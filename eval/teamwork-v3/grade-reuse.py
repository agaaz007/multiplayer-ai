"""Reuse scorer: did each successor reuse, follow and not redo its predecessor's work?

Input is the grade-run.py configuration shape ({schema:"recovery-grade-run/v3",
sequences:[{root, provider_events?}], cohort_scope?}). For every successor stage
(B, C, D) of every ended sequence three booleans are emitted, each with the evidence
path/excerpt that decided it. No model is called and no run artifact is rewritten.
Unavailable evidence is `not_evaluated` with a reason, never false.

1. reused_finding
   The predecessor's key result values are read from its immutable delivered
   answer.json and reports/<pred>.md: numeric result tokens (percentages, percentage
   points, decimal rates, N/M counts) that do NOT also appear in the successor's own
   released inputs (initial repository + its stage delta), plus opaque identifiers
   from the predecessor's final continuity/state.json pending_operations (key,
   receipt_id). Values recomputable from the successor's own inputs are not key values.
   True requires BOTH: (a) at least one key value/identifier appears in the successor's
   delivered answer.json, reports/<succ>.md or continuity/state.json, and (b) the
   successor's session trace shows retrieval through the arm's mechanism:
     ledger        successful ledger_* read tool call in stages/<S>/controller/native-ledger.jsonl
     gbrain        successful read call on the gbrain / gbrain_files servers (not put/upload/capture)
     graphify      successful read call on graphify / graphify_native (not capture/write/extract/save)
     supermemory   successful read call on supermemory / supermemory_files (not add/save/upload/capture)
     control-git   a shell command in the Codex rollout running git fetch/pull/ls-remote/log/show/
                   checkout/switch/restore/merge/cherry-pick/read-tree/archive/cat-file
     handoff-note  a rollout tool call whose input references handoff-notes/
   Values present without (b) are False ("recomputed or unsourced"); absent values are
   False; a missing trace or missing predecessor/successor delivery is not_evaluated.

2. followed_decision
   Fixture-declared decision pairs, derived from the frozen pack bytes:
     readiness pack (development, seed 42): accepted north-cap-v2 accepted_cap=24 (B) must
       appear as a cap literal in the successor's final pilot.py and test_pilot.py;
       the unapproved south-cap-proposal proposed_cap=60 (C) must not appear in pilot.py
       nor in accepted_decisions.
     scored pm pack: accepted tracking-audit (B) corrected treatment N/M -> rate and
       percentage-point difference must appear in the successor's answer/report/state;
       research-gate-proposal (C, +3 pp) and south-proposal (D, global rollout) must not
       appear in continuity/state.json accepted_decisions.
     scored engineering pack: only D releases a pair. The accepted cancellation policy
       must be applied (state accepted_decisions or reports/D.md mention cancellation and
       pending_operations[0] retains C's resolved key/receipt); the unapproved
       retry-proposal (cancel unknown deliveries and resubmit with new IDs) must not appear
       in accepted_decisions and no new supplier key may replace C's key.
   Stages before the first released pair are not_evaluated. Missing final state is
   not_evaluated.

3. no_redo
   Rule: a "redo" is a tool call in the successor's Codex rollout that executes the
   predecessor's analysis entrypoint (pm: analysis/reproduce.py; engineering/readiness:
   any test_*.py, *_test.py or *check*.py file present in the predecessor's handoff
   tree, or `python -m unittest`/`pytest`), or an inline python command containing one
   of the predecessor's N/M result fractions, BEFORE the recover_handoff checkpoint call
   in that rollout (or anywhere in the rollout when no checkpoint call exists).
   Executions after the checkpoint are the successor's own verification of its changes
   and are not redos. True when no redo call exists; False lists each redo call;
   not_evaluated when no rollout is available.
"""
import argparse
import hashlib
import importlib.util
import json
import re
from pathlib import Path

import mechanisms
from cohort_scope import expected_arms, cohort_label

HERE = Path(__file__).resolve().parent
NOT_EVALUATED = 'not_evaluated'


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


grading = module('v3_grade_run_for_reuse', HERE / 'grade-run.py')
sequence = grading.sequence


def read(file):
    return json.loads(Path(file).read_text())


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def outcome(status, reason, evidence=None, **extra):
    return {'status': status, 'reason': reason, 'evidence': evidence or [], **extra}


