import crypto from "node:crypto";

/** Literal-only inspection of harness wrappers. Never evaluates JavaScript. */
export interface CapturedToolCall { tool: string; input: unknown; call_id: string; input_complete: boolean; wrapper?: string }
export const DEFAULT_DATA_TOOLS = ["^mcp__(?!ledger__).*(query|sql|clickhouse|amplitude|mixpanel|postgres|bigquery|snowflake|duckdb|metabase|redash|looker|analytics|insight|chart|event|funnel|retention|cohort|segment|report)"];
const SHELL = /^(Bash|exec_command|shell|container\.exec)$/;
const DATABASE = /\b(psql|clickhouse(-client)?|bq|duckdb|sqlite3|mysql|snowsql|trino|presto)\b/;
export const canonicalToolName = (name: string): string => name.replace(/^(?:functions\.|tools\.)/, "");
export const inputText = (input: unknown): string => typeof input === "string" ? input : JSON.stringify(input ?? null);
export const evidenceId = (callId: string | undefined, tool: string, at: string | undefined, input: unknown): string =>
  callId ? `q:${callId}` : `q:legacy:${crypto.createHash("sha256").update(JSON.stringify([at ?? "", canonicalToolName(tool), inputText(input)])).digest("hex").slice(0, 24)}`;

interface Token { value: string; kind: "name" | "string" | "number" | "punct" | "dynamic"; start: number; end: number }
function tokens(source: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < source.length;) {
    const start = i, c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith("//", i)) { const end = source.indexOf("\n", i); i = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (c === '"' || c === "'") {
      i++; let value = "", valid = false;
      while (i < source.length) {
        const x = source[i++];
        if (x === c) { valid = true; break; }
        if (x !== "\\") { value += x; continue; }
        const e = source[i++];
        const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0", "\\": "\\", "'": "'", '"': '"' };
        if (e === "u" || e === "x") {
          const length = e === "u" ? 4 : 2, hex = source.slice(i, i + length);
          if (!new RegExp(`^[0-9a-f]{${length}}$`, "i").test(hex)) break;
          value += String.fromCharCode(parseInt(hex, 16)); i += length;
        } else if (e === "\n") { /* line continuation */ }
        else if (e in escapes) value += escapes[e];
        else { value += e ?? ""; }
      }
      out.push({ value, kind: valid ? "string" : "dynamic", start, end: i }); continue;
    }
    // A template may contain interpolation. Keep it opaque; never pretend its value is known.
    if (c === "`") { i++; while (i < source.length) { if (source[i++] === "\\") i++; else if (source[i - 1] === "`") break; } out.push({ value: source.slice(start, i), kind: "dynamic", start, end: i }); continue; }
    const name = source.slice(i).match(/^[A-Za-z_$][\w$]*/);
    if (name) { i += name[0].length; out.push({ value: name[0], kind: "name", start, end: i }); continue; }
    const num = source.slice(i).match(/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
    if (num) { i += num[0].length; out.push({ value: num[0], kind: "number", start, end: i }); continue; }
    out.push({ value: c, kind: "punct", start, end: ++i });
  }
  return out;
}

function literal(ts: Token[], from: number, depth = 0): { value: unknown; end: number } | null {
  if (depth > 30) return null;
  const t = ts[from]; if (!t) return null;
  if (t.kind === "string") return { value: t.value, end: from + 1 };
  if (t.kind === "number" && Number.isFinite(Number(t.value))) return { value: Number(t.value), end: from + 1 };
  if (t.kind === "name" && ["true", "false", "null"].includes(t.value)) return { value: t.value === "null" ? null : t.value === "true", end: from + 1 };
  if (t.value === "{") {
    const value: Record<string, unknown> = Object.create(null); let i = from + 1;
    while (ts[i] && ts[i].value !== "}") {
      if (!["name", "string"].includes(ts[i].kind) || ts[i + 1]?.value !== ":") return null;
      const key = ts[i].value, item = literal(ts, i + 2, depth + 1); if (!item) return null;
      Object.defineProperty(value, key, { value: item.value, enumerable: true, configurable: true }); i = item.end;
      if (ts[i]?.value === "}") break;
      if (ts[i]?.value !== ",") return null; i++;
    }
    return ts[i]?.value === "}" ? { value, end: i + 1 } : null;
  }
  if (t.value === "[") {
    const value: unknown[] = []; let i = from + 1;
    while (ts[i] && ts[i].value !== "]") {
      const item = literal(ts, i, depth + 1); if (!item) return null; value.push(item.value); i = item.end;
      if (ts[i]?.value === "]") break;
      if (ts[i]?.value !== ",") return null; i++;
    }
    return ts[i]?.value === "]" ? { value, end: i + 1 } : null;
  }
  return null;
}

