// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 网关页的「智能体」区块（P36.5，`harness-backends.md` §4）：每台节点上每个智能体
 * 跑在哪个底层、用哪个模型，节点装了哪些底层；以及新节点自动接入 magpie。
 *
 * ## 读
 *
 * 经控制链路问节点 `runtime.status` 与 `runtime.versions`（形状见
 * `host/runtimes/contract.ts`）。答不了 `runtime.status` 的节点（答 `unsupported`，
 * 或答的不是这个形状）就是没有 `runtimeCatalog` 能力的旧节点：照列，不给写控件。
 * 页面跟进作业时每 3 秒一读：`runtime.status` 缓存 3 秒；`runtime.versions` 只随
 * 装、卸、更新变，缓存 5 分钟，这几样写之后立即作废，节点自己报「安装中」时按
 * 3 秒跟。
 * 底层的名称、系列与线路一律取目录（`host/runtimes/catalog.ts`），这里不写死任何
 * 一个底层或系列。
 *
 * ## 按系列自动选模型
 *
 * 节点在它自己的 magpie 档案上时，候选是这把网关密钥能用的模型（与白名单核对同一
 * 套算法，由 `ConsoleMagpie` 算）。模型为「自动」的智能体取所配底层默认系列的第一名
 * （`rankFamilyModels`）；该系列一个都没有时按目录里的系列顺序取别的系列的第一名，
 * 标「系列外」。底层没有默认系列的不选（跟随节点主模型），没有线路的（qianmopi）
 * 也不收手选。路由组只在手选时用。算出的与节点上配置的一样就不发；手选的原样保存，
 * 不被重算覆盖。节点不在 magpie 档案上了，指向那份档案的模型由中枢撤回。
 *
 * 重算的时机：网关的连接、上游、路由组、密钥变了之后与每 10 分钟的核对
 * （`ConsoleMagpie` 调 {@link ConsoleMagpieAgents.changed}）、第一次读到一台节点、
 * 打开自动接入、接入一台节点之后；页面改底层时在同一次下发里带上新模型。同一时刻
 * 只跑一轮，期间再来的合并成下一轮；对节点的写一次一条。
 *
 * ## 自动接入
 *
 * 打开时（缺省），模型指派是 `inherit`、没有全局缺省档案、不属于任何租户的节点，由
 * 中枢自己（账本主体 `system:magpie`）走「为节点签发」同一条签发链接入；magpie 里
 * 还没有可用模型时不试，失败的一小时内不再试。
 *
 * ## 原生扩展
 *
 * 每个智能体的插件、MCP 与技能（P36.7）在 `consoleMagpieExtensions.ts`；这里把
 * 它接上同一条控制链路、同一道写权限，并在第一次读到一台节点时探明它有没有这组操作。
 */

import {
  type ConsoleFailure,
  type ConsoleResult,
  extensionInstallRequest,
  extensionItemName,
  MAGPIE_EXTENSION_KINDS,
  type MagpieAgentChange,
  type MagpieAgentModelView,
  type MagpieAgentsNodeView,
  type MagpieAgentsPort,
  type MagpieAgentsSnapshot,
  type MagpieAgentView,
  type MagpieCaller,
  type MagpieExtensionInstall,
  type MagpieExtensionJobView,
  type MagpieExtensionRemove,
  type MagpieExtensionsView,
  type MagpieKeyView,
  type MagpieRuntimeEntryView,
  type MagpieRuntimeJobView,
  type MagpieRuntimeView,
  type ProviderCaller,
} from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import { z } from 'zod'
import {
  FAMILIES,
  type ModelFamily,
  normalizeRuntimeId,
  RUNTIME_CATALOG,
  type RuntimeLane,
  type RuntimeSpec,
  rankFamilyModels,
  runtimeSpec,
} from '../host/runtimes/catalog.js'
import {
  type AgentRuntimeState,
  RUNTIME_ERRORS,
  RUNTIME_OPS,
  type RuntimeFallbackCode,
  type RuntimeStatusReply,
  type RuntimeVersionRow,
  type RuntimeVersionsReply,
} from '../host/runtimes/contract.js'
import { AgentExtensions } from './consoleMagpieExtensions.js'

type RuntimeSource = NonNullable<RuntimeVersionRow['source']>

const READ_MS = 8_000
const CONFIGURE_MS = 30_000
/** The node's own install steps take up to 11 minutes (P31): a margin on top. */
const INSTALL_MS = 13 * 60_000
const REMOVE_MS = 2 * 60_000
/** How long a page write waits for an install's answer before saying it runs. */
const WAIT_MS = 5_000
/** How long a node's `runtime.status` answer is shown as is. */
const STATUS_TTL_MS = 3_000
/**
 * How long its `runtime.versions` answer is: what is installed changes by an
 * install, a removal or an update, and each of those drops it at once.
 */
