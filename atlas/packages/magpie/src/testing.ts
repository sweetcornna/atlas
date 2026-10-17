// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An in-memory magpie for tests: two loopback HTTP servers, management and
 * gateway, answering the routes Qianmo calls with the shapes and rules of
 * magpie's Go code (v0.1.x). No network beyond loopback, no files.
 *
 * ## Use
 *
 * ```ts
 * const fake = await FakeMagpie.start({ providers: [...], groups: [...] })
 * const client = new MagpieClient({
 *   managementUrl: fake.managementUrl,
 *   gatewayUrl: fake.gatewayUrl,
 *   webKey: fake.webKey,
 * })
 * ...
 * await fake.stop()
 * ```
 *
 * ## Management (`fake.managementUrl`)
 *
 * Every `/api/*` route needs the cookie `magpie_web_<management port>` set
 * to `fake.webKey`, else `401 text/plain` (`internal/gui/web.go`). A change
 * magpie refuses is `400 {"error": "<magpie's sentence>"}`.
 *
 * - `GET /api/settings` → `{version, gateway, onNetwork, publicURL}`
 * - `GET /api/providers` → `{providers: [providerJSON], presets: [presetJSON], gateway}`
 * - `POST /api/provider/save` `{new: true, preset, key, name?, chat?, responses?, anthropic?}`
 *   adds a provider under the next free id (`<preset>`, `<preset>-2`, …) → providers state
 * - `POST /api/provider/{on,off,delete}` `{id}` → providers state
 * - `POST /api/provider/test` `{id}` → `{results: [{protocol, ok, status, ms, model, error?}], provider}`
 * - `POST /api/provider/models` `{id}` → `{count, dropped, provider}`
 * - `GET /api/groups` → `{groups: [groupJSON], models: []}`; a group's
 *   `members` lists those its patterns match after its own, `matched` which
 * - `POST /api/groups/save` (whole group, `from` to rename), `POST /api/groups/delete` `{id}` or `{ids}`
 * - `GET /api/caller-keys` → `{keys: [keyRow], accountNames: {}}` (secrets masked)
 * - `GET /api/caller-keys/models` → `{models: [{id, name, provider?, group?}], accounts: [...]}`
 * - `POST /api/caller-keys/{add-key,rename-key,rotate-key,limit-key,reset-limit-key,models-key,on-key,off-key,remove-key}`
 *   with `access.Change` → `{keys, accountNames, secret}`
 * - `GET /api/usage?period=` → the seeded summary; an unknown period is 30d
 *
 * ## Gateway (`fake.gatewayUrl`)
 *
 * Acts as a gateway beyond loopback: every request needs an enabled gateway
 * key (`Authorization: Bearer`, `x-api-key`, `x-goog-api-key` or `?key=`),
 * else 401 whose message quotes the last four characters of the key sent,
 * as magpie's does. `gatewayOpen: true` answers without a key, as on
 * loopback; `gatewayClosed: true` refuses everything with 403, as a gateway
 * that is not shared.
 *
 * - `GET /api/hello` → `{name: 'magpie', version}`
 * - `GET /v1/models` → `{object: 'list', data: [{id, object, owned_by, display_name}], has_more: false}`,
 *   held to the key's models (a `*` matches any run, slashes too; a group
 *   passes when named or when every member does)
 *
 * ## Faults
 *
 * `fake.fault({target, path?, times?, status?, body?, delayMs?, redirect?, oversize?})`
 * answers matching requests with the fault instead (`times` of them, or
 * all until `fake.clearFaults()`).
 */

import { randomBytes } from 'node:crypto'
import type { MagpiePeriod } from './types.js'

export interface FakeProviderSeed {
  readonly id: string
  readonly name?: string
  readonly preset?: string
  readonly host?: string
  readonly off?: boolean
  /** Model ids without the provider prefix. */
  readonly models?: readonly string[]
  /** A signed-in subscription. */
  readonly account?: {
    readonly agent: string
    readonly user: string
    readonly plan?: string
  }
  /** Sends as a vendor's own client. */
  readonly ownClient?: boolean
  readonly key?: string
}

export interface FakePresetSeed {
  readonly id: string
  readonly name?: string
  readonly kind?: string
  readonly noKey?: boolean
  readonly host?: string
  readonly models?: readonly string[]
  readonly endpoint?: string
  readonly ownClient?: boolean
}

export interface FakeGroupSeed {
  readonly id: string
  readonly name?: string
  readonly members?: readonly string[]
  readonly match?: readonly string[]
  readonly routing?: string
  readonly affinity?: string
  readonly classifier?: string
  /** Any other stored field, kept as given (weights, rules, …). */
  readonly extra?: Readonly<Record<string, unknown>>
}

export interface FakeUsageRow {
  readonly calls?: number
  readonly errors?: number
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly cost?: number
  readonly unpriced?: number
}

