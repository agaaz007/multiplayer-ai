import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exclusiveJson, json, ownedPath, sha256, type AnalyticalTask } from './analytical-contract.js';
import { readGbrainEmbeddingKey } from './analytical-credentials.js';
import { copyFrozenDirectory, verifyFrozenDirectory, writeNativeSupermemorySettings } from './analytical-native.js';
import { createTrialSupermemoryKey, supermemoryClient } from './analytical-supermemory.js';
import { prepareLedgerNative, prepareLedgerStage, captureLedgerStage, exportLedgerNative, closeLedgerNative, type LedgerNativeState } from './analytical-ledger-native.js';
import { graphifyStore } from './analytical-graphify.js';
import { spawnHarness } from './harness.js';
import { SequenceTaskSchema, PilotLimitsSchema, type SequenceTask } from './sequence-contract.js';
import { verifySequenceContent } from './sequence-freeze.js';
import { gradeFrozenSequenceSql } from './sequence-grade.js';
import { nativeSequenceTransport, connectSequenceTransport } from './sequence-transport.js';
import { runSequenceCodex, type SequenceMcp } from './sequence-codex.js';
import { serveStageTools, type StageToolConfig } from './sequence-mcp.js';
import { createBudget, reserve, reconcile, recordSubscriptionUsage, summarizeBudget, tokensBound, PRICE_BOUNDS } from './sequence-budget.js';
import { buildReport } from './sequence-report.js';

/**
 * Four-stage cumulative-work pilot dispatcher: A produces, B continues and corrects, C builds a
 * related task on A and B, D carries later evidence forward and inherits C. One sequence is one
 * (task, arm) pair; every stage is a fresh simulated user in a fresh Codex session, home and
 * workspace, inside a kernel-verified seatbelt. Only the arm's own team store survives between
 * stages. The fresh-agent arm has no store at all.
 */
const STAGES = ['A', 'B', 'C', 'D'] as const;
type Stage = typeof STAGES[number];
const ARMS = ['ledger', 'supermemory', 'gbrain', 'graphify', 'fresh-agent'] as const;
type Arm = typeof ARMS[number];
const PERSONS: Record<Stage, string> = { A: 'sim-user-a', B: 'sim-user-b', C: 'sim-user-c', D: 'sim-user-d' };
const TASK_FILES: Record<string, { task: string; oracle?: string }> = {
  'real-hiastro': { task: 'controller/analysis-sequence.json', oracle: 'controller/analysis-oracles.json' },
  'real-analysis-tab': { task: 'controller/coding-sequence.json' },
};
const CODING_CHECKS = [
  { id: 'typecheck', argv: ['pnpm', '-r', 'typecheck'], timeoutMs: 600_000 },
  { id: 'dashboard-analysis-tests', argv: ['pnpm', '--filter', '@beirut/dashboard', 'test:analysis'], timeoutMs: 300_000 },
  { id: 'api-analysis-workbench-tests', argv: ['pnpm', '--filter', '@beirut/api', 'test:analysis-workbench'], timeoutMs: 300_000 },
];
const filename = fileURLToPath(import.meta.url);
const runtimeOf = () => path.dirname(path.dirname(filename));
const argsOf = (argv: string[]) => {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new Error('use --name value arguments');
    values[argv[i].slice(2)] = argv[i + 1];
  }
  return values;
};
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, json(value), { mode: 0o600 }); };
const appendJsonl = (file: string, value: unknown) => fs.appendFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
const now = () => new Date().toISOString();
const git = (cwd: string, args: string[], env: Record<string, string> = {}) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
  env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...env } }).toString().trim();
function hashTree(root: string, filter = (f: string) => f.endsWith('.js')): Record<string, string> {
  const out: Record<string, string> = {};
  (function walk(dir: string) { for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else if (filter(f.name)) out[path.relative(root, p)] = sha256(fs.readFileSync(p)); } })(root);
  return out;
}
function readEnvValue(file: string, name: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error(`${name} file must be an owner-only regular file`);
  const m = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*?)\\s*$`))).filter(Boolean);
  if (m.length !== 1) throw new Error(`${name} file needs exactly one assignment`);
  const value = m[0]![1].replace(/^['"]|['"]$/g, '');
  if (!/^[A-Za-z0-9_-]{20,}$/.test(value)) throw new Error(`${name} value is not a plain credential`);
  return value;
}
const clean = (text: string, secrets: string[]) => secrets.reduce((v, s) => (s ? v.split(s).join('[redacted]') : v), text).replace(/(?:sk-|sm_)[\w-]{20,}/g, '[redacted]');

// ---------------------------------------------------------------- manifest

interface PilotManifest {
  schema: 'sequence-pilot/v1'; createdAt: string; contentRoot: string; contentFreezeSha256: string; realDataSha256: string;
  runtimeDir: string; runtimeHashes: Record<string, string>; limits: any; arms: Arm[]; tasks: string[]; persons: Record<Stage, string>;
  reasoningEffort: 'medium'; promptTemplateSha256: string; harness: { codex: string; node: string };
  providers: Record<string, unknown>; caFile: string; pnpmStore: string; codingBaselineChecks: unknown; priceBounds: typeof PRICE_BOUNDS;
  credentialFiles: Record<string, string>; fairnessNotes: string[];
}
const PROMPT_TEMPLATE = `{{TASK_PROMPT}}

