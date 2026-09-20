# Ledger production readiness: Agaaz and Rachit

Date: 20 September 2026. Status: proposed engineering plan; no implementation or production validation claimed. Code inspected: `9beb92b375612a066d2c234d6c4ba8690d8d9156`.

## Recommendation and delivery target

Keep Ledger and harden the existing system. Ship discovery and binding fixes first, then make capture durable and independent of slow snapshot operations. Instrument actual retrieval and completed handoffs so the next weekly review measures use, reliability, and cost separately.

Production scope is the two configured team members, their supported local Claude/Codex sessions, and their explicitly permitted repositories and non-repository analysis. This is not a launch of a hosted, multi-tenant service. Production readiness means the release gates below pass on **both machines**; healthy Agaaz capture cannot substitute for Rachit evidence.

Planning estimate: **8–13 engineer-days**, including implementation, regression work, and release operations, with coding-agent assistance. With two engineers and careful integration, target **6–9 working days to a release candidate and the 72-hour canary**, assuming access to both machines and a disposable Postgres instance. Discovery/binding patches should be available in the first **1–2 working days**. These are estimates, not benchmarked agent speedups. One engineer should budget roughly two working weeks plus any unfinished canary time. Do not compress the fault tests or two-machine canary to meet a date.

## Evidence and boundaries

The audit covers `[2026-09-13T12:32:40Z, 2026-09-20T12:32:40Z)`. Its local report and reproducible inputs are in [the audit directory](../../.context/ledger-audit/REPORT.md), which is gitignored and will not accompany a clone. Shared evidence is recorded in:

- `fnd-20260920-tranzmit-ledger-weekly-audit-155-objects-59-expl-o4qp`, version `c15374289b4ea32808f0dac1a765e8bd72be3fddc67c428c775ff50e3d4cf6cd`.
- `fnd-20260920-tranzmit-continuity-weekly-audit-11-dedicated-ne-t8co`, version `fa42b20108ba7ad1e442bf2138cb7d4095b1893e77a16d52b95ac82daf740db0`.
- Metric definition: `def-20260920-ledger-weekly-activity-audit-recording-explicit--78hh`, version `193ea15fcf886f4b9357b4a508e5a6465a1ce6cdec487e9e2e47ccb33ad266e8`.

Observed baseline: all 12 identified structured analytical lookups returned no matches; 15/155 new objects carried `analysis_scope`; 21/409 pre-cutoff objects did. Captured-event arrival p95 was 6.1 minutes for Agaaz and 24.0 hours for Rachit, including offline/backlog uploads. These numbers are not completeness or online latency measures. Eleven dedicated successful Neon continuity reads were identified, a lower bound that excludes unquantified SQL inside other operations. There were no observed ordinary-work `ledger_resume` calls. Cross-person knowledge reuse was demonstrated; executable handoff reliability and positive net ROI were not.

Preserve existing decisions: investigations are identified by question, not checkout (`dec-20260917-investigations-are-keyed-by-their-question-repos-w8tj`); analysis binds or declares before query-grain proposals (`dec-20260917-multi-pm-continuity-bind-or-new-at-session-start-u44f`); Git remains the knowledge authority and Neon holds continuity state (`dec-20260917-ship-ledger-graph-as-a-read-only-cli-view-over-g-59x1`). Do not automatically accept findings or classifier proposals to improve adoption statistics.

## What already exists

| Existing component | Reuse and repair |
|---|---|
| `src/investigation.ts`, `query.ts`, `authority.ts` | Keep exact scope/authority resolution, corrections, dependency pins, and conflicts. Add a separate candidate discovery result. |
| `src/store.ts`, `schema.ts`, `mcp.ts` | Extend proposal/write validation and scope propagation; keep immutable accepted history and explicit supersession. |
| `src/continuity/investigations.ts`, `records.ts` | Keep question-based work records and explicit event links; make multi-write transitions atomic. |
| `src/helper/spool.ts`, `daemon.ts`, `continuity/store.ts` | Keep local-first buffering, stable producer IDs, Postgres uniqueness, and session locking; repair crash boundaries and batch upload. |
| `src/continuity/shadow.ts`, `resume.ts` | Keep hidden refs, deny rules, remote verification, claims, generations, and fresh-worktree bootstrap. |
| `src/capture-tools.ts`, `continuity/events.ts`, hook journals | Reuse safe static wrapper parsing and runtime evidence. Never evaluate wrapper JavaScript to discover calls. |
| `src/helper/heartbeat.ts`, `continuity/brief.ts` | Extend existing health reporting instead of adding an observability service. |
| `src/selftest-*.ts`, `src/eval/` | Extend Node assertion tests and existing two-author fixtures; no test-framework replacement. |

