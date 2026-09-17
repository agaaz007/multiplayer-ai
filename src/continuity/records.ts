import type pg from "pg";
import type { EventRow } from "./store.js";
import { resolveSessionId } from "./evidence.js";

/**
 * Work records: the logical unit of work, separate from threads (the physical
 * session + worktree unit that owns claims and snapshots).
 *
 * Requirement (spec v1.2): a session can contribute evidence and state updates
 * to multiple work records; each record maintains its own progress and
 * dependencies, independent of any session's rolling summary.
 *
 * Three layers:
 *   shared evidence   cont_events / cont_artifacts / snapshots (already exist)
 *   work records      cont_records + cont_record_links (spans) + cont_state_updates (append-only, provenance)
 *   active context    assembled at ledger_resume(record) from the two above, within a budget
 *
 * Rules:
 *   - links carry `source`: explicit (agent/user named the record), suggested (classifier), unassigned (nobody)
 *   - state updates are `proposed` until a person or their agent confirms; a record's current state is a
 *     projection over updates, with proposed items visibly flagged
 *   - contradictions are kept side by side, never resolved by timestamp
 *   - saving is not accepting: a record never promotes a hypothesis to a Ledger decision or finding
 *
 * This file is the CONTRACT. Signatures and types here are fixed; implementers fill the bodies.
 * Consumers (classifier, retrieval, tools) code against these signatures.
 */

export type RecordKind = "implementation" | "investigation" | "writing" | "decision" | "other";
export type RecordStatus = "open" | "done" | "archived";
export type LinkSource = "explicit" | "suggested" | "unassigned";
export type UpdateStatus = "proposed" | "confirmed" | "rejected";
export type UpdateKind = "progress" | "decision" | "hypothesis" | "blocker" | "next" | "contradiction" | "note";

export interface WorkRecord {
  id: string;
  kind: RecordKind;
  title: string;
  goal: string | null;
  repo: string | null;              // canonical repo identity, or null for non-code work (hiring, copy)
  status: RecordStatus;
  created_by: string;
  ledger_refs: { id: string; version?: string }[];   // decisions/findings/definitions this record depends on
  state_version: number;            // bumps on every confirmed update
  created_at: Date;
  updated_at: Date;
}

export interface RecordLink {
  id: string;
  record_id: string;
  session_id: string;
  from_seq: number;
  to_seq: number;                   // inclusive
  source: LinkSource;
  confidence: number | null;        // 0..1 for suggested; null for explicit
  note: string | null;
  created_by: string;               // author or "classifier"
  created_at: Date;
}

export interface StateUpdate {
  id: string;
  record_id: string;
  session_id: string | null;
  from_seq: number | null;
  to_seq: number | null;
  status: UpdateStatus;
  kind: UpdateKind;
  text: string;
  evidence: { session_id: string; seq: number }[];   // exact events this update rests on
  created_by: string;
  created_at: Date;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  supersedes: string | null;        // an earlier update this one replaces (kept, marked)
  // rejection provenance, mirrors confirmation (additive; rows carry them, added to the type after implementation)
  reject_reason?: string | null;
  rejected_by?: string | null;
  rejected_at?: Date | null;
  // acceptance provenance (2026-09-13): the sessions that proposed and confirmed it, and how it was confirmed
  proposed_session_id?: string | null;
  confirmed_session_id?: string | null;
  /** mcp: an agent through the MCP tool; cli: the CLI without an interactive prompt; cli-interactive: a person typed yes at the CLI prompt; null: not recorded (rows before 2026-09-13) */
  confirmed_via?: ConfirmChannel | null;
}

export type ConfirmChannel = "mcp" | "cli" | "cli-interactive";

export interface RecordState {
  record: WorkRecord;
  progress: StateUpdate[];
  decisions: StateUpdate[];
  hypotheses: StateUpdate[];
  blockers: StateUpdate[];
  next: StateUpdate[];
  contradictions: StateUpdate[];
  notes: StateUpdate[];
  proposed_count: number;
  confirmed_count: number;
  last_update_at: Date | null;
  conflicts: { supersedes: string; update_ids: string[] }[];
  contributing_sessions: { session_id: string; author: string; harness: string; last_seen_at: Date | null; spans: number }[];
}

export interface Span { session_id: string; from_seq: number; to_seq: number }

export interface UnassignedSpan extends Span {
  author: string;
  harness: string;
  event_count: number;
  first_at: Date | null;
  last_at: Date | null;
  preview: string;                  // first instruction or assistant text in the span, clipped
}

type Q = pg.Pool | pg.PoolClient;

// ---------- private: vocabularies, validation, helpers ----------

const RECORD_KINDS = new Set<RecordKind>(["implementation", "investigation", "writing", "decision", "other"]);
const RECORD_STATUSES = new Set<RecordStatus>(["open", "done", "archived"]);
const LINK_SOURCES = new Set<LinkSource>(["explicit", "suggested", "unassigned"]);
const UPDATE_STATUSES = new Set<UpdateStatus>(["proposed", "confirmed", "rejected"]);
const UPDATE_KINDS = new Set<UpdateKind>(["progress", "decision", "hypothesis", "blocker", "next", "contradiction", "note"]);

/** Event kinds that carry human or agent content. Only these count for assignment, previews, and evidence grouping. */
const CONTENT_KINDS = ["instruction.added", "assistant.message", "tool.requested", "file.changed", "compaction"];

/** Link sources that count as coverage. `unassigned` is a marker, never coverage. */
const COVERING_SOURCES: LinkSource[] = ["explicit", "suggested"];

const TITLE_MAX = 200;
const PREVIEW_MAX = 160;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Must stay structurally identical to the expression in `cont_events_fts_idx` (db.ts) so the planner
 * can match the GIN index; only the table alias differs.
 */
const fts = (alias: string) =>
  `to_tsvector('english', coalesce(${alias}.payload->>'text','') || ' ' || coalesce(${alias}.payload->>'input','') || ' ' || coalesce(${alias}.payload->>'output_preview',''))`;

/** explicit beats suggested beats unassigned when one event sits in overlapping spans. */
const SOURCE_RANK = `(case l.source when 'explicit' then 0 when 'suggested' then 1 else 2 end)`;

