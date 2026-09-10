import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resume-pack shaping and evidence-query tests. Needs a Postgres:
 * LEDGER_CONTINUITY_DB, default postgresql://localhost:5432/ledger_selftest_resume.
 * Drops and recreates every cont_* table there. No git remote is needed:
 * buildResumePack tolerates a missing repoPath, and checkpoints carry fake
 * wip refs so the bootstrap block renders.
 *
 * Covers: first-3/last-8 instruction shaping with the gap named; the latest
 * compaction summary as a clipped "Session summary" section; files touched in
 * the last hour of the source session; the Sources honesty line; queryEvents
 * filters, ordering, and the truncation trailer; artifact slices by id and
 * sha256; and budget shrinking that keeps honesty, pending ops, and bootstrap.
 *
 * Pass --show to print the first 40 lines of the 40-instruction pack.
 */

const DB = process.env.LEDGER_CONTINUITY_DB || "postgresql://localhost:5432/ledger_selftest_resume";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-resume-"));
process.env.LEDGER_CONFIG_DIR = path.join(tmp, ".ledger");
process.env.LEDGER_GIT_SYNC = "0";

const { getPool, migrate, closePools, tableList } = await import("./continuity/db.js");
const S = await import("./continuity/store.js");
const { buildResumePack, clipSummary, INSTRUCTIONS_HEAD, INSTRUCTIONS_TAIL, RECENT_FILES_MINUTES } = await import("./continuity/resume.js");
const { queryEvents, getArtifact, eventLine, threadSourceCounts } = await import("./continuity/evidence.js");
const { initLedger } = await import("./store.js");
type Config = import("./store.js").Config;
type NormEvent = import("./continuity/events.js").NormEvent;
type EventKind = import("./continuity/events.js").EventKind;

const T = (min: number) => new Date(Date.UTC(2026, 8, 8, 2, min, 0));
let step = 0;
const ok = (msg: string) => console.log(`  ok ${++step}. ${msg}`);
const ev = (id: string, kind: EventKind, min: number, payload: Record<string, unknown>, call_id?: string): NormEvent => ({ producer_event_id: id, kind, occurred_at: T(min).toISOString(), payload, ...(call_id ? { call_id } : {}) });
const REPO = "github.com/tranzmit/demo";

// ---------- setup: ledger dir, fresh schema ----------
const ledgerDir = path.join(tmp, "ledger");
initLedger(ledgerDir, "test");
const cfg: Config = { ledger_dir: ledgerDir, git_sync: false, author: "agaaz", continuity: { database_url: DB, machine: "agaaz-mac" } };
const pool = getPool(cfg);
for (const t of await tableList(pool)) await pool.query(`drop table if exists ${t} cascade`);
await migrate(pool);
ok(`schema reset on ${DB.replace(/\/\/[^@]*@/, "//…@")}`);

/** A session bound to a new thread it claims, its events, and a head checkpoint with a fake verified snapshot. */
async function fixture(name: string, o: { author?: string; harness?: string; lastSeen: Date; events: NormEvent[]; wip?: boolean }) {
  const sid = `sess-${name}`;
  const author = o.author ?? "rachit";
  await S.upsertSession(pool, { id: sid, author, harness: o.harness ?? "claude", machine: "rachit-mac", repo: REPO, branch: "main", started_at: T(0), last_seen_at: o.lastSeen });
  const t = await S.createThread(pool, { repo: REPO, branch: "main", title: `Thread ${name}`, goal: null, created_by: author });
  const c = await S.claimThread(pool, t.id, sid, author);
  assert.ok(c.ok, "fixture claim");
  const gen = c.ok ? c.generation : -1;
  const r = await S.appendEvents(pool, sid, o.events, t.id, gen);
  assert.equal(r.inserted, o.events.length, "all fixture events inserted");
  const cp = await S.publishCheckpoint(pool, { thread_id: t.id, session_id: sid, generation: gen, kind: "snapshot", through_event_seq: r.lastSeq, base_commit: "a".repeat(40), wip_ref: o.wip === false ? null : `refs/wip/${author}/${sid}`, wip_commit: o.wip === false ? null : "b".repeat(40), verified_snapshot_at: o.lastSeen, verified_events_at: o.lastSeen });
  assert.ok(cp.advanced, `fixture checkpoint advanced: ${cp.reason}`);
  const seqRows = await pool.query<{ seq: number; producer_event_id: string }>(`select seq, producer_event_id from cont_events where session_id = $1`, [sid]);
  const seqOf = (id: string) => { const row = seqRows.rows.find((x) => x.producer_event_id === id); assert.ok(row, `seq of ${id}`); return row!.seq; };
  return { t, sid, gen, lastSeq: r.lastSeq, seqOf };
}

