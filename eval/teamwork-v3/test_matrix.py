import json
from pathlib import Path
import tempfile
import unittest
from fixtures import build
from sequence import prepare,dump,digest,load
from matrix import preflight,run,disk_preflight,DiskAdmissionError,MINIMUM_FREE_BYTES
from unittest.mock import patch
from types import SimpleNamespace
import cohort_scope

class MatrixAdmissionTests(unittest.TestCase):
    def setUp(self):
        disk_patch=patch('matrix.shutil.disk_usage',return_value=SimpleNamespace(free=10*1024**3))
        self.disk=disk_patch.start();self.addCleanup(disk_patch.stop)
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        registry=patch('disk_budget.REGISTRY_DIR',self.root/'disk-registry');registry.start();self.addCleanup(registry.stop)
        self.budget=self.root/'budget.json';dump(self.budget,{'maximum_usd':30})
        self.issues=self.root/'known-issues.json';dump(self.issues,{'schema':'teamwork-known-issues/v3','ledger_short_file_evidence':'test disclosure','supermemory_file_support':'test disclosure','intervention_policy':'stop and retain'})
        self.bound=self.root/'frozen-runtime.txt';self.bound.write_text('immutable runtime fixture')
        packs={t:build(self.root/'packs'/t,t,271,False) for t in ['pm','engineering']}
        import test_mechanisms, mechanisms
        fixture=test_mechanisms.RecordUseTests();fixture.setUp();self.addCleanup(fixture.doCleanups)
        proof=self.root/'record-use.json';dump(proof,mechanisms.audit(fixture.r,fixture.w))
        self.proof=proof
        self.packs=packs;self.launches=[];self.readies=[]
        lanes=[self.lane(arm) for arm in ['ledger','graphify','gbrain','supermemory']]
        self.config=self.root/'matrix.json';dump(self.config,self.matrix_config(lanes))
    def lane(self,arm):
        seqs=[]
        for t in ['pm','engineering']:
            r=self.root/'sequences'/f'{t}-{arm}';prepare(self.packs[t],r,t,arm)
            ready=r/'ready.json';dump(ready,{'arm':arm,'capture_recall_pass':True,'isolation_pass':True,'full_harness_pass':True,'native_version':'fixture-v1','record_use_audit':{'path':str(self.proof),'sha256':digest(self.proof)}})
            native=r/'native.json';dump(native,{'readiness_receipt':str(ready),'version':'fixture-v1'})
            launch=r/'launch.json';dump(launch,{'schema':'teamwork-launch/v3','authorization':'test only','execution_authorized':True,'paid_paths_gated':True,'maximum_approved_usd':30,
                'budget_file':str(self.budget),'native_config':str(native),'known_issues_file':str(self.issues),'frozen_files':{str(self.bound):digest(self.bound),str(self.issues):digest(self.issues)},
                'model':'same-model','reasoning_effort':'medium','capture_timeout_ms':300000,
                'runtime':str(self.root/'runtime'),'driver_argv':['node',str(self.bound),'run','{request}'],
                'stage_profiles':{s:str(r/'stages'/s/'controller/native-profile.json') for s in 'ABCD'}})
            self.launches.append(launch);self.readies.append(ready);seqs.append({'root':str(r),'launch':str(launch)})
        return {'arm':arm,'sequences':seqs}
    def matrix_config(self,lanes,scope=None):
        cfg={'schema':'teamwork-matrix/v3','arms':lanes,'disk_plan':{'schema':'teamwork-disk-plan/v3','sequences':[{'root':s['root'],'arm':a['arm'],'track':load(Path(s['root'])/'sequence.json')['track'],'filesystem_path':s['root'],'retained_output_bytes':256*1024**2,'peak_working_capture_bytes':64*1024**2,'basis':'test retention and peak'}for a in lanes for s in a['sequences']],'shared':[{'filesystem_path':str(self.root),'overhead_bytes':0,'margin_bytes':1024**3,'basis':'test shared margin'}]}}
        if scope is not None:cfg['cohort_scope']=scope
        return cfg
    def test_six_arm_scope_admits_twelve_sequences_and_controls_need_no_record_proof(self):
        lanes=load(self.config)['arms']+[self.lane(arm) for arm in cohort_scope.CONTROL_ARMS]
        for ready in self.readies[-4:]:self.change(ready,record_use_audit=None)
        dump(self.config,self.matrix_config(lanes));self.rejects_without_dispatch('declared competitor')
        dump(self.config,self.matrix_config(lanes,cohort_scope.batch_scope('six-arm','user declared the six-arm cohort')))
        result=preflight(self.config);self.assertEqual(len(result['arms']),6);self.assertEqual(len(result['disk_members']),12)
        self.assertEqual({a['arm'] for a in result['arms']},set(cohort_scope.ALL_ARMS))
        self.change(self.readies[-1],full_harness_pass=False)
        with self.assertRaisesRegex(ValueError,'full-harness'):preflight(self.config)
    def test_controls_batch_runs_two_lanes(self):
        lanes=[self.lane(arm) for arm in cohort_scope.CONTROL_ARMS]
        for ready in self.readies[-4:]:self.change(ready,record_use_audit=None)
        dump(self.config,self.matrix_config(lanes,cohort_scope.batch_scope('controls','controls batch')))
        with patch('matrix.run_sequence',return_value={'status':'ended','stages':{}}) as dispatch:state=run(self.config,self.root/'run-output')
        self.assertEqual(dispatch.call_count,4);self.assertEqual(set(state['arms']),set(cohort_scope.CONTROL_ARMS))
    def test_missing_known_issue_disclosure_rejected(self):
        self.change(self.launches[-1],known_issues_file=None)
        self.rejects_without_dispatch('known issues')
    def test_record_proof_must_match_native_version(self):
        root=self.launches[0].parent;self.change(root/'native.json',version='different')
        self.change(self.readies[0],native_version='different')
        self.rejects_without_dispatch('record-use audit native version')
    def test_ledger_requires_record_use_proof(self):
        self.change(self.readies[0],record_use_audit={})
        self.rejects_without_dispatch('record-use audit')
    def test_record_proof_cannot_be_changed_after_verification(self):
        self.change(self.proof,admission_eligible=False)
        self.rejects_without_dispatch('record-use audit freeze')
    def tearDown(self):self.tmp.cleanup()
    def change(self,file,**fields):d=load(file);d.update(fields);dump(file,d)
    def rejects_without_dispatch(self, pattern):
        out=self.root/'run-output'
        with patch('matrix.run_sequence') as dispatch:
            with self.assertRaisesRegex(ValueError,pattern):run(self.config,out)
            dispatch.assert_not_called()
        self.assertFalse(out.exists())
        self.assertFalse(any(self.root.rglob('attempt.json')))
    def test_development_pack_rejected_before_any_dispatch(self):
        root=self.launches[-1].parent;state=load(root/'sequence.json')
        pack=Path(state['pack']);self.change(pack/'manifest.json',development=True)
        self.rejects_without_dispatch('development')
    def test_prepared_manifest_hash_mismatch_rejected_before_dispatch(self):
        self.change(self.launches[-1].parent/'sequence.json',pack_manifest_sha256='changed')
        self.rejects_without_dispatch('pack/transport freeze')
    def test_prepared_transport_hash_mismatch_rejected_before_dispatch(self):
        self.change(self.launches[-1].parent/'sequence.json',transport_sha256='changed')
        self.rejects_without_dispatch('pack/transport freeze')
    def test_mandatory_launch_fields_checked_for_last_lane_before_any_dispatch(self):
        launch=self.launches[-1];original=load(launch)
        for key in ['authorization','runtime','model','reasoning_effort','driver_argv','stage_profiles','frozen_files']:
            with self.subTest(key=key):
                data=dict(original);data.pop(key);dump(launch,data)
                self.rejects_without_dispatch('launch gates|freeze |driver argv|profiles')
                dump(launch,original)
    def test_unfrozen_driver_input_rejected_before_dispatch(self):
        driver=self.root/'unfrozen-driver.mjs';driver.write_text('// fake only')
        self.change(self.launches[-1],driver_argv=['node',str(driver),'{request}'])
        self.rejects_without_dispatch('missing from frozen_files')
    def test_bad_capture_deadline_rejected_before_dispatch(self):
        self.change(self.launches[-1],capture_timeout_ms=-1)
        self.rejects_without_dispatch('positive capture')
    def test_v3_contract_removes_old_transport_and_delivery_footer(self):
        pack=Path(load(self.launches[-1].parent/'sequence.json')['pack'])
        contract=(pack/'deltas/A/release/API-A.md').read_text()
        self.assertNotIn('all arms may use ordinary Git',contract)
        self.assertNotIn('Return answer.json',contract)
        self.assertIn('deliver_answer({answer:{...}})',contract)
        self.assertIn('no predecessor workspace or Git history',contract)
        for stage in 'BCD':
            addition=(pack/f'deltas/{stage}/release/API-{stage}.md').read_text()
            self.assertIn('\n'+stage+':',addition)
            self.assertNotIn('\nA:',addition)
    def test_matching_four_product_two_track_matrix(self):
        p=preflight(self.config);self.assertEqual(len(p['arms']),4);self.assertEqual(set(p['comparisons']),{'pm','engineering'})
        self.assertFalse(any(p.exists() for p in self.root.rglob('attempt.json')))
    def test_explicit_three_product_cohort_admits_complete_six_sequences(self):
        cfg=load(self.config);cfg['arms']=cfg['arms'][:3]
        cfg['disk_plan']['sequences']=[s for s in cfg['disk_plan']['sequences'] if s['arm']!='supermemory']
        dump(self.config,cfg)
        self.rejects_without_dispatch('declared competitor')
        cfg['cohort_scope']={'included_arms':['ledger','graphify','gbrain'],'excluded_arms':['supermemory'],'authorization':'User explicitly skips Supermemory'}
        dump(self.config,cfg);result=preflight(self.config)
        self.assertEqual(len(result['arms']),3)
        self.assertEqual(len(result['disk_members']),6)
        self.assertEqual(result['cohort_scope'],cfg['cohort_scope'])
        cfg['arms'].pop();dump(self.config,cfg)
        self.rejects_without_dispatch('declared competitor')
    def test_scope_cannot_silently_exclude_another_product(self):
        cfg=load(self.config);cfg['cohort_scope']={'included_arms':['ledger','graphify'],'excluded_arms':['gbrain','supermemory'],'authorization':'bad scope'}
        dump(self.config,cfg);self.rejects_without_dispatch('authorized three-product')
    def test_transport_probe_cannot_admit_scored_run(self):
        self.change(self.readies[0],full_harness_pass=False)
        with self.assertRaisesRegex(ValueError,'full-harness'):preflight(self.config)
    def test_different_native_version_rejected(self):
        self.change(self.readies[0],native_version='older')
        with self.assertRaisesRegex(ValueError,'version mismatch'):preflight(self.config)
    def test_different_model_rejected(self):
        self.change(self.launches[2],model='different-model')
        with self.assertRaisesRegex(ValueError,'mismatched'):preflight(self.config)
    def test_budget_cannot_reset_for_one_product(self):
        second=self.root/'second-budget.json';dump(second,{'maximum_usd':30});self.change(self.launches[0],budget_file=str(second))
        with self.assertRaisesRegex(ValueError,'one budget'):preflight(self.config)
    def test_previously_attempted_sequence_rejected(self):
        (self.launches[0].parent/'attempt.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'already attempted'):preflight(self.config)
    def test_frozen_executable_mutation_rejected(self):
        self.bound.write_text('mutated')
        with self.assertRaisesRegex(ValueError,'freeze changed'):preflight(self.config)
    def test_low_disk_blocks_entire_matrix_before_output_or_attempt(self):
        self.disk.return_value=SimpleNamespace(free=MINIMUM_FREE_BYTES-1)
        out=self.root/'new-parent/run-output'
        with patch('matrix.run_sequence') as dispatch:
            with self.assertRaises(DiskAdmissionError) as caught:run(self.config,out)
            dispatch.assert_not_called()
        self.assertFalse(out.parent.exists());self.assertFalse(any(self.root.rglob('attempt.json')))
        receipt=caught.exception.receipt
        self.assertEqual(receipt['status'],'rejected')
        self.assertEqual(receipt['minimum_free_bytes'],5*1024**3)
        self.assertEqual(receipt['checks'][0]['available_bytes'],MINIMUM_FREE_BYTES-1)
        self.assertIn(str(out.resolve()),receipt['checks'][0]['paths'])
    def test_exact_five_gib_admits_and_retains_actual_measurement(self):
        self.disk.return_value=SimpleNamespace(free=MINIMUM_FREE_BYTES)
        plan=preflight(self.config)
        self.assertEqual(plan['disk_admission']['status'],'passed')
        self.assertEqual(plan['disk_admission']['checks'][0]['available_bytes'],5*1024**3)
        self.assertFalse(any(self.root.rglob('attempt.json')))
    def test_unknown_disk_capacity_fails_closed_without_output(self):
        self.disk.side_effect=OSError('disk usage unavailable')
        out=self.root/'run-output'
        with patch('matrix.run_sequence') as dispatch:
            with self.assertRaisesRegex(OSError,'disk usage unavailable'):run(self.config,out)
            dispatch.assert_not_called()
        self.assertFalse(out.exists())

if __name__=='__main__':unittest.main()


class ApiBClarificationTests(unittest.TestCase):
    def test_api_b_states_execute_and_get_response_fields(self):
        import tempfile,fixtures
        from pathlib import Path
        with tempfile.TemporaryDirectory() as d:
            root=fixtures.build(Path(d)/'pack','engineering',271,True)
            text=(Path(root)/'deltas/B/release/API-B.md').read_text()
            self.assertIn('{id,key,payload,state,receipt_id}',text)
            self.assertIn('GET /jobs/ID returns that same persisted job body, including state and receipt_id',text)
            self.assertNotIn('reply 200.\nProvider failure',text)
            a=(Path(root)/'deltas/A/release/API-A.md').read_text()
            self.assertNotIn('receipt_id',a)

