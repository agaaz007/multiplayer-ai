import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ARMS, TaskSchema, OracleSchema, CostPolicySchema, appendHumanLog, evidenceText, exclusiveJson, json, ownedPath, sha256,
  type AnalyticalTask, type Arm, type AdapterContext } from './analytical-contract.js';
import { syntheticAnalyticalFixture } from './analytical-fixture.js';
import { probeGraphifySemantics } from './analytical-graphify.js';
import { createTrialSupermemoryKey } from './analytical-supermemory.js';
import { createProvider, probeGbrainEmbeddings, gbrainEnvironment } from './analytical-providers.js';
import { gradeAnswer } from './analytical-oracle.js';
import { serveAnalyticalMcp } from './analytical-mcp.js';
import { claudeIsolationArgs } from './claude-isolation.js';
import { harnessEnv, spawnHarness } from './harness.js';
import { NativeRouteSchema, NativeStagesSchema, copyFrozenDirectory, verifyFrozenDirectory, nativeReadiness, substitute, writeNativeSupermemorySettings,
  type NativeRoute } from './analytical-native.js';
import { prepareLedgerNative, prepareLedgerStage, captureLedgerStage, exportLedgerNative, closeLedgerNative, type LedgerNativeState } from './analytical-ledger-native.js';

const filename = fileURLToPath(import.meta.url);
const buildRoot = path.dirname(path.dirname(filename));
function projectRoot() {
  let candidate = buildRoot;
  while (path.dirname(candidate) !== candidate) {
    if (fs.existsSync(path.join(candidate, 'package-lock.json')) && fs.existsSync(path.join(candidate, 'node_modules'))) return candidate;
    candidate = path.dirname(candidate);
  }
  throw new Error('installed project dependencies not found');
}
function argsOf(argv: string[]) {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('use --name value arguments; booleans are explicit true/false');
    if (argv[i].slice(2) in values) throw new Error('duplicate option'); values[argv[i].slice(2)] = argv[i + 1];
  }
  return values;
}
function readJson(file: string) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function armOf(value: string): Arm { if (!(ARMS as readonly string[]).includes(value)) throw new Error('unknown arm'); return value as Arm; }
function buildHashes(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  function walk(dir: string) { for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) walk(path.join(dir, f.name));
    else if (f.name.endsWith('.js')) hashes[path.relative(root, path.join(dir, f.name))] = sha256(fs.readFileSync(path.join(dir, f.name)));
  } }
  walk(root); return hashes;
}
export function prepareRun(out: string, taskInput?: unknown, oracleInput?: unknown, protocol: 'native' | 'evidence-parity-diagnostic' = 'native') {
  const defaults = syntheticAnalyticalFixture();
  const task = TaskSchema.parse(taskInput ?? defaults.task); const oracle = OracleSchema.parse(oracleInput ?? defaults.oracle);
  if ((task.kind === 'corrected-analysis') !== (oracle.kind === 'sql')) throw new Error('task and oracle kinds disagree');
  const root = path.resolve(out); fs.mkdirSync(root, { recursive: false, mode: 0o700 });
  const namespace = `ledger_eval_${crypto.randomBytes(16).toString('hex')}`;
  exclusiveJson(path.join(root, 'ownership.json'), { namespace, taskId: task.id });
  exclusiveJson(path.join(root, 'package.json'), { private: true, type: 'module' });
  exclusiveJson(path.join(root, 'task.json'), task);
  const privateRoot = fs.mkdtempSync(path.join(path.dirname(root), '.analytical-grader-'));
  const privateOracle = path.join(privateRoot, 'oracle.json');
  exclusiveJson(privateOracle, { oracle, readCanary: `GRADER_ONLY_${crypto.randomBytes(24).toString('hex')}` });
  const frozenBuild = path.join(root, 'build'); fs.cpSync(buildRoot, frozenBuild, { recursive: true, errorOnExist: true, force: false });
  // Frozen JS imports normal installed dependencies; hash the lockfile as well.
  const dependencies = path.join(projectRoot(), 'node_modules');
  if (fs.existsSync(dependencies)) fs.symlinkSync(dependencies, path.join(root, 'node_modules'), 'dir');
  const lock = path.join(projectRoot(), 'package-lock.json');
  const manifest = { version: 1, runId: namespace, protocol, taskId: task.id, taskKind: task.kind, frozenAt: new Date().toISOString(), executable: task.executable,
    taskHash: sha256(fs.readFileSync(path.join(root, 'task.json'))), oracleHash: sha256(fs.readFileSync(privateOracle)),
    buildFiles: buildHashes(frozenBuild), lockHash: fs.existsSync(lock) ? sha256(fs.readFileSync(lock)) : null,
    limitations: ['same-machine controller; native two-laptop field trial remains separate', 'filesystem isolation is behavioral; private oracle is not an OS-enforced enclave',
      'oracle stored separately from agent/tool configuration; an isolation audit is required for a valid comparison',
      'controller task.json contains all-stage evidence; tool filtering does not prevent filesystem reads of future evidence or other stages',
      'no hard dollar ceiling is enforced across model and native provider operations; explicit operator-monitored cost policy required',
      'no trial completed by preparation; dependencies are installed lockfile-bound packages, not vendored immutable copies'] };
  exclusiveJson(path.join(root, 'manifest.json'), manifest); return { ...manifest, privateOracle };
}
function verifyRun(root: string) {
  const manifest = readJson(path.join(root, 'manifest.json'));
  if (sha256(fs.readFileSync(path.join(root, 'task.json'))) !== manifest.taskHash) throw new Error('frozen task changed');
  const lock = path.join(projectRoot(), 'package-lock.json');
  if (manifest.lockHash && (!fs.existsSync(lock) || sha256(fs.readFileSync(lock)) !== manifest.lockHash)) throw new Error('frozen dependency lock changed');
  const actual = buildHashes(path.join(root, 'build'));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.buildFiles)) throw new Error('frozen executable build changed');
  return manifest;
}
function safeError(error: unknown) { return error instanceof Error ? cleanOutput(error.message).replace(/Bearer\s+\S+|(?:sk-|sm_)[\w-]+/g, '[redacted]') : 'unknown failure'; }
const transientSecrets = new Set<string>();
function cleanOutput(text: string) {
  let value = text;
  for (const [key, secret] of Object.entries(process.env)) if (/(KEY|TOKEN|SECRET|PASSWORD)$/.test(key) && secret && secret.length >= 12) value = value.split(secret).join('[redacted]');
  for (const secret of transientSecrets) value = value.split(secret).join('[redacted]');
  return value;
}
function stageHome(trialDir: string, name: string) {
  const home = ownedPath(trialDir, `homes/${name}`); fs.mkdirSync(home, { recursive: true, mode: 0o700 }); return home;
}
function copyHarnessAuth(home: string, harness: 'claude' | 'codex') {
  const from = harness === 'codex' ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json') : path.join(os.homedir(), '.claude', '.credentials.json');
  const to = ownedPath(home, harness === 'codex' ? '.codex/auth.json' : '.claude/.credentials.json');
  if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); fs.chmodSync(to, 0o600); }
}
function nativeInventoryItems(value: any): { id: string }[] { return Array.isArray(value) ? value : value?.memories ?? value?.pages ?? []; }

