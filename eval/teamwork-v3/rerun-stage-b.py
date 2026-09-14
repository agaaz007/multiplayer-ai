"""Stage-B-only rerun from ONE frozen Ledger stage-A tree: Ledger-as-configured vs no-memory control.

Purpose (dec-20260913-ship-capture-safety-fixes-then-continuity-featur-n12l,
fnd-20260913-ledger-s-engineering-check-failures-were-respons-dwoi): the v3 Ledger
stage-B agent omitted `receipt_id` on GET /jobs/ID and C/D inherited it. Whether Ledger
context RAISES that response-shape omission rate is unsettled. This tool runs fresh
stage-B sessions per arm from identical code and scores response shape deterministically.

HOW THIS DIFFERS FROM THE PRIMARY v3 PROTOCOL (sequence.stage_workspace), AND WHY
  Primary: every stage workspace is `initial repository + current stage delta` only; the
  successor must recover the predecessor's work through the memory product. That makes
  code recovery part of what is measured, so a no-memory control could not even see A.
  Here: every session's workspace is `A's frozen immutable submission tree + the B stage
  delta` (same file transport rules: regular files only, reserved names rejected, one
  fresh Git commit, receipt written). Both arms therefore see byte-identical code, and
  the ONLY difference between arms is memory context: the Ledger arm gets a per-session
  clone of A's native store (hooks, MCP, guide, periodic capture as configured); the
  control gets no memory servers and no hooks. This isolates the attribution question
  and is not a continuity measurement.

STORE FREEZE
  The source root's store was written by stages A-D. Each Ledger session receives a
  Postgres clone (`CREATE DATABASE ... TEMPLATE <source>`) that is then trimmed to the
  state at A's final capture (rows from other stage homes and rows created after the
  cutoff are deleted in the CLONE only; confirmations after the cutoff are reverted).
  The bare WIP remote and the markdown object store are cloned and trimmed the same way.
  The source database, remote and files are never modified. In-place mutations of A's
  rows by later stages (e.g. version counters) cannot be undone; see the trim receipt.

No model or provider call happens in `prepare` or `score`. `run` launches sessions only
when `execution_authorized` is true (set exclusively through `--authorize "<text>"`).
"""
import argparse
import datetime as _dt
import hashlib
import importlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import sequence  # noqa: E402  (frozen v3 transport helpers; imported, not copied)

V2 = HERE.parent / 'teamwork-v2'
SCHEMA = 'teamwork-stage-b-rerun/v1'
TRACK = 'engineering'
PREDECESSOR, STAGE = 'A', 'B'
ARMS = ('ledger', 'fresh-agent')
DEFAULT_MODEL, DEFAULT_EFFORT = 'gpt-5.6-sol', 'medium'
HISTORICAL_CHECKS = ('execution-receipt-and-restart-replay', 'concurrent-execution-single-effect',
                     'unknown-outcome-reconciliation')
LEDGER_DB = re.compile(r'^ledger_native_[a-f0-9]{24}$')
SAFE_DB = re.compile(r'^[a-z0-9_]{1,63}$')
CONTROL_GUIDE = ('This is a no-memory control. Read current workspace task inputs and raw evidence. '
                 'No native memory service is available. Deliver the task answer through deliver_answer '
                 'as soon as ready. Do not invent predecessor conclusions or memory operations.\n')
PROTOCOL_NOTE = ('Stage-B-only rerun. Workspace = predecessor A immutable submission tree + B stage delta '
                 '(NOT initial repo + delta as in sequence.stage_workspace): both arms must see identical '
                 'code so the only difference is memory context. Ledger sessions use per-session clones of '
                 "A's store trimmed to A's final-capture cutoff; control sessions have no memory servers or hooks.")
# Child tables first so foreign keys never block a delete; unknown cont_* tables go before parents.
TRIM_ORDER = ['cont_events', 'cont_checkpoints', 'cont_claims', 'cont_record_links', 'cont_state_updates',
              'cont_artifacts', 'cont_notifications']
TRIM_PARENTS = ['cont_sessions', 'cont_threads', 'cont_records']

load, dump, digest, inventory = sequence.load, sequence.dump, sequence.digest, sequence.inventory


def now():
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def sql_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def ident(name):
    if not SAFE_DB.fullmatch(name):
        raise ValueError('unsafe SQL identifier: ' + name)
    return '"' + name + '"'


# --------------------------------------------------------------------------- Postgres (psql CLI)
def psql(url, sql, *, script=False):
    argv = ['psql', url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-A', '-t']
    argv += ['-f', '-'] if script else ['-c', sql]
    result = subprocess.run(argv, input=sql if script else None, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError('psql failed: ' + result.stderr.strip()[:1500])
    return result.stdout


def database_url(admin_url, name):
    parts = urllib.parse.urlsplit(admin_url)
    if parts.scheme not in ('postgresql', 'postgres') or parts.hostname not in ('127.0.0.1', 'localhost') or parts.password:
        raise ValueError('native Ledger store must be an uncredentialed localhost database')
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, '/' + name, '', ''))


def database_exists(admin_url, name):
    return psql(admin_url, 'select 1 from pg_database where datname=' + sql_quote(name)).strip() == '1'


def clone_database(admin_url, source_name, clone_name, nonce):
    """CREATE DATABASE clone TEMPLATE source; the source is only read by the server-side copy."""
    for name in (source_name, clone_name):
        if not SAFE_DB.fullmatch(name):
            raise ValueError('unsafe database name: ' + name)
    if source_name == clone_name:
        raise ValueError('clone must not be the source database')
    if not database_exists(admin_url, source_name):
        raise ValueError('source store database missing: ' + source_name)
    if database_exists(admin_url, clone_name):
        raise ValueError('clone database already exists: ' + clone_name)
    psql(admin_url, 'create database ' + ident(clone_name) + ' template ' + ident(source_name))
    psql(admin_url, 'comment on database ' + ident(clone_name) + ' is ' + sql_quote(nonce))
    return database_url(admin_url, clone_name)


def drop_database(admin_url, name):
    if not SAFE_DB.fullmatch(name):
        raise ValueError('unsafe database name: ' + name)
    psql(admin_url, 'drop database if exists ' + ident(name))


def introspect(url):
    rows = psql(url, "select table_name||'|'||column_name from information_schema.columns "
                     "where table_schema='public' and table_name like 'cont\\_%' order by 1").split('\n')
    schema = {}
    for row in rows:
        if '|' in row:
            table, column = row.split('|', 1)
            schema.setdefault(table, set()).add(column)
    return schema


def table_counts(url, tables):
    counts = {}
    for table in tables:
        counts[table] = int(psql(url, 'select count(*) from ' + ident(table)).strip() or 0)
    return counts


