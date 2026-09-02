# Object format

Every object is JSON with a `type` and `fields`. Field names are exact. Dates are `YYYY-MM-DD`.

## finding

A finding is an argument, not a number: what was concluded, from what inputs, by what method, under what assumptions.

```json
{
  "type": "finding",
  "fields": {
    "title": "short, specific",
    "question": "the question that was actually answered",
    "result": "the claim: headline numbers with units, or the comparison",
    "definitions_used": ["metric names, if the transcript names them"],
    "data_window": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" },
    "inputs": [{ "source": "mixpanel | clickhouse | postgres.table | ...", "dataset": "optional", "population": "optional", "filters": "optional, sql or words" }],
    "method": "how the inputs became the result, in steps, in words",
    "query": "the exact query text if it appears in the transcript",
    "assumptions": [
      { "statement": "...", "kind": "explicit | implicit", "evidence": "what supports it, or 'not stated in transcript'", "if_wrong": "minor | weakens_conclusion | changes_conclusion" }
    ],
    "alternatives_considered": [],
    "limitations": [],
    "confidence": "low | medium | high",
    "confidence_basis": "why",
    "caveats": []
  }
}
```

## decision

```json
{
  "type": "decision",
  "fields": {
    "title": "short",
    "decision": "stated so it can be false later",
    "context": "what forced a decision",
    "options_considered": [{ "option": "...", "chosen": true, "rationale": "..." }, { "option": "do nothing", "rationale": "..." }],
    "rationale": "...",
    "assumptions": [{ "statement": "...", "kind": "implicit", "evidence": "not stated in transcript", "if_wrong": "changes_conclusion" }],
    "consequences": [],
    "confidence": "low | medium | high",
    "valid_from": "YYYY-MM-DD",
    "revisit_by": "YYYY-MM-DD, if stated",
    "owner": "person name"
  }
}
```

## change

```json
{ "type": "change", "fields": { "title": "...", "what": "what shipped, one sentence", "shipped_at": "YYYY-MM-DD", "surface": "paywall | pricing | onboarding | sdk | backend | ...", "owner": "person", "scope": "who got it", "rollback": "how to undo, if stated" } }
```

## definition

```json
{ "type": "definition", "fields": { "title": "...", "metric": "snake_case_name", "formula": "exact computation", "source": "system of record", "owner": "person", "valid_from": "YYYY-MM-DD", "exclusions": [] } }
```
