"""Native-only successor transport. No model/provider calls during preparation.

The controller releases the identical initial repository plus one stage's delta.
It never reads a predecessor tree to construct a successor. Product-owned stores
may retain originals; only the successor's native tools may restore them.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import time
import contextvars
import disk_budget
import integrity

_DISK_LEASE = contextvars.ContextVar("teamwork_disk_lease", default=None)

RESERVED = {'.git', '.codex', '.claude', '.ledger', 'node_modules', '__pycache__', '.venv'}


def digest(path):
    hasher = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def load(path):
    return json.loads(Path(path).read_text())


def dump(path, value, exclusive=False):
    path = Path(path)
    if exclusive:
        with path.open('x') as stream:
            stream.write(json.dumps(value, indent=2, sort_keys=True) + '\n')
        path.chmod(0o600)
    else:
        temporary = path.with_name(path.name + '.tmp')
        with temporary.open('w') as stream:
            stream.write(json.dumps(value, indent=2, sort_keys=True) + '\n')
        temporary.chmod(0o600)
        temporary.replace(path)


def inventory(root, exclude_root=(), released=False):
    """Reject links and special files; no silent filtering of released inputs."""
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('expected regular directory: ' + str(root))
    result = {}
    for base, directories, files in os.walk(root, followlinks=False):
        for name in list(directories) + files:
            path = Path(base) / name
            if Path(base) == root and name in exclude_root:
                if path.is_symlink():
                    raise ValueError('excluded root is a symlink: ' + str(path))
                if name in directories:
                    directories.remove(name)
                continue
            mode = path.lstat().st_mode
            if not stat.S_ISDIR(mode) and not stat.S_ISREG(mode):
                raise ValueError('symlinks/special files forbidden: ' + str(path))
            if released and (name in RESERVED or name.startswith('.env')):
                raise ValueError('reserved released input: ' + str(path))
            if stat.S_ISREG(mode):
                result[path.relative_to(root).as_posix()] = digest(path)
    return dict(sorted(result.items()))


def contained(root, relative):
    root = Path(root).resolve(strict=True)
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise ValueError('pack paths must be relative')
    path = root / relative
    if '..' in Path(relative).parts or path.is_symlink():
        raise ValueError('unsafe pack path: ' + relative)
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root):
        raise ValueError('pack path escapes root: ' + relative)
    return resolved


def validate_pack(pack):
    pack = Path(pack).resolve(strict=True)
    manifest = load(pack / 'manifest.json')
    if manifest.get('schema') != 'teamwork-pack/v3':
        raise ValueError('expected teamwork-pack/v3')
    if type(manifest.get('development', False)) is not bool:
        raise ValueError('development must be an explicit boolean')
    if inventory(pack, exclude_root={'manifest.json'}) != manifest.get('files'):
        raise ValueError('pack file inventory changed')
    initial = contained(pack, manifest['initial_repo_dir'])
    initial_files = inventory(initial, released=True)
    stages = manifest.get('stages')
    if not isinstance(stages, list) or not stages:
        raise ValueError('nonempty stages required')
    identifiers = set()
    for stage in stages:
        name = stage.get('id')
        if not isinstance(name, str) or not re.fullmatch('[A-Za-z0-9_-]+', name) or name in identifiers:
            raise ValueError('unique safe stage IDs required')
        identifiers.add(name)
        deadline = stage.get('deadline_ms')
        if type(deadline) is not int or deadline <= 0:
            raise ValueError('positive integer deadline_ms required')
        delta = contained(pack, stage['delta_dir'])
        if initial == delta or initial.is_relative_to(delta) or delta.is_relative_to(initial):
            raise ValueError('initial and delta directories overlap')
        delta_files = inventory(delta, released=True)
        for left in initial_files:
            for right in delta_files:
                if left == right or left.startswith(right + '/') or right.startswith(left + '/'):
                    raise ValueError('delta collides with initial repository: ' + right)
        if not contained(pack, stage['prompt_file']).is_file():
            raise ValueError('prompt must be a regular file')
    return manifest


def prepare(pack, out, track, arm):
    pack = Path(pack).resolve(strict=True)
    manifest = validate_pack(pack)
    if manifest.get('track') != track or arm not in manifest.get('arms', []):
        raise ValueError('arm/track not in pack')
    out = Path(out).resolve()
    if out.is_relative_to(pack) or pack.is_relative_to(out):
        raise ValueError('sequence and pack roots must be disjoint')
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    (out / 'controller-canary').write_text(os.urandom(32).hex())
    for stage in manifest['stages']:
        for name in ['home', 'worktree', 'controller']:
            (out / 'stages' / stage['id'] / name).mkdir(parents=True)
        (out / 'stages' / stage['id'] / 'home' / 'foreign-canary').write_text(os.urandom(32).hex())
    state = {'schema': 'teamwork-sequence/v3', 'pack': str(pack), 'arm': arm, 'track': track,
             'development': manifest.get('development', False),
             'pack_manifest_sha256': digest(pack / 'manifest.json'),
             'transport_sha256': digest(__file__), 'executed': False, 'status': 'prepared', 'stages': {}}
    dump(out / 'sequence.json', state, exclusive=True)
    return state


def copy_inputs(source, destination):
    for name in inventory(source, released=True):
        original, target = Path(source) / name, Path(destination) / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(original.read_bytes())
        target.chmod(original.stat().st_mode & 0o777)


def git(work, *args):
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull,
               GIT_TERMINAL_PROMPT='0')
    return subprocess.run(['git', '-c', 'core.hooksPath=' + os.devnull, '-C', str(work), *args],
                          env=env, check=True, capture_output=True, text=True).stdout.strip()


def stage_workspace(pack, stage, work, controller):
    """The only ordinary file transport into any task workspace."""
    pack, work, controller = Path(pack), Path(work), Path(controller)
    manifest = validate_pack(pack)
    if any(work.iterdir()):
        raise ValueError('successor worktree must be empty')
    initial = contained(pack, manifest['initial_repo_dir'])
    delta = contained(pack, stage['delta_dir'])
    copy_inputs(initial, work)
    copy_inputs(delta, work)
    expected = inventory(work)
    git(work, 'init', '-q', '--initial-branch=main')
    git(work, 'add', '-A')
    git(work, '-c', 'user.name=benchmark-controller', '-c', 'user.email=controller@evaluation.invalid',
        'commit', '-q', '--allow-empty', '-m', 'Initial repository and current stage delta only')
    receipt = {'schema': 'teamwork-input-transport/v3', 'stage': stage['id'],
               'initial_repo_files': inventory(initial, released=True),
               'current_delta_files': inventory(delta, released=True), 'released_files': expected,
               'source_policy': 'initial repository + current delta; no predecessor-derived controller transfer',
               'initial_git_head': git(work, 'rev-parse', 'HEAD'),
               'initial_git_commit_count': int(git(work, 'rev-list', '--count', 'HEAD'))}
    dump(controller / 'transport.json', receipt, exclusive=True)
    return receipt


def verify_submission(controller, deadline_ms, track=None):
    controller = Path(controller)
    answer, receipt_file = controller / 'submission/answer.json', controller / 'delivery.json'
    if not answer.exists() or not receipt_file.exists():
        return False
    if answer.is_symlink() or receipt_file.is_symlink():
        raise ValueError('submission receipt/answer must be regular files')
    receipt = load(receipt_file)
    elapsed = receipt.get('elapsed_ms')
    if type(elapsed) not in (int, float) or not math.isfinite(elapsed) or not 0 <= elapsed <= deadline_ms:
        return False
    if digest(answer) != receipt.get('answer_file_sha256'):
        raise ValueError('submitted answer changed')
    # PM intermediate artifacts matter as much as engineering source code in v3.
    expected = (receipt.get('tree') or {}).get('files')
    if not isinstance(expected, dict) or inventory(controller / 'submission/tree') != expected:
        raise ValueError('submitted tree changed or missing (required for every track)')
    return True


def overlap(left, right):
    return left == right or left.is_relative_to(right) or right.is_relative_to(left)


def validate_profile(profile, request, protected):
    if profile.get('arm') != request['arm']:
        raise ValueError('native profile arm mismatch')
    if profile.get('readiness_verified') is not True or profile.get('paid_paths_gated') is not True:
        raise ValueError('native readiness and executable budget gating required')
    if request['arm'] != 'fresh-agent':
        module = profile.get('budget_gate_module')
        if not module or not Path(module).is_file() or not profile.get('budget_file'):
            raise ValueError('executable native budget gate and shared budget file required')
    for key in ['read_paths', 'write_paths']:
        for item in profile.get(key, []):
            path = Path(item).resolve(strict=True)
            if any(overlap(path, Path(blocked).resolve()) for blocked in protected):
                raise ValueError('native path grants private/previous task access: ' + str(path))


def descendant_processes(pid):
    rows = subprocess.run(['ps', '-axo', 'pid=,ppid='], check=True, capture_output=True, text=True).stdout.splitlines()
    parents = {int(parts[0]): int(parts[1]) for row in rows if len(parts := row.split()) == 2}
    owned = {pid}
    while True:
        found = {child for child, parent in parents.items() if parent in owned}
        if found.issubset(owned):
            return owned
        owned.update(found)


GIB = 1024 ** 3
SEQUENCE_MIN_FREE_BYTES = 2 * GIB
RUNTIME_MIN_FREE_BYTES = GIB
DISK_POLL_SECONDS = 2


class DiskSpaceError(RuntimeError):
    def __init__(self, receipt):
        self.receipt = receipt
        super().__init__('insufficient disk space during ' + receipt['phase'] + ': '
                         + str(receipt['free_bytes']) + ' bytes free, '
                         + str(receipt['required_bytes']) + ' required')


def check_disk_space(path, required_bytes, phase):
    active = _DISK_LEASE.get()
    if active is not None:
        active[0].guard(active[1])
    receipt = {'path': str(Path(path).resolve()), 'free_bytes': shutil.disk_usage(path).free,
               'required_bytes': required_bytes, 'phase': phase, 'checked_at_unix': time.time()}
    if receipt['free_bytes'] < required_bytes:
        raise DiskSpaceError(receipt)
    return receipt


def stop_owned_process_tree(proc):
    # The subprocess handle identifies the root we spawned; ps verifies descendants
    # before termination, including children that created separate process groups.
    owned = descendant_processes(proc.pid)
    for pid in sorted(owned, reverse=True):
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    try:
        code = proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        code = None
    for pid in sorted(owned, reverse=True):
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    return proc.wait(timeout=5) if code is None else code


def run_command(argv, cwd, limit_seconds, stdout_file):
    if not isinstance(argv, list) or not argv or not all(isinstance(x, str) for x in argv):
        raise ValueError('argv must be a nonempty string array')
    check_disk_space(cwd, RUNTIME_MIN_FREE_BYTES, 'subprocess admission')
    started = time.monotonic()
    with Path(stdout_file).open('xb') as log:
        proc = subprocess.Popen(argv, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        timed_out = False
        try:
            while True:
                check_disk_space(cwd, RUNTIME_MIN_FREE_BYTES, 'subprocess runtime')
                remaining = limit_seconds - (time.monotonic() - started)
                if remaining <= 0:
                    timed_out = True
                    code = stop_owned_process_tree(proc)
                    break
                try:
                    code = proc.wait(timeout=min(DISK_POLL_SECONDS, remaining))
                    break
                except subprocess.TimeoutExpired:
                    continue
        except BaseException as error:
            code = stop_owned_process_tree(proc)
            if isinstance(error, (DiskSpaceError, disk_budget.DiskReservationError)):
                error.receipt['process'] = {'pid': proc.pid, 'exit_code': code,
                                            'owned_tree_terminated': True,
                                            'elapsed_seconds': time.monotonic() - started}
            raise
    elapsed = time.monotonic() - started
    return {'exit_code': code, 'timed_out': timed_out, 'elapsed_seconds': elapsed,
            'timing_valid': elapsed <= limit_seconds + 5}


def expand(argv, request):
    if not isinstance(argv, list) or not argv or not all(isinstance(x, str) for x in argv):
        raise ValueError('argv must be a nonempty string array')
    return [x.replace('{request}', str(request)) for x in argv]


def run(root, launch, disk_lease=None):
    root = Path(root).resolve(strict=True)
    state, cfg = load(root / 'sequence.json'), load(launch)
    if state['executed'] or (root / 'attempt.json').exists():
        raise ValueError('sequence already attempted; preserve it and explicitly authorize a new root')
    pack = Path(state['pack'])
    manifest = validate_pack(pack)
    if digest(pack / 'manifest.json') != state['pack_manifest_sha256'] or digest(__file__) != state['transport_sha256']:
        raise ValueError('prepared pack/transport freeze changed')
    if cfg.get('execution_authorized') is not True or not cfg.get('authorization'):
        raise ValueError('explicit live execution authorization required')
    if cfg.get('paid_paths_gated') is not True or not 0 < cfg.get('maximum_approved_usd', 0) <= 30:
        raise ValueError('existing shared budget ceiling, at most USD30, required')
    if not Path(cfg.get('budget_file', '')).is_file():
        raise ValueError('existing shared budget file required; allowance is not reset')
    for key in ['runtime', 'model', 'reasoning_effort', 'driver_argv', 'capture_timeout_ms', 'frozen_files']:
        if not cfg.get(key):
            raise ValueError('freeze ' + key)
    if type(cfg['capture_timeout_ms']) is not int or cfg['capture_timeout_ms'] <= 0:
        raise ValueError('positive capture deadline required')
    for name, expected in cfg['frozen_files'].items():
        if digest(name) != expected:
            raise ValueError('frozen runtime/controller input changed: ' + name)
    frozen_paths = {Path(name).resolve() for name in cfg['frozen_files']}
    for argument in cfg['driver_argv'][1:]:
        if Path(argument).is_file() and Path(argument).resolve() not in frozen_paths:
            raise ValueError('driver script/input missing from frozen_files: ' + argument)
    if '{request}' not in cfg['driver_argv']:
        raise ValueError('driver argv requires standalone {request}')
    if not all(stage['id'] in cfg.get('stage_profiles', {}) for stage in manifest['stages']):
        raise ValueError('fresh native profiles required for every stage')
    disk_admission = check_disk_space(root, SEQUENCE_MIN_FREE_BYTES, 'sequence admission')
    own_lease = disk_lease is None
    lease = disk_lease or disk_budget.reserve(cfg.get('disk_plan'), [{'root':str(root),'arm':state['arm'],'track':state['track']}])
    active = False
    try:
        lease.start(root); active = True
        token = _DISK_LEASE.set((lease,root))
        try:
            return _execute(root, launch, state, cfg, pack, manifest, disk_admission)
        finally:
            _DISK_LEASE.reset(token)
    finally:
        if active: lease.complete(root)
        if own_lease: lease.release()


def _execute(root, launch, state, cfg, pack, manifest, disk_admission):
    # Exclusive creation also prevents concurrent dispatchers from rerunning this root.
    dump(root / 'attempt.json', {'launch_sha256': digest(launch), 'started_at_unix': time.time()}, exclusive=True)
    state.update(executed=True, status='running', development=manifest.get('development', False),
                 disk_admission=disk_admission)
    dump(root / 'sequence.json', state)
    for stage in manifest['stages']:
        name = stage['id']
        base = root / 'stages' / name
        work, home, ctl = base / 'worktree', base / 'home', base / 'controller'
        result = {'status': 'started'}
        state['stages'][name] = result
        dump(root / 'sequence.json', state)
        try:
            integrity.check(root,cfg)
            check_disk_space(root, RUNTIME_MIN_FREE_BYTES, 'stage admission')
            transport = stage_workspace(pack, stage, work, ctl)
            prompt = contained(pack, stage['prompt_file']).read_text()
            (ctl / 'prompt.txt').write_text(prompt)
            other_stages = [root / 'stages' / s['id'] for s in manifest['stages'] if s['id'] != name]
            protected = [pack, ctl, root / 'sequence.json', root / 'attempt.json', root / 'controller-canary', *other_stages]
            canaries = [str(root / 'controller-canary')]
            canaries += [str(s / 'home/foreign-canary') for s in other_stages]
            if len(canaries) < 2:
                (ctl / 'foreign-canary').write_text(os.urandom(32).hex())
                canaries.append(str(ctl / 'foreign-canary'))
            request = {'schema': 'teamwork-stage-request/v3', 'workspace': str(work), 'fresh_home': str(home),
                       'controller_output_dir': str(ctl), 'prompt_file': str(ctl / 'prompt.txt'),
                       'runtime': str(Path(cfg['runtime']).resolve()),
                       'native_profile': str(Path(cfg['stage_profiles'][name]).resolve()),
                       'arm': state['arm'], 'track': state['track'], 'stage': name,
                       'model': cfg['model'], 'reasoning_effort': cfg['reasoning_effort'],
                       'stage_deadline_ms': stage['deadline_ms'], 'execution_authorized': True,
                       'authorization': cfg['authorization'],
                       'development_probe': manifest.get('development', False),
                       'scored': not manifest.get('development', False),
                       'native_config': cfg.get('native_config'), 'periodic_capture_argv': cfg.get('periodic_capture_argv'),
                       'forbidden_canaries': canaries, 'forbidden_paths': [str(p) for p in protected],
                       'transport_receipt': str(ctl / 'transport.json'), 'snapshot_all_tracks': True,
                       'stress': stage.get('stress')}
            request_file = ctl / 'request.json'
            dump(request_file, request, exclusive=True)
            if cfg.get('stage_profile_argv'):
                result['native_preparation'] = run_command(expand(cfg['stage_profile_argv'], request_file), root,
                                                          cfg['capture_timeout_ms'] / 1000, ctl / 'native-preparation.log')
                if result['native_preparation']['exit_code'] != 0 or result['native_preparation']['timed_out']:
                    raise ValueError('native preparation failed')
            if inventory(work, exclude_root={'.git'}) != transport['released_files']:
                raise ValueError('native preparation populated/changed task workspace; recovery must be agent initiated')
            if git(work, 'rev-list', '--count', 'HEAD') != '1' or git(work, 'rev-parse', 'HEAD') != transport['initial_git_head']:
                raise ValueError('native preparation changed initial Git history')
            profile = load(request['native_profile'])
            validate_profile(profile, request, protected)
            if state['arm'] != 'fresh-agent' and Path(profile['budget_file']).resolve() != Path(cfg['budget_file']).resolve():
                raise ValueError('native profile uses a different budget file')
            result['driver'] = run_command(expand(cfg['driver_argv'], request_file), root,
                                           stage['deadline_ms'] / 1000 + 15, ctl / 'driver.log')
            integrity.check(root,cfg)
            if (ctl / 'stage-result.json').exists():
                result['session'] = load(ctl / 'stage-result.json')
            result['timing_valid'] = result['driver']['timing_valid'] and result.get('session', {}).get('timing_valid', False)
            result['delivered'] = verify_submission(ctl, stage['deadline_ms'])
            result['grade'] = {'status': 'not_evaluated', 'reason': 'grade retained immutable artifacts separately'}
            if cfg.get('capture_argv', {}).get(name):
                result['capture'] = run_command(expand(cfg['capture_argv'][name], request_file), root,
                                                cfg['capture_timeout_ms'] / 1000, ctl / 'capture.log')
            else:
                result['capture'] = {'status': 'not_evaluated', 'reason': 'native capture receipt absent'}
            integrity.check(root,cfg)
            # Native capture must not rewrite the evidence being graded.
            if result['delivered']:
                verify_submission(ctl, stage['deadline_ms'])
            result['status'] = 'finished'
        except integrity.FreezeError as error:
            result.update(status='failed',error=str(error))
            state.update(status='infrastructure_aborted',infrastructure_abort={'reason':'freeze/intervention violation','error':str(error)})
            dump(root/'sequence.json',state)
            return state
        except (DiskSpaceError, disk_budget.DiskReservationError) as error:
            result.update(status='failed', error=str(error), infrastructure_abort=error.receipt)
            state.update(status='infrastructure_aborted', infrastructure_abort=error.receipt,
                         cleanup='owned process tree terminated; capture and export skipped; artifacts retained')
            dump(root / 'sequence.json', state)
            return state
        except Exception as error:
            result.update(status='failed', error=str(error)[:2000])
        dump(root / 'sequence.json', state)
    state['status'] = 'ended'
    if cfg.get('export_argv'):
        try:
            state['export'] = run_command(cfg['export_argv'], root, cfg['capture_timeout_ms'] / 1000, root / 'export.log')
        except (DiskSpaceError, disk_budget.DiskReservationError) as error:
            state.update(status='infrastructure_aborted', infrastructure_abort=error.receipt,
                         cleanup='owned process tree terminated; export aborted; artifacts retained')
            dump(root / 'sequence.json', state)
            return state
    state['cleanup'] = 'native export receipts retained; stores not silently deleted'
    dump(root / 'sequence.json', state)
    return state


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prep = commands.add_parser('prepare')
    for flag in ['pack', 'out', 'track', 'arm']:
        prep.add_argument('--' + flag, required=True)
    execute = commands.add_parser('run')
    execute.add_argument('--root', required=True)
    execute.add_argument('--launch', required=True)
    args = parser.parse_args()
    result = prepare(args.pack, args.out, args.track, args.arm) if args.command == 'prepare' else run(args.root, args.launch)
    print(json.dumps(result, indent=2))
    if result.get('status') == 'infrastructure_aborted' or any(s.get('status') == 'failed' for s in result.get('stages', {}).values()):
        raise SystemExit(1)
