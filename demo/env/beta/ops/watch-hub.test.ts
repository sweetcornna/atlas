// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `watch-hub.sh`：值守单元的接线——配置根是控制台那一份、一个进程只带目标节点那一把
 * PSK（从文件进环境，不上命令行）、作业文件里的 target 必须都在这个节点上；签名时从
 * peers.conf 现取目标节点公钥给 `--trust`，握手也签（节点带 `--controller` 时只收签名握手）。
 *
 * `bun` 用一个桩代替：它只把 argv 与三个环境变量记下来，不跑真的 `qm watch`（那一段由
 * tests/integration/qianmo-watch-signed.test.ts 对真实进程覆盖）。systemctl 用环境变量关掉。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dir, 'watch-hub.sh')
const REPO = resolve(import.meta.dir, '../../../..')
const PSK = 'c'.repeat(64)
const NODE_KEY = 'Inyg1lW5K3Tsc1VrzZ5-ifdAyfXrFzzBirnDnVsVsvQ'
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function jobs(targets: readonly string[]): string {
  return JSON.stringify(
    targets.map((target, i) => ({
      id: `job-${i}`,
      title: 't',
      target,
      url: 'ws://127.0.0.1:38632',
      prompt: 'p',
      schedule: { everyMs: 1_800_000 },
      taskTtlMs: 600_000,
      notifyPolicy: 'agent-initiated',
    })),
    null,
    2,
  )
}

function fixture(peers?: readonly string[]) {
  const home = mkdtempSync(join(tmpdir(), 'watch-hub-'))
  dirs.push(home)
  const root = join(home, 'qianmo-beta')
  mkdirSync(join(root, 'secrets', 'peers'), { recursive: true })
  mkdirSync(join(root, 'ops'), { recursive: true })
  writeFileSync(join(root, '.qianmo-beta-env'), 'qianmo-beta-env/v1\n')
  writeFileSync(join(root, 'secrets', 'peers', 'beta-5.psk'), `${PSK}\n`, {
    mode: 0o600,
  })
  if (peers !== undefined)
    writeFileSync(join(root, 'peers.conf'), `${peers.join('\n')}\n`)
  const stub = join(home, 'stub')
  const out = join(home, 'stub-out')
  mkdirSync(stub)
  mkdirSync(out)
  writeFileSync(
    join(stub, 'bun'),
    [
      '#!/bin/bash',
      'printf "%s\\n" "$@" >"$STUB_OUT/argv"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bash 的变量引用，不是 JS 模板占位
      'printf "psk=%s\\ncfg=%s\\nid=%s\\n" "${QIANMO_TRANSPORT_PSK:-}" "${QIANMO_CONFIG_DIR:-}" "${OCC_IDENTITY:-}" >"$STUB_OUT/env"',
      'echo "hub=PUBKEY"',
      '',
    ].join('\n'),
  )
  chmodSync(join(stub, 'bun'), 0o755)
  const jobFile = join(home, 'jobs.json')
  writeFileSync(jobFile, jobs(['qianmo://beta-5/ops']))
  const env: Record<string, string> = {
    HOME: home,
    PATH: `${stub}:/usr/bin:/bin`,
    QIANMO_BETA_ROOT: root,
    XDG_CONFIG_HOME: join(home, '.config'),
    QIANMO_WATCH_NO_SYSTEMCTL: '1',
    STUB_OUT: out,
    QIANMO_QM_BINARY: join(stub, 'bun'),
  }
  return { home, root, env, out, jobFile }
}

