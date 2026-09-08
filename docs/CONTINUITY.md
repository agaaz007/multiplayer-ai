# Execution continuity: decisions, learnings, features

The single maintained record for the continuity layer of `@tranzmit/ledger`. Update it whenever a decision is made, a feature lands, or something is learned the hard way. Canonical spec and runbook live beside it in `docs/continuity/`; the Ledger itself holds the formal decision records referenced below.

Last updated: 2026-09-08

---

## 1. What this is, in one paragraph

Ledger's four object types (definition, finding, change, decision) carry a team's **conclusions** across machines and harnesses. Execution continuity carries **unfinished work**: what a teammate's agent was doing when it stopped, well enough that a different person, in a different harness, on a different machine, can continue. A local helper captures every session automatically from the harness's own transcript, snapshots the worktree to a hidden git ref, and uploads to a shared Postgres. Agents discover and continue work through Ledger MCP tools. Nothing depends on an agent remembering to save.

Documents:
- `docs/continuity/spec.md`: the implementation spec (v1.2)
- `docs/continuity/runbook.md`: what is running, how to check, how a teammate joins, how to stop
- `docs/continuity/phase0-report.md`: the transcript coverage scan that gated the build

---

## 2. Features and status

| feature | status | where |
|---|---|---|
| Transcript tailing for Claude Code and Codex, incremental from a byte offset | live | `src/continuity/events.ts` |
| Codex `custom_tool_call` and `response_item/message` parsing (previously 27% of Codex tool calls invisible) | live, tested | `src/transcript.ts`, `src/continuity/events.ts` |
| Shadow commits every 30 s to `refs/wip/<author>/<session>`, denied paths removed from index, tree validated, remote-verified | live, tested | `src/continuity/shadow.ts` |
| Shared store on Neon Postgres: threads, sessions, events, checkpoints, claims, artifacts, notifications | live | `src/continuity/db.ts`, `src/continuity/store.ts` |
| Advisory claims with monotonic per-thread generation; stale generation routed to a fork with a notice | live, tested | `src/continuity/store.ts` |
| Head-update rule: checkpoint advances head only under the live claim at the current generation | live, tested | `src/continuity/store.ts` |
| Snapshot and turn checkpoints with remote-verified timestamps | live | `src/helper/daemon.ts` |
| Artifacts for tool outputs above the 1,200-char preview, inline up to 8 MB, sha256-deduplicated | live, tested | `src/helper/daemon.ts` |
| Local spool with ack; offline accumulation and ordered replay | live, tested | `src/helper/spool.ts` |
| Hook signals (Stop, PreCompact, SessionEnd) and per-tool index for reconciliation | live | `src/hooks.ts`, `src/helper/signals.ts` |
| Hook index vs transcript reconciliation with a 60 s pending window before a confirmed gap | live | `src/helper/daemon.ts` |
| Auto-bind rule: own thread on repo+branch only; zero candidates + instruction creates; several leaves unbound | live, tested | `src/helper/daemon.ts` |
| Resume pack, budgeted, with loss window, pending operations, intervening git diff, superseded decisions, bootstrap | live, tested | `src/continuity/resume.ts` |
| MCP tools: `ledger_threads`, `ledger_thread_get`, `ledger_resume`, `ledger_thread_start`, `ledger_thread_bind`, `ledger_thread_note`, `ledger_release` | live | `src/mcp.ts` |
| CLI: `continuity`, `helper`, `threads`, `resume`, `thread` | live | `src/cli.ts` |
| Brief sections: Open threads, Ledger notices | live | `src/continuity/brief.ts` |
| launchd agent `com.tranzmit.ledger.helper` with KeepAlive | live on Agaaz's machine | `src/install.ts` |
| Regex redaction and deny globs before spool | live, tested | `src/continuity/redact.ts` |
| All drafts shown in brief and README, labeled not in force | live, tested | `src/query.ts`, `src/views.ts` |
| Stop checkpoint clears on receipt-style record responses | live, tested | `src/hooks.ts` |
| Work records store: three tables, span links, append-only state updates with provenance, projection, FTS over events | landed (wave 1), 10 checks green | `src/continuity/records.ts`, `src/continuity/db.ts`, `src/selftest-records.ts` |
| Compaction summaries captured as events (Claude text, Codex mostly markers); Codex `patch_apply_end` / `exec_command_end` / `mcp_tool_call_end` as file-change and exit-code sources; linear-cost tailing | landed (wave 1), 10 checks green, validated on 40 real files | `src/continuity/events.ts`, `src/selftest-events.ts` |
| Evidence query tools (`ledger_events`, `ledger_artifact_get`), recency-shaped pack (first 3 + last 8), compaction spine, recent files, sources line, staged budget shrink | landed (wave 1), 8 checks green, verified over MCP stdio | `src/continuity/resume.ts`, `src/continuity/evidence.ts`, `src/selftest-resume.ts` |
| Classifier at turn checkpoints: spans → records (suggested links), proposed state updates with evidence, unassigned computed; validated item by item; detached from the capture pass with an in-flight guard, 120 s per-session rate limit, `continuity.classify=false` or `LEDGER_CLASSIFY=0` to disable | landed (wave 2), 16 checks green incl. daemon-level | `src/continuity/classify.ts`, `prompts/operations/classify.md`, `src/helper/daemon.ts`, `src/selftest-classify.ts` |
| Retrieval by record across sessions and teammates: record pack (state projection with PROPOSED flags, contradictions side by side, evidence across sessions, superseded Ledger refs flagged, unassigned spans, bootstrap), `ledger_resume(record_id)`, `ledger_records`, `ledger_record_get`, `ledger_record_link`, `ledger_record_update` (propose/confirm/reject), `ledger_record_start`, `ledger_unassigned`, `ledger_evidence_search`; Open work + Unassigned work in the brief; CLI `records`, `record …`, `unassigned`, `resume --record` | landed (wave 2), 20 checks green incl. spec acceptance 28–33, verified over MCP stdio (27 tools listed) | `src/continuity/recordpack.ts`, `src/mcp.ts`, `src/cli.ts`, `src/continuity/brief.ts`, `src/selftest-recordpack.ts` |
| Helper git operations work without a terminal: `gh auth git-credential` when `gh` is installed, prompts disabled, override via `LEDGER_GIT_CREDENTIAL_HELPER` | landed (8 Sep, after the launchd push failure) | `src/continuity/shadow.ts` |
| Resumed sessions re-acquire their thread claim; subagent transcripts have their own identity and never snapshot the parent's worktree; push/verify failures surface in the pass log | landed (8 Sep) | `src/helper/daemon.ts`, `src/continuity/events.ts` |
| Live classifier run on this session: 251 events → 15 spans linked, 3 records created, 7 updates proposed, 4 unassigned, 0 rejected, 229 s | done once, 8 Sep | Neon |
| Classifier lag disclosed in every resume and record pack ("captured through seq N, classified through seq M") | landed (8 Sep, required by eval L02) | `src/continuity/resume.ts`, `src/continuity/recordpack.ts` |
| Helper ignores repo roots under `continuity.exclude_paths` (evaluation fixtures) | landed (8 Sep) | `src/helper/daemon.ts`, `src/store.ts` |
| Continuity evaluation adapter for the kit: fixture, origin and successor drivers, collector, case runners, condition plugins (ours, gbrain), matrix comparison | **in progress** (three agents, 8 Sep) | `src/eval/`, `eval/kit/` |
| Rachit's helper enrolled and uploading (Codex 0.153.4, MacBook-Pro.local); first sessions were in a non-repo folder | done 8 Sep; real handoff test pending a session in the HiAstro checkout | Neon |
| Real interrupted handoff test across two machines | pending Rachit's next HiAstro session | runbook |
| Postgres backup and restore drill | planned | |

