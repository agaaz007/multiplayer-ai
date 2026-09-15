import type pg from "pg";
import type { Config, EmbeddingsConfig } from "../store.js";
import { resolveSessionId } from "./evidence.js";

/**
 * Optional event embeddings over pgvector.
 *
 * Embeddings are a CANDIDATE GENERATOR only: `vectorCandidates` returns event ids with a cosine
 * score for the authority ranking to re-order and filter. Nothing here decides which version of
 * a fact is true, and nothing here throws into a caller's search path: when embeddings are not
 * configured, the extension is missing, the schema is absent or the provider fails, the query
 * functions return [] and the failure is logged once per process, not on every call.
 *
 * Off entirely unless `continuity.embeddings` exists in the config. The provider is OpenAI's
 * embeddings REST endpoint over plain fetch (no SDK), batched 64 inputs per request, retried with
 * backoff on 429/5xx, with a hard per-request timeout. Tests inject a deterministic provider with
 * `setEmbedProvider`.
 *
 * Tables (created by `migrate(pool, cfg)` only when configured):
 *   cont_event_embeddings(event_id pk → cont_events on delete cascade, model, dims, embedding vector(dims), created_at)
 *   cont_embedding_failures(event_id pk, error, at)   events that failed permanently; skipped on later passes
 */

export type EmbedFn = (inputs: string[]) => Promise<number[][]>;

export interface ResolvedEmbeddings {
  provider: "openai";
  model: string;
  dimensions: number;
  api_key_env: string;
  /** whether a key is available (literal or env); never the key itself */
  api_key_present: boolean;
  kinds: string[];
  max_chars: number;
}

export const EMBED_DEFAULTS = {
  model: "text-embedding-3-small",
  dimensions: 1536,
  api_key_env: "OPENAI_API_KEY",
  kinds: ["instruction.added", "assistant.message", "compaction", "tool.finished"],
  max_chars: 4000,
} as const;

/** Inputs per provider request. OpenAI accepts 2048; 64 keeps a request under the per-request token cap at max_chars. */
export const EMBED_BATCH = 64;
/** pgvector's HNSW index supports vectors up to this many dimensions. */
export const HNSW_MAX_DIMS = 2000;
/** USD per 1M input tokens, for the CLI estimate only. Unknown models print tokens without a price. */
const PRICE_PER_M_TOKENS: Record<string, number> = { "text-embedding-3-small": 0.02, "text-embedding-3-large": 0.13, "text-embedding-ada-002": 0.1 };

export class EmbedError extends Error {
  /** true when retrying the same input cannot succeed (bad request, no key); such events are recorded in cont_embedding_failures */
  permanent: boolean;
  status?: number;
  constructor(message: string, opts: { permanent: boolean; status?: number }) {
    super(message);
    this.name = "EmbedError";
    this.permanent = opts.permanent;
    this.status = opts.status;
  }
}

// ---------- config ----------

export function embeddingsConfigured(cfg: Config): boolean {
  return cfg.continuity?.embeddings?.provider === "openai";
}

function apiKeyFor(e: EmbeddingsConfig): string | undefined {
  return e.api_key || process.env[e.api_key_env || EMBED_DEFAULTS.api_key_env] || undefined;
}

export function embeddingSettings(cfg: Config): ResolvedEmbeddings | null {
  const e = cfg.continuity?.embeddings;
  if (!e || e.provider !== "openai") return null;
  const dimensions = Number(e.dimensions ?? EMBED_DEFAULTS.dimensions);
  if (!Number.isInteger(dimensions) || dimensions < 1) throw new Error(`continuity.embeddings.dimensions must be a positive integer, got ${String(e.dimensions)}`);
  const max_chars = Number(e.max_chars ?? EMBED_DEFAULTS.max_chars);
  return {
    provider: "openai",
    model: e.model || EMBED_DEFAULTS.model,
    dimensions,
    api_key_env: e.api_key_env || EMBED_DEFAULTS.api_key_env,
    api_key_present: Boolean(apiKeyFor(e)),
    kinds: e.kinds?.length ? e.kinds : [...EMBED_DEFAULTS.kinds],
    max_chars: Number.isFinite(max_chars) && max_chars > 0 ? Math.floor(max_chars) : EMBED_DEFAULTS.max_chars,
  };
}

