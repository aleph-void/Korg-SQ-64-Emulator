"""Run the pinned upstream image profile on the exact caller-supplied file."""
from ._vendor.sq64_spec.report import catalog, evaluate

SPEC_SOURCE = {
    'url': 'https://github.com/aleph-void/Korg-SQ-64-Custom-Firmware-Spec',
    'revision': '0212e997d27393c5cb6cee48b2a8387f059f1251',
}


def validate_image(content):
    report = dict(evaluate(bytes(content), profile='image'),
                  specSource=dict(SPEC_SOURCE), inputScope='loaded-file')
    requirements = {r['id']: r for r in catalog()['requirements']}
    for row in report['results']:
        requirement = requirements.get(row['id'], {})
        for key in ('severity', 'unsafeWhen'):
            if key in requirement:
                row.setdefault(key, requirement[key])
    return report


def critical_stop(report):
    tests = [row for row in report.get('results', [])
             if row.get('severity') == 'critical' and row.get('unsafeWhen') == 'pass'
             and row.get('status') == 'pass']
    if not tests:
        return None
    return {'reason': 'critical-conformance-pass', 'imageSha256': report.get('imageSha256'),
            'tests': tests,
            'message': report.get('warning') or f"Emulator terminated: critical test {', '.join(row['id'] for row in tests)} passed, "
                       'indicating behavior that could damage a hardware device. '
                       'Do not flash this firmware to a real device.'}
