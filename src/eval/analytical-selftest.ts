import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { TaskSchema, appendHumanLog, evidenceText, exclusiveJson, ownedPath, sha256, type AdapterContext } from './analytical-contract.js';
import { syntheticAnalyticalFixture, CORRECT_SQL } from './analytical-fixture.js';
import { createLocalAdapter, createSupermemoryAdapter, gbrainEnvironment } from './analytical-providers.js';
import { executeSql, gradeAnswer } from './analytical-oracle.js';
import { NativeRouteSchema, nativeReadiness } from './analytical-native.js';
import { prepareRun, runTrial } from './analytical-runner.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-analytical-selftest-'));
let groups = 0;
function ok(name: string) { groups++; console.log(`ok ${groups}: ${name}`); }
function context(arm: AdapterContext['arm'] = 'ledger', mode: AdapterContext['mode'] = 'evidence-parity-diagnostic') {
  const directory = path.join(root, crypto.randomUUID()); fs.mkdirSync(directory);
  const namespace = `ledger_eval_${crypto.randomBytes(16).toString('hex')}`;
  exclusiveJson(path.join(directory, 'ownership.json'), { namespace });
  const traces: unknown[] = [];
  const ctx: AdapterContext = { arm, root: directory, namespace, mode, task: syntheticAnalyticalFixture().task,
    trace: (operation: string, detail: unknown) => traces.push({ operation, detail }), allowExternalExport: false, allowPaidOperations: false };
  return { ctx, traces };
}
try {
  const { task, oracle } = syntheticAnalyticalFixture();
  assert.throws(() => TaskSchema.parse({ ...task, evidence: [...task.evidence, task.evidence[0]] }), /duplicate/);
  assert.throws(() => ownedPath(root, '../escape')); assert.throws(() => ownedPath(root, '/etc/passwd'));
  fs.symlinkSync(os.tmpdir(), path.join(root, 'symlink')); assert.throws(() => ownedPath(root, 'symlink/escape'));
  ok('task identities, traversal and symlink boundaries');
  const rows = executeSql(task.data, CORRECT_SQL);
  assert.equal(rows.length, 2);
  for (const sql of ['DELETE FROM events', 'ATTACH DATABASE "/tmp/forbidden" AS other', 'SELECT load_extension("x")', 'SELECT 1; SELECT 2']) assert.throws(() => executeSql(task.data, sql));
  ok('real SQLite executes the frozen dataset and rejects mutation/extension/multiple-statement attempts');
  assert.equal(oracle.kind, 'sql'); if (oracle.kind !== 'sql') throw new Error('fixture');
  const answer = { definitionId: 'd2', sql: CORRECT_SQL, result: rows, affected: oracle.affected, evidenceIds: oracle.requiredEvidence };
  const trace = [{ operation: 'query_data', detail: { success: true, sqlHash: sha256(CORRECT_SQL) } }];
  assert.equal((await gradeAnswer(task, oracle, answer, trace)).jointSuccess, true);
  assert.equal((await gradeAnswer(task, oracle, answer, [])).jointSuccess, false);
  assert.equal((await gradeAnswer(task, oracle, { ...answer, definitionId: 'd3' }, trace)).jointSuccess, false);
  assert.equal((await gradeAnswer(task, oracle, { ...answer, affected: [] }, trace)).jointSuccess, false);
  ok('joint success requires actual execution, accepted definition and affected-result set');
  const fixedSql = rows.map((r: any) => `SELECT '${r.cohort}' cohort, ${r.numerator} numerator, ${r.denominator} denominator, ${r.conversion} conversion`).join(' UNION ALL ');
  const fixedGrade: any = await gradeAnswer(task, oracle, { ...answer, sql: fixedSql }, [{ operation: 'query_data', detail: { success: true, sqlHash: sha256(fixedSql) } }]);
  assert.equal(fixedGrade.resultCorrect, true); assert.equal(fixedGrade.holdoutsCorrect, false); assert.equal(fixedGrade.jointSuccess, false);
  ok('hidden data perturbations reject a hard-coded result that matches the visible fixture');
  const { ctx } = context(); const local = createLocalAdapter(ctx); await local.ingest();
  const found: any = await local.search('HiAstro trial conversion', 30);
  assert.ok(found.some((x: any) => x.id === 'd2' && x.status === 'stable'));
  assert.ok(found.some((x: any) => x.id === 'd3' && x.status === 'draft'));
  assert.equal((await local.read('d2') as any).body, evidenceText(task.evidence.find(e => e.id === 'd2')!).trim());
  await assert.rejects(() => local.read('../../secret'));
  const second = createLocalAdapter(context().ctx); assert.deepEqual(await second.inventory(), []);
  ok('real Ledger Markdown/query implementation is isolated and preserves full source status/content');
  const native = createLocalAdapter(context('ledger', 'native').ctx); await assert.rejects(() => native.ingest(), /native capture forbids/);
  ok('native mode refuses controller-seeded evidence');
  const log = path.join(root, 'human.jsonl');
  appendHumanLog(log, { participant: 'pm', phase: 'capture', startedAt: '2026-09-10T00:00:00Z', endedAt: '2026-09-10T00:01:00Z', note: 'curated evidence' });
  assert.throws(() => appendHumanLog(log, { participant: 'pm', phase: 'review', startedAt: '2026-09-10T00:00:30Z', endedAt: '2026-09-10T00:02:00Z', note: 'overlap' }), /overlapping/);
  assert.equal(JSON.parse(fs.readFileSync(log, 'utf8')).activeSeconds, 60);
  ok('phase time counts active effort and rejects double-counted participant intervals');
  const previous = process.env.SUPERMEMORY_API_KEY; process.env.SUPERMEMORY_API_KEY = 'contract-test-credential-not-real';
  try {
    const { ctx: remoteCtx } = context('supermemory'); remoteCtx.allowExternalExport = true; remoteCtx.allowPaidOperations = true;
    remoteCtx.task = { ...task, evidence: [task.evidence[0]] };
    const requests: any[] = []; const store = new Map<string, any>();
    const request: typeof fetch = async (input, init) => {
      const route = new URL(String(input)).pathname; const body = init?.body ? JSON.parse(String(init.body)) : undefined; requests.push({ route, body });
      let output: any;
      if (route === '/v3/documents/list') output = { memories: [...store.values()], pagination: { totalItems: store.size, totalPages: 1 } };
      else if (route === '/v3/documents') { const id = 'remote-doc'; store.set(id, { id, ...body, raw: body.content, status: 'done', containerTags: [body.containerTag] }); output = { id, status: 'queued' }; }
      else if (route === '/v4/search') output = { results: [{ id: 'memory', memory: 'source', documents: [{ id: 'remote-doc' }] }] };
      else output = store.get(route.split('/').at(-1)!);
      return new Response(JSON.stringify(output), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const adapter = createSupermemoryAdapter(remoteCtx, request); await adapter.ingest();
    await adapter.search('conversion', 10); assert.equal((await adapter.read('d1') as any).raw, evidenceText(task.evidence[0]));
    const search = requests.find(x => x.route === '/v4/search'); assert.equal(search.body.containerTag, remoteCtx.namespace); assert.equal(search.body.searchMode, 'hybrid');
    assert.equal(requests.find(x => x.route === '/v3/documents').body.documentDate, task.evidence[0].recordedAt);
    store.get('remote-doc').containerTags = ['foreign']; await assert.rejects(() => adapter.search('conversion', 10), /outside trial/);
    ok('Supermemory HTTP contract uses scoped hybrid retrieval, historical documentDate, exact source bytes and rejects foreign documents (transport fixture; no live vendor result)');
    let calls = 0;
    const blocked = createSupermemoryAdapter(context('supermemory').ctx, async () => { calls++; throw new Error('must not call'); });
    assert.equal((await blocked.check()).ready, false); assert.equal(calls, 0);
    ok('missing external-export permission prevents even a readiness network request');
  } finally { if (previous === undefined) delete process.env.SUPERMEMORY_API_KEY; else process.env.SUPERMEMORY_API_KEY = previous; }
  const env = gbrainEnvironment(root, false); assert.equal(env.HOME, path.join(root, 'gbrain-home')); assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.DATABASE_URL, undefined);
  ok('GBrain child environment cannot inherit production storage pointers or paid keys when disabled');
  const route = NativeRouteSchema.parse({ provider: 'supermemory', mechanism: 'official-capture-hooks', implementationRef: 'test-pinned-source',
    claude: { pluginDir: '/not-run' }, codex: { homeTemplate: '/not-run' }, readNamespaces: ['{{NAMESPACE}}'], provenanceNote: 'contract-only' });
  assert.equal(nativeReadiness(route, ['codex'], ctx.namespace).ready, false);
  assert.equal(nativeReadiness({ ...route, readNamespaces: ['production'] }, ['claude'], ctx.namespace).ready, false);
  assert.throws(() => NativeRouteSchema.parse({ ...route, claude: { mcpServers: { x: { command: 'x', env: { SUPERMEMORY_API_KEY: 'secret' } } } } }), /credentials/);
  assert.equal(nativeReadiness(NativeRouteSchema.parse({ provider: 'ledger', mechanism: 'official-capture-hooks', implementationRef: 'frozen-build', claude: {}, codex: {}, readNamespaces: ['{{NAMESPACE}}'], provenanceNote: 'Actual hooks are constructed by the isolated native helper.' }), ['claude', 'codex'], ctx.namespace).ready, true);
  ok('unsafe native fallback namespaces and embedded credentials fail closed');
  const frozen = path.join(root, 'frozen'); const manifest = prepareRun(frozen);
  assert.equal(manifest.taskHash, sha256(fs.readFileSync(path.join(frozen, 'task.json')))); assert.throws(() => prepareRun(frozen));
  const unavailable = await runTrial(frozen, { arm: 'ledger', mode: 'native', harness: 'claude', model: 'explicit-unrun-model', 'timeout-ms': '1000', 'allow-paid': 'false' });
  assert.equal(unavailable.status, 'unavailable-before-launch'); assert.equal(unavailable.jointSuccessDenominator, false); assert.equal(unavailable.humanTime, 'missing-not-zero');
  const missingPolicy = await runTrial(frozen, { arm: 'ledger', mode: 'native', harness: 'claude', model: 'explicit-unrun-model', 'timeout-ms': '1000', 'allow-paid': 'true' });
  assert.equal(missingPolicy.status, 'unavailable-before-launch'); assert.match(missingPolicy.reason!, /cost policy required/);
  assert.equal(missingPolicy.dollarCeilingEnforced, false);
  assert.ok(!fs.readFileSync(path.join(missingPolicy.trialDir, 'trace.jsonl'), 'utf8').includes('stage-start'));
  ok('frozen runs refuse overwrite and no-budget runs retain explicit unavailable status without launching a model');
  const mcpContext = context(); await createLocalAdapter(mcpContext.ctx).ingest();
  const config = path.join(mcpContext.ctx.root, 'mcp.json'); const taskFile = path.join(mcpContext.ctx.root, 'task.json'); exclusiveJson(taskFile, task);
  exclusiveJson(config, { ...mcpContext.ctx, trace: undefined, task: undefined, taskFile, traceFile: path.join(mcpContext.ctx.root, 'trace.jsonl'), role: 'successor', trialDir: mcpContext.ctx.root });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'analytical-runner.js'), 'serve', '--config', config], stderr: 'pipe' });
  const client = new Client({ name: 'contract-test', version: '1' });
  try {
    await client.connect(transport);
    const source = await client.callTool({ name: 'read_source', arguments: { id: 'd2' } }); assert.equal(source.isError, undefined);
    const result = await client.callTool({ name: 'query_data', arguments: { sql: CORRECT_SQL } }); assert.equal(result.isError, undefined);
    const submit = await client.callTool({ name: 'submit_answer', arguments: { answer } }); assert.equal(submit.isError, undefined);
    const duplicate = await client.callTool({ name: 'submit_answer', arguments: { answer } }); assert.equal(duplicate.isError, true);
    assert.ok(fs.readFileSync(path.join(mcpContext.ctx.root, 'trace.jsonl'), 'utf8').includes('query_data'));
  } finally { await client.close(); }
  ok('real subprocess MCP round trip retrieves evidence, executes SQL, records trace and prevents answer replacement');
  for (const role of ['origin', 'successor']) {
    const { ctx: nativeCtx } = context('ledger', 'native');
    const file = path.join(nativeCtx.root, 'task.json'); exclusiveJson(file, task);
    const cfg = path.join(nativeCtx.root, 'mcp.json'); exclusiveJson(cfg, { ...nativeCtx, trace: undefined, task: undefined,
      taskFile: file, traceFile: path.join(nativeCtx.root, 'trace.jsonl'), role, trialDir: nativeCtx.root });
    const connection = new Client({ name: 'native-boundary-test', version: '1' });
    try {
      await connection.connect(new StdioClientTransport({ command: process.execPath,
        args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'analytical-runner.js'), 'serve', '--config', cfg], stderr: 'pipe' }));
      const read = await connection.callTool({ name: 'read_artifact', arguments: { id: 'corrected-query' } }); assert.equal(read.isError, true);
      const tools = await connection.listTools(); assert.ok(!tools.tools.some(t => t.name === 'search' || t.name === 'read_source'));
    } finally { await connection.close(); }
  }
  ok('native origin cannot read a future correction artifact and successor cannot receive controller artifact backfill');
  const codingDir = path.join(root, 'coding-oracle'); fs.mkdirSync(codingDir);
  const codingTask = TaskSchema.parse({ ...task, kind: 'coding-handoff', coding: { sourceRepo: codingDir,
    commit: 'a'.repeat(40), sourceRecord: 'test:record', sourceArtifacts: ['test:prd'] } });
  const codingOracle: import('./analytical-contract.js').Oracle = { kind: 'coding', requiredEvidence: ['d2'],
    commands: [{ argv: [process.execPath, 'independent.cjs'], timeoutMs: 5000 }],
    independentFiles: [{ relativePath: 'independent.cjs', content: 'const assert=require("node:assert/strict"); assert.equal(require("./implementation.cjs")(5),10);' }] };
  fs.writeFileSync(path.join(codingDir, 'implementation.cjs'), 'module.exports=x=>x;');
  assert.equal((await gradeAnswer(codingTask, codingOracle, { evidenceIds: ['d2'] }, [], codingDir)).jointSuccess, false);
  fs.writeFileSync(path.join(codingDir, 'implementation.cjs'), 'module.exports=x=>x*2;');
  assert.equal((await gradeAnswer(codingTask, codingOracle, { evidenceIds: ['d2'] }, [], codingDir)).jointSuccess, true);
  const missingReview = await gradeAnswer(codingTask, { ...codingOracle, commands: [{ argv: [process.execPath, '-e', 'process.exit(78)'], timeoutMs: 5000 }] }, { evidenceIds: ['d2'] }, [], codingDir);
  assert.equal('gradingStatus' in missingReview && missingReview.gradingStatus, 'not-evaluated'); assert.equal(missingReview.jointSuccess, false);
  assert.equal(fs.existsSync(path.join(codingDir, 'independent.cjs')), false);
  ok('coding oracle runs independent subprocess tests, distinguishes incomplete/completed implementation and removes only its injected test');
  console.log(`analytical benchmark: ${groups} contract groups passed. No live model or external provider trial ran.`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
