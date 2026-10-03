// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 内测接线里的模型服务（P18.6，`providers-console-m1.md` §2.5、§2.8、§3.8）。
 *
 * 钉四件事：
 *
 * ① 尾参里有 `--providers` 时，H 腿给控制台补上主密钥、中枢 known_hosts 与逐节点的
 *   执行器——有坐标行且专用 key 在 → ssh；没有坐标行、端点是回环 → 本机直接起
 *   `model-apply.sh`；其余跳过并告警；
 * ② 没有 `--providers` 时一个模型服务参数都不出现（控制台照旧）；
 * ③ `--providers` 不带 `--accounts` 时 H 腿当场拒绝，控制台不起；
 * ④ `beta-reset.sh` **任何参数**都不动主密钥：字节、权限位都不变（带正向对照：
 *   同一次运行里 `--archive-config` 确实把配置根挪走了，说明脚本真跑到了那一步）。
 *
 * 做法与 `beta-up-args.test.ts` 相同：把脚本复制进一棵临时「仓库」，common.sh 末尾把
 * `beta_start_process` 换成只记命令行的桩，不起任何真进程、不碰端口。
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BETA_DIR = join(REPOSITORY_ROOT, 'demo/env/beta')

const RECORDER = `
beta_start_process() {
  local name="$1"
  shift 2
  {
    printf '=== %s\\n' "$name"
    printf '%s\\n' "$@"
  } >>"$BETA_ARGV_LOG"
  exit 0
}
`

/** systemctl that answers "not installed yet" and records nothing we assert on. */
const FAKE_SYSTEMCTL = `#!/bin/bash
for a in "$@"; do
  case "$a" in
    is-enabled) printf 'disabled\\n'; exit 1 ;;
    is-active)  printf 'inactive\\n'; exit 3 ;;
  esac
done
exit 0
`

// Written and run once at module scope: the first exec of a new file on macOS
// pays a policy scan with no upper bound (beta-up-args.test.ts, issue #56).
const STUB_HOME = mkdtempSync(join(tmpdir(), 'qianmo-beta-providers-bin-'))
const STUB_BIN = join(STUB_HOME, 'bin')
mkdirSync(STUB_BIN, { recursive: true })
writeFileSync(join(STUB_BIN, 'systemctl'), FAKE_SYSTEMCTL)
chmodSync(join(STUB_BIN, 'systemctl'), 0o755)
Bun.spawnSync([join(STUB_BIN, 'systemctl'), '--version'], {
  stdout: 'ignore',
  stderr: 'ignore',
})
afterAll(() => rmSync(STUB_HOME, { force: true, recursive: true }))

const scratches: string[] = []
afterEach(() => {
  for (const value of scratches.splice(0)) {
    rmSync(value, { force: true, recursive: true })
  }
})

interface Scratch {
  readonly repo: string
  readonly root: string
  readonly keyDir: string
  readonly argvLog: string
  readonly xdg: string
}

function scratch(): Scratch {
  const base = mkdtempSync(join(tmpdir(), 'qianmo-beta-providers-'))
  scratches.push(base)
  const repo = join(base, 'repo')
  const beta = join(repo, 'demo/env/beta')
  mkdirSync(join(beta, 'ops'), { recursive: true })
  for (const name of ['beta-up.sh', 'beta-reset.sh', 'beta-down.sh']) {
    copyFileSync(join(BETA_DIR, name), join(beta, name))
    chmodSync(join(beta, name), 0o755)
  }
  writeFileSync(
    join(beta, 'common.sh'),
    readFileSync(join(BETA_DIR, 'common.sh'), 'utf8') + RECORDER,
  )
  for (const name of readdirSync(join(BETA_DIR, 'ops'))) {
    if (
      name.endsWith('.in') ||
      name === 'mirror-pull.sh' ||
      name === 'model-apply.sh'
    ) {
      copyFileSync(join(BETA_DIR, 'ops', name), join(beta, 'ops', name))
    }
  }
  mkdirSync(join(repo, 'demo/lib'), { recursive: true })
  copyFileSync(
    join(REPOSITORY_ROOT, 'demo/lib/entry.sh'),
    join(repo, 'demo/lib/entry.sh'),
  )
  mkdirSync(join(repo, 'dist/demo'), { recursive: true })
  for (const entry of ['p81-registry', 'p81-probe']) {
    writeFileSync(join(repo, `dist/demo/${entry}.js`), `// stub for ${entry}\n`)
  }
  writeFileSync(
    join(repo, 'dist/cli-node.js'),
    '// stub; the recorder never runs it\n',
  )
  const root = join(base, 'beta-root')
  mkdirSync(join(root, 'secrets', 'peers'), { recursive: true })
  writeFileSync(join(root, 'secrets', 'transport-psk'), 'psk-for-test\n')
  chmodSync(join(root, 'secrets', 'transport-psk'), 0o600)
  const keyDir = join(base, 'model-keys')
  mkdirSync(keyDir, { recursive: true, mode: 0o700 })
  return {
    repo,
    root,
    keyDir,
    argvLog: join(base, 'argv.log'),
    xdg: join(base, 'xdg'),
  }
}

