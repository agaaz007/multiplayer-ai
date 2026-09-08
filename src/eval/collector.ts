import fs from "node:fs";
import path from "node:path";
import type { ConditionPlugin, FixtureEvent, Metrics, Observation, OriginRun, RetrievedEvidence, SuccessorRun, TrialContext } from "./types.js";

/**
 * Common collector: turns the successor's free-form output and its observed tool traffic into
 * the kit's observation fields. Everything here is derived from what the successor actually
 * produced or received; nothing is filled from the fixture except the *exact* text of an event
 * that a successor tool output was verified to contain (kit rule: the controller may extract
 * the exact excerpt from a larger tool response, never from the fixture file alone).
 *
 * Answer normalization (documented aliases; the kit compares values with Python `!=`):
 *   1. `null`/`undefined` stay null. The strings "null" and "none" (trimmed, case-insensitive) become null.
 *   2. Numeric keys (NUMERIC_KEYS: price_inr, unverified_viewport): numbers pass through; strings have
 *      thousands separators removed and the first number group parsed ("₹199" -> 199, "640px" -> 640,
 *      "INR 199" -> 199). Integral values are emitted as integers. A string with no digits falls through
 *      to rule 3.
 *   3. Every other string: trim, lowercase, collapse internal whitespace, strip wrapping quotes/backticks
 *      and trailing sentence punctuation, then replace spaces with underscores ("Locked insight" ->
 *      "locked_insight", "unique exposed users" -> "unique_exposed_users", "WebView" -> "webview").
 *      Hyphens are preserved, so "metric-v1" survives and "small-screen" would not become "small_screen".
 *   4. Booleans, numbers under non-numeric keys, arrays and objects pass through unchanged.
 *   5. `selected_topic`: trim + lowercase only.
 *
 * Evidence citations: each answer may carry quoted evidence under `evidence`, `evidence_ids`, `quotes`,
 * `sources`, `citations`, `evidence_text` (string or array; objects contribute their `text`, `quote`,
 * `excerpt`, `ref`, `id`, `system_ref` fields). A cited string maps to a fixture event when, after
 * whitespace/case normalization, it equals the event text, contains it, or is a substring of it of at
 * least MIN_EXCERPT_CHARS characters. A string that matches no text is compared with the plugin's
 * system ref for each event (equal, or containment with at least MIN_REF_CHARS). Anything else is
 * dropped: an answer with no mappable citation gets an empty evidence_ids and fails the kit's check.
 */

export const NUMERIC_KEYS = new Set(["price_inr", "unverified_viewport"]);
export const MIN_EXCERPT_CHARS = 20;
export const MIN_REF_CHARS = 6;
/** Beyond this many fixture events, system-ref mapping of unmatched citations is skipped (L01 noise). */
const MAX_REF_LOOKUPS = 400;

export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function normalizeEnum(s: string): string {
  let t = normalizeWs(s).toLowerCase();
  t = t.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "").trim();
  t = t.replace(/[.!?;:,]+$/g, "").trim();
  return t.replace(/ /g, "_");
}

export function normalizeAnswerValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const t = value.trim();
    if (/^(null|none)$/i.test(t)) return null;
    if (NUMERIC_KEYS.has(key)) {
      const m = t.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/-?\d+(\.\d+)?/);
      if (m) return integral(Number(m[0]));
    }
    return normalizeEnum(t);
  }
  if (typeof value === "number") return NUMERIC_KEYS.has(key) ? integral(value) : value;
  return value;
}

function integral(n: number): number {
  return Number.isFinite(n) && Number.isInteger(n) ? Math.trunc(n) : n;
}

const CITATION_FIELDS = ["evidence", "evidence_ids", "quotes", "sources", "citations", "evidence_text", "supporting_evidence", "refs"];

/** Every string the successor attached to an answer as a citation, in order, deduplicated. */
export function citedStrings(answer: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") { const t = v.trim(); if (t && !out.includes(t)) out.push(t); }
    else if (typeof v === "number") push(String(v));
    else if (Array.isArray(v)) v.forEach(push);
    else if (v && typeof v === "object") {
      for (const k of ["text", "quote", "excerpt", "ref", "id", "system_ref", "seq", "event_id"]) if (k in (v as any)) push((v as any)[k]);
    }
  };
  if (answer && typeof answer === "object" && !Array.isArray(answer)) {
    for (const f of CITATION_FIELDS) if (f in (answer as any)) push((answer as any)[f]);
  }
  return out;
}

/** Fixture events a cited string refers to by text (see the module comment for the rule). */
export function matchByText(cited: string, events: FixtureEvent[]): FixtureEvent[] {
  const c = normalizeWs(cited).toLowerCase();
  if (!c) return [];
  const hits: FixtureEvent[] = [];
  for (const e of events) {
    const t = normalizeWs(e.text).toLowerCase();
    if (c === t || c.includes(t) || (c.length >= MIN_EXCERPT_CHARS && t.includes(c))) hits.push(e);
  }
  return hits;
}

