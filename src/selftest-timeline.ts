import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./store.js";
import { assertSafeSelftestDatabase, assertSelftestDatabaseMarker } from "./selftest-db-guard.js";
import { closePools, getPool, migrate } from "./continuity/db.js";
import {
  TIMELINE_UNCONFIGURED,
  buildTimeline,
  harnessOf,
  renderTimeline,
  renderTimelineResult,
  shortener,
  timelineResult,
  transcriptRoot,
} from "./continuity/timeline.js";

/**
 * Multiplayer timeline. The database-backed half needs the disposable cluster
 * (node scripts/test-isolated.mjs selftest-timeline); the pure half runs anywhere.
 *
 * Fixture timestamps sit in 2031 on purpose: suites share one isolated database, and a window
 * query must not pick up sessions another suite wrote with a near-now timestamp.
 */

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-timeline-"));
process.env.LEDGER_CONFIG_DIR = path.join(tmp, "config");

// ---------- no-database path ----------

const unconfigured: Config = { author: "timeline-test", ledger_dir: path.join(tmp, "ledger"), git_sync: false };
const off = await timelineResult(unconfigured, { days: 7 });
assert.equal(off.configured, false);
assert.equal(renderTimelineResult(off), TIMELINE_UNCONFIGURED);
assert.equal(renderTimelineResult(off).split("\n").length, 1, "the unconfigured explanation is one line");
const offJson = JSON.parse(renderTimelineResult(off, true));
assert.equal(offJson.configured, false);
assert.equal(offJson.note, TIMELINE_UNCONFIGURED);
assert.ok(/not configured/.test(TIMELINE_UNCONFIGURED));

// ---------- harness labelling, without a database ----------

assert.equal(transcriptRoot("/Users/x/.codex/sessions/2026/09/17/rollout-2026-09-17T19-07-20-abc.jsonl"), "codex");
assert.equal(transcriptRoot("/Users/x/.claude/projects/-Users-x-repo/abc.jsonl"), "claude");
assert.equal(transcriptRoot(null), null);
assert.equal(transcriptRoot("/tmp/elsewhere/abc.jsonl"), null);

const corroborated = harnessOf("claude", "/Users/x/.claude/projects/p/a.jsonl");
assert.equal(corroborated.confidence, "corroborated");
assert.match(corroborated.label, /transcript-corroborated/);

// The demo defect: an MCP-first bind stamped 'claude' on a session whose transcript is a Codex rollout.
const disputed = harnessOf("claude", "/Users/x/.codex/sessions/2026/09/17/rollout-x.jsonl");
assert.equal(disputed.confidence, "disputed");
assert.equal(disputed.stored, "claude", "the stored value is reported, never rewritten");
assert.equal(disputed.transcript_root, "codex");
assert.match(disputed.label, /disputed/);
assert.match(disputed.label, /codex/);

const unverified = harnessOf("claude", null);
assert.equal(unverified.confidence, "unverified");
assert.match(unverified.label, /unverified/);
assert.equal(harnessOf("claude", null, { harness: "claude", verified: true }).confidence, "corroborated");
assert.equal(harnessOf("claude", null, { harness: "codex", verified: true }).confidence, "unverified", "provenance for another harness corroborates nothing");
assert.equal(harnessOf("unknown", null).confidence, "unknown");
assert.equal(harnessOf(null, null).confidence, "unknown");

// UUIDv7 session ids collide in eight characters; an ambiguous handle is worse than a long one.
assert.equal(shortener(["01a0aefd-8540-7000-8000-0000000000a1", "01a0aefd-ceb0-7000-8000-0000000000a2"])("01a0aefd-8540-7000-8000-0000000000a1"), "01a0aefd-854");
assert.equal(shortener(["aaaaaaaa-1111", "bbbbbbbb-2222"])("aaaaaaaa-1111"), "aaaaaaaa");

console.log("ok timeline: no-database path, harness labelling, id disambiguation");

// ---------- database-backed ----------

const url = process.env.LEDGER_CONTINUITY_DB;
if (!url) {
  console.log("skip timeline database suite: run node scripts/test-isolated.mjs selftest-timeline");
  await fs.rm(tmp, { recursive: true, force: true });
  process.exit(0);
}
assertSafeSelftestDatabase(url);
const cfg: Config = { author: "timeline-test", ledger_dir: path.join(tmp, "ledger"), git_sync: false, continuity: { database_url: url, machine: "fixture" } };
const pool = getPool(cfg);
await assertSelftestDatabaseMarker(pool);
await migrate(pool);

