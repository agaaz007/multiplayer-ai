The controlled tests confirm a saved-file benefit, but do not establish that structured records improve continuation accuracy over GBrain. A [subsequent real handoff on September 10 IST](real-rachit-handoff-2026-09-10.md) recovered Rachit's new Analysis design-readiness task from a verified snapshot and completed it with both Claude conditions. The older adaptive-learning checkout described below remains unrecovered. Source-laptop offline status remains unconfirmed.

The isolated run is [hard-isolated-20260909](../../eval/runs/hard-isolated-20260909/manifest.json), with both harness directions and one repetition per condition. Eight trials completed; four long-history trials stopped at the Codex usage limit. The unchanged [Ledger report](../../eval/runs/hard-isolated-20260909/ours/report.json), [GBrain report](../../eval/runs/hard-isolated-20260909/gbrain/report.json), and [artifact re-audit](../../.context/hard-handoff/evaluation-summary-isolated.json) retain those distinctions.

| Check | Ledger | GBrain | What it establishes |
| --- | --- | --- | --- |
| E03 exact unfinished-file recovery | 2/2 | 0/2 | Ledger supplied saved bytes; GBrain began with the fresh clone |
| E03 original strict scorer | 0/2 | 0/2 | Neither condition met the exact private oracle |
| E03 separate public numeric requirements | 2/2 | 0/2 | Ledger successors preserved price/CTA height and satisfied minimum clearance |
| C02 active third agent | 2/2 | 2/2 | Both conditions coexisted with independent work in another worktree |
| L01 long-history recall | Unmeasured, 2 errors | Unmeasured, 2 errors | Quota prevented a scored successor answer |
| Rachit's actual change / different laptops | Not run in this controlled batch | Not run in this controlled batch | A later, distinct real task is covered in the linked report |

These counts are observations from one trial per direction, not reliability estimates. No continuity level is demonstrated. Ledger finding: `fnd-20260909-isolated-handoff-tests-saved-files-help-completi-lb9j`.

**Rachit's actual checkout.** Read-only production inspection found three Rachit Codex sessions on `MacBook-Pro.local` with non-repository Downloads working directories and null repository, thread, WIP ref, WIP commit, and verified snapshot timestamp. Session `01a07b83-5faa-76f2-ae8e-a01bb9647b64`, events 541 and 548, named an unpushed checkout at `/Users/ramesh/Downloads/Tata1MG/tmp/tranzmit-current.iuURa9`, branch `local/adaptive-learning-five-phases`, repository `agaaz007/behaviour-md-tranzmit`. Selected remote-ref checks found neither that branch nor a matching `refs/wip/rachit/*` ref. The captured agent claimed all five phases were complete locally; that claim remains unverified, and the intended unfinished task has not been confirmed.

The helper derives repository identity from the session working directory. Tool commands inside a nested checkout did not establish a snapshot of that checkout. See the [sanitized inspection](../../.context/hard-handoff/rachit-inspection.json).

An independent forensic review also checked captured patch requests and output artifacts before accepting the blocker. Some earlier file bodies are available, but truncated patch requests, missing core initial bodies, redacted literals, unresolved child edits, and absent final hashes prevent an exact reconstruction from the inspected evidence. Missing final bodies include the store, harness bridge, local app, and lifecycle/harness tests. No guessed patches were executed. The [file coverage review](../../.context/hard-handoff/rachit-final-byte-coverage.json) records these gaps. An archive or published snapshot of the actual nested checkout, including untracked source, would make restoration and independent validation possible; the evidence does not show that those local files were lost.

**E03 completion and the scorer mismatch.**

| Condition | Origin → successor | Final clearance | Final price / CTA height / gap | Strict verdict | Public numeric check |
| --- | --- | ---: | --- | --- | --- |
| Ledger | Codex → Claude | 24 | 199 / 48 / 16 | Fail: gap changed | Pass |
| Ledger | Claude → Codex | 56 | 199 / 48 / 24 | Fail: clearance must equal 20 | Pass |
| GBrain | Codex → Claude | 24 | 199 / 56 / 16 | Fail: configuration changed | Fail |
| GBrain | Claude → Codex | Missing | Final file was `{}` | Fail: missing fields | Fail |

The public instruction requires at least 20 px bottom clearance and preservation of price and CTA height. The private oracle additionally requires exactly 20 px clearance and a content gap of 24. The separate numeric definition was recorded before the isolated rerun; it does not replace the kit verdict. It checks finite numeric fields and the supplied `min(content + gap, viewport - safe_bottom - cta_height)` formula across viewport heights 480/640/800 and content heights 100/470/760/1200. It does not validate Android rendering, animation appearance, or extra-field semantics. One Ledger successor changed the gap, so the public result is not a claim that all configuration fields were preserved.

An [independent reviewer](../../.context/hard-handoff/clean-e03-independent-review.json) verified recovered/final bytes, numeric checks, strict verdicts, trial isolation evidence, and frozen-input hashes. Both Ledger successors started from the exact unfinished seed, while both GBrain successors started from `{}`. GBrain ingested normalized origin events into pages and used keyword retrieval; embeddings were not generated. This comparison combines retrieval with file availability. It cannot isolate the effect of structured records.

The origin agents could finish the fixture themselves. Before capture, the controller deliberately restored the supplied unfinished seed (`safe_bottom=0`) and retained their earlier bytes and reset provenance. This was a controlled reset, not a real interruption of a teammate's task. The controller copied recovered files before continuation and final files afterward, then checked the JSON independently of successor-written tests.

**C02: actual concurrent progress.** Each trial launched a real third CLI agent in a separate detached worktree. It implemented a deduplicated purchase aggregator and ran varied-input checks before, during, and after the paywall successor. The unchanged scorer passed all four trials. Successful checks wholly inside the successor interval were Ledger 182/880 and GBrain 175/139, ordered Codex→Claude / Claude→Codex. These counts demonstrate activity; they are not throughput comparisons.

