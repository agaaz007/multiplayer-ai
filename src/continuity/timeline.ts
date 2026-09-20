import path from "node:path";
import type pg from "pg";
import type { Config } from "../store.js";
import { continuityConfigured, getPool } from "./db.js";
import { redactText } from "./redact.js";

/**
 * The multiplayer timeline: two people, on two harnesses, working one question.
 *
 * This is runtime observation, not knowledge. It reads cont_* rows and renders them; it never
 * writes, and it is never emitted into the ledger repo (views.ts owns generated files and they
 * must stay a pure function of the git objects). CLI and MCP output only.
 *
 * Three rules the renderer enforces, because the underlying rows are weaker than they look:
 *
 *   1. Adjacency is proved, never inferred. A line is only drawn between two people's sessions
 *      when cont_session_bindings or an EXPLICIT cont_record_links span puts them on the same
 *      record. The classifier's own output (source='suggested', status='proposed') is printed
 *      with its label and never counted as a pickup.
 *   2. cont_sessions.harness is a stored field, not a measurement. ensureBindingSession writes it
 *      at MCP-first bind time, before any transcript has been seen, so Codex sessions sit in the
 *      table as 'claude'. We report the stored value alongside the helper's transcript root and
 *      say they disagree; we do not silently correct either one. safety.ts deliberately refuses to
 *      infer a harness from UUID shape, and so do we.
 *   3. Capture lags. Event rows arrive minutes-to-days after the work (received_at - occurred_at),
 *      and some sessions legitimately carry zero events. A quiet lane is not evidence of idleness.
 *
 * Determinism: the only clock input is `now`. Given the same `now` and the same rows, render
 * output is byte-identical -- no "5m ago", every ordering has an id tiebreak.
 */

export const TIMELINE_SCHEMA = "ledger-timeline/v1" as const;

export const TIMELINE_UNCONFIGURED =
  "ledger timeline: execution continuity is not configured on this machine (no continuity.database_url in ~/.ledger/config.json, no LEDGER_CONTINUITY_DB), so there are no captured sessions to place on a timeline.";

export type HarnessConfidence = "corroborated" | "disputed" | "unverified" | "unknown";

export interface TimelineHarness {
  /** exactly what cont_sessions.harness holds; never rewritten here */
  stored: string;
  /** which transcript root the capture helper recorded for this session, when it recorded one */
  transcript_root: "claude" | "codex" | null;
  confidence: HarnessConfidence;
  /** the rendered phrase, so text and JSON consumers cannot drift apart */
  label: string;
}

export type ContributionSource = "binding" | "explicit-link";

export interface TimelineContribution {
  at: string;
  author: string;
  session_id: string;
  source: ContributionSource;
  /** false when the contributing session falls outside the requested window */
  in_window: boolean;
}

export interface TimelineBind {
  at: string;
  record_id: string;
  record_kind: string;
  record_title: string;
  source: ContributionSource;
  bound_by: string | null;
  from_seq: number | null;
  to_seq: number | null;
}

/**
 * The classifier re-links the same session to the same record on every pass, so one suggestion can
 * be dozens of rows. Collapsed per record: the count is kept because it is the honest shape of the
 * evidence, but it never becomes dozens of lines competing with the proved binds.
 */
export interface TimelineSuggestedLink {
  record_id: string;
  record_title: string;
  links: number;
  first_at: string;
  last_at: string;
  max_confidence: number | null;
}

export interface TimelineSession {
  session_id: string;
  author: string;
  machine: string | null;
  harness: TimelineHarness;
  repo: string | null;
  branch: string | null;
  /** basename only: the full cwd is a local home-directory path */
  where: string;
  thread_id: string | null;
  started_at: string | null;
  last_seen_at: string | null;
  ended_at: string | null;
  events: number;
  first_event_at: string | null;
  last_event_at: string | null;
  /** received_at - occurred_at over this session's events, in minutes; null when nothing was captured */
  capture_lag_minutes: { median: number; max: number } | null;
  binds: TimelineBind[];
  suggested_links: TimelineSuggestedLink[];
}

export interface TimelineLane {
  author: string;
  machines: string[];
  sessions: TimelineSession[];
}

