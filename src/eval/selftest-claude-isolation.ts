import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { claudeClassifierArgs, claudeIsolationArgs } from "./claude-isolation.js";
import { claudeOriginArgs } from "./origin.js";
import { answerContract, claudeSuccessorArgs } from "./successor.js";
import { explicitStartupBrief } from "./conditions/ours.js";
import { freezeLedgerGuide, GLOBAL_GUIDE_POINTER, localizeBriefGuide } from "./ledger-guide.js";
import { evalTmpRoot, harnessEnv, newSessionId, spawnHarness, writeJson } from "./harness.js";
import type { TrialContext } from "./types.js";

if (process.argv.includes("--fixture-mcp")) {
  const mcp = new McpServer({ name: "isolation-fixture", version: "1" });
  mcp.registerTool("fixture_ping", { description: "An explicit trial-only tool used by an offline isolation test." }, async () => ({ content: [{ type: "text", text: "fixture pong" }] }));
  await mcp.connect(new StdioServerTransport());
} else {
  process.env.LEDGER_EVAL = "1";
  fs.mkdirSync(evalTmpRoot(), { recursive: true });
  const root = fs.mkdtempSync(path.join(evalTmpRoot(), "claude-isolation-selftest-"));
  const configDir = path.join(root, "ledger-config");
  fs.mkdirSync(configDir);
  process.env.LEDGER_CONFIG_DIR = configDir;
  let step = 0;
  const ok = (message: string) => console.log(`ok ${++step}. ${message}`);
  const checkArgs = (args: string[]) => {
    assert.equal(args[args.indexOf("--setting-sources") + 1], "");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    assert.equal(settings.disableAllHooks, true);
    assert.equal(settings.autoMemoryEnabled, false);
    assert.deepEqual(settings.claudeMdExcludes, ["**"]);
    assert.ok(args.includes("--disable-slash-commands"));
    assert.ok(args.includes("--strict-mcp-config"));
    assert.ok(!args.includes("--bare") && !args.includes("--safe-mode"), "retain subscription auth and explicit MCP");
  };
  try {
    checkArgs(claudeOriginArgs("origin", newSessionId(), false, "fixture-model", root, "fixture.json"));
    checkArgs(claudeOriginArgs("origin-without-mcp", newSessionId(), false, "fixture-model", root, null));
    checkArgs(claudeOriginArgs("third", newSessionId(), true, "fixture-model", root, "fixture.json", ["Bash", "Read"]));
    checkArgs(claudeSuccessorArgs("successor", newSessionId(), "fixture-model", root, "condition-mcp.json", ["mcp__ledger__*"]));
    checkArgs(claudeClassifierArgs("empty-mcp.json"));
    assert.equal(answerContract(["price_inr"]).includes("199"), false);
    ok("all Claude roles disable hooks/settings/memory/skills while retaining auth and explicit MCP; answer contract has no expected numeric example");

    const fakeBuild = path.join(root, "frozen-build");
    fs.mkdirSync(path.join(fakeBuild, "continuity"), { recursive: true });
    const guideSource = path.join(root, "guides", "ledger.md");
    fs.mkdirSync(path.dirname(guideSource));
    fs.copyFileSync(fileURLToPath(new URL("../../guides/ledger.md", import.meta.url)), guideSource);
    writeJson(path.join(fakeBuild, "package.json"), { type: "module" });
    fs.writeFileSync(path.join(fakeBuild, "cli.js"), "// entry point identity for this frozen test build\n");
    fs.writeFileSync(path.join(fakeBuild, "store.js"), `import fs from 'node:fs';import path from 'node:path';export const loadConfig=()=>JSON.parse(fs.readFileSync(path.join(process.env.LEDGER_CONFIG_DIR,'config.json'),'utf8'));`);
    fs.writeFileSync(path.join(fakeBuild, "query.js"), `export const brief=cfg=>'# Ledger brief (fixture)\\n\\nRules: Fixture rules. ${GLOBAL_GUIDE_POINTER}\\n\\nLedger trial marker: '+cfg.marker;`);
    fs.writeFileSync(path.join(fakeBuild, "continuity/brief.js"), `export const openThreadsText=async(cfg,opts)=>{if(process.env.LEDGER_AUTHOR!=='trial-successor'||process.env.LEDGER_CONTINUITY_DB!==cfg.continuity.database_url||opts.cwd!==process.cwd())throw Error('wrong trial pins');return 'Open threads: trial-only-thread';};`);
    fs.writeFileSync(path.join(fakeBuild, "continuity/db.js"), "export const closePools=async()=>{};\n");
    writeJson(path.join(configDir, "config.json"), { marker: "TRIAL_ONLY_CANARY", continuity: { database_url: "postgresql://localhost/isolated_fixture" } });
    const rawDir = path.join(root, "raw");
    fs.mkdirSync(rawDir);
    const context: TrialContext = {
      paths: { root, configDir, rawDir, successorRepo: root, repo: root, bare: path.join(root, "bare"), ledgerDir: path.join(root, "ledger"), homeDir: path.join(root, "home"), outputDir: root },
      request: { protocol_version: 1, direction: "codex-to-claude", repetition: 1, trial_id: "isolated-fixture", output_dir: root, case: { id: "ISOLATION", level: 1, title: "isolation", events: [], resume_prompt: "continue", setup: [], answer_keys: [], successor_answer_contract: {} } },
      condition: "ours", originHarness: "codex", successorHarness: "claude", originAuthor: "trial-origin", successorAuthor: "trial-successor", originModel: "fixture", successorModel: "fixture",
      evalDatabaseUrl: "postgresql://localhost/isolated_fixture", log: () => {},
    };
    const previousCli = process.env.LEDGER_EVAL_CLI_JS;
    process.env.LEDGER_EVAL_CLI_JS = path.join(fakeBuild, "cli.js");
    try {
      const brief = await explicitStartupBrief(context);
      const guidePath = path.join(configDir, "condition-guides", "ledger.md");
      assert.equal(brief, `# Ledger brief (fixture)\n\nRules: Fixture rules. Full format in \`${guidePath}\`.\n\nLedger trial marker: TRIAL_ONLY_CANARY\n\nOpen threads: trial-only-thread`);
      assert.equal(fs.readFileSync(path.join(rawDir, "ours-startup-brief.txt"), "utf8").trim(), brief);
      const trace = JSON.parse(fs.readFileSync(path.join(rawDir, "ours-startup-brief.json"), "utf8"));
      assert.equal(trace.build, fakeBuild);
      assert.equal(trace.config_dir, configDir);
      assert.equal(trace.source, "explicit-frozen-build-render");
      assert.equal(trace.exit_code, 0);
      assert.ok(!trace.args.includes("hook"));
      ok("startup brief comes from the selected frozen build with exact trial config/DB/author pins, without hooks");
      const guideTrace = JSON.parse(fs.readFileSync(path.join(rawDir, "ours-guide.json"), "utf8"));
      assert.equal(guideTrace.source_path, guideSource);
      assert.deepEqual(guideTrace.content_transformations, []);
      const sourceBytes = fs.readFileSync(guideSource);
      assert.deepEqual(fs.readFileSync(guidePath), sourceBytes);
      assert.deepEqual(fs.readFileSync(guideTrace.retained_path), sourceBytes);
      assert.equal(trace.guide.sha256, guideTrace.sha256);
      assert.ok(trace.stdout.includes(GLOBAL_GUIDE_POINTER) && !trace.preamble.includes(GLOBAL_GUIDE_POINTER));
      // Stored records can contain the same words; only the generated header may change.
      const withRecord = trace.stdout + `\nRecorded source: ${GLOBAL_GUIDE_POINTER}\n`;
      assert.ok(localizeBriefGuide(withRecord, guidePath).endsWith(`Recorded source: ${GLOBAL_GUIDE_POINTER}\n`));
      assert.throws(() => localizeBriefGuide("unknown generator format", guidePath), /unrecognized/);
      assert.throws(() => freezeLedgerGuide(context, path.join(root, "missing-package", "build")), /no packaged guide/);
      fs.appendFileSync(guideSource, "\nChanged packaged guide fixture.\n");
      assert.throws(() => freezeLedgerGuide(context, fakeBuild), /frozen guide differs/);
      fs.writeFileSync(guideSource, sourceBytes);
      fs.rmSync(path.dirname(guidePath), { recursive: true });
      assert.deepEqual(fs.readFileSync(guideTrace.retained_path), sourceBytes, "raw guide survives removal of the trial's config copy");
      ok("exact packaged guide is retained with provenance; only the generated pointer changes, and missing/drifting guides fail closed");
    } finally {
      if (previousCli === undefined) delete process.env.LEDGER_EVAL_CLI_JS;
      else process.env.LEDGER_EVAL_CLI_JS = previousCli;
    }

    if (process.argv.includes("--runtime")) {
      // Actual CLI initialization against a local canned HTTP responder. No live model or real credentials.
      const claudeHome = path.join(root, "private-claude");
      const project = path.join(root, "project");
      fs.mkdirSync(claudeHome);
      fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
      const hookMarker = path.join(root, "hook-ran.txt");
      const hook = path.join(root, "fixture-hook.cjs");
      fs.writeFileSync(hook, `require('node:fs').writeFileSync(${JSON.stringify(hookMarker)},'ran');console.log('FIXTURE_HOOK_CONTEXT_CANARY');`);
      const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
      const hookSettings = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(hook)}` }] }] } };
      writeJson(path.join(claudeHome, "settings.json"), hookSettings);
      fs.writeFileSync(path.join(claudeHome, "CLAUDE.md"), "USER_MEMORY_ISOLATION_CANARY\n");
      fs.writeFileSync(path.join(project, "CLAUDE.md"), "PROJECT_MEMORY_ISOLATION_CANARY\n");
      const mcpConfig = path.join(root, "mcp.json");
      writeJson(mcpConfig, { mcpServers: { fixture: { command: process.execPath, args: [fileURLToPath(import.meta.url), "--fixture-mcp"] } } });
      const requests: { path: string; body: unknown }[] = [];
      const server = http.createServer((request, response) => {
        let body = "";
        request.on("data", chunk => { body += chunk; });
        request.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(body); } catch { parsed = {}; }
          requests.push({ path: request.url ?? "", body: parsed });
          if (!request.url?.startsWith("/v1/messages")) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ input_tokens: 1 })); return; }
          const message = { id: "msg_isolation_fixture", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "Fixture ready." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
          if (!parsed.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
          response.writeHead(200, { "content-type": "text/event-stream" });
          const emit = (type: string, payload: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
          emit("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
          emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Fixture ready." } });
          emit("content_block_stop", { index: 0 });
          emit("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
          emit("message_stop", {});
          response.end();
        });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const env = harnessEnv(process.env, {
        LEDGER_CONFIG_DIR: configDir, CLAUDE_CONFIG_DIR: claudeHome,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: "offline-fixture-key",
        ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_CUSTOM_HEADERS: undefined,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_PROXY: "127.0.0.1,localhost",
      });
      try {
        for (const isolated of [false, true]) {
          const before = requests.length;
          if (fs.existsSync(hookMarker)) fs.unlinkSync(hookMarker);
          const args = ["-p", "Return fixture readiness.", "--model", "claude-haiku-4-5-20251001", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--tools", "", "--mcp-config", mcpConfig, "--strict-mcp-config", ...(isolated ? claudeIsolationArgs() : [])];
          const result = await spawnHarness({ cmd: "claude", args, env, cwd: project, timeoutMs: 60_000 });
          writeJson(path.join(root, `runtime-${isolated ? "isolated" : "control"}.json`), { ...result, requests: requests.slice(before) });
          assert.equal(result.exitCode, 0, result.stderr + "\n" + result.stdout.slice(-2000));
          const serialized = JSON.stringify(requests.slice(before).filter(item => item.path.startsWith("/v1/messages")));
          assert.ok(serialized.length > 2, "the actual CLI must reach the local message responder");
          if (isolated) {
            assert.equal(fs.existsSync(hookMarker), false, "SessionStart hook must not execute");
            assert.ok(!serialized.includes("FIXTURE_HOOK_CONTEXT_CANARY") && !serialized.includes("USER_MEMORY_ISOLATION_CANARY") && !serialized.includes("PROJECT_MEMORY_ISOLATION_CANARY"), "startup prompt must exclude hooks and memory");
          } else {
            assert.ok(fs.existsSync(hookMarker), "positive control must execute the configured hook");
            assert.ok(serialized.includes("FIXTURE_HOOK_CONTEXT_CANARY") && serialized.includes("USER_MEMORY_ISOLATION_CANARY") && serialized.includes("PROJECT_MEMORY_ISOLATION_CANARY"), "positive control must show that all canaries are loadable");
          }
          const init = result.stdout.split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.type === "system" && value.subtype === "init");
          assert.ok(init?.mcp_servers?.some((item: any) => item.name === "fixture" && item.status === "connected"), "explicit trial MCP must still connect");
          ok(`actual Claude startup ${isolated ? "isolates hook/instruction canaries" : "positive control loads canaries"} and connects explicit MCP, using only a local canned responder`);
        }
      } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
      console.log(`Offline runtime artifacts: ${root}`);
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(`Isolation test artifacts retained at ${root}`);
    throw error;
  }
}
