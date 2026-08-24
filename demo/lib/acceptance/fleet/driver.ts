// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 真机舰队驱动 —— 四节点 + 控制台，走真实链路。
 *
 * ## 状态：已对真舰队跑过（2026-08-24）
 *
 * 第一轮真跑正如预言的那样是一次调试：套件报 `pass=11 fail=0 skip=104` + exit 0
 * +「判定: PASS」，而这个驱动**一次都没被调用过**（issue #61）。那轮的红不在
 * 被测系统上，在套件上。修完的现在：`startNode`(附着) / `alive` / `stdout` /
 * `stderr` / `listNodeDir` / `readNodeFile` / `execNode` / `execHost` / `dial` /
 * `inspectMirrorTransport` 都对着真机验过。
 *
 * **拨号地址是这个文件最容易再错一次的地方**，见 {@link FleetHost.endpoint}。
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
 * `restart-node` 也不给，而且**没有开关能打开它**。原先有一个 `--allow-restart`，
 * 但它解锁的场景数是 **0**：恢复维度那四条每一条都同时要 `spawn-node`（它们要
 * 先按特定 policy/trust 起一个自己的节点，再重启它、看身份与审计链接不接得上），
 * 而真机腿永远不会有 `spawn-node`。一个永远不改变任何行为的开关比没有更糟 ——
 * 它让人以为「加上它真机腿就能测恢复」。要在真机上测恢复得先有一条**不需要
 * 自己起节点**的恢复场景，那条场景还不存在（issue #61 第 4 条）。
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
  MirrorTransportReport,
  MirrorTransportUnit,
  NodeHandle,
  NodeSpec,
  ScenarioContext,
} from '../types.js'
import { rawDial } from '../local/dial.js'
import { TRAIL_PATH } from '../observe.js'

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
  /**
   * 拨号地址。**这是 runner 那一侧看到的地址，不是节点自己看到的。**
   *
   * 节点在自己机器上听 `127.0.0.1:38625`（四台一模一样），所以直接写那个值
   * 等于让 runner 去拨自己的 38625 —— 那正是 issue #61 第 3 条：四台共用一个
   * 常量、从舰队外拨永远拨不到任何一台。数据面本身是好的，缺的只是**按主机
   * 分配的端口**。见 {@link FleetHost.tunnelPort} 与 {@link fleetConfigFromEnv}。
   */
  readonly endpoint: string
  /**
   * 这台节点在**控制台机器 H** 上的隧道入口端口（38631–38634，一台一个）。
   *
   * 数据面是 H 单点辐射：H 上四条 `qianmo-tunnel@<节点>` 把
   * `127.0.0.1:3863x` 转到各自节点的 38625。所以「从舰队外拨得到某台节点」
   * 等价于「能打到 H 的 3863x」。
   */
  readonly tunnelPort: number
  /** 节点配置根的**绝对路径**，如 `/home/cornna/qianmo-beta/nodes/beta-1/config`。 */
  readonly configRoot: string
  /** `dist/cli-node.js` 的绝对路径。 */
  readonly occPath: string
  /** 额外要补进 PATH 的目录（`~/.bun/bin`，非交互 SSH 解析不到它）。 */
  readonly extraPath?: string
}

export interface FleetConfig {
  readonly hosts: readonly FleetHost[]
  /**
   * 控制台机器的 SSH 目标（`workbench-iap`）。
   *
   * 驱动此前根本没有「控制台主机」这个概念，而审计镜像的**搬运**那一半全部
   * 发生在它上面：四条 `qianmo-mirror@<节点>` user-scope 单元、镜像文件、
   * 以及跑着的控制台自己申报的滞后上限（issue #62）。
   */
  readonly consoleHost?: string
  /** 传输层 PSK。按节点分的话给一张表。 */
  readonly psk: Readonly<Record<string, string>>
  /** SSH 额外参数。 */
  readonly sshArgs?: readonly string[]
}

