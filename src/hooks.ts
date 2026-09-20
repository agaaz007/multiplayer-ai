import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ledgerHome } from "./store.js";
import { appendIndex, writeSignal } from "./helper/signals.js";
import { captureStaleness, readHeartbeat } from "./helper/heartbeat.js";
import { canonicalToolName, dataToolCalls, evidenceId, responseEnvelope, savedRecord } from "./capture-tools.js";
export { isDataTool, DEFAULT_DATA_TOOLS } from "./capture-tools.js";
import { DEFAULT_DATA_TOOLS } from "./capture-tools.js";

/**
 * The checkpoint loop. Deterministic software decides WHEN to check for
 * durable knowledge; the agent decides WHAT it was; the schema decides what
 * fields it must have. This module is the WHEN.
 *
 *   SessionStart  read: brief, plus any uncaptured work from before a compaction
 *   PostToolUse   track: every data-tool call goes in a per-session journal
 *   Stop          flush: unresolved evidence IDs? block once, list them
 *   PreCompact    checkpoint: inject the same list before context is compressed
 *   SessionEnd    reconcile: note capture debt for stats
 *
 * The journal is local (~/.ledger/sessions/<session_id>.json), never in the
 * data repo. It is evidence for the nudge and input to `ledger stats`.
 *
 * One nudge per batch of uncaptured work. Successful saves or dismissals only
 * resolve the exact evidence IDs explicitly acknowledged by that operation.
 * A second Stop with the same debt passes and is logged as unresolved, so the
 * pilot can count how often the nudge was ignored.
 */

export type EntryKind = "query" | "decision" | "record" | "skip" | "search" | "nudge" | "unresolved" | "compact" | "end" | "bind" | "gate";

export interface JournalEntry {
  at: string;
  kind: EntryKind;
  tool?: string;
  summary?: string;
  id?: string;
  evidence_id?: string;
  evidence_ids?: string[];
  capture_status?: CaptureAck["status"];
  input_complete?: boolean;
  /** decision entries: the work record the classifier proposed the decision on */
  record_title?: string;
  /** query entries: a material pull (not a metadata call, and the response carried numbers or rows). Absent on entries journaled before 2026-09-17. */
  material?: boolean;
}

export interface CaptureCoverage { session_id: string; evidence_ids: string[] }
export interface CaptureAck {
  schema: "ledger-capture/v1";
  action: "record" | "skip";
  status: "recorded" | "pending_review" | "dismissed";
  coverage: CaptureCoverage[];
  record_id?: string;
  reason?: string;
}

export interface Journal {
  session_id: string;
  started: string;
  cwd?: string;
  /** from the hook input when the agent provides it (Claude Code does); else resolved by session id */
  transcript_path?: string;
  entries: JournalEntry[];
  /** fingerprint of the debt last nudged; same debt is never nudged twice */
  nudged?: string;
  /** the open investigation this analysis session is bound to (ledger_investigation_bind / ledger_investigation_new) */
  investigation?: { record_id: string; title?: string; at: string };
  /** Stop already blocked once for "material queries, no investigation binding"; a bind clears the condition itself */
  unbound_nudged?: boolean;
  /** Latest fallback batch. Coverage is explicit; a resumed session can accrue new debt. */
  extracted?: { at: string; result: "none" | "drafts" | "skipped" | "error"; reason: string; draft_ids: string[]; attempts?: number; evidence_ids?: string[] };
  extractions?: NonNullable<Journal["extracted"]>[];
}

export interface HookResult {
  stdout?: string;
  stderr?: string;
  exit: number;
  /** SessionEnd with capture debt: the caller should start the transcript fallback for this session */
  reconcile?: boolean;
}

export interface HookOpts {
  dir?: string;
  dataTools?: string[];
  now?: Date;
}

/** ledger_propose_finding (query-grain draft, 2026-09-17) saves a draft with a pending_review capture_ack; the same acknowledgment path applies. */
const RECORD_TOOL = /^mcp__ledger__ledger_(record_(finding|decision|change|definition)|propose_finding)$/;
const SKIP_TOOL = "mcp__ledger__ledger_skip_record";
const SEARCH_TOOLS = /^mcp__ledger__ledger_(search|brief|get|investigations)$/;
/** Binding an analysis session to an investigation record; the success envelope carries structuredContent.record_id. */
const BIND_TOOL = /^mcp__ledger__ledger_investigation_(bind|new)$/;

