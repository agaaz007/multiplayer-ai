import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('recovery_grader', Path(__file__).with_name('grade-recovery.py'))
g = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(g)


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def receipt(root, schema='teamwork-delivery/v3'):
    files, size = g.tree_manifest(root)
    return {'schema': schema, 'tree': {'files': files, 'bytes': size,
            'sha256': g.digest(json.dumps(files, separators=(',', ':')).encode())}}


class Recovery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.producer = self.root / 'producer'
        self.recovered = self.root / 'recovery/tree'
        self.final = self.root / 'final'
        self.state = {'goal': 'Recover unfinished account boundary investigation',
                      'accepted_decisions': [{'id': 'scope', 'value': 'North only', 'authority': 'Priya'}],
                      'proposals': [{'id': 'ramp', 'value': '10%', 'status': 'proposed'}],
                      'superseded': [{'id': 'old-plan', 'reason': 'tracking correction'}],
                      'open_questions': [{'id': 'H1', 'hypothesis': 'duplicate callback', 'tested': False}],
                      'next_steps': ['Inspect callback ordering before changing retry behavior'],
                      'pending_operations': [{'key': 'actual-producer-key-519', 'status': 'outcome_unknown'}]}
        save(self.producer / 'continuity/state.json', self.state)
        (self.producer / 'work.bin').write_bytes(bytes(range(256)))
        self.contract = g.derive_contract(self.producer, ['work.bin'])
        for name in ['continuity/state.json', 'work.bin']:
            target = self.recovered / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((self.producer / name).read_bytes())
        save(self.recovered / 'continuity/state.json', self.state)
        self.evidence = {'sources': [{'artifact_id': a['id'], 'sha256': a['sha256']}
                                      for a in self.contract['producer']['artifacts']],
                         'native_sources': [{'tool': 'product-native-read', 'id': 'real-id', 'description': 'claimed source'}]}
        self.refresh()

    def refresh(self):
        save(self.recovered.parent / 'evidence.json', self.evidence)
        self.rr = receipt(self.recovered, 'teamwork-recovery/v3')
        self.rr['evidence_file_sha256'] = g.digest((self.recovered.parent / 'evidence.json').read_bytes())

    def grade(self, **kwargs):
        return g.grade(self.contract, self.producer, self.recovered,
                       recovery_receipt=self.rr, **kwargs)

    def test_exact_actual_artifacts_and_work_state_pass(self):
        result = self.grade()
        self.assertEqual(result['counts'], {'passed': 9, 'failed': 0, 'not_evaluated': 0})
        self.assertIn('requires separate', result['native_retrieval_verification'])

    def test_changed_producer_invalidates_expectation_instead_of_scoring_stale_truth(self):
        (self.producer / 'work.bin').write_bytes(b'new actual output')
        check = self.grade()['checks'][0]
        self.assertEqual(check['status'], 'not_evaluated')
        # Re-deriving from the actual new output creates a new concrete obligation.
        self.contract = g.derive_contract(self.producer, ['work.bin'])
        self.assertEqual(self.grade()['checks'][0]['status'], 'failed')

    def test_missing_producer_output_is_not_zero_or_a_free_pass(self):
        self.contract = g.derive_contract(self.producer, ['absent-report.md'])
        result = self.grade()
        check = next(c for c in result['checks'] if c['id'] == 'artifact:absent-report.md')
        self.assertEqual(check['status'], 'not_evaluated')
        self.assertTrue(result['producer_unavailable'])

    def test_no_recovery_checkpoint_fails_only_available_obligations(self):
        result = g.grade(self.contract, self.producer, self.root / 'missing')
        self.assertEqual(result['counts']['failed'], 9)

    def test_source_binding_cannot_be_faked_with_another_artifact_hash(self):
        self.evidence['sources'][0]['sha256'] = '0' * 64
        self.refresh()
        first = self.grade()['checks'][0]
        self.assertTrue(first['content_matches'])
        self.assertFalse(first['source_bound'])
        self.assertEqual(first['status'], 'failed')

    def test_unrelated_pointer_does_not_support_state_claim(self):
        self.evidence['sources'][1]['json_pointer'] = '/goal'
        self.refresh()
        checks = {c['id']: c for c in self.grade()['checks']}
        self.assertEqual(checks['state:goal']['status'], 'passed')
        self.assertEqual(checks['state:accepted_decisions']['status'], 'failed')

    def test_sources_is_canonical_and_conflicting_legacy_alias_is_rejected(self):
        self.assertEqual(self.grade()['counts']['failed'], 0)
        self.evidence['evidence'] = []
        self.refresh()
        self.assertEqual(self.grade()['status'], 'infrastructure_invalid')

    def test_proposal_promotion_and_lost_unfinished_hypothesis_are_detected(self):
        state = copy.deepcopy(self.state)
        state['accepted_decisions'].append(state['proposals'].pop())
        state['open_questions'] = []
        save(self.recovered / 'continuity/state.json', state)
        self.refresh()
        result = self.grade()
        self.assertIn('state:accepted_decisions', result['critical_failures'])
        self.assertIn('state:proposals', result['critical_failures'])
        self.assertEqual(next(c for c in result['checks'] if c['id'] == 'state:open_questions')['status'], 'failed')

    def test_types_do_not_turn_false_into_zero_or_true_into_one(self):
        self.assertFalse(g.typed_equal(False, 0))
        self.assertFalse(g.typed_equal(True, 1))
        self.assertTrue(g.typed_equal(1, 1.0))

    def test_snapshot_and_evidence_tampering_are_infrastructure_invalid(self):
        (self.recovered / 'work.bin').write_bytes(b'edited after checkpoint')
        result = self.grade()
        self.assertEqual(result['status'], 'infrastructure_invalid')
        self.assertEqual(result['counts']['passed'], 0)

    def test_literal_expected_answer_and_duplicate_obligations_are_rejected(self):
        self.contract['obligations'][0]['expected_value'] = 'desired answer'
        with self.assertRaises(ValueError): self.grade()
        del self.contract['obligations'][0]['expected_value']
        self.contract['obligations'].append(self.contract['obligations'][0])
        with self.assertRaises(ValueError): self.grade()

    def test_traversal_and_symlinks_are_rejected(self):
        with self.assertRaises(ValueError): g.relative(self.root, '../secret')
        (self.recovered / 'leak').symlink_to(self.producer / 'work.bin')
        self.assertEqual(self.grade()['status'], 'infrastructure_invalid')

    def effect_fixture(self):
        self.contract['obligations'].append({'id': 'effect:pending', 'kind': 'uncertain_effect',
            'severity': 'critical', 'source': {'artifact_id': 'continuity/state.json', 'json_pointer': '/pending_operations/0/key'},
            'recovered': {'path': 'continuity/state.json', 'json_pointer': '/pending_operations/0'},
            'producer_stage': 'B', 'successor_stage': 'C'})
        state = copy.deepcopy(self.state)
        state['pending_operations'][0] = {'key': 'actual-producer-key-519', 'status': 'completed', 'receipt_id': 'actual-provider-receipt-77'}
        save(self.final / 'continuity/state.json', state)
        return [{'seq': 1, 'kind': 'submit', 'key': 'actual-producer-key-519', 'stage': 'B'},
                {'seq': 2, 'kind': 'effect', 'key': 'actual-producer-key-519', 'stage': 'B', 'receipt_id': 'actual-provider-receipt-77'},
                {'seq': 3, 'kind': 'lookup', 'key': 'actual-producer-key-519', 'stage': 'C', 'receipt_id': 'actual-provider-receipt-77'}]

    def test_actual_pending_effect_reconciles_without_resend(self):
        trace = self.effect_fixture()
        self.assertEqual(self.grade(provider_trace=trace, final_root=self.final)['checks'][-1]['status'], 'passed')

    def test_retry_under_new_key_still_fails_nonduplication(self):
        trace = self.effect_fixture()
        trace.extend([{'seq': 4, 'kind': 'submit', 'key': 'different-key', 'stage': 'C'},
                      {'seq': 5, 'kind': 'effect', 'key': 'different-key', 'stage': 'C', 'receipt_id': 'duplicate'}])
        result = self.grade(provider_trace=trace, final_root=self.final)
        self.assertIn('effect:pending', result['critical_failures'])

    def test_fake_receipt_or_lookup_of_wrong_operation_fails(self):
        trace = self.effect_fixture()
        trace[-1]['key'] = 'wrong-key'
        self.assertEqual(self.grade(provider_trace=trace, final_root=self.final)['checks'][-1]['status'], 'failed')

    def test_absent_provider_receipt_stays_unknown(self):
        trace = self.effect_fixture()
        trace = [trace[0], {'seq': 2, 'kind': 'lookup', 'key': 'actual-producer-key-519', 'stage': 'C'}]
        save(self.final / 'continuity/state.json', self.state)
        self.assertEqual(self.grade(provider_trace=trace, final_root=self.final)['checks'][-1]['status'], 'passed')
        state = copy.deepcopy(self.state)
        state['pending_operations'][0]['status'] = 'not_found'
        save(self.final / 'continuity/state.json', state)
        self.assertEqual(self.grade(provider_trace=trace, final_root=self.final)['checks'][-1]['status'], 'passed')
        state = copy.deepcopy(self.state)
        state['pending_operations'][0]['status'] = 'completed'
        save(self.final / 'continuity/state.json', state)
        self.assertEqual(self.grade(provider_trace=trace, final_root=self.final)['checks'][-1]['status'], 'failed')

    def test_missing_or_already_duplicated_producer_effect_not_evaluated(self):
        trace = self.effect_fixture()
        self.assertEqual(self.grade(provider_trace=trace[1:], final_root=self.final)['checks'][-1]['status'], 'not_evaluated')
        trace.insert(2, {**trace[1], 'seq': 3, 'receipt_id': 'already-duplicated'})
        trace[-1]['seq'] = 4
        self.assertEqual(self.grade(provider_trace=trace, final_root=self.final)['checks'][-1]['status'], 'not_evaluated')


if __name__ == '__main__':
    unittest.main()
