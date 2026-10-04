// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A hand-written {@link ProviderPort} for the model-service page suites: an
 * in-memory hub with three nodes, two profiles and a small catalog, that
 * counts what is asked of it.
 *
 * It keeps the port's contract where the pages lean on it — writes need a
 * personal `ops` caller outside break-glass and are refused unrecorded
 * otherwise; an allowed write records itself once (one line per node for an
 * apply, none for a dry run); fingerprints and full URLs are in what it
 * returns, so the page's trimming is what is under test. It does not compile,
 * validate or reach a node: the real port does that, and
 * `tests/integration/qianmo-providers-page.test.ts` runs it.
 */

import type {
  ProviderActivity,
  ProviderApplyResult,
  ProviderAssignment,
  ProviderAutocompactResult,
  ProviderCaller,
  ProviderCandidate,
  ProviderCatalog,
  ProviderCompilePreview,
  ProviderExport,
  ProviderFailure,
  ProviderImportInput,
  ProviderImportPreview,
  ProviderNodeActual,
  ProviderNodeView,
  ProviderOverview,
  ProviderPort,
  ProviderPresetView,
  ProviderProbeResult,
  ProviderProfileDraft,
  ProviderProfileView,
  ProviderResult,
} from '../src/deps.js'

export const NOW = 1_790_000_000_000
export const FINGERPRINT = 'fp1:3f9a1c2e5b6d7e8f90a1b2c3d4e5f607'
export const SHORT_FINGERPRINT = '3f9a1c2e'
export const DEEPSEEK_URL = 'https://api.deepseek.com/anthropic'
export const CHAT_URL = 'https://chat.example.com/v1/secret-path'

function ok<T>(value: T): ProviderResult<T> {
  return { ok: true, value }
}

function failed<T>(
  code: ProviderFailure['code'],
  message: string,
  extra: Partial<ProviderFailure> = {},
): ProviderResult<T> {
  return { ok: false, failure: { code, message, ...extra } }
}

const ANTHROPIC_BITS = {
  mode: 'explicit',
  thinking: true,
  adaptive_thinking: false,
  interleaved_thinking: false,
} as const

function preset(
  entry: Partial<ProviderPresetView> &
    Pick<
      ProviderPresetView,
      'id' | 'vendor' | 'name' | 'group' | 'plan' | 'lane'
    >,
): ProviderPresetView {
  return {
    baseUrl: `https://${entry.id}.example.com/v1`,
    sites: [],
    templateVars: [],
    authScheme: 'bearer',
    models: [],
    compat: {},
    keyHint: null,
    terms: null,
    source: { url: 'https://example.com/docs', verifiedAt: '2026-09-30' },
    evaluated: false,
    listed: true,
    unverified: [],
    notes: [],
    ...entry,
  }
}

