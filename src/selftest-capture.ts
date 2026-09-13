import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { acknowledgeCapture, addDecisionObligations, captureEvidenceIds, captureStats, debt, handleHook, loadJournal, reviewDebt, saveJournal, sessionStartContext, validateCaptureCoverage, type CaptureAck } from "./hooks.js";
import { dataToolCalls, isDataTool, normalizeToolCalls, savedRecord } from "./capture-tools.js";
import { evidenceText, parseTranscript, type Evidence } from "./transcript.js";
import { extractionDebt, findCandidates, reconcile } from "./extract.js";
import { streamTranscript, ARTIFACT_MAX } from "./continuity/events.js";
import { materializeArtifacts } from "./helper/daemon.js";
import { getById, type Config } from "./store.js";

// Synthetic inputs, local temporary ledgers, an injected artifact sink and a deterministic extractor.
// No production settings, database, model provider or Git remote is used.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-capture-regression-"));
process.env.LEDGER_CONFIG_DIR = path.join(tmp, "config");
process.env.LEDGER_GIT_SYNC = "0";
const dir = path.join(tmp, "journals"), sid = "capture-fixture";
let tick = 0, checks = 0;
const now = () => new Date(Date.UTC(2026, 8, 10, 12, 0, tick++));
const hook = (tool: string, input: any, response?: any, id?: string, session = sid) => handleHook("PostToolUse", { session_id: session, tool_name: tool, tool_input: input, tool_response: response, tool_use_id: id }, { dir, now: now() });
const journal = () => loadJournal(sid, dir);
const checkpoint = () => handleHook("Stop", { session_id: sid }, { dir, now: now() });
const coverage = (ids: string[], session = sid) => [{ session_id: session, evidence_ids: ids }];
const receipt = (ack: CaptureAck, error = false) => ({ isError: error, structuredContent: { capture_ack: ack, receipt: { action: "saved", record_id: ack.record_id, records: [{ id: ack.record_id, status: ack.status === "pending_review" ? "draft" : "stable" }] } } });
const recordAck = (ids: string[], status: "recorded" | "pending_review" = "recorded"): CaptureAck => ({ schema: "ledger-capture/v1", action: "record", status, record_id: "fnd-20260910-capture-aaaa", coverage: coverage(ids) });
const ok = (message: string) => console.log(`ok ${++checks} · ${message}`);

hook("mcp__mixpanel__query", { sql: "SELECT trials FROM hiastro" }, {}, "A");
hook("mcp__mixpanel__query", { sql: "SELECT users FROM other_product" }, {}, "B");
hook("mcp__mixpanel__query", { sql: "SELECT trials FROM hiastro" }, {}, "A");
assert.deepEqual(debt(journal()).map(q => q.evidence_id), ["q:A", "q:B"], "duplicate host delivery does not duplicate an obligation");
hook("mcp__ledger__ledger_record_decision", { title: "Unrelated UI color" }, { content: [{ type: "text", text: "Recorded decision dec-20260910-ui-color-aaaa" }] });
assert.equal(debt(journal()).length, 2, "unrelated successful save cannot clear any debt");
const ackA = recordAck(["q:A"]);
hook("mcp__ledger__ledger_record_finding", { title: "A", capture_coverage: coverage(["q:A"]) }, receipt(ackA, true));
assert.equal(debt(journal()).length, 2, "failed save with plausible ack cannot clear debt");
hook("mcp__ledger__ledger_record_finding", { title: "A", capture_coverage: coverage(["q:B"]) }, receipt(ackA));
assert.equal(debt(journal()).length, 2, "receipt coverage must exactly match requested IDs");
hook("mcp__ledger__ledger_record_finding", { title: "A", capture_coverage: coverage(["q:A"]) }, receipt(ackA));
assert.deepEqual(debt(journal()).map(q => q.evidence_id), ["q:B"]);
assert.match(checkpoint().stdout!, /q:B/);
assert.match(sessionStartContext(journal()), /q:B/);
ok("A+B queries, A-only finding: B survives unrelated saves, failures, mismatched acknowledgments and restart");

