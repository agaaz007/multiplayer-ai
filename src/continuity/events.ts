import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDataTool, summarize, DEFAULT_DATA_TOOLS } from "../hooks.js";
import { codexExecCommands, codexOutputText, type Agent } from "../transcript.js";
import { redactText } from "./redact.js";
import { dataToolCalls, evidenceId, inputText, normalizeToolCalls } from "../capture-tools.js";

/**
 * Streaming emitters: read a harness transcript from a byte offset and yield
 * normalized events plus the new offset. A partial trailing line (a live
 * session mid-write) is not consumed; the offset stops before it. A file that
 * shrank since the last read (rotation, rewrite) is read again from 0.
 *
 * Event identity (spec §3.1, v1.1): tool events use `<call_id>:requested` and
 * `<call_id>:finished` so a request and its result never collide on the
 * (session_id, producer_event_id) unique key; `<call_id>:meta` carries a
 * structured completion record (exit code, duration) that arrived in a later
 * read than its `tool.finished`; everything else uses the byte offset of its
 * line (`L<offset>`), which is stable across re-reads of the same file.
 *
 * Thinking / reasoning blocks are deliberately not emitted. They are the
 * model's private working, they are large, and the spec ships evidence, not
 * chain of thought.
 *
 * Compaction summaries ARE emitted (`compaction` with `text`): both harnesses
 * write a model-authored account of the session while the model still held
 * the full context, and that account is evidence for whoever resumes.
 */

export type EventKind =
  | "session.started"
  | "instruction.added"
  | "assistant.message"
  | "tool.requested"
  | "tool.finished"
  | "tool.result_meta"
  | "file.changed"
  | "compaction"
  | "capture.gap"
  | "session.ended";

export interface NormEvent {
  producer_event_id: string;
  kind: EventKind;
  call_id?: string;
  occurred_at?: string;
  payload: Record<string, unknown>;
}

export interface StreamResult {
  harness: Agent;
  events: NormEvent[];
  /** byte offset after the last complete line consumed */
  offset: number;
  session_id?: string;
  cwd?: string;
  branch?: string;
  /**
   * Claude subagent transcript: decided by the FIRST message line only. A parent transcript also
   * contains isSidechain lines (the subagent's messages are mirrored into it), so "any line" is wrong.
   * Subagent files live at <session>/subagents/agent-<agentId>.jsonl and share the parent's sessionId.
   */
  sidechain?: boolean;
  /** Claude subagent id (agentId on its lines), when this file is a subagent transcript */
  agent_id?: string;
  /** the sessionId the lines carry; for a subagent file this is the PARENT session, not this file's identity */
  parent_session_id?: string;
  /** shapes we did not recognize, for coverage reporting */
  unknown: Record<string, number>;
}

const PREVIEW = 1_200;
const INPUT_MAX = 4_000;
const TEXT_MAX = 4_000;
/** Compaction summaries are kept nearly whole: observed 5–20 KB in Claude Code, so the cap rarely bites. */
export const COMPACTION_TEXT_MAX = 32_000;
/** A `patch_apply_end` and an `apply_patch` input naming the same file within this window describe one edit. */
export const PATCH_DEDUPE_WINDOW_MS = 5_000;

function hash(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

function clean(s: string, max: number): string {
  const r = redactText(s.length > max ? s.slice(0, max - 1) + "…" : s);
  return r.text;
}

/** Drop undefined values so payloads stay tidy in JSON and in tests. */
function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/**
 * Read complete lines from `offset`. Returns [lines with their byte start offsets, new offset].
 * Works on the raw buffer, so offsets are exact bytes and the cost is linear in the bytes read
 * (sessions reach 100+ MB; a per-line re-encode would be quadratic). A trailing fragment with no
 * newline is a line still being written and is left for the next read, even if it splits a JSON
 * string or a multibyte character. If the file is now shorter than `offset`, it was rotated or
 * rewritten: read again from 0.
 */
export interface TranscriptLimits { maxBytes?: number; maxLines?: number; initialCwd?: string; stopAtCwdChange?: boolean }
function readNewLines(file: string, offset: number, limits: TranscriptLimits = {}): { lines: { at: number; text: string }[]; offset: number } {
  const size = fs.statSync(file).size;
  if (size < offset) offset = 0;
  if (size === offset) return { lines: [], offset };
  const fd = fs.openSync(file, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(Math.min(size - offset, limits.maxBytes ?? size));
    const n = fs.readSync(fd, buf, 0, buf.length, offset);
    if (n < buf.length) buf = buf.subarray(0, n);
    // A single admitted tool result may exceed the ordinary chunk budget. Read
    // that one frame up to the existing 32 MiB parser safety ceiling; never skip it.
    if (buf.indexOf(10) === -1 && n < size - offset && limits.maxBytes) {
      buf = Buffer.alloc(Math.min(size - offset, 32 << 20));
      const extended = fs.readSync(fd, buf, 0, buf.length, offset); buf = buf.subarray(0, extended);
      if (buf.indexOf(10) === -1 && extended < size - offset) throw new Error("transcript frame exceeds 32 MiB; cursor retained, repair required");
    }
  } finally {
    fs.closeSync(fd);
  }
  const lines: { at: number; text: string }[] = [];
  let pos = 0;
  let consumed = 0;
  let chunkCwd = limits.initialCwd;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break; // partial trailing line: not consumed
    const text = buf.toString("utf8", pos, nl);
    if (limits.stopAtCwdChange && text.trim()) {
      try {
        const parsed = JSON.parse(text), cwd = parsed.cwd ?? parsed.payload?.cwd;
        if (typeof cwd === "string") {
          // End the admitted chunk BEFORE crossing repository policy. Even an
          // A→B→A change in one source read cannot hide B behind the final cwd.
          if (lines.length && cwd !== chunkCwd) break;
          chunkCwd = cwd;
        }
      } catch { /* emitter records malformed complete frames */ }
    }
    if (text.trim()) lines.push({ at: offset + pos, text });
    pos = nl + 1;
    consumed = pos;
    if (lines.length >= (limits.maxLines ?? Infinity)) break;
  }
  return { lines, offset: offset + consumed };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
  return "";
}

