import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { correctionImpact, dependents, objectVersion, resolveAccepted, snapshotIdentity, snapshotsDiffer, verification } from "./authority.js";
import { getById, loadAll, record, type Config } from "./store.js";
import { analyticalContext } from "./investigation.js";
import type { Acceptance, AnalysisScope, Dependency, LedgerObject } from "./schema.js";

// No initLedger(), environment reconfiguration, network, user data, or live config writes.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-claims-test-"));
const cfg: Config = { ledger_dir: path.join(tmp, "knowledge"), author: "agaaz", git_sync: false };
const other: Config = { ...cfg, author: "rachit" };
const scope: AnalysisScope = { product: "HiAstro", dataset: "fixture-paywall-v1", environment: "test", metric: "paywall_cvr",
  population: "Android IN users shown the paywall", grain: "user", attribution_rule: "trial within seven days of first impression" };
const omitUndefined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const get = (id: string) => { const o = getById(cfg, id); assert.ok(o); return o; };
const dep = (o: LedgerObject, relation: Dependency["relation"] = "uses-definition"): Dependency => ({ relation, id: o.id, version: objectVersion(o) });
const accept = (o: LedgerObject, actor = "agaaz"): Acceptance => ({ actor, accepted_at: "2026-09-10",
  evidence_refs: [{ artifact_id: o.id, sha256: objectVersion(o), role: "review" }], expected_predecessor: { id: o.id, version: objectVersion(o) } });