/**
 * A metadata call (schemas, table lists, property catalogues, health checks) is not analysis; neither is a query
 * whose result carried no numbers or rows. Only material pulls gate on an investigation binding and are proposed
 * at query grain.
 */
const METADATA_CALL = /list_|describe|schema|tables|databases|get_properties|get_events$|whoami|health/i;
const EMPTY_RESULT = /^\s*(\[\s*\]|\{\s*\}|null|no (rows|results|data)( returned| found)?\.?|0 rows?( returned)?\.?|empty( result)?\.?)\s*$/i;

function responseRows(r: any): unknown[] | null {
  if (!r || typeof r !== "object") return null;
  for (const k of ["rows", "data", "results", "records", "series"]) if (Array.isArray(r[k])) return r[k];
  const sc = r.structuredContent;
  if (sc && typeof sc === "object") for (const k of ["rows", "data", "results", "records", "series"]) if (Array.isArray(sc[k])) return sc[k];
  return null;
}

/** Pure: is this journaled data-tool call a material pull (see METADATA_CALL). No response, an error, or an empty result is not. */
export function isMaterialPull(tool: string, input: unknown, response: unknown): boolean {
  if (METADATA_CALL.test(canonicalToolName(tool))) return false;
  const text = typeof input === "string" ? input : summarize(input, 2000);
  if (METADATA_CALL.test(text)) return false;
  if (response == null) return false;
  const env = responseEnvelope(response);
  if (env.isError === true || env.is_error === true || env.success === false) return false;
  const rows = responseRows(env);
  if (rows) return rows.length > 0;
  const body = responseText(response);
  if (!body.trim() || EMPTY_RESULT.test(body)) return false;
  return /\d/.test(body);
}

export function sessionsDir(): string {
  return path.join(ledgerHome(), "sessions");
}

