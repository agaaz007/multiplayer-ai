# D04: the limits probe — ours vs gbrain on one buried history

Status as of 15 September 2026: **two scored runs. The probe discriminates at `--noise 20` but the
`ours` arm is not validly measured in either run.** GBrain missed the planted assumption in the larger
history (3/4); the Ledger arm scored 4/4 from a boot brief that already contained the answer and from a
previous trial's record leaked through a shared database. Read "The second live run" and
[[fnd-20260914-d04-eval-harness-shared-eval-postgres-leaks-prio-s2ex]] before treating any of this as a
comparison.

## The question

Three things happen in real PM history, and each has a distinct failure mode for a memory product:

| Plant | Fixture events | The failure it catches |
| --- | --- | --- |
| A corrected number | `cvr-first` (12.4%), `cvr-correct` (9.8%, deduplicated) | Both numbers stay in history and both match "trial-start CVR" equally well. A store that ranks by similarity has no notion of which is current. |
| A rejected option | `options` (price cut / longer trial), `reject` | The text *discussing* the price cut is longer and more on-topic than the sentence retiring it, and the rejection lives in the other session. |
| An assumption nobody states | `filter` (`platform = android` in the where clause) | Said once, as a mechanical query detail, three turns before the number it qualifies and in the earlier session. Nobody ever calls it an assumption or a caveat. |

The successor is asked for all three and must cite source text it actually retrieved.

## What makes it a comparison rather than a demo

Both arms receive **the same normalized origin transcript**, produced by the same real origin turns:

- `ours` runs the production capture path — the real helper, a verified shadow snapshot, turn
  checkpoints, then the real classifier synchronously — and the successor reaches it over Ledger MCP.
- `gbrain` gets a controller-side ingest of the same events: one page per event with frontmatter,
  two tags each, a session index page and a timeline entry, then `embed --all`, served to the
  successor through `gbrain serve`.

The gbrain ingest is deliberately **more generous than the product's own workflow**, which is
agent-authored `put_page` calls that an agent has to remember to make. Lossless ingest of every event
is the strongest form of the arm. If it still fails a plant, that is a structural limit rather than a
capture-discipline artifact — which is the whole point of calling this a limits probe.

## Scoring

`eval/kit/continuity_eval.py` owns the oracle; the adapter never sees expected values. An answer passes
only when the value matches **and** the successor's cited text was present in one of its own tool
outputs, backed by a retained raw trace. Guessing 9.8 fails.

Four checks, all critical:

| Key | Expected | Required source |
| --- | --- | --- |
| `trial_start_cvr_pct` | `9.8` | `cvr-correct` |
| `rejected_option` | `price_cut` | `reject` |
| `rejection_reason` | `locked` | `reject` |
| `cvr_caveat` | `android` | `filter` |

`rejected_option` requiring `reject` (not `options`) is load-bearing: naming the price cut from the
turn that *proposed* both options is not evidence that it was retired.

Answer checks may now carry `accept`, a list of further spellings of the same fact ("Price cut to 149",
"store price locked", "Android only"). It exists so a phrasing difference is not scored as a memory
failure; it never admits a different fact, and `test_accept_does_not_admit_a_different_fact` pins that.
Checks without `accept` keep exact matching, so D01–D03, R01–R02 and E01–E03 are unchanged.

## Running it

```sh
eval/run-limits.sh                       # one case, two arms, codex-to-claude, one repetition
eval/run-limits.sh myrun --noise 20      # widen the gaps between planted facts
```

`--noise` is the number of unrelated turns in each gap (default 2, twelve fixture events total). At 2
the history is short enough that a successor could in principle read it end to end, so retrieval is
barely exercised; raise it to separate retrieval from recall. Origin turns are real model calls, so
cost scales with it.

The script refuses to run without `OPENAI_API_KEY`, because gbrain embeds on write and silently falls
back to keyword/tsvector search without one. A D04 history is small and lexically close to its own
questions, so a keyword-only arm can look fine while the product's actual hybrid retrieval goes
untested. Set `LEDGER_EVAL_GBRAIN_KEYWORD_ONLY=1` to run that arm deliberately and report it as such.

## The first live run (`d04-live-n2`, 14 September 2026)

D04 at `--noise 2` (12 fixture events), codex-to-claude, one repetition. Origin: codex/`gpt-6-astra` as
rachit for session-a, claude-haiku-4-5 as agaaz for session-b. Successor: claude-sonnet-5 both arms.
Claude-reported cost $0.36 total (ours $0.238, gbrain $0.123); codex usage is not priced in that figure.

