import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { idfOver as C_idfOver } from "./query.js";
import { execFileSync } from "node:child_process";

/**
 * Classifier tests (spec v1.2 §13a, acceptance 27/30/33). Needs a Postgres:
 * Requires an explicit localhost LEDGER_TEST_DATABASE_URL. Drops and recreates
 * every cont_* table in that disposable test database.
 *
 * The model is a fake: LEDGER_EXTRACTOR_CMD points at a node script that reads
 * the prompt on stdin, saves it for inspection, and prints canned JSON chosen
 * by a marker it finds in the prompt (an instruction text). Covers: three-topic
 * session → existing record, new record, unassigned; invalid output rejected
 * item by item with nothing invalid written; non-JSON and extractor failure →
 * model_ok false, nothing written; idempotent re-runs; proposed updates with
 * evidence, never confirmed; prompt content and size cap; unassigned spans
 * equal to the records API; dry run and the event cap; the daemon guard and
 * the daemon integration at real turn checkpoints.
 */

const DB = process.env.LEDGER_TEST_DATABASE_URL;
if (!DB) throw new Error('set LEDGER_TEST_DATABASE_URL to an explicitly owned disposable localhost test database');
const dbUrl = new URL(DB);
if (!['localhost','127.0.0.1','[::1]'].includes(dbUrl.hostname) || !/selftest|_test(?:_|$)/.test(dbUrl.pathname) || dbUrl.search) throw new Error('classifier selftest requires a disposable localhost test database');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-cls-"));
process.env.LEDGER_CONFIG_DIR = path.join(tmp, ".ledger");
process.env.LEDGER_GIT_SYNC = "0";
delete process.env.LEDGER_CLASSIFY;

const { getPool, migrate, closePools } = await import("./continuity/db.js");
const S = await import("./continuity/store.js");
const R = await import("./continuity/records.js");
const C = await import("./continuity/classify.js");
const { helperOnce, loadState } = await import("./helper/daemon.js");
const { writeSignal } = await import("./helper/signals.js");
const { initLedger, ledgerHome } = await import("./store.js");
type Config = import("./store.js").Config;
type NormEvent = import("./continuity/events.js").NormEvent;

let step = 0;
const ok = (msg: string) => console.log(`  ok ${++step}. ${msg}`);
const T = (min: number) => new Date(Date.UTC(2026, 8, 8, 2, min, 0));
const iso = (min: number) => T(min).toISOString();
const cl = (o: unknown) => JSON.stringify(o);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const spans = (xs: { from_seq: number; to_seq: number }[]) => xs.map((x) => [x.from_seq, x.to_seq]);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();

// ---------- fake model: canned JSON chosen by a marker found in the prompt ----------
const promptOut = path.join(tmp, "last-prompt.txt");
const cannedFile = path.join(tmp, "canned.json");
const fake = path.join(tmp, "fake-classifier.mjs");
fs.writeFileSync(fake, `
import fs from "node:fs";
const prompt = fs.readFileSync(0, "utf8");
fs.writeFileSync(process.env.FAKE_PROMPT_OUT, prompt);
const canned = JSON.parse(fs.readFileSync(process.env.FAKE_CANNED, "utf8"));
for (const c of canned) {
  if (!prompt.includes(c.marker)) continue;
  if (c.exit) process.exit(c.exit);
  if (c.dynamic) {
    // span every event shown: seqs are the leading numbers of lines after the "# Events" header
    const seqs = prompt.slice(prompt.indexOf("# Events")).split("\\n").map((l) => /^(\\d+) · /.exec(l)).filter(Boolean).map((m) => Number(m[1]));
    const state_updates = c.decision ? [{ record_ref: c.dynamic.title, kind: "decision", text: c.decision, evidence_seqs: [Math.min(...seqs)], confidence: 0.8 }] : [];
    const out = { assignments: [{ record_id: null, new_record: c.dynamic, from_seq: Math.min(...seqs), to_seq: Math.max(...seqs), confidence: 0.75, why: "dynamic fixture" }], state_updates, unassigned: [], notes: "dynamic" };
    process.stdout.write(JSON.stringify(out)); process.exit(0);
  }
  process.stdout.write(typeof c.output === "string" ? c.output : JSON.stringify(c.output)); process.exit(0);
}
process.stdout.write(JSON.stringify({ assignments: [], state_updates: [], unassigned: [], notes: "no marker matched" }));
`);
process.env.LEDGER_EXTRACTOR_CMD = `${JSON.stringify(process.execPath)} ${JSON.stringify(fake)}`;
process.env.FAKE_PROMPT_OUT = promptOut;
process.env.FAKE_CANNED = cannedFile;
const setCanned = (entries: unknown[]) => fs.writeFileSync(cannedFile, JSON.stringify(entries));
const lastPrompt = () => (fs.existsSync(promptOut) ? fs.readFileSync(promptOut, "utf8") : null);
const clearPrompt = () => { try { fs.unlinkSync(promptOut); } catch { /* absent */ } };
setCanned([]);

// ---------- setup: ledger dir, config, fresh schema ----------
const ledgerDir = path.join(tmp, "ledger");
initLedger(ledgerDir, "test");
const cfg: Config = { ledger_dir: ledgerDir, author: "rachit", git_sync: false, continuity: { database_url: DB, machine: "rachit-mac" } };
const pool = getPool(cfg);
await pool.query(`drop table if exists cont_state_updates, cont_record_links, cont_records, cont_notifications, cont_artifacts, cont_claims, cont_checkpoints, cont_events, cont_sessions, cont_threads cascade`);
await migrate(pool);
ok(`schema reset on ${DB.replace(/\/\/[^@]*@/, "//…@")}; fake extractor at ${path.basename(fake)}`);

// ---------- fixtures ----------
const REPO = "github.com/tranzmit/demo";
const OTHER = "github.com/tranzmit/site";
const sidA = "cls-rachit-codex-a";
const sidB = "cls-agaaz-claude-b";
const sidC = "cls-rachit-codex-c";
const sidD = "cls-rachit-codex-d";
const sidE = "cls-rachit-codex-e";

await S.upsertSession(pool, { id: sidA, author: "rachit", harness: "codex", machine: "rachit-mac", repo: REPO, branch: "master", started_at: T(0), last_seen_at: T(15) });
await S.upsertSession(pool, { id: sidB, author: "agaaz", harness: "claude", machine: "agaaz-mac", repo: REPO, branch: "master", started_at: T(20), last_seen_at: T(26) });
await S.upsertSession(pool, { id: sidC, author: "rachit", harness: "codex", machine: "rachit-mac", repo: REPO, started_at: T(30), last_seen_at: T(31) });
await S.upsertSession(pool, { id: sidD, author: "rachit", harness: "codex", machine: "rachit-mac", repo: REPO, started_at: T(32), last_seen_at: T(33) });
await S.upsertSession(pool, { id: sidE, author: "rachit", harness: "codex", machine: "rachit-mac", repo: REPO, started_at: T(40), last_seen_at: T(70) });
const threadA = await S.createThread(pool, { repo: REPO, branch: "master", title: "Add a greeting banner to the app", goal: "Add a greeting banner; keep the price unchanged", created_by: "rachit" });
const claimA = await S.claimThread(pool, threadA.id, sidA, "rachit");
assert.ok(claimA.ok);

