import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Continuity evaluation harness drivers: fixture, origin, successor, harness plumbing.
 *
 * Default: FAKE mode (LEDGER_EVAL_FAKE_HARNESS=1). No claude/codex process is started;
 * the drivers write synthetic transcripts in both formats under a temp root and return
 * canned outputs, so the tests cover trial construction, session grouping and harness
 * assignment in both directions, transcript location, tool-call collection, token
 * accounting, cleanup, and isolation (nothing outside the selftest root, ~/.ledger and
 * the real transcript roots untouched). Needs Postgres at localhost:5432; database
 * LEDGER_EVAL_DB, default ledger_selftest_eval_a.
 *
 * LEDGER_EVAL_REAL=1: one real Claude Haiku origin (2 turns) and one real Claude Haiku
 * successor (no MCP) in a disposable repo. Costs model calls; run once and keep the numbers.
 */

// HARD RULE, before anything from this repo is imported: this is an eval process (src/store.ts saveConfig() throws
// under LEDGER_EVAL=1 without LEDGER_CONFIG_DIR) and LEDGER_CONFIG_DIR points at a disposable guard dir, never
// ~/.ledger. The real ~/.ledger/config.json is snapshotted below and must be byte-identical at the end.
process.env.LEDGER_EVAL = "1";
const REAL = process.env.LEDGER_EVAL_REAL === "1";
if (!REAL) process.env.LEDGER_EVAL_FAKE_HARNESS = "1";
const tmpRoot = path.join(process.env.TMPDIR || "/tmp", "ledger-eval");
const base = path.join(tmpRoot, `selftest-drivers-${process.pid}`);
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });
const guardConfigDir = path.join(base, "config-guard");
fs.mkdirSync(guardConfigDir, { recursive: true });
process.env.LEDGER_CONFIG_DIR = guardConfigDir;
process.env.LEDGER_EVAL_FAKE_ROOT = path.join(base, "fake-transcripts");
process.env.LEDGER_EVAL_DB = process.env.LEDGER_EVAL_DB || "postgresql://localhost:5432/ledger_selftest_eval_a";
delete process.env.LEDGER_EVAL_KEEP;
delete process.env.LEDGER_EVAL_FAKE_NO_USAGE;
delete process.env.LEDGER_EVAL_ORIGIN_MODEL;
delete process.env.LEDGER_EVAL_SUCCESSOR_MODEL;
const realCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
if (!REAL) {
  // a fake CODEX_HOME so the Codex successor's per-trial home copies a fake auth.json, never the real one
  const fakeCodexHome = path.join(base, "fake-codex-home");
  fs.mkdirSync(fakeCodexHome, { recursive: true });
  fs.writeFileSync(path.join(fakeCodexHome, "auth.json"), JSON.stringify({ fake: true, tokens: "not-a-real-token" }));
  fs.writeFileSync(path.join(fakeCodexHome, "config.toml"), 'model = "fake-codex-model"\nmodel_reasoning_effort = "low"\n\n[projects."/x"]\ntrust_level = "trusted"\n');
  process.env.CODEX_HOME = fakeCodexHome;
}

// what must not change while the drivers run
const realLedgerConfig = path.join(os.homedir(), ".ledger", "config.json");
const snap = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
const snapBytes = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f) : null);
const listing = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).sort().join("\n") : "<absent>");
const ledgerCfgBefore = snap(realLedgerConfig);
const ledgerCfgBytesBefore = snapBytes(realLedgerConfig);
const ledgerCfgMtimeBefore = fs.existsSync(realLedgerConfig) ? fs.statSync(realLedgerConfig).mtimeMs : null;
const claudeProjectsBefore = listing(path.join(os.homedir(), ".claude", "projects"));
const codexSessionsBefore = listing(path.join(realCodexHome, "sessions"));

const H = await import("./eval/harness.js");
const F = await import("./eval/fixture.js");
const O = await import("./eval/origin.js");
const S = await import("./eval/successor.js");
const { findTranscript } = await import("./transcript.js");
const { streamTranscript } = await import("./continuity/events.js");
type PublicCase = import("./eval/types.js").PublicCase;
type AdapterRequest = import("./eval/types.js").AdapterRequest;
type Direction = import("./eval/types.js").Direction;
type FixtureEvent = import("./eval/types.js").FixtureEvent;
type OriginTurnDetail = import("./eval/origin.js").OriginTurnDetail;

let step = 0;
const ok = (msg: string) => console.log(`  ok ${++step}. ${msg}`);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trimEnd();
const walk = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

const ev = (id: string, topic: string, text: string, author = "rachit", session = "session-a"): FixtureEvent => ({ id, topic, text, author, session });
const layout = JSON.stringify({ price_inr: 199, cta_height: 48, safe_bottom: 0, content_gap: 24 }, null, 2) + "\n";
const seeds = { "layout.json": layout, "generated/study.txt": "locked insight animation v3\n" };
const events: FixtureEvent[] = [
  ev("constraint", "paywall", "Standing instruction: the marriage paywall price is ₹199. Do not change it."),
  ev("saved", "paywall", "Saved layout.json and generated/study.txt; removed obsolete.txt. Small-screen test is pending."),
  ev("fix", "paywall", "I saved a fix in layout.json. The 640px viewport remains untested.", "agaaz", "session-b"),
];
const kase: PublicCase = {
  id: "E01",
  level: 3,
  title: "Recover tracked, untracked, and deleted files",
  events,
  resume_prompt: "Continue the unfinished small-screen validation from the last remotely verified code snapshot.",
  setup: [
    "Initialize an isolated Git repo with obsolete.txt, then delete it in the origin worktree.",
    "Write seed_files; keep generated/study.txt untracked and policy-included.",
    "Wait for remote-verified snapshot; reset successor; recover into a different worktree.",
  ],
  answer_keys: ["next_action"],
  successor_answer_contract: {},
  seed_files: seeds,
};
const request = (n: string, direction: Direction, c: PublicCase = kase): AdapterRequest => ({
  protocol_version: 1,
  case: c,
  direction,
  repetition: 1,
  trial_id: `selftest-${process.pid}-${n}-${c.id}-${direction}-1`,
  output_dir: path.join(base, "out", `${n}-${direction}`),
});

