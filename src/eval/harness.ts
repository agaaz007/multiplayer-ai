import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Roots } from "../transcript.js";
import { findTranscript } from "../transcript.js";
import type { NormEvent } from "../continuity/events.js";
import type { Harness } from "./types.js";

/**
 * Shared harness plumbing for the continuity evaluation drivers: versions, default
 * models, session ids, a process runner with process-group kill on timeout, and the
 * readers for each harness's machine output.
 *
 * Verified on this machine, 2026-09-08:
 *   Claude Code 2.1.258  `claude -p <prompt> --session-id <uuid> --model <m> --output-format json …`
 *     stdout is ONE JSON object: { type: "result", subtype, is_error, session_id, result, num_turns,
 *     duration_ms, duration_api_ms, total_cost_usd, usage: { input_tokens, cache_creation_input_tokens,
 *     cache_read_input_tokens, output_tokens, iterations: [{ input_tokens, output_tokens,
 *     cache_read_input_tokens, cache_creation_input_tokens, type }] }, modelUsage: { <model>: { inputTokens,
 *     outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD, contextWindow, … } }, … }.
 *     `usage` is the run total and matches the transcript's per-call sum exactly (62,207 = 62,207 in the
 *     real smoke). `usage.iterations` is NOT one entry per API call: in a 2-call run it held ONE entry,
 *     the last call (31,232) while the transcript's first call was 30,975. So the boot context (system
 *     prompt + tools + CLAUDE.md + first prompt) is read from the transcript's first assistant line, and
 *     iterations[0] is only a fallback. Claude's input_tokens EXCLUDES cache reads and cache writes; the
 *     tokens the model actually read are the sum of the three.
 *     Transcript: ~/.claude/projects/<cwd with / and . replaced by ->/<session-id>.jsonl; each assistant
 *     line carries message.usage for its API call (the same message id may appear on several lines).
 *   Codex CLI 0.149.0    `codex exec -C <dir> --skip-git-repo-check -s workspace-write [-m m] --json -o <f> <prompt>`
 *     then `codex exec resume <id> --skip-git-repo-check -c sandbox_mode="workspace-write" [-m m] --json -o <f> <prompt>`
 *     (flag surface checked against `codex exec --help` / `codex exec resume --help` on 2026-09-09: resume has no
 *     -C or -s, so the cwd is the process cwd and the sandbox goes through -c).
 *     stdout is JSONL. Not run for real here; the reader accepts the documented exec event shapes
 *     ({type:"thread.started",thread_id}, {type:"item.completed",item:{type:"agent_message",text}},
 *     {type:"turn.completed",usage:{input_tokens,cached_input_tokens,output_tokens}}, {type:"turn.failed"|"error"})
 *     and the older {id,msg:{type:"session_configured"|"agent_message"|"token_count"}} shape. Codex's
 *     input_tokens INCLUDES cached_input_tokens. turn.completed.usage is a turn total, not a first call;
 *     the rollout's event_msg/token_count lines carry info.last_token_usage per call, so the successor's
 *     boot tokens for Codex come from the rollout (first token_count), verified against real rollouts.
 */

export type Role = "origin" | "successor";

export const CODEX_DEFAULT_MODEL = "codex-default";

export function isFakeHarness(): boolean {
  return process.env.LEDGER_EVAL_FAKE_HARNESS === "1";
}

/** All trial resources live under here; the production helper on this machine excludes it. */
export function evalTmpRoot(): string {
  return path.join(process.env.TMPDIR || "/tmp", "ledger-eval");
}

/** Where fake-mode transcripts are written; pass to findTranscript's `roots` argument. */
export function fakeTranscriptRoots(): Required<Roots> {
  const base = process.env.LEDGER_EVAL_FAKE_ROOT || path.join(evalTmpRoot(), "_fake-transcripts");
  return { claude: path.join(base, "claude", "projects"), codex: path.join(base, "codex", "sessions") };
}