def trim_sql(schema, kept_home, cutoff):
    """SQL that deletes, inside ONE clone, everything not attributable to the kept stage home at the cutoff."""
    if 'cont_sessions' not in schema or 'transcript_path' not in schema['cont_sessions']:
        raise ValueError('clone lacks cont_sessions.transcript_path; cannot attribute rows to a stage')
    like = sql_quote(kept_home.rstrip('/') + '/%')
    cut = sql_quote(cutoff) + '::timestamptz'
    lines = ['begin;',
             'create temporary table rerun_removed_sessions as select id from cont_sessions '
             'where transcript_path is null or transcript_path not like ' + like + ';']
    others = [t for t in sorted(schema) if t not in TRIM_ORDER and t not in TRIM_PARENTS]
    for table in TRIM_ORDER + others:
        columns = schema.get(table)
        if not columns:
            continue
        conditions = []
        if 'session_id' in columns:
            conditions.append('session_id in (select id from rerun_removed_sessions)')
        for column in ('created_at', 'acquired_at', 'received_at', 'occurred_at'):
            if column in columns:
                conditions.append(column + ' > ' + cut)
                break
        if conditions:
            lines.append('delete from ' + ident(table) + ' where ' + ' or '.join(conditions) + ';')
    lines.append('delete from cont_sessions where id in (select id from rerun_removed_sessions);')
    for table in ('cont_threads', 'cont_records'):
        if table in schema and 'created_at' in schema[table]:
            lines.append('delete from ' + ident(table) + ' where created_at > ' + cut + ';')
    updates = schema.get('cont_state_updates', set())
    if {'status', 'confirmed_at', 'confirmed_by'} <= updates:
        lines.append("update cont_state_updates set status='proposed', confirmed_at=null, confirmed_by=null "
                     'where confirmed_at > ' + cut + ';')
    if {'status', 'rejected_at', 'rejected_by'} <= updates:
        lines.append("update cont_state_updates set status='proposed', rejected_at=null, rejected_by=null"
                     + (', reject_reason=null' if 'reject_reason' in updates else '') + ' where rejected_at > ' + cut + ';')
    for table, columns in sorted(schema.items()):
        if 'updated_at' in columns:
            lines.append('update ' + ident(table) + ' set updated_at=least(updated_at, ' + cut + ');')
    lines.append('commit;')
    return '\n'.join(lines) + '\n'


def trim_clone(clone_url, source_name, kept_home, cutoff):
    if urllib.parse.urlsplit(clone_url).path == '/' + source_name:
        raise ValueError('refusing to trim the source store')
    schema = introspect(clone_url)
    before = table_counts(clone_url, sorted(schema))
    script = trim_sql(schema, kept_home, cutoff)
    psql(clone_url, script, script=True)
    after = table_counts(clone_url, sorted(schema))
    kept = [row for row in psql(clone_url, 'select id from cont_sessions order by id').split('\n') if row]
    refs = [row for row in psql(clone_url, 'select wip_ref from cont_sessions where wip_ref is not null').split('\n') if row] \
        if 'wip_ref' in schema['cont_sessions'] else []
    return {'schema': 'teamwork-stage-b-rerun-store-trim/v1', 'cutoff': cutoff, 'kept_home': kept_home,
            'rows_before': before, 'rows_after': after, 'kept_sessions': kept, 'kept_wip_refs': refs, 'sql': script,
            'limitations': ['rows are attributed by cont_sessions.transcript_path prefix and per-table time columns',
                            'in-place mutations of kept rows by later stages (version counters, generations) are not undone',
                            'confirmations/rejections dated after the cutoff are reverted to proposed']}


# --------------------------------------------------------------------------- Git remote + markdown store
def clone_remote(source_remote, destination, keep_refs):
    source_remote, destination = Path(source_remote), Path(destination)
    if not (source_remote / 'HEAD').is_file():
        raise ValueError('source bare remote missing: ' + str(source_remote))
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull, GIT_TERMINAL_PROMPT='0')
    run = lambda *args: subprocess.run(['git', *args], env=env, check=True, capture_output=True, text=True).stdout
    run('clone', '--quiet', '--mirror', str(source_remote), str(destination))
    run('--git-dir=' + str(destination), 'remote', 'remove', 'origin')
    refs = [line.split(' ', 1) for line in run('--git-dir=' + str(destination), 'for-each-ref', '--format=%(refname) %(objectname)').splitlines()]
    removed = []
    for name, commit in refs:
        if name not in keep_refs:
            run('--git-dir=' + str(destination), 'update-ref', '-d', name, commit)
            removed.append(name)
    gc = subprocess.run(['git', '--git-dir=' + str(destination), 'gc', '--prune=now', '--quiet'], env=env, capture_output=True, text=True)
    return {'kept_refs': [name for name, _ in refs if name in keep_refs], 'removed_refs': removed,
            'pruned_unreferenced_objects': gc.returncode == 0}


def object_created_at(text):
    match = re.search(r'^generated:\s*\n(?:[ \t]+.*\n)*?[ \t]+at:\s*[\'"]?([0-9T:.\-Z+]+)', text, re.M)
    if match:
        return match.group(1)
    match = re.search(r'^created:\s*[\'"]?([0-9T:.\-Z+]+)', text, re.M)
    return match.group(1) if match else None


def parse_time(value):
    value = value.strip()
    if value.endswith('Z'):
        value = value[:-1] + '+00:00'
    parsed = _dt.datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=_dt.timezone.utc)


def copy_ledger_dir(source, destination, cutoff):
    """Copy the markdown object store, dropping objects generated after the cutoff and their view lines."""
    source, destination = Path(source), Path(destination)
    cut = parse_time(cutoff)
    removed, kept, undated = [], [], []
    shutil.copytree(source, destination, symlinks=False)
    for path in sorted(destination.rglob('*.md')):
        if path.name in ('README.md', 'index.md', 'log.md', 'LEDGER.md'):
            continue
        created = object_created_at(path.read_text(errors='replace'))
        stamp = path.stem if created is None else created
        if created is None:
            undated.append(path.stem)
            created_dt = _dt.datetime.fromtimestamp(path.stat().st_mtime, _dt.timezone.utc)
        else:
            created_dt = parse_time(created)
        if created_dt > cut:
            removed.append(path.stem)
            path.unlink()
        else:
            kept.append(path.stem)
    if removed:
        counts = {kind: len([p for p in (destination / kind).glob('*.md') if p.name != 'index.md'])
                  for kind in ('definitions', 'findings', 'changes', 'decisions') if (destination / kind).is_dir()}
        singular = {kind: kind[:-1] for kind in counts}
        for view in [p for p in destination.rglob('*.md') if p.name in ('README.md', 'index.md', 'log.md')]:
            lines = view.read_text(errors='replace').split('\n')
            filtered = [line for line in lines if not any(identifier in line for identifier in removed)]
            text = '\n'.join(filtered)
            for kind, count in counts.items():
                text = re.sub(r'\d+ ' + singular[kind] + 's? in force', str(count) + ' ' + (singular[kind] if count == 1 else kind) + ' in force', text)
                text = re.sub(r'\d+ ' + kind + r'( and|,)', str(count) + ' ' + kind + r'\1', text)
                text = re.sub(r'(and )\d+ ' + kind, r'\g<1>' + str(count) + ' ' + kind, text)
            view.write_text(text)
    for note in destination.rglob('*'):
        if note.is_symlink():
            raise ValueError('symlink in ledger object store: ' + str(note))
    return {'kept_objects': kept, 'removed_objects': removed, 'undated_objects_by_mtime': undated, 'cutoff': cutoff,
            'view_note': 'generated views (README/index/log) were line-filtered; the product regenerates them on its next write'}


