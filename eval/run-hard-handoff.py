#!/usr/bin/env python3
"""Run selected live handoff cases with frozen inputs and the unmodified kit scorer.

Same-machine only. This runner does not claim a Rachit-laptop interruption.
The private oracle remains in the controller bundle, outside all agent worktrees.
"""
import argparse
import concurrent.futures
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
KIT = ROOT / "eval/kit/continuity_eval.py"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--cases", nargs="+", choices=["E03", "C02", "L01", "R01"], default=["E03", "C02"])
    parser.add_argument("--conditions", nargs="+", choices=["ours", "gbrain"], default=["ours", "gbrain"])
    parser.add_argument("--directions", nargs="+", choices=["codex-to-claude", "claude-to-codex"], default=["codex-to-claude", "claude-to-codex"])
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=7200)
    parser.add_argument("--noise-events", type=int, default=1300)
    parser.add_argument("--build-dir", default="dist-handoff")
    args = parser.parse_args()
    if min(args.repetitions, args.workers, args.timeout) < 1:
        parser.error("repetitions, workers and timeout must be positive")
    out = Path(args.out).resolve()
    if out.exists():
        parser.error("output directory already exists; choose a new run to retain earlier evidence")
    adapter = ROOT / args.build_dir / "eval/adapter.js"
    if not adapter.is_file():
        parser.error("build first: node_modules/.bin/tsc -p tsconfig.json --outDir " + args.build_dir)
    out.mkdir(parents=True)
    # Freeze executable bytes: rebuilding the workspace during a run cannot alter a
    # later dynamic import or the MCP server that a successor is about to start.
    build = out / "build"
    shutil.copytree(ROOT / args.build_dir, build)
    adapter = build / "eval/adapter.js"
    suite = out / "suite"
    subprocess.run([sys.executable, str(KIT), "prepare", "--out", str(suite), "--noise-events", str(args.noise_events)], check=True, cwd=ROOT)
    # Retain the full oracle unchanged; omitted cases remain not_run in level reports.
    manifest = {
        "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "topology": "same-machine", "cases": args.cases, "conditions": args.conditions,
        "anthropic_api_key_present": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "directions": args.directions, "repetitions": args.repetitions,
        "suite_sha256": hashlib.sha256((suite / "private/oracle.json").read_bytes()).hexdigest(),
        "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "working_diff_sha256": hashlib.sha256(subprocess.check_output(["git", "diff"], cwd=ROOT)).hexdigest(),
        "build_files": {str(p.relative_to(build)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(build.rglob("*.js"))},
        "limitations": ["Controlled fixture, not a real interrupted teammate task", "No second laptop involved", "One repetition is not a reliability estimate"],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    env = {**os.environ, "LEDGER_EVAL": "1"}
    env.pop("LEDGER_EVAL_FAKE_HARNESS", None)
    env["LEDGER_CONFIG_DIR"] = str(out / "controller-config")
    env.setdefault("LEDGER_EVAL_TOKENIZER_PYTHON", str(ROOT / ".context/eval-tokenizer/bin/python3"))
    Path(env["LEDGER_CONFIG_DIR"]).mkdir()
    (out / "source.diff").write_bytes(subprocess.check_output(["git", "diff"], cwd=ROOT))

    def trial(condition, case, direction, repetition):
        bundle = out / condition / "observations" / case / direction / str(repetition)
        bundle.mkdir(parents=True)
        run_id = f"hard-{out.name}-{condition}-{case}-{direction}-{repetition}"
        request = {"protocol_version": 1, "case": json.loads((suite / "public" / f"{case}.json").read_text()),
                   "direction": direction, "repetition": repetition, "trial_id": run_id, "output_dir": str(bundle)}
        print(f"start {condition} {case} {direction} #{repetition}", flush=True)
        # Adapter retains raw traces and uses bounded process groups for harness turns.
        timed_out = False
        with (bundle / "adapter.stderr.log").open("w") as stderr:
            process = subprocess.Popen(["node", str(adapter), "--condition", condition], text=True,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, cwd=ROOT, env=env)
            try:
                stdout, _ = process.communicate(json.dumps(request), timeout=args.timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                # Give the adapter's signal handler time to stop its owned, detached
                # harness groups. subprocess.run(timeout) would SIGKILL it directly.
                process.terminate()
                try:
                    stdout, _ = process.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    stdout, _ = process.communicate()
        (bundle / "adapter.stdout.json").write_text(stdout)
        try:
            observation = json.loads(stdout)
        except ValueError:
            observation = {"status": "error", "reason": "adapter returned invalid JSON; see adapter stdout/stderr"}
        if timed_out:
            observation = {"status": "error", "reason": "adapter timed out; SIGTERM cleanup requested; inspect retained raw traces"}
        (bundle / "observation.json").write_text(json.dumps(observation, indent=2) + "\n")
        print(f"done {condition} {case} {direction}: {observation.get('status')} {observation.get('reason', '')}", flush=True)

    jobs = [(c, k, d, r) for k in args.cases for d in args.directions for c in args.conditions for r in range(1, args.repetitions + 1)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(trial, *job) for job in jobs]
        for job, future in zip(jobs, futures):
            try:
                future.result()
            except Exception as error:
                print(f"controller error {job}: {error}", flush=True)
    for condition in args.conditions:
        subprocess.run([sys.executable, str(KIT), "score", "--suite", str(suite), "--out", str(out / condition),
                        "--directions", *args.directions, "--repetitions", str(args.repetitions)], check=True, cwd=ROOT)
    print(str(out / "manifest.json"))


if __name__ == "__main__":
    main()
