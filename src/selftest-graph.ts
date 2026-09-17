import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildGraph, toDot, toMermaid, type Graph } from "./graph.js";
import { getById, loadAll, pull, record, recordDraft, type Config } from "./store.js";
import { objectVersion } from "./authority.js";
import type { AnalysisScope, Dependency, LedgerObject } from "./schema.js";

// No initLedger(), environment reconfiguration, network, user data, or live config writes.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-graph-test-"));
const git = (cwd: string, a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });
const cfg: Config = { ledger_dir: path.join(tmp, "knowledge"), author: "agaaz", git_sync: false };
const scope: AnalysisScope = { product: "HiAstro", dataset: "fixture-conversion-v1", environment: "test", metric: "trial_cvr",
  population: "Android IN eligible users", grain: "user", attribution_rule: "trial within seven days of first eligible exposure" };
const definition = (patch: Record<string, unknown> = {}) => ({ title: "Eligible-user trial conversion", metric: "trial_cvr",
  formula: "trial users / exposed users", source: "fixture://conversion", owner: "agaaz", valid_from: "2026-08-01", analysis_scope: scope, ...patch });
const get = (id: string, conf = cfg) => { const o = getById(conf, id); assert.ok(o); return o; };
const dep = (o: LedgerObject, relation: Dependency["relation"] = "uses-definition"): Dependency => ({ relation, id: o.id, version: objectVersion(o) });
const accept = (o: LedgerObject, actor = "agaaz") => ({ actor, accepted_at: "2026-09-10T12:00:00Z",
  evidence_refs: [{ artifact_id: o.id, sha256: objectVersion(o), role: "review" as const }], expected_predecessor: { id: o.id, version: objectVersion(o) } });
const finding = (title: string, dependencies: Dependency[], patch: Record<string, unknown> = {}) => ({ title,
  question: "Does Android trial conversion differ by intent?", result: "Synthetic fixture result", definitions_used: ["trial_cvr"],
  data_window: { from: "2026-08-01", to: "2026-08-31" }, inputs: [{ source: "fixture://conversion" }],
  method: "Count distinct trial users divided by distinct eligible exposed users.",
  assumptions: [{ statement: "Synthetic fixture captures every exposure", kind: "implicit" as const }],
  analysis_scope: scope, dependencies, ...patch });
const node = (g: Graph, id: string) => { const n = g.nodes.find((x) => x.id === id); assert.ok(n, `expected ${id} in the graph`); return n; };
const edge = (g: Graph, from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);

