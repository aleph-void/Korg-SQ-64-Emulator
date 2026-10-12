"""Strict, bounded application-only policy and persistent-write validation.

Policies are reviewer-selected inputs, not approvals inferred from firmware.
Traces are external observations, not proof of all possible executions.
"""
import hashlib

from .artifacts import read_artifact
from .image import inspect
from .validation import digest, integer, load_json, nonempty

PROFILE = 'application-only'
RECOVERY_IDS = tuple(f'RECOVERY-{n:03}' for n in range(1, 7))
SPACES = {'internal-flash': 0x10000, 'spi-flash': 0x1000000}
# Destination-relative ranges and payload offsets. Endpoints are exclusive.
INSTALLATION = {
    'internal-flash': [(0, 0x10000, 0)],
    'spi-flash': [(0, 0x4000, 0x10000), (0x4000, 0x8000, 0x34000),
                  (0x10000, 0x30000, 0x14000)],
}
FROZEN_INTERNAL = {'space': 'internal-flash', 'start': 0, 'length': 0x10000,
                   'purpose': 'Mandatory reset, loader, updater and support region', 'kind': 'recovery'}
FORBIDDEN = {'chip-erase', 'mass-erase', 'option-unlock', 'option-write', 'otp-write',
             'protection-change', 'boot-config', 'debug-config', 'status-write', 'unknown-write'}


def sha(raw):
    if not isinstance(raw, (bytes, bytearray)): raise ValueError('Expected exact artifact bytes')
    return hashlib.sha256(raw).hexdigest()


def _object(raw, format_name):
    if not isinstance(raw, (bytes, bytearray)):
        raise ValueError(f'{format_name} must be supplied as exact JSON bytes')
    document = load_json(raw.decode('utf-8'))
    if (not isinstance(document, dict) or document.get('format') != format_name
            or type(document.get('version')) is not int or document['version'] != 1):
        raise ValueError(f'Invalid {format_name} document')
    return document


def _range(item):
    if (not isinstance(item, dict) or not isinstance(item.get('space'), str)
            or item['space'] not in SPACES or not integer(item.get('start'), 0, SPACES[item['space']] - 1)
            or not integer(item.get('length'), 1, SPACES[item['space']] - item['start'])):
        raise ValueError('Invalid persistent storage range; use canonical space-relative offsets')
    return item['space'], item['start'], item['start'] + item['length']


def _overlap(first, second):
    sa, a, b = _range(first)
    sb, c, d = _range(second)
    return sa == sb and a < d and c < b


def _ranges(items):
    if not isinstance(items, list) or len(items) > 256:
        raise ValueError('Expected a bounded storage range list')
    for i, item in enumerate(items):
        _range(item)
        if not nonempty(item.get('purpose')):
            raise ValueError('Every policy range requires its purpose')
        if any(_overlap(item, previous) for previous in items[:i]):
            raise ValueError('Policy ranges overlap')
    return items


def _image_range(data, region):
    space, start, end = _range(region)
    cursor = start
    chunks = []
    for low, high, offset in INSTALLATION[space]:
        if low <= cursor < high:
            stop = min(high, end)
            chunks.append(data[256 + offset + cursor - low:256 + offset + stop - low])
            cursor = stop
            if cursor == end:
                return b''.join(chunks)
    raise ValueError('Recovery dependency is not fully supplied by the baseline image')


def _changed_ranges(data, baseline):
    changed = []
    for space, mappings in INSTALLATION.items():
        for low, high, offset in mappings:
            start = None
            for index in range(high - low):
                differs = data[256 + offset + index] != baseline[256 + offset + index]
                if differs and start is None:
                    start = low + index
                elif not differs and start is not None:
                    changed.append({'space': space, 'start': start, 'length': low + index - start})
                    start = None
            if start is not None:
                changed.append({'space': space, 'start': start, 'length': high - start})
    return changed


def _covered(region, ranges):
    space, cursor, end = _range(region)
    for item in sorted((r for r in ranges if r['space'] == space), key=lambda r: r['start']):
        if item['start'] > cursor:
            break
        cursor = max(cursor, item['start'] + item['length'])
        if cursor >= end:
            return True
    return False


