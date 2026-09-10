Ledger analytical reuse plan — 10 September 2026

Status: original planning snapshot, followed by authorized implementation. The user approved implementation, agent acceptance after evidence validation, separate analytical and coding-PRD tasks, and a native-capture comparison of Ledger, Supermemory and GBrain. Glean is deferred. The shared-document baseline, exact HiAstro case and paid-run budget/model remain pending. Those decisions override the original proposals below. See [implementation status](analytical-reuse-implementation-2026-09-10.md) and the [runnable benchmark protocol](../../eval/analytical-benchmark.md). The historical observations below describe HEAD 230eddf76de543059a80d2a38f4b08284d1ee97d plus the then-existing uncommitted changes; they are not a description of the final implementation or a deployed client.

**The outcome to earn**

Agaaz investigates a HiAstro conversion question in Codex. Rachit checks it in Claude, establishes that the denominator is wrong, and records an evidence-backed correction. A third PM's agent retrieves the accepted correction, completes an outstanding analytical step using the right query and artifacts, and identifies previous results that need review.

Success requires changed execution and a reproducible result. Conversation recovery, a correct citation, saved-event counts and faster answers cannot establish that success on their own.

Narrow the product to this workflow inside existing Claude/Codex tools. Keep the four knowledge types, existing work records, Git and Postgres. Defer workrooms, dashboards, role onboarding, a general review inbox, a new graph database and broad coding benchmarks. A CLI/MCP correction review and affected-results list are enough for this pilot.

**What is known now**

The earlier audit remains a source, not a substitute for current verification. This planning pass inspected source and ran small in-memory capture probes; it did not replay original sessions, test production permissions or run a fresh laptop handoff.

| Issue | Current evidence | Boundary |
| --- | --- | --- |
| A draft hides accepted knowledge | src/store.ts:497 unconditionally deprecates a supersedes target, including draft persistence at :565. | Source-confirmed mechanism; Rachit's earlier finding reports an isolated CLI reproduction. No new live-store reproduction in this pass. |
| A proposed work-state update hides a confirmed update | src/continuity/records.ts:459 and recordpack.ts:159 suppress a predecessor for any non-rejected superseder. src/selftest-records.ts:290 asserts this behavior. | A second authority defect in work records, separate from knowledge-object persistence. |
| An unrelated save clears outstanding capture | src/hooks.ts:135 clears all query entries preceding any record or skip; extract.ts:84 then sees no debt. | Reproduced in memory against the existing build, with matching source checked. Not a fresh desktop-hook test. |
| Old evidence can disappear before retrieval | transcript.ts:266 keeps the final prompt characters; classify.ts:247–281 trims old events and :427 advances past them. Candidate records are capped and mostly limited to recent open work. | Long-transcript evidence loss reproduced in memory; classifier behavior source-traced. Raw omitted classifier events can remain stored, but ordinary subsequent classification skips them. |
| Resume can omit the actual latest events | recordEvidence sorts oldest first before a 2,000-event limit; recordpack selects its tail from that limited set. | Source-confirmed algorithm; not proof this affected the user's particular answer. |
| Search lacks analytical scope and accepted-lineage resolution | query.ts:50 searches all history lexically, then breaks ties by recency. Brief findings are recent and capped; decision count is capped. Tags are its available scope filter. | Search is not literally “latest only.” The combined pipeline provides plausible mechanisms for the symptom, not a traced diagnosis of one answer. |
| Impact analysis lacks exact dependencies | schema.ts:108 stores optional metric-name strings in definitions_used; work packs check only direct Ledger refs and do not verify their supplied version. | No reliable reverse/transitive correction-impact computation follows from these fields. |
| Saved events do not ensure a runnable query | events.ts:154 retains shortened request summaries; full artifact storage is applied to outputs. A native analytics call was detected while its exec-wrapped equivalent was not in a local probe. | Live host delivery can differ and needs testing. Source summaries cannot stand in for exact input bytes. |
| Earlier comparison cannot establish superiority | The evaluation report documents startup-hook contamination. The later real handoff report has no classified work records, keyword-only GBrain and temporal mistakes in both conditions. | Later isolation work is useful infrastructure; it cannot repair earlier contaminated observations. |

Local evidence: [.context capture probes](../../.context/capture-audit-2026-09-10.md). Historical reports: [handoff evaluation](handoff-evaluation-2026-09-09.md) and [real Rachit handoff](real-rachit-handoff-2026-09-10.md). The probe file is local and gitignored; copy its synthetic commands and outputs into the regression PR before using it as shared evidence.