const VERSIONS_TTL_MS = 5 * 60_000
const JOIN_RETRY_MS = 60 * 60_000
/** The control-link actor of the hub's own writes. */
const ACTOR = 'magpie'
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** What the hub's own ledger lines are written with (`system:magpie`). */
export type MagpieSystemRecord = (
  action: string,
  target: string,
  outcome: 'ok' | 'refused' | 'failed',
  code?: string,
) => Promise<boolean>

/** The part of the control link this module uses (`ControlLinks`). */
export interface RuntimeControl {
  request(
    node: string,
    op: string,
    args: Record<string, unknown>,
    actor: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<ControlOutcome>
}

export interface MagpieAgentsOptions {
  readonly control: RuntimeControl
  /** The nodes on the control link. */
  readonly nodes: () => readonly string[]
  /** The tenant a node is mapped to, or null for the platform's. */
  readonly tenantOf?: (node: string) => string | null
  readonly now?: () => number
  /** How long an install answer is waited for (tests shorten it). */
  readonly waitMs?: number
  readonly onError?: (message: string) => void
}

/** The hub's own caller and ledger for writes nobody at the page asked for. */
export interface MagpieSystem {
  readonly caller: ProviderCaller
  readonly record: MagpieSystemRecord
}

/** A node as the model service and magpie see it. */
export interface AgentNodeGateway {
  /** The node's own magpie profile (`magpie-node-<id>`). */
  readonly profileId: string
  readonly assignment: 'bound' | 'inherit' | 'profile' | 'unmanaged'
  /**
   * What the node's gateway key lets through, groups included; empty when
   * the node is not on its magpie profile, null when magpie could not be read.
   */
  readonly models: readonly string[] | null
}

export interface MagpieAgentsGateways {
  readonly defaultProfileId: string | null
  readonly nodes: ReadonlyMap<string, AgentNodeGateway>
  /** Every eligible model and group on the gateway; null when unread. */
  readonly platformModels: readonly string[] | null
}

/** What `ConsoleMagpie` lends this module: its state file, its gate, its issuance chain. */
export interface MagpieAgentsHost {
  readonly configured: () => boolean
  readonly authorize: (caller: MagpieCaller) => ConsoleFailure | null
  readonly autoJoin: () => boolean
  readonly setAutoJoin: (on: boolean) => void
  /** The manual model of an agent, or null for automatic. */
  readonly choice: (node: string, agent: string) => string | null
  readonly setChoice: (
    node: string,
    agent: string,
    model: string | null,
  ) => void
  readonly gateways: () => Promise<MagpieAgentsGateways | null>
  /** Issue the node's key; `null` is the hub itself (automatic join). */
  readonly join: (
    node: string,
    caller: MagpieCaller | null,
  ) => Promise<ConsoleResult<MagpieKeyView>>
  readonly system: MagpieSystem | undefined
}

// --- the node's answers --------------------------------------------------

/**
 * A closed vocabulary of the contract, read open: a newer node's new code or
 * lane must not make the whole answer look like an old node's.
 */
function word<T extends string>(): z.ZodType<T> {
  return z.custom<T>(
    value =>
      typeof value === 'string' && value.length > 0 && value.length <= 40,
  )
}

const agentStateSchema: z.ZodType<AgentRuntimeState> = z.object({
  agent: z.string().regex(NAME),
  configured: z.object({
    runtime: z.string().max(64),
    model: z.string().max(256).nullable(),
    source: word<AgentRuntimeState['configured']['source']>(),
  }),
  effective: z.object({
    runtime: z.string().max(64),
    model: z.string().max(256).optional(),
    lane: word<RuntimeLane>().optional(),
  }),
  reason: z
    .object({
      code: word<RuntimeFallbackCode>(),
      message: z.string().max(1000),
    })
    .optional(),
})

const statusSchema: z.ZodType<RuntimeStatusReply> = z.object({
  defaultRuntime: z.string().max(64),
  agents: z.array(agentStateSchema).max(256),
})

const versionsSchema: z.ZodType<RuntimeVersionsReply> = z.object({
  defaultRuntime: z.string().max(64),
  runtimes: z
    .array(
      z.object({
        id: z.string().max(64),
        label: z.string().max(80),
        installed: z.boolean(),
        version: z.string().max(64).optional(),
        source: word<RuntimeSource>().optional(),
        pin: z.string().max(64).optional(),
        installing: z.boolean(),
        lastInstall: z
          .object({
            at: z.number(),
            ok: z.boolean(),
            version: z.string().max(64).optional(),
            error: z.string().max(1000).optional(),
          })
          .optional(),
        verified: z.boolean(),
      }),
    )
    .max(64),
})

type Facts =
  | {
      readonly state: 'ok'
      readonly status: RuntimeStatusReply
      readonly versions: RuntimeVersionsReply | null
    }
  | { readonly state: 'old' }
  | { readonly state: 'unreachable'; readonly error: string }

// --- picking -------------------------------------------------------------

/**
 * Families in the order a runtime falls back through when its own has no
 * model: the catalog's runtimes' families in catalog order, then the rest of
 * the catalog's family table.
 */
function familyOrder(): readonly ModelFamily[] {
  const out: ModelFamily[] = []
  for (const family of [
    ...RUNTIME_CATALOG.map(spec => spec.family),
    ...Object.values(FAMILIES),
  ]) {
    if (family !== null && !out.some(one => one.id === family.id))
      out.push(family)
  }
  return out
}

function firstOf(
  own: ModelFamily | null,
  candidates: readonly string[],
): { readonly model: string; readonly outOfFamily: boolean } | null {
  if (own !== null) {
    const ranked = rankFamilyModels(own, candidates)[0]
    if (ranked !== undefined) return { model: ranked, outOfFamily: false }
  }
  for (const family of familyOrder()) {
    if (family.id === own?.id) continue
    const ranked = rankFamilyModels(family, candidates)[0]
    if (ranked !== undefined) return { model: ranked, outOfFamily: true }
  }
  const any = candidates.find(id => !id.startsWith('group/'))
  return any === undefined ? null : { model: any, outOfFamily: true }
}

/**
 * The automatic model of a runtime among a key's models (§4.2): its family's
 * best, else another family's best (out of family); none for a runtime that
 * follows the node's main model. Routing groups never.
 */
export function autoModel(
  spec: RuntimeSpec,
  candidates: readonly string[],
): { readonly model: string; readonly outOfFamily: boolean } | null {
  if (spec.family === null || spec.lanes.length === 0) return null
  return firstOf(spec.family, candidates)
}

/** The main model a joining node's profile starts on: the default runtime's family first. */
export function joinModel(candidates: readonly string[]): string | null {
  const preferred = RUNTIME_CATALOG.find(spec => spec.default)?.family ?? null
  return firstOf(preferred, candidates)?.model ?? null
}

/** The family a model reads as on the page, or null. */
function familyLabel(id: string): string | null {
  const name = (id.split('/').pop() ?? id).toLowerCase()
  for (const family of familyOrder()) {
    if (family.tiers.some(pattern => pattern.test(name))) return family.label
  }
  return null
}

const CATALOG_VIEW: readonly MagpieRuntimeEntryView[] = RUNTIME_CATALOG.map(
  spec => ({
    id: spec.id,
    label: spec.label,
    family: spec.family?.label ?? null,
    builtin: spec.install.kind === 'builtin',
    default: spec.default,
  }),
)

// --- failures ------------------------------------------------------------

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

function failed<T>(
  code: ConsoleFailure['code'],
  message: string,
): ConsoleResult<T> {
  return { ok: false, failure: { code, message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A node's refusal as the console's failure; the node's words kept. */
function fromNode(outcome: {
  readonly code: string
  readonly message: string
}): ConsoleFailure {
  const message = `节点 · ${outcome.message}`.slice(0, 300)
  switch (outcome.code) {
    case 'unsupported':
      return { code: 'unsupported', message }
    case 'invalid':
    case RUNTIME_ERRORS.unknownRuntime:
    case RUNTIME_ERRORS.badModel:
      return { code: 'invalid', message }
    case RUNTIME_ERRORS.unknownAgent:
      return { code: 'not_found', message }
    case 'refused':
    case 'E_BUSY':
    case RUNTIME_ERRORS.inUse:
    case RUNTIME_ERRORS.builtin:
    case RUNTIME_ERRORS.busy:
    case RUNTIME_ERRORS.installFailed:
      return { code: 'refused', message }
    default:
      return { code: 'unreachable', message }
  }
}

async function settle(run: Promise<ControlOutcome>): Promise<ControlOutcome> {
  try {
    return await run
  } catch (error) {
    return { ok: false, code: 'unreachable', message: messageOf(error) }
  }
}

interface WriteState {
  readonly state: 'pending' | 'failed'
  readonly at: number
  readonly message: string | null
}

interface JobState extends WriteState {
  readonly kind: 'install' | 'remove'
}

export class ConsoleMagpieAgents implements MagpieAgentsPort {
  readonly #host: MagpieAgentsHost
  readonly #options: MagpieAgentsOptions
  readonly #now: () => number
  readonly #facts = new Map<
    string,
    { readonly at: number; readonly value: Facts }
  >()
  /** Each node's last `runtime.versions` answer; null when it gave none usable. */
  readonly #versions = new Map<
    string,
    { readonly at: number; readonly value: RuntimeVersionsReply | null }
  >()
  readonly #seen = new Set<string>()
  readonly #writes = new Map<string, WriteState>()
  readonly #jobs = new Map<string, JobState>()
  readonly #joinFailed = new Map<string, number>()
  readonly #pending = new Set<Promise<unknown>>()
  #running: Promise<void> | null = null
  #again = false
  #closed = false
  #chain: Promise<unknown> = Promise.resolve()
  /** Each agent's native extensions (P36.7). */
  readonly #ext: AgentExtensions

  constructor(host: MagpieAgentsHost, options: MagpieAgentsOptions) {
    this.#host = host
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#ext = new AgentExtensions({
      request: (node, op, args, actor, timeoutMs) =>
        settle(options.control.request(node, op, args, actor, { timeoutMs })),
      fromNode,
      track: promise => {
        this.#track(promise)
      },
      now: this.#now,
      waitMs: options.waitMs ?? WAIT_MS,
      actor: ACTOR,
    })
  }

  /** Something the models depend on changed: recompute in the background. */
  changed(): void {
    this.#schedule()
  }

  /** What is installed on `node` changed elsewhere (an update): read it again. */
  runtimesChanged(node: string): void {
    this.#facts.delete(node)
    this.#versions.delete(node)
  }

  /** Every background round and write has finished (tests). */
  async idle(): Promise<void> {
    while (this.#running !== null || this.#pending.size > 0)
      await Promise.all([this.#running, ...this.#pending])
  }

  close(): void {
    this.#closed = true
  }

  // --- plumbing ----------------------------------------------------------

  #schedule(): void {
    if (this.#closed) return
    if (this.#running !== null) {
      this.#again = true
      return
    }
    this.#running = this.#loop()
  }

  async #loop(): Promise<void> {
    do {
      this.#again = false
      try {
        await this.#sync()
      } catch (error) {
        this.#options.onError?.(`智能体模型核对失败 · ${messageOf(error)}`)
      }
    } while (this.#again && !this.#closed)
    this.#running = null
  }

  /** Writes to nodes one at a time: a page's choice and a round never cross. */
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(run, run)
    this.#chain = next.catch(() => {})
    return next
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise)
    void promise.finally(() => this.#pending.delete(promise)).catch(() => {})
    return promise
  }

  async #read(node: string, fresh: boolean): Promise<Facts> {
    const now = this.#now()
    const cached = this.#facts.get(node)
    if (!fresh && cached !== undefined && now - cached.at < STATUS_TTL_MS)
      return cached.value
    const control = this.#options.control
    const known = this.#versions.get(node)
    // A node installing on its own (P36.3) is followed at the status pace.
    const due =
      known === undefined ||
      now - known.at >=
        (known.value?.runtimes.some(row => row.installing) === true
          ? STATUS_TTL_MS
          : VERSIONS_TTL_MS)
    const [status, versions] = await Promise.all([
      settle(
        control.request(node, RUNTIME_OPS.status, {}, ACTOR, {
          timeoutMs: READ_MS,
        }),
      ),
      due
        ? settle(
            control.request(node, RUNTIME_OPS.versions, {}, ACTOR, {
              timeoutMs: READ_MS,
            }),
          )
        : null,
    ])
    let rows = known?.value ?? null
    // An answer is kept; a link failure keeps what was read before and asks
    // again next time.
    if (versions !== null && (versions.ok || versions.code === 'unsupported')) {
      const parsed = versions.ok
        ? versionsSchema.safeParse(versions.value)
        : null
      rows = parsed?.success === true ? parsed.data : null
      this.#versions.set(node, { at: now, value: rows })
    }
    let value: Facts
    if (status.ok) {
      const parsed = statusSchema.safeParse(status.value)
      value = parsed.success
        ? { state: 'ok', status: parsed.data, versions: rows }
        : { state: 'old' }
    } else if (status.code === 'unsupported') {
      value = { state: 'old' }
    } else {
      value = { state: 'unreachable', error: status.message.slice(0, 300) }
    }
    this.#facts.set(node, { at: this.#now(), value })
    return value
  }

  /** The node's tenant; `undefined` when the tenancy cannot be read. */
  #tenantOf(node: string): string | null | undefined {
    try {
      return this.#options.tenantOf?.(node) ?? null
    } catch {
      return undefined
    }
  }

  async #gateways(): Promise<MagpieAgentsGateways | null> {
    try {
      return await this.#host.gateways()
    } catch (error) {
      this.#options.onError?.(`读模型指派失败 · ${messageOf(error)}`)
      return null
    }
  }

  // --- the model an agent should have ------------------------------------

  /**
   * What `runtime.configure` should set the agent's model to: a
   * `<profile>/<model>`, `null` to take back one of ours, or `undefined` to
   * leave it alone.
   */
  #desired(
    node: string,
    agent: AgentRuntimeState,
    gateway: AgentNodeGateway | undefined,
  ): string | null | undefined {
    const current = agent.configured.model
    const ours =
      gateway !== undefined &&
      current !== null &&
      current.startsWith(`${gateway.profileId}/`)
    if (gateway?.assignment !== 'bound') return ours ? null : undefined
    const models = gateway.models
    const spec = runtimeSpec(agent.configured.runtime)
    if (models === null || spec === undefined) return undefined
    if (spec.lanes.length === 0) return ours ? null : undefined
    const manual = this.#host.choice(node, agent.agent)
    if (manual !== null) return `${gateway.profileId}/${manual}`
    const pick = autoModel(spec, models)
    if (pick === null) return ours ? null : undefined
    return `${gateway.profileId}/${pick.model}`
  }

