// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 控制台的登记簿与续租者：页面上的「注册」活过租约（P15.2 的最小内核），以及
 * 建在它上面的生命周期——发布、暂停、恢复、退役（P15.2，`tenancy-m1.md` §3.6）。
 *
 * ## 缺陷
 *
 * 注册中心的租约是 `DEFAULT_TTL_MS`（90 s），过期条目从 `list()` / `resolve()`
 * 消失。控制台原先只有按需心跳（人点按钮才续），注册中心宿主
 * （`demo/lib/p81-registry.ts`）只替启动参数里的 `--register` 续租，节点从不拨号。
 * 于是页面上注册成功的条目没有任何续租方，90 s 后就不在名册里了。
 *
 * ## 续租者为什么住在控制台进程里
 *
 * P15 草案（`tenancy-m1.md` §3.6，v0.1-draft）写的是「续租者住在注册中心进程旁」。
 * 这里选了控制台，理由见 `docs/dev/console.md` §7.3，要点：
 *
 * - **意图归控制台。**「这条是页面上注册的、要一直在」是 admin token 背后的一个
 *   决定；注册中心零鉴权（console.md §8.2），把这份意图放到它那边，就是让任何够得着
 *   它端口的人一次 POST 就能造出一条永不过期的登记。
 * - **注册中心 HTTP v0 零改动。**注册中心侧的续租者要知道哪些条目是控制台注册的，
 *   只能加字段 / 加路由，或者两个进程共享一个文件（内测里两者配置根不同）。放在控制台
 *   就只用既有的 `POST /v0/agents`，新控制台配旧注册中心照样全功能。
 * - **控制台是产品面，注册中心宿主不是。**没有 `qm registry` 子命令，宿主只是 demo
 *   脚本；而验收腿的注册中心本来就是进程内的 `startRegistryServer`，续租者在控制台里
 *   才会被真实路径覆盖。
 *
 * 代价：控制台停机超过一个 TTL，它登记的条目按租约消失，直到控制台回来（启动即重新
 * 宣告）。`--register` 那批种子由注册中心宿主续，不受影响。
 *
 * ## 续租用 `POST /v0/agents`，不用心跳
 *
 * 每一轮把登记簿里每条 `active` 的整条声明原样再注册一次：
 *
 * - 同一端点 → 200，等于续租，同时把能力 / 状态重新声明一遍；
 * - 注册中心刚重启、表上没有 → 201，条目回来；
 * - 地址被**另一个端点**占着 → 409，注册中心什么都不改。续租者不抢（与
 *   `register()` 防劫持同一条规矩），只出声、下一轮再试。
 *
 * 心跳做不到第三条：它不看端点，会替占着这个地址的别人续租。
 *
 * ## 周期
 *
 * `renewIntervalFor(租约)`（`@qianmo/registry`）：默认租约下 20 s，与
 * `p81-registry.ts` 同一个出处。租约取注册中心回执里的 `expiresAt − lastHeartbeatAt`
 * （`rosterLease`，C-1 那条「以注册中心为准」），没有回执时用 `DEFAULT_TTL_MS`。
 * 租约变短时下一轮提前，不会让新登记的一条在第一次续租之前就过期。
 *
 * ## 生命周期
 *
 * 每条带 `state`（active / paused / retired）与最近一次改它的主体与时刻。
 * `paused` 与 `retired` 不续租，注册中心那条立即 `DELETE`；真正挡住流量的是三个
 * 出口在拨号前的检查（{@link ConsoleRegistrations.exitRefusal}、`qm watch` 读同一
 * 个文件）。给了托管清单（`--managed`）时，发布与恢复只认清单里的地址，端点从
 * 清单取。退役的地址不再发布；暂停的地址要用恢复。
 *
 * ## 落盘，与读不出来时
 *
 * 路径由 `consoleArgs.ts` 从 `occConfigPath()` 派生；写入复用 `FileRegistryStore`
 * （同目录临时文件 `wx` 创建 + fsync + rename，P2.1）。文档形状见
 * `consoleRegistrationLedger.ts`。
 *
 * 这是**意图**而不是软状态，所以读不出来时**不从空登记簿起**：那会把退役的地址
 * 重新放出去。坏 JSON / 版本不对的文件照旧改名挪开（`.unreadable-<ISO>`）留证，
 * 权限与 IO 错误原地不动；无论哪种，本进程从此不发布、不恢复、不写盘，三个出口
 * 一律不拨，stderr 告警，之后有请求被拒时每分钟最多再报一次。重启后仍是这样，
 * 直到运维放回修好的文件，或把挪开的那份移出目录。
 *
 * 写失败不让那一次请求失败——它在本进程里已经生效——但此后不再接受发布与恢复：
 * 写不进去的暂停在重启后会丢，不能再叠更多放宽的变更上去。
 */

