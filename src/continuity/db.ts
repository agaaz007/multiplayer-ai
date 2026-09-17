import pg from "pg";
import type { Config } from "../store.js";
import { embeddingsConfigured, ensureEmbeddingSchema } from "./embeddings.js";

/**
 * Shared Postgres for execution continuity. One pool per URL, created lazily.
 * All tables are prefixed `cont_` so the database can be shared with anything
 * else the team already keeps there. Migrations are idempotent CREATE IF NOT
 * EXISTS; there is no version table yet, since v1 has one schema.
 *
 * Knowledge objects (definitions, findings, changes, decisions) never live here.
 * They stay in the git ledger and are referenced by id.
 */

const pools = new Map<string, pg.Pool>();

export function continuityConfigured(cfg: Config): boolean {
  return Boolean(cfg.continuity?.database_url);
}

export function getPool(cfg: Config): pg.Pool {
  const url = cfg.continuity?.database_url;
  if (!url) throw new Error("continuity not configured: set continuity.database_url in ~/.ledger/config.json or LEDGER_CONTINUITY_DB");
  let p = pools.get(url);
  if (!p) {
    // pg 8.23 treats sslmode=require as verify-full and prints a security warning while parsing the URL.
    // Strip the libpq-style params and state the intent explicitly: verify the server certificate.
    const u = new URL(url);
    const wantSsl = u.searchParams.get("sslmode") !== "disable" && !/^(localhost|127\.0\.0\.1|\/tmp)/.test(u.hostname);
    u.searchParams.delete("sslmode");
    u.searchParams.delete("channel_binding");
    // statement_timeout is enforced by the server, so it cannot end a query whose connection died silently
    // (a laptop sleep or DNS loss). query_timeout is the client-side bound and TCP keepalive surfaces dead
    // sockets; without both the helper once waited 39 h on one query while launchd reported it running.
    p = new pg.Pool({ connectionString: u.toString(), ssl: wantSsl ? { rejectUnauthorized: true } : false, max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 8_000, statement_timeout: 20_000, query_timeout: 30_000, keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
    p.on("error", () => { /* idle client errors are retried on next query */ });
    pools.set(url, p);
  }
  return p;
}

export async function closePools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end().catch(() => {})));
  pools.clear();
}

