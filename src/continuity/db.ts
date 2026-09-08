import pg from "pg";
import type { Config } from "../store.js";

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
    p = new pg.Pool({ connectionString: u.toString(), ssl: wantSsl ? { rejectUnauthorized: true } : false, max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 8_000, statement_timeout: 20_000 });
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
`;

export async function migrate(pool: pg.Pool): Promise<string[]> {
  const before = await tableList(pool);
  await pool.query(SCHEMA);
  const after = await tableList(pool);
  return after.filter((t) => !before.includes(t));
}

export async function tableList(pool: pg.Pool): Promise<string[]> {
  const r = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = current_schema() and table_name like 'cont_%' order by 1`
  );
  return r.rows.map((x) => x.table_name);
}