---

## 3. Decisions

Each entry: what was decided, the options that lost, and the Ledger record id where one exists. Newest last.

### D-001 · 2026-09-07 · Ledger models conclusions, not execution state; that gap is the pilot's real problem
Assessment of the shipped Ledger against "can my Claude resume Rachit's Codex from last night." Conclusion continuity works; execution continuity did not exist. Options that lost: treating the transcript fallback as sufficient (it only fires on data queries and produces lossy drafts). Ledger: `fnd-20260907-tranzmit-ledger-audit-two-fallback-sessions-code-mxnm`.

### D-002 · 2026-09-07 · "Slack for agents" is the wrong frame; shared working memory is the right one
From the Mosaic memo: two agents with identical context are the same agent; continuity is a property of the store. Kept from Slack: attention routing (notices) and human principals (authors own claims). Lost: agents messaging agents in channels.

### D-003 · 2026-09-08 · Local capture helper + shared Postgres + hidden git refs, not a hosted runner
Options that lost: hosted runner MVP (centralizes execution, kills Conductor parallelism, 5 to 8× the build), investigation DAG in git with agent-written checkpoints (dies with the agent, no CAS), hooks-only capture, Mosaic as transport, do nothing. Ledger: `dec-20260907-build-execution-continuity-as-a-local-capture-he-ys7o`.

