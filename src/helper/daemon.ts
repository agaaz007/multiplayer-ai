import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type pg from "pg";
import { ledgerHome, type Config } from "../store.js";
import { withUsageInvocation } from "../usage.js";
import { flushUsage } from "../continuity/usage.js";
import { getPool } from "../continuity/db.js";
import { streamTranscript, detectHarness, type NormEvent } from "../continuity/events.js";
import { repoRoot, repoIdentity, currentBranch, headCommit } from "../continuity/shadow.js";
import * as S from "../continuity/store.js";
import { queueSnapshot, snapshotQueueSize } from "./snapshot-queue.js";
import { spoolAppend, spoolPending, spoolAck, spoolCursor, spoolStatus } from "./spool.js";
import { readBinding, takeSignal, readIndex, appendLocalNotifications } from "./signals.js";
import { redactText } from "../continuity/redact.js";
import { classifySession, classifyAllowed, unclassifiedCount } from "../continuity/classify.js";
import { addDecisionObligations } from "../hooks.js";
import { autoBindEligible, forbiddenSnapshotRoot, threadTitleFor, transcriptRoots } from "../continuity/safety.js";
import { writeHeartbeat, withDeadline, type HelperHeartbeat } from "./heartbeat.js";
import { embeddingsConfigured, embedPendingEvents } from "../continuity/embeddings.js";
import { boundSessionIds, extendBoundLink, touchBoundRepo } from "../continuity/investigations.js";
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
 *
 * Liveness (2026-09-13): the loop runs each pass under a deadline and exits past it so
 * launchd restarts the process, writes ~/.ledger/helper-heartbeat.json around every pass,
 * and heartbeats live claims on its own timer so a slow pass cannot let leases lapse.
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
  pendingSnapshotTurn?: boolean;
  lastHeartbeatAt?: number;
  lastSeenMtime: number;
  sidechain?: boolean;
  seenCallIds: string[];
  reconciled: string[];
  unknown: Record<string, number>;
  ended?: boolean;
  firstInstruction?: string;
  /** when the session started: earliest event time on first read, else the transcript's birth time. Auto-bind only adopts threads older than this. */
  startedAtMs?: number;
  /** last time the classifier ran for this session (rate limit: one run per 120 s) */
  lastClassifyAt?: number;
  /** a classification is running detached for this session; never start a second one */
  classifyInFlight?: boolean;
  /** when a session without a thread started waiting to end for a classification slot (bounded by CLASSIFY_HOLD_MAX_MS) */
  classifyHoldSince?: number;
}

export interface HelperOpts {
  roots?: { claude?: string; codex?: string };
  /** Explicit dependency injection for isolated fault tests. */
  pool?: pg.Pool;
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
  /** Tests can wait for snapshot publication; production always detaches. */
  snapshotWaitMs?: number;
}

export interface HelperLoopOpts extends HelperOpts {
  intervalMs?: number;
  /** a pass running longer than this exits the process (launchd restarts it). Default continuity.pass_deadline_s or 900 s. */
  passDeadlineMs?: number;
  /** cadence of the independent claim heartbeat. Default 30 s. */
  claimHeartbeatMs?: number;
  /** stop after this many passes (tests) */
  maxPasses?: number;
  /** called instead of process.exit when a pass exceeds its deadline (tests) */
  exit?: (code: number) => void;
}

/** Detached classifications by session id; a pass never blocks on them, and a session never runs two. */
const classifyInFlight = new Map<string, Promise<void>>();
const snapshotPublications = new Set<Promise<void>>();
let usageFlush: Promise<unknown> | null = null;
const snapshotCompleted = new Map<string, Partial<SessState>>();

/** Embeddings per pass (optional feature): at most this many newly uploaded events, and no new provider batch after this long. */
export const EMBED_PASS_MAX_EVENTS = 256;
export const EMBED_PASS_MAX_MS = 60_000;

export interface PassSummary {
  at: string;
  sessions: number;
  events_spooled: number;
  events_uploaded: number;
  snapshots: number;
  checkpoints: number;
  bound: number;
  /** classifications started after a turn checkpoint; each runs detached and logs its outcome (or failure) when it returns */
  classified: number;
  errors: string[];
}

const stateFile = () => path.join(ledgerHome(), "helper-state.json");
const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
/** Mid-pass state saves: the claim heartbeat timer and a restarted helper both read the saved file. */
const STATE_SAVE_EVERY_MS = 30_000;

