import type pg from "pg";
import type { NormEvent } from "./events.js";

/**
 * Continuity store: the six tables in db.ts, plus notifications. Every rule
 * from spec §4.1 and §6 lives here so the daemon and the plugin cannot
 * disagree about them:
 *
 *   - thread generation is monotonic and only a claim increments it
 *   - a checkpoint advances the head only if its session holds the live claim
 *     AND its generation equals the thread's current generation
 *   - a stale-generation session is routed to a fork; historical events keep
 *     their original thread_id
 */

export interface SessionRow {
  id: string; thread_id: string | null; author: string; harness: string; machine: string | null;
  cwd: string | null; repo: string | null; branch: string | null; transcript_path: string | null;
  started_at: Date | null; last_seen_at: Date | null; ended_at: Date | null; transcript_offset: string | number;
  coverage: Record<string, unknown>; last_verified_snapshot_at: Date | null; last_acked_event_at: Date | null;
  diverged_at_seq: number | null; fork_thread_id: string | null; base_commit: string | null; wip_ref: string | null; wip_commit: string | null;
  claim_generation: number | null;
}
export interface ThreadRow {
  id: string; repo: string; branch: string | null; title: string; goal: string | null; created_by: string; status: string;
  generation: number; head_checkpoint_id: string | null; forked_from_thread_id: string | null; forked_at_checkpoint_id: string | null;
  created_at: Date; updated_at: Date;
}
export interface ClaimRow { thread_id: string; holder_session_id: string; holder_author: string; generation: number; acquired_at: Date; heartbeat_at: Date; expires_at: Date; released_at: Date | null }
export interface CheckpointRow {
  id: string; thread_id: string; session_id: string; generation: number; kind: string; through_event_seq: number;
  base_commit: string | null; wip_ref: string | null; wip_commit: string | null; verified_snapshot_at: Date | null; verified_events_at: Date | null;
  structured_state: Record<string, any>; narrative: string | null; narrative_status: string; capture_gaps: any[]; advanced_head: boolean; created_at: Date;
}
export interface EventRow { id: string; session_id: string; seq: number; producer_event_id: string; call_id: string | null; thread_id: string | null; kind: string; occurred_at: Date | null; received_at: Date; generation: number | null; payload: Record<string, any> }

export interface ThreadSummary extends ThreadRow {
  claim: ClaimRow | null;
  last_session: Pick<SessionRow, "id" | "author" | "harness" | "machine" | "branch" | "last_seen_at" | "ended_at" | "last_verified_snapshot_at" | "wip_ref" | "wip_commit"> | null;
  head: Pick<CheckpointRow, "id" | "kind" | "created_at" | "wip_commit" | "verified_snapshot_at"> | null;
  first_instruction: string | null;
  last_message: string | null;
}

type Q = pg.Pool | pg.PoolClient;

// ---------- sessions ----------

export async function upsertSession(q: Q, s: { id: string; author: string; harness: string; machine?: string | null; cwd?: string | null; repo?: string | null; branch?: string | null; transcript_path?: string | null; started_at?: Date | string | null; last_seen_at?: Date | string | null }): Promise<SessionRow> {
  const r = await q.query<SessionRow>(
    `insert into cont_sessions (id, author, harness, machine, cwd, repo, branch, transcript_path, started_at, last_seen_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10, now()))
     on conflict (id) do update set
       machine = coalesce(excluded.machine, cont_sessions.machine),
       cwd = coalesce(excluded.cwd, cont_sessions.cwd),
       repo = coalesce(excluded.repo, cont_sessions.repo),
       branch = coalesce(excluded.branch, cont_sessions.branch),
       transcript_path = coalesce(excluded.transcript_path, cont_sessions.transcript_path),
       started_at = coalesce(cont_sessions.started_at, excluded.started_at),
       last_seen_at = greatest(cont_sessions.last_seen_at, excluded.last_seen_at)
     returning *`,
    [s.id, s.author, s.harness, s.machine ?? null, s.cwd ?? null, s.repo ?? null, s.branch ?? null, s.transcript_path ?? null, s.started_at ?? null, s.last_seen_at ?? null]
  );
  return r.rows[0];
}

export async function getSession(q: Q, id: string): Promise<SessionRow | null> {
  const r = await q.query<SessionRow>(`select * from cont_sessions where id = $1`, [id]);
  return r.rows[0] ?? null;
}