// ---------- 1. forty instructions: first 3 + last 8, gap named ----------
const forty = Array.from({ length: 40 }, (_, i) => ev(`i${i + 1}`, "instruction.added", i, { text: `Instruction ${i + 1}: ${"lorem ipsum dolor ".repeat(16)}`.trim() }));
const A = await fixture("forty", { lastSeen: T(40), events: forty });
{
  const pack = await buildResumePack(cfg, pool, A.t.id, { mode: "inspect", author: "agaaz", now: T(60) });
  assert.equal(pack.instructions.length, INSTRUCTIONS_HEAD + INSTRUCTIONS_TAIL);
  assert.deepEqual(pack.instructions.map((i) => i.seq), [1, 2, 3, 33, 34, 35, 36, 37, 38, 39, 40], "first 3 and last 8, in order");
  const fetch = `ledger_events(thread_id: "${A.t.id}", kinds: ["instruction.added"], after_seq: 3)`;
  assert.deepEqual(pack.instructions_omitted, { count: 29, from_seq: 4, to_seq: 32, fetch });
  const line = `… 29 instructions omitted (seq 4..32); ${fetch}`;
  const i3 = pack.text.indexOf("[seq 3 "), io = pack.text.indexOf(line), i33 = pack.text.indexOf("[seq 33 ");
  assert.ok(i3 > 0 && io > i3 && i33 > io, `omitted line sits between seq 3 and seq 33 (${i3}, ${io}, ${i33})`);
  assert.ok(!pack.text.includes("[seq 4 ") && !pack.text.includes("[seq 32 "), "gap instructions not rendered");
  assert.ok(pack.text.includes("Instruction 1:") && pack.text.includes("Instruction 3:") && pack.text.includes("Instruction 33:") && pack.text.includes("Instruction 40:"));
  assert.ok(pack.omitted.some((o) => o.includes("29 instructions omitted (seq 4..32)") && o.includes(fetch)), `omitted names the gap: ${pack.omitted.join(" | ")}`);
  assert.ok(pack.text.includes("## Human instructions (40, in order; first 3 and last 8 shown)"));
  assert.equal(pack.session_summary, null);
  assert.ok(!pack.text.includes("## Session summary"), "no summary section without a compaction event");
  assert.deepEqual(pack.sources, { instructions: 40, assistant_messages: 0, tool_calls: 0, compaction_summaries: 0, sessions: 1 });
  if (process.argv.includes("--show")) console.log(pack.text.split("\n").slice(0, 40).map((l) => `    | ${l}`).join("\n"));
  ok("40 instructions: first 3 + last 8 in order, gap line with seq 4..32 and the ledger_events fetch, mirrored in omitted and JSON");
}

// ---------- artifact first, so a tool.finished event can reference it ----------
const artText = Array.from({ length: 500 }, (_, i) => `line ${String(i + 1).padStart(4, "0")}: ${"x".repeat(40)}\n`).join("");
const AL = artText.length;
assert.equal(AL, 26_000);
const artSha = crypto.createHash("sha256").update(artText).digest("hex");
const art = await S.putArtifact(pool, { sha256: artSha, kind: "tool_output", bytes: Buffer.from(artText, "utf8"), session_id: null });
assert.equal(art.existed, false);

