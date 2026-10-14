// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `replicate-hub.sh`：自我复制在中枢上的几步（prepare / add / discard / restart）。临时
 * HOME、临时内测根，真的 ssh-keygen 与真的 awk。
 *
 * 钉住：prepare 先查后写、生成的两样都是 0600；add 写进 peers.conf 的两行与 console.env
 * 的那一条 `--chat-url` 逐字对；discard 之后两个文件回到 add 之前、PSK 与 key 都不在、
 * 记录也不在，再 discard 一次是 NOTHING。
 *
 * `restart` 要 systemd：把真的 replicate-hub.sh 与 common.sh 拷进一棵临时树，旁边放
 * 只管 pid 文件的 beta-up.sh / beta-down.sh 替身，PATH 上放一个按 oneshot 单元行事的
 * 假 systemctl（restart = ExecStop 若 active，再 ExecStart；ExecStart 见进程在跑就不
 * 重起，与真的 beta-up.sh 一样）。钉住：手工起的中枢腿（单元不是 active）也真的重起、
 * 由单元接管；单元管着的照旧一条 restart；重起没生效（pid 没换）就失败、不报 RESTARTED。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dir, 'replicate-hub.sh')
const IDENTITY = `qianmo://hub/console=${'k'.repeat(43)}`
const NODE_KEY = 'n'.repeat(43)
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const PEERS = [
  '# peers',
  `node beta-5 user=qianmo host=198.51.100.5 port=22 local-port=38631 remote-port=38625 trail=/home/qianmo/qianmo-beta/nodes/beta-5/config/qianmo/audit/trail.ndjson key=/home/q/.ssh/qianmo-beta-links/beta-5 server=p3 public-key=${'b'.repeat(43)}`,
  'qianmo://beta-5/planner  ws://127.0.0.1:38631',
  '',
].join('\n')
const CONSOLE_ENV =
  'CONSOLE_EXTRA_ARGS=--chat-url beta-5=ws://127.0.0.1:38631\nOTHER=1\n'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'replicate-hub-'))
  dirs.push(home)
  const root = join(home, 'qianmo-beta')
  mkdirSync(join(root, 'ops'), { recursive: true })
  mkdirSync(join(root, 'secrets', 'peers'), { recursive: true })
  writeFileSync(join(root, '.qianmo-beta-env'), 'qianmo-beta-env/v1\n')
  writeFileSync(join(root, 'peers.conf'), PEERS)
  writeFileSync(join(root, 'ops', 'console.env'), CONSOLE_ENV)
  const env: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    QIANMO_BETA_ROOT: root,
    QIANMO_BETA_CONSOLE_IDENTITY: IDENTITY,
    // Far from anything a developer machine listens on.
    QIANMO_BETA_REPLICATE_PORT_FIRST: '48631',
    QIANMO_BETA_REPLICATE_PORT_LAST: '48640',
  }
  const run = (...args: string[]) => {
    const ran = spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8' })
    return { code: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr }
  }
  return { home, root, run }
}

function fields(stdout: string, tag: string): string[] {
  return stdout
    .split('\n')
    .filter(line => line.startsWith(`${tag} `))
    .map(line => line.slice(tag.length + 1))
}

