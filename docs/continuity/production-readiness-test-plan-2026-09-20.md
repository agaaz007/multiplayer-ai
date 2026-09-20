# Ledger production-readiness test and release evidence plan

Companion to [the engineering plan](production-readiness-2026-09-20.md). Status: test specification, not test results. Baseline inspected on 20 September 2026 at `9beb92b`.

## Harness and isolation

The repository uses TypeScript compiled to `dist/` and Node's `assert/strict`, with standalone `src/selftest-*.ts` programs. Reuse it. Existing continuity tests already cover producer deduplication, claims, fork routing, redaction, snapshots, and two-author resume. Records tests cover normal declaration, near-duplicate refusal, and idempotent/rebinding behavior. Investigation tests cover correction history, incompatible product scope, and accepted definitions surviving draft crowding. These are not substitutes for the failure-injection cases below.

Before executing DB suites, T1 must provide a runner with a fresh disposable Postgres database, unique test marker, isolated `LEDGER_CONFIG_DIR`, temporary Git repositories/remotes, and disabled team Git sync. Current `selftest-continuity.ts` drops `cont_*` tables at startup. Refuse a configured team database even if a test environment variable points to it. Never run a drop-capable suite with inherited live credentials. Fixtures should contain synthetic data, not copied personal transcripts or secrets.

Build once using `npm run build`. During implementation, run only affected compiled suites; before release, run the full suite through the guarded launcher. Do not execute independent DB suites concurrently against the same schema. Add new tests to the full-suite script so crash/usage regressions cannot remain optional. CLI/MCP adapter parity belongs in integration tests, not only direct function tests.

## Planned execution branches

```text
Lookup(question, scope)
  |-> accepted evidence -> resolve exact version/correction -> applicable/conflict/review
  |-> legacy candidate -> render unknown scope -> open -> validate before reuse
  |-> known incompatible scope -> exclude
  `-> no match / backend unavailable -> distinct result states

Bind(request, session)
  |-> invalid/missing identity -> typed refusal; zero writes
  |-> existing request key -> original committed result
  `-> lock -> validate open work -> bind + link + repo -> commit
       |-> precommit error -> rollback all
       `-> commit response lost -> reconcile request key; no blind duplicate

Capture(source chunk)
  -> normalize/redact -> durable segment -> atomic cursor manifest
       |-> incomplete frame -> retain bytes; no cursor advance past frame
       |-> invalid complete frame -> explicit quarantine/coverage error
       `-> upload artifacts -> lock/dedupe/bulk events -> commit -> durable ack
            |-> artifact failure -> retain retry bytes; other sessions continue
            |-> DB outage -> local capture continues; backlog visible
            `-> ack lost -> replay; unique event IDs prevent duplicates

Snapshot(job, generation, event watermark)
  -> async Git/private index -> push -> verify exact remote object
       |-> timeout/denied file -> failure state; capture keeps running
       |-> stale generation -> no head advance
       `-> valid generation -> publish checkpoint with original watermark

Usage(invocation)
  -> stable ID + outcome -> local bounded telemetry spool -> idempotent upload
       |-> backend failure -> pending/unknown coverage; user call continues
       |-> telemetry write -> no recursive instrumentation
       `-> wrapper/hook observation -> exact link or unresolved; never guess

Handoff(attempt)
  -> pack available? -> inspect/claim/fork -> verify snapshot/evidence
       |-> unavailable/stale -> explicit stop/recovery for dependent work
       |-> pending mutation -> determine prior outcome before any retry
       `-> deliver continuation + validation -> record terminal outcome
```

## Failure and acceptance matrix

“Existing” below means a relevant test/path was inspected, not that it was run or passes now. Every new row requires failure handling and a user-visible state as part of implementation.

