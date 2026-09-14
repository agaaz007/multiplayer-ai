import tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import sequence,readiness,freeze_launches,run_readiness,disk_budget,cohort_scope,prepare_cohort
from prepare_cohort import disk_plan

class LaunchPreparationTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.pack=readiness.build(self.root/'pack');self.runtime=self.root/'runtime';self.runtime.mkdir();(self.runtime/'runtime.js').write_text('// test runtime')
  budget=self.root/'budget.json';sequence.dump(budget,{'schema':'teamwork-budget/v2','maximum_usd':30,'entries':[]})
  self.entries=[]
  for arm in ('ledger','graphify','gbrain','supermemory'):
   root=self.root/arm;sequence.prepare(self.pack,root,'engineering',arm)
   for name in ('native-guide.md','proxy.json','proxy-ready.json'):(root/name).write_text('test fixture')
   ready=root/'ready.json';sequence.dump(ready,{'arm':arm,'native_version':'test','capture_recall_pass':True,'isolation_pass':True})
   template=root/'template';template.mkdir();(template/'hook.js').write_text('// immutable official template fixture')
   sequence.dump(root/'native-config.json',{'root':str(root),'arm':arm,'version':'test','readiness_receipt':str(ready),'guide_file':str(root/'native-guide.md'),'proxy_config':str(root/'proxy.json'),'proxy_ready_file':str(root/'proxy-ready.json'),'supermemory_template':str(template)})
   self.entries.append({'root':str(root),'arm':arm,'track':'engineering'})
  template=self.root/'supermemory/template/hook.js';self.inventory=self.root/'inventory.json';sequence.dump(self.inventory,{'files':{str(template):sequence.digest(template)}})
  self.prep=self.root/'preparation.json';sequence.dump(self.prep,{'schema':'teamwork-preparation/v3','budget_file':str(budget),'entries':self.entries,'disk_plan':disk_plan(self.entries,self.root)})
  p=patch.object(disk_budget,'REGISTRY_DIR',self.root/'registry');p.start();self.addCleanup(p.stop)
  p=patch.object(disk_budget.shutil,'disk_usage',return_value=SimpleNamespace(free=20*1024**3));self.free=p.start();self.addCleanup(p.stop)
 def freeze(self):return freeze_launches.freeze(self.prep,self.runtime,[self.inventory])
 def test_missing_native_readiness_creates_no_launches(self):
  (self.root/'supermemory/ready.json').unlink()
  with self.assertRaises(FileNotFoundError):self.freeze()
  self.assertFalse(any(self.root.glob('*/launch.json')))
 def test_modified_pinned_template_fails_before_launch(self):
  (self.root/'supermemory/template/hook.js').write_text('altered')
  with self.assertRaisesRegex(ValueError,'inventory changed'):self.freeze()
  self.assertFalse(any(self.root.glob('*/launch.json')))
 def test_four_ready_lanes_share_one_lease_and_cannot_refreeze(self):
  config=self.freeze()
  with self.assertRaisesRegex(ValueError,'freeze already exists'):self.freeze()
  leases=[]
  def dispatch(root,launch,disk_lease):leases.append(disk_lease.token);return {'status':'ended'}
  with patch.object(run_readiness.sequence,'run',side_effect=dispatch):result=run_readiness.run(config,self.root/'run')
  self.assertEqual(len(result['results']),4);self.assertEqual(len(set(leases)),1)
 def test_aggregate_disk_failure_precedes_any_dispatch(self):
  config=self.freeze();self.free.return_value.free=5*1024**3
  with patch.object(run_readiness.sequence,'run')as dispatch:
   with self.assertRaises(disk_budget.DiskReservationError):run_readiness.run(config,self.root/'run')
   dispatch.assert_not_called()
  self.assertFalse((self.root/'run').exists())

