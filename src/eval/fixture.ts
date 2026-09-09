import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { initLedger, type Config } from "../store.js";
import { closePools, getPool, migrate } from "../continuity/db.js";
import { redactText } from "../continuity/redact.js";
import type { AdapterRequest, Condition, Direction, Harness, PublicCase, TrialContext, TrialPaths } from "./types.js";
import { defaultModel, evalTmpRoot, harnessEnv } from "./harness.js";

/**
 * Disposable trial resources. Everything a trial touches lives under
 * `${TMPDIR:-/tmp}/ledger-eval/<trial_id>/` (the production helper on this machine
 * excludes that prefix), except the evidence bundle, which is the runner's
 * `output_dir`. Nothing here reads or writes ~/.ledger: initLedger is called with
 * LEDGER_CONFIG_DIR pointed at the trial's own config dir.
 *
 * Layout:
 *   repo/          origin worktree: git init -b master, README.md committed, obsolete.txt committed when
 *                  the case setup names it and then deleted from the worktree when the setup says so;
 *                  tracked seed files committed with placeholder content and modified to the seed content
 *                  in the worktree (ADAPTER.md: "Initialize layout.json as tracked, then modify it");
 *                  generated/** seeds untracked and gitignored (policy-included via continuity.include)
 *   remote.git/    bare remote with the initial commit on master
 *   successor/     fresh clone of the bare remote
 *   ledger/        disposable ledger repo (initLedger, git_sync false)
 *   config/        LEDGER_CONFIG_DIR: config.json + whatever the hooks/helper/MCP write
 *   home/          per-trial HOME material (gbrain, per-trial CODEX_HOME)
 */

export const DEFAULT_EVAL_DB = "postgresql://localhost:5432/ledger_eval";

export function evalDatabaseUrl(): string {
  return process.env.LEDGER_EVAL_DB || DEFAULT_EVAL_DB;
}

export interface CreateTrialOptions {
  evalDatabaseUrl?: string;
  evalRoot?: string;
  originModel?: string;
  successorModel?: string;
  /** extra log sink; raw/controller.log always receives the redacted line */
  log?: (line: string) => void;
  /** run migrate() on the eval database (once per process per URL). Default true. */
  migrate?: boolean;
  /** apply the case setup now (seed files, obsolete.txt deletion). Default true; call applyCaseSetup later otherwise. */
  applySetup?: boolean;
  /** "modify": tracked seeds committed as placeholders then modified in the worktree (default). "commit": seed content committed. */
  seedMode?: "modify" | "commit";
}

export function harnessesFor(direction: Direction): { origin: Harness; successor: Harness } {
  return direction === "codex-to-claude" ? { origin: "codex", successor: "claude" } : { origin: "claude", successor: "codex" };
}

/** Rachit works in Codex, Agaaz in Claude; the origin author follows the origin harness. */
export function authorsFor(direction: Direction): { origin: string; successor: string } {
  return harnessesFor(direction).origin === "codex" ? { origin: "rachit", successor: "agaaz" } : { origin: "agaaz", successor: "rachit" };
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "ledger-eval",
  GIT_AUTHOR_EMAIL: "eval@ledger.local",
  GIT_COMMITTER_NAME: "ledger-eval",
  GIT_COMMITTER_EMAIL: "eval@ledger.local",
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env: { ...process.env, ...GIT_ENV } })
    .toString()
    .trim();
}

export function safeTrialId(id: string): string {
  const s = String(id ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  if (!s) throw new Error("trial_id is empty");
  return s;
}

export function setupMentions(c: PublicCase, re: RegExp): boolean {
  return (c.setup ?? []).some((s) => re.test(s));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A seed file the setup keeps out of git: anything under generated/, or one the setup says to keep untracked. */
export function isUntrackedSeed(rel: string, c: PublicCase): boolean {
  return rel.startsWith("generated/") || setupMentions(c, new RegExp(`keep\\s+${escapeRe(rel)}\\s+untracked`, "i"));
}

export function placeholderFor(rel: string): string {
  return rel.endsWith(".json") ? "{}\n" : `placeholder for ${rel}\n`;
}

function writeRel(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new Error(`seed path escapes the repo: ${rel}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function makeLog(rawDir: string, extra?: (line: string) => void): (line: string) => void {
  const file = path.join(rawDir, "controller.log");
  return (line: string) => {
    const red = redactText(String(line)).text;
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${red}\n`);
    } catch {
      /* raw dir gone (after cleanup) */
    }
    extra?.(red);
  };
}

function withConfigDir<T>(dir: string, fn: () => T): T {
  const prev = process.env.LEDGER_CONFIG_DIR;
  process.env.LEDGER_CONFIG_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.LEDGER_CONFIG_DIR;
    else process.env.LEDGER_CONFIG_DIR = prev;
  }
}