// session A: three topics. content seqs: 1 2 4 5 | 6 7 | 8 9 11 | 12 13 (3 and 10 are tool results, not content)
const evA: NormEvent[] = [
  { producer_event_id: "a1", kind: "instruction.added", occurred_at: iso(0), payload: { text: "Add a greeting banner to the app; keep the price unchanged." } },
  { producer_event_id: "a2:requested", kind: "tool.requested", call_id: "a2", occurred_at: iso(1), payload: { tool: "apply_patch", input: "*** Update File: src/app.ts\n-export const banner = false;\n+export const banner = true;" } },
  { producer_event_id: "a2:finished", kind: "tool.finished", call_id: "a2", occurred_at: iso(2), payload: { output_preview: "Success. Updated the following files:\nM src/app.ts" } },
  { producer_event_id: "a4", kind: "file.changed", occurred_at: iso(2), payload: { path: "src/app.ts", status: "M" } },
  { producer_event_id: "a5", kind: "assistant.message", occurred_at: iso(3), payload: { text: "Banner added. Test fails on small viewport; next I will check the CTA at 360px." } },
  { producer_event_id: "a6", kind: "instruction.added", occurred_at: iso(4), payload: { text: "Quick one: what is the git command to list remote refs?" } },
  { producer_event_id: "a7", kind: "assistant.message", occurred_at: iso(5), payload: { text: "git ls-remote origin" } },
  { producer_event_id: "a8", kind: "instruction.added", occurred_at: iso(6), payload: { text: "Now investigate why checkout latency spiked yesterday" } },
  { producer_event_id: "a9:requested", kind: "tool.requested", call_id: "a9", occurred_at: iso(7), payload: { tool: "exec", input: "psql -c \"select p95 from checkout_latency where day = '2026-09-07'\"" } },
  { producer_event_id: "a9:finished", kind: "tool.finished", call_id: "a9", occurred_at: iso(8), payload: { output_preview: "p95 | 2140ms" } },
  { producer_event_id: "a11", kind: "assistant.message", occurred_at: iso(9), payload: { text: "Latency spike correlates with the cache flush at 02:00; I think the flush is the cause." } },
  { producer_event_id: "a12:requested", kind: "tool.requested", call_id: "a12", occurred_at: iso(10), payload: { tool: "exec", input: "npm run build" } },
  { producer_event_id: "a13", kind: "compaction", occurred_at: iso(11), payload: { source: "codex_compacted", text: "Summary: banner shipped; latency investigation ongoing, cache flush suspected." } },
];
const evB: NormEvent[] = [
  { producer_event_id: "b1", kind: "instruction.added", occurred_at: iso(20), payload: { text: "Reindex the search cluster and verify the doc counts" } },
  { producer_event_id: "b2:requested", kind: "tool.requested", call_id: "b2", occurred_at: iso(21), payload: { tool: "exec", input: "curl -XPOST localhost:9200/_reindex" } },
  { producer_event_id: "b2:finished", kind: "tool.finished", call_id: "b2", occurred_at: iso(22), payload: { output_preview: "{\"took\": 1200}" } },
  { producer_event_id: "b4", kind: "assistant.message", occurred_at: iso(23), payload: { text: "Reindex started" } },
  { producer_event_id: "b5:requested", kind: "tool.requested", call_id: "b5", occurred_at: iso(24), payload: { tool: "exec", input: "curl localhost:9200/_count" } },
  { producer_event_id: "b6", kind: "assistant.message", occurred_at: iso(25), payload: { text: "Counts match: 1,204 docs" } },
];
const evC: NormEvent[] = [
  { producer_event_id: "c1", kind: "instruction.added", occurred_at: iso(30), payload: { text: "Rewrite the pricing FAQ in plain language" } },
  { producer_event_id: "c2", kind: "assistant.message", occurred_at: iso(31), payload: { text: "Draft ready in docs/faq.md" } },
];
const evD: NormEvent[] = [
  { producer_event_id: "d1", kind: "instruction.added", occurred_at: iso(32), payload: { text: "Run the nightly backup and report the size" } },
  { producer_event_id: "d2", kind: "assistant.message", occurred_at: iso(33), payload: { text: "Backup running" } },
];
const evE: NormEvent[] = [];
for (let i = 1; i <= 30; i++) evE.push({ producer_event_id: `e${i}`, kind: i % 2 ? "instruction.added" : "assistant.message", occurred_at: iso(40 + i), payload: { text: `Polish the onboarding copy, step ${i}` } });
for (const [sid, evs, tid, gen] of [[sidA, evA, threadA.id, 1], [sidB, evB, null, null], [sidC, evC, null, null], [sidD, evD, null, null], [sidE, evE, null, null]] as const) {
  const r = await S.appendEvents(pool, sid, evs as NormEvent[], tid, gen);
  assert.equal(r.inserted, evs.length, `${sid}: inserted`);
}

// records: two candidates for REPO sessions (one on the repo, one non-code), three that must not be candidates
const recBanner = await R.createRecord(pool, { kind: "implementation", title: "Greeting banner", goal: "Add a greeting banner; price unchanged", repo: REPO, created_by: "rachit" });
const recEmail = await R.createRecord(pool, { kind: "writing", title: "Launch email", repo: null, created_by: "agaaz" });
const recSearch = await R.createRecord(pool, { kind: "implementation", title: "Search reindex", goal: "Reindex the search cluster", repo: REPO, created_by: "agaaz" });
const recOther = await R.createRecord(pool, { kind: "implementation", title: "Site pricing typo", repo: OTHER, created_by: "rachit" });
const recOld = await R.createRecord(pool, { kind: "investigation", title: "Stale investigation", repo: REPO, created_by: "rachit" });
const recDone = await R.createRecord(pool, { kind: "implementation", title: "Finished thing", repo: REPO, created_by: "rachit" });
await R.updateRecordMeta(pool, recDone.id, { status: "done" });
await pool.query(`update cont_records set updated_at = now() - interval '20 days' where id = $1`, [recOld.id]);
await R.addStateUpdate(pool, { record_id: recBanner.id, kind: "progress", text: "Banner component scaffolded", created_by: "rachit", status: "confirmed" });
const bannerBefore = (await R.getRecord(pool, recBanner.id))!;
assert.equal(bannerBefore.state_version, 1);
const recordCount = async () => (await pool.query<{ n: number }>(`select count(*)::int as n from cont_records`)).rows[0].n;
const updatesFor = async (sid: string) => (await pool.query<{ n: number }>(`select count(*)::int as n from cont_state_updates where session_id = $1`, [sid])).rows[0].n;
const recordsBefore = await recordCount();
ok("fixtures: five sessions with real seqs, thread claimed by session A, six records (two candidates, three excluded by repo/age/status)");

// ---------- unit: guard ----------
{
  const on = C.classifyAllowed(cfg, { now: 1_000_000, env: {} });
  assert.equal(on.ok, true);
  const env = C.classifyAllowed(cfg, { now: 1_000_000, env: { LEDGER_CLASSIFY: "0" } });
  assert.equal(env.ok, false);
  assert.match((env as any).reason, /LEDGER_CLASSIFY=0/);
  const off = C.classifyAllowed({ ...cfg, continuity: { ...cfg.continuity!, classify: false } as any }, { now: 1_000_000, env: {} });
  assert.equal(off.ok, false);
  assert.match((off as any).reason, /classify is false/);
  const undef = C.classifyAllowed({ ...cfg, continuity: { ...cfg.continuity!, classify: undefined } as any }, { now: 1_000_000, env: {} });
  assert.equal(undef.ok, true, "undefined = enabled");
  const rl = C.classifyAllowed(cfg, { now: 1_000_000, lastClassifyAt: 1_000_000 - 60_000, env: {} });
  assert.equal(rl.ok, false);
  assert.match((rl as any).reason, /rate limited: next run in 60 s/);
  assert.equal(C.classifyAllowed(cfg, { now: 1_000_000, lastClassifyAt: 1_000_000 - 120_000, env: {} }).ok, true, "exactly 120 s later is allowed");
  assert.equal(C.CLASSIFY_MIN_INTERVAL_MS, 120_000);
  ok("guard: LEDGER_CLASSIFY=0 and continuity.classify=false disable; undefined enables; 120 s per-session rate limit");
}