function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

function assertOneOf<T extends string>(set: Set<T>, v: unknown, what: string): asserts v is T {
  if (typeof v !== "string" || !set.has(v as T)) throw new Error(`invalid ${what}: ${String(v)} (expected one of ${[...set].join(", ")})`);
}

function assertSeq(v: unknown, what: string): asserts v is number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`invalid ${what}: ${String(v)} (expected a non-negative integer)`);
}

function assertSpan(from: number, to: number): void {
  if (from > to) throw new Error(`invalid span: from_seq ${from} > to_seq ${to}`);
}

function requireText(v: unknown, what: string, max?: number): string {
  const t = String(v ?? "").trim();
  if (!t) throw new Error(`${what} is required`);
  return max ? t.slice(0, max) : t;
}

function hours(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid sinceHours: ${String(v)}`);
  return n;
}

function lim(v: unknown, def: number, max: number): number {
  const n = Number(v ?? def);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.floor(n), max);
}

/** Escape LIKE metacharacters so a user's `q` matches literally (Postgres default escape is backslash). */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function normalizeEvidence(ev: unknown): { session_id: string; seq: number }[] {
  if (ev == null) return [];
  if (!Array.isArray(ev)) throw new Error("evidence must be an array of { session_id, seq }");
  return ev.map((e, i) => {
    const sid = (e as any)?.session_id;
    const seq = (e as any)?.seq;
    if (typeof sid !== "string" || !sid) throw new Error(`evidence[${i}].session_id is required`);
    assertSeq(seq, `evidence[${i}].seq`);
    return { session_id: sid, seq };
  });
}

async function requireRecord(q: Q, id: string): Promise<WorkRecord> {
  const rec = await getRecord(q, id);
  if (!rec) throw new Error(`record not found: ${id}`);
  return rec;
}

// ---------- records ----------

/**
 * Every open investigation, any repo. The classifier's anti-twin lookup needs this rather than its own
 * candidate list: candidates are capped and scoped to `repo = $1 or repo is null`, so the same analytical
 * question opened while working in another repo is invisible and becomes a new record instead of a link.
 */
export async function openInvestigations(q: Q): Promise<WorkRecord[]> {
  return (await q.query<WorkRecord>(
    `select * from cont_records where kind = 'investigation' and status = 'open' order by updated_at desc limit 500`
  )).rows;
}

export async function createRecord(q: Q, r: { kind: RecordKind; title: string; goal?: string | null; repo?: string | null; created_by: string; ledger_refs?: { id: string; version?: string }[] }): Promise<WorkRecord> {
  assertOneOf(RECORD_KINDS, r.kind, "record kind");
  const title = requireText(r.title, "record title", TITLE_MAX);
  const createdBy = requireText(r.created_by, "created_by");
  const refs = r.ledger_refs ?? [];
  if (!Array.isArray(refs) || refs.some((x) => !x || typeof x.id !== "string" || !x.id)) throw new Error("ledger_refs must be an array of { id, version? }");
  const res = await q.query<WorkRecord>(
    `insert into cont_records (kind, title, goal, repo, created_by, ledger_refs) values ($1,$2,$3,$4,$5,$6::jsonb) returning *`,
    [r.kind, title, r.goal ?? null, r.repo ?? null, createdBy, JSON.stringify(refs)]
  );
  return res.rows[0];
}

export async function getRecord(q: Q, id: string): Promise<WorkRecord | null> {
  if (!isUuid(id)) return null;
  const r = await q.query<WorkRecord>(`select * from cont_records where id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function listRecords(q: Q, f: { repo?: string | null; kind?: RecordKind; status?: RecordStatus; author?: string; sinceHours?: number; q?: string; limit?: number } = {}): Promise<WorkRecord[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  // repo: undefined = any; null = records with no repo (non-code work); string = that repo
  if (f.repo === null) where.push(`r.repo is null`);
  else if (f.repo) { params.push(f.repo); where.push(`r.repo = $${params.length}`); }
  if (f.kind) { assertOneOf(RECORD_KINDS, f.kind, "record kind"); params.push(f.kind); where.push(`r.kind = $${params.length}`); }
  if (f.status) { assertOneOf(RECORD_STATUSES, f.status, "record status"); params.push(f.status); where.push(`r.status = $${params.length}`); }
  if (f.author) { params.push(f.author); where.push(`r.created_by = $${params.length}`); }
  if (f.sinceHours != null) { params.push(hours(f.sinceHours)); where.push(`r.updated_at > now() - ($${params.length}::float8 * interval '1 hour')`); }
  const needle = f.q?.trim();
  if (needle) { params.push(`%${likeEscape(needle)}%`); where.push(`(r.title ilike $${params.length} or r.goal ilike $${params.length})`); }
  const limit = lim(f.limit, 20, 100);
  const r = await q.query<WorkRecord>(
    `select r.* from cont_records r ${where.length ? "where " + where.join(" and ") : ""} order by r.updated_at desc, r.id limit ${limit}`,
    params
  );
  return r.rows;
}

export async function updateRecordMeta(q: Q, id: string, patch: { title?: string; goal?: string | null; status?: RecordStatus; kind?: RecordKind; ledger_refs?: { id: string; version?: string }[] }): Promise<void> {
  const params: unknown[] = [id];
  const sets: string[] = [];
  if (patch.title !== undefined) { params.push(requireText(patch.title, "record title", TITLE_MAX)); sets.push(`title = $${params.length}`); }
  if (patch.goal !== undefined) { params.push(patch.goal ?? null); sets.push(`goal = $${params.length}`); }
  if (patch.status !== undefined) { assertOneOf(RECORD_STATUSES, patch.status, "record status"); params.push(patch.status); sets.push(`status = $${params.length}`); }
  if (patch.kind !== undefined) { assertOneOf(RECORD_KINDS, patch.kind, "record kind"); params.push(patch.kind); sets.push(`kind = $${params.length}`); }
  if (patch.ledger_refs !== undefined) {
    if (!Array.isArray(patch.ledger_refs) || patch.ledger_refs.some((x) => !x || typeof x.id !== "string" || !x.id)) throw new Error("ledger_refs must be an array of { id, version? }");
    params.push(JSON.stringify(patch.ledger_refs)); sets.push(`ledger_refs = $${params.length}::jsonb`);
  }
  if (!sets.length) return;
  if (!isUuid(id)) throw new Error(`record not found: ${id}`);
  const r = await q.query(`update cont_records set ${sets.join(", ")}, updated_at = now() where id = $1`, params);
  if (!r.rowCount) throw new Error(`record not found: ${id}`);
}

// ---------- links (spans of a session's events that contribute to a record) ----------

/**
 * Resolve a session id that may be the shortened form every surface renders,
 * keeping the historical "session not found" wording for genuinely unknown
 * ids so existing callers and their error handling are unaffected.
 */
async function requireSession(q: Q, given: string): Promise<string> {
  try {
    return (await resolveSessionId(q, given)).id;
  } catch (e: any) {
    if (/^ambiguous session id/.test(String(e?.message))) throw e;
    throw new Error(`session not found: ${given}`);
  }
}

export async function linkSpan(q: Q, l: { record_id: string; session_id: string; from_seq: number; to_seq: number; source: LinkSource; confidence?: number | null; note?: string | null; created_by: string }): Promise<RecordLink> {
  assertOneOf(LINK_SOURCES, l.source, "link source");
  assertSeq(l.from_seq, "from_seq");
  assertSeq(l.to_seq, "to_seq");
  assertSpan(l.from_seq, l.to_seq);
  const confidence = l.confidence ?? null;
  if (confidence != null && (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1))) throw new Error(`invalid confidence: ${String(l.confidence)} (expected 0..1)`);
  const createdBy = requireText(l.created_by, "created_by");
  const sessionId = requireText(l.session_id, "session_id");
  await requireRecord(q, l.record_id);
  const resolvedSessionId = await requireSession(q, sessionId);
  // Overlapping links from different sources are allowed on purpose: an explicit link can sit over a suggested one.
  // The record's updated_at moves in the same statement so listRecords reflects new evidence.
  const r = await q.query<RecordLink>(
    `with l as (
       insert into cont_record_links (record_id, session_id, from_seq, to_seq, source, confidence, note, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *
     ), r as (update cont_records set updated_at = now() where id = $1)
     select * from l`,
    [l.record_id, resolvedSessionId, l.from_seq, l.to_seq, l.source, confidence, l.note ?? null, createdBy]
  );
  return r.rows[0];
}

