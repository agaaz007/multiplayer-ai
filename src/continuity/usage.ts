import fs from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { drainUsageWrites, usageDirectory, usageHealth, withoutUsage, type UsageEnvelope, startStorageOperation, sqlOperationClass, invalidateUsageDiskEstimate, usageSpoolHealth } from "../usage.js";

export const USAGE_SCHEMA = `
create table if not exists cont_usage_invocations (
 invocation_id uuid primary key, actor text not null, session_id text, harness text not null,
 identity_source text not null, identity_verified boolean not null, machine text, version text not null,
 tool text not null, traffic_class text not null, purpose text not null, parent_invocation_id text,
 started_at timestamptz not null, finished_at timestamptz, duration_ms double precision,
 outcome text not null, availability text not null, records jsonb not null default '[]',
 received_at timestamptz not null default now()
);
alter table cont_usage_invocations add column if not exists logical_operation_key text;
create index if not exists cont_usage_invocations_window_idx on cont_usage_invocations(started_at,actor,traffic_class);
create table if not exists cont_usage_storage_ops (
 operation_id uuid primary key, invocation_id uuid not null, backend text not null,
 operation_class text not null, purpose text not null, started_at timestamptz not null,
 duration_ms double precision not null, success boolean not null, returned_rows int,
 evidence_returned boolean, attempt int not null, received_at timestamptz not null default now()
);
create index if not exists cont_usage_storage_invocation_idx on cont_usage_storage_ops(invocation_id);
create table if not exists cont_usage_retention_runs (
 id uuid primary key default gen_random_uuid(), pruned_before timestamptz not null,
 invocations_deleted int not null, operations_deleted int not null,
 performed_at timestamptz not null default now()
);
create table if not exists cont_schema_versions(version int primary key, applied_at timestamptz not null default now());
insert into cont_schema_versions(version) values(2) on conflict do nothing;
`;

/** Instrument each checked-out client once: pool.query also uses these clients, so it
 * produces one observation, not an extra pool-level duplicate. Supports pg callbacks. */
const instrumented=new WeakSet<object>();
export function instrumentUsageClient(client: pg.PoolClient): void {
  if (instrumented.has(client)) return;instrumented.add(client);
  const original=client.query.bind(client);
  (client as any).query=function(...args:any[]) {
    const query=args[0];const text=typeof query === "string" ? query : query?.text;
    const classification=sqlOperationClass(text);
    const finish=startStorageOperation({backend:"neon",operation_class:classification,purpose:classification === "maintenance" ? "maintenance" : undefined});
    const complete=(error:unknown,result:any) => finish({success:!error,returned_rows:Array.isArray(result) ? result.reduce((n:number,r:any)=>n+(r.rowCount??0),0) : result?.rowCount ?? null,evidence_returned:null});
    const i=args.length-1;
    if (typeof args[i] === "function") {
      const callback=args[i];args[i]=(e:unknown,r:unknown) => {complete(e,r);callback(e,r);};
      try {return (original as any)(...args);} catch(e) {complete(e,null);throw e;}
    }
    try {
      const result=(original as any)(...args);
      if (result?.then) return result.then((r:unknown)=>{complete(null,r);return r;},(e:unknown)=>{complete(e,null);throw e;});
      // Event-emitting pg Query objects retain native semantics.
      if (result?.once) {result.once("end",(r:unknown)=>complete(null,r));result.once("error",(e:unknown)=>complete(e,null));}
      return result;
    } catch(e) {complete(e,null);throw e;}
  };
}

/** Unlike a general mutation, usage UPSERTs are replay-safe after an unknown commit.
 * Destroy an overdue borrowed client and retain local frames; later replay reconciles
 * UUIDs. The budget includes pool acquisition, and a late-acquired client is destroyed. */
async function boundedUsageWrite<T>(pool:pg.Pool,run:(client:pg.PoolClient)=>Promise<T>,timeoutMs:number):Promise<T> {
  let client:pg.PoolClient|undefined,finished=false,released=false;
  const release=(destroy=false)=>{if(client&&!released){released=true;client.release(destroy);}};
  let timer:ReturnType<typeof setTimeout>;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{finished=true;release(true);reject(new Error("usage_upload_timeout"));},timeoutMs);});
  const work=(async()=>{client=await pool.connect();if(finished){release(true);throw new Error("usage_upload_timeout");}return run(client);})();
  try{return await Promise.race([work,timeout]);}finally{finished=true;clearTimeout(timer!);release();}
}

