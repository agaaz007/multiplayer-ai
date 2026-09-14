"""Controller-only exact-map reblinding; never changes scored submissions."""
import argparse,copy,hashlib,json,pathlib,re,secrets,random

OPAQUE=re.compile(r'\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{18,}\b|relay-north-smb-[a-z0-9-]+')
ALIAS=re.compile(r'\bsource-\d{3}\b')
def leaves(value):
    if isinstance(value,dict):
        for v in value.values():yield from leaves(v)
    elif isinstance(value,list):
        for v in value:yield from leaves(v)
    elif isinstance(value,str):yield value
def reblind(answer,sources):
    public={source['id'] for source in sources};mapping={}
    # Encounter order is deterministic within a packet and does not encode product identity.
    for value in leaves(answer):
        for token in list(ALIAS.findall(value))+list(OPAQUE.findall(value)):
            if token not in public and token not in mapping:mapping[token]=f'prior-reference-{len(mapping)+1:03}'
    def apply(value):
        if isinstance(value,dict):return {k:apply(v) for k,v in value.items()}
        if isinstance(value,list):return [apply(v) for v in value]
        if isinstance(value,str):
            for old,new in sorted(mapping.items(),key=lambda kv:-len(kv[0])):
                value=re.sub(r'(?<![A-Za-z0-9_-])'+re.escape(old)+r'(?![A-Za-z0-9_-])',lambda _:new,value)
        return value
    result=apply(answer)
    if any(OPAQUE.search(v) for v in leaves(result)):raise ValueError('opaque identifier survived exact mapping')
    return result,mapping
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def save(p,value):p.write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n')
def prepare(old,out):
    old=pathlib.Path(old).resolve();out=pathlib.Path(out).resolve();out.mkdir(mode=0o700)
    (out/'packets').mkdir(mode=0o700);config=json.loads((old/'review-config.json').read_text());private=json.loads((old/'controller-map.json').read_text());lookup={x['case_id']:x for x in private['cases']};cases=[];maps=[]
    for item in config['cases']:
        prior=pathlib.Path(item['packet']);case='case-'+secrets.token_hex(6);target=out/'packets'/case;target.mkdir(mode=0o700)
        answer=json.loads((prior/'answer.json').read_text());sources=json.loads((prior/'sources.json').read_text());blind,mapping=reblind(answer,sources)
        save(target/'answer.json',blind)
        for name in ['sources.json','fact-keys.json']:(target/name).write_bytes((prior/name).read_bytes())
        cases.append({'id':case,'stage':item['stage'],'packet':str(target)})
        maps.append({**lookup[item['id']],'case_id':case,'original_review_case_id':item['id'],'exact_additional_identifier_map':mapping,'original_prepared_answer_sha256':sha(prior/'answer.json'),'final_blind_answer_sha256':sha(target/'answer.json'),'source_sha256':sha(target/'sources.json'),'original_packet':str(prior)})
    random.SystemRandom().shuffle(cases);config['schema']='pm-review-run/v3';config['cases']=cases
    save(out/'review-config.json',config);save(out/'controller-map.json',{'cases':maps})
    save(out/'preparation.json',{'schema':'pm-final-review-preparation/v3','cases':len(cases),'model_calls':0,'original_preparation':str(old),'original_config_sha256':sha(old/'review-config.json'),'original_inspection_sha256':sha(old/'inspection.json'),'recipe_sha256':sha(pathlib.Path(__file__)),'changes':'Only exact native/predecessor identifier substitutions and new randomized case IDs/order; prior documented mechanism neutralization retained. Public source bytes, substantive content, uncertainties, numbers and approval qualifications are unchanged.','inspection_status':'independent inspection required before launch'})
    return {'cases':len(cases),'packets_with_additional_identifier_substitutions':sum(bool(x['exact_additional_identifier_map']) for x in maps)}
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--original',required=True);p.add_argument('--out',required=True);a=p.parse_args();print(json.dumps(prepare(a.original,a.out)))