export function loadState(): Record<string, SessState> {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return {}; }
}
export function saveState(st: Record<string, SessState>): void {
  fs.mkdirSync(ledgerHome(), { recursive: true });
  const tmp = stateFile() + ".tmp";
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(st)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
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

/**
 * Session identity is the FILE, not the sessionId the lines carry. Claude subagent transcripts
 * (<session>/subagents/agent-<id>.jsonl) carry the parent's sessionId; keying on it collided a
 * subagent with its parent, thrashed the shared offset, and re-spooled hundreds of events per pass.
 */
function sessionIdFor(file: string, harness: "claude" | "codex", parsedId?: string): string {
  if (harness === "claude") return path.basename(file, ".jsonl");
  if (parsedId) return parsedId;
  const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
  return m?.[1] ?? path.basename(file, ".jsonl");
}

/** realpath when it exists (macOS: /var → /private/var; Claude Code records the realpath'd cwd), else the string as given */
function realOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

function repoAllowed(cfg: Config, repo: string, root: string | null): boolean {
  // excluded prefixes win (evaluation fixtures, scratch dirs); compare realpaths on both sides; then the optional allowlist
  const excl = (cfg.continuity?.exclude_paths ?? []).filter(Boolean).map(realOrSelf);
  const r = root ? realOrSelf(root) : null;
  if (r && excl.some((p) => r === p || r.startsWith(p.endsWith(path.sep) ? p : p + path.sep))) return false;
  const allow = cfg.continuity?.repos ?? [];
  if (!allow.length) return true;
  return allow.some((a) => repo === a || repo.endsWith(a) || (root && (root === a || root.endsWith(a))));
}

/** Earliest event time when the transcript was read from its start, else its birth time (sessions tracked before startedAtMs existed). */
function startedAtFor(file: string, eventsFromStart: NormEvent[]): number | undefined {
  let min = Infinity;
  for (const e of eventsFromStart) {
    const t = e.occurred_at ? Date.parse(String(e.occurred_at)) : NaN;
    if (Number.isFinite(t) && t < min) min = t;
  }
  if (Number.isFinite(min)) return min;
  try { const st = fs.statSync(file); return st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs; } catch { return undefined; }
}

/**
 * Another session tracked by this helper that holds, or last held with the lease lapsed, this thread's
 * claim while its transcript is still being written. Taking the claim from it would fork a live session:
 * exactly what happened when stale sessions were bound after a helper restart.
 */
async function liveLocalHolder(pool: pg.Pool, st: Record<string, SessState>, threadId: string, sid: string, nowMs: number, quietMs: number): Promise<string | null> {
  const row = await S.getClaimAny(pool, threadId);
  if (!row || row.released_at || row.holder_session_id === sid) return null;
  const h = st[row.holder_session_id];
  if (!h || h.ended) return null;
  try { return nowMs - fs.statSync(h.file).mtimeMs <= quietMs ? row.holder_session_id : null; } catch { return null; }
}

/** Claim a thread for a live session unless a live local session holds it. Returns a short note for the log. */
async function claimUnlessLiveHolder(pool: pg.Pool, st: Record<string, SessState>, threadId: string, sid: string, author: string, nowMs: number, quietMs: number): Promise<string> {
  const other = await liveLocalHolder(pool, st, threadId, sid, nowMs, quietMs);
  if (other) return `claim left with live session ${other.slice(0, 8)}`;
  const c = await S.claimThread(pool, threadId, sid, author);
  return c.ok ? `gen ${c.generation}` : `claim held by ${c.holder.holder_author}`;
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
  };
}

/**
 * After a `turn` checkpoint: classify the session's new events into work records
 * (spec §13a). Gated by config/env and a per-session rate limit; contained by its
 * own try/catch so a model failure never touches capture or checkpoints.
 */
/** Detached classifications running at once across sessions; more wait for a later pass, so a burst of sessions going quiet cannot start dozens of model calls. */
export const MAX_CONCURRENT_CLASSIFY = 2;
/** A session without a thread waits at most this long to end while its unclassified tail waits for the rate limit or a free slot. */
export const CLASSIFY_HOLD_MAX_MS = 10 * 60_000;
/** Decisions the classifier proposes below this confidence stay PROPOSED on their record but do not become checkpoint prompts. */
export const DECISION_PROMPT_MIN_CONFIDENCE = 0.6;

type ClassifyStart = "started" | "disabled" | "rate_limited" | "in_flight" | "busy";

function classifyAfterTurn(cfg: Config, pool: pg.Pool, sid: string, s: SessState, now: Date, sum: PassSummary, log: (m: string) => void): ClassifyStart {
  const gate = classifyAllowed(cfg, { now: now.getTime(), lastClassifyAt: s.lastClassifyAt });
  if (!gate.ok) return gate.reason.startsWith("rate limited") ? "rate_limited" : "disabled";
  if (classifyInFlight.has(sid)) return "in_flight"; // a model call is still running for this session
  if (classifyInFlight.size >= MAX_CONCURRENT_CLASSIFY) return "busy";
  s.lastClassifyAt = now.getTime();
  s.classifyInFlight = true;
  sum.classified++; // counts starts; the outcome is logged when the detached call returns
  const p = classifySession(cfg, pool, sid, { now, log })
    .then((r) => {
      if (!r.model_ok) { log(`classify ${sid.slice(0, 8)}: ${r.error}`); return; }
      if (!r.events_considered) return;
      log(`classify ${sid.slice(0, 8)}: ${r.events_considered} events → ${r.assignments_applied} span(s) linked, ${r.records_created} new record(s), ${r.updates_proposed} update(s) proposed, ${r.unassigned.length} unassigned${r.rejected.length ? `, ${r.rejected.length} rejected` : ""}`);
      // decisions reached in conversation call no data tool; ask about them at the session's next checkpoint
      const decisions = r.proposed.filter((u) => u.kind === "decision" && u.confidence >= DECISION_PROMPT_MIN_CONFIDENCE);
      if (!decisions.length || s.sidechain) return;
      try {
        const added = addDecisionObligations(sid, decisions.map((u) => ({ update_id: u.id, record_title: u.record_title, text: u.text })), { now });
        if (added) log(`classify ${sid.slice(0, 8)}: ${added} decision(s) from the conversation queued for the next checkpoint`);
      } catch (e: any) { log(`decision prompts for ${sid.slice(0, 8)} not queued: ${String(e?.message ?? e).slice(0, 160)}`); }
    })
    .catch((e: any) => log(`classify ${sid.slice(0, 8)} failed: ${String(e?.message ?? e).slice(0, 200)}`))
    .finally(() => { classifyInFlight.delete(sid); s.classifyInFlight = false; });
  classifyInFlight.set(sid, p);
  return "started";
}

