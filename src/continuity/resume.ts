import path from "node:path";
import { latestVerifiedSnapshot, snapshotBootstrap, type VerifiedSnapshot } from "./snapshot-evidence.js";
import type pg from "pg";
import { loadAll, type Config } from "../store.js";
import { TYPES } from "../schema.js";
import { claimThread, createThread, getClaim, getThread, headCheckpoint, latestCheckpointAny, pendingOperations, sessionEvents, threadEvents, getSession, summarizeThread, type CheckpointRow, type ClaimRow, type SessionRow, type ThreadRow, type ThreadSummary } from "./store.js";
import { defaultRemoteBranch, diffStat, fetchQuiet, repoRoot, repoIdentity } from "./shadow.js";
import { PREVIEW_MAX_CHARS, sourcesLine, threadSourceCounts, type SourceCounts } from "./evidence.js";
import { readProgress } from "./classify.js";
import { DECISION_RULE, ledgerRefStatuses, renderDecisionsInForce, threadRecordDecisions, writtenLedgerIds, type LedgerRefStatus, type RecordDecisionGroup } from "./packsections.js";
import { parseAsOf, pendingOperationsAsOf, renderVisitDelta, threadVisitDelta, type PackDetail, type VisitDelta } from "./packlean.js";
export { type PackDetail, type VisitDelta } from "./packlean.js";

/**
 * SIGNATURE (for mcp.ts / cli.ts):
 *
 *   buildResumePack(cfg: Config, pool: pg.Pool, threadId: string, opts: ResumeOpts): Promise<ResumePack>
 *
 *   ResumeOpts = {
 *     mode: "continue" | "fork" | "inspect";
 *     author: string;                    // the resuming author (claim holder)
 *     sessionId?: string;                // the resuming session; synthesized if absent
 *     repoPath?: string;                 // local checkout of the same repo, for the intervening diff and bootstrap
 *     budgetTokens?: number;             // default 6000; shrinks sections, never switches detail
 *     detail?: "lean" | "evidence";      // default "lean": "Last assistant messages" and "Since the checkpoint" are capped at
 *                                        // 3 lines each plus the fetch that restores them; "evidence": the pre-2026-09-15 pack
 *     asOf?: string;                     // ISO time: events, checkpoints and pending operations only up to that instant
 *     viewer?: string;                   // the requesting author (mcp passes cfg.author): "Changed since your last visit"
 *                                        // is rendered when the viewer has an earlier session on the thread
 *     now?: Date;
 *   }
 *
 *   MCP wiring: ledger_resume(thread_id) / ledger_thread_get pass { detail, asOf: as_of, viewer: cfg.author }.
 *
 * The resume pack (spec §7). Built mechanically from the store and git; the
 * reader is an LLM and gets evidence, not a summary. Budgeted, and anything
 * dropped for budget is named so it can be fetched.
 *
 * Shape for long threads: instructions keep the first few (the goal) and the
 * last few (what is next) and name the gap; the latest compaction summary the
 * source harness wrote is shown as evidence; recently touched files come
 * before the all-time list.
 */

/** Long instruction lists keep the first INSTRUCTIONS_HEAD (goal-setting) and the last INSTRUCTIONS_TAIL (what's next). */
export const INSTRUCTIONS_HEAD = 3;
export const INSTRUCTIONS_TAIL = 8;
/** The latest compaction summary gets at most this many tokens, and at most SUMMARY_BUDGET_SHARE of the pack budget. */
export const SUMMARY_MAX_TOKENS = 2000;
export const SUMMARY_BUDGET_SHARE = 0.3;
/** "Recent" files: changed within this many minutes before the source session's last_seen_at. */
export const RECENT_FILES_MINUTES = 60;
export const RECENT_FILES_MAX = 15;
export const FILES_MAX = 30;
const INSTRUCTION_CLIP = 400;
const INSTRUCTION_CLIP_MIN = 120;
const INSTRUCTIONS_BUDGET_SHARE = 0.35;

export type ResumeMode = "continue" | "fork" | "inspect";
export type ResumeDetail = PackDetail;
/** Lean detail keeps at most this many lines in "Last assistant messages" and in each part of "Since the checkpoint". */
export const LEAN_SECTION_LINES = 3;
const LEAN_MESSAGE_CLIP = 200;

export interface ResumeOpts {
  mode: ResumeMode;
  author: string;
  /** the session doing the resuming; synthesized if absent */
  sessionId?: string;
  /** a local checkout of the same repo, for the intervening-changes diff and the bootstrap commands */
  repoPath?: string;
  budgetTokens?: number;
  now?: Date;
  /** "lean" (default): messages and since-checkpoint capped at LEAN_SECTION_LINES plus references. "evidence": full lines. */
  detail?: ResumeDetail;
  /** ISO time; events, checkpoints and pending operations after this instant are hidden */
  asOf?: string;
  /** the requesting author; "Changed since your last visit" is rendered when they have an earlier session on the thread */
  viewer?: string;
}

