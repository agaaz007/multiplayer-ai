import json,tempfile,unittest
from pathlib import Path
from mechanisms import audit,sha

def save(p,d):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(d))
RID='11111111-1111-1111-1111-111111111111';UID='22222222-2222-2222-2222-222222222222';KEY='opaque-operation-key-123456789'
class RecordUseTests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.r=Path(self.t.name);self.clock=0;self.files={}
  self.source=self.r/'pack/deltas/B/sources/B.json';save(self.source,{'id':'north-cap-v2','status':'accepted','owner':'Mira','accepted_cap':24})
  save(self.r/'pack/manifest.json',{'development':True,'stages':[{'id':'B','delta_dir':'deltas/B'}],'files':{'deltas/B/sources/B.json':sha(self.source)}})
  save(self.r/'sequence.json',{'arm':'ledger','status':'ended','pack':str(self.r/'pack')})
  save(self.r/'native-config.json',{'version':'fixture-v1'})
  self.w={'source':str(self.source),'sha256':sha(self.source),'pointer':'/accepted_cap','record_marker':'accepted_cap=24'}
  self.native_text='north-cap-v2 accepted_cap=24; pending key '+KEY
  self.add('A','ledger','ledger_record_start',{},f'Record {RID} "pilot" created on owned repo')
  self.add('B','ledger','ledger_record_update',{'action':'propose','record_id':RID,'text':self.native_text,'evidence':[{'session_id':'session-B','seq':8}]},f'Proposed next update {UID} on record')
  self.add('B','ledger','ledger_record_update',{'action':'confirm','record_id':RID,'update_id':UID},f'Confirmed next update {UID} on record (state_version now 2).')
  self.add('C','ledger','ledger_record_get',{'record_id':RID},f'record {RID} state v2\n- [confirmed] '+self.native_text)
  self.add('C','operations','lookup_operation',{'key':KEY},json.dumps({'key':KEY,'status':'completed','receipt_id':'receipt-original'}))
  p=self.r/'external-operations/events.jsonl';p.parent.mkdir();p.write_text('\n'.join(json.dumps(x)for x in [{'kind':'effect','stage':'B','key':KEY,'receipt_id':'receipt-original'},{'kind':'lookup','stage':'C','key':KEY,'status':'completed','receipt_id':'receipt-original'}]))
  sp=self.r/'stages/C/controller/submission/tree/continuity/state.json';save(sp,{'pending_operations':[{'key':KEY,'status':'completed','receipt_id':'receipt-original'}]})
  save(self.r/'stages/C/controller/delivery.json',{'received_monotonic_ms':999,'tree':{'files':{'continuity/state.json':sha(sp)}}})
 def add(self,stage,server,name,args,body):
  p=self.r/f'stages/{stage}/controller/native-{server}.jsonl';p.parent.mkdir(parents=True,exist_ok=True);self.clock+=10;i=self.clock
  req={'at_monotonic_ms':i,'direction':'request','message':{'id':i,'method':'tools/call','params':{'name':name,'arguments':args,'_meta':{'x-codex-turn-metadata':{'session_id':'session-'+stage}}}}}
  res={'at_monotonic_ms':i+1,'direction':'response','message':{'id':i,'result':{'content':[{'type':'text','text':body}]}}}
  with p.open('a')as f:f.write(json.dumps(req)+'\n'+json.dumps(res)+'\n')
 def edit(self,relative,fn):
  p=self.r/relative;rows=[json.loads(l)for l in p.read_text().splitlines()];fn(rows);p.write_text('\n'.join(json.dumps(x)for x in rows)+'\n')
 def test_real_chain_and_correction_binding_required(self):
  x=audit(self.r,self.w);self.assertTrue(x['admission_eligible']);self.assertEqual(x['structured_records']['status'],'trace_supported');self.assertIn('not_evaluated',x['causal_attribution'])
  self.assertFalse(audit(self.r)['admission_eligible'])
 def test_enabled_classifier_or_proposed_update_is_insufficient(self):
  self.edit('stages/C/controller/native-ledger.jsonl',lambda rs:rs[1]['message']['result']['content'][0].update(text=f'record {RID} state v2\n- [PROPOSED] '+self.native_text))
  self.assertFalse(audit(self.r,self.w)['admission_eligible'])
 def test_failed_confirmation_cannot_pass(self):
  self.edit('stages/B/controller/native-ledger.jsonl',lambda rs:rs[3]['message']['result'].update(isError=True))
  self.assertFalse(audit(self.r,self.w)['admission_eligible'])
 def test_wrong_record_or_stale_state_cannot_pass(self):
  self.edit('stages/C/controller/native-ledger.jsonl',lambda rs:rs[1]['message']['result']['content'][0].update(text=f'record {RID} state v1\n- [confirmed] '+self.native_text))
  self.assertFalse(audit(self.r,self.w)['admission_eligible'])
 def test_action_before_retrieval_cannot_pass(self):
  self.edit('stages/C/controller/native-operations.jsonl',lambda rs:rs[0].update(at_monotonic_ms=1))
  self.assertFalse(audit(self.r,self.w)['admission_eligible'])
 def test_missing_receipt_or_changed_delivery_cannot_pass(self):
  p=self.r/'external-operations/events.jsonl';p.write_text('');self.assertFalse(audit(self.r,self.w)['admission_eligible'])
 def test_unreviewed_or_wrong_correction_cannot_pass(self):
  w={**self.w,'record_marker':'accepted_cap=40'}
  with self.assertRaises(ValueError):audit(self.r,w)
 def test_same_session_is_not_fresh(self):
  self.edit('stages/C/controller/native-ledger.jsonl',lambda rs:rs[0]['message']['params']['_meta']['x-codex-turn-metadata'].update(session_id='session-B'))
  self.assertFalse(audit(self.r,self.w)['admission_eligible'])
 def test_wrong_operation_key_cannot_pass(self):
  self.edit('stages/C/controller/native-operations.jsonl',lambda rs:rs[0]['message']['params']['arguments'].update(key='different-operation-key-123456789'))
  self.assertFalse(audit(self.r,self.w)['admission_eligible'])
 def test_post_delivery_action_cannot_pass(self):
  save(self.r/'stages/C/controller/delivery.json',{'received_monotonic_ms':1})
  self.assertFalse(audit(self.r,self.w)['admission_eligible'])
 def test_mutated_correction_source_rejected(self):
  self.source.write_text('{}')
  with self.assertRaises(ValueError):audit(self.r,self.w)
 def test_infrastructure_abort_never_admits(self):
  save(self.r/'sequence.json',{'arm':'ledger','status':'infrastructure_aborted','pack':str(self.r/'pack')});self.assertFalse(audit(self.r,self.w)['admission_eligible'])
if __name__=='__main__':unittest.main()
 def test_agent_confirmed_label_from_truthful_acceptance_rendering_passes(self):
  label='- [agent-confirmed for benchmark-b by the session that proposed it; not reviewed by a person] '
  self.edit('stages/C/controller/native-ledger.jsonl',lambda rs:rs[1]['message']['result']['content'][0].update(text=f'record {RID} state v2\n'+label+self.native_text))
  self.assertTrue(audit(self.r,self.w)['admission_eligible'])
 def test_proposed_label_still_fails_even_when_it_mentions_confirmed(self):
  self.edit('stages/C/controller/native-ledger.jsonl',lambda rs:rs[1]['message']['result']['content'][0].update(text=f'record {RID} state v2\n- [PROPOSED] not confirmed: '+self.native_text))
  self.assertFalse(audit(self.r,self.w)['admission_eligible'])

