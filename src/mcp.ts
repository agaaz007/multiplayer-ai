import { startHandoff, updateHandoff } from "./continuity/handoffs.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { loadConfig, loadAll, record, getById, discardDraft, proposeFinding, reviewFinding, type Config } from "./store.js";
import { brief, search, similarFindings, renderFull, stats, objectScopeLine } from "./query.js";
import { AnalyticalDateSchema, AnalysisScopeSchema, ChangeSchema, DecisionSchema, DefinitionSchema, FindingSchema, WindowInputSchema, TYPES, type LedgerObject } from "./schema.js";
import { correctionImpact, objectVersion, resolveAccepted, verification } from './authority.js';
import { investigation } from './investigation.js';
import { validateCaptureCoverage, acknowledgeCapture, loadJournal, type CaptureAck, type CaptureCoverage } from './hooks.js';
import { verifyAcceptanceEvidence } from './acceptance-evidence.js';
import { validateRecordCoverage, acknowledgeLocalCapture, reconcileSharedCapture } from './capture-boundary.js';
import { EVIDENCE_URI, ReferenceSchema, evidenceResult, contributionResult } from "./evidence.js";
import { RECEIPT_GUIDANCE, savedReceipt, receiptText } from "./receipts.js";
import { continuityConfigured, getPool } from "./continuity/db.js";
import { listThreads, createThread, getThread, claimThread, releaseClaim, upsertSession, appendEvents, getSession } from "./continuity/store.js";
import { buildResumePack, threadLine } from "./continuity/resume.js";
import { queryEvents, getArtifact, eventLine, resolveSessionId, resolveSearchScope, scopeLine, EVENTS_DEFAULT_LIMIT, EVENTS_MAX_LIMIT, PREVIEW_CHARS, PREVIEW_MAX_CHARS, ARTIFACT_DEFAULT_CHARS, ARTIFACT_MAX_CHARS } from "./continuity/evidence.js";
import { repoRoot, repoIdentity, currentBranch } from "./continuity/shadow.js";
import { forbiddenSnapshotRoot, localTranscriptExists, resolveHarnessSession, resolveHarnessIdentity, type HarnessIdentity } from "./continuity/safety.js";
import { openThreadsText } from "./continuity/brief.js";
import { writeBinding, writeSignal } from "./helper/signals.js";
import { buildRecordPack, listRecordSummaries, recordLine, unassignedLine } from "./continuity/recordpack.js";
import { addStateUpdate, asOfRecordSummaries, confirmStateUpdate, createRecord, getRecord, linkSpan, recordsForSession, rejectStateUpdate, searchEvidence, unassignedSpans, updateRecordMeta } from "./continuity/records.js";
import { acceptanceLabel } from "./continuity/packsections.js";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const refused = (s: string) => ({ ...text(s), isError: true as const });

// ---------- investigation binding (dec-20260917 bind-or-new) ----------
// src/continuity/investigations.ts is owned by the continuity side and may not be on disk in every
// build; the contract below is what it exports. Loaded on demand so a missing module refuses
// clearly at call time instead of failing the whole server at import.
type AnyPool = ReturnType<typeof getPool>;
interface InvestigationsModule {
  listInvestigations(pool: AnyPool, cfg: Config, o: { q?: string; author?: string; hours?: number; limit?: number }): Promise<{ text: string; items: unknown[] }>;
  bindInvestigation(pool: AnyPool, cfg: Config, o: { record_id: string; session_id: string; question?: string; request_id?: string; identity?: HarnessIdentity }): Promise<{ text: string; record_id: string; title: string; already_bound: boolean }>;
  declareInvestigation(pool: AnyPool, cfg: Config, o: { question: string; goal?: string; session_id: string; repo?: string; request_id?: string; identity?: HarnessIdentity }): Promise<{ text: string; record_id: string }>;
  sessionBinding(pool: AnyPool, session_id: string): Promise<unknown>;
}
const INVESTIGATIONS_MODULE: string = "./continuity/investigations.js";
async function investigationsModule(): Promise<InvestigationsModule> {
  try { return (await import(INVESTIGATIONS_MODULE)) as InvestigationsModule; }
  catch (e: any) { throw new Error(`investigation binding is not available in this build (${INVESTIGATIONS_MODULE}: ${String(e?.message ?? e).slice(0, 120)})`); }
}
/** Whatever shape sessionBinding returns, the bound work record id is what a proposal needs. */
function boundRecordId(binding: unknown): string | undefined {
  if (!binding) return undefined;
  if (typeof binding === "string") return binding;
  const o = binding as Record<string, unknown>;
  for (const k of ["record_id", "investigation_record_id", "id"]) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  return undefined;
}
/**
 * The retained query input for a capture evidence id, hash-checked: the helper stores each data-tool
 * call's full input as a cont_artifacts row and stamps input_artifact_id/sha256 on its tool.requested
 * event (materializeArtifacts). Null when the event, the artifact or the hash is missing; acceptance
 * then pins the reviewed draft only and says so.
 */
async function locateQueryArtifact(pool: AnyPool, queryRef: string): Promise<{ artifact_id: string; sha256: string } | null> {
  const ev = await pool.query<{ id: string | null; sha: string | null }>(
    `select payload->>'input_artifact_id' as id, payload->>'input_artifact_sha256' as sha from cont_events
      where kind='tool.requested' and payload->'evidence_ids' ? $1 and payload->>'input_artifact_id' is not null order by received_at desc limit 1`, [queryRef]);
  const row = ev.rows[0];
  if (!row?.id || !row.sha || !/^[a-f0-9]{64}$/.test(row.sha)) return null;
  const art = await pool.query<{ inline: Buffer | null }>(`select inline from cont_artifacts where id::text = $1 and sha256 = $2`, [row.id, row.sha]);
  const inline = art.rows[0]?.inline;
  if (!inline || createHash("sha256").update(inline).digest("hex") !== row.sha) return null;
  return { artifact_id: row.id, sha256: row.sha };
}
function coverageOf(fields: Record<string, unknown>): CaptureCoverage[] {
  const raw = fields.capture_coverage;
  return Array.isArray(raw) ? raw.filter((c): c is CaptureCoverage => c && typeof c.session_id === "string" && Array.isArray(c.evidence_ids) && c.evidence_ids.length > 0) : [];
}

