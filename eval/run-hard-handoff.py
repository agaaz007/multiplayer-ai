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
import re
import secrets
import shutil
import subprocess
import sys
import threading
from urllib.parse import unquote, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
KIT = ROOT / "eval/kit/continuity_eval.py"
DEFAULT_DATABASE = "postgresql://localhost:5432/ledger_eval"


def local_database_settings(url):
    """Reject remote hosts and URI options that could override the loopback host."""
    try:
        parsed = urlsplit(url)
        port = parsed.port or 5432
    except ValueError as error:
        raise ValueError("invalid local evaluation database URL") from error
    if (parsed.scheme not in ("postgres", "postgresql")
            or parsed.hostname not in ("localhost", "127.0.0.1", "::1")
            or parsed.query or parsed.fragment
            or not re.fullmatch(r"/ledger_eval(?:_[a-zA-Z0-9_]+)?", parsed.path)):
        raise ValueError("LEDGER_EVAL_DB must name a local ledger_eval database with no URI options")
    return {"parsed": parsed, "host": parsed.hostname, "port": port,
            "user": unquote(parsed.username) if parsed.username else None,
            "password": unquote(parsed.password) if parsed.password else None}


class TrialDatabase:
    """An exclusive CREATE DATABASE from template0; only its creator may drop it."""

    def __init__(self, settings, artifact, env):
        self.settings = settings
        self.artifact = Path(artifact)
        self.name = "ledger_eval_" + secrets.token_hex(16)
        self.owned = False
        self.finished = False
        self.env = {key: value for key, value in env.items() if not key.startswith("PG")}
        self.env["PGCONNECT_TIMEOUT"] = "8"
        if settings["password"] is not None:
            self.env["PGPASSWORD"] = settings["password"]
        self.report = {"mode": "exclusive_database_per_trial", "database": self.name,
                       "host": settings["host"], "port": settings["port"],
                       "created_by_controller": False, "template": "template0",
                       "empty_precondition": None, "cleanup": {"status": "not_created"}}

    @property
    def url(self):
        parsed = self.settings["parsed"]
        return urlunsplit((parsed.scheme, parsed.netloc, "/" + self.name, "", ""))

    def _write(self):
        self.artifact.parent.mkdir(parents=True, exist_ok=True)
        self.artifact.write_text(json.dumps(self.report, indent=2) + "\n")

    def _command(self, program, *args):
        connection = ["--host", self.settings["host"], "--port", str(self.settings["port"]), "--no-password"]
        if self.settings["user"]:
            connection.extend(["--username", self.settings["user"]])
        result = subprocess.run([program, *connection, *args], env=self.env, text=True,
                                capture_output=True, timeout=30)
        if result.returncode:
            # Connection credentials are never included in argv or the report.
            detail = result.stderr.strip()[:500]
            if self.settings["password"]:
                detail = detail.replace(self.settings["password"], "[redacted]")
            raise RuntimeError(f"{program} failed: {detail}")
        return result.stdout.strip()

    def create(self):
        if self.owned or self.finished:
            raise RuntimeError("database lifecycle cannot be reused")
        self._write()
        try:
            # CREATE must fail on collision. Never attach to or delete a preexisting DB.
            self._command("createdb", "--maintenance-db", "postgres", "--template", "template0", self.name)
            self.owned = True
            self.report["created_by_controller"] = True
            self.report["created_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            self.report["cleanup"] = {"status": "pending"}
            self._write()
            count = int(self._command("psql", "--dbname", self.name, "--no-psqlrc", "--tuples-only", "--no-align",
                                      "--set", "ON_ERROR_STOP=1", "--command",
                                      "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace "
                                      "where n.nspname <> 'information_schema' and n.nspname !~ '^pg_';"))
            self.report["empty_precondition"] = {"non_system_relations": count, "passed": count == 0,
                                                  "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
            if count != 0:
                raise RuntimeError("new evaluation database is not empty")
            self._write()
        except Exception as error:
            self.report["setup_error"] = str(error)
            self._write()
            raise

    def cleanup(self):
        if self.finished:
            return self.report["cleanup"]
        self.finished = True
        if self.owned:
            if not re.fullmatch(r"ledger_eval_[0-9a-f]{32}", self.name):
                raise RuntimeError("refusing to drop an unexpected database name")
            try:
                # No --force: a surviving child connection must be disclosed, not killed.
                self._command("dropdb", "--maintenance-db", "postgres", self.name)
                self.report["cleanup"] = {"status": "dropped", "at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
                self.owned = False
            except Exception as error:
                self.report["cleanup"] = {"status": "error", "reason": str(error)}
        self._write()
        return self.report["cleanup"]


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
    if os.environ.get("LEDGER_EXTRACTOR_CMD") or os.environ.get("LEDGER_EXTRACTOR", "auto") not in ("auto", "claude"):
        parser.error("live hard-handoff runs require the isolated Claude classifier; unset custom extractor overrides")
    try:
        database_settings = local_database_settings(os.environ.get("LEDGER_EVAL_DB", DEFAULT_DATABASE))
    except ValueError as error:
        parser.error(str(error))
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
    shutil.copytree(ROOT / "prompts", out / "prompts")
    shutil.copytree(ROOT / "template", out / "template")
    # Encoding data is immutable and hash-checked by tiktoken. Freeze an already
    # populated cache so parallel trials need no network fetch on first use.
    tokenizer_cache = ROOT / ".context/eval-tokenizer/cache"
    if "L01" in args.cases and tokenizer_cache.is_dir():
        shutil.copytree(tokenizer_cache, out / ".context/eval-tokenizer/cache")
    adapter = build / "eval/adapter.js"
    suite = out / "suite"
    subprocess.run([sys.executable, str(KIT), "prepare", "--out", str(suite), "--noise-events", str(args.noise_events)], check=True, cwd=ROOT)
    # Retain the full oracle unchanged; omitted cases remain not_run in level reports.
    manifest = {
        "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "topology": "same-machine", "cases": args.cases, "conditions": args.conditions,
        "anthropic_api_key_present": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "classifier": {"provider": "claude", "model": "CLI configured default (not independently resolved)", "custom_extractor_override": False},
        "database_isolation": {"mode": "exclusive_database_per_trial", "host": database_settings["host"],
                               "port": database_settings["port"], "template": "template0", "trials": {}},
        "directions": args.directions, "repetitions": args.repetitions,
        "suite_sha256": hashlib.sha256((suite / "private/oracle.json").read_bytes()).hexdigest(),
        "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "working_diff_sha256": hashlib.sha256(subprocess.check_output(["git", "diff"], cwd=ROOT)).hexdigest(),
        "build_files": {str(p.relative_to(build)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(build.rglob("*.js"))},
        "prompt_files": {str(p.relative_to(out)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((out / "prompts").rglob("*")) if p.is_file()},
        "template_files": {str(p.relative_to(out)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((out / "template").rglob("*")) if p.is_file()},
        "tokenizer_cache_files": {str(p.relative_to(out)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((out / ".context/eval-tokenizer/cache").glob("*")) if p.is_file()},
        "limitations": ["Controlled fixture, not a real interrupted teammate task", "No second laptop involved", "One repetition is not a reliability estimate"],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    env = {**os.environ, "LEDGER_EVAL": "1"}
    env.pop("LEDGER_EVAL_FAKE_HARNESS", None)
    env["LEDGER_CONFIG_DIR"] = str(out / "controller-config")
    env.setdefault("LEDGER_EVAL_TOKENIZER_PYTHON", str(ROOT / ".context/eval-tokenizer/bin/python3"))
    Path(env["LEDGER_CONFIG_DIR"]).mkdir()
    (out / "source.diff").write_bytes(subprocess.check_output(["git", "diff"], cwd=ROOT))
    manifest_lock = threading.Lock()

    def record_database(run_id, database):
        with manifest_lock:
            manifest["database_isolation"]["trials"][run_id] = {
                **database.report, "artifact": str(database.artifact.relative_to(out))}
            temporary = out / "manifest.pending.json"
            temporary.write_text(json.dumps(manifest, indent=2) + "\n")
            temporary.replace(out / "manifest.json")

    def trial(condition, case, direction, repetition):
        bundle = out / condition / "observations" / case / direction / str(repetition)
        bundle.mkdir(parents=True)
        run_id = f"hard-{out.name}-{condition}-{case}-{direction}-{repetition}"
        request = {"protocol_version": 1, "case": json.loads((suite / "public" / f"{case}.json").read_text()),
                   "direction": direction, "repetition": repetition, "trial_id": run_id, "output_dir": str(bundle)}
        print(f"start {condition} {case} {direction} #{repetition}", flush=True)
        database = TrialDatabase(database_settings, bundle / "raw/database-isolation.json", env)
        # Adapter retains raw traces and uses bounded process groups for harness turns.
        timed_out = False
        stdout = ""
        observation = None
        try:
            database.create()
            record_database(run_id, database)
            child_env = {**env, "LEDGER_EVAL_DB": database.url}
            with (bundle / "adapter.stderr.log").open("w") as stderr:
                process = subprocess.Popen(["node", str(adapter), "--condition", condition], text=True,
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, cwd=ROOT, env=child_env)
                try:
                    stdout, _ = process.communicate(json.dumps(request), timeout=args.timeout)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    # Adapter's signal handler stops its owned detached harness groups.
                    process.terminate()
                    try:
                        stdout, _ = process.communicate(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        stdout, _ = process.communicate()
            try:
                observation = json.loads(stdout)
                if not isinstance(observation, dict):
                    raise ValueError("observation must be an object")
            except ValueError:
                observation = {"status": "error", "reason": "adapter returned invalid JSON; see adapter stdout/stderr"}
            if timed_out:
                observation = {"status": "error", "reason": "adapter timed out; SIGTERM cleanup requested; inspect retained raw traces"}
        except Exception as error:
            observation = {"status": "error", "reason": str(error)}
        finally:
            # Adapter has exited (including its normal cleanup) before we attempt DROP.
            cleanup = database.cleanup()
            record_database(run_id, database)
            if cleanup["status"] == "error":
                print(f"database cleanup error {run_id}: {cleanup['reason']}", flush=True)
        (bundle / "adapter.stdout.json").write_text(stdout)
        observation["database_isolation_file"] = "raw/database-isolation.json"
        observation["database_cleanup"] = database.report["cleanup"]
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
