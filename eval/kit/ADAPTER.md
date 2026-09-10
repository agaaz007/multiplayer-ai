# Adapter contract

Implement this inside or alongside the actual Ledger repository. No Ledger tool
argument schemas are assumed here; discover/use the installed tool definitions.
The supplied template intentionally returns `skipped` until integrated.

## Controller input and output

The runner launches the argv in `adapter.example.json` once per trial, passes one
JSON object on stdin and expects one JSON object on stdout. It executes from the
caller's current directory. Use an absolute script path if running elsewhere.

Request fields:

| Field | Meaning |
| --- | --- |
| `protocol_version` | `1` |
| `case` | Public setup, origin events, resume prompt, answer keys and optional seed files/limits |
| `direction` | `codex-to-claude` or `claude-to-codex` |
| `repetition` | Trial index, starting at 1 |
| `trial_id` | Unique run prefix plus case/direction/repetition; use for isolated resources |
| `output_dir` | Absolute evidence bundle directory |

For a completed trial return this shape; omit fields irrelevant to the case:

```json
{
  "status": "completed",
  "provenance": {
    "mode": "live",
    "system_revision": "ACTUAL_GIT_REVISION",
    "run_ref": "ACTUAL_CONTROLLER_RUN_ID",
    "origin_harness": "codex",
    "successor_harness": "claude",
    "origin_harness_version": "RECORDED_VERSION",
    "successor_harness_version": "RECORDED_VERSION",
    "origin_model": "RECORDED_MODEL",
    "successor_model": "RECORDED_MODEL"
  },
  "answers": {
    "requested_field": {"value": "SUCCESSOR_VALUE", "evidence_ids": ["fixture-source-id"]}
  },
  "retrieved_evidence": {
    "fixture-source-id": {
      "text": "EXACT_RETRIEVED_SOURCE_TEXT",
      "system_ref": "REAL_EVENT_OR_LEDGER_REFERENCE",
      "raw_ref": "raw/retrieval-response.json"
    }
  },
  "selected_topic": "SUCCESSOR_SELECTED_TOPIC",
  "recovered_files": "recovered",
  "final_files": "final",
  "actions_file": "actions.json",
  "ownership_file": "ownership.json",
  "parallel_file": "parallel.json",
  "stress_file": "stress.json",
  "coverage_file": "coverage.json",
  "metrics": {"resume_latency_ms": 0}
}
```

The uppercase strings are placeholders, not fixture answers. Store artifacts
inside `output_dir`; absolute escapes, `..` escapes and symlinks outside the
bundle are rejected. The runner writes your response to `observation.json`.
It does not archive stderr automatically; retain redacted controller logs yourself.

Use `status: skipped` with a reason for a missing capability/configuration.
Use `status: error` for controller execution errors. A completed trial with
incorrect successor behavior must remain `completed` so its assertions fail;
do not hide it as an infrastructure error.

## Connect the existing components

| Experiment responsibility | Existing interface described in the supplied implementation report |
| --- | --- |
| Start isolated origin work and capture | Actual Codex/Claude runtime plus local transcript helper, uploader and shadow snapshot path |
| Discover requested work | `ledger_records`, `ledger_record_get`, `ledger_threads`, `ledger_thread_get` |
| Assemble and inspect continuation | `ledger_resume`, `ledger_events`, `ledger_artifact_get`, `ledger_evidence_search` |
| Inspect record membership/state | `ledger_record_link`, `ledger_record_update`, existing classifier/state-update storage |
| Observe ownership behavior | Existing claim generation/release/continuation interfaces and collector queries |
| Inspect incomplete organization | `ledger_unassigned`, capture and classification cursors |
| Verify code recovery | Remote shadow refs/artifact refs, recovered filesystem bytes and independent Git queries |

Names are references from the user's status report, not verified callable tools
in the environment where this kit was created. Use actual installed names and
schemas. Do not add a synthetic answer-producing server to make the tests pass.

Origin fixture events have stable IDs. Preserve an external map from those IDs
to actual captured event or Ledger-object refs. `retrieved_evidence` may include
an event only if the successor actually received it through the system. The
collector can extract that event's exact text from a larger tool response. It
must not fill this dictionary from the original fixture file. Preserve the raw
response containing the excerpt for review.

