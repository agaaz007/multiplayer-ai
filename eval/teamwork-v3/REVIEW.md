# PM review preparation and launch

This is a separate, uncalibrated decision-quality review of the sixteen immutable PM submissions. It does not replace recovery, timing, supplier, or native-use audits. It makes no pooled winner score.

After all primary sequences end, prepare the complete cohort with the same input configuration used by `grade-run.py`:

```sh
python3 eval/teamwork-v3/review-prepare.py --config GRADE_CONFIG.json --out NEW_PREPARATION --runtime ABS_RUNTIME
```

The grading configuration supplies `sequences`, each with an absolute `root` and optional controller `provider_events` path. The preparer accepts all eight engineering/PM entries but requires all four PM arms and retains all sixteen expected cases. A timely, valid immutable answer and submission tree make a case eligible. Missing, invalid or late submissions remain explicitly `not_evaluated` with no model calls; eligible submissions are reviewed unchanged. These unavailable cases are never zero scores or silently omitted. It starts no model sessions. `review-config.json` is deliberately written with `execution_authorized: false`.

Inspect every neutral packet and its private `controller-map.json` before changing that gate. The private map records original file hashes, packet hashes, exact identity substitutions and source roles; never copy it to reviewers. Inspection must verify that substitutions preserve substantive claims, qualifications, authority, identifiers' distinctness and source binding. Automated identity scanning does not prove full blinding. Declare the cohort and freeze these artifacts before launch.

After controller inspection, authorization and the normal source freeze:

```sh
node eval/teamwork-v3/review-runner.mjs run --config NEW_PREPARATION/review-config.json --out NEW_REVIEW_OUTPUT
```

The configuration defaults to the subscription runtime, `gpt-5.6-sol`, medium reasoning, a 300-second deadline per review and six concurrent sessions. It permits exactly two initial independent reviews per case, then one adjudicator only for divergent valid judgments. Invalid, late or identity-exposed sessions are retained as `not_evaluated`; no retry occurs. Each fresh isolated workspace contains only neutral inputs, the rubric, the output schema and the public literal-evidence validator. Adjudicators additionally receive the two initial judgments.

The answer envelope contains the delivered answer, `reports/STAGE.md` and final `continuity/state.json`. Sources distinguish canonical released evidence from actual recovered and delivered artifacts. Missing recovery does not become reconstructed evidence. Supplier observations exclude B's explicitly post-delivery action when judging B. A saved recommendation is not human approval. Reviewers judge claims at the delivery boundary, with unknown corroboration distinguished from contradiction.

Five fixed factual categories avoid enforcing arbitrary wording or task-specific answer keys: numeric result, scope and denominator, decision authority, predecessor attribution and operation state. All factual and critical-error judgments bind literal excerpts from both answer and sources. The standalone self-check supplies only schema and citation errors within the same original session; the controller independently revalidates the final output. Semantic correctness remains a model judgment.

Outputs retain raw review JSON, stdout, stderr, process metadata, timing, token usage, isolation evidence and input hashes, plus live atomic `status.json`. Generic receipt/container schema labels remain compatible with the prior review report tooling; the judgment schema is explicitly `pm-continuation-review/v3`.

Local verification, with injected sessions and no inference calls:

```sh
node --test eval/teamwork-v3/test-review.mjs
python3 -m unittest discover -s eval/teamwork-v3 -p test_review_prepare.py
```
