/**
 * Continuity evaluation adapter: the CONTRACT between the fixture/origin/successor
 * drivers, the collector, and the condition plugins. Signatures and types here are
 * fixed; implementers fill bodies in sibling modules. See eval/kit/ADAPTER.md for the
 * runner protocol this adapter speaks (one JSON request on stdin, one JSON observation
 * on stdout, artifacts under request.output_dir).
 *
 * Experimental integrity rules the contract enforces by shape:
 *   - the successor never receives fixture ids, expected answers, or the origin transcript;
 *   - retrieved_evidence is filled ONLY from what the successor actually received through its tools;
 *   - the controller (this adapter) sees everything and writes raw traces for review;
 *   - every trial uses disposable resources: temp repo + bare remote, temp ledger repo, temp
 *     LEDGER_CONFIG_DIR, an eval Postgres database, and (gbrain) a temp HOME with its own brain.
 */

export type Harness = "claude" | "codex";
export type Direction = "codex-to-claude" | "claude-to-codex";
/** The memory substrate the successor is allowed to use. */
export type Condition = "ours" | "gbrain";

// ---------- kit protocol (mirrors continuity_eval.py) ----------

export interface FixtureEvent { id: string; topic: string; text: string; author: string; session: string }

export interface PublicCase {
  id: string;
  level: number;
  title: string;
  events: FixtureEvent[];
  resume_prompt: string;
  setup: string[];
  answer_keys: string[];
  successor_answer_contract: unknown;
  seed_files?: Record<string, string>;
  stress_requirements?: { minimum_origin_tokens: number; maximum_boot_tokens: number; minimum_compactions: number };
}

export interface AdapterRequest {
  protocol_version: 1;
  case: PublicCase;
  direction: Direction;
  repetition: number;
  trial_id: string;
  output_dir: string;
}

export interface Provenance {
  mode: "live" | "unconfigured";
  system_revision: string;
  run_ref: string;
  origin_harness: Harness;
  successor_harness: Harness;
  origin_harness_version: string;
  successor_harness_version: string;
  origin_model: string;
  successor_model: string;
  /** not in the kit's schema; recorded for our matrix */
  condition: Condition;
  topology: "same-machine" | "two-machine";
}

export interface RetrievedEvidence { text: string; system_ref: string; raw_ref: string }

export interface Observation {
  status: "completed" | "skipped" | "error";
  reason?: string;
  provenance: Partial<Provenance> & { mode: Provenance["mode"] };
  answers?: Record<string, { value: unknown; evidence_ids: string[] }>;
  retrieved_evidence?: Record<string, RetrievedEvidence>;
  selected_topic?: string;
  recovered_files?: string;
  final_files?: string;
  actions_file?: string;
  ownership_file?: string;
  parallel_file?: string;
  stress_file?: string;
  coverage_file?: string;
  metrics?: Metrics;
}

export interface Metrics {
  successor_boot_tokens?: number;
  successor_total_input_tokens?: number;
  retrieved_tokens?: number;
  resume_latency_ms?: number;
  time_to_first_correct_action_ms?: number;
  completion_latency_ms?: number;
  origin_turns?: number;
  origin_wall_ms?: number;
  successor_wall_ms?: number;
  successor_tool_calls?: number;
  capture_lag_ms?: number;
}

// ---------- trial resources ----------

export interface TrialPaths {
  root: string;            // <tmp>/<trial_id>
  repo: string;            // origin worktree (git, with remote)
  bare: string;            // bare remote
  successorRepo: string;   // fresh clone for the successor
  ledgerDir: string;       // disposable ledger repo (git, no remote)
  configDir: string;       // LEDGER_CONFIG_DIR for hooks/helper/MCP in this trial
  homeDir: string;         // per-trial HOME for gbrain and any harness state that must not leak
  rawDir: string;          // output_dir/raw
  outputDir: string;
}

export interface TrialContext {
  request: AdapterRequest;
  condition: Condition;
  paths: TrialPaths;
  originHarness: Harness;
  successorHarness: Harness;
  originAuthor: string;    // "rachit" for session-a events, "agaaz" for session-b (swapped in reverse direction)
  successorAuthor: string;
  originModel: string;
  successorModel: string;
  evalDatabaseUrl: string; // postgresql://localhost:5432/ledger_eval
  /** log line sink; also appended to raw/controller.log (redacted) */
  log: (line: string) => void;
}