export interface TimelineShared {
  record_id: string;
  kind: string;
  title: string;
  status: string;
  created_by: string;
  created_at: string;
  touched_repos: string[];
  authors: string[];
  contributions: TimelineContribution[];
  pinned_ledger_refs: string[];
  proposed_updates: number;
  confirmed_updates: number;
}

export interface TimelinePickup {
  at: string;
  actor: string;
  actor_session: string;
  actor_harness: TimelineHarness;
  via: ContributionSource;
  record_id: string;
  record_kind: string;
  record_title: string;
  after: { author: string; session_id: string; at: string; source: ContributionSource }[];
  gap_minutes: number;
  pinned_ledger_refs_on_record: number;
}

export interface Timeline {
  schema: typeof TIMELINE_SCHEMA;
  generated_for: string;
  scope: { kind: "window"; days: number; from: string; to: string } | { kind: "record"; record_id: string; expected: "any" | "investigation" };
  lanes: TimelineLane[];
  shared: TimelineShared[];
  pickups: TimelinePickup[];
  counts: { people: number; sessions: number; records: number; shared_records: number; pickups: number };
  truncated: { sessions: boolean; limit: number };
  caveats: string[];
}

export type TimelineResult = { configured: false; note: string } | { configured: true; timeline: Timeline };

export interface TimelineOptions {
  days?: number;
  recordId?: string;
  investigationId?: string;
  limit?: number;
  now?: Date;
}

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const TITLE_MAX = 110;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Live projection of a record's state updates, matching investigations.ts so counts agree across surfaces. */
const LIVE_UPDATE = `u.status <> 'rejected' and not exists (select 1 from cont_state_updates v where v.record_id = u.record_id and v.supersedes = u.id and v.status = 'confirmed')`;

// ---------- small formatting helpers (local: importing recordpack would pull the classifier in) ----------

/**
 * Shortest prefix that keeps every id in this rendering distinct. Codex session ids are UUIDv7, so
 * sessions minutes apart share their first eight characters; an ambiguous handle on a multiplayer
 * timeline is worse than a long one.
 */
export function shortener(ids: Iterable<string>): (id: string) => string {
  const all = [...new Set(ids)];
  for (const n of [8, 12, 18]) {
    if (new Set(all.map((x) => x.slice(0, n))).size === all.length) return (id) => id.slice(0, n);
  }
  return (id) => id;
}

function clean(s: string | null | undefined, max = TITLE_MAX): string {
  if (!s) return "";
  const t = redactText(String(s)).text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Minute-resolution UTC. No relative phrasing anywhere: it would make two runs differ. */
function utc(d: Date | string | null | undefined): string {
  if (!d) return "unknown time";
  const t = new Date(d);
  return Number.isFinite(t.getTime()) ? t.toISOString().slice(0, 16).replace("T", " ") : "unknown time";
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const t = new Date(d);
  return Number.isFinite(t.getTime()) ? t.toISOString() : null;
}

function minutesBetween(a: string, b: string): number {
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / 60_000);
}

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

const cmp = (a: string | null, b: string | null): number => (a === b ? 0 : a == null ? 1 : b == null ? -1 : a < b ? -1 : 1);

/** "1 session carries" / "3 sessions carry": the caveats read as prose or they do not get read. */
const count = (n: number, noun: string, singularVerb: string, pluralVerb: string): string =>
  `${n} ${noun}${n === 1 ? "" : "s"} ${n === 1 ? singularVerb : pluralVerb}`;

/**
 * Which transcript root the capture helper found this session under. This is the persisted form of
 * safety.ts's `local_transcript` verification, so it is evidence, not a guess about the id's shape.
 */
export function transcriptRoot(transcriptPath: string | null | undefined): "claude" | "codex" | null {
  if (!transcriptPath) return null;
  const p = String(transcriptPath).replace(/\\/g, "/");
  if (p.includes("/.codex/sessions/")) return "codex";
  if (p.includes("/.claude/projects/")) return "claude";
  return null;
}

/**
 * Report the stored harness next to whatever corroborates or contradicts it. Never returns a
 * "real" harness: a disputed row stays disputed until someone fixes the row.
 */