# --------------------------------------------------------------------------- Source root
def capture_cutoff(a_controller):
    stamps = []
    for receipt in sorted(Path(a_controller).glob('native-capture-*.json')):
        try:
            value = load(receipt).get('at')
        except ValueError:
            continue
        if isinstance(value, str):
            stamps.append(value)
    return max(stamps, key=parse_time) if stamps else None


def a_snapshot(a_controller):
    snapshots = []
    for receipt in sorted(Path(a_controller).glob('native-capture-*.json')):
        try:
            for item in load(receipt).get('snapshots') or []:
                if isinstance(item, dict) and item.get('commit') and item.get('ref'):
                    snapshots.append(item)
        except ValueError:
            continue
    return snapshots[-1] if snapshots else None


def load_source(root, cutoff=None):
    root = Path(root).resolve(strict=True)
    state = load(root / 'sequence.json')
    if state.get('schema') != 'teamwork-sequence/v3' or state.get('track') != TRACK or state.get('arm') != 'ledger':
        raise ValueError('source must be an engineering-ledger teamwork-sequence/v3 root')
    if state.get('status') != 'ended':
        raise ValueError('source sequence has not ended (status ' + str(state.get('status')) + ')')
    a_state = state.get('stages', {}).get(PREDECESSOR, {})
    if a_state.get('status') != 'finished' or a_state.get('delivered') is not True:
        raise ValueError('source stage A was not finished and delivered')
    pack = Path(state['pack']).resolve(strict=True)
    manifest = sequence.validate_pack(pack)
    if digest(pack / 'manifest.json') != state['pack_manifest_sha256']:
        raise ValueError('source pack manifest changed since the sequence was prepared')
    stages = {s['id']: s for s in manifest['stages']}
    if PREDECESSOR not in stages or STAGE not in stages:
        raise ValueError('pack lacks stages A and B')
    a_controller = root / 'stages' / PREDECESSOR / 'controller'
    if not sequence.verify_submission(a_controller, stages[PREDECESSOR]['deadline_ms'], TRACK):
        raise ValueError("stage A has no verified timely immutable submission")
    a_tree = a_controller / 'submission' / 'tree'
    native_state = load(root / 'native-state.json')
    if native_state.get('arm') != 'ledger' or not SAFE_DB.fullmatch(str(native_state.get('database_name', ''))):
        raise ValueError('native-state.json must name the Ledger store database')
    owner = load(root / 'ledger-native-owner.json')
    ownership = load(root / 'ownership.json')
    if owner.get('databaseName') != native_state['database_name'] or ownership.get('namespace') != native_state.get('namespace') \
            or owner.get('namespace') != native_state.get('namespace'):
        raise ValueError('native owner/state/ownership disagree about the store')
    native_config = load(root / 'native-config.json')
    if native_config.get('arm') != 'ledger' or Path(native_config['root']).resolve() != root:
        raise ValueError('native-config.json does not belong to this root')
    launch = load(root / 'launch.json') if (root / 'launch.json').exists() else {}
    cutoff = cutoff or capture_cutoff(a_controller)
    if not cutoff:
        raise ValueError('no stage-A native capture receipt with a timestamp; pass --cutoff')
    later = [s for s in owner.get('stages', []) if s.get('role') != 'stage-' + PREDECESSOR and s.get('preparedAt')]
    if later and min(parse_time(s['preparedAt']) for s in later) <= parse_time(cutoff):
        raise ValueError('cutoff is not before the next stage preparation; store trim would leak later stages')
    ops_file = root / 'external-operations' / 'events.jsonl'
    a_ops = []
    if ops_file.exists():
        a_ops = [json.loads(line) for line in ops_file.read_text().splitlines() if line.strip()]
        a_ops = [e for e in a_ops if e.get('stage') == PREDECESSOR]
    return {'root': root, 'state': state, 'pack': pack, 'manifest': manifest, 'stages': stages, 'a_controller': a_controller,
            'a_tree': a_tree, 'a_tree_files': inventory(a_tree), 'a_delivery_sha256': digest(a_controller / 'delivery.json'),
            'native_state': native_state, 'owner': owner, 'native_config': native_config, 'launch': launch, 'cutoff': cutoff,
            'a_home': str(root / 'stages' / PREDECESSOR / 'home'), 'a_snapshot': a_snapshot(a_controller),
            'a_supplier_events': a_ops, 'source_database': native_state['database_name'],
            'source_database_pattern_ok': bool(LEDGER_DB.fullmatch(native_state['database_name']))}


# --------------------------------------------------------------------------- Workspace seeding
def seed_workspace(source, work, controller):
    """A's immutable submission tree + B delta, with the primary transport's file rules and one fresh commit."""
    work, controller = Path(work), Path(controller)
    if any(work.iterdir()):
        raise ValueError('session worktree must be empty')
    delta = sequence.contained(source['pack'], source['stages'][STAGE]['delta_dir'])
    delta_files = inventory(delta, released=True)
    tree_files = inventory(source['a_tree'], released=True)
    for left in tree_files:
        for right in delta_files:
            if left == right or left.startswith(right + '/') or right.startswith(left + '/'):
                raise ValueError('stage delta collides with predecessor tree: ' + right)
    sequence.copy_inputs(source['a_tree'], work)
    sequence.copy_inputs(delta, work)
    released = inventory(work)
    sequence.git(work, 'init', '-q', '--initial-branch=main')
    sequence.git(work, 'add', '-A')
    sequence.git(work, '-c', 'user.name=benchmark-controller', '-c', 'user.email=controller@evaluation.invalid',
                 'commit', '-q', '--allow-empty', '-m', 'Predecessor A immutable submission tree and current stage delta')
    receipt = {'schema': 'teamwork-input-transport/stage-b-rerun/v1', 'stage': STAGE,
               'predecessor_tree_files': tree_files, 'predecessor_tree_source': str(source['a_tree']),
               'predecessor_delivery_sha256': source['a_delivery_sha256'],
               'current_delta_files': delta_files, 'released_files': released,
               'source_policy': PROTOCOL_NOTE, 'initial_git_head': sequence.git(work, 'rev-parse', 'HEAD'),
               'initial_git_commit_count': int(sequence.git(work, 'rev-list', '--count', 'HEAD'))}
    dump(controller / 'transport.json', receipt, exclusive=True)
    return receipt