/** Text the harness or a skill injected as a "user" message; never a human instruction. */
function isHarnessInjected(raw: string): boolean {
  const t = raw.trimStart();
  return (
    t.startsWith("<") ||
    t.startsWith("# AGENTS.md") ||
    t.startsWith("Caveat:") ||
    t.startsWith("[Request interrupted") ||
    t.startsWith("[SYSTEM NOTIFICATION") ||
    t.startsWith("Base directory for this skill:") ||
    t.startsWith("Stop hook feedback:") ||
    t.startsWith("Launching skill:") ||
    // Claude Code compaction summary (normally flagged isCompactSummary; the prefix guards a missing flag)
    t.startsWith("This session is being continued from a previous conversation") ||
    /^<(system_instruction|task-notification|local-command|command-name)/.test(t)
  );
}

function toolRequested(id: string, tool: string, input: unknown, at: string | undefined, dataTools: string[]): NormEvent {
  const calls = dataToolCalls(tool, input, id, dataTools);
  const ledgerCalls = normalizeToolCalls(tool, input, id).filter(c => /(?:^|_)ledger_/.test(c.tool));
  const summary = summarize(calls.length === 1 && calls[0].wrapper && calls[0].input_complete ? calls[0].input : input, INPUT_MAX);
  const full = inputText(input), sourceBytes = Buffer.byteLength(full, "utf8");
  // Do not run expensive full-text redaction on material we cannot store anyway.
  const redacted = sourceBytes > ARTIFACT_MAX ? { text: "", hits: 0 } : redactText(full);
  const bytes = sourceBytes > ARTIFACT_MAX ? sourceBytes : Buffer.byteLength(redacted.text, "utf8");
  const payload: Record<string, unknown> = {
    tool, input: clean(summary, INPUT_MAX), input_hash: crypto.createHash("sha256").update(full).digest("hex"),
    is_data_tool: calls.length > 0, input_preview_truncated: full.length > INPUT_MAX || summary !== full,
  };
  if (calls.length || ledgerCalls.length) {
    payload.input_capture_reason = calls.length ? "analytics" : "ledger";
    payload.evidence_ids = calls.map(call => evidenceId(call.call_id, call.tool, at, call.input));
    if (sourceBytes <= ARTIFACT_MAX) payload.input_sha256 = crypto.createHash("sha256").update(redacted.text).digest("hex");
    payload.input_format = typeof input === "string" ? "text" : "json";
    payload.input_byte_size = bytes;
    payload.input_redactions = redacted.hits;
    payload.input_complete = redacted.hits === 0 && calls.every(call => call.input_complete) && bytes <= ARTIFACT_MAX;
    payload.input_availability = bytes > ARTIFACT_MAX ? "oversized" : "pending_artifact";
    if (bytes <= ARTIFACT_MAX) payload._full_input = redacted.text;
    else payload.input_gap = { kind: "input_oversized", byte_size: bytes, note: "Full query input exceeds ARTIFACT_MAX; only a labelled preview is available." };
    if (calls.some(call => !call.input_complete)) payload.input_gap = { kind: "wrapper_arguments_unresolved", note: "Wrapper source retained, but runtime query arguments are unknown; never execute it as a reconstructed query." };
  }
  return {
    producer_event_id: `${id}:requested`,
    kind: "tool.requested",
    call_id: id,
    occurred_at: at,
    payload,
  };
}

