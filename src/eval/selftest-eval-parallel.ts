import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { C02 } from "./cases/C02.js";
import { evalTmpRoot, writeJson } from "./harness.js";
import { git } from "./fixture.js";
import { createParallelState, fileHash, parallelProgress, readParallelOperations, runParallelTurn, startParallelHandoff, stopParallelAgent } from "./parallel-agent.js";
import type { AdapterRequest, OriginRun, SuccessorRun, TrialContext } from "./types.js";

/** Pure plumbing/negative checks by default. --live-claude runs only an actual third-agent smoke, not a C02 trial. */
const live = process.argv.includes("--live-claude");
process.env.LEDGER_EVAL = "1";
if (live) delete process.env.LEDGER_EVAL_FAKE_HARNESS;
else process.env.LEDGER_EVAL_FAKE_HARNESS = "1";
fs.mkdirSync(evalTmpRoot(), { recursive: true });
const root = fs.mkdtempSync(path.join(evalTmpRoot(), "parallel-selftest-"));
const paths = {
  root, repo: path.join(root, "repo"), bare: path.join(root, "remote.git"), successorRepo: path.join(root, "successor"),
  ledgerDir: path.join(root, "ledger"), configDir: path.join(root, "config"), homeDir: path.join(root, "home"),
  outputDir: path.join(root, "output"), rawDir: path.join(root, "output", "raw"),
};
for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
process.env.LEDGER_CONFIG_DIR = paths.configDir;
git(paths.repo, "init", "--quiet", "-b", "master");
fs.writeFileSync(path.join(paths.repo, "README.md"), "# Disposable C02 selftest\n");
git(paths.repo, "add", "README.md");
git(paths.repo, "commit", "--quiet", "-m", "initial fixture");
const request: AdapterRequest = {
  protocol_version: 1, direction: "codex-to-claude", repetition: 1, trial_id: path.basename(root), output_dir: paths.outputDir,
  case: { id: "C02", level: 4, title: "Third agent selftest", events: [], resume_prompt: "Continue", setup: [], answer_keys: [], successor_answer_contract: {} },
};
const ctx: TrialContext = { request, paths, condition: "ours", originHarness: "claude", successorHarness: "codex", originAuthor: "eval", successorAuthor: "eval", originModel: "claude-haiku-4-5-20251001", successorModel: "codex-default", evalDatabaseUrl: "postgresql://localhost:5432/ledger_eval", log: line => fs.appendFileSync(path.join(paths.rawDir, "controller.log"), `${new Date().toISOString()} ${line}\n`) };
writeJson(path.join(paths.rawDir, "bootstrap.json"), { worktree: paths.successorRepo });
const rawOutputPath = path.join(paths.rawDir, "successor-output.json");
writeJson(rawOutputPath, { started_at: "2026-01-01T00:00:01.000Z", ended_at: "2026-01-01T00:00:03.000Z" });
const origin: OriginRun = { harness: "claude", sessionIds: [], turns: [], transcriptPaths: [], totalInputTokens: 0, compactions: 0 };
const successor: SuccessorRun = { harness: "codex", sessionId: "plumbing", transcriptPath: null, output: {}, rawOutputPath, toolCalls: [], bootTokens: null, totalInputTokens: null, wallMs: 0 };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let step = 0;
const ok = (text: string) => console.log(`ok ${++step}. ${text}`);

