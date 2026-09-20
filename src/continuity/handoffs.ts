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
 status text not null default 'pack_delivered' check(status in ('pack_delivered','verified','completed','failed','abandoned')),
 evidence jsonb not null default '[]',
 note text,
 user_confirmed boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
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
  const r = await pool.query(`insert into cont_handoff_attempts(source_kind,source_id,destination_session,author,mode,work_kind,source_snapshot_verified,pending_operations)
    values($1,$2,$3,$4,$5,$6,$7,$8) returning id`, [input.source_kind,input.source_id,input.destination_session,input.author,input.mode,input.work_kind,input.source_snapshot_verified,input.pending_operations ?? 0]);
  return r.rows[0].id;
}

/** Evidence-backed, agent-reported progress. Never labels a user's acceptance implicitly. */
export async function updateHandoff(pool: pg.Pool, input: {
  id: string; author: string; session_id: string; status: "verified" | "completed" | "failed" | "abandoned";
  evidence: HandoffEvidence[]; note?: string;
}): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("begin");
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
      if (ref.session_id !== input.session_id || !Number.isSafeInteger(ref.seq) || ref.seq < 1) throw new Error("Handoff progress evidence must be from the destination session");
      const {rows: events} = await client.query("select kind,payload from cont_events where session_id=$1 and seq=$2", [ref.session_id, ref.seq]);
      const e = events[0];
      if (!e) throw new Error("Handoff evidence event is unavailable; wait for capture before reporting progress");
      if (ref.role === "delivered_result" && e.kind !== "assistant.message") throw new Error("Delivered result requires a captured assistant message");
      if ((ref.role === "verification" || ref.role === "validation") && e.kind !== "tool.finished") throw new Error("Verification/validation require captured tool outcomes");
      if ((ref.role === "verification" || ref.role === "validation") && (e.payload?.is_error || e.payload?.isError || e.payload?.success === false || e.payload?.status === "failed")) throw new Error("Failed tool outcomes cannot establish successful verification");
      refs.push(ref);
    }
    const all: HandoffEvidence[] = [...(attempt.evidence ?? []), ...refs].filter((r, i, a) => a.findIndex(x => x.session_id === r.session_id && x.seq === r.seq && x.role === r.role) === i);
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
