import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ConditionPlugin, TrialContext, OriginRun, FixtureEvent } from "../types.js";
import { streamTranscript, type NormEvent } from "../../continuity/events.js";
import { resolveOriginSessions } from "./ours.js";

/**
 * Condition "gbrain": the same normalized origin events our helper sees, ingested into an isolated gbrain
 * brain (PGLite under the trial HOME), exposed to the successor through `gbrain serve` MCP tools.
 *
 *   prepare        `HOME=<trial home> gbrain init --pglite`; one page per event (`s-<session8>-<seq>`), tagged
 *                  with the kind, the session and the author, staged as markdown and written with one
 *                  `gbrain import <dir> --no-embed`; a `session-<session8>` page listing the whole session in
 *                  order; a timeline entry per event (`gbrain timeline-add`) when the event count is modest;
 *                  `gbrain embed --all` once at the end (needs OPENAI_API_KEY; failure is noted, not fatal).
 *   successorSetup an MCP config running `gbrain serve` with HOME = the trial home. The successor process
 *                  itself keeps its real HOME (its login lives there).
 *   evidenceRef    keyword search (`gbrain call search`) and an exact-text check on the page body.
 *
 * The real ~/.gbrain is never read or written: every gbrain invocation here carries HOME = trial home.
 */

const GBRAIN_FALLBACK = "/Users/Agaaz/.bun/bin/gbrain";
const CONTENT_KINDS = new Set(["instruction.added", "assistant.message", "tool.requested", "tool.finished", "file.changed", "compaction"]);
const TIMELINE_MAX_EVENTS = 200;
const INGEST_FILE = "eval-ingest.json";
const BODY_MAX = 6000;

const norm = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * Short session ids for slugs. The tail of the id, not the head: Codex ids are uuid v7, so sessions created
 * in the same hour share their leading hex and would collide as `s-<head>-<seq>`. Lengthened until unique
 * within the trial.
 */
export function sessionShorts(ids: string[]): Map<string, string> {
  const hex = (id: string) => id.replace(/-/g, "");
  const out = new Map<string, string>();
  for (let len = 8; len <= 32; len += 4) {
    out.clear();
    const seen = new Set<string>();
    let clash = false;
    for (const id of ids) {
      const s = hex(id).slice(-len) || id;
      if (seen.has(s)) { clash = true; break; }
      seen.add(s);
      out.set(id, s);
    }
    if (!clash) return out;
  }
  for (const id of ids) out.set(id, hex(id));
  return out;
}
export const sessionShort = (id: string) => sessionShorts([id]).get(id)!;

