import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type pg from "pg";
import { ledgerHome, type Config } from "../store.js";
import { getPool } from "../continuity/db.js";
import { streamTranscript, detectHarness, type NormEvent } from "../continuity/events.js";
import { shadowCommit, repoRoot, repoIdentity, currentBranch, headCommit } from "../continuity/shadow.js";
import * as S from "../continuity/store.js";
import { spoolAppend, spoolPending, spoolAck } from "./spool.js";
import { readBinding, takeSignal, readIndex, appendLocalNotifications } from "./signals.js";
import { redactText } from "../continuity/redact.js";
import { classifySession, classifyAllowed } from "../continuity/classify.js";
const putArtifact = S.putArtifact;

/**
 * The capture helper (spec §3). One process per machine. Each pass:
 *
 *   discover  transcripts modified in the active window (both harnesses)
 *   tail      new lines from the saved byte offset → normalized events → local spool
 *   bind      session → thread: explicit binding file, else own-thread auto-bind, else create, else unbound
 *   upload    drain the spool into Postgres, idempotent on (session, producer_event_id)
 *   snapshot  shadow-commit each active worktree on the cadence, push, verify, publish a `snapshot` checkpoint
 *   signals   Stop / PreCompact / SessionEnd from the hooks → `turn` checkpoint, release on end
 *   reconcile hook index vs parsed events → confirmed capture gaps after a grace window
 *   heartbeat claims; release quiet sessions; deliver notifications to the local log
 *
 * Nothing here depends on the agent cooperating. If the harness dies, the next
 * pass still tails what it wrote and snapshots what it changed.
 */

export interface SessState {
  file: string;
  harness: "claude" | "codex";
  offset: number;
  cwd?: string;
  root?: string | null;
  repo?: string;
  branch?: string | null;
  threadId?: string | null;
  unbound_reason?: string;
  baseCommit?: string | null;
  wipRef?: string;
  lastCommit?: string | null;
  lastTree?: string;
  lastShadowAt?: number;
  lastHeartbeatAt?: number;
  lastSeenMtime: number;
  sidechain?: boolean;
  seenCallIds: string[];
  reconciled: string[];
  unknown: Record<string, number>;
  ended?: boolean;
  firstInstruction?: string;
  /** last time the classifier ran for this session (rate limit: one run per 120 s) */
  lastClassifyAt?: number;
  /** a classification is running detached for this session; never start a second one */
  classifyInFlight?: boolean;
}

export interface HelperOpts {
  roots?: { claude?: string; codex?: string };
  /** transcripts modified within this many minutes are "active" */
  activeWindowMin?: number;
  /** a session with no activity for this long is released and marked ended */
  quietEndMin?: number;
  snapshotIntervalS?: number;
  now?: Date;
  log?: (s: string) => void;
  /** disable git push (tests) */
  push?: boolean;
  /** how long helperOnce waits for detached classifications before returning; 0 (default) = do not wait. Tests set it so results are visible on return. */
  classifyWaitMs?: number;
}

/** Detached classifications by session id; a pass never blocks on them, and a session never runs two. */
const classifyInFlight = new Map<string, Promise<void>>();

export interface PassSummary {
  at: string;
  sessions: number;
  events_spooled: number;
  events_uploaded: number;
  snapshots: number;
  checkpoints: number;
  bound: number;
  /** sessions the classifier ran on after a turn checkpoint (model replied and output was applied) */
  classified: number;
  errors: string[];
}

const stateFile = () => path.join(ledgerHome(), "helper-state.json");
const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");

export function loadState(): Record<string, SessState> {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return {}; }
}
export function saveState(st: Record<string, SessState>): void {
  fs.mkdirSync(ledgerHome(), { recursive: true });
  const tmp = stateFile() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(st));
  fs.renameSync(tmp, stateFile());
}