export interface ResumePack {
  thread: ThreadSummary;
  claim: { acquired: boolean; generation?: number; holder?: ClaimRow | null; note: string };
  fork?: ThreadRow;
  checkpoint: Record<string, unknown> | null;
  /** Exact remotely verified snapshot, which may precede the latest unverified checkpoint. */
  snapshot: VerifiedSnapshot | null;
  loss_window: Record<string, unknown>;
  capture_gaps: unknown[];
  /** the instructions shown in the pack, in order (first INSTRUCTIONS_HEAD + last INSTRUCTIONS_TAIL when the list was shaped) */
  instructions: { seq: number; at: string | null; text: string }[];
  /** the gap between head and tail when the list was shaped for budget; null when every instruction is shown */
  instructions_omitted: { count: number; from_seq: number; to_seq: number; fetch: string } | null;
  /** the latest compaction summary written by the source harness; evidence, not memory */
  session_summary: { source: string; harness: string; session_id: string; seq: number; at: string | null; text: string; chars: number; clipped: boolean } | null;
  last_messages: { at: string | null; text: string }[];
  /** files changed in the last RECENT_FILES_MINUTES of the source session, most recent first */
  recent_files: { path: string; count: number; last_at: string | null }[];
  files_touched: { path: string; count: number }[];
  pending_operations: { call_id: string; tool: string; input: string; seq: number }[];
  last_error: Record<string, unknown> | null;
  intervening: { git: string | null; ledger: string[] };
  /** Ledger objects this thread's sessions saved, resolved to what is in force now */
  decisions: LedgerRefStatus[];
  /** decision updates of the work records these sessions contribute to, with how each was accepted */
  record_decisions: RecordDecisionGroup[];
  bootstrap: string[];
  /** what the thread's evidence is made of */
  sources: SourceCounts;
  omitted: string[];
  text: string;
  /** which shape was rendered */
  detail: ResumeDetail;
  /** the as-of instant applied, ISO; null when current */
  as_of: string | null;
  /** what happened after the viewer's last session on the thread; null without a viewer */
  changed_since: VisitDelta | null;
}

const approxTokens = (s: string) => Math.ceil(s.length / 4);
const fmt = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 19).replace("T", " ") + "Z" : "unknown");
const clipTo = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const harnessName = (h: string | null | undefined) => (h === "claude" ? "Claude Code" : h === "codex" ? "Codex" : h || "unknown harness");
const num = (n: number) => n.toLocaleString("en-US");

/** Clip a summary to maxChars, preferring a paragraph boundary, then a line boundary, in the last 40% of the window. */
export function clipSummary(text: string, maxChars: number): { text: string; clipped: boolean } {
  if (text.length <= maxChars) return { text, clipped: false };
  const floor = Math.floor(maxChars * 0.6);
  let cut = text.lastIndexOf("\n\n", maxChars);
  if (cut < floor) cut = text.lastIndexOf("\n", maxChars);
  if (cut < floor) cut = maxChars;
  return { text: text.slice(0, cut).trimEnd(), clipped: true };
}

