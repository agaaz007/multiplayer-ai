# Competitor readiness implementation — 10 September 2026

Latest status: the [four-stage cumulative-work protocol](../../eval/analytical-sequences.md) replaces the single-handoff experiment as the intended pilot. The existing runner is still a handoff runner; its output now explicitly says `validForCumulativeLearning: false`. No scored sequence or superiority result exists. Historical checkpoints below describe their respective inspected revisions.

Implemented after approval of all four proposed items: official Supermemory SDK adapter, scoped native Supermemory credentials, GBrain embedding readiness, and Graphify-Labs as a distinct competitor. The later instruction to maintain a level playing field added cross-arm condition checks and stricter comparative grading gates.

Supermemory uses official SDK 4.25.4. The controller provisions a one-day key for a single trial container, passes only the scoped key to native hooks/MCP, retains the revocation ID without the secret, and attempts revocation after the trial. Successful own-tag profile/search and explicit 403 foreign-tag denials are required. Inventory follows every page, rejects duplicates, changing totals, foreign/multi-tag documents and incomplete processing. Writes and searches use singular `containerTag`. The documented list API still exposes plural `containerTags`; singular compatibility must be verified live, with no fallback. Signal extraction and capture cadence are no longer overridden.

GBrain is pinned to installed CLI 0.18.2 and its text-embedding-3-large/1536-dimension embedding implementation. Readiness can run an actual synthetic embedding/hybrid-recall probe in a separate owned brain. Scored native capture still uses GBrain's own MCP put_page and query. Production brain pointers and unrelated provider keys are excluded; missing embedding credentials or incomplete coverage stop launch.

Graphify is pinned to graphifyy 0.9.50 from Graphify-Labs/graphify. The bridge calls its official CLI for extraction, query, affected, explain, path, save-result and reflect. It writes source-agent notes into a private corpus and binds extraction receipts to source hashes, graph hash and explicit backend/model. It does not implement an alternate memory/extraction/ranking algorithm and is not advertised as automatic transcript capture or Graphify's skill/subagent workflow. A separate synthetic semantic probe is available when explicitly authorized. AST-only checks do not qualify analytical capture.

Fairness controls:

- Separate corrected-analysis and coding-handoff tasks remain frozen with private independent oracles.
- Source prompts/people/models, successor model, timeout and approved maximum spend must match across arms in a harness direction. Drift is rejected.
- Product-specific native setup/capture instructions and extraction models remain disclosed and included in effort/cost accounting.
- Configuration and prelaunch probe failures remain unavailable, rather than incorrect task answers.
- Comparative qualification requires the existing isolation audit plus equal-evidence, matched-conditions, reviewed-native-workflow, capture-effort, blind-grading and provider-cost attestations. All seven human-time phases must be recorded; missing is not zero.
- Full filesystem isolation is not established by this change. The existing same-machine runner still requires inspection of startup context, future evidence and other-stage reads.

Validation performed locally:

- npm run build: passed.
- Analytical benchmark suite: 15 contract groups passed.
- Competitor suite: 7 groups passed, including real installed Graphify AST extraction/query/save-result/reflection, with fixture transports for Supermemory. No paid API or successor-model request ran.
- git diff --check: passed for tracked changes.

Not yet established: authenticated Supermemory scope/list compatibility; live GBrain embeddings; live Graphify semantic extraction; complete official Supermemory hook templates/trust on both harnesses; real-task correctness; two-laptop handoff; superiority or time saved.

The supplied Supermemory key was not written to source/config files or printed. SUPERMEMORY_API_KEY and OPENAI_API_KEY were absent from the launcher environment at inspection. Scored execution still needs exported credentials, explicit models/budget, completed real-task/oracle choices and native configuration review. The existing Ledger local lane disables its model classifier; review/disclose that configuration before treating the experiment as a full-product comparison.

Protocol and commands: eval/analytical-benchmark.md. Native route examples: eval/analytical-supermemory-native.example.json, eval/analytical-gbrain-native.example.json, eval/analytical-graphify-native.example.json. Placeholders require explicit user selections and reviewed built plugin paths.

## Follow-up: benchmark-only GBrain credential and matched task model

The user supplied `/Users/Agaaz/conductor/workspaces/multiplayer-ai/ledger-repo-zip/gbrain.env` for GBrain benchmark embeddings only. The file is untracked, ignored by Git and mode 0600. The new `--gbrain-env-file` option and native service launcher keep its key out of the parent environment and task-agent/other-provider configuration. No raw key was copied into the workspace.

A live call through the installed GBrain embedding module returned a finite 1536-dimensional vector for synthetic text. A separate owned PGLite probe then passed native save, embedding health and hybrid recall. Its result is `.context/competitor-readiness/gbrain-native-R4rs7M/result.json`; the direct embedding result is `.context/competitor-readiness/gbrain-embedding-Jtd7wR/result.json`. Scanning the 1129 native probe files found no raw credential matches. The embedding probe is not a full task or a superiority result.