try {
  const d1 = get(record(cfg, { type: "definition", fields: { title: "Paywall trial conversion", metric: "paywall_cvr",
    formula: "trial users / users shown the paywall", source: "fixture://paywall", owner: "agaaz", valid_from: "2026-08-01", analysis_scope: scope } }).id);

  const claim = (title: string, patch: Record<string, unknown> = {}) => omitUndefined({ title,
    question: "Does paywall A convert better than paywall B on Android?", result: "A converted at 12.4% against B at 10.5%",
    definitions_used: ["paywall_cvr"], data_window: { from: "2026-08-20", to: "2026-08-31" },
    inputs: [{ source: "fixture://paywall", snapshot_at: "2026-09-01" }],
    method: "Per-user trial conversion compared between the two paywall arms.",
    assumptions: [{ statement: "Arm assignment is logged on every impression", kind: "implicit" }],
    analysis_scope: scope, dependencies: [dep(d1)], query: "SELECT arm, countIf(trial)/count() FROM paywall GROUP BY arm", ...patch });
  // Explicit `undefined` in a fixture spread would otherwise be written into frontmatter.


  // ---------- 1. claim-shaped obligations ----------
  // A legacy finding with no claim_type keeps working: unclassified is reported, never assumed measured.
  const legacy = get(record(cfg, { type: "finding", fields: claim("Unclassified legacy claim", { query: undefined }) }).id);
  assert.equal(legacy.fields.claim_type, undefined);

  assert.throws(() => record(cfg, { type: "finding", fields: claim("Measurement with no recipe", { claim_type: "measurement", query: undefined }) }),
    /a measurement claim requires: `query`/, "a measurement nobody can re-run is refused, and the message names the field");
  assert.throws(() => record(cfg, { type: "finding", fields: claim("Comparison with no baseline", { claim_type: "comparison" }) }),
    /`baseline`[\s\S]*`confidence_basis`/, "a comparison names both missing fields in one message, not one per round trip");
  assert.throws(() => record(cfg, { type: "finding", fields: claim("Explanation from the outcome alone", { claim_type: "explanation" }) }),
    /`discriminating_test`[\s\S]*alternatives_considered[\s\S]*derived-from/, "an explanation cannot inherit a measurement's standing");
  // Work in progress is exempt: the rules are about what an accepted claim must carry.
  record(cfg, { type: "finding", fields: claim("Explanation still being worked out", { claim_type: "explanation", status: "draft" }) });

  const measured = get(record(cfg, { type: "finding", fields: claim("A converts better than B", { claim_type: "comparison",
    baseline: "paywall B", confidence_basis: "41,200 vs 118,900 users; arms balanced 51/49" }) }).id);
  const explained = get(record(cfg, { type: "finding", fields: omitUndefined({ ...claim("Urgency copy explains A's lift", { claim_type: "explanation" }),
    question: "Why does paywall A convert better?", result: "A's countdown copy creates urgency",
    analysis_scope: undefined, definitions_used: [], dependencies: [dep(measured, "derived-from")],
    alternatives_considered: ["A's price anchor, not its urgency copy, drives the lift: not yet separated"],
    discriminating_test: "Ship A's copy without the countdown timer; urgency predicts the lift disappears, anchoring predicts it survives." }) }).id);
  assert.equal(explained.fields.claim_type, "explanation");

  // ---------- 2. reproduction: the tier acceptance does not provide ----------
  const reproduction = (patch: Record<string, unknown>) => omitUndefined({ title: "Re-ran the A/B comparison", claim_type: "measurement",
    question: "Does the paywall A vs B comparison reproduce?", result: "Re-ran the recorded query", source: "fixture://paywall",
    data_window: { from: "2026-08-20", to: "2026-08-31" }, inputs: [{ source: "fixture://paywall", snapshot_at: "2026-09-01" }],
    method: "Re-ran the recorded query against the same snapshot and compared the result.",
    assumptions: [{ statement: "The fixture snapshot is byte-identical to the original read", kind: "implicit" }],
    query: "SELECT arm, countIf(trial)/count() FROM paywall GROUP BY arm", ...patch });

  assert.throws(() => record(other, { type: "finding", fields: reproduction({
    reproduction_of: { id: measured.id, version: "0".repeat(64), outcome: "matched" }, dependencies: [dep(measured, "derived-from")] }) }),
    /reproduction_of version mismatch/, "a reproduction must name the exact version it re-ran");
  assert.throws(() => record(other, { type: "finding", fields: reproduction({
    reproduction_of: { id: measured.id, version: objectVersion(measured), outcome: "matched" } }) }),
    /a reproduction must pin what it re-ran[\s\S]*derived-from/, "the repair string is the dependency to paste, not the rule that was broken");

  assert.equal(verification(loadAll(cfg), measured).status, "unreproduced", "accepted is not reproduced");
  const rerun = get(record(other, { type: "finding", fields: reproduction({
    reproduction_of: { id: measured.id, version: objectVersion(measured), outcome: "matched" }, dependencies: [dep(measured, "derived-from")] }) }).id);
  const after = verification(loadAll(cfg), measured);
  assert.equal(after.status, "reproduced");
  assert.ok(after.attempts.some(a => a.id === rerun.id && a.independent), "a different author's re-run is independent");
  assert.equal(after.notes.length, 0);

  // Self-reproduction is recorded, and labelled for what it is.
  const selfRun = get(record(cfg, { type: "finding", fields: { ...reproduction({
    reproduction_of: { id: explained.id, version: objectVersion(explained), outcome: "matched" }, dependencies: [dep(explained, "derived-from")] }),
    title: "Author re-ran their own explanation check" } }).id);
  assert.equal(selfRun.author, "agaaz");
  assert.equal(verification(loadAll(cfg), explained).status, "reproduced");
  assert.match(verification(loadAll(cfg), explained).notes.join(" "), /not an independent reproduction/);

  // A re-run that disagrees contests the record rather than replacing it.
  const disputed = get(record(cfg, { type: "finding", fields: claim("Second measured comparison", { claim_type: "comparison",
    title: "Second measured comparison", baseline: "paywall B", confidence_basis: "same arms, recomputed" }) }).id);
  record(other, { type: "finding", fields: reproduction({ title: "Re-run disagreed",
    reproduction_of: { id: disputed.id, version: objectVersion(disputed), outcome: "differed", note: "B led by 0.4pp on the same rows" },
    dependencies: [dep(disputed, "derived-from")] }) });
  const contested = verification(loadAll(cfg), disputed);
  assert.equal(contested.status, "contested");
  assert.match(contested.notes.join(" "), /did not match/);

  // An attempt against an earlier content_version never carries over to the current one.
  const drifted = loadAll(cfg).map(o => o.id === measured.id ? { ...o, body: "edited after the re-run" } : o);
  const stale = verification(drifted, drifted.find(o => o.id === measured.id)!);
  assert.equal(stale.status, "unreproduced");
  assert.match(stale.notes.join(" "), /earlier content_version/);

  // ---------- 3. snapshot: a re-read is not a disagreement ----------
  const parent = get(record(cfg, { type: "finding", fields: claim("Original snapshot claim", { title: "Original snapshot claim" }) }).id);
  const childA = get(record(cfg, { type: "finding", fields: claim("Corrected on the 09-01 snapshot",
    { title: "Corrected on the 09-01 snapshot", supersedes: parent.id, acceptance: accept(parent),
      correction: { effect: "historical", reason: "The original read double-counted repeat impressions" } }) }).id);
  const childB: LedgerObject = { ...childA, id: "competing-later-snapshot", path: `${childA.path}.competing`,
    fields: { ...childA.fields, inputs: [{ source: "fixture://paywall", snapshot_at: "2026-09-08" }] } };
  assert.ok(snapshotsDiffer(childA, childB));
  assert.equal(snapshotIdentity(childA), "2026-09-01");
  const reread = resolveAccepted([get(parent.id), childA, childB], parent.id);
  assert.equal(reread.status, "conflict", "a re-read still does not auto-resolve; recency never picks a winner");
  assert.match(reread.warnings.join(" "), /may be a re-read of changed source data/);

  const blindA: LedgerObject = { ...childA, fields: { ...childA.fields, inputs: [{ source: "fixture://paywall" }] } };
  const blindB: LedgerObject = { ...childB, fields: { ...childB.fields, inputs: [{ source: "fixture://paywall" }] } };
  const blind = resolveAccepted([get(parent.id), blindA, blindB], parent.id);
  assert.match(blind.warnings.join(" "), /snapshots are unrecorded[\s\S]*snapshot_at/, "unknown is neither agreement nor disagreement, and the message says how to fix it");

  // ---------- 4. blast radius decides who gets interrupted ----------
  const quiet = correctionImpact(loadAll(cfg), childA.id);
  assert.equal(quiet.interrupt.required, false);
  assert.match(quiet.interrupt.reason, /needs no one's attention yet/);
  record(cfg, { type: "finding", fields: { title: "Projection built on the original snapshot claim",
    question: "What does the paywall result imply for revenue?", result: "Projection pending review", source: "fixture://paywall",
    data_window: { from: "2026-08-20", to: "2026-08-31" }, inputs: [{ source: "fixture://paywall" }],
    method: "Use the original paywall claim as an input to a qualitative projection.",
    assumptions: [{ statement: "The paywall result transfers to the projection", kind: "implicit" }],
    dependencies: [dep(parent, "derived-from")] } });
  const loud = correctionImpact(loadAll(cfg), childA.id);
  assert.equal(loud.interrupt.required, true);
  assert.match(loud.interrupt.reason, /need review before reuse/);
  assert.ok(dependents(loadAll(cfg), parent.id).length >= 1);

  // ---------- 5. same-scope claims nobody linked ----------
  const rival = get(record(other, { type: "finding", fields: claim("Rachit's paywall comparison", { title: "Rachit's paywall comparison",
    claim_type: "comparison", baseline: "paywall A", confidence_basis: "same arms, independent pull",
    result: "B converted at 11.8% against A at 11.1%", inputs: [{ source: "fixture://paywall", snapshot_at: "2026-09-01" }] }) }).id);
  const pack = analyticalContext(loadAll(cfg), { question: "Does paywall A convert better than paywall B on Android?", scope, limit: 20 });
  const group = pack.unlinked.find(u => u.ids.includes(rival.id) && u.ids.includes(measured.id));
  assert.ok(group, "two same-scope, same-window claims with no supersession between them are flagged as possibly competing");
  assert.match(group!.reason, /no supersession relation/);
  assert.match(pack.text, /possibly competing, unlinked/);
  assert.ok(!pack.unlinked.some(u => u.ids.includes(explained.id)), "a differently scoped claim is not made to compete");
  // Mutually competing claims are one question, not one per pair: n claims must not cost n^2 warnings.
  assert.equal(pack.unlinked.length, 1, "competing claims are reported as one group, not every pair");
  assert.ok(group!.ids.length >= 3);
  assert.equal(pack.text.split("possibly competing, unlinked").length - 1, 1);
  assert.ok(!/## Uncertain[\s\S]*## Original/.test(pack.text) || pack.text.includes("NEEDS REVIEW"),
    "an empty section is omitted rather than printed as a heading the successor pays for");

  // ---------- 6. the successor reads three states and a next step ----------
  assert.match(pack.text, /## Verified: reproduced at this exact content_version/);
  assert.match(pack.text, /## Accepted, not independently reproduced/);
  assert.match(pack.text, /## Next check/);
  assert.ok(pack.next_checks.some(n => /Compare .* and /.test(n) && /(pin one of these|pins any of them)/.test(n)),
    "an unresolved disagreement says whether it changes what happens next");
  assert.ok(pack.next_checks.some(n => /Reproduce /.test(n)), "an accepted but never re-run measurement gets a concrete next step");
  assert.equal(pack.verification[measured.id].status, "reproduced");

  console.log("selftest-claims: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
