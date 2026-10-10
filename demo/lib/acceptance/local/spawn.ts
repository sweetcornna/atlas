// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 本地驱动 —— 从**源码**起一个真的 `qm` 进程。
 *
 * 为什么不跑编译产物 `dist/qm-<target>`（舰队腿的做法）：那要求先跑一次
 * `bun atlas/scripts/build-qm.ts`。验收套件的硬要求是「不许有手工步骤」，而一条
 * 「请先构建」就是手工步骤；把构建塞进套件又要在每次跑之前付几分钟。
 *
 * 源码模式就是 `@qianmo/node` 的 `bin`：Bun 直接执行
 * `atlas/packages/node/src/cli.ts`，不需要任何转译期 defines。解释器取
 * `process.execPath`（跑这套件的那个 Bun），不靠 PATH 上碰巧是哪一个。
 *
 * 子进程 stdout 的 banner 与 stderr 的告警都是断言对象，所以全 pipe。
 */

import { join } from 'node:path'

/** 仓库根：本文件在 `<root>/demo/lib/acceptance/local/`。 */
export const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')

/** `qm` 的源码入口（`@qianmo/node` 的 `bin.qm`）。 */
export const QM_ENTRY = join(REPO_ROOT, 'atlas/packages/node/src/cli.ts')

/** Source invocation shared by acceptance subprocess fixtures. */
export function cliPrefix(): string[] {
  return [process.execPath, QM_ENTRY]
}

export interface SpawnedProcess {
  readonly pid: number
  stdout(): string
  stderr(): string
  alive(): boolean
  /** 先 TERM，宽限后 KILL。幂等。 */
  stop(graceMs?: number): Promise<void>
  /** 进程退出码（还活着时是 undefined）。 */
  exitCode(): number | undefined
}

export interface SpawnOptions {
  readonly argv: readonly string[]
  /** 必须带 `QIANMO_CONFIG_DIR`：每个 `qm` 进程一个一次性配置根。 */
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
}

/**
 * 起一个 `qm` 子进程（`[<bun>, atlas/packages/node/src/cli.ts, …argv]`）并把
 * 两条流实时抽干。
 *
 * **必须实时抽干**，不能等进程结束再 `new Response(p.stdout).text()`：常驻
 * 节点是长跑进程，等它结束就是等到超时；而管道写满之后子进程会阻塞在
 * `write` 上，表现为「节点起来了但什么都不干」。
 *
 * 缺 `QIANMO_CONFIG_DIR` 直接抛：漏掉它的子进程会落回用户真实的 `~/.qianmo`。
 */
export function spawnCli(options: SpawnOptions): SpawnedProcess {
  if (!options.env.QIANMO_CONFIG_DIR) {
    throw new Error(
      `spawnCli: QIANMO_CONFIG_DIR is required (qm ${options.argv.join(' ')})`,
    )
  }
  const proc = Bun.spawn([process.execPath, QM_ENTRY, ...options.argv], {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let out = ''
  let err = ''
  void drain(proc.stdout, chunk => {
    out += chunk
  })
  void drain(proc.stderr, chunk => {
    err += chunk
  })

  let stopped = false
  return {
    pid: proc.pid,
    stdout: () => out,
    stderr: () => err,
    alive: () => proc.exitCode === null && proc.signalCode === null,
    exitCode: () => proc.exitCode ?? undefined,
    stop: async (graceMs = 3_000) => {
      if (stopped) return
      stopped = true
      if (proc.exitCode !== null || proc.signalCode !== null) return
      proc.kill('SIGTERM')
      const died = await Promise.race([
        proc.exited.then(() => true),
        new Promise<boolean>(resolve =>
          setTimeout(() => resolve(false), graceMs),
        ),
      ])
      if (!died) {
        proc.kill('SIGKILL')
        await proc.exited
      }
    },
  }
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) onChunk(decoder.decode(value, { stream: true }))
    }
  } catch {
    // 进程被 kill 时流会以异常收场，那不是观察结果，吞掉即可。
  }
}

/** 跑一条**会结束**的 `qm` 子命令，收集全部输出。 */
export async function runCli(
  options: SpawnOptions & { readonly timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = spawnCli(options)
  const timeoutMs = options.timeoutMs ?? 30_000
  const finished = await Promise.race([
    (async () => {
      while (proc.alive()) await sleep(20)
      return true
    })(),
    new Promise<boolean>(resolve =>
      setTimeout(() => resolve(false), timeoutMs),
    ),
  ])
  if (!finished) {
    await proc.stop()
    return {
      code: -1,
      stdout: proc.stdout(),
      stderr: `${proc.stderr()}\n[acceptance] 子命令超时 ${timeoutMs}ms`,
    }
  }
  // 退出之后再让抽流循环跑一拍，否则最后一段输出可能还没进缓冲区。
  await sleep(30)
  return {
    code: proc.exitCode() ?? -1,
    stdout: proc.stdout(),
    stderr: proc.stderr(),
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 轮询等一个条件成立。
 *
 * 超时抛，且**把最后一次观察到的现场带在异常里** —— 「等 X 超时」这条消息
 * 本身没有排查价值，有价值的是超时那一刻 stderr 里是什么。
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: {
    readonly timeoutMs: number
    readonly stepMs?: number
    readonly what: string
    readonly diagnose?: () => string
    readonly signal?: AbortSignal
  },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  const step = options.stepMs ?? 50
  for (;;) {
    if (await predicate()) return
    if (options.signal?.aborted === true) {
      throw new Error(
        `等待 ${options.what} 时被中止；现场:\n${options.diagnose?.() ?? ''}`,
      )
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `等待 ${options.what} 超时（${options.timeoutMs}ms）；现场:\n${options.diagnose?.() ?? '(无)'}`,
      )
    }
    await sleep(step)
  }
}