The [artifact re-audit](../../.context/hard-handoff/clean-c02-primary-review.json) verified interval boundaries, successful before/after operations, full harness overlap, separate worktree paths, preserved sentinel/checker hashes, and the controller's independent implementation check. A second agent completed [actual tool-operation replay](../../.context/hard-handoff/clean-c02-parser-replay.json), including negative mutations that remove success evidence or force failure. Its broader review stopped at the usage limit. This demonstrates coexistence in both conditions, not a Ledger-specific coordination advantage. C01's claim race and stale-upload behavior remain untested.

**L01: history delivered, recall blocked.** Both Claude-origin trials completed 145 real turns across four fresh sessions. The [source re-audit](../../.context/hard-handoff/clean-l01-primary-review.json) found every original event in retained normalized instructions: 1,303 events, including 1,300 unrelated diagnostics, and three observed session resets. Unique source text totals 101,741 tokens under pinned `tiktoken 0.12.0 / o200k_base`, explicitly a proxy; provider-native tokenization was not verified. Repeated cache reads, system prompts, and assistant text do not contribute to that count. These are fresh-session resets, not native compactions of one exhausted context.

Both Codex successors returned usage-limit errors without answers. The Codex-origin trials stopped after 77 and 76 successful turns respectively, during the third session. All four observations are `error`; the kit reports them as `not_run`, with no recall or boot-budget score. No model was silently substituted. The remaining long-history comparison requires available quota and a new declared run.

**Why earlier comparisons were withdrawn.** Strict MCP configuration did not disable global Claude startup hooks. Earlier Ledger briefs exposed other trials from the shared evaluation database. The old forward L01 successor retrieved C02's price instruction; phase-1 R01 opened an earlier E01 record. This was confirmed in actual transcripts and tool traffic. The [contamination review](../../.context/hard-handoff/l01-ledger-forward-independent-review.json) supports corrective finding `fnd-20260909-continuity-benchmark-isolation-failed-ledger-suc-2im0`, which supersedes the earlier phase-1 tie finding. Original counts remain unchanged; their comparative interpretation is withdrawn.

Pre-isolation E03/C02/L01 runs, retries, and setup failures remain diagnostic artifacts under `eval/runs/hard-*`, with `validity-review.json` sidecars where applicable. CLI incompatibility, tokenizer initialization, C02 verifier defects, and a third-agent setup failure are not silently replaced by successful trials. None of those older runs establishes a memory-accuracy advantage.

**Isolation and remaining audit limits.** The fresh runner created 12 distinct empty `template0` databases, one per trial. All reported successful cleanup and a later local catalog query confirmed all 12 absent. Claude origin/successor/classifier/third-agent roles disable global hooks, settings, auto-memory, and instruction files while retaining the intended MCP configuration. Codex uses private homes with only copied authentication and trial configuration. Ledger's normal brief is explicitly rendered from the selected frozen build and trial database. Actual CLI tests against a local canned HTTP responder verified positive hook/memory canaries disappear under isolation while the intended MCP still connects.

The current run froze JavaScript, prompts, templates, and tokenizer cache before trials. Its Python controller copy was retained during the run, with that later capture time disclosed separately. Full Codex transcripts were removed with private homes; retained stdout and tool streams support narrower inspection. One successor read the installed Ledger guide; its exact retrieved text was retained and reviewed as generic usage material without foreign trial content, but it was not frozen beforehand. The private oracle was outside agent worktrees, without an OS sandbox guaranteeing it could not be read.

Subsequent local source fixes retain complete origin/successor transcripts and hashes before cleanup, freeze the packaged guide, and pin both startup and later MCP brief pointers. These fixes do not retroactively expand the current run's evidence. Final checks passed: TypeScript build, drivers (30), conditions (27, including actual MCP), adapter (12), completion (7 groups), parallel negative checks (7 groups), history source/token checks, guide isolation checks, and concurrent database/MCP canaries. Code changes are local and uncommitted.

**Reproduction.** The [runner](../../eval/run-hard-handoff.py) refuses an existing output directory, freezes inputs, launches selected cases, cleans up owned processes/databases, and invokes the unchanged scorer. Requirements are authenticated compatible CLIs, local PostgreSQL, GBrain, helper exclusions for the temporary evaluation root, and the pinned tokenizer environment/cache for L01.

```sh
node_modules/.bin/tsc -p tsconfig.json --outDir dist-handoff
env -u ANTHROPIC_API_KEY \
PATH="$PWD/.context/eval-codex-cli/node_modules/.bin:$PATH" \
LEDGER_EVAL_ORIGIN_MODEL='claude=claude-haiku-4-5-20251001,codex=gpt-6-astra' \
LEDGER_EVAL_SUCCESSOR_MODEL='claude=claude-sonnet-5,codex=gpt-6-astra' \
python3 eval/run-hard-handoff.py \
  --out eval/runs/hard-handoff-new --build-dir dist-handoff \
  --cases E03 C02 L01 --conditions ours gbrain \
  --directions codex-to-claude claude-to-codex \
  --repetitions 1 --workers 4
```

This uses the private Codex 0.153.4 installation; the machine-wide CLI was not upgraded. Auditing retained results needs no model calls: run `node .context/hard-handoff/audit-clean-results.mjs`. The report and code are in the workspace; detailed run artifacts under `eval/runs/` and `.context/` are local evidence, not a published evidence archive. The subsequent real-task comparison supplies equivalent saved-code access and a verified source task from Rachit's laptop. Repeated trials, offline-source confirmation, structured records, and completed long-history recall tests are still needed before broader accuracy claims.
