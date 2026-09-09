import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Condition-plugin tests without a model. A trial-like context is built by hand (tiny git repo + bare
 * remote, trial ledger, trial config dir, trial HOME), two synthetic origin transcripts (Codex as rachit,
 * Claude as agaaz) run in the fixture repo, the classifier is a canned script, and the eval database is
 * LEDGER_CONTINUITY_DB (default postgresql://localhost:5432/ledger_selftest_eval_c). Everything lives
 * under ${TMPDIR:-/tmp}/ledger-eval/. The real ~/.ledger/config.json and ~/.gbrain must be unchanged afterwards.
 *
 * THE HARD RULE (2026-09-09 incident): this process sets LEDGER_EVAL=1 and points LEDGER_CONFIG_DIR at a
 * disposable directory BEFORE importing store.ts/db.ts/daemon.ts, so `saveConfig` can never touch the
 * machine config; the plugins are expected to set LEDGER_CONFIG_DIR = the trial config dir themselves and
 * restore it, which is asserted below (the ambient dir must stay empty).
 */

const DB = process.env.LEDGER_CONTINUITY_DB || "postgresql://localhost:5432/ledger_selftest_eval_c";
const evalRoot = path.join(os.tmpdir(), "ledger-eval");
fs.mkdirSync(evalRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(evalRoot, "selftest-conditions-"));
const ambientConfigDir = path.join(root, "ambient-ledger"); // stands in for ~/.ledger; nothing may write here
process.env.LEDGER_EVAL = "1";
process.env.LEDGER_CONFIG_DIR = ambientConfigDir;
process.env.LEDGER_GIT_SYNC = "0";
delete process.env.LEDGER_CLASSIFY;
delete process.env.LEDGER_DIR;
delete process.env.LEDGER_AUTHOR;

const realHome = os.homedir();
const realLedgerConfig = path.join(realHome, ".ledger", "config.json");
const realBrainConfig = path.join(realHome, ".gbrain", "config.json");
const snap = (f: string) => (fs.existsSync(f) ? { bytes: fs.readFileSync(f), mtimeMs: fs.statSync(f).mtimeMs } : null);
const realLedgerBefore = snap(realLedgerConfig);
const realBrainBefore = snap(realBrainConfig);
const sameSnap = (a: ReturnType<typeof snap>, b: ReturnType<typeof snap>) => (a === null && b === null) || (a !== null && b !== null && a.bytes.equals(b.bytes) && a.mtimeMs === b.mtimeMs);

const { getPool, migrate, closePools } = await import("../continuity/db.js");
const S = await import("../continuity/store.js");
const R = await import("../continuity/records.js");
const { repoIdentity } = await import("../continuity/shadow.js");
const { initLedger, record, saveConfig } = await import("../store.js");
const { pluginFor } = await import("./conditions/index.js");
const { bootstrapWorktree, trialConfig, assertIsolated } = await import("./conditions/ours.js");
const { sessionShort } = await import("./conditions/gbrain.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
type TrialContext = import("./types.js").TrialContext;
type OriginRun = import("./types.js").OriginRun;
type FixtureEvent = import("./types.js").FixtureEvent;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
const cl = (o: unknown) => JSON.stringify(o);
let step = 0;
const ok = (msg: string) => console.log(`  ok ${++step}. ${msg}`);
const gbrainReal = (...args: string[]) => { try { return execFileSync("gbrain", args, { env: { ...process.env, HOME: realHome }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).toString(); } catch (e: any) { return `ERR ${String(e?.message ?? e)}`; } };
const gbrainTrial = (home: string, ...args: string[]) => execFileSync("gbrain", args, { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).toString();
const withConfigDir = <T>(dir: string, fn: () => T): T => { const prev = process.env.LEDGER_CONFIG_DIR; process.env.LEDGER_CONFIG_DIR = dir; try { return fn(); } finally { if (prev === undefined) delete process.env.LEDGER_CONFIG_DIR; else process.env.LEDGER_CONFIG_DIR = prev; } };

/** Talk to an MCP stdio server the way the successor harness would, with a hard timeout; returns tool names and one call's text. */
async function mcpProbe(cmd: string, args: string[], env: Record<string, string>, tool: string, input: Record<string, unknown>, timeoutMs = 30_000): Promise<{ ms: number; tools: string[]; text: string }> {
  const t0 = Date.now();
  const transport = new StdioClientTransport({ command: cmd, args, env: { ...(process.env as Record<string, string>), ...env }, stderr: "pipe" });
  const errLog = path.join(root, `mcp-${path.basename(cmd)}-stderr.log`);
  transport.stderr?.on("data", (d: Buffer) => fs.appendFileSync(errLog, d));
  const client = new Client({ name: "selftest-eval-conditions", version: "0" });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`MCP probe of ${cmd} ${args.join(" ")} timed out after ${timeoutMs} ms (stderr in ${errLog})`)), timeoutMs); });
  try {
    await Promise.race([client.connect(transport), deadline]);
    const tools = (await Promise.race([client.listTools(), deadline])).tools.map((t) => t.name);
    const res = (await Promise.race([client.callTool({ name: tool, arguments: input }), deadline])) as { content?: { type: string; text?: string }[] };
    const text = (res.content ?? []).map((c) => (c.type === "text" ? String(c.text ?? "") : "")).join("\n");
    return { ms: Date.now() - t0, tools, text };
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

// ---------- the guard that would have stopped the incident ----------
{
  assert.equal(process.env.LEDGER_CONFIG_DIR, ambientConfigDir, "imports must not change LEDGER_CONFIG_DIR");
  const prev = process.env.LEDGER_CONFIG_DIR;
  delete process.env.LEDGER_CONFIG_DIR;
  assert.throws(() => saveConfig({ ledger_dir: root, author: "nobody", git_sync: false }), /refusing to write the real/, "saveConfig must refuse under LEDGER_EVAL=1 without LEDGER_CONFIG_DIR");
  process.env.LEDGER_CONFIG_DIR = prev;
  assert.ok(sameSnap(snap(realLedgerConfig), realLedgerBefore), "real ~/.ledger/config.json untouched by the refused write");
  ok("saveConfig refuses to write the real ~/.ledger/config.json from an eval process without LEDGER_CONFIG_DIR");
}

// ---------- the real brain and the real ledger config, before ----------
const realStatsBefore = gbrainReal("stats");
const realListBefore = gbrainReal("list", "--limit", "5000");

// ---------- fixture: bare remote, origin clone, successor clone ----------
const bare = path.join(root, "fixture.git");
const repo = path.join(root, "origin", "fixture");
const successorRepo = path.join(root, "successor", "fixture");
git(root, "init", "--bare", "--quiet", "-b", "master", bare);
fs.mkdirSync(path.dirname(repo), { recursive: true });
git(path.dirname(repo), "clone", "--quiet", bare, "fixture");
const layout0 = JSON.stringify({ price_inr: 199, cta_height: 48, safe_bottom: 0, content_gap: 24 }, null, 2) + "\n";
fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
fs.writeFileSync(path.join(repo, "layout.json"), layout0);
fs.writeFileSync(path.join(repo, "obsolete.txt"), "old\n");
fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
git(repo, "add", "-A");
git(repo, "commit", "--quiet", "-m", "init");
git(repo, "push", "--quiet", "origin", "master");
fs.mkdirSync(path.dirname(successorRepo), { recursive: true });
git(path.dirname(successorRepo), "clone", "--quiet", bare, "fixture");
// the origin's worktree after its sessions: an edit, a new untracked file, a deletion
const layout1 = layout0.replace('"cta_height": 48', '"cta_height": 56');
fs.writeFileSync(path.join(repo, "layout.json"), layout1);
fs.mkdirSync(path.join(repo, "generated"), { recursive: true });
fs.writeFileSync(path.join(repo, "generated", "study.txt"), "locked insight animation v3\n");
fs.unlinkSync(path.join(repo, "obsolete.txt"));
ok("fixture repo with bare remote, successor clone, dirty origin worktree (edit + untracked + deletion)");

// ---------- trial resources ----------
const ledgerDir = path.join(root, "ledger");
const configDir = path.join(root, "config");
const homeDir = path.join(root, "home");
const outputDir = path.join(root, "out");
const rawDir = path.join(outputDir, "raw");
for (const d of [configDir, homeDir, rawDir]) fs.mkdirSync(d, { recursive: true });
// initLedger writes a config.json: only ever into the TRIAL config dir (as the fixture does), never the ambient one
withConfigDir(configDir, () => initLedger(ledgerDir, "rachit"));
assert.ok(fs.existsSync(path.join(configDir, "config.json")) && !fs.existsSync(ambientConfigDir), "initLedger wrote the trial config only");
// the trial config as the fixture writes it, deliberately without continuity.repos: prepare must add it
fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ ledger_dir: ledgerDir, author: "rachit", git_sync: false, continuity: { database_url: DB, machine: "eval-test", include: ["generated/**"], classify: true } }, null, 2) + "\n");
ok("trial ledger initialised under the trial config dir; ambient LEDGER_CONFIG_DIR untouched");

