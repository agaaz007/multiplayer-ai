import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { authorInk, buildGraph, toDot, toMermaid, type Graph } from "./graph.js";
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
  const unscoped = (() => { const f: Record<string, unknown> = finding("Definition by name only", []); delete f.analysis_scope; return f; })();
  const named = get(record(cfg, { type: "finding", fields: unscoped }).id);
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


  // A second metric family, unrelated to trial_cvr. It is the control for --impact below: a
  // correction's blast radius must stop somewhere, and a test that cannot show where proves nothing.
  const other: AnalysisScope = { ...scope, metric: "paid_cvr", dataset: "fixture-paid-v1" };
  const d3 = get(record(cfg, { type: "definition", fields: definition({ title: "Paid conversion", metric: "paid_cvr", analysis_scope: other }) }).id);
  const pinsD3 = get(record(cfg, { type: "finding", fields: finding("Pinned to paid conversion", [dep(d3)],
    { analysis_scope: other, definitions_used: ["paid_cvr"] }) }).id);
  assert.equal(edge(buildGraph(cfg), pinsD3.id, d3.id)?.strength, "pinned");

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
  const classTokens = (m: string) => m.split("\n").filter((l) => /^  class n\d+ /.test(l)).map((l) => l.split(" ").at(-1)!);
  const defined = (m: string) => new Set(m.split("\n").filter((l) => l.startsWith("  classDef ")).map((l) => l.split(" ")[3]));
  for (const m of [draftMermaid, toMermaid(withDraft, true)]) {
    assert.ok(classTokens(m).length, "every node carries a class");
    // `class n1 a,b` is a node list plus one class name, not two classes: it would drop the styling.
    assert.ok(classTokens(m).every((c) => !c.includes(",")), "one class token per node, never a comma list");
    for (const c of classTokens(m)) assert.ok(defined(m).has(c), `class ${c} is used but never defined by a classDef`);
  }

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
  // An unpinned reference is not absence of impact, it is unknown impact, and it is drawn as loudly.
  assert.match(String(node(impact, decision.id).lineage_unresolved), /no pinned version/);
  assert.match(String(node(impact, named.id).lineage_unresolved), /does not identify an exact definition version/);
  assert.equal(node(impact, decision.id).needs_review, undefined);
  assert.equal(impact.nodes.find((n) => n.id === d3.id), undefined, "the blast radius stops at an unrelated metric family");
  assert.equal(impact.nodes.find((n) => n.id === pinsD3.id), undefined);
  assert.match(toDot(impact).split("\n").find((l) => l.includes(`"${pinned.id}" [`))!, /color="#cf222e"/);



  // ---- a pin that stopped matching: only reachable by editing bytes outside the write path,
  // which is exactly when a reader most needs to see that the exactness claim expired ----
  fs.appendFileSync(d3.path, "\nHand-edited outside the write path.\n");
  const drifted = buildGraph(cfg);
  assert.equal(edge(drifted, pinsD3.id, d3.id)?.strength, "stale");
  assert.match(String(edge(drifted, pinsD3.id, d3.id)?.detail), /version no longer matches/);
  assert.equal(drifted.summary.stale_pins, 1);
  assert.match(drifted.scope, /1 stale pin/);
  assert.match(toDot(drifted).split("\n").find((l) => l.includes(`"${pinsD3.id}" -> "${d3.id}"`))!, /style=dashed, color="#cf222e"/);

  // ---- ego graph ----
  const ego = buildGraph(cfg, { id: d1.id, depth: 1 });
  assert.deepEqual(new Set(ego.nodes.map((n) => n.id)), new Set([d1.id, d2.id, pinned.id, repro.id]),
    "depth 1 is d1 plus everything with an edge to it, in either direction");
  assert.equal(buildGraph(cfg, { id: d1.id, depth: 0 }).nodes.length, 1, "depth 0 is the object alone");
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
  // The regression this guards: a conflict head must not fall back to mermaid's default node style,
  // which would make it indistinguishable from an ordinary current record in the rendered picture.
  const conflictMermaidAll = toMermaid(conflicted);
  const headClass = conflictMermaidAll.split("\n").filter((l) => /^  class n\d+ currentAlarm$/.test(l));
  assert.equal(headClass.length, 2, "both heads carry a single defined alarm class");
  assert.match(conflictMermaidAll, /classDef currentAlarm[^\n]*stroke:#cf222e[^\n]*stroke-width:4px/);
  assert.ok(conflictMermaidAll.split("\n").filter((l) => /^  class n\d+ /.test(l)).every((l) => !l.includes(",")));
  const onlyConflicts = buildGraph({ ...b, git_sync: false }, { conflictsOnly: true });
  assert.ok(onlyConflicts.nodes.some((n) => n.id === ca.id) && onlyConflicts.nodes.some((n) => n.id === cb.id));
  assert.ok(onlyConflicts.nodes.some((n) => n.id === base.id), "the shared predecessor is kept so the conflict is legible");

  // ---- the scope line never lets a filtered picture read as the whole ledger ----
  assert.match(buildGraph(cfg, { types: ["finding"] }).scope, /types finding/);
  assert.match(buildGraph(cfg, { currentOnly: true }).scope, /current only/);
  assert.match(buildGraph(cfg).scope, /including superseded and drafts/);
  assert.match(buildGraph(cfg, { days: 7 }).scope, /last 7d/);


  // ---- the node is the question, the person is the ink ----
  // What a prospect or a teammate recognises is their own question, never `fnd-...-gyt8`, so the
  // label is derived per type and the id drops to the line underneath.
  const change = get(record(cfg, { type: "change", fields: { title: "Eligibility filter shipped",
    what: "Paywall eligibility filter shipped to Android IN at 100%", shipped_at: "2026-09-05",
    surface: "paywall", owner: "agaaz", scope: "Android IN, 100%" } }).id);
  // A record written before `question` existed: the only shape that can reach the title fallback,
  // because the write path has required the field ever since. Written by hand for that reason.
  const legacyId = "fnd-20260820-legacy-cut-with-no-question-field-0000";
  fs.writeFileSync(path.join(cfg.ledger_dir, "findings", `${legacyId}.md`), [
    "---", "type: finding", `id: ${legacyId}`,
    "title: Legacy cut recorded before the question field existed",
    "status: stable", "generated:", "  by: 'human:rachit'", "  at: '2026-08-20T00:00:00.000Z'",
    "result: Kept for the fallback path only.", "---", "",
  ].join("\n"));

  const labelled = buildGraph(cfg);
  assert.equal(node(labelled, pinned.id).headline, "Does Android trial conversion differ by intent?", "a finding is its question");
  assert.equal(node(labelled, decision.id).headline, "Run the next paywall test on marriage intent", "a decision is the decision");
  assert.equal(node(labelled, d2.id).headline, "trial_cvr", "a definition is the metric it fixes, not its prose title");
  assert.equal(node(labelled, change.id).headline, "Paywall eligibility filter shipped to Android IN at 100%", "a change is what shipped");
  assert.equal(node(labelled, legacyId).headline, "Legacy cut recorded before the question field existed",
    "a record with no words of its own falls back to its title, never to an empty node");

  const mermaid = toMermaid(labelled);
  const aliasOf = (g: Graph, id: string) => `n${g.nodes.findIndex((x) => x.id === id)}`;
  const nodeLine = (m: string, g: Graph, id: string) => {
    const l = m.split("\n").find((x) => new RegExp(`^  ${aliasOf(g, id)}[([{]`).test(x));
    assert.ok(l, `expected a rendered node for ${id}`);
    return l;
  };
  const classesOf = (m: string, g: Graph, id: string) =>
    m.split("\n").filter((l) => l.startsWith(`  class ${aliasOf(g, id)} `)).map((l) => l.split(" ").at(-1)!);
  const labelParts = (line: string) => line.slice(line.indexOf('"') + 1, line.lastIndexOf('"')).split("<br/>");

  // The question leads, the id stays available on the next line, the author is written out.
  assert.deepEqual(labelParts(nodeLine(mermaid, labelled, pinned.id)).slice(0, 3),
    ["Does Android trial conversion differ by intent?", pinned.id, "by agaaz"]);
  for (const n of labelled.nodes)
    assert.ok(labelParts(nodeLine(mermaid, labelled, n.id)).includes(`by ${n.author}`),
      "the author is spelled out on every node: a channel that exists only as a hue is not readable");

  // ---- a real question carries mermaid's syntax characters, and must survive as text ----
  const hostileText = 'Did "eligible" (v2) cover {chat|voice} [IN] <5% & >95% #1 `x`?';
  const hostileFields = (() => { const f: Record<string, unknown> = finding("Hostile characters in the question", [],
    { question: hostileText, definitions_used: [] }); delete f.analysis_scope; return f; })();
  const hostile = get(record(cfg, { type: "finding", fields: hostileFields }).id);
  const escaped = buildGraph(cfg);
  const hostileLabel = labelParts(nodeLine(toMermaid(escaped), escaped, hostile.id))[0];
  assert.match(hostileLabel, /#quot;eligible#quot;/);
  assert.match(hostileLabel, /#40;v2#41;/);
  assert.match(hostileLabel, /#123;chat#124;voice#125;/);
  assert.match(hostileLabel, /#91;IN#93;/);
  assert.match(hostileLabel, /#35;1 #96;x#96;/);
  // Angle brackets are not entities: GitHub renders the block with htmlLabels on, where a decoded
  // `<` would be a tag rather than text.
  assert.match(hostileLabel, /‹5% & ›95%/);
  const bare = hostileLabel.replace(/#(?:\d+|[a-z]+);/g, "");
  for (const ch of ['"', "|", "(", ")", "[", "]", "{", "}", "#", "`", "<", ">"])
    assert.ok(!bare.includes(ch), `a bare ${ch} inside a label is mermaid syntax, not text`);
  for (const line of toMermaid(escaped, true).split("\n"))
    assert.equal((line.match(/"/g) ?? []).length % 2, 0, `unbalanced quotes would break the GitHub renderer: ${line}`);

  // ---- author is ink, and ink never touches the channel tier owns ----
  const ink = authorInk(escaped.nodes);
  assert.deepEqual([...ink.keys()], ["agaaz", "rachit"],
    "ink is assigned in sorted author order: GRAPH.md re-renders on every push and must not churn");
  assert.notEqual(ink.get("agaaz")!.color, ink.get("rachit")!.color);
  const rendered = toMermaid(escaped);
  for (const def of rendered.split("\n").filter((l) => /^  classDef (current|draft|retired)/.test(l)))
    assert.doesNotMatch(def, /(?:^|,)color:/, "tier sets no label colour: that is the author's channel, and one property cannot carry two claims");
  for (const [, v] of ink)
    assert.ok(rendered.split("\n").includes(`  classDef ${v.cls} color:${v.color}`), `author class ${v.cls} sets ink and nothing else`);
  assert.deepEqual(classesOf(rendered, escaped, pinned.id), ["current", ink.get("agaaz")!.cls],
    "tier class first, author class second, one token per statement");
  assert.deepEqual(classesOf(rendered, escaped, legacyId), ["current", ink.get("rachit")!.cls]);
  assert.deepEqual(classesOf(rendered, escaped, d1.id), ["retired", ink.get("agaaz")!.cls],
    "a retired record keeps its author's ink: a channel that vanishes on some nodes is not a channel");

  // The two channels are orthogonal in dot as well: same tier and different people differ only in
  // ink; same person across tiers differs only in border.
  const dotLine = (d: string, id: string) => {
    const l = d.split("\n").find((x) => x.startsWith(`  "${id}" [`));
    assert.ok(l, `expected a rendered node for ${id}`);
    return l;
  };
  const dotAll = toDot(escaped);
  const border = (l: string) => l.match(/, color="(#[0-9a-f]{6})"/)![1];
  const fontcolor = (l: string) => l.match(/fontcolor="(#[0-9a-f]{6})"/)![1];
  assert.equal(border(dotLine(dotAll, pinned.id)), border(dotLine(dotAll, legacyId)));
  assert.notEqual(fontcolor(dotLine(dotAll, pinned.id)), fontcolor(dotLine(dotAll, legacyId)));
  assert.notEqual(border(dotLine(dotAll, pinned.id)), border(dotLine(dotAll, d1.id)), "tier still owns the border");
  assert.equal(fontcolor(dotLine(dotAll, pinned.id)), fontcolor(dotLine(dotAll, d1.id)));
  assert.equal(fontcolor(dotLine(dotAll, pinned.id)), ink.get("agaaz")!.color);

  // ---- the legend says which colour is whose, in words ----
  const legendMermaid = toMermaid(escaped, true);
  assert.match(legendMermaid, /subgraph authors\["who recorded it/);
  const legendDot = toDot(escaped, true);
  assert.match(legendDot, /subgraph cluster_authors/);
  for (const [author, v] of ink) {
    assert.ok(legendMermaid.includes(`["by ${author}"]`), "the legend names the person, so the key is readable without the colour");
    assert.match(legendMermaid, new RegExp(`^    class A\\d+ ${v.cls}$`, "m"));
    assert.ok(legendDot.includes(`[label="by ${author}", shape=plaintext, fontcolor="${v.color}"]`));
  }
  // The tier legend is still the first key drawn, and still shows tier as border and fill.
  assert.ok(legendMermaid.indexOf("subgraph legend[") < legendMermaid.indexOf("subgraph authors["));
  assert.ok(legendDot.indexOf("cluster_legend") < legendDot.indexOf("cluster_authors"));

  // ---- --labels id: the address leads, the words stay ----
  assert.equal(buildGraph(cfg).labels, "question", "the default leads with the question; the id is an address, not information");
  const byId = buildGraph(cfg, { labels: "id" });
  assert.equal(byId.labels, "id");
  assert.deepEqual(labelParts(nodeLine(toMermaid(byId), byId, pinned.id)).slice(0, 3),
    [pinned.id, "Pinned to the definition", "by agaaz"]);
  assert.match(byId.scope, /labelled by id/);
  assert.match(escaped.scope, /labelled by question/);

  // ---- neither the new label nor the new ink introduced an ordering or downgraded a named edge ----
  const decisionToPinned = rendered.split("\n").find((l) =>
    l.startsWith(`  ${aliasOf(escaped, decision.id)} `) && l.endsWith(` ${aliasOf(escaped, pinned.id)}`))!;
  assert.match(decisionToPinned, /-\.->\|"evidence: no pinned version"\|/, "a named reference is still dashed and still labelled");
  for (const out of [rendered, legendMermaid, dotAll, legendDot, toMermaid(byId), toDot(byId, true)]) {
    assert.doesNotMatch(out, /\brank\s*=/, "a rank constraint would let position assert recency");
    assert.doesNotMatch(out, /\b20\d\d-\d\d-\d\d\b/, "no date reaches the rendered graph, not even through a label");
  }

  console.log("graph: pinned-vs-named edges, tier styling, no date in the layout, correction blast radius, reproduction, ego walk, undirected unresolved conflicts, per-type labels, mermaid escaping, and the author ink channel tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
