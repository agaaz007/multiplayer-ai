#!/usr/bin/env node
// Separate process for every helper pass prevents global pool/home cross-sequence contamination.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const req=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const cfg=JSON.parse(fs.readFileSync(path.join(req.fresh_home,'.ledger','config.json'),'utf8'));
const state=JSON.parse(fs.readFileSync(path.join(req.native_root,'ledger-native-owner.json'),'utf8'));
if(cfg.continuity.database_url!==state.databaseUrl||cfg.continuity.classify!==true||!state.stages.some(s=>s.home===req.fresh_home&&s.worktree===req.workspace))throw new Error('isolated classifier-on Ledger configuration mismatch');
const base=pathToFileURL(req.runtime+path.sep),db=await import(new URL('continuity/db.js',base));
try{
 const {helperOnce}=await import(new URL('helper/daemon.js',base));const logs=[];
 const summary=await helperOnce(cfg,{roots:{codex:path.join(req.fresh_home,'.codex','sessions'),claude:path.join(req.fresh_home,'.ledger','unused-claude')},activeWindowMin:1440,quietEndMin:1440,push:true,classifyWaitMs:115000,log:s=>logs.push(s)});
 const pool=db.getPool(cfg);
 const sessions=(await pool.query('select s.*, (select count(*)::int from cont_events e where e.session_id=s.id) as event_count from cont_sessions s where s.transcript_path like $1',[req.fresh_home+'/%'])).rows;
 const snapshots=[];
 for(const session of sessions){
   if(fs.realpathSync(session.cwd)!==fs.realpathSync(req.workspace))throw new Error('capture escaped stage workspace');
   if(session.wip_ref&&session.wip_commit&&session.last_verified_snapshot_at){
     const commit=execFileSync('git',['ls-remote',state.remote,session.wip_ref],{cwd:req.workspace,encoding:'utf8'}).trim().split(/\s+/)[0];
     if(commit!==session.wip_commit)throw new Error('remote snapshot verification mismatch');
     snapshots.push({session_id:session.id,thread_id:session.thread_id,commit,ref:session.wip_ref,verified_at:session.last_verified_snapshot_at});
   }
 }
 // Actual proposals are evidence of a model result; zero proposals can still be a valid classification.
 const updates=(await pool.query("select id,record_id,status,created_by from cont_state_updates where session_id=any($1::text[])",[sessions.map(s=>s.id)])).rows;
 console.log(JSON.stringify({at:new Date().toISOString(),summary,logs,sessions:sessions.map(s=>({id:s.id,event_count:s.event_count,thread_id:s.thread_id})),snapshots,updates,classifier_enabled:true,classifier_failures:logs.filter(s=>/classify.*(failed|error|extractor cmd)/i.test(s)),captured:sessions.some(s=>s.event_count>0)}));
}finally{await db.closePools();}
// helperOnce's bounded wait leaves a timer alive after an early classifier completion.
// This dedicated pass has no remaining work once pools close; flush stdout then exit.
process.stdout.write('',()=>process.exit(0));