// ---------- thread B: compaction summaries, files, messages, a pending op ----------
const para = "This paragraph summarizes one step of the work, the command that was run, and what was learned from its output.";
const big = Array.from({ length: 560 }, (_, i) => `Paragraph ${i + 1}. ${para}`).join("\n\n");
assert.ok(big.length >= 60_000, `big summary is ${big.length} chars`);
const longMsg = (lead: string) => `${lead} ${"Detail sentence about the pricing work and the layout. ".repeat(18)}`.trim();
const bEvents: NormEvent[] = [
  ev("i1", "instruction.added", 0, { text: "Ship the pricing page; keep the price unchanged." }),
  ev("i2", "instruction.added", 5, { text: "Also add a banner." }),
  ...Array.from({ length: 20 }, (_, i) => ev(`fold${i + 1}`, "file.changed", 6, { path: `src/old/file-${String(i + 1).padStart(2, "0")}.ts`, status: "M" })),
  ev("c0", "compaction", 10, { source: "claude_compact_boundary" }),
  ev("c1", "compaction", 20, { source: "claude_compact_summary", text: "OLD SUMMARY: early state of the work.", chars: 37 }),
  ev("m1", "assistant.message", 30, { text: longMsg("Banner added; now on the pricing page.") }),
  ev("t1", "tool.requested", 40, { tool: "Bash", input: "npm test" }, "call-1"),
  ev("t1f", "tool.finished", 41, { tool: "Bash", output_preview: "1 passing", is_error: false }, "call-1"),
  ev("c2", "compaction", 50, { source: "claude_compact_summary", text: big, chars: big.length }),
  ev("i3", "instruction.added", 60, { text: "Now fix the 360px layout." }),
  ev("m2", "assistant.message", 70, { text: longMsg("Looking at the 360px layout next.") }),
  ev("r1", "tool.requested", 80, { tool: "Read", input: "src/pricing.tsx" }, "call-3"),
  ev("r1f", "tool.finished", 81, { tool: "Read", output_preview: "export const Pricing = () => …", artifact_id: art.id, artifact_sha256: artSha }, "call-3"),
  ev("f1", "file.changed", 110, { path: "src/pricing.tsx", status: "M" }),
  ev("f2", "file.changed", 119, { path: "src/pricing.tsx", status: "M" }),
  ev("f3", "file.changed", 125, { path: "src/pricing.tsx", status: "M" }),
  ev("m3", "assistant.message", 126, { text: longMsg("Third message: build is next.") }),
  ev("t2", "tool.requested", 128, { tool: "Bash", input: "npm run build" }, "call-2"),
];
const B = await fixture("compact", { lastSeen: T(130), events: bEvents });
// a second session (another harness, another author) contributing one instruction to the same thread
await S.upsertSession(pool, { id: "sess-compact-2", author: "agaaz", harness: "codex", machine: "agaaz-mac", repo: REPO, branch: "main", started_at: T(140), last_seen_at: T(150) });
await S.appendEvents(pool, "sess-compact-2", [ev("x1", "instruction.added", 145, { text: "From Codex: also check the footer." })], B.t.id, null);

