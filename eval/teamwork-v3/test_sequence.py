"""Controller-only transport tests; no model or provider calls."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sequence_v3', Path(__file__).with_name('sequence.py'))
sequence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sequence)


class TransportTests(unittest.TestCase):
    def setUp(self):
        disk_patch = patch.object(sequence.shutil, 'disk_usage', return_value=SimpleNamespace(free=10 * sequence.GIB))
        self.disk_usage = disk_patch.start()
        self.addCleanup(disk_patch.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        registry = patch("disk_budget.REGISTRY_DIR", self.base / "disk-registry")
        registry.start(); self.addCleanup(registry.stop)
        self.pack = self.base / 'pack'
        (self.pack / 'initial').mkdir(parents=True)
        (self.pack / 'initial' / 'app.py').write_text('# common starter\n')
        (self.pack / 'controller').mkdir()
        (self.pack / 'controller' / 'hidden.json').write_text('{"answer":"never release"}')
        stages = []
        for name in 'ABC':
            (self.pack / 'delta' / name).mkdir(parents=True)
            (self.pack / 'delta' / name / 'task.txt').write_text('delta ' + name)
            (self.pack / ('prompt-' + name + '.txt')).write_text('Perform stage ' + name)
            stages.append({'id': name, 'delta_dir': 'delta/' + name,
                           'prompt_file': 'prompt-' + name + '.txt', 'deadline_ms': 1000})
        self.manifest = {'schema': 'teamwork-pack/v3', 'track': 'pm', 'arms': ['fresh-agent', 'ledger'],
                         'initial_repo_dir': 'initial', 'stages': stages}
        self.freeze_pack()
        self.root = self.base / 'sequence'

    def freeze_pack(self):
        self.manifest['files'] = sequence.inventory(self.pack, exclude_root={'manifest.json'})
        sequence.dump(self.pack / 'manifest.json', self.manifest)

    def prepare(self, arm='fresh-agent'):
        return sequence.prepare(self.pack, self.root, 'pm', arm)

    def controller(self, stage):
        return self.root / 'stages' / stage / 'controller'

    def work(self, stage):
        return self.root / 'stages' / stage / 'worktree'

    def release(self, stage):
        return sequence.stage_workspace(self.pack, next(s for s in self.manifest['stages'] if s['id'] == stage),
                                        self.work(stage), self.controller(stage))

    def launch(self):
        driver = self.base / 'fake-driver.py'
        driver.write_text('# test stand-in; never executed\n')
        budget = self.base / 'shared-budget.json'
        budget.write_text('{"maximum_usd":30}')
        profiles = {}
        for name in 'ABC':
            profile = self.base / (name + '-profile.json')
            sequence.dump(profile, {'arm': 'fresh-agent', 'readiness_verified': True, 'paid_paths_gated': True})
            profiles[name] = str(profile)
        cfg = {'execution_authorized': True, 'authorization': 'controller unit test only', 'paid_paths_gated': True,
               'maximum_approved_usd': 30, 'budget_file': str(budget), 'runtime': str(self.base),
               'model': 'fixed-test-model', 'reasoning_effort': 'medium', 'capture_timeout_ms': 1000,
               'driver_argv': [sys.executable, str(driver), '{request}'],
               'frozen_files': {str(driver): sequence.digest(driver)}, 'stage_profiles': profiles,
               'capture_argv': {name: ['test-capture', '{request}'] for name in 'ABC'}}
        cfg['disk_plan']={'schema':'teamwork-disk-plan/v3','sequences':[{'root':str(self.root),'arm':sequence.load(self.root/'sequence.json')['arm'],'track':'pm','filesystem_path':str(self.root),'retained_output_bytes':256*1024**2,'peak_working_capture_bytes':64*1024**2,'basis':'test estimate'}],'shared':[{'filesystem_path':str(self.root),'overhead_bytes':0,'margin_bytes':1024**3,'basis':'test margin'}]}
        launch = self.base / 'launch.json'
        sequence.dump(launch, cfg)
        return launch, cfg

    def fake_driver(self, argv, cwd, limit, output):
        if argv[0] == 'test-capture':
            return {'exit_code': 0, 'timed_out': False, 'timing_valid': True, 'elapsed_seconds': 0}
        req = sequence.load(argv[-1])
        work, ctl = Path(req['workspace']), Path(req['controller_output_dir'])
        # A derived artifact must not be present when the next driver starts.
        self.assertFalse((work / 'prior-derived.txt').exists())
        self.assertEqual((work / 'app.py').read_text(), '# common starter\n')
        self.assertEqual((work / 'task.txt').read_text(), 'delta ' + req['stage'])
        self.assertEqual(sequence.git(work, 'rev-list', '--count', 'HEAD'), '1')
        self.assertTrue(req['snapshot_all_tracks'])
        self.assertIn(str(self.pack), req['forbidden_paths'])
        (work / 'prior-derived.txt').write_text('producer secret ' + req['stage'])
        (work / 'app.py').write_text('producer implementation ' + req['stage'])
        (ctl / 'submission').mkdir()
        shutil.copytree(work, ctl / 'submission/tree', ignore=shutil.ignore_patterns('.git'))
        answer = ctl / 'submission/answer.json'
        sequence.dump(answer, {'complete': True})
        sequence.dump(ctl / 'delivery.json', {'elapsed_ms': 50, 'answer_file_sha256': sequence.digest(answer),
                                            'tree': {'files': sequence.inventory(ctl / 'submission/tree')}})
        sequence.dump(ctl / 'stage-result.json', {'timing_valid': True, 'delivered': True})
        return {'exit_code': 0, 'timed_out': False, 'timing_valid': True, 'elapsed_seconds': 0}

    def test_prepare_releases_no_inputs(self):
        self.prepare()
        for name in 'ABC':
            self.assertEqual(list(self.work(name).iterdir()), [])
            self.assertEqual(list(self.controller(name).iterdir()), [])

    def test_successor_gets_baseline_delta_only_and_fresh_history(self):
        self.prepare()
        self.release('A')
        (self.work('A') / 'prior-analysis.md').write_text('do not transfer')
        (self.work('A') / 'app.py').write_text('completed implementation')
        sequence.git(self.work('A'), 'add', '-A')
        sequence.git(self.work('A'), '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Prior work')
        receipt = self.release('B')
        self.assertEqual(receipt['initial_git_commit_count'], 1)
        self.assertEqual(set(receipt['released_files']), {'app.py', 'task.txt'})
        self.assertEqual((self.work('B') / 'app.py').read_text(), '# common starter\n')
        self.assertFalse((self.work('B') / 'prior-analysis.md').exists())
        self.assertFalse((self.work('B') / 'controller').exists())
        self.assertEqual((self.work('B') / 'task.txt').read_text(), 'delta B')
        self.assertEqual(list(self.work('C').iterdir()), [])

    def test_reused_workspace_rejected(self):
        self.prepare()
        self.release('A')
        with self.assertRaisesRegex(ValueError, 'empty'):
            self.release('A')

    def test_pack_tamper_rejected(self):
        self.prepare()
        (self.pack / 'delta/B/task.txt').write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'inventory changed'):
            self.release('B')

    def test_pack_symlink_rejected(self):
        (self.pack / 'initial/escape').symlink_to(self.base)
        with self.assertRaisesRegex(ValueError, 'symlinks'):
            sequence.validate_pack(self.pack)

    def test_delta_cannot_replace_baseline(self):
        (self.pack / 'delta/B/app.py').write_text('overwritten')
        self.freeze_pack()
        with self.assertRaisesRegex(ValueError, 'collides'):
            self.prepare()

    def test_delta_cannot_hide_git_or_credentials(self):
        (self.pack / 'delta/B/.git').mkdir()
        self.freeze_pack()
        with self.assertRaisesRegex(ValueError, 'reserved'):
            self.prepare()

    def test_traversal_and_duplicate_stage_rejected(self):
        self.manifest['stages'][1]['delta_dir'] = '../outside'
        self.freeze_pack()
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            self.prepare()
        self.manifest['stages'][1]['delta_dir'] = 'delta/B'
        self.manifest['stages'][1]['id'] = 'A'
        self.freeze_pack()
        with self.assertRaisesRegex(ValueError, 'unique'):
            self.prepare()

    def test_native_stores_allowed_broad_or_prior_grants_rejected(self):
        self.prepare('ledger')
        store = self.root / 'native-store'
        store.mkdir()
        gate = self.base / 'gate.mjs'
        gate.write_text('export const permitNativeCall = () => null;')
        profile = {'arm': 'ledger', 'readiness_verified': True, 'paid_paths_gated': True,
                   'budget_gate_module': str(gate), 'budget_file': str(self.base / 'budget.json'),
                   'read_paths': [str(store)], 'write_paths': [str(store)]}
        protected = [self.pack, self.controller('B'), self.root / 'stages/A']
        sequence.validate_profile(profile, {'arm': 'ledger'}, protected)
        for bad in [self.root, self.work('A'), self.pack, self.base]:
            profile['read_paths'] = [str(bad)]
            with self.assertRaisesRegex(ValueError, 'private/previous'):
                sequence.validate_profile(profile, {'arm': 'ledger'}, protected)

    def test_pm_requires_artifact_snapshot_and_hashes(self):
        self.prepare()
        ctl = self.controller('A')
        (ctl / 'submission').mkdir()
        sequence.dump(ctl / 'submission/answer.json', {'answer': 'yes'})
        sequence.dump(ctl / 'delivery.json', {'elapsed_ms': 10, 'answer_file_sha256': sequence.digest(ctl / 'submission/answer.json'), 'tree': None})
        with self.assertRaisesRegex(ValueError, 'tree'):
            sequence.verify_submission(ctl, 1000, 'pm')
        (ctl / 'submission/tree').mkdir()
        receipt = sequence.load(ctl / 'delivery.json')
        receipt['tree'] = {'files': {}}
        sequence.dump(ctl / 'delivery.json', receipt)
        self.assertTrue(sequence.verify_submission(ctl, 1000, 'pm'))
        (ctl / 'submission/tree/added').write_text('late')
        with self.assertRaisesRegex(ValueError, 'tree'):
            sequence.verify_submission(ctl, 1000, 'pm')

    def test_full_controller_never_supplies_previous_derived_work(self):
        self.prepare()
        launch, _ = self.launch()
        with patch.object(sequence, 'run_command', side_effect=self.fake_driver):
            state = sequence.run(self.root, launch)
        self.assertEqual([x['status'] for x in state['stages'].values()], ['finished'] * 3)
        self.assertTrue(all(x['delivered'] for x in state['stages'].values()))
        with self.assertRaisesRegex(ValueError, 'already attempted'):
            sequence.run(self.root, launch)

    def test_development_labels_are_unscored_without_relaxing_readiness(self):
        self.manifest['development'] = True
        self.freeze_pack()
        prepared = self.prepare()
        self.assertTrue(prepared['development'])
        launch, cfg = self.launch()
        profile = sequence.load(cfg['stage_profiles']['B'])
        profile['readiness_verified'] = False
        sequence.dump(cfg['stage_profiles']['B'], profile)
        with patch.object(sequence, 'run_command', side_effect=self.fake_driver):
            state = sequence.run(self.root, launch)
        self.assertTrue(state['development'])
        self.assertEqual(state['stages']['B']['status'], 'failed')
        self.assertIn('readiness', state['stages']['B']['error'])
        for stage in 'ABC':
            request = sequence.load(self.controller(stage) / 'request.json')
            self.assertTrue(request['development_probe'])
            self.assertFalse(request['scored'])

    def test_primary_labels_stay_scored(self):
        prepared = self.prepare()
        self.assertFalse(prepared['development'])
        launch, _ = self.launch()
        with patch.object(sequence, 'run_command', side_effect=self.fake_driver):
            sequence.run(self.root, launch)
        for stage in 'ABC':
            request = sequence.load(self.controller(stage) / 'request.json')
            self.assertFalse(request['development_probe'])
            self.assertTrue(request['scored'])

    def test_native_preparation_cannot_preload_recovery(self):
        self.prepare()
        launch, cfg = self.launch()
        cfg['stage_profile_argv'] = ['test-prepare', '{request}']
        sequence.dump(launch, cfg)
        def preload(argv, *args):
            req = sequence.load(argv[-1])
            (Path(req['workspace']) / 'restored-without-agent.txt').write_text('hidden shortcut')
            return {'exit_code': 0, 'timed_out': False, 'timing_valid': True}
        with patch.object(sequence, 'run_command', side_effect=preload) as calls:
            state = sequence.run(self.root, launch)
        self.assertEqual(calls.call_count, 3)
        self.assertTrue(all('recovery must be agent initiated' in x['error'] for x in state['stages'].values()))

    def test_capture_cannot_rewrite_immutable_output(self):
        self.prepare()
        launch, _ = self.launch()
        def capture_mutation(argv, *args):
            if argv[0] == 'test-capture':
                req = sequence.load(argv[-1])
                (Path(req['controller_output_dir']) / 'submission/answer.json').write_text('{}')
                return {'exit_code': 0, 'timed_out': False, 'timing_valid': True}
            return self.fake_driver(argv, *args)
        with patch.object(sequence, 'run_command', side_effect=capture_mutation):
            state = sequence.run(self.root, launch)
        self.assertTrue(all(x['status'] == 'failed' and 'answer changed' in x['error'] for x in state['stages'].values()))

    def test_freeze_changed_before_dispatch_leaves_unattempted(self):
        self.prepare()
        launch, cfg = self.launch()
        Path(cfg['driver_argv'][1]).write_text('changed')
        with self.assertRaisesRegex(ValueError, 'frozen'):
            sequence.run(self.root, launch)
        self.assertFalse((self.root / 'attempt.json').exists())

    def test_unbound_driver_rejected(self):
        self.prepare()
        launch, cfg = self.launch()
        replacement = self.base / 'replacement.py'
        replacement.write_text('# changed driver')
        cfg['driver_argv'][1] = str(replacement)
        sequence.dump(launch, cfg)
        with self.assertRaisesRegex(ValueError, 'missing from frozen_files'):
            sequence.run(self.root, launch)
        self.assertFalse((self.root / 'attempt.json').exists())

    def test_timeout_cleans_detached_descendant(self):
        script = self.base / 'parent.py'
        pidfile = self.base / 'child.pid'
        script.write_text('import subprocess,sys,time,pathlib\n'
                          'p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"],start_new_session=True)\n'
                          'pathlib.Path(sys.argv[1]).write_text(str(p.pid))\n'
                          'time.sleep(60)\n')
        result = sequence.run_command([sys.executable, str(script), str(pidfile)], self.base, 0.4, self.base / 'timeout.log')
        self.assertTrue(result['timed_out'])
        self.assertTrue(pidfile.exists())
        child = int(pidfile.read_text())
        status = subprocess.run(['ps', '-p', str(child), '-o', 'stat='], capture_output=True, text=True).stdout.strip()
        if status and not status.startswith('Z'):
            os.kill(child, 9)
            self.fail('detached child survived timeout: ' + status)

    def test_disk_admission_rejects_before_attempt_or_dispatch(self):
        self.prepare()
        launch, _ = self.launch()
        self.disk_usage.return_value = SimpleNamespace(free=sequence.SEQUENCE_MIN_FREE_BYTES - 1)
        with patch.object(sequence, 'run_command') as dispatch:
            with self.assertRaisesRegex(sequence.DiskSpaceError, 'sequence admission'):
                sequence.run(self.root, launch)
        dispatch.assert_not_called()
        self.assertFalse((self.root / 'attempt.json').exists())
        self.assertFalse(sequence.load(self.root / 'sequence.json')['executed'])

    def test_runtime_disk_abort_skips_capture_successors_and_export(self):
        self.prepare()
        launch, cfg = self.launch()
        cfg['export_argv'] = ['test-export']
        sequence.dump(launch, cfg)
        error = sequence.DiskSpaceError({'phase': 'subprocess runtime', 'free_bytes': 123,
                                         'required_bytes': sequence.RUNTIME_MIN_FREE_BYTES,
                                         'process': {'owned_tree_terminated': True}})
        with patch.object(sequence, 'run_command', side_effect=error) as dispatch:
            state = sequence.run(self.root, launch)
        self.assertEqual(dispatch.call_count, 1)
        self.assertEqual(state['status'], 'infrastructure_aborted')
        self.assertEqual(list(state['stages']), ['A'])
        self.assertNotIn('capture', state['stages']['A'])
        self.assertNotIn('export', state)
        self.assertFalse((self.controller('B') / 'request.json').exists())
        self.assertTrue((self.root / 'attempt.json').exists())
        with self.assertRaisesRegex(ValueError, 'already attempted'):
            sequence.run(self.root, launch)

    def test_disk_low_water_cleans_real_detached_descendant(self):
        script = self.base / 'parent.py'
        pidfile = self.base / 'child.pid'
        script.write_text('import subprocess,sys,time,pathlib\n'
                          'p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"],start_new_session=True)\n'
                          'pathlib.Path(sys.argv[1]).write_text(str(p.pid))\n'
                          'time.sleep(60)\n')
        self.disk_usage.side_effect = lambda _: SimpleNamespace(
            free=sequence.RUNTIME_MIN_FREE_BYTES - 1 if pidfile.exists() else 10 * sequence.GIB)
        started = time.monotonic()
        with patch.object(sequence, 'DISK_POLL_SECONDS', 0.05):
            with self.assertRaises(sequence.DiskSpaceError) as raised:
                sequence.run_command([sys.executable, str(script), str(pidfile)], self.base, 60, self.base / 'low-water.log')
        self.assertLess(time.monotonic() - started, 5)
        self.assertTrue(raised.exception.receipt['process']['owned_tree_terminated'])
        self.assertTrue(pidfile.exists())
        child = int(pidfile.read_text())
        status = subprocess.run(['ps', '-p', str(child), '-o', 'stat='], capture_output=True, text=True).stdout.strip()
        if status and not status.startswith('Z'):
            os.kill(child, 9)
            self.fail('detached child survived disk abort: ' + status)

    def test_disk_guard_refuses_subprocess_before_opening_log(self):
        self.disk_usage.return_value = SimpleNamespace(free=sequence.RUNTIME_MIN_FREE_BYTES - 1)
        log = self.base / 'not-created.log'
        with patch.object(sequence.subprocess, 'Popen') as spawn:
            with self.assertRaises(sequence.DiskSpaceError):
                sequence.run_command([sys.executable, '-c', 'raise RuntimeError()'], self.base, 1, log)
        spawn.assert_not_called()
        self.assertFalse(log.exists())


if __name__ == '__main__':
    unittest.main()
