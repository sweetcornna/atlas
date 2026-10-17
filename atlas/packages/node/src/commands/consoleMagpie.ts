// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 平台模型网关 magpie 的中枢端口（P33/P34，`--magpie`）。
 *
 * magpie 作为平台的网关服务跑（`magpie serve --web=127.0.0.1:3430`），网关开在
 * 网络上、带 TLS、要求网关密钥。节点拿中枢签发的密钥直连网关；**中枢从不转发
 * 模型流量**（章程 N-5 v2.22、R-9），只调 magpie 的管理接口，外加两样只读：
 * 网关的 `/api/hello` 与 `/v1/models`。
 *
 * ## 一把密钥就是一份模型档案
 *
 * 绑定一个节点 = 中枢生成密钥值（`qm-gw-` 加 32 字节随机，不以 `sk-magpie-`
 * 开头）→ 在 magpie 建同值的密钥并写死模型白名单 → 经 `ProviderPort` 写档案
 * `magpie-<kind>-<id>`（预设 `magpie`，密钥只进模型服务的密文库）→ 指派 → 下发。
 * 编译、下发、切换都是模型服务原来那一套，这里没有第二个调度器。magpie 一侧只
 * 记密钥的名字与 id；本文件的状态里也只有名字与 id。
 *
 * ## L-6
 *
 * 每把密钥都带显式白名单，只含 API 密钥上游（`provider/*`）与全由它们组成的
 * 路由组（`@qianmo/magpie` 的 `eligiblePatterns`）；订阅账号与借用客户端身份的
 * 上游永远不在内。magpie 那边的上游与路由组会变，所以每次改动之后、以及每 10
 * 分钟，都把每把密钥的白名单改回合格范围。
 *
 * ## 文件
 *
 * - `qianmoConfigPath('qianmo','console','magpie.json')`：网关与管理地址、最近
 *   一次核对、绑定（0600，整份原子重写）。
 * - 管理密钥（`MAGPIE_WEB_KEY`）封在另一个密文库里，信封与模型密钥同一套
 *   （`ProviderSecretStore`），槽名 `magpie-management:web-key` 绑进附加数据，
 *   主密钥也是单独一把。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type {
  ConsoleFailure,
  ConsoleResult,
  MagpieBinding,
  MagpieCaller,
  MagpieCheckView,
  MagpieConnectDraft,
  MagpieConnectionView,
  MagpieGroupDraft,
  MagpieGroupView,
  MagpieKeyChange,
  MagpieKeyDraft,
  MagpieKeyView,
  MagpieLane,
  MagpieLimitDraft,
  MagpieLimitView,
  MagpiePort,
  MagpieProviderDraft,
  MagpieProviderView,
  MagpieSnapshot,
  MagpieTestView,
  MagpieUsagePeriod,
  MagpieUsageView,
  ProviderAssignment,
  ProviderCaller,
  ProviderFailure,
  ProviderOverview,
  ProviderPort,
  ProviderProfileDraft,
} from '@qianmo/console'
import {
  checkOrigin,
  eligiblePatterns,
  groupEligible,
  ineligiblePatterns,
  MagpieClient,
  MagpieError,
  type MagpieGroup,
  type MagpieKey,
  type MagpieLimit,
  type MagpieProvider,
  NO_MODEL_PATTERN,
} from '@qianmo/magpie'
import { presetById } from '@qianmo/providers'
import { writePrivateJson } from '../providers/store.js'
import { ProviderSecretStore } from './consoleProvidersSecrets.js'

const PERSONAL_SUBJECT = /^u:[0-9a-f]{16}$/
const NODE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
/** What a delivered profile accepts as a model id (`@qianmo/providers`). */
const PROFILE_MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._:/~@+-]{0,127}$/
const MANAGEMENT_SLOT = { profileId: 'magpie-management', keyId: 'web-key' }
const GATEWAY_KEY_ID = 'gw'
const CHECK_EVERY_MS = 10 * 60 * 1000
const SNAPSHOT_TTL_MS = 2_000

interface BindingRecord {
  readonly kind: 'node' | 'tenant'
  readonly id: string
  readonly keyId: string
  readonly keyName: string
  readonly profileId: string
  readonly lane: MagpieLane
  readonly mainModel: string
  readonly fastModel: string | null
  readonly modelsMode: 'all' | 'list'
  /** The chosen list in `list` mode; empty in `all` mode. */
  readonly models: readonly string[]
  /** The node's assignment before it was bound, to give back on removal. */
  readonly previous: ProviderAssignment | null
  readonly createdAt: number
}

interface MagpieState {
  readonly v: 1
  readonly gatewayUrl: string | null
  readonly managementUrl: string | null
  readonly webCookiePort: number | null
  readonly connectedAt: number | null
  readonly lastCheck: MagpieCheckView | null
  readonly bindings: readonly BindingRecord[]
}

const EMPTY_STATE: MagpieState = {
  v: 1,
  gatewayUrl: null,
  managementUrl: null,
  webCookiePort: null,
  connectedAt: null,
  lastCheck: null,
  bindings: [],
}

export interface ConsoleMagpieOptions {
  readonly statePath: string
  readonly secretsPath: string
  readonly keyPath: string
  readonly providers: ProviderPort
  /** The tenants a key may be bound to (P35). */
  readonly tenants?: () => readonly string[]
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly checkEveryMs?: number
  readonly onError?: (message: string) => void
}

type Result<T> = ConsoleResult<T>
type Failure = { readonly ok: false; readonly failure: ConsoleFailure }

function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

