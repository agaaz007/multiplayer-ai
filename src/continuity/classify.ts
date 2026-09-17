import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { ledgerHome, type Config } from "../store.js";
import { runExtractorAsync } from "../extract.js";
import * as S from "./store.js";
import * as R from "./records.js";
import type { RecordKind, UpdateKind, Span, WorkRecord, StateUpdate } from "./records.js";
import { idfOver, questionSimilarity, titleSimilarity } from "../query.js";


/**
 * Classifier (spec v1.2 §13a, D-009): runs at each `turn` checkpoint. Given the
 * open work records and the events since the last classification, it asks a
 * model to assign contiguous spans to records, propose new records where no
 * candidate covers the goal, and propose state updates with exact event
 * evidence. Everything it writes is `suggested` (links) or `proposed` (state
 * updates), created_by "classifier". It never confirms anything and never
 * writes a Ledger decision or finding. Whatever it cannot place stays
 * unassigned; the records layer computes that from coverage, and the brief
 * surfaces it.
 *
 * Failure is contained: a model error or non-JSON reply returns
 * `model_ok: false` and writes nothing. The daemon logs and moves on; capture
 * and checkpoints never wait on this.
 *
 * Progress is tracked per session in ~/.ledger/classify/<session>.json so a
 * later run starts after the last seq considered.
 */

export interface ClassifyOpts {
  sinceSeq?: number;
  now?: Date;
  maxEvents?: number;
  dryRun?: boolean;
  log?: (s: string) => void;
  /** Optional execution boundary for isolated evaluations; production keeps the configured extractor. */
  extract?: (prompt: string, cfg: Config) => Promise<string>;
}

export interface ClassifyResult {
  session_id: string;
  events_considered: number;
  candidates: number;
  candidate_pool_size: number;
  candidates_omitted: number;
  assignments_applied: number;
  /** assignments whose exact suggested link already existed (idempotent re-run) */
  assignments_skipped: number;
  records_created: number;
  /** proposed new investigations that restated an open one and were linked to it instead of created */
  twins_linked: number;
  /**
   * proposed new investigations that matched nothing open and were NOT created: the classifier links analysis
   * work to an investigation a session declared or bound (bind-or-new), it never opens one from cwd. The span
   * stays unassigned with that reason.
   */
  investigations_declined: number;
  updates_proposed: number;
  /** state updates this session already proposed with the same kind and text (idempotent re-run) */
  updates_skipped: number;
  /** content events in the considered window not covered by any explicit/suggested link after apply, as contiguous spans */
  unassigned: (Span & { reason?: string })[];
  rejected: { item: unknown; reason: string }[];
  prompt_chars: number;
  model_ok: boolean;
  error?: string;
  /** gap notes: events dropped by the cap, prompt trimming, model notes */
  notes: string[];
  since_seq: number;
  through_seq: number;
  dry_run: boolean;
  /** state updates this run wrote, for the helper's follow-up (decision prompts at the next checkpoint) */
  proposed: { id: string; record_id: string; record_title: string; kind: UpdateKind; text: string; confidence: number; evidence_seqs: number[] }[];
}

export interface ClassifyProgress { last_seq: number; runs: number; last_at: string }

export const CLASSIFY_MIN_INTERVAL_MS = 120_000;
export const DEFAULT_MAX_EVENTS = 400;
export const PROMPT_CHAR_CAP = 60_000;
const CANDIDATE_CAP = 30;
const EVENT_PREVIEW = 300;
const COMPACTION_PREVIEW = 600;
const TITLE_MAX = 140;
const CREATED_BY = "classifier";

const CONTENT_KINDS = ["instruction.added", "assistant.message", "tool.requested", "file.changed", "compaction"];
const RECORD_KINDS = new Set<RecordKind>(["implementation", "investigation", "writing", "decision", "other"]);
const UPDATE_KINDS = new Set<UpdateKind>(["progress", "decision", "hypothesis", "blocker", "next", "contradiction", "note"]);

const PROMPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");
const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");

// ---------- guard: the daemon asks this before every run ----------

/**
 * Whether the daemon may classify this session now. Off when `continuity.classify` is
 * false in config or LEDGER_CLASSIFY=0 in the environment; otherwise at most one run per
 * CLASSIFY_MIN_INTERVAL_MS per session.
 */
