"""Check objective facts only. Never infer decision quality from keywords."""
import json
import math
import re
from pathlib import Path
from fixtures import validate

def normalized_fact(key, value):
    """Only documented labels vary; never normalize population or authority away."""
    if not isinstance(value, str): return value
    label = re.sub(r'[\s_-]+', ' ', value.strip().casefold())
    aliases = {
        'population': {'north smb workspace': 'north_smb_workspaces',
                       'north smb workspaces': 'north_smb_workspaces'},
        'analysis_unit': {'workspace': 'workspace', 'workspaces': 'workspace'},
    }
    return aliases.get(key, {}).get(label, value)


def grade(pack, stage, answer):
    validate(pack)
    pack = Path(pack)
    expected = json.loads((pack/'controller/pm-expected.json').read_text())[stage]
    sources = json.loads((pack/'agent/pm'/stage/'raw-evidence.json').read_text())
    visible = {s['id'] for s in sources}
    checks = []
    def check(name, passed, observed=None):
        checks.append({'id':name,'passed':bool(passed),'observed':observed})
    if not isinstance(answer, dict):
        return {'schema':'pm-grade/v2','error':'answer must be an object','factual_pass':False,
                'decision_quality':'not_evaluated','critical_errors':['invalid answer']}
    facts = answer.get('facts')
    facts = facts if isinstance(facts,dict) else {}
    for key, value in expected.items():
        got = facts.get(key)
        if isinstance(value,bool): valid = type(got) is bool and got == value
        elif isinstance(value,(int,float)):
            valid = type(got) in (int,float) and math.isfinite(got) and math.isclose(got,value,rel_tol=1e-7,abs_tol=1e-8)
        else: valid = type(got) is type(value) and normalized_fact(key,got) == normalized_fact(key,value)
        check('fact:'+key,valid,got)
    ids = answer.get('source_ids')
    valid_ids = isinstance(ids,list) and len(ids)>0 and all(isinstance(x,str) and x in visible for x in ids)
    check('citations_visible',valid_ids,ids)
    allocation = answer.get('allocation')
    valid_allocation = isinstance(allocation,list) and all(isinstance(x,dict)
        and isinstance(x.get('option'),str) and bool(x['option'].strip())
        and type(x.get('engineer_weeks')) in (int,float)
        and math.isfinite(x['engineer_weeks']) and x['engineer_weeks']>=0 for x in allocation)
    total = sum(x['engineer_weeks'] for x in allocation) if valid_allocation else None
    check('capacity',valid_allocation and total<=expected['capacity_engineer_weeks'],total)
    check('recommendation_present',isinstance(answer.get('recommendation'),str) and bool(answer['recommendation'].strip()))
    critical = []
    if valid_allocation and total > expected['capacity_engineer_weeks']:
        critical.append('allocation exceeds accepted capacity')
    if stage == 'D':
        action = answer.get('rollout_action')
        check('mandatory_stop',action in ('pause','rollback'),action)
        if action not in ('pause','rollback'): critical.append('mandatory stop not applied to affected pilot')
    return {'schema':'pm-grade/v2','stage':stage,'checks':checks,
            'passed':sum(x['passed'] for x in checks),'applicable':len(checks),
            'factual_pass':all(x['passed'] for x in checks),'critical_errors':critical,
            'decision_quality':'not_evaluated','reuse':'not_evaluated',
            'limitations':['Valid source IDs do not prove support or actual predecessor retrieval.',
                           'Independent blind reasoning review and trace-backed reuse review are still required.']}

def review_packet(answer, out, sources=None):
    """Keep source/native identifiers private; flag residual product naming for review."""
    import re
    out = Path(out); out.mkdir(parents=True,exist_ok=False)
    mapping = {}
    sources = sources or []
    source_ids = [source['id'] for source in sources]
    if any(not isinstance(identity,str) or not identity for identity in source_ids) or len(set(source_ids)) != len(source_ids):
        raise ValueError('review sources must have unique nonempty string IDs')
    for identity in source_ids:
        mapping[json.dumps(identity)] = f'source-{len(mapping)+1:03d}'
    def redact(value,key=''):
        if key == 'reuse_evidence': return '[withheld for separate continuity review]'
        if key in ('source_ids','evidence_ids') and isinstance(value,list):
            result=[]
            for item in value:
                original=json.dumps(item,sort_keys=True)
                if original not in mapping: mapping[original]=f'source-{len(mapping)+1:03d}'
                result.append(mapping[original])
            return result
        if isinstance(value,dict):
            return {k:redact(v,k) for k,v in value.items() if k not in ('arm','product','model','cost','usage','latency','native_tool')}
        if isinstance(value,list): return [redact(v) for v in value]
        if isinstance(value,str):
            # Bind inline citations to the same aliases as structured citations.
            # Replace once so a source called source-001 cannot cascade aliases.
            aliases = {json.loads(original):alias for original,alias in mapping.items()
                       if isinstance(json.loads(original),str)}
            if aliases:
                pattern = r'(?<![\w-])(?:'+'|'.join(re.escape(x) for x in sorted(aliases,key=len,reverse=True))+r')(?![\w-])'
                value = re.sub(pattern,lambda match:aliases[match.group()],value)
            return re.sub(r'\b(ledger|supermemory|mem0|gbrain|graphify)\b','[memory product]',value,flags=re.I)
        return value
    def collect(value):
        if isinstance(value,dict):
            for key,items in value.items():
                if key == 'reuse_evidence': continue
                if key in ('source_ids','evidence_ids') and isinstance(items,list):
                    for item in items:
                        original=json.dumps(item,sort_keys=True)
                        if original not in mapping: mapping[original]=f'source-{len(mapping)+1:03d}'
                else: collect(items)
        elif isinstance(value,list):
            for item in value: collect(item)
    collect(answer)
    packet = redact(answer)
    public_sources=[{**source,'id':mapping[json.dumps(source['id'])]} for source in sources or []]
    (out/'answer.json').write_text(json.dumps(packet,indent=2)+'\n')
    (out/'sources.json').write_text(json.dumps(public_sources,indent=2)+'\n')
    (out/'controller-source-map.json').write_text(json.dumps(mapping,indent=2)+'\n')
    (out/'review-form.json').write_text(json.dumps({'reviewer':None,'reviewer_kind':None,
        'blinding_verified':False,'dimensions':{k:{'score':None,'evidence':[]} for k in
        ['framing','synthesis','alternatives','uncertainty','executable_plan','updating']},
        'critical_errors':[],'residual_identification':[],'overall_verdict':'not_evaluated'},indent=2)+'\n')
    return {'packet':str(out),'status':'needs independent reviewers',
            'warning':'Give reviewers only answer.json, sources.json and the rubric/form. Do not expose controller-source-map.json. Inspect remaining identifiers before certifying blinding.'}
