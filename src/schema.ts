import { z } from "zod";

/**
 * Four object types. Each has one moment an agent should READ it and one
 * moment it should WRITE it. Don't add a fifth until a read visibly fails.
 *
 *   definition — read before writing a query.        kills metric drift
 *   finding    — read before starting an analysis.   kills rework
 *   change     — read before attributing a result.   kills misattribution
 *   decision   — read before proposing direction.    kills agents diverging
 *
 * Analysis is not a fifth type. Analysis is the process; a finding is its
 * durable output and carries its own inputs, method, assumptions, and
 * reproduction recipe.
 *
 * Findings and decisions are arguments, not numbers. Their schemas require
 * the parts of an argument that are usually left implicit. The schema is the
 * enforcement; prose instructions are not. A record missing them is rejected
 * with a message that says what to add.
 *
 * Shape borrowed from two standards: MADR (Markdown Any Decision Records) for
 * decisions, and the analytic tradecraft standards in ICD 203 plus the Key
 * Assumptions Check for findings.
 */
export const TYPES = ["definition", "finding", "change", "decision"] as const;
export type LedgerType = (typeof TYPES)[number];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, "ISO date, e.g. 2026-09-02");

/** Common implicit assumptions. Quoted back to the agent when it lists none. */
export const IMPLICIT_ASSUMPTION_PROMPTS = [
  "event tracking / the source table is complete for the window",
  "cohort or segment assignment is logged correctly",
  "the definition used matches the one in the ledger (or the one the asker meant)",
  "no other experiment or release changed the population during the window (check changes)",
  "the denominator and attribution window match the previous analysis",
];

const AssumptionSchema = z.object({
  statement: z.string().min(3).describe("One sentence. Something that must be true for the result or decision to hold."),
  kind: z
    .enum(["explicit", "implicit"])
    .describe("explicit: stated by the asker or in the question. implicit: relied on without anyone saying it, e.g. data completeness, cohort assignment, no concurrent change."),
  evidence: z.string().optional().describe("What supports it, or 'not independently verified'."),
  if_wrong: z
    .enum(["minor", "weakens_conclusion", "changes_conclusion"])
    .default("minor")
    .describe("What happens to the conclusion if this assumption is false."),
});
export type Assumption = z.infer<typeof AssumptionSchema>;

const IMPLICIT_MESSAGE =
  `list at least one implicit assumption (kind: implicit). Every conclusion rests on some. Common ones: ` +
  IMPLICIT_ASSUMPTION_PROMPTS.join("; ") +
  `. Mark if_wrong: changes_conclusion where it applies.`;

const AssumptionsSchema = z
  .array(AssumptionSchema)
  .min(1, "at least one assumption is required; every conclusion rests on some")
  .refine((v) => v.some((a) => a.kind === "implicit"), { message: IMPLICIT_MESSAGE })
  .describe("Explicit and implicit assumptions the conclusion rests on. At least one implicit.");

const InputSchema = z.object({
  source: z
    .string()
    .min(1)
    .describe("System the data came from: mixpanel, amplitude, clickhouse, postgres.subscriptions, a doc"),
  dataset: z.string().optional().describe("Project, database, or table within the source"),
  window: z.object({ from: isoDate, to: isoDate }).optional().describe("If different from the finding's data_window."),
  population: z.string().optional().describe("Who is in the denominator: 'users shown subscription_paywall'"),
  filters: z
    .union([z.string(), z.record(z.string(), z.string())])
    .optional()
    .describe("Row-level filters, as SQL/words or a map: { country: IN, platform: android }"),
  note: z.string().optional().describe("Anything about quality or coverage of this input."),
});

const base = {
  title: z.string().min(3).max(140),
  author: z.string().min(1).describe("Who recorded this (person name, not agent name)"),
  tags: z.array(z.string()).default([]),
  description: z.string().max(200).optional().describe("One line. Derived from the main field if omitted."),
  status: z.enum(["stable", "deprecated", "draft"]).default("stable"),
  supersedes: z
    .string()
    .optional()
    .describe("id of the object this replaces; that object is marked superseded"),
  body: z.string().default("").describe("Free markdown. Keep it short; put facts in fields."),
};

export const DefinitionSchema = z.object({
  ...base,
  metric: z.string().min(1).describe("Canonical metric name, e.g. trial_to_paid_cvr"),
  formula: z.string().min(1).describe("Exact computation, in words or SQL"),
  source: z.string().min(1).describe("System of record, e.g. amplitude, postgres.subscriptions"),
  owner: z.string().min(1),
  valid_from: isoDate,
  exclusions: z.array(z.string()).default([]).describe("What is filtered out, e.g. internal users, refunds"),
  grain: z.string().optional().describe("Unit of the numerator/denominator, e.g. per user, per session"),
});

