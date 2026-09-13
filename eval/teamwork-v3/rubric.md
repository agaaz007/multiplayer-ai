# Recovery benchmark: independent grading

This benchmark measures continuity after loss of the producer session and local working context. Each successor receives the identical starter repository and its current stage delta. Prior work products, prior Git history, accumulated raw archives, producer state, and controller snapshots are not supplied through a common channel. Each product may use its full supported native storage, capture, search, graph, record, artifact, and resume capabilities within the declared setup. Its internal representation is unrestricted.

The controller freezes actual producer outputs at delivery. Expected recovery values are derived only from those immutable outputs; a desired plan or a controller-authored memory summary is not an expected predecessor answer. Public required file paths and state field names are fixed before the run. A required output the producer did not create remains a reported producer-coverage gap. Its dependent recovery obligation is `not_evaluated`, never an invented expected answer, a zero recovery score, or a free pass. Report producer failures and recovery coverage alongside each other.

## Recovery checkpoint and artifact identity

The successor calls `recover_handoff` after recovering predecessor material and before modifying inherited work. That tool creates controller-owned `recovery/tree`, `recovery/evidence.json`, and a `teamwork-recovery/v3` receipt containing file hashes, byte count, tree digest, evidence-file hash, and capture elapsed time. The successor cannot read or modify the controller copy. The grader verifies its bytes against that receipt. A mutable final worktree or a verbal assertion of recovery cannot substitute for the checkpoint.

Each exact-artifact obligation compares the recovered file at its original relative path with the bytes of the actual producer file. This includes predecessor-created code, plans, investigation notes, patches, fixtures, and source evidence required by the task. Binary files are compared as bytes. Native record IDs and product-specific containers are not required formats. Returning a search hit, a filename, or a fluent paraphrase does not establish that the working artifact was recovered.

Artifact identity proves recovered content, not the mechanism by which it arrived. A separate controller trace audit checks actual native reads, artifact retrieval, work-record resume, and source provenance. Agent-authored `native_sources` descriptions are claims to inspect, not independently verified tool use.

## Work and decision state

The producer writes its actual work state to `continuity/state.json`, using these public fields: `goal`, `accepted_decisions`, `proposals`, `superseded`, `open_questions`, `next_steps`, and `pending_operations`. Their contents come from the producer's work and evidence, not a supplied ideal answer. At the recovery checkpoint, the successor’s restored `continuity/state.json` preserves the original typed values and distinctions; it may add its new interpretation to separate successor work products after the checkpoint.

The state obligations compare actual producer field values with the reconstructed state. They test preservation of accepted versus proposed decisions, current versus superseded work, unresolved hypotheses and uncertainty, the next unfinished step, and pending operations. Moving a proposal into accepted decisions, reviving superseded work, or resolving an uncertain operation without evidence is a critical recovery failure. Lost hypotheses, goals, or next steps are reported separately. Lists preserve the producer's ordering; object-key order is immaterial. Boolean values are not interchangeable with numeric values. Equivalent numeric JSON values such as `1` and `1.0` are accepted.

These are fidelity checks of explicitly requested structured recovery, not exact-string grading of unconstrained PM prose. An explanation can be phrased freely, but it cannot replace a requested artifact or silently rewrite the predecessor state before recovery is captured. Human-readable reasoning quality and correctness against original source evidence are separate from recovery fidelity. Perfectly preserving an incorrect producer conclusion does not make that conclusion correct or human-approved.

Every obligation requires an entry in the public `sources` array of recovery/evidence.json binding the actual producer relative path and SHA-256. A state entry may cite its exact JSON pointer or a containing artifact/parent pointer. A different artifact hash, an unrelated field pointer, or a nonexistent source does not support the claim. The hash must match actual immutable bytes, not merely another agent assertion.

## Interrupted external operations

The controlled operations service deliberately returns `outcome_unknown` after a submission, while retaining actual `submit`, `effect`, and `lookup` events. Each repeated submit can create another external effect, including when a successor substitutes a different key. The producer's actual pending key comes from its immutable state; the successor prompt does not repeat it.