def _policy(raw, approved, baseline, spec_version, artifact_root):
    if not digest(approved) or sha(raw) != approved:
        raise ValueError('Recovery policy is not pinned to the reviewer-approved SHA-256')
    policy = _object(raw, 'sq64-recovery-policy')
    if policy.get('specVersion') != spec_version:
        raise ValueError('Recovery policy belongs to another specification revision')
    if not isinstance(baseline, (bytes, bytearray)) or policy.get('baselineSha256') != sha(baseline):
        raise ValueError('Recovery policy requires the exact approved baseline VSB')
    if any(row['status'] != 'pass' for row in inspect(baseline)[1]):
        raise ValueError('Baseline VSB fails image checks')
    if not nonempty(policy.get('reviewRevision')):
        raise ValueError('Recovery policy requires a review revision')
    if not isinstance(policy.get('installer'), dict) or read_artifact(policy['installer'], artifact_root) is None:
        raise ValueError('Verified installer artifact and --artifact-root are required')
    if not isinstance(policy.get('observer'), dict) or read_artifact(policy['observer'], artifact_root) is None:
        raise ValueError('Verified write-observer artifact is required')
    protected = [FROZEN_INTERNAL] + _ranges(policy.get('protected'))
    for region in protected[1:]:
        if region.get('kind') not in ('recovery', 'reserved', 'calibration'):
            raise ValueError('Protected ranges must identify recovery, reserved or calibration ownership')
        if _overlap(region, FROZEN_INTERNAL):
            raise ValueError('The mandatory internal recovery range cannot be redefined')
    writes = policy.get('writes')
    if not isinstance(writes, dict) or set(writes) != {'installation', 'runtime'}:
        raise ValueError('Policy must declare separate installation and runtime write allowlists')
    for regions in writes.values():
        for region in _ranges(regions):
            if any(_overlap(region, guard) for guard in protected):
                raise ValueError('Write allowlist overlaps protected storage')
    geometry = policy.get('spiGeometry')
    if (not isinstance(geometry, dict) or not integer(geometry.get('pageSize'), 1, SPACES['spi-flash'])
            or geometry['pageSize'] & (geometry['pageSize'] - 1)
            or not isinstance(geometry.get('eraseSizes'), list) or not geometry['eraseSizes']):
        raise ValueError('Reviewed SPI page and erase geometry is required')
    for size in geometry['eraseSizes']:
        if not integer(size, 1, SPACES['spi-flash']) or size & (size - 1):
            raise ValueError('Invalid SPI erase geometry')
    if len(set(geometry['eraseSizes'])) != len(geometry['eraseSizes']):
        raise ValueError('Duplicate SPI erase sizes')
    return policy, protected


def _trace(raw, policy, identity, protected, contexts, model_hash, changed):
    trace = _object(raw, 'sq64-write-trace')
    for key in ('imageSha256', 'baselineSha256', 'policySha256', 'installerSha256', 'observerSha256'):
        if trace.get(key) != identity[key]:
            raise ValueError('Write trace identity mismatch: ' + key)
    runs = trace.get('runs')
    if not isinstance(runs, list) or not runs or len(runs) > 1024:
        raise ValueError('Write trace requires bounded installation and runtime runs')
    failures = {identifier: [] for identifier in RECOVERY_IDS[1:4]}
    phases, names = set(), set()
    total = 0
    for run in runs:
        if (not isinstance(run, dict) or not nonempty(run.get('name')) or run['name'] in names
                or run.get('phase') not in ('installation', 'runtime') or run.get('complete') is not True
                or run.get('captureStart') != 'before-execution'
                or run.get('captureEnd') != 'after-completion'
                or run.get('baselineIdentity') != 'content-measurement'
                or run.get('coverage') != 'all-persistent-mutation-attempts'):
            raise ValueError('Incomplete, duplicate or unbounded write-trace run')
        names.add(run['name'])
        phases.add(run['phase'])
        name = run.get('context')
        context = contexts.get(name) if isinstance(name, str) else None
        if (not isinstance(context, dict) or context.get('kind') not in ('hardware', 'emulator')
                or context.get('target') != 'candidate'):
            raise ValueError('Trace requires a candidate execution context, not review/probe evidence')
        if context['kind'] == 'emulator' and context.get('modelContractSha256') != model_hash:
            raise ValueError('Trace emulator context belongs to another model contract')
        tool_hashes = {t.get('sha256') for t in context.get('tools', []) if isinstance(t, dict)}
        if identity['observerSha256'] not in tool_hashes:
            raise ValueError('Trace context does not identify the approved observer')
        if run['phase'] == 'installation' and identity['installerSha256'] not in tool_hashes:
            raise ValueError('Trace context does not identify the approved installer')
        events = run.get('events')
        if (not isinstance(events, list) or not integer(run.get('eventCount'), 0, 1000000)
                or run['eventCount'] != len(events)):
            raise ValueError('Write trace is truncated or has an invalid event count')
        total += len(events)
        if total > 1000000:
            raise ValueError('Write trace exceeds event limit')
        programmed = []
        for index, event in enumerate(events):
            if not isinstance(event, dict) or not integer(event.get('sequence'), 0, 999999) or event['sequence'] != index:
                raise ValueError('Write trace event sequence is missing, duplicated or out of order')
            operation = event.get('operation')
            if not isinstance(operation, str):
                raise ValueError('Missing write operation classification')
            label = f"{run['name']} event {index}"
            if operation in FORBIDDEN:
                failures['RECOVERY-003'].append(label + ': forbidden ' + operation)
                continue
            if operation not in ('erase', 'program'):
                raise ValueError('Unrecognized persistent operation: ' + operation)
            space, start, end = _range(event)
            if operation == 'program':
                programmed.append(event)
            if any(_overlap(event, guard) for guard in protected):
                failures['RECOVERY-002'].append(label + ': attempted mutation of protected storage')
            allowed = policy['writes'][run['phase']]
            if not any(space == r['space'] and r['start'] <= start and end <= r['start'] + r['length'] for r in allowed):
                failures['RECOVERY-004'].append(label + ': mutation is outside a single approved write range')
            if space == 'spi-flash':
                geometry = policy['spiGeometry']
                if operation == 'erase' and (event['length'] not in geometry['eraseSizes'] or start % event['length']):
                    failures['RECOVERY-004'].append(label + ': unapproved or unaligned erase geometry')
                if operation == 'program' and start // geometry['pageSize'] != (end - 1) // geometry['pageSize']:
                    failures['RECOVERY-004'].append(label + ': program crosses page boundary')
        if run['phase'] == 'installation' and any(not _covered(region, programmed) for region in changed):
            raise ValueError('Installation trace does not cover every changed payload byte')
    if phases != {'installation', 'runtime'}:
        raise ValueError('Both complete installation and runtime captures are mandatory')
    checks = [{'id': key, 'status': 'fail' if reasons else 'pass',
               'detail': '; '.join(reasons[:20]) if reasons else 'No prohibited operations in the supplied bounded captures',
               'violationCount': len(reasons)} for key, reasons in failures.items()]
    return checks, {'runs': len(runs), 'events': total}