export async function unlinkSpan(q: Q, link_id: string): Promise<boolean> {
  if (!isUuid(link_id)) return false;
  const r = await q.query(`delete from cont_record_links where id = $1`, [link_id]);
  return (r.rowCount ?? 0) > 0;
}

export async function recordLinks(q: Q, record_id: string): Promise<RecordLink[]> {
  if (!isUuid(record_id)) return [];
  const r = await q.query<RecordLink>(`select * from cont_record_links where record_id = $1 order by session_id, from_seq, to_seq, created_at, id`, [record_id]);
  return r.rows;
}

export async function sessionLinks(q: Q, session_id: string): Promise<RecordLink[]> {
  const r = await q.query<RecordLink>(`select * from cont_record_links where session_id = $1 order by from_seq, to_seq, created_at, id`, [session_id]);
  return r.rows;
}

/** Events of a session not covered by any explicit or suggested link, grouped into contiguous spans. */
export async function unassignedSpans(q: Q, f: { session_id?: string; sinceHours?: number; author?: string; limit?: number } = {}): Promise<UnassignedSpan[]> {
  const params: unknown[] = [CONTENT_KINDS];
  const where: string[] = [`e.kind = any($1)`];
  // a rendered session id is always an 8-char prefix; resolve it or fail loudly
  if (f.session_id) { params.push((await resolveSessionId(q, f.session_id)).id); where.push(`e.session_id = $${params.length}`); }
  if (f.author) { params.push(f.author); where.push(`s.author = $${params.length}`); }
  if (f.sinceHours != null) { params.push(hours(f.sinceHours)); where.push(`coalesce(e.occurred_at, e.received_at) > now() - ($${params.length}::float8 * interval '1 hour')`); }
  type Ev = { session_id: string; seq: number; kind: string; at: Date; author: string; harness: string; text: string | null; input: string | null; path: string | null; tool: string | null };
  const ev = await q.query<Ev>(
    `select e.session_id, e.seq, e.kind, coalesce(e.occurred_at, e.received_at) as at, s.author, s.harness,
            e.payload->>'text' as text, e.payload->>'input' as input, e.payload->>'path' as path, e.payload->>'tool' as tool
       from cont_events e
       join cont_sessions s on s.id = e.session_id
      where ${where.join(" and ")}
      order by e.session_id, e.seq`,
    params
  );
  if (!ev.rows.length) return [];

  const sessionIds = [...new Set(ev.rows.map((r) => r.session_id))];
  const links = await q.query<{ session_id: string; from_seq: number; to_seq: number }>(
    `select session_id, from_seq, to_seq from cont_record_links where session_id = any($1) and source = any($2) order by session_id, from_seq, to_seq`,
    [sessionIds, COVERING_SOURCES]
  );
  const cover = new Map<string, { from_seq: number; to_seq: number }[]>();
  for (const l of links.rows) {
    const arr = cover.get(l.session_id) ?? [];
    arr.push({ from_seq: l.from_seq, to_seq: l.to_seq });
    cover.set(l.session_id, arr);
  }

  // Walk each session's content events in seq order. Two consecutive uncovered events belong to the same
  // span unless a covering link lies strictly between them (it cannot touch either, since both are uncovered).
  type Acc = UnassignedSpan & { fallback: string };
  const spans: Acc[] = [];
  const lastAt = new Map<string, number>();
  let cur: Acc | null = null;
  for (const e of ev.rows) {
    const at = e.at ? new Date(e.at) : null;
    if (at) lastAt.set(e.session_id, Math.max(lastAt.get(e.session_id) ?? 0, at.getTime()));
    const ls = cover.get(e.session_id) ?? [];
    if (ls.some((l) => e.seq >= l.from_seq && e.seq <= l.to_seq)) continue; // covered
    const split = !cur || cur.session_id !== e.session_id || ls.some((l) => l.from_seq > cur!.to_seq && l.to_seq < e.seq);
    if (split) {
      cur = { session_id: e.session_id, from_seq: e.seq, to_seq: e.seq, author: e.author, harness: e.harness, event_count: 0, first_at: at, last_at: at, preview: "", fallback: "" };
      spans.push(cur);
    }
    cur!.to_seq = e.seq;
    cur!.event_count++;
    cur!.last_at = at;
    if (!cur!.preview && (e.kind === "instruction.added" || e.kind === "assistant.message") && e.text) cur!.preview = clip(e.text, PREVIEW_MAX);
    if (!cur!.fallback) {
      const alt = e.text || (e.tool && e.input ? `${e.tool}: ${e.input}` : e.input) || e.path || "";
      if (alt) cur!.fallback = clip(alt, PREVIEW_MAX);
    }
  }

  // Most recently active session first; within a session, reading order.
  spans.sort((a, b) => {
    if (a.session_id !== b.session_id) return (lastAt.get(b.session_id) ?? 0) - (lastAt.get(a.session_id) ?? 0) || a.session_id.localeCompare(b.session_id);
    return a.from_seq - b.from_seq;
  });
  return spans.slice(0, lim(f.limit, 50, 500)).map(({ fallback, ...s }) => ({ ...s, preview: s.preview || fallback }));
}

