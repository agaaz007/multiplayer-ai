#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { initLedger, loadConfig, loadAll, record, getById, pull, discardDraft, ledgerHome, saveConfig } from "./store.js";
import { brief, search, renderFull, stats } from "./query.js";
import { TYPES, type LedgerType, type LedgerObject } from "./schema.js";
import { readReceipt, savedReceipt, renderReceiptBox, type LedgerReceipt } from "./receipts.js";
import { installClaude, installCodex, installGuides, agentRulesText } from "./install.js";
import { startMcp } from "./mcp.js";
import { handleHook, validateCaptureCoverage, acknowledgeCapture } from "./hooks.js";
import { verifyAcceptanceEvidence } from './acceptance-evidence.js';
import { validateRecordCoverage, acknowledgeLocalCapture, reconcileSharedCapture } from './capture-boundary.js';
import { investigation } from './investigation.js';
import { correctionImpact, objectVersion, resolveAccepted } from './authority.js';
import { buildGraph, renderGraph, type GraphFormat } from './graph.js';
import { AnalysisScopeSchema, AnalyticalDateSchema } from './schema.js';
import { DEFAULT_QUIET_MS, pendingDrafts, reconcile } from "./extract.js";
import { continuityConfigured, getPool, migrate, tableList, closePools } from "./continuity/db.js";
import { listThreads, getThread, updateThread } from "./continuity/store.js";
import { buildResumePack, threadLine } from "./continuity/resume.js";
import { queryEvents, getArtifact } from "./continuity/evidence.js";
import { checkoutWip, repoRoot, repoIdentity } from "./continuity/shadow.js";
import { openThreadsText } from "./continuity/brief.js";
import { bindInvestigation, declareInvestigation, listInvestigations, sessionBinding } from "./continuity/investigations.js";
import { buildRecordPack, listRecordSummaries, recordLine, unassignedLine } from "./continuity/recordpack.js";
import { addStateUpdate, confirmStateUpdate, createRecord, getRecord, linkSpan, rejectStateUpdate, unassignedSpans, type RecordKind, type RecordStatus, type UpdateKind } from "./continuity/records.js";
import { helperOnce, helperLoop, loadState } from "./helper/daemon.js";
import { installHelper, helperStatus, installSource } from "./install.js";
import { stageRelease, activateRelease, installFromRelease, deployStatus, formatDeployStatus, listReleases } from "./deploy.js";
import { readHeartbeat } from "./helper/heartbeat.js";

