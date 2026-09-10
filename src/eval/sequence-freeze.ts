import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ownedPath, sha256, exclusiveJson } from './analytical-contract.js';
import { SequenceTaskSchema, type SequenceTask } from './sequence-contract.js';

const DataManifest = z.object({
  schema: z.literal('real-hiastro-freeze/v1'), valid: z.literal(true), synthetic: z.literal(false),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), rowCount: z.number().int().positive(),
  source: z.string().min(1), queryFile: z.string().min(1), definition: z.string().min(1),
  windowStart: z.iso.datetime(), windowEndExclusive: z.iso.datetime(),
}).passthrough();
const columns = ['user_id','day','current_config','assignment_config','canonical_login_events','legacy_login_events','trial_all','trial_499','trial_199'];

/** This gate verifies a documented real export. A metadata assertion alone never proves data origin. */
export function validateRealHiAstro(dataFile: string, manifestFile: string) {
  const bytes = fs.readFileSync(dataFile);
  const manifest = DataManifest.parse(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
  if (sha256(bytes) !== manifest.sha256) throw new Error('real data hash differs from its recorded source freeze');
  const raw = JSON.parse(bytes.toString());
  if (JSON.stringify(raw.columns) !== JSON.stringify(columns) || !Array.isArray(raw.rows)
      || raw.rows.length !== manifest.rowCount) throw new Error('real data columns or row count changed');
  const seen = new Set<string>();
  let canonical = 0, legacy = 0;
  const data: Array<Record<string, string | number | null>> = [];
  for (const row of raw.rows) {
    if (!Array.isArray(row) || row.length !== columns.length) throw new Error('invalid real data row');
    const [user, day, config, assignment, c, l, all, p499, p199] = row;
    if (typeof user !== 'string' || !/^[a-f0-9]{64}$/.test(user)) throw new Error('unhashed or invalid user identifier');
    if (!['2026-09-06','2026-09-07','2026-09-08','2026-09-09'].includes(day) || ![23,32,34].includes(config)) throw new Error('row outside the approved pilot window/population');
    if (assignment !== null && !Number.isSafeInteger(assignment)) throw new Error('invalid assignment mapping');
    if (![c,l].every(n => Number.isSafeInteger(n) && n >= 0) || c + l === 0) throw new Error('row lacks observed login evidence');
    if (![all,p499,p199].every(n => n === 0 || n === 1) || p499 > all || p199 > all) throw new Error('invalid trial flags');
    const key = `${user}:${day}`;
    if (seen.has(key)) throw new Error('duplicate user-day');
    seen.add(key); canonical += Number(c > 0); legacy += Number(l > 0);
    data.push(Object.fromEntries(columns.map((name, i) => [name, row[i]])));
  }
  if (manifest.windowStart !== '2026-09-05T18:30:00Z' || manifest.windowEndExclusive !== '2026-09-09T18:30:00Z') throw new Error('window contract differs from frozen rows');
  return { manifest, data, canonicalLoginUserDays: canonical, legacyLoginUserDays: legacy };
}

export interface ContentFreeze {
  schema: 'sequence-content-freeze/v1'; frozenAt: string;
  realData: { file: string; manifest: string; sha256: string; rowCount: number };
  taskIds: string[]; files: Record<string, string>; additions: Record<string, string[]>;
  scope: 'inputs-and-grading-contracts'; executionAuthorized: false;
}

/** Freeze task content separately from runtime readiness. New revisions require a new destination. */
export function freezeSequenceContent(root: string, input: {
  dataFile: string; dataManifest: string; taskFiles: string[]; requiredFiles: string[]; destination: string;
}): ContentFreeze {
  const dataFile = ownedPath(root, input.dataFile), manifestFile = ownedPath(root, input.dataManifest);
  const real = validateRealHiAstro(dataFile, manifestFile);
  const tasks: SequenceTask[] = input.taskFiles.map(file => SequenceTaskSchema.parse(JSON.parse(fs.readFileSync(ownedPath(root, file), 'utf8'))));
  if (tasks.length !== 2 || new Set(tasks.map(t => t.id)).size !== 2
      || new Set(tasks.map(t => t.stages[0].task.kind)).size !== 2) throw new Error('freeze needs the separate real analysis and coding tasks');
  for (const task of tasks) {
    if (task.provenance.realDataSha256 !== real.manifest.sha256 || fs.realpathSync(task.provenance.realDataFile) !== fs.realpathSync(dataFile)) throw new Error('both tasks must use this same real data freeze');
    for (const stage of task.stages) {
      if (stage.task.kind !== task.stages[0].task.kind) throw new Error('task kind changes within a sequence');
      if (JSON.stringify(stage.task.data) !== JSON.stringify(real.data)) throw new Error('a stage uses missing, changed or synthetic data');
      if (stage.task.coding && stage.task.coding.commit !== task.stages[0].task.coding?.commit) throw new Error('coding starting commit changes between stages');
    }
  }
  const files: Record<string,string> = {};
  for (const file of [...new Set([input.dataFile,input.dataManifest,real.manifest.queryFile,...input.taskFiles,...input.requiredFiles])].sort()) {
    const target = ownedPath(root, file);
    if (!fs.statSync(target).isFile()) throw new Error('freeze inputs must be regular files');
    files[file] = sha256(fs.readFileSync(target));
  }
  const freeze: ContentFreeze = { schema: 'sequence-content-freeze/v1', frozenAt: new Date().toISOString(),
    realData: { file: input.dataFile, manifest: input.dataManifest, sha256: real.manifest.sha256, rowCount: real.data.length },
    taskIds: tasks.map(t => t.id), additions: Object.fromEntries(tasks.map(t => [t.id, t.provenance.benchmarkAdditions])), files,
    scope: 'inputs-and-grading-contracts', executionAuthorized: false };
  exclusiveJson(ownedPath(root, input.destination), freeze);
  return freeze;
}

export function verifySequenceContent(root: string, manifestPath: string): ContentFreeze {
  const freeze: ContentFreeze = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (freeze.schema !== 'sequence-content-freeze/v1' || freeze.scope !== 'inputs-and-grading-contracts' || freeze.executionAuthorized !== false
      || !Object.keys(freeze.files ?? {}).length) throw new Error('invalid content freeze');
  for (const [file, hash] of Object.entries(freeze.files)) {
    if (sha256(fs.readFileSync(ownedPath(root, file))) !== hash) throw new Error(`frozen content changed: ${file}`);
  }
  const data = validateRealHiAstro(ownedPath(root, freeze.realData.file), ownedPath(root, freeze.realData.manifest));
  if (data.manifest.sha256 !== freeze.realData.sha256 || data.data.length !== freeze.realData.rowCount) throw new Error('data freeze binding changed');
  return freeze;
}
