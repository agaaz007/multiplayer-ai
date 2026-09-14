#!/usr/bin/env node
/** Native-readiness receipt producer for the baseline control arms (decision 7A).
 *
 * probe  NATIVE_CONFIG.json [--out FILE]
 *   Deterministically exercises the provisioned transport of an UNUSED control root:
 *   a simulated stage A commits+pushes / writes HANDOFF.md, the real capture step runs,
 *   a simulated one-commit stage B is prepared, and recall (branch via `git ls-remote`,
 *   note visible in handoff-notes/) plus isolation (no grant overlaps a protected path)
 *   are asserted. Probe artifacts are removed from the live store afterwards and the
 *   store is verified empty. Writes teamwork-native-readiness/v3 with
 *   full_harness_pass:false; no model runs.
 * assess NATIVE_CONFIG.json --sequence ENDED_READINESS_ROOT --out FILE
 *   Reads an ENDED live seed-42 A/B/C readiness sequence and sets full_harness_pass
 *   true only if every stage delivered and stage B's final worktree contains A's
 *   pilot.py/test_pilot.py recovered through the control mechanism (see checks).
 * No receipt field is ever set to pass without the corresponding check passing.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CONTROL_ARMS,CONTROL_VERSIONS,git,sha,remotePath,notesPath,remoteRefs,worktreeInventory,prepareControlStage,captureControl,grantIsolation} from './native-controls.mjs';

const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const write=(f,o)=>fs.writeFileSync(f,JSON.stringify(o,null,2)+'\n',{mode:0o600,flag:'wx'});
const SCHEMA='teamwork-native-readiness/v3';
const FULL_HARNESS_REASON='a live seed-42 A/B/C readiness sequence has not run yet against this control root; run run_readiness.py, then control-readiness.mjs assess';

export function loadConfig(file){
 const cfg=read(file);
 if(!CONTROL_ARMS.includes(cfg.arm))throw new Error('control readiness applies only to '+CONTROL_ARMS.join('/'));
 for(const k of ['root','guide_file'])if(!cfg[k])throw new Error('native config missing '+k);
 cfg.root=fs.realpathSync(cfg.root);cfg.version=cfg.version??CONTROL_VERSIONS[cfg.arm];cfg.readiness_receipt=cfg.readiness_receipt??path.join(cfg.root,'native-readiness.json');
 return cfg;
}

function commitAll(work,message){git(work,'add','-A');git(work,'-c','user.name=control-readiness','-c','user.email=control-readiness@evaluation.invalid','commit','-q','--allow-empty','-m',message);return git(work,'rev-parse','HEAD');}
const INITIAL={'WORKFLOW.md':'# probe workflow\n','project.json':'{"project":"control readiness probe","synthetic":true}\n'};
function releaseWorkspace(work){
 fs.mkdirSync(work,{recursive:true,mode:0o700});
 for(const [name,body] of Object.entries(INITIAL))fs.writeFileSync(path.join(work,name),body);
 git(work,'init','-q','--initial-branch=main');
 return commitAll(work,'Initial repository and current stage delta only');
}
function protectedPaths(root){
 const list=[path.join(root,'sequence.json'),path.join(root,'attempt.json'),path.join(root,'controller-canary')];
 const stages=path.join(root,'stages');if(fs.existsSync(stages))for(const s of fs.readdirSync(stages))list.push(path.join(stages,s));
 const seq=path.join(root,'sequence.json');if(fs.existsSync(seq)){const state=read(seq);if(state.pack)list.push(state.pack);}
 return list;
}
function storeEmpty(cfg){
 if(cfg.arm==='control-git')return remoteRefs(remotePath(cfg.root)).length===0;
 return fs.readdirSync(notesPath(cfg.root)).length===0;
}

export function probe(cfg,{out}={}){
 const state=read(path.join(cfg.root,'native-state.json'));
 if(state.arm!==cfg.arm)throw new Error('native state arm mismatch');
 if((state.stages??[]).length)throw new Error('probe requires an unused provisioned control root (no stages prepared)');
 if(!storeEmpty(cfg))throw new Error('probe requires an empty transport store');
 const checks=[];const check=(id,pass,detail)=>{checks.push({id,pass:Boolean(pass),detail});return Boolean(pass);};
 const scratch=path.join(cfg.root,'control-readiness','probe-'+Date.now());fs.mkdirSync(scratch,{recursive:true,mode:0o700});
 const stage=(name)=>({workspace:path.join(scratch,name,'worktree'),controller_output_dir:path.join(scratch,name,'controller'),stage:'probe-'+name,arm:cfg.arm});
 let recall=false,isolation=false,cleanup={};
 try{
  // Simulated stage A: original work + note, committed; pushed for git-only.
  const A=stage('A');releaseWorkspace(A.workspace);fs.mkdirSync(A.controller_output_dir,{recursive:true,mode:0o700});
  const pilot='NORTH_CAP = 40\n\ndef eligible(n):\n    return isinstance(n, int) and 0 <= n <= NORTH_CAP\n';
  const test='import pilot\n\nassert pilot.eligible(40) and not pilot.eligible(41)\n';
  const note='# HANDOFF\n\nStage probe-A implemented pilot.eligible with NORTH_CAP = 40.\n\n```python\n'+pilot+'```\n';
  fs.writeFileSync(path.join(A.workspace,'pilot.py'),pilot);fs.writeFileSync(path.join(A.workspace,'test_pilot.py'),test);fs.writeFileSync(path.join(A.workspace,'HANDOFF.md'),note);
  const profileA={read_paths:[],write_paths:[]};const prepA=prepareControlStage(cfg,A,profileA);
  const headA=commitAll(A.workspace,'probe-A original work');
  if(cfg.arm==='control-git')git(A.workspace,'push','-q','origin','HEAD:refs/heads/probe-A');
  const captureA=captureControl(cfg,A);
  if(cfg.arm==='control-git')check('stage_a_push_recorded',captureA.head_pushed===true&&captureA.refs_containing_head.includes('refs/heads/probe-A'),captureA);
  else check('stage_a_note_captured',captureA.note_absent===false&&captureA.note.sha256===sha(Buffer.from(note)),captureA);
  // Simulated stage B: fresh one-commit workspace; preparation must not change it.
  const B=stage('B');const headB=releaseWorkspace(B.workspace);fs.mkdirSync(B.controller_output_dir,{recursive:true,mode:0o700});
  const before=worktreeInventory(B.workspace);const profileB={read_paths:[],write_paths:[]};const prepB=prepareControlStage(cfg,B,profileB);
  check('successor_inventory_unchanged',JSON.stringify(worktreeInventory(B.workspace))===JSON.stringify(before),{files:Object.keys(before)});
  check('successor_history_one_commit',git(B.workspace,'rev-list','--count','HEAD')==='1'&&git(B.workspace,'rev-parse','HEAD')===headB,{head:headB});
  check('successor_has_no_predecessor_files',!fs.existsSync(path.join(B.workspace,'pilot.py'))&&!fs.existsSync(path.join(B.workspace,'HANDOFF.md')),null);
  if(cfg.arm==='control-git'){
   const listed=git(B.workspace,'ls-remote','origin');const visible=listed.split('\n').some(line=>line.split(/\s+/)[0]===headA&&line.endsWith('refs/heads/probe-A'));
   check('branch_visible_via_ls_remote',visible,{ls_remote:listed});
   git(B.workspace,'fetch','-q','origin');
   const recovered=git(B.workspace,'show','origin/probe-A:pilot.py')+'\n';
   check('predecessor_bytes_recoverable_by_fetch',recovered===pilot,{sha256:sha(Buffer.from(recovered))});
   check('unpushed_stage_recorded_as_lost',(()=>{const C=stage('C');releaseWorkspace(C.workspace);fs.mkdirSync(C.controller_output_dir,{recursive:true,mode:0o700});prepareControlStage(cfg,C,{read_paths:[],write_paths:[]});fs.writeFileSync(path.join(C.workspace,'late.py'),'x=1\n');commitAll(C.workspace,'probe-C unpushed');const r=captureControl(cfg,C);return r.head_pushed===false&&typeof r.loss_note==='string';})(),null);
  }else{
   const target=path.join(notesPath(cfg.root),'probe-A.md');
   check('note_visible_in_handoff_notes',fs.existsSync(target)&&sha(fs.readFileSync(target))===sha(Buffer.from(note))&&prepB.notes_available_at_preparation.includes('probe-A.md'),{path:target});
   check('note_not_copied_into_successor',!fs.existsSync(path.join(B.workspace,'HANDOFF.md'))&&!fs.existsSync(path.join(B.workspace,'handoff-notes')),null);
   check('missing_note_recorded_absent',(()=>{const C=stage('C');releaseWorkspace(C.workspace);fs.mkdirSync(C.controller_output_dir,{recursive:true,mode:0o700});prepareControlStage(cfg,C,{read_paths:[],write_paths:[]});const r=captureControl(cfg,C);return r.note_absent===true&&r.note===null&&!fs.existsSync(path.join(notesPath(cfg.root),'probe-C.md'));})(),null);
  }
  recall=checks.every(c=>c.pass);
  const grants=[...profileB.read_paths,...profileB.write_paths];const iso=grantIsolation(grants,[...protectedPaths(cfg.root),scratch]);
  const insideRoot=grants.every(g=>fs.realpathSync(g).startsWith(cfg.root+path.sep));
  isolation=check('grants_do_not_overlap_protected_paths',iso.pass&&insideRoot,iso);
  if(cfg.arm==='control-git')isolation=check('control_git_grants_are_only_the_shared_remote',profileB.read_paths.length===1&&profileB.write_paths.length===1&&profileB.read_paths[0]===remotePath(cfg.root),profileB)&&isolation;
  else isolation=check('handoff_note_grant_is_read_only_notes_dir',profileB.read_paths.length===1&&profileB.write_paths.length===0&&profileB.read_paths[0]===notesPath(cfg.root),profileB)&&isolation;
  check('no_mcp_servers_or_hooks',Object.keys(profileB.mcp??{}).length===0&&!profileB.hooks&&Object.keys(profileB.hook_env??{}).length===0,profileB);
  isolation=isolation&&checks.at(-1).pass;
 }catch(error){checks.push({id:'probe_exception',pass:false,detail:String(error.message).slice(0,2000)});recall=false;isolation=false;}
 // Remove probe artifacts from the live store so no live successor can read probe material.
 try{
  if(cfg.arm==='control-git'){const bare=remotePath(cfg.root);for(const r of remoteRefs(bare))git(bare,'update-ref','-d',r.ref);}
  else for(const n of fs.readdirSync(notesPath(cfg.root)))fs.unlinkSync(path.join(notesPath(cfg.root),n));
  cleanup={store_empty_after_probe:storeEmpty(cfg),probe_scratch_retained:scratch};
 }catch(error){cleanup={store_empty_after_probe:false,error:String(error.message)};}
 if(!cleanup.store_empty_after_probe){checks.push({id:'probe_store_cleanup',pass:false,detail:cleanup});recall=false;}
 const receipt={schema:SCHEMA,arm:cfg.arm,native_version:cfg.version,created_at:new Date().toISOString(),
  capture_recall_pass:recall,isolation_pass:isolation,full_harness_pass:false,full_harness_reason:FULL_HARNESS_REASON,
  scored:false,development_probe:true,transport:state.transport??null,git_version:state.git_version??null,
  scope:'deterministic transport probe on the provisioned control store; simulated stages, no model, no live sandbox',
  isolation_basis:'path-grant overlap check against controller-private paths (sequence.json, attempt.json, canary, stages/, pack); kernel seatbelt is verified per live stage by the driver, not here',
  checks,probe_store_cleanup:cleanup,
  limitations:['Simulated stages exercise the transport, not agent behaviour.','A control cannot fail capture for product reasons; unpushed work or a missing note is an agent outcome recorded as lost/absent.']};
 const file=out??cfg.readiness_receipt;write(file,receipt);return {...receipt,receipt_file:file};
}

/** Text of every tool call in a stage's Codex rollouts (custom_tool_call / function_call inputs). */
export function rolloutCallTexts(stageDir){
 const root=path.join(stageDir,'home','.codex','sessions');const out=[];
 if(!fs.existsSync(root))return out;
 (function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.isFile()&&e.name.endsWith('.jsonl')){let n=0;for(const line of fs.readFileSync(f,'utf8').split('\n')){n++;try{const ev=JSON.parse(line);const p=ev.payload??{};if(ev.type==='response_item'&&['custom_tool_call','function_call'].includes(p.type)){const text=typeof (p.input??p.arguments)==='string'?(p.input??p.arguments):JSON.stringify(p.input??p.arguments??'');out.push({file:f,line:n,name:p.name??null,text});}}catch{}}}}})(root);
 return out;
}

