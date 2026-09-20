import assert from "node:assert/strict";
import crypto from "node:crypto";
import { headline, memoryReport, renderMemoryReport } from "./interpret.js";
import { objectVersion } from "./authority.js";
import type { LedgerObject } from "./schema.js";

/**
 * The interpretability view is a sales surface and an audit surface at once, so the thing under test
 * is not "does it render" but "can every number it prints be wrong". Each case here is a way the page
 * could lie: a capped list reported as a total, a deprecated object inflating a denominator, a named
 * reference counted as lineage, or the clock making two machines disagree on a committed file.
 */

let n = 0;
const obj = (o: Partial<LedgerObject> & { id: string; type: LedgerObject["type"] }): LedgerObject => ({
  created: `2026-09-${String(10 + (n++ % 10)).padStart(2, "0")}T12:00:00.000Z`,
  path: `/tmp/${o.id}.md`,
  title: o.id,
  author: "agaaz",
  tags: [],
  status: "stable",
  description: "",
  body: "",
  fields: {},
  ...o,
});

// ---------------------------------------------------------------------------------------------
// Empty ledger: every section renders, nothing claims a number it does not have.
// ---------------------------------------------------------------------------------------------
{
  const r = memoryReport([]);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.reuse.findings_total, 0);
  const md = renderMemoryReport(r, []);
  assert.match(md, /## Disagreements the ledger refused to settle \(0\)/);
  assert.match(md, /## Corrections and what they put back under review \(0\)/);
  assert.match(md, /## Work reused across people \(0\)/);
  assert.doesNotMatch(md, /NaN|undefined/);
  assert.match(headline(r).join(" "), /\*\*0\*\* disagreements caught/);
}

// ---------------------------------------------------------------------------------------------
// Pinned lineage across people counts; the same reference by name does not.
// ---------------------------------------------------------------------------------------------
{
  const base = obj({ id: "fnd-base", type: "finding", author: "rachit", fields: { result: "12.4%" } });
  const version = objectVersion(base);
  const pinned = obj({
    id: "fnd-pinned",
    type: "finding",
    author: "agaaz",
    fields: { result: "holds on Android", dependencies: [{ relation: "derived-from", id: "fnd-base", version }] },
  });
  const named = obj({ id: "fnd-named", type: "finding", author: "agaaz", fields: { result: "also holds", based_on: ["fnd-base"] } });

  const r = memoryReport([base, pinned, named]);
  assert.equal(r.reuse.cross_author.length, 1, "only the pinned edge is reuse");
  assert.equal(r.reuse.cross_author[0].from, "fnd-pinned");
  assert.equal(r.reuse.cross_author[0].live, true);
  assert.equal(r.reuse.unpinned_cross_author.length, 1, "the named reference is reported, not counted");
  assert.equal(r.reuse.unpinned_cross_author[0].from, "fnd-named");
  assert.equal(r.reuse.findings_pinned, 1);
  assert.equal(r.reuse.findings_total, 3);

  // A pin whose version no longer matches is lineage that has gone stale, and must be visible.
  const stalePin = obj({
    id: "fnd-stale",
    type: "finding",
    author: "agaaz",
    fields: { result: "x", dependencies: [{ relation: "derived-from", id: "fnd-base", version: crypto.createHash("sha256").update("other").digest("hex") }] },
  });
  const r2 = memoryReport([base, stalePin]);
  assert.equal(r2.reuse.stale.length, 1);
  assert.equal(r2.reuse.stale[0].live, false);
  assert.match(renderMemoryReport(r2, [base, stalePin]), /stale pin/);
}

// ---------------------------------------------------------------------------------------------
// Denominators count objects in force. A deprecated predecessor must not inflate "out of N".
// ---------------------------------------------------------------------------------------------
{
  const old = obj({ id: "fnd-old", type: "finding", status: "deprecated", superseded_by: "fnd-new", previous_status: "stable" });
  const current = obj({ id: "fnd-new", type: "finding", supersedes: "fnd-old" });
  const draft = obj({ id: "fnd-draft", type: "finding", status: "draft" });
  const r = memoryReport([old, current, draft]);
  assert.equal(r.reuse.findings_total, 1, "deprecated and draft findings are not in force");
  assert.equal(r.gaps.drafts.count, 1);
  assert.equal(r.totals.deprecated, 1);
}

// ---------------------------------------------------------------------------------------------
// Capped lists report the true count, never the length of the sample.
// ---------------------------------------------------------------------------------------------
{
  const many = Array.from({ length: 37 }, (_, i) => obj({ id: `fnd-${String(i).padStart(2, "0")}`, type: "finding" }));
  const r = memoryReport(many);
  assert.equal(r.gaps.findings_without_pins.count, 37, "count is the total");
  assert.equal(r.gaps.findings_without_pins.examples.length, 20, "sample is bounded");
  assert.match(renderMemoryReport(r, many), /\*\*37\*\* of 37 findings pin no definition/);
}

// ---------------------------------------------------------------------------------------------
// Two accepted successors to one predecessor: reported as a conflict, never ranked by recency,
// and the count of what already depends on a side drives whether it needs attention.
// ---------------------------------------------------------------------------------------------
{
  const acceptance = (id: string, version: string) => ({
    actor: "agaaz",
    accepted_at: "2026-09-12",
    expected_predecessor: { id, version },
    evidence_refs: [{ artifact_id: "art-1", sha256: crypto.createHash("sha256").update(id).digest("hex"), role: "review" }],
  });
  const parent = obj({ id: "fnd-parent", type: "finding", created: "2026-09-01T00:00:00.000Z", fields: { result: "10%" } });
  const pv = objectVersion(parent);
  const a = obj({ id: "fnd-a", type: "finding", created: "2026-09-02T00:00:00.000Z", supersedes: "fnd-parent", fields: { result: "11% (A)", acceptance: acceptance("fnd-parent", pv) } });
  const b = obj({ id: "fnd-b", type: "finding", created: "2026-09-03T00:00:00.000Z", supersedes: "fnd-parent", fields: { result: "9% (B)", acceptance: acceptance("fnd-parent", pv) } });
  const objects = [{ ...parent, status: "deprecated" as const, superseded_by: "fnd-a", previous_status: "stable" as const }, a, b];

  const r = memoryReport(objects);
  assert.equal(r.conflicts.length, 1, "one conflict, deduplicated across both members");
  assert.deepEqual(r.conflicts[0].ids, ["fnd-a", "fnd-b"]);
  assert.equal(r.conflicts[0].kind, "accepted-conflict");
  assert.equal(r.conflicts[0].dependents.length, 0);
  const md = renderMemoryReport(r, objects);
  assert.match(md, /11% \(A\)/);
  assert.match(md, /9% \(B\)/);
  assert.match(md, /Nothing downstream depends on either side yet/);
  // Neither claim may be presented as the answer: both sides render as peers, with no ranking language.
  assert.doesNotMatch(md, /winner|latest wins|most recent|supersedes automatically/i);
  const table = md.split("### Competing accepted claims")[1].split("##")[0];
  assert.ok(table.includes("fnd-a") && table.includes("fnd-b"), "both sides in the same table");
  assert.match(md, /will not pick by recency/);

  // Once something pins one side, the page says it needs resolving.
  const downstream = obj({
    id: "fnd-down",
    type: "finding",
    fields: { result: "built on A", dependencies: [{ relation: "derived-from", id: "fnd-a", version: objectVersion(a) }] },
  });
  const r2 = memoryReport([...objects, downstream]);
  assert.equal(r2.conflicts[0].dependents.length, 1);
  assert.match(renderMemoryReport(r2, [...objects, downstream]), /needs resolving before more work rests on it/);
}

// ---------------------------------------------------------------------------------------------
// A correction lists what it put back under review, and says when nobody needs interrupting.
// ---------------------------------------------------------------------------------------------
{
  const def = obj({ id: "def-cvr", type: "definition", created: "2026-09-01T00:00:00.000Z", fields: { metric: "cvr", formula: "trials/impressions" } });
  const dv = objectVersion(def);
  const user = obj({
    id: "fnd-uses-def",
    type: "finding",
    created: "2026-09-02T00:00:00.000Z",
    fields: { result: "12.4%", dependencies: [{ relation: "uses-definition", id: "def-cvr", version: dv }] },
  });
  const fixed = obj({
    id: "def-cvr-fixed",
    type: "definition",
    created: "2026-09-05T00:00:00.000Z",
    supersedes: "def-cvr",
    fields: {
      metric: "cvr",
      formula: "trials/unique impressions",
      correction: { effect: "historical", reason: "denominator double-counted repeat impressions" },
      acceptance: {
        actor: "agaaz",
        accepted_at: "2026-09-05",
        expected_predecessor: { id: "def-cvr", version: dv },
        evidence_refs: [{ artifact_id: "art-2", sha256: crypto.createHash("sha256").update("e").digest("hex"), role: "review" }],
      },
    },
  });
  const objects = [{ ...def, status: "deprecated" as const, superseded_by: "def-cvr-fixed", previous_status: "stable" as const }, user, fixed];

  const r = memoryReport(objects);
  assert.equal(r.corrections.length, 1);
  assert.equal(r.corrections[0].effect, "historical");
  assert.equal(r.corrections[0].accepted, true);
  assert.deepEqual(r.corrections[0].affected.map((a) => a.id), ["fnd-uses-def"]);
  assert.equal(r.corrections[0].interrupt.required, true);
  const md = renderMemoryReport(r, objects);
  assert.match(md, /Needs attention/);
  assert.match(md, /denominator double-counted repeat impressions/);
  assert.match(headline(r).join(" "), /\*\*1\*\* recorded result put back under review/);
}

// ---------------------------------------------------------------------------------------------
// Determinism: the page is a function of the objects, not of the clock. Two machines rendering the
// same objects must emit identical bytes, or a generated file becomes a merge conflict.
// ---------------------------------------------------------------------------------------------
{
  const objects = [obj({ id: "fnd-x", type: "finding", created: "2026-09-10T00:00:00.000Z" }), obj({ id: "def-y", type: "definition", created: "2026-09-11T00:00:00.000Z" })];
  const once = renderMemoryReport(memoryReport(objects), objects);
  const twice = renderMemoryReport(memoryReport([...objects].reverse()), [...objects].reverse());
  assert.equal(once, twice, "object order must not change the bytes");
  assert.match(once, /As of the last record, 2026-09-11/, "anchored to the newest record, not today");
  const r = memoryReport(objects);
  assert.equal(r.since, "2026-09-04T00:00:00.000Z", "the window counts back from the anchor");
}

// ---------------------------------------------------------------------------------------------
// Markdown safety: a pipe or newline in a claim must not break the table it is rendered into.
// ---------------------------------------------------------------------------------------------
{
  const nasty = obj({ id: "fnd-pipe", type: "finding", fields: { result: "a | b\nsecond line" } });
  const md = renderMemoryReport(memoryReport([nasty]), [nasty]);
  for (const line of md.split("\n")) assert.ok(!/^\|.*\n/.test(line));
  assert.ok(!md.includes("a | b"), "raw pipes are escaped");
}

console.log("selftest-interpret: ok");
