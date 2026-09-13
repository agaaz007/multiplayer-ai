import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import matter from "gray-matter";
import type { z } from "zod";
import { DIRS, SCHEMAS, TYPES, type LedgerObject, type LedgerType } from "./schema.js";
import { isGeneratedView, regenerateViews } from "./views.js";
import { validateClaim, validateDependencies, validateEvidenceReferences, validateSupersession } from "./authority.js";

// ---------- config ----------

export interface Config {
  ledger_dir: string;
  author: string;
  git_sync: boolean;
  /** Regexes over tool names that count as data work for the Stop checkpoint. Defaults in hooks.ts. */
  data_tools?: string[];
  /** Which CLI runs the transcript fallback: "claude" | "codex" | "auto" (default) | "none". */
  extractor?: string;
  /** Execution continuity: shared Postgres for threads/sessions/events/claims. Absent = feature off. */
  continuity?: ContinuityConfig;
}

export interface ContinuityConfig {
  /** postgres:// URL. Never committed; lives in ~/.ledger/config.json (mode 600) or LEDGER_CONTINUITY_DB. */
  database_url: string;
  /** Label for this machine in sessions and notifications. Defaults to os.hostname(). */
  machine?: string;
  /** Extra deny globs for shadow commits and uploads, on top of the defaults. */
  deny?: string[];
  /** Gitignored paths that must still be captured (e.g. generated assets a study needs). Repo-relative globs. */
  include?: string[];
  /** Only these repo remotes/paths are captured. Empty or absent = every git worktree a session runs in. */
  repos?: string[];
  /** Shadow commit cadence in seconds. Default 30. */
  snapshot_interval_s?: number;
  /** Run the span→work-record classifier after turn checkpoints. Default true. LEDGER_CLASSIFY=0 also disables. */
  classify?: boolean;
  /** Sessions whose repo root is under one of these path prefixes are ignored by this machine's helper (e.g. evaluation fixtures). */
  exclude_paths?: string[];
  /** A helper pass running longer than this exits the process so launchd restarts it. Default 900. */
  pass_deadline_s?: number;
}

/**
 * Machine-level state: config, session journals, the reconcile log.
 * Resolved per call, never at import time — a module-level constant captures
 * whatever HOME was when the module loaded, which silently wrote the real
 * ~/.ledger/config.json from tests that set HOME after importing.
 * LEDGER_CONFIG_DIR overrides it outright.
 */
export function ledgerHome(): string {
  return process.env.LEDGER_CONFIG_DIR || path.join(os.homedir(), ".ledger");
}
const configFile = () => path.join(ledgerHome(), "config.json");

export function loadConfig(): Config {
  const env = process.env.LEDGER_DIR;
  let cfg: Partial<Config> = {};
  if (fs.existsSync(configFile())) {
    cfg = JSON.parse(fs.readFileSync(configFile(), "utf8"));
  }
  const ledger_dir = env || cfg.ledger_dir;
  if (!ledger_dir) {
    throw new Error(
      `No ledger configured. Run: ledger init <dir>   (or set LEDGER_DIR)`
    );
  }
  return {
    ledger_dir: path.resolve(ledger_dir),
    author: process.env.LEDGER_AUTHOR || cfg.author || os.userInfo().username,
    git_sync: process.env.LEDGER_GIT_SYNC
      ? process.env.LEDGER_GIT_SYNC !== "0"
      : cfg.git_sync ?? true,
    ...(cfg.data_tools ? { data_tools: cfg.data_tools } : {}),
    ...(cfg.extractor ? { extractor: cfg.extractor } : {}),
    ...(continuityFrom(cfg) ? { continuity: continuityFrom(cfg)! } : {}),
  };
}

function continuityFrom(cfg: Partial<Config>): ContinuityConfig | undefined {
  const url = process.env.LEDGER_CONTINUITY_DB || cfg.continuity?.database_url;
  if (!url) return undefined;
  return { ...(cfg.continuity ?? { database_url: url }), database_url: url, machine: cfg.continuity?.machine || os.hostname() };
}