// ---------- drivers ----------

export interface OriginTurnResult {
  harness: Harness;
  sessionId: string;           // the harness's own session/thread id (transcript identity)
  transcriptPath: string | null;
  turnIndex: number;
  fixtureEventId: string;
  assistantText: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read?: number };
  wallMs: number;
}

export interface OriginRun {
  harness: Harness;
  sessionIds: string[];        // one per fixture session label (session-a, session-b)
  turns: OriginTurnResult[];
  transcriptPaths: string[];
  totalInputTokens: number;
  compactions: number;         // real compaction/reset events observed in the transcript
}

export interface SuccessorRun {
  harness: Harness;
  sessionId: string;
  transcriptPath: string | null;
  /** the successor's final JSON (answers + selected_topic + free text), parsed leniently */
  output: Record<string, unknown> | null;
  rawOutputPath: string;       // raw/successor-output.json
  toolCalls: { tool: string; input: string; output_preview: string; at: string | null; call_id: string | null }[];
  bootTokens: number | null;   // input tokens of the first model call (prompt + tools + brief), from harness usage
  totalInputTokens: number | null;
  wallMs: number;
}

// ---------- condition plugin ----------

export interface ConditionPlugin {
  name: Condition;
  /**
   * After the origin run: make the origin's evidence available to the successor the way this
   * substrate would. `ours`: run the helper pass(es) so events, snapshots, checkpoints, and
   * classification land in the eval database. `gbrain`: ingest the same normalized events into
   * the trial brain as pages/timeline entries.
   */
  prepare(ctx: TrialContext, origin: OriginRun): Promise<{ notes: string[]; prepared_ms: number }>;
  /**
   * What the successor process gets: env, MCP config path, allowed tools, working directory,
   * and any extra prompt preamble (never fixture ids or answers).
   */
  successorSetup(ctx: TrialContext): Promise<{ env: Record<string, string>; mcpConfigPath: string | null; allowedTools: string[]; cwd: string; preamble: string }>;
  /** Map fixture event ids to real system refs by exact text, for evidence validation. */
  evidenceRef(ctx: TrialContext, fixtureEvent: FixtureEvent): Promise<{ system_ref: string } | null>;
}

// ---------- case orchestration ----------

export interface CaseRunner {
  id: string;
  /** Anything beyond the common flow: seed files, fake services, third agent, race, faults. */
  before?(ctx: TrialContext): Promise<void>;
  /** Origin turns are the fixture events in order unless overridden. */
  originEvents?(ctx: TrialContext): FixtureEvent[];
  /** Cases with real context resets may own the origin lifecycle and retain every epoch trace. */
  runOrigin?(ctx: TrialContext): Promise<OriginRun>;
  /** Controller fixture work after real origin turns, before capture. Record any mutations in raw traces. */
  afterOrigin?(ctx: TrialContext, origin: OriginRun): Promise<void>;
  /** Start concurrent work or verify the recovered starting state immediately before the successor. */
  beforeSuccessor?(ctx: TrialContext): Promise<void>;
  /** Case-specific collector artifacts (ownership.json, parallel.json, coverage.json, actions.json). */
  collect?(ctx: TrialContext, origin: OriginRun, successor: SuccessorRun): Promise<Partial<Observation>>;
  after?(ctx: TrialContext): Promise<void>;
}

// ---------- comparison ----------

export interface MatrixCell { condition: Condition; case: string; direction: Direction; repetition: number; status: string; checks: { type: string; key?: string; status: string }[]; metrics: Metrics }
export interface Matrix {
  generated_at: string;
  suite_sha256: string;
  conditions: Condition[];
  cells: MatrixCell[];
  levels: Record<Condition, Record<number, { passed: number; total: number; qualified: boolean }>>;
  summary: Record<Condition, { pass_rate: number; median_boot_tokens: number | null; median_resume_latency_ms: number | null }>;
}
