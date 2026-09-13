"""Shared, conservative disk commitments; estimates are not filesystem quotas.

One flock-protected registry is shared by all controllers for this user. Dead
owners never expire automatically: a crashed capture may still have live children.
"""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import shutil
import time
import uuid

GIB = 1024 ** 3
REGISTRY_DIR = Path.home() / '.cache/teamwork-disk-reservations/v3'


class DiskReservationError(ValueError):
    def __init__(self, message, receipt=None):
        self.receipt = receipt or {'status': 'rejected', 'reason': message}
        super().__init__(message)


def filesystem(value):
    target = Path(value).resolve()
    probe = target
    while not probe.exists():
        probe = probe.parent
    if probe.is_file():
        probe = probe.parent
    return str(probe.stat().st_dev), str(probe)


def positive(value, name, minimum=1):
    if type(value) is not int or value < minimum:
        raise DiskReservationError('missing/invalid disk estimate: ' + name)
    return value


def normalize(plan, expected):
    if not isinstance(plan, dict) or plan.get('schema') != 'teamwork-disk-plan/v3':
        raise DiskReservationError('explicit aggregate disk_plan required')
    wanted = {str(Path(x['root']).resolve()): (x['arm'], x['track']) for x in expected}
    members = {}
    volumes = {}
    for item in plan.get('sequences', []):
        root = str(Path(item['root']).resolve())
        if root in members or root not in wanted or wanted[root] != (item.get('arm'), item.get('track')):
            raise DiskReservationError('disk plan must bind each expected arm/track/root exactly once')
        device, probe = filesystem(item['filesystem_path'])
        if filesystem(root)[0] != device:
            raise DiskReservationError('sequence disk estimate names the wrong filesystem')
        if not isinstance(item.get('basis'), str) or not item['basis'].strip():
            raise DiskReservationError('disk estimate basis required')
        members[root] = {'root': root, 'arm': item['arm'], 'track': item['track'], 'device': device,
                         'retained_output_bytes': positive(item.get('retained_output_bytes'), 'retained_output_bytes'),
                         'peak_working_capture_bytes': positive(item.get('peak_working_capture_bytes'), 'peak_working_capture_bytes'),
                         'basis': item['basis'], 'status': 'queued'}
        volumes.setdefault(device, {'device': device, 'probe_path': probe})
    if set(members) != set(wanted) or not members:
        raise DiskReservationError('disk plan missing sequence estimates (both tracks must be included)')
    seen = set()
    for item in plan.get('shared', []):
        device, probe = filesystem(item['filesystem_path'])
        if device in seen or device not in volumes:
            raise DiskReservationError('one shared estimate required per involved filesystem')
        seen.add(device)
        if not isinstance(item.get('basis'), str) or not item['basis'].strip():
            raise DiskReservationError('shared disk estimate basis required')
        volumes[device].update(overhead_bytes=positive(item.get('overhead_bytes'), 'overhead_bytes', 0),
                               margin_bytes=positive(item.get('margin_bytes'), 'margin_bytes', GIB),
                               basis=item['basis'])
    if seen != set(volumes):
        raise DiskReservationError('shared overhead and margin estimates required for every filesystem')
    return {'members': members, 'volumes': volumes}


def remaining(entry, exclude_member=None):
    """Both tracks retain outputs; their lane peak is max, not sum (serial tracks).

    Runtime may spend its own allowance, but cannot spend any other active/queued
    lane's headroom. Active usage is conservatively retained until completion.
    """
    totals = {d: v['overhead_bytes'] + v['margin_bytes'] for d, v in entry['volumes'].items()}
    excluded = entry['members'].get(exclude_member)
    peaks = {}
    for root, m in entry['members'].items():
        if m['status'] == 'completed':
            continue
        if root != exclude_member:
            totals[m['device']] += m['retained_output_bytes']
        key = (m['device'], m['arm'])
        peaks[key] = max(peaks.get(key, 0), m['peak_working_capture_bytes'])
    for (device, arm), peak in peaks.items():
        if not excluded or (device, arm) != (excluded['device'], excluded['arm']):
            totals[device] += peak
    return totals


@contextmanager
def locked():
    root = Path(REGISTRY_DIR)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / 'registry.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        file = root / 'registry.json'
        state = json.loads(file.read_text()) if file.exists() else {'schema': 'teamwork-disk-registry/v3', 'reservations': {}}
        if state.get('schema') != 'teamwork-disk-registry/v3' or not isinstance(state.get('reservations'), dict):
            raise DiskReservationError('invalid shared disk registry; refuse to discard commitments')
        def save():
            tmp = root / ('registry-' + uuid.uuid4().hex + '.tmp')
            try:
                with tmp.open('x') as out:
                    json.dump(state, out, indent=2, sort_keys=True)
                    out.flush()
                    os.fsync(out.fileno())
                tmp.replace(file)
            finally:
                tmp.unlink(missing_ok=True)
        yield state, save