assert.throws(() => validateCaptureCoverage(coverage(["q:A"], "unknown-session"), dir), /unknown/);
assert.throws(() => validateCaptureCoverage(coverage(["q:B", "q:B"]), dir), /duplicate/);
hook("mcp__ledger__ledger_skip_record", { reason: "unrelated sanity check" }, { content: [{ type: "text", text: "Noted, nothing recorded" }] });
assert.equal(debt(journal()).length, 1);
const skip: CaptureAck = { schema: "ledger-capture/v1", action: "skip", status: "dismissed", reason: "Query B was a connectivity sanity check", coverage: coverage(["q:B"]) };
hook("mcp__ledger__ledger_skip_record", { reason: skip.reason, capture_coverage: skip.coverage }, { isError: true, structuredContent: { capture_ack: skip } });
assert.equal(debt(journal()).length, 1);
hook("mcp__ledger__ledger_skip_record", { reason: "Another unrelated reason", capture_coverage: skip.coverage }, { structuredContent: { capture_ack: skip } });
assert.equal(debt(journal()).length, 1);
hook("mcp__ledger__ledger_skip_record", { reason: skip.reason, capture_coverage: skip.coverage }, { structuredContent: { capture_ack: skip } });
assert.equal(debt(journal()).length, 0);
assert.deepEqual(acknowledgeCapture(skip, { dir }), { acknowledged: 0, pending_review: 0 });
ok("dismissal requires successful exact coverage/reason; unknown sessions and duplicate IDs are rejected; acknowledgment is idempotent");

hook("mcp__mixpanel__query", { sql: "SELECT denominator FROM hiastro" }, {}, "C");
const pending = recordAck(["q:C"], "pending_review");
hook("mcp__ledger__ledger_record_finding", { capture_coverage: pending.coverage }, receipt(pending));
assert.equal(debt(journal()).length, 0);
assert.deepEqual(reviewDebt(journal()).map(q => q.evidence_id), ["q:C"]);
assert.match(sessionStartContext(journal()), /awaiting review/);
assert.match(sessionStartContext(journal()), /not an accepted finding/);
acknowledgeCapture(recordAck(["q:C"]), { dir });
acknowledgeCapture(pending, { dir });
assert.equal(reviewDebt(journal()).length, 0, "late draft cannot undo accepted capture status");
const legacy = { session_id: "legacy", started: now().toISOString(), entries: [{ at: now().toISOString(), kind: "query" as const, tool: "mcp__mixpanel__query", summary: "Old query" }, { at: now().toISOString(), kind: "record" as const, id: "fnd-20260910-unscoped-aaaa" }] };
assert.equal(debt(legacy).length, 1);
assert.equal(debt(legacy)[0].evidence_id, debt(JSON.parse(JSON.stringify(legacy)))[0].evidence_id);
const legacyId = captureEvidenceIds(legacy)[0];
legacy.entries.push({ at: now().toISOString(), kind: 'record', id: 'fnd-20260910-legacy-aaaa', evidence_ids: [legacyId], capture_status: 'recorded' } as any);
assert.equal(debt(legacy).length, 0); assert.deepEqual(captureEvidenceIds(legacy), [legacyId], 'settled legacy IDs remain valid explicit membership');
ok("pending review remains visible without repeat extraction, and legacy obligations retain deterministic IDs");

hook('mcp__mixpanel__query', {sql:'SELECT local'}, {}, 'local-remote');
const mixedAck: CaptureAck = {...recordAck(['q:local-remote']), coverage:[...coverage(['q:local-remote']), {session_id:'other-laptop',evidence_ids:['q:remote']}]};
hook('mcp__ledger__ledger_record_finding', {capture_coverage:mixedAck.coverage}, receipt(mixedAck));
assert.equal(debt(journal()).length, 0, 'remote successful exact receipt can settle its locally known subset');
assert.equal(fs.existsSync(path.join(dir,'other-laptop.json')), false, 'hook never creates a foreign journal to acknowledge remote evidence');
ok('mixed local/remote receipt settles exact local membership without fabricating another laptop journal');

