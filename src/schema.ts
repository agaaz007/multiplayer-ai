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
  // Two identical-scope results over one window can differ only because the source moved under them
  // (late-arriving events, a backfill). Without this the read path cannot tell a re-read from a dispute.
  snapshot_at: isoDate.optional().describe("When this source was read, or the source's watermark. Two results over the same window with different snapshots may be a re-read, not a disagreement."),
  snapshot_id: z.string().optional().describe("Exact immutable source version if the system has one: an export id, a table snapshot, a warehouse time-travel token."),
});

const scopeText = z.string().trim().min(1);
export const AnalyticalDateSchema = isoDate.refine((v) => {
  const [year, month, day] = v.slice(0, 10).split("-").map(Number);
  const actual = new Date(Date.UTC(year, month - 1, day));
  return actual.getUTCFullYear() === year && actual.getUTCMonth() === month - 1 && actual.getUTCDate() === day && Number.isFinite(Date.parse(v));
}, "valid ISO calendar date required");
const orderedWindow = z.object({ from: AnalyticalDateSchema, to: AnalyticalDateSchema }).refine(
  (v) => v.from <= v.to, { message: "from must not be after to", path: ["to"] }
);

/** Applicability, not an access-control grant. Missing legacy scope stays unknown. */
export const AnalysisScopeSchema = z.object({
  product: scopeText,
  dataset: scopeText,
  environment: scopeText,
  metric: scopeText,
  population: scopeText,
  grain: scopeText,
  attribution_rule: scopeText,
  window: orderedWindow.optional(),
});
export type AnalysisScope = z.infer<typeof AnalysisScopeSchema>;

export const EvidenceReferenceSchema = z.object({
  artifact_id: scopeText.optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, "SHA-256 in lowercase hexadecimal"),
  role: z.enum(["query", "parameters", "result", "dataset", "correction", "review", "reproduction", "other"]),
  session_id: scopeText.optional(),
  seq: z.number().int().min(0).optional(),
}).refine((v) => v.seq === undefined || v.session_id !== undefined, { message: "seq requires session_id" });
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const DependencySchema = z.object({
  relation: z.enum(["uses-definition", "derived-from", "based-on"]),
  id: scopeText,
  // Named content_version everywhere it is printed (ledger_get, ledger_investigation, record packs).
  // It is NOT the `snapshot` field of ledger_search results, which hashes the rendered text instead.
  version: z.string().regex(/^[a-f0-9]{64}$/, "must be the target's 64-hex content_version, printed by ledger_get and ledger_investigation (not the `snapshot` field of ledger_search)"),
});
export type Dependency = z.infer<typeof DependencySchema>;

export const CorrectionSchema = z.object({
  effect: z.enum(["historical", "future_only"]),
  reason: z.string().trim().min(3),
  effective_from: AnalyticalDateSchema.optional(),
  effective_to: AnalyticalDateSchema.optional(),
}).refine((v) => v.effect !== "future_only" || v.effective_from !== undefined,
  { message: "future_only correction requires effective_from", path: ["effective_from"] })
  .refine((v) => !v.effective_from || !v.effective_to || v.effective_from <= v.effective_to,
    { message: "effective_from must not be after effective_to", path: ["effective_to"] });
export type Correction = z.infer<typeof CorrectionSchema>;

