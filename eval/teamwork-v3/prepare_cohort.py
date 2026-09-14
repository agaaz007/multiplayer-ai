"""Prepare fresh four-product roots and explicit estimates, without native/model calls.

Preparation is not a launch freeze or a readiness receipt. No attempted roots or
previous budget are modified. Native provisioning and verified admission follow.
"""
import argparse,json
from pathlib import Path
import fixtures,readiness,sequence
GIB=1024**3

def disk_plan(entries,root):
    return {'schema':'teamwork-disk-plan/v3','sequences':[{
        **{k:e[k]for k in ('root','arm','track')},'filesystem_path':e['root'],
        'retained_output_bytes':GIB//2,'peak_working_capture_bytes':GIB//4,
        'basis':'Conservative initial estimate: 512 MiB retained per sequence and 256 MiB peak working/capture per lane. Previous interrupted three-lane readiness retained approximately 0.5 GiB in total; incomplete observation, not a measured maximum. Recalibrate upward from completed four-lane readiness before primary freeze.'}for e in entries],
        'shared':[{'filesystem_path':str(root),'overhead_bytes':GIB//2,'margin_bytes':2*GIB,'basis':'512 MiB shared logs/controller overhead plus 2 GiB free-space margin; existing native installs already consume measured free space.'}]}

def build(out,budget):
    root=Path(out).resolve();budget=Path(budget).resolve(strict=True)
    state=sequence.load(budget)
    if state.get('schema')!='teamwork-budget/v2' or state.get('maximum_usd')!=30:
        raise ValueError('existing canonical USD30 budget required; never reset allowance')
    root.mkdir(parents=True,exist_ok=False)
    rp=readiness.build(root/'readiness/pack');sequence.dump(root/'readiness/correction-witness.json',readiness.correction(rp))
    entries=[]
    for arm in fixtures.ARMS:
        dest=root/'readiness/sequences'/arm;sequence.prepare(rp,dest,'engineering',arm)
        entries.append({'root':str(dest),'arm':arm,'track':'engineering'})
    sequence.dump(root/'readiness/preparation.json',{'schema':'teamwork-preparation/v3','execution_ready':False,'reason':'fresh native provisioning, live isolation and full-harness receipts required','entries':entries,'budget_file':str(budget),'disk_plan':disk_plan(entries,root)})
    packs={t:fixtures.build(root/'scored/packs'/t,t,271,False)for t in ('pm','engineering')}
    entries=[]
    for arm in fixtures.ARMS:
        for track in ('pm','engineering'):
            dest=root/'scored/sequences'/(track+'-'+arm);sequence.prepare(packs[track],dest,track,arm)
            entries.append({'root':str(dest),'arm':arm,'track':track,'launch':str(dest/'launch.json')})
    sequence.dump(root/'scored/preparation.json',{'schema':'teamwork-preparation/v3','execution_ready':False,'task_model':'gpt-5.6-sol','reasoning_effort':'medium','budget_file':str(budget),'entries':entries,'disk_plan':disk_plan(entries,root),'required_before_freeze':['All four live native full-harness admission receipts','Ledger reproducible record-use audit with B correction witness','Supermemory original-file download host pin and scoped key isolation proof','Recalibrated aggregate disk estimates','Known issues disclosure and intervention policy','Native versions, templates, adapters, guides, graders and launch hashes']})
    return root

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);p.add_argument('--budget',required=True);a=p.parse_args();print(build(a.out,a.budget))
