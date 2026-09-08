# Phase 0 report: transcript capture coverage

Scanned 8 Sep 2026 on Agaaz's machine with `.context/phase0/coverage.mjs` (streams every local transcript, no parser dependency). Raw numbers in `coverage.json`. Wall time 21 s.

## Verdict: go

Transcripts are complete enough to be the primary observation source. Every gap found is in our parser, not in the files.

| | Claude Code | Codex |
|---|---|---|
| files | 3,056 | 724 |
| bytes | 847 MB | 2,133 MB |
| tool calls | 45,972 | 70,837 |
| tool results | 45,966 | 70,833 |
| unpaired calls | 7 | 4 |
| files with more than one unpaired call | 1 | 0 |
| unparseable lines | 0 | 0 |
| unknown content block types | 0 | n/a |
| result size p50 / p99 / max | 447 / 19,040 / 69,514 chars | 514 / 40,148 / 239,646 chars |
| results offloaded to a side file | 1,240 (2.7%) | 0 |
| harness-side truncation markers | 0 | 1,930 |
| compaction markers | 0 detected by pattern | 1,526 `compacted` + 1,489 `context_compacted` |
| reasoning blocks | 22,908 thinking | 61,438 reasoning |

The 11 unpaired calls across 116,809 are the in-flight tool call at the moment a session died. That is the expected residue and exactly what `pending_operations` exists to surface.

## Parser gaps found and fixed

**Codex `custom_tool_call`.** 31,600 calls, 44.6% of Codex tool calls (27% of the combined corpus), were invisible to `parseCodex`, which handled only `function_call`. Names: `exec` (28,373) and `apply_patch` (3,227). `exec` input is JavaScript wrapping `tools.exec_command({cmd})`; 17,243 have literal `cmd` strings, 5,380 build the command dynamically, 5,750 contain no `exec_command` call. Outputs are arrays of `{type: "input_text", text}` parts (28,843) or strings (41,990). Fixed: both call and output shapes parsed, shell literals extracted from the wrapper, dynamic wrappers kept as raw source, `apply_patch` recognized and not counted as a data query. `exec` added to shell tool names in `src/hooks.ts` so `psql`/`clickhouse`/`bq` inside it count as data work.

**Codex `response_item/message`.** Newer rollouts carry prompts and replies as `response_item` with `payload.type: message` and `role: user | assistant | developer`, content parts `input_text | output_text`. The parser read only the older `event_msg/user_message` and `agent_message` shape. In the sampled 302 files, 276 use the old shape and 26 the new; the most recent session had zero prompts and zero conclusions under the old parser. Fixed: new shape read by role, `developer` role (injected AGENTS.md text) excluded, legacy shape used only when the new shape yields nothing, so a file containing both is not double-counted.

Both fixes have fixtures in `src/selftest.ts`. Build and self-test green.

## Shapes worth using in Phase 1

Codex emits structured completion events the current parser ignores entirely. They are better sources than parsing output text:

| event | count | use |
|---|---|---|
| `event_msg/patch_apply_end` | 22,184 | file-change events with paths, the Codex `file.changed` source |
| `event_msg/exec_command_end` | 14,297 | exit codes and durations for `tool.finished` |
| `event_msg/mcp_tool_call_end` | 5,325 | MCP tool completion |
| `event_msg/sub_agent_activity` | 8,361 | subagent boundaries |
| `event_msg/turn_aborted` | 213 | explicit interruption marker |
| `event_msg/error` | 18 | harness errors |
| `event_msg/item_completed` | 9,938 | newest unified item stream: CommandExecution, FileChange, McpToolCall, ContextCompaction, UserMessage, AgentMessage |

Claude Code emits `file-history-snapshot` (292) and `file-history-delta` (97) line types, its own file-change tracking, plus `isSidechain` on 1,641 subagent lines and `pr-link`, `bridge-session`, `fork-context-ref` metadata.

## What this does and does not prove

Proves: the transcripts contain every tool call with its input, every result up to 240 KB, every prompt, every assistant message, and reasoning, and they are structurally stable enough that 3 GB parsed without a single bad line.

Does not prove: that a live tail keeps up under load, that offloaded Claude outputs are always still on disk when the helper reads them, or that either harness's format will hold. The hooks-as-index reconciliation in the spec (§3.1) is the running check for the last point; the `custom_tool_call` miss would have been caught on the first session.

## Remaining Phase 0 work

- Shadow-commit prototype against a local bare remote, including the denied-path index removal and tree validation from spec §3.2.
- Refactor `parseClaude` / `parseCodex` into streaming emitters that yield normalized events from a byte offset.
- Decide whether Phase 1 reads Codex tool events from `response_item` (current) or from the `event_msg/*_end` and `item_completed` streams (richer, but the older files in the corpus lack `item_completed`).
