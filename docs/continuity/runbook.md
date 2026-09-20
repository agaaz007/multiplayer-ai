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

## Stable install: `ledger deploy` (15 Sep 2026)

Until 15 Sep every hook, the MCP registration, the reconciler and the helper on Agaaz's machine executed `…/richmond-v1/dist/cli.js`, so `npm run build` in that Conductor worktree was a production deploy. Installers now refuse a `cli.js` that sits inside a git worktree (`ledger install …`, `ledger helper install`; override only with `LEDGER_ALLOW_WORKTREE_INSTALL=1`), and the supported path is:

```
npm run build                 # in the source tree you want live
node dist/cli.js deploy       # or: ledger deploy, once ~/.ledger/bin/ledger is on PATH
ledger deploy --status        # every entry point and the cli.js it runs
```

`deploy` runs `npm pack --ignore-scripts` and `npm ci --omit=dev` into `~/.ledger/bin/releases/<version>-<utc stamp>-<git sha>[-dirty]/`, points `~/.ledger/bin/current` at it, writes the launcher `~/.ledger/bin/ledger`, then runs `install all` and `helper install` **from the release**, so hooks, MCP registrations and both launchd plists pin the versioned path. The helper and reconciler restart during install; MCP servers inside open Claude/Codex sessions keep running the previous binary until those sessions restart. Codex re-hashes hook commands, so `/hooks` must be trusted again after each deploy. Old releases are never deleted automatically; delete them by hand once `deploy --status` shows nothing references them. `ledger helper status` prints the `cli.js` the running helper executes and flags a worktree.

On Agaaz's machine the first release is `0.1.0-20260914T203225Z-5364efa-dirty` and the nvm `ledger` symlink now points at the launcher (it used to be an `npm link` into richmond-v1).

## Rotate the Neon password

The password was pasted into an agent chat on 2026-09-08 and again appeared in a tool output on 2026-09-15. No Neon API credential exists on either machine (`~/.config/neonctl` is empty), so the reset itself happens in the Neon console: project → Roles → `neondb_owner` → Reset password, then copy the new pooled connection string. Then, on **each** machine:

```
ledger continuity rotate 'postgresql://neondb_owner:<new>@ep-…-pooler.…neon.tech/neondb?sslmode=require&channel_binding=require'
```

It connects with the new URL first (fails closed, never echoes the URL), writes `~/.ledger/config.json` with mode 600, kickstarts `com.tranzmit.ledger.helper` and waits for a heartbeat from the new pid. Run it on Agaaz's machine, then on Rachit's, within the same sitting; the old password is dead from the moment the console resets it, so both helpers log connection errors until their config is rotated. Confirm with `ledger continuity status` on both machines and `ledger helper status` showing a fresh pass. Restart open Claude/Codex sessions afterwards; their MCP servers hold the old URL in memory.

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

## Work inside a git checkout

Threads, claims, and snapshots exist only for sessions whose working directory is inside a git repository with a remote. A session in a plain folder (a Downloads directory, a scratch dir) still uploads its events, but gets no thread, no claim, and no `refs/wip/` snapshot, so nobody can check out its code. For the pilot, run Codex or Claude from the HiAstro checkout.

## Check it is working

```
ledger helper status          launchd state, log tail, tracked sessions
ledger continuity status      row counts per table on Neon
tail -f ~/.ledger/helper.log  live passes
git ls-remote origin 'refs/wip/*'   snapshots on the project remote
```

A healthy pass line looks like `pass: 1 sessions, 7 spooled, 7 uploaded, 1 snapshots, 1 checkpoints`. Passes with nothing new print nothing.

## Rachit joins (Phase 3)

On Rachit's machine, from a clone of this branch (after 15 Sep: any tree, because nothing runs from it afterwards):

```
git pull && npm install && npm run build
node dist/cli.js use <path-to-tranzmit-ledger-clone> --author rachit
node dist/cli.js deploy                  # copies the build to ~/.ledger/bin/releases/<id>, installs MCP + hooks + reconciler + helper from there
# first time only, add continuity to ~/.ledger/config.json:
#   "continuity": { "database_url": "<Neon URL>", "machine": "<hostname>" }
chmod 600 ~/.ledger/config.json
~/.ledger/bin/ledger continuity status   # must print db ok
~/.ledger/bin/ledger deploy --status     # every line ✓ release
launchctl kickstart -k gui/$(id -u)/com.tranzmit.ledger.helper   # only if config.json changed after deploy
```

