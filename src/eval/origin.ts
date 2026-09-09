import path from "node:path";
import { streamTranscript } from "../continuity/events.js";
import type { FixtureEvent, Harness, OriginRun, OriginTurnResult, TrialContext } from "./types.js";
import { appendJsonl, codexModelArgs, countCompactions, defaultModel, envKeys, isFakeHarness, newSessionId, otherHarness, runHarnessTurn, waitForTranscript, writeJson, type FakeToolCall, type TurnSpec } from "./harness.js";
import { prepareCodexHome } from "./successor.js";
import { trialEnv, writeEmptyMcpConfig, writeTrialConfig } from "./fixture.js";
import { claudeIsolationArgs } from "./claude-isolation.js";

/**
 * Origin driver: one real harness turn per fixture event, in fixture order, each event
 * delivered verbatim behind a one-line preamble. Events sharing a `session` label share
 * one harness session (Claude `--session-id` then `--resume`; Codex `exec` then
 * `exec resume`). The primary label (session-a) runs on the origin harness as the
 * origin author; any other label runs on the other harness as the other author, which
 * is what R02 needs in both directions (ADAPTER.md: reverse the people/harness
 * assignments for the reverse direction). The trial config's `author` is switched before
 * each turn so the hooks and helper attribute the session to the right person, and
 * restored to the origin author afterwards.
 *
 * The origin never sees fixture ids, answers, or the resume prompt: only the event text.
 */

export const ORIGIN_PROMPT_PREFIX = "You are working in this repository. Act on the following instruction; do the minimum needed, do not ask questions, do not summarize.";
export const ORIGIN_TURN_TIMEOUT_MS = 300_000;

export interface RunOriginOptions {
  /** per turn; on timeout the process group is killed and the turn is recorded as failed. Default 300 s. */
  timeoutMs?: number;
  /** Claude only. undefined: an empty strict config (the user's global MCP servers alone exceed Haiku's 200k context); null: no --mcp-config; string: that file. */
  mcpConfigPath?: string | null;
  allowedTools?: string[];
  extraEnv?: Record<string, string>;
}

/** What the contract's OriginTurnResult cannot say: whether the turn succeeded and why not. */
export interface OriginTurnDetail extends OriginTurnResult {
  ok: boolean;
  failure: string | null;
  sessionLabel: string;
  author: string;
  model: string;
  exitCode: number | null;
  timedOut: boolean;
  stderrTail: string;
  startedAt: string;
  endedAt: string;
}

export function primarySessionLabel(events: FixtureEvent[]): string {
  return events.some((e) => e.session === "session-a") ? "session-a" : events[0]?.session ?? "session-a";
}

export function harnessFor(ctx: TrialContext, sessionLabel: string, primaryLabel = "session-a"): Harness {
  return !sessionLabel || sessionLabel === primaryLabel ? ctx.originHarness : otherHarness(ctx.originHarness);
}

export function authorFor(ctx: TrialContext, sessionLabel: string, primaryLabel = "session-a"): string {
  return !sessionLabel || sessionLabel === primaryLabel ? ctx.originAuthor : ctx.successorAuthor;
}

/**
 * The origin receives the fixture event text VERBATIM as its user turn. The framing line goes
 * to Claude as an appended system prompt and is omitted for Codex (the events are imperative
 * already). Putting the framing inside the user turn contaminated the captured instruction:
 * the exact fixture text then existed only as a substring of a longer prompt, which is what
 * evidence validation compares against.
 */
export function originPrompt(text: string): string {
  return text;
}

/** Claude argv. The prompt sits right after -p because --add-dir / --allowedTools / --mcp-config are variadic and would swallow it. */
export function claudeOriginArgs(prompt: string, sessionId: string, resume: boolean, model: string, addDir: string, mcpConfigPath: string | null, allowedTools?: string[]): string[] {
  const a = ["-p", prompt, ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]), "--model", model, "--output-format", "json", "--dangerously-skip-permissions", "--append-system-prompt", ORIGIN_PROMPT_PREFIX, ...claudeIsolationArgs()];
  if (mcpConfigPath) a.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  a.push("--add-dir", addDir);
  if (allowedTools?.length) a.push("--allowedTools", ...allowedTools);
  return a;
}