describe('replicate-hub.sh', () => {
  test('prepare, add, discard: the hub is back where it was', () => {
    const { home, root, run } = fixture()
    const prepared = run('prepare', '--node', 'n113-7', '--agent', 'main')
    expect(prepared.stderr).toBe('')
    expect(prepared.code).toBe(0)
    expect(fields(prepared.stdout, 'LOCAL_PORT')).toEqual(['48631'])
    const psk = join(root, 'secrets', 'peers', 'n113-7.psk')
    const key = join(home, '.ssh', 'qianmo-beta-links', 'n113-7')
    expect(fields(prepared.stdout, 'PSK_FILE')).toEqual([psk])
    expect(fields(prepared.stdout, 'LINK_KEY')).toEqual([key])
    expect(readFileSync(psk, 'utf8')).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(psk).mode & 0o777).toBe(0o600)
    expect(statSync(key).mode & 0o777).toBe(0o600)
    expect(fields(prepared.stdout, 'LINK_PUBKEY')[0]).toMatch(
      /^ssh-ed25519 [A-Za-z0-9+/=]+$/,
    )
    expect(fields(prepared.stdout, 'NODE_ARG')).toEqual([
      '--trust',
      IDENTITY,
      '--local-commands-from',
      'qianmo://hub/console',
      '--sign-handshake',
      '--omp-max-children=1',
      '--omp-idle-ms=60000',
    ])

    // A second prepare of the same name is refused before anything is written.
    const again = run('prepare', '--node', 'n113-7', '--agent', 'main')
    expect(again.code).toBe(1)

    const trail =
      '/root/qianmo-beta/nodes/n113-7/config/qianmo/audit/trail.ndjson'
    const added = run(
      'add',
      '--node',
      'n113-7',
      '--agent',
      'main',
      '--user',
      'root',
      '--host',
      '203.0.113.7',
      '--port',
      '22',
      '--local-port',
      '48631',
      '--server',
      '203.0.113.7',
      '--public-key',
      NODE_KEY,
      '--trail',
      trail,
    )
    expect(added.stderr).toBe('')
    expect(added.stdout).toBe('ADDED\n')
    const peers = readFileSync(join(root, 'peers.conf'), 'utf8')
    expect(peers).toBe(
      PEERS +
        `node n113-7 user=root host=203.0.113.7 port=22 local-port=48631 remote-port=38625 trail=${trail} key=${key} server=203.0.113.7 public-key=${NODE_KEY}\n` +
        'qianmo://n113-7/main  ws://127.0.0.1:48631\n',
    )
    expect(readFileSync(join(root, 'ops', 'console.env'), 'utf8')).toBe(
      'CONSOLE_EXTRA_ARGS=--chat-url beta-5=ws://127.0.0.1:38631 --chat-url n113-7=ws://127.0.0.1:48631\nOTHER=1\n',
    )

    const discarded = run('discard', '--node', 'n113-7')
    expect(discarded.stdout).toBe('DISCARDED\n')
    expect(readFileSync(join(root, 'peers.conf'), 'utf8')).toBe(PEERS)
    expect(readFileSync(join(root, 'ops', 'console.env'), 'utf8')).toBe(
      CONSOLE_ENV,
    )
    expect(existsSync(psk)).toBe(false)
    expect(existsSync(key)).toBe(false)
    expect(existsSync(`${key}.pub`)).toBe(false)
    expect(existsSync(join(root, 'state', 'replicate', 'n113-7.created'))).toBe(
      false,
    )
    expect(run('discard', '--node', 'n113-7').stdout).toBe('NOTHING\n')
  })

  test('a name already in peers.conf, or not a name, is refused', () => {
    const { root, run } = fixture()
    expect(run('prepare', '--node', 'beta-5', '--agent', 'main').code).toBe(1)
    expect(run('prepare', '--node', '../x', '--agent', 'main').code).not.toBe(0)
    expect(run('prepare', '--node', 'ok-1', '--agent', '-x').code).toBe(1)
    expect(existsSync(join(root, 'secrets', 'peers', 'beta-5.psk'))).toBe(false)
  })

  test('add refuses a loopback port another node holds', () => {
    const { run } = fixture()
    expect(run('prepare', '--node', 'n2', '--agent', 'main').code).toBe(0)
    const added = run(
      'add',
      '--node',
      'n2',
      '--agent',
      'main',
      '--user',
      'root',
      '--host',
      '203.0.113.8',
      '--port',
      '22',
      '--local-port',
      '38631',
      '--server',
      's',
      '--public-key',
      NODE_KEY,
      '--trail',
      '/root/t.ndjson',
    )
    expect(added.code).toBe(1)
    expect(added.stderr).toContain('38631')
  })
})

// ---------------------------------------------------------------------------
// restart

/** Only the pid files: what decides whether the real beta-up.sh restarts. */
const STUB_UP = `#!/usr/bin/env bash
printf 'beta-up %s\\n' "$*" >>"$FAKE_LOG"
proc=''
case " $* " in
  *' --only console '*) proc=console ;;
  *' --only registry '*) proc=registry ;;
esac
[ -n "$proc" ] || exit 0
file="$QIANMO_BETA_ROOT/run/$proc.pid"
if [ -f "$file" ]; then printf '%s 已在运行，不重起\\n' "$proc"; exit 0; fi
mkdir -p "$QIANMO_BETA_ROOT/run"
n=$(cat "$FAKE_SEQ" 2>/dev/null || echo 5000); n=$((n + 1)); printf '%s' "$n" >"$FAKE_SEQ"
printf '%s\\n' "$n" >"$file"
`

const STUB_DOWN = `#!/usr/bin/env bash
printf 'beta-down %s\\n' "$*" >>"$FAKE_LOG"
[ "\${FAKE_DOWN:-}" = noop ] || rm -f "$QIANMO_BETA_ROOT/run/$1.pid"
`