Put `~/.ledger/bin` on PATH (or symlink `ledger` to `~/.ledger/bin/ledger`). `ledger install all` and `ledger helper install` run straight from a clone now refuse with a message pointing at `deploy`.

Then in Codex: run `/hooks`, review the five ledger entries, trust them. Capture works without this via transcript tailing; Stop-driven `turn` checkpoints need it.

### The one real handoff (the test that makes "multiplayer" honest)

Second human, second machine, dirty repo, no verbal handoff. Preconditions, checked before anyone starts: both machines show `ledger deploy --status` all ✓ release on the same release id, both `ledger continuity status` print `db ok` after the Neon rotation, and Rachit's session runs **inside the actual git checkout** with a remote (the 9 Sep attempt failed because his sessions ran from `~/Downloads`; a nested checkout is not the repo).

1. Rachit, in Codex from the HiAstro checkout, starts a task and works until the tree is dirty (edited, uncommitted files, at least one new file). He tells nobody what he did. He closes Codex mid-task (kill it once, let the laptop sleep once).
2. Within a minute his helper must show a pass with `1 snapshots, 1 checkpoints`, and `git ls-remote origin 'refs/wip/rachit/*'` from any clone must list the snapshot ref.
3. Agaaz, on his machine, in a fresh Claude session from a clean HiAstro checkout: the brief lists Rachit's thread under Open threads. `ledger_resume(thread_id, mode: "continue", cwd)` claims it and prints the bootstrap; run the two git lines to get a worktree at the snapshot. Check: the dirty files are present byte for byte, the pack's "saved through" time is remote-verified, pending operations are listed, and the next action stated by the pack is the one Rachit would have taken.
4. Agaaz continues the task in that worktree and finishes it, then `ledger_release`. Rachit reopens his laptop and reads the notice in his next brief.

Score it on three things only: the dirty files arrived intact, the pack named the correct next step, and Agaaz did not redo work Rachit had already done. Record the result as a Ledger finding either way; a failure with its trace is the deliverable, not a rerun until it passes.

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

## Embeddings (optional)

Off unless `continuity.embeddings` exists in `~/.ledger/config.json`. Embeddings only generate candidates behind the authority ranking; they never decide which version of a fact is true. Evidence search stays Postgres full-text; `vectorCandidates` adds nearest-neighbour event ids with a cosine score for the ranking to re-order, and returns `[]` (never throws) when unconfigured, when pgvector or the tables are missing, or when the provider fails (logged once, not per call).

```json
"continuity": {
  "database_url": "<Neon URL>",
  "embeddings": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "dimensions": 1536,
    "api_key_env": "OPENAI_API_KEY",
    "kinds": ["instruction.added", "assistant.message", "compaction", "tool.finished"],
    "max_chars": 4000
  }
}
```

Every key but `provider` has that default; `api_key` may hold the key literally instead of `api_key_env` (file mode 600; no command ever prints it). The helper reads the env var from its own environment, so a launchd-run helper needs the key in the plist or `api_key` in the config. The OpenAI REST endpoint is called with plain `fetch`, 64 inputs per request, retried with backoff on 429/5xx, 45 s hard timeout per attempt.

```
ledger continuity migrate                 # create extension vector; cont_event_embeddings(vector(dims)) + HNSW cosine index; cont_embedding_failures
ledger continuity embed --status          # configured? extension installed? embedded / eligible / pending / failures, model, dims, cost of the pending backfill
ledger continuity embed --backfill --dry-run           # estimate only
ledger continuity embed --backfill [--limit N] [--since 30d]   # oldest first, 256 per batch, progress with tokens and USD
```