export interface FakeUsageSeed extends FakeUsageRow {
  readonly models?: readonly (FakeUsageRow & {
    readonly provider: string
    readonly model: string
  })[]
  readonly keys?: readonly (FakeUsageRow & { readonly keyId: string })[]
}

export interface FakeMagpieOptions {
  readonly webKey?: string
  readonly version?: string
  readonly providers?: readonly FakeProviderSeed[]
  readonly presets?: readonly FakePresetSeed[]
  readonly groups?: readonly FakeGroupSeed[]
  readonly usage?: Partial<Record<MagpiePeriod, FakeUsageSeed>>
  readonly gatewayOpen?: boolean
  readonly gatewayClosed?: boolean
}

export interface FakeFault {
  readonly target: 'management' | 'gateway'
  /** Only requests whose path starts with this. */
  readonly path?: string
  /** How many requests it answers; every one until cleared when absent. */
  readonly times?: number
  readonly status?: number
  readonly body?: string
  readonly contentType?: string
  readonly delayMs?: number
  /** Answer 302 to this location. */
  readonly redirect?: string
  /** Stream this many bytes with no length declared. */
  readonly oversize?: number
}

export interface FakeRequest {
  readonly target: 'management' | 'gateway'
  readonly method: string
  readonly path: string
  /** The web key cookie came, right. */
  readonly cookie: boolean
  /** The gateway key that came, if any. */
  readonly key: string | null
  readonly body: unknown
}

interface ProviderRecord {
  id: string
  name: string
  preset: string
  host: string
  off: boolean
  models: string[]
  account: NonNullable<FakeProviderSeed['account']> | null
  ownClient: boolean
  key: string
}

interface GroupRecord {
  [field: string]: unknown
  id: string
  name: string
  members: string[]
  match: string[]
}

interface LimitRecord {
  period: string
  days?: number
  hours?: number
  tokens?: number
  cost?: number
  cacheReads?: boolean
  since: string
}

interface KeyRecord {
  id: string
  name: string
  secret: string
  off: boolean
  limits: LimitRecord[]
  models: string[]
  accounts: string[]
  /** Tokens counted against each limit, for tests to set. */
  usedTokens: number
  usedCost: number
}

