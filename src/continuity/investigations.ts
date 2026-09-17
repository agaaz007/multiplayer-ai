import type pg from "pg";
import path from "node:path";
import type { Config } from "../store.js";
// Title matching lives in query.ts with the rest of the text similarity, so the classifier can reach it
// without importing this module: investigations -> recordpack -> classify is already a cycle.
import { matchScore, normalizeTitle, titleSimilarity } from "../query.js";
export { matchScore, normalizeTitle, titleSimilarity };
import { createRecord, getRecord, linkSpan } from "./records.js";
import { upsertSession } from "./store.js";
import { ago } from "./recordpack.js";

/**
 * Investigations: the analysis-session counterpart of a thread binding.
 *
 * Decision in force (dec-20260917-multi-pm-continuity-bind-or-new-at-session-start-u44f): an analysis session
 * resolves its scope at session start to an existing open `investigation` work record, or declares a new
 * question, before it runs data queries. Repo is optional: several investigations share one repo, and much
 * PM work is warehouse SQL or sheets with no checkout at all, so a "thread on this repo" is the wrong unit.
 *
 * Storage: cont_session_bindings (session → record, one row per session) plus one EXPLICIT cont_record_links
 * span per binding, noted "bound by <author>", covering the session from seq 1. The helper extends that span's
 * to_seq each pass (extendBoundLink) so the record accumulates the whole session. The classifier may still
 * add `suggested` links on the same events; explicit ranks above suggested wherever spans overlap
 * (SOURCE_RANK in records.ts), so a binding is never overridden by a suggestion.
 */

type Q = pg.Pool | pg.PoolClient;

export interface InvestigationItem {
  record_id: string;
  title: string;
  goal: string | null;
  repo: string | null;
  status: string;
  created_by: string;
  updated_at: string;
  proposed: number;
  confirmed: number;
  bound_sessions: number;
  /** lexical match of `q` against title + goal + confirmed state text, 0..1; 0 when no `q` */
  match: number;
}

const TITLE_MAX = 140;
/** Title-token coverage, both directions, for the declare-time refusal. Not the ledger-object measure in query.ts: this compares two investigation titles, not two recorded questions, and 0.9 means each title covers nine tenths of the other's tokens. */
const NEAR_IDENTICAL_TITLE = 0.9;
const BOUND_NOTE_PREFIX = "bound by ";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Confirmed state text is part of the document; a superseded or rejected update is not current state. */
const LIVE = `u.status <> 'rejected' and not exists (select 1 from cont_state_updates v where v.record_id = u.record_id and v.supersedes = u.id and v.status = 'confirmed')`;

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function harnessGuess(): string {
  return process.env.CODEX_THREAD_ID ? "codex" : "claude";
}

const BIND_INSTRUCTION = `Bind this session to one with ledger_investigation_bind(record_id) or declare a new question with ledger_investigation_new(question); non-repo work is fine. Do not proceed as just a thread on this repo.`;

export function investigationLine(it: InvestigationItem, now = new Date()): string {
  const where = it.repo ? path.basename(it.repo) : "non-repo";
  return `- ${it.title} · ${it.created_by} · updated ${ago(it.updated_at, now)} · ${it.proposed}/${it.confirmed} updates · ${it.bound_sessions} bound session${it.bound_sessions === 1 ? "" : "s"} · ${where} · ${it.record_id}`;
}

async function openInvestigationRows(q: Q, opts: { author?: string; hours?: number; cap?: number } = {}): Promise<(InvestigationItem & { state_text: string })[]> {
  const params: unknown[] = [];
  const where = [`r.kind = 'investigation'`, `r.status = 'open'`];
  if (opts.author) { params.push(opts.author); where.push(`r.created_by = $${params.length}`); }
  if (opts.hours != null && Number.isFinite(opts.hours) && opts.hours > 0) { params.push(opts.hours); where.push(`r.updated_at > now() - ($${params.length}::float8 * interval '1 hour')`); }
  const cap = Math.min(Math.max(1, Math.floor(opts.cap ?? 200)), 500);
  const r = await q.query<{ record_id: string; title: string; goal: string | null; repo: string | null; status: string; created_by: string; updated_at: Date; proposed: number; confirmed: number; bound_sessions: number; state_text: string }>(
    `select r.id as record_id, r.title, r.goal, r.repo, r.status, r.created_by, r.updated_at,
            (select count(*) from cont_state_updates u where u.record_id = r.id and u.status = 'proposed' and ${LIVE})::int as proposed,
            (select count(*) from cont_state_updates u where u.record_id = r.id and u.status = 'confirmed' and ${LIVE})::int as confirmed,
            (select count(*) from cont_session_bindings b where b.record_id = r.id)::int as bound_sessions,
            coalesce((select string_agg(u.text, ' ' order by u.created_at) from cont_state_updates u where u.record_id = r.id and u.status = 'confirmed' and ${LIVE}), '') as state_text
       from cont_records r
      where ${where.join(" and ")}
      order by r.updated_at desc, r.id
      limit ${cap}`,
    params
  );
  return r.rows.map((x) => ({ ...x, updated_at: new Date(x.updated_at).toISOString(), match: 0 }));
}