// ---------- logging: once per key per process ----------

const warned = new Set<string>();
let defaultLog: (s: string) => void = (s) => process.stderr.write(`${s}\n`);
/** Where log-once messages from `vectorCandidates` go (the helper passes its own log through opts; the MCP server defaults to stderr). */
export function setEmbedLog(log: ((s: string) => void) | null): void {
  defaultLog = log ?? ((s) => process.stderr.write(`${s}\n`));
}
function warnOnce(key: string, msg: string, log: (s: string) => void = defaultLog): void {
  if (warned.has(key)) return;
  warned.add(key);
  log(`embeddings: ${msg}`);
}
/** Tests: forget which warnings were printed. */
export function resetEmbedWarnings(): void { warned.clear(); }

// ---------- provider ----------

let override: EmbedFn | null = null;
/** Tests inject a deterministic provider; null restores the configured one. */
export function setEmbedProvider(fn: EmbedFn | null): void { override = fn; }

const errText = (e: any) => String(e?.message ?? e).slice(0, 300);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One OpenAI embeddings request for ≤ EMBED_BATCH inputs; retried on 429/5xx/network, hard timeout per attempt. */
async function openaiEmbed(cfg: EmbeddingsConfig, s: ResolvedEmbeddings, inputs: string[], opts: { timeoutMs?: number; attempts?: number } = {}): Promise<number[][]> {
  const key = apiKeyFor(cfg);
  if (!key) throw new EmbedError(`no API key: set ${s.api_key_env} in the helper's environment or continuity.embeddings.api_key in ~/.ledger/config.json`, { permanent: true });
  if (!inputs.length) return [];
  const body: Record<string, unknown> = { model: s.model, input: inputs };
  // `dimensions` is accepted by the text-embedding-3 family only; ada-002 rejects it
  if (/^text-embedding-3/.test(s.model)) body.dimensions = s.dimensions;
  const attempts = opts.attempts ?? 4;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 45_000);
    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
        const out: number[][] = new Array(inputs.length);
        for (const d of json.data ?? []) out[d.index] = d.embedding;
        for (let j = 0; j < inputs.length; j++) {
          if (!Array.isArray(out[j])) throw new EmbedError(`provider returned no vector for input ${j}`, { permanent: false });
          if (out[j].length !== s.dimensions) throw new EmbedError(`provider returned ${out[j].length} dimensions, configured ${s.dimensions} (model ${s.model})`, { permanent: true });
        }
        return out;
      }
      const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      if (res.status === 429 || res.status >= 500) { lastErr = new EmbedError(`HTTP ${res.status} ${text}`, { permanent: false, status: res.status }); }
      else if (res.status === 401 || res.status === 403) throw new EmbedError(`HTTP ${res.status}: key rejected (${text})`, { permanent: true, status: res.status });
      else throw new EmbedError(`HTTP ${res.status} ${text}`, { permanent: true, status: res.status });
    } catch (e: any) {
      if (e instanceof EmbedError && e.permanent) throw e;
      lastErr = e instanceof EmbedError ? e : new EmbedError(e?.name === "AbortError" ? "request timed out" : `network: ${errText(e)}`, { permanent: false });
    } finally {
      clearTimeout(t);
    }
    if (i < attempts - 1) await sleep(Math.min(8000, 800 * 2 ** i) + Math.floor(Math.random() * 250));
  }
  throw lastErr instanceof EmbedError ? lastErr : new EmbedError(errText(lastErr), { permanent: false });
}

/** The embed function for this config: the test override when set, else OpenAI over fetch. */
export function embedProvider(cfg: Config): EmbedFn {
  if (override) return override;
  const e = cfg.continuity?.embeddings;
  const s = embeddingSettings(cfg);
  if (!e || !s) throw new EmbedError("embeddings not configured", { permanent: true });
  return (inputs) => openaiEmbed(e, s, inputs);
}

// ---------- text ----------

