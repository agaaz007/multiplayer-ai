The active pilot protocol is now [four-stage cumulative work](analytical-sequences.md): A produces, B continues and corrects, C performs related new work using A and B, and D applies later evidence while inheriting C's contribution. It adds a fresh-agent control and sequence-wide effort accounting. The runner documented below is the earlier single-handoff implementation. The four-stage protocol has its own dispatcher since 2026-09-10: `dist/eval/sequence-runner.js` (`prepare`, `smoke`, `run-all`, `report`; see the Runtime section of analytical-sequences.md).

This runner evaluates two distinct tasks: correcting and continuing an analytical investigation, and implementing a coding PRD from a teammate's unfinished source. Native capture is the primary protocol. Importing identical evidence is an explicitly labelled retrieval diagnostic. The selected competitors are Supermemory, GBrain and Graphify-Labs/graphify. Glean is deferred; `shared-doc` is optional and is not silently added to the selected arms.

No live competitive trial is included in this change. The contract tests use real local Ledger queries, a real subprocess MCP connection and Python SQLite; the Supermemory SDK transport uses test fixtures. Competitor selftests also run the installed Graphify 0.9.50 AST/query/save-result/reflect workflow without paid extraction. Those tests are implementation validation, not vendor-performance results.

Build and validate without models or cloud calls:

```sh
node_modules/.bin/tsc -p tsconfig.json --outDir .context/analytical-build
node .context/analytical-build/eval/analytical-selftest.js
```

Prepare the synthetic correction fixture:

```sh
node .context/analytical-build/eval/analytical-runner.js prepare \
  --out .context/analytical-correction-v1 --mode native
```

Preparation refuses an existing output directory. It freezes the task, controller build, dependency lock hash and oracle hash. The private oracle is written into a **separate controller directory**; the command prints its path for the evaluator. Its location is not included in agent/tool configuration or the run manifest. Keep that path outside agent mounts. Installed dependencies are lockfile-bound but not vendored byte-for-byte. An arm/harness execution plan freezes route, source stages, models and timeout **before assignment**, and rejects changed parameters within the same run.

`check --run <dir> --arm ledger` is local. Supermemory checks require both a credential and `--allow-export true`, otherwise no request occurs. GBrain readiness checks the installed binary and embedding credential; it does not mistake a keyword-only brain for a configured hybrid arm. A capture/plugin configuration is separate from a successful actual capture probe.

Native launch, after selecting explicit models and a paid-operation budget:

```sh
node .context/analytical-build/eval/analytical-runner.js run \
  --run .context/analytical-correction-v1 --mode native --arm gbrain \
  --harness claude --model MODEL_SELECTED_BY_USER --timeout-ms 600000 \
  --native-route eval/analytical-gbrain-native.example.json \
  --stages /absolute/path/to/reviewed-and-model-pinned-stages.json \
  --cost-policy /absolute/path/to/explicitly-authorized-cost-policy.json \
  --allow-paid true --allow-export true
```

The runner launches actual installed Claude/Codex subprocesses. It does not require a custom external agent driver and has no automatic model fallback. Source stages use fresh homes, then a fresh third-PM successor. Models and timeouts are explicit; global startup hooks/memory are disabled except for the selected native integration. Native route files may contain configuration placeholders (`NAMESPACE`, `HOME`, `WORKTREE`, `TRIAL_DIR`, `BUILD_DIR`, `GBRAIN_HOME`, `LEDGER_DIR`), but never API keys. Credentials come from the environment and are redacted from retained process output.

`--allow-paid true` alone cannot launch a trial. The required cost-policy JSON contains `authorizationRef`, `operator`, positive `maximumApprovedUsd`, `authorizedModels`, `enforcement: "operator-monitored-no-hard-cap"`, `acknowledgeNoHardDollarCap: true` and explicit `stopInstructions`. Its contents are frozen in the execution plan and copied into each attempt. Supply it only after the user authorizes that scope and monitoring arrangement. **This runner does not enforce a dollar ceiling** across Codex, Claude and native provider operations; the timeout is not a spending cap. If the user requires a hard cap, do not launch until an enforceable external cap exists. Raw model outputs are retained, but model and provider usage must be reconciled separately; missing cost is not zero.

