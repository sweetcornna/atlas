// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 启动器维度 —— PR #48（issue #38 / #40）的验收面。
 *
 * 这一维跑的是**仓库自带的真 shell 脚本**（`/bin/bash` 里 source
 * `demo/env/beta/common.sh`，或直接 exec `beta-up.sh`），不是它们的 TypeScript
 * 替身。理由与 `scripts/test-shards.sh` 把 `demo/env` 单独列一格是同一条：
 * 这些脚本要证明的东西恰恰是「在真 bash 上会怎样」，而开发机的 macOS bash 3.2
 * 与线上的 Linux bash 5 差别就在这一层。
 *
 * `LC_ALL=C` 是必须的：`demo/env` 全树用「变量紧跟全角标点」的写法，macOS 的
 * bash 3.2 在 UTF-8 locale 下会把全角逗号算进变量名，`set -u` 当场报 unbound
 * variable（这就是 issue #49）。钉成 C 让本机行为与线上一致 —— 被测的是启动器
 * 的存活校验，不是多字节解析。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { Checks } from '../checks.js'
import { REPO_ROOT } from '../local/spawn.js'
import type { Scenario, ScenarioContext } from '../types.js'

const COMMON_SH = join(REPO_ROOT, 'demo/env/beta/common.sh')
const BETA_UP = join(REPO_ROOT, 'demo/env/beta/beta-up.sh')

interface ShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

function betaRoot(ctx: ScenarioContext): string {
  const root = join(ctx.workdir, 'beta-root')
  mkdirSync(join(root, 'run'), { recursive: true })
  mkdirSync(join(root, 'logs'), { recursive: true })
  return root
}

/** 在真 bash 里 source `common.sh` 之后跑几行。 */
function runShell(
  root: string,
  lines: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): ShellResult {
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      ['set -euo pipefail', '. "$1"', ...lines].join('\n'),
      'qianmo-acceptance',
      COMMON_SH,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        LC_ALL: 'C',
        QIANMO_BETA_ROOT: root,
        ...extraEnv,
      },
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

/**
 * 跑 `beta-up.sh`，但把它最终要执行的那条命令**截下来**。
 *
 * 手法：给一个只含假 `bun` 的 PATH，那个假 `bun` 把自己收到的 argv 与
 * `OCC_CONFIG_DIR` 追加进一个日志文件然后退出。于是不需要真起节点，就能断言
 * 「尾参有没有原样传到底层命令行上」。
 */
/**
 * 造一个**镜像仓库根**，让 `beta-up.sh` 相信 `dist/` 已经构建好了。
 *
 * 为什么需要它：`common.sh` 把产物路径写死成 `BETA_OCC="$REPO_DIR/dist/cli-node.js"`
 * 且不认任何环境变量覆盖，而 `REPO_DIR` 是从 `common.sh` 自己的 `BASH_SOURCE[0]`
 * 往上三级推出来的。于是「不先跑一次真构建就没法碰这条路径」——那正好撞上
 * 委托里「不许有手工步骤」。
 *
 * 出路是**换一个 `REPO_DIR`**：临时目录里 `demo` 软链到真仓库、`dist/cli-node.js`
 * 放一个占位文件。bash 的 `cd` 走逻辑路径，`pwd` 因此答的是软链那一侧，
 * `REPO_DIR` 就落在临时目录上 —— 跑的**仍是仓库里那份真脚本**，只有它眼中的
 * 仓库根被换掉了。
 *
 * 唯一被伪造的是「产物存在」这一个事实；`beta_require_occ` 之后的每一步（参数
 * 解析、尾参透传、启动、探活）都照原样走。
 */
function mirrorRepo(ctx: ScenarioContext): string {
  const mirror = join(ctx.workdir, 'repo-mirror')
  mkdirSync(join(mirror, 'dist'), { recursive: true })
  writeFileSync(
    join(mirror, 'dist', 'cli-node.js'),
    '// qianmo acceptance placeholder —— 只为让 beta_require_occ 通过\n',
  )
  symlinkSync(join(REPO_ROOT, 'demo'), join(mirror, 'demo'))
  return join(mirror, 'demo/env/beta/beta-up.sh')
}

/**
 * 一个假 `bun`：把自己被怎么调起来的记下来。
 *
 * `linger` 决定它记完之后是否挂住。**默认挂住**，因为 `beta_start_process`
 * 的成功判据正是「宽限期之后进程还活着」—— 记完就退等于让每条启动场景都撞上
 * 那道存活校验（PR #48 加的那道），观察点会前移到「起不来」而不是「怎么起的」。
 */
