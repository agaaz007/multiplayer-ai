#!/usr/bin/env node
// Separate controller audit. Never edits the original run or starts model sessions.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateReview,disagreement} from './review-runner.mjs';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
export const digest=x=>crypto.createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const leaves=x=>x&&typeof x==='object'?Object.values(x).flatMap(leaves):[String(x)];

export function normalizeCriticalAliases(raw) {
  const judgment=structuredClone(raw),changes=[],errors=[];
  for(const [index,item] of (judgment.critical_errors??[]).entries()) {
    if(!item||typeof item!=='object')continue;
    for(const [alias,canonical] of [['type','kind'],['rationale','explanation']]) {
      if(!Object.hasOwn(item,alias))continue;
      if(Object.hasOwn(item,canonical)) {
        if(!same(item[canonical],item[alias]))errors.push(`critical_errors.${index}: conflicting ${alias}/${canonical}`);
      } else {item[canonical]=item[alias];changes.push({path:`critical_errors.${index}.${canonical}`,from:alias,value:item[alias]});}
    }
  }
  return {judgment,changes,errors};
}

export function clearanceErrors(clearance,{raw,rawHash,caseId,reviewer,sources}) {
  const errors=[];
  if(!clearance||clearance.case_id!==caseId||clearance.reviewer!==reviewer||clearance.raw_sha256!==rawHash||clearance.residual_sha256!==digest(raw.residual_identification))return ['no exact manually approved residual clearance'];
  if(clearance.manual_review!==true||!clearance.reviewed_by||!clearance.reason)errors.push('manual reviewer and reason required');
  if(!Array.isArray(clearance.entries)||clearance.entries.length!==raw.residual_identification.length)return [...errors,'every residual entry requires separate clearance'];
  for(const [i,entry] of clearance.entries.entries()) {
    const residual=raw.residual_identification[i];
    if(entry.index!==i||!entry.no_vendor_inference_quote||!leaves(residual).some(s=>s.includes(entry.no_vendor_inference_quote)))errors.push(`residual ${i}: exact express no-vendor-inference quote required`);
    if(entry.no_vendor_inference_confirmed!==true)errors.push(`residual ${i}: manual no-inference confirmation required`);
    if(!Array.isArray(entry.public_evidence)||!entry.public_evidence.length)errors.push(`residual ${i}: public entity evidence required`);
    else for(const ev of entry.public_evidence) {
      const source=sources.find(s=>s.id===ev.source);
      if(!source||!ev.quote||!leaves(source).some(s=>s.includes(ev.quote))||!ev.entity||!ev.quote.includes(ev.entity)||!leaves(residual).some(s=>s.includes(ev.entity)))errors.push(`residual ${i}: exact public fixture entity binding required`);
    }
    if(/\b(?:ledger|supermemory|mem0|gbrain|graphify)\b|mcp__/i.test(JSON.stringify(residual)))errors.push(`residual ${i}: real product/native identifier cannot be cleared`);
  }
  return errors;
}

export function auditReceipt({raw,rawHash,receipt,process,request,manifest,item,answer,sources,facts,clearance,inputChecks=[]}) {
  const normalized=normalizeCriticalAliases(raw),errors=[...normalized.errors,...inputChecks];
  const judgment=normalized.judgment;
  let residualCleared=false;
  if(Array.isArray(raw.residual_identification)&&raw.residual_identification.length) {
    const ce=clearanceErrors(clearance,{raw,rawHash,caseId:item.id,reviewer:receipt.reviewer,sources});errors.push(...ce);
    if(!ce.length){judgment.residual_identification=[];residualCleared=true;}
  }
  errors.push(...validateReview(judgment,answer,sources,facts));
  if(process?.timedOut||process?.exitCode!==0||process?.completed!==true)errors.push('unsuccessful or timed-out process');
  if(process?.model!==manifest.model)errors.push('actual process model mismatch');
  if(process?.isolation?.ownReadVerified!==true||!(process?.isolation?.kernelDeniedReads>=2))errors.push('unverified kernel isolation');
  if(!same(process?.usage??null,receipt.usage)||process?.sessionId!==receipt.session_id)errors.push('process usage/session receipt mismatch');
  if(receipt.model!==manifest.model||receipt.reasoning_effort!==manifest.reasoning_effort||request.model!==manifest.model||request.reasoningEffort!==manifest.reasoning_effort)errors.push('model configuration mismatch');
  if(receipt.input_hash!==item.input_hash||digest({answer,sources,fact_keys:facts})!==item.input_hash)errors.push('input hash mismatch');
  if(receipt.status==='reviewed'&&receipt.judgment&&!same(receipt.judgment,raw))errors.push('original reviewed receipt differs from raw judgment');
  if(![receipt.elapsed_ms,receipt.wall_elapsed_ms].every(x=>Number.isFinite(x)&&x>=0&&x<=manifest.timeout_ms+5000)||Math.abs(receipt.elapsed_ms-receipt.wall_elapsed_ms)>5000)errors.push('invalid timing');
  if(request.timeoutMs!==manifest.timeout_ms||Object.keys(request.mcp??{}).length||request.ledgerHooks!==false||request.additionalReadPaths?.length||request.additionalWritePaths?.length||request.hooks||request.forbiddenCanaries?.length<2)errors.push('review isolation request mismatch');
  if(receipt.reviewer===3&&(!Array.isArray(judgment.adjudication_notes)||!judgment.adjudication_notes.length))errors.push('missing adjudication explanations');
  const waived=new Set(['critical error needs kind, explanation and verified passages','residual_identification must be a string array','reviewer reported residual identification; controller inspection required']);
  errors.push(...(receipt.errors??[]).filter(e=>!waived.has(e)).map(e=>'retained original error: '+e));
  return {original_status:receipt.status,original_errors:receipt.errors,status:errors.length?'not_evaluated':'contract_valid',errors:[...new Set(errors)],alias_changes:normalized.changes,residual_manually_cleared:residualCleared,raw_sha256:rawHash,judgment:errors.length?null:judgment};
}