/** Wait up to `ms` for detached classifications (tests; a daemon pass passes 0 and moves on). */
async function awaitClassifications(ms: number): Promise<void> {
  if (ms <= 0 || !classifyInFlight.size) return;
  await Promise.race([Promise.allSettled([...classifyInFlight.values()]), new Promise((r) => setTimeout(r, ms))]);
}

/**
 * Full tool outputs and offloaded side files become artifacts (inline bytea up to
 * ARTIFACT_MAX, deduplicated by sha256). The event keeps the preview plus an
 * artifact id. Above the cap, the event carries an explicit `oversized` gap
 * with size and, when known, the local path; nothing is silently dropped.
 */
export function retainOffloadedOutputs(events: NormEvent[]): void {
  for (const event of events) {
    const p = event.payload as Record<string, any>;
    if (event.kind !== "tool.finished" || typeof p._full === "string" || typeof p.offloaded_path !== "string") continue;
    try {
      const bytes = fs.statSync(p.offloaded_path).size;
      if (bytes > 8 * 1024 * 1024) {
        p.output_availability = "oversized";
        p.oversized = { byte_size: bytes, note: "offloaded output exceeds ARTIFACT_MAX" };
      } else { p._full = redactText(fs.readFileSync(p.offloaded_path, "utf8")).text; p.output_availability = "pending_artifact"; }
    } catch (error: any) {
      // The original source path and a permanent explicit gap are retained; do
      // not pretend an unreadable offload was captured in full.
      p.output_availability = "unavailable";
      p.output_gap = { kind: "offloaded_output_unreadable", code: String(error?.code ?? "unknown") };
    }
  }
}

export async function materializeArtifacts(pool: pg.Pool, sessionId: string, events: NormEvent[], storeArtifact: typeof putArtifact = putArtifact): Promise<void> {
  for (const e of events) {
    if (e.kind === "tool.requested" || typeof e.payload._full_input === "string") {
      const p = e.payload as Record<string, any>;
      if (typeof p._full_input === "string") {
        const bytes = Buffer.from(p._full_input, "utf8"), sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        // Failure leaves the spool batch unacknowledged. Retry exact input delivery even if no new source event arrives.
        const artifact = await storeArtifact(pool, { sha256, kind: "tool_input", bytes, session_id: sessionId });
        p.input_artifact_id = artifact.id;
        p.input_artifact_sha256 = sha256;
        p.input_availability = "stored";
        delete p._full_input;
      }
      if (e.kind === "tool.requested") continue;
    }
    if (e.kind !== "tool.finished") continue;
    const p = e.payload as Record<string, any>;
    let full: string | undefined = typeof p._full === "string" ? p._full : undefined;

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
    // Transient output failures are retryable exactly like input failures. The
    // immutable spool still holds _full; acknowledgment cannot pass this event.
    const a = await storeArtifact(pool, { sha256: sha, kind: "tool_output", bytes: buf, session_id: sessionId });
    p.artifact_id = a.id;
    p.artifact_sha256 = sha;
    p.output_availability = "stored";
    delete p._full;
  }
}

