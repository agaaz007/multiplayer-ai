#!/usr/bin/env node
/** Own the whole lifecycle of a local, disposable Postgres; never load Ledger config. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import pg from "pg";

const args = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-isolated-"));
const marker = `ledger_selftest_${crypto.randomBytes(8).toString("hex")}`;
const data = path.join(temp, "pgdata");
const bin = process.env.LEDGER_TEST_PG_BIN;
const executable = name => bin ? path.join(bin, name) : name;
let started = false;
const run = (cmd, argv, env = process.env, quiet = false) => new Promise((resolve, reject) => {
  const child = spawn(cmd, argv, { cwd: root, env, stdio: quiet ? "pipe" : "inherit" });
  let errors = "";
  if (quiet) { child.stdout.on("data", () => {}); child.stderr.on("data", x => { errors += x.toString().slice(0, 4000); }); }
  child.on("error", reject);
  child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} failed (${signal ?? code})${quiet ? `: ${errors}` : ""}`)));
});
const cleanup = () => {
  if (started) spawnSync(executable("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "ignore", timeout: 15_000 });
  started = false;
  fs.rmSync(temp, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { cleanup(); process.exit(130); });
try {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const p = server.address().port; server.close(() => resolve(p)); });
  });
  await run(executable("initdb"), ["-D", data, "-A", "trust", "--no-locale", "-E", "UTF8"], process.env, true);
  await run(executable("pg_ctl"), ["-D", data, "-l", path.join(temp, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${temp}`, "-w", "start"], process.env, true);
  started = true;
  const connectionString = `postgresql://${encodeURIComponent(os.userInfo().username)}@127.0.0.1:${port}/${marker}?sslmode=disable`;
  const admin = new pg.Client({ connectionString: connectionString.replace(`/${marker}?`, "/postgres?") });
  await admin.connect();
  await admin.query(`create database ${marker}`); // marker is generated lowercase hex, never user input
  await admin.end();
  const client = new pg.Client({ connectionString }); await client.connect();
  await client.query("create table ledger_selftest_identity(singleton boolean primary key default true check(singleton), marker text not null)");
  await client.query("insert into ledger_selftest_identity(marker) values($1)", [marker]);
  await client.end();
  const env = { ...process.env, LEDGER_SELFTEST: "1", LEDGER_CLASSIFY: "0", LEDGER_SELFTEST_DB_MARKER: marker, LEDGER_SELFTEST_DB_PORT: String(port), LEDGER_CONFIG_DIR: path.join(temp, "config"), LEDGER_CONTINUITY_DB: connectionString, LEDGER_TEST_DATABASE_URL: connectionString, LEDGER_GIT_SYNC: "0", LEDGER_TRAFFIC_CLASS: "evaluation" };
  delete env.LEDGER_DIR; delete env.LEDGER_AUTHOR;
  fs.mkdirSync(env.LEDGER_CONFIG_DIR);
  const manifest = path.join(temp, "environment.json");
  fs.writeFileSync(manifest, JSON.stringify(Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("LEDGER_"))), null, 2), { mode: 0o600 });
  console.log(`Isolated selftest database ready; environment: ${manifest}`);
  if (args.includes("--server")) {
    // Development-only: agents may run serial suites with the printed, local-only environment.
    await new Promise(() => { setInterval(() => {}, 60_000); });
  }
  if (!args.includes("--no-build")) await run("npm", ["run", "build"], env);
  const selected = args.filter(x => !x.startsWith("--"));
  const suites = selected.length ? selected : ["selftest", "selftest-helper-safety", "selftest-events", "selftest-authority", "selftest-capture", "selftest-capture-boundary", "selftest-investigation", "selftest-claims", "selftest-graph", "selftest-findings", "eval/analytical-selftest", "eval/analytical-competitors-selftest", "selftest-continuity", "selftest-records", "selftest-resume", "selftest-classify", "selftest-recordpack", "selftest-embeddings", "selftest-availability", "selftest-binding-usage", "selftest-production", "selftest-capture-durability", "selftest-snapshot-worker", "selftest-capture-store", "selftest-resume-verification", "selftest-restore"];
  const databaseSuites = new Set(["selftest-continuity", "selftest-records", "selftest-resume", "selftest-classify", "selftest-recordpack", "selftest-embeddings", "selftest-binding-usage", "selftest-production", "selftest-restore", "selftest-resume-verification", "selftest-capture-store", "eval/selftest-eval-conditions"]);
  for (const suite of suites) {
    if (!/^(?:eval\/)?[a-z0-9-]+$/.test(suite)) throw new Error("Invalid selftest suite name");
    console.log(`\nRunning ${suite}`);
    const suiteEnv = {...env};
    // Pure MCP suites intentionally exercise an installation with no continuity DB.
    if (!databaseSuites.has(suite)) { delete suiteEnv.LEDGER_CONTINUITY_DB; delete suiteEnv.LEDGER_TEST_DATABASE_URL; }
    await run(process.execPath, [path.join(root, "dist", `${suite}.js`)], suiteEnv);
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally { cleanup(); }
