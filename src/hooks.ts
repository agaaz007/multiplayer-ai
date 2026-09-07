import fs from "node:fs";
import path from "node:path";
import { ledgerHome } from "./store.js";
import { appendIndex, writeSignal } from "./helper/signals.js";

/**
 * The checkpoint loop. Deterministic software decides WHEN to check for
 * durable knowledge; the agent decides WHAT it was; the schema decides what
 * fields it must have. This module is the WHEN.
 *
 *   SessionStart  read: brief, plus any uncaptured work from before a compaction
 *   PostToolUse   track: every data-tool call goes in a per-session journal
 *   Stop          flush: queries since the last record? block once, list them
 *   PreCompact    checkpoint: inject the same list before context is compressed
 *   SessionEnd    reconcile: note capture debt for stats
 *
 * The journal is local (~/.ledger/sessions/<session_id>.json), never in the
 * data repo. It is evidence for the nudge and input to `ledger stats`.
 *
 * One nudge per batch of uncaptured work. The agent resolves it by recording
 * (any ledger_record_* call) or by calling ledger_skip_record with a reason.
 * A second Stop with the same debt passes and is logged as unresolved, so the
 * pilot can count how often the nudge was ignored.
 */

export type EntryKind = "query" | "record" | "skip" | "search" | "nudge" | "unresolved" | "compact" | "end";

export interface JournalEntry {
  at: string;
  kind: EntryKind;
  tool?: string;
  summary?: string;
  id?: string;
}

export interface Journal {
  session_id: string;
  started: string;
  cwd?: string;
  /** from the hook input when the agent provides it (Claude Code does); else resolved by session id */
  transcript_path?: string;
  entries: JournalEntry[];
  /** fingerprint of the debt last nudged; same debt is never nudged twice */
  nudged?: string;
  /** set by the transcript fallback; a session is reconciled once, except errors, which are retried a few times */
  extracted?: { at: string; result: "none" | "drafts" | "skipped" | "error"; reason: string; draft_ids: string[]; attempts?: number };
}

export interface HookResult {
  stdout?: string;
  stderr?: string;
  exit: number;
  /** SessionEnd with capture debt: the caller should start the transcript fallback for this session */
  reconcile?: boolean;
}

export interface HookOpts {
  dir?: string;
  dataTools?: string[];
  now?: Date;
}

/** Tool names that count as data work. Matched against `mcp__<server>__<tool>`; ledger's own tools excluded. */
export const DEFAULT_DATA_TOOLS = [
  "^mcp__(?!ledger__).*(query|sql|clickhouse|amplitude|mixpanel|postgres|bigquery|snowflake|duckdb|metabase|redash|looker|analytics|insight|chart|event|funnel|retention|cohort|segment|report)",
];
const BASH_DATA = /\b(psql|clickhouse(-client)?|bq|duckdb|sqlite3|mysql|snowsql|trino|presto)\b/;
const RECORD_TOOL = /^mcp__ledger__ledger_record_(finding|decision|change|definition)$/;
const SKIP_TOOL = "mcp__ledger__ledger_skip_record";
const SEARCH_TOOLS = /^mcp__ledger__ledger_(search|brief|get)$/;

export function sessionsDir(): string {
  return path.join(ledgerHome(), "sessions");
}

function journalPath(sessionId: string, dir: string): string {
  return path.join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export function loadJournal(sessionId: string, dir = sessionsDir()): Journal {
  const f = journalPath(sessionId, dir);
  if (fs.existsSync(f)) {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      /* corrupt: start over */
    }
  }
  return { session_id: sessionId, started: new Date().toISOString(), entries: [] };
}

export function saveJournal(j: Journal, dir = sessionsDir()): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(journalPath(j.session_id, dir), JSON.stringify(j, null, 2) + "\n");
}

/** Shell tools: Claude's Bash; Codex's exec_command, and its `exec` custom tool whose input is shell text (or JS wrapping it). */
const SHELL_TOOLS = /^(Bash|exec|exec_command|shell|container\.exec)$/;

export function isDataTool(toolName: string, toolInput: any, patterns = DEFAULT_DATA_TOOLS): boolean {
  if (SHELL_TOOLS.test(toolName)) {
    const src = typeof toolInput === "string" ? toolInput : String(toolInput?.command ?? toolInput?.cmd ?? "");
    return BASH_DATA.test(src);
  }
  return patterns.some((p) => new RegExp(p, "i").test(toolName));
}

