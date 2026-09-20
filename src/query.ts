import { type Config, loadAll } from "./store.js";
import { TYPES, AnalysisScopeSchema, type LedgerObject, type LedgerType } from "./schema.js";
import { captureStats } from "./hooks.js";
import { projectAuthorityObjects, resolveAccepted, correctionImpact, matchesAnalysisScope, objectVersion, scopeIdentity, type ScopeQuery } from './authority.js';

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

// ---------- duplicate detection: a different question from search, and a different measure ----------

/**
 * `score` asks "is this record relevant to this query": recall of the query's tokens against the whole
 * record, unnormalised for how much the record says. That is the right shape for search and the wrong
 * one for "did someone already answer this". A 16-token question against a 600-token finding matches on
 * the vocabulary every finding in a ledger shares (`login`, `trial`, `config`, `rate`), the title bonus
 * carries it past 1.0, and nothing on the other side has to be about the same thing. On the pilot ledger
 * that flagged 3,629 of 21,528 finding pairs as near-duplicates — 17% of everything anyone had written.
 *
 * Duplication is a symmetric claim about two questions, so it is measured as one: cosine over the two
 * questions alone, each token weighted by inverse document frequency, so shared boilerplate counts for
 * little and the terms that distinguish one question from another carry the match. Same corpus, 25 pairs
 * at {@link NEAR_DUPLICATE}.
 */
export const NEAR_DUPLICATE = 0.5;
/**
 * The write-path nudge is advisory, ranked and capped, so it reaches lower than the bar for asserting
 * that two records duplicate each other: a refresh of the same metric over a later window lands here.
 * Below this, the pilot ledger's pairs stop being the same question and start being the same subject.
 */
export const RELATED_QUESTION = 0.3;

/** What a record claims, not everything it says: the question a finding answers, the metric a definition names. Falls back to the title when a legacy record has neither. */
export function claimText(o: LedgerObject): string {
  const f = o.fields;
  return String(f.question ?? f.metric ?? f.decision ?? f.what ?? "").trim() || o.title;
}

/** IDF over a corpus of claim texts. Built once per call site; `df` counts every finding ever recorded, superseded included, because how common a word is is a property of the vocabulary and not of what is current. */
export function idfOver(corpus: string[]): (token: string) => number {
  const df = new Map<string, number>();
  for (const text of corpus) for (const t of new Set(tokens(text))) df.set(t, (df.get(t) ?? 0) + 1);
  const n = corpus.length;
  return (t) => Math.log((n + 1) / ((df.get(t) ?? 0) + 0.5));
}