export const CATALOG: ProviderCatalog = {
  groups: ['cn-paygo', 'intl', 'plan', 'local', 'custom'],
  presets: [
    preset({
      id: 'deepseek',
      vendor: 'DeepSeek',
      name: 'DeepSeek',
      group: 'cn-paygo',
      plan: 'paygo',
      lane: 'anthropic',
      baseUrl: DEEPSEEK_URL,
      models: [
        {
          id: 'deepseek-v4-pro',
          role: 'main',
          tiers: ['opus', 'sonnet'],
          capabilities: ANTHROPIC_BITS,
          effort: {
            send: 'always',
            level: 'max',
            levels: ['low', 'high', 'max'],
          },
        },
      ],
      compat: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' },
      keyHint: { prefixes: ['sk-'], display: 'sk-' },
    }),
    preset({
      id: 'kimi',
      vendor: '月之暗面',
      name: 'Kimi',
      group: 'cn-paygo',
      plan: 'paygo',
      lane: 'anthropic',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      sites: [
        {
          id: 'cn',
          label: '国内站',
          baseUrl: 'https://api.moonshot.cn/anthropic',
        },
        {
          id: 'intl',
          label: '国际站',
          baseUrl: 'https://api.moonshot.ai/anthropic',
        },
      ],
      models: [
        {
          id: 'kimi-k3',
          role: 'main',
          tiers: ['opus'],
          capabilities: { mode: 'family' },
          effort: { send: 'auto' },
        },
      ],
      keyHint: { prefixes: ['sk-'], display: 'sk-' },
    }),
    preset({
      id: 'kimi-code',
      vendor: '月之暗面',
      name: 'Kimi Code 套餐',
      group: 'plan',
      plan: 'plan',
      lane: 'anthropic',
      keyHint: { prefixes: ['sk-kimi-'], display: 'sk-kimi-' },
      terms: {
        restricted: true,
        note: '仅限编程工具使用，禁止转售。',
        url: 'https://example.com/terms',
      },
      models: [
        {
          id: 'k3',
          role: 'main',
          tiers: ['opus'],
          capabilities: { mode: 'family' },
          effort: { send: 'auto' },
        },
      ],
    }),
    preset({
      id: 'qwen',
      vendor: '阿里云',
      name: '百炼',
      group: 'cn-paygo',
      plan: 'paygo',
      lane: 'anthropic',
      baseUrl: 'https://{WorkspaceId}.{region}.example.com/anthropic',
      templateVars: [
        { name: 'WorkspaceId', label: '业务空间 ID' },
        { name: 'region', label: '地域（例如 cn-beijing）' },
      ],
      models: [
        {
          id: 'qwen3.8-max',
          role: 'main',
          tiers: ['opus'],
          capabilities: { mode: 'family' },
          effort: { send: 'auto' },
        },
      ],
    }),
    preset({
      id: 'anthropic',
      vendor: 'Anthropic',
      name: 'Anthropic',
      group: 'intl',
      plan: 'paygo',
      lane: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      authScheme: 'x-api-key',
      models: [
        {
          id: 'claude-opus-5-5',
          role: 'main',
          tiers: ['opus'],
          capabilities: { mode: 'family' },
          effort: { send: 'auto' },
        },
      ],
    }),
    preset({
      id: 'azure',
      vendor: 'Microsoft',
      name: 'Azure OpenAI',
      group: 'intl',
      plan: 'paygo',
      lane: 'openai-responses',
      listed: false,
    }),
    preset({
      id: 'ollama',
      vendor: 'Ollama',
      name: 'Ollama',
      group: 'local',
      plan: 'local',
      lane: 'anthropic',
      baseUrl: 'http://127.0.0.1:11434',
      placeholderKey: 'ollama',
    }),
    preset({
      id: 'custom-openai',
      vendor: '自定义',
      name: '自定义 OpenAI 兼容',
      group: 'custom',
      plan: 'custom',
      lane: 'openai-chat',
      baseUrl: '',
    }),
  ],
}

function deepseekProfile(revision: number): ProviderProfileView {
  return {
    id: 'deepseek',
    revision,
    name: 'DeepSeek',
    presetId: 'deepseek',
    plan: 'paygo',
    site: null,
    lane: 'anthropic',
    baseUrl: DEEPSEEK_URL,
    models: [
      {
        id: 'deepseek-v4-pro',
        role: 'main',
        tiers: ['opus', 'sonnet'],
        capabilities: ANTHROPIC_BITS,
        effort: {
          send: 'always',
          level: 'max',
          levels: ['low', 'high', 'max'],
        },
        // The hub asks for 500k; the node clamps to what it can (D-8).
        contextTokens: 500_000,
      },
    ],
    compat: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' },
    effortLock: null,
    keySelection: 'fill_first',
    auth: { scheme: 'bearer' },
    keys: [
      { id: 'k1', fingerprint: FINGERPRINT, setAt: '2026-10-03T06:20:00.000Z' },
    ],
    evaluated: false,
  }
}

function chatProfile(revision: number): ProviderProfileView {
  return {
    id: 'chat-svc',
    revision,
    name: '自建网关',
    presetId: 'custom-openai',
    plan: 'custom',
    site: null,
    lane: 'openai-chat',
    baseUrl: CHAT_URL,
    models: [
      {
        id: 'gateway-large',
        role: 'main',
        tiers: ['opus', 'sonnet', 'haiku'],
        capabilities: {
          mode: 'explicit',
          thinking: false,
          adaptive_thinking: false,
          interleaved_thinking: false,
        },
        effort: { send: 'never' },
      },
    ],
    auth: { scheme: 'bearer' },
    keys: [{ id: 'k1' }],
    evaluated: false,
  }
}