/** Full outputs above the preview travel in `_full` (redacted) until the daemon turns them into an artifact; never stored inline in the event. */
export const ARTIFACT_MAX = 8 * 1024 * 1024;

function toolFinished(id: string, output: string, at: string | undefined, extra: Record<string, unknown> = {}): NormEvent {
  const offloaded = output.match(/Full output saved to:\s*(\S+)/)?.[1];
  const payload: Record<string, unknown> = { output_preview: clean(output, PREVIEW), output_len: output.length, ...(offloaded ? { offloaded_path: offloaded } : {}), ...extra };
  if (output.length > PREVIEW) {
    if (output.length <= ARTIFACT_MAX) payload._full = redactText(output).text;
    else payload.oversized = { byte_size: Buffer.byteLength(output, "utf8"), note: "exceeds ARTIFACT_MAX; only the preview is stored" };
  }
  return { producer_event_id: `${id}:finished`, kind: "tool.finished", call_id: id, occurred_at: at, payload };
}

/**
 * A compaction with text. `text` is redacted, then capped at COMPACTION_TEXT_MAX; `chars` is the
 * length of the extracted summary before either, so a consumer can tell when the cap bit.
 */
function compactionEvent(id: string, at: string | undefined, source: string, text: string, extra: Record<string, unknown> = {}): NormEvent {
  const red = redactText(text).text;
  const capped = red.length > COMPACTION_TEXT_MAX ? red.slice(0, COMPACTION_TEXT_MAX - 1) + "…" : red;
  return { producer_event_id: id, kind: "compaction", occurred_at: at, payload: compact({ source, text: capped, chars: text.length, ...extra }) };
}

/**
 * The summary body of a Claude Code compaction message. Shape observed 2026-09-08 across 22
 * `isCompactSummary` lines (Claude Code 2.1.220–2.1.257): a plain string,
 *   "This session is being continued from a previous conversation that ran out of context. The
 *    summary below covers the earlier portion of the conversation.\n\nSummary:\n<body>\n\nContinue
 *    the conversation from where it left off without asking the user any further questions. …"
 * 5–20 KB. None in the corpus wraps the body in `<summary>…</summary>`; when a version does, the
 * inside of that block is preferred. Otherwise the fixed preamble and the continuation trailer are
 * stripped and the body is kept.
 */
export function claudeCompactSummaryText(raw: string): string {
  const tagged = raw.match(/<summary>([\s\S]*?)<\/summary>/);
  if (tagged) return tagged[1].trim();
  let t = raw;
  const label = t.indexOf("\nSummary:\n");
  if (label !== -1 && label < 600) t = t.slice(label + "\nSummary:\n".length);
  const trailer = t.lastIndexOf("\nContinue the conversation from where it left off");
  if (trailer !== -1) t = t.slice(0, trailer);
  return t.trim();
}

// ---------- Claude Code ----------