**1. Freeze the workflow and failure cases before changing behavior**

Select one real analytical question and a permitted, reproducible dataset snapshot. Independently verify what denominator is correct for that question. The example is a scenario to prove, not evidence that a particular HiAstro result is already wrong.

Capture the original query, parameters, result, unfinished next step, correction evidence, reviewer action and affected prior findings. Use synthetic or approved sanitized fixtures for adversarial variants. Freeze expected outcomes before running successor agents; keep the grader and answer key inaccessible to them.

Define “scope” in two layers:
- Access scope: which organization's sources this person is allowed to retrieve. Enforce this at retrieval and artifact access, not through an agent instruction.
- Analytical applicability: product, dataset/environment, metric identity, population/cohort, grain, window and attribution rule. An authorized Android result may still be the wrong evidence for an iOS question.

A work record identifies an investigation; a repository or session does not define analytical applicability. Carry recorded time and effective time separately. Distinguish a correction to past work from a valid new definition for future work.

Record current behavior as failing regression cases. Do not change their expected answers to accommodate implementation outputs.

Deliverable: a small source fixture, a dependency oracle and a test contract. Exact pilot metric definitions are proposed below and must be registered before benchmark numbers are reported.

**2. Preserve accepted knowledge through proposals, corrections and sync**

Implement a shared accepted-state contract for knowledge objects and work-record projections.

A proposal or fallback draft can challenge an accepted object but cannot hide it. Only explicit acceptance of a valid replacement can change current accepted state. Rejecting a proposal leaves current state unchanged. Preserve original evidence and every acceptance/rejection event.

Acceptance must identify the accountable human, supporting evidence, target definition and applicable scope. For the pilot, use the existing metric owner or a designated reviewer; do not build a role-management product. Verify the actor through the configured identity boundary, not an arbitrary model-supplied author field. Agent actions follow that person's delegated authority.

Validate replacement target existence, compatible type and metric identity, applicable scope, absence of cycles, and expected predecessor/revision. Accept against an expected version so two laptops cannot silently overwrite each other's resolution. If separate offline branches accept competing replacements, expose the unresolved conflict after sync; do not choose by timestamp.

Keep proposed, accepted, rejected, superseded and needs-review meanings distinct. Acceptance means reviewed authority for this scope; it does not establish objective truth. A supported later challenge must be visible and actionable.

Start with the narrow persistence/projection guards and correct the existing test that rewards hiding confirmed state. Preserve the current storage architecture. Represent acceptance and supersession history explicitly and project current state consistently across search, brief, get and resume. Git is the knowledge source; any derived index must identify the source revision it reflects. A stale or incomplete index must not claim it resolved the latest accepted correction.

Before migration, generate a report of existing draft-to-stable supersession links and ambiguous competing branches. Repair only unambiguous cases through a recorded migration that preserves history. Review ambiguous cases rather than guessing which answer to restore.

Gate: accepted knowledge remains visible during proposal, rejection, restart, sync and concurrent replacement tests. Direct retrieval of an older object preserves its bytes and points to the applicable accepted correction or unresolved conflict.

**3. Make capture obligations correspond to the work actually captured**

Replace the session-wide “anything was saved” watermark with stable evidence IDs and explicit coverage.

Each relevant query/execution creates an obligation. A finding covers specific query IDs or validated analysis spans and their artifacts. A save for investigation B cannot satisfy investigation A. A definition or decision does not automatically discharge findings owed for unrelated queries.

Track durable local capture, relevant knowledge recorded, explicit dismissal with reason, pending review and remote publication independently. A fallback draft may mean evidence was captured but still needs review; it must not mean the investigation has an accepted finding. Failed saves/skips leave obligations outstanding. A local successful save can acknowledge local recording while remaining visibly unsynced.

Unify native and wrapped call normalization across hooks, fallback and continuity capture. Use structured success receipts and stable call identities; reconcile new unresolved evidence after restarts instead of treating the whole session as permanently reconciled.

Store permitted full query/parameter inputs and referenced files as content-addressed artifacts. Store source hashes before display truncation. A reproducibility manifest binds query, parameters, dataset snapshot/window, result, definition revision, artifact hashes and execution outcome. Redacted, missing, truncated or unverified material must remain labelled; do not promise that every transcript is executable.