export function harnessOf(stored: string | null | undefined, transcriptPath: string | null | undefined, provenance?: { harness?: string; verified?: boolean } | null): TimelineHarness {
  const value = String(stored ?? "").trim() || "unknown";
  const root = transcriptRoot(transcriptPath);
  const verified = provenance?.verified === true && provenance.harness === value;
  if (value !== "claude" && value !== "codex") {
    return { stored: value, transcript_root: root, confidence: "unknown", label: root ? `harness never established (row says "${value}", capture transcript root says ${root})` : `harness never established (row says "${value}")` };
  }
  if (root && root !== value) {
    return { stored: value, transcript_root: root, confidence: "disputed", label: `stored harness ${value}, disputed by capture transcript root (${root})` };
  }
  if (root === value) return { stored: value, transcript_root: root, confidence: "corroborated", label: `${value} (transcript-corroborated)` };
  if (verified) return { stored: value, transcript_root: null, confidence: "corroborated", label: `${value} (identity-verified at bind)` };
  return { stored: value, transcript_root: null, confidence: "unverified", label: `${value}, unverified (MCP-first binds write this field before any transcript is read)` };
}

// ---------- row shapes ----------

interface SessionRow {
  id: string; author: string; harness: string | null; machine: string | null; cwd: string | null;
  repo: string | null; branch: string | null; thread_id: string | null; transcript_path: string | null;
  started_at: Date | null; last_seen_at: Date | null; ended_at: Date | null;
  identity_provenance: { harness?: string; verified?: boolean } | null;
}
interface EventAggRow { session_id: string; events: number; first_at: Date | null; last_at: Date | null; lag_median: string | null; lag_max: string | null }
interface BindingRow { session_id: string; record_id: string; bound_by: string; bound_at: Date }
interface LinkRow { record_id: string; session_id: string; from_seq: number; to_seq: number; source: string; confidence: number | null; created_by: string; created_at: Date; author: string }
interface RecordRow { id: string; kind: string; title: string; status: string; created_by: string; created_at: Date; touched_repos: string[] | null; ledger_refs: { id: string }[] | null; proposed: number; confirmed: number }

function sessionWhere(s: SessionRow): string {
  if (s.repo) {
    const base = path.basename(s.repo.replace(/\/+$/, "")).replace(/\.git$/, "");
    return `${base || s.repo}${s.branch ? `@${clean(s.branch, 60)}` : ""}`;
  }
  // The full cwd is a home-directory path; its basename names the work without exporting the path.
  if (s.cwd) return `non-repo (${path.basename(s.cwd.replace(/\/+$/, "")) || "unnamed"})`;
  return "no repo recorded";
}

// ---------- build ----------

