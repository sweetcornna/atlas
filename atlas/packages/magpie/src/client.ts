// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The client for one magpie: its management API (the page `magpie serve
 * --web` serves, `internal/gui/*.go`) and two reads of its gateway
 * (`GET /api/hello`, `GET /v1/models`, `internal/gateway/gateway.go`).
 *
 * ## What it will not do
 *
 * - **Call a model.** The gateway's model endpoints are the nodes'; this
 *   client reads the gateway's identity and catalog only (N-5 v2.22, R-9).
 * - **Follow a redirect.** Every request is `redirect: 'manual'` and a 3xx is
 *   an error: a management key in a cookie must not be carried to wherever a
 *   redirect points.
 * - **Wait forever or read without end.** Each request has a deadline (5 s
 *   unless the call says otherwise: magpie fetches the vendor's list inside a
 *   provider save, for up to 8 s) and a body cap (2 MiB).
 * - **Say a secret.** Errors are fixed sentences. The one remote text that is
 *   passed on is magpie's own `{"error": …}` on a management 400, with every
 *   secret of that request taken out first; the gateway's bodies never reach
 *   an error, since its 401 quotes the end of the key it refused.
 *
 * Addresses are origins only (`checkOrigin`): https, or plain http to this
 * machine's loopback, and never a path, a query or credentials.
 *
 * The management API answers only with the `MAGPIE_WEB_KEY` cookie
 * `magpie_web_<port>` (`internal/gui/web.go` `webHandler`), where the port is
 * the one magpie listens on: the management origin's own unless
 * `webCookiePort` says otherwise (a reverse proxy in front of it).
 */

import { accessOf, groupOf, keyOf } from './parse.js'
import {
  GROUP_AFFINITIES,
  GROUP_ROUTINGS,
  LIMIT_PERIODS,
  MAGPIE_PERIODS,
  MAX_KEY_LIMITS,
  type MagpieGroup,
  type MagpieGroupDraft,
  type MagpieHello,
  type MagpieInfo,
  type MagpieKey,
  type MagpieKeyChoice,
  type MagpieLimit,
  type MagpieModel,
  type MagpiePeriod,
  type MagpiePreset,
  type MagpieProvider,
  type MagpieProviderDraft,
  type MagpieTestResult,
  type MagpieUsage,
  type MagpieUsageTotals,
} from './types.js'

export const MAGPIE_ERROR_CODES = [
  'magpie_bad_url',
  'magpie_invalid',
  'magpie_unreachable',
  'magpie_auth',
  'magpie_not_magpie',
  'magpie_bad_response',
  'magpie_rejected',
  'magpie_not_found',
] as const
export type MagpieErrorCode = (typeof MAGPIE_ERROR_CODES)[number]

/** A failure with a stable code; the message never holds a secret. */
export class MagpieError extends Error {
  readonly code: MagpieErrorCode
  /** The HTTP status magpie answered with, when it answered. */
  readonly status: number | undefined

