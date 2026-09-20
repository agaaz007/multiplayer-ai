import { assertSafeSelftestDatabase, assertSelftestDatabaseMarker } from "./selftest-db-guard.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Record-level retrieval tests (spec §13a, "Retrieval by record"). Needs a
 * Postgres: LEDGER_CONTINUITY_DB, default
 * postgresql://localhost:5432/ledger_selftest_recordpack. Drops and recreates
 * every cont_* table there.
 *
 * Fixture: two sessions by two authors on two harnesses contribute to one
 * investigation record; rachit's session is bound to a thread with a claim and
 * a head checkpoint carrying a wip ref; a contradiction between the two
 * sessions' hypotheses; a Ledger decision the record depends on, superseded
 * after the reference was made; a non-code writing record; an unlinked span in
 * rachit's session; a third session with nothing assignable.
 *
 * Covers the record pack in both details: lean (the default: state, decisions,
 * pending, changed-since-your-last-visit, bootstrap, drill-down references, no
 * event lines, under LEAN_TARGET_TOKENS; viewer first-visit vs delta; as_of)
 * and evidence (header, state with PROPOSED flags, cross-session evidence,
 * session summary, pending ops inside spans, superseded refs, unassigned spans,
 * bootstrap, claim modes, budget shrinking), the record tools
 * over an in-process MCP client, listRecordSummaries, the brief sections, and
 * acceptance tests 28, 29, 30, 32, 33. Pass --show to print the pack.
 */

// the MCP tools resolve the caller's session from these; unset them so provenance assertions do not depend on the shell running the test
for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_THREAD_ID"]) delete process.env[k];
const DB = process.env.LEDGER_CONTINUITY_DB || "postgresql://localhost:5432/ledger_selftest_recordpack";
assertSafeSelftestDatabase(DB);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-recpack-"));
process.env.LEDGER_CONFIG_DIR = path.join(tmp, ".ledger");
process.env.LEDGER_GIT_SYNC = "0";

const { getPool, migrate, closePools, tableList } = await import("./continuity/db.js");
const S = await import("./continuity/store.js");
const R = await import("./continuity/records.js");
const { buildRecordPack, listRecordSummaries, recordLine, unassignedLine, stateLine, EVIDENCE_HEAD, EVIDENCE_TAIL, LEAN_TARGET_TOKENS, LEAN_PROPOSED_FULL } = await import("./continuity/recordpack.js");
const { openWorkText, openThreadsText } = await import("./continuity/brief.js");
const { initLedger, record, getById } = await import("./store.js");
const { objectVersion } = await import('./authority.js');
const { createMcpServer } = await import("./mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
type Config = import("./store.js").Config;
type NormEvent = import("./continuity/events.js").NormEvent;
type EventKind = import("./continuity/events.js").EventKind;

// fixture times are relative to the real clock so the 48 h brief windows apply; nothing asserts wall-clock strings
const BASE = Math.floor((Date.now() - 3 * 3_600_000) / 60_000) * 60_000;
const T = (min: number) => new Date(BASE + min * 60_000);
const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ") + "Z";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let step = 0;
const ok = (msg: string) => console.log(`  ok ${++step}. ${msg}`);
const ev = (id: string, kind: EventKind, min: number, payload: Record<string, unknown>, call_id?: string): NormEvent => ({ producer_event_id: id, kind, occurred_at: T(min).toISOString(), payload, ...(call_id ? { call_id } : {}) });
const approxTokens = (s: string) => Math.ceil(s.length / 4);
const REPO = "github.com/tranzmit/demo";
const TODAY = new Date().toISOString().slice(0, 10);

// ---------- setup: ledger dir, fresh schema ----------
const ledgerDir = path.join(tmp, "ledger");
initLedger(ledgerDir, "test");
const cfg: Config = { ledger_dir: ledgerDir, git_sync: false, author: "agaaz", continuity: { database_url: DB, machine: "agaaz-mac" } };
const pool = getPool(cfg);
await assertSelftestDatabaseMarker(pool);
await pool.query(`drop table if exists cont_session_bindings, cont_state_updates, cont_record_links, cont_records, cont_notifications, cont_artifacts, cont_claims, cont_checkpoints, cont_events, cont_sessions, cont_threads cascade`);
await migrate(pool);
assert.equal((await tableList(pool)).length, 11, "all eleven cont_* tables present (cont_session_bindings added 2026-09-17)");
ok(`schema reset on ${DB.replace(/\/\/[^@]*@/, "//…@")}`);

// ---------- fixture: agaaz (Claude Code) then rachit (Codex) on one repo ----------
const sidA = "agaaz-claude-attr-1";
const sidR = "0199bbbb-cccc-7ddd-8eee-ffffffffffff";
const sidN = "rachit-codex-nothing-1";
const A8 = sidA.slice(0, 8), R8 = sidR.slice(0, 8);

await S.upsertSession(pool, { id: sidA, author: "agaaz", harness: "claude", machine: "agaaz-mac", repo: REPO, branch: "master", started_at: T(0), last_seen_at: T(15) });
const aEvents: NormEvent[] = [
  ev("a1", "instruction.added", 0, { text: "Attribution: compare Mixpanel and ClickHouse trial-start counts for the September paywall test" }),
  ev("a2", "tool.requested", 1, { tool: "Bash", input: "clickhouse-client -q 'select count() from paywall_resolved where test = \"sept\"'" }, "a-c1"),
  ev("a3", "tool.finished", 2, { tool: "Bash", output_preview: "41200", is_error: false }, "a-c1"),
  ev("a4", "assistant.message", 3, { text: "ClickHouse counts 41,200 paywall_resolved rows; Mixpanel shows 38,900. Hypothesis: Mixpanel drops events with a missing distinct_id." }),
  ev("a5", "file.changed", 4, { path: "queries/attribution.sql", status: "M" }),
  ev("a6", "tool.requested", 5, { tool: "Bash", input: "psql events -c 'select count(*) from events where distinct_id is null'" }, "a-c2"),
  ev("a7", "tool.finished", 6, { tool: "Bash", output_preview: "", stderr_preview: 'psql: FATAL: database "events" does not exist', is_error: true }, "a-c2"),
  ev("a8", "assistant.message", 7, { text: "The database is called analytics, not events; retrying." }),
  ev("a9", "tool.requested", 8, { tool: "Bash", input: "psql analytics -c 'select count(*) from events where distinct_id is null'" }, "a-c3"),
  ev("a10", "tool.finished", 9, { tool: "Bash", output_preview: "1830", is_error: false }, "a-c3"),
];
const ra = await S.appendEvents(pool, sidA, aEvents, null, null);
assert.equal(ra.inserted, 10);
await S.updateSession(pool, sidA, { ended_at: T(15) });

await S.upsertSession(pool, { id: sidR, author: "rachit", harness: "codex", machine: "rachit-mac", repo: REPO, branch: "master", started_at: T(30), last_seen_at: T(70) });
const thread = await S.createThread(pool, { repo: REPO, branch: "master", title: "Attribution gap", goal: null, created_by: "rachit" });
const claimR = await S.claimThread(pool, thread.id, sidR, "rachit");
assert.ok(claimR.ok, "fixture claim");
const genR = claimR.ok ? claimR.generation : -1;
const codexSummary = "Summary written at compaction: compared counts (ClickHouse 41,200 vs Mixpanel 38,900); found the distinct_id guard in src/ingest/mixpanel.ts:88; the counter-hypothesis is the 7-day attribution window. Next step: size the guard's effect against the window.";
const rEvents: NormEvent[] = [
  ev("r1", "instruction.added", 30, { text: "Continue the attribution investigation: check whether the Mixpanel gap is the distinct_id filter" }),
  ev("r2", "tool.requested", 31, { tool: "Bash", input: "grep -n distinct_id src/ingest/*.ts" }, "r-c1"),
  ev("r3", "tool.finished", 32, { tool: "Bash", output_preview: "src/ingest/mixpanel.ts:88: if (!distinct_id) return;", is_error: false }, "r-c1"),
  ev("r4", "assistant.message", 33, { text: "Found: mixpanel.ts drops events without distinct_id at line 88. Counter-hypothesis: the gap is the 7-day attribution window, not distinct_id." }),
  ev("r5", "compaction", 34, { source: "codex_compacted", text: codexSummary, chars: codexSummary.length }),
  ev("r6", "file.changed", 60, { path: "src/ingest/mixpanel.ts", status: "M" }),
  ev("r7", "tool.requested", 61, { tool: "Bash", input: "psql analytics -c 'select count(*) from events where distinct_id is null and ts > now() - interval 7 day'" }, "r-c2"),
  ev("r8", "instruction.added", 62, { text: "Separate: draft the landing copy for the pricing page" }),
  ev("r9", "assistant.message", 63, { text: "Draft headline: 'Know your week before it starts.'" }),
  ev("r10", "tool.requested", 64, { tool: "Bash", input: "npm run build" }, "r-c3"),
  ev("r11", "instruction.added", 65, { text: "Unrelated: look at the CI flake in the deploy job" }),
];
const rr = await S.appendEvents(pool, sidR, rEvents, thread.id, genR);
assert.equal(rr.inserted, 11);
const WIP_REF = `refs/wip/rachit/${sidR}`;
const WIP_COMMIT = "b".repeat(40);
await S.updateSession(pool, sidR, { base_commit: "a".repeat(40), wip_ref: WIP_REF, wip_commit: WIP_COMMIT, last_verified_snapshot_at: T(69) });
const cp = await S.publishCheckpoint(pool, { thread_id: thread.id, session_id: sidR, generation: genR, kind: "snapshot", through_event_seq: rr.lastSeq, base_commit: "a".repeat(40), wip_ref: WIP_REF, wip_commit: WIP_COMMIT, verified_snapshot_at: T(69), verified_events_at: T(69) });
assert.ok(cp.advanced, `fixture checkpoint advanced: ${cp.reason}`);
assert.equal(await S.releaseClaim(pool, thread.id, sidR), true, "rachit's session released its claim");

// a session with nothing assignable (acceptance 33)
await S.upsertSession(pool, { id: sidN, author: "rachit", harness: "codex", machine: "rachit-mac", repo: null, started_at: T(80), last_seen_at: T(82) });
await S.appendEvents(pool, sidN, [ev("n1", "instruction.added", 80, { text: "hey, quick sanity check on the numbers from yesterday?" }), ev("n2", "assistant.message", 81, { text: "Which numbers do you mean?" })], null, null);

// ---------- Ledger decision the record depends on, superseded after the reference ----------
const decision = (title: string, decision: string, supersedes?: string) => record(cfg, {
  type: "decision",
  fields: {
    title, decision,
    context: "Two analytics stores disagree on September paywall trial starts; one has to be the source of truth for the test readout.",
    options_considered: [{ option: decision, chosen: true, rationale: "chosen for the test readout" }, { option: "Do nothing", rationale: "the readout would carry two numbers" }],
    rationale: "One number per metric.",
    assumptions: [{ statement: "ClickHouse ingestion was complete for the window", kind: "implicit", if_wrong: "changes_conclusion" }],
    valid_from: "2026-09-08", owner: "agaaz", ...(supersedes ? { supersedes, acceptance: {
      actor:'agaaz', accepted_at:'2026-09-10', expected_predecessor:{id:supersedes,version:objectVersion(getById(cfg,supersedes)!)},
      evidence_refs:[{artifact_id:supersedes,sha256:objectVersion(getById(cfg,supersedes)!),role:'review'}],
    } } : {}),
  },
});
const dec1 = decision("ClickHouse is the source of truth for the September paywall test", "Use ClickHouse paywall_resolved for the September test readout");

// ---------- records ----------
const recAttr = await R.createRecord(pool, { kind: "investigation", title: "Attribution investigation", goal: "Explain why Mixpanel and ClickHouse disagree on September paywall trial starts", repo: REPO, created_by: "agaaz", ledger_refs: [{ id: dec1.id }] });
await R.linkSpan(pool, { record_id: recAttr.id, session_id: sidA, from_seq: 1, to_seq: 10, source: "explicit", created_by: "agaaz" });
await R.linkSpan(pool, { record_id: recAttr.id, session_id: sidR, from_seq: 1, to_seq: 7, source: "explicit", created_by: "rachit" });
const d1 = await R.addStateUpdate(pool, { record_id: recAttr.id, session_id: sidA, from_seq: 1, to_seq: 4, kind: "decision", text: "Use ClickHouse paywall_resolved as the source of truth for the September test", evidence: [{ session_id: sidA, seq: 3 }, { session_id: sidA, seq: 4 }], created_by: "agaaz", status: "confirmed" });
const h1 = await R.addStateUpdate(pool, { record_id: recAttr.id, session_id: sidA, from_seq: 4, to_seq: 4, kind: "hypothesis", text: "The Mixpanel gap comes from events with a missing distinct_id being dropped", evidence: [{ session_id: sidA, seq: 4 }, { session_id: sidA, seq: 10 }], created_by: "agaaz" });
const h2 = await R.addStateUpdate(pool, { record_id: recAttr.id, session_id: sidR, from_seq: 4, to_seq: 4, kind: "hypothesis", text: "The Mixpanel gap comes from the 7-day attribution window, not distinct_id", evidence: [{ session_id: sidR, seq: 4 }], created_by: "rachit" });
const c1 = await R.addStateUpdate(pool, { record_id: recAttr.id, kind: "contradiction", text: `Cause of the gap disputed: missing distinct_id (agaaz, ${A8} seq 4) vs 7-day attribution window (rachit, ${R8} seq 4)`, evidence: [{ session_id: sidA, seq: 4 }, { session_id: sidR, seq: 4 }], created_by: "classifier" });
const versionBeforeN1 = (await R.getRecord(pool, recAttr.id))!.state_version;
const n1 = await R.addStateUpdate(pool, { record_id: recAttr.id, session_id: sidR, from_seq: 5, to_seq: 5, kind: "next", text: "Size the effect of the distinct_id guard against the attribution window", evidence: [{ session_id: sidR, seq: 5 }], created_by: "classifier" });
const recCopy = await R.createRecord(pool, { kind: "writing", title: "Landing copy", goal: "Pricing page headline", repo: null, created_by: "rachit" });
await R.linkSpan(pool, { record_id: recCopy.id, session_id: sidR, from_seq: 8, to_seq: 9, source: "explicit", created_by: "rachit" });

// supersede the decision after the record referenced it
const dec2 = decision("ClickHouse is the source of truth, with the distinct_id guard removed", "Use ClickHouse paywall_resolved for the September test readout after removing the distinct_id guard", dec1.id);
assert.equal(dec2.superseded, dec1.id);
assert.equal(getById(cfg, dec1.id)!.status, "deprecated");
ok(`fixture: sessions ${A8} (agaaz, claude, ended) and ${R8} (rachit, codex, thread ${thread.id.slice(0, 8)} + checkpoint + wip), record "Attribution investigation" with 5 updates, "Landing copy" (non-code), decision ${dec1.id} superseded by ${dec2.id}`);

// ---------- 1. header and state (both details) ----------
// `lean` is the default pack a successor reads; `pack` asks for the evidence detail, the pre-2026-09-15 shape, which the evidence assertions below inspect
const lean = await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", now: T(120) });
const pack = await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", now: T(120), detail: "evidence" });
if (process.argv.includes("--show")) console.log(lean.text.split("\n").map((l) => `    | ${l}`).join("\n"));
assert.equal(lean.detail, "lean", "lean is the default detail");
assert.equal(pack.detail, "evidence");
for (const t of [lean.text, pack.text]) {
  assert.ok(t.startsWith(`# Record pack: Attribution investigation\nrecord ${recAttr.id} · investigation · repos touched ${REPO} · status open · created by agaaz `), t.split("\n").slice(0, 2).join("\n"));
  assert.ok(t.includes(" · state v1 · updated "), "header carries state_version");
  assert.ok(t.includes("goal: Explain why Mixpanel and ClickHouse disagree"), "goal line");
  assert.ok(t.includes("## State (v1 · 4 proposed · 1 confirmed)"), "state header counts");
  assert.ok(t.includes(`- [confirmed by agaaz; how it was accepted was not recorded] Use ClickHouse paywall_resolved as the source of truth for the September test (by agaaz, ${TODAY}; evidence: seq 3,4 of ${A8})`), "a confirmation with no recorded channel never claims a person accepted it");
  assert.ok(t.includes(`- [PROPOSED] The Mixpanel gap comes from events with a missing distinct_id being dropped (by agaaz, ${TODAY}; evidence: seq 4,10 of ${A8})`), "agaaz's hypothesis PROPOSED");
  assert.ok(t.includes(`- [PROPOSED] The Mixpanel gap comes from the 7-day attribution window, not distinct_id (by rachit, ${TODAY}; evidence: seq 4 of ${R8})`), "rachit's hypothesis PROPOSED");
  assert.ok(t.includes(`- [PROPOSED] Cause of the gap disputed: missing distinct_id (agaaz, ${A8} seq 4) vs 7-day attribution window (rachit, ${R8} seq 4) (by classifier, ${TODAY}; evidence: seq 4 of ${A8}; seq 4 of ${R8})`), "contradiction line with both sides' evidence");
  const order = ["### Decisions (1)", "### Next (1)", "### Hypotheses (2)", "### Contradictions (both sides kept; never resolved by timestamp) (1)"].map((h) => t.indexOf(h));
  assert.ok(order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), `state kinds in order: ${order.join(",")}`);
  assert.ok(!t.includes("### Blockers") && !t.includes("### Progress") && !t.includes("### Notes"), "empty kinds are not rendered");
}
{
  assert.equal(pack.state.hypotheses.length, 2);
  assert.ok(pack.state.hypotheses.every((u) => u.status === "proposed"));
  assert.ok(stateLine(d1).startsWith("- [confirmed by agaaz;"), stateLine(d1));
  assert.equal(stateLine(h2).slice(0, 12), "- [PROPOSED]");
  ok("pack header (id, kind, repo, status, creator, state version) and state, in both details: confirmed decision, both contradicting hypotheses flagged PROPOSED (≤ LEAN_PROPOSED_FULL per kind stay in full), contradiction with both sides, kinds in order, empty kinds skipped");
}

