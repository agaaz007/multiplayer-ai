"""Neutral PM review packets from actual delivered/recovered artifacts; no models."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import re
import secrets

HERE = Path(__file__).resolve().parent
def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value
grading = module('v3_review_input_grading', HERE / 'grade-run.py')
FACTS = ['numeric_result', 'scope_and_denominator', 'decision_authority', 'predecessor_attribution', 'operation_state']
VENDOR = re.compile(r'(?i)ledger|supermemory|mem0|gbrain|graphify|mcp__\w+')
VENDOR_TOKEN = re.compile(r'(?i)\b[A-Za-z0-9_.:/-]*(?:ledger|supermemory|mem0|gbrain|graphify|mcp__)[A-Za-z0-9_.:/-]*\b')
OPAQUE = re.compile(r'\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b|\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{18,}\b|\b(?:rec|record|wrk|thread|fnd|dec|chg|def)[-_][A-Za-z0-9_-]{8,}\b')
ABSOLUTE = re.compile(r'/(?:Users|private|var|tmp)/[^\s"\'<>]+')
REF_KEYS = {'key', 'receipt_id', 'record_id', 'thread_id', 'predecessor_source', 'native_id', 'source_id'}
POSSIBLE_REF_KEYS = {'source', 'predecessor', 'prior_source', 'record', 'thread', 'sources', 'source_ids', 'predecessor_ids'}


def read(path): return json.loads(Path(path).read_text())
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as stream: json.dump(value, stream, indent=2, ensure_ascii=False); stream.write('\n')


def blind(answer, sources, public_paths=(), public_ids=()):
    """One private exact map across answer and all source bodies; preserve claims."""
    mapping = {name: f'artifact-{i + 1:03}' for i, name in enumerate(sorted(set(public_paths), key=lambda x: (-len(x), x)))}
    known = set(public_ids)
    def remember(value):
        if value and value not in known and value not in mapping:
            mapping[value] = 'reference-' + str(1 + sum(v.startswith('reference-') for v in mapping.values())).zfill(3)
    def collect(value, key=''):
        if isinstance(value, dict):
            for k, v in value.items(): collect(v, k)
        elif isinstance(value, list):
            for v in value: collect(v, key)
        elif isinstance(value, str):
            if key in REF_KEYS: remember(value)
            if key in POSSIBLE_REF_KEYS and re.fullmatch(r'[A-Za-z0-9_./:-]+', value): remember(value)
            for token in VENDOR_TOKEN.findall(value):
                if any(c in token for c in '-_/:') or any(c.isdigit() for c in token): remember(token)
            for token in [*OPAQUE.findall(value), *ABSOLUTE.findall(value)]: remember(token.rstrip('.,;:)'))
            # JSON artifact bodies retain keys/values inside a string. Parse when possible.
            if value.lstrip().startswith(('{', '[')):
                try: collect(json.loads(value))
                except ValueError: pass
    collect(answer); collect(sources)
    changes = []
    def transform(value, location=''):
        if isinstance(value, dict): return {k: transform(v, location + '/' + k) for k, v in value.items()}
        if isinstance(value, list): return [transform(v, location + '/' + str(i)) for i, v in enumerate(value)]
        if not isinstance(value, str): return value
        original = value
        for old, new in sorted(mapping.items(), key=lambda kv: -len(kv[0])):
            value = re.sub(r'(?<![A-Za-z0-9_-])' + re.escape(old) + r'(?![A-Za-z0-9_-])', lambda _: new, value)
        value = VENDOR.sub('native-product', value)
        if value != original: changes.append({'location': location, 'before': original, 'after': value})
        return value
    payload = transform({'answer': answer, 'sources': sources})
    if VENDOR.search(json.dumps(payload)) or ABSOLUTE.search(json.dumps(payload)):
        raise ValueError('residual native identity/path requires controller inspection')
    return payload['answer'], payload['sources'], {'exact_map': mapping, 'changes': changes}


def content(path):
    if path.is_symlink() or path.stat().st_size > 1024 * 1024:
        raise ValueError('unsafe or oversized reviewer artifact: ' + str(path))
    return path.read_text(encoding='utf-8')


def eligibility(root, stage):
    """Declared before dispatch: a timely, valid immutable answer is required."""
    ctl = root / 'stages' / stage['id'] / 'controller'
    present = {name: sha(ctl / name) for name in ('delivery.json', 'submission/answer.json')
               if (ctl / name).is_file() and not (ctl / name).is_symlink()}
    try:
        if not grading.sequence.verify_submission(ctl, stage['deadline_ms']):
            return {'status': 'not_evaluated', 'reason': 'missing, invalid, or late immutable submission'}, present
        grading.recovery.verify_receipt(ctl / 'submission/tree', ctl / 'delivery.json', 'teamwork-delivery/v3')
        if not isinstance(read(ctl / 'submission/answer.json'), dict):
            raise ValueError('delivered answer must be a JSON object')
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {'status': 'not_evaluated', 'reason': 'missing, invalid, or late immutable submission'}, present
    return {'status': 'eligible', 'reason': 'timely immutable answer and submission tree verified'}, present


def packet_for(root, state, pack, manifest, stage, provider_events=None):
    name = stage['id']; ctl = root / 'stages' / name / 'controller'
    if not grading.sequence.verify_submission(ctl, stage['deadline_ms']):
        raise ValueError('missing/late immutable delivered PM answer: ' + name)
    delivery = grading.recovery.verify_receipt(ctl / 'submission/tree', ctl / 'delivery.json')
    final = ctl / 'submission/tree'; missing = []
    report_path = 'reports/' + name + '.md'; state_path = 'continuity/state.json'
    answer = {'delivered_answer': read(ctl / 'submission/answer.json'),
              'report': content(final / report_path) if (final / report_path).is_file() else None,
              'work_state': content(final / state_path) if (final / state_path).is_file() else None,
              'missing_deliverables': [p for p in (report_path, state_path) if not (final / p).is_file()]}
    recovered = ctl / 'recovery/tree'; recovered_files = {}
    if name != 'A' and (ctl / 'recovery.json').is_file():
        rr = grading.recovery.verify_receipt(recovered, ctl / 'recovery.json', 'teamwork-recovery/v3')
        if sha(ctl / 'recovery/evidence.json') != rr.get('evidence_file_sha256'):
            raise ValueError('recovery evidence hash mismatch')
        recovered_files = rr['tree']['files']
    elif name != 'A': missing.append('No recovery checkpoint was captured; do not invent recovered predecessor material.')
    entries = []; paths = {report_path, state_path}; bindings = []; public_ids = set()
    def source(title, body, role, availability, original=None, **fields):
        sid = f'source-{len(entries) + 1:03}'
        entries.append({'id': sid, 'title': title, 'body': body, 'role': role,
                        'availability': availability, **fields})
        if original is not None: bindings.append({'source_id': sid, 'original_path': str(original), 'sha256': sha(original), 'role': role})
        return sid
    source('Current stage task', content(pack / stage['prompt_file']), 'public_task', 'current_stage_input', pack / stage['prompt_file'])
    workflow = pack / manifest['initial_repo_dir'] / 'WORKFLOW.md'
    source('Public workflow and authority rules', content(workflow), 'public_task', 'current_stage_input', workflow)
    stages = [s['id'] for s in manifest['stages']]; upto = stages[:stages.index(name) + 1]
    canonical_paths = []
    for spec in manifest['stages']:
        if spec['id'] not in upto: continue
        source_file = pack / spec['delta_dir'] / 'sources' / (spec['id'] + '.json')
        canonical_paths.append(('sources/' + spec['id'] + '.json', source_file))
        path_name = 'sources/' + spec['id'] + '.json'; paths.add(path_name)
        records = read(source_file)
        public_ids.update(r.get('id') for r in records if isinstance(r.get('id'), str))
        availability = 'current_stage_input' if spec['id'] == name else 'recovered_exact' if recovered_files.get(path_name) == sha(source_file) else 'recovered_modified' if path_name in recovered_files else 'absent_from_recovery_checkpoint'
        for record in records:
            source(record.get('title', 'Released source'), record.get('body', json.dumps(record)), 'canonical_released_evidence', availability,
                   source_file, released=record.get('released'), authority_label=record.get('status'), original_public_id=record.get('id'))
        if availability == 'absent_from_recovery_checkpoint': missing.append(path_name + ' absent at the recovery checkpoint; later native access is not ruled out.')
    for where, files, role in [(recovered, recovered_files, 'recovery_checkpoint_artifact'), (final, delivery['tree']['files'], 'delivered_artifact')]:
        for relative in sorted(files):
            if relative in (report_path, state_path) and role == 'delivered_artifact': continue
            if not relative.startswith(('reports/', 'continuity/', 'sources/', 'analysis/')): continue
            if any(part.startswith('.') for part in Path(relative).parts): continue
            file = grading.recovery.relative(where, relative); paths.add(relative)
            try: body = content(file)
            except UnicodeDecodeError:
                missing.append(relative + ' is binary; literal text review not available.'); continue
            source('Actual task artifact ' + relative, body, role,
                   'present_at_recovery_checkpoint' if role == 'recovery_checkpoint_artifact' else 'present_at_delivery', file)
    if provider_events and Path(provider_events).is_file():
        events = [json.loads(line) for line in Path(provider_events).read_text().splitlines() if line.strip()]
        # B's supplier call is explicitly after answer delivery; do not grade it with future knowledge.
        visible = [e for e in events if e.get('stage') in upto and not (name == 'B' and e.get('stage') == 'B')]
        source('Controller supplier observations through the relevant delivery boundary', json.dumps(visible, indent=2),
               'independent_supplier_oracle', 'reviewer_ground_truth; not automatically available to the agent', Path(provider_events))
    source('Recovery availability inventory', json.dumps({'stage': name, 'checkpoint_present': bool(recovered_files),
           'recovered_task_files': sorted(p for p in recovered_files if p.startswith(('reports/', 'continuity/', 'sources/', 'analysis/'))),
           'missing_or_unverified': missing,
           'interpretation': 'Canonical sources are ground truth. Recovered artifacts establish checkpoint content. Delivered files may reflect later native reads or reconstruction; separate traces establish actual retrieval/use.'}, indent=2),
           'controller_inventory', 'reviewer_ground_truth; inventory only, no inferred decisions')
    paths.update(p for p in recovered_files if p.startswith(('reports/', 'continuity/', 'sources/', 'analysis/')))
    blinded_answer, blinded_sources, mapping = blind(answer, entries, paths, public_ids)
    provenance = {'delivery_sha256': sha(ctl / 'delivery.json'), 'answer_sha256': sha(ctl / 'submission/answer.json'),
                  'submission_tree_sha256': delivery['tree']['sha256'],
                  'recovery_receipt_sha256': sha(ctl / 'recovery.json') if (ctl / 'recovery.json').is_file() else None,
                  'source_bindings': bindings, 'blinding': mapping, 'missing_material': missing}
    return blinded_answer, blinded_sources, provenance


def prepare(entries, out, runtime, model='gpt-5.6-sol', reasoning_effort='medium', ca_file=None, cohort_scope=None):
    arms = grading.expected_arms({'cohort_scope': cohort_scope} if cohort_scope is not None else {})
    expected_cases = len(arms) * 4
    plan = grading.preflight(entries, cohort_scope=cohort_scope)
    plan = [r for r in plan if r[2]['track'] == 'pm']
    if len(plan) != len(arms) or {r[2]['arm'] for r in plan} != set(arms):
        raise ValueError('the complete ' + grading.cohort_label(arms) + ' PM cohort is required')
    if any([s['id'] for s in row[4]['stages']] != list('ABCD') for row in plan):
        raise ValueError('all four A-D stages required for each declared PM product')
    out = Path(out).resolve()
    if out.exists(): raise ValueError('review preparation output must be new')
    staged = []
    for entry, root, state, pack, manifest in plan:
        for stage in manifest['stages']:
            eligible, observed = eligibility(root, stage)
            answer, sources = None, None
            provenance = {'observed_submission_hashes': observed}
            if eligible['status'] == 'eligible':
                answer, sources, provenance = packet_for(root, state, pack, manifest, stage, entry.get('provider_events'))
            staged.append((root, state, stage, eligible, answer, sources, provenance))
    if len(staged) != expected_cases: raise ValueError('expected all ' + str(expected_cases) + ' PM cases before preparation')
    out.mkdir(parents=True, mode=0o700); cases = []; mapping = []
    for root, state, stage, eligible, answer, sources, provenance in staged:
        cid = 'case-' + secrets.token_hex(6); packet = out / 'packets' / cid
        case = {'id': cid, 'stage': stage['id'], 'eligibility': eligible}
        hashes = {}
        if eligible['status'] == 'eligible':
            save(packet / 'answer.json', answer); save(packet / 'sources.json', sources); save(packet / 'fact-keys.json', FACTS)
            case['packet'] = str(packet)
            hashes = {name: sha(packet / name) for name in ('answer.json', 'sources.json', 'fact-keys.json')}
        cases.append(case)
        mapping.append({'case_id': cid, 'arm': state['arm'], 'stage': stage['id'], 'sequence_root': str(root),
                        'eligibility': eligible, **provenance, 'packet_hashes': hashes})
    random.SystemRandom().shuffle(cases)
    runtime = Path(runtime).resolve(); rubric = HERE / 'review-rubric.md'
    config = {'schema': 'pm-continuation-review-run/v3', 'execution_authorized': False, 'cohort_scope': cohort_scope,
              'authorization': 'Await controller inspection and launch declaration; preparation starts no model sessions.',
              'runtime': str(runtime), 'runtime_sha256': sha(runtime / 'eval/sequence-codex.js'),
              'rubric': str(rubric), 'rubric_sha256': sha(rubric), 'model': model,
              'reasoning_effort': reasoning_effort, 'timeout_ms': 300000, 'max_concurrency': 6, 'cases': cases}
    if ca_file: config['ca_file'] = str(Path(ca_file).resolve())
    save(out / 'review-config.json', config); save(out / 'controller-map.json', {'cases': mapping})
    save(out / 'preparation.json', {'schema': 'pm-continuation-review-preparation/v3', 'cases': expected_cases, 'model_calls': 0, 'cohort_scope': cohort_scope,
         'inspection': 'required before launch; identity scanning is not proof of complete blinding',
         'source_hashes': {str(HERE / f): sha(HERE / f) for f in ['review-prepare.py', 'review-runner.mjs', 'review-validator.mjs', 'review-rubric.md']},
         'factual_categories': FACTS, 'overall_leaderboard': 'not_emitted',
         'eligibility_policy': 'A valid timely immutable answer and submission tree are required; every expected case remains represented. Missing/invalid/late submissions are not_evaluated, never zero. No reruns or replacement cases.',
         'evidence_policy': 'Canonical source truth and actual recovered/delivered artifacts remain separately labeled; no guessed predecessor answers.'})
    return {'cases': expected_cases, 'eligible_cases': sum(c['eligibility']['status'] == 'eligible' for c in cases),
            'not_evaluated_cases': sum(c['eligibility']['status'] == 'not_evaluated' for c in cases),
            'model_calls': 0, 'config': str(out / 'review-config.json'), 'execution_authorized': False}


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--config', required=True); p.add_argument('--out', required=True)
    p.add_argument('--runtime', required=True); p.add_argument('--model', default='gpt-5.6-sol')
    p.add_argument('--reasoning-effort', default='medium'); p.add_argument('--ca-file')
    a = p.parse_args(); cfg = read(a.config)
    print(json.dumps(prepare(cfg['sequences'], a.out, a.runtime, a.model, a.reasoning_effort, a.ca_file, cohort_scope=cfg.get('cohort_scope'))))
