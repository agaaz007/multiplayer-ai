import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Config } from "./store.js";
import { resolveHarnessIdentity, type HarnessIdentity } from "./continuity/safety.js";

export type TrafficClass = "ordinary" | "evaluation" | "audit" | "maintenance" | "unknown";
export type UsagePurpose = "interactive_read" | "automatic_brief" | "capture_write" | "maintenance" | "telemetry";
export interface UsageMetadata {
  tool: string;
  session_id?: string;
  identity?: HarnessIdentity;
  traffic_class?: TrafficClass;
  purpose?: UsagePurpose;
  /** Stable across one transport retry only when the transport supplies one. */
  invocation_id?: string;
  parent_invocation_id?: string;
  /** Hashed idempotency key; null when transport retry identity is unknown. */
  logical_operation_key?: string;
  version?: string;
}
export interface UsageSummary {
  outcome?: "success" | "refusal" | "error";
  availability?: "available" | "empty" | "unavailable" | "stale" | "unknown";
  records?: {id:string;version?:string;author?:string}[];
}
export interface UsageInvocation {
  invocation_id: string; actor: string; session_id: string | null; harness: string; identity_source: string;
  identity_verified: boolean; machine: string | null; version: string; tool: string; traffic_class: TrafficClass;
  purpose: UsagePurpose; parent_invocation_id: string | null; logical_operation_key?: string | null; started_at: string; finished_at: string | null;
  duration_ms: number | null; outcome: "started" | "success" | "refusal" | "error";
  availability: string; records: {id:string;version?:string;author?:string}[];
  /** Bytes of context this invocation actually delivered to the agent. Null when it injects nothing. */
  payload_bytes: number | null;
  /** Records a byte budget left out of that payload. 0 means nothing was dropped; null means not an injection. */
  payload_dropped: number | null;
}
export interface UsageStorageOperation {
  operation_id: string; invocation_id: string; backend: "git" | "neon";
  operation_class: string; purpose: UsagePurpose; started_at: string; duration_ms: number;
  success: boolean; returned_rows: number | null; evidence_returned: boolean | null; attempt: number;
}
export type UsageEnvelope = {kind:"invocation";value:UsageInvocation} | {kind:"storage";value:UsageStorageOperation};
interface Context { invocation: UsageInvocation; disabled?: boolean; injected?: boolean }
const context = new AsyncLocalStorage<Context>();
const pending = new Set<Promise<void>>();
const queues = new Map<string,Promise<void>>();
const MAX_PENDING = 1000;
const diskBytes = new Map<string,number>();
const MAX_SPOOL_BYTES = 16 * 1024 * 1024;
let dropped = 0;
let lastError: string | null = null;
const safe = (v: unknown, fallback = "unknown", max = 200): string => typeof v === "string" && /^[A-Za-z0-9_.:@/ -]+$/.test(v) && !v.includes("://") ? v.slice(0,max) : fallback;
export function usageDirectory(): string { return path.join(process.env.LEDGER_CONFIG_DIR ?? path.join(os.homedir(),".ledger"),"usage-spool-v1"); }
export function usageHealth(): {pending:number;dropped:number;last_error:string|null} { return {pending:pending.size,dropped,last_error:lastError}; }
export function currentUsageInvocationId(): string | undefined { return context.getStore()?.invocation.invocation_id; }
export function withoutUsage<T>(fn: () => T): T { const c=context.getStore(); return c ? context.run({...c,disabled:true},fn) : fn(); }

/** Usage is never awaited by the user's operation. Bounded, separate spool; failures
 * are exposed through health, not recursively reported as database operations. */