// ---------- 1b. lean detail: the default; five sections in order, references only, under the token target ----------
{
  const t = lean.text;
  const heads = ["## State (v1 · 4 proposed · 1 confirmed)", "## Decisions in force for this work (1)", "## Pending / unknown operations (1)", "## Changed since your last visit", "## Bootstrap", "## Drill down (13 content events in 2 spans; references only)", "## Omitted for budget or unavailable"];
  const at = heads.map((h) => t.indexOf(h));
  assert.ok(at.every((i) => i > 0) && at.every((v, i) => i === 0 || v > at[i - 1]), `lean sections in order: ${heads.map((h, i) => `${h.slice(0, 20)}@${at[i]}`).join(", ")}`);
  assert.ok(!t.includes("## Evidence across sessions") && !t.includes("### Session summary") && !t.includes("### Files touched") && !t.includes("## Unassigned spans") && !t.includes("## First turn contract"), "evidence-detail sections absent");
  assert.ok(!/ · \d+ · \d\d:\d\d · (instruction\.added|assistant\.message|tool\.requested|tool\.finished|file\.changed|compaction) · /.test(t), "no evidence line is inlined");
  assert.ok(!t.includes(codexSummary) && !t.includes("Attribution: compare Mixpanel") && !t.includes("Draft headline") && !t.includes("FATAL"), "no event text (instructions, summary, error output) is inlined");
  assert.ok(approxTokens(t) < 1200 && 1200 <= LEAN_TARGET_TOKENS, `lean pack under 1200 tokens at level 0: ${approxTokens(t)}`);
  assert.ok(!lean.omitted.some((o) => /for budget/.test(o)), `no budget shrink was needed: ${lean.omitted.join(" | ")}`);
  assert.ok(t.length < pack.text.length / 1.5, `lean is much smaller than evidence: ${t.length} vs ${pack.text.length}`);
  assert.deepEqual(lean.evidence_summary, { total: 13, shown: [], omitted: { count: 13, fetch: [`ledger_events(session_id: "${sidA}", after_seq: 0, before_seq: 11)`, `ledger_events(session_id: "${sidR}", after_seq: 0, before_seq: 8)`] } }, "lean shows no evidence and names the per-span fetches");
  // honesty, compact: sessions on one line, the snapshot, the decision rule, no full contract
  assert.ok(t.includes(`Honesty: 2 contributing sessions: ${R8} (rachit, Codex, last seen 50m ago); ${A8} (agaaz, Claude Code, last seen 2h ago, ended).`), t.split("\n")[4]);
  assert.ok(t.includes(`Code saved through ${fmt(T(69))} (remote-verified; session ${R8}).`) && t.includes("Act only on [in force] Ledger objects and [accepted by <person>] record decisions"), "snapshot and decision rule in the honesty block");
  // state: the confirmed decision first, the ≤3 proposed items per kind in full with the acceptance labels
  assert.ok(t.includes(`- [confirmed by agaaz; how it was accepted was not recorded] Use ClickHouse paywall_resolved`) && t.includes(`- [PROPOSED] The Mixpanel gap comes from the 7-day attribution window, not distinct_id (by rachit, ${TODAY}; evidence: seq 4 of ${R8})`));
  assert.equal(LEAN_PROPOSED_FULL, 3);
  // decisions in force, compact: tag + id + origin, no title; the omission names ledger_get
  assert.ok(t.includes(`- [SUPERSEDED by ${dec2.id}, which is in force] decision ${dec1.id} · linked explicitly\n`), "compact decision line");
  assert.ok(!t.includes(`decision ${dec1.id}: ClickHouse is the source of truth`), "no title in lean");
  assert.ok(lean.omitted.some((o) => o.startsWith("Ledger object titles") && o.includes("ledger_get / ledger_impact per id")), lean.omitted.join(" | "));
  // pending: the same line as the evidence pack, shorter warning
  assert.ok(t.includes(`- session ${R8} seq 7 Bash: psql analytics -c 'select count(*) from events where distinct_id is null and ts > now() - interval 7 day'  ← outcome unknown; do not rerun blindly`));
  // no viewer: totals, not a delta
  assert.ok(t.includes(`## Changed since your last visit\nNo viewer given, so no delta. Totals since creation: 13 content events in 2 sessions, 5 state updates (4 proposed, 1 confirmed), 1 pending operation, 2 files touched.\n- files: src/ingest/mixpanel.ts, queries/attribution.sql`), t.slice(t.indexOf("## Changed since"), t.indexOf("## Bootstrap")));
  assert.equal(lean.changed_since?.viewer, null);
  // bootstrap: the existing block
  assert.ok(t.includes(`## Bootstrap\nsnapshot from session ${R8} (rachit, Codex)\n\`\`\`\ngit fetch origin ${WIP_REF}:${WIP_REF}\n`));
  // drill down: one exact ledger_events call per span, the last error, the compaction summary, unassigned, search; nothing inline
  const drill = t.slice(t.indexOf("## Drill down"), t.indexOf("## Omitted"));
  assert.ok(drill.includes(`- ledger_events(session_id: "${sidA}", after_seq: 0, limit: 10)  · agaaz/Claude Code\n- ledger_events(session_id: "${sidR}", after_seq: 0, limit: 7)  · rachit/Codex\n`), drill);
  assert.ok(drill.includes(`- last error (${A8} seq 7 Bash): ledger_events(session_id: "${sidA}", after_seq: 6, limit: 1, preview_chars: 2000)`), drill);
  assert.ok(drill.includes(`- compaction summary by Codex (${codexSummary.length} chars, evidence not memory): ledger_events(session_id: "${sidR}", after_seq: 4, limit: 1, preview_chars: ${codexSummary.length})`), drill);
  assert.ok(t.includes(`1 unassigned span may belong here`) && t.includes(`ledger_unassigned(session_id: "${sidR}")`) && drill.includes(`- search: ledger_evidence_search(q: "…", record_id: "${recAttr.id}")`), drill);
  assert.deepEqual(lean.drill_down.slice(0, 2), [`ledger_events(session_id: "${sidA}", after_seq: 0, limit: 10)`, `ledger_events(session_id: "${sidR}", after_seq: 0, limit: 7)`]);
  // every omission names its fetch; the evidence pack is one call away
  assert.ok(lean.omitted.every((o) => /ledger_/.test(o)), lean.omitted.join(" | "));
  assert.ok(t.includes(`## Omitted for budget or unavailable\n`) && t.includes(`ledger_record_get(record_id: "${recAttr.id}", detail: "evidence")`), "the evidence pack is named as the restoring fetch");
  // a wide budget alone never switches to evidence; the evidence detail must be asked for
  const wide = await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", now: T(120), budgetTokens: 20000 });
  assert.equal(wide.detail, "lean");
  assert.ok(!wide.text.includes("## Evidence across sessions") && wide.text.includes("## Drill down"), "budget_tokens >= STATE_WIDE_BUDGET stays lean");
  assert.ok(wide.text.includes(`ledger_record_get(record_id: "${recAttr.id}", detail: "evidence")`), "the wide lean pack still points at the evidence detail");
  // the evidence detail is the previous shape
  assert.ok(pack.text.includes("## Evidence across sessions (13 events in 2 spans, time order") && pack.text.includes("### Session summary") && pack.text.includes("## First turn contract") && pack.text.includes(codexSummary), "detail: evidence reproduces the inline pack");
  ok(`lean detail is the default: State → Decisions in force → Pending → Changed since your last visit → Bootstrap → Drill down, references only, ${approxTokens(t)} tokens (evidence detail: ${approxTokens(pack.text)}); a 20000 budget stays lean; detail "evidence" reproduces the inline shape`);
}