Cost for the current store: about 32k events, of which the four default kinds with text are the eligible set, at roughly 300 tokens each is about 10M tokens, about USD 0.20 on text-embedding-3-small (USD 0.02 per 1M tokens). `--status` prints the exact figure from the stored text (tokens ≈ chars / 4). The helper embeds only what it uploads in a pass (at most 256 events and 60 s per pass, one batched call per pass, `embedded N events` in the log); everything older is the backfill's job. An event whose embedding the provider rejects lands in `cont_embedding_failures` and is skipped afterwards (`delete from cont_embedding_failures` to retry); a 429/5xx after retries records nothing and the next pass retries.

Neon reports `vector` 0.8.6 available; `migrate` installs it on first run. Changing `model` or `dimensions` is refused by `migrate` with a mismatch error because vectors from different models are not comparable: `drop table cont_event_embeddings, cont_embedding_failures`, then `migrate` and `--backfill` again. `dimensions` must be ≤ 2000 for the HNSW index (text-embedding-3-large: set 1536 or 1024).

## Honesty statements the product shows

- Code saved through {remote-verified time}; events acknowledged through {time}; later activity may be incomplete.
- Up to {computed} seconds of edits plus any in-flight tool call may be missing.
- The claim is advisory. It protects the shared record, not the other machine.
- Narrative is generated and unreviewed; machine fields are the evidence.

## Known limits

- One helper per machine tails every active transcript under `~/.claude/projects` and `~/.codex/sessions`; scope with `continuity.repos` if needed.
- Codex `exec` wrappers with dynamically built commands are stored as their JS source, not as shell.
- The Neon password was pasted into this chat and is therefore in this session's transcript (redacted in the uploaded copy, but present in the local file). Rotate it after the pilot.

## Reliability release: September 2026

The implementation and acceptance criteria are in [the production-readiness plan](production-readiness-2026-09-20.md). Passing local tests is not completion of the two-machine canary or proof of positive ROI.

### Run tests without touching the team database

Install a local PostgreSQL distribution providing `initdb`, `pg_ctl`, `pg_dump`, and `pg_restore`; set `LEDGER_TEST_PG_BIN` if its binaries are not on PATH. Run:

```sh
npm run test:all
npm run test:production
node scripts/test-isolated.mjs selftest-continuity
```

The runner creates a fresh loopback-only cluster on a random port, a randomly named database, and a marker table; it stops and deletes only its own cluster afterward. Drop-capable tests refuse an unmarked or nonlocal database. Pure tests do not inherit a continuity database. Do not bypass the guard by pointing tests at the team instance. `--no-build` reuses an existing compiled build; use it only after a successful build of the same source.

### Install and canary

1. Preserve the current versioned runtime, configuration, pending spool files, and source transcripts. Do not install an active development worktree as the service runtime.
2. Apply the candidate's additive migration with `ledger continuity migrate`. Old knowledge stays in Git. New usage/handoff tables and binding operation keys live in Postgres. Review migration errors before continuing; never clear tables to resolve them.
3. Install the same candidate through the existing versioned-runtime deployment flow on Agaaz's machine first. Restart MCP processes and the helper so they actually load the candidate. Verify the helper's reported executable/build and hook trust. A package on disk does not establish the running version.
4. Exercise a real scoped lookup, bind, ordinary captured tool call, and snapshot on an allowed test repository. Inspect local and remote watermarks. Roll to Rachit's permitted scope after the initial checks pass; do not widen repository permissions.
5. Set `LEDGER_TRAFFIC_CLASS=ordinary` in each ordinary runtime's environment, and `evaluation` or `audit` in evaluation/audit runtimes. Unclassified traffic stays `unknown`. Set `LEDGER_BUILD_COMMIT` to the candidate commit for usage attribution.
6. Observe both machines for 72 hours and record sample sizes, offline/unknown periods, queue growth, artifacts, and verified snapshots. Complete one analysis and one code handoff in each direction using actual work. Keep the release in pilot if any gate is failed or unknown.

### Inspect health and consumption

```sh
ledger helper status
ledger continuity health
ledger usage health
ledger usage flush
ledger usage report --from 2026-09-21T00:00:00Z --to 2026-09-28T00:00:00Z
ledger handoff report --from 2026-09-21T00:00:00Z --to 2026-09-28T00:00:00Z
```

