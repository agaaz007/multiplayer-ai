import { type Config, loadAll } from "./store.js";
import { TYPES, type LedgerObject, type LedgerType } from "./schema.js";
import { captureStats } from "./hooks.js";

// ---------- text scoring (no embeddings; good enough for hundreds of objects) ----------

const STOP = new Set(
  "the a an of to in on for and or is are was were be by with from at as it this that what how why when which did do does we our".split(" ")
);

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function textOf(o: LedgerObject): string {
  const f = o.fields;
  const parts = [
    o.title,
    o.tags.join(" "),
    o.body,
    ...Object.values(f).map((v) => (typeof v === "string" ? v : JSON.stringify(v))),
  ];
  return parts.join(" ");
}

export function score(query: string, o: LedgerObject): number {
  const q = new Set(tokens(query));
  if (q.size === 0) return 0;
  const doc = tokens(textOf(o));
  const title = new Set(tokens(o.title + " " + (o.fields.question ?? o.fields.metric ?? o.fields.decision ?? o.fields.what ?? "")));
  let hits = 0;
  for (const t of q) {
    if (title.has(t)) hits += 2;
    else if (doc.includes(t)) hits += 1;
  }
  return hits / q.size;
}

export interface SearchOpts {
  types?: LedgerType[];
  limit?: number;
  includeSuperseded?: boolean;
  tags?: string[];
}

export function search(cfg: Config, query: string, opts: SearchOpts = {}): (LedgerObject & { score: number })[] {
  const all = loadAll(cfg, opts.types ?? TYPES);
  return all
    .filter((o) => opts.includeSuperseded || o.status === "stable")
    .filter((o) => !opts.tags?.length || opts.tags.some((t) => o.tags.includes(t)))
    .map((o) => ({ ...o, score: score(query, o) }))
    .filter((o) => o.score > 0)
    .sort((a, b) => b.score - a.score || (a.created < b.created ? 1 : -1))
    .slice(0, opts.limit ?? 10);
}

/** Findings that answer a similar question. This is the rework-killer. */
export function similarFindings(cfg: Config, question: string, limit = 5) {
  return search(cfg, question, { types: ["finding"], limit }).filter((o) => o.score >= 0.5);
}

// ---------- rendering ----------

function short(o: LedgerObject): string {
  const f = o.fields;
  switch (o.type) {
    case "definition":
      return `- **${f.metric}** (${o.id}) = ${f.formula}. Source: ${f.source}. Excludes: ${(f.exclusions as string[])?.join(", ") || "nothing"}. Owner: ${f.owner}, valid from ${f.valid_from}.`;
    case "finding":
      return `- ${o.created.slice(0, 10)} ${o.author}: **${f.question}** → ${f.result} [${(f.data_window as any)?.from}→${(f.data_window as any)?.to}, ${f.source}, ${f.confidence}] (${o.id})`;
    case "change":
      return `- ${f.shipped_at} ${f.owner}: **${f.what}** on ${f.surface}${f.scope ? ` (${f.scope})` : ""} (${o.id})`;
    case "decision":
      return `- ${f.valid_from} ${f.owner}: **${f.decision}** — ${f.rationale} [${f.confidence}${f.revisit_by ? `, revisit ${f.revisit_by}` : ""}] (${o.id})`;
  }
}