// ---------- 1c. changed since your last visit: first visit vs delta, two authors; own session excluded ----------
{
  const nobody = await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", now: T(120), viewer: "nobody" });
  assert.deepEqual({ first: nobody.changed_since?.first_visit, viewer: nobody.changed_since?.viewer, since: nobody.changed_since?.since, events: nobody.changed_since?.events.map((e) => [e.session_id, e.count]) }, { first: true, viewer: "nobody", since: null, events: [[sidR, 6], [sidA, 7]] }, "first visit: totals per session, most recent first");
  assert.ok(nobody.text.includes(`## Changed since your last visit\nFirst visit for nobody: no earlier session of yours contributes to this record. Totals since creation (${TODAY}): 13 content events in 2 sessions, 5 state updates (4 proposed, 1 confirmed), 1 pending operation, 2 files touched.`), nobody.text.slice(nobody.text.indexOf("## Changed since"), nobody.text.indexOf("## Bootstrap")));
  // agaaz's last contributing session ended at T(15); rachit's whole span, the pending call, the file and every update came after
  const mine = await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", now: T(120), viewer: "agaaz" });
  const d = mine.changed_since!;
  assert.deepEqual({ first: d.first_visit, last: d.last_session?.session_id, since: d.since?.toISOString(), events: d.events.map((e) => [e.session_id, e.author, e.count, e.from_seq, e.to_seq]), added: d.state_updates.added.length, confirmed: d.state_updates.confirmed.length, pending: d.pending, files: d.files.map((f) => f.path) },
    { first: false, last: sidA, since: T(15).toISOString(), events: [[sidR, "rachit", 6, 1, 7]], added: 5, confirmed: 0, pending: [{ session_id: sidR, seq: 7, tool: "Bash" }], files: ["src/ingest/mixpanel.ts"] });
  const sec = mine.text.slice(mine.text.indexOf("## Changed since"), mine.text.indexOf("## Bootstrap"));
  assert.ok(sec.includes(`Your last contributing session ${A8} was last seen ${fmt(T(15))}. Since then:`), sec);
  assert.ok(sec.includes(`- 6 new content events in session ${R8} (rachit, Codex) seq 1..7, last ${fmt(T(61))}: ledger_events(session_id: "${sidR}", after_seq: 0, limit: 7)`), sec);
  assert.ok(sec.includes(`- state update added (5): decision ${d1.id.slice(0, 8)} [confirmed], next ${n1.id.slice(0, 8)} [PROPOSED], hypothesis ${h1.id.slice(0, 8)} [PROPOSED], hypothesis ${h2.id.slice(0, 8)} [PROPOSED], contradiction ${c1.id.slice(0, 8)} [PROPOSED]; full text via ledger_record_get(record_id: "${recAttr.id}", budget_tokens: 20000, detail: "evidence")`), sec);
  assert.ok(sec.includes(`- 1 new pending operation: session ${R8} seq 7 Bash`) && sec.includes(`- files touched (1): src/ingest/mixpanel.ts`), sec);
  assert.ok(!sec.includes("Attribution: compare") && !sec.includes("distinct_id guard"), "the delta references events and updates; it does not inline them");
  // rachit's last contributing session is 0199bbbb (his later session sidN contributes nothing); after T(70) only the updates were added
  const his = await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "rachit", now: T(120), viewer: "rachit" });
  assert.deepEqual({ last: his.changed_since?.last_session?.session_id, events: his.changed_since?.events, added: his.changed_since?.state_updates.added.length, pending: his.changed_since?.pending, files: his.changed_since?.files }, { last: sidR, events: [], added: 5, pending: [], files: [] });
  assert.ok(his.text.includes(`Your last contributing session ${R8} was last seen ${fmt(T(70))}. Since then:\n- state update added (5):`) && !his.text.includes("new content event"), his.text.slice(his.text.indexOf("## Changed since"), his.text.indexOf("## Bootstrap")));
  // the reading session is never its own last visit
  const self = await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", now: T(120), viewer: "agaaz", sessionId: sidA });
  assert.equal(self.changed_since?.first_visit, true, "with only its own session on the record, the viewer is on a first visit");
  ok("changed since your last visit: first visit reports totals; agaaz sees rachit's 6 content events (one exact ledger_events call), the 5 updates by id, the new pending op and the file; rachit sees only the updates; the reading session is excluded");
}