const statsDir = path.join(tmp,'stats-journals');
saveJournal({session_id:'stats',started:now().toISOString(),entries:[
  {at:now().toISOString(),kind:'query',evidence_id:'q:stats-A'},
  {at:now().toISOString(),kind:'query',evidence_id:'q:stats-B'},
  {at:now().toISOString(),kind:'nudge',evidence_ids:['q:stats-A','q:stats-B']},
  {at:now().toISOString(),kind:'record',id:'dec-20260910-unrelated-aaaa'},
  {at:now().toISOString(),kind:'skip',evidence_ids:['q:stats-B'],capture_status:'dismissed'},
  {at:now().toISOString(),kind:'record',id:'fnd-20260910-related-aaaa',evidence_ids:['q:stats-A'],capture_status:'pending_review'},
]},statsDir);
const stats = captureStats(365,statsDir).join('\n');
assert.match(stats,/records 2 \(1 unprompted, 1 after a checkpoint\)/);
assert.match(stats,/query results awaiting draft review 1/);
ok('checkpoint metrics attribute only covered evidence; unrelated saves/skips cannot claim prompted capture or erase pending review');

await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise<void>((resolve, reject) => {
  const script = `import {handleHook} from ${JSON.stringify(new URL("./hooks.js", import.meta.url).href)}; handleHook('PostToolUse', {session_id:'parallel-hooks',tool_name:'mcp__mixpanel__query',tool_use_id:'parallel-${index}',tool_input:{sql:'SELECT ${index}'}}, {dir:${JSON.stringify(dir)}});`;
  execFile(process.execPath, ["--input-type=module", "-e", script], { env: process.env, timeout: 10_000 }, (error, _stdout, stderr) => error ? reject(new Error(String(error) + stderr)) : resolve());
})));
assert.equal(debt(loadJournal("parallel-hooks", dir)).length, 8);
const corruptPath = path.join(dir, "corrupt.json"), corruptBytes = '{"session_id":"corrupt","entries":[';
fs.writeFileSync(corruptPath, corruptBytes);
assert.throws(() => handleHook("PostToolUse", { session_id: "corrupt", tool_name: "mcp__mixpanel__query", tool_input: { sql: "SELECT 1" } }, { dir }), /refusing to overwrite/);
assert.equal(fs.readFileSync(corruptPath, "utf8"), corruptBytes);
ok("concurrent hook processes preserve every obligation; unreadable journals are never silently reset");

const wrapper = 'const a=await tools.mcp__mixpanel__query({sql:"SELECT trials", parameters:{country:"IN"}}); const b=await tools["mcp__mixpanel__query"]({sql:"SELECT users"}); text([a,b]);';
assert.equal(isDataTool("functions.exec", wrapper), true);
assert.equal(isDataTool("exec", 'text(await tools.exec_command({cmd:"psql -c select"}));'), true);
assert.equal(dataToolCalls("exec", wrapper, "wrap").length, 2);
assert.equal(isDataTool("exec", '// tools.mcp__mixpanel__query({sql:"ignore"});\ntext("tools.mcp__mixpanel__query({})");'), false);
const dynamic = normalizeToolCalls("exec", "await tools.mcp__mixpanel__query({sql: process.env.SECRET});", "dynamic")[0];
assert.equal(dynamic.input_complete, false);
assert.equal(isDataTool("exec", "await tools.mcp__mixpanel__query({sql: process.env.SECRET});"), true);
assert.equal(savedRecord(receipt(ackA))?.id, ackA.record_id);
assert.equal(savedRecord(receipt(ackA, true)), null);
assert.equal(savedRecord({ content: [{ type: "text", text: "Rejected: duplicate of fnd-20260910-example-aaaa" }] }), null);
ok("native/namespaced/literal wrappers normalize without evaluating code; dynamic inputs stay explicitly unresolved; Saved receipts recognized");