const USAGE = `ledger — shared definitions, findings, changes, decisions for your agents

  ledger init <dir> [--author NAME]      create a ledger repo and point this machine at it
  ledger use <dir>  [--author NAME]      point this machine at an existing ledger clone
  ledger install claude|codex|all        wire the MCP server, hooks, guide, and reconciler into your agent
  ledger install guides                 update both agents' guides without rewiring MCP or hooks
  ledger deploy [--no-install]           copy this build to ~/.ledger/bin/releases/<version> and install hooks, MCP and helper from there
  ledger deploy --status                 which cli.js every hook, MCP registration and launchd job runs right now
  ledger mcp                             run the MCP server (stdio)
  ledger mcp --http --scratch [--port N] serve MCP over HTTP from a scratch ledger at /mcp/$LEDGER_HTTP_SECRET (ChatGPT test endpoint; no login)
  ledger brief [--days N] [--tags a,b]   what an agent sees at session start
  ledger search <query> [--type T]       free-text search
  ledger get <id>                        show one object
  ledger investigate <question> [--scope scope.json] [--definitions id,id] [--as-of DATE]
                                         accepted corrections, exact evidence and affected findings across all history
  ledger impact <correction-id>           direct/transitive review paths and unresolved lineage
  ledger graph [--format mermaid|dot|json] [--id ID --depth N] [--impact ID]
                                         render the lineage already in the ledger: supersedes, pinned
                                         dependencies, reproductions, evidence. Selection:
                                         --conflicts (unresolved accepted heads) · --unpinned (findings
                                         on a definition name with no pinned version) · --impact <id>
                                         (blast radius of a correction). Filters: --type --tag --author
                                         --days N --current-only. --names draws dashed definitions_used
                                         edges; --legend adds a key. Scope line goes to stderr.
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
  ledger continuity rotate <postgres-url> verify the new database URL, write it to config.json (mode 600), restart the helper
  ledger continuity embed --status | --backfill [--limit N] [--since 30d] [--dry-run]
                                         optional pgvector embeddings (continuity.embeddings): status, or embed not-yet-embedded events oldest first
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
  ledger record show <id> [--budget N] [--detail lean|evidence]
                                         record pack without claiming: lean by default (state, decisions in force, pending ops, changed since your last visit, drill-down refs); --detail evidence inlines event lines
  ledger record start <kind> <title…> [--goal g] [--link <session>:<from>:<to>]
                                         new record (repo from cwd when inside a git repo, else non-code)
  ledger record link <id> <session> <from> <to> [--note n]
  ledger record propose <id> <kind> <text…> --evidence <session>:<seq>[,…] [--supersedes <update>]
  ledger record confirm <update-id> | ledger record reject <update-id> --reason "..."
  ledger investigation list [--q text] [--author a] [--hours N] [--limit N]
                                         open investigation records across all repos (repo-less included), ranked by match to --q
  ledger investigation bind <record-id> [--session <id>] [--question q]
                                         bind an analysis session to an open investigation (explicit span from seq 1; the helper extends it)
  ledger investigation new "<question>" [--goal g] [--session <id>] [--repo <identity>]
                                         declare a new investigation and bind the session; refused when a near-identical open one exists
  ledger investigation show --session <id>
                                         which investigation a session is bound to
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

const BOOL_FLAGS = new Set(["--all", "--plain", "--box", "--no-push", "--dry-run", "--show",
  "--current-only", "--conflicts", "--unpinned", "--names", "--legend"]);
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
      case "deploy": {
        if (args.includes("--status")) {
          const releases = listReleases();
          console.log(`releases in ~/.ledger/bin/releases: ${releases.length ? releases.join(", ") : "(none)"}`);
          console.log(formatDeployStatus(deployStatus()).join("\n"));
          return;
        }
        const here = installSource();
        console.log(`source: ${here.cli}${here.worktree ? ` (git worktree ${here.worktree})` : ""}`);
        const info = stageRelease((l) => console.log(l));
        console.log(`staged release ${info.id}\n  ${info.dir}`);
        for (const p of activateRelease(info, (l) => console.log(l))) console.log(`  ${p}`);
        if (!args.includes("--no-install")) installFromRelease(info, (l) => console.log(l));
        else console.log(`skipped install (--no-install); run: node ${info.dir}/dist/cli.js install all && node ${info.dir}/dist/cli.js helper install`);
        console.log("");
        console.log(formatDeployStatus(deployStatus()).join("\n"));
        const releases = listReleases();
        if (releases.length > 3) console.log(`\n${releases.length} releases kept under ${path.dirname(info.dir)}; older ones are safe to delete once nothing references them (ledger deploy --status).`);
        console.log("\nrunning MCP servers restart with their harness sessions; the helper and reconciler were restarted by install.");
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
        if (args.includes("--http")) {
          // ChatGPT web and claude.ai reach MCP servers only over HTTPS. Until login exists this serves a scratch ledger only.
          if (!args.includes("--scratch")) throw new Error("ledger mcp --http serves only a scratch ledger for now; add --scratch. Serving the team ledger over the internet needs login, which is not built yet.");
          const { startHttpMcp } = await import("./http.js");
          await startHttpMcp({ port: Number(flag(args, "--port") ?? process.env.PORT ?? 8787), secret: process.env.LEDGER_HTTP_SECRET || undefined, scratch: true });
          return; // keeps running
        }
        await startMcp();
        return; // keeps running
      case "brief": {
        const cfg = loadConfig();
        for(const warning of reconcileSharedCapture(cfg).warnings) console.error(warning);
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
        const captureWarnings:string[]=[];
        if(event==='SessionStart' && cfg) {
          try {captureWarnings.push(...reconcileSharedCapture(cfg).warnings);}
          catch(error) {captureWarnings.push(`Shared capture acknowledgment unavailable; local obligations retained: ${String(error)}`);}
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
              const threads = await openThreadsText(cfg, { cwd: input?.cwd ? String(input.cwd) : process.cwd(), timeoutMs: 8000 }); // SessionStart hook allows 30 s; Neon connects have taken 7-8 s
              if (threads) parts.push(threads);
            } catch { /* never block a session start */ }
          }
          if (res.stdout) parts.push(res.stdout);
          parts.push(...captureWarnings);
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
        const q = positionals(args).join(" ");
        const t = flag(args, "--type") as LedgerType | undefined;
        const scopePath = flag(args, '--scope');
        const scope = scopePath ? AnalysisScopeSchema.partial().parse(JSON.parse(fs.readFileSync(scopePath,'utf8'))) : undefined;
        const hits = search(cfg, q, { types: t ? [t] : undefined, limit: 20, scope, asOf:AnalyticalDateSchema.optional().parse(flag(args,'--as-of')) });
        if (showReceipt) printReceipt(readReceipt("found", hits, q));
        if (!hits.length) return console.log("no matches");
        for (const h of hits) {
          console.log(`[${h.score.toFixed(2)}] ${h.type} ${h.id} — ${h.title} [${h.authority_status}]`);
          for (const warning of h.authority_warnings) console.log(`  WARNING: ${warning}`);
        }
        return;
      }
      case "get": {
        const cfg = loadConfig();
        const o = getById(cfg, args[0]);
        if (showReceipt) printReceipt(readReceipt("opened", o ? [o] : []));
        console.log(o ? renderFull(o) : `not found: ${args[0]}`);
        if (o) {
          const authority = resolveAccepted(loadAll(cfg,TYPES,false),o.id,{asOf:AnalyticalDateSchema.optional().parse(flag(args,'--as-of'))});
          console.log(`content_version: ${objectVersion(o)}\nAccepted resolution: ${authority.status}`);
          for (const warning of authority.warnings) console.log(`WARNING: ${warning}`);
          for (const current of authority.current.filter(c=>c.id!==o.id)) console.log(`Applicable accepted source:\n${renderFull(current)}\ncontent_version: ${objectVersion(current)}`);
          for (const proposal of authority.proposals) console.log(`PROPOSED: ${proposal.id} — ${proposal.title}`);
        }
        return;
      }
      case 'investigate': {
        const scopePath = flag(args,'--scope');
        const scope = scopePath ? AnalysisScopeSchema.partial().parse(JSON.parse(fs.readFileSync(scopePath,'utf8'))) : undefined;
        const question = positionals(args).join(' ');
        if (!question) throw new Error('usage: ledger investigate <question> [--scope scope.json]');
        const pack = investigation(loadConfig(),{question,scope,definition_ids:flag(args,'--definitions')?.split(','),as_of:AnalyticalDateSchema.optional().parse(flag(args,'--as-of'))});
        if (showReceipt) printReceipt(readReceipt('found',pack.objects,question));
        console.log(pack.text);
        return;
      }
      case 'impact': {
        if (!args[0]) throw new Error('usage: ledger impact <correction-id>');
        console.log(JSON.stringify(correctionImpact(loadAll(loadConfig()),args[0]),null,2));
        return;
      }
      case "graph": {
        const format = (flag(args, "--format") ?? "mermaid") as GraphFormat;
        if (!["mermaid", "dot", "json"].includes(format)) throw new Error(`unknown --format ${format}; use mermaid, dot or json`);
        const depth = flag(args, "--depth");
        const days = flag(args, "--days");
        const t = flag(args, "--type") as LedgerType | undefined;
        if (t && !TYPES.includes(t)) throw new Error(`unknown --type ${t}; use ${TYPES.join(", ")}`);
        const g = buildGraph(loadConfig(), {
          types: t ? [t] : undefined,
          tags: flag(args, "--tag")?.split(","),
          author: flag(args, "--author"),
          days: days ? Number(days) : undefined,
          id: flag(args, "--id") ?? positionals(args)[0],
          depth: depth ? Number(depth) : undefined,
          currentOnly: args.includes("--current-only"),
          conflictsOnly: args.includes("--conflicts"),
          unpinnedOnly: args.includes("--unpinned"),
          impact: flag(args, "--impact"),
          names: args.includes("--names"),
        });
        // The scope line goes to stderr so stdout stays a clean pipe into graphviz or a mermaid paste,
        // while a reader still sees what the picture cut. Silence here would let a filtered graph
        // read as the whole ledger.
        console.error(g.scope);
        for (const heads of g.summary.conflicts)
          console.error(`UNRESOLVED: ${heads.join(" vs ")} — both accepted, no authoritative head. Drawn without an arrow; resolve with evidence, never by recency.`);
        if (!g.nodes.length) { console.error("nothing selected"); return; }
        console.log(renderGraph(g, format, args.includes("--legend")));
        return;
      }
      case "record": {
        const type = args[0] as LedgerType;
        // `ledger record show|start|link|propose|confirm|reject …` are the work-record commands (continuity);
        // `ledger record <type> < fields.json` records a Ledger object, as before.
        if (!TYPES.includes(type)) { await workRecordCommand(args); return; }
        const fields = JSON.parse(readStdin() || "{}");
        const cfg = loadConfig();
        const coverage = await validateRecordCoverage(cfg,fields);
        await verifyAcceptanceEvidence(cfg,fields);
        const res = record(cfg, { type, fields });
        if (coverage.length) {
          try {
            const applied=acknowledgeLocalCapture({schema:'ledger-capture/v1',action:'record',status:fields.status === 'draft' ? 'pending_review' : 'recorded',coverage,record_id:res.id});
            if(applied.remote_pending) console.error(`${applied.remote_pending} remote evidence acknowledgment(s) saved; source-machine journal update awaits its next pull and reconciliation.`);
          }
          catch (error) { console.error(`Saved ${res.id}, but capture acknowledgment failed; do not duplicate the object: ${String(error)}`); }
        }
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
          const created = await migrate(pool, cfg);
          console.log(created.length ? `created: ${created.join(", ")}` : "schema up to date");
          console.log(`tables: ${(await tableList(pool)).join(", ")}`);
        } else if (sub === "status") {
          const t = await tableList(pool);
          const counts = await Promise.all(t.map(async (n) => `${n}=${(await pool.query(`select count(*)::int as c from ${n}`)).rows[0].c}`));
          console.log(`db ok · author ${cfg.author} · machine ${cfg.continuity!.machine}\n${counts.join("  ")}`);
        } else if (sub === "rotate") {
          // Neon (or any Postgres) password rotation: prove the new URL works before anything is
          // written, never print it, then restart the launchd helper so the running process
          // and the file agree. The old password stays valid until you revoke it upstream.
          const url = args[1];
          if (!url || !/^postgres(ql)?:\/\//.test(url)) throw new Error("usage: ledger continuity rotate <postgresql://…>  (the new URL; it is not echoed)");
          const { default: pg } = await import("pg");
          const probe = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
          await probe.connect();
          try {
            const r = await probe.query("select current_user as u, count(*)::int as threads from cont_threads");
            console.log(`new URL ok · role ${r.rows[0].u} · cont_threads=${r.rows[0].threads}`);
          } finally { await probe.end(); }
          const next = { ...cfg, continuity: { ...cfg.continuity!, database_url: url } };
          saveConfig(next);
          fs.chmodSync(path.join(ledgerHome(), "config.json"), 0o600);
          console.log(`wrote ${path.join(ledgerHome(), "config.json")} (mode 600)`);
          const before = readHeartbeat();
          if (process.platform === "darwin") {
            const { spawnSync } = await import("node:child_process");
            const uid = process.getuid?.() ?? 0;
            const r = spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/com.tranzmit.ledger.helper`], { encoding: "utf8", timeout: 20_000 });
            if (r.status !== 0) console.log(`helper restart failed (${(r.stderr || "").trim()}); run: launchctl kickstart -k gui/${uid}/com.tranzmit.ledger.helper`);
            else {
              let hb = readHeartbeat();
              for (let i = 0; i < 40 && (!hb || hb.pid === before?.pid || !hb.started_at || hb.started_at === before?.started_at); i++) { await new Promise((res) => setTimeout(res, 500)); hb = readHeartbeat(); }
              console.log(hb && hb.pid !== before?.pid ? `helper restarted · pid ${hb.pid} · ${hb.cli}` : "helper restart requested; no new heartbeat yet (check: ledger helper status)");
            }
          } else console.log("restart the helper service so it picks up the new URL");
          console.log("MCP servers inside open Claude/Codex sessions keep the old connection until those sessions restart.");
        } else if (sub === "embed") {
          // Optional event embeddings. The API key is read from config/env and is never printed here.
          const E = await import("./continuity/embeddings.js");
          const fmtUsd = (v: number | null) => (v == null ? "n/a (unknown model price)" : `USD ${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`);
          if (args.includes("--status")) {
            const st = await E.embeddingStatus(pool, cfg);
            const lines = [
              `configured: ${st.configured ? "yes" : "no (add continuity.embeddings to ~/.ledger/config.json)"}`,
              `extension vector: ${st.extension.installed ? `installed ${st.extension.installed}` : st.extension.available ? `available ${st.extension.available}, not installed (run: ledger continuity migrate)` : "not available on this server"}`,
            ];
            if (st.configured) {
              lines.push(`model: ${st.model} · dims ${st.dims} · key ${st.api_key_present ? `present (${st.api_key_env})` : `MISSING (set ${st.api_key_env})`}`);
              lines.push(`kinds: ${st.kinds!.join(", ")} · max_chars ${st.max_chars}`);
              lines.push(`table cont_event_embeddings: ${st.table_exists ? `present · stored dims ${st.stored_dims ?? "?"}${st.dims_match === false ? " · MISMATCH with config (see: ledger continuity migrate)" : ""}${st.stored_models.length ? ` · stored model ${st.stored_models.join(", ")}` : ""}` : "absent (run: ledger continuity migrate)"}`);
              lines.push(`embedded ${st.embedded} / eligible ${st.eligible} · pending ${st.pending} · failures ${st.failures}`);
              lines.push(`backfill estimate for pending: ${st.pending_chars} chars ≈ ${st.estimated_tokens} tokens ≈ ${fmtUsd(st.estimated_usd)}`);
            }
            console.log(lines.join("\n"));
          } else if (args.includes("--backfill")) {
            if (!E.embeddingsConfigured(cfg)) throw new Error("embeddings not configured: add continuity.embeddings to ~/.ledger/config.json (see docs/continuity/runbook.md, Embeddings)");
            const settings = E.embeddingSettings(cfg)!;
            if (!settings.api_key_present) throw new Error(`no embeddings API key: set ${settings.api_key_env} or continuity.embeddings.api_key`);
            await migrate(pool, cfg); // installs the extension and tables; refuses a width/model mismatch with instructions
            const limitFlag = flag(args, "--limit");
            const limit = limitFlag ? Math.max(1, Math.floor(Number(limitFlag))) : Infinity;
            if (!Number.isFinite(Number(limitFlag ?? 1))) throw new Error(`invalid --limit ${limitFlag}`);
            const sinceHours = E.parseSinceHours(flag(args, "--since"));
            const st = await E.embeddingStatus(pool, cfg, { sinceHours });
            const plan = Math.min(limit, st.pending);
            const planChars = st.pending ? Math.round((st.pending_chars * plan) / st.pending) : 0;
            const planTokens = Math.ceil(planChars / 4);
            console.log(`model ${st.model} · dims ${st.dims} · embedded ${st.embedded} / eligible ${st.eligible} · failures ${st.failures}`);
            console.log(`pending${sinceHours != null ? ` (since ${flag(args, "--since")})` : ""}: ${st.pending} events · will embed ${plan} · ≈ ${planChars} chars ≈ ${planTokens} tokens ≈ ${fmtUsd(E.costUsd(st.model!, planTokens))}`);
            if (args.includes("--dry-run") || plan === 0) { console.log(plan === 0 ? "nothing to do" : "dry run: nothing embedded"); }
            else {
              let done = 0, failed = 0, chars = 0;
              const t0 = Date.now();
              while (done + failed < plan) {
                const r = await E.embedPendingEvents(pool, cfg, { limit: Math.min(256, plan - done - failed), sinceHours, log: (l) => console.log(l) });
                done += r.embedded; failed += r.failed; chars += r.chars;
                const tokens = Math.ceil(chars / 4);
                console.log(`embedded ${done}/${plan}${failed ? ` · ${failed} failed` : ""} · ${tokens} tokens ≈ ${fmtUsd(E.costUsd(st.model!, tokens))} · ${Math.round((Date.now() - t0) / 1000)}s`);
                if (r.stopped_early) { console.log(`stopped: ${r.error ?? "provider unavailable"}; rerun to continue`); break; }
                if (r.remaining === 0 || (!r.embedded && !r.failed)) break;
              }
            }
          } else throw new Error("usage: ledger continuity embed --status | --backfill [--limit N] [--since 30d] [--dry-run]");
        } else throw new Error("usage: ledger continuity migrate|status|rotate <url>|embed …");
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
          const pack = await buildRecordPack(cfg, getPool(cfg), recordId, { mode, author: cfg.author, sessionId: `cli:${cfg.author}:${Date.now()}`, repoPath: process.cwd(), viewer: cfg.author, detail: (flag(args, "--detail") as "lean" | "evidence" | undefined) });
          console.log(pack.text);
          await closePools();
          return;
        }
        const id = args[0];
        if (!id || id.startsWith("--")) throw new Error("usage: ledger resume <thread-id> [--mode continue|fork|inspect] [--checkout <dir>]  |  ledger resume --record <id> [--mode continue|inspect]");
        const pack = await buildResumePack(cfg, getPool(cfg), id, { mode, author: cfg.author, sessionId: `cli:${cfg.author}:${Date.now()}`, repoPath: process.cwd(), viewer: cfg.author, detail: (flag(args, "--detail") as "lean" | "evidence" | undefined) });
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
        if (sub === "show") console.log((await buildResumePack(cfg, pool, id, { mode: "inspect", author: cfg.author, repoPath: process.cwd(), budgetTokens: 12000, viewer: cfg.author, detail: (flag(args, "--detail") as "lean" | "evidence" | undefined) })).text);
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
      case "investigation": {
        // analysis-session scope (dec-20260917-multi-pm-continuity-bind-or-new-at-session-start-u44f): bind or declare, any repo or none
        const cfg = loadConfig();
        const pool = getPool(cfg);
        const pos = positionals(args);
        const sub = pos[0];
        const usage = `usage: ledger investigation list [--q text] [--author a] [--hours N] [--limit N] | bind <record-id> [--session <id>] [--question q] | new "<question>" [--goal g] [--session <id>] [--repo <identity>] | show --session <id>`;
        const sessionArg = flag(args, "--session") ?? process.env.LEDGER_SESSION_ID;
        if (sub === "list") {
          const hours = flag(args, "--hours"), limit = flag(args, "--limit");
          const r = await listInvestigations(pool, cfg, { q: flag(args, "--q"), author: flag(args, "--author"), hours: hours ? Number(hours) : undefined, limit: limit ? Number(limit) : undefined });
          console.log(r.text);
        } else if (sub === "bind") {
          if (!pos[1]) throw new Error(usage);
          if (!sessionArg) throw new Error(`${usage}\nbind needs the session to bind: --session <id> (or LEDGER_SESSION_ID)`);
          const r = await bindInvestigation(pool, cfg, { record_id: pos[1], session_id: sessionArg, question: flag(args, "--question") });
          console.log(r.text);
        } else if (sub === "new") {
          const question = pos.slice(1).join(" ");
          if (!question) throw new Error(usage);
          // without a live session the CLI binds a synthetic one, as `ledger resume` does, so the record exists and the declaration is attributed
          const r = await declareInvestigation(pool, cfg, { question, goal: flag(args, "--goal"), session_id: sessionArg ?? `cli:${cfg.author}:${Date.now()}`, repo: flag(args, "--repo") ?? null });
          console.log(r.text);
        } else if (sub === "show") {
          if (!sessionArg) throw new Error(usage);
          const b = await sessionBinding(pool, sessionArg);
          console.log(b ? `session ${sessionArg} → investigation ${b.record_id} (bound by ${b.bound_by} at ${b.bound_at}${b.question ? `; question: ${b.question}` : ""})` : `session ${sessionArg} is not bound to an investigation`);
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

/** `ledger record show|start|link|propose|confirm|reject …`: the work-record commands (spec §13a). */
async function workRecordCommand(args: string[]): Promise<void> {
  const cfg = loadConfig();
  const pool = getPool(cfg);
  const pos = positionals(args);
  const sub = pos[0];
  const usage = `usage: ledger record <definition|finding|change|decision> < fields.json  |  ledger record show <id> [--budget N] | start <kind> <title…> [--goal g] [--link <session>:<from>:<to>] | link <id> <session> <from> <to> [--note n] | propose <id> <kind> <text…> --evidence <session>:<seq>[,…] [--supersedes <update>] | confirm <update-id> | reject <update-id> --reason "..."`;
  if (sub === "show") {
    if (!pos[1]) throw new Error(usage);
    console.log((await buildRecordPack(cfg, pool, pos[1], { mode: "inspect", author: cfg.author, repoPath: process.cwd(), budgetTokens: Number(flag(args, "--budget") ?? 12000), viewer: cfg.author, detail: (flag(args, "--detail") as "lean" | "evidence" | undefined) })).text);
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
    // A person accepts at an interactive prompt. Without a terminal (an agent running the CLI, a script) the
    // confirmation is recorded as made without review, so successors are never told a person accepted it.
    const { getStateUpdate } = await import("./continuity/records.js");
    const { acceptanceLabel } = await import("./continuity/packsections.js");
    const pending = await getStateUpdate(pool, pos[1]);
    if (!pending) throw new Error(`not found: ${pos[1]}`);
    let via: "cli" | "cli-interactive" = "cli";
    const needsPerson = pending.status === "proposed" || (pending.status === "confirmed" && pending.confirmed_via !== "cli-interactive");
    if (needsPerson && process.stdin.isTTY && process.stdout.isTTY) {
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log(`${pending.kind} update ${pending.id} (by ${pending.created_by}):\n  ${pending.text}`);
      const answer = (await rl.question(`Accept this as ${cfg.author}? Type "yes" to accept: `)).trim().toLowerCase();
      rl.close();
      if (answer !== "yes") { console.log("not accepted; nothing changed"); await closePools(); return; }
      via = "cli-interactive";
    }
    const u = await confirmStateUpdate(pool, pos[1], cfg.author, { via });
    if (!u) throw new Error(`not found: ${pos[1]}`);
    const rec = await getRecord(pool, u.record_id);
    console.log(`${u.kind} update ${u.id} is now [${acceptanceLabel(u)}]; record state_version ${rec?.state_version ?? "?"}`);
  } else if (sub === "reject") {
    const reason = flag(args, "--reason");
    if (!pos[1] || !reason) throw new Error(usage);
    const u = await rejectStateUpdate(pool, pos[1], cfg.author, reason);
    if (!u) throw new Error(`not found: ${pos[1]}`);
    // a rejected proposal no longer needs the checkpoint's decision prompt in the session it came from
    if (u.session_id) { try { acknowledgeLocalCapture({ schema: "ledger-capture/v1", action: "skip", status: "dismissed", reason: `proposal rejected: ${reason.trim()}`, coverage: [{ session_id: u.session_id, evidence_ids: [`d:${u.id}`] }] }); } catch { /* no local prompt for it */ } }
    console.log(`rejected ${u.kind} update ${u.id}: ${reason}`);
  } else throw new Error(usage);
  await closePools();
}

function loadAuthorFallback(): string {
  try {
    return loadConfig().author;
  } catch {
    return process.env.USER || process.env.USERNAME || "unknown";
  }
}

main();
