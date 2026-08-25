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
 * ## 两种节点句柄，别混用（issue #65）
 *
 * `startNode` 在这条腿上有**两条**分岔，由 {@link NodeSpec.attach} 选：
 *
 * | | 是什么 | 谁用 | 能不能停/重启/写 |
 * | --- | --- | --- | --- |
 * | 附着 | 部署好的那台内测节点本人 | 声明 `attach-node` 的场景 | **一律不能** |
 * | 一次性 | 在一台舰队机器上现起的、跑完就杀掉并 `rm -rf` 的常驻 | 声明 `spawn-node` 的场景 | 能 |
 *
 * 「一次性节点」不是「重起内测节点」的委婉说法 —— 那件事仍然禁止，
 * {@link FleetDriver.stopNode} 对附着句柄照旧抛。它跑的是**那台机器上部署好的
 * 那个 `dist/cli-node.js`**，在真机的内核与架构上，只是配置根、端口、PSK 全是
 * 本场景自己的。于是：
 *
 *   · **正向拨号第一次成为可能**，而且**一把生产 PSK 都不需要读**。此前这条腿
 *     的数据面只有「错 PSK → 4003」一条，信封投递 / 能力 token / 限额在线上
 *     一条都没验过（PR #63 自陈的第 2 条缺口）。
 *   · 篡改、重启、硬杀这类**要动配置根**的场景也成立了 —— 动的是一次性根。
 *
 * ## 与本地驱动的**能力差**，以及为什么
 *
 * 真机腿仍然**没有**这两种能力，需要它们的场景如实记 `skip`：
 *
 * | 能力 | 为什么没有 |
 * | --- | --- |
 * | `mutate-node-env` | 本轮没有场景要它。一次性节点上它随 `restart-node` 一起成立，但没有场景验证过 —— 不声明未经验证的能力 |
 * | `stub-upstream` | 真机打真实模型端点，那正是真机腿的意义；插一个假上游会把这条腿变成一次慢十倍的本地跑 |
 *
 * `local-ca-fixture` **已经补齐**（此前卡在签发顺序上）：`execHost` 多了
 * `forNodeSpawn`（夹具位落在本场景的落机上）、`readFile`（产物回 runner）与
 * `run`（openssl），`NodeSpec.configRoot` 让「先签证书、再用同一个根起节点」
 * 这个顺序成立。于是离线 CA 那条链在真机上跑的是**部署好的那个
 * `dist/cli-node.js`** 的 `qm ca` / `qm cert`，证书文件也真的在节点那台机器上。
 *
 * ## 一次性节点落在哪台机器上
 *
 * 轮转 {@link DEFAULT_SPAWN_MACHINES}：`cornna-p2` / `cornna-p3` / `cornna-p7`
 * （aarch64）+ `workbench-iap`（x86_64）。**`cornna-p12` 不在里面**，理由是
 * 内存：那台一共 967 MB、可用约 380 MB，而一个常驻带上它的 ACP 子进程实测占
 * **约 370 MB**。在它上面起第二个常驻，最可能的结局是 OOM killer 挑走
 * beta-4 —— 而「跑完舰队仍然是好的」是这条腿的前置条件，不是它的目标。
 * x86_64 的覆盖由 H 提供，架构面没有因此变窄。
 *
 * ## 舰队拓扑
 *
 * 四节点 `cornna-p2`(beta-1) / `cornna-p3`(beta-2) / `cornna-p7`(beta-3) /
 * `cornna-p12`(beta-4)，控制台在 `workbench-iap`。
 *
 * **`bun` 在每一台上都位于 `~/.bun/bin/bun`，非交互 SSH 解析不到**（H 上实测
 * `which bun` 也答不出来）—— 这正是 issue #40 那次事故的成因，所以每条远端命令
 * 都显式补 PATH。别把它「简化」掉。
 *
 * **一次性常驻用 `setsid` 起**，于是它和它的 ACP 子进程落在同一个进程组里，
 * `kill -- -<pid>` 一次收干净。实测不加这一步的话，杀掉常驻会把 ACP 子进程
 * （约 250 MB）留在机器上，一轮下来能攒出几十个。
 */

import type {
  AcceptanceConsole,
  AcceptanceDriver,
  AcceptanceRegistry,
  ConsoleSlot,
  ConsoleSpec,
  DialOptions,
  DialProbe,
  DriverCapability,
  ExecHost,
  ExecHostWhere,
  ExecResult,
  LauncherHost,
  MirrorTransportReport,
  MirrorTransportUnit,
  NodeHandle,
  NodeSpec,
  RegistrySpec,
  ScenarioContext,
} from '../types.js'
import {
  consoleLaunch,
  http,
  startRegistry,
  tokensFromBanner,
} from '../local/console.js'
import { rawDial } from '../local/dial.js'
import { ACCEPTANCE_PSK, TIMINGS_FILE } from '../local/driver.js'
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

/**
 * 一台能承载**一次性进程**的舰队机器。
 *
 * 与 {@link FleetHost} 分开而不是加个布尔字段：`FleetHost` 的每个字段都描述
 * 「这台机器上那个内测节点」（节点名、隧道口、生产配置根），而承载一次性进程
 * 只需要「SSH 得到、有部署好的产物、有 bun」。控制台机器 H 满足后者却一个前者
 * 都没有 —— 塞进 `hosts` 会立刻污染 {@link FleetDriver.inspectMirrorTransport}
 * （它逐台去问 `qianmo-mirror@<节点>`）和 `execHost` 的轮转。
 */
export interface SpawnMachine {
  /** SSH 目标。 */
  readonly ssh: string
  /** 进证据用的标签，形如 `cornna-p2 (aarch64)`。 */
  readonly label: string
  /** 部署检出相对家目录的位置，如 `atlas-beta`。 */
  readonly repoRel: string
}

