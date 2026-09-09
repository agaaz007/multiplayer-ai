The 2026-09-09 handoff evaluation completed a controlled layout task in both harness directions. The unchanged E03 scorer marked all four trials failed. A separate, retrospective check of the public requirements found that Ledger's two successors preserved the saved configuration and produced valid layouts; GBrain's two successors did not preserve or reconstruct that configuration. These results support the value of recovering saved files. They do not establish that structured work records improve continuation accuracy over GBrain.

The requested continuation of Rachit's actual unfinished change remains untested because no recoverable snapshot was available. The controlled task is not a substitute for a successful recovery from his laptop.

**Rachit's actual work: inspection confirmed a missing checkpoint.**

Read-only session inspection found three Rachit sessions with Downloads-directory working directories outside a Git repository:

- `01a07b83-5faa-76f2-ae8e-a01bb9647b64`
- `01a08105-5167-7f61-a098-43e2b477861a`
- `01a080bb-745f-7951-820a-8c15e349f459`

For all three, `repo`, `thread_id`, `wip_ref`, and `last_verified_snapshot_at` were null. Events 541 and 548 of session `01a07b83-5faa-76f2-ae8e-a01bb9647b64` described an unpushed checkout at `/Users/ramesh/Downloads/Tata1MG/tmp/tranzmit-current.iuURa9`, on `local/adaptive-learning-five-phases`, in `agaaz007/behaviour-md-tranzmit`. A read-only remote-ref check found neither that branch nor any matching `refs/wip/rachit/*` ref.

A [sanitized metadata inspection](../../.context/hard-handoff/rachit-inspection.json) retains the session fields and whitelisted event claims. The captured agent claimed all five phases were completed locally; that completion claim has not been independently verified, and the user has not yet identified which unfinished task to use. They establish that the inspected sessions and selected remote refs did not supply a checkpoint. They do not establish that Rachit's local files were lost. Finishing his exact change requires publishing a snapshot or branch from that nested checkout, then recovering it into a fresh worktree and validating the change.

**E03: completed trials and unchanged official verdicts.**

The scored run is [hard-e03-20260909-b](../../eval/runs/hard-e03-20260909-b/manifest.json): one repetition per condition and direction, all on one laptop. The [Ledger report](../../eval/runs/hard-e03-20260909-b/ours/report.json) and [GBrain report](../../eval/runs/hard-e03-20260909-b/gbrain/report.json) retain the kit's original verdicts.

| Condition | Origin → successor | Final `safe_bottom` | Other final fields | Official E03 | Retrospective public requirements |
| --- | --- | ---: | --- | --- | --- |
| Ledger | Codex → Claude | 24 | Price 199, CTA height 48, gap 24 preserved | Fail: requires exactly 20 | Pass |
| Ledger | Claude → Codex | 48 | Price 199, CTA height 48, gap 24 preserved | Fail: requires exactly 20 | Pass |
| GBrain | Codex → Claude | 24 | CTA height became 56; gap became 16 | Fail: unrelated configuration changed | Fail |
| GBrain | Claude → Codex | Missing | Final file remained `{}` | Fail: required fields missing | Fail |

The public instruction requires a CTA at least 20 px above the bottom edge and preservation of price and CTA height. The private oracle additionally requires `safe_bottom == 20`, with CTA height 48 and content gap 24. Thus Ledger's 24 px and 48 px solutions satisfy the public clearance requirement but fail the stricter oracle. The mismatch was discovered after the runs; no prompts or official verdicts were changed to accommodate the results.

The [separate public-contract validation](../../eval/runs/hard-e03-20260909-b/public-contract-validation.json) records every final value and 12 numerical checks per populated configuration: viewport heights 480, 640, and 800, crossed with content heights 100, 470, 760, and 1200. A second agent independently verified the final bytes and these calculations. The retrospective result is Ledger 2/2 and GBrain 0/2; the official result remains Ledger 0/2 and GBrain 0/2. Neither tally is a reliability estimate.

