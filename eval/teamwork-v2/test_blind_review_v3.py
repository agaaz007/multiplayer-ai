import importlib.util,pathlib,unittest,copy
spec=importlib.util.spec_from_file_location('blind_v3',pathlib.Path(__file__).with_name('blind-review-v3.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Blinding(unittest.TestCase):
 def test_nested_and_prose_identifiers_replaced_consistently(self):
  a={'facts':{'rate':.21,'approved':False},'affected_prior_work':[{'predecessor_source':'gfq9xbRLj2wL3rt7KVa4do','source_id':'source-015','source':'relay-north-smb-investment-stage-a-2026-09-12'}],'note':'Not approved: gfq9xbRLj2wL3rt7KVa4do and source-015 remain unavailable.','source_ids':['source-001','source-015']};before=copy.deepcopy(a)
  b,m=module.reblind(a,[{'id':'source-001'}]);self.assertEqual(a,before);self.assertEqual(b['facts'],a['facts']);self.assertEqual(b['source_ids'][0],'source-001');self.assertIn(m['gfq9xbRLj2wL3rt7KVa4do'],b['note']);self.assertIn('Not approved:',b['note']);self.assertIn('remain unavailable.',b['note']);self.assertEqual(len(m),3)
 def test_numeric_and_substantive_prose_unchanged(self):
  a={'facts':{'rate':.21},'text':'Relay North SMB plan; Priya must ratify the +3-point threshold. raw-evidence.json is public. Exact predecessor plan unavailable.'};b,m=module.reblind(a,[]);self.assertEqual(a,b);self.assertEqual(m,{})
 def test_alias_prefix_is_not_partially_replaced(self):
  a={'note':'source-015 source-015-extra source-001'};b,m=module.reblind(a,[{'id':'source-001'}]);self.assertEqual(b['note'],'prior-reference-001 source-015-extra source-001')
if __name__=='__main__':unittest.main()
