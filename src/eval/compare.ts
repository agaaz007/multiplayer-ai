#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { Condition, Direction, Matrix, MatrixCell, Metrics } from "./types.js";

/**
 * Cross-condition comparison over kit output:
 *
 *   node dist/eval/compare.js --suite <dir> --runs <dir> --conditions ours,gbrain
 *                             [--directions codex-to-claude,claude-to-codex] [--repetitions N]
 *                             [--kit <continuity_eval.py>] [--python <bin>]
 *
 * For each condition, <runs>/<condition>/observations/... must exist as produced by the kit's `run`.
 * The kit's `score` is invoked per condition (it owns the oracle; this file never re-scores), its
 * report.json is read, and <runs>/matrix.json plus <runs>/matrix.md are written per the Matrix type.
 * Directions and repetitions default to what the observation directories contain.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const LEVEL_NAMES: Record<number, string> = { 1: "Decision continuity", 2: "Selective continuity", 3: "Executable continuation", 4: "Team coordination", 5: "Sustained continuity" };

interface Args { suite: string; runs: string; conditions: Condition[]; directions: Direction[] | null; repetitions: number | null; kit: string; python: string }

function parseArgs(argv: string[]): Args {
  const a: Args = { suite: "", runs: "", conditions: [], directions: null, repetitions: null, kit: path.join(REPO_ROOT, "eval", "kit", "continuity_eval.py"), python: process.env.PYTHON || "python3" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
    if (k === "--suite") a.suite = path.resolve(v());
    else if (k === "--runs") a.runs = path.resolve(v());
    else if (k === "--conditions") a.conditions = v().split(",").map((s) => s.trim()).filter(Boolean) as Condition[];
    else if (k === "--directions") a.directions = v().split(/[,\s]+/).filter(Boolean) as Direction[];
    else if (k === "--repetitions") a.repetitions = Number(v());
    else if (k === "--kit") a.kit = path.resolve(v());
    else if (k === "--python") a.python = v();
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.suite || !a.runs || !a.conditions.length) throw new Error("usage: compare --suite <dir> --runs <dir> --conditions ours,gbrain [--directions ...] [--repetitions N]");
  for (const c of a.conditions) if (c !== "ours" && c !== "gbrain") throw new Error(`unknown condition ${c}`);
  return a;
}

/** What the observation tree actually holds: directions and the highest repetition index. */
function detect(runs: string, conditions: Condition[]): { directions: Direction[]; repetitions: number } {
  const dirs = new Set<Direction>();
  let reps = 0;
  for (const c of conditions) {
    const obs = path.join(runs, c, "observations");
    if (!fs.existsSync(obs)) continue;
    for (const cs of fs.readdirSync(obs)) {
      const cd = path.join(obs, cs);
      if (!fs.statSync(cd).isDirectory()) continue;
      for (const d of fs.readdirSync(cd)) {
        if (d !== "codex-to-claude" && d !== "claude-to-codex") continue;
        dirs.add(d);
        for (const r of fs.readdirSync(path.join(cd, d))) { const n = Number(r); if (Number.isInteger(n) && n > reps) reps = n; }
      }
    }
  }
  const order: Direction[] = ["codex-to-claude", "claude-to-codex"];
  return { directions: order.filter((d) => dirs.has(d)), repetitions: Math.max(reps, 1) };
}

interface KitResult { case: string; level: number; status: string; checks: { type: string; key?: string; status: string; detail?: string }[]; reason?: string; metrics?: Metrics; direction: Direction; repetition: number }
interface KitReport { suite_sha256: string; provisional_level_on_selected_matrix: number; pilot_level_demonstrated: number | null; protocol: { repetitions: number; directions: string[]; qualification_matrix_selected: boolean }; levels: Record<string, { name: string; passed: number; failed: number; missing_or_unverified: number; total: number; passed_all_observed_cases: boolean }>; results: KitResult[] }

