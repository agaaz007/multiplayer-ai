import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TrialContext } from "./types.js";

const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
export const GLOBAL_GUIDE_POINTER = "Full format in ~/.claude/ledger.md.";

/** The selected build's packaged guide, never the machine's installed guide. */
export function freezeLedgerGuide(ctx: TrialContext, build: string): { path: string; retainedPath: string; provenancePath: string; sha256: string } {
  // run-hard-handoff freezes guides/ beside the selected build, just as it does prompts/.
  const source = path.resolve(build, "../guides/ledger.md");
  if (!fs.existsSync(source)) throw new Error(`ours: selected build has no packaged guide at ${source}; freeze repository guides/ alongside the build`);
  const bytes = fs.readFileSync(source);
  const digest = sha256(bytes);
  const trialPath = path.join(ctx.paths.configDir, "condition-guides", "ledger.md");
  const retainedPath = path.join(ctx.paths.rawDir, "condition-guides", "ledger.md");
  for (const dest of [trialPath, retainedPath]) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // An already-frozen trial must not silently change which guide the agent can read.
    if (fs.existsSync(dest)) {
      if (!fs.readFileSync(dest).equals(bytes)) throw new Error(`ours: frozen guide differs from selected build: ${dest}`);
    } else fs.writeFileSync(dest, bytes, { mode: 0o600 });
  }
  const provenancePath = path.join(ctx.paths.rawDir, "ours-guide.json");
  fs.writeFileSync(provenancePath, JSON.stringify({
    schema_version: 1, source_kind: "selected-build-repository-guide", build: path.resolve(build),
    source_path: source, source_realpath: fs.realpathSync(source), source_mtime: fs.statSync(source).mtime.toISOString(),
    trial_path: trialPath, retained_path: retainedPath, bytes: bytes.length, sha256: digest,
    captured_at: new Date().toISOString(), byte_equality_verified: true, content_transformations: [],
  }, null, 2) + "\n");
  return { path: trialPath, retainedPath, provenancePath, sha256: digest };
}

/**
 * Reject a selected build that ignored the optional guide path; no source text is rewritten.
 *
 * The invariant is about the POINTER, not the layout: the brief's generated `Rules:` line must point at
 * the frozen trial guide rather than the machine's installed one. That line is found
 * by prefix rather than by index because the header grows — the analytical-scope work (3486dfe) added the
 * activity-summary line, and conflict/authority warnings appear above the rules conditionally, so a
 * fixed `lines[2]` check failed every `ours` trial on a brief that was in fact correctly pointed.
 */
export function assertLocalBriefGuide(rendered: string, guidePath: string): void {
  const lines = rendered.split("\n");
  // The FIRST rules line only: it is the generated one, and it precedes any record content below.
  // Scanning the whole document instead would fail a brief that correctly points at the trial guide
  // but lists a stored record whose own body quotes the global path.
  const rules = lines.find((l) => l.startsWith("Rules: "));
  if (!lines[0]?.startsWith("# Ledger brief (") || lines[1] !== ""
      || !rules?.endsWith(`Full format in \`${guidePath}\`.`)) {
    throw new Error("ours: unrecognized generated brief guide pointer; refusing a global-guide fallback");
  }
}