const longSql = `SELECT count(*) FROM events\n-- ${"denominator context ".repeat(350)}\nWHERE eligible_user = true AND internal_user = false`;
const transcript = path.join(tmp, "rollout-2026-09-10T12-00-00-normalization.jsonl");
const json = (value: any) => JSON.stringify(value);
fs.writeFileSync(transcript, [
  json({ type: "session_meta", payload: { id: "normalization", cwd: tmp } }),
  json({ type: "response_item", payload: { type: "function_call", name: "mcp__mixpanel__query", call_id: "long", arguments: JSON.stringify({ sql: longSql, parameters: { country: "IN" } }) } }),
  json({ type: "response_item", payload: { type: "function_call_output", call_id: "long", output: "42" } }),
  json({ type: "response_item", payload: { type: "custom_tool_call", name: "functions.exec", call_id: "wrap", input: wrapper } }),
  json({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "wrap", output: "[10,20]" } }),
].join("\n") + "\n");
const parsed = parseTranscript(transcript, "codex");
assert.equal(parsed.queries.length, 3);
assert.equal(parsed.queries[0].input, longSql, "SQL newline/comment semantics preserved exactly");
assert.match(parsed.queries[0].input_json!, /country/);
assert.equal(parsed.queries[1].output_binding, "wrapper_aggregate");
assert.equal(parsed.queries[1].output_complete, false, "aggregate wrapper output is not falsely bound to each query");
const text = evidenceText({ ...parsed, conclusions: Array.from({ length: 100 }, () => "UNRELATED LATER CONCLUSION ".repeat(100)) });
assert.match(text, /internal_user = false/);
assert.match(text, /all required queries retained/);
assert.throws(() => evidenceText({ ...parsed, queries: [{ ...parsed.queries[0], input: "Q".repeat(50_000) }] }), /Required query evidence exceeds.*no queries were discarded/);
ok("exact long SQL and parameters survive parsing and narrative pressure; aggregate or oversize evidence never appears complete");

const stream = streamTranscript(transcript, 0, "codex");
const requested = stream.events.filter(e => e.kind === "tool.requested");
assert.match(String(requested[0].payload._full_input), /internal_user = false/);
assert.deepEqual(requested[0].payload.evidence_ids, ["q:long"]);
assert.deepEqual(requested[1].payload.evidence_ids, parsed.queries.slice(1).map(q => q.evidence_id));
const stored: Buffer[] = [];
await assert.rejects(materializeArtifacts({} as any, "normalization", requested, async () => { throw new Error("offline"); }), /offline/);
assert.equal(typeof requested[0].payload._full_input, "string", "failed delivery leaves exact bytes available for retry");
await materializeArtifacts({} as any, "normalization", requested, async (_pool, artifact) => { stored.push(artifact.bytes!); return { id: `artifact-${stored.length}` } as any; });
assert.equal(requested[0].payload.input_availability, "stored");
assert.equal(requested[0].payload._full_input, undefined);
assert.equal(requested[0].payload.input_artifact_sha256, crypto.createHash("sha256").update(stored[0]).digest("hex"));
assert.equal(JSON.parse(stored[0].toString()).sql, longSql);
ok("query artifacts preserve exact permitted bytes, match hashes, and retry offline input delivery without a new source event");

const redactedFile = path.join(tmp, "redacted.jsonl");
fs.writeFileSync(redactedFile, json({ type: "assistant", message: { content: [{ type: "tool_use", id: "secret", name: "mcp__mixpanel__query", input: { sql: "SELECT 1", api_key: "sk-abcdefghijklmnopqrstuvwxyz012345" } }] } }) + "\n");
const red = streamTranscript(redactedFile, 0, "claude").events.find(e => e.kind === "tool.requested")!;
assert.equal(red.payload.input_complete, false);
assert.equal(red.payload.input_redactions, 1);
assert.ok(!String(red.payload._full_input).includes("sk-abcdefghijklmnopqrstuvwxyz"));
const hugeFile = path.join(tmp, "oversize.jsonl");
fs.writeFileSync(hugeFile, json({ type: "assistant", message: { content: [{ type: "tool_use", id: "huge", name: "mcp__mixpanel__query", input: { sql: "q".repeat(ARTIFACT_MAX + 1) } }] } }) + "\n");
const huge = streamTranscript(hugeFile, 0, "claude").events.find(e => e.kind === "tool.requested")!;
assert.equal(huge.payload.input_availability, "oversized");
assert.equal(huge.payload.input_complete, false);
assert.equal(huge.payload._full_input, undefined);
ok("redacted and oversize query inputs remain labelled incomplete instead of promising executable artifacts");

