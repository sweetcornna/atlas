// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `bootstrap.sh` 的前置检查：哪几样是**构建**要的，哪几样只是**自检**要的。
 *
 * 这条区分原先没有，代价很具体。2026-08-25 实查：内测舰队四台节点机上一台都没有
 * node（只有 `~/.bun/bin/bun`），而 ① 里那句 `command -v node || demo_die` 是无条件的。
 * 于是这份「装机 runbook」在真实部署机上从第一步就跑不起来，历次上机只能绕开它手工
 * 构建——而绕开的同时也绕过了 ③ 里那段源 commit 注入（issue #70），四台节点
 * 因此报 `sourceCommit=unknown`。
 *
 * 所以这里钉四件事：
 *
 * ① 缺 node 且要跑 ④ 时，**仍然**死在 ①。放宽不等于取消：自检真的会 spawn node。
 * ② 缺 node 且显式 `--skip-selftest` 时，②③ 照跑。这是舰队那条路径。
 * ③ 缺 node **不会**让 ④ 自动跳过——静默降级会让「自检过了」和「自检压根没跑」在
 *    输出里长得一模一样，那比直接失败更难发现。
 * ④ bun 低于 omp 基座的硬下限 1.4 时死在 ①，并说出下限；高于 pin 的版本只 WARN。
 *
 * 手法：造一棵只有 `demo/env/`、qm 入口占位与 `.tool-versions` 的一次性树，PATH 上只放桩
 * `bun` / `git`（以及需要时的 `node`）。桩让用例停在「前置检查怎么判」这一层，
 * 不去真跑 `bun install`——那既慢，也会把两件事的失败混在一个断言里。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { linkSharedExecutable } from '../../atlas/tests/support/sharedExecutable.ts'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..')
const COMMON_SOURCE = join(REPOSITORY_ROOT, 'demo/env/common.sh')
const BOOTSTRAP_SOURCE = join(REPOSITORY_ROOT, 'demo/env/bootstrap.sh')
const ENTRY_SOURCE = join(REPOSITORY_ROOT, 'demo/lib/entry.sh')

/** 真 `.tool-versions` 里的 bun pin，桩要报同一个值，免得用例被那句 WARN 干扰。 */
const BUN_PIN = (await Bun.file(join(REPOSITORY_ROOT, '.tool-versions')).text())
  .split('\n')
  .map(line => line.trim().split(/\s+/))
  .find(([name]) => name === 'bun')?.[1]

const roots: string[] = []

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true })
})

/**
 * 每个可执行文件**整份文件只写一次**，用例里落的是指向它的软链（issue #102；
 * 做法与理由见 `atlas/tests/support/sharedExecutable.ts`）。
 *
 * 这份文件 6 条用例，每条 `scaffold()` 要写 4–5 个可执行文件（两个脚本 + 两三个
 * bin 桩）；各写各的，就是每条用例白付近十秒首次执行扫描。这些文件的内容**全都
 * 是固定的**（两个脚本是仓库原文，桩的 body 只有那两三种），所以按内容各写一次、
 * 当场预热，用例里只落软链。
 *
 * `bootstrap.sh` / `common.sh` 靠 `${BASH_SOURCE[0]}` 自定位，而 **bash 不解析
 * 软链** —— `BASH_SOURCE[0]` 给的是软链自己的路径，于是 `dirname` 仍落在这条
 * 用例的树里。软链因此不会把它们的 `REPO_DIR` 带偏。
 */
const WARMUP_ENV = { QIANMO_BOOTSTRAP_WARMUP: '1' }

async function place(
  root: string,
  relative: string,
  from: string,
): Promise<void> {
  const text = await Bun.file(from).text()
  linkSharedExecutable(join(root, relative), text, {
    name: relative.replaceAll('/', '_'),
    warmupEnv: WARMUP_ENV,
  })
}

function stub(binDir: string, name: string, body: string): void {
  linkSharedExecutable(join(binDir, name), `#!/bin/sh\n${body}\n`, {
    name: `stub_${name}`,
    warmupEnv: WARMUP_ENV,
  })
}

/**
 * 一次性树 + 一个只有桩的 bin 目录。
 *
 * `withNode` 是正面对照：少了它，一个「永远报缺 node」的实现也能让①②全绿。
 */
async function scaffold(
  withNode: boolean,
  bunVersion: string | undefined = BUN_PIN,
): Promise<{ root: string; bin: string }> {
  const root = mkdtempSync(join(tmpdir(), 'qianmo-bootstrap-'))
  roots.push(root)
  await place(root, 'demo/env/common.sh', COMMON_SOURCE)
  await place(root, 'demo/env/bootstrap.sh', BOOTSTRAP_SOURCE)
  // common.sh source 它（demo_entry 的实现）。缺了它 common.sh 在 source 阶段就死在
  // `set -e` 上，用例只看得到一个空输出 —— 与真正的前置检查失败无法区分。
  await place(root, 'demo/lib/entry.sh', ENTRY_SOURCE)
  // qm 入口只查「在不在」（demo_require_qm），占位即可；有了它，正常路径才能以 0 退出。
  mkdirSync(join(root, 'atlas/packages/node/src'), { recursive: true })
  writeFileSync(join(root, 'atlas/packages/node/src/cli.ts'), '// stub\n')
  writeFileSync(join(root, '.tool-versions'), `bun ${BUN_PIN}\n`)

  const bin = join(root, 'stub-bin')
  mkdirSync(bin, { recursive: true })
  // `bun --version` 要报出给定版本（缺省是 pin）；其余子命令（install / run build:native /
  // test）一律成功返回，用例关心的是「走没走到那一步」，不是那几步自己对不对。
  stub(
    bin,
    'bun',
    `[ "$1" = "--version" ] && { echo "${bunVersion}"; exit 0; }\nexit 0`,
  )
  // git 只答 --version；`rev-parse` 失败正是「这棵树不是仓库」那一支，与部署机一致。
  stub(
    bin,
    'git',
    '[ "$1" = "--version" ] && { echo "git version 2.43.0"; exit 0; }\nexit 1',
  )
  if (withNode) stub(bin, 'node', 'echo v22.0.0')
  return { root, bin }
}