function capabilities(
  chat: boolean,
  replay: boolean,
): ProviderNodeActual['capabilities'] {
  return {
    protocol: 1,
    chatEffortHonorsOverride: chat,
    replayFilter: replay,
    multiKey: false,
  }
}

function nodeA(): ProviderNodeView {
  const recent: ProviderActivity[] = [
    {
      kind: 'probe',
      at: NOW - 120_000,
      requestId: 'req-probe-a',
      profileId: 'deepseek',
      outcome: 'ok',
      mode: 'auth',
    },
    {
      kind: 'apply',
      at: NOW - 3_600_000,
      requestId: 'req-apply-a',
      profileId: 'deepseek',
      outcome: 'ok',
    },
  ]
  return {
    node: 'node-a',
    executor: 'local',
    assignment: { mode: 'inherit' },
    contextOverride: null,
    expected: { profileId: 'deepseek', revision: 3, contextOverride: null },
    actual: {
      managed: true,
      applied: {
        profileId: 'deepseek',
        revision: 3,
        requestId: 'req-apply-a',
        at: new Date(NOW - 3_600_000).toISOString(),
      },
      onDiskHash: 'hash-disk-a',
      appliedHash: 'hash-applied-a',
      loadedHash: 'hash-applied-a',
      pending: null,
      resident: { running: true, generation: 4, inFlight: 0 },
      inheritedProviderKeys: [],
      capabilities: capabilities(true, true),
      lastResult: null,
      effective: {
        apiProvider: 'firstParty',
        wire: 'anthropic',
        model: 'deepseek-v4-pro',
        wireModel: 'deepseek-v4-pro',
        modelSettingsSlot: 'opus',
        effortOnWire: true,
        effortLevel: 'max',
        contextTokens: 200_000,
        autoCompactWindow: 180_000,
        autoCompactSource: 'settings',
      },
    },
    lastStatus: { at: NOW - 60_000, ok: true },
    drift: [],
    recent,
  }
}

function nodeB(): ProviderNodeView {
  return {
    node: 'node-b',
    executor: 'ssh',
    assignment: { mode: 'profile', profileId: 'chat-svc' },
    contextOverride: 1_000_000,
    expected: {
      profileId: 'chat-svc',
      revision: 1,
      contextOverride: 1_000_000,
    },
    actual: {
      managed: true,
      applied: {
        profileId: 'deepseek',
        revision: 2,
        requestId: 'req-old-b',
        at: new Date(NOW - 86_400_000).toISOString(),
      },
      onDiskHash: 'hash-disk-b',
      appliedHash: 'hash-applied-b',
      loadedHash: 'hash-applied-b',
      pending: null,
      resident: { running: true, generation: 2, inFlight: 1 },
      inheritedProviderKeys: ['ANTHROPIC_BASE_URL'],
      capabilities: capabilities(false, false),
      lastResult: {
        requestId: 'req-conflict-b',
        code: 'conflict',
        at: new Date(NOW - 600_000).toISOString(),
        diffKeys: ['env.ANTHROPIC_MODEL'],
      },
      effective: {
        apiProvider: 'firstParty',
        wire: 'anthropic',
        model: 'deepseek-v4-pro',
        wireModel: 'deepseek-v4-pro',
        modelSettingsSlot: 'opus',
        effortOnWire: true,
        effortLevel: 'high',
        contextTokens: 200_000,
        autoCompactWindow: 150_000,
        autoCompactSource: 'env',
      },
    },
    lastStatus: {
      at: NOW - 300_000,
      ok: false,
      message: '节点无响应，已超时。',
    },
    drift: [
      {
        kind: 'out-of-sync',
        message: '期望（chat-svc r1）与实际不同、需要下发',
      },
      {
        kind: 'local-edit',
        message: '本地改动（env.ANTHROPIC_MODEL）',
        keys: ['env.ANTHROPIC_MODEL'],
      },
      { kind: 'env-residue', message: '进程环境残留、需重启' },
    ],
    recent: [
      {
        kind: 'apply',
        at: NOW - 600_000,
        requestId: 'req-conflict-b',
        profileId: 'chat-svc',
        outcome: 'refused',
        code: 'conflict',
      },
    ],
  }
}