/** `text || input || output_preview`, clipped, prefixed with the kind and the tool name when present. Null when there is nothing to embed. */
export function eventText(kind: string, payload: Record<string, unknown> | null | undefined, maxChars: number): string | null {
  const p = payload ?? {};
  const raw = [p.text, p.input, p.output_preview].map((v) => (typeof v === "string" ? v : v == null ? "" : String(v))).find((v) => v.length > 0) ?? "";
  const body = raw.trim();
  if (!body) return null;
  const tool = typeof p.tool === "string" && p.tool ? ` ${p.tool}` : "";
  return `${kind}${tool}: ${body.slice(0, maxChars)}`;
}

/** SQL mirror of `payload.text || payload.input || payload.output_preview` (empty strings fall through like JS `||`). */
const EVENT_TEXT_SQL = `coalesce(nullif(ev.payload->>'text',''), nullif(ev.payload->>'input',''), nullif(ev.payload->>'output_preview',''))`;

export const vectorLiteral = (v: number[]): string => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;

// ---------- schema ----------

/** Runs after the base schema when embeddings are configured. Refuses a dimension or model mismatch with the stored vectors. */
export async function ensureEmbeddingSchema(pool: pg.Pool, cfg: Config): Promise<void> {
  const s = embeddingSettings(cfg);
  if (!s) return;
  if (s.dimensions > HNSW_MAX_DIMS) throw new Error(`continuity.embeddings.dimensions=${s.dimensions} exceeds the HNSW limit of ${HNSW_MAX_DIMS}; text-embedding-3-large accepts "dimensions": 1536 or 1024`);
  try {
    await pool.query(`create extension if not exists vector`);
  } catch (e: any) {
    throw new Error(`could not install the pgvector extension (create extension if not exists vector): ${errText(e)}. Install pgvector on the server or run the statement as a role that may create extensions.`);
  }
  const existing = await storedShape(pool);
  if (existing) {
    const mismatch: string[] = [];
    if (existing.dims != null && existing.dims !== s.dimensions) mismatch.push(`cont_event_embeddings.embedding is vector(${existing.dims}) but continuity.embeddings.dimensions is ${s.dimensions}`);
    const otherModels = existing.models.filter((m) => m !== s.model);
    if (otherModels.length) mismatch.push(`stored vectors come from model ${otherModels.join(", ")} but continuity.embeddings.model is ${s.model}`);
    if (mismatch.length) {
      throw new Error(
        `embeddings schema mismatch: ${mismatch.join("; ")}. Vectors from different models or widths are not comparable, so nothing was changed. ` +
        `To switch: psql <db> -c "drop table cont_event_embeddings, cont_embedding_failures" then \`ledger continuity migrate\` and \`ledger continuity embed --backfill\` (re-embeds every eligible event; see the runbook for the cost estimate). Or restore the previous model/dimensions in ~/.ledger/config.json.`
      );
    }
  }
  await pool.query(`
    create table if not exists cont_event_embeddings (
      event_id bigint primary key references cont_events(id) on delete cascade,
      model text not null,
      dims int not null,
      embedding vector(${s.dimensions}) not null,
      created_at timestamptz default now()
    );
    create index if not exists cont_event_embeddings_hnsw_idx on cont_event_embeddings using hnsw (embedding vector_cosine_ops);
    create table if not exists cont_embedding_failures (
      event_id bigint primary key,
      error text,
      at timestamptz
    );
  `);
}

/** Width of the stored `embedding` column (pgvector keeps it in atttypmod) and the distinct models stored, or null when the table is absent. */
async function storedShape(pool: pg.Pool): Promise<{ dims: number | null; models: string[] } | null> {
  const t = await pool.query<{ reg: string | null }>(`select to_regclass('cont_event_embeddings')::text as reg`);
  if (!t.rows[0]?.reg) return null;
  const a = await pool.query<{ typmod: number }>(`select atttypmod::int as typmod from pg_attribute where attrelid = 'cont_event_embeddings'::regclass and attname = 'embedding' and not attisdropped`);
  const typmod = a.rows[0]?.typmod;
  const m = await pool.query<{ model: string }>(`select distinct model from cont_event_embeddings limit 5`);
  return { dims: typmod != null && typmod > 0 ? typmod : null, models: m.rows.map((r) => r.model) };
}