# --------------------------------------------------------------------------- Prepare
def interleave(arms, sessions):
    """ABBA ordering so time-of-day drift is balanced across arms."""
    order = []
    for index in range(1, sessions + 1):
        block = list(arms) if index % 2 else list(reversed(arms))
        order.extend(arm + '-' + format(index, '02d') for arm in block)
    return order


def freeze_files(paths):
    frozen = {}
    for path in paths:
        path = Path(path)
        if path.is_dir():
            for child in sorted(path.rglob('*')):
                if child.is_file() and not child.is_symlink():
                    frozen[str(child.resolve())] = digest(child)
        elif path.is_file():
            frozen[str(path.resolve())] = digest(path)
    return frozen


def verify_frozen(frozen):
    for name, expected in frozen.items():
        if not Path(name).is_file() or digest(name) != expected:
            raise ValueError('frozen runtime/controller input changed: ' + name)


def default_node(source_launch):
    argv = source_launch.get('driver_argv') or []
    if argv and Path(argv[0]).is_file():
        return str(Path(argv[0]).resolve())
    node = shutil.which('node')
    if not node:
        raise ValueError('node binary required')
    return str(Path(node).resolve())


def prepare(source_root, out, sessions, arms=ARMS, authorize=None, runtime=None, driver_argv=None, cutoff=None,
            db_namer=None, node=None):
    if not isinstance(sessions, int) or not 1 <= sessions <= 20:
        raise ValueError('sessions must be an integer between 1 and 20')
    arms = tuple(arms)
    if not arms or len(set(arms)) != len(arms) or any(arm not in ARMS for arm in arms):
        raise ValueError('arms must be a subset of ' + ','.join(ARMS))
    if authorize is not None and (not isinstance(authorize, str) or not authorize.strip()):
        raise ValueError('--authorize requires non-empty text')
    source = load_source(source_root, cutoff)
    out = Path(out).resolve()
    if out.is_relative_to(source['root']) or source['root'].is_relative_to(out) or out.is_relative_to(source['pack']):
        raise ValueError('rerun output must be disjoint from the source root and pack')
    launch = source['launch']
    runtime = Path(runtime or launch.get('runtime') or '').resolve()
    if not runtime.is_dir():
        raise ValueError('frozen runtime directory required')
    node = node or default_node(launch)
    driver_argv = driver_argv or [node, str(HERE / 'session-driver.mjs'), 'run', '{request}']
    if '{request}' not in driver_argv:
        raise ValueError('driver argv requires standalone {request}')
    stage_profile_argv = [node, str(HERE / 'native-lifecycle.mjs'), 'stage', '{request}']
    periodic_argv = [node, str(HERE / 'native-lifecycle.mjs'), 'periodic', '{request}']
    capture_argv = [node, str(HERE / 'native-lifecycle.mjs'), 'capture', '{request}']
    model = launch.get('model', DEFAULT_MODEL)
    effort = launch.get('reasoning_effort', DEFAULT_EFFORT)
    stage_b = source['stages'][STAGE]
    deadline = stage_b['deadline_ms']
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    order = interleave(arms, sessions)
    roots = {sid: out / 'sessions' / sid for sid in order}
    owner, native_config, native_state = source['owner'], source['native_config'], source['native_state']
    admin_url = owner.get('adminUrl') or 'postgresql://' + urllib.parse.quote(os.environ.get('USER', '')) + '@127.0.0.1:5432/postgres'
    prompt = sequence.contained(source['pack'], stage_b['prompt_file']).read_text()
    records = []
    for sid in order:
        arm, index = sid.rsplit('-', 1)
        sroot = roots[sid]
        base = sroot / 'stages' / STAGE
        work, home, ctl = base / 'worktree', base / 'home', base / 'controller'
        for folder in (work, home, ctl):
            folder.mkdir(parents=True, mode=0o700)
        (sroot / 'controller-canary').write_text(os.urandom(32).hex())
        (ctl / 'foreign-canary').write_text(os.urandom(32).hex())
        transport = seed_workspace(source, work, ctl)
        (ctl / 'prompt.txt').write_text(prompt)
        (sroot / 'external-operations').mkdir(mode=0o700)
        record = {'session': sid, 'arm': arm, 'index': int(index), 'root': str(sroot), 'workspace': str(work),
                  'controller': str(ctl), 'status': 'prepared', 'released_files_sha256': hashlib.sha256(
                      json.dumps(transport['released_files'], sort_keys=True).encode()).hexdigest()}
        profile_file = ctl / 'native-profile.json'
        if arm == 'ledger':
            clone_name = db_namer(int(index)) if db_namer else 'ledger_native_' + secrets.token_hex(12)
            nonce = secrets.token_hex(24)
            clone_url = clone_database(admin_url, source['source_database'], clone_name, nonce)
            trim = trim_clone(clone_url, source['source_database'], source['a_home'], source['cutoff'])
            dump(sroot / 'store-trim-receipt.json', trim, exclusive=True)
            remote = sroot / 'ledger-native-origin.git'
            remote_receipt = clone_remote(owner['remote'], remote, set(trim['kept_wip_refs']))
            dump(sroot / 'remote-trim-receipt.json', remote_receipt, exclusive=True)
            ledger_receipt = copy_ledger_dir(source['root'] / 'ledger', sroot / 'ledger', source['cutoff'])
            dump(sroot / 'ledger-dir-trim-receipt.json', ledger_receipt, exclusive=True)
            dump(sroot / 'ownership.json', {'namespace': native_state['namespace']}, exclusive=True)
            session_owner = {**owner, 'trialDir': str(sroot), 'databaseUrl': clone_url, 'databaseName': clone_name,
                             'adminUrl': admin_url, 'remote': str(remote), 'nonce': nonce,
                             'stages': [s for s in owner.get('stages', []) if s.get('role') == 'stage-' + PREDECESSOR],
                             'rerun_source': {'root': str(source['root']), 'database': source['source_database'], 'cutoff': source['cutoff']}}
            session_owner.pop('closedAt', None)
            snapshot = source['a_snapshot']
            if snapshot and snapshot['ref'] in trim['kept_wip_refs']:
                session_owner['latestSnapshot'] = {'sessionId': snapshot.get('session_id'), 'threadId': snapshot.get('thread_id'),
                                                   'commit': snapshot['commit'], 'ref': snapshot['ref'],
                                                   'verifiedAt': snapshot.get('verified_at'), 'tree': None}
            else:
                session_owner.pop('latestSnapshot', None)
            dump(sroot / 'ledger-native-owner.json', session_owner, exclusive=True)
            dump(sroot / 'native-state.json', {'arm': 'ledger', 'namespace': native_state['namespace'],
                                               'created_at': native_state.get('created_at'), 'version': native_state.get('version'),
                                               'stages': [PREDECESSOR], 'database_name': clone_name,
                                               'rerun_source_database': source['source_database']}, exclusive=True)
            guide = sroot / 'native-guide.md'
            shutil.copyfile(native_config['guide_file'], guide)
            config = {**native_config, 'root': str(sroot), 'guide_file': str(guide)}
            dump(sroot / 'native-config.json', config, exclusive=True)
            record.update(database=clone_name, database_url=clone_url, remote=str(remote),
                          store_rows_after_trim=trim['rows_after'], kept_wip_refs=trim['kept_wip_refs'])
            session_periodic, session_stage_profile_argv, session_capture = periodic_argv, stage_profile_argv, capture_argv
        else:
            guide = sroot / 'control-guide.md'
            guide.write_text(CONTROL_GUIDE)
            dump(sroot / 'native-config.json', {'arm': 'fresh-agent', 'root': str(sroot), 'guide_file': str(guide),
                                                'version': 'no-memory-control'}, exclusive=True)
            profile = {'arm': 'fresh-agent', 'guide_file': str(guide), 'guide_sha256': digest(guide), 'mcp': {}, 'hook_env': {},
                       'read_paths': [], 'write_paths': [], 'readiness_verified': True,
                       'readiness_basis': 'no-memory control: no native product; the session driver verifies kernel isolation and delivery at launch',
                       'paid_paths_gated': True,
                       'paid_paths_basis': 'No memory MCP or capture hooks; only the fixed task model subscription; zero provider-paid operations.'}
            if native_config.get('ca_file'):
                profile['ca_file'] = native_config['ca_file']
            dump(profile_file, profile, exclusive=True)
            session_periodic, session_stage_profile_argv, session_capture = None, None, None
        forbidden = [str(source['pack']), str(source['root']), str(ctl), str(out / 'rerun.json'), str(out / 'frozen-files.json')]
        forbidden += [str(roots[other]) for other in order if other != sid]
        request = {'schema': 'teamwork-stage-request/v3', 'workspace': str(work), 'fresh_home': str(home),
                   'controller_output_dir': str(ctl), 'prompt_file': str(ctl / 'prompt.txt'), 'runtime': str(runtime),
                   'native_profile': str(profile_file), 'arm': arm, 'track': TRACK, 'stage': STAGE, 'model': model,
                   'reasoning_effort': effort, 'stage_deadline_ms': deadline,
                   'execution_authorized': authorize is not None, 'authorization': authorize,
                   'development_probe': False, 'scored': True, 'native_config': str(sroot / 'native-config.json'),
                   'periodic_capture_argv': session_periodic,
                   'forbidden_canaries': [str(sroot / 'controller-canary'), str(ctl / 'foreign-canary')],
                   'forbidden_paths': forbidden, 'transport_receipt': str(ctl / 'transport.json'),
                   'snapshot_all_tracks': True, 'stress': stage_b.get('stress'),
                   'rerun': {'schema': SCHEMA, 'session': sid, 'protocol': PROTOCOL_NOTE}}
        dump(ctl / 'request.json', request, exclusive=True)
        session_launch = {'schema': 'teamwork-stage-b-rerun-launch/v1', 'session': sid, 'arm': arm,
                          'execution_authorized': authorize is not None, 'authorization': authorize,
                          'paid_paths_gated': True, 'maximum_approved_usd': 30, 'budget_file': launch.get('budget_file') or native_config.get('budget_file'),
                          'runtime': str(runtime), 'model': model, 'reasoning_effort': effort, 'stage_deadline_ms': deadline,
                          'capture_timeout_ms': launch.get('capture_timeout_ms', 300000),
                          'driver_argv': driver_argv, 'stage_profile_argv': session_stage_profile_argv,
                          'capture_argv': session_capture, 'native_config': request['native_config'],
                          'native_profile': str(profile_file), 'request': str(ctl / 'request.json'),
                          'frozen_files_file': str(out / 'frozen-files.json'), 'frozen_files_sha256': None,
                          'protected_paths': [str(source['pack']), str(source['root']), str(ctl)] + [str(roots[o]) for o in order if o != sid]}
        dump(sroot / 'launch.json', session_launch, exclusive=True)
        records.append(record)
    frozen_inputs = [HERE / name for name in ('session-driver.mjs', 'harness-codex.mjs', 'operations.mjs', 'native-lifecycle.mjs',
                                                'native-ledger-capture.mjs', 'native-classifier.mjs', 'native-http-proxy.mjs')]
    frozen_inputs += [V2 / name for name in ('budget-gate.mjs', 'grade_engineering_contract_v2.py', 'provider_sim.py')]
    frozen_inputs += [runtime, node, source['pack'] / 'manifest.json', source['a_tree'], Path(driver_argv[0])]
    frozen_inputs += [Path(x) for x in driver_argv[1:] if Path(x).is_file()]
    for sid in order:
        sroot = roots[sid]
        frozen_inputs += [sroot / 'native-config.json', sroot / 'stages' / STAGE / 'controller' / 'prompt.txt',
                          sroot / 'stages' / STAGE / 'controller' / 'transport.json']
        frozen_inputs += [p for p in (sroot / 'native-guide.md', sroot / 'control-guide.md', sroot / 'stages' / STAGE / 'controller' / 'native-profile.json',
                                      sroot / 'ledger-native-owner.json', sroot / 'native-state.json') if p.exists()]
    frozen = freeze_files(frozen_inputs)
    dump(out / 'frozen-files.json', frozen, exclusive=True)
    frozen_sha = digest(out / 'frozen-files.json')
    source_frozen = launch.get('frozen_files') or {}
    common = [name for name in frozen if name in source_frozen]
    mismatched = [name for name in common if source_frozen[name] != frozen[name]]
    for sid in order:
        file = roots[sid] / 'launch.json'
        cfg = load(file)
        cfg['frozen_files_sha256'] = frozen_sha
        dump(file, cfg)
    plan = {'schema': SCHEMA, 'created_at': now(), 'status': 'prepared', 'source_root': str(source['root']),
            'source_pack': str(source['pack']), 'source_pack_manifest_sha256': digest(source['pack'] / 'manifest.json'),
            'source_database': source['source_database'], 'source_database_name_pattern_ok': source['source_database_pattern_ok'],
            'source_a_tree': str(source['a_tree']), 'source_a_tree_files': source['a_tree_files'],
            'source_a_supplier_events': source['a_supplier_events'], 'store_cutoff': source['cutoff'],
            'runtime': str(runtime), 'node': node, 'model': model, 'reasoning_effort': effort, 'stage_deadline_ms': deadline,
            'stage_stress': stage_b.get('stress'), 'arms': list(arms), 'sessions_per_arm': sessions, 'order': order,
            'execution_authorized': authorize is not None, 'authorization': authorize, 'driver_argv': driver_argv,
            'frozen_files_sha256': frozen_sha, 'frozen_files_count': len(frozen),
            'runtime_freeze_matches_source_launch': {'compared': len(common), 'mismatched': len(mismatched),
                                                     'mismatched_sample': mismatched[:10]},
            'protocol': PROTOCOL_NOTE, 'sessions': records, 'transport_sha256': digest(__file__)}
    dump(out / 'rerun.json', plan, exclusive=True)
    return plan