/** Roots for findTranscript: the fake roots in fake mode, the real ~/.claude and ~/.codex otherwise. */
export function transcriptRoots(): Roots {
  return isFakeHarness() ? fakeTranscriptRoots() : {};
}

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** Top-level `model = "…"` from CODEX_HOME/config.toml, before any [section]. */
export function codexConfiguredModel(home = codexHome()): string | null {
  try {
    const text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t.startsWith("[")) break;
      const m = t.match(/^model\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
  } catch {
    /* no config */
  }
  return null;
}

/** `-m <model>` unless the model is the sentinel meaning "whatever Codex is configured to use". */
export function codexModelArgs(model: string): string[] {
  return model && model !== CODEX_DEFAULT_MODEL ? ["-m", model] : [];
}

const versionCache = new Map<Harness, string>();

export function harnessVersion(h: Harness): string {
  if (isFakeHarness()) return `fake-${h}`;
  const cached = versionCache.get(h);
  if (cached) return cached;
  let v = "unknown";
  try {
    v = execFileSync(h, ["--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }).toString().trim().split("\n")[0] || "unknown";
  } catch {
    /* not installed */
  }
  versionCache.set(h, v);
  return v;
}

/** Env override: a plain model name (applies to whichever harness plays the role) or "claude=<m>,codex=<m>". */
function envModel(value: string | undefined, h: Harness): string | null {
  if (!value) return null;
  if (!value.includes("=")) return value.trim();
  for (const part of value.split(",")) {
    const [k, ...rest] = part.split("=");
    if (k?.trim() === h && rest.length) return rest.join("=").trim();
  }
  return null;
}

export function defaultModel(h: Harness, role: Role): string {
  const fromEnv = envModel(role === "origin" ? process.env.LEDGER_EVAL_ORIGIN_MODEL : process.env.LEDGER_EVAL_SUCCESSOR_MODEL, h);
  if (fromEnv) return fromEnv;
  if (h === "claude") return role === "origin" ? "claude-haiku-4-5-20251001" : "claude-sonnet-5";
  return codexConfiguredModel() ?? CODEX_DEFAULT_MODEL;
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

export function otherHarness(h: Harness): Harness {
  return h === "claude" ? "codex" : "claude";
}

/**
 * Machine-level ledger overrides must not leak into a trial (the trial config is authoritative), and neither may
 * the identity of a Claude Code session this controller happens to run inside: a harness child is its own
 * top-level session, not a subagent of ours, and must not inherit our session id, child marker, or team socket.
 */
const STRIPPED_ENV = [
  "LEDGER_DIR", "LEDGER_AUTHOR", "LEDGER_CONTINUITY_DB", "LEDGER_GIT_SYNC",
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID",
  "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_EFFORT",
];

/**
 * Env for any process a trial spawns. Always carries LEDGER_EVAL=1: src/store.ts refuses to write the real
 * ~/.ledger/config.json when it is set without LEDGER_CONFIG_DIR, so a child that lost its LEDGER_CONFIG_DIR
 * fails loudly instead of repointing the machine config (2026-09-09 incident, docs/CONTINUITY.md).
 */
export function harnessEnv(base: NodeJS.ProcessEnv, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of STRIPPED_ENV) delete env[k];
  env.LEDGER_EVAL = "1";
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Names only, sorted: what an invocation record may contain. Values never. */
export function envKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((k) => env[k] !== undefined).sort();
}

/** Claude Code's project directory name for a cwd: `/` and `.` become `-`. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

// ---------- process runner ----------

export interface SpawnOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdin?: string;
  log?: (line: string) => void;
}

export interface SpawnResult {
  cmd: string;
  args: string[];
  pid: number | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: string | null;
  wallMs: number;
  startedAt: string;
  endedAt: string;
}

const STDERR_CAP = 1_000_000;
const live = new Set<ChildProcess>();
let exitHook = false;

/** Kill a process group (the child is spawned detached, so its pid is the group id); falls back to the pid. */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function installExitHook() {
  if (exitHook) return;
  exitHook = true;
  process.on("exit", () => {
    for (const c of live) killGroup(c.pid, "SIGKILL");
  });
  // The outer controller timeout sends SIGTERM. Node does not emit 'exit' for
  // an unhandled signal, so explicitly clean up only the child groups we own.
  process.once("SIGTERM", () => process.exit(143));
  process.once("SIGINT", () => process.exit(130));
}

/** Run a harness process with a watchdog: on timeout the whole process group gets SIGTERM, then SIGKILL 5 s later. */
export function spawnHarness(o: SpawnOptions): Promise<SpawnResult> {
  installExitHook();
  return new Promise((resolve) => {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: string | null = null;
    let done = false;
    let child: ChildProcess;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      live.delete(child);
      const wallMs = Date.now() - started;
      o.log?.(`exit ${o.cmd} pid=${child?.pid ?? "?"} code=${code} signal=${signal} timed_out=${timedOut} wall_ms=${wallMs} stdout_chars=${stdout.length}`);
      resolve({ cmd: o.cmd, args: o.args, pid: child?.pid ?? null, stdout, stderr, exitCode: code, signal, timedOut, spawnError, wallMs, startedAt, endedAt: new Date().toISOString() });
    };
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      o.log?.(`timeout after ${o.timeoutMs} ms: killing process group of pid ${child?.pid}`);
      killGroup(child?.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child?.pid, "SIGKILL"), 5_000);
    }, o.timeoutMs);
    try {
      child = spawn(o.cmd, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (e: any) {
      spawnError = String(e?.message ?? e);
      child = undefined as unknown as ChildProcess;
      finish(null, null);
      return;
    }
    live.add(child);
    o.log?.(`spawn ${o.cmd} pid=${child.pid} cwd=${o.cwd} timeout_ms=${o.timeoutMs} argv=${JSON.stringify(o.args.map((a) => (a.length > 120 ? a.slice(0, 117) + "…" : a)))}`);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      spawnError = String(e?.message ?? e);
      // ENOENT and friends: no 'close' may follow when the process never started
      setTimeout(() => finish(null, null), 50);
    });
    child.on("close", (code, signal) => finish(code, signal));
    try {
      child.stdin?.end(o.stdin ?? "");
    } catch {
      /* stdin already closed */
    }
  });
}

