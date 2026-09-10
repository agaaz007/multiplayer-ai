# Exploratory cumulative-work pilot — protocol revision

Status: the user approved simulated A/B/C/D users on this laptop, approximately $20 total, real frozen HiAstro data for both tasks, and the C/D benchmark additions. The real task inputs and grading contracts are frozen in `.context/real-pilot-20260910/content-freeze.json`; see `docs/continuity/real-pilot-freeze-2026-09-10.md`. Runtime conditions and the four-stage dispatcher still require completion before launch. No scored sequence has run. The existing `analytical-runner.ts` implements a handoff experiment, not this four-stage protocol. Its results cannot establish cumulative team learning.

The hypothesis is that a fresh agent can complete new work correctly using contributions from multiple predecessors, with less reconstruction, and preserve its own contribution for the next recipient. This is an open hypothesis for Ledger, Supermemory, GBrain and Graphify. A product may succeed through files, conversations, graph retrieval or structured records. Score observable behavior, not a preferred storage representation.

## Runtime (implemented 2026-09-10)

The four-stage dispatcher is `src/eval/sequence-runner.ts` (built to `dist/eval/sequence-runner.js`). It runs one sequence per `(task, arm)` from the frozen content in `.context/real-pilot-20260910`, with the arms `ledger`, `supermemory`, `gbrain`, `graphify` and the `fresh-agent` control. Every stage is a fresh simulated user (`sim-user-a` … `sim-user-d`, distinct git identities), a fresh Codex `exec` session with its own home and workspace, inside the kernel-verified seatbelt from `sequence-isolation.ts`. Stage inputs are committed as the workspace baseline for every arm; for the coding task the pinned baseline tar is extracted, committed with fixed metadata, installed offline from the local pnpm store and `@beirut/shared` is built before the agent starts.

```sh
npm run build
node dist/eval/sequence-runner.js prepare --root .context/pilot-20260910 --content .context/real-pilot-20260910 \
  --limits eval/pilot-limits-2026-09-10.json --supermemory-route .context/competitor-readiness/supermemory-install/native-route.json \
  --supermemory-env-file <0600 file with SUPERMEMORY_API_KEY> --gbrain-env-file <0600 file with OPENAI_API_KEY> \
  --graphify-route .context/competitor-readiness/graphify-openai-native.json --ca-file .context/competitor-readiness/system-trust-public.pem
node dist/eval/sequence-runner.js smoke --root <root> --arm <arm>      # two-stage synthetic capture-then-retrieve check, unscored
node dist/eval/sequence-runner.js run-all --root <root> --concurrency 3  # all frozen (task, arm) sequences
node dist/eval/sequence-runner.js report --root <root>                  # report.json + report.md
node dist/eval/sequence-runner.js budget --root <root>
```

`prepare` freezes the runtime (a hashed copy of `dist`), the limits (`PilotLimitsSchema`), the prompt template, the provider versions/routes and the coding baseline check results into `manifest.json`, and opens the single shared allowance in `budget.json`. `run` refuses a changed runtime or content freeze.

What each arm gets, beyond the identical prompt, inputs, task tools and limits:

| Arm | Team store across A-D | Capture | Delivery to the next stage |
| --- | --- | --- | --- |
| ledger | owned local Postgres database + ledger dir + bare WIP remote (all created per sequence) | official hooks, helper transcript capture after each stage, WIP snapshot pushed to the bare remote; classifier off | MCP record/thread tools; the agent fetches the predecessor's snapshot itself with the resume bootstrap commands |
| supermemory | one container tag = sequence namespace, one scoped one-day key | official Codex plugin hooks (synchronous Stop flush) and native memory tools | recall hook and `search_memory`; documents are polled for processing up to `providerWaitMs` |
| gbrain | one PGLite brain, served outside the sandbox through a socket bridge | agent-authored `put_page` (embeds on write); controller runs `embed --all` only if coverage is incomplete | native `query`/`search`/`get_page` |
| graphify | one corpus + graph, bridge tools served outside the sandbox | agent-authored `graphify_write_source` + `graphify_extract`; controller extracts only if saved sources changed and the agent did not | `graphify_query`/`read_source`/`affected` |
| fresh-agent | none | none | none; each stage starts from the same ordinary inputs only |