function streamClaude(file: string, fromOffset: number, dataTools: string[], limits: TranscriptLimits = {}): StreamResult {
  const res: StreamResult = { harness: "claude", events: [], offset: fromOffset, unknown: {} };
  const { lines, offset } = readNewLines(file, fromOffset, limits);
  res.offset = offset;
  if (!res.session_id) res.session_id = path.basename(file, ".jsonl");
  for (const { at, text } of lines) {
    let j: any;
    try { j = JSON.parse(text); } catch { res.unknown["unparseable"] = (res.unknown["unparseable"] ?? 0) + 1; continue; }
    if (j.sessionId) res.session_id = String(j.sessionId);
    if (j.cwd) res.cwd = String(j.cwd);
    if (j.gitBranch) res.branch = String(j.gitBranch);
    if (res.sidechain === undefined && fromOffset === 0 && j.message) {
      // the file's first message line decides; an incremental read may start on a mirrored subagent line
      res.sidechain = Boolean(j.isSidechain);
      if (typeof j.agentId === "string" && j.agentId) res.agent_id = j.agentId;
      if (j.sessionId) res.parent_session_id = String(j.sessionId);
    }
    const ts: string | undefined = j.timestamp;
    const content = j.message?.content;

    // Compaction summary: a `user` line flagged isCompactSummary carrying the model-written account of
    // the dropped history. One `compaction` event with the text; never an instruction.added.
    if (j.isCompactSummary) {
      const raw = textOf(content) || (typeof j.content === "string" ? j.content : "");
      res.events.push(compactionEvent(`L${at}`, ts, "claude_compact_summary", claudeCompactSummaryText(raw), { raw_chars: raw.length }));
      continue;
    }
    // Compaction boundary: `system`/`compact_boundary` marker with compactMetadata {trigger, preTokens, postTokens, durationMs, …}; no text.
    if (j.type === "system" && j.subtype === "compact_boundary") {
      const cm = j.compactMetadata && typeof j.compactMetadata === "object" ? j.compactMetadata : {};
      res.events.push({ producer_event_id: `L${at}`, kind: "compaction", occurred_at: ts, payload: compact({
        source: "claude_compact_boundary", subtype: "compact_boundary",
        trigger: typeof cm.trigger === "string" ? cm.trigger : undefined,
        pre_tokens: typeof cm.preTokens === "number" ? cm.preTokens : undefined,
        post_tokens: typeof cm.postTokens === "number" ? cm.postTokens : undefined,
        duration_ms: typeof cm.durationMs === "number" ? cm.durationMs : undefined,
      }) });
      continue;
    }
    if (j.type === "user") {
      if (typeof content === "string") {
        if (!isHarnessInjected(content)) res.events.push({ producer_event_id: `L${at}`, kind: "instruction.added", occurred_at: ts, payload: { text: clean(content, TEXT_MAX) } });
        continue;
      }
      for (const c of Array.isArray(content) ? content : []) {
        if (c?.type === "text" && typeof c.text === "string" && !isHarnessInjected(c.text)) {
          res.events.push({ producer_event_id: `L${at}`, kind: "instruction.added", occurred_at: ts, payload: { text: clean(c.text, TEXT_MAX) } });
        } else if (c?.type === "tool_result") {
          const out = textOf(c.content) || String(j.toolUseResult?.stdout ?? "");
          const extra: Record<string, unknown> = {};
          if (c.is_error) extra.is_error = true;
          const tr = j.toolUseResult;
          if (tr && typeof tr === "object") {
            if (typeof tr.stderr === "string" && tr.stderr.trim()) extra.stderr_preview = clean(tr.stderr, 600);
            if (tr.interrupted) extra.interrupted = true;
            if (typeof tr.filePath === "string") {
              res.events.push({ producer_event_id: `L${at}:file`, kind: "file.changed", occurred_at: ts, payload: { path: tr.filePath, via: "edit" } });
            }
          }
          res.events.push(toolFinished(String(c.tool_use_id), out, ts, extra));
        } else if (c?.type && !["text", "tool_result", "image", "document"].includes(c.type)) {
          res.unknown[`user/${c.type}`] = (res.unknown[`user/${c.type}`] ?? 0) + 1;
        }
      }
    } else if (j.type === "assistant") {
      for (const c of Array.isArray(content) ? content : []) {
        if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
          res.events.push({ producer_event_id: `L${at}:${hash(c.text).slice(0, 6)}`, kind: "assistant.message", occurred_at: ts, payload: { text: clean(c.text, TEXT_MAX) } });
        } else if (c?.type === "tool_use") {
          res.events.push(toolRequested(String(c.id), String(c.name ?? ""), c.input, ts, dataTools));
          if ((c.name === "Write" || c.name === "Edit" || c.name === "NotebookEdit") && typeof c.input?.file_path === "string") {
            res.events.push({ producer_event_id: `${c.id}:file`, kind: "file.changed", call_id: String(c.id), occurred_at: ts, payload: { path: c.input.file_path, via: c.name } });
          }
        } else if (c?.type && !["text", "tool_use", "thinking", "redacted_thinking"].includes(c.type)) {
          res.unknown[`assistant/${c.type}`] = (res.unknown[`assistant/${c.type}`] ?? 0) + 1;
        }
      }
    }
  }
  return res;
}

// ---------- Codex ----------

const CODEX_KNOWN = new Set([
  "session_meta", "turn_context", "world_state", "token_usage_record", "compacted", "inter_agent_communication_metadata",
  "response_item/message", "response_item/reasoning", "response_item/function_call", "response_item/function_call_output",
  "response_item/custom_tool_call", "response_item/custom_tool_call_output", "response_item/web_search_call",
  "response_item/tool_search_call", "response_item/tool_search_output", "response_item/agent_message",
  "event_msg/user_message", "event_msg/agent_message", "event_msg/agent_reasoning", "event_msg/item_completed",
  "event_msg/token_count", "event_msg/task_started", "event_msg/task_complete", "event_msg/thread_settings_applied",
  "event_msg/patch_apply_end", "event_msg/exec_command_end", "event_msg/mcp_tool_call_end", "event_msg/sub_agent_activity",
  "event_msg/context_compacted", "event_msg/web_search_end", "event_msg/view_image_tool_call", "event_msg/turn_aborted",
  "event_msg/error", "event_msg/image_generation_end", "event_msg/thread_name_updated", "event_msg/thread_rolled_back",
  "event_msg/entered_review_mode", "event_msg/exited_review_mode",
]);

