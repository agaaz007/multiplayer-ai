/** Baseline control arms (decision 7A): temporary roots only, no model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {CONTROL_ARMS,provisionControl,prepareControlStage,captureControl,exportControl,grantIsolation,remotePath,notesPath,remoteRefs,git} from './native-controls.mjs';
import {config,provision,prepareStage,captureStage,exportSequence} from './native-lifecycle.mjs';
import {setup} from './native-setup.mjs';
import {guides,guideFor} from './native-guides.mjs';
import {loadConfig,probe,assess} from './control-readiness.mjs';

const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const save=(f,o)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(o,null,2));};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'tw-controls-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return fs.realpathSync(root);}
function release(work){fs.mkdirSync(work,{recursive:true});fs.writeFileSync(path.join(work,'WORKFLOW.md'),'# w\n');fs.writeFileSync(path.join(work,'task.txt'),'delta\n');git(work,'init','-q','--initial-branch=main');git(work,'add','-A');git(work,'-c','user.name=t','-c','user.email=t@e.invalid','commit','-q','-m','Initial repository and current stage delta only');return git(work,'rev-parse','HEAD');}
function setupRoot(base,arm){const root=path.join(base,'seq-'+arm);fs.mkdirSync(root);const runtime=path.join(base,'runtime');fs.mkdirSync(runtime,{recursive:true});const budget=path.join(base,'budget.json');if(!fs.existsSync(budget))save(budget,{schema:'teamwork-budget/v2',maximum_usd:30,entries:[]});const s=setup({root,arm,runtime,budget_file:budget,native_versions:path.join(base,'no-versions')});return {root,native_config:s.native_config,guide:s.guide};}

test('setup writes control configs without proxy or budget gate and guides carry the transport path',t=>{
  const base=fixture(t);
  for(const arm of CONTROL_ARMS){
    const {root,native_config,guide}=setupRoot(base,arm);const cfg=read(native_config);
    assert.equal(cfg.arm,arm);assert.equal(cfg.version,arm+'/v3');assert.equal(cfg.proxy_config,undefined);assert.equal(cfg.proxy_ready_file,undefined);assert.equal(cfg.budget_gate_module,undefined);
    assert.equal(cfg.readiness_receipt,path.join(root,'native-readiness.json'));assert.deepEqual(cfg.read_paths,[]);assert.equal(cfg.native_capabilities.mcp_memory_servers,false);
    const text=fs.readFileSync(guide,'utf8');assert.ok(text.includes(root));assert.equal(text,guideFor(arm,root));assert.doesNotMatch(text,/ledger|gbrain|graphify|supermemory/i);
    assert.ok(guides[arm].includes('{root}'));assert.ok(text.includes('BEFORE your final task action')||text.includes('Before your final task action'));
  }
  assert.match(guides['control-git'],/git fetch origin/);assert.match(guides['handoff-note'],/HANDOFF\.md/);
});

test('git-only: provision bare remote, stage preparation only adds origin, capture records pushed and unpushed truthfully',async t=>{
  const base=fixture(t);const {root,native_config}=setupRoot(base,'control-git');const cfg=config(native_config);
  const provisioned=await provision(cfg);assert.equal(provisioned.readiness_verified,false);assert.match(provisioned.transport,/git-only/);
  assert.ok(fs.existsSync(path.join(remotePath(root),'HEAD')));
  const stage=(name)=>({native_config,arm:'control-git',stage:name,workspace:path.join(root,'stages',name,'worktree'),fresh_home:path.join(root,'stages',name,'home'),controller_output_dir:path.join(root,'stages',name,'controller'),native_profile:path.join(root,'stages',name,'controller','native-profile.json')});
  const A=stage('A');const headA=release(A.workspace);fs.mkdirSync(A.fresh_home,{recursive:true});fs.mkdirSync(A.controller_output_dir,{recursive:true});
  const filesBefore=fs.readdirSync(A.workspace).sort();
  const prepared=await prepareStage(A);assert.equal(prepared.readiness_verified,false);
  const profile=read(A.native_profile);
  assert.equal(profile.paid_paths_gated,true);assert.deepEqual(profile.mcp,{});assert.equal(profile.hooks,undefined);assert.deepEqual(profile.hook_env,{});
  assert.deepEqual(profile.read_paths,[remotePath(root)]);assert.deepEqual(profile.write_paths,[remotePath(root)]);
  assert.deepEqual(fs.readdirSync(A.workspace).sort(),filesBefore);assert.equal(git(A.workspace,'rev-list','--count','HEAD'),'1');assert.equal(git(A.workspace,'rev-parse','HEAD'),headA);
  assert.equal(git(A.workspace,'remote','get-url','origin'),remotePath(root));
  assert.ok(fs.existsSync(path.join(A.controller_output_dir,'control-preparation.json')));
  // Agent work: commit + push (as the guide instructs).
  fs.writeFileSync(path.join(A.workspace,'pilot.py'),'CAP=40\n');git(A.workspace,'add','-A');git(A.workspace,'-c','user.name=a','-c','user.email=a@e.invalid','commit','-q','-m','work');git(A.workspace,'push','-q','origin','HEAD:refs/heads/stage-A');
  const captured=await captureStage(A);assert.equal(captured.head_pushed,true);assert.deepEqual(captured.refs_containing_head,['refs/heads/stage-A']);assert.equal(captured.loss_note,null);assert.ok(fs.existsSync(captured.receipt_file));
  // Unpushed stage B is honestly lost.
  const B=stage('B');release(B.workspace);fs.mkdirSync(B.fresh_home,{recursive:true});fs.mkdirSync(B.controller_output_dir,{recursive:true});await prepareStage(B);
  assert.equal(git(B.workspace,'ls-remote','origin').includes('refs/heads/stage-A'),true);
  assert.equal(fs.existsSync(path.join(B.workspace,'pilot.py')),false,'no controller copy of predecessor files');
  fs.writeFileSync(path.join(B.workspace,'b.py'),'x\n');git(B.workspace,'add','-A');git(B.workspace,'-c','user.name=b','-c','user.email=b@e.invalid','commit','-q','-m','unpushed');
  const lost=await captureStage(B);assert.equal(lost.head_pushed,false);assert.match(lost.loss_note,/unpushed/);
  assert.deepEqual(remoteRefs(remotePath(root)).map(r=>r.ref),['refs/heads/stage-A']);
  const exported=await exportSequence(cfg);assert.equal(exported.remote_refs.length,1);assert.ok(fs.existsSync(exported.bundle));
  await assert.rejects(prepareStage(A),/already prepared/);
});

test('handoff-note: capture copies HANDOFF.md to handoff-notes/<stage>.md, records absence, never populates a successor',async t=>{
  const base=fixture(t);const {root,native_config}=setupRoot(base,'handoff-note');const cfg=config(native_config);
  await provision(cfg);assert.ok(fs.existsSync(notesPath(root)));
  const stage=(name)=>({native_config,arm:'handoff-note',stage:name,workspace:path.join(root,'stages',name,'worktree'),fresh_home:path.join(root,'stages',name,'home'),controller_output_dir:path.join(root,'stages',name,'controller'),native_profile:path.join(root,'stages',name,'controller','native-profile.json')});
  const A=stage('A');release(A.workspace);fs.mkdirSync(A.fresh_home,{recursive:true});fs.mkdirSync(A.controller_output_dir,{recursive:true});await prepareStage(A);
  const profile=read(A.native_profile);assert.deepEqual(profile.read_paths,[notesPath(root)]);assert.deepEqual(profile.write_paths,[]);assert.deepEqual(profile.mcp,{});assert.equal(profile.paid_paths_gated,true);
  const note='# HANDOFF\nCAP=40\n';fs.writeFileSync(path.join(A.workspace,'HANDOFF.md'),note);
  const captured=await captureStage(A);assert.equal(captured.note_absent,false);assert.equal(captured.note.sha256,sha(Buffer.from(note)));
  assert.equal(fs.readFileSync(path.join(notesPath(root),'A.md'),'utf8'),note);
  const B=stage('B');const headB=release(B.workspace);fs.mkdirSync(B.fresh_home,{recursive:true});fs.mkdirSync(B.controller_output_dir,{recursive:true});await prepareStage(B);
  assert.deepEqual(read(path.join(B.controller_output_dir,'control-preparation.json')).notes_available_at_preparation,['A.md']);
  assert.deepEqual(fs.readdirSync(B.workspace).filter(n=>n!=='.git').sort(),['WORKFLOW.md','task.txt']);assert.equal(git(B.workspace,'rev-parse','HEAD'),headB);
  const absent=await captureStage(B);assert.equal(absent.note_absent,true);assert.equal(absent.note,null);assert.equal(fs.existsSync(path.join(notesPath(root),'B.md')),false);
  // A symlinked note is not copied either.
  const C=stage('C');release(C.workspace);fs.mkdirSync(C.fresh_home,{recursive:true});fs.mkdirSync(C.controller_output_dir,{recursive:true});await prepareStage(C);
  fs.symlinkSync(path.join(base,'budget.json'),path.join(C.workspace,'HANDOFF.md'));
  const link=await captureStage(C);assert.equal(link.note_absent,true);assert.match(link.reason,/not a regular file/);
  const exported=await exportSequence(cfg);assert.deepEqual(exported.notes.map(n=>n.name),['A.md']);
});

test('grant isolation rejects overlaps with controller-private paths',t=>{
  const base=fixture(t);fs.mkdirSync(path.join(base,'stages/A'),{recursive:true});fs.writeFileSync(path.join(base,'sequence.json'),'{}');
  assert.equal(grantIsolation([path.join(base,'shared-remote.git')],[path.join(base,'sequence.json'),path.join(base,'stages/A')]).pass,true);
  assert.equal(grantIsolation([path.join(base,'stages/A/worktree')],[path.join(base,'stages/A')]).pass,false);
  assert.equal(grantIsolation([base],[path.join(base,'sequence.json')]).pass,false);
});

test('control-readiness probe passes on unused roots, cleans the live store and never claims full harness',async t=>{
  const base=fixture(t);
  for(const arm of CONTROL_ARMS){
    const {root,native_config}=setupRoot(base,arm);const cfg=config(native_config);await provision(cfg);
    save(path.join(root,'sequence.json'),{schema:'teamwork-sequence/v3',arm,pack:path.join(base,'pack-'+arm),executed:false,status:'prepared',stages:{}});fs.mkdirSync(path.join(base,'pack-'+arm));
    const receipt=probe(loadConfig(native_config));
    assert.equal(receipt.schema,'teamwork-native-readiness/v3');assert.equal(receipt.arm,arm);assert.equal(receipt.native_version,arm+'/v3');
    assert.equal(receipt.capture_recall_pass,true,JSON.stringify(receipt.checks));assert.equal(receipt.isolation_pass,true);assert.equal(receipt.full_harness_pass,false);assert.match(receipt.full_harness_reason,/seed-42/);
    assert.equal(receipt.probe_store_cleanup.store_empty_after_probe,true);
    assert.deepEqual(read(path.join(root,'native-readiness.json')).checks.map(c=>c.pass),receipt.checks.map(()=>true));
    if(arm==='control-git')assert.equal(remoteRefs(remotePath(root)).length,0);else assert.deepEqual(fs.readdirSync(notesPath(root)),[]);
    // Reusing the receipt path or a used root is refused.
    assert.throws(()=>probe(loadConfig(native_config)),/EEXIST|exists/);
    const state=read(path.join(root,'native-state.json'));state.stages.push('A');save(path.join(root,'native-state.json'),state);
    assert.throws(()=>probe(loadConfig(native_config),{out:path.join(root,'second.json')}),/unused provisioned/);
  }
});

test('probe records a failing check truthfully when the transport is broken',async t=>{
  const base=fixture(t);const {root,native_config}=setupRoot(base,'handoff-note');const cfg=config(native_config);await provision(cfg);
  fs.rmSync(notesPath(root),{recursive:true});fs.writeFileSync(notesPath(root),'not a directory');
  let receipt=null;try{receipt=probe(loadConfig(native_config));}catch(e){receipt={error:e.message};}
  if(receipt.schema){assert.equal(receipt.capture_recall_pass,false);assert.equal(receipt.full_harness_pass,false);}
  else assert.match(receipt.error,/ENOTDIR|not a directory|empty transport/);
});

function endedReadiness(base,arm,{deliverAll=true,pushA=true,readNotes=true,recoveryExact=true}={}){
  const {root,native_config}=setupRoot(base,arm);
  const pack=path.join(base,'pack-'+arm);fs.mkdirSync(pack,{recursive:true});save(path.join(pack,'manifest.json'),{schema:'teamwork-pack/v3',development:true,seed:42,stages:[{id:'A'},{id:'B'},{id:'C'}]});
  const stages={};for(const s of ['A','B','C'])stages[s]={status:'finished',delivered:deliverAll||s!=='C'};
  save(path.join(root,'sequence.json'),{schema:'teamwork-sequence/v3',arm,pack,executed:true,status:'ended',stages});
  save(path.join(root,'native-state.json'),{arm,stages:['A','B','C'],transport:'test'});
  save(path.join(root,'native-readiness.json'),{schema:'teamwork-native-readiness/v3',arm,native_version:arm+'/v3',capture_recall_pass:true,isolation_pass:true,full_harness_pass:false});
  const pilot='CAP=24\n',test_='assert True\n';
  for(const s of ['A','B','C']){const ctl=path.join(root,'stages',s,'controller');fs.mkdirSync(path.join(ctl,'handoff/tree'),{recursive:true});save(path.join(ctl,'stage-result.json'),{isolation:{ownReadVerified:true,kernelDeniedReads:2}});
    if(s!=='A'){fs.mkdirSync(path.join(ctl,'recovery/tree'),{recursive:true});fs.writeFileSync(path.join(ctl,'recovery/tree/pilot.py'),recoveryExact?pilot:'CAP=41\n');fs.writeFileSync(path.join(ctl,'recovery/tree/test_pilot.py'),test_);}
    fs.writeFileSync(path.join(ctl,'handoff/tree/pilot.py'),s==='A'?pilot:'CAP=24 # corrected\n');fs.writeFileSync(path.join(ctl,'handoff/tree/test_pilot.py'),test_);}
  if(arm==='control-git'){
    fs.mkdirSync(remotePath(root));git(remotePath(root),'init','--bare','-q');
    save(path.join(root,'stages/A/controller/native-capture-1.json'),{arm,head_pushed:pushA});
    const bWork=path.join(root,'stages/B/worktree');release(bWork);git(bWork,'remote','add','origin',remotePath(root));
    if(pushA){const aWork=path.join(root,'stages/A/worktree');release(aWork);fs.writeFileSync(path.join(aWork,'pilot.py'),pilot);git(aWork,'add','-A');git(aWork,'-c','user.name=a','-c','user.email=a@e.invalid','commit','-q','-m','w');git(aWork,'remote','add','origin',remotePath(root));git(aWork,'push','-q','origin','HEAD:refs/heads/stage-A');git(bWork,'fetch','-q','origin');}
  }else{
    fs.mkdirSync(notesPath(root));fs.writeFileSync(path.join(notesPath(root),'A.md'),'# note\n');
    const sessions=path.join(root,'stages/B/home/.codex/sessions/2026/09/13');fs.mkdirSync(sessions,{recursive:true});
    const line=JSON.stringify({type:'response_item',payload:{type:'custom_tool_call',name:'exec',input:readNotes?'const r=await tools.exec_command({cmd:"cat '+notesPath(root)+'/A.md"});':'const r=await tools.exec_command({cmd:"ls"});'}});
    fs.writeFileSync(path.join(sessions,'rollout-1.jsonl'),line+'\n');
  }
  return {root,native_config};
}

test('assess sets full_harness_pass only when delivery, isolation and control-mechanism recovery all hold',t=>{
  const base=fixture(t);
  for(const arm of CONTROL_ARMS){
    const ok=endedReadiness(base,arm);const r=assess(loadConfig(ok.native_config),ok.root,{out:path.join(base,arm+'-pass.json')});
    assert.equal(r.full_harness_pass,true,JSON.stringify(r.checks.filter(c=>!c.pass)));assert.equal(r.native_version,arm+'/v3');assert.ok(read(path.join(base,arm+'-pass.json')).full_harness_pass);
    const missing=endedReadiness(fs.mkdtempSync(path.join(base,'m-')),arm,{deliverAll:false});const r2=assess(loadConfig(missing.native_config),missing.root,{out:path.join(base,arm+'-missing.json')});
    assert.equal(r2.full_harness_pass,false);assert.match(r2.full_harness_reason,/all_stages_delivered/);
    const noMech=endedReadiness(fs.mkdtempSync(path.join(base,'n-')),arm,{pushA:false,readNotes:false});const r3=assess(loadConfig(noMech.native_config),noMech.root,{out:path.join(base,arm+'-nomech.json')});
    assert.equal(r3.full_harness_pass,false);assert.match(r3.full_harness_reason,/recovered_via_(git|note)_mechanism/);
  }
  const inexact=endedReadiness(fs.mkdtempSync(path.join(base,'i-')),'control-git',{recoveryExact:false});const r4=assess(loadConfig(inexact.native_config),inexact.root,{out:path.join(base,'git-inexact.json')});
  assert.equal(r4.full_harness_pass,false);assert.match(r4.full_harness_reason,/recovered_bytes_exact_at_checkpoint/);
  const noteInexact=endedReadiness(fs.mkdtempSync(path.join(base,'j-')),'handoff-note',{recoveryExact:false});const r5=assess(loadConfig(noteInexact.native_config),noteInexact.root,{out:path.join(base,'note-inexact.json')});
  assert.equal(r5.full_harness_pass,true);assert.equal(r5.mechanism.recovered_bytes_exact_at_checkpoint,false);
});

test('lifecycle config rejects unknown arms and still requires proxies for products',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-cfg-'));const f=path.join(dir,'c.json');
  save(f,{arm:'fresh-agent',root:dir,runtime:dir,guide_file:f});assert.throws(()=>config(f),/unsupported/);
  save(f,{arm:'control-git',root:dir,runtime:dir,guide_file:f});assert.equal(config(f).arm,'control-git');
  fs.rmSync(dir,{recursive:true});
});
