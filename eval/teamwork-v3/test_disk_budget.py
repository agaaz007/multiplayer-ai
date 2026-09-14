import json,tempfile,unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import disk_budget as d

class DiskTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.registry=patch.object(d,'REGISTRY_DIR',self.root/'registry');self.registry.start();self.addCleanup(self.registry.stop)
  self.space=patch.object(d.shutil,'disk_usage',return_value=SimpleNamespace(free=100*d.GIB));self.free=self.space.start();self.addCleanup(self.space.stop)
 def plan(self,prefix='one',arms=('ledger','graphify','gbrain','supermemory')):
  members=[{'root':str(self.root/prefix/(arm+'-'+track)),'arm':arm,'track':track,'filesystem_path':str(self.root),'retained_output_bytes':d.GIB//2,'peak_working_capture_bytes':d.GIB//4,'basis':'explicit test estimates'} for arm in arms for track in ('pm','engineering')]
  return {'schema':'teamwork-disk-plan/v3','sequences':members,'shared':[{'filesystem_path':str(self.root),'overhead_bytes':d.GIB//2,'margin_bytes':2*d.GIB,'basis':'shared estimate'}]},members
 def test_both_tracks_retained_but_one_peak_per_lane(self):
  p,m=self.plan();self.assertEqual(sum(d.remaining(d.normalize(p,m)).values()),int(7.5*d.GIB))
 def test_joint_overcommit_rejected_even_when_each_lane_fits(self):
  self.free.return_value.free=6*d.GIB
  for arm in ('ledger','graphify','gbrain','supermemory'):
   p,m=self.plan(arms=(arm,));self.assertEqual(d.preview(p,m)['status'],'passed')
  p,m=self.plan()
  with self.assertRaises(d.DiskReservationError):d.reserve(p,m)
 def test_missing_estimate_fails_closed(self):
  p,m=self.plan();p['sequences'][0].pop('peak_working_capture_bytes')
  with self.assertRaises(d.DiskReservationError):d.reserve(p,m)
 def test_concurrent_controllers_cannot_both_spend_same_space(self):
  self.free.return_value.free=10*d.GIB
  def run(prefix):
   p,m=self.plan(prefix)
   try:return d.reserve(p,m)
   except d.DiskReservationError:return None
  with ThreadPoolExecutor(2) as pool:leases=list(pool.map(run,('one','two')))
  self.assertEqual(sum(x is not None for x in leases),1)
  next(x for x in leases if x).release()
 def test_crashed_owner_keeps_commitment(self):
  p,m=self.plan();lease=d.reserve(p,m)
  with d.locked() as (state,save):state['reservations'][lease.token]['owner_pid']=99999999;save()
  self.free.return_value.free=10*d.GIB;p,m=self.plan('two')
  with self.assertRaises(d.DiskReservationError):d.reserve(p,m)
 def test_runtime_abort_stops_other_lanes_and_release_waits(self):
  p,m=self.plan();lease=d.reserve(p,m);a=m[0]['root'];b=m[2]['root'];lease.start(a);lease.start(b)
  with self.assertRaises(d.DiskReservationError):lease.release()
  self.free.return_value.free=2*d.GIB
  with self.assertRaises(d.DiskReservationError):lease.guard(a)
  with self.assertRaises(d.DiskReservationError):lease.guard(b)
  lease.complete(a);lease.complete(b);lease.release()
 def test_tracks_with_shared_peak_cannot_overlap(self):
  p,m=self.plan();lease=d.reserve(p,m);lease.start(m[0]['root'])
  with self.assertRaises(d.DiskReservationError):lease.start(m[1]['root'])
  lease.complete(m[0]['root']);lease.start(m[1]['root']);lease.complete(m[1]['root']);lease.release()
if __name__=='__main__':unittest.main()
