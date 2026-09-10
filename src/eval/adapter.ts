#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { AdapterRequest, Condition, ConditionPlugin, Harness, Observation, OriginRun, Provenance, SuccessorRun, TrialContext } from "./types.js";
import { needsSnapshot, runnerFor, type EvalCaseRunner } from "./cases/index.js";
import { collectCommon } from "./collector.js";
import { copyTree, fakeDrivers, fakePlugin, type BootstrapResult, type Drivers, type EvalPlugin } from "./fake.js";
import { redactText } from "../continuity/redact.js";

/**
 * The executable the continuity kit runs once per trial:
 *
 *   node dist/eval/adapter.js --condition ours|gbrain [--fake | --fake-harness] [--keep]
 *
 * One JSON request on stdin, exactly one JSON observation on stdout. Every log line goes to
 * stderr and to <output_dir>/raw/controller.log (redacted). Flow per trial: pick the CaseRunner;
 * createTrial; runner.before; runOrigin; plugin.prepare; plugin.successorSetup; for snapshot cases
 * bootstrap the recovered worktree and copy it to <output_dir>/recovered BEFORE the successor
 * starts; runSuccessor; collectCommon merged with runner.collect; runner.after; cleanupTrial.
 *
 * `--fake` sets LEDGER_EVAL_FAKE_HARNESS=1 and swaps in the fake drivers and plugin from fake.ts so
 * the pipeline runs without a model; status stays "completed" so the kit scores it.
 * `--fake-harness` keeps the REAL drivers (fixture/origin/successor under LEDGER_EVAL_FAKE_HARNESS=1,
 * so no harness process is spawned but the trial repo, ledger and eval database are exercised) and
 * uses the fake plugin; the drivers' canned successor answers fail honestly.
 * LEDGER_EVAL_KEEP=1 (or --keep) keeps the trial root after the run.
 *
 * A thrown error anywhere yields status "error" with the message; the process still exits 0 with
 * the JSON on stdout so the kit records the reason instead of "exited with code N".
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

interface Args { condition: Condition; fake: boolean; fakeHarness: boolean; keep: boolean }

function parseArgs(argv: string[]): Args {
  let condition: Condition | null = null;
  let fake = false;
  let fakeHarness = false;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--condition") { const v = argv[++i]; if (v !== "ours" && v !== "gbrain") throw new Error(`--condition must be ours|gbrain, got ${v}`); condition = v; }
    else if (a.startsWith("--condition=")) { const v = a.slice("--condition=".length); if (v !== "ours" && v !== "gbrain") throw new Error(`--condition must be ours|gbrain, got ${v}`); condition = v; }
    else if (a === "--fake") fake = true;
    else if (a === "--fake-harness") fakeHarness = true;
    else if (a === "--keep") keep = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!condition) throw new Error("--condition ours|gbrain is required");
  return { condition, fake, fakeHarness, keep: keep || process.env.LEDGER_EVAL_KEEP === "1" };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(Buffer.from(c)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function gitHead(cwd: string): string {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown"; } catch { return "unknown"; }
}

const versionCache = new Map<string, string>();
function cliVersion(h: Harness): string {
  if (versionCache.has(h)) return versionCache.get(h)!;
  let v = "unknown";
  try { v = execFileSync(h, ["--version"], { stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }).toString().trim().split("\n")[0] || "unknown"; } catch { /* not installed */ }
  versionCache.set(h, v);
  return v;
}

/**
 * Real drivers and plugins live in sibling modules owned by the driver agents. They are loaded by
 * name at runtime so this file compiles before they land; the adaptation to their exports is here
 * and nowhere else. Driver exports (per the drivers agent, 2026-09-08):
 *   fixture.js   createTrial(request, condition, { log }) / cleanupTrial(ctx, { keep })
 *   origin.js    runOrigin(ctx, events)
 *   successor.js runSuccessor(ctx, setup, resumePrompt, answerKeys)
 *   harness.js   harnessVersion(h)                       (optional; falls back to `<harness> --version`)
 *   conditions/<c>.js  default | plugin | <c>Plugin | <c>   (a ConditionPlugin, optionally with bootstrapWorktree)
 */