const tag = randomUUID().slice(0, 8);
const T = (hhmm: string) => new Date(`2031-04-1${hhmm}`);
// One prefix, two sessions: the Codex id shape the real data collides on.
const ANN = `01b0aefd-8540-7000-8000-${tag}0000a1`;
const ANN_QUIET = `01b0aefd-ceb0-7000-8000-${tag}0000a2`;
const BOB = `01b0af96-075f-7311-93f9-${tag}0000b1`;
const BOB_EMPTY = `01b0afa2-f1a1-7c62-9da2-${tag}0000b2`;

const session = (id: string, author: string, harness: string, transcript: string | null, started: Date, lastSeen: Date, repo: string | null, cwd: string | null, branch: string | null) =>
  pool.query(
    `insert into cont_sessions(id,author,harness,machine,cwd,repo,branch,transcript_path,started_at,last_seen_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, author, harness, `${author}-box`, cwd, repo, branch, transcript, started, lastSeen]
  );

await session(ANN, "tl-ann", "claude", `/Users/ann/.claude/projects/-repo/${ANN}.jsonl`, T("7T13:23:00Z"), T("7T19:17:00Z"), "https://github.com/tl/multiplayer-ai", "/Users/ann/work/multiplayer-ai", "tl/funnel");
await session(ANN_QUIET, "tl-ann", "claude", `/Users/ann/.claude/projects/-repo/${ANN_QUIET}.jsonl`, T("7T15:00:00Z"), T("7T15:10:00Z"), "https://github.com/tl/multiplayer-ai", "/Users/ann/work/multiplayer-ai", "tl/funnel");
// Stored 'claude', but the capture helper filed the transcript under the Codex root.
await session(BOB, "tl-bob", "claude", `/Users/bob/.codex/sessions/2031/04/17/rollout-2031-04-17T19-07-20-${BOB}.jsonl`, T("7T13:37:00Z"), T("7T13:47:00Z"), null, "/Users/bob/Downloads/Tata1MG", null);
// MCP-first bind with nothing captured yet: harness unverified AND zero events.
await session(BOB_EMPTY, "tl-bob", "codex", null, T("7T16:00:00Z"), T("7T16:00:00Z"), null, null, null);

const event = (id: string, seq: number, kind: string, occurred: Date, lagMinutes: number) =>
  pool.query(`insert into cont_events(session_id,seq,producer_event_id,kind,occurred_at,received_at) values($1,$2,$3,$4,$5,$6)`,
    [id, seq, `${id}:${seq}`, kind, occurred, new Date(occurred.getTime() + lagMinutes * 60_000)]);

for (let i = 1; i <= 4; i++) await event(ANN, i, "assistant.message", T(`7T13:${23 + i}:00Z`), 1);
for (let i = 1; i <= 3; i++) await event(ANN_QUIET, i, "tool.requested", T(`7T15:0${i}:00Z`), 0);
// The documented 8-18 minute capture lag, measured rather than asserted.
for (let i = 1; i <= 3; i++) await event(BOB, i, "assistant.message", T(`7T13:4${i}:00Z`), 17);

const shared = (await pool.query<{ id: string }>(
  `insert into cont_records(kind,title,goal,created_by,ledger_refs,touched_repos)
   values('investigation',$1,'Rank the steps by users lost.','tl-ann',$2::jsonb,$3::text[]) returning id`,
  [`Largest drop-off points before the paywall impression (${tag})`,
   JSON.stringify([{ id: `fnd-2031-funnel-${tag}`, version: "a".repeat(64) }, { id: `fnd-2031-gaps-${tag}` }]),
   ["https://github.com/tl/multiplayer-ai"]]
)).rows[0].id;
// A record the classifier merely suggests a second author onto: it must never become shared work.
const suggestedOnly = (await pool.query<{ id: string }>(
  `insert into cont_records(kind,title,created_by) values('implementation',$1,'tl-ann') returning id`,
  [`Classifier-suggested only (${tag})`]
)).rows[0].id;

const bind = (recordId: string, sessionId: string, by: string, at: Date) =>
  pool.query(`insert into cont_session_bindings(session_id,record_id,question,bound_by,bound_at) values($1,$2,$3,$4,$5)`, [sessionId, recordId, "drop-off question", by, at]);
const link = (recordId: string, sessionId: string, source: string, by: string, at: Date, confidence: number | null = null) =>
  pool.query(`insert into cont_record_links(record_id,session_id,from_seq,to_seq,source,confidence,note,created_by,created_at) values($1,$2,1,$3,$4,$5,$6,$7,$8)`,
    [recordId, sessionId, 4, source, confidence, source === "explicit" ? `bound by ${by}` : null, by, at]);

await bind(shared, ANN, "tl-ann", T("7T13:24:00Z"));
await link(shared, ANN, "explicit", "tl-ann", T("7T13:24:00Z"));
await bind(shared, BOB, "tl-bob", T("7T13:38:00Z"));
await link(shared, BOB, "explicit", "tl-bob", T("7T13:38:00Z"));
await link(suggestedOnly, ANN_QUIET, "explicit", "tl-ann", T("7T15:02:00Z"));
// `confidence` is float4; 0.5 and 0.75 survive the round trip exactly, 0.91 does not.
await link(suggestedOnly, BOB, "suggested", "classifier", T("7T13:44:00Z"), 0.5);
await link(suggestedOnly, BOB, "suggested", "classifier", T("7T13:45:00Z"), 0.75);

const now = new Date("2031-04-18T00:00:00Z");
const windowed = await buildTimeline(pool, { author: cfg.author, days: 2, now });

// ---- swimlane ordering: lanes by first activity, sessions within a lane by start ----
const lanes = windowed.lanes.filter((l) => l.author.startsWith("tl-"));
assert.deepEqual(lanes.map((l) => l.author), ["tl-ann", "tl-bob"], "ann's 13:23 session opens the earlier lane");
assert.deepEqual(lanes[0].sessions.map((s) => s.session_id), [ANN, ANN_QUIET]);
assert.deepEqual(lanes[1].sessions.map((s) => s.session_id), [BOB, BOB_EMPTY]);
assert.deepEqual(lanes[0].machines, ["tl-ann-box"]);

// ---- harness labelling on real rows ----
const bobSession = lanes[1].sessions[0];
assert.equal(bobSession.harness.stored, "claude");
assert.equal(bobSession.harness.transcript_root, "codex");
assert.equal(bobSession.harness.confidence, "disputed");
assert.equal(lanes[0].sessions[0].harness.confidence, "corroborated");
assert.equal(lanes[1].sessions[1].harness.confidence, "unverified", "an MCP-first bind's harness is corroborated by nothing");

// ---- empty session ----
const empty = lanes[1].sessions[1];
assert.equal(empty.events, 0);
assert.equal(empty.capture_lag_minutes, null);
assert.equal(empty.first_event_at, null);
assert.deepEqual(empty.binds, [], "a session with no events invents no adjacency");

// ---- measured capture lag ----
assert.deepEqual(bobSession.capture_lag_minutes, { median: 17, max: 17 });
assert.deepEqual(lanes[0].sessions[0].capture_lag_minutes, { median: 1, max: 1 });

// ---- cross-author bind ----
const sharedRow = windowed.shared.find((r) => r.record_id === shared);
assert.ok(sharedRow, "a record two authors bound to is shared work");
assert.deepEqual(sharedRow!.authors, ["tl-ann", "tl-bob"]);
assert.deepEqual(sharedRow!.contributions.map((c) => [c.author, c.source]), [["tl-ann", "binding"], ["tl-bob", "binding"]]);
assert.deepEqual(sharedRow!.pinned_ledger_refs, [`fnd-2031-funnel-${tag}`, `fnd-2031-gaps-${tag}`]);

const pickups = windowed.pickups.filter((p) => p.record_id === shared);
assert.equal(pickups.length, 1);
assert.equal(pickups[0].actor, "tl-bob");
assert.equal(pickups[0].actor_session, BOB);
assert.equal(pickups[0].via, "binding");
assert.equal(pickups[0].gap_minutes, 14, "the two binds are fourteen minutes apart");
assert.deepEqual(pickups[0].after.map((a) => a.author), ["tl-ann"]);
assert.equal(pickups[0].pinned_ledger_refs_on_record, 2);
assert.equal(pickups[0].actor_harness.confidence, "disputed", "a pickup carries the unreliability of the lane it lands in");

// ---- never invent adjacency ----
assert.equal(windowed.shared.some((r) => r.record_id === suggestedOnly), false, "a suggested link does not make two people share work");
assert.equal(windowed.pickups.some((p) => p.record_id === suggestedOnly), false, "the classifier's own output is not a pickup");
const bobSuggested = bobSession.suggested_links.find((l) => l.record_id === suggestedOnly);
assert.ok(bobSuggested, "the suggestion is still shown, labelled");
assert.equal(bobSuggested!.links, 2, "repeat classifier passes collapse per record without hiding the count");
assert.equal(bobSuggested!.max_confidence, 0.75);

// ---- render ----
const text = renderTimeline(windowed);
assert.match(text, /^Multiplayer timeline — 2031-04-16 00:00 to 2031-04-18 00:00 UTC \(2 days\)$/m);
assert.match(text, /stored harness claude, disputed by capture transcript root \(codex\)/);
assert.match(text, /no events captured \(row exists, content does not\)/);
assert.match(text, /unverified \(MCP-first binds write this field/);
assert.match(text, /14m after tl-ann's session/);
assert.match(text, /Proof: cont_session_bindings rows for both sessions on the same record/);
assert.match(text, /2 suggested links →/);
assert.match(text, /classifier output, not decided/);
assert.match(text, /non-repo \(Tata1MG\)/);
assert.equal(/\/Users\/bob\/Downloads/.test(text), false, "a home-directory path never reaches the output");
assert.match(text, /multiplayer-ai@tl\/funnel/);
assert.match(text, /2 pinned ledger refs/);
assert.match(text, /Read this honestly/);
assert.match(text, /1 session carries a harness the capture transcript root contradicts/);
assert.match(text, /1 session has zero captured events/);
assert.match(text, /shows a median arrival delay of 5m or more/);
// Colliding UUIDv7 prefixes widen together.
assert.match(text, new RegExp(`session ${ANN.slice(0, 12)} `));
assert.equal(text.includes(`session ${ANN.slice(0, 8)} `), false);

// Within a lane, a bind and a suggestion read in the order they happened.
const bobBlock = text.slice(text.indexOf(`session ${BOB.slice(0, 12)}`));
assert.ok(bobBlock.indexOf("bound → investigation") < bobBlock.indexOf("2 suggested links"), "13:38 bind precedes the 13:44 suggestion");

// ---- determinism: one clock input, byte-identical output ----
const again = renderTimeline(await buildTimeline(pool, { author: cfg.author, days: 2, now }));
assert.equal(again, text, "the same rows and the same `now` render identical bytes");
assert.equal(JSON.stringify(await buildTimeline(pool, { author: cfg.author, days: 2, now })), JSON.stringify(windowed));
assert.equal(/ ago\b/.test(text), false, "no relative time phrasing: it would differ between runs");

// ---- focused mode: every contributor to one record, window ignored ----
const focused = await buildTimeline(pool, { author: cfg.author, recordId: shared, days: 1, now: new Date("2035-01-01T00:00:00Z") });
assert.deepEqual(focused.lanes.map((l) => l.author), ["tl-ann", "tl-bob"]);
assert.deepEqual(focused.lanes.flatMap((l) => l.sessions.map((s) => s.session_id)), [ANN, BOB]);
assert.equal(focused.counts.pickups, 1, "a window far from the work still shows the record's own story");
assert.equal(focused.scope.kind, "record");
assert.match(renderTimeline(focused), new RegExp(`Multiplayer timeline — record ${shared}`));

await assert.rejects(buildTimeline(pool, { author: cfg.author, recordId: "not-a-uuid" }), /not a record id/);
await assert.rejects(buildTimeline(pool, { author: cfg.author, recordId: randomUUID() }), /record not found/);
await assert.rejects(buildTimeline(pool, { author: cfg.author, investigationId: suggestedOnly }), /not an investigation/);

// ---- truncation is stated, never silent ----
const capped = await buildTimeline(pool, { author: cfg.author, days: 2, now, limit: 2 });
assert.equal(capped.truncated.sessions, true);
assert.equal(capped.counts.sessions, 2);
assert.match(renderTimeline(capped), /Truncated at 2 sessions/);

// ---- an empty view says so rather than rendering an empty frame ----
const nothing = await buildTimeline(pool, { author: cfg.author, days: 1, now: new Date("2032-01-01T00:00:00Z") });
assert.equal(nothing.lanes.length, 0);
assert.match(renderTimeline(nothing), /No captured sessions in this window/);

const json = JSON.parse(renderTimelineResult({ configured: true, timeline: windowed }, true));
assert.equal(json.schema, "ledger-timeline/v1");
assert.equal(json.counts.pickups, windowed.counts.pickups);

console.log(`ok timeline database: swimlane ordering, cross-author bind (${pickups[0].gap_minutes}m gap), disputed/unverified harness, empty session, suggested-not-adjacent, determinism, focus, truncation`);

await closePools();
await fs.rm(tmp, { recursive: true, force: true });