// ---------- unit: tolerant parse ----------
{
  const j = { assignments: [], state_updates: [], unassigned: [], notes: "n" };
  assert.deepEqual(C.parseClassifyOutput(JSON.stringify(j)), j);
  assert.deepEqual(C.parseClassifyOutput("```json\n" + JSON.stringify(j) + "\n```"), j);
  assert.deepEqual(C.parseClassifyOutput("Here you go:\n" + JSON.stringify(j) + "\nDone."), j);
  assert.deepEqual(C.parseClassifyOutput("{}"), { assignments: [], state_updates: [], unassigned: [], notes: "" }, "missing arrays default to empty");
  assert.throws(() => C.parseClassifyOutput("Sorry, no."), /non-JSON/);
  assert.throws(() => C.parseClassifyOutput("[1,2]"), /non-JSON/);
  assert.throws(() => C.parseClassifyOutput('{"assignments": "x"}'), /must be arrays/);
  ok("parse: plain, fenced, prose-wrapped JSON accepted; prose, arrays, wrong shapes rejected");
}

// ---------- (a) three-topic session → existing record, new record, unassigned; (f) proposed updates; (g) prompt; (h) unassigned ----------
const cannedA = {
  assignments: [
    { record_id: recBanner.id, new_record: null, from_seq: 1, to_seq: 5, confidence: 0.95, why: "instruction names the banner; patch and message carry it out" },
    { record_id: null, new_record: { kind: "investigation", title: "Checkout latency spike", goal: "Why did checkout latency spike on 2026-09-07?" }, from_seq: 8, to_seq: 11, confidence: 0.8, why: "instruction opens an investigation no candidate covers" },
  ],
  state_updates: [
    { record_ref: recBanner.id, kind: "progress", text: "Banner added in src/app.ts; test fails on small viewport", evidence_seqs: [5, 4], confidence: 0.9 },
    { record_ref: recBanner.id, kind: "decision", text: "Price stays unchanged", evidence_seqs: [1], confidence: 0.9 },
    { record_ref: "Checkout latency spike", kind: "hypothesis", text: "Spike correlates with the 02:00 cache flush", evidence_seqs: [11], confidence: 0.6 },
  ],
  unassigned: [
    { from_seq: 6, to_seq: 7, reason: "one-off question, not a piece of work" },
    { from_seq: 12, to_seq: 13, reason: "pending build with no result; compaction spans topics" },
  ],
  notes: "three topics: banner, a one-off question, latency investigation",
};
setCanned([{ marker: "Add a greeting banner to the app", output: cannedA }]);
clearPrompt();
const ra = await C.classifySession(cfg, pool, sidA, { now: T(16) });
const promptA = lastPrompt()!;
let recLatency: import("./continuity/records.js").WorkRecord;
let ra2: Awaited<ReturnType<typeof C.classifySession>>;
{
  assert.equal(ra.model_ok, true, ra.error ?? "");
  assert.equal(ra.error, undefined);
  assert.equal(ra.since_seq, 0);
  assert.equal(ra.through_seq, 13);
  assert.equal(ra.events_considered, 11, "content events only: tool results excluded");
  assert.equal(ra.candidates, 4, "banner + search reindex + older open investigation + launch email");
  assert.equal(ra.assignments_applied, 1, "the banner span links; the investigation span is declined");
  assert.equal(ra.records_created, 0, "the classifier never opens an investigation: bind-or-new owns analysis scope");
  assert.equal(ra.investigations_declined, 1);
  assert.equal(ra.updates_proposed, 2, "the hypothesis on the declined investigation has no record to land on");
  assert.equal(ra.rejected.length, 2, ra.rejected.map((r) => r.reason).join("\n"));
  assert.ok(ra.rejected.every((r) => /"Checkout latency spike" was not opened by the classifier/.test(r.reason) && /ledger_investigation_new/.test(r.reason) && /never created from cwd/.test(r.reason)), ra.rejected.map((r) => r.reason).join("\n"));
  assert.deepEqual(spans(ra.unassigned), [[6, 7], [8, 11], [12, 13]], "the declined span is its own unassigned span, not merged into its neighbours");
  assert.equal(ra.unassigned[0].reason, "one-off question, not a piece of work");
  assert.match(ra.unassigned[1].reason ?? "", /"Checkout latency spike" was not opened by the classifier/);
  assert.equal(ra.unassigned[2].reason, "pending build with no result; compaction spans topics");
  assert.ok(ra.notes.some((n) => n.startsWith("model: three topics")), ra.notes.join(" | "));

  let links = await R.sessionLinks(pool, sidA);
  assert.equal(links.length, 1);
  assert.ok(links.every((l) => l.source === "suggested" && l.created_by === "classifier"));
  assert.deepEqual(spans(links), [[1, 5]]);
  assert.equal(links[0].record_id, recBanner.id);
  assert.ok(Math.abs((links[0].confidence ?? 0) - 0.95) < 1e-6);
  assert.equal(links[0].note, "instruction names the banner; patch and message carry it out");
  assert.equal(await recordCount(), recordsBefore, "no record minted because the session sat in a git root");
  assert.deepEqual((await R.listRecords(pool, { kind: "investigation", status: "open" })).map((r) => r.title), ["Stale investigation"], "open investigations unchanged");
  ok("(a) three topics: seq 1..5 → existing Greeting banner; 8..11 declined (an investigation is declared or bound by a session, never minted by the classifier) and unassigned with that reason; 6..7 and 12..13 unassigned with the model's reasons");

  // A person declares the investigation (what ledger_investigation_new does). The repo it is declared from is a
  // touched repo, a capability the work may read; the record's identity is the question and its repo stays null.
  recLatency = await R.createRecord(pool, { kind: "investigation", title: "Checkout latency spike", goal: "Why did checkout latency spike on 2026-09-07?", repo: REPO, created_by: "rachit" });
  assert.equal(recLatency.repo, null, "an investigation never carries a repo identity");
  assert.deepEqual(recLatency.touched_repos, [REPO], "the repo passed at creation is folded into touched_repos");
  assert.equal(await recordCount(), recordsBefore + 1);
  // The same model output over the same window now links 8..11 to the declared investigation by title.
  clearPrompt();
  ra2 = await C.classifySession(cfg, pool, sidA, { now: T(16), sinceSeq: 0 });
  assert.equal(ra2.model_ok, true, ra2.error ?? "");
  assert.equal(ra2.candidates, 5, "the declared investigation is repo-null, so it is a candidate from every scope");
  assert.equal(ra2.assignments_applied, 1);
  assert.equal(ra2.assignments_skipped, 1, "the banner link already exists");
  assert.equal(ra2.records_created, 0);
  assert.equal(ra2.investigations_declined, 0, "a new_record naming an open candidate's title is that candidate");
  assert.equal(ra2.updates_proposed, 1, "the hypothesis lands on the declared investigation");
  assert.equal(ra2.updates_skipped, 2);
  assert.deepEqual(ra2.rejected, []);
  assert.deepEqual(spans(ra2.unassigned), [[6, 7], [12, 13]]);
  links = await R.sessionLinks(pool, sidA);
  assert.equal(links.length, 2);
  assert.ok(links.every((l) => l.source === "suggested" && l.created_by === "classifier"));
  assert.deepEqual(spans(links), [[1, 5], [8, 11]]);
  assert.equal(links[1].record_id, recLatency.id);
  assert.deepEqual((await R.getRecord(pool, recLatency.id))!.touched_repos, [REPO], "linking a session on an already-touched repo adds nothing (idempotent)");
  assert.equal(await recordCount(), recordsBefore + 1);
  ok("(a2) once a session has declared the investigation, the classifier links the same span to it by title and proposes the hypothesis there; touched_repos stays idempotent");

  // (f) proposed, with evidence, never confirmed
  const stB = (await R.recordState(pool, recBanner.id))!;
  assert.equal(stB.record.state_version, 1, "state_version unchanged by proposed updates");
  assert.equal(stB.proposed_count, 2);
  assert.equal(stB.confirmed_count, 1, "the fixture's confirmed update only");
  const prog = stB.progress.find((u) => u.created_by === "classifier")!;
  assert.equal(prog.status, "proposed");
  assert.equal(prog.confirmed_by, null);
  assert.equal(prog.confirmed_at, null);
  assert.equal(prog.session_id, sidA);
  assert.equal(prog.from_seq, 4);
  assert.equal(prog.to_seq, 5);
  assert.deepEqual(prog.evidence, [{ session_id: sidA, seq: 4 }, { session_id: sidA, seq: 5 }], "evidence sorted, exact seqs");
  assert.equal(stB.decisions.length, 1);
  assert.equal(stB.decisions[0].status, "proposed", "a decision-kind update is still only proposed");
  assert.deepEqual(stB.decisions[0].evidence, [{ session_id: sidA, seq: 1 }]);
  const stL = (await R.recordState(pool, recLatency.id))!;
  assert.equal(stL.record.state_version, 0);
  assert.equal(stL.proposed_count, 1);
  assert.equal(stL.confirmed_count, 0);
  assert.equal(stL.hypotheses[0].text, "Spike correlates with the 02:00 cache flush");
  assert.deepEqual(stL.hypotheses[0].evidence, [{ session_id: sidA, seq: 11 }]);
  assert.equal(stL.contributing_sessions.length, 1);
  assert.equal(stL.contributing_sessions[0].session_id, sidA);
  const confirmed = (await pool.query<{ n: number }>(`select count(*)::int as n from cont_state_updates where created_by = 'classifier' and status <> 'proposed'`)).rows[0].n;
  assert.equal(confirmed, 0, "the classifier never confirms");
  ok("(f) three updates land as proposed with exact evidence and min/max span; state_version untouched; nothing confirmed");

  // (h) unassigned spans equal the records API after apply
  const api = await R.unassignedSpans(pool, { session_id: sidA });
  assert.deepEqual(spans(api), spans(ra2.unassigned));
  assert.equal(api[0].preview, "Quick one: what is the git command to list remote refs?");
  ok("(h) result.unassigned equals unassignedSpans() from the records API: [6..7], [12..13]");

  // (g) prompt content and size (the first run's prompt: four candidates, before the investigation was declared)
  const p = promptA;
  assert.ok(p, "prompt captured");
  assert.equal(p.length, ra.prompt_chars);
  assert.ok(p.length < C.PROMPT_CHAR_CAP, `prompt under cap: ${p.length}`);
  assert.ok(p.includes("# What the ledger is") && p.includes("# Object format") && p.includes("# Classify operation"), "purpose, format, classify prompt sections present");
  assert.ok(p.includes("# Candidate records (4)"));
  assert.ok(p.includes(`] ${recBanner.id} · kind: implementation · title: Greeting banner · repo: ${REPO}`), "candidate line has id/kind/title/repo");
  assert.ok(p.includes(`] ${recSearch.id} · kind: implementation · title: Search reindex · repo: ${REPO}`), "open repo record with no links is a candidate");
  assert.ok(p.includes("goal: Add a greeting banner; price unchanged"));
  assert.ok(p.includes("state: CONFIRMED (1 current, 0 omitted from summary): progress: Banner component scaffolded"), "candidate state summary from recordState preserves confirmed status");
  assert.ok(p.includes(`] ${recEmail.id} · kind: writing · title: Launch email · repo: none (non-code work)`));
  assert.ok(p.includes("state: no updates yet"));
  assert.ok(/\[1\] .* · kind: /.test(p) && /\[4\] .* · kind: /.test(p) && !/\[5\] /.test(p), "candidates numbered 1..4");
  for (const r of [recOther, recDone]) assert.ok(!p.includes(r.id), `${r.title} is not a candidate`);
  assert.ok(p.includes(recOld.id), 'old open work is not excluded solely by age');
  assert.ok(p.includes(`Thread: "Add a greeting banner to the app"`), "thread context");
  assert.ok(p.includes(`# Events (session ${sidA}, seq 1..13, 11 shown)`));
  assert.ok(p.includes("1 · instruction.added · Add a greeting banner to the app; keep the price unchanged."));
  assert.ok(p.includes("2 · tool.requested · apply_patch: *** Update File: src/app.ts -export const banner = false; +export const banner = true;"), "tool line: tool + input, newlines collapsed");
  assert.ok(p.includes("4 · file.changed · M src/app.ts"));
  assert.ok(p.includes("9 · tool.requested · exec: psql -c"));
  assert.ok(p.includes("12 · tool.requested · exec: npm run build"));
  assert.ok(p.includes("13 · compaction · Summary: banner shipped;"));
  assert.ok(!/\n3 · tool\.finished/.test(p) && !/\n10 · /.test(p), "tool results are not shown");
  assert.ok(p.includes("Return only JSON"));
  ok(`(g) prompt has purpose/format/classify sections, both candidates with state, thread, 11 numbered events; ${p.length} chars (cap ${C.PROMPT_CHAR_CAP})`);
  console.log(`     prompt size for the three-topic fixture: ${p.length} chars`);

  // progress file
  const prog2 = C.readProgress(sidA)!;
  assert.deepEqual({ last_seq: prog2.last_seq, runs: prog2.runs }, { last_seq: 13, runs: 1 });
  assert.equal(prog2.last_at, T(16).toISOString());
  assert.ok(fs.existsSync(path.join(ledgerHome(), "classify", `${sidA}.json`)), "progress under ~/.ledger/classify/");
  ok("progress file records last_seq 13, runs 1, last_at");
}

