# Tranzmit Execution Continuity — Local Capture Spec

Version 1.1 · 8 September 2026 · Status: Phase 0 in progress; Phases 1–3 proposed
Author: Claude (Fable 5.1) for Agaaz, synthesizing the 7 Sep investigation-DAG plan, the 7 Sep hosted-runner MVP spec, the revised local architecture, the Mosaic memo, and a read of the Ledger source at this branch.

**v1.1 corrections (Agaaz review, 8 Sep).** Six defects in v1.0 fixed in place: (1) request and result shared a `producer_event_id` and would have deduplicated each other; (2) the "30 seconds" loss claim was a constant, not a measurement, and discoverability lagged snapshots by up to five minutes; (3) shadow commits covered only bound sessions while test 16 promised unbound recovery; (4) the head-update rule reopened overwrites after a claim release; (5) `read-tree HEAD` would carry a tracked `.env` into the snapshot because `add` exclusions do not remove indexed entries; (6) the spec itself introduced loss via a 256 KB artifact cap below an observed 278 KB output and "clipped" instructions. Also: a hook/transcript mismatch is "not observed yet" before it is "missing." Each fix is marked **[v1.1]** below.

**Phase 0 status (8 Sep).** Corpus scan complete over 3,056 Claude and 724 Codex files (3.0 GB): zero unparseable lines, zero unknown Claude block types, 11 unpaired tool calls of 116,809 (all in-flight at process death). Two Codex parser gaps found and fixed with tests: `custom_tool_call` (31,600 calls, 44.6% of Codex tool calls and 27% of the combined corpus, previously invisible) and `response_item/message` (newer prompt/reply shape, 26 of 302 sampled files). Full numbers in `.context/phase0/report.md`. **Gate: go.**

**Build status (8 Sep, later).** Phases 1 and 2 are implemented on branch `agaaz007/ledger-repo-zip`, uncommitted, and running on Agaaz's machine. Schema live on Neon (`cont_*`, seven tables). Modules: `src/continuity/{db,events,redact,shadow,store,resume,brief}.ts`, `src/helper/{daemon,spool,signals}.ts`; CLI `ledger continuity|helper|threads|resume|thread`; seven MCP tools; hooks emit checkpoint/end signals and a per-tool index; brief shows Open threads and notices; hidden-draft filter fixed in brief and README. Isolated end-to-end suite `npm run test:continuity` passes 14 checks against local Postgres, including Codex→Claude resume with exact snapshot checkout, quiet-end release, claim CAS, head rule after release, stale-generation fork with notification, tracked `.env` excluded from snapshots, unbound-session snapshot, artifact for long output, idempotent upload. Live: this session was captured (509 events), snapshotted to `refs/wip/agaaz/<session>` on GitHub (remote-verified), checkpointed, and its resume pack renders from Neon. launchd agent `com.tranzmit.ledger.helper` installed with KeepAlive. Phase 3 (Rachit's machine, real interrupted handoff, restore drill) is pending Rachit.

**Implementation notes that refine v1.1.**
- *Thread creation.* Zero own-thread candidates plus at least one human instruction → the helper creates a thread titled from the first line of that instruction. Exactly one candidate → bind. Several → unbound with the candidates named in `coverage.unbound_reason`. Never binds to another author's thread.
- *Notifications.* Delivered by the helper into `~/.ledger/notifications.log`; the next SessionStart or `ledger_brief` on that machine shows them under "Ledger notices." Not a terminal push; harnesses expose no channel for that.
- *Artifacts.* Tool outputs above the 1,200-char preview travel redacted with the event and are stored as `cont_artifacts.inline` (sha256-deduplicated) up to 8 MB; the event keeps the preview and the artifact id. Claude offloaded side files are read and stored the same way when present. Above 8 MB the event carries `oversized` with size and local path.
- *Store access.* Helper and plugin connect to Postgres directly with the per-machine URL in `~/.ledger/config.json` (mode 600) or `LEDGER_CONTINUITY_DB`. No HTTP service in v1. Attribution is by `author` in config, trust-based between the two pilots.
- *Reasoning blocks* are never uploaded. Prompts, assistant text, tool inputs, previews, file paths, and snapshots are.
- *Ended sessions that resume* (laptop wakes) are un-ended by the helper; their uploads route per the generation rule, usually to a fork.

---

## 0. Promise and non-promise

