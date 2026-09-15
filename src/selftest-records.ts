import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Work-records tests (spec v1.2, D-009). Needs a Postgres: LEDGER_CONTINUITY_DB,
 * default postgresql://localhost:5432/ledger_selftest. Drops and recreates every
 * cont_* table there. Fixtures go through the real store functions so seqs are
 * assigned the way the helper assigns them.
 *
 * Covers: idempotent migration; record CRUD and listing; spans from two authors
 * linked to one record with overlapping explicit+suggested links; unassigned
 * span detection with an `unassigned` marker that must not count as coverage;
 * append-only state updates (proposed → confirmed / rejected / superseded) with
 * the record's state_version moving only on confirmation; contradictions kept
 * side by side; full-text search with record/repo/session/kind restrictions;
 * evidence ranking by authority tier → recency → similarity with explicit labels,
 * as-of status evaluation, author filter, scope resolution, and reciprocal rank
 * fusion with an injected vector candidate list; as-of record summaries;
 * per-session contribution summary; input validation.
 */

const DB = process.env.LEDGER_CONTINUITY_DB || "postgresql://localhost:5432/ledger_selftest";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-rec-"));
process.env.LEDGER_CONFIG_DIR = path.join(tmp, ".ledger");
process.env.LEDGER_GIT_SYNC = "0";

const { getPool, migrate, closePools, tableList } = await import("./continuity/db.js");
const S = await import("./continuity/store.js");
const R = await import("./continuity/records.js");
const E = await import("./continuity/evidence.js");
type Config = import("./store.js").Config;
type NormEvent = import("./continuity/events.js").NormEvent;

let step = 0;
const ok = (msg: string) => console.log(`  ok ${++step}. ${msg}`);
const T = (min: number) => new Date(Date.UTC(2026, 8, 8, 2, min, 0));
const iso = (min: number) => T(min).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const key = (e: { session_id: string; seq: number }) => `${e.session_id}:${e.seq}`;
const keys = (sid: string, seqs: number[]) => seqs.map((n) => `${sid}:${n}`);

const cfg: Config = { ledger_dir: path.join(tmp, "ledger"), author: "rachit", git_sync: false, continuity: { database_url: DB, machine: "test-mac" } };
const pool = getPool(cfg);

// ---------- 1. schema: idempotent migrate, three new tables, FTS index ----------
await pool.query(`drop table if exists cont_state_updates, cont_record_links, cont_records, cont_notifications, cont_artifacts, cont_claims, cont_checkpoints, cont_events, cont_sessions, cont_threads cascade`);
const NEW = ["cont_records", "cont_record_links", "cont_state_updates"];
const first = await migrate(pool);
for (const t of NEW) assert.ok(first.includes(t), `first migrate creates ${t}: ${first.join(",")}`);
const second = await migrate(pool);
assert.deepEqual(second, [], "second migrate creates nothing");
const tables = await tableList(pool);
for (const t of NEW) assert.ok(tables.includes(t), `tableList has ${t}: ${tables.join(",")}`);
const idx = (await pool.query<{ indexname: string }>(`select indexname from pg_indexes where tablename = 'cont_events'`)).rows.map((r) => r.indexname);
assert.ok(idx.includes("cont_events_fts_idx"), `FTS index present: ${idx.join(",")}`);
ok(`migrate is idempotent; ${NEW.join(", ")} and cont_events_fts_idx exist on ${DB.replace(/\/\/[^@]*@/, "//…@")}`);

// ---------- fixtures: four sessions, two authors, real seqs via appendEvents ----------
const REPO = "github.com/tranzmit/demo";
const SITE = "github.com/tranzmit/site";
const sidR = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee"; // rachit, codex, demo
const sidA = "agaaz-claude-rec-1";                   // agaaz, claude, demo
const sidU = "rachit-codex-email-1";                 // rachit, codex, site
const sidV = "agaaz-claude-ancient";                 // agaaz, claude, demo; events dated 2020

await S.upsertSession(pool, { id: sidR, author: "rachit", harness: "codex", machine: "rachit-mac", repo: REPO, branch: "master", started_at: T(0), last_seen_at: T(10) });
await S.upsertSession(pool, { id: sidA, author: "agaaz", harness: "claude", machine: "agaaz-mac", repo: REPO, branch: "master", started_at: T(60), last_seen_at: T(65) });
await S.upsertSession(pool, { id: sidU, author: "rachit", harness: "codex", machine: "rachit-mac", repo: SITE, branch: "main", started_at: T(100), last_seen_at: T(110) });
await S.upsertSession(pool, { id: sidV, author: "agaaz", harness: "claude", machine: "agaaz-mac", repo: REPO, started_at: new Date("2020-01-01T00:00:00Z"), last_seen_at: new Date("2020-01-01T00:01:00Z") });

const evR: NormEvent[] = [
  { producer_event_id: "r1", kind: "instruction.added", occurred_at: iso(0), payload: { text: "Add a greeting banner to the app; keep the price unchanged." } },
  { producer_event_id: "r2:requested", kind: "tool.requested", call_id: "r2", occurred_at: iso(1), payload: { tool: "exec", input: "npm test" } },
  { producer_event_id: "r2:finished", kind: "tool.finished", call_id: "r2", occurred_at: iso(2), payload: { output_preview: "1 failing: banner visible on small viewport" } },
  { producer_event_id: "r4", kind: "assistant.message", occurred_at: iso(3), payload: { text: "Banner added. Test fails on small viewport; next I will check the CTA at 360px." } },
  { producer_event_id: "r5", kind: "instruction.added", occurred_at: iso(4), payload: { text: "Now investigate why checkout latency spiked yesterday" } },
  { producer_event_id: "r6:requested", kind: "tool.requested", call_id: "r6", occurred_at: iso(5), payload: { tool: "exec", input: "psql -c \"select p95 from checkout_latency where day = '2026-09-07'\"" } },
  { producer_event_id: "r6:finished", kind: "tool.finished", call_id: "r6", occurred_at: iso(6), payload: { output_preview: "p95 | 2140ms" } },
  { producer_event_id: "r8", kind: "assistant.message", occurred_at: iso(7), payload: { text: "Latency spike correlates with the cache flush at 02:00." } },
  { producer_event_id: "r9", kind: "file.changed", occurred_at: iso(8), payload: { path: "src/cache.ts", status: "M" } },
  { producer_event_id: "r10", kind: "compaction", occurred_at: iso(9), payload: { text: "Summary: banner shipped; latency investigation ongoing, cache flush suspected." } },
];
const evA: NormEvent[] = [
  { producer_event_id: "a1", kind: "instruction.added", occurred_at: iso(60), payload: { text: "Continue rachit's latency investigation; test the cache flush hypothesis" } },
  { producer_event_id: "a2:requested", kind: "tool.requested", call_id: "a2", occurred_at: iso(61), payload: { tool: "run_query", input: "select toStartOfHour(ts), quantile(0.95)(latency_ms) from checkout group by 1" } },
  { producer_event_id: "a2:finished", kind: "tool.finished", call_id: "a2", occurred_at: iso(62), payload: { output_preview: "02:00 | 2140\n03:00 | 410" } },
  { producer_event_id: "a4", kind: "assistant.message", occurred_at: iso(63), payload: { text: "The cache flush is not the cause; the spike matches the deploy of release 4.2." } },
];
const evU: NormEvent[] = [
  { producer_event_id: "u1", kind: "instruction.added", occurred_at: iso(100), payload: { text: "Write the launch email draft for the September release" } },
  { producer_event_id: "u2", kind: "assistant.message", occurred_at: iso(101), payload: { text: "Drafting the email now" } },
  { producer_event_id: "u3:requested", kind: "tool.requested", call_id: "u3", occurred_at: iso(102), payload: { tool: "write", input: "docs/launch-email.md" } },
  { producer_event_id: "u4", kind: "instruction.added", occurred_at: iso(103), payload: { text: "Also fix the pricing typo on the site" } },
  { producer_event_id: "u5", kind: "file.changed", occurred_at: iso(104), payload: { path: "pricing.md", status: "M" } },
  { producer_event_id: "u6", kind: "assistant.message", occurred_at: iso(105), payload: { text: "Typo fixed" } },
  { producer_event_id: "u7", kind: "instruction.added", occurred_at: iso(106), payload: { text: "Back to the email: shorten the subject line" } },
  { producer_event_id: "u8:requested", kind: "tool.requested", call_id: "u8", occurred_at: iso(107), payload: { tool: "edit", input: "docs/launch-email.md" } },
  { producer_event_id: "u8:finished", kind: "tool.finished", call_id: "u8", occurred_at: iso(108), payload: { output_preview: "ok" } },
  { producer_event_id: "u10", kind: "assistant.message", occurred_at: iso(109), payload: { text: "Subject line shortened to eight words" } },
];
const evV: NormEvent[] = [
  { producer_event_id: "v1", kind: "instruction.added", occurred_at: "2020-01-01T00:00:30Z", payload: { text: "This ancient prompt predates the ledger" } },
];
for (const [sid, evs] of [[sidR, evR], [sidA, evA], [sidU, evU], [sidV, evV]] as const) {
  const r = await S.appendEvents(pool, sid, evs as NormEvent[], null, null);
  assert.equal(r.inserted, evs.length, `${sid}: inserted`);
  assert.equal(r.lastSeq, evs.length, `${sid}: seqs are 1..n`);
}

