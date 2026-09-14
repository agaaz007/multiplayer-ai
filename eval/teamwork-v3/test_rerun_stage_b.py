"""Controller-only tests for the stage-B rerun: synthetic roots, a fake driver, no model/provider calls.

The Postgres test uses throwaway databases named ledger_eval_rerun_test_* on 127.0.0.1:5432 and
skips cleanly when the server is unreachable. No other database is touched.
"""
import importlib.util
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('rerun_stage_b', HERE / 'rerun-stage-b.py')
rerun = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rerun)
sequence = rerun.sequence

CUTOFF = '2026-09-13T10:19:04.139Z'
BEFORE, AFTER = '2026-09-13T10:16:00.000Z', '2026-09-13T10:25:00.000Z'
REFERENCE = (HERE.parent / 'teamwork-v2' / 'reference_app.py').read_text()
GET_OMITS_RECEIPT = REFERENCE.replace("if len(parts)==3 and self.command=='GET':return 200,j",
                                      "if len(parts)==3 and self.command=='GET':return 200,{k:v for k,v in j.items() if k!='receipt_id'}")
assert GET_OMITS_RECEIPT != REFERENCE

FAKE_DRIVER = r'''
import hashlib, json, shutil, sys
from pathlib import Path
here = Path(__file__).resolve().parent
cfg = json.loads((here / 'fake-driver-config.json').read_text())
mode, request_file = sys.argv[1], sys.argv[2]
assert mode == 'run', mode
req = json.loads(Path(request_file).read_text())
assert req['schema'] == 'teamwork-stage-request/v3' and req['stage'] == 'B'
assert req['execution_authorized'] is True and req['authorization'], 'fake driver launched without authorization'
work, ctl = Path(req['workspace']), Path(req['controller_output_dir'])
(ctl / 'fake-driver-ran').write_text(req['arm'])
assert (work / 'app.py').is_file() and (work / 'release/API-A.md').is_file(), 'predecessor tree missing'
assert (work / 'release/API-B.md').is_file(), 'stage delta missing'
assert (work / '.git').is_dir(), 'seeded git history missing'
profile = json.loads(Path(req['native_profile']).read_text())
assert profile['arm'] == req['arm']
if req['arm'] == 'fresh-agent':
    assert not profile.get('mcp') and not profile.get('hooks'), 'control has memory servers'
else:
    assert 'ledger' in profile['mcp'], 'ledger session lacks its MCP server'
tree = ctl / 'submission/tree'
shutil.copytree(work, tree, ignore=shutil.ignore_patterns('.git'))
(tree / 'app.py').write_text(Path(cfg['ledger_app' if req['arm'] == 'ledger' else 'control_app']).read_text())
(tree / 'reports').mkdir(exist_ok=True)
(tree / 'reports/B.md').write_text('# fake stage B\n')
answer = ctl / 'submission/answer.json'
answer.write_text(json.dumps({'complete': True, 'arm': req['arm']}))
def digest(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()
files = {}
for p in sorted(tree.rglob('*')):
    if p.is_file():
        files[p.relative_to(tree).as_posix()] = digest(p)
(ctl / 'delivery.json').write_text(json.dumps({'schema': 'teamwork-delivery/v3', 'elapsed_ms': 50,
    'answer_file_sha256': digest(answer), 'tree': {'files': files}}))
(ctl / 'stage-result.json').write_text(json.dumps({'schema': 'teamwork-stage/v3', 'arm': req['arm'], 'stage': 'B',
    'delivered': True, 'timing_valid': True, 'elapsed_ms': 50, 'wall_elapsed_ms': 50, 'timed_out': False, 'exit_code': 0}))
print('fake driver finished', req['arm'])
'''

FAKE_STAGE_PROFILE = r'''
import hashlib, json, sys
from pathlib import Path
mode, request_file = sys.argv[1], sys.argv[2]
assert mode == 'stage'
req = json.loads(Path(request_file).read_text())
cfg = json.loads(Path(req['native_config']).read_text())
root = Path(cfg['root'])
owner = json.loads((root / 'ledger-native-owner.json').read_text())
state = json.loads((root / 'native-state.json').read_text())
assert owner['databaseName'] == state['database_name'] and 'B' not in state['stages']
assert Path(req['workspace']).resolve().is_relative_to(root.resolve())
env = {'LEDGER_CONFIG_DIR': str(Path(req['fresh_home']) / '.ledger'), 'LEDGER_CONTINUITY_DB': owner['databaseUrl'],
       'LEDGER_CLASSIFY': '0', 'LEDGER_EXTRACTOR': 'none', 'LEDGER_GIT_SYNC': '0'}
(Path(req['fresh_home']) / '.ledger').mkdir(parents=True, exist_ok=True)
(Path(req['fresh_home']) / '.ledger' / 'config.json').write_text(json.dumps({'ledger_dir': str(root / 'ledger'),
    'continuity': {'database_url': owner['databaseUrl'], 'repos': [req['workspace']], 'classify': False}}))
profile = {'arm': 'ledger', 'guide_file': cfg['guide_file'], 'guide_sha256': hashlib.sha256(Path(cfg['guide_file']).read_bytes()).hexdigest(),
           'mcp': {'ledger': {'command': 'node', 'args': ['cli.js', 'mcp'], 'env': env, 'cwd': req['workspace']}},
           'hooks': {'hooks': {}}, 'hook_env': env, 'read_paths': [owner['remote']], 'write_paths': [str(root / 'ledger')],
           'readiness_verified': True, 'paid_paths_gated': True, 'budget_gate_module': cfg['budget_gate_module'],
           'budget_file': cfg['budget_file']}
Path(req['native_profile']).write_text(json.dumps(profile, indent=1))
state['stages'].append('B'); (root / 'native-state.json').write_text(json.dumps(state))
print(json.dumps({'profile': req['native_profile']}))
'''

