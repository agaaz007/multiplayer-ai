import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { json, ownedPath, sha256 } from './analytical-contract.js';

const server = z.object({ command: z.string().min(1), args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}), env_vars: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).optional() }).strict();
/** Paths are copied and hashed before launch. Configuration uses placeholders, never credentials. */
export const NativeRouteSchema = z.object({
  provider: z.enum(['ledger', 'supermemory', 'gbrain', 'graphify', 'shared-doc']),
  mechanism: z.enum(['official-capture-hooks', 'native-agent-save']),
  implementationRef: z.string().min(1),
  humanCaptureInstructions: z.string().default(''),
  claude: z.object({ pluginDir: z.string().optional(), settings: z.record(z.string(), z.unknown()).default({}),
    mcpServers: z.record(z.string(), server).default({}) }).strict().optional(),
  codex: z.object({ homeTemplate: z.string().optional(), configAppend: z.string().default(''),
    mcpServers: z.record(z.string(), server).default({}) }).strict().optional(),
  graphify: z.object({ binary: z.string().min(1), version: z.literal('0.9.50'), backend: z.enum(['claude', 'openai']), model: z.string().min(1).refine(m => !/SET_EXPLICIT|MODEL_SELECTED_BY_USER|PLACEHOLDER/.test(m), 'select an explicit Graphify extraction model') }).strict().optional(),
  readNamespaces: z.array(z.string()).min(1),
  provenanceNote: z.string().min(1),
}).strict().superRefine((route, ctx) => {
  for (const h of [route.claude, route.codex]) for (const s of Object.values(h?.mcpServers ?? {})) {
    for (const [key, value] of Object.entries(s.env)) if (/(KEY|TOKEN|SECRET|PASSWORD)$/.test(key) && value) {
      ctx.addIssue({ code: 'custom', message: 'credentials must be inherited from the process environment, not embedded in native route files' });
    }
  }
});
export type NativeRoute = z.infer<typeof NativeRouteSchema>;
export interface NativeStage { role: 'origin' | 'correction'; person: string; harness: 'claude' | 'codex'; model: string; prompt: string }
export const NativeStagesSchema = z.array(z.object({ role: z.enum(['origin', 'correction']), person: z.string().min(1),
  harness: z.enum(['claude', 'codex']), model: z.string().min(1), prompt: z.string().min(1) }).strict()).min(2)
  .refine(stages => stages[0].role === 'origin' && stages.some(s => s.role === 'correction'), 'origin and correction stages required');

export function copyFrozenDirectory(from: string, to: string): Record<string, string> {
  if (!path.isAbsolute(from) || !fs.statSync(from).isDirectory()) throw new Error('native integration must be a local absolute directory');
  const hashes: Record<string, string> = {};
  function walk(current: string, relative: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.isSymbolicLink()) throw new Error('native integration contains a symlink');
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (/credentials|auth\.json$|\.env$|config\.toml$|supermemory\.json$/i.test(entry.name)) throw new Error('native template includes credential/config file; supply reviewed configuration separately');
      const target = ownedPath(to, rel);
      if (entry.isDirectory()) { fs.mkdirSync(target, { recursive: true }); walk(path.join(current, entry.name), rel); }
      else {
        const data = fs.readFileSync(path.join(current, entry.name));
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data, { flag: 'wx', mode: 0o600 }); hashes[rel] = sha256(data);
      }
    }
  }
  fs.mkdirSync(to, { recursive: true, mode: 0o700 }); walk(from, ''); return hashes;
}
export function verifyFrozenDirectory(directory: string, expected: Record<string, string>): void {
  const actual: Record<string, string> = {};
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('frozen integration changed to a symlink');
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file); else actual[path.relative(directory, file).split(path.sep).join('/')] = sha256(fs.readFileSync(file));
    }
  }
  walk(directory);
  const stable = (v: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))));
  if (stable(actual) !== stable(expected)) throw new Error('frozen native integration changed');
}
export function substitute(value: unknown, substitutions: Record<string, string>): any {
  if (typeof value === 'string') return value.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in substitutions)) throw new Error(`unknown native configuration placeholder ${key}`); return substitutions[key];
  });
  if (Array.isArray(value)) return value.map(v => substitute(v, substitutions));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, substitutions)]));
  return value;
}
export function nativeReadiness(route: NativeRoute | undefined, harnesses: ('claude' | 'codex')[], namespace: string, scopeVerified = false) {
  if (!route) return { ready: false, reason: 'native route absent; never substitute controller ingestion for capture' };
  const resolved = substitute(route.readNamespaces, { NAMESPACE: namespace }) as string[];
  if (resolved.some(tag => tag !== namespace)) return { ready: false, reason: 'native read namespace can escape this trial' };
  for (const h of harnesses) if (!route[h]) return { ready: false, reason: `native ${h} route unavailable` };
  if (route.provider === 'supermemory' && !scopeVerified) return { ready: false,
    reason: 'Supermemory requires a live scoped-key boundary check before native capture; namespace declarations alone are insufficient' };
  if (route.provider === 'graphify' && (!route.graphify || route.mechanism !== 'native-agent-save')) return { ready: false, reason: 'Graphify requires explicit native CLI configuration and agent-authored source capture' };
  // Ledger's hook files and private DB are created by prepareLedgerNative/Stage
  // after this declaration check; other integrations must supply their own hooks.
  if (route.mechanism === 'official-capture-hooks' && route.provider !== 'ledger') {
    if (harnesses.includes('claude') && !route.claude?.pluginDir && !route.claude?.settings.hooks) return { ready: false, reason: 'Claude capture hooks not configured' };
    if (harnesses.includes('codex') && !route.codex?.homeTemplate) return { ready: false, reason: 'Codex native hook template missing' };
  }
  // This is configuration readiness, not evidence of successful capture. The runner
  // separately verifies the post-origin canary in actual provider source bytes.
  return { ready: true, namespaces: resolved, mechanism: route.mechanism, captureVerified: false,
    limitation: 'declared read namespaces require runtime canary/traffic verification; supplied configuration is not isolation proof' };
}
export function writeNativeSupermemorySettings(worktree: string, home: string, namespace: string) {
  const project = ownedPath(worktree, '.claude/.supermemory-claude/config.json');
  fs.mkdirSync(path.dirname(project), { recursive: true });
  fs.writeFileSync(project, json({ repoContainerTag: namespace, personalContainerTag: namespace }));
  const codex = ownedPath(home, '.codex/supermemory.json'); fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.writeFileSync(codex, json({ projectContainerTag: namespace, userContainerTag: namespace }));
}
