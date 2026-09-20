import { assertSafeSelftestDatabase, assertSelftestDatabaseMarker } from "./selftest-db-guard.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Optional event embeddings (pgvector). Needs a Postgres with the vector extension available:
 * LEDGER_CONTINUITY_DB, default postgresql://localhost:5432/ledger_selftest. Drops and recreates
 * every cont_* table there and removes the embedding tables again at the end, so the other
 * continuity selftests see the schema they expect. No network: the provider is a deterministic
 * fake (synonym-normalised hashed bag of words projected to 8 dimensions) injected with
 * setEmbedProvider.
 *
 * Covers: migrate without embeddings is unchanged; migrate with embeddings installs the extension,
 * both tables and the HNSW index, idempotently; helper-style batch embedding; vectorCandidates puts
 * the semantically nearest event first for a paraphrase the lexical search misses; every filter
 * (repo, session, record, kinds, sinceHours, asOf); [] when unconfigured, when the key is missing
 * and when the provider is down (logged once); permanent failures recorded and skipped; dimension
 * and model mismatches refused with drop + backfill instructions; the daemon embeds what it uploads.
 */

const DB = process.env.LEDGER_CONTINUITY_DB || "postgresql://localhost:5432/ledger_selftest";
assertSafeSelftestDatabase(DB);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-emb-"));
process.env.LEDGER_CONFIG_DIR = path.join(tmp, ".ledger");
process.env.LEDGER_GIT_SYNC = "0";
process.env.LEDGER_SELFTEST = "1";
delete process.env.LEDGER_EMB_TEST_NO_KEY;

const { getPool, migrate, closePools, tableList } = await import("./continuity/db.js");
const S = await import("./continuity/store.js");
const R = await import("./continuity/records.js");
const E = await import("./continuity/embeddings.js");
const { helperOnce } = await import("./helper/daemon.js");
type Config = import("./store.js").Config;
type NormEvent = import("./continuity/events.js").NormEvent;
type EmbedFn = import("./continuity/embeddings.js").EmbedFn;

let step = 0;
const ok = (msg: string) => console.log(`  ok ${++step}. ${msg}`);
const T = (min: number) => new Date(Date.UTC(2026, 8, 8, 2, min, 0));
const iso = (min: number) => T(min).toISOString();
const cl = (o: unknown) => JSON.stringify(o);

// ---------- fake provider: deterministic, semantic through a synonym table ----------
const DIMS = 8;
const SYN: Record<string, string> = {
  purchases: "checkout", purchase: "checkout", payment: "checkout", payments: "checkout", buying: "checkout", order: "checkout",
  slow: "latency", slowness: "latency", sluggish: "latency", delay: "latency", delays: "latency", lag: "latency",
  spiked: "spike", spikes: "spike", jump: "spike", jumped: "spike", increase: "spike",
  greeting: "banner", header: "banner", welcome: "banner",
  grow: "grew", growth: "grew", growing: "grew",
};
const STOP = new Set(["the", "and", "why", "did", "get", "got", "for", "with", "that", "this", "was", "were", "have", "has", "not", "now", "yesterday", "please", "message", "assistant", "instruction", "added", "tool", "finished", "compaction"]);
const tokVec = new Map<string, number[]>();
function tokenVector(tok: string): number[] {
  let v = tokVec.get(tok);
  if (!v) {
    const h = crypto.createHash("sha256").update(tok).digest();
    v = Array.from({ length: DIMS }, (_, i) => h[i] / 127.5 - 1);
    tokVec.set(tok, v);
  }
  return v;
}
function fakeVector(text: string): number[] {
  const toks = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t)).map((t) => SYN[t] ?? t);
  const v = new Array(DIMS).fill(0);
  for (const t of toks) { const tv = tokenVector(t); for (let i = 0; i < DIMS; i++) v[i] += tv[i]; }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const providerCalls: string[][] = [];