**Promise.** Rachit works in Codex on his laptop on a HiAstro thread. The run stops for any reason. Agaaz, in an existing Conductor session, says "continue Rachit's HiAstro animation work from last night." Agaaz's Claude discovers the thread, claims it, checks out Rachit's exact last-uploaded code into an isolated worktree, reads what was asked, done, tried, pending, and unknown, sees what changed in the project since, and continues. Meanwhile other Conductor agents keep working on HiAstro in other worktrees, unaffected. Rachit's terminal tells him his thread was continued.

**Non-promise.** The successor continues from the last state that left the laptop. It cannot recover edits or tool results that never uploaded. The loss window is bounded and shown, never hidden. A claim protects the shared record; it cannot stop a process on someone else's machine. Model internals are not transferred; only observed evidence is. The narrative summary is generated and unreviewed.

**Why local, not hosted.** The hosted spec bought correctness by centralizing execution: both people move their agents onto a runner, one writer per project, worktrees deferred. That regresses Conductor parallelism, migrates the whole workflow, and is five to eight times the build for two users. The local design keeps agents where they are and accepts advisory claims instead of fencing. For two people this is the right trade. Sections 5 through 7 and 10 of the hosted spec are reused nearly verbatim here; only its runner, lease-fencing, and web UI are dropped.

---

## 1. Architecture

| Component | Responsibility | Where it lives |
|---|---|---|
| Ledger plugin (MCP + hooks) | Discover threads, build resume packs, claim, bind sessions, checkpoint at Stop, brief section | extends `src/mcp.ts`, `src/hooks.ts`, `src/query.ts` |
| Capture helper (daemon) | Tail harness transcripts, shadow-commit the worktree, spool, upload, heartbeat, notify | new `src/helper/`, launchd agent via `src/install.ts` pattern |
| Continuity service | Threads, sessions, events, checkpoints, claims, artifacts; CAS on claims; sequence allocation | small Node HTTP service + Postgres, same repo |
| Git remote | Exact code state on hidden refs `refs/wip/<author>/<session>` | existing project remote |
| Ledger git repo | Definitions, findings, changes, decisions, unchanged | existing `tranzmit-ledger` |
| Local worktree | Execution, with that teammate's environment and credentials | Conductor / Codex, as today |

No hosted runner. No web UI in v1. Object storage deferred (see §12). Postgres is the only new server.

---

## 2. Core model

- **Thread.** The unit of continuity. A goal pursued over time in one repo, across any number of sessions and harnesses. Has a head checkpoint and at most one live claim. Threads can fork.
- **Session.** One harness process run on one machine. Contributes events to at most one thread at a time. May be unbound. Identity: Claude = transcript filename; Codex = `session_meta.payload.id`.
- **Event.** Append-only, normalized observation from a session. Never edited; corrections are new events.
- **Checkpoint.** Immutable snapshot of a thread: event watermark + wip commit + base commit + mechanical structured state + optional narrative + capture gaps.
- **Claim.** Advisory ownership of a thread for continuation. Has a monotonically increasing generation. Protects the record: stale-generation uploads become a fork, never a silent drop or overwrite.
- **Fork.** A new thread linked to a parent checkpoint. Created explicitly by a user, or automatically when a stale-generation session keeps writing.

Sessions are probes. Threads persist. This is the Mosaic memo's model applied to a team of humans who each own their claims.

---

## 3. Capture helper — the hard part

### 3.1 Transcript tailing (primary observation source)

Watch `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl`. Per file, keep a byte-offset watermark. Parse new complete lines incrementally, tolerating a partial trailing line. Refactor `parseClaude` / `parseCodex` in `src/transcript.ts` into streaming emitters that yield normalized events rather than one batch `Evidence`.

Why tailing over hooks: the transcript is the harness's own durable log. It is written whether or not hooks fire, whether or not Codex has trusted them, and it survives the harness process dying. Hooks remain for control (Stop checkpoint request, SessionStart brief and bind). Tailing is for observation.

**Measured on 8 Sep 2026 against real files on this machine.** A Claude Code transcript carries full `tool_use` inputs, full `tool_result` content in-line (observed up to 28 KB), a structured `toolUseResult` (stdout, stderr, `structuredPatch`, `originalFile`), assistant text, thinking blocks, user prompts, `parentUuid` ordering, `isSidechain` for subagents, `gitBranch`, and `stop_hook_summary` system lines. A Codex rollout carries `custom_tool_call` and `function_call` with complete inputs (observed up to 16 KB), outputs in-line up to 278 KB, `reasoning` items, explicit `compacted` markers, and `turn_context`. `PostToolUse` provides only tool name, input, and response; no assistant text, no prompts, no reasoning. The current hook journal keeps 200 characters per event (`summarize(max = 200)` in `src/hooks.ts`). So the hook path is the lossy one today, by design.

