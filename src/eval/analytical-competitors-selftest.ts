import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readGbrainEmbeddingKey } from './analytical-credentials.js';
import { createProvider, createSupermemoryAdapter, createGbrainAdapter, gbrainEnvironment } from './analytical-providers.js';
import { supermemoryClient, verifySupermemoryScope, createTrialSupermemoryKey } from './analytical-supermemory.js';
import { graphifyStore } from './analytical-graphify.js';
import { freezeComparisonConditions } from './analytical-runner.js';
import { NativeRouteSchema, nativeReadiness, writeNativeSupermemorySettings } from './analytical-native.js';
import { syntheticAnalyticalFixture } from './analytical-fixture.js';
import { type AdapterContext } from './analytical-contract.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-competitors-selftest-'));
const previous = { ...process.env }; let groups = 0;
const ok = (s: string) => console.log(`ok ${++groups}: ${s}`);
function context(arm: AdapterContext['arm']): AdapterContext {
  const directory = path.join(root, crypto.randomUUID()); fs.mkdirSync(directory);
  const namespace = `ledger_eval_${crypto.randomBytes(16).toString('hex')}`;
  fs.writeFileSync(path.join(directory, 'ownership.json'), JSON.stringify({ namespace }));
  return { arm, namespace, root: directory, task: syntheticAnalyticalFixture().task, mode: 'native',
    allowExternalExport: true, allowPaidOperations: true, trace: () => {} };
}
const response = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
try {
  process.env.SUPERMEMORY_API_KEY = 'fixture-only-master-not-real';
  const ctx = context('supermemory'); const calls: any[] = [];
  let foreignStatus = 403; let projectedList = false; let duplicate = false; let changedTotal = false; let foreignDocument = false; let pending = false;
  const transport: typeof fetch = async (url, init) => {
    const route = new URL(String(url)).pathname; const body = init?.body ? JSON.parse(String(init.body)) : {};
    assert.equal(init?.redirect, 'error'); assert.equal(body.containerTags, undefined);
    calls.push({ route, body });
    if (route.startsWith('/v3/auth/scoped-key')) return response(init?.method === 'DELETE' ? { success: true } : { id: 'test-key-id', key: 'fixture-scoped-key-not-real', containerTag: ctx.namespace });
    if (body.containerTag?.endsWith('_denied') && !(projectedList && route === '/v3/documents/list')) return response({ error: 'test denial' }, foreignStatus);
    if (route === '/v4/profile') return response({ profile: { static: [], dynamic: [] } });
    if (route === '/v4/search') return response({ results: [] });
    if (route === '/v3/documents/list') return response({ memories: [{ id: duplicate ? 'd1' : 'd' + body.page,
      containerTag: foreignDocument ? 'foreign' : ctx.namespace, status: pending ? 'extracting' : 'done' }],
      pagination: { totalItems: changedTotal && body.page === 2 ? 3 : 2, totalPages: 2 } });
    return response({ error: 'unexpected' }, 500);
  };
  const sdk = supermemoryClient('fixture-scoped-key-not-real', transport);
  await verifySupermemoryScope(sdk, ctx.namespace);
  for (const status of [200, 401, 500]) { foreignStatus = status; await assert.rejects(() => verifySupermemoryScope(sdk, ctx.namespace), /isolation unverified/); }
  foreignStatus = 403; ok('live-scope contract requires explicit foreign denial and successful own profile/search; 401 and server errors cannot pass');
  projectedList = true;
  // This fixture has two rows across two pages; the projection probe requests
  // 100, so return a complete first page just for that negative filter request.
  const projectionTransport: typeof fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (new URL(String(url)).pathname === '/v3/documents/list' && body.containerTag?.endsWith('_denied')) return response({
      memories: [{ id: 'own', containerTag: foreignDocument ? 'foreign' : ctx.namespace }], pagination: { totalItems: 1, totalPages: 1 } });
    return transport(url, init);
  };
  await verifySupermemoryScope(supermemoryClient('fixture-scoped-key-not-real', projectionTransport), ctx.namespace);
  foreignDocument = true; await assert.rejects(() => verifySupermemoryScope(supermemoryClient('fixture-scoped-key-not-real', projectionTransport), ctx.namespace), /escaped/);
  foreignDocument = false; projectedList = false;
  ok('credential-scoped listing may return 200, but foreign returned documents are rejected');
  const lease = await createTrialSupermemoryKey(ctx.namespace, transport); assert.equal(lease.namespace, ctx.namespace); await lease.revoke();
  assert.ok(calls.some(c => c.route.endsWith('/test-key-id'))); ok('scoped key provisioning/revocation uses official SDK and singular namespace');
  const provider = createSupermemoryAdapter(ctx, transport, 'fixture-scoped-key-not-real');
  assert.equal((await provider.check()).ready, true); assert.equal((await provider.inventory() as any[]).length, 2);
  duplicate = true; await assert.rejects(() => provider.inventory(), /duplicate/); duplicate = false;
  changedTotal = true; await assert.rejects(() => provider.inventory(), /changed during pagination/); changedTotal = false;
  foreignDocument = true; await assert.rejects(() => provider.inventory(), /outside trial/); foreignDocument = false;
  pending = true; assert.equal((await provider.check()).ready, false); pending = false;
  await provider.profile!('current correction'); assert.ok(calls.some(c => c.route === '/v4/profile' && c.body.q === 'current correction'));
  ok('complete inventory, processing readiness and profile; duplicates, moving pagination and foreign records fail closed');
  const native = NativeRouteSchema.parse({ provider: 'supermemory', mechanism: 'official-capture-hooks', implementationRef: 'fixture',
    claude: { pluginDir: '/fixture' }, codex: { homeTemplate: '/fixture' }, readNamespaces: ['{{NAMESPACE}}'], provenanceNote: 'fixture' });
  assert.equal(nativeReadiness(native, ['codex'], ctx.namespace).ready, false);
  assert.equal(nativeReadiness(native, ['codex'], ctx.namespace, true).ready, true);
  writeNativeSupermemorySettings(path.join(root, 'worktree'), path.join(root, 'home'), ctx.namespace);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'home/.codex/supermemory.json'), 'utf8'));
  assert.equal(config.signalExtraction, undefined); assert.equal(config.captureEveryNTurns, undefined);
  ok('native Supermemory requires scope proof and keeps official capture defaults');
  delete process.env.OPENAI_API_KEY;
  assert.equal((await createGbrainAdapter(context('gbrain')).check()).ready, false);
  assert.equal(gbrainEnvironment(root, true).SUPERMEMORY_API_KEY, undefined);
  assert.equal(gbrainEnvironment(root, false).ANTHROPIC_API_KEY, undefined);
  ok('missing embedding credentials fail readiness and unrelated vendor keys never enter GBrain');
  const keyFile = path.join(root, 'gbrain.env');
  const testKey = 'sk-fixture-embedding-only-not-real';
  fs.writeFileSync(keyFile, `export OPENAI_API_KEY="${testKey}"\n`, { mode: 0o600 });
  const parentKey = process.env.OPENAI_API_KEY;
  assert.equal(readGbrainEmbeddingKey(keyFile), testKey);
  assert.equal(gbrainEnvironment(root, true, keyFile).OPENAI_API_KEY, testKey);
  assert.equal(gbrainEnvironment(root, false, keyFile).OPENAI_API_KEY, undefined);
  assert.equal(process.env.OPENAI_API_KEY, parentKey);
  fs.chmodSync(keyFile, 0o644); assert.throws(() => readGbrainEmbeddingKey(keyFile), /owner-only/); fs.chmodSync(keyFile, 0o600);
  fs.writeFileSync(keyFile, 'OPENAI_API_KEY=$(touch forbidden)\n'); assert.throws(() => readGbrainEmbeddingKey(keyFile), /invalid/);
  assert.equal(fs.existsSync(path.join(root, 'forbidden')), false);
  fs.writeFileSync(keyFile, `OPENAI_API_KEY=${testKey}\nOPENAI_API_KEY=${testKey}\n`); assert.throws(() => readGbrainEmbeddingKey(keyFile), /exactly one/);
  fs.writeFileSync(keyFile, `OPENAI_API_KEY=${testKey}\n`);
  const launchCtx = context('gbrain'); launchCtx.gbrainCredentialFile = keyFile;
  const launchHome = path.join(launchCtx.root, 'gbrain-home'); fs.mkdirSync(path.join(launchHome, '.gbrain'), { recursive: true });
  fs.writeFileSync(path.join(launchHome, '.gbrain/config.json'), JSON.stringify({ engine: 'pglite', database_path: path.join(launchHome, 'private.pglite') }));
  const launcherConfig = path.join(launchCtx.root, 'launcher.json'); fs.writeFileSync(launcherConfig, JSON.stringify(launchCtx));
  const fakeBinary = path.join(root, 'fake-gbrain');
  fs.writeFileSync(fakeBinary, `#!${process.execPath}\nconsole.log(JSON.stringify({keyMatches:process.env.OPENAI_API_KEY===${JSON.stringify(testKey)},noSupermemory:!process.env.SUPERMEMORY_API_KEY,home:process.env.HOME}));`, { mode: 0o700 });
  const launcherOutput = execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'analytical-runner.js'), 'gbrain-serve', '--config', launcherConfig], {
    env: { ...process.env, ANALYTICAL_GBRAIN_BIN: fakeBinary }, encoding: 'utf8', timeout: 10000 });
  assert.deepEqual(JSON.parse(launcherOutput), { keyMatches: true, noSupermemory: true, home: launchHome });
  assert.equal(launcherOutput.includes(testKey), false);
  assert.equal(process.env.OPENAI_API_KEY, parentKey);
  ok('credential file is parsed without shell execution and routed only to the isolated GBrain child; no parent export or raw key output');

  const conditions = { stages: [{ harness: 'codex', model: 'fixture', prompt: 'fixed origin' }], successorHarness: 'claude', successorModel: 'fixture', timeoutMs: 1000, maximumApprovedUsd: 1, mode: 'native' };
  freezeComparisonConditions(root, conditions); freezeComparisonConditions(root, conditions);
  for (const changed of [{ ...conditions, successorModel: 'different' }, { ...conditions, maximumApprovedUsd: 2 }, { ...conditions, stages: [{ ...conditions.stages[0], prompt: 'extra hint' }] }]) {
    assert.throws(() => freezeComparisonConditions(root, changed), /conditions differ/);
  }
  ok('cross-arm model, prompt and budget drift is rejected');
  const graphCtx = context('graphify'); graphCtx.allowPaidOperations = false; graphCtx.allowExternalExport = false;
  const graph = graphifyStore(graphCtx);
  assert.match(graph.call(['--version']), /0\.9\.50/);
  graph.write('example.py', 'def correct_denominator(users):\n    return len(set(users))\n');
  assert.throws(() => graph.write('../escape.md', 'no'), /filename/);
  graph.extract(true);
  assert.match(graph.query('correct_denominator'), /correct_denominator/);
  assert.equal((await createProvider(graphCtx).check()).ready, false);
  const configuredGraphCtx: AdapterContext = { ...graphCtx, allowPaidOperations: true, allowExternalExport: true, graphify: { binary: 'graphify', version: '0.9.50', backend: 'claude', model: 'fixture-model-not-called' } };
  process.env.ANTHROPIC_API_KEY = 'fixture-key-not-used';
  assert.equal((await createProvider(configuredGraphCtx).check()).ready, false);
  const extractionFile = path.join(graph.root, 'extraction.json');
  const receipt = JSON.parse(fs.readFileSync(extractionFile, 'utf8'));
  fs.writeFileSync(extractionFile, JSON.stringify({ ...receipt, codeOnly: false, backend: 'claude', model: 'fixture-model-not-called' }));
  // Contract-only fabricated receipt: test invalidation, not semantic extraction quality.
  assert.equal((await createProvider(configuredGraphCtx).check()).ready, true);
  graph.write('new-note.md', 'A source changed after extraction.');
  assert.equal((await createProvider(configuredGraphCtx).check()).ready, false);
  graph.save({ question: 'Denominator?', answer: 'Use distinct eligible users', outcome: 'corrected', correction: 'Event rows were the wrong grain' });
  assert.ok(graph.sources().some(s => s.id.startsWith('memory/')));
  graph.reflect(); assert.ok(fs.existsSync(path.join(graph.output, 'LESSONS.md')));
  assert.throws(() => graph.extract(), /authorization/);
  fs.symlinkSync(os.tmpdir(), path.join(graph.corpus, 'foreign'));
  assert.throws(() => graph.sources(), /symlink/);
  ok('installed Graphify performs actual AST extraction/query/save-result/reflection in a private store; AST-only never passes semantic readiness');
  console.log(`${groups} competitor groups passed; no paid provider/model request made.`);
} finally {
  for (const k of Object.keys(process.env)) if (!(k in previous)) delete process.env[k];
  Object.assign(process.env, previous); fs.rmSync(root, { recursive: true, force: true });
}
