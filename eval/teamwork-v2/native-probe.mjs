#!/usr/bin/env node
// Unscored transport/capture smoke. Synthetic hook input is explicitly not a task-agent trial.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync,execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {provision,prepareStage} from './native-lifecycle.mjs';
import {startProxy} from './native-http-proxy.mjs';
const run=promisify(execFile),cf=path.resolve(process.argv[2]),cfg=JSON.parse(fs.readFileSync(cf,'utf8'));
const write=(f,o)=>fs.writeFileSync(f,JSON.stringify(o,null,2)+'\n',{mode:0o600}),sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={arm:cfg.arm,native_version:cfg.version,development_probe:true,scored:false,task_agent_probe:false,capture_recall_pass:false,isolation_pass:false,steps:[]};
const save=()=>write(path.join(cfg.root,'probe-result.json'),result);let server,client;
try{
 const state=await provision(cfg);const token=crypto.randomBytes(24).toString('hex'),marker='CANARY_'+crypto.randomBytes(12).toString('hex');
 const route={provider:cfg.arm==='supermemory'?'supermemory':'openai',namespace:state.namespace,sequence:cfg.arm+'-readiness',token,
  ...(cfg.arm==='supermemory'?{key_file:path.join(cfg.root,'supermemory-private.json')}:{env_file:cfg.openai_env_file,env_name:'OPENAI_API_KEY'})};
 const proxyConfig={budget_file:cfg.budget_file,routes:[route],trace_file:path.join(cfg.root,'http.jsonl'),ready_file:path.join(cfg.root,'proxy-ready.json')};
 const pc=path.join(cfg.root,'proxy-config.json');write(pc,proxyConfig);const started=await startProxy(proxyConfig);server=started.server;
 const base=`http://127.0.0.1:${started.port}`;cfg.provider_env=cfg.arm==='supermemory'?{SUPERMEMORY_CODEX_API_KEY:token,SUPERMEMORY_API_URL:base,SUPERMEMORY_MCP_URL:base+'/mcp'}:{OPENAI_API_KEY:token,OPENAI_BASE_URL:base+'/v1'};
 cfg.proxy_config=pc;cfg.proxy_ready_file=proxyConfig.ready_file;
 const proxyReceipt={pid:process.pid,port:started.port,host:'127.0.0.1',config_sha256:sha(pc),proxy_sha256:sha(new URL('./native-http-proxy.mjs',import.meta.url)),live_probe_pass:false};write(proxyConfig.ready_file,proxyReceipt);write(cf,cfg);
 const request=async(url,body)=>{const r=await fetch(base+url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error('readiness HTTP denied: '+url+' '+r.status);return r.json();};
 const call=async(name,args)=>{const r=await client.callTool({name,arguments:args},undefined,{timeout:180000});result.steps.push({name,args,result:r});save();if(r.isError)throw new Error('native tool failed: '+name);return r;};
 for(const stage of ['A','B']){
  const baseDir=path.join(cfg.root,stage),workspace=path.join(baseDir,'workspace'),home=path.join(baseDir,'home'),output=path.join(baseDir,'controller');for(const p of [workspace,home,output])fs.mkdirSync(p,{recursive:true,mode:0o700});
  execFileSync('git',['init','-q'],{cwd:workspace});execFileSync('git',['-c','user.name=probe','-c','user.email=probe@evaluation.invalid','commit','--allow-empty','-qm','readiness baseline'],{cwd:workspace});
  const req={arm:cfg.arm,stage,runtime:cfg.runtime,native_config:cf,native_profile:path.join(output,'profile.json'),fresh_home:home,workspace,controller_output_dir:output};await prepareStage(req);const profile=JSON.parse(fs.readFileSync(req.native_profile,'utf8'));
  if(cfg.arm==='supermemory'){
   const transcript=path.join(home,'.codex','readiness.jsonl');fs.writeFileSync(transcript,JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:`Remember our synthetic release decision: the silver otter feature uses freshwater mode. Its acceptance identifier is ${marker}. This invented readiness source is not benchmark evidence.`}]}})+'\n');
   const hook=stage==='A'?'flush.js':'recall.js';const child=spawn(process.execPath,[path.join(home,'.codex','supermemory',hook)],{cwd:workspace,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:path.join(home,'.codex'),...cfg.provider_env},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
   child.stdin.end(JSON.stringify({session_id:crypto.randomUUID(),transcript_path:stage==='A'?transcript:null,cwd:workspace,prompt:'What release mode and acceptance identifier does silver otter use?'}));const timer=setTimeout(()=>child.kill('SIGKILL'),35000);const code=await new Promise(r=>child.on('close',r));clearTimeout(timer);
   result.steps.push({native_hook:hook,exit_code:code,stdout,stderr});save();if(code!==0)throw new Error('official hook did not complete');if(stage==='B')result.native_hook_recall=stdout.includes(marker);
  }
  const spec=Object.values(profile.mcp)[0];client=new Client({name:'teamwork-unscored-native-probe',version:'2.0.0'});
  await client.connect(new StdioClientTransport({command:spec.command,args:spec.args,env:{PATH:process.env.PATH,...spec.env},cwd:spec.cwd,stderr:'ignore'}));
  const tools=await client.listTools();write(path.join(output,'native-tools.json'),tools);
  if(stage==='A'){
   if(cfg.arm==='gbrain')await call('put_page',{slug:'silver-otter-release',content:`---\ntitle: Silver otter release decision\ntags: [readiness]\n---\nThe silver otter release uses freshwater mode. Its acceptance identifier is ${marker}.`});
   if(cfg.arm==='graphify'){await call('graphify_write_source',{id:'silver-otter.md',content:`# Silver otter release\nThe silver otter release uses freshwater mode. Its acceptance identifier is ${marker}. Freshwater mode depends on the river gate check.`});await call('graphify_extract',{});}
   // Supermemory A was captured by its unchanged official flush hook above.
  }else{
   const r=cfg.arm==='gbrain'?await call('query',{query:'silver otter release freshwater acceptance identifier',detail:'high',limit:5}):cfg.arm==='graphify'?await call('graphify_query',{query:'silver otter freshwater acceptance identifier',budget:3000}):await call('search_memory',{containerTag:state.namespace,query:'silver otter freshwater acceptance identifier'});
   result.capture_recall_pass=JSON.stringify(r).includes(marker);
   if(cfg.arm==='graphify'&&!result.capture_recall_pass){const original=await call('graphify_read_source',{id:'silver-otter.md'});result.capture_recall_pass=JSON.stringify(original).includes(marker);result.graph_query_exact_canary=JSON.stringify(r).includes(marker);}
  }
  await client.close();client=null;
  if(stage==='A'&&cfg.arm==='supermemory')for(let i=0;i<60;i++){const list=await request('/v3/documents/list',{containerTag:state.namespace,page:1,limit:100});if(list.memories?.length&&list.memories.every(d=>d.status==='done'))break;await new Promise(r=>setTimeout(r,2000));}
 }
 const bad=await fetch(base+(cfg.arm==='supermemory'?'/v4/search':'/v1/embeddings'),{method:'POST',headers:{authorization:'Bearer denied-token','content-type':'application/json'},body:'{}'});result.proxy_auth_denied=bad.status===401;
 if(cfg.arm==='supermemory'){const foreign=await fetch(base+'/v4/search',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({containerTag:state.namespace+'_foreign',q:'x'})});result.foreign_scope_denied=foreign.status===403;result.isolation_pass=result.proxy_auth_denied&&result.foreign_scope_denied;}
 else result.isolation_pass=result.proxy_auth_denied; // kernel task-agent isolation is a distinct host probe.
 proxyReceipt.live_probe_pass=result.capture_recall_pass&&result.isolation_pass;write(proxyConfig.ready_file,proxyReceipt);
}catch(error){result.failure=String(error.message).replace(/(?:sm_|sk-)[A-Za-z0-9_-]+/g,'[redacted]').slice(0,500);}finally{if(client)await client.close().catch(()=>{});if(server)await new Promise(r=>server.close(r));save();}
console.log(JSON.stringify({arm:cfg.arm,capture_recall_pass:result.capture_recall_pass,isolation_pass:result.isolation_pass,failure:result.failure??null,result_file:path.join(cfg.root,'probe-result.json')}));