  constructor(code: MagpieErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'MagpieError'
    this.code = code
    this.status = status
  }
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
/** magpie fetches the vendor's list inside a save for up to 8 s. */
const SAVE_TIMEOUT_MS = 15_000
/** A provider test waits up to 25 s, a model refetch up to 20 s. */
const TEST_TIMEOUT_MS = 30_000
const MODELS_TIMEOUT_MS = 25_000
/** A catalog longer than this is not one a key is held to. */
const MAX_CATALOG = 2_000
const MAX_KEY_MODELS = 500
const MAX_ERROR_TEXT = 200
/** The reserved prefix of magpie's own keys (`access.legacyLANPrefix`). */
const MAGPIE_KEY_PREFIX = 'sk-magpie-'
/** magpie web's own default port (`internal/cli/web_cli.go` `webAddr`). */
const DEFAULT_WEB_PORT = 3430

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/
// biome-ignore lint/suspicious/noControlCharactersInRegex: same
const CONTROL_ALL = /[\u0000-\u001f\u007f]/g

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * The origin `url` names, normalised (`https://host[:port]`), or a
 * `magpie_bad_url` error. A trailing `/` is taken; any other path is not.
 */
export function checkOrigin(url: string): string {
  const bad = (message: string) => new MagpieError('magpie_bad_url', message)
  if (typeof url !== 'string' || url.length === 0 || url.length > 512) {
    throw bad('magpie 地址不能为空')
  }
  if (CONTROL.test(url) || /\s|\\/.test(url)) {
    throw bad('magpie 地址里不能有空白或控制字符')
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw bad('magpie 地址不是合法的 URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw bad('magpie 地址只能是 http 或 https')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw bad('magpie 地址里不能带用户名或密码')
  }
  if (
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    /[?#]/.test(url)
  ) {
    throw bad('magpie 地址只能是 origin · 不带路径或查询')
  }
  if (parsed.port === '0') throw bad('magpie 地址的端口不对')
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw bad('magpie 地址要用 https · 只有本机回环可以用 http')
  }
  return parsed.origin
}

/** The port magpie web listens on behind `origin`, for its cookie's name. */
function portOf(origin: string): number {
  const parsed = new URL(origin)
  if (parsed.port !== '') return Number(parsed.port)
  return DEFAULT_WEB_PORT
}

export interface MagpieClientOptions {
  /** The management origin (`magpie serve --web=…`). */
  readonly managementUrl?: string
  /** The gateway origin as this process reaches it. */
  readonly gatewayUrl?: string
  /** `MAGPIE_WEB_KEY`. Never logged, never part of an error. */
  readonly webKey?: string
  /** The port magpie web listens on, when it is not the management origin's. */
  readonly webCookiePort?: number
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
  readonly maxBytes?: number
}

type Target = 'management' | 'gateway'

interface CallOptions {
  readonly body?: unknown
  /** A gateway key for this one request. */
  readonly key?: string
  readonly timeoutMs?: number
  /** Values to take out of any text an error passes on. */
  readonly secrets?: readonly string[]
}

type Json = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** `text` with every secret, control character and run of blanks taken out. */
function redact(raw: string, secrets: readonly string[]): string {
  let out = raw
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('***')
  }
  out = out.replace(CONTROL_ALL, ' ').replace(/\s+/g, ' ').trim()
  return out.length > MAX_ERROR_TEXT ? `${out.slice(0, MAX_ERROR_TEXT)}…` : out
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
}

async function readCapped(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => {})
    throw new MagpieError(
      'magpie_bad_response',
      'magpie 的回应超过 2 MiB',
      response.status,
    )
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new MagpieError(
        'magpie_bad_response',
        'magpie 的回应超过 2 MiB',
        response.status,
      )
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    joined.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

function limitBody(limit: MagpieLimit): Record<string, unknown> {
  return {
    period: limit.period,
    ...(limit.period === 'days' ? { days: limit.days } : {}),
    ...(limit.period === 'hours' ? { hours: limit.hours } : {}),
    ...(limit.tokens ? { tokens: limit.tokens } : {}),
    ...(limit.cost ? { cost: limit.cost } : {}),
    ...(limit.cacheReads ? { cacheReads: true } : {}),
  }
}

function sameWindow(a: MagpieLimit, b: MagpieLimit): boolean {
  return (
    a.period === b.period &&
    (a.period !== 'days' || a.days === b.days) &&
    (a.period !== 'hours' || a.hours === b.hours)
  )
}

/** A limit magpie would take, or the reason it would not (`Limit.Valid`). */
function limitProblem(limit: MagpieLimit): string | null {
  if (!(LIMIT_PERIODS as readonly string[]).includes(limit.period)) {
    return '限额周期只能是 day week month days hours'
  }
  const tokens = limit.tokens ?? 0
  const cost = limit.cost ?? 0
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    return '限额的 token 数要是非负整数'
  }
  if (!Number.isFinite(cost) || cost < 0) return '限额的费用要是非负数'
  if (tokens === 0 && cost === 0) return '限额至少要给 token 或费用之一'
  if (limit.period === 'days') {
    const days = limit.days ?? 0
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return '按天循环的限额要 1 到 3650 天'
    }
  }
  if (limit.period === 'hours') {
    const hours = limit.hours ?? 0
    if (!Number.isInteger(hours) || hours < 1 || hours > 8760) {
      return '按小时循环的限额要 1 到 8760 小时'
    }
  }
  return null
}

/** A key's model pattern magpie would take (`access.CleanModels`). */
function patternProblem(pattern: string): string | null {
  if (pattern.length === 0 || pattern.length > 300) {
    return '模型名要 1 到 300 个字符'
  }
  if (CONTROL.test(pattern) || /\s/.test(pattern)) {
    return '模型名里不能有空白或控制字符'
  }
  if (
    !pattern.includes('/') ||
    pattern.startsWith('/') ||
    pattern.endsWith('/')
  ) {
    return '模型名要写 provider/model 或 group/名称'
  }
  return null
}

