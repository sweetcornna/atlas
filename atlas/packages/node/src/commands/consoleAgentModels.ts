// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 智能体按底层原生方式配模型（`harness-backends.md` §11）：每台节点上每个智能体的
 * 模型、推理强度、Claude Code 的四档与各档强度、opencode 的小模型，按 magpie 的字段
 * （`POST /api/set {agent, field, value}`）一项一项改。
 *
 * ## 不依赖 magpie
 *
 * 模型候选来自下发到这台节点的模型档案（它在用的、期望的、任务分工引用的），按档案
 * 分组；magpie 网关密钥只是其中 `presetId: 'magpie'` 的一份。中枢开着 magpie、节点
 * 接在它自己的 magpie 档案上时，`model` 字段交给网关页的智能体区块
 * （`consoleMagpieAgents.ts`）：留空即「自动」按系列取，手选存在 `magpie.json`，
 * 与以前一样；那份档案的候选是这把密钥能用的模型与路由组。
 *
 * ## 存与发
 *
 * `model` 照旧是节点 `runtimes.json` 的 `model`；其余字段存在
 * `qianmoConfigPath('qianmo','console','agent-models.json')`（0600），并整份经
 * `runtime.configure {agent, fields}` 下发（节点存进同一个文件的 `fields`）。
 * 节点在 `runtime.status` 的 `configured.fields` 里报它收到的；没有这一项的是旧节点：
 * 只发 `model`，其余字段记在中枢、标「节点未收到」，节点升级后读页面时补发。
 * 节点上的与中枢记的不一致时（节点重装、文件丢了），读页面时在后台重发，同一智能体
 * 十分钟至多一次。
 *
 * ## 规则
 *
 * 分档与小模型与主模型走同一地址与密钥，只能选主模型同一来源的；档位强度写成
 * `model:effort`，只有 magpie 网关认，所以只在 magpie 档案上开放。强度按底层与模型
 * 收窄（`modelFields.ts`），节点启动时再收一次。写操作只给模型服务的写者（个人运维
 * 账号、非 break-glass），路由记 `runtime.configure`。
 */

import {
  type AgentModelChange,
  type AgentModelFieldView,
  type AgentModelsAgentView,
  type AgentModelsNodeView,
  type AgentModelsPort,
  type AgentModelsSnapshot,
  type AgentModelSourceView,
  type ConsoleFailure,
  type ConsoleResult,
  type MagpieAgentChange,
  type MagpieAgentView,
  type MagpieCaller,
  type ProviderOverview,
  type ProviderProfileView,
  type ProviderResult,
} from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import { readTextIfExists, writePrivateJson } from '../providers/store.js'
import { normalizeRuntimeId, runtimeSpec } from '../host/runtimes/catalog.js'
import {
  RUNTIME_ERRORS,
  RUNTIME_OPS,
  type AgentRuntimeState,
} from '../host/runtimes/contract.js'
import {
  agentModelFields,
  effortChoices,
  effortVocabulary,
  fieldValueProblem,
  followTier,
  type ClaudeTier,
  MODEL_SPEC,
  type ModelFacts,
  modelOf,
  profileOf,
} from '../host/runtimes/modelFields.js'
import type { MagpieAgentsGateways } from './consoleMagpieAgents.js'

const READ_MS = 8_000
const CONFIGURE_MS = 30_000
/** How long a node's `runtime.status` answer is shown as is. */
const STATUS_TTL_MS = 3_000
/** How often a node that lost an agent's fields gets them again. */
const RESEND_MS = 10 * 60_000
const ACTOR = 'agent-models'
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
/** A personal account (the model service's writers), as `consoleMagpie.ts`. */
const PERSONAL_SUBJECT = /^u:[0-9a-f]{16}$/

