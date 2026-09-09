import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { streamTranscript } from "../continuity/events.js";
import { findTranscript } from "../transcript.js";
import { git, trialEnv, writeEmptyMcpConfig } from "./fixture.js";
import { appendJsonl, envKeys, isFakeHarness, killGroup, newSessionId, runHarnessTurn, writeJson, type TurnOutcome } from "./harness.js";
import { claudeOriginArgs, codexOriginArgs } from "./origin.js";
import { collectToolCalls, parseLastJsonObject, prepareCodexHome } from "./successor.js";
import type { TrialContext } from "./types.js";

/** C02's unrelated task. The third harness implements the aggregation; this runner validates it. */
export const ATTRIBUTION_RUNNER = String.raw`const fs = require("node:fs");
const crypto = require("node:crypto");
const aggregate = require("./attribution.cjs");
const phase = process.argv[2];
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(sequence) {
  const started_at = new Date().toISOString();
  const offset = sequence % 97;
  const events = [
    { id: "a", channel: "organic", amount: 120 + offset },
    { id: "b", channel: "paid", amount: 200 + offset },
    { id: "a", channel: "organic", amount: 120 + offset },
    { id: "c", channel: "organic", amount: 80 },
  ];
  const actual = aggregate(events);
  const expected = { organic: { purchases: 2, revenue: 200 + offset }, paid: { purchases: 1, revenue: 200 + offset } };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("attribution check failed: " + JSON.stringify(actual));
  const report = JSON.stringify({ phase, sequence, result: actual }) + "\n";
  fs.writeFileSync("attribution-report.json", report);
  const operation = { phase, sequence, started_at, ended_at: new Date().toISOString(), pid: process.pid, success: true, report_sha256: hash(report) };
  fs.appendFileSync("attribution-operations.jsonl", JSON.stringify(operation) + "\n");
  return operation;
}
(async () => {
  if (!["before", "during", "after"].includes(phase)) throw new Error("unknown phase");
  if (phase !== "during") { console.log(JSON.stringify(check(0))); return; }
  const deadline = Date.now() + 720000;
  let sequence = 0;
  check(sequence++);
  fs.writeFileSync("attribution-ready.json", JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  while (!fs.existsSync("attribution-stop")) {
    if (Date.now() > deadline) throw new Error("controller did not end the handoff within 12 minutes");
    await pause(200);
    check(sequence++);
  }
  console.log(JSON.stringify({ phase, successful_operations: sequence, ended_at: new Date().toISOString() }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

export function fileHash(file: string): string | null {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
  catch { return null; }
}

export interface ParallelOperation {
  phase: string;
  sequence: number;
  started_at: string;
  ended_at: string;
  pid: number;
  success: boolean;
  report_sha256: string;
}

export interface ParallelTurn {
  phase: "before" | "during" | "after";
  outcome: TurnOutcome;
  toolCalls: Record<string, unknown>[];
  traceRef: string;
}

/** Shell strings and argv arrays express the same operation (Codex may wrap Node with a Python timeout). */
export function invokesAttributionCheck(input: string, phase: ParallelTurn["phase"]): boolean {
  return new RegExp(`check-attribution\\.cjs["']?(?:\\s+|\\s*,\\s*)["']?${phase}(?=["'\\s;,)\\]}]|$)`).test(input);
}

function outputLayers(call: Record<string, unknown>): Record<string, unknown>[] {
  const layers: Record<string, unknown>[] = [];
  let text = String(call.output ?? call.output_preview ?? "");
  // Codex's exec wrapper returns JSON whose output is a string containing the actual process JSON.
  for (let depth = 0; depth < 5; depth++) {
    const value = parseLastJsonObject(text);
    if (!value) break;
    layers.push(value);
    if (typeof value.output !== "string") break;
    text = value.output;
  }
  return layers;
}

/** Verify process completion, following the exact shell/cell id when a real tool invocation yields. */
export function verifiedAttributionToolOperation(turn: ParallelTurn): boolean {
  if (!turn.outcome.ok || turn.outcome.spawn.pid === null) return false;
  const sessions = new Set<string>();
  const cells = new Set<string>();
  const references = (input: string, key: string, known: Set<string>) => {
    const match = new RegExp(`["']?${key}["']?\\s*:\\s*["']?([A-Za-z0-9_-]+)`).exec(input);
    return Boolean(match && known.has(match[1]));
  };
  for (const call of turn.toolCalls) {
    const input = String(call.input ?? "");
    if (!/(?:^|__|\.)(?:Bash|exec|exec_command|write_stdin|wait)$/.test(String(call.tool ?? ""))) continue;
    const launch = invokesAttributionCheck(input, turn.phase);
    if (!launch && !references(input, "session_id", sessions) && !references(input, "cell_id", cells)) continue;
    if (call.is_error === true || (call.exit_code != null && call.exit_code !== 0)) continue;
    const layers = outputLayers(call);
    if (layers.some(layer => typeof layer.exit_code === "number" && layer.exit_code !== 0)) continue;
    for (const layer of layers) if (typeof layer.session_id === "number" || typeof layer.session_id === "string") sessions.add(String(layer.session_id));
    const cell = /Script running with cell ID\s+([A-Za-z0-9_-]+)/.exec(String(call.output ?? call.output_preview ?? ""));
    if (cell) cells.add(cell[1]);
    const completed = call.exit_code === 0 || layers.some(layer => layer.exit_code === 0)
      || (call.tool === "Bash" && call.is_error === false && typeof call.finished_at === "string");
    if (!completed) continue;
    if (layers.some(layer => layer.phase === turn.phase && (turn.phase === "during"
      ? Number.isInteger(layer.successful_operations) && Number(layer.successful_operations) > 0
      : layer.success === true))) return true;
  }
  return false;
}

export interface ParallelState {
  ctx: TrialContext;
  worktree: string;
  sentinelBefore: string;
  runnerBefore: string;
  fake: boolean;
  sessionId: string | null;
  turns: ParallelTurn[];
  running: Promise<ParallelTurn> | null;
  runningSettled: boolean;
  activePid: number | null;
  codexDir: string | null;
  failure: string | null;
}

export function createParallelState(ctx: TrialContext): ParallelState {
  const worktree = path.join(ctx.paths.root, "third-agent-worktree");
  git(ctx.paths.repo, "worktree", "add", "--quiet", "--detach", worktree, "HEAD");
  fs.writeFileSync(path.join(worktree, "unrelated-sentinel.txt"), `Unrelated in-progress attribution work: ${crypto.randomUUID()}\n`);
  fs.writeFileSync(path.join(worktree, "attribution.cjs"), "module.exports = function aggregate(events) { throw new Error('TODO: aggregate attributed purchases'); };\n");
  fs.writeFileSync(path.join(worktree, "check-attribution.cjs"), ATTRIBUTION_RUNNER);
  const isolatedCtx: TrialContext = {
    ...ctx,
    paths: { ...ctx.paths, configDir: path.join(ctx.paths.root, "third-agent-config"), homeDir: path.join(ctx.paths.root, "third-agent-home") },
  };
  fs.mkdirSync(isolatedCtx.paths.configDir, { recursive: true });
  fs.mkdirSync(isolatedCtx.paths.homeDir, { recursive: true });
  writeJson(path.join(isolatedCtx.paths.configDir, "config.json"), { ledger_dir: ctx.paths.ledgerDir, author: "eval-third-agent", git_sync: false });
  const state: ParallelState = {
    ctx: isolatedCtx, worktree,
    sentinelBefore: fileHash(path.join(worktree, "unrelated-sentinel.txt"))!,
    runnerBefore: fileHash(path.join(worktree, "check-attribution.cjs"))!,
    fake: isFakeHarness(), sessionId: ctx.originHarness === "claude" ? newSessionId() : null,
    turns: [], running: null, runningSettled: true, activePid: null, codexDir: null, failure: null,
  };
  if (ctx.originHarness === "codex" && !state.fake) {
    state.codexDir = prepareCodexHome(isolatedCtx, { env: {}, mcpConfigPath: null, allowedTools: [], cwd: worktree, preamble: "" }).home;
  }
  writeJson(path.join(ctx.paths.rawDir, "third-agent-setup.json"), {
    mode: state.fake ? "fake-plumbing" : "live",
    harness: ctx.originHarness, model: ctx.originModel, worktree,
    git_common_dir: git(worktree, "rev-parse", "--git-common-dir"),
    initial_head: git(worktree, "rev-parse", "HEAD"),
    sentinel_sha256: state.sentinelBefore, runner_sha256: state.runnerBefore,
    config_dir: isolatedCtx.paths.configDir,
    codex_home: state.codexDir,
    isolated_role: "third-agent",
  });
  return state;
}

function promptFor(phase: ParallelTurn["phase"]): string {
  const scope = "You are the third agent working independently on attribution in this disposable worktree. Only modify attribution.cjs and files generated by check-attribution.cjs. Preserve unrelated-sentinel.txt and check-attribution.cjs byte-for-byte. Do not access other worktrees, memory servers, network services, or git remotes. ";
  if (phase === "before") return scope + "Implement module.exports = function aggregate(events) in attribution.cjs. Deduplicate purchases by id (first occurrence wins), group by channel in first-seen order, and return an object whose values are {purchases: count, revenue: sum of amount}. Run node check-attribution.cjs before and fix your function until the command exits successfully. End with the command result.";
  if (phase === "during") return scope + "Keep validating attribution while another agent continues its paywall task. Execute node check-attribution.cjs during with a shell timeout of at least 750000 ms. This command performs independent varied-input checks every 200 ms until the controller creates attribution-stop. Wait for this exact command to finish successfully; do not create attribution-stop yourself and do not background the command. If the shell yields, poll that same process until it finishes. End with its result.";
  return scope + "The handoff is over. Run node check-attribution.cjs after to independently confirm your attribution code still works. Do not change any file manually in this turn. End with the command result.";
}

/** Exact owned PID comes from this invocation's spawn event, never from process-name lookup. */
export async function runParallelTurn(state: ParallelState, phase: ParallelTurn["phase"]): Promise<ParallelTurn> {
  const { ctx } = state;
  const harness = ctx.originHarness;
  const prompt = promptFor(phase);
  const lastMessageFile = path.join(ctx.paths.rawDir, `third-agent-${phase}-last-message.txt`);
  const model = ctx.originModel;
  const args = harness === "claude"
    ? claudeOriginArgs(prompt, state.sessionId!, state.turns.length > 0, model, state.worktree, writeEmptyMcpConfig(ctx), ["Bash", "Read", "Write", "Edit"])
    : codexOriginArgs(prompt, state.sessionId, model, state.worktree, lastMessageFile);
  const env = trialEnv(ctx, state.codexDir ? { CODEX_HOME: state.codexDir } : {});
  state.runningSettled = false;
  writeJson(path.join(ctx.paths.rawDir, `third-agent-${phase}-invocation.json`), { harness, model, phase, cwd: state.worktree, args, env_keys: envKeys(env), codex_home: state.codexDir, ledger_config_dir: ctx.paths.configDir });
  try {
    const outcome = await runHarnessTurn({
      harness, cmd: harness, args, cwd: state.worktree, env, timeoutMs: phase === "during" ? 780_000 : 180_000,
      sessionId: state.sessionId, resume: state.turns.length > 0, prompt, model, lastMessageFile,
      log: line => {
        const spawn = /^spawn \S+ pid=(\d+) /.exec(line);
        if (spawn) state.activePid = Number(spawn[1]);
        ctx.log(`third-agent(${phase}): ${line}`);
      },
      fake: { reply: "fake plumbing: no third agent performed work" },
    });
    state.sessionId = outcome.sessionId ?? state.sessionId;
    const traceRef = `raw/third-agent-${phase}-result.json`;
    writeJson(path.join(ctx.paths.outputDir, traceRef), { phase, harness, model, ...outcome });
    const found = state.sessionId && !state.fake
      ? findTranscript(state.sessionId, undefined, state.codexDir ? { codex: path.join(state.codexDir, "sessions") } : {})
      : null;
    const toolCalls = found ? collectToolCalls(streamTranscript(found.path, 0, harness).events).full.filter(call => {
      const at = Date.parse(String(call.at ?? ""));
      return at >= Date.parse(outcome.spawn.startedAt) && at <= Date.parse(outcome.spawn.endedAt);
    }) : [];
    const toolRef = `raw/third-agent-${phase}-tools.jsonl`;
    fs.writeFileSync(path.join(ctx.paths.outputDir, toolRef), toolCalls.map(call => JSON.stringify(call)).join("\n") + "\n");
    const turn = { phase, outcome, toolCalls, traceRef };
    state.turns.push(turn);
    return turn;
  } finally {
    state.runningSettled = true;
    state.activePid = null;
  }
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function startParallelHandoff(state: ParallelState): Promise<void> {
  if (state.fake) return;
  const before = await runParallelTurn(state, "before");
  if (!before.outcome.ok) { state.failure = `third agent initial operation failed: ${before.outcome.failure}`; return; }
  if (!readParallelOperations(state.worktree).some(op => op.phase === "before" && op.success)) {
    state.failure = "third agent did not complete the initial independent attribution operation";
    return;
  }
  state.running = runParallelTurn(state, "during");
  // Attach a rejection handler immediately; collect/cleanup still observes and records the failure.
  void state.running.catch(() => undefined);
  const deadline = Date.now() + 150_000;
  while (!fs.existsSync(path.join(state.worktree, "attribution-ready.json"))) {
    if (state.runningSettled) { state.failure = "third agent ended without starting the parallel operation"; return; }
    if (Date.now() > deadline) { state.failure = "third agent never reached the handoff barrier"; await stopParallelAgent(state); return; }
    await pause(100);
  }
  appendJsonl(path.join(state.ctx.paths.rawDir, "third-agent-lifecycle.jsonl"), { phase: "ready-for-successor", at: new Date().toISOString(), harness_pid: state.activePid });
}

export async function stopParallelAgent(state: ParallelState): Promise<void> {
  if (!state.running) return;
  if (fs.existsSync(state.worktree)) fs.writeFileSync(path.join(state.worktree, "attribution-stop"), `${new Date().toISOString()}\n`);
  if (!state.runningSettled) await Promise.race([state.running.catch(() => undefined), pause(20_000)]);
  if (!state.runningSettled && state.activePid) {
    killGroup(state.activePid, "SIGTERM");
    await Promise.race([state.running.catch(() => undefined), pause(5_000)]);
    if (!state.runningSettled && state.activePid) killGroup(state.activePid, "SIGKILL");
  }
  try { await state.running; }
  catch (error) { state.failure = String(error); }
  state.running = null;
}

export function readParallelOperations(worktree: string): ParallelOperation[] {
  try { return fs.readFileSync(path.join(worktree, "attribution-operations.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}

/** A process being alive is insufficient: a verified operation must finish inside the real successor interval. */
export function parallelProgress(operations: ParallelOperation[], startedAt: string, endedAt: string): { before: boolean; during: boolean; after: boolean; duringCount: number } {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  const successful = operations.filter(op => op.success === true && Number.isFinite(Date.parse(op.started_at)) && Number.isFinite(Date.parse(op.ended_at)) && Date.parse(op.ended_at) >= Date.parse(op.started_at));
  const during = successful.filter(op => op.phase === "during" && Date.parse(op.started_at) >= start && Date.parse(op.ended_at) <= end);
  return {
    before: successful.some(op => op.phase === "before" && Date.parse(op.ended_at) < start),
    during: during.length > 0,
    after: successful.some(op => op.phase === "after" && Date.parse(op.started_at) > end),
    duringCount: during.length,
  };
}