const fallbackSid = "fallback-session", fallbackFile = path.join(tmp, "fallback-session.jsonl");
const cfg: Config = { ledger_dir: path.join(tmp, "ledger"), author: "capture-fixture", git_sync: false };
fs.mkdirSync(cfg.ledger_dir);
const fallbackLines: string[] = [];
function appendFallback(call: string, sql: string) {
  const at = now();
  fallbackLines.push(json({ type: "assistant", sessionId: fallbackSid, timestamp: at.toISOString(), message: { content: [{ type: "tool_use", id: call, name: "mcp__mixpanel__query", input: { sql } }] } }));
  fallbackLines.push(json({ type: "user", sessionId: fallbackSid, timestamp: at.toISOString(), message: { content: [{ type: "tool_result", tool_use_id: call, content: "42" }] } }));
  fs.writeFileSync(fallbackFile, fallbackLines.join("\n") + "\n");
  handleHook("PostToolUse", { session_id: fallbackSid, transcript_path: fallbackFile, tool_name: "mcp__mixpanel__query", tool_input: { sql }, tool_use_id: call }, { dir, now: at });
}
appendFallback("first", "SELECT numerator");
const fakeExtractor = path.join(tmp, "extractor.cjs"), runs = path.join(tmp, "extractor-runs.txt");
fs.writeFileSync(fakeExtractor, `const fs=require('node:fs');let p='';process.stdin.on('data',x=>p+=x).on('end',()=>{fs.appendFileSync(${json(runs)},'run\\n');const ids=[...p.matchAll(/^### (q:[^ ]+) ·/gm)].map(x=>x[1]);console.log(JSON.stringify({drafts:[{type:'finding',evidence_ids:ids,fields:{title:'Synthetic denominator finding',question:'What is the denominator?',result:'42 (synthetic)'}}],reason:'synthetic covered query'}));});`);
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
process.env.LEDGER_EXTRACTOR_CMD = `${shellQuote(process.execPath)} ${shellQuote(fakeExtractor)}`;
const opts = { dir, sessionId: fallbackSid, quietMs: 0 };
let results = reconcile(cfg, opts);
assert.equal(results[0].result, "drafts", JSON.stringify(results));
let fallbackJournal = loadJournal(fallbackSid, dir);
assert.equal(debt(fallbackJournal).length, 0);
assert.equal(reviewDebt(fallbackJournal).length, 1);
assert.deepEqual(getById(cfg, results[0].draft_ids[0])?.fields.capture_coverage, coverage(["q:first"], fallbackSid));
assert.equal(reconcile(cfg, opts).length, 0, "review-covered IDs do not extract again");
appendFallback("second", "SELECT corrected denominator");
results = reconcile(cfg, opts);
assert.equal(results[0].result, "drafts", JSON.stringify(results));
assert.equal(reviewDebt(loadJournal(fallbackSid, dir)).length, 2);
assert.equal(fs.readFileSync(runs, "utf8").trim().split("\n").length, 2);
assert.equal(loadJournal(fallbackSid, dir).extractions?.length, 2);
ok("fallback persists explicit draft coverage, preserves review debt, and processes new evidence after a session resumes");

