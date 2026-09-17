import tempfile,unittest,json
from unittest.mock import patch
from pathlib import Path
from fixtures import ARMS
from readiness import build,correction
from sequence import validate_pack,dump,digest
import integrity
class ReadinessTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
 def test_same_probe_bytes_across_products_and_distinct_development_seed(self):
  p=build(self.root/'one');q=build(self.root/'two');a=validate_pack(p);b=validate_pack(q)
  self.assertEqual(a,b);self.assertTrue(a['development']);self.assertEqual(a['seed'],42);self.assertEqual(a['arms'],ARMS)
  self.assertEqual([s['id']for s in a['stages']],list('ABC'));self.assertEqual(a['stages'][2]['stress']['compact_token_limit'],4000)
  witness=correction(p);self.assertEqual(witness['sha256'],a['files']['deltas/B/sources/B.json'])
 def test_freeze_change_is_journaled_and_stops_attempt(self):
  f=self.root/'input';f.write_text('original');cfg={'frozen_files':{str(f):digest(f)}};integrity.check(self.root,cfg)
  f.write_text('changed')
  with self.assertRaises(integrity.FreezeError):integrity.check(self.root,cfg)
  event=json.loads((self.root/'interventions.jsonl').read_text());self.assertEqual(event['action'],'freeze violation')
  f.write_text('original')
  with self.assertRaises(integrity.FreezeError):integrity.check(self.root,cfg)
 def test_freeze_hashing_streams_without_whole_file_allocations(self):
  p=self.root/'large';p.write_bytes(b'abc123'*400000)
  expected=digest(p)
  with patch.object(Path,'read_bytes',side_effect=AssertionError('whole-file allocation forbidden')):
   self.assertEqual(digest(p),expected)
   integrity.check(self.root,{'frozen_files':{str(p):expected}})
 def test_manual_intervention_stops_even_if_source_hashes_match(self):
  integrity.record(self.root,'agaaz','native memory edit','integration investigation',['native record'])
  with self.assertRaises(integrity.FreezeError):integrity.check(self.root,{'frozen_files':{}})
if __name__=='__main__':unittest.main()


class CompactionLimitTests(unittest.TestCase):
    def test_readiness_pack_compaction_limit_is_configurable(self):
        import tempfile,json
        from pathlib import Path
        import readiness
        with tempfile.TemporaryDirectory() as d:
            default=json.loads((Path(readiness.build(Path(d)/'p4'))/'manifest.json').read_text())
            scored=json.loads((Path(readiness.build(Path(d)/'p12',42,12000))/'manifest.json').read_text())
        c=lambda m:[s for s in m['stages'] if s['id']=='C'][0]['stress']
        self.assertEqual(c(default),{'compact_token_limit':4000})
        self.assertEqual(c(scored),{'compact_token_limit':12000})
        self.assertEqual([s['stress'] for s in scored['stages'] if s['id']!='C'],[s['stress'] for s in default['stages'] if s['id']!='C'])

