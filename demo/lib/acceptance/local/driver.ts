// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 本地驱动 —— 在本机起真的 `qm resident` / `qm console` 进程，用真的传输层
 * 拨过去，读真的审计链与 transcript。
 *
 * 三条与既有 demo harness 一致的纪律（照抄理由，不是照抄代码）：
 *
 * ① **一个进程一个 `OCC_CONFIG_DIR`。** 审计链是「一个配置根一个文件」，两个
 *    常驻共用一个根 = 两条哈希链交织进同一个文件，`qm audit --verify` 会报
 *    `chain: broken` —— 一个拓扑错误看起来会像一次篡改。
 *
 * ② **就绪判据是「拨得通」，不是「进程还活着」。** 进程活着但端口没绑上的
 *    窗口真实存在，按 pid 判就绪会让后面每一条断言都在赌运气。
 *
 * ③ **端口显式分配、不用 `--port 0`。** 常驻的启动 banner **不含端口**，
 *    `onReady` 只有进程内调用方拿得到。所以外部驱动只能自己先占一个空闲口
 *    再让出来。注意 Bun 允许两个服务器绑同一个 TCP 口且都不报错，所以分配
 *    之后要靠 ② 的拨号验证真的是自己那个进程在应答。
 */

import { mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AcceptanceDriver,
  DialOptions,
  DialProbe,
  DriverCapability,
  ExecResult,
  NodeHandle,
  NodeSpec,
  ScenarioContext,
} from '../types.js'
import { rawDial, type RawAuth } from './dial.js'
import {
  runCli,
  sleep,
  spawnCli,
  waitFor,
  type SpawnedProcess,
} from './spawn.js'

/** 验收专用 PSK。长度过 `PSK_MIN_LENGTH`（16），内容无秘密可言。 */
export const ACCEPTANCE_PSK = 'qianmo-acceptance-psk-0000000000'
/** 与上面不同的一把，用来测「错 PSK」。 */
export const WRONG_PSK = 'qianmo-acceptance-psk-9999999999'

/** 时间线文件在配置根里的相对路径 —— 两个驱动共用这一个名字。 */
export const TIMINGS_FILE = 'acceptance-timings.jsonl'

const LOCAL_CAPABILITIES: ReadonlySet<DriverCapability> = new Set([
  'spawn-node',
  'restart-node',
  'mutate-node-env',
  'read-node-files',
  'exec-node-cli',
  'raw-dial',
  'run-launcher',
  'stub-upstream',
  'read-repo-source',
])

/** 本地节点句柄：比通用接口多一些只有本地拿得到的东西。 */
export interface LocalNodeHandle extends NodeHandle {
  readonly port: number
  readonly root: string
  /** 时间线文件（`--timings`），场景靠它等 turn 结束。 */
  readonly timingsPath: string
  readonly process: SpawnedProcess
  /** 按同样的参数重启（配置根不变 —— 那是身份与审计链的锚）。 */
  restart(overrides?: Partial<NodeSpec>): Promise<LocalNodeHandle>
}

export class LocalDriver implements AcceptanceDriver {
  readonly target = 'local' as const
  readonly capabilities = LOCAL_CAPABILITIES

  async startNode(
    ctx: ScenarioContext,
    spec: NodeSpec,
  ): Promise<LocalNodeHandle> {
    const root = join(ctx.workdir, `node-${spec.name}`)
    mkdirSync(join(root, 'config'), { recursive: true })
    mkdirSync(join(root, 'state'), { recursive: true })
    for (const cwd of Object.values(spec.agents)) {
      mkdirSync(cwd, { recursive: true })
    }
    return await this.#launch(ctx, spec, root)
  }

