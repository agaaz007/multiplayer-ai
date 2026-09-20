import type pg from "pg";

export const HANDOFF_SCHEMA = `
create table if not exists cont_handoff_attempts (
 id uuid primary key default gen_random_uuid(),
 source_kind text not null check(source_kind in ('record','thread')),
 source_id uuid not null,
 destination_session text not null,
 author text not null,
 mode text not null check(mode in ('continue','fork')),
 work_kind text not null check(work_kind in ('analysis','code')),
 source_snapshot_verified boolean not null default false,
 pending_operations int not null default 0,
 destination_start_seq int not null default 0,
 status text not null default 'pack_delivered' check(status in ('pack_delivered','verified','completed','failed','abandoned')),
 evidence jsonb not null default '[]',
 note text,
 user_confirmed boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table cont_handoff_attempts add column if not exists destination_start_seq int not null default 0;
create index if not exists cont_handoff_author_created on cont_handoff_attempts(author,created_at);
`;

export interface HandoffEvidence { session_id: string; seq: number; role: "verification" | "validation" | "delivered_result" | "pending_operation_resolution" }
export interface StartHandoff {
  source_kind: "record" | "thread"; source_id: string; destination_session: string;
  author: string; mode: "continue" | "fork"; work_kind: "analysis" | "code";
  source_snapshot_verified: boolean;
  pending_operations?: number;
}
export async function startHandoff(pool: pg.Pool, input: StartHandoff): Promise<string> {
  if(!["record","thread"].includes(input.source_kind) || !["continue","fork"].includes(input.mode) || !["analysis","code"].includes(input.work_kind)) throw new Error("Invalid handoff source, mode or work kind");
  if(!/^[A-Za-z0-9_-]{8,200}$/.test(input.destination_session) || !input.author?.trim()) throw new Error("A real destination session and configured author are required");
  if(!Number.isSafeInteger(input.pending_operations ?? 0) || (input.pending_operations ?? 0)<0) throw new Error("Invalid pending operation count");
  const c=await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local lock_timeout='2s'");
    // Same session-first lock order as binding/event admission. Capture the current
    // acknowledged watermark while admission cannot move it underneath this read.
    const session=await c.query(`select author from cont_sessions where id=$1 for update`,[input.destination_session]);
    if(!session.rows[0] || session.rows[0].author !== input.author) throw new Error("Destination session is unavailable or belongs to another author; wait for capture or bind it first");
    const source=await c.query(input.source_kind === "record" ? `select kind from cont_records where id=$1 for share` : `select 'implementation'::text as kind from cont_threads where id=$1 for share`,[input.source_id]);
    if(!source.rows[0]) throw new Error("Handoff source does not exist");
    const kind=source.rows[0].kind === "implementation" ? "code" : "analysis";
    if(kind !== input.work_kind) throw new Error("Handoff work kind does not match the retained source");
    const watermark=await c.query(`select coalesce(max(seq),0)::int as seq from cont_events where session_id=$1`,[input.destination_session]);
    const r = await c.query(`insert into cont_handoff_attempts(source_kind,source_id,destination_session,author,mode,work_kind,source_snapshot_verified,pending_operations,destination_start_seq)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [input.source_kind,input.source_id,input.destination_session,input.author,input.mode,input.work_kind,input.source_snapshot_verified,input.pending_operations ?? 0,watermark.rows[0].seq]);
    await c.query("commit");return r.rows[0].id;
  }catch(e){await c.query("rollback").catch(()=>{});throw e;}finally{c.release();}
}

/** Evidence-backed, agent-reported progress. Never labels a user's acceptance implicitly. */
export async function updateHandoff(pool: pg.Pool, input: {
  id: string; author: string; session_id: string; status: "verified" | "completed" | "failed" | "abandoned";
  evidence: HandoffEvidence[]; note?: string;
}): Promise<Record<string, unknown>> {
  if (!["verified","completed","failed","abandoned"].includes(input.status)) throw new Error("Invalid handoff status");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='2s'");
    const {rows} = await client.query("select * from cont_handoff_attempts where id=$1 for update",[input.id]);
    const attempt = rows[0];
    if (!attempt || attempt.author !== input.author || attempt.destination_session !== input.session_id) throw new Error("Handoff does not belong to this author and destination session");
    if (["completed","failed","abandoned"].includes(attempt.status)) {
      if (attempt.status !== input.status) throw new Error("A terminal handoff cannot be relabelled; start a new attempt");
      await client.query("commit"); return attempt;
    }
    if (!Array.isArray(input.evidence) || input.evidence.length > 50) throw new Error("At most 50 exact event evidence references are allowed");
    const refs: HandoffEvidence[] = [];
    for (const ref of input.evidence) {
      if (!ref || !["verification","validation","delivered_result","pending_operation_resolution"].includes(ref.role)) throw new Error("Invalid handoff evidence role");
      if (ref.session_id !== input.session_id || !Number.isSafeInteger(ref.seq) || ref.seq < 1) throw new Error("Handoff progress evidence must be from the destination session");
      if(ref.seq <= attempt.destination_start_seq) throw new Error("Handoff evidence must be captured after this attempt began");
      const {rows: events} = await client.query("select kind,payload from cont_events where session_id=$1 and seq=$2", [ref.session_id, ref.seq]);
      const e = events[0];
      if (!e) throw new Error("Handoff evidence event is unavailable; wait for capture before reporting progress");
      if (ref.role === "delivered_result" && e.kind !== "assistant.message") throw new Error("Delivered result requires a captured assistant message");
      if ((["verification","validation","pending_operation_resolution"].includes(ref.role)) && e.kind !== "tool.finished") throw new Error("Verification/validation require captured tool outcomes");
      if ((["verification","validation","pending_operation_resolution"].includes(ref.role)) && (e.payload?.is_error || e.payload?.isError || e.payload?.success === false || ["failed","declined","cancelled","canceled"].includes(e.payload?.status) || (typeof e.payload?.exit_code === "number" && e.payload.exit_code !== 0))) throw new Error("Failed tool outcomes cannot establish successful verification");
      if(ref.role === "delivered_result" && !String(e.payload?.text ?? "").trim()) throw new Error("Delivered result must contain a retained message body");
      refs.push({session_id:ref.session_id,seq:ref.seq,role:ref.role});
    }
    const all: HandoffEvidence[] = [...(attempt.evidence ?? []), ...refs].filter((r, i, a) => a.findIndex(x => x.session_id === r.session_id && x.seq === r.seq && x.role === r.role) === i);
    if(all.length>100) throw new Error("Handoff evidence is limited to 100 exact references");
    if (input.status === "verified" || input.status === "completed") {
      if (!all.some(r => r.role === "verification")) throw new Error("Handoff verification requires a retained tool outcome for the evidence read or bootstrap");
      if (attempt.work_kind === "code" && !attempt.source_snapshot_verified) throw new Error("Code handoff cannot be verified without a remotely verified source snapshot");
    }
    if (input.status === "completed" && (!all.some(r => r.role === "validation") || !all.some(r => r.role === "delivered_result"))) throw new Error("Completion requires retained validation and a delivered continuation result");
    if (input.status === "completed" && attempt.pending_operations > 0 && !all.some(r => r.role === "pending_operation_resolution")) throw new Error("Resolve the source's pending operations and retain the evidence before completing this handoff");
    if (["failed","abandoned"].includes(input.status) && !input.note?.trim()) throw new Error("Failed or abandoned handoffs require a reason");
    const updated = await client.query(`update cont_handoff_attempts set status=$2,evidence=$3::jsonb,note=$4,updated_at=now() where id=$1 returning *`, [input.id,input.status,JSON.stringify(all),input.note?.slice(0,2000) ?? null]);
    await client.query("commit"); return updated.rows[0];
  } catch (e) { await client.query("rollback").catch(()=>{}); throw e; }
  finally { client.release(); }
}

/** Deterministic weekly export, explicitly excluding any claim of time saved. */
export async function handoffSummary(pool: pg.Pool, from: string, to: string) {
  const a = new Date(from), b = new Date(to);
  if (!Number.isFinite(+a) || !Number.isFinite(+b) || a >= b) throw new Error("Expected an increasing ISO reporting interval");
  const {rows} = await pool.query(`select author,work_kind,mode,status,count(*)::int as attempts,
    count(*) filter(where user_confirmed)::int as user_confirmed
    from cont_handoff_attempts where created_at >= $1 and created_at < $2 group by author,work_kind,mode,status order by author,work_kind,mode,status`,[a,b]);
  return {from:a.toISOString(),to:b.toISOString(),attribution:"agent-reported, supported by retained evidence; not independent verification",rows};
}
