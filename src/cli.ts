#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { initLedger, loadConfig, record, getById, pull, discardDraft, ledgerHome } from "./store.js";
import { brief, search, renderFull, stats } from "./query.js";
import { TYPES, type LedgerType } from "./schema.js";
import { installClaude, installCodex, agentRulesText } from "./install.js";
import { startMcp } from "./mcp.js";
import { handleHook } from "./hooks.js";
import { DEFAULT_QUIET_MS, pendingDrafts, reconcile } from "./extract.js";

const USAGE = `ledger — shared definitions, findings, changes, decisions for your agents

  ledger init <dir> [--author NAME]      create a ledger repo and point this machine at it
  ledger use <dir>  [--author NAME]      point this machine at an existing ledger clone
  ledger install claude|codex|all        wire the MCP server, hooks, guide, and reconciler into your agent
  ledger mcp                             run the MCP server (stdio)
  ledger brief [--days N] [--tags a,b]   what an agent sees at session start
  ledger search <query> [--type T]       free-text search
  ledger get <id>                        show one object
  ledger record <type> < fields.json     record from JSON on stdin
  ledger drafts                          drafts awaiting review (from the transcript fallback)
  ledger discard <id> --reason "..."     reject a draft
  ledger reconcile [--session ID] [--quiet 20m] [--dry-run]
                                         transcript fallback: sessions with capture debt -> drafts
  ledger stats [--days N]                pilot health, incl. the checkpoint loop and the fallback
  ledger sync                            git pull now
  ledger rules                           print the agent guide
  ledger hook <event> < hook.json        Claude Code / Codex hook entry point (installed for you)
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

function parseDuration(s: string | undefined, fallbackMs: number): number {
  if (!s) return fallbackMs;
  const m = s.match(/^(\d+)\s*(ms|s|m|h)?$/);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  return { ms: n, s: n * 1000, m: n * 60_000, h: n * 3_600_000 }[m[2] ?? "m"]!;
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
        // Claude Code / Codex lifecycle hook. Must never crash the session:
        // any failure exits 0 silently. LEDGER_HOOKS_OFF=1 is set for the
        // extractor's own agent session so it cannot journal or block itself.
        if (process.env.LEDGER_HOOKS_OFF === "1") process.exit(0);
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
        if (res.reconcile && cfg && input?.session_id && (cfg.extractor ?? "auto") !== "none") {
          // Detached, so the hook returns at once and the agent can exit.
          const child = spawn(process.execPath, [path.resolve(process.argv[1]), "reconcile", "--session", String(input.session_id)], {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, LEDGER_HOOKS_OFF: "1" },
          });
          child.unref();
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
      case "drafts": {
        const ds = pendingDrafts(loadConfig());
        if (!ds.length) return console.log("no drafts awaiting review");
        for (const d of ds) {
          console.log(`${d.id}  ${d.title}\n    ${d.fields.capture_reason ?? ""}\n    session ${d.fields.source_session ?? "?"}, ${d.created.slice(0, 16)}. promote: record a stable ${d.type} with supersedes: ${d.id}; discard: ledger discard ${d.id} --reason "..."`);
        }
        return;
      }
      case "discard": {
        const id = args[0];
        const reason = flag(args, "--reason");
        if (!id || !reason) throw new Error(`usage: ledger discard <id> --reason "..."`);
        const r = discardDraft(loadConfig(), id, reason);
        console.log(`discarded ${r.id}${r.git ? ` — ${r.git}` : ""}`);
        return;
      }
      case "reconcile": {
        const cfg = loadConfig();
        if ((cfg.extractor ?? "auto") === "none") return console.log("extractor disabled (extractor: none in ~/.ledger/config.json)");
        const results = reconcile(cfg, {
          sessionId: flag(args, "--session"),
          quietMs: parseDuration(flag(args, "--quiet"), DEFAULT_QUIET_MS),
          dryRun: args.includes("--dry-run"),
        });
        const logFile = path.join(ledgerHome(), "reconcile.log");
        const lines = results.map((r) => `${new Date().toISOString()} ${r.session_id} ${r.result}${r.draft_ids.length ? ` ${r.draft_ids.join(",")}` : ""}: ${r.reason}`);
        try {
          fs.mkdirSync(path.dirname(logFile), { recursive: true });
          if (lines.length) fs.appendFileSync(logFile, lines.join("\n") + "\n");
        } catch {
          /* log is best-effort */
        }
        console.log(lines.length ? lines.join("\n") : "nothing to reconcile");
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
