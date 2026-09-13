# Execute-response contract amendment

The original engineering grader remains frozen and its results remain authoritative historical records. `grade_engineering_contract_v2.py` is a separate versioned copy for a uniform post-run diagnostic regrade.

The published B contract explicitly requires receipt persistence, completed state and HTTP 200, and describes a provider receipt `{receipt_id, key}`. It does not explicitly require `state` in the application's successful execute response. The original grader checked that undocumented response property in three checks. The retained Ledger B diagnostic returns a correct receipt object and stores/exposes the completed state correctly; its original failures therefore reflect response shape.

This amendment preserves every check ID, applicability and severity. In successful execution, replay, concurrent completion and reconciliation checks it validates HTTP 200 and a receipt matching the actual provider's receipt for the job, then uses `GET /jobs/ID` to verify persisted completed state and the same receipt. Restart, duplicate-send, ownership and unknown-outcome requirements remain. No task inputs or submissions are changed. Provider-backed receipt matching also prevents a fabricated but internally consistent receipt from passing.

Validation covers the reference in all stages, receipt-only responses, the immutable Ledger B diagnostic, and deliberate missing/fabricated/unpersisted receipt, duplicate-send and unresolved-state failures. The uniformly amended result is not a replacement for the original score. It should be shown alongside it, with this disclosed amendment and original timing/usage.

After the entire matrix has ended:

```bash
python3 eval/teamwork-v2/grade_engineering_contract_v2.py regrade \
  --matrix-status .context/teamwork-v2-live-20260912/scored/run/status.json \
  --out .context/teamwork-v2-live-20260912/scored/engineering-contract-v2
```

The command refuses a running matrix, checks its amendment/source manifest, excludes development seed 41, verifies every available immutable engineering submission, and applies the same amended grader to each. Missing submissions remain not evaluated and unavailable arms remain visible. Original sequence files are never rewritten. `results.json` and `results.md` preserve original and amended check/critical-error vectors. Regrade runtime is not added to task latency.

Run validation without model calls:

```bash
python3 -m unittest discover -s eval/teamwork-v2 -p test_engineering_contract_v2.py -v
```
