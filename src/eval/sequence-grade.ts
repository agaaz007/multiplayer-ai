import { executeSql } from './analytical-oracle.js';
import fs from 'node:fs';
import { ownedPath, sha256, type AnalyticalTask, type Oracle } from './analytical-contract.js';
import { verifySequenceContent } from './sequence-freeze.js';
import { SequenceOracleSchema, SequenceTaskSchema } from './sequence-contract.js';

const normalized = (value: any): any => Array.isArray(value) ? value.map(normalized)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,normalized(v)]))
  : typeof value === 'number' ? Math.round(value * 1e10) / 1e10 : value;
const same = (a: unknown,b: unknown) => JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));

/** Execution correctness is separate from lineage. Controller-created logical IDs are not proof of memory reuse. */
export function gradeSequenceSql(task: AnalyticalTask, oracle: Oracle, answer: any, trace: any[]) {
  if(oracle.kind!=='sql')throw new Error('sequence SQL grade requires SQL oracle');
  const executed = trace.some(e=>e.operation==='query_data' && e.detail?.success && e.detail.sqlHash===sha256(String(answer?.sql??'')));
  let resultCorrect=false,holdoutsCorrect=false,error: string|undefined;
  try {
    const actual=executeSql(task.data,answer?.sql);
    resultCorrect=same(actual,executeSql(task.data,oracle.sql))&&same(answer?.result,actual);
    holdoutsCorrect=oracle.holdouts.every(data=>same(executeSql(data,answer.sql),executeSql(data,oracle.sql)));
  } catch(e) { error=e instanceof Error?e.message:'SQL evaluation failed'; }
  return {schema:'sequence-sql-grade/v1',executed,resultCorrect,holdoutsCorrect,
    scored:false,
    executableCompletion:task.executable&&executed&&resultCorrect&&holdoutsCorrect,
    reuse:'not_evaluated',impact:'not_evaluated',criticalProseErrors:'not_evaluated',
    sequenceSuccess:null,error,
    limitation:'Requires separate trace-backed review of actual predecessor contributions, affected work and unsupported claims. Logical labels or a correct result alone do not demonstrate cumulative reuse.'};
}

/** Actual grading entry: refuses absent/tampered freezes and unlisted task/oracle inputs. */
export function gradeFrozenSequenceSql(input: {root: string; manifestFile: string; taskFile: string; oracleFile: string;
  stage: 'A'|'B'|'C'|'D'; answer: unknown; trace: unknown[]}) {
  const freeze=verifySequenceContent(input.root,input.manifestFile);
  for(const file of [input.taskFile,input.oracleFile])if(!freeze.files[file])throw new Error('grading input is not in the frozen manifest');
  const task=SequenceTaskSchema.parse(JSON.parse(fs.readFileSync(ownedPath(input.root,input.taskFile),'utf8')));
  const oracles=SequenceOracleSchema.parse(JSON.parse(fs.readFileSync(ownedPath(input.root,input.oracleFile),'utf8')));
  if(!freeze.taskIds.includes(task.id)||oracles.taskId!==task.id)throw new Error('grading task does not match the frozen sequence');
  const stage=task.stages.find(s=>s.stage===input.stage),oracle=oracles.stages.find(s=>s.stage===input.stage);
  if(!stage||!oracle)throw new Error('missing frozen stage');
  return {...gradeSequenceSql(stage.task,oracle.oracle,input.answer,input.trace),scored:true,
    sourceFreezeSha256:sha256(fs.readFileSync(input.manifestFile)),realDataSha256:freeze.realData.sha256,
    scope:'stage SQL correctness only; runtime fairness, lineage, prose, impact and whole-pilot success require their separate evidence'};
}
