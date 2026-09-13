"""Independent black-box HTTP acceptance, including real process restart."""
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
                    require(status==200 and result.get('state')=='completed' and result.get('receipt_id'),'missing execution receipt')
                    app.stop();app.start();status,again=app.call(path,'POST',{})
                    require(status==200 and again.get('receipt_id')==result['receipt_id'] and len(provider.posts)==before+1,'replayed external effect')
                check('execution-receipt-and-restart-replay',successful,'critical')
                def concurrent_execution():
                    job=create();path='/jobs/'+job['id']+'/execute';before=len(provider.posts)
                    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                        results=list(pool.map(lambda _:app.call(path,'POST',{}),range(4)))
                    require(all(status in (200,202) for status,_ in results),'concurrent execution failed')
                    status,result=app.call(path,'POST',{})
                    require(status==200 and result.get('state')=='completed' and len(provider.posts)==before+1,'concurrent execution duplicated effect or lost completion')
                check('concurrent-execution-single-effect',concurrent_execution,'critical')
                def uncertain():
                    job=create('timeout-after-commit');path='/jobs/'+job['id']+'/execute';before=len(provider.posts)
                    status,result=app.call(path,'POST',{})
                    require(status==202 and result.get('state')=='outcome_unknown','lost response falsely resolved')
                    app.stop();app.start();status,result=app.call(path,'POST',{})
                    require(status==200 and result.get('state')=='completed' and result.get('receipt_id')==provider.receipts[job['id']]['receipt_id'],'failed to reconcile committed effect')
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
    return {'schema':'engineering-grade/v2','stage':stage,'checks':checks,
            'passed':sum(c['passed'] for c in checks),'applicable':len(checks),
            'behavioral_pass':bool(checks) and all(c['passed'] for c in checks),
            'critical_errors':critical,'maintainability':'not_evaluated','reuse':'not_evaluated',
            'execution_isolation':'macOS seatbelt' if sys.platform=='darwin' else 'local trusted-artifact grading only; sandbox required for adversarial submissions'}
