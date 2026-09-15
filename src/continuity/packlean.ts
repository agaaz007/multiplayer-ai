import type pg from "pg";
import { getRecord, type RecordState, type StateUpdate, type UpdateKind } from "./records.js";
import { EVENTS_MAX_LIMIT } from "./evidence.js";
import { stateLine } from "./packsections.js";

/**
 * Helpers for the lean packs (2026-09-15, after the teamwork-v3 bake-off: successors read packs full of raw
 * event lines, then pulled events with 12,000-char previews and compacted six or seven times). Both packs
 * now default to `detail: "lean"`: state, decisions, pending work, what changed since the reader's last
 * visit, bootstrap, and drill-down references. No event line is ever inlined in lean mode; every reference
 * is an exact fetch (`ledger_events(session_id, after_seq, limit)`, `ledger_evidence_search`, `ledger_artifact_get`).
 *
 *   recordStateAsOf   the record's state projection at an instant (updates created later are absent; a
 *                     confirmation or rejection later than the instant is undone, so the update shows as proposed)
 *   recordVisitDelta  what happened on a record after the viewer's most recent contributing session
 *   threadVisitDelta  the same for a thread
 *   renderVisitDelta  the "Changed since your last visit" section, or "first visit" with totals
 *   spanFetch         one `ledger_events(...)` call that returns exactly one linked span
 */

type Q = pg.Pool | pg.PoolClient;

export type PackDetail = "lean" | "evidence";

const short = (sid: string) => sid.slice(0, 8);
const fmt = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 19).replace("T", " ") + "Z" : "unknown");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const q = (s: string) => JSON.stringify(s);
const harnessName = (h: string | null | undefined) => (h === "claude" ? "Claude Code" : h === "codex" ? "Codex" : h || "unknown harness");

/** Parse an `as_of` option; an invalid string is an error, never silently "now". */
export function parseAsOf(s: string | undefined | null): Date | null {
  if (s == null || s === "") return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`as_of is not a time: ${s}`);
  return d;
}

/** `ledger_events(session_id: "…", after_seq: from-1, limit: n)`: exactly the events of one span, capped at the tool's maximum. */
export function spanFetch(l: { session_id: string; from_seq: number; to_seq: number }): string {
  const n = l.to_seq - l.from_seq + 1;
  return `ledger_events(session_id: ${q(l.session_id)}, after_seq: ${l.from_seq - 1}, limit: ${Math.min(n, EVENTS_MAX_LIMIT)})${n > EVENTS_MAX_LIMIT ? ` then page with after_seq up to ${l.to_seq}` : ""}`;
}

// ---------- state as of an instant ----------

/**
 * Mirrors records.recordState, restricted to what existed at `asOf`: updates created later are absent; an
 * update confirmed or rejected after the instant is shown as it was then, proposed; an update superseded by
 * a confirmation later than the instant is still live. Contributing sessions are the record's linked sessions
 * (links are organisation, not evidence, so they are not filtered by time).
 */