// ---------- 1d. as_of: state updates and events after the instant are hidden ----------
{
  // at T(20) only agaaz's events exist; every state update was created later (real clock), and rachit's pending call is in the future
  const early = await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", now: T(120), asOf: T(20).toISOString(), detail: "evidence" });
  assert.equal(early.as_of, T(20).toISOString());
  assert.ok(early.text.includes(`as of ${fmt(T(20))}: state updates and events after this instant are hidden (links and contributing sessions are not filtered).`), early.text.split("\n").slice(0, 5).join("\n"));
  assert.deepEqual({ total: early.evidence_summary.total, sessions: [...new Set(early.evidence_summary.shown.map((e) => e.session_id))], proposed: early.state.proposed_count, confirmed: early.state.confirmed_count, pending: early.pending_operations, files: early.files.map((f) => f.path), err: early.last_error?.seq, summary: early.session_summary },
    { total: 7, sessions: [sidA], proposed: 0, confirmed: 0, pending: [], files: ["queries/attribution.sql"], err: 7, summary: null }, "as of T(20): agaaz's 7 content events, no updates, no pending call, one file, agaaz's error, no compaction yet");
  assert.ok(early.text.includes("## State (v1 · 0 proposed · 0 confirmed)\n(no state updates yet") && !early.text.includes("- [PROPOSED]"), "no update existed yet");
  assert.deepEqual(early.contributing_sessions.map((s) => s.session_id), [sidR, sidA], "links are organisation, not evidence: both sessions stay listed");
  const earlyLean = await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", now: T(120), asOf: T(20).toISOString(), viewer: "agaaz" });
  assert.ok(earlyLean.text.includes("## Drill down (7 content events in 2 spans; references only)") && !earlyLean.text.includes("compaction summary"), "lean counts and pointers are as-of too");
  assert.ok(earlyLean.changed_since?.first_visit === false && earlyLean.changed_since?.events.length === 0, "the delta is bounded by as_of as well");
  // a later update is hidden by an as_of before it, and a confirmation after as_of shows the update as it was then: proposed
  const updatedBefore = (await R.getRecord(pool, recAttr.id))!.updated_at;
  const late = await R.addStateUpdate(pool, { record_id: recAttr.id, kind: "note", text: "LATER NOTE that as_of must hide", evidence: [{ session_id: sidR, seq: 4 }], created_by: "rachit" });
  await pool.query(`update cont_state_updates set created_at = now() + interval '1 hour' where id = $1`, [late.id]);
  await pool.query(`update cont_state_updates set confirmed_at = now() + interval '1 hour' where id = $1`, [d1.id]);
  const cut = new Date(Date.now() + 30 * 60_000).toISOString();
  const now2 = await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", now: T(120) });
  const asOf = await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", now: T(120), asOf: cut });
  assert.ok(now2.text.includes("LATER NOTE that as_of must hide") && now2.state.notes.length === 1 && now2.text.includes("### Notes (1)"), "without as_of the future-dated note is live");
  assert.ok(!asOf.text.includes("LATER NOTE") && asOf.state.notes.length === 0, "as_of hides the update created after it");
  assert.ok(now2.text.includes("- [confirmed by agaaz; how it was accepted was not recorded] Use ClickHouse") && asOf.text.includes("- [PROPOSED] Use ClickHouse paywall_resolved as the source of truth"), "a confirmation after as_of is undone: the decision shows as proposed");
  assert.deepEqual({ p: asOf.state.proposed_count, c: asOf.state.confirmed_count }, { p: 5, c: 0 });
  await assert.rejects(buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", asOf: "not-a-time" }), /as_of is not a time/);
  await pool.query(`update cont_state_updates set confirmed_at = created_at where id = $1`, [d1.id]);
  await pool.query(`delete from cont_state_updates where id = $1`, [late.id]);
  await pool.query(`update cont_records set updated_at = $2 where id = $1`, [recAttr.id, updatedBefore]);
  ok("as_of: at T(20) the pack has agaaz's 7 events, no state, no pending call, one file; a future-dated update is hidden and a later confirmation is undone; an invalid time is an error");
}

// ---------- 2. evidence from both sessions, attributed, ordered ----------
{
  const es = pack.evidence_summary;
  assert.equal(es.total, 13, "content events inside the spans: 7 from agaaz's span, 6 from rachit's");
  assert.equal(es.shown.length, EVIDENCE_HEAD + EVIDENCE_TAIL - 2, "2 instructions in head (only two exist), last 8; the head's second instruction is inside the tail");
  assert.deepEqual([...new Set(es.shown.map((e) => e.session_id))].sort(), [sidA, sidR].sort(), "both sessions present");
  for (let i = 1; i < es.shown.length; i++) assert.ok((es.shown[i].at ?? "") >= (es.shown[i - 1].at ?? ""), "time order");
  assert.deepEqual(es.shown.filter((e) => e.session_id === sidA).map((e) => e.seq), [1, 8, 9], "agaaz: first instruction (head) + the two events before rachit's span (tail)");
  assert.deepEqual(es.shown.filter((e) => e.session_id === sidR).map((e) => e.seq), [1, 2, 4, 5, 6, 7], "rachit: the whole linked span; seq 3 is a tool result, not content");
  assert.deepEqual(es.omitted, { count: 4, fetch: [`ledger_events(session_id: "${sidA}", after_seq: 0, before_seq: 11)`, `ledger_events(session_id: "${sidR}", after_seq: 0, before_seq: 8)`] }, "gap named with a fetch per span");
  const t = pack.text;
  assert.ok(t.includes("## Evidence across sessions (13 events in 2 spans, time order; first 3 instructions and last 8 shown)"), "section header");
  const la = t.indexOf(`${A8} agaaz/claude · 1 · `), lg = t.indexOf(`… 4 events omitted (${A8} seq 2 … ${A8} seq 6); fetch per span: ledger_events(session_id: "${sidA}", after_seq: 0, before_seq: 11)`), lr = t.indexOf(`${R8} rachit/codex · 1 · `);
  assert.ok(la > 0 && lg > la && lr > lg, `agaaz's instruction, then the gap line, then rachit's instruction (${la}, ${lg}, ${lr})`);
  assert.ok(t.includes("instruction.added · Attribution: compare Mixpanel and ClickHouse") && t.includes("instruction.added · Continue the attribution investigation"), "both instructions rendered");
  assert.ok(t.includes(`${R8} rachit/codex · 7 · `) && t.includes("tool.requested · Bash: psql analytics -c 'select count(*) from events where distinct_id is null and ts"), "rachit's pending call is in the evidence");
  assert.ok(!t.includes("Draft headline"), "the Landing copy span (rachit seq 8..9) is not this record's evidence");
  assert.ok(pack.omitted.some((o) => o.startsWith("4 evidence events omitted") && o.includes(`after_seq: 0, before_seq: 8`)), `omitted names the gap: ${pack.omitted.join(" | ")}`);
  assert.deepEqual(pack.contributing_sessions.map((s) => [s.session_id, s.author, s.harness, s.ended, s.spans]), [[sidR, "rachit", "codex", false, 1], [sidA, "agaaz", "claude", true, 1]], "contributing sessions, most recent first");
  assert.ok(t.includes(`- ${R8} · rachit · Codex · last seen ${fmt(T(70))} (not marked ended) · 1 span · thread ${thread.id.slice(0, 8)}`) && t.includes(`- ${A8} · agaaz · Claude Code · last seen ${fmt(T(15))} (ended) · 1 span`), "honesty lists sessions with harness, last seen, ended");
  assert.ok(t.includes(`Code saved through ${fmt(T(69))} (remote-verified; session ${R8}).`), "latest verified snapshot named");
  assert.deepEqual(pack.sources, { instructions: 2, assistant_messages: 3, tool_calls: 5, compaction_summaries: 1, sessions: 2, spans: 2, proposed_updates: 4, confirmed_updates: 1 });
  assert.ok(t.includes("Sources: 2 instructions, 3 assistant messages, 5 tool calls, 1 compaction summaries across 2 sessions in 2 spans; 4 proposed and 1 confirmed state updates."), "sources line");
  assert.ok(t.includes("The claim is advisory.") && t.includes("Proposed items are unconfirmed") && t.includes("Narrative-free: everything below is machine-assembled from evidence"), "standard honesty lines");
  ok("[acceptance 28] evidence from both sessions, attributed (session, author/harness), in time order, first instructions + last 8 with the gap named per span; contributing_sessions lists both; honesty block has sessions, snapshot, sources");
}

// ---------- 3. session summary from the compaction event, labeled with the harness ----------
{
  const ss = pack.session_summary!;
  assert.ok(ss, "session_summary present");
  assert.deepEqual({ harness: ss.harness, source: ss.source, session_id: ss.session_id, seq: ss.seq, clipped: ss.clipped, chars: ss.chars, text: ss.text }, { harness: "Codex", source: "codex_compacted", session_id: sidR, seq: 5, clipped: false, chars: codexSummary.length, text: codexSummary });
  assert.ok(pack.text.includes("### Session summary (written by Codex at compaction; evidence, not memory)"), "labeled with the harness");
  assert.ok(pack.text.includes(`source codex_compacted · session ${R8} seq 5 · ${fmt(T(34))} · ${codexSummary.length} chars\n${codexSummary}`), "summary text follows its provenance line");
  assert.ok(pack.text.indexOf("## Evidence across sessions") < pack.text.indexOf("### Session summary") && pack.text.indexOf("### Session summary") < pack.text.indexOf("### Files touched"), "summary sits after the evidence lines, before files");
  const copyPack = await buildRecordPack(cfg, pool, recCopy.id, { mode: "inspect", author: "agaaz", now: T(120) });
  assert.equal(copyPack.session_summary, null, "the compaction event is outside the Landing copy span");
  assert.ok(!copyPack.text.includes("Session summary"));
  // files: rachit's recent change first (within 60 min of last_seen), then agaaz's older one
  assert.deepEqual(pack.files.map((f) => [f.path, f.count, f.recent]), [["src/ingest/mixpanel.ts", 1, true], ["queries/attribution.sql", 1, false]]);
  assert.deepEqual(pack.recent_files.map((f) => f.path), ["src/ingest/mixpanel.ts"]);
  assert.ok(pack.text.includes(`### Files touched in the record's spans (2; recent = last 60 min of session ${R8})\n- src/ingest/mixpanel.ts ×1 (${fmt(T(60)).slice(11, 16)}) recent\n- queries/attribution.sql ×1`), "recent file first, marked");
  ok("[acceptance 31] session summary: the compaction event inside rachit's span, labeled 'written by Codex at compaction; evidence, not memory', absent for the record whose span excludes it; files touched with recent first");
}

// ---------- 4. pending operations inside the spans; last error ----------
{
  assert.deepEqual(pack.pending_operations, [{ call_id: "r-c2", tool: "Bash", input: "psql analytics -c 'select count(*) from events where distinct_id is null and ts > now() - interval 7 day'", seq: 7, session_id: sidR }], "r-c2 (seq 7, inside 1..7) listed; r-c3 (seq 10, outside) not");
  const t = pack.text;
  assert.ok(t.includes(`## Pending / unknown operations (1) — all contributing sessions, inside linked spans\n- session ${R8} seq 7 Bash: psql analytics -c 'select count(*) from events where distinct_id is null and ts > now() - interval 7 day'  ← outcome unknown; do not blindly rerun if it mutates anything`));
  assert.ok(!t.includes("npm run build"), "the pending call outside the spans is not listed");
  assert.deepEqual({ session_id: pack.last_error!.session_id, seq: pack.last_error!.seq }, { session_id: sidA, seq: 7 }, "last error inside any span: agaaz's failed psql");
  assert.ok(t.includes(`## Last error inside the spans\nsession ${A8} seq 7 `) && t.includes('psql: FATAL: database \\"events\\" does not exist'), "last error rendered with its stderr");
  const copyPack = await buildRecordPack(cfg, pool, recCopy.id, { mode: "inspect", author: "agaaz", now: T(120) });
  assert.deepEqual(copyPack.pending_operations, [], "Landing copy's span 8..9 has no pending call");
  assert.equal(copyPack.last_error, null);
  ok("pending operations: the unfinished call inside rachit's linked span is listed with the outcome-unknown warning; the one outside the span is not; the last error inside the spans comes from agaaz's session");
}

// ---------- 5. superseded Ledger reference flagged ----------
{
  assert.deepEqual(pack.ledger_refs.map((r) => ({ id: r.id, found: r.found, type: r.type, status: r.status, superseded_by: r.superseded_by })), [{ id: dec1.id, found: true, type: "decision", status: "deprecated", superseded_by: dec2.id }]);
  const t = pack.text;
  assert.ok(t.includes(`## Decisions in force for this work (1)\nLedger objects this work saved or linked, resolved to what is in force now. Only [in force] items are accepted knowledge.\n- [SUPERSEDED by ${dec2.id}, which is in force] decision ${dec1.id}: ClickHouse is the source of truth for the September paywall test (agaaz, ${TODAY}) · linked explicitly`), "superseded ref flagged inline");
  assert.ok(t.includes(`NOT IN FORCE (1): ${dec1.id} → ${dec2.id}. Do not act on these as decided.`), "summary line");
  assert.ok(t.includes("Captured from 0 Ledger save results in 0 sessions and 1 explicit link."), "capture disclosure");
  const copyPack = await buildRecordPack(cfg, pool, recCopy.id, { mode: "inspect", author: "agaaz", now: T(120) });
  assert.ok(copyPack.text.includes("## Decisions in force for this work (0)\n(none:"));
  // an unknown id is reported, not guessed
  const recX = await R.createRecord(pool, { kind: "other", title: "Dangling ref", repo: null, created_by: "agaaz", ledger_refs: [{ id: "dec-20260101-nope-zzzz", version: "3" }] });
  const px = await buildRecordPack(cfg, pool, recX.id, { mode: "inspect", author: "agaaz", now: T(120) });
  assert.ok(px.text.includes(`- [NOT FOUND] dec-20260101-nope-zzzz @3 · linked explicitly (ledger_get "dec-20260101-nope-zzzz")`), px.text);
  assert.equal(px.ledger_refs[0].found, false);
  await pool.query(`delete from cont_records where id = $1`, [recX.id]);
  ok(`[acceptance 32] the record's ledger_ref ${dec1.id} was superseded by ${dec2.id} after the reference was made; the pack flags it inline and in a summary line; a missing id is reported as NOT FOUND`);
}

// ---------- 6. unassigned span in a contributing session ----------
{
  assert.deepEqual(pack.unassigned.map((u) => [u.session_id, u.from_seq, u.to_seq, u.event_count, u.preview]), [[sidR, 10, 11, 2, "Unrelated: look at the CI flake in the deploy job"]], "rachit's seq 10..11 (build call + unrelated instruction) is unassigned; 8..9 belongs to Landing copy");
  const t = pack.text;
  assert.ok(t.includes(`## Unassigned spans in contributing sessions (may belong here; link with ledger_record_link)\n- rachit · codex · session ${R8} seq 10..11 (2 events, `) && t.includes(`) "Unrelated: look at the CI flake in the deploy job"`), "unassigned line with preview and seq range");
  assert.ok(!t.includes("quick sanity check"), "the unrelated third session is not a contributing session, so its span is not here");
  const copyPack = await buildRecordPack(cfg, pool, recCopy.id, { mode: "inspect", author: "agaaz", now: T(120) });
  assert.deepEqual(copyPack.unassigned.map((u) => [u.from_seq, u.to_seq]), [[10, 11]], "same session, same unassigned span, from the other record's view");
  ok("unassigned: the unlinked span 10..11 of rachit's session is reported with its preview from both records that share the session; a non-contributing session's material is not");
}

// ---------- 7. bootstrap for the repo record; non-code for the other ----------
{
  assert.deepEqual(pack.bootstrap, [
    `git fetch origin ${WIP_REF}:${WIP_REF}`,
    `git worktree add --detach ../attribution-investigation ${WIP_COMMIT}`,
    `# then, deliberately: git -C ../attribution-investigation rebase origin/master   (or merge; your call, not automatic)`,
  ]);
  assert.ok(pack.text.includes(`## Bootstrap\nsnapshot from session ${R8} (rachit, Codex)\n\`\`\`\ngit fetch origin ${WIP_REF}:${WIP_REF}\n`), "bootstrap block names the snapshot's session");
  assert.ok(pack.text.includes("2. Check out the snapshot into a fresh worktree"), "code contract");
  const copyLean = await buildRecordPack(cfg, pool, recCopy.id, { mode: "inspect", author: "agaaz", now: T(120) });
  assert.ok(copyLean.text.includes("## Bootstrap\nnon-code record; no worktree") && copyLean.text.includes("Non-code record: no code snapshot applies.") && !copyLean.text.includes("First turn contract"), "lean non-code bootstrap and honesty");
  const copyPack = await buildRecordPack(cfg, pool, recCopy.id, { mode: "inspect", author: "agaaz", now: T(120), detail: "evidence" });
  assert.deepEqual(copyPack.bootstrap, []);
  assert.ok(copyPack.text.includes("## Bootstrap\nnon-code record; no worktree"), "non-code bootstrap");
  assert.ok(copyPack.text.includes(`record ${recCopy.id} · writing · non-code work · status open · created by rachit`), "non-code header");
  assert.ok(copyPack.text.includes("Non-code record: no code snapshot applies."));
  assert.ok(copyPack.text.includes("2. This is non-code work: there is no worktree."), "non-code contract");
  // a session-less wip falls back to the thread's head checkpoint
  await S.updateSession(pool, sidR, { wip_ref: null, wip_commit: null });
  const viaHead = await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", now: T(120) });
  assert.equal(viaHead.bootstrap[0], `git fetch origin ${WIP_REF}:${WIP_REF}`);
  assert.ok(viaHead.text.includes(`snapshot from thread ${thread.id.slice(0, 8)} head checkpoint`), "falls back to the thread head");
  await S.updateSession(pool, sidR, { wip_ref: WIP_REF, wip_commit: WIP_COMMIT });
  ok("bootstrap: the repo record prints fetch + worktree commands for rachit's wip ref (session first, thread head as fallback); the non-code record says 'non-code record; no worktree' and adapts the contract");
}

// ---------- 8. mode continue acquires the thread claim; inspect does not ----------
{
  assert.equal(pack.claim.acquired, false);
  assert.equal(pack.claim.thread_id, thread.id);
  assert.equal(await S.getClaim(pool, thread.id), null, "inspect left the thread unclaimed");
  assert.ok(pack.text.includes(`claim: thread ${thread.id} ("Attribution gap") has no live claim; inspect only`));
  const cont = await buildRecordPack(cfg, pool, recAttr.id, { mode: "continue", author: "agaaz", sessionId: "agaaz-resume-1", now: T(120) });
  assert.deepEqual({ acquired: cont.claim.acquired, generation: cont.claim.generation, thread_id: cont.claim.thread_id }, { acquired: true, generation: genR + 1, thread_id: thread.id });
  const live = await S.getClaim(pool, thread.id);
  assert.deepEqual({ holder: live?.holder_session_id, author: live?.holder_author, generation: live?.generation }, { holder: "agaaz-resume-1", author: "agaaz", generation: genR + 1 });
  assert.ok(cont.text.includes(`claim: claim acquired on thread ${thread.id} ("Attribution gap"), generation ${genR + 1}. Advisory: it protects the shared record, not the other machine.`));
  const blocked = await buildRecordPack(cfg, pool, recAttr.id, { mode: "continue", author: "rachit", sessionId: "rachit-resume-2", now: T(121) });
  assert.equal(blocked.claim.acquired, false);
  assert.equal(blocked.claim.holder?.holder_author, "agaaz");
  assert.ok(blocked.text.includes(`is claimed by agaaz since`) && blocked.text.includes(`ledger_resume(thread_id: "${thread.id}", mode: "fork")`), "a held claim is reported with the fork escape hatch");
  const copyCont = await buildRecordPack(cfg, pool, recCopy.id, { mode: "continue", author: "agaaz", sessionId: "agaaz-resume-1", now: T(120) });
  assert.deepEqual({ acquired: copyCont.claim.acquired, thread_id: copyCont.claim.thread_id }, { acquired: false, thread_id: null });
  assert.ok(copyCont.text.includes("claim: non-code record; no thread claim"));
  assert.equal(await S.releaseClaim(pool, thread.id, "agaaz-resume-1"), true);
  ok(`claim: inspect never claims; continue claims the thread of the latest contributing session (generation ${genR + 1}, held by agaaz-resume-1); a second continue sees the holder; the non-code record has no claim`);
}

// ---------- 9. budget 1500 keeps honesty, decisions, pending, bootstrap; drops named ----------
{
  const tight = await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", now: T(120), budgetTokens: 1500, detail: "evidence" });
  assert.ok(approxTokens(pack.text) <= 6000, `default pack within 6000 tokens: ${approxTokens(pack.text)}`);
  assert.ok(tight.text.length < pack.text.length, `tight pack is smaller: ${tight.text.length} < ${pack.text.length}`);
  for (const must of ["## Honesty", "Sources: 2 instructions", `Code saved through ${fmt(T(69))}`, "### Decisions (1)", "- [confirmed by agaaz; how it was accepted was not recorded] Use ClickHouse paywall_resolved", "## Pending / unknown operations (1)", "seq 7 Bash: psql analytics", "## Bootstrap", `git fetch origin ${WIP_REF}:${WIP_REF}`, "## First turn contract", `NOT IN FORCE (1): ${dec1.id} → ${dec2.id}`, "## Omitted for budget or unavailable"]) {
    assert.ok(tight.text.includes(must), `tight pack keeps: ${must}`);
  }
  assert.ok(pack.text.includes(codexSummary) && !tight.text.includes(codexSummary), "the summary text is dropped under budget");
  assert.ok(tight.omitted.some((o) => o.startsWith("session summary text (omitted for budget)")), `summary drop named: ${tight.omitted.join(" | ")}`);
  assert.ok(tight.omitted.some((o) => (o.includes("evidence events omitted") && o.includes("shortened for budget")) || o.startsWith("evidence lines (omitted for budget)")), `evidence drop named: ${tight.omitted.join(" | ")}`);
  assert.ok(tight.omitted.every((o) => !/omitted for budget|shortened for budget/.test(o) || /ledger_/.test(o)), "every budget drop names the call that fetches it");
  assert.ok(tight.omitted.some((o) => o.includes("older hypotheses (list shortened for budget)") && o.includes(`ledger_record_get(record_id: "${recAttr.id}"`)), "state cap named with the fetch call");
  assert.ok(tight.text.includes("… 1 more via ledger_record_get"), "in-text pointer for the capped kind");
  assert.ok(tight.evidence_summary.shown.length <= 3 && tight.evidence_summary.omitted!.count >= 10, "evidence head/tail shrink");
  assert.equal(tight.session_summary!.text, codexSummary, "JSON keeps the summary");
  assert.equal(tight.state.hypotheses.length, 2, "JSON keeps the full state");
  // a tight lean pack keeps the same guarantees without ever inlining evidence
  const tightLean = await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", now: T(120), budgetTokens: 1500 });
  for (const must of ["### Decisions (1)", "- [confirmed by agaaz; how it was accepted was not recorded] Use ClickHouse paywall_resolved", "## Pending / unknown operations (1)", "seq 7 Bash: psql analytics", "## Bootstrap", `git fetch origin ${WIP_REF}:${WIP_REF}`, "## Drill down", `[SUPERSEDED by ${dec2.id}, which is in force]`]) assert.ok(tightLean.text.includes(must), `tight lean pack keeps: ${must}`);
  assert.ok(approxTokens(tightLean.text) <= 1500 && !tightLean.text.includes(codexSummary), `tight lean pack within budget: ${approxTokens(tightLean.text)}`);
  ok(`budget 1500 (evidence detail): honesty, snapshot, decisions, pending op, bootstrap, contract, superseded flag survive (${approxTokens(tight.text)} tokens vs ${approxTokens(pack.text)}); summary text, evidence tail, and soft state kinds shrink with each drop named; the lean pack keeps the same guarantees at ${approxTokens(tightLean.text)} tokens`);
}

// ---------- 11. listRecordSummaries counts and recordLine ----------
{
  const rows = await listRecordSummaries(pool, { sinceHours: 24 });
  const attr = rows.find((r) => r.id === recAttr.id)!, copy = rows.find((r) => r.id === recCopy.id)!;
  assert.deepEqual({ sessions: attr.sessions, proposed: attr.proposed, confirmed: attr.confirmed, np: attr.newest_proposed?.text, npKind: attr.newest_proposed?.kind, npBy: attr.newest_proposed?.created_by }, { sessions: 2, proposed: 4, confirmed: 1, np: "Size the effect of the distinct_id guard against the attribution window", npKind: "next", npBy: "classifier" });
  assert.deepEqual({ sessions: copy.sessions, proposed: copy.proposed, confirmed: copy.confirmed, np: copy.newest_proposed }, { sessions: 1, proposed: 0, confirmed: 0, np: null });
  assert.equal(rows[0].id, recCopy.id, "most recently updated first");
  assert.match(recordLine(attr, T(120)), new RegExp(`^- investigation · Attribution investigation · touched demo · updated \\d+[mh] ago · 2 sessions · 4/1 updates · ${attr.id}$`));
  assert.match(recordLine(copy, T(120)), new RegExp(`^- writing · Landing copy · non-code · updated \\d+[mh] ago · 1 session · 0/0 updates · ${copy.id}$`));
  assert.deepEqual((await listRecordSummaries(pool, { repo: REPO })).map((r) => r.id), [recAttr.id], "repo filter");
  assert.deepEqual((await listRecordSummaries(pool, { repo: null })).map((r) => r.id), [recCopy.id], "repo null = non-code only");
  assert.deepEqual((await listRecordSummaries(pool, { kind: "writing" })).map((r) => r.id), [recCopy.id]);
  assert.deepEqual((await listRecordSummaries(pool, { q: "attribution" })).map((r) => r.id), [recAttr.id]);
  assert.deepEqual(await listRecordSummaries(pool, { author: "nobody" }), []);
  // a superseded proposed update no longer counts; a rejected one never did
  const sup = await R.addStateUpdate(pool, { record_id: recCopy.id, kind: "note", text: "first draft", evidence: [{ session_id: sidR, seq: 9 }], created_by: "rachit" });
  const sup2 = await R.addStateUpdate(pool, { record_id: recCopy.id, kind: "note", text: "second draft", evidence: [{ session_id: sidR, seq: 9 }], created_by: "rachit", supersedes: sup.id });
  const rej = await R.addStateUpdate(pool, { record_id: recCopy.id, kind: "note", text: "wrong record", evidence: [{ session_id: sidR, seq: 9 }], created_by: "rachit" });
  await R.rejectStateUpdate(pool, rej.id, "agaaz", "belongs elsewhere");
  const copy2 = (await listRecordSummaries(pool, { repo: null })).find((r) => r.id === recCopy.id)!;
  assert.deepEqual({ proposed: copy2.proposed, confirmed: copy2.confirmed, np: copy2.newest_proposed?.id }, { proposed: 2, confirmed: 0, np: sup2.id }, "unaccepted replacements preserve both proposals; rejected updates excluded");
  ok("listRecordSummaries: distinct sessions, proposed/confirmed in the current projection (superseded and rejected excluded), newest proposed update; recordLine format; repo/null/kind/q/author filters");
}

// ---------- 12. brief sections: Open work + Unassigned work ----------
{
  const text = await openWorkText(cfg, { now: T(120) });
  assert.ok(text.startsWith("## Open work (records), last 14 days\n"), text.split("\n")[0]);
  assert.ok(text.includes(`· Attribution investigation · touched demo · `) && text.includes(`· ${recAttr.id}`), "attribution record line");
  assert.ok(text.includes(`· Landing copy · non-code · `) && text.includes(`· ${recCopy.id}`), "landing copy line");
  assert.ok(text.includes(`\n  PROPOSED next: "Size the effect of the distinct_id guard against the attribution window" (by classifier)\n`), "newest proposed update under the record");
  assert.ok(text.includes(`\n  PROPOSED note: "second draft" (by rachit)\n`) || text.endsWith(`\n  PROPOSED note: "second draft" (by rachit)`) || text.includes(`  PROPOSED note: "second draft" (by rachit)\n\n## Unassigned`), "landing copy's newest proposed note");
  const ui = text.indexOf("## Unassigned work, last 48h");
  assert.ok(ui > 0 && ui > text.indexOf("## Open work"), "unassigned section after open work");
  assert.ok(text.includes(`- rachit · codex · session ${R8} seq 10..11 (2 events, `) && text.includes(`"Unrelated: look at the CI flake in the deploy job"`), "rachit's unlinked span");
  assert.ok(text.includes(`- rachit · codex · session ${sidN.slice(0, 8)} seq 1..2 (2 events, `) && text.includes(`"hey, quick sanity check on the numbers from yesterday?"`), "the session with nothing assignable");
  assert.ok(text.indexOf(sidN.slice(0, 8)) < text.indexOf(`session ${R8} seq 10..11`), "most recently active session first");
  assert.ok(!text.includes("Draft headline") && !text.includes("Continue the attribution investigation"), "linked spans are not unassigned");
  // openThreadsText appends the work sections after its own; the thread is rachit's so it shows for agaaz
  const all = await openThreadsText(cfg, {});
  assert.ok(all.includes("## Open threads, last 48h") && all.includes(thread.id) && all.indexOf("## Open threads") < all.indexOf("## Open work (records)") && all.indexOf("## Open work (records)") < all.indexOf("## Unassigned work"), "threads, then open work, then unassigned");
  // a 100-char clip on the proposed text
  const long = await R.addStateUpdate(pool, { record_id: recCopy.id, kind: "note", text: "L".repeat(180), evidence: [{ session_id: sidR, seq: 9 }], created_by: "rachit" });
  const clipped = await openWorkText(cfg, { now: T(120) });
  assert.ok(clipped.includes(`  PROPOSED note: "${"L".repeat(99)}…" (by rachit)`), "proposed text clipped to 100 chars");
  await R.rejectStateUpdate(pool, long.id, "agaaz", "test noise");
  // nothing invented: the brief created no record for the unassigned session
  assert.equal((await R.listRecords(pool, {})).length, 2, "no record was created from unassigned material");
  assert.equal((await R.recordsForSession(pool, sidN)).length, 0);
  ok("[acceptance 33] brief: Open work lists both records with their newest PROPOSED update (clipped to 100 chars); Unassigned work lists rachit's unlinked span and the session with nothing assignable, most recent first; no record is invented; openThreadsText appends both sections");
}

// ---------- 10. MCP tools in-process: ledger_record_update propose → confirm; reject needs a reason ----------
const server = createMcpServer(cfg);
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
const client = new Client({ name: "selftest-recordpack", version: "0" });
await client.connect(ct);
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  return (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
};
{
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ["ledger_resume", "ledger_records", "ledger_record_get", "ledger_record_link", "ledger_record_update", "ledger_record_start", "ledger_unassigned", "ledger_evidence_search", "ledger_search", "ledger_events"]) assert.ok(names.includes(n), `tool registered: ${n}`);
  const before = (await R.getRecord(pool, recAttr.id))!.state_version;
  const noEv = await call("ledger_record_update", { record_id: recAttr.id, action: "propose", kind: "progress", text: "Sized the guard" });
  assert.match(noEv, /^propose needs evidence/);
  const p = await call("ledger_record_update", { record_id: recAttr.id, action: "propose", kind: "progress", text: "Sized the distinct_id guard: 1,830 of 41,200 rows lack a distinct_id", evidence: [{ session_id: sidA, seq: 10 }] });
  const pid = p.match(/update ([0-9a-f-]{36})/)?.[1];
  assert.ok(pid && UUID.test(pid), p);
  assert.ok(p.startsWith(`Proposed progress update ${pid} on record "Attribution investigation" (status proposed; state_version unchanged at ${before})`), p);
  let st1 = (await R.recordState(pool, recAttr.id))!;
  assert.deepEqual({ status: st1.progress[0].status, by: st1.progress[0].created_by, ev: st1.progress[0].evidence, v: st1.record.state_version }, { status: "proposed", by: "agaaz", ev: [{ session_id: sidA, seq: 10 }], v: before }, "propose never confirms; state_version unchanged");
  const c = await call("ledger_record_update", { record_id: recAttr.id, action: "confirm", update_id: pid });
  assert.equal(c, `Confirmed progress update ${pid} on record "Attribution investigation": successors see [agent-confirmed for agaaz; not reviewed by a person] (state_version now ${before + 1}). A person accepts it with \`ledger record confirm ${pid}\` in a terminal.`);
  assert.equal((await R.getStateUpdate(pool, pid!))!.confirmed_via, "mcp", "an MCP confirmation is recorded as an agent's");
  st1 = (await R.recordState(pool, recAttr.id))!;
  assert.equal(st1.record.state_version, before + 1, "confirm bumps state_version");
  assert.equal(st1.progress[0].status, "confirmed");
  const p2 = await call("ledger_record_update", { record_id: recAttr.id, action: "propose", kind: "blocker", text: "analytics DB credentials missing on CI", evidence: [{ session_id: sidA, seq: 7 }] });
  const pid2 = p2.match(/update ([0-9a-f-]{36})/)?.[1]!;
  const noReason = await call("ledger_record_update", { record_id: recAttr.id, action: "reject", update_id: pid2 });
  assert.match(noReason, /^reject needs reason/);
  assert.equal((await R.recordState(pool, recAttr.id))!.blockers.length, 1, "still proposed after the refused reject");
  const rj = await call("ledger_record_update", { record_id: recAttr.id, action: "reject", update_id: pid2, reason: "credentials exist; the DB name was wrong" });
  assert.equal(rj, `Rejected blocker update ${pid2} on record "Attribution investigation": credentials exist; the DB name was wrong (state_version unchanged at ${before + 1}).`);
  st1 = (await R.recordState(pool, recAttr.id))!;
  assert.equal(st1.blockers.length, 0);
  assert.equal(st1.record.state_version, before + 1, "reject does not bump");
  assert.match(await call("ledger_record_update", { record_id: recAttr.id, action: "confirm" }), /^confirm needs update_id/);
  assert.match(await call("ledger_record_update", { record_id: "00000000-0000-4000-8000-000000000000", action: "confirm", update_id: pid }), /^Not found: record/);
  assert.match(await call("ledger_record_update", { record_id: recAttr.id, action: "confirm", update_id: pid2 }), /^ledger_record_update failed: state update .* is rejected/);
  ok("ledger_record_update: propose requires evidence and never confirms; confirm bumps state_version; reject requires a reason and does not bump; wrong states are reported, not silently accepted");
}

