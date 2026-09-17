import { createHash } from "node:crypto";
import type { Acceptance, AnalysisScope, ClaimType, Correction, Dependency, EvidenceReference, LedgerObject, LedgerType, Reproduction } from "./schema.js";

/** Mutable lifecycle metadata is deliberately absent: superseding a record cannot change its evidence version. */
export function objectVersion(o: LedgerObject): string {
  return createHash("sha256").update(canonical({ id: o.id, type: o.type, created: o.created, title: o.title,
    author: o.author, description: o.description, tags: o.tags, supersedes: o.supersedes ?? null,
    body: o.body, fields: o.fields })).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Scope identity ignoring the window: two results over different windows still measure the same thing. */
export function scopeIdentity(value: unknown): string {
  if (!value || typeof value !== "object") return canonical(null);
  const { window: _window, ...identity } = value as Record<string, unknown>;
  return canonical(identity);
}

/**
 * Which source state a result was computed from. Scope says *what* was measured; this says *when the
 * source was read*. A warehouse with late-arriving events or a backfill can return two different
 * correct answers for one scope and window, and without this the read path reports that as a dispute.
 * Deliberately not part of scopeIdentity: a correction computed on a newer snapshot must still be
 * able to supersede the claim it corrects.
 */
export function snapshotIdentity(o: LedgerObject): string | null {
  const inputs = (o.fields.inputs as { snapshot_at?: string; snapshot_id?: string }[] | undefined) ?? [];
  const parts = inputs.flatMap((i) => [i.snapshot_id, i.snapshot_at]).filter((v): v is string => Boolean(v));
  return parts.length ? [...new Set(parts)].sort().join("|") : null;
}

/** Unknown on either side is neither agreement nor disagreement, so it does not claim a re-read. */
export function snapshotsDiffer(a: LedgerObject, b: LedgerObject): boolean {
  const [x, y] = [snapshotIdentity(a), snapshotIdentity(b)];
  return Boolean(x && y && x !== y);
}

export type ScopeQuery = Partial<AnalysisScope>;
export function matchesAnalysisScope(o: LedgerObject, scope?: ScopeQuery): boolean {
  if (!scope || !Object.keys(scope).length) return true;
  const actual = o.fields.analysis_scope as AnalysisScope | undefined;
  if (!actual) return false;
  if (!Object.entries(scope).filter(([key]) => key !== "window").every(([key, v]) => canonical(actual[key as keyof AnalysisScope]) === canonical(v))) return false;
  if (!scope.window) return true;
  // An aggregate over a month is not the same claim as one over a week. Definitions may be broader.
  if (o.type === "finding") {
    const window = o.fields.data_window as { from: string; to: string } | undefined;
    if (!window || window.from.slice(0, 10) !== scope.window.from.slice(0, 10) || window.to.slice(0, 10) !== scope.window.to.slice(0, 10)) return false;
  }
  const c = o.fields.correction as Correction | undefined;
  const lower = [actual.window?.from, c?.effective_from].filter((v): v is string => Boolean(v)).sort().at(-1);
  const upper = [actual.window?.to, c?.effective_to].filter((v): v is string => Boolean(v)).sort()[0];
  return (!lower || scope.window.from.slice(0, 10) >= lower.slice(0, 10))
    && (!upper || scope.window.to.slice(0, 10) <= upper.slice(0, 10));
}

/** Two objects claim about the same thing when their scope identities match; window is applicability, not identity. */
export function sameAnalyticalScope(a: LedgerObject, b: LedgerObject): boolean {
  if (!a.fields.analysis_scope || !b.fields.analysis_scope) return false;
  return scopeIdentity(a.fields.analysis_scope) === scopeIdentity(b.fields.analysis_scope);
}

/**
 * Blast radius: the recorded work that pins this object by exact version. Zero dependents is how the
 * read path decides an unresolved disagreement does not yet need to interrupt a person.
 */
export function dependents(objects: LedgerObject[], id: string): string[] {
  return objects.filter((o) => o.id !== id && o.status !== "draft"
    && ((o.fields.dependencies as Dependency[] | undefined) ?? []).some((r) => r.id === id)).map((o) => o.id);
}

/** Which scope facets differ, so a mismatch names the field to change rather than the rule that was broken. */
function scopeDiff(a: unknown, b: unknown): string[] {
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const [x, y] = [obj(a), obj(b)];
  return [...new Set([...Object.keys(x), ...Object.keys(y)])]
    .filter((k) => k !== "window" && JSON.stringify(x[k] ?? null) !== JSON.stringify(y[k] ?? null))
    .map((k) => `${k}: ${JSON.stringify(x[k] ?? null)} → ${JSON.stringify(y[k] ?? null)}`);
}

function compatible(parent: LedgerObject, child: Pick<LedgerObject, "type" | "fields">): string | null {
  if (parent.type !== child.type) return `supersession must preserve object type: ${parent.id} is a ${parent.type}, this is a ${child.type}`;
  if (parent.type === "definition" && parent.fields.metric !== child.fields.metric)
    return `supersession must preserve metric identity: ${parent.id} defines ${JSON.stringify(parent.fields.metric)}, this defines ${JSON.stringify(child.fields.metric)}`;
  if (scopeIdentity(parent.fields.analysis_scope) !== scopeIdentity(child.fields.analysis_scope)) {
    const diff = scopeDiff(parent.fields.analysis_scope, child.fields.analysis_scope);
    return `supersession must preserve analytical scope; ${diff.length ? `these facets differ (predecessor → yours): ${diff.join("; ")}` : `${parent.id} has no analysis_scope, so a legacy migration must be explicit`}. Match the predecessor's analysis_scope, or record a new object instead of superseding.`;
  }
  return null;
}

function wasAccepted(o: LedgerObject): boolean {
  return o.status === "stable" || (o.status === "deprecated" && Boolean(o.superseded_by) && !o.fields.discarded
    && o.previous_status!=='draft' && o.fields.capture_method!=='transcript_fallback');
}

function effective(o: LedgerObject, asOf: string): boolean {
  const c = o.fields.correction as Correction | undefined;
  const window = o.type === "definition" ? (o.fields.analysis_scope as AnalysisScope | undefined)?.window : undefined;
  const day = asOf.slice(0, 10);
  return (!c?.effective_from || day >= c.effective_from.slice(0, 10))
    && (!c?.effective_to || day <= c.effective_to.slice(0, 10))
    && (!window?.from || day >= window.from.slice(0, 10))
    && (!window?.to || day <= window.to.slice(0, 10));
}

export interface AuthorityResolution {
  requested_id: string;
  status: "current" | "conflict" | "proposed" | "unavailable";
  current: LedgerObject[];
  history: LedgerObject[];
  proposals: LedgerObject[];
  warnings: string[];
  scope_status: "known" | "unknown";
}

/** Resolve a complete accepted family. No timestamp is used to choose between competing accepted successors. */
export function resolveAccepted(objects: LedgerObject[], id: string, opts: { asOf?: string; scope?: ScopeQuery } = {}): AuthorityResolution {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const requested = byId.get(id);
  const warnings: string[] = [];
  const empty = (status: AuthorityResolution["status"]): AuthorityResolution => ({ requested_id: id, status, current: [], history: [], proposals: [], warnings, scope_status: requested?.fields.analysis_scope ? "known" : "unknown" });
  if (!requested) { warnings.push(`missing object: ${id}`); return empty("unavailable"); }
  const taskWindow = requested.type === "definition" ? opts.scope?.window : undefined;
  const authorityScope = taskWindow && opts.scope ? Object.fromEntries(Object.entries(opts.scope).filter(([key]) => key !== "window")) as ScopeQuery : opts.scope;
  // A requested historical version can lead to a replacement with a different applicability interval.
  if (!matchesAnalysisScope(requested, authorityScope)) { warnings.push(`object does not establish requested analytical scope: ${id}`); return empty("unavailable"); }
  const edges = new Map<string, LedgerObject[]>();
  for (const o of objects) {
    if (!o.supersedes) continue;
    const p = byId.get(o.supersedes);
    if (!p || compatible(p, o)) continue;
    edges.set(p.id, [...(edges.get(p.id) ?? []), o]);
  }
  let root = requested;
  const ancestors = new Set<string>();
  while (root.supersedes) {
    if (ancestors.has(root.id)) { warnings.push(`cyclic supersession at ${root.id}`); return empty("unavailable"); }
    ancestors.add(root.id);
    const p = byId.get(root.supersedes);
    if (!p) { warnings.push(`missing predecessor: ${root.supersedes}`); break; }
    const issue = compatible(p, root);
    if (issue) { warnings.push(`${root.id}: ${issue}`); break; }
    root = p;
  }
  const family: LedgerObject[] = [];
  const seen = new Set<string>();
  const visit = (o: LedgerObject) => {
    if (seen.has(o.id)) { warnings.push(`cyclic supersession at ${o.id}`); return; }
    seen.add(o.id); family.push(o);
    for (const c of edges.get(o.id) ?? []) visit(c);
  };
  visit(root);
  const asOf = opts.asOf ?? opts.scope?.window?.to ?? new Date().toISOString();
  const currentAt = (date: string): LedgerObject[] => {
    const accepted = family.filter((o) => wasAccepted(o) && effective(o, date) && matchesAnalysisScope(o, authorityScope));
    const acceptedIds = new Set(accepted.map((o) => o.id));
    const hasAcceptedDescendant = (o: LedgerObject, chain = new Set<string>()): boolean => {
      if (chain.has(o.id)) return false;
      chain.add(o.id);
      return (edges.get(o.id) ?? []).some((child) => acceptedIds.has(child.id) || hasAcceptedDescendant(child, chain));
    };
    return accepted.filter((o) => !hasAcceptedDescendant(o));
  };
  let current = currentAt(asOf);
  let windowUnavailable = false;
  if (taskWindow) {
    const from = taskWindow.from.slice(0, 10), to = taskWindow.to.slice(0, 10);
    const dates = new Set([from, to]);
    // Authority is constant between these day boundaries. Endpoints alone miss a bounded correction inside a window.
    for (const o of family.filter(wasAccepted)) {
      const c = o.fields.correction as Correction | undefined;
      const window = (o.fields.analysis_scope as AnalysisScope | undefined)?.window;
      for (const start of [c?.effective_from, window?.from]) {
        const day = start?.slice(0, 10);
        if (day && day >= from && day <= to) dates.add(day);
      }
      for (const end of [c?.effective_to, window?.to]) {
        const day = end?.slice(0, 10);
        if (!day || day < from || day >= to) continue;
        dates.add(new Date(Date.parse(day + "T00:00:00.000Z") + 86_400_000).toISOString().slice(0, 10));
      }
    }
    const segments = [...dates].sort().map(date => ({ date, current: currentAt(date) }));
    const conflicts = segments.filter(segment => segment.current.length > 1);
    const uniform = segments.every(segment => segment.current.length === 1 && segment.current[0].id === segments[0].current[0]?.id);
    if (conflicts.length) {
      current = [...new Map(conflicts.flatMap(segment => segment.current).map(o => [o.id, o])).values()];
      warnings.push(`accepted definition conflict within requested window ${from}..${to} at ${conflicts.map(segment => segment.date).join(", ")}; review the competing versions before analysis`);
    } else if (!uniform) {
      current = [];
      windowUnavailable = true;
      warnings.push(`no single accepted definition applies throughout ${from}..${to}; split the analysis window or review missing applicability: ${segments.map(segment => `${segment.date}=${segment.current.map(o => o.id).join(",") || "unavailable"}`).join("; ")}`);
    } else current = segments[0].current;
  }
  if (wasAccepted(requested) && !effective(requested, asOf)) warnings.push(`${requested.id}: accepted but outside its effective interval at ${asOf.slice(0, 10)}`);
  const proposals = family.filter((o) => o.status === "draft");
  for (const o of family) {
    if (o.status === "deprecated" && o.superseded_by && !o.previous_status && !o.fields.capture_method && !o.fields.discarded)
      warnings.push(`${o.id}: legacy acceptance provenance is unknown; previous_status and capture metadata are absent, so any former-acceptance projection is an inference, not a verified acceptance`);
    if (o.superseded_by && byId.get(o.superseded_by)?.status === "draft") warnings.push(`${o.id}: legacy draft replacement does not remove accepted knowledge`);
    if (o.superseded_by && !byId.has(o.superseded_by)) warnings.push(`${o.id}: missing replacement ${o.superseded_by}`);
  }
  if (current.length > 1) {
    const pairs = current.flatMap((a, i) => current.slice(i + 1).map((b) => [a, b] as const));
    // Name the cheapest explanation before a person spends an hour adjudicating a dispute that is not one.
    const reread = pairs.filter(([a, b]) => snapshotsDiffer(a, b));
    const hint = reread.length
      ? ` These read different data snapshots (${[...new Set(current.map((o) => `${o.id}=${snapshotIdentity(o) ?? "unrecorded"}`))].join("; ")}), so this may be a re-read of changed source data rather than a disagreement; compare the snapshots before treating it as a dispute.`
      : current.some((o) => !snapshotIdentity(o))
        ? ` Data snapshots are unrecorded on ${current.filter((o) => !snapshotIdentity(o)).map((o) => o.id).join(", ")}, so a re-read of changed source data cannot be ruled out; record inputs[].snapshot_at to make that distinguishable.`
        : "";
    warnings.push(`competing accepted replacements: ${current.map((o) => o.id).join(", ")}; explicit resolution required.${hint}`);
  }
  if (!requested.fields.analysis_scope) warnings.push("analytical scope unknown (legacy record)");
  return { requested_id: id, status: current.length > 1 ? "conflict" : current.length ? "current" : windowUnavailable ? "unavailable" : proposals.length ? "proposed" : "unavailable",
    current, history: family, proposals, warnings, scope_status: requested.fields.analysis_scope ? "known" : "unknown" };
}

/** Project effective lifecycle for old readers/views without changing historical source records. */
export function projectAuthorityObjects(objects: LedgerObject[], opts: { asOf?: string; scope?: ScopeQuery } = {}): LedgerObject[] {
  return objects.map((o) => {
    if (!wasAccepted(o)) return o;
    const r = resolveAccepted(objects, o.id, opts);
    if (r.current.some((c) => c.id === o.id)) return { ...o, status: "stable" as const, superseded_by: undefined };
    if (r.current.length === 1) {
      let descendant: LedgerObject | undefined = r.current[0];
      const visited = new Set<string>();
      while (descendant?.supersedes && !visited.has(descendant.id)) {
        if (descendant.supersedes === o.id) return { ...o, status: "deprecated" as const, superseded_by: r.current[0].id };
        visited.add(descendant.id);
        descendant = objects.find(candidate => candidate.id === descendant!.supersedes);
      }
    }
    return { ...o, status: "deprecated" as const, superseded_by: undefined };
  });
}

/** Validate new exact lineage. Legacy friendly-name fields remain readable and are reported incomplete by impact. */
export function validateDependencies(objects: LedgerObject[], fields: Record<string, unknown>, type?: LedgerType): void {
  const byId = new Map(objects.map((o) => [o.id, o]));
  if(type==='finding' && (fields.status ?? 'stable')==='stable' && fields.analysis_scope) {
    const metric=(fields.analysis_scope as AnalysisScope).metric;
    const refs=(fields.dependencies as Dependency[] | undefined) ?? [];
    if(!refs.some(ref=>ref.relation==='uses-definition' && byId.get(ref.id)?.fields.metric===metric)) {
      // Name the repair, not just the rule: the definitions that define this metric are in hand here,
      // and without them the caller can only guess which id to attach.
      const candidates=objects.filter(o=>o.type==='definition' && o.fields.metric===metric && wasAccepted(o)).map(o=>o.id);
      const how=candidates.length
        ? `add dependencies: [{relation: "uses-definition", id: "${candidates[0]}", version: <its content_version>}]${candidates.length>1 ? ` (or one of ${candidates.slice(1,4).join(', ')})` : ''}`
        : `no accepted definition exists for metric ${JSON.stringify(metric)} yet: record one with ledger_record_definition first, or record this finding with status: "draft"`;
      throw new Error(`new stable scoped finding requires an exact uses-definition dependency for metric ${metric}. To fix: ${how}${candidates.length ? `. Get content_version from ledger_get(id)` : ""}.`);
    }
  }
  for (const ref of (fields.dependencies as Dependency[] | undefined) ?? []) {
    const target = byId.get(ref.id);
    if (!target) throw new Error(`dependency not found: ${ref.id}. Find the real id with ledger_search, or drop the dependency.`);
    if (!wasAccepted(target) && (fields.status ?? "stable") === "stable") throw new Error(`dependency is a draft or unaccepted historical evidence: ${ref.id}. Depend on an accepted object, or record this as status: "draft".`);
    if (ref.version !== objectVersion(target)) throw new Error(`dependency version mismatch: ${ref.id} is at content_version ${objectVersion(target)}, you passed ${ref.version || "nothing"}. Pass content_version (ledger_get, ledger_investigation), not the \`snapshot\` field of ledger_search — they are different hashes.`);
    if (ref.relation === "uses-definition" && target.type !== "definition") throw new Error(`uses-definition target must be a definition: ${ref.id} is a ${target.type}. Use relation "${target.type === "finding" ? "derived-from" : "based-on"}" instead.`);
    if (ref.relation === "derived-from" && target.type !== "finding") throw new Error(`derived-from target must be a finding: ${ref.id} is a ${target.type}. Use relation "${target.type === "definition" ? "uses-definition" : "based-on"}" instead.`);
    if (ref.relation === "uses-definition" && fields.analysis_scope && target.fields.analysis_scope
      && scopeIdentity(fields.analysis_scope) !== scopeIdentity(target.fields.analysis_scope))
      throw new Error(`definition dependency analytical scope mismatch: ${ref.id}. Facets that differ (definition → your finding): ${scopeDiff(target.fields.analysis_scope, fields.analysis_scope).join("; ") || "the definition has no analysis_scope"}.`);
    if (type === "finding" && (fields.status ?? "stable") === "stable" && ref.relation === "uses-definition") {
      const window = fields.data_window as { from: string; to: string } | undefined;
      const scope = fields.analysis_scope as AnalysisScope | undefined;
      const resolution = resolveAccepted(objects, ref.id, { asOf: window?.to,
        scope: scope || window ? { ...scope, ...(window ? { window } : {}) } : undefined });
      if (resolution.current.length !== 1 || resolution.current[0].id !== ref.id
        || (window && (!effective(target, window.from) || !effective(target, window.to))))
        throw new Error(`new stable finding must use the sole applicable accepted definition: ${ref.id}; reread the correction or save historical evidence as a draft`);
    }
  }
}

/**
 * Claim-shaped obligations. A measurement, a comparison and an explanation are falsified by different
 * evidence, so requiring one set of fields for all three lets a causal story inherit the standing of a
 * measured number. Each message names the field to add rather than the rule that was broken.
 */
export function validateClaim(objects: LedgerObject[], type: LedgerType, fields: Record<string, unknown>): void {
  if (type !== "finding") return;
  const refs = (fields.dependencies as Dependency[] | undefined) ?? [];
  const reproduction = fields.reproduction_of as Reproduction | undefined;
  if (reproduction) {
    const target = objects.find((o) => o.id === reproduction.id);
    if (!target) throw new Error(`reproduction_of target not found: ${reproduction.id}. Find the real id with ledger_search.`);
    if (target.type !== "finding") throw new Error(`reproduction_of target must be a finding: ${reproduction.id} is a ${target.type}.`);
    const actual = objectVersion(target);
    if (reproduction.version !== actual)
      throw new Error(`reproduction_of version mismatch: ${reproduction.id} is at content_version ${actual}, you passed ${reproduction.version || "nothing"}. Pin the version you actually re-ran; if the record changed under you, re-run against the current one.`);
    if (!refs.some((r) => r.relation === "derived-from" && r.id === reproduction.id && r.version === reproduction.version))
      throw new Error(`a reproduction must pin what it re-ran. To fix: add dependencies: [{relation: "derived-from", id: "${reproduction.id}", version: "${reproduction.version}"}].`);
  }
  const claim = fields.claim_type as ClaimType | undefined;
  if (!claim || (fields.status ?? "stable") !== "stable") return;
  const missing: string[] = [];
  if (claim === "measurement") {
    const recipe = fields.reproduce as { query_or_artifact?: string } | undefined;
    if (!String(fields.query ?? "").trim() && !recipe?.query_or_artifact)
      missing.push(`\`query\` with the exact query, MCP call or notebook cell (or \`reproduce.query_or_artifact\`) — a measurement is verified by re-running it, and nobody can re-run what was not recorded`);
  }
  if (claim === "comparison") {
    if (!String(fields.baseline ?? "").trim()) missing.push("`baseline` naming what the result is compared against");
    if (!String(fields.confidence_basis ?? "").trim())
      missing.push("`confidence_basis` stating sample sizes and how comparable the groups are — a comparison is verified by checking the groups and the uncertainty, not the headline");
  }
  if (claim === "explanation") {
    if (!String(fields.discriminating_test ?? "").trim())
      missing.push("`discriminating_test`: an observation that would come out one way if this explanation holds and another way if a rival does. The outcome being explained is consistent with every rival, so it cannot establish this one");
    if (!((fields.alternatives_considered as string[] | undefined) ?? []).some((a) => String(a).trim()))
      missing.push("at least one entry in `alternatives_considered`: the rival explanations for the same outcome, and why each is less likely");
    if (!refs.some((r) => r.relation === "derived-from"))
      missing.push("a `derived-from` dependency pinning the exact finding whose result this explains");
  }
  if (missing.length) throw new Error(`a ${claim} claim requires: ${missing.join("; ")}. Record it as status: "draft" if the supporting work is not done, or change claim_type if this is a different kind of claim.`);
}

export type VerificationStatus = "reproduced" | "contested" | "unreproduced";
export interface VerificationAttempt { id: string; actor: string; outcome: Reproduction["outcome"]; independent: boolean; at_current_version: boolean; note?: string }
export interface VerificationResult { status: VerificationStatus; attempts: VerificationAttempt[]; notes: string[] }

/**
 * The third tier the acceptance machinery does not provide: accepted means a person asserted a review
 * with pinned evidence; reproduced means someone re-ran the recorded recipe and got the same answer.
 * An attempt against an earlier content_version never counts for the current one.
 */
export function verification(objects: LedgerObject[], target: LedgerObject): VerificationResult {
  const version = objectVersion(target);
  const attempts: VerificationAttempt[] = [];
  for (const o of objects) {
    const r = o.fields.reproduction_of as Reproduction | undefined;
    if (!r || r.id !== target.id || !wasAccepted(o)) continue;
    attempts.push({ id: o.id, actor: o.author, outcome: r.outcome, independent: o.author !== target.author, at_current_version: r.version === version, note: r.note });
  }
  const live = attempts.filter((a) => a.at_current_version);
  const status: VerificationStatus = live.some((a) => a.outcome === "differed") ? "contested"
    : live.some((a) => a.outcome === "matched") ? "reproduced" : "unreproduced";
  const notes: string[] = [];
  if (status === "reproduced" && !live.some((a) => a.outcome === "matched" && a.independent))
    notes.push(`reproduced only by ${target.author}, who recorded it; not an independent reproduction`);
  if (status === "contested") notes.push(`a reproduction at this exact version did not match: ${live.filter((a) => a.outcome === "differed").map((a) => `${a.id} (${a.actor})${a.note ? ` — ${a.note}` : ""}`).join("; ")}`);
  if (status === "unreproduced" && attempts.length && !live.length)
    notes.push(`${attempts.length} reproduction attempt(s) target an earlier content_version of this record and do not carry over`);
  if (live.some((a) => a.outcome === "could_not_run"))
    notes.push(`a reproduction could not be run: ${live.filter((a) => a.outcome === "could_not_run").map((a) => `${a.id}${a.note ? ` — ${a.note}` : ""}`).join("; ")}`);
  return { status, attempts, notes };
}

/** Local knowledge evidence is verifiable here; artifact IDs require the host's artifact store validation. */
export function validateEvidenceReferences(objects: LedgerObject[], fields: Record<string, unknown>): void {
  const refs = [...((fields.evidence_refs as EvidenceReference[] | undefined) ?? []),
    ...((fields.acceptance as Acceptance | undefined)?.evidence_refs ?? [])];
  for (const ref of refs) {
    if (!ref.artifact_id) continue;
    const target = objects.find((o) => o.id === ref.artifact_id);
    if (!target && /^(def|fnd|dec|chg)-/.test(ref.artifact_id)) throw new Error(`knowledge evidence not found: ${ref.artifact_id}`);
    if (target && objectVersion(target) !== ref.sha256) throw new Error(`knowledge evidence version mismatch: ${ref.artifact_id}`);
  }
}

/** Called under the local store write lock, after pulling. Remote forks are detected by resolveAccepted after sync. */
export function validateSupersession(objects: LedgerObject[], type: LedgerType, fields: Record<string, unknown>, actor: string): LedgerObject | null {
  const id = fields.supersedes;
  if (!id) return null;
  const old = objects.find((o) => o.id === id);
  if (!old) throw new Error(`supersession target not found: ${id}`);
  const issue = compatible(old, { type, fields });
  if (issue) throw new Error(issue);
  const checked = new Set<string>();
  let node: LedgerObject | undefined = old;
  while (node) {
    if (checked.has(node.id)) throw new Error(`cyclic supersession: ${node.id}`);
    checked.add(node.id);
    node = node.supersedes ? objects.find((o) => o.id === node!.supersedes) : undefined;
  }
  if ((fields.status ?? "stable") !== "stable") return old;
  const acceptance = fields.acceptance as Acceptance | undefined;
  if (acceptance && acceptance.actor !== actor) throw new Error("acceptance.actor must match configured Ledger author");
  // Promoting a previously unaccepted draft preserves the existing full-schema promotion workflow.
  if (old.status === "draft") {
    if (old.supersedes) throw new Error("accept the original predecessor directly; a proposal cannot bypass predecessor review");
    return old;
  }
  if (!acceptance?.expected_predecessor) throw new Error("accepted replacement requires acceptance with evidence_refs and expected_predecessor id/version");
  if (acceptance.expected_predecessor.id !== old.id || acceptance.expected_predecessor.version !== objectVersion(old))
    throw new Error("accepted replacement predecessor/version mismatch; reread the current record before accepting");
  const scope = old.fields.analysis_scope as AnalysisScope | undefined;
  const correction = old.fields.correction as Correction | undefined;
  // Historical claims can be corrected after their applicability expires. Validate the predecessor where it applied.
  const from = [scope?.window?.from, correction?.effective_from].filter((v): v is string => Boolean(v)).sort().at(-1);
  const to = [scope?.window?.to, correction?.effective_to].filter((v): v is string => Boolean(v)).sort()[0];
  if (from && to && from.slice(0, 10) > to.slice(0, 10)) throw new Error("supersession predecessor has no valid applicability interval; review its scope and correction bounds");
  const resolution = resolveAccepted(objects, old.id, {
    asOf: to ?? from,
    scope: from && to ? { ...scope, window: { from, to } } : scope,
  });
  if (resolution.current.length !== 1 || resolution.current[0].id !== old.id)
    throw new Error("supersession target is no longer the sole accepted predecessor; reread and resolve the conflict");
  // Even a future-effective accepted successor reserves the predecessor against another ordinary acceptance.
  if (objects.some((o) => o.supersedes === old.id && wasAccepted(o)))
    throw new Error("supersession target already has an accepted successor; explicit conflict resolution required");
  return old;
}

export interface ImpactResult {
  correction_id: string;
  accepted: boolean;
  effect: Correction["effect"] | "unspecified";
  affected: { id: string; status: "needs_review"; path: string[]; reason: string }[];
  excluded: { id: string; reason: string }[];
  incomplete: { id: string; reason: string }[];
  complete: boolean;
  /** Whether this correction changes what anyone does next. Nothing downstream means nobody needs interrupting. */
  interrupt: { required: boolean; reason: string };
}

/** Reverse traversal over exact versions; it identifies review obligations, never rewrites past claims. */
export function correctionImpact(objects: LedgerObject[], correctionId: string): ImpactResult {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const c = byId.get(correctionId);
  const effect = (c?.fields.correction as Correction | undefined)?.effect ?? "unspecified";
  const result: ImpactResult = { correction_id: correctionId, accepted: Boolean(c && wasAccepted(c)), effect, affected: [], excluded: [], incomplete: [], complete: false,
    interrupt: { required: false, reason: "not yet computed" } };
  const settle = (r: ImpactResult): ImpactResult => {
    r.interrupt = r.affected.length
      ? { required: true, reason: `${r.affected.length} recorded result(s) depend on the corrected record and need review before reuse: ${r.affected.slice(0, 5).map((a) => a.id).join(", ")}${r.affected.length > 5 ? ", …" : ""}` }
      : r.incomplete.length
        ? { required: true, reason: `no downstream result is confirmed affected, but lineage is unresolved, so the blast radius is unknown: ${r.incomplete.slice(0, 3).map((x) => x.reason).join("; ")}` }
        : { required: false, reason: "no recorded work depends on the corrected record; nothing downstream changes, so this needs no one's attention yet" };
    return r;
  };
  if (!c || !c.supersedes || !byId.has(c.supersedes)) { result.incomplete.push({ id: correctionId, reason: "correction or original predecessor is unavailable" }); return settle(result); }
  if (!result.accepted) { result.incomplete.push({ id: correctionId, reason: "correction is not accepted; no automatic review impact asserted" }); return settle(result); }
  if(effect==='unspecified') result.incomplete.push({id:correctionId,reason:'replacement has no declared historical/future effect; downstream dependencies require review and applicability is unresolved'});
  const family = resolveAccepted(objects, c.id);
  if (family.status === "conflict") { result.incomplete.push({ id: correctionId, reason: "competing accepted corrections require resolution" }); return settle(result); }
  const reverse = new Map<string, { child: LedgerObject; ref: Dependency }[]>();
  const unresolved: { child: LedgerObject; target?: string; reason: string }[] = [];
  for (const o of objects) {
    if (o.status === "draft") continue;
    const refs = (o.fields.dependencies as Dependency[] | undefined) ?? [];
    for (const ref of refs) {
      const target = byId.get(ref.id);
      if (!target || objectVersion(target) !== ref.version) { unresolved.push({ child: o, target: ref.id, reason: `${ref.id}: missing or mismatched exact dependency version` }); continue; }
      reverse.set(ref.id, [...(reverse.get(ref.id) ?? []), { child: o, ref }]);
    }
    const legacyNames = (o.fields.definitions_used as string[] | undefined) ?? [];
    const old = byId.get(c.supersedes)!;
    const scopeMayApply = !o.fields.analysis_scope || !old.fields.analysis_scope || scopeIdentity(o.fields.analysis_scope) === scopeIdentity(old.fields.analysis_scope);
    if (scopeMayApply && legacyNames.includes(String(old.fields.metric ?? "")) && !refs.some((r) => r.relation === "uses-definition"))
      unresolved.push({ child: o, target: old.id, reason: "legacy metric-name dependency does not identify an exact definition version" });
    const oldRefs = [((o.fields.prior as { ids?: string[] } | undefined)?.ids ?? []), o.fields.based_on ?? [], o.fields.related_findings ?? []].flat() as string[];
    for (const id of oldRefs) if (!refs.some((r) => r.id === id)) unresolved.push({ child: o, target: id, reason: `${id}: legacy dependency has no pinned version` });
  }
  const seen = new Set<string>();
  const queue: { id: string; path: string[] }[] = [];
  let predecessor: LedgerObject | undefined = byId.get(c.supersedes);
  let predecessorPath = [c.id];
  // A second correction must not make unrevalidated work pinned to an earlier version disappear.
  while (predecessor) {
    if (seen.has(predecessor.id)) { result.incomplete.push({ id: predecessor.id, reason: "cyclic predecessor history" }); break; }
    seen.add(predecessor.id);
    predecessorPath = [...predecessorPath, predecessor.id];
    queue.push({ id: predecessor.id, path: predecessorPath });
    if (predecessor.supersedes && !byId.has(predecessor.supersedes)) {
      result.incomplete.push({ id: predecessor.id, reason: `missing earlier predecessor: ${predecessor.supersedes}` }); break;
    }
    predecessor = predecessor.supersedes ? byId.get(predecessor.supersedes) : undefined;
  }
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    for (const { child } of reverse.get(current.id) ?? []) {
      if (seen.has(child.id) || child.id === c.id) continue;
      seen.add(child.id);
      const w = child.fields.data_window as { from: string; to: string } | undefined;
      const correction = c.fields.correction as Correction | undefined;
      const before = w && correction?.effective_from && w.to.slice(0, 10) < correction.effective_from.slice(0, 10);
      const after = w && correction?.effective_to && w.from.slice(0, 10) > correction.effective_to.slice(0, 10);
      if (before || after) { result.excluded.push({ id: child.id, reason: "analysis window is outside the correction's effective interval" }); continue; }
      if (effect === "future_only" && !w) result.incomplete.push({ id: child.id, reason: "no analytical window to establish future-only correction applicability" });
      const chain = [...current.path, child.id];
      result.affected.push({ id: child.id, status: "needs_review", path: chain, reason: `${child.id} depends on ${current.id}; original values remain evidence until reviewed` });
      queue.push({ id: child.id, path: chain });
    }
  }
  // Unknown lineage remains unknown transitively. It does not prove a downstream result is affected or safe.
  const uncertain = new Set<string>();
  let more = true;
  while (more) {
    more = false;
    for (const gap of unresolved) {
      const scopeMayApply = !gap.child.fields.analysis_scope || !c.fields.analysis_scope
        || scopeIdentity(gap.child.fields.analysis_scope) === scopeIdentity(c.fields.analysis_scope);
      if ((gap.target && (seen.has(gap.target) || uncertain.has(gap.target))) || (gap.target && !byId.has(gap.target) && scopeMayApply)) {
        result.incomplete.push({ id: gap.child.id, reason: gap.reason });
        if (!uncertain.has(gap.child.id)) { uncertain.add(gap.child.id); more = true; }
      }
    }
    for (const id of [...uncertain]) for (const { child } of reverse.get(id) ?? []) {
      if (!uncertain.has(child.id)) { uncertain.add(child.id); more = true; result.incomplete.push({ id: child.id, reason: `${id}: upstream lineage is unresolved` }); }
    }
  }
  result.incomplete = [...new Map(result.incomplete.map((x) => [`${x.id}:${x.reason}`, x])).values()];
  result.complete = result.incomplete.length === 0;
  return settle(result);
}