export async function recordStateAsOf(qq: Q, recordId: string, asOf: Date): Promise<RecordState | null> {
  const record = await getRecord(qq, recordId);
  if (!record) return null;
  const ups = await qq.query<StateUpdate>(
    `select u.* from cont_state_updates u
      where u.record_id = $1 and u.created_at <= $2
        and not (u.status = 'rejected' and coalesce(u.rejected_at, u.created_at) <= $2)
        and not exists (select 1 from cont_state_updates v where v.record_id = u.record_id and v.supersedes = u.id and v.status = 'confirmed' and coalesce(v.confirmed_at, v.created_at) <= $2)
      order by u.created_at, u.id`,
    [recordId, asOf]
  );
  const rows: StateUpdate[] = ups.rows.map((u) => {
    if (u.status === "confirmed" && u.confirmed_at && new Date(u.confirmed_at).getTime() > asOf.getTime()) return { ...u, status: "proposed", confirmed_by: null, confirmed_at: null, confirmed_session_id: null, confirmed_via: null };
    if (u.status === "rejected") return { ...u, status: "proposed", rejected_by: null, rejected_at: null, reject_reason: null };
    return u;
  });
  const state: RecordState = {
    record, progress: [], decisions: [], hypotheses: [], blockers: [], next: [], contradictions: [], notes: [],
    proposed_count: 0, confirmed_count: 0, last_update_at: null, conflicts: [], contributing_sessions: [],
  };
  const bucket: Record<UpdateKind, StateUpdate[]> = { progress: state.progress, decision: state.decisions, hypothesis: state.hypotheses, blocker: state.blockers, next: state.next, contradiction: state.contradictions, note: state.notes };
  let last = 0;
  for (const u of rows) {
    (bucket[u.kind] ?? state.notes).push(u);
    if (u.status === "proposed") state.proposed_count++;
    else if (u.status === "confirmed") state.confirmed_count++;
    const t = Math.max(new Date(u.created_at).getTime(), u.confirmed_at ? new Date(u.confirmed_at).getTime() : 0);
    if (t > last) last = t;
  }
  state.last_update_at = last ? new Date(last) : null;
  const cs = await qq.query<{ session_id: string; author: string; harness: string; last_seen_at: Date | null; spans: number }>(
    `select l.session_id, s.author, s.harness, s.last_seen_at, count(*)::int as spans
       from cont_record_links l join cont_sessions s on s.id = l.session_id
      where l.record_id = $1
      group by l.session_id, s.author, s.harness, s.last_seen_at
      order by s.last_seen_at desc nulls last, l.session_id`,
    [recordId]
  );
  state.contributing_sessions = cs.rows;
  const lineage = await qq.query<{ id: string; supersedes: string | null }>(`select id, supersedes from cont_state_updates where record_id = $1 and created_at <= $2`, [recordId, asOf]);
  const parents = new Map(lineage.rows.map((u) => [u.id, u.supersedes]));
  const replacements = new Map<string, string[]>();
  for (const u of rows) if (u.status === "confirmed" && u.supersedes) {
    let root = u.supersedes;
    const seen = new Set<string>();
    while (parents.get(root) && !seen.has(root)) { seen.add(root); root = parents.get(root)!; }
    replacements.set(root, [...(replacements.get(root) ?? []), u.id]);
  }
  state.conflicts = [...replacements].filter(([, ids]) => ids.length > 1).map(([supersedes, update_ids]) => ({ supersedes, update_ids }));
  return state;
}

/** Count of content events inside a record's covering spans up to an instant (the as-of counterpart of records.recordEvidenceCount). */
export async function recordEvidenceCountAsOf(qq: Q, recordId: string, kinds: string[], sources: string[], asOf: Date): Promise<number> {
  const r = await qq.query<{ n: number }>(
    `select count(*)::int as n from cont_events e
      where e.kind = any($2) and coalesce(e.occurred_at, e.received_at) <= $4
        and exists (select 1 from cont_record_links l where l.record_id = $1 and l.session_id = e.session_id and e.seq between l.from_seq and l.to_seq and l.source = any($3))`,
    [recordId, kinds, sources, asOf]
  );
  return r.rows[0]?.n ?? 0;
}

/** tool.requested at or before `asOf` with no tool.finished for the same call at or before `asOf`: what was in flight at that instant. */
export async function pendingOperationsAsOf(qq: Q, sessionId: string, asOf: Date): Promise<{ call_id: string; tool: string; input: string; seq: number; occurred_at: Date | null }[]> {
  const r = await qq.query(
    `select a.call_id, a.payload->>'tool' as tool, a.payload->>'input' as input, a.seq, a.occurred_at
       from cont_events a
      where a.session_id = $1 and a.kind = 'tool.requested' and coalesce(a.occurred_at, a.received_at) <= $2
        and not exists (select 1 from cont_events b where b.session_id = a.session_id and b.call_id = a.call_id and b.kind = 'tool.finished' and coalesce(b.occurred_at, b.received_at) <= $2)
      order by a.seq`,
    [sessionId, asOf]
  );
  return r.rows;
}

// ---------- changed since your last visit ----------

export interface DeltaEvents { session_id: string; author: string; harness: string; count: number; from_seq: number; to_seq: number; last_at: Date | null }