let transientDown = false;
const fake: EmbedFn = async (inputs) => {
  providerCalls.push(inputs);
  if (transientDown) throw new E.EmbedError("HTTP 503 upstream", { permanent: false, status: 503 });
  for (const t of inputs) if (t.includes("POISON")) throw new E.EmbedError("HTTP 400 input rejected", { permanent: true, status: 400 });
  return inputs.map(fakeVector);
};
E.setEmbedProvider(fake);
const logged: string[] = [];
E.setEmbedLog((s) => logged.push(s));

// ---------- configs ----------
const base: Config = { ledger_dir: path.join(tmp, "ledger"), author: "rachit", git_sync: false, continuity: { database_url: DB, machine: "test-mac" } };
const cfgE: Config = { ...base, continuity: { ...base.continuity!, embeddings: { provider: "openai", model: "fake-bow-8", dimensions: DIMS, kinds: ["instruction.added", "assistant.message", "compaction", "tool.finished"], max_chars: 200 } } };
const pool = getPool(base);

// ---------- 1. schema ----------
await assertSelftestDatabaseMarker(pool);
await pool.query(`drop table if exists cont_event_embeddings, cont_embedding_failures, cont_state_updates, cont_record_links, cont_records, cont_notifications, cont_artifacts, cont_claims, cont_checkpoints, cont_events, cont_sessions, cont_threads cascade`);
E.resetEmbedSchemaCache(pool);
assert.equal(E.embeddingsConfigured(base), false);
assert.equal(E.embeddingsConfigured(cfgE), true);
const plain = await migrate(pool);
assert.ok(plain.includes("cont_events") && !plain.includes("cont_event_embeddings"), `plain migrate creates the base schema only: ${plain.join(",")}`);
assert.deepEqual(await migrate(pool, base), [], "migrate with a config without embeddings creates nothing more");
assert.ok(!(await tableList(pool)).includes("cont_event_embeddings"));
const withEmb = await migrate(pool, cfgE);
assert.deepEqual(withEmb.sort(), ["cont_embedding_failures", "cont_event_embeddings"], `embedding tables created: ${withEmb.join(",")}`);
assert.deepEqual(await migrate(pool, cfgE), [], "second migrate with embeddings is idempotent");
const ext = (await pool.query<{ extversion: string }>(`select extversion from pg_extension where extname = 'vector'`)).rows[0];
assert.ok(ext?.extversion, "vector extension installed");
const idx = (await pool.query<{ indexdef: string }>(`select indexdef from pg_indexes where tablename = 'cont_event_embeddings' and indexname = 'cont_event_embeddings_hnsw_idx'`)).rows[0];
assert.match(idx?.indexdef ?? "", /USING hnsw .*vector_cosine_ops/, `HNSW cosine index: ${idx?.indexdef}`);
const typmod = (await pool.query<{ t: number }>(`select atttypmod::int as t from pg_attribute where attrelid = 'cont_event_embeddings'::regclass and attname = 'embedding'`)).rows[0].t;
assert.equal(typmod, DIMS, "vector column width matches the configured dimensions");
ok(`migrate: unchanged without embeddings; with embeddings installs vector ${ext.extversion}, cont_event_embeddings(vector(${DIMS})) + HNSW cosine index, cont_embedding_failures, idempotently`);

// ---------- 2. unconfigured paths ----------
assert.deepEqual(await E.vectorCandidates(pool, base, "anything", {}, 5), [], "[] when embeddings are not configured");
{
  const st = await E.embeddingStatus(pool, base);
  assert.equal(st.configured, false);
  assert.ok(st.extension.installed, "status reports the extension even when unconfigured");
}
ok("unconfigured: vectorCandidates returns [], status says configured: no");

