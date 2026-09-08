import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_DATA_TOOLS, isDataTool, summarize } from "./hooks.js";

/**
 * Read a Claude Code or Codex transcript into the evidence the fallback
 * extractor needs: the human's prompts, every data-tool call with its result,
 * every ledger record call (so the extractor does not duplicate live captures),
 * and the agent's stated conclusions. Bounded, most recent kept.
 *
 * Formats (verified against real files on 2026-09-03):
 *   Claude Code  ~/.claude/projects/<cwd-hash>/<session_id>.jsonl
 *                lines: type user|assistant, message.content = string | [{type: text|tool_use{name,input}|tool_result{tool_use_id,content,is_error}}],
 *                plus timestamp, cwd, sessionId
 *   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl
 *                lines: session_meta{payload.id,cwd}; response_item payload.type message{role,content[{type,text}]} |
 *                function_call{name,arguments,call_id} | function_call_output{call_id,output}; event_msg user_message|agent_message
 */

export type Agent = "claude" | "codex";

export interface EvidenceQuery {
  tool: string;
  input: string;
  output: string;
  at?: string;
}

export interface Evidence {
  agent: Agent;
  session_id: string;
  path: string;
  cwd?: string;
  started?: string;
  ended?: string;
  mtime: number;
  prompts: string[];
  queries: EvidenceQuery[];
  records: { tool: string; title: string; ok: boolean }[];
  conclusions: string[];
}

export interface Roots {
  claude?: string;
  codex?: string;
}

const defaultRoots = (): Required<Roots> => ({
  claude: path.join(os.homedir(), ".claude", "projects"),
  codex: path.join(os.homedir(), ".codex", "sessions"),
});

const RECORD_TOOL = /ledger_record_(finding|decision|change|definition)$/;
const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/**
 * Codex's `exec` custom tool takes JavaScript source that calls
 * tools.exec_command({cmd: "..."}) one or more times. Pull the literal cmd
 * strings out so data-tool matching and the evidence pack see shell, not JS.
 * Dynamic or template expressions stay as the raw source (never guessed).
 */
export function codexExecCommands(src: string): string {
  const cmds: string[] = [];
  const re = /\bcmd\s*:\s*("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const raw = m[2] ?? m[3] ?? "";
    try {
      cmds.push(m[2] !== undefined ? JSON.parse(`"${raw}"`) : raw.replace(/\\'/g, "'"));
    } catch {
      cmds.push(raw);
    }
  }
  return cmds.length ? cmds.join("\n") : src;
}

/** Codex tool output is a string, or an array of { type: "input_text", text } parts. */
export function codexOutputText(o: unknown): string {
  if (o == null) return "";
  if (typeof o === "string") return o;
  if (Array.isArray(o)) return o.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("");
  return JSON.stringify(o);
}

function walk(dir: string, depth = 4): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir) || depth < 0) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, depth - 1));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** Locate a session's transcript: the hook-provided path if it still exists, else by session id under both roots. */
export function findTranscript(sessionId: string, hint?: string, roots: Roots = {}): { path: string; agent: Agent } | null {
  if (hint && fs.existsSync(hint)) return { path: hint, agent: hint.includes(`${path.sep}.codex${path.sep}`) ? "codex" : "claude" };
  const r = { ...defaultRoots(), ...roots };
  for (const f of walk(r.claude, 2)) if (path.basename(f, ".jsonl") === sessionId) return { path: f, agent: "claude" };
  for (const f of walk(r.codex, 4)) if (f.includes(sessionId)) return { path: f, agent: "codex" };
  return null;
}

function lines(file: string): any[] {
  const out: any[] = [];
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* partial last line of a live session */
    }
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
  return "";
}

function isLedgerRecord(name: string): boolean {
  return RECORD_TOOL.test(name);
}