--- Session context (identical for every product; simulated identities are labelled) ---
You are {{PERSON}}, the {{STAGE}}-stage teammate on this team. This is a fresh session in a fresh workspace: {{WORKTREE}}. Earlier teammates worked in their own separate sessions and workspaces; nothing from their workspaces is copied here. Whatever your team's configured product delivers is the only way their work can reach you.
Files provided for this stage in your workspace: {{INPUTS}}
{{ARM_INSTRUCTIONS}}
Task tools (MCP server "stage"): query_data runs one read-only SQL query over the frozen events table; read_artifact reads a task artifact; submit_answer submits your final structured answer exactly once. {{CODING_NOTE}}
Rules: stay inside your workspace and home directory and do not try to read other directories. Do not claim a check you did not run. Save your work through the configured product before calling submit_answer, then call submit_answer once with the fields the task asks for. Finish within the session time limit of {{MINUTES}} minutes.`;
const ARM_INSTRUCTIONS: Record<Arm, string> = {
  ledger: 'Team memory product: Ledger (MCP server "ledger" plus automatic session-capture hooks). Use ledger_brief, ledger_search, ledger_investigation, ledger_threads, ledger_resume and ledger_records to find earlier teammates\' work, and ledger_record_definition / ledger_record_finding / ledger_record_decision / ledger_record_change / ledger_thread_note to record yours with original evidence, assumptions, exact queries and source IDs. Keep proposals separate from accepted knowledge. Your transcript and workspace files are captured automatically; a predecessor\'s code snapshot is fetched with the bootstrap commands shown by ledger_resume (git fetch origin <ref>, then check it out).',
  supermemory: 'Team memory product: Supermemory (official Codex plugin: automatic capture hooks plus MCP server "supermemory"). Use its native memory tools (for example search_memory) to find earlier teammates\' work; the plugin captures this session automatically when it ends. Save explicit notes with its memory tools when you want a precise record of evidence, exact queries, code and unfinished work. Preserve source references and accepted versus proposed corrections.',
  gbrain: 'Team memory product: GBrain (MCP server "gbrain", a shared team brain). Nothing is captured automatically: use put_page to save your findings, exact queries, code and unfinished work as pages (with frontmatter title and tags), and query, search, get_page and list_pages to find earlier teammates\' pages. Preserve source references and accepted versus proposed corrections.',
  graphify: 'Team memory product: Graphify (graphify_* tools on the "stage" server). Nothing is captured automatically: save your notes, exact queries, code and unfinished work with graphify_write_source, run graphify_extract after saving so they become searchable, and use graphify_query, graphify_list_sources, graphify_read_source, graphify_affected and graphify_explain to find earlier teammates\' work. Record feedback with graphify_save_result. Preserve source references and accepted versus proposed corrections.',
  'fresh-agent': 'No team memory product is configured for this session and no earlier teammate\'s output is available to you (control condition). Work from the files in your workspace and the task tools; where the task says to save through your product, save your artifacts as files in your workspace instead.',
};
function renderPrompt(m: PilotManifest, arm: Arm, stage: Stage, task: AnalyticalTask, worktree: string, inputs: string[]) {
  const values: Record<string, string> = { TASK_PROMPT: task.prompt, PERSON: m.persons[stage], STAGE: stage, WORKTREE: worktree, INPUTS: inputs.join(', '),
    ARM_INSTRUCTIONS: ARM_INSTRUCTIONS[arm], MINUTES: String(Math.round(m.limits.stageTimeoutMs / 60_000)),
    CODING_NOTE: task.kind === 'coding-handoff' ? 'The repository in your workspace is the pinned baseline with dependencies installed offline (pnpm) and @beirut/shared built; use the repository\'s own scripts for checks.' : '' };
  return PROMPT_TEMPLATE.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => { if (!(k in values)) throw new Error(`prompt placeholder ${k}`); return values[k]; });
}

// ---------------------------------------------------------------- prepare

async function prepare(opts: Record<string, string>) {
  const root = path.resolve(opts.root); fs.mkdirSync(root, { recursive: false, mode: 0o700 });
  const contentRoot = fs.realpathSync(opts.content);
  const freeze = verifySequenceContent(contentRoot, path.join(contentRoot, 'content-freeze.json'));
  const limits = PilotLimitsSchema.parse(readJson(opts.limits));
  const arms = (opts.arms ?? ARMS.join(',')).split(',') as Arm[];
  for (const a of arms) if (!(ARMS as readonly string[]).includes(a)) throw new Error(`unknown arm ${a}`);
  const tasks = (opts.tasks ?? freeze.taskIds.join(',')).split(',');
  for (const t of tasks) if (!freeze.taskIds.includes(t) || !TASK_FILES[t]) throw new Error(`task ${t} is not in the content freeze`);
  const runtimeDir = path.join(root, 'runtime');
  fs.cpSync(runtimeOf(), runtimeDir, { recursive: true, errorOnExist: true, force: false });
  const projectRoot = path.dirname(runtimeOf());
  fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  exclusiveJson(path.join(root, 'package.json'), { private: true, type: 'module' });
  fs.mkdirSync(path.join(root, 'routes'), { mode: 0o700 });
  const providers: Record<string, unknown> = {};
  const credentialFiles: Record<string, string> = {};
  if (arms.includes('supermemory')) {
    const route = readJson(opts['supermemory-route']);
    const template = path.join(root, 'routes', 'supermemory-codex-template');
    const hashes = copyFrozenDirectory(route.codex.homeTemplate, template);
    readEnvValue(opts['supermemory-env-file'], 'SUPERMEMORY_API_KEY'); credentialFiles.supermemory = opts['supermemory-env-file'];
    providers.supermemory = { implementationRef: route.implementationRef, template, templateHashes: hashes, stopHook: 'synchronous host dispatch; unchanged official flush.js',
      containerScope: 'one scoped one-day key per sequence, container tag = sequence namespace, revoked at sequence end', capture: 'official plugin hooks (SessionStart, UserPromptSubmit recall, PreToolUse, Stop flush) plus native MCP tools' };
  }
  if (arms.includes('gbrain') || arms.includes('graphify')) { readGbrainEmbeddingKey(opts['gbrain-env-file']); credentialFiles.openai = opts['gbrain-env-file']; }
  if (arms.includes('gbrain')) {
    const version = execFileSync('gbrain', ['--version'], { encoding: 'utf8', timeout: 60_000 }).trim();
    if (!/0\.18\.2/.test(version)) throw new Error('GBrain must be the pinned 0.18.2');
    providers.gbrain = { version, engine: 'pglite', embedding: 'text-embedding-3-large/1536 via OPENAI_API_KEY (benchmark credential, outside the sandbox)', capture: 'agent-authored pages through native MCP put_page; no automatic transcript capture; put_page embeds on write, controller runs `gbrain embed --all` after a stage only if coverage is incomplete (indexing, disclosed)' };
  }
  if (arms.includes('graphify')) {
    const route = readJson(opts['graphify-route']);
    const version = execFileSync(route.graphify.binary, ['--version'], { encoding: 'utf8', timeout: 60_000 }).trim();
    if (!version.endsWith(route.graphify.version)) throw new Error('Graphify version differs from the route');
    providers.graphify = { ...route.graphify, extraction: 'official CLI extract with the OpenAI backend; controller re-extracts after a stage only if saved sources changed and the agent did not (indexing, disclosed)', limits: { maxOutputTokens: 4096, maxRetries: 0, apiTimeoutSeconds: 120 } };
  }
  if (arms.includes('ledger')) providers.ledger = { build: 'this pilot runtime (frozen copy of dist)', capture: 'official hooks + helper transcript capture + WIP snapshot to an owned bare remote; MCP record tools; classifier and transcript-model extraction disabled', database: 'owned local Postgres database per sequence, allowed through the seatbelt for this arm only' };
  const caFile = path.join(root, 'routes', 'public-ca.pem'); fs.copyFileSync(opts['ca-file'], caFile);
  const pnpmStore = execFileSync('pnpm', ['store', 'path'], { encoding: 'utf8' }).trim();
  // Coding baseline compatibility checks on a scratch extraction, so a stage's check results have a known pre-state.
  let codingBaselineChecks: unknown = null;
  if (tasks.includes('real-analysis-tab') && opts['coding-baseline'] !== 'false') {
    const scratch = path.join(root, 'baseline-check'); fs.mkdirSync(scratch, { mode: 0o700 });
    const prep = await prepareCodingWorktree(contentRoot, scratch, pnpmStore);
    codingBaselineChecks = { preparation: prep, checks: await runCodingChecks(scratch, path.join(root, 'baseline-check-home')) };
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const manifest: PilotManifest = { schema: 'sequence-pilot/v1', createdAt: now(), contentRoot, contentFreezeSha256: sha256(fs.readFileSync(path.join(contentRoot, 'content-freeze.json'))),
    realDataSha256: freeze.realData.sha256, runtimeDir, runtimeHashes: hashTree(runtimeDir), limits, arms, tasks, persons: PERSONS, reasoningEffort: 'medium',
    promptTemplateSha256: sha256(PROMPT_TEMPLATE + JSON.stringify(ARM_INSTRUCTIONS)), harness: { codex: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(), node: process.version },
    providers, caFile, pnpmStore, codingBaselineChecks, priceBounds: PRICE_BOUNDS, credentialFiles,
    fairnessNotes: ['Same model, reasoning effort, prompts, inputs, tools, time limit and seatbelt for every arm; only the product paragraph of the prompt and the product\'s own MCP servers/hooks differ.',
      'Simulated users A-D are distinct git identities, homes and sessions on one laptop; this does not establish cross-account permissions or cross-laptop delivery.',
      'The Ledger arm alone may reach local Postgres (its team store); the other arms reach their stores over HTTPS (Supermemory) or through controller-side servers outside the sandbox (GBrain, Graphify).',
      'Controller-run indexing after a stage (Ledger helper capture, Supermemory processing wait, GBrain embed on incomplete coverage, Graphify extraction on changed sources) is the product\'s background process, measured and disclosed; no content is written on an agent\'s behalf.',
      'Paid provider usage is charged to one shared allowance at conservative upper bounds; Codex subscription tokens are reported separately.'] };
  exclusiveJson(path.join(root, 'manifest.json'), manifest);
  createBudget(path.join(root, 'budget.json'), limits.maximumApprovedUsd, limits.authorization);
  fs.mkdirSync(path.join(root, 'sequences'), { mode: 0o700 });
  return { root, manifest: path.join(root, 'manifest.json'), arms, tasks, runtimeFiles: Object.keys(manifest.runtimeHashes).length, codingBaselineChecks };
}
function loadPilot(root: string) {
  const m: PilotManifest = readJson(path.join(root, 'manifest.json'));
  if (m.schema !== 'sequence-pilot/v1') throw new Error('invalid pilot manifest');
  verifySequenceContent(m.contentRoot, path.join(m.contentRoot, 'content-freeze.json'));
  if (JSON.stringify(hashTree(m.runtimeDir)) !== JSON.stringify(m.runtimeHashes)) throw new Error('frozen pilot runtime changed');
  return m;
}
async function prepareCodingWorktree(contentRoot: string, worktree: string, pnpmStore: string) {
  const started = Date.now();
  execFileSync('tar', ['xf', path.join(contentRoot, 'inputs', 'coding-baseline.tar'), '-C', worktree], { timeout: 120_000 });
  git(worktree, ['init', '-q']); git(worktree, ['add', '-A']);
  const fixed = { GIT_AUTHOR_NAME: 'frozen-baseline', GIT_AUTHOR_EMAIL: 'baseline@evaluation.invalid', GIT_COMMITTER_NAME: 'frozen-baseline', GIT_COMMITTER_EMAIL: 'baseline@evaluation.invalid', GIT_AUTHOR_DATE: '2026-09-10T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-10T00:00:00Z' };
  git(worktree, ['-c', 'user.name=frozen-baseline', '-c', 'user.email=baseline@evaluation.invalid', 'commit', '-q', '-m', 'Frozen pinned baseline 61b8945693eea3a546123667616c937abea3a210 (reconstructed tree, fresh metadata)'], fixed);
  fs.appendFileSync(path.join(worktree, '.git', 'info', 'exclude'), '.claude/\n.sequence-own-canary\n.mcp/\n');
  const env = { PATH: process.env.PATH!, HOME: path.join(path.dirname(worktree), 'prep-home'), LANG: 'en_US.UTF-8', CI: '1' }; fs.mkdirSync(env.HOME, { recursive: true });
  // pnpm derives its store from HOME; the preparation home is private, so the machine store is passed explicitly.
  const install = await spawnHarness({ cmd: 'pnpm', args: ['install', '--offline', '--frozen-lockfile', '--reporter=silent', '--store-dir', pnpmStore], cwd: worktree, env, timeoutMs: 600_000 });
  const shared = await spawnHarness({ cmd: 'pnpm', args: ['--filter', '@beirut/shared', 'build'], cwd: worktree, env, timeoutMs: 300_000 });
  if (install.exitCode !== 0 || shared.exitCode !== 0) throw new Error(`coding baseline preparation failed: install=${install.exitCode} shared=${shared.exitCode} ${shared.stderr.slice(-400)}`);
  return { baselineCommit: git(worktree, ['rev-parse', 'HEAD']), tree: git(worktree, ['rev-parse', 'HEAD^{tree}']), installMs: install.wallMs, sharedBuildMs: shared.wallMs, clean: git(worktree, ['status', '--porcelain']) === '' };
}
async function runCodingChecks(worktree: string, home: string) {
  fs.mkdirSync(home, { recursive: true });
  const results = [];
  for (const check of CODING_CHECKS) {
    const r = await spawnHarness({ cmd: check.argv[0], args: check.argv.slice(1), cwd: worktree, env: { PATH: process.env.PATH!, HOME: home, LANG: 'en_US.UTF-8', CI: '1', LEDGER_EVAL: '1' }, timeoutMs: check.timeoutMs });
    results.push({ id: check.id, argv: check.argv, exitCode: r.exitCode, timedOut: r.timedOut, wallMs: r.wallMs, stdoutTail: r.stdout.slice(-3000), stderrTail: r.stderr.slice(-3000) });
  }
  return results;
}

// ---------------------------------------------------------------- one sequence

interface SequenceState {
  schema: 'sequence-run/v1'; task: string; arm: Arm; namespace: string; dir: string; startedAt: string; endedAt?: string;
  stages: Record<string, unknown>; store: Record<string, unknown>; cleanup: Record<string, unknown>; failures: string[];
}
type StageSpec = { stage: Stage; task: AnalyticalTask; inputs: { relativePath: string; content: string }[] };
async function runSequence(root: string, taskId: string, arm: Arm, label?: string, smokeStages?: StageSpec[]) {
  const m = loadPilot(root);
  if (!m.arms.includes(arm) || (!smokeStages && !m.tasks.includes(taskId))) throw new Error('task/arm not in the frozen pilot');
  const stagesToRun: StageSpec[] = smokeStages ?? (SequenceTaskSchema.parse(readJson(path.join(m.contentRoot, TASK_FILES[taskId].task))) as SequenceTask).stages.map(s => ({ stage: s.stage as Stage, task: s.task, inputs: s.inputs }));
  const seqDir = path.join(root, smokeStages ? 'smoke' : 'sequences', `${taskId}-${arm}${label ? `-${label}` : ''}`);
  fs.mkdirSync(path.dirname(seqDir), { recursive: true, mode: 0o700 }); fs.mkdirSync(seqDir, { recursive: false, mode: 0o700 });
  const namespace = `ledger_eval_${crypto.randomBytes(16).toString('hex')}`;
  exclusiveJson(path.join(seqDir, 'ownership.json'), { namespace, task: taskId, arm });
  const storeDir = path.join(seqDir, 'store'); fs.mkdirSync(storeDir, { mode: 0o700 });
  fs.writeFileSync(path.join(storeDir, 'canary'), crypto.randomBytes(8).toString('hex'), { mode: 0o600 });
  const state: SequenceState = { schema: 'sequence-run/v1', task: taskId, arm, namespace, dir: seqDir, startedAt: now(), stages: {}, store: {}, cleanup: {}, failures: [] };
  const persist = () => writeJson(path.join(seqDir, 'sequence.json'), state);
  const secrets: string[] = [];
  const log = (line: string) => appendJsonl(path.join(seqDir, 'controller.log.jsonl'), { at: now(), line: clean(line, secrets) });
  const budgetFile = path.join(root, 'budget.json');
  persist();
  // ---- team store per arm
  let ledger: LedgerNativeState | undefined; let smKey: { key: string; id: string; revoke: () => Promise<void> } | undefined; let openaiKey: string | undefined;
  const gbrainHome = path.join(storeDir, 'gbrain-home'); const graphifyRoot = path.join(storeDir, 'graphify-root');
  try {
    if (arm === 'ledger') {
      ledger = await prepareLedgerNative(seqDir, namespace, m.runtimeDir);
      state.store.ledger = { databaseName: ledger.databaseName, remote: ledger.remote, ledgerDir: path.join(seqDir, 'ledger') };
      fs.mkdirSync(path.join(seqDir, 'ledger'), { recursive: true });
    }
    if (arm === 'supermemory') {
      process.env.SUPERMEMORY_API_KEY = readEnvValue(m.credentialFiles.supermemory, 'SUPERMEMORY_API_KEY');
      try { smKey = await createTrialSupermemoryKey(namespace); } finally { delete process.env.SUPERMEMORY_API_KEY; }
      secrets.push(smKey.key); state.store.supermemory = { scopedKeyId: smKey.id, containerTag: namespace, secretPersisted: false };
    }
    if (arm === 'gbrain' || arm === 'graphify') openaiKey = readGbrainEmbeddingKey(m.credentialFiles.openai);
    if (arm === 'gbrain') {
      fs.mkdirSync(gbrainHome, { mode: 0o700 });
      execFileSync('gbrain', ['init', '--pglite'], { env: gbrainEnv(gbrainHome, openaiKey!), stdio: 'pipe', timeout: 120_000 });
      const cfg = readJson(path.join(gbrainHome, '.gbrain', 'config.json'));
      if (cfg.engine !== 'pglite' || !path.resolve(cfg.database_path).startsWith(gbrainHome + path.sep)) throw new Error('GBrain store escaped the sequence');
      state.store.gbrain = { home: gbrainHome, engine: cfg.engine };
    }
    if (arm === 'graphify') { fs.mkdirSync(graphifyRoot, { mode: 0o700 }); exclusiveJson(path.join(graphifyRoot, 'ownership.json'), { namespace }); state.store.graphify = { root: graphifyRoot }; }
    persist();
    // ---- stages
    const previousCanaries: string[] = [];
    for (const stageSpec of stagesToRun) {
      const stage = stageSpec.stage as Stage;
      const stageRoot = path.join(seqDir, 'stages', stage); const agentDir = path.join(stageRoot, 'agent'); const ctl = path.join(stageRoot, 'controller');
      const home = path.join(agentDir, 'home'); const worktree = path.join(agentDir, 'worktree');
      for (const d of [agentDir, home, worktree, ctl, path.join(home, '.mcp')]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      const ctlCanary = path.join(ctl, 'canary'); fs.writeFileSync(ctlCanary, crypto.randomBytes(8).toString('hex'), { mode: 0o600 });
      const homeCanary = path.join(home, '.stage-canary'); fs.writeFileSync(homeCanary, crypto.randomBytes(8).toString('hex'), { mode: 0o600 });
      const record: any = { stage, person: m.persons[stage], startedAt: now(), home, worktree };
      state.stages[stage] = record; persist(); log(`stage ${stage} start`);
      const transports: Array<{ close: () => Promise<void> }> = [];
      try {
        const task = stageSpec.task;
        // workspace
        if (task.kind === 'coding-handoff') record.preparation = await prepareCodingWorktree(m.contentRoot, worktree, m.pnpmStore);
        else { git(worktree, ['init', '-q']); fs.appendFileSync(path.join(worktree, '.git', 'info', 'exclude'), '.claude/\n.sequence-own-canary\n.mcp/\n'); }
        git(worktree, ['config', 'user.name', m.persons[stage]]); git(worktree, ['config', 'user.email', `${m.persons[stage]}@${namespace}.evaluation.invalid`]);
        const mcp: SequenceMcp = {}; let hooks: unknown; const hookEnv: Record<string, string> = {}; const extraEnv: Record<string, string> = {};
        const readPaths = [fs.realpathSync(path.join(root, 'node_modules')), m.caFile, ...(task.kind === 'coding-handoff' ? [m.pnpmStore] : [])];
        const writePaths = [agentDir];
        // Stage inputs are committed as the workspace baseline for every arm: the capture helpers of all
        // products need a repository with a HEAD, and the committed inputs are part of the "same starting repository".
        for (const f of stageSpec.inputs) { const target = ownedPath(worktree, f.relativePath); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, f.content); }
        record.inputs = stageSpec.inputs.map(f => f.relativePath);
        git(worktree, ['add', '-A']);
        git(worktree, ['-c', 'user.name=frozen-baseline', '-c', 'user.email=baseline@evaluation.invalid', 'commit', '-q', '--allow-empty', '-m', `Frozen stage ${stage} inputs`],
          { GIT_AUTHOR_DATE: '2026-09-10T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-10T00:00:00Z' });
        record.inputsCommit = git(worktree, ['rev-parse', 'HEAD']);
        let ledgerStage: Awaited<ReturnType<typeof prepareLedgerStage>> | undefined;
        const stageIdentity = { home, worktree, harness: 'codex' as const, person: m.persons[stage], role: `stage-${stage}` };
        if (ledger) {
          ledgerStage = await prepareLedgerStage(ledger, stageIdentity, { restoreSnapshot: false });
          mcp.ledger = { command: process.execPath, args: [path.join(m.runtimeDir, 'cli.js'), 'mcp'], env: ledgerStage.env };
          hooks = { hooks: ledgerStage.hooks }; Object.assign(hookEnv, ledgerStage.env);
          writePaths.push(path.join(seqDir, 'ledger')); readPaths.push(ledger.remote);
          record.ledgerBootstrap = ledgerStage.bootstrap;
        }
        if (arm === 'supermemory') {
          const codexHome = path.join(home, '.codex');
          record.templateHashes = copyFrozenDirectory((m.providers.supermemory as any).template, codexHome);
          writeNativeSupermemorySettings(worktree, home, namespace);
          const h = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8').split('{{HOME}}').join(home));
          for (const group of h.hooks.Stop ?? []) for (const hook of group.hooks ?? []) hook.async = false;
          hooks = h; hookEnv.SUPERMEMORY_CODEX_API_KEY = smKey!.key; hookEnv.SUPERMEMORY_DEBUG = 'true';
          mcp.supermemory = { command: 'node', args: [path.join(codexHome, 'supermemory', 'mcp-proxy.js')], env_vars: ['SUPERMEMORY_CODEX_API_KEY'] };
        }
        // Unix socket paths must stay under 104 bytes on macOS, so they live in a short owned directory, not the stage home.
        const socketDir = path.join('/tmp', 'ledger-eval-sock'); fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
        const socketToken = crypto.randomBytes(6).toString('hex');
        const socketFor = (name: string) => path.join(socketDir, `${socketToken}-${name}.sock`);
        record.sockets = { dir: socketDir, token: socketToken };
        const transportRecord = (name: string) => (direction: string, message: unknown) => appendJsonl(path.join(ctl, `transport-${name}.jsonl`), { at: now(), direction, message });
        if (arm === 'gbrain') {
          transports.push(await nativeSequenceTransport(socketFor('gbrain'), 'gbrain', ['serve'], gbrainEnv(gbrainHome, openaiKey!), gbrainHome, transportRecord('gbrain')));
          mcp.gbrain = { command: process.execPath, args: [path.join(m.runtimeDir, 'eval', 'sequence-runner.js'), 'connect', '--socket', socketFor('gbrain')] };
        }
        // stage tool server (outside the sandbox) for every arm
        const taskFile = path.join(ctl, 'task.json'); writeJson(taskFile, task);
        const traceFile = path.join(ctl, 'trace.jsonl');
        const toolConfig: StageToolConfig = { stageDir: stageRoot, taskFile, traceFile, answerDir: ctl, stage, arm, namespace,
          ...(arm === 'graphify' ? { graphify: { root: graphifyRoot, binary: (m.providers.graphify as any).binary, version: (m.providers.graphify as any).version, backend: (m.providers.graphify as any).backend, model: (m.providers.graphify as any).model,
            maxOutputTokens: 4096, maxRetries: 0, apiTimeoutSeconds: 120, allowPaidOperations: true } } : {}) };
        const toolConfigFile = path.join(ctl, 'tools.json'); writeJson(toolConfigFile, toolConfig);
        const toolHome = path.join(ctl, 'tool-home'); fs.mkdirSync(toolHome, { recursive: true });
        const toolEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: toolHome, LANG: 'en_US.UTF-8', TMPDIR: toolHome, LEDGER_EVAL: '1', ...(arm === 'graphify' ? { OPENAI_API_KEY: openaiKey } : {}) };
        transports.push(await nativeSequenceTransport(socketFor('stage'), process.execPath, [path.join(m.runtimeDir, 'eval', 'sequence-runner.js'), 'serve-stage', '--config', toolConfigFile], toolEnv, toolHome, transportRecord('stage')));
        mcp.stage = { command: process.execPath, args: [path.join(m.runtimeDir, 'eval', 'sequence-runner.js'), 'connect', '--socket', socketFor('stage')] };
        // paid-operation reservations that this stage can trigger
        const reservations: string[] = [];
        if (arm === 'supermemory') reservations.push((await reserve(budgetFile, { sequence: `${taskId}-${arm}`, stage, provider: 'supermemory', operation: 'capture-processing', reservedUsd: PRICE_BOUNDS['supermemory:document'].perDocumentUsd * 6, basis: 'up to six captured documents per stage at the assumed per-document bound' })).id);
        if (arm === 'gbrain') reservations.push((await reserve(budgetFile, { sequence: `${taskId}-${arm}`, stage, provider: 'openai', operation: 'gbrain-embeddings', reservedUsd: 0.10, basis: 'up to 200k embedding tokens at the text-embedding-3-large bound' })).id);
        // prompt and launch
        const prompt = renderPrompt(m, arm, stage, task, worktree, record.inputs);
        fs.writeFileSync(path.join(ctl, 'prompt.txt'), prompt, { mode: 0o600 });
        const forbidden = [ctlCanary, path.join(storeDir, 'canary'), ...previousCanaries];
        const run = await runSequenceCodex({ home, worktree, runtime: m.runtimeDir, prompt, model: m.limits.model, timeoutMs: m.limits.stageTimeoutMs, mcp, hooks, hookEnv,
          additionalReadPaths: readPaths, additionalWritePaths: writePaths, caFile: m.caFile, forbiddenCanaries: forbidden, reasoningEffort: m.reasoningEffort,
          allowLocalPostgres: arm === 'ledger', ledgerHooks: arm === 'ledger', extraEnv });
        record.endedAt = now();
        writeJson(path.join(ctl, 'process.json'), { ...run, stdout: clean(run.stdout, secrets), stderr: clean(run.stderr, secrets), policy: undefined });
        record.run = { completed: run.completed, exitCode: run.exitCode, timedOut: run.timedOut, wallMs: run.wallMs, usage: run.usage ?? null, sessionId: run.sessionId,
          itemTypes: run.itemTypes, streamErrors: run.streamErrors, isolation: run.isolation, policyHash: run.policyHash, assistantText: clean(run.assistantText, secrets).slice(0, 6000) };
        await recordSubscriptionUsage(budgetFile, { at: now(), sequence: `${taskId}-${arm}`, stage, model: m.limits.model, usage: run.usage ?? null, wallMs: run.wallMs });
        for (const t of transports.splice(0)) await t.close();
        // answer + tool audit
        const answerFile = path.join(ctl, 'answer.json');
        record.answerSubmitted = fs.existsSync(answerFile);
        record.answer = record.answerSubmitted ? readJson(answerFile) : null;
        record.toolCalls = auditRollout(home, ctl, secrets, run.stdout, arm);
        const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
        record.queryDataCalls = trace.filter(e => e.operation === 'query_data').length;
        // product capture / indexing after the agent stopped (the product's background work, measured)
        record.capture = await postStageCapture({ arm, ledger, stageIdentity, smKey, namespace, gbrainHome, openaiKey, graphifyRoot, task, m, budgetFile, reservations, taskId, stage, worktree, ctl, log, trace });
        // grading
        if (smokeStages) record.grade = { scored: false, smoke: true };
        else if (task.kind === 'corrected-analysis') {
          record.grade = record.answerSubmitted ? gradeFrozenSequenceSql({ root: m.contentRoot, manifestFile: path.join(m.contentRoot, 'content-freeze.json'), taskFile: TASK_FILES[taskId].task, oracleFile: TASK_FILES[taskId].oracle!, stage, answer: record.answer, trace })
            : { scored: true, executableCompletion: false, resultCorrect: false, holdoutsCorrect: false, executed: false, error: 'no answer submitted' };
        } else record.grade = await gradeCodingStage(worktree, ctl, record.preparation.baselineCommit, m);
        previousCanaries.push(homeCanary, ctlCanary);
        log(`stage ${stage} end completed=${record.run.completed} answer=${record.answerSubmitted}`);
      } catch (e) {
        record.endedAt = record.endedAt ?? now(); record.failure = clean(e instanceof Error ? e.message : String(e), secrets).slice(0, 2000);
        state.failures.push(`${stage}: ${record.failure}`); log(`stage ${stage} failed: ${record.failure}`);
        for (const t of transports.splice(0)) await t.close().catch(() => {});
        previousCanaries.push(homeCanary, ctlCanary);
      } finally { persist(); }
    }
  } catch (e) { state.failures.push(`sequence: ${clean(e instanceof Error ? e.message : String(e), secrets).slice(0, 2000)}`); }
  // ---- end of sequence: export product stores, revoke keys, close owned databases
  try {
    if (ledger) {
      try { const exported = await exportLedgerNative(ledger); state.cleanup.ledgerExport = exported; await closeLedgerNative(ledger); state.cleanup.ledgerDatabase = 'owned database removed after exact export'; }
      catch (e) { state.cleanup.ledgerDatabase = `retained: ${e instanceof Error ? e.message : 'export/cleanup failed'}`; }
    }
    if (smKey) {
      try { state.cleanup.supermemoryDocuments = await dumpSupermemory(smKey.key, namespace, path.join(storeDir, 'supermemory-documents.json')); } catch (e) { state.cleanup.supermemoryDocuments = `dump failed: ${e instanceof Error ? e.message : 'unknown'}`; }
      try { await smKey.revoke(); state.cleanup.supermemoryKey = 'scoped key revoked; documents retained in the container for audit'; } catch { state.cleanup.supermemoryKey = `revocation failed; key id ${smKey.id} must be revoked in the console`; }
    }
    if (arm === 'gbrain') {
      try { execFileSync('gbrain', ['export', '--dir', path.join(storeDir, 'gbrain-export')], { env: gbrainEnv(gbrainHome), stdio: 'pipe', timeout: 120_000 }); state.cleanup.gbrainExport = path.join(storeDir, 'gbrain-export'); }
      catch (e) { state.cleanup.gbrainExport = `export failed: ${e instanceof Error ? e.message.slice(0, 300) : 'unknown'}`; }
    }
  } finally { state.endedAt = now(); persist(); }
  return state;
}
function gbrainEnv(home: string, key?: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: home, LANG: 'en_US.UTF-8', TMPDIR: home, LEDGER_EVAL: '1', __CF_USER_TEXT_ENCODING: process.env.__CF_USER_TEXT_ENCODING, ...(key ? { OPENAI_API_KEY: key } : {}) };
}
function gbrainCall(home: string, key: string | undefined, name: string, args: unknown) {
  const text = execFileSync('gbrain', ['call', name, JSON.stringify(args)], { env: gbrainEnv(home, key), stdio: 'pipe', timeout: 120_000, maxBuffer: 20 << 20 }).toString();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 2000) }; }
}
/** Reads the stage's own Codex rollout: every tool call the agent made, with previews, for the reuse and reconstruction audit. */
function auditRollout(home: string, ctl: string, secrets: string[], stdout: string, arm: Arm) {
  // Codex 0.149 wraps MCP calls in its `exec` tool, so the rollout shows JS bodies; the JSON event
  // stream still reports each MCP call as an item with server, tool, arguments and result.
  const mcpCalls: any[] = []; const byServerTool: Record<string, number> = {}; let commandExecutions = 0;
  for (const line of stdout.split('\n')) {
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'item.completed' || !e.item) continue;
    if (e.item.type === 'command_execution') commandExecutions++;
    if (e.item.type !== 'mcp_tool_call') continue;
    const key = `${e.item.server}.${e.item.tool}`; byServerTool[key] = (byServerTool[key] ?? 0) + 1;
    const resultText = JSON.stringify(e.item.result ?? null);
    mcpCalls.push({ server: e.item.server, tool: e.item.tool, status: e.item.status, error: e.item.error ?? null, arguments: clean(JSON.stringify(e.item.arguments ?? null).slice(0, 4000), secrets),
      result: clean(resultText.slice(0, 20000), secrets), resultChars: resultText.length, resultHash: sha256(resultText) });
  }
  writeJson(path.join(ctl, 'mcp-calls.json'), mcpCalls);
  const isMemory = (c: any) => c.server !== 'stage' || String(c.tool).startsWith('graphify_');
  const memory = mcpCalls.filter(isMemory);
  const rollout = auditRolloutFile(home, ctl, secrets);
  return { ...rollout, commandExecutions, mcpCalls: mcpCalls.length, byServerTool, memoryToolCalls: memory.length,
    memoryReads: memory.filter(c => /search|query|get|list|brief|investigat|resume|threads|records|read|explain|affected|path|profile|recall/i.test(c.tool)).length,
    memoryWrites: memory.filter(c => /record|put|write|save|note|add|start|update|link|extract|reflect|store|remember|forget/i.test(c.tool)).length, arm };
}
function auditRolloutFile(home: string, ctl: string, secrets: string[]) {
  const sessions = path.join(home, '.codex', 'sessions'); const files: string[] = [];
  (function walk(dir: string) { if (!fs.existsSync(dir)) return; for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.jsonl')) files.push(p); } })(sessions);
  const calls: any[] = []; const pending = new Map<string, any>(); const counts: Record<string, number> = {}; let compactions = 0;
  for (const file of files) {
    fs.copyFileSync(file, path.join(ctl, `rollout-${path.basename(file)}`));
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      let e: any; try { e = JSON.parse(line); } catch { continue; }
      const p = e.payload ?? {};
      if (e.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
        const name = String(p.name ?? 'unknown'); counts[name] = (counts[name] ?? 0) + 1;
        const call = { at: e.timestamp, name, callId: p.call_id, input: clean(String(p.arguments ?? p.input ?? '').slice(0, 4000), secrets), output: null as string | null, outputChars: 0 };
        calls.push(call); if (p.call_id) pending.set(p.call_id, call);
      } else if (e.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
        const call = pending.get(p.call_id); const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
        if (call) { call.output = clean(out.slice(0, 20000), secrets); call.outputChars = out.length; call.outputHash = sha256(out); }
      } else if (e.type === 'event_msg' && (p.type === 'context_compacted' || p.type === 'compacted')) compactions++;
    }
  }
  writeJson(path.join(ctl, 'tool-calls.json'), calls);
  return { rolloutToolCalls: calls.length, rolloutByName: counts, compactions, rolloutFiles: files.length };
}
async function postStageCapture(x: { arm: Arm; ledger?: LedgerNativeState; stageIdentity: any; smKey?: { key: string }; namespace: string; gbrainHome: string; openaiKey?: string; graphifyRoot: string;
  task: AnalyticalTask; m: PilotManifest; budgetFile: string; reservations: string[]; taskId: string; stage: Stage; worktree: string; ctl: string; log: (s: string) => void; trace: any[] }) {
  const started = Date.now(); const out: any = { arm: x.arm };
  try {
    if (x.arm === 'ledger' && x.ledger) {
      const capture = await captureLedgerStage(x.ledger, x.stageIdentity);
      out.ledger = { evidenceFile: capture.evidenceFile, snapshot: capture.snapshot, sessions: capture.sessions.map((s: any) => ({ id: s.id, eventCount: s.event_count, wipRef: s.wip_ref, verifiedAt: s.last_verified_snapshot_at })), summary: capture.summary, limitations: capture.limitations };
    }
    if (x.arm === 'supermemory' && x.smKey) {
      const client = supermemoryClient(x.smKey.key); const deadline = Date.now() + x.m.limits.providerWaitMs; let docs: any[] = [];
      for (;;) {
        const list: any = await client.post('/v3/documents/list', { body: { containerTag: x.namespace, page: 1, limit: 100 } });
        docs = list.memories ?? [];
        if (docs.every(d => d.status === 'done' || d.status === 'failed') || Date.now() > deadline) break;
        await new Promise(r => setTimeout(r, 3000));
      }
      out.supermemory = { documents: docs.map(d => ({ id: d.id, status: d.status, createdAt: d.createdAt, title: d.title ?? null })), waitedMs: Date.now() - started, processingComplete: docs.every(d => d.status === 'done') };
      await reconcile(x.budgetFile, x.reservations[0], null, { documentsInContainer: docs.length }, 'per-document charge unknown on the user plan; reservation retained as the charge');
    }
    if (x.arm === 'gbrain') {
      const health = gbrainCall(x.gbrainHome, x.openaiKey, 'get_health', {});
      out.gbrain = { healthBefore: health };
      if (typeof health.page_count === 'number' && health.page_count > 0 && (health.embed_coverage !== 1 || health.missing_embeddings !== 0)) {
        const t = Date.now();
        try { execFileSync('gbrain', ['embed', '--all'], { env: gbrainEnv(x.gbrainHome, x.openaiKey), stdio: 'pipe', timeout: 300_000 }); out.gbrain.embedRun = { ok: true, ms: Date.now() - t }; }
        catch (e) { out.gbrain.embedRun = { ok: false, ms: Date.now() - t, error: (e instanceof Error ? e.message : 'failed').slice(0, 300) }; }
        out.gbrain.healthAfter = gbrainCall(x.gbrainHome, x.openaiKey, 'get_health', {});
      }
      out.gbrain.pages = gbrainCall(x.gbrainHome, x.openaiKey, 'list_pages', { limit: 100 });
      await reconcile(x.budgetFile, x.reservations[0], null, { pageCount: health.page_count ?? null }, 'embedding token usage is not reported by GBrain; reservation retained as the charge');
    }
    if (x.arm === 'graphify') {
      const g = x.m.providers.graphify as any;
      process.env.OPENAI_API_KEY = x.openaiKey;
      try {
        const store = graphifyStore({ arm: 'graphify', root: x.graphifyRoot, namespace: x.namespace, task: x.task, mode: 'native', trace: (op, d) => appendJsonl(path.join(x.ctl, 'trace.jsonl'), { at: now(), operation: op, stage: x.stage, detail: d, controllerIndexing: true }),
          allowExternalExport: true, allowPaidOperations: true, graphify: { binary: g.binary, version: g.version, backend: g.backend, model: g.model, maxOutputTokens: 4096, maxRetries: 0, apiTimeoutSeconds: 120 } });
        const sources = store.sources(); const receiptFile = path.join(store.root, 'extraction.json');
        const receipt = fs.existsSync(receiptFile) ? readJson(receiptFile) : null;
        const current = receipt && JSON.stringify(receipt.sources) === JSON.stringify(sources) && receipt.codeOnly === false;
        out.graphify = { sources: sources.length, agentExtracted: x.trace.some(e => e.operation === 'graphify-cli' && e.detail?.command === 'extract' && !e.controllerIndexing), graphCurrentAfterAgent: Boolean(current) };
        if (sources.length && !current) {
          const bytes = sources.reduce((n, s) => n + fs.statSync(path.join(store.corpus, s.id)).size, 0);
          const bound = tokensBound(bytes) * (PRICE_BOUNDS['openai:gpt-4.1-mini'].inputPerMillion + PRICE_BOUNDS['openai:gpt-4.1-mini'].outputPerMillion) / 1e6 + 0.01;
          const entry = await reserve(x.budgetFile, { sequence: `${x.taskId}-${x.arm}`, stage: x.stage, provider: 'openai', operation: 'graphify-extraction', reservedUsd: bound, basis: `corpus ${bytes} bytes; input+output bound at gpt-4.1-mini upper rates` });
          const t = Date.now();
          try { store.extract(); out.graphify.controllerExtraction = { ok: true, ms: Date.now() - t, corpusBytes: bytes }; }
          catch (e) { out.graphify.controllerExtraction = { ok: false, ms: Date.now() - t, error: (e instanceof Error ? e.message : 'failed').slice(0, 300) }; }
          await reconcile(x.budgetFile, entry.id, null, { corpusBytes: bytes }, 'Graphify prints an estimate only; reservation retained as the charge');
        }
      } finally { delete process.env.OPENAI_API_KEY; }
    }
  } catch (e) { out.error = (e instanceof Error ? e.message : String(e)).slice(0, 1500); x.log(`capture ${x.arm} ${x.stage} error: ${out.error}`); }
  out.ms = Date.now() - started; return out;
}
async function gradeCodingStage(worktree: string, ctl: string, baselineCommit: string, m: PilotManifest) {
  git(worktree, ['add', '-A', '-N', '.']);
  const status = git(worktree, ['status', '--porcelain']).split('\n').filter(Boolean);
  const changedFiles = status.map(l => l.slice(3)).filter(f => !f.startsWith('.claude/') && !f.startsWith('.mcp/'));
  const patch = execFileSync('git', ['diff', '--binary', baselineCommit], { cwd: worktree, maxBuffer: 200 << 20, env: { PATH: process.env.PATH, HOME: worktree, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  fs.writeFileSync(path.join(ctl, 'candidate.patch'), patch, { mode: 0o600 });
  const checks = await runCodingChecks(worktree, path.join(ctl, 'check-home'));
  const baseline = (m.codingBaselineChecks as any)?.checks ?? [];
  return { schema: 'sequence-coding-grade/v1', scored: false, changedFiles, changedFileCount: changedFiles.length, patchBytes: patch.length, patchSha256: sha256(patch),
    checks: checks.map(c => ({ ...c, baselineExitCode: baseline.find((b: any) => b.id === c.id)?.exitCode ?? null, regressed: (baseline.find((b: any) => b.id === c.id)?.exitCode === 0) && c.exitCode !== 0 })),
    featureCompletion: 'not_evaluated', scope: 'baseline-compatibility checks and the exact candidate patch only; PRD behaviour, HTTP/Postgres/UI bindings and reuse require the separate independent grading in grading-contract.md' };
}
async function dumpSupermemory(key: string, namespace: string, file: string) {
  const client = supermemoryClient(key); const docs: any[] = [];
  for (let page = 1; page <= 100; page++) {
    const list: any = await client.post('/v3/documents/list', { body: { containerTag: namespace, page, limit: 100 } });
    for (const d of list.memories ?? []) { let full: any = null; try { full = await client.documents.get(d.id); } catch { /* keep listing */ } docs.push({ listed: d, document: full }); }
    if (page >= (list.pagination?.totalPages ?? 1)) break;
  }
  writeJson(file, docs); return { file, documents: docs.length };
}

// ---------------------------------------------------------------- run-all

async function runAll(root: string, opts: Record<string, string>) {
  const m = loadPilot(root);
  const tasks = (opts.tasks ?? m.tasks.join(',')).split(','); const arms = (opts.arms ?? m.arms.join(',')).split(',') as Arm[];
  const concurrency = Math.max(1, Number(opts.concurrency ?? '2'));
  const jobs = tasks.flatMap(task => arms.map(arm => ({ task, arm })));
  const results: any[] = []; let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++]; const started = Date.now();
      const r = await new Promise<{ code: number | null; out: string; err: string }>(resolve => {
        const child = spawn(process.execPath, [filename, 'run', '--root', root, '--task', job.task, '--arm', job.arm], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
        child.on('close', code => resolve({ code, out, err }));
      });
      results.push({ ...job, exitCode: r.code, wallMs: Date.now() - started, stderrTail: r.err.slice(-1500) });
      appendJsonl(path.join(root, 'run-all.log.jsonl'), { at: now(), ...job, exitCode: r.code, wallMs: Date.now() - started });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return { jobs: results, budget: summarizeBudget(path.join(root, 'budget.json')) };
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv; const opts = argsOf(rest);
  if (command === 'serve-stage') { await serveStageTools(opts.config); return; }
  if (command === 'connect') { await connectSequenceTransport(opts.socket); return; }
  if (command === 'prepare') { console.log(json(await prepare(opts))); return; }
  if (command === 'run') { const s = await runSequence(path.resolve(opts.root), opts.task, opts.arm as Arm, opts.label); console.log(json({ dir: s.dir, failures: s.failures, stages: Object.fromEntries(Object.entries(s.stages).map(([k, v]: any) => [k, { completed: v.run?.completed ?? false, answer: v.answerSubmitted ?? false, grade: v.grade?.executableCompletion ?? v.grade?.changedFileCount ?? null, failure: v.failure ?? null }])) })); return; }
  if (command === 'smoke') {
    const canary = `CANARY_${crypto.randomBytes(10).toString('hex')}`;
    const base = { version: 1 as const, kind: 'corrected-analysis' as const, executable: false, artifacts: [], evidence: [{ id: 'smoke-note', title: 'smoke', content: 'synthetic smoke', author: 'controller', recordedAt: '2026-09-10T00:00:00Z', effectiveAt: '2026-09-10T00:00:00Z', status: 'evidence' as const, kind: 'artifact' as const, scope: {}, dependsOn: [], sourceRef: 'synthetic:smoke' }],
      provenance: { classification: 'synthetic' as const, externalExportAllowed: true, sourceRefs: ['synthetic:smoke'], permissionNote: 'invented smoke fixture; unscored' },
      data: [{ user_id: 'a', day: '2026-09-06', n: 1 }, { user_id: 'b', day: '2026-09-06', n: 2 }, { user_id: 'c', day: '2026-09-07', n: 3 }] };
    const inputs = [{ relativePath: 'README-smoke.md', content: 'Synthetic smoke workspace. Nothing here is real product data.\n' }];
    const stages: StageSpec[] = [
      { stage: 'A', inputs, task: { ...base, id: 'smoke-a', title: 'smoke A', prompt: `Smoke test (synthetic, unscored). Team decision for the silver otter release: it uses freshwater mode, and its exact acceptance identifier is ${canary}. Run exactly one query_data query, SELECT COUNT(*) AS n FROM events, and note the count. Save the decision, the exact identifier and the row count through the configured product so that a teammate in a later, separate session can retrieve them. Then call submit_answer with {"saved": true, "identifier": "<the identifier>", "rowCount": <n>}.` } },
      { stage: 'B', inputs, task: { ...base, id: 'smoke-b', title: 'smoke B', prompt: 'Smoke test (synthetic, unscored). A teammate in an earlier, separate session established the release mode and the exact acceptance identifier for the silver otter release, plus a row count they obtained from query_data. Retrieve all three through the configured product without guessing; if the product returns nothing, say so. Then call submit_answer with {"identifier": "<exact identifier or null>", "releaseMode": "<mode or null>", "rowCount": <n or null>, "sourceIds": ["<native record/document/page/source ids you actually retrieved>"]}.' } },
    ];
    const s = await runSequence(path.resolve(opts.root), 'smoke', opts.arm as Arm, crypto.randomBytes(3).toString('hex'), stages);
    const b: any = s.stages.B; const a: any = s.stages.A;
    console.log(json({ dir: s.dir, arm: opts.arm, canary, failures: s.failures,
      A: { completed: a?.run?.completed ?? false, answer: a?.answer ?? null, capture: a?.capture ?? null, toolCalls: a?.toolCalls ?? null },
      B: { completed: b?.run?.completed ?? false, answer: b?.answer ?? null, toolCalls: b?.toolCalls ?? null, retrievedCanary: JSON.stringify(b?.answer ?? {}).includes(canary), retrievedRowCount: b?.answer?.rowCount === 3 } }));
    return;
  }
  if (command === 'run-all') { console.log(json(await runAll(path.resolve(opts.root), opts))); return; }
  if (command === 'report') { const r = buildReport(path.resolve(opts.root)); console.log(json({ root: r.root, sequences: r.sequences.map((s: any) => ({ task: s.task, arm: s.arm, cumulative: s.cumulative, failures: s.failures })), budget: r.budget })); return; }
  if (command === 'budget') { console.log(json(summarizeBudget(path.join(path.resolve(opts.root), 'budget.json')))); return; }
  throw new Error('commands: prepare | run | run-all | smoke | report | budget | serve-stage | connect');
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(filename)) main().catch(e => { console.error(e instanceof Error ? e.stack ?? e.message : String(e)); process.exit(1); });