function journalPath(sessionId: string, dir: string): string {
  return path.join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export function loadJournal(sessionId: string, dir = sessionsDir()): Journal {
  const f = journalPath(sessionId, dir);
  if (fs.existsSync(f)) {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (error: any) {
      throw new Error(`Capture journal unreadable; refusing to overwrite outstanding evidence: ${f} (${error?.message ?? error})`);
    }
  }
  return { session_id: sessionId, started: new Date().toISOString(), entries: [] };
}

const heldJournalLocks = new Set<string>();
/** Atomic replacement avoids partial JSON; this lock also prevents concurrent hooks dropping each other's entries. */
export function withJournalLock<T>(sessionId: string, operation: () => T, dir = sessionsDir()): T {
  fs.mkdirSync(dir, { recursive: true });
  const lock = `${journalPath(sessionId, dir)}.lock`;
  if (heldJournalLocks.has(lock)) return operation();
  const deadline = Date.now() + 3000;
  while (true) {
    try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "owner"), String(process.pid)); break; }
    catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const pid = Number(fs.readFileSync(path.join(lock, "owner"), "utf8"));
        if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); } catch (e: any) { stale = e?.code === "ESRCH"; } }
      } catch { try { stale = Date.now() - fs.statSync(lock).mtimeMs > 30_000; } catch { /* another process released it */ } }
      if (stale) { try { fs.rmSync(lock, { recursive: true }); } catch { /* raced with another recovery */ } continue; }
      if (Date.now() >= deadline) throw new Error(`Capture journal busy; no evidence was overwritten: ${sessionId}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  heldJournalLocks.add(lock);
  try { return operation(); }
  finally { heldJournalLocks.delete(lock); fs.rmSync(lock, { recursive: true, force: true }); }
}

export function saveJournal(j: Journal, dir = sessionsDir()): void {
  fs.mkdirSync(dir, { recursive: true });
  const target = journalPath(j.session_id, dir), tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n");
  fs.renameSync(tmp, target);
}

/**
 * The query-like part of a tool input, one line, capped. The nudge quotes it
 * back at 200 chars; the transcript fallback asks for more so the extractor
 * sees the whole query.
 */
export function summarize(toolInput: any, max = 200): string {
  if (toolInput == null) return "";
  if (typeof toolInput === "string") return clip(toolInput, max);
  for (const k of ["sql", "query", "command", "cmd", "question", "text", "prompt", "q", "jql", "expression"]) {
    const v = toolInput[k];
    if (typeof v === "string" && v.trim()) return clip(v, max);
  }
  return clip(JSON.stringify(toolInput), max);
}

function clip(s: string, n = 200): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function responseText(r: any): string {
  if (r == null) return "";
  if (typeof r === "string") return r;
  if (Array.isArray(r?.content)) return r.content.map((c: any) => c?.text ?? "").join("\n");
  return JSON.stringify(r);
}

const queryIdentity = (e: JournalEntry): string => e.evidence_id ?? evidenceId(undefined, e.tool ?? "", e.at, e.summary ?? "");

function obligations(j: Journal): { query: JournalEntry; status: CaptureAck["status"] | "unresolved" }[] {
  const queries = new Map<string, JournalEntry>(), states = new Map<string, CaptureAck["status"]>();
  for (const entry of j.entries) {
    if (entry.kind === "query" || entry.kind === "decision") { const id = queryIdentity(entry); queries.set(id, { ...entry, evidence_id: id }); }
    else if ((entry.kind === "record" || entry.kind === "skip") && entry.capture_status) {
      for (const id of entry.evidence_ids ?? []) if (queries.has(id)) states.set(id, entry.capture_status);
    }
  }
  return [...queries].map(([id, query]) => ({ query, status: states.get(id) ?? "unresolved" }));
}

/** Legacy unscoped saves cannot establish which evidence they captured. */
export function debt(j: Journal): JournalEntry[] {
  return obligations(j).filter(e => e.status === "unresolved").map(e => e.query);
}

export function reviewDebt(j: Journal): JournalEntry[] {
  return obligations(j).filter(e => e.status === "pending_review").map(e => e.query);
}

/** Includes settled legacy entries using the same deterministic identities as the debt projection. */
export function captureEvidenceIds(j: Journal): string[] {
  return obligations(j).map(e => e.query.evidence_id!);
}

/** Parse exact explicit receipt coverage without asserting where the source journals live. */
export function normalizeCaptureCoverage(value: unknown): CaptureCoverage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new Error("capture_coverage must be an array of at most 50 session/evidence lists");
  const result: CaptureCoverage[] = [], seenSessions = new Set<string>();
  for (const item of value) {
    if (!item || typeof item.session_id !== "string" || !item.session_id.trim() || !Array.isArray(item.evidence_ids) || !item.evidence_ids.length || item.evidence_ids.length > 500) throw new Error("capture_coverage requires explicit session_id and 1–500 evidence_ids");
    if (seenSessions.has(item.session_id)) throw new Error(`duplicate capture session: ${item.session_id}`);
    seenSessions.add(item.session_id);
    const ids = item.evidence_ids;
    if (ids.some((id: unknown) => typeof id !== "string" || !id.length) || new Set(ids).size !== ids.length) throw new Error(`capture_coverage contains invalid or duplicate evidence IDs for session ${item.session_id}`);
    result.push({ session_id: item.session_id, evidence_ids: [...ids].sort() });
  }
  return result.sort((a, b) => a.session_id.localeCompare(b.session_id));
}

/**
 * Evidence IDs are minted with a `q:` prefix (see capture-tools) and printed that way in the
 * checkpoint reminder, so the common mistake is passing the bare call id. Name the exact repair
 * rather than leaving the caller to guess the format.
 */
function unknownIdHint(missing: string[], known: Set<string>): string {
  const fixable = missing.filter(id => known.has(`q:${id}`));
  if (fixable.length) return `IDs are prefixed: pass ${fixable.map(id => `"q:${id}"`).join(", ")} exactly as printed.`;
  const sample = [...known].slice(0, 3);
  return sample.length ? `Outstanding IDs for this session are: ${sample.join(", ")}${known.size > sample.length ? `, and ${known.size - sample.length} more` : ""}.` : `This session has no outstanding capture evidence.`;
}

/** Validate explicit coverage against this machine's journals, never infer a session or remote membership. */
export function validateCaptureCoverage(value: unknown, dir = sessionsDir()): CaptureCoverage[] {
  const result = normalizeCaptureCoverage(value);
  for (const item of result) {
    const known = new Set(captureEvidenceIds(loadJournal(item.session_id, dir)));
    const missing = item.evidence_ids.filter(id => !known.has(id));
    if (missing.length) throw new Error(`capture_coverage contains unknown evidence IDs for local session ${item.session_id}: ${missing.join(", ")}. ${unknownIdHint(missing, known)}`);
  }
  return result;
}

function validAck(ack: CaptureAck): boolean {
  return ack?.schema === "ledger-capture/v1" &&
    (ack.action === "record" && ["recorded", "pending_review"].includes(ack.status) && typeof ack.record_id === "string" && /^(fnd|dec|chg|def)-\d{8}-[\w-]+$/.test(ack.record_id) ||
      ack.action === "skip" && ack.status === "dismissed" && typeof ack.reason === "string" && ack.reason.trim().length >= 5);
}

/** Call only after a successful durable save/dismissal; hooks additionally verify the tool result and request. */
export function acknowledgeCapture(ack: CaptureAck, opts: { dir?: string; now?: Date } = {}): { acknowledged: number; pending_review: number } {
  if (!validAck(ack)) throw new Error("invalid successful capture acknowledgment");
  const dir = opts.dir ?? sessionsDir(), coverage = validateCaptureCoverage(ack.coverage, dir);
  let acknowledged = 0, pending_review = 0;
  for (const item of coverage) {
    withJournalLock(item.session_id, () => {
    const j = loadJournal(item.session_id, dir);
    const states = new Map(obligations(j).map(o => [o.query.evidence_id, o.status]));
    // Duplicate host delivery is idempotent; a later draft must not undo already recorded evidence.
    const ids = item.evidence_ids.filter(id => states.get(id) !== ack.status && !(ack.status === "pending_review" && states.get(id) !== "unresolved"));
    if (!ids.length) return;
    const audit = ack.action === "record" ? [...j.entries].reverse().find(e => e.kind === "record" && e.id === ack.record_id && !e.capture_status) : undefined;
    if (audit) { audit.evidence_ids = ids; audit.capture_status = ack.status; }
    else j.entries.push({ at: (opts.now ?? new Date()).toISOString(), kind: ack.action === "skip" ? "skip" : "record", id: ack.record_id, summary: ack.reason, evidence_ids: ids, capture_status: ack.status });
    saveJournal(j, dir); acknowledged += ids.length; if (ack.status === "pending_review") pending_review += ids.length;
    }, dir);
  }
  return { acknowledged, pending_review };
}

export const DECISION_EVIDENCE_PREFIX = "d:";
export interface DecisionObligation { update_id: string; record_title: string; text: string }

/**
 * The helper's classifier found a decision in this session's conversation and proposed it on a work record. A decision
 * reached in conversation calls no data tool, so the checkpoint never asked about one (2026-09-14). The next Stop,
 * PreCompact or SessionStart lists it beside uncaptured queries. It is settled like them, by recording a Ledger decision
 * or skipping with a reason (both with capture_coverage), or by rejecting the proposal. Returns how many were new.
 */
export function addDecisionObligations(sessionId: string, items: DecisionObligation[], opts: { dir?: string; now?: Date } = {}): number {
  if (!sessionId || !items.length) return 0;
  const dir = opts.dir ?? sessionsDir();
  return withJournalLock(sessionId, () => {
    const j = loadJournal(sessionId, dir);
    const known = new Set(j.entries.filter((e) => e.kind === "decision").map((e) => e.evidence_id));
    let added = 0;
    for (const it of items) {
      const id = `${DECISION_EVIDENCE_PREFIX}${it.update_id}`;
      if (known.has(id)) continue;
      j.entries.push({ at: (opts.now ?? new Date()).toISOString(), kind: "decision", tool: "classifier", evidence_id: id, record_title: clip(it.record_title, 120), summary: clip(it.text, 300) });
      known.add(id);
      added++;
    }
    if (added) saveJournal(j, dir);
    return added;
  }, dir);
}

export function fingerprint(d: JournalEntry[]): string {
  return d.map(queryIdentity).sort().join("|");
}

export function debtText(d: JournalEntry[]): string {
  return d.map((e) => e.kind === "decision"
    ? `- ${queryIdentity(e)} · ${e.at.slice(11, 16)} decision proposed on record "${e.record_title || "untitled"}": ${e.summary}`
    : `- ${queryIdentity(e)} · ${e.at.slice(11, 16)} ${e.tool}: ${e.summary}${e.input_complete === false ? " [input unresolved/incomplete]" : ""}`).join("\n");
}

/** "2 data queries", "1 decision found in this conversation", or both joined with "and". */
function debtNoun(d: JournalEntry[]): string {
  const decisions = d.filter((e) => e.kind === "decision").length, queries = d.length - decisions;
  return [
    queries ? `${queries} data quer${queries === 1 ? "y" : "ies"}` : "",
    decisions ? `${decisions} decision${decisions === 1 ? "" : "s"} found in this conversation` : "",
  ].filter(Boolean).join(" and ");
}

const RESOLVE =
  `Do one of:\n` +
  `1. Record it: ledger_record_finding (question, result, inputs, method, assumptions with at least one implicit), ` +
  `or ledger_record_decision / ledger_record_change / ledger_record_definition if that is what this was. ` +
  `A rough number with its assumptions written down beats no record; use confidence: low.\n` +
  `2. Or call ledger_skip_record with the reason this evidence produced no durable finding (exploration, a check that confirmed nothing, a dead end).\n` +
  `In either case include capture_coverage: [{session_id: the session printed here, evidence_ids: the exact query IDs covered}]. Unrelated saves and unscoped skips do not clear these obligations.`;

/** Extra guidance when the list includes decisions the classifier found in the conversation. */
function decisionsResolve(d: JournalEntry[]): string {
  if (!d.some((e) => e.kind === "decision")) return "";
  return `\nFor a d: item (a decision found in the conversation): if a person decided it, record it with ledger_record_decision under their name. ` +
    `If nobody decided it (still exploring, a suggestion nobody accepted) or it is already recorded, call ledger_skip_record with that reason. ` +
    `Rejecting the proposal with ledger_record_update(action: "reject") also settles it. Use the d: ID in capture_coverage.`;
}

/** Decision in force: analysis scope is an investigation record, bound or declared, never "just a thread on this repo". */
export const BIND_DECISION_ID = "dec-20260917-multi-pm-continuity-bind-or-new-at-session-start-u44f";

/** PostToolUse additional context on the first material pull of an unbound session (once per session). */
export const GATE_TEXT =
  `Ledger: analysis session is not bound to an investigation. Before more queries: ledger_investigations(q: "<question>") ` +
  `then ledger_investigation_bind(record_id) or ledger_investigation_new(question). Non-repo work is fine; do not proceed as just a thread on this repo.`;

/** Material pulls journaled in this session (see isMaterialPull), whatever their capture status. */
export function materialQueries(j: Journal): JournalEntry[] {
  return j.entries.filter((e) => e.kind === "query" && e.material === true);
}

/**
 * Stop reason when material queries ran and no investigation is bound. Same once-per-fingerprint rule as the
 * debt block; ledger_investigation_bind / ledger_investigation_new later in the session clears it.
 */
export function unboundReason(material: JournalEntry[]): string {
  return (
    `Ledger: this session ran ${material.length} material data quer${material.length === 1 ? "y" : "ies"} but is not bound to an investigation (${BIND_DECISION_ID}). ` +
    `Resolve scope first: ledger_investigations(q: "<question>") then ledger_investigation_bind(record_id) or ledger_investigation_new(question). ` +
    `Non-repo work is fine; do not proceed as just a thread on this repo. Binding clears this block; the queries below stay owed either way.`
  );
}

/**
 * The QUERY GRAIN: each material pull in the debt is one candidate finding, proposed with ledger_propose_finding
 * against its own q: id. Non-material queries keep the RESOLVE wording.
 */
function queryGrain(d: JournalEntry[]): string {
  const material = d.filter((e) => e.kind === "query" && e.material === true);
  if (!material.length) return "";
  return (
    `QUERY GRAIN: ${material.length} of these returned material results; each is one finding at query grain:\n` +
    material.map((e) => `- ${queryIdentity(e)} · ${e.tool}: ${e.summary}`).join("\n") +
    `\nFor each, propose a finding at query grain with ledger_propose_finding({ population, metric, window, result, query_ref: "q:<id>" }) ` +
    `(the bound investigation is attached automatically), or dismiss it with ledger_skip_record and a reason. Use the q: id in capture_coverage.\n\n`
  );
}

function stopReason(d: JournalEntry[]): string {
  return (
    `Ledger: ${debtNoun(d)} still lack an explicitly scoped capture acknowledgment:\n` +
    debtText(d) +
    `\n\n` +
    queryGrain(d) +
    RESOLVE + decisionsResolve(d) +
    `\nThis reminder fires once per batch of uncaptured work.`
  );
}

/** The block SessionStart prints after a compaction or resume when work is uncaptured. */
export function sessionStartContext(j: Journal): string {
  const d = debt(j), review = reviewDebt(j);
  if (!d.length && !review.length) return "";
  const pending = review.length ? `\n\n## Captured evidence awaiting review\n\nSession ${j.session_id}: ${review.length} query result(s) have a draft, not an accepted finding.\n${debtText(review)}` : "";
  if (!d.length) return pending.trim();
  return (
    `## Uncaptured work from earlier in this session\n\n` +
    `Session ${j.session_id}: ${debtNoun(d)} have no explicitly scoped record. Context may have been compacted; ${d.some((e) => e.kind === "decision") ? "they are" : "the queries are"} still known:\n` +
    debtText(d) +
    `\n\n` +
    queryGrain(d) + RESOLVE + decisionsResolve(d) + pending
  );
}