export function classifyAllowed(cfg: Config, o: { now: number; lastClassifyAt?: number | null; env?: NodeJS.ProcessEnv; minIntervalMs?: number }): { ok: true } | { ok: false; reason: string } {
  const env = o.env ?? process.env;
  if (env.LEDGER_CLASSIFY === "0") return { ok: false, reason: "LEDGER_CLASSIFY=0" };
  if ((cfg.continuity as any)?.classify === false) return { ok: false, reason: "continuity.classify is false" };
  const min = o.minIntervalMs ?? CLASSIFY_MIN_INTERVAL_MS;
  if (o.lastClassifyAt != null && o.now - o.lastClassifyAt < min) return { ok: false, reason: `rate limited: next run in ${Math.ceil((min - (o.now - o.lastClassifyAt)) / 1000)} s` };
  return { ok: true };
}

/** Content events captured beyond this session's classifier progress: whether a quiet session still needs a run. */
export async function unclassifiedCount(pool: pg.Pool, sessionId: string): Promise<number> {
  const since = readProgress(sessionId)?.last_seq ?? 0;
  return (await pool.query<{ n: number }>(`select count(*)::int as n from cont_events where session_id = $1 and kind = any($2) and seq > $3`, [sessionId, CONTENT_KINDS, since])).rows[0].n;
}

// ---------- progress file ----------

const progressDir = () => path.join(ledgerHome(), "classify");
const progressFile = (sessionId: string) => path.join(progressDir(), `${safe(sessionId)}.json`);

export function readProgress(sessionId: string): ClassifyProgress | null {
  try {
    const p = JSON.parse(fs.readFileSync(progressFile(sessionId), "utf8"));
    if (typeof p?.last_seq !== "number") return null;
    return { last_seq: p.last_seq, runs: Number(p.runs ?? 0), last_at: String(p.last_at ?? "") };
  } catch { return null; }
}

export function writeProgress(sessionId: string, p: ClassifyProgress): void {
  fs.mkdirSync(progressDir(), { recursive: true });
  const f = progressFile(sessionId);
  fs.writeFileSync(f + ".tmp", JSON.stringify(p));
  fs.renameSync(f + ".tmp", f);
}

// ---------- prompt ----------

function readPrompt(rel: string): string {
  return fs.readFileSync(path.join(PROMPTS, rel), "utf8").trim();
}