if (live) {
  const state = createParallelState(ctx);
  try {
    await startParallelHandoff(state);
    assert.equal(state.failure, null, state.failure ?? "");
    assert.ok(state.activePid, "an actual third harness must be alive");
    const startedAt = new Date().toISOString();
    // This is an explicitly simulated handoff interval; the full adapter alone can claim live C02.
    await pause(1_500);
    const endedAt = new Date().toISOString();
    await stopParallelAgent(state);
    await runParallelTurn(state, "after");
    const progress = parallelProgress(readParallelOperations(state.worktree), startedAt, endedAt);
    assert.ok(progress.before && progress.during && progress.after, JSON.stringify(progress));
    assert.ok(state.turns.every(turn => turn.outcome.ok && turn.outcome.spawn.pid !== null && turn.toolCalls.length > 0));
    assert.equal(fileHash(path.join(state.worktree, "unrelated-sentinel.txt")), state.sentinelBefore);
    writeJson(path.join(paths.outputDir, "smoke.json"), { mode: "live-third-agent-smoke", actual_successor: false, started_at: startedAt, ended_at: endedAt, progress, turns: state.turns.map(turn => ({ phase: turn.phase, ok: turn.outcome.ok, tool_calls: turn.toolCalls.length })) });
    ok(`real third harness executed before/during/after checks; this smoke uses a simulated successor interval: ${paths.outputDir}`);
  } finally { await stopParallelAgent(state); }
} else {
  try {
    await C02.before!(ctx);
    await C02.beforeSuccessor!(ctx);
    await C02.collect!(ctx, origin, successor);
    const parallel = JSON.parse(fs.readFileSync(path.join(paths.outputDir, "parallel.json"), "utf8"));
    assert.equal(parallel.mode, "fake-plumbing");
    assert.equal(parallel.third_agent_progressed, false);
    assert.equal(parallel.actual_harness_tool_operations_verified, false);
    assert.equal(parallel.independent_validation_passed, false);
    assert.equal(parallel.sentinel_before, parallel.sentinel_after);
    assert.notEqual(parallel.worktree_a, parallel.worktree_b);
    for (const ref of parallel.raw_trace_refs) assert.ok(fs.statSync(path.join(paths.outputDir, ref)).size > 0);
    ok("fake C02 cannot claim an active third agent, successful tool operation, or completed independent validation");

    const worktree = parallel.worktree_b;
    assert.throws(() => execFileSync(process.execPath, ["check-attribution.cjs", "before"], { cwd: worktree, stdio: "pipe" }));
    assert.deepEqual(readParallelOperations(worktree), []);
    ok("the attribution fixture starts unfinished and an unimplemented task cannot emit success");
    fs.writeFileSync(path.join(worktree, "attribution.cjs"), `module.exports=events=>{const seen=new Set(),result={};for(const event of events){if(seen.has(event.id))continue;seen.add(event.id);result[event.channel]??={purchases:0,revenue:0};result[event.channel].purchases++;result[event.channel].revenue+=event.amount;}return result};\n`);
    execFileSync(process.execPath, ["check-attribution.cjs", "before"], { cwd: worktree, stdio: "pipe" });
    const watcher = spawn(process.execPath, ["check-attribution.cjs", "during"], { cwd: worktree, stdio: "pipe" });
    const stopped = new Promise<number | null>(resolve => watcher.on("close", resolve));
    try {
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(path.join(worktree, "attribution-ready.json"))) {
        if (Date.now() > deadline) throw new Error("attribution fixture did not start");
        await pause(20);
      }
      const start = new Date().toISOString();
      await pause(500);
      const end = new Date().toISOString();
      fs.writeFileSync(path.join(worktree, "attribution-stop"), "selftest stop\n");
      assert.equal(await stopped, 0);
      await pause(5);
      execFileSync(process.execPath, ["check-attribution.cjs", "after"], { cwd: worktree, stdio: "pipe" });
      const operations = readParallelOperations(worktree);
      assert.ok(parallelProgress(operations, start, end).duringCount >= 1);
      assert.deepEqual(parallelProgress(operations, "invalid", "invalid"), { before: false, during: false, after: false, duringCount: 0 });
      const outside = operations.filter(op => op.phase !== "during");
      assert.equal(parallelProgress(outside, start, end).during, false);
      const failures = operations.map(op => ({ ...op, success: false }));
      assert.equal(parallelProgress(failures, start, end).during, false);
      const backwards = operations.map(op => ({ ...op, started_at: op.ended_at, ended_at: "1970-01-01T00:00:00.000Z" }));
      assert.equal(parallelProgress(backwards, start, end).during, false);
      ok("real child-process fixture records varied checks inside the bounded interval; absent, failed, invalid, and reversed timestamps fail");
    } finally {
      if (watcher.exitCode === null && watcher.signalCode === null) watcher.kill("SIGKILL");
      await stopped;
    }
    await C02.after!(ctx);
    await C02.after!(ctx);
    ok("cleanup is idempotent when no harness was spawned");
  } finally {
    await C02.after!(ctx);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