// ---------- Claude JSON output ----------

export interface ClaudeUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  iterations?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number }[];
}

export interface ClaudeJsonOutput {
  session_id: string | null;
  result: string;
  is_error: boolean;
  subtype: string | null;
  num_turns: number | null;
  duration_ms: number | null;
  duration_api_ms: number | null;
  total_cost_usd: number | null;
  usage: ClaudeUsage | null;
  modelUsage: Record<string, unknown> | null;
  /**
   * `usage.iterations[0]`: input_tokens + cache_creation_input_tokens + cache_read_input_tokens. Claude Code 2.1.258
   * reports ONE iteration per run and it is the LAST API call, so this equals the boot context only for a
   * single-call run; the successor driver prefers the transcript's first assistant line and uses this as the fallback.
   */
  bootTokens: number | null;
  /** input + cache creation + cache read of the top-level usage: the run total, equal to the transcript's per-call sum */
  totalInputTokens: number | null;
  raw: Record<string, unknown>;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The tokens the model read for one Claude API call. */
export function claudeCallInput(u: ClaudeUsage | undefined | null): number | null {
  if (!u || typeof u !== "object") return null;
  if (u.input_tokens === undefined && u.cache_creation_input_tokens === undefined && u.cache_read_input_tokens === undefined) return null;
  return num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
}

/** Parse `claude -p --output-format json` stdout (one object) or a stream-json run (the `result` line). */
export function readClaudeJsonOutput(stdout: string): ClaudeJsonOutput | null {
  const text = stdout.trim();
  if (!text) return null;
  let j: any = null;
  try {
    j = JSON.parse(text);
  } catch {
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const cand = JSON.parse(lines[i]);
        if (cand && typeof cand === "object" && (cand.type === "result" || "result" in cand)) {
          j = cand;
          break;
        }
      } catch {
        /* not this line */
      }
    }
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const usage: ClaudeUsage | null = j.usage && typeof j.usage === "object" ? j.usage : null;
  const iterations = Array.isArray(usage?.iterations) ? usage!.iterations! : [];
  const bootTokens = iterations.length ? claudeCallInput(iterations[0]) : null;
  const totalInputTokens = claudeCallInput(usage);
  return {
    session_id: typeof j.session_id === "string" ? j.session_id : null,
    result: typeof j.result === "string" ? j.result : j.result == null ? "" : JSON.stringify(j.result),
    is_error: Boolean(j.is_error),
    subtype: typeof j.subtype === "string" ? j.subtype : null,
    num_turns: typeof j.num_turns === "number" ? j.num_turns : null,
    duration_ms: typeof j.duration_ms === "number" ? j.duration_ms : null,
    duration_api_ms: typeof j.duration_api_ms === "number" ? j.duration_api_ms : null,
    total_cost_usd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : null,
    usage,
    modelUsage: j.modelUsage && typeof j.modelUsage === "object" ? j.modelUsage : null,
    bootTokens,
    totalInputTokens,
    raw: j,
  };
}

