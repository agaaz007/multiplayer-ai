import { type Config, loadAll } from "./store.js";
import { TYPES, type LedgerObject, type LedgerType } from "./schema.js";
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

export interface BriefOpts {
  days?: number;
  tags?: string[];
  /** Optional packaged guide supplied by an embedding host; installed-guide default is unchanged. */
  guidePath?: string;
  scope?: ScopeQuery;
}

/**
 * The thing injected at session start. Deliberately small:
 * all active definitions + last N days of findings/changes/decisions.
 */
export function brief(cfg: Config, opts: BriefOpts = {}): string {
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

  const out: string[] = [];
  out.push(`# Ledger brief (${new Date().toISOString().slice(0, 10)}, last ${days} days)`);
  out.push(``);
  out.push(`This brief is an activity summary, not exhaustive task context. Use ledger_investigation with the question and analytical scope before reusing a result; it resolves accepted corrections across full history.`);
  for (const conflict of conflicts.values()) out.push(`UNRESOLVED ACCEPTED CONFLICT: ${conflict.current.map(c => `${c.id} (${c.title})`).join("; ")}. No single source is authoritative; inspect the evidence and explicitly resolve. The recent-list limit does not resolve this conflict.`);
  for(const warning of authorityWarnings) out.push(`WARNING: ${warning}`);
  out.push(`Rules: use these definitions verbatim when computing metrics. Before running an analysis, call ledger_search with the question — if a matching finding exists, reuse or explicitly refresh it. Before attributing a change in a metric, check changes below. After any analysis, decision, or ship, record it: a finding needs inputs, method, and assumptions (explicit and implicit); a decision needs context and the options that lost. Full format in ${opts.guidePath ? `\`${opts.guidePath}\`` : "~/.claude/ledger.md"}.`);
  out.push(``);
  out.push(`## Definitions (${defs.length})`);
  out.push(defs.length ? defs.map(short).join("\n") : authorityWarnings.size || conflicts.size ? "_no single applicable accepted definition; review the authority warnings before computing a metric_" : "_none yet — record one before computing any metric_");
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
  const drafts = source.filter((o) => o.status === "draft" && byTag(o) && matchesAnalysisScope(o, opts.scope));
  if (drafts.length) {
    const proposed = drafts.filter((o) => o.fields.stance === "PROPOSED");
    const fallback = drafts.filter((o) => o.fields.stance !== "PROPOSED" && o.fields.capture_method === "transcript_fallback");
    const manual = drafts.filter((o) => o.fields.stance !== "PROPOSED" && o.fields.capture_method !== "transcript_fallback");
    out.push(``, `## Drafts, not in force (${drafts.length})`);
    if (proposed.length) {
      out.push(`Query-grain findings proposed by an agent after a data pull (stance PROPOSED). Not law: a person accepts with ledger_review_finding(id, "accept") or discards with a reason; the next agent may reuse the result only as a proposal.`);
      for (const d of proposed.slice(0, 5)) out.push(`- [proposed] finding ${d.id}: **${d.title}** — investigation ${d.fields.investigation_record_id ?? "unbound"}, query ${d.fields.query_ref ?? "?"} (${d.author}, ${d.created.slice(0, 10)})`);
      if (proposed.length > 5) out.push(`- …and ${proposed.length - 5} more proposed findings: \`ledger drafts\``);
    }
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
