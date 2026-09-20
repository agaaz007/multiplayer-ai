import type pg from 'pg';
import type { CheckpointRow } from './store.js';

/** One checkpoint proves this exact commit/ref/time pair. Session timestamps are not transferable to another commit. */
export interface VerifiedSnapshot {
  status: 'verified';
  checkpoint_id: string;
  thread_id: string;
  session_id: string;
  repo: string;
  ref: string;
  commit: string;
  base_commit: string | null;
  verified_at: Date;
  through_event_seq: number;
  created_at: Date;
}

export async function verifiedSnapshots(pool: pg.Pool, opts: {threadId?: string; sessionIds?: string[]; repos?: string[]; asOf?: Date | null}): Promise<VerifiedSnapshot[]> {
  if (opts.sessionIds && !opts.sessionIds.length || opts.repos && !opts.repos.length) return [];
  const params: unknown[] = [];
  const conditions = ["c.advanced_head", "c.verified_snapshot_at is not null", "c.wip_ref like 'refs/wip/%'", "c.wip_commit ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'"];
  if (opts.threadId) {params.push(opts.threadId);conditions.push(`c.thread_id=$${params.length}`);}
  if (opts.sessionIds) {params.push(opts.sessionIds);conditions.push(`c.session_id=any($${params.length}::text[])`);}
  if (opts.repos) {params.push(opts.repos);conditions.push(`t.repo=any($${params.length}::text[])`);}
  if (opts.asOf) {params.push(opts.asOf);conditions.push(`c.created_at <= $${params.length} and c.verified_snapshot_at <= $${params.length}`);}
  const rows = (await pool.query<CheckpointRow & {repo:string}>(`select * from (
    select distinct on(c.session_id) c.*,t.repo from cont_checkpoints c join cont_threads t on t.id=c.thread_id
    where ${conditions.join(' and ')} order by c.session_id,c.verified_snapshot_at desc,c.created_at desc,c.id desc
    ) verified order by verified_snapshot_at desc,created_at desc,id desc`,params)).rows;
  return rows.map(row=>({status:'verified' as const,checkpoint_id:row.id,thread_id:row.thread_id,session_id:row.session_id,repo:row.repo,
    ref:row.wip_ref!,commit:row.wip_commit!,base_commit:row.base_commit,verified_at:row.verified_snapshot_at!,
    through_event_seq:row.through_event_seq,created_at:row.created_at}));
}

export async function latestVerifiedSnapshot(pool: pg.Pool, opts: Parameters<typeof verifiedSnapshots>[1]): Promise<VerifiedSnapshot | null> {
  return (await verifiedSnapshots(pool,opts))[0] ?? null;
}

const shellArg = (value: string) => /^[A-Za-z0-9_./:-]+$/.test(value) && !value.startsWith('-') ? value : `'${value.replace(/'/g, `'"'"'`)}'`;

/** Sanitized snapshots can be orphan commits. Restore first; never rebase/merge that isolated history or apply its full-tree deletions. */
export function snapshotBootstrap(snapshot: VerifiedSnapshot, title: string): string[] {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40) || 'ledger-snapshot';
  const destination = `../${slug}`;
  const base = snapshot.base_commit && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(snapshot.base_commit) ? snapshot.base_commit : null;
  return [
    `git fetch origin ${shellArg(`${snapshot.ref}:${snapshot.ref}`)}`,
    `git cat-file -e ${shellArg(`${snapshot.commit}^{commit}`)}`,
    `git worktree add --detach ${shellArg(destination)} ${shellArg(snapshot.commit)}`,
    `# Inspect this exact snapshot in the fresh worktree; reconcile pending operations before continuing.`,
    `# Snapshot history is isolated. Do not rebase or merge its history into a product branch.`,
    base ? `# Original source base: ${base}. Verify this commit is available before comparing intended paths.` : `# Original source base is unavailable; establish the correct base from source evidence before porting changes.`,
    `# Port only reviewed changes in intended paths to a separate target worktree after git apply --check.`,
    `# Do not apply a full-tree diff: denied/generated files are deliberately absent from the snapshot.`,
  ];
}
