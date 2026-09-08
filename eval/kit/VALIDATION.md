# Validation performed when this kit was built

Date: 2026-09-08.

- Python unittest suite: **26 tests passed**. These use synthetic observations
  to verify correct scoring and rejection of incorrect/missing evidence.
- CLI smoke: generated all 12 scenarios and invoked the unconfigured adapter
  once per case in the Codex-to-Claude direction.
- Smoke result: **12 not run**; no continuity level assessed or demonstrated.
- Real Ledger or harness execution: **not performed**. No repository checkout,
  live Ledger connection or configured harness runner was available.

The deliverable contains the generator, scorer, report writer, CI gate, tests,
scenario setup instructions and adapter contract. Connecting the real adapter
is required before this suite can measure your system.

Do not quote the 26 passing evaluator tests as 26 passing Ledger tests.
