#!/usr/bin/env node
/** Loopback-only, sequence-token authenticated network gate. Provider keys never enter native task processes. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {reserve,reconcile} from './budget-gate.mjs';
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const size=o=>Buffer.byteLength(JSON.stringify(o));
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const fail=message=>{throw new Error(message);};
function plain(text){if(typeof text!=='string'||!text.trim()||/^\s*(?:https?:|data:|file:)/i.test(text))fail('only inline plain text ingestion is bounded');}
function scope(body,namespace){
 for(const key of ['containerTag','container_tag','projectContainerTag','userContainerTag'])if(body[key]!==undefined&&body[key]!==namespace)fail('foreign container is forbidden');
 if(body.containerTags!==undefined&&(!Array.isArray(body.containerTags)||body.containerTags.length!==1||body.containerTags[0]!==namespace))fail('foreign container list is forbidden');
}
export function classifyRequest(route,method,pathname,body){
 const bytes=size(body);if(bytes>2*1024*1024)fail('request exceeds two MiB bound');
 if(route.provider==='openai'){
  if(method!=='POST')fail('OpenAI method not permitted');
  if(pathname==='/v1/embeddings'){
   if(body.model!=='text-embedding-3-large')fail('unpriced embedding model');
   const inputs=typeof body.input==='string'?[body.input]:body.input;
   if(!Array.isArray(inputs)||!inputs.length||inputs.some(s=>typeof s!=='string'))fail('only string embedding input is bounded');
   const bound=(bytes+1024)*0.13/1e6;
   return {origin:'https://api.openai.com',path:pathname,bound,basis:'UTF8 request bytes +1024 overhead at $0.13/M embedding tokens',rate:{input:0.13,output:0}};
  }
  if(pathname==='/v1/chat/completions'){
   if(!['gpt-4.1-mini','gpt-4.1-mini-2025-04-14'].includes(body.model))fail('unpriced generation model');
   if(body.stream||body.tools||body.functions||body.modalities||body.audio||(body.n??1)!==1)fail('only nonstreamed single text completion is bounded');
   if(!Array.isArray(body.messages)||body.messages.some(m=>typeof m.content!=='string'))fail('only text messages are bounded');
   const output=body.max_completion_tokens??body.max_tokens;if(!Number.isInteger(output)||output<1||output>4096)fail('explicit output limit at most4096 required');
   const bound=((bytes+1024+body.messages.length*64)*0.4+output*1.6)/1e6;
   return {origin:'https://api.openai.com',path:pathname,bound,basis:'UTF8 bytes + message framing overhead; capped output; official gpt-4.1-mini $0.40/$1.60 perM',rate:{input:0.4,output:1.6}};
  }
  fail('OpenAI route has no price bound');
 }
 if(route.provider!=='supermemory')fail('unknown provider');
 if(pathname==='/mcp'){
  if(method!=='POST')fail('only explicit MCP request transport permitted');
  if(['initialize','notifications/initialized','ping','tools/list'].includes(body.method))return {origin:'https://mcp.supermemory.ai',path:'/mcp',bound:0.001,basis:'conservative one operations allowance for protocol request'};
  if(body.method!=='tools/call')fail('unknown MCP method');
  const name=body.params?.name,args=body.params?.arguments??{};scope(args,route.namespace);
  if(['add_memory','save-memory'].includes(name)){
   plain(args.content);if(args.url||args.file||args.fileUrl)fail('unbounded rich ingestion');
   return {origin:'https://mcp.supermemory.ai',path:'/mcp',bound:(bytes+1024)*0.00001+0.001,basis:'all UTF8 request bytes +1024 at rich upperSMrate $0.010/1K, no dedup discount; operation allowance'};
  }
  if(['search_memory','getDocument','whoAmI','listDocuments','listMemories','memory-graph','fetch-graph-data'].includes(name))return {origin:'https://mcp.supermemory.ai',path:'/mcp',bound:0.001,basis:'ten operations and 200 searches worth of public rate allowance per native read'};
  fail('unpriced Supermemory MCP tool');
 }
 scope(body,route.namespace);
 if(method==='POST'&&['/v3/documents','/v4/memories'].includes(pathname)){
  plain(body.content);if(body.url||body.file||body.fileUrl||body.documents)fail('only inline plain text ingestion');
  return {origin:'https://api.supermemory.ai',path:pathname,bound:(bytes+1024)*0.00001+0.001,basis:'all UTF8 request bytes+1024 at highest published richSMrate; operation allowance, dedup ignored'};
 }
 if((method==='POST'&&['/v4/search','/v3/search','/v4/profile','/v3/documents/list'].includes(pathname))||(method==='GET'&&/^\/v3\/documents\/[A-Za-z0-9_-]+$/.test(pathname)))return {origin:'https://api.supermemory.ai',path:pathname,bound:0.001,basis:'conservative native read allowance above public per-search/per-operation rates'};
 fail('Supermemory route has no bounded price');
}
function credential(route){
 if(route.key_file){const d=read(route.key_file);if(typeof d[route.key_field??'key']!=='string')fail('private key field absent');return d[route.key_field??'key'];}
 const raw=fs.readFileSync(route.env_file,'utf8');const key=route.env_name??'OPENAI_API_KEY';
 const match=raw.match(new RegExp('(?:^|\\n)(?:export\\s+)?'+key+'\\s*=\\s*([^\\n]+)'));if(!match)fail('private credential absent');return match[1].trim().replace(/^(['"])(.*)\1$/,'$2');
}
export async function startProxy(cfg,{request=fetch}={}){
 if(!fs.existsSync(cfg.budget_file))fail('shared budget must exist before proxy startup');
 const routes=new Map(cfg.routes.map(r=>[r.token,r]));if(routes.size!==cfg.routes.length||[...routes.keys()].some(t=>typeof t!=='string'||t.length<24))fail('unique high-entropy sequence tokens required');
 const events=event=>fs.appendFileSync(cfg.trace_file,JSON.stringify({at:new Date().toISOString(),...event})+'\n',{mode:0o600});
 const server=http.createServer(async(req,res)=>{
  let receipt;try{
   const auth=String(req.headers.authorization??'');const route=routes.get(auth.replace(/^Bearer\s+/i,''));if(!route){res.writeHead(401);res.end('proxy authentication required');return;}
   const url=new URL(req.url,'http://localhost');if(url.search)fail('unclassified query parameters');
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>2*1024*1024)fail('request size exceeds bound');}
   const body=raw?JSON.parse(raw):{};const spec=classifyRequest(route,req.method,url.pathname,body);
   receipt=reserve(cfg.budget_file,`${route.provider}.http.${url.pathname}`,spec.bound,spec.basis,{sequence:route.sequence,request_sha256:hash(raw)});
   const headers={authorization:`Bearer ${credential(route)}`,'content-type':'application/json',accept:req.headers.accept??'application/json'};
   for(const name of ['mcp-session-id','mcp-protocol-version'])if(req.headers[name])headers[name]=req.headers[name];
   const upstream=await request(spec.origin+spec.path,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:raw,redirect:'error',signal:AbortSignal.timeout(125000)});
   const output=await upstream.text();let usage=null;
   if(route.provider==='openai'&&upstream.ok){try{usage=JSON.parse(output).usage;}catch{}
    if(usage&&spec.rate){const input=usage.prompt_tokens??usage.total_tokens,completion=usage.completion_tokens??0;
     if(Number.isFinite(input)&&Number.isFinite(completion))reconcile(cfg.budget_file,receipt.id,(input*spec.rate.input+completion*spec.rate.output)/1e6,JSON.stringify({usage,request_id:upstream.headers.get('x-request-id')}));}
   }
   // Unknown/failed provider charges keep their reservation; no speculative refund.
   events({provider:route.provider,sequence:route.sequence,path:url.pathname,status:upstream.status,reservation:receipt.id,bound_usd:spec.bound,usage,request_sha256:hash(raw),response_sha256:hash(output)});
   const responseHeaders={'content-type':upstream.headers.get('content-type')??'application/json'};
   for(const name of ['mcp-session-id','mcp-protocol-version'])if(upstream.headers.get(name))responseHeaders[name]=upstream.headers.get(name);
   res.writeHead(upstream.status,responseHeaders);res.end(output);
  }catch(error){events({denied:true,reservation:receipt?.id??null,error:String(error.message).slice(0,300)});res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Controller budget/scope gate rejected request',type:'budget_gate'}}));}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(cfg.port??0,'127.0.0.1',resolve);});
 return {server,port:server.address().port};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const cfg=read(process.argv[2]);const {port}=await startProxy(cfg);
 fs.writeFileSync(cfg.ready_file,JSON.stringify({pid:process.pid,port,host:'127.0.0.1',started_at:new Date().toISOString(),config_sha256:hash(fs.readFileSync(process.argv[2])),proxy_sha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),live_probe_pass:false},null,2),{mode:0o600});
 console.log(JSON.stringify({listening:true,port,ready_file:cfg.ready_file}));
}
