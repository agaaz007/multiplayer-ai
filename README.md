# ledger

Shared memory for a team's coding agents. Plain markdown in git, read and written by Claude Code, Codex, Cursor, or anything that speaks MCP.

It holds four things, and only four:

| type | agent reads it before | agent writes it when | it kills |
|---|---|---|---|
| **definition** | writing any query | a metric is computed with no definition, or one changes | two people getting different numbers for the same metric |
| **finding** | starting an analysis | an analysis finishes | redoing work someone did on Tuesday |
| **change** | attributing a metric move | something ships | crediting your test for someone else's fix |
| **decision** | proposing direction | a direction is chosen, dropped, or reversed | two agents compounding in opposite directions |

Not a transcript drive. Not a codebase wiki. Not a new chat UI. Your agents keep running wherever they run today; this is the thing they read first and write last.

## How it works

```
Claude Code (Conductor) ──┐
                          ├── MCP (stdio) ── ledger ── ~/tranzmit-ledger/   (git clone)
Codex (app or CLI) ───────┘                              ├── definitions/*.md
                                                         ├── findings/*.md
                                                         ├── changes/*.md
                                                         └── decisions/*.md
```

- Every object is one markdown file with YAML frontmatter. The file name is the id. Humans can `cat` it, diff it, review it in a PR.
- Every `record` pulls, commits, and pushes. Every read pulls (at most once a minute). Two people on two machines see each other's objects within a minute, with git as the sync layer and conflict log. Objects are one file each, so they never conflict; the generated views can, and when they do `ledger` regenerates them from the merged objects and carries on. A record made offline is committed locally and pushed by the next one. The data repo is never left mid-rebase.
- `ledger_record_finding` returns similar prior findings, so the agent sees the duplicate before it writes one.
- Nothing is edited in place. Refreshes and reversals are new files with `supersedes`; the old one is marked `deprecated` and drops out of the brief but stays in history.
- Every record also rebuilds the data repo's `README.md`, per-directory `index.md`, and `log.md` from the full set of objects, and commits them alongside. They are derived files: byte-identical on every machine, never edited, never merged. **GitHub is the dashboard**: open the data repo and you see definitions, decisions in force, and the last 14 days of changes and findings as tables; `log.md` is the newest-first feed; commit history is the audit trail.
- Session start injects a brief: all definitions, decisions in force, last 14 days of findings and changes. That's it. Small enough to always be in context.
- `memory.md` is the interpretability view, regenerated alongside the others: disagreements the ledger refused to settle, corrections and the recorded results they put back under review, and work one person pinned from another's by exact version. It counts only what lineage proves, reports what it cannot prove in a Gaps section, and is anchored to the newest record rather than the clock so two machines emit the same bytes. `ledger memory [--days N] [--json]` prints the same view.

## Install

Requires Node 20+ and git.

```bash
git clone <this repo> && cd ledger
npm install && npm link          # puts `ledger` on your PATH
```

**First machine** (creates the data repo):

```bash
ledger init ~/tranzmit-ledger --author agaaz
cd ~/tranzmit-ledger
gh repo create tranzmit/ledger-data --private --source=. --push
ledger install all               # wires Claude Code + Codex
```

**Every other machine:**

```bash
git clone git@github.com:tranzmit/ledger-data.git ~/tranzmit-ledger
ledger use ~/tranzmit-ledger --author rachit
ledger install codex             # or: claude / all
```

Then restart the agent. Verify with:

```bash
ledger brief          # what the agent will see
ledger stats          # should show 0 of everything
```

### What `install` does

