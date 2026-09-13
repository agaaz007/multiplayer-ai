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
  return typeof item.quote==='string'&&item.quote.trim().length>0&&
    [JSON.stringify(content,null,2),...leaves(content)].some(text=>text.includes(item.quote));
}

export const FACTUAL_CATEGORIES=['numeric_result','scope_and_denominator','decision_authority','predecessor_attribution','operation_state'];
export function validateReview(review,answer,sources,required=FACTUAL_CATEGORIES) {
  const errors=[];
  if(!review||typeof review!=='object'||Array.isArray(review))return ['review must be an object'];
  if(review.schema!=='pm-continuation-review/v3')errors.push('wrong review schema');
  if(typeof review.summary!=='string'||!review.summary.trim())errors.push('summary required');
  function evidence(items,label,both=false){
    if(!Array.isArray(items)||!items.length||!items.every(item=>evidenceValid(item,answer,sources)))errors.push(label+': exact source/answer evidence required');
    else if(both&&(!items.some(item=>item.source==='answer')||!items.some(item=>item.source!=='answer')))errors.push(label+': cite both answer and source evidence');
  }
  for(const dimension of DIMENSIONS){const value=review.dimensions?.[dimension];
    if(!Number.isInteger(value?.score)||value.score<0||value.score>4)errors.push(dimension+': integer score 0-4 required');
    if(typeof value?.rationale!=='string'||!value.rationale.trim())errors.push(dimension+': rationale required');
    evidence(value?.evidence,dimension);
  }
  const facts=review.factual_assessment;
  if(!facts||typeof facts!=='object'||Array.isArray(facts)||canonical(Object.keys(facts).sort())!==canonical([...FACTUAL_CATEGORIES].sort()))errors.push('factual_assessment must contain the five fixed factual categories');
  for(const key of FACTUAL_CATEGORIES){const value=facts?.[key];
    if(!['supported','contradicted','unclear','not_stated','not_applicable'].includes(value?.verdict))errors.push(key+': valid factual verdict required');
    if(typeof value?.rationale!=='string'||!value.rationale.trim())errors.push(key+': rationale required');
    evidence(value?.evidence,key,true);
  }
  if(!Array.isArray(review.critical_errors))errors.push('critical_errors must be an array');
  else for(const error of review.critical_errors){
    if(typeof error?.kind!=='string'||!error.kind.trim()||typeof error?.explanation!=='string'||!error.explanation.trim())errors.push('critical error requires kind and explanation strings');
    evidence(error?.evidence,'critical error',true);
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
