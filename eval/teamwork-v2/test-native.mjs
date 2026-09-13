import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {config,provision,prepareStage} from './native-lifecycle.mjs';
const root=()=>fs.mkdtempSync(path.join(os.tmpdir(),'teamwork-native-test-'));
const write=(f,o)=>fs.writeFileSync(f,JSON.stringify(o));
test('native setup requires explicit fresh authorization',async()=>{
 const r=root();try{await assert.rejects(provision({root:r,arm:'fresh-agent'}),/authorization/);assert.equal(fs.existsSync(path.join(r,'ownership.json')),false);}finally{fs.rmSync(r,{recursive:true,force:true});}
});
test('control stages are isolated and never claim probes from bare booleans',async()=>{
 const r=root();try{
 const guide=path.join(r,'guide.md');fs.writeFileSync(guide,'No memory tools.');
 const c={root:r,arm:'fresh-agent',runtime:r,guide_file:guide,execution_authorized:true,version:'none',readiness_verified:true};const cf=path.join(r,'config.json');write(cf,c);
 await provision(c);for(const d of ['home','work','out'])fs.mkdirSync(path.join(r,d));
 const req={arm:'fresh-agent',stage:'A',native_config:cf,fresh_home:path.join(r,'home'),workspace:path.join(r,'work'),controller_output_dir:path.join(r,'out'),native_profile:path.join(r,'out','profile.json')};
 await prepareStage(req);const p=JSON.parse(fs.readFileSync(req.native_profile));assert.equal(p.readiness_verified,false);assert.deepEqual(p.mcp,{});
 await assert.rejects(prepareStage(req),/already prepared/);
 }finally{fs.rmSync(r,{recursive:true,force:true});}
});
test('native config rejects incomplete lifecycle requests',()=>{const r=root();try{const f=path.join(r,'config.json');write(f,{arm:'ledger'});assert.throws(()=>config(f),/missing root/);}finally{fs.rmSync(r,{recursive:true,force:true});}});
test('classify-on capture source does not disable classification or insert synthetic events',()=>{
 const s=fs.readFileSync(new URL('./native-ledger-capture.mjs',import.meta.url),'utf8');assert.match(s,/classifyWaitMs:115000/);assert.match(s,/cfg.continuity.classify!==true/);assert.doesNotMatch(s,/insert into cont_events|LEDGER_CLASSIFY.*0/);
});