// ---------- Codex JSON event stream ----------

export interface CodexTurnUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

export interface CodexStreamSummary {
  sessionId: string | null;
  lastMessage: string | null;
  messages: string[];
  turns: CodexTurnUsage[];
  /** from a token_count event's last_token_usage when the stream carries one; else the first turn total; else null */
  firstCallInputTokens: number | null;
  firstCallSource: "token_count" | "turn.completed" | null;
  totalInputTokens: number | null;
  errors: string[];
  lines: number;
  parsed: number;
  types: Record<string, number>;
}

export function readCodexJsonStream(stdout: string): CodexStreamSummary {
  const s: CodexStreamSummary = { sessionId: null, lastMessage: null, messages: [], turns: [], firstCallInputTokens: null, firstCallSource: null, totalInputTokens: null, errors: [], lines: 0, parsed: 0, types: {} };
  let tokenCountTotal: number | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    s.lines++;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (!j || typeof j !== "object") continue;
    s.parsed++;
    const t: string = String(j.type ?? j.msg?.type ?? "?");
    s.types[t] = (s.types[t] ?? 0) + 1;
    const msg = j.msg && typeof j.msg === "object" ? j.msg : null;
    if (t === "thread.started" && typeof j.thread_id === "string") s.sessionId = j.thread_id;
    else if (t === "session_meta" && j.payload) s.sessionId = String(j.payload.id ?? j.payload.session_id ?? s.sessionId ?? "") || s.sessionId;
    else if (msg?.type === "session_configured" && typeof msg.session_id === "string") s.sessionId = msg.session_id;
    else if (t === "item.completed" && j.item?.type === "agent_message" && typeof j.item.text === "string") s.messages.push(j.item.text);
    else if (msg?.type === "agent_message" && typeof msg.message === "string") s.messages.push(msg.message);
    else if (t === "turn.completed" && j.usage && typeof j.usage === "object") {
      s.turns.push({ input_tokens: num(j.usage.input_tokens), cached_input_tokens: num(j.usage.cached_input_tokens), output_tokens: num(j.usage.output_tokens) });
    } else if ((t === "event_msg" && j.payload?.type === "token_count") || msg?.type === "token_count") {
      const info = (t === "event_msg" ? j.payload?.info : msg?.info ?? msg) ?? {};
      const last = info.last_token_usage ?? null;
      const total = info.total_token_usage ?? null;
      if (s.firstCallInputTokens === null && last && typeof last.input_tokens === "number") {
        s.firstCallInputTokens = last.input_tokens;
        s.firstCallSource = "token_count";
      }
      if (total && typeof total.input_tokens === "number") tokenCountTotal = total.input_tokens;
    } else if (t === "turn.failed" || t === "error" || msg?.type === "error") {
      s.errors.push(String(j.error?.message ?? j.message ?? msg?.message ?? line).slice(0, 600));
    }
    if (typeof j.thread_id === "string" && !s.sessionId) s.sessionId = j.thread_id;
  }
  s.lastMessage = s.messages.length ? s.messages[s.messages.length - 1] : null;
  if (s.turns.length) s.totalInputTokens = s.turns.reduce((n, u) => n + u.input_tokens, 0);
  else if (tokenCountTotal !== null) s.totalInputTokens = tokenCountTotal;
  if (s.firstCallInputTokens === null && s.turns.length) {
    s.firstCallInputTokens = s.turns[0].input_tokens;
    s.firstCallSource = "turn.completed";
  }
  return s;
}