export async function buildResumePack(cfg: Config, pool: pg.Pool, threadId: string, opts: ResumeOpts): Promise<ResumePack> {
  const now = opts.now ?? new Date();
  const detail: ResumeDetail = opts.detail ?? "lean";
  const budget = opts.budgetTokens ?? 6000;
  const asOf = parseAsOf(opts.asOf);
  const upTo = (d: Date | null | undefined) => !asOf || (d != null && new Date(d).getTime() <= asOf.getTime());
  const evTime = (e: { occurred_at: Date | null; received_at: Date }) => e.occurred_at ?? e.received_at;
  const omitted: string[] = [];
  let t = await getThread(pool, threadId);
  if (!t) throw new Error(`thread not found: ${threadId}`);

  // ----- claim / fork -----
  const sessionId = opts.sessionId ?? `resume:${opts.author}:${now.toISOString()}`;
  let fork: ThreadRow | undefined;
  let claimInfo: ResumePack["claim"];
  if (opts.mode === "fork") {
    const cp = await headCheckpoint(pool, t.id);
    fork = await createThread(pool, { repo: t.repo, branch: t.branch, title: `${t.title} (${opts.author} fork)`, goal: t.goal, created_by: opts.author, forked_from_thread_id: t.id, forked_at_checkpoint_id: cp?.id ?? null });
    const c = await claimThread(pool, fork.id, sessionId, opts.author);
    claimInfo = { acquired: c.ok, generation: c.ok ? c.generation : undefined, holder: null, note: `forked from ${t.id} at checkpoint ${cp?.id ?? "none"}; you own the fork` };
  } else if (opts.mode === "continue") {
    const c = await claimThread(pool, t.id, sessionId, opts.author);
    if (c.ok) claimInfo = { acquired: true, generation: c.generation, holder: null, note: `claim acquired, generation ${c.generation}. Advisory: it protects the shared record, not the other machine.` };
    else claimInfo = { acquired: false, holder: c.holder, note: `claim held by ${c.holder.holder_author} since ${fmt(c.holder.acquired_at)} (heartbeat ${fmt(c.holder.heartbeat_at)}). Read-only pack; use mode=fork to work in parallel, or wait for release/expiry at ${fmt(c.holder.expires_at)}.` };
  } else {
    const live = await getClaim(pool, t.id);
    claimInfo = { acquired: false, holder: live, note: live ? `claim held by ${live.holder_author}; inspect only` : "no live claim; inspect only" };
  }

  // ----- checkpoint & sessions -----
  let head = await headCheckpoint(pool, t.id);
  if (head && !upTo(head.created_at)) head = null;
  let latest = head ?? (asOf
    ? (await pool.query<CheckpointRow>(`select * from cont_checkpoints where thread_id = $1 and created_at <= $2 order by created_at desc limit 1`, [t.id, asOf])).rows[0] ?? null
    : await latestCheckpointAny(pool, t.id));
  if (!head && latest) omitted.push(asOf ? `showing the latest checkpoint at or before the as-of instant, ${latest.id} (${latest.kind})` : `thread has no head checkpoint; showing latest non-head checkpoint ${latest.id} (${latest.kind}, did not advance: claim/generation mismatch at publish)`);
  const summary = await summarizeThread(pool, t);
  // the source session: the checkpoint's, else the thread's most recently seen session
  const srcSession: SessionRow | null = latest ? await getSession(pool, latest.session_id) : summary.last_session ? await getSession(pool, summary.last_session.id) : null;

  // ----- evidence (as-of: rows after the instant are dropped before shaping) -----
  const instrRows = (await threadEvents(pool, t.id, { kinds: ["instruction.added"] })).filter((e) => upTo(evTime(e)));
  const msgRows = asOf
    ? (await threadEvents(pool, t.id, { kinds: ["assistant.message"] })).filter((e) => upTo(evTime(e))).slice(-3)
    : await threadEvents(pool, t.id, { kinds: ["assistant.message"], limit: 3 });
  const fileRows = (await threadEvents(pool, t.id, { kinds: ["file.changed"] })).filter((e) => upTo(evTime(e)));
  const gapRows = (await threadEvents(pool, t.id, { kinds: ["capture.gap"], limit: 20 })).filter((e) => upTo(evTime(e)));
  const compRows = (await threadEvents(pool, t.id, { kinds: ["compaction"] })).filter((e) => upTo(evTime(e)));
  const sources = await threadSourceCounts(pool, t.id);
  const pend = srcSession ? (asOf ? await pendingOperationsAsOf(pool, srcSession.id, asOf) : await pendingOperations(pool, srcSession.id)) : [];
  const errRows = srcSession ? (await sessionEvents(pool, srcSession.id, { kinds: ["tool.finished"] })).filter((e) => upTo(evTime(e))) : [];
  const lastErr = [...errRows].reverse().find((e) => e.payload?.is_error || (typeof e.payload?.stderr_preview === "string" && e.payload.stderr_preview));
  const msgFetch = `ledger_events(thread_id: ${JSON.stringify(t.id)}, kinds: ["assistant.message"], preview_chars: 2000)`;
  const asOfLine = asOf ? `as of ${fmt(asOf)}: events, checkpoints and pending operations after this instant are hidden.` : null;

  // ----- changed since the viewer's last session on this thread -----
  const delta: VisitDelta | null = opts.viewer ? await threadVisitDelta(pool, t.id, pend.map((p) => ({ ...p, session_id: srcSession?.id })), { viewer: opts.viewer, excludeSessionId: opts.sessionId ?? null, asOf, kinds: ["instruction.added", "assistant.message", "tool.requested", "file.changed", "compaction"] }) : null;

  const fileCounts = new Map<string, number>();
  for (const f of fileRows) { const p = String(f.payload?.path ?? ""); if (p) fileCounts.set(p, (fileCounts.get(p) ?? 0) + 1); }
  const files = [...fileCounts].map(([p, n]) => ({ path: p, count: n })).sort((a, b) => b.count - a.count);

  // files changed in the last RECENT_FILES_MINUTES of the source session, by occurred_at relative to its last_seen_at
  let recentFiles: ResumePack["recent_files"] = [];
  if (srcSession?.last_seen_at) {
    const since = new Date(srcSession.last_seen_at).getTime() - RECENT_FILES_MINUTES * 60_000;
    const m = new Map<string, { count: number; last: number }>();
    for (const f of fileRows) {
      const p = String(f.payload?.path ?? "");
      const at = f.occurred_at ? new Date(f.occurred_at).getTime() : null;
      if (!p || f.session_id !== srcSession.id || at == null || at < since) continue;
      const cur = m.get(p) ?? { count: 0, last: 0 };
      m.set(p, { count: cur.count + 1, last: Math.max(cur.last, at) });
    }
    recentFiles = [...m].map(([p, v]) => ({ path: p, count: v.count, last_at: new Date(v.last).toISOString() })).sort((a, b) => (b.last_at! > a.last_at! ? 1 : b.last_at! < a.last_at! ? -1 : b.count - a.count)).slice(0, RECENT_FILES_MAX);
  }
  const topOfFull = new Set(files.slice(0, recentFiles.length).map((f) => f.path));
  const recentIsTop = recentFiles.length > 0 && recentFiles.every((f) => topOfFull.has(f.path));

  // the latest compaction summary with text: written by the source harness while it still held the full context
  const comp = [...compRows].reverse().find((e) => typeof e.payload?.text === "string" && e.payload.text.trim().length > 0) ?? null;
  let sessionSummary: ResumePack["session_summary"] = null;
  const summaryMaxChars = Math.min(SUMMARY_MAX_TOKENS * 4, Math.floor(budget * 4 * SUMMARY_BUDGET_SHARE));
  if (comp) {
    const cs = comp.session_id === srcSession?.id ? srcSession : await getSession(pool, comp.session_id);
    const source = String(comp.payload.source ?? comp.payload.subtype ?? "compaction");
    const full = String(comp.payload.text);
    const c = clipSummary(full, summaryMaxChars);
    sessionSummary = { source, harness: harnessName(cs?.harness ?? (source.startsWith("codex") ? "codex" : source.startsWith("claude") ? "claude" : null)), session_id: comp.session_id, seq: comp.seq, at: comp.occurred_at ? comp.occurred_at.toISOString() : null, text: c.text, chars: full.length, clipped: c.clipped };
  }
  const summaryFetch = sessionSummary ? `ledger_events(session_id: "${sessionSummary.session_id}", kinds: ["compaction"], after_seq: ${sessionSummary.seq - 1}, limit: 1, preview_chars: ${Math.min(sessionSummary.chars, PREVIEW_MAX_CHARS)})` : "";

  // ----- loss window (measured, never a constant) -----
  const lastSeen = srcSession?.last_seen_at ?? null;
  const snapshot = await latestVerifiedSnapshot(pool,{threadId:t.id,asOf});
  const vSnap = snapshot?.verified_at ?? null;
  if (latest?.wip_commit && latest.wip_commit !== snapshot?.commit) omitted.push(`Latest checkpoint ${latest.id} names an unverified or unselected commit ${latest.wip_commit}; it is not the verified bootstrap snapshot.`);
  const vEv = latest?.verified_events_at ?? srcSession?.last_acked_event_at ?? null;
  const secs = (a: Date | null, b: Date | null) => (a && b ? Math.max(0, Math.round((a.getTime() - b.getTime()) / 1000)) : null);
  const loss = {
    last_seen_at: lastSeen, verified_snapshot_at: vSnap, verified_events_at: vEv,
    // A remote verification timestamp does not identify when the tree was captured or bound later edits.
    unsaved_code_seconds: null, since_snapshot_verification_seconds: secs(lastSeen,vSnap),
    verified_snapshot_commit: snapshot?.commit ?? null, verified_snapshot_checkpoint_id: snapshot?.checkpoint_id ?? null,
    unacked_event_seconds: secs(lastSeen, vEv),
    session_ended: Boolean(srcSession?.ended_at),
    in_flight_operations: pend.length,
  };
  const gaps: unknown[] = [...(latest?.capture_gaps ?? []), ...gapRows.map((g) => g.payload)];

  // ----- intervening changes -----
  let gitDiff: string | null = null;
  let bootstrap: string[] = [];
  const wipRef = latest?.wip_ref ?? null;
  const wipCommit = latest?.wip_commit ?? null;
  const baseCommit = latest?.base_commit ?? null;
  const localRepo = opts.repoPath ? repoRoot(opts.repoPath) : null;
  const sameRepo = localRepo ? repoIdentity(localRepo) === t.repo : false;
  if (localRepo && sameRepo) {
    fetchQuiet(localRepo);
    const target = defaultRemoteBranch(localRepo);
    if (baseCommit) {
      const d = diffStat(localRepo, baseCommit, target);
      gitDiff = `${baseCommit.slice(0, 8)}..${target}:\n${d.text}${d.truncated ? "\n(truncated)" : ""}`;
    }
  } else if (opts.repoPath) {
    omitted.push(`intervening git diff skipped: ${localRepo ? `local checkout is ${repoIdentity(localRepo)}, thread repo is ${t.repo}` : `${opts.repoPath} is not a git repo`}`);
  }
  if (snapshot) {
    bootstrap = snapshotBootstrap(snapshot,t.title);
    if (opts.repoPath && (!sameRepo || repoIdentity(localRepo!) !== snapshot.repo)) {
      bootstrap = [];
      omitted.push(`Bootstrap withheld: use a checkout of snapshot repository ${snapshot.repo}; the supplied checkout does not match.`);
    }
  } else {
    omitted.push("no verified code snapshot for this thread: no accepted checkpoint pairs an exact wip commit with its remote verification; code state remains unverified");
  }

  // ----- ledger objects since the checkpoint -----
  const since = latest?.created_at ?? t.created_at;
  const repoTag = path.basename(t.repo).toLowerCase();
  const allObjects = loadAll(cfg, TYPES);
  const ledgerSince = allObjects
    .filter((o) => o.status === "stable" && o.created >= since.toISOString())
    .filter((o) => o.tags.some((x) => x.toLowerCase() === repoTag) || JSON.stringify(o.fields).toLowerCase().includes(repoTag) || o.title.toLowerCase().includes(repoTag))
    .slice(0, 10)
    .map((o) => `${o.type} ${o.id}: ${o.title} (${o.author}, ${o.created.slice(0, 10)})`);

  // ----- decisions in force: Ledger objects this thread's sessions saved, resolved through the authority layer -----
  const saved = await writtenLedgerIds(pool, { threadId: t.id });
  const decisionRefs = ledgerRefStatuses(allObjects, saved.refs);
  const recordDecisions = await threadRecordDecisions(pool, t.id);

  // ----- instructions: chronological when they fit; else first HEAD + last TAIL with the gap named -----
  const instrAll = instrRows.map((e) => ({ seq: e.seq, at: e.occurred_at ? e.occurred_at.toISOString() : null, text: String(e.payload?.text ?? "") }));
  const instrBudgetChars = Math.floor(budget * 4 * INSTRUCTIONS_BUDGET_SHARE);
  const fullClipped = instrAll.map((i) => ({ ...i, text: clipTo(i.text, INSTRUCTION_CLIP) }));
  const fullChars = fullClipped.reduce((n, i) => n + i.text.length, 0);
  let shownInstr: typeof instrAll;
  let instrOmitted: ResumePack["instructions_omitted"] = null;
  if (fullChars <= instrBudgetChars) {
    shownInstr = fullClipped;
  } else if (instrAll.length <= INSTRUCTIONS_HEAD + INSTRUCTIONS_TAIL) {
    const per = Math.max(INSTRUCTION_CLIP_MIN, Math.min(INSTRUCTION_CLIP, Math.floor(instrBudgetChars / Math.max(1, instrAll.length))));
    shownInstr = instrAll.map((i) => ({ ...i, text: clipTo(i.text, per) }));
  } else {
    const per = Math.max(INSTRUCTION_CLIP_MIN, Math.min(INSTRUCTION_CLIP, Math.floor(instrBudgetChars / (INSTRUCTIONS_HEAD + INSTRUCTIONS_TAIL))));
    const gap = instrAll.slice(INSTRUCTIONS_HEAD, instrAll.length - INSTRUCTIONS_TAIL);
    shownInstr = [...instrAll.slice(0, INSTRUCTIONS_HEAD), ...instrAll.slice(-INSTRUCTIONS_TAIL)].map((i) => ({ ...i, text: clipTo(i.text, per) }));
    const from = gap[0].seq, to = gap[gap.length - 1].seq;
    instrOmitted = { count: gap.length, from_seq: from, to_seq: to, fetch: `ledger_events(thread_id: "${t.id}", kinds: ["instruction.added"], after_seq: ${from - 1})` };
    omitted.push(`${gap.length} instructions omitted (seq ${from}..${to}); fetch with ${instrOmitted.fetch}`);
  }

  // ----- render within budget; softer sections shrink first, each drop named -----
  // classifier lag is disclosed, never hidden: organization into work records may trail raw capture
  let lagLine: string | null = null;
  if (srcSession) {
    const cap = (await pool.query<{ m: number }>(`select coalesce(max(seq),0)::int as m from cont_events where session_id = $1`, [srcSession.id])).rows[0].m;
    const cls = readProgress(srcSession.id)?.last_seq ?? 0;
    lagLine = `Classifier: session ${srcSession.id.slice(0, 8)} captured through seq ${cap}, classified through seq ${cls}${cap > cls ? ` (lag ${cap - cls} events; work after seq ${cls} may be unassigned to any record yet)` : " (current)"}.`;
  }

  const render = (level: number): { text: string; omitted: string[] } => {
    const om = [...omitted];
    const L: string[] = [];
    L.push(`# Resume pack: ${t.title}`);
    L.push(`thread ${t.id} · repo ${t.repo}${t.branch ? ` · branch ${t.branch}` : ""} · created by ${t.created_by} ${fmt(t.created_at)} · status ${t.status} · generation ${t.generation}`);
    if (fork) L.push(`FORK: you are on ${fork.id} ("${fork.title}"), forked from the thread above.`);
    L.push(`claim: ${claimInfo.note}`);
    if (asOfLine) L.push(asOfLine);
    L.push(``);
    L.push(`## Honesty`);
    L.push(`Snapshot ${snapshot?.commit.slice(0,12) ?? "unavailable"} verified at ${fmt(vSnap)}${snapshot ? ` (checkpoint ${snapshot.checkpoint_id})` : ""}. Events acknowledged through ${fmt(vEv)}. Source session last seen ${fmt(lastSeen)}${srcSession?.ended_at ? ", ended" : ", not marked ended"}.`);
    if (snapshot) L.push(`Verification applies only to commit ${snapshot.commit}; its timestamp does not bound later uncaptured edits. ${pend.length} in-flight tool call(s) have unknown outcomes.`);
    else L.push(`No exact verified snapshot: treat the code state as unverified.`);
    L.push(`The claim is advisory. It protects the shared record, not the other machine. Any narrative below is generated and unreviewed; machine fields are the evidence.`);
    L.push(sourcesLine(sources));
    if (lagLine) L.push(lagLine);
    if (gaps.length) L.push(`Capture gaps (${gaps.length}): ${JSON.stringify(gaps.slice(0, 6))}${gaps.length > 6 ? " …" : ""}`);
    L.push(``);
    L.push(`## Goal`);
    L.push(t.goal || summary.first_instruction || "(no goal recorded; first instruction below)");
    L.push(``);
    if (sessionSummary) {
      L.push(`## Session summary (written by ${sessionSummary.harness} at compaction; evidence, not memory)`);
      L.push(`source ${sessionSummary.source} · session ${sessionSummary.session_id.slice(0, 8)} seq ${sessionSummary.seq}${sessionSummary.at ? ` · ${fmt(sessionSummary.at)}` : ""} · ${num(sessionSummary.chars)} chars`);
      if (level >= 2) {
        const c = clipSummary(sessionSummary.text, 800);
        L.push(c.text);
        L.push(`(clipped for budget at ${num(c.text.length)} of ${num(sessionSummary.chars)} chars; full text via ${summaryFetch})`);
        om.push(`session summary shortened for budget; full text via ${summaryFetch}`);
      } else {
        L.push(sessionSummary.text);
        if (sessionSummary.clipped) L.push(`(clipped at ${num(sessionSummary.text.length)} of ${num(sessionSummary.chars)} chars; full text via ${summaryFetch})`);
      }
      L.push(``);
    }
    L.push(`## Human instructions (${instrRows.length}, in order${instrOmitted ? `; first ${INSTRUCTIONS_HEAD} and last ${INSTRUCTIONS_TAIL} shown` : ""})`);
    shownInstr.forEach((i, idx) => {
      if (instrOmitted && idx === INSTRUCTIONS_HEAD) L.push(`… ${instrOmitted.count} instructions omitted (seq ${instrOmitted.from_seq}..${instrOmitted.to_seq}); ${instrOmitted.fetch}`);
      L.push(`- [seq ${i.seq}${i.at ? ` ${i.at.slice(11, 16)}` : ""}] ${i.text.replace(/\n+/g, " ")}`);
    });
    L.push(``);
    L.push(`## Checkpoint (${latest ? `${latest.kind}, ${fmt(latest.created_at)}${latest.advanced_head ? "" : ", NOT the head"}` : "none"})`);
    if (latest) {
      L.push(`base_commit ${baseCommit?.slice(0, 10) ?? "?"} · wip ${wipRef ?? "none"} @ ${wipCommit?.slice(0, 10) ?? "?"} · through event seq ${latest.through_event_seq}`);
      const ss = latest.structured_state ?? {};
      if (ss.tools_summary) L.push(`tools: ${JSON.stringify(ss.tools_summary)}`);
      if (ss.last_error) L.push(`last error at publish: ${JSON.stringify(ss.last_error).slice(0, 300)}`);
      if (latest.narrative) L.push(`narrative (${latest.narrative_status}): ${latest.narrative.slice(0, 800)}`);
    }
    L.push(``);
    if (recentFiles.length && !recentIsTop) {
      L.push(`## Files touched in the last ${RECENT_FILES_MINUTES} minutes of the source session (${recentFiles.length})`);
      for (const f of recentFiles) L.push(`- ${f.path} ×${f.count}${f.last_at ? ` (${f.last_at.slice(11, 16)})` : ""}`);
      L.push(``);
    }
    const fileMax = level >= 3 ? 10 : FILES_MAX;
    L.push(`## Files touched (${files.length})`);
    for (const f of files.slice(0, fileMax)) L.push(`- ${f.path} ×${f.count}`);
    if (files.length > fileMax) om.push(`${files.length - fileMax} more touched files${level >= 3 ? " (list shortened for budget)" : ""}; ledger_events(thread_id: "${t.id}", kinds: ["file.changed"])`);
    L.push(``);
    L.push(`## Pending / unknown operations (${pend.length})`);
    for (const p of pend) L.push(`- seq ${p.seq} ${p.tool}: ${String(p.input).replace(/\n+/g, " ").slice(0, 200)}  ← outcome unknown; do not blindly rerun if it mutates anything`);
    if (lastErr) {
      L.push(``); L.push(`## Last error`);
      if (level >= 4) { L.push(`seq ${lastErr.seq} ${String(lastErr.payload?.tool ?? "")} (details omitted for budget; ledger_events(session_id: "${lastErr.session_id}", after_seq: ${lastErr.seq - 1}, limit: 1, preview_chars: 2000))`); om.push("last error details"); }
      else L.push(`seq ${lastErr.seq} ${JSON.stringify({ ...lastErr.payload, output_preview: String(lastErr.payload?.output_preview ?? "").slice(0, 400) })}`);
    }
    L.push(``);
    L.push(`## Last assistant messages`);
    if (level >= 1) { L.push(`(omitted for budget; ledger_events(thread_id: "${t.id}", kinds: ["assistant.message"]))`); om.push(`last assistant messages (omitted for budget; ledger_events(thread_id: "${t.id}", kinds: ["assistant.message"]))`); }
    else if (detail === "lean") {
      // lean: at most LEAN_SECTION_LINES short lines, each a reference to its event; the full text is one fetch away
      for (const m of msgRows.slice(-LEAN_SECTION_LINES)) L.push(`- [${m.occurred_at ? m.occurred_at.toISOString().slice(11, 16) : "?"}] session ${m.session_id.slice(0, 8)} seq ${m.seq}: ${clipTo(String(m.payload?.text ?? "").replace(/\s+/g, " ").trim(), LEAN_MESSAGE_CLIP)}`);
      L.push(`(${msgRows.length ? "clipped; " : "none captured; "}full text via ${msgFetch})`);
      om.push(`assistant message text clipped to ${LEAN_MESSAGE_CLIP} chars in lean detail; ${msgFetch}`);
    }
    else for (const m of msgRows) L.push(`- [${m.occurred_at ? m.occurred_at.toISOString().slice(11, 16) : "?"}] ${String(m.payload?.text ?? "").replace(/\n+/g, " ").slice(0, 600)}`);
    L.push(``);
    for (const line of renderDecisionsInForce(decisionRefs, saved, { compact: level >= 4, groups: recordDecisions, perGroup: level >= 3 ? 2 : 5 })) L.push(line);
    if (level >= 4 && decisionRefs.length) om.push(`Ledger object titles in Decisions in force (ids and status kept); ledger_get per id`);
    L.push(``);
    L.push(`## Since the checkpoint`);
    if (detail === "lean" && gitDiff) {
      // lean: the diff header plus LEAN_SECTION_LINES stat lines; the rest is a git command away
      const lines = gitDiff.split("\n");
      const shown = lines.slice(0, LEAN_SECTION_LINES + 1);
      L.push(`git diff --stat ${shown.join("\n")}`);
      if (lines.length > shown.length) { L.push(`(${lines.length - shown.length} more lines; run git diff --stat ${lines[0].replace(/:$/, "")} in your checkout)`); om.push(`git diff --stat shortened to ${LEAN_SECTION_LINES} lines in lean detail; run git diff --stat ${lines[0].replace(/:$/, "")}`); }
    } else L.push(gitDiff ? `git diff --stat ${gitDiff}` : `git: ${om.find((o) => o.startsWith("intervening")) ?? "no local checkout given; pass repoPath to compute"}`);
    const ledgerCap = detail === "lean" ? LEAN_SECTION_LINES : ledgerSince.length;
    if (level >= 4 && ledgerSince.length) { L.push(`ledger: ${ledgerSince.length} object(s) mentioning ${repoTag} since ${fmt(since)} (list omitted for budget; ledger_search "${repoTag}")`); om.push("ledger objects since the checkpoint"); }
    else if (!ledgerSince.length) L.push(`ledger: nothing new mentioning ${repoTag} since ${fmt(since)}`);
    else {
      L.push(`ledger objects mentioning ${repoTag} since ${fmt(since)}:\n${ledgerSince.slice(0, ledgerCap).map((s) => `- ${s}`).join("\n")}`);
      if (ledgerSince.length > ledgerCap) { L.push(`- … ${ledgerSince.length - ledgerCap} more; ledger_search "${repoTag}"`); om.push(`${ledgerSince.length - ledgerCap} ledger objects since the checkpoint (lean detail); ledger_search "${repoTag}"`); }
    }
    L.push(``);
    if (delta && !delta.first_visit) {
      for (const line of renderVisitDelta(delta, { unit: "thread", created: t.created_at, level: level >= 3 ? 1 : 0 })) L.push(line);
      L.push(``);
    }
    L.push(`## Bootstrap`);
    L.push(bootstrap.length ? "```\n" + bootstrap.join("\n") + "\n```" : "(no snapshot to check out)");
    L.push(``);
    L.push(`## First turn contract`);
    L.push(`1. Check out the snapshot into a fresh worktree and inspect it; do not assume the branch tip matches.`);
    L.push(`2. State what is confirmed (verified snapshot, acknowledged events) vs uncertain (loss window, pending operations, gaps).`);
    L.push(`3. Do not rerun a pending operation that mutates anything until you know its outcome.`);
    L.push(`4. ${DECISION_RULE}`);
    L.push(`5. Say what you are continuing and what your next action is. Record progress as you go; the helper captures automatically.`);
    if (om.length) { L.push(``); L.push(`## Omitted for budget or unavailable`); for (const o of om) L.push(`- ${o}`); }
    return { text: L.join("\n"), omitted: om };
  };

  // shrink the softest sections first: assistant messages, then the summary, then the file list, then error/ledger detail
  let level = 0;
  let out = render(level);
  while (approxTokens(out.text) > budget && level < 4) out = render(++level);

  return {
    thread: summary, claim: claimInfo, fork, checkpoint: latest ? { id: latest.id, kind: latest.kind, created_at: latest.created_at, base_commit: baseCommit, wip_ref: wipRef, wip_commit: wipCommit, verified_snapshot_at: latest.verified_snapshot_at, through_event_seq: latest.through_event_seq, structured_state: latest.structured_state, narrative_status: latest.narrative_status, advanced_head: latest.advanced_head } : null,
    loss_window: loss, capture_gaps: gaps, instructions: shownInstr, instructions_omitted: instrOmitted,
    session_summary: sessionSummary,
    last_messages: msgRows.map((m) => ({ at: m.occurred_at ? m.occurred_at.toISOString() : null, text: String(m.payload?.text ?? "") })),
    recent_files: recentFiles, files_touched: files, pending_operations: pend.map((p) => ({ call_id: p.call_id, tool: p.tool, input: p.input, seq: p.seq })),
    last_error: lastErr ? lastErr.payload : null, intervening: { git: gitDiff, ledger: ledgerSince },
    decisions: decisionRefs, record_decisions: recordDecisions,
    snapshot, bootstrap, sources, omitted: out.omitted, text: out.text,
    detail, as_of: asOf ? asOf.toISOString() : null, changed_since: delta,
  };
}