function freezeExecutionPlan(root: string, arm: Arm, opts: Record<string, string>, route: NativeRoute | undefined, stages: unknown, costPolicy: unknown) {
  const plans = ownedPath(root, 'plans'); fs.mkdirSync(plans, { recursive: true });
  const basename = `${arm}-${opts.harness}-${opts.mode ?? 'native'}`;
  const file = ownedPath(plans, `${basename}.json`);
  const spec = { protocol: opts.mode ?? 'native', arm, harness: opts.harness, model: opts.model, timeoutMs: Number(opts['timeout-ms']),
    route: route ?? null, stages, costPolicy, gbrainCredentialFile: opts['gbrain-env-file'] ?? null };
  if (fs.existsSync(file)) {
    const prior = readJson(file);
    if (JSON.stringify(prior.spec) !== JSON.stringify(spec)) throw new Error('arm/harness execution plan changed; prepare a new frozen run');
    if (prior.frozenRoute?.claude?.pluginDir) verifyFrozenDirectory(prior.frozenRoute.claude.pluginDir, prior.integrationHashes.claude);
    if (prior.frozenRoute?.codex?.homeTemplate) verifyFrozenDirectory(prior.frozenRoute.codex.homeTemplate, prior.integrationHashes.codex);
    return prior;
  }
  let frozenRoute = route;
  const integrationHashes: Record<string, Record<string, string>> = {};
  if (route) {
    frozenRoute = structuredClone(route);
    if (route.claude?.pluginDir) {
      const target = path.join(plans, `${basename}-claude-plugin`);
      integrationHashes.claude = copyFrozenDirectory(route.claude.pluginDir, target);
      frozenRoute.claude!.pluginDir = target;
    }
    if (route.codex?.homeTemplate) {
      const target = path.join(plans, `${basename}-codex-template`);
      integrationHashes.codex = copyFrozenDirectory(route.codex.homeTemplate, target);
      frozenRoute.codex!.homeTemplate = target;
    }
  }
  const plan = { frozenAt: new Date().toISOString(), spec, frozenRoute, integrationHashes, hash: sha256(JSON.stringify(spec)) };
  exclusiveJson(file, plan); return plan;
}

export function freezeComparisonConditions(root: string, conditions: {
  stages: unknown[]; successorHarness: string; successorModel: string; timeoutMs: number;
  maximumApprovedUsd: number | null; mode: string;
}) {
  const direction = (conditions.stages as { harness: string }[]).map(s => s.harness).concat(conditions.successorHarness).join('-');
  if (!/^(claude|codex)(-(claude|codex))*$/.test(direction)) throw new Error('invalid comparison harness direction');
  const file = ownedPath(root, `comparison-${conditions.mode}-${direction}.json`);
  if (fs.existsSync(file)) {
    if (JSON.stringify(readJson(file)) !== JSON.stringify(conditions)) throw new Error('comparison conditions differ across arms; freeze a new run instead of changing prompts, models or budgets');
  } else exclusiveJson(file, conditions);
}

