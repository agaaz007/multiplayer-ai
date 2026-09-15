#!/usr/bin/env python3
"""Report retained scored artifacts and prepare blind packets; never run models."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets

from fixtures import STAGES, validate
from grade_pm import review_packet
from sequence import verify_submission


def read(path): return json.loads(Path(path).read_text())
def digest(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def write(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.' + path.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n'); temporary.chmod(0o600)
    os.replace(temporary, path)


def references(matrix_status):
    status = read(matrix_status)
    if status.get('schema') != 'teamwork-matrix-run/v2': raise ValueError('actual matrix status required')
    lanes = status.get('preflight', {}).get('arms')
    if not isinstance(lanes, list): raise ValueError('matrix preflight inventory missing')
    return status, lanes


def capture_receipts(controller):
    receipts = []
    for file in sorted(controller.glob('native-capture*.json')):
        if not re.fullmatch(r'native-capture(?:-\d+)?\.json', file.name): continue
        try:
            record = read(file)
            receipts.append({'path': str(file), 'sha256': digest(file), **{key: record[key] for key in
                ('arm', 'elapsed_ms', 'captured', 'capture_complete', 'processing_complete', 'capture_mode',
                 'classifier_enabled', 'classifier_failures') if key in record}})
        except (ValueError, OSError) as error: receipts.append({'path': str(file), 'error': str(error)})
    return receipts


def review_for(stage, mapping, reviews):
    matches = [entry for entry in mapping.get('cases', []) if entry['sequence_root'] == stage['sequence_root'] and entry['stage'] == stage['stage']]
    ended = reviews.get('status') == 'ended'
    if not matches:
        return {'status': 'not_evaluated', 'reason': 'review run ended without a mapped case for this submission'} if ended else {'status': 'pending_independent_reviews'}
    entry = matches[0]
    if stage.get('submission_sha256') != entry.get('submission_sha256'):
        return {'status': 'not_evaluated', 'reason': 'review map does not bind this submitted answer'}
    item = reviews.get('cases', {}).get(entry['case_id'], {})
    pair = item.get('initial_reviews', [])
    def incomplete(pending_status, reason, receipts):
        result = {'status': 'not_evaluated' if ended else pending_status,
                  'review_case': entry['case_id'], 'retained_status': item.get('status')}
        if ended:
            result.update(reason=reason, receipt_errors=[{key: receipt[key] for key in
                ('reviewer', 'role', 'status', 'errors') if key in receipt} for receipt in receipts])
            if item.get('error'): result['case_error'] = item['error']
        return result
    if len(pair) != 2 or any(review.get('status') != 'reviewed' for review in pair):
        return incomplete('pending_independent_reviews', 'review run ended without two valid independent reviews', pair)
    if item.get('disagreement', {}).get('needed') and item.get('adjudication', {}).get('status') != 'reviewed':
        result = incomplete('pending_adjudication', 'review run ended without valid required adjudication', [item['adjudication']] if item.get('adjudication') else [])
        return {**result, 'agreement': item.get('agreement')}
    if not item.get('final_judgment'): return {'status': 'not_evaluated', 'reason': 'no final reviewed judgment'}
    return {'status': item['status'], 'review_case': entry['case_id'], 'judgment': item['final_judgment'],
            'agreement': item.get('agreement'), 'critical_error_gate': item.get('critical_error_gate'),
            'calibration': reviews.get('calibration', {'status': 'unknown'}), 'overall_score': 'not_emitted'}


def summarize(matrix_status, review_results=None, review_map=None):
    status, lanes = references(matrix_status)
    reviews = read(review_results) if review_results else {}
    mapping = read(review_map) if review_map else {}
    if bool(review_results) != bool(review_map): raise ValueError('review results and private map must be supplied together')
    report = {'schema': 'teamwork-retained-report/v2', 'matrix_status': str(Path(matrix_status).resolve()),
        'matrix_status_sha256': digest(matrix_status), 'matrix_state': status.get('status'),
        'matrix_elapsed_seconds': status.get('elapsed_seconds'), 'arms': [], 'stages': [], 'exclusions': [],
        'metric_definitions': {
            'engineering_checks': 'Retained automated acceptance checks passed/applicable, with critical failures separately; no quality inference from submission alone.',
            'pm_facts': 'Retained automated typed-field and hard-constraint agreement, not a count of semantically wrong claims. Independent per-field semantic factual assessment and decision quality are separate.',
            'delivery_elapsed_ms': 'Controller monotonic elapsed time on the immutable submission receipt; missing stays null.',
            'process_elapsed_ms': 'Retained stage session elapsed time including native setup inside the driver; external native preparation/capture shown separately.',
            'tokens': 'Recorded subscription usage; cached input is a subset when the harness reports it. Missing usage stays null; no dollar conversion.',
            'capture': 'Native capture process and selected receipt fields; successful process exit alone does not establish durable handoff or successor reuse.'},
        'limitations': ['Seed 41 development artifacts are excluded.', 'This matrix is an exploratory screen, not a replicated superiority claim.',
            'No aggregate cross-track leaderboard is computed.', 'Decision quality requires independent review; uncalibrated model judgments retain that limitation. Reuse requires separate native trace review.',
            'Matrix elapsed time under parallel dispatch is not a sum of stage latency.']}
    for lane in lanes:
        arm = lane['arm']; arm_status = status.get('arms', {}).get(arm, {})
        report['arms'].append({'arm': arm, 'status': arm_status.get('status', lane.get('status')),
                              'reason': lane.get('reason'), 'sequence_statuses': arm_status.get('sequences', {})})
        if lane.get('status') == 'unavailable': continue
        for entry in lane.get('sequences', []):
            root = Path(entry['root']).resolve()
            try:
                sequence = read(root / 'sequence.json'); launch = read(entry['launch']); pack = Path(sequence['pack'])
                seed = read(pack / 'manifest.json')['seed']
                if seed == 41 or launch.get('development_probe') is True or launch.get('scored') is False:
                    report['exclusions'].append({'sequence_root': str(root), 'reason': 'development/unscored sequence', 'seed': seed}); continue
                validate(pack)
                if digest(pack / 'manifest.json') != sequence['pack_manifest_sha256']: raise ValueError('pack freeze mismatch')
            except (OSError, ValueError, KeyError) as error:
                report['exclusions'].append({'sequence_root': str(root), 'reason': 'unreadable or invalid sequence artifact', 'error': str(error)}); continue
            for stage in STAGES:
                recorded = sequence.get('stages', {}).get(stage, {}); controller = root / 'stages' / stage / 'controller'
                session = recorded.get('session', {}); grade = recorded.get('grade', {})
                item = {'arm': arm, 'track': sequence['track'], 'stage': stage, 'seed': seed, 'sequence_root': str(root),
                    'status': recorded.get('status', 'not_started'), 'sequence_executed': sequence.get('executed'),
                    'model': launch.get('model'), 'reasoning_effort': launch.get('reasoning_effort'),
                    'stage_deadline_ms': launch.get('stage_deadline_ms'), 'delivery_verified': False,
                    'delivery_elapsed_ms': None, 'process_elapsed_ms': session.get('elapsed_ms'),
                    'wall_elapsed_ms': session.get('wall_elapsed_ms'), 'timing_valid': recorded.get('timing_valid'),
                    'session_timed_out': session.get('timed_out'), 'session_exit_code': session.get('exit_code'),
                    'driver_process': recorded.get('driver'), 'subscription_usage': session.get('usage'),
                    'native_preparation': recorded.get('native_preparation'),
                    'native_capture': {'process': recorded.get('capture'), 'receipts': capture_receipts(controller),
                                       'durable_handoff': 'not_evaluated', 'verified_reuse': 'not_evaluated'},
                    'failures': [recorded[key] for key in ('error', 'infrastructure_failure') if recorded.get(key)]}
                submission = controller / 'submission/answer.json'
                if recorded.get('delivered') or (controller / 'delivery.json').exists():
                    try:
                        item['delivery_verified'] = verify_submission(controller, launch['stage_deadline_ms'], sequence['track'])
                        item['delivery_elapsed_ms'] = read(controller / 'delivery.json').get('elapsed_ms')
                        if item['delivery_verified']: item['submission_sha256'] = digest(submission)
                        else: item['failures'].append('No timely immutable submission verifies.')
                    except (ValueError, KeyError, OSError) as error: item['failures'].append('Submission verification failed: ' + str(error))
                schema = 'engineering-grade/v2' if sequence['track'] == 'engineering' else 'pm-grade/v2'
                if grade.get('schema') == schema:
                    item['grade'] = {'status': 'retained' if item['delivery_verified'] else 'invalid_submission',
                        'passed_checks': grade.get('passed'), 'applicable_checks': grade.get('applicable'),
                        'checks': grade.get('checks', []), 'critical_errors': grade.get('critical_errors', []),
                        'behavioral_pass': grade.get('behavioral_pass') if sequence['track'] == 'engineering' else None,
                        'factual_pass': grade.get('factual_pass') if sequence['track'] == 'pm' else None}
                else: item['grade'] = {'status': 'not_evaluated', 'reason': grade.get('reason', 'No retained grade available.')}
                item['classifier_receipts'] = []
                for file in sorted(controller.glob('classifier-*/receipt.json')):
                    try: item['classifier_receipts'].append({'path': str(file), 'sha256': digest(file), **read(file)})
                    except (ValueError, OSError) as error: item['classifier_receipts'].append({'path': str(file), 'error': str(error)})
                if sequence['track'] == 'pm':
                    item['decision_quality'] = review_for(item, mapping, reviews) if item['delivery_verified'] else {'status': 'not_evaluated', 'reason': 'No verified submission.'}
                report['stages'].append(item)
    return report


def markdown(report):
    lines = ['# Retained teamwork benchmark results', '',
        f"Matrix status: **{report['matrix_state']}**. Development seed 41 is excluded. Missing values remain unknown.", '',
        'PM check totals are automated typed-field/constraint agreement. A failed string match can be correct prose; semantic factual judgments are retained separately with the independent reviews.', '',
        '| Product | Track | Stage | Delivery ms | Process ms | Timing valid | Checks | Critical failures | Decision review |',
        '|---|---|---|---:|---:|---|---|---|---|']
    def cell(value): return 'unknown' if value is None else str(value).replace('|', '\\|').replace('\n', ' ')
    for item in report['stages']:
        grade = item['grade']; checks = f"{grade.get('passed_checks')}/{grade.get('applicable_checks')}" if grade['status'] in ('retained', 'invalid_submission') else 'not evaluated'
        if grade['status'] == 'invalid_submission': checks += ' (invalid artifact)'
        values = [item['arm'], item['track'], item['stage'], item['delivery_elapsed_ms'], item['process_elapsed_ms'], item['timing_valid'],
                  checks, (', '.join(grade.get('critical_errors', [])) or 'none reported') if grade['status'] != 'not_evaluated' else 'not evaluated', item.get('decision_quality', {}).get('status', 'not applicable')]
        lines.append('| ' + ' | '.join(cell(value) for value in values) + ' |')
    lines.extend(['', '## Failures and unavailable arms', ''])
    for arm in report['arms']:
        if arm['status'] == 'unavailable': lines.append(f"- {arm['arm']}: unavailable — {arm['reason']}")
        for track, sequence in arm.get('sequence_statuses', {}).items():
            if sequence.get('error'): lines.append(f"- {arm['arm']}/{track}: {sequence['error']}")
    for item in report['stages']:
        reasons = list(item['failures'])
        if item['status'] == 'not_started': reasons.append('not started')
        if item['session_timed_out']: reasons.append('session timed out; timely delivery, if present, is retained')
        if item['timing_valid'] is False: reasons.append('timing invalid; do not rank this latency')
        if not item['delivery_verified'] and item['status'] != 'not_started': reasons.append('no verified timely delivery')
        if reasons: lines.append(f"- {item['arm']}/{item['track']}/{item['stage']}: " + '; '.join(reasons))
    for exclusion in report['exclusions']: lines.append(f"- Excluded {exclusion['sequence_root']}: {exclusion['reason']}")
    lines.extend(['', '## Usage and native capture', '',
        '| Product | Track | Stage | Input tokens | Cached input | Output tokens | Capture exit | Native receipts |',
        '|---|---|---|---:|---:|---:|---|---:|'])
    for item in report['stages']:
        usage = item['subscription_usage'] or {}; capture = item['native_capture']; process = capture['process'] or {}
        values = [item['arm'], item['track'], item['stage'], usage.get('input_tokens'), usage.get('cached_input_tokens'), usage.get('output_tokens'), process.get('exit_code'), len(capture['receipts'])]
        lines.append('| ' + ' | '.join(cell(value) for value in values) + ' |')
    lines.extend(['', 'Capture receipts, classifier usage, detailed checks and all retained failures are in report.json. Receipt counts are not memory-quality scores. Native capture success and actual successor reuse are separate claims.', ''])
    lines.extend('- ' + limitation for limitation in report['limitations'])
    return '\n'.join(lines) + '\n'


def prepare_reviews(matrix_status, out, authorization, timeout_ms=300000, max_concurrency=2, calibration_artifact=None):
    report = summarize(matrix_status); status, lanes = references(matrix_status)
    candidates = [item for item in report['stages'] if item['track'] == 'pm' and item['delivery_verified']]
    if not candidates: raise ValueError('No verified scored PM submissions available; no review config created.')
    out = Path(out).resolve(); out.mkdir(parents=True, exist_ok=False); out.chmod(0o700)
    launches = {str(Path(entry['root']).resolve()): read(entry['launch']) for lane in lanes for entry in lane.get('sequences', [])}
    cases = []; mapping = []; reviewer_basis = None
    for item in candidates:
        root = Path(item['sequence_root']); launch = launches[str(root)]; sequence = read(root / 'sequence.json'); pack = Path(sequence['pack'])
        rubric = pack / 'controller/scoring/rubric.md'; runtime = Path(launch['runtime'])
        basis = {'runtime': str(runtime), 'runtime_sha256': digest(runtime / 'eval/sequence-codex.js'),
                 'rubric': str(rubric), 'rubric_sha256': digest(rubric), 'model': launch['model'], 'reasoning_effort': launch['reasoning_effort']}
        ca = launch.get('ca_file')
        profile = launch.get('stage_profiles', {}).get(item['stage'])
        if not ca and profile and Path(profile).is_file(): ca = read(profile).get('ca_file')
        if not ca and launch.get('native_config') and Path(launch['native_config']).is_file(): ca = read(launch['native_config']).get('ca_file')
        if ca: basis['ca_file'] = ca
        if reviewer_basis is not None and basis != reviewer_basis: raise ValueError('PM review cases have differing frozen runtime/model/rubric/reasoning/CA')
        reviewer_basis = basis
        case = 'case-' + secrets.token_hex(6); packet = out / 'packets' / case
        answer_file = root / 'stages' / item['stage'] / 'controller/submission/answer.json'
        review_packet(read(answer_file), packet, read(pack / 'agent/pm' / item['stage'] / 'raw-evidence.json'))
        public_form=read(pack / 'agent/pm' / item['stage'] / 'answer-format.json')
        write(packet/'fact-keys.json',list(public_form['facts']))
        packet.chmod(0o700)
        for file in packet.iterdir(): file.chmod(0o600)
        cases.append({'id': case, 'stage': item['stage'], 'packet': str(packet)})
        mapping.append({'case_id': case, 'arm': item['arm'], 'track': 'pm', 'stage': item['stage'],
                        'sequence_root': str(root), 'submission_sha256': item['submission_sha256']})
    config = {'schema': 'pm-review-run/v2', 'execution_authorized': True, 'authorization': authorization,
              **reviewer_basis, 'timeout_ms': timeout_ms, 'max_concurrency': max_concurrency, 'cases': cases}
    if calibration_artifact: config['calibration_artifact'] = str(Path(calibration_artifact).resolve())
    write(out / 'controller-map.json', {'schema': 'pm-review-map/v2', 'cases': mapping})
    write(out / 'review-config.json', config)
    write(out / 'preparation.json', {'model_calls': 0, 'verified_pm_submissions': len(cases), 'source_matrix_status_sha256': digest(matrix_status),
          'review_config': str(out / 'review-config.json'), 'private_map': str(out / 'controller-map.json'),
          'note': 'Inspect anonymization and calibration; no reviewer sessions have run.'})
    return {'prepared_cases': len(cases), 'review_config': str(out / 'review-config.json'), 'private_map': str(out / 'controller-map.json'), 'model_calls': 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__); commands = parser.add_subparsers(dest='command', required=True)
    command = commands.add_parser('report'); command.add_argument('--matrix-status', required=True); command.add_argument('--out', required=True)
    command.add_argument('--reviews'); command.add_argument('--review-map')
    command = commands.add_parser('prepare-reviews'); command.add_argument('--matrix-status', required=True); command.add_argument('--out', required=True)
    command.add_argument('--authorization', required=True); command.add_argument('--timeout-ms', type=int, default=300000)
    command.add_argument('--max-concurrency', type=int, default=2); command.add_argument('--calibration-artifact')
    args = parser.parse_args()
    if args.command == 'report':
        report = summarize(args.matrix_status, args.reviews, args.review_map); out = Path(args.out).resolve(); out.mkdir(parents=True, exist_ok=True)
        write(out / 'report.json', report); temporary = out / '.report.md.tmp'; temporary.write_text(markdown(report)); os.replace(temporary, out / 'report.md')
        print(json.dumps({'report': str(out / 'report.json'), 'markdown': str(out / 'report.md'), 'stages': len(report['stages'])}))
    else: print(json.dumps(prepare_reviews(args.matrix_status, args.out, args.authorization, args.timeout_ms, args.max_concurrency, args.calibration_artifact)))


if __name__ == '__main__': main()