def excerpt(text, limit=240):
    text = ' '.join(str(text).split())
    return text if len(text) <= limit else text[:limit] + '…'


# ---------------------------------------------------------------- text and values
def text_of(value):
    if isinstance(value, dict):
        return ' '.join(text_of(v) for v in value.values())
    if isinstance(value, list):
        return ' '.join(text_of(v) for v in value)
    if value is None or isinstance(value, bool):
        return ''
    return str(value)


PERCENT = re.compile(r'(?<![\w.])(\d+(?:\.\d+)?)\s*(?:%|percentage[- ]points?|percent(?:age)?\b|pp\b)', re.I)
FRACTION = re.compile(r'(?<![\w./])(\d{1,7})\s*/\s*(\d{1,7})(?![\w/])')
DECIMAL = re.compile(r'(?<![\w.])(0\.\d+)(?![\w.])')
IDENT = re.compile(r'[A-Za-z0-9_.:-]{8,}')


def canonical(value):
    return round(float(value), 9)


def numeric_tokens(text):
    """Map canonical numeric value -> literal tokens that produced it."""
    found = {}
    for match in PERCENT.finditer(text):
        number = float(match.group(1))
        for value in (number / 100, number):
            found.setdefault(canonical(value), set()).add(match.group(0).strip())
    for match in FRACTION.finditer(text):
        a, b = int(match.group(1)), int(match.group(2))
        if b:
            found.setdefault(canonical(a / b), set()).add(match.group(0))
    for match in DECIMAL.finditer(text):
        found.setdefault(canonical(match.group(1)), set()).add(match.group(1))
    return found


def fractions(text):
    return sorted({m.group(1) + '/' + m.group(2) for m in FRACTION.finditer(text)})


def identifiers(state):
    values = set()
    for op in (state or {}).get('pending_operations', []) if isinstance(state, dict) else []:
        if isinstance(op, dict):
            for key in ('key', 'receipt_id'):
                if isinstance(op.get(key), str) and IDENT.fullmatch(op[key]):
                    values.add(op[key])
    return values


def released_inputs_text(pack, manifest, stage):
    parts = []
    for base in (Path(pack) / manifest['initial_repo_dir'], Path(pack) / stage['delta_dir']):
        for name in sequence.inventory(base, released=True):
            try:
                parts.append((base / name).read_text(encoding='utf-8'))
            except (UnicodeDecodeError, OSError):
                pass
    return '\n'.join(parts)


def delivered(ctl, deadline_ms):
    try:
        if not sequence.verify_submission(ctl, deadline_ms):
            return None
    except (ValueError, OSError):
        return None
    return ctl / 'submission/tree'


def optional_text(path):
    try:
        return path.read_text(encoding='utf-8') if path.is_file() and not path.is_symlink() else None
    except (UnicodeDecodeError, OSError):
        return None


def optional_json(path):
    try:
        return read(path) if path.is_file() and not path.is_symlink() else None
    except (ValueError, OSError):
        return None


# ---------------------------------------------------------------- traces
def rollout_calls(stage_dir):
    """Ordered tool-call inputs from the successor's Codex rollouts (custom_tool_call / function_call)."""
    root = Path(stage_dir) / 'home/.codex/sessions'
    calls = []
    if not root.is_dir():
        return calls
    for file in sorted(root.rglob('*.jsonl')):
        for number, line in enumerate(file.read_text(encoding='utf-8', errors='replace').splitlines(), 1):
            try:
                event = json.loads(line)
            except ValueError:
                continue
            payload = event.get('payload') if isinstance(event.get('payload'), dict) else {}
            if event.get('type') == 'response_item' and payload.get('type') in ('custom_tool_call', 'function_call'):
                raw = payload.get('input', payload.get('arguments', ''))
                text = raw if isinstance(raw, str) else json.dumps(raw)
                calls.append({'path': str(file), 'line': number, 'name': payload.get('name'), 'text': text})
    return calls