function nodeC(): ProviderNodeView {
  return {
    node: 'node-c',
    executor: 'local',
    assignment: { mode: 'unmanaged' },
    contextOverride: null,
    expected: null,
    actual: null,
    lastStatus: null,
    drift: [],
    recent: [],
  }
}

/** One write the fake saw, after the role check let it through. */
export interface FakeWrite {
  readonly method: string
  readonly input: unknown
}

export class FakeProviders implements ProviderPort {
  readonly profiles = new Map<string, ProviderProfileView>([
    ['deepseek', deepseekProfile(3)],
    ['chat-svc', chatProfile(1)],
  ])
  readonly secretSet = new Map<string, string | undefined>([
    ['deepseek', '2026-10-03T06:20:00.000Z'],
  ])
  readonly nodes = new Map<string, ProviderNodeView>([
    ['node-a', nodeA()],
    ['node-b', nodeB()],
    ['node-c', nodeC()],
  ])
  defaultProfileId: string | null = 'deepseek'
  revision = 7
  /** Every method called, reads included, in order. */
  readonly calls: string[] = []
  /** Writes the role check let through. */
  readonly writes: FakeWrite[] = []
  /** Set to make every read answer this failure. */
  down: ProviderFailure | null = null
  /** What the next write answers instead of doing it. */
  nextFailure: ProviderFailure | null = null

  // --- reads --------------------------------------------------------------

  overview(): Promise<ProviderResult<ProviderOverview>> {
    this.calls.push('overview')
    if (this.down !== null)
      return Promise.resolve({ ok: false, failure: this.down })
    const nodes = [...this.nodes.values()]
    return Promise.resolve(
      ok({
        revision: this.revision,
        defaultProfileId: this.defaultProfileId,
        profiles: [...this.profiles.values()].map(profile => ({
          profile,
          secrets: profile.keys.map(key => ({
            keyId: key.id,
            set: key.fingerprint !== undefined,
            ...(key.setAt === undefined ? {} : { setAt: key.setAt }),
          })),
          nodes: nodes
            .filter(node => node.expected?.profileId === profile.id)
            .map(node => node.node),
          isDefault: profile.id === this.defaultProfileId,
        })),
        nodes,
      }),
    )
  }

  profile(id: string): Promise<ProviderResult<ProviderProfileView>> {
    this.calls.push('profile')
    const found = this.profiles.get(id)
    return Promise.resolve(
      found === undefined ? failed('not_found', '没有这份档案') : ok(found),
    )
  }

  catalog(): ProviderCatalog {
    this.calls.push('catalog')
    return CATALOG
  }

  draftFromPreset(input: {
    readonly presetId: string
    readonly site?: string
  }): ProviderResult<ProviderProfileView> {
    this.calls.push('draftFromPreset')
    const found = CATALOG.presets.find(entry => entry.id === input.presetId)
    if (found === undefined) return failed('not_found', '没有这个预设')
    const site =
      input.site === undefined
        ? found.sites[0]
        : found.sites.find(entry => entry.id === input.site)
    let id = found.id
    for (let n = 2; this.profiles.has(id); n += 1) id = `${found.id}-${n}`
    return ok({
      id,
      revision: 0,
      name: found.name,
      presetId: found.id,
      plan: found.plan,
      site: site?.id ?? null,
      lane: found.lane,
      baseUrl: site?.baseUrl ?? found.baseUrl,
      models: found.models,
      compat: found.compat,
      effortLock: null,
      keySelection: 'fill_first',
      auth: { scheme: found.authScheme },
      keys: [{ id: 'k1' }],
      ...(found.terms === null ? {} : { terms: found.terms }),
      evaluated: false,
    })
  }