// ---------- 2. records: create, get, list with filters and q, update meta ----------
const recBanner = await R.createRecord(pool, { kind: "implementation", title: "Greeting banner", goal: "Add a greeting banner; price unchanged", repo: REPO, created_by: "rachit", ledger_refs: [{ id: "dec-20260907-build-execution-continuity-as-a-local-capture-he-ys7o", version: "1" }] });
const recLatency = await R.createRecord(pool, { kind: "investigation", title: "Checkout latency spike", goal: "Why did checkout p95 spike on 2026-09-07?", repo: REPO, created_by: "rachit" });
const recEmail = await R.createRecord(pool, { kind: "writing", title: "Launch email", repo: null, created_by: "agaaz" });
const recOld = await R.createRecord(pool, { kind: "other", title: "Old archived thing", created_by: "agaaz" });
await R.updateRecordMeta(pool, recOld.id, { status: "archived" });
await pool.query(`update cont_records set updated_at = now() - interval '5 days' where id = $1`, [recOld.id]);
{
  assert.match(recBanner.id, UUID);
  assert.equal(recBanner.status, "open");
  assert.equal(recBanner.state_version, 0);
  assert.equal(recBanner.repo, REPO);
  assert.deepEqual(recBanner.ledger_refs, [{ id: "dec-20260907-build-execution-continuity-as-a-local-capture-he-ys7o", version: "1" }]);
  assert.equal(recEmail.repo, null);
  assert.equal(recEmail.goal, null);
  assert.deepEqual(recEmail.ledger_refs, []);
  const got = (await R.getRecord(pool, recBanner.id))!;
  assert.equal(got.title, "Greeting banner");
  assert.ok(got.created_at instanceof Date && got.updated_at instanceof Date);
  assert.equal(await R.getRecord(pool, randomUUID()), null);
  assert.equal(await R.getRecord(pool, "not-a-uuid"), null);

  const all = await R.listRecords(pool);
  assert.equal(all.length, 4);
  assert.equal(all[3].id, recOld.id, "oldest updated_at last");
  assert.deepEqual((await R.listRecords(pool, { repo: REPO })).map((r) => r.id).sort(), [recBanner.id, recLatency.id].sort());
  assert.deepEqual((await R.listRecords(pool, { repo: null })).map((r) => r.id).sort(), [recEmail.id, recOld.id].sort(), "repo: null = non-code records");
  assert.deepEqual((await R.listRecords(pool, { kind: "investigation" })).map((r) => r.id), [recLatency.id]);
  assert.deepEqual((await R.listRecords(pool, { status: "archived" })).map((r) => r.id), [recOld.id]);
  assert.deepEqual((await R.listRecords(pool, { author: "agaaz" })).map((r) => r.id).sort(), [recEmail.id, recOld.id].sort());
  assert.deepEqual((await R.listRecords(pool, { q: "LATENCY" })).map((r) => r.id), [recLatency.id], "q is case-insensitive on title");
  assert.deepEqual((await R.listRecords(pool, { q: "price unchanged" })).map((r) => r.id), [recBanner.id], "q matches goal");
  assert.equal((await R.listRecords(pool, { q: "%" })).length, 0, "LIKE metacharacters in q are literal");
  assert.equal((await R.listRecords(pool, { sinceHours: 24 })).length, 3, "sinceHours excludes the 5-day-old record");
  assert.equal((await R.listRecords(pool, { limit: 1 })).length, 1);
  assert.equal((await R.listRecords(pool, { repo: REPO, kind: "implementation", author: "rachit", q: "banner" })).length, 1, "filters intersect");

  await R.updateRecordMeta(pool, recBanner.id, { goal: "Add a greeting banner; price unchanged; CTA visible at 360px", ledger_refs: [] });
  const upd = (await R.getRecord(pool, recBanner.id))!;
  assert.equal(upd.goal, "Add a greeting banner; price unchanged; CTA visible at 360px");
  assert.deepEqual(upd.ledger_refs, []);
  assert.ok(upd.updated_at.getTime() >= got.updated_at.getTime());
  assert.equal((await R.listRecords(pool))[0].id, recBanner.id, "meta update moves the record to the top");
  await assert.rejects(R.updateRecordMeta(pool, randomUUID(), { title: "x" }), /record not found/);
  await assert.rejects(R.updateRecordMeta(pool, recBanner.id, { status: "closed" as any }), /invalid record status/);
  ok("createRecord/getRecord/listRecords: repo (incl. null), kind, status, author, sinceHours, q (ILIKE, escaped), limit; updateRecordMeta bumps updated_at");
}

