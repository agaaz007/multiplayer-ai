"""Prepare fresh cohort roots and explicit disk estimates, without native/model calls.

Preparation is not a launch freeze or a readiness receipt. No attempted roots or
previous budget are modified. Native provisioning and verified admission follow.

Decision 7A: the full cohort has six arms (four products plus the `control-git`
and `handoff-note` baseline controls). `--arms` selects the six-arm cohort or one
batch (`products`, `controls`) so lanes can run in two batches, each with its own
smaller aggregate reservation. Per-sequence estimates never shrink with the batch.
"""
import argparse,json
from pathlib import Path
import fixtures,readiness,sequence
from cohort_scope import ALL_ARMS,PRODUCT_ARMS,CONTROL_ARMS,batch_scope
GIB=1024**3
RETAINED_PER_SEQUENCE=GIB//2
PEAK_PER_LANE=GIB//4
SHARED_OVERHEAD=GIB//2
MARGIN=2*GIB
BATCHES={'all':ALL_ARMS,'six-arm':ALL_ARMS,'products':PRODUCT_ARMS,'controls':CONTROL_ARMS,'ledger-vs-controls':('ledger',)+CONTROL_ARMS}
DEFAULT_AUTHORIZATION='Decision 7A (2026-09-13 review): compare the four native products against the control-git and handoff-note baseline controls; preserve the original shared USD30 ceiling.'
SIX_ARM_SCORED_BASIS='Six-arm scored cohort aggregate: 12 x 512 MiB retained + 6 x 256 MiB peak + 512 MiB shared + 2 GiB margin = 10 GiB.'


def gib(n):
    return f'{n/GIB:g} GiB'


def disk_plan_summary(plan):
    """GiB totals of a teamwork-disk-plan/v3: retained per sequence, one peak per lane, shared overhead and margin."""
    sequences=plan.get('sequences',[]);shared=plan.get('shared',[])
    retained=sum(s['retained_output_bytes'] for s in sequences)
    peaks={}
    for s in sequences:
        peaks[s['arm']]=max(peaks.get(s['arm'],0),s['peak_working_capture_bytes'])
    peak=sum(peaks.values());overhead=sum(x['overhead_bytes'] for x in shared);margin=sum(x['margin_bytes'] for x in shared)
    total=retained+peak+overhead+margin
    arms=sorted({s['arm'] for s in sequences})
    summary={'sequences':len(sequences),'lanes':len(peaks),'arms':arms,'retained_bytes':retained,'peak_bytes':peak,'overhead_bytes':overhead,'margin_bytes':margin,'total_bytes':total,
        'retained_gib':retained/GIB,'peak_gib':peak/GIB,'overhead_gib':overhead/GIB,'margin_gib':margin/GIB,'total_gib':total/GIB}
    summary['text']=(f"{len(sequences)} x {gib(RETAINED_PER_SEQUENCE) if sequences and all(s['retained_output_bytes']==RETAINED_PER_SEQUENCE for s in sequences) else 'retained'} retained = {gib(retained)}; "
        f"{len(peaks)} lane peaks = {gib(peak)}; shared overhead {gib(overhead)}; margin {gib(margin)}; total {gib(total)}")
    return summary


def disk_plan(entries,root):
    plan={'schema':'teamwork-disk-plan/v3','sequences':[{
        **{k:e[k]for k in ('root','arm','track')},'filesystem_path':e['root'],
        'retained_output_bytes':RETAINED_PER_SEQUENCE,'peak_working_capture_bytes':PEAK_PER_LANE,
        'basis':'Conservative initial estimate: 512 MiB retained per sequence and 256 MiB peak working/capture per lane, unchanged for every batch. Previous interrupted three-lane readiness retained approximately 0.5 GiB in total; incomplete observation, not a measured maximum. Recalibrate upward from completed readiness before primary freeze.'}for e in entries],
        'shared':[{'filesystem_path':str(root),'overhead_bytes':SHARED_OVERHEAD,'margin_bytes':MARGIN,'basis':'512 MiB shared logs/controller overhead plus 2 GiB free-space margin; existing native installs already consume measured free space.'}]}
    summary=disk_plan_summary(plan)
    plan['aggregate_basis']=SIX_ARM_SCORED_BASIS+' This plan covers '+summary['text']+'. Batches reserve only their own lanes; per-sequence estimates are not lowered.'
    plan['summary']=summary
    return plan


def print_summary(plan,label=''):
    s=disk_plan_summary(plan)
    print(f"{label}{s['text']}")
    return s


def build(out,budget,arms='all',authorization=DEFAULT_AUTHORIZATION):
    if arms not in BATCHES:raise ValueError('arms must be one of '+', '.join(BATCHES))
    selected=BATCHES[arms];batch='six-arm' if arms in ('all','six-arm') else arms
    scope=batch_scope(batch,authorization)
    root=Path(out).resolve();budget=Path(budget).resolve(strict=True)
    state=sequence.load(budget)
    if state.get('schema')!='teamwork-budget/v2' or state.get('maximum_usd')!=30:
        raise ValueError('existing canonical USD30 budget required; never reset allowance')
    root.mkdir(parents=True,exist_ok=False)
    rp=readiness.build(root/'readiness/pack');sequence.dump(root/'readiness/correction-witness.json',readiness.correction(rp))
    entries=[]
    for arm in selected:
        dest=root/'readiness/sequences'/arm;sequence.prepare(rp,dest,'engineering',arm)
        entries.append({'root':str(dest),'arm':arm,'track':'engineering'})
    sequence.dump(root/'readiness/preparation.json',{'schema':'teamwork-preparation/v3','execution_ready':False,'reason':'fresh native provisioning, live isolation and full-harness receipts required','entries':entries,'budget_file':str(budget),'cohort_scope':scope,'disk_plan':disk_plan(entries,root)})
    packs={t:fixtures.build(root/'scored/packs'/t,t,271,False)for t in ('pm','engineering')}
    entries=[]
    for arm in selected:
        for track in ('pm','engineering'):
            dest=root/'scored/sequences'/(track+'-'+arm);sequence.prepare(packs[track],dest,track,arm)
            entries.append({'root':str(dest),'arm':arm,'track':track,'launch':str(dest/'launch.json')})
    required=['Live native full-harness admission receipts for every product lane','Ledger reproducible record-use audit with B correction witness','Supermemory original-file download host pin and scoped key isolation proof','control-readiness.mjs probe and assess receipts for control-git and handoff-note','Recalibrated aggregate disk estimates','Known issues disclosure and intervention policy','Native versions, templates, adapters, guides, graders and launch hashes']
    sequence.dump(root/'scored/preparation.json',{'schema':'teamwork-preparation/v3','execution_ready':False,'task_model':'gpt-5.6-sol','reasoning_effort':'medium','budget_file':str(budget),'entries':entries,'cohort_scope':scope,'disk_plan':disk_plan(entries,root),'required_before_freeze':required})
    return root


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--out',required=True);p.add_argument('--budget',required=True)
    p.add_argument('--arms',choices=sorted(BATCHES),default='all',help='six-arm cohort (all) or one batch: products, controls, ledger-vs-controls')
    p.add_argument('--authorization',default=DEFAULT_AUTHORIZATION)
    a=p.parse_args();root=build(a.out,a.budget,a.arms,a.authorization);print(root)
    for name in ('readiness','scored'):print_summary(sequence.load(root/name/'preparation.json')['disk_plan'],name+': ')