/** Whether a tool output contains the exact fixture text: raw, whitespace-normalized, or JSON-escaped. */
export function outputContains(output: string, text: string): "exact" | "whitespace" | "json" | null {
  if (!output || !text) return null;
  if (output.includes(text)) return "exact";
  if (normalizeWs(output).includes(normalizeWs(text))) return "whitespace";
  const esc = JSON.stringify(text).slice(1, -1);
  if (esc !== text && output.includes(esc)) return "json";
  return null;
}

export interface ToolOutput { n: number; tool: string; call_id: string | null; input: string; output: string; at: string | null; source: "driver" | "transcript" }

/**
 * Successor tool outputs, fullest text available: the driver's preview, replaced by the full output
 * from the successor transcript when the transcript is on disk (tool.finished `_full`, redacted).
 * Transcript calls the driver did not report are appended.
 */
export async function loadSuccessorToolOutputs(successor: SuccessorRun, log: (s: string) => void): Promise<ToolOutput[]> {
  const byCall = new Map<string, { tool?: string; input?: string; output?: string; at?: string }>();
  if (successor.transcriptPath && fs.existsSync(successor.transcriptPath)) {
    try {
      const { streamTranscript } = await import("../continuity/events.js");
      const res = streamTranscript(successor.transcriptPath, 0, successor.harness);
      for (const ev of res.events) {
        if (!ev.call_id) continue;
        const cur = byCall.get(ev.call_id) ?? {};
        if (ev.kind === "tool.requested") { cur.tool = String(ev.payload.tool ?? ""); cur.input = String(ev.payload.input ?? ""); cur.at = ev.occurred_at; }
        if (ev.kind === "tool.finished") cur.output = String((ev.payload as any)._full ?? ev.payload.output_preview ?? "");
        byCall.set(ev.call_id, cur);
      }
      log(`collector: transcript ${path.basename(successor.transcriptPath)} yielded ${byCall.size} tool calls`);
    } catch (e: any) {
      log(`collector: transcript parse failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  const out: ToolOutput[] = [];
  const seen = new Set<string>();
  successor.toolCalls.forEach((c, i) => {
    const full = c.call_id ? byCall.get(c.call_id) : undefined;
    if (c.call_id) seen.add(c.call_id);
    const output = full?.output && full.output.length >= c.output_preview.length ? full.output : c.output_preview;
    out.push({ n: i + 1, tool: c.tool, call_id: c.call_id, input: c.input, output, at: c.at, source: full?.output ? "transcript" : "driver" });
  });
  for (const [id, v] of byCall) {
    if (seen.has(id) || v.output === undefined) continue;
    out.push({ n: out.length + 1, tool: v.tool ?? "?", call_id: id, input: v.input ?? "", output: v.output, at: v.at ?? null, source: "transcript" });
  }
  return out;
}

function readLedgerIds(rawDir: string): Record<string, string> {
  try {
    const p = path.join(rawDir, "ledger-ids.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { /* optional sidecar */ }
  return {};
}

export function metricsFrom(origin: OriginRun | null, successor: SuccessorRun, successorStartedAt: number | null): Metrics {
  const m: Metrics = {};
  if (successor.bootTokens != null) m.successor_boot_tokens = successor.bootTokens;
  if (successor.totalInputTokens != null) m.successor_total_input_tokens = successor.totalInputTokens;
  m.successor_wall_ms = successor.wallMs;
  m.completion_latency_ms = successor.wallMs;
  m.successor_tool_calls = successor.toolCalls.length;
  const firstAt = successor.toolCalls.map((c) => (c.at ? Date.parse(c.at) : NaN)).find((t) => Number.isFinite(t));
  if (successorStartedAt != null && firstAt !== undefined && firstAt >= successorStartedAt) m.resume_latency_ms = firstAt - successorStartedAt;
  else m.resume_latency_ms = successor.wallMs;
  if (origin) {
    m.origin_turns = origin.turns.length;
    m.origin_wall_ms = origin.turns.reduce((a, t) => a + (t.wallMs || 0), 0);
  }
  return m;
}

export interface CollectOptions { successorStartedAt?: number | null }

export async function collectCommon(ctx: TrialContext, origin: OriginRun | null, successor: SuccessorRun, plugin: ConditionPlugin, opts: CollectOptions = {}): Promise<Partial<Observation>> {
  const { request, log } = ctx;
  const events = request.case.events;
  const rawDir = ctx.paths.rawDir;
  fs.mkdirSync(rawDir, { recursive: true });
  const obs: Partial<Observation> = {};

  // ---- tool outputs (raw trace for review) ----
  const outputs = await loadSuccessorToolOutputs(successor, log);
  fs.writeFileSync(path.join(rawDir, "successor-tools.jsonl"), outputs.map((o) => JSON.stringify({ n: o.n, tool: o.tool, call_id: o.call_id, at: o.at, input: o.input.slice(0, 4000), output: o.output.slice(0, 20000), output_len: o.output.length, source: o.source })).join("\n") + (outputs.length ? "\n" : ""));

  // ---- answers ----
  const rawAnswers = (successor.output?.answers && typeof successor.output.answers === "object" ? successor.output.answers : {}) as Record<string, unknown>;
  const refCache = new Map<string, string | null>();
  const refOf = async (e: FixtureEvent): Promise<string | null> => {
    if (refCache.has(e.id)) return refCache.get(e.id)!;
    let ref: string | null = null;
    try { ref = (await plugin.evidenceRef(ctx, e))?.system_ref ?? null; } catch (err: any) { log(`collector: evidenceRef(${e.id}) failed: ${String(err?.message ?? err).slice(0, 160)}`); }
    refCache.set(e.id, ref);
    return ref;
  };
  const answers: NonNullable<Observation["answers"]> = {};
  const cited = new Set<string>();
  for (const key of request.case.answer_keys) {
    if (!(key in rawAnswers)) continue;
    const a = rawAnswers[key];
    const rawValue = a && typeof a === "object" && !Array.isArray(a) && "value" in (a as any) ? (a as any).value : a;
    const ids: string[] = [];
    for (const s of citedStrings(a)) {
      let hits = matchByText(s, events);
      if (!hits.length && events.length <= MAX_REF_LOOKUPS) {
        for (const e of events) {
          const ref = await refOf(e);
          if (!ref) continue;
          const a1 = s.toLowerCase(), b1 = ref.toLowerCase();
          if (a1 === b1 || (b1.length >= MIN_REF_CHARS && a1.includes(b1)) || (a1.length >= MIN_REF_CHARS && b1.includes(a1))) hits.push(e);
        }
      }
      for (const h of hits) if (!ids.includes(h.id)) ids.push(h.id);
    }
    ids.forEach((id) => cited.add(id));
    answers[key] = { value: normalizeAnswerValue(key, rawValue), evidence_ids: ids };
  }
  obs.answers = answers;
  log(`collector: ${Object.keys(answers).length}/${request.case.answer_keys.length} answers, cited fixture ids: ${[...cited].join(", ") || "(none)"}`);

  // ---- retrieved evidence: only what a successor tool output actually contained ----
  const ledgerIds = readLedgerIds(rawDir);
  const retrieved: Record<string, RetrievedEvidence> = {};
  const rawFiles = new Map<number, string>();
  for (const id of cited) {
    const e = events.find((x) => x.id === id);
    if (!e) continue;
    const candidates = outputs.map((o) => ({ o, kind: outputContains(o.output, e.text) })).filter((c): c is { o: ToolOutput; kind: NonNullable<ReturnType<typeof outputContains>> } => c.kind !== null);
    if (!candidates.length) { log(`collector: evidence ${id} cited but no successor tool output contained its text; left out`); continue; }
    const pluginRef = await refOf(e);
    // Without a plugin ref, prefer the output that also carries the ledger object id from the sidecar (D02), else the first hit.
    const found = (!pluginRef && ledgerIds[id] && candidates.find((c) => c.o.output.includes(ledgerIds[id]))) || candidates[0];
    let rawRef = rawFiles.get(found.o.n);
    if (!rawRef) {
      rawRef = `raw/retrieval-${found.o.n}.json`;
      fs.writeFileSync(path.join(ctx.paths.outputDir, rawRef), JSON.stringify({ n: found.o.n, tool: found.o.tool, call_id: found.o.call_id, at: found.o.at, input: found.o.input, output: found.o.output, source: found.o.source }, null, 2) + "\n");
      rawFiles.set(found.o.n, rawRef);
    }
    let systemRef = pluginRef;
    if (!systemRef && ledgerIds[id] && found.o.output.includes(ledgerIds[id])) systemRef = ledgerIds[id];
    if (!systemRef) systemRef = `${ctx.condition}:${found.o.tool}:${found.o.call_id ?? `call-${found.o.n}`}`;
    retrieved[id] = { text: e.text, system_ref: systemRef, raw_ref: rawRef };
    log(`collector: evidence ${id} found in tool call #${found.o.n} (${found.o.tool}, ${found.kind}) -> ${systemRef}`);
  }
  if (Object.keys(retrieved).length) obs.retrieved_evidence = retrieved;

  // ---- selected topic ----
  const topic = successor.output?.selected_topic;
  if (typeof topic === "string" && topic.trim()) obs.selected_topic = topic.trim().toLowerCase();

  // ---- metrics ----
  obs.metrics = metricsFrom(origin, successor, opts.successorStartedAt ?? null);

  // ---- file bundles, when the adapter produced them ----
  for (const [field, dir] of [["recovered_files", "recovered"], ["final_files", "final"]] as const) {
    const p = path.join(ctx.paths.outputDir, dir);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) (obs as any)[field] = dir;
  }
  return obs;
}