MINI_SCHEMA = '''
create table cont_threads(id text primary key, title text, status text, created_at timestamptz, updated_at timestamptz);
create table cont_sessions(id text primary key, harness text, cwd text, transcript_path text, thread_id text references cont_threads(id),
  wip_ref text, wip_commit text, ended_at timestamptz);
create table cont_events(id serial primary key, session_id text not null references cont_sessions(id), seq int, kind text,
  occurred_at timestamptz, received_at timestamptz);
create table cont_checkpoints(id text primary key, thread_id text not null references cont_threads(id), session_id text not null references cont_sessions(id), created_at timestamptz);
create table cont_claims(thread_id text primary key references cont_threads(id), holder_session_id text, holder_author text, acquired_at timestamptz);
create table cont_artifacts(id text primary key, session_id text, sha256 text, created_at timestamptz);
create table cont_records(id text primary key, title text, status text, state_version int, created_at timestamptz, updated_at timestamptz);
create table cont_record_links(id text primary key, record_id text not null references cont_records(id) on delete cascade, session_id text not null references cont_sessions(id), created_at timestamptz);
create table cont_state_updates(id text primary key, record_id text not null references cont_records(id) on delete cascade, session_id text, status text,
  text text, created_by text, created_at timestamptz, confirmed_by text, confirmed_at timestamptz, rejected_by text, rejected_at timestamptz, reject_reason text);
'''


def postgres_available():
    try:
        ready = subprocess.run(['pg_isready', '-h', '127.0.0.1', '-p', '5432'], capture_output=True, timeout=10)
        if ready.returncode != 0:
            return False
        subprocess.run(['psql', admin_url(), '-X', '-q', '-t', '-c', 'select 1'], check=True, capture_output=True, timeout=10)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def admin_url():
    import urllib.parse
    return 'postgresql://' + urllib.parse.quote(os.environ.get('USER', 'postgres')) + '@127.0.0.1:5432/postgres'