async function loadReal(condition: Condition, fakePluginOnly: boolean): Promise<{ drivers: Drivers; plugin: EvalPlugin }> {
  const load = async (rel: string): Promise<any> => import(new URL(rel, import.meta.url).href);
  const fixture = await load("./fixture.js");
  const origin = await load("./origin.js");
  const successor = await load("./successor.js");
  let harness: any = null;
  try { harness = await load("./harness.js"); } catch { /* optional */ }
  let plugin: EvalPlugin;
  if (fakePluginOnly) plugin = fakePlugin(condition);
  else {
    const mod = await load(`./conditions/${condition}.js`);
    plugin = mod.default ?? mod.plugin ?? mod[`${condition}Plugin`] ?? mod[condition];
    if (!plugin || typeof plugin.prepare !== "function") throw new Error(`conditions/${condition}.js exports no ConditionPlugin`);
  }
  const createTrial = fixture.createTrial ?? fixture.default?.createTrial;
  const cleanupTrial = fixture.cleanupTrial ?? fixture.default?.cleanupTrial;
  const runOrigin = origin.runOrigin ?? origin.default;
  const runSuccessor = successor.runSuccessor ?? successor.default;
  for (const [n, f] of Object.entries({ createTrial, cleanupTrial, runOrigin, runSuccessor })) if (typeof f !== "function") throw new Error(`driver export missing: ${n}`);
  const drivers: Drivers = {
    createTrial: (request, cond, log) => createTrial(request, cond, { log }),
    cleanupTrial: (ctx, keep) => cleanupTrial(ctx, { keep }),
    runOrigin: (ctx, events) => runOrigin(ctx, events),
    runSuccessor: (ctx, setup, resumePrompt, answerKeys) => runSuccessor(ctx, setup, resumePrompt, answerKeys),
    harnessVersion: (h) => { try { const v = harness?.harnessVersion?.(h); if (typeof v === "string" && v) return v; } catch { /* fall through */ } return cliVersion(h); },
  };
  return { drivers, plugin };
}

/** Fallback bootstrap when the plugin has no bootstrapWorktree: latest session for the origin repo in the eval database -> checkoutWip. */
async function fallbackBootstrap(ctx: TrialContext): Promise<BootstrapResult> {
  const { getPool } = await import("../continuity/db.js");
  const { checkoutWip, repoIdentity } = await import("../continuity/shadow.js");
  const repo = repoIdentity(ctx.paths.repo);
  const pool = getPool({ ledger_dir: ctx.paths.ledgerDir, author: ctx.successorAuthor, git_sync: false, continuity: { database_url: ctx.evalDatabaseUrl } });
  const r = await pool.query<{ id: string; wip_ref: string; wip_commit: string }>(
    `select id, wip_ref, wip_commit from cont_sessions where repo = $1 and wip_ref is not null and wip_commit is not null order by last_verified_snapshot_at desc nulls last, last_seen_at desc nulls last limit 1`, [repo]);
  const s = r.rows[0];
  if (!s) throw new Error(`no snapshot session for repo ${repo} in the eval database`);
  const dest = path.join(ctx.paths.root, "recovered-worktree");
  checkoutWip(ctx.paths.successorRepo, s.wip_ref, s.wip_commit, dest);
  ctx.log(`bootstrap(fallback): session ${s.id} ${s.wip_ref}@${s.wip_commit.slice(0, 12)} -> ${dest}`);
  return { worktree: dest, wip_ref: s.wip_ref, wip_commit: s.wip_commit };
}