**Where transcripts are genuinely lossy, and the fix for each.**
1. Outputs above a size threshold are offloaded to a local side file and the transcript holds a path (six such references in one session). The helper follows the path and uploads under the artifact policy.
2. Harness-side truncation ("Total output lines: N" in Codex). The hook receives the identical truncated payload; this is not a transcript loss and neither path can recover it.
3. Parser drift. The current `parseCodex` handles only `function_call`; in the most recent Codex session 186 of 241 tool calls were `custom_tool_call` and invisible. This risk is real and already biting. Fix below.

**Hooks as index, transcript as content, reconcile.** `PostToolUse` is kept and reduced to a cheap real-time index: `tool_use_id`, tool name, timestamp, and a hash of the input. Tailing supplies content. The helper diffs the two streams per session. A `tool_use_id` seen by the hook but never parsed from the transcript is a parser miss and emits `capture.gap` with the exact id. A tool event parsed from the transcript with no hook record means hooks are not firing for that harness; coverage reports it. Unknown block or payload types emit `capture.gap` rather than being skipped. This makes capture self-checking instead of trusting either source alone.

**[v1.1] Not observed yet is not missing.** A hook index entry with no matching transcript event is `pending` for a grace window of 60 s (transcript writes lag tool completion by up to a few seconds; a slow disk or a large result lags more). Only after the window, or after the session ends, does it become a `confirmed` gap. Gaps carry `status: pending | confirmed` and the resume pack shows only confirmed gaps as gaps, with pending ones as "still arriving."

Normalized event kinds: `instruction.added`, `assistant.message`, `tool.requested`, `tool.finished`, `file.changed` (from shadow commit diff), `checkpoint.published`, `session.started`, `session.ended`, `claim.acquired`, `claim.released`, `capture.gap`.

**[v1.1]** `producer_event_id` = `<call_id>:requested` for `tool.requested` and `<call_id>:finished` for `tool.finished`; for other kinds, sha1 of (file, byte offset). A request and its result share `call_id`, so they must not share the event id or the unique constraint deduplicates one away. `call_id` is stored as its own column for pairing. Uploads are idempotent on `(session_id, producer_event_id)`.

### 3.2 Shadow commits (file truth)

Transcripts show `Edit`/`Write` inputs but not the result of `apply_patch`, sed, heredocs, or build scripts. File truth comes from git.

**[v1.1]** Every 30 s, for each worktree with an active session in an opted-in repo, bound or unbound, if dirty since last shadow:

```
export GIT_INDEX_FILE=$(mktemp)
git read-tree HEAD
git add -A -- .
git add -f -- <declared ignored paths>
# read-tree loaded every tracked file, including a tracked .env; `add` exclusions do
# not remove indexed entries, so denied paths must be removed from the index explicitly
git rm -r --cached --quiet --ignore-unmatch -- <denied globs>
tree=$(git write-tree)
# validate: abort the snapshot if any denied path survived into the tree
git ls-tree -r --name-only "$tree" | grep -E -q '<denied regex>' && { echo "denied path in tree"; exit 2; }
# detect files that changed while we were reading: index vs worktree
changed=$(git diff-files --name-only)
[ -n "$changed" ] && { sleep 1; retry_once; }   # on second mismatch, publish with capture_gaps: file_changed_during_snapshot
[ "$tree" = "$last_tree" ] && exit 0
commit=$(git commit-tree "$tree" -p "$parent" -m "wip: <thread|unbound> <session> $(date -u +%FT%TZ)")
git update-ref refs/wip/<author>/<session> "$commit"
git push --quiet origin refs/wip/<author>/<session>
git ls-remote --exit-code origin refs/wip/<author>/<session> | grep -q "$commit"   # remote-verified before it counts as saved
```

`parent` = previous shadow commit for this session, else HEAD at session start. Never touches the user's branch, index, or working tree. Deletions and untracked non-ignored files are captured naturally. Unbound sessions snapshot to the same ref scheme; thread binding is metadata and can be attached later (test 16). A temporary index does not make filesystem reads atomic; the `diff-files` check and the gap entry make that visible instead of pretending otherwise.

**[v1.1]** A snapshot only counts as saved when the remote confirms the commit. `sessions.last_verified_snapshot_at` and the wip commit sha are recorded from that confirmation, not from the local push call returning.