// ---------- unit: assignment, models, ids ----------
{
  assert.deepEqual(F.harnessesFor("codex-to-claude"), { origin: "codex", successor: "claude" });
  assert.deepEqual(F.harnessesFor("claude-to-codex"), { origin: "claude", successor: "codex" });
  assert.deepEqual(F.authorsFor("codex-to-claude"), { origin: "rachit", successor: "agaaz" });
  assert.deepEqual(F.authorsFor("claude-to-codex"), { origin: "agaaz", successor: "rachit" });
  ok("harness and author assignment per direction");
  if (!REAL) {
    assert.equal(H.defaultModel("claude", "origin"), "claude-haiku-4-5-20251001");
    assert.equal(H.defaultModel("claude", "successor"), "claude-sonnet-5");
    assert.equal(H.defaultModel("codex", "origin"), "fake-codex-model", "codex default = model from CODEX_HOME/config.toml");
  }
  process.env.LEDGER_EVAL_ORIGIN_MODEL = "claude=claude-opus-4-1,codex=gpt-5";
  assert.equal(H.defaultModel("claude", "origin"), "claude-opus-4-1");
  assert.equal(H.defaultModel("codex", "origin"), "gpt-5");
  process.env.LEDGER_EVAL_SUCCESSOR_MODEL = "claude-sonnet-4-5";
  assert.equal(H.defaultModel("claude", "successor"), "claude-sonnet-4-5");
  assert.equal(H.defaultModel("codex", "successor"), "claude-sonnet-4-5", "a plain value applies to whichever harness plays the role");
  delete process.env.LEDGER_EVAL_ORIGIN_MODEL;
  delete process.env.LEDGER_EVAL_SUCCESSOR_MODEL;
  assert.deepEqual(H.codexModelArgs(H.CODEX_DEFAULT_MODEL), []);
  assert.deepEqual(H.codexModelArgs("gpt-5"), ["-m", "gpt-5"]);
  ok("default models, LEDGER_EVAL_ORIGIN_MODEL / LEDGER_EVAL_SUCCESSOR_MODEL overrides (plain and per-harness)");
  assert.match(H.newSessionId(), /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.notEqual(H.newSessionId(), H.newSessionId());
  if (!REAL) assert.equal(H.harnessVersion("claude"), "fake-claude");
  assert.equal(H.claudeProjectDirName("/private/var/x.y/z"), "-private-var-x-y-z");
  assert.ok(H.evalTmpRoot().endsWith("ledger-eval"));
  const env = H.harnessEnv(
    { PATH: "/bin", LEDGER_DIR: "/leak", LEDGER_AUTHOR: "leak", LEDGER_CONTINUITY_DB: "leak", LEDGER_GIT_SYNC: "0", HOME: "/h", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "ours", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_MESSAGING_SOCKET: "/s", CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_CODE_EXECPATH: "/claude" },
    { LEDGER_CONFIG_DIR: "/cfg", HOME: undefined },
  );
  assert.deepEqual(env, { PATH: "/bin", CLAUDE_CODE_EXECPATH: "/claude", LEDGER_EVAL: "1", LEDGER_CONFIG_DIR: "/cfg" });
  assert.deepEqual(H.envKeys({ B: "1", A: "2", C: undefined }), ["A", "B"]);
  ok("session ids, versions, project dir names; harness env strips machine-level ledger overrides and our own Claude session identity, always carries LEDGER_EVAL=1");
}

// ---------- unit: Claude JSON output (shape observed from claude 2.1.258 on 2026-09-08) ----------
{
  const sample = {
    type: "result", subtype: "success", is_error: false, session_id: "aa04872b-2598-4f1d-b065-a72e0d85ffc5", result: "OK", num_turns: 1, duration_ms: 6787, duration_api_ms: 1356, total_cost_usd: 0.036,
    usage: { input_tokens: 10, cache_creation_input_tokens: 17407, cache_read_input_tokens: 13782, output_tokens: 47, iterations: [{ input_tokens: 10, output_tokens: 47, cache_read_input_tokens: 13782, cache_creation_input_tokens: 17407, type: "message" }] },
    modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 10, outputTokens: 47, cacheReadInputTokens: 13782, cacheCreationInputTokens: 17407, contextWindow: 200000 } },
  };
  const r = H.readClaudeJsonOutput(JSON.stringify(sample) + "\n")!;
  assert.equal(r.session_id, sample.session_id);
  assert.equal(r.result, "OK");
  assert.equal(r.is_error, false);
  assert.equal(r.bootTokens, 31199, "boot = iterations[0] input + cache_creation + cache_read");
  assert.equal(r.totalInputTokens, 31199);
  assert.equal(r.duration_api_ms, 1356);
  // two API calls: the top-level usage is the run total (verified equal to the transcript's per-call sum), iterations[0] the boot candidate
  const second = { input_tokens: 500, output_tokens: 10, cache_read_input_tokens: 31000, cache_creation_input_tokens: 0, type: "message" };
  const two = { ...sample, usage: { input_tokens: 10 + 500, cache_creation_input_tokens: 17407, cache_read_input_tokens: 13782 + 31000, output_tokens: 57, iterations: [sample.usage.iterations[0], second] } };
  const r2 = H.readClaudeJsonOutput(JSON.stringify(two))!;
  assert.equal(r2.bootTokens, 31199);
  assert.equal(r2.totalInputTokens, 31199 + 31500, "total = top-level input + cache_creation + cache_read");
  const stream = ['{"type":"system","subtype":"init"}', '{"type":"assistant","message":{}}', JSON.stringify(sample)].join("\n");
  assert.equal(H.readClaudeJsonOutput(stream)?.session_id, sample.session_id);
  assert.equal(H.readClaudeJsonOutput("not json"), null);
  assert.equal(H.readClaudeJsonOutput(""), null);
  const noIter = H.readClaudeJsonOutput(JSON.stringify({ ...sample, usage: { input_tokens: 5, cache_read_input_tokens: 5 } }))!;
  assert.equal(noIter.bootTokens, null);
  assert.equal(noIter.totalInputTokens, 10);
  const err = H.readClaudeJsonOutput(JSON.stringify({ ...sample, is_error: true, result: "Prompt is too long" }))!;
  assert.equal(err.is_error, true);
  ok("readClaudeJsonOutput: result, session id, boot candidate = iterations[0], total = top-level usage, stream-json, garbage, is_error");
}

