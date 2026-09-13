import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {classifyRequest,startProxy} from './native-http-proxy.mjs';
import {initialize,committed} from './budget-gate.mjs';
test('unknown or unbounded OpenAI requests never get a price',()=>{
 const r={provider:'openai'};
 for(const body of [{model:'other',input:'x'},{model:'text-embedding-3-large',input:[[1,2]]}])assert.throws(()=>classifyRequest(r,'POST','/v1/embeddings',body));
 assert.throws(()=>classifyRequest(r,'POST','/v1/chat/completions',{model:'gpt-4.1-mini',messages:[{content:'x'}]}),/output limit/);
 const b=classifyRequest(r,'POST','/v1/chat/completions',{model:'gpt-4.1-mini',messages:[{content:'x'}],max_tokens:100});assert.ok(b.bound>100*1.6/1e6);
});
test('SM namespaces, remote-content ingestion, and unknown calls fail closed',()=>{
 const r={provider:'supermemory',namespace:'owned'};
 assert.throws(()=>classifyRequest(r,'POST','/v4/memories',{content:'https://remote.example',containerTag:'owned'}),/plain text/);
 assert.throws(()=>classifyRequest(r,'POST','/v4/search',{q:'hi',containerTag:'foreign'}),/foreign/);
 assert.throws(()=>classifyRequest(r,'POST','/mcp',{method:'tools/call',params:{name:'import_all',arguments:{}}}),/unpriced/);
 assert.ok(classifyRequest(r,'POST','/v4/memories',{content:'hello',containerTag:'owned'}).bound>0);
});
test('network gate reserves before forwarding and rejects exhaustion without provider contact',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-http-test-')),budget=path.join(dir,'budget.json'),key=path.join(dir,'key.json');let calls=0,server;
 try{
  initialize(budget,0.0002,'test only');fs.writeFileSync(key,JSON.stringify({key:'private-test-key'}));
  const token='test-sequence-token-'.repeat(3),cfg={budget_file:budget,trace_file:path.join(dir,'trace.jsonl'),routes:[{provider:'openai',token,key_file:key,sequence:'smoke'}]};
  const started=await startProxy(cfg,{request:async(url,opts)=>{calls++;assert.equal(url,'https://api.openai.com/v1/embeddings');assert.equal(opts.headers.authorization,'Bearer private-test-key');return new Response(JSON.stringify({usage:{prompt_tokens:1,total_tokens:1}}),{status:200});}});server=started.server;
  const req=()=>fetch(`http://127.0.0.1:${started.port}/v1/embeddings`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({model:'text-embedding-3-large',input:'x'.repeat(2000)})});
  assert.equal((await req()).status,403);assert.equal(calls,0);assert.equal(committed(JSON.parse(fs.readFileSync(budget))),0);
 }finally{if(server)await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
test('per-request OpenAI usage reconciles known token charge',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-http-test-')),budget=path.join(dir,'budget.json'),key=path.join(dir,'key.json');let server;
 try{initialize(budget,1,'test only');fs.writeFileSync(key,JSON.stringify({key:'private-test-key'}));const token='positive-sequence-token-test';
 const started=await startProxy({budget_file:budget,trace_file:path.join(dir,'trace.jsonl'),routes:[{provider:'openai',token,key_file:key}]},{request:async()=>new Response(JSON.stringify({usage:{total_tokens:2}}))});server=started.server;
 const response=await fetch(`http://127.0.0.1:${started.port}/v1/embeddings`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify({model:'text-embedding-3-large',input:'hello'})});assert.equal(response.status,200);
 assert.equal(committed(JSON.parse(fs.readFileSync(budget))),2*0.13/1e6);
 }finally{if(server)await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