export function trialConfigPath(ctx: TrialContext): string {
  return path.join(ctx.paths.configDir, "config.json");
}

/** The trial's config.json; switch `author` between the origin and the successor with this. Returns the file path. */
export function writeTrialConfig(ctx: TrialContext, author: string): string {
  const cfg: Config = {
    ledger_dir: ctx.paths.ledgerDir,
    author,
    git_sync: false,
    continuity: {
      database_url: ctx.evalDatabaseUrl,
      machine: `eval-${safeTrialId(ctx.request.trial_id)}`,
      include: ["generated/**"],
      classify: true,
    },
  };
  fs.mkdirSync(ctx.paths.configDir, { recursive: true });
  const file = trialConfigPath(ctx);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return file;
}

export function readTrialConfig(ctx: TrialContext): Config {
  return JSON.parse(fs.readFileSync(trialConfigPath(ctx), "utf8")) as Config;
}

/**
 * Child-process env for anything run inside the trial: LEDGER_EVAL=1 and LEDGER_CONFIG_DIR=<trial config dir>
 * (the hooks, helper, and MCP server read them), machine-level ledger overrides and our own Claude session
 * identity stripped. Every origin and successor process goes through this.
 */
export function trialEnv(ctx: TrialContext, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return harnessEnv(process.env, { LEDGER_EVAL: "1", LEDGER_CONFIG_DIR: ctx.paths.configDir, ...extra });
}

/** `{"mcpServers":{}}` for `--mcp-config … --strict-mcp-config`: no user-level MCP servers reach the harness. */
export function writeEmptyMcpConfig(ctx: TrialContext, name = "mcp-empty.json"): string {
  const file = path.join(ctx.paths.configDir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }) + "\n");
  return file;
}

const migrated = new Set<string>();

/** Idempotent schema migration on the eval database, once per process per URL. */
export async function ensureMigrated(ctx: TrialContext): Promise<boolean> {
  const url = ctx.evalDatabaseUrl;
  if (migrated.has(url)) return false;
  const cfg: Config = { ledger_dir: ctx.paths.ledgerDir, author: ctx.originAuthor, git_sync: false, continuity: { database_url: url } };
  const created = await migrate(getPool(cfg));
  migrated.add(url);
  ctx.log(`eval database ready: ${url.replace(/\/\/[^@]*@/, "//…@")} (${created.length} tables created)`);
  return true;
}

export { closePools as closeEvalPools };

export interface SetupApplied {
  trackedSeeds: string[];
  untrackedSeeds: string[];
  obsoleteDeleted: boolean;
}

/** Filesystem application of the case setup in the origin worktree: seed contents and the obsolete.txt deletion. */
export function applyCaseSetup(ctx: TrialContext): SetupApplied {
  const c = ctx.request.case;
  const repo = ctx.paths.repo;
  const out: SetupApplied = { trackedSeeds: [], untrackedSeeds: [], obsoleteDeleted: false };
  for (const [rel, content] of Object.entries(c.seed_files ?? {})) {
    writeRel(repo, rel, content);
    (isUntrackedSeed(rel, c) ? out.untrackedSeeds : out.trackedSeeds).push(rel);
  }
  const obsolete = path.join(repo, "obsolete.txt");
  if (setupMentions(c, /obsolete\.txt[^.]*\bdelete|delete[^.]*\bobsolete\.txt/i) && fs.existsSync(obsolete)) {
    fs.rmSync(obsolete);
    out.obsoleteDeleted = true;
  }
  ctx.log(`setup applied: tracked=${JSON.stringify(out.trackedSeeds)} untracked=${JSON.stringify(out.untrackedSeeds)} obsolete_deleted=${out.obsoleteDeleted}`);
  return out;
}

