"""Grade an ended native-continuation run without rewriting any run artifacts."""
import mechanisms
from cohort_scope import expected_arms, cohort_label
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


recovery = module('v3_recovery_grading', HERE / 'grade-recovery.py')
sequence = module('v3_sequence_grading', HERE / 'sequence.py')


def read(file):
    return json.loads(Path(file).read_text())


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def write(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    with file.open('x') as stream:
        json.dump(value, stream, indent=2); stream.write('\n')


def engineering_grader():
    # Import the fixed, versioned public-contract scorer; never the original V2 bug.
    sys.path.insert(0, str(HERE.parent / 'teamwork-v2'))
    try:
        return module('engineering_contract_v2_for_recovery', HERE.parent / 'teamwork-v2/grade_engineering_contract_v2.py').grade
    finally:
        sys.path.pop(0)


def artifact_selection(pack, manifest, producer_stage, producer_tree):
    stages = [s['id'] for s in manifest['stages']]
    upto = stages[:stages.index(producer_stage) + 1]
    fixed = {'continuity/state.json'}
    fixed.update('reports/' + s + '.md' for s in upto)
    fixed.update('continuity/history/' + s + '.json' for s in upto[:-1])
    fixed.add('analysis/reproduce.py' if manifest['track'] == 'pm' else 'app.py')
    for st in manifest['stages']:
        if st['id'] in upto:
            fixed.update(sequence.inventory(Path(pack) / st['delta_dir']))
    initial = sequence.inventory(Path(pack) / manifest['initial_repo_dir'])
    actual = sequence.inventory(producer_tree) if Path(producer_tree).is_dir() else {}
    additional = [name for name, digest in actual.items()
                  if name not in fixed and initial.get(name) != digest
                  and not any(part.startswith('.') for part in Path(name).parts)]
    return {'fixed_public_paths': sorted(fixed), 'additional_actual_task_paths': sorted(additional),
            'excluded_unchanged_starter_paths': sorted(name for name, digest in actual.items()
                                                     if name in initial and digest == initial[name]),
            'note': 'Fixed and additional artifact vectors stay separate; output quantity is not a cross-product weight.'}


def input_transport(pack, manifest, stage, controller):
    file = Path(controller) / 'transport.json'
    if not file.exists():
        return {'status': 'not_evaluated', 'reason': 'transport receipt missing'}
    receipt = read(file)
    expected_initial = sequence.inventory(Path(pack) / manifest['initial_repo_dir'])
    expected_delta = sequence.inventory(Path(pack) / stage['delta_dir'])
    valid = (receipt.get('schema') == 'teamwork-input-transport/v3'
             and receipt.get('initial_git_commit_count') == 1
             and receipt.get('initial_repo_files') == expected_initial
             and receipt.get('current_delta_files') == expected_delta
             and receipt.get('released_files') == {**expected_initial, **expected_delta})
    return {'status': 'verified' if valid else 'invalid', 'receipt_sha256': sha(file),
            'initial_git_commit_count': receipt.get('initial_git_commit_count'),
            'source_policy': receipt.get('source_policy')}


def preflight(entries, require_complete=False, cohort_scope=None):
    arms = expected_arms({"cohort_scope": cohort_scope} if cohort_scope is not None else {})
    if not entries:
        raise ValueError('at least one ended sequence required')
    result, roots, arms_tracks = [], set(), set()
    for entry in entries:
        root = Path(entry['root']).resolve(strict=True)
        state = read(root / 'sequence.json')
        if state.get('schema') != 'teamwork-sequence/v3' or state.get('status') != 'ended':
            raise ValueError('post-run grading requires ended teamwork-sequence/v3')
        if state['arm'] not in arms:
            raise ValueError('sequence arm excluded by the declared cohort')
        if root in roots or (state['arm'], state['track']) in arms_tracks:
            raise ValueError('duplicate sequence root or arm/track')
        roots.add(root); arms_tracks.add((state['arm'], state['track']))
        pack = Path(state['pack'])
        manifest = sequence.validate_pack(pack)
        if manifest.get('development'):
            raise ValueError('development sequences cannot enter scored report')
        if sha(pack / 'manifest.json') != state['pack_manifest_sha256']:
            raise ValueError('sequence pack hash changed')
        if state['track'] != manifest['track'] or state['arm'] not in manifest['arms']:
            raise ValueError('sequence arm/track differs from pack')
        result.append((entry, root, state, pack, manifest))
    for track in {s[2]['track'] for s in result}:
        if len({s[2]['pack_manifest_sha256'] for s in result if s[2]['track'] == track}) != 1:
            raise ValueError('different frozen packs within one track')
    if require_complete:
        expected = {(arm, track) for arm in arms for track in ('pm', 'engineering')}
        if arms_tracks != expected or any([s['id'] for s in row[4]['stages']] != list('ABCD') for row in result):
            raise ValueError('complete ' + cohort_label(arms) + ' two-track A-D cohort required; retain every expected task')
    return result


def grade_run(entries, out, functional_grader=None, require_complete=True, cohort_scope=None):
    plan = preflight(entries, require_complete=require_complete, cohort_scope=cohort_scope)
    arms = expected_arms({"cohort_scope": cohort_scope} if cohort_scope is not None else {})
    out = Path(out).resolve()
    if out.exists():
        raise ValueError('grading output must be a new directory')
    out.mkdir(parents=True, mode=0o700)
    functional_grader = functional_grader or engineering_grader()
    result = {'schema': 'native-continuation-run-grade/v3', 'sequences': [],
              'cohort_scope': cohort_scope, 'expected_sequences': len(arms) * 2, 'expected_tasks': len(arms) * 8,
              'model_calls': 0, 'source_artifacts_modified': 0,
              'pm_decision_quality': 'not_evaluated; independent reviews have not been launched',
              'native_retrieval_verified': 'not_evaluated; separate native evidence audit required',
              'source_hashes': {str(p): sha(p) for p in [HERE / 'grade-run.py', HERE / 'grade-recovery.py',
                              HERE / 'rubric.md', HERE.parent / 'teamwork-v2/grade_engineering_contract_v2.py',
                              HERE.parent / 'teamwork-v2/provider_sim.py']}}
    for entry, root, state, pack, manifest in plan:
        row = {'root': str(root), 'arm': state['arm'], 'track': state['track'],
               'seed': manifest['seed'], 'pack_sha256': state['pack_manifest_sha256'],
               'sequence_sha256': sha(root / 'sequence.json'), 'stages': {}}
        provider = entry.get('provider_events')
        row['provider_events_sha256'] = sha(provider) if provider and Path(provider).is_file() else None
        for index, stage in enumerate(manifest['stages']):
            name = stage['id']; ctl = root / 'stages' / name / 'controller'
            observed = state.get('stages', {}).get(name, {})
            current = {'execution_status': observed.get('status', 'missing'),
                       'execution_error': observed.get('error'), 'input_transport': input_transport(pack, manifest, stage, ctl),
                       'delivery': {'status': 'not_delivered'}, 'functional': {'status': 'not_evaluated'},
                       'compaction': observed.get('session', {}).get('compaction', {'status': 'not_evaluated'}),
                       'interruption': observed.get('session', {}).get('interruption', {'status': 'not_evaluated'})}
            final_valid = False
            try:
                final_valid = sequence.verify_submission(ctl, stage['deadline_ms'])
                if final_valid:
                    delivery = recovery.verify_receipt(ctl / 'submission/tree', ctl / 'delivery.json')
                    current['delivery'] = {'status': 'verified', 'elapsed_ms': delivery['elapsed_ms'],
                                           'receipt_sha256': sha(ctl / 'delivery.json'), 'tree_sha256': delivery['tree']['sha256']}
                elif (ctl / 'delivery.json').exists():
                    current['delivery'] = {'status': 'invalid_or_late', 'receipt_sha256': sha(ctl / 'delivery.json')}
            except (ValueError, OSError) as error:
                current['delivery'] = {'status': 'integrity_invalid', 'error': str(error)}
                final_valid = False
            if final_valid and state['track'] == 'engineering':
                try:
                    current['functional'] = functional_grader(ctl / 'submission/tree', name)
                    current['functional']['grader'] = 'public behavioral contract amendment v2; distinct from recovery'
                except Exception as error:
                    current['functional'] = {'status': 'not_evaluated', 'infrastructure_error': str(error)}
            elif state['track'] == 'pm':
                current['functional'] = {'status': 'not_evaluated', 'reason': 'No new PM exact-string or quality oracle is inferred from this task output.'}
            if index == 0:
                current['recovery'] = {'status': 'not_applicable', 'reason': 'initial producer has no predecessor'}
            else:
                previous = manifest['stages'][index - 1]['id']
                pred = root / 'stages' / previous / 'controller'
                pred_tree = pred / 'handoff/tree'
                try:
                    selection = artifact_selection(pack, manifest, previous, pred_tree)
                    current['artifact_selection'] = selection
                    if not (pred / 'handoff.json').is_file() or not pred_tree.is_dir():
                        raise ValueError('actual predecessor handoff snapshot/receipt unavailable')
                    pr = recovery.verify_receipt(pred_tree, pred / 'handoff.json', 'teamwork-handoff/v3')
                    contract = recovery.derive_contract(pred_tree, selection['fixed_public_paths'] + selection['additional_actual_task_paths'], producer_receipt=pr)
                    if previous == 'B' and name == 'C':
                        contract['obligations'].append({'id': 'operation:interrupted-request', 'kind': 'uncertain_effect',
                            'severity': 'critical', 'source': {'artifact_id': 'continuity/state.json', 'json_pointer': '/pending_operations/0/key'},
                            'recovered': {'path': 'continuity/state.json', 'json_pointer': '/pending_operations/0'},
                            'producer_stage': previous, 'successor_stage': name})
                    rr = read(ctl / 'recovery.json') if (ctl / 'recovery.json').is_file() else None
                    timing_error = None
                    if rr is not None:
                        elapsed = rr.get('elapsed_ms')
                        if type(elapsed) not in (int, float) or not math.isfinite(elapsed) or not 0 <= elapsed <= stage['deadline_ms']:
                            timing_error = 'recovery checkpoint exceeded stage deadline or has invalid time'
                        elif final_valid and elapsed > current['delivery']['elapsed_ms']:
                            timing_error = 'recovery checkpoint occurred after task delivery'
                    graded = recovery.grade(contract, pred_tree, ctl / 'recovery/tree', pr, rr,
                                             provider, ctl / 'submission/tree' if final_valid else None)
                    if timing_error:
                        graded['infrastructure_errors'].append(timing_error); graded['status'] = 'infrastructure_invalid'
                        for check in graded['checks']:
                            if check['status'] != 'not_evaluated': check['status'] = 'not_evaluated'; check['details'] = timing_error
                        graded['counts'] = {'passed': 0, 'failed': 0, 'not_evaluated': len(graded['checks'])}
                        graded['critical_failures'] = []
                        for group in graded['by_kind'].values():
                            total = sum(group.values()); group.update(passed=0, failed=0, not_evaluated=total)
                    current['recovery'] = graded
                    current['recovery']['transition'] = previous + '→' + name
                    current['recovery']['elapsed_ms'] = rr.get('elapsed_ms') if rr else None
                    current['recovery']['producer_handoff_sha256'] = sha(pred / 'handoff.json')
                    current['recovery']['recovery_receipt_sha256'] = sha(ctl / 'recovery.json') if rr else None
                    fixed = set(selection['fixed_public_paths'])
                    current['recovery']['artifact_groups'] = {
                        group: [c['id'] for c in graded['checks'] if c['kind'] == 'artifact' and
                                (c['id'][len('artifact:'):] in fixed) == (group == 'fixed_public')]
                        for group in ('fixed_public', 'additional_actual')}
                    current['recovery']['artifact_group_counts'] = {
                        group: {status: sum(c['id'] in identifiers and c['status'] == status for c in graded['checks'])
                                for status in ('passed', 'failed', 'not_evaluated')}
                        for group, identifiers in current['recovery']['artifact_groups'].items()}
                    write(out / 'contracts' / (state['track'] + '-' + state['arm'] + '-' + name + '.json'), contract)
                except (ValueError, OSError) as error:
                    current['recovery'] = {'status': 'not_evaluated', 'producer_or_controller_gap': str(error),
                                           'transition': previous + '→' + name,
                                           'note': 'No expected producer output was invented or scored as successful recovery.'}
            row['stages'][name] = current
        try:
            row['mechanism_audit']=mechanisms.audit(root)
        except (ValueError, OSError, KeyError) as error:
            row['mechanism_audit']={'status':'not_evaluated','error':str(error)}
        journal=root/'interventions.jsonl'
        row['interventions']=[json.loads(line) for line in journal.read_text().splitlines()] if journal.exists() else []
        result['sequences'].append(row)
    write(out / 'report.json', result)
    lines = ['# Native continuation results', '', 'Recovery and engineering functionality are separate. PM decision quality and native mechanism attribution require independent audits.', '',
             '| Product | Track | Stage | Delivery | Required artifacts P/F/NE | Additional artifacts P/F/NE | State P/F/NE | Operation P/F/NE | Engineering checks |',
             '|---|---|---|---|---|---|---|---|---|']
    for row in result['sequences']:
        for name, stage in row['stages'].items():
            groups = stage['recovery'].get('by_kind', {})
            def counts(kind):
                c = groups.get(kind)
                return '/'.join(str(c[s]) for s in ('passed', 'failed', 'not_evaluated')) if c else stage['recovery']['status']
            def artifact_counts(group):
                c = stage['recovery'].get('artifact_group_counts', {}).get(group)
                return '/'.join(str(c[s]) for s in ('passed', 'failed', 'not_evaluated')) if c else stage['recovery']['status']
            f = stage['functional']
            functional = str(f['passed']) + '/' + str(f['applicable']) if 'passed' in f else f.get('status', 'not_evaluated')
            lines.append(f"| {row['arm']} | {row['track']} | {name} | {stage['delivery']['status']} | {artifact_counts('fixed_public')} | {artifact_counts('additional_actual')} | {counts('state')} | {counts('uncertain_effect')} | {functional} |")
    lines += ['', 'P/F/NE means passed, failed, and not evaluated. Missing producer outputs and infrastructure gaps remain explicit in report.json. Additional actual task files are identified separately from fixed public obligations; differing output quantity is not a cross-product weight. No model reviewers ran during grading.']
    (out / 'report.md').write_text('\n'.join(lines) + '\n')
    return result


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--config', required=True, help='JSON {schema:"recovery-grade-run/v3", sequences:[{root,provider_events?}]}')
    p.add_argument('--out', required=True)
    a = p.parse_args(); config = read(a.config)
    if config.get('schema') != 'recovery-grade-run/v3':
        raise SystemExit('expected recovery-grade-run/v3')
    report = grade_run(config['sequences'], a.out, cohort_scope=config.get('cohort_scope'))
    print(json.dumps({'sequences': len(report['sequences']), 'model_calls': 0, 'report': str(Path(a.out).resolve() / 'report.json')}))