export const FindingSchema = z.object({
  ...base,
  question: z.string().min(3).describe("The question that was actually answered"),
  result: z.string().min(1).describe("The claim: headline number(s) with units, or the comparison"),
  definitions_used: z.array(z.string()).default([]).describe("metric names from definitions/"),
  data_window: z.object({ from: isoDate, to: isoDate }),
  source: z.string().min(1).describe("Primary system the data came from. Defaults to inputs[0].source."),
  inputs: z.array(InputSchema).min(1).describe("Every source, dataset, population, and filter the result was computed from."),
  method: z
    .string()
    .min(10)
    .describe("How the inputs became the result, in steps and in words. The exact SQL or call goes in `query`."),
  grain: z.string().optional().describe("Unit of comparison: user, session, order"),
  baseline: z.string().optional().describe("What the result is compared against, if a comparison"),
  query: z.string().optional().describe("The exact query / MCP call / notebook cell, so it can be re-run"),
  assumptions: AssumptionsSchema,
  alternatives_considered: z
    .array(z.string())
    .default([])
    .describe("Other explanations for the result, or other approaches, and why they were rejected."),
  limitations: z.array(z.string()).default([]).describe("Methodological limits: observational, small n, proxy metric"),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
  confidence_basis: z.string().optional().describe("Why this confidence: sample size, source quality, which assumptions were checked."),
  prior: z
    .object({
      relation: z.enum(["confirms", "revises", "contradicts", "new"]),
      ids: z.array(z.string()).default([]),
    })
    .optional()
    .describe("How this relates to earlier findings on the same question. Use supersedes for a refresh."),
  reproduce: z
    .object({
      tool: z.string().optional(),
      query_or_artifact: z.string().optional().describe("Path or reference to the saved query, notebook, or chart"),
      instructions: z.string().optional(),
    })
    .optional()
    .describe("How another agent re-runs this. Omit if `query` plus `inputs` are enough."),
  caveats: z.array(z.string()).default([]).describe("Warnings about the number itself, e.g. disagrees with a prior finding"),
});

export const ChangeSchema = z.object({
  ...base,
  what: z.string().min(3).describe("What shipped, in one sentence"),
  shipped_at: isoDate,
  surface: z.string().min(1).describe("Where users see it: paywall, pricing, onboarding, sdk, backend"),
  owner: z.string().min(1),
  scope: z.string().optional().describe("Who got it: 100%, 13-arm test, iOS only, India only"),
  related_findings: z.array(z.string()).default([]).describe("finding ids that motivated it"),
  rollback: z.string().optional().describe("How to undo, or 'none'"),
});

const OptionSchema = z.object({
  option: z.string().min(1),
  chosen: z.boolean().default(false),
  rationale: z.string().optional().describe("Why it won, or why it lost."),
});

export const DecisionSchema = z.object({
  ...base,
  decision: z.string().min(3).describe("The decision, stated so it can be false later"),
  context: z.string().min(10).describe("Context and problem statement: what forced a decision now, in two or three sentences."),
  drivers: z.array(z.string()).default([]).describe("Decision drivers: the qualities or constraints that mattered most."),
  options_considered: z
    .array(OptionSchema)
    .min(1, "list every option on the table, including 'do nothing'")
    .refine((v) => v.some((o) => o.chosen), { message: "mark the option taken with chosen: true; it should match `decision`" })
    .describe("Every alternative that was on the table, including 'do nothing', with the chosen one marked."),
  rationale: z.string().min(1),
  assumptions: AssumptionsSchema,
  consequences: z.array(z.string()).default([]).describe("What becomes easier, harder, or impossible because of this."),
  reversibility: z.enum(["reversible", "costly", "irreversible"]).optional(),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
  valid_from: isoDate,
  revisit_by: isoDate.optional().describe("Date this should be re-examined"),
  confirmation: z
    .union([
      z.string(),
      z.object({
        metric: z.string(),
        success_condition: z.string(),
        evaluate_after: z.string().optional().describe("A date or a sample size: '10,000 eligible exposures'"),
      }),
    ])
    .optional()
    .describe("How we will know it was right: the metric and threshold, and when to evaluate."),
  based_on: z.array(z.string()).default([]).describe("Evidence: finding/definition/change ids"),
  consulted: z.array(z.string()).default([]).describe("People whose input was sought."),
  owner: z.string().min(1),
});

export const SCHEMAS: Record<LedgerType, z.ZodObject<any>> = {
  definition: DefinitionSchema,
  finding: FindingSchema,
  change: ChangeSchema,
  decision: DecisionSchema,
};

export const DIRS: Record<LedgerType, string> = {
  definition: "definitions",
  finding: "findings",
  change: "changes",
  decision: "decisions",
};

/** What an object looks like once loaded from disk. */
export interface LedgerObject {
  id: string;
  type: LedgerType;
  created: string; // ISO = generated.at
  path: string; // absolute
  title: string;
  author: string;
  tags: string[];
  status: "stable" | "deprecated" | "draft";
  supersedes?: string;
  superseded_by?: string;
  description: string;
  body: string;
  fields: Record<string, unknown>; // type-specific frontmatter
}
