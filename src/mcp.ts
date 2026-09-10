import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { loadConfig, loadAll, record, getById, discardDraft, type Config } from "./store.js";
import { brief, search, similarFindings, renderFull, stats } from "./query.js";
import { AnalyticalDateSchema, AnalysisScopeSchema, ChangeSchema, DecisionSchema, DefinitionSchema, FindingSchema, TYPES, type LedgerObject } from "./schema.js";
import { correctionImpact, objectVersion, resolveAccepted } from './authority.js';
import { investigation } from './investigation.js';
import { validateCaptureCoverage, acknowledgeCapture, type CaptureAck } from './hooks.js';
import { verifyAcceptanceEvidence } from './acceptance-evidence.js';
import { validateRecordCoverage, acknowledgeLocalCapture, reconcileSharedCapture } from './capture-boundary.js';
import { EVIDENCE_URI, ReferenceSchema, evidenceResult, contributionResult } from "./evidence.js";
import { RECEIPT_GUIDANCE, savedReceipt, receiptText } from "./receipts.js";
import { continuityConfigured, getPool } from "./continuity/db.js";
import { listThreads, createThread, getThread, claimThread, releaseClaim, upsertSession, appendEvents } from "./continuity/store.js";
import { buildResumePack, threadLine } from "./continuity/resume.js";
import { queryEvents, getArtifact, eventLine, EVENTS_DEFAULT_LIMIT, EVENTS_MAX_LIMIT, PREVIEW_CHARS, PREVIEW_MAX_CHARS, ARTIFACT_DEFAULT_CHARS, ARTIFACT_MAX_CHARS } from "./continuity/evidence.js";
import { repoRoot, repoIdentity, currentBranch } from "./continuity/shadow.js";
import { openThreadsText } from "./continuity/brief.js";
import { writeBinding, writeSignal } from "./helper/signals.js";
import { buildRecordPack, listRecordSummaries, recordLine, unassignedLine } from "./continuity/recordpack.js";
import { addStateUpdate, confirmStateUpdate, createRecord, getRecord, linkSpan, rejectStateUpdate, searchEvents, unassignedSpans } from "./continuity/records.js";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