Ledger restored the exact unfinished seed before both successors started. Both successors then changed the file. GBrain started from the ordinary fresh clone, whose `layout.json` was `{}`. GBrain ingested normalized origin events as pages and used keyword search; embeddings were not generated. This comparison combines retrieval with the availability of uncommitted file contents. It cannot isolate the effect of structured records. An accuracy comparison of the memory layers would need equivalent starting files in both conditions.

**What the controller actually did.**

The origin agents acted on five fixture instructions and could complete the layout themselves. Before capture, the controller deliberately restored the supplied unfinished seed (`safe_bottom=0`). It retained their earlier file bytes and the reset hashes in `raw/e03-origin-layout.before-reset.json` and `raw/e03-origin-checkpoint.json`. This is a controlled fixture reset, not a real interrupted session.

The adapter copied `recovered/` before the successor and `final/` afterward. It checked the initial seed before continuation and independently evaluated final JSON without executing successor-written validation code. Each observation bundle retains `raw/e03-successor-start.json`, `raw/e03-validation.json`, bootstrap/final manifests, successor output, and tool traces. The agent's statement that tests passed did not determine the result.

The run manifest identifies Git revision `230eddf76de543059a80d2a38f4b08284d1ee97d`, a working-diff hash, and a SHA-256 for every frozen JavaScript file. The exact executable tree is under `build/`; `source.diff` preserves tracked changes. E03-b's prompt assets were added at 11:30:04 UTC while origins were running, before Ledger preparation/classification, and their hashes and timing are disclosed in its manifest. Subsequent runner versions freeze prompts, templates, and available tokenizer cache before starting trials.

E03-b predates the explicit classifier MCP-isolation change. Its classifier used the default Claude extractor configuration; later C02-b and L01 runs use an empty strict MCP configuration and retain classifier execution traces. This limits reproducibility of the earlier classifier boundary.

The private oracle was outside the agent worktrees and was not supplied in successor prompts. This was logical separation, not an operating-system guarantee that the agents could not read the controller bundle. The run therefore does not prove isolation against deliberate oracle access.

**Other requested hard-handoff checks.**

| Check | Observed status |
| --- | --- |
| Different laptops | Not run; all controlled trials used the same machine |
| Both harness directions | E03 completed in both directions, one repetition each |
| Third agent actively progressing during handoff, C02 | Four trials completed: strict Ledger 0/2, GBrain 1/2; two forward failures are verifier artifacts, and Ledger reverse has a real third-agent setup failure |
| Long mixed-topic history and three context resets, L01 | Running; append observed history size, resets, boot tokens, verdicts, and artifact paths when complete |

No continuity level is demonstrated by these E03 results. The additional concurrency and history checks must be reported from their actual observation artifacts rather than inferred from the implementation.

**C02: real concurrent work, with verifier and setup failures separated.**

The [C02-b run](../../eval/runs/hard-c02-20260909-b/manifest.json) used an independent third harness in a detached worktree on the same repository. It implemented an attribution aggregator and ran varied-input checks before, during, and after the paywall successor. The controller verified process overlap, the separate implementation, successful tool completion, and unchanged sentinel/checker bytes. A neutral untracked marker ensured a snapshot existed when the origin left the repository clean; the marker contains no expected answer and is explicitly recorded as controlled fixture setup.

| Condition | Origin → successor | Original official verdict | Observed evidence |
| --- | --- | --- | --- |
| Ledger | Codex → Claude | Fail | Full third-harness overlap, 546 successful checks during the successor, independent validation and sentinel preservation; before-phase tool verifier rejected a batched result |
| GBrain | Codex → Claude | Fail | Full overlap, 549 checks during, independent validation and sentinel preservation; same verifier defect |
| Ledger | Claude → Codex | Fail | Third agent's initial `before` check failed on TODO code; after implementing it ran `after` instead of repeating `before`. No during phase launched and no overlap occurred |
| GBrain | Claude → Codex | Pass | Full overlap, 112 checks during, successful before/during/after tool operations, independent validation and sentinel preservation |