function oneLine(s: unknown, n: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function eventLine(e: S.EventRow): string {
  const p = e.payload ?? {};
  let preview: string;
  switch (e.kind) {
    case "tool.requested": preview = oneLine(`${p.tool ?? "tool"}: ${p.input ?? ""}`, EVENT_PREVIEW); break;
    case "file.changed": preview = oneLine(`${p.status ? String(p.status) + " " : ""}${p.path ?? ""}`, EVENT_PREVIEW); break;
    case "compaction": preview = oneLine(p.text ?? "", COMPACTION_PREVIEW); break;
    default: preview = oneLine(p.text ?? "", EVENT_PREVIEW);
  }
  return `${e.seq} · ${e.kind} · ${preview}`;
}

interface Candidate { record: WorkRecord; state_summary: string; linked_here: boolean; updates: StateUpdate[] }

function summarizeState(st: R.RecordState | null): { summary: string; updates: StateUpdate[] } {
  if (!st) return { summary: "", updates: [] };
  const buckets: [string, StateUpdate[]][] = [["decision", st.decisions], ["blocker", st.blockers], ["contradiction", st.contradictions], ["next", st.next], ["progress", st.progress], ["hypothesis", st.hypotheses], ["note", st.notes]];
  const all = buckets.flatMap(([,updates]) => updates);
  const pack = (status: 'confirmed' | 'proposed', budget: number) => {
    const parts: string[] = []; let shown = 0, size = 0;
    const count = all.filter(u => u.status === status).length;
    if (!count) return '';
    // Each status has its own reserved budget. New proposals cannot evict confirmed state.
    for (const [kind, ups] of buckets) for (const u of ups.filter(u => u.status === status).slice(-2).reverse()) {
      const line = `${kind}: ${oneLine(u.text, 120)}`;
      if (size + line.length + 2 > budget) continue;
      parts.push(line); shown++; size += line.length + 2;
    }
    return `${status.toUpperCase()} (${count} current, ${count-shown} omitted from summary): ${parts.join('; ')}`;
  };
  return { summary: [pack('confirmed', 900), pack('proposed', 300)].filter(Boolean).join(' | '), updates: all };
}

function candidateLines(cands: Candidate[]): string {
  if (!cands.length) return "(none: no linked, relevant or open records in this scope)";
  return cands.map((c, i) => {
    const r = c.record;
    const touched = Array.isArray(r.touched_repos) ? r.touched_repos : [];
    const where = r.repo ?? (r.kind === "investigation" ? `none (investigation keyed by its question${touched.length ? `; repos touched: ${touched.join(", ")}` : ""})` : "none (non-code work)");
    const bits = [`[${i + 1}] ${r.id}`, `kind: ${r.kind}`, `title: ${r.title}`, `repo: ${where}`, `status: ${r.status}`];
    if (r.goal) bits.push(`goal: ${oneLine(r.goal, 300)}`);
    if (c.linked_here) bits.push(`already linked to this session`);
    bits.push(`state: ${c.state_summary || "no updates yet"}`);
    return bits.join(" · ");
  }).join("\n");
}

// ---------- anti-twin: a "new" investigation that restates an open one links to it instead ----------

/**
 * Thirteen open investigations, none bound, was not thirteen questions: it was one question restated by
 * successive sessions. The only guard was `byTitle`, which collapses a proposed new record into a candidate
 * only when the titles are byte-identical, and the candidate list is both capped and scoped to this repo —
 * so a restatement, or the same question opened while working in another repo, became a new record.
 *
 * Two measures, either sufficient, because they fail in different places. Title coverage catches a
 * reordering or a synonym-free rewrite and is blind when the goal carries the meaning; IDF cosine over
 * title and goal catches a rewording and is weak on a 13-record corpus where nothing is rare. On the
 * thirteen real open investigations the most similar *distinct* pair scores 0.43 title / 0.17 cosine, while
 * hand-written restatements of three of them score 1.00/0.40, 0.50/0.32 and 0.80/0.57.
 *
 * Linking is the safe error. A link is `suggested` and a person confirms or rejects it; a wrong create is
 * silent and permanent, and it is the one that has been growing.
 */
export const TWIN_TITLE = 0.5;
export const TWIN_QUESTION = 0.3;

const investigationText = (r: { title: string; goal?: string | null }) => `${r.title} ${r.goal ?? ""}`.trim();

/** The open investigation a proposed new one restates, or null. `idf` comes from {@link idfOver} over the same pool. */
export function twinInvestigation(
  proposed: { title: string; goal: string | null },
  open: WorkRecord[],
  idf: (t: string) => number
): { record: WorkRecord; title_similarity: number; question_similarity: number } | null {
  const scored = open.map((record) => ({
    record,
    title_similarity: titleSimilarity(proposed.title, record.title),
    question_similarity: questionSimilarity(investigationText(proposed), investigationText(record), idf),
  }));
  const hits = scored.filter((x) => x.title_similarity >= TWIN_TITLE || x.question_similarity >= TWIN_QUESTION);
  if (!hits.length) return null;
  // Rank on the pair, not on one measure: the strongest evidence of the same question wins.
  return hits.sort((a, b) =>
    Math.max(b.title_similarity, b.question_similarity) - Math.max(a.title_similarity, a.question_similarity) ||
    b.title_similarity - a.title_similarity || a.record.id.localeCompare(b.record.id))[0];
}

const QUERY_STOP_WORDS = new Set('the and this that with from into for was were are have has will then only also what when why how not but its keep use using now'.split(' '));

/** Rank against the full allowed record scope before applying the prompt cap. No recency/closed filter on relevant records. */
export async function selectClassifyCandidates(pool: pg.Pool, session: S.SessionRow, events: S.EventRow[], linked: WorkRecord[]) {
  // Balance terms across this event page, with human instructions first, so one verbose
  // recent tool invocation cannot monopolize the query. This is lexical retrieval, not authority.
  const rows = [...events.filter(e => e.kind === 'instruction.added'), ...events.filter(e => e.kind !== 'instruction.added')]
    .map(e => [...new Set(eventLine(e).toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])].filter(t => !QUERY_STOP_WORDS.has(t)));
  const allTerms = new Set(rows.flat()); const terms: string[] = [], seenTerms = new Set<string>();
  for (let i = 0; terms.length < 128 && rows.some(row => row.length > i); i++) for (const row of rows) {
    const term = row[i]; if (term && !seenTerms.has(term) && terms.length < 128) { terms.push(term); seenTerms.add(term); }
  }
  const query = terms.length ? terms.join(' | ') : '';
  const result = await pool.query<WorkRecord & { relevance: number; pool_size: number }>(`
    with scoped as (
      select r.*, ts_rank_cd(
        setweight(to_tsvector('simple',r.title),'A') || setweight(to_tsvector('simple',coalesce(r.goal,'')),'B') ||
        setweight(to_tsvector('simple',coalesce((select string_agg(u.text,' ') from cont_state_updates u
          where u.record_id=r.id and u.status='confirmed' and not exists
            (select 1 from cont_state_updates v where v.record_id=u.record_id and v.supersedes=u.id and v.status='confirmed')),'')),'C'),
        to_tsquery('simple',$3)) as relevance
      from cont_records r where r.repo=$1 or r.repo is null or r.id=any($2::uuid[])
    ), eligible as (select * from scoped where status='open' or relevance>0 or id=any($2::uuid[]))
    select *, count(*) over()::int as pool_size from eligible order by relevance desc,updated_at desc,id limit $4`,
    [session.repo, linked.map(r => r.id), query, CANDIDATE_CAP]);
  const seen = new Set<string>(), picked: {record:WorkRecord;linked_here:boolean}[] = [];
  const linkedIds = new Set(linked.map(r => r.id));
  const take = (records: WorkRecord[]) => { for (const record of records) if (!seen.has(record.id) && picked.length < CANDIDATE_CAP) {
    seen.add(record.id); picked.push({record,linked_here:linkedIds.has(record.id)});
  } };
  // Reserve at least half the budget for page relevance even during a linked-record flood.
  take(linked.slice(0, Math.floor(CANDIDATE_CAP/2))); take(result.rows); take(linked);
  const poolSize = result.rows[0]?.pool_size ?? 0;
  return { picked, poolSize, omitted: Math.max(0,poolSize-picked.length), queryTerms: terms.length, queryTermsOmitted: Math.max(0,allTerms.size-terms.length) };
}