class SyntheticSource:
    """An ended engineering-ledger v3 root: pack, delivered stage A, native store descriptors, remote, ledger dir."""

    def __init__(self, base, database_name='ledger_native_' + 'ab' * 12):
        self.base = Path(base)
        self.pack = self.base / 'pack'
        self.root = self.base / 'source' / 'engineering-ledger'
        self.runtime = self.base / 'runtime'
        self.node = shutil.which('node')
        self.database_name = database_name
        self.build_pack()
        self.build_runtime()
        self.build_root()

    def write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def build_pack(self):
        self.write(self.pack / 'initial-repo/WORKFLOW.md', '# workflow\n')
        self.write(self.pack / 'initial-repo/project.json', '{"name":"jobs"}\n')
        self.write(self.pack / 'deltas/A/app.py', '# starter\n')
        self.write(self.pack / 'deltas/A/provider_sim.py', '# sim\n')
        self.write(self.pack / 'deltas/A/release/API-A.md', '# API A\n')
        self.write(self.pack / 'deltas/B/release/API-B.md', '# API B\n')
        self.write(self.pack / 'deltas/B/release/operation-approval.md', 'one synthetic delivery approved\n')
        self.write(self.pack / 'prompts/A.txt', 'Do stage A\n')
        self.write(self.pack / 'prompts/B.txt', 'Continue the engineering team task, stage B.\n')
        self.manifest = {'schema': 'teamwork-pack/v3', 'track': 'engineering', 'arms': ['ledger', 'graphify'], 'development': False,
                         'initial_repo_dir': 'initial-repo', 'seed': 271,
                         'stages': [{'id': 'A', 'delta_dir': 'deltas/A', 'prompt_file': 'prompts/A.txt', 'deadline_ms': 60000, 'stress': {}},
                                    {'id': 'B', 'delta_dir': 'deltas/B', 'prompt_file': 'prompts/B.txt', 'deadline_ms': 60000,
                                     'stress': {'interrupt_after_supplier_effect': True}}]}
        self.manifest['files'] = sequence.inventory(self.pack, exclude_root={'manifest.json'})
        sequence.dump(self.pack / 'manifest.json', self.manifest)

    def build_runtime(self):
        self.write(self.runtime / 'cli.js', '// frozen runtime stand-in\n')
        self.write(self.runtime / 'eval/harness.js', '// stand-in\n')
        self.budget = self.base / 'budget.json'
        sequence.dump(self.budget, {'schema': 'teamwork-budget/v2', 'maximum_usd': 30, 'entries': []})
        self.gate = self.base / 'budget-gate.mjs'
        self.gate.write_text('export const permitNativeCall=()=>null;\n')

    def git(self, cwd, *args):
        env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull)
        return subprocess.run(['git', '-C', str(cwd), *args], env=env, check=True, capture_output=True, text=True).stdout.strip()

    def build_root(self):
        root = self.root
        (root / 'stages/A/home').mkdir(parents=True)
        (root / 'stages/B/home').mkdir(parents=True)
        tree = root / 'stages/A/controller/submission/tree'
        for name in ('WORKFLOW.md', 'project.json'):
            self.write(tree / name, (self.pack / 'initial-repo' / name).read_text())
        self.write(tree / 'app.py', REFERENCE)
        self.write(tree / 'provider_sim.py', '# sim\n')
        self.write(tree / 'release/API-A.md', '# API A\n')
        self.write(tree / 'test_app.py', '# tests\n')
        self.write(tree / 'reports/A.md', '# A report\n')
        self.write(tree / 'continuity/state.json', '{"stage":"A"}\n')
        answer = root / 'stages/A/controller/submission/answer.json'
        sequence.dump(answer, {'complete': True})
        sequence.dump(root / 'stages/A/controller/delivery.json', {'schema': 'teamwork-delivery/v3', 'elapsed_ms': 34000,
                      'answer_file_sha256': sequence.digest(answer), 'tree': {'files': sequence.inventory(tree)}})
        self.a_snapshot_repo = self.base / 'a-work'
        self.a_snapshot_repo.mkdir()
        (self.a_snapshot_repo / 'app.py').write_text(REFERENCE)
        self.git(self.a_snapshot_repo, 'init', '-q', '--initial-branch=main')
        self.git(self.a_snapshot_repo, 'add', '-A')
        self.git(self.a_snapshot_repo, '-c', 'user.name=t', '-c', 'user.email=t@evaluation.invalid', 'commit', '-qm', 'A wip')
        self.a_commit = self.git(self.a_snapshot_repo, 'rev-parse', 'HEAD')
        (self.a_snapshot_repo / 'app.py').write_text(GET_OMITS_RECEIPT)
        self.git(self.a_snapshot_repo, 'add', '-A')
        self.git(self.a_snapshot_repo, '-c', 'user.name=t', '-c', 'user.email=t@evaluation.invalid', 'commit', '-qm', 'B wip')
        self.b_commit = self.git(self.a_snapshot_repo, 'rev-parse', 'HEAD')
        remote = root / 'ledger-native-origin.git'
        self.git(root, 'init', '-q', '--bare', str(remote))
        self.git(self.a_snapshot_repo, 'push', '-q', str(remote), self.a_commit + ':refs/wip/benchmark-a/sessA')
        self.git(self.a_snapshot_repo, 'push', '-q', str(remote), self.b_commit + ':refs/wip/benchmark-b/sessB')
        sequence.dump(root / 'stages/A/controller/native-capture-1789294744144.json', {
            'arm': 'ledger', 'at': CUTOFF, 'snapshots': [{'session_id': 'sessA', 'thread_id': 'thrA', 'commit': self.a_commit,
                                                          'ref': 'refs/wip/benchmark-a/sessA', 'verified_at': BEFORE}]})
        namespace = 'ledger_eval_' + 'cd' * 16
        self.nonce = 'ef' * 24
        sequence.dump(root / 'ownership.json', {'namespace': namespace})
        sequence.dump(root / 'native-state.json', {'arm': 'ledger', 'namespace': namespace, 'created_at': BEFORE, 'version': 'test-freeze',
                                                   'stages': ['A', 'B'], 'database_name': self.database_name})
        self.admin = admin_url()
        sequence.dump(root / 'ledger-native-owner.json', {
            'trialDir': str(root), 'namespace': namespace, 'frozenBuildDir': str(self.runtime),
            'databaseUrl': rerun.database_url(self.admin, self.database_name), 'databaseName': self.database_name,
            'adminUrl': self.admin, 'remote': str(remote), 'nonce': self.nonce, 'createdAt': BEFORE,
            'stages': [{'home': str(root / 'stages/A/home'), 'worktree': str(root / 'stages/A/worktree'), 'harness': 'codex',
                        'person': 'benchmark-a', 'role': 'stage-A', 'initialHead': 'x', 'preparedAt': '2026-09-13T10:11:43.892Z'},
                       {'home': str(root / 'stages/B/home'), 'worktree': str(root / 'stages/B/worktree'), 'harness': 'codex',
                        'person': 'benchmark-b', 'role': 'stage-B', 'initialHead': 'y', 'preparedAt': '2026-09-13T10:19:15.477Z'}]})
        self.write(root / 'native-guide.md', 'Use the Ledger product natively.\n')
        sequence.dump(root / 'native-config.json', {'arm': 'ledger', 'root': str(root), 'runtime': str(self.runtime),
                                                    'guide_file': str(root / 'native-guide.md'), 'version': 'test-freeze',
                                                    'execution_authorized': True, 'budget_file': str(self.budget),
                                                    'budget_gate_module': str(self.gate), 'read_paths': []})
        ledger = root / 'ledger'
        self.write(ledger / 'decisions/dec-20260913-stage-a-oaf9.md', "---\ntype: decision\nid: dec-20260913-stage-a-oaf9\ngenerated:\n  by: 'human:benchmark-a'\n  at: '" + BEFORE + "'\n---\nA decision\n")
        self.write(ledger / 'decisions/dec-20260913-stage-b-mhqe.md', "---\ntype: decision\nid: dec-20260913-stage-b-mhqe\ngenerated:\n  by: 'human:benchmark-b'\n  at: '" + AFTER + "'\n---\nB decision\n")
        self.write(ledger / 'decisions/index.md', '# decisions\n\n* [B](dec-20260913-stage-b-mhqe.md) - b\n* [A](dec-20260913-stage-a-oaf9.md) - a\n')
        self.write(ledger / 'index.md', '# Ledger\n\n* [decisions](decisions/) - 2 decisions in force\n* [log](log.md) - newest first\n')
        self.write(ledger / 'README.md', '# Ledger\n\nLast record. 0 definitions, 2 decisions in force, 0 changes and 0 findings in the last 14 days.\n\n| a | [dec-20260913-stage-b-mhqe](decisions/dec-20260913-stage-b-mhqe.md) |\n| b | [dec-20260913-stage-a-oaf9](decisions/dec-20260913-stage-a-oaf9.md) |\n')
        self.write(ledger / 'log.md', '# Ledger log\n\n* **Creation**: decision [B](decisions/dec-20260913-stage-b-mhqe.md) by benchmark-b.\n* **Creation**: decision [A](decisions/dec-20260913-stage-a-oaf9.md) by benchmark-a.\n')
        self.write(root / 'external-operations/events.jsonl', json.dumps({'seq': 1, 'stage': 'B', 'kind': 'submit', 'key': 'k' * 20}) + '\n')
        sequence.dump(root / 'launch.json', {'schema': 'teamwork-launch/v3', 'runtime': str(self.runtime), 'model': 'gpt-5.6-sol',
                                             'reasoning_effort': 'medium', 'driver_argv': [self.node, 'session-driver.mjs', 'run', '{request}'],
                                             'budget_file': str(self.budget), 'capture_timeout_ms': 5000,
                                             'frozen_files': {str((self.runtime / 'cli.js').resolve()): sequence.digest(self.runtime / 'cli.js')}})
        sequence.dump(root / 'sequence.json', {'schema': 'teamwork-sequence/v3', 'pack': str(self.pack), 'arm': 'ledger', 'track': 'engineering',
                                               'development': False, 'pack_manifest_sha256': sequence.digest(self.pack / 'manifest.json'),
                                               'transport_sha256': 'x', 'executed': True, 'status': 'ended',
                                               'stages': {'A': {'status': 'finished', 'delivered': True, 'timing_valid': True},
                                                          'B': {'status': 'finished', 'delivered': True, 'timing_valid': True}}})


class RerunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='stage-b-rerun-test-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.source = SyntheticSource(self.base)
        tools = self.base / 'tools'
        tools.mkdir()
        self.control_app, self.ledger_app = tools / 'control_app.py', tools / 'ledger_app.py'
        self.control_app.write_text(REFERENCE)
        self.ledger_app.write_text(GET_OMITS_RECEIPT)
        self.driver = tools / 'fake-driver.py'
        self.driver.write_text(FAKE_DRIVER)
        sequence.dump(tools / 'fake-driver-config.json', {'control_app': str(self.control_app), 'ledger_app': str(self.ledger_app)})
        self.stage_script = tools / 'fake-stage.py'
        self.stage_script.write_text(FAKE_STAGE_PROFILE)
        self.driver_argv = [sys.executable, str(self.driver), 'run', '{request}']
        self.out = self.base / 'rerun'

    def prepare(self, arms=('fresh-agent',), sessions=2, authorize=None, **kw):
        return rerun.prepare(self.source.root, self.out, sessions, arms, authorize, driver_argv=self.driver_argv, **kw)

    def marker_count(self):
        return len(list(self.out.rglob('fake-driver-ran')))

    def test_interleave_balances_arms_abba(self):
        self.assertEqual(rerun.interleave(('ledger', 'fresh-agent'), 3),
                         ['ledger-01', 'fresh-agent-01', 'fresh-agent-02', 'ledger-02', 'ledger-03', 'fresh-agent-03'])

    def test_prepare_seeds_a_tree_plus_b_delta_and_never_launches(self):
        plan = self.prepare()
        self.assertEqual(plan['order'], ['fresh-agent-01', 'fresh-agent-02'])
        self.assertFalse(plan['execution_authorized'])
        self.assertEqual(plan['store_cutoff'], CUTOFF)
        self.assertEqual(plan['source_a_supplier_events'], [])
        self.assertEqual(self.marker_count(), 0)
        for record in plan['sessions']:
            work, ctl = Path(record['workspace']), Path(record['controller'])
            released = sequence.inventory(work, exclude_root={'.git'})
            expected = dict(sequence.inventory(self.source.root / 'stages/A/controller/submission/tree'))
            expected.update({'release/' + n: sequence.digest(self.source.pack / 'deltas/B/release' / n) for n in ('API-B.md', 'operation-approval.md')})
            self.assertEqual(released, expected)
            self.assertEqual((work / 'app.py').read_text(), REFERENCE)
            self.assertEqual(sequence.git(work, 'rev-list', '--count', 'HEAD'), '1')
            transport = sequence.load(ctl / 'transport.json')
            self.assertEqual(transport['schema'], 'teamwork-input-transport/stage-b-rerun/v1')
            self.assertIn('NOT initial repo + delta', transport['source_policy'])
            request = sequence.load(ctl / 'request.json')
            self.assertEqual(request['schema'], 'teamwork-stage-request/v3')
            self.assertFalse(request['execution_authorized'])
            self.assertIsNone(request['authorization'])
            self.assertEqual(request['model'], 'gpt-5.6-sol')
            self.assertEqual(request['stage_deadline_ms'], 60000)
            self.assertEqual(request['stress'], {'interrupt_after_supplier_effect': True})
            self.assertIn(str(self.source.root), request['forbidden_paths'])
            self.assertIn(str(self.source.pack), request['forbidden_paths'])
            self.assertEqual(len(request['forbidden_canaries']), 2)
            profile = sequence.load(request['native_profile'])
            self.assertEqual(profile['arm'], 'fresh-agent')
            self.assertEqual(profile['mcp'], {})
            self.assertNotIn('hooks', profile)
            self.assertTrue(profile['readiness_verified'] and profile['paid_paths_gated'])
            self.assertEqual(Path(profile['guide_file']).read_text(), rerun.CONTROL_GUIDE)
            launch = sequence.load(Path(record['root']) / 'launch.json')
            self.assertFalse(launch['execution_authorized'])
            self.assertEqual(launch['frozen_files_sha256'], plan['frozen_files_sha256'])
        frozen = sequence.load(self.out / 'frozen-files.json')
        self.assertIn(str(self.driver.resolve()), frozen)
        self.assertIn(str((self.source.runtime / 'cli.js').resolve()), frozen)
        self.assertEqual(plan['runtime_freeze_matches_source_launch']['mismatched'], 0)
        self.assertGreaterEqual(plan['runtime_freeze_matches_source_launch']['compared'], 1)

    def test_prepare_refuses_delta_collision_with_predecessor_tree(self):
        tree = self.source.root / 'stages/A/controller/submission/tree'
        (tree / 'release/API-B.md').write_text('# predecessor already had this path\n')
        delivery = sequence.load(self.source.root / 'stages/A/controller/delivery.json')
        delivery['tree']['files'] = sequence.inventory(tree)
        sequence.dump(self.source.root / 'stages/A/controller/delivery.json', delivery)
        with self.assertRaisesRegex(ValueError, 'collides'):
            self.prepare()

    def test_prepare_requires_ended_delivered_source(self):
        state = sequence.load(self.source.root / 'sequence.json')
        state['status'] = 'running'
        sequence.dump(self.source.root / 'sequence.json', state)
        with self.assertRaisesRegex(ValueError, 'not ended'):
            self.prepare()

    def test_prepare_requires_cutoff_before_next_stage_preparation(self):
        with self.assertRaisesRegex(ValueError, 'leak later stages'):
            self.prepare(cutoff='2026-09-13T10:30:00Z')

    def test_run_refuses_without_authorization_then_runs_and_scores(self):
        self.prepare()
        with self.assertRaisesRegex(ValueError, 'authorization required'):
            rerun.run(self.out)
        self.assertEqual(self.marker_count(), 0)
        plan = rerun.authorize_root(self.out, 'unit test: fake driver only')
        self.assertTrue(plan['execution_authorized'])
        for record in plan['sessions']:
            self.assertTrue(sequence.load(Path(record['controller']) / 'request.json')['execution_authorized'])
        plan = rerun.run(self.out)
        self.assertEqual(plan['status'], 'ended')
        self.assertEqual([r['status'] for r in plan['sessions']], ['finished', 'finished'])
        self.assertEqual(self.marker_count(), 2)
        for record in plan['sessions']:
            root, ctl = Path(record['root']), Path(record['controller'])
            self.assertTrue((root / 'attempt.json').exists() and (root / 'session.json').exists())
            self.assertIn('fake driver finished', (ctl / 'driver.log').read_text())
            self.assertTrue((ctl / 'stage-result.json').exists() and (ctl / 'submission/tree/app.py').exists())
            self.assertTrue(record['delivered'] and record['timing_valid'])
        with self.assertRaisesRegex(ValueError, 'already attempted'):
            rerun.authorize_root(self.out, 'again')
        rerun_again = rerun.run(self.out)
        self.assertTrue(all(r.get('skipped') for r in rerun_again['sessions']))
        self.assertEqual(self.marker_count(), 2)
        report = rerun.score(self.out)
        self.assertTrue((self.out / 'report.json').exists() and (self.out / 'report.md').exists())
        control = report['arms']['fresh-agent']
        self.assertEqual((control['n'], control['get_receipt_id_omissions'], control['execute_state_omissions']), (2, 0, 0))
        self.assertEqual(control['historical_three_pass'], 2)
        self.assertEqual(control['checks_passed_over_applicable'], ['9/9', '9/9'])
        self.assertIsNone(report['comparison'])
        for item in report['sessions']:
            self.assertEqual(item['status'], 'scored')
            self.assertTrue(item['response_shape']['get_includes_receipt_id'])
            self.assertTrue(item['response_shape']['get_receipt_matches_provider'])
            self.assertFalse(item['get_omits_receipt_id'])
        self.assertIn('| fresh-agent | 2 | 2 | 2 | 0 | 0.00 |', (self.out / 'report.md').read_text())
        self.assertEqual(report['model_grading'], 'none')

    def test_run_refuses_tampered_frozen_input(self):
        self.prepare(authorize='unit test')
        (self.source.runtime / 'cli.js').write_text('// changed after freeze\n')
        plan = rerun.run(self.out)
        self.assertEqual({r['status'] for r in plan['sessions']}, {'failed'})
        self.assertTrue(all('frozen' in r['error'] for r in plan['sessions']))
        self.assertEqual(self.marker_count(), 0)

    def test_trim_sql_deletes_children_before_parents_and_reverts_late_confirmations(self):
        schema = {'cont_sessions': {'id', 'transcript_path', 'wip_ref'}, 'cont_events': {'id', 'session_id', 'received_at'},
                  'cont_threads': {'id', 'created_at', 'updated_at'}, 'cont_claims': {'thread_id', 'acquired_at'},
                  'cont_records': {'id', 'created_at', 'updated_at'},
                  'cont_state_updates': {'id', 'record_id', 'session_id', 'status', 'created_at', 'confirmed_at', 'confirmed_by', 'rejected_at', 'rejected_by', 'reject_reason'},
                  'cont_extra': {'id', 'session_id', 'created_at'}}
        sql = rerun.trim_sql(schema, '/roots/x/stages/A/home', CUTOFF)
        statements = [s.strip() for s in sql.split('\n') if s.strip()]
        self.assertEqual(statements[0], 'begin;')
        self.assertIn("transcript_path not like '/roots/x/stages/A/home/%'", statements[1])
        order = [i for i, s in enumerate(statements) if s.startswith('delete from')]
        names = [statements[i].split()[2] for i in order]
        self.assertLess(names.index('"cont_events"'), names.index('cont_sessions'))
        self.assertLess(names.index('"cont_extra"'), names.index('cont_sessions'))
        self.assertLess(names.index('cont_sessions'), names.index('"cont_threads"'))
        self.assertIn('delete from "cont_events" where session_id in (select id from rerun_removed_sessions) or received_at > ' + rerun.sql_quote(CUTOFF) + '::timestamptz;', statements)
        self.assertIn('delete from "cont_claims" where acquired_at > ' + rerun.sql_quote(CUTOFF) + '::timestamptz;', statements)
        self.assertIn("update cont_state_updates set status='proposed', confirmed_at=null, confirmed_by=null where confirmed_at > " + rerun.sql_quote(CUTOFF) + '::timestamptz;', statements)
        self.assertTrue(any(s.startswith('update "cont_records" set updated_at=least') for s in statements))
        self.assertEqual(statements[-1], 'commit;')
        with self.assertRaisesRegex(ValueError, 'transcript_path'):
            rerun.trim_sql({'cont_events': {'id'}}, '/x', CUTOFF)

    def test_copy_ledger_dir_drops_objects_after_cutoff_and_recounts_views(self):
        receipt = rerun.copy_ledger_dir(self.source.root / 'ledger', self.base / 'ledger-copy', CUTOFF)
        self.assertEqual(receipt['removed_objects'], ['dec-20260913-stage-b-mhqe'])
        self.assertEqual(receipt['kept_objects'], ['dec-20260913-stage-a-oaf9'])
        self.assertFalse((self.base / 'ledger-copy/decisions/dec-20260913-stage-b-mhqe.md').exists())
        self.assertTrue((self.source.root / 'ledger/decisions/dec-20260913-stage-b-mhqe.md').exists())
        for view in ('README.md', 'index.md', 'log.md', 'decisions/index.md'):
            self.assertNotIn('mhqe', (self.base / 'ledger-copy' / view).read_text())
        self.assertIn('1 decision in force', (self.base / 'ledger-copy/index.md').read_text())
        self.assertIn('0 definitions, 1 decision in force, 0 changes and 0 findings', (self.base / 'ledger-copy/README.md').read_text())

    def test_render_report_handles_missing_sessions(self):
        report = {'source_root': 'r', 'source_database': 'd', 'store_cutoff': CUTOFF, 'grader': 'g', 'model_grading': 'none', 'run_status': 'ended',
                  'driver_override': False, 'protocol': 'p', 'arms': {'ledger': {'sessions_prepared': 1, 'sessions_delivered': 0, 'n': 0,
                  'get_receipt_id_omissions': 0, 'get_receipt_id_omission_rate': None, 'execute_state_omissions': 0, 'historical_three_pass': 0, 'behavioral_pass': 0}},
                  'comparison': None, 'sessions': [{'session': 'ledger-01', 'arm': 'ledger', 'status': 'not_delivered'}],
                  'primary_outcome': 'x', 'secondary_outcome': 'y', 'historical_checks': list(rerun.HISTORICAL_CHECKS), 'limitations': ['l']}
        text = rerun.render_report(report)
        self.assertIn('| ledger | 1 | 0 | 0 | 0 | n/a |', text)
        self.assertIn('Comparison unavailable', text)


