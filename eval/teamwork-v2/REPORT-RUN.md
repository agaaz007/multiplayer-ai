# Reporting the live matrix

`report-run.py` reads retained controller artifacts only. It never starts a model, calls a provider, changes a grade, or modifies a task workspace. It excludes seed 41, explicit development probes and unscored launches. It preserves unavailable arms and failures; missing usage or timing remains unknown. Running matrix snapshots may contain stages that have not started.

Generate or refresh the JSON and Markdown snapshot:

```bash
python3 eval/teamwork-v2/report-run.py report \
  --matrix-status .context/teamwork-v2-live-20260912/scored/run/status.json \
  --out .context/teamwork-v2-live-20260912/scored/report
```

The report keeps engineering behavior checks and critical failures separate from PM automated field/constraint agreement, semantic factual assessments and decision judgments. A string-format mismatch is not counted as proof of an incorrect factual claim. A timely immutable submission stays delivered if its process later times out. Invalid timing is explicit and must not be used to rank latency. Submission hashes/trees are independently reverified before a result is marked as a verified delivery. Automated grades are retained, not recomputed. Capture process exits, selected native receipts and subscription-classifier receipts are reported without inferring successful handoff or successor reuse from a save count.

Prepare blind review packets once scored PM submissions exist:

```bash
python3 eval/teamwork-v2/report-run.py prepare-reviews \
  --matrix-status .context/teamwork-v2-live-20260912/scored/run/status.json \
  --out .context/teamwork-v2-live-20260912/scored/pm-review-preparation \
  --authorization 'PM review is part of the user-authorized benchmark comparison' \
  --timeout-ms 300000 --max-concurrency 2
```

This writes `review-config.json`, random neutral packet directories and `controller-map.json`; it makes zero model calls. The existing neutral packet builder supplies stage-visible sources and source aliases. Public required facts-field names are copied from the stage answer format for complete semantic factual assessment; hidden expected values are not included. The private map binds each case to the exact submitted answer hash and original arm/stage. Original product paths stay out of the reviewer packets. Both the map and packet files are controller-private. Inspect anonymization before launching the reviewer runner described in `REVIEW-RUNNER.md`. A preparation directory is new-only; do not overwrite earlier preparation. Preparing before all stages finish includes only the verified submissions available at that moment.

Once independent reviews finish, include their results and the private binding map:

```bash
python3 eval/teamwork-v2/report-run.py report \
  --matrix-status .context/teamwork-v2-live-20260912/scored/run/status.json \
  --out .context/teamwork-v2-live-20260912/scored/report \
  --reviews .context/teamwork-v2-live-20260912/scored/pm-reviews/status.json \
  --review-map .context/teamwork-v2-live-20260912/scored/pm-review-preparation/controller-map.json
```

PM decision quality stays pending until two valid independent judgments exist and any score/semantic-fact/critical-error disagreements have a completed adjudication. The report retains calibration labels; uncalibrated model judgments are a limitation, not a new run blocker. There is no aggregate engineering-plus-PM leaderboard or invented total score.

Validate mechanics without a model/provider call:

```bash
python3 -m unittest discover -s eval/teamwork-v2 -p test_report_run.py -v
```