Process oldest unprocessed events in bounded pages and advance only through material actually processed. Keep prompt/result/event relationships. Do not discard old queries while retaining only conclusions, or silently move a classifier cursor beyond omitted events.

For this analyst workflow, support explicit query/notebook attachment from a different working directory. The nested Analysis checkout demonstrates why a snapshot of the session's outer repository is insufficient. Do not expand scope to automatically uploading every nested checkout. Verify artifact restoration remotely, including offline upload retry without further file changes.

Gate: A+B queries followed by an A-only finding leave B outstanding through compaction/restart/fallback. Long SQL retains a denominator filter after character 4,000. Both harnesses' real emitted call shapes create equivalent evidence obligations.

**4. Pin dependencies and turn corrections into explainable review**

Each finding must refer to the exact definition version it used, its query/artifact versions and any prior results it relies on. Retain friendly metric names for humans; names alone cannot establish lineage.

Use a small typed relation set: uses-definition, derived-from, based-on and supersedes. Validate endpoints and source versions. Existing Git records and a derived Postgres index can support reverse traversal; this does not require a new graph database.

A correction carries:
- The original mistake and supporting evidence.
- The corrected definition and executable query.
- Its acceptance, scope and effective interval.
- Whether it changes historical interpretation or only future analyses.

An accepted historical correction triggers direct and transitive dependency traversal. Return affected findings, decisions and work records with a path explaining each inclusion. Mark them needs-review; preserve their old numbers and evidence. Dependency does not automatically prove that every downstream conclusion is false.

A reviewer can record “recomputed with changed result,” “revalidated unchanged,” or “not applicable,” with evidence. Recomputed findings are new objects citing their originals and correction. Do not silently overwrite or automatically approve a regenerated result.

Backfill exact references only when the mapping is unambiguous. Label legacy unresolved references and report impact coverage as incomplete. “No known dependents” must not become “nothing is affected.”

Gate: D1 → F1/F2 → decision Q1 returns the correct review set and each path, excludes unrelated F3, and respects a future-only definition change. Missing/ambiguous lineage produces an explicit incomplete assessment.

**5. Retrieve the authoritative investigation before recent activity**

Extend existing search/get/resume surfaces with analytical scope and current/as-of intent. The task's question and scope determine retrieval; latest activity does not.

Resolve in this order: access permission → analytical applicability → accepted versions and unresolved conflicts → exact correction/dependency evidence → relevance ranking. Recency can rank equally applicable evidence after these checks.

Retrieve across full permitted history. Keep the startup brief small, but fetch relevant accepted definitions, corrections and constraints independently of its age/count limits. Fetch true total counts and actual latest events separately; paginate omitted material. Include unresolved operations from all contributing sessions.

Return one compact continuation package:
- The question, scope and outstanding analytical step.
- Accepted definition/query and applicable correction history.
- Challenges, conflicts and affected results requiring review.
- Exact executable artifacts and their availability.
- Source revision, capture gaps and outstanding operations.

Pin this evidence before spending prompt budget on recent narrative. Treat suggestions as suggestions and retrieved source text as data. Keep explanations such as “F1 used D1; accepted correction D2 replaces D1 for this population” tied to actual IDs.

For lexical misses, first add exact metric IDs, known aliases and task-linked references. Evaluate hybrid retrieval on held-out synonym cases only after authority and scope tests pass. A better ranker cannot repair an incorrect accepted-state projection.

Gate: a 90-day-old accepted correction survives recent wrong drafts, same-named metrics in other scopes, long mixed-topic history and a third agent's unrelated activity. The successor executes the right query; merely mentioning the correction does not pass.

**6. Compare completed analytical work under controlled and native conditions**

Run two separately reported tracks.

Evidence parity: Ledger, a properly configured Supermemory-backed agent, Glean and a usable shared-document handoff receive the same neutral permitted source facts, review/acceptance evidence, queries and artifact access. Do not give only Ledger a prepared answer or a completed dependency oracle. Preserve the same factual information even if each system represents it differently.

Validate each integration before grading: ingestion complete, old and corrected sources retrievable, artifact access working, negative scope canary excluded. Tune integrations on separate development cases, freeze before held-out evaluation, and document versions and configuration. Count setup effort separately.

