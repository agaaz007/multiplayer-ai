import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, preflight, validateReview, disagreement } from './review-runner.mjs';

const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2));
const dimensions=['framing','synthesis','alternatives','uncertainty','executable_plan','updating'];
const answer={recommendation:'Pause the North pilot and investigate delivery failures.',facts:{guardrail_breached:true},source_ids:['source-001']};
const sources=[{id:'source-001',body:'The failure rate is 3.6%, above the mandatory 2% stop threshold.'}];
function judgment(score=3) {
  return {schema:'pm-independent-review/v2',summary:'Scoped response is supported by the mandatory threshold.',
    dimensions:Object.fromEntries(dimensions.map(name=>[name,{score,rationale:'The answer bounds its action to the affected pilot.',
      evidence:[{source:'answer',quote:answer.recommendation}]}])),
    factual_assessment:{guardrail_breached:{verdict:'supported',rationale:'The observed rate exceeds the mandatory threshold.',
      answer_evidence:[{source:'answer',path:'facts.guardrail_breached',observed:true}],source_evidence:[{source:'source-001',quote:sources[0].body}]}},
    critical_errors:[],residual_identification:[],adjudication_notes:[]};
}
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'review-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const runtime=path.join(root,'runtime');fs.mkdirSync(path.join(runtime,'eval'),{recursive:true});
  fs.writeFileSync(path.join(runtime,'eval/sequence-codex.js'),'// injected sessions only');
  const rubric=path.join(root,'rubric.md');fs.writeFileSync(rubric,'Score every dimension 0-4 using evidence.');
  const packet=path.join(root,'packet');fs.mkdirSync(packet);save(path.join(packet,'answer.json'),answer);save(path.join(packet,'sources.json'),sources);
  save(path.join(packet,'controller-source-map.json'),{private_product:'ledger'});
  const cfg={schema:'pm-review-run/v2',execution_authorized:true,authorization:'fake-session validation only',runtime,runtime_sha256:hash(fs.readFileSync(path.join(runtime,'eval/sequence-codex.js'))),
    rubric,rubric_sha256:hash(fs.readFileSync(rubric)),model:'frozen-test-model',reasoning_effort:'medium',timeout_ms:1000,max_concurrency:2,
    cases:[{id:'case-0001',packet,stage:'D'}]};
  const config=path.join(root,'config.json');save(config,cfg);
  const out=path.join(root,'out');
  t.after(()=>{if(fs.existsSync(path.join(out,'manifest.json')))fs.rmSync(JSON.parse(fs.readFileSync(path.join(out,'manifest.json'))).private_session_root,{recursive:true,force:true});});
  return {root,cfg,config,out,packet};
}
const processResult={exitCode:0,timedOut:false,completed:true,stdout:'{"type":"turn.completed"}\n',stderr:'',usage:{input_tokens:100,output_tokens:40},
  isolation:{ownReadVerified:true,kernelDeniedReads:2},sessionId:'fake-session'};

test('validates real passages and absence without awarding quality for numbers alone',()=>{
  assert.deepEqual(validateReview(judgment(),answer,sources),[]);
  const invalid=judgment();invalid.dimensions.framing.evidence=[{source:'source-999',quote:'invented'}];
  assert.ok(validateReview(invalid,answer,sources).length);
  const missing=judgment();missing.dimensions.framing.evidence=[{source:'answer',missing:'owner'}];
  assert.deepEqual(validateReview(missing,answer,sources),[]);
  missing.dimensions.framing.evidence=[{source:'answer',missing:'recommendation'}];
  assert.ok(validateReview(missing,answer,sources).length);
});

test('two fresh reviewers run independently and agreement needs no third session',async t=>{
  const {config,out}=fixture(t);const calls=[];
  let arrivals=0,release;const together=new Promise(resolve=>release=resolve);
  const result=await run(config,out,{sessionRunner:async input=>{
    calls.push(input);arrivals++;if(arrivals===2)release();await together;
    assert.deepEqual(input.mcp,{});assert.equal(input.ledgerHooks,false);
    assert.equal(fs.existsSync(path.join(input.worktree,'peer-1.json')),false);
    assert.equal(fs.existsSync(path.join(input.worktree,'controller-source-map.json')),false);
    assert.ok(!input.prompt.includes('ledger'));assert.ok(!input.worktree.includes('ledger'));
    save(path.join(input.worktree,'review.json'),judgment());return processResult;
  }});
  assert.equal(calls.length,2);assert.notEqual(calls[0].home,calls[1].home);assert.notEqual(calls[0].worktree,calls[1].worktree);
  assert.equal(result.cases['case-0001'].status,'reviewed_agreement');
  assert.equal(result.cases['case-0001'].agreement.exact_dimensions,6);
  assert.equal(result.cases['case-0001'].initial_reviews[0].usage.input_tokens,100);
  assert.equal(result.calibration.status,'not_provided; results remain uncalibrated');
});