// ---------- 2. session summary: latest compaction with text, harness named, clipped ----------
const packB = await buildResumePack(cfg, pool, B.t.id, { mode: "inspect", author: "agaaz", now: T(200) });
{
  const ss = packB.session_summary!;
  assert.ok(ss, "session_summary present");
  assert.ok(packB.text.includes("## Session summary (written by Claude Code at compaction; evidence, not memory)"), "section header names the harness");
  assert.equal(ss.source, "claude_compact_summary");
  assert.equal(ss.harness, "Claude Code");
  assert.equal(ss.chars, big.length);
  assert.equal(ss.clipped, true);
  assert.equal(ss.seq, B.seqOf("c2"), "the latest summary with text, not the boundary or the older one");
  assert.ok(ss.text.startsWith("Paragraph 1.") && !ss.text.includes("OLD SUMMARY"), "latest wins");
  assert.ok(ss.text.length <= 7200 && ss.text.length >= 0.6 * 7200, `clipped to ≤ 30% of the 6000-token budget: ${ss.text.length}`);
  assert.ok(ss.text.endsWith("."), "clipped at a paragraph boundary");
  const fetch = `ledger_events(session_id: "${B.sid}", kinds: ["compaction"], after_seq: ${B.seqOf("c2") - 1}, limit: 1, preview_chars: ${big.length})`;
  assert.ok(packB.text.includes(`(clipped at ${ss.text.length.toLocaleString("en-US")} of ${big.length.toLocaleString("en-US")} chars; full text via ${fetch})`), "clip note says how to fetch the full text");
  assert.ok(packB.text.indexOf("## Goal") < packB.text.indexOf("## Session summary") && packB.text.indexOf("## Session summary") < packB.text.indexOf("## Human instructions"), "summary sits after Goal, before instructions");
  // short thread: instructions chronological, nothing omitted
  assert.deepEqual(packB.instructions.map((i) => i.seq), [B.seqOf("i1"), B.seqOf("i2"), B.seqOf("i3"), 1], "3 from the source session then seq 1 of the second session, in insertion order");
  assert.equal(packB.instructions_omitted, null);
  assert.ok(!packB.text.includes("instructions omitted"));
  // codex-authored summary, not clipped
  const E = await fixture("codex", { harness: "codex", lastSeen: T(20), events: [ev("e1", "instruction.added", 0, { text: "Refactor the footer." }), ev("e2", "compaction", 10, { source: "codex_compacted", text: "Codex summary text.", chars: 19 })] });
  const packE = await buildResumePack(cfg, pool, E.t.id, { mode: "inspect", author: "agaaz", now: T(30) });
  assert.ok(packE.text.includes("## Session summary (written by Codex at compaction; evidence, not memory)"));
  assert.deepEqual({ text: packE.session_summary!.text, clipped: packE.session_summary!.clipped, chars: packE.session_summary!.chars }, { text: "Codex summary text.", clipped: false, chars: 19 });
  assert.ok(!packE.text.includes("(clipped"));
  // clipSummary prefers a paragraph boundary, then a line, then a hard cut
  assert.deepEqual(clipSummary("aaaa\n\nbbbb\n\ncccc", 11), { text: "aaaa\n\nbbbb", clipped: true });
  assert.deepEqual(clipSummary("aaaa\nbbbb\ncccc", 11), { text: "aaaa\nbbbb", clipped: true });
  assert.deepEqual(clipSummary("a".repeat(30), 10), { text: "a".repeat(10), clipped: true });
  assert.deepEqual(clipSummary("short", 10), { text: "short", clipped: false });
  ok("session summary: latest compaction with text, harness named (Claude Code / Codex), 60,000 chars clipped at a paragraph with a fetch pointer; absent when no such event");
}

// ---------- 3. recent files: last 60 minutes of the source session ----------
{
  const dEvents: NormEvent[] = [
    ev("d-i1", "instruction.added", 0, { text: "Tidy the models." }),
    ...[5, 6, 7, 8, 9].map((m, i) => ev(`d-old${i}`, "file.changed", m, { path: "src/old.ts" })),
    ev("d-mid", "file.changed", 59, { path: "src/mid.ts" }), // 61 minutes before last_seen: outside the window
    ev("d-r1", "file.changed", 100, { path: "src/recent.ts" }),
    ev("d-r2", "file.changed", 110, { path: "src/recent.ts" }),
    ev("d-r3", "file.changed", 119, { path: "src/also-recent.ts" }),
    ev("d-c0", "compaction", 115, { source: "claude_compact_boundary", text: "" }),
  ];
  const D = await fixture("recent", { lastSeen: T(120), events: dEvents });
  const pack = await buildResumePack(cfg, pool, D.t.id, { mode: "inspect", author: "agaaz", now: T(130) });
  assert.deepEqual(pack.recent_files.map((f) => [f.path, f.count, f.last_at]), [["src/also-recent.ts", 1, T(119).toISOString()], ["src/recent.ts", 2, T(110).toISOString()]], "most recent first, counted within the window");
  assert.ok(!pack.recent_files.some((f) => f.path === "src/mid.ts" || f.path === "src/old.ts"));
  assert.equal(pack.files_touched[0].path, "src/old.ts");
  assert.equal(pack.files_touched[0].count, 5);
  assert.equal(pack.files_touched.length, 4);
  const hdr = `## Files touched in the last ${RECENT_FILES_MINUTES} minutes of the source session (2)`;
  assert.ok(pack.text.includes(hdr) && pack.text.indexOf(hdr) < pack.text.indexOf("## Files touched (4)"), "recent subsection precedes the full list");
  assert.ok(pack.text.includes("- src/also-recent.ts ×1 (03:59)") && pack.text.includes("- src/recent.ts ×2 (03:50)"), "recent lines carry the last-change time");
  assert.equal(pack.session_summary, null, "a compaction event with empty text is not a summary");
  assert.ok(!pack.text.includes("## Session summary"));
  // thread B: the only recent file is also the top of the full list, so the subsection is skipped
  assert.deepEqual(packB.recent_files.map((f) => [f.path, f.count]), [["src/pricing.tsx", 3]]);
  assert.equal(packB.files_touched[0].path, "src/pricing.tsx");
  assert.ok(!packB.text.includes("Files touched in the last"), "subsection skipped when identical to the top of the full list");
  ok("recent files: events within 60 minutes of last_seen_at listed first (most recent first); older only in the full list; subsection skipped when redundant");
}