class SixArmPreparationTests(unittest.TestCase):
 """Decision 7A: products keep their proxy gates; controls need none; both freeze under one declared scope."""
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.pack=readiness.build(self.root/'pack');self.runtime=self.root/'runtime';self.runtime.mkdir();(self.runtime/'runtime.js').write_text('// test runtime')
  self.budget=self.root/'budget.json';sequence.dump(self.budget,{'schema':'teamwork-budget/v2','maximum_usd':30,'entries':[]})
  self.entries=[]
  for arm in cohort_scope.ALL_ARMS:
   root=self.root/arm;sequence.prepare(self.pack,root,'engineering',arm);(root/'native-guide.md').write_text('guide')
   ready=root/'ready.json';sequence.dump(ready,{'arm':arm,'native_version':'test','capture_recall_pass':True,'isolation_pass':True})
   native={'root':str(root),'arm':arm,'version':'test','readiness_receipt':str(ready),'guide_file':str(root/'native-guide.md')}
   if arm in cohort_scope.PRODUCT_ARMS:
    for name in ('proxy.json','proxy-ready.json'):(root/name).write_text('fixture')
    template=root/'template';template.mkdir();(template/'hook.js').write_text('// template')
    native.update(proxy_config=str(root/'proxy.json'),proxy_ready_file=str(root/'proxy-ready.json'),supermemory_template=str(template))
   sequence.dump(root/'native-config.json',native);self.entries.append({'root':str(root),'arm':arm,'track':'engineering'})
  template=self.root/'supermemory/template/hook.js';self.inventory=self.root/'inventory.json';sequence.dump(self.inventory,{'files':{str(template):sequence.digest(template)}})
  p=patch.object(disk_budget,'REGISTRY_DIR',self.root/'registry');p.start();self.addCleanup(p.stop)
  p=patch.object(disk_budget.shutil,'disk_usage',return_value=SimpleNamespace(free=40*1024**3));self.free=p.start();self.addCleanup(p.stop)
 def preparation(self,entries,scope):
  prep=self.root/'preparation.json';sequence.dump(prep,{'schema':'teamwork-preparation/v3','budget_file':str(self.budget),'entries':entries,'cohort_scope':scope,'disk_plan':disk_plan(entries,self.root)});return prep
 def test_six_arm_readiness_freezes_and_runs_six_lanes_without_control_proxies(self):
  scope=cohort_scope.batch_scope('six-arm','test authorization')
  config=freeze_launches.freeze(self.preparation(self.entries,scope),self.runtime,[self.inventory])
  matrix=sequence.load(config);self.assertEqual(len(matrix['entries']),6);self.assertEqual(matrix['cohort_scope'],scope)
  for entry in self.entries:
   launch=sequence.load(Path(entry['root'])/'launch.json');self.assertEqual(launch['authorization'],'test authorization')
   frozen=launch['frozen_files'];root=Path(entry['root']).resolve();self.assertIn(str(root/'native-guide.md'),frozen)
   if entry['arm'] in cohort_scope.CONTROL_ARMS:self.assertFalse(any(k.endswith('proxy.json') and k.startswith(str(root)) for k in frozen))
   elif entry['arm']!='ledger':self.assertIn(str(root/'proxy.json'),frozen)  # Ledger has no paid provider path either
  seen=[]
  def dispatch(root,launch,disk_lease):seen.append(sequence.load(Path(root)/'sequence.json')['arm']);return {'status':'ended'}
  with patch.object(run_readiness.sequence,'run',side_effect=dispatch):result=run_readiness.run(config,self.root/'run')
  self.assertEqual(sorted(seen),sorted(cohort_scope.ALL_ARMS));self.assertEqual(result['cohort_scope'],scope)
 def test_six_lanes_without_declared_scope_are_rejected(self):
  with self.assertRaisesRegex(ValueError,'declared'):freeze_launches.freeze(self.preparation(self.entries,None),self.runtime,[self.inventory])
  self.assertFalse(any(self.root.glob('*/launch.json')))
 def test_product_lane_still_requires_proxy_files(self):
  scope=cohort_scope.batch_scope('six-arm','test authorization');(self.root/'gbrain/proxy-ready.json').unlink()
  with self.assertRaises(FileNotFoundError):freeze_launches.freeze(self.preparation(self.entries,scope),self.runtime,[self.inventory])
 def test_control_batch_freezes_alone_with_smaller_reservation(self):
  controls=[e for e in self.entries if e['arm'] in cohort_scope.CONTROL_ARMS];scope=cohort_scope.batch_scope('controls','controls batch')
  config=freeze_launches.freeze(self.preparation(controls,scope),self.runtime,[self.inventory]);matrix=sequence.load(config)
  self.assertEqual({e['arm'] for e in matrix['entries']},set(cohort_scope.CONTROL_ARMS))
  summary=prepare_cohort.disk_plan_summary(matrix['disk_plan']);self.assertEqual(summary['total_gib'],4.0)
  with patch.object(run_readiness.sequence,'run',return_value={'status':'ended'}):result=run_readiness.run(config,self.root/'run')
  self.assertEqual(len(result['results']),2)
  # A products-batch config cannot admit control lanes and vice versa.
  matrix['cohort_scope']=cohort_scope.batch_scope('products','wrong batch');sequence.dump(self.root/'wrong.json',matrix)
  with self.assertRaisesRegex(ValueError,'declared four-product'):run_readiness.run(self.root/'wrong.json',self.root/'run2')