export const SCHEMA = `
create table if not exists cont_threads (
  id uuid primary key default gen_random_uuid(),
  repo text not null,
  branch text,
  title text not null,
  goal text,
  created_by text not null,
  status text not null default 'open',
  generation int not null default 0,
  head_checkpoint_id uuid,
  forked_from_thread_id uuid,
  forked_at_checkpoint_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists cont_sessions (
  id text primary key,
  thread_id uuid references cont_threads(id),
  author text not null,
  harness text not null,
  machine text,
  cwd text,
  repo text,
  branch text,
  transcript_path text,
  started_at timestamptz,
  last_seen_at timestamptz,
  ended_at timestamptz,
  transcript_offset bigint not null default 0,
  coverage jsonb not null default '{}'::jsonb,
  last_verified_snapshot_at timestamptz,
  last_acked_event_at timestamptz,
  diverged_at_seq int,
  fork_thread_id uuid,
  base_commit text,
  wip_ref text,
  wip_commit text,
  claim_generation int
);

create table if not exists cont_events (
  id bigserial primary key,
  session_id text not null references cont_sessions(id),
  seq int not null,
  producer_event_id text not null,
  call_id text,
  thread_id uuid,
  kind text not null,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  generation int,
  payload jsonb not null default '{}'::jsonb,
  artifact_refs jsonb not null default '[]'::jsonb,
  unique (session_id, producer_event_id),
  unique (session_id, seq)
);

create table if not exists cont_checkpoints (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references cont_threads(id),
  session_id text not null references cont_sessions(id),
  generation int not null,
  kind text not null,
  through_event_seq int not null default 0,
  base_commit text,
  wip_ref text,
  wip_commit text,
  verified_snapshot_at timestamptz,
  verified_events_at timestamptz,
  structured_state jsonb not null default '{}'::jsonb,
  narrative text,
  narrative_status text not null default 'none',
  capture_gaps jsonb not null default '[]'::jsonb,
  advanced_head boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists cont_claims (
  thread_id uuid primary key references cont_threads(id),
  holder_session_id text not null,
  holder_author text not null,
  generation int not null,
  acquired_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz
);

create table if not exists cont_artifacts (
  id uuid primary key default gen_random_uuid(),
  sha256 text not null unique,
  kind text not null,
  byte_size int not null,
  storage_uri text,
  inline bytea,
  session_id text,
  created_at timestamptz not null default now()
);

create table if not exists cont_notifications (
  id bigserial primary key,
  author text not null,
  machine text,
  message text not null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

create index if not exists cont_events_thread_idx on cont_events(thread_id, id);
create index if not exists cont_sessions_thread_idx on cont_sessions(thread_id);
create index if not exists cont_sessions_seen_idx on cont_sessions(last_seen_at desc);
create index if not exists cont_threads_repo_idx on cont_threads(repo, status, updated_at desc);
create index if not exists cont_checkpoints_thread_idx on cont_checkpoints(thread_id, created_at desc);

-- Work records (spec v1.2, D-009): the logical unit of work. A session contributes to many
-- records through spans of its events; state updates are append-only with provenance.
create table if not exists cont_records (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'other',
  title text not null,
  goal text,
  repo text,
  status text not null default 'open',
  created_by text not null,
  ledger_refs jsonb not null default '[]'::jsonb,
  state_version int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists cont_record_links (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references cont_records(id) on delete cascade,
  session_id text not null references cont_sessions(id),
  from_seq int not null,
  to_seq int not null,
  source text not null,
  confidence real,
  note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  check (from_seq <= to_seq)
);

create table if not exists cont_state_updates (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references cont_records(id) on delete cascade,
  session_id text,
  from_seq int,
  to_seq int,
  status text not null default 'proposed',
  kind text not null,
  text text not null,
  evidence jsonb not null default '[]'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  confirmed_by text,
  confirmed_at timestamptz,
  supersedes uuid references cont_state_updates(id),
  reject_reason text
);
alter table cont_state_updates add column if not exists rejected_by text;
alter table cont_state_updates add column if not exists rejected_at timestamptz;
-- acceptance provenance (2026-09-13): which session proposed and confirmed an update, and through which channel
alter table cont_state_updates add column if not exists proposed_session_id text;
alter table cont_state_updates add column if not exists confirmed_session_id text;
alter table cont_state_updates add column if not exists confirmed_via text;

-- Investigation bindings (2026-09-17): an analysis session resolves its scope to one open investigation
-- record (any repo, or none) before it runs data queries. One row per session; the matching explicit
-- cont_record_links span (note "bound by <author>") is what the helper extends each pass. See investigations.ts.
create table if not exists cont_session_bindings (
  session_id text primary key,
  record_id uuid not null references cont_records(id),
  question text,
  bound_by text not null,
  bound_at timestamptz not null default now()
);
create index if not exists cont_session_bindings_record_idx on cont_session_bindings(record_id);

create index if not exists cont_records_repo_idx on cont_records(repo, status, updated_at desc);
create index if not exists cont_records_updated_idx on cont_records(updated_at desc);
create index if not exists cont_record_links_record_idx on cont_record_links(record_id);
create index if not exists cont_record_links_session_idx on cont_record_links(session_id, from_seq, to_seq);
create index if not exists cont_state_updates_record_idx on cont_state_updates(record_id, created_at);
create index if not exists cont_state_updates_supersedes_idx on cont_state_updates(supersedes);

-- Full-text search over event content. records.ts must use this exact expression so the planner matches the index.
create index if not exists cont_events_fts_idx on cont_events using gin (
  to_tsvector('english', coalesce(payload->>'text','') || ' ' || coalesce(payload->>'input','') || ' ' || coalesce(payload->>'output_preview',''))
);
`;

/**
 * Idempotent. Without `cfg`, or with a config that has no `continuity.embeddings`, this runs the base
 * SCHEMA only. With embeddings configured it also installs pgvector and the cont_event_embeddings /
 * cont_embedding_failures tables, refusing a width or model mismatch with stored vectors (embeddings.ts).
 */
export async function migrate(pool: pg.Pool, cfg?: Config): Promise<string[]> {
  const before = await tableList(pool);
  await pool.query(SCHEMA);
  if (cfg && embeddingsConfigured(cfg)) await ensureEmbeddingSchema(pool, cfg);
  const after = await tableList(pool);
  return after.filter((t) => !before.includes(t));
}

export async function tableList(pool: pg.Pool): Promise<string[]> {
  const r = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = current_schema() and table_name like 'cont_%' order by 1`
  );
  return r.rows.map((x) => x.table_name);
}