/** One field, rendered so a reader can follow the argument rather than parse JSON. */
function renderField(k: string, v: unknown): string[] {
  if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) return [];
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [`**${k}**: ${v}`];
  if (k === "assumptions" && Array.isArray(v)) {
    const tag = (a: any) =>
      a.if_wrong === "changes_conclusion" ? ", changes conclusion" : a.if_wrong === "weakens_conclusion" ? ", weakens conclusion" : "";
    return [
      `**${k}**:`,
      ...v.map((a: any) => `- [${a.kind}${tag(a)}] ${a.statement}${a.evidence ? ` (evidence: ${a.evidence})` : ""}`),
    ];
  }
  if (k === "inputs" && Array.isArray(v)) {
    const filt = (f: any) => (typeof f === "string" ? f : f ? Object.entries(f).map(([a, b]) => `${a}=${b}`).join(", ") : "");
    return [
      `**${k}**:`,
      ...v.map(
        (i: any) =>
          `- ${i.source}${i.dataset ? `/${i.dataset}` : ""}${i.window ? ` [${i.window.from}→${i.window.to}]` : ""}${i.population ? `, population: ${i.population}` : ""}${i.filters ? `, ${filt(i.filters)}` : ""}${i.note ? ` (${i.note})` : ""}`
      ),
    ];
  }
  if (k === "options_considered" && Array.isArray(v)) {
    return [`**${k}**:`, ...v.map((o: any) => `- ${o.chosen ? "[chosen] " : ""}${o.option}${o.rationale ? `: ${o.rationale}` : ""}`)];
  }
  if (k === "confirmation" && v && typeof v === "object") {
    const c = v as any;
    return [`**${k}**: ${c.metric} ${c.success_condition}${c.evaluate_after ? `, evaluate after ${c.evaluate_after}` : ""}`];
  }
  if (k === "reproduce" && v && typeof v === "object") {
    const r = v as any;
    return [`**${k}**: ${[r.tool, r.query_or_artifact, r.instructions].filter(Boolean).join(" · ")}`];
  }
  if (k === "data_window" && v && typeof v === "object") {
    const w = v as any;
    return [`**${k}**: ${w.from} → ${w.to}`];
  }
  if (k === "prior" && v && typeof v === "object") {
    const p = v as any;
    return [`**${k}**: ${p.relation}${p.ids?.length ? ` ${p.ids.join(", ")}` : ""}`];
  }
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return v.length === 1 ? [`**${k}**: ${v[0]}`] : [`**${k}**:`, ...v.map((x) => `- ${x}`)];
  }
  return [`**${k}**: ${JSON.stringify(v)}`];
}

export function renderFull(o: LedgerObject): string {
  const lines = [`# ${o.title}`, ``, `id: ${o.id}  type: ${o.type}  status: ${o.status}  author: ${o.author}  created: ${o.created}`];
  if (o.supersedes) lines.push(`supersedes: ${o.supersedes}`);
  if (o.superseded_by) lines.push(`superseded_by: ${o.superseded_by}`);
  if (o.tags.length) lines.push(`tags: ${o.tags.join(", ")}`);
  lines.push(``);
  for (const [k, v] of Object.entries(o.fields)) lines.push(...renderField(k, v));
  if (o.body) lines.push(``, o.body);
  return lines.join("\n");
}

export interface BriefOpts {
  days?: number;
  tags?: string[];
}

/**
 * The thing injected at session start. Deliberately small:
 * all active definitions + last N days of findings/changes/decisions.
 */
export function brief(cfg: Config, opts: BriefOpts = {}): string {
  const days = opts.days ?? 14;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const all = loadAll(cfg).filter((o) => o.status === "stable");
  const byTag = (o: LedgerObject) => !opts.tags?.length || opts.tags.some((t) => o.tags.includes(t));

  const defs = all.filter((o) => o.type === "definition" && byTag(o));
  const recent = (t: LedgerType) => all.filter((o) => o.type === t && o.created >= since && byTag(o));

  const decisions = all.filter((o) => o.type === "decision" && byTag(o)).slice(0, 15);
  const findings = recent("finding").slice(0, 20);
  const changes = recent("change").slice(0, 15);

  const out: string[] = [];
  out.push(`# Ledger brief (${new Date().toISOString().slice(0, 10)}, last ${days} days)`);
  out.push(``);
  out.push(`Rules: use these definitions verbatim when computing metrics. Before running an analysis, call ledger_search with the question — if a matching finding exists, reuse or explicitly refresh it. Before attributing a change in a metric, check changes below. After any analysis, decision, or ship, record it: a finding needs inputs, method, and assumptions (explicit and implicit); a decision needs context and the options that lost. Full format in ~/.claude/ledger.md.`);
  out.push(``);
  out.push(`## Definitions (${defs.length})`);
  out.push(defs.length ? defs.map(short).join("\n") : "_none yet — record one before computing any metric_");
  out.push(``);
  out.push(`## Decisions in force (${decisions.length})`);
  out.push(decisions.length ? decisions.map(short).join("\n") : "_none_");
  out.push(``);
  out.push(`## Changes shipped, last ${days}d (${changes.length})`);
  out.push(changes.length ? changes.map(short).join("\n") : "_none_");
  out.push(``);
  out.push(`## Findings, last ${days}d (${findings.length})`);
  out.push(findings.length ? findings.map(short).join("\n") : "_none_");

  // Every draft is visible and labeled by origin. None is in force. Previously only transcript-fallback
  // drafts were listed, which hid hand-recorded `status: draft` objects from every brief.
  const drafts = loadAll(cfg, TYPES, false).filter((o) => o.status === "draft" && byTag(o));
  if (drafts.length) {
    const fallback = drafts.filter((o) => o.fields.capture_method === "transcript_fallback");
    const manual = drafts.filter((o) => o.fields.capture_method !== "transcript_fallback");
    out.push(``, `## Drafts, not in force (${drafts.length})`);
    if (fallback.length) {
      out.push(`Extracted from transcripts after live capture failed. For each: ledger_get it, then record a stable object with supersedes set to the draft id, or ledger_discard_draft with a reason.`);
      for (const d of fallback.slice(0, 5)) out.push(`- [fallback] ${d.type} ${d.id}: **${d.title}** — ${d.fields.capture_reason ?? ""} (${d.author}, ${d.created.slice(0, 10)})`);
      if (fallback.length > 5) out.push(`- …and ${fallback.length - 5} more fallback drafts: \`ledger drafts\``);
    }
    if (manual.length) {
      out.push(`Recorded by a person or their agent with status: draft. Work in progress, not a decision or finding in force; the owner promotes by recording a stable object with supersedes.`);
      for (const d of manual.slice(0, 5)) out.push(`- [draft] ${d.type} ${d.id}: **${d.title}** (${d.author}, ${d.created.slice(0, 10)})`);
      if (manual.length > 5) out.push(`- …and ${manual.length - 5} more drafts`);
    }
  }
  return out.join("\n");
}