/**
 * 舰队默认拓扑。**裸名 `beta-4` 是黑洞，节点四必须用 `cornna-p12`。**
 *
 * `endpoint` 不写在这里 —— 它由 {@link fleetConfigFromEnv} 按 `tunnelPort` 与
 * 拨号主机现拼，因为「从哪儿拨」是运行环境的事实而不是拓扑的事实。
 */
export const DEFAULT_FLEET_HOSTS: readonly Omit<
  FleetHost,
  'occPath' | 'endpoint'
>[] = [
  {
    ssh: 'cornna-p2',
    node: 'beta-1',
    tunnelPort: 38_631,
    configRoot: '/home/cornna/qianmo-beta/nodes/beta-1/config',
    extraPath: '$HOME/.bun/bin',
  },
  {
    ssh: 'cornna-p3',
    node: 'beta-2',
    tunnelPort: 38_632,
    configRoot: '/home/cornna/qianmo-beta/nodes/beta-2/config',
    extraPath: '$HOME/.bun/bin',
  },
  {
    ssh: 'cornna-p7',
    node: 'beta-3',
    tunnelPort: 38_633,
    configRoot: '/home/cornna/qianmo-beta/nodes/beta-3/config',
    extraPath: '$HOME/.bun/bin',
  },
  {
    ssh: 'cornna-p12',
    node: 'beta-4',
    tunnelPort: 38_634,
    configRoot: '/root/qianmo-beta/nodes/beta-4/config',
  },
]

interface FleetNodeHandle extends NodeHandle {
  readonly host: FleetHost
}

/**
 * 真机腿缺的那几项，以及为什么缺。与本文件头注那张表同一批理由 —— 写在这里
 * 是为了让它们进报告：只印一句「缺少能力: spawn-node」的 skip，读的人分不出
 * 「这条腿天然做不到」和「谁忘了实现」。
 */
const FLEET_CAPABILITY_GAPS: ReadonlyMap<DriverCapability, string> = new Map([
  [
    'spawn-node',
    '舰队节点是长期部署的常驻，验收不该按任意参数另起一个：重起会打断内测使用者，也会污染那条节点的审计链',
  ],
  [
    'spawn-console',
    '控制台既是部署好的、又只经隧道可达，「起一个自己的控制台再打它的端口」两头都不成立',
  ],
  [
    'restart-node',
    '重启真机节点会打断内测使用者，并在那条节点的审计链上留下一次计划外中断；原先那个 --allow-restart 开关解锁的场景数是 0（恢复维度四条都同时要 spawn-node），已删',
  ],
  ['mutate-node-env', '改凭据/环境要重启，与 restart-node 同一条理由'],
  [
    'run-launcher',
    '启动器脚本在部署时跑过；验收期再跑一次等于重新部署一遍生产环境',
  ],
  [
    'stub-upstream',
    '真机打真实模型端点，那正是这条腿的意义；插一个假上游会把它变成一次慢十倍的本地跑',
  ],
  [
    'local-ca-fixture',
    'CA 目录与证书是在 runner 的文件系统上造的，而被测二进制在四台节点上 —— --cert/--trust-ca 指过去是一条不存在的路径',
  ],
  ['mirror-transport', '没有配置控制台主机（QIANMO_ACCEPTANCE_CONSOLE_HOST）'],
])

export class FleetDriver implements AcceptanceDriver {
  readonly target = 'fleet' as const
  readonly capabilities: ReadonlySet<DriverCapability>
  readonly capabilityGaps = FLEET_CAPABILITY_GAPS
  readonly #config: FleetConfig
  /** `execHost` 不点名时的轮转游标 —— 见那个方法的注释。 */
  #execHostCursor = 0

