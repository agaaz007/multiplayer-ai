# Dispatch 7A: six-arm cohort (four products + two baseline controls)

Decision 7A (2026-09-13 review) adds `control-git` (share only through a bare Git remote) and `handoff-note` (share only through `HANDOFF.md`) to the four native products. This document is the ordered command list to prepare, admit, run and grade a fresh six-arm cohort under THIS worktree. Every step marks whether it needs a live model. Nothing below has been executed against a live lane; see "What remains unverified".

Conventions: run from the worktree root `/Users/Agaaz/conductor/workspaces/multiplayer-ai/yamoussoukro`. `DATE` is today's date in `YYYYMMDD`; `BASE=.context/teamwork-v3-bakeoff-$DATE`. `PINNED=/Users/Agaaz/conductor/workspaces/multiplayer-ai/richmond-v1/.context/teamwork-v3-live-20260912/native-versions` (pinned gbrain 0.50.0.0, graphify 0.9.59, bun 1.4.2; `package-inventory.json` alongside). `PRIOR=/Users/Agaaz/conductor/workspaces/multiplayer-ai/richmond-v1/.context/teamwork-v3-four-products-20260913` (prior admissions, services, transport probes). The canonical budget stays `/Users/Agaaz/conductor/workspaces/multiplayer-ai/richmond-v1/.context/teamwork-v2-live-20260912/budget.json` (`teamwork-budget/v2`, USD 30, never reset). The runtime is the frozen `dist/` build of this worktree (or the previously frozen runtime directory if that is the one already admitted; do not mix). Never delete or edit a root that has `attempt.json`.

## 0. Local verification (no model)

```sh
python3 -m unittest discover -s eval/teamwork-v3 -p 'test_*.py'      # 156 tests
node --test eval/teamwork-v3/test-*.mjs                                 # 36 tests
python3 -m py_compile eval/teamwork-v3/*.py
for f in eval/teamwork-v3/*.mjs; do node --check "$f"; done
```

## 1. Prepare the six-arm cohort (no model)

```sh
DATE=$(date +%Y%m%d); BASE=.context/teamwork-v3-bakeoff-$DATE
python3 eval/teamwork-v3/prepare_cohort.py --out $BASE/cohort --arms all \
  --budget /Users/Agaaz/conductor/workspaces/multiplayer-ai/richmond-v1/.context/teamwork-v2-live-20260912/budget.json
```

Creates `readiness/pack` (seed 42, A/B/C, development), six readiness roots `readiness/sequences/<arm>`, `scored/packs/{pm,engineering}` (seed 271, A/B/C/D), twelve scored roots `scored/sequences/<track>-<arm>`, both `preparation.json` files with `cohort_scope` = six-arm and the recomputed disk plans. The command prints the disk summaries.

To run in two batches instead, prepare two cohorts: `--arms products --out $BASE/cohort-products` and `--arms controls --out $BASE/cohort-controls`. Each preparation carries its own `cohort_scope` batch declaration and its own smaller aggregate reservation; per-sequence estimates are identical in every batch.

Recomputed disk numbers (`prepare_cohort.disk_plan_summary`, verified by `DiskPlanSummaryTests`):

| plan | retained | lane peaks | shared | margin | total |
|---|---|---|---|---|---|
| scored six-arm | 12 x 512 MiB = 6 GiB | 6 x 256 MiB = 1.5 GiB | 512 MiB | 2 GiB | **10 GiB** |
| scored products batch | 8 x 512 MiB = 4 GiB | 4 x 256 MiB = 1 GiB | 512 MiB | 2 GiB | 7.5 GiB |
| scored controls batch | 4 x 512 MiB = 2 GiB | 2 x 256 MiB = 0.5 GiB | 512 MiB | 2 GiB | 5 GiB |
| readiness six-arm | 6 x 512 MiB = 3 GiB | 6 x 256 MiB = 1.5 GiB | 512 MiB | 2 GiB | 7 GiB |
| readiness products | 2 GiB | 1 GiB | 512 MiB | 2 GiB | 5.5 GiB |
| readiness controls | 1 GiB | 0.5 GiB | 512 MiB | 2 GiB | 4 GiB |