/**
 * Codex structured completion shapes, verified against ~/.codex/sessions on 2026-09-08
 * (corpus: 22,184 patch_apply_end, 14,297 exec_command_end, 5,343 mcp_tool_call_end, 1,527 compacted).
 *
 *   compacted            payload { message: "" (empty in every observed line), replacement_history: [response items
 *                        that replace the history: message{role: user|developer|assistant, content[{type,text}]},
 *                        occasionally agent_message, and a final compaction{encrypted_content, id, …} whose summary is
 *                        opaque], window_id, window_number, first_window_id, previous_window_id; newer lines add
 *                        compaction_response_id, guardian_history, latest_token_usage_record }.
 *                        The readable summary, when any, is the assistant items kept in replacement_history.
 *   context_compacted    event_msg payload { type } only: a marker, paired with a `compacted` line.
 *   patch_apply_end      payload { call_id, turn_id, changes: { <absolute path>: { type: add|update|delete,
 *                        unified_diff?, content?, move_path? } }, success: bool, status: completed|failed|declined,
 *                        stdout, stderr }. call_id is `call_…` when the model called apply_patch directly (3,239) and
 *                        `exec-<uuid>` when apply_patch ran inside the `exec` JS wrapper (18,945); the latter never
 *                        matches a response_item call_id.
 *   exec_command_end     payload { call_id (`call_…`, matches function_call exec_command), turn_id, exit_code,
 *                        duration: { secs, nanos }, status: completed|failed, command[], cwd, aggregated_output,
 *                        formatted_output, stdout, stderr, parsed_cmd[], process_id, source }. Absent from rollouts
 *                        after 2026-07 (the `exec` JS wrapper replaced exec_command).
 *   mcp_tool_call_end    payload { call_id (`call_…` 1,199 / `exec-…` 4,144), duration: { secs, nanos },
 *                        invocation: { server, tool, arguments }, result: { Ok: { content[] } } | { Err: string } }.
 *
 * File order within a call: response_item request → event_msg *_end → response_item output, typically within
 * 100 ms. A read boundary can fall between any two of them.
 */

