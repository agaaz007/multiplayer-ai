import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCriticalAliases,clearanceErrors,auditReceipt,digest,auditRun} from './review-contract-v2.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const answer={recommendation:'Pause the pilot.',facts:{breach:true}};
const sources=[{id:'source-001',body:'Relay planning owner Priya orders a stop.'}];
function fixture(){
  const raw={schema:'pm-independent-review/v2',summary:'The stop is supported.',dimensions:Object.fromEntries(['framing','synthesis','alternatives','uncertainty','executable_plan','updating'].map(k=>[k,{score:3,rationale:'Bounded stop.',evidence:[{source:'answer',quote:answer.recommendation}]}])),factual_assessment:{breach:{verdict:'supported',rationale:'A stop is ordered.',answer_evidence:[{source:'answer',path:'facts.breach',observed:true}],source_evidence:[{source:'source-001',quote:sources[0].body}]}},critical_errors:[],residual_identification:[],adjudication_notes:[]};
  const input_hash=digest({answer,sources,fact_keys:['breach']});
  return {raw,rawHash:digest(raw),answer,sources,facts:['breach'],item:{id:'case-0001',input_hash},manifest:{model:'test-model',reasoning_effort:'medium',timeout_ms:1000},receipt:{reviewer:1,role:'independent',status:'reviewed',errors:[],model:'test-model',reasoning_effort:'medium',input_hash,elapsed_ms:20,wall_elapsed_ms:20,usage:{output_tokens:2},session_id:'test-session'},process:{model:'test-model',completed:true,timedOut:false,exitCode:0,isolation:{ownReadVerified:true,kernelDeniedReads:2},usage:{output_tokens:2},sessionId:'test-session'},request:{model:'test-model',reasoningEffort:'medium',timeoutMs:1000,mcp:{},ledgerHooks:false,additionalReadPaths:[],additionalWritePaths:[],forbiddenCanaries:['a','b']}};
}
function addClearance(f){
  f.raw.residual_identification=[{entity:'Priya',assessment:'Public fixture person; no vendor or arm identity is inferred.'}];f.rawHash=digest(f.raw);
  f.clearance={case_id:f.item.id,reviewer:1,raw_sha256:f.rawHash,residual_sha256:digest(f.raw.residual_identification),manual_review:true,reviewed_by:'controller',reason:'Only the publicly named planning owner.',entries:[{index:0,no_vendor_inference_quote:'no vendor or arm identity is inferred',no_vendor_inference_confirmed:true,public_evidence:[{source:'source-001',entity:'Priya',quote:sources[0].body}]}]};return f;
}
test('aliases retain raw content and unchanged critical evidence',()=>{
  const raw={critical_errors:[{type:'authority',rationale:'No ratification',evidence:[{source:'answer',quote:'Pause'}]}]};const before=JSON.stringify(raw),r=normalizeCriticalAliases(raw);
  assert.equal(JSON.stringify(raw),before);assert.equal(r.judgment.critical_errors[0].kind,'authority');assert.deepEqual(r.judgment.critical_errors[0].evidence,raw.critical_errors[0].evidence);assert.equal(r.changes.length,2);
});
test('conflicting aliases are rejected instead of choosing a favorable judgment',()=>{
  const r=normalizeCriticalAliases({critical_errors:[{kind:'x',type:'y',explanation:'one',rationale:'two'}]});assert.equal(r.errors.length,2);
});
test('already canonical equal aliases require no semantic rewrite',()=>{
  const r=normalizeCriticalAliases({critical_errors:[{kind:'x',type:'x',explanation:'same',rationale:'same'}]});assert.deepEqual(r.errors,[]);assert.deepEqual(r.changes,[]);
});
test('manual clearance binds raw hash, exact public entity, and no-inference quote',()=>{
  const f=addClearance(fixture());assert.equal(auditReceipt(f).status,'contract_valid');
  f.clearance.raw_sha256='wrong';assert.equal(auditReceipt(f).status,'not_evaluated');
});
test('unknown or actual product identifiers cannot be cleared',()=>{
  const f=addClearance(fixture());f.raw.residual_identification[0].entity='Ledger';f.rawHash=digest(f.raw);f.clearance.raw_sha256=f.rawHash;f.clearance.residual_sha256=digest(f.raw.residual_identification);
  assert.ok(auditReceipt(f).errors.some(e=>e.includes('real product')));
});
test('fixture-like text without manual clearance remains invalid',()=>{
  const f=addClearance(fixture());delete f.clearance;assert.equal(auditReceipt(f).status,'not_evaluated');
});
test('clearance cannot invent a public source quote or waive missing express no-inference',()=>{
  const f=addClearance(fixture());f.clearance.entries[0].public_evidence[0].quote='Invented';assert.equal(auditReceipt(f).status,'not_evaluated');
  f.clearance.entries[0].public_evidence[0].quote=sources[0].body;f.clearance.entries[0].no_vendor_inference_quote='not in review';assert.equal(auditReceipt(f).status,'not_evaluated');
});
test('format normalization cannot repair fabricated evidence or changed fact values',()=>{
  const f=fixture();f.raw.critical_errors=[{type:'wrong',rationale:'Bad',evidence:[{source:'source-001',quote:'fabricated'}]}];assert.equal(auditReceipt(f).status,'not_evaluated');
  f.raw.critical_errors=[];f.raw.factual_assessment.breach.answer_evidence[0].observed=false;assert.equal(auditReceipt(f).status,'not_evaluated');
});
test('timeout, isolation, timing, input hashes, and retained infrastructure errors stay invalid',()=>{
  for(const mutate of [f=>f.process.timedOut=true,f=>f.process.isolation.kernelDeniedReads=1,f=>f.receipt.elapsed_ms=7000,f=>f.receipt.input_hash='other',f=>f.receipt.errors=['reviewer modified input answer.json']]){const f=fixture();mutate(f);assert.equal(auditReceipt(f).status,'not_evaluated');}
});
test('post-run gate rejects active reviews without creating an output',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'review-contract-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'manifest.json'),'{}');fs.writeFileSync(path.join(root,'status.json'),JSON.stringify({status:'running'}));
  assert.throws(()=>auditRun(root,null,path.join(root,'audit')),/ended/);assert.equal(fs.existsSync(path.join(root,'audit')),false);
});
