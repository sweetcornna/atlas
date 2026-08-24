// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 真机舰队驱动 —— 四节点 + 控制台，走真实链路。
 *
 * ## 状态：**已写好，尚未在真机上执行过一次。**
 *
 * 这不是谦辞，是这份文件唯一重要的元数据。委托里明确要求「先写出来但不要
 * 执行」，所以下面每一条 SSH 命令的**形状**都对着 `demo/env/beta/` 的既有脚本
 * 抄，但没有任何一条被真机验证过。第一次真跑必须当作一次调试，不是一次验收 ——
 * 那一轮的红大概率是这个文件的问题，不是被测系统的问题。
 *
 * ## 与本地驱动的**能力差**，以及为什么
 *
 * 真机腿**没有**这四种能力，于是需要它们的场景会如实记 `skip`：
 *
 * | 能力 | 为什么没有 |
 * | --- | --- |
 * | `spawn-node` | 舰队节点是长期部署的常驻，验收不该按任意参数另起一个；重起会打断内测使用者，也会污染那条节点的审计链 |
 * | `mutate-node-env` | 改凭据/环境要重启，同上 |
 * | `run-launcher` | 启动器脚本在部署时跑过；验收期再跑一次等于重新部署 |
 * | `stub-upstream` | 真机打真实模型端点，那正是真机腿的意义；插一个假上游会把这条腿变成一次慢十倍的本地跑 |
 *
 * 剩下的 `raw-dial` / `read-node-files` / `exec-node-cli` 覆盖了握手、能力、
 * 信任、投递、唤醒、审计六个维度的**绝大部分**——因为那些场景的材料都在
 * **发起方**手里（错 PSK、过期 token、重放……），拨过去就能问，不需要动节点。
 *
 * `restart-node` 默认也不给；`--allow-restart` 才打开（恢复维度要它）。
 *
 * ## 舰队拓扑
 *
 * 四节点 `cornna-p2`(beta-1) / `cornna-p3`(beta-2) / `cornna-p7`(beta-3) /
 * `cornna-p12`(beta-4)，控制台在 `workbench-iap`。
 *
 * **`bun` 在 p2/p3/p7 上位于 `~/.bun/bin/bun`，非交互 SSH 解析不到** ——
 * 这正是 issue #40 那次事故的成因，所以 {@link FleetDriver.execNode} 每条命令
 * 都显式补 PATH。别把它「简化」掉。
 */

import type {
  AcceptanceDriver,
  DialOptions,
  DialProbe,
  DriverCapability,
  ExecHost,
  ExecResult,
  NodeHandle,
  NodeSpec,
  ScenarioContext,
} from '../types.js'
import { rawDial } from '../local/dial.js'

/**
 * 一次性目录的家目录相对前缀。
 *
 * 放在 `.cache` 下而不是内测根下：那棵树是部署产物，验收不该往里塞东西；
 * 而这个前缀出现在每一次 `rm -rf` 的路径里，是那条命令的安全前提。
 */
const SCRATCH_PREFIX = '.cache/qianmo-acceptance'

/** 一台真机。 */
export interface FleetHost {
  /** SSH 目标（`~/.ssh/config` 里的别名），如 `cornna-p2`。 */
  readonly ssh: string
  /** 节点名，如 `beta-1`。 */
  readonly node: string
  /** 传输层地址，如 `ws://10.0.0.2:38625`。 */
  readonly endpoint: string
  /** 节点配置根的**绝对路径**，如 `/home/cornna/qianmo-beta/nodes/beta-1/config`。 */
  readonly configRoot: string
  /** `dist/cli-node.js` 的绝对路径。 */
  readonly occPath: string
  /** 额外要补进 PATH 的目录（`~/.bun/bin`，非交互 SSH 解析不到它）。 */
  readonly extraPath?: string
}