const SESSION_PATCH_KEYS = new Set(["thread_id", "cwd", "repo", "branch", "last_seen_at", "ended_at", "transcript_offset", "coverage", "last_verified_snapshot_at", "last_acked_event_at", "base_commit", "wip_ref", "wip_commit", "claim_generation", "diverged_at_seq", "fork_thread_id"]);
export async function updateSession(q: Q, id: string, patch: Partial<Record<string, unknown>>): Promise<void> {
  const keys = Object.keys(patch).filter((k) => SESSION_PATCH_KEYS.has(k));
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await q.query(`update cont_sessions set ${sets} where id = $1`, [id, ...keys.map((k) => (k === "coverage" ? JSON.stringify(patch[k]) : patch[k]))]);
}

// ---------- events ----------

export async function appendEvents(pool: pg.Pool, sessionId: string, events: NormEvent[], threadId: string | null, generation: number | null): Promise<{ inserted: number; lastSeq: number }> {
  if (!events.length) {
    const r = await pool.query<{ m: number }>(`select coalesce(max(seq),0)::int as m from cont_events where session_id = $1`, [sessionId]);
    return { inserted: 0, lastSeq: r.rows[0].m };
  }
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`select id from cont_sessions where id = $1 for update`, [sessionId]);
    const existing = await c.query<{ producer_event_id: string }>(`select producer_event_id from cont_events where session_id = $1 and producer_event_id = any($2)`, [sessionId, events.map((e) => e.producer_event_id)]);
    const have = new Set(existing.rows.map((x) => x.producer_event_id));
    const fresh = events.filter((e) => !have.has(e.producer_event_id));
    const m = await c.query<{ m: number }>(`select coalesce(max(seq),0)::int as m from cont_events where session_id = $1`, [sessionId]);
    let seq = m.rows[0].m;
    for (const e of fresh) {
      seq++;
      await c.query(
        `insert into cont_events (session_id, seq, producer_event_id, call_id, thread_id, kind, occurred_at, generation, payload)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (session_id, producer_event_id) do nothing`,
        [sessionId, seq, e.producer_event_id, e.call_id ?? null, threadId, e.kind, e.occurred_at ?? null, generation, JSON.stringify(e.payload)]
      );
    }
    await c.query(`update cont_sessions set last_acked_event_at = now() where id = $1`, [sessionId]);
    await c.query("commit");
    return { inserted: fresh.length, lastSeq: seq };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function sessionEvents(q: Q, sessionId: string, opts: { kinds?: string[]; limit?: number; afterSeq?: number } = {}): Promise<EventRow[]> {
  const params: unknown[] = [sessionId];
  let where = `session_id = $1`;
  if (opts.kinds?.length) { params.push(opts.kinds); where += ` and kind = any($${params.length})`; }
  if (opts.afterSeq != null) { params.push(opts.afterSeq); where += ` and seq > $${params.length}`; }
  const r = await q.query<EventRow>(`select * from cont_events where ${where} order by seq ${opts.limit ? `desc limit ${Number(opts.limit)}` : "asc"}`, params);
  return opts.limit ? r.rows.reverse() : r.rows;
}

export async function threadEvents(q: Q, threadId: string, opts: { kinds?: string[]; limit?: number } = {}): Promise<EventRow[]> {
  const params: unknown[] = [threadId];
  let where = `thread_id = $1`;
  if (opts.kinds?.length) { params.push(opts.kinds); where += ` and kind = any($${params.length})`; }
  const r = await q.query<EventRow>(`select * from cont_events where ${where} order by id ${opts.limit ? `desc limit ${Number(opts.limit)}` : "asc"}`, params);
  return opts.limit ? r.rows.reverse() : r.rows;
}

/** tool.requested with no tool.finished for the same call_id in the same session. */
export async function pendingOperations(q: Q, sessionId: string): Promise<{ call_id: string; tool: string; input: string; seq: number; occurred_at: Date | null }[]> {
  const r = await q.query(
    `select a.call_id, a.payload->>'tool' as tool, a.payload->>'input' as input, a.seq, a.occurred_at
       from cont_events a
      where a.session_id = $1 and a.kind = 'tool.requested'
        and not exists (select 1 from cont_events b where b.session_id = a.session_id and b.call_id = a.call_id and b.kind = 'tool.finished')
      order by a.seq`,
    [sessionId]
  );
  return r.rows;
}

// ---------- threads ----------