function totalsOf(raw: Json): MagpieUsageTotals {
  return {
    calls: num(raw['calls']),
    errors: num(raw['errors']),
    input: num(raw['input']),
    output: num(raw['output']),
    cacheRead: num(raw['cache_read']),
    cacheWrite: num(raw['cache_write']),
    cost: num(raw['cost']),
    unpriced: num(raw['unpriced']),
  }
}

/** A catalog id worth keeping: printable, no blanks, bounded. */
const MODEL_ID = /^[!-~]{1,300}$/

export class MagpieClient {
  readonly #management: string | null
  readonly #gateway: string | null
  readonly #webKey: string | null
  readonly #cookie: string | null
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number
  readonly #maxBytes: number

  constructor(options: MagpieClientOptions) {
    this.#management =
      options.managementUrl === undefined
        ? null
        : checkOrigin(options.managementUrl)
    this.#gateway =
      options.gatewayUrl === undefined ? null : checkOrigin(options.gatewayUrl)
    const webKey = options.webKey ?? null
    if (webKey !== null && (webKey.length === 0 || /[\s;,"\\]/.test(webKey))) {
      throw new MagpieError(
        'magpie_invalid',
        '管理密钥只能用字母 · 数字与 - . _ ~',
      )
    }
    this.#webKey = webKey
    const port =
      options.webCookiePort ??
      (this.#management === null ? DEFAULT_WEB_PORT : portOf(this.#management))
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new MagpieError('magpie_invalid', '管理页端口不对')
    }
    this.#cookie = `magpie_web_${port}`
    this.#fetch = options.fetch ?? fetch
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  /** The management origin this client talks to, or null. */
  get managementUrl(): string | null {
    return this.#management
  }

  /** The gateway origin this client reads, or null. */
  get gatewayUrl(): string | null {
    return this.#gateway
  }

  async #call(
    target: Target,
    method: 'GET' | 'POST',
    path: string,
    options: CallOptions = {},
  ): Promise<unknown> {
    const origin = target === 'management' ? this.#management : this.#gateway
    if (origin === null) {
      throw new MagpieError(
        'magpie_bad_url',
        target === 'management'
          ? '没有配置 magpie 管理地址'
          : '没有配置 magpie 网关地址',
      )
    }
    const headers: Record<string, string> = { accept: 'application/json' }
    const secrets = [...(options.secrets ?? [])]
    if (target === 'management') {
      if (this.#webKey === null) {
        throw new MagpieError('magpie_auth', '没有 magpie 管理密钥')
      }
      headers['cookie'] = `${this.#cookie}=${this.#webKey}`
      secrets.push(this.#webKey)
    } else if (options.key !== undefined) {
      headers['authorization'] = `Bearer ${options.key}`
      secrets.push(options.key)
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    let response: Response
    try {
      response = await this.#fetch(`${origin}${path}`, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs),
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      })
    } catch (error) {
      throw new MagpieError(
        'magpie_unreachable',
        isAbort(error) ? '连接 magpie 超时' : '连不上 magpie',
      )
    }
    let body: string
    try {
      body = await readCapped(response, this.#maxBytes)
    } catch (error) {
      if (error instanceof MagpieError) throw error
      throw new MagpieError(
        'magpie_unreachable',
        isAbort(error) ? '读取 magpie 回应超时' : '读取 magpie 回应中断',
        response.status,
      )
    }
    const status = response.status
    if (status >= 300 && status < 400) {
      throw new MagpieError(
        'magpie_bad_response',
        'magpie 返回了重定向 · 不跟随',
        status,
      )
    }
    if (status === 401 || status === 403) {
      throw new MagpieError(
        'magpie_auth',
        target === 'management'
          ? 'magpie 管理密钥不对或缺失'
          : 'magpie 网关密钥无效或缺失',
        status,
      )
    }
    if (status === 404) {
      throw new MagpieError(
        'magpie_not_found',
        'magpie 没有这个接口 · 版本可能过旧',
        status,
      )
    }
    let parsed: unknown
    try {
      parsed = body.length === 0 ? null : JSON.parse(body)
    } catch {
      parsed = undefined
    }
    if (status === 400 && target === 'management') {
      const said = isRecord(parsed) ? text(parsed['error']) : ''
      throw new MagpieError(
        'magpie_rejected',
        said === ''
          ? 'magpie 拒绝了这次修改'
          : `magpie 拒绝 · ${redact(said, secrets)}`,
        status,
      )
    }
    if (status < 200 || status >= 300) {
      throw new MagpieError(
        'magpie_bad_response',
        `magpie 返回 HTTP ${status}`,
        status,
      )
    }
    if (parsed === undefined) {
      throw new MagpieError(
        'magpie_bad_response',
        'magpie 的回应不是 JSON',
        status,
      )
    }
    return parsed
  }

  async #object(
    target: Target,
    method: 'GET' | 'POST',
    path: string,
    options: CallOptions = {},
  ): Promise<Json> {
    const value = await this.#call(target, method, path, options)
    if (!isRecord(value)) {
      throw new MagpieError('magpie_bad_response', 'magpie 的回应形状不对')
    }
    return value
  }

  // --- identity ----------------------------------------------------------

  /** The gateway's identity. `key` is needed when the gateway is beyond loopback. */
  async hello(key?: string): Promise<MagpieHello> {
    const body = await this.#call('gateway', 'GET', '/api/hello', {
      ...(key === undefined ? {} : { key }),
    })
    if (!isRecord(body) || body['name'] !== 'magpie') {
      throw new MagpieError('magpie_not_magpie', '这个地址答的不是 magpie')
    }
    return { name: 'magpie', version: text(body['version']).slice(0, 80) }
  }

