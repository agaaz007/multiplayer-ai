#!/usr/bin/env python3
"""Live LOCAL PostgreSQL/MCP isolation checks; no model calls or production config.

Build first: node_modules/.bin/tsc -p tsconfig.json --outDir dist-completion
Run: python3 eval/test_handoff_database_isolation.py --build-dir dist-completion
"""
import argparse
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("hard_handoff", ROOT / "eval/run-hard-handoff.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

MCP_CHECK = r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const build = process.argv[1];
const { migrate, getPool, closePools } = await import(pathToFileURL(path.join(build, 'continuity/db.js')));
const { createMcpServer } = await import(pathToFileURL(path.join(build, 'mcp.js')));
const configs = JSON.parse(fs.readFileSync(0, 'utf8'));
const markers = ['ISOLATION_CANARY_ALPHA', 'ISOLATION_CANARY_BETA'];
const servers = [], clients = [];
try {
  await Promise.all(configs.map(async (cfg, index) => {
    const pool = getPool(cfg);
    await migrate(pool);
    const existing = await pool.query('select count(*)::int as n from cont_threads');
    assert.equal(existing.rows[0].n, 0, 'each trial starts with no foreign threads');
    await pool.query('insert into cont_threads(repo,title,goal,created_by) values($1,$2,$2,$3)',
      ['same-repo-canary', markers[index], 'other-author']);
  }));
  const replies = await Promise.all(configs.map(async (cfg, index) => {
    const server = createMcpServer(cfg);
    const client = new Client({name: 'database-isolation-selftest', version: '1'});
    servers.push(server); clients.push(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({name: 'ledger_brief', arguments: {days: 14}});
    assert.ok(!result.isError, 'real ledger_brief MCP call succeeds');
    const text = result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
    assert.ok(text.includes(markers[index]), 'own canary is visible through real MCP brief');
    assert.ok(!text.includes(markers[1 - index]), 'other trial canary is absent from real MCP brief');
    return {own_canary_visible: true, foreign_canary_visible: false};
  }));
  console.log(JSON.stringify({mcp_briefs: replies}));
} finally {
  await Promise.all(clients.map(client => client.close()));
  await Promise.all(servers.map(server => server.close()));
  await closePools();
}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", default="dist-completion")
    args = parser.parse_args()
    build = (ROOT / args.build_dir).resolve()
    assert (build / "mcp.js").is_file(), "build the isolated test output directory first"
    before_env = dict(os.environ)
    for url in ["postgresql://production.example/ledger_eval", "postgresql://localhost.evil/ledger_eval",
                "postgresql://127.0.0.2/ledger_eval", "postgresql://localhost/production",
                "postgresql://localhost/ledger_eval?host=production.example",
                "postgresql://localhost/ledger_eval?service=production", "postgresql://localhost/ledger_eval#x",
                "mysql://localhost/ledger_eval", "postgresql:///ledger_eval",
                "postgresql://localhost:wrong/ledger_eval"]:
        try:
            runner.local_database_settings(url)
        except ValueError:
            pass
        else:
            raise AssertionError("unsafe database configuration accepted")
    print("ok: ten remote/override/non-evaluation URL configurations rejected before any database operation")

    settings = runner.local_database_settings(os.environ.get("LEDGER_EVAL_DB", runner.DEFAULT_DATABASE))
    created = []
    with tempfile.TemporaryDirectory(prefix="ledger-eval-db-isolation-") as temporary:
        temp = Path(temporary)
        env = {**os.environ, "LEDGER_EVAL": "1", "LEDGER_CONFIG_DIR": str(temp / "config")}
        Path(env["LEDGER_CONFIG_DIR"]).mkdir()
        # libpq service/host overrides must not bypass the explicit loopback guard.
        pg_hostile_env = {**env, "PGHOSTADDR": "203.0.113.1", "PGSERVICE": "production-canary"}
        databases = [runner.TrialDatabase(settings, temp / str(i) / "isolation.json", pg_hostile_env) for i in range(2)]
        created.extend(databases)
        assert databases[0].name != databases[1].name
        assert all("PGHOSTADDR" not in db.env and "PGSERVICE" not in db.env for db in databases)
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                list(executor.map(lambda database: database.create(), databases))
            for database in databases:
                assert database.report["empty_precondition"] == {
                    **database.report["empty_precondition"], "non_system_relations": 0, "passed": True}
                assert database.report["created_by_controller"] is True
            assert databases[0].url != databases[1].url
            print("ok: two concurrent trials created distinct empty template0 databases without mutating global environment")

            configs = []
            for index, database in enumerate(databases):
                ledger = temp / str(index) / "ledger"
                ledger.mkdir()
                configs.append({"ledger_dir": str(ledger), "author": "reader", "git_sync": False,
                                "continuity": {"database_url": database.url}})
            result = subprocess.run(["node", "--input-type=module", "-e", MCP_CHECK, str(build)],
                                    input=json.dumps(configs), env=env, cwd=ROOT, text=True,
                                    capture_output=True, timeout=45)
            assert result.returncode == 0, result.stderr
            actual = json.loads(result.stdout)
            assert actual["mcp_briefs"] == [{"own_canary_visible": True, "foreign_canary_visible": False}] * 2
            print("ok: two actual MCP ledger_brief calls each see their own thread canary and no foreign trial canary")

            # Simulate an unpredictable name collision: CREATE rejects it; the failed
            # lifecycle never gains authority to drop the already-existing database.
            with patch.object(runner.secrets, "token_hex", return_value=databases[0].name.removeprefix("ledger_eval_")):
                collision = runner.TrialDatabase(settings, temp / "collision.json", env)
            try:
                collision.create()
            except RuntimeError:
                pass
            else:
                raise AssertionError("database collision must not attach to existing data")
            assert collision.owned is False
            assert collision.cleanup()["status"] == "not_created"
            count = databases[0]._command("psql", "--dbname", databases[0].name, "--no-psqlrc", "--tuples-only",
                                          "--no-align", "--command", "select count(*) from cont_threads;")
            assert count == "1", "failed CREATE cleanup must preserve the original database"
            print("ok: a failed exclusive CREATE cannot delete a preexisting database or its canary")

            with patch.object(databases[1], "_command", side_effect=RuntimeError("injected drop failure")):
                cleanup = databases[1].cleanup()
            assert cleanup == {"status": "error", "reason": "injected drop failure"}
            assert json.loads(databases[1].artifact.read_text())["cleanup"] == cleanup
            # A failed drop leaves the ownership proof intact; reset this test object's
            # terminal flag only to clean up our own injected failure after asserting it.
            assert databases[1].owned is True
            databases[1].finished = False
            print("ok: cleanup failure remains explicit in the retained artifact; no false dropped status")
        finally:
            for database in created:
                cleanup = database.cleanup()
                assert cleanup["status"] == "dropped", cleanup

        for database in databases:
            assert json.loads(database.artifact.read_text())["cleanup"]["status"] == "dropped"
            exists = database._command("psql", "--dbname", "postgres", "--no-psqlrc", "--tuples-only", "--no-align",
                                       "--command", "select count(*) from pg_database where datname='" + database.name + "';")
            assert exists == "0", "owned database was not dropped"
        # Exercise main() with a deliberately non-model adapter. Its two concurrent
        # children inspect their own assigned DB and explicitly return an error so
        # this infrastructure selftest can never look like a successful live trial.
        stub_build = temp / "stub-build"
        (stub_build / "eval").mkdir(parents=True)
        pg_module = (ROOT / "node_modules/pg/lib/index.js").as_uri()
        stub = r"""
import fs from 'node:fs';
import path from 'node:path';
import pg from PG_MODULE;
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString());
const pool = new pg.Pool({connectionString: process.env.LEDGER_EVAL_DB, ssl: false});
try {
  const name = (await pool.query('select current_database() as name')).rows[0].name;
  const empty = (await pool.query("select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'")).rows[0].n;
  await pool.query('create table runner_canary(marker text)');
  await pool.query('insert into runner_canary values($1)', [request.trial_id]);
  await new Promise(resolve => setTimeout(resolve, 150));
  const rows = (await pool.query('select marker from runner_canary')).rows;
  fs.writeFileSync(path.join(request.output_dir, 'raw/child-database.json'), JSON.stringify({name, empty, markers: rows.map(x => x.marker), config_dir: process.env.LEDGER_CONFIG_DIR}));
  console.log(JSON.stringify({status:'error',reason:'Synthetic runner infrastructure selftest; no model calls'}));
} finally { await pool.end(); }
""".replace("PG_MODULE", json.dumps(pg_module))
        (stub_build / "eval/adapter.js").write_text(stub)
        run_output = temp / "runner-output"
        run_env = {**env, "LEDGER_EXTRACTOR": "claude"}
        run_env.pop("LEDGER_EXTRACTOR_CMD", None)
        launched = subprocess.run(["python3", str(ROOT / "eval/run-hard-handoff.py"),
                                   "--out", str(run_output), "--build-dir", str(stub_build),
                                   "--cases", "E03", "--conditions", "ours", "gbrain",
                                   "--directions", "codex-to-claude", "--workers", "2", "--noise-events", "2"],
                                  env=run_env, cwd=ROOT, capture_output=True, text=True, timeout=60)
        assert launched.returncode == 0, launched.stderr
        manifest = json.loads((run_output / "manifest.json").read_text())
        reports = manifest["database_isolation"]["trials"]
        assert len(reports) == 2
        assert len({report["database"] for report in reports.values()}) == 2
        for run_id, report in reports.items():
            assert report["cleanup"]["status"] == "dropped"
            assert report["empty_precondition"]["passed"] is True
            artifact = run_output / report["artifact"]
            bundle = artifact.parent.parent
            child = json.loads((artifact.parent / "child-database.json").read_text())
            assert child["name"] == report["database"]
            assert child["empty"] == 0
            assert child["markers"] == [run_id]
            observation = json.loads((bundle / "observation.json").read_text())
            assert observation["database_isolation_file"] == "raw/database-isolation.json"
            assert observation["database_cleanup"]["status"] == "dropped"
            assert observation["status"] == "error"
        print("ok: real runner launches two isolated child databases and records empty preconditions and teardown in manifest/bundles")
        assert dict(os.environ) == before_env
        print("ok: both precisely owned databases removed; unrelated databases and global environment untouched")
    print("test_handoff_database_isolation: all checks passed (local Postgres and actual MCP; no live models)")


if __name__ == "__main__":
    main()