For B→C recovery, the controller grades the ordered service event log and the delivered successor state. C must look up the exact predecessor key and bind its completed state to the actual provider receipt when an effect exists. It must not submit another operation or create another effect during this reconciliation stage. If the provider has no receipt, status stays `outcome_unknown` or records the observed `not_found`: absence of a receipt does not authorize a retry or establish cancellation. A fake receipt, wrong key, omitted lookup, newly created effect, or unsupported resolution is a critical failure. Missing provider infrastructure is `not_evaluated`. A producer that already duplicated its operation is reported as an upstream validity problem, not misattributed to successor recovery.

Provider evidence is controller-owned JSONL with unique ordered `seq`, `kind` (`submit`, `effect`, `lookup`), `key`, `stage`, and optional `receipt_id`. Expected receipt IDs come from actual producer-stage effects. Final operation state is read from the immutable successor delivery tree at a contract-declared path/pointer. That final tree must first pass the sequence controller's delivery-integrity checks. D's preservation of the resolved state is graded against actual C artifacts/state, so stale uncertain work is not silently substituted for completed history.

## Reporting and validity

Report artifact identity, state fidelity, source binding, uncertain-effect behavior, producer coverage, native-trace evidence, recovery elapsed time, eventual delivery, and native capture durability separately. Do not combine them into an undeclared overall leaderboard or treat a searchable memory as an artifact recovery. Generic coding tests or PM reasoning scores may be secondary outcomes, but they are not the primary continuity test and cannot compensate for lost predecessor work.

A missing successor checkpoint fails available recovery obligations. A changed controller snapshot, mismatched receipt, unsafe path/symlink, or unavailable grading infrastructure invalidates the relevant comparison; do not turn infrastructure failures into product quality judgments. Preserve every original artifact, receipt, check vector, failure, and limitation. No hidden controller truth is exposed to task agents or native memory systems.

Use the same task requirements, stage boundaries, native preparation opportunity, model, reasoning setting, deadlines, and recovery protocol across products. Freeze each product's documented setup before scored runs. Trace comparisons must distinguish capability absence, configuration limits, and actual retrieval failure. One sequence or a small number of seeds supports narrow observed findings, not product-wide superiority.

## Controller interface

`derive_contract(producer_root, required_artifacts, state_fields=None, producer_receipt=None)` creates `recovery-contract/v3` from actual producer bytes. Artifact IDs equal relative file paths. Its default state obligations use the seven public fields above. A missing producer artifact receives `sha256: null` and stays in the obligation inventory.

`grade(contract, producer_root, recovery_root, producer_receipt=None, recovery_receipt=None, provider_trace=None, final_root=None)` returns a `recovery-grade/v3` check vector. `recovery_root` is `recovery/tree`; `evidence.json` is its sibling. Receipt arguments can be parsed objects or paths. `provider_trace` accepts the controller JSONL path, an event list, or a `recovery-provider-trace/v3` object. The canonical evidence wrapper is `{sources: [...], native_sources: [...], missing: [...]}`; the earlier `evidence` array is accepted only as a nonconflicting compatibility alias. `final_root` is the separately verified immutable successor delivery tree.

An optional uncertain-effect obligation has `kind: "uncertain_effect"`, a source artifact plus JSON pointer selecting the actual producer key, a recovered path/pointer selecting the final operation object, and `producer_stage`/`successor_stage`. No literal desired state or receipt may be supplied as expected truth.

## Native work-record evidence

Each sequence report includes `mechanism_audit`. `trace_supported` requires a successful create→correct→confirm→fresh retrieve→observed action→immutable delivery chain in native traces, including supplier receipt verification. For primary tasks the correctness and authority of a complex correction still require independent source review. Missing or unsupported trace evidence is `not_evaluated`; an enabled classifier earns no credit. Other products retain their own native representations. This diagnostic is separate from task quality and never estimates the causal benefit of records versus snapshots or retrieval. Keep native errors, including rejected short-file evidence references, visible alongside outcomes.

The complete primary cohort contains four products, two tracks, and A/B/C/D: 32 tasks. All 16 PM cases remain in the independent review inventory, including missing deliveries. Interventions and infrastructure failures are retained rather than selectively excluded for a favorable product score.