  /** The management side's version and gateway address; checks the web key. */
  async info(): Promise<MagpieInfo> {
    const body = await this.#call('management', 'GET', '/api/settings')
    if (!isRecord(body) || typeof body['version'] !== 'string') {
      throw new MagpieError(
        'magpie_not_magpie',
        '这个地址答的不是 magpie 管理页',
      )
    }
    const gateway = text(body['gateway'])
    return {
      version: text(body['version']).slice(0, 80),
      gateway: gateway === '' ? null : gateway.slice(0, 200),
      onNetwork: body['onNetwork'] === true,
    }
  }

  // --- providers ---------------------------------------------------------

  async #providersState(): Promise<Json> {
    return this.#object('management', 'GET', '/api/providers')
  }

  async listProviders(): Promise<readonly MagpieProvider[]> {
    return providersOf(await this.#providersState())
  }

  /**
   * The presets a provider can be added from with nothing but a key, by id.
   * Left out: another magpie and the presets that send as a vendor's own
   * client (both borrow an identity), and those that need the user's own
   * endpoint. Sponsorship and taglines are not carried.
   */
  async listPresets(): Promise<readonly MagpiePreset[]> {
    const state = await this.#providersState()
    const out: MagpiePreset[] = []
    for (const raw of list(state['presets'])) {
      if (!isRecord(raw)) continue
      const id = text(raw['id'])
      const kind = text(raw['kind'])
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) continue
      if (kind === 'remote' || raw['ownClient'] === true) continue
      if (text(raw['endpoint']) !== '') continue
      const urls = [raw['chat'], raw['responses'], raw['anthropic']].some(
        value => text(value) !== '',
      )
      if (!urls) continue
      out.push({
        id,
        name: (text(raw['name']) || id).slice(0, 80),
        kind,
        noKey: raw['noKey'] === true,
      })
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Add a provider; magpie gives it the next free id, which is returned. */
  async saveProvider(draft: MagpieProviderDraft): Promise<MagpieProvider> {
    const preset = draft.preset.trim()
    const urls = {
      ...(draft.chat ? { chat: upstreamUrl(draft.chat) } : {}),
      ...(draft.responses ? { responses: upstreamUrl(draft.responses) } : {}),
      ...(draft.anthropic ? { anthropic: upstreamUrl(draft.anthropic) } : {}),
    }
    if (preset === '' && Object.keys(urls).length === 0) {
      throw new MagpieError('magpie_invalid', '要选预设或给出上游地址')
    }
    if (preset !== '' && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(preset)) {
      throw new MagpieError('magpie_invalid', '预设名不对')
    }
    // magpie splits a key field on blanks into several keys.
    const key = draft.key?.trim() ?? ''
    if (
      key.length > 4096 ||
      CONTROL.test(key) ||
      /[\s,;\uff0c\uff1b]/.test(key)
    ) {
      throw new MagpieError(
        'magpie_invalid',
        '上游密钥只能是一个 · 不含空白或控制字符',
      )
    }
    const name = draft.name?.trim() ?? ''
    if (name.length > 80 || CONTROL.test(name)) {
      throw new MagpieError('magpie_invalid', '名称不超过 80 个字符')
    }
    if (preset === '' && name === '') {
      throw new MagpieError('magpie_invalid', '自定义上游要给名称')
    }
    const before = new Set((await this.listProviders()).map(one => one.id))
    const state = await this.#object(
      'management',
      'POST',
      '/api/provider/save',
      {
        body: {
          new: true,
          preset,
          key,
          ...(name === '' ? {} : { name }),
          ...(preset === '' ? urls : {}),
        },
        timeoutMs: SAVE_TIMEOUT_MS,
        secrets: key === '' ? [] : [key],
      },
    )
    const added = providersOf(state).find(one => !before.has(one.id))
    if (added === undefined) {
      throw new MagpieError('magpie_bad_response', 'magpie 没有列出新加的上游')
    }
    return added
  }

  async setProviderEnabled(
    id: string,
    on: boolean,
  ): Promise<readonly MagpieProvider[]> {
    const state = await this.#object(
      'management',
      'POST',
      `/api/provider/${on ? 'on' : 'off'}`,
      { body: { id: providerId(id) } },
    )
    return providersOf(state)
  }

  async deleteProvider(id: string): Promise<readonly MagpieProvider[]> {
    const state = await this.#object(
      'management',
      'POST',
      '/api/provider/delete',
      {
        body: { id: providerId(id) },
      },
    )
    return providersOf(state)
  }

  /**
   * magpie sends the smallest request to each endpoint the provider serves.
   * The vendor's own error text is dropped: it can quote the key it refused.
   */
  async testProvider(id: string): Promise<readonly MagpieTestResult[]> {
    const body = await this.#object(
      'management',
      'POST',
      '/api/provider/test',
      {
        body: { id: providerId(id) },
        timeoutMs: TEST_TIMEOUT_MS,
      },
    )
    return list(body['results']).flatMap(raw => {
      if (!isRecord(raw)) return []
      const status = num(raw['status'])
      const model = text(raw['model'])
      return [
        {
          protocol: text(raw['protocol']),
          ok: raw['ok'] === true,
          status: status === 0 ? null : status,
          ms: num(raw['ms']),
          model: model === '' ? null : model,
        },
      ]
    })
  }

  /** Ask the vendor for the provider's list again; returns what it serves now. */
  async providerModels(id: string): Promise<{
    readonly count: number
    readonly models: readonly string[]
  }> {
    const body = await this.#object(
      'management',
      'POST',
      '/api/provider/models',
      {
        body: { id: providerId(id) },
        timeoutMs: MODELS_TIMEOUT_MS,
      },
    )
    const provider = isRecord(body['provider'])
      ? providersOf({ providers: [body['provider']] })[0]
      : undefined
    return { count: num(body['count']), models: provider?.modelIds ?? [] }
  }

  // --- groups ------------------------------------------------------------

  async #groupsRaw(): Promise<readonly Json[]> {
    const state = await this.#object('management', 'GET', '/api/groups')
    return list(state['groups']).filter(isRecord)
  }

  async listGroups(): Promise<readonly MagpieGroup[]> {
    return (await this.#groupsRaw()).flatMap(raw => {
      const group = groupOf(raw)
      return group === null ? [] : [group]
    })
  }

  /**
   * Save a group. magpie replaces a group whole, so the group as magpie has
   * it now is the base and only the draft's fields change: its rules,
   * classifier, weights and the rest are kept.
   */
  async saveGroup(draft: MagpieGroupDraft): Promise<MagpieGroup> {
    const id = draft.id.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(id)) {
      throw new MagpieError(
        'magpie_invalid',
        '路由组 id 只能用小写字母 · 数字 · 点与连字符',
      )
    }
    if (
      draft.routing !== undefined &&
      !GROUP_ROUTINGS.includes(draft.routing)
    ) {
      throw new MagpieError('magpie_invalid', '路由方式不对')
    }
    if (
      draft.affinity !== undefined &&
      !GROUP_AFFINITIES.includes(draft.affinity)
    ) {
      throw new MagpieError('magpie_invalid', '会话保持方式不对')
    }
    const members = draft.members?.map(member => member.trim()) ?? undefined
    for (const member of members ?? []) {
      const problem = patternProblem(member)
      if (problem !== null) throw new MagpieError('magpie_invalid', problem)
    }
    const name = draft.name?.trim()
    if (name !== undefined && (name.length > 80 || CONTROL.test(name))) {
      throw new MagpieError('magpie_invalid', '名称不超过 80 个字符')
    }
    const from = draft.from?.trim().toLowerCase()
    const existing = (await this.#groupsRaw()).find(
      raw => text(raw['id']) === (from ?? id),
    )
    if (
      existing === undefined &&
      (members === undefined || members.length === 0)
    ) {
      throw new MagpieError('magpie_invalid', '新路由组至少要一个成员')
    }
    const base: Record<string, unknown> = {}
    if (existing !== undefined) {
      for (const [field, value] of Object.entries(existing)) {
        if (!DERIVED_GROUP_FIELDS.has(field)) base[field] = value
      }
    }
    const body: Record<string, unknown> = {
      ...base,
      id,
      ...(name === undefined ? {} : { name }),
      ...(members === undefined ? {} : { members, matched: [] }),
      ...(draft.routing === undefined
        ? {}
        : { routing: draft.routing === 'smart' ? '' : draft.routing }),
      ...(draft.affinity === undefined
        ? {}
        : { affinity: draft.affinity === 'auto' ? '' : draft.affinity }),
      ...(existing !== undefined && from !== undefined && from !== id
        ? { from }
        : {}),
    }
    const state = await this.#object('management', 'POST', '/api/groups/save', {
      body,
    })
    const saved = list(state['groups'])
      .filter(isRecord)
      .map(groupOf)
      .find(group => group?.id === id)
    if (saved === undefined || saved === null) {
      throw new MagpieError(
        'magpie_bad_response',
        'magpie 没有列出保存的路由组',
      )
    }
    return saved
  }

  async deleteGroup(id: string): Promise<readonly MagpieGroup[]> {
    const state = await this.#object(
      'management',
      'POST',
      '/api/groups/delete',
      {
        body: { id: groupId(id) },
      },
    )
    return list(state['groups']).flatMap(raw => {
      const group = isRecord(raw) ? groupOf(raw) : null
      return group === null ? [] : [group]
    })
  }

  // --- gateway keys ------------------------------------------------------

  async #keysFrom(body: Json): Promise<readonly MagpieKey[]> {
    return list(body['keys']).flatMap(raw => {
      const key = isRecord(raw) ? keyOf(raw) : null
      return key === null ? [] : [key]
    })
  }

  async listKeys(): Promise<readonly MagpieKey[]> {
    return this.#keysFrom(
      await this.#object('management', 'GET', '/api/caller-keys'),
    )
  }

  async #key(id: string): Promise<MagpieKey> {
    const found = (await this.listKeys()).find(key => key.id === id)
    if (found === undefined) {
      throw new MagpieError('magpie_not_found', 'magpie 里没有这把网关密钥')
    }
    return found
  }

  async #keyAction(
    action: string,
    change: Readonly<Record<string, unknown>>,
    secrets: readonly string[] = [],
  ): Promise<Json> {
    return this.#object('management', 'POST', `/api/caller-keys/${action}`, {
      body: change,
      secrets,
    })
  }

  /**
   * Create a key with a value the caller chose (`access.Change.Secret`), then
   * find it by its name, which must be unique: the id is magpie's own.
   */
  async addKey(input: {
    readonly name: string
    readonly secret: string
  }): Promise<MagpieKey> {
    const name = input.name.trim()
    if (name.length === 0 || [...name].length > 120 || CONTROL.test(name)) {
      throw new MagpieError('magpie_invalid', '密钥名称要 1 到 120 个字符')
    }
    const secret = input.secret
    if (
      secret.length < 8 ||
      secret.length > 256 ||
      !/^[!-~]+$/.test(secret) ||
      secret.startsWith(MAGPIE_KEY_PREFIX)
    ) {
      throw new MagpieError(
        'magpie_invalid',
        '密钥值要 8 到 256 个可打印字符 · 不能以 sk-magpie- 开头',
      )
    }
    if ((await this.listKeys()).some(key => key.name === name)) {
      throw new MagpieError('magpie_invalid', '已有同名的网关密钥')
    }
    const keys = await this.#keysFrom(
      await this.#keyAction('add-key', { name, secret }, [secret]),
    )
    const named = keys.filter(key => key.name === name)
    if (named.length !== 1 || named[0] === undefined) {
      throw new MagpieError(
        'magpie_bad_response',
        'magpie 没有列出新加的网关密钥',
      )
    }
    return named[0]
  }

  /**
   * Make `limits` the key's limits, in order (at most five, one per window).
   * When the windows stay as they are, each is set in its place, so a cycle
   * keeps its start (`access.sinceOf`); otherwise the first becomes the only
   * one and the rest are added after it.
   */
  async setKeyLimits(
    id: string,
    limits: readonly MagpieLimit[],
  ): Promise<MagpieKey> {
    if (limits.length > MAX_KEY_LIMITS) {
      throw new MagpieError('magpie_invalid', '一把密钥最多 5 条限额')
    }
    for (const limit of limits) {
      const problem = limitProblem(limit)
      if (problem !== null) throw new MagpieError('magpie_invalid', problem)
    }
    for (let a = 0; a < limits.length; a += 1) {
      for (let b = a + 1; b < limits.length; b += 1) {
        if (sameWindow(limits[a] as MagpieLimit, limits[b] as MagpieLimit)) {
          throw new MagpieError('magpie_invalid', '同一个周期只能有一条限额')
        }
      }
    }
    const current = await this.#key(id)
    if (limits.length === 0) {
      await this.#keyAction('limit-key', { key: id })
      return this.#key(id)
    }
    const inPlace =
      current.limits.length === limits.length &&
      current.limits.every((limit, index) =>
        sameWindow(limit, limits[index] as MagpieLimit),
      )
    if (inPlace) {
      for (const [index, limit] of limits.entries()) {
        await this.#keyAction('limit-key', {
          key: id,
          index,
          limit: limitBody(limit),
        })
      }
    } else {
      const [first, ...rest] = limits
      await this.#keyAction('limit-key', {
        key: id,
        limit: limitBody(first as MagpieLimit),
      })
      for (const [offset, limit] of rest.entries()) {
        await this.#keyAction('limit-key', {
          key: id,
          index: offset + 1,
          limit: limitBody(limit),
        })
      }
    }
    return this.#key(id)
  }

  /** Count one limit (or every limit) of the key again from now. */
  async resetKeyLimit(id: string, index?: number): Promise<MagpieKey> {
    if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
      throw new MagpieError('magpie_invalid', '限额序号不对')
    }
    await this.#keyAction('reset-limit-key', {
      key: id,
      ...(index === undefined ? {} : { index }),
    })
    return this.#key(id)
  }

  /**
   * Hold the key to `patterns`. An empty list is refused: magpie reads it as
   * "every model", accounts included, which is never what Qianmo means.
   */
  async setKeyModels(
    id: string,
    patterns: readonly string[],
  ): Promise<MagpieKey> {
    if (patterns.length === 0) {
      throw new MagpieError(
        'magpie_invalid',
        '模型白名单不能为空 · magpie 把空列表当作全部模型',
      )
    }
    if (patterns.length > MAX_KEY_MODELS) {
      throw new MagpieError('magpie_invalid', '模型白名单最多 500 条')
    }
    for (const pattern of patterns) {
      const problem = patternProblem(pattern)
      if (problem !== null) throw new MagpieError('magpie_invalid', problem)
    }
    const keys = await this.#keysFrom(
      await this.#keyAction('models-key', { key: id, models: [...patterns] }),
    )
    const key = keys.find(one => one.id === id)
    if (key === undefined || key.models.length === 0) {
      throw new MagpieError('magpie_bad_response', 'magpie 没有记下模型白名单')
    }
    return key
  }

  async setKeyEnabled(id: string, on: boolean): Promise<MagpieKey> {
    const keys = await this.#keysFrom(
      await this.#keyAction(on ? 'on-key' : 'off-key', { key: id }),
    )
    const key = keys.find(one => one.id === id)
    if (key === undefined) {
      throw new MagpieError('magpie_not_found', 'magpie 里没有这把网关密钥')
    }
    return key
  }

  /**
   * magpie's own rotation: same id, limits and usage, a new value of its
   * making (`sk-magpie-key-…`). magpie offers no way to set a key's value
   * after it is made, so the new value is returned here, once.
   */
  async rotateKey(id: string): Promise<{ readonly secret: string }> {
    const body = await this.#keyAction('rotate-key', { key: id })
    const secret = text(body['secret'])
    if (secret.length < 8 || !/^[!-~]+$/.test(secret)) {
      throw new MagpieError('magpie_bad_response', 'magpie 没有给出新的密钥值')
    }
    return { secret }
  }

  async removeKey(id: string): Promise<void> {
    await this.#keyAction('remove-key', { key: id })
  }

  /** The models and routing groups a key may be held to. Accounts are not carried. */
  async keyChoices(): Promise<readonly MagpieKeyChoice[]> {
    const body = await this.#object(
      'management',
      'GET',
      '/api/caller-keys/models',
    )
    return list(body['models']).flatMap(raw => {
      if (!isRecord(raw)) return []
      const id = text(raw['id'])
      if (!MODEL_ID.test(id)) return []
      const provider = text(raw['provider'])
      return [
        {
          id,
          name: text(raw['name']) || id,
          provider: provider === '' ? null : provider,
          group: raw['group'] === true,
        },
      ]
    })
  }

  // --- usage -------------------------------------------------------------

  /**
   * The usage page's summary of a period. magpie reads an unknown period as
   * 30 days without saying so; this client refuses one instead.
   */
  async usage(period: MagpiePeriod): Promise<MagpieUsage> {
    if (!(MAGPIE_PERIODS as readonly string[]).includes(period)) {
      throw new MagpieError('magpie_invalid', '用量周期只能是 today 7d 30d all')
    }
    const body = await this.#object(
      'management',
      'GET',
      `/api/usage?period=${encodeURIComponent(period)}`,
    )
    const since = text(body['since'])
    return {
      period,
      since: since === '' || since.startsWith('0001-') ? null : since,
      totals: totalsOf(body),
      models: list(body['models']).flatMap(raw => {
        if (!isRecord(raw)) return []
        const id = text(raw['id'])
        if (id === '') return []
        return [
          {
            ...totalsOf(raw),
            id,
            name: text(raw['name']) || text(raw['model']) || id,
          },
        ]
      }),
      keys: list(body['callerKeys']).flatMap(raw => {
        if (!isRecord(raw)) return []
        const keyId = text(raw['callerKeyId']) || text(raw['id'])
        if (keyId === '') return []
        return [
          {
            ...totalsOf(raw),
            keyId,
            name: text(raw['name']) || text(raw['callerKeyName']) || keyId,
          },
        ]
      }),
    }
  }

  // --- catalog -----------------------------------------------------------

  /** The gateway's model list as `key` sees it (held keys see their own models). */
  async catalog(key: string): Promise<readonly MagpieModel[]> {
    const body = await this.#object('gateway', 'GET', '/v1/models', { key })
    if (!Array.isArray(body['data'])) {
      throw new MagpieError('magpie_bad_response', 'magpie 的模型目录形状不对')
    }
    if (body['has_more'] === true) {
      throw new MagpieError('magpie_bad_response', 'magpie 的模型目录不完整')
    }
    const rows = body['data'] as readonly unknown[]
    if (rows.length > MAX_CATALOG) {
      throw new MagpieError('magpie_bad_response', 'magpie 的模型目录过长')
    }
    const out: MagpieModel[] = []
    const seen = new Set<string>()
    for (const raw of rows) {
      if (!isRecord(raw)) continue
      const id = text(raw['id'])
      if (!MODEL_ID.test(id) || seen.has(id)) continue
      seen.add(id)
      out.push({
        id,
        name: (text(raw['display_name']) || id).slice(0, 200),
        owner: text(raw['owned_by']).slice(0, 100),
      })
    }
    return out
  }
}

