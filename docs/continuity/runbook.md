# Execution continuity: runbook

What is running, how to check it, how Rachit joins, how to stop it. Spec: `execution-continuity-spec-v1.md`.

## What is live on Agaaz's machine (8 Sep 2026)

- Shared store: Neon Postgres, tables `cont_threads, cont_sessions, cont_events, cont_checkpoints, cont_claims, cont_artifacts, cont_notifications`. URL in `~/.ledger/config.json` under `continuity.database_url` (file mode 600). Never in the repo.
- Helper daemon: launchd `com.tranzmit.ledger.helper`, KeepAlive, 10 s passes, log `~/.ledger/helper.log`.
- Hooks: Stop / PreCompact write a checkpoint signal, SessionEnd writes an end signal, PostToolUse appends a tool index. All local files under `~/.ledger/`.
- Brief: SessionStart and `ledger_brief` append "Open threads" (teammates', last 48 h, this repo first) and "Ledger notices."
- MCP tools: `ledger_threads`, `ledger_thread_get`, `ledger_resume`, `ledger_thread_start`, `ledger_thread_bind`, `ledger_thread_note`, `ledger_release`. Requires an MCP restart in each harness to appear.

## Work records (added 8 Sep, later)

Threads are the physical unit (one session, one worktree, one claim). **Work records** are the logical unit: a session contributes spans of its events to many records; a record accumulates from many sessions and teammates and keeps its own state with provenance. The brief shows **Open work (records)** and **Unassigned work**.

```
ledger_records(cwd?)                               records on this repo, newest first
ledger_resume(record_id, mode: "continue")         state, evidence across sessions, pending ops, contradictions, bootstrap
ledger_record_get(record_id)                       same, read-only, bigger budget
ledger_record_link(record_id, session_id, from_seq, to_seq)   say "these events belong to this record"
ledger_record_update(record_id, action: "propose"|"confirm"|"reject", …)   propose with evidence; confirm or reject with reason
ledger_record_start(kind, title, goal?, cwd?)      start a record explicitly
ledger_unassigned()                                spans no record claims
ledger_evidence_search(q)                          full-text search over everyone's captured events
ledger_events / ledger_artifact_get                the originals behind any line
```

CLI: `ledger records [--all]`, `ledger record show|start|link|propose|confirm|reject …`, `ledger unassigned`, `ledger resume --record <id>`, `ledger events …`, `ledger artifact …`.

A classifier runs after each turn checkpoint (at most once per 120 s per session, detached from capture): it links spans as **suggested**, proposes state updates as **proposed**, and leaves the rest unassigned. It never confirms anything and never writes a Ledger decision or finding. Disable with `"classify": false` under `continuity` in `~/.ledger/config.json`, or `LEDGER_CLASSIFY=0` in the helper's environment. Each run is one model call through your own `claude` or `codex` login; a 250-event slice took about four minutes.

**PROPOSED means unconfirmed.** Do not treat a proposed hypothesis or decision as settled. Confirm with `ledger_record_update(action: "confirm")` when you have checked it; promotion to a Ledger decision or finding remains a separate, human act.

## Credentials the helper needs

The helper runs under launchd with no terminal. macOS's keychain credential helper cannot answer there, so remote git operations use `gh auth git-credential`. Requirements: `gh` installed and `gh auth status` logged in for the account that can push to the project remotes. Override with `LEDGER_GIT_CREDENTIAL_HELPER` if you use something else. A push that cannot authenticate is recorded on the checkpoint as `snapshot_not_verified` and in the helper log as a pass error; the snapshot is not "saved" until the remote confirms it.

## Daily use

Morning, in any Claude or Codex session (after MCP restart), the brief lists teammates' open threads. To continue one:

```
ledger_resume(thread_id, mode: "continue", cwd: "<a checkout of the same repo>")
```

It claims the thread (advisory), returns the resume pack, and prints the bootstrap:

```
git fetch origin refs/wip/<author>/<session>:refs/wip/<author>/<session>
git worktree add --detach ../<slug> <wip_commit>
```

`mode: "fork"` creates a linked thread you own instead. `mode: "inspect"` reads without claiming.

From a terminal:

```
ledger threads [--all] [--hours N]                 open threads on this repo (or all)
ledger resume <thread> --mode inspect              the pack, no claim
ledger resume <thread> --checkout ../wt-name       claim + pack + worktree at the snapshot
ledger thread show|close|title <id>
```

## Check it is working

```
ledger helper status          launchd state, log tail, tracked sessions
ledger continuity status      row counts per table on Neon
tail -f ~/.ledger/helper.log  live passes
git ls-remote origin 'refs/wip/*'   snapshots on the project remote
```

A healthy pass line looks like `pass: 1 sessions, 7 spooled, 7 uploaded, 1 snapshots, 1 checkpoints`. Passes with nothing new print nothing.

## Rachit joins (Phase 3)

On Rachit's machine, from a clone of this branch:

```
npm install && npm run build
ledger use <path-to-tranzmit-ledger-clone> --author rachit
ledger install all                       # MCP + hooks + reconciler for Claude and Codex
# add continuity to ~/.ledger/config.json:
#   "continuity": { "database_url": "<same Neon URL>", "machine": "<his hostname>" }
chmod 600 ~/.ledger/config.json
ledger continuity status                 # must print db ok
ledger helper install                    # launchd, KeepAlive
```

Then in Codex: run `/hooks`, review the five ledger entries, trust them. Capture works without this via transcript tailing; Stop-driven `turn` checkpoints need it.

The pilot test: Rachit works on HiAstro in Codex; we kill it once and let the laptop sleep once; Agaaz continues both via `ledger_resume` in Conductor while another HiAstro agent runs in a different worktree. Three of three must reach a correct next action without a verbal handoff.

## What leaves the machine

Uploaded: human prompts, assistant messages, tool inputs, 1,200-char output previews, full outputs as artifacts up to 8 MB, file paths touched, shadow commits of the worktree to `refs/wip/<author>/<session>` on the project's own remote.

Never uploaded: thinking/reasoning blocks, `.env*`, `*.pem`, `*.key`, `**/secrets/**`, `**/credentials*`, `.npmrc`, `.netrc`, `node_modules`, build caches. Known token shapes are regex-redacted before spooling (AWS, GitHub, OpenAI/Anthropic, Slack, Neon, Google, URL passwords, `KEY=value` pairs). This is best-effort.

Add repo-specific denies or gitignored paths that must be captured:

```json
"continuity": { "database_url": "...", "deny": ["config/prod.*"], "include": ["public/generated/**"] }
```

## Stop / remove

```
launchctl unload ~/Library/LaunchAgents/com.tranzmit.ledger.helper.plist   # stop the daemon
git push origin --delete refs/wip/<author>/<session>                         # drop a snapshot ref
```

Removing `continuity` from `~/.ledger/config.json` disables every continuity feature; the four Ledger object types and hooks keep working as before.

## Honesty statements the product shows

- Code saved through {remote-verified time}; events acknowledged through {time}; later activity may be incomplete.
- Up to {computed} seconds of edits plus any in-flight tool call may be missing.
- The claim is advisory. It protects the shared record, not the other machine.
- Narrative is generated and unreviewed; machine fields are the evidence.

## Known limits

- One helper per machine tails every active transcript under `~/.claude/projects` and `~/.codex/sessions`; scope with `continuity.repos` if needed.
- Codex `exec` wrappers with dynamically built commands are stored as their JS source, not as shell.
- The Neon password was pasted into this chat and is therefore in this session's transcript (redacted in the uploaded copy, but present in the local file). Rotate it after the pilot.