const cfgDb = { ledger_dir: ledgerDir, author: "test", git_sync: false, continuity: { database_url: DB, machine: "eval-test" } };
const pool = getPool(cfgDb);
await pool.query(`drop table if exists cont_state_updates, cont_record_links, cont_records, cont_notifications, cont_artifacts, cont_claims, cont_checkpoints, cont_events, cont_sessions, cont_threads cascade`);
await migrate(pool);
ok(`schema reset on ${DB.replace(/\/\/[^@]*@/, "//…@")}`);

// ---------- fixture events and origin transcripts ----------
const GOAL = "Improve the locked marriage insight. Validate the small Android layout.";
const CONSTRAINT = "Binding instruction: keep price_inr at 199; do not change price to fix layout.";
const METRIC = "Decision metric-v2 supersedes metric-v1. Use unique exposed users as denominator. Confirmed by Agaaz.";
const events: FixtureEvent[] = [
  { id: "goal", topic: "paywall", text: GOAL, author: "rachit", session: "session-a" },
  { id: "constraint", topic: "paywall", text: CONSTRAINT, author: "rachit", session: "session-a" },
  { id: "metric-v2", topic: "conversion", text: METRIC, author: "agaaz", session: "session-b" },
];
const sidA = "0199eeee-1111-7222-8333-444444444441"; // codex, rachit
const sidB = "0199eeee-2222-7222-8333-444444444442"; // claude, agaaz
const shortA = sessionShort(sidA), shortB = sessionShort(sidB); // gbrain slugs use the id tail: both ids share a uuid-v7-style head
const fakeRoots = { claude: path.join(root, "fake", "claude"), codex: path.join(root, "fake", ".codex", "sessions") };
const dayDir = path.join(fakeRoots.codex, "2026", "09", "08");
fs.mkdirSync(dayDir, { recursive: true });
fs.mkdirSync(fakeRoots.claude, { recursive: true });
const tA = path.join(dayDir, `rollout-2026-09-08T02-00-00-${sidA}.jsonl`);
fs.writeFileSync(tA, [
  cl({ timestamp: "2026-09-08T02:00:00Z", type: "session_meta", payload: { id: sidA, cwd: repo, cli_version: "0.153.4" } }),
  cl({ timestamp: "2026-09-08T02:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: GOAL }] } }),
  cl({ timestamp: "2026-09-08T02:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: CONSTRAINT }] } }),
  cl({ timestamp: "2026-09-08T02:00:03Z", type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "p1", input: '*** Begin Patch\n*** Update File: layout.json\n@@\n-  "cta_height": 48,\n+  "cta_height": 56,\n*** End Patch' } }),
  cl({ timestamp: "2026-09-08T02:00:04Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "p1", output: "Success. Updated the following files:\nM layout.json" } }),
  cl({ timestamp: "2026-09-08T02:00:05Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "e1", input: 'await tools.exec_command({cmd:"npm test"})' } }),
  cl({ timestamp: "2026-09-08T02:00:06Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "e1", output: "1 failing: small viewport" } }),
  cl({ timestamp: "2026-09-08T02:00:07Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Layout patched (cta_height 56). The small-screen validation has not run yet." }] } }),
].join("\n") + "\n");
const tB = path.join(fakeRoots.claude, `${sidB}.jsonl`);
fs.writeFileSync(tB, [
  cl({ type: "user", timestamp: "2026-09-08T03:00:00Z", sessionId: sidB, cwd: repo, gitBranch: "master", message: { role: "user", content: METRIC } }),
  cl({ type: "assistant", timestamp: "2026-09-08T03:00:01Z", sessionId: sidB, cwd: repo, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: path.join(repo, "generated", "study.txt"), content: "locked insight animation v3\n" } }] } }),
  cl({ type: "user", timestamp: "2026-09-08T03:00:02Z", sessionId: sidB, cwd: repo, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] }, toolUseResult: { filePath: path.join(repo, "generated", "study.txt") } }),
  cl({ type: "assistant", timestamp: "2026-09-08T03:00:03Z", sessionId: sidB, cwd: repo, message: { role: "assistant", content: [{ type: "text", text: "Saved the study note. Next: validate the 640px viewport." }] } }),
].join("\n") + "\n");
process.env.LEDGER_EVAL_TRANSCRIPT_ROOTS = JSON.stringify(fakeRoots);

