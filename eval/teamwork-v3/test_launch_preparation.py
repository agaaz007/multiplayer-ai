import tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import sequence,readiness,freeze_launches,run_readiness,disk_budget
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
if __name__=='__main__':unittest.main()