function failed(code: ConsoleFailure['code'], message: string): Failure {
  return { ok: false, failure: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A magpie client error as the console's failure. */
function fromMagpie(error: unknown): Failure {
  if (!(error instanceof MagpieError)) {
    return failed('unreachable', `模型网关出错 · ${messageOf(error)}`)
  }
  switch (error.code) {
    case 'magpie_bad_url':
    case 'magpie_invalid':
      return failed('invalid', error.message)
    case 'magpie_auth':
    case 'magpie_rejected':
      return failed('refused', error.message)
    case 'magpie_not_found':
      return failed('not_found', error.message)
    default:
      return failed('unreachable', error.message)
  }
}

/** A model service failure as the console's failure. */
function fromProviders(failure: ProviderFailure): Failure {
  const message = `模型服务 · ${failure.message}`
  switch (failure.code) {
    case 'invalid':
    case 'conflict':
    case 'in_use':
      return failed('invalid', message)
    case 'not_found':
      return failed('not_found', message)
    case 'rejected':
      return failed('rejected', message)
    case 'refused':
      return failed('refused', message)
    default:
      return failed('unreachable', message)
  }
}

function bindingKey(binding: MagpieBinding): string {
  return `${binding.kind}:${binding.id}`
}

function sameBinding(a: MagpieBinding, b: MagpieBinding): boolean {
  return a.kind === b.kind && a.id === b.id
}

/** `magpie-<kind>-<id>`, made to fit a profile id (`[a-z0-9-]{1,48}`). */
export function magpieProfileId(binding: MagpieBinding): string {
  const slug = binding.id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = `magpie-${binding.kind}-${slug}`
  if (slug === binding.id && base.length <= 48) return base
  const hash = createHash('sha256')
    .update(bindingKey(binding))
    .digest('hex')
    .slice(0, 8)
  return `${base.slice(0, 39).replace(/-+$/, '')}-${hash}`
}

/** A gateway key value of ours: never magpie's `sk-magpie-` prefix. */
function newSecret(): string {
  return `qm-gw-${randomBytes(32).toString('base64url')}`
}

/** Does a key list let `id` through (`access.ModelAllowed`, plus group naming)? */
function allows(patterns: readonly string[], id: string): boolean {
  return patterns.some(pattern => {
    if (pattern.toLowerCase() === id.toLowerCase()) return true
    if (!pattern.includes('*')) return false
    const source = pattern
      .split('*')
      .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    return new RegExp(`^${source}$`, 'i').test(id)
  })
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length === b.length &&
    [...a].sort().join('\n') === [...b].sort().join('\n')
  )
}

function parseState(text: string): MagpieState | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw['v'] !== 1 || !Array.isArray(raw['bindings']))
    return null
  const text_ = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' ? value : null
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null
  const bindings: BindingRecord[] = []
  for (const entry of raw['bindings']) {
    if (!isRecord(entry)) return null
    const kind = entry['kind']
    if (kind !== 'node' && kind !== 'tenant') return null
    const id = text_(entry['id'])
    const keyId = text_(entry['keyId'])
    const keyName = text_(entry['keyName'])
    const profileId = text_(entry['profileId'])
    const mainModel = text_(entry['mainModel'])
    const lane = entry['lane']
    if (
      id === null ||
      keyId === null ||
      keyName === null ||
      profileId === null ||
      mainModel === null ||
      (lane !== 'anthropic' &&
        lane !== 'openai-responses' &&
        lane !== 'openai-chat')
    )
      return null
    const previous = entry['previous']
    bindings.push({
      kind,
      id,
      keyId,
      keyName,
      profileId,
      lane,
      mainModel,
      fastModel: text_(entry['fastModel']),
      modelsMode: entry['modelsMode'] === 'list' ? 'list' : 'all',
      models: Array.isArray(entry['models'])
        ? entry['models'].filter(
            (one): one is string => typeof one === 'string',
          )
        : [],
      previous: isRecord(previous)
        ? (previous as unknown as ProviderAssignment)
        : null,
      createdAt: number(entry['createdAt']) ?? 0,
    })
  }
  const check = raw['lastCheck']
  return {
    v: 1,
    gatewayUrl: text_(raw['gatewayUrl']),
    managementUrl: text_(raw['managementUrl']),
    webCookiePort: number(raw['webCookiePort']),
    connectedAt: number(raw['connectedAt']),
    lastCheck: isRecord(check) ? (check as unknown as MagpieCheckView) : null,
    bindings,
  }
}

function limitView(
  limit: MagpieLimit,
  used: MagpieKey['used'][number] | undefined,
): MagpieLimitView {
  return {
    period: limit.period,
    days: limit.days ?? null,
    hours: limit.hours ?? null,
    tokens: limit.tokens ?? null,
    cost: limit.cost ?? null,
    cacheReads: limit.cacheReads === true,
    tokensUsed: used?.tokensUsed ?? null,
    costUsed: used?.costUsed ?? null,
    spent: used?.spent === true,
    reset: used?.reset ?? null,
  }
}

function limitOf(draft: MagpieLimitDraft): MagpieLimit {
  return {
    period: draft.period,
    ...(draft.days === undefined ? {} : { days: draft.days }),
    ...(draft.hours === undefined ? {} : { hours: draft.hours }),
    ...(draft.tokens === undefined ? {} : { tokens: draft.tokens }),
    ...(draft.cost === undefined ? {} : { cost: draft.cost }),
    ...(draft.cacheReads === true ? { cacheReads: true } : {}),
  }
}

function providerView(provider: MagpieProvider): MagpieProviderView {
  return {
    id: provider.id,
    name: provider.name,
    preset: provider.preset,
    host: provider.host,
    enabled: provider.enabled,
    ready: provider.ready,
    models: provider.models,
    access: provider.access,
    plan: provider.plan,
  }
}

function groupView(
  group: MagpieGroup,
  providers: readonly MagpieProvider[],
  groups: readonly MagpieGroup[],
): MagpieGroupView {
  return {
    id: group.id,
    name: group.name,
    members: group.members,
    matched: group.matched,
    match: group.match,
    routing: group.routing,
    affinity: group.affinity,
    ready: group.ready,
    eligible: groupEligible(group, providers, groups),
  }
}

