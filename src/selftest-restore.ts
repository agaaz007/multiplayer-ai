import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { assertSafeSelftestDatabase, assertSelftestDatabaseMarker } from "./selftest-db-guard.js";
import { getPool, migrate, closePools } from "./continuity/db.js";
import { initLedger } from "./store.js";

const db = process.env.LEDGER_CONTINUITY_DB ?? "";
assertSafeSelftestDatabase(db);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-restore-"));
const url = new URL(db);
const target = `ledger_selftest_${randomBytes(8).toString("hex")}`;
const pool = getPool({author:"fixture",ledger_dir:path.join(tmp,"knowledge"),git_sync:false,continuity:{database_url:db,machine:"fixture"}});
const restoreUrl = new URL(url); restoreUrl.pathname = `/${target}`;
const restored = new pg.Client({connectionString:restoreUrl.toString()});
const binary = (name:string) => process.env.LEDGER_TEST_PG_BIN ? path.join(process.env.LEDGER_TEST_PG_BIN,name) : name;
let created = false, connected = false;
try {
  await assertSelftestDatabaseMarker(pool);
  await migrate(pool);
  const bytes=Buffer.from("synthetic retained query evidence for restore verification");
  const sha=createHash("sha256").update(bytes).digest("hex");
  await pool.query("insert into cont_artifacts(sha256,kind,byte_size,inline) values($1,'fixture',$2,$3) on conflict do nothing",[sha,bytes.length,bytes]);
  const tables=(await pool.query("select tablename from pg_tables where schemaname='public' and tablename like 'cont_%' order by tablename")).rows.map(r=>String(r.tablename));
  const counts=new Map<string,number>();
  for(const table of tables) {assert.match(table,/^cont_[a-z_]+$/);counts.set(table,Number((await pool.query(`select count(*) as n from ${table}`)).rows[0].n));}
  execFileSync(binary("pg_dump"),["--format=custom","--no-owner","--file",path.join(tmp,"fixture.dump"),"--dbname",db],{stdio:"pipe"});
  await pool.query(`create database ${target}`); created=true;
  execFileSync(binary("pg_restore"),["--no-owner","--exit-on-error","--dbname",restoreUrl.toString(),path.join(tmp,"fixture.dump")],{stdio:"pipe"});
  await restored.connect(); connected=true;
  for(const [table,n] of counts) assert.equal(Number((await restored.query(`select count(*) as n from ${table}`)).rows[0].n),n,table);
  const artifact=(await restored.query("select inline from cont_artifacts where sha256=$1",[sha])).rows[0];
  assert.deepEqual(artifact.inline,bytes);
  assert.equal(createHash("sha256").update(artifact.inline).digest("hex"),sha);

  const knowledge=path.join(tmp,"knowledge");
  process.env.LEDGER_CONFIG_DIR=path.join(tmp,"config");
  initLedger(knowledge,"fixture");
  const git=(cwd:string,...args:string[])=>execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"],env:{...process.env,GIT_AUTHOR_NAME:"fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}}).trim();
  fs.writeFileSync(path.join(knowledge,"restore-fixture.md"),"# Synthetic retained knowledge\nNo personal data.\n");
  git(knowledge,"add","restore-fixture.md"); git(knowledge,"commit","-m","restore fixture");
  const before=git(knowledge,"rev-parse","HEAD");
  git(tmp,"clone","--bare",knowledge,path.join(tmp,"backup.git"));
  git(tmp,"clone",path.join(tmp,"backup.git"),path.join(tmp,"restored-knowledge"));
  assert.equal(git(path.join(tmp,"restored-knowledge"),"rev-parse","HEAD"),before);
  assert.equal(fs.readFileSync(path.join(tmp,"restored-knowledge","restore-fixture.md"),"utf8"),fs.readFileSync(path.join(knowledge,"restore-fixture.md"),"utf8"));
  console.log(`restore selftest: ${tables.length} continuity tables, artifact bytes/hash, and Git commit/content survived isolated backup/restore; live recovery coverage remains unmeasured`);
} finally {
  if(connected) await restored.end();
  if(created) await pool.query(`drop database ${target}`).catch(()=>{});
  await closePools(); fs.rmSync(tmp,{recursive:true,force:true});
}