// ---------- 3. links from two sessions to one record; evidence ordered, annotated, de-duplicated ----------
const lb = await R.linkSpan(pool, { record_id: recBanner.id, session_id: sidR, from_seq: 1, to_seq: 4, source: "explicit", created_by: "rachit" });
const ll1 = await R.linkSpan(pool, { record_id: recLatency.id, session_id: sidR, from_seq: 5, to_seq: 10, source: "explicit", created_by: "rachit" });
const ll2 = await R.linkSpan(pool, { record_id: recLatency.id, session_id: sidR, from_seq: 6, to_seq: 8, source: "suggested", confidence: 0.8, note: "classifier overlap with the explicit span", created_by: "classifier" });
const ll3 = await R.linkSpan(pool, { record_id: recLatency.id, session_id: sidA, from_seq: 1, to_seq: 4, source: "suggested", confidence: 0.7, created_by: "classifier" });
{
  assert.match(lb.id, UUID);
  assert.equal(lb.record_id, recBanner.id);
  assert.equal(lb.session_id, sidR);
  assert.equal(lb.from_seq, 1);
  assert.equal(lb.to_seq, 4);
  assert.equal(lb.source, "explicit");
  assert.equal(lb.confidence, null);
  assert.equal(lb.note, null);
  assert.ok(Math.abs((ll2.confidence ?? 0) - 0.8) < 1e-6, `confidence stored: ${ll2.confidence}`);
  assert.equal(ll2.note, "classifier overlap with the explicit span");

  const ev = await R.recordEvidence(pool, recLatency.id);
  assert.deepEqual(ev.map(key), [...keys(sidR, [5, 6, 7, 8, 9, 10]), ...keys(sidA, [1, 2, 3, 4])], "both sessions, ordered by occurred_at then id, each event once");
  for (const e of ev) {
    assert.equal(e.author, e.session_id === sidR ? "rachit" : "agaaz", `author on ${key(e)}`);
    assert.equal(e.harness, e.session_id === sidR ? "codex" : "claude", `harness on ${key(e)}`);
    assert.equal(e.link_source, e.session_id === sidR ? "explicit" : "suggested", `link_source on ${key(e)}: explicit wins over the overlapping suggested span`);
    assert.ok(e.payload && typeof e.payload === "object", "payload carried through");
  }
  const sug = await R.recordEvidence(pool, recLatency.id, { sources: ["suggested"] });
  assert.deepEqual(sug.map(key), [...keys(sidR, [6, 7, 8]), ...keys(sidA, [1, 2, 3, 4])], "sources filter narrows to suggested spans only");
  assert.ok(sug.every((e) => e.link_source === "suggested"));
  assert.deepEqual((await R.recordEvidence(pool, recLatency.id, { kinds: ["instruction.added"] })).map(key), [`${sidR}:5`, `${sidA}:1`], "kinds filter");
  assert.deepEqual((await R.recordEvidence(pool, recLatency.id, { limit: 3 })).map(key), keys(sidR, [5, 6, 7]), "limit keeps the earliest");
  assert.deepEqual((await R.recordEvidence(pool, recLatency.id, { after: T(6) })).map(key), [...keys(sidR, [8, 9, 10]), ...keys(sidA, [1, 2, 3, 4])], "after filter");
  assert.equal((await R.recordEvidence(pool, recBanner.id)).length, 4);
  assert.equal((await R.recordEvidence(pool, randomUUID())).length, 0);
  assert.equal((await R.recordLinks(pool, recLatency.id)).length, 3);
  assert.deepEqual((await R.sessionLinks(pool, sidR)).map((l) => l.id), [lb.id, ll1.id, ll2.id], "session links in seq order");
  assert.ok((await R.getRecord(pool, recLatency.id))!.updated_at.getTime() > recLatency.updated_at.getTime(), "linking bumps the record's updated_at");
  ok("linkSpan from rachit (explicit 5..10, suggested 6..8) and agaaz (suggested 1..4); recordEvidence returns 10 events once each, ordered, annotated; explicit wins on overlap; sources/kinds/limit/after filters");
}

// ---------- 4. unassigned spans: middle span linked, marker does not count ----------
const recTypo = await R.createRecord(pool, { kind: "implementation", title: "Pricing typo", repo: SITE, created_by: "rachit" });
await R.linkSpan(pool, { record_id: recTypo.id, session_id: sidU, from_seq: 4, to_seq: 6, source: "explicit", created_by: "rachit" });
{
  const u0 = await R.unassignedSpans(pool, { session_id: sidU });
  assert.equal(u0.length, 2, `two uncovered spans: ${JSON.stringify(u0)}`);
  assert.equal(u0[0].from_seq, 1);
  assert.equal(u0[0].to_seq, 3);
  assert.equal(u0[0].event_count, 3);
  assert.equal(u0[0].preview, "Write the launch email draft for the September release");
  assert.equal(u0[0].author, "rachit");
  assert.equal(u0[0].harness, "codex");
  assert.equal(u0[0].first_at?.getTime(), T(100).getTime());
  assert.equal(u0[0].last_at?.getTime(), T(102).getTime());
  assert.equal(u0[1].from_seq, 7);
  assert.equal(u0[1].to_seq, 10, "span runs through the trailing assistant message; the tool.finished at 9 is not content and does not split it");
  assert.equal(u0[1].event_count, 3, "content events only: 7, 8, 10");
  assert.equal(u0[1].preview, "Back to the email: shorten the subject line");
  assert.equal(u0[1].first_at?.getTime(), T(106).getTime());
  assert.equal(u0[1].last_at?.getTime(), T(109).getTime());

  const marker = await R.linkSpan(pool, { record_id: recEmail.id, session_id: sidU, from_seq: 1, to_seq: 3, source: "unassigned", created_by: "classifier" });
  const u1 = await R.unassignedSpans(pool, { session_id: sidU });
  assert.deepEqual(u1.map((s) => [s.from_seq, s.to_seq]), [[1, 3], [7, 10]], "an 'unassigned' marker link is not coverage");
  assert.equal(await R.unlinkSpan(pool, marker.id), true);
  assert.equal(await R.unlinkSpan(pool, marker.id), false, "second unlink finds nothing");
  assert.equal(await R.unlinkSpan(pool, "nope"), false);

  await R.linkSpan(pool, { record_id: recEmail.id, session_id: sidU, from_seq: 1, to_seq: 3, source: "explicit", created_by: "agaaz" });
  const u2 = await R.unassignedSpans(pool, { session_id: sidU });
  assert.deepEqual(u2.map((s) => [s.from_seq, s.to_seq]), [[7, 10]], "explicit link on 1..3 removes that span");

  // rachit: R is fully covered (1..4 banner, 5..10 latency); only U's tail remains
  const byRachit = await R.unassignedSpans(pool, { author: "rachit" });
  assert.deepEqual(byRachit.map((s) => [s.session_id, s.from_seq, s.to_seq]), [[sidU, 7, 10]]);
  // agaaz: A is covered by the suggested span; the 2020 session is not
  const byAgaaz = await R.unassignedSpans(pool, { author: "agaaz" });
  assert.deepEqual(byAgaaz.map((s) => [s.session_id, s.from_seq, s.to_seq]), [[sidV, 1, 1]]);
  assert.equal(byAgaaz[0].preview, "This ancient prompt predates the ledger");
  assert.deepEqual(await R.unassignedSpans(pool, { author: "agaaz", sinceHours: 24 * 365 }), [], "sinceHours drops the 2020 events");
  const everything = await R.unassignedSpans(pool);
  assert.deepEqual(everything.map((s) => s.session_id), [sidU, sidV], "most recently active session first");
  assert.equal((await R.unassignedSpans(pool, { limit: 1 })).length, 1);
  await assert.rejects(R.unassignedSpans(pool, { sinceHours: -1 }), /invalid sinceHours/);
  ok("unassignedSpans: exactly [1..3] and [7..10] around a linked middle span with correct previews/counts/times; 'unassigned' marker ignored; explicit link removes a span; author/sinceHours/limit filters");
}

