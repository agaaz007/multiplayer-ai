import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ledgerHome } from "./store.js";
import { RELEASES_DIR, installSource, type InstallSource } from "./install.js";

/**
 * `ledger deploy`: copy *this* build into a versioned directory under ~/.ledger/bin and install
 * hooks, MCP registrations, the reconciler and the capture helper from that copy.
 *
 *   ~/.ledger/bin/releases/<version>-<utc stamp>-<git sha>[-dirty]/   the package (dist, guides,
 *                                                                     template, prompts, node_modules)
 *   ~/.ledger/bin/current -> releases/<id>                             what the launcher runs
 *   ~/.ledger/bin/ledger                                               `exec node current/dist/cli.js "$@"`
 *
 * Hooks and launchd plists are written by the copy itself (`node <release>/dist/cli.js install all`),
 * so they pin the *versioned* path, never `current`: nothing that runs in the background changes
 * until the next explicit deploy. A build in a worktree is no longer a production deploy.
 *
 * The copy is produced by `npm pack --ignore-scripts` (honours package.json `files`) and
 * `npm ci --omit=dev --ignore-scripts` (exact lockfile, production dependencies only).
 */

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PACKAGE_ROOT = path.resolve(HERE, "..");
const NODE = process.execPath;

export interface ReleaseInfo {
  id: string;
  version: string;
  source: string;
  git: { sha: string | null; branch: string | null; dirty: boolean | null };
  node: string;
  built_at: string;
  dir: string;
}

function gitOut(args: string[]): string | null {
  try { return execFileSync("git", ["-C", PACKAGE_ROOT, ...args], { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).toString().trim(); } catch { return null; }
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function describeSource(): Omit<ReleaseInfo, "id" | "dir" | "built_at"> {
  const pkgFile = path.join(PACKAGE_ROOT, "package.json");
  if (!fs.existsSync(pkgFile)) throw new Error(`no package.json next to dist/: ${PACKAGE_ROOT}`);
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  if (pkg.name !== "@tranzmit/ledger") throw new Error(`not the ledger package: ${pkg.name} at ${PACKAGE_ROOT}`);
  if (!fs.existsSync(path.join(PACKAGE_ROOT, "dist", "cli.js"))) throw new Error(`dist/cli.js missing in ${PACKAGE_ROOT}: run npm run build first`);
  const status = gitOut(["status", "--porcelain", "--untracked-files=no"]);
  return {
    version: String(pkg.version),
    source: PACKAGE_ROOT,
    git: { sha: gitOut(["rev-parse", "--short=7", "HEAD"]), branch: gitOut(["rev-parse", "--abbrev-ref", "HEAD"]), dirty: status === null ? null : status.length > 0 },
    node: process.version,
  };
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 300_000): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, npm_config_update_notifier: "false" } });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})\n${(r.stderr || r.stdout || "").trim().slice(-2000)}`);
  return r.stdout;
}

/** Stage this build under ~/.ledger/bin/releases/<id>. Returns the release, does not install anything. */
export function stageRelease(log: (l: string) => void = () => {}): ReleaseInfo {
  const src = describeSource();
  if (src.source.startsWith(RELEASES_DIR() + path.sep)) throw new Error(`already a release: ${src.source}. Deploy from a source tree.`);
  const id = [src.version, stamp(), src.git.sha ?? "nogit"].join("-") + (src.git.dirty ? "-dirty" : "");
  const dir = path.join(RELEASES_DIR(), id);
  if (fs.existsSync(dir)) throw new Error(`release exists: ${dir}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-pack-"));
  try {
    log(`packing ${src.source} (${src.git.branch ?? "?"} @ ${src.git.sha ?? "?"}${src.git.dirty ? ", dirty" : ""})`);
    const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", tmp], src.source));
    const tgz = path.join(tmp, packed[0].filename);
    run("tar", ["-xzf", tgz, "-C", dir, "--strip-components=1"], dir);
    const lock = path.join(src.source, "package-lock.json");
    if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(dir, "package-lock.json"));
    log(`installing production dependencies into ${dir}`);
    run("npm", fs.existsSync(lock) ? ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"] : ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], dir);
    // Load the copy once: a missing dependency fails here, not in a hook at 2 a.m.
    run(NODE, ["-e", `import(${JSON.stringify(path.join(dir, "dist", "install.js"))}).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })`], dir, 60_000);
    fs.chmodSync(path.join(dir, "dist", "cli.js"), 0o755);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const info: ReleaseInfo = { id, dir, built_at: new Date().toISOString(), ...src };
  fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify(info, null, 2) + "\n");
  return info;
}