// ---------- MCP: the other record tools ----------
{
  const list = await call("ledger_records", {});
  assert.ok(list.includes(recAttr.id) && list.includes(recCopy.id) && list.includes("· Attribution investigation · touched demo ·"), list);
  assert.ok((await call("ledger_records", { kind: "writing" })).includes(recCopy.id) && !(await call("ledger_records", { kind: "writing" })).includes(recAttr.id));
  assert.match(await call("ledger_records", { q: "zzz-nothing" }), /(^|\n)No records match\.$/, "a scope line may precede the empty result");
  const get = await call("ledger_record_get", { record_id: recAttr.id });
  assert.ok(get.startsWith("# Record pack: Attribution investigation\n") && get.includes("[PROPOSED]") && get.includes("## Bootstrap"), "ledger_record_get returns the pack");
  assert.equal(await S.getClaim(pool, thread.id), null, "ledger_record_get does not claim");
  const res = await call("ledger_resume", { record_id: recAttr.id, mode: "inspect" });
  assert.ok(res.startsWith("# Record pack: Attribution investigation\n") && res.includes("inspect only"), "ledger_resume with record_id");
  assert.equal(await call("ledger_resume", {}), "thread_id or record_id is required.");
  assert.match(await call("ledger_resume", { record_id: recAttr.id, mode: "fork" }), /^mode=fork applies to threads/);
  assert.match(await call("ledger_resume", { record_id: "00000000-0000-4000-8000-000000000000", mode: "inspect" }), /^ledger_resume failed: record not found/);
  const thr = await call("ledger_resume", { thread_id: thread.id, mode: "inspect" });
  assert.ok(thr.startsWith("# Resume pack: Attribution gap\n"), "thread path unchanged");
  const un = await call("ledger_unassigned", { session_id: sidR });
  assert.ok(un.includes(`session ${R8} seq 10..11 (2 events, `) && un.includes("Unrelated: look at the CI flake"), un);
  assert.equal(await call("ledger_unassigned", { session_id: sidA }), "No unassigned spans match.");
  // the search tool may print a "scope:" header line first and suffix each hit with an authority tier; hit lines stay `[rank] sid author/harness · seq · HH:MM · …`
  const hits = (out: string) => out.split("\n").filter((l) => !l.startsWith("scope:"));
  const srch = await call("ledger_evidence_search", { q: "distinct_id", record_id: recAttr.id });
  const srchLines = hits(srch);
  assert.ok(srchLines.length >= 4 && srchLines.every((l) => /^\[\d\.\d+\] [0-9a-z-]{8} (agaaz\/claude|rachit\/codex) · \d+ · \d\d:\d\d · /.test(l)), srch);
  assert.ok(srch.includes(`${R8} rachit/codex · 4 · `) && srch.includes(`${A8} agaaz/claude · 4 · `), "hits from both sessions");
  assert.ok(!srch.includes("npm run build"), "restricted to the record's spans");
  const srchS = await call("ledger_evidence_search", { q: "attribution window", session_id: sidR, kinds: ["compaction"] });
  assert.ok(hits(srchS).length === 1 && srchS.includes("compaction · codex_compacted"), srchS);
  assert.match(await call("ledger_evidence_search", { q: "zebra-quokka" }), /(^|\n)No events match/);
  const start = await call("ledger_record_start", { kind: "other", title: "CI flake in the deploy job", cwd: tmp, link: { session_id: sidR, from_seq: 10, to_seq: 11 } });
  const newId = start.match(/^Record ([0-9a-f-]{36}) "CI flake in the deploy job" \(other\) created as non-code work by agaaz\. Linked session /)?.[1];
  assert.ok(newId, start);
  assert.equal((await R.getRecord(pool, newId!))!.repo, null, "tmp is not a git repo, so the record is non-code");
  assert.deepEqual(await R.unassignedSpans(pool, { session_id: sidR }), [], "the span is no longer unassigned");
  const link = await call("ledger_record_link", { record_id: newId!, session_id: sidN, from_seq: 1, to_seq: 2, note: "same topic" });
  assert.match(link, new RegExp(`^Linked session ${sidN} seq 1\\.\\.2 to record "CI flake in the deploy job" \\(${newId}\\); link [0-9a-f-]{36}, explicit, by agaaz\\.$`));
  const links = await R.recordLinks(pool, newId!);
  assert.deepEqual(links.map((l) => [l.session_id, l.from_seq, l.to_seq, l.source, l.created_by, l.note]), [[sidR, 10, 11, "explicit", "agaaz", null], [sidN, 1, 2, "explicit", "agaaz", "same topic"]]);
  assert.match(await call("ledger_record_link", { record_id: newId!, session_id: "no-such-session", from_seq: 1, to_seq: 2 }), /^ledger_record_link failed: session not found/);
  assert.match(await call("ledger_record_get", { record_id: "not-a-uuid" }), /^ledger_record_get failed: record not found/);
  const inRepo = await call("ledger_record_start", { kind: "implementation", title: "Repo-bound record", cwd: process.cwd() });
  const repoRec = await R.getRecord(pool, inRepo.match(/^Record ([0-9a-f-]{36})/)![1]);
  assert.ok(repoRec!.repo && inRepo.includes(` created on ${repoRec!.repo} by agaaz.`), "cwd inside a git repo gives the record that repo identity");
  await pool.query(`delete from cont_records where id = $1`, [repoRec!.id]);
  ok("MCP tools: ledger_records (filters), ledger_record_get (no claim), ledger_resume(record_id) with inspect/fork/missing handling and the thread path intact, ledger_unassigned, ledger_evidence_search (ranked, attributed, span-restricted), ledger_record_start (+link, repo or non-code), ledger_record_link");
}