/**
 * The query-like part of a tool input, one line, capped. The nudge quotes it
 * back at 200 chars; the transcript fallback asks for more so the extractor
 * sees the whole query.
 */
export function summarize(toolInput: any, max = 200): string {
  if (toolInput == null) return "";
  if (typeof toolInput === "string") return clip(toolInput, max);
  for (const k of ["sql", "query", "command", "cmd", "question", "text", "prompt", "q", "jql", "expression"]) {
    const v = toolInput[k];
    if (typeof v === "string" && v.trim()) return clip(v, max);
  }
  return clip(JSON.stringify(toolInput), max);
}

function clip(s: string, n = 200): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function responseText(r: any): string {
  if (r == null) return "";
  if (typeof r === "string") return r;
  if (Array.isArray(r?.content)) return r.content.map((c: any) => c?.text ?? "").join("\n");
  return JSON.stringify(r);
}

/** Query entries after the last record or skip. */
export function debt(j: Journal): JournalEntry[] {
  let cut = -1;
  j.entries.forEach((e, i) => {
    if (e.kind === "record" || e.kind === "skip") cut = i;
  });
  return j.entries.slice(cut + 1).filter((e) => e.kind === "query");
}

export function fingerprint(d: JournalEntry[]): string {
  return d.map((e) => e.at).join("|");
}

export function debtText(d: JournalEntry[]): string {
  return d.map((e) => `- ${e.at.slice(11, 16)} ${e.tool}: ${e.summary}`).join("\n");
}

const RESOLVE =
  `Do one of:\n` +
  `1. Record it: ledger_record_finding (question, result, inputs, method, assumptions with at least one implicit), ` +
  `or ledger_record_decision / ledger_record_change / ledger_record_definition if that is what this was. ` +
  `A rough number with its assumptions written down beats no record; use confidence: low.\n` +
  `2. Or call ledger_skip_record with the reason none of this is a durable finding (exploration, a check that confirmed nothing, a dead end).`;

function stopReason(d: JournalEntry[]): string {
  return (
    `Ledger: ${d.length} data quer${d.length === 1 ? "y" : "ies"} since the last record, and nothing recorded:\n` +
    debtText(d) +
    `\n\n` +
    RESOLVE +
    `\nThis reminder fires once per batch of uncaptured work.`
  );
}

/** The block SessionStart prints after a compaction or resume when work is uncaptured. */
export function sessionStartContext(j: Journal): string {
  const d = debt(j);
  if (!d.length) return "";
  return (
    `## Uncaptured work from earlier in this session\n\n` +
    `${d.length} data quer${d.length === 1 ? "y" : "ies"} ran with no ledger record. Context may have been compacted; the queries are still known:\n` +
    debtText(d) +
    `\n\n` +
    RESOLVE
  );
}