def evaluate_recovery(data, *, baseline, policy_data, approved_policy_sha256, trace_data,
                      evidence, contexts, artifact_root, spec_version, model_hash):
    result = {'status': 'fail', 'checks': [], 'recoveryGuaranteed': False,
              'claim': 'Policy and bounded observation checks; no runtime isolation or universal recovery guarantee'}
    try:
        if policy_data is None:
            raise ValueError('Missing reviewer-pinned recovery policy')
        policy, protected = _policy(policy_data, approved_policy_sha256, baseline, spec_version, artifact_root)
        identity = {'imageSha256': sha(data), 'baselineSha256': sha(baseline),
                    'policySha256': sha(policy_data), 'installerSha256': policy['installer']['artifactSha256'],
                    'observerSha256': policy['observer']['artifactSha256']}
        result.update(identity)
        if trace_data is None:
            raise ValueError('Missing installation/runtime write trace')
        identity['traceSha256'] = sha(trace_data)
        result['traceSha256'] = identity['traceSha256']
        if (not isinstance(evidence, dict) or evidence.get('version') != 2
                or evidence.get('recovery') != identity):
            raise ValueError('Evidence is not bound to this exact recovery policy, baseline, installer, observer and trace')
        if len(data) != 0x38100:
            raise ValueError('Candidate is not a full-system VSB')
        changed = []
        for region in protected:
            if region['kind'] == 'recovery':
                if _image_range(data, region) != _image_range(baseline, region):
                    changed.append(region['purpose'])
        result['checks'].append({'id': 'RECOVERY-001', 'status': 'fail' if changed else 'pass',
                                 'detail': 'Changed protected recovery bytes: ' + ', '.join(changed) if changed
                                 else 'Mandatory first 64 KiB and all declared recovery dependencies match the approved baseline'})
        changed_ranges = _changed_ranges(data, baseline)
        checks, counts = _trace(trace_data, policy, identity, protected, contexts, model_hash, changed_ranges)
        if any(not _covered(region, policy['writes']['installation'])
               or any(_overlap(region, guard) for guard in protected) for region in changed_ranges):
            check = next(c for c in checks if c['id'] == 'RECOVERY-004')
            check.update(status='fail', detail='Candidate changes bytes outside approved installation ranges or inside protected storage')
        result['checks'].extend(checks)
        result.update(counts)
        result['status'] = 'fail' if any(c['status'] == 'fail' for c in result['checks']) else 'pass'
    except (ValueError, OSError) as error:
        result['error'] = str(error)
    return result
