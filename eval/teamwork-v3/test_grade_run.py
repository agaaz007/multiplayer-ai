import copy
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
def module(name, file):
    s = importlib.util.spec_from_file_location(name, file)
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
run = module('grade_run_tests', HERE / 'grade-run.py')
fixtures = module('recovery_fixtures_tests', HERE / 'fixtures.py')

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True); path.write_text(json.dumps(value))

def receipt(root, schema):
    files, size = run.recovery.tree_manifest(root)
    return {'schema': schema, 'elapsed_ms': 100,
            'tree': {'files': files, 'bytes': size,
                     'sha256': run.recovery.digest(json.dumps(files, separators=(',', ':')).encode())}}


class RunGrading(unittest.TestCase):
    def test_default_scored_report_rejects_partial_cohort_before_writing(self):
        with self.assertRaisesRegex(ValueError, 'complete four-product'):
            run.grade_run([{'root': str(self.seq)}], self.root / 'out', self.fake_functional)
        self.assertFalse((self.root / 'out').exists())

    def test_all_four_products_and_two_tracks_required(self):
        pm_pack = self.root / 'pm-pack'; fixtures.build(pm_pack, 'pm', seed=271)
        entries = []
        for track in ('pm', 'engineering'):
            for arm in ('ledger', 'graphify', 'gbrain', 'supermemory'):
                root = self.root / (track + '-' + arm)
                state = run.sequence.prepare(pm_pack if track == 'pm' else self.pack, root, track, arm)
                state['status'] = 'ended'; save(root / 'sequence.json', state)
                entries.append({'root': str(root)})
        self.assertEqual(len(run.preflight(entries, require_complete=True)), 8)
        with self.assertRaisesRegex(ValueError, 'complete four-product'):
            run.preflight(entries[:-1], require_complete=True)

    def three_cohort(self):
        scope = {'included_arms': ['ledger', 'graphify', 'gbrain'], 'excluded_arms': ['supermemory'], 'authorization': 'User explicitly excluded Supermemory'}
        pm_pack = self.root / 'pm-pack'; fixtures.build(pm_pack, 'pm', seed=271)
        entries = []
        for track in ('pm', 'engineering'):
            for arm in scope['included_arms']:
                root = self.root / (track + '-' + arm)
                state = run.sequence.prepare(pm_pack if track == 'pm' else self.pack, root, track, arm)
                state['status'] = 'ended'; save(root / 'sequence.json', state)
                entries.append({'root': str(root)})
        return scope, entries

    def test_authorized_three_cohort_retains_all_24_tasks(self):
        scope, entries = self.three_cohort()
        result = run.grade_run(entries, self.root / 'out', self.fake_functional, cohort_scope=scope)
        self.assertEqual(result['expected_sequences'], 6)
        self.assertEqual(result['expected_tasks'], 24)
        self.assertEqual(sum(len(s['stages']) for s in result['sequences']), 24)
        self.assertEqual(result['cohort_scope'], scope)

    def test_three_cohort_is_not_inferred_from_missing_product(self):
        _, entries = self.three_cohort()
        with self.assertRaisesRegex(ValueError, 'complete four-product'):
            run.preflight(entries, require_complete=True)

    def test_declared_three_cohort_cannot_drop_another_track(self):
        scope, entries = self.three_cohort()
        with self.assertRaisesRegex(ValueError, 'complete three-product'):
            run.preflight(entries[:-1], require_complete=True, cohort_scope=scope)

    def test_three_cohort_requires_explicit_authorization(self):
        scope, entries = self.three_cohort(); scope['authorization'] = ''
        with self.assertRaisesRegex(ValueError, 'authorized three-product'):
            run.preflight(entries, require_complete=True, cohort_scope=scope)

    def declared_cohort(self, batch):
        scope = run.cohort_label and __import__('cohort_scope').batch_scope(batch, 'User declared the ' + batch + ' cohort')
        pm_pack = self.root / 'pm-pack'
        if not pm_pack.exists(): fixtures.build(pm_pack, 'pm', seed=271)
        entries = []
        for track in ('pm', 'engineering'):
            for arm in scope['included_arms']:
                root = self.root / (track + '-' + arm)
                state = run.sequence.prepare(pm_pack if track == 'pm' else self.pack, root, track, arm)
                state['status'] = 'ended'; save(root / 'sequence.json', state)
                entries.append({'root': str(root)})
        return scope, entries

    def test_declared_six_arm_cohort_retains_48_tasks(self):
        scope, entries = self.declared_cohort('six-arm')
        result = run.grade_run(entries, self.root / 'out', self.fake_functional, cohort_scope=scope)
        self.assertEqual((result['expected_sequences'], result['expected_tasks']), (12, 48))
        self.assertEqual(sum(len(s['stages']) for s in result['sequences']), 48)
        with self.assertRaisesRegex(ValueError, 'complete six-arm'):
            run.preflight(entries[:-1], require_complete=True, cohort_scope=scope)
        with self.assertRaisesRegex(ValueError, 'complete four-product'):
            run.preflight(entries, require_complete=True)

    def test_declared_control_batch_grades_four_sequences(self):
        scope, entries = self.declared_cohort('controls')
        result = run.grade_run(entries, self.root / 'out', self.fake_functional, cohort_scope=scope)
        self.assertEqual((result['expected_sequences'], result['expected_tasks']), (4, 16))
        with self.assertRaisesRegex(ValueError, 'arm excluded'):
            run.preflight(entries, require_complete=True, cohort_scope=__import__('cohort_scope').batch_scope('products', 'x'))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.pack = self.root / 'pack'
        fixtures.build(self.pack, 'engineering', seed=271)
        self.seq = self.root / 'seq'
        state = run.sequence.prepare(self.pack, self.seq, 'engineering', 'ledger')
        manifest = run.read(self.pack / 'manifest.json')
        previous = None
        self.key = 'actual-key-from-B-handoff'
        for stage in manifest['stages']:
            name = stage['id']; ctl = self.seq / 'stages' / name / 'controller'
            tree = ctl / 'submission/tree'; tree.mkdir(parents=True)
            if previous:
                shutil.copytree(previous / 'handoff/tree', tree, dirs_exist_ok=True)
                recovered = ctl / 'recovery/tree'
                shutil.copytree(previous / 'handoff/tree', recovered)
                files, _ = run.recovery.tree_manifest(recovered)
                evidence = {'sources': [{'artifact_id': n, 'sha256': d} for n, d in files.items()],
                            'native_sources': [{'tool': 'fixture-only', 'id': name, 'description': 'fake local test transport'}]}
                save(ctl / 'recovery/evidence.json', evidence)
                rr = receipt(recovered, 'teamwork-recovery/v3'); rr['elapsed_ms'] = 50
                rr['evidence_file_sha256'] = run.sha(ctl / 'recovery/evidence.json')
                save(ctl / 'recovery.json', rr)
                prior_state = run.read(tree / 'continuity/state.json')
                save(tree / ('continuity/history/' + chr(ord(name) - 1) + '.json'), prior_state)
            shutil.copytree(self.pack / 'initial-repo', tree, dirs_exist_ok=True)
            shutil.copytree(self.pack / stage['delta_dir'], tree, dirs_exist_ok=True)
            (tree / 'reports').mkdir(exist_ok=True)
            (tree / ('reports/' + name + '.md')).write_text('Actual stage ' + name + ' report')
            (tree / 'focused-check.py').write_text('print("a producer-authored check")\n')
            pending = [] if name == 'A' else [{'key': self.key, 'status': 'planned' if name == 'B' else 'completed',
                                             **({'receipt_id': 'provider-receipt'} if name in 'CD' else {})}]
            value = {'stage': name, 'goal': 'Actual work ' + name, 'accepted_decisions': [],
                     'proposals': ['a proposal'], 'superseded': [], 'open_questions': ['unfinished ' + name],
                     'next_steps': ['next'], 'pending_operations': pending}
            save(tree / 'continuity/state.json', value)
            save(ctl / 'submission/answer.json', {'stage': name})
            delivery = receipt(tree, 'teamwork-delivery/v3')
            delivery['answer_file_sha256'] = run.sha(ctl / 'submission/answer.json')
            save(ctl / 'delivery.json', delivery)
            handoff = ctl / 'handoff/tree'; shutil.copytree(tree, handoff)
            if name == 'B':
                changed = copy.deepcopy(value); changed['open_questions'] = ['Changed after useful delivery, before interruption']
                save(handoff / 'continuity/state.json', changed)
            save(ctl / 'handoff.json', receipt(handoff, 'teamwork-handoff/v3'))
            initial = run.sequence.inventory(self.pack / 'initial-repo')
            delta = run.sequence.inventory(self.pack / stage['delta_dir'])
            save(ctl / 'transport.json', {'schema': 'teamwork-input-transport/v3', 'initial_git_commit_count': 1,
                 'initial_repo_files': initial, 'current_delta_files': delta, 'released_files': {**initial, **delta}})
            state['stages'][name] = {'status': 'finished', 'session': {'compaction': {'observed': False}}}
            previous = ctl
        state['status'] = 'ended'; state['executed'] = True; save(self.seq / 'sequence.json', state)
        self.events = self.root / 'events.jsonl'
        self.events.write_text('\n'.join(json.dumps(e) for e in [
            {'seq': 1, 'kind': 'submit', 'key': self.key, 'stage': 'B'},
            {'seq': 2, 'kind': 'effect', 'key': self.key, 'stage': 'B', 'receipt_id': 'provider-receipt'},
            {'seq': 3, 'kind': 'lookup', 'key': self.key, 'stage': 'C', 'receipt_id': 'provider-receipt'}]) + '\n')
        self.calls = []

    def fake_functional(self, tree, stage):
        self.calls.append((tree, stage))
        return {'checks': [{'id': 'fake-controller-check', 'passed': True}], 'passed': 1, 'applicable': 1}

    def grade(self):
        return run.grade_run([{'root': str(self.seq), 'provider_events': str(self.events)}], self.root / 'out', self.fake_functional, require_complete=False)

    def test_uses_actual_handoff_state_not_earlier_delivery_and_keeps_functionality_separate(self):
        result = self.grade(); stages = result['sequences'][0]['stages']
        self.assertEqual(stages['C']['recovery']['counts']['failed'], 0)
        self.assertEqual(stages['C']['recovery']['counts']['not_evaluated'], 0)
        self.assertEqual(stages['C']['recovery']['by_kind']['uncertain_effect']['passed'], 1)
        self.assertEqual([s for _, s in self.calls], list('ABCD'))
        self.assertTrue(all(str(p).endswith('/submission/tree') for p, _ in self.calls))
        self.assertEqual(stages['A']['recovery']['status'], 'not_applicable')
        self.assertNotIn('WORKFLOW.md', stages['C']['artifact_selection']['fixed_public_paths'])
        self.assertIn('artifact:focused-check.py', stages['C']['recovery']['artifact_groups']['additional_actual'])

    def test_missing_producer_handoff_is_explicit_not_reconstructed_from_submission(self):
        (self.seq / 'stages/B/controller/handoff.json').unlink()
        result = self.grade()['sequences'][0]['stages']['C']
        self.assertEqual(result['recovery']['status'], 'not_evaluated')
        self.assertIn('handoff', result['recovery']['producer_or_controller_gap'])
        self.assertEqual(result['functional']['passed'], 1)

    def test_corrupted_delivery_never_reaches_functional_grader(self):
        (self.seq / 'stages/C/controller/submission/tree/app.py').write_text('post-delivery mutation')
        result = self.grade()['sequences'][0]['stages']['C']
        self.assertEqual(result['delivery']['status'], 'integrity_invalid')
        self.assertNotIn('C', [s for _, s in self.calls])
        self.assertEqual(result['recovery']['by_kind']['uncertain_effect']['not_evaluated'], 1)

    def test_active_sequence_rejected_before_any_grading_or_output(self):
        state = run.read(self.seq / 'sequence.json'); state['status'] = 'running'; save(self.seq / 'sequence.json', state)
        with self.assertRaises(ValueError): self.grade()
        self.assertFalse(self.calls); self.assertFalse((self.root / 'out').exists())

    def test_late_recovery_does_not_keep_pass_counts(self):
        p = self.seq / 'stages/C/controller/recovery.json'; rr = run.read(p); rr['elapsed_ms'] = 1300000; save(p, rr)
        result = self.grade()['sequences'][0]['stages']['C']['recovery']
        self.assertEqual(result['status'], 'infrastructure_invalid')
        self.assertEqual(result['counts']['passed'], 0)
        self.assertTrue(all(v['passed'] == 0 for v in result['by_kind'].values()))


if __name__ == '__main__': unittest.main()