// ---------- state updates (append-only, provenance, proposed → confirmed) ----------

export async function addStateUpdate(q: Q, u: { record_id: string; session_id?: string | null; from_seq?: number | null; to_seq?: number | null; kind: UpdateKind; text: string; evidence?: { session_id: string; seq: number }[]; created_by: string; status?: UpdateStatus; supersedes?: string | null; proposed_session_id?: string | null; confirmed_via?: ConfirmChannel | null }): Promise<StateUpdate> {
  assertOneOf(UPDATE_KINDS, u.kind, "update kind");
  const status = u.status ?? "proposed";
  assertOneOf(UPDATE_STATUSES, status, "update status");
  const text = requireText(u.text, "update text");
  const createdBy = requireText(u.created_by, "created_by");
  const from = u.from_seq ?? null;
  const to = u.to_seq ?? null;
  if (from != null) assertSeq(from, "from_seq");
  if (to != null) assertSeq(to, "to_seq");
  if ((from == null) !== (to == null)) throw new Error("from_seq and to_seq must be given together");
  if (from != null && to != null) assertSpan(from, to);
  // Evidence is exactly what the caller names. A span without evidence stays without evidence; nothing is fabricated.
  const evidence = normalizeEvidence(u.evidence);
  const sessionId = u.session_id ?? null;
  if (from != null && !sessionId) throw new Error("session_id is required when from_seq/to_seq are given");
  await requireRecord(q, u.record_id);
  const resolvedSessionId = sessionId ? await requireSession(q, sessionId) : sessionId;
  for (const ref of evidence) {
    // the caller's id may be the shortened form the brief and record packs print
    try {
      ref.session_id = await requireSession(q, ref.session_id);
    } catch {
      throw new Error(`evidence event not found: ${ref.session_id}:${ref.seq}`);
    }
    const exists = await q.query(`select 1 from cont_events where session_id = $1 and seq = $2`, [ref.session_id, ref.seq]);
    if (!exists.rows.length) throw new Error(`evidence event not found: ${ref.session_id}:${ref.seq}`);
  }
  const supersedes = u.supersedes ?? null;
  if (supersedes) {
    if (!isUuid(supersedes)) throw new Error(`superseded update not found: ${supersedes}`);
    const prev = await q.query<{ record_id: string }>(`select record_id from cont_state_updates where id = $1`, [supersedes]);
    if (!prev.rows[0]) throw new Error(`superseded update not found: ${supersedes}`);
    if (prev.rows[0].record_id !== u.record_id) throw new Error(`superseded update ${supersedes} belongs to a different record`);
  }
  const confirmed = status === "confirmed";
  // One statement: the insert and the record's version/activity bump cannot be observed apart.
  const r = await q.query<StateUpdate>(
    `with u as (
       insert into cont_state_updates (record_id, session_id, from_seq, to_seq, status, kind, text, evidence, created_by, supersedes, confirmed_by, confirmed_at, proposed_session_id, confirmed_session_id, confirmed_via)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11, case when $11::text is null then null else now() end, $13, case when $11::text is null then null else $13 end, $14)
       returning *
     ), r as (
       update cont_records set state_version = state_version + $12::int, updated_at = now() where id = $1
     )
     select * from u`,
    [u.record_id, resolvedSessionId, from, to, status, u.kind, text, JSON.stringify(evidence), createdBy, supersedes, confirmed ? createdBy : null, confirmed ? 1 : 0, u.proposed_session_id ?? null, confirmed ? (u.confirmed_via ?? null) : null]
  );
  return r.rows[0];
}

export async function getStateUpdate(q: Q, id: string): Promise<StateUpdate | null> {
  if (!isUuid(id)) return null;
  return (await q.query<StateUpdate>(`select * from cont_state_updates where id = $1`, [id])).rows[0] ?? null;
}

/**
 * proposed → confirmed. `via` records how: an agent through MCP, the CLI without a prompt, or a person at the
 * interactive CLI prompt; packs only say a person accepted an update confirmed via cli-interactive. Confirming an
 * already-confirmed update is idempotent, except that a person's interactive acceptance upgrades an agent's
 * confirmation (or one whose channel was never recorded) and takes over its confirmed_by.
 */