export async function buildTimeline(pool: pg.Pool, opts: TimelineOptions & { author: string }): Promise<Timeline> {
  const now = opts.now ?? new Date();
  const days = Math.min(Math.max(1, Math.floor(opts.days ?? DEFAULT_DAYS)), 3650);
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const focus = opts.recordId ?? opts.investigationId ?? null;
  if (focus && !UUID_RE.test(focus)) throw new Error(`not a record id: ${focus} (expected the uuid printed by ledger records / ledger investigation list)`);
  const from = new Date(now.getTime() - days * 24 * 3600_000);

  // A focused timeline ignores the window on purpose: "show me everyone who worked this question"
  // is the whole point of --record, and a 7-day default would cut the predecessor off.
  const sessionSql = focus
    ? `select s.*, to_jsonb(s) -> 'identity_provenance' as identity_provenance from cont_sessions s
        where s.id in (select session_id from cont_session_bindings where record_id = $1::uuid
                       union select session_id from cont_record_links where record_id = $1::uuid)
        order by coalesce(s.started_at, s.last_seen_at, s.ended_at) nulls last, s.id limit ${limit + 1}`
    : `select s.*, to_jsonb(s) -> 'identity_provenance' as identity_provenance from cont_sessions s
        where coalesce(s.last_seen_at, s.ended_at, s.started_at) >= $1
        order by coalesce(s.started_at, s.last_seen_at, s.ended_at) nulls last, s.id limit ${limit + 1}`;
  const sessionRows = (await pool.query<SessionRow>(sessionSql, [focus ?? from])).rows;
  const truncated = sessionRows.length > limit;
  const sessions = sessionRows.slice(0, limit);
  const sessionIds = sessions.map((s) => s.id);
  const inWindow = new Set(sessionIds);

  if (focus) {
    const rec = (await pool.query<{ kind: string }>(`select kind from cont_records where id = $1::uuid`, [focus])).rows[0];
    if (!rec) throw new Error(`record not found: ${focus}`);
    if (opts.investigationId && rec.kind !== "investigation") throw new Error(`record ${focus} is a ${rec.kind} record, not an investigation; use --record for it`);
  }

  const [events, bindings, links] = sessionIds.length
    ? await Promise.all([
        pool.query<EventAggRow>(
          `select e.session_id, count(*)::int as events, min(e.occurred_at) as first_at, max(e.occurred_at) as last_at,
                  percentile_disc(0.5) within group (order by extract(epoch from (e.received_at - e.occurred_at)))
                    filter (where e.occurred_at is not null) as lag_median,
                  max(extract(epoch from (e.received_at - e.occurred_at))) filter (where e.occurred_at is not null) as lag_max
             from cont_events e where e.session_id = any($1) group by e.session_id`,
          [sessionIds]
        ),
        pool.query<BindingRow>(`select session_id, record_id, bound_by, bound_at from cont_session_bindings where session_id = any($1)`, [sessionIds]),
        pool.query<LinkRow>(
          `select l.record_id, l.session_id, l.from_seq, l.to_seq, l.source, l.confidence, l.created_by, l.created_at, s.author
             from cont_record_links l join cont_sessions s on s.id = l.session_id where l.session_id = any($1)`,
          [sessionIds]
        ),
      ])
    : [{ rows: [] as EventAggRow[] }, { rows: [] as BindingRow[] }, { rows: [] as LinkRow[] }];

  // Records these sessions touched. Everyone who ever contributed to one is then pulled in, even
  // from outside the window: the person you picked work up from may have finished days earlier.
  const recordIds = [...new Set([...bindings.rows.map((b) => b.record_id), ...links.rows.map((l) => l.record_id), ...(focus ? [focus] : [])])].sort();
  const [allBindings, allLinks, records] = recordIds.length
    ? await Promise.all([
        pool.query<BindingRow>(`select session_id, record_id, bound_by, bound_at from cont_session_bindings where record_id = any($1::uuid[])`, [recordIds]),
        pool.query<LinkRow>(
          `select l.record_id, l.session_id, l.from_seq, l.to_seq, l.source, l.confidence, l.created_by, l.created_at, s.author
             from cont_record_links l join cont_sessions s on s.id = l.session_id where l.record_id = any($1::uuid[])`,
          [recordIds]
        ),
        pool.query<RecordRow>(
          `select r.id, r.kind, r.title, r.status, r.created_by, r.created_at, r.touched_repos, r.ledger_refs,
                  (select count(*) from cont_state_updates u where u.record_id = r.id and u.status = 'proposed' and ${LIVE_UPDATE})::int as proposed,
                  (select count(*) from cont_state_updates u where u.record_id = r.id and u.status = 'confirmed' and ${LIVE_UPDATE})::int as confirmed
             from cont_records r where r.id = any($1::uuid[])`,
          [recordIds]
        ),
      ])
    : [{ rows: [] as BindingRow[] }, { rows: [] as LinkRow[] }, { rows: [] as RecordRow[] }];

  const recordById = new Map(records.rows.map((r) => [r.id, r]));
  const eventsBy = new Map(events.rows.map((e) => [e.session_id, e]));
  const titleOf = (id: string) => clean(recordById.get(id)?.title) || `(record ${id.slice(0, 8)} is not readable from here)`;
  const kindOf = (id: string) => recordById.get(id)?.kind ?? "record";

  // ---- sessions -> lanes ----
  const built: TimelineSession[] = sessions.map((s) => {
    const agg = eventsBy.get(s.id);
    const binds: TimelineBind[] = [];
    for (const b of bindings.rows.filter((x) => x.session_id === s.id)) {
      binds.push({ at: iso(b.bound_at)!, record_id: b.record_id, record_kind: kindOf(b.record_id), record_title: titleOf(b.record_id), source: "binding", bound_by: b.bound_by, from_seq: null, to_seq: null });
    }
    for (const l of links.rows.filter((x) => x.session_id === s.id && x.source === "explicit")) {
      // A binding always writes its own explicit span; showing both would double-count one act.
      if (binds.some((b) => b.record_id === l.record_id && b.source === "binding")) continue;
      binds.push({ at: iso(l.created_at)!, record_id: l.record_id, record_kind: kindOf(l.record_id), record_title: titleOf(l.record_id), source: "explicit-link", bound_by: l.created_by, from_seq: l.from_seq, to_seq: l.to_seq });
    }
    binds.sort((a, b) => cmp(a.at, b.at) || a.record_id.localeCompare(b.record_id));
    const grouped = new Map<string, TimelineSuggestedLink>();
    for (const l of links.rows.filter((x) => x.session_id === s.id && x.source === "suggested")) {
      const at = iso(l.created_at)!;
      const g = grouped.get(l.record_id);
      if (!g) grouped.set(l.record_id, { record_id: l.record_id, record_title: titleOf(l.record_id), links: 1, first_at: at, last_at: at, max_confidence: l.confidence });
      else {
        g.links++;
        if (cmp(at, g.first_at) < 0) g.first_at = at;
        if (cmp(at, g.last_at) > 0) g.last_at = at;
        if (l.confidence != null && (g.max_confidence == null || l.confidence > g.max_confidence)) g.max_confidence = l.confidence;
      }
    }
    const suggested = [...grouped.values()].sort((a, b) => cmp(a.first_at, b.first_at) || a.record_id.localeCompare(b.record_id));
    const median = agg?.lag_median == null ? null : Math.round(Number(agg.lag_median) / 60);
    const max = agg?.lag_max == null ? null : Math.round(Number(agg.lag_max) / 60);
    return {
      session_id: s.id,
      author: s.author,
      machine: s.machine,
      harness: harnessOf(s.harness, s.transcript_path, s.identity_provenance),
      repo: s.repo,
      branch: s.branch,
      where: sessionWhere(s),
      thread_id: s.thread_id,
      started_at: iso(s.started_at),
      last_seen_at: iso(s.last_seen_at),
      ended_at: iso(s.ended_at),
      events: agg?.events ?? 0,
      first_event_at: iso(agg?.first_at ?? null),
      last_event_at: iso(agg?.last_at ?? null),
      capture_lag_minutes: median == null || max == null ? null : { median, max },
      binds,
      suggested_links: suggested,
    };
  });

  const laneKey = (s: TimelineSession) => s.started_at ?? s.first_event_at ?? s.last_seen_at;
  const byAuthor = new Map<string, TimelineSession[]>();
  for (const s of built) (byAuthor.get(s.author) ?? byAuthor.set(s.author, []).get(s.author)!).push(s);
  const lanes: TimelineLane[] = [...byAuthor.entries()]
    .map(([author, list]) => {
      list.sort((a, b) => cmp(laneKey(a), laneKey(b)) || a.session_id.localeCompare(b.session_id));
      return { author, machines: [...new Set(list.map((s) => s.machine).filter((m): m is string => Boolean(m)))].sort(), sessions: list };
    })
    .sort((a, b) => cmp(laneKey(a.sessions[0]), laneKey(b.sessions[0])) || a.author.localeCompare(b.author));

  // ---- shared records: every proved contribution, in or out of window ----
  const contributionsFor = (recordId: string): TimelineContribution[] => {
    const out = new Map<string, TimelineContribution>();
    for (const b of allBindings.rows.filter((x) => x.record_id === recordId)) {
      out.set(b.session_id, { at: iso(b.bound_at)!, author: b.bound_by, session_id: b.session_id, source: "binding", in_window: inWindow.has(b.session_id) });
    }
    for (const l of allLinks.rows.filter((x) => x.record_id === recordId && x.source === "explicit")) {
      if (out.has(l.session_id)) continue;
      out.set(l.session_id, { at: iso(l.created_at)!, author: l.author, session_id: l.session_id, source: "explicit-link", in_window: inWindow.has(l.session_id) });
    }
    return [...out.values()].sort((a, b) => cmp(a.at, b.at) || a.session_id.localeCompare(b.session_id));
  };

  const shared: TimelineShared[] = [];
  const pickups: TimelinePickup[] = [];
  const harnessBySession = new Map(built.map((s) => [s.session_id, s.harness]));
  for (const id of recordIds) {
    const rec = recordById.get(id);
    const contributions = contributionsFor(id);
    const authors = [...new Set(contributions.map((c) => c.author))].sort();
    if (rec && authors.length > 1) {
      shared.push({
        record_id: id,
        kind: rec.kind,
        title: clean(rec.title),
        status: rec.status,
        created_by: rec.created_by,
        created_at: iso(rec.created_at)!,
        touched_repos: (rec.touched_repos ?? []).slice().sort(),
        authors,
        contributions,
        pinned_ledger_refs: (rec.ledger_refs ?? []).map((r) => r.id).filter(Boolean).slice().sort(),
        proposed_updates: rec.proposed,
        confirmed_updates: rec.confirmed,
      });
    }
    for (let i = 1; i < contributions.length; i++) {
      const c = contributions[i];
      // A pickup is only a pickup when the lane it lands in is on screen; otherwise there is
      // nothing on this timeline for the reader to connect it to.
      if (!inWindow.has(c.session_id)) continue;
      const earlierOthers = contributions.slice(0, i).filter((p) => p.author !== c.author);
      if (!earlierOthers.length) continue;
      const nearest = earlierOthers[earlierOthers.length - 1];
      pickups.push({
        at: c.at,
        actor: c.author,
        actor_session: c.session_id,
        actor_harness: harnessBySession.get(c.session_id) ?? harnessOf(null, null),
        via: c.source,
        record_id: id,
        record_kind: rec?.kind ?? "record",
        record_title: titleOf(id),
        after: earlierOthers.map((p) => ({ author: p.author, session_id: p.session_id, at: p.at, source: p.source })),
        gap_minutes: minutesBetween(c.at, nearest.at),
        pinned_ledger_refs_on_record: (rec?.ledger_refs ?? []).length,
      });
    }
  }
  shared.sort((a, b) => cmp(a.contributions[0]?.at ?? null, b.contributions[0]?.at ?? null) || a.record_id.localeCompare(b.record_id));
  pickups.sort((a, b) => cmp(a.at, b.at) || a.actor_session.localeCompare(b.actor_session));

  return {
    schema: TIMELINE_SCHEMA,
    generated_for: opts.author,
    scope: focus ? { kind: "record", record_id: focus, expected: opts.investigationId ? "investigation" : "any" } : { kind: "window", days, from: from.toISOString(), to: now.toISOString() },
    lanes,
    shared,
    pickups,
    counts: { people: lanes.length, sessions: built.length, records: recordIds.length, shared_records: shared.length, pickups: pickups.length },
    truncated: { sessions: truncated, limit },
    caveats: caveatsFor(built, shared),
  };
}