appendFallback("third", "SELECT unrelated population");
fs.writeFileSync(fakeExtractor, `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({drafts:[{type:'finding',evidence_ids:['q:first'],fields:{title:'Unrelated old result',question:'An old question?',result:'old'}}]})));`);
results = reconcile(cfg, opts);
assert.equal(results[0].result, "error");
assert.deepEqual(debt(loadJournal(fallbackSid, dir)).map(q => q.evidence_id), ["q:third"]);
ok("fallback cannot satisfy new obligations by attaching an unrelated prior query ID");

appendFallback("fourth", "SELECT another unresolved denominator");
fs.writeFileSync(fakeExtractor, `let p='';process.stdin.on('data',x=>p+=x).on('end',()=>{const id=p.match(/^### (q:[^ ]+) ·/m)[1];console.log(JSON.stringify({drafts:[{type:'finding',evidence_ids:[id],fields:{title:'One scoped result',question:'One question?',result:'42'}}]}));});`);
results = reconcile(cfg, opts);
assert.equal(results[0].result, "drafts");
assert.deepEqual(debt(loadJournal(fallbackSid, dir)).map(q => q.evidence_id), ["q:fourth"]);
assert.deepEqual(extractionDebt(loadJournal(fallbackSid, dir)).map(q => q.evidence_id), ["q:fourth"], "partial fallback cannot advance past uncovered work");
assert.ok(findCandidates({ dir, quietMs: 0 }).some(candidate => candidate.journal.session_id === fallbackSid && candidate.evidence[0].evidence_id === "q:fourth"));
ok("partial fallback coverage leaves unmatched evidence eligible for the next automatic batch");

// decisions the classifier found in conversation are obligations beside queries
{
  const dsid = "decision-fixture", uid = "11111111-2222-4333-8444-555555555555", did = `d:${uid}`;
  const item = { update_id: uid, record_title: "Pricing analysis", text: "Keep the annual plan until the test reads out" };
  assert.equal(addDecisionObligations(dsid, [item], { dir, now: now() }), 1);
  assert.equal(addDecisionObligations(dsid, [item], { dir, now: now() }), 0, "the same proposal is queued once");
  assert.deepEqual(debt(loadJournal(dsid, dir)).map((e) => [e.kind, e.evidence_id]), [["decision", did]]);
  assert.deepEqual(extractionDebt(loadJournal(dsid, dir), true), [], "decision prompts never go to the transcript fallback");
  assert.deepEqual(validateCaptureCoverage(coverage([did], dsid), dir), coverage([did], dsid));
  assert.equal(handleHook("SessionEnd", { session_id: dsid }, { dir, now: now() }).reconcile, undefined, "decision-only debt does not start the fallback");
  const blocked = JSON.parse(handleHook("Stop", { session_id: dsid }, { dir, now: now() }).stdout!);
  assert.equal(blocked.decision, "block");
  assert.ok(blocked.reason.startsWith(`Session ${dsid}\nLedger: 1 decision found in this conversation still lack an explicitly scoped capture acknowledgment:\n- ${did} · `), blocked.reason);
  assert.ok(blocked.reason.includes(`decision proposed on record "Pricing analysis": Keep the annual plan until the test reads out`) && blocked.reason.includes("For a d: item"), blocked.reason);
  assert.ok(sessionStartContext(loadJournal(dsid, dir)).includes("1 decision found in this conversation have no explicitly scoped record. Context may have been compacted; they are still known"));
  const decAck: CaptureAck = { schema: "ledger-capture/v1", action: "record", status: "recorded", record_id: "dec-20260910-keep-annual-plan-aaaa", coverage: coverage([did], dsid) };
  hook("mcp__ledger__ledger_record_decision", { title: "Keep the annual plan", capture_coverage: decAck.coverage }, receipt(decAck), "decision-record", dsid);
  assert.deepEqual(debt(loadJournal(dsid, dir)), [], "a scoped Ledger decision settles it");
  ok("decisions found in conversation queue once as d: obligations, block Stop with their record and text, stay out of the transcript fallback, and settle with a scoped decision record");
}

console.log(`Capture regression suite: ${checks} scenarios passed. Temporary fixtures: ${tmp}`);
