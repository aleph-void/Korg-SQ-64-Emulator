"""Strict JSON and bounded scalar inputs shared by the public validators."""
import json
import math
import re


def load_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f'Duplicate JSON key: {key}')
            result[key] = value
        return result

    def constant(value):
        raise ValueError(f'Non-finite JSON number: {value}')

    def decimal(value):
        result = float(value)
        if not math.isfinite(result):
            raise ValueError(f'Non-finite JSON number: {value}')
        return result

    return json.loads(text, object_pairs_hook=pairs, parse_constant=constant, parse_float=decimal)


def integer(value, low, high):
    return type(value) is int and low <= value <= high


def finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def digest(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def unhex(value, *, maximum):
    if (not isinstance(value, str) or len(value) > maximum * 2
            or len(value) % 2 or re.fullmatch('[0-9a-fA-F]*', value) is None):
        raise ValueError('Invalid or oversized hexadecimal data')
    return bytes.fromhex(value)
