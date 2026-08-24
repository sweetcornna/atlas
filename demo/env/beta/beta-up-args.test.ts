// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `beta-up.sh` 的参数面：尾参透传与 `--print-wake-identity`（issue #38）。
 *
 * 病根是**已实现的能力用本仓库的部署脚本部署不出来**：`--trust <节点>=<公钥>` 与
 * `--wake-sign` 由常驻/控制台实现着，而起法脚本对未知参数一律 `beta_die`，自己又没有
 * 任何表达它们的方式。2026-08-24 的舰队部署因此只能在部署机上手写瘦封装绕开这里的参数
 * 解析——那份封装不在仓库里，不可重复、不可交接。
 *
 * 所以这里钉四件事：
 *
 * ① `--` 之后的参数**原样**落到底层命令行上（node 腿 → resident，host 腿 → console）；
 * ② 透传不吃掉脚本自己那份策展：`--open-policy` 等仍在，且透传参数排在最后；
 * ③ `--print-wake-identity` 是前台查询：标准输出上只有那一行公钥，且用的是控制台**自己**
 *    那个配置根——拿另一个根打出来的公钥与控制台真正用于签名的不是同一把；
 * ④ 未知参数把本脚本支持的参数集一并打出来，且密钥值形式的尾参当场被拦下。
 *
 * 做法：把两个脚本复制进一棵临时「仓库」，并在复制出来的 common.sh 末尾把
 * `beta_start_process` 换成一个只**记录底层命令行**的桩。这样断言的就是真参数解析的
 * 产物，而不是对源码做字符串匹配；同时不起任何真进程、不碰端口。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BETA_DIR = join(REPOSITORY_ROOT, 'demo/env/beta')

/**
 * 把 `beta_start_process` 换成一个只记账的桩。
 *
 * 注册中心那一步要放行，host 腿才走得到控制台：它的 `--ready <文件>` 是下游那个等待
 * 循环的唯一判据，所以桩把它写出来并返回；其余进程记完就整脚本退出——再往下是就绪
 * 探测，那要真端口，而本用例问的是命令行长什么样。
 */
const RECORDER = `
beta_start_process() {
  local name="$1"
  shift 2
  {
    printf '=== %s\\n' "$name"
    printf '%s\\n' "$@"
  } >>"$BETA_ARGV_LOG"
  local a prev='' ready=''
  for a in "$@"; do
    if [ "$prev" = '--ready' ]; then ready="$a"; fi
    prev="$a"
  done
  if [ -n "$ready" ]; then
    printf '{}\\n' >"$ready"
    return 0
  fi
  exit 0
}
`

/** 假的 occ 产物：记下 argv 与配置根，`--print-wake-identity` 时打一行身份。 */
const FAKE_OCC = `#!/usr/bin/env bun
const args = process.argv.slice(2)
const fs = require('node:fs')
fs.appendFileSync(
  process.env.FAKE_OCC_LOG,
  JSON.stringify({ args, configDir: process.env.OCC_CONFIG_DIR ?? '' }) + '\\n',
)
if (args.includes('--print-wake-identity')) {
  process.stdout.write('console=fake-public-key-0123456789\\n')
}
`

const scratches: string[] = []

interface Scratch {
  readonly repo: string
  readonly root: string
  readonly argvLog: string
  readonly occLog: string
}

/** 一棵临时「仓库」+ 一个临时内测根。 */
function scratch(): Scratch {
  const base = mkdtempSync(join(tmpdir(), 'qianmo-beta-up-args-'))
  scratches.push(base)
  const repo = join(base, 'repo')
  const beta = join(repo, 'demo/env/beta')
  mkdirSync(beta, { recursive: true })
  mkdirSync(join(repo, 'dist'), { recursive: true })
  copyFileSync(join(BETA_DIR, 'beta-up.sh'), join(beta, 'beta-up.sh'))
  chmodSync(join(beta, 'beta-up.sh'), 0o755)
  const common = readFileSync(join(BETA_DIR, 'common.sh'), 'utf8')
  writeFileSync(join(beta, 'common.sh'), common + RECORDER)
  writeFileSync(join(repo, 'dist/cli-node.js'), FAKE_OCC)
  chmodSync(join(repo, 'dist/cli-node.js'), 0o755)

  const root = join(base, 'beta-root')
  mkdirSync(join(root, 'secrets', 'peers'), { recursive: true })
  // PSK 由 H 生成后分发，脚本在本机永不生成——所以用例得先把它放好。
  writeFileSync(join(root, 'secrets', 'transport-psk'), 'psk-for-test\n')
  chmodSync(join(root, 'secrets', 'transport-psk'), 0o600)

  return {
    repo,
    root,
    argvLog: join(base, 'argv.log'),
    occLog: join(base, 'occ.log'),
  }
}

