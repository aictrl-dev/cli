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
        RUN.FIXTURE.mkdir(mode=0o700, exist_ok=True)
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

if __name__ == '__main__':
    unittest.main()