// ---------- 4. sources line ----------
{
  const want = { instructions: 4, assistant_messages: 3, tool_calls: 3, compaction_summaries: 2, sessions: 2 };
  assert.deepEqual(packB.sources, want);
  assert.deepEqual(await threadSourceCounts(pool, B.t.id), want);
  assert.ok(packB.text.includes("Sources: 4 instructions, 3 assistant messages, 3 tool calls, 2 compaction summaries across 2 sessions."), "honesty block names the sources");
  assert.ok(packB.text.indexOf("## Honesty") < packB.text.indexOf("Sources: 4 instructions") && packB.text.indexOf("Sources: 4 instructions") < packB.text.indexOf("## Goal"));
  ok("sources: instruction/message/tool-call/compaction counts across sessions, computed from the thread's events, in the honesty block and JSON");
}

// ---------- 5. queryEvents ----------
{
  const all = await queryEvents(pool, { session_id: B.sid });
  assert.equal(all.total, bEvents.length);
  assert.equal(all.events.length, bEvents.length);
  assert.equal(all.truncated, false);
  const seqs = all.events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "ordered by seq");
  assert.equal(new Set(seqs).size, seqs.length);
  assert.ok(!all.text.includes("showing "), "no trailer when everything fits");

  const kinds = await queryEvents(pool, { session_id: B.sid, kinds: ["instruction.added"] });
  assert.deepEqual(kinds.events.map((e) => e.seq), [B.seqOf("i1"), B.seqOf("i2"), B.seqOf("i3")]);

  const byPath = await queryEvents(pool, { thread_id: B.t.id, path: "pricing" });
  assert.deepEqual(byPath.events.map((e) => e.producer_event_id), ["r1", "f1", "f2", "f3"], "path matches payload.path and tool input; not the Read result");

  const byQ = await queryEvents(pool, { session_id: B.sid, q: "BANNER" });
  assert.deepEqual(byQ.events.map((e) => e.producer_event_id), ["i2", "m1"], "case-insensitive substring over text");
  const byQOut = await queryEvents(pool, { session_id: B.sid, q: "1 PASSING" });
  assert.deepEqual(byQOut.events.map((e) => e.producer_event_id), ["t1f"], "q also covers output_preview");

  const range = await queryEvents(pool, { session_id: B.sid, after_seq: B.seqOf("c1"), before_seq: B.seqOf("c2") });
  assert.deepEqual(range.events.map((e) => e.producer_event_id), ["m1", "t1", "t1f"]);

  const page1 = await queryEvents(pool, { session_id: B.sid, limit: 3 });
  assert.equal(page1.events.length, 3);
  assert.equal(page1.truncated, true);
  assert.equal(page1.next_after_seq, 3);
  assert.deepEqual(page1.events.map((e) => e.seq), [1, 2, 3]);
  assert.ok(page1.text.endsWith(`showing 3 of ${bEvents.length} matching; next: after_seq=3`), page1.text.split("\n").pop() ?? "");
  const page2 = await queryEvents(pool, { session_id: B.sid, limit: 3, after_seq: page1.next_after_seq! });
  assert.deepEqual(page2.events.map((e) => e.seq), [4, 5, 6], "cursor continues");
  assert.equal((await queryEvents(pool, { session_id: B.sid, limit: 100_000 })).events.length, bEvents.length, "limit capped at 200 still returns everything here");

  // line format
  const l7 = eventLine(all.events.find((e) => e.producer_event_id === "t1f")!);
  assert.equal(l7, `${B.seqOf("t1f")} · 02:41 · tool.finished · Bash: 1 passing`);
  const lr = eventLine(all.events.find((e) => e.producer_event_id === "r1f")!);
  assert.ok(lr.endsWith(` [artifact ${art.id}]`), lr);
  const lc = eventLine(all.events.find((e) => e.producer_event_id === "c2")!);
  assert.ok(lc.startsWith(`${B.seqOf("c2")} · 02:50 · compaction · claude_compact_summary · ${big.length} chars: Paragraph 1.`) && lc.length <= 240, `compaction preview clipped to 200 chars: ${lc.length}`);
  assert.ok(lc.includes("…"));
  const lm = eventLine(all.events.find((e) => e.producer_event_id === "m1")!);
  assert.ok(lm.length <= `${B.seqOf("m1")} · 02:30 · assistant.message · `.length + 200, "preview clipped to 200 chars");
  const lf = eventLine(all.events.find((e) => e.producer_event_id === "f1")!);
  assert.equal(lf, `${B.seqOf("f1")} · 03:50 · file.changed · src/pricing.tsx (M)`);
  const lp = eventLine(all.events.find((e) => e.producer_event_id === "t2")!);
  assert.equal(lp, `${B.seqOf("t2")} · 04:08 · tool.requested · Bash: npm run build`);

  // full text of one event via preview_chars (what the pack's clip note points at)
  const full = await queryEvents(pool, { session_id: B.sid, kinds: ["compaction"], after_seq: B.seqOf("c2") - 1, limit: 1, preview_chars: big.length });
  assert.equal(full.events.length, 1);
  assert.ok(full.text.includes("Paragraph 560.") && full.text.includes("\n\n"), "full summary returned with paragraphs intact");

  // thread-level query spans sessions in insertion order
  const thr = await queryEvents(pool, { thread_id: B.t.id, kinds: ["instruction.added"] });
  assert.deepEqual(thr.events.map((e) => e.producer_event_id), ["i1", "i2", "i3", "x1"]);
  assert.equal(thr.events[3].session_id, "sess-compact-2");

  // errors and empties
  await assert.rejects(queryEvents(pool, {}), /thread_id or session_id is required/);
  await assert.rejects(queryEvents(pool, { thread_id: "not-a-uuid" }), /not a thread id/);
  const none = await queryEvents(pool, { session_id: B.sid, q: "zzz-nothing-matches" });
  assert.equal(none.total, 0);
  assert.match(none.text, /^no events match/);
  ok("queryEvents: kinds, path, q (text and output_preview), after/before seq, limit with trailer and cursor, seq ordering, line format with artifact marker, full text via preview_chars");

  // A rendered session id is a prefix: every surface shortens it to 8 characters, so the shortened
  // form must work. Before this resolved, a prefix matched no rows and read exactly like an empty
  // session, which sent agents to bulk thread reads instead.
  const short = A.sid.slice(0, 8);
  assert.notEqual(short, A.sid, "fixture id is longer than the rendered prefix");
  const byPrefix = await queryEvents(pool, { session_id: short, kinds: ["instruction.added"] });
  const byFull = await queryEvents(pool, { session_id: A.sid, kinds: ["instruction.added"] });
  assert.ok(byFull.events.length > 0, "the fixture session has instruction events");
  assert.deepEqual(byPrefix.events.map((e) => e.producer_event_id), byFull.events.map((e) => e.producer_event_id), "a prefix returns exactly what the full id returns");
  assert.equal(byPrefix.session_id, A.sid, "the resolved id is reported");
  assert.equal(byPrefix.lines[0], `session ${short} is ${A.sid}; pass the full id.`, "the full id is taught on the first line");
  assert.ok(!byFull.lines[0].startsWith("session "), "an exact id adds no resolution line");

  // An unknown id is an error, never an empty result: that conflation was the bug.
  await assert.rejects(queryEvents(pool, { session_id: "01a08bad" }), /unknown session id "01a08bad": no captured session has that id or prefix/);
  // An ambiguous prefix names the candidates instead of silently picking one.
  await assert.rejects(queryEvents(pool, { session_id: B.sid.slice(0, 8) }), /ambiguous session id "sess-com": matches sess-compact, sess-compact-2\. Pass more characters\./);
  // A session that exists but has nothing matching still reports empty, not an error.
  assert.equal((await queryEvents(pool, { session_id: short, q: "zzz-nothing-matches" })).total, 0, "a resolvable id with no matches is still an empty result");
  ok("queryEvents: rendered 8-char session ids resolve, unknown and ambiguous ids throw, genuinely empty stays empty");

  // Record packs print `thread ${short(id)}` beside each session, and thread ids are a real uuid
  // column: an unresolved prefix used to fail the ::uuid cast with an opaque database error.
  const tShort = A.t.id.slice(0, 8);
  const byThreadPrefix = await queryEvents(pool, { thread_id: tShort, kinds: ["instruction.added"] });
  const byThreadFull = await queryEvents(pool, { thread_id: A.t.id, kinds: ["instruction.added"] });
  assert.ok(byThreadFull.events.length > 0, "the fixture thread has instruction events");
  assert.deepEqual(byThreadPrefix.events.map((e) => e.producer_event_id), byThreadFull.events.map((e) => e.producer_event_id), "a thread prefix returns what the full id returns");
  await assert.rejects(queryEvents(pool, { thread_id: "ffffffff" }), /not a thread id: ffffffff \(no thread has that id or prefix\)/);
  // getThread backs ledger_thread_get/note/bind/release; the same rendered prefix must work there.
  assert.equal((await S.getThread(pool, tShort))?.id, A.t.id, "getThread resolves the rendered prefix");
  assert.equal(await S.getThread(pool, "ffffffff"), null, "an unknown thread prefix is still null, not a database error");
  ok("thread ids: rendered 8-char prefixes resolve in queryEvents and getThread; unknown stays a clean miss");
}

