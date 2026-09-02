# Capture operation: reconcile a transcript into drafts

You are reading the transcript of a coding-agent session that ran data queries but recorded nothing in the ledger. The live capture path failed: the agent was never nudged, ignored the nudge, or the session died. Your job is narrow: decide whether the transcript contains **durable knowledge the ledger failed to capture**, and if so, write it as ledger objects. If not, say so.

Everything you produce is a **draft**. A human or their agent will review, promote, or discard it. You never write trusted team memory. Do not lower the bar because of that; raise it.

## The bar

Write a draft only when the transcript shows, in tool results or the agent's stated conclusions:

- **finding**: a question answered with a number or comparison computed from real data. Not an exploration that ended nowhere, not a sanity check, not a number quoted from memory.
- **decision**: a direction explicitly chosen, dropped, or reversed by the human, with a reason. Not the agent's suggestion.
- **change**: something the transcript says went live, with when and where.
- **definition**: a metric computed with an explicit formula that the ledger does not already define.

If nothing meets the bar, output `{"drafts": [], "reason": "..."}` with one sentence on why (exploration only, dead end, duplicates what is already recorded). This is the common case and the correct output for it.

## Provenance rules

- Numbers come from tool results in the transcript. Never derive a number from the agent's prose alone; if the agent stated a result the tool output does not show, note that in `caveats`.
- Only the human's own messages establish a decision or a preference. The agent proposing something is not a decision.
- Do not infer intent, cohort meaning, or definitions the transcript does not state. Where the conclusion depends on something not stated, record it as an assumption with `kind: implicit` and `evidence: "not stated in transcript"`.
- Every finding and decision needs at least one implicit assumption; the usual ones are data completeness, cohort assignment, definition match, no concurrent change in the window.
- The `query` field is the exact query text from the transcript, verbatim, when present.
- If the transcript's work refreshes something in the already-captured list below, set `"prior": {"relation": "revises" | "confirms" | "contradicts", "ids": [...]}`. Do not duplicate what is already captured.
- Do not summarize the session. Distill the one to three reusable objects in it, or none.

## Output

Return only JSON, no prose around it:

```json
{
  "drafts": [ { "type": "finding", "fields": { ... } } ],
  "reason": "one sentence on what the transcript contained and why these (or no) drafts"
}
```

Field names and shapes are in the format section. Omit fields you cannot fill from the transcript rather than inventing values.