export interface FleetConfig {
  readonly hosts: readonly FleetHost[]
  /**
   * 能起一次性节点 / 控制台的机器。空表 = 这条腿没有 `spawn-node`。
   *
   * **不要把内存吃紧的机器放进来**，理由见文件头「一次性节点落在哪台机器上」。
   */
  readonly spawnMachines: readonly SpawnMachine[]
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

/**
 * 舰队默认的一次性进程承载机。
 *
 * `cornna-p12` **故意不在里面** —— 它一共 967 MB 内存、可用约 380 MB，而一个
 * 常驻 + ACP 子进程实测约 370 MB。见文件头。
 */
export const DEFAULT_SPAWN_MACHINES: readonly SpawnMachine[] = [
  { ssh: 'cornna-p2', label: 'cornna-p2 (aarch64)', repoRel: 'atlas-beta' },
  { ssh: 'cornna-p3', label: 'cornna-p3 (aarch64)', repoRel: 'atlas-beta' },
  { ssh: 'cornna-p7', label: 'cornna-p7 (aarch64)', repoRel: 'atlas-beta' },
  // 与 `DEFAULT_CONSOLE_HOST` 是同一台机器，但**写成字面量**：那个常量声明在
  // 本文件末尾，在这里引用会撞上 TDZ。两处同名不是巧合，是同一台 H。
  {
    ssh: 'workbench-iap',
    label: 'workbench-iap (x86_64)',
    repoRel: 'atlas-beta',
  },
]

/** 一个一次性节点的家当 —— 只有这种句柄才允许停 / 重启 / 往配置根里写。 */
interface DisposableNode {
  readonly machine: SpawnMachine
  /** 目标机上的一次性根（日志与 pid 文件落在它下面）。 */
  readonly root: string
  /**
   * 节点的配置根。缺省是 `${root}/config`，但场景可以经
   * {@link NodeSpec.configRoot} 换成一个**已经装着身份与证书**的根 —— 那正是
   * 证书这一维搬上真机的前提。存在这里而不是每次现算，是因为重启必须复用它。
   */
  readonly configRoot: string
  /** 节点在**它自己那台机器**上监听的端口。 */
  readonly remotePort: number
  readonly occPath: string
}

interface FleetNodeHandle extends NodeHandle {
  /** 这个句柄落在哪台机器上。 */
  readonly ssh: string
  /** 那台机器上 `dist/cli-node.js` 的绝对路径。 */
  readonly occPath: string
  /**
   * 一次性节点专有。**附着来的内测节点上是 undefined**，而每一个会改动目标
   * 状态的方法（`stopNode` / `restartNode` / `killNode` / `writeNodeFile` /
   * `setNodePathMode`）都先看它 —— 那是「不许动生产」这条纪律在代码里的位置。
   */
  readonly disposable?: DisposableNode
}

/**
 * 真机腿缺的那几项，以及为什么缺。与本文件头注那张表同一批理由 —— 写在这里
 * 是为了让它们进报告：只印一句「缺少能力: spawn-node」的 skip，读的人分不出
 * 「这条腿天然做不到」和「谁忘了实现」。
 */
const FLEET_CAPABILITY_GAPS: ReadonlyMap<DriverCapability, string> = new Map([
  [
    'spawn-node',
    '没有配置可承载一次性进程的舰队机器（QIANMO_ACCEPTANCE_SPAWN_HOSTS 置空）',
  ],
  [
    'spawn-console',
    '没有配置可承载一次性进程的舰队机器（QIANMO_ACCEPTANCE_SPAWN_HOSTS 置空）',
  ],
  [
    'restart-node',
    '重启只对一次性节点开放，而这一轮没有可承载一次性进程的舰队机器；部署好的内测节点永远不重启 —— 那会打断内测使用者，并在它的审计链上留下一次计划外中断',
  ],
  [
    'mutate-node-env',
    '本轮没有场景要它。一次性节点上它随 restart-node 一起成立（restartNode 收 Partial<NodeSpec>，env 在里面），但没有任何场景验证过 —— 不声明未经验证的能力',
  ],
  [
    'run-launcher',
    '没有配置可承载一次性进程的舰队机器（QIANMO_ACCEPTANCE_SPAWN_HOSTS 置空）',
  ],
  [
    'stub-upstream',
    '真机打真实模型端点，那正是这条腿的意义；插一个假上游会把它变成一次慢十倍的本地跑',
  ],
  [
    'local-ca-fixture',
    '没有配置可承载一次性进程的舰队机器（QIANMO_ACCEPTANCE_SPAWN_HOSTS 置空）—— 签发链要跑在被测二进制那台机器上，而这一轮一台都没有',
  ],
  ['mirror-transport', '没有配置控制台主机（QIANMO_ACCEPTANCE_CONSOLE_HOST）'],
])

/*
 * 驱动内部那几个「等它就绪」的墙钟预算。
 *
 * **一条纪律：用它们的地方一律乘 `ctx.timeoutScale`，不许写裸的
 * `Date.now() + <常数>`。**
 *
 * 这几个等待存在的意义是把「起来了但拨不通」和「压根没起来」分开说 —— 一条
 * 指名道姓的错误消息，比让场景撞上通用的场景级超时有用得多。但那份价值有个
 * 前提：**它们必须晚于场景预算触发才对**。倍率此前只作用于场景预算，够不到
 * 驱动内部，于是真机腿（`FLEET_TIMEOUT_SCALE = 4`）或忙 runner（CI 上
 * `--timeout-scale 3`）上它们会先炸，把一条只是慢了一步的场景记成 `error`
 * （「套件自己炸了」）—— 那既不算覆盖也不指向任何产品问题，还恰好是会被人
 * 当成「套件不稳」而加豁免的那类噪声（issue #85 ②，与 PR #69 同一条纪律）。
 *
 * 为什么从 `ctx` 取而不是在这里读 `FLEET_TIMEOUT_SCALE`：`--timeout-scale`
 * 可以压过那个默认值（PR #73），驱动自己去读常量就会和场景预算用上两个不同
 * 的倍率 —— 一份倍率、一个出处，出处是 runner。
 */

/** 一次性节点「拨得通了没有」与一次性控制台 `/v0/health` 的等待基准。 */
const DISPOSABLE_READY_BUDGET_MS = 60_000

/** 反向隧道「通了没有」的等待基准（远端 curl 探一次，每拍一次 SSH 往返）。 */
const REVERSE_TUNNEL_READY_BUDGET_MS = 30_000

export class FleetDriver implements AcceptanceDriver {
  readonly target = 'fleet' as const
  readonly capabilities: ReadonlySet<DriverCapability>
  readonly capabilityGaps = FLEET_CAPABILITY_GAPS
  readonly #config: FleetConfig
  /** `execHost` 不点名时的轮转游标 —— 见那个方法的注释。 */
  #execHostCursor = 0
  /** 一次性节点的落机轮转游标 —— 全压第一台等于只覆盖一种架构。 */
  #spawnCursor = 0
  /** `ssh <目标> echo $HOME` 的结果缓存（p12 是 /root，其余是 /home/cornna）。 */
  readonly #homes = new Map<string, Promise<string>>()
  /** 场景 → 它的落机。见 {@link FleetDriver.#machineFor}。 */
  readonly #machines = new WeakMap<ScenarioContext, SpawnMachine>()

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
    if (config.spawnMachines.length > 0) {
      caps.push(
        'spawn-node',
        'restart-node',
        'spawn-console',
        'run-launcher',
        // 签发链跑在落机上（`execHost({ forNodeSpawn: true })`），证书与 CA 根
        // 因此和一次性节点同机。没有落机 = 没有地方跑 `qm ca`，这一项随之消失。
        'local-ca-fixture',
      )
    }
    this.capabilities = new Set(caps)
  }

  /**
   * 两条分岔：附着到部署好的那台，或在一台舰队机器上起一个一次性节点。
   *
   * 选择权在 {@link NodeSpec.attach} —— 驱动看不到场景的 `requires`，所以
   * 「我要的是一台现成的节点」必须由规格自己说出来。见文件头那张表。
   *
   * 附着分支里 `spec` 的 agent / policy / trust 全部**被忽略**：真机上那些是
   * 部署时决定的，声明 `attach-node` 的场景本来就不关心它们。
   */
  async startNode(ctx: ScenarioContext, spec: NodeSpec): Promise<NodeHandle> {
    if (spec.attach === true) return this.#attach(spec)
    return await this.#spawn(ctx, spec)
  }

