import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { correctionImpact, matchesAnalysisScope, objectVersion, projectAuthorityObjects, resolveAccepted, validateDependencies, validateSupersession } from "./authority.js";
import { getById, loadAll, pull, record, recordDraft, type Config } from "./store.js";
import type { Acceptance, AnalysisScope, Dependency, LedgerObject } from "./schema.js";
import { brief, search } from "./query.js";

// No initLedger(), environment reconfiguration, network, user data, or live config writes.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-authority-test-"));
const cfg: Config = { ledger_dir: path.join(tmp, "knowledge"), author: "agaaz", git_sync: false };
const scope: AnalysisScope = { product: "HiAstro", dataset: "fixture-conversion-v1", environment: "test", metric: "trial_cvr",
  population: "Android IN eligible users", grain: "user", attribution_rule: "trial within seven days of first eligible exposure" };
const definition = (patch: Record<string, unknown> = {}) => ({ title: "Eligible-user trial conversion", metric: "trial_cvr",
  formula: "trial users / exposed users", source: "fixture://conversion", owner: "agaaz", valid_from: "2026-08-01", analysis_scope: scope, ...patch });
const get = (id: string, conf = cfg) => { const o = getById(conf, id); assert.ok(o); return o; };
const dep = (o: LedgerObject, relation: Dependency["relation"] = "uses-definition"): Dependency => ({ relation, id: o.id, version: objectVersion(o) });
const accept = (o: LedgerObject, actor = "agaaz"): Acceptance => ({ actor, accepted_at: "2026-09-10T12:00:00Z",
  evidence_refs: [{ artifact_id: o.id, sha256: objectVersion(o), role: "review" }], expected_predecessor: { id: o.id, version: objectVersion(o) } });
const finding = (title: string, dependencies: Dependency[], patch: Record<string, unknown> = {}) => ({ title,
  question: "Does Android trial conversion differ by intent?", result: "Synthetic fixture result", definitions_used: ["trial_cvr"],
  data_window: { from: "2026-08-01", to: "2026-08-31" }, inputs: [{ source: "fixture://conversion" }],
  method: "Count distinct trial users divided by distinct eligible exposed users.", assumptions: [{ statement: "Synthetic fixture captures every exposure", kind: "implicit" }],
  analysis_scope: scope, dependencies, ...patch });

