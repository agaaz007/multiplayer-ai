"""Bind provisioned native configs to fresh prepared roots, without dispatch.

Do this only after development fixes. Missing live receipts fail closed. Package
inventories are checked against actual files, not just copied version strings.
"""
import argparse,json,shutil
from pathlib import Path
import sequence,mechanisms,integrity
from cohort_scope import expected_arms,CONTROL_ARMS
HERE=Path(__file__).resolve().parent

def freeze(preparation,runtime,inventories):
    preparation=Path(preparation).resolve();plan=sequence.load(preparation);runtime=Path(runtime).resolve(strict=True)
    if plan.get('schema')!='teamwork-preparation/v3':raise ValueError('prepared cohort required')
    arms=expected_arms(plan)
    common={}
    def bind(p,expected=None):
        p=Path(p).resolve(strict=True);actual=sequence.digest(p)
        if expected is not None and actual!=expected:raise ValueError('native package inventory changed: '+str(p))
        common[str(p)]=actual
    for p in HERE.iterdir():
        if p.is_file() and p.suffix in ('.py','.mjs','.md','.json'):bind(p)
    for name in ('budget-gate.mjs','grade_engineering_contract_v2.py','grade_engineering.py','provider_sim.py'):bind(HERE.parent/'teamwork-v2'/name)
    for p in runtime.rglob('*'):
        if p.is_file():bind(p)
    node=str(Path(shutil.which('node')).resolve());bind(node)
    if not inventories:raise ValueError('actual native package/template inventories required')
    for source in inventories:
        source=Path(source).resolve();receipt=sequence.load(source);bind(source)
        files=receipt.get('files')
        if isinstance(files,dict):
            for name,expected in files.items():bind(name,expected)
        elif isinstance(files,list):
            for item in files:bind(source.parent/item['path'],item.get('sha256',item.get('target_sha256')))
        else:raise ValueError('native inventory file hashes required')
        if 'model' in receipt:bind(source.parent/receipt['model']['file'],receipt['model']['sha256'])
    launches=[]
    for entry in plan['entries']:
        root=Path(entry['root']).resolve();state=sequence.load(root/'sequence.json');pack=sequence.validate_pack(state['pack']);development=pack['development']
        if state['executed'] or (root/'attempt.json').exists():raise ValueError('never refreeze an attempted sequence')
        if state['transport_sha256']!=sequence.digest(sequence.__file__):raise ValueError('prepared transport changed; explicitly prepare a fresh cohort')
        native_file=root/'native-config.json';native=sequence.load(native_file);ready_file=Path(native['readiness_receipt']);ready=sequence.load(ready_file)
        if native['arm']!=entry['arm'] or Path(native['root']).resolve()!=root:raise ValueError('native store must belong to this root')
        if ready.get('arm')!=entry['arm'] or ready.get('native_version')!=native.get('version') or ready.get('capture_recall_pass') is not True or ready.get('isolation_pass') is not True:raise ValueError('actual live native transport/isolation readiness required')
        if not development:
            if ready.get('full_harness_pass') is not True:raise ValueError('actual full-harness readiness required')
            if entry['arm']=='ledger':
                proof=ready.get('record_use_audit',{});mechanisms.verify_admission(proof.get('path',''),proof.get('sha256'),native.get('version'))
        frozen=dict(common)
        required=[native_file,Path(native['guide_file']),ready_file]
        # Ledger and the baseline controls have no paid provider path, so no proxy gate is required.
        if entry['arm']!='ledger' and entry['arm'] not in CONTROL_ARMS:required += [Path(native['proxy_config']),Path(native['proxy_ready_file'])]
        if native.get('ca_file'):required.append(Path(native['ca_file']))
        for f in required:frozen[str(f.resolve())]=sequence.digest(f)
        if entry['arm']=='supermemory':
            template=Path(native['supermemory_template']).resolve()
            for f in template.rglob('*'):
                if f.is_file() and str(f.resolve()) not in common:raise ValueError('official Supermemory template file absent from inventory: '+str(f))
        if ready.get('record_use_audit'):
            proof=ready['record_use_audit'];frozen[proof['path']]=proof['sha256']
        stages=[s['id']for s in pack['stages']]
        cfg={'schema':'teamwork-launch/v3','execution_authorized':True,'authorization':(plan.get('cohort_scope') or {}).get('authorization','Agaaz authorized the full native Ledger, Graphify, GBrain and Supermemory comparison in parallel; preserve the original shared USD30 ceiling.'),'paid_paths_gated':True,'maximum_approved_usd':30,'budget_file':plan['budget_file'],'runtime':str(runtime),'model':'gpt-5.6-sol','reasoning_effort':'medium','capture_timeout_ms':300000,'driver_argv':[node,str(HERE/'session-driver.mjs'),'run','{request}'],'native_config':str(native_file),'stage_profile_argv':[node,str(HERE/'native-lifecycle.mjs'),'stage','{request}'],'stage_profiles':{s:str(root/'stages'/s/'controller/native-profile.json')for s in stages},'capture_argv':{s:[node,str(HERE/'native-lifecycle.mjs'),'capture','{request}']for s in stages},'export_argv':[node,str(HERE/'native-lifecycle.mjs'),'export',str(native_file)],'frozen_files':frozen,'known_issues_file':str(HERE/'known-issues.json'),'development_probe':development,'scored':not development}
        if entry['arm']=='ledger':cfg['periodic_capture_argv']=[node,str(HERE/'native-lifecycle.mjs'),'periodic','{request}']
        integrity.verify_disclosures(cfg);launches.append((root/'launch.json',cfg))
    # Validate every lane before creating any launch. Never overwrite a previous freeze.
    if (preparation.parent/'matrix-config.json').exists() or any(file.exists() for file,_ in launches):raise ValueError('launch freeze already exists')
    for file,cfg in launches:sequence.dump(file,cfg,exclusive=True)
    entries=[{**entry,'launch':str(Path(entry['root'])/'launch.json')}for entry in plan['entries']]
    development=all(cfg['development_probe']for _,cfg in launches)
    if development:
        matrix={'schema':'teamwork-readiness-matrix/v3','entries':entries,'disk_plan':plan['disk_plan']}
        if {e['arm'] for e in entries}!=set(arms):raise ValueError('readiness entries differ from the declared cohort')
    else:
        matrix={'schema':'teamwork-matrix/v3','arms':[{'arm':arm,'sequences':[{k:e[k]for k in ('root','launch')}for e in entries if e['arm']==arm]}for arm in arms],'disk_plan':plan['disk_plan']}
    if plan.get('cohort_scope') is not None:matrix['cohort_scope']=plan['cohort_scope']
    file=preparation.parent/'matrix-config.json';sequence.dump(file,matrix,exclusive=True);return file

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--preparation',required=True);p.add_argument('--runtime',required=True);p.add_argument('--inventory',action='append',required=True);a=p.parse_args();print(freeze(a.preparation,a.runtime,a.inventory))
