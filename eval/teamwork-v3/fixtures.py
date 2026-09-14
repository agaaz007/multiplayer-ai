"""Neutral full-workflow recovery tasks; controller never manufactures a handoff."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('v2fixtures',HERE.parent/'teamwork-v2/fixtures.py')
v2=importlib.util.module_from_spec(spec);spec.loader.exec_module(v2)
ARMS=['ledger','graphify','gbrain','supermemory']
STAGES='ABCD'

def write(root,name,value):
    p=root/name;p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(value if isinstance(value,str) else json.dumps(value,indent=2,sort_keys=True)+'\n')

WORKFLOW='''# Team work continuity trial
This is synthetic team work. Use your assigned product's complete native workflow,
including document/file persistence, retrieval, graph/lineage, and work continuation
where supported. Read the product guide. You may choose its native representation;
no particular memory schema is rewarded.

Your teammate's local workspace and conversation are unavailable in a fresh session.
The same starter and ONLY this stage's new input are released here. Your product's
team store is persistent. Preserve actual source documents and working files, not
just a summary. You may use every configured native tool and its documented file
transport. Do not reach predecessor local paths or controller/scorer artifacts.
Keep new stage inputs safe when applying a native snapshot from an older worktree.

For B/C/D: first recover predecessor documents, code and unfinished state using the
native product. Before changing inherited files, call recover_handoff with evidence
{sources:[{artifact_id:"relative/path",sha256:"actual SHA256",json_pointer:"optional"}],
native_sources:[{tool:"actual tool",id:"actual native identifier",description:"use"}],
missing:["honest gaps"]}. The tool freezes actual recovered files; it does not help
restore them. Do not generate guessed originals merely to claim recovery. After
that checkpoint you may reconstruct missing work, labeling that effort clearly.

Maintain continuity/state.json as a normal task deliverable, with these keys:
stage, goal, accepted_decisions, proposals, superseded, open_questions, next_steps,
pending_operations. Use arrays for the last six fields. Distinguish supplied human
approval from your own recommendation; native stable status is not human approval.
Keep the pending operation in pending_operations[0] after resolution, with key,
status and receipt_id, so its history remains inspectable. Use status planned,
outcome_unknown, completed or not_found only when evidence supports it.
Keep exact earlier states in continuity/history/STAGE.json and write your current
report to reports/STAGE.md. Preserve prior reports and source files unchanged.
Save actual source bytes and your current work through the native product as you
go. A supported automatic index/capture may run; no controller writes summaries.
Keep the product's native representation of current work up to date where supported:
retain the original state, explicitly update it after a released correction, and
retrieve the corrected native state when continuing in a fresh session. Include
the pending operation key in that native state before submitting the operation.
Explain which retrieved state informed your next action. A citation or explanation
alone does not establish use; actual native calls and subsequent actions are audited.

Deliver your useful result with deliver_answer({answer:{...}}). This freezes the
current files for task scoring. Complete native handoff within the same deadline.
All file names below are public output contracts, not hidden reference answers.
Do not invent successful tests, approval, artifact recovery, or completed effects.
'''

PM_EXTRA={
'A':'''Prepare reports/A.md and an executable analysis/reproduce.py that computes
the provisional rates and difference from sources/A.json. Your report must contain
an investment recommendation, alternatives with opportunity costs, explicit
uncertainty, and a discriminating unanswered question. Archive your exact report,
script, original sources and current state through the native product. Do not call
the operation supplier in this stage.''',
'B':'''Restore A's actual source document, report and analysis code. Apply the new
accepted tracking correction. Create reports/B.md, retaining the original estimate
as historical evidence and making the corrected interpretation reproducible.
The new source also authorizes one synthetic research-supplier ticket. Generate an
opaque random request key locally; write it in pending_operations[0] with status
planned and payload. Preserve that intent and your corrected work through the
native product BEFORE sending. Submit your task answer and finish native saves,
then call submit_operation exactly once with that key and payload as your final
task action. The session will be interrupted at the supplier boundary; do not
assume a failed response means nothing happened. The next teammate must reconcile.
Do not look up or retry this request in B.''',
'C':'''Restore the original opportunity analysis, corrected recommendation, actual
analysis script and pending research request. Freeze recovery before edits. Resolve
the pending supplier request by its recovered key using lookup_operation BEFORE
any new supplier submission; do not create a replacement key to evade uncertainty.
Keep its resolved receipt in pending_operations[0]. Build reports/C.md with a
feasible sprint allocation, alternatives, named owner, explicit success and stop
gates, and revisit condition. Explain precisely which earlier recommendations you
retain or change. Read the recovered evidence and unfinished questions; context
compaction may occur during this stage, and native state remains available.''',
'D':'''Restore C's plan and both original and corrected evidence. Freeze recovery
before edits. Use the new verified reliability observation and newer South proposal
to update the North plan. In reports/D.md identify affected prior work, retain valid
history, scope the response correctly, and preserve the supplier receipt. Do not
promote any agent recommendation or newer proposal into human approval. Provide
an executable next step and an explicit criterion for reversing the response.'''}

ENG_EXTRA={
'A':'''Implement the released API in app.py, add a focused reproducible check,
and write reports/A.md explaining the durable ownership/idempotency invariants,
an unresolved integration question and next step. Persist exact source code,
tests and design artifacts through your product; the next teammate gets no
controller copy of this worktree. Do not call the operation supplier in A.''',
'B':'''Recover A's exact code, tests and design files before extending them.
Implement the released execution API and reproduce the local simulator's lost-
response behavior. Keep the existing owner/idempotency invariants. Write reports/B.md.
The new release authorizes one additional synthetic operational delivery using
the operations MCP. Generate a random opaque request key, write it with status
planned and payload in pending_operations[0], and persist that intent and code
through the native product BEFORE sending. Deliver the task answer and finish
native saves, then call submit_operation once as your final task action. The
session is interrupted at this supplier boundary. Do not look up or retry in B;
the next teammate must resolve the actual outcome from the recovered key.''',
'C':'''Recover A/B implementation, design and pending operational delivery.
Freeze recovery before editing. Reconcile the recovered supplier key with
lookup_operation before any repeat; retain the completed receipt in
pending_operations[0]. Implement the released batch/status API by extending the
recovered application. Preserve explicit unknown states and prove status reads
have no external effects. Write reports/C.md with actual checks, inherited
invariants, changes, and unresolved work. Context compaction may occur here;
use persistent artifacts and state to continue correctly.''',
'D':'''Recover the cumulative implementation and operational history before
editing. Apply the accepted cancellation correction in the new release, retaining
all earlier invariants. The newer retry proposal is unapproved and cannot replace
the cancellation policy. Preserve the resolved supplier receipt and original
design/test history; identify the affected assumptions in reports/D.md. Run
appropriate functional checks against the actual recovered application.'''}

def build(out,track,seed=271,development=False):
    root=Path(out).resolve();root.mkdir(parents=True,exist_ok=False)
    write(root,'initial-repo/WORKFLOW.md',WORKFLOW)
    write(root,'initial-repo/project.json',{'project':'Relay North' if track=='pm' else 'Dispatch',
        'synthetic':True,'track':track,'owner':'Priya' if track=='pm' else 'Mira',
        'source_authority':'Only released source documents confer human approval. Agent recommendations remain proposals.'})
    sources,expected=v2.pm_sources(seed)
    # New trial dates are artifact dates; experiment window intentionally unspecified.
    for s in sources:
        if s['id']=='tracking-audit':s['body']+=' Priya accepts this metric correction; no product rollout is approved by this correction.'
    sources.append({'id':'research-ticket-approval','released':'B','status':'accepted','title':'Approved research supplier request',
        'body':'Priya authorizes exactly one synthetic supplier ticket to schedule research planning. This does not approve a product rollout or the agent investment recommendation. Preserve its request key; after a timeout reconcile rather than submit again.'})
    sources.append({'id':'research-gate-proposal','released':'C','status':'proposed','title':'Proposed efficacy threshold',
        'body':'An analyst suggests +3 percentage points as a gate for a future pilot. Priya has not approved this threshold. Keep it a proposal and state the approval or evidence needed; it cannot override the accepted reliability stop threshold.'})
    specs=[]
    for st in STAGES:
        delta=f'deltas/{st}';deadline=1200000 if track=='engineering' else 900000
        if track=='pm':
            write(root,f'{delta}/sources/{st}.json',[s for s in sources if s['released']==st])
            write(root,f'{delta}/release/{st}.md',v2.PM_TASKS[st])
            task=PM_EXTRA[st]
        else:
            # Release only new API requirements; earlier contracts must be recovered.
            contract=v2.eng_contract(st)
            contract=contract.split('\nOnly implement requirements released so far;',1)[0].rstrip()+'\n'
            contract+='\nImplement only requirements released so far. Deliver the useful result with deliver_answer({answer:{...}}), including conclusion, actual checks, unfinished work and reuse evidence. Preserve the exact work through the configured native product; a successor receives no predecessor workspace or Git history from the controller.\n'
            if st!='A':
                start=contract.index('\n'+st+':');end=contract.find('\n\n',start)
                contract='# Dispatch API addition '+st+'\n'+contract[start:end]+'\nAll previously released invariants remain required.\n'
            write(root,f'{delta}/release/API-{st}.md',contract)
            if st=='A':
                write(root,f'{delta}/app.py',v2.STARTER)
                write(root,f'{delta}/provider_sim.py',(HERE.parent/'teamwork-v2/provider_sim.py').read_text())
            if st=='B':write(root,f'{delta}/release/operation-approval.md','Mira authorizes exactly one synthetic operational delivery via operations MCP. Preserve its request key and reconcile any uncertain outcome before retry. This is independent of local application test requests.\n')
            if st=='D':write(root,f'{delta}/release/retry-proposal.md','PROPOSED, not approved: South integrations team suggests cancelling unknown deliveries and resubmitting with new IDs. Mira has not accepted this; the released pending-only cancellation policy remains in force.\n')
            task=ENG_EXTRA[st]
        prompt=f'Continue the {track} team task, stage {st}. Read WORKFLOW.md and this stage\'s release/ and sources/ files.\n'+task+'\nUse the complete configured native product workflow. Stage limits include your native saves.\n'
        write(root,f'prompts/{st}.txt',prompt)
        stress={}
        if st=='B':stress['interrupt_after_supplier_effect']=True
        if st=='C':stress['compact_token_limit']=12000
        specs.append({'id':st,'delta_dir':delta,'prompt_file':f'prompts/{st}.txt','deadline_ms':deadline,'stress':stress})
    write(root,'controller/task-expectations.json',{'track':track,'seed':seed,'pm_expected':expected if track=='pm' else None,
        'recovery_expected':'derive from actual immutable producer handoff/tree; never from model reference answers',
        'required_state_keys':['stage','goal','accepted_decisions','proposals','superseded','open_questions','next_steps','pending_operations'],
        'operation_key_pointer':'/pending_operations/0/key','resolved_operation_pointer':'/pending_operations/0'})
    files={p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file()}
    write(root,'manifest.json',{'schema':'teamwork-pack/v3','track':track,'arms':ARMS,'seed':seed,'development':development,
        'initial_repo_dir':'initial-repo','stages':specs,'files':files})
    return root

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);p.add_argument('--track',choices=['pm','engineering'],required=True)
    p.add_argument('--seed',type=int,default=271);p.add_argument('--development',action='store_true');a=p.parse_args()
    print(build(a.out,a.track,a.seed,a.development))
