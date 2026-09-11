"""CONTROLLER-ONLY reference to validate the grader. Never seed agent work with it."""
import argparse
import json
import sqlite3
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,required=True);parser.add_argument('--db',required=True);parser.add_argument('--provider-url',required=True)
    args=parser.parse_args();lock=threading.RLock()
    db=sqlite3.connect(args.db,check_same_thread=False);db.row_factory=sqlite3.Row
    db.execute('CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner TEXT,key TEXT,payload TEXT,state TEXT,receipt_id TEXT,UNIQUE(owner,key))');db.commit()
    def job(owner,identity):
        row=db.execute('SELECT * FROM jobs WHERE owner=? AND id=?',(owner,identity)).fetchone()
        return dict(row) if row else None
    def state(j,value,receipt=None):
        db.execute('UPDATE jobs SET state=?,receipt_id=? WHERE id=?',(value,receipt,j['id']));db.commit()
        return job(j['owner'],j['id'])
    def provider(path,data=None):
        req=urllib.request.Request(args.provider_url+path,data=json.dumps(data).encode() if data else None,headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=2) as response:return response.status,json.loads(response.read())
        except urllib.error.HTTPError as e:return e.code,{}
        except Exception:return 503,{}
    def execute(j):
        if j['state']=='cancelled':return 409,j
        if j['state']=='completed':return 200,j
        if j['state']=='outcome_unknown':
            status,receipt=provider('/receipts/'+urllib.parse.quote(j['id']))
            return (200,state(j,'completed',receipt['receipt_id'])) if status==200 else (202,j)
        # Mark uncertain durably BEFORE the effect, so process death cannot cause blind resend.
        j=state(j,'outcome_unknown')
        status,receipt=provider('/deliver',{'key':j['id'],'payload':j['payload']})
        return (200,state(j,'completed',receipt['receipt_id'])) if status==200 else (202,j)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def reply(self,status,data):
            payload=json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
        def do_GET(self):self.handle_request()
        def do_POST(self):self.handle_request()
        def handle_request(self):
            if self.path=='/health':self.reply(200,{'status':'ok'});return
            owner=self.headers.get('X-Owner')
            if not owner:self.reply(401,{});return
            try:
                data=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or b'{}')
                with lock:status,result=self.route(owner,data)
                self.reply(status,result)
            except (ValueError,TypeError,KeyError):self.reply(400,{})
        def route(self,owner,data):
            path=urllib.parse.urlparse(self.path)
            if path.path=='/jobs' and self.command=='POST':
                if not all(isinstance(data.get(k),str) and data[k] for k in ['key','payload']):return 400,{}
                row=db.execute('SELECT id,payload FROM jobs WHERE owner=? AND key=?',(owner,data['key'])).fetchone()
                if row:return (200,job(owner,row['id'])) if row['payload']==data['payload'] else (409,{})
                identity=uuid.uuid4().hex;db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?)',(identity,owner,data['key'],data['payload'],'pending',None));db.commit();return 201,job(owner,identity)
            if path.path.startswith('/jobs/'):
                parts=path.path.split('/');j=job(owner,parts[2])
                if not j:return 404,{}
                if len(parts)==3 and self.command=='GET':return 200,j
                if len(parts)==4 and self.command=='POST':
                    if parts[3]=='execute':return execute(j)
                    if parts[3]=='cancel':
                        if j['state']=='cancelled':return 200,j
                        return (200,state(j,'cancelled')) if j['state']=='pending' else (409,j)
            if path.path in ('/batches','/batches/status'):
                if path.path=='/batches' and self.command=='POST':ids=data.get('job_ids');run=True
                elif path.path=='/batches/status' and self.command=='GET':ids=urllib.parse.parse_qs(path.query).get('ids',[''])[0].split(',');run=False
                else:return 404,{}
                if not isinstance(ids,list) or not ids or not all(isinstance(x,str) and x for x in ids) or len(set(ids))!=len(ids):return 400,{}
                jobs=[job(owner,x) for x in ids]
                if not all(jobs):return 404,{}
                return 200,{'jobs':[execute(j)[1] for j in jobs] if run else jobs}
            return 404,{}
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()

if __name__=='__main__':main()
