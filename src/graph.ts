import { loadAll, type Config } from "./store.js";
import { TYPES, type Correction, type Dependency, type LedgerObject, type LedgerType, type Reproduction } from "./schema.js";
import { correctionImpact, objectVersion, resolveAccepted, verification, type VerificationStatus } from "./authority.js";
import { objectAuthority, type ObjectAuthorityLabel, type ObjectAuthorityTier } from "./query.js";

/**
 * A renderer for the lineage graph the ledger already stores. It is a view, never a source:
 * every node and edge is derived from the git objects on each call, so there is nothing to sync
 * and nothing to drift. Continuity (threads, sessions, events) lives in Postgres and is a
 * different picture — execution, not knowledge — and is deliberately not drawn here.
 *
 * Three rules this module exists to keep, because breaking any of them makes the graph lie:
 *
 *   1. Authority tier is the first visual channel. A draft and an accepted finding must never
 *      render as peers. Tier drives border, fill and weight; it is not a tooltip.
 *   2. No timeline layout, ever. Recency-as-truth is the thing the ledger refuses; laying nodes
 *      out by date asserts it silently. Rank comes from lineage edges only.
 *   3. An edge means a pinned content_version. Compatibility fields that carry only a name or a
 *      bare id (`definitions_used`, `based_on`, `prior.ids`, `related_findings`) are unresolved
 *      lineage and render dashed, labelled, and never as plain lineage.
 *
 * Edges point from an object to what it rests on: a successor to the predecessor it supersedes,
 * a finding to the definition it used, a decision to its evidence.
 */

export type EdgeKind =
  | "supersedes"
  | "uses-definition"
  | "derived-from"
  | "based-on"
  | "reproduction"
  | "evidence"
  | "prior"
  | "definition-name"
  | "unresolved";

/**
 * How much the edge is worth.
 *   pinned — a content_version that still matches the target. Real lineage.
 *   stale  — a pinned version that no longer matches, or whose target is gone. Louder than named:
 *            someone asserted exactness and it stopped being true.
 *   named  — a name or bare id with no version. Compatibility, not lineage.
 */
export type EdgeStrength = "pinned" | "stale" | "named";

export interface GraphNode {
  id: string;
  type: LedgerType;
  title: string;
  author: string;
  created: string;
  tier: ObjectAuthorityTier;
  label: ObjectAuthorityLabel;
  /** Findings only: whether anyone re-ran the recipe at this exact content_version. */
  verification?: VerificationStatus;
  /** This object is one head of an unresolved accepted conflict. Nothing here ranks the heads. */
  conflict: boolean;
  /** This object replaces a predecessor and declares a correction effect. */
  correction?: Correction["effect"];
  /** Metric names in `definitions_used` with no pinned uses-definition edge behind them. */
  unpinned_definitions: string[];
  /** Set by --impact: this object depends on the corrected record and needs review before reuse. */
  needs_review?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  strength: EdgeStrength;
  /** Shown on the edge: a reproduction outcome, a prior relation, why a pin is stale. */
  detail?: string;
}

export interface GraphSummary {
  nodes: number;
  edges: number;
  current: number;
  draft: number;
  retired: number;
  /** Unresolved accepted conflicts, as head-sets. Never resolved here, only counted and drawn. */
  conflicts: string[][];
  /** Findings resting on a metric name with no pinned definition version. */
  unpinned: string[];
  stale_pins: number;
  /** Edges dropped because a filter or --depth cut one endpoint. The picture is partial by this much. */
  clipped_edges: number;
  /** References to ids that are not in the ledger at all. A real dangling reference, not a clip. */
  dangling: string[];
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  summary: GraphSummary;
  scope: string;
}

export interface GraphOpts {
  types?: LedgerType[];
  tags?: string[];
  author?: string;
  /** Only objects created in the last N days. Filters membership; it never orders the layout. */
  days?: number;
  /** Ego graph: start from this id and walk `depth` edges in either direction. */
  id?: string;
  depth?: number;
  /** Drop superseded, deprecated and rejected nodes. Off by default: lineage is the point. */
  currentOnly?: boolean;
  /** Keep only the components containing an unresolved accepted conflict. */
  conflictsOnly?: boolean;
  /** Keep only findings resting on an unpinned definition name, plus what they connect to. */
  unpinnedOnly?: boolean;
  /** Scope to the blast radius of a correction, via correctionImpact. */
  impact?: string;
  /** Draw dashed `definitions_used` name edges. Off by default: a name is not lineage. */
  names?: boolean;
}

