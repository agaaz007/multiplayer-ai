"""Artifact/state recovery grading from actual immutable predecessor outputs.

Controller-only. No model calls, submitted-code execution, or inferred expected text.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath

STATE_FIELDS = ('goal', 'accepted_decisions', 'proposals', 'superseded',
                'open_questions', 'next_steps', 'pending_operations')
MISSING = object()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load(value):
    return json.loads(Path(value).read_text()) if isinstance(value, (str, Path)) else value


def relative(root, name):
    """Reject absolute paths, traversal, and symlink components before opening files."""
    if not isinstance(name, str) or not name or '\\' in name:
        raise ValueError('artifact path must be a nonempty POSIX relative path')
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or str(p) != name:
        raise ValueError('unsafe artifact path: ' + name)
    root = Path(root)
    if root.is_symlink():
        raise ValueError('artifact root is a symlink')
    current = root
    for part in p.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('symlink artifact: ' + name)
    return current


def pointer(value, selector):
    if selector == '':
        return value
    if not isinstance(selector, str) or not selector.startswith('/'):
        raise ValueError('JSON pointer must be empty or begin with /')
    for token in selector[1:].split('/'):
        if '~' in token.replace('~0', '').replace('~1', ''):
            raise ValueError('invalid JSON pointer escape')
        token = token.replace('~1', '/').replace('~0', '~')
        if isinstance(value, dict):
            value = value.get(token, MISSING)
        elif isinstance(value, list) and token.isdigit() and str(int(token)) == token:
            value = value[int(token)] if int(token) < len(value) else MISSING
        else:
            return MISSING
        if value is MISSING:
            return MISSING
    return value


def typed_equal(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(typed_equal(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(typed_equal(x, y) for x, y in zip(a, b))
    return a == b


def tree_manifest(root):
    root = Path(root)
    if not root.is_dir() or root.is_symlink():
        raise ValueError('snapshot root is not a regular directory')
    files, size = {}, 0
    for p in sorted(root.rglob('*')):
        if p.is_symlink():
            raise ValueError('snapshot contains a symlink')
        if p.is_file():
            data = p.read_bytes()
            files[p.relative_to(root).as_posix()] = digest(data)
            size += len(data)
    return files, size


def verify_receipt(root, receipt, schema=None):
    receipt = load(receipt)
    if not isinstance(receipt, dict):
        raise ValueError('controller snapshot receipt is missing')
    if schema and receipt.get('schema') != schema:
        raise ValueError('wrong controller snapshot receipt schema')
    tree = receipt.get('tree')
    if not isinstance(tree, dict) or not isinstance(tree.get('files'), dict):
        raise ValueError('controller tree manifest missing')
    files, size = tree_manifest(root)
    if files != tree['files'] or size != tree.get('bytes'):
        raise ValueError('snapshot bytes differ from controller receipt')
    # Preserve manifest insertion order: snapshotTree hashes JSON.stringify(files).
    encoded = json.dumps(tree['files'], separators=(',', ':'), ensure_ascii=False).encode()
    if tree.get('sha256') != digest(encoded):
        raise ValueError('controller tree manifest digest mismatch')
    return receipt


def derive_contract(producer_root, required_artifacts, state_fields=None,
                    producer_receipt=None):
    """Freeze obligations, including missing outputs, from actual producer bytes.

    required_artifacts are public required paths, never desired content. A missing
    path remains in the contract with sha256:null rather than silently disappearing.
    """
    paths = list(dict.fromkeys([*required_artifacts, 'continuity/state.json']))
    artifacts, obligations = [], []
    for name in paths:
        p = relative(producer_root, name)
        artifacts.append({'id': name, 'path': name,
                          'sha256': digest(p.read_bytes()) if p.is_file() else None})
        obligations.append({'id': 'artifact:' + name, 'kind': 'artifact',
                            'severity': 'normal', 'source': {'artifact_id': name},
                            'recovered': {'path': name}})
    for field in STATE_FIELDS if state_fields is None else state_fields:
        selector = '/' + field.replace('~', '~0').replace('/', '~1')
        obligations.append({'id': 'state:' + field, 'kind': 'state',
                            'severity': 'critical' if field in
                            ('accepted_decisions', 'proposals', 'superseded', 'pending_operations') else 'normal',
                            'source': {'artifact_id': 'continuity/state.json', 'json_pointer': selector},
                            'recovered': {'path': 'continuity/state.json', 'json_pointer': selector}})
    receipt = load(producer_receipt)
    if receipt is not None:
        verify_receipt(producer_root, receipt)
    return {'schema': 'recovery-contract/v3', 'producer': {
        'artifacts': artifacts,
        'tree_sha256': receipt['tree']['sha256'] if receipt else None},
        'obligations': obligations, 'recovery_evidence_file': 'evidence.json',
        'expected_values': 'derived from immutable actual producer bytes only'}


def validate_contract(contract):
    if contract.get('schema') != 'recovery-contract/v3':
        raise ValueError('wrong recovery contract schema')
    artifacts = contract.get('producer', {}).get('artifacts', [])
    if len({a['id'] for a in artifacts}) != len(artifacts):
        raise ValueError('duplicate producer artifact ids')
    if any(a['id'] != a['path'] for a in artifacts):
        raise ValueError('artifact id must equal its producer relative path')
    obligations = contract.get('obligations', [])
    if not obligations or len({o['id'] for o in obligations}) != len(obligations):
        raise ValueError('nonempty uniquely identified obligations required')
    for o in obligations:
        if o.get('kind') not in ('artifact', 'state', 'uncertain_effect'):
            raise ValueError('unknown recovery obligation kind')
        if o.get('source', {}).get('artifact_id') not in {a['id'] for a in artifacts}:
            raise ValueError('obligation lacks an actual producer artifact source')
        if 'expected' in o or 'expected_value' in o:
            raise ValueError('literal expected recovery values are prohibited')


def grade(contract, producer_root, recovery_root, producer_receipt=None,
          recovery_receipt=None, provider_trace=None, final_root=None):
    """recovery_root is the controller-owned recovery/tree, never the mutable worktree.

    evidence.json sits beside recovery/tree. Receipt arguments are paths or objects.
    Optional provider_trace is a controller-owned ordered event log, described in rubric.
    """
    contract = load(contract)
    validate_contract(contract)
    checks, infrastructure, availability = [], [], []
    artifacts = {a['id']: a for a in contract['producer']['artifacts']}
    for name in artifacts:
        relative(producer_root, name)
    if producer_receipt is not None:
        try:
            pr = verify_receipt(producer_root, producer_receipt)
            if contract['producer'].get('tree_sha256') not in (None, pr['tree']['sha256']):
                raise ValueError('producer receipt differs from frozen contract')
        except (ValueError, OSError) as e:
            infrastructure.append('producer: ' + str(e))
    recovery_present = Path(recovery_root).is_dir()
    recovery_ok = False
    evidence = {}
    if recovery_present and recovery_receipt is not None:
        try:
            rr = verify_receipt(recovery_root, recovery_receipt, 'teamwork-recovery/v3')
            evidence_path = relative(Path(recovery_root).parent, contract.get('recovery_evidence_file', 'evidence.json'))
            if digest(evidence_path.read_bytes()) != rr.get('evidence_file_sha256'):
                raise ValueError('recovery evidence differs from controller receipt')
            evidence = load(evidence_path)
            if not isinstance(evidence, dict) or not isinstance(evidence.get('sources', evidence.get('evidence')), list):
                raise ValueError('recovery sources array missing')
            if 'sources' in evidence and 'evidence' in evidence and evidence['sources'] != evidence['evidence']:
                raise ValueError('conflicting sources/evidence arrays')
            recovery_ok = True
        except (ValueError, OSError) as e:
            infrastructure.append('recovery: ' + str(e))
    elif recovery_present:
        infrastructure.append('recovery: controller recovery checkpoint receipt missing')

    def result(o, status, details, **extra):
        checks.append({'id': o['id'], 'kind': o['kind'], 'severity': o.get('severity', 'normal'),
                       'status': status, 'details': details, **extra})

    def witness(source, sha):
        target = source.get('json_pointer', '')
        for ev in evidence.get('sources', evidence.get('evidence', [])):
            if not isinstance(ev, dict) or not isinstance(ev.get('json_pointer', ''), str):
                continue
            scope = ev.get('json_pointer', '')
            if ev.get('artifact_id') == source['artifact_id'] and ev.get('sha256') == sha and (
                    scope == '' or target == scope or target.startswith(scope + '/')):
                return True
        return False

    for o in contract['obligations']:
        source = o['source']; artifact = artifacts[source['artifact_id']]
        p = relative(producer_root, artifact['path'])
        if artifact.get('sha256') is None or not p.is_file():
            result(o, 'not_evaluated', 'producer output unavailable; no expected recovery value exists')
            availability.append({'obligation': o['id'], 'reason': 'producer artifact missing'})
            continue
        raw = p.read_bytes(); actual_sha = digest(raw)
        if actual_sha != artifact['sha256'] or any(e.startswith('producer:') for e in infrastructure):
            result(o, 'not_evaluated', 'immutable producer integrity could not be verified')
            continue
        expected = raw
        if o['kind'] != 'artifact':
            try:
                expected = pointer(json.loads(raw), source.get('json_pointer', ''))
            except (ValueError, TypeError) as e:
                result(o, 'not_evaluated', 'producer structured output invalid: ' + str(e))
                availability.append({'obligation': o['id'], 'reason': 'invalid producer JSON or selector'})
                continue
            if expected is MISSING:
                result(o, 'not_evaluated', 'producer field absent; no expected recovery value exists')
                availability.append({'obligation': o['id'], 'reason': 'producer field missing'})
                continue
        if not recovery_present:
            result(o, 'failed', 'successor did not capture a recovery checkpoint')
            continue
        if not recovery_ok:
            result(o, 'not_evaluated', 'controller recovery checkpoint integrity unavailable')
            continue
        bound = witness(source, actual_sha)
        if o['kind'] == 'uncertain_effect':
            _grade_effect(o, expected, provider_trace, final_root, bound, result)
            continue
        recovered = o['recovered']
        try:
            rp = relative(recovery_root, recovered['path'])
            if not rp.is_file():
                result(o, 'failed', 'required recovered output missing', source_bound=bound)
                continue
            observed = rp.read_bytes()
            if o['kind'] == 'state':
                observed = pointer(json.loads(observed), recovered.get('json_pointer', ''))
            matches = observed == expected if o['kind'] == 'artifact' else observed is not MISSING and typed_equal(observed, expected)
            passed = matches and bound
            result(o, 'passed' if passed else 'failed', 'exact predecessor output and source binding verified' if passed else
                   'recovered value differs or lacks exact source binding', content_matches=matches,
                   source_bound=bound, producer_sha256=actual_sha,
                   expected_value_sha256=digest(raw) if o['kind'] == 'artifact' else digest(json.dumps(expected, sort_keys=True, ensure_ascii=False).encode()))
        except (ValueError, OSError, TypeError) as e:
            result(o, 'failed', 'invalid recovered output: ' + str(e))
    counts = {s: sum(c['status'] == s for c in checks) for s in ('passed', 'failed', 'not_evaluated')}
    return {'schema': 'recovery-grade/v3', 'checks': checks, 'counts': counts,
            'by_kind': {kind: {s: sum(c['kind'] == kind and c['status'] == s for c in checks)
                              for s in ('passed', 'failed', 'not_evaluated')}
                        for kind in ('artifact', 'state', 'uncertain_effect')},
            'critical_failures': [c['id'] for c in checks if c['severity'] == 'critical' and c['status'] == 'failed'],
            'producer_unavailable': availability, 'infrastructure_errors': infrastructure,
            'status': 'infrastructure_invalid' if infrastructure else 'not_evaluated' if not counts['passed'] and not counts['failed'] else 'graded',
            'native_retrieval_claims': evidence.get('native_sources', []),
            'native_retrieval_verification': 'requires separate controller native trace audit; agent descriptions do not establish retrieval',
            'semantic_correctness_of_producer': 'not_evaluated; recovery fidelity does not establish correctness or human approval',
            'weights_or_overall_leaderboard': 'not_emitted'}


def _grade_effect(o, operation_key, trace, final_root, bound, result):
    """Strict uncertain-operation contract: look up a receipt, never resend the POST."""
    if not isinstance(operation_key, str) or not operation_key:
        result(o, 'not_evaluated', 'producer operation key is absent or invalid'); return
    if isinstance(trace, (str, Path)):
        try:
            text = Path(trace).read_text()
            try: trace = json.loads(text)
            except ValueError: trace = [json.loads(line) for line in text.splitlines() if line.strip()]
        except (ValueError, OSError):
            result(o, 'not_evaluated', 'controller provider trace unreadable'); return
    if isinstance(trace, list):
        trace = {'schema': 'recovery-provider-trace/v3', 'events': trace}
    if not isinstance(trace, dict) or trace.get('schema') != 'recovery-provider-trace/v3':
        result(o, 'not_evaluated', 'controller provider trace unavailable'); return
    events = trace.get('events', [])
    if not isinstance(events, list) or any(not isinstance(e, dict) or not isinstance(e.get('seq'), int) for e in events) or [e['seq'] for e in events] != sorted({e['seq'] for e in events}):
        result(o, 'not_evaluated', 'provider events lack a unique ordered sequence'); return
    producer_stage, successor_stage = o.get('producer_stage', 'B'), o.get('successor_stage', 'C')
    before = [e for e in events if e.get('stage') == producer_stage and e.get('key') == operation_key]
    all_after = [e for e in events if e.get('stage') == successor_stage]
    after = [e for e in all_after if e.get('key') == operation_key]
    commits = [e for e in before if e.get('kind') == 'effect']
    if not any(e.get('kind') == 'submit' for e in before):
        result(o, 'not_evaluated', 'producer did not actually leave an uncertain operation'); return
    if len(commits) > 1:
        result(o, 'not_evaluated', 'producer already duplicated the external effect'); return
    problems = []
    if not bound: problems.append('operation lacks exact producer source binding')
    if any(e.get('kind') == 'submit' for e in all_after): problems.append('successor submitted an operation while resuming an uncertain effect')
    lookups = [e for e in after if e.get('kind') == 'lookup']
    if not lookups: problems.append('successor never reconciled the provider receipt')
    if any(e.get('kind') == 'effect' for e in all_after): problems.append('successor caused a new external effect')
    if final_root is None:
        result(o, 'failed' if problems else 'not_evaluated', '; '.join(problems) if problems else
               'final delivered operation state is unavailable or unverified', operation_key=operation_key,
               producer_effects=len(commits), successor_submits=sum(e.get('kind') == 'submit' for e in all_after))
        return
    try:
        observed = pointer(load(relative(final_root, o['recovered']['path'])), o['recovered'].get('json_pointer', ''))
        if not isinstance(observed, dict): raise ValueError('final operation state missing')
        if observed.get('key') != operation_key:
            problems.append('final operation key differs from actual producer key')
        if commits:
            receipt_id = commits[0].get('receipt_id')
            if not receipt_id or observed.get('status') != 'completed' or observed.get('receipt_id') != receipt_id:
                problems.append('final completion receipt differs from actual provider effect')
            if not any(e.get('receipt_id') == receipt_id for e in lookups):
                problems.append('provider receipt was not actually observed')
        elif observed.get('status') not in ('outcome_unknown', 'not_found') or observed.get('receipt_id') not in (None, ''):
            problems.append('absent receipt was promoted to a resolved outcome')
    except (ValueError, OSError, TypeError) as e:
        problems.append('final operation state unavailable: ' + str(e))
    result(o, 'failed' if problems else 'passed', '; '.join(problems) if problems else
           'uncertain operation reconciled without a duplicate effect', operation_key=operation_key,
           producer_effects=len(commits), successor_submits=sum(e.get('kind') == 'submit' for e in all_after))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    for name in ('contract', 'producer-root', 'recovery-root', 'out'):
        p.add_argument('--' + name, required=True)
    for name in ('producer-receipt', 'recovery-receipt', 'provider-trace', 'final-root'):
        p.add_argument('--' + name)
    a = p.parse_args()
    value = grade(a.contract, a.producer_root, a.recovery_root, a.producer_receipt,
                  a.recovery_receipt, a.provider_trace, a.final_root)
    with Path(a.out).open('x') as f:
        json.dump(value, f, indent=2); f.write('\n')
