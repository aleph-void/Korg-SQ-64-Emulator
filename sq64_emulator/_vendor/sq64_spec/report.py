"""Evidence accounting. Artifact integrity does not certify its observations."""
import hashlib
from pathlib import Path, PurePosixPath

from .declaration import validate_declaration, measurements_pass
from .image import inspect
from .validation import digest, load_json, nonempty


def catalog():
    return load_json(Path(__file__).with_name('requirements.json').read_text())


def model_contract_digest():
    return hashlib.sha256(Path(__file__).with_name('board.json').read_bytes()).hexdigest()


def _contexts(evidence):
    contexts = evidence.get('contexts')
    if not isinstance(contexts, dict):
        raise ValueError('Evidence v2 requires named execution contexts')
    for name, context in contexts.items():
        if (not nonempty(name) or not isinstance(context, dict)
                or context.get('kind') not in ('hardware', 'emulator', 'review')
                or context.get('target') not in ('candidate', 'probe')
                or any(not nonempty(context.get(k)) for k in ('environment', 'sourceRevision', 'fixtureRevision'))):
            raise ValueError('Invalid evidence execution context')
        tool_list = context.get('tools')
        if not isinstance(tool_list, list) or not tool_list:
            raise ValueError('Evidence context requires tool identities')
        for tool in tool_list:
            if (not isinstance(tool, dict) or not nonempty(tool.get('name'))
                    or not nonempty(tool.get('version')) or not digest(tool.get('sha256'))):
                raise ValueError('Tool name, version and SHA-256 are required')
    return contexts


def _artifact(item, root):
    if (any(not nonempty(item.get(k)) for k in ('procedure', 'observations', 'artifact'))
            or not digest(item.get('artifactSha256'))):
        raise ValueError('Passing evidence requires procedure, observations, artifact path and SHA-256')
    relative = PurePosixPath(item['artifact'])
    if (relative.is_absolute() or '..' in relative.parts or '\\' in item['artifact']
            or ':' in item['artifact'] or not relative.parts):
        raise ValueError('Artifact escapes evidence root')
    if root is None:
        return False
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ValueError('Artifact escapes evidence root')
    if hashlib.sha256(path.read_bytes()).hexdigest() != item['artifactSha256']:
        raise ValueError('Artifact digest mismatch')
    return True


