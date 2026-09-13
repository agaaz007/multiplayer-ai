import json
from pathlib import Path
import tempfile
import threading
import unittest

from fixtures import ARMS, build, dump
from sequence import prepare
from matrix import preflight, run


class MatrixTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.pack = self.root / 'pack'; build(self.pack, 73)
        self.budget = self.root / 'budget.json'; dump(self.budget, {'limit_usd': 30})
        self.runtime = self.root / 'runtime'; self.runtime.mkdir()
        self.config = self.root / 'matrix.json'
        self.lanes = []
        for arm in ARMS:
            entries = []
            for track in ('engineering', 'pm'):
                root = self.root / (arm + '-' + track)
                prepare(self.pack, root, track, arm)
                profile = root / 'native-profile.json'; dump(profile, {})
                launch = root / 'launch.json'
                dump(launch, {'execution_authorized': True, 'authorization': 'test-only fake runner',
                    'paid_paths_gated': True, 'maximum_approved_usd': 30, 'budget_file': str(self.budget),
                    'runtime': str(self.runtime), 'model': 'fixed-model', 'reasoning_effort': 'medium',
                    'stage_deadline_ms': 1200000 if track == 'engineering' else 600000,
                    'capture_timeout_ms': 30000, 'stage_profiles': {stage: str(profile) for stage in 'ABCD'}})
                entries.append({'root': str(root), 'launch': str(launch)})
            self.lanes.append({'arm': arm, 'sequences': entries})
        self.save()

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        dump(self.config, {'schema': 'teamwork-matrix/v2', 'max_workers': 6, 'arms': self.lanes})

    def change_launch(self, arm_index, track_index, **changes):
        path = self.lanes[arm_index]['sequences'][track_index]['launch']
        cfg = json.loads(Path(path).read_text()); cfg.update(changes); dump(path, cfg)

    def test_parallel_lanes_keep_engineering_then_pm_and_stage_order(self):
        barrier = threading.Barrier(6)
        lock = threading.Lock(); events = {arm: [] for arm in ARMS}
        def fake(root, launch):
            state = json.loads((Path(root) / 'sequence.json').read_text())
            if state['track'] == 'engineering': barrier.wait(timeout=5)
            for stage in 'ABCD':
                with lock: events[state['arm']].append((state['track'], stage))
            return {'status': 'ended', 'stages': {stage: {'status': 'finished'} for stage in 'ABCD'}}
        result = run(self.config, self.root / 'output', fake)
        self.assertEqual(result['status'], 'ended')
        expected = [(track, stage) for track in ('engineering', 'pm') for stage in 'ABCD']
        for arm in ARMS:
            self.assertEqual(events[arm], expected)
            self.assertEqual(result['arms'][arm]['status'], 'finished')
        self.assertEqual(json.loads((self.root / 'output/status.json').read_text()), result)

    def test_preflight_mismatch_prevents_any_dispatch(self):
        self.change_launch(5, 1, model='different-model')
        calls = []
        with self.assertRaisesRegex(ValueError, 'mismatched'):
            run(self.config, self.root / 'output', lambda *args: calls.append(args))
        self.assertEqual(calls, [])
        self.assertFalse((self.root / 'output').exists())

    def test_shared_budget_and_limits_cannot_diverge(self):
        other = self.root / 'other-budget.json'; dump(other, {})
        self.change_launch(2, 0, budget_file=str(other))
        with self.assertRaisesRegex(ValueError, 'canonical budget'): preflight(self.config)
        self.change_launch(2, 0, budget_file=str(self.budget), stage_deadline_ms=3)
        with self.assertRaisesRegex(ValueError, 'mismatched'): preflight(self.config)

    def test_unavailable_arm_remains_visible_and_failure_does_not_stop_others(self):
        self.lanes[2] = {'arm': 'mem0', 'status': 'unavailable', 'reason': 'native readiness not established'}
        self.save(); calls = []
        def fake(root, launch):
            calls.append(root)
            if Path(root).name == 'ledger-engineering': raise RuntimeError('retained failure')
            return {'status': 'ended', 'stages': {}}
        result = run(self.config, self.root / 'output', fake)
        self.assertEqual(len(calls), 10)
        self.assertEqual(result['arms']['mem0']['status'], 'unavailable')
        self.assertEqual(result['arms']['ledger']['status'], 'finished_with_failures')
        self.assertEqual(result['arms']['ledger']['sequences']['pm']['status'], 'finished')
        self.assertEqual(result['arms']['graphify']['status'], 'finished')
        self.assertEqual(sum(Path(path).name == 'ledger-engineering' for path in calls), 1)

    def test_executed_duplicate_missing_arm_and_unauthorized_rejected(self):
        state_path = Path(self.lanes[0]['sequences'][0]['root']) / 'sequence.json'
        state = json.loads(state_path.read_text()); state['executed'] = True; dump(state_path, state)
        with self.assertRaisesRegex(ValueError, 'already attempted'): preflight(self.config)
        state['executed'] = False; dump(state_path, state)
        self.change_launch(0, 0, execution_authorized=False)
        with self.assertRaisesRegex(ValueError, 'authorization'): preflight(self.config)
        self.change_launch(0, 0, execution_authorized=True)
        original = self.lanes[1]['sequences'][0]
        self.lanes[1]['sequences'][0] = self.lanes[0]['sequences'][0]; self.save()
        with self.assertRaisesRegex(ValueError, 'duplicate sequence root'): preflight(self.config)
        self.lanes[1]['sequences'][0] = original
        self.lanes.pop(); self.save()
        with self.assertRaisesRegex(ValueError, 'all six arms'): preflight(self.config)

    def test_reversed_config_tracks_are_dispatched_in_canonical_order(self):
        self.lanes[0]['sequences'].reverse(); self.save()
        self.assertEqual([item['track'] for item in preflight(self.config)['arms'][0]['sequences']], ['engineering', 'pm'])

    def test_different_frozen_pack_is_rejected(self):
        other = self.root / 'other-pack'; build(other, 109)
        from matrix import digest
        state_path = Path(self.lanes[5]['sequences'][1]['root']) / 'sequence.json'
        state = json.loads(state_path.read_text()); state.update(pack=str(other), pack_manifest_sha256=digest(other / 'manifest.json'))
        dump(state_path, state)
        with self.assertRaisesRegex(ValueError, 'mismatched'): preflight(self.config)

    def test_second_dispatch_cannot_overwrite_status(self):
        output = self.root / 'output'; output.mkdir()
        with self.assertRaises(FileExistsError): run(self.config, output, lambda *args: {})


if __name__ == '__main__':
    unittest.main()
