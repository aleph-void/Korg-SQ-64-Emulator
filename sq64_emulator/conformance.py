"""Run the pinned upstream image profile on the exact caller-supplied file."""
from ._vendor.sq64_spec.report import evaluate

SPEC_SOURCE = {
    'url': 'https://github.com/aleph-void/Korg-SQ-64-Custom-Firmware-Spec',
    'revision': 'a71297981a601b5e69e5d44dc44ada897050df3d',
}


def validate_image(content):
    return dict(evaluate(bytes(content), profile='image'),
                specSource=dict(SPEC_SOURCE), inputScope='loaded-file')