// ---------- fixtures: two repos, three sessions, real seqs via appendEvents ----------
const REPO = "github.com/tranzmit/demo";
const SITE = "github.com/tranzmit/site";
const sidR = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee"; // rachit, demo
const sidA = "agaaz-claude-emb-1";                   // agaaz, demo
const sidU = "rachit-codex-site-1";                  // rachit, site
await S.upsertSession(pool, { id: sidR, author: "rachit", harness: "codex", machine: "rachit-mac", repo: REPO, branch: "master", started_at: T(0), last_seen_at: T(10) });
await S.upsertSession(pool, { id: sidA, author: "agaaz", harness: "claude", machine: "agaaz-mac", repo: REPO, branch: "master", started_at: T(60), last_seen_at: T(65) });
await S.upsertSession(pool, { id: sidU, author: "rachit", harness: "codex", machine: "rachit-mac", repo: SITE, branch: "main", started_at: T(100), last_seen_at: T(110) });

const evR: NormEvent[] = [
  { producer_event_id: "r1", kind: "instruction.added", occurred_at: iso(0), payload: { text: "Add a greeting banner to the app; keep the price unchanged." } },
  { producer_event_id: "r2:requested", kind: "tool.requested", call_id: "r2", occurred_at: iso(1), payload: { tool: "exec", input: "npm test" } },
  { producer_event_id: "r2:finished", kind: "tool.finished", call_id: "r2", occurred_at: iso(2), payload: { tool: "exec", output_preview: "1 failing: banner visible on small viewport" } },
  { producer_event_id: "r4", kind: "assistant.message", occurred_at: iso(3), payload: { text: "Banner added. Test fails on small viewport; next I will check the CTA at 360px." } },
  { producer_event_id: "r5", kind: "instruction.added", occurred_at: iso(4), payload: { text: "Now investigate why checkout latency spiked yesterday" } },
  { producer_event_id: "r6:requested", kind: "tool.requested", call_id: "r6", occurred_at: iso(5), payload: { tool: "exec", input: "psql -c \"select p95 from checkout_latency where day = '2026-09-07'\"" } },
  { producer_event_id: "r6:finished", kind: "tool.finished", call_id: "r6", occurred_at: iso(6), payload: { tool: "exec", output_preview: "p95 | 2140ms" } },
  { producer_event_id: "r8", kind: "assistant.message", occurred_at: iso(7), payload: { text: "Latency spike correlates with the cache flush at 02:00." } },
  { producer_event_id: "r9", kind: "file.changed", occurred_at: iso(8), payload: { path: "src/cache.ts", status: "M" } },
  { producer_event_id: "r10", kind: "compaction", occurred_at: iso(9), payload: { text: "Summary: banner shipped; latency investigation ongoing, cache flush suspected." } },
  { producer_event_id: "r11", kind: "assistant.message", occurred_at: iso(10), payload: { text: "   " } }, // whitespace only: never embeddable
];
const evA: NormEvent[] = [
  { producer_event_id: "a1", kind: "instruction.added", occurred_at: iso(60), payload: { text: "Write the release notes for the mobile app" } },
  { producer_event_id: "a2", kind: "assistant.message", occurred_at: iso(61), payload: { text: "Release notes drafted; POISON marker for the provider test." } },
  { producer_event_id: "a3", kind: "assistant.message", occurred_at: iso(62), payload: { text: "The checkout delay came from the payment gateway retrying." } },
];
const evU: NormEvent[] = [
  { producer_event_id: "u1", kind: "instruction.added", occurred_at: iso(100), payload: { text: "Fix the newsletter signup form validation" } },
  { producer_event_id: "u2", kind: "assistant.message", occurred_at: iso(101), payload: { text: "Purchases were slow because the payment webhook timed out." } },
];
await S.appendEvents(pool, sidR, evR, null, null);
await S.appendEvents(pool, sidA, evA, null, null);
await S.appendEvents(pool, sidU, evU, null, null);
const idOf = async (sid: string, pid: string) => Number((await pool.query<{ id: string }>(`select id::text as id from cont_events where session_id = $1 and producer_event_id = $2`, [sid, pid])).rows[0].id);
const seqOf = async (sid: string, pid: string) => (await pool.query<{ seq: number }>(`select seq from cont_events where session_id = $1 and producer_event_id = $2`, [sid, pid])).rows[0].seq;
const idCheckoutInstr = await idOf(sidR, "r5");
const idLatencyMsg = await idOf(sidR, "r8");
const idPoison = await idOf(sidA, "a2");
const idBlank = await idOf(sidR, "r11");
const idGateway = await idOf(sidA, "a3");
const idWebhook = await idOf(sidU, "u2");
ok("fixtures: 16 events in 3 sessions across 2 repos, including a whitespace-only message and a POISON message");