def assess(state, candidate=None, own_id=None, member=None):
    requirements = {}
    probes = {}
    for token, entry in state['reservations'].items():
        # Released reservations remain an audit trail but no longer reserve bytes.
        if entry['status'] == 'released':
            continue
        for device, count in remaining(entry, member if token == own_id else None).items():
            requirements[device] = requirements.get(device, 0) + count
            probes[device] = entry['volumes'][device]['probe_path']
    if candidate:
        for device, count in remaining(candidate).items():
            requirements[device] = requirements.get(device, 0) + count
            probes[device] = candidate['volumes'][device]['probe_path']
    checks = []
    for device, needed in requirements.items():
        if filesystem(probes[device])[0] != device:
            raise DiskReservationError('reserved filesystem identity changed; commitments require manual review')
        free = shutil.disk_usage(probes[device]).free
        checks.append({'device': device, 'probe_path': probes[device], 'available_bytes': free,
                       'required_remaining_bytes': needed, 'passed': free >= needed})
    receipt = {'schema': 'teamwork-disk-admission/v3', 'checked_at_unix': time.time(), 'checks': checks,
               'status': 'passed' if all(x['passed'] for x in checks) else 'rejected',
               'accounting': 'all non-released reservations, including crashed owners; estimates, not hard quotas'}
    if receipt['status'] != 'passed':
        raise DiskReservationError('aggregate disk commitments exceed available space', receipt)
    return receipt


def preview(plan, expected):
    candidate = normalize(plan, expected)
    with locked() as (state, _):
        return assess(state, candidate)


def reserve(plan, expected):
    candidate = normalize(plan, expected)
    with locked() as (state, save):
        for e in state['reservations'].values():
            if e['status'] != 'released' and set(e['members']) & set(candidate['members']):
                raise DiskReservationError('sequence root already has a live or stale disk commitment')
        receipt = assess(state, candidate)
        token = uuid.uuid4().hex
        candidate.update(status='reserved', owner_pid=os.getpid(), created_at_unix=time.time(), admission=receipt)
        state['reservations'][token] = candidate
        save()
    return Lease(token, receipt)


class Lease:
    def __init__(self, token, receipt):
        self.token = token
        self.receipt = receipt

    def _entry(self, state):
        entry = state['reservations'].get(self.token)
        if not entry or entry['status'] == 'released' or entry['owner_pid'] != os.getpid():
            raise DiskReservationError('disk lease is missing, released, or owned by a different controller')
        return entry

    def start(self, root):
        root = str(Path(root).resolve())
        with locked() as (state, save):
            entry = self._entry(state)
            if entry['status'] == 'aborted' or root not in entry['members'] or entry['members'][root]['status'] != 'queued':
                raise DiskReservationError('disk reservation does not admit this sequence')
            arm = entry['members'][root]['arm']
            if any(m['arm'] == arm and m['status'] == 'running' for m in entry['members'].values()):
                raise DiskReservationError('tracks sharing a peak reservation must run serially')
            entry['members'][root]['status'] = 'running'
            save()

    def guard(self, root):
        root = str(Path(root).resolve())
        with locked() as (state, save):
            entry = self._entry(state)
            if entry['status'] == 'aborted' or entry['members'].get(root, {}).get('status') != 'running':
                raise DiskReservationError('aggregate disk reservation aborted or sequence not active')
            try:
                return assess(state, own_id=self.token, member=root)
            except DiskReservationError as error:
                entry.update(status='aborted', abort=error.receipt)
                save()
                raise

    def complete(self, root):
        with locked() as (state, save):
            entry = self._entry(state)
            member = entry['members'][str(Path(root).resolve())]
            if member['status'] != 'running':
                raise DiskReservationError('only an active sequence can complete its disk commitment')
            member.update(status='completed', completed_at_unix=time.time())
            save()

    def release(self):
        with locked() as (state, save):
            entry = self._entry(state)
            if any(m['status'] == 'running' for m in entry['members'].values()):
                raise DiskReservationError('cannot release a disk reservation with active sequences')
            entry.update(status='released', released_at_unix=time.time(),
                         release_basis='own controller confirms no active sequence; retained files remain on disk')
            save()