function emit(envelope: UsageEnvelope): void {
  if(process.env.LEDGER_USAGE === "0") return;
  if (pending.size >= MAX_PENDING) { dropped++; return; }
  const dir=usageDirectory();
  const previous=queues.get(dir) ?? Promise.resolve();
  const task=previous.then(async () => {
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    let bytes=diskBytes.get(dir);
    if(bytes == null) {
      bytes=0;
      for(const file of await fs.readdir(dir)) if(file.endsWith(".json")) bytes+=(await fs.stat(path.join(dir,file)).catch(()=>({size:0}))).size;
      diskBytes.set(dir,bytes);
    }
    const encoded=JSON.stringify(envelope);
    if (bytes+Buffer.byteLength(encoded)>MAX_SPOOL_BYTES) { dropped++; lastError="spool_capacity"; return; }
    const id=envelope.kind === "invocation" ? envelope.value.invocation_id : envelope.value.operation_id;
    const dest=path.join(dir,`${envelope.kind}-${id}${envelope.kind === "invocation" ? (envelope.value.finished_at ? "-finished" : "-started") : ""}.json`);
    const tmp=`${dest}.${randomUUID()}.tmp`;
    const f=await fs.open(tmp,"wx",0o600);
    try { await f.writeFile(encoded); await f.sync(); } finally { await f.close(); }
    const previousSize=(await fs.stat(dest).catch(()=>({size:0}))).size;
    await fs.rename(tmp,dest);
    diskBytes.set(dir,bytes+Buffer.byteLength(encoded)-previousSize);
    const d=await fs.open(dir,"r"); try { await d.sync(); } finally { await d.close(); }
  }).catch(() => { dropped++; lastError="local_spool_write_failed"; }).finally(async () => {
    if(dropped || lastError) {
      const health=path.join(dir,`health-${process.pid}.status`),tmp=`${health}.tmp`;
      try {await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.writeFile(tmp,JSON.stringify({dropped,last_error:lastError,updated_at:new Date().toISOString()}),{mode:0o600});await fs.rename(tmp,health);}catch { /* disk health remains unknown */ }
    }
    pending.delete(task);
  });
  queues.set(dir,task); pending.add(task);
}
export async function drainUsageWrites(): Promise<void> { await Promise.all([...pending]); }

function recordsOf(value: unknown): UsageSummary["records"] {
  const r=value as {structuredContent?:{results?:unknown[];objects?:unknown[];sources?:unknown[];references?:{id:string}[];receipt?:{records?:unknown[]};content_version?:string};results?:unknown[];objects?:unknown[]};
  const structured=r?.structuredContent;
  let rows=structured?.sources ?? structured?.results ?? structured?.objects ?? structured?.receipt?.records ?? r?.results ?? r?.objects ?? [];
  // Preserve reference appearances, including two passages citing the same source.
  // Only returned source identities count; unresolved caller-supplied IDs do not.
  if(structured?.references?.length && structured.sources) {
    const sources=new Map(structured.sources.map(x=>[(x as {id:string}).id,x]));
    rows=structured.references.flatMap(ref=>sources.has(ref.id)?[sources.get(ref.id)]:[]);
  }
  return rows.flatMap(x => {
    const v=x as {id?:unknown;content_version?:unknown;author?:unknown};
    if (typeof v?.id !== "string" || !/^(?:def|fnd|chg|dec)-[A-Za-z0-9-]+$/.test(v.id)) return [];
    const version=v.content_version ?? structured?.content_version;
    return [{id:v.id,version:typeof version === "string" && /^[a-f0-9]{64}$/.test(version) ? version : undefined,author:typeof v.author === "string" ? safe(v.author) : undefined}];
  }).slice(0,100);
}

const cleanRecords=(rows: UsageSummary["records"]): UsageInvocation["records"] =>
  (rows ?? []).filter(r => /^(?:def|fnd|chg|dec)-[A-Za-z0-9-]+$/.test(r.id)).slice(0,100).map(r => ({id:r.id,version:r.version && /^[a-f0-9]{64}$/.test(r.version) ? r.version : undefined,author:r.author ? safe(r.author) : undefined}));

/**
 * Record what an agent actually received from the invocation in flight: the ids in the payload, its
 * byte size, and how many records a byte budget left out. Ids, counts and sizes only — never a record
 * body, so the redaction rules in continuity/redact.ts have nothing to strip.
 *
 * The product's claim was "the agent used these records", asserted on the agent's own word with no
 * record of what was ever delivered. A brief that was truncated to a ~2 KB preview for eighteen days
 * looked identical to one that arrived whole. An injection row states the truncation as a fact.
 *
 * A no-op outside an invocation and when usage is off, so no caller has to check and no logging
 * failure can reach a hook or a tool result.
 */
export function reportInjectedContext(delivered: {record_ids?: string[]; bytes?: number; dropped?: number}): void {
  try {
    const c=context.getStore();
    if(!c || c.disabled) return;
    c.injected=true;
    const i=c.invocation;
    if(Number.isFinite(delivered.bytes)) i.payload_bytes=Math.max(0,Math.round(delivered.bytes!));
    if(Number.isFinite(delivered.dropped)) i.payload_dropped=Math.max(0,Math.round(delivered.dropped!));
    if(delivered.record_ids) i.records=cleanRecords(delivered.record_ids.map(id => ({id})));
  } catch { lastError="usage_injection_report_failed"; }
}