// ---------- (d) idempotent re-runs ----------
{
  clearPrompt();
  const r1 = await C.classifySession(cfg, pool, sidA, { now: T(17) });
  assert.equal(r1.model_ok, true);
  assert.equal(r1.since_seq, 13, "default sinceSeq comes from the progress file");
  assert.equal(r1.events_considered, 0);
  assert.equal(r1.prompt_chars, 0);
  assert.equal(lastPrompt(), null, "no model call without new events");
  assert.equal((await R.sessionLinks(pool, sidA)).length, 2);

  const r2 = await C.classifySession(cfg, pool, sidA, { now: T(18), sinceSeq: 0 });
  assert.equal(r2.model_ok, true, r2.error ?? "");
  assert.ok(lastPrompt(), "forced re-run calls the model");
  assert.equal(r2.candidates, 5, "the new record is now a candidate (linked to this session)");
  assert.equal(r2.assignments_applied, 0);
  assert.equal(r2.assignments_skipped, 2, "both exact suggested links already exist");
  assert.equal(r2.records_created, 0, "new_record with an existing candidate's title resolves to it");
  assert.equal(r2.updates_proposed, 0);
  assert.equal(r2.updates_skipped, 3, "same kind+text from this session already proposed");
  assert.deepEqual(r2.rejected, []);
  assert.deepEqual(spans(r2.unassigned), [[6, 7], [12, 13]]);
  assert.equal((await R.sessionLinks(pool, sidA)).length, 2, "zero new links");
  assert.equal(await updatesFor(sidA), 3, "zero new updates");
  assert.equal(await recordCount(), recordsBefore + 1, "zero new records");
  assert.equal(C.readProgress(sidA)!.runs, 3, "(a), (a2) and this forced re-run");
  ok("(d) re-run without new events makes no model call; forced re-run over the same window writes zero links, updates, or records");
}

