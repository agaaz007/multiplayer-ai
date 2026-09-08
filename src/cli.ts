#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { initLedger, loadConfig, loadAll, record, getById, pull, discardDraft, ledgerHome } from "./store.js";
import { brief, search, renderFull, stats } from "./query.js";
import { TYPES, type LedgerType, type LedgerObject } from "./schema.js";
import { readReceipt, savedReceipt, renderReceiptBox, type LedgerReceipt } from "./receipts.js";
import { installClaude, installCodex, installGuides, agentRulesText } from "./install.js";
import { startMcp } from "./mcp.js";
import { handleHook } from "./hooks.js";
import { DEFAULT_QUIET_MS, pendingDrafts, reconcile } from "./extract.js";
import { continuityConfigured, getPool, migrate, tableList, closePools } from "./continuity/db.js";
import { listThreads, getThread, updateThread } from "./continuity/store.js";
import { buildResumePack, threadLine } from "./continuity/resume.js";
import { queryEvents, getArtifact } from "./continuity/evidence.js";
import { checkoutWip, repoRoot, repoIdentity } from "./continuity/shadow.js";
import { openThreadsText } from "./continuity/brief.js";
import { buildRecordPack, listRecordSummaries, recordLine, unassignedLine } from "./continuity/recordpack.js";
import { addStateUpdate, confirmStateUpdate, createRecord, getRecord, linkSpan, rejectStateUpdate, unassignedSpans, type RecordKind, type RecordStatus, type UpdateKind } from "./continuity/records.js";
import { helperOnce, helperLoop, loadState } from "./helper/daemon.js";
import { installHelper, helperStatus } from "./install.js";