const DEFAULT_PRESETS: readonly FakePresetSeed[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'vendor',
    host: 'api.anthropic.com',
    models: ['claude-sonnet-5', 'claude-haiku-5'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'vendor',
    host: 'api.openai.com',
    models: ['gpt-6', 'gpt-6-mini'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'relay',
    host: 'openrouter.ai',
    models: ['anthropic/claude-sonnet-5', 'deepseek/deepseek-v4'],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'local',
    noKey: true,
    host: 'localhost:11434',
    models: ['qwen3'],
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    kind: 'vendor',
    endpoint: 'https://example.openai.azure.com',
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    kind: 'relay',
    host: 'opencode.ai',
    ownClient: true,
    models: ['big-pickle'],
  },
  { id: 'remote-magpie', name: 'Another magpie', kind: 'remote' },
]

const ROUTINGS = [
  '',
  'order',
  'rotate',
  'usage',
  'pace',
  'weight',
  'manual',
  'plugin',
]
const AFFINITIES = ['', 'session', 'turn', 'off', 'strict']
const LIMIT_WINDOWS = ['day', 'week', 'month', 'days', 'hours']
const KEY_PREFIX = 'sk-magpie-key-'
const LEGACY_PREFIX = 'sk-magpie-'

class Refusal extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strs(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function token(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

function globMatches(pattern: string, id: string): boolean {
  if (pattern.toLowerCase() === id.toLowerCase()) return true
  if (!pattern.includes('*')) return false
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'i').test(id)
}

function isPattern(member: string): boolean {
  return member.startsWith('re:') || member.includes('*')
}

function totals(row: FakeUsageRow | undefined): Record<string, number> {
  return {
    calls: row?.calls ?? 0,
    errors: row?.errors ?? 0,
    input: row?.input ?? 0,
    output: row?.output ?? 0,
    cache_read: row?.cacheRead ?? 0,
    cache_write: row?.cacheWrite ?? 0,
    reasoning: 0,
    cost: row?.cost ?? 0,
    unpriced: row?.unpriced ?? 0,
  }
}

export class FakeMagpie {
  readonly webKey: string
  readonly version: string
  readonly requests: FakeRequest[] = []
  gatewayOpen: boolean
  gatewayClosed: boolean
  readonly #providers: ProviderRecord[] = []
  readonly #presets: readonly FakePresetSeed[]
  readonly #groups: GroupRecord[] = []
  readonly #keys: KeyRecord[] = []
  readonly #usage: Partial<Record<MagpiePeriod, FakeUsageSeed>>
  readonly #faults: { fault: FakeFault; left: number }[] = []
  #management: ReturnType<typeof Bun.serve> | null = null
  #gateway: ReturnType<typeof Bun.serve> | null = null

  private constructor(options: FakeMagpieOptions) {
    this.webKey = options.webKey ?? token(24)
    this.version = options.version ?? '0.1.1268-fake'
    this.gatewayOpen = options.gatewayOpen ?? false
    this.gatewayClosed = options.gatewayClosed ?? false
    this.#presets = options.presets ?? DEFAULT_PRESETS
    this.#usage = { ...(options.usage ?? {}) }
    for (const seed of options.providers ?? []) this.addProvider(seed)
    for (const seed of options.groups ?? []) this.setGroup(seed)
  }

  static async start(options: FakeMagpieOptions = {}): Promise<FakeMagpie> {
    const fake = new FakeMagpie(options)
    fake.#management = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => fake.#serve('management', request),
    })
    fake.#gateway = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => fake.#serve('gateway', request),
    })
    return fake
  }

  get managementUrl(): string {
    return `http://127.0.0.1:${this.webPort}`
  }

  get gatewayUrl(): string {
    return `http://127.0.0.1:${this.#gateway?.port ?? 0}`
  }

  /** The port in the web key cookie's name. */
  get webPort(): number {
    return this.#management?.port ?? 0
  }

  async stop(): Promise<void> {
    await this.#management?.stop(true)
    await this.#gateway?.stop(true)
    this.#management = null
    this.#gateway = null
  }

  // --- test controls -------------------------------------------------------

  addProvider(seed: FakeProviderSeed): void {
    this.#providers.push({
      id: seed.id,
      name: seed.name ?? seed.id,
      preset: seed.preset ?? seed.id,
      host: seed.host ?? `${seed.id}.example.test`,
      off: seed.off ?? false,
      models: [...(seed.models ?? [])],
      account: seed.account ?? null,
      ownClient: seed.ownClient ?? false,
      key: seed.key ?? '',
    })
  }

  setGroup(seed: FakeGroupSeed): void {
    const record: GroupRecord = {
      ...(seed.extra ?? {}),
      id: seed.id,
      name: seed.name ?? seed.id,
      members: [...(seed.members ?? [])],
      match: [...(seed.match ?? [])],
      ...(seed.routing ? { routing: seed.routing } : {}),
      ...(seed.affinity ? { affinity: seed.affinity } : {}),
      ...(seed.classifier ? { classifier: seed.classifier } : {}),
    }
    const at = this.#groups.findIndex(group => group.id === seed.id)
    if (at === -1) this.#groups.push(record)
    else this.#groups[at] = record
  }

  setUsage(period: MagpiePeriod, seed: FakeUsageSeed): void {
    this.#usage[period] = seed
  }

  fault(fault: FakeFault): void {
    this.#faults.push({ fault, left: fault.times ?? Number.POSITIVE_INFINITY })
  }

  clearFaults(): void {
    this.#faults.length = 0
  }

  /** A key as magpie stores it, secret included, for tests to inspect. */
  key(idOrName: string): Readonly<KeyRecord> | undefined {
    return this.#keys.find(key => key.id === idOrName || key.name === idOrName)
  }

  /** Every key, secrets included. */
  keys(): readonly Readonly<KeyRecord>[] {
    return this.#keys
  }

  /** Set what a key has used of its limits. */
  setKeyUsed(id: string, tokens: number, cost = 0): void {
    const key = this.#keys.find(one => one.id === id)
    if (key !== undefined) {
      key.usedTokens = tokens
      key.usedCost = cost
    }
  }

  /** A group as magpie stores it. */
  group(id: string): Readonly<GroupRecord> | undefined {
    return this.#groups.find(group => group.id === id)
  }

  provider(id: string): Readonly<ProviderRecord> | undefined {
    return this.#providers.find(provider => provider.id === id)
  }

  // --- serving -------------------------------------------------------------

  async #serve(
    target: 'management' | 'gateway',
    request: Request,
  ): Promise<Response> {
    const url = new URL(request.url)
    const cookieName = `magpie_web_${this.webPort}`
    const cookie = (request.headers.get('cookie') ?? '')
      .split(';')
      .map(part => part.trim())
      .some(part => part === `${cookieName}=${this.webKey}`)
    const key = this.#callerKey(request, url)
    let body: unknown = null
    if (request.method === 'POST') {
      const raw = await request.text()
      try {
        body = raw === '' ? null : JSON.parse(raw)
      } catch {
        body = undefined
      }
    }
    this.requests.push({
      target,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      cookie,
      key,
      body,
    })
    const faulted = await this.#faulted(target, url.pathname)
    if (faulted !== null) return faulted
    try {
      if (target === 'management') {
        if (!url.pathname.startsWith('/api/')) {
          return new Response('magpie web', { status: 200 })
        }
        if (!cookie) {
          return new Response('unauthorized\n', {
            status: 401,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          })
        }
        if (body === undefined) throw new Refusal('invalid character in JSON')
        return this.#managementRoute(request.method, url, body)
      }
      return this.#gatewayRoute(request.method, url, key)
    } catch (error) {
      if (error instanceof Refusal) return json({ error: error.message }, 400)
      throw error
    }
  }

  async #faulted(
    target: 'management' | 'gateway',
    path: string,
  ): Promise<Response | null> {
    const entry = this.#faults.find(
      one =>
        one.left > 0 &&
        one.fault.target === target &&
        (one.fault.path === undefined || path.startsWith(one.fault.path)),
    )
    if (entry === undefined) return null
    entry.left -= 1
    const { fault } = entry
    if (fault.delayMs !== undefined) await Bun.sleep(fault.delayMs)
    if (fault.redirect !== undefined) {
      return new Response(null, {
        status: 302,
        headers: { location: fault.redirect },
      })
    }
    if (fault.oversize !== undefined) {
      const size = fault.oversize
      const chunk = new Uint8Array(64 * 1024).fill(0x61)
      let sent = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= size) {
            controller.close()
            return
          }
          const part = chunk.subarray(0, Math.min(chunk.length, size - sent))
          sent += part.length
          controller.enqueue(part)
        },
      })
      return new Response(stream, {
        status: fault.status ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (fault.status === undefined && fault.body === undefined) return null
    return new Response(fault.body ?? '', {
      status: fault.status ?? 200,
      headers: { 'content-type': fault.contentType ?? 'application/json' },
    })
  }

  #callerKey(request: Request, url: URL): string | null {
    const auth = request.headers.get('authorization') ?? ''
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
    return (
      request.headers.get('x-api-key') ??
      request.headers.get('x-goog-api-key') ??
      url.searchParams.get('key')
    )
  }

  #managementRoute(method: string, url: URL, body: unknown): Response {
    const path = url.pathname
    const input = isRecord(body) ? body : {}
    if (method === 'GET' && path === '/api/settings') {
      return json({
        version: this.version,
        gateway: this.gatewayUrl,
        onNetwork: !this.gatewayOpen,
        publicURL: '',
      })
    }
    if (method === 'GET' && path === '/api/providers') {
      return json(this.#providersState())
    }
    if (method === 'POST' && path.startsWith('/api/provider/')) {
      return this.#providerAction(path.slice('/api/provider/'.length), input)
    }
    if (method === 'GET' && path === '/api/groups') {
      return json(this.#groupsState())
    }
    if (method === 'POST' && path.startsWith('/api/groups/')) {
      return this.#groupAction(path.slice('/api/groups/'.length), input)
    }
    if (method === 'GET' && path === '/api/caller-keys') {
      return json({ keys: this.#keyRows(), accountNames: {} })
    }
    if (method === 'GET' && path === '/api/caller-keys/models') {
      return json(this.#keyModels())
    }
    if (method === 'POST' && path.startsWith('/api/caller-keys/')) {
      const secret = this.#keyAction(
        path.slice('/api/caller-keys/'.length),
        input,
      )
      return json({ keys: this.#keyRows(), accountNames: {}, secret })
    }
    if (method === 'GET' && path === '/api/usage') {
      return json(this.#usageState(url.searchParams.get('period') ?? ''))
    }
    return new Response('404 page not found\n', { status: 404 })
  }

  // providers

  #providerRow(provider: ProviderRecord): Record<string, unknown> {
    const masked =
      provider.key.length >= 12
        ? `…${provider.key.slice(-4)}`
        : provider.key === ''
          ? ''
          : '…'
    return {
      id: provider.id,
      name: provider.name,
      icon: '',
      preset: provider.preset,
      host: provider.host,
      chat: `https://${provider.host}/v1`,
      responses: '',
      anthropic: '',
      off: provider.off,
      ready: !provider.off && provider.models.length > 0,
      exposed: provider.models.length,
      models: provider.models.map(id => ({
        id,
        name: '',
        on: true,
        images: false,
      })),
      key: { set: provider.key !== '', masked, optional: false },
      keyList: [],
      sponsored: false,
      ...(provider.account === null
        ? {}
        : {
            account: { ...provider.account, agentName: provider.account.agent },
          }),
      ...(provider.ownClient ? { ownClient: true } : {}),
    }
  }

  #providersState(): Record<string, unknown> {
    return {
      providers: this.#providers.map(provider => this.#providerRow(provider)),
      presets: this.#presets.map(preset => ({
        id: preset.id,
        name: preset.name ?? preset.id,
        icon: '',
        kind: preset.kind ?? 'vendor',
        ...(preset.host === undefined
          ? {}
          : { chat: `https://${preset.host}/v1` }),
        ...(preset.noKey ? { noKey: true } : {}),
        ...(preset.endpoint === undefined ? {} : { endpoint: preset.endpoint }),
        ...(preset.ownClient ? { ownClient: true } : {}),
        added: this.#providers.some(provider => provider.preset === preset.id),
      })),
      excluded: [],
      gateway: { url: this.gatewayUrl, lan: !this.gatewayOpen, running: true },
      plugins: [],
    }
  }

  #findProvider(id: unknown): ProviderRecord {
    const found = this.#providers.find(provider => provider.id === str(id))
    if (found === undefined) throw new Refusal(`no provider ${str(id)}`)
    return found
  }

  #providerAction(action: string, input: Record<string, unknown>): Response {
    switch (action) {
      case 'save': {
        if (input['new'] !== true)
          throw new Refusal('fake magpie: only new saves')
        const presetId = str(input['preset'])
        const preset = this.#presets.find(one => one.id === presetId)
        const custom =
          str(input['chat']) ||
          str(input['responses']) ||
          str(input['anthropic'])
        if (preset === undefined && custom === '') {
          throw new Refusal(`unknown preset ${presetId}`)
        }
        const key = str(input['key']).trim()
        if (
          preset !== undefined &&
          custom === '' &&
          preset.endpoint !== undefined
        ) {
          throw new Refusal(
            `${preset.name ?? preset.id} needs your resource's endpoint`,
          )
        }
        if (
          preset !== undefined &&
          custom === '' &&
          !preset.noKey &&
          key === ''
        ) {
          throw new Refusal(`${preset.name ?? preset.id} needs an API key`)
        }
        const base =
          preset !== undefined && custom === ''
            ? preset.id
            : str(input['name'])
                .toLowerCase()
                .replace(/[^a-z0-9-]+/g, '-') || 'custom'
        let id = base
        for (
          let n = 2;
          this.#providers.some(provider => provider.id === id);
          n += 1
        ) {
          id = `${base}-${n}`
        }
        this.#providers.push({
          id,
          name: str(input['name']) || preset?.name || id,
          preset: preset !== undefined && custom === '' ? preset.id : '',
          host:
            preset !== undefined && custom === ''
              ? (preset.host ?? '')
              : new URL(custom).host,
          off: false,
          models: [
            ...(preset !== undefined && custom === ''
              ? (preset.models ?? [])
              : ['model-a']),
          ],
          account: null,
          ownClient: preset?.ownClient === true && custom === '',
          key,
        })
        return json(this.#providersState())
      }
      case 'on':
      case 'off': {
        this.#findProvider(input['id']).off = action === 'off'
        return json(this.#providersState())
      }
      case 'delete': {
        const provider = this.#findProvider(input['id'])
        this.#providers.splice(this.#providers.indexOf(provider), 1)
        return json(this.#providersState())
      }
      case 'test': {
        const provider = this.#findProvider(input['id'])
        const model = provider.models[0] ?? ''
        const ok = !provider.off && model !== ''
        return json({
          results: [
            {
              protocol: 'chat',
              ok,
              status: ok ? 200 : 401,
              ms: 42,
              model,
              ...(ok ? {} : { error: `invalid api key ${provider.key}` }),
            },
          ],
          provider: this.#providerRow(provider),
        })
      }
      case 'models': {
        const provider = this.#findProvider(input['id'])
        return json({
          count: provider.models.length,
          dropped: 0,
          provider: this.#providerRow(provider),
        })
      }
      default:
        return new Response('404 page not found\n', { status: 404 })
    }
  }

  // groups

  #entries(): string[] {
    return this.#providers
      .filter(provider => !provider.off)
      .flatMap(provider =>
        provider.models.map(model => `${provider.id}/${model}`),
      )
  }

  #matched(group: GroupRecord): string[] {
    if (group.match.length === 0) return []
    const named = new Set(group.members)
    return this.#entries().filter(
      id =>
        !named.has(id) &&
        group.match.some(pattern =>
          pattern.startsWith('re:')
            ? new RegExp(pattern.slice(3)).test(id)
            : globMatches(pattern, id),
        ),
    )
  }

  #groupRow(group: GroupRecord): Record<string, unknown> {
    const matched = this.#matched(group)
    const members = [...group.members, ...matched]
    const entries = new Set(this.#entries())
    return {
      ...group,
      members,
      ...(matched.length > 0 ? { matched } : {}),
      ready: members.some(member =>
        entries.has(member.split(':')[0] ?? member),
      ),
      memberInfo: members.map(id => ({ id, ready: entries.has(id) })),
      holds: [],
      offers: [],
      shared: [],
      patterns: group.match.map(pattern => ({
        pattern,
        models: matched.length,
      })),
    }
  }

  #groupsState(): Record<string, unknown> {
    return {
      groups: this.#groups.map(group => this.#groupRow(group)),
      models: [],
      pools: [],
      deciders: [],
      found: false,
      templates: [],
    }
  }

  #groupAction(action: string, input: Record<string, unknown>): Response {
    switch (action) {
      case 'save': {
        const to = str(input['id']).trim().toLowerCase()
        const from = str(input['from'])
        if (!/^[a-z0-9][a-z0-9.-]*$/.test(to)) {
          throw new Refusal(
            `a group's id must be lowercase letters, digits, dots and dashes, not "${str(input['id'])}"`,
          )
        }
        const routing = str(input['routing'])
        if (!ROUTINGS.includes(routing))
          throw new Refusal(`unknown routing ${routing}`)
        const affinity = str(input['affinity'])
        if (!AFFINITIES.includes(affinity))
          throw new Refusal(`unknown affinity ${affinity}`)
        // ownMembers: what was matched is left out, a pattern typed among the members is one
        const matched = strs(input['matched'])
        const members: string[] = []
        const match = strs(input['match'])
        for (const raw of strs(input['members'])) {
          const member = raw.trim()
          if (matched.includes(member)) continue
          if (isPattern(member)) match.push(member)
          else if (member !== '' && !members.includes(member))
            members.push(member)
        }
        if (members.length === 0 && match.length === 0) {
          throw new Refusal(
            'a group needs a model in it, or a pattern its models match',
          )
        }
        const stored: GroupRecord = {
          id: from !== '' && from !== to ? from : to,
          name: '',
          members,
          match,
        }
        for (const [field, value] of Object.entries(input)) {
          if (
            [
              'from',
              'matched',
              'members',
              'match',
              'id',
              'on',
              'order',
              'ids',
              'kind',
              'text',
            ].includes(field)
          )
            continue
          stored[field] = value
        }
        stored.name = str(input['name']) || to
        if (routing === '') delete stored['routing']
        if (affinity === '') delete stored['affinity']
        const at = this.#groups.findIndex(group => group.id === stored.id)
        if (at === -1) this.#groups.push(stored)
        else this.#groups[at] = stored
        if (stored.id !== to) {
          if (this.#groups.some(group => group.id === to)) {
            throw new Refusal(`there is a group ${to} already`)
          }
          stored.id = to
        }
        return json(this.#groupsState())
      }
      case 'delete': {
        const ids = strs(input['ids'])
        const targets = ids.length > 0 ? ids : [str(input['id'])]
        for (const id of targets) {
          if (!this.#groups.some(group => group.id === id)) {
            throw new Refusal(`no group ${id}`)
          }
        }
        for (const id of targets) {
          this.#groups.splice(
            this.#groups.findIndex(group => group.id === id),
            1,
          )
        }
        return json(this.#groupsState())
      }
      default:
        return new Response('404 page not found\n', { status: 404 })
    }
  }

  // keys

  #keyRows(): Record<string, unknown>[] {
    return this.#keys.map(key => {
      const managed = key.secret.startsWith(LEGACY_PREFIX)
      const masked = managed
        ? `${key.secret.startsWith(KEY_PREFIX) ? KEY_PREFIX : LEGACY_PREFIX}…${key.secret.slice(-6)}`
        : key.secret.length >= 12
          ? `…${key.secret.slice(-4)}`
          : '…'
      const [first, ...more] = key.limits
      const usedAll = key.limits.map(limit => ({
        period: limit.period,
        ...(limit.days ? { days: limit.days } : {}),
        ...(limit.hours ? { hours: limit.hours } : {}),
        start: limit.since,
        reset: new Date(Date.parse(limit.since) + 86_400_000).toISOString(),
        calls: 0,
        tokens: key.usedTokens,
        cost: key.usedCost,
        ...(limit.tokens ? { tokenLimit: limit.tokens } : {}),
        ...(limit.cost ? { costLimit: limit.cost } : {}),
        ...(limit.cacheReads ? { cacheReads: true } : {}),
        tokensLeft: Math.max(0, (limit.tokens ?? 0) - key.usedTokens),
        costLeft: Math.max(0, (limit.cost ?? 0) - key.usedCost),
        spent:
          (limit.tokens !== undefined && key.usedTokens >= limit.tokens) ||
          (limit.cost !== undefined && key.usedCost >= limit.cost),
      }))
      return {
        id: key.id,
        name: key.name,
        ...(key.off ? { off: true } : {}),
        masked,
        ...(first === undefined ? {} : { limit: first }),
        ...(more.length > 0 ? { moreLimits: more } : {}),
        ...(key.models.length > 0 ? { models: key.models } : {}),
        ...(key.accounts.length > 0 ? { accounts: key.accounts } : {}),
        ...(usedAll.length > 0 ? { used: usedAll[0], usedAll } : {}),
      }
    })
  }

  #keyModels(): Record<string, unknown> {
    return {
      models: [
        ...this.#groups.map(group => ({
          id: `group/${group.id}`,
          name: group.name,
          group: true,
        })),
        ...this.#providers
          .filter(provider => !provider.off)
          .flatMap(provider =>
            provider.models.map(model => ({
              id: `${provider.id}/${model}`,
              name: model,
              provider: provider.id,
              providerName: provider.name,
            })),
          ),
      ],
      accounts: this.#providers
        .filter(provider => provider.account !== null && !provider.off)
        .map(provider => ({
          id: `${provider.id}/acct-1`,
          name: provider.account?.user ?? '',
          provider: provider.id,
          account: true,
        })),
    }
  }

  #limitOf(
    raw: unknown,
    previous: LimitRecord | undefined,
  ): LimitRecord | null {
    if (!isRecord(raw)) return null
    const tokens = typeof raw['tokens'] === 'number' ? raw['tokens'] : 0
    const cost = typeof raw['cost'] === 'number' ? raw['cost'] : 0
    if (tokens < 0 || cost < 0) throw new Refusal("A limit can't be negative")
    if (tokens === 0 && cost === 0) return null
    const period = str(raw['period']) || 'day'
    if (!LIMIT_WINDOWS.includes(period)) {
      throw new Refusal(
        "A limit's period is day, week, month, every N days or every N hours",
      )
    }
    const days = typeof raw['days'] === 'number' ? raw['days'] : 0
    const hours = typeof raw['hours'] === 'number' ? raw['hours'] : 0
    if (period === 'days' && (days < 1 || days > 3650)) {
      throw new Refusal(
        "A limit's cycle is a whole number of days from 1 to 3650",
      )
    }
    if (period === 'hours' && (hours < 1 || hours > 8760)) {
      throw new Refusal(
        "A limit's cycle is a whole number of hours from 1 to 8760",
      )
    }
    const same =
      previous !== undefined &&
      previous.period === period &&
      (previous.days ?? 0) === (period === 'days' ? days : 0) &&
      (previous.hours ?? 0) === (period === 'hours' ? hours : 0)
    return {
      period,
      ...(period === 'days' ? { days } : {}),
      ...(period === 'hours' ? { hours } : {}),
      ...(tokens > 0 ? { tokens } : {}),
      ...(cost > 0 ? { cost: Math.round(cost * 1e4) / 1e4 } : {}),
      ...(raw['cacheReads'] === true ? { cacheReads: true } : {}),
      since: same ? previous.since : new Date().toISOString(),
    }
  }

  #keyAction(action: string, input: Record<string, unknown>): string {
    const name = str(input['name']).trim()
    if (action === 'add-key' || action === 'rename-key') {
      if (name === '' || [...name].length > 120) {
        throw new Refusal('Use a name between 1 and 120 characters')
      }
    }
    if (action === 'add-key') {
      let secret = str(input['secret']).trim()
      if (secret !== '') {
        if (secret.length < 8 || secret.length > 256) {
          throw new Refusal('Use a key between 8 and 256 characters')
        }
        if (!/^[!-~]+$/.test(secret)) {
          throw new Refusal(
            'A key can have only letters, digits and ASCII symbols, no spaces',
          )
        }
        if (secret.startsWith(LEGACY_PREFIX)) {
          throw new Refusal(
            "A key of your own can't start with sk-magpie-: leave the key empty and magpie makes one",
          )
        }
        if (this.#keys.some(key => key.secret === secret)) {
          throw new Refusal('Another gateway key already has this key')
        }
      } else {
        secret = `${KEY_PREFIX}${token(24)}`
      }
      this.#keys.push({
        id: randomBytes(12).toString('hex'),
        name,
        secret,
        off: false,
        limits: [],
        models: [],
        accounts: [],
        usedTokens: 0,
        usedCost: 0,
      })
      return secret
    }
    const key = this.#keys.find(one => one.id === str(input['key']))
    if (key === undefined) throw new Refusal('Key not found')
    const index = typeof input['index'] === 'number' ? input['index'] : null
    switch (action) {
      case 'rotate-key':
        key.secret = `${KEY_PREFIX}${token(24)}`
        return key.secret
      case 'rename-key':
        key.name = name
        return ''
      case 'limit-key': {
        let limits = [...key.limits]
        if (index === null) {
          const limit = this.#limitOf(input['limit'], limits[0])
          limits = limit === null ? [] : [limit]
        } else {
          const limit = this.#limitOf(input['limit'], limits[index])
          if (
            index < 0 ||
            index > limits.length ||
            (index === limits.length && limit === null)
          ) {
            throw new Refusal('This key has no such limit')
          }
          if (limit === null) limits.splice(index, 1)
          else if (index === limits.length) {
            if (limits.length >= 5)
              throw new Refusal('A key can have at most 5 limits')
            limits.push(limit)
          } else limits[index] = limit
        }
        for (let a = 0; a < limits.length; a += 1) {
          for (let b = a + 1; b < limits.length; b += 1) {
            const x = limits[a]
            const y = limits[b]
            if (
              x !== undefined &&
              y !== undefined &&
              x.period === y.period &&
              x.days === y.days &&
              x.hours === y.hours
            ) {
              throw new Refusal(
                `This key already has a limit ${x.period}: change that one instead`,
              )
            }
          }
        }
        key.limits = limits
        return ''
      }
      case 'reset-limit-key': {
        if (key.limits.length === 0)
          throw new Refusal('This key has no limit to reset')
        const now = new Date().toISOString()
        if (index !== null) {
          const limit = key.limits[index]
          if (limit === undefined)
            throw new Refusal('This key has no such limit')
          limit.since = now
        } else {
          for (const limit of key.limits) limit.since = now
        }
        key.usedTokens = 0
        key.usedCost = 0
        return ''
      }
      case 'models-key': {
        const out: string[] = []
        for (const raw of strs(input['models'])) {
          const model = raw.trim()
          if (
            model === '' ||
            out.some(one => one.toLowerCase() === model.toLowerCase())
          )
            continue
          if (
            !model.includes('/') ||
            model.startsWith('/') ||
            model.endsWith('/')
          ) {
            throw new Refusal(
              `A key's model is <provider>/<model> or <provider>/*, like openai/gpt-5 or anthropic/*: ${model}`,
            )
          }
          if (model.length > 300)
            throw new Refusal("A key's model is at most 300 characters")
          out.push(model)
        }
        if (out.length > 500)
          throw new Refusal('A key can list at most 500 models')
        key.models = out
        return ''
      }
      case 'accounts-key':
        key.accounts = strs(input['accounts'])
        return ''
      case 'on-key':
      case 'off-key':
        key.off = action === 'off-key'
        return ''
      case 'remove-key':
        this.#keys.splice(this.#keys.indexOf(key), 1)
        return ''
      case 'copy-key':
        return key.secret
      default:
        throw new Refusal(`unknown key action "${action}"`)
    }
  }

  // usage

  #usageState(raw: string): Record<string, unknown> {
    const period: MagpiePeriod = (
      ['today', '7d', '30d', 'all'] as const
    ).includes(raw as MagpiePeriod)
      ? (raw as MagpiePeriod)
      : '30d'
    const seed = this.#usage[period]
    return {
      period,
      since:
        seed === undefined ? '0001-01-01T00:00:00Z' : '2026-10-01T00:00:00Z',
      ...totals(seed),
      bucket: 'day',
      series: [],
      agents: [],
      models: (seed?.models ?? []).map(row => ({
        id: `${row.provider}/${row.model}`,
        provider: row.provider,
        model: row.model,
        ...totals(row),
        name: row.model,
        sub: row.provider,
      })),
      providerKeys: [],
      accounts: [],
      callerKeys: (seed?.keys ?? []).map(row => ({
        id: row.keyId,
        callerKeyId: row.keyId,
        ...totals(row),
        name: this.#keys.find(key => key.id === row.keyId)?.name ?? row.keyId,
      })),
      sessions: [],
      sessionCount: 0,
      path: '~/.magpie/usage.jsonl',
    }
  }

  // gateway

  #gatewayRoute(method: string, url: URL, sent: string | null): Response {
    if (this.gatewayClosed) {
      return new Response("magpie isn't shared on the local network\n", {
        status: 403,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }
    const key =
      sent === null
        ? undefined
        : this.#keys.find(one => one.secret === sent && !one.off)
    if (!this.gatewayOpen && key === undefined) {
      const which =
        sent === null || sent === ''
          ? 'no API key was sent'
          : sent.length >= 12
            ? `the API key ending in ${sent.slice(-4)} is not an enabled magpie gateway key`
            : 'the API key sent is not an enabled magpie gateway key'
      return json(
        { error: { message: which, type: 'authentication_error' } },
        401,
      )
    }
    if (method === 'GET' && url.pathname === '/api/hello') {
      return json({ name: 'magpie', version: this.version })
    }
    if (method === 'GET' && url.pathname === '/v1/models') {
      const patterns = key?.models ?? []
      const allows = (...ids: string[]) =>
        patterns.length === 0 ||
        ids.some(id => patterns.some(pattern => globMatches(pattern, id)))
      const data: Record<string, unknown>[] = []
      for (const group of this.#groups) {
        const members = [...group.members, ...this.#matched(group)].map(
          member => member.split(':')[0] ?? member,
        )
        const named = allows(`group/${group.id}`)
        const every =
          members.length > 0 && members.every(member => allows(member))
        if (named || every || patterns.length === 0) {
          data.push({
            id: `group/${group.id}`,
            object: 'model',
            owned_by: 'magpie',
            display_name: group.name,
          })
        }
      }
      for (const provider of this.#providers) {
        if (provider.off) continue
        for (const model of provider.models) {
          const id = `${provider.id}/${model}`
          if (allows(id)) {
            data.push({
              id,
              object: 'model',
              owned_by: provider.id,
              display_name: model,
            })
          }
        }
      }
      return json({ object: 'list', data, has_more: false })
    }
    return json({ error: { message: 'not found' } }, 404)
  }
}
