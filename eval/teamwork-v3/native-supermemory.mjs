/** Native API transport and verbatim ingestion; no controller-authored semantic memory. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath}from'node:url';
import {McpServer}from'@modelcontextprotocol/sdk/server/mcp.js';import{StdioServerTransport}from'@modelcontextprotocol/sdk/server/stdio.js';import{z}from'zod';
import{contained,inventory,hash,restore,readRange}from'./native-files.mjs';
export function searchOptions(a){if(a.aggregate&&a.rerank)throw Error('Supermemory search cannot combine aggregate and rerank; choose one');return a;}
export function nativeSupermemory(cfg,{request=fetch}={}){
 const base=cfg.provider_env?.SUPERMEMORY_API_URL,token=cfg.provider_env?.SUPERMEMORY_CODEX_API_KEY;
 if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base??'')||!token||!cfg.namespace)throw Error('scoped controller proxy required');
 async function api(url,body,method=body===undefined?'GET':'POST'){
  const r=await request(base+url,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(130000)});
  if(!r.ok)throw Error('native Supermemory HTTP '+r.status);return r.json();
 }
 const id=s=>{if(!/^[A-Za-z0-9_-]+$/.test(s))throw Error('native document ID required');return s;};
 async function upload(relative,stage='manual',root=cfg.workspace){
  const data=fs.readFileSync(contained(root,relative));
  const result=await api('/controller/supermemory/file',{containerTag:cfg.namespace,filename:path.basename(relative),path:relative,stage,sha256:hash(data),content_base64:data.toString('base64'),customId:'file-'+hash(Buffer.from(stage+'\0'+relative+'\0'+hash(data)))});
  return {...result,path:relative,sha256:hash(data),bytes:data.length};
 }
 async function bytes(document_id){const d=await api('/controller/supermemory/file/'+id(document_id));const b=Buffer.from(d.content,'base64');if(hash(b)!==d.sha256||b.length!==d.bytes)throw Error('native download digest mismatch');return b;}
 return {api,upload,bytes,
  async capture(stage){
   const files=[];for(const item of inventory(cfg.workspace,cfg.artifact_limits).files){
    try{const data=fs.readFileSync(contained(cfg.workspace,item.path));new TextDecoder('utf-8',{fatal:true}).decode(data);if(data.includes(0))throw Error('binary');}catch{files.push({...item,status:'unsupported_binary',source_kind:'workspace'});continue;}
    files.push({...await upload(item.path,stage),source_kind:'workspace'});
   }
   if(cfg.transcript_root&&fs.existsSync(cfg.transcript_root))for(const item of inventory(cfg.transcript_root,cfg.artifact_limits).files){
    // Native hooks retain conversation memory; exact original transcripts use ordinary native file storage.
    files.push({...await upload(item.path,stage,cfg.transcript_root),source_kind:'original_transcript'});
   }
   const manifest={stage,files};const saved=await api('/v3/documents',{containerTag:cfg.namespace,customId:'stage-'+stage.toLowerCase()+'-artifact-manifest',content:JSON.stringify(manifest),metadata:{stage,kind:'original-artifact-index'}});
   return {manifest:saved,files,semantic_handoff:'none; path/hash/native IDs only'};
  }
 };
}
export async function serve(cfg){
 const native=nativeSupermemory(cfg),server=new McpServer({name:'supermemory-native-workflow',version:'3.0.0'});
 const tool=(name,description,inputSchema,fn)=>server.registerTool(name,{description,inputSchema},async a=>{try{return{content:[{type:'text',text:JSON.stringify(await fn(a))}]};}catch(e){return{isError:true,content:[{type:'text',text:e.message}]};}});
 tool('supermemory_capture_workspace','Upload original text workspace files and a native path/hash index. No semantic controller summary.',{stage:z.string().regex(/^[A-Za-z0-9-]+$/)},a=>native.capture(a.stage));
 tool('supermemory_upload_file','Preserve exact original UTF8 file bytes using native file upload.',{path:z.string(),stage:z.string().default('manual')},a=>native.upload(a.path,a.stage));
 tool('supermemory_read_file','Read exact original native file bytes, with full-file hash.',{document_id:z.string(),offset:z.number().int().min(0).default(0),length:z.number().int().min(1).max(524288).default(65536)},async a=>readRange(await native.bytes(a.document_id),a.offset,a.length));
 tool('supermemory_restore_file','Restore native original bytes into this current workspace, requiring hash and explicit overwrite.',{document_id:z.string(),destination:z.string(),sha256:z.string(),overwrite:z.boolean().default(false)},async a=>restore(cfg.workspace,a.destination,await native.bytes(a.document_id),a));
 tool('supermemory_search','Native hybrid search with query rewriting, reranking, aggregation and related memory context.',{q:z.string().max(4000),rerank:z.boolean().default(true),aggregate:z.boolean().default(false),rewriteQuery:z.boolean().default(true),searchMode:z.enum(['hybrid','memories','documents']).default('hybrid')},a=>native.api('/v4/search',{...searchOptions(a),containerTag:cfg.namespace,limit:20}));
 tool('supermemory_profile','Native project profile and query-conditioned profile search.',{q:z.string().max(4000).optional()},a=>native.api('/v4/profile',{...a,containerTag:cfg.namespace}));
 tool('supermemory_get_document','Read complete native document content and metadata, not search snippets.',{id:z.string().regex(/^[A-Za-z0-9_:-]+$/)},a=>native.api('/v3/documents/'+encodeURIComponent(a.id)));
 tool('supermemory_list_documents','List native project documents and their processing status.',{page:z.number().int().min(1).max(100).default(1)},a=>native.api('/v3/documents/list',{...a,containerTag:cfg.namespace,limit:100}));
 tool('supermemory_save_document','Save substantive current work or correction through native memory extraction.',{content:z.string().max(100000),customId:z.string().regex(/^[A-Za-z0-9_:-]{1,100}$/).optional()},a=>native.api('/v3/documents',{...a,containerTag:cfg.namespace}));
 await server.connect(new StdioServerTransport());
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await serve(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));