  constructor(config: FleetConfig) {
    this.#config = config
    const caps: DriverCapability[] = [
      'attach-node',
      'raw-dial',
      'read-node-files',
      'exec-node-cli',
      // 静态断言读的是**运行机上的这份仓库源码**，与目标是本地还是真机无关。
      // 真机腿照跑一遍，是为了「验收当时那份源码长这样」也进真机的报告。
      'read-repo-source',
    ]
    if (config.consoleHost !== undefined) caps.push('mirror-transport')
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

  /**
   * 真机上不重启节点 —— 与 {@link stopNode} 同一条理由，且驱动**不声明**
   * `restart-node`，所以任何要它的场景在能力差集那一步就被跳掉了，走不到这里。
   *
   * 留着这个方法只是因为接口要求；它抛，不是「暂未实现」的占位。
   */
  async restartNode(): Promise<NodeHandle> {
    throw new Error(
      'FleetDriver 不重启真机节点：那会打断内测使用者，也会在那条节点的审计链上留下一次计划外中断',
    )
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
      node: opts.nodeName ?? 'acceptance-probe',
      auth:
        opts.auth.mode === 'none'
          ? { kind: 'none' }
          : { kind: 'psk', psk: opts.auth.psk === '' ? psk : opts.auth.psk },
      sendBeforeAuth: opts.sendBeforeAuth,
      sendAfterReady: opts.send,
      settleMs: opts.settleMs,
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
   * 读一次审计镜像搬运的现场（issue #62）。
   *
   * ## 三个「不要写死」
   *
   * ① **镜像路径与滞后上限从跑着的控制台命令行上读**，不是常数。控制台是
   *    `--audit <节点>=<路径>` + `--audit-mirror <节点>=<分钟>` 申报的，那条
   *    命令行才是真源；抄一份进套件，改了部署这边不会红，只会开始说谎。
   * ② **新鲜度用控制台机器自己的钟算**（同一次采集里取 `date +%s`）。拿
   *    runner 的钟去减目标机的 mtime，跨时区或时钟漂移会造出假红/假绿。
   * ③ **权威副本比的是前缀哈希**，不是整份相等。审计链只追加，采样之间源端
   *    完全可能又写了几条 —— 那时整份哈希本来就该不同，而搬运仍然是对的。
   *
   * 采集全程只读：`systemctl show` / `stat` / `md5sum` / `head -c`。
   */
  async inspectMirrorTransport(): Promise<MirrorTransportReport> {
    const consoleHost = this.#config.consoleHost
    if (consoleHost === undefined) {
      throw new Error('inspectMirrorTransport 需要 consoleHost')
    }
    const consoleSsh: FleetHost = {
      ssh: consoleHost,
      node: 'console',
      tunnelPort: 0,
      endpoint: '',
      configRoot: '',
      occPath: '',
    }

    // 一次往返把控制台侧的东西全取回来：跑着的控制台命令行 + 每台的单元状态
    // + 镜像文件的 stat/md5 + 目标机的钟。
    const declared = await this.#ssh(consoleSsh, [
      `date +%s`,
      // 申报是成对的 `--audit <n>=<路径>` / `--audit-mirror <n>=<分钟>`，从
      // **跑着的控制台**的命令行上读 —— 那条命令行才是真源，抄一份进套件只会
      // 在部署改了之后开始说谎。
      `ps -eo args | grep -oE -- '--audit(-mirror)? [^ ]+' | sort -u`,
    ])
    if (declared.code !== 0) {
      return {
        consoleHost,
        units: [],
        failure: `读控制台申报失败 (${declared.code}): ${declared.stderr.slice(0, 400)}`,
      }
    }
    const declaredLines = declared.stdout.split('\n')
    const observedAtSec = Number.parseInt(declaredLines[0] ?? '', 10)
    const paths = new Map<string, string>()
    const lags = new Map<string, number>()
    for (const line of declaredLines.slice(1)) {
      const mirror = /^--audit-mirror (\S+)=(\d+)$/.exec(line.trim())
      if (mirror !== null && mirror[1] !== undefined) {
        lags.set(mirror[1], Number.parseInt(mirror[2] ?? '', 10))
        continue
      }
      const audit = /^--audit (\S+)=(\S+)$/.exec(line.trim())
      if (audit !== null && audit[1] !== undefined && audit[2] !== undefined) {
        paths.set(audit[1], audit[2])
      }
    }

    const units: MirrorTransportUnit[] = []
    for (const host of this.#config.hosts) {
      const mirrorPath = paths.get(host.node)
      const quotedMirror =
        mirrorPath === undefined ? '' : shellQuote(mirrorPath)
      // 每个值单独一行 `键=值`：`stat -c` 的 `%n` 是**文件名**不是换行，一行
      // 塞两个字段会拼出 `mirror-mtime=…<路径>mirror-bytes=…` 这种读不回来的
      // 东西。时间戳让**目标机自己**把 systemd 那串人话转成 epoch —— 那串正是
      // 它打印的，它一定认得，而在 runner 上 `Date.parse` 一个带时区缩写的
      // systemd 时间串是另一条会静默给出 NaN 的路。
      const unit = `qianmo-mirror@${host.node}`
      const probe = await this.#ssh(consoleSsh, [
        `lt="$(systemctl --user show '${unit}.timer' -p LastTriggerUSec --value 2>/dev/null)"`,
        `printf 'last-trigger-at=%s\n' "$lt"`,
        `printf 'last-trigger-sec=%s\n' "$(date -d "$lt" +%s 2>/dev/null)"`,
        `systemctl --user show '${unit}.service' -p ExecMainStatus -p Result 2>/dev/null || true`,
        ...(mirrorPath === undefined
          ? []
          : [
              `printf 'mirror-mtime=%s\n' "$(stat -c '%Y' -- '${quotedMirror}' 2>/dev/null)"`,
              `printf 'mirror-bytes=%s\n' "$(stat -c '%s' -- '${quotedMirror}' 2>/dev/null)"`,
              `printf 'mirror-md5=%s\n' "$(md5sum -- '${quotedMirror}' 2>/dev/null | cut -d' ' -f1)"`,
            ]),
      ])
      const mirrorBytes = intField(probe.stdout, 'mirror-bytes')
      // 权威副本在**节点**上，所以这一段要连到那台机器上去问。
      const authority =
        mirrorBytes === undefined
          ? { code: 0, stdout: '', stderr: '' }
          : await this.#ssh(host, [
              `t='${shellQuote(`${host.configRoot}/${TRAIL_PATH}`)}'`,
              `printf 'authoritative-bytes=%s\n' "$(stat -c '%s' -- "$t" 2>/dev/null)"`,
              `printf 'authoritative-md5=%s\n' "$(md5sum -- "$t" 2>/dev/null | cut -d' ' -f1)"`,
              `printf 'authoritative-prefix-md5=%s\n' "$(head -c ${mirrorBytes} -- "$t" 2>/dev/null | md5sum | cut -d' ' -f1)"`,
            ])
      units.push({
        node: host.node,
        ...(lags.get(host.node) === undefined
          ? {}
          : { maxLagMinutes: lags.get(host.node) }),
        ...(mirrorPath === undefined ? {} : { mirrorPath }),
        ...pick('lastTriggerAt', strField(probe.stdout, 'last-trigger-at')),
        ...pick('lastTriggerSec', intField(probe.stdout, 'last-trigger-sec')),
        ...pick('serviceExitCode', intField(probe.stdout, 'ExecMainStatus')),
        ...pick('serviceResult', strField(probe.stdout, 'Result')),
        ...pick('mirrorMtimeSec', intField(probe.stdout, 'mirror-mtime')),
        ...pick('mirrorBytes', mirrorBytes),
        ...pick('mirrorHash', strField(probe.stdout, 'mirror-md5')),
        ...pick(
          'authoritativeBytes',
          intField(authority.stdout, 'authoritative-bytes'),
        ),
        ...pick(
          'authoritativeHash',
          strField(authority.stdout, 'authoritative-md5'),
        ),
        ...pick(
          'authoritativePrefixHash',
          strField(authority.stdout, 'authoritative-prefix-md5'),
        ),
        ...(Number.isFinite(observedAtSec) ? { observedAtSec } : {}),
        raw: `${probe.stdout}\n${authority.stdout}`.trim(),
      })
    }
    return { consoleHost, units }
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