// ---------- fake classifier: one new record per session, one proposed `next` ----------
const fake = path.join(root, "fake-classifier.mjs");
const promptLog = path.join(root, "classifier-prompts.log");
const envLog = path.join(root, "classifier-env.log");
fs.writeFileSync(fake, `
import fs from "node:fs";
const prompt = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(promptLog)}, prompt + "\\n=====\\n");
fs.appendFileSync(${JSON.stringify(envLog)}, JSON.stringify({ LEDGER_EVAL: process.env.LEDGER_EVAL ?? null, LEDGER_CONFIG_DIR: process.env.LEDGER_CONFIG_DIR ?? null }) + "\\n");
const seqs = prompt.slice(prompt.indexOf("# Events")).split("\\n").map((l) => /^(\\d+) · /.exec(l)).filter(Boolean).map((m) => Number(m[1]));
const title = prompt.includes("price_inr") ? "Marriage paywall layout" : prompt.includes("metric-v2") ? "Conversion denominator decision" : "Misc work";
const out = {
  assignments: [{ record_id: null, new_record: { kind: "implementation", title, goal: title }, from_seq: Math.min(...seqs), to_seq: Math.max(...seqs), confidence: 0.8, why: "fixture" }],
  state_updates: [{ record_ref: title, kind: "next", text: "validate the small screen", evidence_seqs: [Math.max(...seqs)], confidence: 0.7 }],
  unassigned: [], notes: "fake classifier",
};
process.stdout.write(JSON.stringify(out));
`);
process.env.LEDGER_EXTRACTOR_CMD = `${JSON.stringify(process.execPath)} ${JSON.stringify(fake)}`;