// ---------- build ----------

const truthy = <T>(v: T | undefined | null): v is T => Boolean(v);

function conflictKey(ids: string[]): string {
  return [...ids].sort().join("|");
}

/** Every edge the object set asserts, before any filtering. Direction: dependent -> what it rests on. */
function allEdges(objects: LedgerObject[], opts: GraphOpts): { edges: GraphEdge[]; dangling: Set<string> } {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const byMetric = new Map<string, LedgerObject[]>();
  for (const o of objects) {
    if (o.type !== "definition") continue;
    const m = String(o.fields.metric ?? "");
    if (m) byMetric.set(m, [...(byMetric.get(m) ?? []), o]);
  }
  const edges: GraphEdge[] = [];
  const dangling = new Set<string>();
  const seen = new Set<string>();
  const push = (e: GraphEdge) => {
    const key = `${e.from}|${e.to}|${e.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(e);
  };
  /** A pinned reference is only lineage while its version still matches the target it names. */
  const pinStrength = (id: string, version: string): { strength: EdgeStrength; detail?: string } => {
    const target = byId.get(id);
    if (!target) { dangling.add(id); return { strength: "stale", detail: "target missing" }; }
    return objectVersion(target) === version ? { strength: "pinned" } : { strength: "stale", detail: "version no longer matches" };
  };

  for (const o of objects) {
    const deps = (o.fields.dependencies as Dependency[] | undefined) ?? [];
    const pinnedIds = new Set(deps.map((d) => d.id));

    if (o.supersedes) {
      if (!byId.has(o.supersedes)) dangling.add(o.supersedes);
      push({ from: o.id, to: o.supersedes, kind: "supersedes", strength: "pinned",
        detail: (o.fields.correction as Correction | undefined)?.effect });
    }

    // A reproduction pins its target twice by design (reproduction_of, plus derived-from in
    // dependencies). One line, not two: the reproduction edge carries the outcome, which is the
    // part a reader needs, so the duplicate derived-from is folded into it.
    const rep = o.fields.reproduction_of as Reproduction | undefined;
    if (rep) {
      const { strength, detail } = pinStrength(rep.id, rep.version);
      push({ from: o.id, to: rep.id, kind: "reproduction", strength,
        detail: [rep.outcome, detail].filter(truthy).join(", ") });
    }

    for (const d of deps) {
      if (rep && d.id === rep.id && d.relation === "derived-from") continue;
      const { strength, detail } = pinStrength(d.id, d.version);
      push({ from: o.id, to: d.id, kind: d.relation, strength, detail });
    }

    // Bare-id compatibility fields. They carry no version, so they are drawn as unresolved lineage
    // unless the same target is already pinned in dependencies, where the pinned edge is the truth.
    const prior = o.fields.prior as { relation?: string; ids?: string[] } | undefined;
    for (const id of prior?.ids ?? []) {
      if (pinnedIds.has(id)) continue;
      if (!byId.has(id)) dangling.add(id);
      push({ from: o.id, to: id, kind: "prior", strength: "named", detail: prior?.relation ?? "prior" });
    }
    const evidence = [
      ...((o.fields.based_on as string[] | undefined) ?? []),
      ...((o.fields.related_findings as string[] | undefined) ?? []),
    ];
    for (const id of evidence) {
      if (pinnedIds.has(id)) continue;
      if (!byId.has(id)) dangling.add(id);
      push({ from: o.id, to: id, kind: "evidence", strength: "named", detail: "no pinned version" });
    }

    if (opts.names) {
      const hasPinnedDefinition = deps.some((d) => d.relation === "uses-definition");
      for (const name of (o.fields.definitions_used as string[] | undefined) ?? []) {
        for (const def of byMetric.get(name) ?? []) {
          if (pinnedIds.has(def.id)) continue;
          push({ from: o.id, to: def.id, kind: "definition-name", strength: "named",
            detail: hasPinnedDefinition ? `name only: ${name}` : `name only, nothing pinned: ${name}` });
        }
      }
    }
  }
  return { edges, dangling };
}

/**
 * Metric names a finding rests on with no pinned uses-definition edge behind them. This is the
 * "findings with no definition" case rendered as a node property rather than an absent edge,
 * because an edge that is not there cannot be seen.
 */
function unpinnedDefinitions(o: LedgerObject, byMetric: Set<string>, byId: Map<string, LedgerObject>): string[] {
  const names = (o.fields.definitions_used as string[] | undefined) ?? [];
  if (!names.length) return [];
  const pinned = new Set(
    ((o.fields.dependencies as Dependency[] | undefined) ?? [])
      .filter((d) => d.relation === "uses-definition")
      .map((d) => String(byId.get(d.id)?.fields.metric ?? ""))
      .filter(truthy)
  );
  return names.filter((n) => !pinned.has(n) && byMetric.has(n));
}

export function buildGraph(cfg: Config, opts: GraphOpts = {}): Graph {
  const objects = loadAll(cfg, TYPES);
  const byId = new Map(objects.map((o) => [o.id, o]));
  const metricNames = new Set(objects.filter((o) => o.type === "definition").map((o) => String(o.fields.metric ?? "")).filter(truthy));

  // Conflict heads first: they decide a node's loudest marker and one of the three questions
  // this command exists for. resolveAccepted never ranks the heads and neither does anything below.
  const conflictOf = new Map<string, string[]>();
  const conflicts = new Map<string, string[]>();
  for (const o of objects) {
    const authority = resolveAccepted(objects, o.id);
    if (authority.status !== "conflict") continue;
    const heads = authority.current.map((c) => c.id);
    if (heads.length < 2) continue;
    conflicts.set(conflictKey(heads), heads);
    for (const id of heads) conflictOf.set(id, heads);
  }

  const node = (o: LedgerObject): GraphNode => {
    const authority = resolveAccepted(objects, o.id);
    const { tier, label } = objectAuthority(o, authority);
    return {
      id: o.id, type: o.type, title: o.title, author: o.author, created: o.created, tier, label,
      verification: o.type === "finding" ? verification(objects, o).status : undefined,
      conflict: conflictOf.has(o.id),
      correction: o.supersedes ? (o.fields.correction as Correction | undefined)?.effect : undefined,
      unpinned_definitions: unpinnedDefinitions(o, metricNames, byId),
    };
  };
  let nodes = objects.map(node);
  const { edges: everyEdge, dangling } = allEdges(objects, opts);

  // Unresolved conflicts are a pair of equally accepted heads, so the link carries no direction.
  // Rendered without an arrow in every format; a reader must not be able to read a winner off it.
  for (const heads of conflicts.values()) {
    for (let i = 0; i < heads.length; i++)
      for (let j = i + 1; j < heads.length; j++)
        everyEdge.push({ from: heads[i], to: heads[j], kind: "unresolved", strength: "named", detail: "unresolved: no authoritative head" });
  }

  // ---- selection ----
  let keep = new Set(nodes.map((n) => n.id));
  const cutoff = opts.days ? new Date(Date.now() - opts.days * 86_400_000).toISOString() : undefined;
  const byNodeId = new Map(nodes.map((n) => [n.id, n]));
  const matches = (n: GraphNode) =>
    (!opts.types || opts.types.includes(n.type)) &&
    (!opts.author || n.author === opts.author) &&
    (!opts.tags?.length || opts.tags.some((t) => byId.get(n.id)!.tags.includes(t))) &&
    (!cutoff || n.created >= cutoff) &&
    (!opts.currentOnly || n.tier !== 0);
  keep = new Set(nodes.filter(matches).map((n) => n.id));

  if (opts.impact) {
    const impact = correctionImpact(objects, opts.impact);
    const reach = new Set<string>([opts.impact]);
    for (const a of impact.affected) { reach.add(a.id); for (const p of a.path) reach.add(p); }
    for (const x of impact.incomplete) reach.add(x.id);
    const correction = byId.get(opts.impact);
    if (correction?.supersedes) reach.add(correction.supersedes);
    keep = new Set([...keep].filter((id) => reach.has(id)));
    for (const id of reach) if (byNodeId.has(id)) keep.add(id);
    const needsReview = new Set(impact.affected.map((a) => a.id));
    for (const n of nodes) if (needsReview.has(n.id)) n.needs_review = true;
  }
  if (opts.conflictsOnly) keep = new Set([...keep].filter((id) => conflictOf.has(id)));
  if (opts.unpinnedOnly) keep = new Set([...keep].filter((id) => byNodeId.get(id)?.unpinned_definitions.length));

  // Ego graph, and the neighbourhood expansion the --conflicts/--unpinned filters need to be readable:
  // a lone node with its edges cut says nothing about what depends on it.
  const seeds = opts.id ? [opts.id] : opts.conflictsOnly || opts.unpinnedOnly ? [...keep] : undefined;
  if (seeds) {
    const adjacency = new Map<string, string[]>();
    for (const e of everyEdge) {
      adjacency.set(e.from, [...(adjacency.get(e.from) ?? []), e.to]);
      adjacency.set(e.to, [...(adjacency.get(e.to) ?? []), e.from]);
    }
    const depth = opts.depth ?? (opts.id ? 2 : 1);
    const reached = new Set<string>(seeds.filter((s) => byNodeId.has(s)));
    let frontier = [...reached];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier)
        for (const n of adjacency.get(id) ?? [])
          if (byNodeId.has(n) && !reached.has(n)) { reached.add(n); next.push(n); }
      frontier = next;
    }
    // The ego/component walk defines membership; --current-only still applies, other filters do not,
    // because hiding a predecessor by date would silently cut the lineage the walk was asked for.
    keep = new Set([...reached].filter((id) => !opts.currentOnly || byNodeId.get(id)!.tier !== 0));
    if (opts.id && !byNodeId.has(opts.id)) throw new Error(`not in the ledger: ${opts.id}`);
  }

  nodes = nodes.filter((n) => keep.has(n.id));
  const present = new Set(nodes.map((n) => n.id));
  const edges = everyEdge.filter((e) => present.has(e.from) && present.has(e.to));
  const clipped = everyEdge.filter((e) => (present.has(e.from) || present.has(e.to)) && !(present.has(e.from) && present.has(e.to))).length;

  const summary: GraphSummary = {
    nodes: nodes.length,
    edges: edges.length,
    current: nodes.filter((n) => n.tier === 3).length,
    draft: nodes.filter((n) => n.tier === 2).length,
    retired: nodes.filter((n) => n.tier === 0).length,
    conflicts: [...conflicts.values()].filter((heads) => heads.some((id) => present.has(id))),
    unpinned: nodes.filter((n) => n.unpinned_definitions.length).map((n) => n.id),
    stale_pins: edges.filter((e) => e.strength === "stale").length,
    clipped_edges: clipped,
    dangling: [...dangling].filter((id) => !byId.has(id)),
  };
  return { nodes, edges, summary, scope: scopeLine(opts, summary) };
}

/** One line naming what the picture covers and what it cuts, so a reader never guesses the scope. */
export function scopeLine(opts: GraphOpts, s: GraphSummary): string {
  const parts = [
    `scope: ledger objects, lineage only`,
    `types ${opts.types?.length ? opts.types.join(",") : "any"}`,
    `author ${opts.author ?? "any"}`,
    opts.days ? `last ${opts.days}d` : "all time",
    opts.id ? `ego ${opts.id} depth ${opts.depth ?? 2}` : opts.impact ? `blast radius of ${opts.impact}` : "whole ledger",
    opts.currentOnly ? "current only" : "including superseded and drafts",
    opts.names ? "name edges drawn" : "name edges omitted",
  ];
  const notes = [
    `${s.nodes} nodes (${s.current} current · ${s.draft} draft · ${s.retired} retired)`,
    `${s.edges} edges`,
    s.conflicts.length ? `${s.conflicts.length} UNRESOLVED conflict(s)` : null,
    s.unpinned.length ? `${s.unpinned.length} finding(s) on an unpinned definition name` : null,
    s.stale_pins ? `${s.stale_pins} stale pin(s)` : null,
    s.clipped_edges ? `${s.clipped_edges} edge(s) clipped by the selection` : null,
    s.dangling.length ? `${s.dangling.length} dangling reference(s): ${s.dangling.slice(0, 3).join(", ")}` : null,
  ].filter(truthy);
  return `${parts.join(" · ")}\n${notes.join(" · ")}`;
}

// ---------- render ----------

export type GraphFormat = "dot" | "mermaid" | "json";

function clip(s: string, n = 46): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** Tier first, then the markers that change what a reader should do with the node. */
function badges(n: GraphNode): string[] {
  return [
    n.label,
    n.conflict ? "UNRESOLVED CONFLICT" : null,
    n.needs_review ? "NEEDS REVIEW" : null,
    n.verification === "contested" ? "contested" : n.verification === "reproduced" ? "reproduced" : null,
    n.correction ? `correction: ${n.correction}` : null,
    n.unpinned_definitions.length ? `unpinned: ${n.unpinned_definitions.join(", ")}` : null,
  ].filter(truthy);
}

const DOT_SHAPE: Record<LedgerType, string> = {
  definition: "box", finding: "ellipse", change: "parallelogram", decision: "hexagon",
};

/**
 * Tier drives style, fill and pen weight; markers only raise the pen and the border colour on top.
 * No `rank`, no date clustering: position comes from lineage edges and nothing else.
 */
function dotNode(n: GraphNode): string {
  const tier = n.tier === 3
    ? { color: "#1a7f37", fill: "#f2fbf4", font: "#24292f", style: "filled,solid", pen: 1.4 }
    : n.tier === 2
      ? { color: "#9a6700", fill: "#fff8e5", font: "#24292f", style: "filled,dashed", pen: 1.4 }
      : { color: "#8c959f", fill: "#f6f8fa", font: "#6e7781", style: "filled,dotted", pen: 1.0 };
  const alarm = n.conflict || n.verification === "contested" || n.needs_review;
  const label = [clip(n.title), `(${n.id})`, ...badges(n)].join("\\n");
  const attrs = [
    `label="${label.replace(/"/g, '\\"')}"`,
    `shape=${DOT_SHAPE[n.type]}`,
    `style="${tier.style}"`,
    `fillcolor="${alarm ? "#fff0ef" : tier.fill}"`,
    `color="${alarm ? "#cf222e" : tier.color}"`,
    `fontcolor="${tier.font}"`,
    `penwidth=${alarm ? 2.6 : tier.pen}`,
    n.verification === "reproduced" ? "peripheries=2" : null,
  ].filter(truthy);
  return `  "${n.id}" [${attrs.join(", ")}];`;
}