export function composeClassifyPrompt(ctx: { session: S.SessionRow; thread: S.ThreadRow | null; candidates: Candidate[]; events: S.EventRow[]; sinceSeq: number; notes: string[]; today: string }): string {
  const s = ctx.session;
  const run = [
    `# This run`,
    `Today is ${ctx.today}. The session below belongs to "${s.author}" (${s.harness}${s.machine ? ` on ${s.machine}` : ""}). Session id: ${s.id}.`,
    `Repo: ${s.repo ?? "none"}${s.branch ? ` @ ${s.branch}` : ""}.${ctx.thread ? ` Thread: "${ctx.thread.title}"${ctx.thread.goal ? ` (goal: ${oneLine(ctx.thread.goal, 300)})` : ""}.` : ""}`,
    `Events shown are those after seq ${ctx.sinceSeq}; only instruction, assistant message, tool request, file change, and compaction events are listed, so seq numbers have gaps. Tool results are not shown; a tool request has no outcome here.`,
    ...ctx.notes.map((n) => `Note: ${n}`),
  ].join("\n");
  const first = ctx.events[0]?.seq ?? ctx.sinceSeq + 1;
  const last = ctx.events[ctx.events.length - 1]?.seq ?? ctx.sinceSeq;
  return [
    readPrompt("base/purpose.md"),
    readPrompt("base/format.md"),
    readPrompt("operations/classify.md"),
    run,
    `# Candidate records (${ctx.candidates.length})`,
    candidateLines(ctx.candidates),
    `# Events (session ${s.id}, seq ${first}..${last}, ${ctx.events.length} shown)`,
    ctx.events.map(eventLine).join("\n"),
  ].join("\n\n");
}

// ---------- model output ----------

export interface ModelAssignment { record_id: string | null; new_record: { kind: RecordKind; title: string; goal: string | null } | null; from_seq: number; to_seq: number; confidence: number; why: string }
export interface ModelUpdate { record_ref: string; kind: UpdateKind; text: string; evidence_seqs: number[]; confidence: number }
export interface ModelOutput { assignments: unknown[]; state_updates: unknown[]; unassigned: unknown[]; notes: string }

/** Tolerant JSON parse: the model may wrap in a fence or add a sentence. Throws on anything that is not the expected object. */
export function parseClassifyOutput(out: string): ModelOutput {
  const s = String(out ?? "").trim();
  const candidates = [s, s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""), s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const j = JSON.parse(c);
      if (!j || typeof j !== "object" || Array.isArray(j)) continue;
      const arr = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : null);
      const a = arr(j.assignments), u = arr(j.state_updates), n = arr(j.unassigned);
      if (!a || !u || !n) throw new Error("assignments, state_updates and unassigned must be arrays");
      return { assignments: a, state_updates: u, unassigned: n, notes: typeof j.notes === "string" ? j.notes : "" };
    } catch (e: any) {
      if (/must be arrays/.test(String(e?.message))) throw e;
      /* try the next shape */
    }
  }
  throw new Error(`classifier returned non-JSON: ${s.slice(0, 200)}`);
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isConf = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const overlaps = (a: { from_seq: number; to_seq: number }, b: { from_seq: number; to_seq: number }) => a.from_seq <= b.to_seq && b.from_seq <= a.to_seq;

// ---------- the run ----------

