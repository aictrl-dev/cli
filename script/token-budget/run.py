#!/usr/bin/env python3
"""Linux-only public CLI SDK capture; no downloads or model traffic."""
import argparse
import ctypes
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
FIXTURE = Path('/tmp/aictrl-token-budget')
WORKSPACE = FIXTURE / 'workspace'


def execute(command, cwd, env, limit=25):
    child = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    timed = False
    try:
        stdout, stderr = child.communicate(timeout=limit)
    except subprocess.TimeoutExpired:
        timed = True
        os.killpg(child.pid, signal.SIGKILL)
        stdout, stderr = child.communicate(timeout=5)
    surviving = False
    try:
        os.killpg(child.pid, 0)
        surviving = True
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    # As a Linux subreaper, reap orphaned members after terminating our owned group.
    end = time.monotonic() + 2
    while True:
        try:
            pid, _ = os.waitpid(-child.pid, os.WNOHANG)
            if not pid and time.monotonic() < end:
                time.sleep(0.01)
                continue
            if not pid:
                break
        except ChildProcessError:
            break
    try:
        os.killpg(child.pid, 0)
        raise RuntimeError('Owned process group remains after cleanup')
    except ProcessLookupError:
        pass
    return {'exit': child.returncode, 'timedOut': timed, 'remaining_group_killed': surviving,
            'process_group': child.pid, 'command': command}, stdout, stderr


def verify(result):
    if result['remaining_group_killed']:
        raise RuntimeError('Owned process group survived controller exit; capture rejected after cleanup')
    if result['exit'] or result['timedOut']:
        raise RuntimeError('Capture failed or exceeded deadline: ' + json.dumps(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='New evidence directory; never overwritten')
    parser.add_argument('--repeats', type=int, default=2)
    parser.add_argument('--source', type=Path, default=ROOT.parents[1] / 'packages/cli/src/index.ts',
                        help='Explicit alternate source entry for isolated source-growth controls; CI uses repository entry')
    parser.add_argument('--observe', action='store_true', help='Report observations without enforcing budgets (evaluation only)')
    args = parser.parse_args()
    if sys.platform != 'linux' or sys.version_info[:2] != (3, 12):
        raise RuntimeError('Require Linux and provisioned Python 3.12')
    if args.repeats < 2:
        raise ValueError('At least two cold captures per arm required')
    bun = shutil.which('bun')
    if not bun or not shutil.which('rg'):
        raise RuntimeError('Require real bun and ripgrep on PATH; install prerequisites before offline capture')
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError('Unable to establish Linux child subreaper')
    try:
        FIXTURE.mkdir(mode=0o700)
    except FileExistsError:
        info = FIXTURE.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError('Fixed fixture must be an owned private directory, never a symlink')
    fd = os.open(FIXTURE / 'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Exclusive fixed workspace is already in use')
        output = args.output.resolve()
        if output.is_relative_to(FIXTURE):
            raise ValueError('Evidence output must be outside the fixed fixture directory')
        output.mkdir(parents=True, exist_ok=False)
        records = []
        for arm in ['default', 'four']:
            for repeat in range(1, args.repeats + 1):
                out = output / f'{arm}-{repeat}'
                out.mkdir()
                if WORKSPACE.is_symlink():
                    raise RuntimeError('Refusing a symlink fixed workspace')
                if WORKSPACE.exists():
                    shutil.rmtree(WORKSPACE)
                WORKSPACE.mkdir()
                env = {'PATH': os.pathsep.join([str(Path(bun).parent), '/usr/local/bin', '/usr/bin', '/bin']),
                       'HOME': str(out / 'controller-home'), 'XDG_CACHE_HOME': str(out / 'controller-cache'),
                       'BUN_RUNTIME_TRANSPILER_CACHE_PATH': str(out / 'controller-bun-cache'),
                       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'TZ': 'UTC',
                       'TOKEN_BUDGET_OUTPUT': str(out), 'TOKEN_BUDGET_WORKSPACE': str(WORKSPACE),
                       'TOKEN_BUDGET_SOURCE': str(args.source.resolve(strict=True)),
                       'TOKEN_BUDGET_ARM': arm}
                subprocess.run(['git', '-c', 'init.defaultBranch=fixture', 'init', '--quiet', str(WORKSPACE)],
                               env=env, check=True, stdin=subprocess.DEVNULL)
                result, stdout, stderr = execute([bun, 'run', '--no-install', '--no-env-file', str(ROOT / 'capture.ts')], ROOT, env)
                result.update(arm=arm, repeat=repeat)
                (out / 'controller.log').write_text(stdout + stderr)
                (out / 'controller-result.json').write_text(json.dumps(result, indent=2) + '\n')
                verify(result)
                records.append(result)
        (output / 'campaign.json').write_text(json.dumps({'runs': records, 'workspace': str(WORKSPACE),
            'raw_normalization': False, 'repeats': args.repeats, 'source_entry': str(args.source.resolve())}, indent=2) + '\n')
        subprocess.run([sys.executable, '-I', '-B', str(ROOT / 'count.py'), str(output),
                        *(['--observe'] if args.observe else [])], check=True,
                       env={'PATH': env['PATH'], 'HOME': str(output / 'counter-home'), 'TZ': 'UTC'})


if __name__ == '__main__':
    main()
