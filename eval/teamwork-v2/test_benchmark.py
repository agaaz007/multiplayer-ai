import json
from pathlib import Path
import shutil
import tempfile
import unittest
import sys
from fixtures import build, validate, pm_sources, eng_contract, STARTER
from grade_pm import grade, review_packet
from grade_engineering import grade as grade_engineering
from bench import preflight,schedule
from sequence import prepare as prepare_sequence,run as run_sequence

class PackTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.pack=self.root/'pack';build(self.pack,41)
    def tearDown(self):self.temp.cleanup()
    def answer(self,stage):
        _,facts=pm_sources(41)
        return {'facts':facts[stage],'source_ids':['strategy','experiment-v1'] if stage=='A' else ['strategy','tracking-audit'],
                'recommendation':'Fund an instrumentation audit and a bounded pilot with explicit reliability stop criteria.',
                'allocation':[{'option':'instrumentation audit','engineer_weeks':1}],
                'rollout_action':'pause' if stage=='D' else 'not_applicable'}
    def test_reproducible_and_no_future_inputs(self):
        other=self.root/'other';build(other,41)
        self.assertEqual((self.pack/'manifest.json').read_bytes(),(other/'manifest.json').read_bytes())
        self.assertTrue(validate(self.pack)['valid'])
        self.assertNotIn('tracking-audit',(self.pack/'agent/pm/A/raw-evidence.json').read_text())
        self.assertNotIn('\nD:',eng_contract('C'));self.assertNotIn('\nB:',eng_contract('A'))
        self.assertIn('\nD:',eng_contract('D'))
    def test_hash_tampering_rejected(self):
        (self.pack/'agent/pm/B/raw-evidence.json').write_text('[]')
        with self.assertRaises(ValueError):validate(self.pack)
    def test_correct_facts_do_not_auto_pass_decision_quality(self):
        for stage in 'ABCD':
            result=grade(self.pack,stage,self.answer(stage));self.assertTrue(result['factual_pass'],result)
            self.assertEqual(result['decision_quality'],'not_evaluated')
    def test_equivalent_population_labels_pass_without_accepting_other_scopes(self):
        answer=self.answer('A')
        answer['facts']['population']='North SMB workspaces'
        answer['facts']['analysis_unit']='Workspaces'
        self.assertTrue(grade(self.pack,'A',answer)['factual_pass'])
        for wrong in ['South SMB workspaces','North enterprise workspaces','North SMB users']:
            answer['facts']['population']=wrong
            self.assertFalse(grade(self.pack,'A',answer)['factual_pass'])
    def test_wrong_scope_stale_metric_and_future_citation_fail(self):
        answer=self.answer('B');answer['facts']['treatment_rate']=.25;answer['facts']['population']='south_enterprise';answer['source_ids']=['south-proposal']
        result=grade(self.pack,'B',answer);self.assertFalse(result['factual_pass'])
        self.assertGreaterEqual(sum(not x['passed'] for x in result['checks']),3)
    def test_capacity_and_guardrail_errors_cannot_hide_in_polished_prose(self):
        answer=self.answer('D');answer['allocation'][0]['engineer_weeks']=100;answer['rollout_action']='expand'
        result=grade(self.pack,'D',answer);self.assertEqual(len(result['critical_errors']),2)
    def test_nan_and_bool_are_not_numeric_answers(self):
        answer=self.answer('A');answer['facts']['control_rate']=float('nan');answer['allocation'][0]['engineer_weeks']=True
        self.assertFalse(grade(self.pack,'A',answer)['factual_pass'])
    def test_blind_packet_keeps_identity_map_private(self):
        answer=self.answer('A');answer.update({'arm':'ledger','recommendation':'Ledger suggests a pilot','reuse_evidence':[{'id':'ledger-secret'}]})
        review_packet(answer,self.root/'review')
        public=(self.root/'review/answer.json').read_text().lower()
        self.assertNotIn('ledger',public);self.assertNotIn('strategy',public)
    def test_blind_inline_citations_bind_to_the_public_archive(self):
        sources,_=pm_sources(41)
        sources=[source for source in sources if source['released']<='B']
        answer=self.answer('B')
        answer['recommendation']='Apply [tracking-audit], retain `experiment-v1`, and follow strategy.'
        result=review_packet(answer,self.root/'review',sources)
        packet=json.loads((self.root/'review/answer.json').read_text())
        public=json.loads((self.root/'review/sources.json').read_text())
        by_title={source['title']:source['id'] for source in public}
        audit=by_title['Accepted tracking correction']
        self.assertIn('['+audit+']',packet['recommendation'])
        self.assertIn(audit,packet['source_ids'])
        self.assertNotIn('tracking-audit',packet['recommendation'])
        self.assertEqual(len({source['id'] for source in public}),len(sources))
    def test_duplicate_review_source_ids_are_rejected(self):
        source={'id':'one','body':'evidence'}
        with self.assertRaisesRegex(ValueError,'unique'):
            review_packet(self.answer('A'),self.root/'review',[source,source])
    def test_unconfigured_profiles_fail_closed(self):
        result=preflight(self.pack,Path(__file__).with_name('profiles.example.json'))
        self.assertFalse(result['ready']);self.assertIn('freeze authorization',result['problems'])
    def test_paired_schedule(self):
        result=schedule([41,73,109]);self.assertEqual(result['model_stages'],144)
        self.assertEqual(result,schedule([41,73,109]))
    def test_sequence_staging_withholds_future_sources_and_launch_needs_authorization(self):
        root=self.root/'sequence';prepare_sequence(self.pack,root,'pm','fresh-agent')
        self.assertEqual(list((root/'stages/D/worktree').iterdir()),[])
        cfg=self.root/'launch.json';cfg.write_text('{}')
        with self.assertRaisesRegex(ValueError,'authorization'):run_sequence(root,cfg)
        self.assertFalse(json.loads((root/'sequence.json').read_text())['executed'])