**Inclusion policy** (explicit, per repo, in `.ledger/continuity.json` or defaults):
- Include: tracked changes, untracked non-ignored files, ignored paths explicitly declared (e.g. generated motion assets a HiAstro study needs).
- Exclude always: `node_modules`, build caches, `.env*`, files matching secret globs, files over 50 MB unless declared.
- Undeclared ignored files are excluded and listed in `capture_gaps` so the omission is visible.

### 3.3 Spool and upload

Local append-only spool at `~/.ledger/spool/<session>.jsonl`. Upload in batches with exponential backoff. Ack advances the watermark. Offline accumulates indefinitely. On reconnect, replay preserves order and the server deduplicates by producer id.

### 3.4 Lifecycle and coverage

- launchd agent `com.tranzmit.ledger.helper`, RunAtLoad true, KeepAlive true. Reuse `installReconciler` pattern.
- `ledger helper start|stop|status`.
- Heartbeat per active session every 30 s → `sessions.last_seen_at`.
- Coverage report per session, uploaded and shown in resume packs: transcript root readable, hooks trusted (Codex), shadow commit healthy, last upload age, gaps.
- If a transcript root is missing or a format is unrecognized, emit `capture.gap` and keep going. Never fabricate.

### 3.5 Checkpoint request channel

Hooks signal the helper via a Unix socket or a touch-file in `~/.ledger/signals/<session>` to publish a checkpoint now (Stop, PreCompact, SessionEnd, claim release). Publication is described in §5.

**[v1.1]** Every remote-verified snapshot (§3.2) also publishes a lightweight `kind: snapshot` checkpoint: wip commit, event watermark, verified timestamps, no narrative, no structured state beyond files touched. Discoverability therefore tracks the 30 s snapshot cadence, not the turn cadence. `kind: turn` checkpoints at Stop and the other triggers add the full structured state. The previous "self-trigger every 5 minutes" is removed; it was the source of the false 30-second claim.

---

## 4. Shared store

### 4.1 Postgres (six tables)

```sql
threads       (id uuid pk, repo text, title text, goal text, created_by text, status text,
               generation int not null default 0,          -- [v1.1] monotonic, never resets on release
               head_checkpoint_id uuid, forked_from_thread_id uuid, forked_at_checkpoint_id uuid,
               created_at timestamptz, updated_at timestamptz)

sessions      (id text pk, thread_id uuid null, author text, harness text, machine text,
               cwd text, branch text, started_at, last_seen_at, ended_at,
               transcript_watermark bigint, coverage jsonb,
               last_verified_snapshot_at timestamptz null, last_acked_event_at timestamptz null,   -- [v1.1] measured, not asserted
               diverged_at_seq int null, fork_thread_id uuid null)                                 -- [v1.1] explicit routing after divergence

events        (id bigserial pk, session_id text, seq int, producer_event_id text,
               call_id text null,                             -- [v1.1] pairs :requested with :finished
               thread_id uuid null,                           -- [v1.1] routing at insert time; immutable per event
               kind text, occurred_at timestamptz, received_at timestamptz,
               generation int null, payload jsonb, artifact_refs jsonb,
               unique (session_id, producer_event_id))

checkpoints   (id uuid pk, thread_id uuid, session_id text, generation int,
               kind text,                                     -- [v1.1] snapshot | turn
               through_event_seq int, base_commit text, wip_ref text, wip_commit text,
               verified_snapshot_at timestamptz, verified_events_at timestamptz,   -- [v1.1]
               structured_state jsonb, narrative text null, narrative_status text,
               capture_gaps jsonb, created_at timestamptz)

claims        (thread_id uuid pk, holder_session_id text, holder_author text,
               generation int, acquired_at, heartbeat_at, expires_at, released_at timestamptz null)

artifacts     (id uuid pk, sha256 text, kind text, byte_size int, storage_uri text null,
               inline bytea null, session_id text, created_at timestamptz)
```

`seq` per session is allocated server-side in the insert transaction.

**[v1.1] Head-update rule.** A checkpoint advances `threads.head_checkpoint_id` only if all three hold: the checkpoint's `session_id` is the current claim holder, the checkpoint's `generation` equals `threads.generation`, and the claim is not released or expired. There is no "no claim and bound" path. After a release nothing advances the head until a new claim increments the generation. `ledger_resume continue` and `ledger_thread_start` claim automatically, so this costs nothing in the normal flow.

**[v1.1] Routing rule.** `events.thread_id` is set at insert from the session's current routing and never changes. When a stale-generation upload arrives, the server sets `sessions.diverged_at_seq` and `sessions.fork_thread_id`, and every later event from that session is inserted with `thread_id = fork_thread_id`. Historical events keep the thread they belonged to. The fork's `forked_at_checkpoint_id` is the last checkpoint that session published under the old generation.