Per stage the controller retains the prompt, the stage task, the Codex event stream and rollout, every MCP call with its result (`mcp-calls.json`), the stage tool trace, the submitted answer, the capture/indexing outcome, and for coding the exact candidate patch plus the baseline-compatibility check results. Analysis answers are scored with `gradeFrozenSequenceSql`; coding feature completion is not scored by the runtime.

Fixes made while bringing the runtime up (2026-09-10): the seatbelt policy emitted `127.0.0.1:5432`, which `sandbox-exec` rejects, so every isolation probe had been failing; `(deny process-info*)` made node and codex die with SIGTRAP at startup (CoreFoundation needs process info unless `__CF_USER_TEXT_ENCODING` is set, and even then only for some homes), so it was dropped; unix socket paths longer than 104 bytes were silently truncated by macOS and collided across stages; and the Ledger helper cannot snapshot a repository without a HEAD, so stage inputs are now committed before the agent starts.

Known runtime observations: Codex's websocket transport fails certificate validation inside the sandbox and falls back to HTTPS after four reconnect attempts per turn (recorded as stream errors, not failures); Supermemory's flushed session document can remain queued beyond the frozen 120-second processing wait, which is recorded as `processingComplete: false` and left for the next stage to find or not.

## Unit of evaluation

One sequence contains four fresh task-agent sessions, A through D. Run one sequence per product for each of two tasks: HiAstro investigation and Analysis-tab implementation. This gives eight product sequences and 32 task-agent stages. The fresh-agent control adds one four-stage sequence per task: ten sequences and 40 stages total, under the shared $20 allowance. Shared-document handoff is a distinct optional control, not a substitute for no accumulated context.

| Stage | Agent receives | Required output and reuse |
| --- | --- | --- |
| A — Produce | Frozen starting repository/data and initial task inputs | Executable initial result, findings/decisions, files and one explicitly unfinished step, captured using the product's normal workflow. |
| B — Continue and correct | Fresh identity/session, ordinary next-task inputs, new validation evidence, access to this product's accumulated store | Validate the applicable correction or constraint, finish the next step, and contribute a new independently checkable result or fix. |
| C — Build on it | Fresh identity/session and a different related task; no controller-written handoff summary | Complete an executable task whose acceptance criteria require distinct contributions established in A and B. Add a new result or feature that D will need. |
| D — Carry learning forward | Fresh identity/session, further raw evidence changing an earlier conclusion or constraint, and another ordinary task | Validate the change, use C's contribution, identify all affected work, update the executable result, and avoid reviving rejected or superseded claims. |

New evidence is introduced in the assigned stage only. A later timestamp is not acceptance. Either person's agent may accept after checking evidence; a separate human approval is not required. Include a plausible recent unaccepted proposal and unrelated active work to test scope and authority without rewarding recency alone.

## Two separate task sequences

The exact approved extensions and ordinary-input availability are now frozen in the real pilot's task files. They are benchmark additions, not historical Rachit requests. The following table describes their purpose.

| Task | A and B | C | D |
| --- | --- | --- | --- |
| HiAstro | A computes legacy logic within the frozen current-config cohort; B validates the canonical identity/current-config correction and establishes the full-window repeat-user rule. | Segment user-day conversion by config and repeat-window/one-day users; preserve SQL and an observational recommendation or justified deferral. | Narrow to the real ₹499 plan; identify produced all-plan work needing review for the new scope, preserving its historical validity. |
| Analysis tab | Reconstruct from the original PRD and pinned incomplete baseline; A prepares immutable briefs and B completes linked execution/review with tested retry and unknown-outcome behavior. | Add read-only comparison of saved brief revisions and linked run status. | Restrict comparison to completed linked runs at server and UI, preserving history, exact revisions and unknown QA values. |

Do not seed the coding trial from the already-completed implementation or its answer-revealing tests. Rachit's outer snapshot did not capture the nested app checkout; label any PRD-plus-baseline reconstruction. Do not invent historical discoveries to make the task dependency graph look complete.

## Matched conditions and native capture

Use `gpt-5.6-sol` through Codex for every task-agent stage, including the control. Freeze model/reasoning settings, prompts, ordinary inputs, source revision, tools, time/output limits, provider versions/configuration, processing wait limits, order and retry policy before the first scored stage. Product-specific extraction/embedding models are disclosed separately, with all usage included.