// ---------- 5. state updates: proposed → confirmed / rejected / superseded; state_version ----------
{
  const p1 = await R.addStateUpdate(pool, { record_id: recBanner.id, session_id: sidR, from_seq: 1, to_seq: 4, kind: "progress", text: "Banner added; test fails on small viewport", evidence: [{ session_id: sidR, seq: 4 }], created_by: "rachit" });
  assert.match(p1.id, UUID);
  assert.equal(p1.status, "proposed");
  assert.equal(p1.kind, "progress");
  assert.deepEqual(p1.evidence, [{ session_id: sidR, seq: 4 }]);
  assert.equal(p1.confirmed_by, null);
  assert.equal(p1.confirmed_at, null);
  assert.equal(p1.supersedes, null);
  let st = (await R.recordState(pool, recBanner.id))!;
  assert.deepEqual(st.progress.map((u) => u.id), [p1.id]);
  assert.equal(st.proposed_count, 1);
  assert.equal(st.confirmed_count, 0);
  assert.equal(st.record.state_version, 0, "a proposed update does not bump state_version");
  assert.ok(st.last_update_at && st.last_update_at.getTime() >= p1.created_at.getTime());

  const n1 = await R.addStateUpdate(pool, { record_id: recBanner.id, session_id: sidR, from_seq: 4, to_seq: 4, kind: "next", text: "Check the CTA at 360px", created_by: "rachit" });
  assert.deepEqual(n1.evidence, [], "evidence omitted with a span stays empty, never fabricated");
  st = (await R.recordState(pool, recBanner.id))!;
  assert.equal(st.proposed_count, 2);
  assert.deepEqual(st.next.map((u) => u.id), [n1.id]);

  const c1 = (await R.confirmStateUpdate(pool, p1.id, "agaaz"))!;
  assert.equal(c1.status, "confirmed");
  assert.equal(c1.confirmed_by, "agaaz");
  assert.ok(c1.confirmed_at instanceof Date);
  st = (await R.recordState(pool, recBanner.id))!;
  assert.equal(st.confirmed_count, 1);
  assert.equal(st.proposed_count, 1);
  assert.equal(st.record.state_version, 1, "confirm bumps state_version");
  assert.ok(st.record.updated_at.getTime() >= c1.confirmed_at!.getTime() - 1000, "confirm bumps updated_at");
  const c1b = (await R.confirmStateUpdate(pool, p1.id, "rachit"))!;
  assert.equal(c1b.confirmed_by, "agaaz", "re-confirming is a no-op");
  assert.equal((await R.recordState(pool, recBanner.id))!.record.state_version, 1, "no double bump");
  assert.equal(c1.confirmed_via, null, "no channel given: not recorded, never assumed to be a person");

  // acceptance provenance: an agent's confirmation stays an agent's until a person accepts at the interactive prompt
  const vStart = (await R.getRecord(pool, recBanner.id))!.state_version;
  const pa = await R.addStateUpdate(pool, { record_id: recBanner.id, kind: "note", text: "provenance probe", created_by: "rachit", proposed_session_id: sidR });
  assert.equal(pa.proposed_session_id, sidR);
  const va = (await R.confirmStateUpdate(pool, pa.id, "rachit", { via: "mcp", session_id: sidR }))!;
  assert.deepEqual({ via: va.confirmed_via, sid: va.confirmed_session_id, by: va.confirmed_by }, { via: "mcp", sid: sidR, by: "rachit" });
  const vBefore = (await R.getRecord(pool, recBanner.id))!.state_version;
  assert.equal(vBefore, vStart + 1);
  const again = (await R.confirmStateUpdate(pool, pa.id, "rachit", { via: "cli" }))!;
  assert.equal(again.confirmed_via, "mcp", "a non-interactive re-confirmation does not change the channel");
  const person = (await R.confirmStateUpdate(pool, pa.id, "agaaz", { via: "cli-interactive" }))!;
  assert.deepEqual({ via: person.confirmed_via, by: person.confirmed_by, sid: person.confirmed_session_id }, { via: "cli-interactive", by: "agaaz", sid: null }, "a person's interactive acceptance upgrades the agent's confirmation");
  assert.equal((await R.getRecord(pool, recBanner.id))!.state_version, vBefore + 1, "the upgrade bumps state_version once");
  assert.equal((await R.confirmStateUpdate(pool, pa.id, "rachit", { via: "cli-interactive" }))!.confirmed_by, "agaaz", "a second interactive acceptance is a no-op");
  assert.equal((await R.getRecord(pool, recBanner.id))!.state_version, vBefore + 1);
  assert.equal((await R.getStateUpdate(pool, pa.id))!.id, pa.id);
  assert.equal(await R.getStateUpdate(pool, "not-a-uuid"), null);
  // remove the probe so the checks below see the record as before
  await pool.query(`delete from cont_state_updates where id = $1`, [pa.id]);
  await pool.query(`update cont_records set state_version = $2 where id = $1`, [recBanner.id, vStart]);

  const rj = (await R.rejectStateUpdate(pool, n1.id, "rachit", "already covered by the fix"))!;
  assert.equal(rj.status, "rejected");
  assert.equal((rj as any).reject_reason, "already covered by the fix");
  assert.equal((rj as any).rejected_by, "rachit");
  st = (await R.recordState(pool, recBanner.id))!;
  assert.deepEqual(st.next, [], "rejected updates are excluded");
  assert.equal(st.proposed_count, 0);
  assert.equal(st.record.state_version, 1, "reject does not bump state_version");
  await assert.rejects(R.confirmStateUpdate(pool, n1.id, "agaaz"), /rejected/, "a rejected update cannot be confirmed");
  await assert.rejects(R.rejectStateUpdate(pool, p1.id, "agaaz", "no"), /confirmed/, "a confirmed update cannot be rejected; supersede it");

  const p2 = await R.addStateUpdate(pool, { record_id: recBanner.id, session_id: sidR, from_seq: 1, to_seq: 4, kind: "progress", text: "Banner added; 360px CTA fix landed", created_by: "agaaz", supersedes: p1.id });
  assert.equal(p2.supersedes, p1.id);
  st = (await R.recordState(pool, recBanner.id))!;
  assert.deepEqual(st.progress.map((u) => u.id), [p1.id, p2.id], "proposal remains visible alongside accepted predecessor");
  assert.equal(st.proposed_count, 1);
  assert.equal(st.confirmed_count, 1, "a proposal cannot hide a confirmed update");
  assert.equal(st.record.state_version, 1);
  assert.equal((await pool.query(`select status from cont_state_updates where id = $1`, [p1.id])).rows[0].status, "confirmed", "p1 is kept, not edited");

  const p3 = await R.addStateUpdate(pool, { record_id: recBanner.id, kind: "progress", text: "mistaken refresh", created_by: "agaaz", supersedes: p2.id });
  await R.rejectStateUpdate(pool, p3.id, "rachit", "wrong record");
  st = (await R.recordState(pool, recBanner.id))!;
  assert.deepEqual(st.progress.map((u) => u.id), [p1.id, p2.id], "rejection leaves accepted predecessor and pending proposal visible");

  await R.confirmStateUpdate(pool, p2.id, "rachit");
  st = (await R.recordState(pool, recBanner.id))!;
  assert.equal(st.record.state_version, 2);
  assert.equal(st.confirmed_count, 1);

  const d1 = await R.addStateUpdate(pool, { record_id: recBanner.id, kind: "decision", text: "Keep the banner dismissible", created_by: "rachit", status: "confirmed" });
  assert.equal(d1.status, "confirmed");
  assert.equal(d1.confirmed_by, "rachit");
  assert.ok(d1.confirmed_at instanceof Date);
  st = (await R.recordState(pool, recBanner.id))!;
  assert.equal(st.record.state_version, 3, "an update recorded as confirmed bumps state_version once");
  assert.deepEqual(st.decisions.map((u) => u.id), [d1.id]);
  assert.equal(st.confirmed_count, 2);
  await assert.rejects(R.addStateUpdate(pool, { record_id: recLatency.id, kind: "note", text: "x", created_by: "rachit", supersedes: p1.id }), /different record/);
  await assert.rejects(R.addStateUpdate(pool, { record_id: recBanner.id, kind: "note", text: "x", created_by: "rachit", supersedes: randomUUID() }), /superseded update not found/);
  ok("state updates: proposed → recordState flags it; confirm bumps state_version (idempotent); reject excludes without bump; supersedes hides the old one unless the superseder is rejected; confirmed-at-creation bumps once");
}

// ---------- 5b. functions accept a PoolClient; rollback leaves nothing ----------
{
  const c = await pool.connect();
  try {
    await c.query("begin");
    const n = await R.addStateUpdate(c, { record_id: recBanner.id, kind: "note", text: "inside a transaction", created_by: "rachit" });
    const inside = (await R.recordState(c, recBanner.id))!;
    assert.ok(inside.notes.some((x) => x.id === n.id));
    await c.query("rollback");
  } finally {
    c.release();
  }
  const outside = (await R.recordState(pool, recBanner.id))!;
  assert.equal(outside.notes.length, 0);
  assert.equal(outside.record.state_version, 3);
  ok("records functions accept a PoolClient; a rolled-back transaction leaves no update behind");
}