export interface FleetConfig {
  readonly hosts: readonly FleetHost[]
  /** 传输层 PSK。按节点分的话给一张表。 */
  readonly psk: Readonly<Record<string, string>>
  /** 允许重启节点（恢复维度需要）。默认关。 */
  readonly allowRestart?: boolean
  /** SSH 额外参数。 */
  readonly sshArgs?: readonly string[]
}

/** 舰队默认拓扑。**裸名 `beta-4` 是黑洞，节点四必须用 `cornna-p12`。** */
export const DEFAULT_FLEET_HOSTS: readonly Omit<FleetHost, 'occPath'>[] = [
  {
    ssh: 'cornna-p2',
    node: 'beta-1',
    endpoint: 'ws://127.0.0.1:38625',
    configRoot: '/home/cornna/qianmo-beta/nodes/beta-1/config',
    extraPath: '$HOME/.bun/bin',
  },
  {
    ssh: 'cornna-p3',
    node: 'beta-2',
    endpoint: 'ws://127.0.0.1:38625',
    configRoot: '/home/cornna/qianmo-beta/nodes/beta-2/config',
    extraPath: '$HOME/.bun/bin',
  },
  {
    ssh: 'cornna-p7',
    node: 'beta-3',
    endpoint: 'ws://127.0.0.1:38625',
    configRoot: '/home/cornna/qianmo-beta/nodes/beta-3/config',
    extraPath: '$HOME/.bun/bin',
  },
  {
    ssh: 'cornna-p12',
    node: 'beta-4',
    endpoint: 'ws://127.0.0.1:38625',
    configRoot: '/root/qianmo-beta/nodes/beta-4/config',
  },
]

interface FleetNodeHandle extends NodeHandle {
  readonly host: FleetHost
}

export class FleetDriver implements AcceptanceDriver {
  readonly target = 'fleet' as const
  readonly capabilities: ReadonlySet<DriverCapability>
  readonly #config: FleetConfig
  /** `execHost` 不点名时的轮转游标 —— 见那个方法的注释。 */
  #execHostCursor = 0

  constructor(config: FleetConfig) {
    this.#config = config
    const caps: DriverCapability[] = [
      'raw-dial',
      'read-node-files',
      'exec-node-cli',
      // 静态断言读的是**运行机上的这份仓库源码**，与目标是本地还是真机无关。
      // 真机腿照跑一遍，是为了「验收当时那份源码长这样」也进真机的报告。
      'read-repo-source',
    ]
    if (config.allowRestart === true) caps.push('restart-node')
    this.capabilities = new Set(caps)
  }