/** The models a key may point a profile at: eligible upstreams' models and groups. */
function modelChoices(
  providers: readonly MagpieProvider[],
  groups: readonly MagpieGroup[],
): string[] {
  const out: string[] = []
  for (const provider of providers) {
    if (provider.access !== 'key' || !provider.enabled) continue
    for (const model of provider.modelIds) out.push(`${provider.id}/${model}`)
  }
  for (const group of groups) {
    if (groupEligible(group, providers, groups)) out.push(`group/${group.id}`)
  }
  return out.filter(id => PROFILE_MODEL_ID.test(id)).slice(0, 1000)
}

/**
 * What a node goes back to when its key is removed: the profile it had, or
 * the default; never nothing, which would leave it on the removed key.
 */
function fallbackOf(
  record: BindingRecord,
  overview: ProviderOverview,
): ProviderAssignment | null {
  const exists = (id: string) =>
    id !== record.profileId &&
    overview.profiles.some(one => one.profile.id === id)
  const previous = record.previous
  if (previous?.mode === 'profile' && exists(previous.profileId))
    return previous
  const fallback = overview.defaultProfileId
  return fallback !== null && exists(fallback) ? { mode: 'inherit' } : null
}

interface MagpieRead {
  readonly providers: readonly MagpieProvider[]
  readonly groups: readonly MagpieGroup[]
}

export class ConsoleMagpie implements MagpiePort {
  readonly #options: ConsoleMagpieOptions
  readonly #secrets: ProviderSecretStore
  readonly #now: () => number
  #state: MagpieState = EMPTY_STATE
  #problem: string | null = null
  #queue: Promise<unknown> = Promise.resolve()
  #timer: ReturnType<typeof setInterval> | null = null
  #cache: { readonly at: number; readonly value: MagpieSnapshot } | null = null