// ---------- 3. helper-style batch embedding with failures ----------
{
  // eligible = configured kinds with non-empty text: r1 r2:finished r4 r5 r6:finished r8 r10 (7) + a1 a2 a3 (3) + u1 u2 (2) = 12; a2 fails permanently
  const st0 = await E.embeddingStatus(pool, cfgE);
  assert.equal(st0.eligible, 12, `eligible before: ${st0.eligible}`);
  assert.equal(st0.pending, 12);
  assert.ok(st0.pending_chars > 0 && st0.estimated_tokens === Math.ceil(st0.pending_chars / 4));
  assert.equal(st0.estimated_usd, null, "unknown fake model has no price");
  assert.equal(E.costUsd("text-embedding-3-small", 10_000_000), 0.2, "10M tokens on text-embedding-3-small ≈ USD 0.20");
  providerCalls.length = 0;
  const r = await E.embedPendingEvents(pool, cfgE, { limit: 1000, log: (s) => logged.push(s) });
  assert.equal(r.embedded, 11, `embedded: ${JSON.stringify(r)}`);
  assert.equal(r.failed, 1, "the POISON event is a recorded failure");
  assert.equal(r.stopped_early, false);
  assert.equal(r.remaining, 0);
  // one batch for 12 inputs, then 12 single retries to isolate the bad one
  assert.equal(providerCalls[0].length, 12, "one batched provider call for all pending events");
  assert.ok(providerCalls.slice(1).every((c) => c.length === 1) && providerCalls.length === 13, `permanent batch error isolated per input: ${providerCalls.map((c) => c.length).join(",")}`);
  const stored = (await pool.query<{ event_id: string; model: string; dims: number }>(`select event_id::text as event_id, model, dims from cont_event_embeddings order by event_id`)).rows;
  assert.equal(stored.length, 11);
  assert.ok(stored.every((s) => s.model === "fake-bow-8" && s.dims === DIMS));
  assert.ok(!stored.some((s) => Number(s.event_id) === idBlank), "whitespace-only event never selected");
  const fails = (await pool.query<{ event_id: string; error: string }>(`select event_id::text as event_id, error from cont_embedding_failures`)).rows;
  assert.deepEqual(fails.map((f) => Number(f.event_id)), [idPoison]);
  assert.match(fails[0].error, /400 input rejected/);
  // the text sent carries the kind and tool prefix, clipped to max_chars
  const sent = providerCalls[0];
  assert.ok(sent.some((t) => t.startsWith("tool.finished exec: 1 failing")), `kind + tool prefix: ${sent.find((t) => t.startsWith("tool."))}`);
  assert.ok(sent.some((t) => t === "instruction.added: Now investigate why checkout latency spiked yesterday"));
  assert.ok(sent.every((t) => t.length <= 200 + 40));
  assert.equal(E.eventText("assistant.message", { text: "x".repeat(500) }, 100)!.length, "assistant.message: ".length + 100, "clipped to max_chars");
  assert.equal(E.eventText("assistant.message", { text: "", input: "fallback" }, 100), "assistant.message: fallback", "empty text falls through to input like JS ||");
  assert.equal(E.eventText("assistant.message", {}, 100), null);

  // second run: nothing pending, the failure is skipped, no provider call
  providerCalls.length = 0;
  const r2 = await E.embedPendingEvents(pool, cfgE, { limit: 1000 });
  assert.equal(r2.embedded + r2.failed, 0);
  assert.equal(providerCalls.length, 0, "failed event is not retried and nothing else is pending");
  const st1 = await E.embeddingStatus(pool, cfgE);
  assert.equal(st1.embedded, 11); assert.equal(st1.failures, 1); assert.equal(st1.pending, 0); assert.equal(st1.eligible, 12);
  assert.equal(st1.table_exists, true); assert.equal(st1.stored_dims, DIMS); assert.equal(st1.dims_match, true);
  assert.deepEqual(st1.stored_models, ["fake-bow-8"]);
  assert.ok(!JSON.stringify(st1).includes("sk-"), "status never carries a key");
  ok("batch embedding: 11 stored with kind/tool prefix and clipping, POISON recorded in cont_embedding_failures and skipped next run, blank text never selected, status counts agree");
}

