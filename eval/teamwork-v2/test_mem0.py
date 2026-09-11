import unittest
from mem0 import Mem0

class Mem0Tests(unittest.TestCase):
    def setUp(self):
        self.calls=[]
        def request(method,path,body):self.calls.append((method,path,body));return {'event_id':'event-123','status':'PENDING'} if 'add' in path else {'results':[]}
        self.client=Mem0('not-a-real-key','teamwork_isolated_123',transport=request,authorize=lambda operation:True)
    def test_native_v3_scope_and_async_receipt(self):
        self.client.call('add',messages=[{'role':'user','content':'The pilot has not been approved.'}])
        self.assertEqual(self.calls[0][2]['user_id'],'teamwork_isolated_123');self.assertTrue(self.calls[0][2]['infer'])
        self.client.call('search',query='pilot approval');self.assertEqual(self.calls[1][2]['filters'],{'user_id':'teamwork_isolated_123'})
        self.client.call('event',event_id='event-123');self.assertEqual(self.calls[2][1],'/v1/event/event-123/')
    def test_foreign_scope_and_event_rejected(self):
        with self.assertRaises(ValueError):self.client.call('search',query='x',filters={'user_id':'other'})
        with self.assertRaises(ValueError):self.client.call('event',event_id='foreign')
        with self.assertRaises(ValueError):self.client.call('add',messages=[],user_id='other')
        self.assertEqual(self.calls,[])
    def test_no_implicit_paid_requests(self):
        client=Mem0('not-a-real-key','teamwork_isolated_123',transport=lambda *args:self.fail('request escaped'))
        with self.assertRaises(RuntimeError):client.call('search',query='x')

if __name__=='__main__':unittest.main()