Every origin/correction stage receives a different capture marker. Before successor launch the controller reads actual saved provider sources and requires **every marker**, then checks retrieval readiness. It never fills a native capture gap by importing the task's expected records. This establishes capture of the marker-containing source, not completeness of every query/artifact; the scored continuation, exact source audit and artifact coverage must establish that stronger claim.

Source-stage artifacts declare `availableFrom` and `access`. An origin cannot read a future correction artifact. A native successor cannot use `read_artifact` to obtain a `handoff-output`: it must recover those bytes through its provider. `shared-input` is reserved for genuinely common permitted inputs, such as the underlying dataset. The synthetic dataset is shared; the accepted query template is a correction-stage handoff output.

These are **tool access rules**, not a filesystem boundary. The controller's `task.json` retains complete source material, including future-stage evidence. A coding agent able to read parent paths could bypass tool filters or inspect another stage's home. A comparative grade therefore also requires explicit evidence that future evidence and other stages' private state were excluded from the actual agent context and reads.

Provider boundaries:

- **Ledger:** immutable neutral evidence can be imported into a disposable Markdown store for diagnostics. Native trials use actual Ledger MCP writes plus an isolated nonce-owned localhost continuity database, the real hooks/helper and a private bare Git remote. Each source's actual transcript/artifacts are captured; verified WIP snapshots are restored into the next fresh stage. A dirty stage without a verified snapshot, or a clean changed commit with no transferable native snapshot, fails closed. Exact database rows and artifact bytes are exported before owned database cleanup; snapshot Git objects remain for audit. Classifier/model extraction is explicitly disabled, so this tests raw native capture and actual source-agent record writes. Codex hook trust requires separate verification. Fixture helper tests alone do not prove live harness capture.
- **Supermemory:** official `supermemory` SDK 4.25.4. The controller reads `SUPERMEMORY_API_KEY`, mints a one-day single-container key using `/v3/auth/scoped-key`, and gives only that scoped key to Claude/Codex hooks, MCP and the diagnostic adapter. It revokes the key after the attempt while retaining captured evidence. The key ID (never the secret) is retained for revocation reconciliation. Preflight requires explicit 403 denials for synthetic foreign-tag search/profile requests and either a 403 or verified credential-scoped list projection, successful own-tag profile/search, complete paginated inventory, and settled processing. Original source documents must belong exclusively to the trial tag. Native capture preserves official plugin defaults; only project and personal tags are set to the trial tag. Actual source-byte capture plus native hybrid recall are required before successor launch. A scoped key fixes authorization boundaries only if the actual service and plugin traffic pass these checks.
  The SDK/list API documentation still exposes plural `containerTags`; our integration deliberately sends singular `containerTag` through the SDK extension method. A live two-container probe confirmed that listing projects only the scoped key’s documents even when a foreign singular filter is supplied (HTTP 200); cross-container get returned 404 and search/profile returned 403. The adapter accepts that projection only with verified response shape, tags and pagination. If the service cannot prove scoping/pagination, readiness fails. No plural or unscoped fallback is enabled. The source plugin may still attempt legacy-tag reads, which must be rejected by the service; review actual plugin traffic. Example: `eval/analytical-supermemory-native.example.json` (reviewed built hook paths and hook trust still required).
- **GBrain:** pinned CLI 0.18.2, `text-embedding-3-large`, 1536 dimensions. Requires `OPENAI_API_KEY` and explicit cost authorization. The runner exercises actual embedding and native hybrid retrieval in a **separate synthetic probe brain**, keeping the scored trial empty. Each scored store has an owned PGLite home and receives only its needed provider credentials, not production database pointers or Supermemory keys. Native `put_page` performs product capture; complete embedding coverage and actual native recall are required after source capture. This is agent-authored page capture, not automatic transcript capture. The installed model is disclosed, not silently replaced. Example: `eval/analytical-gbrain-native.example.json`.
- **Graphify:** pinned `graphifyy` 0.9.50 from Graphify-Labs/graphify. An explicit backend (`claude` or `openai`) and extraction model are required in the native route and cost policy. The scoped bridge writes agent-authored files, then calls official `extract`, `query`, `affected`, `explain`, `path`, `save-result` and `reflect` commands. It supplies no alternate extraction, ranking or correction algorithm. Graphify gets its own corpus, graph, feedback, cache and home; source paths and symlinks cannot escape the corpus. Extraction receipts bind backend/model, source hashes and graph hash, so changed files require re-extraction. AST-only checks never qualify semantic/analytical readiness. This lane tests the documented CLI workflow, not the skill's subagent workflow or automatic conversation capture. Count note preparation, feedback and extraction effort. Example: `eval/analytical-graphify-native.example.json`; replace the model placeholder before parsing/running it.
- **Shared document:** available as an opt-in diagnostic local document/search arm. A maintained native document workflow needs a reviewed route; no native capture is fabricated.