| ID / task | Failure/edge case | Existing coverage | Required assertion and visible result |
|---|---|---|---|
| D1 / T2 | Real funnel question has only unscoped relevant history | Resolver has unresolved-scope warnings; no sufficient candidate result | Expected record in top five labelled candidates; applicable set unchanged. |
| D2 / T2 | Draft/newer/other-product result outranks accepted evidence | Authority/correction tests exist | No authority leakage; known incompatible scope excluded, conflicts retained. |
| D3 / T2 | Partial scope, no scope, empty question, true negative, zero/maximum limit | Extend investigation/MCP tests | Validate input; bounded output; no-match distinct from candidate-only or unavailable. |
| D4 / T2 | Proposal acceptance drops scope or pins first name-matched definition | Finding tests exist; new propagation assertion needed | Explicit scope and exact dependencies preserved; ambiguous definition stays unresolved. |
| D5 / T2 | Legacy enrichment changes downstream authority | Supersession/impact infrastructure exists | Original preserved; evidence acceptance/version checks and impact paths retained. |
| B1 / T3 | Server environment stale/missing, explicit ID malformed, two sessions active | Helper-safety covers missing/stale environment | No fabricated/latest-session fallback; zero writes on refusal; real session recovery instruction. |
| B2 / T3 | Crash after any binding write, lock timeout, simultaneous rebind | Happy-path idempotency/rebind exists | All-or-nothing binding/span/repo state; previous history retained; clear error. |
| B3 / T3 | Commit succeeds but connection drops before reply | New failure injection | Same request key returns original operation; no duplicate declaration or rebind. |
| B4 / T3 | Legacy partial bind, wrong stored harness, unknown provenance | New fixtures | Retry repairs missing span; verified metadata correction logged; unknown is not Claude. |
| C1 / T4 | Process killed before/after spool flush, cursor rename, DB commit, ack, rotation | Existing replay/idempotency is narrower | Restart yields exact admitted event set; no skip or destructive reset. **Critical current gap.** |
| C2 / T4 | Truncated trailing frame, corrupt middle frame, disk full, permission denied | Partial transcript lines covered | Partial preserved; corruption/disk error visible; source cursor cannot skip uncaptured bytes. |
| C3 / T4 | Offline DB, cold connection, helper restart during outage | Extend continuity tests | Local admission independent of Neon; durable backlog count/age; safe retry. |
| C4 / T4 | Duplicate producer IDs within batch and across concurrent uploads | Existing across-upload deduplication | Stable order, no duplicate sequence/event, fresh neighbors retained, transaction rollback tested. |
| C5 / T4 | 10,000 events/100 MiB artifacts plus second live session | New bounded replay benchmark | Bounded memory/queues; fairness and recovery budgets recorded with environment. |
| C6 / T4 | Artifact insert transiently fails after bytes parsed | Existing oversized artifact behavior insufficient | Bytes/hash retained and retried; no false oversize or complete-evidence claim. **Critical current gap.** |
| C7 / T4 | Redacted/over-policy-size artifact, unsupported wrapper shape | Redaction/capture-boundary suites exist | Honest permanent status; no secret enters spool, metric labels, logs, or remote artifact. |
| S1 / T5 | Git push hangs for 60 seconds; child produces excessive output | Snapshot safety tests exist | Capture/heartbeats continue; bounded output; child terminated and job retryable. |
| S2 / T5 | Branch/base/deny-policy change or dirty real Git index | Extend shadow/continuity tests | Private index invalidated; real index untouched; tracked denied files never published. |
| S3 / T5 | Claim changes while snapshot runs; more events arrive | Existing fencing scenarios exist | Original generation/watermark retained; late job cannot advance successor or claim later coverage. |
| S4 / T5 | Push acknowledged locally but remote verification fails | Existing verification logic | No verified timestamp; actionable unavailable snapshot state; analysis-only is not a failure. |
| U1 / T6 | Direct, nested, concurrent, bracket-notation, dynamic, conditional wrapper calls | Static parser tests exist | Executed fixture calls reconcile exactly once; unexecuted/static candidates excluded. |
| U2 / T6 | Refusal, timeout, retry, camel/snake error result; missing inner ID | New invocation integration suite | Correct logical/attempt distinction, terminal outcome, explicit unknown correlation. |
| U3 / T6 | Usage DB unavailable, disk full, queue cap, recursive SQL logging | New usage fault suite | Core read unaffected; bounded telemetry; visible loss/pending counters; zero recursive events. |
| U4 / T6 | SELECT returns zero; brief reads automatically; maintenance queries | New purpose fixtures | Correct SQL/read classification; none mistaken for a completed handoff. |
| H1 / T7 | Brief section times out; query outlives response | Current code returns empty | Unavailable distinct from empty; outstanding work cancelled/released; pool remains usable. |
| H2 / T7 | Machine silent, asleep, restarted, or clock skewed | Heartbeat tests partly relevant | Offline/unknown explicit; skew flagged; no fabricated online SLI denominator. |
| H3 / T7 | Proposed state or missing Git source in a work pack | Recordpack tests exist | Proposed label persists; missing source reported; no stale copy promoted in Neon. |
| H4 / T7 | Pending mutating operation when successor resumes | Resume suite exists | Investigate original outcome before retry; terminal handoff evidence separate from opening pack. |
| R1 / T8 | Upgrade interrupted, old client connects, rollback after new spool data | New migration compatibility scenario | Additive schema works with old clients; compatibility reader preserves all pending bytes. |
| R2 / T8 | Database loss with Git knowledge still present | Restore drill required | Restore to isolated target; verify records/events/artifact hashes and identify measured recovery window. |
| R3 / T8 | One healthy machine masks the other's failure | Live pilot, no fixture substitute | Separate 72-hour gate report and successful analysis/code handoffs in both directions. |

## Required release evidence bundle

Keep synthetic fixtures and regression code in the repository. Store real-session evidence in permission-appropriate retained artifacts; commit only sanitized summaries and exact record/artifact references.

1. Release commit, schema/spool versions, runtime versions, and per-machine install/hook verification.
2. Test commands, isolated DB identity (no credential), suite results, fault-injection seeds, and baseline versus candidate timings.
3. Original audit queries classified as known-answerable/true-negative/undetermined, expected record IDs, and candidate/authority outputs.
4. Event-set/hash comparisons for each kill/restart point, artifacts, queue/memory/fairness measurements, and unresolved coverage.
5. Upgrade/rollback/restore transcripts with secrets removed; latest recoverable event and verified snapshot watermarks, plus measured restore duration. State any unprotected recovery window explicitly.
6. Per-machine canary sample counts, percentile calculations, active-online denominator construction, offline/unknown exclusions, and telemetry reconciliation.
7. Four real handoff attempt IDs with author direction, source/destination evidence, code/evidence verification, delivered result, terminal outcome, and user confirmation status.

Release owner marks each engineering-plan gate passed/failed/unknown. Any failed or unknown P1 gate keeps the release in pilot. Do not relabel proposed findings as accepted, erase failed handoff attempts, or exclude online stalls to satisfy a target.
