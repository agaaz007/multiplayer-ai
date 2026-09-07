import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDataTool, summarize, DEFAULT_DATA_TOOLS } from "../hooks.js";
import { codexExecCommands, codexOutputText, type Agent } from "../transcript.js";
import { redactText } from "./redact.js";

/**
 * Streaming emitters: read a harness transcript from a byte offset and yield
 * normalized events plus the new offset. A partial trailing line (a live
 * session mid-write) is not consumed; the offset stops before it.
 *
 * Event identity (spec §3.1, v1.1): tool events use `<call_id>:requested` and
 * `<call_id>:finished` so a request and its result never collide on the
 * (session_id, producer_event_id) unique key; everything else uses the byte
 * offset of its line, which is stable across re-reads of the same file.
 *
 * Thinking / reasoning blocks are deliberately not emitted. They are the
 * model's private working, they are large, and the spec ships evidence, not
 * chain of thought.
 */

export type EventKind =
  | "session.started"
  | "instruction.added"
  | "assistant.message"
  | "tool.requested"
  | "tool.finished"
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
  /** Claude subagent transcript (isSidechain); never auto-bound to a thread */
  sidechain?: boolean;
  /** shapes we did not recognize, for coverage reporting */
  unknown: Record<string, number>;
}

const PREVIEW = 1_200;
const INPUT_MAX = 4_000;
const TEXT_MAX = 4_000;

function hash(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

function clean(s: string, max: number): string {
  const r = redactText(s.length > max ? s.slice(0, max - 1) + "…" : s);
  return r.text;
}

/** Read complete lines from `offset`. Returns [lines with their start offsets, new offset]. */
function readNewLines(file: string, offset: number): { lines: { at: number; text: string }[]; offset: number } {
  const size = fs.statSync(file).size;
  if (size <= offset) return { lines: [], offset: size < offset ? 0 : offset }; // truncated/rotated → restart
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString("utf8");
    const lines: { at: number; text: string }[] = [];
    let pos = 0;
    let consumed = 0;
    while (true) {
      const nl = text.indexOf("\n", pos);
      if (nl === -1) break;
      const line = text.slice(pos, nl);
      const byteStart = offset + Buffer.byteLength(text.slice(0, pos), "utf8");
      if (line.trim()) lines.push({ at: byteStart, text: line });
      pos = nl + 1;
      consumed = pos;
    }
    return { lines, offset: offset + Buffer.byteLength(text.slice(0, consumed), "utf8") };
  } finally {
    fs.closeSync(fd);
  }
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
    /^<(system_instruction|task-notification|local-command|command-name)/.test(t)
  );
}

function toolRequested(id: string, tool: string, input: unknown, at: string | undefined, dataTools: string[]): NormEvent {
  const summary = summarize(input, INPUT_MAX);
  return {
    producer_event_id: `${id}:requested`,
    kind: "tool.requested",
    call_id: id,
    occurred_at: at,
    payload: { tool, input: clean(summary, INPUT_MAX), input_hash: hash(summary), is_data_tool: isDataTool(tool, input, dataTools) },
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

// ---------- Claude Code ----------

function streamClaude(file: string, fromOffset: number, dataTools: string[]): StreamResult {
  const res: StreamResult = { harness: "claude", events: [], offset: fromOffset, unknown: {} };
  const { lines, offset } = readNewLines(file, fromOffset);
  res.offset = offset;
  if (!res.session_id) res.session_id = path.basename(file, ".jsonl");
  for (const { at, text } of lines) {
    let j: any;
    try { j = JSON.parse(text); } catch { res.unknown["unparseable"] = (res.unknown["unparseable"] ?? 0) + 1; continue; }
    if (j.sessionId) res.session_id = String(j.sessionId);
    if (j.cwd) res.cwd = String(j.cwd);
    if (j.gitBranch) res.branch = String(j.gitBranch);
    if (j.isSidechain) res.sidechain = true;
    const ts: string | undefined = j.timestamp;
    const content = j.message?.content;

    if (j.type === "system" && (j.subtype === "compact_boundary" || j.isCompactSummary)) {
      res.events.push({ producer_event_id: `L${at}`, kind: "compaction", occurred_at: ts, payload: { subtype: j.subtype ?? "summary" } });
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

function streamCodex(file: string, fromOffset: number, dataTools: string[]): StreamResult {
  const res: StreamResult = { harness: "codex", events: [], offset: fromOffset, unknown: {} };
  const { lines, offset } = readNewLines(file, fromOffset);
  res.offset = offset;
  const recentTexts = new Set<string>(); // legacy + new message shapes can both carry one turn
  const remember = (t: string) => { recentTexts.add(t); if (recentTexts.size > 64) recentTexts.delete(recentTexts.values().next().value!); };
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
    } else if (t === "compacted" || (t === "event_msg" && p.type === "context_compacted")) {
      res.events.push({ producer_event_id: `L${at}`, kind: "compaction", occurred_at: ts, payload: {} });
    } else if (t === "event_msg" && p.type === "turn_aborted") {
      res.events.push({ producer_event_id: `L${at}`, kind: "capture.gap", occurred_at: ts, payload: { kind: "turn_aborted", reason: p.reason } });
    } else if (t === "event_msg" && p.type === "error") {
      res.events.push({ producer_event_id: `L${at}`, kind: "capture.gap", occurred_at: ts, payload: { kind: "harness_error", message: clean(String(p.message ?? ""), 600) } });
    } else if (t === "event_msg" && p.type === "patch_apply_end") {
      const paths = collectPaths(p);
      for (const fp of paths) res.events.push({ producer_event_id: `L${at}:${hash(fp).slice(0, 6)}`, kind: "file.changed", occurred_at: ts, payload: { path: fp, via: "apply_patch", success: p.success ?? true } });
      if (!paths.length) res.events.push({ producer_event_id: `L${at}`, kind: "file.changed", occurred_at: ts, payload: { via: "apply_patch", success: p.success ?? true } });
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
      let input: any;
      if (p.type === "custom_tool_call") input = name === "exec" ? codexExecCommands(String(p.input ?? "")) : String(p.input ?? "");
      else { try { input = typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments ?? {}; } catch { input = { raw: String(p.arguments ?? "") }; } }
      res.events.push(toolRequested(String(p.call_id), name, input, ts, dataTools));
      if (name === "apply_patch") {
        for (const fp of patchPaths(String(p.input ?? ""))) res.events.push({ producer_event_id: `${p.call_id}:file:${hash(fp).slice(0, 6)}`, kind: "file.changed", call_id: String(p.call_id), occurred_at: ts, payload: { path: fp, via: "apply_patch" } });
      }
    } else if (t === "response_item" && (p.type === "function_call_output" || p.type === "custom_tool_call_output")) {
      res.events.push(toolFinished(String(p.call_id), codexOutputText(p.output), ts));
    }
  }
  if (!res.session_id) {
    const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
    res.session_id = m?.[1] ?? path.basename(file, ".jsonl");
  }
  return res;
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

export function streamTranscript(file: string, fromOffset = 0, harness?: Agent, dataTools: string[] = DEFAULT_DATA_TOOLS): StreamResult {
  const h = harness ?? detectHarness(file);
  return h === "codex" ? streamCodex(file, fromOffset, dataTools) : streamClaude(file, fromOffset, dataTools);
}
