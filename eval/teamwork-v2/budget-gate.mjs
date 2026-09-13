/** Shared synchronous reservation ledger for parallel benchmark lanes.
 * A reservation bounds a declared operation, not a vendor invoice. Unknown price
 * bounds must not be configured as zero. All paid network paths must use a gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const file=fileURLToPath(import.meta.url);
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
function edit(filename,fn){
  const target=path.resolve(filename),lock=target+'.lock',deadline=Date.now()+5000;
  for(;;){try{fs.mkdirSync(lock,{mode:0o700});break;}catch(e){if(e.code!=='EEXIST')throw e;if(Date.now()>deadline)throw new Error('shared budget lock unavailable; refusing operation');sleep(20);}}
  try{const state=read(target);const result=fn(state);const temp=target+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(state,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,target);return result;}
  finally{fs.rmdirSync(lock);}
}
export const committed=state=>state.entries.reduce((sum,e)=>sum+(e.actual_usd??e.bound_usd),0);
export function initialize(filename,maximum,authorization){
  if(!Number.isFinite(maximum)||maximum<=0||!authorization)throw new Error('finite positive allowance and authorization required');
  fs.writeFileSync(filename,JSON.stringify({schema:'teamwork-budget/v2',maximum_usd:maximum,authorization,created_at:new Date().toISOString(),entries:[],blocked:null},null,2)+'\n',{mode:0o600,flag:'wx'});
}
export function reserve(filename,operation,bound,basis,metadata={}){
  if(!Number.isFinite(bound)||bound<0||!basis)throw new Error('operation needs a known nonnegative upper bound and basis');
  return edit(filename,state=>{
    if(state.schema!=='teamwork-budget/v2'||state.blocked)throw new Error('budget invalid or blocked');
    if(committed(state)+bound>state.maximum_usd+1e-9)throw new Error('whole-run allowance exhausted');
    const entry={id:crypto.randomUUID(),at:new Date().toISOString(),operation,bound_usd:bound,actual_usd:null,basis,...metadata};state.entries.push(entry);return entry;
  });
}
export function reconcile(filename,id,actual,evidence){
  if(!Number.isFinite(actual)||actual<0)throw new Error('invalid actual charge');
  return edit(filename,state=>{
    const entry=state.entries.find(e=>e.id===id);if(!entry)throw new Error('reservation not found');
    if(entry.actual_usd!==null)throw new Error('reservation already reconciled');
    entry.actual_usd=actual;entry.evidence=evidence;
    if(actual>entry.bound_usd||committed(state)>state.maximum_usd)state.blocked='Observed charge exceeded declared bound; reconcile configuration before further work';
    return entry;
  });
}
export function permitNativeCall(message,context){
  if(message.method!=='tools/call')return null;
  const tool=message.params?.name;const profile=context.profile;
  const spec=profile.operation_bounds?.[context.server]?.[tool];
  if(!spec)return `Unclassified native operation ${context.server}.${tool}; no budget bypass`;
  if(JSON.stringify(message.params?.arguments??{}).length>(spec.max_input_chars??20000))return 'Native operation exceeds frozen input bound';
  try{
    reserve(profile.budget_file,`${context.server}.${tool}`,spec.usd,spec.basis,
      {arm:context.arm,stage:context.stage,call_id:message.id??null});return null;
  }catch(error){return 'Budget gate: '+error.message;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===file){
  const [cmd,filename,...args]=process.argv.slice(2);
  try{
    let result;
    if(cmd==='init') {initialize(filename,Number(args[0]),args[1]);result={created:true};}
    else if(cmd==='reserve')result=reserve(filename,args[0],Number(args[1]),args[2],args[3]?JSON.parse(args[3]):{});
    else if(cmd==='reconcile')result=reconcile(filename,args[0],Number(args[1]),args[2]);
    else if(cmd==='status'){const state=read(filename);result={maximum_usd:state.maximum_usd,committed_usd:committed(state),remaining_usd:state.maximum_usd-committed(state),reservations:state.entries.length,blocked:state.blocked};}
    else throw new Error('usage: budget-gate.mjs init|reserve|reconcile|status FILE [arguments]');
    console.log(JSON.stringify(result));
  }catch(error){console.error(error.message);process.exitCode=2;}
}
