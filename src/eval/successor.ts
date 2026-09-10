import fs from "node:fs";
import path from "node:path";
import { streamTranscript, type NormEvent } from "../continuity/events.js";
import type { Harness, SuccessorRun, TrialContext } from "./types.js";
import { appendJsonl, codexHome, codexModelArgs, defaultModel, envKeys, isFakeHarness, newSessionId, runHarnessTurn, transcriptUsage, waitForTranscript, writeJson, type TurnSpec } from "./harness.js";
import { trialEnv, writeEmptyMcpConfig } from "./fixture.js";
import { claudeIsolationArgs } from "./claude-isolation.js";
import { retainTranscript } from "./transcript-evidence.js";

/**
 * Successor driver: one fresh harness session that receives only the condition's
 * preamble, the case's resume prompt, and the answer contract (key names). It never
 * sees fixture ids, expected answers, or the origin transcript. Its tool calls are read
 * back from its own transcript, so `toolCalls` reflects what the harness actually did.
 *
 * Boot tokens: the input of the successor's FIRST model call, which is the system prompt,
 * tool schemas, CLAUDE.md/AGENTS.md, the injected brief, and the prompt, before any
 * retrieval. Both harnesses record per-call usage only in their transcript, so that is the
 * primary source and the machine output on stdout is the fallback:
 *   Claude  primary  transcript: first `type:"assistant"` line, message.usage.input_tokens +
 *                    cache_creation_input_tokens + cache_read_input_tokens ("transcript.first_assistant_usage")
 *           fallback `--output-format json` result: usage.iterations[0], same three fields summed
 *                    ("json.usage.iterations[0]"; on 2.1.258 iterations holds ONE entry and it is the LAST call)
 *   Codex   primary  rollout: first event_msg/token_count payload.info.last_token_usage.input_tokens, cache
 *                    included ("rollout.first_token_count")
 *           fallback `--json` stream: turn.completed usage.input_tokens, a turn total ("stream.turn.completed")
 * raw/successor-output.json records both candidates (boot_tokens_transcript, boot_tokens_json) and the one used.
 */

export interface SuccessorSetup {
  env: Record<string, string>;
  mcpConfigPath: string | null;
  allowedTools: string[];
  cwd: string;
  preamble: string;
}

export interface RunSuccessorOptions {
  /** Default 600 s. */
  timeoutMs?: number;
  model?: string;
  /** Default ctx.successorHarness. */
  harness?: Harness;
}

export function claudeSuccessorArgs(prompt: string, sessionId: string, model: string, cwd: string, mcpConfigPath: string, allowedTools: string[]): string[] {
  const args = ["-p", prompt, "--session-id", sessionId, "--model", model, "--output-format", "json", "--dangerously-skip-permissions", ...claudeIsolationArgs(), "--mcp-config", mcpConfigPath, "--strict-mcp-config", "--add-dir", cwd];
  if (allowedTools.length) args.push("--allowedTools", ...allowedTools);
  return args;
}

export const SUCCESSOR_TIMEOUT_MS = 600_000;

/**
 * The same contract for every condition. It fixes the FORM of a value (an identifier, not a sentence)
 * without naming any expected value; the oracle compares values literally, so "locked insight only" and
 * "locked_insight" are different answers even when they state the same fact. Explanations, attribution,
 * and qualifiers belong in `evidence` and `notes`, never in `value`.
 */
export function answerContract(answerKeys: string[]): string {
  return (
    'When finished, output ONLY a JSON object on the last line of your reply: {"answers": {"<key>": {"value": <answer>, "evidence": ["<exact quoted source text you retrieved>"]}}, "selected_topic": "<topic if asked>", "notes": "<one sentence>"}. ' +
    `Keys: ${answerKeys.join(", ")}. ` +
    "Value format: each value is the shortest identifier that names the fact, not a sentence: a number as a JSON number without currency symbols or units, otherwise a single word or a short snake_case noun phrase naming the thing itself (a component, a status, a reason word, a next step). " +
    "Do not add qualifiers (\"only\", \"currently\"), attribution (\"by X\", \"according to\"), reasons, or units to a value; put those in evidence or notes. " +
    "If the source states a reason, the value is the reason word itself. If a question asks for a status such as resolved or unresolved, answer with that word. " +
    "For an action or next step, use verb_object form with the verb first (validate_x, check_y). For selected_topic, use one lowercase word naming the work area. " +
    "Use null when a value is genuinely unknown or unresolved; never guess. " +
    "`evidence` must be the exact text of the original human instruction or message as you retrieved it through a tool, copied verbatim, never paraphrased and never a summary line; if a tool showed only a preview or clipped line, fetch the full text first (for example with a larger preview or by reading the page or event) and quote from that."
  );
}