/**
 * Open investigation records across ALL repos, repo-null included. With `q`, ranked by lexical match against
 * title + goal + confirmed state text, then updated_at desc; without it, updated_at desc.
 */
export async function listInvestigations(pool: pg.Pool, cfg: Config, opts: { q?: string; author?: string; hours?: number; limit?: number }): Promise<{ text: string; items: InvestigationItem[] }> {
  void cfg;
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 20)), 100);
  const rows = await openInvestigationRows(pool, { author: opts.author, hours: opts.hours });
  const q = opts.q?.trim();
  const scored = rows.map((r) => ({ ...r, match: q ? matchScore(q, r.title, `${r.goal ?? ""} ${r.state_text}`) : 0 }));
  scored.sort((a, b) => b.match - a.match || (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0) || a.record_id.localeCompare(b.record_id));
  const items: InvestigationItem[] = scored.slice(0, limit).map(({ state_text: _s, ...it }) => it);
  const now = new Date();
  const head = items.length
    ? `Open investigations (${items.length}${rows.length > items.length ? ` of ${rows.length}` : ""}, all repos${q ? `, ranked by match to "${clip(q, 80)}"` : ""}):`
    : `No open investigations${q ? ` match "${clip(q, 80)}"` : ""}${opts.author ? ` by ${opts.author}` : ""}${opts.hours ? ` in the last ${opts.hours}h` : ""}.`;
  const lines = [head, ...items.map((it) => `${investigationLine(it, now)}${q ? ` · match ${it.match.toFixed(2)}` : ""}`), BIND_INSTRUCTION];
  return { text: lines.join("\n"), items };
}

async function maxSeq(q: Q, session_id: string): Promise<number> {
  const r = await q.query<{ m: number }>(`select coalesce(max(seq), 0)::int as m from cont_events where session_id = $1`, [session_id]);
  return r.rows[0]?.m ?? 0;
}

/**
 * Attach a session to an open investigation. Idempotent for the same record. A rebind to another record keeps the
 * earlier explicit span (those events did belong to the earlier investigation) and starts a new one at the current
 * seq; only the newest bound span is extended by the helper from then on.
 */
export async function bindInvestigation(pool: pg.Pool, cfg: Config, opts: { record_id: string; session_id: string; question?: string }): Promise<{ text: string; record_id: string; title: string; already_bound: boolean }> {
  const session_id = String(opts.session_id ?? "").trim();
  if (!session_id) throw new Error("session_id is required to bind an investigation");
  if (!UUID_RE.test(String(opts.record_id ?? ""))) throw new Error(`record not found: ${String(opts.record_id)} (expected a record id from ledger_investigations)`);
  const rec = await getRecord(pool, opts.record_id);
  if (!rec) throw new Error(`record not found: ${opts.record_id}`);
  if (rec.kind !== "investigation") throw new Error(`record ${rec.id} is a ${rec.kind} record, not an investigation; declare one with ledger_investigation_new or pick one from ledger_investigations`);
  if (rec.status !== "open") throw new Error(`investigation ${rec.id} is ${rec.status}, not open; pick an open one from ledger_investigations or declare a new question`);

  // The helper may not have uploaded this session yet; the link needs the session row to exist.
  await upsertSession(pool, { id: session_id, author: cfg.author, harness: harnessGuess(), machine: cfg.continuity?.machine ?? null });
  const existing = await sessionBinding(pool, session_id);
  const already_bound = existing?.record_id === rec.id;
  const question = opts.question?.trim() || null;
  if (already_bound) {
    if (question && question !== existing!.question) await pool.query(`update cont_session_bindings set question = $2 where session_id = $1`, [session_id, question]);
    return { text: `Session ${session_id.slice(0, 8)} is already bound to investigation "${rec.title}" (${rec.id}). Continue; data queries accumulate on it.`, record_id: rec.id, title: rec.title, already_bound: true };
  }
  await pool.query(
    `insert into cont_session_bindings (session_id, record_id, question, bound_by) values ($1, $2, $3, $4)
     on conflict (session_id) do update set record_id = excluded.record_id, question = coalesce(excluded.question, cont_session_bindings.question), bound_by = excluded.bound_by, bound_at = now()`,
    [session_id, rec.id, question, cfg.author]
  );
  const m = await maxSeq(pool, session_id);
  // explicit beats suggested: an agent's or person's binding outranks whatever the classifier proposes on the same events
  const from = existing ? Math.max(1, m) : 1;
  const to = Math.max(from, m);
  await linkSpan(pool, { record_id: rec.id, session_id, from_seq: from, to_seq: to, source: "explicit", note: `${BOUND_NOTE_PREFIX}${cfg.author}`, created_by: cfg.author });
  const rebound = existing ? ` (rebound from ${existing.record_id})` : "";
  return {
    text: `Bound session ${session_id.slice(0, 8)} to investigation "${rec.title}" (${rec.id})${rebound}. Data queries in this session now accumulate on this record; propose findings at query grain with ledger_propose_finding (the bound investigation is attached automatically).`,
    record_id: rec.id,
    title: rec.title,
    already_bound: false,
  };
}