// ---------- transcript-derived usage and compactions ----------

export interface TranscriptUsage {
  /** first model call: Claude input+cache_creation+cache_read; Codex token_count.last_token_usage.input_tokens (cache included) */
  boot: number | null;
  total: number | null;
  calls: number;
}

/** Per-call usage read from the harness's own transcript (Claude assistant lines; Codex token_count lines). */
export function transcriptUsage(harness: Harness, file: string): TranscriptUsage {
  const out: TranscriptUsage = { boot: null, total: null, calls: 0 };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  const seen = new Set<string>();
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (harness === "claude") {
      if (j?.type !== "assistant" || !j.message?.usage) continue;
      const id = String(j.message.id ?? j.requestId ?? "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      const n = claudeCallInput(j.message.usage);
      if (n === null) continue;
      out.calls++;
      total += n;
      if (out.boot === null) out.boot = n;
    } else {
      if (j?.type !== "event_msg" || j.payload?.type !== "token_count") continue;
      const info = j.payload.info ?? {};
      const last = info.last_token_usage;
      if (last && typeof last.input_tokens === "number") {
        out.calls++;
        if (out.boot === null) out.boot = last.input_tokens;
      }
      const tot = info.total_token_usage;
      if (tot && typeof tot.input_tokens === "number") total = tot.input_tokens;
    }
  }
  if (out.calls) out.total = total;
  return out;
}

/**
 * Real compaction/reset events. Claude writes a compact_boundary AND a summary line per compaction, so the
 * boundary count is used when present; Codex writes a `compacted` line and a `context_compacted` marker.
 */
export function countCompactions(events: NormEvent[], harness: Harness): number {
  const by = (src: string) => events.filter((e) => e.kind === "compaction" && e.payload.source === src).length;
  if (harness === "claude") return by("claude_compact_boundary") || by("claude_compact_summary");
  return by("codex_compacted") || by("codex_context_compacted");
}

/** Poll findTranscript for a session id; the harness flushes its transcript before exit, so this is usually immediate. */
export async function waitForTranscript(sessionId: string, timeoutMs = 10_000, roots: Roots = transcriptRoots()): Promise<{ path: string; agent: Harness } | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const f = findTranscript(sessionId, undefined, roots);
    if (f) return f;
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------- one harness turn (real or fake) ----------

export interface FakeToolCall {
  name: string;
  input: unknown;
  output: string;
}

export interface TurnSpec {
  harness: Harness;
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Claude: chosen up front; Codex: null on the first turn (the stream reports it) */
  sessionId: string | null;
  resume: boolean;
  prompt: string;
  model: string;
  /** Codex `-o` file: the last agent message */
  lastMessageFile?: string;
  log?: (line: string) => void;
  /** what the fake harness answers in LEDGER_EVAL_FAKE_HARNESS=1 mode */
  fake?: { reply: string; toolCalls?: FakeToolCall[] };
}