function parseClaude(file: string, dataTools: string[]): Evidence {
  const ev: Evidence = { agent: "claude", session_id: path.basename(file, ".jsonl"), path: file, mtime: fs.statSync(file).mtimeMs, prompts: [], queries: [], records: [], conclusions: [] };
  const pending = new Map<string, EvidenceQuery>(); // tool_use id -> query awaiting its result
  const recordIds = new Map<string, { tool: string; title: string }>();
  for (const j of lines(file)) {
    if (j.sessionId && !ev.session_id) ev.session_id = j.sessionId;
    if (j.cwd && !ev.cwd) ev.cwd = j.cwd;
    if (j.timestamp) {
      if (!ev.started) ev.started = j.timestamp;
      ev.ended = j.timestamp;
    }
    const content = j.message?.content;
    if (j.type === "user") {
      if (typeof content === "string") {
        if (!content.startsWith("<")) ev.prompts.push(clip(content, 600)); // skip harness-injected blocks
        continue;
      }
      for (const c of Array.isArray(content) ? content : []) {
        if (c?.type === "text" && typeof c.text === "string" && !c.text.startsWith("<")) ev.prompts.push(clip(c.text, 600));
        if (c?.type === "tool_result") {
          const q = pending.get(c.tool_use_id);
          if (q) {
            q.output = clip(textOf(c.content) || j.toolUseResult?.stdout || "", 1200);
            pending.delete(c.tool_use_id);
          }
          const r = recordIds.get(c.tool_use_id);
          if (r) {
            ev.records.push({ ...r, ok: !c.is_error && /Recorded /.test(textOf(c.content)) });
            recordIds.delete(c.tool_use_id);
          }
        }
      }
    } else if (j.type === "assistant") {
      for (const c of Array.isArray(content) ? content : []) {
        if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) ev.conclusions.push(clip(c.text, 1500));
        if (c?.type === "tool_use") {
          const name = String(c.name ?? "");
          if (isLedgerRecord(name)) recordIds.set(c.id, { tool: name, title: clip(c.input?.title, 140) });
          else if (isDataTool(name, c.input, dataTools)) {
            const q: EvidenceQuery = { tool: name, input: summarize(c.input, 4000), output: "", at: j.timestamp };
            ev.queries.push(q);
            pending.set(c.id, q);
          }
        }
      }
    }
  }
  return ev;
}

function parseCodex(file: string, dataTools: string[]): Evidence {
  const ev: Evidence = { agent: "codex", session_id: "", path: file, mtime: fs.statSync(file).mtimeMs, prompts: [], queries: [], records: [], conclusions: [] };
  const pending = new Map<string, EvidenceQuery>();
  const recordIds = new Map<string, { tool: string; title: string }>();
  // Older rollouts carry prompts/replies as event_msg user_message/agent_message; newer ones as
  // response_item message with a role. A file may contain both for the same turn, so collect the
  // legacy shape separately and use it only when the newer shape yielded nothing.
  const legacyPrompts: string[] = [];
  const legacyConclusions: string[] = [];
  for (const j of lines(file)) {
    if (j.timestamp) {
      if (!ev.started) ev.started = j.timestamp;
      ev.ended = j.timestamp;
    }
    const p = j.payload ?? {};
    if (j.type === "session_meta") {
      ev.session_id = String(p.id ?? ev.session_id);
      if (p.cwd) ev.cwd = p.cwd;
    } else if (j.type === "event_msg" && p.type === "user_message") {
      // older rollout format (most of the corpus as of 2026-09-08)
      const m = String(p.message ?? "");
      if (m && !m.startsWith("<")) legacyPrompts.push(clip(m, 600));
    } else if (j.type === "event_msg" && p.type === "agent_message") {
      if (p.message) legacyConclusions.push(clip(p.message, 1500));
    } else if (j.type === "response_item" && p.type === "message") {
      // newer rollout format: role user|assistant|developer, content parts input_text|output_text.
      // `developer` carries injected AGENTS.md / harness instructions and is never a human prompt.
      const text = codexOutputText(p.content);
      if (p.role === "user" && text && !text.startsWith("<") && !text.startsWith("# AGENTS.md")) ev.prompts.push(clip(text, 600));
      else if (p.role === "assistant" && text.trim()) ev.conclusions.push(clip(text, 1500));
    } else if (j.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
      // Two call shapes, verified against rollouts on 2026-09-08:
      //   function_call     { name, call_id, arguments: JSON string }   e.g. exec_command, js, write_stdin
      //   custom_tool_call  { name, call_id, input: raw string }        e.g. exec (JS wrapper around shell), apply_patch
      // custom_tool_call is roughly a third of all Codex tool calls and was previously invisible.
      const name = String(p.name ?? "");
      let input: any;
      if (p.type === "custom_tool_call") {
        input = name === "exec" ? codexExecCommands(String(p.input ?? "")) : String(p.input ?? "");
      } else {
        try {
          input = typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments ?? {};
        } catch {
          input = { raw: String(p.arguments ?? "") };
        }
      }
      if (isLedgerRecord(name)) recordIds.set(p.call_id, { tool: name, title: clip(input?.title, 140) });
      else if (isDataTool(name, input, dataTools)) {
        const q: EvidenceQuery = { tool: name, input: summarize(input, 4000), output: "", at: j.timestamp };
        ev.queries.push(q);
        pending.set(p.call_id, q);
      }
    } else if (j.type === "response_item" && (p.type === "function_call_output" || p.type === "custom_tool_call_output")) {
      const out = codexOutputText(p.output);
      const q = pending.get(p.call_id);
      if (q) {
        q.output = clip(out, 1200);
        pending.delete(p.call_id);
      }
      const r = recordIds.get(p.call_id);
      if (r) {
        ev.records.push({ ...r, ok: /Recorded /.test(out) });
        recordIds.delete(p.call_id);
      }
    }
  }
  if (!ev.prompts.length) ev.prompts = legacyPrompts;
  if (!ev.conclusions.length) ev.conclusions = legacyConclusions;
  if (!ev.session_id) {
    const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
    ev.session_id = m?.[1] ?? path.basename(file, ".jsonl");
  }
  return ev;
}