/** Schema check for query and helper paths: table present with the configured width. Cached per pool per process; a negative result is re-checked after a minute. */
const schemaOk = new WeakMap<pg.Pool, { ok: boolean; reason?: string; at: number }>();
async function schemaReady(pool: pg.Pool, s: ResolvedEmbeddings): Promise<{ ok: boolean; reason?: string }> {
  const c = schemaOk.get(pool);
  if (c && (c.ok || Date.now() - c.at < 60_000)) return c;
  let r: { ok: boolean; reason?: string };
  try {
    const shape = await storedShape(pool);
    if (!shape) r = { ok: false, reason: "cont_event_embeddings does not exist; run `ledger continuity migrate`" };
    else if (shape.dims != null && shape.dims !== s.dimensions) r = { ok: false, reason: `stored vectors are ${shape.dims}-wide, configured ${s.dimensions}; see \`ledger continuity migrate\`` };
    else r = { ok: true };
  } catch (e: any) { r = { ok: false, reason: errText(e) }; }
  schemaOk.set(pool, { ...r, at: Date.now() });
  return r;
}
/** Tests: forget the cached schema check for a pool (after dropping tables). */
export function resetEmbedSchemaCache(pool?: pg.Pool): void { if (pool) schemaOk.delete(pool); }

// ---------- embedding events ----------

export interface EmbedRunResult {
  /** vectors stored this run */
  embedded: number;
  /** events recorded in cont_embedding_failures this run */
  failed: number;
  /** characters sent to the provider (after clipping); tokens ≈ chars / 4 */
  chars: number;
  /** pending eligible events left after this run, when known (null when the run stopped early) */
  remaining: number | null;
  /** true when the run stopped on the time cap or a transient provider error rather than exhausting the selection */
  stopped_early: boolean;
  /** the transient error that stopped the run, if any */
  error?: string;
}

export interface EmbedSelection {
  /** only events of these sessions (the helper passes the sessions it uploaded to this pass) */
  sessionIds?: string[];
  /** only events newer than this many hours */
  sinceHours?: number;
  /** at most this many events */
  limit: number;
  /** stop starting new provider batches after this many ms */
  deadlineMs?: number;
  log?: (s: string) => void;
  /** progress after each stored batch (the CLI prints it) */
  onBatch?: (done: number, total: number, chars: number) => void;
}

interface PendingRow { id: string; kind: string; payload: Record<string, unknown> }

async function selectPending(pool: pg.Pool, s: ResolvedEmbeddings, sel: EmbedSelection): Promise<PendingRow[]> {
  const params: unknown[] = [s.kinds];
  const where = [`emb.event_id is null`, `f.event_id is null`, `ev.kind = any($1)`, `${EVENT_TEXT_SQL} is not null`];
  if (sel.sessionIds) { params.push(sel.sessionIds); where.push(`ev.session_id = any($${params.length})`); }
  if (sel.sinceHours != null) { params.push(sel.sinceHours); where.push(`coalesce(ev.occurred_at, ev.received_at) > now() - ($${params.length}::float8 * interval '1 hour')`); }
  const limit = Math.max(1, Math.min(Math.floor(sel.limit), 100_000));
  const r = await pool.query<PendingRow>(
    `select ev.id::text as id, ev.kind, ev.payload
       from cont_events ev
       left join cont_event_embeddings emb on emb.event_id = ev.id
       left join cont_embedding_failures f on f.event_id = ev.id
      where ${where.join(" and ")}
      order by ev.id asc
      limit ${limit}`,
    params
  );
  return r.rows;
}

async function storeVectors(pool: pg.Pool, s: ResolvedEmbeddings, rows: { id: string; vec: number[] }[]): Promise<number> {
  if (!rows.length) return 0;
  const params: unknown[] = [];
  const values = rows.map((r) => {
    params.push(r.id, s.model, s.dimensions, vectorLiteral(r.vec));
    const n = params.length;
    return `($${n - 3}::bigint, $${n - 2}, $${n - 1}::int, $${n}::vector)`;
  });
  const r = await pool.query(`insert into cont_event_embeddings (event_id, model, dims, embedding) values ${values.join(",")} on conflict (event_id) do nothing`, params);
  return r.rowCount ?? 0;
}