// ---------- the trial context ----------
const logFile = path.join(rawDir, "controller.log");
const ctx: TrialContext = {
  request: {
    protocol_version: 1,
    case: { id: "SELFTEST", level: 1, title: "conditions selftest", events, resume_prompt: "Continue the paywall work.", setup: [], answer_keys: ["price_inr"], successor_answer_contract: {} },
    direction: "codex-to-claude", repetition: 1, trial_id: "selftest-conditions-1", output_dir: outputDir,
  },
  condition: "ours",
  paths: { root, repo, bare, successorRepo, ledgerDir, configDir, homeDir, rawDir, outputDir },
  originHarness: "codex", successorHarness: "claude",
  originAuthor: "rachit", successorAuthor: "agaaz",
  originModel: "none", successorModel: "none",
  evalDatabaseUrl: DB,
  log: (line: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`),
};
const origin: OriginRun = {
  harness: "codex",
  sessionIds: [sidA, sidB],
  turns: [
    { harness: "codex", sessionId: sidA, transcriptPath: tA, turnIndex: 0, fixtureEventId: "goal", assistantText: "", wallMs: 0 },
    { harness: "codex", sessionId: sidA, transcriptPath: tA, turnIndex: 1, fixtureEventId: "constraint", assistantText: "", wallMs: 0 },
    { harness: "claude", sessionId: sidB, transcriptPath: null, turnIndex: 0, fixtureEventId: "metric-v2", assistantText: "", wallMs: 0 },
  ],
  transcriptPaths: [tA], // session B's transcript is located by id under LEDGER_EVAL_TRANSCRIPT_ROOTS
  totalInputTokens: 0,
  compactions: 0,
};

// ======================================================================
// ours
// ======================================================================
const ours = pluginFor("ours");
assert.equal(ours.name, "ours");
assert.equal(pluginFor("gbrain").name, "gbrain");
ok("pluginFor resolves both conditions");

{
  assert.throws(() => assertIsolated({ ...ctx, paths: { ...ctx.paths, configDir: path.join(realHome, ".ledger") } }), /real/, "the real ~/.ledger is refused as a trial config dir");
  assert.throws(() => assertIsolated({ ...ctx, evalDatabaseUrl: "postgresql://u:p@ep-x.us-east-1.aws.neon.tech/neondb" }), /Neon/, "a Neon URL is refused as the eval database");
  const realDb = (() => { try { return JSON.parse(fs.readFileSync(realLedgerConfig, "utf8"))?.continuity?.database_url as string | undefined; } catch { return undefined; } })();
  if (realDb) assert.throws(() => assertIsolated({ ...ctx, evalDatabaseUrl: realDb }), /real continuity database/, "the machine's real continuity database is refused");
  assertIsolated(ctx);
  ok("ours refuses the real config dir, the real continuity database, and any Neon URL; accepts the trial context");
}

const prep = await ours.prepare(ctx, origin);
assert.ok(prep.prepared_ms > 0 && prep.notes.length >= 2, JSON.stringify(prep));
assert.equal(process.env.LEDGER_CONFIG_DIR, ambientConfigDir, "LEDGER_CONFIG_DIR restored after prepare");
assert.equal(process.env.LEDGER_EVAL, "1", "LEDGER_EVAL still set after prepare");
assert.equal(process.env.LEDGER_CLASSIFY, undefined, "LEDGER_CLASSIFY restored after prepare");
console.log(prep.notes.map((n) => `     · ${n}`).join("\n"));
ok(`ours.prepare ran in ${prep.prepared_ms} ms and restored the environment`);

{
  const cfgFile = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  assert.ok(Array.isArray(cfgFile.continuity.repos) && cfgFile.continuity.repos.includes(repo), `repos pinned: ${JSON.stringify(cfgFile.continuity)}`);
  assert.equal(cfgFile.continuity.database_url, DB);
  assert.deepEqual(cfgFile.continuity.include, ["generated/**"], "fixture keys preserved");
  assert.equal(cfgFile.author, "rachit", "author untouched by prepare");
  assert.ok(!fs.existsSync(ambientConfigDir), "nothing written under the ambient LEDGER_CONFIG_DIR (helper state, roots, signals all went to the trial dir)");
  assert.ok(!fs.existsSync(path.join(realHome, ".ledger", "eval-roots")), "nothing written under the real ~/.ledger");
  assert.ok(fs.existsSync(path.join(configDir, "helper-state.json")), "helper state lives in the trial config dir");
  assert.ok(fs.existsSync(path.join(configDir, "eval-roots", "1")) && fs.existsSync(path.join(configDir, "eval-roots", "2")), "private per-session transcript roots under the trial config dir");
  assert.ok(sameSnap(snap(realLedgerConfig), realLedgerBefore), "real ~/.ledger/config.json byte-identical after prepare");
  const envLines = fs.readFileSync(envLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(envLines.length >= 2 && envLines.every((e) => e.LEDGER_EVAL === "1" && e.LEDGER_CONFIG_DIR === configDir), `classifier children carried LEDGER_EVAL=1 and the trial config dir: ${JSON.stringify(envLines)}`);
  ok("trial config pinned to the fixture repo and the eval database; helper state, roots and classifier children isolated in the trial dir");
}

const sessA = (await S.getSession(pool, sidA))!;
const sessB = (await S.getSession(pool, sidB))!;
{
  assert.ok(sessA && sessB, "both origin sessions captured");
  assert.equal(sessA.author, "rachit"); assert.equal(sessA.harness, "codex");
  assert.equal(sessB.author, "agaaz"); assert.equal(sessB.harness, "claude");
  assert.equal(Number(sessA.transcript_offset), fs.statSync(tA).size, "session A fully tailed");
  assert.equal(Number(sessB.transcript_offset), fs.statSync(tB).size, "session B fully tailed");
  assert.equal(sessA.repo, repoIdentity(repo));
  assert.ok(sessA.thread_id && sessB.thread_id, "both sessions bound to threads");
  assert.notEqual(sessA.thread_id, sessB.thread_id, "different authors: different threads");
  const kinds = async (sid: string) => Object.fromEntries((await pool.query(`select kind, count(*)::int as n from cont_events where session_id = $1 group by kind`, [sid])).rows.map((r: any) => [r.kind, r.n]));
  const kA = await kinds(sidA), kB = await kinds(sidB);
  assert.equal(kA["instruction.added"], 2, JSON.stringify(kA));
  assert.equal(kA["tool.requested"], 2);
  assert.equal(kA["tool.finished"], 2);
  assert.equal(kA["file.changed"], 1);
  assert.equal(kA["assistant.message"], 1);
  assert.equal(kB["instruction.added"], 1, JSON.stringify(kB));
  assert.ok(kB["tool.requested"] === 1 && kB["file.changed"] >= 1 && kB["assistant.message"] === 1);
  ok("events uploaded for both sessions with the right authors, harnesses, kinds, and full transcript offsets");
}
{
  assert.ok(sessA.wip_ref && sessA.wip_commit && sessA.last_verified_snapshot_at, `session A snapshot verified: ${JSON.stringify({ ref: sessA.wip_ref, commit: sessA.wip_commit, at: sessA.last_verified_snapshot_at })}`);
  assert.equal(sessA.wip_ref, `refs/wip/rachit/${sidA}`);
  const remote = git(root, "--git-dir", bare, "show-ref", sessA.wip_ref!).split(/\s+/)[0];
  assert.equal(remote, sessA.wip_commit, "bare remote holds the exact snapshot commit");
  const tree = git(repo, "ls-tree", "-r", "--name-only", sessA.wip_commit!).split("\n");
  assert.ok(tree.includes("generated/study.txt") && tree.includes("layout.json") && !tree.includes("obsolete.txt"), `snapshot tree: ${tree.join(",")}`);
  assert.ok(sessB.wip_commit && sessB.last_verified_snapshot_at, "session B also snapshotted");
  ok("verified shadow snapshot on the bare remote: untracked file included, deletion captured");
}
{
  const cps = async (sid: string) => (await pool.query(`select kind, advanced_head from cont_checkpoints where session_id = $1 order by created_at`, [sid])).rows as { kind: string; advanced_head: boolean }[];
  const cA = await cps(sidA), cB = await cps(sidB);
  assert.ok(cA.some((c) => c.kind === "turn"), `turn checkpoint for A: ${JSON.stringify(cA)}`);
  assert.ok(cB.some((c) => c.kind === "turn"), `turn checkpoint for B: ${JSON.stringify(cB)}`);
  assert.ok(cA.some((c) => c.kind === "turn" && c.advanced_head), "A's turn checkpoint advanced the head under its live claim");
  assert.equal(await S.getClaim(pool, sessA.thread_id!), null, "A's claim released at end");
  assert.equal(await S.getClaim(pool, sessB.thread_id!), null, "B's claim released at end");
  assert.ok(sessA.ended_at && sessB.ended_at, "sessions ended");
  ok("turn checkpoints published (head advanced), then claims released as the SessionEnd signal would");
}
{
  const lA = await R.sessionLinks(pool, sidA), lB = await R.sessionLinks(pool, sidB);
  assert.ok(lA.length >= 1 && lA.every((l) => l.source === "suggested" && l.created_by === "classifier"), `A links: ${JSON.stringify(lA)}`);
  assert.ok(lB.length >= 1, `B links: ${JSON.stringify(lB)}`);
  const recs = await R.listRecords(pool, { status: "open", limit: 50 });
  const titles = recs.map((r) => r.title);
  assert.ok(titles.includes("Marriage paywall layout") && titles.includes("Conversion denominator decision"), `records: ${titles.join(" | ")}`);
  const ups = (await pool.query(`select count(*)::int as n from cont_state_updates where status = 'proposed' and created_by = 'classifier'`)).rows[0].n;
  assert.ok(ups >= 2, `proposed updates: ${ups}`);
  const prompts = fs.readFileSync(promptLog, "utf8");
  assert.ok(prompts.includes(CONSTRAINT) && prompts.includes(METRIC), "the classifier saw the real event text");
  ok("real classifier path ran synchronously: suggested links, new records, proposed updates from the canned model");
}
{
  const rec = JSON.parse(fs.readFileSync(path.join(configDir, "eval-origin.json"), "utf8"));
  assert.equal(rec.sessions.length, 2);
  assert.deepEqual(rec.sessions.map((s: any) => [s.id, s.author, s.harness, s.label]), [[sidA, "rachit", "codex", "session-a"], [sidB, "agaaz", "claude", "session-b"]]);
  ok("origin map persisted (session ids, authors, harnesses, labels) for the successor phase");
}

// successorSetup
const setup = await ours.successorSetup(ctx);
let oursServer: { command: string; args: string[]; env: Record<string, string> };
{
  assert.equal(process.env.LEDGER_CONFIG_DIR, ambientConfigDir, "LEDGER_CONFIG_DIR restored after successorSetup");
  assert.equal(setup.mcpConfigPath, path.join(configDir, "mcp-ours.json"));
  const mcp = JSON.parse(fs.readFileSync(setup.mcpConfigPath!, "utf8"));
  oursServer = mcp.mcpServers.ledger;
  assert.equal(oursServer.command, process.execPath);
  assert.ok(fs.existsSync(oursServer.args[0]) && path.isAbsolute(oursServer.args[0]) && oursServer.args[0].endsWith("cli.js") && oursServer.args[1] === "mcp", JSON.stringify(oursServer.args));
  assert.equal(oursServer.env.LEDGER_CONFIG_DIR, configDir);
  assert.equal(oursServer.env.LEDGER_AUTHOR, "agaaz");
  assert.equal(oursServer.env.LEDGER_EVAL, "1");
  assert.equal(oursServer.env.LEDGER_CONTINUITY_DB, DB);
  const cfgFile = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  assert.equal(cfgFile.author, "agaaz", "trial config author switched to the successor");
  assert.deepEqual(cfgFile.continuity.include, ["generated/**"], "author switch preserved the other keys");
  assert.equal(setup.env.LEDGER_CONFIG_DIR, configDir);
  assert.equal(setup.env.LEDGER_EVAL, "1");
  assert.ok(setup.allowedTools.includes("mcp__ledger__*") && setup.allowedTools.includes("Read"));
  assert.equal(setup.cwd, successorRepo);
  assert.equal(setup.preamble, fs.readFileSync(path.join(rawDir, "ours-startup-brief.txt"), "utf8").trim());
  assert.ok(setup.preamble.includes(sessA.thread_id!), "explicit startup brief includes the trial origin thread");
  ok("ours.successorSetup: MCP config runs `node cli.js mcp` against the trial config dir as agaaz with LEDGER_EVAL=1; author switched with fs");
}
{
  // the server the successor would get, started exactly as configured: it must read the TRIAL config and see the origin threads
  const probe = await mcpProbe(oursServer.command, oursServer.args, oursServer.env, "ledger_threads", { cwd: successorRepo, include_own: true, hours: 720, limit: 10 });
  for (const t of ["ledger_threads", "ledger_resume", "ledger_records", "ledger_brief", "ledger_evidence_search"]) assert.ok(probe.tools.includes(t), `tool ${t} in ${probe.tools.length} tools`);
  assert.ok(probe.text.includes(sessA.thread_id!) && probe.text.includes(sessB.thread_id!), `ledger_threads over the trial config lists both origin threads:\n${probe.text}`);
  assert.ok(probe.text.includes("rachit"), probe.text);
  assert.ok(sameSnap(snap(realLedgerConfig), realLedgerBefore), "real ~/.ledger/config.json byte-identical after the MCP server ran");
  ok(`ledger MCP server from mcp-ours.json answered in ${probe.ms} ms with ${probe.tools.length} tools and lists both origin threads from the eval database`);
}

// bootstrapWorktree
{
  const wt = await bootstrapWorktree(ctx);
  assert.ok(wt, "worktree bootstrapped");
  assert.equal(wt!.worktree, `${successorRepo}-wt`);
  assert.equal(wt!.wip_commit, sessB.wip_commit ?? sessA.wip_commit);
  assert.equal(git(wt!.worktree, "rev-parse", "HEAD"), wt!.wip_commit);
  assert.equal(fs.readFileSync(path.join(wt!.worktree, "layout.json"), "utf8"), layout1, "successor worktree has the origin's edit");
  assert.ok(fs.existsSync(path.join(wt!.worktree, "generated", "study.txt")), "untracked file recovered");
  assert.ok(!fs.existsSync(path.join(wt!.worktree, "obsolete.txt")), "deletion recovered");
  const again = await bootstrapWorktree(ctx);
  assert.equal(again!.worktree, wt!.worktree, "idempotent");
  assert.equal(process.env.LEDGER_CONFIG_DIR, ambientConfigDir, "LEDGER_CONFIG_DIR restored after bootstrapWorktree");
  ok("bootstrapWorktree checks the verified snapshot out of the bare remote into <successorRepo>-wt");
}

// evidenceRef: events, then a real Ledger decision
{
  const c = await ours.evidenceRef(ctx, events[1]);
  assert.ok(c && /^event:[^:]+:\d+$/.test(c.system_ref), JSON.stringify(c));
  const [, sid, seq] = c!.system_ref.split(":");
  assert.equal(sid, sidA);
  const row = (await pool.query(`select kind, payload->>'text' as text from cont_events where session_id = $1 and seq = $2`, [sid, Number(seq)])).rows[0];
  assert.equal(row.kind, "instruction.added");
  assert.equal(row.text, CONSTRAINT);
  const g = await ours.evidenceRef(ctx, events[0]);
  assert.ok(g && g.system_ref.startsWith(`event:${sidA}:`) && g.system_ref !== c!.system_ref);
  const m = await ours.evidenceRef(ctx, events[2]);
  assert.ok(m && m.system_ref.startsWith(`event:${sidB}:`), JSON.stringify(m));
  const ws = await ours.evidenceRef(ctx, { ...events[1], text: `  Binding instruction:   keep price_inr at 199;\ndo not change price to fix layout. ` });
  assert.equal(ws?.system_ref, c!.system_ref, "whitespace-normalized match resolves to the same event");
  const none = await ours.evidenceRef(ctx, { id: "x", topic: "x", text: "this sentence was never said by anyone zzqx", author: "rachit", session: "session-a" });
  assert.equal(none, null);
  assert.equal(process.env.LEDGER_CONFIG_DIR, ambientConfigDir, "LEDGER_CONFIG_DIR restored after evidenceRef");
  ok("ours.evidenceRef resolves fixture text to event:<session>:<seq> (exact and whitespace-normalized, instruction first) and null for unknown text");

  const trialCfg = withConfigDir(configDir, () => trialConfig(ctx, { write: false }));
  const dec = record(trialCfg, {
    type: "decision",
    fields: {
      title: "Conversion denominator: unique exposed users",
      decision: METRIC,
      context: "The denominator definition changed after review of the exposure data; the old one was all sessions.",
      options_considered: [{ option: "unique exposed users", chosen: true, rationale: "matches exposure" }, { option: "all sessions", rationale: "superseded" }],
      rationale: "Exposure-based denominator matches what the paywall shows.",
      assumptions: [{ statement: "Exposure logging is complete for the window", kind: "implicit", evidence: "not independently verified", if_wrong: "changes_conclusion" }],
      valid_from: "2026-09-08",
      owner: "agaaz",
    },
  });
  const l = await ours.evidenceRef(ctx, events[2]);
  assert.equal(l?.system_ref, `ledger:${dec.id}`, JSON.stringify(l));
  ok(`ours.evidenceRef prefers a trial-ledger decision carrying the text: ${dec.id}`);
}

// ======================================================================
// gbrain
// ======================================================================
const gbrain = pluginFor("gbrain");
const ctxG: TrialContext = { ...ctx, condition: "gbrain" };
{
  await assert.rejects(gbrain.prepare({ ...ctxG, paths: { ...ctxG.paths, homeDir: realHome } }, origin), /real home/, "the real HOME is refused");
  await assert.rejects(gbrain.prepare({ ...ctxG, paths: { ...ctxG.paths, homeDir: "" } }, origin), /absolute/, "an empty HOME is refused (it would fall through to the real brain)");
  ok("gbrain refuses to run against the real HOME or an empty HOME");
}
const prepG = await gbrain.prepare(ctxG, origin);
console.log(prepG.notes.map((n) => `     · ${n}`).join("\n"));
const contentKinds = ["instruction.added", "assistant.message", "tool.requested", "tool.finished", "file.changed", "compaction"];
{
  const cfg = JSON.parse(fs.readFileSync(path.join(homeDir, ".gbrain", "config.json"), "utf8"));
  assert.ok(String(cfg.database_path).startsWith(homeDir + path.sep) || String(cfg.database_path).startsWith(fs.realpathSync(homeDir) + path.sep), `isolated brain: ${JSON.stringify(cfg)}`);
  assert.equal(cfg.engine, "pglite");
  const ingest = JSON.parse(fs.readFileSync(path.join(homeDir, ".gbrain", "eval-ingest.json"), "utf8"));
  // one page per content event: the same normalized events our helper uploaded
  const contentEvents = (await pool.query(`select count(*)::int as n from cont_events where session_id = any($1) and kind = any($2)`, [[sidA, sidB], contentKinds])).rows[0].n;
  assert.equal(ingest.pages, contentEvents, `event pages: ${JSON.stringify(ingest)} vs ${contentEvents} content events in the eval database`);
  assert.equal(ingest.session_pages, 2);
  assert.equal(ingest.put_ok, ingest.pages + 2, "one `gbrain put` per event page plus the two session pages");
  assert.equal(ingest.put_failed, 0);
  assert.equal(ingest.tag_ok, 2 * (ingest.pages + 2), "two `gbrain tag` calls per page (kind + session; session + slug for session pages)");
  assert.equal(ingest.tag_failed, 0);
  assert.equal(ingest.timeline, ingest.pages, "one timeline entry per event page");
  assert.equal(typeof ingest.embed_ok, "boolean");
  ok(`gbrain.prepare created an isolated PGLite brain under the trial HOME with ${ingest.pages} event pages via put/tag (${prepG.prepared_ms} ms; embed ${ingest.embed_ok ? "ok" : `not done: ${ingest.embed_note}`})`);
}
{
  const list = gbrainTrial(homeDir, "list", "--limit", "5000");
  const slugs = list.split("\n").map((l) => l.split("\t")[0]).filter(Boolean);
  const eventsA = slugs.filter((s) => s.startsWith(`s-${shortA}-`)).length, eventsB = slugs.filter((s) => s.startsWith(`s-${shortB}-`)).length;
  assert.ok(eventsA === 8 && eventsB >= 4 && slugs.includes(`session-${shortA}`) && slugs.includes(`session-${shortB}`), `list: ${slugs.join(",")}`);
  // slugs carry the seq the helper assigned to the same event (session_meta is seq 1, so the goal is 2 and the constraint 3)
  const seqOf = async (sid: string, text: string) => Number((await pool.query(`select seq from cont_events where session_id = $1 and payload->>'text' = $2`, [sid, text])).rows[0]?.seq);
  const seqG = await seqOf(sidA, GOAL), seqC = await seqOf(sidA, CONSTRAINT);
  assert.ok(seqG > 0 && seqC > seqG, `seqs: goal ${seqG}, constraint ${seqC}`);
  const slugC = `s-${shortA}-${seqC}`;
  assert.ok(slugs.includes(slugC), `slug ${slugC} exists (seq aligned with cont_events)`);
  const tags = gbrainTrial(homeDir, "tags", slugC);
  assert.ok(tags.includes("instruction.added") && tags.includes(`session-${shortA}`) && tags.includes("rachit"), `tags on ${slugC}: ${tags}`);
  const page = gbrainTrial(homeDir, "get", slugC);
  assert.ok(page.includes(`# instruction.added · session ${shortA} · seq ${seqC}`) && page.includes(CONSTRAINT) && page.includes("(author: rachit, harness: codex, at: 2026-09-08T02:00:02Z)"), `page format:\n${page}`);
  const search = gbrainTrial(homeDir, "call", "search", JSON.stringify({ query: "price_inr 199 layout", limit: 5 }));
  assert.ok(search.includes(slugC), `search hit: ${search.slice(0, 300)}`);
  const sessionPage = gbrainTrial(homeDir, "call", "get_page", JSON.stringify({ slug: `session-${shortA}` }));
  assert.ok(sessionPage.includes(CONSTRAINT.slice(0, 40)) && sessionPage.includes(`seq ${seqG} ·`) && sessionPage.indexOf(`seq ${seqG} ·`) < sessionPage.indexOf(`seq ${seqC} ·`), "session page lists the events in order");
  const stats = gbrainTrial(homeDir, "stats");
  assert.ok(/Timeline:\s+\d+/.test(stats) && !/Timeline:\s+0\b/.test(stats), `timeline entries present: ${stats}`);
  ok("event pages (title, text, author/harness/at), tags, session page, and timeline entries are searchable in the trial brain");
}
{
  assert.equal(gbrainReal("stats"), realStatsBefore, "real brain stats unchanged");
  assert.equal(gbrainReal("list", "--limit", "5000"), realListBefore, "real brain page list unchanged");
  assert.ok(sameSnap(snap(realBrainConfig), realBrainBefore), "real ~/.gbrain/config.json unchanged");
  ok("the real ~/.gbrain is untouched (stats, page list, and config identical before and after)");
}
const setupG = await gbrain.successorSetup(ctxG);
let gbrainServer: { command: string; args: string[]; env: Record<string, string> };
{
  assert.equal(setupG.mcpConfigPath, path.join(configDir, "mcp-gbrain.json"));
  const mcp = JSON.parse(fs.readFileSync(setupG.mcpConfigPath!, "utf8"));
  gbrainServer = mcp.mcpServers.gbrain;
  assert.ok(fs.existsSync(gbrainServer.command) && path.basename(gbrainServer.command) === "gbrain", gbrainServer.command);
  assert.deepEqual(gbrainServer.args, ["serve"]);
  assert.deepEqual(gbrainServer.env, { HOME: homeDir });
  assert.ok(!("HOME" in setupG.env), "the successor process keeps its real HOME");
  assert.ok(!("LEDGER_CONFIG_DIR" in setupG.env), "no ledger config is handed to the gbrain successor");
  assert.ok(setupG.allowedTools.includes("mcp__gbrain__*") && !setupG.allowedTools.some((t) => t.startsWith("mcp__ledger")));
  assert.equal(setupG.cwd, successorRepo);
  assert.ok(setupG.preamble.includes("gbrain knowledge brain"));
  ok("gbrain.successorSetup: MCP config runs `gbrain serve` with HOME = trial home; successor keeps its HOME; no ledger tools");
}
{
  // `gbrain serve` is only ever started through the MCP config; here through a client with a hard timeout
  const probe = await mcpProbe(gbrainServer.command, gbrainServer.args, gbrainServer.env, "search", { query: "price_inr 199 layout", limit: 3 });
  for (const t of ["search", "query", "get_page", "traverse_graph", "get_timeline"]) assert.ok(probe.tools.includes(t), `tool ${t} in ${probe.tools.length} tools`);
  assert.ok(probe.text.includes(`s-${shortA}-`) && probe.text.includes("price_inr"), `serve search over the trial brain:\n${probe.text.slice(0, 400)}`);
  assert.equal(gbrainReal("stats"), realStatsBefore, "real brain stats unchanged after serve");
  ok(`gbrain serve from mcp-gbrain.json answered in ${probe.ms} ms with ${probe.tools.length} tools and searches the trial brain`);
}
{
  const c = await gbrain.evidenceRef(ctxG, events[1]);
  assert.ok(c && /^gbrain:page:s-[0-9a-f]{8}-\d+$/.test(c.system_ref), JSON.stringify(c));
  const slug = c!.system_ref.slice("gbrain:page:".length);
  const page = gbrainTrial(homeDir, "call", "get_page", JSON.stringify({ slug }));
  assert.ok(JSON.parse(page.slice(page.indexOf("{"), page.lastIndexOf("}") + 1)).compiled_truth.includes(CONSTRAINT), "page body carries the exact text");
  const m = await gbrain.evidenceRef(ctxG, events[2]);
  assert.ok(m && m.system_ref.startsWith(`gbrain:page:s-${shortB}-`), JSON.stringify(m));
  const none = await gbrain.evidenceRef(ctxG, { id: "x", topic: "x", text: "this sentence was never said by anyone zzqx", author: "rachit", session: "session-a" });
  assert.equal(none, null);
  ok("gbrain.evidenceRef returns gbrain:page:<slug> for ingested text and null for unknown text");
}

// ---------- the machine is as we found it ----------
{
  assert.ok(sameSnap(snap(realLedgerConfig), realLedgerBefore), "real ~/.ledger/config.json byte-identical (and same mtime) before and after the whole run");
  assert.ok(sameSnap(snap(realBrainConfig), realBrainBefore), "real ~/.gbrain/config.json byte-identical before and after");
  assert.ok(!fs.existsSync(ambientConfigDir), "ambient LEDGER_CONFIG_DIR never written");
  assert.equal(process.env.LEDGER_CONFIG_DIR, ambientConfigDir);
  ok("~/.ledger/config.json and ~/.gbrain unchanged; the ambient config dir was never written");
}

await closePools();
console.log(`selftest-eval-conditions: ok (${step} checks) — ${root}`);
process.exit(0);