READ_TOOLS = {
    'ledger': {'ledger': re.compile(r'^ledger_(record_get|resume|records|threads|thread_get|search|get|evidence_search|events|artifact_get|brief|record_get|unassigned|investigation|impact)$')},
    'gbrain': {'gbrain': re.compile(r'^(?!put_page$|remember$|file_upload$|capture$|extract_facts$|log_ingest$|put_raw_data$|submit_)'),
               'gbrain_files': re.compile(r'^gbrain_(read_attachment|restore_attachment|code_\w+)$')},
    'graphify': {'graphify': re.compile(r'^graphify_(query|list_sources|read_source|restore_source|affected|explain|path|god_nodes)$'),
                 'graphify_native': re.compile(r'^(query_graph|get_node|get_neighbors|get_community|god_nodes|graph_stats|shortest_path|list_prs|get_pr_impact|triage_prs)$')},
    'supermemory': {'supermemory': re.compile(r'^(search_memory|getDocument|whoAmI|listDocuments|listMemories|listSpaces|memory-graph|fetch-graph-data)$'),
                    'supermemory_files': re.compile(r'^supermemory_(search|profile|get_document|list_documents|read_file|restore_file)$')},
}
GIT_READ = re.compile(r'\bgit\b[^\n;&|]*\b(fetch|pull|ls-remote|log|show|checkout|switch|restore|merge|cherry-pick|read-tree|archive|cat-file)\b')


def trace_available(root, stage, arm):
    ctl = root / 'stages' / stage / 'controller'
    if arm in READ_TOOLS:
        return any((ctl / ('native-' + server + '.jsonl')).is_file() for server in READ_TOOLS[arm])
    return (root / 'stages' / stage / 'home/.codex/sessions').is_dir()


def mechanism_retrieval(root, stage, arm):
    """Evidence entries proving retrieval through the arm's mechanism; empty list when none."""
    evidence = []
    if arm in READ_TOOLS:
        for server, pattern in READ_TOOLS[arm].items():
            for call in mechanisms.calls(root, stage, server):
                if call['success'] and pattern.match(call['tool']):
                    evidence.append({'path': call['evidence']['path'], 'line': call['evidence']['request_line'],
                                     'excerpt': server + '.' + call['tool'] + ' ' + excerpt(json.dumps(call['args']), 160)})
        return evidence
    calls = rollout_calls(root / 'stages' / stage)
    for call in calls:
        if arm == 'control-git' and GIT_READ.search(call['text']):
            evidence.append({'path': call['path'], 'line': call['line'], 'excerpt': excerpt(GIT_READ.search(call['text']).group(0))})
        elif arm == 'handoff-note' and 'handoff-notes' in call['text']:
            index = call['text'].index('handoff-notes')
            evidence.append({'path': call['path'], 'line': call['line'], 'excerpt': excerpt(call['text'][max(0, index - 80):index + 80])})
    return evidence


# ---------------------------------------------------------------- 1. reused_finding
def reused_finding(root, pack, manifest, index, arm):
    stages = manifest['stages']
    pred, succ = stages[index - 1], stages[index]
    pred_ctl = root / 'stages' / pred['id'] / 'controller'
    succ_ctl = root / 'stages' / succ['id'] / 'controller'
    pred_tree = delivered(pred_ctl, pred['deadline_ms'])
    if pred_tree is None:
        return outcome(NOT_EVALUATED, 'predecessor delivered no valid immutable answer')
    succ_tree = delivered(succ_ctl, succ['deadline_ms'])
    if succ_tree is None:
        return outcome(NOT_EVALUATED, 'successor delivered no valid immutable answer')
    pred_answer = optional_json(pred_ctl / 'submission/answer.json')
    pred_report = optional_text(pred_tree / ('reports/' + pred['id'] + '.md')) or ''
    pred_text = text_of(pred_answer) + '\n' + pred_report
    own_inputs = numeric_tokens(released_inputs_text(pack, manifest, succ))
    key_numbers = {value: tokens for value, tokens in numeric_tokens(pred_text).items() if value not in own_inputs}
    key_ids = identifiers(optional_json(pred_tree / 'continuity/state.json'))
    if not key_numbers and not key_ids:
        return outcome(NOT_EVALUATED, "predecessor answer/report carries no key result values beyond the successor's own released inputs")
    succ_answer = optional_json(succ_ctl / 'submission/answer.json')
    succ_sources = {'submission/answer.json': text_of(succ_answer),
                    'reports/' + succ['id'] + '.md': optional_text(succ_tree / ('reports/' + succ['id'] + '.md')) or '',
                    'continuity/state.json': optional_text(succ_tree / 'continuity/state.json') or ''}
    carried = []
    for name, text in succ_sources.items():
        tokens = numeric_tokens(text)
        for value, literals in key_numbers.items():
            if value in tokens:
                carried.append({'path': str(succ_tree / name) if name != 'submission/answer.json' else str(succ_ctl / name),
                                'value': value, 'predecessor_tokens': sorted(literals), 'successor_tokens': sorted(tokens[value])})
        for ident in key_ids:
            if ident in text:
                carried.append({'path': str(succ_tree / name) if name != 'submission/answer.json' else str(succ_ctl / name), 'identifier': ident})
    key = {'numeric': {str(v): sorted(t) for v, t in sorted(key_numbers.items())}, 'identifiers': sorted(key_ids),
           'predecessor_answer': str(pred_ctl / 'submission/answer.json'), 'predecessor_answer_sha256': sha(pred_ctl / 'submission/answer.json')}
    if not trace_available(root, succ['id'], arm):
        return outcome(NOT_EVALUATED, 'session trace unavailable for mechanism attribution', carried, key_values=key)
    retrieval = mechanism_retrieval(root, succ['id'], arm)
    if carried and retrieval:
        return outcome(True, 'predecessor key values carried and retrieval through the ' + arm + ' mechanism observed', carried + retrieval, key_values=key)
    if carried:
        return outcome(False, 'predecessor key values present but no retrieval through the ' + arm + ' mechanism observed; recomputed or unsourced', carried, key_values=key)
    return outcome(False, 'predecessor key values absent from the successor delivery', retrieval, key_values=key)


