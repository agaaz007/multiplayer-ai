"""Trace-supported native work-record use, never a causal treatment estimate.

Parse the pinned Ledger protocol conservatively. Unknown response shapes remain
not_evaluated. A controller-supplied assertion or enabled classifier cannot pass.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

UUID=r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text())
def text(m):return '\n'.join(c.get('text','') for c in m.get('result',{}).get('content',[]) if c.get('type')=='text')
def calls(root,stage,server):
    p=Path(root)/'stages'/stage/'controller'/('native-'+server+'.jsonl')
    if not p.is_file():return []
    requests={};out=[]
    for no,line in enumerate(p.read_text().splitlines(),1):
        e=json.loads(line);m=e.get('message',{})
        if e.get('direction')=='request' and m.get('method')=='tools/call':requests[m['id']]=(no,e)
        elif e.get('direction')=='response' and m.get('id') in requests:
            n,q=requests.pop(m['id']);params=q['message']['params'];body=text(m)
            meta=params.get('_meta',{}).get('x-codex-turn-metadata',{})
            out.append({'tool':params['name'],'args':params.get('arguments',{}),'body':body,
                'session_id':meta.get('session_id'),'request_time':q['at_monotonic_ms'],'response_time':e['at_monotonic_ms'],
                'success':not m.get('error') and not m.get('result',{}).get('isError') and not re.search(r'\bfailed:',body,re.I),
                'evidence':{'path':str(p.resolve()),'sha256':sha(p),'request_line':n,'response_line':no,'call_id':m['id']}})
    return out

CONFIRMED_LABEL=re.compile(r'^\s*-?\s*\[(confirmed|agent-confirmed\b[^\]]*|accepted by [^\]]+)\]')

def audit(root,correction=None):
    root=Path(root).resolve();state=read(root/'sequence.json')
    result={'schema':'teamwork-mechanism-audit/v3','root':str(root),'arm':state['arm'],
        'structured_records':{'status':'not_evaluated','reason':'complete supported record chain absent'},
        'causal_attribution':'not_evaluated; traces show use/association, not the benefit caused by each mechanism',
        'snapshot_retrieval_overlap':'possible; no exclusivity inferred from a record/action match'}
    if state['arm']!='ledger':
        result['structured_records']['reason']='Ledger work-record protocol is not imposed on other products'
        return result
    a,b,c=(calls(root,s,'ledger') for s in 'ABC')
    operations=calls(root,'C','operations')
    failures=[{'stage':s,'tool':x['tool'],'evidence':x['evidence'],'error':x['body']}for s,cc in [('A',a),('B',b),('C',c)]for x in cc if not x['success']]
    result['native_errors']=failures
    files={str(root/'sequence.json'):sha(root/'sequence.json')}
    pack_manifest=Path(state['pack'])/'manifest.json'
    result['development']=read(pack_manifest).get('development')
    files[str(pack_manifest)]=sha(pack_manifest)
    native_config=root/'native-config.json'
    result['native_version']=read(native_config).get('version') if native_config.exists() else None
    if native_config.exists():files[str(native_config)]=sha(native_config)
    for stage in 'ABC':
        for server in ['ledger','operations']:
            p=root/'stages'/stage/'controller'/('native-'+server+'.jsonl')
            if p.exists():files[str(p)]=sha(p)
    marker=None;source_id=None
    if correction is not None:
        pack=Path(state['pack']).resolve();manifest=read(pack/'manifest.json');source=Path(correction['source']).resolve();relative=source.relative_to(pack).as_posix()
        bstage=next(x for x in manifest['stages']if x['id']=='B')
        if not relative.startswith(bstage['delta_dir']+'/')or manifest['files'].get(relative)!=sha(source)or sha(source)!=correction['sha256']:raise ValueError('correction must bind frozen B release bytes')
        doc=read(source);value=doc
        for segment in correction['pointer'].split('/')[1:]:value=value[segment.replace('~1','/').replace('~0','~')]
        marker=correction['record_marker'];source_id=doc.get('id')
        if doc.get('status')!='accepted' or not doc.get('owner')or not source_id or marker!=correction['pointer'].split('/')[-1]+'='+str(value):raise ValueError('accepted source/value marker mismatch')
        files[str(source)]=sha(source)
    for s in 'BC':
        p=root/'stages'/s/'controller/delivery.json'
        if p.exists():files[str(p)]=sha(p)
    provider=root/'external-operations/events.jsonl'
    events=[json.loads(l)for l in provider.read_text().splitlines()]if provider.exists() else []
    if provider.exists():files[str(provider)]=sha(provider)
    created=[]
    for x in a:
        m=re.search(r'^Record ('+UUID+r') .* created ',x['body'])
        if x['tool']=='ledger_record_start' and x['success'] and m:created.append((m[1],x))
    candidates=[]
    for rid,start in created:
        for proposed in b:
            arg=proposed['args'];m=re.search(r'^Proposed \w+ update ('+UUID+r') ',proposed['body'])
            if proposed['tool']!='ledger_record_update' or not proposed['success'] or arg.get('action')!='propose' or arg.get('record_id')!=rid or not m or not arg.get('evidence'):continue
            update=m[1];native_text=arg.get('text','')
            for confirmed in b:
                ca=confirmed['args'];version=re.search(r'Confirmed \w+ update '+re.escape(update)+r'.*state_version now (\d+)',confirmed['body'])
                if confirmed['tool']!='ledger_record_update' or not confirmed['success'] or ca.get('action')!='confirm' or ca.get('record_id')!=rid or ca.get('update_id')!=update or not version or confirmed['request_time']<=proposed['response_time']:continue
                for retrieved in c:
                    ra=retrieved['args'];body=retrieved['body'];sv=re.search(r'\bstate v(\d+)',body)
                    if retrieved['tool'] not in ['ledger_record_get','ledger_resume'] or not retrieved['success'] or ra.get('record_id')!=rid or rid not in body or not sv or int(sv[1])<int(version[1]):continue
                    # Exact confirmed state line, not PROPOSED, must carry the same text. The runtime labelled
                    # confirmed lines '[confirmed]' until 2026-09-13; the truthful-acceptance rendering now writes
                    # '[agent-confirmed for <who> ...; not reviewed by a person]' (or '[accepted by <person>]').
                    if not any(CONFIRMED_LABEL.match(line) and native_text in line for line in body.splitlines()):continue
                    ids=[x['session_id']for x in [start,proposed,retrieved]]
                    if any(not i for i in ids)or len(set(ids))!=3:continue
                    if not start['response_time']<proposed['request_time']<confirmed['response_time']<retrieved['request_time']:continue
                    for action in operations:
                        key=action['args'].get('key')
                        if action['tool']!='lookup_operation' or not action['success'] or not key or len(key)<16 or key not in native_text or action['request_time']<=retrieved['response_time'] or action['session_id']!=retrieved['session_id']:continue
                        effects=[e for e in events if e.get('kind')=='effect' and e.get('stage')=='B' and e.get('key')==key]
                        lookups=[e for e in events if e.get('kind')=='lookup' and e.get('stage')=='C' and e.get('key')==key and e.get('status')=='completed']
                        if len(effects)!=1 or not any(e.get('receipt_id')==effects[0].get('receipt_id') for e in lookups):continue
                        if key not in action['body'] or effects[0].get('receipt_id','__missing__') not in action['body']:continue
                        delivery=root/'stages/C/controller/delivery.json';tree=root/'stages/C/controller/submission/tree';sp=tree/'continuity/state.json'
                        if not delivery.exists()or not sp.exists():continue
                        d=read(delivery)
                        if d.get('received_monotonic_ms',0)<=action['response_time']:continue
                        if d.get('tree',{}).get('files',{}).get('continuity/state.json')!=sha(sp):continue
                        pending=read(sp).get('pending_operations',[])
                        if not any(o.get('key')==key and o.get('status')=='completed' and o.get('receipt_id')==effects[0]['receipt_id']for o in pending):continue
                        files[str(sp)]=sha(sp)
                        candidates.append({'record_id':rid,'update_id':update,'confirmed_state_version':int(version[1]),'retrieved_state_version':int(sv[1]),'sessions':ids,'confirmed_text':native_text,'native_evidence_refs':arg['evidence'],'pending_key':key,'correction_source_verified':bool(marker and marker in native_text and source_id in native_text),
                            'chain':{n:x['evidence'] for n,x in [('created',start),('proposed',proposed),('confirmed',confirmed),('retrieved',retrieved),('acted',action)]}})
    result['structured_records']={'status':'trace_supported' if candidates else 'not_evaluated','chains':candidates,
        'reason':'created, evidence-backed updated, confirmed, fresh-session retrieved and bound to observed action+delivery' if candidates else 'complete successful confirmed-record/action/delivery chain absent',
        'correction_semantics':'requires independent source review; confirmation is not proof of human approval'}
    result['input_hashes']=files
    for chain in candidates:
        for e in chain['chain'].values():result['input_hashes'][e['path']]=e['sha256']
    result['correction_source_binding']=correction
    result['admission_eligible']=result['development'] is True and state.get('status')=='ended' and any(x['correction_source_verified']for x in candidates)
    return result

def verify_admission(file, expected_hash, native_version=None):
    """Recompute from bound originals; a hand-written 'passed' receipt is insufficient."""
    file=Path(file)
    if sha(file)!=expected_hash:raise ValueError('record-use audit freeze changed')
    receipt=read(file)
    if receipt.get('schema')!='teamwork-mechanism-audit/v3' or receipt.get('admission_eligible') is not True:
        raise ValueError('record-use audit requires a successful corrected-record action chain')
    if native_version is not None and receipt.get('native_version')!=native_version:raise ValueError('record-use audit native version differs from scored version')
    if not receipt.get('input_hashes'):raise ValueError('record-use audit originals missing')
    for path,digest in receipt['input_hashes'].items():
        if sha(path)!=digest:raise ValueError('record-use audit original changed: '+path)
    actual=audit(receipt['root'],receipt.get('correction_source_binding'))
    if actual!=receipt or actual.get('admission_eligible') is not True:
        raise ValueError('record-use audit does not reproduce from native traces')
    return receipt

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--out',required=True);p.add_argument('--correction');a=p.parse_args()
    with Path(a.out).open('x')as f:json.dump(audit(a.root,read(a.correction)if a.correction else None),f,indent=2);f.write('\n')