export function handleHook(event: string, input: any, opts: HookOpts = {}): HookResult {
  const sessionId = String(input?.session_id ?? "");
  if (!sessionId) return { exit: 0 };
  return withJournalLock(sessionId, () => handleHookLocked(event, input, opts), opts.dir ?? sessionsDir());
}

/**
 * Continuity lines for SessionStart, only on a machine whose capture helper has written a heartbeat:
 * the session id the MCP continuity tools need (their environment can be stale or absent), and a
 * warning when capture here is dead, stalled or failing.
 */
export function continuityStartContext(sessionId: string, now = new Date()): string {
  const hb = readHeartbeat();
  if (!sessionId || !/^[A-Za-z0-9_-]{8,}$/.test(sessionId)) return "";
  const lines = [`Ledger session: ${sessionId}. Pass session_id: "${sessionId}" to ledger_investigation_bind, ledger_investigation_new, ledger_propose_finding, ledger_resume, ledger_thread_start, ledger_thread_bind, ledger_thread_note and ledger_release.`];
  if (!hb) return [...lines, "Capture status unknown: no local helper heartbeat is available."].join("\n");
  const stale = captureStaleness(hb, now);
  if (stale) lines.push(`WARNING: ${stale}`);
  return lines.join("\n");
}

function handleHookLocked(event: string, input: any, opts: HookOpts = {}): HookResult {
  const dir = opts.dir ?? sessionsDir();
  const now = (opts.now ?? new Date()).toISOString();
  const sessionId = String(input?.session_id ?? "");
  if (!sessionId) return { exit: 0 };
  const j = loadJournal(sessionId, dir);
  if (input?.cwd && !j.cwd) j.cwd = String(input.cwd);
  if (input?.transcript_path && !j.transcript_path) j.transcript_path = String(input.transcript_path);

  switch (event) {
    case "SessionStart": {
      saveJournal(j, dir);
      const ctx = [continuityStartContext(sessionId, opts.now ?? new Date()), sessionStartContext(j)].filter(Boolean).join("\n\n");
      return { stdout: ctx, exit: 0 };
    }

    case "PostToolUse": {
      const tool = canonicalToolName(String(input?.tool_name ?? ""));
      // continuity: index every tool call locally so the helper can reconcile the transcript against it
      try { appendIndex(sessionId, { at: now, tool, id: input?.tool_use_id ? String(input.tool_use_id) : undefined }); } catch { /* best-effort */ }
      if (RECORD_TOOL.test(tool)) {
        const saved = savedRecord(input?.tool_response);
        if (saved && !j.entries.some(e => e.kind === "record" && e.id === saved.id)) {
          j.entries.push({ at: now, kind: "record", tool, id: saved.id, summary: clip(String(input?.tool_input?.title ?? "")) });
        }
      } else if (tool === SKIP_TOOL) {
        // A skip is recorded only through its validated successful acknowledgment below.
      } else if (SEARCH_TOOLS.test(tool)) {
        j.entries.push({ at: now, kind: "search", tool, summary: summarize(input?.tool_input) });
      } else if (BIND_TOOL.test(tool)) {
        // A successful bind/declare names the record in structuredContent; the journal remembers it across compactions.
        // Read it at either depth: Claude Code hands PostToolUse the structuredContent already flattened
        // (a JSON string of {record_id, title, ...}), so insisting on the MCP envelope left every bound
        // session looking unbound — the gate fired and the Stop block held after a successful bind.
        const resp = responseEnvelope(input?.tool_response), sc = resp.structuredContent ?? resp;
        const recordId = typeof sc?.record_id === "string" ? sc.record_id : undefined;
        if (recordId && !(resp.isError === true || resp.is_error === true || resp.success === false)) {
          const title = typeof sc?.title === "string" ? clip(sc.title, 140) : undefined;
          j.investigation = { record_id: recordId, ...(title ? { title } : {}), at: now };
          j.entries.push({ at: now, kind: "bind", tool, id: recordId, summary: title ?? clip(String(input?.tool_input?.question ?? "")) });
          saveJournal(j, dir);
        }
        return { exit: 0 };
      } else {
        const callId = input?.tool_use_id ? String(input.tool_use_id) : undefined;
        const calls = dataToolCalls(tool, input?.tool_input, callId ?? `legacy:${evidenceId(undefined, tool, now, summarize(input?.tool_input))}`, opts.dataTools ?? DEFAULT_DATA_TOOLS);
        if (!calls.length) return { exit: 0 };
        let material = false;
        for (const call of calls) {
          const id = evidenceId(call.call_id, call.tool, now, call.input);
          const isMaterial = isMaterialPull(call.tool, call.input, input?.tool_response);
          material ||= isMaterial;
          if (!j.entries.some(e => e.kind === "query" && queryIdentity(e) === id)) j.entries.push({ at: now, kind: "query", tool: call.tool, summary: summarize(call.input), evidence_id: id, input_complete: call.input_complete, material: isMaterial });
        }
        // The gate: the first material pull in a session with no investigation binding gets the bind-or-declare
        // instruction once (decision dec-20260917-multi-pm-continuity-bind-or-new-at-session-start-u44f).
        if (material && !j.investigation && !j.entries.some(e => e.kind === "gate")) {
          j.entries.push({ at: now, kind: "gate", summary: "unbound material pull" });
          saveJournal(j, dir);
          const ctx = GATE_TEXT;
          return {
            // hookSpecificOutput.additionalContext is the Claude Code PostToolUse shape; the top-level copies and
            // stderr are the plain text for hosts that read either. Exit 0: the tool already ran.
            stdout: JSON.stringify({ additionalContext: ctx, systemMessage: ctx, hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx } }),
            stderr: ctx,
            exit: 0,
          };
        }
      }
      saveJournal(j, dir);
      if (RECORD_TOOL.test(tool) || tool === SKIP_TOOL) {
        const resp = responseEnvelope(input?.tool_response), ack = resp.structuredContent?.capture_ack as CaptureAck | undefined;
        if (ack && !resp.isError && !resp.is_error && resp.success !== false) {
          try {
            const requested = normalizeCaptureCoverage(input?.tool_input?.capture_coverage);
            const returned = normalizeCaptureCoverage(ack.coverage);
            const success = RECORD_TOOL.test(tool) ? savedRecord(resp) : null;
            if (JSON.stringify(requested) === JSON.stringify(returned) && returned.length &&
              (tool === SKIP_TOOL ? ack.action === "skip" && ack.reason === input?.tool_input?.reason : ack.action === "record" && success?.id === ack.record_id && (success?.status === "draft" ? ack.status === "pending_review" : ack.status === "recorded"))) {
              // A remote MCP receipt may cover another laptop as well as this one. Its
              // successful exact receipt can settle only evidence actually journaled here.
              const local = returned.flatMap(item => {
                const known = new Set(captureEvidenceIds(loadJournal(item.session_id, dir)));
                const evidence_ids = item.evidence_ids.filter(id => known.has(id));
                return evidence_ids.length ? [{ session_id: item.session_id, evidence_ids }] : [];
              });
              acknowledgeCapture({ ...ack, coverage: local }, { dir, now: opts.now });
            }
          } catch { /* invalid/mismatched evidence is never acknowledged by a hook */ }
        }
      }
      return { exit: 0 };
    }

    case "Stop": {
      // continuity: end of turn is the primary `turn` checkpoint trigger; the helper does the work
      try { writeSignal(sessionId, "checkpoint"); } catch { /* best-effort */ }
      const d = debt(j);
      // material pulls with no investigation binding block too (BIND_DECISION_ID), once per session; a bind later
      // in the session clears the condition, and never re-opens a debt nudge for the same queries
      // Only material queries still owed count: a probe dismissed with ledger_skip_record (or covered by a
      // recorded finding) must not force a bind on a session that is not doing analysis.
      const owed = new Set(d.map(queryIdentity));
      const unbound = j.investigation ? [] : materialQueries(j).filter((e) => owed.has(queryIdentity(e)));
      if (!d.length && !unbound.length) return { exit: 0 };
      const fp = fingerprint(d);
      const debtDue = d.length > 0 && j.nudged !== fp;
      const unboundDue = unbound.length > 0 && !j.unbound_nudged;
      if (input?.stop_hook_active || (!debtDue && !unboundDue)) {
        // already nudged for this work (or we are inside a stop-hook continuation): let it go, count it
        if (d.length && !j.entries.some((e) => e.kind === "unresolved" && e.summary === fp)) {
          j.entries.push({ at: now, kind: "unresolved", summary: fp });
          saveJournal(j, dir);
        }
        return { exit: 0 };
      }
      if (debtDue) { j.nudged = fp; j.entries.push({ at: now, kind: "nudge", summary: fp, evidence_ids: d.map(queryIdentity) }); }
      if (unboundDue) { j.unbound_nudged = true; j.entries.push({ at: now, kind: "nudge", summary: "unbound", evidence_ids: unbound.map(queryIdentity) }); }
      saveJournal(j, dir);
      // JSON on stdout, exit 0: the block form both Claude Code and Codex document.
      // Top-level decision/reason is the original Claude shape and the Codex shape;
      // hookSpecificOutput is the current Claude shape. Emit both.
      const reason = `Session ${j.session_id}\n` + [unbound.length ? unboundReason(unbound) : "", d.length ? stopReason(d) : ""].filter(Boolean).join("\n\n");
      return {
        stdout: JSON.stringify({ decision: "block", reason, hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason } }),
        exit: 0,
      };
    }

    case "PreCompact": {
      try { writeSignal(sessionId, "checkpoint"); } catch { /* best-effort */ }
      const d = debt(j);
      if (!d.length) return { exit: 0 };
      j.entries.push({ at: now, kind: "compact", summary: fingerprint(d), evidence_ids: d.map(queryIdentity) });
      saveJournal(j, dir);
      const ctx =
        `Ledger: session ${j.session_id} is about to be compacted and ${debtNoun(d)} have no scoped record:\n` +
        debtText(d) +
        `\n\nRecord it now, while the method and assumptions are still in context.\n` +
        queryGrain(d) + RESOLVE + decisionsResolve(d);
      return {
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreCompact", additionalContext: ctx } }),
        exit: 0,
      };
    }

    case "SessionEnd": {
      try { writeSignal(sessionId, "end"); } catch { /* best-effort */ }
      // only query debt goes to the transcript fallback; a decision prompt already sits on its work record as PROPOSED
      const d = debt(j).filter((e) => e.kind === "query");
      if (d.length) {
        j.entries.push({ at: now, kind: "end", summary: `${d.length} uncaptured` });
        saveJournal(j, dir);
        // live capture failed for this session: hand it to the transcript fallback now
        return { exit: 0, reconcile: true };
      }
      return { exit: 0 };
    }

    default:
      return { exit: 0 };
  }
}