  preview(input: {
    readonly candidate: ProviderCandidate
    readonly node?: string
  }): Promise<ProviderResult<ProviderCompilePreview>> {
    this.calls.push('preview')
    this.writes.push({ method: 'preview', input })
    return Promise.resolve(
      ok({
        modelType: 'anthropic',
        route: 'direct',
        effectiveLane: 'anthropic',
        set: { ANTHROPIC_AUTH_TOKEN: null },
        secretKeys: ['ANTHROPIC_AUTH_TOKEN'],
        deleted: [],
        modelSettings: {},
        warnings: [],
      }),
    )
  }

  node(name: string): Promise<ProviderResult<ProviderNodeView>> {
    this.calls.push('node')
    const found = this.nodes.get(name)
    return Promise.resolve(
      found === undefined ? failed('not_found', '没有这个节点') : ok(found),
    )
  }

  refreshNode(name: string): Promise<ProviderResult<ProviderNodeView>> {
    this.calls.push('refreshNode')
    return this.node(name)
  }

  exportProfiles(
    ids?: readonly string[],
  ): Promise<ProviderResult<ProviderExport>> {
    this.calls.push('exportProfiles')
    const chosen = [...this.profiles.values()].filter(
      profile => ids === undefined || ids.includes(profile.id),
    )
    const profiles = chosen.map(profile => ({
      ...profile,
      keys: profile.keys.map(key => ({ id: key.id })),
    }))
    return Promise.resolve(
      ok({
        filename: 'qianmo-providers-2026-10-03.json',
        text: JSON.stringify({
          v: 1,
          kind: 'qianmo-providers',
          secrets: 'not-included',
          profiles,
        }),
        count: profiles.length,
      }),
    )
  }

  importPreview(text: string): Promise<ProviderResult<ProviderImportPreview>> {
    this.calls.push('importPreview')
    if (text.includes('"apiKey"')) {
      return Promise.resolve(
        failed('invalid', '有不认识的键，整份拒绝。', {
          path: 'profiles.0.apiKey',
        }),
      )
    }
    return Promise.resolve(ok({ profiles: [], collisions: [], warnings: [] }))
  }

  async models(
    input: { readonly node: string; readonly candidate?: ProviderCandidate },
    caller: ProviderCaller,
  ): Promise<ProviderResult<readonly { readonly id: string }[]>> {
    this.calls.push('models')
    const denied = this.#deny<readonly { readonly id: string }[]>(caller)
    if (denied !== null) return denied
    this.writes.push({ method: 'models', input })
    return ok([{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }])
  }

  // --- writes -------------------------------------------------------------