function decodeRuntimeResult(value: any): any {
  if (typeof value === "string" && value.length <= ARTIFACT_MAX) { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === "object" ? value : {};
}
function runtimeInvocationId(value: any, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  const v = decodeRuntimeResult(value), usage = v.structuredContent?.usage;
  if (usage?.source === "ledger_server" && typeof usage.invocation_id === "string" && /^[a-f0-9-]{36}$/i.test(usage.invocation_id)) return usage.invocation_id;
  for (const c of Array.isArray(v.content) ? v.content : []) {
    if (c?.type === "text") { const id = runtimeInvocationId(c.text, depth + 1); if (id) return id; }
  }
  return undefined;
}

interface PatchRef { ev?: NormEvent; path: string; call_id?: string; ts?: string }

function streamCodex(file: string, fromOffset: number, dataTools: string[], limits: TranscriptLimits = {}): StreamResult {
  const res: StreamResult = { harness: "codex", events: [], offset: fromOffset, unknown: {} };
  const { lines, offset } = readNewLines(file, fromOffset, limits);
  res.offset = offset;
  const recentTexts = new Set<string>(); // legacy + new message shapes can both carry one turn
  const remember = (t: string) => { recentTexts.add(t); if (recentTexts.size > 64) recentTexts.delete(recentTexts.values().next().value!); };

  // Events emitted early that a later line in the same read supersedes; filtered out before return.
  const suppressed = new Set<NormEvent>();
  // file.changed emitted from apply_patch input (fallback source) and from patch_apply_end (preferred source).
  const patchFallbacks: PatchRef[] = [];
  const patchEnds: PatchRef[] = [];
  // tool.finished by call_id, and tool.result_meta by call_id, both within this read.
  const finishedByCall = new Map<string, NormEvent>();
  const metaByCall = new Map<string, { ev: NormEvent; fields: Record<string, unknown> }>();
  // requested but not yet finished in this read: lets an `exec-…` sub-call name its enclosing `exec` call.
  // Heuristic, only when exactly one call is in flight and the id is not a model-issued `call_…` (whose own
  // request may simply sit in an earlier read); the JS wrapper runs its sub-calls sequentially inside one call.
  const inflight = new Map<string, string>();
  const enclosing = (callId: string): Record<string, unknown> => {
    if (callId.startsWith("call_") || inflight.has(callId) || inflight.size !== 1) return {};
    const [[id]] = inflight;
    return { enclosing_call_id: id };
  };
  const near = (a?: string, b?: string) => {
    if (!a || !b) return false;
    const x = Date.parse(a), y = Date.parse(b);
    return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= PATCH_DEDUPE_WINDOW_MS;
  };
  const sameEdit = (a: PatchRef, b: PatchRef) => samePath(a.path, b.path, res.cwd) && ((a.call_id && a.call_id === b.call_id) || near(a.ts, b.ts));
  /**
   * Structured completion (exit code, duration) for a call. If the tool.finished for the call is in this
   * read it carries the fields; otherwise a `tool.result_meta` (`<call_id>:meta`) carries them, since a
   * stored event is never amended. Emitted at the *_end line's position and withdrawn if the output turns
   * up later in the same read.
   */
  const attachMeta = (callId: string, fields: Record<string, unknown>, ts: string | undefined, correlate = true) => {
    const fin = finishedByCall.get(callId);
    if (fin) { Object.assign(fin.payload, fields); return; }
    const ev: NormEvent = { producer_event_id: `${callId}:meta`, kind: "tool.result_meta", call_id: callId, occurred_at: ts, payload: { call_id: callId, ...fields, ...(correlate ? enclosing(callId) : {}) } };
    metaByCall.set(callId, { ev, fields });
    res.events.push(ev);
  };

  for (const { at, text } of lines) {
    let j: any;
    try { j = JSON.parse(text); } catch { res.unknown["unparseable"] = (res.unknown["unparseable"] ?? 0) + 1; continue; }
    const p = j.payload ?? {};
    const t = String(j.type);
    const key = p.type ? `${t}/${p.type}` : t;
    if (!CODEX_KNOWN.has(key)) res.unknown[key] = (res.unknown[key] ?? 0) + 1;
    const ts: string | undefined = j.timestamp;

    if (t === "session_meta") {
      res.session_id = String(p.id ?? res.session_id ?? "");
      if (p.cwd) res.cwd = String(p.cwd);
      res.events.push({ producer_event_id: `L${at}`, kind: "session.started", occurred_at: ts, payload: { cwd: p.cwd, cli_version: p.cli_version, model: p.model } });
    } else if (t === "turn_context") {
      if (p.cwd) res.cwd = String(p.cwd);
    } else if (t === "compacted") {
      const rh: any[] = Array.isArray(p.replacement_history) ? p.replacement_history : [];
      let body = String(p.message ?? "").trim();
      let textSource = body ? "message" : "none";
      if (!body) {
        const parts: string[] = [];
        for (const it of rh) {
          if (!it || typeof it !== "object") continue;
          if (it.type === "summary" || it.role === "assistant" || it.type === "agent_message") {
            const c = it.content ?? it.text ?? it.summary;
            const s = (typeof c === "string" || Array.isArray(c) ? codexOutputText(c) : typeof c?.text === "string" ? c.text : "").trim();
            if (s) parts.push(s);
          }
        }
        if (parts.length) { body = parts.join("\n\n"); textSource = "replacement_history"; }
      }
      res.events.push(compactionEvent(`L${at}`, ts, "codex_compacted", body, { items: rh.length, text_source: textSource, window_number: typeof p.window_number === "number" ? p.window_number : undefined }));
    } else if (t === "event_msg" && p.type === "context_compacted") {
      res.events.push({ producer_event_id: `L${at}`, kind: "compaction", occurred_at: ts, payload: { source: "codex_context_compacted" } });
    } else if (t === "event_msg" && p.type === "turn_aborted") {
      res.events.push({ producer_event_id: `L${at}`, kind: "capture.gap", occurred_at: ts, payload: { kind: "turn_aborted", reason: p.reason } });
    } else if (t === "event_msg" && p.type === "error") {
      res.events.push({ producer_event_id: `L${at}`, kind: "capture.gap", occurred_at: ts, payload: { kind: "harness_error", message: clean(String(p.message ?? ""), 600) } });
    } else if (t === "event_msg" && p.type === "patch_apply_end") {
      // Source of truth for files changed by apply_patch. Dedupe rule: a file.changed already emitted in this
      // read from an apply_patch *input* (fallback) for the same path, with the same call_id or a timestamp
      // within PATCH_DEDUPE_WINDOW_MS, is withdrawn in favour of this one. Ids stay as they are
      // (`L<offset>:<path hash>` here, `<call_id>:file:<path hash>` for the fallback); when a read boundary
      // separates the two lines both may reach the store, which is the documented residual.
      const callId = p.call_id != null ? String(p.call_id) : undefined;
      const success = typeof p.success === "boolean" ? p.success : true;
      const changes = p.changes && typeof p.changes === "object" && !Array.isArray(p.changes) ? Object.entries<any>(p.changes) : null;
      const entries = changes
        ? changes.map(([fp, c]) => ({ path: fp, change: typeof c?.type === "string" ? c.type : undefined, move_path: typeof c?.move_path === "string" ? c.move_path : undefined }))
        : collectPaths(p).map((fp) => ({ path: fp, change: undefined, move_path: undefined }));
      for (const e of entries) {
        const ref: PatchRef = { path: e.path, call_id: callId, ts };
        for (const fb of patchFallbacks) if (fb.ev && !suppressed.has(fb.ev) && sameEdit(fb, ref)) suppressed.add(fb.ev);
        patchEnds.push(ref);
        res.events.push({ producer_event_id: `L${at}:${hash(e.path).slice(0, 6)}`, kind: "file.changed", call_id: callId, occurred_at: ts, payload: compact({
          path: e.path, via: "apply_patch", success, source: "patch_apply_end", change: e.change, move_path: e.move_path,
          status: typeof p.status === "string" ? p.status : undefined, ...(callId ? enclosing(callId) : {}),
        }) });
      }
      if (!entries.length) res.events.push({ producer_event_id: `L${at}`, kind: "file.changed", call_id: callId, occurred_at: ts, payload: { via: "apply_patch", success, source: "patch_apply_end" } });
    } else if (t === "event_msg" && p.type === "exec_command_end") {
      const callId = String(p.call_id ?? "");
      if (callId) attachMeta(callId, compact({
        meta_source: "exec_command_end",
        exit_code: typeof p.exit_code === "number" ? p.exit_code : undefined,
        duration_ms: durationMs(p.duration),
        status: typeof p.status === "string" ? p.status : undefined,
        is_error: p.status === "failed" || (typeof p.exit_code === "number" && p.exit_code !== 0) ? true : undefined,
      }), ts);
    } else if (t === "event_msg" && p.type === "mcp_tool_call_end") {
      const callId = String(p.call_id ?? "");
      const r = p.result && typeof p.result === "object" ? p.result : {};
      const err = r.Err != null ? clean(typeof r.Err === "string" ? r.Err : JSON.stringify(r.Err), 600) : undefined;
      const decoded = decodeRuntimeResult(r.Ok);
      const failed = err !== undefined || decoded?.is_error === true || decoded?.isError === true;
      const serverId = runtimeInvocationId(decoded);
      const runtimeInput = typeof p.invocation?.tool === "string" && p.invocation.arguments !== undefined
        ? toolRequested(callId, `mcp__${p.invocation.server ?? "unknown"}__${p.invocation.tool}`, p.invocation.arguments, ts, dataTools).payload : {};
      // Runtime completion proves execution; lexical wrapper matches do not.
      // Do not infer the parent wrapper merely because one call is in flight.

      if (callId) attachMeta(callId, compact({
        ...runtimeInput,
        meta_source: "mcp_tool_call_end",
        invocation_source: "runtime_completion",
        server_invocation_id: serverId,
        invocation_correlation: serverId ? "server_identity" : "unknown",
        duration_ms: durationMs(p.duration),
        mcp_server: typeof p.invocation?.server === "string" ? p.invocation.server : undefined,
        mcp_tool: typeof p.invocation?.tool === "string" ? p.invocation.tool : undefined,
        success: !failed,
        error: err,
        is_error: failed ? true : undefined,
      }), ts, false);
    } else if (t === "response_item" && p.type === "message") {
      const body = codexOutputText(p.content);
      if (!body.trim()) continue;
      if (p.role === "user" && !isHarnessInjected(body)) {
        if (!recentTexts.has(body)) { remember(body); res.events.push({ producer_event_id: `L${at}`, kind: "instruction.added", occurred_at: ts, payload: { text: clean(body, TEXT_MAX) } }); }
      } else if (p.role === "assistant") {
        if (!recentTexts.has(body)) { remember(body); res.events.push({ producer_event_id: `L${at}`, kind: "assistant.message", occurred_at: ts, payload: { text: clean(body, TEXT_MAX) } }); }
      }
    } else if (t === "event_msg" && p.type === "user_message") {
      const m = String(p.message ?? "");
      if (m && !isHarnessInjected(m) && !recentTexts.has(m)) { remember(m); res.events.push({ producer_event_id: `L${at}`, kind: "instruction.added", occurred_at: ts, payload: { text: clean(m, TEXT_MAX) } }); }
    } else if (t === "event_msg" && p.type === "agent_message") {
      const m = String(p.message ?? "");
      if (m.trim() && !recentTexts.has(m)) { remember(m); res.events.push({ producer_event_id: `L${at}`, kind: "assistant.message", occurred_at: ts, payload: { text: clean(m, TEXT_MAX) } }); }
    } else if (t === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
      const name = String(p.name ?? "");
      const callId = String(p.call_id);
      let input: any;
      if (p.type === "custom_tool_call") input = String(p.input ?? "");
      else { try { input = typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments ?? {}; } catch { input = { raw: String(p.arguments ?? "") }; } }
      res.events.push(toolRequested(callId, name, input, ts, dataTools));
      inflight.set(callId, name);
      if (name === "apply_patch") {
        // Fallback source: the paths named in the patch body. Skipped when a patch_apply_end for the same call
        // already covered the path in this read (it normally follows the request, so this rarely fires).
        for (const fp of patchPaths(String(p.input ?? ""))) {
          const ref: PatchRef = { path: fp, call_id: callId, ts };
          if (patchEnds.some((pe) => sameEdit(pe, ref))) continue;
          ref.ev = { producer_event_id: `${callId}:file:${hash(fp).slice(0, 6)}`, kind: "file.changed", call_id: callId, occurred_at: ts, payload: { path: fp, via: "apply_patch", source: "apply_patch_input" } };
          patchFallbacks.push(ref);
          res.events.push(ref.ev);
        }
      }
    } else if (t === "response_item" && (p.type === "function_call_output" || p.type === "custom_tool_call_output")) {
      const callId = String(p.call_id);
      const fin = toolFinished(callId, codexOutputText(p.output), ts);
      const m = metaByCall.get(callId);
      if (m) { Object.assign(fin.payload, m.fields); suppressed.add(m.ev); metaByCall.delete(callId); }
      finishedByCall.set(callId, fin);
      inflight.delete(callId);
      res.events.push(fin);
    }
  }
  if (suppressed.size) res.events = res.events.filter((e) => !suppressed.has(e));
  if (!res.session_id) {
    const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
    res.session_id = m?.[1] ?? path.basename(file, ".jsonl");
  }
  return res;
}

/** Codex durations are `{ secs, nanos }`; tolerate a plain millisecond number. */
function durationMs(d: unknown): number | undefined {
  if (typeof d === "number") return Number.isFinite(d) ? Math.round(d) : undefined;
  if (!d || typeof d !== "object") return undefined;
  const secs = Number((d as any).secs ?? 0), nanos = Number((d as any).nanos ?? 0);
  return Number.isFinite(secs) && Number.isFinite(nanos) ? Math.round(secs * 1000 + nanos / 1e6) : undefined;
}

/**
 * Whether two path spellings name the same file: patch_apply_end reports absolute paths, an apply_patch body
 * names repo-relative ones. Resolve against the session cwd when known; otherwise accept a segment-aligned suffix.
 */
export function samePath(a: string, b: string, cwd?: string): boolean {
  const norm = (s: string) => {
    let x = s.replace(/\\/g, "/");
    if (!x.startsWith("/") && cwd) x = path.posix.join(cwd.replace(/\\/g, "/"), x);
    return path.posix.normalize(x);
  };
  const A = norm(a), B = norm(b);
  if (A === B) return true;
  const rel = (s: string) => path.posix.normalize(s.replace(/\\/g, "/")).replace(/^\.\//, "");
  return (!b.startsWith("/") && A.endsWith("/" + rel(b))) || (!a.startsWith("/") && B.endsWith("/" + rel(a)));
}

function collectPaths(o: any, depth = 0): string[] {
  const out: string[] = [];
  if (!o || depth > 3) return out;
  if (typeof o === "string") return out;
  if (Array.isArray(o)) { for (const x of o) out.push(...collectPaths(x, depth + 1)); return out; }
  for (const [k, v] of Object.entries(o)) {
    if ((k === "path" || k === "file" || k === "filename") && typeof v === "string") out.push(v);
    else if (k === "changes" || k === "files" || k === "paths") {
      if (Array.isArray(v)) out.push(...collectPaths(v, depth + 1));
      else if (v && typeof v === "object") out.push(...Object.keys(v));
    }
  }
  return out;
}

/** File paths from a Codex apply_patch body: "*** Update File: path", "*** Add File:", "*** Delete File:". */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  const re = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch))) out.push(m[1].trim());
  return out;
}

export function detectHarness(file: string): Agent {
  return file.includes(`${path.sep}.codex${path.sep}`) || path.basename(file).startsWith("rollout-") ? "codex" : "claude";
}

export function streamTranscript(file: string, fromOffset = 0, harness?: Agent, dataTools: string[] = DEFAULT_DATA_TOOLS, limits: TranscriptLimits = {}): StreamResult {
  const h = harness ?? detectHarness(file);
  return h === "codex" ? streamCodex(file, fromOffset, dataTools, limits) : streamClaude(file, fromOffset, dataTools, limits);
}