// ---------- 6. getArtifact ----------
{
  const s1 = await getArtifact(pool, { id: art.id }, { offset: 0, max_chars: 10_000 });
  assert.equal(s1.found, true);
  assert.equal(s1.body, artText.slice(0, 10_000));
  assert.ok(s1.text.startsWith(`artifact ${art.id} · tool_output · ${AL} bytes · showing [0, 10000)\n`), s1.text.slice(0, 120));
  assert.ok(s1.text.endsWith(`\nnext: offset=10000 (${AL - 10_000} of ${AL} chars remain)`), s1.text.slice(-80));
  assert.equal(s1.next_offset, 10_000);
  const s2 = await getArtifact(pool, { id: art.id }, { offset: s1.next_offset!, max_chars: 10_000 });
  assert.equal(s2.body, artText.slice(10_000, 20_000), "the next offset continues exactly");
  assert.ok(s2.text.startsWith(`artifact ${art.id} · tool_output · ${AL} bytes · showing [10000, 20000)\n`));
  assert.equal(s2.next_offset, 20_000);
  const s3 = await getArtifact(pool, { id: art.id }, { offset: s2.next_offset!, max_chars: 10_000 });
  assert.equal(s3.body, artText.slice(20_000));
  assert.equal(s3.next_offset, null);
  assert.ok(s3.text.includes(`showing [20000, ${AL})`) && s3.text.endsWith(`end of artifact (${AL} chars)`));
  assert.equal(s1.body! + s2.body! + s3.body!, artText, "three slices reassemble the artifact");
  const bySha = await getArtifact(pool, { sha256: artSha.toUpperCase() });
  assert.equal(bySha.id, art.id);
  assert.equal(bySha.body, artText.slice(0, 20_000), "default max_chars is 20,000");
  assert.equal(bySha.next_offset, 20_000);
  const huge = await getArtifact(pool, { id: art.id }, { max_chars: 10_000_000 });
  assert.equal(huge.body, artText, "max_chars capped at 100,000 still covers this artifact");
  const missing = await getArtifact(pool, { id: "00000000-0000-4000-8000-000000000000" });
  assert.equal(missing.found, false);
  assert.equal(missing.text, "artifact not found: 00000000-0000-4000-8000-000000000000");
  const notId = await getArtifact(pool, { id: artSha });
  assert.equal(notId.found, false);
  assert.match(notId.text, /not an artifact id .*looks like a sha256/);
  const missingSha = await getArtifact(pool, { sha256: "e".repeat(64) });
  assert.match(missingSha.text, /^artifact not found: e{64}$/);
  await assert.rejects(getArtifact(pool, {}), /id or sha256 is required/);
  await pool.query(`insert into cont_artifacts (sha256, kind, byte_size, storage_uri, inline) values ($1, 'tool_output', 9000000, 's3://ledger/big-output', null)`, ["f".repeat(64)]);
  const ext = await getArtifact(pool, { sha256: "f".repeat(64) });
  assert.equal(ext.found, true);
  assert.equal(ext.body, null);
  assert.ok(ext.text.includes("showing [0, 0)") && ext.text.includes("stored at s3://ledger/big-output, not inline"), ext.text);
  ok("getArtifact: slices by offset/max_chars with header and next-offset trailer, reassembly, sha256 lookup, clear not-found, storage_uri without inline body");
}