// ---------- 13. acceptance tests from spec §13a, asserted explicitly ----------
{
  const fresh = await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", now: T(130), detail: "evidence" });
  // 28: two sessions by different authors contribute to one record
  assert.deepEqual(fresh.contributing_sessions.map((s) => s.session_id).sort(), [sidA, sidR].sort());
  assert.deepEqual(new Set(fresh.contributing_sessions.map((s) => s.author)), new Set(["agaaz", "rachit"]));
  assert.ok(fresh.evidence_summary.shown.some((e) => e.session_id === sidA) && fresh.evidence_summary.shown.some((e) => e.session_id === sidR));
  for (let i = 1; i < fresh.evidence_summary.shown.length; i++) assert.ok((fresh.evidence_summary.shown[i].at ?? "") >= (fresh.evidence_summary.shown[i - 1].at ?? ""));
  assert.ok(fresh.evidence_summary.shown.every((e) => e.author && e.harness && fresh.text.includes(`${e.session_id.slice(0, 8)} ${e.author}/${e.harness} · ${e.seq} · `)), "every shown event is attributed in the text");
  ok("[acceptance 28] two sessions by different authors contribute to one record: ledger_resume(record) shows evidence from both, ordered, attributed; contributing_sessions lists both");
  // 29: two contradicting hypotheses from different sessions
  const hyp = fresh.state.hypotheses;
  assert.deepEqual(hyp.map((h) => [h.id, h.created_by, h.session_id, h.status]), [[h1.id, "agaaz", sidA, "proposed"], [h2.id, "rachit", sidR, "proposed"]], "both hypotheses present, from different sessions, neither confirmed or rejected");
  assert.equal(fresh.state.contradictions.length, 1);
  assert.equal(fresh.state.contradictions[0].id, c1.id);
  assert.ok(fresh.text.includes("### Contradictions (both sides kept; never resolved by timestamp) (1)"));
  assert.ok(fresh.text.includes("missing distinct_id being dropped (by agaaz") && fresh.text.includes("7-day attribution window, not distinct_id (by rachit"), "both sides rendered");
  assert.equal((await pool.query(`select count(*)::int as n from cont_state_updates where record_id = $1 and kind = 'hypothesis' and status <> 'proposed'`, [recAttr.id])).rows[0].n, 0, "nothing auto-resolved the later one over the earlier one");
  ok("[acceptance 29] two contradicting hypotheses from different sessions: both present in the record state, contradiction listed beside them, neither auto-resolved");
  // 30: classifier proposes; nobody confirms
  assert.equal(versionBeforeN1, 1, "state_version was 1 (one confirmed decision) before the classifier's proposal");
  const nx = fresh.state.next.find((u) => u.id === n1.id)!;
  assert.deepEqual({ status: nx.status, by: nx.created_by, confirmed_by: nx.confirmed_by }, { status: "proposed", by: "classifier", confirmed_by: null });
  assert.ok(fresh.text.includes(`- [PROPOSED] Size the effect of the distinct_id guard against the attribution window (by classifier, ${TODAY}; evidence: seq 5 of ${R8})`), "renders as PROPOSED");
  assert.equal((await R.getRecord(pool, recAttr.id))!.state_version, versionBeforeN1 + 1, "state_version moved only for the confirmed progress update in check 10, never for the classifier's proposal");
  const nowV = (await R.getRecord(pool, recAttr.id))!.state_version;
  const cls = await R.addStateUpdate(pool, { record_id: recAttr.id, kind: "hypothesis", text: "classifier: both effects overlap", evidence: [{ session_id: sidR, seq: 5 }], created_by: "classifier" });
  assert.equal((await R.getRecord(pool, recAttr.id))!.state_version, nowV, "a new classifier proposal leaves state_version unchanged");
  assert.ok((await buildRecordPack(cfg, pool, recAttr.id, { mode: "inspect", author: "agaaz", now: T(130) })).text.includes("- [PROPOSED] classifier: both effects overlap (by classifier"));
  await R.rejectStateUpdate(pool, cls.id, "agaaz", "test noise");
  ok("[acceptance 30] a classifier-proposed state update nobody confirms renders as PROPOSED in the pack and leaves state_version unchanged");
  // 32: superseded decision flagged
  assert.equal(fresh.ledger_refs[0].status, "deprecated");
  assert.equal(fresh.ledger_refs[0].superseded_by, dec2.id);
  assert.ok(fresh.text.includes(`[SUPERSEDED by ${dec2.id}, which is in force]`));
  ok("[acceptance 32] a record referencing a decision that was later superseded: the pack flags it");
  // 33: session with no assignable content → Unassigned work in the brief; nothing invented
  // (its span was linked to the CI-flake record in the MCP check above, so re-create the situation with a fresh session)
  const sidZ = "agaaz-claude-nothing-2";
  await S.upsertSession(pool, { id: sidZ, author: "agaaz", harness: "claude", machine: "agaaz-mac", repo: null, started_at: T(90), last_seen_at: T(91) });
  await S.appendEvents(pool, sidZ, [ev("z1", "instruction.added", 90, { text: "thinking out loud, ignore" })], null, null);
  const recordsBefore = (await R.listRecords(pool, {})).length;
  const briefText = await openWorkText(cfg, { now: T(130) });
  assert.ok(briefText.includes("## Unassigned work, last 48h") && briefText.includes(`- agaaz · claude · session ${sidZ.slice(0, 8)} seq 1..1 (1 event, `) && briefText.includes(`"thinking out loud, ignore"`), briefText);
  assert.equal((await R.listRecords(pool, {})).length, recordsBefore, "the brief invents no record");
  assert.equal((await R.recordsForSession(pool, sidZ)).length, 0);
  assert.ok(!briefText.includes("Open work (records)") || !briefText.slice(0, briefText.indexOf("## Unassigned work")).includes(sidZ.slice(0, 8)), "the session appears only under Unassigned work");
  ok("[acceptance 33] a session with no assignable content appears under Unassigned work in the brief with its exact preview; nothing invented");
}

