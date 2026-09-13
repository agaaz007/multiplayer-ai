/** Temporary-file tests only: no Codex/model/provider process is launched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {deliver,recover,snapshotTree} from './session-driver.mjs';
import {operate} from './operations.mjs';
import {runSequenceCodex} from './harness-codex.mjs';

const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'teamwork-v3-driver-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workspace=path.join(root,'work'),output=path.join(root,'controller');
  fs.mkdirSync(workspace);fs.mkdirSync(output);
  fs.writeFileSync(path.join(workspace,'state.json'),'{"stage":"A","proposal":"unapproved"}\n');
  return {root,workspace,output,track:'pm',started:100,deadline:1000};
}

test('PM delivery freezes files and exact answer bytes',t=>{
  const cfg=fixture(t),receipt=deliver(cfg,{answer:'useful'},()=>150);
  assert.equal(receipt.schema,'teamwork-delivery/v3');
  assert.equal(receipt.elapsed_ms,50);
  assert.equal(receipt.tree.files['state.json'],hash(fs.readFileSync(path.join(cfg.workspace,'state.json'))));
  assert.equal(receipt.answer_file_sha256,hash(fs.readFileSync(path.join(cfg.output,'submission/answer.json'))));
  fs.writeFileSync(path.join(cfg.workspace,'state.json'),'changed later');
  assert.match(fs.readFileSync(path.join(cfg.output,'submission/tree/state.json'),'utf8'),/unapproved/);
  assert.throws(()=>deliver(cfg,{answer:'replacement'},()=>160),/already delivered/);
});

test('recovery checkpoint is independently immutable and precedes delivery',t=>{
  const cfg=fixture(t),evidence={sources:[{artifact_id:'state.json',sha256:hash(fs.readFileSync(path.join(cfg.workspace,'state.json')))}],native_sources:[]};
  const receipt=recover(cfg,evidence,()=>130);
  assert.equal(receipt.schema,'teamwork-recovery/v3');
  assert.equal(receipt.evidence_file_sha256,hash(fs.readFileSync(path.join(cfg.output,'recovery/evidence.json'))));
  fs.writeFileSync(path.join(cfg.workspace,'state.json'),'{"stage":"B"}\n');
  const delivery=deliver(cfg,{answer:'continued'},()=>170);
  assert.notEqual(receipt.tree.files['state.json'],delivery.tree.files['state.json']);
  assert.throws(()=>recover(cfg,evidence,()=>180),/already submitted/);
});

test('recovery cannot be submitted retroactively after useful answer',t=>{
  const cfg=fixture(t);deliver(cfg,{},()=>150);
  assert.throws(()=>recover(cfg,{},()=>160),/precede delivery/);
});

test('recovery receipt makes no claim to supply or validate originals',t=>{
  const cfg=fixture(t),receipt=recover(cfg,{missing:['predecessor unavailable']},()=>150);
  assert.match(receipt.verification,/snapshot only/);
  assert.deepEqual(Object.keys(receipt.tree.files),['state.json']);
});

test('late recovery snapshot is not accepted',t=>{
  const cfg=fixture(t);let n=0;
  assert.throws(()=>recover(cfg,{},()=>++n===1?150:1001),/missed deadline/);
  assert.equal(fs.existsSync(path.join(cfg.output,'recovery.json')),false);
  assert.equal(fs.existsSync(path.join(cfg.output,'.recovery-pending')),false);
});

test('late delivery snapshot is not accepted',t=>{
  const cfg=fixture(t);let n=0;
  assert.throws(()=>deliver(cfg,{},()=>++n===1?150:1001),/missed deadline/);
  assert.equal(fs.existsSync(path.join(cfg.output,'delivery.json')),false);
  assert.equal(fs.existsSync(path.join(cfg.output,'.delivery-pending')),false);
});

test('recovery does not follow a symlink into private producer files',t=>{
  const cfg=fixture(t),secret=path.join(cfg.root,'hidden');fs.writeFileSync(secret,'private');
  fs.symlinkSync(secret,path.join(cfg.workspace,'stolen'));
  assert.throws(()=>recover(cfg,{},()=>150),/symlink/);
  assert.equal(fs.existsSync(path.join(cfg.output,'recovery')),false);
});

test('snapshot retains binary original bytes and excludes harness state',t=>{
  const cfg=fixture(t);fs.mkdirSync(path.join(cfg.workspace,'.git'));fs.writeFileSync(path.join(cfg.workspace,'.git/config'),'private remote');
  const binary=Buffer.from([0,255,16,1,0]);fs.writeFileSync(path.join(cfg.workspace,'original.bin'),binary);
  const tree=snapshotTree(cfg.workspace,path.join(cfg.output,'snapshot'));
  assert.equal(tree.files['original.bin'],hash(binary));assert.equal(tree.files['.git/config'],undefined);
  assert.deepEqual(fs.readFileSync(path.join(cfg.output,'snapshot/original.bin')),binary);
});

test('supplier commits real local effect before interruption trigger and withholds receipt',t=>{
  const cfg=fixture(t),supplier={root:path.join(cfg.root,'supplier'),stage:'B',interrupt_file:path.join(cfg.output,'trigger.json')};
  const response=operate(supplier,'submit','opaque-key-012345','approved synthetic request');
  assert.equal(response.isError,true);assert.equal(JSON.parse(response.content[0].text).status,'outcome_unknown');
  const events=fs.readFileSync(path.join(supplier.root,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(x=>x.kind),['submit','effect']);
  const trigger=JSON.parse(fs.readFileSync(supplier.interrupt_file,'utf8'));
  assert.equal(trigger.event_seq,events[1].seq);assert.equal(trigger.key,events[1].key);
  assert.equal(response.content[0].text.includes(events[1].receipt_id),false);
  const lookup=operate({...supplier,stage:'C',interrupt_file:undefined},'lookup',trigger.key);
  assert.equal(JSON.parse(lookup.content[0].text).receipt_id,events[1].receipt_id);
  const after=fs.readFileSync(path.join(supplier.root,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(after.filter(x=>x.kind==='effect').length,1);
});

test('supplier records duplicate external effects rather than silently deduplicating',t=>{
  const cfg=fixture(t),supplier={root:path.join(cfg.root,'supplier'),stage:'C'};
  operate(supplier,'submit','opaque-key-012345','request');operate(supplier,'submit','opaque-key-012345','request');
  const events=fs.readFileSync(path.join(supplier.root,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(x=>x.kind==='effect').length,2);
  assert.notEqual(events[1].receipt_id,events[3].receipt_id);
});

test('supplier lookup for wrong key cannot create an effect',t=>{
  const cfg=fixture(t),supplier={root:path.join(cfg.root,'supplier'),stage:'C'};
  assert.equal(JSON.parse(operate(supplier,'lookup','unseen-key-1234').content[0].text).status,'not_found');
  assert.throws(()=>operate(supplier,'submit','../../private','request'),/opaque stable/);
  const events=fs.readFileSync(path.join(supplier.root,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(x=>x.kind),['lookup']);
});

test('real MCP transport holds lost acknowledgement and closes boundedly',async t=>{
  const cfg=fixture(t),supplier={root:path.join(cfg.root,'supplier'),stage:'B',interrupt_file:path.join(cfg.output,'trigger.json')};
  const configFile=path.join(cfg.output,'supplier.json');fs.writeFileSync(configFile,JSON.stringify(supplier));
  const runtime=process.env.TEAMWORK_TEST_RUNTIME??fileURLToPath(new URL('../../dist/',import.meta.url));
  const {nativeSequenceTransport}=await import(pathToFileURL(path.join(runtime,'eval/sequence-transport.js')).href);
  // Keep Unix socket below macOS sun_path limit independently of the fixture path.
  const socketDir=fs.mkdtempSync(path.join(os.tmpdir(),'v3s-')),socket=path.join(socketDir,'s');
  const trace=[];let transport,client;
  t.after(async()=>{client?.destroy();await transport?.close();fs.rmSync(socketDir,{recursive:true,force:true});});
  transport=await nativeSequenceTransport(socket,process.execPath,[fileURLToPath(new URL('./operations.mjs',import.meta.url)),configFile],
    {PATH:process.env.PATH,HOME:cfg.output},cfg.output,(direction,message)=>trace.push({direction,message}));
  client=net.createConnection(socket);client.on('error',()=>{});
  await new Promise(resolve=>client.once('connect',resolve));
  const received=[];let buffer='';client.on('data',chunk=>{buffer+=chunk;for(;;){const i=buffer.indexOf('\n');if(i<0)break;received.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1);}});
  const send=message=>client.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
  const waitFor=async(predicate,ms=3000)=>{const until=Date.now()+ms;while(!predicate()){assert.ok(Date.now()<until,'condition timed out');await new Promise(r=>setTimeout(r,20));}};
  send({id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'v3-controller-test',version:'1'}}});
  await waitFor(()=>received.some(m=>m.id===1&&m.result));
  send({method:'notifications/initialized'});
  send({id:2,method:'tools/call',params:{name:'submit_operation',arguments:{key:'request-key-12345',payload:'synthetic authorized ticket'}}});
  await waitFor(()=>fs.existsSync(supplier.interrupt_file));
  await new Promise(r=>setTimeout(r,350));
  assert.equal(received.some(m=>m.id===2),false,'lost acknowledgement must still be pending');
  const events=fs.readFileSync(path.join(supplier.root,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e=>e.kind==='effect').length,1);
  const start=Date.now();await transport.close();
  assert.ok(Date.now()-start<2000,'pending MCP call blocked transport shutdown');
  await waitFor(()=>trace.some(x=>x.direction==='native-exit'),1000);
  transport=null;
});

test('harness forwards explicit denies and compact config; interruption uses owned pid',async t=>{
  const cfg=fixture(t),runtime=path.join(cfg.root,'runtime'),home=path.join(cfg.root,'home');
  fs.mkdirSync(path.join(runtime,'eval'),{recursive:true});fs.mkdirSync(home);
  fs.writeFileSync(path.join(runtime,'package.json'),'{"type":"module"}');
  fs.writeFileSync(path.join(runtime,'eval/sequence-isolation.js'),`export const sequenceSeatbelt=(r,w,d,o)=>JSON.stringify({r,w,d,o});export const verifySequenceSeatbelt=()=>({testStub:true});`);
  // Only these test doubles run. They never spawn Codex, touch credentials or kill a process.
  fs.writeFileSync(path.join(runtime,'eval/harness.js'),`export const killGroup=(pid)=>pid===81234567;export const readCodexJsonStream=()=>({turns:[],errors:[]});export async function spawnHarness(o){o.log('spawn fake pid=81234567 cwd=test');await new Promise(r=>setTimeout(r,1250));return {pid:81234567,stdout:'',stderr:'',exitCode:null,signal:'SIGKILL',timedOut:false};}`);
  const trigger=path.join(cfg.output,'trigger.json');fs.writeFileSync(trigger,'{"event_seq":2,"key":"opaque-key"}');
  const authSource=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'auth.json');
  const read=fs.readFileSync,copy=fs.copyFileSync;
  // Intercept only the auth-source access so this test never reads/copies real auth.
  fs.readFileSync=function(file,...args){return String(file)===authSource?'{"auth_mode":"chatgpt","test_only":true}':read.call(this,file,...args);};
  fs.copyFileSync=function(from,to,...args){if(String(from)===authSource){fs.writeFileSync(to,'{"auth_mode":"chatgpt","test_only":true}');return;}return copy.call(this,from,to,...args);};
  let result;
  try{result=await runSequenceCodex({runtime,home,worktree:cfg.workspace,model:'gpt-5.6-sol',reasoningEffort:'medium',timeoutMs:5000,
    mcp:{},prompt:'test only',compactTokenLimit:12000,interruptFile:trigger,forbiddenCanaries:[cfg.output],forbiddenPaths:[path.join(cfg.root,'previous')],additionalReadPaths:[],additionalWritePaths:[]});}
  finally{fs.readFileSync=read;fs.copyFileSync=copy;}
  const config=fs.readFileSync(path.join(home,'.codex/config.toml'),'utf8');
  assert.match(config,/model_auto_compact_token_limit = 12000/);assert.match(config,/body_after_prefix/);
  assert.match(config,/model = "gpt-5.6-sol"/);
  assert.deepEqual(JSON.parse(result.policy).d,[cfg.output,path.join(cfg.root,'previous')]);
  assert.equal(result.interruption.pid,81234567);assert.equal(result.interruption.killed,true);
  assert.equal(result.interruption.trigger.event_seq,2);
});