/**
 * Create an investigation record from a question and bind the session to it. Refuses when an open investigation
 * already carries a near-identical question, naming it so the agent binds instead of forking the same work.
 */
export async function declareInvestigation(pool: pg.Pool, cfg: Config, opts: { question: string; goal?: string; session_id: string; repo?: string | null }): Promise<{ text: string; record_id: string }> {
  const question = String(opts.question ?? "").replace(/\s+/g, " ").trim();
  if (!question) throw new Error("question is required to declare an investigation");
  const title = question.length > TITLE_MAX ? question.slice(0, TITLE_MAX - 1) + "…" : question;
  const open = await openInvestigationRows(pool, { cap: 500 });
  const dup = open.map((r) => ({ r, s: titleSimilarity(title, r.title) })).filter((x) => x.s >= NEAR_IDENTICAL_TITLE).sort((a, b) => b.s - a.s)[0];
  if (dup) {
    throw new Error(`An open investigation with a near-identical question already exists: "${dup.r.title}" (${dup.r.record_id}, by ${dup.r.created_by}, match ${dup.s.toFixed(2)}). Bind to it with ledger_investigation_bind(record_id: "${dup.r.record_id}") instead of declaring a new one; if the question is genuinely different, reword it so the difference is in the title.`);
  }
  const rec = await createRecord(pool, { kind: "investigation", title, goal: opts.goal?.trim() || null, repo: opts.repo ?? null, created_by: cfg.author });
  const bound = await bindInvestigation(pool, cfg, { record_id: rec.id, session_id: opts.session_id, question });
  return {
    text: `Declared investigation "${rec.title}" (${rec.id})${rec.repo ? ` on ${path.basename(rec.repo)}` : " as non-repo work"}${rec.goal ? `; goal: ${clip(rec.goal, 120)}` : ""}. ${bound.text}`,
    record_id: rec.id,
  };
}

export async function sessionBinding(pool: pg.Pool, session_id: string): Promise<{ record_id: string; question: string | null; bound_by: string; bound_at: string } | null> {
  const sid = String(session_id ?? "").trim();
  if (!sid) return null;
  const r = await pool.query<{ record_id: string; question: string | null; bound_by: string; bound_at: Date }>(
    `select record_id, question, bound_by, bound_at from cont_session_bindings where session_id = $1`,
    [sid]
  );
  const row = r.rows[0];
  return row ? { record_id: row.record_id, question: row.question, bound_by: row.bound_by, bound_at: new Date(row.bound_at).toISOString() } : null;
}

/**
 * Helper step, once per pass per bound session: move the newest "bound by" explicit span's to_seq up to the
 * session's current max seq so the investigation accumulates the whole session. One UPDATE; the record's
 * updated_at moves in the same statement when the span grew. Returns true when the span was extended.
 */
export async function extendBoundLink(pool: Q, session_id: string): Promise<boolean> {
  const r = await pool.query(
    `with b as (select record_id from cont_session_bindings where session_id = $1),
          m as (select coalesce(max(seq), 0)::int as max_seq from cont_events where session_id = $1),
          target as (
            select l.id from cont_record_links l, b
             where l.session_id = $1 and l.record_id = b.record_id and l.source = 'explicit' and l.note like $2
             order by l.created_at desc, l.id desc limit 1
          ),
          upd as (
            update cont_record_links l set to_seq = m.max_seq
              from m, target
             where l.id = target.id and m.max_seq > l.to_seq
            returning l.record_id
          )
     update cont_records r set updated_at = now() from upd where r.id = upd.record_id returning r.id`,
    [session_id, `${BOUND_NOTE_PREFIX}%`]
  );
  return (r.rowCount ?? 0) > 0;
}

/** All sessions with a binding, for the helper's per-pass extension step. */
export async function boundSessionIds(pool: Q): Promise<string[]> {
  const r = await pool.query<{ session_id: string }>(`select session_id from cont_session_bindings order by bound_at`);
  return r.rows.map((x) => x.session_id);
}
