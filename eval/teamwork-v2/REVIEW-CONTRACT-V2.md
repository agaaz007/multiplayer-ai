# Separate post-run reviewer contract audit

The supplied `review-format.json` shows an empty `critical_errors` array without defining item keys. Some initial judgments use `type` and `rationale` for the concepts the validator calls `kind` and `explanation`. This controller correction preserves the original raw reviews, receipts, statuses, prompt, and validator. It changes no task answer, score, fact verdict, critical-error assertion, or quoted evidence.

`review-contract-v2.mjs` deterministically supplies `kind` from `type` and `explanation` from `rationale` only when the canonical field is absent. Conflicting simultaneous values remain invalid. All original fields remain in the normalized copy. The frozen validator is then applied to exact dimensions, factual typed values and quoted evidence. Process completion, timing, kernel isolation, model, usage/session receipts, original input hashes, current isolated inputs, and original status/receipt consistency are checked again. Other original errors remain invalid.

Common fictional names do not identify a memory competitor. Clearance nevertheless requires an explicit, controller-manual entry for each flagged residual item: exact raw/remainder hashes, an exact reviewer passage expressly denying vendor/arm inference, an exact public source passage containing the named fixture entity, and a recorded reviewer/reason. The program does not infer clearance from keywords. Unknown concerns and actual vendor/native identifiers remain invalid. All original residual text is retained in raw evidence. A review with no explicit no-inference statement remains unresolved under this amendment.

Run only after the original review run has ended; retain its temporary input workspaces until the audit has checked their hashes:

```sh
node eval/teamwork-v2/review-contract-v2.mjs audit \
  --run /absolute/scored/pm-reviews \
  --clearances /absolute/scored/pm-review-contract-clearances.json \
  --out /absolute/scored/pm-review-contract-v2
```

Without `--clearances`, alias-only corrections can be assessed, while nonempty residual concerns remain invalid. Output is a separate `audit.json`, not a rewritten original status. Each review reports its original status/errors, proposed contract validity, exact alias changes, clearance status, and original raw/receipt hashes. Each pair reports agreement, eligibility for an already retained adjudicator, need for its first adjudication, or unresolved failure. No models run.

To complete newly valid pairs, freeze a separate adjudication-only configuration from `required_new_adjudications` after reviewing this audit. Run exactly one fresh third reviewer for each newly valid divergent pair with no prior adjudicator. Supply the same blind answer/sources/rubric/fact keys and the two retained, mechanically normalized peer judgments; explicitly specify the already required critical-error item schema and limit residual identification to vendor/arm clues. Do not supply controller maps, native traces, task grades, prior outcomes, or preferred scores. Preserve the same model, reasoning setting, timeout, isolation, token reporting and rubric. Record these new adjudicators in a separate output linked by original hashes. No initial reviewer is rerun, no failed existing adjudicator is retried, and no preferred review is selected. Original missing/invalid judgments remain visible alongside the corrected interpretation. This file proposes that execution; this tool cannot launch it.

Validation: `node --test eval/teamwork-v2/test-review-contract-v2.mjs` uses only fake judgments and temporary local fixtures.
