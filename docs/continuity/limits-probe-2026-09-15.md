# D04: the limits probe — ours vs gbrain on one buried history

Status as of 15 September 2026: **built and validated without models; no scored trial has run.** Every
result below is from the fake-successor path, which exercises the plumbing and the oracle, not memory
or model capability. Nothing here is a measurement of Ledger or GBrain.

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

## What this does not measure

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
