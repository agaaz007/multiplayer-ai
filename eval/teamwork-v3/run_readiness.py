"""Run the declared unscored readiness lanes concurrently under one shared disk reservation."""
import argparse,concurrent.futures,json
from pathlib import Path
import disk_budget,sequence,integrity
from cohort_scope import expected_arms,cohort_label

def run(config,out):
    config=Path(config).resolve();cfg=sequence.load(config);entries=cfg.get('entries',[])
    arms=expected_arms(cfg)
    if cfg.get('schema')!='teamwork-readiness-matrix/v3' or len(entries)!=len(arms) or {e['arm']for e in entries}!=set(arms):raise ValueError('exactly the declared '+cohort_label(arms)+' readiness lanes required')
    manifests=set();budgets=set();roots=set()
    for entry in entries:
        root=Path(entry['root']).resolve();state=sequence.load(root/'sequence.json');launch=sequence.load(entry['launch']);pack=sequence.validate_pack(state['pack'])
        if root in roots or state['executed'] or (root/'attempt.json').exists():raise ValueError('fresh unattempted roots required for every declared lane')
        roots.add(root)
        if state['arm']!=entry['arm'] or state['track']!=entry['track'] or pack['development'] is not True or launch.get('development_probe') is not True or launch.get('scored') is not False:raise ValueError('development pack and launch required')
        if state['transport_sha256']!=sequence.digest(sequence.__file__) or state['pack_manifest_sha256']!=sequence.digest(Path(state['pack'])/'manifest.json'):raise ValueError('prepared freeze changed')
        if launch.get('model')!='gpt-5.6-sol' or launch.get('reasoning_effort')!='medium' or launch.get('maximum_approved_usd')!=30:raise ValueError('selected subscription model and original budget required')
        integrity.verify_disclosures(launch);integrity.check(root,launch)
        manifests.add(state['pack_manifest_sha256']);budgets.add(str(Path(launch['budget_file']).resolve()))
    if len(manifests)!=1 or len(budgets)!=1:raise ValueError('identical readiness pack and shared budget required')
    normalized=disk_budget.normalize(cfg.get('disk_plan'),entries)
    for path in (config,out,*budgets):
        if disk_budget.filesystem(path)[0] not in normalized['volumes']:raise ValueError('all controller filesystems must have aggregate estimates')
    lease=disk_budget.reserve(cfg['disk_plan'],entries)
    try:
        out=Path(out);out.mkdir(parents=True,exist_ok=False)
        def lane(e):
            try:return {'arm':e['arm'],'root':e['root'],'sequence':sequence.run(e['root'],e['launch'],disk_lease=lease)}
            except Exception as error:return {'arm':e['arm'],'root':e['root'],'status':'failed','error':str(error)}
        with concurrent.futures.ThreadPoolExecutor(len(entries)) as pool:
            results=[]
            for future in concurrent.futures.as_completed([pool.submit(lane,e)for e in entries]):
                result=future.result();results.append(result);sequence.dump(out/(result['arm']+'.json'),result)
        receipt={'schema':'teamwork-readiness-matrix-result/v3','disk_admission':lease.receipt,'results':results,'cohort_scope':cfg.get('cohort_scope'),'admission':'not automatic; inspect native capture, isolation, real compaction/interruption and Ledger record-use evidence; control arms need control-readiness.mjs assess'}
        sequence.dump(out/'result.json',receipt);return receipt
    finally:lease.release()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--config',required=True);p.add_argument('--out',required=True);a=p.parse_args();print(json.dumps(run(a.config,a.out),indent=2))