import { renameSync } from 'node:fs'
import {
  rosterLease,
  type ConsoleAgent,
  type ConsoleFailure,
  type ConsoleResult,
  type LifecycleChange,
  type LifecycleOutcome,
  type LifecyclePort,
  type LifecycleRefusal,
  type LifecycleSnapshot,
  type PublishInput,
  type RegisterAgentInput,
  type RegistrationRecord,
  type RegistrationState,
  type RegistryPort,
  type WakePort,
} from '@qianmo/console'
import {
  DEFAULT_TTL_MS,
  FileRegistryStore,
  renewIntervalFor,
} from '@qianmo/registry'
import {
  UNREADABLE_SUFFIX,
  exitFailureOf,
  exitRefusalOf,
  ledgerDocument,
  ledgerProblemOf,
  readRegistrationLedger,
  type LedgerEntry,
} from './consoleRegistrationLedger.js'

export { REGISTRATION_LEDGER_VERSION } from './consoleRegistrationLedger.js'

/** stderr 行的前缀，与 `console chat:` 同一个写法。 */
const LOG_PREFIX = 'console registrations:'

/** 读不出来之后，本进程不做的事。 */
const CLOSED =
  'publishing and resuming are refused, and chat, wake and qm watch reach no agent, until the ledger is repaired and this console restarts'

/** 被拒的请求再提醒一次的最短间隔，与账号库同一个数（`AccountBook`）。 */
const REMIND_EVERY_MS = 60_000

/** 一轮续租里一条地址的结果。 */
type RenewOutcome =
  | { readonly kind: 'renewed'; readonly address: string }
  /** 这一轮在路上时它被注销或暂停了；续租那次 POST 可能把它建了回来，已补一次 DELETE。 */
  | { readonly kind: 'withdrawn'; readonly address: string }
  | {
      readonly kind: 'failed'
      readonly address: string
      readonly failure: ConsoleFailure
    }

/** 排一次延时任务，返回取消函数。测试换成手动触发的那一个。 */
export type RenewScheduler = (
  task: () => Promise<void>,
  delayMs: number,
) => () => void

/** 托管清单里的一条：`peers.conf` 的地址行。 */
interface ManagedAddress {
  readonly address: string
  readonly endpoint: string
}

interface ConsoleRegistrationsOptions {
  /** 登记簿的绝对路径（`consoleRegistrationsPath()`）。 */
  readonly path: string
  /** 注册中心 HTTP v0 那个端口（`createRegistryPort`）。 */
  readonly registry: RegistryPort
  /**
   * 托管清单（`--managed`）。给了，发布与恢复只认清单里的地址、端点从清单取；
   * 不给就不查（与 P15.8 的写 token 同一个先例：可选，`beta-up.sh` 总是给）。
   */
  readonly managed?: readonly ManagedAddress[]
  readonly schedule?: RenewScheduler
  /** 出声的地方；生产是 stderr。 */
  readonly log?: (line: string) => void
  /** 排「下一轮什么时候」、给挪开的文件起名、给状态变更记时刻。 */
  readonly now?: () => number
}

/** 登记簿为什么不能用：读不出来（谁都不拨），或写不进去（内存仍完整）。 */
interface LedgerProblem {
  readonly kind: 'unreadable' | 'unwritable'
  readonly text: string
}