export function createMcpServer(cfg: Config, opts: { guidePath?: string } = {}) {
  const server = new McpServer({ name: "ledger", version: "0.1.0" });
  const evidenceUi = { ui: { resourceUri: EVIDENCE_URI } };
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

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
        "Search definitions, findings, changes, and decisions by free text. Use it BEFORE running an analysis (has this question been answered?), before attributing a metric move (what shipped?), and before proposing direction (what was decided?). Shows retrieved evidence, not proof of use. If your answer builds on these records, call ledger_show_contribution with the actual record IDs and answer excerpts." + RECEIPT_GUIDANCE,
      _meta: evidenceUi,
      annotations: readOnly,
      inputSchema: {
        query: z.string().min(2),
        types: z.array(z.enum(TYPES)).optional(),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(50).default(10),
        include_superseded: z.boolean().default(false),
        analysis_scope: AnalysisScopeSchema.partial().optional().describe('Analytical applicability, not a permission boundary'),
        as_of: AnalyticalDateSchema.optional().describe('Effective date for definition/correction resolution'),
      },
    },
    async ({ query, types, tags, limit, include_superseded, analysis_scope, as_of }) => {
      const hits = search(cfg, query, { types, tags, limit, includeSuperseded: include_superseded, scope: analysis_scope, asOf: as_of });
      if (!hits.length) return evidenceResult(`No matches for "${query}". If you go on to answer this, record the finding.`, [], { query });
      return evidenceResult(
        hits
          .map((h) => `[${h.score.toFixed(2)}] ${h.type} ${h.id} — ${h.title}\n    ${(h.fields.result ?? h.fields.formula ?? h.fields.decision ?? h.fields.what ?? "")}\n    Authority: ${h.authority_status}${h.authority_status==='conflict' ? `; competing accepted sources: ${h.authority_current_ids.join(', ')}; do not choose by recency` : ''}${h.authority_warnings.length ? `\n    ${h.authority_warnings.join('\n    ')}` : ''}`)
          .join("\n"), hits, { query }
      );
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
      const authority = resolveAccepted(loadAll(cfg, TYPES, false), id, {asOf: as_of});
      const current = authority.current.filter(c=>c.id !== o.id);
      const objects = [...new Map([o,...current,...authority.proposals].map(x=>[x.id,x])).values()];
      return evidenceResult([renderFull(o), `content_version: ${objectVersion(o)}`, `Accepted resolution: ${authority.status}`,
        ...authority.warnings.map(w=>`WARNING: ${w}`),
        ...current.map(c=>`Applicable accepted source:\n${renderFull(c)}\ncontent_version: ${objectVersion(c)}`),
        ...authority.proposals.map(p=>`PROPOSED, not accepted: ${p.id} — ${p.title}`)].join('\n\n'), objects);
    }
  );

  registerAppTool(server, 'ledger_investigation', {
    title: 'Continue an analytical investigation',
    description: 'Retrieve accepted definitions, correction history, exact dependencies and affected results across full history before continuing analytical work. Proposed claims cannot displace accepted knowledge. Supply analytical scope; missing scope and lineage remain explicit.' + RECEIPT_GUIDANCE,
    inputSchema: { question: z.string().min(2), analysis_scope: AnalysisScopeSchema.partial().optional(), definition_ids: z.array(z.string()).optional(), as_of: AnalyticalDateSchema.optional(), limit: z.number().int().min(1).max(50).default(10) },
    _meta: evidenceUi, annotations: readOnly,
  }, async ({question, analysis_scope, definition_ids, as_of, limit}) => {
    const pack = investigation(cfg, {question, scope:analysis_scope, definition_ids, as_of, limit});
    const result = evidenceResult(pack.text, pack.objects, {query: question});
    return {...result, structuredContent: {...result.structuredContent, investigation: pack}};
  });

  registerAppTool(server, 'ledger_impact', {
    title: 'Review work affected by a correction',
    description: 'Traverse exact definition and finding dependencies from an accepted correction. Returns direct/transitive review paths and incomplete legacy lineage. Needs review does not mean false.' + RECEIPT_GUIDANCE,
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
          const sim = similarFindings(cfg, String(fields.question));
          if (sim.length) {
            warn =
              `\n\nNote: ${sim.length} similar finding(s) already exist. If yours is a refresh, set supersedes to the old id. If the numbers disagree, say why in caveats.\n` +
              sim.map((s) => `  ${s.id} (${s.author}, ${s.created.slice(0, 10)}): ${s.fields.result}`).join("\n");
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
        const details =
          `Recorded ${type} ${res.id}` +
            (res.superseded ? ` (superseded ${res.superseded})` : "") +
            (res.git ? ` — ${res.git}` : "") +
            warn + captureWarning;
        return { content: [receiptText(receipt, details)], structuredContent: { receipt, ...(captureAck ? {capture_ack:captureAck} : {}) } };
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
    "Record the result of an analysis as an argument, not a number: question, result, definitions used, data window, inputs (every table/event), method (how inputs became the result, in words), the exact query, and assumptions. At least one assumption must be kind: implicit (data completeness, definition match, nothing shipped in the window); the tool rejects the record otherwise and says what to add. Do this at the END of any analysis, even a small one, even at low confidence. Returns similar prior findings so duplicates are visible."
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

  server.registerTool(
    "ledger_stats",
    {
      title: "Ledger stats",
      description: "Pilot health: object counts by author, findings missing definitions, cross-author duplicate findings.",
      inputSchema: { days: z.number().int().min(1).max(365).default(14) },
    },
    async ({ days }) => text(stats(cfg, days))
  );

  // ---------- execution continuity (spec §8) ----------
  if (continuityConfigured(cfg)) {
    const pool = () => getPool(cfg);
    const sessionOf = (given?: string) => given || process.env.CLAUDE_SESSION_ID || process.env.CODEX_THREAD_ID || `mcp:${cfg.author}:${process.pid}`;

    server.registerTool(
      "ledger_threads",
      {
        title: "Open work threads",
        description: "List teammates' (and optionally your own) open work threads: goal, last activity, harness, claim holder, verified snapshot age. Use before continuing anyone's work. Pass cwd to see threads on the repo you are in.",
        inputSchema: {
          cwd: z.string().optional().describe("A path inside the repo to filter by; defaults to all repos"),
          author: z.string().optional(),
          include_own: z.boolean().default(false),
          hours: z.number().int().min(1).max(720).default(72),
          limit: z.number().int().min(1).max(50).default(10),
        },
      },
      async ({ cwd, author, include_own, hours, limit }) => {
        const root = cwd ? repoRoot(cwd) : null;
        const rows = await listThreads(pool(), { repo: root ? repoIdentity(root) : undefined, author, excludeAuthor: include_own || author ? undefined : cfg.author, sinceHours: hours, status: "open", limit });
        return text(rows.length ? rows.map((r) => threadLine(r)).join("\n") : "No open threads match.");
      }
    );

    server.registerTool(
      "ledger_thread_get",
      { title: "Thread detail", description: "Full detail for one thread: every human instruction, files touched, pending operations, checkpoint, claim state. Read-only; does not claim.", inputSchema: { thread_id: z.string() } },
      async ({ thread_id }) => text((await buildResumePack(cfg, pool(), thread_id, { mode: "inspect", author: cfg.author, budgetTokens: 12000 })).text)
    );

    server.registerTool(
      "ledger_resume",
      {
        title: "Resume a thread or a work record",
        description: "Continue a teammate's work. Pass thread_id for a thread (one session's worktree and claim) or record_id for a work record (one goal accumulated across sessions and teammates: state with proposed items flagged, evidence from every contributing session in time order, pending operations, contradictions, linked Ledger objects with supersession flags, unassigned spans that may belong, and the bootstrap for the latest snapshot). mode=continue claims the thread (advisory; for a record, the thread of its most recent contributing session; a non-code record has no claim) and returns the pack with worktree bootstrap commands; mode=fork (threads only) creates a linked fork you own; mode=inspect reads without claiming. Pass cwd (a checkout of the same repo) to get the diff of what changed since the checkpoint. Your first turn must inspect the worktree, state confirmed vs uncertain progress, never treat a proposed update as decided, and never blindly rerun a pending operation.",
        inputSchema: {
          thread_id: z.string().optional().describe("Thread to resume; thread_id or record_id is required"),
          record_id: z.string().optional().describe("Work record to resume instead of a thread (from ledger_records or the brief's Open work section)"),
          mode: z.enum(["continue", "fork", "inspect"]).default("continue"),
          cwd: z.string().optional().describe("Local checkout of the same repo, for the intervening-change diff"),
          session_id: z.string().optional().describe("Your harness session id if known; binds this session to the thread"),
          budget_tokens: z.number().int().min(1500).max(20000).default(6000),
        },
      },
      async ({ thread_id, record_id, mode, cwd, session_id, budget_tokens }) => {
        const sid = sessionOf(session_id);
        if (record_id) {
          if (mode === "fork") return text("mode=fork applies to threads; use mode=continue or mode=inspect with record_id (fork the underlying thread with thread_id if you need parallel work).");
          try {
            const pack = await buildRecordPack(cfg, pool(), record_id, { mode, author: cfg.author, sessionId: sid, repoPath: cwd, budgetTokens: budget_tokens });
            if (mode === "continue" && pack.claim.acquired && pack.claim.thread_id) writeBinding(sid, { thread_id: pack.claim.thread_id });
            return text(pack.text);
          } catch (e: any) {
            return text(`ledger_resume failed: ${e.message}`);
          }
        }
        if (!thread_id) return text("thread_id or record_id is required.");
        const pack = await buildResumePack(cfg, pool(), thread_id, { mode, author: cfg.author, sessionId: sid, repoPath: cwd, budgetTokens: budget_tokens });
        if (mode !== "inspect" && pack.claim.acquired) writeBinding(sid, { thread_id: pack.fork?.id ?? thread_id });
        return text(pack.text);
      }
    );

    server.registerTool(
      "ledger_thread_start",
      { title: "Start a new thread", description: "Bind this session to a new thread you own, with an explicit title and goal. Otherwise the helper auto-creates one from your first prompt.", inputSchema: { title: z.string().min(3).max(140), goal: z.string().optional(), cwd: z.string().describe("A path inside the repo"), session_id: z.string().optional() } },
      async ({ title, goal, cwd, session_id }) => {
        const root = repoRoot(cwd);
        if (!root) return text("cwd must be inside a git repo so the thread has a repo identity.");
        const t = await createThread(pool(), { repo: repoIdentity(root), branch: currentBranch(root), title, goal: goal ?? null, created_by: cfg.author });
        const sid = sessionOf(session_id);
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

    server.registerTool(
      "ledger_records",
      {
        title: "Open work records",
        description: "List work records: the logical units of work that accumulate across sessions and teammates (a thread is one session's worktree; a record is one goal). One line each: kind · title · repo or non-code · updated · contributing sessions · proposed/confirmed updates · id. Records are cross-author by nature, so nobody is excluded. Pass cwd to see records on the repo you are in; q for a title/goal substring. Continue one with ledger_resume(record_id) or read it with ledger_record_get.",
        inputSchema: {
          cwd: z.string().optional().describe("A path inside the repo to filter by; defaults to all repos and non-code records"),
          kind: z.enum(RECORD_KINDS).optional(),
          status: z.enum(RECORD_STATUSES).default("open"),
          author: z.string().optional().describe("Filter by the record's creator"),
          q: z.string().optional().describe("Case-insensitive substring over title and goal"),
          hours: z.number().int().min(1).max(24 * 365).default(336).describe("Only records updated within this many hours (default 14 days)"),
          limit: z.number().int().min(1).max(50).default(15),
        },
        annotations: readOnly,
      },
      async ({ cwd, kind, status, author, q, hours, limit }) => {
        try {
          const root = cwd ? repoRoot(cwd) : null;
          const rows = await listRecordSummaries(pool(), { repo: root ? repoIdentity(root) : undefined, kind, status, author, q, sinceHours: hours, limit });
          return text(rows.length ? rows.map((r) => recordLine(r)).join("\n") : "No records match.");
        } catch (e: any) {
          return failed("ledger_records", e);
        }
      }
    );

    server.registerTool(
      "ledger_record_get",
      {
        title: "Work record detail",
        description: "The full record pack without claiming anything: state projection with [PROPOSED] items flagged and contradictions side by side, contributing sessions and authors, evidence across all of them in time order, the latest compaction summary as evidence, files touched, pending operations from the most recent contributing session, linked Ledger objects with supersession flags, unassigned spans that may belong, and the bootstrap when the record has a repo. Everything omitted for budget is named with the call that fetches it.",
        inputSchema: {
          record_id: z.string(),
          budget_tokens: z.number().int().min(1500).max(40000).default(12000).describe("Raise to 20000 to see up to 50 state items per kind"),
          cwd: z.string().optional().describe("Local checkout of the same repo, for the bootstrap rebase target"),
        },
        annotations: readOnly,
      },
      async ({ record_id, budget_tokens, cwd }) => {
        try {
          return text((await buildRecordPack(cfg, pool(), record_id, { mode: "inspect", author: cfg.author, repoPath: cwd, budgetTokens: budget_tokens })).text);
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
        },
      },
      async ({ record_id, session_id, from_seq, to_seq, note }) => {
        try {
          const rec = await getRecord(pool(), record_id);
          if (!rec) return text(`Not found: record ${record_id}`);
          const l = await linkSpan(pool(), { record_id, session_id, from_seq, to_seq, source: "explicit", note: note ?? null, created_by: cfg.author });
          return text(`Linked session ${session_id} seq ${from_seq}..${to_seq} to record "${rec.title}" (${rec.id}); link ${l.id}, explicit, by ${cfg.author}.`);
        } catch (e: any) {
          return failed("ledger_record_link", e);
        }
      }
    );

    server.registerTool(
      "ledger_record_update",
      {
        title: "Propose, confirm, or reject a record state update",
        description: "Append to a work record's state. action=propose adds a proposed update (kind: progress | decision | hypothesis | blocker | next | contradiction | note) with the exact events it rests on; it is never confirmed on propose and does not change state_version. action=confirm accepts a proposed update on the person's behalf and bumps state_version. action=reject declines one with a reason (kept in history). To replace an earlier update, propose a new one with supersedes; nothing is edited. A confirmed record state is still not a Ledger decision or finding; promote with ledger_record_decision / ledger_record_finding.",
        inputSchema: {
          record_id: z.string(),
          action: z.enum(["propose", "confirm", "reject"]),
          kind: z.enum(UPDATE_KINDS).optional().describe("propose: the update kind"),
          text: z.string().max(4000).optional().describe("propose: the update, one or two sentences, stated so it could later be false"),
          evidence: z.array(z.object({ session_id: z.string(), seq: z.number().int().min(0) })).optional().describe("propose: at least one exact event this update rests on"),
          supersedes: z.string().optional().describe("propose: id of an earlier update this one replaces"),
          update_id: z.string().optional().describe("confirm / reject: the update id"),
          reason: z.string().max(1000).optional().describe("reject: why (required)"),
        },
      },
      async ({ record_id, action, kind, text: body, evidence, supersedes, update_id, reason }) => {
        try {
          const rec = await getRecord(pool(), record_id);
          if (!rec) return text(`Not found: record ${record_id}`);
          if (action === "propose") {
            if (!kind) return text("propose needs kind (progress | decision | hypothesis | blocker | next | contradiction | note).");
            if (!body?.trim()) return text("propose needs text.");
            if (!evidence?.length) return text("propose needs evidence: at least one { session_id, seq } the update rests on. A state update without evidence is a guess; find the event with ledger_events or ledger_evidence_search first.");
            const u = await addStateUpdate(pool(), { record_id, kind, text: body, evidence, created_by: cfg.author, supersedes: supersedes ?? null });
            return text(`Proposed ${u.kind} update ${u.id} on record "${rec.title}" (status proposed; state_version unchanged at ${rec.state_version}${u.supersedes ? `; supersedes ${u.supersedes}` : ""}). It renders as [PROPOSED] until a person confirms it: ledger_record_update(record_id: "${rec.id}", action: "confirm", update_id: "${u.id}").`);
          }
          if (!update_id) return text(`${action} needs update_id.`);
          if (action === "confirm") {
            const u = await confirmStateUpdate(pool(), update_id, cfg.author);
            if (!u) return text(`Not found: update ${update_id}`);
            const after = await getRecord(pool(), record_id);
            return text(`Confirmed ${u.kind} update ${u.id} on record "${rec.title}" by ${u.confirmed_by} (state_version now ${after?.state_version ?? "?"}).`);
          }
          if (!reason?.trim()) return text("reject needs reason: say why the update is wrong or not durable; it is kept in history.");
          const u = await rejectStateUpdate(pool(), update_id, cfg.author, reason);
          if (!u) return text(`Not found: update ${update_id}`);
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
        description: "Create a work record for a goal that will span sessions or teammates: an investigation, an implementation, a piece of writing, a decision in progress. Pass cwd inside a git repo for code work (the record gets that repo identity) or omit it for non-code work (hiring, copy, planning). Optionally link the span of your current session that already belongs to it.",
        inputSchema: {
          kind: z.enum(RECORD_KINDS),
          title: z.string().min(3).max(200),
          goal: z.string().max(2000).optional(),
          cwd: z.string().optional().describe("A path inside the repo for code work; omit for non-code work"),
          link: z.object({ session_id: z.string(), from_seq: z.number().int().min(0), to_seq: z.number().int().min(0) }).optional().describe("A span of a session to link explicitly at creation"),
        },
      },
      async ({ kind, title, goal, cwd, link }) => {
        try {
          const root = cwd ? repoRoot(cwd) : null;
          const repo = root ? repoIdentity(root) : null;
          const rec = await createRecord(pool(), { kind, title, goal: goal ?? null, repo, created_by: cfg.author });
          let linked = "";
          if (link) {
            const l = await linkSpan(pool(), { record_id: rec.id, session_id: link.session_id, from_seq: link.from_seq, to_seq: link.to_seq, source: "explicit", created_by: cfg.author });
            linked = ` Linked session ${link.session_id} seq ${link.from_seq}..${link.to_seq} (link ${l.id}).`;
          }
          return text(`Record ${rec.id} "${rec.title}" (${rec.kind}) created${repo ? ` on ${repo}` : " as non-code work"} by ${cfg.author}.${linked} Propose state with ledger_record_update; link further spans with ledger_record_link.`);
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
        description: "Postgres full-text search over captured evidence: human instructions, assistant messages, tool inputs, output previews, and compaction summaries, across every session. Narrow to a record's linked spans (record_id), one session, a repo (cwd), event kinds, or a time window. Returns ranked event lines with session, author, and harness; read one in full with ledger_events(session_id, after_seq, limit: 1, preview_chars) — the shortened session id printed here is accepted there. This searches evidence, not the knowledge ledger; use ledger_search for definitions, findings, changes, and decisions.",
        inputSchema: {
          q: z.string().min(2),
          cwd: z.string().optional().describe("A path inside a repo to restrict to sessions on that repo"),
          record_id: z.string().optional().describe("Restrict to events inside this record's linked spans"),
          session_id: z.string().optional(),
          kinds: z.array(z.string()).optional().describe('e.g. ["instruction.added","assistant.message"], ["compaction"], ["tool.requested"]'),
          hours: z.number().int().min(1).max(24 * 365).optional(),
          limit: z.number().int().min(1).max(200).default(20),
        },
        annotations: readOnly,
      },
      async ({ q, cwd, record_id, session_id, kinds, hours, limit }) => {
        try {
          const root = cwd ? repoRoot(cwd) : null;
          const rows = await searchEvents(pool(), q, { repo: root ? repoIdentity(root) : undefined, record_id, session_id, kinds, sinceHours: hours, limit });
          if (!rows.length) return text(`No events match "${q}"${record_id ? ` inside record ${record_id}` : ""}.`);
          return text(rows.map((e) => `[${e.rank.toFixed(3)}] ${e.session_id.slice(0, 8)} ${e.author}/${e.harness} · ${eventLine(e)}`).join("\n"));
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