`matrix.py` additionally requires 5 GiB free per involved filesystem at preflight, and `sequence.py` requires 2 GiB free at sequence admission and 1 GiB during subprocesses. The per-sequence numbers are still the conservative initial estimates; recalibrate upward from the completed readiness run before the scored freeze, never downward to fit storage. Measure first: `python3 -c "import shutil;print(shutil.disk_usage('.context').free/2**30)"`.

## 2. Provision native stores (no model; paid provider routes are configured, not exercised)

Products (reuse the pinned installs and prior owned services; nothing is copied from prior scored stores):

1. Start the owned loopback budget proxy and the GBrain reranker as in `$PRIOR/services/` (`node eval/teamwork-v3/native-http-proxy.mjs <proxy-config.json>`), with fresh routes/tokens for the twelve new `sequence` names, then run the live probe that sets `live_probe_pass: true` in the ready file (the prior `prepare-scored-local-native.mjs` shows the probe; it makes one priced `text-embedding-3-large` call per route against the shared USD 30 budget).
2. For each product root (six readiness roots first; scored roots after readiness passes) write the native config and provision the store:

```sh
node -e '
import("./eval/teamwork-v3/native-setup.mjs").then(async ({setup})=>{
  const {provision,config}=await import("./eval/teamwork-v3/native-lifecycle.mjs");
  const s=setup({root:process.argv[1],arm:process.argv[2],runtime:process.argv[3],budget_file:process.argv[4],
    proxy_config:process.argv[5],proxy_ready_file:process.argv[6],provider_env:JSON.parse(process.argv[7]),version:process.argv[8],
    native_versions:process.env.PINNED,ca_file:process.env.CA_FILE,supermemory_template:process.env.SM_TEMPLATE,supermemory_env_file:process.env.SM_ENV});
  console.log(JSON.stringify(await provision(config(s.native_config))));
});' "$BASE/cohort/readiness/sequences/gbrain" gbrain "$PWD/dist" <budget> <proxy-config> <proxy-ready> '{"OPENAI_BASE_URL":"http://127.0.0.1:PORT/v1","OPENAI_API_KEY":"<route token>",...}' "gbrain 0.50.0.0"
```

   Versions must equal the pinned strings (`gbrain 0.50.0.0`, `graphify 0.9.59`, Ledger `workspace-dist-control-freeze-<date>` of the frozen runtime, Supermemory plugin `1.0.18`). GBrain provisioning creates a private PostgreSQL database and role on the local server; Supermemory provisioning creates a scoped key (setup call, no document charge). Ledger provisioning uses the runtime's `analytical-ledger-native`.
3. Prior admissions under `$PRIOR/admissions/*.json` are reusable only as *evidence of what passed on 2026-09-13*; `freeze_launches.py` requires each root's own `readiness_receipt` whose `native_version` equals the new root's `version`, and `matrix.py` re-verifies Ledger's record-use audit from hashed originals. Point a new root's `readiness_receipt` at a prior receipt only if the native version string, adapters and guides are byte-identical to the frozen ones (the freeze binds every `eval/teamwork-v3/*.{py,mjs,md,json}` file, so any adapter change since 2026-09-13, including this dispatch, invalidates reuse of the prior *full-harness* receipts for scored roots). Expect to re-run readiness for all six arms.

Controls (no provider, no proxy, no budget gate):

```sh
for arm in control-git handoff-note; do
  node -e 'import("./eval/teamwork-v3/native-setup.mjs").then(async ({setup})=>{const {provision,config}=await import("./eval/teamwork-v3/native-lifecycle.mjs");const s=setup({root:process.argv[1],arm:process.argv[2],runtime:process.argv[3],budget_file:process.argv[4]});console.log(JSON.stringify(await provision(config(s.native_config))));})' \
    "$BASE/cohort/readiness/sequences/$arm" $arm "$PWD/dist" /Users/Agaaz/conductor/workspaces/multiplayer-ai/richmond-v1/.context/teamwork-v2-live-20260912/budget.json
done
```