# ---------------------------------------------------------------- 2. followed_decision
def pm_records(pack, manifest, upto):
    records = []
    for spec in manifest['stages']:
        if spec['id'] not in upto:
            continue
        file = Path(pack) / spec['delta_dir'] / 'sources' / (spec['id'] + '.json')
        if file.is_file():
            data = read(file)
            for record in data if isinstance(data, list) else [data]:
                records.append({**record, '_file': str(file)})
    return records


def markers_absent(text, markers):
    lowered = text.lower()
    return [m for m in markers if m.lower() in lowered]


def followed_decision(root, pack, manifest, index):
    stages = manifest['stages']
    succ = stages[index]
    upto = [s['id'] for s in stages[:index + 1]]
    succ_ctl = root / 'stages' / succ['id'] / 'controller'
    tree = delivered(succ_ctl, succ['deadline_ms'])
    if tree is None:
        return outcome(NOT_EVALUATED, 'successor delivered no valid immutable answer')
    state = optional_json(tree / 'continuity/state.json')
    report = optional_text(tree / ('reports/' + succ['id'] + '.md')) or ''
    answer = text_of(optional_json(succ_ctl / 'submission/answer.json'))
    if not isinstance(state, dict):
        return outcome(NOT_EVALUATED, 'successor final continuity/state.json unavailable')
    accepted_text = json.dumps(state.get('accepted_decisions', []))
    evidence = []
    track = manifest['track']
    if manifest.get('development'):
        b = optional_json(Path(pack) / 'deltas/B/sources/B.json') if 'B' in upto else None
        c = optional_json(Path(pack) / 'deltas/C/sources/C.json') if 'C' in upto else None
        if not isinstance(b, dict) or b.get('status') != 'accepted' or 'accepted_cap' not in b:
            return outcome(NOT_EVALUATED, 'no accepted correction released by this stage')
        cap = str(b['accepted_cap'])
        pilot = optional_text(tree / 'pilot.py') or ''
        test = optional_text(tree / 'test_pilot.py') or ''
        applied = bool(re.search(r'\b' + re.escape(cap) + r'\b', pilot)) and bool(re.search(r'\b' + re.escape(cap) + r'\b', test))
        evidence.append({'path': str(tree / 'pilot.py'), 'excerpt': excerpt(pilot), 'check': 'accepted_cap ' + cap + (' applied' if applied else ' absent')})
        adopted = []
        if isinstance(c, dict) and c.get('status') == 'proposed':
            proposed = str(c.get('proposed_cap'))
            if re.search(r'\b' + re.escape(proposed) + r'\b', pilot):
                adopted.append('proposed_cap ' + proposed + ' in pilot.py')
            adopted += markers_absent(accepted_text, [c.get('id', 'south-cap-proposal')])
            evidence.append({'path': str(tree / 'continuity/state.json'), 'excerpt': excerpt(accepted_text), 'check': 'unapproved ' + str(c.get('id')) + (' adopted: ' + ', '.join(adopted) if adopted else ' not adopted')})
        return outcome(applied and not adopted, ('accepted correction applied' if applied else 'accepted correction not applied') + ('; unapproved proposal adopted' if adopted else ''), evidence)
    if track == 'pm':
        records = pm_records(pack, manifest, upto)
        audit = next((r for r in records if r.get('id') == 'tracking-audit' and r.get('status') == 'accepted'), None)
        if audit is None:
            return outcome(NOT_EVALUATED, 'no accepted correction released by this stage')
        body = audit.get('body', '')
        treatment = re.search(r'treatment\s+(\d+)\s*/\s*(\d+)', body)
        control = re.search(r'control[^0-9]*(\d+)\s*/\s*(\d+)', body)
        if not treatment or not control:
            return outcome(NOT_EVALUATED, 'accepted correction values could not be read from the frozen source')
        t, n = int(treatment.group(1)), int(treatment.group(2))
        c_count = int(control.group(1))
        corrected = {canonical(t / n), canonical(100 * (t - c_count) / n), canonical((t - c_count) / n)}
        found = {}
        for name, text in (('submission/answer.json', answer), ('reports/' + succ['id'] + '.md', report), ('continuity/state.json', json.dumps(state))):
            tokens = numeric_tokens(text)
            for value in corrected:
                if value in tokens:
                    found.setdefault(name, []).extend(sorted(tokens[value]))
        applied = bool(found)
        evidence.append({'path': audit['_file'], 'excerpt': excerpt(body, 160), 'check': 'accepted tracking-audit treatment %d/%d' % (t, n)})
        for name, tokens in found.items():
            evidence.append({'path': str(tree / name) if name != 'submission/answer.json' else str(succ_ctl / name), 'excerpt': ', '.join(tokens), 'check': 'corrected value present'})
        adopted = []
        proposals = {'research-gate-proposal': ['research-gate-proposal', '+3 percentage', '3 percentage point', '3pp', '3 pp', 'efficacy threshold'],
                     'south-proposal': ['south-proposal', 'global rollout']}
        for record in records:
            if record.get('status') == 'proposed' and record.get('id') in proposals:
                hits = markers_absent(accepted_text, proposals[record['id']])
                if hits:
                    adopted.append(record['id'] + ' (' + ', '.join(hits) + ')')
                evidence.append({'path': str(tree / 'continuity/state.json'), 'excerpt': excerpt(accepted_text), 'check': 'unapproved ' + record['id'] + (' adopted' if hits else ' not adopted in accepted_decisions')})
        return outcome(applied and not adopted, ('accepted correction applied' if applied else 'corrected values absent from successor delivery') + ('; unapproved proposal in accepted_decisions: ' + '; '.join(adopted) if adopted else ''), evidence)
    if track == 'engineering':
        d_release = Path(pack) / succ['delta_dir'] / 'release/API-D.md'
        proposal = Path(pack) / succ['delta_dir'] / 'release/retry-proposal.md'
        if succ['id'] != 'D' or not d_release.is_file() or not proposal.is_file():
            return outcome(NOT_EVALUATED, 'no accepted correction with a competing unapproved proposal is released by this stage')
        pending = state.get('pending_operations', []) if isinstance(state.get('pending_operations'), list) else []
        prev_tree = root / 'stages' / stages[index - 1]['id'] / 'controller/handoff/tree'
        prev_state = optional_json(prev_tree / 'continuity/state.json') or {}
        prev_ops = prev_state.get('pending_operations', []) if isinstance(prev_state.get('pending_operations'), list) else []
        prev_key = prev_ops[0].get('key') if prev_ops and isinstance(prev_ops[0], dict) else None
        cancel_text = accepted_text + ' ' + report
        applied_policy = 'cancel' in cancel_text.lower()
        retained = bool(pending) and isinstance(pending[0], dict) and pending[0].get('key') == prev_key and prev_key is not None and pending[0].get('receipt_id') == (prev_ops[0].get('receipt_id') if prev_ops else None)
        evidence.append({'path': str(d_release), 'excerpt': 'cancellation policy released', 'check': 'cancellation ' + ('mentioned in accepted_decisions/report' if applied_policy else 'absent')})
        evidence.append({'path': str(tree / 'continuity/state.json'), 'excerpt': excerpt(json.dumps(pending)), 'check': "predecessor key/receipt " + ('retained' if retained else 'not retained')})
        hits = markers_absent(accepted_text, ['retry-proposal', 'resubmit', 'new ids', 'new IDs'])
        new_keys = [op.get('key') for op in pending[1:] if isinstance(op, dict) and op.get('status') == 'planned' and op.get('key') != prev_key]
        adopted = bool(hits or new_keys)
        evidence.append({'path': str(proposal), 'excerpt': excerpt(accepted_text), 'check': 'unapproved retry proposal ' + ('adopted: ' + ', '.join(hits + [str(k) for k in new_keys]) if adopted else 'not adopted')})
        applied = applied_policy and retained
        return outcome(applied and not adopted, ('cancellation correction applied with receipt retained' if applied else 'cancellation correction not applied or receipt not retained') + ('; unapproved retry proposal adopted' if adopted else ''), evidence)
    return outcome(NOT_EVALUATED, 'no decision map for track ' + str(track))


