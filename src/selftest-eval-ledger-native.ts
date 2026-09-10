import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { prepareLedgerNative, prepareLedgerStage, captureLedgerStage, restoreLedgerSnapshot, exportLedgerNative, closeLedgerNative,
  type LedgerNativeStage, type LedgerNativeState } from './eval/analytical-ledger-native.js';

// Fabricated host-format transcripts exercise the REAL helper and local Git/PG plumbing.
// This is not a real model completion, laptop handoff, or competitive benchmark.
const build = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.resolve('.context/native-capture-selftest-'));
const namespace = `ledger_eval_${crypto.randomBytes(16).toString('hex')}`;
fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ namespace }));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@evaluation.invalid',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@evaluation.invalid' } }).toString().trim();
const source = path.join(root, 'source'); fs.mkdirSync(source); git(source, 'init', '--quiet');
fs.writeFileSync(path.join(source, 'query.sql'), 'select 1;\n'); git(source, 'add', '.'); git(source, 'commit', '--quiet', '-m', 'initial unfinished fixture');
const baseHead = git(source, 'rev-parse', 'HEAD');
function makeStage(role: string, harness: 'claude' | 'codex'): LedgerNativeStage {
  const home = path.join(root, 'homes', role); const worktree = path.join(root, 'worktrees', role);
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(root, 'clone', '--quiet', '--no-hardlinks', source, worktree);
  return { home, worktree, role, harness, person: role === 'origin' ? 'rachit-fixture' : 'agaaz-fixture' };
}
function transcript(stage: LedgerNativeStage, text: string, query = 'select 2;') {
  const sid = crypto.randomUUID(); const timestamp = new Date().toISOString();
  const lines = stage.harness === 'codex' ? [
    { timestamp, type: 'session_meta', payload: { id: sid, cwd: stage.worktree } },
    { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
    { timestamp, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'wrapped-q', input: `await tools.mcp__mixpanel__query({query:${JSON.stringify(query)}})` } },
    { timestamp, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'wrapped-q', output: 'rows: 2' } },
  ] : [
    { type: 'user', sessionId: sid, uuid: 'u1', cwd: stage.worktree, timestamp, message: { role: 'user', content: text } },
    { type: 'assistant', sessionId: sid, uuid: 'a1', cwd: stage.worktree, timestamp, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'native-q', name: 'mcp__mixpanel__query', input: { query } }] } },
    { type: 'user', sessionId: sid, uuid: 'u2', cwd: stage.worktree, timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'native-q', content: 'rows: 2' }] } },
  ];
  const folder = path.join(stage.home, stage.harness === 'claude' ? '.claude/projects/fixture' : '.codex/sessions/2026/09/10');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, stage.harness === 'claude' ? `${sid}.jsonl` : `rollout-2026-09-10T00-00-00-${sid}.jsonl`);
  fs.writeFileSync(file, lines.map(x => JSON.stringify(x)).join('\n') + '\n'); return sid;
}
let state: LedgerNativeState | undefined;
try {
  state = await prepareLedgerNative(root, namespace, build);
  await assert.rejects(prepareLedgerNative(root, namespace, build), /EEXIST/);
  await assert.rejects(closeLedgerNative({ ...state, nonce: 'wrong' }), /ownership mismatch/);
  const origin = makeStage('origin', 'claude'); const p1 = await prepareLedgerStage(state, origin);
  assert.equal(p1.config.continuity?.classify, false); assert.equal('matcher' in p1.hooks.PostToolUse[0], false);
  fs.writeFileSync(path.join(origin.worktree, 'query.sql'), 'select count(distinct eligible_id) as denominator;\n');
  const firstSid = transcript(origin, 'Continue unfinished denominator investigation; preserve eligibility filter.');
  const first = await captureLedgerStage(state, origin); assert.ok(first.snapshot); assert.equal(first.snapshot.sessionId, firstSid);
  assert.equal(git(origin.worktree, 'rev-parse', 'HEAD'), baseHead, 'native helper leaves active branch HEAD unchanged');
  assert.ok(git(origin.worktree, 'status', '--porcelain'), 'native helper leaves source edits in place');

  const correction = makeStage('correction', 'codex'); const p2 = await prepareLedgerStage(state, correction);
  assert.equal(p2.bootstrap.restored, true); assert.match(fs.readFileSync(path.join(correction.worktree, 'query.sql'), 'utf8'), /eligible_id/);
  const fullQuery = 'select count(distinct eligible_id) from cohort where eligible=true\n/*' + 'large-query-input '.repeat(400) + '*/;';
  fs.writeFileSync(path.join(correction.worktree, 'query.sql'), fullQuery);
  const secondSid = transcript(correction, 'Correct denominator using all eligible users, not only payers.', fullQuery);
  const second = await captureLedgerStage(state, correction); assert.ok(second.snapshot); assert.equal(second.snapshot.sessionId, secondSid);
  assert.equal(second.sessions.length, 1, 'fresh stage helper observes only its own harness transcript roots');
  const db = new pg.Client({ connectionString: state.databaseUrl }); await db.connect();
  try {
    const repos = (await db.query('select distinct repo from cont_sessions')).rows; assert.equal(repos.length, 1, 'people/harnesses share one fixture repository identity');
    const input = (await db.query(`select a.inline,a.sha256,e.payload from cont_events e join cont_artifacts a on a.id::text=e.payload->>'input_artifact_id' where e.session_id=$1`, [secondSid])).rows[0];
    assert.ok(input); assert.equal(crypto.createHash('sha256').update(input.inline).digest('hex'), input.sha256);
    assert.ok(input.inline.toString().includes(fullQuery.replace(/\n/g, '\\n')), 'full wrapped query survives as native artifact, not only preview');
    const records = (await db.query('select count(*)::int as n from cont_records')).rows[0].n; assert.equal(records, 0, 'fixture did not manufacture classifier records');
  } finally { await db.end(); }

  const successor = makeStage('successor', 'codex'); const p3 = await prepareLedgerStage(state, successor);
  assert.equal(p3.bootstrap.restored, true); assert.equal(fs.readFileSync(path.join(successor.worktree, 'query.sql'), 'utf8'), fullQuery);
  assert.equal(git(successor.worktree, 'rev-parse', 'HEAD'), second.snapshot.commit);
  fs.writeFileSync(path.join(successor.worktree, 'new-edit.txt'), 'successor owned edit');
  await assert.rejects(restoreLedgerSnapshot(state, successor.worktree), /refusing to replace changes/);
  await assert.rejects(captureLedgerStage(state, { ...origin, person: 'someone-else' }), /not prepared/);
  const missing = makeStage('missing-transcript', 'codex'); await prepareLedgerStage(state, missing);
  await assert.rejects(captureLedgerStage(state, missing), /no actual stage transcript/);
  const clean = makeStage('clean-analyst', 'claude'); await prepareLedgerStage(state, clean);
  transcript(clean, 'Check current definition without editing source.');
  const cleanCapture = await captureLedgerStage(state, clean); assert.equal(cleanCapture.snapshot, null, 'unchanged analytical stage does not invent a WIP snapshot');
  assert.equal(state.latestSnapshot?.commit, second.snapshot.commit, 'clean stage retains actual previous snapshot for successor bootstrap');
  const exported = await exportLedgerNative(state);
  const manifest = JSON.parse(fs.readFileSync(exported.manifestFile, 'utf8'));
  assert.ok(manifest.tables.cont_events.rows > 0 && manifest.tables.cont_artifacts.rows > 0);
  for (const artifact of manifest.artifacts) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(exported.directory, artifact.file))).digest('hex'), artifact.sha256);
  await closeLedgerNative(state); assert.ok(state.closedAt);
  await assert.rejects(closeLedgerNative(state), /already closed/);
  console.log(`selftest-eval-ledger-native: ok (real local helper, two harness-format fixture transcripts, verified snapshot chain, input artifact hash, isolation and cleanup; not model execution). Evidence: ${root}`);
} finally { if (state && !state.closedAt) await closeLedgerNative(state); }
