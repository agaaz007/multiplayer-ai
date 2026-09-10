import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SequenceTaskSchema, SequenceOracleSchema } from './sequence-contract.js';
import { freezeSequenceContent, validateRealHiAstro, verifySequenceContent } from './sequence-freeze.js';
import { sha256 } from './analytical-contract.js';
import { sequenceSeatbelt, verifySequenceSeatbelt } from './sequence-isolation.js';
import { gradeFrozenSequenceSql } from './sequence-grade.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-sequence-tests-'));
let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`ok ${passed} - ${name}`); }
try {
  // Invented rows exercise validators only. They are never eligible for the real pilot.
  const row = ['a'.repeat(64),'2026-09-06',23,null,1,1,0,0,0];
  const raw = { columns: ['user_id','day','current_config','assignment_config','canonical_login_events','legacy_login_events','trial_all','trial_499','trial_199'], rows: [row] };
  const bytes = JSON.stringify(raw);
  fs.writeFileSync(path.join(root,'data.json'),bytes);
  const manifest = { schema:'real-hiastro-freeze/v1', valid:true,synthetic:false,sha256:sha256(bytes),rowCount:1,
    source:'unit test assertion only; not an actual source export',queryFile:'query.sql',definition:'unit-test',
    windowStart:'2026-09-05T18:30:00Z',windowEndExclusive:'2026-09-09T18:30:00Z' };
  const writeManifest = (patch={}) => fs.writeFileSync(path.join(root,'data-manifest.json'),JSON.stringify({...manifest,...patch}));
  const validate = () => validateRealHiAstro(path.join(root,'data.json'),path.join(root,'data-manifest.json'));
  writeManifest();
  test('rejects an explicitly synthetic or invalid source before scoring', () => {
    writeManifest({synthetic:true});assert.throws(validate);writeManifest({valid:false});assert.throws(validate);writeManifest();
  });
  test('detects changed bytes even when the row structure is valid', () => {
    fs.appendFileSync(path.join(root,'data.json'),' ');assert.throws(validate,/hash/);fs.writeFileSync(path.join(root,'data.json'),bytes);
  });
  test('rejects duplicate user-days and the failed all-zero login export', () => {
    for (const rows of [[row,row],[[...row.slice(0,4),0,0,0,0,0]]]) {
      const text=JSON.stringify({...raw,rows});fs.writeFileSync(path.join(root,'data.json'),text);writeManifest({sha256:sha256(text),rowCount:rows.length});assert.throws(validate);
    }
    fs.writeFileSync(path.join(root,'data.json'),bytes);writeManifest();
  });
  const data = validate().data;
  const evidence = [{id:'source',title:'source',content:'test only',author:'unit-test',recordedAt:'2026-09-10T00:00:00Z',effectiveAt:'2026-09-10T00:00:00Z',status:'evidence',kind:'artifact',scope:{},dependsOn:[],sourceRef:'test'}];
  const task = (kind='corrected-analysis'): any => ({id:kind,title:kind,provenance:{realDataFile:path.join(root,'data.json'),realDataSha256:manifest.sha256,sourceNote:'unit test only',benchmarkAdditions:[]},
    stages:'ABCD'.split('').map((stage,i)=>({stage,inputs:[{relativePath:'input.txt',content:'test'}],reuseRequirements:i===2?[{from:'A',contribution:'a'},{from:'B',contribution:'b'}]:i===3?[{from:'C',contribution:'c'}]:[],
      task:{version:1,id:kind+'-'+stage,title:stage,kind,provenance:{classification:'approved-local-import',externalExportAllowed:true,sourceRefs:['unit-test'],permissionNote:'unit-test'},prompt:'unit-test',executable:true,evidence,artifacts:[],data,
        ...(kind==='coding-handoff'?{coding:{sourceRepo:root,commit:'1'.repeat(40),sourceRecord:'test',sourceArtifacts:['test']}}:{})}}))});
  test('requires A/B/C/D in order and distinct A/B contributions for C', () => {
    const t=task();assert.ok(SequenceTaskSchema.safeParse(t).success);t.stages.reverse();assert.equal(SequenceTaskSchema.safeParse(t).success,false);
    const c=task();c.stages[2].reuseRequirements.pop();assert.equal(SequenceTaskSchema.safeParse(c).success,false);
    const f=task();f.stages[1].reuseRequirements=[{from:'D',contribution:'future'}];assert.equal(SequenceTaskSchema.safeParse(f).success,false);
  });
  test('rejects input traversal, duplicate paths and repeated oracle stages', () => {
    for (const p of ['../private','/controller','a/../../x','a\\..\\x']) {const t=task();t.stages[0].inputs[0].relativePath=p;assert.equal(SequenceTaskSchema.safeParse(t).success,false);}
    const t=task();t.stages[0].inputs.push(t.stages[0].inputs[0]);assert.equal(SequenceTaskSchema.safeParse(t).success,false);
    const oracle={kind:'sql',definitionId:'test',sql:'select 1',requiredEvidence:[],affected:[],holdouts:[[]]};
    assert.equal(SequenceOracleSchema.safeParse({taskId:'test',stages:['A','B','C','C'].map(stage=>({stage,oracle}))}).success,false);
  });
  for (const kind of ['corrected-analysis','coding-handoff']) fs.writeFileSync(path.join(root,kind+'.json'),JSON.stringify(task(kind)));
  fs.writeFileSync(path.join(root,'query.sql'),'-- unit test');
  const input={dataFile:'data.json',dataManifest:'data-manifest.json',taskFiles:['corrected-analysis.json','coding-handoff.json'],requiredFiles:['query.sql'],destination:'frozen.json'};
  test('binds both tasks to one dataset and refuses missing coding data', () => {
    const bad=task('coding-handoff');delete bad.stages[3].task.data;
    fs.writeFileSync(path.join(root,'coding-handoff.json'),JSON.stringify(bad));assert.throws(()=>freezeSequenceContent(root,input),/data/);
    fs.writeFileSync(path.join(root,'coding-handoff.json'),JSON.stringify(task('coding-handoff')));
  });
  test('freeze is exclusive and later verification detects changed contracts', () => {
    freezeSequenceContent(root,input);assert.throws(()=>freezeSequenceContent(root,input));
    assert.equal(verifySequenceContent(root,path.join(root,'frozen.json')).realData.rowCount,1);
    fs.appendFileSync(path.join(root,'query.sql'),'\n-- changed');assert.throws(()=>verifySequenceContent(root,path.join(root,'frozen.json')),/changed/);
  });
  test('the scored entry refuses missing or tampered freezes before reading answers', () => {
    const input={root,manifestFile:path.join(root,'missing-freeze.json'),taskFile:'corrected-analysis.json',oracleFile:'oracle.json',stage:'C' as const,answer:{},trace:[]};
    assert.throws(()=>gradeFrozenSequenceSql(input));
    assert.throws(()=>gradeFrozenSequenceSql({...input,manifestFile:path.join(root,'frozen.json')}),/changed/);
    fs.writeFileSync(path.join(root,'query.sql'),'-- unit test');
    assert.throws(()=>gradeFrozenSequenceSql({...input,manifestFile:path.join(root,'frozen.json')}),/not in the frozen manifest/);
  });
  if(process.platform==='darwin')test('actual kernel denies predecessor, grader and symlink reads', () => {
    for(const dir of ['agent','previous','grader'])fs.mkdirSync(path.join(root,dir));
    for(const dir of ['agent','previous','grader'])fs.writeFileSync(path.join(root,dir,'canary'),'test-'+dir);
    fs.symlinkSync(path.join(root,'grader','canary'),path.join(root,'agent','link'));
    const policy=sequenceSeatbelt([], [path.join(root,'agent')], [path.join(root,'previous'),path.join(root,'grader')]);
    const result=verifySequenceSeatbelt(policy,path.join(root,'agent','canary'),[path.join(root,'previous','canary'),path.join(root,'grader','canary'),path.join(root,'agent','link')]);
    assert.equal(result.kernelDeniedReads,3);
    assert.throws(()=>sequenceSeatbelt([root],[],[path.join(root,'grader')]),/forbidden/);
  });
  console.log(`${passed} sequence tests passed; no paid calls or scored fixtures used`);
} finally { fs.rmSync(root,{recursive:true,force:true}); }