function stubBunDir(
  ctx: ScenarioContext,
  argvLog: string,
  options: { readonly linger?: boolean } = {},
): string {
  const bin = join(ctx.workdir, 'stub-bin')
  mkdirSync(bin, { recursive: true })
  // `--ready <路径>`：注册中心用一个 ready 文件宣告自己起来了，而 beta-up.sh
  // 会卡在那儿等 30 s 再 die。假 bun 替它写一下，控制台那一步才够得着。
  const script = `#!/bin/bash
printf '%s\\n' "OCC_CONFIG_DIR=\${OCC_CONFIG_DIR:-}" >>"${argvLog}"
printf '%s\\n' "ARGV: $*" >>"${argvLog}"
prev=''
for arg in "$@"; do
  if [ "$prev" = '--ready' ]; then printf '{"stub":true}\\n' >"$arg"; fi
  prev="$arg"
done
${options.linger === false ? 'exit 0' : 'sleep 30'}
`
  const path = join(bin, 'bun')
  writeFileSync(path, script, { mode: 0o755 })
  return bin
}

/** 场景结束时按 pid 文件把假进程收干净，别把 `sleep` 留在机器上。 */
function killStubsOnCleanup(ctx: ScenarioContext, root: string): void {
  ctx.cleanup(() => {
    const runDir = join(root, 'run')
    if (!existsSync(runDir)) return
    for (const name of readdirSync(runDir)) {
      if (!name.endsWith('.pid')) continue
      const pid = Number(readFileSync(join(runDir, name), 'utf8').trim())
      if (!Number.isFinite(pid) || pid <= 0) continue
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 早就没了。
      }
    }
  })
}

