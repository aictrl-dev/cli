#!/usr/bin/env python3
"""Linux-only public CLI SDK capture; no downloads or model traffic."""
import argparse
import ctypes
import errno
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
import traceback

ROOT = Path(__file__).resolve().parent
FIXTURE = Path('/tmp/aictrl-token-budget')
WORKSPACE = FIXTURE / 'workspace'


def _reap_descendants(limit=2):
    # Called only in a fresh forked subreaper: it has no caller-owned children.
    # waitid(WNOWAIT) proves each PID is our unreaped direct child. Until we
    # explicitly waitpid it, even an exiting child cannot release/reuse its PID.
    end = time.monotonic() + limit
    surviving = False
    records = []
    while True:
        children = Path(f'/proc/self/task/{os.getpid()}/children').read_text().split()
        if not children:
            try:
                os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return surviving, records
            raise RuntimeError('Owned child inventory incomplete; refusing unproven cleanup')
        for value in children:
            pid = int(value)
            state = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if state is not None:
                os.waitpid(pid, 0)
                records.append({'pid': pid, 'state': 'reaped', 'owner': os.getpid()})
                continue
            surviving = True
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                # Still unreaped: this identity cannot have become a foreign PID.
                pass
            records.append({'pid': pid, 'state': 'live-killed', 'owner': os.getpid()})
        if time.monotonic() >= end:
            raise RuntimeError('Owned descendants remain after cleanup deadline: ' + ','.join(children))
        time.sleep(0.005)


def _capture(command, cwd, env, limit, cancelled):
    child = None
    primary = None
    timed = False
    surviving = False
    records = []
    stdout = stderr = ''
    try:
        child = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        end = time.monotonic() + limit
        while child.poll() is None:
            if cancelled():
                raise InterruptedError('Capture supervisor interrupted')
            remaining = end - time.monotonic()
            if remaining <= 0:
                timed = True
                break
            try:
                stdout, stderr = child.communicate(timeout=min(0.05, remaining))
            except subprocess.TimeoutExpired:
                # Recheck the actual parent, even while a descendant holds a pipe.
                pass
    except BaseException as error:
        primary = error
        raise
    finally:
        errors = []
        if child is not None and child.poll() is None:
            try:
                child.kill()
            except ProcessLookupError:
                pass
            except Exception as error:
                errors.append(error)
            try:
                child.wait(timeout=5)
            except Exception as error:
                errors.append(error)
        try:
            surviving, records = _reap_descendants()
        except Exception as error:
            errors.append(error)
        if child is not None:
            try:
                stdout, stderr = child.communicate(timeout=5)
            except Exception as error:
                errors.append(error)
            finally:
                for stream in (child.stdout, child.stderr):
                    if stream is not None:
                        try:
                            stream.close()
                        except Exception as error:
                            errors.append(error)
        if errors:
            detail = 'Owned capture cleanup failed: ' + '; '.join(str(error) for error in errors)
            if primary is not None:
                primary.add_note(detail)
            else:
                raise RuntimeError(detail) from errors[0]
    return {'exit': child.returncode, 'timedOut': timed, 'remaining_group_killed': surviving,
            'process_group': child.pid, 'supervisor': os.getpid(),
            'descendant_cleanup': records, 'command': command}, stdout, stderr


def execute(command, cwd, env, limit=25):
    # A separate fork is an ownership boundary, not a network/security sandbox.
    # Its only children are the capture and descendants adopted from that capture.
    read, write = os.pipe()
    try:
        supervisor = os.fork()
    except BaseException:
        os.close(read)
        os.close(write)
        raise
    if supervisor == 0:
        status = 1
        try:
            os.close(read)
            interrupted = False

            def cancel(number, frame):
                nonlocal interrupted
                interrupted = True

            try:
                # Do not retain the caller's unrelated pipes/files in this fork.
                for value in os.listdir('/proc/self/fd'):
                    descriptor = int(value)
                    if descriptor > 2 and descriptor != write:
                        try:
                            os.close(descriptor)
                        except OSError as error:
                            if error.errno != errno.EBADF:
                                raise
                signal.signal(signal.SIGTERM, cancel)
                signal.signal(signal.SIGINT, cancel)
                signal.signal(signal.SIGCHLD, signal.SIG_DFL)
                if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
                    raise OSError(ctypes.get_errno(), 'Unable to establish owned Linux child subreaper')
                result, stdout, stderr = _capture(command, cwd, env, limit, lambda: interrupted)
                payload = {'result': result, 'stdout': stdout, 'stderr': stderr}
            except BaseException as error:
                payload = {'error': {'type': type(error).__name__, 'message': str(error),
                    'errno': getattr(error, 'errno', None), 'strerror': getattr(error, 'strerror', None),
                    'filename': getattr(error, 'filename', None),
                    'traceback': ''.join(traceback.format_exception(error))}}
            with os.fdopen(write, 'w') as stream:
                json.dump(payload, stream)
            status = 0 if 'result' in payload else 1
        finally:
            os._exit(status)
    os.close(write)
    with os.fdopen(read) as stream:
        primary = None
        try:
            # Drain before waitpid: stdout/stderr can exceed the result pipe buffer.
            payload = json.load(stream)
        except BaseException as error:
            primary = error
            try:
                os.kill(supervisor, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except Exception as cleanup_error:
                primary.add_note('Supervisor cancellation failed: ' + str(cleanup_error))
            try:
                # Finish owned cleanup and drain its reply before waiting.
                stream.read()
            except Exception as cleanup_error:
                primary.add_note('Supervisor reply drain failed: ' + str(cleanup_error))
            raise
        finally:
            try:
                _, status = os.waitpid(supervisor, 0)
            except Exception as cleanup_error:
                if primary is None:
                    raise
                primary.add_note('Supervisor reap failed: ' + str(cleanup_error))
    if 'error' in payload:
        error = payload['error']
        if error['errno'] is not None:
            failure = OSError(error['errno'], error['strerror'], error['filename'])
        else:
            failure = RuntimeError('Capture supervisor failed: ' + error['type'] + ': ' + error['message'])
        failure.add_note(error['traceback'])
        raise failure
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        raise RuntimeError('Capture supervisor exited without successful cleanup: ' + str(status))
    return payload['result'], payload['stdout'], payload['stderr']


def verify(result):
    if result['remaining_group_killed']:
        raise RuntimeError('Owned descendant survived controller exit; capture rejected after cleanup')
    if result['exit'] or result['timedOut']:
        raise RuntimeError('Capture failed or exceeded deadline: ' + json.dumps(result))


def private_directory(path, reuse=False):
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        if not reuse:
            raise
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077
            or (not reuse and stat.S_IMODE(info.st_mode) != 0o700)):
        raise RuntimeError('Fixture/evidence directory must be an owned private directory, never a symlink')
    return path


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
    private_directory(FIXTURE, reuse=True)
    fd = os.open(FIXTURE / 'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Exclusive fixed workspace is already in use')
        if args.output.is_symlink():
            raise ValueError('Evidence output must be a new directory, never a symlink')
        output = args.output.resolve()
        if output.is_relative_to(FIXTURE):
            raise ValueError('Evidence output must be outside the fixed fixture directory')
        private_directory(output)
        records = []
        for arm in ['default', 'four']:
            for repeat in range(1, args.repeats + 1):
                out = output / f'{arm}-{repeat}'
                private_directory(out)
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