// ---------- (b) invalid output: each bad item rejected with a reason; only valid items written ----------
{
  const cannedB = {
    assignments: [
      { record_id: recSearch.id, new_record: null, from_seq: 1, to_seq: 2, confidence: 0.9, why: "valid" },
      { record_id: recSearch.id, new_record: null, from_seq: 2, to_seq: 4, confidence: 0.9, why: "overlaps the first" },
      { record_id: randomUUID(), new_record: null, from_seq: 4, to_seq: 4, confidence: 0.9, why: "unknown record" },
      { record_id: null, new_record: { kind: "implementation", title: "Zed" }, from_seq: 5, to_seq: 99, confidence: 0.9, why: "out of range" },
      { record_id: recSearch.id, new_record: null, from_seq: 5, to_seq: 6, confidence: 1.5, why: "bad confidence" },
      { record_id: null, new_record: null, from_seq: 5, to_seq: 6, confidence: 0.5, why: "neither" },
      { record_id: null, new_record: { kind: "bogus", title: "Bad kind" }, from_seq: 5, to_seq: 6, confidence: 0.5, why: "bad kind" },
      { record_id: recSearch.id, new_record: null, from_seq: 6, to_seq: 5, confidence: 0.5, why: "inverted" },
      { record_id: recBanner.id, new_record: null, from_seq: 4, to_seq: 6, confidence: "high", why: "string confidence" },
      "junk",
    ],
    state_updates: [
      { record_ref: recSearch.id, kind: "progress", text: "Reindex started", evidence_seqs: [2, 4], confidence: 0.8 },
      { record_ref: "Zed", kind: "note", text: "x", evidence_seqs: [5], confidence: 0.5 },
      { record_ref: recSearch.id, kind: "wat", text: "x", evidence_seqs: [5], confidence: 0.5 },
      { record_ref: recSearch.id, kind: "note", text: "   ", evidence_seqs: [5], confidence: 0.5 },
      { record_ref: recSearch.id, kind: "note", text: "cites a tool result", evidence_seqs: [3], confidence: 0.5 },
      { record_ref: recSearch.id, kind: "note", text: "no evidence", evidence_seqs: [], confidence: 0.5 },
      { record_ref: recSearch.id, kind: "note", text: "bad confidence", evidence_seqs: [5], confidence: 2 },
    ],
    unassigned: [
      { from_seq: 4, to_seq: 6, reason: "verification not clearly part of the reindex" },
      { from_seq: 7, to_seq: 9, reason: "out of range" },
      42,
    ],
    notes: "mostly broken on purpose",
  };
  setCanned([{ marker: "Reindex the search cluster", output: cannedB }]);
  const rb = await C.classifySession(cfg, pool, sidB, { now: T(27) });
  assert.equal(rb.model_ok, true, rb.error ?? "");
  assert.equal(rb.events_considered, 5);
  assert.equal(rb.candidates, 5, "banner, search, latency, older open work + launch email");
  assert.equal(rb.assignments_applied, 1);
  assert.equal(rb.records_created, 0);
  assert.equal(rb.updates_proposed, 1);
  const reasons = rb.rejected.map((r) => r.reason);
  assert.equal(rb.rejected.length, 17, reasons.join("\n"));
  const expect = [
    /overlaps assignment 1\.\.2/, /is not among the candidates/, /outside the events shown \(1\.\.6\)/, /confidence must be a number in 0\.\.1, got 1\.5/,
    /exactly one of record_id and new_record must be set \(neither given\)/, /new_record\.kind must be one of/, /from_seq 6 > to_seq 5/, /confidence must be a number in 0\.\.1, got high/, /assignment is not an object/,
    /record_ref "Zed" is neither a candidate id nor the title of an accepted new_record/, /kind must be one of .* got wat/, /text is required/, /evidence seq 3 is not one of the events shown/, /evidence_seqs must name at least one/, /confidence must be a number in 0\.\.1, got 2/,
    /outside the events shown/, /unassigned item is not an object/,
  ];
  for (const re of expect) assert.ok(reasons.some((r) => re.test(r)), `expected a rejection matching ${re}: \n${reasons.join("\n")}`);
  assert.ok(rb.rejected.every((r) => r.item !== undefined), "each rejection carries the offending item");
  const links = await R.sessionLinks(pool, sidB);
  assert.deepEqual(spans(links), [[1, 2]]);
  assert.equal(links[0].record_id, recSearch.id);
  assert.equal(await updatesFor(sidB), 1);
  const st = (await R.recordState(pool, recSearch.id))!;
  assert.equal(st.progress[0].text, "Reindex started");
  assert.equal(st.progress[0].status, "proposed");
  assert.equal(await recordCount(), recordsBefore + 1, "no record created for Zed or Bad kind");
  assert.deepEqual(spans(rb.unassigned), [[4, 6]]);
  assert.equal(rb.unassigned[0].reason, "verification not clearly part of the reindex");
  assert.deepEqual(spans(await R.unassignedSpans(pool, { session_id: sidB })), [[4, 6]]);
  ok("(b) invalid output: 17 items rejected with named reasons (overlap, unknown id, out of range, confidence, kind, shape, evidence); the one valid link and update written");
}

// ---------- (c) non-JSON and extractor failure → model_ok false, nothing written ----------
{
  setCanned([{ marker: "Rewrite the pricing FAQ", output: "Sorry, I cannot produce that." }, { marker: "Run the nightly backup", exit: 2 }]);
  const before = await recordCount();
  const rc = await C.classifySession(cfg, pool, sidC, { now: T(34) });
  assert.equal(rc.model_ok, false);
  assert.match(rc.error!, /non-JSON: Sorry, I cannot produce that\./);
  assert.equal(rc.events_considered, 2, "events were loaded and the prompt built");
  assert.ok(rc.prompt_chars > 0);
  assert.equal(rc.assignments_applied + rc.records_created + rc.updates_proposed, 0);
  assert.equal((await R.sessionLinks(pool, sidC)).length, 0);
  assert.equal(await updatesFor(sidC), 0);
  assert.equal(await recordCount(), before);
  assert.equal(C.readProgress(sidC), null, "no progress written on failure");

  const rd = await C.classifySession(cfg, pool, sidD, { now: T(35) });
  assert.equal(rd.model_ok, false);
  assert.match(rd.error!, /classifier failed/);
  assert.equal((await R.sessionLinks(pool, sidD)).length, 0);
  assert.equal(C.readProgress(sidD), null);

  const rx = await C.classifySession(cfg, pool, "no-such-session", { now: T(35) });
  assert.equal(rx.model_ok, false);
  assert.match(rx.error!, /session not found/);
  ok("(c) non-JSON reply and a failing extractor both return model_ok=false with the error; no links, updates, records, or progress written");
}