// ---------- 4. paraphrase: nearest first where the lexical search misses ----------
{
  const q = "why did purchases get slow";
  const lexical = await R.searchEvents(pool, q, {});
  assert.equal(lexical.length, 0, `full-text search misses the paraphrase: ${lexical.map((e) => e.payload?.text).join(" | ")}`);
  providerCalls.length = 0;
  const c = await E.vectorCandidates(pool, cfgE, q, {}, 5);
  assert.equal(providerCalls.length, 1, "the query is embedded with one provider call");
  assert.deepEqual(providerCalls[0], [q]);
  assert.ok(c.length === 5, `k respected: ${c.length}`);
  assert.equal(c[0].event_id, idCheckoutInstr, `nearest is the checkout-latency instruction: ${JSON.stringify(c)}`);
  assert.ok(c[0].score > c[1].score && c[0].score <= 1.0001 && c[0].score > 0, `scores descend, cosine: ${JSON.stringify(c)}`);
  for (let i = 1; i < c.length; i++) assert.ok(c[i - 1].score >= c[i].score);
  assert.ok(Number.isInteger(c[0].event_id));
  ok(`paraphrase "${q}": FTS returns 0, vectorCandidates puts the checkout-latency instruction first (score ${c[0].score.toFixed(3)})`);
}

