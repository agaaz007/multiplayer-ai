# Ledger reliability implementation

Date: 21 September 2026. Status: implemented locally; production rollout and two-machine acceptance remain pending. This report updates the [engineering plan](production-readiness-2026-09-20.md), without changing its release gates.

## What changed

| Task | Implemented behavior | Remaining release evidence |
|---|---|---|
| T1 — contracts and safe fixtures | Explicit availability, verified identity provenance, usage traffic classes and capture watermarks. A guarded launcher owns a disposable local Postgres cluster; destructive tests require its database marker. | Inventory and verify the actual running versions, hook trust, repository permissions and backlog on both machines. |
| T2 — discovery | Structured investigation returns bounded legacy candidates separately from applicable authority. Candidates carry exact versions and scope gaps. Proposals retain scope and resolve exact accepted definition dependencies. | Replay and adjudicate the remaining audit questions; monitor relevance in ordinary work. |
| T3 — binding | Bind/new operations are transactional, serialized per session and idempotent by request key. Lost commit acknowledgments are reconciled; ambiguous outcomes stay explicit. Real harness identity replaces guessed defaults. | Verify identities and retries through both installed MCP hosts. |
| T4 — capture | Checksummed durable segments and source cursors, bounded fair admission/upload, transactional event deduplication, retained artifact retries, helper leases and explicit disk limits. | Measure online latency, backlog drain and coverage on both machines. |
| T5 — snapshots | Separate bounded worker processes, parent-death cleanup, persistent private indices, sanitized snapshot ancestry and fenced publication. Resume selects an exact verified checkpoint rather than borrowing a session timestamp. | Verify remote Git access, fresh-worktree recovery and snapshot latency in permitted real repositories. |
| T6 — usage | MCP/CLI invocation outcomes, source references and classified Postgres operations are recorded through a separate bounded spool. Reports separate intentional reads, automatic briefs, writes, maintenance, author and traffic class. | Deploy instrumentation before claiming complete weekly counts; reconcile unknown traffic and telemetry backlog. |
| T7 — handoffs | Empty and unavailable reads differ. Continue/fork produces an attempt; completion needs fresh destination-session validation/result evidence and pending-operation reconciliation. Code handoffs require verified source snapshots. | Complete four real handoffs: analysis and code, one each in both directions. |
| T8 — release | Guarded regression/fault tests, synthetic database/artifact/Git restore tests, operational commands, pause controls and rollout/recovery instructions. | Versioned installation, credential-rotation follow-through, authorized live-backup restore and 72-hour canary. |

The audit's known false dead end is now a regression case: its funnel question surfaces the retained relevant legacy finding among the first five candidates. That establishes discovery for this case, not a general relevance score or acceptance of the legacy finding.

## How to validate

Run `npm run test:all` with a local PostgreSQL installation containing pgvector. Set `LEDGER_TEST_PG_BIN` when those binaries are outside PATH. The launcher creates and destroys only its own local cluster, marks traffic as evaluation, isolates configuration and disables real classifier-provider fallback. `npm run test:production` provides a smaller availability, binding/usage and handoff check.

New fault coverage includes local spool crash boundaries and corruption, concurrent upload deduplication, artifact retries, snapshot timeout and parent termination, denied files in snapshot ancestry, stale snapshot publication, lost helper state with deleted source transcripts, ambiguous binding commits, timed-out database reads, usage replay, and exact source/destination evidence for handoffs. Restore checks compare database rows and artifact hashes and clone a synthetic Git backup.

The local regression log is `.context/production-full-tests.log` (gitignored). A successful local run does not establish the live backup's recoverability, either machine's online capture SLO, or a completed teammate handoff.

## Compatibility and known limits

- Git remains the knowledge authority. No existing legacy finding is automatically accepted, rewritten or assigned guessed scope.
- Postgres changes are additive. Apply the candidate migration and restart the actual MCP/helper runtimes during rollout.
- Spool v2 requires a compatible rollback runtime. Preserve original v1 inputs and all pending segments; an old v1 writer must not resume against migrated state.
- Rewritten/rotated transcripts stop visibly pending source-generation repair. Unsupported Codex offloaded-output layouts remain unavailable. Neither is automatic recovery.
- Snapshot history is isolated to prevent denied files leaking through parent commits. Restore into a fresh detached worktree and port reviewed paths against the recorded base; do not merge/rebase the snapshot history or apply full-tree deletions.
- Usage reports measure observed calls and operations. Returned rows, agent-reported references and evidence-backed handoff statuses do not prove time saved or independent human verification. Disabled, missing or queued telemetry is a coverage gap, not zero use.
- No production database migration, credential change, runtime deployment or live-backup restore is claimed by this implementation.

Follow the [runbook](runbook.md#reliability-release-september-2026) for installation, telemetry classification, health commands, bounded rollback, handoff completion and final release evidence.
