# Independent PM review runner

`review-runner.mjs` consumes the existing `bench.py review-packet` output. It runs two fresh Codex ChatGPT subscription sessions per delivered PM answer, using the frozen `runSequenceCodex` runtime and no memory servers, capture hooks, API keys, browser, or shared conversation. Task-solver memory budgets are not charged for reviewer subscription inference. Reviewer time and tokens are retained separately.

The controller copies only `answer.json`, `sources.json`, public required fact-field names (`fact-keys.json`), the frozen rubric and a review format into neutral temporary workspaces. Original product-bearing packet paths, the reversible source map, other reviewers' workspaces, costs and native traces stay outside the kernel-permitted roots. The first two sessions cannot read each other's judgments. A third fresh adjudicator receives the same answer/evidence plus anonymized peer judgments if any dimension score, semantic factual verdict, or critical-error classification/evidence differs. Both original judgments remain in the output.

A controller must inspect anonymization before running. Preflight rejects explicit product names and `mcp__` markers; that check cannot guarantee all linguistic identity cues are removed. A review that reports residual identification remains `not_evaluated`. Scope/reliability facts inside the answer and raw archive remain visible.

Prepare each packet with its stage-visible evidence:

```bash
python3 eval/teamwork-v2/bench.py review-packet \
  --pack /absolute/frozen-pack --stage D \
  --answer /absolute/submission/answer.json \
  --out /absolute/controller-packets/case-0001
```

Freeze a controller-only configuration:

```json
{
  "schema": "pm-review-run/v2",
  "execution_authorized": true,
  "authorization": "Reference to the user's authorization for this comparison",
  "runtime": "/absolute/frozen-runtime",
  "runtime_sha256": "SHA256 of frozen-runtime/eval/sequence-codex.js",
  "rubric": "/absolute/frozen-pack/controller/scoring/rubric.md",
  "rubric_sha256": "SHA256 of the rubric bytes",
  "model": "gpt-5.6-sol",
  "reasoning_effort": "medium",
  "timeout_ms": 300000,
  "max_concurrency": 2,
  "ca_file": "/absolute/public-ca.pem",
  "cases": [
    {"id": "case-0001", "stage": "D", "packet": "/absolute/controller-packets/case-0001"}
  ]
}
```

The time limit is a suggested starting allocation, not a validated completion guarantee. Set `ca_file` only when the selected runtime needs it. `calibration_artifact` is an optional path to independently checked calibration evidence. Its hash is retained; its content is not automatically certified. Without it the output explicitly labels the judgments uncalibrated. Mechanical fake-session tests do not calibrate a model reviewer or validate decision-quality accuracy.

Launch after delivered answers and their immutable provenance have been verified:

```bash
node eval/teamwork-v2/review-runner.mjs run \
  --config /absolute/review-config.json \
  --out /absolute/new-controller-review-output
```

`status.json` is updated atomically. Each case retains the first two judgments, exact dimension agreement, mean absolute score disagreement, critical-error agreement, any adjudication, and the final dimension vector. Every session retains raw output, request, parsed review, receipt, elapsed time, model, session ID and usage. Private temporary homes contain subscription authentication copied by the existing runtime and must remain controller-private; their location is retained in `manifest.json` for later controlled cleanup. Do not publish these homes or the manifest/source map to reviewers.

Every reviewer supplies a `factual_assessment` for each required/submitted facts field: `supported`, `contradicted`, `unclear`, or `missing`, with the exact submitted typed value and source passages. A failed automated string comparison is not presumed factually wrong. Reviewers interpret the full statement, including negation, scope, units and qualifications; no keyword matching is used. Required field names come from the public answer format, not hidden expected values. Packets built directly with `bench.py review-packet` may optionally include `fact-keys.json`; without it only submitted field names are available. `report-run.py prepare-reviews` includes all public required field names.

The runner validates scores, exact cited passages, source availability, exact typed factual-value binding, missing-field assertions, immutable input files, successful timely completion and actual runtime isolation receipts. This checks review mechanics; it cannot prove a passage supports the reviewer's interpretation. Missing, malformed, timed-out or exposed-identity reviews stay `not_evaluated`, with no automatic retry. Unresolved reviewer failures do not become zero scores. A reported critical error produces a separate critical-error gate. No numerical total or quality-pass threshold is invented, and reuse stays unscored until a separate trace reviewer assesses it.

The supplied rubric requires independent reviews and retained/adjudicated disagreements; it does not define a separate reviewer-calibration gate. The protocol asks for a development seed to calibrate task duration and grader sensitivity. This runner does not block model judgments when calibration evidence is absent: it labels them uncalibrated. An identical subscription model in fresh isolated sessions supplies independent contexts, not independent model families or human judgment. Independent calibration checks, repeated cases and uncertainty reporting would strengthen broader claims.

Validate without model calls:

```bash
node --test eval/teamwork-v2/test-review-runner.mjs
```

Prelaunch clarification for the scored review: cumulative raw evidence does not include full predecessor submissions or native records. Reviewers distinguish unavailable corroboration from contradiction, preserve the answer’s uncertainty, and leave actual predecessor attribution/retrieval accuracy to the separate continuity trace audit. A saved agent recommendation does not establish human approval. This constraint applies uniformly to initial reviewers and adjudicators and provides no arm outcomes or hidden answers.