def authorize_root(out, text):
    out = Path(out).resolve(strict=True)
    if not isinstance(text, str) or not text.strip():
        raise ValueError('authorization text required')
    plan = load(out / 'rerun.json')
    for record in plan['sessions']:
        if (Path(record['root']) / 'attempt.json').exists():
            raise ValueError('a session was already attempted; prepare a new root instead of re-authorizing')
    for record in plan['sessions']:
        for file in (Path(record['root']) / 'launch.json', Path(record['controller']) / 'request.json'):
            cfg = load(file)
            cfg.update(execution_authorized=True, authorization=text)
            dump(file, cfg)
    plan.update(execution_authorized=True, authorization=text, authorized_at=now())
    dump(out / 'rerun.json', plan)
    return plan


# --------------------------------------------------------------------------- Run
def run(out, driver_argv=None, stage_profile_argv=None, capture=False, only=None):
    out = Path(out).resolve(strict=True)
    plan = load(out / 'rerun.json')
    if plan.get('schema') != SCHEMA:
        raise ValueError('not a stage-B rerun root')
    if plan.get('execution_authorized') is not True or not plan.get('authorization'):
        raise ValueError('explicit live execution authorization required (prepare/authorize with --authorize "<text>")')
    if digest(__file__) != plan['transport_sha256']:
        raise ValueError('rerun transport changed since preparation')
    if driver_argv is not None and '{request}' not in driver_argv:
        raise ValueError('driver argv requires standalone {request}')
    frozen = load(out / 'frozen-files.json')
    if digest(out / 'frozen-files.json') != plan['frozen_files_sha256']:
        raise ValueError('frozen file inventory changed')
    plan.update(status='running', run_started_at=plan.get('run_started_at') or now(),
                driver_override=driver_argv is not None or stage_profile_argv is not None)
    dump(out / 'rerun.json', plan)
    records = {r['session']: r for r in plan['sessions']}
    for sid in plan['order']:
        if only and sid not in only:
            continue
        record = records[sid]
        sroot, ctl, work = Path(record['root']), Path(record['controller']), Path(record['workspace'])
        if (sroot / 'attempt.json').exists():
            record.setdefault('skipped', 'already attempted; artifacts preserved')
            continue
        launch = load(sroot / 'launch.json')
        request_file = ctl / 'request.json'
        request = load(request_file)
        record.update(status='started', started_at=now())
        dump(out / 'rerun.json', plan)
        try:
            if launch.get('execution_authorized') is not True or request.get('execution_authorized') is not True or not request.get('authorization'):
                raise ValueError('session not authorized')
            verify_frozen(frozen)
            dump(sroot / 'attempt.json', {'launch_sha256': digest(sroot / 'launch.json'), 'started_at_unix': time.time(),
                                          'driver_argv': driver_argv or launch['driver_argv']}, exclusive=True)
            transport = load(ctl / 'transport.json')
            if inventory(work, exclude_root={'.git'}) != transport['released_files']:
                raise ValueError('seeded workspace changed before launch')
            if sequence.git(work, 'rev-list', '--count', 'HEAD') != '1' or sequence.git(work, 'rev-parse', 'HEAD') != transport['initial_git_head']:
                raise ValueError('seeded Git history changed before launch')
            protected = [Path(p) for p in launch['protected_paths']]
            profile_argv = stage_profile_argv or launch.get('stage_profile_argv')
            if record['arm'] == 'ledger':
                if not profile_argv:
                    raise ValueError('ledger sessions require a native stage profile command')
                record['native_preparation'] = sequence.run_command(sequence.expand(profile_argv, request_file), sroot,
                                                                     launch['capture_timeout_ms'] / 1000, ctl / 'native-preparation.log')
                if record['native_preparation']['exit_code'] != 0 or record['native_preparation']['timed_out']:
                    raise ValueError('native preparation failed')
                if inventory(work, exclude_root={'.git'}) != transport['released_files']:
                    raise ValueError('native preparation populated/changed task workspace')
                if sequence.git(work, 'rev-list', '--count', 'HEAD') != '1' or sequence.git(work, 'rev-parse', 'HEAD') != transport['initial_git_head']:
                    raise ValueError('native preparation changed initial Git history')
                profile_text = Path(request['native_profile']).read_text()
                if plan['source_database'] in profile_text or plan['source_root'] in profile_text:
                    raise ValueError('native profile references the frozen source store or root')
                if record['database'] not in profile_text:
                    raise ValueError('native profile does not use this session\'s cloned store')
            profile = load(request['native_profile'])
            sequence.validate_profile(profile, request, protected)
            if record['arm'] == 'fresh-agent' and (profile.get('mcp') or profile.get('hooks') or profile.get('hook_env')):
                raise ValueError('control must not have memory servers or hooks')
            argv = sequence.expand(driver_argv or launch['driver_argv'], request_file)
            record['driver'] = sequence.run_command(argv, sroot, launch['stage_deadline_ms'] / 1000 + 15, ctl / 'driver.log')
            if (ctl / 'stage-result.json').exists():
                record['session_result'] = {k: v for k, v in load(ctl / 'stage-result.json').items()
                                            if k in ('delivered', 'elapsed_ms', 'wall_elapsed_ms', 'timed_out', 'timing_valid', 'exit_code', 'interruption', 'compaction')}
            record['timing_valid'] = record['driver']['timing_valid'] and record.get('session_result', {}).get('timing_valid', False)
            record['delivered'] = sequence.verify_submission(ctl, launch['stage_deadline_ms'], TRACK)
            if capture and launch.get('capture_argv'):
                record['capture'] = sequence.run_command(sequence.expand(launch['capture_argv'], request_file), sroot,
                                                         launch['capture_timeout_ms'] / 1000, ctl / 'capture.log')
                if record['delivered']:
                    sequence.verify_submission(ctl, launch['stage_deadline_ms'], TRACK)
            record['status'] = 'finished'
        except Exception as error:  # retained per session; the remaining sessions still run
            record.update(status='failed', error=str(error)[:2000])
        record['ended_at'] = now()
        dump(sroot / 'session.json', record)
        dump(out / 'rerun.json', plan)
    plan['status'] = 'ended' if all(r.get('status') in ('finished', 'failed') or r.get('skipped') for r in plan['sessions']) else 'partial'
    plan['run_ended_at'] = now()
    dump(out / 'rerun.json', plan)
    return plan