export interface VisitDelta {
  viewer: string | null;
  /** no earlier session of the viewer contributes; `events`, `files` and `pending` then carry totals */
  first_visit: boolean;
  /** the viewer's most recent contributing session, when there is one */
  last_session: { session_id: string; last_seen_at: Date | null } | null;
  /** the instant the delta starts from: the last session's last_seen_at; null for a first visit */
  since: Date | null;
  events: DeltaEvents[];
  /** records only: live updates created after `since`, and updates confirmed after `since` that already existed */
  state_updates: { added: StateUpdate[]; confirmed: StateUpdate[] };
  pending: { session_id: string; seq: number; tool: string }[];
  files: { path: string; count: number }[];
  /** threads only: checkpoints published after `since` */
  checkpoints: number;
}

interface DeltaOpts {
  viewer?: string | null;
  /** the session reading the pack: never its own "last visit" */
  excludeSessionId?: string | null;
  asOf?: Date | null;
}

const upper = (asOf: Date | null | undefined, col: string, params: unknown[]) => { if (!asOf) return ""; params.push(asOf); return ` and ${col} <= $${params.length}`; };

/** What happened on a record after the viewer's most recent contributing session (through links or state updates). */
export async function recordVisitDelta(qq: Q, recordId: string, state: RecordState, pend: { session_id: string; seq: number; tool: string; occurred_at?: Date | null }[], o: DeltaOpts): Promise<VisitDelta> {
  const viewer = o.viewer ?? null;
  let last: VisitDelta["last_session"] = null;
  if (viewer) {
    const p: unknown[] = [recordId, viewer, o.excludeSessionId ?? ""];
    const cap = upper(o.asOf, "coalesce(s.started_at, s.last_seen_at)", p);
    const r = await qq.query<{ id: string; last_seen_at: Date | null }>(
      `select s.id, s.last_seen_at from cont_sessions s
        where s.author = $2 and s.id <> $3${cap}
          and (exists (select 1 from cont_record_links l where l.record_id = $1 and l.session_id = s.id and l.source <> 'unassigned')
            or exists (select 1 from cont_state_updates u where u.record_id = $1 and (u.session_id = s.id or u.proposed_session_id = s.id or u.confirmed_session_id = s.id)))
        order by s.last_seen_at desc nulls last, s.id limit 1`,
      p
    );
    if (r.rows[0]) last = { session_id: r.rows[0].id, last_seen_at: r.rows[0].last_seen_at };
  }
  const since = last?.last_seen_at ?? null;
  const first = !last;
  const p: unknown[] = [recordId];
  let win = "";
  if (since) { p.push(since); win += ` and coalesce(e.occurred_at, e.received_at) > $${p.length}`; }
  win += upper(o.asOf, "coalesce(e.occurred_at, e.received_at)", p);
  const inSpans = `exists (select 1 from cont_record_links l where l.record_id = $1 and l.session_id = e.session_id and e.seq between l.from_seq and l.to_seq and l.source <> 'unassigned')`;
  const ev = await qq.query<DeltaEvents>(
    `select e.session_id, s.author, s.harness, count(*)::int as count, min(e.seq)::int as from_seq, max(e.seq)::int as to_seq, max(coalesce(e.occurred_at, e.received_at)) as last_at
       from cont_events e join cont_sessions s on s.id = e.session_id
      where ${inSpans}${win}
      group by e.session_id, s.author, s.harness order by last_at desc nulls last, e.session_id`,
    p
  );
  const files = await qq.query<{ path: string; count: number }>(
    `select e.payload->>'path' as path, count(*)::int as count from cont_events e
      where e.kind = 'file.changed' and coalesce(e.payload->>'path','') <> '' and ${inSpans}${win}
      group by e.payload->>'path' order by max(coalesce(e.occurred_at, e.received_at)) desc, count desc`,
    p
  );
  const all = [...state.decisions, ...state.blockers, ...state.next, ...state.progress, ...state.hypotheses, ...state.contradictions, ...state.notes];
  const t = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);
  const s = since ? since.getTime() : 0;
  const added = since ? all.filter((u) => t(u.created_at) > s) : all;
  const confirmed = since ? all.filter((u) => u.status === "confirmed" && t(u.created_at) <= s && t(u.confirmed_at) > s) : [];
  const pendSince = since ? pend.filter((x) => t(x.occurred_at) > s) : pend;
  return {
    viewer, first_visit: first, last_session: last, since, events: ev.rows,
    state_updates: { added, confirmed },
    pending: pendSince.map((x) => ({ session_id: x.session_id, seq: x.seq, tool: x.tool })),
    files: files.rows, checkpoints: 0,
  };
}

