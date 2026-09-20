import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { DEFAULT_DENY_GLOBS, DEFAULT_SNAPSHOT_EXCLUDES, globToRegExp } from "./redact.js";
import { forbiddenSnapshotRoot } from "./safety.js";

/**
 * Shadow commits (spec §3.2, v1.1). Capture the exact worktree state onto a
 * hidden ref without touching the user's branch, index, or files.
 *
 *   temp index ← HEAD tree
 *   add -A                         (tracked changes, deletions, untracked non-ignored)
 *   add -f <declared includes>     (gitignored paths the project says it needs)
 *   rm --cached <denied>           (read-tree loaded tracked secrets too; `add` exclusions never remove them)
 *   write-tree, validate no denied path survived, detect files changed mid-read
 *   commit-tree -p <previous shadow | HEAD>, update-ref refs/wip/<author>/<session>, push, ls-remote verify
 *
 * A snapshot only counts as saved when the remote confirms the commit.
 */

export interface ShadowOpts {
  ref: string;                 // refs/wip/<author>/<session>
  parent?: string;             // previous shadow commit; defaults to HEAD
  lastTree?: string;           // skip if unchanged
  deny?: string[];             // extra deny globs
  include?: string[];          // gitignored paths to force-add
  exclude?: string[];          // extra reproducible-path excludes
  remote?: string;             // default "origin"
  push?: boolean;              // default true
  message?: string;
  now?: Date;
  /** Helper worker-owned directory, never the user index. */
  privateIndexDirectory?: string;
}

export interface ShadowResult {
  ok: boolean;
  skipped?: "clean" | "unchanged" | "not_a_repo" | "no_head" | "forbidden_root";
  error?: string;
  tree?: string;
  commit?: string;
  parent?: string;
  pushed?: boolean;
  verified?: boolean;
  verified_at?: string;
  files: { status: string; path: string }[];
  gaps: { kind: string; paths?: string[]; detail?: string }[];
}

/**
 * Git without a terminal. The helper runs under launchd: no TTY, and macOS's
 * osxkeychain credential helper returns nothing there, so an HTTPS push dies
 * with "could not read Username". `gh auth git-credential` answers without a
 * TTY, so remote operations use it when `gh` is installed. Prompts are always
 * disabled so a failure is immediate and lands in capture_gaps, never a hang.
 * Override with continuity.git_credential_helper (any git credential helper string, or "" for git's default).
 */