let bin: string | null = null;
export function gbrainBin(): string {
  if (bin) return bin;
  try {
    const p = execFileSync("sh", ["-c", "command -v gbrain"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (p) return (bin = p);
  } catch { /* not on PATH */ }
  return (bin = GBRAIN_FALLBACK);
}

interface GbResult { ok: boolean; stdout: string; stderr: string }

/** Run gbrain against the trial brain. Never inherits a database pointer from the real environment. */
export function gb(ctx: TrialContext, args: string[], opts: { input?: string; timeoutMs?: number } = {}): GbResult {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: ctx.paths.homeDir };
  for (const k of Object.keys(env)) if (/^GBRAIN|^DATABASE_URL$|^SUPABASE/i.test(k)) delete env[k];
  try {
    const out = execFileSync(gbrainBin(), args, { env, input: opts.input, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 << 20, stdio: ["pipe", "pipe", "pipe"] });
    return { ok: true, stdout: out.toString(), stderr: "" };
  } catch (e: any) {
    return { ok: false, stdout: String(e?.stdout ?? ""), stderr: String(e?.stderr ?? e?.message ?? e) };
  }
}

/** The JSON value in a gbrain stdout that may carry unrelated lines before or after it. */
function jsonOf(out: string): unknown {
  const s = out.trim();
  const starts = [s.indexOf("["), s.indexOf("{")].filter((i) => i >= 0);
  if (!starts.length) return null;
  const a = Math.min(...starts);
  const b = Math.max(s.lastIndexOf("]"), s.lastIndexOf("}"));
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function brainConfig(ctx: TrialContext): { database_path?: string; engine?: string } | null {
  try { return JSON.parse(fs.readFileSync(path.join(ctx.paths.homeDir, ".gbrain", "config.json"), "utf8")); } catch { return null; }
}

function ensureBrain(ctx: TrialContext): void {
  fs.mkdirSync(ctx.paths.homeDir, { recursive: true });
  if (!brainConfig(ctx)) {
    const r = gb(ctx, ["init", "--pglite"], { timeoutMs: 180_000 });
    if (!r.ok) throw new Error(`gbrain init failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  }
  const cfg = brainConfig(ctx);
  const dbPath = String(cfg?.database_path ?? "");
  const home = ctx.paths.homeDir;
  const under = (p: string, root: string) => p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  if (!cfg || !dbPath || !(under(dbPath, home) || under(realpath(dbPath), realpath(home)))) {
    throw new Error(`gbrain brain is not isolated under the trial HOME (${home}): ${JSON.stringify(cfg)}`);
  }
}
function realpath(p: string): string { try { return fs.realpathSync(p); } catch { return p; } }

// ---------- pages ----------

function eventBody(e: NormEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.kind) {
    case "tool.requested": return `${String(p.tool ?? "tool")}: ${typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? "")}`;
    case "tool.finished": return `output${p.is_error ? " (error)" : ""}: ${String(p.output_preview ?? "")}${p.stderr_preview ? `\nstderr: ${String(p.stderr_preview)}` : ""}`;
    case "file.changed": return `${p.status ? String(p.status) + " " : ""}${String(p.path ?? "")}${p.via ? ` (via ${String(p.via)})` : ""}`;
    default: return String(p.text ?? "");
  }
}

const yamlStr = (s: string) => JSON.stringify(s);

interface Page { slug: string; kind: string; seq: number; text: string; body: string; at: string | undefined; session: string }

function eventPage(e: NormEvent, seq: number, short: string, author: string, harness: string): Page {
  const text = eventBody(e).slice(0, BODY_MAX);
  const at = e.occurred_at;
  const md = `# ${e.kind} · session ${short} · seq ${seq}\n\n${text}\n\n(author: ${author}, harness: ${harness}, at: ${at ?? "unknown"})\n`;
  return { slug: `s-${short}-${seq}`, kind: e.kind, seq, text, body: md, at, session: short };
}

function writePage(dir: string, slug: string, title: string, type: string, tags: string[], body: string): void {
  const fm = `---\ntitle: ${yamlStr(title)}\ntype: ${type}\ntags: [${tags.map(yamlStr).join(", ")}]\n---\n`;
  fs.writeFileSync(path.join(dir, `${slug}.md`), fm + body);
}

async function prepare(ctx: TrialContext, origin: OriginRun): Promise<{ notes: string[]; prepared_ms: number }> {
  const t0 = Date.now();
  const notes: string[] = [];
  const log = (s: string) => ctx.log(`gbrain: ${s}`);
  const sessions = resolveOriginSessions(ctx, origin);
  if (!sessions.length) throw new Error("gbrain.prepare: no origin transcripts to ingest");
  ensureBrain(ctx);

  const stage = path.join(ctx.paths.homeDir, "gbrain-import");
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const pages: Page[] = [];
  const ingested: { id: string; short: string; author: string; harness: string; events: number; pages: number }[] = [];
  const shorts = sessionShorts(sessions.map((s) => s.id));
  for (const s of sessions) {
    const r = streamTranscript(s.transcript, 0, s.harness);
    const short = shorts.get(s.id)!;
    const lines: string[] = [];
    let n = 0;
    r.events.forEach((e, i) => {
      const seq = i + 1; // the seq our helper assigns: insertion order over every normalized event
      if (!CONTENT_KINDS.has(e.kind)) return;
      const p = eventPage(e, seq, short, s.author, s.harness);
      pages.push(p);
      n++;
      writePage(stage, p.slug, `${e.kind} · session ${short} · seq ${seq}`, "event", [e.kind, `session-${short}`, s.author], p.body);
      lines.push(`- seq ${seq} · ${e.kind}${e.occurred_at ? ` · ${e.occurred_at}` : ""}: ${norm(eventBody(e)).slice(0, 2000)} ([[s-${short}-${seq}]])`);
    });
    const sessionBody = `# session ${short} · ${s.harness} · ${s.author}\n\nSession ${s.id} (${s.harness}, author ${s.author}), ${r.events.length} events, ${n} shown in order. Each line links to the event page.\n\n${lines.join("\n")}\n`;
    writePage(stage, `session-${short}`, `session ${short} · ${s.harness} · ${s.author}`, "session", ["session", `session-${short}`, s.author, s.harness], sessionBody);
    ingested.push({ id: s.id, short, author: s.author, harness: s.harness, events: r.events.length, pages: n + 1 });
    log(`staged ${n} event pages + 1 session page for ${s.harness} session ${short} (${s.author})`);
  }

  // one import for every page: `gbrain import <dir> --no-embed` (tags and type come from the frontmatter)
  const imp = gb(ctx, ["import", stage, "--no-embed"], { timeoutMs: 300_000 });
  const m = /(\d+) pages imported/.exec(imp.stdout);
  const imported = m ? Number(m[1]) : NaN;
  if (!imp.ok) notes.push(`gbrain import failed: ${(imp.stderr || imp.stdout).slice(0, 300)}`);
  const expected = pages.length + ingested.length;
  if (imp.ok && imported !== expected) {
    // fall back to per-page put for anything the import skipped
    let fixed = 0;
    for (const f of fs.readdirSync(stage)) {
      const slug = f.replace(/\.md$/, "");
      const r = gb(ctx, ["put", slug], { input: fs.readFileSync(path.join(stage, f), "utf8") });
      if (r.ok) fixed++;
    }
    notes.push(`gbrain import reported ${imported} of ${expected} pages; re-put ${fixed} pages individually`);
  }

  // a timeline entry per event when cheap (one process per entry)
  let timeline = 0;
  if (pages.length <= TIMELINE_MAX_EVENTS) {
    for (const p of pages) {
      const date = (p.at ?? new Date().toISOString()).slice(0, 10);
      const r = gb(ctx, ["timeline-add", p.slug, date, `${p.kind}: ${norm(p.text).slice(0, 200)}`], { timeoutMs: 30_000 });
      if (r.ok) timeline++;
    }
  } else notes.push(`timeline entries skipped: ${pages.length} events exceed the ${TIMELINE_MAX_EVENTS}-event budget`);

  // embeddings: optional; keyword search works without them. Without a key `gbrain embed --all` sits for a
  // minute and embeds nothing, so it is attempted only when a key is present (or forced with LEDGER_EVAL_GBRAIN_EMBED=1).
  let embedOk = false;
  let embedWhy = "skipped: no OPENAI_API_KEY";
  if (process.env.OPENAI_API_KEY || process.env.LEDGER_EVAL_GBRAIN_EMBED === "1") {
    const emb = gb(ctx, ["embed", "--all"], { timeoutMs: 180_000 });
    const embN = /Embedded (\d+) chunks/.exec(emb.stdout);
    embedOk = emb.ok && embN !== null && Number(embN[1]) > 0 && !/Error embedding/.test(emb.stdout + emb.stderr);
    embedWhy = embedOk ? "" : /OPENAI_API_KEY/.test(emb.stdout + emb.stderr) ? "no OPENAI_API_KEY" : (emb.stderr || emb.stdout).replace(/\s+/g, " ").slice(0, 160);
  }

  fs.writeFileSync(path.join(ctx.paths.homeDir, ".gbrain", INGEST_FILE), JSON.stringify({ sessions: ingested, pages: pages.length, session_pages: ingested.length, imported, timeline, embed_ok: embedOk, embed_note: embedWhy, at: new Date().toISOString() }, null, 2) + "\n");
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  notes.push(`${pages.length} event pages + ${ingested.length} session page(s) written (import reported ${imported}), ${timeline} timeline entries, embed ${embedOk ? "ok" : `failed (${embedWhy})`}, ${secs} s`);
  for (const s of ingested) notes.push(`${s.harness} session ${s.short} (${s.author}): ${s.events} normalized events, ${s.pages} pages`);
  return { notes, prepared_ms: Date.now() - t0 };
}

// ---------- successor ----------

async function successorSetup(ctx: TrialContext) {
  const mcpConfigPath = path.join(ctx.paths.configDir, "mcp-gbrain.json");
  const mcp = { mcpServers: { gbrain: { command: gbrainBin(), args: ["serve"], env: { HOME: ctx.paths.homeDir } } } };
  fs.mkdirSync(ctx.paths.configDir, { recursive: true });
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcp, null, 2) + "\n");
  let ingest: { embed_ok?: boolean } | null = null;
  try { ingest = JSON.parse(fs.readFileSync(path.join(ctx.paths.homeDir, ".gbrain", INGEST_FILE), "utf8")); } catch { ingest = null; }
  const preamble =
    "A teammate's previous work sessions were captured into the gbrain knowledge brain available to you as MCP tools (search, query, get_page, traverse_graph, get_timeline). Use them to recover what was asked, decided, and left unfinished before acting." +
    (ingest && ingest.embed_ok === false ? " Keyword search is available; semantic query may return nothing because embeddings were not generated." : "");
  return {
    // HOME is not overridden for the successor process (its login lives in the real HOME); the ledger hooks
    // of the user's real settings are switched off so the successor sees no Ledger brief in this condition.
    env: { LEDGER_HOOKS_OFF: "1" },
    mcpConfigPath,
    allowedTools: ["mcp__gbrain__*", "Read", "Glob", "Grep", "Bash(git *)", "Bash(ls *)", "Bash(cat *)"],
    cwd: ctx.paths.successorRepo,
    preamble,
  };
}

// ---------- evidence ----------

interface Hit { slug: string; chunk_text?: string; title?: string }

function search(ctx: TrialContext, query: string, limit = 10): Hit[] {
  const r = gb(ctx, ["call", "search", JSON.stringify({ query, limit })], { timeoutMs: 60_000 });
  const j = jsonOf(r.stdout);
  return Array.isArray(j) ? (j as Hit[]).filter((h) => h && typeof h.slug === "string") : [];
}

function pageBody(ctx: TrialContext, slug: string): string | null {
  const r = gb(ctx, ["call", "get_page", JSON.stringify({ slug })], { timeoutMs: 60_000 });
  const j = jsonOf(r.stdout) as { compiled_truth?: string } | null;
  return j && typeof j.compiled_truth === "string" ? j.compiled_truth : null;
}

async function evidenceRef(ctx: TrialContext, fixtureEvent: FixtureEvent): Promise<{ system_ref: string } | null> {
  const text = String(fixtureEvent.text ?? "");
  const want = norm(text);
  if (!want || !brainConfig(ctx)) return null;
  const words = want.split(" ").map((w) => w.replace(/[^\p{L}\p{N}_-]/gu, "")).filter((w) => w.length > 1);
  const queries = [...new Set([words.slice(0, 8).join(" "), want, words.slice(0, 4).join(" "), words.slice(-4).join(" ")].filter(Boolean))];
  const checked = new Set<string>();
  for (const q of queries) {
    const hits = search(ctx, q).sort((a, b) => Number(b.slug.startsWith("s-")) - Number(a.slug.startsWith("s-")));
    for (const h of hits) {
      if (checked.has(h.slug)) continue;
      checked.add(h.slug);
      const chunk = norm(h.chunk_text ?? "");
      if (chunk.includes(want)) return { system_ref: `gbrain:page:${h.slug}` };
      const body = pageBody(ctx, h.slug);
      if (body && norm(body).includes(want)) return { system_ref: `gbrain:page:${h.slug}` };
    }
  }
  return null;
}

export const gbrain: ConditionPlugin = { name: "gbrain", prepare, successorSetup, evidenceRef };
