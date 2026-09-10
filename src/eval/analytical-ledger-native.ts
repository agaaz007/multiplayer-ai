import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import type { Config } from '../store.js';

const run = promisify(execFile);
const ownerFile = 'ledger-native-owner.json';
export interface LedgerNativeStage { home: string; worktree: string; harness: 'claude' | 'codex'; person: string; role: string }
export interface LedgerNativeSnapshot { sessionId: string; threadId: string | null; commit: string; ref: string; verifiedAt: string; tree: string }
export interface LedgerNativeState {
  trialDir: string; namespace: string; frozenBuildDir: string; databaseUrl: string; databaseName: string;
  adminUrl: string; remote: string; nonce: string; createdAt: string; closedAt?: string;
  latestSnapshot?: LedgerNativeSnapshot;
  stages: Array<LedgerNativeStage & { initialHead: string | null; preparedAt: string }>;
}
function writeJson(file: string, value: unknown, exclusive = false) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
}
function inside(root: string, target: string): string {
  const realRoot = fs.realpathSync(root); const resolved = path.resolve(target);
  const realTarget = fs.existsSync(resolved) ? fs.realpathSync(resolved) : path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  if (!realTarget.startsWith(realRoot + path.sep)) throw new Error('native Ledger path is outside its owned trial');
  return realTarget;
}
function localUrl(value: string): URL {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.password || [...url.searchParams].length) throw new Error('native Ledger evaluation requires an uncredentialed localhost database');
  return url;
}
function assertOwned(state: LedgerNativeState): void {
  const trial = JSON.parse(fs.readFileSync(path.join(state.trialDir, 'ownership.json'), 'utf8'));
  const owner = JSON.parse(fs.readFileSync(path.join(state.trialDir, ownerFile), 'utf8'));
  if (trial.namespace !== state.namespace || owner.namespace !== state.namespace || owner.nonce !== state.nonce
      || owner.databaseName !== state.databaseName || owner.databaseUrl !== state.databaseUrl || owner.remote !== state.remote
      || owner.closedAt || state.closedAt || !/^ledger_native_[a-f0-9]{24}$/.test(state.databaseName)) throw new Error('native Ledger ownership mismatch or already closed');
  const url = localUrl(state.databaseUrl); const admin = localUrl(state.adminUrl);
  if (url.pathname !== '/' + state.databaseName || admin.pathname !== '/postgres' || url.host !== admin.host || url.username !== admin.username) throw new Error('native Ledger database ownership URL mismatch');
  inside(state.trialDir, state.remote);
}
function persist(state: LedgerNativeState) { writeJson(path.join(state.trialDir, ownerFile), state); }
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: path.dirname(cwd), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } }).toString().trim();
}
function head(worktree: string): string | null { try { return git(worktree, ['rev-parse', '--verify', 'HEAD']); } catch { return null; } }
function quote(value: string) { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/** Creates only an exclusively owned local DB and a bare fixture remote. No source records are imported. */
export async function prepareLedgerNative(trialDirInput: string, namespace: string, frozenBuildDir: string): Promise<LedgerNativeState> {
  const trialDir = fs.realpathSync(trialDirInput);
  if (JSON.parse(fs.readFileSync(path.join(trialDir, 'ownership.json'), 'utf8')).namespace !== namespace) throw new Error('trial namespace ownership mismatch');
  const build = fs.realpathSync(frozenBuildDir);
  for (const file of ['cli.js', 'continuity/db.js', 'helper/daemon.js']) if (!fs.statSync(path.join(build, file)).isFile()) throw new Error(`frozen native Ledger build missing ${file}`);
  const databaseName = `ledger_native_${crypto.randomBytes(12).toString('hex')}`;
  const adminUrl = `postgresql://${encodeURIComponent(os.userInfo().username)}@127.0.0.1:5432/postgres`;
  const url = localUrl(adminUrl); url.pathname = '/' + databaseName;
  const state: LedgerNativeState = { trialDir, namespace, frozenBuildDir: build, databaseUrl: url.toString(), databaseName, adminUrl,
    remote: path.join(trialDir, 'ledger-native-origin.git'), nonce: crypto.randomBytes(24).toString('hex'), createdAt: new Date().toISOString(), stages: [] };
  writeJson(path.join(trialDir, ownerFile), state, true);
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
  let created = false;
  try {
    await admin.connect();
    await admin.query(`create database "${databaseName}"`); created = true;
    await admin.query(`comment on database "${databaseName}" is '${state.nonce}'`);
    git(trialDir, ['init', '--bare', '--quiet', state.remote]);
    await child(state, undefined, 'migrate');
    return state;
  } catch (error) {
    // The random name was created by this invocation, so cleanup cannot target a pre-existing DB.
    if (created) await admin.query(`drop database "${databaseName}"`).catch(() => {});
    persist({ ...state, closedAt: new Date().toISOString() });
    throw error;
  } finally { await admin.end().catch(() => {}); }
}

/** Must run before the stage agent starts. All stages share this trial's repository identity. */
export async function prepareLedgerStage(state: LedgerNativeState, stageInput: LedgerNativeStage, options: { restoreSnapshot?: boolean } = {}) {
  assertOwned(state);
  const stage = { ...stageInput, home: inside(state.trialDir, stageInput.home), worktree: inside(state.trialDir, stageInput.worktree) };
  if (!stage.person.trim() || !stage.role.trim() || state.stages.some(s => s.home === stage.home || s.worktree === stage.worktree)) throw new Error('native stage needs a fresh home and worktree');
  if (git(stage.worktree, ['status', '--porcelain']).trim()) throw new Error('native bootstrap requires a fresh clean checkout');
  const remotes = git(stage.worktree, ['remote']).split('\n');
  if (remotes.includes('origin')) git(stage.worktree, ['remote', 'set-url', 'origin', state.remote]);
  else git(stage.worktree, ['remote', 'add', 'origin', state.remote]);
  // Ensure no inherited push URL can send helper snapshots to the source repository.
  try { git(stage.worktree, ['config', '--unset-all', 'remote.origin.pushurl']); } catch { /* absent */ }
  git(stage.worktree, ['config', 'remote.origin.pushurl', state.remote]);
  git(stage.worktree, ['config', 'user.name', stage.person]);
  git(stage.worktree, ['config', 'user.email', `${state.namespace}@evaluation.invalid`]);
  // The four-stage pilot leaves the fetch to the agent (the resume pack's bootstrap commands), so the
  // product's own delivery is what gets measured; the older handoff runner restores here.
  const bootstrap = state.latestSnapshot && options.restoreSnapshot !== false ? await restoreLedgerSnapshot(state, stage.worktree)
    : { restored: false as const, reason: state.latestSnapshot ? 'snapshot left for the agent to fetch through the product' : 'no earlier verified source WIP snapshot', commit: head(stage.worktree) };
  const cfgDir = path.join(stage.home, '.ledger'); fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, 'config.json');
  const prior = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  if ((prior.author && prior.author !== stage.person) || (prior.ledger_dir && path.resolve(prior.ledger_dir) !== path.join(state.trialDir, 'ledger'))) throw new Error('stage config belongs to another actor or ledger');
  const config: Config = { ledger_dir: path.join(state.trialDir, 'ledger'), author: stage.person, git_sync: false, extractor: 'none',
    continuity: { database_url: state.databaseUrl, machine: `same-machine-fixture-${state.namespace}`, repos: [stage.worktree], classify: false } };
  writeJson(cfgPath, config);
  state.stages.push({ ...stage, initialHead: head(stage.worktree), preparedAt: new Date().toISOString() }); persist(state);
  const cli = path.join(state.frozenBuildDir, 'cli.js');
  const env = { LEDGER_CONFIG_DIR: cfgDir, LEDGER_CONTINUITY_DB: state.databaseUrl, LEDGER_CLASSIFY: '0', LEDGER_EXTRACTOR: 'none', LEDGER_GIT_SYNC: '0' };
  const timeouts: Record<string, number> = { SessionStart: 15, PostToolUse: 10, Stop: 15, PreCompact: 15, SessionEnd: 10 };
  const hooks = Object.fromEntries(Object.entries(timeouts).map(([event, timeout]) => [event, [{ hooks: [{ type: 'command',
    command: `env ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(' ')} ${quote(process.execPath)} ${quote(cli)} hook ${event}`, timeout }] }]]));
  return { config, env, bootstrap, hooks, mcpServer: { command: process.execPath, args: [cli, 'mcp'], env },
    limitations: ['same-machine isolated fixture; does not prove two-laptop delivery', 'automatic classifier and transcript model extraction disabled; raw helper capture and agent-authored MCP records remain enabled'] };
}