/** For `ledger stats`: did the checkpoint loop do anything, and did the agent respond. */
export function captureStats(days: number, dir = sessionsDir()): string[] {
  if (!fs.existsSync(dir)) return [`  capture: no sessions journaled yet (run \`ledger install claude\`)`];
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const journals: Journal[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const j: Journal = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (j.started >= since) journals.push(j);
    } catch {
      /* skip */
    }
  }
  const n = (k: EntryKind) => journals.reduce((s, j) => s + j.entries.filter((e) => e.kind === k).length, 0);
  // A record responded to a checkpoint only if it covered an ID that checkpoint
  // named. Unrelated saves/skips do not reset this attribution either.
  let prompted = 0;
  for (const j of journals) {
    const pending = new Set<string>();
    for (const e of j.entries) {
      if (e.kind === "nudge" || e.kind === "compact") for (const id of e.evidence_ids ?? []) pending.add(id);
      else if ((e.kind === "record" || e.kind === "skip") && e.capture_status) {
        if (e.kind === "record" && e.evidence_ids?.some(id => pending.has(id))) prompted++;
        for (const id of e.evidence_ids ?? []) pending.delete(id);
      }
    }
  }
  const endedWithDebt = journals.filter((j) => debt(j).length > 0).length;
  const sessionsWithQueries = journals.filter((j) => j.entries.some((e) => e.kind === "query")).length;
  return [
    `  capture (this machine): sessions ${journals.length}, with data queries ${sessionsWithQueries}, queries ${n("query")}`,
    `    records ${n("record")} (${n("record") - prompted} unprompted, ${prompted} after a checkpoint), nudges ${n("nudge")}, explicit skips ${n("skip")}, nudges ignored ${n("unresolved")}`,
    `    compactions with uncaptured work ${n("compact")}, sessions still carrying uncaptured work ${endedWithDebt}, query results awaiting draft review ${journals.reduce((count,j) => count+reviewDebt(j).length,0)}`,
  ];
}