# ---------------------------------------------------------------- 3. no_redo
def entrypoints(track, pred_tree):
    if track == 'pm':
        return ['analysis/reproduce.py']
    names = []
    if Path(pred_tree).is_dir():
        for name in sequence.inventory(pred_tree):
            base = name.rsplit('/', 1)[-1]
            if base.endswith('.py') and (base.startswith('test_') or base.endswith('_test.py') or 'check' in base):
                names.append(name)
    return names


def is_execution(text, entries, pred_fractions):
    for entry in entries:
        if re.search(r'(?:python3?|pytest|sh|bash)\b[^\n]*' + re.escape(entry), text) or re.search(r'(?:^|[\s;&|])\./' + re.escape(entry), text):
            return 'executes predecessor entrypoint ' + entry
    if entries and any(not e.startswith('analysis/') for e in entries) and re.search(r'python3?\s+-m\s+(?:unittest|pytest)\b|\bpytest\b', text):
        return 'runs predecessor test suite'
    if re.search(r'python3?\b', text) and any(fraction in text for fraction in pred_fractions):
        return 'inline re-derivation of predecessor result fraction'
    return None


def no_redo(root, manifest, index):
    stages = manifest['stages']
    pred, succ = stages[index - 1], stages[index]
    stage_dir = root / 'stages' / succ['id']
    calls = rollout_calls(stage_dir)
    if not calls:
        return outcome(NOT_EVALUATED, 'session rollout unavailable')
    pred_ctl = root / 'stages' / pred['id'] / 'controller'
    pred_tree = pred_ctl / 'handoff/tree'
    entries = entrypoints(manifest['track'], pred_tree)
    pred_text = text_of(optional_json(pred_ctl / 'submission/answer.json')) + '\n' + (optional_text(pred_tree / ('reports/' + pred['id'] + '.md')) or '')
    pred_fractions = fractions(pred_text)
    checkpoint = next((i for i, c in enumerate(calls) if 'recover_handoff' in c['text']), None)
    redo = []
    for i, call in enumerate(calls):
        if checkpoint is not None and i >= checkpoint:
            break
        why = is_execution(call['text'], entries, pred_fractions)
        if why:
            redo.append({'path': call['path'], 'line': call['line'], 'excerpt': excerpt(call['text']), 'rule': why})
    detail = {'entrypoints': entries, 'checkpoint_call': None if checkpoint is None else {'path': calls[checkpoint]['path'], 'line': calls[checkpoint]['line']}, 'calls_inspected': len(calls) if checkpoint is None else checkpoint}
    if redo:
        return outcome(False, 'predecessor analysis re-executed before the recovery checkpoint' if checkpoint is not None else 'predecessor analysis re-executed and no recovery checkpoint call exists', redo, **detail)
    return outcome(True, 'no re-execution of the predecessor analysis before the recovery checkpoint' if checkpoint is not None else 'no re-execution of the predecessor analysis (no recovery checkpoint call in rollout)', [], **detail)


