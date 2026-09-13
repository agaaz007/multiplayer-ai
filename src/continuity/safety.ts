import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Guards shared by the helper and the MCP tools, from the 2026-09-13 north-star review:
 *
 *   resolveHarnessSession   which harness session an MCP call belongs to; never a made-up id
 *   forbiddenSnapshotRoot   a git root that would sweep up far more than a project ($HOME or an ancestor)
 *   autoBindEligible        a session adopts an existing own thread only if the thread predates it
 *   threadTitleFor          a first prompt too short to name the work ("pwd") does not become the title
 */

/** Checked in order when a tool call does not pass session_id. Claude Code exports CLAUDE_CODE_SESSION_ID. */
export const SESSION_ENV_VARS = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_THREAD_ID"] as const;

export type SessionResolution =
  | { ok: true; id: string; source: "explicit" | (typeof SESSION_ENV_VARS)[number] }
  | { ok: false; error: string };

/**
 * An explicit session_id wins. Otherwise an environment id is used only when a local transcript
 * exists for it, because the MCP server's environment is fixed at startup and can outlive the
 * session (/clear, resume). With neither, the caller must refuse: a claim or binding written for a
 * synthetic id is never picked up by the helper, and the successor's work lands on another thread.
 */
export function resolveHarnessSession(given: string | undefined | null, env: NodeJS.ProcessEnv, hasTranscript: (id: string) => boolean): SessionResolution {
  const explicit = String(given ?? "").trim();
  if (explicit) return { ok: true, id: explicit, source: "explicit" };
  const unmatched: string[] = [];
  for (const name of SESSION_ENV_VARS) {
    const v = String(env[name] ?? "").trim();
    if (!v) continue;
    if (hasTranscript(v)) return { ok: true, id: v, source: name };
    unmatched.push(`${name}=${v.slice(0, 8)}… has no local transcript`);
  }
  return {
    ok: false,
    error:
      `No harness session id. Pass session_id (SessionStart prints it as "Ledger session: <id>")` +
      (unmatched.length ? `; ${unmatched.join("; ")}` : `; none of ${SESSION_ENV_VARS.join(", ")} is set`) +
      `. Nothing was claimed or bound.`,
  };
}

/** Where both harnesses write transcripts. */
export function transcriptRoots(): { claude: string; codex: string } {
  return { claude: path.join(os.homedir(), ".claude", "projects"), codex: path.join(os.homedir(), ".codex", "sessions") };
}

/** True when a Claude (<project>/<id>.jsonl) or Codex (…/rollout-…-<id>.jsonl) transcript exists for this id. */
export function localTranscriptExists(id: string, roots = transcriptRoots()): boolean {
  if (!/^[A-Za-z0-9_-]{8,}$/.test(id)) return false;
  try {
    for (const proj of fs.readdirSync(roots.claude, { withFileTypes: true })) {
      if (proj.isDirectory() && fs.existsSync(path.join(roots.claude, proj.name, `${id}.jsonl`))) return true;
    }
  } catch { /* no Claude root on this machine */ }
  const walk = (dir: string, depth: number): boolean => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.isDirectory()) { if (depth > 0 && walk(path.join(dir, e.name), depth - 1)) return true; }
      else if (e.name.endsWith(`${id}.jsonl`)) return true;
    }
    return false;
  };
  return walk(roots.codex, 4);
}

const realOrResolved = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/**
 * Why a git root must never be shadow-committed, or null. `git add -A` at the home directory (or an
 * ancestor of it) would stage dotfiles, credentials and unrelated projects and push them to whatever
 * remote that repo has. There is no override: work in a project checkout instead.
 */
export function forbiddenSnapshotRoot(root: string, home = os.homedir()): string | null {
  const r = realOrResolved(root), h = realOrResolved(home);
  if (r === h) return `git root ${r} is the home directory`;
  if (h.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return `git root ${r} contains the home directory`;
  return null;
}

/** Clock slack between the machine that created a thread and the session's own timestamps. */
export const AUTO_BIND_SLACK_MS = 60_000;

/**
 * Auto-bind (spec §8) lets a session continue its author's open thread on the same repo and branch.
 * A thread created after the session started is later work: a stale session found on a helper
 * restart must not adopt it, and must not take its claim. Unknown start time is not eligible.
 */
export function autoBindEligible(sessionStartedAtMs: number | null | undefined, threadCreatedAt: Date | string): boolean {
  if (sessionStartedAtMs == null || !Number.isFinite(sessionStartedAtMs)) return false;
  return new Date(threadCreatedAt).getTime() <= sessionStartedAtMs + AUTO_BIND_SLACK_MS;
}

export const TITLE_MIN_WORDS = 3;

/** The first human instruction names the thread only when it has at least TITLE_MIN_WORDS words. */
export function threadTitleFor(firstInstruction: string | undefined | null, repo: string, sessionId: string): string {
  const t = String(firstInstruction ?? "").trim();
  if (t.split(/\s+/).filter(Boolean).length >= TITLE_MIN_WORDS) return t;
  return `${path.basename(repo) || "repo"} work (session ${sessionId.slice(0, 8)})`;
}