export async function confirmStateUpdate(q: Q, id: string, by: string, opts: { via?: ConfirmChannel | null; session_id?: string | null } = {}): Promise<StateUpdate | null> {
  if (!isUuid(id)) return null;
  const who = requireText(by, "confirmed_by");
  const via = opts.via ?? null;
  // proposed → confirmed and the record's state_version bump happen in one statement.
  const r = await q.query<StateUpdate>(
    `with u as (
       update cont_state_updates set status = 'confirmed', confirmed_by = $2, confirmed_at = now(), confirmed_via = $3, confirmed_session_id = $4
        where id = $1 and (status = 'proposed' or (status = 'confirmed' and $3::text = 'cli-interactive' and coalesce(confirmed_via, '') <> 'cli-interactive'))
        returning *
     ), r as (
       update cont_records set state_version = state_version + 1, updated_at = now() where id in (select record_id from u)
     )
     select * from u`,
    [id, who, via, opts.session_id ?? null]
  );
  if (r.rows[0]) return r.rows[0];
  const cur = await q.query<StateUpdate>(`select * from cont_state_updates where id = $1`, [id]);
  const row = cur.rows[0];
  if (!row) return null;
  if (row.status === "confirmed") return row; // idempotent
  throw new Error(`state update ${id} is ${row.status}; record a new update instead of confirming it`);
}

export async function rejectStateUpdate(q: Q, id: string, by: string, reason: string): Promise<StateUpdate | null> {
  if (!isUuid(id)) return null;
  const who = requireText(by, "rejected_by");
  const why = requireText(reason, "reject reason");
  // Rejection does not bump state_version: nothing about the record's accepted state changed.
  const r = await q.query<StateUpdate>(
    `update cont_state_updates set status = 'rejected', reject_reason = $3, rejected_by = $2, rejected_at = now()
      where id = $1 and status = 'proposed' returning *`,
    [id, who, why]
  );
  if (r.rows[0]) return r.rows[0];
  const cur = await q.query<StateUpdate>(`select * from cont_state_updates where id = $1`, [id]);
  const row = cur.rows[0];
  if (!row) return null;
  if (row.status === "rejected") return row; // idempotent
  throw new Error(`state update ${id} is ${row.status}; supersede it with a new update instead of rejecting it`);
}

/** The record's current state: a projection over updates. Rejected excluded; superseded excluded; proposed included and flagged. */
export async function recordState(q: Q, record_id: string): Promise<RecordState | null> {
  const record = await getRecord(q, record_id);
  if (!record) return null;
  const ups = await q.query<StateUpdate>(
    `select u.* from cont_state_updates u
      where u.record_id = $1 and u.status <> 'rejected'
        and not exists (select 1 from cont_state_updates v where v.record_id = u.record_id and v.supersedes = u.id and v.status = 'confirmed')
      order by u.created_at, u.id`,
    [record_id]
  );
  const state: RecordState = {
    record, progress: [], decisions: [], hypotheses: [], blockers: [], next: [], contradictions: [], notes: [],
    proposed_count: 0, confirmed_count: 0, last_update_at: null, conflicts: [], contributing_sessions: [],
  };
  const bucket: Record<UpdateKind, StateUpdate[]> = {
    progress: state.progress, decision: state.decisions, hypothesis: state.hypotheses, blocker: state.blockers,
    next: state.next, contradiction: state.contradictions, note: state.notes,
  };
  let last = 0;
  for (const u of ups.rows) {
    (bucket[u.kind] ?? state.notes).push(u);
    if (u.status === "proposed") state.proposed_count++;
    else if (u.status === "confirmed") state.confirmed_count++;
    const t = Math.max(new Date(u.created_at).getTime(), u.confirmed_at ? new Date(u.confirmed_at).getTime() : 0);
    if (t > last) last = t;
  }
  state.last_update_at = last ? new Date(last) : null;
  const cs = await q.query<{ session_id: string; author: string; harness: string; last_seen_at: Date | null; spans: number }>(
    `select l.session_id, s.author, s.harness, s.last_seen_at, count(*)::int as spans
       from cont_record_links l join cont_sessions s on s.id = l.session_id
      where l.record_id = $1
      group by l.session_id, s.author, s.harness, s.last_seen_at
      order by s.last_seen_at desc nulls last, l.session_id`,
    [record_id]
  );
  state.contributing_sessions = cs.rows;
  const lineage = await q.query<{id:string;supersedes:string|null}>(`select id, supersedes from cont_state_updates where record_id=$1`,[record_id]);
  const parents = new Map(lineage.rows.map(u=>[u.id,u.supersedes]));
  const replacements = new Map<string, string[]>();
  for (const u of ups.rows) if (u.status === 'confirmed' && u.supersedes) {
    let root = u.supersedes;
    const seen = new Set<string>();
    while (parents.get(root) && !seen.has(root)) {seen.add(root);root=parents.get(root)!;}
    replacements.set(root, [...(replacements.get(root) ?? []), u.id]);
  }
  state.conflicts = [...replacements].filter(([, ids]) => ids.length > 1).map(([supersedes, update_ids]) => ({ supersedes, update_ids }));
  return state;
}

// ---------- evidence retrieval across sessions ----------

/** Events across every linked span of a record, ordered by occurred_at, each annotated with session author/harness. */
export async function recordEvidence(q: Q, record_id: string, f: { kinds?: string[]; limit?: number; after?: Date | null; sources?: LinkSource[]; order?: 'asc' | 'desc'; errorsOnly?: boolean } = {}): Promise<(EventRow & { author: string; harness: string; link_source: LinkSource })[]> {
  if (!isUuid(record_id)) return [];
  const params: unknown[] = [record_id];
  const where: string[] = [`l.record_id = $1`];
  if (f.sources?.length) { for (const s of f.sources) assertOneOf(LINK_SOURCES, s, "link source"); params.push(f.sources); where.push(`l.source = any($${params.length})`); }
  if (f.kinds?.length) { params.push(f.kinds); where.push(`e.kind = any($${params.length})`); }
  if (f.after) { params.push(f.after); where.push(`coalesce(e.occurred_at, e.received_at) > $${params.length}`); }
  if (f.errorsOnly) where.push(`(e.payload->>'is_error' = 'true' or coalesce(e.payload->>'stderr_preview','') <> '')`);
  const limit = lim(f.limit, 200, 2000);
  // distinct on (e.id) keeps one row per event when spans overlap; the strongest link source wins.
  const r = await q.query<EventRow & { author: string; harness: string; link_source: LinkSource }>(
    `select x.* from (
       select distinct on (e.id) e.*, s.author, s.harness, l.source as link_source
         from cont_record_links l
         join cont_events e on e.session_id = l.session_id and e.seq between l.from_seq and l.to_seq
         join cont_sessions s on s.id = e.session_id
        where ${where.join(" and ")}
        order by e.id, ${SOURCE_RANK}, l.created_at
     ) x
     order by coalesce(x.occurred_at, x.received_at) ${f.order === 'desc' ? 'desc' : 'asc'}, x.session_id ${f.order === 'desc' ? 'desc' : 'asc'}, x.seq ${f.order === 'desc' ? 'desc' : 'asc'}
     limit ${limit}`,
    params
  );
  return r.rows;
}