async function recordFailures(pool: pg.Pool, rows: { id: string; error: string }[]): Promise<void> {
  if (!rows.length) return;
  const params: unknown[] = [];
  const values = rows.map((r) => { params.push(r.id, r.error.slice(0, 500)); return `($${params.length - 1}::bigint, $${params.length}, now())`; });
  await pool.query(`insert into cont_embedding_failures (event_id, error, at) values ${values.join(",")} on conflict (event_id) do update set error = excluded.error, at = excluded.at`, params);
}

/**
 * Embed eligible events that have no vector and no recorded failure, oldest first, in provider batches of
 * EMBED_BATCH. A permanent provider error on a batch is retried one input at a time so only the offending
 * events are recorded as failures; a transient error (429/5xx/network after retries) stops the run without
 * recording anything, so the next pass or backfill retries those events.
 */
export async function embedPendingEvents(pool: pg.Pool, cfg: Config, sel: EmbedSelection): Promise<EmbedRunResult> {
  const log = sel.log ?? defaultLog;
  const out: EmbedRunResult = { embedded: 0, failed: 0, chars: 0, remaining: null, stopped_early: false };
  const s = embeddingSettings(cfg);
  if (!s) return { ...out, remaining: 0 };
  const ready = await schemaReady(pool, s);
  if (!ready.ok) { warnOnce(`schema:${ready.reason}`, `skipped: ${ready.reason}`, log); return { ...out, stopped_early: true, error: ready.reason }; }
  const embed = embedProvider(cfg);
  const rows = await selectPending(pool, s, sel);
  const t0 = Date.now();
  const items = rows.map((r) => ({ id: r.id, text: eventText(r.kind, r.payload, s.max_chars) }));
  // rows are selected with non-empty text, so a null here is whitespace-only content: never embeddable
  const blank = items.filter((i) => !i.text).map((i) => ({ id: i.id, error: "no embeddable text" }));
  await recordFailures(pool, blank);
  out.failed += blank.length;
  const todo = items.filter((i): i is { id: string; text: string } => Boolean(i.text));
  let done = 0;
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    if (sel.deadlineMs != null && Date.now() - t0 > sel.deadlineMs) { out.stopped_early = true; break; }
    const batch = todo.slice(i, i + EMBED_BATCH);
    let vecs: (number[] | null)[];
    try {
      vecs = await embed(batch.map((b) => b.text));
    } catch (e: any) {
      const perm = !(e instanceof EmbedError) || e.permanent;
      if (!perm) { out.stopped_early = true; out.error = errText(e); warnOnce(`provider:${out.error}`, `provider unavailable, will retry next pass: ${out.error}`, log); break; }
      if (batch.length === 1) { await recordFailures(pool, [{ id: batch[0].id, error: errText(e) }]); out.failed++; continue; }
      // isolate the offending inputs
      vecs = [];
      const fails: { id: string; error: string }[] = [];
      for (const b of batch) {
        try { vecs.push((await embed([b.text]))[0]); }
        catch (e2: any) {
          if (e2 instanceof EmbedError && !e2.permanent) { out.stopped_early = true; out.error = errText(e2); break; }
          vecs.push(null); fails.push({ id: b.id, error: errText(e2) });
        }
      }
      await recordFailures(pool, fails);
      out.failed += fails.length;
      if (out.stopped_early) { warnOnce(`provider:${out.error}`, `provider unavailable, will retry next pass: ${out.error}`, log); }
    }
    const good: { id: string; vec: number[] }[] = [];
    batch.forEach((b, j) => { const v = vecs[j]; if (v && v.length === s.dimensions) { good.push({ id: b.id, vec: v }); out.chars += b.text.length; } });
    out.embedded += await storeVectors(pool, s, good);
    done += batch.length;
    sel.onBatch?.(done, todo.length, out.chars);
    if (out.stopped_early) break;
  }
  if (!out.stopped_early) out.remaining = rows.length >= Math.floor(sel.limit) ? null : 0;
  return out;
}

// ---------- status ----------

export interface EmbeddingStatus {
  configured: boolean;
  provider?: "openai";
  model?: string;
  dims?: number;
  api_key_env?: string;
  api_key_present?: boolean;
  kinds?: string[];
  max_chars?: number;
  extension: { available: string | null; installed: string | null };
  table_exists: boolean;
  stored_dims: number | null;
  stored_models: string[];
  dims_match: boolean | null;
  embedded: number;
  eligible: number;
  pending: number;
  failures: number;
  /** characters that a full backfill of pending events would send (after clipping); tokens ≈ chars / 4 */
  pending_chars: number;
  estimated_tokens: number;
  estimated_usd: number | null;
}