export async function helperOnce(cfg: Config, opts: HelperOpts = {}): Promise<PassSummary> {
  return withUsageInvocation(cfg, { tool: "helper_capture", traffic_class: "maintenance", purpose: "capture_write", version: process.env.LEDGER_BUILD_COMMIT ?? "0.1.0" }, () => helperOnceImpl(cfg, opts));
}
async function helperOnceImpl(cfg: Config, opts: HelperOpts): Promise<PassSummary> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const sum: PassSummary = { at: now.toISOString(), sessions: 0, events_spooled: 0, events_uploaded: 0, snapshots: 0, checkpoints: 0, bound: 0, classified: 0, errors: [] };
  if (!cfg.continuity) throw new Error("continuity not configured");
  const pool = opts.pool ?? getPool(cfg);
  const author = cfg.author;
  const machine = cfg.continuity.machine ?? os.hostname();
  const activeMs = (opts.activeWindowMin ?? 10) * 60_000;
  const quietMs = (opts.quietEndMin ?? 30) * 60_000;
  const snapEvery = (opts.snapshotIntervalS ?? cfg.continuity.snapshot_interval_s ?? 30) * 1000;
  const roots = { ...transcriptRoots(), ...(opts.roots ?? {}) };
  const st = loadState();
  for (const [sid, patch] of snapshotCompleted) { if (st[sid]) Object.assign(st[sid], patch); snapshotCompleted.delete(sid); }
  let lastSave = Date.now();
  /** sessions that had events inserted this pass; only their new events are embedded (backfill is the CLI's job) */
  const uploadedSessions = new Set<string>();
  /** sessions bound to an investigation (ledger_investigation_bind/_new); one SELECT per pass, then one UPDATE per bound session below */
  let boundSessions = new Set<string>();


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

  const admitted: { file: string; mtime: number; sid: string; s: SessState; resumed: boolean }[] = [];
  for (const { file, mtime } of active.values()) {
    try {
      const harness = detectHarness(file);
      let sid = byFile.get(file);
      let s = sid ? st[sid] : undefined;

      // ---- tail ----
      const readFromStart = !s || !s.offset;
      const r = streamTranscript(file, sid ? (spoolCursor(sid) ?? s?.offset ?? 0) : 0, harness, cfg.data_tools, { maxBytes: 1 << 20, maxLines: 200 });
      if (!sid) { sid = sessionIdFor(file, harness, r.session_id); s = st[sid] ?? { file, harness, offset: 0, lastSeenMtime: 0, seenCallIds: [], reconciled: [], unknown: {} }; st[sid] = s; byFile.set(file, sid); }
      s = s!;
      if (s.startedAtMs == null) s.startedAtMs = startedAtFor(file, readFromStart ? r.events : []);

      s.lastSeenMtime = mtime;
      if (r.cwd) s.cwd = r.cwd;
      if (r.branch) s.branch = r.branch;
      // derived every pass from the path (self-healing: an earlier build mis-set this from mirrored lines)
      s.sidechain = s.file.includes(`${path.sep}subagents${path.sep}`) || path.basename(s.file).startsWith("agent-") || Boolean(r.sidechain);
      for (const [k, v] of Object.entries(r.unknown)) s.unknown[k] = (s.unknown[k] ?? 0) + v;
      if (s.cwd && s.root === undefined) {
        const root = repoRoot(s.cwd);
        const forbidden = root ? forbiddenSnapshotRoot(root) : null;
        if (forbidden) {
          // a session started in ~ must never snapshot the home directory; capture its events only
          s.root = null;
          s.unbound_reason = `not captured as a repo: ${forbidden}`;
          log(`session ${sid.slice(0, 8)}: ${forbidden}; events only, no thread or snapshot`);
        } else {
          s.root = root;
          if (s.root) { s.repo = repoIdentity(s.root); s.branch = s.branch ?? currentBranch(s.root); s.baseCommit = headCommit(s.root); s.wipRef = `refs/wip/${safe(author)}/${safe(sid)}`; }
        }
      }
      if (s.root && s.repo && !repoAllowed(cfg, s.repo, s.root)) { s.ended = true; continue; }
      if (!s.firstInstruction) {
        const fi = r.events.find((e) => e.kind === "instruction.added");
        if (fi) s.firstInstruction = String(fi.payload.text ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0)?.slice(0, 100) ?? undefined;
      }
      for (const e of r.events) if (e.call_id && e.kind === "tool.requested") s.seenCallIds.push(e.call_id);
      if (s.seenCallIds.length > 5000) s.seenCallIds = s.seenCallIds.slice(-5000);
      const quiet = now.getTime() - mtime > quietMs;
      const resumed = Boolean(s.ended && r.events.length);
      // Persist even an empty normalized chunk: source cursor and admission share
      // the same fsynced manifest. A crash before saveState replays, never skips.
      retainOffloadedOutputs(r.events);
      if (r.offset !== s.offset || r.events.length) spoolAppend(sid, { offset: r.offset, events: r.events, at: now.toISOString() });
      s.offset = r.offset;
      sum.events_spooled += r.events.length;
      if (resumed) s.ended = false;
      sum.sessions++;
      admitted.push({ file, mtime, sid, s, resumed });
    } catch (e: any) { sum.errors.push(`local capture ${path.basename(file)}: ${String(e?.message ?? e).slice(0, 200)}`); }
  }
  // All local capture is committed before the first network operation. A failed
  // connection cannot prevent other sessions' transcript admission this pass.
  saveState(st);
  if (process.env.LEDGER_CAPTURE_PAUSE_UPLOAD === "1") { sum.errors.push("remote upload paused by LEDGER_CAPTURE_PAUSE_UPLOAD; local admission/spool retained"); return sum; }
  try { boundSessions = new Set(await boundSessionIds(pool)); } catch (e: any) {
    sum.errors.push(`remote unavailable; local spool retained: ${String(e?.message ?? e).slice(0, 120)}`);
    return sum; // one failed connection per pass, not one full timeout per session
  }
  for (const { file, mtime, sid, s, resumed } of admitted) {
    const quiet = now.getTime() - mtime > quietMs;
    try {
      if (resumed && s.threadId) await claimUnlessLiveHolder(pool, st, s.threadId, sid, author, now.getTime(), quietMs);
      // ---- session row ----
      const stored = await S.upsertSession(pool, { id: sid, author, harness: s.harness, machine, cwd: s.cwd, repo: s.repo, branch: s.branch, transcript_path: file, started_at: s.startedAtMs != null ? new Date(s.startedAtMs) : undefined, last_seen_at: new Date(mtime) });

      // ---- bind ----
      if (!s.threadId && !s.sidechain && s.repo) {
        const b = readBinding(sid);
        const explicit = Boolean(b?.thread_id || b?.new);
        let thread: S.ThreadRow | null = null;
        if (b?.thread_id) thread = await S.getThread(pool, b.thread_id);
        else if (b?.new) thread = await S.createThread(pool, { repo: s.repo, branch: s.branch, title: b.title || threadTitleFor(s.firstInstruction, s.repo, sid), goal: s.firstInstruction, created_by: author, created_at: now });
        // The store already binds this session, so this helper lost its local state (for example a restart before any
        // saved pass). Keep that thread: auto-bind would exclude the session's own thread, created after the session started.
        else if (stored.thread_id) thread = await S.getThread(pool, stored.thread_id);
        if (!thread && !explicit) {
          const own = await S.findOwnOpenThreads(pool, s.repo, s.branch ?? null, author);
          // Only threads that already existed when this session started, and that no teammate is continuing,
          // can be this session's work. A stale session found on a helper restart must not adopt newer threads.
          const eligible: S.ThreadRow[] = [];
          for (const t of own) {
            if (!autoBindEligible(s.startedAtMs, t.created_at)) continue;
            const c = await S.getClaim(pool, t.id);
            if (c && c.holder_author !== author) continue;
            eligible.push(t);
          }
          const where = `${path.basename(s.repo)}${s.branch ? `@${s.branch}` : ""}`;
          if (eligible.length === 1) thread = eligible[0];
          else if (eligible.length > 1) s.unbound_reason = `ambiguous: ${eligible.length} own open threads on ${where}: ${eligible.map((t) => t.id.slice(0, 8)).join(", ")}`;
          else if (quiet) s.unbound_reason = own.length ? `quiet session older than own open thread(s) ${own.map((t) => t.id.slice(0, 8)).join(", ")} on ${where}: not auto-bound` : "quiet session: no thread created";
          else if (s.firstInstruction) thread = await S.createThread(pool, { repo: s.repo, branch: s.branch, title: threadTitleFor(s.firstInstruction, s.repo, sid), goal: s.firstInstruction, created_by: author, created_at: now });
          else s.unbound_reason = "no human instruction yet";
        }
        if (thread) {
          s.threadId = thread.id;
          s.unbound_reason = undefined;
          await S.updateSession(pool, sid, { thread_id: thread.id, base_commit: s.baseCommit ?? null, wip_ref: s.wipRef ?? null });
          sum.bound++;
          const note = quiet && !explicit ? "quiet: bound without a claim" : await claimUnlessLiveHolder(pool, st, thread.id, sid, author, now.getTime(), quietMs);
          log(`bound ${sid.slice(0, 8)} → thread ${thread.id.slice(0, 8)} "${thread.title}" ${note}`);
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
        if (res.inserted) uploadedSessions.add(sid);
        acked++;
        spoolAck(sid, acked);
      }

      // ---- investigation binding: the whole session accumulates on the bound record ----
      // A session bound with ledger_investigation_bind/_new carries one explicit "bound by <author>" span from seq 1.
      // Extend it to the current max seq (one UPDATE). Thread binding above is unchanged: an analysis session inside
      // a repo still gets its repo thread as before. The classifier may still add `suggested` links on the same
      // events; records.ts ranks explicit above suggested on overlapping spans (SOURCE_RANK) and counts explicit
      // links as coverage, so a suggestion is lower authority and never overrides the binding.
      if (boundSessions.has(sid)) {
        try { if (await extendBoundLink(pool, sid)) log(`extended investigation span for ${sid.slice(0, 8)} to the session's current max seq`); }
        catch (e: any) { log(`investigation span extension failed for ${sid.slice(0, 8)}: ${String(e?.message ?? e).slice(0, 120)}`); }
        // the repo the session sits in is a capability of the investigation (touched_repos), never its identity
        try { if (await touchBoundRepo(pool, sid)) log(`investigation bound to ${sid.slice(0, 8)} now lists the session's repo as touched`); }
        catch (e: any) { log(`investigation touched-repo update failed for ${sid.slice(0, 8)}: ${String(e?.message ?? e).slice(0, 120)}`); }
      }

      // ---- reconcile hook index vs parsed (pending → confirmed after 60 s) ----
      const idx = readIndex(sid);
      const seen = new Set(s.seenCallIds);
      const confirmed: NormEvent[] = [];
      let subcalls = 0;
      for (const e of idx) {
        if (seen.has(e.id) || s.reconciled.includes(e.id)) continue;
        // Codex's hook reports each shell sub-command of the `exec` JS wrapper under its own `exec-<uuid>` id;
        // the transcript carries the wrapper call as `call_…`. A sub-call id is not a missed event.
        if (/^exec-[0-9a-f-]{8,}/i.test(e.id)) { s.reconciled.push(e.id); subcalls++; continue; }
        if (now.getTime() - new Date(e.at).getTime() < 60_000) continue; // still arriving
        s.reconciled.push(e.id);
        confirmed.push({ producer_event_id: `gap:${e.id}`, kind: "capture.gap", occurred_at: e.at, payload: { kind: "hook_saw_tool_transcript_did_not", tool: e.tool, tool_use_id: e.id, status: "confirmed" } });
      }
      if (subcalls) log(`${subcalls} hook sub-call id(s) matched to exec wrapper calls in ${sid.slice(0, 8)} (not gaps)`);
      if (confirmed.length) { await S.appendEvents(pool, sid, confirmed, routing.thread_id, routing.generation); sum.events_uploaded += confirmed.length; log(`${confirmed.length} confirmed capture gap(s) in ${sid.slice(0, 8)}`); }

      // ---- signals & snapshot ----
      const endSignal = takeSignal(sid, "end");
      const cpSignal = takeSignal(sid, "checkpoint") || endSignal || Boolean(s.pendingSnapshotTurn);
      if (cpSignal) s.pendingSnapshotTurn = true;
      const due = !s.lastShadowAt || now.getTime() - s.lastShadowAt >= snapEvery;
      // subagent transcripts share the parent's worktree; the parent session snapshots it
      // A quiet session has no new agent edits to capture (its last live snapshot already has them), so it is only
      // snapshotted on an explicit turn/end signal. Snapshotting every quiet tracked session each pass ran a synchronous
      // `git add -A` of the same worktree dozens of times per pass and starved uploads and heartbeats (2026-09-13).
      if (process.env.LEDGER_SNAPSHOTS !== "0" && s.root && s.wipRef && (cpSignal || (due && !quiet)) && !s.ended && !s.sidechain) {
        // Freeze coverage BEFORE starting Git. Later uploads must never be
        // attributed to an earlier snapshot, and a changed claim stays fenced.
        const throughSeq = (await S.appendEvents(pool, sid, [], null, null)).lastSeq;
        const source = { thread_id: routing.thread_id, generation: routing.generation, base: s.baseCommit, ref: s.wipRef, previous: s.lastCommit };
        const stateAtDispatch = cpSignal && routing.thread_id ? await structuredState(pool, sid, routing.thread_id, []) : {};
        const work = queueSnapshot(s.root, { ref: s.wipRef, parent: s.lastCommit ?? undefined, lastTree: s.lastTree, deny: cfg.continuity.deny, include: cfg.continuity.include, push: opts.push ?? true, now, message: `wip ${sid.slice(0, 8)} ${now.toISOString()}` });
        if (work) {
          s.lastShadowAt = now.getTime();
          s.pendingSnapshotTurn = false;
          let publication: Promise<void>;
          publication = work.then(async sh => {
            if (sh.error) {
              log(`shadow ${sid.slice(0, 8)}: ${sh.error.replace(/\s+/g, " ").trim()}`);
              writeHeartbeat({ snapshot_last_error: sh.error.slice(0, 200), snapshot_queue_depth: snapshotQueueSize() });
              sum.errors.push(`shadow ${sid.slice(0, 8)}: ${sh.error}`);
            }
            if (sh.commit) sum.snapshots++;
            // A failed push must be retried even if the worktree is unchanged.
            const patch: Partial<SessState> = {};
            if (sh.commit) patch.lastCommit = sh.commit;
            if (sh.tree && (sh.verified || opts.push === false)) patch.lastTree = sh.tree;
            if (source.thread_id && (sh.commit || cpSignal)) {
              const cp = await S.publishCheckpoint(pool, {
                thread_id: source.thread_id, session_id: sid, generation: source.generation, kind: cpSignal ? "turn" : "snapshot",
                through_event_seq: throughSeq, base_commit: source.base, wip_ref: source.ref, wip_commit: sh.commit ?? source.previous ?? null,
                verified_snapshot_at: sh.verified ? new Date(sh.verified_at!) : null, verified_events_at: now,
                structured_state: { ...stateAtDispatch, snapshot_files: sh.files.slice(0, 200) },
                capture_gaps: [...sh.gaps, ...(sh.verified || sh.skipped === "unchanged" ? [] : [{ kind: "snapshot_not_verified", detail: sh.error ?? sh.skipped ?? "push or verify failed" }])],
              });
              sum.checkpoints++;
              if (!cp.advanced) log(`checkpoint ${cp.id.slice(0, 8)} did not advance head: ${cp.reason}`);
              // Session verification cannot be advanced by a waking predecessor.
              if (cp.advanced && sh.verified) await pool.query(`update cont_sessions set wip_commit=$2, last_verified_snapshot_at=$3 where id=$1 and claim_generation=$4 and thread_id=$5`, [sid, sh.commit, sh.verified_at, source.generation, source.thread_id]);
            }
            if (!source.thread_id && sh.verified) await pool.query(`update cont_sessions set wip_commit=$2, last_verified_snapshot_at=$3 where id=$1 and thread_id is null and claim_generation is null`, [sid, sh.commit, sh.verified_at]);
            Object.assign(s, patch); snapshotCompleted.set(sid, patch);
            if (cpSignal) classifyAfterTurn(cfg, pool, sid, s, now, sum, log);
          }).catch((e: any) => { log(`snapshot publication ${sid.slice(0, 8)} failed: ${String(e?.message ?? e).slice(0, 200)}`); })
            .finally(() => { snapshotPublications.delete(publication); });
          snapshotPublications.add(publication);
          // Explicit test mode preserves deterministic helperOnce assertions.
          if (opts.push === false || opts.snapshotWaitMs) await withDeadline(publication, opts.snapshotWaitMs ?? 30_000);
        } else if (cpSignal) {
          // Retain turn intent while another worktree owns the bounded worker.
          s.lastShadowAt = 0;
        }
      }

      // ---- work state for sessions without a thread ----
      // Work outside a git repo (a PM's analysis, writing, planning) and unbound repo sessions have no checkpoint to classify
      // after, so they classify at each turn end and once more when they end or go quiet (2026-09-14: 69 such sessions had
      // produced no work record). A session does not end while its unclassified tail waits for the rate limit or a free slot.
      let holdForClassify = false;
      if (!routing.thread_id && !s.sidechain && !s.ended && (cpSignal || quiet) && (await unclassifiedCount(pool, sid)) > 0) {
        const start = classifyAfterTurn(cfg, pool, sid, s, now, sum, log);
        if ((start === "rate_limited" || start === "busy" || start === "in_flight") && (endSignal || quiet)) {
          s.classifyHoldSince ??= now.getTime();
          holdForClassify = now.getTime() - s.classifyHoldSince < CLASSIFY_HOLD_MAX_MS;
        }
      }
      if (!holdForClassify) s.classifyHoldSince = undefined;

      // ---- heartbeat / end ----
      // An unbound session that goes quiet leaves the active set too. It used to stay tracked forever and was re-processed
      // every pass; new transcript lines un-end it (see the tail step).
      const drained = spoolStatus(sid).pending_batches === 0 && s.offset >= fs.statSync(file).size;
      if (!s.threadId && !s.ended && (endSignal || quiet) && !holdForClassify && drained) {
        await S.updateSession(pool, sid, { ended_at: now });
        s.ended = true;
        log(`session ${sid.slice(0, 8)} ${endSignal ? "ended" : "went quiet"} unbound${s.unbound_reason ? ` (${s.unbound_reason})` : ""}`);
      }
      if (s.threadId && !s.ended) {
        if ((endSignal || quiet) && drained && !snapshotQueueSize()) {
          await S.releaseClaim(pool, s.threadId, sid);
          await S.updateSession(pool, sid, { ended_at: now });
          s.ended = true;
          log(`session ${sid.slice(0, 8)} ${endSignal ? "ended" : "went quiet"}; claim released`);
        } else if (!s.lastHeartbeatAt || now.getTime() - s.lastHeartbeatAt > 30_000) {
          // hold the claim while live: if the heartbeat finds none (released by a quiet-end, an expiry, or a restart), take it back
          // unless another live session on this machine holds it
          const held = await S.heartbeatClaim(pool, s.threadId, sid);
          if (!held) {
            try {
              const note = await claimUnlessLiveHolder(pool, st, s.threadId, sid, author, now.getTime(), quietMs);
              log(`session ${sid.slice(0, 8)} claim on thread ${s.threadId.slice(0, 8)}: ${note}`);
            } catch (e: any) { log(`claim failed for ${sid.slice(0, 8)}: ${String(e?.message ?? e).slice(0, 120)}`); }
          }
          s.lastHeartbeatAt = now.getTime();
        }
      }
    } catch (e: any) {
      sum.errors.push(`${path.basename(file)}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    if (Date.now() - lastSave > STATE_SAVE_EVERY_MS) {
      try { saveState(st); } catch { /* the end-of-pass save retries */ }
      lastSave = Date.now();
    }
  }

  // ---- embeddings (optional): one batched step for the events this pass uploaded ----
  // Off unless continuity.embeddings is set. Bounded by count and time so a slow provider cannot push a pass past its
  // deadline; anything left over is picked up by the next pass or `ledger continuity embed --backfill`. Failures are
  // logged once per reason and never count as pass errors: capture does not depend on embeddings.
  if (uploadedSessions.size && embeddingsConfigured(cfg)) {
    try {
      const r = await embedPendingEvents(pool, cfg, { sessionIds: [...uploadedSessions], limit: EMBED_PASS_MAX_EVENTS, deadlineMs: EMBED_PASS_MAX_MS, log });
      if (r.embedded || r.failed) log(`embedded ${r.embedded} events${r.failed ? ` (${r.failed} recorded as failed)` : ""}${r.stopped_early ? " (stopped early; the rest next pass)" : ""}`);
    } catch (e: any) {
      log(`embeddings step failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }

  // Independent, bounded telemetry drain. Never await it on the capture path;
  // the uploader is single-flight and DB queries have server/client deadlines.
  if (!usageFlush) usageFlush = flushUsage(pool, 100).then(r => { if (r.error) log(`usage telemetry: ${r.error}; pending=${r.pending}`); }).catch(() => { log("usage telemetry upload failed; local queue retained"); }).finally(() => { usageFlush = null; });

  // ---- notifications ----
  try {
    const notes = await S.takeNotifications(pool, author, machine);
    if (notes.length) { appendLocalNotifications(notes.map((n) => `${now.toISOString()} ${n}`)); for (const n of notes) log(`NOTICE ${n}`); }
  } catch (e: any) { sum.errors.push(`notifications: ${String(e?.message ?? e).slice(0, 120)}`); }

  writeHeartbeat({ snapshot_queue_depth: snapshotQueueSize(), capture_sessions: Object.fromEntries(admitted.map(({ sid, s }) => [sid, spoolStatus(sid)])) });

  // prune ended sessions from state after a day
  for (const [sid, s] of Object.entries(st)) if (s.ended && now.getTime() - s.lastSeenMtime > 86_400_000) delete st[sid];
  await awaitClassifications(opts.classifyWaitMs ?? 0);
  saveState(st);
  return sum;
}

/**
 * Keep live sessions' claims alive independently of pass progress. A pass that stalls (a slow remote,
 * a dead connection until query_timeout) used to let every lease lapse, and stale sessions then took
 * the claims. Reads the last saved state; only sessions whose transcript is still being written count.
 */
export async function heartbeatLiveClaims(cfg: Config, opts: { now?: Date; quietEndMin?: number } = {}): Promise<number> {
  if (!cfg.continuity) return 0;
  const pool = getPool(cfg);
  const nowMs = (opts.now ?? new Date()).getTime();
  const quietMs = (opts.quietEndMin ?? 30) * 60_000;
  let n = 0;
  for (const [sid, s] of Object.entries(loadState())) {
    if (!s.threadId || s.ended || s.sidechain) continue;
    let mtime: number;
    try { mtime = fs.statSync(s.file).mtimeMs; } catch { continue; }
    if (nowMs - mtime > quietMs) continue;
    if (await S.heartbeatClaim(pool, s.threadId, sid)) n++;
  }
  return n;
}

function beat(patch: Partial<HelperHeartbeat>, log: (s: string) => void): void {
  try { writeHeartbeat(patch); } catch (e: any) { log(`heartbeat file write failed: ${String(e?.message ?? e).slice(0, 120)}`); }
}

export async function helperLoop(cfg: Config, opts: HelperLoopOpts = {}): Promise<void> {
  const log = opts.log ?? ((s: string) => process.stdout.write(`${new Date().toISOString()} ${s}\n`));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const deadlineMs = opts.passDeadlineMs ?? (cfg.continuity?.pass_deadline_s ?? 900) * 1000;
  let stop = false;
  process.on("SIGTERM", () => { stop = true; });
  process.on("SIGINT", () => { stop = true; });
  log(`helper started: author ${cfg.author}, machine ${cfg.continuity?.machine}, interval ${(opts.intervalMs ?? 10_000) / 1000}s, pass deadline ${Math.round(deadlineMs / 1000)}s`);
  beat({ pid: process.pid, cli: process.argv[1] ?? "", author: cfg.author, machine: cfg.continuity?.machine ?? os.hostname(), started_at: new Date().toISOString(), pass_deadline_s: Math.round(deadlineMs / 1000), last_pass_started_at: null, last_pass_finished_at: null, last_pass_ms: null, last_error: null }, log);

  // claims are heartbeated on their own timer, so a slow or stuck pass cannot let a live session's lease lapse
  let beating = false;
  const claimTimer = setInterval(() => {
    if (beating) return;
    beating = true;
    heartbeatLiveClaims(cfg, { quietEndMin: opts.quietEndMin })
      .catch((e: any) => log(`claim heartbeat failed: ${String(e?.message ?? e).slice(0, 160)}`))
      .finally(() => { beating = false; });
  }, opts.claimHeartbeatMs ?? 30_000);
  claimTimer.unref?.();

  let passes = 0;
  try {
    while (!stop && (opts.maxPasses == null || passes < opts.maxPasses)) {
      const t0 = Date.now();
      beat({ last_pass_started_at: new Date(t0).toISOString() }, log);
      const r = await withDeadline(helperOnce(cfg, { ...opts, log }).then((summary) => ({ summary }), (error: any) => ({ error })), deadlineMs);
      passes++;
      if (r.timedOut) {
        const msg = `pass exceeded its ${Math.round(deadlineMs / 1000)}s deadline; exiting so launchd restarts the helper (spool acks and upload dedup let the next pass resume)`;
        log(msg);
        beat({ last_error: msg }, log);
        exit(75);
        return;
      }
      if ("error" in r.value) {
        const msg = String(r.value.error?.message ?? r.value.error).slice(0, 300);
        log(`pass failed: ${msg}`);
        beat({ last_error: `pass failed: ${msg}` }, log);
      } else {
        const s = r.value.summary;
        if (s.events_spooled || s.events_uploaded || s.snapshots || s.classified || s.errors.length) log(`pass: ${s.sessions} sessions, ${s.events_spooled} spooled, ${s.events_uploaded} uploaded, ${s.snapshots} snapshots, ${s.checkpoints} checkpoints, ${s.classified} classified${s.errors.length ? `, errors: ${s.errors.join(" | ")}` : ""}`);
        beat({ last_pass_finished_at: new Date().toISOString(), last_pass_ms: Date.now() - t0, last_error: s.errors.length ? s.errors.join(" | ").slice(0, 300) : null }, log);
      }
      if (stop || (opts.maxPasses != null && passes >= opts.maxPasses)) break;
      const wait = Math.max(1000, (opts.intervalMs ?? 10_000) - (Date.now() - t0));
      await new Promise((res) => setTimeout(res, wait));
    }
  } finally {
    clearInterval(claimTimer);
  }
  log("helper stopped");
}