// Child process isolates ledgerHome(), helper state and pools from concurrently running trials.
async function child(state: LedgerNativeState, stage: LedgerNativeStage | undefined, operation: 'migrate' | 'capture'): Promise<any> {
  const input = { build: pathToFileURL(state.frozenBuildDir + path.sep).href, operation,
    config: stage ? path.join(stage.home, '.ledger', 'config.json') : null, databaseUrl: state.databaseUrl,
    home: stage?.home, worktree: stage?.worktree, harness: stage?.harness };
  const code = `
    import fs from 'node:fs';
    const input = JSON.parse(process.argv[1]);
    const db = await import(new URL('continuity/db.js', input.build));
    try {
      const cfg = input.config ? JSON.parse(fs.readFileSync(input.config, 'utf8')) : { continuity: {database_url: input.databaseUrl} };
      const pool = db.getPool(cfg);
      if (input.operation === 'migrate') { console.log(JSON.stringify({migrations: await db.migrate(pool)})); }
      else {
        const {helperOnce} = await import(new URL('helper/daemon.js', input.build));
        const logs = [];
        const roots = {claude:input.home+(input.harness==='claude'?'/.claude/projects':'/.ledger/unused-claude-root'),codex:input.home+(input.harness==='codex'?'/.codex/sessions':'/.ledger/unused-codex-root')};
        const summary = await helperOnce(cfg, {roots, activeWindowMin:1440,quietEndMin:1440,push:true,log:s=>logs.push(s)});
        const sessions = (await pool.query('select s.*, (select count(*)::int from cont_events e where e.session_id=s.id) as event_count from cont_sessions s where s.transcript_path like $1 order by s.id',[input.home+'/%'])).rows;
        console.log(JSON.stringify({summary,logs,sessions}));
      }
    } finally { await db.closePools(); }
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', code, JSON.stringify(input)], {
    cwd: state.trialDir, timeout: 120_000, maxBuffer: 8 << 20,
    env: { PATH: process.env.PATH, HOME: stage?.home ?? state.trialDir, LEDGER_CONFIG_DIR: stage ? path.join(stage.home, '.ledger') : path.join(state.trialDir, 'native-admin'),
      LEDGER_CLASSIFY: '0', LEDGER_EXTRACTOR: 'none', LEDGER_GIT_SYNC: '0', LEDGER_GIT_CREDENTIAL_HELPER: '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  return JSON.parse(stdout.trim());
}

/** Reads the actual stage transcript through the real helper. Does not generate events or memory records. */
export async function captureLedgerStage(state: LedgerNativeState, stage: LedgerNativeStage) {
  assertOwned(state);
  const prepared = state.stages.find(s => s.home === fs.realpathSync(stage.home) && s.worktree === fs.realpathSync(stage.worktree));
  if (!prepared || prepared.person !== stage.person || prepared.role !== stage.role || prepared.harness !== stage.harness) throw new Error('native stage was not prepared with this identity');
  if (git(stage.worktree, ['remote', 'get-url', 'origin']) !== state.remote || git(stage.worktree, ['remote', 'get-url', '--push', 'origin']) !== state.remote) throw new Error('stage changed its permitted snapshot remote');
  const dirty = Boolean(git(stage.worktree, ['status', '--porcelain'])); const finalHead = head(stage.worktree);
  const config = JSON.parse(fs.readFileSync(path.join(stage.home, '.ledger', 'config.json'), 'utf8'));
  if (config.continuity?.database_url !== state.databaseUrl || config.author !== stage.person || config.continuity?.classify !== false) throw new Error('native stage changed isolated capture configuration');
  const result = await child(state, stage, 'capture');
  const sessions = result.sessions as Array<Record<string, any>>;
  if (result.summary.errors.length) throw new Error(`native capture failed: ${result.summary.errors.join(' | ')}`);
  if (!sessions.length || !sessions.some(s => s.harness === stage.harness && s.event_count > 0 && fs.realpathSync(s.cwd) === fs.realpathSync(stage.worktree))) throw new Error('no actual stage transcript events were captured');
  if (sessions.some(s => s.cwd && fs.realpathSync(s.cwd) !== fs.realpathSync(stage.worktree))) throw new Error('native capture included a transcript from another worktree');
  const snapshots = sessions.filter(s => s.harness === stage.harness && s.cwd && fs.realpathSync(s.cwd) === fs.realpathSync(stage.worktree) && s.wip_commit && s.wip_ref && s.last_verified_snapshot_at)
    .sort((a,b) => Date.parse(b.last_verified_snapshot_at) - Date.parse(a.last_verified_snapshot_at));
  let snapshot: LedgerNativeSnapshot | undefined;
  if (snapshots.length) {
    const s = snapshots[0];
    const remoteCommit = git(stage.worktree, ['ls-remote', state.remote, s.wip_ref]).split(/\s+/)[0];
    if (remoteCommit !== s.wip_commit) throw new Error('native snapshot remote verification disagrees with captured checkpoint');
    snapshot = { sessionId: s.id, threadId: s.thread_id, commit: s.wip_commit, ref: s.wip_ref, verifiedAt: s.last_verified_snapshot_at,
      tree: git(stage.worktree, ['rev-parse', `${s.wip_commit}^{tree}`]) };
    state.latestSnapshot = snapshot; persist(state);
  }
  const evidence = { stage, ...result, dirtyAtCapture: dirty, initialHead: prepared.initialHead, finalHead, snapshot: snapshot ?? null,
    limitations: snapshot ? [] : ['no new source WIP snapshot; any earlier verified snapshot remains the bootstrap source'] };
  const file = path.join(state.trialDir, `ledger-native-capture-${path.basename(stage.home)}-${crypto.randomBytes(4).toString('hex')}.json`);
  writeJson(file, evidence, true);
  if (dirty && !snapshot) throw new Error(`uncommitted source changes lack a verified native snapshot; evidence: ${file}`);
  if (!dirty && finalHead !== prepared.initialHead && !snapshot) throw new Error(`committed source changed but helper produced no transferable snapshot; evidence: ${file}`);
  return { ...evidence, evidenceFile: file };
}

/** Restores only a captured and remote-verified snapshot into an owned, still-clean stage checkout. */
export async function restoreLedgerSnapshot(state: LedgerNativeState, successorWorktree: string) {
  assertOwned(state); const worktree = inside(state.trialDir, successorWorktree); const snapshot = state.latestSnapshot;
  if (!snapshot) throw new Error('no verified source snapshot is available');
  if (git(worktree, ['status', '--porcelain'])) throw new Error('refusing to replace changes in a native stage checkout');
  if (git(worktree, ['ls-remote', state.remote, snapshot.ref]).split(/\s+/)[0] !== snapshot.commit) throw new Error('source snapshot ref moved or is unavailable');
  git(worktree, ['fetch', '--quiet', '--no-tags', state.remote, snapshot.ref]);
  if (git(worktree, ['rev-parse', 'FETCH_HEAD']) !== snapshot.commit) throw new Error('fetched native snapshot is not the verified commit');
  git(worktree, ['checkout', '--detach', snapshot.commit]);
  const tree = git(worktree, ['rev-parse', 'HEAD^{tree}']);
  if (tree !== snapshot.tree || git(worktree, ['status', '--porcelain'])) throw new Error('restored native snapshot tree failed verification');
  return { restored: true as const, ...snapshot, worktree };
}

/** Exports a consistent read snapshot, exact artifact bytes and hashes before owned DB cleanup. */
export async function exportLedgerNative(state: LedgerNativeState) {
  assertOwned(state);
  const directory = path.join(state.trialDir, `ledger-native-export-${crypto.randomBytes(8).toString('hex')}`);
  fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(path.join(directory, 'artifacts'), { mode: 0o700 });
  const db = new pg.Client({ connectionString: state.databaseUrl, connectionTimeoutMillis: 5000 });
  const tables: Record<string, { file: string; sha256: string; rows: number }> = {};
  const artifacts: Array<{ id: string; file: string; sha256: string; byteSize: number }> = [];
  try {
    await db.connect(); await db.query('begin isolation level repeatable read read only');
    const names = (await db.query("select tablename from pg_tables where schemaname='public' and tablename like 'cont\\_%' order by tablename")).rows;
    for (const { tablename: table } of names) {
      if (!/^cont_[a-z_]+$/.test(table)) throw new Error('unexpected native table name');
      const rows = (await db.query(`select * from "${table}"`)).rows;
      if (table === 'cont_artifacts') for (const row of rows) {
        if (!Buffer.isBuffer(row.inline)) throw new Error(`cannot export unavailable artifact bytes ${row.id}`);
        const hash = crypto.createHash('sha256').update(row.inline).digest('hex');
        if (hash !== row.sha256) throw new Error(`native artifact hash mismatch ${row.id}`);
        const file = `artifacts/${hash}.bin`; fs.writeFileSync(path.join(directory, file), row.inline, { mode: 0o600, flag: 'wx' });
        artifacts.push({ id: row.id, file, sha256: hash, byteSize: row.inline.length });
        row.inline = { encoding: 'external-exact-bytes', file, sha256: hash };
      }
      const file = `${table}.json`; writeJson(path.join(directory, file), rows, true);
      tables[table] = { file, rows: rows.length, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex') };
    }
    await db.query('commit');
    const manifestFile = path.join(directory, 'manifest.json');
    writeJson(manifestFile, { version: 1, namespace: state.namespace, databaseName: state.databaseName, exportedAt: new Date().toISOString(),
      tables, artifacts, latestSnapshot: state.latestSnapshot ?? null, retainedBareRemote: state.remote,
      representation: 'SQL rows serialized as JSON; cont_artifacts.inline replaced by relative exact-byte file reference; bytea content hash verified; native Git snapshot objects retained in owned bare remote' }, true);
    return { directory, manifestFile, manifestSha256: crypto.createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex') };
  } catch (error) { await db.query('rollback').catch(() => {}); throw error; }
  finally { await db.end().catch(() => {}); }
}

/** Removes only the DB whose random name and server-side nonce belong to this trial. Keeps evidence files. */
export async function closeLedgerNative(state: LedgerNativeState): Promise<void> {
  assertOwned(state);
  const admin = new pg.Client({ connectionString: state.adminUrl, connectionTimeoutMillis: 5000 });
  try {
    await admin.connect();
    const owner = (await admin.query(`select shobj_description(oid,'pg_database') as nonce from pg_database where datname=$1`, [state.databaseName])).rows[0];
    if (!owner || owner.nonce !== state.nonce) throw new Error('refusing to remove native database without matching server-side ownership nonce');
    await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()', [state.databaseName]);
    await admin.query(`drop database "${state.databaseName}"`);
    state.closedAt = new Date().toISOString(); persist(state);
  } finally { await admin.end().catch(() => {}); }
}