export function parseTranscript(file: string, agent?: Agent, dataTools: string[] = DEFAULT_DATA_TOOLS): Evidence {
  const a: Agent = agent ?? (file.includes(`${path.sep}.codex${path.sep}`) || path.basename(file).startsWith("rollout-") ? "codex" : "claude");
  return a === "codex" ? parseCodex(file, dataTools) : parseClaude(file, dataTools);
}

export function hasMaterialActivity(ev: Evidence): boolean {
  return ev.queries.length > 0;
}

/** The evidence pack the extractor reads. Most recent material wins when the cap bites. */
export function evidenceText(ev: Evidence, maxChars = 40_000): string {
  const head = [
    `Session ${ev.session_id} (${ev.agent})${ev.cwd ? ` in ${ev.cwd}` : ""}${ev.started ? `, ${ev.started.slice(0, 16)} to ${ev.ended?.slice(0, 16) ?? "?"}` : ""}.`,
    `${ev.queries.length} data-tool calls, ${ev.records.length} ledger records, ${ev.prompts.length} human messages.`,
  ].join("\n");
  const blocks: string[] = [];
  if (ev.records.length) {
    blocks.push(`## Already recorded live (do not duplicate)\n` + ev.records.map((r) => `- ${r.tool}: ${r.title}${r.ok ? "" : " (rejected)"}`).join("\n"));
  }
  if (ev.prompts.length) blocks.push(`## Human messages\n` + ev.prompts.map((p, i) => `${i + 1}. ${p}`).join("\n"));
  if (ev.queries.length) {
    blocks.push(
      `## Data-tool calls and results\n` +
        ev.queries.map((q, i) => `### ${i + 1}. ${q.tool}${q.at ? ` @ ${q.at.slice(11, 16)}` : ""}\ninput: ${q.input}\noutput: ${q.output || "(no output captured)"}`).join("\n\n")
    );
  }
  if (ev.conclusions.length) blocks.push(`## Agent's stated conclusions\n` + ev.conclusions.map((c, i) => `${i + 1}. ${c}`).join("\n"));
  let body = blocks.join("\n\n");
  if (body.length > maxChars) body = "…(earlier material trimmed)…\n" + body.slice(body.length - maxChars);
  return head + "\n\n" + body;
}
