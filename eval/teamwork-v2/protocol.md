# Protocol: engineering and product decisions

Status: executable local benchmark content/scoring kit. Live native adapters and isolation/readiness are a separate gate; no new paid benchmark is authorized by creating this kit. The original pilot allowance is not reset or assumed to fund an expanded matrix.

## Question and arms

Does a team using this product deliver better engineering work or better product decisions over several fresh teammates, and what total effort does that require? Ledger, Supermemory, Mem0, GBrain and Graphify are product arms. A fresh-agent/no-memory arm shares the same ordinary raw evidence and team repository. An optional shared-document control measures the incremental benefit over a basic handoff document. No score rewards a storage format, number of records, or tool vocabulary.

Keep engineering and PM leaderboards separate. A memory product does not change the underlying task model; this measures the combined agent/workflow outcome with a fixed model, not a vendor's standalone coding intelligence.

## Engineering: Dispatch, a durable delivery service

Use a dependency-free Python HTTP starter, SQLite for durable application state, and a controlled external delivery provider. SQLite is the fixture application's store, unrelated to the memory products' backing stores. No external customer or payment is contacted.

| Stage | Team task | Observable acceptance |
|---|---|---|
| A | Ship job creation/history with ownership, durable idempotency and payload conflict handling | Black-box HTTP tests, cross-owner denial, process restart, concurrent duplicate requests |
| B | Integrate delivery, including a request whose response is lost after the provider committed | Correct durable state; no duplicate external send; reconcile unknown outcome before any retry |
| C | Add a batch workflow and read-only status reporting using A's storage/ownership and B's execution/receipts | Mixed batch status, explicit missing IDs, isolation, exact receipts; GET cannot trigger delivery |
| D | Handle an urgent cancellation-policy correction: only pending work is cancelable; unknown work requires reconciliation | Old functionality still passes; correct cancellation boundaries; no reintroduced duplicate send or cross-owner access |

Agents may choose implementation details. Public API behavior is fixed. The primary run starts each successor with the previous stage's final code tree through ordinary team Git for every arm, including control. Do not reset competitors to the starter. Retain whether code was actually committed, submitted, uncommitted or test-verified; a controller-created checkpoint is labeled as such and identical across arms.

The interrupted-work stress variant kills B at a preregistered trigger before its final commit and gives C the last normal shared commit. Only the product's supported capture may recover uncommitted code. Run this as a separate outcome, with recovery source, missing operations and exact file hashes. Do not silently count this artifact-transport advantage as better reasoning in the common-Git track.

## PM: Relay onboarding investment and rollout

The PM track is a product decision sequence, not a SQL examination. Raw inputs include customer interviews, support notes, opportunity estimates, engineering capacity, experiment aggregates, a tracking audit, rollout observations, and a proposal from a different market. A spreadsheet, script, SQL or written calculation is equally acceptable. Evidence is synthetic and source-labeled.

| Stage | Team task | Judgment being tested |
|---|---|---|
| A | Prioritize onboarding versus exports versus notification tuning under a capacity constraint | Synthesis of qualitative/quantitative evidence; alternatives; opportunity cost; explicit uncertainty |
| B | Tracking audit changes what the apparent activation uplift means | Correct interpretation, preservation of historical results, revision of confidence and recommended experiment |
| C | Allocate the next sprint and set a bounded rollout/research plan using A and B | Feasible tradeoffs, evidence from both predecessors, owner/trigger/success and rollback criteria |
| D | Later rollout evidence crosses a pre-existing reliability guardrail; an unrelated team's expansion proposal arrives | Timely scoped decision update, respect for the actual guardrail, downstream impact, no proposal promoted to approval |

There is no required winner between feasible options. Automated checks score verifiable facts and hard constraints. Blinded reviewers score the reasoning, alternatives and consequences. A well-supported hold, bounded pilot or scoped investment can outperform an unsupported rollout. Low confidence alone is not good calibration; the uncertainty must change an action, research priority or decision threshold.

The raw source archive grows by stage and is available equally to all arms. Only derived memories, prior decision rationales and unfinished work depend on memory. This keeps the control solvable and lets us measure reconstruction cost. Add a source ablation only as a separately labeled recovery track, never as the primary comparison.

## Continuity stresses and controls