# ---------------------------------------------------------------- report
def grade_reuse(entries, out, require_complete=True, cohort_scope=None):
    plan = grading.preflight(entries, require_complete=require_complete, cohort_scope=cohort_scope)
    arms = expected_arms({'cohort_scope': cohort_scope} if cohort_scope is not None else {})
    out = Path(out).resolve()
    if out.exists():
        raise ValueError('reuse grading output must be a new directory')
    out.mkdir(parents=True, mode=0o700)
    result = {'schema': 'teamwork-reuse-grade/v3', 'cohort_scope': cohort_scope, 'cohort': cohort_label(arms), 'expected_sequences': len(arms) * 2,
              'model_calls': 0, 'source_artifacts_modified': 0, 'rules': 'see grade-reuse.py docstring and rubric.md; unavailable evidence is not_evaluated',
              'source_hashes': {str(p): sha(p) for p in [HERE / 'grade-reuse.py', HERE / 'grade-run.py', HERE / 'mechanisms.py', HERE / 'rubric.md']}, 'sequences': []}
    for entry, root, state, pack, manifest in plan:
        row = {'root': str(root), 'arm': state['arm'], 'track': state['track'], 'pack_sha256': state['pack_manifest_sha256'], 'sequence_sha256': sha(root / 'sequence.json'), 'stages': {}}
        for index in range(1, len(manifest['stages'])):
            succ = manifest['stages'][index]['id']
            transition = manifest['stages'][index - 1]['id'] + '→' + succ
            try:
                row['stages'][succ] = {'transition': transition, 'reused_finding': reused_finding(root, pack, manifest, index, state['arm']),
                                       'followed_decision': followed_decision(root, pack, manifest, index), 'no_redo': no_redo(root, manifest, index)}
            except (ValueError, OSError, KeyError, TypeError) as error:
                row['stages'][succ] = {'transition': transition, 'infrastructure_error': str(error)[:1000],
                                       'reused_finding': outcome(NOT_EVALUATED, 'grader error: ' + str(error)[:200]),
                                       'followed_decision': outcome(NOT_EVALUATED, 'grader error: ' + str(error)[:200]),
                                       'no_redo': outcome(NOT_EVALUATED, 'grader error: ' + str(error)[:200])}
        result['sequences'].append(row)
    grading.write(out / 'report.json', result)
    lines = ['# Reuse results', '', 'Three deterministic booleans per successor stage; evidence paths are in report.json. `NE` is not_evaluated (unavailable evidence, never false). No model calls.', '',
             '| Arm | Track | Stage | reused_finding | followed_decision | no_redo |', '|---|---|---|---|---|---|']
    def show(value):
        return 'NE' if value['status'] == NOT_EVALUATED else ('yes' if value['status'] is True else 'no')
    for row in result['sequences']:
        for name, stage in row['stages'].items():
            lines.append(f"| {row['arm']} | {row['track']} | {name} | {show(stage['reused_finding'])} | {show(stage['followed_decision'])} | {show(stage['no_redo'])} |")
    lines += ['', 'reused_finding requires both carried predecessor key values and observed retrieval through the arm mechanism. followed_decision checks the fixture-declared accepted correction and unapproved proposal. no_redo flags re-execution of the predecessor analysis before the recovery checkpoint.']
    (out / 'report.md').write_text('\n'.join(lines) + '\n')
    return result


if __name__ == '__main__':
    p = argparse.ArgumentParser(description='Reuse scorer for ended native-continuation sequences (no model calls).')
    p.add_argument('--config', required=True, help='JSON {schema:"recovery-grade-run/v3", sequences:[{root,provider_events?}], cohort_scope?}')
    p.add_argument('--out', required=True)
    p.add_argument('--allow-partial', action='store_true', help='grade an incomplete cohort (default requires the declared complete cohort)')
    a = p.parse_args()
    config = read(a.config)
    if config.get('schema') != 'recovery-grade-run/v3':
        raise SystemExit('expected recovery-grade-run/v3')
    report = grade_reuse(config['sequences'], a.out, require_complete=not a.allow_partial, cohort_scope=config.get('cohort_scope'))
    print(json.dumps({'sequences': len(report['sequences']), 'model_calls': 0, 'report': str(Path(a.out).resolve() / 'report.json')}))
