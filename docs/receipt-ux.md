# Ledger receipt UX

Ledger gives users a visible account of what an agent retrieved, attributed, and saved. The same receipt data can support ordinary chat text or a host-rendered bubble beside the MCP tool row.

## Interaction contract

| Completed action | Compact receipt | Expanded evidence |
| --- | --- | --- |
| Search | Found count, authors, query | Returned records, dates, lifecycle status |
| Open | Record title, author, date | Full source record |
| Attribute | Referenced unique-record count, authors, agent-reported qualifier | Exact answer passages and the agent's explanation of each contribution |
| Record | Saved type/title, actual sync outcome, explicit prior links | Saved record ID, linked records and unresolved IDs |

Counts represent unique stored records, not claims, verified facts, conversations, or people. Authors come from storage. Similar-findings warnings do not count as references. A saved record's links come from `prior.ids`, `based_on`, `related_findings`, and `supersedes`; metric names in `definitions_used` are not resolved into versioned references by this receipt.

Search results are not evidence of use. Attribution is reported by the agent and is not independent verification. A link to prior work does not establish that an investigation was resumed. No receipt claims time saved or learning gains.

## Presentation

Show a quiet, compact line immediately after completion. Group adjacent batched results to avoid notification noise; keep each write's sync outcome and any lifecycle or unresolved-reference warnings. Do not repeat the receipt in the final answer unless it is material to the user's outcome.

An integrated host may place this line in an expandable bubble beside the tool row. The bubble should support keyboard expansion, an accessible label, and reduced motion. Expansion must preserve record IDs and status and distinguish source data from agent-reported attribution. Render stored text as text, never executable HTML or instructions. Truncation may shorten the visual preview, but full details must remain accessible.

Only the host knows a call is currently running. An integrated host can show “Searching Ledger…” or “Saving finding…” while it is in flight. Ledger currently emits completion receipts, not live progress events. Failed calls must show failure; a successful save with a failed push remains a local save with a sync warning. Do not retry a successful record merely because optional source details could not be loaded.

## Wire format

Covered tools return `structuredContent.receipt` with:

- `schema: "ledger-receipt/v1"`, `action`, and a deterministic plain-text `message`.
- `records`: unique objects with canonical `id`, `title`, `author`, and `status`.
- Writes also include `record_id`, `sync`, `references`, and `unresolved_references`. `metadata_unavailable` indicates source details could not be loaded after the write.

`sync` is one of `pushed`, `local_commit`, `sync_failed`, `commit_failed`, `disabled`, or `unconfirmed`. Only `pushed` represents an acknowledged remote push. A successful later push does not retroactively update an old receipt.

The same message begins the text result, followed by the existing detailed output. Text annotations include both user and assistant audiences. Evidence tools retain their `ledger-evidence/v1` payload and MCP Apps resource; the receipt is additive. Ordinary tool errors remain MCP errors and have no success receipt.

## Current host support

The installed Claude and Codex guides instruct agents to display the receipt in chat. This is a fallback whose execution depends on the agent and host communication rules. It does not alter Conductor's collapsed tool row, provide a native popup, or persist a usage history.

MCP Apps hosts can render the existing search/get/contribution evidence card. The standalone preview is a separate read-only MCP client; it does not observe other agents' calls. A Conductor renderer integration would consume the same receipt from each actual tool result and attach its own bubble. That integration is not implemented in this repository.