/** Cosine of two IDF-weighted question vectors, in [0, 1]. Symmetric: neither side wins by being longer. */
export function questionSimilarity(a: string, b: string, idf: (t: string) => number): number {
  const [x, y] = [new Set(tokens(a)), new Set(tokens(b))];
  if (!x.size || !y.size) return 0;
  let dot = 0, na = 0, nb = 0;
  for (const t of x) { const w = idf(t); na += w * w; if (y.has(t)) dot += w * w; }
  for (const t of y) { const w = idf(t); nb += w * w; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Two declared scopes that disagree are not two answers to one question, whatever their wording shares:
 * a metric measured on Android IN does not duplicate the same metric on iOS US. An absent scope is
 * unknown, never a match, so legacy records keep being compared on their questions.
 */
export function scopesConflict(a: unknown, b: unknown): boolean {
  return Boolean(a && b && scopeIdentity(a) !== scopeIdentity(b));
}

export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Fraction of the query's tokens found in the document, title hits counting fully and body hits half.
 * Range 0..1. Query-token stop words are removed by `tokens` (query.ts), so "how did trial CVR move"
 * matches on "trial", "cvr", "move".
 */
export function matchScore(q: string, title: string, body = ""): number {
  const qt = new Set(tokens(q));
  if (!qt.size) return 0;
  const t = new Set(tokens(title)), b = new Set(tokens(body));
  let hits = 0;
  for (const x of qt) { if (t.has(x)) hits += 1; else if (b.has(x)) hits += 0.5; }
  return hits / qt.size;
}

/** Symmetric title coverage: both titles must cover each other's tokens. The declare-time near-duplicate refusal in continuity/investigations.ts and the classifier anti-twin check both read it. */
export function titleSimilarity(a: string, b: string): number {
  if (normalizeTitle(a) === normalizeTitle(b)) return 1;
  return Math.min(matchScore(a, b), matchScore(b, a));
}

export interface SearchOpts {
  types?: LedgerType[];
  limit?: number;
  includeSuperseded?: boolean;
  tags?: string[];
  scope?: ScopeQuery;
  asOf?: string;
  /** Only objects recorded under this author. */
  author?: string;
}

/**
 * Authority tier of a ledger object, the first sort key of `search`.
 *   3 = stable and current: not superseded, or the accepted head of an unresolved conflict
 *   2 = draft: recorded by a person or the transcript fallback, never in force
 *   0 = superseded or deprecated: shown only with includeSuperseded
 */
export type ObjectAuthorityTier = 3 | 2 | 0;

/** `current` · `draft` · `superseded by <id>` · `rejected` (a discarded draft) · `discarded cut` (a query-grain proposal a person discarded, reason kept) · `deprecated` (retired without a successor). */
export type ObjectAuthorityLabel = "current" | "draft" | `superseded by ${string}` | "rejected" | "discarded cut" | "deprecated";

export type AuthoritySearchHit = LedgerObject & {
  score: number;
  authority_status: ReturnType<typeof resolveAccepted>["status"];
  authority_warnings: string[];
  authority_current_ids: string[];
  scope_status: "known" | "unknown";
  authority_tier: ObjectAuthorityTier;
  authority_label: ObjectAuthorityLabel;
};

/** Discover a definition family before resolving its time intervals; partial applicability must stay visible as a warning. */
export function matchesDiscoveryScope(o: LedgerObject, scope?: ScopeQuery): boolean {
  if(o.type==='definition' && scope?.window) {
    const {window: _window,...identity}=scope;
    return matchesAnalysisScope(o,identity);
  }
  return matchesAnalysisScope(o,scope);
}

/** Missing facets are discovery evidence only. Known incompatible facets never become fallback hits. */
export function legacyScopeGaps(o: LedgerObject, scope?: ScopeQuery): string[] | null {
  const actual = (o.fields.analysis_scope ?? {}) as Record<string, unknown>;
  const required = Object.keys(AnalysisScopeSchema.shape).filter(k => k !== 'window');
  const gaps = required.filter(k => typeof actual[k] !== 'string' || !(actual[k] as string).trim());
  if (!gaps.length) return null;
  for (const [key, value] of Object.entries(scope ?? {})) {
    if (key === 'window' || value === undefined) continue;
    if (actual[key] !== undefined && actual[key] !== value) return null;
  }
  if (scope?.window) {
    const window = (o.type === 'finding' ? o.fields.data_window : actual.window) as {from?: string; to?: string} | undefined;
    if (window?.from && (o.type === 'finding' ? window.from.slice(0,10) !== scope.window.from.slice(0,10) : window.from.slice(0,10) > scope.window.from.slice(0,10))) return null;
    if (window?.to && (o.type === 'finding' ? window.to.slice(0,10) !== scope.window.to.slice(0,10) : window.to.slice(0,10) < scope.window.to.slice(0,10))) return null;
    if (!window?.from || !window?.to) gaps.push('window');
  }
  return gaps;
}

/** Tier and label from the object's own lifecycle plus its accepted resolution; the label always names what displaced it. */
export function objectAuthority(o: LedgerObject, authority: { status: string; current: { id: string }[] }): { tier: ObjectAuthorityTier; label: ObjectAuthorityLabel } {
  if (o.superseded_by) return { tier: 0, label: `superseded by ${o.superseded_by}` };
  if (o.status === "deprecated") return { tier: 0, label: o.fields.stance === "discarded" ? "discarded cut" : o.fields.discarded ? "rejected" : "deprecated" };
  if (o.status === "draft") return { tier: 2, label: "draft" };
  // stable: current unless the accepted resolution names other heads and not this one
  if (authority.status === "conflict" && !authority.current.some((c) => c.id === o.id)) {
    const head = authority.current[0]?.id;
    return head ? { tier: 0, label: `superseded by ${head}` } : { tier: 0, label: "deprecated" };
  }
  return { tier: 3, label: "current" };
}

/** One line naming what the search covered; the first line of every result so a reader never guesses the scope. */
export function objectScopeLine(opts: SearchOpts): string {
  return `scope: ledger objects, all repos · types ${opts.types?.length ? opts.types.join(",") : "any"} · author ${opts.author ?? "any"} · as of ${opts.asOf ?? "now"} · ${opts.includeSuperseded ? "including superseded and drafts" : "current only"} · lexical only`;
}

/**
 * Ranking: authority tier desc, then created desc, then lexical score desc. A newer current object
 * outranks an older one whatever their scores; score only breaks ties inside one tier and instant.
 */
export function compareHits(a: AuthoritySearchHit, b: AuthoritySearchHit): number {
  return b.authority_tier - a.authority_tier || (a.created < b.created ? 1 : a.created > b.created ? -1 : 0) || b.score - a.score || a.id.localeCompare(b.id);
}

export function search(cfg: Config, query: string, opts: SearchOpts = {}): AuthoritySearchHit[] {
  const source = loadAll(cfg, TYPES);
  const all = opts.includeSuperseded ? source : projectAuthorityObjects(source, { asOf: opts.asOf, scope: opts.scope });
  const annotated = (o: LedgerObject): AuthoritySearchHit => {
    const authority = resolveAccepted(source, o.id, { asOf: opts.asOf, scope: opts.scope });
    const { tier, label } = objectAuthority(o, authority);
    return { ...o, score: score(query, o), authority_status: authority.status, authority_warnings: authority.warnings,
      authority_current_ids: authority.current.map(c => c.id), scope_status: authority.scope_status, authority_tier: tier, authority_label: label };
  };
  const ranked = all
    .filter(o => !opts.types || opts.types.includes(o.type))
    .filter(o => !opts.author || o.author === opts.author)
    .filter(o => matchesDiscoveryScope(o, opts.scope))
    .filter((o) => !opts.tags?.length || opts.tags.some((t) => o.tags.includes(t)))
    .map(annotated)
    .filter(o => opts.includeSuperseded || o.status==='stable' || (o.authority_status==='conflict' && o.authority_current_ids.includes(o.id)) ||
      (o.type==='definition' && opts.scope?.window && o.authority_status==='unavailable' && o.status!=='draft' && o.previous_status!=='draft' && o.fields.capture_method!=='transcript_fallback'))
    .filter((o) => o.score > 0)
    .sort(compareHits);
  const selected = ranked.slice(0, opts.limit ?? 10);
  const ids = new Set(selected.map(o => o.id));
  // A result limit may trim relevance, never one side of an unresolved accepted conflict.
  for (const hit of [...selected]) if (hit.authority_status === "conflict") {
    for (const id of hit.authority_current_ids) {
      if (ids.has(id)) continue;
      const sibling = all.find(o => o.id === id);
      if (sibling && matchesDiscoveryScope(sibling, opts.scope)) { selected.push(annotated(sibling)); ids.add(id); }
    }
  }
  return selected;
}

export type SimilarFindingHit = AuthoritySearchHit & { similarity: number };

export interface SimilarOpts {
  /** The pending record's analysis_scope, when it declares one. A candidate that declares a different scope is dropped: same words, different population. */
  scope?: unknown;
  /** Minimum {@link questionSimilarity}. Defaults to {@link RELATED_QUESTION}. */
  threshold?: number;
}

/**
 * Findings that answer a similar question. This is the rework-killer, so it is ordered by similarity
 * and capped: the write path shows these to an author who is about to record, and a list padded with
 * everything that shares the word "trial" is a list nobody reads.
 *
 * Candidates come from `search`, which applies the authority projection, so a superseded or discarded
 * finding is never offered as the thing to supersede. They are then re-scored with
 * {@link questionSimilarity}; `hit.score` stays the lexical relevance `search` computed.
 */
export function similarFindings(cfg: Config, question: string, limit = 5, opts: SimilarOpts = {}): SimilarFindingHit[] {
  const idf = idfOver(loadAll(cfg, ["finding"]).map(claimText));
  // No candidate cap: ranked by authority then recency, a 50-hit page is the 50 newest weak matches,
  // and the near-duplicate from three months ago — the one worth superseding — falls off the end.
  return search(cfg, question, { types: ["finding"], limit: Number.MAX_SAFE_INTEGER })
    .map((h) => ({ ...h, similarity: questionSimilarity(question, claimText(h), idf) }))
    .filter((h) => h.similarity >= (opts.threshold ?? RELATED_QUESTION) && !scopesConflict(opts.scope, h.fields.analysis_scope))
    .sort((a, b) => b.similarity - a.similarity || compareHits(a, b))
    .slice(0, limit);
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

/** Ids named inline when one warning covers many records; the count beside them is always exact. */
const WARNING_IDS_SHOWN = 6;

/**
 * One sentence repeated with a different id in front is one fact, not many. On the Tranzmit ledger
 * 36 of 38 authority warnings are the same legacy-provenance sentence, together 9.4 KB — more than
 * the whole brief budget, which meant every definition was crowded out by a fact stated 36 times.
 * Collapsing keeps the sentence once and the exact count; the first ids are named so a reader can
 * start somewhere, and the remainder is stated rather than silently dropped.
 */
export function collapseWarnings(warnings: string[]): string[] {
  const families = new Map<string, string[]>();
  for (const warning of warnings) {
    const prefixed = /^([A-Za-z][\w.-]*):\s([\s\S]+)$/.exec(warning);
    const [sentence, id] = prefixed ? [prefixed[2], prefixed[1]] : [warning, ""];
    const ids = families.get(sentence) ?? [];
    if (id) ids.push(id);
    families.set(sentence, ids);
  }
  return [...families].map(([sentence, ids]) => {
    if (ids.length === 0) return sentence;
    if (ids.length === 1) return `${ids[0]}: ${sentence}`;
    const shown = ids.slice(0, WARNING_IDS_SHOWN);
    const rest = ids.length - shown.length;
    return `${sentence} Affects ${ids.length} records: ${shown.join(", ")}${rest ? `, and ${rest} more (\`ledger_get(id)\` on any of them)` : ""}`;
  });
}

export interface BriefOpts {
  days?: number;
  tags?: string[];
  /** Optional packaged guide supplied by an embedding host; installed-guide default is unchanged. */
  guidePath?: string;
  scope?: ScopeQuery;
  /** Hard ceiling on the rendered brief, in bytes. Infinity renders everything (`ledger brief --full`). */
  budgetBytes?: number;
  /** SessionStart after a resume or a compaction: the brief says it replaces the copy already in context. */
  reinjection?: boolean;
}

/**
 * Both harnesses truncate a SessionStart hook payload long before the model reads it, and neither
 * says so. On this machine every brief since 2026-09-03 was over the limit — 25 KB then, 123,064
 * bytes on 2026-09-21 — and the agent received a ~2 KB preview that stopped inside the authority
 * warnings, so it never saw a single definition. Nothing detected it, because an agent cannot tell
 * a short brief from a complete one.
 *
 * So the brief is budgeted here, where the omissions are still countable, rather than cut by the
 * harness where they are not. A brief that arrives whole and names what it left out is strictly
 * more useful than one that arrives cut at an arbitrary byte.
 */
export const BRIEF_BUDGET_BYTES = 7_000;
/** The SessionStart hook emits the brief plus the session line, uncaptured work, open threads and capture warnings. */
export const SESSION_START_BUDGET_BYTES = 10_000;
export type BriefSectionKey = "conflicts" | "warnings" | "definitions" | "decisions" | "findings" | "changes" | "drafts";

/**
 * Spend order, highest first: a conflict the agent cannot discover by asking, then the definitions
 * a metric must be computed with, then the decisions in force, then recent activity it would only
 * reread. Everything below the line is one `ledger_search` away; a wrong number is not.
 */
export const BRIEF_PRIORITY: BriefSectionKey[] = ["conflicts", "warnings", "definitions", "decisions", "findings", "changes", "drafts"];

/**
 * Per-section ceilings in bytes, summing to roughly what {@link BRIEF_BUDGET_BYTES} leaves after the
 * fixed prose. They are ceilings, not reservations: unspent bytes flow to the sections below, and a
 * second pass hands the remainder back down the same order. Without them, priority alone lets one
 * runaway list — 48 definitions at ~1,300 bytes each, 38 legacy-provenance warnings — spend the whole
 * budget and leave every section under it empty, which is the failure this budget exists to prevent.
 */
export const BRIEF_SECTION_CAPS: Record<BriefSectionKey, number> = {
  conflicts: 700, warnings: 500, definitions: 1_800, decisions: 700, findings: 600, changes: 400, drafts: 200,
};

const BRIEF_NOUNS: Record<BriefSectionKey, string> = {
  conflicts: "unresolved accepted conflicts", warnings: "authority warnings", definitions: "definitions",
  decisions: "decisions in force", findings: "findings", changes: "changes", drafts: "drafts",
};

/** What returns the records a section could not fit. Every omission names its own query. */
const BRIEF_RETRIEVAL: Record<BriefSectionKey, string> = {
  conflicts: '`ledger_search({ query, include_superseded: true })`',
  warnings: '`ledger_get(id)`, then `ledger_investigation({ question, analysis_scope })` for the accepted resolution',
  definitions: '`ledger_search({ query: "<metric>", types: ["definition"], limit: 50 })`',
  decisions: '`ledger_search({ query, types: ["decision"], limit: 50 })`',
  findings: '`ledger_search({ query, types: ["finding"], limit: 50 })`',
  changes: '`ledger_search({ query, types: ["change"], limit: 50 })`',
  drafts: '`ledger drafts`',
};

interface BriefEntry { id?: string; text: string; name?: string }
interface SectionFill { key: BriefSectionKey; lines: string[]; ids: string[]; omitted: number; total: number; bytes: number }
/** Renders what a section could not fit. Richest first; `fitSection` falls back when even this does not fit. */
type OverflowRenderer = (omitted: BriefEntry[], total: number) => string;

const countOverflow = (key: BriefSectionKey): OverflowRenderer => (omitted, total) =>
  `_${omitted.length} of ${total} ${BRIEF_NOUNS[key]} omitted to fit the brief's byte budget. Retrieve them: ${BRIEF_RETRIEVAL[key]}._`;

/**
 * Definitions overflow to their metric names. Knowing that `trial_start_cvr` is defined somewhere is
 * the difference between one `ledger_get` and a silently reinvented denominator, and a name costs
 * ~20 bytes against ~1,300 for the definition it points at. `limit` bounds the name list so
 * {@link fitSection} can offer a narrower version when the wide one does not fit.
 */
const namedOverflow = (limit: number): OverflowRenderer => (omitted, total) => {
  const names: string[] = [];
  let bytes = 0;
  for (const e of omitted) {
    const label = e.name ?? e.id ?? "";
    if (!label || bytes + label.length + 3 > limit) break;
    names.push(label); bytes += label.length + 3;
  }
  if (!names.length) return countOverflow("definitions")(omitted, total);
  const rest = omitted.length - names.length;
  return `_${omitted.length} of ${total} definitions omitted to fit the brief's byte budget. Also defined, not shown in full: ${names.join(" · ")}${rest ? ` (+${rest} more)` : ""}. Read one with \`ledger_get(id)\`; list them with ${BRIEF_RETRIEVAL.definitions}._`;
};

/**
 * Whole entries only. Half a definition is a wrong definition and the agent cannot tell, so the
 * loop drops entries until the kept ones plus the overflow notice fit the allowance.
 */
function fitSection(key: BriefSectionKey, entries: BriefEntry[], allowance: number, renderers: OverflowRenderer[]): SectionFill {
  const size = (s: string) => Buffer.byteLength(s) + 1;
  for (const render of renderers) {
    for (let k = entries.length; k >= 0; k--) {
      const lines = entries.slice(0, k).map((e) => e.text);
      if (k < entries.length) lines.push(render(entries.slice(k), entries.length));
      const bytes = lines.reduce((n, l) => n + size(l), 0);
      if (bytes > allowance) continue;
      return { key, lines, ids: entries.slice(0, k).flatMap((e) => (e.id ? [e.id] : [])), omitted: entries.length - k, total: entries.length, bytes };
    }
  }
  // Nothing fits, not even the notice. The closing "Not in this brief" block still carries the count.
  return { key, lines: [], ids: [], omitted: entries.length, total: entries.length, bytes: 0 };
}

export interface BriefDrop { section: BriefSectionKey; omitted: number; of: number }

/**
 * The closing block, and the one thing in the brief that is never dropped: it states the budget, the
 * exact count of every omission, and how to retrieve them. Without it a budgeted brief would be
 * indistinguishable from a complete one, which is the bug the budget exists to fix.
 */
function tailLines(budget: number | null, drops: BriefDrop[]): string[] {
  return [
    `## Not in this brief`,
    budget === null
      ? `Unbudgeted (\`ledger brief --full\`). The brief your harness injects is capped at ${BRIEF_BUDGET_BYTES} bytes.`
      : `Capped at ${budget} bytes so the harness delivers it whole; over that, it is silently truncated before you see it.`,
    drops.length
      ? `Omitted here: ${drops.map((d) => `${d.omitted} ${BRIEF_NOUNS[d.section]}`).join(", ")}. Those counts are exact and each section above names the query that returns them.`
      : `Nothing was omitted: every current record in scope is above.`,
    `Everything else is still recorded: \`ledger_search({ query, types })\` finds records, \`ledger_get(id)\` reads one in full, and \`ledger_investigation({ question, analysis_scope })\` resolves accepted definitions and corrections across full history before you reuse a result.`,
    `Retrieval is not use: found means it was returned to you, referenced means you cited it with ledger_show_contribution, saved means it is recorded.`,
  ];
}
export interface BriefReport {
  text: string;
  bytes: number;
  /** null when the brief was rendered unbudgeted (`ledger brief --full`). */
  budget_bytes: number | null;
  /** Ids the agent actually received, in render order. Ids only: an injection record never carries bodies. */
  record_ids: string[];
  drops: BriefDrop[];
  truncated: boolean;
}

/**
 * The thing injected at session start: all active definitions plus the last N days of
 * findings/changes/decisions, rendered under {@link BRIEF_BUDGET_BYTES} and reporting exactly what
 * the budget left out. {@link brief} returns the text alone; the report is what the injection log
 * records, so what was logged is what the agent received.
 */
export function briefReport(cfg: Config, opts: BriefOpts = {}): BriefReport {
  const days = opts.days ?? 14;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const source = loadAll(cfg);
  const all = projectAuthorityObjects(source, { scope: opts.scope }).filter((o) => o.status === "stable" && matchesAnalysisScope(o, opts.scope));
  const byTag = (o: LedgerObject) => !opts.tags?.length || opts.tags.some((t) => o.tags.includes(t));

  const defs = all.filter((o) => o.type === "definition" && byTag(o));
  const recent = (t: LedgerType) => all.filter((o) => o.type === t && o.created >= since && byTag(o));

  const decisions = all.filter((o) => o.type === "decision" && byTag(o)).slice(0, 15);
  const findings = recent("finding").slice(0, 20);
  const changes = recent("change").slice(0, 15);
  const conflicts = new Map<string, ReturnType<typeof resolveAccepted>>();
  const authorityWarnings = new Set<string>();
  for (const o of source.filter(byTag).filter(o=>matchesDiscoveryScope(o,opts.scope))) {
    const resolution = resolveAccepted(source, o.id, { scope: opts.scope });
    if (resolution.status === "conflict") conflicts.set(resolution.current.map(c => c.id).sort().join("|"), resolution);
    if((opts.scope?.window && resolution.status==='unavailable') || resolution.current.some(c=>c.id===o.id))
      for(const warning of resolution.warnings) authorityWarnings.add(warning);
  }

  // Every draft is visible and labeled by origin. None is in force. Previously only transcript-fallback
  // drafts were listed, which hid hand-recorded `status: draft` objects from every brief.
  const drafts = source.filter((o) => o.status === "draft" && byTag(o) && matchesAnalysisScope(o, opts.scope));
  const draftLabel = (d: LedgerObject) => d.fields.stance === "PROPOSED" ? "proposed" : d.fields.capture_method === "transcript_fallback" ? "fallback" : "draft";
  const draftDetail = (d: LedgerObject) =>
    d.fields.stance === "PROPOSED" ? ` — investigation ${d.fields.investigation_record_id ?? "unbound"}, query ${d.fields.query_ref ?? "?"}`
      : d.fields.capture_method === "transcript_fallback" ? `${d.fields.capture_reason ? ` — ${d.fields.capture_reason}` : ""}` : "";
  const draftRank = (d: LedgerObject) => ["proposed", "fallback", "draft"].indexOf(draftLabel(d));
  const orderedDrafts = [...drafts].sort((a, b) => draftRank(a) - draftRank(b));

  const entries: Record<BriefSectionKey, BriefEntry[]> = {
    conflicts: [...conflicts.values()].map((conflict) => ({
      id: conflict.current[0]?.id,
      text: `UNRESOLVED ACCEPTED CONFLICT: ${conflict.current.map(c => `${c.id} (${c.title})`).join("; ")}. No single source is authoritative; inspect the evidence and explicitly resolve. The recent-list limit does not resolve this conflict.`,
    })),
    warnings: collapseWarnings([...authorityWarnings]).map((warning) => ({ text: `WARNING: ${warning}` })),
    definitions: defs.map((o) => ({ id: o.id, name: String(o.fields.metric ?? o.title), text: short(o)! })),
    decisions: decisions.map((o) => ({ id: o.id, text: short(o)! })),
    findings: findings.map((o) => ({ id: o.id, text: short(o)! })),
    changes: changes.map((o) => ({ id: o.id, text: short(o)! })),
    drafts: orderedDrafts.map((d) => ({ id: d.id, text: `- [${draftLabel(d)}] ${d.type} ${d.id}: **${d.title}**${draftDetail(d)} (${d.author}, ${d.created.slice(0, 10)})` })),
  };

  const budget = opts.budgetBytes ?? BRIEF_BUDGET_BYTES;
  const budgeted = Number.isFinite(budget) && budget > 0;
  const head = [
    `# Ledger brief (${new Date().toISOString().slice(0, 10)}, last ${days} days)`,
    ...(opts.reinjection ? [`This snapshot replaces the earlier Ledger brief in this session; the copy above it is stale, read this one.`] : []),
    ``,
    `This brief is an activity summary, not exhaustive task context. Use ledger_investigation with the question and analytical scope before reusing a result; it resolves accepted corrections across full history.`,
  ];
  const rules = `Rules: use these definitions verbatim when computing metrics. Before running an analysis, call ledger_search with the question — if a matching finding exists, reuse or explicitly refresh it. Before attributing a change in a metric, check changes below. After any analysis, decision, or ship, record it: a finding needs inputs, method, and assumptions (explicit and implicit); a decision needs context and the options that lost. Full format in ${opts.guidePath ? `\`${opts.guidePath}\`` : "~/.claude/ledger.md"}.`;
  const headings: Record<string, string> = {
    definitions: "Definitions", decisions: "Decisions in force",
    changes: `Changes shipped, last ${days}d`, findings: `Findings, last ${days}d`, drafts: "Drafts, not in force",
  };
  // The labels are deliberately unbracketed here: a bracketed label in the guidance reads as one more
  // draft entry, to a person and to any test that looks for one.
  const draftsFooter = `Not in force. A person accepts a proposed finding with ledger_review_finding(id, "accept"), promotes a fallback or manual draft by recording a stable object with supersedes, or discards it with a reason.`;
  // Headings, the fixed prose and the closing block are always emitted, so they are spent before any
  // record is. The closing block is reserved at its worst case — every section fully omitted — which
  // is known from the entry counts alone, so the reserve is exact rather than a guessed constant.
  const worstTail = tailLines(budgeted ? budget : null, BRIEF_PRIORITY.flatMap((key) =>
    entries[key].length ? [{ section: key, omitted: entries[key].length, of: entries[key].length }] : []));
  const fixed = [
    ...head, rules,
    ...Object.entries(headings).flatMap(([key, h]) => [``, `## ${h} (${entries[key as BriefSectionKey].length} of ${entries[key as BriefSectionKey].length})`]),
    ...(drafts.length ? [draftsFooter] : []),
    ``, ...worstTail,
  ].reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);

  const fills = new Map<BriefSectionKey, SectionFill>();
  const renderers = (key: BriefSectionKey) => key === "definitions"
    ? [namedOverflow(1_400), namedOverflow(700), namedOverflow(300), countOverflow(key)]
    : [countOverflow(key)];
  if (!budgeted) {
    for (const key of BRIEF_PRIORITY) fills.set(key, fitSection(key, entries[key], Infinity, renderers(key)));
  } else {
    // Three passes of one cap each, in priority order. A single pass leaves the caps' slack unspent;
    // an unbounded second pass hands the whole remainder to whichever high-priority section is still
    // truncated — on this ledger that was 38 legacy-provenance warnings, which then crowded out every
    // definition, decision and finding. Offering one more cap at a time spreads the slack instead.
    let remaining = Math.max(0, budget - fixed);
    for (const pass of [1, 2, 3]) for (const key of BRIEF_PRIORITY) {
      const previous = fills.get(key);
      if (previous && !previous.omitted) continue;
      const available = remaining + (previous?.bytes ?? 0);
      const fill = fitSection(key, entries[key], Math.min(BRIEF_SECTION_CAPS[key] * pass, available), renderers(key));
      remaining = available - fill.bytes;
      fills.set(key, fill);
    }
  }

  const section = (key: BriefSectionKey, heading: string, empty: string) => {
    const fill = fills.get(key)!;
    const count = fill.omitted ? `${fill.total - fill.omitted} of ${fill.total}` : String(fill.total);
    return [``, `## ${heading} (${count})`, fill.lines.length ? fill.lines.join("\n") : empty];
  };

  const out: string[] = [...head];
  for (const key of ["conflicts", "warnings"] as const) out.push(...fills.get(key)!.lines);
  out.push(rules);
  out.push(...section("definitions", headings.definitions,
    authorityWarnings.size || conflicts.size ? "_no single applicable accepted definition; review the authority warnings before computing a metric_" : "_none yet — record one before computing any metric_"));
  out.push(...section("decisions", headings.decisions, "_none_"));
  out.push(...section("changes", headings.changes, "_none_"));
  out.push(...section("findings", headings.findings, "_none_"));
  if (drafts.length) {
    out.push(...section("drafts", headings.drafts, "_none shown; see `ledger drafts`_"));
    out.push(draftsFooter);
  }

  const drops: BriefDrop[] = BRIEF_PRIORITY.flatMap((key) => {
    const fill = fills.get(key)!;
    return fill.omitted ? [{ section: key, omitted: fill.omitted, of: fill.total }] : [];
  });
  out.push(``, ...tailLines(budgeted ? budget : null, drops));

  const text = out.join("\n");
  return {
    text,
    bytes: Buffer.byteLength(text),
    budget_bytes: budgeted ? budget : null,
    record_ids: BRIEF_PRIORITY.flatMap((key) => fills.get(key)!.ids),
    drops,
    truncated: drops.length > 0,
  };
}

export function brief(cfg: Config, opts: BriefOpts = {}): string {
  return briefReport(cfg, opts).text;
}

export interface PayloadPart {
  name: string;
  text: string;
  /** Ceiling in bytes; unspent bytes flow to the parts after it. */
  cap?: number;
  /** Printed when this part is trimmed, so a reader can retrieve the rest. */
  more?: string;
}
export interface BudgetedPayload {
  text: string;
  bytes: number;
  dropped: { name: string; omitted_lines: number; omitted_bytes: number }[];
}

/**
 * Assemble a hook payload under a hard ceiling, in the order given. Whole lines only, and a trimmed
 * part says how much it lost and where the rest is: the failure this replaces was a harness cut that
 * announced nothing, so a silent trim here would reproduce the bug one layer down.
 */
export function budgetPayload(parts: PayloadPart[], totalBytes: number): BudgetedPayload {
  const kept: string[] = [];
  const dropped: BudgetedPayload["dropped"] = [];
  let remaining = totalBytes;
  for (const part of parts) {
    const text = part.text?.trim();
    if (!text) continue;
    const separator = kept.length ? 2 : 0; // the blank line that joins parts
    const allowance = Math.min(part.cap ?? Infinity, remaining) - separator;
    const lines = text.split("\n");
    const size = (s: string) => Buffer.byteLength(s) + 1;
    const whole = lines.reduce((n, l) => n + size(l), 0);
    if (whole <= allowance) { kept.push(text); remaining -= whole + separator; continue; }
    const notice = (omitted: number, bytes: number) => `_${omitted} further line(s), ${bytes} bytes, omitted from ${part.name} to fit the session-start byte budget${part.more ? `: ${part.more}` : ""}._`;
    const reserve = size(notice(lines.length, whole));
    const out: string[] = [];
    let used = 0;
    for (const line of lines) {
      if (used + size(line) + reserve > allowance) break;
      out.push(line); used += size(line);
    }
    const omittedLines = lines.length - out.length;
    const omittedBytes = whole - used;
    if (used + reserve <= allowance) out.push(notice(omittedLines, omittedBytes));
    dropped.push({ name: part.name, omitted_lines: omittedLines, omitted_bytes: omittedBytes });
    if (out.length) { kept.push(out.join("\n")); remaining -= used + reserve + separator; }
  }
  const text = kept.join("\n\n");
  return { text, bytes: Buffer.byteLength(text), dropped };
}

// ---------- stats: the thing you measure the pilot with ----------

export function stats(cfg: Config, days = 14): string {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const all = loadAll(cfg);
  const recent = all.filter((o) => o.created >= since);
  const count = (t: LedgerType) => recent.filter((o) => o.type === t).length;
  const authors = new Map<string, number>();
  for (const o of recent) authors.set(o.author, (authors.get(o.author) ?? 0) + 1);

  // near-duplicate findings: same question asked twice within the window. IDF over every finding
  // ever recorded, so a word's weight does not swing with what happened to be asked this fortnight.
  const findings = recent.filter((o) => o.type === "finding");
  const idf = idfOver(all.filter((o) => o.type === "finding").map(claimText));
  const dupes: string[] = [];
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      const a = findings[i], b = findings[j];
      if (a.author === b.author) continue;
      if (scopesConflict(a.fields.analysis_scope, b.fields.analysis_scope)) continue;
      const similarity = questionSimilarity(claimText(a), claimText(b), idf);
      if (similarity >= NEAR_DUPLICATE) {
        dupes.push(`  ${a.id} (${a.author}) ~ ${b.id} (${b.author})  [question similarity ${similarity.toFixed(2)}]`);
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
  const proposals = all.filter((o) => o.fields.capture_method === "query_grain_proposal");
  return [
    `  transcript fallback: drafts created ${made.length} (window), pending review ${pending.length}, promoted ${promoted.length}, discarded ${discarded.length} (all time)`,
    `  query-grain proposals: pending ${proposals.filter((o) => o.status === "draft").length}, accepted ${proposals.filter((o) => o.superseded_by).length}, discarded cuts ${proposals.filter((o) => o.fields.stance === "discarded").length} (all time)`,
  ];
}
