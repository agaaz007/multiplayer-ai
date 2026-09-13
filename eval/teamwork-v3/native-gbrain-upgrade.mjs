#!/usr/bin/env node
/** Owned-db administrative prerequisites plus upstream native migrations; preserves setup history. */
import fs from'node:fs';import path from'node:path';import pg from'pg';import{execFileSync}from'node:child_process';import{fileURLToPath}from'node:url';
export async function prepareNativePostgresPrereqs(cfg,state){
if(!/^gbrain_native_v3_[a-f0-9]{24}$/.test(state.database_name))throw Error('owned database name required');
const url=new URL(state.admin_url);url.pathname='/'+state.database_name;const client=new pg.Client({connectionString:url.toString()});await client.connect();
try{const row=(await client.query("select shobj_description(oid, 'pg_database') as nonce from pg_database where datname=$1",[state.database_name])).rows[0];if(row?.nonce!==state.database_nonce)throw Error('ownership nonce mismatch');
const source=fs.readFileSync(path.join(path.dirname(cfg.gbrain_storage_module),'migrate.ts'),'utf8');const start=source.indexOf('DO $v35$'),end=source.indexOf('END $v35$;',start);if(start<0||end<0)throw Error('pinned native v35 SQL not found');await client.query(source.slice(start,end+'END $v35$;'.length));if(state.database_role!==state.database_name+'_role')throw Error('owned role mismatch');await client.query(`alter function public.auto_enable_rls() owner to "${state.database_role}"`);
}finally{await client.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const cfg=JSON.parse(fs.readFileSync(process.argv[2])),state=JSON.parse(fs.readFileSync(path.join(cfg.root,'native-state.json')));await prepareNativePostgresPrereqs(cfg,state);
const home=path.join(cfg.root,'gbrain-home');const result=execFileSync(cfg.gbrain_binary,['init','--migrate-only','--non-interactive','--skip-embed-check','--json'],{env:{PATH:process.env.PATH,HOME:home,TMPDIR:home,...cfg.provider_env},encoding:'utf8',timeout:120000,maxBuffer:8<<20});process.stdout.write(result);

}