try {
  const d1 = get(record(cfg, { type: "definition", fields: definition() }).id);
  assert.equal(d1.author, cfg.author);
  assert.throws(() => record(cfg, { type: "definition", fields: definition({ author: "rachit" }) }), /record author must match configured Ledger author/);
  assert.throws(() => recordDraft(cfg, { type: "definition", fields: definition({ author: "rachit" }),
    capture: { method: "transcript_fallback", session: "synthetic-other-author", reason: "preserve source attribution" } }), /record author must match configured Ledger author/);
  const delegatedMetric = get(record(cfg, { type: "definition", fields: definition({ title: "Different metric owner", author: cfg.author, owner: "rachit", metric: "owned_elsewhere", analysis_scope: { ...scope, metric: "owned_elsewhere" } }) }).id);
  assert.equal(delegatedMetric.author, cfg.author, "new record uses the configured human attribution");
  assert.equal(delegatedMetric.fields.owner, "rachit", "metric ownership remains separate from who recorded it");
  const originalBytes = fs.readFileSync(d1.path, "utf8");
  const proposed = recordDraft(cfg, { type: "definition", fields: definition({ title: "Unreviewed denominator", formula: "trials / sessions", supersedes: d1.id }),
    capture: { method: "transcript_fallback", session: "synthetic-claude", reason: "review denominator" } });
  assert.equal(get(d1.id).status, "stable");
  assert.equal(fs.readFileSync(d1.path, "utf8"), originalBytes, "draft persistence leaves accepted bytes untouched");
  assert.deepEqual(resolveAccepted(loadAll(cfg), proposed.id).current.map((o) => o.id), [d1.id]);
  assert.equal(resolveAccepted(loadAll(cfg), d1.id).proposals[0].id, proposed.id);

  assert.throws(() => record(cfg, { type: "definition", fields: definition({ supersedes: "def-missing" }) }), /target not found/);
  assert.throws(() => record(cfg, { type: "definition", fields: definition({ supersedes: d1.id, metric: "different_metric" }) }), /metric identity/);
  assert.throws(() => record(cfg, { type: "definition", fields: definition({ supersedes: d1.id, analysis_scope: { ...scope, grain: "user-day" } }) }), /analytical scope/);
  assert.throws(() => record(cfg, { type: "definition", fields: definition({ supersedes: d1.id }) }), /requires acceptance/);
  assert.throws(() => record(cfg, { type: "definition", fields: definition({ supersedes: d1.id, acceptance: accept(d1, "rachit") }) }), /configured Ledger author/);
  assert.throws(() => record(cfg, { type: "definition", fields: definition({ supersedes: d1.id, acceptance: { ...accept(d1), expected_predecessor: { id: d1.id, version: "0".repeat(64) } } }) }), /predecessor\/version mismatch/);
  assert.throws(() => record(cfg, { type: "definition", fields: definition({ supersedes: proposed.id, acceptance: accept(get(proposed.id)) }) }), /original predecessor directly/);
  assert.throws(() => record(cfg, { type: "definition", fields: definition({ analysis_scope: { ...scope, product: " " } }) }), /analysis_scope/);
  assert.throws(() => record(cfg, { type: "definition", fields: definition({ correction: { effect: "future_only", reason: "new rule" } }) }), /effective_from/);
  assert.throws(() => record(cfg, { type: "definition", fields: definition({ correction: { effect: "historical", reason: "repair", effective_from: "2026-09-02", effective_to: "2026-09-01" } }) }), /effective_from must not/);
  const cycA = { ...d1, id: "cyclic-a", supersedes: "cyclic-b" };
  const cycB = { ...d1, id: "cyclic-b", supersedes: "cyclic-a" };
  assert.throws(() => validateSupersession([cycA, cycB], "definition", definition({ status: "draft", supersedes: cycA.id }), "agaaz"), /cyclic/);
  assert.equal(resolveAccepted([cycA, cycB], cycA.id).status, "unavailable");

  const f1 = get(record(cfg, { type: "finding", fields: finding("Intent cohort A", [dep(d1)]) }).id);
  const f2 = get(record(cfg, { type: "finding", fields: finding("Intent cohort B", [dep(d1)]) }).id);
  assert.throws(()=>record(cfg,{type:'finding',fields:finding('Missing definition pin',[])}),/requires an exact uses-definition/);
  const {analysis_scope: _followupScope,...followupFields}=finding("Follow-up investigation",[dep(f1,"derived-from")],{definitions_used:[]});
  const followup = get(record(cfg, { type: "finding", fields: followupFields }).id);
  const unrelatedDef = get(record(cfg, { type: "definition", fields: definition({ title: "iOS conversion", analysis_scope: { ...scope, population: "iOS IN eligible users" } }) }).id);
  const unrelated = get(record(cfg, { type: "finding", fields: finding("Unrelated iOS", [dep(unrelatedDef)], { analysis_scope: unrelatedDef.fields.analysis_scope }) }).id);
  const d2 = get(record(cfg, { type: "definition", fields: definition({ title: "Corrected eligible-user denominator", formula: "trial users / eligible exposed users",
    supersedes: d1.id, correction: { effect: "historical", reason: "Ineligible exposures inflated the denominator" }, acceptance: accept(d1) }) }).id);
  assert.equal(objectVersion(get(d1.id)), objectVersion(d1), "lifecycle mutation cannot alter dependency version");
  assert.equal(get(d1.id).body, d1.body);
  assert.deepEqual(resolveAccepted(loadAll(cfg), d1.id).current.map((o) => o.id), [d2.id]);
  assert.throws(() => record(cfg, { type: "definition", fields: definition({ supersedes: d1.id, acceptance: accept(d1) }) }), /no longer the sole accepted predecessor/);
  assert.throws(() => validateDependencies(loadAll(cfg), { dependencies: [{ ...dep(d2), version: "f".repeat(64) }] }), /version mismatch/);
  assert.throws(() => validateDependencies(loadAll(cfg), { dependencies: [{ ...dep(d2), id: "def-unknown" }] }), /not found/);
  assert.throws(() => record(cfg, { type: "definition", fields: definition({ evidence_refs: [{ artifact_id: d2.id, sha256: "0".repeat(64), role: "query" }] }) }), /knowledge evidence version mismatch/);
  assert.throws(() => record(cfg, { type: "finding", fields: finding("Do not revive the old denominator", [dep(d1)]) }), /sole applicable accepted definition/);
  const historicalDraft = record(cfg, { type: "finding", fields: finding("Preserved historical reasoning", [dep(d1)], { status: "draft" }) });
  assert.equal(get(historicalDraft.id).status, "draft");
  const impact = correctionImpact(loadAll(cfg), d2.id);
  assert.deepEqual(new Set(impact.affected.map((o) => o.id)), new Set([f1.id, f2.id, followup.id]));
  assert.deepEqual(impact.affected.find((o) => o.id === followup.id)?.path, [d2.id, d1.id, f1.id, followup.id]);
  assert.ok(!impact.affected.some((o) => o.id === unrelated.id));
  assert.equal(impact.complete, true, "known unrelated analytical scopes do not contaminate the assessed lineage");
  const scopedImpact = correctionImpact([d1, d2, f1, f2, followup], d2.id);
  assert.equal(scopedImpact.complete, true);
  const d3 = { ...d2, id: "third-definition", supersedes: d2.id, fields: { ...d2.fields, formula: "mature trial users / eligible exposed users" } };
  const secondCycle = correctionImpact([d1, d2, d3, f1, f2, followup], d3.id);
  assert.deepEqual(new Set(secondCycle.affected.map(o => o.id)), new Set([f1.id, f2.id, followup.id]),
    "a second correction retains review obligations pinned to an earlier predecessor");
  assert.deepEqual(secondCycle.affected.find(o => o.id === followup.id)?.path, [d3.id, d2.id, d1.id, f1.id, followup.id]);
  assert.equal(matchesAnalysisScope(d2, { product: "HiAstro", grain: "user" }), true);
  assert.equal(matchesAnalysisScope(d2, { product: "other" }), false);
  assert.equal(matchesAnalysisScope(f1, { ...scope, window: { from: "2026-10-01", to: "2026-10-31" } }), false, "a finding's data_window is an applicability constraint");
  assert.equal(matchesAnalysisScope(f1, { ...scope, window: { from: "2026-08-01", to: "2026-08-07" } }), false, "a monthly aggregate cannot become a weekly claim");
  assert.equal(matchesAnalysisScope(f1, { ...scope, window: { from: "2026-08-01", to: "2026-08-31" } }), true);
  assert.equal(matchesAnalysisScope(d2, { ...scope, window: { from: "2026-08-01", to: "2026-08-31" } }), true,
    "definition without a window applies to a narrower analytical window");
  const broader = { ...d2, fields: { ...d2.fields, analysis_scope: { ...scope, window: { from: "2026-01-01", to: "2026-12-31" } } } };
  assert.equal(matchesAnalysisScope(broader, { ...scope, window: { from: "2026-08-01", to: "2026-08-31" } }), true);
  assert.equal(matchesAnalysisScope(broader, { ...scope, window: { from: "2025-08-01", to: "2026-08-31" } }), false);

  const legacy = { ...f1, id: "legacy-finding", fields: { ...f1.fields, dependencies: undefined } };
  const incomplete = correctionImpact([d1, d2, f1, legacy], d2.id);
  assert.equal(incomplete.complete, false);
  assert.ok(incomplete.incomplete.some((o) => o.id === legacy.id));
  const damagedOld = { ...d1, status: "deprecated" as const, superseded_by: proposed.id };
  assert.deepEqual(resolveAccepted([damagedOld, get(proposed.id)], d1.id).current.map((o) => o.id), [d1.id]);
  assert.ok(resolveAccepted([damagedOld, get(proposed.id)], d1.id).warnings.some(w => /legacy acceptance provenance is unknown/.test(w)));
  assert.ok(!resolveAccepted([{ ...damagedOld, previous_status: "stable" }, get(proposed.id)], d1.id).warnings.some(w => /legacy acceptance provenance is unknown/.test(w)), "verified previous lifecycle avoids the legacy inference warning");
  assert.equal(damagedOld.previous_status, undefined, "read warning does not migrate or guess original status");
  const unknownScope = { ...d1, id: "legacy-definition", fields: { ...d1.fields, analysis_scope: undefined } };
  assert.equal(resolveAccepted([unknownScope], unknownScope.id).scope_status, "unknown");
  assert.equal(matchesAnalysisScope(unknownScope, { product: "HiAstro" }), false);

  const later = { ...d2, id: "future-definition", fields: { ...d2.fields, correction: { effect: "future_only", effective_from: "2026-10-01", reason: "Future policy" } } };
  assert.deepEqual(resolveAccepted([d1, later], d1.id, { asOf: "2026-09-10" }).current.map((o) => o.id), [d1.id]);
  assert.deepEqual(resolveAccepted([d1, later], d1.id, { asOf: "2026-10-01" }).current.map((o) => o.id), [later.id]);
  assert.deepEqual(resolveAccepted([d1, later], d1.id, { scope: { ...scope, window: { from: "2026-08-01", to: "2026-08-31" } } }).current.map((o) => o.id), [d1.id],
    "a historical task window selects the applicable predecessor rather than today's definition");
  assert.equal(matchesAnalysisScope(later, { ...scope, window: { from: "2026-08-01", to: "2026-08-31" } }), false);
  assert.doesNotThrow(() => validateDependencies([d1, later], finding("Past-window definition still applies", [dep(d1)]), "finding"));
  assert.throws(() => validateDependencies([d1, later], finding("Window crosses two definitions", [dep(later)], { data_window: { from: "2026-09-01", to: "2026-10-31" } }), "finding"), /sole applicable accepted definition/);
  const acrossFuture = { from: "2026-09-01", to: "2026-10-31" };
  const acrossFutureResolution = resolveAccepted([d1, later], d1.id, { scope: { ...scope, window: acrossFuture } });
  assert.equal(acrossFutureResolution.status, "unavailable");
  assert.deepEqual(acrossFutureResolution.current, []);
  assert.ok(acrossFutureResolution.warnings.some(w => /split the analysis window/.test(w)));
  assert.throws(() => validateDependencies([d1, later], finding("Old version cannot cover a future transition", [dep(d1)], { data_window: acrossFuture }), "finding"), /sole applicable accepted definition/);
  const bounded = { ...later, id: "bounded-midwindow-definition", fields: { ...later.fields,
    correction: { effect: "historical", effective_from: "2026-09-10", effective_to: "2026-09-20", reason: "Bounded historical correction" } } };
  const wholeSeptember = { from: "2026-09-01", to: "2026-09-30" };
  assert.deepEqual(resolveAccepted([d1, bounded], d1.id, { asOf: wholeSeptember.from }).current.map(o => o.id), [d1.id]);
  assert.deepEqual(resolveAccepted([d1, bounded], d1.id, { asOf: wholeSeptember.to }).current.map(o => o.id), [d1.id]);
  assert.equal(resolveAccepted([d1, bounded], d1.id, { scope: { ...scope, window: wholeSeptember } }).status, "unavailable", "matching endpoints cannot hide an interior correction");
  assert.throws(() => validateDependencies([d1, bounded], finding("Bounded correction changes the middle", [dep(d1)], { data_window: wholeSeptember }), "finding"), /sole applicable accepted definition/);
  assert.throws(() => validateDependencies([d1, bounded], finding("Unscoped exact pins still honor the full window", [dep(d1)], { analysis_scope: undefined, data_window: wholeSeptember }), "finding"), /sole applicable accepted definition/);
  assert.deepEqual(resolveAccepted([d1, bounded], d1.id, { scope: { ...scope, window: { from: "2026-09-12", to: "2026-09-19" } } }).current.map(o => o.id), [bounded.id]);
  const endsEarly = { ...d1, id: "scope-limited-definition", fields: { ...d1.fields, analysis_scope: { ...scope, window: { from: "2026-09-01", to: "2026-09-10" } } } };
  const startsLate = { ...later, id: "scope-resumed-definition", supersedes: endsEarly.id, fields: { ...later.fields,
    correction: undefined, analysis_scope: { ...scope, window: { from: "2026-09-20", to: "2026-10-31" } } } };
  assert.equal(resolveAccepted([endsEarly, startsLate], endsEarly.id, { scope: { ...scope, window: wholeSeptember } }).status, "unavailable", "scope applicability gap is not a current definition");
  assert.equal(resolveAccepted([endsEarly, startsLate], endsEarly.id, { asOf: "2026-09-15" }).status, "unavailable", "point resolution honors definition scope bounds");
  assert.deepEqual(resolveAccepted([endsEarly, startsLate], endsEarly.id, { scope: { ...scope, window: { from: "2026-09-21", to: "2026-09-30" } } }).current.map(o => o.id), [startsLate.id], "old ID can resolve its applicable successor beyond its own window");
  const conflictingBounded = { ...bounded, id: "competing-bounded-definition" };
  const intervalConflict = resolveAccepted([d1, bounded, conflictingBounded], d1.id, { scope: { ...scope, window: wholeSeptember } });
  assert.equal(intervalConflict.status, "conflict", "concurrent accepted branches inside a window remain explicit conflicts");
  assert.deepEqual(new Set(intervalConflict.current.map(o => o.id)), new Set([bounded.id, conflictingBounded.id]));
  const futureImpact = correctionImpact([d1, later, f1, f2, followup], later.id);
  assert.equal(futureImpact.affected.length, 0);
  assert.deepEqual(new Set(futureImpact.excluded.map((o) => o.id)), new Set([f1.id, f2.id]));
  assert.equal(projectAuthorityObjects([d1, later], { asOf: "2026-09-10" }).find((o) => o.id === d1.id)?.status, "stable");
  assert.equal(projectAuthorityObjects([d1, later], { asOf: "2026-09-10" }).find((o) => o.id === later.id)?.superseded_by, undefined,
    "future acceptance is not falsely described as superseded by its predecessor");

  const oldWindow = { from: "2000-08-01", to: "2000-08-31" };
  const historicalScope = { ...scope, window: oldWindow };
  const historicalBase = get(record(cfg, { type: "definition", fields: definition({ title: "Expired historical definition", analysis_scope: historicalScope }) }).id);
  const historicalCorrection = get(record(cfg, { type: "definition", fields: definition({ title: "Accepted correction of expired definition", analysis_scope: historicalScope,
    supersedes: historicalBase.id, correction: { effect: "historical", reason: "Repair the bounded historical denominator" }, acceptance: accept(historicalBase) }) }).id);
  assert.deepEqual(resolveAccepted(loadAll(cfg), historicalBase.id, { scope: historicalScope }).current.map(o => o.id), [historicalCorrection.id]);
  assert.throws(() => record(cfg, { type: "definition", fields: definition({ title: "Do not accept a second historical successor", analysis_scope: historicalScope,
    supersedes: historicalBase.id, acceptance: accept(historicalBase) }) }), /no longer the sole accepted predecessor/);
  const correctionBoundedBase = get(record(cfg, { type: "definition", fields: definition({ title: "Correction-bounded historical definition",
    correction: { effect: "historical", reason: "Applies within the historical interval", effective_from: oldWindow.from, effective_to: oldWindow.to } }) }).id);
  const correctionBoundedReplacement = get(record(cfg, { type: "definition", fields: definition({ title: "Review correction-bounded history",
    supersedes: correctionBoundedBase.id, correction: { effect: "historical", reason: "Correct the old interval", effective_from: oldWindow.from, effective_to: oldWindow.to }, acceptance: accept(correctionBoundedBase) }) }).id);
  assert.deepEqual(resolveAccepted(loadAll(cfg), correctionBoundedBase.id, { scope: { ...scope, window: oldWindow } }).current.map(o => o.id), [correctionBoundedReplacement.id]);
  const reservedFuture = { ...historicalBase, id: "future-reserved-historical-successor", supersedes: historicalBase.id,
    fields: { ...historicalBase.fields, analysis_scope: { ...scope, window: { from: "2999-01-01", to: "2999-12-31" } } } };
  assert.throws(() => validateSupersession([historicalBase, reservedFuture], "definition", definition({ supersedes: historicalBase.id,
    analysis_scope: historicalScope, acceptance: accept(historicalBase) }), cfg.author), /already has an accepted successor/, "historical acceptance cannot bypass a reserved future successor");

  // Two local Git replicas accept before seeing the other's write. Both branches survive sync; no latest-wins answer.
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const remote = path.join(tmp, "remote.git");
  git(tmp, ["init", "--bare", remote]);
  const replicaA = path.join(tmp, "replica-a");
  git(tmp, ["clone", remote, replicaA]);
  for (const cwd of [replicaA]) { git(cwd, ["config", "user.name", "Authority fixture"]); git(cwd, ["config", "user.email", "fixture@ledger.invalid"]); }
  const a: Config = { ledger_dir: replicaA, author: "agaaz", git_sync: true };
  const base = get(record(a, { type: "definition", fields: definition() }).id, a);
  git(replicaA, ["push", "--set-upstream", "origin", "HEAD"]);
  const replicaB = path.join(tmp, "replica-b");
  git(tmp, ["clone", remote, replicaB]);
  git(replicaB, ["config", "user.name", "Authority fixture"]); git(replicaB, ["config", "user.email", "fixture@ledger.invalid"]);
  const b: Config = { ledger_dir: replicaB, author: "rachit", git_sync: false };
  const aOffline = { ...a, git_sync: false };
  const ca = record(aOffline, { type: "definition", fields: definition({ title: "Agaaz accepted correction", supersedes: base.id, acceptance: accept(base) }) });
  const cb = record(b, { type: "definition", fields: definition({ title: "Rachit accepted correction", supersedes: base.id, acceptance: accept(get(base.id, b), "rachit") }) });
  git(replicaA, ["add", "."]); git(replicaA, ["commit", "-m", "fixture A acceptance"]); git(replicaA, ["push"]);
  git(replicaB, ["add", "."]); git(replicaB, ["commit", "-m", "fixture B acceptance"]);
  assert.equal(pull({ ...b, git_sync: true }, true), null);
  const conflict = resolveAccepted(loadAll(b), base.id);
  assert.equal(conflict.status, "conflict");
  assert.deepEqual(new Set(conflict.current.map((o) => o.id)), new Set([ca.id, cb.id]));
  assert.ok(conflict.warnings.some((w) => /explicit resolution/.test(w)));
  const conflictSearch = search(b, "Agaaz accepted correction", { limit: 1, scope });
  assert.deepEqual(new Set(conflictSearch.map(o => o.id)), new Set([ca.id, cb.id]), "search limit cannot hide a competing accepted branch");
  assert.ok(conflictSearch.every(o => o.authority_status === "conflict"));
  assert.ok(conflictSearch.every(o => o.authority_warnings.some(w => /competing accepted/.test(w))));
  assert.match(brief(b, { scope }), /UNRESOLVED ACCEPTED CONFLICT/);

  const neverAccepted = get(record(cfg,{type:'definition',fields:definition({title:'Standalone unaccepted proposal',status:'draft'})}).id);
  const originalDraftVersion=objectVersion(neverAccepted);
  record(cfg,{type:'definition',fields:definition({title:'Reviewed standalone proposal',supersedes:neverAccepted.id,correction:{effect:'historical',reason:'Only applicable from September',effective_from:'2026-09-01'}})});
  assert.equal(get(neverAccepted.id).previous_status,'draft');
  assert.equal(objectVersion(get(neverAccepted.id)),originalDraftVersion,'lifecycle provenance does not alter original evidence hash');
  assert.equal(resolveAccepted(loadAll(cfg),neverAccepted.id,{asOf:'2026-08-15'}).current.length,0,'promoting a draft does not manufacture earlier accepted knowledge');

  const futureDraft = get(record(cfg, { type: "definition", fields: definition({ title: "Future-reviewed proposal", status: "draft" }) }).id);
  const futureReviewed = get(record(cfg, { type: "definition", fields: definition({ title: "Future-reviewed accepted definition", supersedes: futureDraft.id,
    correction: { effect: "future_only", reason: "A future definition", effective_from: "2999-01-01" } }) }).id);
  assert.equal(get(futureDraft.id).status, "deprecated", "a reviewed draft leaves the review queue immediately, even before replacement applicability");
  assert.equal(get(futureDraft.id).previous_status, "draft");
  assert.equal(resolveAccepted(loadAll(cfg), futureDraft.id, { asOf: "2026-09-10" }).current.length, 0, "future promotion never manufactures accepted predecessor knowledge");
  assert.deepEqual(resolveAccepted(loadAll(cfg), futureDraft.id, { asOf: "2999-01-01" }).current.map(o => o.id), [futureReviewed.id]);
  assert.equal(resolveAccepted(loadAll(cfg), futureDraft.id).proposals.length, 0);

  // A simultaneous process cannot enter the store while another writer owns the local lock.
  const lock = path.join(replicaA, ".git", ".ledger-write.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname() }));
  try { assert.throws(() => record(a, { type: "definition", fields: definition() }), /write is in progress/); }
  finally { fs.unlinkSync(lock); }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid + 1_000_000, host: os.hostname() }));
  try { assert.match(pull(a, true) ?? "", /pull deferred: another Ledger writer/); }
  finally { fs.unlinkSync(lock); }
  console.log("authority: draft preservation, acceptance/version/scope guards, legacy recovery, exact dependencies, historical/future impact, and two-replica conflict tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
