import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {deliver} from './session-driver.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'teamwork-delivery-'));
try {
  const workspace=path.join(root,'work');const output=path.join(root,'controller');fs.mkdirSync(workspace);fs.mkdirSync(output);
  fs.writeFileSync(path.join(workspace,'app.py'),'submitted version');
  const cfg={workspace,output,track:'engineering',started:100,deadline:200};
  const receipt=deliver(cfg,{conclusion:'ready'},()=>150);
  assert.equal(receipt.memory_write_required,false);assert.equal(receipt.elapsed_ms,50);
  assert.equal(receipt.answer_file_sha256,crypto.createHash('sha256').update(fs.readFileSync(path.join(output,'submission/answer.json'))).digest('hex'));
  fs.writeFileSync(path.join(workspace,'app.py'),'later handoff edit');
  assert.equal(fs.readFileSync(path.join(output,'submission/tree/app.py'),'utf8'),'submitted version');
  assert.throws(()=>deliver(cfg,{conclusion:'replace'},()=>160),/already delivered/);
  const late=path.join(root,'late');fs.mkdirSync(late);
  assert.throws(()=>deliver({...cfg,output:late},{},()=>201),/deadline/);
  assert.equal(fs.existsSync(path.join(late,'delivery.json')),false);
  const escaped=path.join(root,'escaped');fs.mkdirSync(escaped);fs.symlinkSync('/etc/hosts',path.join(workspace,'link'));
  assert.throws(()=>deliver({...cfg,output:escaped},{},()=>150),/symlink/);
  assert.equal(fs.existsSync(path.join(escaped,'delivery.json')),false);
  console.log('delivery: early answer without memory write, immutable code snapshot, duplicate/late delivery and symlink rejection passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