  async #launch(
    ctx: ScenarioContext,
    spec: NodeSpec,
    root: string,
  ): Promise<LocalNodeHandle> {
    const port = await ctx.allocPort()
    const configRoot = join(root, 'config')
    // 时间线放**配置根里面**（而不是旁边的 state/）：驱动接口只暴露
    // `readNodeFile(node, relPath)`，真机腿也只能读到配置根下的东西。放在外面
    // 就成了本地专有的观测面，场景一用它就再也搬不到真机上了。
    const timingsPath = join(configRoot, TIMINGS_FILE)

    const argv = [
      'resident',
      '--node',
      spec.name,
      '--team',
      'acceptance',
      '--port',
      String(port),
      '--hostname',
      '127.0.0.1',
      '--timings',
      timingsPath,
    ]
    for (const [agent, cwd] of Object.entries(spec.agents)) {
      argv.push('--agent', `${agent}=${cwd}`)
    }
    if (spec.omitPolicyFlag !== true) {
      argv.push(
        spec.policy === 'open' ? '--open-policy' : '--require-signed-tasks',
      )
    }
    for (const trust of spec.trust ?? []) argv.push('--trust', trust)
    if (spec.auth.mode !== 'psk') argv.push('--sign-handshake')
    if (spec.auth.mode === 'credential_signature') {
      argv.push('--require-signed-handshake')
    }
    argv.push(...(spec.extraArgs ?? []))

    const psk = spec.auth.mode === 'psk' ? spec.auth.psk : ACCEPTANCE_PSK
    const proc = spawnCli({
      argv,
      env: {
        OCC_IDENTITY: 'qianmo',
        OCC_CONFIG_DIR: configRoot,
        QIANMO_TRANSPORT_PSK: psk,
        ...spec.env,
      },
    })
    ctx.cleanup(() => proc.stop())

    const endpoint = `ws://127.0.0.1:${port}`
    // 就绪判据：banner 落地 **且** 真拨得通（见文件头 ②）。
    await waitFor(() => proc.stdout().includes('"publicKey"'), {
      timeoutMs: 30_000,
      what: `节点 ${spec.name} 的启动 banner`,
      diagnose: () => `stdout:\n${proc.stdout()}\nstderr:\n${proc.stderr()}`,
      signal: ctx.signal,
    })
    await waitFor(
      async () => {
        const probe = await rawDial({
          url: endpoint,
          node: 'readiness-probe',
          auth: { kind: 'psk', psk },
          settleMs: 50,
          timeoutMs: 3_000,
        })
        return probe.authed
      },
      {
        timeoutMs: 30_000,
        stepMs: 200,
        what: `节点 ${spec.name} 接受握手`,
        diagnose: () => `stderr:\n${proc.stderr()}`,
        signal: ctx.signal,
      },
    )

    const handle: LocalNodeHandle = {
      name: spec.name,
      spec,
      endpoint,
      port,
      root,
      configRoot,
      timingsPath,
      process: proc,
      stderr: async () => proc.stderr(),
      stdout: async () => proc.stdout(),
      alive: async () => proc.alive(),
      restart: async overrides => {
        await proc.stop()
        // 端口要真的放开，否则新进程会静默绑到同一个口上（Bun 不报错）。
        await sleep(300)
        return await this.#launch(ctx, { ...spec, ...overrides }, root)
      },
    }
    return handle
  }

  async stopNode(node: NodeHandle): Promise<void> {
    await (node as LocalNodeHandle).process.stop()
  }

  async restartNode(
    ctx: ScenarioContext,
    node: NodeHandle,
    overrides?: Partial<NodeSpec>,
  ): Promise<NodeHandle> {
    return await (node as LocalNodeHandle).restart(overrides)
  }

  /** 本地专有：SIGKILL，用来制造「上一条命是被打断的」那种现场。 */
  async killNode(node: NodeHandle): Promise<void> {
    const local = node as LocalNodeHandle
    process.kill(local.process.pid, 'SIGKILL')
    await sleep(500)
  }

  async dial(
    _ctx: ScenarioContext,
    node: NodeHandle,
    opts: DialOptions,
  ): Promise<DialProbe> {
    return await rawDial({
      url: node.endpoint,
      node: dialerNameOf(opts),
      auth: toRawAuth(opts),
      sendBeforeAuth: opts.sendBeforeAuth,
      sendAfterReady: opts.send,
      timeoutMs: opts.timeoutMs,
    })
  }

  async readNodeFile(
    node: NodeHandle,
    relPath: string,
  ): Promise<string | undefined> {
    try {
      return readFileSync(join(node.configRoot, relPath), 'utf8')
    } catch {
      return undefined
    }
  }

  async listNodeDir(
    node: NodeHandle,
    relPath: string,
  ): Promise<string[] | undefined> {
    try {
      return readdirSync(join(node.configRoot, relPath))
    } catch {
      return undefined
    }
  }

  async execNode(
    node: NodeHandle,
    argv: readonly string[],
  ): Promise<ExecResult> {
    return await runCli({
      argv,
      env: {
        OCC_IDENTITY: 'qianmo',
        OCC_CONFIG_DIR: node.configRoot,
        QIANMO_TRANSPORT_PSK: ACCEPTANCE_PSK,
      },
    })
  }
}

function dialerNameOf(opts: DialOptions): string {
  return opts.auth.mode === 'psk' || opts.auth.mode === 'none'
    ? 'probe-node'
    : opts.auth.nodeName
}

function toRawAuth(opts: DialOptions): RawAuth {
  if (opts.auth.mode === 'none') return { kind: 'none' }
  if (opts.auth.mode === 'psk') {
    return { kind: 'psk', psk: opts.auth.psk }
  }
  throw new Error(
    'LocalDriver.dial 只处理 psk / none；签名类拨号请直接用 rawDial（它能拼非法组合）',
  )
}