/** Only the defects this particular rendering can actually exhibit, so the footer stays worth reading. */
function caveatsFor(sessions: TimelineSession[], shared: TimelineShared[]): string[] {
  const out: string[] = [];
  const disputed = sessions.filter((s) => s.harness.confidence === "disputed").length;
  const unverified = sessions.filter((s) => s.harness.confidence === "unverified" || s.harness.confidence === "unknown").length;
  if (disputed) out.push(`${count(disputed, "session", "carries", "carry")} a harness the capture transcript root contradicts. cont_sessions.harness is written at MCP-first bind time, before any transcript is read, so Codex sessions can be stored as "claude". Both values are shown; neither is corrected here.`);
  if (unverified) out.push(`${count(unverified, "session", "has", "have")} a harness nothing corroborates (no transcript root recorded yet). Read those harness values as unconfirmed.`);
  const lagged = sessions.filter((s) => (s.capture_lag_minutes?.median ?? 0) >= 5);
  if (lagged.length) {
    const worst = Math.max(...lagged.map((s) => s.capture_lag_minutes!.median));
    out.push(`Capture lags: ${count(lagged.length, "session", "shows", "show")} a median arrival delay of 5m or more (worst median ${duration(worst)}, received_at minus occurred_at). Ordering within a lane follows when the work happened, not when the rows landed.`);
  }
  const empty = sessions.filter((s) => s.events === 0).length;
  if (empty) out.push(`${count(empty, "session", "has", "have")} zero captured events. That is a real row with no content, not a failure, and nothing is claimed about what happened in them.`);
  const suggested = sessions.reduce((n, s) => n + s.suggested_links.reduce((m, l) => m + l.links, 0), 0);
  if (suggested) out.push(`${count(suggested, "classifier-suggested link", "is", "are")} shown labelled (collapsed per record) and NOT counted as a pickup. Suggested and PROPOSED are the classifier's output, never a decision.`);
  const refs = shared.reduce((n, r) => n + r.pinned_ledger_refs.length, 0);
  if (refs) out.push(`Pinned ledger refs are recorded on the record, not on the session that produced them; which person recorded each one lives in the git ledger, not in these tables.`);
  out.push(`Adjacency is drawn only from cont_session_bindings rows and explicit cont_record_links spans. Two people working the same question without either is not shown, because nothing here proves it.`);
  return out;
}