let uploading=false;
/** Bounded best-effort drain, called out of the user request path. Delete only after
 * committed UPSERT; a crash replays the same UUID. No raw argument/result bodies. */
export async function flushUsage(pool: pg.Pool, limit=100): Promise<{uploaded:number;pending:number;dropped:number;error?:string}> {
  if (uploading) return {uploaded:0,pending:usageHealth().pending,dropped:usageHealth().dropped};
  uploading=true;
  try { return await withoutUsage(async () => {
    const deadline=performance.now()+4000;
    let localTimer:ReturnType<typeof setTimeout>;
    const ready=await Promise.race([drainUsageWrites().then(()=>true),new Promise<false>(resolve=>{localTimer=setTimeout(()=>resolve(false),2000);})]);
    clearTimeout(localTimer!);
    if(!ready) return {uploaded:0,pending:usageHealth().pending,dropped:usageHealth().dropped,error:"usage_local_write_budget"};
    const dir=usageDirectory();const files=(await fs.readdir(dir).catch(()=>[])).filter(f=>/^(?:invocation-[a-f0-9-]{36}-(?:started|finished)|storage-[a-f0-9-]{36})\.json$/.test(f));let uploaded=0;
    for(const file of files.filter(f=>/^(?:invocation-[a-f0-9-]{36}-(?:started|finished)|storage-[a-f0-9-]{36})\.json$/.test(f)).slice(0,Math.max(1,Math.min(1000,limit)))) {
      if(performance.now()>=deadline) return {uploaded,pending:files.length-uploaded,dropped:usageHealth().dropped,error:"usage_batch_budget"};
      const filename=path.join(dir,file);
      try {
        const bytes=await fs.readFile(filename,"utf8");const e=JSON.parse(bytes) as UsageEnvelope;const v=e.value;
        await boundedUsageWrite(pool,async client => {
        if(e.kind === "invocation") {
          const x=e.value;
          await client.query(`insert into cont_usage_invocations(invocation_id,actor,session_id,harness,identity_source,identity_verified,machine,version,tool,traffic_class,purpose,parent_invocation_id,started_at,finished_at,duration_ms,outcome,availability,records,logical_operation_key)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)
           on conflict(invocation_id) do update set finished_at=excluded.finished_at,duration_ms=excluded.duration_ms,outcome=excluded.outcome,availability=excluded.availability,records=excluded.records
           where cont_usage_invocations.finished_at is null`,[x.invocation_id,x.actor,x.session_id,x.harness,x.identity_source,x.identity_verified,x.machine,x.version,x.tool,x.traffic_class,x.purpose,x.parent_invocation_id,x.started_at,x.finished_at,x.duration_ms,x.outcome,x.availability,JSON.stringify(x.records),x.logical_operation_key ?? null]);
        } else {
          const x=e.value;
          await client.query(`insert into cont_usage_storage_ops(operation_id,invocation_id,backend,operation_class,purpose,started_at,duration_ms,success,returned_rows,evidence_returned,attempt) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`,[x.operation_id,x.invocation_id,x.backend,x.operation_class,x.purpose,x.started_at,x.duration_ms,x.success,x.returned_rows,x.evidence_returned,x.attempt]);
        }
        },Math.max(1,Math.min(2000,deadline-performance.now())));
        // Immutable phase frames prevent an in-flight start upload deleting a later terminal outcome.
        if(await fs.readFile(filename,"utf8").catch(()=>"") === bytes) await fs.unlink(filename).catch(()=>{});
        uploaded++;
      } catch {return {uploaded,pending:files.length-uploaded,dropped:usageHealth().dropped,error:"usage_upload_failed"};}
    }
    return {uploaded,pending:Math.max(0,files.length-uploaded),dropped:usageHealth().dropped};
  }); } finally {uploading=false;invalidateUsageDiskEstimate();}
}

