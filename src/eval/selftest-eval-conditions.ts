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
 * under ${TMPDIR:-/tmp}/ledger-eval/. The real ~/.gbrain must be unchanged afterwards.
 */

const DB = process.env.LEDGER_CONTINUITY_DB || "postgresql://localhost:5432/ledger_selftest_eval_c";
const evalRoot = path.join(os.tmpdir(), "ledger-eval");
fs.mkdirSync(evalRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(evalRoot, "selftest-conditions-"));
process.env.LEDGER_GIT_SYNC = "0";
delete process.env.LEDGER_CONFIG_DIR;
delete process.env.LEDGER_CLASSIFY;

const { getPool, migrate, closePools } = await import("../continuity/db.js");
const S = await import("../continuity/store.js");
const R = await import("../continuity/records.js");
const { repoIdentity } = await import("../continuity/shadow.js");
const { initLedger, record } = await import("../store.js");
const { pluginFor } = await import("./conditions/index.js");
const { bootstrapWorktree, trialConfig } = await import("./conditions/ours.js");
const { sessionShort } = await import("./conditions/gbrain.js");
type TrialContext = import("./types.js").TrialContext;
type OriginRun = import("./types.js").OriginRun;
type FixtureEvent = import("./types.js").FixtureEvent;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
const cl = (o: unknown) => JSON.stringify(o);
let step = 0;
const ok = (msg: string) => console.log(`  ok ${++step}. ${msg}`);
const realHome = os.homedir();
const gbrainReal = (...args: string[]) => { try { return execFileSync("gbrain", args, { env: { ...process.env, HOME: realHome }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).toString(); } catch (e: any) { return `ERR ${String(e?.message ?? e)}`; } };
const gbrainTrial = (home: string, ...args: string[]) => execFileSync("gbrain", args, { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).toString();

// ---------- the real brain, before ----------
const realBrainConfig = path.join(realHome, ".gbrain", "config.json");
const realConfigBefore = fs.existsSync(realBrainConfig) ? fs.readFileSync(realBrainConfig, "utf8") : null;
const realStatsBefore = gbrainReal("stats");

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
initLedger(ledgerDir, "rachit");
const configDir = path.join(root, "config");
const homeDir = path.join(root, "home");
const outputDir = path.join(root, "out");
const rawDir = path.join(outputDir, "raw");
for (const d of [configDir, homeDir, rawDir]) fs.mkdirSync(d, { recursive: true });
// deliberately without continuity.repos: prepare must add it
fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ ledger_dir: ledgerDir, author: "rachit", git_sync: false, continuity: { database_url: DB, machine: "eval-test" } }, null, 2));

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
fs.writeFileSync(fake, `
import fs from "node:fs";
const prompt = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(promptLog)}, prompt + "\\n=====\\n");
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

const prep = await ours.prepare(ctx, origin);
assert.ok(prep.prepared_ms > 0 && prep.notes.length >= 2, JSON.stringify(prep));
assert.equal(process.env.LEDGER_CONFIG_DIR, undefined, "LEDGER_CONFIG_DIR restored after prepare");
assert.equal(process.env.LEDGER_CLASSIFY, undefined, "LEDGER_CLASSIFY restored after prepare");
console.log(prep.notes.map((n) => `     · ${n}`).join("\n"));
ok(`ours.prepare ran in ${prep.prepared_ms} ms and restored the environment`);

{
  const cfgFile = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  assert.ok(Array.isArray(cfgFile.continuity.repos) && cfgFile.continuity.repos.includes(repo), `repos pinned: ${JSON.stringify(cfgFile.continuity)}`);
  assert.equal(cfgFile.continuity.database_url, DB);
  assert.ok(!fs.existsSync(path.join(realHome, ".ledger", "eval-roots")), "nothing written under the real ~/.ledger");
  assert.ok(fs.existsSync(path.join(configDir, "helper-state.json")), "helper state lives in the trial config dir");
  ok("trial config pinned to the fixture repo and the eval database; helper state isolated in the trial dir");
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
{
  assert.equal(setup.mcpConfigPath, path.join(configDir, "mcp-ours.json"));
  const mcp = JSON.parse(fs.readFileSync(setup.mcpConfigPath!, "utf8"));
  const srv = mcp.mcpServers.ledger;
  assert.equal(srv.command, process.execPath);
  assert.ok(fs.existsSync(srv.args[0]) && srv.args[0].endsWith("cli.js") && srv.args[1] === "mcp", JSON.stringify(srv.args));
  assert.equal(srv.env.LEDGER_CONFIG_DIR, configDir);
  assert.equal(srv.env.LEDGER_AUTHOR, "agaaz");
  assert.equal(srv.env.LEDGER_CONTINUITY_DB, DB);
  assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8")).author, "agaaz", "trial config author switched to the successor");
  assert.equal(setup.env.LEDGER_CONFIG_DIR, configDir);
  assert.ok(setup.allowedTools.includes("mcp__ledger__*") && setup.allowedTools.includes("Read"));
  assert.equal(setup.cwd, successorRepo);
  assert.equal(setup.preamble, "");
  ok("ours.successorSetup: MCP config runs `node cli.js mcp` against the trial config dir as agaaz; author switched");
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
  const none = await ours.evidenceRef(ctx, { id: "x", topic: "x", text: "this sentence was never said by anyone zzqx", author: "rachit", session: "session-a" });
  assert.equal(none, null);
  ok("ours.evidenceRef resolves fixture text to event:<session>:<seq> (exact, instruction first) and null for unknown text");

  const trialCfg = trialConfig(ctx, { write: false });
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
const prepG = await gbrain.prepare(ctxG, origin);
console.log(prepG.notes.map((n) => `     · ${n}`).join("\n"));
{
  const cfg = JSON.parse(fs.readFileSync(path.join(homeDir, ".gbrain", "config.json"), "utf8"));
  assert.ok(String(cfg.database_path).startsWith(homeDir + path.sep) || String(cfg.database_path).startsWith(fs.realpathSync(homeDir) + path.sep), `isolated brain: ${JSON.stringify(cfg)}`);
  assert.equal(cfg.engine, "pglite");
  const ingest = JSON.parse(fs.readFileSync(path.join(homeDir, ".gbrain", "eval-ingest.json"), "utf8"));
  // one page per content event: the same normalized events our helper uploaded
  const contentEvents = (await pool.query(`select count(*)::int as n from cont_events where session_id = any($1) and kind = any($2)`, [[sidA, sidB], ["instruction.added", "assistant.message", "tool.requested", "tool.finished", "file.changed", "compaction"]])).rows[0].n;
  assert.equal(ingest.pages, contentEvents, `event pages: ${JSON.stringify(ingest)} vs ${contentEvents} content events in the eval database`);
  assert.equal(ingest.imported, ingest.pages + 2, "import wrote every event page plus the two session pages");
  assert.equal(ingest.timeline, ingest.pages, "one timeline entry per event page");
  ok(`gbrain.prepare created an isolated PGLite brain under the trial HOME with ${ingest.pages} event pages (${prepG.prepared_ms} ms)`);
}
{
  const list = gbrainTrial(homeDir, "list", "-n", "5");
  assert.ok(/s-0199eeee-\d+/.test(list) || /session-0199eeee/.test(list), `list: ${list}`);
  const search = gbrainTrial(homeDir, "call", "search", JSON.stringify({ query: "price_inr 199 layout", limit: 5 }));
  assert.ok(search.includes(`s-${sidA.slice(0, 8)}-`), `search hit: ${search.slice(0, 300)}`);
  const page = gbrainTrial(homeDir, "call", "get_page", JSON.stringify({ slug: `session-${sidA.slice(0, 8)}` }));
  assert.ok(page.includes(CONSTRAINT.slice(0, 40)) && page.includes("seq"), "session page lists the events in order");
  const stats = gbrainTrial(homeDir, "stats");
  assert.ok(/Timeline:\s+\d+/.test(stats) && !/Timeline:\s+0\b/.test(stats), `timeline entries present: ${stats}`);
  ok("event pages, session page, tags, and timeline entries are searchable in the trial brain");
}
{
  assert.equal(gbrainReal("stats"), realStatsBefore, "real brain stats unchanged");
  const after = fs.existsSync(realBrainConfig) ? fs.readFileSync(realBrainConfig, "utf8") : null;
  assert.equal(after, realConfigBefore, "real ~/.gbrain/config.json unchanged");
  ok("the real ~/.gbrain is untouched (stats and config identical before and after)");
}
const setupG = await gbrain.successorSetup(ctxG);
{
  assert.equal(setupG.mcpConfigPath, path.join(configDir, "mcp-gbrain.json"));
  const mcp = JSON.parse(fs.readFileSync(setupG.mcpConfigPath!, "utf8"));
  const srv = mcp.mcpServers.gbrain;
  assert.ok(fs.existsSync(srv.command) && path.basename(srv.command) === "gbrain", srv.command);
  assert.deepEqual(srv.args, ["serve"]);
  assert.equal(srv.env.HOME, homeDir);
  assert.ok(!("HOME" in setupG.env), "the successor process keeps its real HOME");
  assert.ok(setupG.allowedTools.includes("mcp__gbrain__*") && !setupG.allowedTools.some((t) => t.startsWith("mcp__ledger")));
  assert.equal(setupG.cwd, successorRepo);
  assert.ok(setupG.preamble.includes("gbrain knowledge brain"));
  ok("gbrain.successorSetup: MCP config runs `gbrain serve` with HOME = trial home; no ledger tools");
}
{
  const c = await gbrain.evidenceRef(ctxG, events[1]);
  assert.ok(c && /^gbrain:page:s-[0-9a-f]{8}-\d+$/.test(c.system_ref), JSON.stringify(c));
  const slug = c!.system_ref.slice("gbrain:page:".length);
  const page = gbrainTrial(homeDir, "call", "get_page", JSON.stringify({ slug }));
  assert.ok(JSON.parse(page.slice(page.indexOf("{"), page.lastIndexOf("}") + 1)).compiled_truth.includes(CONSTRAINT), "page body carries the exact text");
  const m = await gbrain.evidenceRef(ctxG, events[2]);
  assert.ok(m && m.system_ref.startsWith(`gbrain:page:s-${sidB.slice(0, 8)}-`), JSON.stringify(m));
  const none = await gbrain.evidenceRef(ctxG, { id: "x", topic: "x", text: "this sentence was never said by anyone zzqx", author: "rachit", session: "session-a" });
  assert.equal(none, null);
  ok("gbrain.evidenceRef returns gbrain:page:<slug> for ingested text and null for unknown text");
}

await closePools();
console.log(`selftest-eval-conditions: ok (${step} checks) — ${root}`);
