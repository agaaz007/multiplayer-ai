"""Versioned contract amendment: successful execute state is verified via GET job.

The frozen original grader remains unchanged. This copy preserves check IDs and
checks persisted state/receipt rather than requiring state in an HTTP200 body.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from provider_sim import Provider

def request(url,path,method='GET',data=None,owner='team-a'):
    headers={'Content-Type':'application/json'}
    if owner is not None: headers['X-Owner']=owner
    req=urllib.request.Request(url+path,data=json.dumps(data).encode() if data is not None else None,headers=headers,method=method)
    try:
        with urllib.request.urlopen(req,timeout=4) as r: return r.status,json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        body=e.read()
        try: parsed=json.loads(body or b'{}')
        except ValueError: parsed={'raw':body.decode(errors='replace')[:500]}
        return e.code,parsed

class App:
    def __init__(self,candidate,scratch,provider):
        self.candidate=Path(candidate).resolve();self.scratch=Path(scratch).resolve();self.provider=provider;self.proc=None
    def start(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        self.url=f'http://127.0.0.1:{port}'
        argv=[sys.executable,str(self.candidate/'app.py'),'--port',str(port),'--db',str(self.scratch/'app.sqlite'),'--provider-url',self.provider.url]
        self.log=open(self.scratch/'server.log','ab')
        # On macOS keep submitted code away from hidden grading files and parent workspace.
        if sys.platform=='darwin':
            allowed=[str(self.candidate),str(self.scratch),str(Path(sys.executable).resolve().parent.parent)]
            rules=''.join(f'(subpath {json.dumps(p)})' for p in allowed)
            policy=f'(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders"))(allow file-read-metadata)(deny file-write*)(allow file-read* {rules})(allow file-write* (subpath {json.dumps(str(self.scratch))}) (literal "/dev/null") (literal "/dev/tty"))'
            argv=['/usr/bin/sandbox-exec','-p',policy,*argv]
        env={'PATH':os.environ.get('PATH',''),'HOME':str(self.scratch),'TMPDIR':str(self.scratch),'PYTHONDONTWRITEBYTECODE':'1',
             '__CF_USER_TEXT_ENCODING':f'0x{os.getuid():x}:0:2'}
        self.proc=subprocess.Popen(argv,cwd=self.candidate,env=env,stdout=self.log,stderr=self.log,start_new_session=True)
        deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            if self.proc.poll() is not None: break
            try:
                if request(self.url,'/health',owner=None)[0]==200:return
            except Exception: pass
            time.sleep(.05)
        raise RuntimeError(f'application did not become healthy (exit={self.proc.poll()}): '+(self.scratch/'server.log').read_text(errors='replace')[-1200:])
    def stop(self):
        if self.proc is not None:
            try: os.killpg(self.proc.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            self.proc.wait(timeout=5);self.proc=None
        if hasattr(self,'log'): self.log.close()
    def call(self,path,method='GET',data=None,owner='team-a'):return request(self.url,path,method,data,owner)

def grade(candidate,stage):
    if stage not in 'ABCD' or len(stage)!=1: raise ValueError('stage must be A/B/C/D')
    checks=[];provider=Provider();critical=[]
    with tempfile.TemporaryDirectory(prefix='teamwork-grader-') as scratch:
        app=App(candidate,scratch,provider)
        def check(name,fn,severity='normal'):
            try: fn();checks.append({'id':name,'passed':True,'severity':severity})
            except Exception as e:
                checks.append({'id':name,'passed':False,'severity':severity,'error':str(e)[:1500]})
                if severity=='critical':critical.append(name)
        def require(condition,message):
            if not condition:raise AssertionError(message)
        def create(payload='hello',key=None,owner='team-a'):
            status,job=app.call('/jobs','POST',{'key':key or uuid.uuid4().hex,'payload':payload},owner)
            require(status==201 and isinstance(job.get('id'),str) and job.get('state')=='pending',f'create returned {status}: {job}')
            return job
        def require_completed(job,status,response):
            require(status==200,'successful execution did not return HTTP200')
            oracle=provider.receipts.get(job['id'])
            require(isinstance(oracle,dict) and isinstance(oracle.get('receipt_id'),str) and bool(oracle['receipt_id']),'provider has no completed receipt for this job')
            require(isinstance(response,dict) and response.get('receipt_id')==oracle['receipt_id'],'execute returned missing or incorrect receipt')
            get_status,persisted=app.call('/jobs/'+job['id'])
            require(get_status==200 and persisted.get('state')=='completed','GET job does not expose persisted completed state')
            require(persisted.get('receipt_id')==oracle['receipt_id'],'GET job receipt does not match provider receipt')
            return persisted
        try:
            app.start()
            def owner_test():
                require(app.call('/jobs','POST',{'key':'k','payload':'p'},None)[0]==401,'missing identity accepted')
                job=create();path='/jobs/'+job['id']
                routes=[(path,'GET',None)]
                if stage>='B':routes.append((path+'/execute','POST',{}))
                if stage>='C':routes.extend([('/batches','POST',{'job_ids':[job['id']]}),('/batches/status?ids='+job['id'],'GET',None)])
                if stage>='D':routes.append((path+'/cancel','POST',{}))
                before=(len(provider.posts),len(provider.gets))
                for route,method,data in routes:
                    require(app.call(route,method,data,None)[0]==401,'missing identity accepted: '+route)
                    require(app.call(route,method,data,'team-b')[0]==404,'cross-owner operation allowed: '+route)
                require((len(provider.posts),len(provider.gets))==before,'unauthorized request contacted provider')
                require(app.call(path)[1].get('state')=='pending','unauthorized request mutated job')
            check('owner-isolation',owner_test,'critical')
            def validation():
                for body in ({},{'key':'','payload':'x'},{'key':'x','payload':[]},{'key':2,'payload':'x'}):
                    require(app.call('/jobs','POST',body)[0]==400,'invalid input accepted')
            check('input-validation',validation)
            def idempotency():
                key=uuid.uuid4().hex;job=create(key=key)
                status,again=app.call('/jobs','POST',{'key':key,'payload':'hello'})
                require(status==200 and again.get('id')==job['id'],'not idempotent')
                require(app.call('/jobs','POST',{'key':key,'payload':'different'})[0]==409,'payload conflict not rejected')
                require(create(key=key,owner='team-b')['id']!=job['id'],'key incorrectly global')
            check('idempotency-and-key-scope',idempotency)
            def restart():
                job=create();app.stop();app.start()
                status,got=app.call('/jobs/'+job['id'])
                require(status==200 and got.get('payload')==job['payload'],'job lost on restart')
            check('durable-restart',restart)
            def concurrency():
                key=uuid.uuid4().hex
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    results=list(pool.map(lambda _:app.call('/jobs','POST',{'key':key,'payload':'same'}),range(4)))
                require(sorted(s for s,_ in results)==[200,200,200,201] and len({j.get('id') for _,j in results})==1,'concurrent duplicates created or failed')
            check('concurrent-create',concurrency)
            if stage>='B':
                def successful():
                    job=create();path='/jobs/'+job['id']+'/execute';before=len(provider.posts)
                    status,result=app.call(path,'POST',{})
                    require_completed(job,status,result)
                    app.stop();app.start();status,again=app.call(path,'POST',{})
                    require_completed(job,status,again)
                    require(again.get('receipt_id')==result['receipt_id'] and len(provider.posts)==before+1,'replayed external effect')
                check('execution-receipt-and-restart-replay',successful,'critical')
                def concurrent_execution():
                    job=create();path='/jobs/'+job['id']+'/execute';before=len(provider.posts)
                    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                        results=list(pool.map(lambda _:app.call(path,'POST',{}),range(4)))
                    require(all(status in (200,202) for status,_ in results),'concurrent execution failed')
                    status,result=app.call(path,'POST',{})
                    require_completed(job,status,result)
                    require(len(provider.posts)==before+1,'concurrent execution duplicated external effect')
                check('concurrent-execution-single-effect',concurrent_execution,'critical')
                def uncertain():
                    job=create('timeout-after-commit');path='/jobs/'+job['id']+'/execute';before=len(provider.posts)
                    status,result=app.call(path,'POST',{})
                    require(status==202 and result.get('state')=='outcome_unknown','lost response falsely resolved')
                    app.stop();app.start();status,result=app.call(path,'POST',{})
                    require_completed(job,status,result)
                    require(len(provider.posts)==before+1,'resent before reconciling')
                check('unknown-outcome-reconciliation',uncertain,'critical')
                def absent():
                    job=create('fail-before-commit');path='/jobs/'+job['id']+'/execute';before=len(provider.posts)
                    app.call(path,'POST',{});status,result=app.call(path,'POST',{})
                    require(status==202 and result.get('state')=='outcome_unknown' and len(provider.posts)==before+1,'404 receipt incorrectly authorizes retry')
                check('absent-receipt-stays-unknown',absent,'critical')
            if stage>='C':
                def batch():
                    a=create();b=create('fail-before-commit');ids=[a['id'],b['id']]
                    status,result=app.call('/batches','POST',{'job_ids':ids})
                    jobs=result.get('jobs',[])
                    require(status==200 and [j.get('id') for j in jobs]==ids and [j.get('state') for j in jobs]==['completed','outcome_unknown'],'batch loses states or order')
                    before=(len(provider.posts),len(provider.gets));status,result=app.call('/batches/status?ids='+','.join(ids))
                    require(status==200 and (len(provider.posts),len(provider.gets))==before,'status GET contacted provider')
                    require([j.get('id') for j in result.get('jobs',[])]==ids and [j.get('state') for j in result['jobs']]==['completed','outcome_unknown'],'status GET changed or omitted jobs')
                check('batch-composes-storage-and-execution',batch)
                def invalid_batch():
                    a=create();b=create(owner='team-b');before=len(provider.posts)
                    require(app.call('/batches','POST',{'job_ids':[a['id'],b['id']]})[0]==404 and len(provider.posts)==before,'unauthorized batch had partial side effect')
                    require(app.call('/batches','POST',{'job_ids':[a['id'],a['id']]})[0]==400,'duplicate IDs accepted')
                    require(app.call('/batches/status?ids='+a['id']+',missing')[0]==404,'missing job silently omitted')
                check('batch-prevalidation-and-missing-ids',invalid_batch,'critical')
            if stage>='D':
                def cancellation():
                    job=create();path='/jobs/'+job['id'];before=len(provider.posts)
                    status,result=app.call(path+'/cancel','POST',{})
                    require(status==200 and result.get('state')=='cancelled','pending cancel failed')
                    require(app.call(path+'/cancel','POST',{})[0]==200,'cancel not idempotent')
                    require(app.call(path+'/execute','POST',{})[0]==409 and len(provider.posts)==before,'cancelled job delivered')
                    for payload in ['hello','fail-before-commit']:
                        j=create(payload);app.call('/jobs/'+j['id']+'/execute','POST',{})
                        require(app.call('/jobs/'+j['id']+'/cancel','POST',{})[0]==409,'uncertain/completed work reported cancelled')
                check('cancellation-correction',cancellation,'critical')
        except Exception as e:
            checks.append({'id':'startup','passed':False,'error':str(e),'severity':'critical'});critical.append('startup')
        finally:app.stop();provider.close()
    return {'schema':'engineering-grade/v2','grading_amendment':'execute-response-contract-v2','stage':stage,'checks':checks,
            'passed':sum(c['passed'] for c in checks),'applicable':len(checks),
            'behavioral_pass':bool(checks) and all(c['passed'] for c in checks),
            'critical_errors':critical,'maintainability':'not_evaluated','reuse':'not_evaluated',
            'execution_isolation':'macOS seatbelt' if sys.platform=='darwin' else 'local trusted-artifact grading only; sandbox required for adversarial submissions'}


def regrade_all(matrix_status,out,manifest=None,grader=grade):
    """Uniform post-run amendment only; never update original sequence records."""
    import hashlib
    from fixtures import STAGES, validate
    from sequence import verify_submission
    status=json.loads(Path(matrix_status).read_text())
    if status.get('schema')!='teamwork-matrix-run/v2' or status.get('status')!='ended':
        raise ValueError('contract amendment may run only after the matrix has ended')
    source=Path(__file__).resolve().parent
    manifest=Path(manifest) if manifest else source/'grading-amendment-v2.json'
    frozen=json.loads(manifest.read_text())
    def sha(file):return hashlib.sha256(Path(file).read_bytes()).hexdigest()
    if frozen.get('amendment_id')!='execute-response-contract-v2':raise ValueError('unknown amendment manifest')
    for name,expected in frozen['files'].items():
        if sha(source/name)!=expected:raise ValueError('amendment source hash changed: '+name)
    if sha(source/'grade_engineering.py')!=frozen['original_grader_sha256']:raise ValueError('original frozen grader changed')
    out=Path(out).resolve();out.mkdir(parents=True,exist_ok=False)
    results={'schema':'engineering-contract-regrade/v2','amendment_id':frozen['amendment_id'],
             'matrix_status':str(Path(matrix_status).resolve()),'matrix_status_sha256':sha(matrix_status),
             'amendment_manifest_sha256':sha(manifest),'status':'running','stages':[],
             'original_metrics':'retained unchanged; this is a separate uniformly applied amendment',
             'task_timing':'original recorded timing unchanged; diagnostic/regrade time excluded',
             'excluded_development_seeds':[41]}
    def checkpoint():
        pending=out/'.results.json.tmp';pending.write_text(json.dumps(results,indent=2)+'\n');os.replace(pending,out/'results.json')
    checkpoint()
    for lane in status['preflight']['arms']:
        if lane.get('status')=='unavailable':
            for stage in STAGES:results['stages'].append({'arm':lane['arm'],'stage':stage,'status':'unavailable','reason':lane.get('reason')})
            checkpoint();continue
        for entry in lane.get('sequences',[]):
            root=Path(entry['root']);state=json.loads((root/'sequence.json').read_text())
            if state['track']!='engineering':continue
            launch=json.loads(Path(entry['launch']).read_text());pack=Path(state['pack'])
            seed=json.loads((pack/'manifest.json').read_text())['seed']
            if seed==41 or launch.get('development_probe') is True or launch.get('scored') is False:continue
            validate(pack)
            if sha(pack/'manifest.json')!=state['pack_manifest_sha256']:raise ValueError('frozen pack changed')
            if sha(pack/'agent/engineering/B/API.md')!=frozen['public_stage_b_contract_sha256']:raise ValueError('public contract differs from reviewed amendment')
            for stage in STAGES:
                ctl=root/'stages'/stage/'controller';old=state.get('stages',{}).get(stage,{})
                item={'arm':lane['arm'],'stage':stage,'seed':seed,'sequence_root':str(root),
                      'original_grade':old.get('grade'),'original_timing_valid':old.get('timing_valid'),'status':'not_evaluated'}
                results['stages'].append(item)
                try:
                    if not verify_submission(ctl,launch['stage_deadline_ms'],'engineering'):
                        item['reason']='no verified timely immutable submission';checkpoint();continue
                    item['submission_answer_sha256']=sha(ctl/'submission/answer.json')
                    item['delivery_receipt_sha256']=sha(ctl/'delivery.json')
                    item['amended_grade']=grader(ctl/'submission/tree',stage)
                    if not verify_submission(ctl,launch['stage_deadline_ms'],'engineering'):raise ValueError('submission changed during diagnostic')
                    before={check['id']:check['passed'] for check in (old.get('grade') or {}).get('checks',[])}
                    item['changed_check_ids']=[check['id'] for check in item['amended_grade'].get('checks',[]) if before.get(check['id'])!=check['passed']]
                    item['status']='regraded'
                except Exception as error:item['reason']=str(error)
                checkpoint()
    results['status']='ended';checkpoint()
    lines=['# Uniform post-run engineering contract amendment','','Original frozen grades remain unchanged. Successful execute response bodies may be receipts or full jobs; persisted completed state and the provider-matching receipt are verified through GET job. Timing and submission provenance remain original.','',
           '| Arm | Stage | Status | Original checks | Amended checks | Changed checks |','|---|---|---|---|---|---|']
    for item in results['stages']:
        original=item.get('original_grade') or {};amended=item.get('amended_grade') or {}
        count=lambda record:f"{record['passed']}/{record['applicable']}" if 'passed' in record and 'applicable' in record else 'not evaluated'
        lines.append('| '+' | '.join([item['arm'],item['stage'],item['status'],count(original),count(amended),', '.join(item.get('changed_check_ids',[])) or item.get('reason','none')])+' |')
    lines.extend(['','Detailed original and amended critical-error/check vectors are retained in results.json. No aggregate product leaderboard is computed.'])
    (out/'results.md').write_text('\n'.join(lines)+'\n');return results


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__);commands=parser.add_subparsers(dest='command',required=True)
    command=commands.add_parser('regrade');command.add_argument('--matrix-status',required=True);command.add_argument('--out',required=True);command.add_argument('--manifest')
    args=parser.parse_args();result=regrade_all(args.matrix_status,args.out,args.manifest)
    print(json.dumps({'status':result['status'],'stages':len(result['stages']),'out':str(Path(args.out).resolve())}))