Each attempt has its own namespace, homes, source store, trace, assignment and observation. Provider errors and timeouts after an executable trial launches remain failed attempts in its denominator. Configuration/budget unavailability is retained as unavailable-before-launch. Fixture executability is frozen; an arm losing a required artifact never turns an executable fixture into an excluded missing-evidence case. Retries use new attempt IDs; an invalidation is an append-only sidecar, not deletion or replacement.

Importing the real source for either task is a separate explicit operation:

```sh
node .context/analytical-build/eval/analytical-runner.js import-task \
  --spec /absolute/path/to/approved-source-import.json \
  --out .context/approved-task.json
node .context/analytical-build/eval/analytical-runner.js prepare \
  --out .context/analytical-real-prd-v1 --mode native \
  --task .context/approved-task.json --oracle /absolute/path/to/frozen-coding-oracle.json
```

The import spec contains `task` metadata plus `evidenceFiles: [{file: <exact absolute regular file>, metadata: <EvidenceSchema except content>}]`. It reads only those listed files; it does not search the production Ledger or export a whole account. `provenance.classification` must be `approved-local-import`, with an explicit permission note, source refs and external-export permission. Obvious embedded credentials reject the import instead of silently redacting the source. The resulting task JSON has complete content and hashes when frozen; nothing is uploaded by import/preparation.

For a PRD, set `kind: "coding-handoff"` and `coding: {sourceRepo, commit, snapshotRef?, sourceRecord, sourceArtifacts}`. The full 40-character commit is mandatory. A supplied hidden WIP ref must still resolve to that exact commit; if it moved, prepare a new task instead of silently fetching new evidence. Rachit's source session was `01a08156-09f7-77f1-8bf0-c1d07b0c518a`, with full PRD browser artifact `e552ced7-6030-46f0-9424-df7729a52faa`. Its outer-repository WIP commit `1ce6fa161b7f81f88e7f885d3f23d06ac7aaf1fb` did not capture the nested app checkout; it is not evidence of a restorable unfinished app. The recovered PRD plus app baseline `61b8945693eea3a546123667616c937abea3a210` can support a clearly labelled reconstructed task. Confirm permitted full bytes and the appropriate incomplete base before importing. Do not use the already-completed `356bad7` or its added tests as an unfinished benchmark seed.

The SQL oracle executes submitted SQL independently on the visible fixture and hidden data perturbations, checks recorded execution, accepted definition and the exact affected-result set/paths. Read-only SQLite denies writes, attachment, extensions and multiple statements with row, instruction and time budgets. The coding oracle instead executes frozen argv build/test commands on the successor checkout, optionally introducing separate independent test files after the agent stops. It does not pretend SQL scores a PRD. The evaluator must freeze meaningful PRD coverage and verify that the incomplete source fails it before launching the trial; passing build commands alone does not prove PRD completeness or decision continuity.

A coding oracle command exiting 78 means `not-evaluated`, such as a missing independent candidate binding or manual review. This produces a retained `grade-pending-<id>.json`, never a pass, final comparative grade or attributed agent failure. Complete the missing grading work without changing the frozen expected behavior, record its file hashes and human review effort, then grade the same completed attempt. The private PRD oracle's binding must translate candidate behavior without implementing missing product behavior. Baseline-only success cannot establish PRD completion.

Grade with the separately retained private oracle:

```sh
node .context/analytical-build/eval/analytical-runner.js grade \
  --run .context/analytical-correction-v1 --trial /absolute/path/to/attempt \
  --oracle /absolute/path/to/private-controller/oracle.json
```

A private-oracle marker found in retained trial files invalidates the run. Without an independent isolation audit, grades are **diagnostic only** (`validForComparison: false`). `--audit <file>` must identify the attempt namespace/task hash and affirm `valid`, `startupContextReviewed`, `toolTrafficReviewed`, `negativeCanariesExcluded`, `futureEvidenceExcluded` and `otherStagesPrivateStateExcluded` after an actual evidence audit. A declaration is not evidence by itself. This implementation does not establish an OS filesystem enclave; coding harnesses can read outside their worktree. Production comparative claims require an independently verified boundary or the disclosed narrower audit evidence. Do not allow a reviewer to examine another arm's answer before their own trial.