Core runs use fresh A/B/C/D sessions. Stress runs separately introduce: forced context compaction (confirmed by an actual harness event), an interrupted pending external operation, interleaved unrelated projects, and accepted corrections versus newer proposals. Long-history material must carry realistic relevance distractors and version changes; repeated padding is not a workload.

Native Ledger classification and capture should be enabled in its intended configuration for the full-capability track; compare classifier-off as a disclosed ablation. The old Ledger adapter hardcodes classifier-off and must not be advertised as this full-capability setup. Apply the same principle to each competitor's documented capture, processing, temporal and graph features. No custom controller-authored summaries, inferred decisions or repaired memories between stages.

All primary conditions get normal Git/artifact infrastructure, the same raw archive, tools, model, reasoning effort and stage budget. Vendor-specific configuration must be frozen before scoring. Separate a memory-isolation benchmark from business-scope correctness: a market label is not an authorization boundary.

## Delivery and time

An agent may call `deliver_answer` as soon as its useful result is ready, then finish native handoff within the same total stage deadline. Answer submission never requires a memory write. The immutable answer and engineering tree at submission are the graded deliverable; later files are retained as handoff artifacts but cannot silently replace the submitted solution. Record first-valid-delivery time, handoff-ready time, and full stage time separately. A submitted answer with failed handoff can pass delivery and fail continuity. No free post-deadline repair; normal automatic capture/indexing gets a preregistered bounded wait charged separately.

Use monotonic deadlines and process-group termination. If host sleep/suspension or a missed kill greatly exceeds the budget, label timing invalid and report the infrastructure failure. Keep the attempt and use only preregistered replacement rules; never relabel as a product timeout without the evidence. Missing usage stays unknown.

## Schedule and preregistration

Start with an unscored plumbing smoke for every arm, then one development seed to calibrate task duration and grader sensitivity. Freeze evaluated model/provider builds, packaged guides, raw inputs, prompts, budgets, processing bounds, grading code, reference artifacts and order before held-out seeds. Development smoke results cannot enter scored averages.

Suggested first scored screen: three paired held-out seeds per track/arm, four stages each. With six arms this is 144 model stages. Three seeds are an exploratory screen, not a significance claim. Expand cases and repetitions based on preregistered power/precision goals and approved spend. Rotate arm order within seed and track; run A-D in order inside each sequence. Keep results paired by scenario/seed, and report distributions and all failures, not the best attempt.

Seed 41 is a development seed and is excluded from scored trials. Seed variation changes PM evidence quantities and request identifiers; it is not a new independent product domain. The current kit has one core scenario per track. Broad engineering/PM claims require more scenario families and a separately held-out real-work case, not just more numeric variants of these two cases.

Freeze a fresh monetary allowance and per-operation upper bounds only when launching. Count model inference, extraction, embeddings, graph processing, native capture, setup and repairs. Subscription inference is reported as tokens/time separately. No universal dollars-per-document assumption; retain unreconciled reservations. Never present a hard cap unless every paid path is actually gated.

## Required live evidence

Each adapter must produce: an isolated sequence namespace; pinned native version/guide hashes; successful capture-and-retrieve canary in a fresh session; negative namespace read checks; full native tool request/result traces; workspace tree hashes; snapshot/commit provenance; delivery event with controller monotonic timestamp; capture completion/failure and duration; model usage; provider usage or reserved bound; and cleanup/export receipts.

The driver request contains only stage-visible input paths, the arm-native configuration, model/limits, and the isolated workspace. It must not expose expected answers, grader source, future stages, other arms, administrator keys, or the full pack directory. Launch only after kernel/container isolation checks have actually passed. Readiness assertions in a JSON file are audit input, not proof; retain the probe artifacts and hashes.

## Reporting

Report engineering behavioral acceptance and PM factual checks separately from blinded judgment and continuity. Verify claimed reuse with producer artifact, actual successor retrieval, and a substantive output contribution. Citation strings and canaries alone are not substantive reuse. Count necessary revalidation separately from avoidable reconstruction. Report actual scope/authority errors and exact affected-work inventory; no penalty for missing an output the predecessor never produced.

The final comparison must state where each system helped, what it failed to preserve, and whether any advantage survives ordinary Git/raw-document controls. Do not produce one overall winner by averaging unrelated engineering and PM scores.