export function normalizeToolCalls(name: string, input: unknown, callId = "unknown"): CapturedToolCall[] {
  const tool = canonicalToolName(name);
  if (tool !== "exec" || typeof input !== "string") return [{ tool, input, call_id: callId, input_complete: true }];
  const ts = tokens(input), calls: CapturedToolCall[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].kind !== "name" || ts[i].value !== "tools") continue;
    let method: Token | undefined, open: number;
    if (ts[i + 1]?.value === "." && ts[i + 2]?.kind === "name") { method = ts[i + 2]; open = i + 3; }
    else if (ts[i + 1]?.value === "[" && ts[i + 2]?.kind === "string" && ts[i + 3]?.value === "]") { method = ts[i + 2]; open = i + 4; }
    else continue;
    if (ts[open]?.value !== "(") continue;
    const arg = literal(ts, open + 1), known = !!arg && ts[arg.end]?.value === ")";
    calls.push({ tool: canonicalToolName(method.value), input: known ? arg!.value : { unresolved_wrapper_input: input.slice(ts[open].end) }, call_id: `${callId}:inner:${ts[i].start}`, input_complete: known, wrapper: callId });
  }
  return calls.length ? calls : [{ tool, input, call_id: callId, input_complete: false }];
}

function directData(tool: string, input: any, patterns: string[]): boolean {
  if (SHELL.test(tool) || tool === "exec") {
    const text = typeof input === "string" ? input : String(input?.command ?? input?.cmd ?? "");
    return DATABASE.test(text);
  }
  return patterns.some((pattern) => new RegExp(pattern, "i").test(tool));
}
export function isDataTool(tool: string, input: unknown, patterns = DEFAULT_DATA_TOOLS): boolean {
  return normalizeToolCalls(tool, input).some(call => directData(call.tool, call.input, patterns));
}
export function dataToolCalls(tool: string, input: unknown, callId: string, patterns = DEFAULT_DATA_TOOLS): CapturedToolCall[] {
  return normalizeToolCalls(tool, input, callId).filter(call => directData(call.tool, call.input, patterns));
}

/** Decode structured MCP results carried inside JSON/text envelopes, without interpreting prose as success. */
export function responseEnvelope(response: unknown): any {
  let value: any = response;
  for (let n = 0; n < 4; n++) {
    if (typeof value === "string") { try { value = JSON.parse(value); continue; } catch { return { content: [{ type: "text", text: value }] }; } }
    if (value && typeof value === "object") return value;
    return {};
  }
  return value ?? {};
}

export function savedRecord(response: unknown): { id: string; status?: string } | null {
  const r = responseEnvelope(response);
  if (r.isError === true || r.is_error === true || r.success === false) return null;
  const receipt = r.structuredContent?.receipt ?? r.receipt;
  if (receipt?.action === "saved" && typeof receipt.record_id === "string") {
    return { id: receipt.record_id, status: receipt.records?.find((x: any) => x?.id === receipt.record_id)?.status };
  }
  const text = Array.isArray(r.content) ? r.content.map((x: any) => x?.text ?? "").join("\n") : "";
  const m = text.match(/(?:^|\n)Recorded (?:finding|decision|change|definition) ((?:fnd|dec|chg|def)-\d{8}-[\w-]+)/);
  return m ? { id: m[1] } : null;
}
