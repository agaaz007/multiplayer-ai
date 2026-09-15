"""Seeded synthetic task data. This file is controller-only, never agent input."""
import hashlib
import json
import random
import shutil
from pathlib import Path

STAGES = 'ABCD'
ARMS = ['ledger', 'supermemory', 'mem0', 'gbrain', 'graphify', 'fresh-agent']

def dump(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')

ENGINEERING_CONTRACT = '''# Dispatch public API contract
Synthetic engineering fixture. Use Python 3 standard library; application storage must
persist in SQLite. Start with `python3 app.py --port PORT --db FILE --provider-url URL`.
Listen on 127.0.0.1. GET /health returns 200. JSON responses; no live services.

All job/batch operations require `X-Owner` (an authenticated test identity supplied
by a trusted edge; implementing the edge itself is out of scope). Missing header:
401. Looking up another owner's job must return 404, without leaking its fields.

A: POST /jobs {key, payload}, where both are nonempty strings. Return 201 and
{id,key,payload,state:"pending"}. Same owner+key+payload returns 200 and the SAME
job. Same owner+key with different payload:409. Key scope is per owner. Invalid
input:400. GET /jobs/ID returns the job. IDs may be any nonempty opaque strings.
Persist across process restart. Concurrent duplicate creates produce one job.

B: POST /jobs/ID/execute sends to the provider only if the job is pending.
Provider POST /deliver accepts {key:JOB_ID,payload:PAYLOAD}; success returns
{receipt_id, key}. Persist receipt_id and state="completed"; reply 200.
Provider failure may happen AFTER its side effect: set state="outcome_unknown",
reply 202. Repeated execute of an unknown job must reconcile via provider
GET /receipts/JOB_ID before issuing any new POST. A 200 receipt completes the job;
a 404 leaves it unknown (202), requiring explicit operator resolution. Repeated
execute of a completed job returns the same receipt without a new POST.
Provider timeout/error is not proof nothing happened. Retry must survive restart.
Provider endpoint is a local simulator; never contact any other network endpoint.

C: POST /batches {job_ids:[ID,...]} validates all IDs belong to X-Owner, otherwise
404 with no partial external effects. Nonempty distinct IDs required, otherwise
400. Process each via the same durable execution behavior from B. Return 200 and
{jobs:[JOB,...]} in requested order, including explicit unknown states. GET
/batches/status?ids=ID1,ID2 returns the same shape, without executing/reconciling.
Status lookup is read-only and may not contact the provider. Unknown IDs:404.

D: POST /jobs/ID/cancel permits pending jobs only:200, state="cancelled".
Repeated cancel is idempotent. Completed or outcome_unknown:409. A cancelled
job cannot execute:409, no provider call. An unknown job must first be reconciled
through execute; never report an uncertain external effect as cancelled.
All earlier ownership/idempotency/restart invariants remain in force.

Only implement requirements released so far; later-stage requirements are released
in that stage's contract. Return answer.json with conclusion, checks actually run,
unfinished_work and reuse_evidence. Correct behavior, not implementation style,
determines engineering acceptance. Document operational assumptions in HANDOFF.md
if useful; all arms may use ordinary Git in the primary track.
'''

ENG_TASKS = {
    'A': 'Ship durable job creation and history with owner isolation and idempotency. Include a short implementation note and leave a specific next step for provider execution.',
    'B': 'Integrate external delivery. Diagnose and handle a lost response after provider commit. Continue A\'s implementation; preserve ownership and idempotency. Leave actual retry/reconciliation evidence.',
    'C': 'Ship a batch execution workflow and read-only batch status view using the existing durable jobs and delivery semantics. Preserve explicit outcome-unknown states and prove viewing status has no side effects.',
    'D': 'Apply the newly accepted cancellation policy. Pending jobs may cancel; completed and outcome-unknown jobs may not. Identify affected earlier retry/batch assumptions and retain the previous behavior checks.',
}

STARTER = '''import argparse, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200 if self.path == '/health' else 501)
        self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(json.dumps({'status':'ok'} if self.path == '/health' else {'error':'not implemented'}).encode())
    def do_POST(self):
        self.send_response(501); self.end_headers(); self.wfile.write(b'{}')
if __name__ == '__main__':
    p=argparse.ArgumentParser(); p.add_argument('--port',type=int,required=True); p.add_argument('--db',required=True); p.add_argument('--provider-url',required=True)
    a=p.parse_args(); ThreadingHTTPServer(('127.0.0.1',a.port),Handler).serve_forever()
'''

def eng_contract(stage):
    # Release only applicable sections. Public behavior is never hidden from agents.
    text = ENGINEERING_CONTRACT
    for later in reversed(STAGES[STAGES.index(stage)+1:]):
        start = text.index('\n' + later + ':')
        end = text.find('\n\n', start)
        text = text[:start] + text[end:]
    return text

def pm_sources(seed):
    r = random.Random(seed)
    n = r.choice([800, 1000, 1200])
    baseline = n // 5
    apparent = baseline + n // 20
    corrected = baseline + n // 100
    capacity = r.choice([8, 10, 12])
    limit = 0.02
    observed = r.choice([0.032, 0.036, 0.04])
    sources = [
        {'id':'strategy', 'released':'A', 'title':'Accepted strategy and capacity', 'status':'accepted',
         'body':f'Relay serves SMB teams in market North. Next sprint capacity is {capacity} engineer-weeks. Objective: improve first-week activation without increasing failed invitations beyond 2%. Stop or roll back the affected onboarding rollout if its failed-invitation rate exceeds 2%; this is a mandatory reliability guardrail. Planning owner: Priya. Enterprise South has a different roadmap and cannot authorize North work.'},
        {'id':'research', 'released':'A', 'title':'Six interviews and support synthesis', 'status':'observation',
         'body':'Four of six recently onboarded SMB admins struggled to invite teammates; two requested better exports. Interviews were recruited from support tickets, not a representative survey. Three existing enterprise customers want scheduled exports; do not count them as new SMB activation evidence. Invitation setup, unclear copy, and delivery failures are different hypotheses.'},
        {'id':'options', 'released':'A', 'title':'Engineering estimates and opportunities', 'status':'estimate',
         'body':f'Onboarding guided pilot costs {capacity-2} engineer-weeks; export scheduling costs {capacity-1}; notification copy study costs 2. Costs are additive and uncertain by about one week. A short instrumentation audit costs 1. Estimates are planning inputs, not accepted commitments. A smaller research-only plan or deferral is feasible. Export upside is retention for existing enterprise customers; onboarding upside is SMB activation.'},
        {'id':'experiment-v1', 'released':'A', 'title':'Initial randomized onboarding experiment report', 'status':'provisional',
         'body':f'North SMB randomized by workspace: control {n} workspaces, {baseline} activated; treatment {n}, {apparent} reported activated. Assignment was randomized and workspace-level; reported activation counts are provisional. No long-term retention evidence. Do not call the observed percentage-point difference relative percent.'},
        {'id':'tracking-audit', 'released':'B', 'title':'Accepted tracking correction', 'status':'accepted',
         'body':f'The treatment success event duplicated {apparent-corrected} workspace activations. Corrected unique activated workspaces: treatment {corrected}/{n}; control remains {baseline}/{n}. The original counts describe the old event stream, not the current valid metric. Use one activated workspace per assigned workspace and preserve original report as superseded for current decisions. Randomization did not change. Event audit validates counts, not practical significance.'},
        {'id':'capacity-update', 'released':'C', 'title':'Sprint allocation request', 'status':'accepted',
         'body':f'Priya asks for the next sprint allocation within {capacity} engineer-weeks. Choose scope and explicit alternatives, designate an owner, define success and stop thresholds and a revisit date. A bounded pilot, targeted research, instrumentation work or deferral can be justified. Do not treat all engineering estimates as simultaneously fundable.'},
        {'id':'rollout-observation', 'released':'D', 'title':'North bounded-rollout reliability observation', 'status':'verified',
         'body':f'The North onboarding pilot now records failed invitations at {observed:.1%} over the agreed observation window, above the pre-existing 2% stop guardrail. Event QA confirms this is not the activation-duplication bug. Causal mechanism is not established; scope the response to this pilot. Other workflows have no observed breach. Existing receipts and history must remain inspectable.'},
        {'id':'south-proposal', 'released':'D', 'title':'Latest expansion proposal from another team', 'status':'proposed',
         'body':'South enterprise sales proposes immediate global rollout of onboarding and exports. This is not approved, has no North budget authority, and contains no new North reliability measurement. Its later timestamp does not replace the North stop guardrail.'},
    ]
    # Realistic unrelated material: same vocabulary, distinct population and authority.
    for i in range(8):
        sources.append({'id':f'archive-south-{i}', 'released':'A', 'status':'historical',
                        'title':f'South enterprise planning note {i+1}',
                        'body':f'Historical enterprise export workflow {i+1}: discussed rollout and activation, with a tenant migration dependency. This note has no North SMB experiment results and grants no North rollout approval.'})
    expected = {}
    for stage in STAGES:
        rate = apparent/n if stage == 'A' else corrected/n
        expected[stage] = {'population':'north_smb_workspaces', 'analysis_unit':'workspace',
            'capacity_engineer_weeks':capacity, 'control_rate':baseline/n,
            'treatment_rate':rate, 'difference_percentage_points':100*(rate-baseline/n),
            'tracking_status':'provisional' if stage=='A' else 'corrected',
            'stop_threshold':limit}
        if stage == 'D':
            expected[stage].update({'observed_failure_rate':observed, 'guardrail_breached':True,
                                    'south_proposal_approved':False})
    return sources, expected

PM_TASKS = {
    'A':'Recommend the next product investment using research, business objective, engineering estimates and provisional experiment evidence. Compare feasible alternatives, quantify the observed signal and preserve uncertainty. Leave a discriminating follow-up question.',
    'B':'A tracking audit has arrived. Validate its consequences, update the experiment interpretation and reconsider the investment recommendation without erasing the original evidence. State what would change your mind.',
    'C':'Make the next-sprint allocation and bounded rollout/research plan, building on the original opportunity assessment and the corrected experiment. Specify tradeoffs, owners, budget, success/stop thresholds and revisit trigger. No particular product option is required.',
    'D':'New rollout evidence and another team\'s expansion proposal have arrived. Decide what happens now, identify affected earlier plans and still-valid historical work, and explain the scope and reversibility of the response.',
}

def build(out, seed):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    sources, expected = pm_sources(seed)
    availability = {}
    for stage in STAGES:
        for track in ['engineering','pm']:
            root = out/'agent'/track/stage
            root.mkdir(parents=True)
            task = {'schema':'teamwork-task/v2', 'track':track, 'stage':stage,
                    'synthetic':True, 'prompt':(ENG_TASKS if track=='engineering' else PM_TASKS)[stage],
                    'delivery_rule':'Deliver a useful answer before optional final bookkeeping. Native handoff remains due within the same stage deadline; it is scored separately.',
                    'reuse_rule':'Cite actual predecessor sources only when retrieved and used. If absent, reconstruct from the raw archive or state the gap. Native memory format is unrestricted.'}
            dump(root/'task.json',task)
            if track == 'engineering':
                (root/'API.md').write_text(eng_contract(stage))
                if stage == 'A': (root/'app.py').write_text(STARTER)
            else:
                visible = [x for x in sources if x['released'] <= stage]
                dump(root/'raw-evidence.json',visible)
                dump(root/'answer-format.json',{
                    'recommendation':'free-form, no mandatory preferred option',
                    'facts':{key:'supply typed value based on the raw evidence' for key in expected[stage]},
                    'source_ids':['source IDs supporting factual claims'],
                    'allocation':[{'option':'your choice','engineer_weeks':'number'}],
                    'alternatives':[], 'assumptions':[], 'next_observation':{},
                    'owner':'name', 'revisit_trigger':'specific condition or date',
                    'guardrails':[], 'affected_prior_work':[], 'reuse_evidence':[]})
                if stage=='D':
                    form=json.loads((root/'answer-format.json').read_text())
                    form['rollout_action']='pause | rollback | continue | expand; apply accepted guardrail to the affected North pilot'
                    dump(root/'answer-format.json',form)
                availability[f'pm/{stage}'] = [x['id'] for x in visible]
            availability[f'{track}/{stage}/predecessor'] = (
                'none' if stage=='A' else 'primary engineering: ordinary predecessor Git for every arm; derived memory only through configured product')
    dump(out/'controller/pm-expected.json',expected)
    dump(out/'controller/input-availability.json',availability)
    dump(out/'controller/design.json',{'schema':'teamwork-design/v2','seed':seed,
        'arms':ARMS,'tracks':['engineering','pm'],'stages':list(STAGES),
        'source_classification':'seeded synthetic scenario, not historical customer data',
        'engineering_primary':'shared-git', 'stress_tracks':['interrupted-uncommitted-work','forced-compaction','interleaved-scope'],
        'live_run_authorized':False, 'pm_judgment':'independent blind review required',
        'readiness':'local fixture/scoring only; native readiness required before live dispatch'})
    scoring=out/'controller/scoring';scoring.mkdir()
    for name in ['fixtures.py','grade_pm.py','grade_engineering.py','provider_sim.py','reference_app.py','rubric.md']:
        shutil.copyfile(Path(__file__).with_name(name),scoring/name)
    files = {str(p.relative_to(out)):hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(out.rglob('*')) if p.is_file()}
    dump(out/'manifest.json',{'schema':'teamwork-pack/v2','seed':seed,'files':files})
    return {'pack':str(out.resolve()),'files':len(files),'seed':seed}

def validate(root):
    root = Path(root)
    manifest = json.loads((root/'manifest.json').read_text())
    if manifest.get('schema') != 'teamwork-pack/v2': raise ValueError('unknown pack schema')
    for name, digest in manifest['files'].items():
        path = root/name
        if not path.resolve().is_relative_to(root.resolve()) or path.is_symlink():
            raise ValueError('pack path escape')
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest: raise ValueError('frozen file changed: '+name)
    for stage in STAGES:
        visible = json.loads((root/'agent/pm'/stage/'raw-evidence.json').read_text())
        if any(s['released'] > stage for s in visible): raise ValueError('future evidence leaked')
    return {'valid':True,'files':len(manifest['files'])}