### 4.2 What stays in git

Definitions, findings, changes, decisions stay in `tranzmit-ledger` exactly as today. Checkpoints reference them by `{ledger_id, version}` in `structured_state.decisions`. No knowledge object moves to Postgres. Two sources of truth for knowledge is the failure mode this line prevents.

### 4.3 Hosting

Same Neon org as HiAstro, separate database. Team auth: one long-lived token per person issued by `ledger login`, stored in `~/.ledger/config.json`. Every write is attributed to the token's author.

---

## 5. Checkpoint construction

**Triggers.** `kind: snapshot` after every remote-verified shadow commit (§3.2, §3.5). `kind: turn` at Stop (primary), PreCompact, SessionEnd, claim release, and explicit `ledger_release`. **[v1.1]** No timer-based trigger; discoverability follows verified snapshots.

**Publication order** (durable artifacts before advertisement):
1. Shadow-commit now; record `wip_commit` and `through_event_seq`.
2. Push the wip ref; verify the remote has it.
3. Upload any pending artifacts; verify hashes.
4. In one transaction: verify claim generation, insert checkpoint, append `checkpoint.published`, advance `threads.head_checkpoint_id`.
5. Only then is it visible to readers.

Push or upload failure leaves the previous checkpoint current. No checkpoint ever references a commit the remote does not have.

**Schema** (mechanical fields authoritative; narrative optional):

```json
{
  "schema_version": 1,
  "kind": "turn",
  "thread_id": "<uuid>", "session_id": "<id>", "generation": 3,
  "through_event_seq": 148,
  "base_commit": "<sha at session start>",
  "wip_ref": "refs/wip/rachit/<session>", "wip_commit": "<sha>",
  "verified_snapshot_at": "2026-09-08T01:47:12Z", "verified_events_at": "2026-09-08T01:47:40Z",
  "goal": "<first human prompt or edited title>",
  "instructions": [{"event_seq": 1, "preview": "..."}, {"event_seq": 57, "preview": "..."}],
  "files_touched": [{"path": "src/motion/study4.ts", "adds": 41, "dels": 9}],
  "tools_summary": {"count": 212, "last": ["Bash: npm test", "Edit: study4.ts"]},
  "last_assistant_messages": ["...", "...", "..."],
  "pending_operations": [{"tool": "Bash", "input": "npm run build", "event_seq": 147, "status": "unknown"}],
  "last_error": {"tool": "Bash", "excerpt": "...", "event_seq": 139},
  "decisions": [{"ledger_id": "dec-2026...", "version": "..."}],
  "capture_gaps": [{"kind": "ignored_undeclared", "paths": ["public/generated/"]}],
  "loss_window": {"verified_snapshot_at": "...", "verified_events_at": "...", "last_seen_at": "...", "unsaved_seconds_at_publish": 12},
  "narrative": null,
  "narrative_status": "none | generated_unreviewed | stale"
}
```

**Narrative.** Optional. Produced by the existing extractor path (`src/extract.ts`, `prompts/`) from the event stream, labeled `generated_unreviewed`, evidence-linked, never blocking. If it fails, the mechanical checkpoint stands. An inferred next step is never presented as a human instruction.

---

## 6. Claims

- `POST /threads/:id/claim` with `session_id`: compare-and-swap in one transaction. If no live claim (none, released, or expired) → increment `threads.generation`, insert the claim with that generation, return it. Else → 409 with holder author, session, harness, last heartbeat. **[v1.1]** The generation lives on the thread and only ever increases; release does not reset it.
- Heartbeat every 30 s by the helper; lease 5 min. Expiry makes the claim takeable. This is not fencing and is not presented as such.
- Every upload carries the generation the helper holds. Server rule: if `upload.generation < threads.generation`, store the events routed to a fork (§4.1 routing rule), set `sessions.diverged_at_seq` and `sessions.fork_thread_id`, create the fork from the last checkpoint that session published under its old generation, and queue a notification for the stale session's machine. **[v1.1]** Head advancement requires holder session and current generation together (§4.1); a bound session with no claim cannot advance the head.
- Helper delivers notifications to the terminal: `ledger: thread "<title>" was continued by agaaz at 09:12; your further work is now on fork "<title> (rachit fork)"`.
- `ledger_release` or SessionEnd releases the claim after a final checkpoint.

The claim protects the shared record. It does not protect the other laptop. Both facts appear in the resume pack.

