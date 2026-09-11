# Real-task pilot content freeze — September 10, 2026

The user requires real frozen HiAstro data for both task scores and approved the C/D benchmark additions. They selected simulated A/B/C/D users on one laptop and approximately $20 total. The task model remains GPT-5.6 Sol for every product and control.

The content manifest is `.context/real-pilot-20260910/content-freeze.json`. It hashes eighteen local inputs/contracts, including both four-stage tasks, private SQL oracles, input availability, grading rules, the original PRD and the baseline source archive. A changed file invalidates verification. The manifest freezes content; it does not assert runtime readiness or authorize a scored result by itself.

## Real evidence

Both tasks bind every stage to the same read-only production export: complete IST days September 6–9, 2026, current monetization configs 23/32/34. The export contains 9,824 pseudonymous user-day rows from the union of the canonical and legacy UUID identity paths; 9,682 have canonical login evidence. No raw phone/name/email/UUID columns are included. Data SHA-256:

`ff89e51917758b8dbf36e7724069899c06c9fc135b648e1eb60fb5c882b9049a`

The exact extraction query, observed source edges and limitations are retained. Independent SQLite aggregation matched all twelve complete-day config/₹499 count pairs in Ledger finding `fnd-20260910-five-day-daily-animated-paywall-and-config-login-2vnx`. Source edges indicate freshness, not guaranteed completeness. Current config remains a current-state proxy, not historical assignment truth.

The first export had a UUID alias-shadowing error that zeroed both login flags; it is retained as invalid and excluded. The valid v2 export is required by hash and by row-level checks. The scoped legacy comparison cannot reproduce an unrestricted historic assignment population absent from the export.

The coding source archive contains the incomplete baseline `61b8945693eea3a546123667616c937abea3a210`, without Git history containing later answers. The original PRD is artifact `e552ced7-6030-46f0-9424-df7729a52faa`. Rachit's outer snapshot omitted the nested app checkout; this is explicitly a PRD-plus-baseline reconstruction.

## Frozen additions and grading

Analysis C performs full-window repeat-user segmentation and saves an observational recommendation or justified deferral. D narrows to the actual ₹499 plan and reviews affected all-plan work. Coding C adds read-only revision comparison; D changes eligibility to completed linked runs while preserving historical access, source revisions and unknown QA states. These requests are benchmark additions, not historical discoveries attributed to Rachit.

`sequence-grade.ts` separates executable SQL correctness from cumulative reuse and impact. Its scored entry verifies the content freeze before loading a listed task and oracle. Reuse requires a predecessor's actual saved contribution, an actual recipient retrieval, and substantive use in the output. Impact is assessed against outputs actually produced; a missing planned recommendation is not invented by the grader.

The coding score additionally requires actual use of the frozen data in the saved brief/metric validation. Mock assets, local identities and provider failures are disclosed test infrastructure. The previous synthetic-only PRD source fixture is ineligible for real-task scores. Candidate-specific HTTP bindings, disposable Postgres checks and browser review must verify actual behavior; baseline builds and self-authored tests alone cannot establish PRD completion.

## Native Supermemory check

Two actual headless Sol source probes completed but their upstream asynchronous Stop hook produced no saved document within sixty seconds. SessionStart/UserPromptSubmit hooks ran. With the host setting changed to synchronous Stop, the unchanged official flush implementation saved the source exchange. A fresh isolated Sol recipient then recovered its exact identifier through native `search_memory`.

Evidence: `.context/competitor-readiness/supermemory-host-MAbP4k/result.json` and source/recipient process traces. The scoped key denied legacy alias reads outside the trial container. This is successful native capture plus explicit native retrieval, not a claim that automatic recall or compounding passed. Both smoke documents were subsequently deleted, an empty inventory verified, and temporary keys revoked. Failed probes remain part of setup effort. Provider dollar usage remains unreconciled; subscription usage is reported separately.

## What remains before competitive results

No scored A/B/C/D sequence has run. The four-stage dispatcher, complete per-stage provider/budget controls, runtime freeze and independent coding behavior binding remain unfinished. The old runner is still a single-handoff diagnostic. Nine local sequence test groups, fifteen analytical contract groups and nine competitor groups passed; these checks are not product performance results.

Ledger records committed and pushed: decision `dec-20260910-freeze-real-hiastro-inputs-and-approved-c-d-addi-loli`, input-validation finding `fnd-20260910-real-hiastro-four-day-benchmark-export-validated-7f9s`, and native Supermemory readiness finding `fnd-20260910-native-supermemory-capture-and-fresh-sol-retriev-do1g`. The content manifest SHA-256 is `b79b15d3f116fd8db8589f1ca7cb0f38325197169fe4d8a9e6eabb21e1d69f84`.

This pilot can test continuity across fresh sessions and tasks with simulated people. It cannot establish real cross-account authorization, cross-laptop delivery or statistical superiority.

## Update — 10 September 2026, evening: dispatcher built, smokes passed, scored sequences launched

The four-stage dispatcher (`src/eval/sequence-runner.ts`, with `sequence-mcp.ts`, `sequence-budget.ts`, `sequence-report.ts` and a rewritten `sequence-codex.ts`) now exists and was smoke-tested per arm with a synthetic two-stage capture-then-retrieve check: Ledger, Supermemory, GBrain and Graphify each delivered the exact identifier, release mode and query result from stage A to a fresh stage B; the fresh-agent control correctly reported nothing. Four runtime defects were fixed on the way (seatbelt host syntax, `(deny process-info*)` SIGTRAP, unix-socket path truncation, no-HEAD snapshot), plus the Ledger thread-listing freshness label noted in the Rachit handoff report. The scored pilot root is `.context/pilot-20260910` (limits `eval/pilot-limits-2026-09-10.json`); results are reported in `cumulative-pilot-2026-09-10.md`.