class EngineeringTests(unittest.TestCase):
    def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def test_starter_fails_and_reference_passes_all_stage_d_behaviors(self):
        candidate=self.root/'candidate';candidate.mkdir();(candidate/'app.py').write_text(STARTER)
        baseline=grade_engineering(candidate,'A');self.assertFalse(baseline['behavioral_pass']);self.assertEqual(baseline['passed'],0,baseline)
        shutil.copyfile(Path(__file__).with_name('reference_app.py'),candidate/'app.py')
        reference=grade_engineering(candidate,'D');self.assertTrue(reference['behavioral_pass'],reference)
    def test_grader_catches_blind_retry_mutation(self):
        candidate=self.root/'mutant';candidate.mkdir()
        code=Path(__file__).with_name('reference_app.py').read_text()
        code=code.replace("if j['state']=='outcome_unknown':", "if False:  # mutant blindly retries unknown outcome")
        (candidate/'app.py').write_text(code)
        result=grade_engineering(candidate,'B');failed={c['id'] for c in result['checks'] if not c['passed']}
        self.assertIn('unknown-outcome-reconciliation',failed)
        self.assertIn('absent-receipt-stays-unknown',failed)
    def test_grader_catches_cross_owner_mutation(self):
        candidate=self.root/'mutant';candidate.mkdir()
        code=Path(__file__).with_name('reference_app.py').read_text().replace("WHERE owner=? AND id=?',(owner,identity)","WHERE ? IS NOT NULL AND id=?',(owner,identity)")
        (candidate/'app.py').write_text(code)
        result=grade_engineering(candidate,'A')
        self.assertIn('owner-isolation',result['critical_errors'])
    def test_grader_catches_read_only_status_that_reconciles(self):
        candidate=self.root/'mutant';candidate.mkdir()
        code=Path(__file__).with_name('reference_app.py').read_text()
        code=code.replace("'jobs':[execute(j)[1] for j in jobs] if run else jobs", "'jobs':[execute(j)[1] for j in jobs]")
        (candidate/'app.py').write_text(code)
        result=grade_engineering(candidate,'C')
        failed={c['id'] for c in result['checks'] if not c['passed']}
        self.assertIn('batch-composes-storage-and-execution',failed)
    def test_grader_catches_execute_only_owner_bypass(self):
        candidate=self.root/'mutant';candidate.mkdir()
        code=Path(__file__).with_name('reference_app.py').read_text()
        code=code.replace("parts=path.path.split('/');j=job(owner,parts[2])", "parts=path.path.split('/');j=job('team-a' if path.path.endswith('/execute') else owner,parts[2])")
        (candidate/'app.py').write_text(code)
        result=grade_engineering(candidate,'B')
        self.assertIn('owner-isolation',result['critical_errors'])
    @unittest.skipUnless(sys.platform=='darwin','kernel boundary requires macOS')
    def test_candidate_cannot_read_controller_evidence(self):
        candidate=self.root/'candidate';candidate.mkdir();secret=self.root/'controller-secret';secret.write_text('hidden oracle')
        guard=f"try:\n    open({str(secret)!r}).read()\nexcept PermissionError:\n    pass\nelse:\n    raise RuntimeError('controller evidence was readable')\n"
        (candidate/'app.py').write_text(guard+Path(__file__).with_name('reference_app.py').read_text())
        result=grade_engineering(candidate,'A');self.assertTrue(result['behavioral_pass'],result)

if __name__=='__main__':unittest.main()
