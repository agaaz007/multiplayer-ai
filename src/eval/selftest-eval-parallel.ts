import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { C02 } from "./cases/C02.js";
import { defaultModel, evalTmpRoot, writeJson } from "./harness.js";
import { git } from "./fixture.js";
import { createParallelState, fileHash, invokesAttributionCheck, parallelProgress, readParallelOperations, runParallelTurn, startParallelHandoff, stopParallelAgent, verifiedAttributionToolOperation, type ParallelTurn } from "./parallel-agent.js";
import type { TurnOutcome } from "./harness.js";
import type { AdapterRequest, OriginRun, SuccessorRun, TrialContext } from "./types.js";

/** Pure plumbing/negative checks by default. --live-claude/--live-codex run third-agent smokes, not C02 trials. */
const thirdHarness = process.argv.includes("--live-codex") ? "codex" : "claude";
const live = process.argv.includes("--live-claude") || process.argv.includes("--live-codex");
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
const ctx: TrialContext = { request, paths, condition: "ours", originHarness: thirdHarness, successorHarness: thirdHarness === "claude" ? "codex" : "claude", originAuthor: "eval", successorAuthor: "eval", originModel: defaultModel(thirdHarness, "origin"), successorModel: "codex-default", evalDatabaseUrl: "postgresql://localhost:5432/ledger_eval", log: line => fs.appendFileSync(path.join(paths.rawDir, "controller.log"), `${new Date().toISOString()} ${line}\n`) };
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
    const output = (value: unknown) => `Script completed\nWall time 0.1 seconds\nOutput:\n${JSON.stringify(value)}`;
    const duringReport = JSON.stringify({ phase: "during", successful_operations: 490, ended_at: "2026-09-09T11:34:37.903Z" });
    const launch = { tool: "exec", input: `python3 -c 'import subprocess; raise SystemExit(subprocess.run(["node", "check-attribution.cjs", "during"], timeout=750).returncode)'`, output: output({ session_id: 26467, output: "" }), is_error: false };
    const finish = { tool: "exec", input: 'text(await tools.write_stdin({session_id:26467,chars:""}));', output: output({ exit_code: 0, output: duringReport }), is_error: false };
    const turn = (toolCalls: Record<string, unknown>[]): ParallelTurn => ({ phase: "during", outcome: { ok: true, spawn: { pid: 34353 } } as TurnOutcome, toolCalls, traceRef: "regression-fixture" });
    assert.ok(invokesAttributionCheck(launch.input, "during"));
    assert.ok(invokesAttributionCheck('node "check-attribution.cjs" "during"', "during"));
    assert.equal(invokesAttributionCheck(launch.input, "after"), false);
    assert.equal(invokesAttributionCheck("node check-attribution.cjs during_extra", "during"), false);
    assert.ok(verifiedAttributionToolOperation(turn([launch, finish])));
    assert.equal(verifiedAttributionToolOperation(turn([launch])), false, "a yielded process has not completed");
    assert.equal(verifiedAttributionToolOperation(turn([launch, { ...finish, input: 'tools.write_stdin({session_id:999})' }])), false, "another shell's completion is not evidence");
    assert.equal(verifiedAttributionToolOperation(turn([launch, { ...finish, output: output({ exit_code: 1, output: duringReport }) }])), false);
    assert.equal(verifiedAttributionToolOperation(turn([launch, { ...finish, is_error: true }])), false);
    assert.equal(verifiedAttributionToolOperation(turn([launch, { ...finish, output: output({ exit_code: 0, output: "no attribution operation" }) }])), false);
    const yieldingPoll = { ...finish, output: "Script running with cell ID 5\nWall time 31.0 seconds\nOutput:\n" };
    const completedCell = { tool: "wait", input: '{"cell_id":"5"}', output: finish.output, is_error: false };
    assert.ok(verifiedAttributionToolOperation(turn([launch, yieldingPoll, completedCell])));
    assert.equal(verifiedAttributionToolOperation(turn([launch, yieldingPoll, { ...completedCell, input: '{"cell_id":"6"}' }])), false);
    assert.ok(verifiedAttributionToolOperation(turn([{ tool: "Bash", input: "node check-attribution.cjs during", output: duringReport, is_error: false, finished_at: "2026-09-09T11:34:38Z" }])));
    const noPid = turn([launch, finish]);
    noPid.outcome = { ...noPid.outcome, spawn: { ...noPid.outcome.spawn, pid: null } };
    assert.equal(verifiedAttributionToolOperation(noPid), false);
    ok("equivalent argv wrapper and exact shell/cell polling chains verify; wrong ids, errors, unfinished commands, and missing reports fail");
    const beforeReport = JSON.stringify({ phase: "before", success: true, note: 'Quoted braces: } [ \\"' });
    const checksum = { exit_code: 0, output: "Checker and sentinel unchanged.\n" };
    const batchTurn = (results: unknown[]): ParallelTurn => ({
      ...turn([]), phase: "before",
      toolCalls: [{ tool: "exec", input: "node check-attribution.cjs before node -e 'console.log(\"checksum\")'", is_error: false,
        output: "Script completed\nWall time 0.2 seconds\nOutput:\n" + results.map(value => JSON.stringify(value)).join("") }],
    });
    assert.ok(verifiedAttributionToolOperation(batchTurn([{}, { exit_code: 0, output: beforeReport }, checksum])));
    assert.ok(verifiedAttributionToolOperation(batchTurn([checksum, { exit_code: 0, output: beforeReport }, {}])));
    assert.ok(verifiedAttributionToolOperation(batchTurn([[{ status: "fulfilled", value: { exit_code: 0, output: beforeReport } }, { status: "fulfilled", value: checksum }]])));
    assert.equal(verifiedAttributionToolOperation(batchTurn([{ exit_code: 1, output: beforeReport }, checksum])), false, "a failed check cannot borrow a sibling command's exit status");
    assert.equal(verifiedAttributionToolOperation(batchTurn([{ session_id: 45, output: beforeReport }, checksum])), false, "an unfinished check cannot borrow a sibling command's exit status");
    assert.equal(verifiedAttributionToolOperation(batchTurn([{ status: "rejected", value: { exit_code: 0, output: beforeReport } }, checksum])), false);
    assert.equal(verifiedAttributionToolOperation(batchTurn([{ exit_code: 0, output: JSON.stringify({ phase: "after", success: true }) }])), false, "a successful after-phase result cannot replace the required before-phase operation");
    ok("batched adjacent/array results retain every operation and its own status; successful siblings cannot validate failed or unfinished checks");
    await C02.before!(ctx);
    assert.equal(git(paths.repo, "status", "--porcelain"), "");
    await C02.afterOrigin!(ctx, origin);
    const marker = path.join(paths.repo, "continuation-pending.txt");
    assert.equal(git(paths.repo, "status", "--porcelain"), "?? continuation-pending.txt");
    assert.equal(fs.readFileSync(marker, "utf8"), "Pending continuation fixture.\n");
    assert.equal(fs.existsSync(path.join(paths.root, "third-agent-worktree", "continuation-pending.txt")), false);
    const fixture = JSON.parse(fs.readFileSync(path.join(paths.rawDir, "c02-origin-fixture.json"), "utf8"));
    assert.equal(fixture.mode, "controlled-fixture-setup");
    assert.equal(fixture.actual_origin_interruption, false);
    assert.equal(fixture.operation, "created-untracked-file");
    assert.equal(fixture.sha256, fileHash(marker));
    fs.writeFileSync(marker, "Existing origin bytes must be preserved.\n");
    await C02.afterOrigin!(ctx, origin);
    assert.equal(fs.readFileSync(marker, "utf8"), "Existing origin bytes must be preserved.\n");
    assert.equal(JSON.parse(fs.readFileSync(path.join(paths.rawDir, "c02-origin-fixture.json"), "utf8")).operation, "preserved-existing-file");
    ok("clean origin gains untracked snapshot bytes with honest controller provenance; third worktree and existing bytes remain intact");
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
