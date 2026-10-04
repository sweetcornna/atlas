// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 迁移与真机验收要的部署接线（P18.13，`providers-console-m1.md` §2.9、§5.11.8）。
 *
 * 钉五件事，每个 bash 各一遍（`testBashes.ts`）：
 *
 * ① P18.20 的节点尾参 `--trust console=<公钥> --local-commands-from console` 原样到
 *   resident 命令行末尾，并且**活过 beta-down + beta-up**（issue #111 的记录）；
 * ② 控制台的 `--chat-sign` 与 `--accounts --providers` 一起落进 `ops/console.env`，
 *   systemd 单元那条 ExecStart（`--only console -- $CONSOLE_EXTRA_ARGS`）起出来的
 *   控制台仍带着它；手工不带尾参重跑会**点名**说撤掉了它（不静默）；
 * ③ 按节点开缓存诊断 / 24h 保留：放进这台机器的 model-env，起 resident 那一刻在环境里，
 *   重启之后还在；横幅把它们报成「缓存调参」而不是 openai 凭据，不认识的值不回显；
 * ④ 节点迁到中枢托管之后（state.json 记着一次已提交的下发），没有 model-env 不再报
 *   「Not logged in」的假警；model-env 里残留模型服务类的键时 WARN（只报个数）；
 * ⑤ 没托管的节点照旧 WARN（正向对照：判据真的是 state.json，不是一律放过）。
 *
 * 做法照 `beta-up-args.test.ts`：脚本复制进临时「仓库」，common.sh 末尾把
 * `beta_start_process` 换成记账桩——这里的桩多记两把缓存键在进程环境里的样子。
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
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { testBashes } from './testBashes'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BETA_DIR = join(REPOSITORY_ROOT, 'demo/env/beta')
const BASHES = testBashes()

/** 记命令行，再记两把缓存键此刻在环境里的样子（`<unset>` = 没有）。 */
const RECORDER = `
beta_start_process() {
  local name="$1"
  shift 2
  {
    printf '=== %s\\n' "$name"
    printf '%s\\n' "$@"
    printf 'ENV OPENAI_PROMPT_CACHE_DIAGNOSTICS=%s\\n' "\${OPENAI_PROMPT_CACHE_DIAGNOSTICS-<unset>}"
    printf 'ENV OPENAI_PROMPT_CACHE_RETENTION=%s\\n' "\${OPENAI_PROMPT_CACHE_RETENTION-<unset>}"
  } >>"$BETA_ARGV_LOG"
  exit 0
}
`

const FAKE_SYSTEMCTL = `#!/bin/bash
for a in "$@"; do
  case "$a" in
    is-enabled) printf 'disabled\\n'; exit 1 ;;
    is-active)  printf 'inactive\\n'; exit 3 ;;
  esac
done
exit 0
`

// 桩写一次、先跑一次：macOS 对新 inode 的首次 exec 有一次没有上界的策略扫描（issue #56）。
const STUB_HOME = mkdtempSync(join(tmpdir(), 'qianmo-beta-wiring-bin-'))
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
  const base = mkdtempSync(join(tmpdir(), 'qianmo-beta-wiring-'))
  scratches.push(base)
  const repo = join(base, 'repo')
  const beta = join(repo, 'demo/env/beta')
  mkdirSync(join(beta, 'ops'), { recursive: true })
  for (const name of ['beta-up.sh', 'beta-down.sh']) {
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
  writeFileSync(join(repo, 'dist/cli-node.js'), '// stub; never run\n')
  const root = join(base, 'beta-root')
  mkdirSync(join(root, 'secrets', 'peers'), { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'secrets', 'transport-psk'), 'psk-for-test\n', {
    mode: 0o600,
  })
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

interface Run {
  readonly code: number
  readonly out: string
}

function run(
  bash: string,
  place: Scratch,
  script: string,
  args: readonly string[],
): Run {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${STUB_BIN}:${dirname(process.execPath)}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: place.xdg,
    QIANMO_BETA_ROOT: place.root,
    QIANMO_BETA_MODEL_KEY_DIR: place.keyDir,
    // 一个开发机上不会有人占着的口，免得「起之前先问端口空不空」撞上真进程。
    QIANMO_BETA_NODE_PORT: '38979',
    BETA_ARGV_LOG: place.argvLog,
  }
  // 两把缓存键只许来自被测的 model-env。不钉 locale：让 bash 3.2 真按多字节跑
  // （shell-fullwidth-expansion.test.ts 的理由）。
  delete env.OPENAI_PROMPT_CACHE_DIAGNOSTICS
  delete env.OPENAI_PROMPT_CACHE_RETENTION
  const child = Bun.spawnSync(
    [bash, join(place.repo, 'demo/env/beta', script), ...args],
    { cwd: place.repo, env, stdout: 'pipe', stderr: 'pipe' },
  )
  return {
    code: child.exitCode,
    out: `${child.stdout.toString()}${child.stderr.toString()}`,
  }
}

