// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `bootstrap.sh` 的前置检查：哪几样是**构建**要的，哪几样只是**自检**要的。
 *
 * 这条区分原先没有，代价很具体。2026-08-25 实查：内测舰队四台节点机上一台都没有
 * node（只有 `~/.bun/bin/bun`），而 ① 里那句 `command -v node || demo_die` 是无条件的。
 * 于是这份「装机 runbook」在真实部署机上从第一步就跑不起来，历次上机只能绕开它手工
 * `bun run build`——而绕开的同时也绕过了 ③ 里那段源 commit 注入（issue #70），四台节点
 * 的产物因此报 `sourceCommit=unknown`。
 *
 * 所以这里钉三件事：
 *
 * ① 缺 node 且要跑 ④ 时，**仍然**死在 ①。放宽不等于取消：自检真的会 spawn node。
 * ② 缺 node 且显式 `--skip-selftest` 时，②③ 照跑。这是舰队那条路径。
 * ③ 缺 node **不会**让 ④ 自动跳过——静默降级会让「自检过了」和「自检压根没跑」在
 *    输出里长得一模一样，那比直接失败更难发现。
 *
 * 手法：造一棵只有 `demo/env/` 与 `.tool-versions` 的一次性树，PATH 上只放桩
 * `bun` / `git`（以及需要时的 `node`）。桩让用例停在「前置检查怎么判」这一层，
 * 不去真跑 `bun install`——那既慢，也会把两件事的失败混在一个断言里。
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..')
const COMMON_SOURCE = join(REPOSITORY_ROOT, 'demo/env/common.sh')
const BOOTSTRAP_SOURCE = join(REPOSITORY_ROOT, 'demo/env/bootstrap.sh')

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

async function place(
  root: string,
  relative: string,
  from: string,
): Promise<void> {
  const text = await Bun.file(from).text()
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text, { mode: 0o755 })
}

function stub(binDir: string, name: string, body: string): void {
  writeFileSync(join(binDir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

/**
 * 三个桩**整个文件只写一次，并在这里就先各跑一次**。
 *
 * 与 `beta/beta-up-args.test.ts` 顶部同一条结论（issue #56 / #102）：macOS 对**新写出
 * 来的可执行文件的第一次 exec** 要走一遍策略扫描（Gatekeeper/`syspolicyd`），同一个
 * inode 第二次起就只剩约 2 ms。空载实测这台机上的悬崖是 **470 ms vs 2.6 ms**，约 180
 * 倍；而它**没有上界**——机器一忙就涨，同期在 `demo/lib/acceptance/` 上量到的新 inode
 * 首执行是 **1.8–2.5 秒**（同一 inode 再执行仍是 ~5 ms）。
 *
 * 原先每条用例各写一份桩，于是 `scaffold(false)` 的用例白付 2 次扫描、
 * `scaffold(true)` 的付 3 次。本机空载实测正好对上：前者 1.34 s、后者 1.90 s。单条用例
 * 的预算是 **5 000 ms**（`bunfig.toml` 里那个 `[test] timeout = 10000`
 * Bun 1.3.13 根本不读），所以按「忙时 2 秒一次」算，三次扫描就已经过线。完整 `verify`
 * 跑到第 61 个分片时机器早被前面的分片喂热，正是那个价位——issue #102 里这个文件三条
 * 同时红，全部卡在 5002 ms。
 *
 * 三个桩都**没有任何每用例状态**：`bun` 与 `git` 只按 `$1` 答一个常量串，`node` 只
 * `echo` 一个常量，都不写文件、不读环境。所以共享 inode 不会让用例之间互相看见。**新增
 * 任何需要被直接 exec 的桩，都要挂在这里，不要放进 `scaffold()`。**真要记每用例的账，
 * 走 `beta-up-args.test.ts` 那条路：桩本身仍然只有一份，把落点用环境变量
 * （那边是 `FAKE_SYSTEMCTL_LOG`）指到本条用例自己的临时目录里。
 *
 * `node` 单独占一个目录，而不是「有 node 的用例多写一份桩」：`withNode` 于是变成
 * 「PATH 上要不要多前置一个目录」，两档共用同一对 bun/git inode，全文件一共只付 3 次
 * 扫描。
 */
const STUB_HOME = mkdtempSync(join(tmpdir(), 'qianmo-bootstrap-bin-'))
const STUB_BIN = join(STUB_HOME, 'bin')
const NODE_BIN = join(STUB_HOME, 'bin-node')
mkdirSync(STUB_BIN, { recursive: true })
mkdirSync(NODE_BIN, { recursive: true })
// `bun --version` 要报出 pin；其余子命令（install / run build / test）一律成功返回，
// 用例关心的是「走没走到那一步」，不是那几步自己对不对。
stub(
  STUB_BIN,
  'bun',
  `[ "$1" = "--version" ] && { echo "${BUN_PIN}"; exit 0; }\nexit 0`,
)
// git 只答 --version；`rev-parse` 失败正是「这棵树不是仓库」那一支，与部署机一致。
stub(
  STUB_BIN,
  'git',
  '[ "$1" = "--version" ] && { echo "git version 2.43.0"; exit 0; }\nexit 1',
)
stub(NODE_BIN, 'node', 'echo v22.0.0')
// 首执行扫描在**模块作用域**付掉：这里没有任何用例的超时计时器在跑。放进 `beforeAll`
// 是不够的——那时钟已经在走了。少了这三行，文件里前三条要 exec 桩的用例仍然要各自扛
// 一条没有上界的尾巴。
for (const path of [
  join(STUB_BIN, 'bun'),
  join(STUB_BIN, 'git'),
  join(NODE_BIN, 'node'),
]) {
  Bun.spawnSync([path, '--version'], { stdout: 'ignore', stderr: 'ignore' })
}

afterAll(() => {
  rmSync(STUB_HOME, { recursive: true, force: true })
})

/**
 * 一次性树 + 该用例要用的 PATH 前缀。
 *
 * `withNode` 是正面对照：少了它，一个「永远报缺 node」的实现也能让①②全绿。
 */
async function scaffold(
  withNode: boolean,
): Promise<{ root: string; bin: string }> {
  const root = mkdtempSync(join(tmpdir(), 'qianmo-bootstrap-'))
  roots.push(root)
  await place(root, 'demo/env/common.sh', COMMON_SOURCE)
  await place(root, 'demo/env/bootstrap.sh', BOOTSTRAP_SOURCE)
  writeFileSync(join(root, '.tool-versions'), `bun ${BUN_PIN}\n`)

  return { root, bin: withNode ? `${NODE_BIN}:${STUB_BIN}` : STUB_BIN }
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
      // `bin` 可能是两个目录（有 node 那一档），所以它本身就是一段 PATH 片段。
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
    expect(result.stdout).toContain('③ bun run build')
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
    expect(result.stdout).toContain('node v22.0.0')
    expect(result.stdout).not.toContain('node 不在 PATH 上')
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
