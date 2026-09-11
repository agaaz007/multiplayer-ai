"""Controller-owned external-effect oracle; never uses a real delivery provider."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

class Provider:
    def __init__(self):
        self.receipts={}; self.posts=[]; self.lock=threading.Lock()
        outer=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def reply(self,status,data):
                body=json.dumps(data).encode();self.send_response(status)
                self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)))
                self.end_headers();self.wfile.write(body)
            def do_GET(self):
                key=unquote(self.path.removeprefix('/receipts/'))
                with outer.lock: receipt=outer.receipts.get(key)
                self.reply(200 if receipt else 404,receipt or {'error':'unknown'})
            def do_POST(self):
                try:
                    data=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
                    key=data['key'];payload=data['payload']
                except Exception: self.reply(400,{});return
                with outer.lock:
                    outer.posts.append(data)
                    if payload == 'fail-before-commit':
                        receipt=None
                    else:
                        receipt=outer.receipts.setdefault(key,{'receipt_id':'receipt-'+key,'key':key})
                # Observable external receipt exists even though application saw an error.
                if payload in ('timeout-after-commit','fail-before-commit'): self.reply(503,{'error':'response unavailable'})
                else: self.reply(200,receipt)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url=f'http://127.0.0.1:{self.server.server_port}'
    def close(self): self.server.shutdown();self.server.server_close();self.thread.join()