/** What happened on a thread after the viewer's most recent session on it. */
export async function threadVisitDelta(qq: Q, threadId: string, pend: { seq: number; tool: string; occurred_at?: Date | null; session_id?: string }[], o: DeltaOpts): Promise<VisitDelta> {
  const viewer = o.viewer ?? null;
  let last: VisitDelta["last_session"] = null;
  if (viewer) {
    const p: unknown[] = [threadId, viewer, o.excludeSessionId ?? ""];
    const cap = upper(o.asOf, "coalesce(s.started_at, s.last_seen_at)", p);
    const r = await qq.query<{ id: string; last_seen_at: Date | null }>(
      `select s.id, s.last_seen_at from cont_sessions s
        where s.author = $2 and s.id <> $3${cap}
          and (s.thread_id = $1 or exists (select 1 from cont_events e where e.session_id = s.id and e.thread_id = $1))
        order by s.last_seen_at desc nulls last, s.id limit 1`,
      p
    );
    if (r.rows[0]) last = { session_id: r.rows[0].id, last_seen_at: r.rows[0].last_seen_at };
  }
  const since = last?.last_seen_at ?? null;
  const p: unknown[] = [threadId];
  let win = "";
  if (since) { p.push(since); win += ` and coalesce(e.occurred_at, e.received_at) > $${p.length}`; }
  win += upper(o.asOf, "coalesce(e.occurred_at, e.received_at)", p);
  const ev = await qq.query<DeltaEvents>(
    `select e.session_id, s.author, s.harness, count(*)::int as count, min(e.seq)::int as from_seq, max(e.seq)::int as to_seq, max(coalesce(e.occurred_at, e.received_at)) as last_at
       from cont_events e join cont_sessions s on s.id = e.session_id
      where e.thread_id = $1${win}
      group by e.session_id, s.author, s.harness order by last_at desc nulls last, e.session_id`,
    p
  );
  const files = await qq.query<{ path: string; count: number }>(
    `select e.payload->>'path' as path, count(*)::int as count from cont_events e
      where e.thread_id = $1 and e.kind = 'file.changed' and coalesce(e.payload->>'path','') <> ''${win}
      group by e.payload->>'path' order by max(coalesce(e.occurred_at, e.received_at)) desc, count desc`,
    p
  );
  const cp: unknown[] = [threadId];
  let cwin = "";
  if (since) { cp.push(since); cwin += ` and created_at > $${cp.length}`; }
  cwin += upper(o.asOf, "created_at", cp);
  const checkpoints = (await qq.query<{ n: number }>(`select count(*)::int as n from cont_checkpoints where thread_id = $1${cwin}`, cp)).rows[0].n;
  const t = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);
  const pendSince = since ? pend.filter((x) => t(x.occurred_at) > since.getTime()) : pend;
  return {
    viewer, first_visit: !last, last_session: last, since, events: ev.rows,
    state_updates: { added: [], confirmed: [] },
    pending: pendSince.map((x) => ({ session_id: x.session_id ?? "", seq: x.seq, tool: x.tool })),
    files: files.rows, checkpoints,
  };
}

const DELTA_UPDATES_FULL = 3;
const DELTA_FILES_MAX = 8;
const DELTA_SESSIONS_MAX = 6;

/**
 * The "Changed since your last visit" section. `unit` names what the delta is over; `created` is the record's or
 * thread's creation time (a first visit reports totals since then); `stateFetch` restores the full state list.
 * Level 1 keeps counts and ids only.
 */
