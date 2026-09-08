import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Execution-continuity tests. Needs a Postgres: LEDGER_CONTINUITY_DB, default
 * postgresql://localhost:5432/ledger_selftest. Drops and recreates the cont_*
 * tables there. Runs the isolated end-to-end scenario from the spec:
 *
 *   rachit works in Codex on a repo → helper captures, snapshots, publishes →
 *   session dies (quiet) → agaaz resumes in a fresh clone, claims, checks out
 *   the exact snapshot → rachit's laptop wakes and keeps uploading → routed to
 *   a fork, rachit notified; head untouched.
 *
 * Plus the rules that guard it: distinct request/result event ids, claim CAS,
 * head-update rule after release, idempotent upload, tracked .env never in a
 * snapshot, unbound sessions still snapshotted, artifacts for long outputs.
 */

const DB = process.env.LEDGER_CONTINUITY_DB || "postgresql://localhost:5432/ledger_selftest";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-cont-"));
process.env.LEDGER_CONFIG_DIR = path.join(tmp, ".ledger"); // spool, state, bindings, signals live here
process.env.LEDGER_GIT_SYNC = "0";

const { getPool, migrate, closePools } = await import("./continuity/db.js");
const S = await import("./continuity/store.js");
const { streamTranscript } = await import("./continuity/events.js");
const { shadowCommit, checkoutWip, repoIdentity } = await import("./continuity/shadow.js");
const { buildResumePack } = await import("./continuity/resume.js");
const { helperOnce } = await import("./helper/daemon.js");
const { redactText, isDeniedPath } = await import("./continuity/redact.js");
const { takeLocalNotifications } = await import("./helper/signals.js");
const { initLedger } = await import("./store.js");
type Config = import("./store.js").Config;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
const cl = (o: unknown) => JSON.stringify(o);
const T = (min: number) => new Date(Date.UTC(2026, 8, 8, 2, min, 0));
let step = 0;
const ok = (msg: string) => console.log(`  ok ${++step}. ${msg}`);

// ---------- setup: ledger dir, two authors, fresh schema ----------
const ledgerDir = path.join(tmp, "ledger");
initLedger(ledgerDir, "test");
const base: Omit<Config, "author"> = { ledger_dir: ledgerDir, git_sync: false, continuity: { database_url: DB, machine: "test-mac" } };
const cfgR: Config = { ...base, author: "rachit", continuity: { ...base.continuity!, machine: "rachit-mac" } };
const cfgA: Config = { ...base, author: "agaaz", continuity: { ...base.continuity!, machine: "agaaz-mac" } };
const pool = getPool(cfgR);
await pool.query(`drop table if exists cont_state_updates, cont_record_links, cont_records, cont_notifications, cont_artifacts, cont_claims, cont_checkpoints, cont_events, cont_sessions, cont_threads cascade`);
await migrate(pool);
ok(`schema reset on ${DB.replace(/\/\/[^@]*@/, "//…@")}`);

// ---------- unit: redaction and deny list ----------
{
  const r = redactText("DATABASE_URL=postgresql://u:npg_AbCdEfGh123@host/db key sk-abcdefghijklmnopqrstuvwxyz0123 and ghp_" + "a".repeat(40));
  assert.ok(!r.text.includes("npg_AbCdEfGh123") && !r.text.includes("sk-abcdefghijklmnop") && !r.text.includes("ghp_aaaa"), r.text);
  assert.ok(r.hits >= 3);
  for (const p of [".env", "config/.env.local", "keys/id_rsa", "certs/x.pem", "ops/secrets/db.json"]) assert.ok(isDeniedPath(p), `denied: ${p}`);
  for (const p of ["src/app.ts", "environment.md", "README.md"]) assert.ok(!isDeniedPath(p), `allowed: ${p}`);
  ok("redaction masks Neon, OpenAI, GitHub tokens; deny list matches .env, keys, secrets dirs");
}

