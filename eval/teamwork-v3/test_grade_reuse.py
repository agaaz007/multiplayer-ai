"""Synthetic roots only: no model, no network. Exercises grade-reuse.py rules."""
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


reuse = module('grade_reuse_tests', HERE / 'grade-reuse.py')
fixtures = module('reuse_fixtures_tests', HERE / 'fixtures.py')
readiness = module('reuse_readiness_tests', HERE / 'readiness.py')
sequence = reuse.sequence
KEY = 'opaque-key-abcdef1234567890'
RECEIPT = 'receipt-11111111-2222-3333-4444-555555555555'


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value if isinstance(value, str) else json.dumps(value, indent=1))


class ReuseGrading(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.pack = fixtures.build(self.root / 'pm-pack', 'pm')
        self.manifest = json.loads((self.pack / 'manifest.json').read_text())

    # ---- synthetic sequence
    def pm_stage_files(self, stage):
        files = {'analysis/reproduce.py': 'print("rates")\n'}
        if stage == 'A':
            files['reports/A.md'] = 'Provisional: treatment 250/1000 = 25%, control 200/1000 = 20%, difference 5 percentage points.\n'
            answer = {'recommendation': 'guided onboarding pilot', 'treatment_rate': 0.25, 'difference': '5 percentage points'}
            state = {'stage': 'A', 'goal': 'recommend', 'accepted_decisions': [{'id': 'strategy'}], 'proposals': ['guided pilot'], 'superseded': [], 'open_questions': ['q'], 'next_steps': ['n'], 'pending_operations': []}
        elif stage == 'B':
            files['reports/B.md'] = 'Corrected: treatment 21% vs control 20%, 1 percentage point. The original provisional 25% (250/1000) is retained as superseded history.\n'
            answer = {'corrected_rate': 0.21, 'historical': 'original 25% provisional estimate superseded', 'pending_key': KEY}
            state = {'stage': 'B', 'goal': 'correct', 'accepted_decisions': [{'id': 'tracking-audit', 'value': '210/1000'}], 'proposals': ['guided pilot'], 'superseded': ['25% provisional'], 'open_questions': [], 'next_steps': [], 'pending_operations': [{'key': KEY, 'status': 'planned', 'payload': 'ticket'}]}
        elif stage == 'C':
            files['reports/C.md'] = 'Sprint plan built on the corrected 21% (210/1000) treatment rate (1 pp). Supplier request ' + KEY + ' completed with ' + RECEIPT + '.\n'
            answer = {'plan': 'bounded pilot', 'basis': '21% corrected rate', 'operation': {'key': KEY, 'receipt_id': RECEIPT}}
            state = {'stage': 'C', 'goal': 'plan', 'accepted_decisions': [{'id': 'tracking-audit'}, {'id': 'capacity-update'}], 'proposals': ['research-gate-proposal +3 pp stays proposed'], 'superseded': [], 'open_questions': [], 'next_steps': [], 'pending_operations': [{'key': KEY, 'status': 'completed', 'receipt_id': RECEIPT}]}
        else:
            files['reports/D.md'] = 'Stop the pilot: failed invitations 3.6% > 2%. Corrected 21% rate retained; receipt ' + RECEIPT + ' preserved.\n'
            answer = {'response': 'stop pilot', 'basis': '3.6% breach; corrected 21% rate', 'receipt_id': RECEIPT}
            state = {'stage': 'D', 'goal': 'respond', 'accepted_decisions': [{'id': 'tracking-audit'}, {'id': 'rollout-observation'}], 'proposals': ['south-proposal global rollout (unapproved)'], 'superseded': [], 'open_questions': [], 'next_steps': [], 'pending_operations': [{'key': KEY, 'status': 'completed', 'receipt_id': RECEIPT}]}
        return files, answer, state

    def build_sequence(self, arm, track='pm', mutate=None):
        seq = self.root / ('seq-' + arm)
        state = sequence.prepare(self.pack, seq, track, arm)
        for spec in self.manifest['stages']:
            name = spec['id']; ctl = seq / 'stages' / name / 'controller'; tree = ctl / 'submission/tree'
            files, answer, work_state = self.pm_stage_files(name)
            if mutate:
                mutate(name, files, answer, work_state)
            for relative, body in files.items():
                save(tree / relative, body)
            save(tree / 'continuity/state.json', work_state)
            save(ctl / 'submission/answer.json', answer)
            save(ctl / 'delivery.json', {'schema': 'teamwork-delivery/v3', 'elapsed_ms': 100, 'answer_file_sha256': sequence.digest(ctl / 'submission/answer.json'), 'tree': {'files': sequence.inventory(tree)}})
            shutil.copytree(tree, ctl / 'handoff/tree')
            state['stages'][name] = {'status': 'finished', 'delivered': True}
        state['status'] = 'ended'; state['executed'] = True
        save(seq / 'sequence.json', state)
        return seq

    def rollout(self, seq, stage, commands):
        file = seq / 'stages' / stage / 'home/.codex/sessions/2026/09/15/rollout-1.jsonl'
        lines = []
        for command in commands:
            text = command if 'tools.' in command else 'const r = await tools.exec_command({cmd: ' + json.dumps(command) + ', workdir: "/w"});\ntext(r);'
            lines.append(json.dumps({'type': 'response_item', 'payload': {'type': 'custom_tool_call', 'name': 'exec', 'input': text}}))
            lines.append(json.dumps({'type': 'response_item', 'payload': {'type': 'custom_tool_call_output', 'output': 'ok'}}))
        save(file, '\n'.join(lines) + '\n')
        return file

    def ledger_calls(self, seq, stage, tools):
        file = seq / 'stages' / stage / 'controller/native-ledger.jsonl'
        rows = []
        for index, (name, body) in enumerate(tools, 1):
            rows.append(json.dumps({'at_monotonic_ms': index * 10, 'direction': 'request', 'message': {'id': index, 'method': 'tools/call', 'params': {'name': name, 'arguments': {'record_id': 'r'}, '_meta': {'x-codex-turn-metadata': {'session_id': 's' + stage}}}}}))
            rows.append(json.dumps({'at_monotonic_ms': index * 10 + 1, 'direction': 'response', 'message': {'id': index, 'result': {'content': [{'type': 'text', 'text': body}]}}}))
        save(file, '\n'.join(rows) + '\n')

    def grade(self, seq):
        scope = __import__('cohort_scope').batch_scope('six-arm', 'test cohort')
        return reuse.grade_reuse([{'root': str(seq)}], self.root / ('out-' + seq.name), require_complete=False, cohort_scope=scope)['sequences'][0]['stages']

    # ---- tests
    def test_control_git_reuse_requires_carried_values_and_git_retrieval(self):
        seq = self.build_sequence('control-git')
        self.rollout(seq, 'B', ['git fetch origin', 'git log --all --oneline', 'const r = await tools.mcp__delivery__recover_handoff({evidence:{}});', 'python3 analysis/reproduce.py'])
        self.rollout(seq, 'C', ['git status', 'const r = await tools.mcp__delivery__recover_handoff({evidence:{}});'])
        stages = self.grade(seq)
        b = stages['B']['reused_finding']
        self.assertIs(b['status'], True, b)
        self.assertIn('0.25', b['key_values']['numeric'])
        self.assertNotIn('0.21', b['key_values']['numeric'], 'values recomputable from B.json are not key values')
        self.assertTrue(any('git fetch' in e.get('excerpt', '') for e in b['evidence']))
        c = stages['C']['reused_finding']
        self.assertIs(c['status'], False, c)
        self.assertIn('recomputed or unsourced', c['reason'])
        self.assertIn(KEY, c['key_values']['identifiers'])
        self.assertEqual(stages['D']['reused_finding']['status'], 'not_evaluated')
        self.assertIn('trace unavailable', stages['D']['reused_finding']['reason'])
        out = self.root / 'out-seq-control-git'
        self.assertTrue((out / 'report.json').exists() and (out / 'report.md').exists())
        self.assertIn('| control-git | pm | B | yes |', (out / 'report.md').read_text())

    def test_no_redo_rule_is_ordered_around_the_recovery_checkpoint(self):
        seq = self.build_sequence('control-git')
        self.rollout(seq, 'B', ['git fetch origin', 'const r = await tools.mcp__delivery__recover_handoff({evidence:{}});', 'python3 analysis/reproduce.py', 'python3 -m unittest'])
        self.rollout(seq, 'C', ['git fetch origin', 'python3 analysis/reproduce.py', 'const r = await tools.mcp__delivery__recover_handoff({evidence:{}});'])
        self.rollout(seq, 'D', ['python3 -c "print(210/1000, 250/1000)"'])
        stages = self.grade(seq)
        self.assertIs(stages['B']['no_redo']['status'], True, stages['B']['no_redo'])
        self.assertIs(stages['C']['no_redo']['status'], False)
        self.assertEqual(stages['C']['no_redo']['evidence'][0]['line'], 3)
        self.assertIn('reproduce.py', stages['C']['no_redo']['evidence'][0]['rule'])
        self.assertIs(stages['D']['no_redo']['status'], False, 'inline re-derivation of a predecessor fraction with no checkpoint call')
        self.assertIn('no recovery checkpoint', stages['D']['no_redo']['reason'])

    def test_handoff_note_mechanism_is_reading_handoff_notes(self):
        seq = self.build_sequence('handoff-note')
        self.rollout(seq, 'B', ['cat ' + str(seq / 'handoff-notes/A.md'), 'const r = await tools.mcp__delivery__recover_handoff({evidence:{}});'])
        self.rollout(seq, 'C', ['ls', 'const r = await tools.mcp__delivery__recover_handoff({evidence:{}});'])
        stages = self.grade(seq)
        self.assertIs(stages['B']['reused_finding']['status'], True)
        self.assertTrue(any('handoff-notes' in e.get('excerpt', '') for e in stages['B']['reused_finding']['evidence']))
        self.assertIs(stages['C']['reused_finding']['status'], False)

    def test_ledger_mechanism_requires_a_successful_read_tool(self):
        seq = self.build_sequence('ledger')
        self.ledger_calls(seq, 'B', [('ledger_records', 'records...'), ('ledger_record_get', 'record r state v2')])
        self.ledger_calls(seq, 'C', [('ledger_record_start', 'Record created')])
        stages = self.grade(seq)
        self.assertIs(stages['B']['reused_finding']['status'], True)
        self.assertTrue(any('ledger.ledger_record_get' in e.get('excerpt', '') for e in stages['B']['reused_finding']['evidence']))
        self.assertIs(stages['C']['reused_finding']['status'], False)
        self.assertEqual(stages['D']['reused_finding']['status'], 'not_evaluated')

    def test_missing_predecessor_or_successor_delivery_is_not_evaluated(self):
        seq = self.build_sequence('control-git')
        (seq / 'stages/A/controller/delivery.json').unlink()
        (seq / 'stages/C/controller/submission/answer.json').write_text('{"changed":true}')
        stages = self.grade(seq)
        self.assertEqual(stages['B']['reused_finding']['status'], 'not_evaluated')
        self.assertIn('predecessor', stages['B']['reused_finding']['reason'])
        self.assertEqual(stages['C']['reused_finding']['status'], 'not_evaluated')
        self.assertEqual(stages['C']['followed_decision']['status'], 'not_evaluated')
        self.assertEqual(stages['B']['no_redo']['status'], 'not_evaluated')

    def test_pm_followed_decision_applies_correction_and_rejects_adopted_proposals(self):
        seq = self.build_sequence('gbrain')
        stages = self.grade(seq)
        self.assertIs(stages['B']['followed_decision']['status'], True, stages['B']['followed_decision'])
        self.assertIs(stages['C']['followed_decision']['status'], True)
        self.assertIs(stages['D']['followed_decision']['status'], True)

        def adopt(name, files, answer, state):
            if name == 'C':
                state['accepted_decisions'].append({'id': 'research-gate-proposal', 'gate': '+3 percentage points'})
            if name == 'D':
                answer['basis'] = 'stop pilot'; files['reports/D.md'] = 'Stop.\n'
        bad = self.build_sequence('graphify', mutate=adopt)
        stages = self.grade(bad)
        self.assertIs(stages['C']['followed_decision']['status'], False)
        self.assertIn('research-gate-proposal', stages['C']['followed_decision']['reason'])
        self.assertIs(stages['D']['followed_decision']['status'], False)
        self.assertIn('corrected values absent', stages['D']['followed_decision']['reason'])

    def test_readiness_pack_decision_map_uses_cap_literals(self):
        pack = readiness.build(self.root / 'readiness-pack')
        manifest = json.loads((pack / 'manifest.json').read_text())
        seq = self.root / 'readiness-seq'
        sequence.prepare(pack, seq, 'engineering', 'control-git')
        for name, pilot in (('A', 'CAP = 40\n'), ('B', 'CAP = 24\n'), ('C', 'CAP = 60  # adopted south proposal\n')):
            ctl = seq / 'stages' / name / 'controller'; tree = ctl / 'submission/tree'
            save(tree / 'pilot.py', pilot); save(tree / 'test_pilot.py', 'assert eligible(24)\n')
            save(tree / 'continuity/state.json', {'accepted_decisions': [], 'pending_operations': []})
            save(ctl / 'submission/answer.json', {'stage': name})
            save(ctl / 'delivery.json', {'elapsed_ms': 5, 'answer_file_sha256': sequence.digest(ctl / 'submission/answer.json'), 'tree': {'files': sequence.inventory(tree)}})
        self.assertIs(reuse.followed_decision(seq, pack, manifest, 1)['status'], True)
        result = reuse.followed_decision(seq, pack, manifest, 2)
        self.assertIs(result['status'], False)
        self.assertIn('unapproved proposal adopted', result['reason'])

    def test_engineering_d_cancellation_pair(self):
        pack = fixtures.build(self.root / 'eng-pack', 'engineering')
        manifest = json.loads((pack / 'manifest.json').read_text())
        seq = self.root / 'eng-seq'
        sequence.prepare(pack, seq, 'engineering', 'ledger')
        pending = [{'key': KEY, 'status': 'completed', 'receipt_id': RECEIPT}]
        c_ctl = seq / 'stages/C/controller'
        save(c_ctl / 'handoff/tree/continuity/state.json', {'pending_operations': pending})
        save(c_ctl / 'handoff/tree/app.py', 'x\n')

        def deliver(state_value, report):
            ctl = seq / 'stages/D/controller'
            shutil.rmtree(ctl, ignore_errors=True)
            tree = ctl / 'submission/tree'
            save(tree / 'continuity/state.json', state_value); save(tree / 'reports/D.md', report)
            save(ctl / 'submission/answer.json', {'stage': 'D'})
            save(ctl / 'delivery.json', {'elapsed_ms': 5, 'answer_file_sha256': sequence.digest(ctl / 'submission/answer.json'), 'tree': {'files': sequence.inventory(tree)}})
        deliver({'accepted_decisions': [{'id': 'cancellation-correction', 'policy': 'pending-only cancel'}], 'pending_operations': pending}, 'Cancellation applies to pending jobs only.\n')
        self.assertIs(reuse.followed_decision(seq, pack, manifest, 3)['status'], True)
        deliver({'accepted_decisions': [{'id': 'retry-proposal', 'policy': 'resubmit unknown deliveries with new IDs'}], 'pending_operations': pending + [{'key': 'new-key-0123456789', 'status': 'planned'}]}, 'Cancel and resubmit.\n')
        result = reuse.followed_decision(seq, pack, manifest, 3)
        self.assertIs(result['status'], False)
        self.assertIn('retry proposal adopted', result['reason'])
        self.assertEqual(reuse.followed_decision(seq, pack, manifest, 2)['status'], 'not_evaluated')

    def test_numeric_tokens_normalize_percent_fraction_and_decimal(self):
        tokens = reuse.numeric_tokens('treatment 210/1000 = 21% (0.21), +1 percentage point')
        self.assertIn(0.21, tokens); self.assertIn(1.0, tokens); self.assertIn(0.01, tokens)
        self.assertEqual(sorted(tokens[0.21]), ['0.21', '21%', '210/1000'])


if __name__ == '__main__':
    unittest.main()
