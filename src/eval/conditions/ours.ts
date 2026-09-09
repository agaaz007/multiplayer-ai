import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import type { ConditionPlugin, TrialContext, OriginRun, FixtureEvent, Harness } from "../types.js";
import { helperOnce } from "../../helper/daemon.js";
import { writeSignal } from "../../helper/signals.js";
import { classifySession } from "../../continuity/classify.js";
import { getPool, migrate } from "../../continuity/db.js";
import * as S from "../../continuity/store.js";
import { checkoutWip, repoIdentity } from "../../continuity/shadow.js";
import { detectHarness } from "../../continuity/events.js";
import { loadAll, type Config } from "../../store.js";

/**
 * Condition "ours": the successor gets what the production system would give it.
 *
 *   prepare        run the real capture helper (`helperOnce`) against the origin transcripts, into the
 *                  TRIAL config dir and the eval database: events, verified shadow snapshot on the bare
 *                  remote, a `turn` checkpoint (checkpoint signal), release (end signal), then the real
 *                  classifier synchronously. Nothing is hand-written into the store.
 *   successorSetup an MCP config that runs `node dist/cli.js mcp` with LEDGER_CONFIG_DIR = the trial dir,
 *                  the trial config author switched to the successor.
 *   evidenceRef    fixture text → `event:<session>:<seq>` from cont_events (trial sessions only), or
 *                  `ledger:<id>` when a decision in the trial ledger carries the text (D02).
 *
 * Isolation: LEDGER_CONFIG_DIR = the trial config dir and LEDGER_EVAL=1 are set only for the duration of
 * each plugin call and restored after (withEnv); the helper walks private per-session roots (symlinks to
 * the origin transcripts under <configDir>/eval-roots) so it never tails anything but the trial's sessions;
 * `continuity.repos` pins capture to the fixture repo. This module never calls initLedger/saveConfig: the
 * trial config.json (written by the fixture) is read and rewritten with fs only. On 2026-09-09 a test that
 * called initLedger() without LEDGER_CONFIG_DIR repointed the real ~/.ledger/config.json for hours; the
 * guards here (`assertIsolated`) refuse a config dir that is the real one or a database that is the real one.
 */

const ACTIVE_WINDOW_MIN = 14 * 24 * 60; // any origin transcript counts as active, however old the run
const CAPTURE_TIMEOUT_MS = 90_000;
const ORIGIN_FILE = "eval-origin.json";
/** Env every plugin call runs under: the trial's config dir, and the store's eval guard armed. */
const evalEnv = (ctx: TrialContext): Record<string, string> => ({ LEDGER_CONFIG_DIR: ctx.paths.configDir, LEDGER_EVAL: "1" });

export interface OriginSession { id: string; harness: Harness; transcript: string; author: string; label: string | null }
interface OriginRecord { sessions: (OriginSession & { wip_ref: string | null; wip_commit: string | null; thread_id: string | null })[]; repo: string; repo_identity: string }

const norm = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).toString().trim();

/** Set env vars for the duration of `fn`, restoring the previous values (including absence) after. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  const apply = (m: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(m)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  apply(vars);
  try { return await fn(); } finally { apply(prev); }
}

// ---------- trial config ----------

function configFile(ctx: TrialContext): string { return path.join(ctx.paths.configDir, "config.json"); }

function realpathSafe(p: string): string { try { return fs.realpathSync(p); } catch { return p; } }

/** The machine's real ~/.ledger/config.json (never LEDGER_CONFIG_DIR): what a trial must never read or write. */
function realMachineConfig(): { dir: string; database_url: string | null } {
  const dir = path.join(os.homedir(), ".ledger");
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    return { dir, database_url: typeof j?.continuity?.database_url === "string" ? j.continuity.database_url : null };
  } catch { return { dir, database_url: null }; }
}

/**
 * Refuse to run a trial against the real machine config or the real (Neon) continuity database. Cheap, and
 * the only thing standing between a mis-built TrialContext and another config clobber.
 */
