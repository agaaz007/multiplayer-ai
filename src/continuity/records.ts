import type pg from "pg";
import type { EventRow } from "./store.js";

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
}

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

async function sessionExists(q: Q, session_id: string): Promise<boolean> {
  const r = await q.query(`select 1 from cont_sessions where id = $1`, [session_id]);
  return (r.rowCount ?? 0) > 0;
}

async function requireRecord(q: Q, id: string): Promise<WorkRecord> {
  const rec = await getRecord(q, id);
  if (!rec) throw new Error(`record not found: ${id}`);
  return rec;
}

// ---------- records ----------

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
  if (!(await sessionExists(q, sessionId))) throw new Error(`session not found: ${sessionId}`);
  // Overlapping links from different sources are allowed on purpose: an explicit link can sit over a suggested one.
  // The record's updated_at moves in the same statement so listRecords reflects new evidence.
  const r = await q.query<RecordLink>(
    `with l as (
       insert into cont_record_links (record_id, session_id, from_seq, to_seq, source, confidence, note, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *
     ), r as (update cont_records set updated_at = now() where id = $1)
     select * from l`,
    [l.record_id, sessionId, l.from_seq, l.to_seq, l.source, confidence, l.note ?? null, createdBy]
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
  if (f.session_id) { params.push(f.session_id); where.push(`e.session_id = $${params.length}`); }
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

export async function addStateUpdate(q: Q, u: { record_id: string; session_id?: string | null; from_seq?: number | null; to_seq?: number | null; kind: UpdateKind; text: string; evidence?: { session_id: string; seq: number }[]; created_by: string; status?: UpdateStatus; supersedes?: string | null }): Promise<StateUpdate> {
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
  if (sessionId && !(await sessionExists(q, sessionId))) throw new Error(`session not found: ${sessionId}`);
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
       insert into cont_state_updates (record_id, session_id, from_seq, to_seq, status, kind, text, evidence, created_by, supersedes, confirmed_by, confirmed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11, case when $11::text is null then null else now() end)
       returning *
     ), r as (
       update cont_records set state_version = state_version + $12::int, updated_at = now() where id = $1
     )
     select * from u`,
    [u.record_id, sessionId, from, to, status, u.kind, text, JSON.stringify(evidence), createdBy, supersedes, confirmed ? createdBy : null, confirmed ? 1 : 0]
  );
  return r.rows[0];
}

export async function confirmStateUpdate(q: Q, id: string, by: string): Promise<StateUpdate | null> {
  if (!isUuid(id)) return null;
  const who = requireText(by, "confirmed_by");
  // proposed → confirmed and the record's state_version bump happen in one statement.
  const r = await q.query<StateUpdate>(
    `with u as (
       update cont_state_updates set status = 'confirmed', confirmed_by = $2, confirmed_at = now()
        where id = $1 and status = 'proposed' returning *
     ), r as (
       update cont_records set state_version = state_version + 1, updated_at = now() where id in (select record_id from u)
     )
     select * from u`,
    [id, who]
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
        and not exists (select 1 from cont_state_updates v where v.record_id = u.record_id and v.supersedes = u.id and v.status <> 'rejected')
      order by u.created_at, u.id`,
    [record_id]
  );
  const state: RecordState = {
    record, progress: [], decisions: [], hypotheses: [], blockers: [], next: [], contradictions: [], notes: [],
    proposed_count: 0, confirmed_count: 0, last_update_at: null, contributing_sessions: [],
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
  return state;
}

// ---------- evidence retrieval across sessions ----------

/** Events across every linked span of a record, ordered by occurred_at, each annotated with session author/harness. */
export async function recordEvidence(q: Q, record_id: string, f: { kinds?: string[]; limit?: number; after?: Date | null; sources?: LinkSource[] } = {}): Promise<(EventRow & { author: string; harness: string; link_source: LinkSource })[]> {
  if (!isUuid(record_id)) return [];
  const params: unknown[] = [record_id];
  const where: string[] = [`l.record_id = $1`];
  if (f.sources?.length) { for (const s of f.sources) assertOneOf(LINK_SOURCES, s, "link source"); params.push(f.sources); where.push(`l.source = any($${params.length})`); }
  if (f.kinds?.length) { params.push(f.kinds); where.push(`e.kind = any($${params.length})`); }
  if (f.after) { params.push(f.after); where.push(`coalesce(e.occurred_at, e.received_at) > $${params.length}`); }
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
     order by x.occurred_at asc nulls last, x.id asc
     limit ${limit}`,
    params
  );
  return r.rows;
}

/** Full-text search over event text (instructions, assistant messages, tool inputs, output previews, compaction summaries). */
export async function searchEvents(q: Q, query: string, f: { repo?: string | null; session_id?: string; record_id?: string; kinds?: string[]; sinceHours?: number; limit?: number } = {}): Promise<(EventRow & { author: string; harness: string; rank: number })[]> {
  const text = String(query ?? "").trim();
  if (!text) return [];
  const params: unknown[] = [text];
  const tsq = `plainto_tsquery('english', $1)`;
  const where: string[] = [`${fts("e")} @@ ${tsq}`];
  if (f.repo === null) where.push(`s.repo is null`);
  else if (f.repo) { params.push(f.repo); where.push(`s.repo = $${params.length}`); }
  if (f.session_id) { params.push(f.session_id); where.push(`e.session_id = $${params.length}`); }
  if (f.record_id) {
    if (!isUuid(f.record_id)) return [];
    params.push(f.record_id);
    where.push(`exists (select 1 from cont_record_links l where l.record_id = $${params.length} and l.session_id = e.session_id and e.seq between l.from_seq and l.to_seq)`);
  }
  if (f.kinds?.length) { params.push(f.kinds); where.push(`e.kind = any($${params.length})`); }
  if (f.sinceHours != null) { params.push(hours(f.sinceHours)); where.push(`coalesce(e.occurred_at, e.received_at) > now() - ($${params.length}::float8 * interval '1 hour')`); }
  const limit = lim(f.limit, 20, 200);
  const r = await q.query<EventRow & { author: string; harness: string; rank: number }>(
    `select e.*, s.author, s.harness, ts_rank(${fts("e")}, ${tsq})::float8 as rank
       from cont_events e
       join cont_sessions s on s.id = e.session_id
      where ${where.join(" and ")}
      order by rank desc, e.id desc
      limit ${limit}`,
    params
  );
  return r.rows;
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
