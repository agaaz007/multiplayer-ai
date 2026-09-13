"""Freeze checks and explicit controller intervention journal; never repair scored state."""
import argparse,fcntl,hashlib,json,os,time
from pathlib import Path

class FreezeError(ValueError):pass

def record(root,actor,action,reason,affected):
    if not all(isinstance(x,str) and x.strip() for x in (actor,action,reason)) or not affected:
        raise ValueError('intervention actor, action, reason and affected paths required')
    file=Path(root)/'interventions.jsonl'
    with file.open('a') as f:
        fcntl.flock(f,fcntl.LOCK_EX)
        event={'schema':'teamwork-intervention/v3','at_unix':time.time(),'actor':actor,'action':action,'reason':reason,'affected':affected,'scoring':'retain attempt; requires explicit validity review, no silent repair'}
        f.write(json.dumps(event)+'\n');f.flush();os.fsync(f.fileno())
    return event

def verify_disclosures(cfg):
    p=cfg.get('known_issues_file')
    if not p or p not in cfg.get('frozen_files',{}):raise ValueError('known issues must be frozen before scoring')
    data=json.loads(Path(p).read_text())
    if data.get('schema')!='teamwork-known-issues/v3' or not data.get('ledger_short_file_evidence') or not data.get('supermemory_file_support') or not data.get('intervention_policy'):
        raise ValueError('short-file evidence, file support and intervention policy disclosures required')

def check(root,cfg):
    journal=Path(root)/'interventions.jsonl'
    if journal.exists() and journal.stat().st_size:
        raise FreezeError('recorded intervention requires stopping the scored attempt')
    for name,expected in cfg['frozen_files'].items():
        try:
            hasher=hashlib.sha256()
            with Path(name).open('rb') as stream:
                for chunk in iter(lambda:stream.read(1024*1024),b''):hasher.update(chunk)
            actual=hasher.hexdigest()
        except OSError:actual=None
        if actual!=expected:
            record(root,'controller','freeze violation','frozen input changed or disappeared',[name])
            raise FreezeError('frozen input changed: '+name)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--actor',required=True);p.add_argument('--action',required=True);p.add_argument('--reason',required=True);p.add_argument('--affected',nargs='+',required=True);a=p.parse_args()
    print(json.dumps(record(a.root,a.actor,a.action,a.reason,a.affected),indent=2))
