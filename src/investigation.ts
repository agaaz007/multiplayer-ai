import { loadAll, type Config } from './store.js';
import { TYPES, type LedgerObject } from './schema.js';
import { score, renderFull, matchesDiscoveryScope } from './query.js';
import { matchesAnalysisScope, objectVersion, resolveAccepted, correctionImpact, type ScopeQuery } from './authority.js';

export interface InvestigationOptions {
  question: string;
  scope?: ScopeQuery;
  definition_ids?: string[];
  as_of?: string;
  limit?: number;
}

/** Task context is derived from exact accepted lineages, independently of the recent brief. */
export function analyticalContext(objects: LedgerObject[], opts: InvestigationOptions) {
  const byId = new Map(objects.map(o => [o.id, o]));
  const requested = new Set(opts.definition_ids ?? []);
  const relevant = objects.filter(o => matchesDiscoveryScope(o, opts.scope));
  const hits = relevant.map(o => ({o, score: requested.has(o.id) ? Number.MAX_SAFE_INTEGER : score(opts.question, o)}))
    .filter(h => h.score > 0).sort((a,b) => b.score-a.score || a.o.id.localeCompare(b.o.id));
  const warnings: string[] = [];
  if (!opts.scope || !Object.keys(opts.scope).length) warnings.push('Analytical scope was not supplied. These are candidates, not a determination that their populations or definitions match the task.');
  for (const id of requested) if (!byId.has(id) || !matchesDiscoveryScope(byId.get(id)!, opts.scope)) warnings.push(`Requested definition unavailable or outside the supplied analytical scope: ${id}`);
  const contexts = new Map<string, ReturnType<typeof resolveAccepted>>();
  // Mandatory definitions and explicit IDs cannot lose their budget to repeated versions/drafts.
  const pinned = relevant.filter(o=>o.type==='definition' && opts.scope?.metric && o.fields.metric===opts.scope.metric).map(o=>o.id);
  const families = new Map<string,string>();
  for (const hit of hits) {
    const family = resolveAccepted(objects,hit.o.id,{asOf:opts.as_of,scope:opts.scope}).history.map(o=>o.id).sort().join('|') || hit.o.id;
    if (!families.has(family)) families.set(family,hit.o.id);
  }
  const cap = Math.max(1, Math.min(opts.limit ?? 10, 50));
  const queue = [...new Set([...requested,...pinned,...[...families.values()].slice(0,cap)])];
  if (families.size>cap) warnings.push(`${families.size-cap} additional matching source families omitted by the relevance limit; increase limit or narrow scope. Mandatory metric definitions and requested IDs are retained.`);
  const selected = new Map<string, LedgerObject>();
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const o = byId.get(id);
    if (!o) { warnings.push(`Missing linked source: ${id}`); continue; }
    if (!matchesDiscoveryScope(o, opts.scope)) { warnings.push(`Linked source does not establish requested scope: ${id}`); continue; }
    const r = resolveAccepted(objects, id, {asOf: opts.as_of, scope: opts.scope});
    const family = [...r.history.map(h=>h.id)].sort().join('|') || id;
    contexts.set(family, r);
    for (const source of r.history) {
      selected.set(source.id, source);
      for (const ref of (source.fields.dependencies as {id:string;version:string}[] | undefined) ?? []) {
        const target = byId.get(ref.id);
        if (!target || objectVersion(target) !== ref.version) warnings.push(`${source.id}: missing or changed dependency ${ref.id}`);
        else queue.push(ref.id);
      }
    }
    warnings.push(...r.warnings);
  }
  const resolutions = [...contexts.values()];
  const current = [...new Map(resolutions.flatMap(r=>r.current).map(o=>[o.id,o])).values()];
  const corrections = current.filter(o=>o.supersedes);
  const impacts = corrections.map(o=>correctionImpact(objects,o.id));
  const affected = new Map<string, (typeof impacts)[number]['affected'][number]>();
  for (const impact of impacts) for (const item of impact.affected) {
    const source = byId.get(item.id);
    // Applicability selects the correction. Exact downstream dependencies can cross
    // metrics/populations or feed unscoped decisions, and still require review.
    if (source) { affected.set(item.id,item); selected.set(source.id,source); }
  }
  const unresolved_scope = opts.scope ? objects.filter(o=>!o.fields.analysis_scope && score(opts.question,o)>0).map(o=>o.id) : [];
  if (unresolved_scope.length) warnings.push(`${unresolved_scope.length} legacy matching records lack analytical scope; they are not silently used as current task authority.`);
  const renderObject = (o: LedgerObject) => `${renderFull(o)}\n**content_version**: ${objectVersion(o)}`;
  const text = [
    `# Analytical continuation: ${opts.question}`,
    `Scope: ${JSON.stringify(opts.scope ?? null)}. Scope describes applicability, not access control.`,
    `Accepted does not mean independently proven true. Validate the query and supporting evidence before accepting a correction.`,
    ...warnings.map(w=>`WARNING: ${w}`),
    ...resolutions.filter(r=>r.status==='conflict').map(r=>`UNRESOLVED ACCEPTED CONFLICT: ${r.current.map(o=>o.id).join(', ')}. Do not choose by recency.`),
    `## Applicable accepted sources without a known correction review flag`, ...current.filter(o=>!affected.has(o.id)).map(renderObject),
    `## Accepted results requiring review before reuse`, ...current.filter(o=>affected.has(o.id)).map(o=>`NEEDS REVIEW: ${o.id}\n${renderObject(o)}`),
    `## Original evidence and correction history`, ...[...selected.values()].filter(o=>!current.some(c=>c.id===o.id)).map(renderObject),
    `## Proposals, not accepted`, ...[...new Map(resolutions.flatMap(r=>r.proposals).map(o=>[o.id,o])).values()].map(renderObject),
    `## Results requiring review`, ...[...affected.values()].map(a=>`${a.id}: ${a.status}; ${a.reason}; path ${a.path.join(' -> ')}; downstream scope: ${JSON.stringify(byId.get(a.id)?.fields.analysis_scope ?? 'unknown')}`),
    ...impacts.flatMap(i=>i.incomplete.map(x=>`INCOMPLETE IMPACT: ${x.id}: ${x.reason}`)),
    `A review flag does not prove a result false. Recompute or explicitly revalidate it with evidence.`,
    `Artifact references are references only: fetch and hash-check them before claiming restoration or executing a saved query.`,
    `Preserve unresolved capture, missing lineage and pending operations. Save the new result against exact definition and query versions.`,
  ].join('\n\n');
  return {question:opts.question, scope:opts.scope ?? null, resolutions, current, impacts, affected:[...affected.values()], unresolved_scope, warnings:[...new Set(warnings)], objects:[...selected.values()], text};
}

export function investigation(cfg: Config, opts: InvestigationOptions) { return analyticalContext(loadAll(cfg,TYPES), opts); }