// ---------- stats: the thing you measure the pilot with ----------

export function stats(cfg: Config, days = 14): string {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const all = loadAll(cfg);
  const recent = all.filter((o) => o.created >= since);
  const count = (t: LedgerType) => recent.filter((o) => o.type === t).length;
  const authors = new Map<string, number>();
  for (const o of recent) authors.set(o.author, (authors.get(o.author) ?? 0) + 1);

  // near-duplicate findings: same question asked twice within the window
  const findings = recent.filter((o) => o.type === "finding");
  const dupes: string[] = [];
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      const a = findings[i], b = findings[j];
      if (a.author === b.author) continue;
      if (score(String(a.fields.question), b) >= 0.6) {
        dupes.push(`  ${a.id} (${a.author}) ~ ${b.id} (${b.author})`);
      }
    }
  }
  const missingDefs = findings.filter((o) => !(o.fields.definitions_used as string[])?.length).length;
  const argued = [...findings, ...recent.filter((o) => o.type === "decision")];
  const noImplicit = argued.filter(
    (o) => !((o.fields.assumptions as any[]) ?? []).some((a) => a?.kind === "implicit")
  ).length;

  return [
    `Ledger stats, last ${days} days`,
    `  definitions: ${count("definition")}  findings: ${count("finding")}  changes: ${count("change")}  decisions: ${count("decision")}`,
    `  by author: ${[...authors].map(([a, n]) => `${a}=${n}`).join(", ") || "none"}`,
    `  findings without definitions_used: ${missingDefs}  (drift risk)`,
    `  findings/decisions without an implicit assumption: ${noImplicit}  (pre-format or hand-written)`,
    `  cross-author near-duplicate findings: ${dupes.length}  (rework that was NOT caught)`,
    ...dupes,
    `  total objects all time: ${all.length}`,
    ...captureStats(days),
    ...draftStats(all, recent),
  ].join("\n");
}

/** The transcript fallback: how often it ran, what it produced, and what the humans did with it. */
function draftStats(all: LedgerObject[], recent: LedgerObject[]): string[] {
  const fromFallback = (o: LedgerObject) => o.fields.capture_method === "transcript_fallback";
  const made = recent.filter(fromFallback);
  const pending = all.filter((o) => fromFallback(o) && o.status === "draft");
  const promoted = all.filter((o) => fromFallback(o) && o.status === "deprecated" && o.superseded_by);
  const discarded = all.filter((o) => fromFallback(o) && o.status === "deprecated" && !o.superseded_by);
  return [
    `  transcript fallback: drafts created ${made.length} (window), pending review ${pending.length}, promoted ${promoted.length}, discarded ${discarded.length} (all time)`,
  ];
}
