#!/usr/bin/env python3
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Create a review packet and honest observation/P17 manifests. Does not SSH or deploy."""
import argparse
import datetime
import hashlib
import json
import re
from pathlib import Path
import time

DAY_MS = 24 * 60 * 60 * 1000
SHA = re.compile(r'^[a-f0-9]{64}$')
NAME = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$')
NATIVE_ARTIFACTS = {'qm-linux-x64', 'bun-linux-x64', 'check-qm-smoke.mjs',
                    'native-after-review.sh', 'qmcode', 'codex-code-mode-host'}
NATIVE_PREFLIGHT = {'version': 1, 'identity': 'every-native-invocation',
                    'artifacts': 'all-before-interpreter', 'rollback': 'attempt-all-hosts'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def quote(value):
    return "'" + value.replace("'", "'\"'\"'") + "'"


def validate(plan):
    if plan.get('version') != 1 or not NAME.fullmatch(plan.get('candidateId', '')):
        raise ValueError('version 1 and a safe candidateId required')
    if not SHA.fullmatch(plan.get('sourceFilesSha256', '')):
        raise ValueError('frozen source file manifest hash required')
    artifacts = plan.get('artifacts', [])
    if not artifacts:
        raise ValueError('at least one checked target-platform artifact required')
    if len({a.get('name') for a in artifacts}) != len(artifacts):
        raise ValueError('artifact names must be unique')
    for a in artifacts:
        if not NAME.fullmatch(a.get('name', '')) or not SHA.fullmatch(a.get('sha256', '')):
            raise ValueError('invalid artifact name/hash')
        path = Path(a['path'])
        if not path.is_absolute() or not path.is_file() or path.is_symlink():
            raise ValueError('artifact must be an existing absolute regular file')
        if hashlib.sha256(path.read_bytes()).hexdigest() != a['sha256']:
            raise ValueError('artifact checksum mismatch')
    if 'nativePreflight' in plan:
        if plan['nativePreflight'] != NATIVE_PREFLIGHT or {a['name'] for a in artifacts} != NATIVE_ARTIFACTS:
            raise ValueError('native preflight requires the exact contract and all six artifacts')
    hosts = plan.get('hosts', [])
    if len(hosts) < 3 or {h.get('role') for h in hosts} != {'hub', 'worker', 'witness'}:
        raise ValueError('distinct hub, worker and witness roles required')
    identities = set()
    for h in hosts:
        for key in ('id', 'ssh', 'hostname'):
            if not NAME.fullmatch(h.get(key, '')):
                raise ValueError('invalid host ' + key)
        if not SHA.fullmatch(h.get('machineIdSha256', '')):
            raise ValueError('machine ID inventory hash required (may be cloned)')
        if not SHA.fullmatch(h.get('hostIdentitySha256', '')) or h['hostIdentitySha256'] in identities:
            raise ValueError('roles must use independent authenticated SSH target identities')
        host_key = h.get('sshHostKey', '')
        if not re.fullmatch(r'(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp256) [A-Za-z0-9+/]+={0,2}', host_key):
            raise ValueError('reviewed public SSH target host key required')
        if digest({'hostname': h['hostname'], 'sshHostKey': host_key}) != h['hostIdentitySha256']:
            raise ValueError('SSH identity hash must bind the exact target key and hostname')
        identities.add(h['hostIdentitySha256'])
        if not re.fullmatch(r'[a-f0-9-]{36}', h.get('bootId', '')):
            raise ValueError('inventoried boot ID required')
        if h.get('uid', 0) <= 0:
            raise ValueError('candidate processes require a non-root uid')
        home = Path(h.get('home', ''))
        expected = home / 'qianmo-candidate' / plan['candidateId']
        if not re.fullmatch(r'/home/[A-Za-z0-9_.-]+', str(home)) or h.get('root') != str(expected):
            raise ValueError('candidate root must be a fresh home/qianmo-candidate/id path')
        ports = h.get('ports', [])
        if not ports or len(set(ports)) != len(ports) or any(type(p) is not int or not 39720 <= p <= 39799 for p in ports):
            raise ValueError('candidate ports must be unique and confined to 39720..39799')
        if h.get('bind') != '127.0.0.1':
            raise ValueError('candidate ports must be loopback only')
        if not 16 <= h.get('memoryMaxMiB', 0) <= 1024 or not 1 <= h.get('cpuQuotaPercent', 0) <= 100:
            raise ValueError('explicit bounded memory/CPU quota required')
    if plan.get('observationDays') != 7 or plan.get('handoffRoundsPerTool') != 2:
        raise ValueError('seven actual days and two rounds per tool cannot be shortened')
    if plan.get('semanticRecallEnabled') is not False:
        raise ValueError('semantic recall remains disabled pending its quality gate')
    return digest(plan)


def native_preflight(h, artifacts):
    """Trusted inline shell: no candidate interpreter runs before these checks."""
    lines = ['set -euo pipefail', 'umask 077',
             '[ "$(id -u)" = ' + quote(str(h['uid'])) + ' ]',
             '[ "$(hostname)" = ' + quote(h['hostname']) + ' ]',
             '[ "$(cat /proc/sys/kernel/random/boot_id)" = ' + quote(h['bootId']) + ' ]',
             '[ "$(sha256sum /etc/machine-id | cut -d\' \' -f1)" = ' + quote(h['machineIdSha256']) + ' ]']
    for path in [h['home'], str(Path(h['root']).parent), h['root'], h['root'] + '/bin']:
        lines += ['[ ! -L ' + quote(path) + ' ]',
                  '[ "$(readlink -f ' + quote(path) + ')" = ' + quote(path) + ' ]']
    lines += ['command -v ss >/dev/null', 'listeners="$(ss -lntH)"',
              'for p in ' + ' '.join(str(p) for p in h['ports']) + '; do',
              '  if printf \'%s\\n\' "$listeners" | awk \'{print $4}\' | grep -Eq ":${p}$"; then echo "candidate port occupied" >&2; exit 3; fi',
              'done']
    for a in artifacts:
        path = h['root'] + '/bin/' + a['name']
        lines += ['[ -f ' + quote(path) + ' ] && [ ! -L ' + quote(path) + ' ]',
                  '[ "$(sha256sum ' + quote(path) + " | cut -d' ' -f1)\" = " + quote(a['sha256']) + ' ] || { echo "candidate artifact changed" >&2; exit 4; }']
    qm = next(a['sha256'] for a in artifacts if a['name'] == 'qm-linux-x64')
    lines += ['exec bash ' + quote(h['root'] + '/bin/native-after-review.sh') + ' ' + quote(h['root']) + ' ' + quote(h['role']) + ' ' + quote(qm)]
    return '\n'.join(lines)


def execution_wrappers(plan, out, plan_hash):
    known = out.resolve() / 'known_hosts'
    header = ['#!/usr/bin/env bash', 'set -euo pipefail', 'umask 077',
              '# Separate human approval is required; this checksum is not approval.',
              '[ "${1:-}" = ' + quote(plan_hash) + ' ] || exit 2',
              '[ "$(shasum -a 256 ' + quote(str(known)) + " | cut -d' ' -f1)\" = " + quote(hashlib.sha256(known.read_bytes()).hexdigest()) + ' ] || exit 2']
    native = list(header)
    stop = list(header) + ['failed=0']
    for h in plan['hosts']:
        options = ' -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile=' + quote(str(known)) + ' -o HostKeyAlias=' + quote(h['id'])
        native += ['ssh' + options + ' ' + quote(h['ssh']) + " 'bash -s' <<'QIANMO_NATIVE_PREFLIGHT'",
                   native_preflight(h, plan['artifacts']), 'QIANMO_NATIVE_PREFLIGHT']
        unit = plan['candidateId'] + '-' + h['role'] + '-native.service'
        stop += ['if ! ssh' + options + ' ' + quote(h['ssh']) + " 'bash -s' <<'QIANMO_STOP'",
                 'set -euo pipefail',
                 'set +e',
                 'state="$(systemctl --user show --property=LoadState --value ' + quote(unit) + ')"',
                 'code=$?', 'set -e',
                 'if [ "$state" = not-found ]; then echo "candidate unit already absent"; exit 0; fi',
                 '[ "$code" = 0 ] || exit "$code"',
                 '[ -n "$state" ] || exit 4',
                 'systemctl --user stop ' + quote(unit), 'QIANMO_STOP',
                 'then failed=1; fi']
    stop += ['exit "$failed"']
    (out / 'native-after-review.sh').write_text('\n'.join(native) + '\n')
    (out / 'stop-candidate-units.sh').write_text('\n'.join(stop) + '\n')


def review(plan, out):
    plan_hash = validate(plan)
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    (out / 'plan.json').write_bytes(canonical(plan) + b'\n')
    (out / 'plan.sha256').write_text(plan_hash + '\n')
    # This script is a separate, explicitly invoked operation after human review.
    # It only creates the fresh candidate tree and copies verified artifacts.
    # Starting services, installing timers, modifying keys and production files are absent.
    known_hosts = out.resolve() / 'known_hosts'
    known_hosts.write_text(''.join(h['id'] + ' ' + h['sshHostKey'] + '\n' for h in plan['hosts']))
    lines = ['#!/usr/bin/env bash', 'set -euo pipefail', 'umask 077',
             '# Human approval is separate from this checksum guard. Never run before review.',
             '[ "${1:-}" = ' + quote(plan_hash) + ' ] || { echo "reviewed plan SHA required" >&2; exit 2; }']
    lines += ['[ "$(shasum -a 256 ' + quote(str(known_hosts)) + " | cut -d' ' -f1)\" = " + quote(hashlib.sha256(known_hosts.read_bytes()).hexdigest()) + ' ] || { echo "reviewed SSH host keys changed" >&2; exit 2; }']
    for h in plan['hosts']:
        preflight = '\n'.join([
            'set -euo pipefail', 'umask 077',
            '[ "$(id -u)" = ' + quote(str(h['uid'])) + ' ]',
            '[ "$(hostname)" = ' + quote(h['hostname']) + ' ]',
            '[ "$(cat /proc/sys/kernel/random/boot_id)" = ' + quote(h['bootId']) + ' ]',
            '[ "$(sha256sum /etc/machine-id | cut -d\' \' -f1)" = ' + quote(h['machineIdSha256']) + ' ]',
            '[ "$(readlink -f ' + quote(h['home']) + ')" = ' + quote(h['home']) + ' ]',
            '[ ! -L ' + quote(str(Path(h['home']) / 'qianmo-candidate')) + ' ]',
            'command -v ss >/dev/null',
            'listeners="$(ss -lntH)"',
            'for p in ' + ' '.join(str(p) for p in h['ports']) + '; do',
            '  if printf \'%s\\n\' "$listeners" | awk \'{print $4}\' | grep -Eq ":${p}$"; then echo "candidate port occupied" >&2; exit 3; fi',
            'done',
            '[ ! -e ' + quote(h['root']) + ' ]',
            'mkdir -p ' + quote(str(Path(h['root']).parent)),
            'mkdir ' + quote(h['root']),
            'mkdir ' + ' '.join(quote(h['root'] + '/' + x) for x in ['bin', 'home', 'config', 'secrets', 'evidence', 'work', 'run']),
        ])
        host = quote(h['ssh'])
        ssh_options = ' -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile=' + quote(str(known_hosts)) + ' -o HostKeyAlias=' + quote(h['id'])
        lines += ['ssh' + ssh_options + ' ' + host + " 'bash -s' <<'QIANMO_PREFLIGHT'", preflight, 'QIANMO_PREFLIGHT']
        for a in plan['artifacts']:
            dest = h['root'] + '/bin/' + a['name']
            # SCP source is a local absolute path; destination is shell-quoted inside the remote spec.
            lines += ['scp' + ssh_options + ' -- ' + quote(a['path']) + ' ' + quote(h['ssh'] + ':' + dest)]
            verify = "set -e; [ \"$(sha256sum " + quote(dest) + " | cut -d' ' -f1)\" = " + quote(a['sha256']) + " ]; chmod 500 " + quote(dest)
            lines += ['ssh' + ssh_options + ' ' + host + ' ' + quote(verify)]
    (out / 'stage-after-review.sh').write_text('\n'.join(lines) + '\n')
    if 'nativePreflight' in plan:
        execution_wrappers(plan, out, plan_hash)
    (out / 'status.json').write_text(json.dumps({'planSha256': plan_hash, 'state': 'awaiting-human-deployment-review',
        'remoteActionsExecuted': False, 'sevenDayPassed': False, 'p17Passed': False}, indent=2) + '\n')
    print(json.dumps({'directory': str(out), 'planSha256': plan_hash, 'state': 'awaiting-human-deployment-review'}))


def window_status(window, now_ms):
    if window.get('version') != 1 or not SHA.fullmatch(window.get('planSha256', '')):
        raise ValueError('invalid immutable window')
    start, end = window['from'], window['to']
    if type(start) is not int or type(end) is not int or end - start != 7 * DAY_MS:
        raise ValueError('window must cover seven actual days')
    return {'state': 'acquisition-window-elapsed' if now_ms >= end else 'collecting',
            'elapsedMs': max(0, now_ms - start), 'remainingMs': max(0, end - now_ms),
            'sevenDayPassed': False, 'requires': 'frozen complete probe/timing/audit sources, unchanged deployment fingerprints, beta-report, independent review'}


def handoff_check(data, directory):
    required = {'entry', 'acceptedReceipt', 'refsBefore', 'refsAfter', 'nodeTranscript', 'artifactTests',
                'offlineObserver', 'attachTranscript', 'pullReceipt', 'localBefore', 'localAfter'}
    records = data.get('rounds', [])
    seen, missing, hashes = set(), [], []
    for row in records:
        key = (row.get('tool'), row.get('round'))
        if key in seen or key[0] not in ('qmcode', 'claude-code') or key[1] not in (1, 2):
            raise ValueError('exactly two distinct rounds per real tool required')
        seen.add(key)
        ids = row.get('hostIdentityHashes', {})
        if set(ids) != {'origin', 'worker', 'observer'} or len(set(ids.values())) != 3 or any(not SHA.fullmatch(v) for v in ids.values()):
            missing.append({'round': key, 'missing': 'three distinct authenticated host identities'})
        if row.get('offlineSeconds', 0) < 1800:
            missing.append({'round': key, 'missing': 'at least thirty real minutes offline'})
        for name in sorted(required):
            ref = row.get('files', {}).get(name)
            path = (directory / ref).resolve() if isinstance(ref, str) else None
            if path is None or not path.is_relative_to(directory.resolve()) or not path.is_file() or path.stat().st_size == 0:
                missing.append({'round': key, 'missing': name})
            else:
                hashes.append({'round': key, 'kind': name, 'path': ref, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    for key in {(tool, n) for tool in ('qmcode', 'claude-code') for n in (1, 2)} - seen:
        missing.append({'round': key, 'missing': 'round'})
    return {'evidenceInventoryComplete': not missing, 'missing': missing, 'sourceHashes': hashes,
            'p17Passed': False, 'requires': 'independent review of real entry, receipt/ref equality, offline witness, historical constraints, side effects and pull preservation; this inventories files, not their truth'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    r = sub.add_parser('review'); r.add_argument('plan', type=Path); r.add_argument('out', type=Path)
    s = sub.add_parser('window-start'); s.add_argument('plan', type=Path); s.add_argument('--approved-plan-sha', required=True); s.add_argument('out', type=Path)
    s = sub.add_parser('window-status'); s.add_argument('window', type=Path)
    s = sub.add_parser('handoff-check'); s.add_argument('manifest', type=Path)
    args = p.parse_args()
    if args.command == 'review': review(json.loads(args.plan.read_text()), args.out)
    elif args.command == 'window-start':
        plan = json.loads(args.plan.read_text()); sha = validate(plan)
        if sha != args.approved_plan_sha: raise ValueError('reviewed plan hash mismatch')
        now = int(time.time() * 1000)
        data = {'version': 1, 'planSha256': sha, 'from': now, 'to': now + 7 * DAY_MS,
                'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'deployment': plan,
                'warning': 'Start only after candidate deployment and probes are live. This command does not deploy or schedule probes.'}
        with args.out.open('x') as f: f.write(json.dumps(data, indent=2) + '\n')
        print(json.dumps(window_status(data, now)))
    elif args.command == 'window-status': print(json.dumps(window_status(json.loads(args.window.read_text()), int(time.time() * 1000))))
    else: print(json.dumps(handoff_check(json.loads(args.manifest.read_text()), args.manifest.parent), indent=2))


if __name__ == '__main__':
    main()