`human-time --trial <dir> --entry <json>` accepts participant, phase, startedAt, endedAt and note. Phases are setup, capture, correction-validation, handoff, clarification, review and repair. Overlapping time for the same participant is rejected. Missing entries remain **missing**, never zero. Human effort must be reported for failures/retries as well as successes; setup, active time and wall time remain separate. The native track measures capture/maintenance effort; the imported diagnostic track cannot establish an end-to-end human-time advantage.

Official provider references checked 10 September 2026: [Supermemory add](https://supermemory.ai/docs/api-reference/ingest/add-document), [get](https://supermemory.ai/docs/api-reference/documents/get-document), [hybrid search](https://supermemory.ai/docs/api-reference/recall-search/search-memory-entries), [Claude plugin](https://github.com/supermemoryai/claude-supermemory), [Codex plugin](https://github.com/supermemoryai/codex-supermemory). GBrain command and health contracts were read from the installed CLI/source; no global brain configuration or contents were printed.

Clean comparison requirements (10 September 2026):

1. Freeze the same permitted source material, two separate tasks, independent oracle and source-stage prompts before assignment. Native arms receive evidence as it becomes available; no prepared Ledger answer export is used as their capture mechanism.
2. Within each harness direction, `comparison-*.json` fixes source-stage prompts/people/models, successor model, timeout and approved maximum spend across all arms. A mismatch is rejected. Graphify's separate extraction model must also appear in the cost policy and be disclosed with its provider usage. Product-specific capture instructions remain visible and their setup effort is counted.
3. Keep normal product capabilities/settings documented. Supermemory signal extraction is no longer disabled. The current Ledger local lane still disables its model classifier; that limitation must be reviewed/disclosed before treating results as a full-product comparison. Do not claim this transport/configuration work resolves that experimental-design choice.
4. Freeze the trial order/repetition plan before scored execution, keep graders blind to other arms, and retain failed/unavailable/retried attempts. Missing credentials or failed prelaunch probes are `unavailable-before-launch`, not incorrect task answers. Cleanup failure does not rewrite a completed task as an execution failure, but prevents comparative qualification.
5. A grade remains diagnostic until the original isolation checks and these audit fields are true: `equalPermittedEvidenceVerified`, `sourcePromptsModelsBudgetsMatched`, `nativeWorkflowConfigurationReviewed`, `captureEffortIncluded`, `blindIndependentGrading`, `providerCostsReconciled`. These are evaluator attestations requiring actual evidence, not automatic proof.
6. Log all seven human phases, including explicitly observed zero-duration phases: setup, capture, correction-validation, handoff, clarification, review, repair. Missing phases are not zero. Cost reconciliation includes source/successor models, extraction, embedding, capture, recall, probes, retries and review. Report correctness and total human time together.

Run local implementation validation with `npm run test:analytical-competitors` (Graphify 0.9.50 must be installed) and `npm run test:analytical`. These are not scored task trials. An authenticated readiness probe uses the existing `check` command with `--allow-export true --allow-paid true --cost-policy /absolute/path/to/approved-cost-policy.json`; Graphify additionally needs `--native-route /absolute/path/to/configured-graphify-route.json`. Credentials must already be exported into the launching process. Readiness does not choose a model/budget, create a real-task oracle, launch a successor, or prove a two-laptop handoff.

GBrain benchmark-only credential file:

Use `--gbrain-env-file /absolute/path/to/gbrain.env` on `run` or `check` for the GBrain arm. The parser reads exactly one `OPENAI_API_KEY` assignment as data; it does not source a shell file or modify the parent environment. The file must be owner-readable only (`chmod 600`). The adapter passes the key only to owned GBrain subprocesses. In native mode, the runner replaces the reviewed GBrain `serve` entry with a scoped launcher that loads the key inside that service process. Other competitor arms reject this option. Keep this file out of source control. This is process routing, not an OS sandbox against another process owned by the same account.

On 10 September, the supplied benchmark file passed a live call through GBrain's installed embedding function and a separate owned native save/embedding/hybrid-recall probe. No task-agent model or scored trial was launched. The native probe artifacts contained zero matches for the raw key. These checks do not verify the other competitors or establish full benchmark readiness.