export function assess(cfg,sequenceRoot,{out}){
 const root=fs.realpathSync(sequenceRoot);const state=read(path.join(root,'sequence.json'));const checks=[];const check=(id,pass,detail)=>{checks.push({id,pass:Boolean(pass),detail});return Boolean(pass);};
 const evidence={};const bind=(name,file)=>{if(fs.existsSync(file))evidence[name]={path:file,sha256:sha(fs.readFileSync(file))};return fs.existsSync(file);};
 bind('sequence',path.join(root,'sequence.json'));
 check('sequence_ended',state.status==='ended',{status:state.status});
 check('sequence_arm_matches',state.arm===cfg.arm,{arm:state.arm});
 const manifest=fs.existsSync(path.join(state.pack??'','manifest.json'))?read(path.join(state.pack,'manifest.json')):null;
 check('development_pack',manifest?.development===true&&manifest?.seed===42,{seed:manifest?.seed,development:manifest?.development});
 const nativeConfig=path.join(root,'native-config.json');
 check('readiness_root_version_matches',bind('native_config',nativeConfig)&&read(nativeConfig).version===cfg.version&&read(nativeConfig).arm===cfg.arm,{version:cfg.version});
 const probeFile=path.join(root,'native-readiness.json');let probeReceipt=null;
 if(bind('probe_receipt',probeFile))probeReceipt=read(probeFile);
 check('probe_receipt_passed',probeReceipt?.schema===SCHEMA&&probeReceipt?.arm===cfg.arm&&probeReceipt?.capture_recall_pass===true&&probeReceipt?.isolation_pass===true,probeReceipt?{capture_recall_pass:probeReceipt.capture_recall_pass,isolation_pass:probeReceipt.isolation_pass}:'probe receipt missing');
 const stages=(manifest?.stages??[]).map(s=>s.id);
 check('three_stages',JSON.stringify(stages)===JSON.stringify(['A','B','C']),{stages});
 const delivered={};for(const s of stages){const r=state.stages?.[s]??{};delivered[s]={status:r.status,delivered:r.delivered};}
 check('all_stages_delivered',stages.length>0&&stages.every(s=>state.stages?.[s]?.status==='finished'&&state.stages?.[s]?.delivered===true),delivered);
 const isolation={};for(const s of stages){const f=path.join(root,'stages',s,'controller','stage-result.json');isolation[s]=fs.existsSync(f)?read(f).isolation??null:null;}
 check('kernel_isolation_verified_each_stage',stages.length>0&&stages.every(s=>isolation[s]?.ownReadVerified===true),isolation);
 const aTree=path.join(root,'stages','A','controller','handoff','tree'),bTree=path.join(root,'stages','B','controller','handoff','tree'),bRecovery=path.join(root,'stages','B','controller','recovery','tree');
 const files={};
 for(const name of ['pilot.py','test_pilot.py']){
  const a=path.join(aTree,name),b=path.join(bTree,name),r=path.join(bRecovery,name);
  files[name]={a_present:fs.existsSync(a),b_final_present:fs.existsSync(b),b_recovery_present:fs.existsSync(r),
   recovery_exact:fs.existsSync(a)&&fs.existsSync(r)&&sha(fs.readFileSync(a))===sha(fs.readFileSync(r)),
   final_exact:fs.existsSync(a)&&fs.existsSync(b)&&sha(fs.readFileSync(a))===sha(fs.readFileSync(b))};
  if(fs.existsSync(a))bind('A_'+name,a);if(fs.existsSync(b))bind('B_final_'+name,b);if(fs.existsSync(r))bind('B_recovery_'+name,r);
 }
 check('a_produced_pilot_and_test',files['pilot.py'].a_present&&files['test_pilot.py'].a_present,files);
 check('b_final_worktree_contains_pilot_and_test',files['pilot.py'].b_final_present&&files['test_pilot.py'].b_final_present,files);
 const exact=files['pilot.py'].recovery_exact&&files['test_pilot.py'].recovery_exact;
 // Mechanism evidence: the bytes arrived through the control channel, not a controller copy.
 let mechanism;
 if(cfg.arm==='control-git'){
  const aCaptures=fs.existsSync(path.join(root,'stages','A','controller'))?fs.readdirSync(path.join(root,'stages','A','controller')).filter(n=>/^native-capture-\d+\.json$/.test(n)).map(n=>read(path.join(root,'stages','A','controller',n))):[];
  const aPushed=aCaptures.some(c=>c.head_pushed===true);
  const bWork=path.join(root,'stages','B','worktree');let fetched=[];try{fetched=git(bWork,'for-each-ref','--format=%(refname)','refs/remotes/origin').split('\n').filter(Boolean);}catch{}
  const calls=rolloutCallTexts(path.join(root,'stages','B'));const gitReads=calls.filter(c=>/\bgit\b[^\n]*\b(fetch|pull|ls-remote|log|show|checkout|switch|restore|merge|cherry-pick|read-tree|archive|cat-file)\b/.test(c.text)).map(c=>({file:c.file,line:c.line,excerpt:c.text.slice(0,300)}));
  mechanism={a_pushed_before_kill:aPushed,b_fetched_origin_refs:fetched,b_git_read_commands:gitReads.length,samples:gitReads.slice(0,3)};
  check('recovered_via_git_mechanism',aPushed&&(fetched.length>0||gitReads.length>0),mechanism);
  check('recovered_bytes_exact_at_checkpoint',exact,files);
 }else{
  const noteA=path.join(notesPath(root),'A.md');const calls=rolloutCallTexts(path.join(root,'stages','B'));const reads=calls.filter(c=>c.text.includes('handoff-notes')).map(c=>({file:c.file,line:c.line,excerpt:c.text.slice(0,300)}));
  mechanism={a_note_present:fs.existsSync(noteA),b_handoff_notes_references:reads.length,samples:reads.slice(0,3),recovered_bytes_exact_at_checkpoint:exact,note:'a note-based control re-authors code from the note; exact bytes are reported, not required'};
  if(fs.existsSync(noteA))bind('A_note',noteA);
  check('recovered_via_note_mechanism',fs.existsSync(noteA)&&reads.length>0,mechanism);
 }
 const full=checks.every(c=>c.pass);
 const receipt={schema:SCHEMA,arm:cfg.arm,native_version:cfg.version,created_at:new Date().toISOString(),
  capture_recall_pass:probeReceipt?.capture_recall_pass===true,isolation_pass:probeReceipt?.isolation_pass===true&&checks.find(c=>c.id==='kernel_isolation_verified_each_stage').pass,
  full_harness_pass:full,full_harness_reason:full?null:'failed: '+checks.filter(c=>!c.pass).map(c=>c.id).join(', '),
  scored:false,development_probe:true,readiness_root:root,scope:'ended live seed-42 A/B/C readiness sequence assessed for delivery, isolation and control-mechanism recovery of A\'s pilot.py/test_pilot.py',
  checks,mechanism,files,evidence,
  limitations:['Readiness validates transport availability and observed use; it does not establish task quality.','Recovered claims are a teammate\'s claims; a handoff note is not human approval.']};
 write(out,receipt);return {...receipt,receipt_file:out};
}

function argValue(args,name){const i=args.indexOf(name);return i>=0?args[i+1]:undefined;}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [op,file,...rest]=process.argv.slice(2);
 try{
  if(op==='probe'&&file){const r=probe(loadConfig(file),{out:argValue(rest,'--out')});console.log(JSON.stringify(r,null,2));process.exitCode=r.capture_recall_pass&&r.isolation_pass?0:1;}
  else if(op==='assess'&&file&&argValue(rest,'--sequence')&&argValue(rest,'--out')){const r=assess(loadConfig(file),argValue(rest,'--sequence'),{out:argValue(rest,'--out')});console.log(JSON.stringify(r,null,2));process.exitCode=r.full_harness_pass?0:1;}
  else{console.error('usage: control-readiness.mjs probe NATIVE_CONFIG.json [--out FILE] | assess NATIVE_CONFIG.json --sequence ENDED_ROOT --out FILE');process.exitCode=2;}
 }catch(error){console.error('Control readiness failed: '+error.message);process.exitCode=1;}
}
