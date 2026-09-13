import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from fixtures import build, dump, pm_sources
from sequence import prepare

spec=importlib.util.spec_from_file_location('report_run',Path(__file__).with_name('report-run.py'))
report_run=importlib.util.module_from_spec(spec);spec.loader.exec_module(report_run)

class ReportTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve()
        self.pack=self.root/'pack';build(self.pack,137)
        self.sequence=self.root/'pm-fresh-agent';prepare(self.pack,self.sequence,'pm','fresh-agent')
        self.runtime=self.root/'runtime';(self.runtime/'eval').mkdir(parents=True)
        (self.runtime/'eval/sequence-codex.js').write_text('// fake-only runtime')
        self.profile=self.root/'profile.json';dump(self.profile,{'ca_file':'/controller/public-ca.pem'})
        self.launch=self.root/'launch.json';dump(self.launch,{'runtime':str(self.runtime),'model':'frozen-model','reasoning_effort':'medium',
            'stage_deadline_ms':600000,'scored':True,'stage_profiles':{stage:str(self.profile) for stage in 'ABCD'}})
        self.status=self.root/'matrix-status.json'
        dump(self.status,{'schema':'teamwork-matrix-run/v2','status':'running','elapsed_seconds':10,
            'preflight':{'arms':[{'arm':'fresh-agent','status':'ready','sequences':[{'root':str(self.sequence),'launch':str(self.launch)}]},
                                 {'arm':'mem0','status':'unavailable','reason':'example fixture-only missing native prerequisite','sequences':[]}]},
            'arms':{'fresh-agent':{'status':'running','sequences':{}},'mem0':{'status':'unavailable'}}})
    def tearDown(self):self.temp.cleanup()
    def deliver(self,timed_out=False):
        ctl=self.sequence/'stages/A/controller';submission=ctl/'submission';submission.mkdir()
        _,facts=pm_sources(137)
        dump(submission/'answer.json',{'facts':facts['A'],'source_ids':['strategy'],'recommendation':'Defer expansion pending an audit.'})
        digest=hashlib.sha256((submission/'answer.json').read_bytes()).hexdigest()
        dump(ctl/'delivery.json',{'elapsed_ms':1000,'answer_file_sha256':digest})
        state=json.loads((self.sequence/'sequence.json').read_text());state['executed']=True;state['status']='running'
        state['stages']['A']={'status':'finished','delivered':True,'timing_valid':not timed_out,
            'session':{'elapsed_ms':600001 if timed_out else 2000,'timed_out':timed_out,'exit_code':0,'usage':{'input_tokens':100,'cached_input_tokens':50,'output_tokens':20}},
            'grade':{'schema':'pm-grade/v2','passed':11,'applicable':11,'checks':[],'critical_errors':[],'factual_pass':True,'decision_quality':'not_evaluated'},
            'capture':{'exit_code':0,'elapsed_seconds':2,'timed_out':False}}
        dump(self.sequence/'sequence.json',state)
        dump(ctl/'native-capture-123.json',{'arm':'fresh-agent','captured':True,'elapsed_ms':2})
        dump(ctl/'native-capture-env.json',{'DO_NOT_COPY':'secret-env-fixture'})
        return ctl
    def test_partial_report_keeps_unknowns_and_unavailable_arms(self):
        report=report_run.summarize(self.status)
        self.assertEqual(len(report['stages']),4)
        self.assertEqual(report['stages'][0]['status'],'not_started')
        self.assertIsNone(report['stages'][0]['subscription_usage'])
        text=report_run.markdown(report)
        self.assertIn('mem0: unavailable',text);self.assertIn('unknown',text)
    def test_timely_delivery_survives_timeout_but_timing_failure_is_visible(self):
        self.deliver(timed_out=True)
        report=report_run.summarize(self.status);stage=report['stages'][0]
        self.assertTrue(stage['delivery_verified']);self.assertFalse(stage['timing_valid'])
        self.assertEqual(stage['grade']['passed_checks'],11)
        self.assertEqual(stage['decision_quality']['status'],'pending_independent_reviews')
        self.assertEqual(len(stage['native_capture']['receipts']),1)
        self.assertNotIn('secret-env-fixture',json.dumps(report))
        self.assertIn('do not rank this latency',report_run.markdown(report))
    def test_seed41_is_excluded(self):
        other=self.root/'development';build(other,41)
        state=json.loads((self.sequence/'sequence.json').read_text());state['pack']=str(other);state['pack_manifest_sha256']=report_run.digest(other/'manifest.json');dump(self.sequence/'sequence.json',state)
        report=report_run.summarize(self.status)
        self.assertEqual(report['stages'],[]);self.assertEqual(report['exclusions'][0]['seed'],41)
    def test_packets_bind_verified_answers_with_private_maps_and_no_model_call(self):
        self.deliver();out=self.root/'reviews'
        prepared=report_run.prepare_reviews(self.status,out,'fake fixture authorization')
        self.assertEqual(prepared['model_calls'],0)
        config=json.loads((out/'review-config.json').read_text());mapping=json.loads((out/'controller-map.json').read_text())
        case=config['cases'][0]
        self.assertRegex(case['id'],r'^case-[0-9a-f]{12}$')
        self.assertNotIn('fresh-agent',json.dumps(config));self.assertEqual(mapping['cases'][0]['arm'],'fresh-agent')
        self.assertEqual(config['ca_file'],'/controller/public-ca.pem')
        self.assertEqual((out/'controller-map.json').stat().st_mode&0o777,0o600)
        self.assertTrue(Path(case['packet'],'sources.json').is_file())
    def test_tampered_answer_is_not_eligible_for_review(self):
        ctl=self.deliver();(ctl/'submission/answer.json').write_text('{}')
        report=report_run.summarize(self.status)
        self.assertFalse(report['stages'][0]['delivery_verified'])
        self.assertEqual(report['stages'][0]['grade']['status'],'invalid_submission')
        with self.assertRaisesRegex(ValueError,'No verified'):report_run.prepare_reviews(self.status,self.root/'reviews','fake')
        self.assertFalse((self.root/'reviews').exists())
    def test_one_review_never_completes_quality_and_two_disagreeing_require_adjudication(self):
        self.deliver();out=self.root/'packets';report_run.prepare_reviews(self.status,out,'fake')
        mapping=json.loads((out/'controller-map.json').read_text());case=mapping['cases'][0]['case_id']
        results=self.root/'review-status.json';entry={'initial_reviews':[{'status':'reviewed'}],'status':'running'}
        dump(results,{'cases':{case:entry}})
        report=report_run.summarize(self.status,results,out/'controller-map.json')
        self.assertEqual(report['stages'][0]['decision_quality']['status'],'pending_independent_reviews')
        entry['initial_reviews'].append({'status':'reviewed'});entry['disagreement']={'needed':True};dump(results,{'cases':{case:entry}})
        report=report_run.summarize(self.status,results,out/'controller-map.json')
        self.assertEqual(report['stages'][0]['decision_quality']['status'],'pending_adjudication')
    def test_ended_invalid_reviews_are_not_evaluated_and_preserve_errors(self):
        stage={'sequence_root':'fixture','stage':'A','submission_sha256':'bound-answer'}
        mapping={'cases':[dict(stage,case_id='case-fixture')]}
        invalid={'reviewer':2,'role':'independent','status':'not_evaluated','errors':['unsupported source quote']}
        case={'status':'not_evaluated','initial_reviews':[{'status':'reviewed'},invalid], 'error':'retained case failure'}
        reviews={'status':'running','cases':{'case-fixture':case}}
        self.assertEqual(report_run.review_for(stage,mapping,reviews)['status'],'pending_independent_reviews')
        reviews['status']='ended';result=report_run.review_for(stage,mapping,reviews)
        self.assertEqual(result['status'],'not_evaluated')
        self.assertEqual(result['receipt_errors'][1],invalid)
        self.assertEqual(result['case_error'],'retained case failure')
        self.assertIn('without two valid',result['reason'])
        case['initial_reviews']=[{'status':'reviewed'},{'status':'reviewed'}]
        case['disagreement']={'needed':True};case['adjudication']={'reviewer':3,'role':'adjudicator','status':'not_evaluated','errors':['review session timed out']}
        reviews['status']='running'
        self.assertEqual(report_run.review_for(stage,mapping,reviews)['status'],'pending_adjudication')
        reviews['status']='ended';result=report_run.review_for(stage,mapping,reviews)
        self.assertEqual(result['status'],'not_evaluated')
        self.assertEqual(result['receipt_errors'],[case['adjudication']])
        self.assertIn('without valid required adjudication',result['reason'])
        self.assertEqual(report_run.review_for(stage,{'cases':[]},reviews)['status'],'not_evaluated')

if __name__=='__main__':unittest.main()