/** 只在值存在时给出这一项 —— 让 `exactOptionalPropertyTypes` 下的拼装保持干净。 */
function pick<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined
    ? {}
    : ({ [key]: value } as unknown as Record<K, V>)
}

/** 从 `key=value` 行里取一个字符串字段；取不到或为空回 undefined。 */
function strField(text: string, key: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(`${key}=`)) continue
    const value = trimmed.slice(key.length + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

/** 同上，但要求它是个整数。**解析不出来一律 undefined，不要退回 0** —— 那会
 * 让「没取到」和「真的是 0」在断言里长得一模一样，而这两件事的判定相反。 */
function intField(text: string, key: string): number | undefined {
  const raw = strField(text, key)
  if (raw === undefined) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 单引号内的转义 —— 远端命令一律用 `'…'` 包，内部的 `'` 按 POSIX 拼法断开。 */
function shellQuote(value: string): string {
  return value.replaceAll("'", `'\\''`)
}

/** 控制台机器的默认 SSH 目标 —— 审计镜像的搬运那一半全发生在它上面。 */
export const DEFAULT_CONSOLE_HOST = 'workbench-iap'

/** 节点名 → 环境变量后缀（`beta-1` → `BETA_1`）。 */
function envSuffix(node: string): string {
  return node.replaceAll('-', '_').toUpperCase()
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
 *
 * ## 拨号地址怎么定（issue #61 第 3 条）
 *
 * 原先四台写死同一个 `ws://127.0.0.1:38625` —— 那是**节点自己**的回环地址，
 * 从舰队外拨等于拨 runner 自己的 38625。改成按主机的隧道端口，三级优先：
 *
 *   ① `QIANMO_ACCEPTANCE_ENDPOINT_<节点>`：整条 URL 直接给，最高优先。
 *      直连节点、换了端口、走别的转发，都用这个；
 *   ② `QIANMO_ACCEPTANCE_DIAL_HOST`：只换主机名，端口仍用各自的
 *      `tunnelPort`。**在 H 上跑套件时不用设**（那四个口就在 H 的回环上），
 *      从别处跑就把 `ssh -N -L 3863x:127.0.0.1:3863x <H>` 起起来再跑；
 *   ③ 默认 `ws://127.0.0.1:<tunnelPort>`。
 *
 * 套件不自己去建隧道：建隧道要一个跨整轮运行的进程与它的生命周期，而
 * 「这台 runner 怎么够得着舰队」本来就是运行环境的事，写死在套件里只会在
 * 换一种拓扑时挡路。拨不通是**如实的红**，不是假绿 —— 那正好是这次要修的病。
 */
export function fleetConfigFromEnv(repoDirOverride?: string): FleetConfig {
  // 控制台主机可关：`QIANMO_ACCEPTANCE_CONSOLE_HOST=` 置空就等于「这一轮没有
  // 控制台机器」，靠它的场景据此老实 skip 而不是红。
  const consoleHostRaw =
    process.env.QIANMO_ACCEPTANCE_CONSOLE_HOST ?? DEFAULT_CONSOLE_HOST
  const psk: Record<string, string> = {}
  const dialHost = process.env.QIANMO_ACCEPTANCE_DIAL_HOST ?? '127.0.0.1'
  const hosts = DEFAULT_FLEET_HOSTS.map(host => {
    const suffix = envSuffix(host.node)
    psk[host.node] =
      process.env[`QIANMO_ACCEPTANCE_PSK_${suffix}`] ??
      process.env.QIANMO_TRANSPORT_PSK ??
      ''
    // configRoot 形如 `<家目录>/qianmo-beta/nodes/<节点>/config`，仓库检出与它
    // 同在一个家目录下（`<家目录>/atlas-beta`）—— 那是 `beta-up.sh` 的部署形状。
    const home = host.configRoot.replace(/\/qianmo-beta\/.*$/, '')
    const repoDir = repoDirOverride ?? `${home}/atlas-beta`
    const endpoint =
      process.env[`QIANMO_ACCEPTANCE_ENDPOINT_${suffix}`] ??
      `ws://${dialHost}:${host.tunnelPort}`
    return { ...host, endpoint, occPath: `${repoDir}/dist/cli-node.js` }
  })
  return {
    hosts,
    psk,
    ...(consoleHostRaw === '' ? {} : { consoleHost: consoleHostRaw }),
  }
}
