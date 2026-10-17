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
 * ## 公开版：订阅者自己的上游（P35）
 *
 * 公开版不卖模型额度。开通订阅时（`consoleBilling.ts`）给订阅者的租户建一把
 * 「订阅密钥」（`modelsMode: 'tenant'`）：先停用、白名单只有 `NO_MODEL_PATTERN`。
 * 订阅者在订阅页用自己的 API 密钥从 magpie 预设接上游，中枢记下它的 id 与名字
 * （名字以 `qmt-` 开头），之后这把密钥的白名单**恰好**是本租户仍在 magpie 里、
 * id 与名字都对得上的那些上游的 `<id>/*`；一个都没有时回到 `NO_MODEL_PATTERN`
 * 并停用——magpie 把空白名单当作全部模型，所以空列表从不写出。订阅到期也停用。
 * 租户的上游从不进平台密钥的白名单、平台的路由组与平台页的上游列表。
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
  BillingPresetView,
  BillingUpstreamView,
  BillingUsageView,
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
/** The name prefix of every upstream a subscriber connects (P35). */
const TENANT_UPSTREAM_PREFIX = 'qmt-'
const MAX_TENANT_UPSTREAMS = 10
const LIMIT_PERIODS: readonly string[] = [
  'day',
  'week',
  'month',
  'days',
  'hours',
]
const SUBSCRIPTION_KEY = '订阅者的网关密钥随订阅管理 · 这里只能重置限额用量'

interface BindingRecord {
  readonly kind: 'node' | 'tenant'
  readonly id: string
  readonly keyId: string
  readonly keyName: string
  readonly profileId: string
  readonly lane: MagpieLane
  readonly mainModel: string
  readonly fastModel: string | null
  /**
   * `all` and `list` are the platform's keys; `tenant` is a subscriber's
   * (P35), held to the tenant's own upstreams and nothing else.
   */
  readonly modelsMode: 'all' | 'list' | 'tenant'
  /** The chosen list in `list` mode; empty in `all` and `tenant` mode. */
  readonly models: readonly string[]
  /** The node's assignment before it was bound, to give back on removal. */
  readonly previous: ProviderAssignment | null
  readonly createdAt: number
}

/** One upstream a subscriber connected: magpie's id and the name we gave it. */
interface TenantUpstreamRecord {
  readonly id: string
  readonly name: string
  readonly preset: string
  readonly createdAt: number
}

/** A subscriber tenant (P35): whether it is paid up, its plan's caps, its upstreams. */
interface TenantRecord {
  readonly tenant: string
  readonly entitled: boolean
  readonly limits: readonly MagpieLimit[]
  readonly upstreams: readonly TenantUpstreamRecord[]
}

interface MagpieState {
  readonly v: 1
  readonly gatewayUrl: string | null
  readonly managementUrl: string | null
  readonly webCookiePort: number | null
  readonly connectedAt: number | null
  readonly lastCheck: MagpieCheckView | null
  readonly bindings: readonly BindingRecord[]
  readonly tenants: readonly TenantRecord[]
}

const EMPTY_STATE: MagpieState = {
  v: 1,
  gatewayUrl: null,
  managementUrl: null,
  webCookiePort: null,
  connectedAt: null,
  lastCheck: null,
  bindings: [],
  tenants: [],
}

/** A subscriber tenant's gateway as its subscription page shows it. */
export interface TenantGatewayView {
  readonly gateway: 'none' | 'off' | 'on'
  readonly mainModel: string | null
  readonly upstreams: readonly BillingUpstreamView[]
  readonly usage: BillingUsageView | null
}

