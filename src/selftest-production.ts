import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertSafeSelftestDatabase, assertSelftestDatabaseMarker } from "./selftest-db-guard.js";
import { boundedRead, availableSection } from "./continuity/availability.js";
import { getPool, migrate, closePools } from "./continuity/db.js";
import { appendEvents, upsertSession } from "./continuity/store.js";
import { startHandoff, updateHandoff, handoffSummary } from "./continuity/handoffs.js";
import { continuityStartContext } from "./hooks.js";
import type { Config } from "./store.js";

const db = process.env.LEDGER_CONTINUITY_DB ?? "";
assertSafeSelftestDatabase(db);
for (const url of ["postgresql://live.example/production", "postgresql://localhost:5432/ledger_selftest", "postgresql://localhost:5432/postgres"]) {
  assert.throws(() => assertSafeSelftestDatabase(url), /refused/);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-production-test-"));
process.env.LEDGER_CONFIG_DIR = path.join(temp, "config");
process.env.LEDGER_GIT_SYNC = "0";
const cfg: Config = {author:"agaaz",ledger_dir:path.join(temp,"ledger"),git_sync:false,continuity:{database_url:db,machine:"fixture"}};
const pool = getPool(cfg);
try {
  await assertSelftestDatabaseMarker(pool);
  await migrate(pool);
  assert.match(continuityStartContext("fixture-session-identity"),/ledger_investigation_bind.*ledger_investigation_new.*ledger_propose_finding/);
  assert.match(continuityStartContext("fixture-session-identity"),/unknown/);

  const timed = await availableSection("Fixture", () => boundedRead(pool, 30, async c => {await c.query("select pg_sleep(2)");return "unexpected";}));
  assert.equal(timed.status,"unavailable");
  assert.equal(timed.reason,"timeout");
  const recovered = await boundedRead(pool,1000,async c => (await c.query("select 1 as n")).rows[0].n);
  assert.equal(recovered,1,"timed-out connection must not poison the pool");
  assert.equal((await availableSection("Fixture",async()=>"")).status,"available_empty");

  const sid = `test-handoff-${randomUUID()}`;
  await upsertSession(pool,{id:sid,author:"agaaz",harness:"codex",machine:"fixture"});
  await appendEvents(pool,sid,[
    {producer_event_id:"verify",kind:"tool.finished",payload:{success:true,output_preview:"Opened original evidence and checked scope"}},
    {producer_event_id:"validate",kind:"tool.finished",payload:{success:true,output_preview:"Continuation validation passed"}},
    {producer_event_id:"deliver",kind:"assistant.message",payload:{text:"Delivered continuation result"}},
    {producer_event_id:"failed",kind:"tool.finished",payload:{success:false}},
  ],null,null);
  const create = (work_kind:"analysis"|"code"="analysis",verified=false,pending=0) => startHandoff(pool,{source_kind:"record",source_id:randomUUID(),destination_session:sid,author:"agaaz",mode:"continue",work_kind,source_snapshot_verified:verified,pending_operations:pending});
  const evidence = (seq:number,role:"verification"|"validation"|"delivered_result"|"pending_operation_resolution") => ({session_id:sid,seq,role});
  const id = await create();
  const base = {id,author:"agaaz",session_id:sid};
  await assert.rejects(updateHandoff(pool,{...base,status:"completed",evidence:[]}),/verification/);
  await assert.rejects(updateHandoff(pool,{...base,author:"rachit",status:"verified",evidence:[evidence(1,"verification")]}),/does not belong/);
  await assert.rejects(updateHandoff(pool,{...base,status:"verified",evidence:[evidence(99,"verification")]}),/unavailable/);
  await assert.rejects(updateHandoff(pool,{...base,status:"verified",evidence:[evidence(4,"verification")]}),/Failed tool/);
  await updateHandoff(pool,{...base,status:"verified",evidence:[evidence(1,"verification")]});
  await assert.rejects(updateHandoff(pool,{...base,status:"completed",evidence:[evidence(2,"validation")]}),/delivered/);
  const completed = await updateHandoff(pool,{...base,status:"completed",evidence:[evidence(2,"validation"),evidence(3,"delivered_result")]});
  assert.equal(completed.status,"completed");
  assert.equal(completed.user_confirmed,false,"an agent's evidence does not assert user acceptance");
  await assert.rejects(updateHandoff(pool,{...base,status:"failed",evidence:[],note:"relabel"}),/terminal/);
  const code = await create("code");
  await assert.rejects(updateHandoff(pool,{...base,id:code,status:"verified",evidence:[evidence(1,"verification")]}),/remotely verified/);
  const pending = await create("analysis",false,1);
  await assert.rejects(updateHandoff(pool,{...base,id:pending,status:"completed",evidence:[evidence(1,"verification"),evidence(2,"validation"),evidence(3,"delivered_result")]}),/pending operations/);
  const failed = await create();
  await assert.rejects(updateHandoff(pool,{...base,id:failed,status:"failed",evidence:[]}),/reason/);
  await updateHandoff(pool,{...base,id:failed,status:"failed",evidence:[],note:"Bootstrap unavailable"});
  const report = await handoffSummary(pool,"2020-01-01","2100-01-01");
  assert.ok(report.rows.some(r=>r.status==="completed"));
  assert.ok(report.rows.some(r=>r.status==="failed"));
  console.log("production selftest: isolation guards, real SQL cancellation/pool recovery, identity context, and evidenced handoff lifecycle passed");
} finally { await closePools(); fs.rmSync(temp,{recursive:true,force:true}); }
