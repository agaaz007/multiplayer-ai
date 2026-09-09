import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeJson } from "../harness.js";
import { createParallelState, fileHash, parallelProgress, readParallelOperations, runParallelTurn, startParallelHandoff, stopParallelAgent, type ParallelState } from "../parallel-agent.js";
import { trialEnv } from "../fixture.js";
import type { TrialContext } from "../types.js";
import type { EvalCaseRunner } from "./index.js";

const states = new WeakMap<TrialContext, ParallelState>();

/** An actual independent agent edits and validates attribution while the successor resumes paywall work. */
export const C02: EvalCaseRunner = {
  id: "C02",
  async before(ctx) { states.set(ctx, createParallelState(ctx)); },
  async afterOrigin(ctx) {
    // The public C02 events can leave the repo clean. Ensure there are snapshot bytes to
    // restore without injecting an answer or portraying this controlled setup as an interruption.
    const relativePath = "continuation-pending.txt";
    const marker = path.join(ctx.paths.repo, relativePath);
    const existed = fs.existsSync(marker);
    if (!existed) fs.writeFileSync(marker, "Pending continuation fixture.\n", { flag: "wx" });
    writeJson(path.join(ctx.paths.rawDir, "c02-origin-fixture.json"), {
      at: new Date().toISOString(),
      actor: "fixture-controller",
      mode: "controlled-fixture-setup",
      actual_origin_interruption: false,
      purpose: "Ensure C02 exercises snapshot restoration even when the origin leaves the repository clean.",
      operation: existed ? "preserved-existing-file" : "created-untracked-file",
      path: relativePath,
      sha256: fileHash(marker),
      contains_expected_answers: existed ? null : false,
    });
    ctx.log(`C02 controlled fixture: ${existed ? "preserved" : "created"} ${relativePath} before capture; no actual interruption`);
  },
  async beforeSuccessor(ctx) {
    const state = states.get(ctx);
    if (!state) throw new Error("C02 third-agent setup is missing");
    await startParallelHandoff(state);
  },
  async collect(ctx, _origin, successor) {
    const state = states.get(ctx);
    if (!state) throw new Error("C02 third-agent setup is missing");
    await stopParallelAgent(state);
    if (!state.fake && state.turns.some(turn => turn.phase === "before" && turn.outcome.ok)) await runParallelTurn(state, "after");

    const output = JSON.parse(fs.readFileSync(successor.rawOutputPath, "utf8"));
    const bootstrap = JSON.parse(fs.readFileSync(path.join(ctx.paths.rawDir, "bootstrap.json"), "utf8"));
    const operations = readParallelOperations(state.worktree);
    const progress = parallelProgress(operations, output.started_at, output.ended_at);
    const operationRef = "raw/third-agent-operations.jsonl";
    fs.writeFileSync(path.join(ctx.paths.outputDir, operationRef), operations.map(op => JSON.stringify(op)).join("\n") + "\n");
    const sentinelAfter = fileHash(path.join(state.worktree, "unrelated-sentinel.txt"));
    const runnerAfter = fileHash(path.join(state.worktree, "check-attribution.cjs"));
    const runnerPreserved = runnerAfter === state.runnerBefore;
    let independentCheck = { ok: false, output: "not run in fake plumbing mode" };
    if (!state.fake) {
      try {
        const script = `const assert=require('node:assert/strict');const aggregate=require('./attribution.cjs');assert.deepEqual(aggregate([]),{});assert.deepEqual(aggregate([{id:'1',channel:'referral',amount:51},{id:'1',channel:'paid',amount:700},{id:'2',channel:'paid',amount:19},{id:'3',channel:'referral',amount:0}]),{referral:{purchases:2,revenue:51},paid:{purchases:1,revenue:19}});console.log('independent attribution validation passed')`;
        independentCheck = { ok: true, output: execFileSync(process.execPath, ["-e", script], { cwd: state.worktree, env: trialEnv(state.ctx), encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim() };
      } catch (error) { independentCheck = { ok: false, output: String(error) }; }
    }
    const validationRef = "raw/third-agent-independent-validation.json";
    writeJson(path.join(ctx.paths.outputDir, validationRef), { at: new Date().toISOString(), ...independentCheck, runner_preserved: runnerPreserved, runner_sha256: runnerAfter, implementation_sha256: fileHash(path.join(state.worktree, "attribution.cjs")) });

    const phases = ["before", "during", "after"];
    const actualToolChecks = phases.every(phase => state.turns.some(turn => turn.phase === phase && turn.outcome.ok && turn.outcome.spawn.pid !== null && turn.toolCalls.some(call => {
      const input = String(call.input ?? "");
      return input.includes(`check-attribution.cjs ${phase}`) && call.is_error !== true && (call.exit_code == null || call.exit_code === 0);
    })));
    const harnessOverlapped = state.turns.some(turn => turn.phase === "during" && turn.outcome.ok && turn.outcome.spawn.pid !== null
      && Date.parse(turn.outcome.spawn.startedAt) <= Date.parse(output.started_at)
      && Date.parse(turn.outcome.spawn.endedAt) >= Date.parse(output.ended_at));
    const progressed = !state.fake && !state.failure && runnerPreserved && independentCheck.ok && actualToolChecks && harnessOverlapped && progress.before && progress.during && progress.after;
    const refs = ["raw/c02-origin-fixture.json", "raw/third-agent-setup.json", operationRef, validationRef, ...state.turns.flatMap(turn => [turn.traceRef, `raw/third-agent-${turn.phase}-tools.jsonl`])];
    writeJson(path.join(ctx.paths.outputDir, "parallel.json"), {
      raw_trace_refs: refs,
      mode: state.fake ? "fake-plumbing" : "live",
      worktree_a: bootstrap.worktree,
      worktree_b: state.worktree,
      third_agent_progressed: progressed,
      sentinel_before: state.sentinelBefore,
      sentinel_after: sentinelAfter,
      third_agent_harness: ctx.originHarness,
      third_agent_model: ctx.originModel,
      third_agent_session: state.sessionId,
      successor_started_at: output.started_at ?? null,
      successor_ended_at: output.ended_at ?? null,
      operations_before_during_after: progress,
      actual_harness_tool_operations_verified: actualToolChecks,
      third_harness_active_through_successor: harnessOverlapped,
      independent_validation_passed: independentCheck.ok,
      failure: state.fake ? "fake harness cannot demonstrate a third actual agent" : state.failure,
    });
    ctx.log(`C02 third agent: mode=${state.fake ? "fake-plumbing" : "live"} progressed=${progressed} during_operations=${progress.duringCount} sentinel_preserved=${sentinelAfter === state.sentinelBefore}`);
    return { parallel_file: "parallel.json" };
  },
  async after(ctx) {
    const state = states.get(ctx);
    if (!state) return;
    await stopParallelAgent(state);
    states.delete(ctx);
  },
};