For E01 copy the restored files into `recovered/` **before** successor edits.
Initialize `layout.json` as tracked in the origin repo, then modify it to the
provided seed content; `generated/study.txt` is new/untracked and policy-included.
Initialize then delete tracked `obsolete.txt`. Record the remote-verified snapshot
ref. Seed the required files through filesystem operations, not only transcript
Edit/Write descriptions. For E03 copy the final successor files into `final/`.

## Collector artifacts

Every artifact below must include `raw_trace_refs`: a nonempty array of paths to
nonempty raw trace files in this bundle. The scorer verifies attachments exist;
the controller is responsible for parsing them accurately. A successor's statement
that a claim succeeded or a test passed is insufficient.

### E02: actions.json

```json
{
  "raw_trace_refs": ["raw/successor-tools.jsonl"],
  "actions": [{"tool": "read_experiment_status", "operation_id": "create-experiment-7"}]
}
```

Populate from actual successor tool calls against the fixture service. A
`create_experiment` call anywhere in this continuation fails the case. The fixture
must have already created the experiment while simulating loss of the response.

### C01: ownership.json

```json
{
  "raw_trace_refs": ["raw/claims-and-events.jsonl"],
  "claim_results": [{"acquired": true, "conflict": false}, {"acquired": false, "conflict": true}],
  "old_generation": 1,
  "new_generation": 2,
  "head_after_takeover": "REAL_HEAD_REF",
  "head_after_stale_upload": "REAL_HEAD_REF",
  "fork_thread_id": "REAL_FORK_ID",
  "stale_event_id": "REAL_EVENT_ID",
  "stale_event_thread_id": "REAL_FORK_ID"
}
```

Submit claims with separate actors/connections and a synchronization barrier;
sequential calls do not test a race. If the origin owns a non-expired claim, first
use the supported expiry/takeover mechanism so two eligible continuers contend.
Query the event again after stale upload to establish it was retained on a fork.
Use actual generations; the numbers above only illustrate the schema.

### C02: parallel.json

```json
{
  "raw_trace_refs": ["raw/third-agent.jsonl"],
  "worktree_a": "ACTUAL_CONTINUATION_WORKTREE",
  "worktree_b": "ACTUAL_THIRD_AGENT_WORKTREE",
  "third_agent_progressed": true,
  "sentinel_before": "ACTUAL_SHA256",
  "sentinel_after": "ACTUAL_SHA256"
}
```

The sentinel is unrelated work the third agent should not edit during the test.
Progress means a successful independent operation during the handoff, not merely
that a process is alive. Record operation timestamps and actual file hashes.

### L01: stress.json

```json
{
  "raw_trace_refs": ["raw/context-usage.jsonl"],
  "compactions_or_resets": 3,
  "measured_origin_tokens": 100000,
  "successor_boot_tokens": 10000,
  "successor_got_original_history_directly": false,
  "tokenizer": "ACTUAL_TOKENIZER_AND_VERSION",
  "reset_protocol": "ACTUAL_COMPACTION_OR_RESET_MECHANISM"
}
```

Replace numeric examples with observed values. Enforce the case's public
`stress_requirements`. Context-reset count must come from runtime/session traces;
writing three synthetic compaction events does not satisfy the protocol.

### L02: coverage.json

```json
{
  "raw_trace_refs": ["raw/cursors-and-resume.jsonl"],
  "captured_seq": 100,
  "classified_seq": 90,
  "resume_disclosed_lag": true,
  "unassigned_visible": true,
  "unassigned_preserved_after_next_pass": true
}
```

Use actual comparable cursor positions for the same capture stream. The first
two values are collected while lag exists. Capture the real resume response for
the disclosure field. Inspect the relevant unassigned span before and after a
subsequent classifier pass; if it becomes assigned, verify its evidence remains
discoverable through that record. Preservation does not require staying unassigned.

## Failure and cleanup

Keep assertions independent of agent self-grading. Record observations before
cleanup. Track exact process IDs and fixture resource IDs owned by the controller.
The runner times out an adapter invocation after 1,800 seconds by default; it
cannot guarantee cleanup of separately launched harness processes. Implement a
controller watchdog/managed process group and scoped resource cleanup. Never use
broad process-name kills, reset a user's active worktree or drop a production schema.

The fixture controller can run on the origin machine and coordinate an existing
second machine, or in isolated local worktrees if both harnesses are installed.
Actual two-machine handoffs provide stronger evidence about upload/recovery than
same-machine trials. Record the topology rather than treating them as equivalent.