// A long mixed-topic record retains its actual tail, old pending work, and accepted constraints.
{
  const sidLong = 'reuse-long-history';
  const sidFresh = 'reuse-fresh-contributor';
  for (const sid of [sidLong,sidFresh]) await S.upsertSession(pool,{id:sid,author:'agaaz',harness:'codex',machine:'test',repo:null,started_at:T(0),last_seen_at:sid===sidFresh?T(5000):T(4500)});
  const events = Array.from({length:2105},(_,i)=>ev(`long-${i}`,i===0?'instruction.added':i===1?'tool.requested':'assistant.message',i,{...(i===1?{tool:'export',input:'export denominator evidence'}:{text:i===0?'ORIGINAL QUESTION':i===2104?'ACTUAL LATEST EVIDENCE':`unrelated chatter ${i}`})},i===1?'old-pending-export':undefined));
  await S.appendEvents(pool,sidLong,events,null,null);
  await S.appendEvents(pool,sidFresh,[ev('fresh','assistant.message',5000,{text:'new contributor note'})],null,null);
  const rec = await R.createRecord(pool,{kind:'investigation',title:'Long correction investigation',created_by:'agaaz'});
  await R.linkSpan(pool,{record_id:rec.id,session_id:sidLong,from_seq:1,to_seq:2105,source:'explicit',created_by:'agaaz'});
  await R.linkSpan(pool,{record_id:rec.id,session_id:sidFresh,from_seq:1,to_seq:1,source:'explicit',created_by:'agaaz'});
  await R.addStateUpdate(pool,{record_id:rec.id,kind:'decision',text:'ACCEPTED DENOMINATOR CONSTRAINT',created_by:'agaaz',status:'confirmed',evidence:[{session_id:sidLong,seq:1}]});
  for(let i=0;i<12;i++) await R.addStateUpdate(pool,{record_id:rec.id,kind:'decision',text:`newer unsupported proposal ${i}`,created_by:'rachit'});
  const longLean = await buildRecordPack(cfg,pool,rec.id,{mode:'inspect',author:'agaaz',budgetTokens:20000});
  assert.equal(longLean.detail,'lean','a 20000 budget alone does not switch to evidence');
  assert.ok(longLean.text.includes('ACCEPTED DENOMINATOR CONSTRAINT') && longLean.text.includes('- [PROPOSED] 12 proposed, accepted by nobody: ') && !longLean.text.includes('newer unsupported proposal 0'), 'lean: the accepted constraint in full, 12 proposals as a count plus ids');
  assert.ok(longLean.text.includes(`Full text of proposed 12 decisions: ledger_record_get(record_id: "${rec.id}", detail: "evidence")`), longLean.text);
  assert.ok(longLean.text.includes('- ledger_events(session_id: "reuse-long-history", after_seq: 0, limit: 200) then page with after_seq up to 2105  · agaaz/Codex'), 'a span longer than the tool limit says how to page');
  assert.ok(longLean.pending_operations.some(p=>p.call_id==='old-pending-export') && longLean.text.includes('seq 2 export: export denominator evidence'), 'lean keeps the old pending operation');
  assert.ok(!/unrelated chatter/.test(longLean.text) && !/ACTUAL LATEST EVIDENCE/.test(longLean.text), 'lean inlines none of the 2,105 events');
  const longPack = await buildRecordPack(cfg,pool,rec.id,{mode:'inspect',author:'agaaz',budgetTokens:20000,detail:'evidence'});
  assert.equal(longPack.evidence_summary.total,2106);
  assert.ok(longPack.evidence_summary.shown.some(e=>e.seq===2105 && e.session_id===sidLong),'true tail after oldest 2000');
  assert.ok(longPack.pending_operations.some(p=>p.session_id===sidLong && p.call_id==='old-pending-export'),'older contributor pending work retained');
  assert.ok(longPack.text.includes('ACCEPTED DENOMINATOR CONSTRAINT'),'proposals cannot crowd out accepted constraints');
  assert.equal(longPack.evidence_summary.omitted!.count,2106-longPack.evidence_summary.shown.length);
  ok('full-history count and true tail, earlier pending operation, accepted constraint under proposal flood; lean summarises the 12 proposals as ids and pages the 2,105-event span');
}