export async function classifySession(cfg: Config, pool: pg.Pool, sessionId: string, opts: ClassifyOpts = {}): Promise<ClassifyResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const dryRun = Boolean(opts.dryRun);
  const maxEvents = Math.max(1, opts.maxEvents ?? DEFAULT_MAX_EVENTS);
  const res: ClassifyResult = {
    session_id: sessionId, events_considered: 0, candidates: 0, candidate_pool_size: 0, candidates_omitted: 0, assignments_applied: 0, assignments_skipped: 0, records_created: 0, twins_linked: 0, investigations_declined: 0, updates_proposed: 0, updates_skipped: 0,
    unassigned: [], rejected: [], prompt_chars: 0, model_ok: false, notes: [], since_seq: 0, through_seq: 0, dry_run: dryRun, proposed: [],
  };
  const fail = (msg: string): ClassifyResult => { res.error = msg; return res; };

  // 1. session, thread, existing links, window
  const session = await S.getSession(pool, sessionId);
  if (!session) return fail(`session not found: ${sessionId}`);
  const thread = session.thread_id ? await S.getThread(pool, session.thread_id) : null;
  const links = await R.sessionLinks(pool, sessionId);
  const covering = links.filter((l) => l.source === "explicit" || l.source === "suggested");
  const maxCovered = covering.reduce((m, l) => Math.max(m, l.to_seq), 0);
  const progress = readProgress(sessionId);
  // Explicitly linking later work does not acknowledge older unprocessed events.
  const sinceSeq = opts.sinceSeq ?? progress?.last_seq ?? 0;
  res.since_seq = sinceSeq;

  const total = (await pool.query<{ n: number }>(`select count(*)::int as n from cont_events where session_id = $1 and kind = any($2) and seq > $3`, [sessionId, CONTENT_KINDS, sinceSeq])).rows[0].n;
  let events = await S.sessionEvents(pool, sessionId, { kinds: CONTENT_KINDS, afterSeq: sinceSeq, limit: maxEvents, order: 'asc' });
  if (total > events.length) res.notes.push(`${total - events.length} newer event(s) deferred to the next page by the ${maxEvents}-event cap; this page starts at seq ${events[0]?.seq}`);
  res.through_seq = events.length ? events[events.length - 1].seq : sinceSeq;
  if (!events.length) { res.model_ok = true; return res; }

  // 2. Full-scope relevance first, then bounded prompt packing; old/closed work can still matter.
  const linkedHere = await R.recordsForSession(pool, sessionId);
  const selection = await selectClassifyCandidates(pool, session, events, linkedHere);
  const {picked} = selection;
  res.candidate_pool_size = selection.poolSize; res.candidates_omitted = selection.omitted;
  res.notes.push(`Candidate retrieval searched all ages and statuses in this repo/non-code scope plus explicitly linked work; ${selection.poolSize} eligible, ${picked.length} shown, ${selection.omitted} omitted by the ${CANDIDATE_CAP}-record prompt cap. Lexical relevance is not acceptance.`);
  if (selection.queryTermsOmitted) res.notes.push(`${selection.queryTermsOmitted} query term(s) omitted by the 128-term retrieval budget; terms are balanced across the current event page.`);
  const candidates: Candidate[] = [];
  for (const p of picked) {
    const st = summarizeState(await R.recordState(pool, p.record.id));
    candidates.push({ record: p.record, state_summary: st.summary, linked_here: p.linked_here, updates: st.updates });
  }
  res.candidates = candidates.length;
  const byId = new Map(candidates.map((c) => [c.record.id, c]));
  const byTitle = new Map(candidates.map((c) => [c.record.title.trim().toLowerCase(), c]));

  // 3. Keep the earliest unprocessed page. Defer its tail instead of skipping old evidence.
  const today = now.toISOString().slice(0, 10);
  let prompt = composeClassifyPrompt({ session, thread, candidates, events, sinceSeq, notes: res.notes, today });
  if (prompt.length > PROMPT_CHAR_CAP) {
    let dropped = 0;
    while (prompt.length > PROMPT_CHAR_CAP && events.length > 1) {
      events = events.slice(0, -1);
      dropped++;
      const notes = [...res.notes, `${dropped} newest event(s) deferred to fit the prompt cap; this page ends at seq ${events[events.length - 1].seq}`];
      prompt = composeClassifyPrompt({ session, thread, candidates, events, sinceSeq, notes, today });
    }
    res.notes.push(`${dropped} newest event(s) deferred to fit the prompt cap; this page ends at seq ${events[events.length - 1].seq}`);
  }
  if (prompt.length > PROMPT_CHAR_CAP) return fail('one event and its candidate context exceed the prompt cap; progress has not advanced');
  res.through_seq = events[events.length - 1].seq;
  res.prompt_chars = prompt.length;
  res.events_considered = events.length;
  const seqs = new Set(events.map((e) => e.seq));
  const minSeq = events[0].seq;
  const maxSeq = events[events.length - 1].seq;

  // 4. model
  let out: ModelOutput;
  try {
    out = parseClassifyOutput(await (opts.extract ?? runExtractorAsync)(prompt, cfg));
  } catch (e: any) {
    return fail(`classifier failed: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  res.model_ok = true;
  if (out.notes) res.notes.push(`model: ${oneLine(out.notes, 300)}`);

  // 5. validate assignments
  type Acc = ModelAssignment & { existing: boolean };
  const accepted: Acc[] = [];
  const reject = (item: unknown, reason: string) => { res.rejected.push({ item, reason }); };
  const inRange = (o: { from_seq: number; to_seq: number }): string | null => {
    if (!isInt(o.from_seq) || !isInt(o.to_seq)) return "from_seq and to_seq must be integers";
    if (o.from_seq > o.to_seq) return `from_seq ${o.from_seq} > to_seq ${o.to_seq}`;
    if (o.from_seq < minSeq || o.to_seq > maxSeq) return `seq range ${o.from_seq}..${o.to_seq} outside the events shown (${minSeq}..${maxSeq})`;
    return null;
  };
  // Anti-twin pool: fetched once, across every repo, only when the model actually proposes a new investigation.
  const proposesInvestigation = out.assignments.some((a: any) => a?.new_record?.kind === "investigation");
  const openInv = proposesInvestigation ? await R.openInvestigations(pool) : [];
  const invIdf = idfOver(openInv.map((r) => `${r.title} ${r.goal ?? ""}`.trim()));
  // Investigations the model wanted to open and this run declined: identity is the question a session declared or
  // bound, never the folder the chat ran in. Their spans stay unassigned, split out with this reason.
  const declined: { from_seq: number; to_seq: number; reason: string }[] = [];
  const declinedTitles = new Set<string>();
  const declineReason = (title: string) => `investigation "${title}" was not opened by the classifier: an investigation is declared by a session (ledger_investigation_new) or bound (ledger_investigation_bind), never created from cwd; the span stays unassigned until a session binds it`;

  for (const raw of out.assignments) {
    const a = raw as any;
    if (!a || typeof a !== "object") { reject(raw, "assignment is not an object"); continue; }
    const rangeErr = inRange(a);
    if (rangeErr) { reject(raw, rangeErr); continue; }
    if (!isConf(a.confidence)) { reject(raw, `confidence must be a number in 0..1, got ${String(a.confidence)}`); continue; }
    const hasId = typeof a.record_id === "string" && a.record_id.trim();
    const hasNew = a.new_record && typeof a.new_record === "object";
    if (hasId && hasNew) { reject(raw, "exactly one of record_id and new_record must be set (both given)"); continue; }
    if (!hasId && !hasNew) { reject(raw, "exactly one of record_id and new_record must be set (neither given)"); continue; }
    let record_id: string | null = null;
    let new_record: ModelAssignment["new_record"] = null;
    if (hasId) {
      record_id = String(a.record_id).trim();
      if (!byId.has(record_id)) { reject(raw, `record_id ${record_id} is not among the candidates`); continue; }
    } else {
      const kind = String(a.new_record.kind ?? "");
      const title = oneLine(a.new_record.title ?? "", TITLE_MAX);
      if (!RECORD_KINDS.has(kind as RecordKind)) { reject(raw, `new_record.kind must be one of ${[...RECORD_KINDS].join(", ")}, got ${kind || "(empty)"}`); continue; }
      if (!title) { reject(raw, "new_record.title is required"); continue; }
      const goal = a.new_record.goal == null ? null : oneLine(a.new_record.goal, 500) || null;
      const dup = byTitle.get(title.toLowerCase());
      if (dup) record_id = dup.record.id; // a "new" record that already exists by title is that record
      else {
        // An investigation that restates one already open is that investigation, whatever repo it was opened in.
        const twin = kind === "investigation" ? twinInvestigation({ title, goal }, openInv, invIdf) : null;
        if (twin) {
          record_id = twin.record.id;
          res.twins_linked++;
          const why = `linked proposed investigation "${title}" to open ${twin.record.id} "${twin.record.title}" (title ${twin.title_similarity.toFixed(2)}, question ${twin.question_similarity.toFixed(2)}) instead of creating a new record; the link is suggested and a person can reject it`;
          res.notes.push(why);
          log(`classify ${sessionId.slice(0, 8)}: ${why}`);
        } else if (kind === "investigation") {
          // Never mint: a repo-stamped investigation opened because cwd was a git root is how thirteen open
          // investigations came to have zero bound sessions. The span is reported unassigned with the reason.
          const rangeOk = isInt(a.from_seq) && isInt(a.to_seq);
          if (rangeOk) declined.push({ from_seq: a.from_seq, to_seq: a.to_seq, reason: declineReason(title) });
          declinedTitles.add(title.toLowerCase());
          res.investigations_declined++;
          log(`classify ${sessionId.slice(0, 8)}: declined to open investigation "${title}" (bind-or-new owns analysis scope)`);
          reject(raw, declineReason(title));
          continue;
        } else new_record = { kind: kind as RecordKind, title, goal };
      }
    }
    const span = { from_seq: a.from_seq as number, to_seq: a.to_seq as number };
    const clash = accepted.find((x) => overlaps(x, span));
    if (clash) { reject(raw, `overlaps assignment ${clash.from_seq}..${clash.to_seq} in this output`); continue; }
    let existing = false;
    if (record_id) {
      const same = covering.find((l) => l.source === "suggested" && l.record_id === record_id && l.from_seq === span.from_seq && l.to_seq === span.to_seq);
      if (same) existing = true;
      else {
        const other = covering.find((l) => l.source === "suggested" && overlaps(l, span));
        if (other) { reject(raw, `overlaps existing suggested link ${other.from_seq}..${other.to_seq} on record ${other.record_id}`); continue; }
      }
    } else {
      const other = covering.find((l) => l.source === "suggested" && overlaps(l, span));
      if (other) { reject(raw, `overlaps existing suggested link ${other.from_seq}..${other.to_seq} on record ${other.record_id}`); continue; }
    }
    accepted.push({ record_id, new_record, from_seq: span.from_seq, to_seq: span.to_seq, confidence: a.confidence, why: oneLine(a.why ?? "", 300), existing });
  }

  // 6. validate state updates against candidates and accepted new records
  const newTitles = new Map(accepted.filter((x) => x.new_record).map((x) => [x.new_record!.title.toLowerCase(), x]));
  type AccU = ModelUpdate & { target: { record_id: string | null; new_title: string | null } };
  const acceptedUpdates: AccU[] = [];
  for (const raw of out.state_updates) {
    const u = raw as any;
    if (!u || typeof u !== "object") { reject(raw, "state update is not an object"); continue; }
    const ref = String(u.record_ref ?? "").trim();
    let target: AccU["target"] | null = null;
    if (byId.has(ref)) target = { record_id: ref, new_title: null };
    else if (byTitle.has(ref.toLowerCase())) target = { record_id: byTitle.get(ref.toLowerCase())!.record.id, new_title: null };
    else if (newTitles.has(ref.toLowerCase())) target = { record_id: null, new_title: newTitles.get(ref.toLowerCase())!.new_record!.title };
    if (!target && declinedTitles.has(ref.toLowerCase())) { reject(raw, `${declineReason(ref)}; the update has no record to land on`); continue; }
    if (!target) { reject(raw, `record_ref "${ref.slice(0, 80)}" is neither a candidate id nor the title of an accepted new_record`); continue; }
    if (!UPDATE_KINDS.has(u.kind)) { reject(raw, `kind must be one of ${[...UPDATE_KINDS].join(", ")}, got ${String(u.kind)}`); continue; }
    const text = oneLine(u.text ?? "", 1000);
    if (!text) { reject(raw, "text is required"); continue; }
    if (!Array.isArray(u.evidence_seqs) || !u.evidence_seqs.length) { reject(raw, "evidence_seqs must name at least one event seq"); continue; }
    const bad = u.evidence_seqs.find((n: unknown) => !isInt(n) || !seqs.has(n));
    if (bad !== undefined) { reject(raw, `evidence seq ${String(bad)} is not one of the events shown`); continue; }
    if (!isConf(u.confidence)) { reject(raw, `confidence must be a number in 0..1, got ${String(u.confidence)}`); continue; }
    const evidence_seqs = [...new Set<number>(u.evidence_seqs)].sort((a, b) => a - b);
    // idempotent: the same proposal from this session on a candidate is not repeated
    if (target.record_id) {
      const c = byId.get(target.record_id)!;
      if (c.updates.some((x) => x.session_id === sessionId && x.created_by === CREATED_BY && x.kind === u.kind && x.text === text)) { res.updates_skipped++; continue; }
    }
    acceptedUpdates.push({ record_ref: ref, kind: u.kind, text, evidence_seqs, confidence: u.confidence, target });
  }

  // 7. model's unassigned list is informational; validate the ranges, keep the reasons
  const modelUnassigned: { from_seq: number; to_seq: number; reason: string }[] = [];
  for (const raw of out.unassigned) {
    const x = raw as any;
    if (!x || typeof x !== "object") { reject(raw, "unassigned item is not an object"); continue; }
    const err = inRange(x);
    if (err) { reject(raw, err); continue; }
    modelUnassigned.push({ from_seq: x.from_seq, to_seq: x.to_seq, reason: oneLine(x.reason ?? "", 300) });
  }

  // 8. apply: create records, link spans, propose updates. Never confirm; never touch the Ledger.
  const created = new Map<string, WorkRecord>(); // new title (lower) → record
  if (!dryRun) {
    for (const a of accepted) {
      try {
        let record_id = a.record_id;
        if (!record_id) {
          const key = a.new_record!.title.toLowerCase();
          let rec = created.get(key);
          if (!rec) {
            rec = await R.createRecord(pool, { kind: a.new_record!.kind, title: a.new_record!.title, goal: a.new_record!.goal, repo: session.repo ?? null, created_by: CREATED_BY });
            created.set(key, rec);
            res.records_created++;
            log(`classify ${sessionId.slice(0, 8)}: new ${rec.kind} record "${rec.title}" (${rec.id.slice(0, 8)})`);
          }
          record_id = rec.id;
        }
        // The folder this session ran in is a capability of an investigation it serves (touched_repos), not its
        // identity; a no-op for other kinds, whose repo is their identity already.
        if (session.repo) await R.touchRepo(pool, record_id, session.repo);
        if (a.existing) { res.assignments_skipped++; continue; }
        await R.linkSpan(pool, { record_id, session_id: sessionId, from_seq: a.from_seq, to_seq: a.to_seq, source: "suggested", confidence: a.confidence, note: a.why || null, created_by: CREATED_BY });
        res.assignments_applied++;
      } catch (e: any) {
        reject(a, `apply failed: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
    for (const u of acceptedUpdates) {
      try {
        const record_id = u.target.record_id ?? created.get(u.target.new_title!.toLowerCase())?.id;
        if (!record_id) { reject(u, `record "${u.target.new_title}" was not created`); continue; }
        const added = await R.addStateUpdate(pool, {
          record_id, session_id: sessionId, from_seq: u.evidence_seqs[0], to_seq: u.evidence_seqs[u.evidence_seqs.length - 1],
          kind: u.kind, text: u.text, evidence: u.evidence_seqs.map((seq) => ({ session_id: sessionId, seq })), created_by: CREATED_BY, status: "proposed",
        });
        res.updates_proposed++;
        const record_title = u.target.record_id ? byId.get(u.target.record_id)?.record.title ?? "" : u.target.new_title!;
        res.proposed.push({ id: added.id, record_id, record_title, kind: u.kind, text: u.text, confidence: u.confidence, evidence_seqs: u.evidence_seqs });
      } catch (e: any) {
        reject(u, `apply failed: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
    writeProgress(sessionId, { last_seq: res.through_seq, runs: (progress?.runs ?? 0) + 1, last_at: now.toISOString() });
  } else {
    // dry run: count what would be written
    const titles = new Set<string>();
    for (const a of accepted) {
      if (a.new_record) titles.add(a.new_record.title.toLowerCase());
      if (a.existing) res.assignments_skipped++; else res.assignments_applied++;
    }
    res.records_created = titles.size;
    res.updates_proposed = acceptedUpdates.length;
  }

  // 9. unassigned: content events in the window not covered by existing links or accepted spans, grouped like records.unassignedSpans
  const cover: { from_seq: number; to_seq: number }[] = [...covering, ...accepted.filter((a) => !a.existing)];
  // a declined investigation's span is its own unassigned span, so its reason is not lost inside a neighbour
  const edges = new Set<number>();
  for (const d of declined) { edges.add(d.from_seq); edges.add(d.to_seq + 1); }
  let cur: (Span & { reason?: string }) | null = null;
  for (const e of events) {
    if (cover.some((l) => e.seq >= l.from_seq && e.seq <= l.to_seq)) continue;
    const split = !cur || edges.has(e.seq) || cover.some((l) => l.from_seq > cur!.to_seq && l.to_seq < e.seq);
    if (split) { cur = { session_id: sessionId, from_seq: e.seq, to_seq: e.seq }; res.unassigned.push(cur); }
    cur!.to_seq = e.seq;
  }
  for (const u of res.unassigned) {
    const d = declined.find((x) => overlaps(x, u));
    if (d) { u.reason = d.reason; continue; }
    const m = modelUnassigned.find((x) => overlaps(x, u));
    if (m?.reason) u.reason = m.reason;
  }
  return res;
}