export interface TurnOutcome {
  spawn: SpawnResult;
  sessionId: string | null;
  assistantText: string;
  usage: { input_tokens: number; output_tokens: number; cache_read: number } | null;
  /** first model call input as the harness's machine output reports it; the transcript is the better source for both harnesses (see header) */
  bootTokens: number | null;
  totalInputTokens: number | null;
  ok: boolean;
  failure: string | null;
  claude: ClaudeJsonOutput | null;
  codex: CodexStreamSummary | null;
}

export async function runHarnessTurn(spec: TurnSpec): Promise<TurnOutcome> {
  const spawnRes = isFakeHarness()
    ? fakeHarnessTurn(spec)
    : await spawnHarness({ cmd: spec.cmd, args: spec.args, cwd: spec.cwd, env: spec.env, timeoutMs: spec.timeoutMs, log: spec.log });
  const base: TurnOutcome = { spawn: spawnRes, sessionId: spec.sessionId, assistantText: "", usage: null, bootTokens: null, totalInputTokens: null, ok: false, failure: null, claude: null, codex: null };
  const failures: string[] = [];
  if (spawnRes.spawnError) failures.push(`spawn: ${spawnRes.spawnError}`);
  if (spawnRes.timedOut) failures.push(`timeout after ${spec.timeoutMs} ms`);
  if (spawnRes.exitCode !== 0 && !spawnRes.timedOut && !spawnRes.spawnError) failures.push(`exit code ${spawnRes.exitCode}${spawnRes.signal ? ` (${spawnRes.signal})` : ""}`);
  if (spec.harness === "claude") {
    const out = readClaudeJsonOutput(spawnRes.stdout);
    base.claude = out;
    if (!out) failures.push("no JSON result on stdout");
    else {
      base.sessionId = out.session_id ?? spec.sessionId;
      base.assistantText = out.result;
      if (out.usage) {
        base.usage = { input_tokens: num(out.usage.input_tokens) + num(out.usage.cache_creation_input_tokens), output_tokens: num(out.usage.output_tokens), cache_read: num(out.usage.cache_read_input_tokens) };
      }
      base.bootTokens = out.bootTokens;
      base.totalInputTokens = out.totalInputTokens;
      if (out.is_error) failures.push(`harness reported is_error: ${out.result.slice(0, 300)}`);
    }
  } else {
    const s = readCodexJsonStream(spawnRes.stdout);
    base.codex = s;
    base.sessionId = s.sessionId ?? spec.sessionId;
    let text = s.lastMessage ?? "";
    if (!text && spec.lastMessageFile && fs.existsSync(spec.lastMessageFile)) {
      try {
        text = fs.readFileSync(spec.lastMessageFile, "utf8");
      } catch {
        /* unreadable */
      }
    }
    base.assistantText = text;
    if (s.turns.length) {
      base.usage = {
        input_tokens: s.turns.reduce((n, u) => n + (u.input_tokens - u.cached_input_tokens), 0),
        output_tokens: s.turns.reduce((n, u) => n + u.output_tokens, 0),
        cache_read: s.turns.reduce((n, u) => n + u.cached_input_tokens, 0),
      };
    }
    base.bootTokens = s.firstCallInputTokens;
    base.totalInputTokens = s.totalInputTokens;
    for (const e of s.errors) failures.push(`codex: ${e}`);
    if (!s.sessionId) failures.push("no thread/session id in the event stream");
  }
  base.ok = failures.length === 0;
  base.failure = failures.length ? failures.join("; ") : null;
  return base;
}

// ---------- fake harness (LEDGER_EVAL_FAKE_HARNESS=1): synthetic transcripts, canned outputs ----------

const FAKE_USAGE = { input: 12, cacheCreate: 2000, cacheRead: 500, output: 40 };