export function buildSuccessorPrompt(preamble: string, resumePrompt: string, answerKeys: string[]): string {
  return [preamble.trim(), resumePrompt.trim(), answerContract(answerKeys)].filter(Boolean).join("\n\n");
}

/** Scan for the matching close brace of the `{` at `start`, honouring strings and escapes. */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The last JSON object in a reply, leniently: code fences are ignored, prose before or
 * after is ignored, and an object containing `answers` is preferred over any later
 * object that lacks it (a trailing `{"note": …}` must not hide the contract).
 */
export function parseLastJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const cleaned = text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
  const candidates: Record<string, unknown>[] = [];
  let from = cleaned.length;
  while (from > 0) {
    const start = cleaned.lastIndexOf("{", from - 1);
    if (start === -1) break;
    const end = matchBrace(cleaned, start);
    if (end !== -1) {
      try {
        const v = JSON.parse(cleaned.slice(start, end + 1));
        if (v && typeof v === "object" && !Array.isArray(v)) {
          candidates.push(v as Record<string, unknown>);
          if ("answers" in v) return v as Record<string, unknown>;
          if (candidates.length >= 8) break;
        }
      } catch {
        /* not an object here; keep scanning backwards */
      }
    }
    from = start;
  }
  return candidates[0] ?? null;
}

export interface SuccessorToolCall {
  tool: string;
  input: string;
  output_preview: string;
  at: string | null;
  call_id: string | null;
}

/** Tool calls from normalized transcript events: each tool.requested joined with its tool.finished by call id. */
export function collectToolCalls(events: NormEvent[]): { calls: SuccessorToolCall[]; full: Record<string, unknown>[] } {
  const finished = new Map<string, NormEvent>();
  for (const e of events) if (e.kind === "tool.finished" && e.call_id) finished.set(e.call_id, e);
  const calls: SuccessorToolCall[] = [];
  const full: Record<string, unknown>[] = [];
  for (const e of events) {
    if (e.kind !== "tool.requested") continue;
    const fin = e.call_id ? finished.get(e.call_id) : undefined;
    const p = fin?.payload ?? {};
    const call: SuccessorToolCall = {
      tool: String(e.payload.tool ?? ""),
      input: String(e.payload.input ?? ""),
      output_preview: String(p.output_preview ?? ""),
      at: e.occurred_at ?? null,
      call_id: e.call_id ?? null,
    };
    calls.push(call);
    full.push({ ...call, finished_at: fin?.occurred_at ?? null, output_len: p.output_len ?? null, output: typeof p._full === "string" ? p._full : call.output_preview, is_error: p.is_error ?? false, mcp_server: p.mcp_server, mcp_tool: p.mcp_tool, exit_code: p.exit_code });
  }
  return { calls, full };
}

function tomlString(s: string): string {
  return JSON.stringify(String(s));
}

