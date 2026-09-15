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
review = module('pm_review_prepare_tests', HERE / 'review-prepare.py')
fixtures = module('pm_review_fixtures_tests', HERE / 'fixtures.py')

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True); path.write_text(json.dumps(value))
def receipt(root, schema):
    files, size = review.grading.recovery.tree_manifest(root)
    return {'schema': schema, 'elapsed_ms': 100, 'tree': {'files': files, 'bytes': size,
            'sha256': review.grading.recovery.digest(json.dumps(files, separators=(',', ':')).encode())}}


class Preparation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.pack = self.root / 'pack'
        fixtures.build(self.pack, 'pm')
        self.entries = []
        for arm in ('ledger', 'graphify', 'gbrain', 'supermemory'):
            self.entries.append(self.build_arm(arm))
        self.runtime = self.root / 'runtime'; (self.runtime / 'eval').mkdir(parents=True)
        (self.runtime / 'eval/sequence-codex.js').write_text('// never called in preparation tests')

    def build_arm(self, arm):
        if True:
            root = self.root / arm
            state = review.grading.sequence.prepare(self.pack, root, 'pm', arm)
            previous = None
            for stage in review.read(self.pack / 'manifest.json')['stages']:
                name = stage['id']; ctl = root / 'stages' / name / 'controller'; tree = ctl / 'submission/tree'; tree.mkdir(parents=True)
                if previous:
                    shutil.copytree(previous, tree, dirs_exist_ok=True)
                    shutil.copytree(previous, ctl / 'recovery/tree')
                    rr = receipt(ctl / 'recovery/tree', 'teamwork-recovery/v3')
                    save(ctl / 'recovery/evidence.json', {'sources': [], 'native_sources': []})
                    rr['evidence_file_sha256'] = review.sha(ctl / 'recovery/evidence.json')
                    save(ctl / 'recovery.json', rr)
                shutil.copytree(self.pack / stage['delta_dir'], tree, dirs_exist_ok=True)
                (tree / 'reports').mkdir(exist_ok=True)
                (tree / ('reports/' + name + '.md')).write_text(arm + ' report: keep the plan proposed. Control 20%.')
                save(tree / 'continuity/state.json', {'proposals': ['Prior plan'], 'record_id': 'wrk-20260912-native-note',
                     'pending_operations': [] if name == 'A' else [{'key': arm + '-ticket-123456', 'status': 'planned' if name == 'B' else 'completed', 'receipt_id': None if name == 'B' else 'receipt-12345678'}]})
                save(ctl / 'submission/answer.json', {'recommendation': 'Retain the proposal; no human approval is claimed.'})
                dr = receipt(tree, 'teamwork-delivery/v3'); dr['answer_file_sha256'] = review.sha(ctl / 'submission/answer.json')
                save(ctl / 'delivery.json', dr)
                state['stages'][name] = {'status': 'finished'}; previous = tree
            state['status'] = 'ended'; state['executed'] = True; save(root / 'sequence.json', state)
            events = root / 'events.jsonl'; events.write_text(json.dumps({'seq': 1, 'kind': 'effect', 'stage': 'B', 'key': arm + '-ticket-123456', 'receipt_id': 'receipt-12345678'}) + '\n')
            return {'root': str(root), 'provider_events': str(events)}

    def test_declared_six_arm_cohort_prepares_24_slots(self):
        import cohort_scope
        scope = cohort_scope.batch_scope('six-arm', 'User declared the six-arm cohort')
        entries = self.entries + [self.build_arm(arm) for arm in cohort_scope.CONTROL_ARMS]
        out = self.root / 'reviews'; result = review.prepare(entries, out, self.runtime, cohort_scope=scope)
        self.assertEqual((result['cases'], result['eligible_cases']), (24, 24))
        self.assertEqual(len(review.read(out / 'review-config.json')['cases']), 24)
        self.assertEqual(len(review.read(out / 'controller-map.json')['cases']), 24)
        for c in review.read(out / 'review-config.json')['cases']:
            serialized = (Path(c['packet']) / 'answer.json').read_text() + (Path(c['packet']) / 'sources.json').read_text()
            self.assertIsNone(review.VENDOR.search(serialized))
        with self.assertRaisesRegex(ValueError, 'complete six-arm'):
            review.prepare(entries[:-1], self.root / 'reviews-2', self.runtime, cohort_scope=scope)

    def test_complete_cohort_has_ground_truth_and_actual_recovered_material_distinguished(self):
        out = self.root / 'reviews'; result = review.prepare(self.entries, out, self.runtime)
        self.assertEqual(result['cases'], 16); self.assertFalse(result['execution_authorized'])
        cfg = review.read(out / 'review-config.json'); self.assertEqual(len({c['id'] for c in cfg['cases']}), 16)
        case = next(c for c in cfg['cases'] if c['stage'] == 'C'); packet = Path(case['packet'])
        sources = review.read(packet / 'sources.json')
        self.assertTrue(any(s['role'] == 'canonical_released_evidence' for s in sources))
        self.assertTrue(any(s['role'] == 'recovery_checkpoint_artifact' and 'Prior plan' in s['body'] for s in sources))
        self.assertTrue(any(s['availability'] == 'recovered_exact' for s in sources))
        self.assertEqual(review.read(packet / 'fact-keys.json'), review.FACTS)
        for c in cfg['cases']:
            serialized = (Path(c['packet']) / 'answer.json').read_text() + (Path(c['packet']) / 'sources.json').read_text()
            self.assertIsNone(review.VENDOR.search(serialized)); self.assertIsNone(review.ABSOLUTE.search(serialized))

    def test_b_review_does_not_require_future_postdelivery_receipt_knowledge(self):
        entry = self.entries[0]; root = Path(entry['root']); state = review.read(root / 'sequence.json'); manifest = review.read(self.pack / 'manifest.json')
        _, sources, _ = review.packet_for(root, state, self.pack, manifest, manifest['stages'][1], entry['provider_events'])
        oracle = next(s for s in sources if s['role'] == 'independent_supplier_oracle')
        self.assertEqual(json.loads(oracle['body']), [])

    def test_missing_recovery_is_explicit_not_filled_from_canonical_archive(self):
        root = Path(self.entries[0]['root']); ctl = root / 'stages/C/controller'; (ctl / 'recovery.json').unlink()
        manifest = review.read(self.pack / 'manifest.json')
        _, sources, provenance = review.packet_for(root, review.read(root / 'sequence.json'), self.pack, manifest, manifest['stages'][2])
        self.assertFalse(any(s['role'] == 'recovery_checkpoint_artifact' for s in sources))
        self.assertTrue(any(s['availability'] == 'absent_from_recovery_checkpoint' for s in sources))
        self.assertTrue(provenance['missing_material'])

    def test_uniform_blinding_preserves_distinct_keys_and_approval_qualifications(self):
        a = {'report': 'Ledger says this remains proposed; no owner approval.', 'key': 'ledger-request-1234', 'record_id': 'wrk-20260912-abc'}
        sources = [{'id': 'source-001', 'body': json.dumps({'key': 'ledger-request-1234', 'other': 'graphify-request-5678'})}]
        b, s, private = review.blind(a, sources)
        self.assertIn('remains proposed; no owner approval', b['report'])
        self.assertEqual(b['key'], json.loads(s[0]['body'])['key'])
        self.assertTrue(private['exact_map']); self.assertNotIn('Ledger', json.dumps([b, s]))
        b, _, _ = review.blind({'report': 'ledger-request-1234 differs from graphify-request-1234'}, [])
        left, right = b['report'].split(' differs from ')
        self.assertNotEqual(left, right)

    def test_missing_delivery_retains_all_cases_and_other_packets(self):
        root = Path(self.entries[1]['root']); (root / 'stages/D/controller/delivery.json').unlink()
        out = self.root / 'reviews'; result = review.prepare(self.entries, out, self.runtime)
        self.assertEqual(result['cases'], 16); self.assertEqual(result['eligible_cases'], 15)
        cases = review.read(out / 'review-config.json')['cases']
        unavailable = [c for c in cases if c['eligibility']['status'] == 'not_evaluated']
        self.assertEqual(len(unavailable), 1); self.assertNotIn('packet', unavailable[0])
        self.assertEqual(sum('packet' in c for c in cases), 15)

    def test_invalid_or_late_delivery_is_unavailable_without_replacement(self):
        root = Path(self.entries[0]['root'])
        (root / 'stages/B/controller/submission/answer.json').write_text('{"changed":true}')
        file = root / 'stages/C/controller/delivery.json'; data = review.read(file)
        data['elapsed_ms'] = 10**10; save(file, data)
        out = self.root / 'reviews'; result = review.prepare(self.entries, out, self.runtime)
        self.assertEqual(result['eligible_cases'], 14); self.assertEqual(result['not_evaluated_cases'], 2)
        private = review.read(out / 'controller-map.json')['cases']
        self.assertEqual(len(private), 16)
        self.assertTrue(all(c['observed_submission_hashes'] for c in private if c['eligibility']['status'] == 'not_evaluated'))

    def test_malformed_answer_and_receipt_do_not_block_other_cases(self):
        root = Path(self.entries[0]['root']); ctl = root / 'stages/A/controller'
        (ctl / 'submission/answer.json').write_text('not JSON')
        dr = review.read(ctl / 'delivery.json'); dr['answer_file_sha256'] = review.sha(ctl / 'submission/answer.json')
        save(ctl / 'delivery.json', dr)
        save(root / 'stages/B/controller/delivery.json', [])
        result = review.prepare(self.entries, self.root / 'reviews', self.runtime)
        self.assertEqual(result['eligible_cases'], 14); self.assertEqual(result['not_evaluated_cases'], 2)


    def test_authorized_three_cohort_retains_twelve_slots_with_missing_delivery(self):
        scope = {'included_arms': ['ledger', 'graphify', 'gbrain'], 'excluded_arms': ['supermemory'], 'authorization': 'User explicitly excluded Supermemory'}
        entries = self.entries[:3]
        (Path(entries[0]['root']) / 'stages/D/controller/delivery.json').unlink()
        out = self.root / 'reviews'; result = review.prepare(entries, out, self.runtime, cohort_scope=scope)
        self.assertEqual(result['cases'], 12); self.assertEqual(result['eligible_cases'], 11)
        self.assertEqual(result['not_evaluated_cases'], 1)
        cfg = review.read(out / 'review-config.json')
        self.assertEqual(cfg['cohort_scope'], scope); self.assertEqual(len(cfg['cases']), 12)
        self.assertEqual(review.read(out / 'preparation.json')['cohort_scope'], scope)
        self.assertEqual(len(review.read(out / 'controller-map.json')['cases']), 12)

    def test_three_review_cohort_requires_declared_exclusion(self):
        with self.assertRaisesRegex(ValueError, 'complete four-product'):
            review.prepare(self.entries[:3], self.root / 'reviews', self.runtime)
        self.assertFalse((self.root / 'reviews').exists())

    def test_excluded_product_cannot_enter_declared_review(self):
        scope = {'included_arms': ['ledger', 'graphify', 'gbrain'], 'excluded_arms': ['supermemory'], 'authorization': 'User explicitly excluded Supermemory'}
        with self.assertRaisesRegex(ValueError, 'arm excluded'):
            review.prepare(self.entries, self.root / 'reviews', self.runtime, cohort_scope=scope)
        self.assertFalse((self.root / 'reviews').exists())

    def test_three_review_cannot_drop_another_product(self):
        scope = {'included_arms': ['ledger', 'graphify', 'gbrain'], 'excluded_arms': ['supermemory'], 'authorization': 'User explicitly excluded Supermemory'}
        with self.assertRaisesRegex(ValueError, 'complete three-product'):
            review.prepare(self.entries[:2], self.root / 'reviews', self.runtime, cohort_scope=scope)
        self.assertFalse((self.root / 'reviews').exists())


if __name__ == '__main__': unittest.main()