/** One line per thread for the brief and `ledger threads`. */
export function threadLine(s: ThreadSummary, now = new Date()): string {
  const ls = s.last_session;
  const ago = (d: Date | null | undefined) => (d ? `${Math.round((now.getTime() - new Date(d).getTime()) / 60000)}m ago` : "never");
  const ended = ls?.ended_at ? "ended" : ls?.last_seen_at && now.getTime() - new Date(ls.last_seen_at).getTime() > 10 * 60_000 ? "went quiet" : "active";
  const claim = s.claim ? `claimed by ${s.claim.holder_author}` : "unclaimed";
  // The head checkpoint can be a later `turn` checkpoint with no snapshot verification of its own; the
  // session row keeps the last remotely verified snapshot, so fall back to it before saying "none".
  const verifiedAt = s.head?.wip_commit ? s.head.verified_snapshot_at : null;
  const snap = verifiedAt ? `snapshot ${ago(verifiedAt)}` : ls?.last_verified_snapshot_at
    ? `historical verification ${ago(ls.last_verified_snapshot_at)}; open to resolve exact snapshot` : "no verified snapshot";
  const first = (s.first_instruction ?? s.goal ?? "").replace(/\s+/g, " ").slice(0, 90);
  const last = (s.last_message ?? "").replace(/\s+/g, " ").slice(0, 90);
  return `- ${s.created_by} · ${ls?.harness ?? "?"} · ${path.basename(s.repo)}${s.branch ? ` · ${s.branch}` : ""} · last seen ${ago(ls?.last_seen_at)} (${ended}) · ${snap} · ${claim}\n  "${first}"${last ? ` → "${last}"` : ""}\n  ${s.id}`;
}