The forward Codex tool responses contained several adjacent JSON results. The old verifier examined only the last result, a checksum command, and missed the successful attribution command. A later parser retains each command's own status and follows exact shell/cell polling chains. The [independent diagnostic review](../../.context/hard-handoff/c02-independent-review.json) verifies the forward operations and rejects failed attribution results even when a sibling checksum succeeds; the original [Ledger](../../eval/runs/hard-c02-20260909-b/ours/report.json) and [GBrain](../../eval/runs/hard-c02-20260909-b/gbrain/report.json) verdicts remain unchanged. Diagnostic replay is not a newly scored live pass.

Ledger's reverse failure is different: no successful before-phase operation existed, so starting the concurrent phase would have fabricated a pass. Independent review confirms the absence of overlap. This is a third-agent protocol failure in this trial; it does not show that Ledger disturbed the other worktree. These observations do not establish a coordination advantage over the configured GBrain baseline. C01's claim-race and stale-upload case remains unimplemented.

**Setup failures are retained separately from scored E03-b.**

| Run | What happened | Treatment |
| --- | --- | --- |
| [hard-e03-20260909](../../eval/runs/hard-e03-20260909/manifest.json) | Codex origin requests received HTTP 400 requiring a CLI upgrade for the configured model | Stopped as invalid setup; no completion score |
| [hard-c02-20260909](../../eval/runs/hard-c02-20260909/manifest.json) | Ledger's clean origin worktree produced no snapshot for the required bootstrap | Ledger trials `error`/`not_run`; corrected fixture rerun required |
| [hard-long-20260909](../../eval/runs/hard-long-20260909/manifest.json) | One Ledger Codex → Claude preflight could not load the tokenizer cache | That trial was restarted with a populated frozen cache; other trials continued |

The first C02 run also contains completed GBrain observations: Codex → Claude failed the parallel-work check and Claude → Codex passed it. Independent trace review found that the first failure came from a verifier rejecting a Python argv wrapper; the corrected verifier accepts its exact successful command/poll chain. The original verdict remains unchanged. Those observations remain in that run's report; the incomplete Ledger pairing cannot establish a comparative C02 result.

**Reproduction.**

The [runner](../../eval/run-hard-handoff.py) refuses to reuse an output directory, freezes executable inputs, launches isolated trials, retains raw artifacts, and invokes the unchanged kit scorer. It sets `LEDGER_EVAL=1` and a disposable controller `LEDGER_CONFIG_DIR`; trial drivers use their own configurations and the evaluation database. Prerequisites are authenticated compatible Codex/Claude CLIs, GBrain, the local evaluation database, and production-helper exclusions covering the temporary evaluation root and its realpath alias.

```sh
node_modules/.bin/tsc -p tsconfig.json --outDir dist-handoff
env -u ANTHROPIC_API_KEY \
PATH="$PWD/.context/eval-codex-cli/node_modules/.bin:$PATH" \
LEDGER_EVAL_ORIGIN_MODEL='claude=claude-haiku-4-5-20251001,codex=gpt-6-astra' \
LEDGER_EVAL_SUCCESSOR_MODEL='claude=claude-sonnet-5,codex=gpt-6-astra' \
python3 eval/run-hard-handoff.py \
  --out eval/runs/hard-e03-new \
  --build-dir dist-handoff \
  --cases E03 \
  --conditions ours gbrain \
  --directions codex-to-claude claude-to-codex \
  --repetitions 1 --workers 2
```

This command uses the session-local Codex 0.153.4 installation and the Claude subscription authentication selected for these runs; the machine-wide Codex installation was not upgraded. It runs the current source with the E03-b model assignments; it does not recreate stochastic responses. Use E03-b's preserved `build/`, manifest, suite, and raw bundles to audit the historical run. Models were held fixed between conditions within each direction; the reverse direction used a different successor model. No latency or token advantage is claimed from these four trials.

For a subsequent matrix of these three cases, select `--cases E03 C02 L01` and a new output directory, retain both directions, and increase to three repetitions. L01 additionally needs the pinned `tiktoken==0.12.0` environment and cached `o200k_base` encoding under `.context/eval-tokenizer/`, or `LEDGER_EVAL_TOKENIZER_PYTHON` pointing to that Python environment. Its token count is explicitly a tokenizer proxy, not verified provider-native token accounting; three fresh origin sessions after the first establish resets, not automatic compactions. Neither more repetitions nor these local runs replace the missing two-laptop test.
