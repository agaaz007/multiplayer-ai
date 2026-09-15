# Local validation — 2026-09-11

Passed `python3 -m unittest discover -s eval/teamwork-v2 -p 'test_*.py' -v`: 17 tests. Passed `node eval/teamwork-v2/test-delivery.mjs` and Node syntax validation of the stage driver.

The tests verify reproducible packs, future-input withholding, frozen-file tamper detection, PM factual checks and critical constraints, missing independent review remaining unscored, private source mappings, launch refusal without authorization, and native Mem0 request shapes/scope restrictions through an injected fixture transport. They also execute the engineering HTTP reference through the real macOS seatbelt, verify the starter fails, reject blind-retry and cross-owner mutants, and demonstrate that submitted code cannot read a controller-secret file outside its workspace.

The delivery suite verifies that an answer needs no preceding memory write, the submitted code snapshot remains unchanged after later worktree edits, and duplicate/late submissions and symlinks are rejected.

Retained development pack: `.context/teamwork-v2-ready-local-41/`. Retained test log: `.context/teamwork-v2-validation.txt`. The prepared control sequence `.context/teamwork-v2-prepared-control/` has `executed:false`. Seed 41 is development-only. Example profiles correctly fail preflight; no scored model/vendor trial ran.

Still unverified: live fresh-agent execution of this new driver, per-sequence provisioning and native capture/export/cleanup for the new matrix, Mem0 live credentials and retrieval, Ledger classifier-on readiness, actual forced-compaction/interruption injection, and independent PM reviewer agreement. The local checks establish benchmark mechanics, not competitive performance or complete live readiness. One synthetic scenario per track needs calibration and later expansion before broad claims.

Shared Ledger metric definition: `def-20260911-teamwork-benchmark-v2-separate-engineering-pm-qu-wint`. Design decision: `dec-20260911-use-separate-engineering-delivery-and-pm-decisio-utv9`. Both were committed and pushed under agaaz.