  #attach(spec: NodeSpec): FleetNodeHandle {
    const host =
      this.#config.hosts.find(h => h.node === spec.name) ??
      this.#config.hosts[0]
    if (host === undefined) {
      throw new Error('舰队配置里一台机器都没有')
    }
    return {
      name: host.node,
      spec,
      ssh: host.ssh,
      occPath: host.occPath,
      endpoint: host.endpoint,
      // 节点在自己机器上一律听 38625；那个值只有在那台机器上才有意义。
      hostEndpoint: 'ws://127.0.0.1:38625',
      configRoot: host.configRoot,
      stdout: async () => await this.#tail(host, 'out'),
      stderr: async () => await this.#tail(host, 'err'),
      alive: async () => {
        const probe = await this.#ssh(host.ssh, [
          `test -S /proc/1 || true; pgrep -f "resident --node ${host.node}" >/dev/null && echo alive || echo dead`,
        ])
        return probe.stdout.includes('alive')
      },
    }
  }

  /**
   * 在一台舰队机器上起一个**一次性**常驻：一次性配置根、自己挑的端口、自己的
   * PSK，跑完杀掉并 `rm -rf`。
   *
   * 三件事必须一起成立，缺一条这个方法就是假的：
   *
   * ① **跑的是那台机器上部署好的 `dist/cli-node.js`**，不是把 runner 的源码
   *    推过去。被测对象是产物 + 那台机器，这条腿的全部价值在这里。
   * ② **runner 拨得到它。** 节点听在目标机的回环上，所以要现开一条
   *    `ssh -L`；隧道的生命周期挂在场景上（见 {@link FleetDriver.#tunnel}）。
   *    这**不是**把「套件不自己建隧道」那条决定推翻了 —— 那条说的是「runner
   *    怎么够得着**既有**舰队」属于运行环境；而这里的端口是驱动自己刚分配的，
   *    除了驱动没有第二个人知道它，谈不上由环境去配。
   * ③ **就绪判据是拨得通**，与本地驱动同一条纪律：进程活着但端口没绑上的窗口
   *    真实存在，何况这里还多一层隧道预热。
   */
  async #spawn(ctx: ScenarioContext, spec: NodeSpec): Promise<NodeHandle> {
    const machine = await this.#machineFor(ctx)
    const home = await this.#homeOf(machine.ssh)
    const occPath = `${home}/${machine.repoRel}/dist/cli-node.js`
    const root = await this.#scratch(ctx, machine.ssh)
    const remotePort = await this.#freePortOn(machine.ssh)
    const disposable: DisposableNode = {
      machine,
      root,
      configRoot: spec.configRoot ?? `${root}/config`,
      remotePort,
      occPath,
    }

    // 隧道先于进程建：它一旦建好就在整条场景里有效，重启不必重建。
    const localPort = await this.#tunnel(ctx, machine.ssh, remotePort)
    const endpoint = `ws://127.0.0.1:${localPort}`
    return await this.#launchDisposable(ctx, spec, disposable, endpoint)
  }

  /** 起（或重起）一次性常驻，并等到它拨得通。配置根与端口都原样复用。 */
  async #launchDisposable(
    ctx: ScenarioContext,
    spec: NodeSpec,
    disposable: DisposableNode,
    endpoint: string,
  ): Promise<NodeHandle> {
    const { machine, root, configRoot, remotePort, occPath } = disposable
    const psk = spec.auth.mode === 'psk' ? spec.auth.psk : ACCEPTANCE_PSK

    const argv = [
      'resident',
      '--node',
      spec.name,
      // 与本地驱动同一个 team —— 信箱路径按它分目录，两边不一致的话
      // `observe.ts` 的信箱读取在真机腿上会一律读空。
      '--team',
      'acceptance',
      '--port',
      String(remotePort),
      '--hostname',
      '127.0.0.1',
      '--timings',
      `${configRoot}/${TIMINGS_FILE}`,
    ]
    const agentDirs: string[] = []
    for (const agent of Object.keys(spec.agents)) {
      // 规格里的工作区路径是 **runner 上的**，在目标机上不存在。这里只取 agent
      // 名、把工作区落在一次性根下 —— 场景断言的是「哪个 agent 收到了」，
      // 工作区在哪台机器上的哪个目录不是断言对象。
      const dir = `${root}/work/agents/${agent}`
      agentDirs.push(dir)
      argv.push('--agent', `${agent}=${dir}`)
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

    const env: Record<string, string> = {
      OCC_IDENTITY: 'qianmo',
      OCC_CONFIG_DIR: configRoot,
      QIANMO_TRANSPORT_PSK: psk,
      ...spec.env,
    }
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}='${shellQuote(v)}' `)
      .join('')
    const quoted = argv.map(a => `'${shellQuote(a)}'`).join(' ')
    const outLog = `${root}/out.log`
    const errLog = `${root}/err.log`
    const pidFile = `${root}/node.pid`

    const started = await this.#ssh(
      machine.ssh,
      [
        `set -e`,
        // 配置根一起建：场景给的那个根（`NodeSpec.configRoot`）多半已经存在
        // （签发链刚在里面造过身份），而驱动自己开的那个只有 `#scratch` 建过
        // 一次 —— 两种来源在这里合流，`mkdir -p` 对已存在的目录是幂等的。
        `mkdir -p '${shellQuote(configRoot)}' ${agentDirs.map(d => `'${shellQuote(d)}'`).join(' ')}`,
        `: > '${shellQuote(outLog)}'`,
        `: > '${shellQuote(errLog)}'`,
        // `setsid` 让常驻成为新会话的组长，于是它和 ACP 子进程同组，停的时候
        // `kill -- -<pid>` 一次收干净。实测非交互 shell 里 setsid 不会 fork，
        // 所以 `$!` 就是常驻自己的 pid，也就是那个组号。
        `PATH="$HOME/.bun/bin:$PATH" ${envPrefix}setsid bun '${shellQuote(occPath)}' ${quoted} ` +
          `>'${shellQuote(outLog)}' 2>'${shellQuote(errLog)}' </dev/null &`,
        `p=$!`,
        `printf '%s\\n' "$p" > '${shellQuote(pidFile)}'`,
        // 在**远端**轮询 banner，而不是每 0.5 s 往返一次 SSH：经 IAP 的那台
        // 一次往返要一秒上下，轮询放在 runner 侧等于给每个节点加半分钟。
        `for _ in $(seq 1 120); do`,
        `  if grep -q '"publicKey"' '${shellQuote(outLog)}'; then break; fi`,
        `  if ! kill -0 "$p" 2>/dev/null; then break; fi`,
        `  sleep 0.5`,
        `done`,
        `printf 'node-pid=%s\\n' "$p"`,
      ],
      120_000,
    )
    const banner = await this.#ssh(machine.ssh, [
      `cat '${shellQuote(outLog)}' 2>/dev/null || true`,
    ])
    if (!banner.stdout.includes('"publicKey"')) {
      const diag = await this.#ssh(machine.ssh, [
        `cat '${shellQuote(errLog)}' 2>/dev/null || true`,
      ])
      // **抛**而不是返回一个半死的句柄：`recovery/foreign-identity-refused`
      // 断言的正是这条异常的文本（「拒绝覆盖别人的身份文件」），而一个
      // 「起来了但什么都不答」的句柄会让那条场景在后面某个断言上红得毫无线索。
      throw new Error(
        `一次性节点 ${spec.name} 在 ${machine.label} 上没有起来\n` +
          `启动命令退出码 ${String(started.code)}\n` +
          `stdout:\n${banner.stdout}\nstderr:\n${diag.stdout}`,
      )
    }

    const handle: FleetNodeHandle = {
      name: spec.name,
      spec,
      ssh: machine.ssh,
      occPath,
      endpoint,
      hostEndpoint: `ws://127.0.0.1:${remotePort}`,
      configRoot,
      disposable,
      stdout: async () =>
        (
          await this.#ssh(machine.ssh, [
            `cat '${shellQuote(outLog)}' 2>/dev/null || true`,
          ])
        ).stdout,
      stderr: async () =>
        (
          await this.#ssh(machine.ssh, [
            `cat '${shellQuote(errLog)}' 2>/dev/null || true`,
          ])
        ).stdout,
      alive: async () =>
        (
          await this.#ssh(machine.ssh, [
            `p="$(cat '${shellQuote(pidFile)}' 2>/dev/null || echo)"`,
            `if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo alive; else echo dead; fi`,
          ])
        ).stdout.includes('alive'),
    }

    // 就绪判据与本地驱动同构，见 `local/driver.ts` 里那段长注释：拿不到对端
    // 证书私钥的场景（`--require-signed-handshake`）只能退到「收到 challenge」。
    const credentialed = spec.auth.mode === 'credential_signature'
    const deadline = Date.now() + DISPOSABLE_READY_BUDGET_MS * ctx.timeoutScale
    for (;;) {
      const probe = await rawDial({
        url: endpoint,
        node: 'readiness-probe',
        auth: { kind: credentialed ? 'none' : 'psk', psk },
        settleMs: 50,
        timeoutMs: 4_000,
      })
      if (credentialed ? probe.frames.length > 0 : probe.authed) break
      if (ctx.signal.aborted || Date.now() >= deadline) {
        const diag = await this.#ssh(machine.ssh, [
          `cat '${shellQuote(errLog)}' 2>/dev/null || true`,
        ])
        throw new Error(
          `一次性节点 ${spec.name} 在 ${machine.label} 上起来了但拨不通 ` +
            `(${endpoint} → ${machine.ssh}:${String(remotePort)})\n` +
            `最后一次拨号: ${JSON.stringify(probe).slice(0, 400)}\n` +
            `stderr:\n${diag.stdout.slice(0, 1_500)}`,
        )
      }
      await sleep(400)
    }
    // **杀进程的清理必须登记在这里，而不是只靠 `#scratch` 的 `rm -rf`。**
    // 第一版漏了这一条，于是一次跑完之后每台机器上都留着还活着的常驻：
    // 清理逆序跑，先拆隧道、再 `rm -rf`，而那个常驻活得好好的，转头就把
    // 配置目录**又建了回来** —— 现场是「目录删了又冒出来、里面只有 config/」，
    // 而真正的问题是一个没人管的进程带着它的 ACP 子进程在内测机上驻留。
    // 登记在这里，逆序就成了「杀进程 → 拆隧道 → 删目录」。
    ctx.cleanup(async () => {
      await this.#killGroup(handle, disposable, 'TERM')
    })
    ctx.log(`一次性节点 ${spec.name} 落在 ${machine.label}，端点 ${endpoint}`)
    return handle
  }

  /**
   * 停一个**一次性**节点。附着来的那台照旧抛 —— 停了内测就断了。
   *
   * 杀的是整个进程组：ACP 子进程与常驻同组，只杀常驻会把它（实测约 250 MB）
   * 留在机器上。
   */
  async stopNode(node: NodeHandle): Promise<void> {
    const disposable = requireDisposable(node, '停')
    await this.#killGroup(node as FleetNodeHandle, disposable, 'TERM')
  }

  /** SIGKILL 掉一个一次性节点 —— 制造「上一条命是被打断的」那种现场。 */
  async killNode(node: NodeHandle): Promise<void> {
    const disposable = requireDisposable(node, '硬杀')
    await this.#killGroup(node as FleetNodeHandle, disposable, 'KILL')
  }

  async #killGroup(
    node: FleetNodeHandle,
    disposable: DisposableNode,
    signal: 'TERM' | 'KILL',
  ): Promise<void> {
    const pidFile = `${disposable.root}/node.pid`
    await this.#ssh(node.ssh, [
      `p="$(cat '${shellQuote(pidFile)}' 2>/dev/null || echo)"`,
      `[ -n "$p" ] || exit 0`,
      // 先按组杀（`-$p`），组不在了再按 pid 补一刀。
      `kill -${signal} -"$p" 2>/dev/null || kill -${signal} "$p" 2>/dev/null || true`,
      ...(signal === 'TERM'
        ? [
            `for _ in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done`,
            `kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true`,
          ]
        : []),
      `for _ in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done`,
    ])
  }

  /**
   * 停掉再按（可覆盖的）同一份参数起回来。**配置根与端口都原样复用** ——
   * 前者是身份密钥与审计链的锚，后者让那条隧道继续有效。
   *
   * 附着来的内测节点上抛：重启它会打断内测使用者，并在它的审计链上留下一次
   * 计划外中断。
   */
  async restartNode(
    ctx: ScenarioContext,
    node: NodeHandle,
    overrides?: Partial<NodeSpec>,
  ): Promise<NodeHandle> {
    const disposable = requireDisposable(node, '重启')
    await this.#killGroup(node as FleetNodeHandle, disposable, 'TERM')
    // 端口要真的放开再绑回去。
    await sleep(500)
    return await this.#launchDisposable(
      ctx,
      { ...node.spec, ...overrides },
      disposable,
      node.endpoint,
    )
  }

  async dial(
    _ctx: ScenarioContext,
    node: NodeHandle,
    opts: DialOptions,
  ): Promise<DialProbe> {
    const fleetNode = node as FleetNodeHandle
    // 缺省 PSK 按句柄的种类取：一次性节点用它自己那把（场景挑的），附着来的
    // 才回落到配置里的生产 PSK。混用会让「错 PSK 被拒」这条在一次性节点上
    // 变成「对 PSK 被接受」——一次方向相反的假红。
    const fallback =
      fleetNode.disposable === undefined
        ? (this.#config.psk[fleetNode.name] ?? '')
        : node.spec.auth.mode === 'psk'
          ? node.spec.auth.psk
          : ACCEPTANCE_PSK
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
          : {
              kind: 'psk',
              psk: opts.auth.psk === '' ? fallback : opts.auth.psk,
            },
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
    const fleetNode = node as FleetNodeHandle
    // `cat --` 而不是 `cat`：路径里的前导 `-` 否则会被当成参数。
    const result = await this.#ssh(fleetNode.ssh, [
      `cat -- '${shellQuote(`${node.configRoot}/${relPath}`)}' 2>/dev/null || true`,
    ])
    return result.stdout === '' ? undefined : result.stdout
  }

  /**
   * 往配置根下写一个文件。**只对一次性节点开放** —— 见
   * {@link AcceptanceDriver.writeNodeFile} 与 {@link FleetNodeHandle.disposable}。
   */
  async writeNodeFile(
    node: NodeHandle,
    relPath: string,
    content: string,
  ): Promise<string> {
    requireDisposable(node, '写配置根')
    const fleetNode = node as FleetNodeHandle
    const abs = `${node.configRoot}/${relPath}`
    // 内容经 stdin 进去，不进命令行：审计链一行里带引号与换行，拼进 argv 迟早出事。
    const written = await this.#ssh(
      fleetNode.ssh,
      [
        `mkdir -p -- "$(dirname -- '${shellQuote(abs)}')"`,
        `cat > '${shellQuote(abs)}'`,
      ],
      undefined,
      content,
    )
    if (written.code !== 0) {
      throw new Error(
        `在 ${fleetNode.ssh} 上写 ${relPath} 失败 (${written.code}): ${written.stderr.slice(0, 300)}`,
      )
    }
    return abs
  }

  async setNodePathMode(
    node: NodeHandle,
    relPath: string,
    mode: string,
  ): Promise<void> {
    requireDisposable(node, '改权限位')
    const fleetNode = node as FleetNodeHandle
    await this.#ssh(fleetNode.ssh, [
      `chmod ${mode} -- '${shellQuote(`${node.configRoot}/${relPath}`)}'`,
    ])
  }

  async listNodeDir(
    node: NodeHandle,
    relPath: string,
  ): Promise<string[] | undefined> {
    const fleetNode = node as FleetNodeHandle
    const result = await this.#ssh(fleetNode.ssh, [
      `ls -1 -- '${shellQuote(`${node.configRoot}/${relPath}`)}' 2>/dev/null || true`,
    ])
    if (result.stdout.trim() === '') return undefined
    return result.stdout.split('\n').filter(line => line !== '')
  }

  async execNode(
    node: NodeHandle,
    argv: readonly string[],
  ): Promise<ExecResult> {
    const fleetNode = node as FleetNodeHandle
    const quoted = argv.map(a => `'${shellQuote(a)}'`).join(' ')
    // PATH 与 OCC_CONFIG_DIR 都要显式给：非交互 SSH 既解析不到 ~/.bun/bin，
    // 也不会带上部署时那套环境。
    return await this.#ssh(fleetNode.ssh, [
      `PATH="$HOME/.bun/bin:$PATH" OCC_IDENTITY=qianmo OCC_CONFIG_DIR='${shellQuote(node.configRoot)}' ` +
        `bun '${shellQuote(fleetNode.occPath)}' ${quoted}`,
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
  async execHost(
    ctx: ScenarioContext,
    where?: ExecHostWhere,
  ): Promise<ExecHost> {
    // 点了名就落在那个节点所在的机器上 —— 那类场景（`qm resident-wake`）要拨的
    // 正是这个节点的回环口，落在别处得穿隧道，而隧道只在 runner 那一侧存在。
    //
    // 不点名就在四台内测节点之间轮着来，而不是永远第一台：四台里 p12 是
    // x86_64、另外三台是 aarch64 —— 全压在 hosts[0] 上，「验收跑过真机」就只
    // 覆盖了一种架构。这里用 `hosts` 而不是 `spawnMachines`，因为这条路径跑的
    // 是**会结束的**子命令，p12 那点内存扛得住，没有理由把它排除在外。
    // 落在哪台机器写进每条结果的证据里（`执行位置`），所以红了照样可归因。
    const named = where?.sameMachineAs as FleetNodeHandle | undefined
    let ssh: string
    let occPath: string
    let describe: string
    if (named !== undefined) {
      ssh = named.ssh
      occPath = named.occPath
      describe = `${named.ssh} (与节点 ${named.name} 同机)`
    } else if (where?.forNodeSpawn === true) {
      // 夹具位：落在本场景的**落机**上，与后面 `#spawn` 起的一次性节点同机。
      // 走 `hosts` 轮转的话，`--trust-ca` 指向的会是另一台机器上的路径。
      const machine = await this.#machineFor(ctx)
      const home = await this.#homeOf(machine.ssh)
      ssh = machine.ssh
      occPath = `${home}/${machine.repoRel}/dist/cli-node.js`
      describe = `${machine.label} (节点夹具)`
    } else {
      const host =
        this.#config.hosts[this.#execHostCursor++ % this.#config.hosts.length]
      if (host === undefined) throw new Error('舰队配置里一台机器都没有')
      ssh = host.ssh
      occPath = host.occPath
      describe = `${host.ssh} (${host.node})`
    }

    const root = await this.#scratch(ctx, ssh)
    return this.#execHostOn(ssh, occPath, `${root}/config`, `${root}/work`, {
      describe,
    })
  }

  /** 把「在某台机器的某个配置根下跑 `qm`」包成一个 {@link ExecHost}。 */
  #execHostOn(
    ssh: string,
    occPath: string,
    configDir: string,
    workdir: string,
    meta: { readonly describe: string },
  ): ExecHost {
    return {
      describe: meta.describe,
      configDir,
      workdir,
      exec: async (argv, opts) => {
        const env = Object.entries(opts?.env ?? {})
          .map(([k, v]) => `${k}='${shellQuote(v)}' `)
          .join('')
        const quoted = argv.map(a => `'${shellQuote(a)}'`).join(' ')
        // 一条命令换一个配置根：一条签发链要同时用到工具根、对端身份根与
        // 将来那个节点自己的根，而它们本来就该在同一台机器的同一棵树里。
        const dir = opts?.configDir ?? configDir
        return await this.#ssh(
          ssh,
          [
            `PATH="$HOME/.bun/bin:$PATH" OCC_IDENTITY=qianmo OCC_CONFIG_DIR='${shellQuote(dir)}' ` +
              `${env}bun '${shellQuote(occPath)}' ${quoted}`,
          ],
          opts?.timeoutMs,
        )
      },
      run: async (argv, opts) => {
        const env = Object.entries(opts?.env ?? {})
          .map(([k, v]) => `${k}='${shellQuote(v)}' `)
          .join('')
        const quoted = argv.map(a => `'${shellQuote(a)}'`).join(' ')
        return await this.#ssh(
          ssh,
          [`PATH="$HOME/.bun/bin:$PATH" ${env}${quoted}`],
          opts?.timeoutMs,
        )
      },
      writeFile: async (relPath, content) => {
        const abs = `${workdir}/${relPath}`
        // 内容经 stdin 进去，不进命令行：链文件带引号与换行，拼进 argv 迟早出事。
        const written = await this.#ssh(
          ssh,
          [
            `mkdir -p -- "$(dirname -- '${shellQuote(abs)}')"`,
            `cat > '${shellQuote(abs)}'`,
          ],
          undefined,
          content,
        )
        if (written.code !== 0) {
          throw new Error(
            `在 ${ssh} 上写 ${relPath} 失败 (${written.code}): ${written.stderr.slice(0, 300)}`,
          )
        }
        return abs
      },
      mkdir: async relPath => {
        const abs = `${workdir}/${relPath}`
        await this.#ssh(ssh, [`mkdir -p -- '${shellQuote(abs)}'`])
        return abs
      },
      readFile: async pathOrRelPath => {
        const abs = pathOrRelPath.startsWith('/')
          ? pathOrRelPath
          : `${workdir}/${pathOrRelPath}`
        // `cat --` 而不是 `cat`：路径里的前导 `-` 否则会被当成参数。
        const probe = await this.#ssh(ssh, [
          `cat -- '${shellQuote(abs)}' 2>/dev/null || true`,
        ])
        return probe.stdout === '' ? undefined : probe.stdout
      },
      freePort: async () => await this.#freePortOn(ssh),
    }
  }

  /**
   * 一次性注册中心 —— **跑在 runner 进程里**，靠一条**反向**隧道让远端的控制台
   * 够得着。
   *
   * ## 为什么不在目标机上起一个
   *
   * 产品里**没有** `qm registry` 这条子命令；注册中心只经
   * `demo/lib/p81-registry.ts` 暴露，而那个脚本对本维度差两件事：`--register`
   * 至少要一条（于是名册里永远多一条会被周期性续租的登记，`租约到期即消失`
   * 那条当场证伪），以及没有 `--ttl`（那条场景要 3 s 的 TTL，默认 90 s 两轮
   * 等下来超过它自己的超时）。改那个脚本没用 —— 部署机上是**旧的那一份**。
   *
   * ## 那么真机腿的 `console/*` 到底测的是什么（不要含糊过去）
   *
   * 测的是**部署机上那个 `dist/cli-node.js console`**：它的命令行、banner、
   * token 三个入口、鉴权矩阵、`/v0/limits` 报的常量、唤醒白名单与签名唤醒的
   * 整条链路，全部在真机的内核与架构上跑。注册中心那一半仍是套件进程里的
   * `@qianmo/registry`（与本地腿同一份代码，同一个提交），只是隔着一条隧道。
   * 于是 `console/registry-lease-*` 两条在真机腿上**多验的是控制台那半边的
   * 代理**，租约语义那半边与本地腿等价 —— 这一点写在这里，免得报告把它读成
   * 「注册中心也在真机上验过了」。
   */
  async startRegistry(
    ctx: ScenarioContext,
    spec: RegistrySpec = {},
  ): Promise<AcceptanceRegistry> {
    const local = await startRegistry(ctx, spec)
    const machine = await this.#machineFor(ctx)
    const localPort = Number.parseInt(new URL(local.url).port, 10)
    const remotePort = await this.#freePortOn(machine.ssh)
    await this.#reverseTunnel(ctx, machine.ssh, remotePort, localPort)
    return {
      url: local.url,
      hostUrl: `http://127.0.0.1:${String(remotePort)}`,
      readState: local.readState,
    }
  }

  /**
   * 一次性控制台位：一次性根 + 一个 `start`，都落在本场景那台机器上。
   *
   * 与节点同机是**承重的**：控制台要按 `--wake-url` 拨到那个节点，而节点听
   * 在它自己的回环上。见 {@link FleetDriver.#machineFor}。
   */
  async consoleSlot(ctx: ScenarioContext): Promise<ConsoleSlot> {
    const machine = await this.#machineFor(ctx)
    const home = await this.#homeOf(machine.ssh)
    const occPath = `${home}/${machine.repoRel}/dist/cli-node.js`
    const root = await this.#scratch(ctx, machine.ssh)
    const configDir = `${root}/config`
    const workdir = `${root}/work`
    const base = this.#execHostOn(machine.ssh, occPath, configDir, workdir, {
      describe: `${machine.label} (一次性控制台)`,
    })
    return {
      ...base,
      start: async spec =>
        await this.#startConsole(ctx, machine, occPath, root, spec),
    }
  }

  async #startConsole(
    ctx: ScenarioContext,
    machine: SpawnMachine,
    occPath: string,
    root: string,
    spec: ConsoleSpec,
  ): Promise<AcceptanceConsole> {
    const configDir = `${root}/config`
    const remotePort = await this.#freePortOn(machine.ssh)
    const { argv, env: extraEnv } = consoleLaunch(spec, remotePort)
    const env: Record<string, string> = {
      OCC_IDENTITY: 'qianmo',
      OCC_CONFIG_DIR: configDir,
      ...extraEnv,
    }
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}='${shellQuote(v)}' `)
      .join('')
    const quoted = argv.map(a => `'${shellQuote(a)}'`).join(' ')
    const outLog = `${root}/console.out.log`
    const errLog = `${root}/console.err.log`
    const pidFile = `${root}/console.pid`

    // 清理**先登记再启动**。反过来的话，启动那一趟 ssh 自己抛出时（网络抖动、
    // 远端 OOM）就会留下一个没人管的控制台进程：它的 argv 里不一定带着一次性
    // 根（`--audit` 那类参数才带），所以 `#scratch` 的兜底清扫也够不着它。
    // 提前登记没有代价 —— pid 文件不存在时 `#killByPidFile` 直接返回。
    ctx.cleanup(async () => {
      await this.#killByPidFile(machine.ssh, pidFile)
    })

    await this.#ssh(
      machine.ssh,
      [
        `set -e`,
        `: > '${shellQuote(outLog)}'`,
        `: > '${shellQuote(errLog)}'`,
        `PATH="$HOME/.bun/bin:$PATH" ${envPrefix}setsid bun '${shellQuote(occPath)}' ${quoted} ` +
          `>'${shellQuote(outLog)}' 2>'${shellQuote(errLog)}' </dev/null &`,
        `p=$!`,
        `printf '%s\\n' "$p" > '${shellQuote(pidFile)}'`,
        // banner 里带着两枚 token，所以判据是 `admin-token` 那一行落地 ——
        // 与本地腿同一条。轮询放在远端，理由同一次性节点那里。
        `for _ in $(seq 1 120); do`,
        `  if grep -q 'admin-token' '${shellQuote(outLog)}'; then break; fi`,
        `  if ! kill -0 "$p" 2>/dev/null; then break; fi`,
        `  sleep 0.5`,
        `done`,
      ],
      120_000,
    )

    const readOut = async (): Promise<string> =>
      (
        await this.#ssh(machine.ssh, [
          `cat '${shellQuote(outLog)}' 2>/dev/null || true`,
        ])
      ).stdout
    const readErr = async (): Promise<string> =>
      (
        await this.#ssh(machine.ssh, [
          `cat '${shellQuote(errLog)}' 2>/dev/null || true`,
        ])
      ).stdout

    const banner = await readOut()
    if (!banner.includes('admin-token')) {
      throw new Error(
        `一次性控制台在 ${machine.label} 上没有起来\n` +
          `stdout:\n${banner}\nstderr:\n${(await readErr()).slice(0, 1_500)}`,
      )
    }

    const localPort = await this.#tunnel(ctx, machine.ssh, remotePort)
    const url = `http://127.0.0.1:${String(localPort)}`
    // 就绪判据是 `GET /v0/health` 答 200 —— 公开、零鉴权，`systemctl --user
    // is-active` 对这两个单元都不可信（`Type=oneshot` + 只 enable 不 start，
    // 实测进程活着而单元报 inactive）。这里同时也在等隧道预热。
    const deadline = Date.now() + DISPOSABLE_READY_BUDGET_MS * ctx.timeoutScale
    for (;;) {
      if ((await http(`${url}/v0/health`, { timeoutMs: 5_000 })).status === 200)
        break
      if (ctx.signal.aborted || Date.now() >= deadline) {
        throw new Error(
          `一次性控制台在 ${machine.label} 上起来了但 /v0/health 不答 200 ` +
            `(${url} → ${machine.ssh}:${String(remotePort)})\n` +
            `stderr:\n${(await readErr()).slice(0, 1_500)}`,
        )
      }
      await sleep(400)
    }

    const { viewToken, adminToken } = tokensFromBanner(banner, spec)
    return {
      url,
      viewToken,
      adminToken,
      configRoot: configDir,
      banner: readOut,
      stderr: readErr,
    }
  }

  async #killByPidFile(ssh: string, pidFile: string): Promise<void> {
    await this.#ssh(ssh, [
      `p="$(cat '${shellQuote(pidFile)}' 2>/dev/null || echo)"`,
      `[ -n "$p" ] || exit 0`,
      `kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true`,
      `for _ in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done`,
      `kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true`,
    ])
  }

  /**
   * 真机的启动器位：跑**那台机器上部署好的**那一份脚本。
   *
   * 「用哪份脚本」这个选择与它的代价写在 {@link LauncherHost} 的头注上 ——
   * 那不是实现细节，是这一维在真机腿上到底回答了什么问题。
   *
   * `betaRoot` 与 `workdir` 都在一次性根下，所以脚本写出来的 `run/*.pid`、
   * `logs/*`、`peers.conf` 一律落在那儿，**碰不到 `~/qianmo-beta`**。
   */
  async launcherHost(ctx: ScenarioContext): Promise<LauncherHost> {
    const machine = await this.#machineFor(ctx)
    const home = await this.#homeOf(machine.ssh)
    const root = await this.#scratch(ctx, machine.ssh)
    const betaRoot = `${root}/beta-root`
    const workdir = `${root}/work`
    await this.#ssh(machine.ssh, [
      `mkdir -p '${shellQuote(betaRoot)}/run' '${shellQuote(betaRoot)}/logs'`,
    ])
    const ssh = machine.ssh
    return {
      describe: machine.label,
      repoDir: `${home}/${machine.repoRel}`,
      betaRoot,
      workdir,
      writeFile: async (relPath, content, options) => {
        const abs = `${workdir}/${relPath}`
        const written = await this.#ssh(
          ssh,
          [
            `mkdir -p -- "$(dirname -- '${shellQuote(abs)}')"`,
            `cat > '${shellQuote(abs)}'`,
            ...(options?.mode === undefined
              ? []
              : [`chmod ${options.mode} -- '${shellQuote(abs)}'`]),
          ],
          undefined,
          content,
        )
        if (written.code !== 0) {
          throw new Error(
            `在 ${ssh} 上写 ${relPath} 失败 (${written.code}): ${written.stderr.slice(0, 300)}`,
          )
        }
        return abs
      },
      run: async (argv, options) => {
        const env = Object.entries(options?.env ?? {})
          .map(([k, v]) => `${k}='${shellQuote(v)}' `)
          .join('')
        const quoted = argv.map(a => `'${shellQuote(a)}'`).join(' ')
        return await this.#ssh(ssh, [`${env}${quoted}`], options?.timeoutMs)
      },
      exists: async absPath =>
        (
          await this.#ssh(ssh, [
            `test -e '${shellQuote(absPath)}' && echo yes || echo no`,
          ])
        ).stdout.includes('yes'),
      readFile: async absPath => {
        const probe = await this.#ssh(ssh, [
          `cat -- '${shellQuote(absPath)}' 2>/dev/null || true`,
        ])
        return probe.stdout === '' ? undefined : probe.stdout
      },
    }
  }

  /**
   * 本场景的**落机**：第一次要机器的时候按轮转挑一台，之后同一场景一律用它。
   *
   * 钉在场景上而不是每次现挑，是因为一次性进程之间要互相够得着：控制台按
   * `--wake-url` 拨节点、拨的是节点自己那台机器的回环口。分散到两台机器上，
   * 唤醒维度那几条会以「拨不通」的形态红 —— 而那条红读起来像产品坏了。
   *
   * 轮转仍在（键是场景），所以整轮下来四台机器都覆盖得到。
   */
  async #machineFor(ctx: ScenarioContext): Promise<SpawnMachine> {
    const pinned = this.#machines.get(ctx)
    if (pinned !== undefined) return pinned
    const machines = this.#config.spawnMachines
    const machine = machines[this.#spawnCursor++ % machines.length]
    if (machine === undefined) {
      throw new Error('没有可承载一次性进程的舰队机器')
    }
    this.#machines.set(ctx, machine)
    return machine
  }

  /**
   * 从目标机回到 runner 的一条端口转发（`ssh -R`）。
   *
   * 注册中心跑在 runner 上，而控制台在目标机上 —— 没有它那条 `--registry`
   * 指的就是目标机自己的一个空端口。
   */
  async #reverseTunnel(
    ctx: ScenarioContext,
    ssh: string,
    remotePort: number,
    localPort: number,
  ): Promise<void> {
    const child = Bun.spawn(
      [
        'ssh',
        '-N',
        '-o',
        'BatchMode=yes',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=15',
        ...(this.#config.sshArgs ?? []),
        '-R',
        `${String(remotePort)}:127.0.0.1:${String(localPort)}`,
        ssh,
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    )
    void drain(child.stdout)
    void drain(child.stderr)
    ctx.cleanup(() => {
      child.kill('SIGKILL')
    })
    // 反向隧道要等它真的通：控制台一起来就会去打注册中心，早一步起等于让
    // 它在第一次请求上拿到 ECONNREFUSED。这里用一次远端 curl 确认。
    const deadline =
      Date.now() + REVERSE_TUNNEL_READY_BUDGET_MS * ctx.timeoutScale
    for (;;) {
      const probe = await this.#ssh(ssh, [
        `curl -s -o /dev/null -w '%{http_code}' -m 3 ` +
          `http://127.0.0.1:${String(remotePort)}/v0/agents 2>/dev/null || echo 000`,
      ])
      if (/[1-5]\d\d/.test(probe.stdout.trim())) return
      if (ctx.signal.aborted || Date.now() >= deadline) {
        throw new Error(
          `到 ${ssh} 的反向隧道 ${String(remotePort)}→${String(localPort)} 没通：${probe.stdout.trim()}`,
        )
      }
      await sleep(500)
    }
  }

  /**
   * 在目标机上开一层一次性目录（`config/` 与 `work/`），跑完 `rm -rf`。
   *
   * `rm -rf` 的路径由 `mktemp -d` 自己回显、且删之前**再确认一次**它带着
   * {@link SCRATCH_PREFIX} —— 拼一个可能为空的变量再 `rm -rf` 是这类脚本最
   * 经典的事故形态。清理挂 `ctx.cleanup`，超时路径也会跑到。
   */
  async #scratch(ctx: ScenarioContext, ssh: string): Promise<string> {
    const made = await this.#ssh(ssh, [
      `set -e`,
      `mkdir -p "$HOME/${SCRATCH_PREFIX}"`,
      `d="$(mktemp -d "$HOME/${SCRATCH_PREFIX}/run.XXXXXXXX")"`,
      `mkdir -p "$d/config" "$d/work"`,
      `printf '%s\n' "$d"`,
    ])
    const root = made.stdout.trim()
    if (made.code !== 0 || !root.includes(SCRATCH_PREFIX)) {
      throw new Error(
        `在 ${ssh} 上开一次性目录失败 (${made.code}): ${made.stderr.slice(0, 400)}`,
      )
    }
    ctx.cleanup(async () => {
      if (!root.includes(SCRATCH_PREFIX)) return
      // 删之前先兜一次底：把任何 argv 里带着这个一次性根的进程连同它的进程组
      // 收掉。正常路径上 `#launchDisposable` 自己那条清理已经杀过了，这一层
      // 防的是「进程起来了但登记清理之前那一步抛了」——那种漏网进程会一直往
      // 一个刚被 `rm -rf` 的目录里写，把它自己的配置目录重新造出来。
      //
      // `run[.]xxx` 的方括号是那个老把戏：跑这条命令的 shell 自己的命令行里
      // 有 `run[.]xxx` 这串字面量，它**不匹配**这个正则，所以 pkill 不会打到
      // 自己的父进程头上（打到了的话后面的 rm 就不会执行）。
      const id = root.slice(root.lastIndexOf('/') + 1).replace('.', '[.]')
      // **清扫与删除必须是两条独立的远端命令。** 合成一条的话，那条命令行里
      // 同时有 `rm -rf -- '…/run.XXXX'` 这个**没加方括号**的字面量，于是
      // `pgrep -f 'run[.]XXXX'` 把跑着它的那个 shell 自己也匹配上，for 循环
      // 当场把自己的进程组杀掉 —— 结果是进程确实清干净了，而后面那句 rm
      // 一次都没执行过。现场是「每台机器上留着一个只含 config/ 的空目录」，
      // 而 `rm` 那一行看起来完全正确。这个坑踩过一次，别把它合回去。
      await this.#ssh(ssh, [
        `for p in $(pgrep -f '${id}' 2>/dev/null); do`,
        `  kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true`,
        `done`,
        `sleep 0.5`,
        `for p in $(pgrep -f '${id}' 2>/dev/null); do`,
        `  kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true`,
        `done`,
      ])
      await this.#ssh(ssh, [`rm -rf -- '${shellQuote(root)}'`])
    })
    return root
  }

  /** 目标机的家目录（p12 是 `/root`，其余是 `/home/cornna`）。一台问一次。 */
  async #homeOf(ssh: string): Promise<string> {
    const cached = this.#homes.get(ssh)
    if (cached !== undefined) return await cached
    const pending = (async () => {
      const probe = await this.#ssh(ssh, [`printf '%s\n' "$HOME"`])
      const home = probe.stdout.trim()
      if (probe.code !== 0 || !home.startsWith('/')) {
        throw new Error(
          `问不出 ${ssh} 的家目录 (${probe.code}): ${probe.stderr.slice(0, 300)}`,
        )
      }
      return home
    })()
    this.#homes.set(ssh, pending)
    return await pending
  }

  /**
   * 从 runner 到目标机的一条端口转发，生命周期挂在场景上。
   *
   * 两条流都要抽干：经 IAP 的那台每次连接都往 stderr 写几行提示，管道写满
   * 之后 ssh 会阻塞在 `write` 上，表现是「隧道建着建着就不转发了」。
   */
  async #tunnel(
    ctx: ScenarioContext,
    ssh: string,
    remotePort: number,
  ): Promise<number> {
    const localPort = await ctx.allocPort()
    const child = Bun.spawn(
      [
        'ssh',
        '-N',
        '-o',
        'BatchMode=yes',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=15',
        ...(this.#config.sshArgs ?? []),
        '-L',
        `${String(localPort)}:127.0.0.1:${String(remotePort)}`,
        ssh,
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    )
    void drain(child.stdout)
    void drain(child.stderr)
    ctx.cleanup(() => {
      child.kill('SIGKILL')
    })
    return localPort
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
    // 先取「控制台申报了什么」与目标机的钟；每台节点的单元状态与文件在下面
    // 各自一趟（systemctl 的实例名与镜像路径都要按节点拼，合不成一条）。
    const declared = await this.#ssh(consoleHost, [
      // 申报是成对的 `--audit <n>=<路径>` / `--audit-mirror <n>=<分钟>`，从
      // **跑着的控制台**的命令行上读 —— 那条命令行才是真源，抄一份进套件只会
      // 在部署改了之后开始说谎。
      //
      // `|| true` 是必须的：grep 一条都没匹配上时退出 1，而「一条申报都没有」
      // 是这条链路的一种**观察**（下面走 skip 分支），不是采集失败。少了它，
      // 「没部署镜像」会被报成「读不到搬运现场」。
      // `--port` 一起捞：它是下面那次健康检查的地址来源，比写死 38621 稳
      // （改部署这边不会红，只会开始说谎）。
      `ps -eo args | grep -oE -- '--(audit(-mirror)?|port) [^ ]+' | sort -u || true`,
      // 同一趟 ssh 里问一次健康。零额外往返，而它把「一条申报都没有」拆成
      // 「控制台活着但没配镜像」与「控制台没在跑」两件事。
      `p="$(ps -eo args | grep -oE -- 'cli-node.js console .*--port [0-9]+' | grep -oE -- '--port [0-9]+' | head -1 | awk '{print $2}')"`,
      `printf 'console-port=%s\n' "$p"`,
      `if [ -n "$p" ]; then printf 'console-health=%s\n' "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$p/v0/health" 2>/dev/null || echo 000)"; fi`,
    ])
    if (declared.code !== 0) {
      return {
        consoleHost,
        units: [],
        failure: `读控制台申报失败 (${declared.code}): ${declared.stderr.slice(0, 400)}`,
      }
    }
    const declaredLines = declared.stdout.split('\n')
    const paths = new Map<string, string>()
    const lags = new Map<string, number>()
    for (const line of declaredLines) {
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
      const probe = await this.#ssh(consoleHost, [
        // 钟**在这一趟里取**，与 systemctl / stat 读到的是同一个时刻。取一次
        // 放在整轮采集开头会让后取的那几台算出负的「距今」—— 负值又恰好能
        // 无条件通过「≤ 上限」，于是这条断言在最需要它的方向上是瞎的。
        `printf 'observed-at=%s\n' "$(date +%s)"`,
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
          : await this.#ssh(host.ssh, [
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
        ...pick('observedAtSec', intField(probe.stdout, 'observed-at')),
        raw: `${probe.stdout}\n${authority.stdout}`.trim(),
      })
    }
    return {
      consoleHost,
      units,
      ...pick('consolePort', intField(declared.stdout, 'console-port')),
      ...pick(
        'consoleHealthStatus',
        intField(declared.stdout, 'console-health'),
      ),
    }
  }

  /**
   * 目标机上找一个此刻没人在听的高位端口。
   *
   * 用 `ss` 的全量快照做差集而不是逐个口去问：一次 SSH 往返就够，而逐个问是
   * 每个候选一次往返。答不出来是**错误**，不是随便回一个 —— 回一个碰巧被占的
   * 口会让「不可达」那条场景红得毫无道理。
   */
  async #freePortOn(ssh: string): Promise<number> {
    const probe = await this.#ssh(ssh, [
      `ss -H -ltn 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -u`,
    ])
    if (probe.code !== 0) {
      throw new Error(
        `在 ${ssh} 上取监听端口表失败 (${probe.code}): ${probe.stderr.slice(0, 300)}`,
      )
    }
    const busy = new Set(probe.stdout.split('\n').map(l => l.trim()))
    for (let i = 0; i < 200; i += 1) {
      const port = 41_000 + Math.floor(Math.random() * 4_000)
      if (!busy.has(String(port))) return port
    }
    throw new Error(`在 ${ssh} 上 200 次都没抽到空闲端口`)
  }

  async #tail(host: FleetHost, stream: 'out' | 'err'): Promise<string> {
    const result = await this.#ssh(host.ssh, [
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
    ssh: string,
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
        ssh,
        lines.join('\n'),
      ],
      {
        stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    // 计时器必须**在等两条流之前**装上：远端挂住时 `.text()` 就已经不返回了，
    // 装在它们后面等于这个超时永远没有机会开始计时。
    let timedOut = false
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
          }, timeoutMs)
    let stdout: string
    let stderr: string
    let code: number
    try {
      ;[stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      code = await child.exited
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    return {
      code,
      stdout,
      stderr: timedOut
        ? `${stderr}\n[acceptance] ssh ${ssh} 超时 ${String(timeoutMs)}ms，已 SIGKILL`
        : stderr,
    }
  }
}

