import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSafeSelftestDatabase, assertSelftestDatabaseMarker } from './selftest-db-guard.js';
import { getPool, migrate, closePools } from './continuity/db.js';
import * as S from './continuity/store.js';
import { createRecord, linkSpan } from './continuity/records.js';
import { buildResumePack } from './continuity/resume.js';
import { buildRecordPack } from './continuity/recordpack.js';
import { snapshotBootstrap, type VerifiedSnapshot } from './continuity/snapshot-evidence.js';
import { initLedger, type Config } from './store.js';

const DB=process.env.LEDGER_CONTINUITY_DB;
if (!DB) throw new Error('Run selftest-resume-verification through scripts/test-isolated.mjs');
assertSafeSelftestDatabase(DB);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ledger-resume-verification-'));
process.env.LEDGER_CONFIG_DIR=path.join(tmp,'config');process.env.LEDGER_GIT_SYNC='0';
const cfg:Config={ledger_dir:path.join(tmp,'ledger'),author:'agaaz',git_sync:false,continuity:{database_url:DB}};
initLedger(cfg.ledger_dir,cfg.author);
const pool=getPool(cfg);
const T=(n:number)=>new Date(Date.now()-100_000+n*1000);
const repo='https://example.test/fixture/repo';
const A='a'.repeat(40), B='b'.repeat(40), C='c'.repeat(40), BASE='d'.repeat(40);
async function fixture(name:string) {
  const sid=`verification-${name}`;
  await S.upsertSession(pool,{id:sid,author:'rachit',harness:'codex',repo,last_seen_at:T(50)});
  const thread=await S.createThread(pool,{repo,title:`Verification ${name}`,created_by:'rachit'});
  const claim=await S.claimThread(pool,thread.id,sid,'rachit');assert.ok(claim.ok);
  const generation=claim.generation;
  const events=await S.appendEvents(pool,sid,[{producer_event_id:'pending',kind:'tool.requested',call_id:'pending-mutation',occurred_at:T(40).toISOString(),payload:{tool:'Bash',input:'perform a mutation; outcome unknown'}}],thread.id,generation);
  const record=await createRecord(pool,{kind:'investigation',title:`Verification ${name}`,repo,created_by:'rachit'});
  await linkSpan(pool,{record_id:record.id,session_id:sid,from_seq:1,to_seq:events.lastSeq,source:'explicit',created_by:'rachit'});
  const ref=`refs/wip/rachit/${sid}`;
  return {sid,thread,record,generation,ref};
}
try {
  await assertSelftestDatabaseMarker(pool);await migrate(pool);
  const f=await fixture('older-verified');
  const stamp=T(10);
  const good=await S.publishCheckpoint(pool,{thread_id:f.thread.id,session_id:f.sid,generation:f.generation,kind:'snapshot',through_event_seq:1,base_commit:BASE,wip_ref:f.ref,wip_commit:A,verified_snapshot_at:stamp,verified_events_at:T(5)});
  await pool.query('update cont_checkpoints set created_at=$2 where id=$1',[good.id,T(12)]);
  const bad=await S.publishCheckpoint(pool,{thread_id:f.thread.id,session_id:f.sid,generation:f.generation,kind:'turn',through_event_seq:1,base_commit:BASE,wip_ref:f.ref,wip_commit:B,capture_gaps:[{kind:'snapshot_not_verified'}]});
  assert.ok(bad.advanced);
  // Reproduce a legacy row whose commit changed independently from its old verified timestamp.
  await S.updateSession(pool,f.sid,{wip_ref:f.ref,wip_commit:B,last_verified_snapshot_at:stamp});
  const resumed=await buildResumePack(cfg,pool,f.thread.id,{mode:'inspect',author:'agaaz'});
  assert.equal(resumed.checkpoint?.wip_commit,B,'the latest failed checkpoint remains visible as evidence');
  assert.equal(resumed.checkpoint?.verified_snapshot_at,null);
  assert.equal(resumed.snapshot?.commit,A);assert.equal(resumed.snapshot?.checkpoint_id,good.id);
  assert.equal(resumed.snapshot?.verified_at.toISOString(),stamp.toISOString());
  assert.equal(resumed.loss_window.verified_snapshot_commit,A);
  assert.equal(resumed.loss_window.unsaved_code_seconds,null,'verification time cannot bound later edits');
  assert.ok(resumed.bootstrap.some(s=>s.includes(`--detach ../verification-older-verified ${A}`)));
  assert.ok(!resumed.bootstrap.some(s=>s.includes(B)));
  assert.equal(resumed.pending_operations[0]?.call_id,'pending-mutation');
  assert.match(resumed.text,/do not blindly rerun if it mutates anything/);
  assert.match(resumed.text,/unverified or unselected commit/);
  const record=await buildRecordPack(cfg,pool,f.record.id,{mode:'inspect',author:'agaaz'});
  assert.equal(record.snapshot?.commit,A);assert.equal(record.snapshot?.checkpoint_id,good.id);
  assert.equal(record.contributing_sessions[0].wip_commit,A,'session metadata is projected only from exact checkpoint proof');
  assert.equal(record.pending_operations[0]?.call_id,'pending-mutation');
  assert.ok(record.bootstrap.every(s=>!s.includes(B)));
  assert.match(record.text,new RegExp(A.slice(0,12)));
  assert.ok(record.bootstrap.some(s=>s.includes(`Original source base: ${BASE}`)));
  assert.ok(!record.bootstrap.some(s=>/^git .*\b(rebase|merge)\b/.test(s)));
  assert.ok(record.bootstrap.some(s=>s.includes('Do not apply a full-tree diff')));

  const cutoff=T(8).toISOString();
  assert.equal((await buildResumePack(cfg,pool,f.thread.id,{mode:'inspect',author:'agaaz',asOf:cutoff})).snapshot,null,'future verification cannot leak into as-of history');
  assert.equal((await buildRecordPack(cfg,pool,f.record.id,{mode:'inspect',author:'agaaz',asOf:cutoff})).snapshot,null);

  const unverified=await fixture('never-verified');
  await S.publishCheckpoint(pool,{thread_id:unverified.thread.id,session_id:unverified.sid,generation:unverified.generation,kind:'turn',through_event_seq:1,wip_ref:unverified.ref,wip_commit:B});
  await S.updateSession(pool,unverified.sid,{wip_ref:unverified.ref,wip_commit:B,last_verified_snapshot_at:T(10)});
  const noProof=await buildResumePack(cfg,pool,unverified.thread.id,{mode:'inspect',author:'agaaz'});
  assert.equal(noProof.snapshot,null);assert.deepEqual(noProof.bootstrap,[]);assert.equal(noProof.loss_window.verified_snapshot_at,null);
  const noRecordProof=await buildRecordPack(cfg,pool,unverified.record.id,{mode:'inspect',author:'agaaz'});
  assert.equal(noRecordProof.snapshot,null);assert.deepEqual(noRecordProof.bootstrap,[]);
  assert.equal(noRecordProof.contributing_sessions[0].verified_snapshot_at,null);
  // Remote verification from a rejected/stale generation must not become accepted executable authority.
  const stale=await S.publishCheckpoint(pool,{thread_id:unverified.thread.id,session_id:unverified.sid,generation:-1,kind:'snapshot',through_event_seq:1,wip_ref:unverified.ref,wip_commit:C,verified_snapshot_at:T(20)});
  assert.equal(stale.advanced,false);
  assert.equal((await buildResumePack(cfg,pool,unverified.thread.id,{mode:'inspect',author:'agaaz'})).snapshot,null);
  // A record's unrelated contributors cannot donate a snapshot from outside its code repositories.
  await pool.query('update cont_threads set repo=$2 where id=$1',[f.thread.id,'https://example.test/another/repo']);
  assert.equal((await buildRecordPack(cfg,pool,f.record.id,{mode:'inspect',author:'agaaz'})).snapshot,null);

  const hostile={...record.snapshot!,ref:"refs/wip/fixture/$(touch SHOULD_NOT_RUN)"} satisfies VerifiedSnapshot;
  const command=snapshotBootstrap(hostile,'safe title')[0];
  assert.match(command,/git fetch origin 'refs\/wip/,'dynamic snapshot ref must be shell quoted');
  console.log('resume verification: exact checkpoint pairs, older verified fallback, as-of bounds, stale generation exclusion, pending operations, repository scope, and safe orphan bootstrap passed');
} finally {await closePools();fs.rmSync(tmp,{recursive:true,force:true});}
