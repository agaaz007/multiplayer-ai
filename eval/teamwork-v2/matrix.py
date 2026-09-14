"""Preflight an entire frozen comparison, then run one sequential lane per arm."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import threading
import time

from fixtures import ARMS, STAGES, validate

TRACKS = ('engineering', 'pm')
COMPARE_FIELDS = ('model', 'reasoning_effort', 'stage_deadline_ms', 'capture_timeout_ms')


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def absolute_file(value, label):
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise ValueError(label + ' must be an absolute path')
    path = Path(value).resolve()
    if not path.is_file():
        raise ValueError(label + ' must exist: ' + str(path))
    return path


def preflight(config):
    """No runner is called until every ready lane passes these checks."""
    config = Path(config).resolve()
    cfg = read(config)
    if cfg.get('schema') != 'teamwork-matrix/v2':
        raise ValueError('expected teamwork-matrix/v2 schema')
    lanes = cfg.get('arms')
    if not isinstance(lanes, list) or len(lanes) != len(ARMS):
        raise ValueError('represent all six arms; unavailable arms require a reason')
    names = [lane.get('arm') for lane in lanes if isinstance(lane, dict)]
    if len(names) != len(lanes) or set(names) != set(ARMS) or len(set(names)) != len(names):
        raise ValueError('each expected arm must appear exactly once')
    workers = cfg.get('max_workers', 6)
    if type(workers) is not int or not 1 <= workers <= 6:
        raise ValueError('max_workers must be an integer from 1 to 6')
    roots = set()
    comparisons = {}
    shared_budget = None
    allowance = None
    checked = []
    for lane in lanes:
        arm = lane['arm']
        if lane.get('status') == 'unavailable':
            if not isinstance(lane.get('reason'), str) or not lane['reason'].strip() or lane.get('sequences'):
                raise ValueError(arm + ': unavailable needs a reason and no runnable sequences')
            checked.append({'arm': arm, 'status': 'unavailable', 'reason': lane['reason'], 'sequences': []})
            continue
        if lane.get('status', 'ready') != 'ready':
            raise ValueError(arm + ': unknown readiness status')
        entries = lane.get('sequences')
        if not isinstance(entries, list) or len(entries) != 2:
            raise ValueError(arm + ': both engineering and PM sequences required')
        by_track = {}
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get('root'), str) or not Path(entry['root']).is_absolute():
                raise ValueError(arm + ': root must be an absolute path')
            root = Path(entry['root']).resolve()
            if root in roots:
                raise ValueError('duplicate sequence root: ' + str(root))
            roots.add(root)
            state_path = root / 'sequence.json'
            state = read(state_path)
            track = state.get('track')
            if state.get('schema') != 'teamwork-sequence/v2' or state.get('arm') != arm or track not in TRACKS or track in by_track:
                raise ValueError(arm + ': invalid/duplicate arm-track sequence')
            if state.get('executed') is not False or state.get('status') != 'prepared' or state.get('stages'):
                raise ValueError(arm + ': sequence already attempted or not freshly prepared')
            pack = Path(state['pack']).resolve()
            validate(pack)
            pack_hash = digest(pack / 'manifest.json')
            if pack_hash != state.get('pack_manifest_sha256'):
                raise ValueError(arm + ': pack freeze changed')
            for name, expected in state.get('driver_hashes', {}).items():
                if digest(Path(__file__).with_name(name)) != expected:
                    raise ValueError(arm + ': driver/grader changed: ' + name)
            launch_path = absolute_file(entry.get('launch'), arm + ' launch')
            launch = read(launch_path)
            if launch.get('execution_authorized') is not True or not launch.get('authorization'):
                raise ValueError(arm + ': execution authorization required')
            amount = launch.get('maximum_approved_usd')
            if launch.get('paid_paths_gated') is not True or type(amount) not in (int, float) or not 0 < amount < float('inf'):
                raise ValueError(arm + ': gated paid paths and positive allowance required')
            if allowance is None:
                allowance = amount
            elif amount != allowance:
                raise ValueError('all launches must share the same monetary allowance')
            budget = absolute_file(launch.get('budget_file'), arm + ' budget_file')
            if shared_budget is None:
                shared_budget = budget
            elif budget != shared_budget:
                raise ValueError('all launches must share one canonical budget_file')
            if not isinstance(launch.get('runtime'), str) or not Path(launch['runtime']).is_absolute() or not Path(launch['runtime']).is_dir():
                raise ValueError(arm + ': frozen runtime directory required')
            for key in ('model', 'reasoning_effort'):
                if not isinstance(launch.get(key), str) or not launch[key]:
                    raise ValueError(arm + ': freeze ' + key)
            for key in ('stage_deadline_ms', 'capture_timeout_ms'):
                if type(launch.get(key)) is not int or launch[key] <= 0:
                    raise ValueError(arm + ': positive integer ' + key + ' required')
            profiles = launch.get('stage_profiles')
            if not isinstance(profiles, dict) or any(not isinstance(profiles.get(stage), str) or not Path(profiles[stage]).is_absolute() for stage in STAGES):
                raise ValueError(arm + ': absolute native profiles for A-D required')
            # Dynamic stage preparation may create profiles just before the stage.
            if not launch.get('stage_profile_argv'):
                for stage in STAGES:
                    absolute_file(profiles[stage], arm + ' profile ' + stage)
            comparison = {'pack_manifest_sha256': pack_hash, **{key: launch[key] for key in COMPARE_FIELDS}}
            if track not in comparisons:
                comparisons[track] = comparison
            elif comparisons[track] != comparison:
                raise ValueError(track + ': mismatched frozen pack, model, reasoning, or limits')
            by_track[track] = {'track': track, 'root': str(root), 'launch': str(launch_path),
                               'launch_sha256': digest(launch_path), 'state_sha256': digest(state_path)}
        checked.append({'arm': arm, 'status': 'ready', 'sequences': [by_track[track] for track in TRACKS]})
    return {'schema': 'teamwork-matrix-preflight/v2', 'config': str(config), 'config_sha256': digest(config),
            'max_workers': workers, 'budget_file': str(shared_budget) if shared_budget else None,
            'maximum_approved_usd': allowance, 'comparisons': comparisons, 'arms': checked}


def run(config, out, runner=None):
    plan = preflight(config)
    out = Path(out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    if runner is None:
        from sequence import run as runner
    start = time.monotonic()
    lock = threading.Lock()
    state = {'schema': 'teamwork-matrix-run/v2', 'status': 'running', 'preflight': plan,
             'arms': {lane['arm']: {'status': 'unavailable', 'reason': lane['reason'], 'sequences': {}}
                      if lane['status'] == 'unavailable' else {'status': 'queued', 'sequences': {}}
                      for lane in plan['arms']}}

    def write():
        state['elapsed_seconds'] = time.monotonic() - start
        temporary = out / '.status.json.tmp'
        temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + '\n')
        os.replace(temporary, out / 'status.json')

    with lock:
        write()

    def lane_run(lane):
        arm = lane['arm']
        with lock:
            state['arms'][arm]['status'] = 'running'; write()
        for sequence in lane['sequences']:
            track = sequence['track']
            begun = time.monotonic()
            with lock:
                state['arms'][arm]['sequences'][track] = {'status': 'running', 'root': sequence['root']}; write()
            try:
                if digest(sequence['launch']) != sequence['launch_sha256'] or digest(Path(sequence['root']) / 'sequence.json') != sequence['state_sha256']:
                    raise ValueError('launch or sequence changed after matrix preflight')
                result = runner(sequence['root'], sequence['launch'])
                failed = [stage for stage, data in result.get('stages', {}).items() if data.get('status') == 'failed']
                outcome = {'status': 'finished_with_failures' if failed else 'finished',
                           'sequence_status': result.get('status'), 'failed_stages': failed}
            except Exception as error:
                outcome = {'status': 'failed', 'error': str(error)[:2000]}
            with lock:
                state['arms'][arm]['sequences'][track].update(outcome, elapsed_seconds=time.monotonic() - begun)
                write()
        with lock:
            state['arms'][arm]['status'] = 'finished_with_failures' if any(
                item['status'] != 'finished' for item in state['arms'][arm]['sequences'].values()) else 'finished'
            write()

    ready = [lane for lane in plan['arms'] if lane['status'] == 'ready']
    with concurrent.futures.ThreadPoolExecutor(max_workers=plan['max_workers']) as pool:
        futures = [pool.submit(lane_run, lane) for lane in ready]
        for future in concurrent.futures.as_completed(futures):
            future.result()
    with lock:
        state['status'] = 'ended'; write()
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    command = sub.add_parser('run')
    command.add_argument('--config', required=True); command.add_argument('--out', required=True)
    args = parser.parse_args()
    result = run(args.config, args.out)
    print(json.dumps({'status': result['status'], 'out': str(Path(args.out).resolve()),
                      'arms': {name: data['status'] for name, data in result['arms'].items()}}, indent=2))


if __name__ == '__main__':
    main()
