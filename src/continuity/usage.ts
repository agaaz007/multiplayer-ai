import fs from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { drainUsageWrites, usageDirectory, usageHealth, withoutUsage, type UsageEnvelope, startStorageOperation, sqlOperationClass } from "../usage.js";

export const USAGE_SCHEMA = `
create table if not exists cont_usage_invocations (
 invocation_id uuid primary key, actor text not null, session_id text, harness text not null,
 identity_source text not null, identity_verified boolean not null, machine text, version text not null,
 tool text not null, traffic_class text not null, purpose text not null, parent_invocation_id text,
 started_at timestamptz not null, finished_at timestamptz, duration_ms double precision,
 outcome text not null, availability text not null, records jsonb not null default '[]',
 received_at timestamptz not null default now()
);
create index if not exists cont_usage_invocations_window_idx on cont_usage_invocations(started_at,actor,traffic_class);
create table if not exists cont_usage_storage_ops (
 operation_id uuid primary key, invocation_id uuid not null, backend text not null,
 operation_class text not null, purpose text not null, started_at timestamptz not null,
 duration_ms double precision not null, success boolean not null, returned_rows int,
 evidence_returned boolean, attempt int not null, received_at timestamptz not null default now()
);
create index if not exists cont_usage_storage_invocation_idx on cont_usage_storage_ops(invocation_id);
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

let uploading=false;
/** Bounded best-effort drain, called out of the user request path. Delete only after
 * committed UPSERT; a crash replays the same UUID. No raw argument/result bodies. */
export async function flushUsage(pool: pg.Pool, limit=100): Promise<{uploaded:number;pending:number;dropped:number;error?:string}> {
  if (uploading) return {uploaded:0,pending:usageHealth().pending,dropped:usageHealth().dropped};
  uploading=true;
  try { return await withoutUsage(async () => {
    await drainUsageWrites();
    const dir=usageDirectory();const files=await fs.readdir(dir).catch(()=>[]);let uploaded=0;
    for(const file of files.filter(f=>/^(invocation|storage)-[a-f0-9-]{36}\.json$/.test(f)).slice(0,Math.max(1,Math.min(1000,limit)))) {
      const filename=path.join(dir,file);
      try {
        const bytes=await fs.readFile(filename,"utf8");const e=JSON.parse(bytes) as UsageEnvelope;const v=e.value;
        if(e.kind === "invocation") {
          const x=e.value;
          await pool.query(`insert into cont_usage_invocations(invocation_id,actor,session_id,harness,identity_source,identity_verified,machine,version,tool,traffic_class,purpose,parent_invocation_id,started_at,finished_at,duration_ms,outcome,availability,records)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
           on conflict(invocation_id) do update set finished_at=excluded.finished_at,duration_ms=excluded.duration_ms,outcome=excluded.outcome,availability=excluded.availability,records=excluded.records
           where cont_usage_invocations.finished_at is null`,[x.invocation_id,x.actor,x.session_id,x.harness,x.identity_source,x.identity_verified,x.machine,x.version,x.tool,x.traffic_class,x.purpose,x.parent_invocation_id,x.started_at,x.finished_at,x.duration_ms,x.outcome,x.availability,JSON.stringify(x.records)]);
        } else {
          const x=e.value;
          await pool.query(`insert into cont_usage_storage_ops(operation_id,invocation_id,backend,operation_class,purpose,started_at,duration_ms,success,returned_rows,evidence_returned,attempt) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`,[x.operation_id,x.invocation_id,x.backend,x.operation_class,x.purpose,x.started_at,x.duration_ms,x.success,x.returned_rows,x.evidence_returned,x.attempt]);
        }
        // A terminal outcome may have replaced the started frame during upload.
        if(await fs.readFile(filename,"utf8").catch(()=>"") === bytes) await fs.unlink(filename).catch(()=>{});
        uploaded++;
      } catch {return {uploaded,pending:files.length-uploaded,dropped:usageHealth().dropped,error:"usage_upload_failed"};}
    }
    return {uploaded,pending:Math.max(0,files.length-uploaded),dropped:usageHealth().dropped};
  }); } finally {uploading=false;}
}

/** Retention is an explicit maintenance action, never part of a read/tool request. */
export async function pruneUsage(pool:pg.Pool,retentionDays=30):Promise<{invocations:number;operations:number}> {
  if (!Number.isInteger(retentionDays) || retentionDays < 30) throw new Error("Raw usage retention must be at least 30 days");
  return withoutUsage(async () => {
    const ops=await pool.query(`delete from cont_usage_storage_ops where started_at < now()-($1::int * interval '1 day')`,[retentionDays]);
    const inv=await pool.query(`delete from cont_usage_invocations where started_at < now()-($1::int * interval '1 day')`,[retentionDays]);
    return {invocations:inv.rowCount??0,operations:ops.rowCount??0};
  });
}