**Claude Code** (this is also what Conductor runs, so Conductor workspaces pick it up):
- registers the MCP server at user scope (`claude mcp add --scope user`, or edits `~/.claude.json` if the CLI isn't found)
- installs five hooks in `~/.claude/settings.json`, all `ledger hook <event>`: the checkpoint loop described below
- writes the agent guide to `~/.claude/ledger.md` and adds one `@~/.claude/ledger.md` import line to `~/.claude/CLAUDE.md` inside a marked block

**Codex** (CLI and desktop app share `~/.codex`):
- registers the MCP server (`codex mcp add`, or appends to `~/.codex/config.toml`)
- installs the same five hooks in `~/.codex/hooks.json`. Codex uses the same event names and JSON contract as Claude Code, so `ledger hook <event>` serves both. Codex skips hooks it has not been told to trust: after install, run `/hooks` inside Codex, review the five ledger entries, and trust them. Repeat when the hook commands change (a node upgrade, for instance).
- puts the guide text itself inside a marked block in `~/.codex/AGENTS.md`, since AGENTS.md has no import syntax.

Both are idempotent. Re-run after upgrades; the marked block is replaced. `ledger rules` prints the guide if you want to paste it into a project-level CLAUDE.md or AGENTS.md instead.

Every installed command (the MCP server and each hook) is written with the absolute path of the node binary and of `cli.js`, not the bare `ledger` name. The agent process is launched by Conductor, the Codex app, or a scheduler with whatever PATH it inherited, which usually does not include an nvm bin dir. After upgrading node or this package, re-run `ledger install all`.

The guide (`guides/ledger.md`) is the prompt. It is the same shape Code Almanac uses for its `~/.claude/almanac.md`: mental model in 60 seconds, the read loop, the write loop with a worked example, the decisions the agent will face, what runs automatically, troubleshooting. Standing rules in CLAUDE.md are advisory; the guide is read at the moment of the task. What actually enforces the format is the tool schema, below.

## The checkpoint loop

Do not think of a session as one transaction with a read at the start and a write at the end. Long sessions get compacted and agents forget standing instructions. Think checkpoints:

```
SessionStart   read the brief (and, after a compaction, re-list uncaptured work)
      ↓
work: queries, research
      ↓
PostToolUse    every data-tool call goes in a local session journal (tool, query, time)
      ↓
agent reaches a conclusion and tries to finish the turn
      ↓
Stop           queries since the last record? block once, quote them back
      ↓ record (schema-validated, committed, pushed)   or   ledger_skip_record with a reason
continue
      ↓
PreCompact     uncaptured work is injected into context before it is compressed
      ↓
SessionEnd     capture debt is noted for ledger stats
```

Deterministic software decides *when* to ask. The agent decides *what* it was. The schema decides *what fields* it must have. The transcript is never mined for facts.

| responsibility | owner |
|---|---|
| when to check for knowledge | hook |
| what qualifies as durable | guide |
| what fields must be present | schema |
| was the work actually done | session journal (the evidence quoted in the nudge) |
| how a teammate retrieves it | search and brief |
| what happens at compaction | PreCompact checkpoint, SessionStart re-injection |

One nudge per batch of uncaptured work. A second Stop with the same work passes and is logged as ignored, so the pilot can count it. `ledger stats` reports, per machine: sessions with data queries, records unprompted vs after a nudge, explicit skips, nudges ignored, compactions with uncaptured work.

### What works where

| | tools + schema | brief at start | guide | checkpoint loop |
|---|---|---|---|---|
| Claude Code, incl. Conductor | yes | automatic (hook) | `~/.claude/ledger.md` via CLAUDE.md import | yes |
| Codex CLI and desktop app | yes | automatic (hook, once trusted) | inline in `~/.codex/AGENTS.md` | yes, once the five hooks are trusted via `/hooks` |
| ChatGPT web | test only: `ledger mcp --http --scratch` serves a scratch ledger over HTTPS for a Developer mode app; the team ledger needs login, not built yet | agent must call `ledger_brief` | paste the guide into project or custom instructions | no lifecycle hooks exist |

Conductor runs Claude Code, and everything here is installed at user scope (`~/.claude.json`, `~/.claude/settings.json`, `~/.claude/CLAUDE.md`), so every Conductor workspace gets it. The installed commands use absolute paths, so Conductor's PATH does not matter.

The journal lives in `~/.ledger/sessions/` and never enters the data repo. Which tools count as data work is a regex list, `data_tools` in `~/.ledger/config.json`; the default matches common analytics MCP servers and `psql`/`clickhouse`/`bq`/`duckdb` in Bash.

## The transcript fallback

Live capture is the primary path and should carry 90%+ of what is worth keeping, because the agent still has the query, the window, and the intent in context. The fallback exists for the misses. It is a reconciliation mechanism, not something that runs after every session.

```
Stop / PreCompact checkpoint
        ↓
stable object recorded?
   ├── yes → done
   └── no
        ↓
session ends with debt (SessionEnd)   or   session dies and its transcript goes quiet (reconciler, every 30 min, 20 min quiet)
        ↓
ledger reconcile: read the transcript, run the extractor once for this session
        ↓
durable knowledge the ledger failed to capture?
   ├── no  → journal marked, nothing written
   └── yes → DRAFT objects: status: draft, capture_method: transcript_fallback, source_session, capture_reason
                  ↓
        next brief: "Drafts awaiting review" → promote (record a stable object with supersedes) or discard (with a reason)
```

Rules that do not bend:

- **The extractor never writes trusted memory.** Everything it produces is `status: draft`, kept out of the brief's knowledge sections, out of search, and shown only in the review queue and on the dashboard.
- **Triggers are journal-driven.** A session is a candidate only if its journal shows data-tool calls with no record or skip after them. No journal debt, no extraction. Sessions still being worked in are left alone until their transcript has been quiet for 20 minutes.
- **Once per session.** The journal records the outcome (`drafts`, `none`, `skipped`, `error`) and the session is never reconciled again.
- **Provenance rules in the prompt** (`prompts/operations/capture.md`): numbers come from tool results, not prose; only the human's messages establish a decision; anything the transcript does not state becomes an implicit assumption with `evidence: "not stated in transcript"`; do not duplicate what was recorded live.
- **Drafts are validated leniently** (title and the type's main field required, mistyped fields dropped); promotion applies the full schema.

It runs on your own login: `claude -p --tools ""` or `codex exec --ephemeral`, with `LEDGER_HOOKS_OFF=1` in the child's environment so ledger's own hooks are no-ops inside the extraction session and it cannot journal or block itself. Choose with `extractor: claude | codex | auto | none` in `~/.ledger/config.json`. `ledger reconcile --dry-run` shows what would run. An extractor error (CLI not logged in, network) is retried on later runs, up to three times; `none`, `drafts`, and `skipped` are final. Prompts are composable modules in `prompts/`, the layout Code Almanac uses: `base/purpose.md`, `base/format.md`, `operations/capture.md`.

## Tools the agent gets

| tool | purpose |
|---|---|
| `ledger_brief` | definitions + decisions in force + recent findings and changes |
| `ledger_search` | free text across all types; use before any analysis |
| `ledger_get` | one object in full: query, inputs, method, assumptions, options |
| `ledger_show_contribution` | display an attribution card connecting record IDs to answer passages and agent-reported contributions; does not record knowledge |
| `ledger_record_definition` | canonical metric: formula, source, exclusions, owner, valid_from |
| `ledger_record_finding` | question, result, definitions used, data window, inputs, method, query, assumptions (explicit and implicit), alternatives, confidence and its basis, relation to prior findings. Returns similar prior findings. |
| `ledger_record_change` | what shipped, when, where, to whom, how to undo |
| `ledger_record_decision` | the decision, context, every option considered and why it lost, rationale, assumptions, consequences, confidence, revisit date, how it will be confirmed |
| `ledger_skip_record` | the Stop checkpoint asked and nothing was durable; the reason is counted |
| `ledger_discard_draft` | reject a draft from the transcript fallback, with a reason. Promote by recording a stable object with `supersedes` |
| `ledger_stats` | pilot health, including what the checkpoint loop caught |
| `ledger_memory` | the `memory.md` view in a chat: disagreements left unranked, corrections and their blast radius, work pinned across people, and the gaps behind those numbers |

### Standard chat receipts

Search, get, contribution, and all four record tools return a `ledger-receipt/v1` receipt in `structuredContent.receipt` and as the first line of their text result. The receipt identifies the action, the stored records and authors, and, for writes, the actual commit/push outcome. Retrieved records are **Found**, explicit answer attribution is **Referenced**, and a successful write is **Saved**. Drafts, deprecated sources, unresolved links, and sync failures remain visible.

The Claude and Codex guides ask the agent to show `receipt.display.markdown` verbatim as a boxed chat update immediately after the tool call. Plain-text hosts use `receipt.display.text`. The portable box includes a bulb, rounded border, and wrapped content; Markdown's code block supplies the host's background shading. Exact chat colors remain host-controlled. It is agent-displayed text: this package cannot guarantee that every agent follows the instruction. The existing MCP Apps evidence cards remain available in compatible hosts; record tools currently return receipts, not Apps cards.

The CLI's `search`, `get`, and `record` commands show the same box in interactive terminals, with a cyan border when color is supported. `NO_COLOR` disables color, `TERM=dumb` uses an ASCII border, and `--plain` disables the box. Piped output keeps its previous format unless you pass `--box`. MCP payloads never contain terminal color escapes.

After updating and building, run `ledger install guides` to refresh both agents' instructions without changing MCP registrations or trusted hooks. Start a fresh agent session/reconnect its Ledger MCP server to load the new instructions and server code. Pushing this repository alone does not update teammates' installations.

The interaction contract and host-integration requirements are in [the receipt UX specification](docs/receipt-ux.md).

### Expandable evidence cards (MCP Apps)

`ledger_search`, `ledger_get`, and `ledger_show_contribution` advertise an MCP Apps resource at `ui://ledger/evidence-v1.html`. Compatible hosts render an expandable card with the source author, creation date, lifecycle status, and full record. All three tools still return readable text for hosts without Apps support.

Search cards say **Found**, never **Used**. After referencing evidence in an answer, an agent can call:

```json
{
  "references": [{
    "id": "<actual ID returned by ledger_search or ledger_get>",
    "answer_excerpt": "The exact sentence that refers to this evidence.",
    "contribution": "How this record informed the sentence or next step."
  }]
}
```

The contribution tool resolves identity and status from storage, rejects unknown IDs, and counts unique sources. Excerpts and contributions are **agent-reported**: the tool does not inspect the host's answer, prove causal impact, independently verify findings, measure time saved, or persist a usage history. It does not clear the recording checkpoint. Keep ordinary record citations in the answer as well.

The card contains the record snapshot returned by that call; a later supersession appears on the next lookup, not automatically in an old card. Snapshot hashes identify returned content, not a metric-definition version or verification stamp. Full source text is delivered in result `_meta` for UI inspection. The bundled interface makes no network requests and renders record text without interpreting HTML.

**Try locally:** run `npm run preview:ui`, then open `http://127.0.0.1:4318`. Set `LEDGER_UI_PORT` to change the port. This development host uses the real Ledger MCP server and official Apps bridge, reads your configured local ledger, and exposes only the three evidence tools. Git sync and recording are disabled in the preview. No public tunnel is needed.

`ledger_memory` advertises a second resource, `ui://ledger/memory-v1.html`, rendering the same report as a card: the five headline numbers, each disagreement with its competing claims laid out as equal columns in no order, each correction with the results it put back under review, cross-person pins, and the gaps. Both cards build their DOM with `textContent`, so a record's title or result is never interpreted as markup. The tool's text result is capped at 4 KB and summarises; `ledger_get` fetches any record it names and `ledger memory` prints the whole view.

The interface starts as a compact status pill. Click to expand sources, filter by author, and inspect an original record. In hosts that support calling server tools from Apps, **Reference this source** lets you attach a passage and describe its contribution. **Back to search results** restores the retrieved sources. Escape collapses the panel. The preview adds search suggestions, Command/Ctrl-K to focus search, and light/dark themes. Motion follows the reduced-motion preference.

**In Conductor:** the repository's **ledger** Run action starts the preview on that workspace's assigned `CONDUCTOR_PORT`, so multiple workspaces can run independently. Open the loopback URL printed in the Run terminal. New workspaces install and build with `npm ci`. The scripts use Node 20+ from PATH, falling back to an installed nvm Node 22 from `.nvmrc` if needed. This Run action opens the local preview; it does not add MCP Apps rendering to Conductor's conversation UI.

If the preview cannot initialize the card, it shows the connection stage, offers a reconnect button, and preserves the tool's text response when available. Subsequent searches reuse the connected bridge. The sandbox does not need same-origin access or form-submission permissions: attribution uses a tool call. Restart the preview after changing its host script or page.

**Host requirement:** MCP tool support does not imply MCP Apps support. Restart/reconnect the Ledger MCP server after building so the host discovers the new tool and resource. In an Apps-capable host, ask it to search the ledger, then show the contribution of specific records. Conductor's published MCP configuration docs do not establish that its chat renderer supports Apps. This feature does not inject native Conductor popups or decorate its answer sentences.

Protocol: [MCP Apps build guide](https://modelcontextprotocol.io/extensions/apps/build). Host configuration: [Conductor MCP](https://conductor.build/docs/reference/mcp).

## Recording format

A finding is an argument, not a number. A decision is a choice among options, not a sentence. The schemas require the parts people leave out, and the tool rejects a record without them, naming what is missing. Prose instructions cannot do that; a zod schema can.

**Finding** (shape from ICD 203 analytic standards and the Key Assumptions Check):

- `inputs` — every source, with `dataset`, `population`, and `filters`. At least one.
- `method` — how the inputs became the result, in words, plus optional `grain` and `baseline`. The exact SQL stays in `query`.
- `assumptions` — each with `kind: explicit | implicit`, `evidence`, and `if_wrong: minor | weakens_conclusion | changes_conclusion`. At least one, and at least one implicit. If none is implicit the rejection lists the usual suspects: tracking complete for the window, cohort assignment logged correctly, definition matches, no concurrent experiment or release, same denominator and attribution window as before.
- `alternatives_considered`, `limitations`, `confidence_basis`, `prior: { relation: confirms | revises | contradicts | new }`, `reproduce: { tool, query_or_artifact, instructions }` — optional.

**Decision** (shape from [MADR](https://adr.github.io/madr/)):

- `context` — what forced a decision now.
- `options_considered` — every option on the table including "do nothing", each with `rationale`, exactly the chosen one marked `chosen: true`. At least one.
- `assumptions` — same rule as findings.
- `drivers`, `consequences`, `reversibility`, `confirmation` (a string, or `{ metric, success_condition, evaluate_after }`), `consulted` — optional.

The brief stays small: result and confidence. The full argument is behind `ledger_get` and in the file, where a reviewer on GitHub sees it whole. `ledger stats` counts findings and decisions without an implicit assumption, which after the format change should only be hand-written or legacy files.

## The pilot

Two weeks, two people, then decide.

1. Both of you record every real analysis, ship, and decision for two weeks. No cleanup, no backfill.
2. Every day, `ledger stats`. It reports:
   - objects per author (is anyone actually recording?)
   - findings with no `definitions_used` (drift risk)
   - findings and decisions with no implicit assumption (only possible for hand-written or legacy files)
   - cross-author near-duplicate findings (rework the ledger did *not* catch)
3. At the end, answer three questions honestly:
   - Did an agent ever reuse a finding instead of recomputing?
   - Did an agent ever catch a change it would otherwise have misattributed?
   - Did either of you change a decision because the ledger showed the other's?

If the answer to all three is no, either the capture is too manual (make it automatic: scan transcripts) or the problem isn't real at your scale. Both are useful to learn before HiAstro.

If yes to any, the HiAstro pilot is the same install with `--tags hiastro` and their PMs as authors, and the definitions file seeded from their Amplitude metrics.

## Where you see it

Nowhere new. The data repo on GitHub:

- `README.md` — generated dashboard: definitions table, decisions in force, changes and findings from the last 14 days. Same content the agents get in `ledger_brief`.
- `log.md` — every record, newest first, who and what.
- `definitions/`, `findings/`, `changes/`, `decisions/` — one file per object, each with its own `index.md`.
- Commits — one per record, message is `type: title (author)`. `git log` and `git blame` work.

`ledger brief` and `ledger stats` give the same views in a terminal. A web UI can come later; it would read the same files.

### The brief is budgeted, and the budget is logged

Both harnesses truncate an over-long SessionStart hook payload before the model reads it, and neither says so. On the pilot machine every brief from 2026-09-03 onward was over that limit — 25 KB then, 123,064 bytes on 2026-09-21 — so the agent received a ~2 KB preview that stopped inside the authority warnings and never reached a definition. Nothing detected it, because an agent cannot tell a short brief from a complete one.

`brief()` now renders under a hard byte ceiling (7 KB for the brief, 10 KB for the whole SessionStart payload), spending it in priority order: unresolved accepted conflicts, authority warnings, definitions in force, decisions, findings, changes, drafts. Records are kept whole — a half-rendered definition is a wrong definition — and every omission is stated with its exact count and the query that returns it, section by section and again in a closing `## Not in this brief` block. Definitions overflow to their metric names, because knowing `trial_start_cvr` is defined costs ~20 bytes and not knowing it costs a reinvented denominator. A brief re-injected after a resume or a compaction says it replaces the earlier copy. `ledger brief --full` prints the unbudgeted text.

Each injection is recorded through the usage path (`src/usage.ts`), which writes to a bounded local spool first and uploads later, so it survives Postgres being down and is a silent no-op when continuity is not configured. The record carries record ids, byte size and the dropped count — never a record body. `ledger replay [--session ID] [--json] [--html FILE]` plays one session's knowledge trail back in order: what was injected, which records were returned, which the agent cited with `ledger_show_contribution`, what it saved. It names both sources and says which one it could not read, so a trail is never quietly half a trail. Found is retrieval, referenced is the agent's own claim, saved is a record.

## OKF

The data repo is a conformant [OKF v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle, checked by the self-test:

- every non-reserved `.md` has YAML frontmatter with `type`
- `generated: { by: human:<name>, at }`, `status: stable | deprecated`, `supersedes`, `sources`, `stale_after` (decisions' `revisit_by`) follow the spec's trust and lifecycle families
- reserved `index.md` (progressive disclosure, root carries `okf_version`) and `log.md` (newest-first history) are generated
- our type-specific fields (`question`, `data_window`, `formula`, ...) are extension keys, which the spec requires consumers to preserve

So any OKF reader (Google's tooling, `serradura/okf`, an agent with a generic OKF skill) can consume the ledger, and you can move it out of this tool without conversion. The spec's `Attested Computation` type is the natural next step for `definitions` if HiAstro's number drift turns out to be about *how* a metric was run rather than *what* it means: the formula becomes a parameterized computation, the agent can only fill parameters, and an attester checks the executed SQL matched. Not built. Noted.

## What's deliberately not here

- No embeddings. Term overlap over a few hundred objects is fine. Add them when search visibly misses.
- No web UI. GitHub renders the generated README.
- No transcript mining as a primary path. Recording is an explicit, schema-validated tool call by the agent that did the work, prompted by a deterministic checkpoint. The transcript fallback runs only for sessions whose journal proves live capture failed, writes drafts only, and never a trusted fact.
- No fifth object type. Add one when an agent visibly needed something and couldn't find it.

## Object format

```markdown
---
type: finding
id: fnd-20260902-trial-cvr-august-k3p2
title: Trial CVR August
description: What was trial to paid conversion in August for iOS? → 11.2% (n=4,310 trials)
tags: [hiastro]
status: stable
generated:
  by: human:agaaz
  at: '2026-09-02T10:14:00.000Z'
sources:
  - id: primary
    resource: postgres.subscriptions
question: What was trial to paid conversion in August for iOS?
result: 11.2% (n=4,310 trials)
definitions_used: [trial_to_paid_cvr]
data_window: { from: '2026-08-01', to: '2026-08-31' }
inputs:
  - source: postgres.subscriptions
    population: trials started in window
    filters: platform='ios', excludes internal users
method: Cohort by trial start date. Paid within 14 days over trials started.
grain: user
query: select ... where platform='ios'
assumptions:
  - { statement: iOS means App Store, not web checkout on an iPhone, kind: explicit, if_wrong: changes_conclusion }
  - { statement: postgres.subscriptions is complete for August, kind: implicit, evidence: row counts match the ETL log, if_wrong: changes_conclusion }
  - { statement: the paywall test shipped 2026-08-20 does not invalidate a monthly figure, kind: implicit, evidence: not independently verified, if_wrong: weakens_conclusion }
alternatives_considered: [attributing by payment date instead of trial start, rejected, mixes cohorts]
limitations: [observational]
confidence: medium
confidence_basis: n is large; one implicit assumption unchecked
prior: { relation: new, ids: [] }
caveats: []
---
Optional markdown body, kept short.
```

Frontmatter is the contract. Body is optional. The generated dashboard shows the result; `ledger_get` and the file show the argument.

## Development

```bash
npm run build
npm test        # builds, then runs an end-to-end test incl. the MCP server over stdio
npm run preview:ui  # local read-only MCP Apps host, http://127.0.0.1:4318
```

MIT.