export const launcherScenarios: readonly Scenario[] = [
  {
    id: 'launcher/start-process-missing-command',
    dimension: 'launcher',
    title: 'beta_start_process：命令不可执行时报失败，且不留 pid 文件',
    expected:
      '退出码非零、stderr 含「起不来」与 .bun/bin 提示、run/<名>.pid 不存在',
    requires: ['run-launcher'],
    timeoutMs: 60_000,
    async run(ctx) {
      const root = betaRoot(ctx)
      const result = runShell(root, [
        'beta_start_process demo "$QIANMO_BETA_ROOT/config" definitely-not-a-real-binary',
      ])
      const pidFile = join(root, 'run', 'demo.pid')
      return new Checks()
        .note('stdout', result.stdout)
        .note('stderr', result.stderr)
        .expect(result.exitCode !== 0, '退出码非零', result.exitCode)
        .contains(result.stderr, '起不来', 'stderr')
        .contains(result.stderr, '.bun/bin', 'stderr（要指出最常见的那个成因）')
        .notContains(result.stdout, '已启动', 'stdout（不许报成功）')
        .expect(!existsSync(pidFile), 'pid 文件没有被写出来', pidFile)
        .done('起不来时不谎报成功')
    },
  },

  {
    id: 'launcher/start-process-dies-immediately',
    dimension: 'launcher',
    title: 'beta_start_process：命令存在但立刻退出时也报失败，并摊开 stderr',
    expected:
      '退出码非零、stdout 含「未能保持运行」之外的日志尾巴、pid 文件被清掉',
    requires: ['run-launcher'],
    timeoutMs: 60_000,
    async run(ctx) {
      const root = betaRoot(ctx)
      const result = runShell(root, [
        'beta_start_process demo "$QIANMO_BETA_ROOT/config" /bin/bash -c "echo boom >&2; exit 3"',
      ])
      const pidFile = join(root, 'run', 'demo.pid')
      const output = `${result.stdout}\n${result.stderr}`
      return new Checks()
        .note('stdout', result.stdout)
        .note('stderr', result.stderr)
        .expect(result.exitCode !== 0, '退出码非零', result.exitCode)
        .contains(output, '未能保持运行', '输出')
        .contains(output, 'boom', '输出（子进程的 stderr 要被摊开）')
        .expect(!existsSync(pidFile), '陈旧 pid 文件被清掉', pidFile)
        .done('起了就死也算失败')
    },
  },

  {
    id: 'launcher/start-process-happy-path',
    dimension: 'launcher',
    title: 'beta_start_process：进程真活着时照旧报成功（正向对照）',
    expected: '退出码 0、stdout 含「已启动」、pid 文件存在',
    requires: ['run-launcher'],
    timeoutMs: 60_000,
    async run(ctx) {
      const root = betaRoot(ctx)
      const result = runShell(root, [
        'beta_start_process demo "$QIANMO_BETA_ROOT/config" /bin/sleep 30',
        'cat "$(beta_pidfile demo)"',
      ])
      const pidFile = join(root, 'run', 'demo.pid')
      ctx.cleanup(() => {
        // 别把 sleep 留在机器上。
        try {
          const pid = Number(
            Bun.spawnSync(['cat', pidFile]).stdout.toString().trim(),
          )
          if (Number.isFinite(pid) && pid > 0) process.kill(pid, 'SIGKILL')
        } catch {
          // 已经没了。
        }
      })
      return new Checks()
        .note('stdout', result.stdout)
        .note('stderr', result.stderr)
        .eq(result.exitCode, 0, '退出码')
        .contains(result.stdout, '已启动', 'stdout')
        .expect(existsSync(pidFile), 'pid 文件存在', pidFile)
        .done('正向对照成立')
    },
  },

  {
    id: 'launcher/beta-up-passthrough-trust',
    dimension: 'launcher',
    title: 'beta-up.sh 尾参能表达 --trust（节点腿）',
    expected: '`-- --trust <节点>=<公钥>` 原样出现在 resident 的命令行末尾',
    requires: ['run-launcher'],
    timeoutMs: 90_000,
    async run(ctx) {
      const root = betaRoot(ctx)
      const argvLog = join(ctx.workdir, 'argv-node.log')
      const bin = stubBunDir(ctx, argvLog)
      const betaUp = mirrorRepo(ctx)
      killStubsOnCleanup(ctx, root)

      const child = Bun.spawnSync(
        [
          '/bin/bash',
          betaUp,
          '--role',
          'node',
          '--node',
          'beta-acc',
          '--',
          '--trust',
          'console=fake-public-key-0123456789',
        ],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            PATH: `${bin}:/usr/bin:/bin`,
            LC_ALL: 'C',
            QIANMO_BETA_ROOT: root,
            QIANMO_BETA_START_GRACE_S: '0',
            QIANMO_TRANSPORT_PSK: 'qianmo-acceptance-psk-0000000000',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const log = existsSync(argvLog)
        ? Bun.spawnSync(['cat', argvLog]).stdout.toString()
        : ''
      return (
        new Checks()
          .note('beta-up stdout', child.stdout.toString().slice(0, 3_000))
          .note('beta-up stderr', child.stderr.toString().slice(0, 3_000))
          .note('截获的命令行', log === '' ? '(没有截到)' : log)
          .expect(log !== '', '截到了 resident 的命令行', log)
          // 尾参必须落在**末尾**：它是 `--` 之后原样附加的，夹在中间说明被
          // 重排过，而重排会让 `--agent name=cwd` 这类成对参数错位。
          .expect(
            log
              .trimEnd()
              .endsWith('--trust console=fake-public-key-0123456789'),
            '尾参原样落在命令行末尾',
            log,
          )
          .contains(log, '--trust', '截获的命令行')
          .contains(log, 'console=fake-public-key-0123456789', '截获的命令行')
          .done('节点腿尾参透传可用')
      )
    },
  },

  {
    id: 'launcher/beta-up-passthrough-wake-sign',
    dimension: 'launcher',
    title: 'beta-up.sh 尾参能表达 --wake-sign（控制台腿）',
    expected: '`-- --wake-sign` 原样出现在 console 的命令行末尾',
    requires: ['run-launcher'],
    timeoutMs: 90_000,
    async run(ctx) {
      const root = betaRoot(ctx)
      const argvLog = join(ctx.workdir, 'argv-host.log')
      const bin = stubBunDir(ctx, argvLog)
      const betaUp = mirrorRepo(ctx)
      killStubsOnCleanup(ctx, root)
      // 控制台腿要求地址表里至少有一条 —— 那是脚本的前置（运维单页第一步），
      // 不是本场景要断言的东西，所以在这里补齐而不是让它 die 在前面。
      writeFileSync(
        join(root, 'peers.conf'),
        'qianmo://beta-acc/planner ws://127.0.0.1:38625\n',
        { mode: 0o600 },
      )

      const child = Bun.spawnSync(
        ['/bin/bash', betaUp, '--role', 'host', '--', '--wake-sign'],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            PATH: `${bin}:/usr/bin:/bin`,
            LC_ALL: 'C',
            QIANMO_BETA_ROOT: root,
            QIANMO_BETA_START_GRACE_S: '0',
            QIANMO_TRANSPORT_PSK: 'qianmo-acceptance-psk-0000000000',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const log = existsSync(argvLog)
        ? Bun.spawnSync(['cat', argvLog]).stdout.toString()
        : ''
      const consoleLine =
        log.split('\n').find(line => line.includes(' console ')) ?? ''
      return new Checks()
        .note('beta-up stdout', child.stdout.toString().slice(0, 3_000))
        .note('beta-up stderr', child.stderr.toString().slice(0, 3_000))
        .note('截获的命令行', log === '' ? '(没有截到)' : log)
        .expect(log !== '', '截到了命令行', log)
        .expect(consoleLine !== '', '其中有 console 那条', log)
        .contains(consoleLine, '--wake-sign', 'console 的命令行')
        .expect(
          consoleLine.trimEnd().endsWith('--wake-sign'),
          '尾参原样落在命令行末尾',
          consoleLine,
        )
        .done('控制台腿尾参透传可用')
    },
  },

  {
    id: 'launcher/print-wake-identity-starts-nothing',
    dimension: 'launcher',
    title: 'beta-up.sh --print-wake-identity 走专用路径，不起后台进程',
    expected: 'stdout 只有那一行身份，run/console.pid 不存在',
    requires: ['run-launcher'],
    timeoutMs: 90_000,
    async run(ctx) {
      const root = betaRoot(ctx)
      const argvLog = join(ctx.workdir, 'argv-identity.log')
      // 这条的 stub 不能 `sleep`：`--print-wake-identity` 是**同步**取一行，
      // 挂住会让整条场景耗到超时，而超时记的是 `error` 而不是它要证明的事。
      const bin = stubBunDir(ctx, argvLog, { linger: false })
      const betaUp = mirrorRepo(ctx)
      killStubsOnCleanup(ctx, root)

      const child = Bun.spawnSync(
        ['/bin/bash', betaUp, '--print-wake-identity'],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            PATH: `${bin}:/usr/bin:/bin`,
            LC_ALL: 'C',
            QIANMO_BETA_ROOT: root,
            QIANMO_TRANSPORT_PSK: 'qianmo-acceptance-psk-0000000000',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const stdout = child.stdout.toString()
      const stderr = child.stderr.toString()
      const pidFile = join(root, 'run', 'console.pid')
      const log = existsSync(argvLog)
        ? Bun.spawnSync(['cat', argvLog]).stdout.toString()
        : ''
      return new Checks()
        .note('stdout', stdout)
        .note('stderr', stderr.slice(0, 3_000))
        .note('截获的命令行', log === '' ? '(没有截到)' : log)
        .expect(log !== '', '截到了命令行', log)
        .contains(log, '--print-wake-identity', '截获的命令行')
        .expect(
          !existsSync(pidFile),
          'run/console.pid 不存在（这条路径不起后台进程）',
          pidFile,
        )
        .notContains(stdout, '已启动', 'stdout（不该走 beta_start_process）')
        .done('查身份不是一次启动')
    },
  },

  {
    id: 'launcher/beta-up-refuses-token-in-passthrough',
    dimension: 'launcher',
    title: 'beta-up.sh 拒绝把 token 放进尾参（命令行会进进程列表）',
    expected: '退出码非零，stderr 说明为什么不能这么传',
    requires: ['run-launcher'],
    timeoutMs: 60_000,
    async run(ctx) {
      const root = betaRoot(ctx)
      const child = Bun.spawnSync(
        [
          '/bin/bash',
          BETA_UP,
          '--role',
          'host',
          '--',
          '--admin-token',
          'this-should-be-refused',
        ],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            PATH: '/usr/bin:/bin',
            LC_ALL: 'C',
            QIANMO_BETA_ROOT: root,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const stderr = child.stderr.toString()
      return new Checks()
        .note('stderr', stderr)
        .expect(child.exitCode !== 0, '退出码非零', child.exitCode)
        .contains(stderr, '--admin-token', 'stderr')
        .contains(stderr, '进程列表', 'stderr（要说清为什么）')
        .done('尾参不许夹带 token')
    },
  },
]
