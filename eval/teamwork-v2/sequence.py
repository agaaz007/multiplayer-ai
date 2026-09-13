"""Sequence staging and dispatch for already provisioned native profiles.

Provisioning must supply per-stage native profiles and capture commands. The
controller never constructs semantic handoff summaries. This module has no
embedded provider credentials or new provider-account creation.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
from fixtures import STAGES,dump,validate
from grade_pm import grade as grade_pm
from grade_engineering import grade as grade_engineering

def copy_tree(source,dest):
    source=Path(source);dest=Path(dest);dest.mkdir(parents=True,exist_ok=True)
    excluded={'.git','.codex','.ledger','.claude','node_modules','__pycache__','.venv'}
    for path in source.iterdir():
        if path.name in excluded or path.name.startswith('.env'):continue
        if path.is_symlink():raise ValueError('code transfer rejects symlinks: '+path.name)
        target=dest/path.name
        if path.is_dir():copy_tree(path,target)
        elif path.is_file():shutil.copy2(path,target)

def verify_submission(controller,deadline_ms,track):
    """Verify exactly the frozen answer/tree, including added files, before grading."""
    controller=Path(controller);answer=controller/'submission/answer.json';receipt_path=controller/'delivery.json'
    if not answer.exists() or not receipt_path.exists():return False
    if answer.is_symlink() or receipt_path.is_symlink():raise ValueError('submission receipt/answer must be regular files')
    receipt=json.loads(receipt_path.read_text())
    if not 0<=receipt['elapsed_ms']<=deadline_ms:return False
    if hashlib.sha256(answer.read_bytes()).hexdigest()!=receipt.get('answer_file_sha256'):
        raise ValueError('submitted answer changed or missing byte hash')
    if track=='engineering':
        tree=controller/'submission/tree'
        if tree.is_symlink() or not tree.is_dir():raise ValueError('submitted tree must be a directory')
        expected=(receipt.get('tree') or {}).get('files')
        if not isinstance(expected,dict):raise ValueError('submitted tree manifest missing')
        actual={}
        for artifact in tree.rglob('*'):
            if artifact.is_symlink():raise ValueError('submitted tree contains symlink')
            if artifact.is_file():actual[artifact.relative_to(tree).as_posix()]=hashlib.sha256(artifact.read_bytes()).hexdigest()
        if actual!=expected:raise ValueError('submitted tree changed')
    return True

def inherit_shared_git(previous,work):
    """Preserve ordinary committed history equally; controller snapshots uncommitted work."""
    if previous:
        copy_tree(previous,work)
        git=Path(previous)/'.git'
        if git.is_dir() and not git.is_symlink():shutil.copytree(git,Path(work)/'.git')

def descendant_processes(pid):
    """Capture owned descendants before a timeout reparents detached native servers."""
    rows=subprocess.run(['ps','-axo','pid=,ppid='],capture_output=True,text=True,check=True).stdout.splitlines()
    parents={int(parts[0]):int(parts[1]) for row in rows if len(parts:=row.split())==2}
    owned={pid}
    while True:
        found={child for child,parent in parents.items() if parent in owned}
        if found.issubset(owned):return owned
        owned.update(found)

def prepare(pack,out,track,arm):
    validate(pack);pack=Path(pack).resolve();out=Path(out).resolve()
    design=json.loads((pack/'controller/design.json').read_text())
    if arm not in design['arms'] or track not in design['tracks']:raise ValueError('arm/track not in pack')
    out.mkdir(parents=True,exist_ok=False)
    (out/'controller-canary').write_text(os.urandom(16).hex())
    # Only stage directories are created in advance; future inputs stay in the private pack.
    for stage in STAGES:
        (out/'stages'/stage/'home').mkdir(parents=True)
        (out/'stages'/stage/'worktree').mkdir()
        (out/'stages'/stage/'controller').mkdir()
        (out/'stages'/stage/'home'/'foreign-canary').write_text(os.urandom(16).hex())
    manifest={'schema':'teamwork-sequence/v2','pack':str(pack),'track':track,'arm':arm,
              'pack_manifest_sha256':hashlib.sha256((pack/'manifest.json').read_bytes()).hexdigest(),
              'driver_hashes':{name:hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                               for name in ['session-driver.mjs','sequence.py','fixtures.py','grade_engineering.py','grade_pm.py','provider_sim.py']},
              'status':'prepared','executed':False,'stages':{}}
    dump(out/'sequence.json',manifest);return manifest

def run_command(argv,cwd,limit_seconds,stdout_file):
    if not isinstance(argv,list) or not argv or not all(isinstance(x,str) for x in argv):raise ValueError('argv must be a nonempty string array')
    started=time.monotonic()
    with open(stdout_file,'wb') as log:
        proc=subprocess.Popen(argv,cwd=cwd,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        timed_out=False
        try:code=proc.wait(timeout=limit_seconds)
        except subprocess.TimeoutExpired:
            timed_out=True
            owned=descendant_processes(proc.pid)
            # Let the driver's SIGTERM handler clean up its detached Codex group first.
            try:os.killpg(proc.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:code=proc.wait(timeout=5)
            except subprocess.TimeoutExpired:code=None
            for pid in sorted(owned,reverse=True):
                try:os.killpg(pid,signal.SIGKILL)
                except ProcessLookupError:
                    try:os.kill(pid,signal.SIGKILL)
                    except ProcessLookupError:pass
            if code is None:code=proc.wait(timeout=5)
    elapsed=time.monotonic()-started
    return {'exit_code':code,'timed_out':timed_out,'elapsed_seconds':elapsed,
            'timing_valid':elapsed<=limit_seconds+5}

def run(root,launch):
    root=Path(root).resolve();cfg=json.loads(Path(launch).read_text());state=json.loads((root/'sequence.json').read_text())
    if state['executed']:raise ValueError('sequence already attempted; keep failures and prepare a new explicitly authorized attempt')
    pack=Path(state['pack']);validate(pack)
    if hashlib.sha256((pack/'manifest.json').read_bytes()).hexdigest()!=state['pack_manifest_sha256']:raise ValueError('pack freeze changed')
    for name,digest in state['driver_hashes'].items():
        if hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()!=digest:raise ValueError('driver/grader changed: '+name)
    if cfg.get('execution_authorized') is not True or not cfg.get('authorization'):raise ValueError('new live execution authorization required')
    # This is not advertised as a billing cap. Every paid tool path requires its own native gate.
    if cfg.get('paid_paths_gated') is not True or cfg.get('maximum_approved_usd',0)<=0:raise ValueError('verified native cost gating and allowance required')
    if not all(stage in cfg.get('stage_profiles',{}) for stage in STAGES):raise ValueError('provision native profiles for all four fresh identities')
    for key in ['runtime','model','reasoning_effort','stage_deadline_ms','capture_timeout_ms']:
        if not cfg.get(key):raise ValueError('freeze '+key)
    driver=Path(__file__).with_name('session-driver.mjs')
    state['executed']=True;state['status']='running';dump(root/'sequence.json',state)
    previous=None
    for stage in STAGES:
        stage_root=root/'stages'/stage;work=stage_root/'worktree';ctl=stage_root/'controller';home=stage_root/'home'
        result={'status':'started'};state['stages'][stage]=result;dump(root/'sequence.json',state)
        try:
            if state['track']=='engineering':
                if previous:inherit_shared_git(previous,work)
                else:copy_tree(pack/'agent/engineering/A',work)
            copy_tree(pack/'agent'/state['track']/stage,work)
            # Normal Git is intentionally available in every primary engineering arm.
            subprocess.run(['git','init','-q',str(work)],check=True)
            subprocess.run(['git','-C',str(work),'add','-A'],check=True)
            subprocess.run(['git','-C',str(work),'-c','user.name=benchmark-controller','-c','user.email=controller@evaluation.invalid',
                'commit','-q','--allow-empty','-m',f'Normal shared tree and released stage {stage} inputs'],check=True)
            task=json.loads((work/'task.json').read_text())
            prompt=task['prompt']+'\nRead the task files in this workspace. '+task['delivery_rule']+' '+task['reuse_rule']
            (ctl/'prompt.txt').write_text(prompt)
            other=STAGES[(STAGES.index(stage)+1)%4]
            request={'workspace':str(work),'fresh_home':str(home),'controller_output_dir':str(ctl),
                'runtime':str(Path(cfg['runtime']).resolve()),'native_profile':str(Path(cfg['stage_profiles'][stage]).resolve()),
                'prompt_file':str(ctl/'prompt.txt'),'arm':state['arm'],'track':state['track'],'stage':stage,
                'model':cfg['model'],'reasoning_effort':cfg['reasoning_effort'],'stage_deadline_ms':cfg['stage_deadline_ms'],
                'execution_authorized':True,'authorization':cfg['authorization'],
                'native_config':cfg.get('native_config'),
                'periodic_capture_argv':cfg.get('periodic_capture_argv'),
                'forbidden_canaries':[str(root/'controller-canary'),str(root/'stages'/other/'home/foreign-canary')]}
            dump(ctl/'request.json',request)
            if cfg.get('stage_profile_argv'):
                argv=[x.replace('{request}',str(ctl/'request.json')) for x in cfg['stage_profile_argv']]
                result['native_preparation']=run_command(argv,root,cfg['capture_timeout_ms']/1000,ctl/'native-preparation.log')
                if result['native_preparation']['exit_code']!=0:raise ValueError('native stage preparation failed; see native-preparation.log')
            result['driver']=run_command(['node',str(driver),'run',str(ctl/'request.json')],root,cfg['stage_deadline_ms']/1000+15,ctl/'driver.log')
            if (ctl/'stage-result.json').exists():result['session']=json.loads((ctl/'stage-result.json').read_text())
            result['timing_valid']=result['driver']['timing_valid'] and result.get('session',{}).get('timing_valid',False)
            if 'session' not in result:result['infrastructure_failure']='driver did not produce a stage-result receipt; inspect driver.log'
            answer_path=ctl/'submission/answer.json'
            result['delivered']=verify_submission(ctl,cfg['stage_deadline_ms'],state['track'])
            if result['delivered']:
                result['grade']=(grade_engineering(ctl/'submission/tree',stage) if state['track']=='engineering'
                    else grade_pm(pack,stage,json.loads(answer_path.read_text())))
            else:result['grade']={'completed':False,'reason':'no timely immutable submission'}
            # Native capture is explicit and measured; no inferred successful handoff.
            capture=cfg.get('capture_argv',{}).get(stage)
            if capture:
                argv=[x.replace('{request}',str(ctl/'request.json')) for x in capture]
                result['capture']=run_command(argv,root,cfg['capture_timeout_ms']/1000,ctl/'capture.log')
            else:result['capture']={'status':'not_evaluated','reason':'native post-stage receipt absent'}
            result['status']='finished'
        except Exception as error:result['status']='failed';result['error']=str(error)[:2000]
        # Failed predecessor work remains available through ordinary team Git as in real engineering.
        # This snapshot is controller-owned infrastructure, not credited as a memory-product save.
        previous=work if state['track']=='engineering' else None
        dump(root/'sequence.json',state)
    state['status']='ended';state['cleanup']='native export/cleanup receipts required; stores are not silently deleted'
    if cfg.get('export_argv'):
        state['export']=run_command(cfg['export_argv'],root,cfg['capture_timeout_ms']/1000,root/'export.log')
    dump(root/'sequence.json',state);return state
