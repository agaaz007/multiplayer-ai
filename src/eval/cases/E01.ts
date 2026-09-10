import fs from "node:fs";
import path from "node:path";
import type { TrialContext } from "../types.js";
import type { EvalCaseRunner } from "./index.js";

/**
 * E01: recover tracked, untracked and deleted files. The adapter copies the bootstrapped worktree
 * into <output_dir>/recovered BEFORE the successor starts (kit rule). This runner only verifies that
 * the copy exists and names it; it never writes into it. A missing bundle is a controller failure
 * and is raised as an error rather than reported as a successor mismatch.
 */
export const E01: EvalCaseRunner = {
  id: "E01",
  async collect(ctx: TrialContext) {
    const dir = path.join(ctx.paths.outputDir, "recovered");
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error("E01: recovered/ bundle missing; the adapter must copy the recovered worktree before the successor runs");
    const n = countFiles(dir);
    ctx.log(`E01: recovered/ present with ${n} files`);
    return { recovered_files: "recovered" };
  },
};

function countFiles(dir: string): number {
  let n = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".git") continue;
    const p = path.join(dir, ent.name);
    n += ent.isDirectory() ? countFiles(p) : 1;
  }
  return n;
}