**As scored at the time: ours 4/4 pass, gbrain 3/4 fail on `rejection_reason`.**
**That gbrain failure was a scoring artifact, not a memory failure.** Both arms retrieved the same
sentence and stated the same reason; ours wrote `price_locked_for_quarter`, which happened to be in the
`accept` list, and gbrain wrote `locked_pricing`, which happened not to be. The check now matches on the
stem `lock` instead (see `answer_check`), and re-scoring the **same retained observations** gives
**4/4 for both arms**. Reproduce with `eval/runs/d04-live-n2-rescored`.

The rule was changed after seeing the answers. That is disclosed rather than quietly folded in: the
as-run matrix in `eval/runs/d04-live-n2/matrix.md` still records the original verdict.

On the facts, both products recovered all three plants:

| Plant | ours | gbrain |
| --- | --- | --- |
| Corrected number | 9.8, citing the correction | 9.8, citing the correction |
| Rejected option + reason | `price_cut` / `price_locked_for_quarter` | `price_cut` / `locked_pricing` |
| Unstated assumption | `android_only` | `android_only` |

**Why it did not discriminate: at this size there was no retrieval problem to solve.** GBrain's session
pages are complete linear transcripts — every normalized event, in order, with full text. Its successor
called `search` twice and `get_page` once and had the entire history in context; three tool calls, 24 s.
Ours took a different route — `ledger_investigation` → `ledger_resume(record, inspect)` → `ledger_search`
→ two `ledger_events` calls across both session ids; six tool calls, 32 s — but it too could see
everything. Neither arm had to *find* anything. `--noise 2` tests the successor's reading comprehension,
which is the weakness this document already warned about; the run confirmed it empirically.

Two differences did show up, neither of them scored:

- Ours volunteered the acceptance state unprompted: "All of this remains [PROPOSED], not confirmed by a
  person — nobody has run `ledger record confirm` on these state updates." Nothing in the prompt asked.
- GBrain's free-text `notes` independently flagged the Android-only condition as never restated as a
  caveat, so on this history it surfaced the hidden assumption in prose as well as in the scored answer.

The next run must raise `--noise` far enough that neither a session page nor a resume pack can carry the
whole history, which is the only condition under which the three plants test retrieval rather than
reading. Until then D04 has no comparative result.

## The second live run (`d04-live-n20`, 14 September 2026)

Same protocol at `--noise 20`: 66 fixture events, 43 on codex as rachit and 23 on claude-haiku as
agaaz, with **43 turns between the `platform = android` filter and the corrected number it qualifies**.
Capture scale: Ledger took 53 events from the codex session alone; GBrain wrote 147 event pages + 2
session pages, 149 puts, 298 tags, 147 timeline entries, embeddings complete, in 219 s. Claude-reported
cost $0.45 (codex/`gpt-6-astra` origin usage not priced).

| Check | ours | gbrain |
| --- | --- | --- |
| `trial_start_cvr_pct` | 9.8 | 9.8 |
| `rejected_option` | `price_cut` | `price_cut` |
| `rejection_reason` | `price_locked_for_quarter` | `price_locked` |
| `cvr_caveat` | `android_only` | **`preliminary_no_significance_conclusion` — fail** |

**The size increase worked.** GBrain went from 3 tool calls and 24 s at `--noise 2` to 10 calls and 73 s,
visibly hunting: `query` → `search` → `get_page` → `search "9.8 percent deduplicated CVR condition"` →
`search "trial-start CVR caveat"` → `search "dedup"` → `search "saw the paywall twice"`. At this size the
history no longer fits in one page, so retrieval is finally the thing being tested.

**How it failed is the informative part.** GBrain's cited evidence *contains* the Android fact
("Android-only measurement; iOS excluded (export still backfilling at pull time)"), so the information
reached its context. It answered a different caveat anyway — the "preliminary result; no conclusion
about lift or significance yet" status — and explained the choice in its notes: that status line "was
dropped when the notes were rewritten with the sizing table". That is a defensible answer to the
question as worded.

Two design weaknesses follow, and they are the probe's, not the product's:

1. **At high noise the origin agents manufacture their own caveats.** `experiment-notes.md`, written by
   an origin agent, carries a preliminary/significance disclaimer that was genuinely dropped later. "The
   condition nobody wrote down" stops being unique once agents write prose into the workspace, so the
   check silently becomes "pick the caveat the grader had in mind".
