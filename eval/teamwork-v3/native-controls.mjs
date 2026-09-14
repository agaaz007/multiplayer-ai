#!/usr/bin/env node
/** Baseline control transports (decision 7A): git-only and markdown handoff note.
 *
 * `control-git`: each sequence root owns a bare repository. Stage preparation adds it
 * as `origin` to the successor's one-commit workspace and nothing else. Recovery is
 * agent-initiated (`git fetch origin`); an unpushed stage is honestly lost.
 * `handoff-note`: post-stage capture copies the final worktree's HANDOFF.md to
 * <root>/handoff-notes/<stage>.md. A missing note is recorded as absent, never invented.
 * Notes are read from handoff-notes/, never copied into a successor workspace.
 * Neither control has MCP memory servers, hooks or a paid provider path.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

export const CONTROL_ARMS=['control-git','handoff-note'];
export const BASELINE_CONTROLS=['fresh-agent',...CONTROL_ARMS];
export const CONTROL_VERSIONS={'control-git':'control-git/v3','handoff-note':'handoff-note/v3'};
export const isControl=arm=>BASELINE_CONTROLS.includes(arm);
export const isTransportControl=arm=>CONTROL_ARMS.includes(arm);
export const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export const remotePath=root=>path.join(root,'shared-remote.git');
export const notesPath=root=>path.join(root,'handoff-notes');

export function git(cwd,...args){
 return execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',timeout:60000,maxBuffer:32<<20,stdio:['ignore','pipe','pipe'],
  env:{PATH:process.env.PATH,HOME:process.env.HOME??cwd,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',LANG:'en_US.UTF-8'}}).trim();
}
function tryGit(cwd,...args){try{return git(cwd,...args);}catch{return null;}}
export function remoteRefs(bare){
 const out=tryGit(bare,'for-each-ref','--format=%(refname) %(objectname)');
 return out?out.split('\n').filter(Boolean).map(line=>{const [ref,commit]=line.split(' ');return {ref,commit};}):[];
}
/** Regular files of a worktree excluding .git, as relative path -> sha256; symlinks are rejected. */
export function worktreeInventory(root){
 const files={};
 function walk(dir,relative){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
   if(relative===''&&entry.name==='.git')continue;
   const absolute=path.join(dir,entry.name),name=relative?relative+'/'+entry.name:entry.name;
   if(entry.isSymbolicLink())throw new Error('symlink in workspace: '+name);
   if(entry.isDirectory())walk(absolute,name);else if(entry.isFile())files[name]=sha(fs.readFileSync(absolute));else throw new Error('special file in workspace: '+name);
  }
 }
 walk(root,'');return files;
}

export function provisionControl(cfg,state){
 if(cfg.arm==='control-git'){
  const bare=remotePath(cfg.root);if(fs.existsSync(bare))throw new Error('shared remote already exists');
  fs.mkdirSync(bare,{mode:0o700});git(bare,'init','--bare','-q');
  state.shared_remote=bare;state.git_version=git(cfg.root,'--version');state.transport='git-only: bare shared remote, agent fetch/push';
 }else if(cfg.arm==='handoff-note'){
  const dir=notesPath(cfg.root);if(fs.existsSync(dir))throw new Error('handoff-notes already exists');
  fs.mkdirSync(dir,{mode:0o700});state.handoff_notes=dir;state.transport='markdown handoff note: HANDOFF.md copied to handoff-notes/<stage>.md after each stage';
 }else throw new Error('not a transport control arm: '+cfg.arm);
 state.mcp_memory_servers=[];state.hooks=false;state.paid_provider_path=false;
 return state;
}

