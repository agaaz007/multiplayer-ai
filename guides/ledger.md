# Ledger — shared team memory, read first, written last

This machine has a `ledger` MCP server. It holds the team's canonical metric **definitions**, past **findings**, shipped **changes**, and **decisions** in force, as markdown files in a git repo that every teammate's agents read and write. You are the primary reader and the primary writer. A checkpoint runs when you try to finish a turn: if data queries ran and nothing was recorded, you will be asked to record or to say why not. Nothing reconstructs your work from the transcript afterwards.

---

## The mental model in 60 seconds

Four object types. Each has one moment you read it and one moment you write it.

| type | read it before | write it when | it kills |
|---|---|---|---|
| **definition** | writing any query | you compute a metric with no definition, or a definition changes | two people getting different numbers for the same metric |
| **finding** | starting an analysis | an analysis finishes, however small | redoing work someone did on Tuesday |
| **change** | attributing a metric move | something ships | crediting your test for someone else's fix |
| **decision** | proposing direction | a direction is chosen, dropped, or reversed | two agents compounding in opposite directions |

Analysis is not a fifth type. Analysis is the process; a finding is its durable output and carries its own inputs, method, assumptions, and how to reproduce it.

Objects are never edited. A refresh or reversal is a new object with `supersedes`; the old one becomes `deprecated` and drops out of the brief. Record under the human's name. Agents are ephemeral; people own claims.

The brief you got at session start (definitions, decisions in force, last 14 days of findings and changes) is the whole ledger at a glance. Everything else is one tool call away.

---

## The read loop

Do these before the work, not after.

- **Before writing a query:** use the ledger definition verbatim. If the metric has no definition, record one with `ledger_record_definition` before reporting a number. A number without a definition is not a finding.
- **Before an analysis:** `ledger_search` with the question. If a finding exists, reuse it, or refresh it with `supersedes`. Never silently recompute.
- **Before attributing a metric move:** `ledger_search` with type `change` over the window. Something probably shipped.
- **Before proposing direction:** `ledger_search` with type `decision`. It may already be decided, or decided against.

---

## The write loop: a finding is an argument, not a number

"iOS users seem to convert better" is useless to a teammate two days later. What they need is: what exactly was concluded, from what inputs, by what method, under what assumptions, and how to reproduce it.

`ledger_record_finding` rejects a record that lacks inputs, method, or assumptions. It also rejects an assumptions list with no implicit assumption, and tells you what to add. This is deliberate. The parts of an analysis people leave out are the parts that make two PMs get two different numbers.

Before recording, run the **key assumptions check**, three questions:

1. What must be true about the **data**? (event tracking complete for the window, correct table, cohort assignment logged correctly, filters match the population)
2. What must be true about the **definition**? (matches the ledger, matches what the asker meant, same denominator and attribution window as the previous analysis)
3. What happened in the **window**? (no other experiment or release touched this population, no holiday or outage, window is representative)

Anything you relied on without anyone saying it is `kind: implicit`. Anything the asker stated is `kind: explicit`. Mark `if_wrong` as `minor`, `weakens_conclusion`, or `changes_conclusion`.

A complete finding:

```json
{
  "title": "Marriage vs general intent, trial-start CVR, Android IN",
  "question": "Does intent=marriage convert to trial start better than intent=general?",
  "result": "Marriage users had 18.2% higher trial-start CVR (12.4% vs 10.5%, n=41,200 vs 118,900)",
  "definitions_used": ["trial_start_cvr", "paywall_impression"],
  "data_window": { "from": "2026-08-20", "to": "2026-08-31" },
  "inputs": [
    { "source": "mixpanel", "dataset": "hiastro-production", "population": "users shown subscription_paywall", "filters": { "country": "IN", "platform": "android" } }
  ],
  "method": "Per-user trial-start conversion compared between the marriage and general intent cohorts, cohort by first paywall impression in the window.",
  "grain": "user",
  "baseline": "general intent",
  "query": "SELECT intent, countIf(trial_started)/count() FROM paywall_resolved WHERE ... GROUP BY intent",
  "assumptions": [
    { "statement": "Intent assignment is logged correctly on paywall_resolved", "kind": "explicit", "evidence": "intent field present on 99.7% of rows", "if_wrong": "changes_conclusion" },
    { "statement": "No other experiment was disproportionately allocated across the two intent cohorts", "kind": "implicit", "evidence": "not independently verified", "if_wrong": "changes_conclusion" },
    { "statement": "Event tracking was complete for the window", "kind": "implicit", "evidence": "daily event counts flat", "if_wrong": "weakens_conclusion" }
  ],
  "alternatives_considered": [
    "Marriage users could differ in acquisition source: not checked",
    "Different paywall variants could explain the uplift: variant distribution is 51/49, so unlikely"
  ],
  "limitations": ["Observational comparison, not randomized"],
  "confidence": "medium",
  "confidence_basis": "Large sample, but cohort confounding remains possible",
  "prior": { "relation": "new", "ids": [] },
  "reproduce": { "tool": "mixpanel", "query_or_artifact": "queries/intent-cvr-aug.sql", "instructions": "Run against production events using the definitions above" }
}
```

The tool returns similar prior findings. If one exists and yours is a refresh, set `supersedes`. If the numbers disagree, say why in `caveats` and set `prior.relation: contradicts`.

A decision follows the same rule with a different shape, borrowed from MADR (Markdown Any Decision Records): the options that lost are as important as the one that won, and the decision must say how it will be confirmed.

```json
{
  "title": "Prioritize marriage intent on Android for the next paywall experiment",
  "decision": "The next paywall experiment targets marriage intent on Android; career and iOS wait one cycle",
  "context": "One experiment slot this cycle. Intent cohorts differ in observed CVR and in size.",
  "drivers": ["largest addressable cohort", "highest observed conversion gap", "fastest experiment cycle"],
  "options_considered": [
    { "option": "Marriage / Android", "chosen": true, "rationale": "highest expected impact" },
    { "option": "Career / Android", "rationale": "lower traffic" },
    { "option": "Marriage / iOS", "rationale": "smaller addressable population" },
    { "option": "Do nothing this cycle", "rationale": "slot would go unused" }
  ],
  "rationale": "Expected trials per cycle is highest for marriage on Android by a wide margin.",
  "assumptions": [
    { "statement": "Observed intent uplift will survive randomization", "kind": "implicit", "evidence": "fnd-20260903-marriage-vs-general-intent-k3p2 is observational", "if_wrong": "changes_conclusion" }
  ],
  "consequences": ["Career experiments delayed by one cycle"],
  "reversibility": "reversible",
  "confidence": "medium",
  "valid_from": "2026-09-03",
  "revisit_by": "2026-10-01",
  "confirmation": { "metric": "trial_start_cvr", "success_condition": "+10% relative uplift vs control", "evaluate_after": "10,000 eligible exposures" },
  "based_on": ["fnd-20260903-marriage-vs-general-intent-k3p2"],
  "consulted": ["rachit"],
  "owner": "agaaz"
}
```

Changes and definitions are short. A change is what, when, where, to whom, and how to undo. A definition is the exact formula, the source, the exclusions, and an owner.

---

## Decisions you'll face

**"Was that an analysis?"** If you ran a query against real data and reported a number, yes. Record it, even with `confidence: low`. A rough number with its assumptions written down beats no record. The bar is "would someone recompute this next week": if yes, record.

**"The checkpoint asked, but nothing here is a finding."** Call `ledger_skip_record` with the reason: exploration, a sanity check that confirmed nothing, a dead end. It clears the checkpoint and is counted, so be honest. Do not use it to get past the reminder when there is a number someone will want.

**"A similar finding already exists."** Read it with `ledger_get`. Same question, older data: record yours with `supersedes`. Same question, same window, different number: record yours with `prior.relation: contradicts` and say why in `caveats`. Different question that happens to share words: record as new.

**"There is no definition for this metric."** Record one first. Say what you computed, exactly, with exclusions. If the asker disagrees later, the definition gets superseded, and the finding still says which definition it used.

