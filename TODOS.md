# TODOS

## Security

### Rotate the Neon continuity database password

**What:** Rotate the shared Neon Postgres password used by every teammate's continuity helper and update each machine's config.

**Why:** The password was pasted into an agent chat on 2026-09-08, so it sits in at least one transcript outside the secret store.

**Context:** docs/CONTINUITY.md open questions says "Neon password was pasted into chat on 2026-09-08; rotate after the pilot." The redactor masked it before spool (CONTINUITY.md learning for 2026-09-08), but the harness transcript on the source machine still holds it. Rotation needs a coordinated config update on Agaaz's and Rachit's machines, then a helper restart on both. Raised during the 2026-09-13 north-star eng review.

**Effort:** S
**Priority:** P1
**Depends on:** None

## Infrastructure

### Postgres backup and restore drill for the continuity store

**What:** Take a backup of the Neon continuity database and restore it into a scratch database, then run a resume pack against the restored copy.

**Why:** Every handoff (events, checkpoints, claims, records, operations) depends on this single store, and restore has never been exercised.

**Context:** docs/CONTINUITY.md feature table lists "Postgres backup and restore drill" as planned with no owner. The 2026-09-13 review found the helper silently stopped for about 39 hours, which shows how quietly the store can fall behind. Start with Neon branch restore, then verify `ledger resume <thread> --inspect` output matches the source database.

**Effort:** M
**Priority:** P2
**Depends on:** None

## Eval

### Unblock teamwork-v3 dispatch after adding baseline arms

**What:** Resolve the two v3 dispatch blockers: the disk reservation versus free space, and the missing native-readiness receipt producer.

**Why:** No scored v3 run can start, so neither the product comparison nor the new Git and handoff-note baselines can produce evidence.

**Context:** Finding fnd-20260912-teamwork-v3-four-product-benchmark-is-not-dispat-bshm: 6.66 GiB free versus a 7.50 GiB reservation, and sequence.py:214 gates every lane on readiness_verified with no producer for native-readiness.json. The 2026-09-13 review (decision 7A) adds control-git and handoff-note arms, which raises the reservation unless lanes run in two batches. Recompute disk_budget.py estimates for the new arm set before freeing space.

**Effort:** M
**Priority:** P1
**Depends on:** 7A baseline arms (eval/teamwork-v3/matrix.py ARMS)

## Completed