### D-004 · 2026-09-08 · Transcripts are the primary observation source; hooks are the index
Measured: transcripts carry prompts, assistant text, reasoning, full tool inputs, results to 240 KB; hooks carry tool name/input/response only, and the journal kept 200 chars. Reconcile the two per session; a mismatch is pending for 60 s before it is a confirmed gap. Ledger: `fnd-20260907-local-claude-codex-transcripts-are-complete-enou-4te7`, `def-20260907-transcript-capture-coverage-for-local-claude-cod-mzn5`.

### D-005 · 2026-09-08 · Six spec corrections from Agaaz's review adopted before build
Distinct event ids for request and result; loss window computed from remote-verified timestamps, never a constant; unbound sessions still snapshotted; head-update rule requires live claim and current generation; `git rm --cached` for denied paths after `read-tree`; 8 MB inline artifact cap with explicit gaps above. Spec v1.1.

### D-006 · 2026-09-08 · Thread is the unit of continuity, not session; knowledge stays in git
Sessions are probes; threads persist across harnesses. Definitions, findings, changes, decisions never move to Postgres; records reference them by id and version.

### D-007 · 2026-09-08 · Reasoning blocks are never uploaded
Prompts, assistant text, tool inputs, previews, file paths, and snapshots are. Thinking is the model's private working and is large.

### D-008 · 2026-09-08 · Notifications are delivered through the next hook, not a terminal push
Harnesses expose no channel for pushing into a live terminal. The helper writes to a local log; SessionStart and `ledger_brief` show it under "Ledger notices."

### D-009 · 2026-09-08 · Work records are a layer above threads; a session contributes to many records
From the "shared accumulation, then task-directed retrieval" review. Threads remain the physical unit (claims, snapshots, per session and repo). Work records are the logical unit: many-to-many with sessions via event spans, each with its own append-only state updates carrying provenance and a `proposed` → `confirmed` status. Compaction summaries are evidence, never the memory; nothing is deleted at compaction. Options that lost: a repeatedly summarized conversation as the memory; one thread per session. Spec v1.2 §13a. Ledger: `dec-20260908-add-a-work-records-layer-above-threads-keep-post-cqr7` (covers D-009 and D-010).

### D-010 · 2026-09-08 · Postgres + git stay the stores; no graph database
The record graph is small and shallow: five or six edge types, one or two joins per question, recursive CTE for anything deeper. Retrieval is the hard part and lives in Postgres (FTS now, `pgvector` if needed). Git keeps accepted knowledge and code. A graph view for humans may be derived; a graph store is not the system of record. Revisit trigger: hundreds of records with dense dependency edges and routine five-hop questions; first stop would be Apache AGE on the same Postgres.