function score(a: Args, condition: Condition, directions: Direction[], repetitions: number): KitReport {
  const out = path.join(a.runs, condition);
  if (!fs.existsSync(path.join(out, "observations"))) throw new Error(`no observations for ${condition} under ${out}`);
  const argv = [a.kit, "score", "--suite", a.suite, "--out", out, "--repetitions", String(repetitions), "--directions", ...directions];
  execFileSync(a.python, argv, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  return JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8")) as KitReport;
}

export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function cellLabel(c: MatrixCell, reason?: string): string {
  if (c.status === "pass") return "pass";
  if (c.status === "fail") {
    const bad = c.checks.filter((k) => k.status === "fail").map((k) => (k.key ? `${k.type}:${k.key}` : k.type));
    return `fail (${bad.join(", ") || "see report"})`;
  }
  if (c.status === "unverified") {
    const missing = c.checks.filter((k) => k.status === "missing").map((k) => (k.key ? `${k.type}:${k.key}` : k.type));
    return `unverified (${missing.join(", ") || reason || "see report"})`;
  }
  return reason ? `not_run (${reason.slice(0, 60)})` : "not_run";
}

function counts(cells: MatrixCell[]) {
  const n = (s: string) => cells.filter((c) => c.status === s).length;
  return { total: cells.length, pass: n("pass"), fail: n("fail"), not_run: n("not_run"), unverified: n("unverified") };
}

export function buildMatrix(reports: Record<Condition, KitReport>, conditions: Condition[]): { matrix: Matrix; reasons: Map<string, string>; highest: Record<Condition, number> } {
  const cells: MatrixCell[] = [];
  const reasons = new Map<string, string>();
  const levels = {} as Matrix["levels"];
  const summary = {} as Matrix["summary"];
  const highest = {} as Record<Condition, number>;
  for (const c of conditions) {
    const rep = reports[c];
    const own: MatrixCell[] = rep.results.map((r) => ({ condition: c, case: r.case, direction: r.direction, repetition: r.repetition, status: r.status, checks: r.checks.map((k) => ({ type: k.type, ...(k.key ? { key: k.key } : {}), status: k.status })), metrics: r.metrics ?? {} }));
    for (const r of rep.results) if (r.reason) reasons.set(`${c}|${r.case}|${r.direction}|${r.repetition}`, r.reason);
    cells.push(...own);
    levels[c] = {};
    for (const [n, l] of Object.entries(rep.levels)) levels[c][Number(n)] = { passed: l.passed, total: l.total, qualified: l.passed_all_observed_cases };
    const k = counts(own);
    summary[c] = {
      pass_rate: k.total ? k.pass / k.total : 0,
      median_boot_tokens: median(own.map((x) => x.metrics.successor_boot_tokens as number).filter((x) => typeof x === "number")),
      median_resume_latency_ms: median(own.map((x) => x.metrics.resume_latency_ms as number).filter((x) => typeof x === "number")),
    };
    highest[c] = rep.provisional_level_on_selected_matrix ?? 0;
  }
  const sha = conditions.map((c) => reports[c].suite_sha256);
  if (new Set(sha).size > 1) throw new Error(`conditions were scored against different suites: ${sha.join(" vs ")}`);
  return { matrix: { generated_at: new Date().toISOString(), suite_sha256: sha[0] ?? "", conditions, cells, levels, summary }, reasons, highest };
}

const fmt = (n: number | null, unit = "") => (n == null ? "n/a" : `${Math.round(n)}${unit}`);

export function renderMarkdown(m: Matrix, reasons: Map<string, string>, highest: Record<Condition, number>, directions: Direction[], repetitions: number, reports: Record<Condition, KitReport>): string {
  const L: string[] = [];
  const conds = m.conditions;
  const cases = [...new Set(m.cells.map((c) => c.case))].sort();
  const levelOf = new Map<string, number>();
  for (const c of conds) for (const r of reports[c].results) levelOf.set(r.case, r.level);
  L.push("# Continuity evaluation matrix", "");
  L.push(`Generated ${m.generated_at}. Suite sha256 \`${m.suite_sha256.slice(0, 16)}…\`. Conditions: ${conds.join(", ")}. Directions: ${directions.join(", ")}. Repetitions: ${repetitions}.`, "");
  L.push("Each cell is the kit's verdict for one trial: pass, fail (failed checks in parentheses), unverified (missing evidence), or not_run (adapter skipped or errored).", "");
  L.push("## Cases", "");
  L.push(`| Case | Level | Direction | Rep | ${conds.join(" | ")} |`);
  L.push(`| --- | --- | --- | --- | ${conds.map(() => "---").join(" | ")} |`);
  for (const cs of cases) for (const d of directions) for (let r = 1; r <= repetitions; r++) {
    const row = conds.map((c) => {
      const cell = m.cells.find((x) => x.condition === c && x.case === cs && x.direction === d && x.repetition === r);
      return cell ? cellLabel(cell, reasons.get(`${c}|${cs}|${d}|${r}`)) : "absent";
    });
    L.push(`| ${cs} | ${levelOf.get(cs) ?? "?"} | ${d} | ${r} | ${row.join(" | ")} |`);
  }
  L.push("", "## Levels", "");
  L.push(`| Level | Capability | ${conds.join(" | ")} |`);
  L.push(`| --- | --- | ${conds.map(() => "---").join(" | ")} |`);
  for (const n of [1, 2, 3, 4, 5]) {
    const row = conds.map((c) => { const l = m.levels[c]?.[n]; return l ? `${l.passed}/${l.total}${l.qualified ? " (all passed)" : ""}` : "n/a"; });
    L.push(`| ${n} | ${LEVEL_NAMES[n]} | ${row.join(" | ")} |`);
  }
  L.push("", "## Trials, cost and latency", "");
  L.push("| Condition | Trials | Pass | Fail | Unverified | Not run | Highest level with all cases passed | Median boot tokens | Median resume latency |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of conds) {
    const k = counts(m.cells.filter((x) => x.condition === c));
    const nBoot = m.cells.filter((x) => x.condition === c && typeof x.metrics.successor_boot_tokens === "number").length;
    const nLat = m.cells.filter((x) => x.condition === c && typeof x.metrics.resume_latency_ms === "number").length;
    L.push(`| ${c} | ${k.total} | ${k.pass} | ${k.fail} | ${k.unverified} | ${k.not_run} | ${highest[c] || "none"} | ${fmt(m.summary[c].median_boot_tokens)} (${nBoot} trials) | ${fmt(m.summary[c].median_resume_latency_ms, " ms")} (${nLat} trials) |`);
  }
  L.push("", "## Summary", "", summaryParagraph(m, highest, directions, repetitions), "");
  return L.join("\n");
}

/** One paragraph that states only what the cells show. */
export function summaryParagraph(m: Matrix, highest: Record<Condition, number>, directions: Direction[], repetitions: number): string {
  const conds = m.conditions;
  const perCase = [...new Set(m.cells.map((c) => c.case))].length;
  const parts: string[] = [];
  const first = conds[0];
  const kFirst = counts(m.cells.filter((x) => x.condition === first));
  parts.push(`This matrix covers ${kFirst.total} trial${kFirst.total === 1 ? "" : "s"} per condition (${perCase} case${perCase === 1 ? "" : "s"} × ${directions.length} direction${directions.length === 1 ? "" : "s"} × ${repetitions} repetition${repetitions === 1 ? "" : "s"}).`);
  for (const c of conds) {
    const k = counts(m.cells.filter((x) => x.condition === c));
    const bits = [`${k.pass} passed`, `${k.fail} failed`];
    if (k.unverified) bits.push(`${k.unverified} unverified`);
    if (k.not_run) bits.push(`${k.not_run} not run`);
    parts.push(`${c}: ${bits.join(", ")}; highest level with every trial passed: ${highest[c] ? `${highest[c]} (${LEVEL_NAMES[highest[c]]})` : "none"}.`);
  }
  const notRun = conds.map((c) => counts(m.cells.filter((x) => x.condition === c)).not_run);
  if (notRun.some((n) => n > 0)) parts.push(`Trials marked not run were skipped or errored by the adapter and count as neither pass nor fail, so levels whose cases were not run cannot be established from this matrix.`);
  const failedCases = (c: Condition) => [...new Set(m.cells.filter((x) => x.condition === c && x.status === "fail").map((x) => x.case))].sort();
  for (const c of conds) { const f = failedCases(c); if (f.length) parts.push(`Failed cases for ${c}: ${f.join(", ")}.`); }
  if (conds.length > 1) {
    const [a, b] = conds;
    const pa = counts(m.cells.filter((x) => x.condition === a)).pass, pb = counts(m.cells.filter((x) => x.condition === b)).pass;
    parts.push(pa === pb ? `${a} and ${b} passed the same number of trials.` : `${pa > pb ? a : b} passed ${Math.abs(pa - pb)} more trial${Math.abs(pa - pb) === 1 ? "" : "s"} than ${pa > pb ? b : a}.`);
  }
  const boots = conds.map((c) => `${c} ${fmt(m.summary[c].median_boot_tokens)}`);
  const lats = conds.map((c) => `${c} ${fmt(m.summary[c].median_resume_latency_ms, " ms")}`);
  parts.push(`Median successor boot tokens: ${boots.join(", ")}; median resume latency: ${lats.join(", ")} (medians over the trials that reported the metric, including failed ones; cost and speed are only meaningful alongside correctness).`);
  const full = repetitions >= 3 && directions.length === 2;
  parts.push(full ? `Both directions with at least three repetitions were run, which is the kit's qualification matrix; results remain a fixture acceptance gate, not a reliability estimate.` : `This selection (${directions.length} direction${directions.length === 1 ? "" : "s"}, ${repetitions} repetition${repetitions === 1 ? "" : "s"}) is smaller than the kit's qualification matrix of both directions × three repetitions, so no pilot level is demonstrated and no percentage here is a reliability estimate.`);
  return parts.join(" ");
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const det = detect(a.runs, a.conditions);
  const directions = a.directions ?? det.directions;
  const repetitions = a.repetitions ?? det.repetitions;
  if (!directions.length) throw new Error(`no observation directories found under ${a.runs}/<condition>/observations`);
  const reports = {} as Record<Condition, KitReport>;
  for (const c of a.conditions) {
    reports[c] = score(a, c, directions, repetitions);
    process.stderr.write(`scored ${c}: ${reports[c].results.length} trials, provisional level ${reports[c].provisional_level_on_selected_matrix}\n`);
  }
  const { matrix, reasons, highest } = buildMatrix(reports, a.conditions);
  fs.mkdirSync(a.runs, { recursive: true });
  fs.writeFileSync(path.join(a.runs, "matrix.json"), JSON.stringify(matrix, null, 2) + "\n");
  fs.writeFileSync(path.join(a.runs, "matrix.md"), renderMarkdown(matrix, reasons, highest, directions, repetitions, reports));
  process.stdout.write(`${path.join(a.runs, "matrix.md")}\n`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch((e) => { process.stderr.write(`compare: ${String(e?.message ?? e)}\n`); process.exitCode = 1; });
