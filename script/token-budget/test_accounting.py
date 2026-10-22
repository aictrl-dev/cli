"""Offline accounting faults using copied real captures and private environment copies."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import reference
import count

class Reference(unittest.TestCase):
    def test_public_canonical_protocol_golden(self):
        raw = json.dumps({'messages': [{'role': 'user', 'content': 'héllo'}], 'model': 'transport-only',
                          'temperature': .1, 'tools': []}, ensure_ascii=False)
        self.assertEqual(reference.input_text(raw), '{"messages":[{"content":"héllo","role":"user"}],"tools":[]}')
        self.assertEqual(reference.output_text({'kind': 'tool', 'name': 'read', 'arguments': {'z': 1, 'a': 'é'}}),
                         '{"arguments":{"a":"é","z":1},"name":"read"}')
        self.assertEqual(reference.output_text({'kind': 'text', 'text': 'Done'}), 'Done')
        with self.assertRaises(ValueError):
            reference.input_text('{}')

    def test_pinned_known_string_roundtrip(self):
        encoding = reference.load_encoding()
        text = 'Hello, world! aictrl offline tokenizer QA.'
        encoded = encoding.encode_ordinary(text)
        self.assertEqual(len(encoded), 11)
        self.assertEqual(encoding.decode(encoded), text)

    def test_actual_copied_environment_rejects_missing_wrong_rank_and_wrong_version(self):
        environment = Path(sys.prefix).parent
        self.assertTrue((environment / 'setup.json').is_file(), 'Run with the explicit setup-created venv')
        script = 'import sys;sys.path.insert(0,sys.argv[1]);import reference;reference.load_encoding()'
        for mode, diagnostic in [('missing', 'Missing or mismatched'), ('wrong', 'Missing or mismatched'),
                                 ('version', 'Require pinned tiktoken')]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix='budget-environment-') as directory:
                clone = Path(directory) / 'environment'
                shutil.copytree(environment, clone, symlinks=True, copy_function=shutil.copy2,
                                ignore=shutil.ignore_patterns('wheel-cache'))
                rank = clone / 'cache' / reference.RANK_KEY
                if mode == 'missing':
                    rank.unlink()
                elif mode == 'wrong':
                    rank.write_bytes(b'wrong-rank-data')
                else:
                    metadata = next((clone / 'venv/lib/python3.12/site-packages').glob('tiktoken-*.dist-info/METADATA'))
                    text = metadata.read_text()
                    self.assertIn('Version: 0.12.0', text)
                    metadata.write_text(text.replace('Version: 0.12.0', 'Version: 0.11.0', 1))
                p = subprocess.run([str(clone / 'venv/bin/python3'), '-I', '-B', '-c', script, str(ROOT)],
                                   env={'PATH': '/usr/bin:/bin', 'HOME': str(clone / 'home')},
                                   stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
                self.assertNotEqual(p.returncode, 0)
                self.assertIn(diagnostic, p.stderr)

@unittest.skipUnless(os.environ.get('TOKEN_BUDGET_TEST_CAMPAIGN'), 'Set TOKEN_BUDGET_TEST_CAMPAIGN to actual completed capture')
class Captures(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='budget-capture-fault-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.original = Path(os.environ['TOKEN_BUDGET_TEST_CAMPAIGN'])
        shutil.copy2(self.original / 'campaign.json', self.directory / 'campaign.json')
        for source in self.original.glob('*-*'):
            if not source.is_dir():
                continue
            target = self.directory / source.name
            target.mkdir()
            for name in ['controller-result.json', 'result.json', 'network.jsonl', 'request-0.json']:
                shutil.copy2(source / name, target / name)
        self.case = self.directory / 'default-1'

    def analyze(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return count.analyze(self.directory, observe=True)

    def body(self, transform):
        file = self.case / 'request-0.json'
        body = json.loads(file.read_text())
        transform(body)
        file.write_text(json.dumps(body, ensure_ascii=False))

    def test_real_captures_reproduce_and_user_text_is_outside_prefix(self):
        first = self.analyze()
        for file in self.directory.glob('*-*/request-0.json'):
            body = json.loads(file.read_text())
            next(m for m in body['messages'] if m['role'] == 'user')['content'] = 'A different explicit user fixture ' * 100
            file.write_text(json.dumps(body))
        second = self.analyze()
        self.assertEqual([r['prefix_sha256'] for r in first['rows']], [r['prefix_sha256'] for r in second['rows']])
        self.assertNotEqual([r['full_first_model_input_reference_tokens'] for r in first['rows']],
                            [r['full_first_model_input_reference_tokens'] for r in second['rows']])

    def test_wrong_catalog_rejected(self):
        self.body(lambda b: b['tools'][0]['function'].update(name='unknown-fixture-work'))
        with self.assertRaisesRegex(ValueError, 'Wrong actual tool catalog'):
            self.analyze()

    def test_raw_clock_or_cwd_drift_rejected(self):
        self.body(lambda b: b['messages'][0].update(content=b['messages'][0]['content'].replace('Wed Oct 21 2026', 'Thu Oct 22 2026')))
        with self.assertRaisesRegex(ValueError, 'Uncontrolled raw environment'):
            self.analyze()

    def test_nonidentical_tool_description_repetitions_rejected(self):
        self.body(lambda b: b['tools'][0]['function'].update(description=b['tools'][0]['function']['description'] + ' Drift'))
        with self.assertRaisesRegex(ValueError, 'differs between cold repetitions'):
            self.analyze()

    def test_unaccounted_auxiliary_network_and_request_rejected(self):
        file = self.case / 'network.jsonl'
        with file.open('a') as stream:
            stream.write(json.dumps({'origin': 'http://127.0.0.1:1', 'path': '/v1/models', 'allowed': True}) + '\n')
        with self.assertRaisesRegex(ValueError, 'Unaccounted network'):
            self.analyze()

    def test_deadline_record_cannot_be_a_negative_success(self):
        file = self.case / 'result.json'
        data = json.loads(file.read_text()); data['deadline'] = True; file.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'Invalid capture'):
            self.analyze()

    def test_surviving_controller_group_rejected(self):
        file = self.case / 'controller-result.json'
        data = json.loads(file.read_text()); data['remaining_group_killed'] = True; file.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'Unsuccessful controller'):
            self.analyze()

if __name__ == '__main__':
    unittest.main()