// ---------- 6. contradictions: two hypotheses from different sessions, both kept ----------
{
  const h1 = await R.addStateUpdate(pool, { record_id: recLatency.id, session_id: sidR, from_seq: 5, to_seq: 8, kind: "hypothesis", text: "The 02:00 cache flush causes the spike", evidence: [{ session_id: sidR, seq: 8 }], created_by: "rachit" });
  const h2 = await R.addStateUpdate(pool, { record_id: recLatency.id, session_id: sidA, from_seq: 1, to_seq: 4, kind: "hypothesis", text: "The release 4.2 deploy causes the spike, not the cache flush", evidence: [{ session_id: sidA, seq: 4 }], created_by: "agaaz" });
  const st = (await R.recordState(pool, recLatency.id))!;
  assert.deepEqual(st.hypotheses.map((u) => u.id), [h1.id, h2.id], "both hypotheses present, in creation order");
  assert.ok(st.hypotheses.every((u) => u.status === "proposed"));
  assert.equal(st.proposed_count, 2);
  assert.equal(st.confirmed_count, 0);
  assert.equal(st.record.state_version, 0);
  const cs = Object.fromEntries(st.contributing_sessions.map((s) => [s.session_id, s]));
  assert.deepEqual(Object.keys(cs).sort(), [sidA, sidR].sort());
  assert.equal(cs[sidR].spans, 2, "two links from rachit's session");
  assert.equal(cs[sidA].spans, 1);
  assert.equal(cs[sidR].author, "rachit");
  assert.equal(cs[sidR].harness, "codex");
  assert.equal(cs[sidA].author, "agaaz");
  assert.equal(cs[sidA].harness, "claude");
  assert.equal(cs[sidA].last_seen_at?.getTime(), T(65).getTime());
  assert.equal(await R.recordState(pool, randomUUID()), null);
  ok("contradictions: rachit's and agaaz's hypotheses sit side by side in recordState; contributing_sessions lists both with span counts");
}

// ---------- 7. full-text search ----------
{
  const s1 = await R.searchEvents(pool, "latency spike");
  const k1 = s1.map(key);
  assert.ok(k1.includes(`${sidR}:5`) && k1.includes(`${sidR}:8`), `instruction and assistant message found: ${k1.join(",")}`);
  assert.ok(s1.every((e) => typeof e.rank === "number" && e.rank > 0), "rank returned");
  assert.ok(s1.every((e) => typeof e.similarity === "number" && e.similarity > 0 && e.sources.includes("lexical")), "similarity and sources returned");
  // ordering is authority tier desc, then recency desc, then similarity desc (2026-09-15; was rank desc)
  const when = (e: { occurred_at: Date | null; received_at: Date }) => new Date(e.occurred_at ?? e.received_at).getTime();
  for (let i = 1; i < s1.length; i++) {
    const [a, b] = [s1[i - 1], s1[i]];
    assert.ok(a.tier > b.tier || (a.tier === b.tier && (when(a) > when(b) || (when(a) === when(b) && a.similarity >= b.similarity))), `ordered by tier, recency, similarity at ${i}: ${key(a)} tier ${a.tier} vs ${key(b)} tier ${b.tier}`);
  }
  // at this point h1 (proposed) cites R:8 and h2 (proposed) cites A:4; R:5 is uncited
  const tiers = Object.fromEntries(s1.map((e) => [key(e), [e.tier, e.label]]));
  assert.deepEqual(tiers[`${sidR}:8`], [2, "PROPOSED"], JSON.stringify(tiers));
  assert.deepEqual(tiers[`${sidR}:5`], [1, "uncited"]);
  assert.equal(s1[0].tier, 2, "cited-by-proposed events lead the uncited ones");
  assert.ok(s1.every((e) => (e.session_id === sidR ? e.author === "rachit" && e.harness === "codex" : e.author === "agaaz" && e.harness === "claude")), "author/harness annotated");
  assert.equal((await R.searchEvents(pool, "latency spike", { record_id: recBanner.id })).length, 0, "record_id restricts to the record's spans");
  const s3 = (await R.searchEvents(pool, "latency spike", { record_id: recLatency.id })).map(key);
  assert.ok(s3.includes(`${sidR}:5`), s3.join(","));
  assert.ok(s3.every((k) => k.startsWith(sidR) || k.startsWith(sidA)));
  assert.equal((await R.searchEvents(pool, "latency spike", { record_id: randomUUID() })).length, 0);
  assert.equal((await R.searchEvents(pool, "email", { repo: REPO })).length, 0, "repo filter");
  const s4 = (await R.searchEvents(pool, "email", { repo: SITE })).map(key);
  assert.ok(s4.includes(`${sidU}:1`) && s4.includes(`${sidU}:7`), s4.join(","));
  assert.deepEqual((await R.searchEvents(pool, "cache flush", { session_id: sidA })).map(key).sort(), keys(sidA, [1, 4]), "session filter");
  assert.deepEqual((await R.searchEvents(pool, "p95", { kinds: ["tool.finished"] })).map(key), [`${sidR}:7`], "output_preview is searchable; kinds filter");
  assert.deepEqual((await R.searchEvents(pool, "p95", { kinds: ["tool.requested"] })).map(key), [`${sidR}:6`], "tool input is searchable");
  assert.equal((await R.searchEvents(pool, "ancient prompt")).length, 1);
  assert.equal((await R.searchEvents(pool, "ancient prompt", { sinceHours: 24 * 365 })).length, 0, "sinceHours filter");
  assert.equal((await R.searchEvents(pool, "latency", { limit: 1 })).length, 1);
  assert.deepEqual(await R.searchEvents(pool, "   "), []);
  assert.deepEqual(await R.searchEvents(pool, "zzqx-nothing-matches"), []);
  ok("searchEvents: finds instructions/messages/inputs/previews by word; ranked by tier → recency → similarity; record_id, repo, session_id, kinds, sinceHours, limit respected");
}