/** Codex argv: `exec` for a new thread (cwd via -C), `exec resume <id>` afterwards (cwd is the process cwd; resume has no -C or -s). */
export function codexOriginArgs(prompt: string, sessionId: string | null, model: string, cwd: string, lastMessageFile: string): string[] {
  const m = codexModelArgs(model);
  if (sessionId) return ["exec", "resume", sessionId, "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', ...m, "--json", "-o", lastMessageFile, prompt];
  return ["exec", "-C", cwd, "--skip-git-repo-check", "-s", "workspace-write", ...m, "--json", "-o", lastMessageFile, prompt];
}

interface SessionState {
  label: string;
  harness: Harness;
  author: string;
  model: string;
  sessionId: string | null;
  turns: number;
  /** a Codex session whose first turn yielded no thread id cannot be resumed; later turns are recorded as failed */
  dead: string | null;
}

export async function runOrigin(ctx: TrialContext, events: FixtureEvent[], opts: RunOriginOptions = {}): Promise<OriginRun> {
  const timeoutMs = opts.timeoutMs ?? ORIGIN_TURN_TIMEOUT_MS;
  const primary = primarySessionLabel(events);
  const raw = ctx.paths.rawDir;
  const mcpConfigPath = opts.mcpConfigPath === undefined ? writeEmptyMcpConfig(ctx, "origin-mcp-empty.json") : opts.mcpConfigPath;
  // Origin and successor have separate isolated Codex configs. Real personal MCP servers,
  // hooks and memory must not contaminate a fixture or escape into the team database.
  const originCodex = events.some((e) => harnessFor(ctx, e.session || primary, primary) === "codex")
    ? prepareCodexHome(ctx, { cwd: ctx.paths.repo, mcpConfigPath, env: {}, allowedTools: [], preamble: "" }, "origin")
    : null;
  const sessions = new Map<string, SessionState>();
  const turns: OriginTurnDetail[] = [];
  const invocations: Record<string, unknown>[] = [];
  let configAuthor: string | null = null;
  ctx.log(`origin run: ${events.length} events, primary label ${primary}, origin ${ctx.originHarness}/${ctx.originAuthor}`);
  try {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const label = ev.session || primary;
      let s = sessions.get(label);
      if (!s) {
        const harness = harnessFor(ctx, label, primary);
        s = {
          label,
          harness,
          author: authorFor(ctx, label, primary),
          model: harness === ctx.originHarness ? ctx.originModel : defaultModel(harness, "origin"),
          sessionId: harness === "claude" ? newSessionId() : null,
          turns: 0,
          dead: null,
        };
        sessions.set(label, s);
        ctx.log(`session ${label}: ${harness} as ${s.author} model=${s.model}${s.sessionId ? ` id=${s.sessionId}` : ""}`);
      }
      if (configAuthor !== s.author) {
        writeTrialConfig(ctx, s.author);
        configAuthor = s.author;
      }
      const prompt = originPrompt(ev.text);
      const resume = s.turns > 0;
      const startedAt = new Date().toISOString();
      if (s.dead) {
        const t0 = Date.now();
        const detail: OriginTurnDetail = { harness: s.harness, sessionId: s.sessionId ?? "", transcriptPath: null, turnIndex: i, fixtureEventId: ev.id, assistantText: "", wallMs: Date.now() - t0, ok: false, failure: `not run: ${s.dead}`, sessionLabel: label, author: s.author, model: s.model, exitCode: null, timedOut: false, stderrTail: "", startedAt, endedAt: new Date().toISOString() };
        turns.push(detail);
        appendJsonl(path.join(raw, "origin-turns.jsonl"), detail);
        ctx.log(`origin turn ${i + 1}/${events.length} ${label} ${s.harness} NOT RUN (${s.dead}) event=${ev.id}`);
        continue;
      }
      const lastMessageFile = path.join(raw, `origin-turn-${i + 1}-last-message.txt`);
      const args = s.harness === "claude"
        ? claudeOriginArgs(prompt, s.sessionId!, resume, s.model, ctx.paths.repo, mcpConfigPath, opts.allowedTools)
        : codexOriginArgs(prompt, resume ? s.sessionId : null, s.model, ctx.paths.repo, lastMessageFile);
      const env = trialEnv(ctx, { ...opts.extraEnv, ...(s.harness === "codex" && originCodex ? { CODEX_HOME: originCodex.home } : {}) });
      const fakeCalls: FakeToolCall[] = s.harness === "claude"
        ? [{ name: "Bash", input: { command: "git status --short" }, output: "" }]
        : [{ name: "exec", input: { command: "git status --short" }, output: "Script completed\nOutput:\n" }];
      const spec: TurnSpec = {
        harness: s.harness, cmd: s.harness, args, cwd: ctx.paths.repo, env, timeoutMs, sessionId: s.sessionId, resume, prompt, model: s.model,
        lastMessageFile: s.harness === "codex" ? lastMessageFile : undefined, log: ctx.log,
        fake: { reply: `Done: ${ev.text.slice(0, 120)}`, toolCalls: fakeCalls },
      };
      invocations.push({ turn: i + 1, session_label: label, harness: s.harness, author: s.author, model: s.model, resume, session_id: s.sessionId, cmd: s.harness, args, cwd: ctx.paths.repo, env_keys: envKeys(env), timeout_ms: timeoutMs, prompt_chars: prompt.length });
      const out = await runHarnessTurn(spec);
      if (!s.sessionId && out.sessionId) s.sessionId = out.sessionId;
      s.turns++;
      if (s.harness === "codex" && !s.sessionId) s.dead = "no thread id captured from the first codex turn";
      const detail: OriginTurnDetail = {
        harness: s.harness,
        sessionId: s.sessionId ?? "",
        transcriptPath: null,
        turnIndex: i,
        fixtureEventId: ev.id,
        assistantText: out.assistantText,
        ...(out.usage ? { usage: { input_tokens: out.usage.input_tokens, output_tokens: out.usage.output_tokens, cache_read: out.usage.cache_read } } : {}),
        wallMs: out.spawn.wallMs,
        ok: out.ok,
        failure: out.failure,
        sessionLabel: label,
        author: s.author,
        model: s.model,
        exitCode: out.spawn.exitCode,
        timedOut: out.spawn.timedOut,
        stderrTail: out.spawn.stderr.slice(-2000),
        startedAt,
        endedAt: out.spawn.endedAt,
      };
      turns.push(detail);
      appendJsonl(path.join(raw, "origin-turns.jsonl"), { ...detail, stdout_chars: out.spawn.stdout.length, boot_tokens: out.bootTokens, total_input_tokens: out.totalInputTokens });
      ctx.log(`origin turn ${i + 1}/${events.length} ${label} ${s.harness} ${out.ok ? "ok" : `FAILED (${out.failure})`} wall_ms=${out.spawn.wallMs} in=${out.usage?.input_tokens ?? "?"} cache_read=${out.usage?.cache_read ?? "?"} out=${out.usage?.output_tokens ?? "?"} event=${ev.id}`);
      if (!out.ok) break; // preserve the failed turn, then reject instead of spending more calls
    }
  } finally {
    if (configAuthor !== ctx.originAuthor) writeTrialConfig(ctx, ctx.originAuthor);
  }

  const sessionIds: string[] = [];
  const transcriptPaths: string[] = [];
  let compactions = 0;
  const transcriptNotes: Record<string, unknown>[] = [];
  for (const s of sessions.values()) {
    if (!s.sessionId) {
      ctx.log(`session ${s.label}: no session id; transcript not located`);
      transcriptNotes.push({ label: s.label, harness: s.harness, session_id: null, transcript: null });
      continue;
    }
    sessionIds.push(s.sessionId);
    const roots = s.harness === "codex" && originCodex && !isFakeHarness() ? { codex: path.join(originCodex.home, "sessions") } : undefined;
    const found = await waitForTranscript(s.sessionId, 10_000, roots);
    if (!found) {
      ctx.log(`session ${s.label}: transcript for ${s.sessionId} not found`);
      transcriptNotes.push({ label: s.label, harness: s.harness, session_id: s.sessionId, transcript: null });
      continue;
    }
    transcriptPaths.push(found.path);
    const r = streamTranscript(found.path, 0, s.harness);
    const n = countCompactions(r.events, s.harness);
    compactions += n;
    for (const t of turns) if (t.sessionId === s.sessionId) t.transcriptPath = found.path;
    transcriptNotes.push({ label: s.label, harness: s.harness, session_id: s.sessionId, transcript: found.path, events: r.events.length, compactions: n, unknown_shapes: r.unknown });
    ctx.log(`session ${s.label}: transcript ${found.path} (${r.events.length} events, ${n} compactions)`);
  }
  const totalInputTokens = turns.reduce((n, t) => n + (t.usage?.input_tokens ?? 0) + (t.usage?.cache_read ?? 0), 0);
  const run: OriginRun = { harness: ctx.originHarness, sessionIds, turns, transcriptPaths, totalInputTokens, compactions };
  writeJson(path.join(raw, "origin-invocations.json"), { invocations, transcripts: transcriptNotes });
  writeJson(path.join(raw, "origin-run.json"), run);
  const failed = turns.find((turn) => !turn.ok);
  if (failed) throw new Error(`origin harness failed on turn ${failed.turnIndex + 1}: ${failed.failure}; see raw/origin-turns.jsonl. No continuation may be scored from failed origin turns.`);
  ctx.log(`origin run done: ${turns.filter((t) => t.ok).length}/${turns.length} turns ok, ${sessionIds.length} sessions, ${transcriptPaths.length} transcripts, ${totalInputTokens} input tokens (incl. cache reads), ${compactions} compactions`);
  return run;
}