export async function withUsageInvocation<T>(cfg: Config, metadata: UsageMetadata, fn: () => Promise<T>, summary?: (result:T) => UsageSummary): Promise<T> {
  if(process.env.LEDGER_USAGE === "0") return fn();
  const id=metadata.invocation_id && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(metadata.invocation_id) ? metadata.invocation_id : randomUUID();
  const invocation: UsageInvocation={invocation_id:id,actor:safe(cfg.author),session_id:metadata.session_id ? safe(metadata.session_id) : null,harness:metadata.identity?.harness ?? "unknown",identity_source:safe(metadata.identity?.source),identity_verified:metadata.identity?.verified ?? false,machine:cfg.continuity?.machine ? safe(cfg.continuity.machine) : null,version:safe(metadata.version,"unknown"),tool:safe(metadata.tool),traffic_class:metadata.traffic_class ?? "unknown",purpose:metadata.purpose ?? "interactive_read",parent_invocation_id:metadata.parent_invocation_id ? safe(metadata.parent_invocation_id) : null,logical_operation_key:metadata.logical_operation_key && /^[a-f0-9]{64}$/.test(metadata.logical_operation_key) ? metadata.logical_operation_key : null,started_at:new Date().toISOString(),finished_at:null,duration_ms:null,outcome:"started",availability:"unknown",records:[],payload_bytes:null,payload_dropped:null};
  const store: Context={invocation};
  const began=performance.now(); emit({kind:"invocation",value:{...invocation}});
  return context.run(store,async () => {
    try {
      const result=await fn();
      let details:UsageSummary={};
      try {details=summary?.(result) ?? {};}catch{lastError="usage_summary_failed";}
      const isError=(result as {isError?:boolean})?.isError === true;
      invocation.outcome=details.outcome ?? (isError ? "error" : "success");
      invocation.availability=details.availability ?? "unknown";
      // An explicit injection report is what the agent received; the generic result scan is a guess
      // about it, so it never overwrites one.
      if(!store.injected) invocation.records=cleanRecords(details.records ?? recordsOf(result) ?? []);
      return result;
    } catch (e) { invocation.outcome=(e as {code?:string})?.code === "refusal" ? "refusal" : "error"; throw e; }
    finally { invocation.finished_at=new Date().toISOString();invocation.duration_ms=Math.max(0,performance.now()-began);emit({kind:"invocation",value:{...invocation}}); }
  });
}

export function startStorageOperation(opts: {backend:"git"|"neon";operation_class:string;purpose?:UsagePurpose;attempt?:number}): (result:{success:boolean;returned_rows?:number|null;evidence_returned?:boolean|null}) => void {
  const c=context.getStore();
  if (!c || c.disabled || c.invocation.purpose === "telemetry") return () => {};
  const at=new Date().toISOString(),began=performance.now();let done=false;
  return result => {
    if (done) return;done=true;
    emit({kind:"storage",value:{operation_id:randomUUID(),invocation_id:c.invocation.invocation_id,backend:opts.backend,operation_class:safe(opts.operation_class),purpose:opts.purpose ?? c.invocation.purpose,started_at:at,duration_ms:Math.max(0,performance.now()-began),success:result.success,returned_rows:result.returned_rows ?? null,evidence_returned:result.evidence_returned ?? null,attempt:opts.attempt ?? 1}});
  };
}
export async function observeStorageOperation<T>(opts: Parameters<typeof startStorageOperation>[0], fn: () => Promise<T>, summarize?: (value:T) => {returned_rows?:number;evidence_returned?:boolean}): Promise<T> {
  const finish=startStorageOperation(opts);
  try {const value=await fn();finish({success:true,...summarize?.(value)});return value;} catch(e) {finish({success:false});throw e;}
}

