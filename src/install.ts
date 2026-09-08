import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ledgerHome } from "./store.js";

/**
 * What the agent reads, and what runs around it.
 *
 * Guide: one file, `guides/ledger.md`, installed two ways.
 *   Claude Code  ~/.claude/ledger.md, imported from ~/.claude/CLAUDE.md by a
 *                single `@~/.claude/ledger.md` line inside a marked block.
 *   Codex        AGENTS.md has no import syntax, so the guide text itself
 *                goes inside the marked block in ~/.codex/AGENTS.md.
 * The marked block is replaced on every install, so guide upgrades reach
 * both agents by re-running `ledger install`. Pattern borrowed from Code
 * Almanac (Apache-2.0), which installs ~/.claude/almanac.md the same way.
 *
 * Hooks (Claude Code and Codex): the checkpoint loop in hooks.ts.
 * Every entry is `ledger hook <event>`, one per event, replaced on install.
 */

const MARK_START = "<!-- ledger:start -->";
const MARK_END = "<!-- ledger:end -->";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const GUIDE_FILE = path.resolve(HERE, "..", "guides", "ledger.md");

/**
 * Hooks and the MCP server are launched by the agent process, whose PATH is
 * whatever Conductor, the Codex app, or a launchd job happened to inherit.
 * `ledger` lives in an nvm bin dir that is often not on that PATH. So every
 * installed command is absolute: this node binary, this cli.js. Re-run
 * `ledger install` after upgrading node or the package.
 */