/** Fields magpie derives on every read of a group and never stores. */
const DERIVED_GROUP_FIELDS = new Set([
  'ready',
  'memberInfo',
  'holds',
  'offers',
  'shared',
  'picked',
  'patterns',
  'decides',
  'classifierFailed',
])

function providerId(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new MagpieError('magpie_invalid', '上游 id 不对')
  }
  return id
}

function groupId(id: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(id)) {
    throw new MagpieError('magpie_invalid', '路由组 id 不对')
  }
  return id
}

/** An upstream base URL: http(s), no credentials, query or fragment. */
function upstreamUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new MagpieError('magpie_invalid', '上游地址不是合法的 URL')
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new MagpieError(
      'magpie_invalid',
      '上游地址只能是 http 或 https · 不带用户名或查询',
    )
  }
  return parsed.toString().replace(/\/$/, '')
}

function providersOf(state: Json): readonly MagpieProvider[] {
  const out: MagpieProvider[] = []
  for (const raw of list(state['providers'])) {
    if (!isRecord(raw)) continue
    const id = text(raw['id'])
    if (id === '') continue
    const models = list(raw['models'])
      .filter(isRecord)
      .filter(model => model['on'] === true)
      .map(model => text(model['id']))
      .filter(model => model !== '')
    const account = isRecord(raw['account']) ? raw['account'] : null
    const plan = account === null ? '' : text(account['plan'])
    out.push({
      id,
      name: text(raw['name']) || id,
      preset: text(raw['preset']),
      host: text(raw['host']).slice(0, 200),
      enabled: raw['off'] !== true,
      ready: raw['ready'] === true,
      models:
        typeof raw['exposed'] === 'number'
          ? num(raw['exposed'])
          : models.length,
      modelIds: models,
      access: accessOf(raw),
      plan: plan === '' ? null : plan.slice(0, 60),
    })
  }
  return out
}