class DiskPlanSummaryTests(unittest.TestCase):
 def entries(self,arms,tracks=('pm','engineering')):
  return [{'root':'/x/'+t+'-'+a,'arm':a,'track':t} for a in arms for t in tracks]
 def test_six_arm_scored_totals_are_ten_gib(self):
  plan=disk_plan(self.entries(cohort_scope.ALL_ARMS),'/x');s=prepare_cohort.disk_plan_summary(plan)
  self.assertEqual((s['sequences'],s['lanes']),(12,6));self.assertEqual(s['retained_gib'],6.0);self.assertEqual(s['peak_gib'],1.5)
  self.assertEqual(s['overhead_gib'],0.5);self.assertEqual(s['margin_gib'],2.0);self.assertEqual(s['total_gib'],10.0)
  self.assertIn('12 x 512 MiB retained + 6 x 256 MiB peak + 512 MiB shared + 2 GiB margin = 10 GiB',plan['aggregate_basis'])
  self.assertEqual(plan['summary']['total_gib'],10.0);self.assertEqual(s['text'],'12 x 0.5 GiB retained = 6 GiB; 6 lane peaks = 1.5 GiB; shared overhead 0.5 GiB; margin 2 GiB; total 10 GiB')
 def test_batches_keep_per_sequence_estimates_and_shrink_only_the_aggregate(self):
  products=disk_plan(self.entries(cohort_scope.PRODUCT_ARMS),'/x');controls=disk_plan(self.entries(cohort_scope.CONTROL_ARMS),'/x')
  self.assertEqual(prepare_cohort.disk_plan_summary(products)['total_gib'],7.5);self.assertEqual(prepare_cohort.disk_plan_summary(controls)['total_gib'],5.0)
  for plan in (products,controls):
   for s in plan['sequences']:self.assertEqual((s['retained_output_bytes'],s['peak_working_capture_bytes']),(512*1024**2,256*1024**2))
  readiness_six=disk_plan(self.entries(cohort_scope.ALL_ARMS,('engineering',)),'/x');self.assertEqual(prepare_cohort.disk_plan_summary(readiness_six)['total_gib'],7.0)
  readiness_products=disk_plan(self.entries(cohort_scope.PRODUCT_ARMS,('engineering',)),'/x');self.assertEqual(prepare_cohort.disk_plan_summary(readiness_products)['total_gib'],5.5)
 def test_summary_matches_disk_budget_accounting(self):
  plan=disk_plan(self.entries(cohort_scope.ALL_ARMS),'/x')
  with patch.object(disk_budget,'filesystem',return_value=('dev','/x')):
   totals=disk_budget.remaining(disk_budget.normalize(plan,plan['sequences']))
  self.assertEqual(sum(totals.values()),prepare_cohort.disk_plan_summary(plan)['total_bytes'])


class PrepareCohortBatchTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.budget=self.root/'budget.json';sequence.dump(self.budget,{'schema':'teamwork-budget/v2','maximum_usd':30,'entries':[]})
 def test_controls_batch_prepares_only_control_roots_with_batch_scope(self):
  root=prepare_cohort.build(self.root/'cohort','%s'%self.budget,'controls','batch authorization')
  scored=sequence.load(root/'scored/preparation.json');ready=sequence.load(root/'readiness/preparation.json')
  self.assertEqual({e['arm'] for e in scored['entries']},set(cohort_scope.CONTROL_ARMS));self.assertEqual(len(scored['entries']),4);self.assertEqual(len(ready['entries']),2)
  self.assertEqual(scored['cohort_scope']['batch'],'controls');self.assertEqual(cohort_scope.expected_arms(scored),cohort_scope.CONTROL_ARMS)
  self.assertEqual(scored['disk_plan']['summary']['total_gib'],5.0);self.assertEqual(ready['disk_plan']['summary']['total_gib'],4.0)
  self.assertIn('control-readiness.mjs',' '.join(scored['required_before_freeze']))
  with self.assertRaisesRegex(ValueError,'arms must be one of'):prepare_cohort.build(self.root/'other',str(self.budget),'everything')
 def test_default_is_the_six_arm_cohort(self):
  root=prepare_cohort.build(self.root/'cohort',str(self.budget))
  scored=sequence.load(root/'scored/preparation.json')
  self.assertEqual(len(scored['entries']),12);self.assertEqual(cohort_scope.expected_arms(scored),cohort_scope.ALL_ARMS);self.assertEqual(scored['disk_plan']['summary']['total_gib'],10.0)
  for e in scored['entries']:self.assertTrue((Path(e['root'])/'sequence.json').exists())
if __name__=='__main__':unittest.main()


class LedgerVsControlsScopeTests(unittest.TestCase):
    def test_ledger_vs_controls_is_a_closed_declared_scope(self):
        import cohort_scope
        scope=cohort_scope.batch_scope('ledger-vs-controls','bake-off authorization')
        self.assertEqual(scope['included_arms'],['ledger','control-git','handoff-note'])
        self.assertEqual(sorted(scope['excluded_arms']),['gbrain','graphify','supermemory'])
        self.assertEqual(cohort_scope.expected_arms({'cohort_scope':scope}),('ledger','control-git','handoff-note'))
        self.assertEqual(cohort_scope.cohort_label(('ledger','control-git','handoff-note')),'ledger-vs-controls')
        self.assertEqual(cohort_scope.cohort_label(cohort_scope.PRODUCT_ARMS[:3]),'three-product')
        self.assertEqual(cohort_scope.cohort_label(cohort_scope.PRODUCT_ARMS),'four-product')
        self.assertIn('ledger-vs-controls',__import__('prepare_cohort').BATCHES)