/** Retention is an explicit maintenance action, never part of a read/tool request. */
export async function pruneUsage(pool:pg.Pool,retentionDays=30):Promise<{invocations:number;operations:number}> {
  if (!Number.isInteger(retentionDays) || retentionDays < 30) throw new Error("Raw usage retention must be at least 30 days");
  return withoutUsage(async () => {
    const client=await pool.connect();
    try {
      await client.query("begin");
      const cutoff=(await client.query(`select now()-($1::int * interval '1 day') as cutoff`,[retentionDays])).rows[0].cutoff;
      const ops=await client.query(`delete from cont_usage_storage_ops where started_at < $1`,[cutoff]);
      const inv=await client.query(`delete from cont_usage_invocations where started_at < $1`,[cutoff]);
      await client.query(`insert into cont_usage_retention_runs(pruned_before,invocations_deleted,operations_deleted) values($1,$2,$3)`,[cutoff,inv.rowCount??0,ops.rowCount??0]);
      await client.query("commit");
      return {invocations:inv.rowCount??0,operations:ops.rowCount??0};
    }catch(e){await client.query("rollback").catch(()=>{});throw e;}finally{client.release();}
  });
}


/** Half-open window and separate grains: tool invocations, actual SQL operations,
 * and agent-reported reference appearances. SQL row count is not usefulness. */
export async function usageSummary(pool:pg.Pool,opts:{from:string;to:string;actor?:string;traffic_class?:string}) {
  if(!Number.isFinite(Date.parse(opts.from)) || !Number.isFinite(Date.parse(opts.to)) || Date.parse(opts.from)>=Date.parse(opts.to)) throw new Error("Usage window must have valid from < to timestamps");
  return withoutUsage(async () => {
    const params=[opts.from,opts.to,opts.actor ?? null,opts.traffic_class ?? null];
    const where=`i.started_at >= $1::timestamptz and i.started_at < $2::timestamptz and ($3::text is null or i.actor=$3) and ($4::text is null or i.traffic_class=$4)`;
    const operationWhere=`o.started_at >= $1::timestamptz and o.started_at < $2::timestamptz and ($3::text is null or i.actor=$3) and ($4::text is null or i.traffic_class=$4)`;
    const invocations=await pool.query(`select i.actor,i.tool,i.purpose,i.traffic_class,i.outcome,i.availability,count(*)::int as invocations,count(i.finished_at)::int as terminal_outcomes,avg(i.duration_ms) as mean_duration_ms,percentile_cont(0.95) within group(order by i.duration_ms) as p95_duration_ms,percentile_cont(0.99) within group(order by i.duration_ms) as p99_duration_ms,count(distinct i.logical_operation_key)::int as known_logical_operations,count(*) filter(where i.logical_operation_key is null)::int as invocations_without_retry_identity from cont_usage_invocations i where ${where} group by 1,2,3,4,5,6 order by 1,2,3,4,5,6`,params);
    const operations=await pool.query(`select i.actor,o.backend,o.operation_class,o.purpose,o.success,o.attempt,count(*)::int as operations,count(*) filter(where o.returned_rows=0)::int as zero_row_operations,sum(o.returned_rows)::bigint as returned_rows,count(*) filter(where o.evidence_returned=true)::int as known_evidence_returns,count(*) filter(where o.evidence_returned is null)::int as unknown_evidence_returns from cont_usage_storage_ops o join cont_usage_invocations i using(invocation_id) where ${operationWhere} group by 1,2,3,4,5,6 order by 1,2,3,4,5,6`,params);
    const references=await pool.query(`select i.actor as caller_author,r->>'author' as source_author,count(*)::int as record_appearances,count(distinct r->>'id')::int as distinct_records from cont_usage_invocations i cross join lateral jsonb_array_elements(i.records) r where ${where} and i.tool='ledger_show_contribution' and i.outcome='success' group by 1,2 order by 1,2`,params);
    const orphaned=await pool.query(`select count(*)::int as operations_without_invocation from cont_usage_storage_ops o where o.started_at >= $1::timestamptz and o.started_at < $2::timestamptz and not exists(select 1 from cont_usage_invocations i where i.invocation_id=o.invocation_id)`,params.slice(0,2));
    const retention=await pool.query(`select pruned_before,invocations_deleted,operations_deleted,performed_at from cont_usage_retention_runs order by performed_at desc limit 20`);
    return {retention_history:retention.rows,window:{from:opts.from,to:opts.to,bounds:"[from,to)"},invocations:invocations.rows,storage_operations:operations.rows,agent_reported_references:references.rows,operations_without_invocation:orphaned.rows[0].operations_without_invocation,local_spool:await usageSpoolHealth(),limitations:["Unknown traffic remains unknown; no historical backfill is inferred.","Invocations are grouped by invocation start; SQL dispatches by operation start. Retry grouping is known only when a caller supplied an idempotency key.","Reference appearances are agent-reported use, not completed handoffs.","Local spool health covers this machine; remote machine completeness requires its health evidence."]};
  });
}