`usage health` reports disk backlog and telemetry coverage; emission pending in memory and persisted files are different counts. Usage upload is independent of event capture. `usage report` separates logical invocations from SQL operations, operation purpose, author, and traffic class. Explicit MCP reads are intentional retrieval; SessionStart reads are automatic brief work. Empty SELECTs remain reads, and returned rows do not prove useful knowledge or a completed handoff. Inspect unknown classification and telemetry backlog alongside every report. No raw prompts or SQL are stored in usage labels.

`continuity health` exposes helper state and watermarks; it does not infer why a teammate is silent. Missing heartbeat means unknown coverage. A brief that times out now says unavailable rather than no work. Retry the specific read after checking the service; don't open a duplicate investigation solely because a read failed.

### Recovery by failure class

| Symptom | Recovery |
|---|---|
| Missing session identity | Use the real `Ledger session` ID printed at SessionStart; pass `session_id` or CLI `--session`. Restart stale MCP hosts if necessary. Do not fabricate an ID or choose the newest unrelated transcript. |
| Bind/new timed out | Retry the identical operation with the same `request_id` / `--request-id`. A conflicting reuse of the key is refused. Preserve the original question, target, and session. |
| No applicable analytical record | Inspect labelled legacy candidates, open their evidence, and validate scope. Enrich through a new scoped finding with an exact `derived-from` pin; never bulk-promote guesses. |
| Neon unavailable | Preserve local spool/transcripts. Local admission continues independently; read sections report unavailable and usage remains queued. Restore connectivity and observe backlog drain. |
| Artifact storage fails | Retain retry bytes and inspect the reported error. A transient error is not an oversized artifact. Never delete the spool or advance its acknowledgment manually. |
| Corrupt spool or cursor concern | Set `LEDGER_CAPTURE_PAUSE_UPLOAD=1` for the helper, restart it, and preserve all spool segments/manifests and transcripts for repair. No remote event acknowledgment should advance while upload is paused. |
| Git push hangs or snapshot unsafe | Set `LEDGER_SNAPSHOTS=0` for the helper and restart. Capture continues; code continuity remains explicitly unverified. Fix Git access/permissions, then re-enable snapshots and require remote verification. |
| Telemetry overhead/outage | `LEDGER_USAGE=0` pauses new emission without deleting queued observations. Inspect `usage health`; do not call a disabled period zero use. |

Spool v2 is a compatibility boundary. Retain original v1 inputs during rollout and use only a rollback runtime that understands v2. Do not run an old v1 writer against migrated state. Never reset `helper-state.json`, delete unacknowledged files, or rerun pending mutating tool calls as a generic recovery step.

### Complete a handoff honestly

`ledger_resume` and CLI `ledger resume` return a handoff attempt after a usable continuation pack is delivered and its destination session exists. Inspect-only reads do not count as continuations. Use the real destination session for continue/fork. Report progress through `ledger_handoff_update` or `ledger handoff update --session <id>` with JSON on stdin. Exact event references have `{session_id, seq, role}`, where role is `verification`, `validation`, `delivered_result`, or `pending_operation_resolution`.

Verification must point to captured destination-session tool outcomes after the attempt began. Code work requires a remotely verified source snapshot. Completion requires validation plus a nonempty delivered assistant result, and evidence that pending source operations were reconciled. Failed/abandoned attempts require a reason and remain visible. These are agent-reported outcomes backed by retained events; the tool does not claim independent semantic verification or human acceptance.

### Credential rotation and restore evidence

Check the existing credential-rotation TODO against the actual credential owner. The new `ledger continuity rotate --stdin` and `--url-file <private-file>` inputs avoid placing a replacement URL in shell history. Obtain and supply the credential through the team's secret channel; never paste it into a chat or commit it. The command validates and installs the supplied URL; revoke the old credential at the provider separately and verify it fails on both machines.

The isolated restore test backs up/restores continuity tables and artifact bytes/hashes and clones a synthetic Git ledger backup. It cannot prove the live database's backup schedule, retention, or recovery window. Before sign-off, restore an authorized live backup to a separate permitted target, verify retained evidence and Git versions, and record recoverable watermarks and restore duration without exposing secrets.
