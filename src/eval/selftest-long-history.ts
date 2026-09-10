import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { batchHistory, measureHistory, verifyObservedHistory, LONG_BATCH_CHARS } from "./long-history.js";
import type { FixtureEvent, OriginRun } from "./types.js";

const event = (id: string, text: string): FixtureEvent => ({ id, text, session: "session-a", author: "rachit", topic: "mixed" });

// Both sources remain intact at the exact production capture boundary.
const sources = [event("a", "a".repeat(LONG_BATCH_CHARS - 3)), event("b", "b"), event("c", "c")];
const batches = batchHistory(sources);
assert.equal(batches.length, 2);
assert.equal(batches[0].text.length, LONG_BATCH_CHARS);
assert.deepEqual(batches.flatMap((batch) => batch.events.map((source) => source.id)), ["a", "b", "c"]);
assert.throws(() => batchHistory([event("a", "x".repeat(LONG_BATCH_CHARS + 1))]), /cannot fit/);
assert.throws(() => batchHistory([event("same", "one"), event("same", "two")]), /duplicate fixture/);

// A source absent from the actual normalized transcript must not be counted.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-long-history-unit-"));
try {
  const transcript = path.join(temp, "unit-transcript.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", timestamp: "2026-09-09T00:00:00Z", message: { role: "user", content: "First observed source.\n\nSecond observed source." } }) + "\n");
  const run: OriginRun = {
    harness: "claude", sessionIds: ["unit-session"], transcriptPaths: [transcript], totalInputTokens: 999_999_999, compactions: 0,
    turns: [{ harness: "claude", sessionId: "unit-session", transcriptPath: transcript, turnIndex: 0, fixtureEventId: "a", assistantText: "", wallMs: 0 }],
  };
  const observed = [event("a", "First observed source."), event("b", "Second observed source.")];
  assert.equal(verifyObservedHistory(observed, run).length, 2);
  assert.throws(() => verifyObservedHistory([...observed, event("missing", "This never reached the origin.")], run), /absent from the actual/);
  // Actual pinned tokenizer; enormous cumulative model input is deliberately irrelevant.
  const count = measureHistory(observed);
  const repeated = measureHistory(observed);
  assert.equal(count.measured_origin_tokens, count.events.reduce((sum, source) => sum + source.tokens, 0));
  assert.equal(count.measured_origin_tokens, repeated.measured_origin_tokens);
  assert.ok(count.measured_origin_tokens < 30);
  assert.equal(count.provider_tokenizer_verified, false);
  assert.equal(count.tokenizer_version, "0.12.0");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log("long-history selftest passed: source-preserving batches, missing-source rejection, pinned unique-source token measurement");