`native-setup.mjs` writes `native-guide.md` (with the root's absolute transport path), `native-config.json` (version `control-git/v3` / `handoff-note/v3`, `readiness_receipt` defaulting to `<root>/native-readiness.json`), and `provision` creates `<root>/shared-remote.git` or `<root>/handoff-notes/`.

## 3. Control readiness probe (no model)

```sh
for arm in control-git handoff-note; do
  node eval/teamwork-v3/control-readiness.mjs probe $BASE/cohort/readiness/sequences/$arm/native-config.json
done
```

Writes `<root>/native-readiness.json` with `capture_recall_pass`, `isolation_pass`, `full_harness_pass: false` and the reason that the live seed-42 sequence has not run. Exit code 1 if any check failed; the receipt then records the failure and `freeze_launches.py` will refuse it. Must run before any live stage (it refuses used roots and cleans its probe artifacts from the live store).

## 4. Freeze readiness launches (no model)

```sh
python3 eval/teamwork-v3/freeze_launches.py --preparation $BASE/cohort/readiness/preparation.json --runtime "$PWD/dist" \
  --inventory $PINNED/package-inventory.json --inventory <supermemory template inventory> --inventory <reranker inventory>
```

Fails closed on any missing receipt, changed pinned package, or (new) an entry set that differs from the declared `cohort_scope`. Controls need no `proxy_config`/`proxy_ready_file`. Produces `readiness/matrix-config.json` (`teamwork-readiness-matrix/v3`, six entries, `cohort_scope` carried).

## 5. Run readiness (LIVE MODEL: gpt-5.6-sol medium via the Codex ChatGPT subscription; paid provider calls for the four products through the proxy)

```sh
python3 eval/teamwork-v3/run_readiness.py --config $BASE/cohort/readiness/matrix-config.json --out $BASE/cohort/readiness/run-1
```

Six lanes concurrently under one disk lease (7 GiB aggregate). Then, without touching any root:

```sh
python3 eval/teamwork-v3/mechanisms.py --root $BASE/cohort/readiness/sequences/ledger --correction $BASE/cohort/readiness/correction-witness.json --out $BASE/admissions/ledger-record-use.json
for arm in control-git handoff-note; do
  node eval/teamwork-v3/control-readiness.mjs assess $BASE/cohort/readiness/sequences/$arm/native-config.json --sequence $BASE/cohort/readiness/sequences/$arm --out $BASE/admissions/$arm.json
done
```

Product full-harness receipts are written by the controller after inspection exactly as on 2026-09-13 (`$PRIOR/admissions/*.json` shows the shape: `schema`, `arm`, `native_version`, `capture_recall_pass`, `isolation_pass`, `full_harness_pass`, `evidence` paths+hashes, `limitations`, `product_outcomes`); Ledger's receipt carries `record_use_audit: {path, sha256}`. Control receipts come from `assess` only; never hand-write `full_harness_pass: true`.

## 6. Provision and freeze the scored roots (no model)

Repeat step 2 for the twelve `scored/sequences/<track>-<arm>` roots (fresh stores; controls: fresh bare remote / notes dir; probe each control root with step 3 so `capture_recall_pass`/`isolation_pass` are its own, then set its `native-config.json` `readiness_receipt` to the `assess` receipt from step 5, whose `native_version` matches). Then:

```sh
python3 eval/teamwork-v3/freeze_launches.py --preparation $BASE/cohort/scored/preparation.json --runtime "$PWD/dist" --inventory ... 
python3 eval/teamwork-v3/matrix.py check --config $BASE/cohort/scored/matrix-config.json --out $BASE/cohort/scored/run-1
```

`check` requires `full_harness_pass: true` for all twelve lanes, one shared budget, identical pack/model/limits within each track, the aggregate 10 GiB reservation preview and 5 GiB free per filesystem; it writes nothing.

## 7. Run the scored matrix (LIVE MODEL; subscription inference for all six arms, paid provider calls only for the four products)

```sh
python3 eval/teamwork-v3/matrix.py run --config $BASE/cohort/scored/matrix-config.json --out $BASE/cohort/scored/run-1
```

Six lanes concurrently, PM then engineering inside each lane, 48 stage sessions. Record any intervention first with `python3 eval/teamwork-v3/integrity.py --root <root> --actor ... --action ... --reason ... --affected ...`; a recorded intervention stops that attempt.

## 8. Grade (no model)

```sh
python3 - <<'PY'
import json;from pathlib import Path
base=Path('.context/teamwork-v3-bakeoff-DATE/cohort/scored');prep=json.loads((base/'preparation.json').read_text())
entries=[{'root':e['root'],'provider_events':str(Path(e['root'])/'external-operations/events.jsonl')} for e in prep['entries']]
assert all(json.loads((Path(e['root'])/'sequence.json').read_text())['status']=='ended' for e in entries) and len(entries)==12
(base/'grade-config.json').write_text(json.dumps({'schema':'recovery-grade-run/v3','cohort_scope':prep['cohort_scope'],'sequences':entries},indent=2))
PY
python3 eval/teamwork-v3/grade-run.py   --config $BASE/cohort/scored/grade-config.json --out $BASE/cohort/scored/grading-1
python3 eval/teamwork-v3/grade-reuse.py --config $BASE/cohort/scored/grade-config.json --out $BASE/cohort/scored/reuse-1
python3 eval/teamwork-v3/review-prepare.py --config $BASE/cohort/scored/grade-config.json --out $BASE/cohort/scored/pm-review-preparation-1 --runtime "$PWD/dist" --ca-file <public CA>
```

`grade-run.py` requires the complete declared cohort (12 sequences / 48 tasks) and emits recovery, delivery, engineering functional and mechanism-audit results; `grade-reuse.py` emits `reused_finding`/`followed_decision`/`no_redo` per successor stage with evidence; `review-prepare.py` stages all 24 PM review slots with `execution_authorized: false`. The PM review itself (`review-runner.mjs run`) is a LIVE MODEL step and needs the controller inspection described in REVIEW.md first.

## What remains genuinely unverified

- No live lane, readiness or scored, has run with the control arms. In particular the macOS seatbelt has not been exercised with a bare-repository write grant: `git push` from inside the sandbox to `<root>/shared-remote.git` relies on the same policy shape Ledger uses for its owned remote (read grant) plus a write grant; whether `git-receive-pack` succeeds under `sandbox-exec` is untested here. `control-readiness.mjs probe` exercises the transport outside the sandbox only, and says so in `isolation_basis`.
- `control-readiness.mjs assess` has only been run against synthetic ended roots (test-controls.mjs). Its rollout scan targets the observed Codex `custom_tool_call`/`function_call` rollout shape from the 2026-09-13 runs; a Codex CLI upgrade may change it.
- `grade-reuse.py` has only been run against synthetic roots. Its mechanism detection for products uses the controller MCP traces (`native-<server>.jsonl`) and cannot see Supermemory's official plugin hook recall, which is not in those traces; such retrieval would show as "recomputed or unsourced" unless a `supermemory`/`supermemory_files` read tool was also called.
- The disk numbers are recomputations of the same 512 MiB / 256 MiB per-sequence estimates as the 2026-09-13 plan, not measurements. A completed six-arm readiness run is still required to recalibrate them.
- Prior product admissions (`$PRIOR/admissions`) were taken against the adapters frozen on 2026-09-13; this dispatch changed shared files (`native-lifecycle.mjs`, `native-setup.mjs`, `native-guides.mjs`, `session-driver.mjs`, `sequence.py`, ...), so `full_harness_pass` receipts for the products must be re-earned by fresh readiness, as protocol.md requires after any adapter change.
- Provider routes, the reranker and the Supermemory template/scoped-key flow were not restarted or probed in this worktree; step 2 describes them from the prior run's scripts.