// ---------- 5. filters mirror records.ts searchEvents; asOf bounds time from above ----------
{
  const q = "why did purchases get slow";
  const ids = (r: { event_id: number }[]) => r.map((x) => x.event_id);
  const byKind = await E.vectorCandidates(pool, cfgE, q, { kinds: ["assistant.message"] }, 3);
  assert.ok(byKind.length === 3 && byKind.every((x) => [idLatencyMsg, idGateway, idWebhook].includes(x.event_id) || true));
  const kindsOf = (await pool.query<{ kind: string }>(`select kind from cont_events where id = any($1)`, [ids(byKind)])).rows.map((r) => r.kind);
  assert.ok(kindsOf.every((k) => k === "assistant.message"), `kinds filter: ${kindsOf.join(",")}`);

  const site = await E.vectorCandidates(pool, cfgE, q, { repo: SITE }, 10);
  assert.deepEqual(ids(site).sort(), [await idOf(sidU, "u1"), idWebhook].sort(), "repo filter restricts to the site sessions");
  assert.equal(site[0].event_id, idWebhook, "within the site repo the webhook message is nearest");
  assert.deepEqual(await E.vectorCandidates(pool, cfgE, q, { repo: null }, 10), [], "repo: null means sessions without a repo; none here");

  const bySession = await E.vectorCandidates(pool, cfgE, q, { session_id: sidA }, 10);
  assert.deepEqual(ids(bySession).sort(), [await idOf(sidA, "a1"), idGateway].sort(), "session filter (POISON event has no vector)");
  const byPrefix = await E.vectorCandidates(pool, cfgE, q, { session_id: sidR.slice(0, 8) }, 10);
  assert.equal(byPrefix.length, 7, "8-char session prefix resolves like searchEvents");
  assert.deepEqual(await E.vectorCandidates(pool, cfgE, q, { session_id: "no-such-session-anywhere" }, 10), [], "unknown session: []");

  // record filter: a record whose span covers r5..r8 in rachit's session only
  const rec = await R.createRecord(pool, { kind: "investigation", title: "checkout latency", created_by: "rachit", repo: REPO });
  await R.linkSpan(pool, { record_id: rec.id, session_id: sidR, from_seq: await seqOf(sidR, "r5"), to_seq: await seqOf(sidR, "r8"), source: "explicit", created_by: "rachit" });
  const byRecord = await E.vectorCandidates(pool, cfgE, q, { record_id: rec.id }, 10);
  assert.deepEqual(ids(byRecord).sort(), [idCheckoutInstr, await idOf(sidR, "r6:finished"), idLatencyMsg].sort(), `record span r5..r8 (tool.requested is not embedded): ${JSON.stringify(byRecord)}`);
  assert.equal(byRecord[0].event_id, idCheckoutInstr);
  assert.deepEqual(await E.vectorCandidates(pool, cfgE, q, { record_id: "not-a-uuid" }, 10), [], "non-uuid record id: []");

  // time: fixtures are dated 2026-09-08; sinceHours 1 excludes them, a wide window includes them
  assert.deepEqual(await E.vectorCandidates(pool, cfgE, q, { sinceHours: 1 }, 10), []);
  assert.equal((await E.vectorCandidates(pool, cfgE, q, { sinceHours: 24 * 365 * 5 }, 20)).length, 11);
  assert.deepEqual(await E.vectorCandidates(pool, cfgE, q, { sinceHours: -3 }, 10), [], "invalid sinceHours: [] not throw");
  const asOf = await E.vectorCandidates(pool, cfgE, q, { asOf: iso(4) }, 20);
  assert.deepEqual(ids(asOf).sort(), [await idOf(sidR, "r1"), await idOf(sidR, "r2:finished"), await idOf(sidR, "r4"), idCheckoutInstr].sort(), `asOf T+4 keeps events at or before it: ${JSON.stringify(asOf)}`);
  assert.equal(asOf[0].event_id, idCheckoutInstr);
  assert.deepEqual(await E.vectorCandidates(pool, cfgE, q, { asOf: "garbage" }, 20), []);
  assert.deepEqual(await E.vectorCandidates(pool, cfgE, "   ", {}, 5), [], "blank query: []");
  assert.deepEqual(await E.vectorCandidates(pool, cfgE, q, {}, 0), [], "k=0: []");
  const combined = await E.vectorCandidates(pool, cfgE, q, { repo: REPO, kinds: ["assistant.message"], asOf: iso(70), sinceHours: 24 * 365 * 5 }, 10);
  assert.deepEqual(ids(combined).sort(), [await idOf(sidR, "r4"), idLatencyMsg, idGateway].sort(), "filters AND-intersect");
  ok("filters: kinds, repo (incl. null), session (exact + prefix, unknown → []), record span, sinceHours, asOf, combinations; bad inputs return [] without throwing");
}