# --------------------------------------------------------------------------- Score
def grader_module():
    if str(V2) not in sys.path:
        sys.path.append(str(V2))
    return importlib.import_module('grade_engineering_contract_v2')


def probe_response_shape(tree, module, provider_factory):
    """Direct, model-free observation of execute success body and GET /jobs/ID shape."""
    provider = provider_factory()
    result = {'status': 'not_probed'}
    with tempfile.TemporaryDirectory(prefix='stage-b-rerun-probe-') as scratch:
        app = module.App(tree, scratch, provider)
        try:
            app.start()
            status, job = app.call('/jobs', 'POST', {'key': uuid.uuid4().hex, 'payload': 'hello'})
            result['create_status'] = status
            if status != 201 or not isinstance(job, dict) or not isinstance(job.get('id'), str):
                result['status'] = 'create_failed'
                return result
            status, body = app.call('/jobs/' + job['id'] + '/execute', 'POST', {})
            body = body if isinstance(body, dict) else {}
            result.update(execute_status=status, execute_body_keys=sorted(body),
                          execute_body_includes_state='state' in body,
                          execute_body_includes_receipt_id=isinstance(body.get('receipt_id'), str) and bool(body.get('receipt_id')))
            oracle = provider.receipts.get(job['id']) or {}
            get_status, got = app.call('/jobs/' + job['id'])
            got = got if isinstance(got, dict) else {}
            result.update(get_status=get_status, get_body_keys=sorted(got),
                          get_includes_state='state' in got, get_state=got.get('state'),
                          get_includes_receipt_id=isinstance(got.get('receipt_id'), str) and bool(got.get('receipt_id')),
                          get_receipt_matches_provider=bool(oracle) and got.get('receipt_id') == oracle.get('receipt_id'))
            result['status'] = 'probed' if status == 200 and get_status == 200 else 'execute_or_get_not_200'
        except Exception as error:
            result.update(status='probe_error', error=str(error)[:800])
        finally:
            app.stop()
            provider.close()
    return result