---

## 7. Resume pack

Built mechanically by the plugin from server data. Default budget 6,000 tokens. Never silently drops constraints, pending operations, or capture gaps; on overflow, lists what was omitted and how to fetch it.

Contents, in order:
1. Thread goal and title; all human instructions in order, clipped; source seqs.
2. Head checkpoint structured state (§5).
3. **[v1.1]** Loss window computed from verified timestamps, never a constant: "Code saved through 01:47:12 (remote-verified). Events acknowledged through 01:47:40. Last seen 01:48:03. Up to 51 s of edits and one in-flight `npm run build` may be missing." Confirmed capture gaps listed; pending ones shown as still arriving.
4. Claim status: who held it, generation, whether this call acquired it.
5. Intervening project changes: `git diff --stat <base_commit>..origin/master`, list of commits, and ledger objects created since the checkpoint that match the repo or thread tags. Superseded decisions referenced by the checkpoint are flagged.
6. Worktree bootstrap:
   ```
   git fetch origin refs/wip/rachit/<session>:refs/wip/rachit/<session>
   git worktree add ../<thread-slug> <wip_commit>
   ```
   Rebasing onto origin/master is the agent's deliberate, visible choice, not automatic.
7. First-turn contract: inspect the worktree, acknowledge gaps, state confirmed vs uncertain progress, do not blindly rerun unknown operations, choose the next action, and say what it is continuing.

Read-only mode (`mode: inspect`) returns the pack without claiming.

---

## 8. Plugin surface

New MCP tools (additive to `src/mcp.ts`):

| tool | behavior |
|---|---|
| `ledger_threads(repo?, author?, since?, status?)` | Open threads with freshness, harness, claim holder, head checkpoint age |
| `ledger_thread_get(thread_id)` | Full thread detail and event summary |
| `ledger_resume(thread_id, mode: continue \| fork \| inspect)` | continue = claim + pack; fork = new linked thread + pack; inspect = pack only |
| `ledger_thread_start(title?, goal?)` | Bind current session to a new thread |
| `ledger_thread_bind(thread_id)` | Bind current session as a contributor without claiming |
| `ledger_thread_note(text)` | Append a human or agent note to the thread's events |
| `ledger_release()` | Final checkpoint and release claim |

Existing tools unchanged. CLI mirrors: `ledger threads`, `ledger resume <id>`, `ledger helper …`.

**Hooks** (`src/hooks.ts`):
- SessionStart: brief + "Open threads in this repo" section (teammates only, 48 h, cap 5) + helper coverage line. **[v1.1] Auto-bind rule:** bind only when exactly one open thread matches this repo, this branch, and this author. Never auto-bind to another person's thread; that is what `ledger_resume` is for. If zero or several candidates match, the session stays unbound, the candidates are listed in the SessionStart context, and the session's work is still snapshotted and uploaded (§3.2) so it can be attached later.
- Stop: existing data-query checkpoint unchanged; additionally signal the helper to checkpoint if the worktree changed this turn.
- PreCompact, SessionEnd: signal checkpoint; SessionEnd also releases.
- PostToolUse: unchanged journaling.

**Brief** (`src/query.ts`): new section, one line per thread:
`rachit · codex · hiastro · wip/rachit/… · last seen 02:14 · died mid-turn · "Rebuild six motion studies…" → "Study 4 curtain timing off; trying 380ms" · unclaimed · thr-…`

**Day-0 fix.** The hidden-draft filter: `query.ts:181` shows only `transcript_fallback` drafts, `query.ts:53` and `:152` filter to stable. Show all drafts, labeled by origin and "not in force." Rachit's five Sep 5 decisions are currently invisible to every brief.

---

## 9. Security and privacy

- Uploaded: human prompts in full (never clipped in storage; the resume pack previews and links), assistant text, tool inputs, tool output previews (1,200 chars) in the event, shadow commits, file change stats.
- **[v1.1] Full tool outputs and other evidence:** stored inline as `artifacts.inline` up to 8 MB after redaction (Postgres handles this comfortably; the largest output observed in 70,833 Codex results was 240 KB). Above 8 MB the artifact is not uploaded and the event carries an explicit `capture_gaps` entry with `kind: oversized_artifact`, `sha256`, `byte_size`, and the local path, so the successor knows exactly what is missing and where it still exists. Nothing is silently dropped. Object storage remains deferred until an artifact actually exceeds 8 MB.
- Not uploaded ever: `.env*`; secret-glob paths; anything the per-repo deny list names. Shadow commits enforce this in the index and validate the tree (§3.2).
- Regex redaction for known token shapes (AWS, GitHub, Bearer, `DATABASE_URL=…`, private keys) before spool write. Best effort. Named as a known limitation; a redaction miss is a real exposure in a shared store.
- Postgres and the wip refs are readable by the team. The project remote already is.
- The successor runs on their own credentials. No credential ever transfers.