// ---------- unit: streaming emitter, distinct ids, incremental offsets ----------
{
  const f = path.join(tmp, "rollout-2026-09-08T02-00-00-aaaaaaaa-1111-2222-3333-444444444444.jsonl");
  const long = "x".repeat(5000);
  const lines = [
    cl({ timestamp: "2026-09-08T02:00:00Z", type: "session_meta", payload: { id: "aaaaaaaa-1111-2222-3333-444444444444", cwd: "/x" } }),
    cl({ timestamp: "2026-09-08T02:00:01Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "# AGENTS.md instructions for /x" }] } }),
    cl({ timestamp: "2026-09-08T02:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a banner" }] } }),
    cl({ timestamp: "2026-09-08T02:00:03Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input: 'await tools.exec_command({cmd:"psql -c \\"select 1\\""})' } }),
    cl({ timestamp: "2026-09-08T02:00:04Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: long }] } }),
    cl({ timestamp: "2026-09-08T02:00:05Z", type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c2", input: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch" } }),
  ];
  fs.writeFileSync(f, lines.slice(0, 3).join("\n") + "\n" + lines[3].slice(0, 20)); // partial trailing line
  const r1 = streamTranscript(f, 0, "codex");
  assert.equal(r1.events.filter((e) => e.kind === "instruction.added").length, 1, "developer role excluded, user prompt read once");
  assert.equal(r1.events.filter((e) => e.kind === "tool.requested").length, 0, "partial line not consumed");
  fs.writeFileSync(f, lines.join("\n") + "\n");
  const r2 = streamTranscript(f, r1.offset, "codex");
  const ids = r2.events.map((e) => e.producer_event_id);
  assert.ok(ids.includes("c1:requested") && ids.includes("c1:finished"), `request and result have distinct ids: ${ids.join(",")}`);
  assert.equal(r2.events.filter((e) => e.kind === "instruction.added").length, 0, "no duplicate prompt on incremental read");
  const fin = r2.events.find((e) => e.producer_event_id === "c1:finished")!;
  assert.ok(String(fin.payload.output_preview).length <= 1200 && typeof fin.payload._full === "string" && (fin.payload._full as string).length === 5000, "long output: preview + _full for artifact");
  assert.ok(r2.events.some((e) => e.kind === "file.changed" && e.payload.path === "src/app.ts"), "apply_patch yields file.changed");
  const r3 = streamTranscript(f, r2.offset, "codex");
  assert.equal(r3.events.length, 0, "nothing new → nothing emitted");
  ok("streaming emitter: incremental, partial-line safe, distinct request/result ids, artifacts staged");
}

// ---------- e2e fixture: bare remote + rachit's clone with a tracked .env ----------
const bare = path.join(tmp, "demo.git");
const repoR = path.join(tmp, "rachit", "demo");
git(tmp, "init", "--bare", "--quiet", "-b", "master", bare);
fs.mkdirSync(path.dirname(repoR), { recursive: true });
git(path.dirname(repoR), "clone", "--quiet", bare, "demo");
fs.mkdirSync(path.join(repoR, "src"), { recursive: true });
fs.writeFileSync(path.join(repoR, "README.md"), "# demo\n");
fs.writeFileSync(path.join(repoR, "src", "app.ts"), "export const banner = false;\n");
fs.writeFileSync(path.join(repoR, ".env"), "API_KEY=sk-live-supersecretvalue1234567890\n");
fs.writeFileSync(path.join(repoR, ".gitignore"), "node_modules/\n");
git(repoR, "add", "-A");
git(repoR, "commit", "--quiet", "-m", "init (tracks .env on purpose)");
git(repoR, "push", "--quiet", "origin", "master");
const baseSha = git(repoR, "rev-parse", "HEAD");
ok("fixture repo with bare remote; .env is TRACKED to prove the deny rule");

// ---------- unit: shadow commit excludes a tracked .env and validates the tree ----------
{
  fs.writeFileSync(path.join(repoR, "src", "app.ts"), "export const banner = true; // rachit\n");
  fs.writeFileSync(path.join(repoR, "src", "banner.css"), ".banner{color:red}\n"); // untracked
  fs.writeFileSync(path.join(repoR, ".env"), "API_KEY=sk-live-CHANGED\n"); // modified secret
  fs.unlinkSync(path.join(repoR, "README.md")); // deletion
  const sh = shadowCommit(repoR, { ref: "refs/wip/rachit/unit", push: true, now: T(0) });
  assert.ok(sh.ok && sh.commit && sh.verified, `shadow ok/verified: ${JSON.stringify(sh)}`);
  const tree = git(repoR, "ls-tree", "-r", "--name-only", sh.commit!).split("\n");
  assert.ok(!tree.includes(".env"), `tracked .env removed from snapshot tree: ${tree.join(",")}`);
  assert.ok(tree.includes("src/banner.css") && tree.includes("src/app.ts") && !tree.includes("README.md"), "untracked added, deletion captured");
  assert.ok(sh.files.some((f) => f.path === "src/banner.css" && f.status === "A"), "file list reports the addition");
  const remoteSha = git(repoR, "ls-remote", "origin", "refs/wip/rachit/unit").split(/\s+/)[0];
  assert.equal(remoteSha, sh.commit, "remote has the snapshot");
  const again = shadowCommit(repoR, { ref: "refs/wip/rachit/unit", parent: sh.commit, lastTree: sh.tree, push: true, now: T(1) });
  assert.equal(again.skipped, "unchanged", "no new commit when the tree is unchanged");
  ok("shadow commit: tracked .env excluded, tree validated, untracked+deletions captured, remote-verified, idempotent");
}

// ---------- e2e 1: rachit's Codex session is captured, bound, snapshotted, checkpointed ----------
const roots = { claude: path.join(tmp, "claude-empty"), codex: path.join(tmp, "codex") };
fs.mkdirSync(roots.claude, { recursive: true });
const day = path.join(roots.codex, "2026", "09", "08");
fs.mkdirSync(day, { recursive: true });
const sidR = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const tR = path.join(day, `rollout-2026-09-08T02-00-00-${sidR}.jsonl`);
const rLines = [
  cl({ timestamp: "2026-09-08T02:00:00Z", type: "session_meta", payload: { id: sidR, cwd: repoR, cli_version: "0.149.0" } }),
  cl({ timestamp: "2026-09-08T02:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a greeting banner to the app; keep the price unchanged." }] } }),
  cl({ timestamp: "2026-09-08T02:00:02Z", type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "p1", input: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-export const banner = false;\n+export const banner = true; // rachit\n*** End Patch" } }),
  cl({ timestamp: "2026-09-08T02:00:03Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "p1", output: "Success. Updated the following files:\nM src/app.ts" } }),
  cl({ timestamp: "2026-09-08T02:00:04Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "e1", input: 'await tools.exec_command({cmd:"npm test"})' } }),
  cl({ timestamp: "2026-09-08T02:00:05Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "e1", output: "1 failing: banner visible on small viewport\n" + "log line\n".repeat(400) } }),
  cl({ timestamp: "2026-09-08T02:00:06Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Banner added. Test fails on small viewport; next I will check the CTA at 360px." }] } }),
  cl({ timestamp: "2026-09-08T02:00:07Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "e2", input: 'await tools.exec_command({cmd:"npm run build"})' } }),
  // e2 never finishes: the session dies here
];
fs.writeFileSync(tR, rLines.join("\n") + "\n");
fs.utimesSync(tR, T(0), T(0));
let s1 = await helperOnce(cfgR, { roots, now: T(1), push: true, log: () => {} });
assert.equal(s1.errors.length, 0, `pass 1 errors: ${s1.errors.join(" | ")}`);
assert.equal(s1.sessions, 1);
assert.equal(s1.bound, 1, "auto-created + bound a thread from the first prompt");
assert.ok(s1.events_uploaded >= 7, `events uploaded: ${s1.events_uploaded}`);
assert.equal(s1.snapshots, 1, "one shadow commit");
assert.equal(s1.checkpoints, 1, "one snapshot checkpoint");
const threadsR = await S.listThreads(pool, { author: "rachit" });
assert.equal(threadsR.length, 1);
const thread = threadsR[0];
assert.ok(thread.title.startsWith("Add a greeting banner"), thread.title);
assert.equal(thread.generation, 1);
assert.ok(thread.head_checkpoint_id, "head advanced under rachit's own claim");
assert.equal(thread.claim?.holder_author, "rachit");
const sessR = (await S.getSession(pool, sidR))!;
assert.equal(sessR.repo, repoIdentity(repoR));
assert.ok(sessR.wip_commit && sessR.last_verified_snapshot_at, "session records verified snapshot");
const evCount = (await pool.query(`select kind, count(*)::int as n from cont_events where session_id = $1 group by kind order by kind`, [sidR])).rows;
const byKind = Object.fromEntries(evCount.map((r: any) => [r.kind, r.n]));
assert.equal(byKind["tool.requested"], 3);
assert.equal(byKind["tool.finished"], 2, "e2 has no result");
assert.equal(byKind["instruction.added"], 1);
assert.equal(byKind["file.changed"], 1);
const pend = await S.pendingOperations(pool, sidR);
assert.equal(pend.length, 1);
assert.equal(pend[0].call_id, "e2");
const art = (await pool.query(`select count(*)::int as n from cont_artifacts`)).rows[0].n;
assert.equal(art, 1, "long test output stored as an artifact");
const artRef = (await pool.query(`select payload->>'artifact_id' as a, length(payload->>'output_preview') as p from cont_events where session_id = $1 and call_id = 'e1' and kind = 'tool.finished'`, [sidR])).rows[0];
assert.ok(artRef.a && Number(artRef.p) <= 1200, "event references the artifact and keeps only a preview");
const snapTree = git(repoR, "ls-tree", "-r", "--name-only", sessR.wip_commit!).split("\n");
assert.ok(!snapTree.includes(".env") && snapTree.includes("src/banner.css"), "session snapshot excludes .env, includes untracked css");
ok("e2e 1: rachit's Codex session captured → thread auto-created and claimed → events, artifact, verified snapshot, head checkpoint");

// second pass with nothing new: no duplicate events, no new snapshot
const s1b = await helperOnce(cfgR, { roots, now: T(2), push: true, log: () => {} });
assert.equal(s1b.events_uploaded, 0);
assert.equal(s1b.snapshots, 0);
ok("idempotent pass: zero re-uploads, zero re-snapshots");

// ---------- e2e 2: rachit's session dies; quiet-end releases the claim ----------
const s2 = await helperOnce(cfgR, { roots, now: T(35), push: true, log: () => {} });
assert.equal(s2.errors.length, 0, s2.errors.join(" | "));
assert.equal(await S.getClaim(pool, thread.id), null, "claim released after quiet period");
assert.ok((await S.getSession(pool, sidR))!.ended_at, "session marked ended");
ok("e2e 2: 30 min quiet → claim released, session ended (no SessionEnd hook needed)");

// head rule after release: rachit's own late checkpoint under gen 1 must not advance
{
  const r = await S.publishCheckpoint(pool, { thread_id: thread.id, session_id: sidR, generation: 1, kind: "turn", through_event_seq: 9 });
  assert.equal(r.advanced, false);
  assert.match(r.reason!, /no live claim/);
  ok(`head rule: checkpoint without a live claim does not advance (${r.reason})`);
}

// ---------- e2e 3: agaaz resumes from a fresh clone ----------
const repoA = path.join(tmp, "agaaz", "demo");
fs.mkdirSync(path.dirname(repoA), { recursive: true });
git(path.dirname(repoA), "clone", "--quiet", bare, "demo");
const packR = await buildResumePack(cfgA, pool, thread.id, { mode: "continue", author: "agaaz", sessionId: "agaaz-sess-1", repoPath: repoA, now: T(480) });
assert.equal(packR.claim.acquired, true, packR.claim.note);
assert.equal(packR.claim.generation, 2, "generation increments on the new claim");
assert.ok(packR.text.includes("Add a greeting banner"), "goal present");
assert.ok(packR.text.includes("keep the price unchanged"), "constraint present verbatim");
assert.ok(packR.pending_operations.some((p) => p.call_id === "e2"), "in-flight npm run build listed as unknown");
assert.ok(packR.files_touched.some((f) => f.path === "src/app.ts"), "files touched");
assert.ok(packR.last_messages.some((m) => m.text.includes("360px")), "rachit's last message present");
assert.ok(packR.bootstrap[0].startsWith("git fetch origin refs/wip/rachit/"), packR.bootstrap.join("\n"));
assert.ok(packR.text.includes("remote-verified"), "loss window states verified timestamps");
assert.ok(!packR.text.includes("sk-live"), "no secret leaked into the pack");
const wt = path.join(tmp, "agaaz", "wt-banner");
checkoutWip(repoA, String(packR.checkpoint!.wip_ref), String(packR.checkpoint!.wip_commit), wt);
assert.equal(fs.readFileSync(path.join(wt, "src", "app.ts"), "utf8"), "export const banner = true; // rachit\n", "agaaz's worktree has rachit's exact edit");
assert.ok(fs.existsSync(path.join(wt, "src", "banner.css")), "untracked file recovered");
assert.ok(!fs.existsSync(path.join(wt, ".env")), ".env not in the recovered worktree");
assert.ok(!fs.existsSync(path.join(wt, "README.md")), "deletion recovered");
ok("e2e 3: agaaz claims (gen 2), gets goal/constraint/pending/files/last message, checks out the exact snapshot into a fresh worktree");

// simultaneous continue by a second agaaz session → 409-style refusal
{
  const c = await S.claimThread(pool, thread.id, "agaaz-sess-2", "agaaz");
  assert.equal(c.ok, false);
  assert.equal((c as any).holder.holder_session_id, "agaaz-sess-1");
  ok("claim CAS: second continue refused with the holder");
}

// ---------- e2e 4: rachit's laptop wakes and keeps uploading → fork, notify, head untouched ----------
const headBefore = (await S.getThread(pool, thread.id))!.head_checkpoint_id;
fs.appendFileSync(tR, [
  cl({ timestamp: "2026-09-08T10:05:00Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "e2", output: "build ok" } }),
  cl({ timestamp: "2026-09-08T10:05:01Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Build passed; trying the 360px fix now." }] } }),
].join("\n") + "\n");
fs.utimesSync(tR, T(485), T(485));
const s4 = await helperOnce(cfgR, { roots, now: T(486), push: true, log: () => {} });
assert.equal(s4.errors.length, 0, s4.errors.join(" | "));
const sessR2 = (await S.getSession(pool, sidR))!;
assert.ok(sessR2.fork_thread_id, "stale-generation session routed to a fork");
const fork = (await S.getThread(pool, sessR2.fork_thread_id!))!;
assert.equal(fork.forked_from_thread_id, thread.id);
assert.ok(fork.title.includes("rachit fork"));
const lateEv = (await pool.query(`select thread_id from cont_events where session_id = $1 and call_id = 'e2' and kind = 'tool.finished'`, [sidR])).rows[0];
assert.equal(lateEv.thread_id, fork.id, "late event lands on the fork");
const earlyEv = (await pool.query(`select thread_id from cont_events where session_id = $1 and call_id = 'p1' and kind = 'tool.requested'`, [sidR])).rows[0];
assert.equal(earlyEv.thread_id, thread.id, "historical events keep their original thread");
assert.equal((await S.getThread(pool, thread.id))!.head_checkpoint_id, headBefore, "head unchanged by the stale session");
// the helper pass already fetched rachit's notice into the local log (the path hooks read); the row is now delivered
const delivered = (await pool.query(`select message, delivered_at from cont_notifications where author = 'rachit'`)).rows;
assert.equal(delivered.length, 1);
assert.ok(delivered[0].delivered_at, "notice marked delivered by the helper");
const local = takeLocalNotifications();
assert.equal(local.length, 1, `local notifications log has the notice: ${JSON.stringify(local)}`);
assert.match(local[0], /continued by agaaz/);
assert.match(local[0], /fork/);
assert.equal(takeLocalNotifications().length, 0, "taking notices clears the log");
ok("e2e 4: stale generation → fork created, late events routed there, history intact, head untouched, rachit notified");

// ---------- unbound session still snapshotted (test 16/25) ----------
{
  const sidU = "0199ffff-0000-7000-8000-000000000001";
  const tU = path.join(day, `rollout-2026-09-08T03-00-00-${sidU}.jsonl`);
  // no human instruction yet: cannot auto-create a thread, but files must still be captured
  fs.writeFileSync(tU, [
    cl({ timestamp: "2026-09-08T03:00:00Z", type: "session_meta", payload: { id: sidU, cwd: repoR } }),
    cl({ timestamp: "2026-09-08T03:00:01Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "u1", input: 'await tools.exec_command({cmd:"ls"})' } }),
    cl({ timestamp: "2026-09-08T03:00:02Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "u1", output: "src" } }),
  ].join("\n") + "\n");
  fs.utimesSync(tU, T(600), T(600));
  fs.writeFileSync(path.join(repoR, "src", "unbound.txt"), "work with no thread\n");
  const su = await helperOnce(cfgR, { roots, now: T(601), push: true, log: () => {} });
  assert.equal(su.errors.length, 0, su.errors.join(" | "));
  const sU = (await S.getSession(pool, sidU))!;
  assert.equal(sU.thread_id, null, "unbound");
  // rachit now owns two open threads (original + fork), so the auto-bind rule must refuse rather than guess
  assert.match(String((sU.coverage as any).unbound_reason), /^ambiguous: 2 own open threads|^no human instruction yet/);
  assert.ok(sU.wip_commit, "unbound session still has a verified snapshot");
  const t = git(repoR, "ls-tree", "-r", "--name-only", sU.wip_commit!).split("\n");
  assert.ok(t.includes("src/unbound.txt") && !t.includes(".env"));
  ok("unbound session: no thread, but files snapshotted to refs/wip and .env still excluded");
}

// ---------- idempotent upload at the store level ----------
{
  const r1 = await S.appendEvents(pool, sidR, [{ producer_event_id: "dup:1", kind: "assistant.message", payload: { text: "x" } }], thread.id, null);
  const r2 = await S.appendEvents(pool, sidR, [{ producer_event_id: "dup:1", kind: "assistant.message", payload: { text: "x" } }], thread.id, null);
  assert.equal(r1.inserted, 1);
  assert.equal(r2.inserted, 0);
  ok("appendEvents is idempotent on (session, producer_event_id)");
}

await closePools();
console.log(`selftest-continuity: ok (${step} checks) — tmp ${tmp}`);