// ---------- render ----------

export function renderTimeline(t: Timeline): string {
  const out: string[] = [];
  const sid = shortener([
    ...t.lanes.flatMap((l) => l.sessions.map((s) => s.session_id)),
    ...t.shared.flatMap((r) => r.contributions.map((c) => c.session_id)),
    ...t.pickups.flatMap((p) => [p.actor_session, ...p.after.map((a) => a.session_id)]),
  ]);
  const rid = shortener([
    ...t.lanes.flatMap((l) => l.sessions.flatMap((s) => [...s.binds.map((b) => b.record_id), ...s.suggested_links.map((x) => x.record_id)])),
    ...t.shared.map((r) => r.record_id),
    ...t.pickups.map((p) => p.record_id),
  ]);
  const head = t.scope.kind === "record"
    ? `Multiplayer timeline — record ${t.scope.record_id}`
    : `Multiplayer timeline — ${utc(t.scope.from)} to ${utc(t.scope.to)} UTC (${t.scope.days} day${t.scope.days === 1 ? "" : "s"})`;
  out.push(head);
  out.push(`${t.counts.people} ${t.counts.people === 1 ? "person" : "people"} · ${t.counts.sessions} session${t.counts.sessions === 1 ? "" : "s"} · ${t.counts.shared_records} shared record${t.counts.shared_records === 1 ? "" : "s"} · ${t.counts.pickups} cross-person pickup${t.counts.pickups === 1 ? "" : "s"}`);
  out.push(`Times are UTC, minute resolution. Every timestamp is when the row says the thing happened.`);
  if (t.truncated.sessions) out.push(`Truncated at ${t.truncated.limit} sessions; raise --limit to see the rest.`);

  if (!t.lanes.length) {
    out.push(``);
    out.push(t.scope.kind === "record" ? `No session has ever bound or been explicitly linked to this record.` : `No captured sessions in this window.`);
  }

  for (const lane of t.lanes) {
    out.push(``);
    out.push(`${lane.author} · ${lane.sessions.length} session${lane.sessions.length === 1 ? "" : "s"} · ${lane.machines.length ? `machine${lane.machines.length === 1 ? "" : "s"} ${lane.machines.join(", ")}` : "machine not recorded"}`);
    for (const s of lane.sessions) {
      out.push(`  ${utc(s.started_at ?? s.first_event_at)}  session ${sid(s.session_id)} · ${s.harness.label} · ${s.where}`);
      const span = s.events
        ? `${s.events} event${s.events === 1 ? "" : "s"}, ${utc(s.first_event_at)} → ${utc(s.last_event_at)}${s.capture_lag_minutes ? ` · arrival delay median ${duration(s.capture_lag_minutes.median)}, max ${duration(s.capture_lag_minutes.max)}` : ""}`
        : `no events captured (row exists, content does not)`;
      // The session row can outlive its last captured event; say so rather than implying it went quiet.
      const alive = s.last_seen_at && s.last_event_at && minutesBetween(s.last_seen_at, s.last_event_at) > 60 ? ` · last seen ${utc(s.last_seen_at)}` : "";
      out.push(`                    ${span}${alive}`);
      // Proved binds and labelled suggestions interleave by time: a lane has to read chronologically
      // or the reader cannot tell which came first.
      const marks: { at: string; key: string; line: string }[] = [];
      for (const b of s.binds) {
        const how = b.source === "binding" ? `bound` : `linked (explicit span ${b.from_seq}..${b.to_seq})`;
        marks.push({ at: b.at, key: b.record_id, line: `    ${utc(b.at)}  ${how} → ${b.record_kind} ${rid(b.record_id)} "${b.record_title}"` });
      }
      for (const l of s.suggested_links) {
        const when = l.first_at === l.last_at ? utc(l.first_at) : `${utc(l.first_at)} → ${utc(l.last_at)}`;
        marks.push({ at: l.first_at, key: l.record_id, line: `    ${when}  ${l.links} suggested link${l.links === 1 ? "" : "s"} → ${rid(l.record_id)} "${l.record_title}"${l.max_confidence == null ? "" : ` (confidence up to ${l.max_confidence.toFixed(2)})`} — classifier output, not decided` });
      }
      marks.sort((a, b) => cmp(a.at, b.at) || a.key.localeCompare(b.key));
      for (const m of marks) out.push(m.line);
    }
  }

  if (t.shared.length) {
    out.push(``);
    out.push(`Shared work`);
    for (const r of t.shared) {
      out.push(`- ${r.kind} ${rid(r.record_id)} "${r.title}" · opened by ${r.created_by} ${utc(r.created_at)} · ${r.status}`);
      out.push(`  ${r.authors.length} people: ${r.contributions.map((c) => `${c.author} (${sid(c.session_id)}, ${utc(c.at)}${c.in_window ? "" : ", outside this view"})`).join(" → ")}`);
      if (r.pinned_ledger_refs.length) {
        const shown = r.pinned_ledger_refs.slice(0, 3).join(", ");
        out.push(`  ${r.pinned_ledger_refs.length} pinned ledger ref${r.pinned_ledger_refs.length === 1 ? "" : "s"}: ${shown}${r.pinned_ledger_refs.length > 3 ? ` (+${r.pinned_ledger_refs.length - 3} more)` : ""}`);
      }
      out.push(`  ${r.proposed_updates} proposed / ${r.confirmed_updates} confirmed state updates${r.proposed_updates ? " — PROPOSED is the classifier's, not decided" : ""}`);
    }
  }

  if (t.pickups.length) {
    out.push(``);
    out.push(`Picked up`);
    for (const p of t.pickups) {
      const nearest = p.after[p.after.length - 1];
      out.push(`- ${utc(p.at)}  ${p.actor}'s session ${sid(p.actor_session)} ${p.via === "binding" ? "bound to" : "was explicitly linked to"} ${p.record_kind} ${rid(p.record_id)} "${p.record_title}",`);
      out.push(`  ${duration(Math.abs(p.gap_minutes))} after ${nearest.author}'s session ${sid(nearest.session_id)} (${utc(nearest.at)})${p.after.length > 1 ? `, and after ${p.after.length - 1} earlier contribution${p.after.length === 2 ? "" : "s"}` : ""}.`);
      out.push(`  Proof: ${p.via === "binding" ? "cont_session_bindings" : "cont_record_links source=explicit"} rows for both sessions on the same record.`);
      out.push(`  Harness of ${p.actor}'s session: ${p.actor_harness.label}.`);
      if (p.pinned_ledger_refs_on_record) out.push(`  Available to reuse: ${p.pinned_ledger_refs_on_record} ledger ref${p.pinned_ledger_refs_on_record === 1 ? "" : "s"} pinned on the record.`);
    }
  } else if (t.lanes.length) {
    out.push(``);
    out.push(`Picked up`);
    out.push(`- none proved in this view. A pickup is only drawn from a binding or an explicit record link; nothing weaker is treated as adjacency.`);
  }

  if (t.caveats.length) {
    out.push(``);
    out.push(`Read this honestly`);
    for (const c of t.caveats) out.push(`- ${c}`);
  }
  return out.join("\n");
}

// ---------- entry point ----------

export async function timelineResult(cfg: Config, opts: TimelineOptions = {}): Promise<TimelineResult> {
  if (!continuityConfigured(cfg)) return { configured: false, note: TIMELINE_UNCONFIGURED };
  return { configured: true, timeline: await buildTimeline(getPool(cfg), { ...opts, author: cfg.author }) };
}

export function renderTimelineResult(r: TimelineResult, json = false): string {
  if (!r.configured) return json ? JSON.stringify({ schema: TIMELINE_SCHEMA, configured: false, note: r.note }, null, 2) : r.note;
  return json ? JSON.stringify(r.timeline, null, 2) : renderTimeline(r.timeline);
}