---

## 10. Honesty statements (must appear verbatim in the product)

- "Code saved through {verified_snapshot_at}; events acknowledged through {verified_events_at}; later activity may be incomplete." **[v1.1]** Both timestamps are remote-verified values, never local assumptions.
- "Up to {computed} seconds of edits plus any in-flight tool call may be missing." **[v1.1]** Computed per resume from `last_seen_at` minus the verified timestamps; no fixed number appears anywhere in the product.
- "Claim is advisory. It protects the shared record, not the other machine."
- "Narrative is generated and unreviewed. Machine fields are the evidence."
- "Capture gaps: {list}." Never "fully recovered" when a gap is known.

---

## 11. Acceptance tests

| # | test | required result |
|---|---|---|
| 1 | Codex → Claude, planned stop | Claude worktree at exact wip commit; constraints and pending validation in pack |
| 2 | Claude → Codex, planned stop | Same in reverse |
| 3 | SIGKILL Codex mid-edit, no hooks fire | Helper's last shadow commit and transcript tail captured; checkpoint published by helper; narrative absent or stale |
| 4 | Laptop sleeps mid-run, wakes 6 h later | Spool flushes; checkpoint published; pack shows loss window |
| 5 | Crash during a tool call | `pending_operations` lists it as unknown; pack forbids blind rerun |
| 6 | Two `ledger_resume continue` within 1 s | Exactly one claim; other gets 409 with holder |
| 7 | Stale-generation session keeps uploading | Events stored; fork thread created; head unchanged; holder machine notified |
| 8 | Resume A after B advanced master | Worktree from A's wip commit; pack shows diff to master and intervening ledger objects; B untouched |
| 9 | Untracked file and a deletion | Both in shadow commit |
| 10 | Declared ignored path vs undeclared vs `.env` | Included / excluded and listed in gaps / never included |
| 11 | Codex hooks untrusted | Capture complete via tailing; coverage says `hooks: untrusted` |
| 12 | Server unreachable 10 min | Spool accumulates; replay ordered; no duplicates |
| 13 | Upload retried after timeout | One logical event |
| 14 | Referenced ledger decision superseded | Pack flags old dependency and new decision |
| 15 | Narrative extractor unavailable | Mechanical checkpoint fully usable |
| 16 | Session never bound to a thread | Uploaded; visible as unbound; bindable later |
| 17 | Third Conductor agent on a different thread throughout 1–8 | Unaffected; its own shadow ref and thread |
| 18 | Secret in tool output | Redacted in stored event; not in any artifact |
| 19 | Push of wip ref fails | Previous checkpoint remains current; no dangling reference |
| 20 | **[v1.1]** Tool call and its result in one session | Both stored as distinct events sharing `call_id`; neither deduplicated |
| 21 | **[v1.1]** Tracked `.env` in the repo, worktree dirty | Shadow tree contains no denied path; snapshot aborts if validation finds one |
| 22 | **[v1.1]** Claim released, two bound sessions publish checkpoints | Head does not advance for either until one re-claims and the generation increments |
| 23 | **[v1.1]** Tool output of 9 MB | Not uploaded; event carries `oversized_artifact` gap with sha256, size, and local path; resume pack names it |
| 24 | **[v1.1]** Hook index entry arrives, transcript line lands 20 s later | Gap is `pending` then cleared; never reported as `confirmed` |
| 25 | **[v1.1]** Unbound session edits files, laptop dies | Files recovered from `refs/wip/<author>/<session>`; session bindable to a thread afterwards |
| 26 | **[v1.1]** File rewritten while snapshot is being read | Retry once; on second mismatch publish with `file_changed_during_snapshot` gap naming the paths |

**Gate.** Real-workflow test: Rachit in Codex on real HiAstro work, interrupted by kill and by sleep, continued by Agaaz in Conductor with a third HiAstro agent running, three of three attempts reach a correct next action without a verbal handoff. Then the fixture matrix above passes. Ownership, integrity, and redaction tests must pass regardless of continuation rate.

---

## 12. Build order

