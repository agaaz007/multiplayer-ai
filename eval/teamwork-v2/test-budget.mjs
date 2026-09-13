import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';
import {initialize,reserve,permitNativeCall,committed} from './budget-gate.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'tw-budget-'));
try{
 const file=path.join(root,'budget.json');initialize(file,3,'test only');
 const script=path.resolve('eval/teamwork-v2/budget-gate.mjs');
 const results=await Promise.all(Array.from({length:8},()=>new Promise(resolve=>{
   const child=spawn(process.execPath,[script,'reserve',file,'test','1','known fixture cost'],{stdio:'ignore'});child.on('exit',resolve);
 })));
 assert.equal(results.filter(x=>x===0).length,3);assert.equal(committed(JSON.parse(fs.readFileSync(file))),3);
 assert.throws(()=>reserve(file,'bad',NaN,'bad'),/upper bound/);
 assert.match(permitNativeCall({method:'tools/call',params:{name:'unclassified'}},{server:'memory',profile:{}}),/Unclassified/);
 console.log('budget: atomic parallel reservations enforce shared cap; unknown operations and invalid bounds denied');
}finally{fs.rmSync(root,{recursive:true,force:true});}
