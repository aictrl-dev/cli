"""Pinned offline reference accounting shared by CI and release comparisons."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import os
import socket
import sys

INPUT_FIELDS = ('instructions', 'messages', 'input', 'tools', 'response_format', 'text')
RANK_SHA256 = '446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d'
RANK_KEY = hashlib.sha1(b'https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken').hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def input_text(body):
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise ValueError('Request body must be an object')
    selected = {key: payload[key] for key in INPUT_FIELDS if key in payload}
    if not any(key in selected for key in ('instructions', 'messages', 'input')):
        raise ValueError('No model input found')
    return canonical(selected)


def output_text(response):
    if response['kind'] == 'text':
        return response['text']
    if response['kind'] == 'tool':
        return canonical({'name': response['name'], 'arguments': response['arguments']})
    raise ValueError('Unknown response kind: ' + str(response.get('kind')))


def load_encoding():
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError('Require provisioned Python 3.12')
    if importlib.metadata.version('tiktoken') != '0.12.0':
        raise RuntimeError('Require pinned tiktoken 0.12.0')
    cache = Path(sys.prefix).parent / 'cache'
    rank = cache / RANK_KEY
    if not rank.is_file() or hashlib.sha256(rank.read_bytes()).hexdigest() != RANK_SHA256:
        raise RuntimeError('Missing or mismatched pinned o200k rank data; rerun explicit setup')
    attempts = []

    def deny(*args, **kwargs):
        attempts.append(repr(args))
        raise RuntimeError('Offline reference counter forbids network')

    socket.socket.connect = deny
    socket.socket.connect_ex = deny
    socket.create_connection = deny
    socket.getaddrinfo = deny
    os.environ['TIKTOKEN_CACHE_DIR'] = str(cache)
    import tiktoken
    encoding = tiktoken.get_encoding('o200k_base')
    if attempts:
        raise RuntimeError('Unexpected tokenizer network attempt')
    if len(encoding.encode_ordinary('hello world')) != 2:
        raise RuntimeError('Known-string tokenizer parity failed')
    return encoding