function manifest(dir: string): { path: string; sha256: string; bytes: number }[] {
  const out: { path: string; sha256: string; bytes: number }[] = [];
  const walk = (d: string, rel: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === ".git") continue;
      const p = path.join(d, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(p, r);
      else if (ent.isFile()) { const b = fs.readFileSync(p); out.push({ path: r, sha256: crypto.createHash("sha256").update(b).digest("hex"), bytes: b.length }); }
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

interface Timings { [k: string]: number }

async function runTrial(request: AdapterRequest, args: Args, log: (l: string) => void, timings: Timings): Promise<Observation> {
  const runner: EvalCaseRunner = runnerFor(request.case.id);
  const base = { mode: "live" as const, system_revision: gitHead(REPO_ROOT), run_ref: request.trial_id, condition: args.condition, topology: "same-machine" as const };
  if (runner.skip) {
    log(`case ${request.case.id} skipped: ${runner.skip}`);
    return { status: "skipped", reason: runner.skip, provenance: base };
  }
  const { drivers, plugin } = args.fake ? { drivers: fakeDrivers, plugin: fakePlugin(args.condition) } : await loadReal(args.condition, args.fakeHarness);
  const started = Date.now();
  const ctx = await drivers.createTrial(request, args.condition, log);
  timings.create_trial_ms = Date.now() - started;
  let obs: Observation | null = null;
  try {
    fs.mkdirSync(ctx.paths.rawDir, { recursive: true });
    log(`trial ${request.trial_id}: case ${request.case.id} (${request.case.title}), ${request.direction}, rep ${request.repetition}, condition ${args.condition}${args.fake ? " [fake drivers+plugin]" : args.fakeHarness ? " [real drivers, fake harness, fake plugin]" : ""}`);
    log(`paths: repo=${ctx.paths.repo} successor=${ctx.paths.successorRepo} ledger=${ctx.paths.ledgerDir} config=${ctx.paths.configDir}`);

    if (runner.before) { const t = Date.now(); await runner.before(ctx); timings.before_ms = Date.now() - t; }

    const events = runner.originEvents?.(ctx) ?? request.case.events;
    let t = Date.now();
    const origin: OriginRun = runner.runOrigin ? await runner.runOrigin(ctx) : await drivers.runOrigin(ctx, events);
    timings.origin_ms = Date.now() - t;
    log(`origin: ${origin.harness}, ${origin.turns.length} turns over ${origin.sessionIds.length} session(s), ${origin.totalInputTokens} input tokens, ${origin.compactions} compactions`);
    fs.writeFileSync(path.join(ctx.paths.rawDir, "origin-run.json"), JSON.stringify({ harness: origin.harness, sessionIds: origin.sessionIds, transcriptPaths: origin.transcriptPaths, totalInputTokens: origin.totalInputTokens, compactions: origin.compactions, turns: origin.turns.map((x) => ({ turn: x.turnIndex, event: x.fixtureEventId, session: x.sessionId, wall_ms: x.wallMs, usage: x.usage ?? null, assistant: x.assistantText.slice(0, 2000) })) }, null, 2) + "\n");

    if (runner.afterOrigin) await runner.afterOrigin(ctx, origin);

    t = Date.now();
    const prep = await plugin.prepare(ctx, origin);
    timings.prepare_ms = Date.now() - t;
    log(`prepare(${plugin.name}): ${prep.prepared_ms} ms; ${prep.notes.join(" | ") || "no notes"}`);
    fs.writeFileSync(path.join(ctx.paths.rawDir, "prepare.json"), JSON.stringify({ condition: plugin.name, ...prep }, null, 2) + "\n");

    let setup = await plugin.successorSetup(ctx);
    log(`successor setup: cwd=${setup.cwd} mcp=${setup.mcpConfigPath ?? "none"} tools=${setup.allowedTools.length} env=${Object.keys(setup.env).join(",") || "(none)"}`);

    if (needsSnapshot(request.case)) {
      let boot: BootstrapResult;
      if (args.condition === "ours") {
        boot = plugin.bootstrapWorktree ? await plugin.bootstrapWorktree(ctx) : await fallbackBootstrap(ctx);
        setup = { ...setup, cwd: boot.worktree };
        log(`bootstrap(ours): successor works in the recovered worktree ${boot.worktree} (${boot.wip_ref ?? "no ref"})`);
      } else {
        boot = { worktree: setup.cwd || ctx.paths.successorRepo, wip_ref: null, wip_commit: null };
        log(`bootstrap(${args.condition}): no snapshot in this condition; recovered/ is the fresh clone at ${boot.worktree}`);
      }
      const recovered = path.join(ctx.paths.outputDir, "recovered");
      if (fs.existsSync(recovered)) throw new Error("recovered/ already exists; use a fresh output directory so stale files cannot satisfy checks");
      copyTree(boot.worktree, recovered);
      const files = manifest(recovered);
      fs.writeFileSync(path.join(ctx.paths.rawDir, "bootstrap.json"), JSON.stringify({ condition: args.condition, ...boot, copied_to: "recovered", copied_at: new Date().toISOString(), files }, null, 2) + "\n");
      log(`recovered/: ${files.length} files copied before the successor started`);
    }

    if (runner.beforeSuccessor) await runner.beforeSuccessor(ctx);
    t = Date.now();
    const successorStartedAt = Date.now();
    const successor: SuccessorRun = await drivers.runSuccessor(ctx, setup, request.case.resume_prompt, request.case.answer_keys);
    timings.successor_ms = Date.now() - t;
    log(`successor: ${successor.harness} session ${successor.sessionId}, ${successor.toolCalls.length} tool calls, boot ${successor.bootTokens ?? "?"} tokens, ${successor.wallMs} ms, output ${successor.output ? "parsed" : "NOT parsed"}`);

    if (needsSnapshot(request.case)) {
      const final = path.join(ctx.paths.outputDir, "final");
      if (fs.existsSync(final)) throw new Error("final/ already exists; use a fresh output directory so stale files cannot satisfy checks");
      copyTree(setup.cwd, final);
      fs.writeFileSync(path.join(ctx.paths.rawDir, "final-manifest.json"), JSON.stringify({ from: setup.cwd, files: manifest(final) }, null, 2) + "\n");
    }

    t = Date.now();
    const common = await collectCommon(ctx, origin, successor, plugin as ConditionPlugin, { successorStartedAt });
    const extra = runner.collect ? await runner.collect(ctx, origin, successor) : {};
    timings.collect_ms = Date.now() - t;

    const provenance: Provenance = {
      ...base, mode: "live",
      origin_harness: ctx.originHarness, successor_harness: ctx.successorHarness,
      origin_harness_version: drivers.harnessVersion(ctx.originHarness), successor_harness_version: drivers.harnessVersion(ctx.successorHarness),
      origin_model: ctx.originModel, successor_model: ctx.successorModel,
      condition: args.condition, topology: "same-machine",
    };
    obs = { status: "completed", provenance, ...common, ...extra };
    return obs;
  } finally {
    try { if (runner.after) await runner.after(ctx); }
    catch (e: any) { log(`case cleanup failed: ${String(e?.message ?? e).slice(0, 300)}`); }
    try { await drivers.cleanupTrial(ctx, args.keep); log(`cleanup: ${args.keep ? "kept" : "removed"} ${ctx.paths.root}`); }
    catch (e: any) { log(`cleanup failed: ${String(e?.message ?? e).slice(0, 300)}`); }
  }
}

async function main(): Promise<void> {
  const t0 = Date.now();
  let args: Args | null = null;
  let request: AdapterRequest | null = null;
  let outputDir: string | null = null;
  const pending: string[] = [];
  let logFile: string | null = null;
  const log = (line: string) => {
    const t = `${new Date().toISOString()} ${redactText(line).text}`;
    process.stderr.write(t + "\n");
    if (logFile) { try { fs.appendFileSync(logFile, t + "\n"); } catch { /* best effort */ } }
    else pending.push(t);
  };
  const timings: Timings = {};
  let obs: Observation;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.fake || args.fakeHarness) process.env.LEDGER_EVAL_FAKE_HARNESS = "1";
    request = JSON.parse(await readStdin()) as AdapterRequest;
    if (request.protocol_version !== 1) throw new Error(`unsupported adapter protocol ${String((request as any).protocol_version)}`);
    if (!request.output_dir || !path.isAbsolute(request.output_dir)) throw new Error("request.output_dir must be absolute");
    outputDir = request.output_dir;
    fs.mkdirSync(path.join(outputDir, "raw"), { recursive: true });
    logFile = path.join(outputDir, "raw", "controller.log");
    if (pending.length) fs.appendFileSync(logFile, pending.join("\n") + "\n");
    obs = await runTrial(request, args, log, timings);
  } catch (e: any) {
    const reason = String(e?.message ?? e).slice(0, 500);
    log(`error: ${reason}`);
    if (e?.stack) log(String(e.stack).split("\n").slice(0, 12).join(" | "));
    obs = { status: "error", reason, provenance: { mode: "live", system_revision: gitHead(REPO_ROOT), run_ref: request?.trial_id ?? "unknown", ...(args ? { condition: args.condition, topology: "same-machine" as const } : {}) } };
  }
  timings.total_ms = Date.now() - t0;
  if (outputDir) {
    try {
      fs.writeFileSync(path.join(outputDir, "raw", "controller.json"), JSON.stringify({ trial_id: request?.trial_id, case: request?.case.id, direction: request?.direction, repetition: request?.repetition, condition: args?.condition, fake: args?.fake ?? false, argv: process.argv.slice(2), status: obs.status, reason: obs.reason ?? null, timings, finished_at: new Date().toISOString() }, null, 2) + "\n");
      fs.writeFileSync(path.join(outputDir, "observation.json"), JSON.stringify(obs, null, 2) + "\n");
    } catch (e: any) { log(`could not write bundle files: ${String(e?.message ?? e)}`); }
  }
  log(`done: ${obs.status}${obs.reason ? ` (${obs.reason})` : ""} in ${timings.total_ms} ms`);
  try { const { closePools } = await import("../continuity/db.js"); await closePools(); } catch { /* no pools */ }
  process.stdout.write(JSON.stringify(obs) + "\n");
  process.exitCode = 0;
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ status: "error", reason: String(e?.message ?? e).slice(0, 500), provenance: { mode: "live", system_revision: gitHead(REPO_ROOT), run_ref: "unknown" } }) + "\n");
  process.exitCode = 0;
});