export async function runTrial(rootInput: string, opts: Record<string, string>) {
  const root = path.resolve(rootInput); const manifest = verifyRun(root);
  const task = TaskSchema.parse(readJson(path.join(root, 'task.json'))); const arm = armOf(opts.arm);
  const mode = opts.mode ?? 'native'; if (mode !== 'native' && mode !== 'evidence-parity-diagnostic') throw new Error('invalid mode');
  if (manifest.protocol !== mode) throw new Error('trial protocol disagrees with frozen run protocol');
  const providedRoute = opts['native-route'] ? NativeRouteSchema.parse(readJson(opts['native-route'])) : undefined;
  if (providedRoute && providedRoute.provider !== arm) throw new Error('native route belongs to another provider');
  const stages = opts.stages ? NativeStagesSchema.parse(readJson(opts.stages)) : [];
  const successorHarness = opts.harness; if (successorHarness !== 'claude' && successorHarness !== 'codex') throw new Error('harness must be claude or codex');
  if (!opts.model?.trim()) throw new Error('explicit successor model required; no default substitution');
  if ([opts.model, ...stages.map(s => s.model)].some(m => /SET_EXPLICIT|MODEL_SELECTED_BY_USER|^PLACEHOLDER/i.test(m))) throw new Error('replace all example model placeholders with authorized model IDs');
  const timeoutMs = Number(opts['timeout-ms']); if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) throw new Error('explicit bounded timeout-ms required');
  const costPolicy = opts['cost-policy'] ? CostPolicySchema.parse(readJson(opts['cost-policy'])) : null;
  if (costPolicy && [opts.model, ...stages.map(s => s.model), ...(providedRoute?.graphify ? [providedRoute.graphify.model] : [])].some(m => !costPolicy.authorizedModels.includes(m))) throw new Error('a requested model is absent from the explicit cost policy');
  freezeComparisonConditions(root, { stages, successorHarness, successorModel: opts.model, timeoutMs,
    maximumApprovedUsd: costPolicy?.maximumApprovedUsd ?? null, mode });
  const plan = freezeExecutionPlan(root, arm, opts, providedRoute, stages, costPolicy);
  const route = plan.frozenRoute as NativeRoute | undefined;
  const trialDir = ownedPath(root, `trials/${arm}-${opts.harness}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(trialDir, { recursive: true, mode: 0o700 });
  const namespace = `ledger_eval_${crypto.randomBytes(16).toString('hex')}`;
  exclusiveJson(path.join(trialDir, 'ownership.json'), { namespace, parent: manifest.runId });
  const traceFile = path.join(trialDir, 'trace.jsonl');
  const trace = (operation: string, detail: unknown) => fs.appendFileSync(traceFile, JSON.stringify({ at: new Date().toISOString(), operation, detail }) + '\n', { mode: 0o600 });
  const ctx: AdapterContext = { arm, root: trialDir, namespace, task, mode, trace,
    allowExternalExport: opts['allow-export'] === 'true', allowPaidOperations: opts['allow-paid'] === 'true' && Boolean(costPolicy), graphify: route?.graphify, gbrainCredentialFile: opts['gbrain-env-file'] };
  if (ctx.gbrainCredentialFile && arm !== 'gbrain') throw new Error('gbrain-env-file is allowed only for the GBrain arm');
  let provider = createProvider(ctx);
  let supermemoryLease: Awaited<ReturnType<typeof createTrialSupermemoryKey>> | undefined;
  let supermemoryKeyCleanup: string | undefined;
  const spec = { version: 1, namespace, parentRun: manifest.runId, arm, mode, model: opts.model, harness: successorHarness, timeoutMs,
    assignedAt: new Date().toISOString(), executable: task.executable, taskHash: manifest.taskHash,
    executionPlanHash: plan.hash, nativeRoute: route ?? null, stages, costPolicy, status: 'assigned' };
  exclusiveJson(path.join(trialDir, 'assignment.json'), spec);
  let anyStageLaunched = false;
  let status = 'error'; let reason: string | undefined; let successorWorktree: string | undefined;
  let ledgerNative: LedgerNativeState | undefined;
  let nativeLedgerExport: Awaited<ReturnType<typeof exportLedgerNative>> | undefined;
  let nativeLedgerCleanup: string | undefined;
  try {
    if (opts['allow-paid'] === 'true' && !costPolicy) { status = 'unavailable-before-launch'; throw new Error('explicit per-attempt cost policy required; allow-paid alone does not authorize spend and no hard dollar ceiling is enforced'); }
    if (arm === 'supermemory') {
      if (!ctx.allowExternalExport || !task.provenance.externalExportAllowed || !ctx.allowPaidOperations) {
        status = 'unavailable-before-launch'; throw new Error('Supermemory key provisioning requires export and cost authorization');
      }
      try { supermemoryLease = await createTrialSupermemoryKey(namespace); }
      catch (e) { status = 'unavailable-before-launch'; throw e; }
      transientSecrets.add(supermemoryLease.key);
      exclusiveJson(path.join(trialDir, 'supermemory-key.json'), { id: supermemoryLease.id, namespace, expiresInDays: 1, secretPersisted: false });
      provider = createProvider(ctx, supermemoryLease.key);
    }
    const readiness = await provider.check(); exclusiveJson(path.join(trialDir, 'provider-readiness.json'), readiness);
    if (!readiness.ready) { status = 'unavailable-before-launch'; throw new Error(readiness.reason || 'provider not ready'); }
    if (arm === 'graphify' && ctx.allowPaidOperations) {
      try { exclusiveJson(path.join(trialDir, 'graphify-semantic-probe.json'), await probeGraphifySemantics(ctx)); }
      catch (e) { status = 'unavailable-before-launch'; throw e; }
    }
    if (arm === 'gbrain' && ctx.allowPaidOperations) {
      try { exclusiveJson(path.join(trialDir, 'gbrain-embedding-probe.json'), await probeGbrainEmbeddings(ctx)); }
      catch (e) { status = 'unavailable-before-launch'; throw e; }
    }
    if (!ctx.allowPaidOperations) { status = 'unavailable-before-launch'; throw new Error('paid/model execution is not authorized; no agent launched'); }
    if (mode === 'native') {
      const native = nativeReadiness(route, [...stages.map(s => s.harness), successorHarness], namespace, readiness.checks.scopeVerified === true);
      exclusiveJson(path.join(trialDir, 'native-readiness.json'), native);
      if (!native.ready || stages.length === 0) { status = 'unavailable-before-launch'; throw new Error(native.ready ? 'native origin/correction stages missing' : native.reason); }
      if (arm === 'ledger') {
        try { ledgerNative = await prepareLedgerNative(trialDir, namespace, path.join(root, 'build')); trace('native-ledger-prepared', { databaseName: ledgerNative.databaseName, remote: ledgerNative.remote }); }
        catch (e) { status = 'unavailable-before-launch'; throw e; }
      }
    } else await provider.ingest();
    const initialInventory = await provider.inventory(); trace('initial-inventory', initialInventory);
    if (mode === 'native' && nativeInventoryItems(initialInventory).length !== 0) throw new Error('native trial did not start empty');
    const captureMarkers = stages.map((stage, i) => ({ role: stage.role, index: i, marker: `CAPTURE_${crypto.randomBytes(16).toString('hex')}` }));
    const runStage = async (role: string, person: string, harness: 'claude' | 'codex', model: string, prompt: string) => {
      const name = `${role}-${crypto.randomBytes(4).toString('hex')}`;
      const worktree = ownedPath(trialDir, `worktrees/${name}`); fs.mkdirSync(path.dirname(worktree), { recursive: true });
      if (task.coding) {
        execFileSync('git', ['clone', '--no-hardlinks', '--no-checkout', '--', task.coding.sourceRepo, worktree], { timeout: 120_000, stdio: 'pipe' });
        if (task.coding.snapshotRef) {
          execFileSync('git', ['fetch', '--no-tags', 'origin', task.coding.snapshotRef], { cwd: worktree, timeout: 120_000, stdio: 'pipe' });
          const fetched = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], { cwd: worktree }).toString().trim();
          if (fetched !== task.coding.commit) throw new Error('remote snapshot moved from pinned source commit; prepare a new task instead of silently updating');
        }
        execFileSync('git', ['checkout', '--detach', task.coding.commit], { cwd: worktree, timeout: 30_000, stdio: 'pipe' });
      } else { fs.mkdirSync(worktree); execFileSync('git', ['init', '-q'], { cwd: worktree }); }
      // Fresh git identity avoids generated personal/repository scope collisions.
      execFileSync('git', ['config', 'user.email', `${namespace}@evaluation.invalid`], { cwd: worktree });
      const home = stageHome(trialDir, name); copyHarnessAuth(home, harness);
      const nativeSubstitutions = { NAMESPACE: namespace, HOME: home, WORKTREE: worktree, TRIAL_DIR: trialDir,
        LEDGER_DIR: path.join(trialDir, 'ledger'), BUILD_DIR: path.join(root, 'build'), GBRAIN_HOME: path.join(trialDir, 'gbrain-home') };
      const resolved = route ? substitute(route, nativeSubstitutions) as NativeRoute : undefined;
      const configDir = path.join(home, '.ledger'); fs.mkdirSync(configDir, { recursive: true });
      exclusiveJson(path.join(configDir, 'config.json'), { ledger_dir: path.join(trialDir, 'ledger'), author: person, git_sync: false });
      const stageIdentity = { home, worktree, harness, person, role };
      const ledgerStage = ledgerNative ? await prepareLedgerStage(ledgerNative, stageIdentity) : undefined;
      if (ledgerStage) trace('native-ledger-bootstrap', { role, ...ledgerStage.bootstrap, limitations: ledgerStage.limitations });
      const toolConfig = { ...ctx, task: undefined, trace: undefined, taskFile: path.join(root, 'task.json'), traceFile, role, trialDir };
      const toolConfigFile = path.join(trialDir, `${name}-tools.json`); exclusiveJson(toolConfigFile, toolConfig);
      const analysisServer = { command: process.execPath, args: [path.join(root, 'build/eval/analytical-runner.js'), 'serve', '--config', toolConfigFile] };
      const servers: Record<string, { command: string; args: string[]; env?: Record<string, string>; env_vars?: string[] }> = { analysis: analysisServer, ...(mode === 'native' ? resolved?.[harness]?.mcpServers ?? {} : {}),
        ...(ledgerStage ? { ledger: ledgerStage.mcpServer } : {}) };
      if (arm === 'gbrain' && mode === 'native' && ctx.gbrainCredentialFile) {
        const entries = Object.keys(servers).filter(name => name !== 'analysis');
        if (entries.length !== 1 || entries[0] !== 'gbrain' || servers.gbrain.command !== 'gbrain'
          || JSON.stringify(servers.gbrain.args) !== JSON.stringify(['serve'])) throw new Error('credential-file mode requires the reviewed native GBrain serve route');
        servers.gbrain = { command: process.execPath,
          args: [path.join(root, 'build/eval/analytical-runner.js'), 'gbrain-serve', '--config', toolConfigFile] };
      }
      let commandArgs: string[];
      const mcpFile = path.join(trialDir, `${name}-mcp.json`); exclusiveJson(mcpFile, { mcpServers: servers });
      if (arm === 'supermemory' && mode === 'native') writeNativeSupermemorySettings(worktree, home, namespace);
      if (harness === 'claude') {
        const pluginArgs: string[] = [];
        if (mode === 'native' && resolved?.claude?.pluginDir) {
          const plugin = path.join(trialDir, `plugins/${name}`);
          const hashes = copyFrozenDirectory(resolved.claude.pluginDir, plugin); trace('native-plugin-hashes', { role, hashes }); pluginArgs.push('--plugin-dir', plugin);
        }
        const isolation = mode === 'native' ? ['--setting-sources', '', '--settings', JSON.stringify({
          ...resolved?.claude?.settings, ...(ledgerStage ? { hooks: ledgerStage.hooks } : {}), autoMemoryEnabled: false, claudeMdExcludes: ['**'] })] : claudeIsolationArgs();
        commandArgs = ['-p', prompt, '--model', model, '--output-format', 'json', '--session-id', crypto.randomUUID(),
          '--mcp-config', mcpFile, '--strict-mcp-config', ...isolation, ...pluginArgs, '--allowedTools',
          task.kind === 'coding-handoff' ? 'Read,Edit,Write,Glob,Grep,Bash,mcp__*' : 'mcp__*'];
      } else {
        const codexHome = path.join(home, '.codex'); fs.mkdirSync(codexHome, { recursive: true });
        if (mode === 'native' && resolved?.codex?.homeTemplate) {
          const hashes = copyFrozenDirectory(resolved.codex.homeTemplate, codexHome); trace('native-plugin-hashes', { role, hashes });
          const hooksFile = path.join(codexHome, 'hooks.json');
          if (fs.existsSync(hooksFile)) fs.writeFileSync(hooksFile, json(substitute(JSON.parse(fs.readFileSync(hooksFile, 'utf8')), nativeSubstitutions)));
        }
        if (ledgerStage) exclusiveJson(path.join(codexHome, 'hooks.json'), { hooks: ledgerStage.hooks });
        const toml = Object.entries(servers).map(([key, server]) => `[mcp_servers.${key}]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n` +
          (server.env_vars ? `env_vars = ${JSON.stringify(server.env_vars)}\n` : '') +
          ('env' in server ? `[mcp_servers.${key}.env]\n${Object.entries(server.env as Record<string, string>).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n')}\n` : '')).join('\n');
        fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = ${JSON.stringify(model)}\n${mode === 'native' ? resolved?.codex?.configAppend ?? '' : ''}\n${ledgerStage ? '[features]\ncodex_hooks = true\n' : ''}\n${toml}`);
        commandArgs = ['exec', '-C', worktree, '--skip-git-repo-check', '-s', task.kind === 'coding-handoff' ? 'workspace-write' : 'read-only', '-m', model, '--json', prompt];
      }
      const env = harnessEnv(process.env, { HOME: home, CODEX_HOME: path.join(home, '.codex'), LEDGER_CONFIG_DIR: path.join(home, '.ledger'), LEDGER_HOOKS_OFF: mode === 'native' && arm === 'ledger' ? undefined : '1' });
      const allowedCredentials = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']);
      for (const key of Object.keys(env)) {
        if (/^GBRAIN|DATABASE|^SUPABASE|^PG|^AWS_|^GOOGLE_APPLICATION_CREDENTIALS$|^CLAUDE_CONFIG_DIR$|^XDG_CONFIG_HOME$|^NODE_OPTIONS$|^NODE_PATH$|^BASH_ENV$|^ZDOTDIR$|^GIT_CONFIG_|^GIT_DIR$|^GIT_WORK_TREE$/.test(key)) delete env[key];
        else if (/(KEY|TOKEN|SECRET|PASSWORD)$/.test(key) && !allowedCredentials.has(key)) delete env[key];
      }
      if (supermemoryLease) {
        env.SUPERMEMORY_API_KEY = supermemoryLease.key;
        env.SUPERMEMORY_CC_API_KEY = supermemoryLease.key;
        env.SUPERMEMORY_CODEX_API_KEY = supermemoryLease.key;
      }
      // Do not inherit provider endpoint overrides that can bypass trial isolation.
      for (const key of Object.keys(env)) if (/^SUPERMEMORY_.*(?:URL|TAG)|^GRAPHIFY_|^OPENAI_BASE_URL$/.test(key)) delete env[key];
      if (ledgerStage) Object.assign(env, ledgerStage.env);
      trace('stage-start', { role, person, harness, model, home, worktree, commandArgs });
      anyStageLaunched = true;
      const result = await spawnHarness({ cmd: harness, args: commandArgs, cwd: worktree, env, timeoutMs });
      exclusiveJson(path.join(trialDir, `${name}-process.json`), { ...result, stdout: cleanOutput(result.stdout), stderr: cleanOutput(result.stderr) });
      trace('stage-end', { role, exitCode: result.exitCode, timedOut: result.timedOut, wallMs: result.wallMs });
      if (ledgerNative) {
        const capture = await captureLedgerStage(ledgerNative, stageIdentity);
        trace('native-ledger-stage-capture', { role, evidenceFile: capture.evidenceFile, snapshot: capture.snapshot, sessions: capture.sessions.map((s: any) => ({ id: s.id, eventCount: s.event_count })) });
      }
      // Retain private homes/transcripts until audit; do not delete evidence or substitute a model after failure.
      if (result.exitCode !== 0 || result.timedOut || result.spawnError) throw new Error(`${role} harness failed or timed out`);
      return worktree;
    };
    if (mode === 'native') {
      for (const [index, stage] of stages.entries()) await runStage(stage.role, stage.person, stage.harness, stage.model,
        `${stage.prompt}\n${route?.humanCaptureInstructions ?? ''}\nWorking-note capture marker: ${captureMarkers[index].marker}.`);
      const deadline = Date.now() + 60_000; const captured = new Set<string>();
      if (ledgerNative) {
        // Verify native transcript/artifact bytes, independently of whether the source
        // agent copied a canary into a structured conclusion. This is a capture probe,
        // not a claim that all task evidence was captured or later used correctly.
        const exported = await exportLedgerNative(ledgerNative);
        const inventory = readJson(exported.manifestFile);
        const sourceFiles = [...Object.values(inventory.tables).map((t: any) => t.file), ...inventory.artifacts.map((a: any) => a.file)];
        for (const file of sourceFiles) {
          const content = fs.readFileSync(ownedPath(exported.directory, file), 'utf8');
          for (const marker of captureMarkers) if (content.includes(marker.marker)) captured.add(marker.marker);
        }
        trace('native-ledger-source-export', exported);
      }
      do {
        const inventory = await provider.inventory(); trace('native-capture-inventory', inventory);
        for (const item of nativeInventoryItems(inventory)) {
          const content = JSON.stringify(await provider.read(item.id));
          for (const marker of captureMarkers) if (content.includes(marker.marker)) captured.add(marker.marker);
        }
        if (captured.size !== captureMarkers.length) await new Promise(r => setTimeout(r, 1000));
      } while (captured.size !== captureMarkers.length && Date.now() < deadline);
      trace('native-capture-canary', { stages: captureMarkers.map(m => ({ role: m.role, index: m.index, found: captured.has(m.marker) })) });
      if (captured.size !== captureMarkers.length) throw new Error('one or more native origin/correction captures not verified in saved source bytes; no diagnostic backfill performed');
      const indexed = await provider.check(); exclusiveJson(path.join(trialDir, 'post-capture-readiness.json'), indexed);
      if (!indexed.ready) throw new Error('captured sources are not ready for configured retrieval; no successor launched');
      for (const marker of captureMarkers) await provider.verifyRetrieval?.(marker.marker);
    }
    successorWorktree = await runStage('successor', 'third-pm-fixture', successorHarness, opts.model, task.prompt + '\nUse submit_answer when complete.');
    if (!fs.existsSync(path.join(trialDir, 'answer.json'))) throw new Error('successor did not submit an answer');
    status = 'completed';
  } catch (e) { if (!anyStageLaunched) status = 'unavailable-before-launch'; reason = safeError(e); trace('failure', { status, reason }); }
  if (ledgerNative) {
    try {
      nativeLedgerExport = await exportLedgerNative(ledgerNative);
      trace('native-ledger-final-export', nativeLedgerExport);
      await closeLedgerNative(ledgerNative);
      nativeLedgerCleanup = 'owned database removed after verified exact evidence export; Git snapshots retained';
    } catch (e) {
      nativeLedgerCleanup = 'database retained because evidence export or owned cleanup failed';
      const failure = `native evidence export/cleanup failed: ${safeError(e)}`;
      reason = reason ? `${reason}; ${failure}` : failure; status = 'error';
      trace('native-ledger-cleanup-failure', { reason: failure });
    }
  }
  if (supermemoryLease) {
    try { await supermemoryLease.revoke(); supermemoryKeyCleanup = 'scoped key revoked; captured evidence retained'; }
    catch { supermemoryKeyCleanup = 'revocation failed; retained key ID requires reconciliation'; }
    transientSecrets.delete(supermemoryLease.key);
  }
  const observation = { supermemoryKeyCleanup, status, reason, arm, mode, executable: task.executable, namespace, assignedAt: spec.assignedAt,
    finishedAt: new Date().toISOString(), successorWorktree, jointSuccessDenominator: task.executable && status !== 'unavailable-before-launch',
    humanTime: fs.existsSync(path.join(trialDir, 'human-time.jsonl')) ? 'recorded' : 'missing-not-zero', competitiveResult: false,
    costPolicy, costCompleteness: 'unreconciled-model-and-provider-usage; raw process traces retained, missing cost is not zero', dollarCeilingEnforced: false,
    nativeLedgerDatabase: ledgerNative?.databaseName, nativeLedgerExport, nativeLedgerCleanup,
    limitation: 'independent grading and isolation audit required before comparative interpretation' };
  exclusiveJson(path.join(trialDir, 'observation.json'), observation); return { trialDir, ...observation };
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv; const opts = argsOf(rest);
  if (['run', 'check', 'grade'].includes(command) && opts.run) {
    const frozenController = path.join(path.resolve(opts.run), 'build/eval/analytical-runner.js');
    if (filename !== frozenController) {
      verifyRun(path.resolve(opts.run));
      execFileSync(process.execPath, [frozenController, ...argv], { stdio: 'inherit', env: process.env }); return;
    }
  }
  if (command === 'gbrain-serve') {
    const cfg = readJson(opts.config);
    if (cfg.arm !== 'gbrain' || cfg.mode !== 'native' || !cfg.gbrainCredentialFile || !cfg.allowPaidOperations) throw new Error('GBrain credential launcher requires an authorized native benchmark configuration');
    const owner = readJson(ownedPath(cfg.root, 'ownership.json'));
    if (owner.namespace !== cfg.namespace) throw new Error('GBrain launcher ownership mismatch');
    const env = gbrainEnvironment(cfg.root, true, cfg.gbrainCredentialFile);
    const config = readJson(ownedPath(String(env.HOME), '.gbrain/config.json'));
    if (config.engine !== 'pglite' || !path.resolve(config.database_path).startsWith(String(env.HOME) + path.sep)) throw new Error('GBrain launcher store outside trial');
    const child = spawn(process.env.ANALYTICAL_GBRAIN_BIN || 'gbrain', ['serve'], { cwd: cfg.root, env, stdio: ['inherit', 'inherit', 'pipe'] });
    // Provider stderr may echo auth/config; suppress it and report only exit status.
    child.stderr?.on('data', () => {});
    const forward = () => child.kill('SIGTERM'); process.once('SIGTERM', forward); process.once('SIGINT', forward);
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => reject(new Error('GBrain native server failed to start')));
      child.once('exit', code => { process.exitCode = code ?? 1; resolve(); });
    });
    process.removeListener('SIGTERM', forward); process.removeListener('SIGINT', forward); return;
  }
  if (command === 'serve') { await serveAnalyticalMcp(opts.config); return; }
  if (command === 'import-task') {
    const spec = readJson(opts.spec); const task = { ...spec.task, evidence: [...(spec.task?.evidence ?? [])], artifacts: [...(spec.task?.artifacts ?? [])] };
    for (const source of spec.evidenceFiles ?? []) {
      if (!path.isAbsolute(source.file) || fs.lstatSync(source.file).isSymbolicLink()) throw new Error('import lists exact absolute regular files only');
      const content = fs.readFileSync(source.file, 'utf8');
      if (/(?:sk-|sm_)[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) throw new Error('potential credential in selected source; curate permitted evidence before import');
      task.evidence.push({ ...source.metadata, content });
    }
    if (task.provenance?.classification !== 'approved-local-import') throw new Error('import permission/provenance must be explicit');
    const parsed = TaskSchema.parse(task); exclusiveJson(path.resolve(opts.out), parsed);
    console.log(json({ taskId: parsed.id, evidenceSources: parsed.evidence.length, hash: sha256(json(parsed)), externalExportAllowed: parsed.provenance.externalExportAllowed, uploaded: false })); return;
  }
  if (command === 'prepare') {
    const protocol = opts.mode ?? 'native'; if (protocol !== 'native' && protocol !== 'evidence-parity-diagnostic') throw new Error('invalid protocol');
    const prepared = prepareRun(opts.out, opts.task ? readJson(opts.task) : undefined, opts.oracle ? readJson(opts.oracle) : undefined, protocol);
    console.log(json({ runId: prepared.runId, protocol: prepared.protocol, taskId: prepared.taskId, taskHash: prepared.taskHash,
      frozenBuildFiles: Object.keys(prepared.buildFiles).length, manifest: path.resolve(opts.out, 'manifest.json'), privateOracle: prepared.privateOracle, trialsRun: 0 })); return;
  }
  if (command === 'run') { console.log(json(await runTrial(opts.run, opts))); return; }
  if (command === 'check') {
    const root = path.resolve(opts.run); verifyRun(root); const task = TaskSchema.parse(readJson(path.join(root, 'task.json')));
    const namespace = `ledger_eval_${crypto.randomBytes(16).toString('hex')}`;
    const probe = ownedPath(root, `readiness/${namespace}`); fs.mkdirSync(probe, { recursive: true }); exclusiveJson(path.join(probe, 'ownership.json'), { namespace });
    const ctx: AdapterContext = { arm: armOf(opts.arm), root: probe, namespace, task, mode: opts.mode === 'evidence-parity-diagnostic' ? opts.mode : 'native',
      trace: (operation, detail) => fs.appendFileSync(path.join(probe, 'trace.jsonl'), JSON.stringify({ operation, detail }) + '\n'),
      allowExternalExport: opts['allow-export'] === 'true', allowPaidOperations: opts['allow-paid'] === 'true' && Boolean(opts['cost-policy']),
      gbrainCredentialFile: opts['gbrain-env-file'],
      graphify: opts['native-route'] ? NativeRouteSchema.parse(readJson(opts['native-route'])).graphify : undefined };
    if (ctx.gbrainCredentialFile && ctx.arm !== 'gbrain') throw new Error('gbrain-env-file is allowed only for the GBrain arm');
    if (opts['allow-paid'] === 'true') {
      if (!opts['cost-policy']) throw new Error('readiness probe requires explicit cost-policy');
      const cost = CostPolicySchema.parse(readJson(opts['cost-policy']));
      if (ctx.graphify && !cost.authorizedModels.includes(ctx.graphify.model)) throw new Error('Graphify extractor model absent from cost policy');
    }
    let lease: Awaited<ReturnType<typeof createTrialSupermemoryKey>> | undefined;
    try {
      if (ctx.arm === 'supermemory' && ctx.allowExternalExport && task.provenance.externalExportAllowed && ctx.allowPaidOperations) lease = await createTrialSupermemoryKey(namespace);
      const result = await createProvider(ctx, lease?.key).check();
      if (ctx.arm === 'graphify' && result.ready) {
        try { result.checks.liveSemanticProbe = JSON.stringify(await probeGraphifySemantics(ctx)); }
        catch { result.ready = false; result.reason = 'Graphify live semantic extraction/query probe failed'; }
      }
      if (ctx.arm === 'gbrain' && result.ready) {
        try { result.checks.liveEmbeddingProbe = JSON.stringify(await probeGbrainEmbeddings(ctx)); }
        catch { result.ready = false; result.reason = 'GBrain live embedding/hybrid probe failed'; }
      }
      exclusiveJson(path.join(probe, 'readiness.json'), result); console.log(json(result));
    } finally { if (lease) await lease.revoke(); }
    return;
  }
  if (command === 'human-time') { appendHumanLog(ownedPath(path.resolve(opts.trial), 'human-time.jsonl'), readJson(opts.entry)); console.log('Human time recorded; not inferred from wall time.'); return; }
  if (command === 'invalidate') { exclusiveJson(ownedPath(path.resolve(opts.trial), 'validity.json'), { valid: false, reason: opts.reason, at: new Date().toISOString() }); return; }
  if (command === 'grade') {
    const root = path.resolve(opts.run); const manifest = verifyRun(root); const trial = path.resolve(opts.trial);
    if (!trial.startsWith(root + path.sep)) throw new Error('trial outside run');
    const observation = readJson(path.join(trial, 'observation.json'));
    if (fs.existsSync(path.join(trial, 'validity.json')) && !readJson(path.join(trial, 'validity.json')).valid) throw new Error('contaminated/invalid trial cannot receive a competitive grade');
    const traces = fs.existsSync(path.join(trial, 'trace.jsonl')) ? fs.readFileSync(path.join(trial, 'trace.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s)) : [];
    const answer = fs.existsSync(path.join(trial, 'answer.json')) ? readJson(path.join(trial, 'answer.json')) : {};
    if (!opts.oracle || path.resolve(opts.oracle).startsWith(root + path.sep)) throw new Error('private oracle must be supplied from outside the run/agent tree');
    const oracleBytes = fs.readFileSync(opts.oracle); if (sha256(oracleBytes) !== manifest.oracleHash) throw new Error('private oracle changed');
    const privateInput = JSON.parse(oracleBytes.toString());
    let readLeak = false;
    function inspect(dir: string) { for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, f.name); if (f.isSymbolicLink()) continue;
      if (f.isDirectory()) { if (f.name !== 'node_modules' && f.name !== '.git') inspect(file); }
      else if (/\.(json|jsonl|log|txt)$/.test(f.name) && fs.statSync(file).size < 100_000_000 && fs.readFileSync(file, 'utf8').includes(privateInput.readCanary)) readLeak = true;
    } }
    inspect(trial);
    if (readLeak) { exclusiveJson(path.join(trial, 'oracle-read-contamination.json'), { invalid: true, reason: 'private oracle canary appeared in trial evidence' }); throw new Error('private oracle read contaminated this trial'); }
    const audit = opts.audit ? readJson(opts.audit) : null;
    const isolationAudited = audit?.namespace === observation.namespace && audit?.taskHash === manifest.taskHash && audit?.valid === true
      && audit?.startupContextReviewed === true && audit?.toolTrafficReviewed === true && audit?.negativeCanariesExcluded === true
      && audit?.futureEvidenceExcluded === true && audit?.otherStagesPrivateStateExcluded === true;
    const humanFile = path.join(trial, 'human-time.jsonl');
    const humanEntries = fs.existsSync(humanFile) ? fs.readFileSync(humanFile, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)) : [];
    const requiredPhases = ['setup', 'capture', 'correction-validation', 'handoff', 'clarification', 'review', 'repair'];
    const humanTimeComplete = requiredPhases.every(phase => humanEntries.some(e => e.phase === phase));
    const fairnessAudited = audit?.equalPermittedEvidenceVerified === true && audit?.sourcePromptsModelsBudgetsMatched === true
      && audit?.nativeWorkflowConfigurationReviewed === true && audit?.captureEffortIncluded === true
      && audit?.blindIndependentGrading === true && audit?.providerCostsReconciled === true;
    const cleanupComplete = !observation.supermemoryKeyCleanup?.startsWith('revocation failed');
    const grade = await gradeAnswer(TaskSchema.parse(readJson(path.join(root, 'task.json'))), OracleSchema.parse(privateInput.oracle), answer, traces, observation.successorWorktree);
    const gradingPending = 'gradingStatus' in grade && grade.gradingStatus === 'not-evaluated';
    const result = { ...grade, processCompleted: observation.status === 'completed', jointSuccess: observation.status === 'completed' && grade.jointSuccess,
      isolationAudited, fairnessAudited, humanTimeComplete, cleanupComplete,
      evaluationScope: 'single-handoff', validForCumulativeLearning: false,
      validForComparison: isolationAudited && fairnessAudited && humanTimeComplete && cleanupComplete && !gradingPending && observation.status !== 'unavailable-before-launch', oracleReadCanaryDetected: false,
      reason: gradingPending ? 'independent coding review/binding is not evaluated; no task correctness score assigned' : isolationAudited && fairnessAudited && humanTimeComplete && cleanupComplete ? undefined : 'isolation/fairness audit, complete human time, provider cost reconciliation or credential cleanup pending; grade is diagnostic only' };
    // A missing private grader binding is not a failed agent task and must not
    // consume the final grade slot. Retain every pending grading attempt.
    exclusiveJson(path.join(trial, gradingPending ? `grade-pending-${crypto.randomBytes(8).toString('hex')}.json` : 'grade.json'), result); console.log(json(result)); return;
  }
  throw new Error('commands: import-task, prepare, check, run, serve, grade, human-time, invalidate. See eval/analytical-benchmark.md.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === filename) main().catch(e => { console.error(safeError(e)); process.exitCode = 1; });