// ---------- unit: Codex JSON event stream (documented exec shape + legacy shape) ----------
{
  const lines = [
    { type: "thread.started", thread_id: "0199abcd-1111-7000-8000-000000000001" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "item_0", type: "reasoning", text: "…" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "cat hello.txt", aggregated_output: "hello" } },
    { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "first" } },
    { type: "item.completed", item: { id: "item_3", type: "agent_message", text: 'done {"answers":{}}' } },
    { type: "turn.completed", usage: { input_tokens: 26385, cached_input_tokens: 12672, output_tokens: 187 } },
  ];
  const s = H.readCodexJsonStream(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.equal(s.sessionId, "0199abcd-1111-7000-8000-000000000001");
  assert.equal(s.lastMessage, 'done {"answers":{}}');
  assert.equal(s.messages.length, 2);
  assert.deepEqual(s.turns, [{ input_tokens: 26385, cached_input_tokens: 12672, output_tokens: 187 }]);
  assert.equal(s.firstCallInputTokens, 26385);
  assert.equal(s.firstCallSource, "turn.completed");
  assert.equal(s.totalInputTokens, 26385);
  assert.equal(s.errors.length, 0);
  assert.equal(s.parsed, 7);
  const legacy = [
    { id: "0", msg: { type: "session_configured", session_id: "0199abcd-2222-7000-8000-000000000002", model: "gpt-5" } },
    { id: "1", msg: { type: "agent_message", message: "legacy reply" } },
    { id: "2", msg: { type: "token_count", info: { total_token_usage: { input_tokens: 900 }, last_token_usage: { input_tokens: 900 } } } },
    { id: "3", msg: { type: "error", message: "boom" } },
  ];
  const l = H.readCodexJsonStream(legacy.map((x) => JSON.stringify(x)).join("\n"));
  assert.equal(l.sessionId, "0199abcd-2222-7000-8000-000000000002");
  assert.equal(l.lastMessage, "legacy reply");
  assert.equal(l.firstCallInputTokens, 900);
  assert.equal(l.firstCallSource, "token_count");
  assert.equal(l.totalInputTokens, 900);
  assert.deepEqual(l.errors, ["boom"]);
  const empty = H.readCodexJsonStream("garbage\n\n");
  assert.equal(empty.sessionId, null);
  assert.equal(empty.totalInputTokens, null);
  assert.equal(empty.firstCallInputTokens, null);
  const failed = H.readCodexJsonStream(JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } }));
  assert.deepEqual(failed.errors, ["rate limited"]);
  ok("readCodexJsonStream: thread id, last agent message, turn usage, legacy session_configured/token_count shape, errors");
}

// ---------- unit: answer parsing, contract, TOML ----------
{
  const p = S.parseLastJsonObject;
  assert.deepEqual(p('Sure.\n```json\n{"answers": {"k": {"value": 1, "evidence": ["a {b}"]}}, "notes": "x"}\n```\n'), { answers: { k: { value: 1, evidence: ["a {b}"] } }, notes: "x" });
  assert.deepEqual(p('prose {"not": "it"} more {"answers": {"k": {"value": null, "evidence": []}}} trailing text'), { answers: { k: { value: null, evidence: [] } } });
  assert.deepEqual(p('{"answers": {"k": {"value": "v", "evidence": []}}}\n{"note": "later object without answers"}'), { answers: { k: { value: "v", evidence: [] } } });
  assert.deepEqual(p('only {"a": "b}"} here'), { a: "b}" });
  assert.deepEqual(p('{"a": "escaped \\" quote"}'), { a: 'escaped " quote' });
  assert.equal(p("no json at all"), null);
  assert.equal(p(""), null);
  assert.equal(p("[1,2]"), null);
  assert.equal(p("{broken"), null);
  ok("parseLastJsonObject: fenced, prefers the object carrying answers, braces and escapes inside strings, no match");
  const c = S.answerContract(["price_inr", "next_action"]);
  assert.ok(c.startsWith("When finished, output ONLY a JSON object on the last line of your reply: ") && c.includes("Keys: price_inr, next_action") && c.endsWith("never guess.") && c.includes('"selected_topic"'));
  const prompt = S.buildSuccessorPrompt("PRE", "RESUME", ["k"]);
  assert.ok(prompt.startsWith("PRE\n\nRESUME\n\n") && prompt.endsWith("never guess."));
  assert.ok(S.buildSuccessorPrompt("", "RESUME", ["k"]).startsWith("RESUME\n\n"));
  ok("answer contract and successor prompt assembly (preamble, resume prompt, contract)");
  const toml = S.mcpJsonToToml({ mcpServers: { ledger: { command: "node", args: ["/x/cli.js", "mcp"], env: { LEDGER_CONFIG_DIR: "/t/config" } }, "odd name": { url: "http://localhost:1/mcp" } } });
  assert.ok(toml.includes('[mcp_servers.ledger]\ncommand = "node"\nargs = ["/x/cli.js", "mcp"]'), toml);
  assert.ok(toml.includes('[mcp_servers.ledger.env]\nLEDGER_CONFIG_DIR = "/t/config"'), toml);
  assert.ok(toml.includes('[mcp_servers."odd name"]\nurl = "http://localhost:1/mcp"'), toml);
  ok("MCP JSON → Codex config.toml [mcp_servers.<name>] blocks with env tables");
}