export function auditRun(runPath,clearanceFile,out) {
  const manifest=read(path.join(runPath,'manifest.json')),status=read(path.join(runPath,'status.json'));
  if(status.status!=='ended')throw new Error('post-run audit requires ended original review run');
  if(fs.existsSync(out))throw new Error('audit output must be new');
  const clearances=clearanceFile?read(clearanceFile).clearances:[];
  const result={schema:'pm-review-contract-audit/v2',original_run:path.resolve(runPath),original_manifest_sha256:digest(fs.readFileSync(path.join(runPath,'manifest.json'))),original_status_sha256:digest(fs.readFileSync(path.join(runPath,'status.json'))),amended_source_sha256:digest(fs.readFileSync(fileURLToPath(import.meta.url))),clearance_sha256:clearanceFile?digest(fs.readFileSync(clearanceFile)):null,model_calls:0,original_statuses_unchanged:true,cases:{},required_new_adjudications:[]};
  for(const item of manifest.cases) {
    const answer=read(path.join(item.packet,'answer.json')),sources=read(path.join(item.packet,'sources.json')),required=read(path.join(item.packet,'fact-keys.json')),facts=[...new Set([...required,...Object.keys(answer.facts??{})])];
    const row={original_status:status.cases[item.id]?.status,reviews:{},status:'not_evaluated'};
    for(const n of [1,2,3]) {
      const folder=path.join(runPath,item.id,'reviewer-'+n),rf=path.join(folder,'receipt.json');if(!fs.existsSync(rf))continue;
      try {
        const rawBytes=fs.readFileSync(path.join(folder,'review.raw.json')),raw=JSON.parse(rawBytes),receipt=read(rf),process=read(path.join(folder,'process.json')),request=read(path.join(folder,'request.json')),inputChecks=[];
        for(const [file,value] of [['answer.json',answer],['sources.json',sources],['fact-keys.json',facts]])if(!same(read(path.join(request.worktree,file)),value))inputChecks.push('review workspace changed: '+file);
        if(n<3&&[1,2].some(peer=>fs.existsSync(path.join(request.worktree,'peer-'+peer+'.json'))))inputChecks.push('initial reviewer exposed to peer judgment');
        if(n===3)for(const peer of [1,2])if(!same(read(path.join(request.worktree,'peer-'+peer+'.json')),status.cases[item.id]?.initial_reviews?.[peer-1]?.judgment))inputChecks.push('adjudicator peer input mismatch');
        if(digest(fs.readFileSync(path.join(request.worktree,'rubric.md')))!==manifest.rubric_sha256)inputChecks.push('rubric hash mismatch');
        if(receipt.reviewer!==n||receipt.role!==(n===3?'adjudicator':'independent'))inputChecks.push('reviewer role mismatch');
        if(!same(receipt,n===3?status.cases[item.id]?.adjudication:status.cases[item.id]?.initial_reviews?.[n-1]))inputChecks.push('original status receipt mismatch');
        row.reviews[n]=auditReceipt({raw,rawHash:digest(rawBytes),receipt,process,request,manifest,item,answer,sources,facts,clearance:clearances.find(c=>c.case_id===item.id&&c.reviewer===n),inputChecks});
        row.reviews[n].original_receipt_sha256=digest(fs.readFileSync(rf));
      }catch(error){row.reviews[n]={status:'not_evaluated',errors:[error.message]};}
    }
    if([1,2].every(n=>row.reviews[n]?.status==='contract_valid')) {
      row.disagreement=disagreement(row.reviews[1].judgment,row.reviews[2].judgment);
      if(!row.disagreement.needed){row.status='eligible_agreement';row.proposed_judgment=row.reviews[1].judgment;}
      else if(row.reviews[3]?.status==='contract_valid'){row.status='eligible_existing_adjudication';row.proposed_judgment=row.reviews[3].judgment;}
      else if(row.reviews[3])row.status='not_evaluated_existing_adjudication_failed';
      else {row.status='requires_first_adjudication';result.required_new_adjudications.push({case_id:item.id,stage:item.stage,packet:item.packet,initial_raw_sha256:[row.reviews[1].raw_sha256,row.reviews[2].raw_sha256],peers:[row.reviews[1].judgment,row.reviews[2].judgment],reason:row.disagreement});}
    }
    result.cases[item.id]=row;
  }
  fs.mkdirSync(out,{recursive:false,mode:0o700});fs.writeFileSync(path.join(out,'audit.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),get=k=>args.includes(k)?args[args.indexOf(k)+1]:null;
  if(args[0]!=='audit'||!get('--run')||!get('--out'))throw new Error('usage: review-contract-v2.mjs audit --run ENDED_RUN --out NEW_OUT [--clearances MANUAL.json]');
  const result=auditRun(get('--run'),get('--clearances'),get('--out'));
  console.log(JSON.stringify({cases:Object.fromEntries(Object.entries(result.cases).map(([k,v])=>[k,v.status])),required_new_adjudications:result.required_new_adjudications.length,model_calls:0},null,2));
}