/** 记账桩录下的最后一段（按进程名）。 */
function lastBlock(place: Scratch, name: string): string[] | undefined {
  if (!existsSync(place.argvLog)) return undefined
  let current: string[] | undefined
  let found: string[] | undefined
  for (const line of readFileSync(place.argvLog, 'utf8').split('\n')) {
    if (line.startsWith('=== ')) {
      current = []
      if (line.slice(4) === name) found = current
    } else if (line !== '' && current !== undefined) {
      current.push(line)
    }
  }
  return found
}

const argvOf = (block: readonly string[] | undefined): string[] =>
  (block ?? []).filter(line => !line.startsWith('ENV '))
const envOf = (block: readonly string[] | undefined): string[] =>
  (block ?? []).filter(line => line.startsWith('ENV '))

function writeModelEnv(place: Scratch, lines: readonly string[]): void {
  writeFileSync(
    join(place.root, 'secrets', 'model-env'),
    `${lines.join('\n')}\n`,
    {
      mode: 0o600,
    },
  )
}

/** 与节点写 state.json 同一个形状：`writePrivateJson` = `JSON.stringify(v, null, 2)`（store.ts）。 */
function writeProviderState(
  place: Scratch,
  node: string,
  applied: Record<string, unknown> | null,
): void {
  const dir = join(place.root, 'nodes', node, 'config', 'qianmo', 'provider')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(dir, 'state.json'),
    `${JSON.stringify({ v: 1, applied, appliedHash: applied === null ? null : `sha256:${'a'.repeat(64)}` }, null, 2)}\n`,
    { mode: 0o600 },
  )
}

const CONSOLE_PK = 'console=Fake_Public_Key-0123456789abcdefghijklmnopqrstu'
const P18_20_TAIL = ['--trust', CONSOLE_PK, '--local-commands-from', 'console']

test('至少找到一个 bash（macOS 上是 3.2，Linux 上是 5）', () => {
  expect(BASHES.length).toBeGreaterThan(0)
})

