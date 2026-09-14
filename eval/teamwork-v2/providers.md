# Native product comparison setup

Verified documentation sources on 2026-09-11; documentation is not proof of a live tested integration.

| Arm | Use | Required v2 readiness |
|---|---|---|
| Ledger | Current packaged MCP, native hooks/helper, scoped definitions/claims/work records, verified Git snapshots | Freeze source **and packaged guide**; use private Postgres DB and ledger per sequence; enable intended classifier/capture in full-capability track and log extraction usage. Existing `src/eval/analytical-ledger-native.ts` is reusable but hardcodes classifier-off, so it cannot pass full-capability readiness unchanged. |
| Supermemory | Official Codex integration/native MCP, source chunks and extracted memory | Per-sequence scoped key/container, fresh-session capture/recall smoke, verify processing state; preserve sync/async hook settings. Existing `analytical-supermemory.ts` and native template mechanism are reusable; do not feed controller-written summaries. |
| Mem0 | Official Platform V3 or its official agent integration, selected and pinned before scoring | This kit supplies the Platform add/search/event transport. Freeze one sequence entity, keep administrator key outside agent, verify cross-scope canaries and fresh-session recall, retain asynchronous event completion. Full plugin capture needs a separate native configuration and smoke; the add/search client alone is not a complete memory-product trial. |
| GBrain | Official native MCP/CLI capture and retrieval, including supported graph/provenance functionality | Private brain per sequence; current pinned version, guide and embedding config; select documented native capture before scoring. The original pilot's pinned 0.18.2 must not silently stand in for a current best-supported configuration. |
| Graphify | Official CLI/skill/MCP over code/docs with supported query/path/explain/feedback | Private corpus; pin version/extraction backend, freeze source capture/indexing schedule and readiness wait; give the common Git tree like all other engineering arms. |
| Fresh agent | Same raw sources and normal engineering Git, no accumulated memory or derived PM handoff | Fresh isolated home/session; no default personal memory, global Ledger brief, predecessor transcript, or controller summaries. |

Mem0 is separate from Supermemory, and the primary set contains five products plus a control. Product scope is injected by the controller, never selected from an agent argument. Do not advertise a query filter as an ACL. For providers lacking sequence-scoped credentials, the controller proxy must prevent arbitrary endpoints, foreign IDs and unscoped searches; live negative probes are still required. Mem0's adapter deliberately excludes unrestricted get/list/delete until their scoping can be validated.

Sources:

- [Mem0 add](https://docs.mem0.ai/api-reference/memory/add-memories): asynchronous V3 extraction returns an event; input can be entity scoped.
- [Mem0 search](https://docs.mem0.ai/api-reference/memory/search-memories): V3 search uses filters and returns native results; the adapter preserves that shape.
- [Supermemory architecture](https://supermemory.ai/docs/concepts/how-it-works) and [scoped keys](https://supermemory.ai/docs/authentication).
- [GBrain official repository](https://github.com/garrytan/gbrain).
- [Graphify official repository](https://github.com/Graphify-Labs/graphify).

## Native session driver contract

The execution adapter must accept a controller-owned JSON request containing `sequence_id`, `track`, `stage`, `workspace`, `fresh_home`, `visible_input_files`, `native_profile`, `model`, `reasoning_effort`, `stage_deadline_ms` and `controller_output_dir`. It returns a controller-owned result containing `delivery` (timestamp/hash/artifact tree), `stage_end`, `capture` (native receipt/readiness/error), `native_trace`, `isolation_evidence`, and usage with unknowns explicit. Each call launches a genuinely fresh agent; it may not load a shared personal agent profile.

Only copied stage-visible files and required runtime binaries are readable to the task process. The stage driver exposes a `deliver_answer` tool or equivalent controller channel. It writes an immutable answer and captures the submitted engineering tree at the moment of delivery, then allows native bookkeeping to finish within the original deadline. Do not use the v1 `submit_answer` description unchanged: it still requires save-before-submit. Persist the final handoff tree separately.

Per-product provisioning/capture/export/cleanup is outside the agent sandbox, using official integrations. The controller may call their documented indexing/flush operations on **actual agent-generated material**, recording effort; it may not invent memory records or conclusions. Never copy a reference answer or recovered code for one product only. Keep unsuccessful native capture as an outcome after readiness; do not omit it from the matrix.

The included `session-driver.mjs run REQUEST.json` supplies fresh Codex execution and early immutable delivery, using the existing validated macOS harness and native MCP bridges. `check` validates a request without launching a model. A request needs `runtime` (a frozen compiled Ledger/eval runtime), `native_profile` (private JSON), `prompt_file`, `arm`, `track`, `stage`, `workspace`, `fresh_home`, `controller_output_dir`, `model`, `reasoning_effort`, `stage_deadline_ms`, at least two `forbidden_canaries`, `execution_authorized:true` and an authorization description. The native profile contains `arm`, `mcp` stdio servers, optional hooks/hook_env, read_paths/write_paths, ca_file, and verified readiness/budget-gating attestations. These are controller-owned configuration, not evidence by themselves. The driver wraps servers outside the task sandbox and retains their actual protocol traces.

The kit's `preflight` checks hashes and required evidence/configuration fields but does not prove its claims. The session driver does not implement native per-sequence provisioning, periodic capture, final flush, asynchronous processing, cleanup or per-operation cost authorization; those must be supplied by a verified native profile/controller. The original adapters identify the reusable implementation paths above. Placeholder profiles are deliberately not launch-ready. The local kit is usable now for grading retained/manual native trials; full cross-product dispatch and stress injection require this remaining integration and live probes before reporting scores.
