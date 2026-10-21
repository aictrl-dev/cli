#!/usr/bin/env python3
"""Online SETUP ONLY: owned Python environment and checksum-verified rank data."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import urllib.request
import venv

ROOT = Path(__file__).resolve().parent
URL = 'https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken'
SHA = '446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d'
KEY = hashlib.sha1(URL.encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True, help='New owned environment directory')
    args = parser.parse_args()
    if sys.platform != 'linux' or platform.machine() != 'x86_64' or sys.version_info[:2] != (3, 12):
        raise RuntimeError('Lock targets Python 3.12 Linux x86_64')
    directory = args.directory.resolve()
    directory.mkdir(parents=True, exist_ok=False)
    venv.create(directory / 'venv', with_pip=True)
    python = directory / 'venv/bin/python3'
    subprocess.run([str(python), '-I', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
                    '--cache-dir', str(directory / 'wheel-cache'), '--index-url', 'https://pypi.org/simple', '--only-binary=:all:', '--require-hashes',
                    '--no-deps', '-r', str(ROOT / 'requirements.lock')], check=True)
    with urllib.request.urlopen(URL, timeout=30) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != SHA:
        raise RuntimeError('Pinned o200k rank SHA256 mismatch')
    cache = directory / 'cache'
    cache.mkdir()
    (cache / KEY).write_bytes(data)
    (directory / 'setup.json').write_text(json.dumps({'python': sys.version, 'rank_url': URL,
        'rank_sha256': SHA, 'rank_bytes': len(data),
        'requirements_sha256': hashlib.sha256((ROOT / 'requirements.lock').read_bytes()).hexdigest()}, indent=2) + '\n')
    print(f'Offline command: {python} -I -B {ROOT / "run.py"} --output NEW_DIRECTORY')


if __name__ == '__main__':
    main()
