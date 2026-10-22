"""Actual child/guard controls for the owned token-budget runner; no provider calls."""
import ctypes
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
BUN = shutil.which('bun')

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

RUN = module('budget_run', ROOT / 'run.py')

class Protocol(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
            raise RuntimeError('Linux subreaper required for owned child controls')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='token-budget-test-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.env = {'PATH': os.pathsep.join([str(Path(BUN).parent), '/usr/bin', '/bin']),
                    'HOME': str(self.directory / 'home'), 'TZ': 'UTC'}

    def test_clean_process_is_accepted(self):
        result, stdout, stderr = RUN.execute([sys.executable, '-I', '-c', 'print("clean")'], self.directory, self.env, 2)
        RUN.verify(result)
        self.assertEqual(stdout.strip(), 'clean')
        self.assertEqual(stderr, '')
        self.assertFalse(result['remaining_group_killed'])

    def test_actual_deadline_is_never_a_negative_success(self):
        result, _, _ = RUN.execute([sys.executable, '-I', '-c', 'import time;time.sleep(10)'], self.directory, self.env, .05)
        self.assertTrue(result['timedOut'])
        with self.assertRaisesRegex(RuntimeError, 'failed|deadline'):
            RUN.verify(result)
        with self.assertRaises(ProcessLookupError):
            os.killpg(result['process_group'], 0)

    def test_surviving_group_rejected_even_after_parent_exit_zero(self):
        source = ('import os,time\npid=os.fork()\nif pid==0:\n os.close(1);os.close(2);time.sleep(10);os._exit(0)\nprint(pid,flush=True)')
        result, _, _ = RUN.execute([sys.executable, '-I', '-c', source], self.directory, self.env, 2)
        self.assertEqual(result['exit'], 0)
        self.assertTrue(result['remaining_group_killed'])
        with self.assertRaisesRegex(RuntimeError, 'survived controller exit'):
            RUN.verify(result)
        with self.assertRaises(ProcessLookupError):
            os.killpg(result['process_group'], 0)

    def test_setsid_child_with_inherited_output_is_owned_rejected_and_reaped(self):
        source = """import os,time
read,write=os.pipe()
pid=os.fork()
if pid==0:
 os.close(read);os.setsid();os.write(write,b'ready');os.close(write);time.sleep(10);os._exit(0)
os.close(write);os.read(read,5);os.close(read);print(pid,flush=True)
"""
        result, stdout, _ = RUN.execute([sys.executable, '-I', '-c', source], self.directory, self.env, 2)
        self.assertEqual(result['exit'], 0)
        self.assertFalse(result['timedOut'])
        self.assertTrue(result['remaining_group_killed'])
        self.assertNotEqual(result['supervisor'], os.getpid())
        pid = int(stdout.strip())
        self.assertTrue(any(row['pid'] == pid and row['state'] == 'live-killed'
                            and row['owner'] == result['supervisor'] for row in result['descendant_cleanup']))
        with self.assertRaisesRegex(RuntimeError, 'survived controller exit'):
            RUN.verify(result)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_setsid_child_and_grandchild_are_repeatedly_adopted_and_reaped(self):
        source = """import os,time,json
read,write=os.pipe()
pid=os.fork()
if pid==0:
 os.close(read);os.setsid()
 grand=os.fork()
 if grand==0:
  os.setsid();os.write(write,(str(os.getpid())+'\\n').encode());os.close(write);time.sleep(10);os._exit(0)
 os.close(write);time.sleep(10);os._exit(0)
os.close(write)
with os.fdopen(read) as stream: grand=int(stream.readline())
print(json.dumps([pid,grand]),flush=True)
"""
        result, stdout, _ = RUN.execute([sys.executable, '-I', '-c', source], self.directory, self.env, 2)
        self.assertFalse(result['timedOut'])
        self.assertTrue(result['remaining_group_killed'])
        pids = json.loads(stdout)
        killed = {row['pid'] for row in result['descendant_cleanup'] if row['state'] == 'live-killed'}
        self.assertTrue(set(pids) <= killed)
        for pid in pids:
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_zombie_only_adoptee_does_not_reject_a_clean_capture(self):
        source = """import os
pid=os.fork()
if pid==0: os._exit(0)
os.waitid(os.P_PID,pid,os.WEXITED|os.WNOWAIT)
print(pid,flush=True)
"""
        result, stdout, _ = RUN.execute([sys.executable, '-I', '-c', source], self.directory, self.env, 2)
        RUN.verify(result)
        self.assertFalse(result['remaining_group_killed'])
        pid = int(stdout.strip())
        self.assertIn({'pid': pid, 'state': 'reaped', 'owner': result['supervisor']}, result['descendant_cleanup'])
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_caller_unrelated_live_child_is_not_signalled_reaped_or_waited(self):
        foreign = subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(10)'],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            identity = Path(f'/proc/{foreign.pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
            result, stdout, _ = RUN.execute([sys.executable, '-I', '-c', 'print("owned")'],
                                           self.directory, self.env, 2)
            RUN.verify(result)
            self.assertEqual(stdout.strip(), 'owned')
            self.assertIsNone(foreign.poll())
            self.assertEqual(Path(f'/proc/{foreign.pid}/stat').read_text().rsplit(')', 1)[1].split()[19], identity)
            self.assertNotIn(foreign.pid, [row['pid'] for row in result['descendant_cleanup']])
        finally:
            foreign.kill()
            foreign.wait(timeout=3)

    def test_result_pipe_drains_output_larger_than_pipe_capacity(self):
        source = 'import sys;sys.stdout.write("λ"*262144);sys.stderr.write("x"*262144)'
        result, stdout, stderr = RUN.execute([sys.executable, '-I', '-c', source], self.directory, self.env, 2)
        RUN.verify(result)
        self.assertEqual(stdout, 'λ' * 262144)
        self.assertEqual(stderr, 'x' * 262144)

    def test_root_spawn_error_remains_actionable(self):
        with self.assertRaises(FileNotFoundError):
            RUN.execute([str(self.directory / 'missing-owned-command')], self.directory, self.env, 2)

    def test_cleanup_failure_preserves_primary_spawn_error_with_diagnostic(self):
        with mock.patch.object(RUN, '_reap_descendants', side_effect=RuntimeError('owned cleanup probe failed')):
            with self.assertRaises(FileNotFoundError) as failure:
                RUN.execute([str(self.directory / 'missing-owned-command')], self.directory, self.env, 2)
        self.assertIn('owned cleanup probe failed', '\n'.join(failure.exception.__notes__))

    def test_cleanup_failure_rejects_an_otherwise_successful_capture(self):
        with mock.patch.object(RUN, '_reap_descendants', side_effect=RuntimeError('owned cleanup probe failed')):
            with self.assertRaisesRegex(RuntimeError, 'Owned capture cleanup failed'):
                RUN.execute([sys.executable, '-I', '-c', 'print("clean")'], self.directory, self.env, 2)

    def test_private_evidence_directory_ignores_permissive_umask_and_refuses_overwrite(self):
        previous = os.umask(0)
        try:
            output = RUN.private_directory(self.directory / 'evidence')
            arm = RUN.private_directory(output / 'default-1')
        finally:
            os.umask(previous)
        self.assertEqual(output.stat().st_mode & 0o777, 0o700)
        self.assertEqual(arm.stat().st_mode & 0o777, 0o700)
        marker = output / 'accepted.json'
        marker.write_text('retained')
        with self.assertRaises(FileExistsError):
            RUN.private_directory(output)
        self.assertEqual(marker.read_text(), 'retained')

    def test_reused_fixture_directory_rejects_shared_mode_and_symlinks(self):
        shared = self.directory / 'shared'
        shared.mkdir(mode=0o700)
        shared.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, 'owned private directory'):
            RUN.private_directory(shared, reuse=True)
        target = self.directory / 'owned'
        RUN.private_directory(target)
        link = self.directory / 'link'
        link.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'never a symlink'):
            RUN.private_directory(link, reuse=True)
        with self.assertRaises(FileExistsError):
            RUN.private_directory(link)

    def test_before_import_guard_rejects_network_preconnect_and_install(self):
        guard = self.directory / 'guard.ts'
        env = {**self.env, 'GUARD_MODULE': str(ROOT / 'guard.ts'), 'GUARD_FILE': str(guard),
               'SELECTOR_FIXTURE_GUARD_LOG': str(self.directory / 'network.jsonl'),
               'SELECTOR_FIXTURE_ORIGIN': 'http://127.0.0.1:1'}
        Path(env['SELECTOR_FIXTURE_GUARD_LOG']).write_text('')
        create = 'const {guard}=await import(process.env.GUARD_MODULE);await Bun.write(process.env.GUARD_FILE,guard)'
        createfile = self.directory / 'create.ts'
        createfile.write_text(create)
        p = subprocess.run([BUN, 'run', '--no-install', '--no-env-file', str(createfile)], cwd=self.directory,
                           env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=3)
        self.assertEqual(p.returncode, 0, p.stderr)
        cases = [
            ('await fetch("https://example.invalid/offline-probe")', 'blocked nonlocal'),
            ('fetch.preconnect("https://example.invalid")', 'forbids preconnect'),
            ('Bun.spawn([process.execPath,"install","--help"])', 'forbids dependency installation'),
        ]
        for source, diagnostic in cases:
            with self.subTest(diagnostic=diagnostic):
                probe = self.directory / 'probe.ts'
                probe.write_text(source)
                p = subprocess.run([BUN, 'run', '--no-install', '--no-env-file', '--preload', str(guard), str(probe)],
                                   cwd=self.directory, env=env, stdin=subprocess.DEVNULL,
                                   capture_output=True, text=True, timeout=3)
                self.assertNotEqual(p.returncode, 0)
                self.assertIn(diagnostic, p.stderr)
        ledger = [json.loads(line) for line in Path(env['SELECTOR_FIXTURE_GUARD_LOG']).read_text().splitlines()]
        self.assertEqual(ledger, [{'origin': 'https://example.invalid', 'path': '/offline-probe', 'allowed': False}])

    def test_fixed_workspace_lock_rejects_parallel_campaign_before_output(self):
        RUN.private_directory(RUN.FIXTURE, reuse=True)
        fd = os.open(RUN.FIXTURE / 'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        output = self.directory / 'must-not-exist'
        with os.fdopen(fd, 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            p = subprocess.run([sys.executable, '-I', '-B', str(ROOT / 'run.py'), '--output', str(output)],
                               cwd=self.directory, env=self.env, stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, timeout=3)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('Exclusive fixed workspace is already in use', p.stderr)
        self.assertFalse(output.exists())

    def test_clock_preload_is_fixed_before_imports(self):
        probe = self.directory / 'clock.ts'
        probe.write_text('console.log(JSON.stringify({iso:new Date().toISOString(),date:new Date().toDateString(),now:Date.now()}))')
        p = subprocess.run([BUN, 'run', '--no-install', '--no-env-file', '--preload', str(ROOT / 'clock.js'), str(probe)],
                           cwd=self.directory, env=self.env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=3)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(p.stdout), {'iso': '2026-10-21T12:00:00.000Z', 'date': 'Wed Oct 21 2026', 'now': 1792584000000})

class ReleaseManifest(unittest.TestCase):
    def test_missing_final_cleanup_is_explicit_incomplete_campaign(self):
        counter = module('release_count', ROOT / 'release-count.py')
        for checks in [None, [], [{'name': 'last-run', 'removed': {}, 'remaining': {}}],
                       [{'finalCampaignCheck': {}}], ['not-an-object']]:
            with self.subTest(checks=checks), tempfile.TemporaryDirectory(prefix='release-incomplete-') as directory:
                campaign = Path(directory) / 'campaign.json'
                data = {'protocolVersion': 3, 'failures': [], 'REPS': 2}
                if checks is not None:
                    data['cleanupChecks'] = checks
                campaign.write_text(json.dumps(data))
                with self.assertRaisesRegex(ValueError, 'Incomplete release campaign: final cleanup evidence missing'):
                    counter.analyze(campaign)
                self.assertFalse(campaign.with_name('release-comparison.json').exists())


if __name__ == '__main__':
    unittest.main()