for (const bash of BASHES) {
  describe(`bash ${bash.version}`, () => {
    test('P18.20 的节点尾参原样到 resident 末尾，beta-down + beta-up 之后一字不差', () => {
      const place = scratch()
      writeModelEnv(place, ['OPENAI_PROMPT_CACHE_DIAGNOSTICS=1'])
      const first = run(bash.path, place, 'beta-up.sh', [
        '--role',
        'node',
        '--node',
        'beta-1',
        '--',
        ...P18_20_TAIL,
      ])
      const before = lastBlock(place, 'beta-1')
      expect({ got: before !== undefined, out: first.out }).toEqual({
        got: true,
        out: first.out,
      })
      expect(argvOf(before).slice(-4)).toEqual(P18_20_TAIL)
      expect(envOf(before)).toEqual([
        'ENV OPENAI_PROMPT_CACHE_DIAGNOSTICS=1',
        'ENV OPENAI_PROMPT_CACHE_RETENTION=<unset>',
      ])

      const down = run(bash.path, place, 'beta-down.sh', ['beta-1'])
      expect({ code: down.code, out: down.out }).toEqual({
        code: 0,
        out: down.out,
      })
      // 「停机 → 换产物 → 起机」里的那次起机：谁都不会把尾参再抄一遍。
      const second = run(bash.path, place, 'beta-up.sh', [
        '--role',
        'node',
        '--node',
        'beta-1',
      ])
      const after = lastBlock(place, 'beta-1')
      expect(second.out).toContain('沿用上一次记下的尾参')
      expect(argvOf(after)).toEqual(argvOf(before))
      expect(envOf(after)).toEqual(envOf(before))
    })

    test('控制台 --chat-sign 落进 console.env，单元那条 ExecStart 起出来仍带着它；手工不带尾参重跑会点名撤掉', () => {
      const place = scratch()
      writeFileSync(
        join(place.root, 'peers.conf'),
        'qianmo://beta-1/planner ws://127.0.0.1:38625\n',
        { mode: 0o600 },
      )
      const tail = ['--accounts', '--providers', '--chat-sign']
      const first = run(bash.path, place, 'beta-up.sh', [
        '--role',
        'host',
        '--only',
        'console',
        '--',
        ...tail,
      ])
      expect(argvOf(lastBlock(place, 'console')).slice(-3)).toEqual(tail)
      const env = readFileSync(join(place.root, 'ops/console.env'), 'utf8')
      const line = env
        .split('\n')
        .find(entry => entry.startsWith('CONSOLE_EXTRA_ARGS='))
      expect({ line, out: first.out }).toEqual({
        line: 'CONSOLE_EXTRA_ARGS=--accounts --providers --chat-sign',
        out: first.out,
      })

      // systemd 的那一趟：`$CONSOLE_EXTRA_ARGS` 按空白分词后跟在 `--only console --` 后面。
      run(bash.path, place, 'beta-down.sh', ['console'])
      const unitArgs = (line ?? '')
        .slice('CONSOLE_EXTRA_ARGS='.length)
        .split(' ')
      const restarted = run(bash.path, place, 'beta-up.sh', [
        '--role',
        'host',
        '--only',
        'console',
        '--',
        ...unitArgs,
      ])
      const argv = argvOf(lastBlock(place, 'console'))
      expect({ tail: argv.slice(-3), out: restarted.out }).toEqual({
        tail,
        out: restarted.out,
      })
      // --providers 的拓扑那一半也跟着回来了（P18.6 的接线）。
      expect(argv).toContain('--provider-key-file')

      // 手工重跑、忘了尾参：控制台腿按设计撤掉，但要点名——不是静默。
      run(bash.path, place, 'beta-down.sh', ['console'])
      const bare = run(bash.path, place, 'beta-up.sh', [
        '--role',
        'host',
        '--only',
        'console',
      ])
      expect(bare.out).toContain('--accounts --providers --chat-sign')
      expect(bare.out).toContain('会被撤掉')
    })

    test('按节点开 24h 保留：在 resident 的环境里，横幅报成缓存调参而不是 openai', () => {
      const place = scratch()
      writeModelEnv(place, [
        'export OPENAI_PROMPT_CACHE_RETENTION=24h',
        'OPENAI_PROMPT_CACHE_DIAGNOSTICS=1',
      ])
      const result = run(bash.path, place, 'beta-up.sh', [
        '--role',
        'node',
        '--node',
        'beta-3',
      ])
      expect(envOf(lastBlock(place, 'beta-3'))).toEqual([
        'ENV OPENAI_PROMPT_CACHE_DIAGNOSTICS=1',
        'ENV OPENAI_PROMPT_CACHE_RETENTION=24h',
      ])
      expect(result.out).toContain('2 个环境键，涉及 缓存调参）')
      expect(result.out).toContain(
        '缓存调参 : OPENAI_PROMPT_CACHE_DIAGNOSTICS=1 OPENAI_PROMPT_CACHE_RETENTION=24h',
      )
    })

    test('不认识的保留期值不回显', () => {
      const place = scratch()
      writeModelEnv(place, [
        'OPENAI_PROMPT_CACHE_RETENTION=sk-pasted-here-by-mistake',
      ])
      const result = run(bash.path, place, 'beta-up.sh', [
        '--role',
        'node',
        '--node',
        'beta-3',
      ])
      expect(result.out).toContain(
        '缓存调参 : OPENAI_PROMPT_CACHE_RETENTION=（值不认识，未回显）',
      )
      expect(result.out).not.toContain('sk-pasted-here-by-mistake')
    })

    test('中枢托管的节点没有 model-env：说「由中枢托管」，不报 Not logged in', () => {
      const place = scratch()
      writeProviderState(place, 'beta-2', {
        profileId: 'luna',
        revision: 3,
        requestId: 'req-0000000001',
        at: '2026-10-04T00:00:00.000Z',
      })
      const result = run(bash.path, place, 'beta-up.sh', [
        '--role',
        'node',
        '--node',
        'beta-2',
      ])
      expect({
        got: lastBlock(place, 'beta-2') !== undefined,
        out: result.out,
      }).toEqual({
        got: true,
        out: result.out,
      })
      expect(result.out).toContain('模型服务由中枢托管')
      expect(result.out).not.toContain('Not logged in')
    })

    test('中枢托管的节点 model-env 里还有模型服务类的键：WARN env-residue，只报个数', () => {
      const place = scratch()
      writeProviderState(place, 'beta-2', {
        profileId: 'luna',
        revision: 3,
        requestId: 'req-0000000001',
        at: '2026-10-04T00:00:00.000Z',
      })
      writeModelEnv(place, [
        'OPENAI_API_KEY=sk-test-canary-residue-0123456789',
        'OPENAI_WIRE_API=responses',
        'OPENAI_PROMPT_CACHE_DIAGNOSTICS=1',
      ])
      const result = run(bash.path, place, 'beta-up.sh', [
        '--role',
        'node',
        '--node',
        'beta-2',
      ])
      expect(result.out).toContain('model-env 里还有 2 个模型服务类的键')
      expect(result.out).toContain('env-residue')
      expect(result.out).not.toContain('sk-test-canary-residue')
      expect(result.out).not.toContain('OPENAI_API_KEY')
    })

    test('没托管的节点（state.json 里 applied 是 null）照旧 WARN Not logged in', () => {
      const place = scratch()
      writeProviderState(place, 'beta-2', null)
      const result = run(bash.path, place, 'beta-up.sh', [
        '--role',
        'node',
        '--node',
        'beta-2',
      ])
      expect(result.out).toContain('Not logged in')
      expect(result.out).not.toContain('模型服务由中枢托管')
    })
  })
}
