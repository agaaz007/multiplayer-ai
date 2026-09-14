/** Controller HTTP boundary around the unchanged official Mem0 Codex plugin. */
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {reserve} from './budget-gate.mjs';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
export function scopedRequest(method,url,body,namespace,events){
 if(method==='GET'&&/^\/v1\/event\/[A-Za-z0-9_-]+\/$/.test(url)){
  if(!events.has(url.split('/')[3]))throw new Error('foreign event');return null;
 }
 if(method!=='POST'||!['/v3/memories/add/','/v3/memories/search/'].includes(url))throw new Error('endpoint denied');
 if(body.app_id!==namespace)throw new Error('foreign app scope');
 if(url.includes('/add/')){
  if(!body.user_id?.startsWith(namespace+'-')||!body.agent_id?.startsWith(namespace+'-'))throw new Error('foreign write scope');
  if(body.infer!==true||!Array.isArray(body.messages))throw new Error('native extraction required');
 }else{
  if(!body.filters||!Number.isInteger(body.top_k)||body.top_k<1||body.top_k>20)throw new Error('invalid native search');
  // An enforced outer conjunction prevents OR/NOT or arbitrary entity filters escaping this sequence.
  body={...body,filters:{AND:[{app_id:namespace},body.filters]}};
 }
 return body;
}
export async function start(cfg){
 if(cfg.evaluation_account!==true)throw new Error('Only fresh unclaimed no-billing evaluation account supported');
 if(!Number.isInteger(cfg.max_calls)||cfg.max_calls<1||cfg.max_calls>300)throw new Error('At most 300 requests per owned sequence');
 const privateAccount=read(cfg.account_file),key=privateAccount.api_key;
 if(!key)throw new Error('missing controller key');
 const events=new Set(),token=crypto.randomBytes(24).toString('hex');let calls=0;
 const trace=o=>fs.appendFileSync(cfg.trace_file,JSON.stringify({at:new Date().toISOString(),...o})+'\n',{mode:0o600});
 const server=http.createServer(async(req,res)=>{
  const finish=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  try{
   if(req.headers.authorization!==`Token ${token}`)throw new Error('proxy credential denied');
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>250000)throw new Error('request too large');chunks.push(chunk);}
   const original=size?JSON.parse(Buffer.concat(chunks)):null;
   const body=scopedRequest(req.method,req.url,original,cfg.namespace,events);
   if(++calls>cfg.max_calls)throw new Error('evaluation request ceiling reached');
   const receipt=reserve(cfg.budget_file,'mem0.http',0,'Fresh unclaimed evaluation account; no payment method or paid plan enrolled; bounded request quota', {arm:'mem0',namespace:cfg.namespace,path:req.url});
   const response=await fetch('https://api.mem0.ai'+req.url,{method:req.method,headers:{Authorization:`Token ${key}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});
   const data=await response.json();if(data.event_id)events.add(data.event_id);
   trace({operation:req.url,status:response.status,budget_id:receipt.id,request_bytes:size,response:data});finish(response.status,data);
  }catch(e){trace({operation:req.url,denied:true,error:e.message});finish(403,{error:e.message});}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const info={url:`http://127.0.0.1:${server.address().port}`,token,pid:process.pid,namespace:cfg.namespace};
 fs.writeFileSync(cfg.ready_file,JSON.stringify(info,null,2)+'\n',{mode:0o600,flag:'wx'});
 return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await start(read(process.argv[2]));