  #deny<T>(caller: ProviderCaller): ProviderResult<T> | null {
    if (
      caller.role !== 'ops' ||
      caller.breakGlass ||
      !caller.subject.startsWith('u:')
    ) {
      return failed('rejected', '需要运维角色的个人账号')
    }
    return null
  }

  async #write<T>(
    method: string,
    input: unknown,
    caller: ProviderCaller,
    action: Parameters<ProviderCaller['record']>[0],
    target: string,
    run: () => ProviderResult<T>,
  ): Promise<ProviderResult<T>> {
    this.calls.push(method)
    const denied = this.#deny<T>(caller)
    if (denied !== null) return denied
    this.writes.push({ method, input })
    const result: ProviderResult<T> =
      this.nextFailure === null
        ? run()
        : { ok: false, failure: this.nextFailure }
    this.nextFailure = null
    await caller.record(
      action,
      target,
      result.ok ? 'ok' : 'failed',
      result.ok ? undefined : result.failure.code,
    )
    if (result.ok) this.revision += 1
    return result
  }

  saveProfile(
    input: {
      readonly profile: ProviderProfileDraft
      readonly ifMatch: number | null
      readonly secrets?: Readonly<Record<string, string>>
    },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderProfileView>> {
    const id = typeof input.profile.id === 'string' ? input.profile.id : ''
    return this.#write(
      'saveProfile',
      input,
      caller,
      'provider.save',
      `profile:${id}`,
      () => {
        const existing = this.profiles.get(id)
        if (input.ifMatch === null && existing !== undefined) {
          return failed('conflict', '这个 id 已经有档案了，换一个 id', {
            fields: ['id'],
          })
        }
        if (input.ifMatch !== null && existing?.revision !== input.ifMatch) {
          return failed('conflict', '此服务已被他人修改，刷新后再保存', {
            fields: ['models'],
          })
        }
        const saved = {
          ...(input.profile as unknown as ProviderProfileView),
          revision: (existing?.revision ?? 0) + 1,
          keys: [
            input.secrets === undefined
              ? (existing?.keys[0] ?? { id: 'k1' })
              : {
                  id: 'k1',
                  fingerprint: FINGERPRINT,
                  setAt: '2026-10-03T07:00:00.000Z',
                },
          ],
        }
        this.profiles.set(id, saved)
        return ok(saved)
      },
    )
  }

  deleteProfile(
    input: { readonly profileId: string; readonly ifMatch: number },
    caller: ProviderCaller,
  ): Promise<ProviderResult<void>> {
    return this.#write(
      'deleteProfile',
      input,
      caller,
      'provider.delete',
      `profile:${input.profileId}`,
      () => {
        const users = [...this.nodes.values()]
          .filter(node => node.expected?.profileId === input.profileId)
          .map(node => node.node)
        if (users.length > 0) {
          return failed('in_use', '还有节点在用这份档案，先指定替代档案', {
            nodes: users,
          })
        }
        this.profiles.delete(input.profileId)
        return ok(undefined)
      },
    )
  }

  setSecret(
    input: {
      readonly profileId: string
      readonly keyId: string
      readonly value: string
      readonly ifMatch: number
    },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderProfileView>> {
    return this.#write(
      'setSecret',
      input,
      caller,
      'provider.secret.set',
      input.profileId,
      () => {
        const existing = this.profiles.get(input.profileId)
        if (existing === undefined) return failed('not_found', '没有这份档案')
        return ok(existing)
      },
    )
  }

  clearSecret(
    input: {
      readonly profileId: string
      readonly keyId: string
      readonly ifMatch: number
    },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderProfileView>> {
    return this.#write(
      'clearSecret',
      input,
      caller,
      'provider.secret.clear',
      input.profileId,
      () => {
        const existing = this.profiles.get(input.profileId)
        if (existing === undefined) return failed('not_found', '没有这份档案')
        return ok(existing)
      },
    )
  }

  setDefault(
    input: { readonly profileId: string | null },
    caller: ProviderCaller,
  ): Promise<ProviderResult<void>> {
    return this.#write(
      'setDefault',
      input,
      caller,
      'provider.default.set',
      input.profileId ?? 'none',
      () => {
        this.defaultProfileId = input.profileId
        return ok(undefined)
      },
    )
  }

  assign(
    input: { readonly node: string; readonly assignment: ProviderAssignment },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderNodeView>> {
    return this.#write(
      'assign',
      input,
      caller,
      'provider.assign',
      `node:${input.node}`,
      () => {
        const node = this.nodes.get(input.node)
        if (node === undefined) return failed('not_found', '没有这个节点')
        const next = { ...node, assignment: input.assignment }
        this.nodes.set(input.node, next)
        return ok(next)
      },
    )
  }

  setContextOverride(
    input: { readonly node: string; readonly tokens: number | null },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderNodeView>> {
    return this.#write(
      'setContextOverride',
      input,
      caller,
      input.tokens === null ? 'provider.context.clear' : 'provider.context.set',
      `node:${input.node}`,
      () => {
        const node = this.nodes.get(input.node)
        if (node === undefined) return failed('not_found', '没有这个节点')
        const next = { ...node, contextOverride: input.tokens }
        this.nodes.set(input.node, next)
        return ok(next)
      },
    )
  }

  async apply(
    input: {
      readonly nodes?: readonly string[]
      readonly dryRun?: boolean
      readonly force?: boolean
      readonly sessions?: 'keep' | 'reset'
      readonly profileId?: string
    },
    caller: ProviderCaller,
  ): Promise<ProviderResult<readonly ProviderApplyResult[]>> {
    this.calls.push(input.dryRun === true ? 'apply.dryRun' : 'apply')
    const denied = this.#deny<readonly ProviderApplyResult[]>(caller)
    if (denied !== null) return denied
    this.writes.push({ method: 'apply', input })
    const names = input.nodes ?? [...this.nodes.keys()]
    const results: ProviderApplyResult[] = names.map(name => ({
      node: name,
      requestId: `req-${name}`,
      outcome: name === 'node-b' && input.force !== true ? 'refused' : 'ok',
      ...(name === 'node-b' && input.force !== true
        ? { code: 'conflict', diffKeys: ['env.ANTHROPIC_MODEL'] }
        : { pending: true, sessions: 'reset' as const }),
      message:
        name === 'node-b' && input.force !== true
          ? '节点上的配置被改过，拒绝覆盖。'
          : '已写入，等待空闲。',
      ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
    }))
    if (input.dryRun !== true) {
      for (const result of results) {
        await caller.record(
          input.force === true ? 'provider.apply.force' : 'provider.apply',
          `node:${result.node}`,
          result.outcome,
          result.code,
        )
      }
    }
    return ok(results)
  }

  async probe(
    input: {
      readonly node: string
      readonly mode: 'auth' | 'latency' | 'call'
      readonly candidate: ProviderCandidate
    },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderProbeResult>> {
    const action =
      input.mode === 'call'
        ? 'provider.probe.call'
        : input.mode === 'latency'
          ? 'provider.probe.latency'
          : 'provider.probe.auth'
    return await this.#write(
      'probe',
      input,
      caller,
      action,
      `node:${input.node}`,
      () =>
        ok({
          node: input.node,
          requestId: 'req-probe',
          ok: true,
          reachable: true,
          message: '可用。',
          ...(input.mode === 'latency'
            ? { latency: { medianMs: 312, minMs: 280, samples: 3 } }
            : {}),
        }),
    )
  }

  async autocompact(
    input: { readonly node: string; readonly value?: 'auto' | number },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderAutocompactResult>> {
    if (input.value === undefined) {
      this.calls.push('autocompact.read')
      const denied = this.#deny<ProviderAutocompactResult>(caller)
      if (denied !== null) return denied
      const effective = this.nodes.get(input.node)?.actual?.effective
      return ok({
        node: input.node,
        autoCompactWindow: effective?.autoCompactWindow ?? 0,
        configured: effective?.autoCompactWindow ?? 0,
        source: effective?.autoCompactSource ?? 'auto',
      })
    }
    return await this.#write(
      'autocompact',
      input,
      caller,
      'provider.autocompact',
      `node:${input.node}`,
      () => {
        const node = this.nodes.get(input.node)
        if (node === undefined) return failed('not_found', '没有这个节点')
        if (node.actual?.effective?.autoCompactSource === 'env') {
          return failed('refused', '节点环境变量钉住了阈值', {
            nodeCode: 'env-override',
          })
        }
        const value = input.value === 'auto' ? 200_000 : (input.value as number)
        return ok({
          node: input.node,
          autoCompactWindow: value,
          configured: value,
          source: 'settings',
        })
      },
    )
  }

  importProfiles(
    input: ProviderImportInput,
    caller: ProviderCaller,
  ): Promise<ProviderResult<readonly ProviderProfileView[]>> {
    return this.#write(
      'importProfiles',
      input,
      caller,
      'provider.import',
      'import',
      () => ok([]),
    )
  }

  /** Let a node report something else, the way a fresh `status` would. */
  report(
    name: string,
    effective: Partial<NonNullable<ProviderNodeActual['effective']>>,
  ): void {
    const node = this.nodes.get(name)
    const actual = node?.actual
    if (
      node === undefined ||
      actual === null ||
      actual === undefined ||
      actual.effective === undefined
    ) {
      throw new Error(`no report to change on ${name}`)
    }
    this.nodes.set(name, {
      ...node,
      actual: { ...actual, effective: { ...actual.effective, ...effective } },
    })
  }

  /** Take `effective` away from a node, as an older node reports. */
  silence(name: string): void {
    const node = this.nodes.get(name)
    const actual = node?.actual
    if (node === undefined || actual === null || actual === undefined) {
      throw new Error(`no report on ${name}`)
    }
    const { effective: _gone, ...rest } = actual
    this.nodes.set(name, { ...node, actual: rest })
  }
}
