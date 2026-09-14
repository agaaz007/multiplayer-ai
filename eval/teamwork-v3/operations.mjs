#!/usr/bin/env node
/** Synthetic external supplier. Store is controller-owned, independent of memory. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

export function operate(cfg,kind,key,payload){
  if(!/^[a-zA-Z0-9_.:-]{8,150}$/.test(key))throw new Error('key must be an opaque stable identifier');
  fs.mkdirSync(cfg.root,{recursive:true,mode:0o700});
  const file=path.join(cfg.root,'events.jsonl');
  const events=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  function append(event){const e={seq:events.length+1,at:new Date().toISOString(),stage:cfg.stage,...event};fs.appendFileSync(file,JSON.stringify(e)+'\n',{mode:0o600});events.push(e);return e;}
  if(kind==='submit'){
    append({kind:'submit',key,payload});
    const receipt_id='receipt-'+crypto.randomUUID();append({kind:'effect',key,receipt_id,payload});
    if(cfg.interrupt_file&&!fs.existsSync(cfg.interrupt_file)){
      const pending=cfg.interrupt_file+'.tmp';
      fs.writeFileSync(pending,JSON.stringify({schema:'teamwork-interruption-trigger/v3',key,stage:cfg.stage,event_seq:events.length,at:new Date().toISOString(),cause:'supplier effect committed; acknowledgement withheld'}),{mode:0o600,flag:'wx'});
      fs.renameSync(pending,cfg.interrupt_file);
    }
    return {isError:true,content:[{type:'text',text:JSON.stringify({status:'outcome_unknown',key,error:'Response lost after transport sent request. This does not establish whether the supplier committed. Use lookup_operation before any repeated submission.'})}]};
  }
  const receipt=events.find(e=>e.kind==='effect'&&e.key===key);
  append({kind:'lookup',key,status:receipt?'completed':'not_found',receipt_id:receipt?.receipt_id??null});
  return {content:[{type:'text',text:JSON.stringify(receipt?{status:'completed',key,receipt_id:receipt.receipt_id}:{status:'not_found',key})}]};
}
async function serve(file){
  const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
  const server=new McpServer({name:'synthetic-external-operations',version:'3.0.0'});
  server.registerTool('submit_operation',{description:'Send an authorized synthetic supplier request. This supplier does NOT deduplicate repeated requests: repeated submissions can cause repeated external effects. A timeout is an uncertain outcome; retain the key and reconcile through lookup. This fixture never contacts a real customer.',inputSchema:{key:z.string(),payload:z.string().min(1).max(10000)}},async({key,payload})=>{
    const result=operate(cfg,'submit',key,payload);
    // Keep the acknowledgement genuinely pending until the task process is killed.
    // Returning an error immediately would permit a fast task to exit before interruption.
    if(cfg.interrupt_file)return await new Promise(()=>{});
    return result;
  });
  server.registerTool('lookup_operation',{description:'Read the supplier receipt for a previously submitted stable key. Read-only reconciliation; never creates an external effect.',inputSchema:{key:z.string()}},async({key})=>operate(cfg,'lookup',key));
  await server.connect(new StdioServerTransport());
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await serve(process.argv[2]);