export async function embeddingStatus(pool: pg.Pool, cfg: Config): Promise<EmbeddingStatus> {
  const ext = await pool.query<{ available: string | null; installed: string | null }>(
    `select default_version as available, installed_version as installed from pg_available_extensions where name = 'vector'`
  );
  const s = embeddingSettings(cfg);
  const base: EmbeddingStatus = {
    configured: Boolean(s),
    extension: ext.rows[0] ?? { available: null, installed: null },
    table_exists: false, stored_dims: null, stored_models: [], dims_match: null,
    embedded: 0, eligible: 0, pending: 0, failures: 0, pending_chars: 0, estimated_tokens: 0, estimated_usd: null,
  };
  if (!s) return base;
  Object.assign(base, { provider: s.provider, model: s.model, dims: s.dimensions, api_key_env: s.api_key_env, api_key_present: s.api_key_present, kinds: s.kinds, max_chars: s.max_chars });
  const shape = await storedShape(pool);
  if (!shape) {
    const e = await pool.query<{ eligible: number; chars: string }>(`select count(*)::int as eligible, coalesce(sum(least(length(${EVENT_TEXT_SQL}), $2)),0)::text as chars from cont_events ev where ev.kind = any($1) and ${EVENT_TEXT_SQL} is not null`, [s.kinds, s.max_chars]);
    base.eligible = e.rows[0].eligible; base.pending = e.rows[0].eligible; base.pending_chars = Number(e.rows[0].chars);
  } else {
    base.table_exists = true; base.stored_dims = shape.dims; base.stored_models = shape.models; base.dims_match = shape.dims == null || shape.dims === s.dimensions;
    const c = await pool.query<{ embedded: number; failures: number; eligible: number; pending: number; chars: string }>(
      `select (select count(*)::int from cont_event_embeddings) as embedded,
              (select count(*)::int from cont_embedding_failures) as failures,
              (select count(*)::int from cont_events ev where ev.kind = any($1) and ${EVENT_TEXT_SQL} is not null) as eligible,
              (select count(*)::int from cont_events ev left join cont_event_embeddings emb on emb.event_id = ev.id left join cont_embedding_failures f on f.event_id = ev.id
                where emb.event_id is null and f.event_id is null and ev.kind = any($1) and ${EVENT_TEXT_SQL} is not null) as pending,
              (select coalesce(sum(least(length(${EVENT_TEXT_SQL}), $2)),0)::text from cont_events ev left join cont_event_embeddings emb on emb.event_id = ev.id left join cont_embedding_failures f on f.event_id = ev.id
                where emb.event_id is null and f.event_id is null and ev.kind = any($1) and ${EVENT_TEXT_SQL} is not null) as chars`,
      [s.kinds, s.max_chars]
    );
    Object.assign(base, { embedded: c.rows[0].embedded, failures: c.rows[0].failures, eligible: c.rows[0].eligible, pending: c.rows[0].pending, pending_chars: Number(c.rows[0].chars) });
  }
  base.estimated_tokens = Math.ceil(base.pending_chars / 4);
  base.estimated_usd = costUsd(s.model, base.estimated_tokens);
  return base;
}

/** USD for `tokens` on `model`, null for models without a known price. */
export function costUsd(model: string, tokens: number): number | null {
  const p = PRICE_PER_M_TOKENS[model];
  return p == null ? null : (tokens / 1_000_000) * p;
}

/** "30d" | "12h" | "2w" | "90m" → hours. Bare numbers are days. */
export function parseSinceHours(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(m|h|d|w)?$/i);
  if (!m) throw new Error(`invalid --since ${s}: use e.g. 30d, 12h, 2w`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "d").toLowerCase();
  const h = unit === "m" ? n / 60 : unit === "h" ? n : unit === "d" ? n * 24 : n * 24 * 7;
  if (!(h > 0)) throw new Error(`invalid --since ${s}`);
  return h;
}

// ---------- candidates ----------