/** Point ~/.ledger/bin/current at the release and (re)write the launcher script. */
export function activateRelease(info: ReleaseInfo, log: (l: string) => void = () => {}): string[] {
  const bin = path.join(ledgerHome(), "bin");
  const current = path.join(bin, "current");
  const tmpLink = `${current}.${process.pid}.tmp`;
  fs.rmSync(tmpLink, { force: true });
  fs.symlinkSync(path.join("releases", info.id), tmpLink);
  fs.renameSync(tmpLink, current); // atomic swap
  const launcher = path.join(bin, "ledger");
  fs.writeFileSync(launcher, `#!/bin/sh\n# written by \`ledger deploy\`; runs the release that ~/.ledger/bin/current points at\nexec ${JSON.stringify(NODE)} ${JSON.stringify(path.join(bin, "current", "dist", "cli.js"))} "$@"\n`, { mode: 0o755 });
  log(`current -> releases/${info.id}`);
  return [current, launcher];
}

/** Run `install all` and `helper install` from the release so every written path is the versioned one. */
export function installFromRelease(info: ReleaseInfo, log: (l: string) => void = () => {}): void {
  const cli = path.join(info.dir, "dist", "cli.js");
  for (const args of [["install", "all"], ["helper", "install"]]) {
    log(`$ node ${cli} ${args.join(" ")}`);
    const r = spawnSync(NODE, [cli, ...args], { stdio: "inherit", env: { ...process.env, LEDGER_ALLOW_WORKTREE_INSTALL: undefined } as NodeJS.ProcessEnv, timeout: 180_000 });
    if (r.status !== 0) throw new Error(`${args.join(" ")} failed (exit ${r.status})`);
  }
}

export interface DeployStatusLine { what: string; cli: string | null; source: InstallSource | null; }

function cliFromCommand(cmd: string | undefined): string | null {
  if (!cmd) return null;
  const m = cmd.match(/(?:^|\s)"?([^"\s]*cli\.js)"?/);
  return m ? m[1] : null;
}

function plistCli(file: string): string | null {
  try {
    const xml = fs.readFileSync(file, "utf8");
    const m = xml.match(/<string>([^<]*cli\.js)<\/string>/);
    return m ? m[1] : null;
  } catch { return null; }
}

/** What every installed entry point on this machine executes right now. */
export function deployStatus(): DeployStatusLine[] {
  const home = os.homedir();
  const lines: DeployStatusLine[] = [];
  const add = (what: string, cli: string | null) => lines.push({ what, cli, source: cli ? installSource(cli) : null });
  add("launchd helper", plistCli(path.join(home, "Library", "LaunchAgents", "com.tranzmit.ledger.helper.plist")));
  add("launchd reconciler", plistCli(path.join(home, "Library", "LaunchAgents", "com.tranzmit.ledger.reconcile.plist")));
  try {
    const hb = JSON.parse(fs.readFileSync(path.join(ledgerHome(), "helper-heartbeat.json"), "utf8"));
    add(`helper process (pid ${hb.pid})`, hb.cli ?? null);
  } catch { add("helper process", null); }
  for (const [label, file] of [["claude hooks", path.join(home, ".claude", "settings.json")], ["codex hooks", path.join(home, ".codex", "hooks.json")]] as const) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      const clis = new Set<string>();
      for (const list of Object.values<any>(j.hooks ?? {})) for (const entry of list) for (const h of entry.hooks ?? []) { const c = cliFromCommand(h.command); if (c) clis.add(c); }
      if (!clis.size) add(label, null); else for (const c of clis) add(label, c);
    } catch { add(label, null); }
  }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    const s = j?.mcpServers?.ledger;
    add("claude MCP (user scope)", s ? (s.args ?? []).find((a: string) => a.endsWith("cli.js")) ?? cliFromCommand(s.command) : null);
  } catch { add("claude MCP (user scope)", null); }
  try {
    const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    const block = toml.match(/\[mcp_servers\.ledger\][^[]*/m)?.[0] ?? "";
    add("codex MCP", cliFromCommand(block.match(/"([^"]*cli\.js)"/)?.[1]));
  } catch { add("codex MCP", null); }
  return lines;
}

export function formatDeployStatus(lines: DeployStatusLine[]): string[] {
  const out: string[] = [];
  let unstable = 0;
  for (const l of lines) {
    if (!l.cli) { out.push(`  ${l.what.padEnd(26)} (not installed)`); continue; }
    const s = l.source!;
    const tag = s.release ? "release" : s.packaged ? "packaged" : s.worktree ? `WORKTREE ${s.worktree}` : "plain";
    if (!s.stable) unstable++;
    out.push(`  ${l.what.padEnd(26)} ${s.stable ? "✓" : "✗"} ${tag}\n${" ".repeat(29)}${s.cli}`);
  }
  out.push(unstable ? `${unstable} entry point(s) still run from a git worktree; run \`ledger deploy\` from the tree you want live.` : "every entry point runs from a stable path.");
  return out;
}

export function listReleases(): string[] {
  try { return fs.readdirSync(RELEASES_DIR()).filter((n) => !n.startsWith(".")).sort(); } catch { return []; }
}