// ---------- 7b. evidence authority: tiers, labels, as-of, author, scope, fusion ----------
const sidT = "rachit-codex-tokenbucket";
await S.upsertSession(pool, { id: sidT, author: "rachit", harness: "codex", machine: "rachit-mac", repo: REPO, branch: "master", started_at: T(199), last_seen_at: T(210) });
const evT: NormEvent[] = [
  { producer_event_id: "t1", kind: "assistant.message", occurred_at: iso(200), payload: { text: "We chose the token bucket over a sliding window" } },              // cited by a confirmed update
  { producer_event_id: "t2", kind: "instruction.added", occurred_at: iso(205), payload: { text: "token bucket token bucket token bucket token bucket refill" } },     // lexically strongest, uncited, newer
  { producer_event_id: "t3", kind: "assistant.message", occurred_at: iso(201), payload: { text: "token bucket capacity is 100" } },                                    // cited by an update later superseded
  { producer_event_id: "t4", kind: "assistant.message", occurred_at: iso(202), payload: { text: "token bucket capacity raised to 250" } },                             // cited by the superseder
  { producer_event_id: "t5", kind: "assistant.message", occurred_at: iso(203), payload: { text: "token bucket should be replaced by a leaky bucket" } },              // cited by a rejected update
  { producer_event_id: "t6", kind: "assistant.message", occurred_at: iso(204), payload: { text: "token bucket burst of 20 tokens" } },                                // cited by a proposed update
  { producer_event_id: "t7:requested", kind: "tool.requested", call_id: "t7", occurred_at: iso(206), payload: { tool: "mcp__ledger__ledger_record_decision", input: "{\"title\":\"token bucket\"}" } },
  { producer_event_id: "t7:finished", kind: "tool.finished", call_id: "t7", occurred_at: iso(207), payload: { output_preview: "Recorded decision dec-20260908-token-bucket-ab12 — token bucket" } }, // seq 8; tool name only on the request (Codex shape)
  { producer_event_id: "t9:requested", kind: "tool.requested", call_id: "t9", occurred_at: iso(208), payload: { tool: "ledger_record_finding", input: "token bucket finding" } },      // seq 9
  { producer_event_id: "t9:finished", kind: "tool.finished", call_id: "t9", occurred_at: iso(209), payload: { tool: "ledger_record_finding", is_error: true, output_preview: "token bucket finding rejected: assumptions missing" } }, // seq 10
  { producer_event_id: "t11", kind: "assistant.message", occurred_at: iso(199), payload: { text: "limiter throttling note with no lexical overlap" } },              // seq 11; reachable only through the vector list
];
// seq 7 (the ledger_record_decision request) matches through its input and is a plain tier-1 event
{
  const r = await S.appendEvents(pool, sidT, evT, null, null);
  assert.equal(r.inserted, evT.length);
}
const recT = await R.createRecord(pool, { kind: "implementation", title: "Rate limiter", repo: REPO, created_by: "rachit" });
await R.linkSpan(pool, { record_id: recT.id, session_id: sidT, from_seq: 1, to_seq: 11, source: "explicit", created_by: "rachit" });
assert.equal((await pool.query<{ n: number }>(`select count(*)::int as n from cont_events where session_id = $1`, [sidT])).rows[0].n, 11);
const uC = await R.addStateUpdate(pool, { record_id: recT.id, kind: "decision", text: "token bucket chosen", evidence: [{ session_id: sidT, seq: 1 }], created_by: "rachit", status: "confirmed" });
const uOld = await R.addStateUpdate(pool, { record_id: recT.id, kind: "progress", text: "capacity 100", evidence: [{ session_id: sidT, seq: 3 }], created_by: "rachit", status: "confirmed" });
const uNew = await R.addStateUpdate(pool, { record_id: recT.id, kind: "progress", text: "capacity 250", evidence: [{ session_id: sidT, seq: 4 }], created_by: "agaaz", status: "confirmed", supersedes: uOld.id });
const uRej = await R.addStateUpdate(pool, { record_id: recT.id, kind: "hypothesis", text: "leaky bucket instead", evidence: [{ session_id: sidT, seq: 5 }], created_by: "agaaz" });
await R.rejectStateUpdate(pool, uRej.id, "rachit", "decided against");
const uProp = await R.addStateUpdate(pool, { record_id: recT.id, kind: "next", text: "tune the burst", evidence: [{ session_id: sidT, seq: 6 }], created_by: "agaaz" });
// deliberate timeline: everything created 3h ago; uC and uNew confirmed and uRej rejected 1h ago; uOld confirmed at creation
await pool.query(`update cont_records set created_at = now() - interval '4 hours' where id = $1`, [recT.id]);
await pool.query(`update cont_state_updates set created_at = now() - interval '3 hours' where record_id = $1`, [recT.id]);
await pool.query(`update cont_state_updates set confirmed_at = now() - interval '1 hour' where id = any($1::uuid[])`, [[uC.id, uNew.id]]);
await pool.query(`update cont_state_updates set confirmed_at = now() - interval '3 hours' where id = $1`, [uOld.id]);
await pool.query(`update cont_state_updates set rejected_at = now() - interval '1 hour' where id = $1`, [uRej.id]);
const seqOf = (hits: { session_id: string; seq: number }[]) => hits.filter((h) => h.session_id === sidT).map((h) => h.seq);
const byT = (hits: Awaited<ReturnType<typeof R.searchEvents>>) => Object.fromEntries(hits.filter((h) => h.session_id === sidT).map((h) => [h.seq, h]));
{
  const res = await R.searchEvidence(pool, "token bucket", { session_id: sidT, candidates: null });
  assert.equal(res.retrieval, "lexical only");
  assert.equal(res.retrieval_note, "vector list disabled");
  assert.equal(res.as_of, null);
  const h = byT(res.hits);
  // tier 3 newest first (8 ledger write, 4, 1), then tier 2 (6), tier 1 by recency (10, 9, 7, 2), tier 0 (5, 3)
  assert.deepEqual(seqOf(res.hits), [8, 4, 1, 6, 10, 9, 7, 2, 5, 3], `authority → recency → similarity: ${seqOf(res.hits).join(",")}`);
  assert.ok(h[2].rank > h[1].rank, `t2 is the lexically stronger match (${h[2].rank} > ${h[1].rank}) yet the confirmed-cited t1 outranks it`);
  assert.ok(h[2].similarity > h[1].similarity, "similarity follows the lexical rank; it never overrides tier");
  assert.deepEqual([h[1].tier, h[1].label], [3, "current"]);
  assert.deepEqual([h[1].citations.length, h[1].citations[0].update_id, h[1].citations[0].status, h[1].citations[0].superseded_by], [1, uC.id, "confirmed", null]);
  assert.deepEqual([h[8].tier, h[8].label, h[8].ledger_write], [3, "current", true], "a successful ledger_record_* result is tier 3 even with the tool name only on the request");
  assert.deepEqual([h[10].tier, h[10].label, h[10].ledger_write], [1, "uncited", false], "a failed ledger write is a plain event");
  assert.deepEqual([h[7].tier, h[7].label, h[7].ledger_write], [1, "uncited", false], "the request of a ledger write is a plain event; only the successful result is authoritative");
  assert.deepEqual([h[4].tier, h[4].label], [3, "current"]);
  assert.deepEqual([h[6].tier, h[6].label], [2, "PROPOSED"]);
  assert.deepEqual([h[2].tier, h[2].label], [1, "uncited"]);
  assert.deepEqual([h[5].tier, h[5].label], [0, "rejected"]);
  assert.deepEqual([h[3].tier, h[3].label], [0, `superseded by ${uNew.id}`]);
  assert.equal(h[3].citations[0].superseded_by, uNew.id);
  assert.ok(!h[11], "seq 11 shares no term with the query and is absent without a vector list");
  // the rendered line carries the label
  const line = E.eventLine(h[3], undefined, { tier: h[3].tier, label: h[3].label });
  assert.ok(line.endsWith(`[tier 0 · superseded by ${uNew.id}]`), line);
  assert.ok(!E.eventLine(h[3]).includes("[tier"), "no suffix without authority");
  ok("evidence tiers: confirmed-cited and ledger writes (3) > proposed-cited (2) > uncited (1) > superseded/rejected (0); recency inside a tier; a weaker confirmed match beats a stronger plain one; labels name the superseder");
}
{
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  const res = await R.searchEvidence(pool, "token bucket", { session_id: sidT, candidates: null, asOf: twoHoursAgo });
  assert.equal(res.as_of, new Date(twoHoursAgo).toISOString());
  const h = byT(res.hits);
  assert.deepEqual([h[1].tier, h[1].label, h[1].citations[0].status], [2, "PROPOSED", "proposed"], "confirmed after as_of counts as proposed");
  assert.deepEqual([h[3].tier, h[3].label, h[3].citations[0].superseded_by], [3, "current", null], "the superseder was confirmed after as_of, so the predecessor is still current");
  assert.deepEqual([h[4].tier, h[4].label], [2, "PROPOSED"], "the superseder itself is only proposed as of then");
  assert.deepEqual([h[5].tier, h[5].label], [2, "PROPOSED"], "rejected after as_of counts as proposed");
  assert.deepEqual([h[8].tier, h[8].label], [3, "current"], "a ledger write is not an update; as_of does not demote it");
  assert.deepEqual(seqOf(res.hits), [8, 3, 6, 5, 4, 1, 10, 9, 7, 2], `as-of ordering: ${seqOf(res.hits).join(",")}`);
  const recent = await R.searchEvidence(pool, "token bucket", { session_id: sidT, candidates: null, asOf: new Date(Date.now() - 30 * 60_000).toISOString() });
  assert.deepEqual(seqOf(recent.hits), [8, 4, 1, 6, 10, 9, 7, 2, 5, 3], "half an hour ago every confirmation had happened");
  const early = await R.searchEvidence(pool, "token bucket", { session_id: sidT, candidates: null, asOf: iso(201) });
  assert.deepEqual(seqOf(early.hits).sort(), [1, 3], "as_of also bounds the events themselves");
  assert.deepEqual(early.hits.map((e) => [e.seq, e.tier, e.label]).sort(), [[1, 1, "uncited"], [3, 1, "uncited"]], "no update existed at that instant (all were created today), so nothing is cited");
  await assert.rejects(R.searchEvidence(pool, "token bucket", { asOf: "not-a-date" }), /invalid asOf/);
  ok("as_of: a confirmation, rejection or supersession after the instant is evaluated as proposed / not yet happened; events after the instant are excluded");
}
{
  assert.equal((await R.searchEvents(pool, "token bucket", { author: "agaaz", candidates: null })).length, 0, "author filter: the session belongs to rachit");
  assert.deepEqual(seqOf(await R.searchEvents(pool, "token bucket", { author: "rachit", candidates: null })), [8, 4, 1, 6, 10, 9, 7, 2, 5, 3]);
  assert.equal((await R.searchEvents(pool, "token bucket", { repo: SITE, candidates: null })).length, 0, "scope repo: another repo sees nothing");
  assert.equal((await R.searchEvents(pool, "token bucket", { repo: REPO, candidates: null })).length, 10, "scope repo: the session's repo sees everything");
  assert.equal((await R.searchEvents(pool, "token bucket", { candidates: null })).length, 10, "scope all");
  // limit applies after the authority ordering (K = 3 × limit lexical candidates are re-ranked, so limit 4 sees all ten)
  assert.deepEqual(seqOf(await R.searchEvents(pool, "token bucket", { session_id: sidT, candidates: null, limit: 4 })), [8, 4, 1, 6], "limit keeps the top of the authority ordering, not the top lexical ranks");
  const two = await R.searchEvents(pool, "token bucket", { session_id: sidT, candidates: null, limit: 2 });
  assert.equal(two.length, 2);
  assert.equal(two[0].seq, 8, "even a tiny candidate pool (K = 6) is ordered by tier first");
  assert.ok(two[0].tier >= two[1].tier);
  // scope resolution: repo whenever cwd is given, all otherwise, never widened silently
  const fns = { repoRoot: (cwd: string) => (cwd.startsWith("/git/") ? cwd : null), repoIdentity: (root: string) => `https://github.com/tranzmit/${root.slice("/git/".length)}` };
  assert.deepEqual(E.resolveSearchScope({ cwd: "/git/demo" }, fns), { scope: "repo", repo: "https://github.com/tranzmit/demo", cwd: "/git/demo", error: null });
  assert.deepEqual(E.resolveSearchScope({}, fns), { scope: "all", repo: null, cwd: null, error: null });
  assert.deepEqual(E.resolveSearchScope({ cwd: "/git/demo", scope: "all" }, fns), { scope: "all", repo: null, cwd: "/git/demo", error: null });
  assert.deepEqual(E.resolveSearchScope({ scope: "repo", fallbackCwd: "/git/site" }, fns).repo, "https://github.com/tranzmit/site", "explicit repo scope falls back to the server cwd");
  assert.match(E.resolveSearchScope({ scope: "repo" }, fns).error ?? "", /no cwd/, "explicit repo scope with nothing to resolve is an error");
  assert.match(E.resolveSearchScope({ scope: "repo", fallbackCwd: "/tmp/nogit" }, fns).error ?? "", /not inside a git repo/, "never widened to all");
  assert.match(E.resolveSearchScope({ cwd: "/tmp/nogit" }, fns).error ?? "", /not inside a git repo/, "a cwd outside git is an error, not scope all");
  assert.equal(E.scopeLine(E.resolveSearchScope({ cwd: "/git/demo" }, fns), { retrieval: "lexical only" }), "scope: repo tranzmit/demo · author any · as of now · lexical only");
  assert.equal(E.scopeLine(E.resolveSearchScope({}, fns), { author: "rachit", asOf: "2026-09-08T02:00:00.000Z", retrieval: "lexical + vector" }), "scope: all repos · author rachit · as of 2026-09-08T02:00:00.000Z · lexical + vector");
  ok("author and repo filters; limit applies after authority ordering; resolveSearchScope defaults to repo with cwd, all without, errors instead of widening; scopeLine format");
}
{
  const idOf = async (seq: number) => (await pool.query<{ id: string }>(`select id from cont_events where session_id = $1 and seq = $2`, [sidT, seq])).rows[0].id;
  const [id11, id2, id9] = await Promise.all([idOf(11), idOf(2), idOf(9)]);
  let seen: unknown = null;
  const fake: import("./continuity/records.js").CandidateFn = async (query, filters, k) => { seen = { query, filters, k }; return [{ event_id: id11, score: 0.9 }, { event_id: id2, score: 0.8 }, { event_id: id9, score: 0.7 }]; };
  const res = await R.searchEvidence(pool, "token bucket", { session_id: sidT, candidates: fake, limit: 20 });
  assert.equal(res.retrieval, "lexical + vector");
  assert.equal(res.retrieval_note, null);
  assert.deepEqual(seen, { query: "token bucket", filters: { repo: undefined, record_id: undefined, session_id: sidT, kinds: undefined, sinceHours: undefined, asOf: undefined }, k: 60 }, "the generator gets the query, the filters and K = 3 × limit");
  const h = byT(res.hits);
  assert.ok(h[11], "a vector-only candidate joins the result");
  assert.deepEqual([h[11].sources, h[11].rank, h[11].tier, h[11].label], [["vector"], 0, 1, "uncited"]);
  assert.ok(Math.abs(h[11].similarity - 1 / 61) < 1e-9, `RRF for vector rank 1 only: ${h[11].similarity}`);
  assert.deepEqual(h[2].sources, ["lexical", "vector"]);
  assert.ok(h[2].similarity > h[11].similarity && h[2].similarity > h[10].similarity, "an event on both lists fuses higher than one on a single list");
  assert.deepEqual(h[9].sources, ["lexical", "vector"]);
  assert.deepEqual(seqOf(res.hits), [8, 4, 1, 6, 10, 9, 7, 2, 11, 5, 3], `fusion changes similarity, not tier or recency: the vector top-1 (seq 11, oldest, uncited) lands at the end of tier 1: ${seqOf(res.hits).join(",")}`);
  // a candidate outside the scope is dropped, never shown
  const other = await R.searchEvidence(pool, "token bucket", { repo: SITE, candidates: fake });
  assert.equal(other.hits.length, 0, "vector candidates from another repo do not leak into a repo-scoped search");
  assert.equal(other.retrieval, "lexical only", "nothing survived the scope, so no vector list was used");
  // a failing generator degrades to lexical and says so
  const broken = await R.searchEvidence(pool, "token bucket", { session_id: sidT, candidates: async () => { throw new Error("pgvector missing"); } });
  assert.equal(broken.retrieval, "lexical only");
  assert.match(broken.retrieval_note ?? "", /vector search failed \(pgvector missing\)/);
  assert.deepEqual(seqOf(broken.hits), [8, 4, 1, 6, 10, 9, 7, 2, 5, 3]);
  // an empty list is reported, not hidden
  const none = await R.searchEvidence(pool, "token bucket", { session_id: sidT, candidates: async () => [] });
  assert.equal(none.retrieval, "lexical only");
  assert.match(none.retrieval_note ?? "", /no candidates/);
  // the default generator (dynamic import of ./embeddings.js) never breaks the search
  const dflt = await R.searchEvidence(pool, "token bucket", { session_id: sidT });
  assert.ok(dflt.retrieval === "lexical only" || dflt.retrieval === "lexical + vector", dflt.retrieval);
  assert.ok(dflt.hits.length >= 10, "lexical hits are always present");
  if (dflt.retrieval === "lexical only") assert.ok(dflt.retrieval_note, "lexical-only fallback states why");
  ok("RRF: FTS top-K and an injected vector top-K fuse into similarity; vector-only hits appear with rank 0; scope filters apply to vector rows; a failing or empty generator falls back to lexical with a note");
}
{
  const [row] = await (await import("./continuity/recordpack.js")).listRecordSummaries(pool, { q: "Rate limiter" });
  assert.deepEqual([row.proposed, row.confirmed, row.state_version], [1, 2, 3], "now: uProp proposed; uC and uNew confirmed (uOld superseded)");
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
  const [asOf] = await R.asOfRecordSummaries(pool, [row], twoHoursAgo);
  assert.deepEqual([asOf.proposed, asOf.confirmed, asOf.state_version], [4, 1, 1], "2h ago: uC, uNew, uRej, uProp all proposed; uOld confirmed and not yet superseded; two confirmations still to come");
  assert.equal(asOf.as_of, twoHoursAgo.toISOString());
  assert.deepEqual(await R.asOfRecordSummaries(pool, [row], new Date(Date.now() - 5 * 3600_000)), [], "a record created after as_of is hidden");
  const [nowRow] = await R.asOfRecordSummaries(pool, [row], new Date());
  assert.deepEqual([nowRow.proposed, nowRow.confirmed, nowRow.state_version], [1, 2, 3], "as of now equals the live summary");
  ok("asOfRecordSummaries: counts and state_version re-evaluated as of an instant; records created later disappear");
}