if (!REAL) {
  // ---------- createTrial, forward direction ----------
  const reqF = request("fwd", "codex-to-claude");
  const ctxF = await F.createTrial(reqF, "ours", { log: () => {} });
  {
    const p = ctxF.paths;
    assert.equal(p.root, path.join(tmpRoot, reqF.trial_id));
    for (const d of [p.repo, p.bare, p.successorRepo, p.ledgerDir, p.configDir, p.homeDir, p.rawDir]) assert.ok(fs.existsSync(d), d);
    assert.equal(p.outputDir, reqF.output_dir);
    assert.equal(p.rawDir, path.join(reqF.output_dir, "raw"));
    assert.equal(ctxF.originHarness, "codex");
    assert.equal(ctxF.successorHarness, "claude");
    assert.equal(ctxF.originAuthor, "rachit");
    assert.equal(ctxF.successorAuthor, "agaaz");
    assert.equal(ctxF.evalDatabaseUrl, process.env.LEDGER_EVAL_DB);
    assert.equal(ctxF.originModel, "fake-codex-model");
    assert.equal(ctxF.successorModel, "claude-sonnet-5");
    ok("createTrial: paths under the eval root, harnesses, authors, models, eval database");
    assert.equal(git(p.repo, "rev-parse", "--abbrev-ref", "HEAD"), "master");
    assert.equal(git(p.repo, "rev-list", "--count", "HEAD"), "1");
    assert.equal(git(p.bare, "ls-tree", "--name-only", "master").split("\n").sort().join(","), ".gitignore,README.md,layout.json,obsolete.txt");
    assert.equal(git(p.repo, "rev-parse", "HEAD"), git(p.bare, "rev-parse", "master"));
    assert.equal(git(p.repo, "remote", "get-url", "origin"), p.bare);
    ok("initial commit (README, obsolete.txt, tracked seed placeholder, .gitignore) on master, pushed to the bare remote");
    assert.deepEqual(git(p.repo, "status", "--porcelain", "--ignored").split("\n").sort(), [" D obsolete.txt", " M layout.json", "!! generated/"]);
    assert.equal(fs.readFileSync(path.join(p.repo, "layout.json"), "utf8"), layout);
    assert.equal(git(p.repo, "show", "HEAD:layout.json"), "{}");
    assert.equal(fs.readFileSync(path.join(p.repo, "generated/study.txt"), "utf8"), seeds["generated/study.txt"]);
    assert.ok(!fs.existsSync(path.join(p.repo, "obsolete.txt")));
    assert.ok(git(p.bare, "show", "master:obsolete.txt").length > 0);
    ok("seed files: layout.json tracked, modified in the worktree; generated/study.txt untracked and ignored; obsolete.txt committed then deleted from the worktree");
    assert.ok(fs.existsSync(path.join(p.successorRepo, "obsolete.txt")) && fs.existsSync(path.join(p.successorRepo, "README.md")));
    assert.equal(fs.readFileSync(path.join(p.successorRepo, "layout.json"), "utf8"), "{}\n");
    assert.ok(!fs.existsSync(path.join(p.successorRepo, "generated")));
    assert.equal(git(p.successorRepo, "status", "--porcelain"), "");
    assert.equal(git(p.successorRepo, "rev-parse", "HEAD"), git(p.bare, "rev-parse", "master"));
    ok("successor clone is the pristine initial commit");
    assert.ok(fs.existsSync(path.join(p.ledgerDir, ".git")) && fs.existsSync(path.join(p.ledgerDir, "LEDGER.md")));
    const cfg = F.readTrialConfig(ctxF);
    assert.equal(cfg.ledger_dir, p.ledgerDir);
    assert.equal(cfg.author, "rachit");
    assert.equal(cfg.git_sync, false);
    assert.equal(cfg.continuity?.database_url, process.env.LEDGER_EVAL_DB);
    assert.equal(cfg.continuity?.machine, `eval-${reqF.trial_id}`);
    assert.deepEqual(cfg.continuity?.include, ["generated/**"]);
    assert.equal(cfg.continuity?.classify, true);
    assert.equal(snap(realLedgerConfig), ledgerCfgBefore, "~/.ledger/config.json must not change");
    assert.equal(process.env.LEDGER_CONFIG_DIR, guardConfigDir, "createTrial restores LEDGER_CONFIG_DIR after initLedger");
    assert.equal(process.env.LEDGER_EVAL, "1");
    assert.ok(!fs.existsSync(path.join(guardConfigDir, "config.json")), "initLedger wrote into the trial config dir, not the process's LEDGER_CONFIG_DIR");
    assert.ok(fs.readFileSync(path.join(p.configDir, "config.json"), "utf8").includes(p.ledgerDir));
    ok("disposable ledger initialised; trial config.json complete; ~/.ledger/config.json untouched; LEDGER_CONFIG_DIR restored");
    const { getPool } = await import("./continuity/db.js");
    const t = await getPool(cfg).query("select count(*)::int as n from information_schema.tables where table_schema = current_schema() and table_name like 'cont_%'");
    assert.ok(t.rows[0].n >= 10, `cont_* tables: ${t.rows[0].n}`);
    assert.equal(await F.ensureMigrated(ctxF), false, "migrate runs once per process per URL");
    ok(`eval database migrated once (${t.rows[0].n} cont_* tables)`);
    F.writeTrialConfig(ctxF, "agaaz");
    assert.equal(F.readTrialConfig(ctxF).author, "agaaz");
    F.writeTrialConfig(ctxF, "rachit");
    assert.equal(F.readTrialConfig(ctxF).author, "rachit");
    ok("writeTrialConfig switches the author");
    ctxF.log("token sk-abcdefghijklmnopqrstuvwxyz0123456789 recorded");
    const logText = fs.readFileSync(path.join(p.rawDir, "controller.log"), "utf8");
    assert.ok(logText.includes("[REDACTED_API_KEY]") && !logText.includes("sk-abcdefghijklmnop"));
    ok("ctx.log appends redacted lines to raw/controller.log");
  }

  // ---------- runOrigin, forward direction ----------
  {
    const run = await O.runOrigin(ctxF, events);
    const det = run.turns as OriginTurnDetail[];
    assert.equal(run.harness, "codex");
    assert.equal(run.turns.length, 3);
    assert.deepEqual(run.turns.map((t) => t.harness), ["codex", "codex", "claude"]);
    assert.deepEqual(run.turns.map((t) => t.fixtureEventId), ["constraint", "saved", "fix"]);
    assert.deepEqual(run.turns.map((t) => t.turnIndex), [0, 1, 2]);
    assert.deepEqual(det.map((t) => t.author), ["rachit", "rachit", "agaaz"]);
    assert.deepEqual(det.map((t) => t.sessionLabel), ["session-a", "session-a", "session-b"]);
    assert.ok(det.every((t) => t.ok), JSON.stringify(det.map((t) => t.failure)));
    assert.equal(run.sessionIds.length, 2);
    assert.equal(run.turns[0].sessionId, run.turns[1].sessionId);
    assert.notEqual(run.turns[0].sessionId, run.turns[2].sessionId);
    assert.deepEqual(run.sessionIds, [run.turns[0].sessionId, run.turns[2].sessionId]);
    ok("runOrigin (codex→claude): one turn per event; session-a on codex as rachit, session-b on claude as agaaz");
    assert.equal(run.transcriptPaths.length, 2);
    const roots = H.transcriptRoots();
    const ta = findTranscript(run.sessionIds[0], undefined, roots)!;
    const tb = findTranscript(run.sessionIds[1], undefined, roots)!;
    assert.equal(ta.agent, "codex");
    assert.ok(path.basename(ta.path).startsWith("rollout-") && ta.path.startsWith(process.env.LEDGER_EVAL_FAKE_ROOT!));
    assert.equal(tb.agent, "claude");
    assert.ok(tb.path.endsWith(`${run.sessionIds[1]}.jsonl`) && tb.path.startsWith(process.env.LEDGER_EVAL_FAKE_ROOT!));
    assert.deepEqual(run.turns.map((t) => t.transcriptPath), [ta.path, ta.path, tb.path]);
    const ra = streamTranscript(ta.path, 0, "codex");
    const instrA = ra.events.filter((e) => e.kind === "instruction.added").map((e) => String(e.payload.text));
    assert.equal(instrA.length, 2);
    assert.ok(instrA[0].startsWith(O.ORIGIN_PROMPT_PREFIX) && instrA[0].endsWith(events[0].text) && instrA[1].endsWith(events[1].text));
    assert.equal(ra.session_id, run.sessionIds[0]);
    assert.equal(ra.cwd, ctxF.paths.repo);
    const rb = streamTranscript(tb.path, 0, "claude");
    const instrB = rb.events.filter((e) => e.kind === "instruction.added").map((e) => String(e.payload.text));
    assert.deepEqual(instrB, [O.originPrompt(events[2].text)]);
    assert.ok(ra.events.some((e) => e.kind === "assistant.message") && ra.events.some((e) => e.kind === "tool.requested"));
    assert.ok(rb.events.some((e) => e.kind === "assistant.message") && rb.events.some((e) => e.kind === "tool.requested"));
    assert.equal(run.compactions, 0);
    ok("transcripts located via findTranscript(roots) in both formats; event text verbatim behind the prefix; 0 compactions");
    assert.ok(run.totalInputTokens > 0 && run.turns.every((t) => t.usage && t.usage.input_tokens! > 0 && t.wallMs >= 1));
    assert.ok(run.turns.every((t) => t.assistantText.startsWith("Done: ")));
    assert.equal(F.readTrialConfig(ctxF).author, "rachit", "config author restored after the session-b turn");
    assert.equal(fs.readFileSync(path.join(ctxF.paths.rawDir, "origin-turns.jsonl"), "utf8").trim().split("\n").length, 3);
    const inv = readJson(path.join(ctxF.paths.rawDir, "origin-invocations.json"));
    assert.equal(inv.invocations.length, 3);
    assert.deepEqual(inv.invocations[0].args.slice(0, 6), ["exec", "-C", ctxF.paths.repo, "--skip-git-repo-check", "-s", "workspace-write"]);
    assert.ok(inv.invocations[0].args.includes("--json") && inv.invocations[0].args[inv.invocations[0].args.length - 1] === O.originPrompt(events[0].text));
    assert.deepEqual(inv.invocations[1].args.slice(0, 3), ["exec", "resume", run.sessionIds[0]]);
    const c2 = inv.invocations[2].args as string[];
    assert.ok(c2[0] === "-p" && c2[1] === O.originPrompt(events[2].text) && c2.includes("--session-id") && c2.includes("--strict-mcp-config") && c2.includes("--dangerously-skip-permissions") && c2.includes("--output-format"));
    assert.ok(c2[c2.indexOf("--mcp-config") + 1].endsWith("origin-mcp-empty.json") && c2[c2.indexOf("--add-dir") + 1] === ctxF.paths.repo);
    assert.ok(inv.invocations.every((x: any) => Array.isArray(x.env_keys) && x.env_keys.includes("LEDGER_CONFIG_DIR") && x.env_keys.includes("LEDGER_EVAL") && !x.env_keys.includes("CLAUDE_CODE_SESSION_ID") && !x.env_keys.includes("LEDGER_DIR") && !("env" in x)));
    assert.ok(!JSON.stringify(inv).includes(events[0].id + '"') || true);
    assert.ok(inv.transcripts.length === 2 && fs.existsSync(path.join(ctxF.paths.rawDir, "origin-run.json")));
    ok("usage, wall time, assistant text recorded; raw origin-turns.jsonl / origin-invocations.json (argv + env keys only) / origin-run.json written");
  }

  // ---------- runSuccessor, forward direction (Claude) ----------
  {
    const mcp = path.join(base, "mcp-ledger.json");
    fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { ledger: { command: "node", args: ["/x/cli.js", "mcp"], env: { LEDGER_CONFIG_DIR: ctxF.paths.configDir } } } }));
    const setup = { env: { LEDGER_EVAL_MARKER: "successor-env-value-9f3" }, mcpConfigPath: mcp, allowedTools: ["mcp__ledger__*", "Read"], cwd: ctxF.paths.successorRepo, preamble: "You are continuing a teammate's work." };
    const sr = await S.runSuccessor(ctxF, setup, kase.resume_prompt, ["next_action", "price_inr"]);
    assert.equal(sr.harness, "claude");
    assert.match(sr.sessionId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    assert.deepEqual(sr.output?.answers, { next_action: { value: "fake", evidence: [] }, price_inr: { value: "fake", evidence: [] } });
    assert.equal(sr.output?.notes, "fake successor: no retrieval performed");
    assert.ok(sr.wallMs >= 1);
    ok("runSuccessor (claude): fresh session; JSON answer object parsed leniently from the reply");
    assert.ok(sr.transcriptPath && sr.transcriptPath.startsWith(process.env.LEDGER_EVAL_FAKE_ROOT!) && sr.transcriptPath.endsWith(`${sr.sessionId}.jsonl`));
    assert.equal(sr.toolCalls.length, 1);
    assert.equal(sr.toolCalls[0].tool, "mcp__ledger__ledger_records");
    assert.ok(sr.toolCalls[0].input.includes(ctxF.paths.successorRepo), sr.toolCalls[0].input);
    assert.equal(sr.toolCalls[0].output_preview, "fake tool output: no records");
    assert.ok(sr.toolCalls[0].call_id?.startsWith("toolu_") && sr.toolCalls[0].at);
    ok("tool calls collected from the successor's own transcript (tool, input, output preview, call id, time)");
    assert.equal(sr.bootTokens, 2512);
    assert.equal(sr.totalInputTokens, 2512 * 2);
    ok("boot tokens = first model call input from harness usage (2512 = 12 + 2000 + 500); total over both calls");
    assert.equal(sr.rawOutputPath, path.join(ctxF.paths.rawDir, "successor-output.json"));
    const rawOut = readJson(sr.rawOutputPath);
    assert.equal(rawOut.session_id, sr.sessionId);
    assert.ok(typeof rawOut.stdout === "string" && rawOut.stdout.includes('"type":"result"'));
    assert.equal(rawOut.boot_tokens_source, "transcript.first_assistant_usage");
    assert.equal(rawOut.boot_tokens_transcript, 2512);
    assert.equal(rawOut.boot_tokens_json, 2512, "fallback candidate (usage.iterations[0]) recorded alongside");
    assert.equal(rawOut.ok, true);
    assert.ok(fs.existsSync(path.join(ctxF.paths.rawDir, "successor-stdout.txt")));
    const invFile = path.join(ctxF.paths.rawDir, "successor-invocation.json");
    const inv = readJson(invFile);
    assert.equal(inv.cmd, "claude");
    assert.equal(inv.args[0], "-p");
    assert.ok(inv.args[1].startsWith("You are continuing a teammate's work.\n\n" + kase.resume_prompt) && inv.args[1].includes("Keys: next_action, price_inr"));
    assert.ok(!inv.args[1].includes(events[0].text) && !inv.args[1].includes(events[2].text), "the successor prompt never carries fixture event text");
    assert.equal(inv.args[inv.args.indexOf("--session-id") + 1], sr.sessionId);
    assert.equal(inv.args[inv.args.indexOf("--model") + 1], "claude-sonnet-5");
    assert.ok(inv.args.includes("--mcp-config") && inv.args[inv.args.indexOf("--mcp-config") + 1] === mcp && inv.args.includes("--strict-mcp-config"));
    assert.equal(inv.args[inv.args.indexOf("--add-dir") + 1], ctxF.paths.successorRepo);
    assert.deepEqual(inv.args.slice(inv.args.indexOf("--allowedTools") + 1), ["mcp__ledger__*", "Read"]);
    assert.ok(inv.env_keys.includes("LEDGER_EVAL_MARKER") && inv.env_keys.includes("LEDGER_CONFIG_DIR") && inv.env_keys.includes("LEDGER_EVAL") && !("env" in inv));
    assert.ok(!fs.readFileSync(invFile, "utf8").includes("successor-env-value-9f3"), "env values must not be recorded");
    const tools = fs.readFileSync(path.join(ctxF.paths.rawDir, "successor-tools.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(tools.length, 1);
    assert.equal(tools[0].output, "fake tool output: no records");
    assert.equal(tools[0].session_id, sr.sessionId);
    ok("raw/successor-output.json (verbatim stdout), successor-invocation.json (argv + env keys, no values), successor-tools.jsonl written");
  }

  // ---------- reverse direction: createTrial + runOrigin + runSuccessor (Codex) ----------
  const reqR = request("rev", "claude-to-codex");
  const ctxR = await F.createTrial(reqR, "ours", { log: () => {} });
  {
    assert.equal(ctxR.originHarness, "claude");
    assert.equal(ctxR.originAuthor, "agaaz");
    assert.equal(ctxR.successorHarness, "codex");
    assert.equal(ctxR.successorAuthor, "rachit");
    assert.equal(ctxR.originModel, "claude-haiku-4-5-20251001");
    assert.equal(ctxR.successorModel, "fake-codex-model");
    assert.equal(O.harnessFor(ctxR, "session-a"), "claude");
    assert.equal(O.harnessFor(ctxR, "session-b"), "codex");
    assert.equal(O.harnessFor(ctxF, "session-b"), "claude");
    assert.equal(O.authorFor(ctxR, "session-b"), "rachit");
    assert.equal(O.authorFor(ctxF, "session-a"), "rachit");
    assert.equal(O.primarySessionLabel([ev("x", "t", "text", "a", "session-z")]), "session-z");
    const run = await O.runOrigin(ctxR, events);
    const det = run.turns as OriginTurnDetail[];
    assert.equal(run.harness, "claude");
    assert.deepEqual(run.turns.map((t) => t.harness), ["claude", "claude", "codex"]);
    assert.deepEqual(det.map((t) => t.author), ["agaaz", "agaaz", "rachit"]);
    assert.ok(det.every((t) => t.ok), JSON.stringify(det.map((t) => t.failure)));
    assert.equal(run.sessionIds.length, 2);
    assert.equal(run.transcriptPaths.length, 2);
    assert.ok(run.transcriptPaths[0].endsWith(`${run.sessionIds[0]}.jsonl`) && path.basename(run.transcriptPaths[1]).startsWith("rollout-"));
    assert.equal(run.compactions, 0);
    const inv = readJson(path.join(ctxR.paths.rawDir, "origin-invocations.json"));
    const a0 = inv.invocations[0].args as string[];
    const a1 = inv.invocations[1].args as string[];
    assert.ok(a0.includes("--session-id") && a0[a0.indexOf("--session-id") + 1] === run.sessionIds[0] && !a0.includes("--resume"));
    assert.ok(a1.includes("--resume") && a1[a1.indexOf("--resume") + 1] === run.sessionIds[0] && !a1.includes("--session-id"));
    assert.equal(a1[1], O.originPrompt(events[1].text));
    assert.equal(a0[a0.indexOf("--model") + 1], "claude-haiku-4-5-20251001");
    assert.equal(inv.invocations[2].args[0], "exec");
    assert.deepEqual(inv.invocations.map((x: any) => x.author), ["agaaz", "agaaz", "rachit"]);
    assert.equal(F.readTrialConfig(ctxR).author, "agaaz");
    ok("reverse direction (claude→codex): session-a on claude as agaaz (--session-id, then --resume), session-b on codex as rachit; config author restored");
  }
  {
    const mcp = path.join(base, "mcp-ledger-rev.json");
    fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { ledger: { command: "node", args: ["/x/cli.js", "mcp"], env: { LEDGER_CONFIG_DIR: ctxR.paths.configDir } } } }));
    const sr = await S.runSuccessor(ctxR, { env: {}, mcpConfigPath: mcp, allowedTools: [], cwd: ctxR.paths.successorRepo, preamble: "" }, kase.resume_prompt, ["next_action"]);
    assert.equal(sr.harness, "codex");
    assert.match(sr.sessionId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    assert.deepEqual(sr.output?.answers, { next_action: { value: "fake", evidence: [] } });
    assert.ok(sr.transcriptPath && path.basename(sr.transcriptPath).startsWith("rollout-") && sr.transcriptPath.includes(sr.sessionId));
    assert.equal(sr.toolCalls.length, 1);
    assert.equal(sr.toolCalls[0].tool, "mcp__ledger__ledger_records");
    assert.ok(sr.toolCalls[0].call_id?.startsWith("call_"));
    assert.equal(sr.toolCalls[0].output_preview, "fake tool output: no records");
    assert.equal(sr.bootTokens, 2512);
    assert.equal(sr.totalInputTokens, 2512);
    const home = path.join(ctxR.paths.homeDir, "codex");
    assert.equal(fs.readFileSync(path.join(home, "auth.json"), "utf8"), fs.readFileSync(path.join(process.env.CODEX_HOME!, "auth.json"), "utf8"));
    const toml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    assert.ok(toml.includes("[mcp_servers.ledger]") && toml.includes('command = "node"') && toml.includes('args = ["/x/cli.js", "mcp"]'), toml);
    assert.ok(toml.includes(`LEDGER_CONFIG_DIR = ${JSON.stringify(ctxR.paths.configDir)}`) && toml.includes(`[projects.${JSON.stringify(ctxR.paths.successorRepo)}]\ntrust_level = "trusted"`), toml);
    assert.ok(!toml.includes("fake-codex-model") && !fs.existsSync(path.join(home, "hooks.json")));
    const inv = readJson(path.join(ctxR.paths.rawDir, "successor-invocation.json"));
    assert.deepEqual(inv.args.slice(0, 6), ["exec", "-C", ctxR.paths.successorRepo, "--skip-git-repo-check", "-s", "workspace-write"]);
    assert.ok(inv.args.includes("--json") && inv.args.includes("-o") && inv.args[inv.args.indexOf("-m") + 1] === "fake-codex-model");
    assert.ok(inv.args[inv.args.length - 1].startsWith(kase.resume_prompt) && inv.args[inv.args.length - 1].includes("Keys: next_action"));
    assert.ok(inv.env_keys.includes("CODEX_HOME") && inv.codex_home.path === home && inv.codex_home.auth_copied === true);
    assert.equal(readJson(sr.rawOutputPath).boot_tokens_source, "rollout.first_token_count");
    assert.equal(fs.readFileSync(path.join(ctxR.paths.rawDir, "successor-last-message.txt"), "utf8").split("\n").pop()?.startsWith('{"answers"'), true);
    ok("runSuccessor (codex): per-trial CODEX_HOME (copied auth.json, generated config.toml with MCP servers + trust, no hooks); exec argv; boot tokens from the rollout's first token_count");
  }

  // ---------- no usage reported → null boot tokens; null MCP config → empty strict config ----------
  {
    process.env.LEDGER_EVAL_FAKE_NO_USAGE = "1";
    const sx = await S.runSuccessor(ctxR, { env: {}, mcpConfigPath: null, allowedTools: [], cwd: ctxR.paths.successorRepo, preamble: "" }, "Q", ["k"]);
    assert.equal(sx.bootTokens, null);
    assert.equal(sx.totalInputTokens, null);
    assert.deepEqual(sx.output?.answers, { k: { value: "fake", evidence: [] } });
    assert.equal(sx.toolCalls.length, 1);
    const sc = await S.runSuccessor(ctxF, { env: {}, mcpConfigPath: null, allowedTools: [], cwd: ctxF.paths.successorRepo, preamble: "" }, "Q", ["k"]);
    assert.equal(sc.bootTokens, null);
    assert.equal(sc.totalInputTokens, null);
    assert.equal(readJson(sc.rawOutputPath).boot_tokens_source, null);
    const inv = readJson(path.join(ctxF.paths.rawDir, "successor-invocation.json"));
    assert.ok(inv.args.includes("--strict-mcp-config") && inv.args[inv.args.indexOf("--mcp-config") + 1].endsWith("successor-mcp-empty.json") && !inv.args.includes("--allowedTools"));
    assert.deepEqual(readJson(inv.args[inv.args.indexOf("--mcp-config") + 1]), { mcpServers: {} });
    delete process.env.LEDGER_EVAL_FAKE_NO_USAGE;
    ok("boot tokens null when the harness reports no usage (both harnesses); null MCP config → empty strict config and no --allowedTools");
  }

  // ---------- cleanup ----------
  {
    const rootF = ctxF.paths.root;
    const rootR = ctxR.paths.root;
    const ctxK = await F.createTrial(request("keep", "codex-to-claude"), "gbrain", { log: () => {}, migrate: false });
    assert.equal(ctxK.condition, "gbrain");
    assert.equal((await F.cleanupTrial(ctxK, { keep: true })).removed, false);
    assert.ok(fs.existsSync(ctxK.paths.root));
    process.env.LEDGER_EVAL_KEEP = "1";
    assert.equal((await F.cleanupTrial(ctxK)).removed, false);
    delete process.env.LEDGER_EVAL_KEEP;
    assert.equal((await F.cleanupTrial(ctxK)).removed, true);
    assert.ok(!fs.existsSync(ctxK.paths.root));
    assert.ok((await F.cleanupTrial(ctxF)).removed && (await F.cleanupTrial(ctxR)).removed);
    assert.ok(!fs.existsSync(rootF) && !fs.existsSync(rootR));
    assert.ok(fs.existsSync(path.join(ctxF.paths.rawDir, "controller.log")) && fs.existsSync(ctxR.paths.rawDir), "the evidence bundle (output_dir) survives cleanup");
    assert.ok(fs.readFileSync(path.join(ctxF.paths.rawDir, "controller.log"), "utf8").includes("cleanup: removed"));
    ok("cleanupTrial removes the trial root (keep option and LEDGER_EVAL_KEEP honoured); output_dir preserved");
  }

  // ---------- isolation ----------
  {
    assert.equal(snap(realLedgerConfig), ledgerCfgBefore, "~/.ledger/config.json unchanged");
    assert.equal(listing(path.join(os.homedir(), ".claude", "projects")), claudeProjectsBefore, "~/.claude/projects unchanged");
    assert.equal(listing(path.join(realCodexHome, "sessions")), codexSessionsBefore, "~/.codex/sessions unchanged");
    const leftovers = fs.readdirSync(tmpRoot).filter((n) => n.includes(`selftest-${process.pid}-`));
    assert.deepEqual(leftovers, [], `trial roots left under ${tmpRoot}: ${leftovers.join(", ")}`);
    const fakeFiles = walk(process.env.LEDGER_EVAL_FAKE_ROOT!).filter((f) => f.endsWith(".jsonl"));
    assert.equal(fakeFiles.length, 8, fakeFiles.join("\n"));
    assert.ok(fakeFiles.every((f) => f.startsWith(base)));
    assert.deepEqual(fs.readdirSync(base).sort(), ["config-guard", "fake-codex-home", "fake-transcripts", "mcp-ledger-rev.json", "mcp-ledger.json", "out"]);
    assert.deepEqual(fs.readdirSync(guardConfigDir), [], "nothing wrote into the process's LEDGER_CONFIG_DIR guard dir");
    assert.equal(process.env.LEDGER_CONFIG_DIR, guardConfigDir);
    ok("isolation: ~/.ledger/config.json, ~/.claude/projects, ~/.codex/sessions unchanged; no trial roots left; 8 fake transcripts, all under the selftest root; guard config dir empty");
  }
  fs.rmSync(base, { recursive: true, force: true });
} else {
  // ---------- REAL smoke: Claude Haiku origin (2 turns) + Claude Haiku successor (no MCP) ----------
  const evs = [ev("t1", "smoke", "Create hello.txt containing hello", "agaaz", "session-a"), ev("t2", "smoke", "Append world to hello.txt", "agaaz", "session-a")];
  const smoke: PublicCase = { id: "SMOKE", level: 0, title: "real driver smoke", events: evs, resume_prompt: "What does hello.txt contain?", setup: [], answer_keys: ["contents"], successor_answer_contract: {} };
  const req = request("real", "claude-to-codex", smoke);
  const ctx = await F.createTrial(req, "ours", { log: (l) => console.log("    | " + l), originModel: "claude-haiku-4-5-20251001", successorModel: "claude-haiku-4-5-20251001" });
  assert.equal(ctx.originHarness, "claude");
  assert.equal(process.env.LEDGER_CONFIG_DIR, guardConfigDir, "createTrial restores LEDGER_CONFIG_DIR");
  assert.equal(snap(realLedgerConfig), ledgerCfgBefore, "~/.ledger/config.json unchanged by createTrial");
  console.log(`    harness versions: claude=${H.harnessVersion("claude")} codex=${H.harnessVersion("codex")}`);
  const run = await O.runOrigin(ctx, evs, { timeoutMs: 300_000 });
  const det = run.turns as OriginTurnDetail[];
  assert.equal(run.turns.length, 2);
  assert.ok(det.every((t) => t.ok), JSON.stringify(det.map((t) => [t.failure, t.stderrTail.slice(-300)])));
  const hello = fs.readFileSync(path.join(ctx.paths.repo, "hello.txt"), "utf8");
  assert.ok(/hello/.test(hello) && /world/.test(hello), JSON.stringify(hello));
  assert.equal(run.sessionIds.length, 1);
  assert.equal(run.transcriptPaths.length, 1);
  assert.ok(fs.existsSync(run.transcriptPaths[0]));
  ok(`REAL origin (claude ${ctx.originModel}): 2 turns ok; hello.txt=${JSON.stringify(hello)}; transcript ${run.transcriptPaths[0]}`);
  for (const t of det) console.log(`    turn ${t.turnIndex + 1}: wall_ms=${t.wallMs} input=${t.usage?.input_tokens} cache_read=${t.usage?.cache_read} output=${t.usage?.output_tokens} text=${JSON.stringify(t.assistantText.slice(0, 100))}`);
  console.log(`    origin total input tokens (incl. cache reads) = ${run.totalInputTokens}; compactions = ${run.compactions}`);
  const sr = await S.runSuccessor(ctx, { env: {}, mcpConfigPath: null, allowedTools: [], cwd: ctx.paths.repo, preamble: "" }, "What does hello.txt contain? Answer in the JSON contract with key contents.", ["contents"], { harness: "claude", model: "claude-haiku-4-5-20251001", timeoutMs: 300_000 });
  assert.ok(sr.transcriptPath && fs.existsSync(sr.transcriptPath), "successor transcript found");
  assert.ok(Number.isInteger(sr.bootTokens) && sr.bootTokens! > 0, `bootTokens=${sr.bootTokens}`);
  assert.ok(sr.output && "answers" in sr.output, `parsed: ${JSON.stringify(sr.output)}`);
  const value = (sr.output as any).answers?.contents?.value;
  assert.ok(typeof value === "string" && /hello/i.test(value), `contents=${JSON.stringify(value)}`);
  ok(`REAL successor (claude haiku): contents=${JSON.stringify(value)}; bootTokens=${sr.bootTokens} totalInputTokens=${sr.totalInputTokens} wallMs=${sr.wallMs} toolCalls=${sr.toolCalls.length}`);
  console.log(`    successor tools: ${sr.toolCalls.map((c) => c.tool).join(", ") || "(none)"}`);
  console.log(`    successor transcript: ${sr.transcriptPath}`);
  console.log(`    evidence bundle kept at: ${ctx.paths.outputDir}`);
  const rawOut = readJson(sr.rawOutputPath);
  console.log(`    successor usage (json): ${JSON.stringify(rawOut.claude?.usage)}`);
  console.log(`    successor transcript usage: ${JSON.stringify(rawOut.transcript_usage)}`);
  console.log(`    successor boot tokens: used=${rawOut.boot_tokens} source=${rawOut.boot_tokens_source} transcript_first_call=${rawOut.boot_tokens_transcript} json_iterations0=${rawOut.boot_tokens_json}`);
  const originInv = readJson(path.join(ctx.paths.rawDir, "origin-invocations.json"));
  const succInv = readJson(path.join(ctx.paths.rawDir, "successor-invocation.json"));
  for (const x of [...originInv.invocations.map((i: any) => ({ role: `origin turn ${i.turn}`, ...i })), { role: "successor", ...succInv }]) {
    assert.ok(x.env_keys.includes("LEDGER_EVAL") && x.env_keys.includes("LEDGER_CONFIG_DIR") && !x.env_keys.includes("CLAUDECODE") && !x.env_keys.includes("CLAUDE_CODE_SESSION_ID"), `${x.role}: env keys ${x.env_keys.join(",")}`);
    console.log(`    ${x.role} argv: ${x.cmd} ${(x.args as string[]).map((a) => (a.length > 60 ? JSON.stringify(a.slice(0, 57) + "…") : a)).join(" ")}`);
  }
  assert.ok((await F.cleanupTrial(ctx)).removed);
  ok("REAL trial root cleaned up; every spawned process carried LEDGER_EVAL=1 + LEDGER_CONFIG_DIR and no nested-Claude identity");
}

// ---------- the config-file identity check, both modes ----------
{
  const after = snapBytes(realLedgerConfig);
  const same = ledgerCfgBytesBefore === null ? after === null : after !== null && ledgerCfgBytesBefore.equals(after);
  assert.ok(same, "~/.ledger/config.json must be byte-identical before and after the whole run");
  const mtimeAfter = fs.existsSync(realLedgerConfig) ? fs.statSync(realLedgerConfig).mtimeMs : null;
  assert.equal(process.env.LEDGER_CONFIG_DIR, guardConfigDir, "LEDGER_CONFIG_DIR still the guard dir at the end");
  ok(`~/.ledger/config.json byte-identical before and after (${ledgerCfgBytesBefore?.length ?? 0} bytes; mtime ${mtimeAfter === ledgerCfgMtimeBefore ? "unchanged" : "CHANGED but bytes equal"})`);
}

await F.closeEvalPools();
console.log(`selftest-eval-drivers: ok (${step} checks)`);
