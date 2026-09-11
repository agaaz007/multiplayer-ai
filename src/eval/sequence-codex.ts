import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sequenceSeatbelt, verifySequenceSeatbelt } from './sequence-isolation.js';
import { spawnHarness, killGroup, readCodexJsonStream } from './harness.js';

export type SequenceMcp = Record<string, { command: string; args: string[]; env_vars?: string[]; env?: Record<string, string> }>;
export interface SequenceCodexInput {
  home: string; worktree: string; runtime: string; prompt: string; model: string; timeoutMs: number; mcp: SequenceMcp;
  hooks?: unknown; hookEnv?: Record<string, string>; additionalReadPaths?: string[]; additionalWritePaths?: string[];
  caFile?: string; forbiddenCanaries: string[]; reasoningEffort?: 'low' | 'medium' | 'high';
  /** The Ledger arm keeps its own hooks on and reaches its owned local Postgres; every other arm has both off. */
  allowLocalPostgres?: boolean; ledgerHooks?: boolean; extraEnv?: Record<string, string>;
}
/**
 * One fresh Codex session inside a kernel-verified seatbelt. The task agent can read the frozen
 * runtime, Node and any explicitly granted paths, and can write only its own home and workspace.
 *
 * `__CF_USER_TEXT_ENCODING` must be present: without it CoreFoundation resolves the user through a
 * process-info lookup that `(deny process-info*)` refuses, and the process dies with SIGTRAP before
 * printing anything (verified 2026-09-10 on this machine for both node and codex).
 */
export async function runSequenceCodex(input: SequenceCodexInput) {
  const codexHome = path.join(input.home, '.codex'); fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const originalAuth = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  const auth = JSON.parse(fs.readFileSync(originalAuth, 'utf8'));
  if (auth.auth_mode !== 'chatgpt') throw new Error('Pilot task agents require the selected Codex subscription auth; do not use an API key for inference');
  fs.copyFileSync(originalAuth, path.join(codexHome, 'auth.json')); fs.chmodSync(path.join(codexHome, 'auth.json'), 0o600);
  const toml = Object.entries(input.mcp).map(([name, s]) => `[mcp_servers.${name}]\ncommand = ${JSON.stringify(s.command)}\nargs = ${JSON.stringify(s.args)}\n`
    + (s.env_vars ? `env_vars = ${JSON.stringify(s.env_vars)}\n` : '')
    + (s.env && Object.keys(s.env).length ? `[mcp_servers.${name}.env]\n${Object.entries(s.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n')}\n` : '')).join('\n');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = ${JSON.stringify(input.model)}\nmodel_reasoning_effort = ${JSON.stringify(input.reasoningEffort ?? 'medium')}\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[features]\nhooks = ${Boolean(input.hooks)}\nmemories = false\napps = false\nbrowser_use = false\ncomputer_use = false\nmulti_agent = false\nimage_generation = false\n${toml}`);
  if (input.hooks) fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify(input.hooks, null, 2));
  const tmp = path.join(input.home, 'tmp'); fs.mkdirSync(tmp, { recursive: true });
  const ownCanary = path.join(input.worktree, '.sequence-own-canary'); fs.writeFileSync(ownCanary, crypto.randomBytes(16).toString('hex'));
  const nodeRoots = [...new Set((process.env.PATH ?? '').split(':').filter(p => p.includes('/.nvm/versions/')).map(p => path.dirname(p)).filter(p => fs.existsSync(p)))];
  const policy = sequenceSeatbelt([input.runtime, ...nodeRoots, ...(input.additionalReadPaths ?? [])],
    [input.home, input.worktree, ...(input.additionalWritePaths ?? [])], input.forbiddenCanaries, { allowLocalPostgres: input.allowLocalPostgres });
  const isolation = verifySequenceSeatbelt(policy, ownCanary, input.forbiddenCanaries);
  fs.unlinkSync(ownCanary);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: input.home, CODEX_HOME: codexHome, TMPDIR: tmp, LANG: 'en_US.UTF-8',
    __CF_USER_TEXT_ENCODING: process.env.__CF_USER_TEXT_ENCODING ?? `0x${process.getuid?.().toString(16) ?? '1f6'}:0:2`,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LEDGER_EVAL: '1',
    ...(input.ledgerHooks ? {} : { LEDGER_HOOKS_OFF: '1' }), ...input.extraEnv, ...input.hookEnv };
  if (input.caFile) { const ca = path.join(input.home, 'public-ca.pem'); fs.copyFileSync(input.caFile, ca); env.CODEX_CA_CERTIFICATE = ca; env.SSL_CERT_FILE = ca; env.NODE_EXTRA_CA_CERTS = ca; }
  const lastMessage = path.join(input.home, 'last-message.txt');
  const argv = ['exec', '-C', input.worktree, '--skip-git-repo-check', '--ignore-rules', '-s', 'danger-full-access', '-m', input.model, '--json', '-o', lastMessage,
    ...(input.hooks ? ['--dangerously-bypass-hook-trust'] : []), input.prompt];
  const result = await spawnHarness({ cmd: '/usr/bin/sandbox-exec', args: ['-p', policy, 'codex', ...argv], cwd: input.worktree, env, timeoutMs: input.timeoutMs });
  // No background app/tool process from an earlier stage may serve a later agent.
  if (result.pid) killGroup(result.pid, 'SIGKILL');
  const secrets = [...Object.values(input.hookEnv ?? {}), ...Object.values(input.extraEnv ?? {})].filter(s => s.length > 16);
  const clean = (s: string) => secrets.reduce((v, k) => v.split(k).join('[redacted]'), s).replace(/(?:sk-|sm_)[\w-]{20,}/g, '[redacted]');
  const stream = readCodexJsonStream(result.stdout);
  const completed = stream.turns.length > 0;
  const usage = stream.turns.length ? stream.turns[stream.turns.length - 1] : undefined;
  const itemTypes: Record<string, number> = {};
  for (const line of result.stdout.split('\n')) { try { const e = JSON.parse(line); if (e.type === 'item.completed' && e.item?.type) itemTypes[e.item.type] = (itemTypes[e.item.type] ?? 0) + 1; } catch { /* not JSON */ } }
  return { ...result, stdout: clean(result.stdout), stderr: clean(result.stderr), isolation, usage, completed, model: input.model,
    sessionId: stream.sessionId, assistantText: clean(stream.lastMessage ?? (fs.existsSync(lastMessage) ? fs.readFileSync(lastMessage, 'utf8') : '')),
    streamErrors: stream.errors.map(clean), itemTypes, billing: 'Codex ChatGPT subscription; token usage reported separately from paid memory/extraction API charges',
    hookTrust: input.hooks ? 'one-invocation trust for reviewed frozen native hook sources' : 'no hooks',
    policyHash: crypto.createHash('sha256').update(policy).digest('hex'), policy };
}