// ---------- rejecting a proposed decision settles its checkpoint prompt ----------
{
  const H = await import("./hooks.js");
  const u = await R.addStateUpdate(pool, { record_id: recAttr.id, session_id: sidA, from_seq: 1, to_seq: 1, kind: "decision", text: "Report only ClickHouse numbers in the readout", evidence: [{ session_id: sidA, seq: 1 }], created_by: "classifier" });
  H.addDecisionObligations(sidA, [{ update_id: u.id, record_title: "Attribution investigation", text: u.text }]);
  assert.deepEqual(H.debt(H.loadJournal(sidA)).map((e) => e.evidence_id), [`d:${u.id}`]);
  const res = await call("ledger_record_update", { record_id: recAttr.id, action: "reject", update_id: u.id, reason: "nobody decided this; it was a suggestion" });
  assert.ok(res.startsWith(`Rejected decision update ${u.id}`), res);
  assert.deepEqual(H.debt(H.loadJournal(sidA)), [], "the rejection settled the prompt in the session it came from");
  ok("rejecting a proposed decision through ledger_record_update settles its d: checkpoint prompt");
}

// ---------- decisions in force: Ledger ids saved inside a record's spans; ledger_refs through MCP ----------
{
  const sidS = "agaaz-claude-saves-1";
  await S.upsertSession(pool, { id: sidS, author: "agaaz", harness: "claude", machine: "agaaz-mac", repo: null, started_at: T(95), last_seen_at: T(97) });
  await S.appendEvents(pool, sidS, [
    ev("s1", "instruction.added", 95, { text: "Record the readout decision" }),
    ev("s2", "tool.finished", 96, { tool: "mcp__ledger__ledger_record_decision", output_preview: JSON.stringify({ receipt: { record_id: dec1.id } }) }, "s-c1"),
    ev("s3", "tool.finished", 97, { tool: "mcp__ledger__ledger_record_decision", output_preview: JSON.stringify({ receipt: { record_id: dec2.id } }) }, "s-c2"),
  ], null, null);
  const started = await call("ledger_record_start", { kind: "other", title: "Readout source decision", link: { session_id: sidS, from_seq: 1, to_seq: 2 }, ledger_refs: ["dec-20260101-nope-zzzz"] });
  const recId = started.match(/^Record ([0-9a-f-]{36})/)![1];
  let p = await buildRecordPack(cfg, pool, recId, { mode: "inspect", author: "agaaz", now: T(130), detail: "evidence" });
  assert.deepEqual(p.ledger_refs.map((r) => [r.id, r.source, r.origin?.seq ?? null, r.status]), [["dec-20260101-nope-zzzz", "explicit", null, null], [dec1.id, "saved", 2, "deprecated"]], "the explicit ref, then the id saved inside the linked span; seq 3 is outside it");
  const pLean = await buildRecordPack(cfg, pool, recId, { mode: "inspect", author: "agaaz", now: T(130) });
  assert.ok(pLean.text.includes(`- [SUPERSEDED by ${dec2.id}, which is in force] decision ${dec1.id} · saved in session ${sidS.slice(0, 8)} seq 2\n`) && pLean.text.includes(`- [NOT FOUND] dec-20260101-nope-zzzz · linked explicitly (ledger_get "dec-20260101-nope-zzzz")`), "lean keeps the status tags and the save origin");
  assert.ok(p.text.includes(`- [SUPERSEDED by ${dec2.id}, which is in force] decision ${dec1.id}: ClickHouse is the source of truth for the September paywall test (agaaz, ${TODAY}) · saved in session ${sidS.slice(0, 8)} seq 2`), p.text);
  assert.ok(p.text.indexOf(`decision ${dec1.id}`) < p.text.indexOf("[NOT FOUND] dec-20260101-nope-zzzz"), "found decisions before missing ids");
  const linked = await call("ledger_record_link", { record_id: recId, session_id: sidS, from_seq: 3, to_seq: 3, ledger_refs: [dec2.id, "dec-20260101-nope-zzzz"] });
  assert.ok(linked.endsWith(`Ledger refs now: dec-20260101-nope-zzzz, ${dec2.id}.`), linked);
  p = await buildRecordPack(cfg, pool, recId, { mode: "inspect", author: "agaaz", now: T(130), detail: "evidence" });
  assert.deepEqual(p.ledger_refs.map((r) => [r.id, r.source, r.status]), [["dec-20260101-nope-zzzz", "explicit", null], [dec2.id, "explicit", "stable"], [dec1.id, "saved", "deprecated"]], "an explicit ref wins over the same id saved in a span");
  assert.ok(p.text.includes(`- [in force] decision ${dec2.id}: `) && p.text.includes("Captured from 2 Ledger save results in 1 session and 2 explicit links."), p.text);
  assert.ok(p.text.includes(`NOT IN FORCE (2): ${dec1.id} → ${dec2.id}; dec-20260101-nope-zzzz.`));
  await pool.query(`delete from cont_records where id = $1`, [recId]);
  ok("decisions in force on a record: ids saved inside linked spans are resolved (superseded flagged with the save event), ids outside the spans are not; ledger_record_start and ledger_record_link add explicit refs, which win over the same saved id");
}

await client.close();
await server.close();
await closePools();
console.log(`selftest-recordpack: ok (${step} checks) — tmp ${tmp}`);