The build and 15 analytical plus 8 competitor groups passed after credential routing changes. The added regression tests cover owner-only permissions, rejection of shell expansion and duplicate assignments, unchanged parent environment, and the actual native launcher passing a fixture credential only to its isolated GBrain child.

The user chose GPT-5.6 Sol and modest spend. The primary plan uses exact model ID `gpt-5.6-sol` (present in the local Codex catalog) for all task-agent roles in all four arms. Cross-harness tests stay separate. The explicit numeric budget remains unanswered; no amount was inferred. `.context/competitor-readiness/primary-plan.json` records that pending state and matched-model stage files are prepared but not run. Supermemory live scope/list and hook checks, Graphify's extraction-model choice/live check, real-task/oracle binding and full native-configuration/isolation review remain pending.

## Live Supermemory checks and Graphify backend checks

Supermemory's two-container canaries passed: each single-container key could list only its own document, including when a foreign singular `containerTag` filter was supplied. Foreign document get returned 404; foreign search/profile returned 403. The list API returns a credential-scoped projection with HTTP 200 rather than rejecting that filter. The adapter now validates this response and retains complete inventory checks instead of treating every 200 as a leak. Both canary documents were deleted and both scoped keys revoked. Evidence: `.context/competitor-readiness/supermemory-boundary-5TypQn/result.json`.

The official Codex Supermemory plugin was built and installed in a private home; the runner now materializes home placeholders in hook commands and forwards explicitly named environment variables to Codex MCP servers. The private template includes a CommonJS package boundary for the upstream bundled JavaScript. This avoids inheriting Ledger's ESM package mode without changing upstream capture/retrieval algorithms.

An unchanged official Stop hook, manually dispatched against a synthetic transcript, saved the original source bytes. Those bytes were retrievable through live hybrid search. However, the fresh recipient's official prompt-recall hook returned no recalled context in this probe. This proves capture and direct hybrid retrieval, not automatic recipient recall or live Codex host hook dispatch. The captured document was deleted and scoped key revoked. Evidence: `.context/competitor-readiness/supermemory-hooks-ZvV6Sb/result.json`. No manual import filled the capture path.

Graphify 0.9.50 lacked both optional provider SDKs. Anthropic 1.4.0 was installed for the initially approved Claude probe, which failed with an invalid API key. The Claude subscription fallback also failed: its copied OAuth token was revoked. Those are authentication failures, not semantic quality results. The experimental Claude CLI adapter was removed after the user redirected testing to OpenAI. OpenAI SDK 3.11.0 is now installed in Graphify's own environment. The installed native OpenAI backend targets `https://api.openai.com/v1`, defaults to `gpt-4.1-mini`, and supports an explicit model. There is no `OPENAI_API_KEY` in the launching environment; the GBrain-only credential has not been used for Graphify. A live OpenAI semantic test remains pending authorized credentials/model selection.

Build and 15 analytical plus 9 competitor test groups passed for the scope/template changes before the final documentation and handoff-scope annotation. These are local regression checks; they do not turn the outstanding native recall, credential or sequence-runner requirements into passes.

## OpenAI Graphify smoke — passed

The user explicitly authorized the credential in `gbrain.env` for this one Graphify smoke test. The native Graphify 0.9.50 OpenAI backend with `gpt-4.1-mini` extracted one synthetic Markdown file into four nodes and three edges. A separate native graph query, with no API credential passed, retrieved the silver otter and its acorn/river/freshwater relationships. Both commands exited zero. Extraction reported 857 input and 397 output tokens and an estimated $0.0010 cost; this is Graphify's estimate, not a reconciled invoice. Total probe wall time was 18.559 seconds. Limits were 1024 output tokens, zero SDK retries, 45-second API timeout and 60-second process timeout.

The credential was loaded as data and passed only to the extraction child environment. A scan of retained probe files found zero raw-key matches. Evidence: `.context/competitor-readiness/graphify-openai-ASefMK/result.json`; reproducible probe: `.context/competitor-readiness/graphify-openai-probe.mjs`. The configured private native route is `.context/competitor-readiness/graphify-openai-native.json`. This verifies Graphify semantic extraction and graph retrieval over a tiny synthetic source, not a scored task, four-stage accumulation or comparative advantage. GPT-5.6 Sol remains the selected task-agent model; full sequence extraction settings and numeric budget are not yet frozen.
# Latest checkpoint: real task content frozen

The user confirmed approximately $20 total, simulated A/B/C/D users on this laptop, real frozen HiAstro data in both tasks and the approved C/D additions. The content freeze and remaining gates are documented in `real-pilot-freeze-2026-09-10.md`. Earlier budget/identity/data blockers in this report are historical.

Supermemory now has an actual successful native Codex source-to-fresh-recipient smoke: synchronous Stop host dispatch, unchanged official flush implementation, and explicit native `search_memory` retrieval. This supersedes the earlier unresolved host-dispatch readiness check; it does not establish automatic recall or compounding. Cleanup verified zero remaining smoke documents and revoked keys. No scored four-stage sequence has run. The new dispatcher, per-stage provider/budget controls, runtime freeze and independent coding feature validation remain unfinished.
