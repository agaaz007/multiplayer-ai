"""Freeze-checked parallel product lanes for the native continuation comparison."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import sys
import threading
import time
from sequence import run as run_sequence,validate_pack,digest,load,dump
import sequence
import disk_budget
import mechanisms
import integrity
from cohort_scope import expected_arms

from cohort_scope import ALL_ARMS
ARMS=set(ALL_ARMS)
MINIMUM_FREE_BYTES=5*1024**3


class DiskAdmissionError(ValueError):
    def __init__(self,receipt):
        self.receipt=receipt
        super().__init__('matrix disk admission failed: '+json.dumps(receipt,sort_keys=True))


def disk_preflight(paths):
    """Measure every involved filesystem without creating a directory or receipt."""
    checks={}
    for value in paths:
        target=Path(value).resolve();probe=target
        while not probe.exists():probe=probe.parent
        if probe.is_file():probe=probe.parent
        device=probe.stat().st_dev
        if device not in checks:
            free=shutil.disk_usage(probe).free
            checks[device]={'device':device,'probe_path':str(probe),'paths':[],
                'available_bytes':free,'minimum_free_bytes':MINIMUM_FREE_BYTES,
                'status':'passed' if free>=MINIMUM_FREE_BYTES else 'insufficient_space'}
        checks[device]['paths'].append(str(target))
    receipt={'schema':'teamwork-matrix-disk-admission/v3','checked_at_unix':time.time(),
        'minimum_free_bytes':MINIMUM_FREE_BYTES,'checks':list(checks.values()),
        'status':'passed' if all(c['status']=='passed' for c in checks.values()) else 'rejected'}
    if receipt['status']!='passed':raise DiskAdmissionError(receipt)
    return receipt

def preflight(file,out=None):
    cfg=load(file)
    if cfg.get('schema')!='teamwork-matrix/v3':raise ValueError('matrix schema')
    arms=cfg.get('arms',[])
    required=expected_arms(cfg)
    if len(arms)!=len(required) or {a['arm'] for a in arms}!=set(required):raise ValueError('exactly the declared competitor cohort required')
    budgets=set();roots=set();comparisons={};result=[]
    for a in arms:
        entries=[]
        if len(a.get('sequences',[]))!=2:raise ValueError('both tracks required')
        tracks=set()
        for s in a['sequences']:
            root=Path(s['root']).resolve();launch=Path(s['launch']).resolve()
            if root in roots:raise ValueError('duplicate root')
            roots.add(root);state=load(root/'sequence.json');lc=load(launch)
            if state.get('executed') or (root/'attempt.json').exists():raise ValueError('already attempted')
            if state.get('schema')!='teamwork-sequence/v3' or state.get('status')!='prepared' or state.get('executed') is not False:
                raise ValueError('unattempted prepared sequence required')
            if state['arm']!=a['arm'] or state['track'] in tracks:raise ValueError('arm/track mismatch')
            t=state['track'];tracks.add(t);pack=validate_pack(state['pack'])
            if pack.get('development') is not False or state.get('development') is not False:
                raise ValueError('development pack/sequence cannot enter scored matrix')
            if pack.get('track')!=t or a['arm'] not in pack.get('arms',[]):raise ValueError('pack arm/track mismatch')
            if digest(Path(state['pack'])/'manifest.json')!=state.get('pack_manifest_sha256') or digest(sequence.__file__)!=state.get('transport_sha256'):
                raise ValueError('prepared pack/transport freeze changed')
            if lc.get('schema')!='teamwork-launch/v3' or lc.get('execution_authorized') is not True or lc.get('paid_paths_gated') is not True or not lc.get('authorization'):
                raise ValueError('launch gates missing')
            if lc.get('development_probe') or lc.get('scored') is False:raise ValueError('development launch cannot enter scored matrix')
            for key in ['runtime','model','reasoning_effort','native_config','budget_file']:
                if not isinstance(lc.get(key),str) or not lc[key]:raise ValueError('freeze '+key)
            if type(lc.get('capture_timeout_ms')) is not int or lc['capture_timeout_ms']<=0:
                raise ValueError('positive capture deadline required')
            if not isinstance(lc.get('frozen_files'),dict) or not lc['frozen_files']:raise ValueError('freeze frozen_files')
            integrity.verify_disclosures(lc)
            argv=lc.get('driver_argv')
            if not isinstance(argv,list) or not argv or any(not isinstance(x,str) or not x for x in argv) or '{request}' not in argv:
                raise ValueError('driver argv requires nonempty strings and standalone {request}')
            if not isinstance(lc.get('stage_profiles'),dict) or any(not lc['stage_profiles'].get(x['id']) for x in pack['stages']):
                raise ValueError('fresh native profiles required for every stage')
            frozen_paths={Path(p).resolve() for p in lc['frozen_files']}
            for argument in argv[1:]:
                if Path(argument).is_file() and Path(argument).resolve() not in frozen_paths:
                    raise ValueError('driver script/input missing from frozen_files: '+argument)
            if lc['maximum_approved_usd']!=30:raise ValueError('existing shared ceiling required')
            budget=Path(lc['budget_file']).resolve();budgets.add(budget)
            if not budget.is_file():raise ValueError('missing canonical budget')
            native=load(lc['native_config']);ready=load(native['readiness_receipt'])
            if ready.get('arm')!=a['arm'] or ready.get('capture_recall_pass') is not True or ready.get('isolation_pass') is not True:
                raise ValueError('native readiness evidence missing')
            if ready.get('full_harness_pass') is not True:
                raise ValueError('scored matrix requires actual full-harness admission, not a transport-only probe')
            if a['arm']=='ledger':
                proof=ready.get('record_use_audit',{})
                if not proof.get('path') or not proof.get('sha256'):raise ValueError('record-use audit required for Ledger admission')
                mechanisms.verify_admission(proof['path'],proof['sha256'],native.get('version'))
            if ready.get('native_version')!=native.get('version'):
                raise ValueError('native readiness version mismatch')
            for p,h in lc['frozen_files'].items():
                if digest(p)!=h:raise ValueError('freeze changed: '+p)
            comparison={'pack':digest(Path(state['pack'])/'manifest.json'),'model':lc['model'],'reasoning':lc['reasoning_effort'],
                        'stages':[(x['id'],x['deadline_ms'],x.get('stress')) for x in pack['stages']],
                        'capture_timeout_ms':lc['capture_timeout_ms']}
            if t in comparisons and comparisons[t]!=comparison:raise ValueError('mismatched task/model/limits')
            comparisons[t]=comparison
            entries.append({**s,'track':t,'launch_sha256':digest(launch),'state_sha256':digest(root/'sequence.json')})
        if tracks!={'pm','engineering'}:raise ValueError('both tracks required')
        result.append({'arm':a['arm'],'sequences':entries})
    if len(budgets)!=1:raise ValueError('one budget across all lanes required')
    disk=disk_preflight([Path(file).resolve().parent,*sorted(roots),*sorted(budgets),*([out] if out is not None else [])])
    expected=[{'root':s['root'],'arm':a['arm'],'track':s['track']} for a in result for s in a['sequences']]
    normalized=disk_budget.normalize(cfg.get('disk_plan'),expected)
    for path in [Path(file).resolve().parent,*budgets,*([out] if out is not None else [])]:
        if disk_budget.filesystem(path)[0] not in normalized['volumes']:
            raise ValueError('controller/budget output filesystem missing from aggregate disk plan')
    aggregate=disk_budget.preview(cfg.get('disk_plan'),expected)
    return {'schema':'teamwork-preflight/v3','config_sha256':digest(file),'cohort_scope':cfg.get('cohort_scope'),'arms':result,'comparisons':comparisons,'budget_file':str(next(iter(budgets))),
            'disk_admission':disk,'aggregate_disk_admission':aggregate,'disk_plan':cfg['disk_plan'],'disk_members':expected}

def run(config,out):
    plan=preflight(config,out)
    lease=disk_budget.reserve(plan['disk_plan'],plan['disk_members'])
    try:
        return _run_reserved(plan,out,lease)
    finally:
        lease.release()

def _run_reserved(plan,out,lease):
    out=Path(out).resolve();out.mkdir(parents=True,exist_ok=False)
    began=time.monotonic();lock=threading.Lock()
    state={'schema':'teamwork-matrix-run/v3','status':'running','preflight':plan,
           'arms':{a['arm']:{'status':'queued','sequences':{}} for a in plan['arms']}}
    def save():state['elapsed_seconds']=time.monotonic()-began;dump(out/'status.json',state)
    def lane(a):
        with lock:state['arms'][a['arm']]['status']='running';save()
        for s in a['sequences']:
            start=time.monotonic()
            with lock:state['arms'][a['arm']]['sequences'][s['track']]={'status':'running','root':s['root']};save()
            try:
                if digest(s['launch'])!=s['launch_sha256'] or digest(Path(s['root'])/'sequence.json')!=s['state_sha256']:
                    raise ValueError('launch/state changed after preflight')
                r=run_sequence(s['root'],s['launch'],disk_lease=lease);failed=[k for k,v in r['stages'].items() if v['status']=='failed']
                status={'status':'infrastructure_aborted' if r.get('status')=='infrastructure_aborted' else ('finished_with_failures' if failed else 'finished'),'failed_stages':failed}
            except Exception as e:status={'status':'failed','error':str(e)}
            with lock:state['arms'][a['arm']]['sequences'][s['track']].update(status,elapsed_seconds=time.monotonic()-start);save()
        with lock:state['arms'][a['arm']]['status']='finished';save()
    save()
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1,len(plan['arms']))) as pool:
        for f in concurrent.futures.as_completed([pool.submit(lane,a) for a in plan['arms']]):f.result()
    state['status']='ended';save();return state

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('command',choices=['check','run']);p.add_argument('--config',required=True);p.add_argument('--out');a=p.parse_args()
    try:result=preflight(a.config,a.out) if a.command=='check' else run(a.config,a.out)
    except (DiskAdmissionError,disk_budget.DiskReservationError) as error:
        print(json.dumps(error.receipt,indent=2),file=sys.stderr);raise SystemExit(2)
    print(json.dumps(result,indent=2))
