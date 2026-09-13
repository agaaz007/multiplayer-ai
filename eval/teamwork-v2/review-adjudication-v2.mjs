#!/usr/bin/env node
// First adjudications for newly valid pairs; never reruns an initial or an existing third review.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';import crypto from 'node:crypto';
import {preflight,validateReview,disagreement} from './review-runner.mjs';
import {digest} from './review-contract-v2.mjs';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
const adjudicatorText='You are the independent adjudicator. Read peer-1.json and peer-2.json only after assessing the underlying answer/evidence. Resolve their disagreements under the rubric; explain which evidence decides each contested dimension, semantic fact verdict, or critical error in adjudication_notes. Their preferences do not establish truth.';
const originalText='You must form your own judgment; no other reviewer assessment is available.';
const clarification='Output contract clarification: each critical_errors item must contain kind (string), explanation (string), and evidence (array of exact source/answer passages). residual_identification is an array of strings for actual vendor/competitor-arm identification clues. Common fictional task people, markets, product names, and public task filenames are not competitor identities. Do not infer vendor identity from opaque record identifiers; report an unresolved clue only if it could reveal a competitor arm, explaining the evidence. This is a blinding check, separate from whether a cited predecessor artifact is available or a proposal is approved.';

export function planSupplement(configFile,auditFile) {
  const plan=preflight(configFile),audit=read(auditFile),original=read(path.join(audit.original_run,'status.json')),manifest=read(path.join(audit.original_run,'manifest.json'));
  if(original.status!=='ended'||audit.schema!=='pm-review-contract-audit/v2')throw new Error('ended original run and versioned contract audit required');
  if(digest(fs.readFileSync(path.join(audit.original_run,'status.json')))!==audit.original_status_sha256||digest(fs.readFileSync(path.join(audit.original_run,'manifest.json')))!==audit.original_manifest_sha256)throw new Error('original run changed since audit');
  if(digest(fs.readFileSync(configFile))!==manifest.config_sha256||manifest.runner_sha256!==digest(fs.readFileSync(new URL('./review-runner.mjs',import.meta.url))))throw new Error('original configuration/runner freeze mismatch');
  const seen=new Set();
  const cases=audit.required_new_adjudications.map(candidate=>{
    const row=audit.cases[candidate.case_id],item=plan.cases.find(x=>x.id===candidate.case_id);
    if(!item||seen.has(item.id)||row?.status!=='requires_first_adjudication'||row.reviews[3]||fs.existsSync(path.join(audit.original_run,item.id,'reviewer-3')))throw new Error('not an eligible first adjudication: '+candidate.case_id);
    seen.add(item.id);
    if(![1,2].every(n=>row.reviews[n]?.status==='contract_valid')||!same(candidate.peers,[row.reviews[1].judgment,row.reviews[2].judgment])||!disagreement(...candidate.peers).needed)throw new Error('pair is not a retained valid divergent pair');
    for(const n of [1,2])if(digest(fs.readFileSync(path.join(audit.original_run,item.id,'reviewer-'+n,'review.raw.json')))!==candidate.initial_raw_sha256[n-1])throw new Error('initial raw review changed');
    const initialRequest=read(path.join(audit.original_run,item.id,'reviewer-1/request.json'));
    if(initialRequest.prompt.split(originalText).length!==2)throw new Error('unexpected original substantive prompt');
    return {...item,peers:candidate.peers,prompt:initialRequest.prompt.replace(originalText,adjudicatorText)+'\n'+clarification};
  });
  if(cases.length!==Object.values(audit.cases).filter(c=>c.status==='requires_first_adjudication').length)throw new Error('omitted eligible pair');
  return {...plan,cases,audit,originalManifest:manifest,auditHash:digest(fs.readFileSync(auditFile))};
}

