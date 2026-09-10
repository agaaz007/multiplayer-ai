import { z } from 'zod';
import { TaskSchema, OracleSchema } from './analytical-contract.js';

export const SequenceArm = z.enum(['ledger', 'supermemory', 'gbrain', 'graphify', 'fresh-agent']);
export const SequenceStage = z.enum(['A', 'B', 'C', 'D']);
const relativePath = z.string().min(1).refine(p => !p.startsWith('/') && !p.includes('\\')
  && p.split('/').every(s => s !== '' && s !== '.' && s !== '..'), 'input path must stay inside the stage workspace');
const file = z.object({ relativePath, content: z.string() }).strict();
export const SequenceTaskSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]+$/), title: z.string().min(1),
  provenance: z.object({ realDataFile: z.string().min(1), realDataSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceNote: z.string().min(1), benchmarkAdditions: z.array(z.string()) }).strict(),
  stages: z.array(z.object({ stage: SequenceStage, task: TaskSchema,
    inputs: z.array(file), reuseRequirements: z.array(z.object({ from: SequenceStage, contribution: z.string().min(1) })).default([]) }).strict()).length(4),
}).strict().superRefine((task, ctx) => {
  if (task.stages.map(s => s.stage).join('') !== 'ABCD') ctx.addIssue({ code: 'custom', message: 'stages must be A/B/C/D exactly once and in order' });
  if (!['A','B'].every(p => task.stages[2]?.reuseRequirements.some(r => r.from === p))) ctx.addIssue({ code: 'custom', message: 'C must need distinct contributions from A and B' });
  if (!task.stages[3]?.reuseRequirements.some(r => r.from === 'C')) ctx.addIssue({ code: 'custom', message: 'D must need C contribution' });
  for (const [i, stage] of task.stages.entries()) {
    if (stage.task.provenance.classification !== 'approved-local-import') ctx.addIssue({ code: 'custom', message: 'scored pilot requires real approved frozen sources' });
    if (new Set(stage.inputs.map(f => f.relativePath)).size !== stage.inputs.length) ctx.addIssue({ code: 'custom', message: 'duplicate stage input path' });
    if (stage.reuseRequirements.some(r => 'ABCD'.indexOf(r.from) >= i)) ctx.addIssue({ code: 'custom', message: 'reuse must reference an earlier stage' });
  }
});
export type SequenceTask = z.infer<typeof SequenceTaskSchema>;
export const SequenceOracleSchema = z.object({ taskId: z.string(), stages: z.array(z.object({ stage: SequenceStage, oracle: OracleSchema })).length(4) }).strict()
  .refine(o => o.stages.map(s => s.stage).join('') === 'ABCD', 'oracle stages must be A/B/C/D exactly once and in order');
export const PilotLimitsSchema = z.object({
  model: z.literal('gpt-5.6-sol'), simulatedUsers: z.literal(true),
  maximumApprovedUsd: z.number().positive().max(20), stageTimeoutMs: z.number().int().min(1000).max(600000),
  providerWaitMs: z.number().int().min(0).max(120000), maximumRetries: z.literal(0),
  maxStageOutputTokens: z.number().int().positive().max(16000),
  authorization: z.string().min(1),
}).strict();