// ---------- dry run + event cap ----------
{
  setCanned([{ marker: "Polish the onboarding copy", dynamic: { kind: "writing", title: "Onboarding copy", goal: null } }]);
  const before = await recordCount();
  const re = await C.classifySession(cfg, pool, sidE, { now: T(71), maxEvents: 10, dryRun: true });
  assert.equal(re.model_ok, true, re.error ?? "");
  assert.equal(re.dry_run, true);
  assert.equal(re.events_considered, 10);
  assert.equal(re.since_seq, 0);
  assert.equal(re.through_seq, 10);
  assert.ok(re.notes.some((n) => /20 newer event\(s\) deferred to the next page/.test(n)), re.notes.join(" | "));
  assert.equal(re.assignments_applied, 1, "dry run counts what would be linked");
  assert.equal(re.records_created, 1, "dry run counts what would be created");
  assert.deepEqual(re.unassigned, [], "the dynamic fixture covers every event shown");
  assert.equal((await R.sessionLinks(pool, sidE)).length, 0, "dry run writes no links");
  assert.equal(await recordCount(), before, "dry run creates no records");
  assert.equal(C.readProgress(sidE), null, "dry run writes no progress");
  const p = lastPrompt()!;
  assert.ok(p.includes("Note: 20 newer event(s) deferred"), "deferred work reaches the model");
  assert.ok(p.includes("seq 1..10, 10 shown") && !/\n20 · /.test(p));
  ok("dry run: nothing written; oldest unprocessed page retained and later work deferred without advancing past it");
}

// ---------- (e) daemon integration: classify at real turn checkpoints, rate limit, kill switch ----------
{
  const bare = path.join(tmp, "demo.git");
  const repo = path.join(tmp, "work", "demo");
  git(tmp, "init", "--bare", "--quiet", "-b", "master", bare);
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  git(path.dirname(repo), "clone", "--quiet", bare, "demo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "site.ts"), "export const footer = false;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "init");
  git(repo, "push", "--quiet", "origin", "master");

  const roots = { claude: path.join(tmp, "claude-empty"), codex: path.join(tmp, "codex") };
  const day = path.join(roots.codex, "2026", "09", "08");
  fs.mkdirSync(roots.claude, { recursive: true });
  fs.mkdirSync(day, { recursive: true });
  const sid = "0199cccc-dddd-7eee-8fff-000000000001";
  const tf = path.join(day, `rollout-2026-09-08T03-00-00-${sid}.jsonl`);
  const lines = [
    cl({ timestamp: "2026-09-08T03:00:00Z", type: "session_meta", payload: { id: sid, cwd: repo } }),
    cl({ timestamp: "2026-09-08T03:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a footer link to the site" }] } }),
    cl({ timestamp: "2026-09-08T03:00:02Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Footer link added in src/site.ts" }] } }),
  ];
  fs.writeFileSync(tf, lines.join("\n") + "\n");
  fs.utimesSync(tf, T(100), T(100));
  fs.writeFileSync(path.join(repo, "src", "site.ts"), "export const footer = true;\n");
  setCanned([{ marker: "Add a footer link to the site", dynamic: { kind: "implementation", title: "Footer link", goal: "Add a footer link" } }]);
  const quiet = () => {};

  // pass 1: no turn signal → snapshot checkpoint only, no classification
  clearPrompt();
  const p1 = await helperOnce(cfg, { roots, now: T(101), push: true, log: quiet, classifyWaitMs: 60_000 });
  assert.equal(p1.errors.length, 0, p1.errors.join(" | "));
  assert.equal(p1.bound, 1);
  assert.equal(p1.snapshots, 1);
  assert.equal(p1.checkpoints, 1);
  assert.equal(p1.classified, 0);
  assert.equal(lastPrompt(), null, "snapshot checkpoint does not classify");
  assert.equal((await R.sessionLinks(pool, sid)).length, 0);

  // pass 2: Stop hook wrote a checkpoint signal; nothing new on disk → the turn-only branch → classify
  writeSignal(sid, "checkpoint");
  const p2 = await helperOnce(cfg, { roots, now: T(102), push: true, log: quiet, classifyWaitMs: 60_000 });
  assert.equal(p2.errors.length, 0, p2.errors.join(" | "));
  assert.equal(p2.snapshots, 0, "tree unchanged");
  assert.equal(p2.checkpoints, 1, "turn checkpoint recorded");
  assert.equal(p2.classified, 1);
  assert.ok(lastPrompt()!.includes("Add a footer link to the site"));
  const l2 = await R.sessionLinks(pool, sid);
  assert.equal(l2.length, 1);
  assert.equal(l2[0].source, "suggested");
  assert.equal(l2[0].created_by, "classifier");
  const footer = (await R.getRecord(pool, l2[0].record_id))!;
  assert.equal(footer.title, "Footer link");
  assert.equal(footer.created_by, "classifier");
  assert.equal(loadState()[sid].lastClassifyAt, T(102).getTime());
  assert.equal(C.readProgress(sid)!.last_seq, l2[0].to_seq);
  ok("(e) daemon: no classification at a snapshot checkpoint; a turn checkpoint with nothing new on disk classifies the session → suggested link + classifier-created record");

  // pass 3: another turn 60 s later → rate limited (no model call, lastClassifyAt unchanged)
  fs.appendFileSync(tf, cl({ timestamp: "2026-09-08T03:03:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Also bump the version number" }] } }) + "\n");
  fs.utimesSync(tf, T(103), T(103));
  writeSignal(sid, "checkpoint");
  clearPrompt();
  const p3 = await helperOnce(cfg, { roots, now: T(103), push: true, log: quiet, classifyWaitMs: 60_000 });
  assert.equal(p3.errors.length, 0, p3.errors.join(" | "));
  assert.equal(p3.checkpoints, 1);
  assert.equal(p3.classified, 0);
  assert.equal(lastPrompt(), null, "rate limit: no model call within 120 s");
  assert.equal(loadState()[sid].lastClassifyAt, T(102).getTime());

  // pass 4: kill switch → no classification even though the interval has passed and events are new
  fs.writeFileSync(path.join(repo, "src", "site.ts"), "export const footer = true; // v2\n");
  writeSignal(sid, "checkpoint");
  process.env.LEDGER_CLASSIFY = "0";
  const p4 = await helperOnce(cfg, { roots, now: T(105), push: true, log: quiet, classifyWaitMs: 60_000 });
  delete process.env.LEDGER_CLASSIFY;
  assert.equal(p4.errors.length, 0, p4.errors.join(" | "));
  assert.equal(p4.snapshots, 1, "new snapshot with the turn");
  assert.equal(p4.checkpoints, 1);
  assert.equal(p4.classified, 0);
  assert.equal(lastPrompt(), null, "LEDGER_CLASSIFY=0: no model call");
  assert.equal(loadState()[sid].lastClassifyAt, T(102).getTime());

  // pass 5: interval passed, switch off → classifies only the new events, through the snapshot+turn branch
  fs.writeFileSync(path.join(repo, "src", "site.ts"), "export const footer = true; // v3\n");
  writeSignal(sid, "checkpoint");
  const p5 = await helperOnce(cfg, { roots, now: T(106), push: true, log: quiet, classifyWaitMs: 60_000 });
  assert.equal(p5.errors.length, 0, p5.errors.join(" | "));
  assert.equal(p5.snapshots, 1);
  assert.equal(p5.classified, 1);
  const p = lastPrompt()!;
  assert.ok(p.includes("Also bump the version number") && !/\n\d+ · assistant\.message · Footer link added/.test(p), "only events after the last classified seq are shown");
  assert.equal(loadState()[sid].lastClassifyAt, T(106).getTime());
  assert.equal((await R.sessionLinks(pool, sid)).length, 2, "the new span was linked (title-deduped onto the same record)");
  assert.equal((await R.sessionLinks(pool, sid))[1].record_id, footer.id);
  ok("(e) daemon: 120 s rate limit and LEDGER_CLASSIFY=0 both skip the model; after the interval a turn with a new snapshot classifies only the new events");

  // classifier failure never breaks the pass
  fs.appendFileSync(tf, cl({ timestamp: "2026-09-08T03:10:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Run the nightly backup now" }] } }) + "\n");
  fs.utimesSync(tf, T(110), T(110));
  setCanned([{ marker: "Run the nightly backup", exit: 3 }]);
  writeSignal(sid, "checkpoint");
  const logs: string[] = [];
  const p6 = await helperOnce(cfg, { roots, now: T(110), push: true, log: (m) => logs.push(m), classifyWaitMs: 60_000 });
  assert.equal(p6.errors.length, 0, "a classifier failure is not a pass error");
  assert.equal(p6.checkpoints, 1, "the turn checkpoint was still published");
  // `classified` counts classifications STARTED (the call is detached from the pass); the failure shows in the log
  assert.equal(p6.classified, 1);
  assert.ok(logs.some((l) => /^classify 0199cccc: classifier failed/.test(l)), logs.join("\n"));
  ok("(e) daemon: a failing model is logged and the checkpoint still lands; capture never waits on the classifier");
}

