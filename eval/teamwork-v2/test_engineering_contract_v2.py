import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from grade_engineering_contract_v2 import grade,regrade_all


class ContractAmendmentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.reference=Path(__file__).with_name('reference_app.py').read_text()
    def tearDown(self):self.temp.cleanup()
    def candidate(self,code):
        folder=self.root/'candidate';folder.mkdir();(folder/'app.py').write_text(code);return folder
    def test_reference_passes_all_stages(self):
        candidate=self.candidate(self.reference)
        for stage in 'ABCD':
            result=grade(candidate,stage);self.assertTrue(result['behavioral_pass'],result)
    def test_receipt_only_success_response_is_contract_equivalent(self):
        code=self.reference.replace("return (200,state(j,'completed',receipt['receipt_id'])) if status==200 else (202,j)",
            "return (200,{'receipt_id':state(j,'completed',receipt['receipt_id'])['receipt_id'],'key':j['id']}) if status==200 else (202,j)")
        code=code.replace("if j['state']=='completed':return 200,j", "if j['state']=='completed':return 200,{'receipt_id':j['receipt_id'],'key':j['id']}")
        result=grade(self.candidate(code),'B');self.assertTrue(result['behavioral_pass'],result)
    def test_missing_response_receipt_fails(self):
        code=self.reference.replace("return (200,state(j,'completed',receipt['receipt_id'])) if status==200 else (202,j)",
            "return (200,{'state':state(j,'completed',receipt['receipt_id'])['state']}) if status==200 else (202,j)")
        result=grade(self.candidate(code),'B')
        self.assertIn('execution-receipt-and-restart-replay',result['critical_errors'])
    def test_fabricated_stored_and_returned_receipt_fails(self):
        code=self.reference.replace("state(j,'completed',receipt['receipt_id'])","state(j,'completed','fabricated-receipt')")
        result=grade(self.candidate(code),'B')
        self.assertIn('execution-receipt-and-restart-replay',result['critical_errors'])
        self.assertIn('unknown-outcome-reconciliation',result['critical_errors'])
    def test_correct_response_but_wrong_persisted_receipt_fails(self):
        code=self.reference.replace("if status==200 else (202,j)","if status==200 else (202,j)")
        code=code.replace("return (200,state(j,'completed',receipt['receipt_id'])) if status==200 else (202,j)",
            "return (200,{'receipt_id':receipt['receipt_id'],'state':state(j,'completed','wrong-stored-receipt')['state']}) if status==200 else (202,j)")
        result=grade(self.candidate(code),'B')
        self.assertIn('execution-receipt-and-restart-replay',result['critical_errors'])
    def test_blind_resend_and_unresolved_unknown_still_fail(self):
        code=self.reference.replace("if j['state']=='outcome_unknown':","if False:")
        result=grade(self.candidate(code),'B')
        self.assertIn('unknown-outcome-reconciliation',result['critical_errors'])
        self.assertIn('absent-receipt-stays-unknown',result['critical_errors'])
    def test_known_receipt_without_persisting_completed_state_fails(self):
        code=self.reference.replace("state(j,'completed',receipt['receipt_id'])","state(j,'outcome_unknown',receipt['receipt_id'])")
        result=grade(self.candidate(code),'B')
        self.assertIn('execution-receipt-and-restart-replay',result['critical_errors'])
        self.assertIn('unknown-outcome-reconciliation',result['critical_errors'])
    def test_completed_replay_duplicate_effect_fails(self):
        code=self.reference.replace("if j['state']=='completed':return 200,j","if False:return 200,j")
        result=grade(self.candidate(code),'B')
        self.assertIn('execution-receipt-and-restart-replay',result['critical_errors'])
        self.assertIn('concurrent-execution-single-effect',result['critical_errors'])
    def test_matrix_must_finish_before_uniform_regrade(self):
        status=self.root/'status.json';status.write_text(json.dumps({'schema':'teamwork-matrix-run/v2','status':'running'}))
        with self.assertRaisesRegex(ValueError,'only after'):regrade_all(status,self.root/'out')
        self.assertFalse((self.root/'out').exists())
    def test_immutable_ledger_b_positive_diagnostic(self):
        repo=Path(__file__).resolve().parents[2]
        candidate=repo/'.context/teamwork-v2-live-20260912/scored/sequences/engineering-ledger/stages/B/controller/submission/tree'
        if not candidate.is_dir():self.skipTest('retained local diagnostic artifact absent')
        before={str(p.relative_to(candidate)):hashlib.sha256(p.read_bytes()).hexdigest() for p in candidate.rglob('*') if p.is_file()}
        result=grade(candidate,'B');self.assertTrue(result['behavioral_pass'],result)
        after={str(p.relative_to(candidate)):hashlib.sha256(p.read_bytes()).hexdigest() for p in candidate.rglob('*') if p.is_file()}
        self.assertEqual(before,after)


if __name__=='__main__':unittest.main()