const NODE = process.execPath;
const CLI = path.resolve(HERE, "cli.js");
const q = (s: string) => (/[\s"]/.test(s) ? JSON.stringify(s) : s);
export function ledgerCommand(...args: string[]): string {
  return [q(NODE), q(CLI), ...args].join(" ");
}

/** One command hook per lifecycle event. PostToolUse is filtered further inside hooks.ts. */
export const HOOK_EVENTS: Record<string, { matcher?: string; timeout: number }> = {
  SessionStart: { timeout: 30 },
  PostToolUse: { matcher: "mcp__.*|Bash", timeout: 10 },
  Stop: { timeout: 10 },
  PreCompact: { timeout: 10 },
  SessionEnd: { timeout: 10 },
};

/** Ours, in any form we have ever installed: bare `ledger hook`, `ledger brief --hook`, or absolute node + cli.js. */
export function isLedgerHookCommand(cmd: unknown): boolean {
  const c = String(cmd ?? "");
  return /(^|[\s/])ledger (hook|brief)\b/.test(c) || /cli\.js"? (hook|brief)\b/.test(c);
}

export function guideText(): string {
  return fs.readFileSync(GUIDE_FILE, "utf8");
}

function claudeImportBlock(): string {
  return `${MARK_START}
@~/.claude/ledger.md
${MARK_END}`;
}

function codexBlock(): string {
  return `${MARK_START}
${guideText().trim()}
${MARK_END}`;
}

function upsertBlock(file: string, block: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const s = cur.indexOf(MARK_START);
  const e = cur.indexOf(MARK_END);
  if (s !== -1 && e !== -1) {
    cur = cur.slice(0, s) + block + cur.slice(e + MARK_END.length);
    fs.writeFileSync(file, cur);
    return `updated ${file}`;
  }
  fs.writeFileSync(file, (cur.trimEnd() + "\n\n" + block + "\n").replace(/^\n+/, ""));
  return `appended to ${file}`;
}

/** Refresh agent instructions without changing MCP registrations or trusted hooks. */
export function installGuides(target: "claude" | "codex" | "all" = "all"): string[] {
  const home = os.homedir();
  const log: string[] = [];
  if (target === "claude" || target === "all") {
    const dst = path.join(home, ".claude", "ledger.md");
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, guideText());
    log.push(`wrote ${dst}`);
    log.push(upsertBlock(path.join(home, ".claude", "CLAUDE.md"), claudeImportBlock()));
  }
  if (target === "codex" || target === "all") {
    log.push(upsertBlock(path.join(home, ".codex", "AGENTS.md"), codexBlock()));
  }
  return log;
}

function tryExec(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

const isOurs = (h: any) => isLedgerHookCommand(h?.command);

/** Replace ledger's entry for every event; leave other people's hooks alone. Returns what changed. */
export function upsertHooks(settings: any): string[] {
  const log: string[] = [];
  settings.hooks = settings.hooks ?? {};
  for (const [event, spec] of Object.entries(HOOK_EVENTS)) {
    const list: any[] = settings.hooks[event] ?? [];
    const kept = list.filter((entry) => !(entry.hooks ?? []).some(isOurs));
    const entry: any = { hooks: [{ type: "command", command: ledgerCommand("hook", event), timeout: spec.timeout }] };
    if (spec.matcher) entry.matcher = spec.matcher;
    const before = JSON.stringify(list);
    settings.hooks[event] = [...kept, entry];
    if (JSON.stringify(settings.hooks[event]) !== before) log.push(event);
  }
  return log;
}

// ---------- the periodic reconciler ----------

const LAUNCHD_LABEL = "com.tranzmit.ledger.reconcile";
export const RECONCILE_INTERVAL_S = 30 * 60;

/**
 * Sessions that die (crash, closed terminal, sleep) never reach SessionEnd,
 * so a scheduler runs `ledger reconcile` every 30 minutes; it only touches
 * sessions whose journal shows capture debt and whose transcript has been
 * quiet for 20 minutes. macOS: a LaunchAgent. Elsewhere: a cron line to add.
 * LEDGER_NO_LAUNCHD=1 writes the plist without loading it (tests, sandboxes).
 */
export function installReconciler(): string[] {
  const log: string[] = [];
  const home = os.homedir();
  const logFile = path.join(ledgerHome(), "reconcile.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const cmdArgs = [NODE, CLI, "reconcile"];
  if (process.platform !== "darwin") {
    log.push(`reconciler: add to cron: */30 * * * * ${cmdArgs.map(q).join(" ")} >> ${logFile} 2>&1`);
    return log;
  }
  const plist = path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${cmdArgs.map((a) => `<string>${a.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`).join("")}</array>
  <key>StartInterval</key><integer>${RECONCILE_INTERVAL_S}</integer>
  <key>RunAtLoad</key><false/>
  <key>EnvironmentVariables</key>
  <dict><key>LEDGER_HOOKS_OFF</key><string>1</string><key>HOME</key><string>${home}</string><key>PATH</key><string>${path.dirname(NODE)}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin</string></dict>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plist, xml);
  if (process.env.LEDGER_NO_LAUNCHD === "1") {
    log.push(`reconciler: wrote ${plist} (not loaded: LEDGER_NO_LAUNCHD)`);
    return log;
  }
  tryExec("launchctl", ["unload", plist]);
  if (tryExec("launchctl", ["load", plist])) log.push(`reconciler: LaunchAgent ${LAUNCHD_LABEL} loaded, every ${RECONCILE_INTERVAL_S / 60} min, log ${logFile}`);
  else log.push(`reconciler: wrote ${plist} but launchctl load failed; run: launchctl load ${plist}`);
  return log;
}

// ---------- the capture helper (execution continuity) ----------

const HELPER_LABEL = "com.tranzmit.ledger.helper";

/**
 * Long-running local daemon: tails transcripts, shadow-commits worktrees,
 * uploads to the shared store. macOS LaunchAgent with KeepAlive so it comes
 * back after a crash and starts at login. Elsewhere: a systemd/cron hint.
 */
export function installHelper(): string[] {
  const log: string[] = [];
  const home = os.homedir();
  const logFile = path.join(ledgerHome(), "helper.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const cmdArgs = [NODE, CLI, "helper", "start"];
  if (process.platform !== "darwin") {
    log.push(`helper: run as a service: ${cmdArgs.map(q).join(" ")} >> ${logFile} 2>&1  (systemd --user or nohup)`);
    return log;
  }
  const plist = path.join(home, "Library", "LaunchAgents", `${HELPER_LABEL}.plist`);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${HELPER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${cmdArgs.map((a) => `<string>${a.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>EnvironmentVariables</key>
  <dict><key>LEDGER_HOOKS_OFF</key><string>1</string><key>HOME</key><string>${home}</string><key>PATH</key><string>${path.dirname(NODE)}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin</string></dict>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plist, xml);
  if (process.env.LEDGER_NO_LAUNCHD === "1") {
    log.push(`helper: wrote ${plist} (not loaded: LEDGER_NO_LAUNCHD)`);
    return log;
  }
  tryExec("launchctl", ["unload", plist]);
  if (tryExec("launchctl", ["load", plist])) log.push(`helper: LaunchAgent ${HELPER_LABEL} loaded (KeepAlive), log ${logFile}`);
  else log.push(`helper: wrote ${plist} but launchctl load failed; run: launchctl load ${plist}`);
  log.push(`helper: stop with  launchctl unload ${plist}`);
  return log;
}

export function helperStatus(): string[] {
  const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${HELPER_LABEL}.plist`);
  const out: string[] = [];
  out.push(fs.existsSync(plist) ? `launchd: ${plist}` : "launchd: not installed (ledger helper install)");
  try {
    const r = execFileSync("launchctl", ["list"], { stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n").find((l) => l.includes(HELPER_LABEL));
    out.push(r ? `launchctl: ${r.trim()} (pid status label)` : "launchctl: not loaded");
  } catch { out.push("launchctl: unavailable"); }
  const logFile = path.join(ledgerHome(), "helper.log");
  if (fs.existsSync(logFile)) {
    const tail = fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-3);
    out.push(`log tail:`, ...tail.map((l) => `  ${l.slice(0, 160)}`));
  }
  return out;
}

// ---------- Claude Code (also what Conductor runs) ----------

export function installClaude(): string[] {
  const log: string[] = [];
  const home = os.homedir();

  // 1. MCP server, user scope. Prefer the CLI; fall back to editing ~/.claude.json.
  //    `mcp add` fails on a name that already exists, so check first.
  //    Absolute node + cli.js so the agent's PATH does not matter (Conductor).
  //    An existing registration is removed and re-added so a node upgrade is picked up.
  if (tryExec("claude", ["mcp", "get", "ledger"])) tryExec("claude", ["mcp", "remove", "--scope", "user", "ledger"]);
  if (tryExec("claude", ["mcp", "add", "--scope", "user", "ledger", "--", NODE, CLI, "mcp"])) {
    log.push(`registered MCP server via \`claude mcp add --scope user\` (${NODE} ${CLI} mcp)`);
  } else {
    const f = path.join(home, ".claude.json");
    const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    j.mcpServers = j.mcpServers ?? {};
    j.mcpServers.ledger = { type: "stdio", command: NODE, args: [CLI, "mcp"] };
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    log.push(`registered MCP server in ${f}`);
  }

  // 2. Hooks: the checkpoint loop.
  const settingsFile = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : {};
  const changed = upsertHooks(settings);
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  log.push(
    changed.length
      ? `hooks installed in ${settingsFile}: ${changed.join(", ")}`
      : `hooks already current in ${settingsFile} (${Object.keys(HOOK_EVENTS).join(", ")})`
  );

  // 3. The guide, and one import line in CLAUDE.md.
  log.push(...installGuides("claude"));

  // 4. The periodic transcript reconciler (shared with Codex; idempotent).
  log.push(...installReconciler());
  log.push("restart Claude Code (and Conductor workspaces) to pick this up");
  return log;
}

// ---------- Codex (CLI and desktop app share ~/.codex) ----------

export function installCodex(): string[] {
  const log: string[] = [];
  const home = os.homedir();
  const codexDir = path.join(home, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });

  // 1. MCP server. Prefer the CLI; fall back to appending TOML.
  //    Absolute paths, same reason as Claude: the desktop app's PATH is not your shell's.
  if (tryExec("codex", ["mcp", "get", "ledger"])) tryExec("codex", ["mcp", "remove", "ledger"]);
  if (tryExec("codex", ["mcp", "add", "ledger", "--", NODE, CLI, "mcp"])) {
    log.push(`registered MCP server via \`codex mcp add\` (${NODE} ${CLI} mcp)`);
  } else {
    const f = path.join(codexDir, "config.toml");
    const cur = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    const block = `[mcp_servers.ledger]\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(CLI)}, "mcp"]\n`;
    if (!/^\[mcp_servers\.ledger\]/m.test(cur)) {
      fs.writeFileSync(f, (cur.trimEnd() ? cur.trimEnd() + "\n\n" : "") + block);
      log.push(`registered MCP server in ${f}`);
    } else {
      // replace the existing block so a node upgrade is picked up
      const next = cur.replace(/\[mcp_servers\.ledger\][^[]*/m, block);
      fs.writeFileSync(f, next);
      log.push(`updated MCP server in ${f}`);
    }
  }

  // 2. Hooks: same checkpoint loop, same event names and JSON contract as
  //    Claude Code. Codex reads ~/.codex/hooks.json (CLI and desktop app).
  //    Non-managed hooks must be trusted once, by hash, inside Codex.
  const hooksFile = path.join(codexDir, "hooks.json");
  const hj = fs.existsSync(hooksFile) ? JSON.parse(fs.readFileSync(hooksFile, "utf8")) : {};
  const changed = upsertHooks(hj);
  fs.writeFileSync(hooksFile, JSON.stringify(hj, null, 2) + "\n");
  log.push(
    changed.length
      ? `hooks installed in ${hooksFile}: ${changed.join(", ")}`
      : `hooks already current in ${hooksFile} (${Object.keys(HOOK_EVENTS).join(", ")})`
  );
  log.push("Codex skips untrusted hooks: open Codex, run /hooks, review the five ledger entries, and trust them (once per change)");

  // 3. The guide, inline.
  log.push(...installGuides("codex"));

  // 4. The periodic transcript reconciler (shared with Claude; idempotent).
  log.push(...installReconciler());
  log.push("restart Codex to pick this up");
  return log;
}

/** For `ledger rules`: the guide, to paste into a project-level CLAUDE.md or AGENTS.md. */
export function agentRulesText(): string {
  return guideText();
}
