/** Controller file transport: unchanged bytes -> native upload -> native presigned download. */
import {reserve} from '../teamwork-v2/budget-gate.mjs';
import crypto from 'node:crypto';
export const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
export const MAX_TEXT_FILE_BYTES=64*1024*1024;
export function uploadInput(body,namespace){
 if(body.containerTag!==namespace)throw Error('foreign or absent file namespace');
 if(typeof body.filename!=='string'||!body.filename||/[\/\\\x00-\x1f]/.test(body.filename)||body.filename.length>200)throw Error('plain filename required');
 if(typeof body.content_base64!=='string')throw Error('base64 file required');
 const data=Buffer.from(body.content_base64,'base64');
 if(data.toString('base64')!==body.content_base64||data.length>MAX_TEXT_FILE_BYTES)throw Error('invalid/oversized file');
 new TextDecoder('utf-8',{fatal:true}).decode(data);
 if(data.includes(0))throw Error('binary file unsupported by bounded text ingestion');
 if(sha(data)!==body.sha256)throw Error('file digest mismatch');
 return data;
}
export async function fileRequest(route,method,pathname,body,{budgetFile,credential,request=fetch,events=()=>{}}){
 const gated=(name,bound,basis)=>{
  if(route.sub_budget_file)reserve(route.sub_budget_file,name,bound,basis,{sequence:route.sequence,canonical_budget:budgetFile});
  return reserve(budgetFile,name,bound,basis,{sequence:route.sequence});
 };
 if(route.provider!=='supermemory')throw Error('Supermemory route required');
 if(method==='POST'&&pathname==='/controller/supermemory/file'){
  const data=uploadInput(body,route.namespace),bound=(data.length+8192)*.00001+.002;
  const r=gated('supermemory.native_file_upload',bound,'Exact UTF8 bytes +8192 at rich upper $0.010/1K; two operation allowance; no dedup discount');
  const form=new FormData();form.set('file',new Blob([data],{type:'text/plain'}),body.filename);form.set('fileType','text');form.set('containerTag',route.namespace);form.set('dreaming','instant');form.set('taskType','memory');
  form.set('metadata',JSON.stringify({path:body.path??body.filename,sha256:sha(data),bytes:data.length,stage:body.stage??'manual'}));
  if(body.customId){if(!/^[a-zA-Z0-9_:-]{1,100}$/.test(body.customId))throw Error('invalid customId');form.set('customId',body.customId);}
  const response=await request('https://api.supermemory.ai/v3/documents/file',{method:'POST',headers:{authorization:'Bearer '+credential()},body:form,redirect:'error',signal:AbortSignal.timeout(125000)});
  const text=await response.text();events({provider:'supermemory',sequence:route.sequence,path:'/v3/documents/file',reservation:r.id,bound_usd:bound,status:response.status,request_sha256:sha(data),response_sha256:sha(text)});
  return {status:response.status,body:text};
 }
 const m=pathname.match(/^\/controller\/supermemory\/file\/([A-Za-z0-9_-]+)$/);
 if(method!=='GET'||!m)throw Error('unsupported file transport');
 const r=gated('supermemory.native_file_download',.001,'Native presigned URL read plus download; no inference or ingestion');
 const response=await request('https://api.supermemory.ai/v3/documents/'+m[1]+'/file-url',{headers:{authorization:'Bearer '+credential()},redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!response.ok)return {status:response.status,body:await response.text()};
 const u=new URL((await response.json()).url);
 if(u.protocol!=='https:'||u.username||u.password||u.port||!(route.file_download_hosts??[]).includes(u.hostname))throw Error('presigned download host must be pinned by readiness');
 const download=await request(u,{redirect:'error',signal:AbortSignal.timeout(60000)});
 if(!download.ok)throw Error('native file download failed');
 const chunks=[];let length=0;
 for await(const chunk of download.body){length+=chunk.length;if(length>MAX_TEXT_FILE_BYTES)throw Error('native file download exceeds bound');chunks.push(chunk);}
 const data=Buffer.concat(chunks);events({provider:'supermemory',sequence:route.sequence,path:'/v3/documents/{id}/file-url+download',reservation:r.id,bound_usd:.001,status:200,response_sha256:sha(data)});
 return {status:200,body:JSON.stringify({document_id:m[1],sha256:sha(data),bytes:data.length,encoding:'base64',content:data.toString('base64')})};
}
