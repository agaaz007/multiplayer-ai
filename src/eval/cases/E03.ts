import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EvalCaseRunner } from "./index.js";

interface LayoutCheck {
  viewport_height: number;
  content_height: number;
  cta_top: number;
  cta_bottom: number;
  bottom_clearance: number;
  passed: boolean;
}

interface LayoutValidation {
  passed: boolean;
  failures: string[];
  checks: LayoutCheck[];
}

/**
 * Controller-only validation, called AFTER the successor exits. The kit remains the
 * official scorer; this independent calculation leaves inspectable numeric evidence
 * alongside its verdict. Never run a script or trust a test result supplied by the agent.
 * Nothing from this function is added to the successor's prompt or working directory.
 */
export function validateCompletedLayout(value: unknown): LayoutValidation {
  const failures: string[] = [];
  const checks: LayoutCheck[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { passed: false, failures: ["layout.json must contain an object"], checks };
  }
  const cfg = value as Record<string, unknown>;
  const keys = ["price_inr", "cta_height", "safe_bottom", "content_gap"] as const;
  for (const key of keys) {
    if (typeof cfg[key] !== "number" || !Number.isFinite(cfg[key])) failures.push(`${key} must be a finite JSON number`);
  }
  if (failures.length) return { passed: false, failures, checks };
  const numeric = cfg as Record<typeof keys[number], number>;
  if (numeric.price_inr !== 199) failures.push("price_inr changed from 199");
  if (numeric.cta_height !== 48) failures.push("cta_height changed from 48");
  if (numeric.content_gap !== 24) failures.push("content_gap changed from 24");
  if (numeric.safe_bottom !== 20) failures.push("safe_bottom must be 20");
  for (const viewport of [480, 640, 800]) {
    for (const content of [100, 470, 760, 1200]) {
      const top = Math.min(content + numeric.content_gap, viewport - numeric.safe_bottom - numeric.cta_height);
      const bottom = top + numeric.cta_height;
      const passed = top >= 0 && bottom <= viewport - 20;
      checks.push({ viewport_height: viewport, content_height: content, cta_top: top, cta_bottom: bottom, bottom_clearance: viewport - bottom, passed });
    }
  }
  if (checks.some((check) => !check.passed)) failures.push("CTA violates a viewport/content check");
  return { passed: failures.length === 0, failures, checks };
}

interface LayoutArtifact {
  path: string;
  sha256: string | null;
  bytes: number | null;
  validation: LayoutValidation;
}

function digest(bytes: string | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readLayout(outputDir: string, folder: string): LayoutArtifact {
  const relative = `${folder}/layout.json`;
  const filename = path.join(outputDir, folder, "layout.json");
  const artifact: LayoutArtifact = { path: relative, sha256: null, bytes: null, validation: { passed: false, failures: [], checks: [] } };
  try {
    // A successor-created symlink must never cause the collector to read outside the bundle.
    if (!fs.lstatSync(filename).isFile()) throw new Error("layout.json is not a regular file");
    const bytes = fs.readFileSync(filename);
    artifact.sha256 = digest(bytes);
    artifact.bytes = bytes.length;
    artifact.validation = validateCompletedLayout(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    artifact.validation.failures.push(code === "ENOENT" ? "layout.json is missing" : error instanceof SyntaxError ? "layout.json is invalid JSON" : String((error as Error).message));
  }
  return artifact;
}

/**
 * The adapter creates recovered/ before the successor and final/ after it. Only missing
 * controller bundles (or a source checkpoint that was already fixed) are infrastructure
 * errors. Missing, malformed or incorrect successor output remains a completed trial,
 * with final_files set, so the official scorer reports the actual failure.
 */
export const E03: EvalCaseRunner = {
  id: "E03",
  async collect(ctx) {
    for (const folder of ["recovered", "final"]) {
      const dir = path.join(ctx.paths.outputDir, folder);
      if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) throw new Error(`E03: ${folder}/ bundle missing; the adapter must copy the worktree ${folder === "recovered" ? "before" : "after"} the successor runs`);
    }
    const recovered = readLayout(ctx.paths.outputDir, "recovered");
    const final = readLayout(ctx.paths.outputDir, "final");
    const seed = ctx.request.case.seed_files?.["layout.json"];
    const expectedSeedHash = seed === undefined ? null : digest(seed);
    const sourceMatchesSeed = expectedSeedHash !== null && recovered.sha256 === expectedSeedHash;
    const changed = recovered.sha256 !== final.sha256;
    const report = {
      version: 1,
      validated_at: new Date().toISOString(),
      validator: "controller numeric layout check; no successor-authored code executed",
      condition: ctx.condition,
      expected_seed_sha256: expectedSeedHash,
      recovered_matches_seed: sourceMatchesSeed,
      source_already_completed: recovered.validation.passed,
      successor_changed_layout: changed,
      completion_passed: final.validation.passed && !recovered.validation.passed && changed && (ctx.condition !== "ours" || sourceMatchesSeed),
      recovered,
      final,
    };
    fs.mkdirSync(ctx.paths.rawDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.paths.rawDir, "e03-validation.json"), JSON.stringify(report, null, 2) + "\n");
    ctx.log(`E03: recovered_matches_seed=${sourceMatchesSeed} changed=${changed} final_passed=${final.validation.passed}; ${final.validation.checks.filter((check) => check.passed).length}/${final.validation.checks.length} numeric checks; raw/e03-validation.json`);
    if (recovered.validation.passed || (ctx.condition === "ours" && !sourceMatchesSeed)) {
      throw new Error("E03: source checkpoint did not preserve the unfinished seed; this trial cannot establish successor task completion (see raw/e03-validation.json)");
    }
    return { recovered_files: "recovered", final_files: "final" };
  },
};