// ---------- 8. records for a session ----------
{
  const rs = await R.recordsForSession(pool, sidR);
  const by = Object.fromEntries(rs.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(by).sort(), [recBanner.id, recLatency.id].sort());
  assert.equal(by[recBanner.id].spans, 1);
  assert.deepEqual(by[recBanner.id].sources, ["explicit"]);
  assert.equal(by[recLatency.id].spans, 2);
  assert.deepEqual(by[recLatency.id].sources, ["explicit", "suggested"]);
  assert.equal(by[recLatency.id].title, "Checkout latency spike");
  assert.deepEqual((await R.recordsForSession(pool, sidA)).map((r) => r.id), [recLatency.id]);
  assert.deepEqual(await R.recordsForSession(pool, "no-such-session"), []);
  ok("recordsForSession: rachit's session contributed to two records with span counts and distinct sources");
}

// ---------- 9. invalid inputs ----------
{
  await assert.rejects(R.linkSpan(pool, { record_id: recBanner.id, session_id: sidR, from_seq: 5, to_seq: 2, source: "explicit", created_by: "rachit" }), /from_seq 5 > to_seq 2/);
  await assert.rejects(R.linkSpan(pool, { record_id: recBanner.id, session_id: sidR, from_seq: -1, to_seq: 2, source: "explicit", created_by: "rachit" }), /from_seq/);
  await assert.rejects(R.linkSpan(pool, { record_id: recBanner.id, session_id: "no-such-session", from_seq: 1, to_seq: 2, source: "explicit", created_by: "rachit" }), /session not found/);
  await assert.rejects(R.linkSpan(pool, { record_id: randomUUID(), session_id: sidR, from_seq: 1, to_seq: 2, source: "explicit", created_by: "rachit" }), /record not found/);
  await assert.rejects(R.linkSpan(pool, { record_id: recBanner.id, session_id: sidR, from_seq: 1, to_seq: 2, source: "guess" as any, created_by: "rachit" }), /invalid link source/);
  await assert.rejects(R.linkSpan(pool, { record_id: recBanner.id, session_id: sidR, from_seq: 1, to_seq: 2, source: "suggested", confidence: 1.5, created_by: "classifier" }), /confidence/);
  await assert.rejects(R.addStateUpdate(pool, { record_id: randomUUID(), kind: "note", text: "x", created_by: "rachit" }), /record not found/);
  await assert.rejects(R.addStateUpdate(pool, { record_id: recBanner.id, kind: "guess" as any, text: "x", created_by: "rachit" }), /invalid update kind/);
  await assert.rejects(R.addStateUpdate(pool, { record_id: recBanner.id, kind: "note", text: "   ", created_by: "rachit" }), /text is required/);
  await assert.rejects(R.addStateUpdate(pool, { record_id: recBanner.id, kind: "note", text: "x", created_by: "rachit", session_id: sidR, from_seq: 3, to_seq: 1 }), /from_seq 3 > to_seq 1/);
  await assert.rejects(R.addStateUpdate(pool, { record_id: recBanner.id, kind: "note", text: "x", created_by: "rachit", session_id: sidR, from_seq: 1 }), /together/);
  await assert.rejects(R.addStateUpdate(pool, { record_id: recBanner.id, kind: "note", text: "x", created_by: "rachit", session_id: "no-such-session" }), /session not found/);
  await assert.rejects(R.addStateUpdate(pool, { record_id: recBanner.id, kind: "note", text: "x", created_by: "rachit", evidence: [{ session_id: sidR, seq: 1.5 }] }), /evidence\[0\]\.seq/);
  await assert.rejects(R.createRecord(pool, { kind: "nope" as any, title: "x", created_by: "rachit" }), /invalid record kind/);
  await assert.rejects(R.createRecord(pool, { kind: "other", title: "   ", created_by: "rachit" }), /title is required/);
  assert.equal(await R.confirmStateUpdate(pool, randomUUID(), "rachit"), null);
  assert.equal(await R.confirmStateUpdate(pool, "not-a-uuid", "rachit"), null);
  assert.equal(await R.rejectStateUpdate(pool, randomUUID(), "rachit", "x"), null);
  const before = (await pool.query<{ n: number }>(`select count(*)::int as n from cont_record_links`)).rows[0].n;
  assert.equal(before, 6, "no invalid link was written");
  ok("invalid inputs: reversed/negative spans, unknown session/record/source/kind, out-of-range confidence, malformed evidence all throw; confirm/reject on a missing id return null");
}

