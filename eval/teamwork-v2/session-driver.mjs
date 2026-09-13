#!/usr/bin/env node
/** Fresh Codex stage driver. Provisioning and native capture profiles stay controller-side.
 * No model is launched by check/selftest or by benchmark pack generation.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const script=fileURLToPath(import.meta.url);
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const save=(f,v)=>fs.writeFileSync(f,JSON.stringify(v,null,2)+'\n',{mode:0o600,flag:'wx'});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const monotonic=()=>Number(process.hrtime.bigint()/1000000n);

export function snapshotTree(source,destination) {
  fs.mkdirSync(destination,{recursive:false,mode:0o700});const files={};
  const excluded=new Set(['.git','.codex','.ledger','.claude','node_modules','__pycache__','.venv']);
  let bytes=0;
  function walk(from,to,relative='') {
    for(const entry of fs.readdirSync(from,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(excluded.has(entry.name) || entry.name.startsWith('.env')) continue;
      const input=path.join(from,entry.name),output=path.join(to,entry.name),name=path.join(relative,entry.name);
      if(entry.isSymbolicLink())throw new Error('submission snapshots require regular files; symlink '+name);
      if(entry.isDirectory()){fs.mkdirSync(output);walk(input,output,name);}
      else if(entry.isFile()) {
        const content=fs.readFileSync(input);bytes+=content.length;
        if(bytes>50*1024*1024)throw new Error('submission tree exceeds 50 MiB');
        fs.writeFileSync(output,content,{mode:fs.statSync(input).mode & 0o777});files[name]=hash(content);
      }
    }
  }
  walk(source,destination);return {files,bytes,sha256:hash(JSON.stringify(files))};
}

export function deliver(cfg,answer,clock=monotonic) {
  if(fs.existsSync(path.join(cfg.output,'delivery.json')))throw new Error('answer already delivered');
  if(clock()>cfg.deadline)throw new Error('stage deadline passed');
  const encoded=JSON.stringify(answer);
  if(encoded.length>200000)throw new Error('answer exceeds delivery budget');
  const pending=path.join(cfg.output,'.delivery-pending');fs.mkdirSync(pending,{mode:0o700});
  try {
    save(path.join(pending,'answer.json'),answer);
    const tree=cfg.track==='engineering'?snapshotTree(cfg.workspace,path.join(pending,'tree')):null;
    const received=clock();if(received>cfg.deadline)throw new Error('delivery snapshot missed deadline');
    const receipt={schema:'teamwork-delivery/v2',received_monotonic_ms:received,
      elapsed_ms:received-cfg.started,answer_sha256:hash(encoded),tree,
      answer_file_sha256:hash(fs.readFileSync(path.join(pending,'answer.json'))),
      native_handoff:'not assessed by delivery',memory_write_required:false};
    fs.renameSync(pending,path.join(cfg.output,'submission'));
    save(path.join(cfg.output,'delivery.json'),receipt);return receipt;
  } catch(error) {
    fs.rmSync(pending,{recursive:true,force:true});throw error;
  }
}

async function serve(config) {
  const cfg=read(config);const server=new McpServer({name:'teamwork-delivery',version:'2.0.0'});
  server.registerTool('deliver_answer',{
    description:'Deliver the useful task result now. No memory save is required first. This freezes your answer and current code. After delivery, finish native memory handoff within the SAME original deadline. Delivery and handoff are measured separately.',
    inputSchema:{answer:z.record(z.string(),z.unknown())}},async ({answer})=>({content:[{type:'text',text:JSON.stringify(deliver(cfg,answer))}]}));
  await server.connect(new StdioServerTransport());
}

function validateRequest(req) {
  for(const key of ['workspace','fresh_home','controller_output_dir','runtime','native_profile','prompt_file','arm','track','stage','model','reasoning_effort'])
    if(typeof req[key]!=='string'||!req[key])throw new Error('missing '+key);
  if(!Number.isInteger(req.stage_deadline_ms)||req.stage_deadline_ms<=0)throw new Error('positive stage_deadline_ms required');
  if(req.execution_authorized!==true || !req.authorization)throw new Error('new live-stage authorization is absent');
  if(!Array.isArray(req.forbidden_canaries)||req.forbidden_canaries.length<2)throw new Error('controller and foreign-workspace canaries required');
  const workspace=fs.realpathSync(req.workspace),home=fs.realpathSync(req.fresh_home),output=fs.realpathSync(req.controller_output_dir);
  if(output===workspace||output===home||output.startsWith(workspace+path.sep)||output.startsWith(home+path.sep))throw new Error('controller output is visible inside agent roots');
  if(fs.existsSync(path.join(home,'.codex/config.toml')))throw new Error('home was already used by an agent');
  return {...req,workspace,fresh_home:home,controller_output_dir:output};
}

async function run(requestFile) {
  const req=validateRequest(read(requestFile)),profile=read(req.native_profile);
  if(profile.arm!==req.arm)throw new Error('native profile arm mismatch');
  const developmentProbe=req.development_probe===true&&req.scored===false;
  if((profile.readiness_verified!==true&&!developmentProbe) || profile.paid_paths_gated!==true)throw new Error('native readiness or paid-path budget gate not verified');
  if(req.arm==='fresh-agent'&&(profile.hooks||Object.keys(profile.hook_env??{}).length))throw new Error('control must not inherit capture/recall hooks');
  if(!profile.guide_file||!profile.guide_sha256)throw new Error('frozen native guide required');
  const guide=fs.readFileSync(profile.guide_file);
  if(hash(guide)!==profile.guide_sha256)throw new Error('native guide changed since freeze');
  const guideDir=path.join(req.fresh_home,'.claude');fs.mkdirSync(guideDir,{recursive:true});
  const guidePath=path.join(guideDir,'ledger.md');fs.writeFileSync(guidePath,guide,{flag:'wx',mode:0o600});
  // Freeze/verify this source plus runtime and guide in launch preparation; only runtime is readable by the agent.
  const {runSequenceCodex}=await import(pathToFileURL(path.join(req.runtime,'eval/sequence-codex.js')).href);
  const {nativeSequenceTransport}=await import(pathToFileURL(path.join(req.runtime,'eval/sequence-transport.js')).href);
  const sockets=fs.mkdtempSync(path.join(os.tmpdir(),'tw-'));const transports=[];
  let captureProcess;
  const stopCapture=()=>{if(captureProcess?.pid){try{process.kill(-captureProcess.pid,'SIGKILL');}catch{}}};
  process.on('exit',stopCapture);
  const mcp={};const started=monotonic();const wallStarted=Date.now();const output=req.controller_output_dir;
  const cfg={output,workspace:req.workspace,track:req.track,started,deadline:started+req.stage_deadline_ms};
  const cfgFile=path.join(output,'delivery-config.json');save(cfgFile,cfg);
  const append=(name,direction,message)=>fs.appendFileSync(path.join(output,`native-${name}.jsonl`),JSON.stringify({at_monotonic_ms:monotonic(),direction,message})+'\n',{mode:0o600});
  try {
    const permit=profile.budget_gate_module
      ?(await import(pathToFileURL(profile.budget_gate_module).href)).permitNativeCall:null;
    if(req.arm!=='fresh-agent'&&typeof permit!=='function')throw new Error('native transport requires an executable budget gate');
    const servers={...(profile.mcp??{}),delivery:{command:process.execPath,args:[script,'serve',cfgFile],env:{PATH:process.env.PATH,HOME:output},cwd:output}};
    if(req.arm==='fresh-agent'&&Object.keys(profile.mcp??{}).length)throw new Error('control must not have memory servers');
    for(const [name,server] of Object.entries(servers)) {
      if(!/^[a-zA-Z0-9_-]+$/.test(name)||typeof server.command!=='string'||!Array.isArray(server.args))throw new Error('invalid native server');
      const socket=path.join(sockets,name+'.sock');
      transports.push(await nativeSequenceTransport(socket,server.command,server.args,
        {PATH:process.env.PATH,HOME:output,...server.env},server.cwd??output,(d,m)=>append(name,d,m),
        name==='delivery'?undefined:message=>permit(message,{arm:req.arm,stage:req.stage,server:name,request:req,profile})));
      mcp[name]={command:process.execPath,args:[path.join(req.runtime,'eval/sequence-runner.js'),'connect','--socket',socket]};
    }
    if(req.periodic_capture_argv) {
      const argv=req.periodic_capture_argv.map(x=>x.replaceAll('{request}',requestFile));
      if(!argv.length||!argv.every(x=>typeof x==='string'))throw new Error('invalid periodic_capture_argv');
      const log=fs.openSync(path.join(output,'periodic-capture.log'),'wx',0o600);
      captureProcess=spawn(argv[0],argv.slice(1),{cwd:output,env:process.env,detached:true,stdio:['ignore',log,log]});
      fs.closeSync(log);
      captureProcess.on('error',error=>append('capture','error',{message:error.message}));
    }
    const prompt=fs.readFileSync(req.prompt_file,'utf8')+`\nYour frozen product workflow guide is at ${guidePath}; read it before using native memory. `+'Deliver your answer with deliver_answer before final bookkeeping. The immutable submitted code/answer is scored. Finish native handoff within the same deadline. Never claim tests or memory saves that did not run.';
    const remaining=cfg.deadline-monotonic();if(remaining<=0)throw new Error('native setup exhausted stage deadline');
    const result=await runSequenceCodex({home:req.fresh_home,worktree:req.workspace,runtime:req.runtime,prompt,
      model:req.model,reasoningEffort:req.reasoning_effort,timeoutMs:remaining,mcp,
      hooks:profile.hooks,hookEnv:profile.hook_env??{},ledgerHooks:req.arm==='ledger',
      extraEnv:profile.extra_env??{},
      additionalReadPaths:profile.read_paths??[],additionalWritePaths:profile.write_paths??[],
      forbiddenCanaries:req.forbidden_canaries,caFile:profile.ca_file,allowLocalPostgres:req.arm==='ledger'});
    const elapsed=monotonic()-started,wallElapsed=Date.now()-wallStarted;
    const safe={...result,policy:undefined};save(path.join(output,'process.json'),safe);
    // A late process completion cannot turn an already timely delivery into a missing answer.
    const delivered=fs.existsSync(path.join(output,'delivery.json'));
    save(path.join(output,'stage-result.json'),{schema:'teamwork-stage/v2',arm:req.arm,track:req.track,stage:req.stage,
      development_probe:developmentProbe,scored:!developmentProbe,
      delivered,delivery:delivered?read(path.join(output,'delivery.json')):null,
      elapsed_ms:elapsed,wall_elapsed_ms:wallElapsed,timed_out:result.timedOut,
      timing_valid:elapsed<=req.stage_deadline_ms+5000&&wallElapsed<=req.stage_deadline_ms+5000&&Math.abs(wallElapsed-elapsed)<=5000,
      exit_code:result.exitCode,usage:result.usage??null,capture:'requires native post-stage capture receipt',
      isolation:result.isolation,model:req.model,reasoning_effort:req.reasoning_effort});
  } finally {
    stopCapture();process.removeListener('exit',stopCapture);
    for(const t of transports)await t.close().catch(()=>{});
    fs.rmSync(sockets,{recursive:true,force:true});
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===script) {
  const [mode,file]=process.argv.slice(2);
  if(mode==='serve'&&file)await serve(file);
  else if(mode==='run'&&file)await run(file);
  else if(mode==='check'&&file)console.log(JSON.stringify({valid:true,request:validateRequest(read(file)).stage}));
  else {console.error('usage: session-driver.mjs run|check REQUEST.json (serve is controller-internal)');process.exitCode=2;}
}
