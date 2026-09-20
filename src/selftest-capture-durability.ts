import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { spoolAppend, spoolPending, spoolAck, spoolCursor, spoolDir, spoolStatus } from "./helper/spool.js";
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
  const offload = path.join(temp, "offload.txt"); fs.writeFileSync(offload, "durable side file");
  const off: NormEvent = { producer_event_id: "off", kind: "tool.finished", payload: { offloaded_path: offload } }; retainOffloadedOutputs([off]); fs.unlinkSync(offload); assert.equal(off.payload._full, "durable side file");
  ok("offloaded bytes retained locally before cursor advances");
  const transcripts = path.join(temp, "transcripts"); fs.mkdirSync(transcripts);
  const repo = path.join(temp, "repo"); fs.mkdirSync(repo); execFileSync("git", ["init", "-q", repo]);
  for (let s = 0; s < 2; s++) fs.writeFileSync(path.join(transcripts, `session-${s}.jsonl`), Array.from({ length: 250 }, (_, i) => JSON.stringify({ type: "user", sessionId: `session-${s}`, cwd: repo, timestamp: new Date().toISOString(), message: { role: "user", content: `message ${i}` } })).join("\n") + "\n");
  const parsed = streamTranscript(path.join(transcripts, "session-0.jsonl"), 0, "claude", [], { maxBytes: 4096, maxLines: 10 }); assert.ok(parsed.events.length <= 10); assert.ok(parsed.offset < fs.statSync(path.join(transcripts, "session-0.jsonl")).size);
  let queries = 0;
  const summary = await helperOnce({ author: "fixture", continuity: { database_url: "unused", machine: "fixture" } } as any, { roots: { claude: transcripts, codex: path.join(temp, "absent") }, pool: { query: async () => { queries++; assert.ok(spoolCursor("session-0")); assert.ok(spoolCursor("session-1")); throw new Error("offline fixture"); } } as any });
  assert.equal(queries, 1); assert.equal(summary.sessions, 2); assert.ok(summary.events_spooled > 0); assert.ok(summary.errors.some(e => e.includes("remote unavailable")));
  ok("all-session bounded local admission precedes DB access and outage fails once per pass");
  console.log(`Capture durability: ${passed} groups passed (synthetic, no database/network).`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
