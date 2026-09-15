# Final uniformly reblinded PM review cohort

The controller excludes the entire original reviewer cohort from final quality scoring under `scored/review-cohort-exclusion.json`. Its raw judgments, errors, usage and partial status remain methodology evidence. V3 reviews all 24 original immutable PM submissions twice in fresh isolated sessions, followed by a third independent adjudicator when the new pair diverges. No primary task is rerun, no original judgment is carried into the final reviewers, and no best-of selection is permitted.

`blind-review-v3.py` extends the original verified blind-packet chain with an exact private map. It replaces opaque/slug predecessor identifiers everywhere in string values, including nested singular source fields and prose, and distinguishes unavailable predecessor references from public source aliases. New case IDs and shuffled case order carry no original arm label. Public sources are byte-identical. Numeric/typed facts, substantive prose, proposal/approval qualifications, and statements about unavailable predecessor context remain. Prior documented minimal mechanism wording neutralization is retained with its original hash provenance.

`review-runner-v3.mjs` preserves the substantive rubric, source evidence, model, medium reasoning, 300-second allocation, two fresh reviewers, six-session concurrency, isolation checks, exact-evidence validation and adjudication rules. Its complete output declaration specifies `critical_errors` items as `{kind, explanation, evidence}` and `residual_identification` as a string array concerning competitor identity, not common fictional task names/files. `prior-reference-NNN` is explicitly an unavailable predecessor reference, not corroboration or approval.

Each reviewer receives `validate-review.mjs`, a standalone copy of `review-validator-v3.mjs`. It reads only local answer, sources, public fact keys, and review output. It validates schema, exact passages and exact typed-value binding; it supplies no scores, expected facts, product names, controller paths or substantive quality feedback. Reviewers may repair those structural/citation errors inside the same session and deadline. The controller independently applies the unchanged strict checks and input hashes after completion. Invalid outcomes are retained without retries or silent normalization.

Launch only after the controller's exclusion declaration and independent inspection:

```sh
node eval/teamwork-v2/review-runner-v3.mjs run \
  --config /absolute/scored/pm-review-v3-preparation/review-config.json \
  --out /absolute/scored/pm-reviews-v3
```

Config uses `pm-review-run/v3`; result/receipt schemas preserve the existing report interface. Runtime, rubric, runner, validator and input hashes are retained. The preparation's private controller map links new cases to immutable original submission hashes. Old source maps, arm labels and traces are not copied to reviewer workspaces. Model judgments remain uncalibrated; no human review is claimed.

Validation: 13 local fake-session tests in `test-review-runner-v3.mjs`, including actual standalone validator execution, and three exact-map preservation tests in `test_blind_review_v3.py`. These verify mechanics, not substantive scoring accuracy.