def evaluate(data, *, profile='hardware', evidence=None, artifact_root=None, declaration=None):
    document = catalog()
    if not isinstance(profile, str) or profile not in document['profiles']:
        raise ValueError('Unknown conformance profile')
    image_digest, static = inspect(data)
    requirements = {r['id']: r for r in document['requirements']}
    limits = {} if declaration is None else validate_declaration(declaration, image_digest, document['requirements'])
    results = {r['id']: dict(r, provenance='executed image check') for r in static}
    applicable = [r for r in document['requirements'] if profile in r['profiles']]
    accepted, seen = {}, set()
    contexts = {}
    if evidence is not None:
        if (not isinstance(evidence, dict) or evidence.get('format') != 'sq64-evidence'
                or type(evidence.get('version')) is not int or evidence['version'] not in (1, 2)
                or evidence.get('imageSha256') != image_digest):
            raise ValueError('Evidence is not bound to this exact image')
        version = evidence['version']
        if version == 2:
            if evidence.get('specVersion') != document['version']:
                raise ValueError('Evidence is for another spec revision')
            contexts = _contexts(evidence)
        if not isinstance(evidence.get('results'), list):
            raise ValueError('Missing evidence results')
        root = Path(artifact_root).resolve() if artifact_root is not None else None
        for item in evidence['results']:
            if not isinstance(item, dict):
                raise ValueError('Invalid evidence item')
            identifier = item.get('id')
            if not isinstance(identifier, str) or identifier not in requirements or identifier in seen:
                raise ValueError('Unknown or duplicate evidence requirement')
            seen.add(identifier)
            requirement = requirements[identifier]
            if 'image' in requirement['profiles']:
                raise ValueError('Static checks cannot be overridden by evidence')
            if item.get('status') not in ('pass', 'fail', 'not-run'):
                raise ValueError('Invalid evidence status')
            row = dict(item, provenance='external observations; not independently reproduced', artifactVerified=False)
            reasons = []
            if item['status'] == 'pass':
                row['artifactVerified'] = _artifact(item, root)
                if not row['artifactVerified']:
                    reasons.append('Artifact not verified; supply --artifact-root')
                if version == 1:
                    reasons.append('Legacy evidence lacks execution and tool identity; migrate to v2')
                else:
                    context_name = item.get('context')
                    if not isinstance(context_name, str) or context_name not in contexts:
                        raise ValueError('Passing evidence requires a known context')
                    context = contexts[context_name]
                    if context['kind'] == 'emulator' and context.get('modelContractSha256') != model_contract_digest():
                        raise ValueError('Emulator context must identify this model contract SHA-256')
                    kinds = requirement['evidenceKinds'] + (['emulator'] if profile == 'software' else [])
                    if context['kind'] not in kinds:
                        reasons.append('Execution kind does not satisfy the requirement')
                    if context['target'] != 'candidate':
                        reasons.append('Diagnostic probe does not establish candidate behavior')
                    if declaration is None:
                        reasons.append('Candidate feature declaration is missing')
                    elif context['sourceRevision'] != declaration['sourceRevision']:
                        raise ValueError('Evidence source revision differs from candidate declaration')
                    cases = item.get('cases')
                    if not isinstance(cases, list) or not cases:
                        raise ValueError('Passing evidence requires explicit cases and expectations')
                    names = set()
                    for case in cases:
                        if (not isinstance(case, dict)
                                or any(not nonempty(case.get(k)) for k in ('name', 'expected', 'observed'))
                                or case.get('status') not in ('pass', 'fail', 'not-run')):
                            raise ValueError('Invalid evidence case')
                        if case['name'] in names:
                            raise ValueError('Duplicate evidence case')
                        names.add(case['name'])
                        if case['status'] == 'fail':
                            row.update(status='fail', suppliedStatus='pass', detail='A recorded case failed')
                        elif case['status'] == 'not-run':
                            reasons.append('A recorded case has not run')
                    missing = set(requirement['cases']) - names
                    if missing:
                        reasons.append('Missing required cases: ' + ', '.join(sorted(missing)))
                    if declaration is not None:
                        complete, passed = measurements_pass(item, limits)
                        if not complete:
                            reasons.append('A declared measurement is missing')
                        if requirement.get('quantitative') and not any(k[0] == identifier for k in limits):
                            reasons.append('Quantitative acceptance limits are missing')
                        if not passed:
                            row.update(status='fail', suppliedStatus='pass', detail='Measured uncertainty interval exceeds declared bounds')
                if reasons:
                    row['limitations'] = reasons
                    if row['status'] != 'fail':
                        row.update(status='not-run', suppliedStatus='pass', detail='; '.join(reasons))
            accepted[identifier] = row
    rows = [results.get(r['id']) or accepted.get(r['id']) or
            {'id': r['id'], 'status': 'not-run', 'detail': r['verification']} for r in applicable]
    blockers = [] if profile in ('image', 'software') else list(document['releaseBlockers'])
    if profile != 'image' and declaration is None:
        blockers.append('Candidate feature declaration is missing')
    if profile == 'korg-compatible' and declaration and declaration['deviations']:
        blockers.append('Declared deviations prevent a strict Korg compatibility claim')
    status = ('fail' if any(r['status'] == 'fail' for r in rows) else
              'incomplete' if blockers or any(r['status'] != 'pass' for r in rows) else 'pass')
    return {'format': 'sq64-conformance-report', 'version': 2, 'specVersion': document['version'],
            'profile': profile, 'imageSha256': image_digest, 'status': status, 'results': rows,
            'modelContractSha256': model_contract_digest(),
            'counts': {s: sum(r['status'] == s for r in rows) for s in ('pass', 'fail', 'not-run')},
            'releaseBlockers': blockers, 'contexts': contexts, 'declaration': declaration,
            'claim': 'Bounded checks for the named profile; not proof for every input or event schedule',
            'hardwareValidated': False, 'externalEvidenceAccepted': bool(accepted)}


def evidence_template(data, profile):
    document = catalog()
    if profile not in document['profiles']:
        raise ValueError('Unknown conformance profile')
    return {'format': 'sq64-evidence', 'version': 2, 'specVersion': document['version'],
            'imageSha256': hashlib.sha256(data).hexdigest(), 'contexts': {},
            'results': [{'id': r['id'], 'status': 'not-run', 'procedure': r['verification'],
                         'cases': [{'name': case, 'status': 'not-run', 'expected': '', 'observed': ''}
                                   for case in r['cases']]}
                        for r in document['requirements'] if profile in r['profiles'] and 'image' not in r['profiles']]}