test('disagreements retain both originals and trigger a fresh adjudicator',async t=>{
  const {config,out}=fixture(t);const calls=[];
  const result=await run(config,out,{sessionRunner:async input=>{
    calls.push(input);const adjudicating=fs.existsSync(path.join(input.worktree,'peer-1.json'));
    const review=judgment(adjudicating?3:calls.length===1?2:4);
    if(adjudicating)review.adjudication_notes=['Evidence supports a bounded stop, with a specified follow-up gap.'];
    save(path.join(input.worktree,'review.json'),review);return processResult;
  }});
  assert.equal(calls.length,3);assert.equal(new Set(calls.map(call=>call.home)).size,3);
  const item=result.cases['case-0001'];assert.equal(item.status,'reviewed_after_adjudication');
  assert.equal(item.initial_reviews[0].judgment.dimensions.framing.score,2);
  assert.equal(item.initial_reviews[1].judgment.dimensions.framing.score,4);
  assert.equal(item.final_judgment.dimensions.framing.score,3);
});

test('timeout or invalid evidence remains not-evaluated without retries',async t=>{
  const {config,out}=fixture(t);let calls=0;
  const result=await run(config,out,{sessionRunner:async input=>{
    calls++;save(path.join(input.worktree,'review.json'),judgment());return {...processResult,timedOut:true};
  }});
  assert.equal(calls,2);assert.equal(result.cases['case-0001'].status,'not_evaluated');
  assert.equal(result.cases['case-0001'].final_judgment,undefined);
});

test('modified evidence and reported identity invalidate the assessment',async t=>{
  const {config,out}=fixture(t);
  const result=await run(config,out,{sessionRunner:async input=>{
    const review=judgment();review.residual_identification=['Native provider name was exposed.'];
    save(path.join(input.worktree,'answer.json'),{});save(path.join(input.worktree,'review.json'),review);return processResult;
  }});
  assert.equal(result.cases['case-0001'].status,'not_evaluated');
  assert.ok(result.cases['case-0001'].initial_reviews[0].errors.some(x=>x.includes('modified input')));
});

test('residual product names and changed frozen runtime fail before any sessions',async t=>{
  const {config,out,cfg,packet}=fixture(t);let called=false;
  save(path.join(packet,'answer.json'),{recommendation:'Ledger says pause'});
  await assert.rejects(run(config,out,{sessionRunner:async()=>called=true}),/residual/);assert.equal(called,false);
  save(path.join(packet,'answer.json'),answer);fs.appendFileSync(path.join(cfg.runtime,'eval/sequence-codex.js'),'changed');
  assert.throws(()=>preflight(config),/runtime_sha256/);
});

test('critical-error disagreement triggers adjudication even with identical scores',()=>{
  const first=judgment(),second=judgment();second.critical_errors=[{kind:'mandatory_stop',explanation:'For test disagreement',evidence:[{source:'answer',quote:answer.recommendation}]}];
  assert.equal(disagreement(first,second).needed,true);assert.equal(disagreement(first,second).dimensions.length,0);
});


test('semantic factual verdict disagreement triggers adjudication without dimension differences',()=>{
  const first=judgment(),second=judgment();
  second.factual_assessment.guardrail_breached.verdict='contradicted';
  const delta=disagreement(first,second);
  assert.equal(delta.needed,true);assert.deepEqual(delta.dimensions,[]);
  assert.deepEqual(delta.factual_fields,['guardrail_breached']);
});

test('factual evidence binds exact typed value, preventing a convenient quote from another field',()=>{
  const review=judgment();
  review.factual_assessment.guardrail_breached.answer_evidence[0].observed=false;
  assert.ok(validateReview(review,answer,sources).some(error=>error.includes('exact submitted fact')));
  review.factual_assessment.guardrail_breached.answer_evidence[0]={source:'answer',quote:answer.recommendation};
  assert.ok(validateReview(review,answer,sources).some(error=>error.includes('exact submitted fact')));
});

test('missing required facts stay missing and cannot be awarded supported verdicts',()=>{
  const review=judgment();
  review.factual_assessment.tracking_status={verdict:'missing',rationale:'The required field is absent.',
    answer_evidence:[{source:'answer',missing:'facts.tracking_status'}],source_evidence:[{source:'source-001',quote:sources[0].body}]};
  assert.deepEqual(validateReview(review,answer,sources,['guardrail_breached','tracking_status']),[]);
  review.factual_assessment.tracking_status.verdict='supported';
  assert.ok(validateReview(review,answer,sources,['guardrail_breached','tracking_status']).some(error=>error.includes('absent fact')));
});

test('complete prose including negation is retained for semantic reviewers without keyword normalization',()=>{
  const negated={...answer,facts:{tracking_status:'The activation counts are not provisional.'}};
  const evidence=[{id:'source-001',body:'Reported activation counts are provisional.'}];
  const review=judgment();
  review.factual_assessment={tracking_status:{verdict:'contradicted',rationale:'The claim negates the explicit provisional status.',
    answer_evidence:[{source:'answer',path:'facts.tracking_status',observed:negated.facts.tracking_status}],
    source_evidence:[{source:'source-001',quote:evidence[0].body}]}};
  assert.deepEqual(validateReview(review,negated,evidence),[]);
  assert.equal(review.factual_assessment.tracking_status.verdict,'contradicted');
  assert.ok(review.factual_assessment.tracking_status.answer_evidence[0].observed.includes('not provisional'));
});