The classifier is already dispatched asynchronously with bounded concurrency. Detaching it again is not a fix. Verify its runtime/errors, but prioritize the synchronous snapshot and serial upload path actually present in the helper.

## Engineering findings

| ID | Finding in current code | Consequence and required fix |
|---|---|---|
| F1 | `analyticalContext` filters by scope before ranking; unscoped matches appear as unresolved IDs, without useful candidate context. | Preserve strict applicability; expose bounded, clearly unverified candidates. |
| F2 | `proposeFinding` constructs metric/population/window but does not carry `analysis_scope`; its definition lookup uses a metric name. | New proposals can perpetuate the discovery gap; propagate scope and resolve exact definitions before establishing lineage. |
| F3 | `resolveHarnessSession` depends on explicit IDs or validated process environment; `harnessGuess` defaults to Claude, and the session upsert does not repair harness metadata. | Missing/stale server environment blocks binding or mislabels sessions. Carry real session identity and record provenance. |
| F4 | Bind/create/link/touched-repo writes are not one transaction; the already-bound branch can bypass repair of an incomplete link. | A timeout or crash can leave partial state. Make transitions atomic, idempotent, and reconcilable after ambiguous commit. |
| F5 | The helper consults Neon before tailing; advances its in-memory transcript cursor before spool append; spool acknowledgments and compaction use separate writes. | Outage can delay capture; crashes can lose or replay boundaries. Establish one durable local commit boundary. |
| F6 | Pending spool/transcript reads are unbounded; event inserts await one SQL statement per event; sessions drain sequentially. | Backlog can monopolize memory and ingestion. Use bounded chunks, bulk inserts, and fair scheduling. |
| F7 | Snapshot Git operations are synchronous and use a fresh private index per snapshot. | Slow Git can starve upload and heartbeats. Separate snapshot execution and reuse a safely invalidated private index. |
| F8 | Full result artifact storage failure is caught and labelled as an oversized output, allowing the event to advance. | A transient storage failure can become missing evidence. Retain retryable bytes and distinguish unavailable, redacted, oversize, and pending. |
| F9 | Wrapper previews hide adjacent calls; runtime MCP end events carry information not normalized into a complete logical invocation; heuristic correlation is ambiguous. | Existing counts understate use and can overstate gaps. Emit authoritative server-side invocation outcomes and reconcile explicitly. |
| F10 | Continuity brief sections convert timeout/error to an empty string; capture age cannot establish machine activity. | Empty can look like no prior work, and silence can look like failure or success. Return explicit availability and freshness states. |

These code paths establish risks and repair opportunities, not a causal decomposition of the audit's 24-hour lag. Phase 0 measures stage timings to distinguish backlog, machine sleep, network delay, and local blocking.

## Architecture and invariants

```text
Analytical question + supplied scope
  -> existing accepted-scope resolver -> applicable / conflict / needs-review
  -> separate lexical candidate search -> scope-unknown, never authoritative
  -> agent opens evidence -> validates scope -> cites exact record/version

Harness transcript / supported hook
  -> normalize + redact + bounded parse
  -> fsync local spool segment + durable source cursor
       |-> fair bounded uploader -> artifacts + bulk event transaction -> ack
       |-> snapshot queue -> asynchronous Git -> remote verification -> fenced checkpoint
       `-> local health / backlog state

MCP/CLI invocation -> server outcome + storage-operation summary
  -> independent bounded local usage spool -> Neon usage tables
  -> weekly usage and handoff report (telemetry itself excluded)