function env(place: Scratch): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    PATH: `${STUB_BIN}:${dirname(process.execPath)}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: place.xdg,
    QIANMO_BETA_ROOT: place.root,
    QIANMO_BETA_MODEL_KEY_DIR: place.keyDir,
    BETA_ARGV_LOG: place.argvLog,
  }
}

function runScript(place: Scratch, script: string, args: readonly string[]) {
  const child = Bun.spawnSync(
    ['/bin/bash', join(place.repo, 'demo/env/beta', script), ...args],
    { cwd: place.repo, env: env(place), stdout: 'pipe', stderr: 'pipe' },
  )
  return {
    exitCode: child.exitCode,
    out: `${child.stdout.toString()}${child.stderr.toString()}`,
  }
}

function consoleArgv(place: Scratch): string[] | undefined {
  if (!existsSync(place.argvLog)) return undefined
  let current: string[] | undefined
  let found: string[] | undefined
  for (const line of readFileSync(place.argvLog, 'utf8').split('\n')) {
    if (line.startsWith('=== ')) {
      current = []
      if (line.slice(4) === 'console') found = current
    } else if (line !== '' && current !== undefined) {
      current.push(line)
    }
  }
  return found
}

function writePeers(place: Scratch, lines: readonly string[]): void {
  writeFileSync(join(place.root, 'peers.conf'), `${lines.join('\n')}\n`)
  chmodSync(join(place.root, 'peers.conf'), 0o600)
}

const PEERS = [
  'local-server hub',
  'qianmo://beta-1/planner ws://127.0.0.1:38625',
  'node beta-2 user=qianmo host=node2.example port=2222 local-port=38632',
  'qianmo://beta-2/planner ws://127.0.0.1:38632',
  'node beta-3 user=ops host=2001:db8::7 local-port=38633',
  'qianmo://beta-3/planner ws://127.0.0.1:38633',
  'node beta-4 user=qianmo host=node4.example local-port=38634',
  'qianmo://beta-4/planner ws://127.0.0.1:38634',
  'qianmo://beta-5/planner ws://203.0.113.9:38625',
]

/** `value` right after each occurrence of `flag`. */
function valuesOf(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) =>
    arg === flag && index + 1 < args.length ? [args[index + 1] as string] : [],
  )
}

describe('the host leg wires model services when the tail asks for them', () => {
  test('--providers: master key, known_hosts and one executor per reachable node', () => {
    const place = scratch()
    writePeers(place, PEERS)
    for (const node of ['beta-2', 'beta-3']) {
      writeFileSync(join(place.keyDir, node), 'not a real key\n', {
        mode: 0o600,
      })
    }
    const result = runScript(place, 'beta-up.sh', [
      '--role',
      'host',
      '--only',
      'console',
      '--',
      '--accounts',
      '--providers',
    ])
    const args = consoleArgv(place)
    expect({ got: args !== undefined, out: result.out }).toEqual({
      got: true,
      out: result.out,
    })
    const argv = args ?? []
    expect(valuesOf(argv, '--provider-key-file')).toEqual([
      join(place.root, 'secrets/provider-master.key'),
    ])
    expect(valuesOf(argv, '--provider-known-hosts')).toEqual([
      join(place.keyDir, 'known_hosts'),
    ])
    expect(valuesOf(argv, '--provider-local')).toEqual([
      `beta-1=${join(place.repo, 'demo/env/beta/ops/model-apply.sh')}`,
    ])
    expect(valuesOf(argv, '--provider-ssh')).toEqual([
      'beta-2=qianmo@node2.example:2222',
      'beta-3=ops@[2001:db8::7]:22',
    ])
    expect(valuesOf(argv, '--provider-ssh-key')).toEqual([
      `beta-2=${join(place.keyDir, 'beta-2')}`,
      `beta-3=${join(place.keyDir, 'beta-3')}`,
    ])
    // beta-4 has no dedicated key, beta-5 is a direct remote node: neither is in
    // the lists above (they are exact), and both are said so.
    expect(result.out).toContain('beta-4 缺第六类动作专用 key')
    expect(result.out).toContain('beta-5 是直连的远端节点')
    expect(result.out).toContain('缺中枢的 known_hosts')
    // The switches themselves stay where the operator put them: last.
    expect(argv.slice(-2)).toEqual(['--accounts', '--providers'])
  })

  test('without --providers no model-service argument appears', () => {
    const place = scratch()
    writePeers(place, PEERS)
    writeFileSync(join(place.keyDir, 'beta-2'), 'not a real key\n', {
      mode: 0o600,
    })
    const result = runScript(place, 'beta-up.sh', [
      '--role',
      'host',
      '--only',
      'console',
      '--',
      '--accounts',
    ])
    const argv = consoleArgv(place)
    expect({ got: argv !== undefined, out: result.out }).toEqual({
      got: true,
      out: result.out,
    })
    expect((argv ?? []).filter(arg => arg.startsWith('--provider'))).toEqual([])
  })

  test('--providers without --accounts stops the host leg before the console starts', () => {
    const place = scratch()
    writePeers(place, PEERS)
    const result = runScript(place, 'beta-up.sh', [
      '--role',
      'host',
      '--only',
      'console',
      '--',
      '--providers',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.out).toContain('尾参里有 --providers 但没有 --accounts')
    expect(consoleArgv(place)).toBeUndefined()
  })
})

describe('beta-reset.sh never touches the master key', () => {
  const ARGS: readonly (readonly string[])[] = [
    [],
    ['--purge-logs'],
    ['--purge-state'],
    ['--archive-config'],
    ['--purge-links'],
    ['--purge-logs', '--purge-state', '--archive-config', '--purge-links'],
  ]
  for (const args of ARGS) {
    test(`beta-reset.sh ${args.join(' ') || '(no arguments)'}`, () => {
      const place = scratch()
      writePeers(place, ['qianmo://beta-1/planner ws://127.0.0.1:38625'])
      // Seed the root the way a real host leg does.
      runScript(place, 'beta-up.sh', [
        '--role',
        'host',
        '--only',
        'console',
        '--',
        '--accounts',
        '--providers',
      ])
      const key = join(place.root, 'secrets/provider-master.key')
      const content = `${'a1'.repeat(32)}\n`
      writeFileSync(key, content, { mode: 0o600 })
      chmodSync(key, 0o600)
      // Ciphertext and book in the console's config root, as the console writes them.
      const consoleDir = join(place.root, 'nodes/console/config/qianmo/console')
      mkdirSync(consoleDir, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(consoleDir, 'provider-secrets.json'),
        '{"v":1,"entries":{}}',
        {
          mode: 0o600,
        },
      )
      const before = statSync(key)

      const result = runScript(place, 'beta-reset.sh', args)
      expect({ code: result.exitCode, out: result.out }).toEqual({
        code: 0,
        out: result.out,
      })
      expect(existsSync(key)).toBe(true)
      expect(readFileSync(key, 'utf8')).toBe(content)
      const after = statSync(key)
      expect(after.mode & 0o777).toBe(0o600)
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(statSync(join(place.root, 'secrets')).mode & 0o777).toBe(0o700)
      if (args.includes('--archive-config')) {
        // §3.8: the deliberate deviation is said out loud.
        expect(result.out).toContain(
          '模型服务的密文随配置根一起归档了（console',
        )
        // Positive control: the reset did reach the config roots — the ciphertext
        // moved with the console's, the key stayed where it was.
        expect(existsSync(join(place.root, 'nodes/console/config'))).toBe(false)
        const archived = readdirSync(join(place.root, 'nodes/console')).filter(
          name => name.startsWith('config.bad-'),
        )
        expect(archived).toHaveLength(1)
        expect(
          existsSync(
            join(
              place.root,
              'nodes/console',
              archived[0] ?? '',
              'qianmo/console/provider-secrets.json',
            ),
          ),
        ).toBe(true)
      }
    })
  }
})