export function renderVisitDelta(d: VisitDelta, o: { unit: "record" | "thread"; created: Date; stateFetch?: string; level?: number }): string[] {
  const L: string[] = [];
  const level = o.level ?? 0;
  const events = d.events.reduce((n, e) => n + e.count, 0);
  L.push(`## Changed since your last visit`);
  const totals = () => {
    const parts = [`${plural(events, "event")} in ${plural(d.events.length, "session")}`];
    if (o.unit === "record") parts.push(`${plural(d.state_updates.added.length, "state update")} (${d.state_updates.added.filter((u) => u.status === "proposed").length} proposed, ${d.state_updates.added.filter((u) => u.status === "confirmed").length} confirmed)`);
    else parts.push(plural(d.checkpoints, "checkpoint"));
    parts.push(plural(d.pending.length, "pending operation"), `${plural(d.files.length, "file")} touched`);
    return parts.join(", ");
  };
  if (!d.viewer) {
    L.push(`No viewer given, so your last visit is unknown. Totals for this ${o.unit} (created ${fmt(o.created)}): ${totals()}.`);
    if (d.files.length && level < 1) L.push(`- files: ${d.files.slice(0, DELTA_FILES_MAX).map((f) => f.path).join(", ")}${d.files.length > DELTA_FILES_MAX ? ` … ${d.files.length - DELTA_FILES_MAX} more` : ""}`);
    return L;
  }
  if (d.first_visit) {
    L.push(`First visit for ${d.viewer}: no earlier session of yours contributes to this ${o.unit}. Totals since creation (${fmt(o.created)}): ${totals()}.`);
    if (d.files.length && level < 1) L.push(`- files: ${d.files.slice(0, DELTA_FILES_MAX).map((f) => f.path).join(", ")}${d.files.length > DELTA_FILES_MAX ? ` … ${d.files.length - DELTA_FILES_MAX} more` : ""}`);
    return L;
  }
  L.push(`Your last contributing session ${short(d.last_session!.session_id)} was last seen ${fmt(d.since)}. Since then:`);
  const nothing = !d.events.length && !d.state_updates.added.length && !d.state_updates.confirmed.length && !d.pending.length && !d.files.length && !d.checkpoints;
  if (nothing) { L.push(`- nothing new: no events, ${o.unit === "record" ? "state updates" : "checkpoints"}, pending operations or file changes after that instant`); return L; }
  for (const e of d.events.slice(0, DELTA_SESSIONS_MAX)) L.push(`- ${plural(e.count, "new event")} in session ${short(e.session_id)} (${e.author}, ${harnessName(e.harness)}) seq ${e.from_seq}..${e.to_seq}${e.last_at ? `, last ${fmt(e.last_at)}` : ""}: ${spanFetch({ session_id: e.session_id, from_seq: e.from_seq, to_seq: e.to_seq })}`);
  if (d.events.length > DELTA_SESSIONS_MAX) L.push(`- … ${d.events.length - DELTA_SESSIONS_MAX} more sessions with new events`);
  if (o.unit === "record") {
    const ups = (label: string, list: StateUpdate[]) => {
      if (!list.length) return;
      if (list.length <= DELTA_UPDATES_FULL && level < 1) for (const u of list) L.push(`- ${label}: ${stateLine(u).slice(2)}`);
      else L.push(`- ${label} (${list.length}): ${list.map((u) => `${u.kind} ${short(u.id)} [${u.status === "confirmed" ? "confirmed" : "PROPOSED"}]`).join(", ")}${o.stateFetch ? `; full text via ${o.stateFetch}` : ""}`);
    };
    ups("state update added", d.state_updates.added);
    ups("confirmed since", d.state_updates.confirmed);
  } else if (d.checkpoints) L.push(`- ${plural(d.checkpoints, "checkpoint")} published`);
  if (d.pending.length) L.push(`- ${plural(d.pending.length, "new pending operation")}: ${d.pending.slice(0, 5).map((x) => `${x.session_id ? `session ${short(x.session_id)} ` : ""}seq ${x.seq} ${x.tool}`).join("; ")}${d.pending.length > 5 ? " …" : ""}`);
  if (d.files.length) L.push(`- files touched (${d.files.length}): ${d.files.slice(0, level >= 1 ? 3 : DELTA_FILES_MAX).map((f) => `${f.path}${f.count > 1 ? ` ×${f.count}` : ""}`).join(", ")}${d.files.length > (level >= 1 ? 3 : DELTA_FILES_MAX) ? " …" : ""}`);
  return L;
}

/** Artifact ids referenced by an event payload (tool results store large outputs and inputs as artifacts). */
export function artifactIds(payload: Record<string, unknown> | null | undefined): string[] {
  if (!payload) return [];
  const ids: string[] = [];
  for (const k of ["artifact_id", "input_artifact_id"]) { const v = payload[k]; if (typeof v === "string" && v) ids.push(v); }
  return ids;
}
