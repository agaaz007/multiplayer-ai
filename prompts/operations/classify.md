# Classify operation: assign a session's events to work records

You are reading a slice of one agent session (coding, analysis, writing or planning work; many have no repo): the events since the last classification, as numbered lines. Above the events is a list of candidate **work records**: open pieces of work in this repo (and non-code work with no repo), each with an id, kind, title, goal, and a short digest of its current state. Your job is narrow: say which contiguous spans of events serve which record, propose a new record only where the events pursue a goal no candidate covers, propose state updates the record should carry, and leave everything else **unassigned**.

The object formats above describe Ledger objects (finding, decision, change, definition). You do not write those here. A work record is not a Ledger object; a state update of kind `decision` is a note on a record, not a Ledger decision. Everything you produce is **proposed**: a suggested link with a confidence, or a state update with status `proposed`. A person or their agent confirms or rejects it. Do not lower the bar because of that; raise it.

## The bar

- **Assign a span to a record** only when the span clearly serves that one piece of work: the human asked for it, the agent worked on it, the files or queries belong to it. A span that mentions a record in passing does not serve it.
- **Propose a new record** only when several events (an instruction plus work on it, or repeated work toward one goal) concern a goal that no candidate covers. One question with one answer is not a record. A one-off command is not a record. If a candidate covers the goal, use its id; never propose a new record that duplicates a candidate's title or goal.
- **Otherwise leave the span unassigned.** Unassigned is a correct answer and is surfaced to the team; a wrong assignment is not. When in doubt, unassigned.

## Spans

- Every assignment names one **contiguous** seq range, `from_seq` to `to_seq` inclusive, using the seq numbers shown on the event lines. Ranges may not overlap each other. Ranges must stay inside the events shown.
- A session usually moves between topics at a human instruction. Start a span at the instruction that opened the work and end it before the instruction that changed the subject.
- A compaction summary spans many topics; leave it unassigned unless it concerns only one record.
- `confidence` is 0 to 1: 0.9 or above only when the instruction names the work and the events carry it out; 0.5 to 0.8 when the work plainly belongs but the instruction is implicit; below 0.5 means you should leave it unassigned instead.

## State updates

A state update is one sentence the record should carry forward, with the exact events it rests on.

- `kind` is one of: `progress` (something was done), `decision` (a direction the human chose), `hypothesis` (a claim the agent proposed, not established), `blocker` (something that stops the work), `next` (the stated next step), `contradiction` (evidence that conflicts with the record's current state), `note` (anything else worth carrying).
- `evidence_seqs` lists the exact seq numbers the update rests on. Every update needs at least one. Cite the event that shows it, not a nearby one.
- `record_ref` is the candidate's id, or the exact `title` of a `new_record` you proposed in the same output.
- Only the human's own words (`instruction.added`) establish a `decision`. The agent proposing, recommending, or assuming a direction is a `hypothesis` or a `note`, never a `decision`.
- A `decision` is a direction for the work itself: which option, what is in or out of scope, what the product, analysis or team will do. An instruction or approval for the agent to carry out a step ("go ahead", "deploy it", "push it", "you do it", "retry", "run the tests") is not a decision; record it as `progress` once the step is done, or not at all.
- A tool call shown without a result has no outcome. Do not state that it succeeded, failed, or produced anything; if it matters, it is a `note` that the call was issued and its outcome is unknown.
- Numbers, file names, and claims come from the events. Do not infer what an event does not show.
- Prefer few updates that a teammate would need over many that restate the events. Zero updates is a valid output.

## Output

Return only JSON, no prose around it:

```json
{
  "assignments": [
    { "record_id": "<candidate id>", "new_record": null, "from_seq": 1, "to_seq": 5, "confidence": 0.9, "why": "one sentence" },
    { "record_id": null, "new_record": { "kind": "implementation | investigation | writing | decision | other", "title": "short, specific, at most 140 characters", "goal": "one sentence, or null" }, "from_seq": 6, "to_seq": 9, "confidence": 0.7, "why": "one sentence" }
  ],
  "state_updates": [
    { "record_ref": "<candidate id or new_record title>", "kind": "progress | decision | hypothesis | blocker | next | contradiction | note", "text": "one sentence", "evidence_seqs": [4, 5], "confidence": 0.8 }
  ],
  "unassigned": [
    { "from_seq": 10, "to_seq": 11, "reason": "one sentence" }
  ],
  "notes": "one sentence on what the slice contained"
}
```

Exactly one of `record_id` and `new_record` is set on each assignment. Empty arrays are valid and common. Omit nothing from the shape; invent nothing to fill it.