export interface ConsoleMagpieOptions {
  readonly statePath: string
  readonly secretsPath: string
  readonly keyPath: string
  readonly providers: ProviderPort
  /** The tenants a key may be bound to (P35). */
  readonly tenants?: () => readonly string[]
  /**
   * The public edition (P35): tenant keys come only with a subscription
   * (`ensureTenant`), never from the page. `caller` is the hub's own
   * (`ConsoleProviders.systemCaller`); `onProfile` hears that a tenant's
   * profile changed, so its nodes get it.
   */
  readonly subscriptions?: {
    readonly caller: ProviderCaller
    readonly onProfile?: (tenant: string) => void
  }
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
    case 'edition_public_magpie_only':
      return failed('rejected', message)
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

/**
 * The profile a subscriber's node runs when it is not on its tenant's (P35,
 * 「无模型」): the gateway's address, the model `NO_MODEL_PATTERN` and a key
 * magpie has never been told, so every call is refused. Delivering it is how
 * a node is taken back: an apply replaces every key the node held, while
 * "not managed" leaves the last delivery where it is. No extra lanes, so a
 * node whose capabilities are unknown can still be given it.
 */
export const NO_MODEL_PROFILE = 'magpie-none'

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

/** Whether magpie's limits are the plan's, field by field. */
function sameLimits(
  a: readonly MagpieLimit[],
  b: readonly MagpieLimit[],
): boolean {
  const key = (limit: MagpieLimit) =>
    [
      limit.period,
      limit.days ?? '',
      limit.hours ?? '',
      limit.tokens ?? '',
      limit.cost ?? '',
      limit.cacheReads === true,
    ].join('|')
  return sameList(a.map(key), b.map(key))
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
      modelsMode:
        entry['modelsMode'] === 'list' || entry['modelsMode'] === 'tenant'
          ? entry['modelsMode']
          : 'all',
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
  const tenants: TenantRecord[] = []
  for (const entry of Array.isArray(raw['tenants']) ? raw['tenants'] : []) {
    if (!isRecord(entry)) return null
    const tenant = text_(entry['tenant'])
    if (tenant === null || !Array.isArray(entry['upstreams'])) return null
    const upstreams: TenantUpstreamRecord[] = []
    for (const one of entry['upstreams']) {
      if (!isRecord(one)) return null
      const id = text_(one['id'])
      const name = text_(one['name'])
      if (id === null || name === null) return null
      upstreams.push({
        id,
        name,
        preset: text_(one['preset']) ?? '',
        createdAt: number(one['createdAt']) ?? 0,
      })
    }
    tenants.push({
      tenant,
      entitled: entry['entitled'] === true,
      limits: Array.isArray(entry['limits'])
        ? entry['limits'].filter(
            (one): one is MagpieLimit =>
              isRecord(one) && LIMIT_PERIODS.includes(String(one['period'])),
          )
        : [],
      upstreams,
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
    tenants,
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

  /**
   * Deliver to one node and look at what it answered: a line saying what did
   * not land (also written to the log), or `null` when it took it. A refusal
   * (busy, a local edit, capabilities it has not told) is as much a failure
   * as a node out of reach: the caller must not report the change as done.
   */
  async #deliver(
    node: string,
    pcaller: ProviderCaller,
  ): Promise<string | null> {
    const applied = await this.#options.providers.apply(
      { nodes: [node] },
      pcaller,
    )
    let problem: string | null
    if (!applied.ok) problem = applied.failure.message
    else {
      const bad = applied.value.find(one => one.outcome !== 'ok')
      problem =
        bad === undefined
          ? null
          : `${bad.code ?? bad.outcome}${bad.message === undefined ? '' : ` · ${bad.message}`}`
    }
    if (problem !== null)
      this.#options.onError?.(`下发到 ${node} 没成 · ${problem}`)
    return problem
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

  // --- subscriber tenants (P35) -------------------------------------------

  /** An upstream a subscriber connected, by our records or by its name. */
  #tenantOwned(provider: MagpieProvider): boolean {
    if (provider.name.startsWith(TENANT_UPSTREAM_PREFIX)) return true
    const id = provider.id.toLowerCase()
    return this.#state.tenants.some(tenant =>
      tenant.upstreams.some(one => one.id.toLowerCase() === id),
    )
  }

  /** What the platform's keys, groups and page may see: no subscriber's upstream. */
  #platform(read: MagpieRead): MagpieRead {
    return {
      providers: read.providers.filter(one => !this.#tenantOwned(one)),
      groups: read.groups,
    }
  }

  #tenantRecord(tenant: string): TenantRecord | undefined {
    return this.#state.tenants.find(one => one.tenant === tenant)
  }