export function assertIsolated(ctx: TrialContext): void {
  const real = realMachineConfig();
  const dir = ctx.paths.configDir;
  if (!dir || !path.isAbsolute(dir)) throw new Error(`ours: trial configDir must be absolute (got ${JSON.stringify(dir)})`);
  if (realpathSafe(dir) === realpathSafe(real.dir)) throw new Error(`ours: trial configDir is the real ${real.dir}; refusing`);
  if (!ctx.evalDatabaseUrl) throw new Error("ours: evalDatabaseUrl is empty");
  if (real.database_url && ctx.evalDatabaseUrl === real.database_url) throw new Error("ours: evalDatabaseUrl is the real continuity database from ~/.ledger/config.json; refusing");
  if (/neon\.tech/i.test(ctx.evalDatabaseUrl)) throw new Error("ours: evalDatabaseUrl points at Neon; the eval database must be local and disposable");
}

/**
 * The trial's config.json, normalized: ledger_dir, author, git_sync off unless stated, continuity pinned to
 * the eval database and to the fixture repo (`repos`). Rewritten only when something was missing or wrong;
 * unknown keys are preserved. `author` overrides the file's author for the returned Config only.
 */
export function trialConfig(ctx: TrialContext, opts: { author?: string; write?: boolean } = {}): Config {
  assertIsolated(ctx);
  const file = configFile(ctx);
  let raw: Record<string, any> = {};
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { raw = {}; }
  const before = JSON.stringify(raw);
  raw.ledger_dir = raw.ledger_dir ?? ctx.paths.ledgerDir;
  raw.author = raw.author ?? ctx.originAuthor;
  raw.git_sync = raw.git_sync ?? false;
  const cont: Record<string, any> = raw.continuity && typeof raw.continuity === "object" ? raw.continuity : {};
  if (cont.database_url && cont.database_url !== ctx.evalDatabaseUrl) ctx.log(`ours: trial config database_url differed from the eval database; pinned to the eval database`);
  cont.database_url = ctx.evalDatabaseUrl;
  cont.machine = cont.machine ?? `eval-${os.hostname()}`;
  const repos = new Set<string>(Array.isArray(cont.repos) ? cont.repos.filter((x: unknown) => typeof x === "string" && x) : []);
  if (!repos.size) { repos.add(ctx.paths.repo); repos.add(realpathSafe(ctx.paths.repo)); }
  cont.repos = [...repos];
  raw.continuity = cont;
  if (opts.write !== false && JSON.stringify(raw) !== before) {
    fs.mkdirSync(ctx.paths.configDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
  }
  return {
    ledger_dir: path.resolve(raw.ledger_dir),
    author: opts.author ?? raw.author,
    git_sync: Boolean(raw.git_sync),
    ...(raw.data_tools ? { data_tools: raw.data_tools } : {}),
    ...(raw.extractor ? { extractor: raw.extractor } : {}),
    continuity: { ...cont, database_url: ctx.evalDatabaseUrl },
  };
}

/** Switch the trial config's author with fs (never saveConfig); every other key is preserved byte for byte. */
function rewriteConfigAuthor(ctx: TrialContext, author: string): void {
  assertIsolated(ctx);
  const file = configFile(ctx);
  let raw: Record<string, any> = {};
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { raw = {}; }
  raw.author = author;
  fs.mkdirSync(ctx.paths.configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
}

// ---------- origin sessions ----------

function walk(dir: string, depth: number): string[] {
  const out: string[] = [];
  if (depth < 0 || !fs.existsSync(dir)) return out;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, depth - 1));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** Transcript roots to search when an origin session's path is unknown: LEDGER_EVAL_TRANSCRIPT_ROOTS (JSON) or the harness defaults. */
export function searchRoots(): { claude: string; codex: string } {
  const def = { claude: path.join(os.homedir(), ".claude", "projects"), codex: path.join(os.homedir(), ".codex", "sessions") };
  const env = process.env.LEDGER_EVAL_TRANSCRIPT_ROOTS;
  if (!env) return def;
  try {
    const j = JSON.parse(env);
    return { claude: typeof j.claude === "string" ? j.claude : def.claude, codex: typeof j.codex === "string" ? j.codex : def.codex };
  } catch { return def; }
}

/** The session id the helper will key this transcript on: Claude = file name; Codex = session_meta id (else the uuid in the name). */
export function sessionIdOf(file: string, harness: Harness): string {
  if (harness === "claude") return path.basename(file, ".jsonl");
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const first = buf.toString("utf8", 0, n).split("\n")[0];
    const j = JSON.parse(first);
    if (j?.type === "session_meta" && j?.payload?.id) return String(j.payload.id);
  } catch { /* fall through */ }
  const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
  return m?.[1] ?? path.basename(file, ".jsonl");
}