/** The part of the control link this module uses (`ControlLinks`). */
export interface AgentModelsControl {
  request(
    node: string,
    op: string,
    args: Record<string, unknown>,
    actor: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<ControlOutcome>
}

/** The gateway page's agents section, when the hub runs magpie. */
export interface AgentModelsMagpie {
  gateways(): Promise<MagpieAgentsGateways | null>
  configure(
    change: MagpieAgentChange,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<MagpieAgentView>>
}

export interface AgentModelsOptions {
  readonly control: AgentModelsControl
  /** The nodes on the control link. */
  readonly nodes: () => readonly string[]
  /** The model service's profiles and nodes. */
  readonly overview: () => Promise<ProviderResult<ProviderOverview>>
  /** The profiles a node's routing brings besides its own. */
  readonly routedProfiles?: (node: string) => readonly string[]
  /** The magpie agents section, read each time (it may come later). */
  readonly magpie?: () => AgentModelsMagpie | undefined
  /** Default `qianmoConfigPath('qianmo','console','agent-models.json')`, given by the host. */
  readonly statePath: string
  readonly now?: () => number
  readonly onError?: (message: string) => void
}

interface StoredAgent {
  readonly node: string
  readonly agent: string
  readonly fields: Readonly<Record<string, string>>
}

interface State {
  readonly v: 1
  readonly agents: readonly StoredAgent[]
}

type Facts =
  | { readonly state: 'ok'; readonly agents: readonly AgentRuntimeState[] }
  | { readonly state: 'old' }
  | { readonly state: 'unreachable'; readonly error: string }

/** A model source as the hub sees it for one node. */
interface Source {
  readonly profile: ProviderProfileView
  readonly magpie: boolean
  /** The lanes it answers (its own and `laneAddresses`'). */
  readonly lanes: readonly string[]
  /** Its models: the profile's chat models, or a bound magpie key's. */
  readonly models: readonly string[]
}

interface Gateway {
  readonly profileId: string
  readonly models: readonly string[] | null
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function settle(run: Promise<ControlOutcome>): Promise<ControlOutcome> {
  try {
    return await run
  } catch (error) {
    return { ok: false, code: 'unreachable', message: messageOf(error) }
  }
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
    case RUNTIME_ERRORS.badModel:
      return { code: 'invalid', message }
    case RUNTIME_ERRORS.unknownAgent:
      return { code: 'not_found', message }
    case 'refused':
    case 'E_BUSY':
      return { code: 'refused', message }
    default:
      return { code: 'unreachable', message }
  }
}

/**
 * What the node will know of a profile's model once compiled
 * (`providers/compile.ts`): the efforts it takes, and that it does not
 * reason when the profile says so; nothing when the base decides.
 */
export function profileModelFacts(
  profile: ProviderProfileView,
  id: string,
): ModelFacts {
  const model = profile.models.find(one => one.id === id)
  if (model === undefined) return { id }
  const inferFamily =
    model.capabilities.mode === 'family' && model.effort.send === 'auto'
  const reasoning =
    model.effort.send !== 'never' &&
    (model.effort.send === 'always' ||
      (model.capabilities.mode === 'explicit' && model.capabilities.thinking))
  return {
    id,
    ...(model.contextTokens === undefined
      ? {}
      : { contextWindow: model.contextTokens }),
    ...(model.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: model.maxOutputTokens }),
    ...(inferFamily
      ? {}
      : reasoning
        ? { efforts: model.effort.levels ?? ['low', 'medium', 'high'] }
        : { reasoning: false }),
  }
}

const agentStateRead = (value: unknown): AgentRuntimeState | null => {
  if (!isRecord(value) || typeof value['agent'] !== 'string') return null
  const configured = value['configured']
  const effective = value['effective']
  if (!isRecord(configured) || !isRecord(effective)) return null
  if (typeof configured['runtime'] !== 'string') return null
  const fields = isRecord(configured['fields'])
    ? Object.fromEntries(
        Object.entries(configured['fields']).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : undefined
  return {
    agent: value['agent'],
    configured: {
      runtime: configured['runtime'],
      model:
        typeof configured['model'] === 'string' ? configured['model'] : null,
      source:
        configured['source'] === 'config' || configured['source'] === 'flag'
          ? configured['source']
          : 'default',
      ...(fields === undefined ? {} : { fields }),
    },
    effective: {
      runtime:
        typeof effective['runtime'] === 'string'
          ? effective['runtime']
          : configured['runtime'],
      ...(typeof effective['model'] === 'string'
        ? { model: effective['model'] }
        : {}),
    },
  }
}

function sameFields(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if ((a[key] ?? '') !== (b[key] ?? '')) return false
  return true
}

export class ConsoleAgentModels implements AgentModelsPort {
  readonly #options: AgentModelsOptions
  readonly #now: () => number
  readonly #facts = new Map<string, { at: number; value: Facts }>()
  readonly #writes = new Map<
    string,
    { state: 'pending' | 'failed'; at: number; message: string | null }
  >()
  readonly #resent = new Map<string, number>()
  readonly #pending = new Set<Promise<unknown>>()
  #state: State
  #chain: Promise<unknown> = Promise.resolve()

  constructor(options: AgentModelsOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#state = this.#load()
  }

  /** Every background resend has finished (tests). */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending])
  }

  #load(): State {
    try {
      const raw: unknown = JSON.parse(
        readTextIfExists(this.#options.statePath) ?? '{"v":1,"agents":[]}',
      )
      const rows =
        isRecord(raw) && Array.isArray(raw['agents']) ? raw['agents'] : []
      const agents: StoredAgent[] = []
      for (const row of rows) {
        if (!isRecord(row) || !isRecord(row['fields'])) continue
        const node = row['node']
        const agent = row['agent']
        if (typeof node !== 'string' || !NAME.test(node)) continue
        if (typeof agent !== 'string' || !NAME.test(agent)) continue
        const fields: Record<string, string> = {}
        for (const [key, value] of Object.entries(row['fields']))
          if (
            key !== 'model' &&
            typeof value === 'string' &&
            value !== '' &&
            fieldValueProblem(key, value) === null
          )
            fields[key] = value
        agents.push({ node, agent, fields })
      }
      return { v: 1, agents }
    } catch (error) {
      this.#options.onError?.(`agent-models.json 读不了 · ${messageOf(error)}`)
      return { v: 1, agents: [] }
    }
  }

  #stored(
    node: string,
    agent: string,
  ): Readonly<Record<string, string>> | undefined {
    return this.#state.agents.find(
      one => one.node === node && one.agent === agent,
    )?.fields
  }

  #save(
    node: string,
    agent: string,
    fields: Readonly<Record<string, string>>,
  ): void {
    const others = this.#state.agents.filter(
      one => one.node !== node || one.agent !== agent,
    )
    const next: State = {
      v: 1,
      agents:
        Object.keys(fields).length === 0
          ? others
          : [...others, { node, agent, fields }],
    }
    writePrivateJson(this.#options.statePath, next)
    this.#state = next
  }

  /** Writes one at a time: two field changes of one agent never cross. */
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(run, run)
    this.#chain = next.catch(() => {})
    return next
  }

  #track(promise: Promise<unknown>): void {
    this.#pending.add(promise)
    void promise.finally(() => this.#pending.delete(promise)).catch(() => {})
  }

  async #read(node: string, fresh: boolean): Promise<Facts> {
    const cached = this.#facts.get(node)
    if (
      !fresh &&
      cached !== undefined &&
      this.#now() - cached.at < STATUS_TTL_MS
    )
      return cached.value
    const status = await settle(
      this.#options.control.request(node, RUNTIME_OPS.status, {}, ACTOR, {
        timeoutMs: READ_MS,
      }),
    )
    let value: Facts
    if (
      status.ok &&
      isRecord(status.value) &&
      Array.isArray(status.value['agents'])
    )
      value = {
        state: 'ok',
        agents: status.value['agents']
          .map(agentStateRead)
          .filter((one): one is AgentRuntimeState => one !== null),
      }
    else if (status.ok || status.code === 'unsupported')
      value = { state: 'old' }
    else value = { state: 'unreachable', error: status.message.slice(0, 300) }
    this.#facts.set(node, { at: this.#now(), value })
    return value
  }

  async #overview(): Promise<ProviderOverview | null> {
    try {
      const read = await this.#options.overview()
      return read.ok ? read.value : null
    } catch (error) {
      this.#options.onError?.(`读模型服务失败 · ${messageOf(error)}`)
      return null
    }
  }

  async #gateways(): Promise<Map<string, Gateway>> {
    const out = new Map<string, Gateway>()
    const magpie = this.#options.magpie?.()
    if (magpie === undefined) return out
    let read: MagpieAgentsGateways | null = null
    try {
      read = await magpie.gateways()
    } catch (error) {
      this.#options.onError?.(`读 magpie 失败 · ${messageOf(error)}`)
    }
    for (const [node, gateway] of read?.nodes ?? [])
      if (gateway.assignment === 'bound')
        out.set(node, { profileId: gateway.profileId, models: gateway.models })
    return out
  }

  /** The profiles delivered to `node`, with what each offers. */
  #sources(
    node: string,
    overview: ProviderOverview | null,
    gateway: Gateway | undefined,
  ): Source[] {
    if (overview === null) return []
    const view = overview.nodes.find(one => one.node === node)
    const ids = new Set<string>()
    const applied = view?.actual?.applied?.profileId
    if (applied !== undefined) ids.add(applied)
    if (view?.expected) ids.add(view.expected.profileId)
    for (const id of this.#options.routedProfiles?.(node) ?? []) ids.add(id)
    if (gateway !== undefined) ids.add(gateway.profileId)
    const out: Source[] = []
    for (const id of ids) {
      const profile = overview.profiles.find(
        one => one.profile.id === id,
      )?.profile
      if (profile === undefined) continue
      const bound = gateway?.profileId === id
      const models = bound
        ? (gateway.models ?? [])
        : profile.models
            .filter(model => (model.kind ?? 'chat') === 'chat')
            .map(model => model.id)
      out.push({
        profile,
        magpie: profile.presetId === 'magpie',
        lanes: [profile.lane, ...Object.keys(profile.laneAddresses ?? {})],
        models,
      })
    }
    return out
  }

  /** The sources an agent on `runtime` can call (qianmopi: any chat profile). */
  #sourcesFor(runtime: string, sources: readonly Source[]): Source[] {
    const lanes = runtimeSpec(runtime)?.lanes ?? []
    return sources.filter(source =>
      lanes.length === 0
        ? [
            'anthropic',
            'openai-chat',
            'openai-responses',
            'gemini',
            'grok',
          ].some(lane => source.lanes.includes(lane))
        : lanes.some(lane => source.lanes.includes(lane)),
    )
  }

  // --- reads -------------------------------------------------------------

  async snapshot(): Promise<ConsoleResult<AgentModelsSnapshot>> {
    const nodes = this.#options.nodes()
    const [overview, gateways, facts] = await Promise.all([
      this.#overview(),
      this.#gateways(),
      Promise.all(nodes.map(node => this.#read(node, false))),
    ])
    return ok({
      nodes: nodes.map((node, index) =>
        this.#nodeView(
          node,
          facts[index] ?? { state: 'old' },
          overview,
          gateways.get(node),
        ),
      ),
    })
  }

  #nodeView(
    node: string,
    facts: Facts,
    overview: ProviderOverview | null,
    gateway: Gateway | undefined,
  ): AgentModelsNodeView {
    if (facts.state !== 'ok')
      return {
        node,
        state: facts.state,
        fields: false,
        agents: [],
        error: facts.state === 'unreachable' ? facts.error : null,
      }
    const sources = this.#sources(node, overview, gateway)
    const takesFields = facts.agents.every(
      one => one.configured.fields !== undefined,
    )
    for (const agent of facts.agents) this.#resendIfLost(node, agent)
    return {
      node,
      state: 'ok',
      fields: takesFields,
      agents: facts.agents.map(agent =>
        this.#agentView(node, agent, sources, gateway),
      ),
      error: null,
    }
  }

  /** The node lost what the hub keeps for an agent: send it again, now and then. */
  #resendIfLost(node: string, agent: AgentRuntimeState): void {
    const stored = this.#stored(node, agent.agent)
    const there = agent.configured.fields
    if (
      stored === undefined ||
      there === undefined ||
      sameFields(stored, there)
    )
      return
    const key = `${node}/${agent.agent}`
    const last = this.#resent.get(key)
    if (last !== undefined && this.#now() - last < RESEND_MS) return
    this.#resent.set(key, this.#now())
    this.#track(
      this.#serial(async () => {
        const outcome = await this.#send(node, agent.agent, { fields: stored })
        if (!outcome.ok)
          this.#options.onError?.(
            `${key} 的模型字段没补发上 · ${outcome.message}`,
          )
      }),
    )
  }

  #agentView(
    node: string,
    agent: AgentRuntimeState,
    sources: readonly Source[],
    gateway: Gateway | undefined,
  ): AgentModelsAgentView {
    const runtime = agent.configured.runtime
    const usable = this.#sourcesFor(runtime, sources)
    const viaMagpie =
      gateway !== undefined && this.#options.magpie?.() !== undefined
    const configured =
      agent.configured.model === null || agent.configured.model === 'auto'
        ? ''
        : agent.configured.model
    const mainSpec =
      configured !== '' ? configured : (agent.effective.model ?? '')
    const mainSource = mainSpec === '' ? undefined : profileOf(mainSpec)
    const source = usable.find(one => one.profile.id === mainSource)
    const mainId = mainSpec === '' ? '' : modelOf(mainSpec)
    const facts = (id: string): ModelFacts =>
      source === undefined ? { id } : profileModelFacts(source.profile, id)
    const there = agent.configured.fields
    const stored = this.#stored(node, agent.agent) ?? {}
    const values: Readonly<Record<string, string>> = there ?? stored
    const pendingKeys = new Set(
      there === undefined
        ? Object.keys(stored)
        : Object.keys(stored).filter(key => (there[key] ?? '') !== stored[key]),
    )
    const sameIds = source?.models ?? []
    const fields: AgentModelFieldView[] = agentModelFields(runtime).map(
      field => {
        const base = {
          key: field.key,
          label: field.label,
          kind: field.kind,
          tier: field.tier ?? null,
          sameSource: field.key !== 'model' && field.kind === 'model',
          pending: pendingKeys.has(field.key),
        }
        if (field.key === 'model') {
          const locked =
            viaMagpie && runtimeSpec(runtime)?.lanes.length === 0
              ? '这台节点接在 magpie 上 · qianmopi 跟随节点主模型'
              : null
          return {
            ...base,
            value: configured,
            follows: agent.effective.model ?? null,
            levels: [],
            locked,
          }
        }
        const value = values[field.key] ?? ''
        if (field.kind === 'model') {
          const followed =
            field.tier !== undefined && mainId !== ''
              ? followTier(field.tier, mainId, sameIds)
              : mainId || undefined
          return {
            ...base,
            value,
            follows:
              followed === undefined || mainSource === undefined
                ? null
                : `${mainSource}/${followed}`,
            levels: [],
            locked: null,
          }
        }
        // An effort: of the main model, or of a tier's model (own or followed).
        const of = field.of ?? 'model'
        let modelId = mainId
        if (of !== 'model') {
          const own = values[of]
          modelId =
            own !== undefined && profileOf(own) === mainSource
              ? modelOf(own)
              : (followTier(of as ClaudeTier, mainId, sameIds) ?? mainId)
        }
        const tierLocked =
          field.tier !== undefined && source?.magpie !== true
            ? '这个来源不认按档强度 · 只有 magpie 网关按档固定强度'
            : null
        return {
          ...base,
          value,
          follows: null,
          levels:
            tierLocked === null
              ? effortChoices(
                  runtime,
                  field.key,
                  modelId === '' ? undefined : facts(modelId),
                )
              : [],
          locked: tierLocked,
        }
      },
    )
    return {
      agent: agent.agent,
      runtime,
      runtimeLabel: runtimeSpec(runtime)?.label ?? runtime,
      fields,
      sources: usable.map(
        (one): AgentModelSourceView => ({
          id: one.profile.id,
          name: one.profile.name,
          magpie: one.magpie,
          models: one.models,
        }),
      ),
      source: source?.profile.id ?? mainSource ?? null,
      write: this.#writes.get(`${node}/${agent.agent}`) ?? null,
    }
  }

  // --- writes ------------------------------------------------------------

  async #send(
    node: string,
    agent: string,
    args: Record<string, unknown>,
  ): Promise<ControlOutcome> {
    const key = `${node}/${agent}`
    this.#writes.set(key, { state: 'pending', at: this.#now(), message: null })
    this.#facts.delete(node)
    const outcome = await settle(
      this.#options.control.request(
        node,
        RUNTIME_OPS.configure,
        { agent, ...args },
        ACTOR,
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
    return outcome
  }

  set(
    change: AgentModelChange,
    caller: MagpieCaller,
  ): Promise<ConsoleResult<AgentModelsAgentView>> {
    return this.#serial(async () => {
      if (
        caller.role !== 'ops' ||
        caller.breakGlass ||
        !PERSONAL_SUBJECT.test(caller.subject)
      )
        return failed(
          'rejected',
          '智能体模型需要运维角色的个人账号 · 共用令牌与 break-glass 只能查看',
        )
      const { node, agent: name, field: key, value } = change
      if (!NAME.test(node) || !this.#options.nodes().includes(node))
        return failed('not_found', '控制链路上没有这台节点')
      if (!NAME.test(name)) return failed('invalid', '智能体名无效')
      const facts = await this.#read(node, true)
      if (facts.state === 'old')
        return failed('unsupported', '节点版本过旧 · 先升级节点')
      if (facts.state === 'unreachable')
        return failed('unreachable', `节点连不上 · ${facts.error}`)
      const agent = facts.agents.find(one => one.agent === name)
      if (agent === undefined)
        return failed('not_found', '节点上没有这个智能体')
      const runtime =
        normalizeRuntimeId(agent.configured.runtime) ?? agent.configured.runtime
      const field = agentModelFields(runtime).find(one => one.key === key)
      if (field === undefined)
        return failed(
          'invalid',
          `${runtimeSpec(runtime)?.label ?? runtime} 没有这个字段`,
        )
      if (key !== 'model') {
        const problem = fieldValueProblem(key, value)
        if (problem !== null) return failed('invalid', problem)
      }
      const [overview, gateways] = await Promise.all([
        this.#overview(),
        this.#gateways(),
      ])
      const gateway = gateways.get(node)
      const usable = this.#sourcesFor(
        runtime,
        this.#sources(node, overview, gateway),
      )
      const view = (state: AgentRuntimeState = agent) =>
        ok(
          this.#agentView(
            node,
            state,
            this.#sources(node, overview, gateway),
            gateway,
          ),
        )
      if (key === 'model')
        return this.#setModel(
          node,
          agent,
          runtime,
          value,
          usable,
          gateway,
          caller,
          view,
        )
      // A tier, small model or effort.
      const configured =
        agent.configured.model === null || agent.configured.model === 'auto'
          ? undefined
          : agent.configured.model
      const mainSource = profileOf(configured ?? agent.effective.model ?? '')
      if (field.kind === 'model' && value !== '') {
        if (mainSource === undefined)
          return failed('invalid', '主模型还没定 · 先选主模型')
        if (profileOf(value) !== mainSource)
          return failed(
            'invalid',
            '分档与小模型要和主模型同一来源 · 它们走主模型的地址与密钥',
          )
        // A model id the list lacks is taken as typed (the picker's direct
        // entry): the node compiles any id under an applied profile.
      }
      if (field.kind === 'effort' && value !== '') {
        if (!effortVocabulary(runtime, key).some(level => level === value))
          return failed('invalid', `${field.label} 不能是 ${value}`)
        if (field.tier !== undefined) {
          const source = usable.find(one => one.profile.id === mainSource)
          if (source?.magpie !== true)
            return failed(
              'invalid',
              '这个来源不认按档强度 · 只有 magpie 网关按档固定强度',
            )
        }
      }
      const before = agent.configured.fields ?? this.#stored(node, name) ?? {}
      const next: Record<string, string> = { ...before }
      if (value === '') delete next[key]
      else next[key] = value
      if (agent.configured.fields === undefined) {
        // A node that predates fields: kept here, sent once it takes them.
        try {
          this.#save(node, name, next)
        } catch (error) {
          return failed('unreachable', `中枢状态写不进去 · ${messageOf(error)}`)
        }
        return view({
          ...agent,
          configured: { ...agent.configured },
        })
      }
      const outcome = await this.#send(node, name, { fields: next })
      if (!outcome.ok) return { ok: false, failure: fromNode(outcome) }
      try {
        this.#save(node, name, next)
      } catch (error) {
        this.#options.onError?.(
          `agent-models.json 写不进去 · ${messageOf(error)}`,
        )
      }
      const answered = agentStateRead(outcome.value)
      return view(
        answered ?? {
          ...agent,
          configured: { ...agent.configured, fields: next },
        },
      )
    })
  }

  async #setModel(
    node: string,
    agent: AgentRuntimeState,
    runtime: string,
    value: string,
    usable: readonly Source[],
    gateway: Gateway | undefined,
    caller: MagpieCaller,
    view: (state?: AgentRuntimeState) => ConsoleResult<AgentModelsAgentView>,
  ): Promise<ConsoleResult<AgentModelsAgentView>> {
    if (value !== '' && !MODEL_SPEC.test(value))
      return failed('invalid', '模型要写成 <档案>/<模型号>')
    const magpie = this.#options.magpie?.()
    if (gateway !== undefined && magpie !== undefined) {
      // On its own magpie profile: the gateway section's choice, as before.
      if (value !== '' && profileOf(value) !== gateway.profileId)
        return failed(
          'invalid',
          '这台节点接在 magpie 上 · 模型从它的网关密钥里选',
        )
      const result = await magpie.configure(
        {
          node,
          agent: agent.agent,
          model: value === '' ? 'auto' : modelOf(value),
        },
        caller,
      )
      this.#facts.delete(node)
      if (!result.ok) return result
      const fresh = await this.#read(node, true)
      const state =
        fresh.state === 'ok'
          ? fresh.agents.find(one => one.agent === agent.agent)
          : undefined
      return view(state ?? agent)
    }
    if (value !== '') {
      const source = usable.find(one => one.profile.id === profileOf(value))
      if (source === undefined)
        return failed(
          'invalid',
          `这台节点上没有 ${runtimeSpec(runtime)?.label ?? runtime} 能用的这个来源`,
        )
    }
    const outcome = await this.#send(node, agent.agent, {
      model: value === '' ? null : value,
    })
    if (!outcome.ok) return { ok: false, failure: fromNode(outcome) }
    const answered = agentStateRead(outcome.value)
    return view(
      answered ?? {
        ...agent,
        configured: { ...agent.configured, model: value === '' ? null : value },
      },
    )
  }
}
