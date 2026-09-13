#!/usr/bin/env node
// Native Ledger extraction command: subscription Codex, no inherited agent memory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

const [configFile] = process.argv.slice(2);
const cfg=JSON.parse(fs.readFileSync(configFile,'utf8'));
if(cfg.subscription_authorized!==true||cfg.model!=='gpt-5.6-sol')throw new Error('explicit subscription classifier authorization and frozen model required');
const prompt=await new Promise(resolve=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>text+=s);process.stdin.on('end',()=>resolve(text));});
if(prompt.length>65000)throw new Error('classifier prompt exceeded native cap');
const dir=fs.mkdtempSync(path.join(cfg.output,'classifier-'));
const home=path.join(dir,'home');fs.mkdirSync(path.join(home,'.codex'),{recursive:true,mode:0o700});
// The controller's stage harness installs subscription auth. Copy only auth, not config/history.
const auth=path.join(cfg.stage_home,'.codex','auth.json');
if(!fs.existsSync(auth))throw new Error('isolated stage subscription auth unavailable');
const authData=JSON.parse(fs.readFileSync(auth,'utf8'));
if(authData.auth_mode!=='chatgpt'||!authData.tokens||authData.OPENAI_API_KEY)throw new Error('classifier requires subscription authentication; API-key billing is not permitted');
fs.copyFileSync(auth,path.join(home,'.codex','auth.json'));fs.chmodSync(path.join(home,'.codex','auth.json'),0o600);
const output=path.join(dir,'answer.txt'),start=Date.now();let stdout='',stderr='';
const child=spawn(cfg.binary??'codex',['exec','--ephemeral','--skip-git-repo-check','--json','-m',cfg.model,'-c','model_reasoning_effort="medium"','-s','read-only','-o',output,'-'],{
  cwd:home,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:path.join(home,'.codex'),LEDGER_HOOKS_OFF:'1',__CF_USER_TEXT_ENCODING:process.env.__CF_USER_TEXT_ENCODING,
   ...(fs.existsSync(path.join(cfg.stage_home,'public-ca.pem'))?{CODEX_CA_CERTIFICATE:path.join(cfg.stage_home,'public-ca.pem'),SSL_CERT_FILE:path.join(cfg.stage_home,'public-ca.pem'),NODE_EXTRA_CA_CERTS:path.join(cfg.stage_home,'public-ca.pem')}:{})},stdio:['pipe','pipe','pipe']});
child.stdin.end(prompt);child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
const timer=setTimeout(()=>child.kill('SIGKILL'),110000);
const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});clearTimeout(timer);
let usage=null;for(const line of stdout.split('\n')){try{const row=JSON.parse(line);if(row.type==='turn.completed')usage=row.usage;}catch{}}
fs.writeFileSync(path.join(dir,'receipt.json'),JSON.stringify({model:cfg.model,reasoning:'medium',billing:'subscription; monetary charge unknown',elapsed_ms:Date.now()-start,exit_code:code,usage,prompt_sha256:crypto.createHash('sha256').update(prompt).digest('hex')},null,2),{mode:0o600});
fs.writeFileSync(path.join(dir,'stream.jsonl'),stdout,{mode:0o600});
fs.rmSync(path.join(home,'.codex','auth.json'),{force:true});
if(code!==0||!fs.existsSync(output))throw new Error('subscription classifier failed; retained receipt records status');
process.stdout.write(fs.readFileSync(output));