function findTranscriptById(id: string): string | null {
  const roots = searchRoots();
  for (const f of [...walk(roots.claude, 3), ...walk(roots.codex, 5)]) {
    if (path.basename(f).includes(id)) return f;
  }
  return null;
}

/**
 * Origin sessions with their transcript file, harness, and author. Authors follow the fixture's session
 * labels: the first label (session-a) is ctx.originAuthor, any other label is ctx.successorAuthor (the
 * kit's two humans; swapped by direction). Transcript paths come from the origin run; a session whose
 * path is missing is located by id under the search roots.
 */
export function resolveOriginSessions(ctx: TrialContext, origin: OriginRun): OriginSession[] {
  const labels: string[] = [];
  for (const e of ctx.request.case.events) if (!labels.includes(e.session)) labels.push(e.session);
  const eventById = new Map(ctx.request.case.events.map((e) => [e.id, e]));
  const labelOf = (sid: string): string | null => {
    for (const t of origin.turns) { if (t.sessionId === sid) { const ev = eventById.get(t.fixtureEventId); if (ev) return ev.session; } }
    const i = origin.sessionIds.indexOf(sid);
    return i >= 0 && i < labels.length ? labels[i] : null;
  };
  const authorOf = (label: string | null): string => (label === null || labels.indexOf(label) <= 0 ? ctx.originAuthor : ctx.successorAuthor);

  const out = new Map<string, OriginSession>();
  const add = (file: string) => {
    if (!fs.existsSync(file)) return;
    const harness = detectHarness(file);
    const id = sessionIdOf(file, harness);
    if (out.has(id)) return;
    const label = labelOf(id);
    out.set(id, { id, harness, transcript: file, author: authorOf(label), label });
  };
  for (const p of origin.transcriptPaths ?? []) if (p) add(p);
  for (const t of origin.turns ?? []) if (t.transcriptPath) add(t.transcriptPath);
  for (const sid of origin.sessionIds ?? []) {
    if ([...out.values()].some((s) => s.id === sid)) continue;
    const f = findTranscriptById(sid);
    if (f) add(f); else ctx.log(`ours: no transcript found for origin session ${sid}`);
  }
  // keep the fixture's session order
  return [...out.values()].sort((a, b) => (a.label && b.label ? labels.indexOf(a.label) - labels.indexOf(b.label) : 0));
}

/** A private root pair containing only this session's transcript (symlink; copy if the link fails). */
function privateRoots(ctx: TrialContext, s: OriginSession, n: number): { claude: string; codex: string } {
  const base = path.join(ctx.paths.configDir, "eval-roots", String(n));
  const claude = path.join(base, "claude");
  const codex = path.join(base, ".codex", "sessions");
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  const link = path.join(s.harness === "codex" ? codex : claude, path.basename(s.transcript));
  if (!fs.existsSync(link)) {
    try { fs.symlinkSync(s.transcript, link); } catch { fs.copyFileSync(s.transcript, link); }
  }
  return { claude, codex };
}

function originFile(ctx: TrialContext): string { return path.join(ctx.paths.configDir, ORIGIN_FILE); }
function readOrigin(ctx: TrialContext): OriginRecord | null {
  try { return JSON.parse(fs.readFileSync(originFile(ctx), "utf8")); } catch { return null; }
}

async function trialSessionIds(ctx: TrialContext, pool: pg.Pool): Promise<string[]> {
  const rec = readOrigin(ctx);
  if (rec?.sessions?.length) return rec.sessions.map((s) => s.id);
  const ident = repoIdentity(ctx.paths.repo);
  const r = await pool.query<{ id: string }>(`select id from cont_sessions where repo = $1 or cwd = any($2) order by last_seen_at`, [ident, [ctx.paths.repo, realpathSafe(ctx.paths.repo)]]);
  return r.rows.map((x) => x.id);
}

// ---------- prepare ----------

function worktreeDirty(repo: string): boolean {
  try { return git(repo, "status", "--porcelain").length > 0; } catch { return false; }
}