function dotEdge(e: GraphEdge): string {
  const label = [e.kind === "evidence" || e.kind === "prior" ? e.kind : e.kind, e.detail].filter(truthy).join(": ");
  if (e.kind === "unresolved")
    return `  "${e.from}" -> "${e.to}" [dir=none, style=dashed, color="#cf222e", penwidth=2.2, fontcolor="#cf222e", label="unresolved"];`;
  const style = e.strength === "pinned" ? "solid" : "dashed";
  const color = e.strength === "stale" ? "#cf222e" : e.strength === "named" ? "#8c959f" : e.kind === "supersedes" ? "#0969da" : "#57606a";
  return `  "${e.from}" -> "${e.to}" [style=${style}, color="${color}", fontcolor="${color}", fontsize=9, label="${clip(label, 34).replace(/"/g, '\\"')}"];`;
}

const DOT_LEGEND = `  subgraph cluster_legend {
    label="authority tier is the border, not a tooltip";
    fontsize=10; color="#d0d7de"; style=dashed;
    "legend_current" [label="current (accepted head)", shape=box, style="filled,solid", fillcolor="#f2fbf4", color="#1a7f37", penwidth=1.4];
    "legend_draft" [label="draft (never in force)", shape=box, style="filled,dashed", fillcolor="#fff8e5", color="#9a6700", penwidth=1.4];
    "legend_retired" [label="superseded / deprecated", shape=box, style="filled,dotted", fillcolor="#f6f8fa", color="#8c959f", fontcolor="#6e7781"];
    "legend_alarm" [label="unresolved conflict · contested · needs review", shape=box, style="filled,solid", fillcolor="#fff0ef", color="#cf222e", penwidth=2.6];
    "legend_pinned" [label="pinned content_version", shape=plaintext];
    "legend_named" [label="name or bare id: unresolved lineage", shape=plaintext];
    "legend_pinned" -> "legend_named" [style=solid, color="#57606a", label="lineage", fontsize=9];
    "legend_current" -> "legend_draft" [style=invis];
    "legend_draft" -> "legend_retired" [style=invis];
    "legend_retired" -> "legend_alarm" [style=invis];
  }`;