/** Count the entire linked history independently of a displayed head/tail window. */
export async function recordEvidenceCount(q: Q, record_id: string, kinds: string[], sources: LinkSource[]): Promise<number> {
  if (!isUuid(record_id)) return 0;
  const r = await q.query<{ n: number }>(`select count(*)::int as n from cont_events e
    where e.kind = any($2) and exists (select 1 from cont_record_links l
      where l.record_id = $1 and l.session_id = e.session_id
      and e.seq between l.from_seq and l.to_seq and l.source = any($3))`, [record_id, kinds, sources]);
  return r.rows[0]?.n ?? 0;
}

// ---------- evidence search: lexical (+ optional vector) candidates, ranked by authority → recency → similarity ----------

/**
 * Authority tier of an evidence hit, the first sort key of `searchEvidence`.
 *   3 = cited as evidence by a CONFIRMED state update, or the tool.finished of a successful ledger_record_* call
 *   2 = cited by a PROPOSED update (and by no confirmed one)
 *   1 = plain event: nobody cites it
 *   0 = cited only by superseded or rejected updates
 */
export type EvidenceTier = 3 | 2 | 1 | 0;

/** `current` (tier 3) · `PROPOSED` (tier 2) · `uncited` (tier 1) · `superseded by <update id>` · `rejected` (tier 0). */
export type EvidenceLabel = "current" | "PROPOSED" | "uncited" | `superseded by ${string}` | "rejected";

export interface EvidenceCitation {
  update_id: string;
  record_id: string;
  /** status as of the search instant: an update confirmed after asOf counts as proposed */
  status: UpdateStatus;
  /** the confirmed update that replaced this one as of the search instant, if any */
  superseded_by: string | null;
}

export type EvidenceHit = EventRow & {
  author: string;
  harness: string;
  /** Postgres ts_rank of the lexical match; 0 when the event came from the vector list only */
  rank: number;
  /** reciprocal-rank-fusion score over the lexical and vector candidate lists; the third sort key */
  similarity: number;
  sources: ("lexical" | "vector")[];
  tier: EvidenceTier;
  label: EvidenceLabel;
  citations: EvidenceCitation[];
  /** the tool.finished of a successful ledger_record_finding/decision/definition/change call */
  ledger_write: boolean;
};

export type CandidateFn = (query: string, filters: { repo?: string | null; record_id?: string; session_id?: string; kinds?: string[]; sinceHours?: number; asOf?: string }, k: number) => Promise<{ event_id: number | string; score: number }[]>;

export interface EvidenceSearchFilters {
  repo?: string | null;
  session_id?: string;
  record_id?: string;
  kinds?: string[];
  sinceHours?: number;
  limit?: number;
  /** only events at or before this instant; update statuses are evaluated as of it too */
  asOf?: string | Date | null;
  /** session author */
  author?: string;
  /** vector candidate generator; default imports ./embeddings.js; null disables the vector list */
  candidates?: CandidateFn | null;
  /** passed through to the default candidate generator */
  cfg?: unknown;
}

export interface EvidenceSearchResult {
  hits: EvidenceHit[];
  /** what produced the candidates; the scope line prints it verbatim */
  retrieval: "lexical + vector" | "lexical only";
  /** why the vector list was not used, when it was not */
  retrieval_note: string | null;
  as_of: string | null;
}

/** RRF constant; the usual 60 keeps a rank-1 lexical hit and a rank-1 vector hit interchangeable. */
const RRF_K = 60;
/** Each candidate list is this many times the requested limit deep before fusion. */
const CANDIDATE_FACTOR = 3;
const LEDGER_WRITE_TOOL = /ledger_record_(finding|decision|definition|change)$/;