interface ShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

function runBetaUp(place: Scratch, args: readonly string[]): ShellResult {
  const child = Bun.spawnSync(
    ['/bin/bash', join(place.repo, 'demo/env/beta/beta-up.sh'), ...args],
    {
      cwd: place.repo,
      env: {
        ...process.env,
        // bun 要在 PATH 上（beta_require_occ 的解释器守卫，issue #40），git 要在 PATH 上
        // （节点腿给每个 agent 建真工作区）。
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        // macOS 自带 bash 3.2 在 UTF-8 locale 下会把 `"$pid，"` 里的全角逗号算进变量名。
        // 真实机器是 Linux + bash 5，那里没有这个问题；钉成 C 只为让两边行为一致。
        LC_ALL: 'C',
        QIANMO_BETA_ROOT: place.root,
        BETA_ARGV_LOG: place.argvLog,
        FAKE_OCC_LOG: place.occLog,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  }
}

/** 桩记下来的那几段底层命令行，按进程名分开。 */
function recorded(place: Scratch): Map<string, string[]> {
  const blocks = new Map<string, string[]>()
  if (!existsSync(place.argvLog)) return blocks
  let current: string[] | undefined
  for (const line of readFileSync(place.argvLog, 'utf8').split('\n')) {
    if (line.startsWith('=== ')) {
      current = []
      blocks.set(line.slice(4), current)
    } else if (line !== '' && current !== undefined) {
      current.push(line)
    }
  }
  return blocks
}

function writePeers(place: Scratch, lines: readonly string[]): void {
  writeFileSync(join(place.root, 'peers.conf'), `${lines.join('\n')}\n`)
  chmodSync(join(place.root, 'peers.conf'), 0o600)
}

afterEach(() => {
  for (const value of scratches.splice(0)) {
    rmSync(value, { force: true, recursive: true })
  }
})

describe('beta-up.sh forwards tail arguments to the underlying command', () => {
  test('the node leg hands --trust to resident, verbatim and last', () => {
    const place = scratch()
    const result = runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-1',
      '--agent',
      'planner',
      '--',
      '--trust',
      'console=fake-public-key-0123456789',
    ])
    const argv = recorded(place).get('beta-1')
    expect({ argv: argv !== undefined, stderr: result.stderr }).toEqual({
      argv: true,
      stderr: result.stderr,
    })
    const args = argv ?? []
    expect(args.slice(0, 3)).toEqual([
      'bun',
      join(place.repo, 'dist/cli-node.js'),
      'resident',
    ])
    // 原样落到命令行上：值里的等号不被拆开，参数也不被重排。
    expect(args).toContain('--trust')
    expect(args[args.indexOf('--trust') + 1]).toBe(
      'console=fake-public-key-0123456789',
    )
    // 透传不吃掉脚本自己那份策展（任务策略两个开关由 resident-task-policy 用例守着）。
    expect(args).toContain('--open-policy')
    expect(args).toContain('--audit-signed-tasks')
    // 追加在**最后**：逃生门的语义是「真要覆盖上面某个默认值时，最后一个赢」。
    expect(args.indexOf('--trust')).toBeGreaterThan(
      args.indexOf('--open-policy'),
    )
    expect(args[args.length - 1]).toBe('console=fake-public-key-0123456789')
  })

  test('the host leg hands --wake-sign to console, verbatim and last', () => {
    const place = scratch()
    writePeers(place, ['qianmo://beta-1/planner ws://127.0.0.1:38625'])
    const result = runBetaUp(place, ['--role', 'host', '--', '--wake-sign'])
    const blocks = recorded(place)
    const argv = blocks.get('console')
    expect({ argv: argv !== undefined, stderr: result.stderr }).toEqual({
      argv: true,
      stderr: result.stderr,
    })
    const args = argv ?? []
    expect(args.slice(0, 3)).toEqual([
      'bun',
      join(place.repo, 'dist/cli-node.js'),
      'console',
    ])
    expect(args[args.length - 1]).toBe('--wake-sign')
    // 两枚 token 仍然走文件形式——尾参是逃生门，不是把这条纪律换掉的旁路。
    expect(args).toContain('--view-token-file')
    expect(args).toContain('--admin-token-file')
    // 注册中心那一段没有被尾参污染：透传只发给这条腿的**底层命令**。
    expect(blocks.get('registry') ?? []).not.toContain('--wake-sign')
  })

  test('multiple tail arguments keep their order and their spaces', () => {
    const place = scratch()
    const result = runBetaUp(place, [
      '--role',
      'node',
      '--node',
      'beta-2',
      '--',
      '--trust',
      'console=k1',
      '--trust',
      'other=k2',
      '--label',
      'two words',
    ])
    expect(result.stderr).not.toContain('未知参数')
    const args = recorded(place).get('beta-2') ?? []
    expect(args.slice(-6)).toEqual([
      '--trust',
      'console=k1',
      '--trust',
      'other=k2',
      '--label',
      'two words',
    ])
  })

  test('a bare `--` with nothing after it changes nothing', () => {
    const bare = scratch()
    runBetaUp(bare, ['--role', 'node', '--node', 'beta-3', '--'])
    const plain = scratch()
    runBetaUp(plain, ['--role', 'node', '--node', 'beta-3'])
    const withDashes = recorded(bare).get('beta-3') ?? []
    const without = recorded(plain).get('beta-3') ?? []
    expect(withDashes.length).toBeGreaterThan(0)
    // 命令行里带着各自的临时仓库与临时内测根，所以比的是「把这两段抹掉之后完全一样」。
    const normalise =
      (place: Scratch) =>
      (value: string): string =>
        value.replace(place.repo, '<repo>').replace(place.root, '<root>')
    expect(withDashes.map(normalise(bare))).toEqual(
      without.map(normalise(plain)),
    )
  })
})

