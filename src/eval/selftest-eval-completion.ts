import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { E03 } from "./cases/E03.js";
import type { AdapterRequest, Condition, Direction, Observation, OriginRun, PublicCase, SuccessorRun, TrialContext } from "./types.js";

/**
 * Controller/scorer boundary regression tests. No model, production config or database.
 * Canned "all tests passed" prose must not rescue incorrect final filesystem bytes.
 *
 * npx tsc -p tsconfig.json --outDir dist-completion
 * node dist-completion/eval/selftest-eval-completion.js
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const kit = path.join(repoRoot, "eval/kit/continuity_eval.py");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-eval-completion-selftest-"));
const initialConfig = process.env.LEDGER_CONFIG_DIR;
const initialEval = process.env.LEDGER_EVAL;
process.env.LEDGER_CONFIG_DIR = path.join(tmp, "config");
process.env.LEDGER_EVAL = "1";
fs.mkdirSync(process.env.LEDGER_CONFIG_DIR, { recursive: true });
const env: NodeJS.ProcessEnv = { ...process.env, LEDGER_EVAL: "1", LEDGER_CONFIG_DIR: process.env.LEDGER_CONFIG_DIR };
delete env.LEDGER_EVAL_FAKE_WRONG;
delete env.LEDGER_EVAL_FAKE_NO_RETRIEVAL;
const py = process.env.PYTHON || "python3";
const readJson = (filename: string) => JSON.parse(fs.readFileSync(filename, "utf8"));
let checks = 0;
const ok = (message: string) => console.log(`  ok ${++checks}. ${message}`);

try {
  const suite = path.join(tmp, "suite");
  execFileSync(py, [kit, "prepare", "--out", suite, "--noise-events", "2"], { env, stdio: "pipe" });
  const fixture = readJson(path.join(suite, "public/E03.json")) as PublicCase;
  const seed = fixture.seed_files!["layout.json"];
  const seedConfig = JSON.parse(seed);
  const corrected = JSON.stringify({ ...seedConfig, safe_bottom: 20 }) + "\n";
  const origin: OriginRun = { harness: "codex", sessionIds: [], turns: [], transcriptPaths: [], totalInputTokens: 0, compactions: 0 };
  const successor: SuccessorRun = { harness: "claude", sessionId: "test-double", transcriptPath: null, output: { notes: "All tests passed; the task is complete." }, rawOutputPath: "", toolCalls: [], bootTokens: 0, totalInputTokens: 0, wallMs: 0 };

  function context(name: string, condition: Condition = "ours", direction: Direction = "codex-to-claude"): TrialContext {
    const root = path.join(tmp, name);
    const outputDir = path.join(root, "output");
    const request: AdapterRequest = { protocol_version: 1, case: fixture, direction, repetition: 1, trial_id: name, output_dir: outputDir };
    const paths = { root, repo: path.join(root, "repo"), bare: path.join(root, "remote.git"), successorRepo: path.join(root, "successor"), ledgerDir: path.join(root, "ledger"), configDir: path.join(root, "config"), homeDir: path.join(root, "home"), rawDir: path.join(outputDir, "raw"), outputDir };
    for (const dir of [paths.repo, paths.rawDir, path.join(outputDir, "recovered"), path.join(outputDir, "final")]) fs.mkdirSync(dir, { recursive: true });
    for (const dir of [paths.repo, path.join(outputDir, "recovered"), path.join(outputDir, "final")]) fs.writeFileSync(path.join(dir, "layout.json"), seed);
    fs.writeFileSync(path.join(paths.rawDir, "successor-output.json"), JSON.stringify(successor.output));
    return { request, condition, paths, originHarness: direction === "codex-to-claude" ? "codex" : "claude", successorHarness: direction === "codex-to-claude" ? "claude" : "codex", originAuthor: "rachit", successorAuthor: "agaaz", originModel: "test-double", successorModel: "test-double", evalDatabaseUrl: "postgresql://localhost:5432/ledger_eval", log: () => {} };
  }

  function officialScore(ctx: TrialContext, observation: Partial<Observation>): any {
    const obs = { status: "completed", provenance: { mode: "live", system_revision: "selftest-only", run_ref: "selftest-only", origin_harness: ctx.originHarness, successor_harness: ctx.successorHarness }, ...observation };
    const filename = path.join(ctx.paths.outputDir, "observation.json");
    fs.writeFileSync(filename, JSON.stringify(obs));
    const script = "import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('kit',sys.argv[1]); kit=importlib.util.module_from_spec(spec); spec.loader.exec_module(kit)\ncase=next(c for c in json.load(open(sys.argv[2])) if c['id']=='E03')\nprint(json.dumps(kit.score_case(case,json.load(open(sys.argv[3])),sys.argv[4],sys.argv[5])))\n";
    return JSON.parse(execFileSync(py, ["-c", script, kit, path.join(suite, "private/oracle.json"), filename, ctx.paths.outputDir, ctx.request.direction], { env, stdio: "pipe" }).toString());
  }

  // Origin is allowed to have acted, but the fixture must stop at known unfinished bytes.
  {
    const ctx = context("origin-reset");
    fs.writeFileSync(path.join(ctx.paths.repo, "layout.json"), corrected);
    await E03.afterOrigin!(ctx, origin);
    assert.equal(fs.readFileSync(path.join(ctx.paths.repo, "layout.json"), "utf8"), seed);
    assert.equal(fs.readFileSync(path.join(ctx.paths.rawDir, "e03-origin-layout.before-reset.json"), "utf8"), corrected);
    const reset = readJson(path.join(ctx.paths.rawDir, "e03-origin-checkpoint.json"));
    assert.equal(reset.controller_changed_layout, true);
    assert.match(reset.limitation, /not a real interrupted Rachit session/);
    assert.notEqual(reset.before_sha256, reset.after_sha256);
  }
  ok("controlled origin reset preserves earlier fix bytes and explicit synthetic-fixture provenance");

  for (const direction of ["codex-to-claude", "claude-to-codex"] as const) {
    const ctx = context(`correct-${direction}`, "ours", direction);
    await E03.beforeSuccessor!(ctx);
    fs.writeFileSync(path.join(ctx.paths.outputDir, "final/layout.json"), corrected);
    const extra = await E03.collect!(ctx, origin, successor);
    assert.deepEqual(extra, { recovered_files: "recovered", final_files: "final" });
    const report = readJson(path.join(ctx.paths.rawDir, "e03-validation.json"));
    assert.equal(report.completion_passed, true);
    assert.equal(report.recovered_matches_seed, true);
    assert.equal(report.successor_changed_layout, true);
    assert.equal(report.source_already_completed, false);
    assert.equal(report.final.validation.checks.length, 12);
    assert.ok(report.final.validation.checks.every((check: any) => check.passed));
    assert.equal(fs.readFileSync(path.join(ctx.paths.outputDir, "recovered/layout.json"), "utf8"), seed);
    assert.equal(fs.readFileSync(path.join(ctx.paths.outputDir, "final/layout.json"), "utf8"), corrected);
    assert.equal(officialScore(ctx, extra).status, "pass");
  }
  ok("corrected final bytes pass the independent kit in both directions; recovered bytes remain unchanged");

  const wrongFinals: Record<string, string | null> = {
    unchanged: seed,
    price_changed: JSON.stringify({ ...seedConfig, safe_bottom: 20, price_inr: 200 }),
    cta_changed: JSON.stringify({ ...seedConfig, safe_bottom: 20, cta_height: 47 }),
    gap_changed: JSON.stringify({ ...seedConfig, safe_bottom: 20, content_gap: 23 }),
    oversized_safe_area: JSON.stringify({ ...seedConfig, safe_bottom: 21 }),
    wrong_type: JSON.stringify({ ...seedConfig, safe_bottom: "20" }),
    boolean_value: JSON.stringify({ ...seedConfig, safe_bottom: true }),
    missing: null,
    invalid_json: "{broken",
    array: "[]",
    non_finite: '{"price_inr":199,"cta_height":48,"content_gap":24,"safe_bottom":1e309}',
  };
  for (const [name, content] of Object.entries(wrongFinals)) {
    const ctx = context(`bad-${name}`);
    const filename = path.join(ctx.paths.outputDir, "final/layout.json");
    if (content === null) fs.unlinkSync(filename); else fs.writeFileSync(filename, content);
    const extra = await E03.collect!(ctx, origin, successor);
    assert.equal(extra.final_files, "final", `${name} must remain scoreable`);
    assert.equal(readJson(path.join(ctx.paths.rawDir, "e03-validation.json")).completion_passed, false, name);
    assert.equal(officialScore(ctx, extra).status, ["invalid_json", "array"].includes(name) ? "unverified" : "fail", name);
  }
  ok("11 incomplete/invalid/unrelated-change outputs cannot pass official scoring despite successor claiming all tests passed");

  {
    const ctx = context("already-fixed");
    fs.writeFileSync(path.join(ctx.paths.outputDir, "recovered/layout.json"), corrected);
    fs.writeFileSync(path.join(ctx.paths.outputDir, "final/layout.json"), corrected);
    await assert.rejects(E03.beforeSuccessor!(ctx), /refusing to start successor/);
    await assert.rejects(E03.collect!(ctx, origin, successor), /cannot establish successor task completion/);
    assert.equal(readJson(path.join(ctx.paths.rawDir, "e03-validation.json")).completion_passed, false);
    assert.equal(readJson(path.join(ctx.paths.rawDir, "e03-successor-start.json")).source_already_completed, true);
  }
  ok("already-correct source is rejected before the successor and cannot be counted as completed work");

  {
    const ctx = context("no-bundle");
    fs.rmSync(path.join(ctx.paths.outputDir, "final"), { recursive: true });
    await assert.rejects(E03.collect!(ctx, origin, successor), /final\/ bundle missing/);
    fs.symlinkSync(ctx.paths.repo, path.join(ctx.paths.outputDir, "final"));
    await assert.rejects(E03.collect!(ctx, origin, successor), /final\/ bundle missing/);
    const linked = context("linked-file");
    fs.unlinkSync(path.join(linked.paths.outputDir, "final/layout.json"));
    fs.symlinkSync(path.join(ctx.paths.repo, "layout.json"), path.join(linked.paths.outputDir, "final/layout.json"));
    const extra = await E03.collect!(linked, origin, successor);
    assert.equal(readJson(path.join(linked.paths.rawDir, "e03-validation.json")).final.sha256, null);
    assert.equal(officialScore(linked, extra).status, "unverified");
  }
  ok("missing controller bundle and symlink escapes do not produce false completion");

  {
    const ctx = context("gbrain-reconstruction", "gbrain");
    fs.writeFileSync(path.join(ctx.paths.outputDir, "recovered/layout.json"), "{}\n");
    await E03.beforeSuccessor!(ctx);
    fs.writeFileSync(path.join(ctx.paths.outputDir, "final/layout.json"), corrected);
    const extra = await E03.collect!(ctx, origin, successor);
    assert.equal(readJson(path.join(ctx.paths.rawDir, "e03-validation.json")).completion_passed, true);
    assert.equal(officialScore(ctx, extra).status, "pass");
  }
  ok("GBrain can pass by reconstructing correct bytes; snapshot absence is not a forced completion failure");

  for (const condition of ["ours", "gbrain"] as const) {
    for (const direction of ["codex-to-claude", "claude-to-codex"] as const) {
      const ctx = context(`adapter-${condition}-${direction}`, condition, direction);
      // Adapter owns creation of these bundles; remove this test helper's prefilled copies.
      fs.rmSync(ctx.paths.outputDir, { recursive: true });
      const observation = JSON.parse(execFileSync(process.execPath, [path.join(here, "adapter.js"), "--condition", condition, "--fake"], { input: JSON.stringify(ctx.request), env, stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 }).toString()) as Observation;
      assert.equal(observation.status, "completed", observation.reason ?? "adapter should complete");
      assert.equal(observation.final_files, "final");
      assert.equal(observation.provenance.origin_harness, ctx.originHarness);
      assert.equal(observation.provenance.successor_harness, ctx.successorHarness);
      assert.ok(fs.statSync(path.join(ctx.paths.rawDir, "successor-tools.jsonl")).size > 0);
      assert.ok(fs.statSync(path.join(ctx.paths.rawDir, "e03-origin-checkpoint.json")).size > 0);
      assert.equal(readJson(path.join(ctx.paths.rawDir, "e03-validation.json")).completion_passed, false);
      assert.equal(officialScore(ctx, observation).status, "fail", "fake successor never edits files, so it must fail");
    }
  }
  ok("four full fake-adapter trials retain raw traces and honestly fail unfinished work across both conditions/directions");
  console.log(`selftest-eval-completion: ok (${checks} groups; synthetic test doubles, no live benchmark claim)`);
} finally {
  if (initialConfig === undefined) delete process.env.LEDGER_CONFIG_DIR; else process.env.LEDGER_CONFIG_DIR = initialConfig;
  if (initialEval === undefined) delete process.env.LEDGER_EVAL; else process.env.LEDGER_EVAL = initialEval;
  if (process.env.LEDGER_EVAL_KEEP === "1") console.log(`kept ${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
}