export function handleHook(event: string, input: any, opts: HookOpts = {}): HookResult {
  const dir = opts.dir ?? sessionsDir();
  const now = (opts.now ?? new Date()).toISOString();
  const sessionId = String(input?.session_id ?? "");
  if (!sessionId) return { exit: 0 };
  const j = loadJournal(sessionId, dir);
  if (input?.cwd && !j.cwd) j.cwd = String(input.cwd);
  if (input?.transcript_path && !j.transcript_path) j.transcript_path = String(input.transcript_path);

  switch (event) {
    case "SessionStart": {
      saveJournal(j, dir);
      const ctx = sessionStartContext(j);
      return { stdout: ctx, exit: 0 };
    }

    case "PostToolUse": {
      const tool = String(input?.tool_name ?? "");
      const text = responseText(input?.tool_response);
      // continuity: index every tool call locally so the helper can reconcile the transcript against it
      try { appendIndex(sessionId, { at: now, tool, id: input?.tool_use_id ? String(input.tool_use_id) : undefined }); } catch { /* best-effort */ }
      if (RECORD_TOOL.test(tool)) {
        const m = text.match(/Recorded (?:finding|decision|change|definition) ((?:fnd|dec|chg|def)-[\w-]+)/);
        if (m && !input?.tool_response?.isError) {
          j.entries.push({ at: now, kind: "record", tool, id: m[1], summary: clip(String(input?.tool_input?.title ?? "")) });
        }
      } else if (tool === SKIP_TOOL) {
        j.entries.push({ at: now, kind: "skip", tool, summary: clip(String(input?.tool_input?.reason ?? "")) });
      } else if (SEARCH_TOOLS.test(tool)) {
        j.entries.push({ at: now, kind: "search", tool, summary: summarize(input?.tool_input) });
      } else if (isDataTool(tool, input?.tool_input, opts.dataTools ?? DEFAULT_DATA_TOOLS)) {
        j.entries.push({ at: now, kind: "query", tool, summary: summarize(input?.tool_input) });
      } else {
        return { exit: 0 }; // not ours; don't touch the journal
      }
      saveJournal(j, dir);
      return { exit: 0 };
    }

    case "Stop": {
      // continuity: end of turn is the primary `turn` checkpoint trigger; the helper does the work
      try { writeSignal(sessionId, "checkpoint"); } catch { /* best-effort */ }
      const d = debt(j);
      if (!d.length) return { exit: 0 };
      const fp = fingerprint(d);
      if (j.nudged === fp || input?.stop_hook_active) {
        // already nudged for this work (or we are inside a stop-hook continuation): let it go, count it
        if (!j.entries.some((e) => e.kind === "unresolved" && e.summary === fp)) {
          j.entries.push({ at: now, kind: "unresolved", summary: fp });
          saveJournal(j, dir);
        }
        return { exit: 0 };
      }
      j.nudged = fp;
      j.entries.push({ at: now, kind: "nudge", summary: fp });
      saveJournal(j, dir);
      // JSON on stdout, exit 0: the block form both Claude Code and Codex document.
      // Top-level decision/reason is the original Claude shape and the Codex shape;
      // hookSpecificOutput is the current Claude shape. Emit both.
      const reason = stopReason(d);
      return {
        stdout: JSON.stringify({ decision: "block", reason, hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason } }),
        exit: 0,
      };
    }

    case "PreCompact": {
      try { writeSignal(sessionId, "checkpoint"); } catch { /* best-effort */ }
      const d = debt(j);
      if (!d.length) return { exit: 0 };
      j.entries.push({ at: now, kind: "compact", summary: fingerprint(d) });
      saveJournal(j, dir);
      const ctx =
        `Ledger: context is about to be compacted and ${d.length} data quer${d.length === 1 ? "y" : "ies"} ran with no record:\n` +
        debtText(d) +
        `\n\nRecord it now, while the method and assumptions are still in context. ` +
        RESOLVE;
      return {
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreCompact", additionalContext: ctx } }),
        exit: 0,
      };
    }

    case "SessionEnd": {
      try { writeSignal(sessionId, "end"); } catch { /* best-effort */ }
      const d = debt(j);
      if (d.length) {
        j.entries.push({ at: now, kind: "end", summary: `${d.length} uncaptured` });
        saveJournal(j, dir);
        // live capture failed for this session: hand it to the transcript fallback now
        return { exit: 0, reconcile: true };
      }
      return { exit: 0 };
    }

    default:
      return { exit: 0 };
  }
}

/** For `ledger stats`: did the checkpoint loop do anything, and did the agent respond. */
export function captureStats(days: number, dir = sessionsDir()): string[] {
  if (!fs.existsSync(dir)) return [`  capture: no sessions journaled yet (run \`ledger install claude\`)`];
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const journals: Journal[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const j: Journal = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (j.started >= since) journals.push(j);
    } catch {
      /* skip */
    }
  }
  const n = (k: EntryKind) => journals.reduce((s, j) => s + j.entries.filter((e) => e.kind === k).length, 0);
  // a record is "prompted" if a checkpoint (Stop nudge or PreCompact reminder)
  // fired since the last record or skip; an ignored nudge stays pending
  let prompted = 0;
  for (const j of journals) {
    let pending = false;
    for (const e of j.entries) {
      if (e.kind === "nudge" || e.kind === "compact") pending = true;
      else if (e.kind === "record") {
        if (pending) prompted++;
        pending = false;
      } else if (e.kind === "skip") pending = false;
    }
  }
  const endedWithDebt = journals.filter((j) => debt(j).length > 0).length;
  const sessionsWithQueries = journals.filter((j) => j.entries.some((e) => e.kind === "query")).length;
  return [
    `  capture (this machine): sessions ${journals.length}, with data queries ${sessionsWithQueries}, queries ${n("query")}`,
    `    records ${n("record")} (${n("record") - prompted} unprompted, ${prompted} after a checkpoint), nudges ${n("nudge")}, explicit skips ${n("skip")}, nudges ignored ${n("unresolved")}`,
    `    compactions with uncaptured work ${n("compact")}, sessions still carrying uncaptured work ${endedWithDebt}`,
  ];
}