{
  const rec = await R.createRecord(pool,{kind:'investigation',title:'Branch conflict regression',created_by:'agaaz'});
  const a = await R.addStateUpdate(pool,{record_id:rec.id,kind:'decision',text:'original',created_by:'agaaz',status:'confirmed'});
  const b = await R.addStateUpdate(pool,{record_id:rec.id,kind:'decision',text:'left branch',created_by:'agaaz',status:'confirmed',supersedes:a.id});
  const c = await R.addStateUpdate(pool,{record_id:rec.id,kind:'decision',text:'right branch',created_by:'rachit',status:'confirmed',supersedes:a.id});
  const d = await R.addStateUpdate(pool,{record_id:rec.id,kind:'decision',text:'left branch continued',created_by:'agaaz',status:'confirmed',supersedes:b.id});
  const state = (await R.recordState(pool,rec.id))!;
  assert.equal(state.conflicts.length,1);
  assert.deepEqual(new Set(state.conflicts[0].update_ids),new Set([c.id,d.id]));
  await assert.rejects(R.addStateUpdate(pool,{record_id:rec.id,kind:'note',text:'invented evidence',created_by:'agaaz',evidence:[{session_id:sidR,seq:99999}]}),/evidence event not found/);
  ok('advancing one accepted branch cannot erase a conflict; fabricated event references rejected');
}
await closePools();
console.log(`selftest-records: ok (${step} checks) — tmp ${tmp}`);