export async function createThread(q: Q, t: { repo: string; branch?: string | null; title: string; goal?: string | null; created_by: string; forked_from_thread_id?: string | null; forked_at_checkpoint_id?: string | null }): Promise<ThreadRow> {
  const r = await q.query<ThreadRow>(
    `insert into cont_threads (repo, branch, title, goal, created_by, forked_from_thread_id, forked_at_checkpoint_id) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [t.repo, t.branch ?? null, t.title.slice(0, 140), t.goal ?? null, t.created_by, t.forked_from_thread_id ?? null, t.forked_at_checkpoint_id ?? null]
  );
  return r.rows[0];
}

export async function getThread(q: Q, id: string): Promise<ThreadRow | null> {
  const r = await q.query<ThreadRow>(`select * from cont_threads where id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function updateThread(q: Q, id: string, patch: { title?: string; goal?: string; status?: string }): Promise<void> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  await q.query(`update cont_threads set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`, [id, ...keys.map((k) => patch[k])]);
}

/** Own open threads on the same repo and branch, recently active. The only auto-bind candidates (spec §8). */
export async function findOwnOpenThreads(q: Q, repo: string, branch: string | null, author: string, sinceHours = 72): Promise<ThreadRow[]> {
  const r = await q.query<ThreadRow>(
    `select t.* from cont_threads t
      where t.repo = $1 and t.status = 'open' and t.created_by = $2 and ($3::text is null or t.branch is null or t.branch = $3)
        and t.updated_at > now() - ($4 || ' hours')::interval
      order by t.updated_at desc`,
    [repo, author, branch, String(sinceHours)]
  );
  return r.rows;
}

export async function listThreads(q: Q, f: { repo?: string | null; author?: string | null; excludeAuthor?: string | null; sinceHours?: number; status?: string; limit?: number } = {}): Promise<ThreadSummary[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (f.repo) { params.push(f.repo); where.push(`t.repo = $${params.length}`); }
  if (f.author) { params.push(f.author); where.push(`t.created_by = $${params.length}`); }
  if (f.excludeAuthor) { params.push(f.excludeAuthor); where.push(`t.created_by <> $${params.length}`); }
  if (f.status) { params.push(f.status); where.push(`t.status = $${params.length}`); }
  if (f.sinceHours) { params.push(String(f.sinceHours)); where.push(`t.updated_at > now() - ($${params.length} || ' hours')::interval`); }
  const limit = Math.min(Number(f.limit ?? 20), 100);
  const r = await q.query<ThreadRow>(`select t.* from cont_threads t ${where.length ? "where " + where.join(" and ") : ""} order by t.updated_at desc limit ${limit}`, params);
  const out: ThreadSummary[] = [];
  for (const t of r.rows) out.push(await summarizeThread(q, t));
  return out;
}

export async function summarizeThread(q: Q, t: ThreadRow): Promise<ThreadSummary> {
  const claim = await getClaim(q, t.id);
  const ls = await q.query<SessionRow>(`select id, author, harness, machine, branch, last_seen_at, ended_at, last_verified_snapshot_at, wip_ref, wip_commit from cont_sessions where thread_id = $1 order by last_seen_at desc nulls last limit 1`, [t.id]);
  const head = t.head_checkpoint_id ? (await q.query<CheckpointRow>(`select id, kind, created_at, wip_commit, verified_snapshot_at from cont_checkpoints where id = $1`, [t.head_checkpoint_id])).rows[0] ?? null : null;
  const fi = await q.query<{ text: string }>(`select payload->>'text' as text from cont_events where thread_id = $1 and kind = 'instruction.added' order by id asc limit 1`, [t.id]);
  const lm = await q.query<{ text: string }>(`select payload->>'text' as text from cont_events where thread_id = $1 and kind = 'assistant.message' order by id desc limit 1`, [t.id]);
  return { ...t, claim, last_session: ls.rows[0] ?? null, head, first_instruction: fi.rows[0]?.text ?? null, last_message: lm.rows[0]?.text ?? null };
}

// ---------- claims ----------

export async function getClaim(q: Q, threadId: string): Promise<ClaimRow | null> {
  const r = await q.query<ClaimRow>(`select * from cont_claims where thread_id = $1 and released_at is null and expires_at > now()`, [threadId]);
  return r.rows[0] ?? null;
}

export async function claimThread(pool: pg.Pool, threadId: string, sessionId: string, author: string, leaseSec = 300): Promise<{ ok: true; generation: number } | { ok: false; holder: ClaimRow }> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const t = await c.query<ThreadRow>(`select * from cont_threads where id = $1 for update`, [threadId]);
    if (!t.rows[0]) throw new Error(`thread not found: ${threadId}`);
    const live = await c.query<ClaimRow>(`select * from cont_claims where thread_id = $1 and released_at is null and expires_at > now()`, [threadId]);
    const cur = live.rows[0];
    if (cur && cur.holder_session_id !== sessionId) {
      await c.query("rollback");
      return { ok: false, holder: cur };
    }
    if (cur && cur.holder_session_id === sessionId) {
      await c.query(`update cont_claims set heartbeat_at = now(), expires_at = now() + ($2 || ' seconds')::interval where thread_id = $1`, [threadId, String(leaseSec)]);
      await c.query("commit");
      return { ok: true, generation: cur.generation };
    }
    const gen = t.rows[0].generation + 1;
    await c.query(`update cont_threads set generation = $2, updated_at = now() where id = $1`, [threadId, gen]);
    await c.query(
      `insert into cont_claims (thread_id, holder_session_id, holder_author, generation, expires_at) values ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)
       on conflict (thread_id) do update set holder_session_id = excluded.holder_session_id, holder_author = excluded.holder_author, generation = excluded.generation,
         acquired_at = now(), heartbeat_at = now(), expires_at = excluded.expires_at, released_at = null`,
      [threadId, sessionId, author, gen, String(leaseSec)]
    );
    await c.query(`update cont_sessions set thread_id = coalesce(thread_id, $2), claim_generation = $3 where id = $1`, [sessionId, threadId, gen]);
    await c.query("commit");
    return { ok: true, generation: gen };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function heartbeatClaim(q: Q, threadId: string, sessionId: string, leaseSec = 300): Promise<boolean> {
  const r = await q.query(`update cont_claims set heartbeat_at = now(), expires_at = now() + ($3 || ' seconds')::interval where thread_id = $1 and holder_session_id = $2 and released_at is null`, [threadId, sessionId, String(leaseSec)]);
  return (r.rowCount ?? 0) > 0;
}

export async function releaseClaim(q: Q, threadId: string, sessionId: string): Promise<boolean> {
  const r = await q.query(`update cont_claims set released_at = now() where thread_id = $1 and holder_session_id = $2 and released_at is null`, [threadId, sessionId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Where a session's uploads go right now, and under which generation. Detects a
 * stale generation (someone else claimed the thread since) and routes the
 * session to a fork, once.
 */
export async function resolveRouting(pool: pg.Pool, sessionId: string): Promise<{ thread_id: string | null; generation: number | null; forked: boolean; fork_thread_id?: string }> {
  const s = await getSession(pool, sessionId);
  if (!s || !s.thread_id) return { thread_id: null, generation: null, forked: false };
  if (s.fork_thread_id) return { thread_id: s.fork_thread_id, generation: null, forked: true, fork_thread_id: s.fork_thread_id };
  const t = await getThread(pool, s.thread_id);
  if (!t) return { thread_id: null, generation: null, forked: false };
  const claim = await getClaim(pool, t.id);
  const mine = claim?.holder_session_id === sessionId;
  if (mine) return { thread_id: t.id, generation: claim!.generation, forked: false };
  // no live claim of ours: if the thread moved past our generation under someone else, fork
  if (s.claim_generation != null && t.generation > s.claim_generation && claim && claim.holder_session_id !== sessionId) {
    const fork = await divergeSession(pool, s, t, claim);
    return { thread_id: fork.id, generation: null, forked: true, fork_thread_id: fork.id };
  }
  return { thread_id: t.id, generation: s.claim_generation, forked: false };
}

export async function divergeSession(pool: pg.Pool, s: SessionRow, t: ThreadRow, claim: ClaimRow): Promise<ThreadRow> {
  const lastCp = await pool.query<CheckpointRow>(`select * from cont_checkpoints where session_id = $1 and thread_id = $2 order by created_at desc limit 1`, [s.id, t.id]);
  const lastSeq = await pool.query<{ m: number }>(`select coalesce(max(seq),0)::int as m from cont_events where session_id = $1`, [s.id]);
  const fork = await createThread(pool, { repo: t.repo, branch: t.branch, title: `${t.title} (${s.author} fork)`, goal: t.goal, created_by: s.author, forked_from_thread_id: t.id, forked_at_checkpoint_id: lastCp.rows[0]?.id ?? null });
  await updateSession(pool, s.id, { fork_thread_id: fork.id, diverged_at_seq: lastSeq.rows[0].m });
  await addNotification(pool, s.author, s.machine, `thread "${t.title}" was continued by ${claim.holder_author} at ${claim.acquired_at.toISOString().slice(11, 16)} UTC; your further work in session ${s.id.slice(0, 8)} is now on fork "${fork.title}" (${fork.id})`);
  return fork;
}

// ---------- checkpoints ----------

export async function publishCheckpoint(pool: pg.Pool, cp: { thread_id: string; session_id: string; generation: number | null; kind: "snapshot" | "turn"; through_event_seq: number; base_commit?: string | null; wip_ref?: string | null; wip_commit?: string | null; verified_snapshot_at?: Date | string | null; verified_events_at?: Date | string | null; structured_state?: Record<string, unknown>; narrative?: string | null; narrative_status?: string; capture_gaps?: unknown[] }): Promise<{ id: string; advanced: boolean; reason?: string }> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const t = await c.query<ThreadRow>(`select * from cont_threads where id = $1 for update`, [cp.thread_id]);
    if (!t.rows[0]) throw new Error(`thread not found: ${cp.thread_id}`);
    const claim = await c.query<ClaimRow>(`select * from cont_claims where thread_id = $1 and released_at is null and expires_at > now()`, [cp.thread_id]);
    const live = claim.rows[0];
    let advanced = false;
    let reason: string | undefined;
    if (!live) reason = "no live claim";
    else if (live.holder_session_id !== cp.session_id) reason = `claim held by ${live.holder_author} (${live.holder_session_id.slice(0, 8)})`;
    else if (cp.generation !== t.rows[0].generation) reason = `generation ${cp.generation} != thread ${t.rows[0].generation}`;
    else advanced = true;
    const r = await c.query<{ id: string }>(
      `insert into cont_checkpoints (thread_id, session_id, generation, kind, through_event_seq, base_commit, wip_ref, wip_commit, verified_snapshot_at, verified_events_at, structured_state, narrative, narrative_status, capture_gaps, advanced_head)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [cp.thread_id, cp.session_id, cp.generation ?? -1, cp.kind, cp.through_event_seq, cp.base_commit ?? null, cp.wip_ref ?? null, cp.wip_commit ?? null, cp.verified_snapshot_at ?? null, cp.verified_events_at ?? null, JSON.stringify(cp.structured_state ?? {}), cp.narrative ?? null, cp.narrative_status ?? "none", JSON.stringify(cp.capture_gaps ?? []), advanced]
    );
    if (advanced) await c.query(`update cont_threads set head_checkpoint_id = $2, updated_at = now() where id = $1`, [cp.thread_id, r.rows[0].id]);
    await c.query("commit");
    return { id: r.rows[0].id, advanced, reason };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function headCheckpoint(q: Q, threadId: string): Promise<CheckpointRow | null> {
  const r = await q.query<CheckpointRow>(`select c.* from cont_threads t join cont_checkpoints c on c.id = t.head_checkpoint_id where t.id = $1`, [threadId]);
  return r.rows[0] ?? null;
}

export async function latestCheckpointAny(q: Q, threadId: string): Promise<CheckpointRow | null> {
  const r = await q.query<CheckpointRow>(`select * from cont_checkpoints where thread_id = $1 order by created_at desc limit 1`, [threadId]);
  return r.rows[0] ?? null;
}

// ---------- artifacts & notifications ----------

export async function putArtifact(q: Q, a: { sha256: string; kind: string; bytes: Buffer; session_id?: string | null }): Promise<{ id: string; existed: boolean }> {
  const ex = await q.query<{ id: string }>(`select id from cont_artifacts where sha256 = $1`, [a.sha256]);
  if (ex.rows[0]) return { id: ex.rows[0].id, existed: true };
  const r = await q.query<{ id: string }>(`insert into cont_artifacts (sha256, kind, byte_size, inline, session_id) values ($1,$2,$3,$4,$5) returning id`, [a.sha256, a.kind, a.bytes.length, a.bytes, a.session_id ?? null]);
  return { id: r.rows[0].id, existed: false };
}

export async function addNotification(q: Q, author: string, machine: string | null, message: string): Promise<void> {
  await q.query(`insert into cont_notifications (author, machine, message) values ($1,$2,$3)`, [author, machine, message]);
}

export async function takeNotifications(q: Q, author: string, machine: string | null): Promise<string[]> {
  const r = await q.query<{ id: string; message: string }>(
    `update cont_notifications set delivered_at = now() where delivered_at is null and author = $1 and (machine is null or $2::text is null or machine = $2) returning id, message`,
    [author, machine]
  );
  return r.rows.map((x) => x.message);
}