function fakeUsageEnabled(): boolean {
  return process.env.LEDGER_EVAL_FAKE_NO_USAGE !== "1";
}

function stamp(): string {
  return new Date().toISOString();
}

/** Write one synthetic turn to a Claude JSONL or Codex rollout under the fake roots and return canned stdout. */
export function fakeHarnessTurn(spec: TurnSpec): SpawnResult {
  const started = Date.now();
  const reply = spec.fake?.reply ?? "ok";
  const calls = spec.fake?.toolCalls ?? [];
  const usage = fakeUsageEnabled();
  const roots = fakeTranscriptRoots();
  let stdout = "";
  let sessionId = spec.sessionId;
  if (spec.harness === "claude") {
    sessionId = sessionId ?? newSessionId();
    const dir = path.join(roots.claude, claudeProjectDirName(spec.cwd));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    const common = { isSidechain: false, userType: "external", cwd: spec.cwd, sessionId, version: "fake", gitBranch: "master" };
    const msgUsage = usage ? { input_tokens: FAKE_USAGE.input, cache_creation_input_tokens: FAKE_USAGE.cacheCreate, cache_read_input_tokens: FAKE_USAGE.cacheRead, output_tokens: FAKE_USAGE.output } : undefined;
    const lines: unknown[] = [{ ...common, parentUuid: null, type: "user", uuid: crypto.randomUUID(), timestamp: stamp(), message: { role: "user", content: spec.prompt } }];
    let apiCalls = 0;
    for (const c of calls) {
      const callId = `toolu_${crypto.randomBytes(8).toString("hex")}`;
      apiCalls++;
      lines.push({ ...common, type: "assistant", uuid: crypto.randomUUID(), timestamp: stamp(), message: { model: spec.model, id: `msg_${crypto.randomBytes(8).toString("hex")}`, type: "message", role: "assistant", content: [{ type: "tool_use", id: callId, name: c.name, input: c.input }], ...(msgUsage ? { usage: msgUsage } : {}) } });
      lines.push({ ...common, type: "user", uuid: crypto.randomUUID(), timestamp: stamp(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: c.output }] }, toolUseResult: { stdout: c.output } });
    }
    apiCalls++;
    lines.push({ ...common, type: "assistant", uuid: crypto.randomUUID(), timestamp: stamp(), message: { model: spec.model, id: `msg_${crypto.randomBytes(8).toString("hex")}`, type: "message", role: "assistant", content: [{ type: "text", text: reply }], stop_reason: "end_turn", ...(msgUsage ? { usage: msgUsage } : {}) } });
    fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const iteration = { input_tokens: FAKE_USAGE.input, output_tokens: FAKE_USAGE.output, cache_read_input_tokens: FAKE_USAGE.cacheRead, cache_creation_input_tokens: FAKE_USAGE.cacheCreate, type: "message" };
    const result: Record<string, unknown> = { type: "result", subtype: "success", is_error: false, session_id: sessionId, result: reply, num_turns: apiCalls, duration_ms: 5, duration_api_ms: 3, total_cost_usd: 0, modelUsage: {}, uuid: crypto.randomUUID() };
    if (usage) {
      result.usage = { input_tokens: FAKE_USAGE.input * apiCalls, cache_creation_input_tokens: FAKE_USAGE.cacheCreate * apiCalls, cache_read_input_tokens: FAKE_USAGE.cacheRead * apiCalls, output_tokens: FAKE_USAGE.output * apiCalls, iterations: Array.from({ length: apiCalls }, () => ({ ...iteration })) };
    }
    stdout = JSON.stringify(result) + "\n";
  } else {
    const isNew = !spec.resume || !sessionId;
    if (isNew) sessionId = newSessionId();
    let file: string | null = null;
    if (!isNew) file = findTranscript(sessionId!, undefined, roots)?.path ?? null;
    if (!file) {
      const now = new Date();
      const dir = path.join(roots.codex, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"), String(now.getUTCDate()).padStart(2, "0"));
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, `rollout-${now.toISOString().slice(0, 19).replace(/[:]/g, "-")}-${sessionId}.jsonl`);
    }
    const lines: unknown[] = [];
    if (isNew) lines.push({ timestamp: stamp(), type: "session_meta", payload: { id: sessionId, session_id: sessionId, timestamp: stamp(), cwd: spec.cwd, originator: "codex_exec", cli_version: "fake", source: "exec", model_provider: "openai", model: spec.model } });
    lines.push({ timestamp: stamp(), type: "turn_context", payload: { cwd: spec.cwd, model: spec.model, approval_policy: "never", sandbox_policy: { mode: "workspace-write" } } });
    lines.push({ timestamp: stamp(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: spec.prompt }] } });
    lines.push({ timestamp: stamp(), type: "event_msg", payload: { type: "user_message", message: spec.prompt } });
    for (const c of calls) {
      const callId = `call_${crypto.randomBytes(10).toString("hex")}`;
      if (c.name === "exec") {
        lines.push({ timestamp: stamp(), type: "response_item", payload: { type: "custom_tool_call", id: `ctc_${crypto.randomBytes(6).toString("hex")}`, status: "completed", call_id: callId, name: "exec", input: `await tools.exec_command({cmd: ${JSON.stringify(String((c.input as any)?.command ?? c.input))}});` } });
        lines.push({ timestamp: stamp(), type: "response_item", payload: { type: "custom_tool_call_output", id: `ctco_${crypto.randomBytes(6).toString("hex")}`, call_id: callId, output: [{ type: "input_text", text: c.output }] } });
      } else {
        lines.push({ timestamp: stamp(), type: "response_item", payload: { type: "function_call", id: `fc_${crypto.randomBytes(6).toString("hex")}`, status: "completed", call_id: callId, name: c.name, arguments: JSON.stringify(c.input ?? {}) } });
        lines.push({ timestamp: stamp(), type: "response_item", payload: { type: "function_call_output", id: `fco_${crypto.randomBytes(6).toString("hex")}`, call_id: callId, output: c.output } });
      }
    }
    const callInput = FAKE_USAGE.input + FAKE_USAGE.cacheCreate + FAKE_USAGE.cacheRead;
    if (usage) {
      const one = { input_tokens: callInput, cached_input_tokens: FAKE_USAGE.cacheRead, cache_write_input_tokens: 0, output_tokens: FAKE_USAGE.output, reasoning_output_tokens: 0, total_tokens: callInput + FAKE_USAGE.output };
      lines.push({ timestamp: stamp(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { ...one }, last_token_usage: { ...one }, model_context_window: 258400 }, rate_limits: null } });
    }
    lines.push({ timestamp: stamp(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: reply }] } });
    lines.push({ timestamp: stamp(), type: "event_msg", payload: { type: "agent_message", message: reply } });
    fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const events: unknown[] = [{ type: "thread.started", thread_id: sessionId }, { type: "turn.started" }, { type: "item.completed", item: { id: "item_0", type: "agent_message", text: reply } }];
    if (usage) events.push({ type: "turn.completed", usage: { input_tokens: callInput, cached_input_tokens: FAKE_USAGE.cacheRead, output_tokens: FAKE_USAGE.output } });
    stdout = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    if (spec.lastMessageFile) {
      fs.mkdirSync(path.dirname(spec.lastMessageFile), { recursive: true });
      fs.writeFileSync(spec.lastMessageFile, reply);
    }
  }
  spec.log?.(`fake ${spec.harness} turn session=${sessionId} resume=${spec.resume} prompt_chars=${spec.prompt.length}`);
  return { cmd: spec.cmd, args: spec.args, pid: null, stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, spawnError: null, wallMs: Math.max(1, Date.now() - started), startedAt: new Date(started).toISOString(), endedAt: stamp() };
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export function appendJsonl(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + "\n");
}