function walk(dir: string, depth: number): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir) || depth < 0) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, depth - 1));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function defaultRoots() {
  return { claude: path.join(os.homedir(), ".claude", "projects"), codex: path.join(os.homedir(), ".codex", "sessions") };
}

function sessionIdFor(file: string, harness: "claude" | "codex", parsedId?: string): string {
  if (parsedId) return parsedId;
  if (harness === "claude") return path.basename(file, ".jsonl");
  const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
  return m?.[1] ?? path.basename(file, ".jsonl");
}

function repoAllowed(cfg: Config, repo: string, root: string | null): boolean {
  const allow = cfg.continuity?.repos ?? [];
  if (!allow.length) return true;
  return allow.some((a) => repo === a || repo.endsWith(a) || (root && (root === a || root.endsWith(a))));
}

async function structuredState(pool: pg.Pool, sessionId: string, threadId: string, files: { status: string; path: string }[]): Promise<Record<string, unknown>> {
  const tools = await S.sessionEvents(pool, sessionId, { kinds: ["tool.requested"], limit: 3 });
  const count = (await pool.query<{ n: number }>(`select count(*)::int as n from cont_events where session_id = $1 and kind = 'tool.requested'`, [sessionId])).rows[0].n;
  const fin = await S.sessionEvents(pool, sessionId, { kinds: ["tool.finished"] });
  const lastErr = [...fin].reverse().find((e) => e.payload?.is_error || e.payload?.stderr_preview);
  const pend = await S.pendingOperations(pool, sessionId);
  const instr = await S.threadEvents(pool, threadId, { kinds: ["instruction.added"] });
  const msgs = await S.sessionEvents(pool, sessionId, { kinds: ["assistant.message"], limit: 3 });
  const touched = await S.threadEvents(pool, threadId, { kinds: ["file.changed"] });
  const counts = new Map<string, number>();
  for (const f of touched) { const p = String(f.payload?.path ?? ""); if (p) counts.set(p, (counts.get(p) ?? 0) + 1); }
  return {
    goal: instr[0]?.payload?.text ? String(instr[0].payload.text).slice(0, 300) : undefined,
    instructions: instr.map((e) => ({ event_seq: e.seq, preview: String(e.payload?.text ?? "").slice(0, 120) })),
    files_touched: [...counts].map(([p, n]) => ({ path: p, count: n })).slice(0, 50),
    snapshot_files: files.slice(0, 200),
    tools_summary: { count, last: tools.map((t) => `${t.payload?.tool}: ${String(t.payload?.input ?? "").slice(0, 80)}`) },
    last_assistant_messages: msgs.map((m) => String(m.payload?.text ?? "").slice(0, 600)),
    pending_operations: pend.map((p) => ({ call_id: p.call_id, tool: p.tool, input: String(p.input).slice(0, 200), status: "unknown" })),
    last_error: lastErr ? { seq: lastErr.seq, ...lastErr.payload } : null,
    decisions: [],
  };
}

/**
 * After a `turn` checkpoint: classify the session's new events into work records
 * (spec §13a). Gated by config/env and a per-session rate limit; contained by its
 * own try/catch so a model failure never touches capture or checkpoints.
 */