  constructor(options: ConsoleMagpieOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#secrets = new ProviderSecretStore({
      secretsPath: options.secretsPath,
      keyPath: options.keyPath,
    })
    let text: string | null = null
    try {
      text = readFileSync(options.statePath, 'utf8')
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT')
        this.#problem = `网关状态文件读不了 · ${messageOf(error)}`
    }
    if (text !== null) {
      const parsed = parseState(text)
      if (parsed === null) this.#problem = '网关状态文件无法解析 · 不会覆盖它'
      else this.#state = parsed
    }
  }

  /** Why writes are refused, or null. */
  get problem(): string | null {
    return this.#problem ?? this.#secrets.problem
  }

  /** Begin the periodic check (after the console is up). */
  start(): void {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => {
      void this.#serial(() => this.#check()).catch(error =>
        this.#options.onError?.(messageOf(error)),
      )
    }, this.#options.checkEveryMs ?? CHECK_EVERY_MS)
    this.#timer.unref?.()
  }

  close(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  // --- plumbing ----------------------------------------------------------

  /** One write at a time: "read magpie, then change it" must not interleave. */
  #serial<T>(run: () => Promise<T>): Promise<T> {
    this.#cache = null
    const next = this.#queue.then(run, run).finally(() => {
      // A snapshot taken while this ran may hold the state from before it.
      this.#cache = null
    })
    this.#queue = next.catch(() => {})
    return next
  }

  #save(next: MagpieState): void {
    writePrivateJson(this.#options.statePath, next)
    this.#state = next
    this.#cache = null
  }

  #authorize(caller: MagpieCaller): Failure | null {
    if (
      caller.breakGlass ||
      caller.role !== 'ops' ||
      !PERSONAL_SUBJECT.test(caller.subject)
    )
      return failed('rejected', '模型网关的这一步需要运维角色的个人账号')
    const problem = this.problem
    if (problem !== null) return failed('unsupported', problem)
    return null
  }

  #providerCaller(caller: MagpieCaller): ProviderCaller {
    return {
      subject: caller.subject,
      role: caller.role,
      breakGlass: caller.breakGlass,
      record: (action, target, outcome, code) =>
        caller.record(action, target, outcome, code),
    }
  }

  #webKey(): string | null {
    try {
      return this.#secrets.reveal(MANAGEMENT_SLOT)
    } catch {
      return null
    }
  }

  #client(): MagpieClient | Failure {
    const { managementUrl, gatewayUrl, webCookiePort } = this.#state
    if (managementUrl === null || gatewayUrl === null)
      return failed('invalid', '还没有连接 magpie')
    const webKey = this.#webKey()
    if (webKey === null) return failed('invalid', '没有 magpie 管理密钥')
    try {
      return new MagpieClient({
        managementUrl,
        gatewayUrl,
        webKey,
        ...(webCookiePort === null ? {} : { webCookiePort }),
        ...(this.#options.fetch === undefined
          ? {}
          : { fetch: this.#options.fetch }),
      })
    } catch (error) {
      return fromMagpie(error)
    }
  }

  async #read(client: MagpieClient): Promise<MagpieRead> {
    const [providers, groups] = await Promise.all([
      client.listProviders(),
      client.listGroups(),
    ])
    return { providers, groups }
  }

  /** What a binding's key may use now. */
  #target(record: BindingRecord, read: MagpieRead): readonly string[] {
    const eligible = eligiblePatterns(read.providers, read.groups)
    if (record.modelsMode === 'all') return eligible
    const bad = new Set(
      ineligiblePatterns(record.models, read.providers, read.groups),
    )
    const kept = record.models.filter(model => !bad.has(model))
    return kept.length === 0 ? [NO_MODEL_PATTERN] : kept
  }

  /** Bring every key's list back within what is eligible (L-6). */
  async #reconcile(client: MagpieClient, read?: MagpieRead): Promise<void> {
    if (this.#state.bindings.length === 0) return
    const now = read ?? (await this.#read(client))
    const keys = await client.listKeys()
    for (const record of this.#state.bindings) {
      const key = keys.find(one => one.id === record.keyId)
      if (key === undefined) continue
      const target = this.#target(record, now)
      if (!sameList(key.models, target))
        await client.setKeyModels(key.id, target)
    }
  }

  async #nodes(): Promise<readonly string[]> {
    const overview = await this.#options.providers.overview()
    return overview.ok ? overview.value.nodes.map(node => node.node) : []
  }

  #tenants(): readonly string[] {
    try {
      return this.#options.tenants?.() ?? []
    } catch {
      return []
    }
  }

  #connection(): MagpieConnectionView {
    const state = this.#state
    return {
      configured: state.managementUrl !== null && state.gatewayUrl !== null,
      gatewayUrl: state.gatewayUrl,
      managementUrl: state.managementUrl,
      keySet: this.#secrets.fingerprint(MANAGEMENT_SLOT) !== null,
      connectedAt: state.connectedAt,
      check: state.lastCheck,
    }
  }

  #keyView(
    record: BindingRecord,
    key: MagpieKey | null | undefined,
  ): MagpieKeyView {
    return {
      binding: { kind: record.kind, id: record.id },
      keyId: record.keyId,
      keyName: record.keyName,
      profileId: record.profileId,
      lane: record.lane,
      mainModel: record.mainModel,
      fastModel: record.fastModel,
      modelsMode: record.modelsMode,
      models: key?.models ?? record.models,
      enabled: key === null || key === undefined ? null : key.enabled,
      masked: key?.masked ?? null,
      limits:
        key === null || key === undefined
          ? []
          : key.limits.map((limit, index) => limitView(limit, key.used[index])),
      createdAt: record.createdAt,
      present: key === null ? null : key !== undefined,
    }
  }

  /** Ask magpie and the gateway whether they answer, and how. */
  async #probe(client: MagpieClient): Promise<MagpieCheckView> {
    const at = this.#now()
    let version: string | null = null
    try {
      version = (await client.info()).version
    } catch (error) {
      return {
        at,
        ok: false,
        version: null,
        gateway: 'unreachable',
        code: error instanceof MagpieError ? error.code : 'magpie_unreachable',
      }
    }
    let gateway: MagpieCheckView['gateway'] = 'unreachable'
    try {
      await client.hello()
      gateway = 'open'
    } catch (error) {
      if (error instanceof MagpieError && error.code === 'magpie_auth')
        gateway = error.status === 403 ? 'closed' : 'keyed'
    }
    return { at, ok: true, version, gateway, code: null }
  }

  async #check(): Promise<MagpieCheckView | null> {
    const client = this.#client()
    if (!(client instanceof MagpieClient)) return null
    const check = await this.#probe(client)
    if (check.ok) await this.#reconcile(client)
    this.#save({ ...this.#state, lastCheck: check })
    return check
  }

  // --- reads -------------------------------------------------------------

  async snapshot(): Promise<Result<MagpieSnapshot>> {
    const cached = this.#cache
    if (cached !== null && this.#now() - cached.at < SNAPSHOT_TTL_MS)
      return ok(cached.value)
    const [nodes, tenants] = [await this.#nodes(), this.#tenants()]
    const base = {
      connection: this.#connection(),
      nodes,
      tenants,
    }
    const local = (problem: MagpieSnapshot['problem']): MagpieSnapshot => ({
      ...base,
      problem,
      providers: [],
      presets: [],
      groups: [],
      keys: this.#state.bindings.map(record => this.#keyView(record, null)),
      models: [],
    })
    if (!base.connection.configured) return ok(local(null))
    const client = this.#client()
    if (!(client instanceof MagpieClient))
      return ok(local({ code: 'magpie_auth', message: client.failure.message }))
    try {
      const [read, presets, keys] = await Promise.all([
        this.#read(client),
        client.listPresets(),
        client.listKeys(),
      ])
      const value: MagpieSnapshot = {
        ...base,
        problem: null,
        providers: read.providers.map(providerView),
        presets: presets.map(preset => ({
          id: preset.id,
          name: preset.name,
          kind: preset.kind,
          noKey: preset.noKey,
        })),
        groups: read.groups.map(group =>
          groupView(group, read.providers, read.groups),
        ),
        keys: this.#state.bindings.map(record =>
          this.#keyView(
            record,
            keys.find(key => key.id === record.keyId),
          ),
        ),
        models: modelChoices(read.providers, read.groups),
      }
      this.#cache = { at: this.#now(), value }
      return ok(value)
    } catch (error) {
      const code =
        error instanceof MagpieError ? error.code : 'magpie_unreachable'
      return ok(local({ code, message: messageOf(error) }))
    }
  }

  async usage(period: MagpieUsagePeriod): Promise<Result<MagpieUsageView>> {
    const client = this.#client()
    if (!(client instanceof MagpieClient)) return client
    try {
      const usage = await client.usage(period)
      return ok({
        period: usage.period,
        since: usage.since,
        totals: usage.totals,
        models: usage.models,
        keys: usage.keys.map(row => {
          const record = this.#state.bindings.find(
            one => one.keyId === row.keyId,
          )
          return {
            ...row,
            binding:
              record === undefined
                ? null
                : { kind: record.kind, id: record.id },
          }
        }),
      })
    } catch (error) {
      return fromMagpie(error)
    }
  }

  // --- connection --------------------------------------------------------

  connect(
    draft: MagpieConnectDraft,
    caller: MagpieCaller,
  ): Promise<Result<MagpieConnectionView>> {
    return this.#serial(async () => {
      const denied = this.#authorize(caller)
      if (denied !== null) return denied
      let gatewayUrl: string
      let managementUrl: string
      try {
        gatewayUrl = checkOrigin(draft.gatewayUrl)
        managementUrl = checkOrigin(draft.managementUrl)
      } catch (error) {
        return fromMagpie(error)
      }
      const port = draft.webCookiePort
      if (
        port !== undefined &&
        (!Number.isInteger(port) || port < 1 || port > 65535)
      )
        return failed('invalid', '管理页端口不对')
      const webKey = draft.managementKey ?? this.#webKey()
      if (webKey === null || webKey === '')
        return failed('invalid', '要填 magpie 管理密钥')
      let client: MagpieClient
      try {
        client = new MagpieClient({
          managementUrl,
          gatewayUrl,
          webKey,
          ...(port === undefined ? {} : { webCookiePort: port }),
          ...(this.#options.fetch === undefined
            ? {}
            : { fetch: this.#options.fetch }),
        })
      } catch (error) {
        return fromMagpie(error)
      }
      const check = await this.#probe(client)
      if (!check.ok)
        return failed(
          check.code === 'magpie_auth' ? 'refused' : 'unreachable',
          check.code === 'magpie_auth'
            ? 'magpie 不认这个管理密钥'
            : `连不上 magpie 管理接口 · ${check.code ?? ''}`,
        )
      if (draft.managementKey !== undefined) {
        try {
          this.#secrets.commit(MANAGEMENT_SLOT.profileId, 1, [], {
            [MANAGEMENT_SLOT.keyId]: draft.managementKey,
          })
        } catch (error) {
          return failed('unreachable', `管理密钥封存失败 · ${messageOf(error)}`)
        }
      }
      const moved =
        this.#state.gatewayUrl !== null && this.#state.gatewayUrl !== gatewayUrl
      this.#save({
        ...this.#state,
        gatewayUrl,
        managementUrl,
        webCookiePort: port ?? null,
        connectedAt: this.#state.connectedAt ?? this.#now(),
        lastCheck: check,
      })
      if (moved) await this.#repoint(caller)
      return ok(this.#connection())
    })
  }

  /** The gateway moved: every binding's profile follows it, nodes get it. */
  async #repoint(caller: MagpieCaller): Promise<void> {
    const providers = this.#options.providers
    const pcaller = this.#providerCaller(caller)
    for (const record of this.#state.bindings) {
      const revision = await this.#revision(record.profileId)
      if (revision === null) continue
      const saved = await providers.saveProfile(
        { profile: this.#profileDraft(record), ifMatch: revision },
        pcaller,
      )
      if (!saved.ok) {
        this.#options.onError?.(
          `${record.profileId} 没能改到新网关地址 · ${saved.failure.message}`,
        )
        continue
      }
      if (record.kind === 'node') {
        const applied = await providers.apply({ nodes: [record.id] }, pcaller)
        if (!applied.ok)
          this.#options.onError?.(
            `下发到 ${record.id} 失败 · ${applied.failure.message}`,
          )
      }
    }
  }

  check(caller: MagpieCaller): Promise<Result<MagpieConnectionView>> {
    return this.#serial(async () => {
      const denied = this.#authorize(caller)
      if (denied !== null) return denied
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      try {
        await this.#check()
      } catch (error) {
        return fromMagpie(error)
      }
      return ok(this.#connection())
    })
  }

  // --- upstreams ---------------------------------------------------------

  async #keyProvider(
    client: MagpieClient,
    id: string,
  ): Promise<Result<MagpieProvider>> {
    const provider = (await client.listProviders()).find(one => one.id === id)
    if (provider === undefined) return failed('not_found', '没有这个上游')
    if (provider.access !== 'key')
      return failed(
        'rejected',
        '订阅账号与客户端身份的上游阡陌不用 · 不在这里改',
      )
    return ok(provider)
  }

  saveProvider(
    draft: MagpieProviderDraft,
    caller: MagpieCaller,
  ): Promise<Result<MagpieProviderView>> {
    return this.#serial(async () => {
      const denied = this.#authorize(caller)
      if (denied !== null) return denied
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      try {
        const presets = await client.listPresets()
        if (!presets.some(preset => preset.id === draft.preset))
          return failed('rejected', '这个预设不能用 · 只收用 API 密钥的上游')
        const added = await client.saveProvider({
          preset: draft.preset,
          ...(draft.key === undefined ? {} : { key: draft.key }),
          ...(draft.name === undefined ? {} : { name: draft.name }),
        })
        await this.#reconcile(client)
        return ok(providerView(added))
      } catch (error) {
        return fromMagpie(error)
      }
    })
  }

  setProviderEnabled(
    id: string,
    on: boolean,
    caller: MagpieCaller,
  ): Promise<Result<MagpieProviderView>> {
    return this.#serial(async () => {
      const denied = this.#authorize(caller)
      if (denied !== null) return denied
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      try {
        const found = await this.#keyProvider(client, id)
        if (!found.ok) return found
        const after = await client.setProviderEnabled(id, on)
        const provider = after.find(one => one.id === id)
        if (provider === undefined) return failed('not_found', '没有这个上游')
        return ok(providerView(provider))
      } catch (error) {
        return fromMagpie(error)
      }
    })
  }

  testProvider(
    id: string,
    caller: MagpieCaller,
  ): Promise<Result<readonly MagpieTestView[]>> {
    return this.#serial(async () => {
      const denied = this.#authorize(caller)
      if (denied !== null) return denied
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      try {
        const found = await this.#keyProvider(client, id)
        if (!found.ok) return found
        return ok(await client.testProvider(id))
      } catch (error) {
        return fromMagpie(error)
      }
    })
  }

  /** The bindings whose profile points at `prefix` (a provider or a group). */
  #usedBy(match: (model: string) => boolean): readonly BindingRecord[] {
    return this.#state.bindings.filter(
      record =>
        match(record.mainModel) ||
        (record.fastModel !== null && match(record.fastModel)),
    )
  }

  removeProvider(id: string, caller: MagpieCaller): Promise<Result<void>> {
    return this.#serial(async () => {
      const denied = this.#authorize(caller)
      if (denied !== null) return denied
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      const users = this.#usedBy(model => model.startsWith(`${id}/`))
      if (users.length > 0)
        return failed(
          'invalid',
          `${users.map(user => bindingKey(user)).join(' ')} 的模型用着这个上游 · 先改它们`,
        )
      try {
        const found = await this.#keyProvider(client, id)
        if (!found.ok) return found
        await client.deleteProvider(id)
        await this.#reconcile(client)
        return ok(undefined)
      } catch (error) {
        return fromMagpie(error)
      }
    })
  }

  // --- routing groups ----------------------------------------------------

  saveGroup(
    draft: MagpieGroupDraft,
    caller: MagpieCaller,
  ): Promise<Result<MagpieGroupView>> {
    return this.#serial(async () => {
      const denied = this.#authorize(caller)
      if (denied !== null) return denied
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      try {
        const read = await this.#read(client)
        if (draft.members !== undefined) {
          const bad = ineligiblePatterns(
            draft.members,
            read.providers,
            read.groups,
          )
          if (bad.length > 0)
            return failed(
              'rejected',
              `成员里有阡陌不用的上游 · ${bad.slice(0, 3).join(' ')}`,
            )
        }
        if (draft.from !== undefined && draft.from !== draft.id) {
          const users = this.#usedBy(model => model === `group/${draft.from}`)
          if (users.length > 0)
            return failed(
              'invalid',
              '有网关密钥的模型用着这个路由组 · 不能改名',
            )
        }
        const saved = await client.saveGroup(draft)
        const after = await this.#read(client)
        await this.#reconcile(client, after)
        return ok(groupView(saved, after.providers, after.groups))
      } catch (error) {
        return fromMagpie(error)
      }
    })
  }

  removeGroup(id: string, caller: MagpieCaller): Promise<Result<void>> {
    return this.#serial(async () => {
      const denied = this.#authorize(caller)
      if (denied !== null) return denied
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      const users = this.#usedBy(model => model === `group/${id}`)
      if (users.length > 0)
        return failed(
          'invalid',
          `${users.map(user => bindingKey(user)).join(' ')} 的模型用着这个路由组 · 先改它们`,
        )
      try {
        await client.deleteGroup(id)
        await this.#reconcile(client)
        return ok(undefined)
      } catch (error) {
        return fromMagpie(error)
      }
    })
  }

  // --- gateway keys ------------------------------------------------------

  /** Main and fast models: each eligible now and let through by `patterns`. */
  #checkModels(
    read: MagpieRead,
    patterns: readonly string[],
    models: readonly (string | null)[],
  ): Result<void> {
    const choices = modelChoices(read.providers, read.groups)
    for (const model of models) {
      if (model === null) continue
      if (!PROFILE_MODEL_ID.test(model))
        return failed('invalid', `模型 id 不能用 · ${model.slice(0, 80)}`)
      if (!choices.includes(model))
        return failed(
          'rejected',
          `不是合格上游的模型或合格的路由组 · ${model.slice(0, 80)}`,
        )
      if (!allows(patterns, model))
        return failed('invalid', `白名单没有放行 ${model.slice(0, 80)}`)
    }
    return ok(undefined)
  }

  #profileDraft(record: {
    readonly kind: 'node' | 'tenant'
    readonly id: string
    readonly profileId: string
    readonly lane: MagpieLane
    readonly mainModel: string
    readonly fastModel: string | null
  }): ProviderProfileDraft {
    const preset = presetById('magpie')
    const gateway = this.#state.gatewayUrl ?? ''
    const fast =
      record.fastModel !== null && record.fastModel !== record.mainModel
        ? record.fastModel
        : null
    const model = (id: string, role: 'main' | 'fast', tiers: string[]) => ({
      id,
      role,
      tiers,
      capabilities: { mode: 'family' },
      effort: { send: 'auto' },
    })
    return {
      id: record.profileId,
      name: `magpie ${record.kind === 'node' ? '节点' : '租户'} ${record.id}`.slice(
        0,
        40,
      ),
      presetId: 'magpie',
      plan: preset?.plan ?? 'custom',
      site: null,
      lane: record.lane,
      baseUrl: record.lane === 'anthropic' ? gateway : `${gateway}/v1`,
      models:
        fast === null
          ? [
              model(record.mainModel, 'main', [
                'opus',
                'sonnet',
                'haiku',
                'fable',
              ]),
            ]
          : [
              model(record.mainModel, 'main', ['opus', 'sonnet', 'fable']),
              model(fast, 'fast', ['haiku']),
            ],
      compat: record.lane === 'anthropic' ? (preset?.compat ?? {}) : {},
      effortLock: null,
      keySelection: 'fill_first',
      auth: { scheme: 'bearer' },
      keys: [{ id: GATEWAY_KEY_ID, label: 'magpie' }],
      ...(preset === undefined ? {} : { probe: preset.probe }),
      evaluated: false,
    }
  }

  async #revision(profileId: string): Promise<number | null> {
    const profile = await this.#options.providers.profile(profileId)
    return profile.ok ? profile.value.revision : null
  }

  issueKey(
    draft: MagpieKeyDraft,
    caller: MagpieCaller,
  ): Promise<Result<MagpieKeyView>> {
    return this.#serial(async () => {
      const denied = this.#authorize(caller)
      if (denied !== null) return denied
      const { binding } = draft
      if (
        (binding.kind === 'node' && !NODE_ID.test(binding.id)) ||
        (binding.kind === 'tenant' && !TENANT_ID.test(binding.id))
      )
        return failed('invalid', '绑定无效')
      if (this.#state.bindings.some(one => sameBinding(one, binding)))
        return failed('invalid', '这个绑定已有网关密钥 · 要换就轮换或收回')
      const providers = this.#options.providers
      const pcaller = this.#providerCaller(caller)
      let previous: ProviderAssignment | null = null
      if (binding.kind === 'node') {
        const overview = await providers.overview()
        if (!overview.ok) return fromProviders(overview.failure)
        const node = overview.value.nodes.find(one => one.node === binding.id)
        if (node === undefined)
          return failed('not_found', '模型服务里没有这个节点')
        previous = node.assignment
      } else if (!this.#tenants().includes(binding.id)) {
        return failed('not_found', '没有这个租户')
      }
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      const lane = draft.lane ?? 'anthropic'
      const fastModel = draft.fastModel ?? null
      const profileId = magpieProfileId(binding)
      let read: MagpieRead
      try {
        read = await this.#read(client)
      } catch (error) {
        return fromMagpie(error)
      }
      const listMode = draft.models !== undefined && draft.models.length > 0
      const chosen = listMode ? (draft.models ?? []) : []
      if (listMode) {
        const bad = ineligiblePatterns(chosen, read.providers, read.groups)
        if (bad.length > 0)
          return failed(
            'rejected',
            `白名单里有阡陌不用的上游 · ${bad.slice(0, 3).join(' ')}`,
          )
      }
      const patterns = listMode
        ? chosen
        : eligiblePatterns(read.providers, read.groups)
      const checked = this.#checkModels(read, patterns, [
        draft.mainModel,
        fastModel,
      ])
      if (!checked.ok) return checked
      const secret = newSecret()
      const keyName = `qm-${binding.kind}-${binding.id.slice(0, 60)}-${randomUUID()}`
      let key: MagpieKey
      try {
        key = await client.addKey({ name: keyName, secret })
      } catch (error) {
        return fromMagpie(error)
      }
      const undo = async (profileSaved: boolean): Promise<void> => {
        try {
          await client.removeKey(key.id)
        } catch (error) {
          this.#options.onError?.(
            `收回半成的网关密钥失败 · ${messageOf(error)}`,
          )
        }
        if (!profileSaved) return
        const revision = await this.#revision(profileId)
        if (revision !== null)
          await providers.deleteProfile(
            { profileId, ifMatch: revision },
            pcaller,
          )
      }
      try {
        key = await client.setKeyModels(key.id, patterns)
        if (draft.limits !== undefined && draft.limits.length > 0)
          key = await client.setKeyLimits(key.id, draft.limits.map(limitOf))
      } catch (error) {
        await undo(false)
        return fromMagpie(error)
      }
      // The hub may not reach the gateway the nodes reach; when it does, the
      // key must see its main model there.
      try {
        const catalog = await client.catalog(secret)
        if (!catalog.some(model => model.id === draft.mainModel)) {
          await undo(false)
          return failed('invalid', '网关的模型目录里没有主模型 · 已收回密钥')
        }
      } catch (error) {
        this.#options.onError?.(
          `签发后读网关目录失败 · 跳过核对 · ${messageOf(error)}`,
        )
      }
      const record: BindingRecord = {
        kind: binding.kind,
        id: binding.id,
        keyId: key.id,
        keyName,
        profileId,
        lane,
        mainModel: draft.mainModel,
        fastModel,
        modelsMode: listMode ? 'list' : 'all',
        models: chosen,
        previous,
        createdAt: this.#now(),
      }
      const revision = await this.#revision(profileId)
      const saved = await providers.saveProfile(
        {
          profile: this.#profileDraft(record),
          ifMatch: revision,
          secrets: { [GATEWAY_KEY_ID]: secret },
        },
        pcaller,
      )
      if (!saved.ok) {
        await undo(false)
        return fromProviders(saved.failure)
      }
      if (binding.kind === 'node') {
        const assigned = await providers.assign(
          { node: binding.id, assignment: { mode: 'profile', profileId } },
          pcaller,
        )
        if (!assigned.ok) {
          await undo(true)
          return fromProviders(assigned.failure)
        }
      }
      try {
        this.#save({
          ...this.#state,
          bindings: [...this.#state.bindings, record],
        })
      } catch (error) {
        return failed('unreachable', `网关状态写不进去 · ${messageOf(error)}`)
      }
      if (binding.kind === 'node') {
        const applied = await providers.apply({ nodes: [binding.id] }, pcaller)
        if (!applied.ok)
          this.#options.onError?.(
            `下发到 ${binding.id} 失败 · ${applied.failure.message}`,
          )
      }
      return ok(this.#keyView(record, key))
    })
  }

  #record(binding: MagpieBinding): BindingRecord | undefined {
    return this.#state.bindings.find(one => sameBinding(one, binding))
  }

  #replace(record: BindingRecord): void {
    this.#save({
      ...this.#state,
      bindings: this.#state.bindings.map(one =>
        sameBinding(one, record) ? record : one,
      ),
    })
  }

  updateKey(
    binding: MagpieBinding,
    change: MagpieKeyChange,
    caller: MagpieCaller,
  ): Promise<Result<MagpieKeyView>> {
    return this.#serial(async () => {
      const denied = this.#authorize(caller)
      if (denied !== null) return denied
      const current = this.#record(binding)
      if (current === undefined) return failed('not_found', '没有这把网关密钥')
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      const providers = this.#options.providers
      const pcaller = this.#providerCaller(caller)
      try {
        const read = await this.#read(client)
        let record = current
        if (change.models !== undefined) {
          if (change.models === null) {
            record = { ...record, modelsMode: 'all', models: [] }
          } else {
            const bad = ineligiblePatterns(
              change.models,
              read.providers,
              read.groups,
            )
            if (bad.length > 0)
              return failed(
                'rejected',
                `白名单里有阡陌不用的上游 · ${bad.slice(0, 3).join(' ')}`,
              )
            record = { ...record, modelsMode: 'list', models: change.models }
          }
        }
        if (change.mainModel !== undefined)
          record = { ...record, mainModel: change.mainModel }
        if (change.fastModel !== undefined)
          record = { ...record, fastModel: change.fastModel }
        const target = this.#target(record, read)
        const modelsChanged =
          record.mainModel !== current.mainModel ||
          record.fastModel !== current.fastModel
        if (modelsChanged || change.models !== undefined) {
          const checked = this.#checkModels(read, target, [
            record.mainModel,
            record.fastModel,
          ])
          if (!checked.ok) return checked
        }
        if (change.enabled !== undefined)
          await client.setKeyEnabled(record.keyId, change.enabled)
        if (change.limits !== undefined)
          await client.setKeyLimits(record.keyId, change.limits.map(limitOf))
        if (change.resetLimit !== undefined)
          await client.resetKeyLimit(
            record.keyId,
            change.resetLimit === 'all' ? undefined : change.resetLimit,
          )
        if (change.models !== undefined)
          await client.setKeyModels(record.keyId, target)
        if (modelsChanged) {
          const revision = await this.#revision(record.profileId)
          if (revision === null)
            return failed('not_found', '模型服务里没有这份档案')
          const saved = await providers.saveProfile(
            { profile: this.#profileDraft(record), ifMatch: revision },
            pcaller,
          )
          if (!saved.ok) return fromProviders(saved.failure)
        }
        this.#replace(record)
        if (modelsChanged && record.kind === 'node') {
          const applied = await providers.apply({ nodes: [record.id] }, pcaller)
          if (!applied.ok)
            this.#options.onError?.(
              `下发到 ${record.id} 失败 · ${applied.failure.message}`,
            )
        }
        const key = (await client.listKeys()).find(
          one => one.id === record.keyId,
        )
        return ok(this.#keyView(record, key))
      } catch (error) {
        return fromMagpie(error)
      }
    })
  }

  rotateKey(
    binding: MagpieBinding,
    caller: MagpieCaller,
  ): Promise<Result<MagpieKeyView>> {
    return this.#serial(async () => {
      const denied = this.#authorize(caller)
      if (denied !== null) return denied
      const record = this.#record(binding)
      if (record === undefined) return failed('not_found', '没有这把网关密钥')
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      const providers = this.#options.providers
      const pcaller = this.#providerCaller(caller)
      const revision = await this.#revision(record.profileId)
      if (revision === null)
        return failed('not_found', '模型服务里没有这份档案')
      let secret: string
      try {
        secret = (await client.rotateKey(record.keyId)).secret
      } catch (error) {
        return fromMagpie(error)
      }
      const set = await providers.setSecret(
        {
          profileId: record.profileId,
          keyId: GATEWAY_KEY_ID,
          value: secret,
          ifMatch: revision,
        },
        pcaller,
      )
      if (!set.ok)
        return failed(
          'unreachable',
          `magpie 里已换新值 · 写进档案失败 · 请重试轮换 · ${set.failure.message}`,
        )
      if (record.kind === 'node') {
        const applied = await providers.apply({ nodes: [record.id] }, pcaller)
        if (!applied.ok)
          this.#options.onError?.(
            `下发到 ${record.id} 失败 · ${applied.failure.message}`,
          )
      }
      try {
        const key = (await client.listKeys()).find(
          one => one.id === record.keyId,
        )
        return ok(this.#keyView(record, key))
      } catch {
        return ok(this.#keyView(record, null))
      }
    })
  }

  removeKey(
    binding: MagpieBinding,
    caller: MagpieCaller,
  ): Promise<Result<{ readonly profileKept: boolean }>> {
    return this.#serial(async () => {
      const denied = this.#authorize(caller)
      if (denied !== null) return denied
      const record = this.#record(binding)
      if (record === undefined) return failed('not_found', '没有这把网关密钥')
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      const providers = this.#options.providers
      const pcaller = this.#providerCaller(caller)
      if (record.kind === 'node') {
        const overview = await providers.overview()
        if (!overview.ok) return fromProviders(overview.failure)
        const node = overview.value.nodes.find(one => one.node === record.id)
        const onIt =
          node?.assignment.mode === 'profile' &&
          node.assignment.profileId === record.profileId
        if (onIt) {
          // Give the node back a profile of its own first, so it never runs
          // on one whose key is about to stop working.
          const back = fallbackOf(record, overview.value)
          if (back === null)
            return failed(
              'invalid',
              '节点原来没有别的模型档案 · 先在模型服务页给它指定一份再收回',
            )
          const assigned = await providers.assign(
            { node: record.id, assignment: back },
            pcaller,
          )
          if (!assigned.ok) return fromProviders(assigned.failure)
          const applied = await providers.apply({ nodes: [record.id] }, pcaller)
          if (!applied.ok)
            this.#options.onError?.(
              `下发到 ${record.id} 失败 · ${applied.failure.message}`,
            )
        }
      }
      try {
        await client.removeKey(record.keyId)
      } catch (error) {
        // Already gone from magpie is what removal wants anyway.
        if (
          !(error instanceof MagpieError) ||
          (error.code !== 'magpie_rejected' &&
            error.code !== 'magpie_not_found')
        )
          return fromMagpie(error)
      }
      let profileKept = false
      const revision = await this.#revision(record.profileId)
      if (revision !== null) {
        const deleted = await providers.deleteProfile(
          { profileId: record.profileId, ifMatch: revision },
          pcaller,
        )
        profileKept = !deleted.ok
      }
      this.#save({
        ...this.#state,
        bindings: this.#state.bindings.filter(one => !sameBinding(one, record)),
      })
      return ok({ profileKept })
    })
  }
}