export async function createTrial(request: AdapterRequest, condition: Condition, opts: CreateTrialOptions = {}): Promise<TrialContext> {
  // This process is an eval process from here on: src/store.ts saveConfig() throws under LEDGER_EVAL=1 unless
  // LEDGER_CONFIG_DIR is set, so a stray initLedger/saveConfig can never repoint ~/.ledger/config.json again.
  process.env.LEDGER_EVAL = "1";
  const trialId = safeTrialId(request.trial_id);
  const evalRoot = path.resolve(opts.evalRoot ?? evalTmpRoot());
  const root = path.join(evalRoot, trialId);
  const outputDir = path.resolve(request.output_dir);
  const paths: TrialPaths = {
    root,
    repo: path.join(root, "repo"),
    bare: path.join(root, "remote.git"),
    successorRepo: path.join(root, "successor"),
    ledgerDir: path.join(root, "ledger"),
    configDir: path.join(root, "config"),
    homeDir: path.join(root, "home"),
    rawDir: path.join(outputDir, "raw"),
    outputDir,
  };
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  for (const d of [root, paths.repo, paths.bare, paths.ledgerDir, paths.configDir, paths.homeDir, paths.rawDir]) fs.mkdirSync(d, { recursive: true });

  const harnesses = harnessesFor(request.direction);
  const authors = authorsFor(request.direction);
  const log = makeLog(paths.rawDir, opts.log);
  const ctx: TrialContext = {
    request,
    condition,
    paths,
    originHarness: harnesses.origin,
    successorHarness: harnesses.successor,
    originAuthor: authors.origin,
    successorAuthor: authors.successor,
    originModel: opts.originModel ?? defaultModel(harnesses.origin, "origin"),
    successorModel: opts.successorModel ?? defaultModel(harnesses.successor, "successor"),
    evalDatabaseUrl: opts.evalDatabaseUrl ?? evalDatabaseUrl(),
    log,
  };
  log(`trial ${trialId}: case=${request.case.id} direction=${request.direction} condition=${condition} origin=${harnesses.origin}/${authors.origin}/${ctx.originModel} successor=${harnesses.successor}/${authors.successor}/${ctx.successorModel} root=${root}`);

  // origin worktree with its initial commit
  const c = request.case;
  const repo = paths.repo;
  git(repo, "init", "--quiet", "-b", "master");
  fs.writeFileSync(path.join(repo, "README.md"), `# ${c.id} fixture\n\nDisposable evaluation repository for trial ${trialId}.\n`);
  const withObsolete = setupMentions(c, /obsolete\.txt/i);
  if (withObsolete) fs.writeFileSync(path.join(repo, "obsolete.txt"), "obsolete content: the origin removes this file\n");
  const seeds = Object.entries(c.seed_files ?? {});
  const untrackedDirs = new Set<string>();
  for (const [rel] of seeds) if (isUntrackedSeed(rel, c)) untrackedDirs.add(rel.includes("/") ? rel.split("/")[0] + "/" : rel);
  if (untrackedDirs.size) fs.writeFileSync(path.join(repo, ".gitignore"), [...untrackedDirs].join("\n") + "\n");
  const seedMode = opts.seedMode ?? "modify";
  for (const [rel, content] of seeds) {
    if (isUntrackedSeed(rel, c)) continue;
    writeRel(repo, rel, seedMode === "commit" ? content : placeholderFor(rel));
  }
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "initial fixture");
  const initialCommit = git(repo, "rev-parse", "HEAD");

  // bare remote, pushed; fresh clone for the successor
  git(paths.bare, "init", "--quiet", "--bare", "-b", "master");
  git(repo, "remote", "add", "origin", paths.bare);
  git(repo, "push", "--quiet", "-u", "origin", "master");
  git(root, "clone", "--quiet", paths.bare, paths.successorRepo);
  log(`repo initialised at ${initialCommit.slice(0, 12)}: obsolete.txt=${withObsolete} seeds=${seeds.length} (${seedMode}) remote=${paths.bare} successor clone=${paths.successorRepo}`);

  if (opts.applySetup !== false) applyCaseSetup(ctx);

  // disposable ledger + trial config (never ~/.ledger): LEDGER_CONFIG_DIR points at the trial config dir for the
  // initLedger call (which ends in saveConfig) and is restored to whatever it was afterwards
  withConfigDir(paths.configDir, () => initLedger(paths.ledgerDir, authors.origin));
  writeTrialConfig(ctx, authors.origin);
  log(`ledger initialised at ${paths.ledgerDir}; config at ${trialConfigPath(ctx)} author=${authors.origin}`);

  if (opts.migrate !== false) await ensureMigrated(ctx);
  return ctx;
}

/** Remove the trial root (repo, remote, successor clone, ledger, config, home). The evidence bundle (output_dir) is never touched. */
export async function cleanupTrial(ctx: TrialContext, opts: { keep?: boolean } = {}): Promise<{ removed: boolean; root: string }> {
  const root = ctx.paths.root;
  const keep = opts.keep ?? process.env.LEDGER_EVAL_KEEP === "1";
  if (keep) {
    ctx.log(`cleanup skipped (keep): ${root}`);
    return { removed: false, root };
  }
  const expected = safeTrialId(ctx.request.trial_id);
  if (path.basename(root) !== expected || path.dirname(root) === path.parse(root).root) throw new Error(`refusing to remove unexpected trial root: ${root}`);
  fs.rmSync(root, { recursive: true, force: true });
  ctx.log(`cleanup: removed ${root}`);
  return { removed: true, root };
}
