#!/usr/bin/env python3
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Read-only Linux process-tree acquisition. It never starts, signals or stops a PID."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import time


def process_info(pid):
    base = Path('/proc') / str(pid)
    raw = (base / 'stat').read_text()
    fields = raw[raw.rfind(')') + 2:].split()
    # /proc/PID/stat fields after comm: state=3, ppid=4, utime=14, stime=15, starttime=22.
    data = {'pid': pid, 'ppid': int(fields[1]), 'startTicks': int(fields[19]),
            'cpuTicks': int(fields[11]) + int(fields[12]), 'rssBytes': None,
            'highWaterBytes': None, 'pssBytes': None}
    for line in (base / 'status').read_text().splitlines():
        key, _, value = line.partition(':')
        if key in ('VmRSS', 'VmHWM'):
            data['rssBytes' if key == 'VmRSS' else 'highWaterBytes'] = int(value.split()[0]) * 1024
    try:
        for line in (base / 'smaps_rollup').read_text().splitlines():
            if line.startswith('Pss:'):
                data['pssBytes'] = int(line.split()[1]) * 1024
    except OSError:
        pass
    return data


def sample(pid, start_ticks):
    target = process_info(pid)
    if target['startTicks'] != start_ticks:
        raise RuntimeError('PID was reused; acquisition refuses another process')
    processes = {pid: target}
    candidates = {}
    for path in Path('/proc').iterdir():
        if path.name.isdigit() and int(path.name) != pid:
            try:
                row = process_info(int(path.name))
                candidates[row['pid']] = row
            except (OSError, ValueError, IndexError):
                pass
    while True:
        added = {p: row for p, row in candidates.items() if row['ppid'] in processes}
        if not added:
            break
        processes.update(added)
        for p in added:
            candidates.pop(p)
    pss = [row['pssBytes'] for row in processes.values()]
    cgroup = None
    try:
        path = next(line[3:] for line in (Path('/proc') / str(pid) / 'cgroup').read_text().splitlines() if line.startswith('0::'))
        directory = Path('/sys/fs/cgroup') / path.lstrip('/')
        cgroup = {'path': path, 'memoryCurrentBytes': int((directory / 'memory.current').read_text()),
                  'memoryEvents': (directory / 'memory.events').read_text()}
    except (OSError, ValueError, StopIteration):
        pass
    return {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'monotonicNs': time.monotonic_ns(), 'processes': list(processes.values()),
            'treePssBytes': sum(pss) if all(n is not None for n in pss) else None,
            'cgroup': cgroup}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--duration', type=float, default=600)
    parser.add_argument('--interval', type=float, default=1)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if os.uname().sysname != 'Linux' or args.pid <= 1 or args.duration <= 0 or args.interval <= 0:
        parser.error('Linux, a PID > 1, positive duration and interval required')
    args.out.mkdir(mode=0o700, parents=True, exist_ok=False)
    start = process_info(args.pid)['startTicks']
    metadata = {'pid': args.pid, 'startTicks': start, 'clockTicksPerSecond': os.sysconf('SC_CLK_TCK'),
                'machineIdSha256': hashlib.sha256(Path('/etc/machine-id').read_bytes()).hexdigest(),
                'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                'durationSeconds': args.duration, 'intervalSeconds': args.interval,
                'scope': 'RSS/HWM per process; only PSS is summed. Cgroup may contain unrelated processes.',
                'acceptance': 'measurement only; not idle-RSS, frozen-state, AC-2 or seven-day success'}
    (args.out / 'manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
    until = time.monotonic() + args.duration
    with (args.out / 'samples.ndjson').open('x') as sink:
        while True:
            sink.write(json.dumps(sample(args.pid, start)) + '\n'); sink.flush()
            remaining = until - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(args.interval, remaining))
    print(json.dumps({'output': str(args.out), 'completeAcquisition': True, 'acceptancePassed': None}))


if __name__ == '__main__':
    main()
