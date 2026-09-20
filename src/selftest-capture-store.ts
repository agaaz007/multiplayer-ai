import assert from "node:assert/strict";
import crypto from "node:crypto";
import { assertSafeSelftestDatabase, assertSelftestDatabaseMarker } from "./selftest-db-guard.js";
import { getPool, migrate, closePools } from "./continuity/db.js";
import { appendEvents, upsertSession, sessionEvents, putArtifact } from "./continuity/store.js";
import type { NormEvent } from "./continuity/events.js";
const url = process.env.LEDGER_CONTINUITY_DB ?? ""; assertSafeSelftestDatabase(url);
const pool = getPool({ author: "fixture", continuity: { database_url: url } } as any);
try {
  await assertSelftestDatabaseMarker(pool); await migrate(pool);
  const id = `capture-store-${crypto.randomUUID()}`; await upsertSession(pool, { id, author: "fixture", harness: "codex" });
  const event = (n: number): NormEvent => ({ producer_event_id: `event-${n}`, kind: "assistant.message", payload: { n } });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => appendEvents(pool, id, [event(i * 2), event(i * 2), event(i * 2 + 1), event(0)], null, null)));
  assert.equal(results.reduce((n, r) => n + r.inserted, 0), 40);
  let rows = await sessionEvents(pool, id); assert.equal(rows.length, 40); assert.deepEqual(rows.map(r => r.seq), Array.from({ length: 40 }, (_, i) => i + 1)); assert.equal(new Set(rows.map(r => r.producer_event_id)).size, 40);
  const retry = await appendEvents(pool, id, Array.from({ length: 40 }, (_, i) => event(i)), null, null); assert.equal(retry.inserted, 0); assert.equal(retry.lastSeq, 40);
  console.log("ok 1. 20 concurrent batches dedupe duplicates in/among batches, retaining all fresh neighbors and consecutive sequences");
  const bad = event(42); (bad as any).kind = null;
  await assert.rejects(appendEvents(pool, id, [event(40), bad, event(41)], null, null));
  rows = await sessionEvents(pool, id); assert.equal(rows.length, 40);
  const recovery = await appendEvents(pool, id, [event(40), event(41), event(42)], null, null); assert.equal(recovery.lastSeq, 43); assert.equal(recovery.inserted, 3);
  console.log("ok 2. failed bulk statement rolls back every event and sequence; exact retry succeeds");
  const bytes = Buffer.from(`fixture artifact ${id}`), sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const artifacts = await Promise.all(Array.from({ length: 8 }, () => putArtifact(pool, { sha256, kind: "tool_output", bytes, session_id: id })));
  assert.equal(new Set(artifacts.map(a => a.id)).size, 1); assert.equal((await pool.query("select inline from cont_artifacts where sha256=$1", [sha256])).rows[0].inline.toString(), bytes.toString());
  console.log("ok 3. concurrent content-addressed artifact inserts converge on one exact retained body");
} finally { await closePools(); }