2. **The Android fact survived only in a derived artifact.** GBrain quoted the origin's own file, not
   the human turn. The check requires the fixture text, so a successor reconstructing the right fact
   from a summary cannot pass, while one that never saw the original also cannot. Those are different
   failures and the current check cannot tell them apart.

### Why the ours arm is not a result

Its successor's boot brief, before any tool call, contained:

    ## Open work (records) (this repo first), last 14 days
    - investigation · Marriage-intent paywall trial-start CVR … · 7e2518ac-…
      PROPOSED next: "Size the 14 day trial experiment from the deduplicated 9.8% trial-start CVR."

and elsewhere quoted the origin back as "two options to lift the **Android-only 12.4% trial-start CVR**",
fusing the hidden filter to the number. `trial_start_cvr_pct` was therefore never a retrieval test for
this arm at any noise level. Supplying that brief is intended product behaviour, not cheating — but it
means the two arms are not performing the same task, and D04 as written does not say so.

Worse, the brief listed records from **other trials' repos** despite being labelled "this repo first".
The `noise=20` successor's first two calls were `ledger_record_get` on its own record *and* on
`c487f23e`, the `noise=2` record written 18 minutes earlier, whose PROPOSED line also stated the
corrected 9.8% figure. All phase-1 `ours` trials share one `ledger_eval` Postgres database; GBrain gets
a fresh PGLite brain per trial HOME, so the contamination is one-directional and favours `ours`.
Details, evidence and assumptions: [[fnd-20260914-d04-eval-harness-shared-eval-postgres-leaks-prio-s2ex]].

**Standing scoreboard: GBrain 3/4, measured cleanly. Ledger unmeasured.**

Before the `ours` arm can be re-run for a comparative number:

- give each trial its own database or schema, and scope the brief's record list to the trial repo;
- decide explicitly whether the boot brief is part of what is being compared. If it is, say so and
  measure both arms with whatever boot context each product actually provides. If it is not, the ours
  successor must start without it. Either is defensible; leaving it undeclared is not;
- make `cvr_caveat` robust to origin-authored caveats, or accept the Android fact from a derived
  artifact and score the two failure modes separately.

## What this does not measure

- **Retrieval, at low `--noise`.** Demonstrated in the first run, not hypothesised.
- **Anything about Ledger, at either noise level.** Its arm booted with the answer and read another
  trial's records; both runs are diagnostic-only for that arm.
- **Whether a successor spontaneously suspects the assumption.** The resume prompt asks for "any
  condition attached to that CVR that the team never wrote down as a caveat". That wording avoids
  naming *which* condition, but it does tell the successor to go looking. D04 measures whether each
  product can *deliver* a never-flagged qualifier on demand, not whether it volunteers one. An
  unprompted variant cannot reuse this mechanism at all: `answer_keys` are shown to the successor, so
  a key named `cvr_caveat` is itself the hint. It needs a new check type that scores free text.
- **Reliability.** One case at one repetition in one direction is an existence proof either way.
- **Capture effort.** The gbrain arm's pages are written by the controller, so no part of this counts
  what it costs a team to keep either store populated in real use.
- **A product comparison at the analytical lane's standard.** `analytical-benchmark.md` requires an
  isolation audit, blind grading, cost reconciliation and human-time accounting before a grade counts
  as comparative. D04 inherits phase-1's diagnostic status, not that bar.

## Two pre-existing failures fixed to get here

Both reproduce on `origin/master` (5364efa) and both blocked the `ours` arm before any successor ran:

1. `assertLocalBriefGuide` checked that `lines[2]` of the startup brief was the `Rules:` line. The
   analytical-scope work (3486dfe) inserted the activity-summary line above it, and conflict/authority
   warnings appear above it conditionally, so **every** `ours` trial failed on a brief that was in fact
   correctly pointed at the frozen trial guide. It now finds the generated rules line by prefix. The
   check stays on the first such line only, preserving the existing rule that a stored record quoting
   the global path must not trip it.
2. D02 wrote metric-v2 with `supersedes` alone. Since the acceptance layer landed, an accepted
   replacement also needs `acceptance.expected_predecessor.{id, version}` and an evidence ref, so D02
   errored out in both conditions. It now re-reads the persisted predecessor and supplies them.