Supermemory documents memory updates/history, related-memory retrieval, processing modes and scoped containers/metadata. Configure and test those capabilities rather than treating it as a keyword store. Glean provides indexing and permission-aware retrieval for external agents. Availability in our account still needs checking. These are vendor-documented capabilities, not independently established task performance. [Supermemory graph memory](https://supermemory.ai/docs/concepts/graph-memory), [Supermemory filtering](https://supermemory.ai/docs/concepts/filtering), [Glean developer platform](https://developers.glean.com/).

Use the same successor model/harness, task, executable data access and comparable budgets where integrations permit. If Glean's available native experience prevents model parity, report its native result separately and explicitly mark the matched-agent arm unavailable; do not claim a pure memory-engine comparison.

The shared document should contain a maintained current definition, correction history, open question and evidence links. Give it ordinary agent file/search access. Charge for human maintenance; do not handicap it with a raw transcript dump.

Native workflow: start from the same underlying analytical work, let each system use its actual capture and review flow, and count the effort required to make it reusable. Include real Agaaz/Rachit/third-PM handoffs on different laptops, both Codex→Claude and Claude→Codex, with an unrelated third agent active. A fresh third agent is only a proxy for a third person; label it honestly. Keep this field evidence separate from controlled fixture results.

Include a second continuation after the third PM saves a new result, then a further evidence-backed correction that affects that result. A fresh recipient must inherit the updated review state and complete the next step without resurrecting either corrected mistake. This checks accumulation across multiple cycles; a single successful handoff cannot establish sustained team learning.

Pilot scope: six scenario families × four arms × two fresh successor harnesses, up to 48 evidence-parity trials if all four arms support the configuration. Freeze the actual arm/harness matrix after readiness checks and before grading; publish unavailable cells and per-cell denominators. A native Glean run cannot fill a missing matched-agent cell. These remain six underlying cases, not 48 independent investigations. Changing the successor harness alone does not demonstrate both complete origin→correction→recipient harness directions; test those explicitly in the native workflow. Cover:
- Older accepted correction followed by a newer incorrect draft.
- Effective time differing from ingestion time and an old relevant source.
- Product/platform/cohort collisions.
- Direct/transitive dependencies with unaffected controls.
- Missing artifacts or unsupported correction evidence.
- An unrelated save that leaves relevant capture unfinished.

Each scenario retains an unfinished analytical step. Freeze whether each fixture is executable before assignment. If permitted runnable evidence exists in the fixture but an arm loses it or cannot retrieve it, that trial remains in the joint-success denominator as a failure. Intentionally unavailable evidence receives a separate safe-handling score; correct handling is a diagnostic pass, not a completed investigation. An unsupported proposed correction can still be executable using the older accepted definition. Report unresolved/blocked tasks separately and include their human effort.

Freeze prompts, product builds, guides, source artifacts, acceptance evidence, model configuration and grading before launch. Use fresh stores, sessions and credential scopes; inspect actual startup context and retrieval traffic with positive/negative canaries. Keep answer keys outside agent mounts and credentials. Randomize order, blind reviewers and retain complete traces. Prevent recipients from seeing another arm's answer before their trial. Contamination invalidates the affected comparison. Preserve invalid attempts and all retries; never silently substitute a cleaner result.

Before launch, set a readiness deadline, per-trial wall-clock and tool budget, allowed human intervention, and total spend ceiling using separate development cases. Publish those limits with the frozen protocol; they are not chosen after seeing scores. A quota error remains a failed assigned trial without a substitute model. Contamination pauses affected launches until isolation checks pass again. A critical error blocks promotion of that build. Fixes produce a separately identified run, not an improved aggregate assembled from earlier passing cases.

**Metrics and decision gates**

These are proposed definitions for registration before measurement, not measured outcomes.

| Metric | Definition |
| --- | --- |
| Correct continuation | An independently reproduced, correct next analytical result using the permitted dataset, scope, query and artifacts. A citation or prose-only answer is insufficient. |
| Correction adherence | Executed query and final conclusion use the accepted applicable definition; no outdated conclusion is presented as current. |
| Impact accuracy | Precision and recall of affected record IDs against the frozen direct/transitive dependency oracle; grade each path and review status separately. Report missing references and unavailable lineage. |
| Joint task success | All three deliverables above pass in a fixture declared executable before assignment. Denominator includes all valid assigned executable trials, including arm-caused capture/retrieval failures, provider errors and timeouts. Invalid contaminated trials are listed separately and cannot support comparison claims. |
| Critical error count | Accepted knowledge hidden by a draft, out-of-scope evidence treated as authority, a corrected error revived as current, or a material affected result falsely declared safe. Any one blocks the pilot gate. |
| Recurring human effort | Sum active person-minutes across capture, correction validation, handoff preparation, recipient clarification, review and mistake repair. Include failures and retries; report all assigned tasks, not just successful ones. |
| Repeated investigation | Previously completed, reusable steps needlessly repeated, distinguished from required correction validation or new analysis. Grade against the frozen task history. |
| Supporting measures | Wall-clock task time, provider/tool cost, blocked/invalid attempt counts, artifact availability and unresolved capture/review debt. They do not replace correctness. |

Measure active time with a lightweight shared task timer and phase log. Separate one-time installation from recurring effort, and report both; any amortized total states its assumed number of handoffs. Benchmark-only grading and experimental setup are not product-use time. Report correctness beside effort so fast incorrect answers cannot win.

Foundation gate: all deterministic authority, scoped-obligation, artifact and dependency regressions pass. This demonstrates the tested invariants, not a production reliability percentage.

Pilot gate: no critical authority/scope errors, correct execution of the denominator correction, and complete identification of critical affected findings. Fix the workflow if this fails; defer expanded UI.

Value gate: use matched tasks in the native-workflow track, charging every arm for capture, document/memory maintenance, correction, handoff and review. Predeclare a material threshold, proposed as at least 20% lower median recurring human effort than the shared-document baseline, with no observed correctness regression. Evidence-parity ingestion is experimental preparation; that track primarily measures correctness and recipient retrieval/continuation effort, not end-to-end capture savings. Compare against the best configured competing product too; beating documents alone does not establish competitive differentiation. The 20% value is a proposed business target, not an observed improvement or statistical standard.

Six cases and a small field pilot guide implementation decisions. Report paired per-case results and uncertainty; do not call assertions or repeated harness runs independent investigations. Use pilot variability to size a fresh held-out confirmation study and preregister the competitive comparison before making superiority claims.

Continue product investment when real teammates repeatedly complete work correctly with less total effort. If all approaches are similarly correct and require similar effort, the foundation works but differentiation remains unproven. Consider a lighter shared-document workflow or Ledger as an integration if it achieves the same result with less maintenance.

**Delivery order and boundaries**

| Increment | Concrete reviewable deliverable | Depends on |
| --- | --- | --- |
| A | Frozen denominator workflow, authority/capture failing tests, baseline protocol | Source review and permitted fixture |
| B | Accepted-state persistence/projection guards, conflict rules, repair report | A |
| C | Evidence-scoped obligations, normalized calls, exact query/artifact capture, incremental reconciliation | A; align IDs with D |
| D | Versioned analytical scope/dependencies and correction impact output | B; shared schema contract with C |
| E | Scoped continuation package and full-history retrieval fixes | B/C/D |
| F | Isolated four-arm pilot, then separately reported real handoffs | E and competitor readiness |

B and C can proceed in parallel after the evidence/scope contract is fixed. Each increment includes focused regression tests and migration compatibility. Review and merge in dependency order; do not bundle a dashboard redesign into the correctness work.

The first implementation PR should address the two draft/proposal authority failures and unrelated capture acknowledgment, with explicit evidence identities and failing tests turned green. Keep wider schema backfill and retrieval changes in subsequent reviewable PRs if combining them makes the first change unsafe.

No live history repair, paid-service setup, new company access grants, deployment or benchmark performance claim is part of this planning turn. Existing MVP direction already prioritizes cross-agent investigation continuity; this proposal sharpens its acceptance criteria. The earlier broad continuity kit remains regression infrastructure. Adopting this plan would require explicitly revising its role as the primary product-success benchmark rather than silently rewriting the decision history.

Relevant Ledger sources:
- fnd-20260910-current-source-audit-identifies-authority-eviden-22pi — this pass's bounded source inspection and synthetic probes; committed and pushed. The implementation plan remains proposed.
- fnd-20260909-triggered-ledger-audit-reproduces-premature-draf-cga6 — reported audit, with original reproduction boundaries.
- dec-20260907-make-cross-agent-investigation-continuity-the-le-s7qw — existing outcome criterion.
- dec-20260908-add-a-work-records-layer-above-threads-keep-post-cqr7 — existing records/storage direction.
- dec-20260908-adopt-the-continuity-evaluation-kit-as-the-accep-xxm4 — prior benchmark direction to revisit if this plan is adopted.