@unittest.skipUnless(postgres_available(), 'Postgres on 127.0.0.1:5432 unreachable')
class PostgresCloneTests(unittest.TestCase):
    def setUp(self):
        self.admin = admin_url()
        token = secrets.token_hex(4)
        self.template = 'ledger_eval_rerun_test_tpl_' + token
        self.clone_prefix = 'ledger_eval_rerun_test_clone_' + token + '_'
        self.created = []
        self.addCleanup(self.drop_all)
        rerun.psql(self.admin, 'create database ' + rerun.ident(self.template))
        self.created.append(self.template)
        self.tmp = tempfile.TemporaryDirectory(prefix='stage-b-rerun-pg-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.source = SyntheticSource(self.base, database_name=self.template)
        a_home, b_home = str(self.source.root / 'stages/A/home'), str(self.source.root / 'stages/B/home')
        q = rerun.sql_quote
        rows = MINI_SCHEMA + '\n'.join([
            "insert into cont_threads values('thrA','stage A','open'," + q(BEFORE) + ',' + q(AFTER) + ');',
            "insert into cont_threads values('thrB','stage B','open'," + q(AFTER) + ',' + q(AFTER) + ');',
            "insert into cont_sessions values('sessA','codex'," + q(a_home) + ',' + q(a_home + '/.codex/sessions/rollout-a.jsonl') + ",'thrA','refs/wip/benchmark-a/sessA'," + q(self.source.a_commit) + ',' + q(BEFORE) + ');',
            "insert into cont_sessions values('sessB','codex'," + q(b_home) + ',' + q(b_home + '/.codex/sessions/rollout-b.jsonl') + ",'thrB','refs/wip/benchmark-b/sessB'," + q(self.source.b_commit) + ',null);',
            "insert into cont_sessions values('synthetic','claude',null,null,null,null,null,null);",
            "insert into cont_events(session_id,seq,kind,occurred_at,received_at) values('sessA',1,'session.started'," + q(BEFORE) + ',' + q(BEFORE) + ');',
            "insert into cont_events(session_id,seq,kind,occurred_at,received_at) values('sessA',2,'tool'," + q(BEFORE) + ',' + q(BEFORE) + ');',
            "insert into cont_events(session_id,seq,kind,occurred_at,received_at) values('sessB',1,'session.started'," + q(AFTER) + ',' + q(AFTER) + ');',
            "insert into cont_checkpoints values('ckA','thrA','sessA'," + q(BEFORE) + ');',
            "insert into cont_checkpoints values('ckB','thrB','sessB'," + q(AFTER) + ');',
            "insert into cont_claims values('thrA','mcp:benchmark-b:1','benchmark-b'," + q(AFTER) + ');',
            "insert into cont_artifacts values('artA','sessA','aa'," + q(BEFORE) + ');',
            "insert into cont_artifacts values('artB','sessB','bb'," + q(AFTER) + ');',
            "insert into cont_records values('recA','Stage A record','open',3," + q(BEFORE) + ',' + q(AFTER) + ');',
            "insert into cont_records values('recC','Stage C record','open',1," + q(AFTER) + ',' + q(AFTER) + ');',
            "insert into cont_record_links values('lnkA','recA','sessA'," + q(BEFORE) + ');',
            "insert into cont_record_links values('lnkB','recA','sessB'," + q(AFTER) + ');',
            "insert into cont_state_updates values('updA','recA',null,'confirmed','A progress','benchmark-a'," + q(BEFORE) + ",'benchmark-a'," + q(BEFORE) + ',null,null,null);',
            "insert into cont_state_updates values('updA2','recA',null,'confirmed','classifier proposal','classifier'," + q(BEFORE) + ",'benchmark-b'," + q(AFTER) + ',null,null,null);',
            "insert into cont_state_updates values('updB','recA','sessB','proposed','B progress','benchmark-b'," + q(AFTER) + ',null,null,null,null,null);'])
        self.template_url = rerun.database_url(self.admin, self.template)
        rerun.psql(self.template_url, rows, script=True)
        self.snapshot_before = rerun.table_counts(self.template_url, sorted(rerun.introspect(self.template_url)))
        tools = self.base / 'tools'
        tools.mkdir()
        (tools / 'control_app.py').write_text(REFERENCE)
        (tools / 'ledger_app.py').write_text(GET_OMITS_RECEIPT)
        self.driver = tools / 'fake-driver.py'
        self.driver.write_text(FAKE_DRIVER)
        sequence.dump(tools / 'fake-driver-config.json', {'control_app': str(tools / 'control_app.py'), 'ledger_app': str(tools / 'ledger_app.py')})
        self.stage_script = tools / 'fake-stage.py'
        self.stage_script.write_text(FAKE_STAGE_PROFILE)
        self.out = self.base / 'rerun'

    def drop_all(self):
        for name in reversed(self.created):
            try:
                rerun.drop_database(self.admin, name)
            except RuntimeError:
                pass

    def namer(self, index):
        name = self.clone_prefix + str(index)
        self.created.append(name)
        return name

    def test_per_session_clone_is_distinct_trimmed_and_source_untouched(self):
        plan = rerun.prepare(self.source.root, self.out, 1, ('ledger', 'fresh-agent'), 'unit test: fake driver and fake stage profile',
                             driver_argv=[sys.executable, str(self.driver), 'run', '{request}'], db_namer=self.namer)
        self.assertEqual(plan['order'], ['ledger-01', 'fresh-agent-01'])
        ledger = next(r for r in plan['sessions'] if r['arm'] == 'ledger')
        clone = ledger['database']
        self.assertNotEqual(clone, self.template)
        self.assertTrue(clone.startswith('ledger_eval_rerun_test_clone_'))
        self.assertTrue(rerun.database_exists(self.admin, clone))
        self.assertTrue(rerun.database_exists(self.admin, self.template))
        # Source store untouched: identical row counts and the later-stage rows still present.
        self.assertEqual(rerun.table_counts(self.template_url, sorted(self.snapshot_before)), self.snapshot_before)
        self.assertEqual(rerun.psql(self.template_url, "select count(*) from cont_sessions where id='sessB'").strip(), '1')
        self.assertEqual(rerun.psql(self.admin, "select shobj_description(oid,'pg_database') from pg_database where datname=" + rerun.sql_quote(self.template)).strip(), '')
        # Clone trimmed to A at the cutoff.
        clone_url = ledger['database_url']
        self.assertEqual(clone_url, rerun.database_url(self.admin, clone))
        self.assertEqual(rerun.psql(clone_url, 'select id from cont_sessions order by id').split(), ['sessA'])
        self.assertEqual(rerun.psql(clone_url, 'select id from cont_threads order by id').split(), ['thrA'])
        self.assertEqual(rerun.psql(clone_url, 'select id from cont_records order by id').split(), ['recA'])
        self.assertEqual(rerun.psql(clone_url, 'select count(*) from cont_events').strip(), '2')
        self.assertEqual(rerun.psql(clone_url, 'select count(*) from cont_claims').strip(), '0')
        self.assertEqual(rerun.psql(clone_url, 'select id from cont_artifacts').split(), ['artA'])
        self.assertEqual(rerun.psql(clone_url, 'select id from cont_record_links').split(), ['lnkA'])
        self.assertEqual(rerun.psql(clone_url, "select id||':'||status from cont_state_updates order by id").split(), ['updA:confirmed', 'updA2:proposed'])
        self.assertEqual(rerun.psql(clone_url, "select confirmed_by is null from cont_state_updates where id='updA2'").strip(), 't')
        self.assertEqual(rerun.psql(clone_url, "select updated_at <= " + rerun.sql_quote(CUTOFF) + "::timestamptz from cont_records where id='recA'").strip(), 't')
        owner = sequence.load(Path(ledger['root']) / 'ledger-native-owner.json')
        self.assertEqual(rerun.psql(self.admin, "select shobj_description(oid,'pg_database') from pg_database where datname=" + rerun.sql_quote(clone)).strip(), owner['nonce'])
        self.assertNotEqual(owner['nonce'], self.source.nonce)
        self.assertEqual(owner['databaseName'], clone)
        self.assertEqual(owner['trialDir'], ledger['root'])
        self.assertEqual([s['role'] for s in owner['stages']], ['stage-A'])
        self.assertEqual(owner['latestSnapshot']['commit'], self.source.a_commit)
        trim = sequence.load(Path(ledger['root']) / 'store-trim-receipt.json')
        self.assertEqual(trim['kept_sessions'], ['sessA'])
        self.assertEqual(trim['rows_before']['cont_sessions'], 3)
        self.assertEqual(trim['rows_after']['cont_sessions'], 1)
        state = sequence.load(Path(ledger['root']) / 'native-state.json')
        self.assertEqual((state['database_name'], state['stages']), (clone, ['A']))
        self.assertTrue((Path(ledger['root']) / 'external-operations').is_dir())
        self.assertFalse((Path(ledger['root']) / 'external-operations/events.jsonl').exists())
        # Remote trimmed to A's WIP ref; source remote keeps both.
        remote = sequence.load(Path(ledger['root']) / 'remote-trim-receipt.json')
        self.assertEqual((remote['kept_refs'], remote['removed_refs']), (['refs/wip/benchmark-a/sessA'], ['refs/wip/benchmark-b/sessB']))
        refs = subprocess.run(['git', '--git-dir=' + ledger['remote'], 'for-each-ref', '--format=%(refname)'], check=True, capture_output=True, text=True).stdout.split()
        self.assertEqual(refs, ['refs/wip/benchmark-a/sessA'])
        source_refs = subprocess.run(['git', '--git-dir=' + str(self.source.root / 'ledger-native-origin.git'), 'for-each-ref', '--format=%(refname)'], check=True, capture_output=True, text=True).stdout.split()
        self.assertEqual(len(source_refs), 2)
        self.assertFalse((Path(ledger['root']) / 'ledger/decisions/dec-20260913-stage-b-mhqe.md').exists())
        config = sequence.load(Path(ledger['root']) / 'native-config.json')
        self.assertEqual(config['root'], ledger['root'])
        self.assertNotIn(str(self.source.root), json.dumps(config))
        # Run both sessions through the fake driver and fake stage profile, then score.
        result = rerun.run(self.out, stage_profile_argv=[sys.executable, str(self.stage_script), 'stage', '{request}'])
        self.assertEqual([r['status'] for r in result['sessions']], ['finished', 'finished'], result['sessions'])
        self.assertTrue(result['driver_override'])
        profile = sequence.load(Path(ledger['controller']) / 'native-profile.json')
        self.assertIn(clone, profile['mcp']['ledger']['env']['LEDGER_CONTINUITY_DB'])
        report = rerun.score(self.out)
        self.assertEqual((report['arms']['ledger']['n'], report['arms']['ledger']['get_receipt_id_omissions']), (1, 1))
        self.assertEqual((report['arms']['fresh-agent']['n'], report['arms']['fresh-agent']['get_receipt_id_omissions']), (1, 0))
        self.assertEqual(report['arms']['ledger']['historical_three_pass'], 0)
        self.assertEqual(report['arms']['fresh-agent']['historical_three_pass'], 1)
        self.assertEqual(report['comparison']['ledger_minus_control_omissions'], 1)
        self.assertTrue(report['comparison']['within_one_session_of_each_other'])
        ledger_item = next(s for s in report['sessions'] if s['arm'] == 'ledger')
        self.assertTrue(ledger_item['get_omits_receipt_id'])
        self.assertFalse(ledger_item['execute_omits_state'])
        self.assertEqual(set(ledger_item['critical_errors']), set(rerun.HISTORICAL_CHECKS))
        self.assertIn('DRIVER OVERRIDE', (self.out / 'report.md').read_text())
        # The source store is still untouched after run/score.
        self.assertEqual(rerun.table_counts(self.template_url, sorted(self.snapshot_before)), self.snapshot_before)

    def test_run_rejects_profile_pointing_at_source_store(self):
        plan = rerun.prepare(self.source.root, self.out, 1, ('ledger',), 'unit test', driver_argv=[sys.executable, str(self.driver), 'run', '{request}'], db_namer=self.namer)
        bad = self.base / 'tools' / 'bad-stage.py'
        bad.write_text(FAKE_STAGE_PROFILE.replace("owner['databaseUrl']", repr(rerun.database_url(self.admin, self.template))))
        result = rerun.run(self.out, stage_profile_argv=[sys.executable, str(bad), 'stage', '{request}'])
        self.assertEqual(result['sessions'][0]['status'], 'failed')
        self.assertIn('frozen source store', result['sessions'][0]['error'])
        self.assertFalse((Path(plan['sessions'][0]['controller']) / 'fake-driver-ran').exists())


if __name__ == '__main__':
    unittest.main()
