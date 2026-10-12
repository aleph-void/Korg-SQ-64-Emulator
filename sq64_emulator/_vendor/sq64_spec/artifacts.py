"""Confined, digest-verified artifact access shared by evidence and policies."""
import hashlib
from pathlib import Path, PurePosixPath

from .validation import digest, nonempty


def read_artifact(item, root):
    if not isinstance(item, dict) or not nonempty(item.get('artifact')) or not digest(item.get('artifactSha256')):
        raise ValueError('Artifact path and SHA-256 are required')
    relative = PurePosixPath(item['artifact'])
    if (relative.is_absolute() or '..' in relative.parts or '\\' in item['artifact']
            or ':' in item['artifact'] or not relative.parts):
        raise ValueError('Artifact escapes evidence root')
    if root is None:
        return None
    root = Path(root).resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ValueError('Artifact escapes evidence root')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['artifactSha256']:
        raise ValueError('Artifact digest mismatch')
    return raw