def score(out, grader=None, probe=None):
    out = Path(out).resolve(strict=True)
    plan = load(out / 'rerun.json')
    module = grader_module()
    grade = grader or module.grade
    if probe is None:
        from provider_sim import Provider  # noqa: E402  (v2 controller simulator, imported via grader path)
        probe = lambda tree: probe_response_shape(tree, module, Provider)
    sessions = []
    for record in plan['sessions']:
        ctl = Path(record['controller'])
        deadline = load(Path(record['root']) / 'launch.json')['stage_deadline_ms']
        item = {'session': record['session'], 'arm': record['arm'], 'index': record['index'], 'run_status': record.get('status'),
                'timing_valid': record.get('timing_valid'), 'status': 'not_scored'}
        sessions.append(item)
        try:
            delivered = sequence.verify_submission(ctl, deadline, TRACK)
        except ValueError as error:
            item.update(status='submission_invalid', reason=str(error))
            continue
        if not delivered:
            item.update(status='not_delivered', reason='no verified timely immutable submission')
            continue
        tree = ctl / 'submission' / 'tree'
        item['submission_tree_sha256'] = hashlib.sha256(json.dumps(inventory(tree), sort_keys=True).encode()).hexdigest()
        grade_result = grade(tree, STAGE)
        checks = {check['id']: check['passed'] for check in grade_result.get('checks', [])}
        item.update(checks=checks, checks_passed=grade_result.get('passed'), checks_applicable=grade_result.get('applicable'),
                    behavioral_pass=grade_result.get('behavioral_pass'), critical_errors=grade_result.get('critical_errors'),
                    check_errors={check['id']: check.get('error') for check in grade_result.get('checks', []) if not check['passed']},
                    historical_three={name: checks.get(name) for name in HISTORICAL_CHECKS},
                    historical_three_pass=all(checks.get(name) is True for name in HISTORICAL_CHECKS))
        shape = probe(tree)
        item['response_shape'] = shape
        probed = shape.get('status') == 'probed'
        item['get_omits_receipt_id'] = (not shape.get('get_includes_receipt_id')) if probed else None
        item['execute_omits_state'] = (not shape.get('execute_body_includes_state')) if probed else None
        item['status'] = 'scored' if probed else 'scored_without_shape_probe'
        if sequence.verify_submission(ctl, deadline, TRACK) is not True:
            raise ValueError('submission changed during scoring: ' + record['session'])
    arms = {}
    for arm in plan['arms']:
        rows = [s for s in sessions if s['arm'] == arm]
        scored = [s for s in rows if s['status'] == 'scored']
        summary = {'sessions_prepared': len(rows), 'sessions_delivered': sum(1 for s in rows if s['status'].startswith('scored')),
                   'n': len(scored),
                   'get_receipt_id_omissions': sum(1 for s in scored if s['get_omits_receipt_id']),
                   'execute_state_omissions': sum(1 for s in scored if s['execute_omits_state']),
                   'historical_three_pass': sum(1 for s in scored if s['historical_three_pass']),
                   'behavioral_pass': sum(1 for s in scored if s['behavioral_pass']),
                   'checks_passed_over_applicable': [str(s['checks_passed']) + '/' + str(s['checks_applicable']) for s in scored]}
        summary['get_receipt_id_omission_rate'] = summary['get_receipt_id_omissions'] / summary['n'] if summary['n'] else None
        summary['execute_state_omission_rate'] = summary['execute_state_omissions'] / summary['n'] if summary['n'] else None
        arms[arm] = summary
    comparison = None
    if set(ARMS) <= set(arms) and arms['ledger']['n'] and arms['fresh-agent']['n']:
        difference = arms['ledger']['get_receipt_id_omissions'] - arms['fresh-agent']['get_receipt_id_omissions']
        comparison = {'ledger_minus_control_omissions': difference,
                      'ledger_minus_control_rate': arms['ledger']['get_receipt_id_omission_rate'] - arms['fresh-agent']['get_receipt_id_omission_rate'],
                      'within_one_session_of_each_other': abs(difference) <= 1 and arms['ledger']['n'] == arms['fresh-agent']['n'],
                      'decision_confirmation': 'dec-20260913-ship-capture-safety-fixes-then-continuity-featur-n12l: Ledger and no-memory control omission rates differ by at most 1 of 5 sessions'}
    report = {'schema': 'teamwork-stage-b-rerun-report/v1', 'scored_at': now(), 'source_root': plan['source_root'],
              'source_database': plan['source_database'], 'store_cutoff': plan['store_cutoff'], 'protocol': plan['protocol'],
              'grader': 'eval/teamwork-v2/grade_engineering_contract_v2.py (imported; stage B checks)',
              'grader_sha256': digest(V2 / 'grade_engineering_contract_v2.py'), 'model_grading': 'none',
              'driver_override': plan.get('driver_override', False), 'run_status': plan.get('status'),
              'primary_outcome': 'GET /jobs/ID after a successful execute lacks a non-empty receipt_id (the v3 Ledger-B omission)',
              'secondary_outcome': 'successful execute body lacks state (the v2 original-grader requirement, not in the released contract)',
              'historical_checks': list(HISTORICAL_CHECKS), 'arms': arms, 'comparison': comparison, 'sessions': sessions,
              'limitations': ['4-5 sessions per arm can only detect large differences; report counts, not significance',
                              "Ledger clones are trimmed approximations of A's store at its final capture (see store-trim-receipt.json)",
                              'the seeded workspace differs from the primary protocol by design (identical code for both arms)']}
    dump(out / 'report.json', report)
    (out / 'report.md').write_text(render_report(report))
    return report