/** Review assertion only. The host must authorize the actor before calling record. */
export const AcceptanceSchema = z.object({
  actor: scopeText,
  accepted_at: AnalyticalDateSchema,
  evidence_refs: z.array(EvidenceReferenceSchema).min(1),
  expected_predecessor: z.object({ id: scopeText, version: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
});
export type Acceptance = z.infer<typeof AcceptanceSchema>;

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
  analysis_scope: AnalysisScopeSchema.partial().optional().describe("Drafts may retain incomplete scope. Stable scoped records require all applicability facets; missing scope never establishes authority."),
  aliases: z.array(scopeText).optional().describe("Known metric or question aliases; not a scope grant."),
  dependencies: z.array(DependencySchema).optional().describe("Exact immutable versions used by this result; legacy names alone are unresolved lineage."),
  evidence_refs: z.array(EvidenceReferenceSchema).optional(),
  correction: CorrectionSchema.optional(),
  acceptance: AcceptanceSchema.optional().describe("Explicit review assertion; caller must separately authorize the actor."),
  capture_coverage: z.array(z.object({ session_id: scopeText, evidence_ids: z.array(scopeText).min(1) })).optional(),
  /** Written by discardDraft / reviewFinding(discard): who rejected the draft, when, and why. Kept in history. */
  discarded: z.object({ by: scopeText, at: isoDate, reason: scopeText }).optional(),
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

/**
 * What kind of assertion the finding makes. Different claims are falsified differently, so
 * they carry different obligations (enforced in validateClaim, which names the missing field):
 *   measurement — a quantity. Verified by re-running the recorded query under the recorded definition.
 *   comparison  — A beats B. Verified by checking comparable groups, uncertainty, and design.
 *   explanation — why A beats B. The outcome alone does not establish it; it needs a discriminating test.
 * Absent on legacy records; an unclassified claim is reported as unclassified, never assumed measured.
 */
export const CLAIM_TYPES = ["measurement", "comparison", "explanation"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** A re-run of an existing finding at an exact version. Recorded as its own finding; the target is never edited. */
export const ReproductionSchema = z.object({
  id: scopeText.describe("id of the finding this re-runs"),
  version: z.string().regex(/^[a-f0-9]{64}$/, "the target's 64-hex content_version, from ledger_get or the record result"),
  outcome: z.enum(["matched", "differed", "could_not_run"]),
  note: z.string().optional().describe("For differed/could_not_run: what differed, or what blocked the run."),
});
export type Reproduction = z.infer<typeof ReproductionSchema>;

/**
 * Query-grain stance (dec-20260917 bind-or-new). A material data pull proposes a finding at query
 * grain: {population, metric, window, result, query_ref}. It is written as a draft with stance
 * PROPOSED; a person accepts (a new stable finding with stance accepted supersedes it) or discards
 * (stance discarded, kept as a discarded cut with the reason). Absent on legacy findings.
 */
export const FINDING_STANCES = ["PROPOSED", "accepted", "discarded"] as const;
export type FindingStance = (typeof FINDING_STANCES)[number];
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "work record id (uuid) from ledger_investigations / ledger_investigation_new");
/** A window as an agent states it: exact {from,to}, or free text mapped into data_window when two ISO dates can be read from it. */
export const WindowInputSchema = z.union([z.string().trim().min(1), z.object({ from: isoDate, to: isoDate })]);

export const FindingSchema = z.object({
  ...base,
  population: z.string().min(1).optional().describe("Query grain: who is in the denominator. Mirrors inputs[0].population."),
  metric: z.string().min(1).optional().describe("Query grain: the metric measured; matches a definition's metric name when one exists."),
  window: WindowInputSchema.optional().describe("Query grain: the window as stated; data_window carries the parsed {from,to}."),
  stance: z.enum(FINDING_STANCES).optional().describe("PROPOSED (agent proposal, draft) · accepted (a person reviewed it) · discarded (kept as a discarded cut). Absent on legacy findings."),
  query_ref: z.string().regex(/^q:.+/, "capture evidence id, exactly as printed: q:<tool_use_id>").optional().describe("The retained data-tool call this result was read from."),
  investigation_record_id: uuid.optional().describe("The work record (investigation) this finding was proposed inside."),
  claim_type: z.enum(CLAIM_TYPES).optional().describe("measurement (a quantity), comparison (A beats B), or explanation (why). Each requires different supporting fields."),
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
  discriminating_test: z
    .string()
    .optional()
    .describe("Required for claim_type: explanation. An observation that would come out one way if this explanation holds and another way if a rival does. Required because the outcome it explains is consistent with every rival explanation."),
  reproduction_of: ReproductionSchema.optional().describe("This finding re-ran an existing one. Pin the same id/version in dependencies with relation derived-from."),
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
  previous_status?: "stable" | "draft";
  description: string;
  body: string;
  fields: Record<string, unknown>; // type-specific frontmatter
}
