#!/usr/bin/env node
import fs from "node:fs";
import { initLedger, loadConfig, record, getById, pull } from "./store.js";
import { brief, search, renderFull, stats } from "./query.js";
import { TYPES, type LedgerType } from "./schema.js";
import { installClaude, installCodex, agentRulesText } from "./install.js";
import { startMcp } from "./mcp.js";
import { handleHook } from "./hooks.js";

const USAGE = `ledger — shared definitions, findings, changes, decisions for your agents

  ledger init <dir> [--author NAME]      create a ledger repo and point this machine at it
  ledger use <dir>  [--author NAME]      point this machine at an existing ledger clone
  ledger install claude|codex|all        wire the MCP server, hooks, and guide into your agent
  ledger mcp                             run the MCP server (stdio)
  ledger brief [--days N] [--tags a,b]   what an agent sees at session start
  ledger search <query> [--type T]       free-text search
  ledger get <id>                        show one object
  ledger record <type> < fields.json     record from JSON on stdin
  ledger stats [--days N]                pilot health, incl. the checkpoint loop
  ledger sync                            git pull now
  ledger rules                           print the agent guide
  ledger hook <event> < hook.json        Claude Code hook entry point (installed for you)
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function readStdin(): string {
  try {
    if (process.stdin.isTTY) return "";
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "init": {
        const dir = args[0];
        if (!dir) throw new Error("usage: ledger init <dir>");
        const author = flag(args, "--author") ?? loadAuthorFallback();
        const created = initLedger(dir, author);
        console.log(`Ledger ready at ${dir} (author: ${author})`);
        for (const c of created) console.log(`  + ${c}`);
        console.log(`\nNext: push it to a private GitHub repo, then on each machine:\n  ledger use <clone-dir> --author <name>\n  ledger install all`);
        return;
      }
      case "use": {
        const dir = args[0];
        if (!dir) throw new Error("usage: ledger use <dir>");
        if (!fs.existsSync(dir)) throw new Error(`not found: ${dir}`);
        const author = flag(args, "--author") ?? loadAuthorFallback();
        initLedger(dir, author); // idempotent: fills in missing dirs, writes config
        console.log(`Using ledger at ${dir} (author: ${author})`);
        return;
      }
      case "install": {
        const which = args[0] ?? "all";
        const log: string[] = [];
        if (which === "claude" || which === "all") log.push("[claude]", ...installClaude().map((l) => "  " + l));
        if (which === "codex" || which === "all") log.push("[codex]", ...installCodex().map((l) => "  " + l));
        if (!log.length) throw new Error("usage: ledger install claude|codex|all");
        console.log(log.join("\n"));
        return;
      }
      case "mcp":
        await startMcp();
        return; // keeps running
      case "brief": {
        const cfg = loadConfig();
        const days = Number(flag(args, "--days") ?? 14);
        const tags = flag(args, "--tags")?.split(",").filter(Boolean);
        // --hook: legacy SessionStart entry; stdout becomes context.
        console.log(brief(cfg, { days, tags }));
        return;
      }
      case "hook": {
        // Claude Code lifecycle hook. Must never crash the session: any
        // failure exits 0 silently. Only Stop uses exit 2, deliberately.
        const event = args[0] ?? "";
        let input: any = {};
        try {
          input = JSON.parse(readStdin() || "{}");
        } catch {
          input = {};
        }
        let cfg: ReturnType<typeof loadConfig> | null = null;
        try {
          cfg = loadConfig();
        } catch {
          cfg = null;
        }
        const res = handleHook(event, input, { dataTools: cfg?.data_tools });
        if (event === "SessionStart") {
          const parts: string[] = [];
          if (cfg) {
            try {
              parts.push(brief(cfg));
            } catch (e: any) {
              parts.push(`# Ledger brief unavailable: ${e?.message ?? e}`);
            }
          }
          if (res.stdout) parts.push(res.stdout);
          if (parts.length) process.stdout.write(parts.join("\n\n") + "\n");
          process.exit(0);
        }
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
        process.exit(res.exit);
      }
      case "search": {
        const cfg = loadConfig();
        const q = args.filter((a) => !a.startsWith("--") && a !== flag(args, "--type")).join(" ");
        const t = flag(args, "--type") as LedgerType | undefined;
        const hits = search(cfg, q, { types: t ? [t] : undefined, limit: 20 });
        if (!hits.length) return console.log("no matches");
        for (const h of hits) console.log(`[${h.score.toFixed(2)}] ${h.type} ${h.id} — ${h.title}`);
        return;
      }
      case "get": {
        const o = getById(loadConfig(), args[0]);
        console.log(o ? renderFull(o) : `not found: ${args[0]}`);
        return;
      }
      case "record": {
        const type = args[0] as LedgerType;
        if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join("|")}`);
        const fields = JSON.parse(readStdin() || "{}");
        const res = record(loadConfig(), { type, fields });
        console.log(`recorded ${res.id}${res.git ? ` — ${res.git}` : ""}`);
        return;
      }
      case "stats":
        console.log(stats(loadConfig(), Number(flag(args, "--days") ?? 14)));
        return;
      case "sync": {
        const r = pull(loadConfig(), true);
        console.log(r ?? "synced");
        return;
      }
      case "rules":
        console.log(agentRulesText());
        return;
      default:
        console.log(USAGE);
        process.exit(cmd ? 1 : 0);
    }
  } catch (e: any) {
    if (cmd === "hook") process.exit(0); // never break the agent's session
    console.error(`ledger: ${e.message}`);
    process.exit(1);
  }
}

function loadAuthorFallback(): string {
  try {
    return loadConfig().author;
  } catch {
    return process.env.USER || process.env.USERNAME || "unknown";
  }
}

main();