export interface VectorFilters {
  repo?: string | null;
  record_id?: string;
  session_id?: string;
  kinds?: string[];
  sinceHours?: number;
  /** ISO timestamp: only events at or before this time (by occurred_at, else received_at) */
  asOf?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Nearest events to `query` by cosine similarity, as candidates for the authority ranking.
 * Never throws: [] when unconfigured, the schema or extension is missing, or the provider fails
 * (logged once per distinct reason). Filters mirror records.ts searchEvents; `asOf` bounds the
 * event time from above. Scores are 1 - cosine distance (1 = identical direction).
 */
export async function vectorCandidates(
  pool: pg.Pool,
  cfg: Config,
  query: string,
  filters: VectorFilters,
  k: number
): Promise<Array<{ event_id: number; score: number }>> {
  let s: ResolvedEmbeddings | null;
  try { s = embeddingSettings(cfg); } catch (e: any) { warnOnce(`config:${errText(e)}`, errText(e)); return []; }
  if (!s) return [];
  const text = String(query ?? "").trim();
  const limit = Math.floor(Number(k));
  if (!text || !Number.isFinite(limit) || limit < 1) return [];
  const f = filters ?? {};
  if (f.record_id && !UUID_RE.test(f.record_id)) return [];
  try {
    const ready = await schemaReady(pool, s);
    if (!ready.ok) { warnOnce(`schema:${ready.reason}`, `candidates disabled: ${ready.reason}`); return []; }
    const [vec] = await embedProvider(cfg)([text]);
    if (!vec || vec.length !== s.dimensions) { warnOnce("query-dims", `query vector has ${vec?.length ?? 0} dimensions, configured ${s.dimensions}`); return []; }
    const params: unknown[] = [vectorLiteral(vec)];
    const where: string[] = [];
    if (f.repo === null) where.push(`s.repo is null`);
    else if (f.repo) { params.push(f.repo); where.push(`s.repo = $${params.length}`); }
    if (f.session_id) { params.push((await resolveSessionId(pool, f.session_id)).id); where.push(`ev.session_id = $${params.length}`); }
    if (f.record_id) { params.push(f.record_id); where.push(`exists (select 1 from cont_record_links l where l.record_id = $${params.length} and l.session_id = ev.session_id and ev.seq between l.from_seq and l.to_seq)`); }
    if (f.kinds?.length) { params.push(f.kinds); where.push(`ev.kind = any($${params.length})`); }
    if (f.sinceHours != null) {
      const h = Number(f.sinceHours);
      if (!Number.isFinite(h) || h <= 0) return [];
      params.push(h); where.push(`coalesce(ev.occurred_at, ev.received_at) > now() - ($${params.length}::float8 * interval '1 hour')`);
    }
    if (f.asOf) {
      if (!Number.isFinite(Date.parse(f.asOf))) return [];
      params.push(new Date(f.asOf).toISOString()); where.push(`coalesce(ev.occurred_at, ev.received_at) <= $${params.length}::timestamptz`);
    }
    const sql = `select e.event_id::text as event_id, (1 - (e.embedding <=> $1::vector))::float8 as score
                   from cont_event_embeddings e
                   join cont_events ev on ev.id = e.event_id
                   join cont_sessions s on s.id = ev.session_id
                  ${where.length ? `where ${where.join(" and ")}` : ""}
                  order by e.embedding <=> $1::vector
                  limit ${Math.min(limit, 1000)}`;
    // Filters are applied after the index scan; widen the scan so filtered queries still fill k, and let pgvector ≥ 0.8
    // keep scanning when the first candidates are filtered out.
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(`set local hnsw.ef_search = ${Math.min(1000, Math.max(40, limit * 4))}`);
      if (where.length) { await c.query("savepoint iter"); try { await c.query(`set local hnsw.iterative_scan = 'relaxed_order'`); } catch { await c.query("rollback to savepoint iter"); } }
      const r = await c.query<{ event_id: string; score: number }>(sql, params);
      await c.query("commit");
      return r.rows.map((x) => ({ event_id: Number(x.event_id), score: Number(x.score) }));
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  } catch (e: any) {
    warnOnce(`query:${errText(e)}`, `candidates unavailable: ${errText(e)}`);
    return [];
  }
}