const defaultSchedule: RenewScheduler = (task, delayMs) => {
  const timer = setTimeout(() => void task(), delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 页面给的那份输入，地址换成注册中心回执里的规范写法。 */
function declarationOf(
  input: RegisterAgentInput,
  address: string,
): RegisterAgentInput {
  return {
    address,
    endpoint: input.endpoint,
    ...(input.capabilities === undefined
      ? {}
      : { capabilities: [...input.capabilities] }),
    ...(input.publicKey === undefined ? {} : { publicKey: input.publicKey }),
    ...(input.status === undefined ? {} : { status: input.status }),
  }
}

/** `ws://h:p` 与 `ws://h:p/` 是同一个端点；解析不了就按原文比。 */
function sameEndpoint(a: string, b: string): boolean {
  try {
    return new URL(a).toString() === new URL(b).toString()
  } catch {
    return a.trim() === b.trim()
  }
}

function refuse(
  code: LifecycleRefusal['code'],
  message: string,
): { readonly ok: false; readonly refusal: LifecycleRefusal } {
  return { ok: false, refusal: { code, message } }
}

function unmanaged(address: string): LifecycleRefusal {
  return {
    code: 'unmanaged',
    message: `${address} 不在托管清单里 · 托管清单来自中枢 peers.conf 的地址行`,
  }
}

/** 本地拒绝换成端口失败的形状，给不认识生命周期的 `RegistryPort` 调用方。 */
function failureOf(refusal: LifecycleRefusal): ConsoleFailure {
  switch (refusal.code) {
    case 'invalid':
      return { code: 'invalid', message: refusal.message }
    case 'not_found':
      return { code: 'not_found', message: refusal.message }
    default:
      return { code: 'rejected', message: refusal.message }
  }
}

const STATE_WORDS: Readonly<Record<RegistrationState, string>> = {
  active: '已发布',
  paused: '已暂停',
  retired: '已退役',
}

/** 唤醒端口外面那一层：地址暂停、退役或登记簿读不出来时，一次都不发。 */
export function gateWakePort(
  port: WakePort,
  gate: (address: string) => ConsoleFailure | null,
): WakePort {
  return {
    send: async input => {
      const refused = gate(input.to)
      return refused === null
        ? await port.send(input)
        : { ok: false, failure: refused }
    },
  }
}

/**
 * 登记簿 + 续租者 + 生命周期。`port` 交给 `ConsoleDeps.registry`，`lifecycle`
 * 交给 `ConsoleDeps.lifecycle`，`start()` 之后开始续租。
 */
export class ConsoleRegistrations {
  /** 包在注册中心端口外的那一层：注册成功入簿，注销先出簿，其余透传。 */
  readonly port: RegistryPort
  /** 生命周期的四个动作与读面（`deps.ts` 的 `LifecyclePort`）。 */
  readonly lifecycle: LifecyclePort

  readonly #path: string
  readonly #store: FileRegistryStore
  readonly #registry: RegistryPort
  readonly #managed: ReadonlyMap<string, string> | null
  readonly #schedule: RenewScheduler
  readonly #log: (line: string) => void
  readonly #now: () => number
  readonly #entries = new Map<string, LedgerEntry>()
  /** 每条地址最近一次失败的原文，只为「状态变了才出声」。 */
  readonly #failing = new Map<string, string>()
  #problem: LedgerProblem | null = null
  #lastAlarmAt = Number.NEGATIVE_INFINITY
  #leaseMs = DEFAULT_TTL_MS
  #running = false
  #cancel: (() => void) | null = null
  /** 已排上的下一轮的时刻；一轮在路上时为 null。 */
  #dueAt: number | null = null

  constructor(options: ConsoleRegistrationsOptions) {
    this.#path = options.path
    this.#store = new FileRegistryStore(options.path)
    this.#registry = options.registry
    this.#managed =
      options.managed === undefined
        ? null
        : new Map(options.managed.map(item => [item.address, item.endpoint]))
    this.#schedule = options.schedule ?? defaultSchedule
    this.#log = options.log ?? (() => {})
    this.#now = options.now ?? Date.now
    this.#load()
    this.port = {
      list: async () => await this.#registry.list(),
      register: async input => await this.#register(input),
      deregister: async address => await this.#deregister(address),
      heartbeat: async address => await this.#heartbeat(address),
    }
    this.lifecycle = {
      read: async () => this.#snapshot(),
      publish: async (input, by) => await this.#publish(input, by),
      pause: async (address, by) => await this.#withdraw(address, 'paused', by),
      resume: async (address, by) => await this.#resume(address, by),
      retire: async (address, by) =>
        await this.#withdraw(address, 'retired', by),
    }
  }

  /** 登记簿文件。进 banner，不是秘密。 */
  get path(): string {
    return this.#path
  }

  /** 登记簿里在续租的（`active`）地址，排好序。 */
  get addresses(): readonly string[] {
    return [...this.#entries.values()]
      .filter(entry => entry.state === 'active')
      .map(entry => entry.declaration.address)
      .sort()
  }

  /** 现在按哪个租约排续租。 */
  get leaseMs(): number {
    return this.#leaseMs
  }

  /** `null` 表示可用；否则是读不出来或写不进去的原因。 */
  get problem(): string | null {
    return this.#problem?.text ?? null
  }

  /** 启动横幅的那一行。 */
  get summary(): string {
    const count = (state: RegistrationState): number =>
      [...this.#entries.values()].filter(entry => entry.state === state).length
    const managed =
      this.#managed === null
        ? 'managed list off (no --managed)'
        : `managed list ${String(this.#managed.size)} addresses`
    return (
      `${this.#path} (${String(count('active'))} renewed by this console, ` +
      `${String(count('paused'))} paused, ${String(count('retired'))} retired; ${managed})` +
      (this.#problem === null ? '' : ` UNAVAILABLE: ${this.#problem.text}`)
    )
  }

  /**
   * 出口检查：对话、唤醒在拨号之前问这一句。`null` 放行；否则是 `rejected`，
   * 原因写在文案里。登记簿读不出来时谁都不放行。
   */
  exitRefusal(address: string): ConsoleFailure | null {
    const unreadable =
      this.#problem?.kind === 'unreadable' ? this.#problem.text : null
    const refusal = exitRefusalOf(
      unreadable,
      this.#entries.get(address),
      address,
    )
    if (refusal === null) return null
    if (refusal.reason === 'unreadable') this.#remind()
    return exitFailureOf(refusal)
  }

  /** 立刻续一轮，之后按周期续，直到 {@link stop}。重复调用无副作用。 */
  start(): void {
    if (this.#running) return
    this.#running = true
    void this.#cycle()
  }

  /** 停止续租。已发出的租约照常到期；登记簿不动，下次启动接着续。 */
  stop(): void {
    this.#running = false
    this.#cancel?.()
    this.#cancel = null
    this.#dueAt = null
  }

  /** 对登记簿里每条 `active` 各重新声明一次。续租者的一轮；测试直接调它。 */
  async renewNow(): Promise<readonly RenewOutcome[]> {
    const declarations = [...this.#entries.values()]
      .filter(entry => entry.state === 'active')
      .map(entry => entry.declaration)
    return await Promise.all(
      declarations.map(declaration => this.#renewOne(declaration)),
    )
  }

  async #cycle(): Promise<void> {
    if (!this.#running) return
    this.#cancel = null
    this.#dueAt = null
    try {
      await this.renewNow()
    } catch (error) {
      // 端口按约定不抛；真抛了是编程错误，也不能让续租从此停掉。
      this.#log(`${LOG_PREFIX} renewal round failed: ${messageOf(error)}`)
    }
    this.#arm(renewIntervalFor(this.#leaseMs))
  }

  #arm(delayMs: number): void {
    if (!this.#running) return
    this.#cancel?.()
    this.#dueAt = this.#now() + delayMs
    this.#cancel = this.#schedule(async () => await this.#cycle(), delayMs)
  }

  async #renewOne(declaration: RegisterAgentInput): Promise<RenewOutcome> {
    const { address } = declaration
    const result = await this.#registry.register(declaration)
    if (!result.ok) {
      const text = `${result.failure.code}: ${result.failure.message}`
      if (this.#failing.get(address) !== text) {
        this.#failing.set(address, text)
        this.#log(`${LOG_PREFIX} renew ${address} failed (${text})`)
      }
      return { kind: 'failed', address, failure: result.failure }
    }
    this.#observeLease(result.value)
    if (this.#entries.get(address)?.state !== 'active') {
      // 注销、暂停、退役都是先改簿再发 DELETE，而这一轮的 POST 可能晚于那个
      // DELETE 到达注册中心，把条目又建了回来。这里看得见这件事，就在这里收掉。
      await this.#registry.deregister(address)
      return { kind: 'withdrawn', address }
    }
    if (this.#failing.delete(address)) {
      this.#log(`${LOG_PREFIX} renew ${address} recovered`)
    }
    return { kind: 'renewed', address }
  }

  // --- the registry port, as consumers without lifecycle see it ------------

  async #register(
    input: RegisterAgentInput,
  ): Promise<ConsoleResult<ConsoleAgent>> {
    const result = await this.#publish(input, undefined)
    if (result.ok) {
      const agent = result.value.agent
      if (agent !== undefined) return { ok: true, value: agent }
      return {
        ok: false,
        failure: { code: 'invalid', message: '注册中心没有给回执' },
      }
    }
    return 'refusal' in result
      ? { ok: false, failure: failureOf(result.refusal) }
      : result
  }

  async #deregister(address: string): Promise<ConsoleResult<void>> {
    const entry = this.#entries.get(address)
    // 先出簿：从这一刻起续租者不再碰它，哪怕下面的 DELETE 失败，租约也会自然到期。
    // 暂停与退役的条目留在簿里——注销不是恢复，状态不能借它抹掉。
    if (entry?.state === 'active') {
      this.#entries.delete(address)
      this.#failing.delete(address)
      this.#persist()
    }
    const result = await this.#registry.deregister(address)
    if (
      !result.ok &&
      entry !== undefined &&
      result.failure.code === 'not_found'
    ) {
      // 簿里有、表上没有（租约刚过期，或注册中心刚重启还没等到下一轮）：
      // 要做的事——不再续租——已经做成了，这不是「没找到」。
      return { ok: true, value: undefined }
    }
    return result
  }

  async #heartbeat(address: string): Promise<ConsoleResult<ConsoleAgent>> {
    if (this.#problem?.kind === 'unreadable') {
      this.#remind()
      return {
        ok: false,
        failure: {
          code: 'rejected',
          message: `登记簿读不出来，不替任何地址续租（${this.#problem.text}）`,
        },
      }
    }
    const state = this.#entries.get(address)?.state
    if (state === 'paused' || state === 'retired') {
      return {
        ok: false,
        failure: {
          code: 'rejected',
          message: `${address} ${STATE_WORDS[state]} · 不续租`,
        },
      }
    }
    const result = await this.#registry.heartbeat(address)
    if (result.ok) this.#observeLease(result.value)
    return result
  }

  // --- lifecycle -----------------------------------------------------------

  #snapshot(): LifecycleSnapshot {
    return {
      problem: this.#problem?.text ?? null,
      managed: this.#managed === null ? null : [...this.#managed.keys()].sort(),
      registrations: [...this.#entries.values()]
        .map(entry => this.#recordOf(entry))
        .sort((a, b) => (a.address < b.address ? -1 : 1)),
    }
  }

  #recordOf(entry: LedgerEntry): RegistrationRecord {
    const address = entry.declaration.address
    return {
      address,
      state: entry.state,
      ...(entry.by === undefined ? {} : { by: entry.by }),
      ...(entry.at === undefined ? {} : { at: entry.at }),
      ...(this.#managed === null
        ? {}
        : { managed: this.#managed.has(address) }),
    }
  }

  /** 会放宽什么的写（发布、恢复）在登记簿有毛病时一律拒。 */
  #closedForWidening(): LifecycleRefusal | null {
    if (this.#problem === null) return null
    this.#remind()
    return {
      code: 'unavailable',
      message: `登记簿不可用（${this.#problem.text}）· 发布与恢复暂停`,
    }
  }

  /** 有托管清单时：地址必须在里面，端点从清单取，给了别的就拒。 */
  #endpointFor(
    address: string,
    given: string | undefined,
  ): { readonly endpoint: string } | LifecycleRefusal {
    if (this.#managed === null) {
      if (given === undefined || given.trim() === '') {
        return { code: 'invalid', message: '字段 endpoint 必须是非空字符串' }
      }
      return { endpoint: given }
    }
    const managed = this.#managed.get(address)
    if (managed === undefined) return unmanaged(address)
    if (given !== undefined && given.trim() !== '') {
      if (!sameEndpoint(given, managed)) {
        return {
          code: 'invalid',
          message: `端点由中枢配置决定：${address} 是 ${managed}，不是 ${given}`,
        }
      }
    }
    return { endpoint: managed }
  }

  #stamp(by: string | undefined): { by?: string; at?: number } {
    return by === undefined ? {} : { by, at: this.#now() }
  }

  async #publish(
    input: PublishInput,
    by: string | undefined,
  ): Promise<LifecycleOutcome<LifecycleChange>> {
    const closed = this.#closedForWidening()
    if (closed !== null) return { ok: false, refusal: closed }
    const held = this.#entries.get(input.address)
    if (held?.state === 'retired') {
      return refuse('retired', `${input.address} 已退役 · 地址不再分配`)
    }
    if (held?.state === 'paused') {
      return refuse('paused', `${input.address} 已暂停 · 要重新放行请用恢复`)
    }
    const endpoint = this.#endpointFor(input.address, input.endpoint)
    if ('code' in endpoint) return { ok: false, refusal: endpoint }
    const declaration: RegisterAgentInput = {
      address: input.address,
      endpoint: endpoint.endpoint,
      ...(input.capabilities === undefined
        ? {}
        : { capabilities: input.capabilities }),
      ...(input.publicKey === undefined ? {} : { publicKey: input.publicKey }),
      ...(input.status === undefined ? {} : { status: input.status }),
    }
    const result = await this.#registry.register(declaration)
    // 只有注册中心收下的才入簿：被拒的、不可达的，页面上已经如实报错了。
    if (!result.ok) return { ok: false, failure: result.failure }
    const address = result.value.address
    const now = this.#entries.get(address)
    if (now !== undefined && now !== held && now.state !== 'active') {
      // 这次 POST 在路上时，别人把它暂停或退役了：那一个决定在后，收回这次发布。
      await this.#registry.deregister(address)
      return refuse(now.state, `${address} ${STATE_WORDS[now.state]}`)
    }
    const entry: LedgerEntry = {
      declaration: declarationOf(declaration, address),
      state: 'active',
      ...this.#stamp(by),
    }
    this.#entries.set(address, entry)
    this.#failing.delete(address)
    this.#persist()
    this.#observeLease(result.value)
    return {
      ok: true,
      value: { registration: this.#recordOf(entry), agent: result.value },
    }
  }

  async #resume(
    address: string,
    by: string,
  ): Promise<LifecycleOutcome<LifecycleChange>> {
    const closed = this.#closedForWidening()
    if (closed !== null) return { ok: false, refusal: closed }
    const held = this.#entries.get(address)
    if (held === undefined) {
      return refuse('not_found', `${address} 不在登记簿里 · 没有可恢复的`)
    }
    if (held.state === 'retired') {
      return refuse('retired', `${address} 已退役 · 地址不再分配`)
    }
    // 没有托管清单时沿用簿里那份端点；有清单时以清单为准（peers.conf 可能改过）。
    let declaration = held.declaration
    if (this.#managed !== null) {
      const managed = this.#managed.get(address)
      if (managed === undefined) {
        return { ok: false, refusal: unmanaged(address) }
      }
      declaration = { ...held.declaration, endpoint: managed }
    }
    const result = await this.#registry.register(declaration)
    if (!result.ok) return { ok: false, failure: result.failure }
    const now = this.#entries.get(address)
    if (now !== held && now !== undefined && now.state !== 'active') {
      await this.#registry.deregister(address)
      return refuse(now.state, `${address} ${STATE_WORDS[now.state]}`)
    }
    const entry: LedgerEntry = {
      declaration: declarationOf(declaration, address),
      state: 'active',
      ...this.#stamp(by),
    }
    this.#entries.set(address, entry)
    this.#failing.delete(address)
    this.#persist()
    this.#observeLease(result.value)
    return {
      ok: true,
      value: { registration: this.#recordOf(entry), agent: result.value },
    }
  }

  /**
   * 暂停与退役：先改簿（从这一刻起出口不拨、续租者不碰），再 `DELETE`。
   * `DELETE` 失败只出声：租约会自然到期，出口已经关上了。
   */
  async #withdraw(
    address: string,
    state: 'paused' | 'retired',
    by: string,
  ): Promise<LifecycleOutcome<LifecycleChange>> {
    if (this.#problem?.kind === 'unreadable') {
      this.#remind()
      // 读不出来时任何写盘都会盖掉那份证据；出口反正已经全关了。
      return refuse(
        'unavailable',
        `登记簿读不出来（${this.#problem.text}）· 不改任何一条`,
      )
    }
    const held = this.#entries.get(address)
    if (held?.state === 'retired') {
      if (state === 'retired') {
        return { ok: true, value: { registration: this.#recordOf(held) } }
      }
      return refuse('retired', `${address} 已退役`)
    }
    if (held?.state === state) {
      return { ok: true, value: { registration: this.#recordOf(held) } }
    }
    const managed = this.#managed?.get(address)
    const declaration =
      held?.declaration ??
      (managed === undefined ? undefined : { address, endpoint: managed })
    if (declaration === undefined) {
      return refuse('not_found', `${address} 不在登记簿里，也不在托管清单里`)
    }
    const entry: LedgerEntry = { declaration, state, by, at: this.#now() }
    this.#entries.set(address, entry)
    this.#failing.delete(address)
    this.#persist()
    const removed = await this.#registry.deregister(address)
    if (!removed.ok && removed.failure.code !== 'not_found') {
      this.#log(
        `${LOG_PREFIX} ${state === 'paused' ? 'pause' : 'retire'} ${address}: ` +
          `registry DELETE failed (${removed.failure.code}: ${removed.failure.message}); ` +
          'the lease runs out on its own, and the exits are already closed',
      )
    }
    return { ok: true, value: { registration: this.#recordOf(entry) } }
  }

  /** 按注册中心实际给的租约调周期；变短了就把已排上的那一轮提前。 */
  #observeLease(agent: ConsoleAgent): void {
    this.#leaseMs = rosterLease([agent], this.#leaseMs)
    const interval = renewIntervalFor(this.#leaseMs)
    if (this.#dueAt !== null && this.#now() + interval < this.#dueAt) {
      this.#arm(interval)
    }
  }

  // --- the file ------------------------------------------------------------

  #fail(kind: LedgerProblem['kind'], text: string, line: string): void {
    if (this.#problem === null || kind === 'unreadable') {
      this.#problem = { kind, text }
    }
    this.#lastAlarmAt = this.#now()
    this.#log(line)
  }

  /** 被拒的请求再提醒一次，每分钟最多一次：首次告警那一行没人会往回翻。 */
  #remind(): void {
    if (this.#problem === null) return
    const now = this.#now()
    if (now - this.#lastAlarmAt < REMIND_EVERY_MS) return
    this.#lastAlarmAt = now
    this.#log(
      `${LOG_PREFIX} ${this.#problem.text}; a request was refused because of it`,
    )
  }

  #load(): void {
    const read = readRegistrationLedger(this.#path)
    if (read.kind === 'ok' || read.kind === 'partial') {
      for (const entry of read.entries) {
        this.#entries.set(entry.declaration.address, entry)
      }
    }
    const problem = ledgerProblemOf(this.#path, read)
    if (problem === null) return
    if (read.kind !== 'malformed') {
      this.#fail('unreadable', problem, `${LOG_PREFIX} ${problem}; ${CLOSED}`)
      return
    }
    // 文档本身坏了：不当空文件覆盖，挪开留证。挪开之后同目录的那份就是
    // 「仍然读不出来」的记号，重启也不会从空登记簿起。
    const stamp = new Date(this.#now()).toISOString().replace(/[:.]/g, '-')
    const aside = `${this.#path}${UNREADABLE_SUFFIX}${stamp}`
    try {
      renameSync(this.#path, aside)
      this.#fail(
        'unreadable',
        `${problem}; moved to ${aside}`,
        `${LOG_PREFIX} ${problem}; moved to ${aside}; ${CLOSED}. ` +
          `Put a repaired ledger back at ${this.#path}, or move ${aside} out of that directory to start from an empty ledger.`,
      )
    } catch (error) {
      this.#fail(
        'unreadable',
        problem,
        `${LOG_PREFIX} ${problem} and could not be moved aside (${messageOf(error)}); ${CLOSED}`,
      )
    }
  }

  #persist(): void {
    // 读不出来的那份还在原处（或刚被挪开）：写一份新的就是拿内存里残缺的簿
    // 覆盖证据，重启后它会被当成完整的读回来。
    if (this.#problem?.kind === 'unreadable') return
    try {
      this.#store.write(ledgerDocument(this.#entries.values()))
    } catch (error) {
      const text = `could not write ${this.#path} (${messageOf(error)})`
      this.#fail(
        'unwritable',
        text,
        `${LOG_PREFIX} ${text}; this change holds until this console restarts, and publishing and resuming are refused until then`,
      )
    }
  }
}