  /**
   * 真机腿上这不是「起一个节点」，而是**附着到一个已经在跑的节点**。
   *
   * 所以 `spec` 里的 agent / policy / trust 全部**被忽略** —— 真机上那些是
   * 部署时决定的。要求任意参数起节点的场景已经因为缺 `spawn-node` 被 skip 掉
   * 了，走到这里的场景只需要一个「能拨、能读」的句柄。
   *
   * `spec.name` 用来在舰队里挑一台；给不出就用第一台。
   */
  async startNode(_ctx: ScenarioContext, spec: NodeSpec): Promise<NodeHandle> {
    const host =
      this.#config.hosts.find(h => h.node === spec.name) ??
      this.#config.hosts[0]
    if (host === undefined) {
      throw new Error('舰队配置里一台机器都没有')
    }
    const handle: FleetNodeHandle = {
      name: host.node,
      spec,
      host,
      endpoint: host.endpoint,
      configRoot: host.configRoot,
      stdout: async () => await this.#tail(host, 'out'),
      stderr: async () => await this.#tail(host, 'err'),
      alive: async () => {
        const probe = await this.#ssh(host, [
          `test -S /proc/1 || true; pgrep -f "resident --node ${host.node}" >/dev/null && echo alive || echo dead`,
        ])
        return probe.stdout.includes('alive')
      },
    }
    return handle
  }

  /** 真机上不停节点。停了内测就断了。 */
  async stopNode(): Promise<void> {
    throw new Error(
      'FleetDriver 不停真机节点：那会打断内测使用者，也会在那条节点的审计链上留下一次计划外中断',
    )
  }

  async restartNode(
    _ctx: ScenarioContext,
    node: NodeHandle,
  ): Promise<NodeHandle> {
    if (this.#config.allowRestart !== true) {
      throw new Error('真机重启需要显式 --allow-restart')
    }
    const host = (node as FleetNodeHandle).host
    await this.#ssh(host, [
      `cd ~/atlas-beta && demo/env/beta/beta-down.sh node && demo/env/beta/beta-up.sh --role node --node ${host.node}`,
    ])
    return node
  }

  async dial(
    _ctx: ScenarioContext,
    node: NodeHandle,
    opts: DialOptions,
  ): Promise<DialProbe> {
    const host = (node as FleetNodeHandle).host
    const psk = this.#config.psk[host.node] ?? ''
    if (opts.auth.mode !== 'psk' && opts.auth.mode !== 'none') {
      throw new Error(
        'FleetDriver.dial 只处理 psk / none；签名类拨号请直接用 rawDial',
      )
    }
    return await rawDial({
      url: node.endpoint,
      node: 'acceptance-probe',
      auth:
        opts.auth.mode === 'none'
          ? { kind: 'none' }
          : { kind: 'psk', psk: opts.auth.psk === '' ? psk : opts.auth.psk },
      sendBeforeAuth: opts.sendBeforeAuth,
      sendAfterReady: opts.send,
      timeoutMs: opts.timeoutMs,
    })
  }

  async readNodeFile(
    node: NodeHandle,
    relPath: string,
  ): Promise<string | undefined> {
    const host = (node as FleetNodeHandle).host
    // `cat --` 而不是 `cat`：路径里的前导 `-` 否则会被当成参数。
    const result = await this.#ssh(host, [
      `cat -- '${host.configRoot}/${relPath}' 2>/dev/null || true`,
    ])
    return result.stdout === '' ? undefined : result.stdout
  }

  async listNodeDir(
    node: NodeHandle,
    relPath: string,
  ): Promise<string[] | undefined> {
    const host = (node as FleetNodeHandle).host
    const result = await this.#ssh(host, [
      `ls -1 -- '${host.configRoot}/${relPath}' 2>/dev/null || true`,
    ])
    if (result.stdout.trim() === '') return undefined
    return result.stdout.split('\n').filter(line => line !== '')
  }

  async execNode(
    node: NodeHandle,
    argv: readonly string[],
  ): Promise<ExecResult> {
    const host = (node as FleetNodeHandle).host
    const quoted = argv.map(a => `'${shellQuote(a)}'`).join(' ')
    // PATH 与 OCC_CONFIG_DIR 都要显式给：非交互 SSH 既解析不到 ~/.bun/bin，
    // 也不会带上部署时那套环境。
    const prefix =
      host.extraPath === undefined ? '' : `PATH="${host.extraPath}:$PATH" `
    return await this.#ssh(host, [
      `${prefix}OCC_IDENTITY=qianmo OCC_CONFIG_DIR='${host.configRoot}' bun '${host.occPath}' ${quoted}`,
    ])
  }

  /**
   * 真机上的一次性执行位置：`$HOME/.cache/qianmo-acceptance/<随机>` 下的
   * `config/` 与 `work/`，跑完 `rm -rf` 掉。
   *
   * **为什么不复用生产配置根** —— 见 {@link ExecHost} 的对比表。一句话：那些
   * 命令会往配置根里生成身份密钥并可能落 settings，而生产根下的身份与审计链
   * 是内测节点在用的东西，也是成果边界的证据。
   *
   * 清理挂 `ctx.cleanup`，runner 在 `finally` 里逆序跑，超时路径也会跑到。
   * `rm -rf` 的路径由 `mktemp -d` 自己回显、且被钉在那个前缀下 —— 拼一个
   * 可能为空的变量再 `rm -rf` 是这类脚本最经典的事故形态。
   */
  async execHost(ctx: ScenarioContext, nodeName?: string): Promise<ExecHost> {
    // 不点名就轮着来，而不是永远第一台。四台里 p12 是 x86_64、另外三台是
    // aarch64 —— 全压在 hosts[0] 上，「验收跑过真机」就只覆盖了一种架构。
    // 落在哪台机器写进每条结果的证据里（`执行位置`），所以红了照样可归因。
    const host =
      nodeName === undefined
        ? this.#config.hosts[this.#execHostCursor++ % this.#config.hosts.length]
        : (this.#config.hosts.find(h => h.node === nodeName) ??
          this.#config.hosts[0])
    if (host === undefined) throw new Error('舰队配置里一台机器都没有')

    const made = await this.#ssh(host, [
      `set -e`,
      `mkdir -p "$HOME/${SCRATCH_PREFIX}"`,
      `d="$(mktemp -d "$HOME/${SCRATCH_PREFIX}/run.XXXXXXXX")"`,
      `mkdir -p "$d/config" "$d/work"`,
      `printf '%s\n' "$d"`,
    ])
    const root = made.stdout.trim()
    if (made.code !== 0 || !root.includes(SCRATCH_PREFIX)) {
      throw new Error(
        `在 ${host.ssh} 上开一次性目录失败 (${made.code}): ${made.stderr.slice(0, 400)}`,
      )
    }
    ctx.cleanup(async () => {
      // 只删自己刚建的那一层，且再确认一次它带着前缀。
      if (!root.includes(SCRATCH_PREFIX)) return
      await this.#ssh(host, [`rm -rf -- '${shellQuote(root)}'`])
    })

    const configDir = `${root}/config`
    const workdir = `${root}/work`
    const prefix =
      host.extraPath === undefined ? '' : `PATH="${host.extraPath}:$PATH" `
    return {
      describe: `${host.ssh} (${host.node})`,
      configDir,
      workdir,
      exec: async (argv, opts) => {
        const env = Object.entries(opts?.env ?? {})
          .map(([k, v]) => `${k}='${shellQuote(v)}' `)
          .join('')
        const quoted = argv.map(a => `'${shellQuote(a)}'`).join(' ')
        return await this.#ssh(
          host,
          [
            `${prefix}OCC_IDENTITY=qianmo OCC_CONFIG_DIR='${shellQuote(configDir)}' ` +
              `${env}bun '${shellQuote(host.occPath)}' ${quoted}`,
          ],
          opts?.timeoutMs,
        )
      },
      writeFile: async (relPath, content) => {
        const abs = `${workdir}/${relPath}`
        // 内容经 stdin 进去，不进命令行：链文件带引号与换行，拼进 argv 迟早出事。
        const written = await this.#ssh(
          host,
          [
            `mkdir -p -- "$(dirname -- '${shellQuote(abs)}')"`,
            `cat > '${shellQuote(abs)}'`,
          ],
          undefined,
          content,
        )
        if (written.code !== 0) {
          throw new Error(
            `在 ${host.ssh} 上写 ${relPath} 失败 (${written.code}): ${written.stderr.slice(0, 300)}`,
          )
        }
        return abs
      },
      mkdir: async relPath => {
        const abs = `${workdir}/${relPath}`
        await this.#ssh(host, [`mkdir -p -- '${shellQuote(abs)}'`])
        return abs
      },
      freePort: async () => await this.#freePortOn(host),
    }
  }

  /**
   * 目标机上找一个此刻没人在听的高位端口。
   *
   * 用 `ss` 的全量快照做差集而不是逐个口去问：一次 SSH 往返就够，而逐个问是
   * 每个候选一次往返。答不出来是**错误**，不是随便回一个 —— 回一个碰巧被占的
   * 口会让「不可达」那条场景红得毫无道理。
   */
  async #freePortOn(host: FleetHost): Promise<number> {
    const probe = await this.#ssh(host, [
      `ss -H -ltn 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -u`,
    ])
    if (probe.code !== 0) {
      throw new Error(
        `在 ${host.ssh} 上取监听端口表失败 (${probe.code}): ${probe.stderr.slice(0, 300)}`,
      )
    }
    const busy = new Set(probe.stdout.split('\n').map(l => l.trim()))
    for (let i = 0; i < 200; i += 1) {
      const port = 41_000 + Math.floor(Math.random() * 4_000)
      if (!busy.has(String(port))) return port
    }
    throw new Error(`在 ${host.ssh} 上 200 次都没抽到空闲端口`)
  }

  async #tail(host: FleetHost, stream: 'out' | 'err'): Promise<string> {
    const result = await this.#ssh(host, [
      `tail -200 -- "$(dirname '${host.configRoot}')/../../logs/${host.node}.${stream}" 2>/dev/null || true`,
    ])
    return result.stdout
  }

  /**
   * 跑一条远端命令。
   *
   * `stdin` 给了就不能带 `-n`（那个选项把 stdin 接到 /dev/null），这正是
   * `writeFile` 经管道送内容的那条路径。
   */
  async #ssh(
    host: FleetHost,
    lines: readonly string[],
    timeoutMs?: number,
    stdin?: string,
  ): Promise<ExecResult> {
    const child = Bun.spawn(
      [
        'ssh',
        ...(stdin === undefined ? ['-n'] : []),
        '-o',
        'BatchMode=yes',
        ...(this.#config.sshArgs ?? []),
        host.ssh,
        lines.join('\n'),
      ],
      {
        stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill('SIGKILL')
          }, timeoutMs)
    let code: number
    try {
      code = await child.exited
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    return { code, stdout, stderr }
  }
}

/** 单引号内的转义 —— 远端命令一律用 `'…'` 包，内部的 `'` 按 POSIX 拼法断开。 */
function shellQuote(value: string): string {
  return value.replaceAll("'", `'\\''`)
}

/**
 * 从环境变量拼一份舰队配置。
 *
 * PSK 按节点取 `QIANMO_ACCEPTANCE_PSK_<节点名大写下划线>`，取不到回退到
 * `QIANMO_TRANSPORT_PSK`。**PSK 只从环境取，不写进仓库**（它是四台机的入站
 * 凭据，进仓库就等于公开）。
 *
 * `occPath` 由各 host 的 `configRoot` 推出来，而不是拼一次再对某台机做字符串
 * 替换 —— p12 那台的家目录是 `/root` 而不是 `/home/cornna`，替换写法在新增第
 * 五台机时会静默给出一条不存在的路径。
 */
export function fleetConfigFromEnv(
  repoDirOverride?: string,
  allowRestart = false,
): FleetConfig {
  const psk: Record<string, string> = {}
  const hosts = DEFAULT_FLEET_HOSTS.map(host => {
    const key = `QIANMO_ACCEPTANCE_PSK_${host.node.replaceAll('-', '_').toUpperCase()}`
    psk[host.node] = process.env[key] ?? process.env.QIANMO_TRANSPORT_PSK ?? ''
    // configRoot 形如 `<家目录>/qianmo-beta/nodes/<节点>/config`，仓库检出与它
    // 同在一个家目录下（`<家目录>/atlas-beta`）—— 那是 `beta-up.sh` 的部署形状。
    const home = host.configRoot.replace(/\/qianmo-beta\/.*$/, '')
    const repoDir = repoDirOverride ?? `${home}/atlas-beta`
    return { ...host, occPath: `${repoDir}/dist/cli-node.js` }
  })
  return { hosts, psk, allowRestart }
}
