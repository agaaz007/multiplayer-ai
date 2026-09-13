#!/usr/bin/env node
// Public-input review self-check: structure and literal evidence only, never decision quality.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const DIMENSIONS=['framing','synthesis','alternatives','uncertainty','executable_plan','updating'];
const canonical=value=>JSON.stringify(value);
function leaves(value) {
  if(value===null||typeof value!=='object')return [String(value)];
  return Object.values(value).flatMap(leaves);
}
function evidenceValid(item,answer,sources) {
  if(!item||typeof item!=='object'||typeof item.source!=='string')return false;
  const content=item.source==='answer'?answer:sources.find(source=>source.id===item.source);
  if(!content)return false;
  if(typeof item.path==='string'&&item.source==='answer'&&Object.hasOwn(item,'observed')) {
    let value=answer;
    for(const segment of item.path.split('.'))value=value&&typeof value==='object'?value[segment]:undefined;
    return value!==undefined&&canonical(value)===canonical(item.observed);
  }
  if(typeof item.missing==='string'&&item.source==='answer') {
    const segments=item.missing.split('.');let value=answer;
    for(const segment of segments)value=value&&typeof value==='object'?value[segment]:undefined;
    return value===undefined||value===null||value===''||(Array.isArray(value)&&value.length===0);
  }
  return typeof item.quote==='string'&&item.quote.trim().length>0&&
    [JSON.stringify(content,null,2),...leaves(content)].some(text=>text.includes(item.quote));
}

function factKeys(answer,required=[]) {
  const actual=answer?.facts&&typeof answer.facts==='object'&&!Array.isArray(answer.facts)?Object.keys(answer.facts):[];
  return [...new Set([...required,...actual])];
}

export function validateReview(review,answer,sources,requiredFactKeys=[]) {
  const errors=[];
  if(!review||typeof review!=='object'||Array.isArray(review))return ['review must be an object'];
  if(review.schema!=='pm-independent-review/v2')errors.push('wrong review schema');
  if(typeof review.summary!=='string'||!review.summary.trim())errors.push('summary required');
  for(const dimension of DIMENSIONS) {
    const value=review.dimensions?.[dimension];
    if(!Number.isInteger(value?.score)||value.score<0||value.score>4)errors.push(dimension+': integer score 0-4 required');
    if(typeof value?.rationale!=='string'||!value.rationale.trim())errors.push(dimension+': rationale required');
    if(!Array.isArray(value?.evidence)||value.evidence.length===0||!value.evidence.every(item=>evidenceValid(item,answer,sources)))errors.push(dimension+': exact source/answer evidence required');
  }
  const required=factKeys(answer,requiredFactKeys),assessments=review.factual_assessment;
  if(!assessments||typeof assessments!=='object'||Array.isArray(assessments)||
    canonical(Object.keys(assessments).sort())!==canonical([...required].sort()))errors.push('factual_assessment must cover exactly all required/submitted fact keys');
  for(const key of required) {
    const fact=assessments?.[key],present=Object.hasOwn(answer.facts??{},key);
    if(!['supported','contradicted','unclear','missing'].includes(fact?.verdict))errors.push(key+': semantic factual verdict required');
    if(fact?.verdict==='missing'&&present)errors.push(key+': submitted fact cannot be marked missing');
    if(!present&&fact?.verdict!=='missing')errors.push(key+': absent fact must be marked missing');
    if(typeof fact?.rationale!=='string'||!fact.rationale.trim())errors.push(key+': factual rationale required');
    const claimEvidence=fact?.answer_evidence;
    const expectedPath='facts.'+key;
    if(!Array.isArray(claimEvidence)||!claimEvidence.length||!claimEvidence.every(item=>
      item.source==='answer'&&(present?item.path===expectedPath&&Object.hasOwn(item,'observed'):item.missing===expectedPath)&&evidenceValid(item,answer,sources)))errors.push(key+': evidence must bind the exact submitted fact value or its absence');
    if(!Array.isArray(fact?.source_evidence)||!fact.source_evidence.length||!fact.source_evidence.every(item=>item.source!=='answer'&&evidenceValid(item,answer,sources)))errors.push(key+': exact source passages required for semantic factual assessment');
  }
  if(!Array.isArray(review.critical_errors))errors.push('critical_errors must be an array');
  else for(const error of review.critical_errors) {
    if(typeof error?.kind!=='string'||!error.kind.trim()||typeof error?.explanation!=='string'||!error.explanation.trim()||
      !Array.isArray(error.evidence)||!error.evidence.length||!error.evidence.every(item=>evidenceValid(item,answer,sources)))errors.push('critical error needs kind, explanation and verified passages');
  }
  if(!Array.isArray(review.residual_identification)||review.residual_identification.some(x=>typeof x!=='string'))errors.push('residual_identification must be a string array');
  return errors;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const read=name=>JSON.parse(fs.readFileSync(name,'utf8'));
    const errors=validateReview(read('review.json'),read('answer.json'),read('sources.json'),read('fact-keys.json'));
    console.log(JSON.stringify({valid:errors.length===0,errors},null,2));process.exitCode=errors.length?1:0;
  }catch(error){console.log(JSON.stringify({valid:false,errors:[error.message]}));process.exitCode=1;}
}