```

Invariants: replay may repeat an upload but cannot duplicate a producer event; remote acknowledgment follows commit, never dispatch; a source cursor advances only after durable capture or an explicit retained rejection; a verified snapshot means the remote object was verified; old claim generations cannot advance a successor's head; missing identity never becomes a fabricated session; candidate discovery never changes authority; proposed knowledge remains proposed. Redaction and repository permissions apply before spool/artifact persistence. Reuse the existing home-root and nested-checkout restrictions.

## Implementation Tasks

All eight tasks are **P1 release blockers** for this production scope. Smaller discovery/binding fixes may ship to the existing pilot earlier. Estimates include review and targeted testing; autonomous-agent elapsed time is unmeasured. Owners below are engineering roles to assign, not commitments attributed to either teammate.

Build checklist (machine-readable: [task JSONL](production-readiness-tasks-2026-09-20.jsonl)):

- [ ] T1 — Safe fixtures, contracts, and operational baseline.
- [ ] T2 — Candidate discovery and scope propagation.
- [ ] T3 — Verified session identity and atomic binding.
- [ ] T4 — Durable spool, fair bulk upload, and artifact retries.
- [ ] T5 — Asynchronous snapshots and fenced publication.
- [ ] T6 — Invocation and Neon-read telemetry.
- [ ] T7 — Visible availability and measurable handoff outcomes.
- [ ] T8 — Guarded regression, restore, rollout, and real handoffs.

### T1 / PR 1 — Establish contracts, safe fixtures, and the operational baseline

**Owner:** release/integration owner. **Effort:** 0.5–1 day. **Depends on:** none. **Findings:** F3, F5–F10.

- Introduce typed contracts for availability, capture stage timestamps, identity provenance, logical invocation IDs, and explicit `traffic_class` (`ordinary`, `evaluation`, `audit`, `maintenance`, `unknown`). Freeze these before parallel implementation.
- Add an isolated test launcher that creates a disposable DB/config/Git remote and refuses the configured team DB. Existing continuity selftests drop `cont_*` tables: a test command must never inherit a live connection accidentally. Require an explicit test marker and disposable database identity before destructive setup.
- Record both machines' installed release, MCP executable path, hook trust/configuration, helper heartbeat, permitted scope, transcript readability, pending bytes, and snapshot capability. Do not widen Rachit's capture permissions to make the chart green.
- Capture read/parse/spool/connection/upload/artifact/snapshot durations and error classes, with no prompts, query text, or credentials in metric labels. Preserve pending spools and original timestamps.
- Verify the existing `TODOS.md` credential-rotation item is closed with evidence; if still open, rotate and update both clients through a secret-safe procedure, then verify the old credential fails. Never paste a DB URL into a plan, transcript, shell history, or test output. Verify backups by a restore drill before final release.

**Done when:** the release owner can distinguish asleep/offline/unknown from an online stalled helper, run isolated tests safely, and account for the actual installed runtime on both machines.

### T2 / PR 2 — Make relevant knowledge discoverable without weakening authority

**Owner:** knowledge engineer. **Effort:** 1–1.5 days. **Depends on:** T1 contracts. **Findings:** F1, F2.

**Files:** `src/investigation.ts`, `query.ts`, `store.ts`, `schema.ts`, `mcp.ts`, analytical guide/schema surfaces, investigation/finding/authority selftests.

- Add `legacy_candidates` alongside the existing authoritative fields, never into `current` or resolved definitions. Return at most five by default, with ID, content version, author, status, relevant excerpt, scope gaps, reason matched, and a suggested evidence-opening action. Always allow candidates even when there are some authoritative hits, so a partial answer does not hide useful history.
- Candidate eligibility: missing or incomplete scope, lexical relevance, and no contradiction in known scope fields. Apply existing visibility restrictions. Keep draft, superseded, discarded, and conflicting labels; no promotion by recency. Preserve correction warnings and exact dependency traversal. Separate `no_applicable_records`, `candidates_available`, `no_matches`, and `unavailable` in structured output and receipts.
- Use existing lexical scoring and authority labels; no embeddings or second knowledge store. A known incompatible product/environment does not become a fallback hit.
- Carry explicit `analysis_scope` through query-grain proposals, acceptance, full recording, CLI, and MCP. Missing scope remains visible and can be saved as a draft. For **new scoped analytical authority**, require the scope necessary to establish applicability; do not invent values to pass validation or require fabricated metrics on qualitative work.
- Replace name-only definition inference with scoped resolution and exact ID/version pins where a definition is actually used. Preserve old findings. Offer a bounded review list for frequently reused legacy records; validated enrichment creates a new scoped finding with a `derived-from` pin to the original ID/version and an exact applicable definition. The original remains unchanged: scope identities cannot be altered through supersession. Same-scope corrections retain the existing acceptance/version and downstream impact checks. No mass auto-backfill from titles or record membership.

**Done when:** the real funnel question exposes its known prior findings as candidates, all known-answerable audit fixtures find the expected record within five candidates, true negatives remain negative, and the authority/correction suite proves candidates cannot become applicable evidence implicitly. New fully scoped proposals survive acceptance with unchanged scope and lineage.

### T3 / PR 3 — Fix session identity and transactional binding

**Owner:** continuity engineer. **Effort:** 1–1.5 days. **Depends on:** T1. **Findings:** F3, F4.

**Files:** `src/continuity/safety.ts`, `investigations.ts`, `store.ts`, `db.ts`, `src/hooks.ts`, `mcp.ts`, guides, records/helper-safety selftests.

- Include the actual harness session ID in SessionStart instructions for bind/new/propose and pass it explicitly at mutating tool boundaries. Validate syntax and local context. Reuse verified environment identity only when it matches the current transcript; if unknown, give a precise recovery instruction. Do not choose the newest transcript, infer the harness from UUID shape, or invent IDs.
- Store identity provenance and `unknown` harness when evidence is absent. Permit correction of mislabelled harness metadata only from verified transcript/runtime evidence, retaining correction provenance. Preserve configured human attribution.
- Execute bind/rebind plus explicit span and touched-repo changes in one transaction on one checked-out `pg` client. Lock the session/binding in a consistent order; preserve historical spans on rebind. Repeating the same bind must converge on complete state, including repairing any legacy partial binding.
- Make declare-and-bind atomic. Add a durable request idempotency key for mutation retries and serialize competing declarations for an exact normalized question. Existing fuzzy matches remain suggestions/refusals, not an automatic semantic merge of distinct questions.
- Bound lock/query/connection deadlines; distinguish refusal, timeout before execution, committed success, and outcome unknown. After an ambiguous connection failure, query the operation key before retrying. Do not blindly retry arbitrary mutations or create a second investigation.

**Done when:** concurrent/repeated binds produce one consistent binding and correct spans; crash injection at every write leaves all-or-nothing state; post-commit connection loss reconciles to the original result; ordinary Codex and Claude starts bind on both machines without relying on stale MCP process environment.

### T4 / PR 4 — Make capture durable, bounded, and fair

**Owner:** continuity engineer. **Effort:** 2–3 days. **Depends on:** T1, T3 shared-store integration. **Findings:** F5, F6, F8.

**Files:** `src/helper/spool.ts`, `daemon.ts`, `src/continuity/events.ts`, `store.ts`, artifact persistence, continuity/events selftests.

- Move local tail/redact/spool before any network-dependent discovery. Bound transcript parsing by bytes and records, preserving partial lines and producer IDs. Cache or move blocking repository inspection off the local durability path.
- Use versioned append-only spool segments and an atomic manifest containing segment identity, acknowledged position, and source cursor. Flush bytes before committing the cursor; sync directory changes where needed. Quarantine corrupt complete frames visibly; never silently skip a middle frame and acknowledge past it. Keep partial trailing frames for recovery.
- Retain a compatibility reader for current spools. Migrate by durable copy and verification, preserving original files through the rollback window. A crash before/after segment rotation or acknowledgment must replay safely. No reset of helper state or deletion of pending spools as a remediation.
- Start with configurable chunks of at most 200 events / 1 MiB of event metadata, with separately bounded existing artifact limits. Deduplicate within a batch and against existing producer IDs under the session lock; assign ordered sequence numbers and bulk insert within the transaction. A duplicate input ID must not break or erase its neighboring fresh events.
- Drain sessions round-robin with a per-pass budget and bounded concurrency. Preserve order within each session; do not let a backlog monopolize the helper. Bound total connection demand across helper/MCP processes rather than merely increasing the existing pool size.
- Keep full artifact bytes durable until storage succeeds or a permanent redaction/size policy outcome is explicitly recorded. Store content-addressed artifacts idempotently before committing their event references; retry transient failures. Do not mutate away retry bytes or reclassify storage failure as oversize. A failed artifact must not block other sessions indefinitely.

**Done when:** kill/restart tests at every spool/transaction/ack boundary show zero missing or duplicate admitted events; offline capture proceeds; a backlog drains without starving a second active session; artifact hashes and bytes survive transient failure. Measured memory and queue limits stay bounded on a large replay fixture.

### T5 / PR 5 — Separate snapshots from capture and verify executable continuity

**Owner:** continuity engineer. **Effort:** 1–1.5 days. **Depends on:** T4. **Findings:** F7.

**Files:** `src/continuity/shadow.ts`, `src/helper/daemon.ts`, `heartbeat.ts`, checkpoint publishing, resume/continuity selftests.

- Run Git through asynchronous child processes in a bounded snapshot worker/queue. Coalesce redundant requests per worktree; one active snapshot per repository/worktree identity. Drain stdout/stderr, enforce timeout/cancellation, and surface failure. Upload and heartbeat scheduling must continue while a remote push stalls.
- Reuse a private index scoped to the worktree and invalidate it on repository identity, base tree, or deny/include policy changes. Never reuse the user's real Git index. Test branch changes, dirty index, denied tracked files, nested repos, and killed children.
- Carry the originating claim generation and the **captured** event watermark through the snapshot job. Publish only under the existing fencing rules; a late completion cannot claim to cover later events or advance a successor's head. Preserve separate event and code verification times.
- Label analysis-only work as snapshot-not-applicable. For code work, unverified push or unsupported checkout means unavailable executable continuity, not a healthy checkpoint.

**Done when:** a deliberately stalled 60-second Git push does not stall local capture/upload/heartbeats; a successor boots the remotely verified snapshot in a fresh worktree; a waking predecessor cannot overwrite the successor's head; pending mutating operations remain visible and are not automatically replayed.

### T6 / PR 6 — Count actual Ledger and Neon use at the source

**Owner:** telemetry/knowledge engineer. **Effort:** 1–1.5 days. **Depends on:** T1; serialize integration into `mcp.ts` and `db.ts` after T2/T3. **Findings:** F9.

**Files:** `src/mcp.ts`, CLI entry points, `capture-tools.ts`, `continuity/events.ts`, `db.ts`, new small usage module/migration, event/capture selftests.

- Wrap Ledger tool dispatch to emit one logical invocation identity, start, and terminal outcome: configured actor, verified session if known, harness/provenance, machine, version, tool, traffic class, duration, success/refusal/error, result record IDs/versions/authors, and availability. Do not store raw arguments, prompts, credentials, or full results in usage rows.
- Record storage operations beneath the invocation with `backend=git|neon`, operation class, purpose (`interactive_read`, `automatic_brief`, `capture_write`, `maintenance`, `telemetry`), success, duration, returned row count, and whether relevant evidence was returned. A successful zero-row SELECT counts as a read, separately from useful retrieval. Count API invocations and SQL operations separately, and count retries separately from logical operations.
- Persist usage asynchronously through an independent, bounded local spool and additive Neon tables (`cont_usage_invocations`, `cont_usage_storage_ops` or equivalent). Usage writes must not instrument themselves, block a user's read, or enter analytical query debt. Telemetry outage reports its own backlog/completeness; it does not imply zero use. Deduplicate by producer invocation/operation IDs. Start with 30-day raw retention and weekly aggregate exports; pruning is a documented maintenance action with coverage metadata.
- Normalize direct calls, wrapper calls, hook evidence, and runtime `mcp_tool_call_end` events into linked observations. Server invocation identity is authoritative; transcript/hook matches are corroboration. Static code matches are candidates, not proof of execution. Preserve unknown correlation for concurrent/dynamic wrappers instead of guessing or double-counting. Handle both supported error result shapes.
- Classify `capture.gap` as unknown shape, correlation mismatch, late delivery, or confirmed missing supported event. Preserve original observations. Historical audit counts remain lower bounds; new telemetry cannot retroactively prove unobserved calls.

**Done when:** deterministic direct/wrapped/concurrent/retried fixture calls reconcile exactly once with server outcomes; same-author/cross-author reference totals are reproducible; automatic brief reads, intentional agent reads, ingestion, and telemetry can be reported independently. An unrelated Neon SELECT is not evidence of continuity use.

### T7 / PR 7 — Make availability visible and close the handoff loop

**Owner:** telemetry/knowledge engineer, integrated by release owner. **Effort:** 0.5–1 day. **Depends on:** T2, T3, T5, T6. **Findings:** F10; outcome measurement gap.

**Files:** `src/continuity/brief.ts`, `resume.ts`, `recordpack.ts`, helper health, CLI/MCP renderers, `docs/continuity/runbook.md`.

- Return explicit section states: available with data, available empty, unavailable, or stale with known watermark. Keep the local knowledge brief usable during a Neon outage. A timed-out section says so and names recovery; it must not print “no work.” Clear timers and terminate/release overdue query work correctly; a `Promise.race` alone does not cancel the query.
- Extend the existing health surface with per-machine last heartbeat, source cursor, durable spool watermark, remote acknowledged event watermark, pending bytes/oldest age, clock-skew warning, snapshot verification, classifier status, and unresolved artifact/correlation counts. Classify online, offline, and unknown using explicit evidence. Avoid treating absent activity as a capture failure.
- Join work packs to explicitly linked Git finding IDs/versions, showing their statuses and source availability. Keep links to underlying events/artifacts. Do not create a second authoritative copy in Neon or turn every proposed state line into a finding.
- Extend resume reporting with a handoff attempt ID linking source work, destination session, pack delivered, snapshot verified/bootstrap outcome when applicable, pending-operation reconciliation, terminal outcome, and evidence references. “Opened,” “referenced,” “claimed,” and “completed” remain different events. Completion requires a delivered continuation result plus verifiable artifact/test/output evidence; user confirmation is recorded separately.

**Done when:** every timeout/stale/no-snapshot case is visible without blocking normal work; analysis and code handoffs can be followed from source record to delivered result; automatic retrieval and agent-reported references do not inflate completed handoffs.

### T8 / PR 8 — Release, restore, and demonstrate two-way handoffs

**Owner:** release/integration owner. **Effort:** 0.5–1 day of engineering plus 72 elapsed hours of observation. **Depends on:** T1–T7.

- Run the linked [test plan](production-readiness-test-plan-2026-09-20.md), isolated full regression suite, upgrade/rollback tests, and a Git-plus-Postgres restore drill. Extend the existing runbook with one command/check per failure class and named operational responsibility.
- Apply additive, versioned migrations first, with bounded lock time and old-client compatibility. Roll one versioned local runtime to Agaaz, then Rachit after a clean initial observation period. Verify each running MCP/helper build and hook trust, not merely the installed package. Feature flags separate discovery, binding, spool-v2, snapshot worker, and usage reporting.
- Preserve old spool input and schema columns through the canary. Roll back to the **compatibility release** that can read the new spool format; never start an incompatible old reader against new state. Disable a failing snapshot worker independently while preserving capture. If durability is suspect, stop remote acknowledgment/compaction, retain local evidence, and repair before resuming.
- Complete four real cross-person handoffs: one analysis and one code continuation in **each direction**. Analysis handoffs must open the retained evidence and deliver a continuation; code handoffs must bootstrap a verified remote snapshot, reconcile pending operations, make the requested change, and validate it. A fixture or this audit does not count as a real handoff.

**Done when:** all gates below pass, both people can use the release, and the release owner signs off the evidence bundle. Missing real work extends the pilot; do not invent a handoff to satisfy a date.

## Dependencies and implementation order

| Lane/step | Modules touched | Depends on |
|---|---|---|
| Integration: T1 contracts/fixtures | contracts, test harness, operations docs | — |
| Knowledge: T2 | knowledge resolver/store/schema, MCP | T1 |
| Continuity: T3 → T4 → T5 | continuity, helper, hooks, DB | T1, then sequential |
| Telemetry: T6 | usage module, MCP, continuity normalization/DB | T1; shared integration after T2/T3 |
| Integration: T7 → T8 | brief/resume/record packs, deployment/tests | all relevant preceding work |

Launch knowledge and continuity work in separate worktrees after T1. They share `src/mcp.ts`; let the integration owner apply the agreed schema/handler adapters sequentially. T6's pure usage module and fixtures can progress independently, but `db.ts`, `events.ts`, and MCP integration overlap the continuity lane and must merge sequentially. With only two engineers, the knowledge engineer takes telemetry after T2. Do not assign overlapping helper/continuity edits to independent agents without coordination.

Critical path: T1 → T3 → T4 → T5 → T7 → T8. T2 provides the first useful pilot improvement. Start stage instrumentation immediately and collect the baseline during implementation. Start the 72-hour release canary only after the integrated candidate is installed and migration/rollback checks pass on both machines.

## Release gates and service targets

Targets below are proposed engineering acceptance criteria, not current measured performance. Report author/machine separately, sample sizes, observation duration, excluded traffic, and unknown coverage. A missing denominator is “unknown,” never 100% healthy.

| Gate | Required evidence |
|---|---|
| Discovery correctness | All adjudicated known-answerable audit fixtures, including the funnel case, surface the expected authoritative record or labelled candidate within five results; true negatives and incompatible scopes stay excluded; zero authority leakage. Classify the original 12 queries before using them as a recall denominator. |
| Binding correctness | 100 deterministic repeated/concurrent/fault-injected mutation attempts: no orphan record, incorrect owner/session, duplicate operation, or partial binding; both real harnesses bind successfully on both machines. |
| Capture durability | Zero missing/duplicate admitted fixture events across crash/outage/replay tests; every source frame is either durably represented or explicitly rejected with retained reason. This validates supported inputs, not all possible harness output. |
| Online capture freshness | Over the 72-hour canary, for each machine, active-online events: p95 ≤60 s and p99 ≤180 s from occurrence to remote receipt; local durable admission p95 ≤5 s after parser observation. Track transcript-to-observation delay separately. Require ≥100 supported events per machine and disclose any shortfall rather than waiving the gate. |
| Offline recovery and fairness | Replay 10,000 mixed events with a 100 MiB artifact fixture after a simulated outage; proposed budget ≤10 minutes on the recorded test network, bounded memory, and a second active session still meets online freshness. Preserve ordering and report total backlog bytes/RTT. Calibrate the budget on day one; any changed target needs an explicit rationale. |
| Query and brief behavior | Warm dedicated reads/binds p95 ≤2 s on a fixed fixture; cold-start attempts resolve or give a typed unavailable/unknown outcome within 10 s. A 4-second brief budget may return partial sections, but never silently equates timeout to empty. Test cancellation and pool recovery. |
| Snapshot correctness | Remote-verified worktree round trip passes; deny rules and claim fencing pass; pending operations are never replayed blindly; slow snapshot work cannot break capture/heartbeat freshness. |
| Telemetry correctness | Exact fixture invocation and storage-operation counts, separately classified; no recursion; no sensitive labels; visible dropped/pending telemetry; measured event/invocation reconciliation on both real machines. |
| Operational readiness | Verified runtime/hooks on both machines; known credential item resolved; restore and compatible rollback demonstrated; documented error recovery and on-call/release owner. |
| Real continuity | Four completed real handoffs, covering analysis/code in both directions, with evidence and failures recorded. Reading a pack or displaying a reference is insufficient. |

Use monotonic durations for local stages. Keep occurred/observed/spooled/received timestamps distinct; compare wall clocks only with clock-skew checks. An offline machine has backlog age, not an online latency breach. Unknown heartbeat coverage stays unknown, and all excluded offline/unknown periods remain visible next to the online SLI.

## Weekly value report after release

Build this from usage/handoff tables and pinned Git records, with queries and versioned metric definitions. Do not change the historical audit's definitions silently.

| Question | Measure and denominator |
|---|---|
| Is retrieval reliable? | Successful logical retrievals / attempted retrievals; empty, unavailable, refusal, and timeout separately. Discovery recall only on adjudicated questions with known prior evidence. |
| Are teammates' agents benefiting? | Explicit references by caller author × source author, distinct source records, and sessions with a reference. Labels say agent-reported use. Separate sources created before the consuming session from self-created sources. |
| Is Neon actually read? | Intentional agent read invocations and their successful SQL reads; automatic brief reads separately; zero-row vs evidence-returning reads; capture/maintenance/telemetry excluded from consumption. |
| Is continuity used? | Pack delivered → claim/inspect/fork → bootstrap/evidence verification → delivered continuation → completed handoff. Show each stage and failure reason, analysis versus code, cross-person versus self. |
| Is capture healthy? | Online freshness, source-to-spool coverage on supported shapes, pending artifacts, backlog recovery, unknown periods, verified snapshots for code-eligible sessions. |
| Is it worth the overhead? | Median/p95 time from handoff request to first validated continuation result; failed/abandoned attempts; manual recovery minutes; measured agent tokens/time and Neon/Git operating cost where obtainable. |

Report the first post-release week descriptively. For ROI, compare several matched analysis/code tasks with and without Ledger under a predeclared evaluation protocol, controlling task difficulty and cache/context reuse as far as possible. Six matched task pairs are a small pilot, not statistical proof. Keep evaluation traffic out of ordinary adoption metrics. Do not translate references, commits, or saves into “hours saved.” Increased Neon query count alone is not success; fewer reads can be efficient if verified handoffs improve.

## NOT in scope

- A new database, vector search, or knowledge migration to Neon: discovery can be repaired inside the existing resolver and Git model.
- A dashboard product or full trace viewer: use the existing CLI/brief and an exportable weekly report until the metrics are trusted.
- A rewrite of classification or auto-acceptance: proposed state remains proposed; classifier runtime failure gets visibility and repair without changing authority.
- Blanket legacy-scope enrichment or recapturing all private transcripts: validate high-value records individually and respect existing capture permissions.
- Hosted MCP/OAuth/multi-tenant production: `src/http.ts` is a scratch-only, unauthenticated surface; keep its isolation. This plan does not authorize putting team data behind it.
- Public SaaS readiness, billing, and a wider client support matrix: these need a separate threat model and operational plan.

## Engineering choices and alternatives

1. **Discovery:** choose a separate candidate bucket; reject silently widening accepted scope because it trades false negatives for false authority. A wholesale legacy migration is slower and still needs individual evidence review.
2. **Capture:** harden the existing spool and Postgres path; reject Redis/Kafka/new queue infrastructure for a two-machine deployment. Versioned spool migration is necessary complexity because restart safety cannot rely on in-memory offsets.
3. **Binding:** use one-client transactions plus idempotency keys; reject increasing timeouts alone because a longer wait does not repair partial state.
4. **Telemetry:** instrument server outcomes/storage boundaries; keep transcript reconciliation for coverage. Reject treating lexical wrapper matches as executed calls.
5. **Release:** permit early pilot patches, but reserve “production ready” for passing durability and two-way handoff gates. A one-day patch cannot substantiate real-time continuity.

Use small shared helpers for transaction handling, availability envelopes, and usage emission; avoid one bespoke retry/timeout implementation per tool. Add inline state diagrams to the spool and binding modules. Keep configurable bounds with conservative defaults, and measure before increasing pools/concurrency.

Transaction implementation must keep all statements on the same checked-out client, per [node-postgres documentation](https://node-postgres.com/features/transactions). Use parameterized bulk insertion and existing unique constraints with carefully deduplicated input, consistent with [PostgreSQL INSERT semantics](https://www.postgresql.org/docs/current/sql-insert.html). Replace blocking child execution with asynchronous processes and consumed output streams, per [Node child-process documentation](https://nodejs.org/api/child_process.html). These references support implementation mechanics, not the unmeasured service targets above.

## GSTACK REVIEW REPORT

Scope: retained the user's four weakness areas and added the durability/operational checks needed to make the production claim meaningful. Ten code-grounded findings are mapped to eight implementation tasks. Architecture, code quality, performance, and test paths were reviewed; the companion test plan specifies failure cases and user-visible recovery. Existing tests were inspected, not executed for this documentation-only change. No application behavior changed.

Readiness: **NOT CLEARED for production**. The plan is actionable; all release evidence remains to be produced. Two critical current risks require explicit closure: spool/cursor crash recovery (F5) and artifact failure being acknowledged as missing output (F8). Other reliability gaps are captured in the task/test matrix. No proposed task is treated as an accepted product decision. No separate outside reviewer was run. Existing TODOs are referenced; no additional TODO-file scope was added.

| Review | Status for this plan |
|---|---|
| Engineering, plan stage | Completed with open implementation/release gates; 10 findings, two critical durability risks. |
| Architecture | F1–F4 and F10 mapped to explicit result, identity, transaction, and availability contracts. |
| Code quality | F5, F8, F9 mapped to durable state transitions, honest failure types, and shared normalization. |
| Performance | F6, F7 mapped to bounded bulk ingestion, fairness, and asynchronous snapshots. |
| Test review | Execution diagram and 31 failure/acceptance scenarios; existing coverage distinguished from required additions. |
| Implementation/adversarial diff review | Not run; there is no implementation diff in this change. |
| CEO/design/outside review | Not run; not a prerequisite for this bounded reliability plan. |

Review lanes: knowledge and continuity can start concurrently, with sequential integration of shared modules and a final release lane. No autonomous-agent speedup is asserted. A later implementation review must inspect the actual diff and test evidence; this planning review does not authorize a green shipping badge.