// ---------- 7. budget: honesty, pending, bootstrap survive; assistant messages drop first ----------
{
  const tight = await buildResumePack(cfg, pool, B.t.id, { mode: "inspect", author: "agaaz", now: T(200), budgetTokens: 1500 });
  assert.ok(Math.ceil(packB.text.length / 4) <= 6000 && tight.text.length < packB.text.length, `tight pack is smaller: ${tight.text.length} < ${packB.text.length}`);
  for (const must of ["## Honesty", "Sources: 4 instructions", "## Pending / unknown operations (1)", "npm run build  ← outcome unknown", "## Bootstrap", `git fetch origin refs/wip/rachit/${B.sid}`, "## First turn contract", "## Session summary", "keep the price unchanged"]) {
    assert.ok(tight.text.includes(must), `tight pack keeps: ${must}`);
  }
  assert.ok(packB.text.includes("Looking at the 360px layout next."), "6000-token pack shows the assistant messages");
  assert.ok(!tight.text.includes("Looking at the 360px layout next."), "1500-token pack drops them");
  assert.ok(tight.text.includes(`## Last assistant messages\n(omitted for budget; ledger_events(thread_id: "${B.t.id}", kinds: ["assistant.message"]))`));
  assert.ok(tight.omitted.some((o) => o.startsWith("last assistant messages")), `drop named in omitted: ${tight.omitted.join(" | ")}`);
  assert.ok(tight.text.includes("## Omitted for budget or unavailable") && tight.text.includes("- last assistant messages"), "omitted section in the text names the drop");
  assert.equal(tight.last_messages.length, 3, "JSON keeps the messages");
  assert.ok(tight.session_summary!.text.length <= 1800, `summary share shrinks with the budget: ${tight.session_summary!.text.length}`);
  assert.deepEqual(packB.omitted.filter((o) => o.startsWith("last assistant")), [], "no drop at 6000 tokens");
  ok("budget 1500: honesty, sources, pending ops, bootstrap, contract, and the summary survive; assistant messages dropped first and named in omitted");
}

await closePools();
console.log(`selftest-resume: ok (${step} checks) — tmp ${tmp}`);
