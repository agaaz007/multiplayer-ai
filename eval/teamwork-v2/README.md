# Teamwork benchmark v2

Two separate tracks: engineering delivery and PM decision quality. This is a new protocol; v1 scores remain historical and are not merged into v2.

The local pack builder, independent HTTP engineering grader, PM evidence checker, blind-review packet builder, and readiness checks run without vendor credentials. Live product trials use the native-session driver contract in `protocol.md`; no provider call or scored model run happens during pack generation or selftests. Native product readiness must be established separately before a scored launch. Do not label configured or simulated adapters live-verified.

```sh
python3 eval/teamwork-v2/bench.py build --out .context/teamwork-v2 --seed 41
python3 eval/teamwork-v2/bench.py validate --pack .context/teamwork-v2
python3 -m unittest discover -s eval/teamwork-v2 -p 'test_*.py' -v
node eval/teamwork-v2/test-delivery.mjs
python3 eval/teamwork-v2/bench.py schedule --seeds 137,211,307 --out .context/teamwork-v2-schedule.json
python3 eval/teamwork-v2/bench.py grade-pm --pack .context/teamwork-v2 --stage C --answer /path/answer.json --out /path/pm-grade.json
python3 eval/teamwork-v2/bench.py grade-engineering --candidate /path/worktree --stage C --out /path/engineering-grade.json
python3 eval/teamwork-v2/bench.py review-packet --pack .context/teamwork-v2 --stage C --answer /path/answer.json --out /path/blind-review
python3 eval/teamwork-v2/bench.py preflight --pack .context/teamwork-v2 --profiles eval/teamwork-v2/profiles.example.json
python3 eval/teamwork-v2/bench.py prepare-sequence --pack .context/teamwork-v2 --out .context/teamwork-v2-control --track engineering --arm fresh-agent
# After native provisioning, fresh allowance, readiness and isolation verification:
python3 eval/teamwork-v2/bench.py run-sequence --root .context/teamwork-v2-control --launch /private/verified-launch.json
```

The example profiles intentionally fail live readiness: they are a configuration checklist, not fake working vendor adapters. Existing native adapters are identified in `providers.md`. Mem0 is an added product arm; its official API adapter and transport tests are in `mem0.py` and `test_mem0.py`. `session-driver.mjs` supplies a fresh Codex launch, native MCP bridges, an early `deliver_answer` tool, immutable submission snapshots, deadline and isolation evidence. It requires a provisioned per-sequence native profile, a built runtime, and explicit new launch authorization; it does not provision vendor accounts or claim unrun native readiness. The v1 paid dispatcher is not reused unchanged.

Generated `agent/<track>/<stage>/` contains only stage-visible inputs and the ordinary cumulative raw-source archive. `controller/` contains expected facts, private tests/review instructions, schedule and hashes. Never expose the pack root, this source directory, other trials, or the controller directory to a task agent. The engineering starter contains a working HTTP shell with unimplemented behavior; the grader must demonstrate it fails acceptance tests before any model trial.

The primary engineering comparison uses the same evolving Git tree for **all** products and the no-memory control. A product-only uncommitted-work recovery stress track is reported separately. PM is evaluated on recommendation quality and evidence handling, not SQL syntax, Ledger record schema, or whether it chose the author's preferred option.

`prepare-sequence` creates empty fresh identities and retains the pack/driver hashes. `run-sequence` releases inputs just in time, transfers the ordinary predecessor code tree equally, invokes the stage driver, grades the immutable submitted artifacts and invokes configured native capture without inventing semantic handoffs. It retains failed stages and refuses to overwrite/retry an attempted sequence. Export/cleanup and product-specific provisioning remain explicit native responsibilities. The example launch is intentionally unauthorized.

See [protocol.md](protocol.md), [providers.md](providers.md), [rubric.md](rubric.md) and the generated `controller/input-availability.json`. Scenario data is explicitly synthetic, seeded and reproducible; it does not represent actual customers or production experiments.


Live orchestration is now implemented in `matrix.py`: one concurrent lane per arm, engineering then PM within each lane, and fresh A→B→C→D sessions within each sequence. The matrix requires all six arms to be represented, shared frozen conditions, a shared allowance, and unattempted sequences. It retains failures and does not retry scored stages. Launch with `python3 eval/teamwork-v2/matrix.py run --config /absolute/matrix.json --out /absolute/new-run-output`.

`native-lifecycle.mjs` provisions Ledger, Supermemory, GBrain and Graphify. `native-mem0-lifecycle.mjs` binds the pinned official Mem0 Codex plugin, including automatic hooks and native search. The HTTP proxies keep provider keys outside task identities and enforce classified routes, sequence scope and budget reservations. Mem0 uses a fresh unclaimed evaluation account with a bounded request quota; this configuration does not claim paid graph features. Native readiness receipts remain required; executable implementation alone is not readiness evidence.

On 2026-09-12 the private run directory `.context/teamwork-v2-live-20260912/` retained live readiness evidence. Ledger and Mem0 exercised actual fresh task-agent sessions; Supermemory, GBrain and Graphify exercised native hooks/tools across fresh native processes. Supermemory explicit search passed while automatic hook injection did not return the canary. These distinctions remain in the receipts. Development probes are excluded from heldout seed137 scoring. PM judgment uses `review-runner.mjs`; its independent contexts are model reviews, and missing review remains not-evaluated. See `REVIEW-RUNNER.md`.
