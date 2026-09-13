/** Bind the official, hash-pinned Mem0 Codex plugin to isolated benchmark identities. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n',{mode:0o600});
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const [op,file]=process.argv.slice(2);
const req=read(file),cfg=read(req.native_config??file);
if(op==='stage'){
 const proxy=read(cfg.proxy_ready),plugin=cfg.plugin_root;
 if(req.arm!=='mem0')throw new Error('arm mismatch');
 const data=path.join(req.fresh_home,'.mem0','codex-plugin');fs.mkdirSync(data,{recursive:true,mode:0o700});
 // A stable fake Git remote is an identity only; it is never contacted.
 const remote=`https://benchmark.invalid/${cfg.namespace}/repository.git`;
 execFileSync('git',['-C',req.workspace,'config','remote.origin.url',remote]);
 const hookEnv={MEM0_API_KEY:proxy.token,MEM0_API_URL:proxy.url,MEM0_PROJECT_ID:cfg.namespace,
  MEM0_CODE_USER_ID:cfg.namespace+'-'+req.stage,MEM0_PLUGIN_DATA_DIR:data,MEM0_CODE_DATA_DIR:data,
  MEM0_TELEMETRY:'false',MEM0_CODE_EXTRACTION_WAIT_SECONDS:'120'};
 const hooks=JSON.parse(fs.readFileSync(path.join(plugin,'hooks/hooks.json'),'utf8').replaceAll('${PLUGIN_ROOT}',plugin).replaceAll('${PLUGIN_DATA}',data));
 // The shell's Anaconda Python lives in another user-tree grant; use the system stdlib interpreter.
 for(const groups of Object.values(hooks.hooks))for(const group of groups)for(const hook of group.hooks)hook.command=hook.command.replace(/^python3 /,'/usr/bin/python3 ');
 const receipt=cfg.readiness_receipt?read(cfg.readiness_receipt):{};
 const ready=receipt.capture_recall_pass===true&&receipt.isolation_pass===true&&receipt.native_version===cfg.version;
 const profile={arm:'mem0',guide_file:cfg.guide_file,guide_sha256:hash(cfg.guide_file),hooks,hook_env:hookEnv,
  readiness_verified:ready,paid_paths_gated:true,budget_gate_module:cfg.budget_gate_module,budget_file:cfg.budget_file,
  operation_bounds:{mem0:{search_memories:{usd:0,basis:'HTTP proxy enforces fresh no-billing evaluation account and request quota',max_input_chars:4000}}},
  read_paths:[plugin],write_paths:[],ca_file:cfg.ca_file,
  mcp:{mem0:{command:'/usr/bin/python3',args:[path.join(plugin,'core/mcp_server.py')],cwd:req.workspace,
    env:{PATH:process.env.PATH,HOME:req.fresh_home,...hookEnv}}}};
 write(req.native_profile,profile);console.log(JSON.stringify({prepared:true,readiness_verified:ready}));
}else if(op==='capture'){
 const deadline=Date.now()+125000;let evidence;
 do{
  const python=`import os,json,sys\nsys.path.insert(0,sys.argv[1])\nfrom memory_core import EvidenceStore,resolve_repo\ns=EvidenceStore()\nr=resolve_repo(sys.argv[2])\nprint(json.dumps({'status':s.status(r.identity),'flushes':[dict(x) for x in s.conn.execute('SELECT * FROM flushes').fetchall()]}))\ns.close()`;
  const data=path.join(req.fresh_home,'.mem0','codex-plugin');
  evidence=JSON.parse(execFileSync('python3',['-c',python,path.join(cfg.plugin_root,'core'),req.workspace],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:req.fresh_home,MEM0_PROJECT_ID:cfg.namespace,MEM0_CODE_DATA_DIR:data,MEM0_TELEMETRY:'false'}}));
  if(evidence.flushes.length&&evidence.flushes.every(x=>x.status==='semantic-succeeded'))break;
  await new Promise(r=>setTimeout(r,1000));
 }while(Date.now()<deadline);
 evidence.capture_complete=evidence.flushes.length>0&&evidence.flushes.every(x=>x.status==='semantic-succeeded');
 write(path.join(req.controller_output_dir,'native-capture.json'),evidence);console.log(JSON.stringify(evidence));
 if(!evidence.capture_complete)process.exitCode=1;
}else if(op==='export'){
 write(path.join(cfg.root,'native-export.json'),{arm:'mem0',trace:cfg.trace_file,namespace:cfg.namespace,stores_retained:true});
}else throw new Error('usage: native-mem0-lifecycle.mjs stage|capture|export REQUEST_OR_CONFIG.json');
