"""Account the explicit release comparison with the shared pinned offline counter."""
import gzip
import hashlib
import json
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from reference import input_text, output_text, load_encoding


def analyze(campaign_path):
    campaign = json.loads(campaign_path.read_text())
    target = campaign_path.with_name('release-comparison.json')
    if target.exists():
        raise ValueError('Refuse overwriting accounting results')
    if campaign['protocolVersion'] != 3 or campaign['failures'] or campaign['REPS'] < 2:
        raise ValueError('Incomplete or failed release campaign')
    final = campaign['cleanupChecks'][-1]['finalCampaignCheck']
    if final['exit'] != 0 or final['timedOut'] or final['stdout'].strip():
        raise ValueError('Final campaign container cleanup not verified')
    encoding = load_encoding()
    arms = {}
    for arm in campaign['HARNESSES']:
        sessions = []
        runs = campaign['raw']['short'][arm]
        if len(runs) != campaign['REPS']:
            raise ValueError('Incomplete arm: ' + arm)
        for run in runs:
            if not run['valid'] or run['exit'] or run['timedOut'] or run['mainRequests'] != 4:
                raise ValueError('Invalid capture: ' + run['runId'])
            log = campaign_path.parent / 'campaign-logs' / (run['runId'] + '.requests-with-bodies.jsonl.gz')
            records = [json.loads(line) for line in gzip.decompress(log.read_bytes()).decode().splitlines()]
            counted = []
            for r in records:
                if r['kind'] not in ('main', 'aux'):
                    continue
                body = r['body'].encode()
                if len(body) != r['bytes'] or hashlib.sha256(body).hexdigest() != r['bodySha256']:
                    raise ValueError('Raw body hash/byte mismatch')
                response = r['responseBody'].encode()
                if len(response) != r['responseDelivery']['bodyBytes']:
                    raise ValueError('Raw SSE response byte mismatch')
                counted.append({'kind': r['kind'], 'step': r['step'],
                    'request_sha256': hashlib.sha256(body).hexdigest(),
                    'response_sha256': hashlib.sha256(response).hexdigest(),
                    'input': len(encoding.encode_ordinary(input_text(r['body']))),
                    'output': len(encoding.encode_ordinary(output_text(r['response'])))})
            main = [r for r in records if r['kind'] == 'main']
            if len(main) != 4 or [r['step'] for r in main] != [0, 1, 2, 3]:
                raise ValueError('Expected exactly ordered scripted steps')
            for i in range(3):
                call = main[i]['response']
                result = next((r for r in main[i+1]['toolResults'] if r['callId'] == f'call_{i}'), None)
                if call['kind'] != 'tool' or call['name'] != 'read' or call['arguments']['filePath'] != f'/workspace/notes-{i}.txt' or not result or not result['complete'] or result['matchedLines'] != 20 or any(result.get(k) for k in ['errorNotice','truncationNotice','nativeSuppressed','nativeGuardrailRefusal']):
                    raise ValueError('Missing actual exact20line ordered Read result')
            if len(main[-1]['toolResults']) != 3 or main[-1]['response']['text'] != 'Done.':
                raise ValueError('Missing final completion')
            if len(counted) != run['mainRequests'] + run['auxRequests']:
                raise ValueError('Request count mismatch')
            incoming = sum(r['input'] for r in counted)
            outgoing = sum(r['output'] for r in counted)
            sessions.append({'runId': run['runId'], 'first_input': next(r['input'] for r in counted if r['kind']=='main'),
                'session_input': incoming, 'session_output': outgoing, 'session_total': incoming+outgoing,
                'capture_sha256': hashlib.sha256(log.read_bytes()).hexdigest(), 'requests': counted})
        arms[arm] = {'sessions': sessions, 'median': {k: statistics.median(r[k] for r in sessions)
            for k in ('first_input','session_input','session_output','session_total')}}
    if not {'current-default','previous-default'} <= arms.keys():
        raise ValueError('Both actual default versions required')
    unsupported = {name+'-selected': 'UNSUPPORTED: actual run --help lacks --tools; no permission/config substitute'
                   for name, supported in campaign['support'].items() if not supported}
    deltas = {k: arms['current-default']['median'][k] - arms['previous-default']['median'][k]
              for k in ('first_input','session_input','session_output','session_total')}
    result = {'measurement': 'offline o200k_base reference tokens; tiktoken0.12.0; no billing/cache/quality/speed claim',
        'campaign_sha256': hashlib.sha256(campaign_path.read_bytes()).hexdigest(),
        'accounting_source_sha256': hashlib.sha256(Path(__file__).with_name('reference.py').read_bytes()).hexdigest(),
        'arms': arms, 'unsupported': unsupported, 'current_minus_previous_default': deltas,
        'gate': 'Complete valid task/provenance/cleanup comparison required; numerical release deltas require reviewer acceptance, not an automatic no-increase policy'}
    target.write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps({k:v['median'] for k,v in arms.items()}, indent=2))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: OWNED_ENV/venv/bin/python3 -I -B script/token-budget/release-count.py CAMPAIGN.json')
    analyze(Path(sys.argv[1]))
