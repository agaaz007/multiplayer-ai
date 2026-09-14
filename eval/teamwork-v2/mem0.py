"""Controller-side Mem0 Platform V3 adapter; official HTTP, no reimplementation.

Only explicit native operations are exposed. Entity scoping is not claimed to be
credential-level isolation: keep the key controller-side and freeze one user_id
per sequence. Full plugin/capture readiness remains a separate live probe.
"""
import json
import re
import urllib.error
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RuntimeError('Mem0 redirect rejected')

class Mem0:
    def __init__(self,key,namespace,transport=None,authorize=None):
        if not re.fullmatch(r'teamwork_[a-zA-Z0-9_-]{8,100}',namespace):raise ValueError('invalid private sequence namespace')
        if not key:raise ValueError('missing Mem0 key')
        self.key=key;self.namespace=namespace;self.transport=transport or self._http
        self.authorize=authorize;self.events=set()
    def _http(self,method,path,body):
        req=urllib.request.Request('https://api.mem0.ai'+path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization':'Token '+self.key,'Content-Type':'application/json'},method=method)
        try:
            with urllib.request.build_opener(NoRedirect()).open(req,timeout=30) as response:return json.loads(response.read())
        except Exception as e:raise RuntimeError('Mem0 request failed ('+type(e).__name__+'); reconcile operation before retry') from None
    def call(self,operation,**args):
        if self.authorize is None or self.authorize(operation) is not True:
            raise RuntimeError('Mem0 operation has no controller budget authorization')
        if operation=='add':
            if set(args)-{'messages'}:raise ValueError('scope/inference overrides are not permitted')
            messages=args.get('messages')
            if not isinstance(messages,list) or not messages or any(not isinstance(x,dict)
                or set(x)!={'role','content'} or x['role'] not in ('user','assistant')
                or not isinstance(x['content'],str) for x in messages):raise ValueError('invalid messages')
            if len(json.dumps(messages))>200000:raise ValueError('message budget exceeded')
            result=self.transport('POST','/v3/memories/add/',{'messages':messages,'user_id':self.namespace,'infer':True})
            if isinstance(result,dict) and isinstance(result.get('event_id'),str):self.events.add(result['event_id'])
            return result
        if operation=='search':
            if set(args)-{'query','top_k'}:raise ValueError('scope overrides are not permitted')
            if not isinstance(args.get('query'),str) or not args['query'].strip():raise ValueError('query required')
            top=args.get('top_k',10)
            if type(top) is not int or not 1<=top<=50:raise ValueError('top_k outside bounds')
            return self.transport('POST','/v3/memories/search/',{'query':args['query'],
                'filters':{'user_id':self.namespace},'top_k':top})
        if operation=='event':
            if set(args)!={'event_id'} or args['event_id'] not in self.events:raise ValueError('event was not created by this adapter')
            if not re.fullmatch(r'[a-zA-Z0-9_-]+',args['event_id']):raise ValueError('invalid event ID')
            return self.transport('GET','/v1/event/'+args['event_id']+'/',None)
        raise ValueError('unsupported operation')