### D-012 · 2026-09-08 · Adopt the continuity evaluation kit as the acceptance gate; first benchmark is ours vs gbrain
The kit (`eval/kit/`, 12 cases in 5 levels, private oracle, exact-evidence scoring, level-gated report) replaces the "3 of 3 handoffs" gate in D-003's confirmation. The first benchmark compares two memory substrates for a fresh successor with the same model, prompt, and repo: **ours** (27 Ledger tools, brief, snapshot worktree) versus **gbrain** (the same normalized origin events ingested into an isolated PGLite brain, gbrain MCP tools, repo at master). Options that lost for the first round: mem0 (not installed, no key), legacy-Ledger and GitHub-only and last-summary-only baselines (deferred to keep the first matrix small; the adapter's condition plugin makes them cheap to add later). Phase 1 scope: D01 to D03, R01, R02, E01, Codex to Claude, one repetition; C01, C02, L02 are ours-only by construction; L01 waits on forced compaction. Adapter lives in `src/eval/`, TypeScript, invoked by the kit as an argv. Successor model held fixed (Sonnet 5 for Claude; Codex default), origin turns on Haiku 4.5. Ledger: `dec-20260908-adopt-the-continuity-evaluation-kit-as-the-accep-xxm4`.

### D-011 · 2026-09-08 · Build in waves with parallel agents on partitioned files
Wave 1: records layer, emitter improvements, evidence query tools. Wave 2: classifier and record-level retrieval, which depend on the records interface. Interface fixed first in `src/continuity/records.ts` so consumers and implementers share one contract. Each agent builds to its own `dist-<x>/` and tests against its own local database to avoid clobbering.

---

## 4. Learnings

Dated, concrete, with the evidence. Add one whenever reality disagreed with the plan.