export async function runSupplement(configFile,auditFile,out,{sessionRunner}={}) {
  const plan=planSupplement(configFile,auditFile),cfg=plan.cfg;out=path.resolve(out);
  fs.mkdirSync(out,{recursive:false,mode:0o700});
  const privateRoot=fs.mkdtempSync(path.join(os.tmpdir(),'pm-adjudication-'));
  const manifest={schema:'pm-adjudication-supplement/v2',audit_sha256:plan.auditHash,original_run:plan.audit.original_run,config_sha256:digest(fs.readFileSync(configFile)),runner_sha256:digest(fs.readFileSync(fileURLToPath(import.meta.url))),original_runner_sha256:plan.originalManifest.runner_sha256,runtime_sha256:plan.runtimeHash,rubric_sha256:digest(plan.rubric),model:cfg.model,reasoning_effort:cfg.reasoning_effort,timeout_ms:cfg.timeout_ms,private_session_root:privateRoot,billing:plan.originalManifest.billing,calibration:plan.originalManifest.calibration,cases:plan.cases.map(c=>({id:c.id,stage:c.stage,input_hash:c.input_hash,peer_sha256:c.peers.map(digest)}))};
  save(path.join(out,'manifest.json'),manifest);fs.writeFileSync(path.join(out,'controller-canary'),crypto.randomBytes(16).toString('hex'),{flag:'wx',mode:0o600});
  const result={schema:'pm-adjudication-supplement-results/v2',status:'running',cases:{}};
  const checkpoint=()=>{fs.writeFileSync(path.join(out,'.status.tmp'),JSON.stringify(result,null,2)+'\n',{mode:0o600});fs.renameSync(path.join(out,'.status.tmp'),path.join(out,'status.json'));};checkpoint();
  if(!sessionRunner)({runSequenceCodex:sessionRunner}=await import(pathToFileURL(path.join(cfg.runtime,'eval/sequence-codex.js')).href));
  let next=0;
  async function one(item){
    const folder=path.join(out,item.id);fs.mkdirSync(folder,{mode:0o700});
    const root=path.join(privateRoot,crypto.randomBytes(8).toString('hex')),worktree=path.join(root,'workspace'),home=path.join(root,'home');fs.mkdirSync(worktree,{recursive:true,mode:0o700});fs.mkdirSync(home,{mode:0o700});
    const originalRequest=read(path.join(plan.audit.original_run,item.id,'reviewer-1/request.json'));
    const format=read(path.join(originalRequest.worktree,'review-format.json'));
    format.critical_errors=[{kind:'string naming the rubric critical error',explanation:'string stating the evidence-based reason',evidence:[{source:'answer or source-NNN',quote:'exact passage'}]}];
    format.residual_identification=['Only actual or unresolved competitor-arm identity clues; otherwise use an empty array.'];
    for(const [name,value] of Object.entries({'answer.json':item.answer,'sources.json':item.sources,'fact-keys.json':item.fact_keys,'review-format.json':format,'peer-1.json':item.peers[0],'peer-2.json':item.peers[1]}))save(path.join(worktree,name),value);
    fs.writeFileSync(path.join(worktree,'rubric.md'),plan.rubric,{flag:'wx',mode:0o600});const hashes=Object.fromEntries(fs.readdirSync(worktree).map(n=>[n,digest(fs.readFileSync(path.join(worktree,n)))]));
    const request={home,worktree,runtime:cfg.runtime,prompt:item.prompt,model:cfg.model,reasoningEffort:cfg.reasoning_effort,timeoutMs:cfg.timeout_ms,mcp:{},hooks:undefined,hookEnv:{},ledgerHooks:false,extraEnv:{},additionalReadPaths:[],additionalWritePaths:[],allowLocalPostgres:false,caFile:cfg.ca_file,forbiddenCanaries:[path.join(out,'controller-canary'),path.join(out,'manifest.json')]};
    save(path.join(folder,'request.json'),request);save(path.join(folder,'input-hashes.json'),hashes);
    const start=process.hrtime.bigint(),wall=Date.now();let processResult,judgment,errors=[];
    try{
      processResult=await sessionRunner(request);const {policy,...safe}=processResult;save(path.join(folder,'process.json'),safe);fs.writeFileSync(path.join(folder,'stdout.jsonl'),processResult.stdout??'',{flag:'wx',mode:0o600});fs.writeFileSync(path.join(folder,'stderr.txt'),processResult.stderr??'',{flag:'wx',mode:0o600});
      const reviewFile=path.join(worktree,'review.json');if(!fs.existsSync(reviewFile)||fs.lstatSync(reviewFile).isSymbolicLink()||fs.statSync(reviewFile).size>1000000)throw new Error('missing/unsafe/oversized review.json');
      const bytes=fs.readFileSync(reviewFile);fs.writeFileSync(path.join(folder,'review.raw.json'),bytes,{flag:'wx',mode:0o600});judgment=JSON.parse(bytes);errors.push(...validateReview(judgment,item.answer,item.sources,item.fact_keys));
      if(processResult.timedOut||processResult.exitCode!==0||processResult.completed!==true)errors.push('review session did not finish successfully within deadline');
      if(processResult.isolation?.ownReadVerified!==true||!(processResult.isolation?.kernelDeniedReads>=2))errors.push('kernel isolation was not verified');
      if(processResult.model!==cfg.model)errors.push('actual model mismatch');
      if(judgment.residual_identification?.length)errors.push('unresolved residual identification');
      if(!Array.isArray(judgment.adjudication_notes)||!judgment.adjudication_notes.length)errors.push('missing adjudication explanations');
      for(const [name,d] of Object.entries(hashes))if(!fs.existsSync(path.join(worktree,name))||digest(fs.readFileSync(path.join(worktree,name)))!==d)errors.push('modified input '+name);
    }catch(e){errors.push(e.message);}
    const elapsed_ms=Number(process.hrtime.bigint()-start)/1e6,wall_elapsed_ms=Date.now()-wall;
    if(elapsed_ms>cfg.timeout_ms+5000||wall_elapsed_ms>cfg.timeout_ms+5000||Math.abs(elapsed_ms-wall_elapsed_ms)>5000)errors.push('review timing invalid');
    const receipt={schema:'pm-review-receipt/v2',reviewer:3,role:'adjudicator',supplement:true,status:errors.length?'not_evaluated':'reviewed',errors,model:cfg.model,reasoning_effort:cfg.reasoning_effort,elapsed_ms,wall_elapsed_ms,usage:processResult?.usage??null,session_id:processResult?.sessionId??null,billing:manifest.billing,input_hash:item.input_hash,peer_sha256:item.peers.map(digest),judgment:errors.length?null:judgment};save(path.join(folder,'receipt.json'),receipt);return receipt;
  }
  await Promise.all(Array.from({length:Math.min(cfg.max_concurrency??2,plan.cases.length)},async()=>{while(next<plan.cases.length){const item=plan.cases[next++];result.cases[item.id]={status:'running'};checkpoint();try{result.cases[item.id]=await one(item);}catch(error){result.cases[item.id]={status:'not_evaluated',error:error.message};}checkpoint();}}));
  result.status='ended';checkpoint();return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
  if(args[0]!=='run'||!args.includes('--config')||!args.includes('--audit')||!args.includes('--out'))throw new Error('usage: review-adjudication-v2.mjs run --config ORIGINAL_CONFIG --audit AUDIT.json --out NEW_OUT');
  const result=await runSupplement(get('--config'),get('--audit'),get('--out'));console.log(JSON.stringify({status:result.status,cases:Object.fromEntries(Object.entries(result.cases).map(([k,v])=>[k,v.status]))}));
}