try {
  // ---- lineage is drawn, and only from version-pinned references ----
  const d1 = get(record(cfg, { type: "definition", fields: definition() }).id);
  const pinned = get(record(cfg, { type: "finding", fields: finding("Pinned to the definition", [dep(d1)]) }).id);
  // The write path refuses a new *scoped* stable finding that names a metric without pinning it, so
  // an unpinned name only exists in the legacy (unscoped) shape. That is the shape --unpinned hunts.
  const named = get(record(cfg, { type: "finding", fields: finding("Definition by name only", [], { analysis_scope: undefined }) }).id);
  const decision = get(record(cfg, { type: "decision", fields: { title: "Target marriage intent on Android",
    decision: "Run the next paywall test on marriage intent", context: "One experiment slot this cycle and two candidate cohorts.",
    options_considered: [{ option: "Marriage / Android", chosen: true }, { option: "Do nothing", rationale: "slot unused" }],
    rationale: "Highest expected trials per cycle.", valid_from: "2026-09-03", owner: "agaaz",
    assumptions: [{ statement: "Observed uplift survives randomization", kind: "implicit" as const }],
    based_on: [pinned.id] } }).id);

  const g = buildGraph(cfg);
  assert.equal(edge(g, pinned.id, d1.id)?.strength, "pinned", "a matching content_version is real lineage");
  assert.equal(edge(g, pinned.id, d1.id)?.kind, "uses-definition");
  assert.equal(edge(g, decision.id, pinned.id)?.strength, "named", "based_on carries no version, so it is not lineage");
  assert.equal(edge(g, named.id, d1.id), undefined, "definitions_used is a name, not an edge, unless asked for");
  assert.deepEqual(node(g, named.id).unpinned_definitions, ["trial_cvr"], "a finding on an unpinned name is flagged on the node");
  assert.deepEqual(node(g, pinned.id).unpinned_definitions, [], "a pinned finding is not flagged");
  assert.ok(g.summary.unpinned.includes(named.id) && !g.summary.unpinned.includes(pinned.id));
  assert.equal(edge(buildGraph(cfg, { names: true }), named.id, d1.id)?.strength, "named", "--names draws the name edge, dashed");

  // ---- authority tier is on the node, and it drives the rendered style ----
  const draft = recordDraft(cfg, { type: "finding", fields: finding("Unreviewed cut", []),
    capture: { method: "transcript_fallback", session: "synthetic-claude", reason: "review" } });
  const withDraft = buildGraph(cfg);
  assert.equal(node(withDraft, pinned.id).tier, 3);
  assert.equal(node(withDraft, pinned.id).label, "current");
  assert.equal(node(withDraft, draft.id).tier, 2);
  assert.equal(node(withDraft, draft.id).label, "draft");
  const draftDot = toDot(withDraft).split("\n").find((l) => l.includes(`"${draft.id}" [`))!;
  const currentDot = toDot(withDraft).split("\n").find((l) => l.includes(`"${pinned.id}" [`))!;
  assert.match(draftDot, /style="filled,dashed"/, "a draft is visibly not an accepted record");
  assert.match(currentDot, /style="filled,solid"/);
  assert.notEqual(draftDot.match(/color="(#[0-9a-f]{6})"/)![1], currentDot.match(/color="(#[0-9a-f]{6})"/)![1],
    "tier is the border colour, not a tooltip");
  const draftMermaid = toMermaid(withDraft);
  assert.match(draftMermaid, /classDef draft[^\n]*stroke-dasharray/);
  assert.ok(draftMermaid.split("\n").some((l) => /^  class n\d+ draft$/.test(l)));

  // ---- nothing is laid out or ranked by date ----
  for (const rendered of [toDot(withDraft, true), toMermaid(withDraft, true)]) {
    assert.doesNotMatch(rendered, /\brank\s*=/, "a rank constraint would let position assert recency");
    assert.doesNotMatch(rendered, /\b20\d\d-\d\d-\d\d\b/, "no date reaches the rendered graph at all");
  }

  // ---- reproduction: recorded while d1 is still the sole applicable accepted definition ----
  const repro = get(record(cfg, { type: "finding", fields: finding("Re-ran the pinned cut",
    [dep(d1), dep(get(pinned.id), "derived-from")],
    { reproduction_of: { id: pinned.id, version: objectVersion(get(pinned.id)), outcome: "matched" } }) }).id);
  const reproduced = buildGraph(cfg);
  assert.equal(edge(reproduced, repro.id, pinned.id)?.kind, "reproduction");
  assert.match(String(edge(reproduced, repro.id, pinned.id)?.detail), /matched/);
  assert.equal(node(reproduced, pinned.id).verification, "reproduced");
  assert.match(toDot(reproduced).split("\n").find((l) => l.includes(`"${pinned.id}" [`))!, /peripheries=2/);

  // ---- supersession: the predecessor retires, but a pin that still matches stays lineage ----
  const d2 = get(record(cfg, { type: "definition", fields: definition({ title: "Denominator corrected to eligible exposures",
    formula: "trial users / eligible exposed users", supersedes: d1.id, acceptance: accept(d1),
    correction: { effect: "historical", reason: "denominator counted ineligible exposures" } }) }).id);
  const superseded = buildGraph(cfg);
  assert.equal(node(superseded, d1.id).tier, 0);
  assert.match(node(superseded, d1.id).label, new RegExp(`^superseded by ${d2.id}$`));
  assert.equal(node(superseded, d2.id).correction, "historical");
  assert.equal(edge(superseded, d2.id, d1.id)?.kind, "supersedes");
  assert.equal(edge(superseded, pinned.id, d1.id)?.strength, "pinned", "the old pin still matches the record it named");
  assert.equal(buildGraph(cfg, { currentOnly: true }).nodes.find((n) => n.id === d1.id), undefined, "--current-only drops retired nodes");

  // ---- blast radius of a correction ----
  const impact = buildGraph(cfg, { impact: d2.id });
  assert.ok(impact.nodes.some((n) => n.id === d2.id) && impact.nodes.some((n) => n.id === d1.id));
  assert.equal(node(impact, pinned.id).needs_review, true, "a result pinned to the corrected record needs review");
  assert.equal(impact.nodes.find((n) => n.id === decision.id), undefined, "the blast radius is not the whole ledger");
  assert.match(toDot(impact).split("\n").find((l) => l.includes(`"${pinned.id}" [`))!, /color="#cf222e"/);


  // ---- a pin that stopped matching: only reachable by editing bytes outside the write path,
  // which is exactly when a reader most needs to see that the exactness claim expired ----
  const other: AnalysisScope = { ...scope, metric: "paid_cvr", dataset: "fixture-paid-v1" };
  const d3 = get(record(cfg, { type: "definition", fields: definition({ title: "Paid conversion", metric: "paid_cvr", analysis_scope: other }) }).id);
  const pinsD3 = get(record(cfg, { type: "finding", fields: finding("Pinned to paid conversion", [dep(d3)],
    { analysis_scope: other, definitions_used: ["paid_cvr"] }) }).id);
  assert.equal(edge(buildGraph(cfg), pinsD3.id, d3.id)?.strength, "pinned");
  fs.appendFileSync(d3.path, "\nHand-edited outside the write path.\n");
  const drifted = buildGraph(cfg);
  assert.equal(edge(drifted, pinsD3.id, d3.id)?.strength, "stale");
  assert.match(String(edge(drifted, pinsD3.id, d3.id)?.detail), /version no longer matches/);
  assert.equal(drifted.summary.stale_pins, 1);
  assert.match(drifted.scope, /1 stale pin/);
  assert.match(toDot(drifted).split("\n").find((l) => l.includes(`"${pinsD3.id}" -> "${d3.id}"`))!, /style=dashed, color="#cf222e"/);

  // ---- ego graph ----
  const ego = buildGraph(cfg, { id: d1.id, depth: 1 });
  assert.deepEqual(new Set(ego.nodes.map((n) => n.id)), new Set([d1.id, d2.id, pinned.id]), "depth 1 is d1 and its direct neighbours");
  assert.ok(ego.summary.clipped_edges > 0, "a clipped picture says how much it cut");
  assert.throws(() => buildGraph(cfg, { id: "fnd-not-here" }), /not in the ledger/);

  // ---- an unresolved accepted conflict is two heads and no arrow ----
  const remote = path.join(tmp, "remote.git");
  git(tmp, ["init", "--bare", remote]);
  const replicaA = path.join(tmp, "replica-a");
  git(tmp, ["clone", remote, replicaA]);
  for (const cwd of [replicaA]) { git(cwd, ["config", "user.name", "Graph fixture"]); git(cwd, ["config", "user.email", "fixture@ledger.invalid"]); }
  const a: Config = { ledger_dir: replicaA, author: "agaaz", git_sync: true };
  const base = get(record(a, { type: "definition", fields: definition() }).id, a);
  git(replicaA, ["push", "--set-upstream", "origin", "HEAD"]);
  const replicaB = path.join(tmp, "replica-b");
  git(tmp, ["clone", remote, replicaB]);
  git(replicaB, ["config", "user.name", "Graph fixture"]); git(replicaB, ["config", "user.email", "fixture@ledger.invalid"]);
  const b: Config = { ledger_dir: replicaB, author: "rachit", git_sync: false };
  const ca = record({ ...a, git_sync: false }, { type: "definition", fields: definition({ title: "Agaaz accepted correction", supersedes: base.id, acceptance: accept(base) }) });
  const cb = record(b, { type: "definition", fields: definition({ title: "Rachit accepted correction", supersedes: base.id, acceptance: accept(get(base.id, b), "rachit") }) });
  git(replicaA, ["add", "."]); git(replicaA, ["commit", "-m", "fixture A acceptance"]); git(replicaA, ["push"]);
  git(replicaB, ["add", "."]); git(replicaB, ["commit", "-m", "fixture B acceptance"]);
  assert.equal(pull({ ...b, git_sync: true }, true), null);

  const conflicted = buildGraph({ ...b, git_sync: false });
  assert.deepEqual(conflicted.summary.conflicts.map((h) => new Set(h)), [new Set([ca.id, cb.id])]);
  assert.ok(node(conflicted, ca.id).conflict && node(conflicted, cb.id).conflict);
  assert.equal(node(conflicted, ca.id).tier, 3, "both heads stay current; the graph never picks one");
  assert.equal(node(conflicted, cb.id).tier, 3);
  const link = conflicted.edges.find((e) => e.kind === "unresolved");
  assert.ok(link && new Set([link.from, link.to]).size === 2);
  const conflictDot = toDot(conflicted).split("\n").filter((l) => l.includes("unresolved"));
  assert.equal(conflictDot.length, 1);
  assert.match(conflictDot[0], /dir=none/, "an arrow between two accepted heads would assert a winner");
  const conflictMermaid = toMermaid(conflicted).split("\n").filter((l) => l.includes("unresolved") && !l.startsWith("%%"));
  assert.equal(conflictMermaid.length, 1);
  assert.match(conflictMermaid[0], /---\|"unresolved"\|/);
  assert.doesNotMatch(conflictMermaid[0], /-->|-\.->/);
  assert.match(conflicted.scope, /1 UNRESOLVED conflict/);
  const onlyConflicts = buildGraph({ ...b, git_sync: false }, { conflictsOnly: true });
  assert.ok(onlyConflicts.nodes.some((n) => n.id === ca.id) && onlyConflicts.nodes.some((n) => n.id === cb.id));
  assert.ok(onlyConflicts.nodes.some((n) => n.id === base.id), "the shared predecessor is kept so the conflict is legible");

  // ---- the scope line never lets a filtered picture read as the whole ledger ----
  assert.match(buildGraph(cfg, { types: ["finding"] }).scope, /types finding/);
  assert.match(buildGraph(cfg, { currentOnly: true }).scope, /current only/);
  assert.match(buildGraph(cfg).scope, /including superseded and drafts/);
  assert.match(buildGraph(cfg, { days: 7 }).scope, /last 7d/);

  console.log("graph: pinned-vs-named edges, tier styling, no date in the layout, correction blast radius, reproduction, ego walk, and undirected unresolved conflicts tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