**Phase 0 — capture spike (days 1–3, go/no-go).** Tail real transcripts already on this machine. Prove incremental parsing, session identity, tool pairing, and Codex `apply_patch` / custom tool shapes. Prototype shadow commits on a HiAstro worktree. Deliver a per-harness coverage report. If Codex transcripts cannot yield tool boundaries, stop and resolve before Phase 1.

*Status 8 Sep:* corpus scan done (`.context/phase0/coverage.mjs`, results in `coverage.json` and `report.md`); Codex `custom_tool_call` and `response_item/message` parser gaps fixed in `src/transcript.ts` with fixtures in `src/selftest.ts`; `exec` added to shell tools in `src/hooks.ts`; build and self-test green. Remaining in Phase 0: shadow-commit prototype against a local bare remote (the HiAstro remote already accepted a dry-run `refs/wip/` push), and the streaming-emitter refactor of the parsers. Gate: **go**.

**Phase 1 — helper and store (week 1).** Daemon: tail, shadow, spool, upload, heartbeat, launchd. Postgres schema and minimal HTTP service in this repo. `ledger threads` lists both people's sessions. Fix the hidden-draft filter.

**Phase 2 — continuity (week 2).** Checkpoints with publication order, claims with generations and fork-on-stale, terminal notification, resume pack builder, MCP tools, brief section, SessionStart default bind, Stop/SessionEnd signals. End-to-end Codex → Claude on the fixture.

**Phase 3 — pilot and hardening (week 3).** Real-workflow gate, fixture matrix, redaction pass, optional narrative via existing extractor, Postgres backup and one restore drill, measured results and limitations doc, ledger decision record.

**Deferred.** Hosted runner and real fencing; environment manifests beyond Conductor setup scripts; web UI; semantic thread search; automatic merging; object storage (inline `bytea` for bounded previews until an artifact exceeds 256 KB); Mosaic integration (revisit if a plan is activated, since its replica could replace tailing + upload).

Effort estimate after Phase 0. The helper is the only genuinely new component; the rest extends existing modules.

---

## 13. Decisions frozen, and what lost

To be recorded in the ledger as a decision once Agaaz and Rachit confirm.

| decision | chosen | lost, and why |
|---|---|---|
| Capture source | Transcript tailing primary, hooks for control | Hooks-only: Codex trust-gated, dies with process. Hosted supervisor: centralizes execution, kills parallelism, 5–8× build |
| Execution location | Local, as today | Hosted runner: correct fencing but wrong trade for two users |
| Coordination store | Postgres | Git refs via `--force-with-lease` CAS: works for claims, wrong for event volume. Git-only: no CAS, 60 s latency |
| File capture | Shadow commits on `refs/wip/…` | rsync to S3: loses git semantics. Auto-commit to user branch: pollutes history |
| Unit of continuity | Thread | Session: does not span harnesses. Project: kills parallelism |
| Ownership | Advisory claim with generation, fork on stale | Hard fencing: requires hosting. No claims: races |
| Knowledge layer | Stays in git ledger, referenced by id/version | Migrate to Postgres: splits the store |
| Checkpoint | Mechanical authoritative, narrative optional | Narrative-first: dies with the agent, unverifiable |
| Scope | Both directions Codex ↔ Claude, code and analysis | Analysis-only: misses the actual HiAstro night work |

---

## 14. Open questions

1. Neon: same org as HiAstro, new database. Confirm.
2. Codex transcript format: pin a version in Phase 0; the parser was verified against files on 3 Sep 2026.
3. Rachit must run `/hooks` and trust the five ledger entries for Stop-driven checkpoints. Tailing covers capture either way.
4. Redaction miss tolerance: agree on the secret-glob list before Phase 1 uploads anything.
5. Mosaic: activate a plan and reuse its replica, or not. Decide after Phase 0 shows how hard tailing actually is.

---

## Appendix — relation to existing source

- `src/transcript.ts`: `parseClaude`, `parseCodex` → streaming emitters. Formats verified 3 Sep 2026.
- `src/hooks.ts`: journal unchanged; add signals, default bind, threads brief.
- `src/extract.ts`: reconciler becomes the optional narrative generator; `findCandidates` gains "thread with dirty checkpoint and no narrative."
- `src/query.ts`: `brief()` gains Open threads; fix draft filters at lines 53, 152, 181.
- `src/mcp.ts`: seven additive tools.
- `src/install.ts`: `installHelper()` alongside `installReconciler()`.
- `src/store.ts`: unchanged; knowledge stays in git.
- New: `src/helper/` (tail, shadow, spool, upload, notify), `src/continuity/` (schema, client, resume pack), `src/service/` (HTTP + Postgres).
