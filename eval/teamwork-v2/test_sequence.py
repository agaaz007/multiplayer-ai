import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from sequence import verify_submission,inherit_shared_git,run_command


class SequenceIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def submission(self):
        submission=self.root/'submission';submission.mkdir();tree=submission/'tree';tree.mkdir()
        answer=submission/'answer.json';answer.write_text('{"result":"ready"}\n')
        (tree/'app.py').write_text('print("submitted")\n')
        receipt={'elapsed_ms':50,'answer_file_sha256':hashlib.sha256(answer.read_bytes()).hexdigest(),
                 'tree':{'files':{'app.py':hashlib.sha256((tree/'app.py').read_bytes()).hexdigest()}}}
        (self.root/'delivery.json').write_text(json.dumps(receipt))
        return answer,tree
    def test_answer_hash_tampering_rejected(self):
        answer,tree=self.submission();self.assertTrue(verify_submission(self.root,100,'engineering'))
        answer.write_text('{"result":"replaced"}')
        with self.assertRaisesRegex(ValueError,'answer changed'):verify_submission(self.root,100,'engineering')
    def test_extra_file_rejected(self):
        _,tree=self.submission();(tree/'injected.py').write_text('later repair')
        with self.assertRaisesRegex(ValueError,'tree changed'):verify_submission(self.root,100,'engineering')
    def test_symlink_rejected(self):
        answer,tree=self.submission();(tree/'link').symlink_to(answer)
        with self.assertRaisesRegex(ValueError,'symlink'):verify_submission(self.root,100,'engineering')
    def test_late_delivery_not_graded(self):
        self.submission();self.assertFalse(verify_submission(self.root,20,'engineering'))
    def test_shared_git_preserves_commits_and_uncommitted_work(self):
        previous=self.root/'previous';work=self.root/'next';previous.mkdir();work.mkdir()
        subprocess.run(['git','init','-q',str(previous)],check=True)
        (previous/'app.py').write_text('committed')
        subprocess.run(['git','-C',str(previous),'add','app.py'],check=True)
        subprocess.run(['git','-C',str(previous),'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','first'],check=True)
        original=subprocess.check_output(['git','-C',str(previous),'rev-parse','HEAD'])
        (previous/'app.py').write_text('unfinished successor work')
        inherit_shared_git(previous,work)
        self.assertEqual(subprocess.check_output(['git','-C',str(work),'rev-parse','HEAD']),original)
        self.assertEqual((work/'app.py').read_text(),'unfinished successor work')
    def test_timeout_terminates_detached_descendant(self):
        child_pid=self.root/'child.pid'
        child='import time;time.sleep(60)'
        script=f'import subprocess,sys,time;from pathlib import Path;p=subprocess.Popen([sys.executable,"-c",{child!r}],start_new_session=True);Path({str(child_pid)!r}).write_text(str(p.pid));time.sleep(60)'
        result=run_command([sys.executable,'-c',script],self.root,.5,self.root/'log')
        self.assertTrue(result['timed_out'])
        pid=int(child_pid.read_text())
        # A killed child can briefly remain a zombie until the platform reaps it.
        state=subprocess.run(['ps','-o','stat=','-p',str(pid)],capture_output=True,text=True).stdout.strip()
        self.assertTrue(not state or state.startswith('Z'),state)

if __name__=='__main__':unittest.main()
