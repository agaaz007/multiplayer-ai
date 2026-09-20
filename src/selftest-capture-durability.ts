import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { spoolAppend, spoolPending, spoolAck, spoolCursor, spoolDir, spoolStatus } from "./helper/spool.js";
import { acquireProcessLease } from "./helper/process-lock.js";
import { drainUsageWrites } from "./usage.js";
import { helperOnce, materializeArtifacts, retainOffloadedOutputs } from "./helper/daemon.js";
import { streamTranscript, type NormEvent } from "./continuity/events.js";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-durability-"));
process.env.LEDGER_CONFIG_DIR = path.join(temp, "config");
const event = (id: string): NormEvent => ({ producer_event_id: id, kind: "assistant.message", payload: { text: id } });
const batch = (offset: number, id = String(offset)) => ({ offset, at: new Date().toISOString(), events: [event(id)] });
let passed = 0; const ok = (s: string) => console.log(`ok ${++passed}. ${s}`);
try {
  // Abrupt process exit at actual fsync/rename boundaries, not only exceptions.
  for (const boundary of ["file_flushed", "segment_committed", "manifest_committed"]) {
    const sid = `crash-${boundary}`; spoolAppend(sid, batch(1));
    const code = `import {setSpoolFaultInjector,spoolAppend} from ${JSON.stringify(new URL("./helper/spool.js", import.meta.url).href)}; setSpoolFaultInjector(b=>{if(b===${JSON.stringify(boundary)})process.exit(86)});spoolAppend(${JSON.stringify(sid)},${JSON.stringify(batch(2))});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: process.env });
    assert.equal(result.status, 86);
    const cursor = spoolCursor(sid)!; assert.ok(cursor === 1 || cursor === 2);
    const pending = spoolPending(sid, 10); assert.deepEqual(pending.batches.map(b => b.offset), cursor === 2 ? [1, 2] : [1]);
    if (cursor === 1) spoolAppend(sid, batch(2));
    assert.deepEqual(spoolPending(sid, 10).batches.flatMap(b => b.events.map(e => e.producer_event_id)), ["1", "2"]);
  }
  ok("kill before/after segment and cursor commit replays exact admitted event set");
  for (const boundary of ["file_flushed", "manifest_committed"]) {
    const sid = `ack-${boundary}`; spoolAppend(sid, batch(3));
    const code = `import {setSpoolFaultInjector,spoolAck} from ${JSON.stringify(new URL("./helper/spool.js", import.meta.url).href)};setSpoolFaultInjector(b=>{if(b===${JSON.stringify(boundary)})process.exit(86)});spoolAck(${JSON.stringify(sid)},1);`;
    assert.equal(spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: process.env }).status, 86);
    const pending = spoolPending(sid); assert.equal(pending.acked, boundary === "file_flushed" ? 0 : 1); assert.equal(spoolCursor(sid), 3);
  }
  ok("ack kill boundaries replay or acknowledge, never erase source/segments");
  spoolAppend("many", { offset: 999, at: "2026-09-20T00:00:00Z", events: Array.from({ length: 10000 }, (_, n) => event(`e${n}`)) });
  let count = 0;
  for (;;) { const p = spoolPending("many"); if (!p.batches.length) break; assert.ok(p.batches[0].events.length <= 200); count += p.batches[0].events.length; spoolAck("many", p.acked + 1); }
  assert.equal(count, 10000); assert.equal(spoolStatus("many").pending_batches, 0); assert.equal(spoolCursor("many"), 999);
  ok("10,000-event replay stays at 200-event upload chunks");
  fs.writeFileSync(path.join(spoolDir(), "legacy.jsonl"), [batch(1), batch(2)].map(b => JSON.stringify(b)).join("\n") + "\n");
  fs.writeFileSync(path.join(spoolDir(), "legacy.ack"), "1\n");
  assert.equal(spoolCursor("legacy"), 2); assert.deepEqual(spoolPending("legacy").batches.map(b => b.offset), [2]);
  assert.ok(fs.existsSync(path.join(spoolDir(), "legacy.jsonl")));
  for (const [id, contents] of [["partial", JSON.stringify(batch(1))], ["corrupt", JSON.stringify(batch(1)) + "\n!bad\n" + JSON.stringify(batch(3)) + "\n"]]) {
    fs.writeFileSync(path.join(spoolDir(), `${id}.jsonl`), contents); assert.throws(() => spoolPending(id), /incomplete|corrupt/); assert.equal(fs.readFileSync(path.join(spoolDir(), `${id}.jsonl`), "utf8"), contents);
  }
  const segment = path.join(spoolDir(), "crash-manifest_committed.v2", "000000000000.json"); fs.writeFileSync(segment, JSON.stringify({ body: "{}", sha256: "bad" }));
  assert.throws(() => spoolPending("crash-manifest_committed"), /checksum/);
  ok("legacy migration retains originals; truncated/corrupt frames block acknowledgment");
  const output: NormEvent = { producer_event_id: "tool:finished", kind: "tool.finished", payload: { _full: "result bytes" } };
  spoolAppend("artifact", { offset: 17, at: new Date().toISOString(), events: [output] });
  await assert.rejects(materializeArtifacts({} as any, "artifact", spoolPending("artifact").batches[0].events, async () => { throw new Error("transient"); }), /transient/);
  const retry = spoolPending("artifact").batches[0].events; assert.equal(retry[0].payload._full, "result bytes"); assert.equal(retry[0].payload.oversized, undefined);
  let stored = ""; await materializeArtifacts({} as any, "artifact", retry, async (_, a) => { stored = a.bytes.toString(); return { id: "artifact-id", existed: false }; });
  assert.equal(stored, "result bytes"); assert.equal(retry[0].payload.output_availability, "stored");
  ok("transient output storage failure retains exact retry bytes and never becomes oversize");
  const outputRoot = path.join(temp, "off-session", "tool-results"); fs.mkdirSync(outputRoot, { recursive: true });
  const offload = path.join(outputRoot, "offload.txt"); fs.writeFileSync(offload, "durable side file");
  const source = { transcriptFile: path.join(temp, "off-session.jsonl"), harness: "claude" as const };
  const off: NormEvent = { producer_event_id: "off", kind: "tool.finished", payload: { offloaded_path: offload } }; retainOffloadedOutputs([off], source); fs.unlinkSync(offload); assert.equal(off.payload._full, "durable side file");
  const privateFile = path.join(temp, "private-note.txt"); fs.writeFileSync(privateFile, "private unrelated plaintext");
  for (const candidate of [privateFile, path.join(outputRoot, "escape.txt")]) {
    if (candidate !== privateFile) fs.symlinkSync(privateFile, candidate);
    const rejected: NormEvent = { producer_event_id: "reject", kind: "tool.finished", payload: { offloaded_path: candidate } };
    retainOffloadedOutputs([rejected], source); assert.equal(rejected.payload._full, undefined); assert.equal(rejected.payload.output_availability, "unavailable");
  }
  ok("offloaded bytes retained locally before cursor advances");
  const transcripts = path.join(temp, "transcripts"); fs.mkdirSync(transcripts);
  const repo = path.join(temp, "repo"); fs.mkdirSync(repo); execFileSync("git", ["init", "-q", repo]);
  for (let s = 0; s < 2; s++) fs.writeFileSync(path.join(transcripts, `session-${s}.jsonl`), Array.from({ length: 250 }, (_, i) => JSON.stringify({ type: "user", sessionId: `session-${s}`, cwd: repo, timestamp: new Date().toISOString(), message: { role: "user", content: `message ${i}` } })).join("\n") + "\n");
  const parsed = streamTranscript(path.join(transcripts, "session-0.jsonl"), 0, "claude", [], { maxBytes: 4096, maxLines: 10 }); assert.ok(parsed.events.length <= 10); assert.ok(parsed.offset < fs.statSync(path.join(transcripts, "session-0.jsonl")).size);
  let queries = 0;
  const summary = await helperOnce({ author: "fixture", continuity: { database_url: "unused", machine: "fixture" } } as any, { roots: { claude: transcripts, codex: path.join(temp, "absent") }, pool: { query: async () => { queries++; assert.ok(spoolCursor("session-0")); assert.ok(spoolCursor("session-1")); throw new Error("offline fixture"); } } as any });
  assert.equal(queries, 1); assert.equal(summary.sessions, 2); assert.ok(summary.events_spooled > 0); assert.ok(summary.errors.some(e => e.includes("remote unavailable")));
  ok("all-session bounded local admission precedes DB access and outage fails once per pass");
  // A cwd transition always starts a separate permission-adjudicated chunk.
  const denied = path.join(temp, "denied"); fs.mkdirSync(denied); execFileSync("git", ["init", "-q", denied]);
  const switchFile = path.join(transcripts, "rollout-switch.jsonl");
  fs.writeFileSync(switchFile, [
    { type: "session_meta", payload: { id: "switch", cwd: repo } },
    { type: "event_msg", payload: { type: "user_message", message: "allowed first" } },
    { type: "turn_context", payload: { cwd: denied } },
    { type: "event_msg", payload: { type: "user_message", message: "FORBIDDEN TEXT" } },
    { type: "turn_context", payload: { cwd: repo } },
    { type: "event_msg", payload: { type: "user_message", message: "allowed again" } },
  ].map(v => JSON.stringify(v)).join("\n") + "\n");
  const cfg: any = { author: "fixture", continuity: { database_url: "unused", machine: "fixture", repos: [repo] } };
  process.env.LEDGER_CAPTURE_PAUSE_UPLOAD = "1";
  const noDb: any = { query: async () => { throw new Error("upload pause must not query"); } };
  for (let i = 0; i < 3; i++) await helperOnce(cfg, { roots: { claude: transcripts, codex: path.join(temp, "absent") }, pool: noDb });
  const captured = JSON.stringify(spoolPending("switch", 100).batches); assert.ok(captured.includes("allowed first")); assert.ok(captured.includes("allowed again")); assert.ok(!captured.includes("FORBIDDEN TEXT"));
  ok("A→forbidden B→A in one transcript never admits B; paused upload preserves local capture");
  fs.writeFileSync(path.join(transcripts, "session-0.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "rewritten shorter" } }) + "\n");
  const rotation = await helperOnce(cfg, { roots: { claude: transcripts, codex: path.join(temp, "absent") }, pool: noDb }); assert.ok(rotation.errors.some(e => /shrank|prefix changed/.test(e)));
  ok("source rewrite fails closed instead of deduplicating new content under old byte IDs");
  delete process.env.LEDGER_CAPTURE_PAUSE_UPLOAD;
  const release = acquireProcessLease(path.join(process.env.LEDGER_CONFIG_DIR!, "helper-pass.lock"));
  await assert.rejects(helperOnce(cfg, { roots: { claude: transcripts }, pool: noDb }), /lease busy/); release();
  const leaseFile = path.join(temp, "stale.lock"); fs.writeFileSync(leaseFile, JSON.stringify({ pid: 2147483647, token: "dead" })); const recovered = acquireProcessLease(leaseFile); assert.throws(() => acquireProcessLease(leaseFile), /lease busy/); recovered();
  fs.mkdirSync(leaseFile + ".guard"); assert.throws(() => acquireProcessLease(leaseFile), /interrupted/); fs.rmdirSync(leaseFile + ".guard");
  ok("whole-pass lease rejects overlap; stale reclaim serializes; interrupted guard fails closed");
  const oldBudget = process.env.LEDGER_SPOOL_MAX_BYTES; process.env.LEDGER_SPOOL_MAX_BYTES = "4096";
  const beforeCap = spoolCursor("many"); assert.throws(() => spoolAppend("many", batch(1000)), /budget exceeded/); assert.equal(spoolCursor("many"), beforeCap);
  if (oldBudget === undefined) delete process.env.LEDGER_SPOOL_MAX_BYTES; else process.env.LEDGER_SPOOL_MAX_BYTES = oldBudget;
  ok("retained acknowledged data consumes the disk cap; exhausted admission leaves cursor intact");
  console.log(`Capture durability: ${passed} groups passed (synthetic, no database/network).`);
} finally { await drainUsageWrites(); fs.rmSync(temp, { recursive: true, force: true }); }