async function turnCheckpoints(pool: pg.Pool, sid: string): Promise<number> {
  return (await pool.query<{ n: number }>(`select count(*)::int as n from cont_checkpoints where session_id = $1 and kind = 'turn'`, [sid])).rows[0].n;
}

async function prepare(ctx: TrialContext, origin: OriginRun): Promise<{ notes: string[]; prepared_ms: number }> {
  const t0 = Date.now();
  const notes: string[] = [];
  const log = (s: string) => ctx.log(`ours: ${s}`);
  const sessions = resolveOriginSessions(ctx, origin);
  if (!sessions.length) throw new Error("ours.prepare: no origin transcripts to capture");

  // LEDGER_CLASSIFY=0: the helper must not start its own detached classification after the turn checkpoint;
  // step 4 runs the classifier synchronously so its result is in the database when prepare returns.
  // Children spawned meanwhile (the extractor behind classifySession) inherit LEDGER_EVAL and LEDGER_CONFIG_DIR.
  return withEnv({ ...evalEnv(ctx), LEDGER_CLASSIFY: "0", LEDGER_GIT_SYNC: process.env.LEDGER_GIT_SYNC ?? "0" }, async () => {
    const baseCfg = trialConfig(ctx);
    const pool = getPool(baseCfg);
    await migrate(pool);
    // a pass clock: strictly increasing so snapshots are always due and every file is inside the active window
    let clock = Math.max(Date.now(), ...sessions.map((s) => { try { return fs.statSync(s.transcript).mtimeMs; } catch { return 0; } }));
    const tick = () => new Date((clock += 1000));
    const pass = async (cfg: Config, roots: { claude: string; codex: string }) => {
      const sum = await helperOnce(cfg, { roots, now: tick(), push: true, classifyWaitMs: 0, activeWindowMin: ACTIVE_WINDOW_MIN, quietEndMin: ACTIVE_WINDOW_MIN, snapshotIntervalS: 0, log });
      for (const e of sum.errors) log(`pass error: ${e}`);
      return sum;
    };
    const expectSnapshot = worktreeDirty(ctx.paths.repo);
    const record: OriginRecord = { sessions: [], repo: ctx.paths.repo, repo_identity: repoIdentity(ctx.paths.repo) };

    let n = 0;
    for (const s of sessions) {
      const cfg: Config = { ...baseCfg, author: s.author };
      const roots = privateRoots(ctx, s, ++n);
      log(`capturing ${s.harness} session ${s.id.slice(0, 8)} as ${s.author} from ${s.transcript}`);

      // 1. tail + upload + snapshot until the offset stops advancing and (when the worktree is dirty) a verified snapshot exists
      const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
      let prevOffset = -1, passes = 0, row: S.SessionRow | null = null, lastErrors: string[] = [];
      for (;;) {
        const sum = await pass(cfg, roots);
        passes++;
        lastErrors = sum.errors;
        row = await S.getSession(pool, s.id);
        const offset = Number(row?.transcript_offset ?? 0);
        const size = (() => { try { return fs.statSync(s.transcript).size; } catch { return 0; } })();
        const snapshotOk = !expectSnapshot || !row?.repo || Boolean(row?.wip_commit && row?.last_verified_snapshot_at);
        const stable = row !== null && offset === prevOffset && offset > 0 && sum.events_spooled === 0 && sum.events_uploaded === 0;
        if (stable && offset >= size && snapshotOk) break;
        if (stable && snapshotOk && passes >= 3) break; // trailing partial line: the helper will not consume it, and nothing else is moving
        if (Date.now() > deadline) {
          notes.push(`capture timeout for ${s.id.slice(0, 8)} after ${passes} passes: offset ${offset}/${size}, snapshot ${row?.wip_commit ? "verified" : "missing"}${lastErrors.length ? `, errors: ${lastErrors.join(" | ")}` : ""}`);
          break;
        }
        prevOffset = offset;
        await sleep(400);
      }
      if (!row) { notes.push(`session ${s.id.slice(0, 8)} was not captured (not in cont_sessions after ${passes} passes)${lastErrors.length ? `: ${lastErrors.join(" | ")}` : ""}`); continue; }

      // 2. a `turn` checkpoint, as the Stop hook would signal it
      writeSignal(s.id, "checkpoint");
      await pass(cfg, roots);
      let turns = await turnCheckpoints(pool, s.id);
      if (!turns) { writeSignal(s.id, "checkpoint"); await pass(cfg, roots); turns = await turnCheckpoints(pool, s.id); }
      // 3. the session is over: SessionEnd → release the claim so a successor can continue
      writeSignal(s.id, "end");
      await pass(cfg, roots);
      row = await S.getSession(pool, s.id);
      const events = (await pool.query<{ n: number }>(`select count(*)::int as n from cont_events where session_id = $1`, [s.id])).rows[0].n;
      record.sessions.push({ ...s, wip_ref: row?.wip_ref ?? null, wip_commit: row?.wip_commit ?? null, thread_id: row?.thread_id ?? null });
      notes.push(`${s.harness} session ${s.id.slice(0, 8)} (${s.author}): ${events} events uploaded in ${passes} passes, snapshot ${row?.wip_commit ? `${row.wip_commit.slice(0, 12)}${row.last_verified_snapshot_at ? " remote-verified" : " NOT verified"}` : expectSnapshot ? "missing" : "none (worktree clean)"}, thread ${row?.thread_id ? row.thread_id.slice(0, 8) : "unbound"}, turn checkpoints ${turns}, claim ${row?.ended_at ? "released" : "still held"}`);
    }
    fs.writeFileSync(originFile(ctx), JSON.stringify(record, null, 2) + "\n");

    // 4. the real classifier, synchronously, per session
    for (const s of record.sessions) {
      const cfg: Config = { ...baseCfg, author: s.author };
      try {
        const r = await classifySession(cfg, pool, s.id, { now: tick(), log });
        if (!r.model_ok) notes.push(`classifier ${s.id.slice(0, 8)}: failed: ${r.error}`);
        else notes.push(`classifier ${s.id.slice(0, 8)}: ${r.events_considered} events → ${r.records_created} record(s) created, ${r.assignments_applied} span(s) linked, ${r.updates_proposed} update(s) proposed, ${r.unassigned.length} unassigned${r.rejected.length ? `, ${r.rejected.length} rejected` : ""}`);
      } catch (e: any) {
        notes.push(`classifier ${s.id.slice(0, 8)}: threw: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
    return { notes, prepared_ms: Date.now() - t0 };
  });
}

// ---------- successor ----------

/**
 * The ledger CLI the successor's MCP server runs: LEDGER_EVAL_CLI_JS, else the cli.js of the build this module
 * runs from (the same sources as the plugin), else the repo's dist/cli.js.
 */
export function cliPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // <build>/eval/conditions
  const buildDir = path.resolve(here, "..", "..");
  const root = path.resolve(buildDir, "..");
  const candidates = [process.env.LEDGER_EVAL_CLI_JS, path.join(buildDir, "cli.js"), path.join(root, "dist", "cli.js")].filter((c): c is string => Boolean(c));
  for (const c of candidates) if (fs.existsSync(c)) return path.resolve(c);
  throw new Error(`ours: no ledger cli.js found (tried ${candidates.join(", ")})`);
}

/**
 * The successor's MCP server: `node <cli.js> mcp` reading the TRIAL config dir as the successor author, with
 * LEDGER_EVAL=1 so the store refuses to write any real config, and LEDGER_CONTINUITY_DB pinned to the eval
 * database (belt and braces over the config's own database_url).
 */
export function mcpServerConfig(ctx: TrialContext) {
  return {
    mcpServers: {
      ledger: {
        command: process.execPath,
        args: [cliPath(), "mcp"],
        env: { LEDGER_CONFIG_DIR: ctx.paths.configDir, LEDGER_AUTHOR: ctx.successorAuthor, LEDGER_EVAL: "1", LEDGER_CONTINUITY_DB: ctx.evalDatabaseUrl },
      },
    },
  };
}

async function successorSetup(ctx: TrialContext) {
  return withEnv(evalEnv(ctx), async () => {
    const mcpConfigPath = path.join(ctx.paths.configDir, "mcp-ours.json");
    fs.mkdirSync(ctx.paths.configDir, { recursive: true });
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpServerConfig(ctx), null, 2) + "\n");
    trialConfig(ctx); // normalize first (repos, database) so hooks reading it see the same pins
    rewriteConfigAuthor(ctx, ctx.successorAuthor);
    return {
      env: { LEDGER_CONFIG_DIR: ctx.paths.configDir, LEDGER_EVAL: "1", LEDGER_CONTINUITY_DB: ctx.evalDatabaseUrl },
      mcpConfigPath,
      allowedTools: ["mcp__ledger__*", "Read", "Glob", "Grep", "Bash(git *)", "Bash(ls *)", "Bash(cat *)"],
      cwd: ctx.paths.successorRepo,
      preamble: "",
    };
  });
}

/**
 * Check the origin's verified snapshot out of the bare remote into `<successorRepo>-wt` (the adapter copies
 * recovered files from it and points the successor there for E cases). Null when no origin session has a
 * snapshot (clean worktree, or nothing captured). Idempotent: an existing worktree is returned as is.
 */
export async function bootstrapWorktree(ctx: TrialContext): Promise<{ worktree: string; wip_ref: string; wip_commit: string } | null> {
  return withEnv(evalEnv(ctx), async () => {
    const cfg = trialConfig(ctx, { write: false });
    const pool = getPool(cfg);
    const ids = await trialSessionIds(ctx, pool);
    if (!ids.length) return null;
    const r = await pool.query<{ id: string; wip_ref: string; wip_commit: string }>(
      `select id, wip_ref, wip_commit from cont_sessions where id = any($1) and wip_ref is not null and wip_commit is not null order by last_verified_snapshot_at desc nulls last, last_seen_at desc limit 1`,
      [ids]
    );
    const row = r.rows[0];
    if (!row) return null;
    const dest = `${ctx.paths.successorRepo}-wt`;
    if (fs.existsSync(dest)) return { worktree: dest, wip_ref: row.wip_ref, wip_commit: row.wip_commit };
    checkoutWip(ctx.paths.successorRepo, row.wip_ref, row.wip_commit, dest);
    ctx.log(`ours: checked out ${row.wip_ref} @ ${row.wip_commit.slice(0, 12)} into ${dest}`);
    return { worktree: dest, wip_ref: row.wip_ref, wip_commit: row.wip_commit };
  });
}

// ---------- evidence ----------

async function evidenceRef(ctx: TrialContext, fixtureEvent: FixtureEvent): Promise<{ system_ref: string } | null> {
  const text = String(fixtureEvent.text ?? "");
  const want = norm(text);
  if (!want) return null;
  return withEnv(evalEnv(ctx), () => evidenceRefInner(ctx, text, want));
}

async function evidenceRefInner(ctx: TrialContext, text: string, want: string): Promise<{ system_ref: string } | null> {
  const cfg = trialConfig(ctx, { write: false });

  // a decision in the trial ledger whose `decision` carries the text (D02: real Ledger objects with supersedes)
  try {
    const decisions = loadAll(cfg, ["decision"], false);
    const exact = decisions.find((d) => norm(String(d.fields.decision ?? "")) === want);
    const contains = exact ?? decisions.find((d) => norm(String(d.fields.decision ?? "")).includes(want));
    if (contains) return { system_ref: `ledger:${contains.id}` };
  } catch (e: any) { ctx.log(`ours: ledger lookup failed: ${String(e?.message ?? e).slice(0, 120)}`); }

  const pool = getPool(cfg);
  const ids = await trialSessionIds(ctx, pool);
  if (!ids.length) return null;
  const order = `order by (kind = 'instruction.added') desc, session_id, seq`;
  const exact = await pool.query<{ session_id: string; seq: number }>(`select session_id, seq from cont_events where session_id = any($1) and payload->>'text' = $2 ${order} limit 1`, [ids, text]);
  if (exact.rows[0]) return { system_ref: `event:${exact.rows[0].session_id}:${exact.rows[0].seq}` };
  const pattern = "%" + want.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
  const loose = await pool.query<{ session_id: string; seq: number }>(
    `select session_id, seq from cont_events where session_id = any($1) and regexp_replace(coalesce(payload->>'text',''), '\\s+', ' ', 'g') ilike $2 ${order} limit 1`,
    [ids, pattern]
  );
  if (loose.rows[0]) return { system_ref: `event:${loose.rows[0].session_id}:${loose.rows[0].seq}` };
  return null;
}

export const ours: ConditionPlugin = { name: "ours", prepare, successorSetup, evidenceRef };