describe('beta-up.sh --print-wake-identity', () => {
  test('prints only the identity line, from the console config root', () => {
    const place = scratch()
    const result = runBetaUp(place, ['--print-wake-identity'])
    expect(result.exitCode).toBe(0)
    // 标准输出上只有那一行：它要能被 `$(...)` 直接接住喂给下一条命令的 --trust。
    expect(result.stdout).toBe('console=fake-public-key-0123456789\n')
    const calls = readFileSync(place.occLog, 'utf8')
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as { args: string[]; configDir: string })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(['console', '--print-wake-identity'])
    // 配置根必须和控制台那一份是同一个：另一个根里那把私钥是另一把，而症状只会在
    // 节点侧表现为验签失败。
    expect(calls[0]?.configDir).toBe(join(place.root, 'nodes/console/config'))
    // 它不是一次启动：没有任何进程被起过。
    expect(existsSync(place.argvLog)).toBe(false)
    expect(existsSync(join(place.root, 'run', 'console.pid'))).toBe(false)
  })

  test('carries the tail arguments into the query', () => {
    const place = scratch()
    // 身份由 --chat-from 决定。这一路与 `--role host -- --chat-from …` 必须问出同一把
    // 钥匙，否则分发出去的是一把控制台根本不用来签名的公钥，而症状只在节点侧表现为
    // 验签失败。
    const result = runBetaUp(place, [
      '--print-wake-identity',
      '--',
      '--chat-from',
      'qianmo://ops/operator',
    ])
    expect(result.exitCode).toBe(0)
    const call = JSON.parse(
      readFileSync(place.occLog, 'utf8').split('\n')[0] ?? '{}',
    ) as { args: string[] }
    expect(call.args).toEqual([
      'console',
      '--print-wake-identity',
      '--chat-from',
      'qianmo://ops/operator',
    ])
  })

  test('refuses to answer for the node leg', () => {
    const place = scratch()
    const result = runBetaUp(place, ['--print-wake-identity', '--role', 'node'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--print-wake-identity')
    expect(existsSync(place.occLog)).toBe(false)
  })
})

describe('beta-up.sh says what it accepts', () => {
  test('an unknown argument prints the whole supported set', () => {
    const place = scratch()
    const result = runBetaUp(place, ['--role', 'node', '--trust', 'a=b'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--trust')
    // 「本脚本支持的参数集」= 每一个开关都在，不是一句「用 --help 看用法」。
    for (const flag of [
      '--role host|node',
      '--node <名字>',
      '--agent <名字>',
      '--port <端口>',
      '--print-wake-identity',
      '-- <args>...',
    ]) {
      expect({ flag, shown: result.stderr.includes(flag) }).toEqual({
        flag,
        shown: true,
      })
    }
    // 顺手把出口指出来：这条路上最常见的未知参数就是该走尾参透传的那些。
    expect(result.stderr).toContain('把它放到 -- 后面透传')
  })

  test('a token value in the tail is refused before anything starts', () => {
    const place = scratch()
    writePeers(place, ['qianmo://beta-1/planner ws://127.0.0.1:38625'])
    const result = runBetaUp(place, [
      '--role',
      'host',
      '--',
      '--admin-token',
      'super-secret-value',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--admin-token-file')
    // 关键是**没有任何进程被起过**：拦在起进程之前，密钥才没有进过任何一份进程列表。
    expect(existsSync(place.argvLog)).toBe(false)
    expect(result.stdout + result.stderr).not.toContain('super-secret-value')
  })
})