/** SQL text is classified in memory and never persisted. Unknown CTEs are not called reads. */
export function sqlOperationClass(sql: unknown): string {
  const text=typeof sql === "string" ? sql.trim().replace(/^(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*/g,"") : "";
  if (/^select\s+pg_(?:advisory|try_advisory)/i.test(text)) return "transaction";
  if (/^explain\b/i.test(text)) return "unknown";
  if (/^(select|show)\b/i.test(text)) return "read";
  if (/^with\b/i.test(text)) return /\b(insert|update|delete|merge)\b/i.test(text) ? "write" : "read";
  if (/^(insert|update|delete|merge|copy)\b/i.test(text)) return "write";
  if (/^(begin|commit|rollback|savepoint|release)\b/i.test(text)) return "transaction";
  if (/^(create|alter|drop|set|vacuum|analyze)\b/i.test(text)) return "maintenance";
  return "unknown";
}


/** Decorate registration before registering tools (including registerAppTool). Only
 * handler metadata and vetted result identities enter usage, never args or content. */
export function instrumentMcpTools(server: {registerTool: (...args:any[]) => any}, cfg: Config): void {
  const register=server.registerTool.bind(server);
  server.registerTool=((name:string,config:any,handler:(...args:any[])=>Promise<any>) => register(name,config,async (...args:any[]) => {
    const resolved=resolveHarnessIdentity(typeof args[0]?.session_id === "string" ? args[0].session_id : undefined);
    const allowed=new Set<TrafficClass>(["ordinary","evaluation","audit","maintenance","unknown"]);
    const configured=process.env.LEDGER_TRAFFIC_CLASS as TrafficClass;
    const traffic_class=process.env.LEDGER_SELFTEST === "1" ? "evaluation" : allowed.has(configured) ? configured : "unknown";
    const readTools=new Set(["ledger_resume","ledger_brief","ledger_search","ledger_get","ledger_stats","ledger_investigation","ledger_investigations","ledger_threads","ledger_thread_get","ledger_records","ledger_record_get","ledger_unassigned","ledger_events","ledger_evidence_search","ledger_artifact_get","ledger_impact","ledger_show_contribution"]);
    const purpose:UsagePurpose=readTools.has(name) || config?.annotations?.readOnlyHint ? "interactive_read" : "maintenance";
    try {
      return await withUsageInvocation(cfg,{tool:name,session_id:resolved.ok ? resolved.id : undefined,identity:resolved.ok ? resolved.identity : undefined,traffic_class,purpose,logical_operation_key:typeof args[0]?.request_id === "string" ? createHash("sha256").update(JSON.stringify([cfg.author,resolved.ok ? resolved.id : null,name,args[0].request_id])).digest("hex") : undefined,version:process.env.LEDGER_BUILD_COMMIT ?? "0.1.0"},async () => {
        const result=await handler(...args);
        const invocation_id=currentUsageInvocationId();
        return invocation_id ? {...result,structuredContent:{...result?.structuredContent,usage:{invocation_id,source:"ledger_server"}}} : result;
      },result => ({outcome:result?.isError ? result?.structuredContent?.outcome === "refusal" ? "refusal" : "error" : "success",availability:result?.isError ? "unavailable" : result?.structuredContent?.availability === "unavailable" ? "unavailable" : (result?.structuredContent?.legacy_candidates?.length || result?.structuredContent?.candidate_count) ? "available" : Array.isArray(result?.structuredContent?.sources) ? result.structuredContent.sources.length ? "available" : "empty" : "unknown",records:recordsOf(result)}));
    } finally {
      // Background, bounded upload. It neither delays this tool result nor starts
      // a new analytical query/evidence obligation. CLI drains explicitly at exit.
      if(cfg.continuity?.database_url) void import("./continuity/db.js").then(async ({getPool}) => {
        const {flushUsage}=await import("./continuity/usage.js");await flushUsage(getPool(cfg));
      }).catch(()=>{});
    }
  })) as typeof server.registerTool;
}


export function invalidateUsageDiskEstimate(): void { diskBytes.delete(usageDirectory()); }
export async function usageSpoolHealth(): Promise<{pending_files:number;pending_bytes:number;oldest_at:string|null;dropped:number;last_error:string|null;coverage:"known"|"unknown";enabled:boolean}> {
  const dir=usageDirectory();let files:string[];
  try {files=await fs.readdir(dir);} catch(e) {return {pending_files:0,pending_bytes:0,oldest_at:null,dropped,last_error:lastError,enabled:process.env.LEDGER_USAGE !== "0",coverage:(e as NodeJS.ErrnoException).code === "ENOENT" ? "known" : "unknown"};}
  let count=0,bytes=0,oldest=Infinity,totalDropped=0,error:string|null=lastError;
  for(const file of files) {
    if(file.endsWith(".status")) {try{const h=JSON.parse(await fs.readFile(path.join(dir,file),"utf8"));totalDropped+=Number(h.dropped)||0;error=h.last_error ?? error;}catch{error="health_unreadable";}continue;}
    if(!file.endsWith(".json"))continue;
    const stat=await fs.stat(path.join(dir,file)).catch(()=>null);if(!stat)continue;count++;bytes+=stat.size;oldest=Math.min(oldest,stat.mtimeMs);
  }
  return {pending_files:count,pending_bytes:bytes,oldest_at:Number.isFinite(oldest)?new Date(oldest).toISOString():null,dropped:Math.max(dropped,totalDropped),last_error:error,enabled:process.env.LEDGER_USAGE !== "0",coverage:error === "health_unreadable" ? "unknown" : "known"};
}