/**
 * 「这个句柄是一次性节点吗」的守门人。
 *
 * 每一个**会改动目标状态**的方法都先过它。附着来的那台是内测在用的节点：
 * 停它会断掉使用者，写它的配置根会在成果边界证据里留下没人解释得清的记录。
 * 抛出的话必须说清是哪一件事被拒绝了 —— 一句「不支持」会让人以为是没实现。
 */
function requireDisposable(node: NodeHandle, what: string): DisposableNode {
  const disposable = (node as FleetNodeHandle).disposable
  if (disposable === undefined) {
    throw new Error(
      `FleetDriver 不${what}附着来的内测节点 ${node.name}：那会打断内测使用者，` +
        `也会在那条节点的审计链上留下一次计划外记录。只有一次性节点（spawn-node）允许这么做`,
    )
  }
  return disposable
}

/** 把一条流读干净并丢掉 —— 只为让写它的那一端不被管道憋住。 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
  } catch {
    // 进程被 kill 时流以异常收场，那不是观察结果。
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
  // 一次性进程落在哪几台机器上：`QIANMO_ACCEPTANCE_SPAWN_HOSTS` 逗号分隔的
  // SSH 目标；置空 = 这一轮不起任何一次性进程（`spawn-node` 等能力随之消失，
  // 靠它们的场景如实 skip）。不给就用默认表 —— 那张表**刻意不含 cornna-p12**，
  // 理由见文件头。
  const spawnRaw = process.env.QIANMO_ACCEPTANCE_SPAWN_HOSTS
  const spawnMachines =
    spawnRaw === undefined
      ? DEFAULT_SPAWN_MACHINES
      : spawnRaw
          .split(',')
          .map(name => name.trim())
          .filter(name => name !== '')
          .map(
            name =>
              DEFAULT_SPAWN_MACHINES.find(m => m.ssh === name) ?? {
                ssh: name,
                label: name,
                repoRel: 'atlas-beta',
              },
          )
  return {
    hosts,
    spawnMachines,
    psk,
    ...(consoleHostRaw === '' ? {} : { consoleHost: consoleHostRaw }),
  }
}
