"""Count actual SDK captures; no production schema reassembly or normalization."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from reference import canonical, input_text, load_encoding, RANK_SHA256

EXPECTED = {'default': ['bash', 'edit', 'glob', 'grep', 'read', 'skill', 'task', 'webfetch', 'write'],
            'four': ['bash', 'edit', 'read', 'write']}
ENVIRONMENT = "<env>\n  Working directory: /tmp/aictrl-token-budget/workspace\n  Is directory a git repo: yes\n  Platform: linux\n  Today's date: Wed Oct 21 2026\n</env>"


def analyze(output, observe=False):
    encoding = load_encoding()
    count = lambda value: len(encoding.encode_ordinary(canonical(value)))
    campaign = json.loads((output / 'campaign.json').read_text())
    runs = campaign['runs']
    if campaign['workspace'] != '/tmp/aictrl-token-budget/workspace' or campaign['raw_normalization'] is not False:
        raise ValueError('Wrong raw fixture conditions')
    repeats = campaign['repeats']
    if not isinstance(repeats, int) or repeats < 2 or len(runs) != 2 * repeats:
        raise ValueError('Require complete repeated two-arm capture')
    rows = []
    for arm, names in EXPECTED.items():
        for repeat in range(1, repeats + 1):
            out = output / f'{arm}-{repeat}'
            controller = json.loads((out / 'controller-result.json').read_text())
            if controller not in runs or controller['exit'] or controller['timedOut'] or controller['remaining_group_killed']:
                raise ValueError('Unsuccessful controller or surviving process group')
            run = json.loads((out / 'result.json').read_text())
            if run['exit'] or run['deadline'] or run['requests'] != 1 or any(not x['allowed'] for x in run['network']):
                raise ValueError('Invalid capture exit/deadline/request/network evidence')
            ledger = [json.loads(line) for line in (out / 'network.jsonl').read_text().splitlines() if line]
            if ledger != run['network'] or len(ledger) != 1 or ledger[0]['path'] != '/v1/chat/completions':
                raise ValueError('Unaccounted network ledger or auxiliary request')
            if len(list(out.glob('request-*.json'))) != 1:
                raise ValueError('Unaccounted request capture')
            raw = (out / 'request-0.json').read_text()
            body = json.loads(raw)
            if body.get('model') != 'fixture':
                raise ValueError('Wrong fixture model')
            tools = body['tools']
            if sorted(tool['function']['name'] for tool in tools) != names:
                raise ValueError('Wrong actual tool catalog: ' + arm)
            systems = [m for m in body['messages'] if m['role'] == 'system']
            users = [m for m in body['messages'] if m['role'] == 'user']
            if len(systems) != 1 or len(users) != 1 or len(body['messages']) != 2:
                raise ValueError('Unexpected single-turn message roles')
            text = systems[0]['content']
            if 'You are aictrl' not in text:
                raise ValueError('Base prompt absent')
            if re.findall(r'<env>.*?</env>', text, re.S) != [ENVIRONMENT]:
                raise ValueError('Uncontrolled raw environment')
            prefix = {'messages': systems, 'tools': tools}
            if 'instructions' in body:
                prefix['instructions'] = body['instructions']
            payload = canonical(prefix)
            (out / 'prefix.canonical.json').write_text(payload)
            rows.append({'arm': arm, 'repeat': repeat, 'raw_body_sha256': hashlib.sha256(raw.encode()).hexdigest(),
                'prefix_sha256': hashlib.sha256(payload.encode()).hexdigest(), 'prefix_chars': len(payload),
                'prefix_reference_tokens': count(prefix),
                'full_first_model_input_reference_tokens': len(encoding.encode_ordinary(input_text(raw))),
                'system_separate_tokens': count({'messages': systems}), 'tools_separate_tokens': count({'tools': tools}),
                'tool_names': names})
    for arm in EXPECTED:
        if len({r['prefix_sha256'] for r in rows if r['arm'] == arm}) != 1:
            raise ValueError('Raw prefix differs between cold repetitions: ' + arm)
    budgets = None if observe else json.loads((Path(__file__).parent / 'budgets.json').read_text())
    violations = [] if observe else [f"{r['arm']}: {r['prefix_reference_tokens']} > {budgets[r['arm']]}" for r in rows
                                      if r['prefix_reference_tokens'] > budgets[r['arm']]]
    report = {'metric': 'raw SDK prefix o200k_base reference tokens; not provider billing/cache/quality/speed',
              'raw_normalization': False, 'tokenizer': 'tiktoken0.12.0/o200k_base', 'rank_sha256': RANK_SHA256,
              'piece_warning': 'System/tool counts encode separate projections and are not additive BPE contributions.',
              'budgets': budgets, 'violations': violations, 'rows': rows}
    (output / 'reference-counts.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    if violations:
        raise RuntimeError('Fixed prefix budget exceeded; review source change or explicit budget edit: ' + '; '.join(violations))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--observe', action='store_true')
    args = parser.parse_args()
    analyze(args.output, args.observe)
