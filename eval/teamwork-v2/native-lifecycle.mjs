#!/usr/bin/env node
/** Controller-only native provisioning. No reference answers or summaries are imported. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),run=promisify(execFile);
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const write=(f,o)=>fs.writeFileSync(f,JSON.stringify(o,null,2)+'\n',{mode:0o600});
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const q=s=>"'"+s.replace(/'/g,"'\\''")+"'";
const load=(cfg,name)=>import(pathToFileURL(path.join(cfg.runtime,'eval',name+'.js')).href);
export function config(file){const cfg=read(file);for(const k of ['arm','root','runtime','guide_file'])if(!cfg[k])throw new Error('native config missing '+k);cfg.root=fs.realpathSync(cfg.root);return cfg;}
function statePath(cfg){return path.join(cfg.root,'native-state.json');}
function owned(cfg,p){const real=fs.realpathSync(p);if(!real.startsWith(cfg.root+path.sep))throw new Error('stage path outside owned native sequence');return real;}
function env(home,more={}){return {PATH:process.env.PATH,HOME:home,TMPDIR:home,LANG:'en_US.UTF-8',LEDGER_EVAL:'1',...more};}
function gbrain(cfg,args,key){return execFileSync(cfg.gbrain_binary??'gbrain',args,{encoding:'utf8',timeout:120000,maxBuffer:20<<20,env:env(path.join(cfg.root,'gbrain-home'),{...(key?{OPENAI_API_KEY:key}:{}),...cfg.provider_env})});}
async function credentials(cfg){const m=await load(cfg,'analytical-credentials');return m.readGbrainEmbeddingKey(cfg.openai_env_file);}
function keyFile(file,name){const raw=fs.readFileSync(file,'utf8');const found=raw.match(new RegExp('(?:^|\\n)(?:export\\s+)?'+name+'\\s*=\\s*([^\\n]+)'));if(!found)throw new Error('required controller credential missing');return found[1].trim().replace(/^(['"])(.*)\1$/,'$2');}
function verifyEvidence(cfg){
 if(!cfg.readiness_receipt)return false;
 const r=read(cfg.readiness_receipt);
 return r.arm===cfg.arm&&r.capture_recall_pass===true&&r.isolation_pass===true&&r.native_version===cfg.version;
}
function verifyNetworkGate(cfg){
 if(cfg.arm==='fresh-agent'||cfg.arm==='ledger')return true;
 if(!cfg.proxy_ready_file||!cfg.proxy_config)return false;
 const receipt=read(cfg.proxy_ready_file);
 return receipt.live_probe_pass===true&&receipt.config_sha256===sha(cfg.proxy_config)&&receipt.proxy_sha256===sha(path.join(here,'native-http-proxy.mjs'));
}
async function scopedSupermemory(cfg){
 const api=await load(cfg,'analytical-supermemory'),token=cfg.provider_env?.SUPERMEMORY_CODEX_API_KEY,base=cfg.provider_env?.SUPERMEMORY_API_URL;
 if(!token||!base||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw new Error('controller Supermemory calls require loopback budget proxy');
 return api.supermemoryClient(token,(input,init)=>{const url=new URL(String(input));return fetch(base+url.pathname+url.search,{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),authorization:`Bearer ${token}`},redirect:'error'});});
}
export async function provision(cfg){
 if(fs.existsSync(statePath(cfg)))throw new Error('native sequence already provisioned');
 if(cfg.execution_authorized!==true)throw new Error('native setup authorization missing');
 const namespace='ledger_eval_'+crypto.randomBytes(16).toString('hex');
 if(fs.existsSync(path.join(cfg.root,'ownership.json')))throw new Error('native root already has an owner');
 write(path.join(cfg.root,'ownership.json'),{namespace});
 const state={arm:cfg.arm,namespace,created_at:new Date().toISOString(),version:cfg.version,stages:[]};
 if(cfg.arm==='ledger'){
  const api=await load(cfg,'analytical-ledger-native');const native=await api.prepareLedgerNative(cfg.root,namespace,cfg.runtime);
  fs.mkdirSync(path.join(cfg.root,'ledger'),{mode:0o700});state.database_name=native.databaseName;
 }else if(cfg.arm==='gbrain'){
  const home=path.join(cfg.root,'gbrain-home');fs.mkdirSync(home,{mode:0o700});
  const version=gbrain(cfg,['--version']).trim();if(version!==cfg.version)throw new Error('GBrain version differs from freeze');
  gbrain(cfg,['init','--pglite']);const c=read(path.join(home,'.gbrain','config.json'));
  if(c.engine!=='pglite'||!path.resolve(c.database_path).startsWith(home+path.sep))throw new Error('GBrain database escaped sequence');
 }else if(cfg.arm==='graphify'){
  const version=execFileSync(cfg.graphify.binary,['--version'],{encoding:'utf8'}).trim();if(!version.endsWith(cfg.graphify.version))throw new Error('Graphify version differs from freeze');
 }else if(cfg.arm==='supermemory'){
  // Scoped-key creation is setup; charged document operations still require the proxy gate.
  const api=await load(cfg,'analytical-supermemory');process.env.SUPERMEMORY_API_KEY=keyFile(cfg.supermemory_env_file,'SUPERMEMORY_API_KEY');
  try{const key=await api.createTrialSupermemoryKey(namespace);write(path.join(cfg.root,'supermemory-private.json'),{key:key.key,id:key.id});state.scoped_key_id=key.id;}finally{delete process.env.SUPERMEMORY_API_KEY;}
 }else if(cfg.arm!=='fresh-agent')throw new Error('arm is not handled by native lifecycle');
 write(statePath(cfg),state);return {arm:cfg.arm,namespace,state_file:statePath(cfg),provisioned:true,readiness_verified:false};
}
export async function prepareStage(req){
 const cfg=config(req.native_config),state=read(statePath(cfg));
 if(req.arm!==cfg.arm||state.arm!==cfg.arm)throw new Error('native stage arm mismatch');
 owned(cfg,req.workspace);owned(cfg,req.fresh_home);owned(cfg,req.controller_output_dir);
 if(state.stages.includes(req.stage))throw new Error('native stage already prepared');
 const p={arm:cfg.arm,guide_file:cfg.guide_file,guide_sha256:sha(cfg.guide_file),mcp:{},hook_env:{},read_paths:[path.resolve(cfg.runtime,'..','node_modules'),...(cfg.read_paths??[])],write_paths:[],ca_file:cfg.ca_file,
  readiness_verified:verifyEvidence(cfg),paid_paths_gated:verifyNetworkGate(cfg)&&Boolean(cfg.arm==='fresh-agent'||(cfg.budget_gate_module&&cfg.budget_file)),budget_gate_module:cfg.budget_gate_module,budget_file:cfg.budget_file,operation_bounds:cfg.operation_bounds};
 if(cfg.arm==='ledger'){
  const api=await load(cfg,'analytical-ledger-native');const native=read(path.join(cfg.root,'ledger-native-owner.json'));
  const stage={home:req.fresh_home,worktree:req.workspace,harness:'codex',person:`benchmark-${req.stage.toLowerCase()}`,role:`stage-${req.stage}`};
  const setup=await api.prepareLedgerStage(native,stage,{restoreSnapshot:false});
  const classifier=path.join(req.controller_output_dir,'classifier-config.json');
  write(classifier,{output:req.controller_output_dir,stage_home:req.fresh_home,model:'gpt-5.6-sol',subscription_authorized:cfg.classifier_subscription_authorized===true,binary:cfg.codex_binary});
  setup.config.continuity.classify=true;setup.config.extractor='codex';write(path.join(req.fresh_home,'.ledger','config.json'),setup.config);
  const hookEnv={...setup.env,LEDGER_CLASSIFY:'1',LEDGER_EXTRACTOR:'codex',LEDGER_EXTRACTOR_CMD:`${q(process.execPath)} ${q(path.join(here,'native-classifier.mjs'))} ${q(classifier)}`};
  // Extraction stays controller-side; task hooks capture evidence but cannot launch an unmetered model.
  const hookEnvTask={...hookEnv,LEDGER_EXTRACTOR:'none',LEDGER_CLASSIFY:'0'};delete hookEnvTask.LEDGER_EXTRACTOR_CMD;
  p.hooks={hooks:setup.hooks};p.hook_env=hookEnvTask;p.mcp.ledger={command:process.execPath,args:[path.join(cfg.runtime,'cli.js'),'mcp'],env:hookEnvTask,cwd:req.workspace};
  p.write_paths.push(path.join(cfg.root,'ledger'));p.read_paths.push(native.remote);
  req.native_root=cfg.root;write(path.join(req.controller_output_dir,'native-capture-request.json'),req);write(path.join(req.controller_output_dir,'native-capture-env.json'),hookEnv);
 }else if(cfg.arm==='gbrain'){
  if(!cfg.provider_env?.OPENAI_BASE_URL||!cfg.provider_env?.OPENAI_API_KEY)throw new Error('GBrain requires controller proxy URL and surrogate key');
  p.mcp.gbrain={command:cfg.gbrain_binary??'gbrain',args:['serve'],env:env(path.join(cfg.root,'gbrain-home'),cfg.provider_env),cwd:path.join(cfg.root,'gbrain-home')};
 }else if(cfg.arm==='graphify'){
  if(!cfg.provider_env?.OPENAI_BASE_URL||!cfg.provider_env?.OPENAI_API_KEY)throw new Error('Graphify requires controller proxy URL and surrogate key');
  // The older scoped adapter intentionally scrubs env. A CLI launcher preserves only the approved proxy endpoint.
  const launcher=path.join(req.controller_output_dir,'graphify-proxy-cli');fs.writeFileSync(launcher,`#!/bin/sh\nOPENAI_BASE_URL=${q(cfg.provider_env.OPENAI_BASE_URL)} exec ${q(cfg.graphify.binary)} "$@"\n`,{mode:0o700});
  const conf=path.join(req.controller_output_dir,'graphify-config.json');write(conf,{...cfg,graphify:{...cfg.graphify,binary:launcher},namespace:state.namespace,trace_file:path.join(req.controller_output_dir,'graphify-native.jsonl')});
  p.mcp.graphify={command:process.execPath,args:[path.join(here,'native-graphify.mjs'),conf],env:env(req.controller_output_dir,cfg.provider_env),cwd:req.controller_output_dir};
 }else if(cfg.arm==='supermemory'){
  const api=await load(cfg,'analytical-native');const codexHome=path.join(req.fresh_home,'.codex');api.copyFrozenDirectory(cfg.supermemory_template,codexHome);api.writeNativeSupermemorySettings(req.workspace,req.fresh_home,state.namespace);
  const hooks=JSON.parse(fs.readFileSync(path.join(codexHome,'hooks.json'),'utf8').split('{{HOME}}').join(req.fresh_home));
  for(const group of hooks.hooks.Stop??[])for(const h of group.hooks??[])h.async=false;
  if(!cfg.provider_env?.SUPERMEMORY_MCP_URL||!cfg.provider_env?.SUPERMEMORY_API_URL)throw new Error('official Supermemory hooks and MCP require controller budget proxy URLs');
  p.hooks=hooks;p.hook_env={...cfg.provider_env};p.mcp.supermemory={command:process.execPath,args:[path.join(codexHome,'supermemory','mcp-proxy.js')],env:env(req.fresh_home,cfg.provider_env),cwd:req.workspace};
 }
 state.stages.push(req.stage);write(statePath(cfg),state);write(req.native_profile,p);
 return {profile:req.native_profile,arm:cfg.arm,readiness_verified:p.readiness_verified};
}
export async function captureStage(req){
 const cfg=config(req.native_config),state=read(statePath(cfg)),start=Date.now();let result={arm:cfg.arm};
 if(cfg.arm==='ledger'){
  const file=path.join(req.controller_output_dir,'native-capture-request.json'),vars=read(path.join(req.controller_output_dir,'native-capture-env.json'));
  const lock=path.join(req.controller_output_dir,'native-capture.lock');let fd;
  if(fs.existsSync(lock)){
   const prior=read(lock);let alive=true;try{process.kill(prior.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
   if(alive)return {arm:cfg.arm,busy:true};fs.unlinkSync(lock);
  }
  try{fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,created_at:new Date().toISOString()}));}catch(e){if(e.code==='EEXIST')return {arm:cfg.arm,busy:true};throw e;}
  try{const {stdout}=await run(process.execPath,[path.join(here,'native-ledger-capture.mjs'),file],{env:env(req.fresh_home,vars),cwd:req.workspace,timeout:125000,maxBuffer:8<<20});result={...result,...JSON.parse(stdout)};}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
 }else if(cfg.arm==='gbrain'){
  result.health=JSON.parse(gbrain(cfg,['call','get_health','{}']));result.pages=JSON.parse(gbrain(cfg,['call','list_pages','{"limit":100}']));result.capture_mode='native agent pages; no controller-authored notes';
 }else if(cfg.arm==='graphify'){
  const root=path.join(cfg.root,'graphify');result.extraction=fs.existsSync(path.join(root,'extraction.json'))?read(path.join(root,'extraction.json')):null;result.capture_mode='agent-authored corpus and native extraction';
  const stageCfg=read(path.join(req.controller_output_dir,'graphify-config.json')),api=await load(cfg,'analytical-graphify');
  process.env.OPENAI_API_KEY=cfg.provider_env.OPENAI_API_KEY;
  const graph=api.graphifyStore({arm:'graphify',root:cfg.root,namespace:state.namespace,mode:'native',task:{provenance:{externalExportAllowed:true}},allowExternalExport:true,allowPaidOperations:true,graphify:{...stageCfg.graphify,maxOutputTokens:4096,maxRetries:0,apiTimeoutSeconds:120},trace:(operation,detail)=>fs.appendFileSync(stageCfg.trace_file,JSON.stringify({at:new Date().toISOString(),operation,detail,controller_indexing:true})+'\n')});
  const sources=graph.sources();result.sources=sources;result.current_after_agent=JSON.stringify(result.extraction?.sources)===JSON.stringify(sources);
  if(sources.length&&!result.current_after_agent){graph.extract();result.controller_extraction=true;result.extraction=read(path.join(root,'extraction.json'));}
 }else if(cfg.arm==='supermemory'){
  const client=await scopedSupermemory(cfg);let docs=[];const deadline=Date.now()+(cfg.provider_wait_ms??120000);
  for(;;){docs=[];for(let page=1;page<=100;page++){const out=await client.post('/v3/documents/list',{body:{containerTag:state.namespace,page,limit:100}});docs.push(...(out.memories??[]));if(page>=(out.pagination?.totalPages??1))break;}
   if(!docs.length||docs.every(d=>['done','failed'].includes(d.status))||Date.now()>=deadline)break;await new Promise(r=>setTimeout(r,2000));}
  result.documents=docs;result.processing_complete=docs.length>0&&docs.every(d=>d.status==='done');
 }
 result.elapsed_ms=Date.now()-start;const file=path.join(req.controller_output_dir,`native-capture-${Date.now()}.json`);write(file,result);return {...result,receipt_file:file};
}
export async function exportSequence(cfg){
 let out={arm:cfg.arm};if(cfg.arm==='ledger'){const api=await load(cfg,'analytical-ledger-native');out={...out,...await api.exportLedgerNative(read(path.join(cfg.root,'ledger-native-owner.json')))};}
 if(cfg.arm==='gbrain'){const dir=path.join(cfg.root,'gbrain-export');gbrain(cfg,['export','--dir',dir]);out.directory=dir;}
 if(cfg.arm==='graphify')out.directory=path.join(cfg.root,'graphify');
 if(cfg.arm==='supermemory'){
  const state=read(statePath(cfg)),client=await scopedSupermemory(cfg),docs=[];
  for(let page=1;page<=100;page++){
   const listed=await client.post('/v3/documents/list',{body:{containerTag:state.namespace,page,limit:100}});
   for(const row of listed.memories??[])docs.push({listed:row,document:await client.documents.get(row.id)});
   if(page>=(listed.pagination?.totalPages??1))break;
  }
  out.file=path.join(cfg.root,'supermemory-export.json');write(out.file,docs);out.sha256=sha(out.file);out.documents=docs.length;
 }
 write(path.join(cfg.root,'native-export.json'),out);return out;
}
export async function cleanupSequence(cfg){
 if(!fs.existsSync(path.join(cfg.root,'native-export.json')))throw new Error('export must succeed before cleanup');
 if(cfg.arm==='ledger'){const api=await load(cfg,'analytical-ledger-native');await api.closeLedgerNative(read(path.join(cfg.root,'ledger-native-owner.json')));}
 if(cfg.arm==='supermemory'){
  const api=await load(cfg,'analytical-supermemory'),key=read(path.join(cfg.root,'supermemory-private.json'));
  const client=api.supermemoryClient(keyFile(cfg.supermemory_env_file,'SUPERMEMORY_API_KEY'));
  await client.delete(`/v3/auth/scoped-key/${encodeURIComponent(key.id)}`);fs.unlinkSync(path.join(cfg.root,'supermemory-private.json'));
 }
 const result={arm:cfg.arm,cleaned_at:new Date().toISOString(),retained:'local exports, source corpus and Git evidence; Supermemory documents retained, scoped key revoked'};
 write(path.join(cfg.root,'native-cleanup.json'),result);return result;
}
async function main(){const [op,file]=process.argv.slice(2);if(op==='provision')return provision(config(file));if(op==='stage')return prepareStage(read(file));if(op==='capture')return captureStage(read(file));if(op==='export')return exportSequence(config(file));if(op==='cleanup')return cleanupSequence(config(file));if(op==='periodic'){
 const req=read(file);if(req.arm!=='ledger')return {skipped:true};
 for(;;){await new Promise(r=>setTimeout(r,30000));if(!fs.existsSync(path.join(req.fresh_home,'.codex','auth.json')))continue;try{await captureStage(req);}catch(error){fs.appendFileSync(path.join(req.controller_output_dir,'native-periodic-errors.jsonl'),JSON.stringify({at:new Date().toISOString(),error:String(error.message).slice(0,500)})+'\n');}}
 }throw new Error('usage: native-lifecycle.mjs provision|stage|capture|periodic|export CONFIG_OR_REQUEST.json');}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{console.log(JSON.stringify(await main()));}catch(error){console.error('Native lifecycle failed: '+String(error.message).replace(/(?:sk-|sm_)[A-Za-z0-9_-]+/g,'[redacted]'));process.exitCode=1;}