- **2026-09-08 · The Codex parser missed 27% of tool calls.** `custom_tool_call` (`exec` with JS-wrapped shell, `apply_patch`) was invisible; outputs are arrays of text parts. Found by the corpus scan, not by anyone noticing. The hook-vs-transcript reconciliation exists so the next format drift is caught on the first session.
- **2026-09-08 · Codex has two message formats in the wild.** Older rollouts use `event_msg/user_message`; newer use `response_item/message` with roles, including a `developer` role that carries injected AGENTS.md text. Both are parsed; the legacy shape is used only when the new yields nothing, so a file with both is not double-counted.
- **2026-09-08 · Harness-injected text masquerades as user prompts.** Skill bodies, system notifications, stop-hook feedback, and compaction summaries appear as `user` messages. Filtered by prefix; the list will grow.
- **2026-09-08 · `git read-tree HEAD` carries tracked secrets into a temporary index.** `add` exclusions do not remove indexed entries. Fix: `git rm --cached` denied paths after read-tree, then validate the written tree. Caught in review before it shipped.
- **2026-09-08 · Request and result share a `call_id`.** Using it as the event id would have deduplicated every tool result. Fixed with `:requested` / `:finished` suffixes.
- **2026-09-08 · Receipt-style tool responses broke the Stop checkpoint.** The hook matched "Recorded …" text; record tools now return "Saved …" receipts, so four records in a row never cleared the debt. Fixed to read `receipt.record_id`. The general lesson: any hook that pattern-matches a tool's prose output will break when the prose changes; prefer structured fields.
- **2026-09-08 · pg 8.23 treats `sslmode=require` as `verify-full` and warns.** Strip libpq params from the URL and pass `ssl: { rejectUnauthorized: true }` explicitly.
- **2026-09-08 · The helper survives a laptop offline period.** One DNS failure logged, then the session was picked up on resume; events since were uploaded. The "un-end on new events" rule mattered here.
- **2026-09-08 · Both harnesses already write model-authored compaction summaries.** Claude Code writes a structured document (observed 15 KB) as a user message flagged `isCompactSummary`; Codex writes `compacted` items. These are high-value evidence written while the model still held the full context. Sessions reach 105 MB, so they exist exactly where they matter. Previously discarded; being captured in wave 1.
- **2026-09-08 · The resume pack kept the wrong end of long instruction lists.** Chronological from the front preserves the goal and drops what is recent. Recency-shaped: first instruction plus the last N.
- **2026-09-08 · Shell data-tool matching is coarse.** `command -v psql` and a test string with a literal `psql` tripped the checkpoint. Tighten to require an actual query argument.
- **2026-09-08 · A contract that takes `Pool | PoolClient` cannot open its own transaction.** The records layer needed atomic "insert update + bump record version" and got it with single-statement data-modifying CTEs, which are atomic on a Pool and compose inside a caller's transaction. Cheaper than widening the contract to `pg.Pool`.
- **2026-09-08 · `drop table … cascade` in one test suite silently strips foreign keys from tables it does not know about.** The continuity suite dropped seven tables; the records suite's `cont_record_links_session_id_fkey` vanished from the shared test DB. Every suite now drops all ten. Per-agent test databases limited the blast radius; the rule is that any suite that resets schema must name every table.
- **2026-09-08 · The first tailing loop was quadratic.** `Buffer.byteLength(text.slice(0, pos))` per line re-encoded the prefix every time; on the 30 to 105 MB sessions in the corpus it would have stalled the helper. Rewritten to walk the raw buffer: 40 MB of Claude transcripts stream in 86 ms.
- **2026-09-08 · Codex compaction rarely carries a summary.** Of 1,527 `compacted` lines in the corpus, `message` is empty in all and only about 7 have an assistant item in `replacement_history`. Claude's `isCompactSummary` messages (5 to 20 KB, 22 in the corpus) are the real compaction spine. Codex compaction events are still emitted as markers with window ids.
- **2026-09-08 · Codex `exec_command_end` disappears from rollouts after July 2026.** Newer sessions route shell through the `exec` JS wrapper whose sub-calls carry `exec-<uuid>` ids that never match a request id. Exit codes attach where they can; otherwise `tool.result_meta` carries them with a best-effort enclosing call id. Format drift is the norm, not the exception; the hook-index reconciliation exists for this.
- **2026-09-08 · `seq` is per session, so a thread-level cursor is ambiguous.** Thread queries page by insertion id and say so; pointers that must be exact (the compaction fetch) use `session_id`. Any future record-level cursor should carry `(session_id, seq)` pairs.
- **2026-09-08 · "Full text via ledger_events" was a lie until previews became adjustable.** Default previews are 200 chars; the pack now emits a fetch call with `preview_chars` sized to the summary. Every "omitted, fetch with X" pointer must be checked against what X actually returns.
- **2026-09-08 · A synchronous model call inside the capture pass would have stalled every other session's snapshots for the model's latency.** The extractor was `execFileSync`. Added `runExtractorAsync` and detached the classifier from the pass with a per-session in-flight guard; `helperOnce` only waits for it when a caller asks (tests pass `classifyWaitMs`). `PassSummary.classified` therefore counts starts, and outcomes are logged when the call returns.
- **2026-09-08 · Unassigned spans are not re-presented to the classifier on later turns.** Progress advances past them; they surface through `unassignedSpans` and the brief, and an explicit link or a `sinceSeq` override re-classifies. A late instruction that clarifies earlier work does not retroactively re-place it. Acceptable for now; noted as a known limit.
- **2026-09-08 · Candidate state summaries cost two queries per record per classification.** Fine at the 120 s cadence with ≤30 candidates; a batched projection is the fix if it ever shows in the pass time.
- **2026-09-08 · Under launchd, HTTPS git push cannot get credentials from the macOS keychain.** Every snapshot after the helper moved to launchd was committed locally, pushed nowhere, and honestly recorded as `snapshot_not_verified: could not read Username for 'https://github.com': Device not configured`. The pass log did not surface it because a local commit existed. Last night's verified pushes came from a shell. Fix: remote git operations use `gh auth git-credential` with prompts disabled, and any push or verify failure is a pass error. The honesty fields worked; the log did not. Lesson: a "saved" claim must be checked against the remote, and the daemon must complain loudly when it is not.
- **2026-09-08 · Claude subagent transcripts carry the parent's `sessionId`.** They live at `<session>/subagents/agent-<id>.jsonl`, and keying sessions on `sessionId` collided a subagent with its parent: one state entry, two files, an offset that thrashed, ~800 events re-spooled every pass (deduplicated on upload, so the store stayed clean) and a 19 MB spool. Fix: session identity is the file, sidechain is decided by the file's first message line on a read from offset zero, and sidechain sessions never snapshot the parent's worktree. Lesson: an identity field that is convenient in the data is not necessarily unique in the data.
- **2026-09-08 · A session that resumes after the quiet-end release kept working without a claim.** Its checkpoints published but never advanced the head, and "code saved through" froze at last night. Fix: on resume, re-claim the own thread if nobody else holds it, otherwise route to a fork with a log line. The morning-after case is the pilot's whole point; it needed this.
- **2026-09-08 · The real classifier took 229 s on a 251-event slice and hit the 60k-char prompt cap.** It produced accurate records with correct evidence seqs for the wave-two work. The latency vindicates detaching it from the capture pass; the cap means long turns get the most recent 400 events, with the gap named. Cost per turn checkpoint is one model call; the 120 s rate limit keeps it to a few per hour of active work.
- **2026-09-08 · First teammate enrollment: Rachit's helper uploaded within minutes, and the reconciler produced 19 false gaps.** Codex 0.153.4's PostToolUse hook reports each shell sub-command inside the `exec` JS wrapper as `Bash` with an `exec-<uuid>` id; the transcript carries the wrapper call as `call_…`. All 31 wrapper calls were captured; the sub-call ids matched nothing and were flagged. Fix: sub-call ids are matched to the wrapper and counted, never flagged. The reconciliation did its job of surfacing a mismatch on the first session from a new harness version; the mismatch was in the index, not the capture.
- **2026-09-08 · A teammate's first sessions ran in a Downloads folder, not a git repo.** No repo means no thread, no claim, no snapshot; events still upload. Expected for a setup session, but the runbook now says it explicitly: work inside a git checkout or nothing is snapshotted. The redactor masked the Neon password he pasted into Codex.
- **2026-09-08 · An "unassigned" marker link still needs a host record.** `RecordLink.record_id` is non-null, so a span nobody can place has nowhere to sit as a row; the records layer computes unassigned spans from coverage instead. Fine for now; the classifier reports unassigned spans in its result rather than persisting markers.