  /**
   * A tenant's upstreams that are still its own in magpie: same id, same
   * name, an API-key upstream. A provider magpie later gave the same id to
   * somebody else does not match the name and is not let through.
   */
  #tenantPresent(
    tenant: string,
    read: MagpieRead,
    except?: string,
  ): readonly {
    readonly upstream: TenantUpstreamRecord
    readonly provider: MagpieProvider
  }[] {
    const record = this.#tenantRecord(tenant)
    if (record === undefined) return []
    return record.upstreams.flatMap(upstream => {
      if (upstream.id === except) return []
      const provider = read.providers.find(
        one =>
          one.id === upstream.id &&
          one.name === upstream.name &&
          one.access === 'key',
      )
      return provider === undefined ? [] : [{ upstream, provider }]
    })
  }

  /**
   * A subscriber key's list: its own upstreams (but `except`, one on its way
   * out), else nothing; never empty.
   */
  #tenantPatterns(
    tenant: string,
    read: MagpieRead,
    except?: string,
  ): readonly string[] {
    const present = this.#tenantPresent(tenant, read, except)
    return present.length === 0
      ? [NO_MODEL_PATTERN]
      : present.map(({ upstream }) => `${upstream.id}/*`)
  }

  /** On only while paid up and with an upstream of its own (but `except`). */
  #tenantEnabled(tenant: string, read: MagpieRead, except?: string): boolean {
    return (
      this.#tenantRecord(tenant)?.entitled === true &&
      this.#tenantPresent(tenant, read, except).length > 0
    )
  }

  /** The main model of a subscriber's profile: kept while valid, else the first. */
  #tenantMain(record: BindingRecord, read: MagpieRead): string {
    const models = this.#tenantPresent(record.id, read)
      .flatMap(({ provider }) =>
        provider.modelIds.map(model => `${provider.id}/${model}`),
      )
      .filter(id => PROFILE_MODEL_ID.test(id))
    if (models.includes(record.mainModel)) return record.mainModel
    return models[0] ?? NO_MODEL_PATTERN
  }

  /** What a binding's key may use now. */
  #target(record: BindingRecord, read: MagpieRead): readonly string[] {
    if (record.modelsMode === 'tenant')
      return this.#tenantPatterns(record.id, read)
    const platform = this.#platform(read)
    const eligible = eligiblePatterns(platform.providers, platform.groups)
    if (record.modelsMode === 'all') return eligible
    const bad = new Set(
      ineligiblePatterns(record.models, platform.providers, platform.groups),
    )
    const kept = record.models.filter(model => !bad.has(model))
    return kept.length === 0 ? [NO_MODEL_PATTERN] : kept
  }

  /**
   * Bring every key's list back within what is eligible (L-6); a subscriber
   * key also to on or off, narrowed before it is switched on and switched
   * off before it is narrowed, and its profile to a main model it can use.
   */
  async #reconcile(client: MagpieClient, read?: MagpieRead): Promise<void> {
    if (this.#state.bindings.length === 0) return
    const now = read ?? (await this.#read(client))
    const keys = await client.listKeys()
    for (const record of this.#state.bindings) {
      const key = keys.find(one => one.id === record.keyId)
      if (key === undefined) continue
      const target = this.#target(record, now)
      const tenant = record.modelsMode === 'tenant'
      const enable = tenant && this.#tenantEnabled(record.id, now)
      if (tenant && !enable && key.enabled)
        await client.setKeyEnabled(key.id, false)
      if (!sameList(key.models, target))
        await client.setKeyModels(key.id, target)
      if (tenant && enable && !key.enabled)
        await client.setKeyEnabled(key.id, true)
      if (tenant) await this.#tenantProfile(record, now)
    }
  }

  /** Point a subscriber's profile at a main model its key lets through. */
  async #tenantProfile(record: BindingRecord, read: MagpieRead): Promise<void> {
    const main = this.#tenantMain(record, read)
    const subscriptions = this.#options.subscriptions
    if (main === record.mainModel || subscriptions === undefined) return
    const next: BindingRecord = { ...record, mainModel: main }
    const revision = await this.#revision(record.profileId)
    if (revision === null) return
    const saved = await this.#options.providers.saveProfile(
      { profile: this.#profileDraft(next), ifMatch: revision },
      subscriptions.caller,
    )
    if (!saved.ok) {
      this.#options.onError?.(
        `${record.profileId} 没能换主模型 · ${saved.failure.message}`,
      )
      return
    }
    this.#replace(next)
    subscriptions.onProfile?.(record.id)
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
      // A subscriber's key shows as the list it is held to.
      modelsMode: record.modelsMode === 'tenant' ? 'list' : record.modelsMode,
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
      const platform = this.#platform(read)
      const value: MagpieSnapshot = {
        ...base,
        problem: null,
        providers: platform.providers.map(providerView),
        presets: presets.map(preset => ({
          id: preset.id,
          name: preset.name,
          kind: preset.kind,
          noKey: preset.noKey,
        })),
        groups: read.groups.map(group =>
          groupView(group, platform.providers, platform.groups),
        ),
        keys: this.#state.bindings.map(record =>
          this.#keyView(
            record,
            keys.find(key => key.id === record.keyId),
          ),
        ),
        models: modelChoices(platform.providers, platform.groups),
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
      const problems = moved ? await this.#repoint(caller) : []
      // The public edition takes a subscriber's node back onto no model:
      // that profile exists from the first connection and follows the gateway.
      await this.#ensureNoModel()
      if (problems.length > 0)
        return failed(
          'unreachable',
          `已改到新网关地址 · ${problems.join(' · ')} · 在模型服务页重新下发`,
        )
      return ok(this.#connection())
    })
  }

  /**
   * The gateway moved: every binding's profile follows it, nodes get it.
   * Returns what did not follow (also in the log).
   */
  async #repoint(caller: MagpieCaller): Promise<string[]> {
    const providers = this.#options.providers
    const pcaller = this.#providerCaller(caller)
    const subscriptions = this.#options.subscriptions
    const problems: string[] = []
    for (const record of this.#state.bindings) {
      const revision = await this.#revision(record.profileId)
      if (revision === null) continue
      // A subscriber's profile is the hub's to write (the public edition's
      // wrapper refuses anyone else); its nodes get it through the billing
      // port's node sync, which also retries a delivery that did not land.
      const subscriber =
        record.modelsMode === 'tenant' && subscriptions !== undefined
      const saved = await providers.saveProfile(
        { profile: this.#profileDraft(record), ifMatch: revision },
        subscriber ? subscriptions.caller : pcaller,
      )
      if (!saved.ok) {
        const line = `${record.profileId} 没能改到新网关地址 · ${saved.failure.message}`
        this.#options.onError?.(line)
        problems.push(line)
        continue
      }
      if (subscriber) subscriptions.onProfile?.(record.id)
      else if (record.kind === 'node') {
        const problem = await this.#deliver(record.id, pcaller)
        if (problem !== null)
          problems.push(`下发到 ${record.id} 没成 · ${problem}`)
      }
    }
    return problems
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
    if (this.#tenantOwned(provider))
      return failed(
        'rejected',
        '这个上游是订阅者自己接的 · 由订阅者在订阅页管理',
      )
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
        const urls = {
          ...(draft.chat ? { chat: draft.chat } : {}),
          ...(draft.responses ? { responses: draft.responses } : {}),
          ...(draft.anthropic ? { anthropic: draft.anthropic } : {}),
        }
        const custom = Object.keys(urls).length > 0
        if (draft.preset !== '' && custom)
          return failed('invalid', '选了预设就不填地址')
        if (draft.preset === '' && !custom)
          return failed('invalid', '要选预设或填自定义地址')
        // A custom upstream is given by its URLs and key: magpie classes it
        // as an API key upstream, which is what L-6 lets a key route to.
        if (draft.preset !== '') {
          const presets = await client.listPresets()
          if (!presets.some(preset => preset.id === draft.preset))
            return failed('rejected', '这个预设不能用 · 只收用 API 密钥的上游')
        }
        if (draft.name?.trim().startsWith(TENANT_UPSTREAM_PREFIX))
          return failed('invalid', `名称不能以 ${TENANT_UPSTREAM_PREFIX} 开头`)
        const added = await client.saveProvider({
          preset: draft.preset,
          ...(draft.key === undefined ? {} : { key: draft.key }),
          ...(draft.name === undefined ? {} : { name: draft.name }),
          ...urls,
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
        const read = this.#platform(await this.#read(client))
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
        const platform = this.#platform(after)
        return ok(groupView(saved, platform.providers, platform.groups))
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
    const address = (lane: MagpieLane) =>
      lane === 'anthropic' ? gateway : `${gateway}/v1`
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
      baseUrl: address(record.lane),
      // magpie answers every lane on one port, so the one key also serves the
      // runtimes that speak another protocol (Claude Code, Codex).
      laneAddresses: Object.fromEntries(
        (['anthropic', 'openai-responses', 'openai-chat'] as const)
          .filter(lane => lane !== record.lane)
          .map(lane => [lane, address(lane)]),
      ),
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
      if (
        binding.kind === 'tenant' &&
        this.#options.subscriptions !== undefined
      )
        return failed(
          'rejected',
          '公开版的租户网关密钥随订阅开通 · 模型由订阅者自己接入',
        )
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
        read = this.#platform(await this.#read(client))
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
        const problem = await this.#deliver(binding.id, pcaller)
        if (problem !== null)
          return failed(
            'unreachable',
            `密钥已签发并写进档案 · 下发到 ${binding.id} 没成 · ${problem} · 在模型服务页重新下发`,
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
      if (
        current.modelsMode === 'tenant' &&
        (change.models !== undefined ||
          change.mainModel !== undefined ||
          change.fastModel !== undefined ||
          change.enabled !== undefined ||
          change.limits !== undefined)
      )
        return failed('rejected', SUBSCRIPTION_KEY)
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      const providers = this.#options.providers
      const pcaller = this.#providerCaller(caller)
      try {
        const live = await this.#read(client)
        const read =
          current.modelsMode === 'tenant' ? live : this.#platform(live)
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
          const problem = await this.#deliver(record.id, pcaller)
          if (problem !== null)
            return failed(
              'unreachable',
              `已改进档案 · 下发到 ${record.id} 没成 · ${problem} · 在模型服务页重新下发`,
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
      if (record.modelsMode === 'tenant')
        return failed('rejected', SUBSCRIPTION_KEY)
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
        const problem = await this.#deliver(record.id, pcaller)
        if (problem !== null)
          return failed(
            'unreachable',
            `magpie 里已换新值并写进档案 · 下发到 ${record.id} 没成 · 节点手里的旧值已失效 · ${problem} · 在模型服务页重新下发`,
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
      if (record.modelsMode === 'tenant')
        return failed('rejected', SUBSCRIPTION_KEY)
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
          // The node did not get its own profile back: it still runs on this
          // key, so the key stays. The assignment has moved, so asking again
          // removes it regardless.
          const problem = await this.#deliver(record.id, pcaller)
          if (problem !== null)
            return failed(
              'unreachable',
              `${record.id} 已改回原来的档案 · 下发没成 · ${problem} · 密钥先不收回 · 再收回一次会直接收回`,
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
  // --- subscriber tenants (P35): the hub's own calls -------------------------

  #subscriptionsOpen(): Failure | null {
    if (this.#options.subscriptions === undefined)
      return failed('unsupported', '这个网关没有接订阅')
    const problem = this.problem
    return problem === null ? null : failed('unsupported', problem)
  }

  #saveTenant(next: TenantRecord): void {
    const others = this.#state.tenants.filter(one => one.tenant !== next.tenant)
    this.#save({ ...this.#state, tenants: [...others, next] })
  }

  /**
   * Give a subscriber tenant its gateway key (idempotent): made, held to
   * nothing and switched off before anything else, capped by the plan's
   * fair-use limits, written into profile `magpie-tenant-<id>` with the
   * hub's own caller. The value lives only in the model service's sealed
   * store; magpie and this file know its name and id.
   */
  ensureTenant(
    tenant: string,
    limits: readonly MagpieLimit[],
  ): Promise<Result<{ readonly binding: string }>> {
    return this.#serial(async () => {
      const closed = this.#subscriptionsOpen()
      if (closed !== null) return closed
      const caller = this.#options.subscriptions?.caller
      if (caller === undefined)
        return failed('unsupported', '这个网关没有接订阅')
      if (!TENANT_ID.test(tenant)) return failed('invalid', '租户 id 无效')
      const binding: MagpieBinding = { kind: 'tenant', id: tenant }
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      const existing = this.#record(binding)
      const known = this.#tenantRecord(tenant)
      try {
        if (existing !== undefined) {
          if (existing.modelsMode !== 'tenant')
            return failed(
              'invalid',
              '这个租户已有平台签发的网关密钥 · 先在网关页收回',
            )
          const key = (await client.listKeys()).find(
            one => one.id === existing.keyId,
          )
          if (key === undefined)
            return failed('not_found', 'magpie 里没有这个租户的网关密钥')
          if (!sameLimits(key.limits, limits))
            await client.setKeyLimits(key.id, limits)
          this.#saveTenant({
            tenant,
            entitled: known?.entitled ?? false,
            limits,
            upstreams: known?.upstreams ?? [],
          })
          await this.#reconcile(client)
          return ok({ binding: bindingKey(binding) })
        }
      } catch (error) {
        return fromMagpie(error)
      }
      const providers = this.#options.providers
      const secret = newSecret()
      const keyName = `qm-tenant-${tenant.slice(0, 60)}-${randomUUID()}`
      let key: MagpieKey
      try {
        key = await client.addKey({ name: keyName, secret })
      } catch (error) {
        return fromMagpie(error)
      }
      const undo = async (): Promise<void> => {
        try {
          await client.removeKey(key.id)
        } catch (error) {
          this.#options.onError?.(
            `收回半成的订阅密钥失败 · ${messageOf(error)}`,
          )
        }
      }
      try {
        // Nothing, then off: magpie reads an empty list as every model.
        key = await client.setKeyModels(key.id, [NO_MODEL_PATTERN])
        key = await client.setKeyEnabled(key.id, false)
        if (limits.length > 0) key = await client.setKeyLimits(key.id, limits)
      } catch (error) {
        await undo()
        return fromMagpie(error)
      }
      const record: BindingRecord = {
        kind: 'tenant',
        id: tenant,
        keyId: key.id,
        keyName,
        profileId: magpieProfileId(binding),
        lane: 'anthropic',
        mainModel: NO_MODEL_PATTERN,
        fastModel: null,
        modelsMode: 'tenant',
        models: [],
        previous: null,
        createdAt: this.#now(),
      }
      const revision = await this.#revision(record.profileId)
      const saved = await providers.saveProfile(
        {
          profile: this.#profileDraft(record),
          ifMatch: revision,
          secrets: { [GATEWAY_KEY_ID]: secret },
        },
        caller,
      )
      if (!saved.ok) {
        await undo()
        return fromProviders(saved.failure)
      }
      try {
        this.#save({
          ...this.#state,
          bindings: [...this.#state.bindings, record],
          tenants: [
            ...this.#state.tenants.filter(one => one.tenant !== tenant),
            {
              tenant,
              entitled: known?.entitled ?? false,
              limits,
              upstreams: known?.upstreams ?? [],
            },
          ],
        })
      } catch (error) {
        return failed('unreachable', `网关状态写不进去 · ${messageOf(error)}`)
      }
      try {
        await this.#reconcile(client)
      } catch (error) {
        this.#options.onError?.(`订阅密钥核对失败 · ${messageOf(error)}`)
      }
      return ok({ binding: bindingKey(binding) })
    })
  }

  /**
   * Paid up or not. Off takes the key off at once; on lets it on only with
   * an upstream of the tenant's own. A tenant never ensured is a no-op.
   */
  setTenantEntitled(tenant: string, entitled: boolean): Promise<Result<void>> {
    return this.#serial(async () => {
      const known = this.#tenantRecord(tenant)
      if (known === undefined) return ok(undefined)
      const closed = this.#subscriptionsOpen()
      if (closed !== null) return closed
      if (known.entitled !== entitled) this.#saveTenant({ ...known, entitled })
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      try {
        await this.#reconcile(client)
      } catch (error) {
        return fromMagpie(error)
      }
      return ok(undefined)
    })
  }

  /**
   * The no-model profile ({@link NO_MODEL_PROFILE}), made or pointed at the
   * gateway as it is now with the hub's own caller; its id, or `null` while
   * there is no gateway (or no subscriptions) to point it at.
   */
  noModelProfile(): Promise<string | null> {
    return this.#serial(() => this.#ensureNoModel())
  }

  async #ensureNoModel(): Promise<string | null> {
    const subscriptions = this.#options.subscriptions
    if (subscriptions === undefined || this.#state.gatewayUrl === null)
      return null
    const { laneAddresses: _lanes, ...draft } = this.#profileDraft({
      kind: 'tenant',
      id: 'none',
      profileId: NO_MODEL_PROFILE,
      lane: 'anthropic',
      mainModel: NO_MODEL_PATTERN,
      fastModel: null,
    })
    const providers = this.#options.providers
    const overview = await providers.overview()
    if (!overview.ok) return null
    const current = overview.value.profiles.find(
      one => one.profile.id === NO_MODEL_PROFILE,
    )
    const sealed = current?.secrets.every(one => one.set) === true
    if (
      current !== undefined &&
      sealed &&
      current.profile.baseUrl === draft['baseUrl']
    )
      return NO_MODEL_PROFILE
    const saved = await providers.saveProfile(
      {
        profile: { ...draft, name: '无模型' },
        ifMatch: current?.profile.revision ?? null,
        ...(sealed
          ? {}
          : {
              secrets: {
                [GATEWAY_KEY_ID]: `qm-none-${randomBytes(32).toString('base64url')}`,
              },
            }),
      },
      subscriptions.caller,
    )
    if (!saved.ok) {
      this.#options.onError?.(
        `${NO_MODEL_PROFILE} 没能存进模型服务 · ${saved.failure.message}`,
      )
      return null
    }
    return NO_MODEL_PROFILE
  }

  /** The profile a tenant's nodes run on, once its key exists. */
  tenantProfileId(tenant: string): string | null {
    const record = this.#record({ kind: 'tenant', id: tenant })
    return record?.modelsMode === 'tenant' ? record.profileId : null
  }

  /**
   * The presets a subscriber may connect: one API key and nothing else
   * (L-6), and only a vendor's own API or OpenRouter — no relay or reseller
   * magpie lists, sponsors included (N-5).
   */
  async tenantPresets(): Promise<Result<readonly BillingPresetView[]>> {
    const client = this.#client()
    if (!(client instanceof MagpieClient)) return client
    try {
      return ok(
        (await client.listPresets({ vendors: true }))
          .filter(preset => !preset.noKey)
          .map(preset => ({ id: preset.id, name: preset.name })),
      )
    } catch (error) {
      return fromMagpie(error)
    }
  }

  /** A subscriber tenant's gateway, for its own page; never another's. */
  async tenantView(tenant: string): Promise<Result<TenantGatewayView>> {
    const record = this.#record({ kind: 'tenant', id: tenant })
    const known = this.#tenantRecord(tenant)
    if (record === undefined || record.modelsMode !== 'tenant')
      return ok({
        gateway: 'none',
        mainModel: null,
        upstreams: [],
        usage: null,
      })
    const offline = (): TenantGatewayView => ({
      gateway: 'off',
      mainModel:
        record.mainModel === NO_MODEL_PATTERN ? null : record.mainModel,
      upstreams: (known?.upstreams ?? []).map(one => ({
        id: one.id,
        name: one.preset,
        preset: one.preset,
        models: 0,
        ready: false,
        present: false,
      })),
      usage: null,
    })
    const client = this.#client()
    if (!(client instanceof MagpieClient)) return ok(offline())
    let read: MagpieRead
    let keys: readonly MagpieKey[]
    let presets: readonly { readonly id: string; readonly name: string }[]
    try {
      ;[read, keys, presets] = await Promise.all([
        this.#read(client),
        client.listKeys(),
        client.listPresets(),
      ])
    } catch {
      return ok(offline())
    }
    const present = this.#tenantPresent(tenant, read)
    const key = keys.find(one => one.id === record.keyId)
    let usage: BillingUsageView | null = null
    try {
      const row = (await client.usage('30d')).keys.find(
        one => one.keyId === record.keyId,
      )
      usage = {
        period: '30d',
        calls: row?.calls ?? 0,
        input: row?.input ?? 0,
        output: row?.output ?? 0,
        cacheRead: row?.cacheRead ?? 0,
        cost: row?.cost ?? 0,
      }
    } catch {
      usage = null
    }
    return ok({
      gateway: key?.enabled === true ? 'on' : 'off',
      mainModel:
        record.mainModel === NO_MODEL_PATTERN ? null : record.mainModel,
      upstreams: (known?.upstreams ?? []).map(one => {
        const live = present.find(item => item.upstream.id === one.id)
        return {
          id: one.id,
          name:
            presets.find(preset => preset.id === one.preset)?.name ??
            one.preset,
          preset: one.preset,
          models: live?.provider.models ?? 0,
          ready: live?.provider.ready ?? false,
          present: live !== undefined,
        }
      }),
      usage,
    })
  }

  /**
   * Connect one of the subscriber's own upstreams from a magpie preset. The
   * key goes to magpie and nowhere else; the upstream is named `qmt-…` and
   * recorded before the tenant's key is widened to it.
   */
  addTenantUpstream(
    tenant: string,
    draft: { readonly preset: string; readonly key: string },
  ): Promise<Result<BillingUpstreamView>> {
    return this.#serial(async () => {
      const closed = this.#subscriptionsOpen()
      if (closed !== null) return closed
      const known = this.#tenantRecord(tenant)
      if (known === undefined || this.tenantProfileId(tenant) === null)
        return failed('invalid', '订阅还在开通 · 稍后再试')
      if (!known.entitled)
        return failed('rejected', '订阅已到期 · 续费后再接入')
      if (known.upstreams.length >= MAX_TENANT_UPSTREAMS)
        return failed('invalid', `最多接 ${MAX_TENANT_UPSTREAMS} 个上游`)
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      try {
        const preset = (await client.listPresets({ vendors: true })).find(
          one => one.id === draft.preset && !one.noKey,
        )
        if (preset === undefined)
          return failed(
            'rejected',
            '这个预设不能用 · 只收填一把 API 密钥的上游',
          )
        const name =
          `${TENANT_UPSTREAM_PREFIX}${tenant.slice(0, 48)}-${preset.id.slice(0, 20)}-${randomBytes(3).toString('hex')}`.slice(
            0,
            80,
          )
        const added = await client.saveProvider({
          preset: preset.id,
          key: draft.key,
          name,
        })
        if (added.access !== 'key' || added.name !== name) {
          await client.deleteProvider(added.id)
          return failed('rejected', '这个上游不是 API 密钥上游 · 已撤回')
        }
        const upstream: TenantUpstreamRecord = {
          id: added.id,
          name,
          preset: preset.id,
          createdAt: this.#now(),
        }
        this.#saveTenant({
          ...known,
          upstreams: [...known.upstreams, upstream],
        })
        await this.#reconcile(client)
        return ok({
          id: added.id,
          name: preset.name,
          preset: preset.id,
          models: added.models,
          ready: added.ready,
          present: true,
        })
      } catch (error) {
        return fromMagpie(error)
      }
    })
  }

  /**
   * Remove one of the subscriber's upstreams: off its key first (off
   * altogether when it was the last), then out of magpie — only if the
   * provider there is still the one we made — and only then out of our
   * records. A step that fails leaves the upstream recorded, so asking again
   * finishes the job; nothing is forgotten while magpie still holds the
   * subscriber's key for it.
   */
  removeTenantUpstream(tenant: string, id: string): Promise<Result<void>> {
    return this.#serial(async () => {
      const closed = this.#subscriptionsOpen()
      if (closed !== null) return closed
      const known = this.#tenantRecord(tenant)
      const upstream = known?.upstreams.find(one => one.id === id)
      if (known === undefined || upstream === undefined)
        return failed('not_found', '没有这个上游')
      const client = this.#client()
      if (!(client instanceof MagpieClient)) return client
      try {
        const read = await this.#read(client)
        const record = this.#record({ kind: 'tenant', id: tenant })
        const key =
          record === undefined
            ? undefined
            : (await client.listKeys()).find(one => one.id === record.keyId)
        if (key !== undefined) {
          // Narrow only: never switched on here, and off before narrowed.
          const target = this.#tenantPatterns(tenant, read, id)
          if (!this.#tenantEnabled(tenant, read, id) && key.enabled)
            await client.setKeyEnabled(key.id, false)
          if (!sameList(key.models, target))
            await client.setKeyModels(key.id, target)
        }
        const live = read.providers.find(one => one.id === id)
        if (live !== undefined && live.name === upstream.name)
          await client.deleteProvider(id)
      } catch (error) {
        return fromMagpie(error)
      }
      const now = this.#tenantRecord(tenant) ?? known
      this.#saveTenant({
        ...now,
        upstreams: now.upstreams.filter(one => one.id !== id),
      })
      try {
        await this.#reconcile(client)
      } catch (error) {
        // Removed from magpie and from our records; the next check finishes
        // the rest (the profile's main model).
        this.#options.onError?.(
          `删除订阅者上游后核对失败 · ${messageOf(error)}`,
        )
      }
      return ok(undefined)
    })
  }
}
