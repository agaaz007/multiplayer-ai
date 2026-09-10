# Reviewer brief — cumulative-work pilot, trace-backed review of one sequence

You are reviewing ONE finished sequence of the four-stage cumulative-work pilot. You are an agent reviewer, not a human; say so in your output. You are not blind to the product name (it is in the directory name); do not let it influence you and do not compare with other arms.

Inputs (read-only; never modify anything under the pilot root):
- Sequence directory: `<SEQ_DIR>` — `sequence.json` (stage records), `stages/<S>/controller/` with `prompt.txt`, `task.json`, `answer.json`, `trace.jsonl` (stage tool calls: query_data SQL + rows, submit_answer), `mcp-calls.json` (every MCP call with arguments and results), `rollout-*.jsonl` (the agent's own Codex transcript), `process.json` (event stream), `tool-calls.json`, and for coding stages `candidate.patch` plus the `checks` in `sequence.json`.
- Grading contract: `<CONTENT_ROOT>/controller/grading-contract.md` and input availability `<CONTENT_ROOT>/controller/input-availability.md`. Apply them literally.
- For the analysis task the private oracles are in `<CONTENT_ROOT>/controller/analysis-oracles.json` (stage SQL + affected sets); the automated SQL grade is already in `sequence.json` (`grade`). Do not re-grade SQL; review what the automation cannot.
- The pilot report entry for this sequence: `<ROOT>/report.json` (find `sequences[]` by dir).

Produce `<SEQ_DIR>/review.json` (write ONLY this file plus `<SEQ_DIR>/review.md`) with this shape:
{
  "schema": "sequence-review/v1", "reviewer": "agent (claude, not human, not blind)", "sequence": "<task>-<arm>",
  "stages": { "A": {...}, "B": {...}, "C": {...}, "D": {...} },
  "cumulative": { "cUsesAandB": {"verdict": "verified|partial|unverified|not-applicable", "evidence": "..."}, "dUsesC": {...}, "dAppliesChangedScope": {...}, "centralCriterionMet": true|false|null, "explanation": "..." },
  "notes": ["..."]
}
Per stage record:
- "status": completed / timed out / failed / no answer (from sequence.json).
- "substantiveReuse": for each reuseEvidence claim in answer.json: {sourceId, producedByStage (from mcp-calls/transcripts of earlier stages), retrievedHere (quote the exact tool result line or transcript excerpt, with file), usedInOutput (quote the exact answer/SQL/code passage that depends on it), verdict: verified|citation-only|not-found}. A correct result alone, a marker, or a logical label alone is NOT verified reuse.
- "reconstruction": list what this stage re-derived that an earlier stage had already produced and saved (re-deriving SQL, re-validating the identity join from scratch, re-implementing a feature), each labelled necessary-validation or avoidable-reconstruction with a one-line reason; count query_data calls and command executions.
- "repeatedMistakes": stale conclusions restated as current, proposals treated as accepted, obsolete identity/assignment join revived (D must not), wrong-scope reuse (all-plan results used for the ₹499 decision without review), regression reintroductions (coding).
- "impact" (B and D): build the inventory of earlier outputs actually produced in this sequence (from earlier stages' answers and saved records), then list which the stage flagged for review and which it missed; give precision and recall over that observed inventory, or n/a.
- "criticalProseErrors": per the contract (wrong metric, current config as historical truth, user-level dedup of daily denominator, causal lift claims, new proposal presented as accepted). Quote.
- Coding stages only: "requirementCoverage": for the stage's row in the contract table, list each required behavior as implemented / partially / missing / not-evaluable with the file+hunk in candidate.patch; "frozenDataUse": did the saved brief/metric validation use the frozen HiAstro data (quote); "codeContinuity": does this stage's patch build on the predecessor's code (same files/functions extended) or re-implement from baseline; "checks": compare `checks` exit codes to baseline.
Rules: quote evidence with file paths; never infer from the product name; unknown is unknown, not zero; keep review.md under 800 words; do not run any agent or model; do not modify pilot files. Finish by printing the path of review.json.