let credentialArgs: string[] | null = null;
export function gitRemoteArgs(): string[] {
  if (credentialArgs) return credentialArgs;
  const override = process.env.LEDGER_GIT_CREDENTIAL_HELPER;
  if (override !== undefined) return (credentialArgs = override ? ["-c", "credential.helper=", "-c", `credential.helper=${override}`] : []);
  try {
    execFileSync("sh", ["-c", "command -v gh"], { stdio: "ignore" });
    credentialArgs = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
  } catch {
    credentialArgs = [];
  }
  return credentialArgs;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const remote = /^(push|fetch|ls-remote|pull|clone)$/.test(args[0] ?? "");
  const full = remote ? [...gitRemoteArgs(), ...args] : args;
  return execFileSync("git", full, { cwd, env: { ...process.env, GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0", ...env }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 64 << 20 }).toString().trim();
}

export function repoRoot(cwd: string): string | null {
  try { return git(cwd, ["rev-parse", "--show-toplevel"]); } catch { return null; }
}

export function currentBranch(cwd: string): string | null {
  try { return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]); } catch { return null; }
}

export function headCommit(cwd: string): string | null {
  try { return git(cwd, ["rev-parse", "HEAD"]); } catch { return null; }
}

export function remoteUrl(cwd: string, remote = "origin"): string | null {
  try { return git(cwd, ["remote", "get-url", remote]); } catch { return null; }
}

/** Canonical repo identity for thread matching: remote URL without credentials or .git, else the path. */
export function repoIdentity(cwd: string): string {
  const url = remoteUrl(cwd);
  if (url) return canonicalRepoUrl(url);
  return repoRoot(cwd) ?? cwd;
}

/** scheme://user:pass@host/x.git → https://host/x ; git@host:x.git → https://host/x */
export function canonicalRepoUrl(url: string): string {
  let u = url.trim();
  u = u.replace(/^git@([^:]+):/, "https://$1/");
  u = u.replace(/^([a-z+]+:\/\/)[^@/]+@/i, "$1");
  u = u.replace(/\.git$/, "").replace(/\/+$/, "");
  return u;
}

export function shadowCommit(worktree: string, opts: ShadowOpts): ShadowResult {
  const res: ShadowResult = { ok: false, files: [], gaps: [] };
  const root = repoRoot(worktree);
  if (!root) return { ...res, skipped: "not_a_repo" };
  // defence in depth behind the helper's own check: never `add -A` and push a home directory
  const forbidden = forbiddenSnapshotRoot(root);
  if (forbidden) return { ...res, skipped: "forbidden_root", gaps: [{ kind: "forbidden_root", detail: forbidden }] };
  const head = headCommit(root);
  if (!head) return { ...res, skipped: "no_head" };
  const deny = [...DEFAULT_DENY_GLOBS, ...(opts.deny ?? [])];
  const exclude = [...DEFAULT_SNAPSHOT_EXCLUDES, ...(opts.exclude ?? [])];
  const denyRe = deny.map(globToRegExp);
  const excludeRe = exclude.map(globToRegExp);
  const indexDir = opts.privateIndexDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), "ledger-shadow-"));
  fs.mkdirSync(indexDir, { recursive: true, mode: 0o700 });
  const idx = path.join(indexDir, "index");
  const metadata = path.join(indexDir, "identity.json");
  const identity = crypto.createHash("sha256").update(JSON.stringify({ root: fs.realpathSync(root), head, deny, exclude, include: opts.include ?? [] })).digest("hex");
  let reuse = false;
  try { reuse = fs.existsSync(idx) && fs.readFileSync(metadata, "utf8") === identity; } catch { /* new or interrupted cache */ }
  // One worker per worktree owns this index. A killed Git may leave its private lock.
  try { fs.unlinkSync(`${idx}.lock`); } catch { /* absent */ }
  const env = { GIT_INDEX_FILE: idx };
  try {
    if (!reuse) git(root, ["read-tree", head], env);
    git(root, ["add", "-A", "--", "."], env);
    for (const inc of opts.include ?? []) {
      try { git(root, ["add", "-f", "--", inc], env); } catch { res.gaps.push({ kind: "include_missing", paths: [inc] }); }
    }
    // remove denied and reproducible paths from the temp index, whether they arrived via read-tree or add
    const listed = git(root, ["ls-files", "--cached"], env).split("\n").filter(Boolean);
    const toDrop = listed.filter((f) => denyRe.some((r) => r.test(f) || r.test(path.basename(f))) || excludeRe.some((r) => r.test(f)));
    for (let i = 0; i < toDrop.length; i += 200) git(root, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ...toDrop.slice(i, i + 200)], env);

    let tree = git(root, ["write-tree"], env);
    // validate: nothing denied survived
    const inTree = git(root, ["ls-tree", "-r", "--name-only", tree]).split("\n").filter(Boolean);
    const leaked = inTree.filter((f) => denyRe.some((r) => r.test(f) || r.test(path.basename(f))));
    if (leaked.length) return { ...res, error: `denied path in snapshot tree: ${leaked.slice(0, 5).join(", ")}`, gaps: [{ kind: "denied_path_in_tree", paths: leaked }] };

    // files changed while we were reading: index vs worktree
    let changed = git(root, ["diff-files", "--name-only"], env).split("\n").filter(Boolean).filter((f) => !toDrop.includes(f));
    if (changed.length) {
      // one retry after a beat; if still moving, snapshot anyway and say so
      execFileSync("sleep", ["1"]);
      git(root, ["add", "-A", "--", "."], env);
      for (let i = 0; i < toDrop.length; i += 200) git(root, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ...toDrop.slice(i, i + 200)], env);
      tree = git(root, ["write-tree"], env);
      changed = git(root, ["diff-files", "--name-only"], env).split("\n").filter(Boolean).filter((f) => !toDrop.includes(f));
      if (changed.length) res.gaps.push({ kind: "file_changed_during_snapshot", paths: changed.slice(0, 50) });
    }
    const finalPaths = git(root, ["ls-tree", "-r", "--name-only", tree]).split("\n").filter(Boolean);
    const finalLeaks = finalPaths.filter(f => denyRe.some(r => r.test(f) || r.test(path.basename(f))));
    if (finalLeaks.length) return { ...res, error: "denied path appeared during snapshot retry", gaps: [{ kind: "denied_path_in_tree", paths: finalLeaks }] };
    fs.writeFileSync(metadata, identity, { mode: 0o600 });
    res.tree = tree;
    if (opts.lastTree && tree === opts.lastTree) return { ...res, ok: true, skipped: "unchanged" };
    const headTree = git(root, ["rev-parse", `${head}^{tree}`]);
    if (!opts.parent && tree === headTree) return { ...res, ok: true, skipped: "clean" };

    const remote = opts.remote ?? "origin";
    /** The remote's current commit for the wip ref, with its objects present locally, or null. */
    const remoteTip = (): string | null => {
      try {
        const sha = git(root, ["ls-remote", remote, opts.ref]).split(/\s+/)[0];
        if (!/^[0-9a-f]{40}$/.test(sha)) return null;
        try { git(root, ["cat-file", "-e", `${sha}^{commit}`]); } catch { git(root, ["fetch", "--quiet", remote, opts.ref]); }
        return sha;
      } catch { return null; }
    };
    // A restarted helper can lose the previous shadow commit. Continuing from the remote tip keeps the push a fast-forward;
    // parenting on HEAD made every later push of the ref fail as non-fast-forward, so nothing was saved (2026-09-13).
    const parent = opts.parent ?? (opts.push === false ? null : remoteTip()) ?? head;

    const when = (opts.now ?? new Date()).toISOString();
    const msg = opts.message ?? `wip snapshot ${when}`;
    const makeCommit = (p: string): string => {
      const c = git(root, ["commit-tree", tree, "-p", p, "-m", msg], {
        GIT_AUTHOR_NAME: "ledger-helper", GIT_AUTHOR_EMAIL: "helper@ledger.local", GIT_COMMITTER_NAME: "ledger-helper", GIT_COMMITTER_EMAIL: "helper@ledger.local",
      });
      git(root, ["update-ref", opts.ref, c]);
      res.commit = c;
      res.parent = p;
      try {
        res.files = git(root, ["diff-tree", "--no-commit-id", "--name-status", "-r", p, c]).split("\n").filter(Boolean).map((l) => { const [status, ...rest] = l.split("\t"); return { status, path: rest.join("\t") }; });
      } catch { /* first commit or unusual parent */ }
      return c;
    };
    let commit = makeCommit(parent);

    if (opts.push === false) return { ...res, ok: true, pushed: false, verified: false };
    const pushError = (e: any) => String(e?.stderr || e?.message || e);
    try {
      git(root, ["push", "--quiet", remote, `${commit}:${opts.ref}`]);
      res.pushed = true;
    } catch (e: any) {
      // the remote ref is not an ancestor of our parent (a lost or rejected local chain): re-parent once on the remote tip
      const tip = /non-fast-forward|fetch first|rejected/i.test(pushError(e)) ? remoteTip() : null;
      if (!tip || tip === parent) return { ...res, ok: true, pushed: false, verified: false, error: `push failed: ${pushError(e).slice(0, 200)}` };
      commit = makeCommit(tip);
      try {
        git(root, ["push", "--quiet", remote, `${commit}:${opts.ref}`]);
        res.pushed = true;
      } catch (e2: any) {
        return { ...res, ok: true, pushed: false, verified: false, error: `push failed after continuing from the remote tip: ${pushError(e2).slice(0, 200)}` };
      }
    }
    try {
      const remoteSha = git(root, ["ls-remote", remote, opts.ref]).split(/\s+/)[0];
      res.verified = remoteSha === commit;
      if (res.verified) res.verified_at = new Date().toISOString();
      else res.error = `remote ref mismatch: ${remoteSha?.slice(0, 8)} != ${commit.slice(0, 8)}`;
    } catch (e: any) {
      res.verified = false;
      res.error = `ls-remote failed: ${String(e?.stderr || e?.message || e).slice(0, 200)}`;
    }
    return { ...res, ok: true };
  } catch (e: any) {
    return { ...res, error: String(e?.stderr || e?.message || e).slice(0, 300) };
  } finally {
    if (!opts.privateIndexDirectory) try { fs.rmSync(path.dirname(idx), { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

/** Fetch a wip ref and create an isolated worktree at that commit. Returns the worktree path. */
export function checkoutWip(repo: string, ref: string, commit: string, dest: string, remote = "origin"): string {
  git(repo, ["fetch", "--quiet", remote, `${ref}:${ref}`]);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  git(repo, ["worktree", "add", "--detach", dest, commit]);
  return dest;
}

/** `git diff --stat` between two commits, for the resume pack's "what changed since" section. */
export function diffStat(repo: string, from: string, to: string, max = 60): { text: string; truncated: boolean } {
  try {
    const out = git(repo, ["diff", "--stat=120", `${from}..${to}`]);
    const lines = out.split("\n");
    return { text: lines.slice(0, max).join("\n"), truncated: lines.length > max };
  } catch (e: any) {
    return { text: `(diff unavailable: ${String(e?.stderr || e?.message || e).slice(0, 120)})`, truncated: false };
  }
}

export function fetchQuiet(repo: string, remote = "origin"): boolean {
  try { git(repo, ["fetch", "--quiet", remote]); return true; } catch { return false; }
}

export function defaultRemoteBranch(repo: string, remote = "origin"): string {
  try { return git(repo, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]); } catch { return `${remote}/master`; }
}
