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

### Install the capture helper, hooks and MCP server from a stable path

**What:** Run the launchd helper, the Claude/Codex hooks and the Ledger MCP server from a versioned install (for example a global npm install or `~/.ledger/bin`), not from a Conductor worktree's `dist/`.

**Why:** Every hook, the MCP server and the helper on Agaaz's machine execute `richmond-v1/dist/cli.js`, so running `npm run build` in that worktree deploys half-finished code to every live session.

**Context:** Found 2026-09-13. `ledger-repo-zip` is a symlink to `richmond-v1`. `src/install.ts` writes absolute `node …/dist/cli.js` commands resolved from wherever `ledger install` ran. Test builds for the 2026-09-13 safety fixes went to `dist-safety/` to avoid a live deploy. Start by making `ledger helper install` and the hook installer refuse, or warn, when `cli.js` sits inside a git worktree.

**Effort:** M
**Priority:** P1
**Depends on:** None

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

### Clarify API-B response fields and run a stage-B-only rerun

**What:** State in API-B that execute and `GET /jobs/ID` return the job including `state` and `receipt_id`. Separately, run stage B only from one frozen Ledger A tree: Ledger as configured vs the no-memory control, 4-5 sessions each. Score response-shape omissions without model calls.

**Why:** Ledger's scored engineering losses were response-shape omissions on an under-specified contract, and whether Ledger context raises that rate is only about 60% settled.

**Context:** Finding fnd-20260913-ledger-s-engineering-check-failures-were-respons-dwoi.
- v2: a grader bug, already corrected; Ledger ties every arm.
- v3: Ledger B omitted `receipt_id` on GET, and C and D inherited it.
- The rerun must happen before the contract is clarified. With the clarified contract, both explanations predict a pass.
- Full diagnosis: the T0 report from the 2026-09-13 review.

**Effort:** M
**Priority:** P1
**Depends on:** None

## Performance

### Move shadow push and verify off the serial helper pass

**What:** Keep the local shadow commit in the pass, but run `git push` and `ls-remote` verification on an async queue with a small concurrency limit and per-operation timeout.

**Why:** One slow remote currently blocks capture and heartbeats for every session on the machine.

**Context:** src/continuity/shadow.ts:73 runs git through execFileSync with a 60 s timeout and shadow.ts:141 blocks on `sleep 1`, inline per session in src/helper/daemon.ts:384. Deferred by the 2026-09-13 north-star review (outside-voice tension X8) as premature for two users. Revisit when a helper pass regularly exceeds its interval or when multi-repo snapshots ship.

**Effort:** S
**Priority:** P3
**Depends on:** Helper watchdog (T1)

### Replace full-history scans and N+1 queries on continuity hot paths

**What:** Fetch the last error with an error predicate and `order by seq desc limit 1`, count files with GROUP BY, batch thread summaries, bound the reconciled-id list, and insert spool batches with one multi-row statement.

**Why:** Turn checkpoints and resume packs reload every tool result and file event per session, and outage catch-up costs one round trip per event.

**Context:** src/helper/daemon.ts:151 and src/continuity/resume.ts:132 load all tool.finished rows; daemon.ts:156 loads all file.changed rows; src/continuity/store.ts:197 runs summarizeThread with four queries per thread; daemon.ts:366 scans an unbounded array; store.ts:98-105 inserts one row per await. Deferred by the 2026-09-13 review (X8).

**Effort:** S
**Priority:** P3
**Depends on:** Shared pack sections (T3)

## Continuity helper

### Persistent snapshot index per session, and git off the event loop

**What:** Keep each session's shadow-commit index file between snapshots instead of a fresh temp index, and run the helper's git commands asynchronously.

**Why:** A fresh temp index has no stat cache, so each snapshot re-hashes the whole tracked tree. The synchronous git calls block the event loop, so database connects and the claim heartbeat time out.

**Context:** Measured 2026-09-13:
- A snapshot-style `git add -A` takes 64 s in `i-want-to-build-this-sdkf/cancun` and under 1 s in `richmond-v1`.
- 47 quiet unbound sessions in cancun kept every helper pass past its 900 s deadline, until quiet sessions stopped being snapshotted.
- A live session in a large repo still pays the 64 s every snapshot cadence.
- `src/continuity/shadow.ts` creates the temp index with `fs.mkdtempSync` and runs git via `execFileSync`.
- This supersedes the P3 "move shadow push and verify off the serial helper pass" item.

**Effort:** M
**Priority:** P1
**Depends on:** None

### Fix the work-record classifier on Agaaz's machine

**What:** Make the classifier's extractor run: upgrade the Codex CLI (v0.149.0), set `extractor: "claude"` in `~/.ledger/config.json`, or pin a model the installed CLI supports. Then surface extractor failures in the brief, not only in `helper.log`.

**Why:** Every classification since at least 2026-09-09 has failed, so work records get no proposed state updates on this machine. Accepted decisions and unresolved actions depend on those records.

**Context:** Recent examples in `~/.ledger/helper.log`:
- `classify df595c6d: classifier failed: codex exec --ephemeral: OpenAI Codex v0.149.0` (2026-09-13T16:11Z)
- the same failure at 16:30Z

The outside-voice Codex run the same day failed with "The 'gpt-6-astra' model requires a newer version of Codex".

**Effort:** S
**Priority:** P1
**Depends on:** None

## Completed