---

## 5. Open questions

- Object storage: not needed until an artifact exceeds 8 MB; none has.
- Mosaic: revisit if tailing proves fragile on Rachit's machine; its replica could replace tail-and-upload.
- Codex `exec` wrappers with dynamically built commands are stored as JS source, not shell; acceptable for now.
- Neon password was pasted into chat on 2026-09-08; rotate after the pilot.
- Whether the classifier should run per turn (cost, latency) or per session end; start per turn with a cap.

---

## 6. Changelog

- **2026-09-08, later** · Work-records layer complete and live. Five parallel agents on partitioned files: records store (10 checks), emitter with compaction and Codex structured events (10), evidence query tools and recency-shaped pack (8), classifier at turn checkpoints (16), record-level retrieval and tools (20); core suite green; all from one production build. Three new tables migrated to Neon. Fixes found by running it live: launchd git credentials, subagent identity collision, claim re-acquire on resume, classifier detached from the pass. Classifier run once on this session: 3 records, 7 proposed updates. 27 MCP tools. Guides updated.
- **2026-09-08** · Commit `41e7c0b`: continuity layer, parser fixes, hook fix, draft visibility, records interface stub. Wave 1 agents started on records, emitter, and query tools. Spec v1.2 adds the work-records requirement (D-009).
- **2026-09-08** · Neon schema migrated; launchd helper installed on Agaaz's machine; this session captured and resumable; Ledger decision and change recorded.
- **2026-09-07** · Phase 0 corpus scan; two Codex parser fixes; spec v1.0 then v1.1.