  /** Send one `runtime.configure`; the hub's own are recorded as `system:magpie`. */
  async #configure(
    node: string,
    agent: string,
    args: Record<string, unknown>,
    actor: string,
    system: boolean,
  ): Promise<ControlOutcome> {
    const key = `${node}/${agent}`
    this.#writes.set(key, { state: 'pending', at: this.#now(), message: null })
    this.#facts.delete(node)
    const outcome = await settle(
      this.#options.control.request(
        node,
        RUNTIME_OPS.configure,
        { agent, ...args },
        actor,
        { timeoutMs: CONFIGURE_MS },
      ),
    )
    this.#facts.delete(node)
    if (outcome.ok) this.#writes.delete(key)
    else
      this.#writes.set(key, {
        state: 'failed',
        at: this.#now(),
        message: outcome.message.slice(0, 300),
      })
    if (system)
      await this.#record(
        'runtime.configure',
        `qianmo://${node}/${agent}`,
        outcome.ok ? 'ok' : 'failed',
        outcome.ok ? undefined : fromNode(outcome).code,
      )
    return outcome
  }

  async #record(
    action: string,
    target: string,
    outcome: 'ok' | 'refused' | 'failed',
    code?: string,
  ): Promise<void> {
    const system = this.#host.system
    if (system === undefined) return
    try {
      await system.record(action, target, outcome, code)
    } catch (error) {
      this.#options.onError?.(`账本没记上 ${action} · ${messageOf(error)}`)
    }
  }

  // --- the background round ----------------------------------------------

  async #sync(): Promise<void> {
    if (!this.#host.configured()) return
    let gateways = await this.#gateways()
    if (gateways === null) return
    if (await this.#autoJoin(gateways)) gateways = await this.#gateways()
    if (gateways === null) return
    const known = gateways
    await Promise.all(
      this.#options.nodes().map(async node => {
        const facts = await this.#read(node, true)
        if (facts.state !== 'ok') return
        this.#seen.add(node)
        for (const agent of facts.status.agents) {
          await this.#serial(async () => {
            if (this.#closed) return
            const desired = this.#desired(node, agent, known.nodes.get(node))
            if (desired === undefined || desired === agent.configured.model)
              return
            const outcome = await this.#configure(
              node,
              agent.agent,
              { model: desired },
              ACTOR,
              true,
            )
            if (!outcome.ok)
              this.#options.onError?.(
                `${node}/${agent.agent} 模型没下发 · ${outcome.message}`,
              )
          })
        }
      }),
    )
  }

  /** Join the nodes that follow nothing (§4.1); true when one joined. */
  async #autoJoin(gateways: MagpieAgentsGateways): Promise<boolean> {
    if (
      !this.#host.autoJoin() ||
      this.#host.system === undefined ||
      gateways.defaultProfileId !== null ||
      gateways.platformModels === null ||
      gateways.platformModels.length === 0
    )
      return false
    let joined = false
    for (const [node, gateway] of gateways.nodes) {
      if (this.#closed) break
      if (gateway.assignment !== 'inherit') continue
      // A tenant's node, or one whose tenant cannot be told, stays out.
      if (this.#tenantOf(node) !== null) continue
      const failedAt = this.#joinFailed.get(node)
      if (failedAt !== undefined && this.#now() - failedAt < JOIN_RETRY_MS)
        continue
      const result = await this.#host.join(node, null)
      await this.#record(
        'magpie.autojoin',
        `node:${node}`,
        result.ok ? 'ok' : 'failed',
        result.ok ? undefined : result.failure.code,
      )
      if (result.ok) {
        this.#joinFailed.delete(node)
        joined = true
      } else {
        this.#joinFailed.set(node, this.#now())
        this.#options.onError?.(
          `${node} 没能自动接入 magpie · ${result.failure.message}`,
        )
      }
    }
    return joined
  }

  // --- reads -------------------------------------------------------------

  async snapshot(): Promise<ConsoleResult<MagpieAgentsSnapshot>> {
    const nodes = this.#options.nodes()
    const [gateways, facts] = await Promise.all([
      this.#gateways(),
      Promise.all(nodes.map(node => this.#read(node, false))),
    ])
    // A node read for the first time gets its models worked out, and is
    // asked once whether it has the native extension ops.
    let fresh = false
    nodes.forEach((node, index) => {
      const read = facts[index]
      if (read?.state !== 'ok') return
      if (!this.#seen.has(node)) {
        this.#seen.add(node)
        fresh = true
      }
      const first = read.status.agents[0]
      if (first !== undefined) this.#ext.probe(node, first.agent)
    })
    if (fresh) this.#schedule()
    return ok({
      autoJoin: this.#host.autoJoin(),
      connected: this.#host.configured(),
      catalog: CATALOG_VIEW,
      nodes: nodes.map((node, index) =>
        this.#nodeView(
          node,
          facts[index] ?? { state: 'old' },
          gateways?.nodes.get(node),
        ),
      ),
    })
  }

  #nodeView(
    node: string,
    facts: Facts,
    gateway: AgentNodeGateway | undefined,
  ): MagpieAgentsNodeView {
    const bound = gateway?.assignment === 'bound'
    const models: MagpieAgentModelView[] = bound
      ? (gateway.models ?? []).map(id =>
          id.startsWith('group/')
            ? { id, family: null, group: true }
            : { id, family: familyLabel(id), group: false },
        )
      : []
    const base = {
      node,
      gateway: gateway?.assignment ?? ('absent' as const),
      tenant: this.#tenantOf(node) ?? null,
      models,
    }
    if (facts.state !== 'ok')
      return {
        ...base,
        state: facts.state,
        defaultRuntime: null,
        runtimes: [],
        agents: [],
        error: facts.state === 'unreachable' ? facts.error : null,
      }
    return {
      ...base,
      state: 'ok',
      defaultRuntime: facts.status.defaultRuntime,
      runtimes: this.#runtimeViews(node, facts.versions),
      agents: facts.status.agents.map(agent =>
        this.#agentView(node, agent, gateway),
      ),
      error: null,
    }
  }

  #runtimeViews(
    node: string,
    versions: RuntimeVersionsReply | null,
  ): MagpieRuntimeView[] {
    const rows = versions?.runtimes ?? []
    const ids = [
      ...RUNTIME_CATALOG.map(spec => spec.id),
      ...rows.map(row => row.id).filter(id => runtimeSpec(id) === undefined),
    ]
    return ids.map(id => {
      const spec = runtimeSpec(id)
      const row = rows.find(one => one.id === id)
      const builtin = spec?.install.kind === 'builtin'
      const job = this.#jobs.get(`${node}/${id}`)
      const last = row?.lastInstall
      return {
        id,
        label: spec?.label ?? row?.label ?? id,
        installed: row?.installed ?? builtin,
        version: row?.version ?? null,
        builtin,
        installing:
          row?.installing === true ||
          (job?.state === 'pending' && job.kind === 'install'),
        removing: job?.state === 'pending' && job.kind === 'remove',
        verified: spec?.verified ?? row?.verified ?? false,
        failed:
          job?.state === 'failed'
            ? { at: job.at, message: job.message }
            : last !== undefined && !last.ok && row?.installed !== true
              ? { at: last.at, message: last.error ?? null }
              : null,
      }
    })
  }

  #agentView(
    node: string,
    agent: AgentRuntimeState,
    gateway: AgentNodeGateway | undefined,
  ): MagpieAgentView {
    const spec = runtimeSpec(agent.configured.runtime)
    const prefix = gateway === undefined ? null : `${gateway.profileId}/`
    const current = agent.configured.model
    const manual = this.#host.choice(node, agent.agent)
    const pick =
      spec !== undefined && gateway?.assignment === 'bound'
        ? autoModel(spec, gateway.models ?? [])
        : null
    return {
      agent: agent.agent,
      runtime: agent.configured.runtime,
      effective: agent.effective.runtime,
      model:
        current !== null && prefix !== null && current.startsWith(prefix)
          ? current.slice(prefix.length)
          : current,
      choice:
        manual === null ? { mode: 'auto' } : { mode: 'manual', model: manual },
      pick: pick?.model ?? null,
      outOfFamily: pick?.outOfFamily ?? false,
      followsNode: spec?.family === null || spec?.lanes.length === 0,
      choosable: spec !== undefined && spec.lanes.length > 0,
      reason:
        agent.reason === undefined
          ? null
          : { code: agent.reason.code, message: agent.reason.message },
      write: this.#writes.get(`${node}/${agent.agent}`) ?? null,
      extensions: this.#ext.view(node, agent.agent, agent.configured.runtime),
    }
  }

  // --- writes ------------------------------------------------------------

  /** The node with the runtime ops (read now unless `fresh` is false); or why not. */
  async #capable(
    node: string,
    fresh = true,
  ): Promise<
    | { readonly ok: true; readonly status: RuntimeStatusReply }
    | { readonly ok: false; readonly failure: ConsoleFailure }
  > {
    if (!NAME.test(node) || !this.#options.nodes().includes(node))
      return {
        ok: false,
        failure: { code: 'not_found', message: '控制链路上没有这台节点' },
      }
    const facts = await this.#read(node, fresh)
    if (facts.state === 'old')
      return {
        ok: false,
        failure: { code: 'unsupported', message: '节点版本过旧 · 先升级节点' },
      }
    if (facts.state === 'unreachable')
      return {
        ok: false,
        failure: {
          code: 'unreachable',
          message: `节点连不上 · ${facts.error}`,
        },
      }
    return { ok: true, status: facts.status }
  }

  configure(
    change: MagpieAgentChange,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieAgentView>> {
    return this.#serial(async () => {
      const denied = this.#host.authorize(caller)
      if (denied !== null) return { ok: false, failure: denied }
      let runtime: string | undefined
      if (change.runtime !== undefined) {
        runtime = normalizeRuntimeId(change.runtime)
        if (runtime === undefined)
          return failed('invalid', '目录里没有这个底层')
      }
      const node = await this.#capable(change.node)
      if (!node.ok) return node
      const agent = node.status.agents.find(one => one.agent === change.agent)
      if (agent === undefined)
        return failed('not_found', '节点上没有这个智能体')
      const gateway = (await this.#gateways())?.nodes.get(change.node)
      const next: AgentRuntimeState =
        runtime === undefined
          ? agent
          : { ...agent, configured: { ...agent.configured, runtime } }
      const spec = runtimeSpec(next.configured.runtime)
      const before = this.#host.choice(change.node, change.agent)
      if (change.model !== undefined) {
        let model: string | null = null
        if (change.model !== 'auto') {
          if (spec === undefined || spec.lanes.length === 0)
            return failed(
              'invalid',
              `${spec?.label ?? next.configured.runtime} 跟随节点主模型`,
            )
          if (gateway?.assignment !== 'bound')
            return failed('invalid', '这台节点还没接入 magpie')
          if (gateway.models === null)
            return failed('unreachable', '读不到 magpie 的模型')
          if (!gateway.models.includes(change.model))
            return failed('invalid', '这台节点的网关密钥用不了这个模型')
          model = change.model
        }
        try {
          this.#host.setChoice(change.node, change.agent, model)
        } catch (error) {
          return failed('unreachable', `网关状态写不进去 · ${messageOf(error)}`)
        }
      }
      const args: Record<string, unknown> = {}
      if (runtime !== undefined && runtime !== agent.configured.runtime)
        args['runtime'] = runtime
      const desired = this.#desired(change.node, next, gateway)
      if (desired !== undefined && desired !== agent.configured.model)
        args['model'] = desired
      if (Object.keys(args).length === 0)
        return ok(this.#agentView(change.node, agent, gateway))
      const outcome = await this.#configure(
        change.node,
        change.agent,
        args,
        caller.subject,
        false,
      )
      if (!outcome.ok) {
        // Not taken: the choice goes back, so no later sync applies it.
        if (change.model !== undefined)
          try {
            this.#host.setChoice(change.node, change.agent, before)
          } catch {
            // Left as it was written; the operator was told it failed.
          }
        return { ok: false, failure: fromNode(outcome) }
      }
      // Another runtime's plugins and servers are not this one's.
      if ('runtime' in args) this.#ext.forget(change.node, change.agent)
      const answered = agentStateSchema.safeParse(outcome.value)
      const state: AgentRuntimeState = answered.success
        ? answered.data
        : {
            ...next,
            configured: {
              ...next.configured,
              model:
                'model' in args
                  ? (args['model'] as string | null)
                  : next.configured.model,
            },
          }
      return ok(this.#agentView(change.node, state, gateway))
    })
  }

  #spec(runtime: string): RuntimeSpec | undefined {
    const id = normalizeRuntimeId(runtime)
    return id === undefined ? undefined : runtimeSpec(id)
  }

  async install(
    input: { readonly node: string; readonly runtime: string },
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieRuntimeJobView>> {
    const denied = this.#host.authorize(caller)
    if (denied !== null) return { ok: false, failure: denied }
    const spec = this.#spec(input.runtime)
    if (spec === undefined) return failed('invalid', '目录里没有这个底层')
    if (spec.install.kind !== 'npm')
      return failed('invalid', `${spec.label} 内置 · 不用安装`)
    const node = await this.#capable(input.node)
    if (!node.ok) return node
    return this.#job(input.node, spec.id, 'install', caller.subject)
  }

  async remove(
    input: { readonly node: string; readonly runtime: string },
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieRuntimeJobView>> {
    const denied = this.#host.authorize(caller)
    if (denied !== null) return { ok: false, failure: denied }
    const spec = this.#spec(input.runtime)
    if (spec === undefined) return failed('invalid', '目录里没有这个底层')
    if (spec.install.kind !== 'npm')
      return failed('invalid', `${spec.label} 内置 · 不能卸载`)
    const node = await this.#capable(input.node)
    if (!node.ok) return node
    return this.#job(input.node, spec.id, 'remove', caller.subject)
  }

  /**
   * Send an install or a removal and wait a little for its answer: the node
   * may take minutes, and the page follows `runtime.versions` meanwhile.
   */
  async #job(
    node: string,
    runtime: string,
    kind: 'install' | 'remove',
    actor: string,
  ): Promise<ConsoleResult<MagpieRuntimeJobView>> {
    const key = `${node}/${runtime}`
    if (this.#jobs.get(key)?.state === 'pending')
      return failed('invalid', '这个底层正在装卸 · 稍后再试')
    this.#jobs.set(key, {
      kind,
      state: 'pending',
      at: this.#now(),
      message: null,
    })
    this.runtimesChanged(node)
    let answered = false
    const run = settle(
      this.#options.control.request(
        node,
        kind === 'install' ? RUNTIME_OPS.install : RUNTIME_OPS.remove,
        { runtime },
        actor,
        { timeoutMs: kind === 'install' ? INSTALL_MS : REMOVE_MS },
      ),
    ).then(outcome => {
      this.runtimesChanged(node)
      // A failure the page already showed is not kept; a late one is.
      if (outcome.ok || answered) this.#jobs.delete(key)
      else
        this.#jobs.set(key, {
          kind,
          state: 'failed',
          at: this.#now(),
          message: outcome.message.slice(0, 300),
        })
      return outcome
    })
    this.#track(run)
    let timer: ReturnType<typeof setTimeout> | undefined
    const early = await Promise.race([
      run,
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), this.#options.waitMs ?? WAIT_MS)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
    if (early === null) return ok({ node, runtime, state: 'running' })
    answered = true
    if (!early.ok) {
      this.#jobs.delete(key)
      return { ok: false, failure: fromNode(early) }
    }
    return ok({ node, runtime, state: 'done' })
  }

  async setAutoJoin(
    on: boolean,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<{ readonly autoJoin: boolean }>> {
    const denied = this.#host.authorize(caller)
    if (denied !== null) return { ok: false, failure: denied }
    try {
      this.#host.setAutoJoin(on)
    } catch (error) {
      return failed('unreachable', `网关状态写不进去 · ${messageOf(error)}`)
    }
    if (on) this.#schedule()
    return ok({ autoJoin: on })
  }

  async join(
    node: string,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieKeyView>> {
    if (!NAME.test(node)) return failed('invalid', '节点名无效')
    const result = await this.#host.join(node, caller)
    if (result.ok) this.#schedule()
    return result
  }

  // --- native extensions (P36.7) -------------------------------------------

  /** The agent on a node that has the runtime ops, and not one known to lack the extension ops. */
  async #extensionAgent(
    node: string,
    agent: string,
    fresh: boolean,
  ): Promise<ConsoleResult<null>> {
    if (!NAME.test(agent)) return failed('invalid', '智能体名无效')
    const found = await this.#capable(node, fresh)
    if (!found.ok) return found
    if (!found.status.agents.some(one => one.agent === agent))
      return failed('not_found', '节点上没有这个智能体')
    if (this.#ext.supported(node) === false)
      return failed('unsupported', '节点版本过旧 · 不支持原生扩展')
    return ok(null)
  }

  async extensions(
    node: string,
    agent: string,
  ): Promise<ConsoleResult<MagpieExtensionsView>> {
    const found = await this.#extensionAgent(node, agent, false)
    if (!found.ok) return found
    return this.#ext.read(node, agent, ACTOR)
  }

  async installExtension(
    input: MagpieExtensionInstall,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieExtensionJobView>> {
    const denied = this.#host.authorize(caller)
    if (denied !== null) return { ok: false, failure: denied }
    const { node, agent, ...asked } = input
    const request = extensionInstallRequest(asked)
    if (!request.ok) return request
    const found = await this.#extensionAgent(node, agent, true)
    if (!found.ok) return found
    return this.#ext.install(node, agent, request.value, caller.subject)
  }

  async removeExtension(
    input: MagpieExtensionRemove,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieExtensionJobView>> {
    const denied = this.#host.authorize(caller)
    if (denied !== null) return { ok: false, failure: denied }
    if (!(MAGPIE_EXTENSION_KINDS as readonly string[]).includes(input.kind))
      return failed('invalid', '扩展种类只能是插件 · MCP · 技能')
    const name = extensionItemName(input.name)
    if (name === null) return failed('invalid', '扩展名无效')
    const found = await this.#extensionAgent(input.node, input.agent, true)
    if (!found.ok) return found
    return this.#ext.remove(
      input.node,
      input.agent,
      input.kind,
      name,
      caller.subject,
    )
  }
}