Each product gets the same starting evidence and the same opportunity to capture work while agents perform it. Retain each product's documented normal capabilities. Measure the effort required for explicit saves, indexing, repair and review. Do not import prepared Ledger records, add bespoke summaries between stages, copy omitted artifacts for a competitor, or tune capture after inspecting scored answers. Native capture gaps count as outcomes. Readiness canaries test connectivity in separate smoke stores; a missing scored capture marker must not prevent C or D from attempting work with what the product actually retained.

Each stage uses a distinct declared user identity and fresh session/home. Within a product sequence, only its accumulated team store and product-supported artifact transfer survive. Other products, future evidence, grading files, previous private homes and controller transcripts must be inaccessible or audited as excluded. A shared team store must actually support access by the selected identities; changing an author string alone is not a real cross-user access test. Simulated users require explicit labeling and approval. Different laptops and both harness directions follow as separate stress tests.

## Fresh-agent control

The control receives the same ordinary stage task inputs, permitted underlying raw data/documents and starting repository. It gets no accumulated findings, derived files, saved decisions, prior agent outputs or product memory, including from its own earlier stages. Each control stage starts independently. It may reconstruct answers from permitted inputs; measure that work. New raw evidence supplied at B or D follows the same availability schedule as the product arms. Never give the control a prepared solution to compensate for missing context.

Freeze an input-availability matrix before trials so that an impossible control is not mistaken for evidence of memory value. Report later-stage correctness alongside provenance-backed reuse and reconstruction effort. Correctness by itself cannot distinguish retrieval from solving the task afresh.

## Independent measurement

Freeze stage-specific executable oracles outside all agent contexts. Verify that the initial coding baseline fails the relevant checks. Use hidden data perturbations for SQL and independent behavioral tests for code. Keep graders blind to product identity and other answers where practical.

| Metric | Evidence and scoring |
| --- | --- |
| Correct completion | Per-stage executable result passes the frozen oracle. Preserve partial results, failures, timeouts and missing artifacts. Report sequence completion separately from individual passes. |
| Cumulative reuse | For C, independently verify at least one distinct contribution from A and one from B in the output or execution; for D, verify C's contribution plus correct treatment of changed earlier knowledge. Require actual retrieved/native artifact provenance and a substantive contribution, not a citation or random marker alone. |
| Repeated work | Annotate repeated queries, rediscovered constraints, recreated artifacts and redundant fixes from the full traces. Distinguish necessary validation from avoidable reconstruction using a rubric frozen before grading. |
| Repeated mistakes | Count stale conclusions, rejected proposals promoted to authority, wrong-scope reuse and regression reintroductions. Check affected-work precision and recall against the frozen dependency set. |
| Total effort | Sum human active minutes, agent wall time, tool work and provider/model cost across A–D, setup, capture, indexing, handoff, correction validation, review, repair, smoke checks and retries. Record missing usage as unknown, not zero; report subscription usage separately from incremental API charges. |

Central success criterion: C completes new work correctly using A and B's contributions with less reconstruction than the fresh-agent control, and D correctly inherits C's contribution while applying the later correction. If the control solves just as well with similar effort, report that. If another product compounds successfully, report that too.

## Budget and release gates

The user set approximately $20 for the entire pilot and approved simulated identities. Runtime stage limits, tool/output limits, processing waits, allocations and retry policy must be frozen in the execution manifest before launch. Charge costs to the whole pilot; do not reset the allowance per product, task, stage or retry. Reserve room for controls and review. Stop dispatching paid work when the remaining authorized allowance cannot cover its bounded operation; if costs or upper bounds cannot be established, stop for reconciliation.

The current runner's `CostPolicySchema` is authorization metadata with operator monitoring, not a hard dollar cap. It cannot enforce the preceding dispatch rule yet. A numeric choice alone is insufficient to launch this protocol: implement and validate sequence scheduling, stage input isolation, no-context control, per-stage grading, complete usage accounting and the budget gate first. Connectivity smoke tests are not scored stages.

Retain unsuccessful and unavailable sequences without replacing them with a better retry. Any permitted retry uses a fresh sequence namespace and counts toward total effort. One sequence per product/task is exploratory evidence, not statistical superiority or a competitive moat. The first report must state identity simulation, same-machine topology, capture configuration differences and missing measurements explicitly.