async function classifyAfterTurn(cfg: Config, pool: pg.Pool, sid: string, s: SessState, now: Date, sum: PassSummary, log: (m: string) => void): Promise<void> {
  const gate = classifyAllowed(cfg, { now: now.getTime(), lastClassifyAt: s.lastClassifyAt });
  if (!gate.ok) return;
  s.lastClassifyAt = now.getTime();
  try {
    const r = await classifySession(cfg, pool, sid, { now, log });
    if (!r.model_ok) { log(`classify ${sid.slice(0, 8)}: ${r.error}`); return; }
    if (!r.events_considered) return;
    sum.classified++;
    log(`classify ${sid.slice(0, 8)}: ${r.events_considered} events → ${r.assignments_applied} span(s) linked, ${r.records_created} new record(s), ${r.updates_proposed} update(s) proposed, ${r.unassigned.length} unassigned${r.rejected.length ? `, ${r.rejected.length} rejected` : ""}`);
  } catch (e: any) {
    log(`classify ${sid.slice(0, 8)} failed: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

/**
 * Full tool outputs and offloaded side files become artifacts (inline bytea up to
 * ARTIFACT_MAX, deduplicated by sha256). The event keeps the preview plus an
 * artifact id. Above the cap, the event carries an explicit `oversized` gap
 * with size and, when known, the local path; nothing is silently dropped.
 */
async function materializeArtifacts(pool: pg.Pool, sessionId: string, events: NormEvent[]): Promise<void> {
  for (const e of events) {
    if (e.kind !== "tool.finished") continue;
    const p = e.payload as Record<string, any>;
    let full: string | undefined = typeof p._full === "string" ? p._full : undefined;
    delete p._full;
    if (!full && typeof p.offloaded_path === "string" && fs.existsSync(p.offloaded_path)) {
      try {
        const size = fs.statSync(p.offloaded_path).size;
        if (size <= 8 * 1024 * 1024) full = redactText(fs.readFileSync(p.offloaded_path, "utf8")).text;
        else p.oversized = { byte_size: size, local_path: p.offloaded_path, note: "offloaded output exceeds ARTIFACT_MAX; left on the source machine" };
      } catch { /* unreadable side file: preview stands */ }
    }
    if (!full) continue;
    const buf = Buffer.from(full, "utf8");
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    try {
      const a = await putArtifact(pool, { sha256: sha, kind: "tool_output", bytes: buf, session_id: sessionId });
      p.artifact_id = a.id;
      p.artifact_sha256 = sha;
    } catch (err: any) {
      p.oversized = { byte_size: buf.length, note: `artifact store failed: ${String(err?.message ?? err).slice(0, 120)}` };
    }
  }
}

export async function helperOnce(cfg: Config, opts: HelperOpts = {}): Promise<PassSummary> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const sum: PassSummary = { at: now.toISOString(), sessions: 0, events_spooled: 0, events_uploaded: 0, snapshots: 0, checkpoints: 0, bound: 0, classified: 0, errors: [] };
  if (!cfg.continuity) throw new Error("continuity not configured");
  const pool = getPool(cfg);
  const author = cfg.author;
  const machine = cfg.continuity.machine ?? os.hostname();
  const activeMs = (opts.activeWindowMin ?? 10) * 60_000;
  const quietMs = (opts.quietEndMin ?? 30) * 60_000;
  const snapEvery = (opts.snapshotIntervalS ?? cfg.continuity.snapshot_interval_s ?? 30) * 1000;
  const roots = { ...defaultRoots(), ...(opts.roots ?? {}) };
  const st = loadState();

  // ---- discover ----
  const files = [...walk(roots.claude, 3), ...walk(roots.codex, 5)];
  const active = new Map<string, { file: string; mtime: number }>();
  for (const f of files) {
    let m: number;
    try { m = fs.statSync(f).mtimeMs; } catch { continue; }
    if (now.getTime() - m > activeMs) continue;
    active.set(f, { file: f, mtime: m });
  }
  // sessions we already track stay in the pass until ended, so quiet-end and signals are handled
  for (const [sid, s] of Object.entries(st)) if (!s.ended && !active.has(s.file) && fs.existsSync(s.file)) active.set(s.file, { file: s.file, mtime: fs.statSync(s.file).mtimeMs });

  const byFile = new Map<string, string>();
  for (const [sid, s] of Object.entries(st)) byFile.set(s.file, sid);

  for (const { file, mtime } of active.values()) {
    try {
      const harness = detectHarness(file);
      let sid = byFile.get(file);
      let s = sid ? st[sid] : undefined;

      // ---- tail ----
      const r = streamTranscript(file, s?.offset ?? 0, harness, cfg.data_tools);
      if (!sid) { sid = sessionIdFor(file, harness, r.session_id); s = st[sid] ?? { file, harness, offset: 0, lastSeenMtime: 0, seenCallIds: [], reconciled: [], unknown: {} }; st[sid] = s; byFile.set(file, sid); }
      s = s!;
      s.offset = r.offset;
      s.lastSeenMtime = mtime;
      if (r.cwd) s.cwd = r.cwd;
      if (r.branch) s.branch = r.branch;
      if ((r as any).sidechain) s.sidechain = true;
      for (const [k, v] of Object.entries(r.unknown)) s.unknown[k] = (s.unknown[k] ?? 0) + v;
      if (s.cwd && s.root === undefined) {
        s.root = repoRoot(s.cwd);
        if (s.root) { s.repo = repoIdentity(s.root); s.branch = s.branch ?? currentBranch(s.root); s.baseCommit = headCommit(s.root); s.wipRef = `refs/wip/${safe(author)}/${safe(sid)}`; }
      }
      if (s.root && s.repo && !repoAllowed(cfg, s.repo, s.root)) { s.ended = true; continue; }
      if (!s.firstInstruction) {
        const fi = r.events.find((e) => e.kind === "instruction.added");
        if (fi) s.firstInstruction = String(fi.payload.text ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0)?.slice(0, 100) ?? undefined;
      }
      for (const e of r.events) if (e.call_id && e.kind === "tool.requested") s.seenCallIds.push(e.call_id);
      if (s.seenCallIds.length > 5000) s.seenCallIds = s.seenCallIds.slice(-5000);
      if (r.events.length) {
        spoolAppend(sid, { offset: r.offset, events: r.events, at: now.toISOString() });
        sum.events_spooled += r.events.length;
        if (s.ended) { s.ended = false; log(`session ${sid.slice(0, 8)} resumed after end/quiet; capture continues (routing may be a fork)`); }
      }
      sum.sessions++;

      // ---- session row ----
      await S.upsertSession(pool, { id: sid, author, harness, machine, cwd: s.cwd, repo: s.repo, branch: s.branch, transcript_path: file, started_at: s.offset === r.offset && !sid ? now : undefined, last_seen_at: new Date(mtime) });

      // ---- bind ----
      if (!s.threadId && !s.sidechain && s.repo) {
        const b = readBinding(sid);
        let thread: S.ThreadRow | null = null;
        if (b?.thread_id) thread = await S.getThread(pool, b.thread_id);
        else if (b?.new) thread = await S.createThread(pool, { repo: s.repo, branch: s.branch, title: b.title || s.firstInstruction || `${path.basename(s.repo)} work`, goal: s.firstInstruction, created_by: author });
        else {
          const own = await S.findOwnOpenThreads(pool, s.repo, s.branch ?? null, author);
          if (own.length === 1) thread = own[0];
          else if (own.length === 0 && s.firstInstruction) thread = await S.createThread(pool, { repo: s.repo, branch: s.branch, title: s.firstInstruction, goal: s.firstInstruction, created_by: author });
          else if (own.length > 1) s.unbound_reason = `ambiguous: ${own.length} own open threads on ${path.basename(s.repo)}${s.branch ? `@${s.branch}` : ""}: ${own.map((t) => t.id.slice(0, 8)).join(", ")}`;
          else s.unbound_reason = "no human instruction yet";
        }
        if (thread) {
          const c = await S.claimThread(pool, thread.id, sid, author);
          s.threadId = thread.id;
          s.unbound_reason = undefined;
          await S.updateSession(pool, sid, { thread_id: thread.id, base_commit: s.baseCommit ?? null, wip_ref: s.wipRef ?? null });
          sum.bound++;
          log(`bound ${sid.slice(0, 8)} → thread ${thread.id.slice(0, 8)} "${thread.title}" ${c.ok ? `gen ${c.generation}` : `claim held by ${c.holder.holder_author}`}`);
        }
      }
      await S.updateSession(pool, sid, { transcript_offset: s.offset, coverage: { unknown_shapes: s.unknown, sidechain: Boolean(s.sidechain), unbound_reason: s.unbound_reason ?? null, hooks_index_entries: readIndex(sid).length } });

      // ---- upload ----
      const routing = await S.resolveRouting(pool, sid);
      if (routing.forked && routing.fork_thread_id && s.threadId !== routing.fork_thread_id) { s.threadId = routing.fork_thread_id; log(`session ${sid.slice(0, 8)} diverged → fork ${routing.fork_thread_id.slice(0, 8)}`); }
      const pending = spoolPending(sid);
      let acked = pending.acked;
      for (const batch of pending.batches) {
        await materializeArtifacts(pool, sid, batch.events);
        const res = await S.appendEvents(pool, sid, batch.events, routing.thread_id, routing.generation);
        sum.events_uploaded += res.inserted;
        acked++;
        spoolAck(sid, acked);
      }

      // ---- reconcile hook index vs parsed (pending → confirmed after 60 s) ----
      const idx = readIndex(sid);
      const seen = new Set(s.seenCallIds);
      const confirmed: NormEvent[] = [];
      for (const e of idx) {
        if (seen.has(e.id) || s.reconciled.includes(e.id)) continue;
        if (now.getTime() - new Date(e.at).getTime() < 60_000) continue; // still arriving
        s.reconciled.push(e.id);
        confirmed.push({ producer_event_id: `gap:${e.id}`, kind: "capture.gap", occurred_at: e.at, payload: { kind: "hook_saw_tool_transcript_did_not", tool: e.tool, tool_use_id: e.id, status: "confirmed" } });
      }
      if (confirmed.length) { await S.appendEvents(pool, sid, confirmed, routing.thread_id, routing.generation); sum.events_uploaded += confirmed.length; log(`${confirmed.length} confirmed capture gap(s) in ${sid.slice(0, 8)}`); }

      // ---- signals & snapshot ----
      const endSignal = takeSignal(sid, "end");
      const cpSignal = takeSignal(sid, "checkpoint") || endSignal;
      const quiet = now.getTime() - mtime > quietMs;
      const due = !s.lastShadowAt || now.getTime() - s.lastShadowAt >= snapEvery;
      if (s.root && s.wipRef && (due || cpSignal) && !s.ended) {
        const sh = shadowCommit(s.root, { ref: s.wipRef, parent: s.lastCommit ?? undefined, lastTree: s.lastTree, deny: cfg.continuity.deny, include: cfg.continuity.include, push: opts.push ?? true, now, message: `wip ${sid.slice(0, 8)} ${now.toISOString()}` });
        s.lastShadowAt = now.getTime();
        if (sh.error && !sh.commit) sum.errors.push(`shadow ${sid.slice(0, 8)}: ${sh.error}`);
        if (sh.tree) s.lastTree = sh.tree;
        if (sh.commit) {
          s.lastCommit = sh.commit;
          sum.snapshots++;
          if (sh.verified) await S.updateSession(pool, sid, { wip_commit: sh.commit, last_verified_snapshot_at: new Date(sh.verified_at!) });
          if (routing.thread_id) {
            const cp = await S.publishCheckpoint(pool, {
              thread_id: routing.thread_id, session_id: sid, generation: routing.generation, kind: cpSignal ? "turn" : "snapshot",
              through_event_seq: (await S.appendEvents(pool, sid, [], null, null)).lastSeq,
              base_commit: s.baseCommit, wip_ref: s.wipRef, wip_commit: sh.commit,
              verified_snapshot_at: sh.verified ? new Date(sh.verified_at!) : null, verified_events_at: now,
              structured_state: cpSignal ? await structuredState(pool, sid, routing.thread_id, sh.files) : { snapshot_files: sh.files.slice(0, 200) },
              capture_gaps: [...sh.gaps, ...(sh.verified ? [] : [{ kind: "snapshot_not_verified", detail: sh.error ?? "push or verify failed" }])],
            });
            sum.checkpoints++;
            if (!cp.advanced) log(`checkpoint ${cp.id.slice(0, 8)} did not advance head: ${cp.reason}`);
            if (cpSignal) await classifyAfterTurn(cfg, pool, sid, s, now, sum, log);
          }
        } else if (cpSignal && routing.thread_id) {
          // nothing new on disk but a turn ended: still record the turn boundary
          const cp = await S.publishCheckpoint(pool, { thread_id: routing.thread_id, session_id: sid, generation: routing.generation, kind: "turn", through_event_seq: (await S.appendEvents(pool, sid, [], null, null)).lastSeq, base_commit: s.baseCommit, wip_ref: s.wipRef, wip_commit: s.lastCommit ?? null, verified_events_at: now, structured_state: await structuredState(pool, sid, routing.thread_id, []), capture_gaps: sh.gaps });
          sum.checkpoints++;
          if (!cp.advanced) log(`turn checkpoint did not advance head: ${cp.reason}`);
          await classifyAfterTurn(cfg, pool, sid, s, now, sum, log);
        }
      }

      // ---- heartbeat / end ----
      if (s.threadId && !s.ended) {
        if (endSignal || quiet) {
          await S.releaseClaim(pool, s.threadId, sid);
          await S.updateSession(pool, sid, { ended_at: now });
          s.ended = true;
          log(`session ${sid.slice(0, 8)} ${endSignal ? "ended" : "went quiet"}; claim released`);
        } else if (!s.lastHeartbeatAt || now.getTime() - s.lastHeartbeatAt > 30_000) {
          await S.heartbeatClaim(pool, s.threadId, sid);
          s.lastHeartbeatAt = now.getTime();
        }
      }
    } catch (e: any) {
      sum.errors.push(`${path.basename(file)}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }

  // ---- notifications ----
  try {
    const notes = await S.takeNotifications(pool, author, machine);
    if (notes.length) { appendLocalNotifications(notes.map((n) => `${now.toISOString()} ${n}`)); for (const n of notes) log(`NOTICE ${n}`); }
  } catch (e: any) { sum.errors.push(`notifications: ${String(e?.message ?? e).slice(0, 120)}`); }

  // prune ended sessions from state after a day
  for (const [sid, s] of Object.entries(st)) if (s.ended && now.getTime() - s.lastSeenMtime > 86_400_000) delete st[sid];
  saveState(st);
  return sum;
}

export async function helperLoop(cfg: Config, opts: HelperOpts & { intervalMs?: number } = {}): Promise<void> {
  const log = opts.log ?? ((s: string) => process.stdout.write(`${new Date().toISOString()} ${s}\n`));
  let stop = false;
  process.on("SIGTERM", () => { stop = true; });
  process.on("SIGINT", () => { stop = true; });
  log(`helper started: author ${cfg.author}, machine ${cfg.continuity?.machine}, interval ${(opts.intervalMs ?? 10_000) / 1000}s`);
  while (!stop) {
    const t0 = Date.now();
    try {
      const s = await helperOnce(cfg, { ...opts, log });
      if (s.events_spooled || s.events_uploaded || s.snapshots || s.classified || s.errors.length) log(`pass: ${s.sessions} sessions, ${s.events_spooled} spooled, ${s.events_uploaded} uploaded, ${s.snapshots} snapshots, ${s.checkpoints} checkpoints, ${s.classified} classified${s.errors.length ? `, errors: ${s.errors.join(" | ")}` : ""}`);
    } catch (e: any) {
      log(`pass failed: ${String(e?.message ?? e).slice(0, 300)}`);
    }
    const wait = Math.max(1000, (opts.intervalMs ?? 10_000) - (Date.now() - t0));
    await new Promise((r) => setTimeout(r, wait));
  }
  log("helper stopped");
}