/** `[mcp_servers.<name>]` blocks from a Claude-style MCP JSON config ({ mcpServers: { name: { command, args, env, url } } }). */
export function mcpJsonToToml(json: Record<string, unknown>): string {
  const servers = (json.mcpServers ?? json.mcp_servers ?? {}) as Record<string, any>;
  const out: string[] = [];
  for (const [name, def] of Object.entries(servers)) {
    if (!def || typeof def !== "object") continue;
    const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name);
    out.push(`[mcp_servers.${key}]`);
    if (typeof def.url === "string") out.push(`url = ${tomlString(def.url)}`);
    if (typeof def.command === "string") out.push(`command = ${tomlString(def.command)}`);
    if (Array.isArray(def.args)) out.push(`args = [${def.args.map((a: unknown) => tomlString(String(a))).join(", ")}]`);
    if (typeof def.cwd === "string") out.push(`cwd = ${tomlString(def.cwd)}`);
    if (typeof def.startup_timeout_sec === "number") out.push(`startup_timeout_sec = ${def.startup_timeout_sec}`);
    const env = def.env && typeof def.env === "object" ? (def.env as Record<string, unknown>) : null;
    if (env && Object.keys(env).length) {
      out.push("", `[mcp_servers.${key}.env]`);
      for (const [k, v] of Object.entries(env)) out.push(`${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)} = ${tomlString(String(v))}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/**
 * A per-trial CODEX_HOME: the real auth.json copied in (Codex is logged out otherwise), a
 * config.toml with the trial's MCP servers and a trust entry for the working directory, and
 * nothing else (no user config, no hooks.json, no history). Returns the directory.
 */
export function prepareCodexHome(ctx: TrialContext, setup: SuccessorSetup, role: "origin" | "successor" = "successor"): { home: string; authCopied: boolean; configPath: string } {
  const home = path.join(ctx.paths.homeDir, role === "origin" ? "origin-codex" : "codex");
  fs.mkdirSync(home, { recursive: true });
  const realAuth = path.join(codexHome(), "auth.json");
  let authCopied = false;
  if (fs.existsSync(realAuth)) {
    fs.copyFileSync(realAuth, path.join(home, "auth.json"));
    fs.chmodSync(path.join(home, "auth.json"), 0o600);
    authCopied = true;
  } else {
    ctx.log(`warning: ${realAuth} not found; the Codex successor will be logged out`);
  }
  const parts: string[] = ["# generated by the ledger continuity evaluation successor driver", ""];
  parts.push(`[projects.${tomlString(setup.cwd)}]`, 'trust_level = "trusted"', "");
  if (setup.mcpConfigPath) {
    const json = JSON.parse(fs.readFileSync(setup.mcpConfigPath, "utf8")) as Record<string, unknown>;
    parts.push(mcpJsonToToml(json));
  }
  const configPath = path.join(home, "config.toml");
  fs.writeFileSync(configPath, parts.join("\n") + "\n");
  return { home, authCopied, configPath };
}

export async function runSuccessor(ctx: TrialContext, setup: SuccessorSetup, resumePrompt: string, answerKeys: string[], opts: RunSuccessorOptions = {}): Promise<SuccessorRun> {
  const harness = opts.harness ?? ctx.successorHarness;
  const model = opts.model ?? (harness === ctx.successorHarness ? ctx.successorModel : defaultModel(harness, "successor"));
  const timeoutMs = opts.timeoutMs ?? SUCCESSOR_TIMEOUT_MS;
  const raw = ctx.paths.rawDir;
  const prompt = buildSuccessorPrompt(setup.preamble, resumePrompt, answerKeys);
  const rawOutputPath = path.join(raw, "successor-output.json");
  let env = trialEnv(ctx, setup.env);
  let sessionId: string | null = null;
  let args: string[];
  let lastMessageFile: string | undefined;
  let codexHomeInfo: { home: string; authCopied: boolean; configPath: string } | null = null;
  if (harness === "claude") {
    sessionId = newSessionId();
    const mcp = setup.mcpConfigPath ?? writeEmptyMcpConfig(ctx, "successor-mcp-empty.json");
    args = claudeSuccessorArgs(prompt, sessionId, model, setup.cwd, mcp, setup.allowedTools);
  } else {
    codexHomeInfo = prepareCodexHome(ctx, setup);
    env = { ...env, CODEX_HOME: codexHomeInfo.home };
    lastMessageFile = path.join(raw, "successor-last-message.txt");
    args = ["exec", "-C", setup.cwd, "--skip-git-repo-check", "-s", "workspace-write", ...codexModelArgs(model), "--json", "-o", lastMessageFile, prompt];
  }
  writeJson(path.join(raw, "successor-invocation.json"), {
    harness, cmd: harness, args, cwd: setup.cwd, env_keys: envKeys(env), session_id: sessionId, model, timeout_ms: timeoutMs,
    mcp_config_path: setup.mcpConfigPath, allowed_tools: setup.allowedTools, preamble_chars: setup.preamble.length, prompt_chars: prompt.length, answer_keys: answerKeys,
    codex_home: codexHomeInfo ? { path: codexHomeInfo.home, auth_copied: codexHomeInfo.authCopied, config: codexHomeInfo.configPath } : null,
  });
  ctx.log(`successor: ${harness} model=${model} cwd=${setup.cwd} mcp=${setup.mcpConfigPath ?? "none"} allowed=${setup.allowedTools.length} prompt_chars=${prompt.length}${sessionId ? ` id=${sessionId}` : ""}`);

  const fakeAnswers = Object.fromEntries(answerKeys.map((k) => [k, { value: "fake", evidence: [] }]));
  const spec: TurnSpec = {
    harness, cmd: harness, args, cwd: setup.cwd, env, timeoutMs, sessionId, resume: false, prompt, model, lastMessageFile, log: ctx.log,
    fake: {
      reply: `I looked for the work record and found nothing to continue.\n${JSON.stringify({ answers: fakeAnswers, selected_topic: null, notes: "fake successor: no retrieval performed" })}`,
      toolCalls: [{ name: "mcp__ledger__ledger_records", input: { repo: setup.cwd }, output: "fake tool output: no records" }],
    },
  };
  const out = await runHarnessTurn(spec);
  sessionId = out.sessionId ?? sessionId;
  fs.writeFileSync(path.join(raw, "successor-stdout.txt"), out.spawn.stdout);
  const parsed = parseLastJsonObject(out.assistantText);

  const roots = codexHomeInfo && !isFakeHarness() ? { codex: path.join(codexHomeInfo.home, "sessions") } : undefined;
  const found = sessionId ? await waitForTranscript(sessionId, 10_000, roots) : null;
  const retained = found ? retainTranscript(raw, found.path, { role: "successor", harness, sessionId: sessionId!, synthetic: isFakeHarness() }) : null;
  let toolCalls: SuccessorToolCall[] = [];
  let tUsage: ReturnType<typeof transcriptUsage> | null = null;
  let transcriptEvents = 0;
  if (retained) {
    const r = streamTranscript(retained.path, 0, harness);
    transcriptEvents = r.events.length;
    const collected = collectToolCalls(r.events);
    toolCalls = collected.calls;
    const toolsFile = path.join(raw, "successor-tools.jsonl");
    if (fs.existsSync(toolsFile)) fs.rmSync(toolsFile);
    for (const c of collected.full) appendJsonl(toolsFile, { session_id: sessionId, harness, ...c });
    if (!collected.full.length) fs.writeFileSync(toolsFile, "");
    tUsage = transcriptUsage(harness, retained.path);
  } else {
    ctx.log(`successor: transcript not found for ${sessionId ?? "(no session id)"}`);
  }
  // First model call from the transcript (both harnesses); the stdout usage is the fallback (see the header).
  const bootFromTranscript = tUsage?.boot ?? null;
  const bootFromStdout = out.bootTokens ?? null;
  const bootTokens = bootFromTranscript ?? bootFromStdout;
  const bootSource =
    bootFromTranscript !== null
      ? harness === "claude" ? "transcript.first_assistant_usage" : "rollout.first_token_count"
      : bootFromStdout !== null
        ? harness === "claude" ? "json.usage.iterations[0]" : out.codex?.firstCallSource === "token_count" ? "stream.token_count" : "stream.turn.completed"
        : null;
  // Totals: Claude's top-level usage is the run total and equals the transcript sum; Codex's stream carries turn totals only.
  const totalInputTokens = harness === "claude" ? out.totalInputTokens ?? tUsage?.total ?? null : tUsage?.total ?? out.totalInputTokens ?? null;

  writeJson(rawOutputPath, {
    harness, model, session_id: sessionId, ok: out.ok, failure: out.failure, exit_code: out.spawn.exitCode, signal: out.spawn.signal, timed_out: out.spawn.timedOut,
    wall_ms: out.spawn.wallMs, started_at: out.spawn.startedAt, ended_at: out.spawn.endedAt,
    stdout: out.spawn.stdout, stderr_tail: out.spawn.stderr.slice(-4000), assistant_text: out.assistantText, parsed_output: parsed,
    usage: out.usage, boot_tokens: bootTokens, boot_tokens_source: bootSource, boot_tokens_transcript: bootFromTranscript, boot_tokens_json: bootFromStdout,
    total_input_tokens: totalInputTokens, transcript_usage: tUsage, transcript: retained?.path ?? null,
    source_transcript: found?.path ?? null, transcript_provenance: retained?.provenancePath ?? null, transcript_sha256: retained?.sha256 ?? null,
    transcript_events: transcriptEvents, tool_calls: toolCalls.length,
    claude: out.claude ? { subtype: out.claude.subtype, num_turns: out.claude.num_turns, duration_ms: out.claude.duration_ms, duration_api_ms: out.claude.duration_api_ms, total_cost_usd: out.claude.total_cost_usd, usage: out.claude.usage, modelUsage: out.claude.modelUsage } : null,
    codex: out.codex ? { turns: out.codex.turns, errors: out.codex.errors, types: out.codex.types, lines: out.codex.lines } : null,
  });
  ctx.log(`successor done: ${out.ok ? "ok" : `FAILED (${out.failure})`} wall_ms=${out.spawn.wallMs} boot=${bootTokens ?? "null"} total_in=${totalInputTokens ?? "null"} tools=${toolCalls.length} parsed=${parsed ? "yes" : "no"} transcript=${retained?.path ?? "none"}`);
  if (!out.ok) throw new Error(`successor harness failed: ${out.failure}; see raw/successor-output.json`);
  return {
    harness,
    sessionId: sessionId ?? "",
    transcriptPath: retained?.path ?? null,
    output: parsed,
    rawOutputPath,
    toolCalls,
    bootTokens,
    totalInputTokens,
    wallMs: out.spawn.wallMs,
  };
}