function sh(env: Record<string, string>, args: readonly string[]) {
  const result = Bun.spawnSync(['bash', SCRIPT, ...args], { env })
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe('install', () => {
  test('参数 0600、作业拷进内测根 0600、单元不留占位符且 OOMScoreAdjust=900', () => {
    const f = fixture()
    const result = sh(f.env, [
      'install',
      '--node',
      'beta-5',
      '--jobs',
      f.jobFile,
      '--sign',
    ])
    expect(result.code).toBe(0)
    const conf = join(f.root, 'ops', 'watch.env')
    expect(statSync(conf).mode & 0o777).toBe(0o600)
    expect(readFileSync(conf, 'utf8')).toContain('WATCH_NODE=beta-5\n')
    expect(readFileSync(conf, 'utf8')).toContain('WATCH_SIGN=1\n')
    expect(readFileSync(conf, 'utf8')).toContain(
      'WATCH_FROM=qianmo://hub/console\n',
    )
    const copied = join(f.root, 'watch', 'jobs.json')
    expect(statSync(copied).mode & 0o777).toBe(0o600)
    expect(readFileSync(copied, 'utf8')).toBe(readFileSync(f.jobFile, 'utf8'))
    const unit = readFileSync(
      join(f.home, '.config', 'systemd', 'user', 'qianmo-watch.service'),
      'utf8',
    )
    expect(unit).not.toMatch(/@[A-Z_]+@/)
    expect(unit).toContain('demo/env/beta/ops/watch-hub.sh run')
    expect(unit).toContain('OOMScoreAdjust=900')
    expect(unit).not.toContain(PSK)
  })

  test.each([
    [
      '作业里有别的节点的 target',
      ['qianmo://beta-5/ops', 'qianmo://beta-1/reviewer'],
    ],
    ['作业里一个 target 都没有', []],
  ])('%s：拒绝', (_label, targets) => {
    const f = fixture()
    writeFileSync(f.jobFile, jobs(targets))
    const result = sh(f.env, [
      'install',
      '--node',
      'beta-5',
      '--jobs',
      f.jobFile,
    ])
    expect(result.code).not.toBe(0)
  })

  test('缺该节点的 PSK 文件：拒绝', () => {
    const f = fixture()
    writeFileSync(f.jobFile, jobs(['qianmo://beta-9/ops']))
    const result = sh(f.env, [
      'install',
      '--node',
      'beta-9',
      '--jobs',
      f.jobFile,
    ])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('PSK')
  })
})

describe('run', () => {
  test('PSK 从文件进环境、不上命令行；配置根是控制台那一份；带 --sign', () => {
    const f = fixture()
    expect(
      sh(f.env, ['install', '--node', 'beta-5', '--jobs', f.jobFile, '--sign'])
        .code,
    ).toBe(0)
    const result = sh(f.env, ['run'])
    expect(result.code).toBe(0)
    const argv = readFileSync(join(f.out, 'argv'), 'utf8').trim().split('\n')
    expect(argv).toEqual([
      'watch',
      '--jobs',
      join(f.root, 'watch', 'jobs.json'),
      '--from',
      'qianmo://hub/console',
      '--sign',
    ])
    expect(argv.join(' ')).not.toContain(PSK)
    const env = readFileSync(join(f.out, 'env'), 'utf8')
    expect(env).toContain(`psk=${PSK}\n`)
    expect(env).toContain(`cfg=${join(f.root, 'nodes', 'console', 'config')}\n`)
    expect(env).toContain('id=\n')
    expect(result.stdout + result.stderr).not.toContain(PSK)
  })

  const TUNNELED = [
    `node beta-5 user=ops host=203.0.113.5 local-port=38632 public-key=${NODE_KEY}`,
    'qianmo://beta-5/ops ws://127.0.0.1:38632',
  ]

  function runArgv(f: ReturnType<typeof fixture>, sign: boolean) {
    expect(
      sh(f.env, [
        'install',
        '--node',
        'beta-5',
        '--jobs',
        f.jobFile,
        ...(sign ? ['--sign'] : []),
      ]).code,
    ).toBe(0)
    const result = sh(f.env, ['run'])
    expect(result.code).toBe(0)
    return {
      result,
      argv: readFileSync(join(f.out, 'argv'), 'utf8').trim().split('\n'),
    }
  }

  test('签名 + 坐标行有 public-key=：加 --trust <节点>=<公钥>，握手也签', () => {
    const { result, argv } = runArgv(fixture(TUNNELED), true)
    expect(argv.slice(-3)).toEqual(['--sign', '--trust', `beta-5=${NODE_KEY}`])
    expect(result.stdout).toContain(`握手签名：--trust beta-5=${NODE_KEY}`)
    expect(result.stdout).not.toContain('WARN')
  })

  test('签名 + 本机节点（回环端点、无坐标行）：公钥读本机身份文件，私钥不进输出', () => {
    const f = fixture(['qianmo://beta-5/ops ws://127.0.0.1:38632'])
    const dir = join(f.root, 'nodes', 'beta-5', 'config', 'qianmo', 'identity')
    mkdirSync(dir, { recursive: true })
    const secret = 'S'.repeat(43)
    writeFileSync(
      join(dir, 'beta-5.json'),
      JSON.stringify(
        { node: 'beta-5', publicKey: NODE_KEY, privateKey: secret },
        null,
        2,
      ),
    )
    const { result, argv } = runArgv(f, true)
    expect(argv.slice(-2)).toEqual(['--trust', `beta-5=${NODE_KEY}`])
    expect(result.stdout + result.stderr).not.toContain(secret)
    expect(argv.join(' ')).not.toContain(secret)
  })

  test('签名但取不到公钥：WARN 点名 signature_required，照旧 PSK 握手（不带 --trust）', () => {
    const { result, argv } = runArgv(
      fixture([
        'node beta-5 user=ops host=203.0.113.5 local-port=38632',
        'qianmo://beta-5/ops ws://127.0.0.1:38632',
      ]),
      true,
    )
    expect(argv).not.toContain('--trust')
    expect(argv.at(-1)).toBe('--sign')
    expect(result.stdout).toContain(
      'WARN : 握手不签名（PSK）：取不到 beta-5 的公钥',
    )
    expect(result.stdout).toContain('public-key=')
    expect(result.stdout).toContain('signature_required')
  })

  test('不签名：peers.conf 有公钥也不带 --trust（qm watch 的 --trust 只在 --sign 下合法）', () => {
    const { argv } = runArgv(fixture(TUNNELED), false)
    expect(argv).not.toContain('--trust')
    expect(argv).not.toContain('--sign')
  })

  test('install --sign 报一声握手签名，但公钥不写进 watch.env', () => {
    const f = fixture(TUNNELED)
    const result = sh(f.env, [
      'install',
      '--node',
      'beta-5',
      '--jobs',
      f.jobFile,
      '--sign',
    ])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`握手签名：--trust beta-5=${NODE_KEY}`)
    expect(result.stdout).toContain('--sign-handshake')
    expect(
      readFileSync(join(f.root, 'ops', 'watch.env'), 'utf8'),
    ).not.toContain(NODE_KEY)
  })

  test('install 之后作业文件被改成别的节点：run 拒绝起', () => {
    const f = fixture()
    expect(
      sh(f.env, ['install', '--node', 'beta-5', '--jobs', f.jobFile]).code,
    ).toBe(0)
    writeFileSync(
      join(f.root, 'watch', 'jobs.json'),
      jobs(['qianmo://beta-1/reviewer']),
    )
    const result = sh(f.env, ['run'])
    expect(result.code).not.toBe(0)
  })
})

describe('print-identity', () => {
  test('问的是控制台那个配置根；只要 --from，不读 PSK', () => {
    const f = fixture()
    const result = sh(f.env, ['print-identity'])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('hub=PUBKEY')
    const argv = readFileSync(join(f.out, 'argv'), 'utf8').trim().split('\n')
    expect(argv).toEqual([
      'watch',
      '--print-identity',
      '--from',
      'qianmo://hub/console',
    ])
    const env = readFileSync(join(f.out, 'env'), 'utf8')
    expect(env).toContain('psk=\n')
    const config = join(f.root, 'nodes', 'console', 'config')
    expect(env).toContain(`cfg=${config}\n`)
    expect(statSync(config).mode & 0o777).toBe(0o700)
  })
})
