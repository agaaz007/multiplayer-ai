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
| Work records: many-to-many session→record contributions, state updates with provenance | **in progress** (wave 1) | `src/continuity/records.ts` |
| Compaction summaries captured as events; Codex structured completion events as file/exit sources | **in progress** (wave 1) | `src/continuity/events.ts` |
| Evidence query tools (`ledger_events`, `ledger_artifact_get`), recency-shaped pack, compaction spine | **in progress** (wave 1) | `src/continuity/resume.ts`, `src/mcp.ts` |
| Classifier at turn checkpoints: spans → records, proposed state updates, unassigned surfaced | planned (wave 2) | `src/continuity/classify.ts` |
| Retrieval by record across sessions and teammates; record tools; Open work + Unassigned in brief | planned (wave 2) | `src/continuity/resume.ts`, `src/mcp.ts` |
| Rachit's machine enrolled; real interrupted handoff test | pending Rachit | runbook |
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

---

## 5. Open questions

- Object storage: not needed until an artifact exceeds 8 MB; none has.
- Mosaic: revisit if tailing proves fragile on Rachit's machine; its replica could replace tail-and-upload.
- Codex `exec` wrappers with dynamically built commands are stored as JS source, not shell; acceptable for now.
- Neon password was pasted into chat on 2026-09-08; rotate after the pilot.
- Whether the classifier should run per turn (cost, latency) or per session end; start per turn with a cap.

---

## 6. Changelog

- **2026-09-08** · Commit `41e7c0b`: continuity layer, parser fixes, hook fix, draft visibility, records interface stub. Wave 1 agents started on records, emitter, and query tools. Spec v1.2 adds the work-records requirement (D-009).
- **2026-09-08** · Neon schema migrated; launchd helper installed on Agaaz's machine; this session captured and resumable; Ledger decision and change recorded.
- **2026-09-07** · Phase 0 corpus scan; two Codex parser fixes; spec v1.0 then v1.1.
