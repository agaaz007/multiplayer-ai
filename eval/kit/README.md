# Ledger continuity evaluation kit

Measure what a fresh successor can recover and correctly do after a handoff.
This is a runnable fixture generator, adapter runner and evidence scorer. The
real Ledger adapter is **not connected**: only specifications and implementation
status documents were available when this kit was built. Its included adapter
returns `skipped`. Evaluator unit tests do not measure Ledger or model capability.

Python 3.9+; standard library only. Run commands from this directory.

## What the levels mean

These are project-specific acceptance levels, not an industry certification.
Each level requires every case at that level and all lower levels to pass.
Individual case results remain visible even when a lower level blocks the total.

| Level | The successor demonstrates | Cases |
| --- | --- | --- |
| 1: Decision continuity | Recovers constraints, rejection reasons and current decisions; preserves unresolved disagreements, including when the evidence is buried | D01–D04 |
| 2: Selective continuity | Retrieves one topic from an interleaved session and joins relevant evidence across sessions | R01–R02 |
| 3: Executable continuation | Recovers exact saved files, handles uncertain external outcomes and completes a small unfinished task | E01–E03 |
| 4: Team coordination | Handles competing claims and stale uploads while a third agent keeps working | C01–C02 |
| 5: Sustained continuity | Preserves a middle-of-history constraint across resets within a boot context budget; exposes classifier lag | L01–L02 |

`0` means **no level verified**, not no capability. `not_run` and `unverified`
never count as passes. A failed assertion means an observed mismatch; an adapter
error means the test could not establish the result. Both block qualification.

The pilot matrix is 13 cases × two handoff directions × three independent trials
= **78 trials**. This is an acceptance gate, not a reliability estimate. Report
results for the tested model, harness versions, Ledger revision and fixture size.

## The cases

| ID | Scenario | Pass evidence |
| --- | --- | --- |
| D01 | A standing ₹199 price instruction and rejected whole-card animation sit in the middle of a session | Correct values and reasons, with retrieved source evidence |
| D02 | A newer confirmed metric definition supersedes an older accepted one | Current definition and explicit supersession |
| D03 | Teammates report 8% and 100% on different dataset snapshots | No fabricated accepted rate; source-backed unresolved status and next check |
| D04 | One history holds a corrected number, a rejected option, and a filter nobody called an assumption | The corrected number, not the first; the retired option with its reason; the population the number actually covers |
| R01 | Paywall, hiring, attribution, copy and evaluation share one session | Paywall selected by topic; correct constraint and unfinished action |
| R02 | Two people contribute to the same work across Codex and Claude | Both contributors' relevant setup and unfinished validation recovered |
| E01 | Origin edits a tracked file, creates an included untracked file and deletes another | Exact hashes in the recovered worktree, deletion preserved, next action correct |
| E02 | An external create operation succeeds, but its response is lost | Successor checks existing outcome without repeating create |
| E03 | A saved layout configuration still violates its required bottom margin | Actual final file preserves price and passes independent numeric checks |
| C01 | Two successors claim one thread, then the old contributor uploads | Exactly one claimant wins; higher generation; head preserved; stale event accessible on a fork |
| C02 | A third agent works in another worktree during the handoff | Its unrelated sentinel remains intact and it continues making progress |
| L01 | Long history, a buried standing constraint and at least three resets | Correct source-backed answer, measured history size and bounded boot context |
| L02 | Raw capture advances ahead of classification | Lag disclosed; relevant unassigned work visible and preserved after another pass |

The miniature layout task gives an independently checkable execution outcome.
It is not a browser, Android, build-system or environment-restoration test.

## Run locally

```bash
python3 -m unittest discover -s tests -v
python3 continuity_eval.py prepare --out /tmp/ledger-eval-suite
python3 continuity_eval.py run --suite /tmp/ledger-eval-suite --out /tmp/ledger-eval-smoke --adapter adapter.example.json --directions codex-to-claude --repetitions 1
```

With the template adapter, this deliberately produces 12 **not-run** results.
It verifies CLI/report plumbing, not continuity. Use fresh output directories;
the runner refuses to overwrite an existing observation.

Wire `collect_trial()` to the actual repository and local harnesses as described
in [ADAPTER.md](ADAPTER.md). The runner invokes its configured argv without a
shell. It does not require a web UI, hosted agent execution or a new datastore.

Then run the complete pilot:

```bash
python3 continuity_eval.py run --suite /tmp/ledger-eval-suite --out /tmp/ledger-eval-live --adapter adapter.example.json --fail-under-level 3
```

The example gate requires decision, selective and executable continuity in both
directions, all three times. Choose level 4 before relying on concurrent shared
work, and level 5 before relying on the tested long-history behavior. A normal
report command exits 0 if report generation succeeded; `--fail-under-level`
returns 1 if the full pilot matrix does not demonstrate the requested level.

If you already collected observations, score without launching agents:

```bash
python3 continuity_eval.py score --suite /tmp/ledger-eval-suite --out /tmp/ledger-eval-live --fail-under-level 3
```

Outputs are `report.md` and `report.json`, including per-assertion results and
adapter-supplied metrics. Changing a fixture means generating a new suite and
collecting fresh observations; do not score old evidence against new fixtures.

## Long context and efficiency

L01 defaults to at least **100,000 unique origin-history tokens**, three actual
compactions/context resets, and at most **12,000 successor boot tokens**. These
are adjustable pilot targets. Noise-event count is not a tokenizer measurement;
the adapter must measure the history through the relevant runtime/tokenizer and
fail the protocol if it cannot reach the configured size.

For the user's million-token question, generate a separate suite:

```bash
python3 continuity_eval.py prepare --out /tmp/ledger-eval-million --noise-events 20000 --minimum-origin-tokens 1000000 --maximum-boot-tokens 12000
```

20,000 events is a workload seed, not a guarantee of one million tokens. Count
each unique history event once; summing repeated prompt input across API calls
would inflate the figure. Record model/tokenizer/version and actual measured
size. Do not claim a single exhausted million-token session if the origin used
several smaller sessions: record which reset/compaction protocol was exercised.

Boot tokens include all instructions, schemas, initial task and initial resume
pack before the successor's first retrieval/action. Later evidence expansion is
allowed; record its additional tokens separately. Report total successor input,
retrieval tokens and elapsed time so a small boot followed by replaying the entire
corpus is visible. The scorer gates boot size, not total lifetime token usage.

Optional metrics in each observation:

- `successor_boot_tokens`, `successor_total_input_tokens`, `retrieved_tokens`.
- `resume_latency_ms`, `time_to_first_correct_action_ms`, `completion_latency_ms`.
- `human_recap_tokens`, `repeated_completed_actions`, `capture_lag_ms`.
- `irrelevant_retrieved_tokens` from spans labeled irrelevant by the controller.

To measure added value, run the same functional cases in three explicitly named
conditions: **fresh agent without continuity**, **last summary only**, and
**Ledger retrieval**. Hold model, task, files available to that condition and
sampling settings fixed and document any differences. Use separate output
directories and randomized condition order. The runner does not automatically
configure or analyze these baselines. Compare cost and speed only alongside
correctness; fast wrong answers are failures.

## Integration and experimental integrity

The adapter is a trusted experiment controller, separate from both agents. It
sees setup inputs and collects source responses. The scorer owns the private
oracle. Neither agent may read this kit, the oracle or the other side's hidden
inputs from a shared filesystem. Simply putting an oracle in a folder named
`private` is not access isolation. Use separate allowed roots/containers or
machines for agents and the controller.

Feed the origin events through the real harness so its transcript and local
helper capture them. Directly inserting rows is useful for a storage integration
test, but cannot establish end-to-end capture. The fresh successor receives only
the resume prompt, answer field names, permitted project files and its ordinary
Ledger tools. It discovers the record by topic. Do not give it the source fixture,
expected answers, record IDs found by the controller or the origin transcript.

For every run, record source and successor harness/model versions, system
revision, classifier settings, capture policy, context limits and run reference.
For R02 reverse the people/harness assignments when testing the reverse direction.
Use fresh fixture resources per trial; retries are additional labeled trials,
not replacements for a failure. Retain failure evidence.

Evidence-backed values are deliberately structured for deterministic scoring.
Normalizing whitespace/case and documented aliases is allowed in the adapter;
inserting expected answers or inferring unstated ones is not. Preserve the raw
successor output for review. Exact text checks apply to retrieved source excerpts,
not the agent's prose. IDs may be mapped from actual Ledger refs by the collector.

The scorer checks evidence consistency, file bytes and fixture invariants. It
trusts the controller to collect actual system observations; a handwritten JSON
file claiming `mode: live` is not authenticated proof. Keep raw tool/DB/ref traces
for review, and inspect failures and a sample of passes.

Use disposable test projects and fixture services. Fault controls and cleanup
must affect only processes/resources created by the adapter. Never delete or
reset production state to prepare a test. For E02 use the fake experiment service,
not a real customer operation.

## What this first version does not establish

- Arbitrary application competence or full machine/process/environment restore.
- Recovery of edits that never reached a remote checkpoint.
- A strict 30-second loss bound: snapshot cadence alone does not bound upload lag.
- PostgreSQL backup restoration, remote Git/object-store durability or scale.
- Correct merging of incompatible snapshots from multiple contributing worktrees.
- Robustness to malicious retrieved instructions or protection of secret files.
- General million-token retention of every fact: L01 tests one known critical constraint.

Add repository-specific acceptance cases for these before making those claims.
The most useful next real pilot is Rachit's unfinished HiAstro change continued by
Agaaz, with a third agent active, followed by the reverse handoff. Verify actual
recovered bytes, the next correct action, the completed application test and
the stated capture gap. Do not infer this outcome from the miniature layout case.
