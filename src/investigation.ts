import { loadAll, type Config } from './store.js';
import { TYPES, type LedgerObject } from './schema.js';
import { score, renderFull, matchesDiscoveryScope, claimText, idfOver, questionSimilarity, NEAR_DUPLICATE, legacyScopeGaps, objectAuthority, tokens } from './query.js';
import { matchesAnalysisScope, objectVersion, resolveAccepted, correctionImpact, dependents, sameAnalyticalScope, snapshotIdentity, snapshotsDiffer, verification, type ScopeQuery } from './authority.js';

export interface InvestigationOptions {
  question: string;
  scope?: ScopeQuery;
  definition_ids?: string[];
  as_of?: string;
  limit?: number;
  candidate_limit?: number;
}

/** Task context is derived from exact accepted lineages, independently of the recent brief. */
export function analyticalContext(objects: LedgerObject[], opts: InvestigationOptions) {
  if (!opts.question.trim()) throw new Error('investigation question must not be empty');
  for (const value of [opts.limit, opts.candidate_limit]) if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 50)) throw new Error('investigation limits must be integers between 1 and 50');
  const byId = new Map(objects.map(o => [o.id, o]));
  const requested = new Set(opts.definition_ids ?? []);
  const relevant = objects.filter(o => matchesDiscoveryScope(o, opts.scope) && !legacyScopeGaps(o, opts.scope));
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
    if (!matchesDiscoveryScope(o, opts.scope) || legacyScopeGaps(o, opts.scope)) { warnings.push(`Linked source does not establish requested scope: ${id}`); continue; }
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
  const candidates = objects.map(o => ({o, gaps: legacyScopeGaps(o, opts.scope), relevance: score(opts.question,o)}))
    .filter(h => h.gaps && h.relevance > 0)
    .sort((a,b) => b.relevance - a.relevance || a.o.id.localeCompare(b.o.id));
  const legacy_candidates = candidates.slice(0,opts.candidate_limit ?? 5).map(({o,gaps,relevance}) => {
    // Resolve without the requested scope to preserve lifecycle/conflict labels, not applicability.
    const authority = resolveAccepted(objects,o.id,{asOf:opts.as_of});
    const lifecycle = objectAuthority(o,authority);
    const matched = [...new Set(tokens(opts.question))].filter(t => tokens([o.title,o.body,JSON.stringify(o.fields)].join(' ')).includes(t));
    return {id:o.id, content_version:objectVersion(o), title:o.title, author:o.author, type:o.type, status:o.status,
      authority_label:authority.status === 'conflict' ? 'unresolved accepted conflict' : lifecycle.label,
      authority_status:authority.status, authority_warnings:authority.warnings,
      supersedes:o.supersedes, superseded_by:o.superseded_by,
      excerpt:String(o.fields.result ?? o.fields.formula ?? o.fields.decision ?? o.fields.what ?? o.body).slice(0,600),
      scope_status:'unknown' as const, scope_gaps:gaps!, scope_known:o.fields.analysis_scope ?? null,
      reason_matched:`Lexical match: ${matched.join(', ')}; analytical applicability not established`, score:relevance,
      next_action:{tool:'ledger_get',arguments:{id:o.id}},
      warning:'Candidate only. Open the original evidence and validate scope, correction history and lineage before reuse; this is not applicable authority.'};
  });
  const unresolved_scope = candidates.map(h=>h.o.id);
  if (unresolved_scope.length) warnings.push(`${unresolved_scope.length} matching records lack complete analytical scope; ${legacy_candidates.length} candidate(s) shown separately, never silently used as current task authority.`);
  const discovery_status = legacy_candidates.length ? 'candidates_available' : current.length ? 'applicable_records' : selected.size ? 'no_applicable_records' : 'no_matches';


  // Competition is computed through the supersession DAG, so two same-scope claims nobody linked are two
  // separate lineages and neither side is flagged. This is the same comparison the write path nudges
  // about (similarFindings), run where honouring the nudge is no longer the second author's option.
  const lineage = new Map<string,string>();
  for (const [family, r] of contexts) for (const o of r.history) lineage.set(o.id, family);
  const sameWindow = (a: LedgerObject, b: LedgerObject) => {
    const [x,y] = [a.fields.data_window as {from:string;to:string}|undefined, b.fields.data_window as {from:string;to:string}|undefined];
    return Boolean(x && y && x.from.slice(0,10)===y.from.slice(0,10) && x.to.slice(0,10)===y.to.slice(0,10));
  };
  const claims = current.filter(o=>o.type==='finding');
  const idf = idfOver(objects.filter(o=>o.type==='finding').map(claimText));
  // Grouped, not pairwise: five mutually competing claims are one question for a person to settle,
  // and emitting ten pair warnings would spend the successor's context saying it ten times.
  const parent = new Map<string,string>();
  const find = (id: string): string => { const p = parent.get(id); return !p || p===id ? id : (parent.set(id,find(p)), parent.get(id)!); };
  for (const o of claims) parent.set(o.id,o.id);
  const rereads = new Set<string>();
  for (let i=0;i<claims.length;i++) for (let j=i+1;j<claims.length;j++) {
    const [a,b] = [claims[i],claims[j]];
    if (lineage.get(a.id) && lineage.get(a.id)===lineage.get(b.id)) continue;
    if (!sameAnalyticalScope(a,b) || !sameWindow(a,b)) continue;
    if (questionSimilarity(claimText(a), claimText(b), idf) < NEAR_DUPLICATE) continue;
    if (snapshotsDiffer(a,b)) { rereads.add(a.id); rereads.add(b.id); }
    parent.set(find(a.id), find(b.id));
  }
  const groups = new Map<string,LedgerObject[]>();
  for (const o of claims) { const root = find(o.id); if (!groups.has(root)) groups.set(root,[]); groups.get(root)!.push(o); }
  const unlinked = [...groups.values()].filter(g=>g.length>1).map(g=>{
    const window = g[0].fields.data_window as {from:string;to:string};
    const reread = g.filter(o=>rereads.has(o.id));
    return { ids: g.map(o=>o.id),
      reason: `identical analytical scope, window ${window.from.slice(0,10)}→${window.to.slice(0,10)} and question, with no supersession relation between them`
        + (reread.length ? `; ${reread.map(o=>`${o.id} read snapshot ${snapshotIdentity(o)}`).join(', ')}, so some of this may be a re-read of changed source data rather than a disagreement` : '') };
  });
  for (const u of unlinked) warnings.push(`possibly competing, unlinked: ${u.ids.join(', ')} — ${u.reason}. None of them deprecates another, so all are returned; compare them and either link one with supersedes or record why each stands.`);

  const verified = new Map<string, ReturnType<typeof verification>>();
  for (const o of current) if (o.type==='finding') verified.set(o.id, verification(objects,o));
  const renderObject = (o: LedgerObject) => {
    const v = verified.get(o.id);
    const line = v ? `\n**verification**: ${v.status}${v.notes.length ? ` — ${v.notes.join('; ')}` : ''}` : '';
    return `${renderFull(o)}\n**content_version**: ${objectVersion(o)}${line}`;
  };
  // Three states the old shape collapsed into one list: reproduced at this exact version, accepted but
  // never re-run, and accepted-but-flagged. Accepted is a review assertion; reproduced is a re-run.
  const applicable = current.filter(o=>!affected.has(o.id));
  const reproduced = applicable.filter(o=>verified.get(o.id)?.status==='reproduced');
  const contested = applicable.filter(o=>verified.get(o.id)?.status==='contested');
  const unproven = applicable.filter(o=>!reproduced.includes(o) && !contested.includes(o));

  // Only interrupt a person when the ambiguity changes what happens next: an unresolved disagreement
  // that nothing pins is a question that can stay open, and this says which kind each one is.
  const list = (ids: string[]) => ids.length > 1 ? `${ids.slice(0,-1).join(', ')} and ${ids.at(-1)}` : ids.join('');
  const blastRadius = (ids: string[]) => {
    const pinned = [...new Set(ids.flatMap(id=>dependents(objects,id)))];
    return pinned.length
      ? `${pinned.length} recorded result(s) pin one of these (${pinned.slice(0,5).join(', ')}${pinned.length>5 ? ', …' : ''}); resolve before reusing them.`
      : `No recorded work pins any of them; this can stay open until someone needs it.`;
  };
  const next: string[] = [
    ...resolutions.filter(r=>r.status==='conflict').map(r=>`Resolve the competing accepted claims ${list(r.current.map(o=>o.id))}: compare analytical scope, data snapshot and evidence, then supersede one or record why both stand. Do not choose by recency. ${blastRadius(r.current.map(o=>o.id))}`),
    ...unlinked.map(u=>`Compare ${list(u.ids)} — ${u.reason}. ${blastRadius(u.ids)}`),
    ...[...affected.values()].map(a=>`Revalidate or recompute ${a.id}: ${a.reason}.`),
    ...contested.map(o=>`Settle the failed reproduction of ${o.id}: ${verified.get(o.id)!.notes.join('; ')}.`),
    ...unproven.filter(o=>o.type==='finding' && (o.fields.query || (o.fields.reproduce as {query_or_artifact?:string}|undefined)?.query_or_artifact))
      .map(o=>`Reproduce ${o.id} by re-running its recorded query, then record the outcome as a finding with reproduction_of {id, version: ${objectVersion(o)}}.`),
    ...current.filter(o=>o.type==='decision' && o.fields.confirmation).map(o=>{
      const c = o.fields.confirmation as {metric?:string;success_condition?:string;evaluate_after?:string} | string;
      return `Evaluate decision ${o.id}: ${typeof c==='string' ? c : `${c.metric} ${c.success_condition}${c.evaluate_after ? `, after ${c.evaluate_after}` : ''}`}.`;
    }),
  ];

  // An empty heading is a line the successor pays for and learns nothing from.
  const section = (heading: string, lines: string[]) => lines.length ? [heading, ...lines] : [];
  const text = [
    `# Analytical continuation: ${opts.question}`,
    `Scope: ${JSON.stringify(opts.scope ?? null)}. Scope describes applicability, not access control.`,
    `Accepted does not mean independently proven true; it means a person asserted a review against pinned evidence. Reproduced means someone re-ran the recorded recipe and got the same answer. Validate the query and supporting evidence before accepting a correction.`,
    ...warnings.map(w=>`WARNING: ${w}`),
    ...resolutions.filter(r=>r.status==='conflict').map(r=>`UNRESOLVED ACCEPTED CONFLICT: ${r.current.map(o=>o.id).join(', ')}. Do not choose by recency.`),
    ...section(`## Verified: reproduced at this exact content_version`, reproduced.map(renderObject)),
    `## Accepted, not independently reproduced`, ...(unproven.length ? unproven.map(renderObject) : ['_none_']),
    ...section(`## Contested: a reproduction at this version did not match`, contested.map(o=>`CONTESTED: ${o.id}\n${renderObject(o)}`)),
    ...section(`## Uncertain: accepted results requiring review before reuse`, current.filter(o=>affected.has(o.id)).map(o=>`NEEDS REVIEW: ${o.id}\n${renderObject(o)}`)),
    ...section(`## Original evidence and correction history`, [...selected.values()].filter(o=>!current.some(c=>c.id===o.id)).map(renderObject)),
    ...section(`## Legacy candidates — scope unknown, not applicable authority`, legacy_candidates.map(c=>
      `${c.id} (${c.author}; ${c.status}; ${c.authority_label})\n${c.title}\n${c.excerpt}\ncontent_version: ${c.content_version}\nMissing scope: ${c.scope_gaps.join(', ')}. ${c.reason_matched}.\n${c.warning} Open with ledger_get({id: "${c.id}"}).${c.authority_warnings.length ? `\n${c.authority_warnings.join('; ')}` : ''}`)),
    ...section(`## Proposals, not accepted`, [...new Map(resolutions.flatMap(r=>r.proposals).map(o=>[o.id,o])).values()].map(renderObject)),
    ...section(`## Results requiring review`, [...affected.values()].map(a=>`${a.id}: ${a.status}; ${a.reason}; path ${a.path.join(' -> ')}; downstream scope: ${JSON.stringify(byId.get(a.id)?.fields.analysis_scope ?? 'unknown')}`)),
    ...impacts.flatMap(i=>i.incomplete.map(x=>`INCOMPLETE IMPACT: ${x.id}: ${x.reason}`)),
    `## Next check`, ...(next.length ? next.map(n=>`- ${n}`) : ['- No outstanding check is derivable from the retrieved lineage.']),
    `A review flag does not prove a result false. Recompute or explicitly revalidate it with evidence.`,
    `Artifact references are references only: fetch and hash-check them before claiming restoration or executing a saved query.`,
    `Preserve unresolved capture, missing lineage and pending operations. Save the new result against exact definition and query versions.`,
  ].join('\n\n');
  return {availability:'available' as const, discovery_status, legacy_candidates, question:opts.question, scope:opts.scope ?? null, resolutions, current, impacts, affected:[...affected.values()], unlinked, verification:Object.fromEntries(verified), next_checks:next, unresolved_scope, warnings:[...new Set(warnings)], objects:[...selected.values()], text};
}

export function investigation(cfg: Config, opts: InvestigationOptions) { return analyticalContext(loadAll(cfg,TYPES), opts); }
