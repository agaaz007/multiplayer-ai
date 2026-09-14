#!/usr/bin/env python3
"""Offline pack preparation, grading and live-readiness audit. No model calls."""
import argparse
import hashlib
import json
from pathlib import Path
import random
import sys
from fixtures import ARMS, STAGES, build, dump, validate
from grade_pm import grade as grade_pm, review_packet
from grade_engineering import grade as grade_engineering
from sequence import prepare as prepare_sequence, run as run_sequence

def preflight(pack,profiles):
    validate(pack)
    cfg=json.loads(Path(profiles).read_text());problems=[]
    for field in ['model','reasoning_effort','stage_deadline_ms','provider_wait_ms','maximum_approved_usd','authorization']:
        if not cfg.get(field):problems.append('freeze '+field)
    for arm in ARMS:
        profile=cfg.get('arms',{}).get(arm,{})
        for field in ['version','capture_mode','session_driver_argv','guide_sha256','isolation_probe','recall_probe']:
            if not profile.get(field):problems.append(arm+': missing '+field)
        for field in ['isolation_probe','recall_probe']:
            evidence=profile.get(field)
            if not isinstance(evidence,dict):continue
            try:
                p=Path(evidence['path']);digest=hashlib.sha256(p.read_bytes()).hexdigest()
                if digest!=evidence['sha256']:raise ValueError('hash mismatch')
                probe=json.loads(p.read_text())
                if probe.get('passed') is not True or probe.get('arm')!=arm:raise ValueError('probe failed/wrong arm')
            except Exception as e:problems.append(arm+': invalid '+field+' ('+str(e)+')')
        if arm=='ledger' and profile.get('capture_mode')!='native-classifier-on':
            problems.append('ledger: full-capability track requires verified classifier-on setup; classifier-off belongs in an ablation')
    return {'ready':not problems,'problems':problems,
            'scope':'configuration/evidence audit only; does not independently reproduce native readiness probes'}

def schedule(seeds):
    jobs=[]
    for seed in seeds:
        for track in ['engineering','pm']:
            arms=ARMS.copy();random.Random(str(seed)+track).shuffle(arms)
            for arm in arms:jobs.append({'seed':seed,'track':track,'arm':arm,'stages':list(STAGES)})
    return {'schema':'teamwork-schedule/v2','sequences':jobs,'model_stages':len(jobs)*4,
            'order':'paired by seed/track, randomized arm order; sequential stages within sequence',
            'executed':False,'statistical_status':'exploratory screen; three seeds do not establish superiority'}

def main():
    parser=argparse.ArgumentParser(description=__doc__);commands=parser.add_subparsers(dest='command',required=True)
    p=commands.add_parser('build');p.add_argument('--out',required=True);p.add_argument('--seed',type=int,default=41)
    p=commands.add_parser('validate');p.add_argument('--pack',required=True)
    p=commands.add_parser('grade-pm');p.add_argument('--pack',required=True);p.add_argument('--stage',choices=list(STAGES),required=True);p.add_argument('--answer',required=True);p.add_argument('--out',required=True)
    p=commands.add_parser('grade-engineering');p.add_argument('--candidate',required=True);p.add_argument('--stage',choices=list(STAGES),required=True);p.add_argument('--out',required=True)
    p=commands.add_parser('review-packet');p.add_argument('--answer',required=True);p.add_argument('--out',required=True);p.add_argument('--pack',required=True);p.add_argument('--stage',choices=list(STAGES),required=True)
    p=commands.add_parser('preflight');p.add_argument('--pack',required=True);p.add_argument('--profiles',required=True)
    p=commands.add_parser('schedule');p.add_argument('--seeds',default='137,211,307');p.add_argument('--out',required=True)
    p=commands.add_parser('prepare-sequence');p.add_argument('--pack',required=True);p.add_argument('--out',required=True);p.add_argument('--track',choices=['engineering','pm'],required=True);p.add_argument('--arm',choices=ARMS,required=True)
    p=commands.add_parser('run-sequence');p.add_argument('--root',required=True);p.add_argument('--launch',required=True)
    args=parser.parse_args()
    if args.command=='build':result=build(args.out,args.seed)
    elif args.command=='validate':result=validate(args.pack)
    elif args.command=='grade-pm':result=grade_pm(args.pack,args.stage,json.loads(Path(args.answer).read_text()));dump(args.out,result)
    elif args.command=='grade-engineering':result=grade_engineering(args.candidate,args.stage);dump(args.out,result)
    elif args.command=='review-packet':
        validate(args.pack)
        result=review_packet(json.loads(Path(args.answer).read_text()),args.out,
            json.loads((Path(args.pack)/'agent/pm'/args.stage/'raw-evidence.json').read_text()))
    elif args.command=='preflight':result=preflight(args.pack,args.profiles)
    elif args.command=='prepare-sequence':result=prepare_sequence(args.pack,args.out,args.track,args.arm)
    elif args.command=='run-sequence':result=run_sequence(args.root,args.launch)
    else:result=schedule([int(v) for v in args.seeds.split(',')]);dump(args.out,result)
    print(json.dumps(result,indent=2))
    if args.command=='preflight' and not result['ready']:return 2
    return 0

if __name__=='__main__':sys.exit(main())
