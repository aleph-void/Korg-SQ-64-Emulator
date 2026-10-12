"""Candidate-specific features and predeclared measurement bounds."""
from .validation import finite, nonempty

FEATURES = ('power', 'midi', 'sequencing', 'storage', 'recovery', 'outputs', 'clocks')


def validate_declaration(document, image_digest, requirements):
    if (not isinstance(document, dict) or document.get('format') != 'sq64-candidate'
            or type(document.get('version')) is not int or document['version'] != 1
            or document.get('imageSha256') != image_digest
            or not nonempty(document.get('sourceRevision'))):
        raise ValueError('Candidate declaration must identify the exact image and source revision')
    features = document.get('features')
    if not isinstance(features, dict) or any(not nonempty(features.get(k)) for k in FEATURES):
        raise ValueError('Declare power, MIDI, sequencing, storage, recovery, outputs and clocks')
    deviations = document.get('deviations')
    if not isinstance(deviations, list) or not all(nonempty(x) for x in deviations):
        raise ValueError('Declare compatibility deviations, using an empty list for none')
    limits = document.get('limits')
    if not isinstance(limits, list):
        raise ValueError('Declare quantitative limits, using an empty list when none are established')
    known = {r['id'] for r in requirements}
    indexed = {}
    for limit in limits:
        if (not isinstance(limit, dict) or not isinstance(limit.get('id'), str)
                or limit['id'] not in known or not nonempty(limit.get('metric'))
                or not nonempty(limit.get('unit')) or not finite(limit.get('min'))
                or not finite(limit.get('max')) or limit['min'] > limit['max']):
            raise ValueError('Invalid candidate measurement limit')
        key = (limit['id'], limit['metric'])
        if key in indexed:
            raise ValueError('Duplicate candidate measurement limit')
        indexed[key] = limit
    return indexed


def measurements_pass(item, limits):
    """Require every declared metric and fit its entire uncertainty interval."""
    required = {metric: limit for (identifier, metric), limit in limits.items() if identifier == item['id']}
    values = item.get('measurements', [])
    if not isinstance(values, list):
        raise ValueError('Measurements must be an array')
    seen = set()
    passed = True
    for measurement in values:
        if (not isinstance(measurement, dict) or not nonempty(measurement.get('metric'))
                or not nonempty(measurement.get('unit')) or not finite(measurement.get('value'))
                or not finite(measurement.get('uncertainty')) or measurement['uncertainty'] < 0):
            raise ValueError('Invalid measured value or uncertainty')
        name = measurement['metric']
        if name in seen or name not in required:
            raise ValueError('Duplicate or undeclared measurement')
        seen.add(name)
        limit = required[name]
        if measurement['unit'] != limit['unit']:
            raise ValueError('Measurement unit differs from declared bound')
        passed &= (limit['min'] <= measurement['value'] - measurement['uncertainty']
                   and measurement['value'] + measurement['uncertainty'] <= limit['max'])
    return required.keys() == seen, passed