// ---------- (f) work outside a git repo: classified at turn ends and when quiet; decisions become checkpoint prompts ----------
{
  const H = await import("./hooks.js");
  const roots = { claude: path.join(tmp, "claude-empty-f"), codex: path.join(tmp, "codex-f") };
  const day = path.join(roots.codex, "2026", "09", "08");
  fs.mkdirSync(roots.claude, { recursive: true });
  fs.mkdirSync(day, { recursive: true });
  const notes = path.join(tmp, "pm-notes"); // a plain folder, not a git repo
  fs.mkdirSync(notes, { recursive: true });
  const sid = "0199dddd-eeee-7fff-8000-000000000002";
  const tf = path.join(day, `rollout-2026-09-08T04-00-00-${sid}.jsonl`);
  const write = (lines: string[], when: Date) => { fs.appendFileSync(tf, lines.join("\n") + "\n"); fs.utimesSync(tf, when, when); };
  const after = (ms: number) => new Date(T(202).getTime() + ms);
  write([
    cl({ timestamp: "2026-09-08T04:00:00Z", type: "session_meta", payload: { id: sid, cwd: notes } }),
    cl({ timestamp: "2026-09-08T04:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Pricing analysis: we will keep the annual plan until the test reads out" }] } }),
    cl({ timestamp: "2026-09-08T04:00:02Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Noted: the annual plan stays; I will size the monthly-only variant next." }] } }),
  ], T(200));
  setCanned([
    { marker: "Pricing analysis: we will keep the annual plan", dynamic: { kind: "investigation", title: "Pricing analysis", goal: "Decide the plan lineup" }, decision: "Keep the annual plan until the pricing test reads out" },
    { marker: "Also check whether monthly-only hurts trial starts", dynamic: { kind: "investigation", title: "Pricing analysis", goal: null } },
  ]);
  // bind-or-new owns analysis scope: the investigation exists because a person declared it (as ledger_investigation_new
  // does); the classifier links the plain-folder session to it by title and never mints one of its own.
  const pricing = await R.createRecord(pool, { kind: "investigation", title: "Pricing analysis", goal: "Decide the plan lineup", repo: null, created_by: "agaaz" });
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  // pass 1: live, no turn signal → captured, not classified
  clearPrompt();
  const f1 = await helperOnce(cfg, { roots, now: T(201), push: false, log, classifyWaitMs: 60_000 });
  assert.equal(f1.errors.length, 0, f1.errors.join(" | "));
  assert.equal(f1.classified, 0);
  assert.equal(lastPrompt(), null);
  assert.equal((await S.getSession(pool, sid))!.repo, null, "a plain folder has no repo identity");

  // pass 2: the Stop hook's turn signal classifies a session with no repo and no thread
  writeSignal(sid, "checkpoint");
  const f2 = await helperOnce(cfg, { roots, now: T(202), push: false, log, classifyWaitMs: 60_000 });
  assert.equal(f2.errors.length, 0, f2.errors.join(" | "));
  assert.equal(f2.classified, 1, "a turn end classifies work outside a repo");
  assert.equal(f2.checkpoints, 0, "no thread, so no checkpoint");
  const links = await R.sessionLinks(pool, sid);
  assert.equal(links.length, 1);
  const rec = (await R.getRecord(pool, links[0].record_id))!;
  assert.equal(rec.id, pricing.id, "linked to the declared investigation, not a classifier-minted twin");
  assert.deepEqual({ title: rec.title, repo: rec.repo, touched: rec.touched_repos }, { title: "Pricing analysis", repo: null, touched: [] });
  const st = (await R.recordState(pool, rec.id))!;
  assert.deepEqual(st.decisions.map((u) => [u.status, u.text]), [["proposed", "Keep the annual plan until the pricing test reads out"]]);
  const dId = `d:${st.decisions[0].id}`;
  assert.deepEqual(H.debt(H.loadJournal(sid)).map((e) => [e.kind, e.evidence_id, e.record_title]), [["decision", dId, "Pricing analysis"]]);
  assert.ok(logs.some((l) => l.includes("1 decision(s) from the conversation queued for the next checkpoint")), logs.join("\n"));
  const stop = H.handleHook("Stop", { session_id: sid }, { now: T(202) });
  const reason = JSON.parse(stop.stdout!).reason as string;
  assert.ok(reason.includes("1 decision found in this conversation still lack") && reason.includes(`${dId} · `) && reason.includes('decision proposed on record "Pricing analysis": Keep the annual plan until the pricing test reads out') && reason.includes("For a d: item"), reason);
  ok("(f) daemon: a Codex session in a plain folder (no repo, no thread) is classified at its turn end into a non-code record; its proposed decision becomes a d: prompt at the next Stop");

  // pass 3: new work, then quiet inside the 120 s rate limit → held open, not ended
  write([cl({ timestamp: "2026-09-08T04:01:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Also check whether monthly-only hurts trial starts" }] } })], after(10_000));
  clearPrompt();
  const f3 = await helperOnce(cfg, { roots, now: after(100_000), quietEndMin: 1, push: false, log, classifyWaitMs: 60_000 });
  assert.equal(f3.errors.length, 0, f3.errors.join(" | "));
  assert.equal(f3.classified, 0, "rate limited");
  assert.equal(lastPrompt(), null);
  assert.ok(!loadState()[sid].ended, "a quiet session waits for its unclassified tail instead of ending");
  assert.equal((await S.getSession(pool, sid))!.ended_at, null);
  assert.equal(loadState()[sid].classifyHoldSince, after(100_000).getTime());

  // pass 4: after the rate limit → the tail is classified and the session ends
  const f4 = await helperOnce(cfg, { roots, now: after(130_000), quietEndMin: 1, push: false, log, classifyWaitMs: 60_000 });
  assert.equal(f4.errors.length, 0, f4.errors.join(" | "));
  assert.equal(f4.classified, 1);
  assert.ok(lastPrompt()!.includes("Also check whether monthly-only hurts trial starts"));
  assert.equal(loadState()[sid].ended, true);
  assert.equal(loadState()[sid].classifyHoldSince, undefined);
  assert.equal(await C.unclassifiedCount(pool, sid), 0, "the tail is classified");
  assert.equal(H.debt(H.loadJournal(sid)).length, 1, "no new decision, the first prompt is still open");

  // pass 5: nothing new → no model call
  clearPrompt();
  writeSignal(sid, "checkpoint");
  const f5 = await helperOnce(cfg, { roots, now: after(400_000), quietEndMin: 1, push: false, log, classifyWaitMs: 60_000 });
  assert.equal(f5.classified, 0);
  assert.equal(lastPrompt(), null);

  // a scoped skip settles the decision prompt
  const skip = { schema: "ledger-capture/v1" as const, action: "skip" as const, status: "dismissed" as const, reason: "nobody decided this yet; still exploring", coverage: [{ session_id: sid, evidence_ids: [dId] }] };
  H.handleHook("PostToolUse", { session_id: sid, tool_name: "mcp__ledger__ledger_skip_record", tool_input: { reason: skip.reason, capture_coverage: skip.coverage }, tool_response: { structuredContent: { capture_ack: skip } }, tool_use_id: "skip-d" }, { now: after(410_000) });
  assert.deepEqual(H.debt(H.loadJournal(sid)), []);
  ok("(f) daemon: a quiet session is held open while its new tail waits out the rate limit, then classified and ended; nothing new means no model call; a scoped skip settles the d: prompt");
}