**"The user only wanted a quick look."** Still a finding. Quick looks become decisions.

**"Whose name goes on it?"** The person you are working for. Never the agent.

**"Should I fix the old object?"** No. Record a new one with `supersedes`. History is the point.

**"The tool rejected my record."** Read the message. It names the field and, for assumptions, lists the common implicit ones. Add what is missing and call again. Do not drop fields to get past validation.

**"The brief says drafts are awaiting review."** These came from the transcript fallback: a session ran queries, nothing was recorded live, and an extractor read the transcript afterwards. They are not in force and not to be trusted. For each one: `ledger_get` it, check the number against the query and the window, then either record a stable object with `supersedes` set to the draft id (the full format applies, so add the assumptions the extractor could not know), or `ledger_discard_draft` with the reason. Do not leave them sitting; the queue is the signal that live capture failed.

---

## The tools

| tool | when |
|---|---|
| `ledger_brief` | start of any session touching metrics, analysis, direction, or shipping (injected automatically in Claude Code) |
| `ledger_search` | before any analysis, attribution, or proposal. Free text across all types, filter by type or tag |
| `ledger_get` | one object in full, including its query, inputs, assumptions, and options |
| `ledger_record_definition` | a metric was computed with no definition, or a definition changed |
| `ledger_record_finding` | an analysis finished. Returns similar prior findings |
| `ledger_record_change` | something went live |
| `ledger_record_decision` | a direction was chosen, dropped, or reversed |
| `ledger_skip_record` | the checkpoint asked and nothing was durable; give the reason |
| `ledger_discard_draft` | a draft in the review queue is not durable knowledge; give the reason. To promote instead, record a stable object with `supersedes` |
| `ledger_stats` | pilot health: who records, what the checkpoint caught, findings missing definitions or assumptions, duplicates across authors |

Every record commits and pushes. Every read pulls. Teammates see each other's objects within a minute.

---

## What runs automatically

In Claude Code and in Codex (CLI and desktop app), five hooks make the loop deterministic. None of them decide what counts as knowledge; they only decide when to ask.

- **SessionStart:** the brief is injected. After a compaction or resume, any uncaptured queries from earlier in the session are listed again, so nothing is lost when context is compressed.
- **PostToolUse:** every data-tool call (MCP analytics servers, `psql`/`clickhouse`/`bq`/`duckdb` in Bash) is noted in a local session journal: tool, query text, time. This is evidence, not knowledge. It never leaves the machine.
- **Stop:** when you try to finish a turn with queries since the last record, the stop is blocked once and the queries are quoted back. You record, or you call `ledger_skip_record`. The same batch is never asked about twice.
- **PreCompact:** if uncaptured queries exist when context is about to be compacted, they are injected into context with a request to record now, while method and assumptions are still in your head.
- **SessionEnd:** if queries ran and nothing was recorded, live capture has failed for this session, and the transcript fallback starts in the background: an extractor reads the transcript and writes **drafts**, never stable objects. A reconciler also runs every 30 minutes for sessions that died without a SessionEnd, once their transcript has been quiet for 20 minutes. Drafts show up in the next brief under "Drafts awaiting review".

Codex runs the same five hooks from `~/.codex/hooks.json`, but skips any hook that has not been trusted. If the checkpoint never fires in Codex, the user has not run `/hooks` and trusted the ledger entries yet; tell them. Until then, call `ledger_brief` yourself at the start of a relevant session and record before you finish.

---

## Troubleshooting

- **"No ledger configured."** The machine has not run `ledger init` or `ledger use`. Tell the user; do not work around it.
- **"committed locally; push failed"** in a record result. The object is saved and will push with the next record. Continue.
- **Brief is empty.** New ledger, or every object is deprecated. Record definitions before computing anything.
- **Two findings disagree.** Both stay. Record a third with `prior.relation: revises`, say which assumption differed, and set `supersedes` on the one that was wrong.
- **The checkpoint fires on a tool that is not data work.** The pattern list is `data_tools` in `~/.ledger/config.json`; tell the user.