/** Mutates the stage profile's grants. Never changes the released inventory or the one-commit history. */
export function prepareControlStage(cfg,req,profile){
 profile.mcp={};profile.hook_env={};delete profile.hooks;profile.transport_control=cfg.arm;
 if(cfg.arm==='control-git'){
  const bare=remotePath(cfg.root);if(!fs.existsSync(path.join(bare,'HEAD')))throw new Error('shared remote not provisioned');
  const before={count:git(req.workspace,'rev-list','--count','HEAD'),head:git(req.workspace,'rev-parse','HEAD'),files:worktreeInventory(req.workspace)};
  if(tryGit(req.workspace,'remote','get-url','origin')!==null)throw new Error('workspace already has an origin remote');
  git(req.workspace,'remote','add','origin',bare);
  const after={count:git(req.workspace,'rev-list','--count','HEAD'),head:git(req.workspace,'rev-parse','HEAD'),files:worktreeInventory(req.workspace)};
  if(after.count!==before.count||after.head!==before.head||JSON.stringify(after.files)!==JSON.stringify(before.files))throw new Error('remote configuration changed the released workspace');
  if(git(req.workspace,'remote')!=='origin')throw new Error('unexpected remotes after preparation');
  profile.read_paths.push(bare);profile.write_paths.push(bare);profile.shared_remote=bare;
  return {shared_remote:bare,initial_git_head:after.head,initial_git_commit_count:Number(after.count),remote_refs_at_preparation:remoteRefs(bare)};
 }
 if(cfg.arm==='handoff-note'){
  const dir=notesPath(cfg.root);if(!fs.existsSync(dir))throw new Error('handoff-notes not provisioned');
  const notes=fs.readdirSync(dir).filter(n=>n.endsWith('.md')).sort();
  profile.read_paths.push(dir);profile.handoff_notes=dir;
  return {handoff_notes:dir,notes_available_at_preparation:notes};
 }
 throw new Error('not a transport control arm: '+cfg.arm);
}

/** Post-stage capture. Truthful transport bookkeeping only; no semantic handoff is generated. */
export function captureControl(cfg,req){
 const result={arm:cfg.arm,stage:req.stage,transport_control:cfg.arm,semantic_handoff:'none; controller records transport state only'};
 if(cfg.arm==='control-git'){
  const bare=remotePath(cfg.root),refs=remoteRefs(bare);
  const head=tryGit(req.workspace,'rev-parse','HEAD');
  const containing=head?refs.filter(r=>{try{git(bare,'merge-base','--is-ancestor',head,r.commit);return true;}catch{return false;}}):[];
  const dirty=tryGit(req.workspace,'status','--porcelain');
  Object.assign(result,{shared_remote:bare,worktree_head:head,remote_refs:refs,head_pushed:containing.length>0,refs_containing_head:containing.map(r=>r.ref),
   uncommitted_paths:dirty===null?null:dirty.split('\n').filter(Boolean).length,
   loss_note:containing.length>0?null:'final worktree HEAD is not on any remote ref; unpushed work is not transported'});
  return result;
 }
 if(cfg.arm==='handoff-note'){
  const dir=notesPath(cfg.root),source=path.join(req.workspace,'HANDOFF.md'),target=path.join(dir,req.stage+'.md');
  let stat=null;try{stat=fs.lstatSync(source);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!stat){return Object.assign(result,{note_absent:true,note:null,reason:'HANDOFF.md absent from the final worktree; nothing copied'});}
  if(!stat.isFile()){return Object.assign(result,{note_absent:true,note:null,reason:'HANDOFF.md is not a regular file; nothing copied'});}
  const bytes=fs.readFileSync(source);
  fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
  return Object.assign(result,{note_absent:false,note:{path:target,sha256:sha(bytes),bytes:bytes.length}});
 }
 throw new Error('not a transport control arm: '+cfg.arm);
}

export function exportControl(cfg){
 if(cfg.arm==='control-git'){
  const bare=remotePath(cfg.root),refs=remoteRefs(bare),out={shared_remote:bare,remote_refs:refs};
  if(refs.length){out.bundle=path.join(cfg.root,'shared-remote-export.bundle');git(bare,'bundle','create',out.bundle,'--all');out.bundle_sha256=sha(fs.readFileSync(out.bundle));}
  return out;
 }
 if(cfg.arm==='handoff-note'){
  const dir=notesPath(cfg.root);
  return {handoff_notes:dir,notes:fs.readdirSync(dir).filter(n=>n.endsWith('.md')).sort().map(n=>{const b=fs.readFileSync(path.join(dir,n));return {name:n,sha256:sha(b),bytes:b.length};})};
 }
 throw new Error('not a transport control arm: '+cfg.arm);
}

/** Path-grant isolation: no read/write grant may overlap a controller-private path. */
export function grantIsolation(grants,protectedPaths){
 const real=p=>{try{return fs.realpathSync(p);}catch{return path.resolve(p);}};
 const overlaps=(a,b)=>a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);
 const violations=[];
 for(const grant of grants){const g=real(grant);for(const blocked of protectedPaths){const b=real(blocked);if(overlaps(g,b))violations.push({grant:g,protected:b});}}
 return {pass:violations.length===0,violations,checked_grants:grants.map(real),protected:protectedPaths.map(real)};
}