// ---------- relevance and confirmed state survive recency, closed status and proposal floods ----------
{
  const repo = 'fixture/hiastro-classifier-scope'; const sessionId = 'cls-scope-flood';
  await S.upsertSession(pool,{id:sessionId,author:'agaaz',harness:'codex',repo});
  await S.appendEvents(pool,sessionId,[{producer_event_id:'scope-1',kind:'instruction.added',payload:{text:'Revisit the HiAstro conversion denominator correction and eligible population.'}}],null,null);
  const older = await R.createRecord(pool,{kind:'investigation',title:'HiAstro conversion denominator',goal:'Correct eligible population',repo,created_by:'rachit'});
  const closed = await R.createRecord(pool,{kind:'investigation',title:'Archived baseline audit',repo,created_by:'rachit'});
  await R.addStateUpdate(pool,{record_id:closed.id,kind:'decision',text:'Accepted HiAstro denominator correction counts every eligible person.',status:'confirmed',created_by:'rachit'});
  for(let i=0;i<45;i++) await R.addStateUpdate(pool,{record_id:closed.id,kind:i%2?'progress':'decision',text:`Recent proposed unrelated alternative ${i}`,status:'proposed',created_by:'classifier'});
  await R.updateRecordMeta(pool,closed.id,{status:'done'});
  await pool.query("update cont_records set updated_at=now()-interval '100 days' where id=any($1::uuid[])",[[older.id,closed.id]]);
  const foreign = await R.createRecord(pool,{kind:'investigation',title:'HiAstro conversion denominator',goal:'Correct eligible population',repo:'fixture/forbidden-scope',created_by:'other'});
  for(let i=0;i<80;i++) {
    const item=await R.createRecord(pool,{kind:'other',title:`Unrelated recent update ${i}`,repo,created_by:'third-agent'});
    if(i<45) await R.linkSpan(pool,{record_id:item.id,session_id:sessionId,from_seq:1,to_seq:1,source:'explicit',created_by:'agaaz'});
  }
  const before=await recordCount(); let prompt='';
  const result=await C.classifySession(cfg,pool,sessionId,{dryRun:true,extract:async value=>{prompt=value;return JSON.stringify({assignments:[],state_updates:[],unassigned:[]});}});
  assert.equal(result.model_ok,true,result.error ?? 'classifier should succeed');
  assert.equal(result.candidates,30); assert.ok(result.candidate_pool_size>=82 && result.candidates_omitted>=52);
  assert.ok(prompt.includes(older.id),'old relevant unlinked record survives 80 recent additions and 45 linked candidates');
  assert.ok(prompt.includes(closed.id),'closed record is relevant through accepted state even with a generic title');
  assert.ok(!prompt.includes(foreign.id),'unlinked record from another repository cannot enter lexical results');
  assert.match(prompt,/CONFIRMED \(1 current, 0 omitted from summary\): decision: Accepted HiAstro denominator correction counts every eligible person/);
  assert.match(prompt,/PROPOSED \(45 current, \d+ omitted from summary\)/);
  assert.match(prompt,/\d+ omitted by the 30-record prompt cap/);
  assert.equal(await recordCount(),before,'retrieval test uses fake output and does not manufacture classifier records');
  ok('full-scope lexical candidates retain old/closed relevant work; confirmed state survives proposal floods; omitted counts and foreign scope remain explicit');
}

// ---------- a restated investigation links to the open one instead of becoming record #14 ----------
// Thirteen open investigations with zero bound sessions were one question restated, not thirteen questions.
// byTitle only collapsed byte-identical titles inside a repo-scoped, capped candidate list.
{
  const open = [
    { title: "Analyze live HiAstro paywall variant performance", goal: "Compare HiAstro production paywall variants using live impression, click, and conversion events." },
    { title: "Diagnose and reduce SDK primary-host timeouts", goal: "Identify the cause of primary-host fallbacks and determine a remedy that preserves access for Jio users." },
    { title: "Marriage-intent paywall experiment sizing", goal: "Recover prior marriage-intent paywall work and continue sizing the experiment." },
    { title: "Analyze HiAstro paywall conversion and reconcile Autotune results", goal: "Trace paywall exposure through verified trials and paid charges, then reconcile the funnel analysis with Statsig Autotune results." },
    { title: "Evaluate HiAstro intent paywall designs against monetization evidence", goal: "Critique the supplied paywall screenshot and intent-sheet designs using historical experiment results and subscription-plan economics." },
    { title: "Compare Ledger with current GBrain, Supermemory, and Graphify", goal: "Compare Ledger's capabilities and benchmark evidence with the latest releases of GBrain, Supermemory, and Graphify." },
    { title: "Review Ledger's handoff capabilities, benchmark evidence, and continuity gaps", goal: "Assess Ledger against the unfinished-work handoff goal and identify evidence-backed priorities." },
  ].map((r, i) => ({ ...r, id: `open-${i}`, kind: "investigation", status: "open", repo: null } as any));
  const idf = C_idfOver(open.map((r) => `${r.title} ${r.goal}`));
  const twin = (title: string, goal: string) => C.twinInvestigation({ title, goal }, open, idf);

  // Restatements of an open investigation link to it.
  assert.equal(twin("Analyze HiAstro paywall variant performance live", "Compare live HiAstro paywall variants on impressions, clicks and conversions.")?.record.id, "open-0");
  assert.equal(twin("Investigate SDK host fallback timeouts", "Find why the primary host times out and fix it without losing Jio users.")?.record.id, "open-1");
  assert.equal(twin("Size the marriage-intent paywall experiment", "Continue sizing the marriage intent paywall test.")?.record.id, "open-2");

  // The real open investigations are distinct work and must not collapse into each other.
  for (const r of open) {
    const others = open.filter((o) => o.id !== r.id);
    const collapsed = C.twinInvestigation({ title: r.title, goal: r.goal }, others, C_idfOver(others.map((o) => `${o.title} ${o.goal}`)));
    assert.equal(collapsed, null, `"${r.title}" must not be read as a restatement of "${collapsed?.record.title}"`);
  }

  // A genuinely different question opens a new record; linking is not the default.
  assert.equal(twin("Cut the SessionStart brief below four seconds", "Make the continuity sections load inside the brief's budget."), null);
  assert.equal(twin("Write the investor update for September", "Draft the monthly update covering shipping and revenue."), null);
  assert.ok(C.TWIN_TITLE === 0.5 && C.TWIN_QUESTION === 0.3, "both bars are explicit constants, not inline numbers");
  ok("anti-twin: a reworded investigation links to the open one; seven real open investigations stay seven");
}

await closePools();
console.log(`selftest-classify: ok (${step} checks) — tmp ${tmp}`);