export function saveConfig(cfg: Config) {
  // Evaluation and test code must never write the real machine config. Any process that sets
  // LEDGER_EVAL=1 (or LEDGER_SELFTEST=1) has to point LEDGER_CONFIG_DIR at a disposable dir first.
  // On 2026-09-09 an eval test called initLedger() without it and repointed ~/.ledger/config.json
  // at a temp ledger for hours; real records went there and the live helper ran as another author.
  if ((process.env.LEDGER_EVAL === "1" || process.env.LEDGER_SELFTEST === "1") && !process.env.LEDGER_CONFIG_DIR) {
    throw new Error("refusing to write the real ~/.ledger/config.json from an eval/test process: set LEDGER_CONFIG_DIR to a disposable directory");
  }
  fs.mkdirSync(ledgerHome(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + "\n");
}

// ---------- git sync (best-effort, never throws) ----------

// Reads pull at most once a minute, per ledger. Writes always pull first.
const lastPull = new Map<string, number>();
const PULL_INTERVAL_MS = 60_000;
const PUSH_ATTEMPTS = 3;
const MAX_REPLAYED_COMMITS = 50;

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
    // rebase --continue must never wait on an editor
    env: { ...process.env, GIT_EDITOR: "true" },
  })
    .toString()
    .trim();
}