/** A oneshot unit: restart runs ExecStop when active, then ExecStart. */
const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
[ "$1" = --user ] && shift
cmd="$1"; shift
state() { cat "$FAKE_UNITS/$1" 2>/dev/null || printf 'inactive'; }
case "$cmd" in
  show-environment|cat|daemon-reload) exit 0 ;;
  is-active) s="$(state "$1")"; printf '%s\\n' "$s"; [ "$s" = active ] ;;
  restart)
    printf 'systemctl restart %s\\n' "$*" >>"$FAKE_LOG"
    for unit in "$@"; do
      proc=console; [ "$unit" = qianmo-registry.service ] && proc=registry
      if [ "$(state "$unit")" = active ]; then "$FAKE_BETA/beta-down.sh" "$proc"; fi
      "$FAKE_BETA/beta-up.sh" --role host --only "$proc"
      printf 'active' >"$FAKE_UNITS/$unit"
    done ;;
  *) exit 0 ;;
esac
`

function restartFixture(units: 'active' | 'inactive') {
  const { home, root } = fixture()
  const beta = join(home, 'tree', 'demo', 'env', 'beta')
  mkdirSync(join(beta, 'ops'), { recursive: true })
  copyFileSync(SCRIPT, join(beta, 'ops', 'replicate-hub.sh'))
  copyFileSync(
    resolve(import.meta.dir, '..', 'common.sh'),
    join(beta, 'common.sh'),
  )
  const bin = join(home, 'bin')
  mkdirSync(bin)
  for (const [path, text] of [
    [join(beta, 'beta-up.sh'), STUB_UP],
    [join(beta, 'beta-down.sh'), STUB_DOWN],
    [join(bin, 'systemctl'), FAKE_SYSTEMCTL],
  ] as const) {
    writeFileSync(path, text)
    chmodSync(path, 0o755)
  }
  const unitsDir = join(home, 'units')
  mkdirSync(unitsDir)
  for (const unit of ['qianmo-console.service', 'qianmo-registry.service'])
    writeFileSync(join(unitsDir, unit), units)
  // What is running now: started by hand, or by the units.
  mkdirSync(join(root, 'run'))
  writeFileSync(join(root, 'run', 'console.pid'), '4242\n')
  writeFileSync(join(root, 'run', 'registry.pid'), '4141\n')
  const log = join(home, 'calls.log')
  const run = (extra: Record<string, string> = {}) => {
    const ran = spawnSync(
      'bash',
      [join(beta, 'ops', 'replicate-hub.sh'), 'restart'],
      {
        env: {
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          LANG: 'C',
          QIANMO_BETA_ROOT: root,
          FAKE_LOG: log,
          FAKE_SEQ: join(home, 'seq'),
          FAKE_UNITS: unitsDir,
          FAKE_BETA: beta,
          ...extra,
        },
        encoding: 'utf8',
      },
    )
    return { code: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr }
  }
  const calls = () =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
  const pid = () =>
    readFileSync(join(root, 'run', 'console.pid'), 'utf8').trim()
  const unit = (name: string) => readFileSync(join(unitsDir, name), 'utf8')
  return { run, calls, pid, unit }
}

describe('replicate-hub.sh restart', () => {
  test('a hub leg started by hand: the old processes go, the units start new ones', () => {
    const h = restartFixture('inactive')
    const ran = h.run()
    expect(ran.stderr).toContain('qianmo-console.service 不是 active')
    expect(ran.code).toBe(0)
    expect(ran.stdout).toBe('RESTARTED\n')
    expect(h.calls()).toEqual([
      'beta-up --role host --only links',
      'beta-down console',
      'beta-down registry',
      'systemctl restart qianmo-registry.service qianmo-console.service',
      'beta-up --role host --only registry',
      'beta-up --role host --only console',
    ])
    expect(h.pid()).not.toBe('4242')
    expect(h.unit('qianmo-console.service')).toBe('active')
  })

  test('units that own the processes: one restart, nothing stopped beside it', () => {
    const h = restartFixture('active')
    const ran = h.run()
    expect(ran.code).toBe(0)
    expect(ran.stdout).toBe('RESTARTED\n')
    expect(h.calls()).toEqual([
      'beta-up --role host --only links',
      'systemctl restart qianmo-registry.service qianmo-console.service',
      'beta-down registry',
      'beta-up --role host --only registry',
      'beta-down console',
      'beta-up --role host --only console',
    ])
    expect(h.pid()).not.toBe('4242')
  })

  test('a restart that left the old console running fails, and says so', () => {
    // The 2026-10-14 shape: the old process survives, ExecStart keeps it.
    const h = restartFixture('inactive')
    const ran = h.run({ FAKE_DOWN: 'noop' })
    expect(ran.code).toBe(1)
    expect(ran.stdout).not.toContain('RESTARTED')
    expect(ran.stderr).toContain('控制台没有重起（run/console.pid 仍是 4242）')
    expect(h.pid()).toBe('4242')
  })
})