def render_report(report):
    yes = lambda value: 'yes' if value is True else 'no' if value is False else 'n/a'
    lines = ['# Stage-B-only rerun: response-shape omissions, Ledger vs no-memory control', '',
             'Source root: `' + report['source_root'] + '`  ', 'Source store: `' + report['source_database'] + '` (per-session clones trimmed at ' + report['store_cutoff'] + ')  ',
             'Grader: ' + report['grader'] + '; model grading: ' + report['model_grading'] + '  ',
             'Run status: ' + str(report['run_status']) + ('; DRIVER OVERRIDE (not a scored live run)' if report['driver_override'] else ''), '',
             report['protocol'], '', '## Per arm', '',
             '| Arm | prepared | delivered | n probed | GET omits receipt_id | rate | execute omits state | historical three pass | all checks pass |',
             '|---|---|---|---|---|---|---|---|---|']
    for arm, s in report['arms'].items():
        rate = lambda value: 'n/a' if value is None else format(value, '.2f')
        lines.append('| ' + ' | '.join([arm, str(s['sessions_prepared']), str(s['sessions_delivered']), str(s['n']),
                                        str(s['get_receipt_id_omissions']), rate(s['get_receipt_id_omission_rate']),
                                        str(s['execute_state_omissions']), str(s['historical_three_pass']) + '/' + str(s['n']),
                                        str(s['behavioral_pass']) + '/' + str(s['n'])]) + ' |')
    comparison = report['comparison']
    lines += ['', '## Comparison', '']
    if comparison:
        lines += ['Ledger minus control, GET receipt_id omissions: ' + str(comparison['ledger_minus_control_omissions'])
                  + ' (rate difference ' + format(comparison['ledger_minus_control_rate'], '+.2f') + ').',
                  'Within one session of each other: ' + yes(comparison['within_one_session_of_each_other']) + '.',
                  'Confirmation criterion: ' + comparison['decision_confirmation'] + '.']
    else:
        lines.append('Comparison unavailable: both arms need at least one probed session.')
    lines += ['', '## Per session', '',
              '| Session | Arm | Status | Timing valid | Checks | Historical three | Execute has state | GET has receipt_id | Omission |',
              '|---|---|---|---|---|---|---|---|---|']
    for s in report['sessions']:
        shape = s.get('response_shape', {})
        lines.append('| ' + ' | '.join([s['session'], s['arm'], s['status'], yes(s.get('timing_valid')),
                                        (str(s.get('checks_passed')) + '/' + str(s.get('checks_applicable'))) if s.get('checks') else 'n/a',
                                        yes(s.get('historical_three_pass')) if s.get('checks') else 'n/a',
                                        yes(shape.get('execute_body_includes_state')) if shape else 'n/a',
                                        yes(shape.get('get_includes_receipt_id')) if shape else 'n/a',
                                        yes(s.get('get_omits_receipt_id'))]) + ' |')
    lines += ['', '## Definitions', '', '- Primary outcome: ' + report['primary_outcome'] + '.', '- Secondary outcome: ' + report['secondary_outcome'] + '.',
              '- Historical three: ' + ', '.join(report['historical_checks']) + ' (the checks Ledger B/C/D failed in v3).', '', '## Limitations', '']
    lines += ['- ' + item for item in report['limitations']]
    return '\n'.join(lines) + '\n'


# --------------------------------------------------------------------------- CLI
def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    prep = commands.add_parser('prepare', help='clone stores and seed per-session workspaces; never starts a session')
    prep.add_argument('--source-root', required=True)
    prep.add_argument('--out', required=True)
    prep.add_argument('--sessions', type=int, required=True)
    prep.add_argument('--arms', default=','.join(ARMS))
    prep.add_argument('--authorize', default=None, metavar='TEXT', help='set execution_authorized=true with this authorization text')
    prep.add_argument('--runtime', default=None)
    prep.add_argument('--cutoff', default=None, help="ISO instant; default = A's last native capture receipt")
    prep.add_argument('--driver-argv', nargs='+', default=None)
    auth = commands.add_parser('authorize', help='set execution_authorized=true on an unattempted prepared root')
    auth.add_argument('--out', required=True)
    auth.add_argument('--authorize', required=True, metavar='TEXT')
    execute = commands.add_parser('run', help='execute prepared sessions in the recorded interleaved order')
    execute.add_argument('--out', required=True)
    execute.add_argument('--driver-argv', nargs='+', default=None)
    execute.add_argument('--stage-profile-argv', nargs='+', default=None)
    execute.add_argument('--capture', action='store_true', help='also run the native post-stage capture for Ledger sessions')
    execute.add_argument('--only', nargs='+', default=None)
    scorer = commands.add_parser('score', help='deterministic response-shape scoring; no model calls')
    scorer.add_argument('--out', required=True)
    args = parser.parse_args(argv)
    if args.command == 'prepare':
        result = prepare(args.source_root, args.out, args.sessions, tuple(a for a in args.arms.split(',') if a), args.authorize,
                         args.runtime, args.driver_argv, args.cutoff)
        result = {k: v for k, v in result.items() if k not in ('source_a_tree_files',)}
    elif args.command == 'authorize':
        result = authorize_root(args.out, args.authorize)
    elif args.command == 'run':
        result = run(args.out, args.driver_argv, args.stage_profile_argv, args.capture, args.only)
    else:
        result = score(args.out)
    print(json.dumps(result, indent=2, default=str))
    if args.command == 'run' and any(r.get('status') == 'failed' for r in result.get('sessions', [])):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
