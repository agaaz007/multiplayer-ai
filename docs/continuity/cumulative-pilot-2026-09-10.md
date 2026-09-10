# Cumulative-work pilot — 10 September 2026

Status: dispatcher implemented and smoke-tested; scored sequences launched from `.context/pilot-20260910`. This document is filled in as results arrive; anything marked *pending* has not been observed.

## What was delivered

The reviewer's revised protocol (A produces, B continues and corrects, C builds a related task on A and B, D carries later evidence forward and inherits C; fresh-agent control; one sequence per product per task; frozen budget and stage limits) is implemented as `node dist/eval/sequence-runner.js` with `prepare`, `smoke`, `run`, `run-all`, `report` and `budget` commands. The protocol text in `eval/analytical-sequences.md` has a Runtime section describing the arms, capture, delivery and retained evidence. Limits are frozen in `eval/pilot-limits-2026-09-10.json`: GPT-5.6 Sol, reasoning medium, 10 minutes per stage, 120 s provider processing wait, no retries, $20 shared allowance at conservative upper bounds.

Simulated users: `sim-user-a` … `sim-user-d` are distinct git identities, homes and Codex sessions on one laptop. This establishes continuity across fresh sessions and tasks; it does not establish cross-account permissions or cross-laptop delivery.

## Fixes made in the line of this work

| Defect | Where | Effect before the fix |
| --- | --- | --- |
| Seatbelt denied `127.0.0.1:5432`, which `sandbox-exec` rejects ("host must be * or localhost") | `sequence-isolation.ts` | every isolation probe failed; the 9th sequence selftest failed |
| `(deny process-info*)` in the seatbelt | `sequence-isolation.ts` | node and codex died with SIGTRAP at startup (CoreFoundation process-info lookup); dropped, nothing secret is in argv |
| Unix socket paths above macOS's 104-byte `sun_path` limit | `sequence-transport.ts`, runner | silently truncated socket path collided across stages (`EADDRINUSE`), transport process leaked |
| Ledger helper cannot snapshot a repository without HEAD | runner | analysis stages produced no WIP snapshot; stage inputs are now committed as the baseline for every arm |
| pnpm resolved its store from a private HOME | runner | offline install failed during coding preparation; the machine store is passed explicitly |
| Thread listing reported "no verified snapshot" when the head checkpoint was a later turn checkpoint | `src/continuity/resume.ts` | noted in the Rachit handoff report as documented-not-fixed; now falls back to the session's last verified snapshot |

## Smoke results (synthetic, unscored)

Two stages per arm: A saves a decision, an identifier and a `query_data` row count through the product; a fresh B retrieves them. All runs used the real dispatcher, seatbelt and product integrations.

| Arm | A saved | B retrieved identifier | B retrieved row count | Native IDs cited by B |
| --- | --- | --- | --- | --- |
| ledger | yes | yes | yes | decision + definition record IDs |
| supermemory | yes | yes | yes | three document IDs |
| gbrain | yes | yes | yes | page slug |
| graphify | yes | yes | yes | source file |
| fresh-agent (control) | files only | no (null, no guess) | no | none |

Observed: Supermemory's flushed session document stayed `queued` beyond the 120 s wait in one smoke while its explicit save was `done`; Codex's websocket transport fails certificate validation in the sandbox and falls back to HTTPS (4 reconnect messages per turn, no failure).

## Scored sequences

*pending* — filled from `report.md` when the ten sequences finish.