// ---------- 6. failures never throw into the search path; logged once ----------
{
  logged.length = 0;
  E.resetEmbedWarnings();
  transientDown = true;
  const a = await E.vectorCandidates(pool, cfgE, "anything", {}, 5);
  const b = await E.vectorCandidates(pool, cfgE, "anything else", {}, 5);
  assert.deepEqual(a, []); assert.deepEqual(b, []);
  assert.equal(logged.filter((l) => /candidates unavailable/.test(l)).length, 1, `provider outage logged once: ${logged.join(" | ")}`);
  // a transient failure during batch embedding records nothing as failed
  await S.appendEvents(pool, sidU, [{ producer_event_id: "u3", kind: "assistant.message", occurred_at: iso(102), payload: { text: "Signup form validation fixed." } }], null, null);
  const r = await E.embedPendingEvents(pool, cfgE, { limit: 100, log: (s) => logged.push(s) });
  assert.equal(r.embedded, 0); assert.equal(r.failed, 0); assert.equal(r.stopped_early, true); assert.match(r.error ?? "", /503/);
  assert.equal((await pool.query(`select count(*)::int as n from cont_embedding_failures`)).rows[0].n, 1, "transient error adds no failure rows");
  transientDown = false;
  const r2 = await E.embedPendingEvents(pool, cfgE, { limit: 100 });
  assert.equal(r2.embedded, 1, "retried on the next run once the provider is back");

  // the real provider with no key: [] and no network
  E.setEmbedProvider(null);
  const cfgNoKey: Config = { ...cfgE, continuity: { ...cfgE.continuity!, embeddings: { ...cfgE.continuity!.embeddings!, api_key_env: "LEDGER_EMB_TEST_NO_KEY" } } };
  assert.equal(E.embeddingSettings(cfgNoKey)!.api_key_present, false);
  logged.length = 0; E.resetEmbedWarnings();
  assert.deepEqual(await E.vectorCandidates(pool, cfgNoKey, "anything", {}, 5), []);
  assert.deepEqual(await E.vectorCandidates(pool, cfgNoKey, "anything", {}, 5), []);
  assert.equal(logged.length, 1); assert.match(logged[0], /no API key: set LEDGER_EMB_TEST_NO_KEY/);
  E.setEmbedProvider(fake);

  // time cap: a deadline of 0 ms lets no batch start
  await S.appendEvents(pool, sidU, [{ producer_event_id: "u4", kind: "assistant.message", occurred_at: iso(103), payload: { text: "Deploying the form fix." } }], null, null);
  const capped = await E.embedPendingEvents(pool, cfgE, { limit: 100, deadlineMs: -1 });
  assert.equal(capped.embedded, 0); assert.equal(capped.stopped_early, true);
  assert.equal((await E.embedPendingEvents(pool, cfgE, { limit: 100 })).embedded, 1);
  ok("provider down → [] logged once, transient batch errors record no failures and retry later; missing key → [] logged once, no network; time cap stops before a batch");
}

// ---------- 7. dimension / model mismatch refused ----------
{
  const cfg16: Config = { ...cfgE, continuity: { ...cfgE.continuity!, embeddings: { ...cfgE.continuity!.embeddings!, dimensions: 16 } } };
  await assert.rejects(migrate(pool, cfg16), (e: any) => /vector\(8\)/.test(e.message) && /dimensions is 16/.test(e.message) && /drop table cont_event_embeddings/.test(e.message) && /embed --backfill/.test(e.message));
  const cfgModel: Config = { ...cfgE, continuity: { ...cfgE.continuity!, embeddings: { ...cfgE.continuity!.embeddings!, model: "fake-other" } } };
  await assert.rejects(migrate(pool, cfgModel), /stored vectors come from model fake-bow-8 but continuity.embeddings.model is fake-other/);
  const cfgBig: Config = { ...cfgE, continuity: { ...cfgE.continuity!, embeddings: { ...cfgE.continuity!.embeddings!, dimensions: 3072 } } };
  await assert.rejects(migrate(pool, cfgBig), /exceeds the HNSW limit of 2000/);
  assert.equal((await pool.query(`select count(*)::int as n from cont_event_embeddings`)).rows[0].n, 13, "nothing dropped by a refused migrate");
  // querying with a mismatched width does not throw either
  E.resetEmbedWarnings();
  const otherPool = getPool({ ...base, continuity: { ...base.continuity!, database_url: DB + (DB.includes("?") ? "&" : "?") + "application_name=emb16" } });
  assert.deepEqual(await E.vectorCandidates(otherPool, cfg16, "anything", {}, 5), [], "width mismatch on the query path: []");
  const st = await E.embeddingStatus(pool, cfg16);
  assert.equal(st.dims_match, false);
  ok("mismatch: migrate refuses a different width or model with drop + backfill instructions and changes nothing; the query path returns []");
}

