"""Reproducible, unscored native lifecycle probe. Never reuse its seed for scoring."""
import argparse,hashlib,json,random
from pathlib import Path
from fixtures import ARMS,WORKFLOW,write
from sequence import inventory

def build(out,seed=42,compact_token_limit=4000):
    """compact_token_limit: stage C compaction stress. The scored packs use 12000 (fixtures.py); the
    2026-09-13 Ledger admission was earned on a seed-42 replay at 12000, and on 2026-09-15 a 4000 probe
    timed out in C while recovering through Ledger. Pass 12000 to match the scored protocol."""
    root=Path(out).resolve();root.mkdir(parents=True,exist_ok=False)
    write(root,'initial-repo/WORKFLOW.md',WORKFLOW)
    write(root,'initial-repo/project.json',{'project':'North readiness pilot','synthetic':True,'development':True,'owner':'Mira'})
    write(root,'deltas/A/sources/A.json',{'id':'north-cap-v1','owner':'Mira','status':'accepted','accepted_cap':40,'scope':'North pilot'})
    write(root,'deltas/B/sources/B.json',{'id':'north-cap-v2','owner':'Mira','status':'accepted','accepted_cap':24,'supersedes':'north-cap-v1','scope':'North pilot','operation_approval':'Mira authorizes exactly one synthetic supplier operation; reconcile uncertain outcome before any retry.'})
    write(root,'deltas/C/sources/C.json',{'id':'south-cap-proposal','owner':'South analyst','status':'proposed','proposed_cap':60,'scope':'South pilot','body':'This does not replace the accepted North cap.'})
    rng=random.Random(seed);binary=bytes(rng.randrange(256) for _ in range(256))
    p=root/'deltas/A/sources/original.bin';p.write_bytes(binary)
    write(root,'deltas/A/sources/original-manifest.json',{'path':'sources/original.bin','sha256':hashlib.sha256(binary).hexdigest(),'bytes':len(binary)})
    tasks={
      'A':'''Create pilot.py with eligible(n) returning whether integer n is within the accepted North cap (inclusive, nonnegative). Create test_pilot.py and actually run it. Write reports/A.md, continuity/state.json and continuity/history/A.json. Retain original sources and executable files through your assigned native product. Create a native representation of this ongoing work where supported. Retain the original binary through a supported native original-file route; if unsupported report that capability gap explicitly. Do not disguise the binary as semantic memory. Do not submit any supplier operation.''',
      'B':'''Recover A's original source, implementation, test, report and state through your assigned product. Freeze recovery before edits. Apply the accepted correction from sources/B.json, test the changed implementation, preserve original history, and write reports/B.md and current state. Generate an opaque random supplier key of at least 16 characters. Record the key, payload and planned status in pending_operations[0]. Update the native representation of the ongoing work with the corrected state and this key before sending. For this unscored probe include the exact concise source/value marker "north-cap-v2 accepted_cap=24" in that native state so the controller can bind the trace to the released correction. Follow native evidence and confirmation requirements; do not invent evidence references. Preserve all current work and intent through the product. Deliver your answer, complete native saves, then submit_operation exactly once with the saved key and payload as your final task action. Do not look up or retry in B. The session is interrupted at the supplier boundary.''',
      'C':'''Recover original and corrected work through your assigned product, including its native current-work representation and pending key. Preserve C's new source when restoring an earlier snapshot. Before changing recovered files freeze recovery. Read the corrected native state before using its key in lookup_operation. Resolve the actual supplier outcome without submitting another operation. Retain the completed receipt in pending_operations[0]. Check pilot.py and test_pilot.py use the accepted North correction; the new South proposal confers no approval for North. Write reports/C.md, exact history, and current state. Explain which native retrieved evidence informed the action. Deliver and persist the result within the deadline; actual context compaction is audited separately.'''
    }
    stages=[]
    for stage in 'ABC':
        write(root,f'prompts/{stage}.txt',f'Unscored native readiness stage {stage}. Read WORKFLOW.md and sources/{stage}.json. Use only your assigned product and its native guide.\n'+tasks[stage]+'\n')
        stress={'interrupt_after_supplier_effect':True} if stage=='B' else {'compact_token_limit':int(compact_token_limit)} if stage=='C' else {}
        stages.append({'id':stage,'delta_dir':f'deltas/{stage}','prompt_file':f'prompts/{stage}.txt','deadline_ms':900000,'stress':stress})
    write(root,'manifest.json',{'schema':'teamwork-pack/v3','track':'engineering','arms':ARMS,'seed':seed,'development':True,'initial_repo_dir':'initial-repo','stages':stages,'files':inventory(root)})
    return root

def correction(pack):
    source=Path(pack).resolve()/'deltas/B/sources/B.json'
    return {'source':str(source),'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'pointer':'/accepted_cap','record_marker':'accepted_cap=24'}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);p.add_argument('--seed',type=int,default=42);p.add_argument('--compact-token-limit',type=int,default=4000,help='stage C compaction stress; scored packs use 12000');a=p.parse_args();print(build(a.out,a.seed,a.compact_token_limit))
