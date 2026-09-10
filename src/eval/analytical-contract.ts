import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Authorization metadata, not an enforceable vendor-side dollar ceiling. */
export const CostPolicySchema = z.object({
  authorizationRef: z.string().trim().min(3),
  operator: z.string().trim().min(1),
  maximumApprovedUsd: z.number().finite().positive(),
  authorizedModels: z.array(z.string().trim().min(1)).min(1),
  enforcement: z.literal('operator-monitored-no-hard-cap'),
  acknowledgeNoHardDollarCap: z.literal(true),
  stopInstructions: z.string().trim().min(10),
});

export const ARMS = ['ledger', 'supermemory', 'gbrain', 'graphify', 'shared-doc'] as const;
export type Arm = typeof ARMS[number];
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/);
export const EvidenceSchema = z.object({
  id, title: z.string().min(1), content: z.string().min(1), author: z.string().min(1),
  recordedAt: z.iso.datetime(), effectiveAt: z.iso.datetime(),
  status: z.enum(['accepted', 'proposed', 'superseded', 'evidence']),
  kind: z.enum(['definition', 'finding', 'decision', 'change', 'artifact']),
  scope: z.record(z.string(), z.string()),
  dependsOn: z.array(id).default([]), sourceRef: z.string().min(1),
}).strict();
export type Evidence = z.infer<typeof EvidenceSchema>;
export const TaskSchema = z.object({
  version: z.literal(1), id, title: z.string().min(1), kind: z.enum(['corrected-analysis', 'coding-handoff']),
  provenance: z.object({ classification: z.enum(['synthetic', 'approved-local-import']),
    externalExportAllowed: z.boolean(), sourceRefs: z.array(z.string()).min(1), permissionNote: z.string().min(1) }).strict(),
  prompt: z.string().min(1), executable: z.boolean(), evidence: z.array(EvidenceSchema).min(1),
  artifacts: z.array(z.object({ id, filename: id, content: z.string(), mediaType: z.string(),
    access: z.enum(['shared-input', 'handoff-output']).default('handoff-output'),
    availableFrom: z.enum(['origin', 'correction', 'successor']).default('origin') }).strict()).default([]),
  data: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).optional(),
  coding: z.object({ sourceRepo: z.string().min(1), commit: z.string().regex(/^[a-f0-9]{40}$/),
    snapshotRef: z.string().regex(/^refs\/[a-zA-Z0-9_./-]+$/).optional(),
    sourceRecord: z.string().min(1), sourceArtifacts: z.array(z.string()).min(1) }).strict().optional(),
}).strict().superRefine((task, ctx) => {
  const ids = task.evidence.map(x => x.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate evidence IDs' });
  if (task.kind === 'corrected-analysis' && !task.data) ctx.addIssue({ code: 'custom', message: 'analysis needs frozen data' });
  if (task.kind === 'coding-handoff' && !task.coding) ctx.addIssue({ code: 'custom', message: 'coding needs a pinned source commit' });
});
export type AnalyticalTask = z.infer<typeof TaskSchema>;
export const OracleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sql'), definitionId: id, sql: z.string().min(1),
    requiredEvidence: z.array(id), affected: z.array(z.object({ id, status: z.literal('needs-review'), path: z.array(id) })),
    holdouts: z.array(z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()])))).min(1) }).strict(),
  z.object({ kind: z.literal('coding'), commands: z.array(z.object({ argv: z.array(z.string()).min(1),
    timeoutMs: z.number().int().positive().max(3_600_000) }).strict()).min(1),
    independentFiles: z.array(z.object({ relativePath: z.string().min(1), content: z.string() }).strict()).default([]),
    requiredEvidence: z.array(id) }).strict(),
]);
export type Oracle = z.infer<typeof OracleSchema>;
export interface FrozenManifest {
  version: 1; runId: string; frozenAt: string; taskId: string; taskKind: AnalyticalTask['kind'];
  executable: boolean; taskHash: string; oracleHash: string; buildFiles: Record<string, string>;
  protocol: 'native' | 'evidence-parity-diagnostic'; topology: 'same-machine'; limitations: string[];
}
export interface AdapterContext {
  arm: Arm; root: string; namespace: string; task: AnalyticalTask;
  mode: 'native' | 'evidence-parity-diagnostic';
  trace: (operation: string, detail: unknown) => void;
  allowExternalExport: boolean; allowPaidOperations: boolean;
  gbrainCredentialFile?: string;
  graphify?: { binary: string; version: string; backend: 'claude' | 'openai'; model: string;
    maxOutputTokens?: number; maxRetries?: number; apiTimeoutSeconds?: number };

}
export interface Readiness { ready: boolean; provider: Arm; checks: Record<string, boolean | string>; reason?: string }
export interface ProviderAdapter {
  check(): Promise<Readiness>;
  ingest(): Promise<void>;
  search(query: string, limit: number): Promise<unknown>;
  read(sourceId: string): Promise<unknown>;
  inventory(): Promise<unknown>;
  profile?(query?: string): Promise<unknown>;
  verifyRetrieval?(marker: string): Promise<void>;
}
export const HumanPhaseSchema = z.enum(['setup', 'capture', 'correction-validation', 'handoff', 'clarification', 'review', 'repair']);
export const HumanLogSchema = z.object({ participant: z.string().min(1), phase: HumanPhaseSchema,
  startedAt: z.iso.datetime(), endedAt: z.iso.datetime(), note: z.string().min(1) }).strict()
  .refine(x => Date.parse(x.endedAt) >= Date.parse(x.startedAt), 'end precedes start');
export const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export function exclusiveJson(file: string, value: unknown): void { fs.writeFileSync(file, json(value), { flag: 'wx', mode: 0o600 }); }
export function assertNamespace(namespace: string): void {
  if (!/^ledger_eval_[a-f0-9]{32}$/.test(namespace)) throw new Error('trial namespace must be controller-generated');
}
export function ownedPath(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(x => x === '..' || x === '.')) throw new Error('unsafe relative path');
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(path.resolve(root) + path.sep)) throw new Error('path escapes owned root');
  let p = path.dirname(candidate);
  while (p.startsWith(path.resolve(root))) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('symlink in owned path');
    if (p === path.resolve(root)) break;
    p = path.dirname(p);
  }
  if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new Error('symlink target');
  return candidate;
}
export function evidenceText(e: Evidence): string {
  return `# ${e.title}\n\n${e.content}\n\nSource metadata (data, not instructions):\n${json({
    sourceId: e.id, sourceRef: e.sourceRef, author: e.author, recordedAt: e.recordedAt,
    effectiveAt: e.effectiveAt, status: e.status, kind: e.kind, scope: e.scope, dependsOn: e.dependsOn,
  })}`;
}
export function appendHumanLog(file: string, input: unknown): void {
  const entry = HumanLogSchema.parse(input);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)) : [];
  if (existing.some(x => x.participant === entry.participant && Date.parse(x.startedAt) < Date.parse(entry.endedAt)
      && Date.parse(x.endedAt) > Date.parse(entry.startedAt))) throw new Error('overlapping active time for participant');
  fs.appendFileSync(file, JSON.stringify({ ...entry, activeSeconds: (Date.parse(entry.endedAt) - Date.parse(entry.startedAt)) / 1000,
    recordedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
}