// ---------- 8. the daemon embeds what it uploads ----------
{
  const roots = { claude: path.join(tmp, "claude-empty"), codex: path.join(tmp, "codex") };
  fs.mkdirSync(roots.claude, { recursive: true });
  const day = path.join(roots.codex, "2026", "09", "08");
  fs.mkdirSync(day, { recursive: true });
  const cwd = path.join(tmp, "notes"); // not a git repo: events only, no thread or snapshot
  fs.mkdirSync(cwd, { recursive: true });
  const sidH = "0199aaaa-0000-7000-8000-00000000e001";
  const f = path.join(day, `rollout-2026-09-08T03-00-00-${sidH}.jsonl`);
  const at = (min: number) => T(min).toISOString();
  fs.writeFileSync(f, [
    cl({ timestamp: at(120), type: "session_meta", payload: { id: sidH, cwd } }),
    cl({ timestamp: at(121), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Summarise the quarterly revenue numbers" }] } }),
    cl({ timestamp: at(122), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Revenue grew 12% quarter over quarter, driven by annual plans." }] } }),
  ].join("\n") + "\n");
  fs.utimesSync(f, T(122), T(122));
  const lines: string[] = [];
  providerCalls.length = 0;
  const sum = await helperOnce(cfgE, { roots, now: T(123), push: false, log: (l) => lines.push(l) });
  assert.equal(sum.errors.length, 0, sum.errors.join(" | "));
  assert.equal(sum.events_uploaded, 3, "session.started + instruction + assistant message");
  assert.ok(lines.some((l) => /^embedded 2 events/.test(l)), `helper logs the embed step: ${lines.join(" | ")}`);
  assert.equal(providerCalls.length, 1, "one batched provider call per pass");
  const n = (await pool.query<{ n: number }>(`select count(*)::int as n from cont_event_embeddings e join cont_events ev on ev.id = e.event_id where ev.session_id = $1`, [sidH])).rows[0].n;
  assert.equal(n, 2, "both uploaded events of the configured kinds have vectors");
  const found = await E.vectorCandidates(pool, cfgE, "revenue growth quarter over quarter", { session_id: sidH }, 1);
  const idRevenue = Number((await pool.query<{ id: string }>(`select id::text as id from cont_events where session_id = $1 and kind = 'assistant.message'`, [sidH])).rows[0].id);
  assert.equal(found[0]?.event_id, idRevenue, "the helper-embedded assistant message is found by a paraphrase");
  // a pass with nothing new does not call the provider; a helper without embeddings config never does
  providerCalls.length = 0; lines.length = 0;
  await helperOnce(cfgE, { roots, now: T(124), push: false, log: (l) => lines.push(l) });
  assert.equal(providerCalls.length, 0);
  assert.ok(!lines.some((l) => /^embedded/.test(l)));
  fs.appendFileSync(f, cl({ timestamp: at(125), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Churn was flat." }] } }) + "\n");
  fs.utimesSync(f, T(125), T(125));
  await helperOnce(base, { roots, now: T(126), push: false, log: (l) => lines.push(l) });
  assert.equal(providerCalls.length, 0, "no embeddings config: the helper never calls a provider");
  assert.equal((await pool.query<{ n: number }>(`select count(*)::int as n from cont_events ev left join cont_event_embeddings e on e.event_id = ev.id where ev.session_id = $1 and ev.kind = 'assistant.message' and e.event_id is null`, [sidH])).rows[0].n, 1, "the new event stays pending for a backfill");
  ok("daemon: a pass embeds the events it uploaded in one batch and logs 'embedded N events'; quiet passes and unconfigured helpers call no provider");
}

// ---------- 9. cascade + cleanup ----------
{
  const before = (await pool.query(`select count(*)::int as n from cont_event_embeddings`)).rows[0].n;
  await pool.query(`delete from cont_events where session_id = $1`, [sidU]);
  const after = (await pool.query(`select count(*)::int as n from cont_event_embeddings`)).rows[0].n;
  assert.equal(before - after, 4, "deleting events cascades to their vectors");
  ok("on delete cascade from cont_events");
}

// leave the shared test database as the other continuity selftests expect it
await pool.query(`drop table if exists cont_event_embeddings, cont_embedding_failures`);
await closePools();
console.log(`selftest-embeddings: ok (${step} checks) — tmp ${tmp}`);
