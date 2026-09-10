import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * End-to-end test of the adapter, collector, case runners and comparison against the REAL kit,
 * using the fake drivers and plugin (LEDGER_EVAL_FAKE_HARNESS=1): no model, no harness, no
 * database. The kit prepares a suite, runs the adapter once per case, and scores; this file asserts
 * the observation bundles and the reports the kit produced.
 *
 *   node dist-eb/eval/selftest-eval-adapter.js        (after: npx tsc -p tsconfig.json --outDir dist-eb)
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(DIST, "..");
const KIT = path.join(REPO_ROOT, "eval", "kit", "continuity_eval.py");
const ADAPTER = path.join(HERE, "adapter.js");
const COMPARE = path.join(HERE, "compare.js");
const PY = process.env.PYTHON || "python3";
const PHASE1 = ["D01", "D02", "D03", "R01", "R02", "E01"];
const PHASE2 = ["E02", "C01", "L02"];

let step = 0;
const ok = (msg: string) => console.log(`  ok ${++step}. ${msg}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-eval-selftest-"));
const env = { ...process.env, LEDGER_EVAL_FAKE_HARNESS: "1" };
delete (env as any).LEDGER_EVAL_FAKE_WRONG;
delete (env as any).LEDGER_EVAL_FAKE_NO_RETRIEVAL;

function py(args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync(PY, [KIT, ...args], { cwd: REPO_ROOT, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 }).toString();
}
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const obsPath = (out: string, c: string, d = "codex-to-claude", r = 1) => path.join(out, "observations", c, d, String(r));

// ---------- suite ----------
const suite = path.join(tmp, "suite");
py(["prepare", "--out", suite, "--noise-events", "50"]);
assert.ok(fs.existsSync(path.join(suite, "public", "D01.json")) && fs.existsSync(path.join(suite, "private", "oracle.json")));
ok(`kit prepared 12 cases into ${suite}`);

function kitRun(condition: string, out: string, extraEnv: Record<string, string> = {}) {
  const adapterJson = path.join(tmp, `adapter-${path.basename(out)}.json`);
  fs.writeFileSync(adapterJson, JSON.stringify(["node", ADAPTER, "--condition", condition, "--fake"]));
  py(["run", "--suite", suite, "--out", out, "--adapter", adapterJson, "--directions", "codex-to-claude", "--repetitions", "1"], extraEnv);
  return readJson(path.join(out, "report.json"));
}

// ---------- condition ours ----------
const runs = path.join(tmp, "runs");
const oursOut = path.join(runs, "ours");
const oursReport = kitRun("ours", oursOut);
const status = (rep: any, c: string) => rep.results.find((r: any) => r.case === c);
for (const c of PHASE1) {
  const o = readJson(path.join(obsPath(oursOut, c), "observation.json"));
  assert.equal(o.status, "completed", `${c} status ${o.status}: ${o.reason}`);
  assert.equal(o.provenance.mode, "live");
  assert.ok(o.provenance.system_revision && o.provenance.run_ref, `${c} provenance`);
  assert.equal(o.provenance.origin_harness, "codex");
  assert.equal(o.provenance.successor_harness, "claude");
  assert.equal(o.provenance.condition, "ours");
  assert.ok(fs.statSync(path.join(obsPath(oursOut, c), "raw", "controller.log")).size > 0, `${c} controller.log`);
  assert.ok(fs.statSync(path.join(obsPath(oursOut, c), "raw", "successor-tools.jsonl")).size > 0, `${c} successor-tools.jsonl`);
}
ok("phase-1 cases completed with live provenance, harnesses matching the direction, controller.log and successor-tools.jsonl present");
for (const c of PHASE2) {
  const o = readJson(path.join(obsPath(oursOut, c), "observation.json"));
  assert.equal(o.status, "skipped", `${c} should be skipped`);
  assert.match(o.reason, /^phase 2: /);
  assert.equal(status(oursReport, c).status, "not_run");
  assert.ok(!fs.existsSync(path.join(obsPath(oursOut, c), "recovered")), `${c} must not create trial resources`);
}
ok("phase-2 cases are skipped with a 'phase 2:' reason and scored not_run, not error");

// D01: answers, evidence ids, retrieved evidence backed by raw files
{
  const base = obsPath(oursOut, "D01");
  const o = readJson(path.join(base, "observation.json"));
  const pub = readJson(path.join(suite, "public", "D01.json"));
  const text = (id: string) => pub.events.find((e: any) => e.id === id).text;
  assert.deepEqual(o.answers.price_inr, { value: 199, evidence_ids: ["constraint"] });
  assert.deepEqual(o.answers.animation_target, { value: "locked_insight", evidence_ids: ["reject"] });
  assert.deepEqual(o.answers.whole_card_rejection, { value: "distracting", evidence_ids: ["reject"] });
  assert.equal(typeof o.answers.price_inr.value, "number");
  for (const id of ["constraint", "reject"]) {
    const r = o.retrieved_evidence[id];
    assert.equal(r.text, text(id), `${id} text must equal the fixture text exactly`);
    assert.equal(r.system_ref, `fake:ours:${id}`);
    assert.match(r.raw_ref, /^raw\/retrieval-\d+\.json$/);
    const raw = path.join(base, r.raw_ref);
    assert.ok(fs.statSync(raw).size > 0, `${id} raw file`);
    assert.ok(fs.readFileSync(raw, "utf8").includes(text(id)), `${id} raw file carries the excerpt`);
  }
  assert.equal(status(oursReport, "D01").status, "pass");
  assert.ok(status(oursReport, "D01").checks.every((k: any) => k.status === "pass"));
}
ok("D01: '₹199' -> 199, 'Locked insight' -> locked_insight, 'distracting.' -> distracting; a 52-char excerpt maps to `constraint`; retrieved_evidence text equals the fixture text with existing raw files; kit scores pass");

// D02: real decision objects with supersedes, ledger ids as system refs
{
  const base = obsPath(oursOut, "D02");
  const o = readJson(path.join(base, "observation.json"));
  const ids = readJson(path.join(base, "raw", "ledger-ids.json"));
  assert.match(ids["metric-v1"], /^dec-/);
  assert.match(ids["metric-v2"], /^dec-/);
  assert.deepEqual(o.answers.denominator, { value: "unique_exposed_users", evidence_ids: ["metric-v2"] });
  assert.deepEqual(o.answers.superseded, { value: "metric-v1", evidence_ids: ["metric-v2"] });
  assert.equal(o.retrieved_evidence["metric-v2"].system_ref, ids["metric-v2"], "system_ref falls back to the ledger object id found in the raw tool output");
  assert.equal(status(oursReport, "D02").status, "pass");
}
ok("D02: two decisions recorded in the trial ledger with supersedes; hyphen preserved in 'metric-v1'; system_ref is the ledger id from raw/ledger-ids.json; kit scores pass");

// D03: null preserved, R01 topic, R02 numeric parse, E01 recovered bundle
{
  const d03 = readJson(path.join(obsPath(oursOut, "D03"), "observation.json"));
  assert.equal(d03.answers.accepted_join_rate.value, null);
  assert.deepEqual(d03.answers.accepted_join_rate.evidence_ids, ["hyp-a", "hyp-b"]);
  assert.equal(d03.answers.status.value, "unresolved");
  assert.equal(d03.answers.next_check.value, "dataset_equivalence");
  assert.equal(status(oursReport, "D03").status, "pass");
  const r01 = readJson(path.join(obsPath(oursOut, "R01"), "observation.json"));
  assert.equal(r01.selected_topic, "paywall");
  assert.equal(status(oursReport, "R01").status, "pass");
  const r02 = readJson(path.join(obsPath(oursOut, "R02"), "observation.json"));
  assert.deepEqual(r02.answers.unverified_viewport, { value: 640, evidence_ids: ["fix"] });
  assert.equal(r02.answers.preview.value, "webview");
  assert.equal(status(oursReport, "R02").status, "pass");
  const e01base = obsPath(oursOut, "E01");
  const e01 = readJson(path.join(e01base, "observation.json"));
  assert.equal(e01.recovered_files, "recovered");
  assert.ok(fs.existsSync(path.join(e01base, "recovered", "layout.json")));
  assert.ok(fs.existsSync(path.join(e01base, "recovered", "generated", "study.txt")));
  assert.ok(!fs.existsSync(path.join(e01base, "recovered", "obsolete.txt")));
  assert.ok(fs.existsSync(path.join(e01base, "raw", "bootstrap.json")));
  assert.equal(e01.answers.next_action.value, "validate_small_screen");
  assert.equal(status(oursReport, "E01").status, "pass", JSON.stringify(status(oursReport, "E01").checks));
  assert.ok(typeof e01.metrics.successor_boot_tokens === "number" && typeof e01.metrics.resume_latency_ms === "number");
}
ok("D03 null preserved, R01 selected_topic lowercased, R02 '640px' -> 640 and 'WebView' -> webview, E01 recovered/ copied before the successor with the deletion preserved; all pass; metrics present");
assert.equal(oursReport.provisional_level_on_selected_matrix, 2, "levels 1-2 qualify; level 3 blocked by phase-2 E02/E03");
ok("ours report: provisional level 2 (level 3 blocked by not_run E02/E03)");

// ---------- condition gbrain (no snapshot: E01 must fail honestly) ----------
const gbrainOut = path.join(runs, "gbrain");
const gbrainReport = kitRun("gbrain", gbrainOut);
{
  const e01 = status(gbrainReport, "E01");
  assert.equal(e01.status, "fail");
  const byKey = Object.fromEntries(e01.checks.map((k: any) => [`${k.type}:${k.key}`, k.status]));
  assert.equal(byKey["file_hash:layout.json"], "fail");
  assert.equal(byKey["absent_file:obsolete.txt"], "fail");
  assert.equal(byKey["answer:next_action"], "pass");
  const o = readJson(path.join(obsPath(gbrainOut, "E01"), "observation.json"));
  assert.equal(o.status, "completed");
  assert.equal(o.provenance.condition, "gbrain");
  assert.equal(status(gbrainReport, "D01").status, "pass");
}
ok("gbrain: E01 is completed but fails file_hash/absent_file (recovered/ copied from the fresh clone), D01 passes");

// ---------- wrong answer scores fail, not error ----------
{
  const wrongOut = path.join(tmp, "wrong");
  const rep = kitRun("ours", wrongOut, { LEDGER_EVAL_FAKE_WRONG: "D01:price_inr=200" });
  const d01 = status(rep, "D01");
  assert.equal(d01.status, "fail");
  const price = d01.checks.find((k: any) => k.key === "price_inr");
  assert.equal(price.status, "fail");
  assert.equal(price.detail, "Incorrect price_inr");
  assert.equal(readJson(path.join(obsPath(wrongOut, "D01"), "observation.json")).answers.price_inr.value, 200);
}
ok("injected wrong value (price_inr=200) scores fail with 'Incorrect price_inr', not error");

// ---------- evidence not in any tool output is left out, and scores fail ----------
{
  const noRetOut = path.join(tmp, "noretrieval");
  const rep = kitRun("ours", noRetOut, { LEDGER_EVAL_FAKE_NO_RETRIEVAL: "1" });
  const o = readJson(path.join(obsPath(noRetOut, "D01"), "observation.json"));
  assert.equal(o.retrieved_evidence, undefined, "collector must not fill retrieved_evidence from the fixture");
  assert.deepEqual(o.answers.price_inr, { value: 199, evidence_ids: ["constraint"] });
  const d01 = status(rep, "D01");
  assert.equal(d01.status, "fail");
  assert.equal(d01.checks.find((k: any) => k.key === "price_inr").detail, "Citation not backed by retrieved source text and real source reference");
}
ok("when no successor tool output contains the text, retrieved_evidence is omitted and the kit fails the citation");

// ---------- a retrieved_evidence entry backed by no raw file scores fail ----------
{
  const noRawOut = path.join(tmp, "noraw");
  fs.cpSync(oursOut, noRawOut, { recursive: true });
  const base = obsPath(noRawOut, "D01");
  const o = readJson(path.join(base, "observation.json"));
  fs.rmSync(path.join(base, o.retrieved_evidence.constraint.raw_ref));
  py(["score", "--suite", suite, "--out", noRawOut, "--directions", "codex-to-claude", "--repetitions", "1"]);
  const rep = readJson(path.join(noRawOut, "report.json"));
  const d01 = status(rep, "D01");
  assert.equal(d01.status, "fail");
  assert.equal(d01.checks.find((k: any) => k.key === "price_inr").status, "fail");
}
ok("a retrieved_evidence entry whose raw_ref file is missing scores fail");

// ---------- compare ----------
{
  const out = execFileSync("node", [COMPARE, "--suite", suite, "--runs", runs, "--conditions", "ours,gbrain"], { cwd: tmp, env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  assert.equal(out, path.join(runs, "matrix.md"));
  const m = readJson(path.join(runs, "matrix.json"));
  assert.deepEqual(m.conditions, ["ours", "gbrain"]);
  assert.equal(m.cells.length, 24);
  assert.equal(m.suite_sha256.length, 64);
  const cell = (c: string, cs: string) => m.cells.find((x: any) => x.condition === c && x.case === cs && x.direction === "codex-to-claude" && x.repetition === 1);
  assert.equal(cell("ours", "E01").status, "pass");
  assert.equal(cell("gbrain", "E01").status, "fail");
  assert.equal(cell("ours", "L01").status, "not_run"); // kit maps an infrastructure error to not_run
  assert.ok(cell("ours", "D01").checks.some((k: any) => k.type === "answer" && k.key === "price_inr" && k.status === "pass"));
  assert.equal(typeof cell("ours", "D01").metrics.successor_boot_tokens, "number");
  assert.deepEqual(m.levels.ours[1], { passed: 3, total: 3, qualified: true });
  assert.deepEqual(m.levels.gbrain[3], { passed: 0, total: 3, qualified: false });
  assert.equal(m.summary.ours.pass_rate, 6 / 12);
  assert.equal(m.summary.gbrain.pass_rate, 5 / 12);
  assert.ok(typeof m.summary.ours.median_boot_tokens === "number");
  const md = fs.readFileSync(path.join(runs, "matrix.md"), "utf8");
  assert.ok(md.startsWith("# Continuity evaluation matrix"));
  assert.ok(md.includes("| Case | Level | Direction | Rep | ours | gbrain |"));
  assert.ok(md.includes("| E01 | 3 | codex-to-claude | 1 | pass | fail (file_hash:layout.json, file_hash:generated/study.txt, absent_file:obsolete.txt) |"));
  assert.ok(md.includes("## Summary"));
  assert.ok(md.includes("ours: 6 passed, 2 failed, 4 not run"));
  assert.ok(md.includes("gbrain: 5 passed, 3 failed, 4 not run"));
  assert.ok(md.includes("no pilot level is demonstrated"));
  console.log("\n--- matrix.md (first 40 lines) ---");
  console.log(md.split("\n").slice(0, 40).join("\n"));
  console.log("--- end ---\n");
}
ok("compare.js wrote matrix.json (24 cells, levels, summary) and matrix.md with the expected table, level rows and an honest summary");

console.log(`selftest-eval-adapter: ok (${step} checks)`);
if (process.env.LEDGER_EVAL_KEEP !== "1") fs.rmSync(tmp, { recursive: true, force: true });
else console.log(`kept ${tmp}`);