function errText(e: any): string {
  return String(e?.stderr || e?.message || e)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Extra -c flags so commits work on machines with no git identity configured. */
function identity(dir: string, author: string): string[] {
  try {
    if (git(dir, ["config", "user.email"])) return [];
  } catch {
    /* not set */
  }
  return ["-c", `user.name=${author}`, "-c", `user.email=${author}@ledger.local`];
}

function isGitRepo(dir: string): boolean {
  try {
    git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

function hasRemote(dir: string): boolean {
  try {
    return git(dir, ["remote"]).length > 0;
  } catch {
    return false;
  }
}

function rebaseInProgress(dir: string): boolean {
  try {
    const gitDir = path.resolve(dir, git(dir, ["rev-parse", "--git-dir"]));
    return fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"));
  } catch {
    return false;
  }
}

/**
 * A rebase left half-done (process killed, or a pre-fix version of this tool)
 * blocks every later pull and commit. Abort it: that restores the branch tip
 * with all local commits intact, and the next sync replays them properly.
 */
function abortStaleRebase(dir: string): void {
  if (!rebaseInProgress(dir)) return;
  try {
    git(dir, ["rebase", "--abort"]);
  } catch {
    /* nothing more we can do; later commands will report */
  }
}

/**
 * Resolve every conflict in the current rebase step, then continue. Repeats
 * until the rebase finishes. Only two kinds of file can conflict:
 *   - generated views (README.md, index.md, log.md): regenerate from the merged
 *     set of objects; they are derived data and never worth a conflict
 *   - an object edited by both sides (two people superseding the same object
 *     at once): keep the commit being replayed, i.e. the local one
 * Throws if the rebase cannot be completed; caller aborts.
 */
function finishRebase(cfg: Config): void {
  const dir = cfg.ledger_dir;
  for (let step = 0; rebaseInProgress(dir); step++) {
    if (step >= MAX_REPLAYED_COMMITS) throw new Error("rebase did not converge");
    const conflicted = git(dir, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
    for (const f of conflicted) {
      if (isGeneratedView(f)) continue;
      // during a rebase, --theirs is the commit being replayed (ours, locally)
      git(dir, ["checkout", "--theirs", "--", f]);
    }
    const views = regenerateViews(cfg, loadAll(cfg, TYPES, false)).map((p) => path.relative(dir, p));
    git(dir, ["add", "--", ...new Set([...conflicted, ...views])]);
    // a replayed commit whose whole content already landed upstream has nothing
    // left to commit; git refuses --continue for it and wants --skip
    const nothingStaged = (() => {
      try {
        git(dir, ["diff", "--cached", "--quiet"]);
        return true;
      } catch {
        return false;
      }
    })();
    try {
      git(dir, ["rebase", nothingStaged ? "--skip" : "--continue"]);
    } catch (e) {
      if (!rebaseInProgress(dir)) throw e; // finished but errored: give up
      // else: the next replayed commit also conflicts; loop resolves it
    }
  }
}

/**
 * Bring local up to date with the remote. If replaying local commits conflicts
 * (only possible on generated views, or on the same object superseded twice),
 * resolve mechanically. Never leaves the repo mid-rebase.
 *
 * With `refreshViews`, regenerate views from the merged state afterwards and
 * commit if they changed, so what gets pushed is never a stale dashboard.
 * Writes want this; reads don't (a read should not create commits).
 */
function rebaseOnRemote(cfg: Config, refreshViews: boolean): void {
  const dir = cfg.ledger_dir;
  const before = git(dir, ["rev-parse", "HEAD"]);
  try {
    git(dir, ["pull", "--rebase", "--quiet", "--autostash"]);
  } catch (e) {
    if (!rebaseInProgress(dir)) throw e; // network / auth / no upstream: nothing to resolve
    try {
      finishRebase(cfg);
    } catch (e2) {
      abortStaleRebase(dir);
      throw e2;
    }
  }
  if (!refreshViews || git(dir, ["rev-parse", "HEAD"]) === before) return;
  const views = regenerateViews(cfg, loadAll(cfg, TYPES, false)).map((p) => path.relative(dir, p));
  git(dir, ["add", "--", ...views]);
  try {
    git(dir, ["diff", "--cached", "--quiet"]);
  } catch {
    git(dir, [...identity(dir, cfg.author), "commit", "--quiet", "-m", "ledger: refresh views"]);
  }
}

export function pull(cfg: Config, force = false): string | null {
  if (!cfg.git_sync) return null;
  const dir = cfg.ledger_dir;
  const lock = knowledgeWriteLock(cfg);
  if (fs.existsSync(lock)) {
    try {
      const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
      if (owner.host !== os.hostname() || owner.pid !== process.pid) return "pull deferred: another Ledger writer holds this checkout";
    } catch { return "pull deferred: Ledger write lock is not yet readable"; }
  }
  if (!force && Date.now() - (lastPull.get(dir) ?? 0) < PULL_INTERVAL_MS) return null;
  lastPull.set(dir, Date.now());
  if (!isGitRepo(dir) || !hasRemote(dir)) return null;
  abortStaleRebase(dir);
  try {
    rebaseOnRemote(cfg, false);
    return null;
  } catch (e) {
    return `pull failed: ${errText(e)}`;
  }
}

export function commitAndPush(cfg: Config, message: string, files: string[]): string | null {
  if (!cfg.git_sync) return null;
  const dir = cfg.ledger_dir;
  if (!isGitRepo(dir)) return null;
  abortStaleRebase(dir);
  try {
    git(dir, ["add", "--", ...files]);
    git(dir, [...identity(dir, cfg.author), "commit", "--quiet", "-m", message]);
  } catch (e) {
    return `commit failed: ${errText(e)}`;
  }
  if (!hasRemote(dir)) return "committed (no remote)";

  let last = "";
  for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt++) {
    try {
      rebaseOnRemote(cfg, true);
    } catch (e) {
      return `committed locally; sync failed: ${errText(e)}`;
    }
    try {
      git(dir, ["push", "--quiet"]);
      lastPull.set(dir, Date.now());
      return "committed and pushed";
    } catch (e) {
      last = errText(e); // someone pushed between our rebase and push; go again
    }
  }
  return `committed locally; push failed after ${PUSH_ATTEMPTS} attempts: ${last}`;
}

// ---------- ids ----------

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const PREFIX: Record<LedgerType, string> = {
  definition: "def",
  finding: "fnd",
  change: "chg",
  decision: "dec",
};

export function makeId(type: LedgerType, title: string, when = new Date()): string {
  const d = when.toISOString().slice(0, 10).replace(/-/g, "");
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${PREFIX[type]}-${d}-${slug(title)}-${rnd}`;
}

// ---------- read ----------

function actorToName(by: unknown): string {
  const v = String(by ?? "");
  return v.startsWith("human:") ? v.slice(6) : v;
}

/**
 * YAML parses an unquoted `2026-01-01` as a Date. Files this tool writes quote
 * dates, but hand-written and legacy files often don't. Turn Dates back into
 * the strings everything else expects: `YYYY-MM-DD` for midnight UTC, else ISO.
 */
export function normalizeYaml<T>(v: T): T {
  if (v instanceof Date) {
    const iso = v.toISOString();
    return (iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso) as unknown as T;
  }
  if (Array.isArray(v)) return v.map(normalizeYaml) as unknown as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizeYaml(x)])) as T;
  }
  return v;
}

function parseFile(file: string): LedgerObject | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const parsed = matter(raw);
  const data = normalizeYaml(parsed.data);
  if (!data || !TYPES.includes(data.type)) return null;
  const {
    id, type, title, description, tags, status, supersedes, superseded_by, previous_status,
    generated, sources, stale_after,
    // legacy keys from pre-OKF files, tolerated on read
    created, author,
    ...fields
  } = data;
  // OKF `sources` -> our simple `source` field for rendering/search
  if (Array.isArray(sources) && sources[0]?.resource && fields.source === undefined) {
    fields.source = sources[0].resource;
  }
  if (stale_after && fields.revisit_by === undefined && type === "decision") {
    fields.revisit_by = String(stale_after).slice(0, 10);
  }
  const fileId = path.basename(file, ".md");
  return {
    id: String(id ?? fileId),
    type,
    created: String(generated?.at ?? created ?? ""),
    path: file,
    title: String(title ?? fileId),
    author: generated?.by ? actorToName(generated.by) : String(author ?? ""),
    description: String(description ?? ""),
    tags: Array.isArray(tags) ? tags.map(String) : [],
    status: status === "active" ? "stable" : status === "superseded" || status === "retracted" ? "deprecated" : status ?? "stable",
    supersedes: supersedes ? String(supersedes) : undefined,
    superseded_by: superseded_by ? String(superseded_by) : undefined,
    previous_status: previous_status === 'stable' || previous_status === 'draft' ? previous_status : undefined,
    body: parsed.content.trim(),
    fields,
  };
}

/**
 * All objects, newest first. `sync` pulls from the remote first (throttled to
 * once a minute); pass false when the caller has just pulled or is mid-git.
 */
export function loadAll(cfg: Config, types: readonly LedgerType[] = TYPES, sync = true): LedgerObject[] {
  if (sync) pull(cfg);
  const out: LedgerObject[] = [];
  for (const t of types) {
    const dir = path.join(cfg.ledger_dir, DIRS[t]);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md") || f === "README.md" || f === "index.md" || f === "log.md") continue;
      const obj = parseFile(path.join(dir, f));
      if (obj) out.push(obj);
    }
  }
  // deterministic: every machine must generate byte-identical views
  out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : a.id < b.id ? -1 : 1));
  return out;
}

export function getById(cfg: Config, id: string): LedgerObject | null {
  return loadAll(cfg).find((o) => o.id === id) ?? null;
}

// ---------- write ----------

export interface RecordInput {
  type: LedgerType;
  fields: Record<string, unknown>;
}

export interface RecordResult {
  id: string;
  path: string;
  git: string | null;
  superseded?: string;
}

function describe(type: LedgerType, f: Record<string, unknown>): string {
  const pick = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").slice(0, 180);
  switch (type) {
    case "definition": return pick(`${f.metric} = ${f.formula}`);
    case "finding": return pick(`${f.question} → ${f.result}`);
    case "change": return pick(f.what);
    case "decision": return pick(f.decision);
  }
}

function prepare(cfg: Config, input: RecordInput): Record<string, any> {
  if (input.fields.author !== undefined && input.fields.author !== cfg.author) {
    throw new Error("record author must match configured Ledger author; preserve another person's contribution through source references");
  }
  const raw: Record<string, any> = { ...input.fields, author: cfg.author };
  // a finding's headline `source` is its first input unless stated
  if (input.type === "finding" && !raw.source && Array.isArray(raw.inputs) && raw.inputs[0]?.source) {
    raw.source = raw.inputs[0].source;
  }
  return raw;
}

function issuesOf(parsed: { success: false; error: { issues: any[] } }): string {
  return parsed.error.issues.map((i: any) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** The main field per type: the one thing a draft must have to be worth reviewing. */
const MAIN_FIELD: Record<LedgerType, string[]> = {
  definition: ["metric", "formula"],
  finding: ["question", "result"],
  change: ["what"],
  decision: ["decision"],
};

/**
 * Write one object: file, supersede bookkeeping, regenerated views, commit,
 * push. `data` is already validated. `extra` lands in the frontmatter after
 * the standard families (used for draft capture metadata).
 */
function persist(
  cfg: Config,
  type: LedgerType,
  data: Record<string, any>,
  opts: { extra?: Record<string, unknown>; commitPrefix?: string } = {}
): RecordResult {
  return withKnowledgeWriteLock(cfg, () => persistLocked(cfg, type, data, opts));
}

function knowledgeWriteLock(cfg: Config): string {
  const lockDir = isGitRepo(cfg.ledger_dir) ? path.resolve(cfg.ledger_dir, git(cfg.ledger_dir, ["rev-parse", "--git-dir"])) : cfg.ledger_dir;
  return path.join(lockDir, ".ledger-write.lock");
}

function withKnowledgeWriteLock<T>(cfg: Config, work: () => T): T {
  fs.mkdirSync(cfg.ledger_dir, { recursive: true });
  const lock = knowledgeWriteLock(cfg);
  let fd: number;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    // A crashed writer must not block the store indefinitely. Only remove our own machine's dead process lock.
    let stale = false;
    try {
      const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
      if (owner.host === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (probe: any) { stale = probe.code === "ESRCH"; }
      }
    } catch { /* incomplete/foreign lock is not safe to remove */ }
    if (!stale) throw new Error("another Ledger write is in progress; retry after it finishes");
    fs.unlinkSync(lock);
    fd = fs.openSync(lock, "wx", 0o600);
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }));
    return work();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

/** Source files appear atomically to concurrent readers; temporary files do not match the .md reader. */
function writeKnowledgeFile(file: string, content: string): void {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try { fs.writeFileSync(temp, content, { flag: "wx" }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function persistLocked(
  cfg: Config,
  type: LedgerType,
  data: Record<string, any>,
  opts: { extra?: Record<string, unknown>; commitPrefix?: string } = {}
): RecordResult {
  const { body, author, title, description, tags, status, supersedes, source, ...rest } = data;

  // Always start from the latest remote state: the generated views are a
  // function of the whole object set, so writing from a stale tree would
  // commit a dashboard that lacks whatever teammates just recorded.
  pull(cfg, true);
  const objects = loadAll(cfg, TYPES, false);
  if (data.acceptance && data.acceptance.actor !== cfg.author) throw new Error("acceptance.actor must match configured Ledger author");
  validateDependencies(objects, data, type);
  validateClaim(objects, type, data);
  validateEvidenceReferences(objects, data);
  const predecessor = validateSupersession(objects, type, data, cfg.author);

  const now = new Date();
  const id = makeId(type, String(title), now);
  const dir = path.join(cfg.ledger_dir, DIRS[type]);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);

  // OKF v0.2 frontmatter. `type` is the only required key; the rest is the
  // recommended + trust/lifecycle families, then our type-specific fields.
  const front: Record<string, unknown> = {
    type,
    id,
    title,
    description: description || describe(type, data),
    tags: tags ?? [],
    status: status ?? "stable",
    generated: { by: `human:${author}`, at: now.toISOString() },
  };
  if (supersedes) front.supersedes = supersedes;
  if (source) front.sources = [{ id: "primary", resource: source }];
  if (type === "decision" && rest.revisit_by) front.stale_after = `${rest.revisit_by}T00:00:00Z`;
  Object.assign(front, opts.extra ?? {});
  Object.assign(front, rest);

  writeKnowledgeFile(file, matter.stringify(body ? body + "\n" : "", front));

  const touched = [file];
  let superseded: string | undefined;
  if (supersedes && (status ?? "stable") === "stable") {
    const old = predecessor;
    if (old) {
      const raw = matter(fs.readFileSync(old.path, "utf8"));
      const d = normalizeYaml(raw.data);
      d.previous_status = old.previous_status ?? old.status;
      // A future-effective definition must not retire today's accepted definition prematurely.
      const effectiveFrom = data.correction?.effective_from;
      if (old.status === "draft" || !effectiveFrom || effectiveFrom.slice(0, 10) <= now.toISOString().slice(0, 10)) d.status = "deprecated";
      d.superseded_by = id;
      writeKnowledgeFile(old.path, matter.stringify(raw.content, d));
      touched.push(old.path);
      superseded = old.id;
    }
  }

  // Regenerate README / index.md / log.md so GitHub is the dashboard.
  touched.push(...regenerateViews(cfg, loadAll(cfg, TYPES, false)));

  const git = commitAndPush(
    cfg,
    `${opts.commitPrefix ?? type}: ${String(title).slice(0, 60)} (${author})`,
    touched.map((p) => path.relative(cfg.ledger_dir, p))
  );
  return { id, path: file, git, superseded };
}

/** Record a stable object. The full schema applies; an incomplete argument is rejected. */
export function record(cfg: Config, input: RecordInput): RecordResult {
  const parsed = SCHEMAS[input.type].safeParse(prepare(cfg, input));
  if (!parsed.success) throw new Error(`Invalid ${input.type}: ${issuesOf(parsed as any)}`);
  return persist(cfg, input.type, parsed.data as Record<string, any>);
}

export interface DraftCapture {
  method: "transcript_fallback";
  session: string;
  agent?: string;
  reason: string;
}

/**
 * Record a draft from the transcript fallback. Drafts are for review, not
 * for trust, so validation is lenient: title and the type's main field are
 * required, everything else is kept if present and well-typed. Status is
 * forced to draft; the capture metadata says where it came from and why the
 * fallback ran. A draft never enters the brief. Promote by recording a stable
 * object with `supersedes`; discard with `discardDraft`.
 */
export function recordDraft(cfg: Config, input: RecordInput & { capture: DraftCapture }): RecordResult {
  const raw = prepare(cfg, input);
  raw.status = "draft";
  for (const k of ["title", ...MAIN_FIELD[input.type]]) {
    if (typeof raw[k] !== "string" || !raw[k].trim()) throw new Error(`draft ${input.type} needs ${k}`);
  }
  if (typeof raw.title === "string") raw.title = raw.title.slice(0, 140);
  // keep only fields the schema knows and that pass their own type checks;
  // a field that fails (wrong type, or an array refine) is dropped, not fixed
  const lenient = (SCHEMAS[input.type] as z.ZodObject<any>).partial();
  let data: Record<string, any>;
  const first = lenient.safeParse(raw);
  if (first.success) data = first.data as Record<string, any>;
  else {
    const bad = new Set(first.error.issues.map((i: any) => String(i.path[0])));
    const pruned = Object.fromEntries(Object.entries(raw).filter(([k]) => !bad.has(k)));
    const again = lenient.safeParse(pruned);
    if (!again.success) throw new Error(`draft ${input.type} invalid: ${issuesOf(again as any)}`);
    data = again.data as Record<string, any>;
  }
  data.author = cfg.author;
  data.status = "draft";
  return persist(cfg, input.type, data, {
    extra: {
      capture_method: input.capture.method,
      source_session: input.capture.session,
      ...(input.capture.agent ? { source_agent: input.capture.agent } : {}),
      capture_reason: input.capture.reason,
    },
    commitPrefix: `draft ${input.type}`,
  });
}

/** Mark a draft as reviewed-and-rejected. It leaves the review list and stays in history. */
export function discardDraft(cfg: Config, id: string, reason: string): { id: string; git: string | null } {
  return withKnowledgeWriteLock(cfg, () => discardDraftLocked(cfg, id, reason));
}

function discardDraftLocked(cfg: Config, id: string, reason: string): { id: string; git: string | null } {
  pull(cfg, true);
  const o = loadAll(cfg, TYPES, false).find((x) => x.id === id);
  if (!o) throw new Error(`not found: ${id}`);
  if (o.status !== "draft") throw new Error(`${id} is ${o.status}, not a draft`);
  const raw = matter(fs.readFileSync(o.path, "utf8"));
  const d = normalizeYaml(raw.data);
  d.status = "deprecated";
  d.discarded = { by: `human:${cfg.author}`, at: new Date().toISOString(), reason };
  writeKnowledgeFile(o.path, matter.stringify(raw.content, d));
  const touched = [o.path, ...regenerateViews(cfg, loadAll(cfg, TYPES, false))];
  const git = commitAndPush(cfg, `discard ${o.type}: ${o.title.slice(0, 60)} (${cfg.author})`, touched.map((p) => path.relative(cfg.ledger_dir, p)));
  return { id, git };
}

// ---------- init ----------

export function initLedger(dir: string, author: string): string[] {
  const abs = path.resolve(dir);
  const created: string[] = [];
  const templateDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "template"
  );
  fs.mkdirSync(abs, { recursive: true });
  for (const t of TYPES) {
    const d = path.join(abs, DIRS[t]);
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
      created.push(d);
    }
  }
  for (const f of ["LEDGER.md", ".gitignore"]) {
    const src = path.join(templateDir, f);
    const dst = path.join(abs, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      if (f === "LEDGER.md") {
        // stamp the creation date; log.md's "Initialization" entry reads it
        const t = matter(fs.readFileSync(src, "utf8"));
        t.data.created = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(dst, matter.stringify(t.content, t.data));
      } else {
        fs.copyFileSync(src, dst);
      }
      created.push(dst);
    }
  }
  const cfg: Config = { ledger_dir: abs, author, git_sync: false };
  if (!fs.existsSync(path.join(abs, "README.md"))) {
    created.push(...regenerateViews(cfg, loadAll(cfg, TYPES, false)));
  }
  if (!fs.existsSync(path.join(abs, ".git"))) {
    try {
      git(abs, ["init", "--quiet", "-b", "main"]);
      git(abs, ["add", "-A"]);
      git(abs, [...identity(abs, author), "commit", "--quiet", "-m", "ledger: init"]);
      created.push(path.join(abs, ".git"));
    } catch {
      /* git optional */
    }
  }
  // keep machine-level settings (data_tools) across init/use
  let existing: Partial<Config> = {};
  try {
    if (fs.existsSync(configFile())) existing = JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    /* unreadable: overwrite */
  }
  saveConfig({ ...existing, ledger_dir: abs, author, git_sync: true });
  return created;
}