function asOfDate(v: string | Date | null | undefined): Date | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid asOf: ${String(v)} (expected an ISO instant)`);
  return d;
}

/**
 * Default vector candidates: `vectorCandidates` from ./embeddings.js, imported lazily so a missing or
 * misconfigured module degrades to lexical retrieval instead of failing the search.
 */
async function defaultCandidates(q: Q, cfg: unknown): Promise<{ fn: CandidateFn | null; note: string | null }> {
  const spec = "./embeddings.js";
  try {
    const mod = (await import(spec)) as { vectorCandidates?: (pool: Q, cfg: unknown, query: string, filters: unknown, k: number) => Promise<{ event_id: number | string; score: number }[]> };
    if (typeof mod.vectorCandidates !== "function") return { fn: null, note: "embeddings module exports no vectorCandidates" };
    const vc = mod.vectorCandidates;
    return { fn: (query, filters, k) => vc(q, cfg, query, filters, k), note: null };
  } catch (e: any) {
    return { fn: null, note: `embeddings module unavailable (${clip(String(e?.message ?? e), 80)})` };
  }
}

/**
 * Search captured events. Candidates: the lexical top-K (Postgres FTS over the GIN index) and, when
 * available, the vector top-K, fused by reciprocal rank fusion into `similarity`. Ranking: authority
 * tier desc, then recency desc, then similarity desc; similarity never overrides tier or recency.
 * Tiers come from one join of the candidate set against cont_state_updates.evidence (jsonb containment).
 *
 * As-of: events at or before `asOf` only; an update created after `asOf` does not exist, one confirmed
 * or rejected after it counts as proposed, and a superseder confirmed after it has not yet superseded.
 * This mirrors investigation.ts's as-of over the git ledger, which resolves object supersession at a
 * date; here the instant also bounds the events themselves, and there is no analytical scope filter.
 */
export async function searchEvidence(q: Q, query: string, f: EvidenceSearchFilters = {}): Promise<EvidenceSearchResult> {
  const text = String(query ?? "").trim();
  const asOf = asOfDate(f.asOf);
  const empty = (retrieval: EvidenceSearchResult["retrieval"], note: string | null): EvidenceSearchResult => ({ hits: [], retrieval, retrieval_note: note, as_of: asOf ? asOf.toISOString() : null });
  if (!text) return empty("lexical only", null);
  const limit = lim(f.limit, 20, 200);
  const k = limit * CANDIDATE_FACTOR;

  // ----- filters shared by the lexical query and the vector-row fetch: scope is never widened by either list -----
  const params: unknown[] = [text];
  const where: string[] = [];
  if (f.repo === null) where.push(`s.repo is null`);
  else if (f.repo) { params.push(f.repo); where.push(`s.repo = $${params.length}`); }
  if (f.author) { params.push(f.author); where.push(`s.author = $${params.length}`); }
  // a rendered session id is always an 8-char prefix; resolve it, and let an unknown id be an error rather than an empty search
  if (f.session_id) { params.push((await resolveSessionId(q, f.session_id)).id); where.push(`e.session_id = $${params.length}`); }
  if (f.record_id) {
    if (!isUuid(f.record_id)) return empty("lexical only", null);
    params.push(f.record_id);
    where.push(`exists (select 1 from cont_record_links l where l.record_id = $${params.length} and l.session_id = e.session_id and e.seq between l.from_seq and l.to_seq)`);
  }
  if (f.kinds?.length) { params.push(f.kinds); where.push(`e.kind = any($${params.length})`); }
  if (f.sinceHours != null) { params.push(hours(f.sinceHours)); where.push(`coalesce(e.occurred_at, e.received_at) > now() - ($${params.length}::float8 * interval '1 hour')`); }
  if (asOf) { params.push(asOf); where.push(`coalesce(e.occurred_at, e.received_at) <= $${params.length}`); }
  const tsq = `plainto_tsquery('english', $1)`;
  type Row = EventRow & { author: string; harness: string; rank: number; tool_name: string | null };
  // a Codex tool.finished carries only call_id: borrow the tool name from its request so ledger writes are recognised
  const select = `select e.*, s.author, s.harness, ts_rank(${fts("e")}, ${tsq})::float8 as rank,
            case when e.kind = 'tool.finished' and e.payload->>'tool' is null and e.call_id is not null
                 then (select r.payload->>'tool' from cont_events r where r.session_id = e.session_id and r.call_id = e.call_id and r.kind = 'tool.requested' order by r.seq desc limit 1) end as tool_name
       from cont_events e
       join cont_sessions s on s.id = e.session_id`;

  // ----- lexical candidates -----
  const lex = await q.query<Row>(`${select} where ${[`${fts("e")} @@ ${tsq}`, ...where].join(" and ")} order by rank desc, e.id desc limit ${k}`, params);
  const rows = new Map<string, Row>();
  const lexRank = new Map<string, number>();
  lex.rows.forEach((r, i) => { rows.set(String(r.id), r); lexRank.set(String(r.id), i + 1); });

  // ----- vector candidates (optional) -----
  let retrieval: EvidenceSearchResult["retrieval"] = "lexical only";
  let note: string | null = null;
  const vecRank = new Map<string, number>();
  let candidates: CandidateFn | null | undefined = f.candidates;
  if (candidates === undefined) { const d = await defaultCandidates(q, f.cfg); candidates = d.fn; note = d.note; }
  else if (candidates === null) note = "vector list disabled";
  if (candidates) {
    try {
      const vc = await candidates(text, { repo: f.repo, record_id: f.record_id, session_id: f.session_id, kinds: f.kinds, sinceHours: f.sinceHours, asOf: asOf ? asOf.toISOString() : undefined }, k);
      const ids = [...new Set(vc.filter((c) => c && c.event_id != null).map((c) => String(c.event_id)))];
      if (!ids.length) note = "embeddings returned no candidates (not configured, or nothing near the query)";
      else {
        // the same filters apply to vector rows; a candidate outside the scope is dropped, never shown
        const vparams = [...params, ids];
        const vr = await q.query<Row>(`${select} where ${[`e.id = any($${vparams.length}::bigint[])`, ...where].join(" and ")}`, vparams);
        const present = new Set(vr.rows.map((r) => String(r.id)));
        for (const r of vr.rows) if (!rows.has(String(r.id))) rows.set(String(r.id), { ...r, rank: 0 });
        let pos = 0;
        for (const c of [...vc].sort((a, b) => b.score - a.score)) { const id = String(c.event_id); if (present.has(id) && !vecRank.has(id)) vecRank.set(id, ++pos); }
        retrieval = "lexical + vector";
        note = present.size ? null : `${ids.length} vector candidate${ids.length === 1 ? "" : "s"} fell outside the scope and were dropped`;
      }
    } catch (e: any) {
      note = `vector search failed (${clip(String(e?.message ?? e), 80)}); lexical only`;
    }
  }
  if (!rows.size) return empty(retrieval, note);

  // ----- authority: one join of the candidate (session_id, seq) pairs against update evidence -----
  const cand = [...rows.values()];
  const cparams: unknown[] = [cand.map((r) => r.session_id), cand.map((r) => r.seq), asOf];
  type Cite = { session_id: string; seq: number; update_id: string; record_id: string; status: string; superseded_by: string | null };
  const cites = await q.query<Cite>(
    `with c as (select * from unnest($1::text[], $2::int[]) as t(session_id, seq))
     select c.session_id, c.seq, u.id as update_id, u.record_id,
            case when $3::timestamptz is null then u.status
                 when u.status = 'confirmed' and coalesce(u.confirmed_at, u.created_at) > $3::timestamptz then 'proposed'
                 when u.status = 'rejected' and coalesce(u.rejected_at, u.created_at) > $3::timestamptz then 'proposed'
                 else u.status end as status,
            (select v.id from cont_state_updates v
              where v.supersedes = u.id and v.status = 'confirmed' and ($3::timestamptz is null or coalesce(v.confirmed_at, v.created_at) <= $3::timestamptz)
              order by v.confirmed_at, v.id limit 1) as superseded_by
       from c
       join cont_state_updates u on u.evidence @> jsonb_build_array(jsonb_build_object('session_id', c.session_id, 'seq', c.seq))
      where $3::timestamptz is null or u.created_at <= $3::timestamptz`,
    cparams
  );
  const byKey = new Map<string, EvidenceCitation[]>();
  for (const c of cites.rows) {
    const key = `${c.session_id}:${c.seq}`;
    const arr = byKey.get(key) ?? [];
    arr.push({ update_id: c.update_id, record_id: c.record_id, status: c.status as UpdateStatus, superseded_by: c.superseded_by });
    byKey.set(key, arr);
  }

  const hits: EvidenceHit[] = cand.map((r) => {
    const id = String(r.id);
    const citations = byKey.get(`${r.session_id}:${r.seq}`) ?? [];
    const tool = String(r.payload?.tool ?? r.tool_name ?? "");
    const ledger_write = r.kind === "tool.finished" && LEDGER_WRITE_TOOL.test(tool) && String(r.payload?.is_error ?? "false") !== "true";
    const live = citations.filter((c) => !c.superseded_by && c.status !== "rejected");
    let tier: EvidenceTier;
    let label: EvidenceLabel;
    if (ledger_write || live.some((c) => c.status === "confirmed")) { tier = 3; label = "current"; }
    else if (live.some((c) => c.status === "proposed")) { tier = 2; label = "PROPOSED"; }
    else if (citations.length) {
      tier = 0;
      const sup = citations.find((c) => c.superseded_by);
      label = sup ? `superseded by ${sup.superseded_by}` : "rejected";
    } else { tier = 1; label = "uncited"; }
    const lr = lexRank.get(id);
    const vr = vecRank.get(id);
    const similarity = (lr ? 1 / (RRF_K + lr) : 0) + (vr ? 1 / (RRF_K + vr) : 0);
    const sources: EvidenceHit["sources"] = [...(lr ? ["lexical" as const] : []), ...(vr ? ["vector" as const] : [])];
    const { tool_name: _t, ...ev } = r;
    return { ...ev, similarity, sources, tier, label, citations, ledger_write };
  });
  const at = (e: EventRow) => new Date(e.occurred_at ?? e.received_at).getTime();
  hits.sort((a, b) => b.tier - a.tier || at(b) - at(a) || b.similarity - a.similarity || Number(b.id) - Number(a.id));
  return { hits: hits.slice(0, limit), retrieval, retrieval_note: note, as_of: asOf ? asOf.toISOString() : null };
}

/** Full-text search over event text; `searchEvidence` without the retrieval metadata. */
export async function searchEvents(q: Q, query: string, f: EvidenceSearchFilters = {}): Promise<EvidenceHit[]> {
  return (await searchEvidence(q, query, f)).hits;
}

// ---------- as-of view of record summaries ----------

/**
 * Re-evaluate a record listing as of an instant: records created after it disappear; proposed/confirmed
 * counts follow the same as-of status rules as `searchEvidence` (confirmed after asOf → proposed;
 * rejected after asOf → proposed; a superseder confirmed after asOf has not yet hidden its predecessor);
 * state_version is the current version minus the confirmations after asOf, an approximation because a
 * person's interactive re-acceptance moves confirmed_at and bumps the version once more.
 * Differs from investigation.ts's as-of, which never hides objects and evaluates only supersession.
 */
export async function asOfRecordSummaries<T extends { id: string; state_version: number; proposed: number; confirmed: number; created_at: Date }>(q: Q, rows: T[], asOf: string | Date): Promise<(T & { as_of: string })[]> {
  const at = asOfDate(asOf);
  if (!at) return rows.map((r) => ({ ...r, as_of: "" }));
  const kept = rows.filter((r) => new Date(r.created_at).getTime() <= at.getTime());
  if (!kept.length) return [];
  type C = { id: string; proposed: number; confirmed: number; after: number };
  const r = await q.query<C>(
    `with u as (
       select u.record_id, u.id, u.confirmed_at,
              case when u.status = 'confirmed' and coalesce(u.confirmed_at, u.created_at) > $2::timestamptz then 'proposed'
                   when u.status = 'rejected' and coalesce(u.rejected_at, u.created_at) > $2::timestamptz then 'proposed'
                   else u.status end as status,
              exists (select 1 from cont_state_updates v where v.supersedes = u.id and v.status = 'confirmed' and coalesce(v.confirmed_at, v.created_at) <= $2::timestamptz) as superseded
         from cont_state_updates u
        where u.record_id = any($1::uuid[]) and u.created_at <= $2::timestamptz
     )
     select r.id,
            (select count(*) from u where u.record_id = r.id and u.status = 'proposed' and not u.superseded)::int as proposed,
            (select count(*) from u where u.record_id = r.id and u.status = 'confirmed' and not u.superseded)::int as confirmed,
            (select count(*) from cont_state_updates x where x.record_id = r.id and x.status = 'confirmed' and x.confirmed_at > $2::timestamptz)::int as after
       from cont_records r where r.id = any($1::uuid[])`,
    [kept.map((x) => x.id), at]
  );
  const by = new Map(r.rows.map((x) => [x.id, x]));
  return kept.map((row) => {
    const c = by.get(row.id);
    return { ...row, proposed: c?.proposed ?? 0, confirmed: c?.confirmed ?? 0, state_version: Math.max(0, row.state_version - (c?.after ?? 0)), as_of: at.toISOString() };
  });
}

/** Records whose linked spans overlap a given session, for "what did this session contribute to". */
export async function recordsForSession(q: Q, session_id: string): Promise<(WorkRecord & { spans: number; sources: LinkSource[] })[]> {
  const r = await q.query<WorkRecord & { spans: number; sources: LinkSource[] }>(
    `select r.*, count(l.id)::int as spans, array_agg(distinct l.source order by l.source) as sources
       from cont_records r
       join cont_record_links l on l.record_id = r.id
      where l.session_id = $1
      group by r.id
      order by r.updated_at desc, r.id`,
    [session_id]
  );
  return r.rows;
}