const USAGE = `ledger — shared definitions, findings, changes, decisions for your agents

  ledger init <dir> [--author NAME]      create a ledger repo and point this machine at it
  ledger use <dir>  [--author NAME]      point this machine at an existing ledger clone
  ledger install claude|codex|all        wire the MCP server, hooks, guide, and reconciler into your agent
  ledger install guides                 update both agents' guides without rewiring MCP or hooks
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

  execution continuity (needs continuity.database_url in ~/.ledger/config.json):
  ledger continuity migrate|status       create the cont_* tables in the shared Postgres / show counts
  ledger helper once|start|status|install
                                         capture helper: one pass, run forever, show state, install the launchd agent
  ledger threads [--all] [--hours N]     open work threads (this repo by default)
  ledger resume <thread> [--mode continue|fork|inspect] [--checkout <dir>]
                                         claim + resume pack; --checkout creates a worktree at the saved snapshot
  ledger resume --record <id> [--mode continue|inspect]
                                         record pack: state across sessions and teammates; claims the latest contributing session's thread (code records)
  ledger thread show|close|title <id>
  ledger records [--all] [--kind k] [--status s] [--q text] [--hours N] [--limit N]
                                         open work records (this repo by default): kind · title · repo · updated · sessions · proposed/confirmed · id
  ledger record show <id> [--budget N]   record pack without claiming: state (PROPOSED flagged), evidence, pending ops, unassigned, bootstrap
  ledger record start <kind> <title…> [--goal g] [--link <session>:<from>:<to>]
                                         new record (repo from cwd when inside a git repo, else non-code)
  ledger record link <id> <session> <from> <to> [--note n]
  ledger record propose <id> <kind> <text…> --evidence <session>:<seq>[,…] [--supersedes <update>]
  ledger record confirm <update-id> | ledger record reject <update-id> --reason "..."
  ledger unassigned [--hours N] [--session id] [--author a] [--limit N]
                                         spans no record claims: preview, seq range, author, harness, time
  ledger events --thread <id> | --session <id> [--kinds a,b] [--path p] [--q text] [--after N] [--before N] [--limit N] [--chars N]
                                         evidence: one line per captured event (seq · HH:MM · kind · preview); --chars widens the preview
  ledger artifact <id|sha256> [--offset N] [--max N]
                                         read a stored tool output (artifact) slice; the trailer gives the next offset

  search/get/record show boxed receipts in interactive terminals.
  --plain disables the box; --box enables it in captured/piped output.
  NO_COLOR disables terminal color; TERM=dumb uses an ASCII border.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const BOOL_FLAGS = new Set(["--all", "--plain", "--box", "--no-push", "--dry-run", "--show"]);
/** Non-flag arguments, with `--name value` pairs and boolean flags removed. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) { if (!BOOL_FLAGS.has(a)) i++; continue; }
    out.push(a);
  }
  return out;
}

/** "<session>:<seq>" or "<session>:<from>:<to>", split from the right so session ids may contain colons. */
function splitRef(s: string, n: number): { session_id: string; nums: number[] } {
  const parts = s.split(":");
  if (parts.length < n + 1) throw new Error(`expected <session>${":<n>".repeat(n)}, got ${s}`);
  const nums = parts.slice(-n).map((x) => { const v = Number(x); if (!Number.isInteger(v) || v < 0) throw new Error(`not a seq: ${x}`); return v; });
  return { session_id: parts.slice(0, -n).join(":"), nums };
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
  const showReceipt = !args.includes("--plain") && (process.stdout.isTTY || args.includes("--box"));
  const printReceipt = (receipt: LedgerReceipt) => console.log(renderReceiptBox(receipt, {
    columns: process.stdout.columns,
    color: Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb",
    ascii: process.env.TERM === "dumb",
  }));
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
        if (which === "guides") log.push(...installGuides());
        if (which === "claude" || which === "all") log.push("[claude]", ...installClaude().map((l) => "  " + l));
        if (which === "codex" || which === "all") log.push("[codex]", ...installCodex().map((l) => "  " + l));
        if (!log.length) throw new Error("usage: ledger install claude|codex|all|guides");
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
            // continuity: teammates' open threads + any notices the helper fetched. Fails open in 4 s.
            try {
              const threads = await openThreadsText(cfg, { cwd: input?.cwd ? String(input.cwd) : process.cwd() });
              if (threads) parts.push(threads);
            } catch { /* never block a session start */ }
          }
          if (res.stdout) parts.push(res.stdout);
          if (parts.length) process.stdout.write(parts.join("\n\n") + "\n");
          await closePools().catch(() => {});
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
        if (showReceipt) printReceipt(readReceipt("found", hits, q));
        if (!hits.length) return console.log("no matches");
        for (const h of hits) console.log(`[${h.score.toFixed(2)}] ${h.type} ${h.id} — ${h.title}`);
        return;
      }
      case "get": {
        const o = getById(loadConfig(), args[0]);
        if (showReceipt) printReceipt(readReceipt("opened", o ? [o] : []));
        console.log(o ? renderFull(o) : `not found: ${args[0]}`);
        return;
      }
      case "record": {
        const type = args[0] as LedgerType;
        if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join("|")}`);
        const fields = JSON.parse(readStdin() || "{}");
        const cfg = loadConfig();
        const res = record(cfg, { type, fields });
        if (showReceipt) {
          let objects: LedgerObject[] | null = null;
          try { objects = loadAll(cfg, TYPES, false); } catch { /* preserve a successful save if metadata is unavailable */ }
          printReceipt(savedReceipt(type, fields, res, objects, cfg.git_sync));
        }
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

      // ---------- execution continuity ----------
      case "continuity": {
        const cfg = loadConfig();
        if (!continuityConfigured(cfg)) throw new Error("continuity not configured: add continuity.database_url to ~/.ledger/config.json (or set LEDGER_CONTINUITY_DB)");
        const sub = args[0] ?? "status";
        const pool = getPool(cfg);
        if (sub === "migrate") {
          const created = await migrate(pool);
          console.log(created.length ? `created: ${created.join(", ")}` : "schema up to date");
          console.log(`tables: ${(await tableList(pool)).join(", ")}`);
        } else if (sub === "status") {
          const t = await tableList(pool);
          const counts = await Promise.all(t.map(async (n) => `${n}=${(await pool.query(`select count(*)::int as c from ${n}`)).rows[0].c}`));
          console.log(`db ok · author ${cfg.author} · machine ${cfg.continuity!.machine}\n${counts.join("  ")}`);
        } else throw new Error("usage: ledger continuity migrate|status");
        await closePools();
        return;
      }
      case "helper": {
        const cfg = loadConfig();
        const sub = args[0] ?? "status";
        if (sub === "once") {
          const s = await helperOnce(cfg, { log: (l) => console.log(l), push: !args.includes("--no-push") });
          console.log(JSON.stringify(s, null, 2));
          await closePools();
          return;
        }
        if (sub === "start") { await helperLoop(cfg, { intervalMs: parseDuration(flag(args, "--interval"), 10_000), push: !args.includes("--no-push") }); await closePools(); return; }
        if (sub === "install") { console.log(installHelper().join("\n")); return; }
        if (sub === "status") {
          console.log(helperStatus().join("\n"));
          const st = loadState();
          const live = Object.entries(st).filter(([, s]) => !s.ended);
          console.log(`tracked sessions: ${Object.keys(st).length} (${live.length} live)`);
          for (const [sid, s] of live.slice(0, 10)) console.log(`  ${sid.slice(0, 8)} ${s.harness} ${s.repo ? path.basename(s.repo) : "(no repo)"}${s.branch ? `@${s.branch}` : ""} thread ${s.threadId?.slice(0, 8) ?? `unbound${s.unbound_reason ? ` (${s.unbound_reason})` : ""}`} offset ${s.offset}${s.lastCommit ? ` wip ${s.lastCommit.slice(0, 8)}` : ""}`);
          return;
        }
        throw new Error("usage: ledger helper once|start|status|install [--no-push] [--interval 10s]");
      }
      case "threads": {
        const cfg = loadConfig();
        const root = repoRoot(process.cwd());
        const rows = await listThreads(getPool(cfg), { repo: args.includes("--all") ? undefined : root ? (await import("./continuity/shadow.js")).repoIdentity(root) : undefined, sinceHours: Number(flag(args, "--hours") ?? 168), status: flag(args, "--status") ?? "open", limit: Number(flag(args, "--limit") ?? 20) });
        console.log(rows.length ? rows.map((r) => threadLine(r)).join("\n") : "no threads");
        await closePools();
        return;
      }
      case "resume": {
        const cfg = loadConfig();
        const recordId = flag(args, "--record");
        const mode = (flag(args, "--mode") ?? "continue") as "continue" | "fork" | "inspect";
        if (recordId) {
          if (mode === "fork") throw new Error("--mode fork applies to threads; use continue or inspect with --record");
          const pack = await buildRecordPack(cfg, getPool(cfg), recordId, { mode, author: cfg.author, sessionId: `cli:${cfg.author}:${Date.now()}`, repoPath: process.cwd() });
          console.log(pack.text);
          await closePools();
          return;
        }
        const id = args[0];
        if (!id || id.startsWith("--")) throw new Error("usage: ledger resume <thread-id> [--mode continue|fork|inspect] [--checkout <dir>]  |  ledger resume --record <id> [--mode continue|inspect]");
        const pack = await buildResumePack(cfg, getPool(cfg), id, { mode, author: cfg.author, sessionId: `cli:${cfg.author}:${Date.now()}`, repoPath: process.cwd() });
        console.log(pack.text);
        const dest = flag(args, "--checkout");
        if (dest && pack.checkpoint?.wip_ref && pack.checkpoint?.wip_commit) {
          const root = repoRoot(process.cwd());
          if (!root) throw new Error("--checkout needs to run inside a checkout of the same repo");
          console.log(`\ncheckout → ${checkoutWip(root, String(pack.checkpoint.wip_ref), String(pack.checkpoint.wip_commit), path.resolve(dest))}`);
        }
        await closePools();
        return;
      }
      case "thread": {
        const cfg = loadConfig();
        const [sub, id] = args;
        if (!id) throw new Error("usage: ledger thread show|close|title <id> [--title ...]");
        const pool = getPool(cfg);
        const t = await getThread(pool, id);
        if (!t) throw new Error(`not found: ${id}`);
        if (sub === "show") console.log((await buildResumePack(cfg, pool, id, { mode: "inspect", author: cfg.author, repoPath: process.cwd(), budgetTokens: 12000 })).text);
        else if (sub === "close") { await updateThread(pool, id, { status: "done" }); console.log(`closed ${id}`); }
        else if (sub === "title") { await updateThread(pool, id, { title: flag(args, "--title") ?? t.title }); console.log("updated"); }
        else throw new Error("usage: ledger thread show|close|title <id>");
        await closePools();
        return;
      }
      case "records": {
        const cfg = loadConfig();
        const root = repoRoot(process.cwd());
        const rows = await listRecordSummaries(getPool(cfg), {
          repo: args.includes("--all") ? undefined : root ? repoIdentity(root) : undefined,
          kind: flag(args, "--kind") as RecordKind | undefined,
          status: (flag(args, "--status") ?? "open") as RecordStatus,
          q: flag(args, "--q"),
          sinceHours: Number(flag(args, "--hours") ?? 336),
          limit: Number(flag(args, "--limit") ?? 20),
        });
        console.log(rows.length ? rows.map((r) => recordLine(r)).join("\n") : "no records");
        await closePools();
        return;
      }
      case "record": {
        const cfg = loadConfig();
        const pool = getPool(cfg);
        const pos = positionals(args);
        const sub = pos[0];
        const usage = `usage: ledger record show <id> [--budget N] | start <kind> <title…> [--goal g] [--link <session>:<from>:<to>] | link <id> <session> <from> <to> [--note n] | propose <id> <kind> <text…> --evidence <session>:<seq>[,…] [--supersedes <update>] | confirm <update-id> | reject <update-id> --reason "..."`;
        if (sub === "show") {
          if (!pos[1]) throw new Error(usage);
          console.log((await buildRecordPack(cfg, pool, pos[1], { mode: "inspect", author: cfg.author, repoPath: process.cwd(), budgetTokens: Number(flag(args, "--budget") ?? 12000) })).text);
        } else if (sub === "start") {
          const [, kind, ...title] = pos;
          if (!kind || !title.length) throw new Error(usage);
          const root = repoRoot(process.cwd());
          const rec = await createRecord(pool, { kind: kind as RecordKind, title: title.join(" "), goal: flag(args, "--goal") ?? null, repo: root ? repoIdentity(root) : null, created_by: cfg.author });
          let linked = "";
          const link = flag(args, "--link");
          if (link) {
            const { session_id, nums } = splitRef(link, 2);
            const l = await linkSpan(pool, { record_id: rec.id, session_id, from_seq: nums[0], to_seq: nums[1], source: "explicit", created_by: cfg.author });
            linked = `; linked ${session_id} seq ${nums[0]}..${nums[1]} (${l.id})`;
          }
          console.log(`record ${rec.id} "${rec.title}" (${rec.kind}) created${rec.repo ? ` on ${rec.repo}` : " as non-code work"}${linked}`);
        } else if (sub === "link") {
          const [, id, session_id, from, to] = pos;
          if (!id || !session_id || from == null || to == null) throw new Error(usage);
          const rec = await getRecord(pool, id);
          if (!rec) throw new Error(`not found: ${id}`);
          const l = await linkSpan(pool, { record_id: id, session_id, from_seq: Number(from), to_seq: Number(to), source: "explicit", note: flag(args, "--note") ?? null, created_by: cfg.author });
          console.log(`linked ${session_id} seq ${from}..${to} to "${rec.title}" (${l.id})`);
        } else if (sub === "propose") {
          const [, id, kind, ...textParts] = pos;
          const ev = flag(args, "--evidence");
          if (!id || !kind || !textParts.length || !ev) throw new Error(usage);
          const evidence = ev.split(",").filter(Boolean).map((r) => { const { session_id, nums } = splitRef(r, 1); return { session_id, seq: nums[0] }; });
          const u = await addStateUpdate(pool, { record_id: id, kind: kind as UpdateKind, text: textParts.join(" "), evidence, created_by: cfg.author, supersedes: flag(args, "--supersedes") ?? null });
          console.log(`proposed ${u.kind} update ${u.id} (status ${u.status}; confirm with: ledger record confirm ${u.id})`);
        } else if (sub === "confirm") {
          if (!pos[1]) throw new Error(usage);
          const u = await confirmStateUpdate(pool, pos[1], cfg.author);
          if (!u) throw new Error(`not found: ${pos[1]}`);
          const rec = await getRecord(pool, u.record_id);
          console.log(`confirmed ${u.kind} update ${u.id} by ${u.confirmed_by}; record state_version ${rec?.state_version ?? "?"}`);
        } else if (sub === "reject") {
          const reason = flag(args, "--reason");
          if (!pos[1] || !reason) throw new Error(usage);
          const u = await rejectStateUpdate(pool, pos[1], cfg.author, reason);
          if (!u) throw new Error(`not found: ${pos[1]}`);
          console.log(`rejected ${u.kind} update ${u.id}: ${reason}`);
        } else throw new Error(usage);
        await closePools();
        return;
      }
      case "unassigned": {
        const cfg = loadConfig();
        const rows = await unassignedSpans(getPool(cfg), { sinceHours: Number(flag(args, "--hours") ?? 48), session_id: flag(args, "--session"), author: flag(args, "--author"), limit: Number(flag(args, "--limit") ?? 10) });
        console.log(rows.length ? rows.map((s) => unassignedLine(s)).join("\n") : "no unassigned spans");
        await closePools();
        return;
      }
      case "events": {
        const cfg = loadConfig();
        const thread_id = flag(args, "--thread");
        const session_id = flag(args, "--session");
        if (!thread_id && !session_id) throw new Error("usage: ledger events --thread <id> | --session <id> [--kinds a,b] [--path p] [--q text] [--after N] [--before N] [--limit N] [--chars N]");
        const n = (s: string | undefined) => (s == null ? undefined : Number(s));
        const r = await queryEvents(getPool(cfg), { thread_id, session_id, kinds: flag(args, "--kinds")?.split(",").map((k) => k.trim()).filter(Boolean), path: flag(args, "--path"), q: flag(args, "--q"), after_seq: n(flag(args, "--after")), before_seq: n(flag(args, "--before")), limit: n(flag(args, "--limit")), preview_chars: n(flag(args, "--chars")) });
        console.log(r.text);
        await closePools();
        return;
      }
      case "artifact": {
        const cfg = loadConfig();
        const ref = args[0];
        if (!ref || ref.startsWith("--")) throw new Error("usage: ledger artifact <id|sha256> [--offset N] [--max N]");
        const bySha = /^[0-9a-f]{64}$/i.test(ref);
        const r = await getArtifact(getPool(cfg), bySha ? { sha256: ref } : { id: ref }, { offset: Number(flag(args, "--offset") ?? 0), max_chars: Number(flag(args, "--max") ?? 20_000) });
        console.log(r.text);
        await closePools();
        if (!r.found) process.exit(1);
        return;
      }
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