export function createMcpServer(cfg: Config, opts: { guidePath?: string } = {}) {
  const server = new McpServer({ name: "ledger", version: "0.1.0" });
  const evidenceUi = { ui: { resourceUri: EVIDENCE_URI } };
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  // An explicit session_id, else a harness env id with a local transcript. Never a synthetic id: the helper
  // looks bindings up by the transcript's id, so a claim written for `mcp:<author>:<pid>` split the successor's
  // work onto another thread (2026-09-13 review). Claude Code exports CLAUDE_CODE_SESSION_ID.
  const sessionOf = (given?: string): string => {
    const r = resolveHarnessSession(given, process.env, (id) => localTranscriptExists(id));
    if (!r.ok) throw new Error(r.error);
    return r.id;
  };
  const handoffResult = async (pack: any, source_kind: "record" | "thread", source_id: string, sid: string | undefined, mode: "continue" | "fork" | "inspect") => {
    if (!sid || mode === "inspect") return text(pack.text);
    if ((source_kind === "thread" || pack.claim.thread_id) && !pack.claim.acquired) return { ...text(pack.text), isError: true as const };
    const code = source_kind === "thread" || pack.record?.kind === "implementation";
    const verified = source_kind === "thread" ? Boolean(pack.loss_window?.verified_snapshot_at) : Boolean(pack.bootstrap?.length && pack.contributing_sessions?.some((s: any) => s.verified_snapshot_at && s.wip_commit && pack.bootstrap.join("\n").includes(s.wip_commit)));
    try {
      const id = await startHandoff(getPool(cfg), {source_kind,source_id,destination_session:sid,author:cfg.author,mode,work_kind:code ? "code" : "analysis",source_snapshot_verified:verified,pending_operations:pack.pending_operations?.length ?? 0});
      return {...text(`${pack.text}\n\nHandoff attempt: ${id} (pack delivered, not completed). After verifying the evidence or bootstrap and delivering the continuation, report exact captured events with ledger_handoff_update. Pending mutations must be reconciled before retrying.`), structuredContent:{handoff:{id,status:"pack_delivered",source_kind,source_id,source_snapshot_verified:verified,attribution:"agent-reported"}}};
    } catch {
      return {...text(`${pack.text}\n\nHandoff tracking unavailable; this read does not establish a completed handoff. Do not repeat a claim just to retry telemetry.`), structuredContent:{handoff:{status:"unavailable"}}};
    }
  };
  const poolIfAny = (): AnyPool | null => (continuityConfigured(cfg) ? getPool(cfg) : null);
  /** Additive: append a Ledger object to the investigation record's ledger_refs so the pack's decisions/refs machinery sees it. */
  const linkToInvestigation = async (pool: AnyPool, recordId: string, ref: { id: string; version?: string }): Promise<string> => {
    const rec = await getRecord(pool, recordId);
    if (!rec) return ` Investigation ${recordId} was not found among the work records; the finding carries investigation_record_id but the record's ledger_refs were not updated.`;
    const merged = [...(rec.ledger_refs ?? [])];
    if (!merged.some((r) => r.id === ref.id)) merged.push(ref);
    await updateRecordMeta(pool, rec.id, { ledger_refs: merged });
    return ` Linked to investigation "${rec.title}" (${rec.id}) as a ledger ref.`;
  };

  registerAppResource(server, "Ledger evidence card", EVIDENCE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{
      uri: EVIDENCE_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(new URL("./ui/evidence.html", import.meta.url), "utf8"),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } },
    }],
  }));

  server.registerTool(
    "ledger_brief",
    {
      title: "Ledger brief",
      description:
        "Call this FIRST in any session that touches metrics, analysis, product direction, or shipping. Returns canonical metric definitions, decisions in force, and recent findings and changes. Small enough to keep in context.",
      inputSchema: {
        days: z.number().int().min(1).max(90).default(14).describe("Lookback window"),
        tags: z.array(z.string()).optional().describe("Filter to tags, e.g. ['hiastro']"),
      },
      annotations: readOnly,
    },
    async ({ days, tags }) => {
      const capture = reconcileSharedCapture(cfg);
      const b = brief(cfg, { days, tags, guidePath: opts.guidePath });
      const threads = await openThreadsText(cfg, { cwd: process.cwd(), includeOwn: false });
      return text([b,threads,...capture.warnings].filter(Boolean).join('\n\n'));
    }
  );

  registerAppTool(server,
    "ledger_search",
    {
      title: "Search the ledger",
      description:
        "Search definitions, findings, changes, and decisions by free text. Use it BEFORE running an analysis (has this question been answered?), before attributing a metric move (what shipped?), and before proposing direction (what was decided?). Ranked by authority first (current > draft > superseded), then recency, then lexical score; every hit is labelled current, draft, superseded by <id>, rejected or deprecated, and the first line states the scope searched. Ledger objects are not repo-scoped; filter by author, types, tags. Shows retrieved evidence, not proof of use. If your answer builds on these records, call ledger_show_contribution with the actual record IDs and answer excerpts." + RECEIPT_GUIDANCE,
      _meta: evidenceUi,
      annotations: readOnly,
      inputSchema: {
        query: z.string().min(2),
        types: z.array(z.enum(TYPES)).optional(),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(50).default(10),
        include_superseded: z.boolean().default(false).describe("Also return superseded, deprecated and draft objects, each labelled (tier 0 / tier 2)"),
        author: z.string().optional().describe("Only objects recorded under this author"),
        analysis_scope: AnalysisScopeSchema.partial().optional().describe('Analytical applicability, not a permission boundary'),
        as_of: AnalyticalDateSchema.optional().describe('Effective date for definition/correction resolution'),
      },
    },
    async ({ query, types, tags, limit, include_superseded, author, analysis_scope, as_of }) => {
      const opts = { types, tags, limit, includeSuperseded: include_superseded, author, scope: analysis_scope, asOf: as_of };
      const scope = objectScopeLine(opts);
      const hits = search(cfg, query, opts);
      const summary = hits.map((h) => ({ id: h.id, type: h.type, authority_tier: h.authority_tier, authority_label: h.authority_label, authority_status: h.authority_status, score: h.score, created: h.created }));
      if (!hits.length) {
        const r = evidenceResult(`${scope}\nNo matches for "${query}". If you go on to answer this, record the finding.`, [], { query });
        return { ...r, structuredContent: { ...r.structuredContent, scope, hits: summary } };
      }
      const r = evidenceResult(
        [scope, ...hits
          .map((h) => `[tier ${h.authority_tier} · ${h.authority_label}] [${h.score.toFixed(2)}] ${h.type} ${h.id} — ${h.title}\n    ${(h.fields.result ?? h.fields.formula ?? h.fields.decision ?? h.fields.what ?? "")}\n    Authority: ${h.authority_status}${h.authority_status==='conflict' ? `; competing accepted sources: ${h.authority_current_ids.join(', ')}; do not choose by recency` : ''}${h.authority_warnings.length ? `\n    ${h.authority_warnings.join('\n    ')}` : ''}`)]
          .join("\n"), hits, { query }
      );
      return { ...r, structuredContent: { ...r.structuredContent, scope, hits: summary } };
    }
  );

  registerAppTool(server,
    "ledger_get",
    {
      title: "Get one ledger object",
      description: "Fetch a full object by id (e.g. fnd-20260902-trial-cvr-ab12) including its query and body." + RECEIPT_GUIDANCE,
      inputSchema: { id: z.string(), as_of: AnalyticalDateSchema.optional() },
      _meta: evidenceUi,
      annotations: readOnly,
    },
    async ({ id, as_of }) => {
      const o = getById(cfg, id);
      if (!o) return evidenceResult(`Not found: ${id}`, [], { missing_ids: [id] });
      // One load: the object set feeds both resolution and verification, and a second read of the
      // whole ledger per ledger_get is exactly the amplification this surface is supposed to avoid.
      const all = loadAll(cfg, TYPES, false);
      const authority = resolveAccepted(all, id, {asOf: as_of});
      const current = authority.current.filter(c=>c.id !== o.id);
      const objects = [...new Map([o,...current,...authority.proposals].map(x=>[x.id,x])).values()];
      const claim = o.type === 'finding' ? verification(all, o) : null;
      return evidenceResult([renderFull(o), `content_version: ${objectVersion(o)}`, `Accepted resolution: ${authority.status}`,
        ...(claim ? [`Verification: ${claim.status}${claim.notes.length ? ` — ${claim.notes.join('; ')}` : ''}. Accepted is a review assertion; reproduced means someone re-ran the recorded recipe at this exact content_version.`] : []),
        ...authority.warnings.map(w=>`WARNING: ${w}`),
        ...current.map(c=>`Applicable accepted source:\n${renderFull(c)}\ncontent_version: ${objectVersion(c)}`),
        ...authority.proposals.map(p=>`PROPOSED, not accepted: ${p.id} — ${p.title}`)].join('\n\n'), objects);
    }
  );

  registerAppTool(server, 'ledger_investigation', {
    title: 'Continue an analytical investigation',
    description: 'Retrieve accepted definitions, correction history, exact dependencies and affected results across full history before continuing analytical work. Proposed claims cannot displace accepted knowledge. Supply analytical scope; missing scope and lineage remain explicit.' + RECEIPT_GUIDANCE,
    inputSchema: { question: z.string().min(2), analysis_scope: AnalysisScopeSchema.partial().optional(), definition_ids: z.array(z.string()).optional(), as_of: AnalyticalDateSchema.optional(), limit: z.number().int().min(1).max(50).default(10), candidate_limit: z.number().int().min(1).max(50).default(5) },
    _meta: evidenceUi, annotations: readOnly,
  }, async ({question, analysis_scope, definition_ids, as_of, limit, candidate_limit}) => {
    const pack = investigation(cfg, {question, scope:analysis_scope, definition_ids, as_of, limit, candidate_limit});
    const result = evidenceResult(pack.text, pack.objects, {query: question, candidate_count: pack.legacy_candidates.length});
    return {...result, structuredContent: {...result.structuredContent, investigation: pack}};
  });

  registerAppTool(server, 'ledger_impact', {
    title: 'Review work affected by a correction',
    description: 'Traverse exact definition and finding dependencies from an accepted correction. Returns direct/transitive review paths, incomplete legacy lineage, and whether the correction changes what anyone does next (interrupt). Needs review does not mean false.' + RECEIPT_GUIDANCE,
    inputSchema: { correction_id: z.string() }, _meta: evidenceUi, annotations: readOnly,
  }, async ({correction_id}) => {
    const all = loadAll(cfg,TYPES);
    const impact = correctionImpact(all, correction_id);
    const ids = new Set([correction_id,...impact.affected.map(a=>a.id)]);
    const result = evidenceResult(JSON.stringify(impact,null,2), all.filter(o=>ids.has(o.id)));
    return {...result, structuredContent: {...result.structuredContent, impact}};
  });

  registerAppTool(server, "ledger_show_contribution", {
    title: "Show Ledger's contribution",
    description: "After using ledger evidence in an answer, show an expandable attribution card linking actual record IDs to exact answer excerpts and their contribution. Source author, date and status are fetched from the ledger. Usage is agent-reported, not independently verified. This only displays a card: it does not save a finding or clear the recording checkpoint. Keep ordinary citations in the answer for hosts without MCP Apps." + RECEIPT_GUIDANCE,
    inputSchema: { references: z.array(ReferenceSchema).min(1).max(20) },
    _meta: evidenceUi,
    annotations: readOnly,
  }, async ({ references }) => contributionResult(cfg, references));

  const recordTool = (
    name: string,
    type: (typeof TYPES)[number],
    schema: z.ZodObject<any>,
    description: string
  ) =>
    server.registerTool(
      name,
      { title: `Save Ledger ${type}`, description: description + RECEIPT_GUIDANCE, inputSchema: schema.omit({ author: true }).extend({ author: z.string().optional() }).shape },
      async (fields: any) => {
        const coverage = await validateRecordCoverage(cfg, fields);
        await verifyAcceptanceEvidence(cfg, fields);
        // Rework check for findings: surface prior answers before writing a new one.
        let warn = "";
        if (type === "finding") {
          const sim = similarFindings(cfg, String(fields.question), 5, { scope: fields.analysis_scope });
          if (sim.length) {
            warn =
              `\n\nNote: ${sim.length} finding(s) ask a similar question, closest first. Each is a candidate, not a duplicate: check the population and window before treating one as the same answer. If yours is a refresh of one, set supersedes to its id. If the numbers disagree, say why in caveats.\n` +
              sim.map((s) => `  [${s.similarity.toFixed(2)}] ${s.id} (${s.author}, ${s.created.slice(0, 10)}): ${s.fields.result}`).join("\n");
          }
        }
        const res = record(cfg, { type, fields });
        let captureAck: CaptureAck | undefined;
        let captureWarning = '';
        if (coverage.length) {
          const ack: CaptureAck = {schema:'ledger-capture/v1',action:'record',status:fields.status === 'draft' ? 'pending_review' : 'recorded',coverage,record_id:res.id};
          try {
            const applied = acknowledgeLocalCapture(ack); captureAck = ack;
            if(applied.remote_pending) captureWarning = `\n${applied.remote_pending} remote evidence acknowledgment(s) saved in this record; the source machine must pull and reconcile before its local journal is updated.`;
          }
          catch (error) { captureWarning = `\nFinding saved, but local capture acknowledgment failed: ${String(error)}. Do not duplicate the saved object; capture remains outstanding.`; }
        }
        // A source-inspection failure must not turn a successful write into an
        // error that invites the agent to retry and create a duplicate record.
        let objects: LedgerObject[] | null = null;
        try { objects = loadAll(cfg, TYPES, false); } catch { /* receipt reports unavailable details */ }
        const receipt = savedReceipt(type, fields, res, objects, cfg.git_sync);
        // Hand back the pin the caller needs next. Without this the only way to learn a new
        // object's content_version was ledger_get on the object you had just written, so every
        // "record a definition, then pin a finding to it" cost an extra round trip.
        const saved = objects?.find((o) => o.id === res.id) ?? null;
        const contentVersion = saved ? objectVersion(saved) : null;
        const details =
          `Recorded ${type} ${res.id}` +
            (res.superseded ? ` (superseded ${res.superseded})` : "") +
            (res.git ? ` — ${res.git}` : "") +
            (contentVersion
              ? `\ncontent_version: ${contentVersion} — pin dependencies to this value; do not re-read this object to fetch it.`
              : `\ncontent_version unavailable (the ledger could not be re-read); fetch it with ledger_get(${res.id}) before pinning a dependency.`) +
            warn + captureWarning;
        return { content: [receiptText(receipt, details)], structuredContent: { receipt, ...(contentVersion ? { content_version: contentVersion } : {}), ...(captureAck ? {capture_ack:captureAck} : {}) } };
      }
    );

  recordTool(
    "ledger_record_definition",
    "definition",
    DefinitionSchema,
    "Record a canonical metric definition. Do this whenever you compute a metric that has no definition in the ledger, or when a definition changes (set supersedes)."
  );
  recordTool(
    "ledger_record_finding",
    "finding",
    FindingSchema,
    "Record the result of an analysis as an argument, not a number: question, result, definitions used, data window, inputs (every table/event), method (how inputs became the result, in words), the exact query, and assumptions. At least one assumption must be kind: implicit (data completeness, definition match, nothing shipped in the window); the tool rejects the record otherwise and says what to add. Set claim_type: a measurement needs the exact query so it can be re-run; a comparison needs baseline and confidence_basis; an explanation needs a discriminating_test, rival explanations, and a derived-from pin to the result it explains, because the outcome alone is consistent with every rival. Record inputs[].snapshot_at so a later re-read can be told apart from a disagreement. To re-run someone's finding, record your own with reproduction_of {id, version, outcome}. Do this at the END of any analysis, even a small one, even at low confidence. Returns similar prior findings so duplicates are visible."
  );
  recordTool(
    "ledger_record_change",
    "change",
    ChangeSchema,
    "Record something that shipped to users or to production: what, when, where, to whom. Do this the moment something goes live, so other people's agents stop misattributing metric moves."
  );
  recordTool(
    "ledger_record_decision",
    "decision",
    DecisionSchema,
    "Record a product or company decision in MADR shape: the decision stated so it could later be false, the context that forced it, every option considered including 'do nothing' with why each lost, rationale, assumptions (at least one implicit), consequences, a revisit date, and how we'll confirm it was right. Do this when a direction is chosen, dropped, or reversed (set supersedes on reversal)."
  );

  server.registerTool(
    "ledger_skip_record",
    {
      title: "Skip recording, with a reason",
      description:
        "Dismiss only the explicitly named capture evidence after checking it produced no durable finding. Unnamed queries remain outstanding. Explain why; never use a skip to hide a relevant analysis.",
      inputSchema: {
        reason: z.string().min(5).describe("Why nothing here is worth a record, in one or two sentences"),
        capture_coverage: z.array(z.object({session_id:z.string().min(1),evidence_ids:z.array(z.string().min(1)).min(1)})).optional(),
      },
    },
    async ({ reason, capture_coverage }) => {
      const coverage = validateCaptureCoverage(capture_coverage);
      if (!coverage.length) return text(`Reason noted; no evidence IDs supplied, so capture obligations remain outstanding: ${reason}`);
      const ack: CaptureAck = {schema:'ledger-capture/v1',action:'skip',status:'dismissed',coverage,reason};
      acknowledgeCapture(ack);
      return {...text(`Explicit evidence dismissed: ${reason}`),structuredContent:{capture_ack:ack}};
    }
  );

  server.registerTool(
    "ledger_discard_draft",
    {
      title: "Discard a draft",
      description:
        "Reject a draft created by the transcript fallback (listed in the brief under 'Drafts awaiting review'). Read it first with ledger_get. To promote instead, verify it and record a stable object with supersedes set to the draft id. Discarding needs a reason and is kept in history.",
      inputSchema: {
        id: z.string().describe("draft id, e.g. fnd-20260903-...-ab12"),
        reason: z.string().min(5).describe("Why it is not durable knowledge: duplicate, wrong, exploration only"),
      },
    },
    async ({ id, reason }) => {
      const r = discardDraft(cfg, id, reason);
      return text(`Discarded ${r.id}${r.git ? ` — ${r.git}` : ""}`);
    }
  );

  // ---------- query-grain findings (dec-20260917 bind-or-new): agent proposes, a person accepts or discards ----------
  server.registerTool(
    "ledger_propose_finding",
    {
      title: "Propose a query-grain finding",
      description:
        "After each material data pull, propose a finding at QUERY grain: on this population, this metric, this window, the result was Y, read from query_ref (the q:<tool_use_id> evidence id the checkpoint prints). Writes a DRAFT finding with stance PROPOSED inside the session's investigation (bound with ledger_investigation_bind / ledger_investigation_new, or passed as investigation_record_id) and covers that query as pending_review. It never accepts: a person reviews with ledger_review_finding. Refuses when the session is unbound and no investigation_record_id is given, so no orphan finding is created. A PROPOSED finding is not law; the next agent reuses it only as a proposal. For a full argued finding use ledger_record_finding." + RECEIPT_GUIDANCE,
      inputSchema: {
        population: z.string().min(1).describe("Who is in the denominator, e.g. 'Android IN users shown subscription_paywall'"),
        metric: z.string().min(1).describe("The metric measured; use the ledger definition's metric name when one exists"),
        window: WindowInputSchema.describe("{from, to} ISO dates, or free text containing them ('2026-08-01..2026-08-31'); text without two dates is kept but data_window stays unset until a person supplies it at accept"),
        result: z.string().min(1).describe("The headline number(s) with units, exactly as the query returned them"),
        query_ref: z.string().regex(/^q:.+/, 'pass the evidence id exactly as printed: "q:<tool_use_id>"').describe("Capture evidence id of the data-tool call this result was read from"),
        investigation_record_id: z.string().optional().describe("Work record (investigation) id; defaults to the one this session is bound to"),
        title: z.string().min(3).max(140).optional().describe("Defaults to '<metric> · <population> · <window>: <result>'"),
        caveats: z.array(z.string()).optional(),
        analysis_scope: AnalysisScopeSchema.partial().optional().describe("Explicit analytical scope; incomplete scope remains visibly proposed"),
        definition_ids: z.array(z.string()).optional().describe("Exact definition IDs to resolve in the supplied scope and reporting window"),
        session_id: z.string().optional().describe('Your harness session id (SessionStart prints it as "Ledger session: <id>"); read from CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID when a local transcript matches'),
      },
    },
    async ({ population, metric, window, result, query_ref, investigation_record_id, title, caveats, session_id, analysis_scope, definition_ids }) => {
      let sid: string;
      try { sid = sessionOf(session_id); } catch (e: any) { return refused(`ledger_propose_finding refused: ${e.message} A proposal covers the query it was read from, so it needs the session that ran it.`); }
      const pool = poolIfAny();
      let recordId = investigation_record_id;
      if (!recordId && pool) {
        try { recordId = boundRecordId(await (await investigationsModule()).sessionBinding(pool, sid)); }
        catch (e: any) { return refused(`ledger_propose_finding refused: could not read this session's investigation binding (${e.message}). Pass investigation_record_id explicitly, or bind first.`); }
      }
      if (!recordId) return refused(`ledger_propose_finding refused: session ${sid} is not bound to an investigation and no investigation_record_id was given. Bind or declare new first: ledger_investigations lists open investigations; ledger_investigation_bind({ record_id }) continues one; ledger_investigation_new({ question }) declares one. An unbound proposal would be an orphan finding, which is never created.`);
      const coverage: CaptureCoverage[] = [{ session_id: sid, evidence_ids: [query_ref] }];
      try { await validateRecordCoverage(cfg, { capture_coverage: coverage }); }
      catch (e: any) { return refused(`ledger_propose_finding refused: ${e.message}`); }
      let source: string | undefined;
      try { source = loadJournal(sid).entries.find((e) => e.kind === "query" && e.evidence_id === query_ref)?.tool; } catch { /* remote session: the source stays unrecorded */ }
      let res;
      try { res = proposeFinding(cfg, { population, metric, window, result, query_ref, investigation_record_id: recordId, title, caveats, source, analysis_scope, definition_ids }, { session: sid }); }
      catch (e: any) { return refused(`ledger_propose_finding failed: ${e.message}`); }
      const ack: CaptureAck = { schema: "ledger-capture/v1", action: "record", status: "pending_review", coverage, record_id: res.id };
      let captureWarning = "";
      let captureAck: CaptureAck | undefined;
      try {
        const applied = acknowledgeLocalCapture(ack); captureAck = ack;
        if (applied.remote_pending) captureWarning = `\n${applied.remote_pending} remote evidence acknowledgment(s) saved in this draft; the source machine reconciles on its next brief.`;
      } catch (error) { captureWarning = `\nProposal saved, but local capture acknowledgment failed: ${String(error)}. Do not duplicate it; the query remains outstanding until reviewed.`; }
      let refsNote = "";
      if (pool) { try { refsNote = await linkToInvestigation(pool, recordId, { id: res.id, ...(res.content_version ? { version: res.content_version } : {}) }); } catch (e: any) { refsNote = ` Investigation ledger_refs not updated: ${e.message}.`; } }
      let objects: LedgerObject[] | null = null;
      try { objects = loadAll(cfg, TYPES, false); } catch { /* receipt reports unavailable details */ }
      const receipt = savedReceipt("finding", { ...res.fields, status: "draft" }, res, objects, cfg.git_sync);
      const details =
        `Proposed finding ${res.id} (draft, stance PROPOSED, pending review) in investigation ${recordId}, covering ${query_ref}${res.git ? ` — ${res.git}` : ""}.` +
        (res.content_version ? `\ncontent_version: ${res.content_version}` : "") +
        `\nNot accepted: a person accepts with ledger_review_finding({ id: "${res.id}", action: "accept" }) or discards with a reason.` +
        (res.fields.data_window ? "" : `\nwindow ${JSON.stringify(window)} did not map to data_window {from, to}; accept will need window: {from, to}.`) +
        refsNote + captureWarning;
      return { content: [receiptText(receipt, details)], structuredContent: { receipt, ...(res.content_version ? { content_version: res.content_version } : {}), investigation_record_id: recordId, stance: "PROPOSED", ...(captureAck ? { capture_ack: captureAck } : {}) } };
    }
  );

  server.registerTool(
    "ledger_review_finding",
    {
      title: "Accept or discard a proposed finding (a person's act)",
      description:
        "A person's review of a query-grain finding proposed with ledger_propose_finding (stance PROPOSED). accept writes a NEW stable finding under the configured Ledger author with stance accepted, supersedes the draft, and an acceptance pinned to the draft's content_version (role review) plus the retained query artifact when it can be located (role query); the result reads 'Accepted by <person>'. discard requires a reason and keeps the draft as a discarded cut: deprecated, stance discarded, reason kept, listed by ledger_search(include_superseded) as 'discarded cut'. Acceptance is never automatic: call accept only when the person you work for has reviewed the number, or when they asked you to. Refuses anything that is not a PROPOSED draft." + RECEIPT_GUIDANCE,
      inputSchema: {
        id: z.string().describe("The proposed finding id (fnd-…)"),
        action: z.enum(["accept", "discard"]),
        reason: z.string().optional().describe("discard: required; why the cut is not durable knowledge (kept in history)"),
        window: z.object({ from: AnalyticalDateSchema, to: AnalyticalDateSchema }).optional().describe("accept: supply when the proposal's free-text window did not map to data_window"),
      },
    },
    async ({ id, action, reason, window }) => {
      const draft = getById(cfg, id);
      if (!draft) return refused(`Not found: ${id}`);
      const pool = poolIfAny();
      let queryEvidence: { artifact_id: string; sha256: string } | undefined;
      let queryNote = "";
      const queryRef = typeof draft.fields.query_ref === "string" ? draft.fields.query_ref : undefined;
      if (action === "accept" && queryRef) {
        if (pool) {
          try { queryEvidence = (await locateQueryArtifact(pool, queryRef)) ?? undefined; } catch (e: any) { queryNote = ` Query artifact lookup failed (${e.message}).`; }
          queryNote += queryEvidence ? ` Acceptance also pins the retained query artifact ${queryEvidence.artifact_id} (role query).` : ` The retained query artifact for ${queryRef} was not located; acceptance pins the reviewed draft's content_version only.`;
        } else queryNote = ` No continuity database: acceptance pins the reviewed draft's content_version only.`;
      }
      let r;
      try { r = reviewFinding(cfg, id, action, { actor: cfg.author, reason, window, queryEvidence }); }
      catch (e: any) { return refused(`ledger_review_finding refused: ${e.message}`); }
      const coverage = coverageOf(draft.fields);
      if (action === "discard") {
        let ack: CaptureAck | undefined;
        if (coverage.length) {
          const a: CaptureAck = { schema: "ledger-capture/v1", action: "skip", status: "dismissed", reason: `discarded cut: ${r.reason}`, coverage };
          try { acknowledgeLocalCapture(a); ack = a; } catch { /* the covering session is not on this machine */ }
        }
        return { ...text(`Discarded cut kept: ${r.reason}\n${id} is now deprecated with stance discarded, by ${r.by}${r.git ? ` — ${r.git}` : ""}. It leaves the review queue and stays in history; ledger_search(include_superseded: true) labels it "discarded cut".`),
          structuredContent: { review: { action, draft_id: id, by: r.by, stance: "discarded", reason: r.reason }, ...(ack ? { capture_ack: ack } : {}) } };
      }
      let captureAck: CaptureAck | undefined;
      let captureWarning = "";
      if (coverage.length) {
        const a: CaptureAck = { schema: "ledger-capture/v1", action: "record", status: "recorded", coverage, record_id: r.id! };
        try { acknowledgeLocalCapture(a); captureAck = a; } catch (error) { captureWarning = `\nAccepted, but local capture acknowledgment failed: ${String(error)}.`; }
      }
      let refsNote = "";
      const rid = typeof draft.fields.investigation_record_id === "string" ? draft.fields.investigation_record_id : undefined;
      if (pool && rid) { try { refsNote = await linkToInvestigation(pool, rid, { id: r.id!, ...(r.content_version ? { version: r.content_version } : {}) }); } catch (e: any) { refsNote = ` Investigation ledger_refs not updated: ${e.message}.`; } }
      let objects: LedgerObject[] | null = null;
      try { objects = loadAll(cfg, TYPES, false); } catch { /* receipt reports unavailable details */ }
      const receipt = savedReceipt("finding", { title: draft.title, status: "stable" }, { id: r.id!, path: r.path!, git: r.git, superseded: id }, objects, cfg.git_sync);
      const roles = r.acceptance?.evidence_refs.map((e) => `${e.role}:${e.artifact_id}`).join(", ") ?? "";
      const details =
        `Accepted by ${r.by} — a person's review under the configured Ledger author, not the agent's. ${r.id} (stable, stance accepted) supersedes ${id}${r.git ? ` — ${r.git}` : ""}.` +
        (r.content_version ? `\ncontent_version: ${r.content_version} — pin dependencies to this value.` : "") +
        `\nacceptance: actor ${r.acceptance?.actor}, expected_predecessor ${id} @ ${r.acceptance?.expected_predecessor?.version}, evidence_refs [${roles}].` +
        queryNote + refsNote + captureWarning;
      return { content: [receiptText(receipt, details)], structuredContent: { receipt, ...(r.content_version ? { content_version: r.content_version } : {}), review: { action, draft_id: id, id: r.id, by: r.by, stance: "accepted", acceptance: r.acceptance }, ...(captureAck ? { capture_ack: captureAck } : {}) } };
    }
  );

  server.registerTool(
    "ledger_stats",
    {
      title: "Ledger stats",
      description: "Pilot health: object counts by author, findings missing definitions, cross-author duplicate findings.",
      inputSchema: { days: z.number().int().min(1).max(365).default(14) },
      annotations: readOnly,
    },
    async ({ days }) => text(stats(cfg, days))
  );

  // ---------- execution continuity (spec §8) ----------
  if (continuityConfigured(cfg)) {
    const pool = () => getPool(cfg);
    // Scope is decided before any query runs: "repo" whenever cwd is given (or explicitly asked for, from the
    // server's cwd), "all" otherwise. A repo that cannot be resolved is an error, never a silent widening.
    const scopeOf = (cwd: string | undefined, scope: "repo" | "all" | undefined) => resolveSearchScope({ cwd, scope, fallbackCwd: process.cwd() }, { repoRoot, repoIdentity });
    const SCOPE = z.enum(["repo", "all"]).optional().describe('"repo": only the repo cwd is in (default when cwd is given); "all": every repo (default without cwd). The first result line states the scope used.');

    server.registerTool(
      "ledger_threads",
      {
        title: "Open work threads",
        description: "List teammates' (and optionally your own) open work threads: goal, last activity, harness, claim holder, verified snapshot age. Use before continuing anyone's work. Pass cwd to see threads on the repo you are in (scope repo); scope \"all\" widens explicitly. The first line states the scope used.",
        inputSchema: {
          cwd: z.string().optional().describe("A path inside the repo to filter by; without it and without scope, all repos"),
          scope: SCOPE,
          author: z.string().optional(),
          session_id: z.string().optional().describe("Only the thread this session is bound to (shortened id accepted)"),
          include_own: z.boolean().default(false),
          hours: z.number().int().min(1).max(720).default(72),
          limit: z.number().int().min(1).max(50).default(10),
        },
        annotations: readOnly,
      },
      async ({ cwd, scope, author, session_id, include_own, hours, limit }) => {
        try {
          const sc = scopeOf(cwd, scope);
          if (sc.error) return text(`ledger_threads refused: ${sc.error}`);
          const head = scopeLine(sc, { author: author ?? (include_own ? "any" : `any except ${cfg.author}`), extra: [`status open`, `last ${hours}h`] });
          let rows = await listThreads(pool(), { repo: sc.repo ?? undefined, author, excludeAuthor: include_own || author ? undefined : cfg.author, sinceHours: hours, status: "open", limit });
          if (session_id) {
            const sess = await getSession(pool(), (await resolveSessionId(pool(), session_id)).id);
            rows = rows.filter((r) => sess?.thread_id && r.id === sess.thread_id);
          }
          return text([head, ...(rows.length ? rows.map((r) => threadLine(r)) : ["No open threads match."])].join("\n"));
        } catch (e: any) {
          return text(`ledger_threads failed: ${e.message}`);
        }
      }
    );

    server.registerTool(
      "ledger_thread_get",
      { title: "Thread detail", description: "Full detail for one thread: every human instruction, files touched, pending operations, checkpoint, claim state. Read-only; does not claim.", inputSchema: { thread_id: z.string() }, annotations: readOnly },
      async ({ thread_id }) => text((await buildResumePack(cfg, pool(), thread_id, { mode: "inspect", author: cfg.author, budgetTokens: 12000 })).text)
    );

    server.registerTool("ledger_handoff_update", {
      title: "Report evidenced handoff progress",
      description: "Update the handoff attempt returned by ledger_resume. Verification and completion require exact captured destination-session events. Completion requires verification, validation, and a delivered assistant result; source pending operations must be reconciled. Agent-reported evidence is not independent or human verification. Failed and abandoned attempts remain visible.",
      inputSchema: {
        id: z.string().uuid(), session_id: z.string().optional(),
        status: z.enum(["verified", "completed", "failed", "abandoned"]),
        evidence: z.array(z.object({session_id:z.string(),seq:z.number().int().positive(),role:z.enum(["verification","validation","delivered_result","pending_operation_resolution"])})).max(50).default([]),
        note: z.string().max(2000).optional(),
      },
    }, async ({id,session_id,status,evidence,note}) => {
      try {
        const result = await updateHandoff(pool(), {id,session_id:sessionOf(session_id),author:cfg.author,status,evidence,note});
        return {...text(`Handoff ${id}: ${result.status}. Agent-reported, supported by retained events; not independent verification.`),structuredContent:{handoff:result}};
      } catch (e:any) {return refused(`ledger_handoff_update refused: ${e.message}`);}
    });

    server.registerTool(
      "ledger_resume",
      {
        title: "Resume a thread or a work record",
        description: "Continue a teammate's work. Pass thread_id for a thread (one session's worktree and claim) or record_id for a work record (one goal accumulated across sessions and teammates: state with proposed items flagged, evidence from every contributing session in time order, pending operations, contradictions, decisions in force, unassigned spans that may belong, and the bootstrap for the latest snapshot). Both packs list the Ledger decisions the work saved or linked, marked in force, SUPERSEDED, DRAFT or CONFLICT, and label each record decision with how it was accepted. detail=lean (default) returns the state projection, decisions in force, pending operations, files and bootstrap with the evidence tail omitted and each omission named with the ledger_events / ledger_evidence_search call that fetches it; detail=evidence adds the evidence lines themselves. as_of renders the pack as of that instant (updates confirmed later show as PROPOSED). mode=continue claims the thread (advisory; for a record, the thread of its most recent contributing session; a non-code record has no claim) and returns the pack with worktree bootstrap commands; mode=fork (threads only) creates a linked fork you own; mode=inspect reads without claiming. Pass cwd (a checkout of the same repo) to get the diff of what changed since the checkpoint. Your first turn must inspect the worktree, state confirmed vs uncertain progress, act only on decisions in force (never on a superseded, draft, proposed or agent-confirmed one as if a person decided it), and never blindly rerun a pending operation.",
        inputSchema: {
          thread_id: z.string().optional().describe("Thread to resume; thread_id or record_id is required"),
          record_id: z.string().optional().describe("Work record to resume instead of a thread (from ledger_records or the brief's Open work section)"),
          mode: z.enum(["continue", "fork", "inspect"]).default("continue"),
          cwd: z.string().optional().describe("Local checkout of the same repo, for the intervening-change diff"),
          session_id: z.string().optional().describe('Your harness session id; SessionStart prints it as "Ledger session: <id>". Required for continue and fork unless this server can read it from CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID with a matching local transcript. Without it nothing is claimed or bound.'),
          budget_tokens: z.number().int().min(1500).max(20000).default(6000),
          detail: z.enum(["lean", "evidence"]).optional().describe("lean (default): state, decisions, pending operations, files, bootstrap; evidence omitted and named. evidence: include the evidence lines"),
          as_of: z.string().optional().describe("ISO instant; the pack is rendered as of then (later confirmations show as PROPOSED)"),
        },
      },
      async ({ thread_id, record_id, mode, cwd, session_id, budget_tokens, detail, as_of }) => {
        // pack options owned by the pack builders; spread so the call compiles whether or not they accept them yet
        const packOpts = { detail, asOf: as_of, viewer: cfg.author };
        // argument errors first: they hold whatever the session
        if (!record_id && !thread_id) return text("thread_id or record_id is required.");
        if (record_id && mode === "fork") return text("mode=fork applies to threads; use mode=continue or mode=inspect with record_id (fork the underlying thread with thread_id if you need parallel work).");
        // inspect never claims, so it needs no session; continue and fork refuse rather than claim under a made-up id
        let sid: string | undefined;
        if (mode !== "inspect") {
          try { sid = sessionOf(session_id); } catch (e: any) { return refused(`ledger_resume refused: ${e.message}`); }
        }
        if (record_id && mode !== "fork") {
          try {
            const pack = await buildRecordPack(cfg, pool(), record_id, { mode, author: cfg.author, sessionId: sid, repoPath: cwd, budgetTokens: budget_tokens, ...packOpts });
            if (sid && mode === "continue" && pack.claim.acquired && pack.claim.thread_id) writeBinding(sid, { thread_id: pack.claim.thread_id });
            return handoffResult(pack, "record", record_id, sid, mode);
          } catch (e: any) {
            return refused(`ledger_resume failed: ${e.message}`);
          }
        }
        if (!thread_id) return text("thread_id or record_id is required.");
        const pack = await buildResumePack(cfg, pool(), thread_id, { mode, author: cfg.author, sessionId: sid, repoPath: cwd, budgetTokens: budget_tokens, ...packOpts });
        if (sid && mode !== "inspect" && pack.claim.acquired) writeBinding(sid, { thread_id: pack.fork?.id ?? thread_id });
        return handoffResult(pack, "thread", thread_id, sid, mode);
      }
    );

    server.registerTool(
      "ledger_thread_start",
      { title: "Start a new thread", description: "Bind this session to a new thread you own, with an explicit title and goal. Otherwise the helper auto-creates one from your first prompt.", inputSchema: { title: z.string().min(3).max(140), goal: z.string().optional(), cwd: z.string().describe("A path inside the repo"), session_id: z.string().optional() } },
      async ({ title, goal, cwd, session_id }) => {
        const root = repoRoot(cwd);
        if (!root) return text("cwd must be inside a git repo so the thread has a repo identity.");
        const forbidden = forbiddenSnapshotRoot(root);
        if (forbidden) return text(`ledger_thread_start refused: ${forbidden}. Start threads from a project checkout; the helper never snapshots a home directory.`);
        // resolve the session before creating anything, so a refusal leaves no orphan thread
        let sid: string;
        try { sid = sessionOf(session_id); } catch (e: any) { return text(`ledger_thread_start refused: ${e.message}`); }
        const t = await createThread(pool(), { repo: repoIdentity(root), branch: currentBranch(root), title, goal: goal ?? null, created_by: cfg.author });
        const c = await claimThread(pool(), t.id, sid, cfg.author);
        writeBinding(sid, { thread_id: t.id });
        return text(`Thread ${t.id} "${t.title}" created on ${t.repo}${t.branch ? `@${t.branch}` : ""}; ${c.ok ? `claimed, generation ${c.generation}` : "claim failed"}. The helper will attach this session's events and snapshots.`);
      }
    );

    server.registerTool(
      "ledger_thread_bind",
      { title: "Bind session to a thread", description: "Attach this session to an existing thread as a contributor without claiming it. To take ownership use ledger_resume mode=continue.", inputSchema: { thread_id: z.string(), session_id: z.string().optional() } },
      async ({ thread_id, session_id }) => {
        const t = await getThread(pool(), thread_id);
        if (!t) return text(`Not found: ${thread_id}`);
        writeBinding(sessionOf(session_id), { thread_id });
        return text(`Session bound to ${t.id} "${t.title}" as a contributor (no claim).`);
      }
    );

    server.registerTool(
      "ledger_thread_note",
      { title: "Add a note to a thread", description: "Append a note to a thread's event stream: a constraint learned, a next step, a mid-task choice. Shows in the resume pack. Not a Ledger decision or finding; record those with ledger_record_*.", inputSchema: { thread_id: z.string(), text: z.string().min(3).max(4000), session_id: z.string().optional() } },
      async ({ thread_id, text: note, session_id }) => {
        const sid = sessionOf(session_id);
        await upsertSession(pool(), { id: sid, author: cfg.author, harness: process.env.CODEX_THREAD_ID ? "codex" : "claude", machine: cfg.continuity?.machine ?? null });
        const r = await appendEvents(pool(), sid, [{ producer_event_id: `note:${Date.now()}`, kind: "instruction.added", occurred_at: new Date().toISOString(), payload: { text: `[note by ${cfg.author}] ${note}` } }], thread_id, null);
        return text(r.inserted ? `Note added to ${thread_id}.` : `Note already present.`);
      }
    );

    server.registerTool(
      "ledger_release",
      { title: "Release a thread claim", description: "Release your claim when you stop working on a thread, so a teammate can continue without waiting for lease expiry. The helper publishes a final checkpoint.", inputSchema: { thread_id: z.string(), session_id: z.string().optional() } },
      async ({ thread_id, session_id }) => {
        const sid = sessionOf(session_id);
        const ok = await releaseClaim(pool(), thread_id, sid);
        writeSignal(sid, "checkpoint");
        return text(ok ? `Released ${thread_id}.` : `No live claim on ${thread_id} held by this session.`);
      }
    );

    // ---------- evidence queries: the raw event stream and stored artifacts ----------
    server.registerTool(
      "ledger_events",
      {
        title: "Query thread or session events",
        description: "Evidence query over a thread's or session's captured events: human instructions, assistant messages, tool calls and results, file changes, compaction summaries, capture gaps. One compact line per event (seq · HH:MM · kind · preview), ordered by seq; filter by kinds, a path substring, a case-insensitive text substring, or a seq range. Use it to fetch what a resume pack omitted for budget, to read a compaction summary in full (raise preview_chars), or to see exactly what a teammate's agent did around a file. Substring match only; not full-text search.",
        inputSchema: {
          thread_id: z.string().optional().describe("Thread to query; thread_id or session_id is required"),
          session_id: z.string().optional().describe("Session to query; seq is per session, so pass this for an exact cursor on multi-session threads. The shortened id shown in briefs, resume packs and evidence-search lines works: any unambiguous prefix resolves. An unknown or ambiguous id is an error, never an empty result."),
          kinds: z.array(z.string()).optional().describe('e.g. ["instruction.added"], ["tool.requested","tool.finished"], ["file.changed"], ["compaction"], ["assistant.message"]'),
          path: z.string().optional().describe("Substring of payload.path (file.changed) or payload.input (tool events)"),
          q: z.string().optional().describe("Case-insensitive substring over payload text / input / output_preview"),
          after_seq: z.number().int().min(0).optional().describe("Only events with seq greater than this; use the trailer's next value to page"),
          before_seq: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(EVENTS_MAX_LIMIT).default(EVENTS_DEFAULT_LIMIT),
          preview_chars: z.number().int().min(20).max(PREVIEW_MAX_CHARS).default(PREVIEW_CHARS).describe("Per-line preview length; raise it with limit 1 to read one event in full"),
        },
        annotations: readOnly,
      },
      async (f) => {
        if (!f.thread_id && !f.session_id) return text("thread_id or session_id is required.");
        try {
          return text((await queryEvents(pool(), f)).text);
        } catch (e: any) {
          return text(`ledger_events failed: ${e.message}`);
        }
      }
    );

    server.registerTool(
      "ledger_artifact_get",
      {
        title: "Read a stored artifact",
        description: "Read a slice of a stored artifact (a tool output longer than the event preview) by id or sha256. Event lines show `[artifact <id>]` when one exists. Returns a header (id, kind, byte size, the [offset, offset+n) window shown), the utf8 text slice, and the next offset when more remains.",
        inputSchema: {
          id: z.string().optional().describe("Artifact id (uuid) from an event line; id or sha256 is required"),
          sha256: z.string().optional().describe("Artifact content hash, as stored on the event payload (artifact_sha256)"),
          offset: z.number().int().min(0).default(0).describe("Character offset into the decoded text"),
          max_chars: z.number().int().min(1).max(ARTIFACT_MAX_CHARS).default(ARTIFACT_DEFAULT_CHARS),
        },
        annotations: readOnly,
      },
      async ({ id, sha256, offset, max_chars }) => {
        if (!id && !sha256) return text("id or sha256 is required.");
        try {
          return text((await getArtifact(pool(), { id, sha256 }, { offset, max_chars })).text);
        } catch (e: any) {
          return text(`ledger_artifact_get failed: ${e.message}`);
        }
      }
    );

    // ---------- work records (spec §13a): retrieval by record across sessions and teammates ----------
    const RECORD_KINDS = ["implementation", "investigation", "writing", "decision", "other"] as const;
    const RECORD_STATUSES = ["open", "done", "archived"] as const;
    const UPDATE_KINDS = ["progress", "decision", "hypothesis", "blocker", "next", "contradiction", "note"] as const;
    const failed = (tool: string, e: any) => text(`${tool} failed: ${e?.message ?? String(e)}`);

    // ---------- investigations (dec-20260917 bind-or-new): bind this session to one, or declare a new one ----------
    server.registerTool(
      "ledger_investigations",
      {
        title: "Open investigations",
        description: "List open investigations (work records of kind investigation) before starting analytical work: title, question, author, last activity, proposed/accepted findings, id. Continue one with ledger_investigation_bind({ record_id }); if nothing matches, declare one with ledger_investigation_new. Every ledger_propose_finding must land inside a bound investigation.",
        inputSchema: {
          q: z.string().optional().describe("Case-insensitive substring over title, goal and question"),
          author: z.string().optional(),
          hours: z.number().int().min(1).max(24 * 365).optional(),
          limit: z.number().int().min(1).max(50).optional(),
        },
        annotations: readOnly,
      },
      async ({ q, author, hours, limit }) => {
        try {
          const r = await (await investigationsModule()).listInvestigations(pool(), cfg, { q, author, hours, limit });
          return { ...text(r.text), structuredContent: { items: r.items } };
        } catch (e: any) { return failed("ledger_investigations", e); }
      }
    );

    server.registerTool(
      "ledger_investigation_bind",
      {
        title: "Bind this session to an investigation",
        description: "Continue an existing investigation: binds the caller session to the work record so ledger_propose_finding lands its query-grain findings there. Returns structuredContent.record_id on success. Say what question this session is pursuing if it differs from the record's.",
        inputSchema: {
          record_id: z.string().describe("Investigation (work record) id from ledger_investigations"),
          question: z.string().max(2000).optional().describe("The question this session pursues inside the investigation"),
          request_id: z.string().min(8).max(200).optional().describe("Stable operation key reused after a timeout; do not change it when retrying"),
          session_id: z.string().optional().describe('Your harness session id (SessionStart prints it as "Ledger session: <id>")'),
        },
      },
      async ({ record_id, question, session_id, request_id }) => {
        let sid: string;
        try { sid = sessionOf(session_id); } catch (e: any) { return refused(`ledger_investigation_bind refused: ${e.message}`); }
        try {
          const r = await (await investigationsModule()).bindInvestigation(pool(), cfg, { record_id, session_id: sid, question, request_id, identity: resolveHarnessIdentity(sid).identity });
          return { ...text(r.text), structuredContent: { record_id: r.record_id, title: r.title, already_bound: r.already_bound, session_id: sid } };
        } catch (e: any) { return { ...failed("ledger_investigation_bind", e), isError: true }; }
      }
    );

    server.registerTool(
      "ledger_investigation_new",
      {
        title: "Declare a new investigation",
        description: "No open investigation matches: declare one (a work record of kind investigation) with the question it pursues and bind the caller session to it. Returns structuredContent.record_id. Check ledger_investigations first so two people do not open the same investigation twice.",
        inputSchema: {
          question: z.string().min(3).max(2000).describe("The question this investigation answers, stated so it could later be false"),
          goal: z.string().max(2000).optional(),
          repo: z.string().optional().describe("Optional: a path inside a repo this investigation may read. Recorded as a touched repo (a capability), never as the record's identity; an investigation is keyed by its question and is complete with no repo at all"),
          request_id: z.string().min(8).max(200).optional().describe("Stable operation key reused after a timeout; do not change it when retrying"),
          session_id: z.string().optional().describe('Your harness session id (SessionStart prints it as "Ledger session: <id>")'),
        },
      },
      async ({ question, goal, repo, session_id, request_id }) => {
        let sid: string;
        try { sid = sessionOf(session_id); } catch (e: any) { return refused(`ledger_investigation_new refused: ${e.message}`); }
        try {
          const repoRootOf = repo ? repoRoot(repo) : null;
          const r = await (await investigationsModule()).declareInvestigation(pool(), cfg, { question, goal, session_id: sid, repo: repoRootOf ? repoIdentity(repoRootOf) : repo, request_id, identity: resolveHarnessIdentity(sid).identity });
          return { ...text(r.text), structuredContent: { record_id: r.record_id, session_id: sid } };
        } catch (e: any) { return { ...failed("ledger_investigation_new", e), isError: true }; }
      }
    );

    server.registerTool(
      "ledger_records",
      {
        title: "Open work records",
        description: "List work records: the logical units of work that accumulate across sessions and teammates (a thread is one session's worktree; a record is one goal). One line each: kind · title · repo or non-code · updated · contributing sessions · proposed/confirmed updates · id. Records are cross-author by nature, so nobody is excluded. Pass cwd to see records on the repo you are in (scope repo); scope \"all\" widens explicitly to every repo and non-code records. q for a title/goal substring; session_id for the records one session contributed to; as_of for counts and state_version as of an instant. The first line states the scope used. Continue one with ledger_resume(record_id) or read it with ledger_record_get.",
        inputSchema: {
          cwd: z.string().optional().describe("A path inside the repo to filter by; without it and without scope, all repos and non-code records"),
          scope: SCOPE,
          kind: z.enum(RECORD_KINDS).optional(),
          status: z.enum(RECORD_STATUSES).default("open"),
          author: z.string().optional().describe("Filter by the record's creator"),
          session_id: z.string().optional().describe("Only records this session contributed a span to (shortened id accepted)"),
          q: z.string().optional().describe("Case-insensitive substring over title and goal"),
          as_of: z.string().optional().describe("ISO instant: records created later are hidden; proposed/confirmed counts and state_version are evaluated as of then"),
          hours: z.number().int().min(1).max(24 * 365).default(336).describe("Only records updated within this many hours (default 14 days; measured from now, not as_of)"),
          limit: z.number().int().min(1).max(50).default(15),
        },
        annotations: readOnly,
      },
      async ({ cwd, scope, kind, status, author, session_id, q, as_of, hours, limit }) => {
        try {
          const sc = scopeOf(cwd, scope);
          if (sc.error) return text(`ledger_records refused: ${sc.error}`);
          const head = scopeLine(sc, { author, asOf: as_of, extra: [`status ${status}`, `last ${hours}h`] });
          let rows: Array<Parameters<typeof recordLine>[0]> = await listRecordSummaries(pool(), { repo: sc.repo ?? undefined, kind, status, author, q, sinceHours: hours, limit });
          if (session_id) {
            const ids = new Set((await recordsForSession(pool(), (await resolveSessionId(pool(), session_id)).id)).map((r) => r.id));
            rows = rows.filter((r) => ids.has(r.id));
          }
          if (as_of) rows = await asOfRecordSummaries(pool(), rows, as_of);
          return text([head, ...(rows.length ? rows.map((r) => recordLine(r)) : ["No records match."])].join("\n"));
        } catch (e: any) {
          return failed("ledger_records", e);
        }
      }
    );

    server.registerTool(
      "ledger_record_get",
      {
        title: "Work record detail",
        description: "The record pack without claiming anything. detail=lean (default): the state projection with [PROPOSED] items flagged and contradictions side by side, decisions in force, contributing sessions and authors, files touched, pending operations from the most recent contributing session, linked Ledger objects with supersession flags, unassigned spans that may belong, and the bootstrap when the record has a repo; the evidence lines are omitted and each omission is named with the ledger_events(session_id, after_seq, …) or ledger_evidence_search(record_id, …) call that fetches it. detail=evidence adds the evidence across every contributing session in time order and the latest compaction summary. as_of renders the pack as of that instant: updates confirmed later show as PROPOSED, later events are excluded.",
        inputSchema: {
          record_id: z.string(),
          budget_tokens: z.number().int().min(1500).max(40000).default(12000).describe("Raise to 20000 to see up to 50 state items per kind"),
          cwd: z.string().optional().describe("Local checkout of the same repo, for the bootstrap rebase target"),
          detail: z.enum(["lean", "evidence"]).optional().describe("lean (default): state, decisions, pending operations, files, bootstrap; evidence omitted and named. evidence: include the evidence lines"),
          as_of: z.string().optional().describe("ISO instant; the pack is rendered as of then"),
        },
        annotations: readOnly,
      },
      async ({ record_id, budget_tokens, cwd, detail, as_of }) => {
        try {
          const packOpts = { detail, asOf: as_of, viewer: cfg.author };
          return text((await buildRecordPack(cfg, pool(), record_id, { mode: "inspect", author: cfg.author, repoPath: cwd, budgetTokens: budget_tokens, ...packOpts })).text);
        } catch (e: any) {
          return failed("ledger_record_get", e);
        }
      }
    );

    server.registerTool(
      "ledger_record_link",
      {
        title: "Link a span of a session to a record",
        description: "Say that events from_seq..to_seq (inclusive) of a session contribute to a work record. The link is explicit (you named the record) and outranks any classifier suggestion over the same events. Use it for your own session's spans as you work, and for unassigned spans the brief or a record pack surfaced. Seqs are per session; see them with ledger_events(session_id), which accepts the shortened id shown in briefs and record packs.",
        inputSchema: {
          record_id: z.string(),
          session_id: z.string().describe("The session whose events contribute; seq numbers are per session"),
          from_seq: z.number().int().min(0),
          to_seq: z.number().int().min(0),
          note: z.string().max(500).optional().describe("Why this span belongs here"),
          ledger_refs: z.array(z.string().min(3)).max(20).optional().describe("Ledger decision, definition or finding ids this work depends on; resume packs show whether each is still in force"),
        },
      },
      async ({ record_id, session_id, from_seq, to_seq, note, ledger_refs }) => {
        try {
          const rec = await getRecord(pool(), record_id);
          if (!rec) return text(`Not found: record ${record_id}`);
          const l = await linkSpan(pool(), { record_id, session_id, from_seq, to_seq, source: "explicit", note: note ?? null, created_by: cfg.author });
          let refsNote = "";
          if (ledger_refs?.length) {
            const merged = [...(rec.ledger_refs ?? [])];
            for (const id of ledger_refs) if (!merged.some((r) => r.id === id)) merged.push({ id });
            await updateRecordMeta(pool(), rec.id, { ledger_refs: merged });
            refsNote = ` Ledger refs now: ${merged.map((r) => r.id).join(", ")}.`;
          }
          return text(`Linked session ${session_id} seq ${from_seq}..${to_seq} to record "${rec.title}" (${rec.id}); link ${l.id}, explicit, by ${cfg.author}.${refsNote}`);
        } catch (e: any) {
          return failed("ledger_record_link", e);
        }
      }
    );

    server.registerTool(
      "ledger_record_update",
      {
        title: "Propose, confirm, or reject a record state update",
        description: "Append to a work record's state. action=propose adds a proposed update (kind: progress | decision | hypothesis | blocker | next | contradiction | note) with the exact events it rests on; it is never confirmed on propose and does not change state_version. action=confirm records an agent confirmation on the author's behalf and bumps state_version; successors see it as agent-confirmed, not reviewed by a person. A person accepts with `ledger record confirm <update_id>` in a terminal. action=reject declines one with a reason (kept in history). To replace an earlier update, propose a new one with supersedes; nothing is edited. A confirmed record state is still not a Ledger decision or finding; promote with ledger_record_decision / ledger_record_finding.",
        inputSchema: {
          record_id: z.string(),
          action: z.enum(["propose", "confirm", "reject"]),
          kind: z.enum(UPDATE_KINDS).optional().describe("propose: the update kind"),
          text: z.string().max(4000).optional().describe("propose: the update, one or two sentences, stated so it could later be false"),
          evidence: z.array(z.object({ session_id: z.string(), seq: z.number().int().min(0) })).optional().describe("propose: at least one exact event this update rests on"),
          supersedes: z.string().optional().describe("propose: id of an earlier update this one replaces"),
          update_id: z.string().optional().describe("confirm / reject: the update id"),
          reason: z.string().max(1000).optional().describe("reject: why (required)"),
          session_id: z.string().optional().describe('Your harness session id (SessionStart prints it as "Ledger session: <id>"); recorded as the session that proposed or confirmed the update'),
        },
      },
      async ({ record_id, action, kind, text: body, evidence, supersedes, update_id, reason, session_id }) => {
        try {
          const rec = await getRecord(pool(), record_id);
          if (!rec) return text(`Not found: record ${record_id}`);
          // provenance is best effort: an unknown session never blocks a proposal or confirmation, it is just not recorded
          let caller: string | null = null;
          try { caller = sessionOf(session_id); } catch { caller = null; }
          if (action === "propose") {
            if (!kind) return text("propose needs kind (progress | decision | hypothesis | blocker | next | contradiction | note).");
            if (!body?.trim()) return text("propose needs text.");
            if (!evidence?.length) return text("propose needs evidence: at least one { session_id, seq } the update rests on. A state update without evidence is a guess; find the event with ledger_events or ledger_evidence_search first.");
            const u = await addStateUpdate(pool(), { record_id, kind, text: body, evidence, created_by: cfg.author, supersedes: supersedes ?? null, proposed_session_id: caller });
            return text(`Proposed ${u.kind} update ${u.id} on record "${rec.title}" (status proposed; state_version unchanged at ${rec.state_version}${u.supersedes ? `; supersedes ${u.supersedes}` : ""}). It renders as [PROPOSED] until confirmed. A person accepts it with \`ledger record confirm ${u.id}\` in a terminal; an agent confirmation (ledger_record_update action "confirm") renders as agent-confirmed, not reviewed by a person.`);
          }
          if (!update_id) return text(`${action} needs update_id.`);
          if (action === "confirm") {
            const u = await confirmStateUpdate(pool(), update_id, cfg.author, { via: "mcp", session_id: caller });
            if (!u) return text(`Not found: update ${update_id}`);
            const after = await getRecord(pool(), record_id);
            const label = acceptanceLabel(u);
            return text(`Confirmed ${u.kind} update ${u.id} on record "${rec.title}": successors see [${label}] (state_version now ${after?.state_version ?? "?"}).${u.confirmed_via === "cli-interactive" ? "" : ` A person accepts it with \`ledger record confirm ${u.id}\` in a terminal.`}`);
          }
          if (!reason?.trim()) return text("reject needs reason: say why the update is wrong or not durable; it is kept in history.");
          const u = await rejectStateUpdate(pool(), update_id, cfg.author, reason);
          if (!u) return text(`Not found: update ${update_id}`);
          // a rejected proposal no longer needs the checkpoint's decision prompt in the session it came from
          if (u.session_id) { try { acknowledgeLocalCapture({ schema: "ledger-capture/v1", action: "skip", status: "dismissed", reason: `proposal rejected: ${reason.trim()}`, coverage: [{ session_id: u.session_id, evidence_ids: [`d:${u.id}`] }] }); } catch { /* no local prompt for it */ } }
          return text(`Rejected ${u.kind} update ${u.id} on record "${rec.title}": ${reason.trim()} (state_version unchanged at ${rec.state_version}).`);
        } catch (e: any) {
          return failed("ledger_record_update", e);
        }
      }
    );

    server.registerTool(
      "ledger_record_start",
      {
        title: "Start a work record",
        description: "Create a work record for a goal that will span sessions or teammates: an investigation, an implementation, a piece of writing, a decision in progress. Pass cwd inside a git repo for code work (the record gets that repo identity) or omit it for non-code work (hiring, copy, planning). An investigation is keyed by its question: cwd becomes a touched repo it may read, never its identity (prefer ledger_investigation_new, which also binds this session). Optionally link the span of your current session that already belongs to it.",
        inputSchema: {
          kind: z.enum(RECORD_KINDS),
          title: z.string().min(3).max(200),
          goal: z.string().max(2000).optional(),
          cwd: z.string().optional().describe("A path inside the repo for code work; omit for non-code work"),
          link: z.object({ session_id: z.string(), from_seq: z.number().int().min(0), to_seq: z.number().int().min(0) }).optional().describe("A span of a session to link explicitly at creation"),
          ledger_refs: z.array(z.string().min(3)).max(20).optional().describe("Ledger decision, definition or finding ids this work depends on; resume packs show whether each is still in force"),
        },
      },
      async ({ kind, title, goal, cwd, link, ledger_refs }) => {
        try {
          const root = cwd ? repoRoot(cwd) : null;
          const repo = root ? repoIdentity(root) : null;
          const rec = await createRecord(pool(), { kind, title, goal: goal ?? null, repo, created_by: cfg.author, ledger_refs: [...new Set(ledger_refs ?? [])].map((id) => ({ id })) });
          let linked = "";
          if (link) {
            const l = await linkSpan(pool(), { record_id: rec.id, session_id: link.session_id, from_seq: link.from_seq, to_seq: link.to_seq, source: "explicit", created_by: cfg.author });
            linked = ` Linked session ${link.session_id} seq ${link.from_seq}..${link.to_seq} (link ${l.id}).`;
          }
          const where = rec.repo ? ` on ${rec.repo}` : rec.touched_repos?.length ? ` keyed by its question (repos it may read: ${rec.touched_repos.join(", ")})` : " as non-code work";
          return text(`Record ${rec.id} "${rec.title}" (${rec.kind}) created${where} by ${cfg.author}.${linked} Propose state with ledger_record_update; link further spans with ledger_record_link.`);
        } catch (e: any) {
          return failed("ledger_record_start", e);
        }
      }
    );

    server.registerTool(
      "ledger_unassigned",
      {
        title: "Unassigned spans",
        description: "Spans of captured sessions that no work record claims (no explicit or suggested link): the material the classifier could not place and nobody linked. One line each with preview, seq range, author, harness, and time. Link a span with ledger_record_link or start a record for it with ledger_record_start; never invent what it is about.",
        inputSchema: {
          session_id: z.string().optional(),
          author: z.string().optional(),
          hours: z.number().int().min(1).max(24 * 365).default(48),
          limit: z.number().int().min(1).max(50).default(10),
        },
        annotations: readOnly,
      },
      async ({ session_id, author, hours, limit }) => {
        try {
          const rows = await unassignedSpans(pool(), { session_id, author, sinceHours: hours, limit });
          return text(rows.length ? rows.map((s) => unassignedLine(s)).join("\n") : "No unassigned spans match.");
        } catch (e: any) {
          return failed("ledger_unassigned", e);
        }
      }
    );

    server.registerTool(
      "ledger_evidence_search",
      {
        title: "Full-text search over captured events",
        description: "Search captured evidence: human instructions, assistant messages, tool inputs, output previews, and compaction summaries. Candidates come from Postgres full-text search plus, when embeddings are configured, a vector list, fused by reciprocal rank fusion; the first line says which (\"lexical + vector\" or \"lexical only\") and the scope used. Ranking is authority first, then recency, then similarity: tier 3 = cited by a CONFIRMED record state update or the result of a successful ledger_record_* call; tier 2 = cited by a PROPOSED update; tier 1 = uncited event; tier 0 = cited only by superseded or rejected updates. Each line ends with [tier N · current | PROPOSED | uncited | superseded by <update id> | rejected]. Scope: cwd (or scope repo) restricts to sessions on that repo and is the default whenever cwd is given; scope \"all\" widens explicitly. Narrow further by record_id (its linked spans), session_id, author, kinds, hours, or as_of (events at or before that instant, update status evaluated as of then). Read one event in full with ledger_events(session_id, after_seq, limit: 1, preview_chars) — the shortened session id printed here is accepted there. This searches evidence, not the knowledge ledger; use ledger_search for definitions, findings, changes, and decisions.",
        inputSchema: {
          q: z.string().min(2),
          cwd: z.string().optional().describe("A path inside a repo to restrict to sessions on that repo (scope repo)"),
          scope: SCOPE,
          record_id: z.string().optional().describe("Restrict to events inside this record's linked spans"),
          session_id: z.string().optional(),
          author: z.string().optional().describe("Only sessions by this author"),
          kinds: z.array(z.string()).optional().describe('e.g. ["instruction.added","assistant.message"], ["compaction"], ["tool.requested"]'),
          hours: z.number().int().min(1).max(24 * 365).optional(),
          as_of: z.string().optional().describe("ISO instant: only events at or before it; an update confirmed after it counts as PROPOSED"),
          limit: z.number().int().min(1).max(200).default(20),
        },
        annotations: readOnly,
      },
      async ({ q, cwd, scope, record_id, session_id, author, kinds, hours, as_of, limit }) => {
        try {
          const sc = scopeOf(cwd, scope);
          if (sc.error) return text(`ledger_evidence_search refused: ${sc.error}`);
          const res = await searchEvidence(pool(), q, { repo: sc.repo ?? undefined, record_id, session_id, author, kinds, sinceHours: hours, asOf: as_of, limit, cfg });
          const head = scopeLine(sc, { author, asOf: res.as_of, retrieval: res.retrieval + (res.retrieval_note ? ` (${res.retrieval_note})` : ""), extra: [...(record_id ? [`record ${record_id}`] : []), ...(session_id ? [`session ${session_id}`] : [])] });
          const lines = res.hits.length
            ? res.hits.map((e) => `[${e.similarity.toFixed(4)}${e.sources.includes("vector") ? (e.sources.includes("lexical") ? " lex+vec" : " vec") : ""}] ${e.session_id.slice(0, 8)} ${e.author}/${e.harness} · ${eventLine(e, undefined, { tier: e.tier, label: e.label })}`)
            : [`No events match "${q}"${record_id ? ` inside record ${record_id}` : ""}.`];
          const hits = res.hits.map((e) => ({ event_id: String(e.id), session_id: e.session_id, seq: e.seq, kind: e.kind, at: (e.occurred_at ?? e.received_at)?.toISOString?.() ?? null, author: e.author, tier: e.tier, label: e.label, similarity: e.similarity, rank: e.rank, sources: e.sources, citations: e.citations, ledger_write: e.ledger_write }));
          return { ...text([head, ...lines].join("\n")), structuredContent: { scope: head, scope_kind: sc.scope, repo: sc.repo, retrieval: res.retrieval, retrieval_note: res.retrieval_note, as_of: res.as_of, hits } };
        } catch (e: any) {
          return failed("ledger_evidence_search", e);
        }
      }
    );
  }

  return server;
}

export async function startMcp() {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e: any) {
    process.stderr.write(`ledger: ${e.message}\n`);
    process.exit(1);
  }
  // Evaluation embeds the same packaged guide as its explicit startup brief. Normal installs
  // keep their existing guide path; an ambient evaluation override alone cannot change it.
  const guidePath = process.env.LEDGER_EVAL === "1" ? process.env.LEDGER_EVAL_GUIDE_PATH : undefined;
  await createMcpServer(cfg, { guidePath }).connect(new StdioServerTransport());
}