interface ShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

function runBootstrap(
  root: string,
  bin: string,
  args: readonly string[],
): ShellResult {
  const child = Bun.spawnSync(
    ['/bin/bash', join(root, 'demo/env/bootstrap.sh'), ...args],
    {
      cwd: root,
      // PATH 里**只有**桩目录和系统目录：开发机上装没装 node 不该改变结论。
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  return {
    exitCode: child.exitCode ?? -1,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  }
}

describe('bootstrap.sh 的 node 前置', () => {
  test('缺 node 且要跑 ④ 自检：仍然死在 ①，并说清出路', async () => {
    const { root, bin } = await scaffold(false)

    const result = runBootstrap(root, bin, [])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('node 不在 PATH 上')
    expect(result.stderr).toContain('--skip-selftest')
    // 死在①，所以 ② 那一步的标题不该出现。
    expect(result.stdout).not.toContain('bun install')
  })

  test('缺 node 但显式 --skip-selftest：只 WARN，②③ 照跑', async () => {
    const { root, bin } = await scaffold(false)

    const result = runBootstrap(root, bin, ['--skip-selftest', '--skip-build'])
    expect(result.stdout).toContain('WARN')
    expect(result.stdout).toContain('已按 --skip-selftest 跳过')
    expect(result.stdout).toContain('② bun install --frozen-lockfile')
    // 走到了 ③，也就走到了那里的源 commit 注入 —— 这正是舰队那条路径要拿到的东西。
    expect(result.stdout).toContain('③ bun run build:native')
  })

  test('缺 node 不会让 ④ 自动跳过 —— 不给 --skip-selftest 就是失败，不是静默降级', async () => {
    const { root, bin } = await scaffold(false)

    const result = runBootstrap(root, bin, ['--skip-build'])
    expect(result.exitCode).not.toBe(0)
    // 「自检」二字根本不该出现：它连 ④ 都没走到，而不是走到了却悄悄跳过。
    expect(result.stdout).not.toContain('④ 自检')
  })

  test('有 node 时一切照旧：不 WARN、不 die，node 版本照报', async () => {
    const { root, bin } = await scaffold(true)

    const result = runBootstrap(root, bin, ['--skip-build', '--skip-selftest'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('node v22.0.0')
    expect(result.stdout).not.toContain('node 不在 PATH 上')
    expect(result.stdout).toContain('qm 入口就位')
  })
})

describe('bootstrap.sh 的 bun 版本下限', () => {
  test.each([
    ['1.3.13'],
    ['1.3.99-canary.1'],
    ['0.9.0'],
  ])('bun %s 低于 1.4：死在 ①，并说出下限', async version => {
    const { root, bin } = await scaffold(true, version)

    const result = runBootstrap(root, bin, ['--skip-build', '--skip-selftest'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(`bun ${version} 太旧`)
    expect(result.stderr).toContain('1.4.0')
    expect(result.stdout).not.toContain('bun install')
  })

  test.each([
    ['1.4.0'],
    ['1.10.0'],
    ['2.0.0'],
  ])('bun %s 不低于 1.4：放行（与 pin 不同只 WARN）', async version => {
    const { root, bin } = await scaffold(true, version)

    const result = runBootstrap(root, bin, ['--skip-build', '--skip-selftest'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('② bun install --frozen-lockfile')
    if (version !== BUN_PIN) expect(result.stdout).toContain('WARN')
  })

  test('bun --version 什么都不报：按不满足处理', async () => {
    const { root, bin } = await scaffold(true, '')

    const result = runBootstrap(root, bin, ['--skip-build', '--skip-selftest'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('太旧')
  })
})

describe('bootstrap.sh 的源 commit 注入', () => {
  test('没有 .git 也没有戳时，③ 里显式警告产物会报 unknown', async () => {
    const { root, bin } = await scaffold(true)

    const result = runBootstrap(root, bin, ['--skip-build', '--skip-selftest'])
    expect(result.stdout).toContain('sourceCommit=unknown')
    expect(result.stdout).toContain('demo/env/pack.sh')
  })

  test('有戳时，③ 里报出那个 commit', async () => {
    const { root, bin } = await scaffold(true)
    const sha = '0123456789abcdef0123456789abcdef01234567'
    writeFileSync(join(root, '.source-commit'), `${sha}\n`)

    const result = runBootstrap(root, bin, ['--skip-build', '--skip-selftest'])
    expect(result.stdout).toContain(sha)
    expect(result.stdout).not.toContain('sourceCommit=unknown')
  })
})
