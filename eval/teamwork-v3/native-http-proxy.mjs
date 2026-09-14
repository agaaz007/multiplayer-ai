#!/usr/bin/env node
/** Loopback-only, sequence-token authenticated network gate. Provider keys never enter native task processes. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {fileRequest} from './supermemory-files.mjs';
import {reserve,reconcile} from '../teamwork-v2/budget-gate.mjs';
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
 if(route.provider==='anthropic'){
  if(method!=='POST'||pathname!=='/v1/messages')fail('unpriced Anthropic route');
  if(body.model!=='claude-haiku-4-5-20251001')fail('unpriced Anthropic model');
  if(Object.keys(body).some(k=>!['model','max_tokens','system','tools','tool_choice','messages'].includes(k)))fail('only native query expansion fields are priced');
  if(!Number.isInteger(body.max_tokens)||body.max_tokens<1||body.max_tokens>300)fail('native expansion output must be at most300');
  if(typeof body.system!=='string'||!Array.isArray(body.messages)||body.messages.some(m=>m.role!=='user'||typeof m.content!=='string'))fail('only plain native expansion text');
  if(body.tools?.length!==1||body.tools[0].name!=='expand_query'||body.tool_choice?.name!=='expand_query'||body.tool_choice?.type!=='tool')fail('only native expand_query tool is permitted');
  const hasCache=o=>o&&typeof o==='object'&&(Object.hasOwn(o,'cache_control')||Object.values(o).some(hasCache));if(hasCache(body))fail('cache directives are not allowed');
  return {origin:'https://api.anthropic.com',path:pathname,bound:((bytes+8192)*2+body.max_tokens*5)/1e6,basis:'Official Haiku4.5 $1 input/$5 output perM; conservative 2x UTF8+8192 framing allowance; native tool output at most300; no cache directives',rate:{input:1,output:5}};
 }
 if(route.provider==='openai'){
  if(method!=='POST')fail('OpenAI method not permitted');
  if(pathname==='/v1/embeddings'){
   if(body.model!=='text-embedding-3-large')fail('unpriced embedding model');
   const inputs=typeof body.input==='string'?[body.input]:body.input;
   if(!Array.isArray(inputs)||!inputs.length||inputs.some(s=>typeof s!=='string'))fail('only string embedding input is bounded');
   const bound=(bytes+1024)*0.13/1e6;
   return {origin:'https://api.openai.com',path:pathname,bound,basis:'UTF8 request bytes +1024 overhead at $0.13/M embedding tokens',rate:{input:0.13,output:0}};
  }
  if(pathname==='/v1/responses'){
   if(!['gpt-4.1-mini','gpt-4.1-mini-2025-04-14'].includes(body.model))fail('unpriced generation model');
   if(body.stream||body.background||body.previous_response_id||body.conversation)fail('stateful or streaming responses are not bounded');
   if(body.tools?.some(t=>t.type!=='function'))fail('built-in paid tools are not permitted');
   const prohibited=o=>o&&typeof o==='object'&&((typeof o.type==='string'&&/image|audio|video|file|computer|web_search|code_interpreter/.test(o.type))||Object.values(o).some(prohibited));if(prohibited(body))fail('only inline text and local function schemas are bounded');
   if(typeof body.input!=='string'&&!Array.isArray(body.input))fail('inline response input required');
   const output=body.max_output_tokens;if(!Number.isInteger(output)||output<1||output>4096)fail('explicit output limit at most4096 required');
   return {origin:'https://api.openai.com',path:pathname,bound:((bytes+8192)*0.8+output*1.6)/1e6,basis:'Current native OpenAI Responses transport; twice UTF8+8192 framing allowance; output capped4096; gpt-4.1-mini $0.40/$1.60 perM; no built-in tools or remote input references',rate:{input:0.4,output:1.6}};
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
  if(['initialize','notifications/initialized','ping','tools/list','resources/list','resources/templates/list','prompts/list'].includes(body.method))return {origin:'https://mcp.supermemory.ai',path:'/mcp',bound:0.001,basis:'conservative one operations allowance for protocol request'};
  if((body.method==='resources/read'&&['supermemory://profile','supermemory://spaces'].includes(body.params?.uri))||(body.method==='prompts/get'&&body.params?.name==='context'))return {origin:'https://mcp.supermemory.ai',path:'/mcp',bound:0.001,basis:'scoped native profile/context read allowance'};
  if(body.method!=='tools/call')fail('unknown MCP method');
  const name=body.params?.name,args=body.params?.arguments??{};scope(args,route.namespace);
  if(['add_memory','save-memory'].includes(name)){
   plain(args.content);if(args.url||args.file||args.fileUrl)fail('unbounded rich ingestion');
   return {origin:'https://mcp.supermemory.ai',path:'/mcp',bound:(bytes+1024)*0.00001+0.001,basis:'all UTF8 request bytes +1024 at rich upperSMrate $0.010/1K, no dedup discount; operation allowance'};
  }
  if(['search_memory','getDocument','whoAmI','listDocuments','listMemories','listSpaces','memory-graph','fetch-graph-data'].includes(name))return {origin:'https://mcp.supermemory.ai',path:'/mcp',bound:0.001,basis:'ten operations and 200 searches worth of public rate allowance per native read'};
  fail('unpriced Supermemory MCP tool');
 }
 scope(body,route.namespace);
 if(method==='POST'&&['/v3/documents','/v4/memories'].includes(pathname)){
  plain(body.content);if(body.url||body.file||body.fileUrl||body.documents)fail('only inline plain text ingestion');
  return {origin:'https://api.supermemory.ai',path:pathname,bound:(bytes+1024)*0.00001+0.001,basis:'all UTF8 request bytes+1024 at highest published richSMrate; operation allowance, dedup ignored'};
 }
 if((method==='POST'&&['/v4/search','/v3/search','/v4/profile','/v3/documents/list'].includes(pathname))||(method==='GET'&&/^\/v3\/documents\/[A-Za-z0-9_:-]+(?:\/file-url|\/chunks)?$/.test(pathname)))return {origin:'https://api.supermemory.ai',path:pathname,bound:0.001,basis:'conservative native read allowance above public per-search/per-operation rates'};
 fail('Supermemory route has no bounded price');
}
function credential(route){
 if(route.environment_key){const key=process.env[route.environment_key];if(!key)fail('controller environment credential missing');return key;}
 if(route.key_file){const d=read(route.key_file);if(typeof d[route.key_field??'key']!=='string')fail('private key field absent');return d[route.key_field??'key'];}
 const raw=fs.readFileSync(route.env_file,'utf8');const key=route.env_name??'OPENAI_API_KEY';
 const match=raw.match(new RegExp('(?:^|\\n)(?:export\\s+)?'+key+'\\s*=\\s*([^\\n]+)'));if(!match)fail('private credential absent');return match[1].trim().replace(/^(['"])(.*)\1$/,'$2');
}
export async function startProxy(cfg,{request=fetch}={}){
 if(!fs.existsSync(cfg.budget_file))fail('shared budget must exist before proxy startup');
 const routes=new Map(cfg.routes.map(r=>[r.token,r]));if(routes.size!==cfg.routes.length||[...routes.keys()].some(t=>typeof t!=='string'||t.length<24))fail('unique high-entropy sequence tokens required');
 const events=event=>fs.appendFileSync(cfg.trace_file,JSON.stringify({at:new Date().toISOString(),...event})+'\n',{mode:0o600});
 const server=http.createServer(async(req,res)=>{
  let receipt,subreceipt,subfile;try{
   const auth=String(req.headers.authorization??req.headers['x-api-key']??'');const route=routes.get(auth.replace(/^Bearer\s+/i,''));if(!route){res.writeHead(401);res.end('proxy authentication required');return;}
   const url=new URL(req.url,'http://localhost');if(url.search)fail('unclassified query parameters');
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>(url.pathname==='/controller/supermemory/file'?90:2)*1024*1024)fail('request size exceeds bound');}
   const body=raw?JSON.parse(raw):{};let appliedOutputCap=null;
   // A declared transport ceiling also covers upstream native gateway calls that omit max output.
   if(route.native_output_cap&&route.provider==='openai'&&['/v1/responses','/v1/chat/completions'].includes(url.pathname)){
    const key=url.pathname==='/v1/responses'?'max_output_tokens':'max_completion_tokens';const prior=body[key]??body.max_tokens;
    if(prior===undefined||prior>route.native_output_cap){body[key]=route.native_output_cap;delete body.max_tokens;appliedOutputCap=route.native_output_cap;raw=JSON.stringify(body);}
   }
   if(url.pathname.startsWith('/controller/supermemory/file')){
    const answer=await fileRequest(route,req.method,url.pathname,body,{budgetFile:cfg.budget_file,credential:()=>credential(route),request,events});
    res.writeHead(answer.status,{'content-type':'application/json'});res.end(answer.body);return;
   }
   const spec=classifyRequest(route,req.method,url.pathname,body);
   if(route.sub_budget_file){subfile=route.sub_budget_file;subreceipt=reserve(subfile,`${route.provider}.http.${url.pathname}`,spec.bound,spec.basis,{sequence:route.sequence,canonical_budget:cfg.budget_file});}
   receipt=reserve(cfg.budget_file,`${route.provider}.http.${url.pathname}`,spec.bound,spec.basis,{sequence:route.sequence,request_sha256:hash(raw)});
   const headers={'content-type':'application/json',accept:req.headers.accept??'application/json',...(route.provider==='anthropic'?{'x-api-key':credential(route),'anthropic-version':'2023-06-01'}:{authorization:`Bearer ${credential(route)}`})};
   for(const name of ['mcp-session-id','mcp-protocol-version'])if(req.headers[name])headers[name]=req.headers[name];
   const upstream=await request(spec.origin+spec.path,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:raw,redirect:'error',signal:AbortSignal.timeout(125000)});
   const output=await upstream.text();let usage=null;
   if(['openai','anthropic'].includes(route.provider)&&upstream.ok){try{usage=JSON.parse(output).usage;}catch{}
    if(usage&&spec.rate){const input=usage.input_tokens??usage.prompt_tokens??usage.total_tokens,completion=usage.output_tokens??usage.completion_tokens??0;
     if(Number.isFinite(input)&&Number.isFinite(completion)){const amount=(input*spec.rate.input+completion*spec.rate.output+(route.provider==='anthropic'?(usage.cache_creation_input_tokens??0)*2+(usage.cache_read_input_tokens??0)*0.1:0))/1e6,evidence=JSON.stringify({usage,request_id:upstream.headers.get('x-request-id')});reconcile(cfg.budget_file,receipt.id,amount,evidence);if(subreceipt)reconcile(subfile,subreceipt.id,amount,evidence);}}
   }
   // Unknown/failed provider charges keep their reservation; no speculative refund.
   events({provider:route.provider,sequence:route.sequence,path:url.pathname,status:upstream.status,reservation:receipt.id,bound_usd:spec.bound,applied_output_cap:appliedOutputCap,usage,request_sha256:hash(raw),response_sha256:hash(output)});
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