export function toDot(g: Graph, legend = false): string {
  return [
    "digraph ledger {",
    `  // ${g.scope.split("\n").join("\n  // ")}`,
    "  // Layout follows lineage edges only. Nothing here is ordered by date: in this ledger the newer",
    "  // record does not win, and a timeline layout would assert that it does.",
    `  graph [rankdir=TB, splines=spline, nodesep=0.45, ranksep=0.7, fontname="Helvetica", bgcolor="white"];`,
    `  node [fontname="Helvetica", fontsize=10, margin=0.12];`,
    `  edge [fontname="Helvetica"];`,
    ...g.nodes.map(dotNode),
    ...g.edges.map(dotEdge),
    ...(legend ? [DOT_LEGEND] : []),
    "}",
  ].join("\n");
}

const MERMAID_SHAPE: Record<LedgerType, (id: string, label: string) => string> = {
  definition: (id, l) => `${id}["${l}"]`,
  finding: (id, l) => `${id}(["${l}"])`,
  change: (id, l) => `${id}[/"${l}"/]`,
  decision: (id, l) => `${id}{{"${l}"}}`,
};

export function toMermaid(g: Graph, legend = false): string {
  // Ledger ids contain characters mermaid treats as syntax, so nodes get positional ids and carry
  // the real id in their label. The label is the address a reader types into `ledger get`.
  const alias = new Map(g.nodes.map((n, i) => [n.id, `n${i}`]));
  const text = (s: string) => s.replace(/"/g, "#quot;").replace(/[<>]/g, "");
  const lines = [
    "%%{init: {'flowchart': {'curve': 'basis'}}}%%",
    "flowchart TD",
    ...g.scope.split("\n").map((l) => `%% ${l}`),
    "%% Lineage layout only; never ordered by date.",
    "  classDef current stroke:#1a7f37,fill:#f2fbf4,color:#24292f,stroke-width:2px",
    "  classDef draft stroke:#9a6700,fill:#fff8e5,color:#24292f,stroke-width:2px,stroke-dasharray:5 4",
    "  classDef retired stroke:#8c959f,fill:#f6f8fa,color:#6e7781,stroke-width:1px,stroke-dasharray:2 4",
    "  classDef alarm stroke:#cf222e,fill:#fff0ef,color:#24292f,stroke-width:4px",
  ];
  for (const n of g.nodes) {
    const label = [clip(n.title), `${n.id}`, ...badges(n)].map(text).join("<br/>");
    lines.push(`  ${MERMAID_SHAPE[n.type](alias.get(n.id)!, label)}`);
    const tier = n.tier === 3 ? "current" : n.tier === 2 ? "draft" : "retired";
    const alarm = n.conflict || n.verification === "contested" || n.needs_review;
    lines.push(`  class ${alias.get(n.id)} ${tier}${alarm ? ",alarm" : ""}`);
  }
  for (const e of g.edges) {
    const a = alias.get(e.from)!;
    const b = alias.get(e.to)!;
    const label = text(clip([e.kind, e.detail].filter(truthy).join(": "), 34));
    // `---` is an undirected link: an unresolved conflict must not render an arrow, because an arrow
    // is a claim about which head won and no such claim exists.
    if (e.kind === "unresolved") lines.push(`  ${a} ---|"unresolved"| ${b}`);
    else if (e.strength === "pinned") lines.push(`  ${a} -->|"${label}"| ${b}`);
    else lines.push(`  ${a} -.->|"${label}"| ${b}`);
  }
  if (legend) {
    lines.push(
      "  subgraph legend[\"authority tier is the border, not a tooltip\"]",
      "    direction LR",
      "    L1[\"current: accepted head\"]", "    class L1 current",
      "    L2[\"draft: never in force\"]", "    class L2 draft",
      "    L3[\"superseded / deprecated\"]", "    class L3 retired",
      "    L4[\"unresolved conflict · contested · needs review\"]", "    class L4 alarm",
      "    L5[\"solid = pinned content_version\"] -.->|\"dashed = name or bare id, unresolved lineage\"| L6[\" \"]",
      "  end"
    );
  }
  return lines.join("\n");
}

export function renderGraph(g: Graph, format: GraphFormat, legend = false): string {
  return format === "json" ? JSON.stringify(g, null, 2) : format === "dot" ? toDot(g, legend) : toMermaid(g, legend);
}
