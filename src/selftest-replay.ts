import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { initLedger, loadConfig, loadAll } from "./store.js";
import { brief, briefReport, budgetPayload, collapseWarnings, BRIEF_BUDGET_BYTES, SESSION_START_BUDGET_BYTES, type BriefSectionKey } from "./query.js";
import { drainUsageWrites, reportInjectedContext, usageDirectory, withUsageInvocation, type UsageEnvelope } from "./usage.js";
import { renderReplay, replayHtml, replayKind, replayTrail, type ReplayTrail } from "./replay.js";

/**
 * The bug this suite exists for: the SessionStart brief exceeded the harness's hook-output limit
 * every day from 2026-09-03 (25 KB then, 123,064 bytes on 2026-09-21), the agent received a ~2 KB
 * preview that stopped inside the authority warnings, and nothing anywhere detected it. So the
 * assertions are not "the brief renders" but "the brief cannot silently be shorter than it claims":
 * every omission is counted, every count is exact, and the byte ceiling actually holds.
 *
 * Everything here is database-free. The continuity-backed half of `ledger replay` is exercised
 * against a real Postgres only in the isolated runner.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-replay-test-"));
process.env.HOME = tmp;
process.env.LEDGER_CONFIG_DIR = path.join(tmp, ".ledger"); // never touch the real ~/.ledger
process.env.LEDGER_GIT_SYNC = "0";
process.env.LEDGER_AUTHOR = "agaaz";
// The isolated runner supplies a disposable Postgres; without one the whole suite still runs and the
// uploaded half is skipped by name. Both paths must work: most machines have no continuity database.
const databaseUrl = process.env.LEDGER_TEST_DATABASE_URL;
delete process.env.LEDGER_CONTINUITY_DB; // the default config here is the not-configured path

const dir = path.join(tmp, "ledger");
process.env.LEDGER_DIR = dir;
initLedger(dir, "agaaz");
const cfg = loadConfig();
assert.equal(cfg.continuity, undefined, "the default fixture config has no continuity database");

// ---------------------------------------------------------------------------------------------
// A ledger big enough to exceed any hook limit, written as files so the schema's write-path
// validation is not the thing under test.
// ---------------------------------------------------------------------------------------------
const write = (folder: string, id: string, frontmatter: string) =>
  fs.writeFileSync(path.join(dir, folder, `${id}.md`), `---\n${frontmatter}\n---\n`);
const pad = (n: number, chars: number) => `${"detail ".repeat(Math.ceil(chars / 7)).slice(0, chars)} #${n}`;

for (let i = 0; i < 40; i++)
  write("definitions", `def-2026090${i % 9}-metric-${String(i).padStart(2, "0")}-aa${String(i).padStart(2, "0")}`,
    [`type: definition`, `id: def-2026090${i % 9}-metric-${String(i).padStart(2, "0")}-aa${String(i).padStart(2, "0")}`,
     `title: Metric ${i}`, `description: d`, `status: stable`, `generated: { by: 'human:agaaz', at: '2026-09-0${i % 9}T00:00:00.000Z' }`,
     `metric: metric_${String(i).padStart(2, "0")}`, `formula: "${pad(i, 1200)}"`, `source: warehouse`, `owner: agaaz`, `valid_from: '2026-09-01'`].join("\n"));

const today = new Date().toISOString().slice(0, 10);
for (let i = 0; i < 20; i++)
  write("findings", `fnd-20260910-result-${String(i).padStart(2, "0")}-bb${String(i).padStart(2, "0")}`,
    [`type: finding`, `id: fnd-20260910-result-${String(i).padStart(2, "0")}-bb${String(i).padStart(2, "0")}`,
     `title: Finding ${i}`, `description: d`, `status: stable`, `generated: { by: 'human:agaaz', at: '${today}T00:00:00.000Z' }`,
     `question: "question ${i}"`, `result: "${pad(i, 900)}"`, `data_window: { from: '2026-09-01', to: '2026-09-10' }`].join("\n"));

for (let i = 0; i < 15; i++)
  write("decisions", `dec-20260910-call-${String(i).padStart(2, "0")}-cc${String(i).padStart(2, "0")}`,
    [`type: decision`, `id: dec-20260910-call-${String(i).padStart(2, "0")}-cc${String(i).padStart(2, "0")}`,
     `title: Decision ${i}`, `description: d`, `status: stable`, `generated: { by: 'human:agaaz', at: '${today}T00:00:00.000Z' }`,
     `decision: "${pad(i, 700)}"`, `rationale: because`, `owner: agaaz`, `valid_from: '2026-09-10'`, `confidence: medium`].join("\n"));

for (let i = 0; i < 15; i++)
  write("changes", `chg-20260910-ship-${String(i).padStart(2, "0")}-dd${String(i).padStart(2, "0")}`,
    [`type: change`, `id: chg-20260910-ship-${String(i).padStart(2, "0")}-dd${String(i).padStart(2, "0")}`,
     `title: Change ${i}`, `description: d`, `status: stable`, `generated: { by: 'human:agaaz', at: '${today}T00:00:00.000Z' }`,
     `what: "${pad(i, 500)}"`, `shipped_at: '2026-09-10'`, `surface: paywall`, `owner: agaaz`].join("\n"));

for (let i = 0; i < 10; i++)
  write("findings", `fnd-20260911-draft-${String(i).padStart(2, "0")}-ee${String(i).padStart(2, "0")}`,
    [`type: finding`, `id: fnd-20260911-draft-${String(i).padStart(2, "0")}-ee${String(i).padStart(2, "0")}`,
     `title: Draft ${i}`, `description: d`, `status: draft`, `generated: { by: 'human:agaaz', at: '${today}T00:00:00.000Z' }`,
     `question: "draft question ${i}"`, `result: r`].join("\n"));

assert.equal(loadAll(cfg).length, 100, "fixture ledger loaded");

// ---------------------------------------------------------------------------------------------
// The ceiling holds, and the unbudgeted text proves the budget is doing work.
// ---------------------------------------------------------------------------------------------
const full = briefReport(cfg, { budgetBytes: Infinity });
const budgeted = briefReport(cfg);

assert.ok(full.bytes > 60_000, `unbudgeted brief should be the oversized thing: ${full.bytes}`);
assert.equal(full.budget_bytes, null, "unbudgeted brief reports no budget");
assert.equal(full.truncated, false);
assert.deepEqual(full.drops, [], "nothing is dropped without a budget");
assert.equal(full.record_ids.length, 100, "every stable record and draft is in the unbudgeted brief");
assert.match(full.text, /Nothing was omitted: every current record in scope is above/);

assert.ok(budgeted.bytes <= BRIEF_BUDGET_BYTES, `budgeted brief must fit: ${budgeted.bytes} > ${BRIEF_BUDGET_BYTES}`);
assert.equal(budgeted.bytes, Buffer.byteLength(budgeted.text), "reported size is the real size");
assert.equal(budgeted.budget_bytes, BRIEF_BUDGET_BYTES);
assert.ok(budgeted.truncated, "this ledger cannot fit; the report must say so");
assert.equal(brief(cfg), budgeted.text, "brief() is briefReport().text");

// ---------------------------------------------------------------------------------------------
// Drop accounting: what the report claims was dropped is what is missing from the text, exactly.
// A count that is merely plausible is the failure mode this whole feature is about.
// ---------------------------------------------------------------------------------------------
const totals: Record<BriefSectionKey, number> = { conflicts: 0, warnings: 0, definitions: 40, decisions: 15, findings: 20, changes: 15, drafts: 10 };
for (const drop of budgeted.drops) {
  assert.equal(drop.of, totals[drop.section], `${drop.section} total`);
  assert.ok(drop.omitted > 0 && drop.omitted <= drop.of, `${drop.section} omitted in range`);
}
for (const id of budgeted.record_ids) assert.ok(budgeted.text.includes(id), `${id} is reported as injected and must be in the text`);
for (const o of loadAll(cfg)) {
  const present = budgeted.text.includes(`(${o.id})`) || budgeted.text.includes(` ${o.id}:`);
  if (present) assert.ok(budgeted.record_ids.includes(o.id), `${o.id} is rendered and must be reported as injected`);
}
const shownIn = (key: BriefSectionKey) => totals[key] - (budgeted.drops.find((d) => d.section === key)?.omitted ?? 0);
for (const key of ["definitions", "decisions", "findings", "changes", "drafts"] as const) {
  const drop = budgeted.drops.find((d) => d.section === key);
  if (!drop) continue;
  assert.match(budgeted.text, new RegExp(`${drop.omitted} of ${drop.of} `), `${key} names its exact omission`);
  assert.match(budgeted.text, new RegExp(`\\(${shownIn(key)} of ${drop.of}\\)`), `${key} heading says how many of how many`);
}
// Every truncated section names the call that returns the rest; "some records were dropped" is not enough.
assert.match(budgeted.text, /ledger_search\(\{ query: "<metric>", types: \["definition"\], limit: 50 \}\)/);
assert.match(budgeted.text, /types: \["decision"\]/);
assert.match(budgeted.text, /ledger drafts/);
assert.match(budgeted.text, /## Not in this brief/);
assert.match(budgeted.text, /Omitted here: .*definitions/);
assert.match(budgeted.text, /Retrieval is not use: found means it was returned to you, referenced means you cited it/);

// Metric names are cheap and the definitions themselves are not, so the overflow carries the names.
assert.match(budgeted.text, /Also defined, not shown in full: metric_/);

// ---------------------------------------------------------------------------------------------
// Whole records only. A definition rendered halfway is a wrong definition the agent cannot detect.
// ---------------------------------------------------------------------------------------------
for (const line of budgeted.text.split("\n")) {
  if (!line.startsWith("- **metric_")) continue;
  assert.match(line, /Owner: agaaz, valid from 2026-09-01\.$/, "a rendered definition is rendered whole");
}

// ---------------------------------------------------------------------------------------------
// Priority: an unresolved accepted conflict outranks everything and survives any budget.
// ---------------------------------------------------------------------------------------------
{
  const conflict = (suffix: string) => [
    `type: finding`, `id: fnd-20260912-rival-${suffix}`, `title: Rival ${suffix}`, `description: d`, `status: stable`,
    `generated: { by: 'human:agaaz', at: '${today}T00:00:00.000Z' }`, `question: q`, `result: r`,
    `supersedes: fnd-20260910-result-00-bb00`,
    `acceptance: { actor: 'agaaz', accepted_at: '${today}T00:00:00.000Z', expected_predecessor: { id: 'fnd-20260910-result-00-bb00', version: '${"a".repeat(64)}' }, evidence_refs: [] }`,
  ].join("\n");
  write("findings", "fnd-20260912-rival-aaaa", conflict("aaaa"));
  write("findings", "fnd-20260912-rival-bbbb", conflict("bbbb"));
  const withConflict = briefReport(cfg);
  assert.ok(withConflict.bytes <= BRIEF_BUDGET_BYTES, `still within budget with a conflict: ${withConflict.bytes}`);
  assert.match(withConflict.text, /UNRESOLVED ACCEPTED CONFLICT/, "a conflict is never the thing the budget drops");
  fs.unlinkSync(path.join(dir, "findings", "fnd-20260912-rival-aaaa.md"));
  fs.unlinkSync(path.join(dir, "findings", "fnd-20260912-rival-bbbb.md"));
}

// ---------------------------------------------------------------------------------------------
// A record larger than the whole budget: the section renders nothing rather than half of it, and
// the closing block still carries the count. Silence is the one outcome that is not allowed.
// ---------------------------------------------------------------------------------------------
{
  const solo = fs.mkdtempSync(path.join(tmp, "solo-"));
  process.env.LEDGER_DIR = solo;
  initLedger(solo, "agaaz");
  const soloCfg = loadConfig();
  fs.writeFileSync(path.join(solo, "definitions", "def-20260901-huge-aaaa.md"),
    `---\ntype: definition\nid: def-20260901-huge-aaaa\ntitle: Huge\ndescription: d\nstatus: stable\ngenerated: { by: 'human:agaaz', at: '2026-09-01T00:00:00.000Z' }\nmetric: huge_metric\nformula: "${"x".repeat(30_000)}"\nsource: s\nowner: agaaz\nvalid_from: '2026-09-01'\n---\n`);
  const r = briefReport(soloCfg);
  assert.ok(r.bytes <= BRIEF_BUDGET_BYTES, `one oversized record must not blow the budget: ${r.bytes}`);
  assert.ok(!r.text.includes("x".repeat(200)), "no half-rendered record");
  assert.deepEqual(r.drops, [{ section: "definitions", omitted: 1, of: 1 }]);
  assert.match(r.text, /Omitted here: 1 definitions/);
  assert.match(r.text, /huge_metric/, "the name survives even when the definition cannot");
  process.env.LEDGER_DIR = dir;
}

// ---------------------------------------------------------------------------------------------
// A bigger budget never shows fewer records, and a tiny ledger is never truncated.
// ---------------------------------------------------------------------------------------------
{
  let previous = -1;
  for (const bytes of [4_000, 7_000, 12_000, 25_000, 60_000]) {
    const r = briefReport(cfg, { budgetBytes: bytes });
    assert.ok(r.bytes <= bytes, `budget ${bytes} honoured: ${r.bytes}`);
    assert.ok(r.record_ids.length >= previous, `budget ${bytes} shows at least as much as the one below it`);
    previous = r.record_ids.length;
  }
  const small = fs.mkdtempSync(path.join(tmp, "small-"));
  process.env.LEDGER_DIR = small;
  initLedger(small, "agaaz");
  const smallCfg = loadConfig();
  fs.writeFileSync(path.join(small, "definitions", "def-20260901-one-aaaa.md"),
    `---\ntype: definition\nid: def-20260901-one-aaaa\ntitle: One\ndescription: d\nstatus: stable\ngenerated: { by: 'human:agaaz', at: '2026-09-01T00:00:00.000Z' }\nmetric: one_metric\nformula: count(*)\nsource: s\nowner: agaaz\nvalid_from: '2026-09-01'\n---\n`);
  const r = briefReport(smallCfg);
  assert.equal(r.truncated, false, "a small ledger is delivered whole");
  assert.deepEqual(r.drops, []);
  assert.deepEqual(r.record_ids, ["def-20260901-one-aaaa"]);
  assert.match(r.text, /Nothing was omitted/);
  process.env.LEDGER_DIR = dir;
}

// ---------------------------------------------------------------------------------------------
// Re-injection says so, so a resumed or compacted session does not accumulate stale snapshots.
// ---------------------------------------------------------------------------------------------
assert.doesNotMatch(budgeted.text, /replaces the earlier Ledger brief/, "a first injection claims no predecessor");
{
  const again = briefReport(cfg, { reinjection: true });
  assert.match(again.text, /This snapshot replaces the earlier Ledger brief in this session/);
  assert.ok(again.bytes <= BRIEF_BUDGET_BYTES, `the supersession line is inside the budget: ${again.bytes}`);
}

// ---------------------------------------------------------------------------------------------
// The whole SessionStart payload, not just the brief: the harness limit applies to what it emits.
// ---------------------------------------------------------------------------------------------
{
  const parts = [
    { name: "the Ledger brief", text: budgeted.text, cap: BRIEF_BUDGET_BYTES, more: "`ledger brief --full`" },
    { name: "open threads and notices", text: Array.from({ length: 60 }, (_, i) => `thread line ${i} ${"y".repeat(80)}`).join("\n"), cap: 1_200, more: "`ledger threads`" },
    { name: "the session line and uncaptured work", text: "Ledger session: abc12345\nuncaptured: q:1", cap: 1_500 },
  ];
  const payload = budgetPayload(parts, SESSION_START_BUDGET_BYTES);
  assert.ok(payload.bytes <= SESSION_START_BUDGET_BYTES, `payload must fit: ${payload.bytes}`);
  assert.equal(payload.bytes, Buffer.byteLength(payload.text));
  assert.ok(payload.text.startsWith("# Ledger brief"), "priority order is preserved");
  assert.ok(payload.text.includes("Ledger session: abc12345"), "a small trailing part still arrives");
  const trimmed = payload.dropped.find((d) => d.name === "open threads and notices");
  assert.ok(trimmed && trimmed.omitted_lines > 0 && trimmed.omitted_bytes > 0, "a trimmed part reports what it lost");
  assert.match(payload.text, /further line\(s\), \d+ bytes, omitted from open threads and notices/);
  assert.match(payload.text, /ledger threads/, "a trimmed part names where the rest is");

  assert.deepEqual(budgetPayload([{ name: "a", text: "one\ntwo" }], 10_000), { text: "one\ntwo", bytes: 7, dropped: [] }, "a part that fits is untouched");
  assert.deepEqual(budgetPayload([{ name: "a", text: "   " }], 10_000).text, "", "empty parts are skipped");
}

// ---------------------------------------------------------------------------------------------
// Injection logging: it records what was delivered, and it never throws at a caller.
// ---------------------------------------------------------------------------------------------
const spoolFrames = async (): Promise<UsageEnvelope[]> => {
  const files = await fs.promises.readdir(usageDirectory()).catch(() => [] as string[]);
  return Promise.all(files.filter((f) => f.startsWith("invocation-")).map(async (f) =>
    JSON.parse(await fs.promises.readFile(path.join(usageDirectory(), f), "utf8")) as UsageEnvelope));
};

reportInjectedContext({ record_ids: ["def-20260901-one-aaaa"], bytes: 10, dropped: 1 }); // outside any invocation
assert.ok(true, "reporting outside an invocation is a no-op, not a crash");

await withUsageInvocation(cfg, { tool: "hook:SessionStart", session_id: "sess-replay-000001", purpose: "automatic_brief" }, async () => {
  reportInjectedContext({ record_ids: budgeted.record_ids, bytes: budgeted.bytes, dropped: budgeted.drops.reduce((n, d) => n + d.omitted, 0) });
  return { ok: true };
});
await withUsageInvocation(cfg, { tool: "ledger_show_contribution", session_id: "sess-replay-000001" }, async () => ({
  structuredContent: { sources: [{ id: budgeted.record_ids[0] }], references: [{ id: budgeted.record_ids[0] }] },
}));
await drainUsageWrites();

{
  const frames = (await spoolFrames()).flatMap((e) => e.kind === "invocation" && e.value.finished_at ? [e.value] : []);
  const injection = frames.find((v) => v.tool === "hook:SessionStart");
  assert.ok(injection, "the injection was logged");
  assert.equal(injection.payload_bytes, budgeted.bytes, "the log says what the agent actually received");
  assert.equal(injection.payload_dropped, budgeted.drops.reduce((n, d) => n + d.omitted, 0), "and what it did not");
  assert.deepEqual(injection.records.map((r) => r.id), budgeted.record_ids, "ids only, in render order");
  assert.ok(!JSON.stringify(injection).includes("Owner: agaaz, valid from"), "no record bodies reach an event");
  const cited = frames.find((v) => v.tool === "ledger_show_contribution");
  assert.ok(cited && cited.records.length === 1, "an agent-reported citation is logged as its own kind of step");
  assert.equal(cited!.payload_bytes, null, "a read is not an injection and claims no payload");
}

// LEDGER_USAGE=0 is the off switch; nothing may fail because logging is off.
{
  process.env.LEDGER_USAGE = "0";
  const before = (await spoolFrames()).length;
  await withUsageInvocation(cfg, { tool: "hook:SessionStart", session_id: "sess-replay-000002" }, async () => {
    reportInjectedContext({ record_ids: ["def-20260901-one-aaaa"], bytes: 1, dropped: 0 });
    return {};
  });
  await drainUsageWrites();
  assert.equal((await spoolFrames()).length, before, "logging off means nothing is written and nothing throws");
  delete process.env.LEDGER_USAGE;
}

// ---------------------------------------------------------------------------------------------
// The replay view.
// ---------------------------------------------------------------------------------------------
assert.equal(replayKind("hook:SessionStart"), "injected");
assert.equal(replayKind("ledger_brief"), "injected");
assert.equal(replayKind("ledger_search"), "found");
assert.equal(replayKind("ledger_investigation"), "found");
assert.equal(replayKind("ledger_impact"), "found");
assert.equal(replayKind("ledger_show_contribution"), "referenced");
assert.equal(replayKind("ledger_record_finding"), "saved");
assert.equal(replayKind("ledger_propose_finding"), "saved");
assert.equal(replayKind("ledger_threads"), "other");

{
  const trail = await replayTrail(cfg, { session: "sess-replay-000001" });
  assert.equal(trail.session_id, "sess-replay-000001");
  assert.equal(trail.totals.injections, 1);
  assert.equal(trail.totals.injected_bytes, budgeted.bytes);
  assert.equal(trail.totals.dropped_records, budgeted.drops.reduce((n, d) => n + d.omitted, 0));
  assert.equal(trail.totals.referenced, 1);
  assert.deepEqual(trail.steps.map((s) => s.kind), ["injected", "referenced"], "in the order they happened");
  const configured = trail.sources.find((s) => s.name === "continuity database");
  assert.equal(configured?.status, "not_configured", "an absent database is named, not hidden");
  assert.equal(trail.sources.find((s) => s.name === "local usage spool")?.status, "read");

  const rendered = renderReplay(trail);
  assert.equal(rendered, renderReplay(trail), "rendering is deterministic");
  assert.doesNotMatch(rendered, new RegExp(new Date().getFullYear() + "-\\d\\d-\\d\\dT"), "no wall clock in the output");
  assert.match(rendered, /injected = delivered into the agent's context · found = returned to it · referenced = it said it used the record/);
  assert.match(rendered, new RegExp(`${budgeted.bytes} B delivered`));
  assert.match(rendered, /continuity database — not configured/);
  assert.match(rendered, /found and referenced are appearances, not distinct records, and referenced is the agent's own claim/);
  assert.ok(rendered.indexOf("hook:SessionStart") < rendered.indexOf("ledger_show_contribution"), "steps are ordered by time");

  const html = replayHtml(trail);
  assert.match(html, /<title>Ledger replay/);
  assert.match(html, /class="kind injected"/);
  assert.match(html, /class="kind referenced"/);
  assert.match(html, new RegExp(`${budgeted.bytes} B delivered`));
  assert.match(html, /Retrieval is not use|Found and referenced are appearances/);

  const escaped: ReplayTrail = { ...trail, session_id: `<script>alert(1)</script>` };
  assert.ok(!replayHtml(escaped).includes("<script>alert(1)</script>"), "session ids are text, never markup");
}

{
  const unknown = await replayTrail(cfg, { session: "sess-replay-no-such-session" });
  assert.deepEqual(unknown.steps, []);
  assert.match(renderReplay(unknown), /no knowledge calls recorded for this session/);
  const all = await replayTrail(cfg, { session: "sess-replay-000001", includeOther: true });
  assert.ok(all.steps.length >= trailSteps(), "--all is a superset");
  function trailSteps() { return 2; }
}

// ---------------------------------------------------------------------------------------------
// The uploaded half: the injection columns have to survive the trip to Postgres, or a trail read on
// another machine would show an injection with no size and no dropped count — exactly the blind spot
// this feature closes. Needs the isolated runner's disposable database.
// ---------------------------------------------------------------------------------------------
if (databaseUrl) {
  const dbCfg = { ...cfg, continuity: { database_url: databaseUrl, machine: "selftest" } };
  const { getPool, migrate, closePools } = await import("./continuity/db.js");
  const { flushUsage } = await import("./continuity/usage.js");
  const pool = getPool(dbCfg);
  await migrate(pool);

  await withUsageInvocation(dbCfg, { tool: "hook:SessionStart", session_id: "sess-replay-uploaded1", purpose: "automatic_brief" }, async () => {
    reportInjectedContext({ record_ids: budgeted.record_ids.slice(0, 3), bytes: budgeted.bytes, dropped: 7 });
    return {};
  });
  await drainUsageWrites();
  const flushed = await flushUsage(pool);
  assert.ok(flushed.uploaded > 0, `usage uploaded: ${JSON.stringify(flushed)}`);

  const row = (await pool.query(`select payload_bytes, payload_dropped, records from cont_usage_invocations where session_id=$1 and finished_at is not null`, ["sess-replay-uploaded1"])).rows[0];
  assert.ok(row, "the injection reached Postgres");
  assert.equal(row.payload_bytes, budgeted.bytes, "byte size survives the upload");
  assert.equal(row.payload_dropped, 7, "the dropped count survives the upload");
  assert.deepEqual(row.records.map((r: { id: string }) => r.id), budgeted.record_ids.slice(0, 3));

  const trail = await replayTrail(dbCfg, { session: "sess-replay-uploaded1" });
  assert.equal(trail.sources.find((s) => s.name === "continuity database")?.status, "read");
  assert.equal(trail.steps.length, 1);
  assert.equal(trail.steps[0].origin, "database", "an uploaded invocation is read back from the database, not the spool");
  assert.equal(trail.steps[0].payload_bytes, budgeted.bytes);
  assert.equal(trail.totals.dropped_records, 7);
  await closePools();
  console.log("  ok database: payload_bytes/payload_dropped persist and replay reads them back");
} else {
  console.log("  skipped database half: no LEDGER_TEST_DATABASE_URL (run through scripts/test-isolated.mjs)");
}

// ---------------------------------------------------------------------------------------------
// Collapsing a repeated warning is a budget fix, so the risk is that it loses a fact to save bytes.
// The count must stay exact, an unrepeated warning must survive untouched, and an id-prefixed
// warning must keep its id.
// ---------------------------------------------------------------------------------------------
{
  const sentence = "legacy acceptance provenance is unknown; previous_status and capture metadata are absent";
  const many = Array.from({ length: 36 }, (_, i) => `fnd-2026090${i % 10}-example-${i}: ${sentence}`);
  const collapsed = collapseWarnings([...many, "analytical scope unknown (legacy record)", `def-solo: ${sentence} but different`]);

  assert.equal(collapsed.length, 3, "one line per distinct sentence, not per record");
  const family = collapsed.find((w) => w.startsWith(sentence) && w.includes("Affects"))!;
  assert.match(family, /Affects 36 records:/, "the count is the true total, not the sample size");
  assert.equal((family.match(/fnd-2026090/g) ?? []).length, 6, "a bounded sample of ids is named");
  assert.match(family, /and 30 more/, "the remainder is stated, never silently dropped");
  assert.ok(collapsed.includes("analytical scope unknown (legacy record)"), "an unprefixed warning is untouched");
  assert.ok(collapsed.some((w) => w.startsWith("def-solo: ")), "a sentence seen once keeps its id prefix");
  assert.ok(
    Buffer.byteLength(family) < Buffer.byteLength(many.join("\n")) / 3,
    "collapsing is worth doing: the family costs a fraction of the repeated form"
  );
  console.log("  ok warnings: a repeated sentence collapses without losing the count");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("selftest-replay: ok");
