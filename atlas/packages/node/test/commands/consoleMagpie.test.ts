// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The hub's magpie port (P33/P34) end to end, with nothing mocked: the fake
 * magpie of `@qianmo/magpie/testing` on loopback, the real model service
 * (`openConsoleProviders`) with a real child process playing the node, real
 * files under a temp directory.
 *
 * What it pins:
 *
 * - a gateway key is a profile of preset `magpie`, its value only in the
 *   model service's sealed store and in the node's delivery, never in the
 *   magpie state file, the ledger or an answer;
 * - every key carries an explicit list of API-key upstreams and groups made
 *   only of them (L-6), and is brought back to it after magpie changes;
 * - rotation and removal keep magpie, the profile and the node in step.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MagpieCaller } from '@qianmo/console'
import { FakeMagpie } from '@qianmo/magpie/testing'
import {
  ConsoleMagpie,
  type ConsoleMagpieOptions,
  magpieProfileId,
} from '../../src/commands/consoleMagpie.js'
import {
  type ConsoleProviders,
  openConsoleProviders,
  type ProviderScheduler,
} from '../../src/commands/consoleProviders.js'
import { RUNTIME_CATALOG } from '../../src/host/runtimes/catalog.js'
import { type FakeNode, fakeNode } from './consoleProvidersFakeNode.js'

const OPS = 'u:0123456789abcdef'
const WEB_KEY = 'magpie-web-key-for-tests-0001'
const STILL: ProviderScheduler = { set: () => null, clear: () => {} }

let root: string
let fake: FakeMagpie
let node: FakeNode
let providers: ConsoleProviders
let ledger: string[]
let errors: string[]
let paths: { state: string; secrets: string; key: string }

function caller(overrides: Partial<MagpieCaller> = {}): MagpieCaller {
  return {
    subject: OPS,
    role: 'ops',
    requestId: 'req-1',
    breakGlass: false,
    async record(action, target, outcome, code) {
      ledger.push(`${action} ${target} ${outcome}${code ? ` ${code}` : ''}`)
      return true
    },
    ...overrides,
  }
}

function port(tenants: readonly string[] = []): ConsoleMagpie {
  return new ConsoleMagpie({
    statePath: paths.state,
    secretsPath: paths.secrets,
    keyPath: paths.key,
    providers,
    tenants: () => tenants,
    onError: line => errors.push(line),
  })
}

/**
 * A port whose `fetch` drops the answer to the first request for `path`
 * after magpie has done it: what a timeout or a cut connection looks like.
 */
function droppingPort(
  path: string,
  extra: Partial<ConsoleMagpieOptions> = {},
  /** Instead of dropping the answer, run this once magpie has answered. */
  meanwhile?: () => Promise<void>,
): {
  readonly magpie: ConsoleMagpie
  arm(): void
} {
  let armed = false
  const magpie = new ConsoleMagpie({
    statePath: paths.state,
    secretsPath: paths.secrets,
    keyPath: paths.key,
    providers,
    tenants: () => [],
    onError: line => errors.push(line),
    ...extra,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetch(input, init)
      if (armed && String(input).endsWith(path)) {
        armed = false
        if (meanwhile === undefined) throw new TypeError('connection reset')
        await meanwhile()
      }
      return response
    }) as typeof fetch,
  })
  return {
    magpie,
    arm: () => {
      armed = true
    },
  }
}

async function connected(
  tenants: readonly string[] = [],
): Promise<ConsoleMagpie> {
  const magpie = port(tenants)
  const result = await magpie.connect(
    {
      gatewayUrl: fake.gatewayUrl,
      managementUrl: fake.managementUrl,
      managementKey: WEB_KEY,
    },
    caller(),
  )
  if (!result.ok) throw new Error(result.failure.message)
  return magpie
}

const LUNA_KEY = 'sk-luna-upstream-0001-abcdef'

/** Another profile, made the default: what a node falls back to. */
async function otherDefault(): Promise<void> {
  const pcaller = {
    subject: OPS,
    role: 'ops' as const,
    breakGlass: false,
    record: async () => true,
  }
  const saved = await providers.saveProfile(
    {
      profile: {
        id: 'luna',
        name: 'Luna',
        presetId: null,
        plan: 'custom',
        site: null,
        lane: 'openai-responses',
        baseUrl: 'https://gateway.vendor.example/v1',
        auth: { scheme: 'bearer' },
        keys: [{ id: 'k1' }],
        models: [
          {
            id: 'gpt-6-luna',
            role: 'main',
            tiers: ['opus', 'sonnet', 'haiku', 'fable'],
            capabilities: { mode: 'family' },
            effort: { send: 'auto' },
          },
        ],
        evaluated: false,
      },
      ifMatch: null,
      secrets: { k1: LUNA_KEY },
    },
    pcaller,
  )
  if (!saved.ok) throw new Error(saved.failure.message)
  const set = await providers.setDefault({ profileId: 'luna' }, pcaller)
  if (!set.ok) throw new Error(set.failure.message)
}

function applies(): Record<string, unknown>[] {
  return node
    .requests()
    .filter(request => request['op'] === 'apply' && request['dryRun'] !== true)
}

function deliveredKey(request: Record<string, unknown> | undefined): unknown {
  const profile = request?.['profile'] as
    | { auth: { keys: { id: string; value?: string }[] } }
    | undefined
  return profile?.auth.keys[0]?.value
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-magpie-port-'))
  ledger = []
  errors = []
  fake = await FakeMagpie.start({
    webKey: WEB_KEY,
    providers: [
      {
        id: 'openai',
        models: ['gpt-6', 'gpt-6-mini'],
        key: 'sk-upstream-openai-0001',
      },
      { id: 'openrouter', models: ['anthropic/claude-sonnet-5'] },
      {
        id: 'codex',
        models: ['gpt-6-codex'],
        account: { agent: 'codex', user: 'a@example.test', plan: 'pro' },
      },
      {
        id: 'zen',
        preset: 'opencode',
        models: ['big-pickle'],
        ownClient: true,
      },
    ],
    groups: [
      {
        id: 'fast',
        members: ['openai/gpt-6-mini', 'openrouter/anthropic/claude-sonnet-5'],
      },
      { id: 'mixed', members: ['openai/gpt-6', 'codex/gpt-6-codex'] },
    ],
  })
  node = fakeNode(join(root, 'node-1'))
  providers = openConsoleProviders({
    storePath: join(root, 'config', 'providers.ndjson'),
    secretsPath: join(root, 'config', 'provider-secrets.json'),
    keyPath: join(root, 'keys', 'provider-master.key'),
    knownHostsFile: join(root, 'known_hosts'),
    nodes: [{ node: 'beta-1', kind: 'local', command: node.command }],
    scheduler: STILL,
  })
  paths = {
    state: join(root, 'config', 'magpie.json'),
    secrets: join(root, 'config', 'magpie-secrets.json'),
    key: join(root, 'keys', 'magpie-master.key'),
  }
})

afterEach(async () => {
  await fake.stop()
  rmSync(root, { recursive: true, force: true })
})

describe('connection', () => {
  test('a wrong management key or a plain-http remote origin is refused before anything is kept', async () => {
    const magpie = port()
    const wrong = await magpie.connect(
      {
        gatewayUrl: fake.gatewayUrl,
        managementUrl: fake.managementUrl,
        managementKey: 'nope-nope-nope',
      },
      caller(),
    )
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.failure.code).toBe('refused')
    const plain = await magpie.connect(
      {
        gatewayUrl: 'http://gw.example.test',
        managementUrl: fake.managementUrl,
        managementKey: WEB_KEY,
      },
      caller(),
    )
    expect(plain.ok).toBe(false)
    if (!plain.ok) expect(plain.failure.code).toBe('invalid')
    expect(() => statSync(paths.state)).toThrow()
  })

  test('connecting seals the management key apart from the state, and a reconnect reuses it', async () => {
    const magpie = await connected()
    const snapshot = await magpie.snapshot()
    if (!snapshot.ok) throw new Error('snapshot')
    expect(snapshot.value.connection).toMatchObject({
      configured: true,
      gatewayUrl: fake.gatewayUrl,
      keySet: true,
      check: { ok: true, version: '0.1.1268-fake', gateway: 'keyed' },
    })
    expect(readFileSync(paths.state, 'utf8')).not.toContain(WEB_KEY)
    expect(readFileSync(paths.secrets, 'utf8')).not.toContain(WEB_KEY)
    expect(statSync(paths.state).mode & 0o777).toBe(0o600)
    expect(statSync(paths.secrets).mode & 0o777).toBe(0o600)
    const again = await port().connect(
      { gatewayUrl: fake.gatewayUrl, managementUrl: fake.managementUrl },
      caller(),
    )
    expect(again.ok).toBe(true)
  })

  test('an open gateway is reported as open', async () => {
    fake.gatewayOpen = true
    const magpie = await connected()
    const snapshot = await magpie.snapshot()
    if (!snapshot.ok) throw new Error('snapshot')
    expect(snapshot.value.connection.check?.gateway).toBe('open')
  })

  test('only a personal ops account outside break-glass writes', async () => {
    const magpie = port()
    for (const who of [
      caller({ role: 'viewer' }),
      caller({ role: 'member' }),
      caller({ breakGlass: true }),
      caller({ subject: 'legacy:admin', role: null }),
    ]) {
      const result = await magpie.connect(
        {
          gatewayUrl: fake.gatewayUrl,
          managementUrl: fake.managementUrl,
          managementKey: WEB_KEY,
        },
        who,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.failure.code).toBe('rejected')
    }
    expect(fake.requests).toEqual([])
  })

  test('a state file that does not parse closes the port and is never overwritten', async () => {
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(paths.state, '{ not json', { mode: 0o600 })
    const magpie = port()
    expect(magpie.problem).toContain('无法解析')
    const result = await magpie.connect(
      {
        gatewayUrl: fake.gatewayUrl,
        managementUrl: fake.managementUrl,
        managementKey: WEB_KEY,
      },
      caller(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('unsupported')
    expect(readFileSync(paths.state, 'utf8')).toBe('{ not json')
  })
})

describe('the snapshot', () => {
  test('lists upstreams by access class and offers only eligible models', async () => {
    const magpie = await connected()
    const snapshot = await magpie.snapshot()
    if (!snapshot.ok) throw new Error('snapshot')
    const value = snapshot.value
    expect(value.providers.map(one => `${one.id} ${one.access}`)).toEqual([
      'openai key',
      'openrouter key',
      'codex account',
      'zen client',
    ])
    expect(value.groups.map(one => `${one.id} ${one.eligible}`)).toEqual([
      'fast true',
      'mixed false',
    ])
    expect(value.models).toEqual([
      'openai/gpt-6',
      'openai/gpt-6-mini',
      'openrouter/anthropic/claude-sonnet-5',
      'group/fast',
    ])
    expect(value.nodes).toEqual(['beta-1'])
    expect(value.presets.map(one => one.id)).not.toContain('opencode')
  })

  test('magpie down: the connection and bindings still show, with the reason', async () => {
    const magpie = await connected()
    fake.fault({ target: 'management', status: 500, body: 'down' })
    const snapshot = await magpie.snapshot()
    if (!snapshot.ok) throw new Error('snapshot')
    expect(snapshot.value.problem?.code).toBe('magpie_bad_response')
    expect(snapshot.value.connection.configured).toBe(true)
    expect(snapshot.value.providers).toEqual([])
  })
})

describe('a gateway key for a node', () => {
  test('is a magpie profile whose value only the model service and the node hold', async () => {
    const magpie = await connected()
    const issued = await magpie.issueKey(
      {
        binding: { kind: 'node', id: 'beta-1' },
        mainModel: 'openrouter/anthropic/claude-sonnet-5',
        fastModel: 'group/fast',
        limits: [{ period: 'day', tokens: 100_000 }],
      },
      caller(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    const view = issued.value
    expect(view.profileId).toBe('magpie-node-beta-1')
    expect(view.modelsMode).toBe('all')
    expect(view.models).toEqual(['openai/*', 'openrouter/*', 'group/fast'])
    expect(view.limits.map(limit => [limit.period, limit.tokens])).toEqual([
      ['day', 100_000],
    ])

    const key = fake.key(view.keyId)
    expect(key?.name.startsWith('qm-node-beta-1-')).toBe(true)
    expect(key?.secret.startsWith('qm-gw-')).toBe(true)
    expect(key?.secret.startsWith('sk-magpie-')).toBe(false)
    expect(key?.models).toEqual(['openai/*', 'openrouter/*', 'group/fast'])
    expect(key?.limits.map(limit => limit.period)).toEqual(['day'])
    const secret = key?.secret ?? ''

    const profile = await providers.profile('magpie-node-beta-1')
    if (!profile.ok) throw new Error('profile')
    expect(profile.value).toMatchObject({
      presetId: 'magpie',
      lane: 'anthropic',
      baseUrl: fake.gatewayUrl,
      auth: { scheme: 'bearer' },
      evaluated: false,
    })
    expect(
      profile.value.models.map(model => `${model.id} ${model.role}`),
    ).toEqual(['openrouter/anthropic/claude-sonnet-5 main', 'group/fast fast'])
    expect(profile.value.keys[0]?.fingerprint).toBeDefined()

    const overview = await providers.overview()
    if (!overview.ok) throw new Error('overview')
    expect(overview.value.nodes[0]?.assignment).toEqual({
      mode: 'profile',
      profileId: 'magpie-node-beta-1',
    })
    expect(deliveredKey(applies().at(-1))).toBe(secret)

    for (const text of [
      readFileSync(paths.state, 'utf8'),
      JSON.stringify(view),
      ledger.join('\n'),
      readFileSync(join(root, 'config', 'provider-secrets.json'), 'utf8'),
    ]) {
      expect(text).not.toContain(secret)
    }
    expect(ledger).toEqual([
      'provider.save magpie-node-beta-1 ok',
      'provider.secret.set magpie-node-beta-1 ok',
      'provider.assign beta-1 ok',
      'provider.apply beta-1 ok',
    ])
  })

  test('openai lanes point the profile at the gateway with /v1', async () => {
    const magpie = await connected()
    const issued = await magpie.issueKey(
      {
        binding: { kind: 'node', id: 'beta-1' },
        mainModel: 'openai/gpt-6',
        lane: 'openai-chat',
      },
      caller(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    const profile = await providers.profile('magpie-node-beta-1')
    if (!profile.ok) throw new Error('profile')
    expect(profile.value.baseUrl).toBe(`${fake.gatewayUrl}/v1`)
    expect(profile.value.laneAddresses).toEqual({
      anthropic: fake.gatewayUrl,
      'openai-responses': `${fake.gatewayUrl}/v1`,
      // Gemini's lane once the runtime catalog has a runtime on it (P36.5).
      ...(RUNTIME_CATALOG.some(spec => spec.lanes.includes('gemini'))
        ? { gemini: `${fake.gatewayUrl}/v1beta` }
        : {}),
    })
    expect(profile.value.models[0]?.tiers).toEqual([
      'opus',
      'sonnet',
      'haiku',
      'fable',
    ])
  })

  test('never reaches a subscription or a borrowed client identity (L-6)', async () => {
    const magpie = await connected()
    const cases = [
      [{ mainModel: 'codex/gpt-6-codex' }, 'rejected'],
      [{ mainModel: 'group/mixed' }, 'rejected'],
      [{ mainModel: 'zen/big-pickle' }, 'rejected'],
      [
        { mainModel: 'openai/gpt-6', models: ['openai/*', 'codex/*'] },
        'rejected',
      ],
      [{ mainModel: 'openai/gpt-6', models: ['*/gpt-6'] }, 'rejected'],
      [{ mainModel: 'openai/gpt-6', models: ['openrouter/*'] }, 'invalid'],
      [{ mainModel: 'openai/not-served' }, 'rejected'],
    ] as const
    for (const [draft, code] of cases) {
      const result = await magpie.issueKey(
        { binding: { kind: 'node', id: 'beta-1' }, ...draft },
        caller(),
      )
      expect(
        `${JSON.stringify(draft)} ${result.ok ? 'ok' : result.failure.code}`,
      ).toBe(`${JSON.stringify(draft)} ${code}`)
    }
    expect(fake.keys()).toEqual([])
    expect(applies()).toEqual([])
  })

  test('an unknown node or a second key for the same node is refused', async () => {
    const magpie = await connected()
    const nowhere = await magpie.issueKey(
      { binding: { kind: 'node', id: 'nowhere' }, mainModel: 'openai/gpt-6' },
      caller(),
    )
    expect(nowhere.ok ? 'ok' : nowhere.failure.code).toBe('not_found')
    const first = await magpie.issueKey(
      { binding: { kind: 'node', id: 'beta-1' }, mainModel: 'openai/gpt-6' },
      caller(),
    )
    expect(first.ok).toBe(true)
    const second = await magpie.issueKey(
      { binding: { kind: 'node', id: 'beta-1' }, mainModel: 'openai/gpt-6' },
      caller(),
    )
    expect(second.ok ? 'ok' : second.failure.code).toBe('invalid')
    expect(fake.keys()).toHaveLength(1)
  })

  test('a failure after the key exists takes the key back out of magpie', async () => {
    const magpie = await connected()
    fake.fault({
      target: 'management',
      path: '/api/caller-keys/models-key',
      status: 400,
      body: '{"error":"nope"}',
    })
    const result = await magpie.issueKey(
      { binding: { kind: 'node', id: 'beta-1' }, mainModel: 'openai/gpt-6' },
      caller(),
    )
    expect(result.ok).toBe(false)
    expect(fake.keys()).toEqual([])
    const profile = await providers.profile('magpie-node-beta-1')
    expect(profile.ok).toBe(false)
  })

  test('a key magpie made although add-key was not answered is taken back out', async () => {
    const { magpie, arm } = droppingPort('/api/caller-keys/add-key')
    const linked = await magpie.connect(
      {
        gatewayUrl: fake.gatewayUrl,
        managementUrl: fake.managementUrl,
        managementKey: WEB_KEY,
      },
      caller(),
    )
    expect(linked.ok).toBe(true)
    arm()
    const result = await magpie.issueKey(
      { binding: { kind: 'node', id: 'beta-1' }, mainModel: 'openai/gpt-6' },
      caller(),
    )
    expect(result.ok).toBe(false)
    // Not left enabled and open to every model.
    expect(fake.keys()).toEqual([])
    expect((await providers.profile('magpie-node-beta-1')).ok).toBe(false)
  })

  test('magpie changes are brought back within the eligible set by a check', async () => {
    const magpie = await connected()
    const issued = await magpie.issueKey(
      { binding: { kind: 'node', id: 'beta-1' }, mainModel: 'openai/gpt-6' },
      caller(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    fake.addProvider({ id: 'deepseek', models: ['deepseek-v4'] })
    fake.setGroup({
      id: 'fast',
      members: ['openai/gpt-6-mini', 'codex/gpt-6-codex'],
    })
    const checked = await magpie.check(caller())
    expect(checked.ok).toBe(true)
    expect(fake.key(issued.value.keyId)?.models).toEqual([
      'openai/*',
      'openrouter/*',
      'deepseek/*',
    ])
  })

  test('one key magpie will not change does not stop the check from fixing the others', async () => {
    const magpie = await connected(['t-1'])
    const first = await magpie.issueKey(
      { binding: { kind: 'node', id: 'beta-1' }, mainModel: 'openai/gpt-6' },
      caller(),
    )
    const second = await magpie.issueKey(
      { binding: { kind: 'tenant', id: 't-1' }, mainModel: 'openai/gpt-6' },
      caller(),
    )
    if (!first.ok || !second.ok) throw new Error('issue')
    fake.addProvider({ id: 'deepseek', models: ['deepseek-v4'] })
    fake.fault({
      target: 'management',
      path: '/api/caller-keys/models-key',
      times: 1,
      status: 500,
      body: 'down',
    })
    const checked = await magpie.check(caller())
    // Said, and the rest still done.
    expect(checked.ok).toBe(false)
    expect(fake.key(first.value.keyId)?.models).not.toContain('deepseek/*')
    expect(fake.key(second.value.keyId)?.models).toContain('deepseek/*')
  })

  test('a list-mode key keeps its list, minus what stops being eligible', async () => {
    const magpie = await connected()
    const issued = await magpie.issueKey(
      {
        binding: { kind: 'node', id: 'beta-1' },
        mainModel: 'openai/gpt-6',
        models: ['openai/*', 'group/fast'],
      },
      caller(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    expect(fake.key(issued.value.keyId)?.models).toEqual([
      'openai/*',
      'group/fast',
    ])
    fake.setGroup({ id: 'fast', members: ['codex/gpt-6-codex'] })
    await magpie.check(caller())
    expect(fake.key(issued.value.keyId)?.models).toEqual(['openai/*'])
  })

  test('changes: off, limits, back to all, a new main model delivered', async () => {
    const magpie = await connected()
    const binding = { kind: 'node' as const, id: 'beta-1' }
    const issued = await magpie.issueKey(
      { binding, mainModel: 'openai/gpt-6', models: ['openai/*'] },
      caller(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    const keyId = issued.value.keyId
    const off = await magpie.updateKey(binding, { enabled: false }, caller())
    expect(off.ok && off.value.enabled).toBe(false)
    expect(fake.key(keyId)?.off).toBe(true)
    const limited = await magpie.updateKey(
      binding,
      { limits: [{ period: 'week', cost: 5 }] },
      caller(),
    )
    expect(limited.ok && limited.value.limits.map(limit => limit.cost)).toEqual(
      [5],
    )
    const all = await magpie.updateKey(binding, { models: null }, caller())
    expect(all.ok && all.value.modelsMode).toBe('all')
    expect(fake.key(keyId)?.models).toEqual([
      'openai/*',
      'openrouter/*',
      'group/fast',
    ])
    const before = applies().length
    const moved = await magpie.updateKey(
      binding,
      { mainModel: 'openrouter/anthropic/claude-sonnet-5' },
      caller(),
    )
    expect(moved.ok).toBe(true)
    expect(applies().length).toBe(before + 1)
    const profile = await providers.profile('magpie-node-beta-1')
    if (!profile.ok) throw new Error('profile')
    expect(profile.value.models[0]?.id).toBe(
      'openrouter/anthropic/claude-sonnet-5',
    )
    const refused = await magpie.updateKey(
      binding,
      { mainModel: 'codex/gpt-6-codex' },
      caller(),
    )
    expect(refused.ok ? 'ok' : refused.failure.code).toBe('rejected')
  })

  test('rotation: magpie makes the value, the profile takes it, the node gets it', async () => {
    const magpie = await connected()
    const binding = { kind: 'node' as const, id: 'beta-1' }
    const issued = await magpie.issueKey(
      { binding, mainModel: 'openai/gpt-6' },
      caller(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    const old = fake.key(issued.value.keyId)?.secret
    const before = await providers.profile('magpie-node-beta-1')
    const rotated = await magpie.rotateKey(binding, caller())
    expect(rotated.ok).toBe(true)
    const secret = fake.key(issued.value.keyId)?.secret ?? ''
    expect(secret).not.toBe(old)
    expect(secret.startsWith('sk-magpie-key-')).toBe(true)
    expect(deliveredKey(applies().at(-1))).toBe(secret)
    const after = await providers.profile('magpie-node-beta-1')
    if (!before.ok || !after.ok) throw new Error('profile')
    expect(after.value.keys[0]?.fingerprint).not.toBe(
      before.value.keys[0]?.fingerprint,
    )
    expect(JSON.stringify(rotated)).not.toContain(secret)
  })

  test('rotation takes the profile’s revision after magpie has answered, not before', async () => {
    const pcaller = {
      subject: OPS,
      role: 'ops' as const,
      breakGlass: false,
      record: async () => true,
    }
    // Somebody saves the gateway profile while magpie is rotating the key.
    const { magpie, arm } = droppingPort(
      '/api/caller-keys/rotate-key',
      {},
      async () => {
        const current = await providers.profile('magpie-node-beta-1')
        if (!current.ok) throw new Error('profile')
        const saved = await providers.saveProfile(
          {
            profile: { ...current.value, name: 'renamed meanwhile' },
            ifMatch: current.value.revision,
          },
          pcaller,
        )
        if (!saved.ok) throw new Error(saved.failure.message)
      },
    )
    const linked = await magpie.connect(
      {
        gatewayUrl: fake.gatewayUrl,
        managementUrl: fake.managementUrl,
        managementKey: WEB_KEY,
      },
      caller(),
    )
    expect(linked.ok).toBe(true)
    const binding = { kind: 'node' as const, id: 'beta-1' }
    const issued = await magpie.issueKey(
      { binding, mainModel: 'openai/gpt-6' },
      caller(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    arm()
    const rotated = await magpie.rotateKey(binding, caller())
    expect(rotated.ok).toBe(true)
    const secret = fake.key(issued.value.keyId)?.secret
    expect(deliveredKey(applies().at(-1))).toBe(secret)
  })

  test('removal is refused while the node has nothing else to run on', async () => {
    const magpie = await connected()
    const binding = { kind: 'node' as const, id: 'beta-1' }
    const issued = await magpie.issueKey(
      { binding, mainModel: 'openai/gpt-6' },
      caller(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    const refused = await magpie.removeKey(binding, caller())
    expect(refused.ok ? 'ok' : refused.failure.code).toBe('invalid')
    expect(fake.keys()).toHaveLength(1)
    expect((await providers.profile('magpie-node-beta-1')).ok).toBe(true)
  })

  test('removal gives the node the default back, then removes the key and the profile', async () => {
    await otherDefault()
    const magpie = await connected()
    const binding = { kind: 'node' as const, id: 'beta-1' }
    const issued = await magpie.issueKey(
      { binding, mainModel: 'openai/gpt-6' },
      caller(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    const removed = await magpie.removeKey(binding, caller())
    expect(removed).toEqual({ ok: true, value: { profileKept: false } })
    expect(fake.keys()).toEqual([])
    const overview = await providers.overview()
    if (!overview.ok) throw new Error('overview')
    expect(overview.value.nodes[0]?.assignment).toEqual({ mode: 'inherit' })
    expect(overview.value.nodes[0]?.expected?.profileId).toBe('luna')
    expect(deliveredKey(applies().at(-1))).toBe(LUNA_KEY)
    expect((await providers.profile('magpie-node-beta-1')).ok).toBe(false)
    const snapshot = await magpie.snapshot()
    expect(snapshot.ok && snapshot.value.keys).toEqual([])
  })

  test('an upstream or group a key points at cannot be removed out from under it', async () => {
    const magpie = await connected()
    const issued = await magpie.issueKey(
      {
        binding: { kind: 'node', id: 'beta-1' },
        mainModel: 'openai/gpt-6',
        fastModel: 'group/fast',
      },
      caller(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    const provider = await magpie.removeProvider('openai', caller())
    expect(provider.ok ? 'ok' : provider.failure.code).toBe('invalid')
    const group = await magpie.removeGroup('fast', caller())
    expect(group.ok ? 'ok' : group.failure.code).toBe('invalid')
    expect(fake.provider('openai')).toBeDefined()
    expect(fake.group('fast')).toBeDefined()
  })

  test('a new gateway address is written into every bound profile and delivered', async () => {
    const magpie = await connected()
    const issued = await magpie.issueKey(
      { binding: { kind: 'node', id: 'beta-1' }, mainModel: 'openai/gpt-6' },
      caller(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    const before = applies().length
    const moved = await magpie.connect(
      {
        gatewayUrl: 'https://gw2.example.test',
        managementUrl: fake.managementUrl,
      },
      caller(),
    )
    expect(moved.ok && moved.value.check?.gateway).toBe('unreachable')
    const profile = await providers.profile('magpie-node-beta-1')
    if (!profile.ok) throw new Error('profile')
    expect(profile.value.baseUrl).toBe('https://gw2.example.test')
    expect(applies().length).toBe(before + 1)
  })

  test('a delivery the node does not take is said to the caller and to the log, not passed off as done', async () => {
    await otherDefault()
    const magpie = await connected()
    const binding = { kind: 'node' as const, id: 'beta-1' }
    const refuse = () =>
      node.set(
        'reply-apply.json',
        JSON.stringify({
          v: 1,
          requestId: 'x',
          ok: false,
          code: 'write-failed',
          message: 'disk full',
        }),
      )
    const take = () => rmSync(join(node.dir, 'reply-apply.json'))
    const unsaid = (result: {
      ok: boolean
      failure?: { code: string; message: string }
    }) => {
      expect(result.ok).toBe(false)
      expect(result.failure?.code).toBe('unreachable')
      expect(result.failure?.message).toContain('beta-1')
      expect(errors.some(line => line.includes('beta-1'))).toBe(true)
      errors.length = 0
    }
    // Issue: the key and the profile exist; the node did not get them.
    refuse()
    const issued = await magpie.issueKey(
      { binding, mainModel: 'openai/gpt-6' },
      caller(),
    )
    unsaid(issued as never)
    const snapshot = await magpie.snapshot()
    expect(
      snapshot.ok && snapshot.value.keys.map(key => key.binding.id),
    ).toEqual(['beta-1'])
    const keyId = snapshot.ok ? snapshot.value.keys[0]?.keyId : undefined
    // A new main model.
    unsaid(
      (await magpie.updateKey(
        binding,
        { mainModel: 'openai/gpt-6-mini' },
        caller(),
      )) as never,
    )
    // Rotation: magpie has the new value, the node still the dead one.
    const before = fake.key(keyId ?? '')?.secret
    unsaid((await magpie.rotateKey(binding, caller())) as never)
    expect(fake.key(keyId ?? '')?.secret).not.toBe(before)
    // A new gateway address: saved, not delivered.
    unsaid(
      (await magpie.connect(
        {
          gatewayUrl: 'https://gw2.example.test',
          managementUrl: fake.managementUrl,
        },
        caller(),
      )) as never,
    )
    const profile = await providers.profile('magpie-node-beta-1')
    expect(profile.ok && profile.value.baseUrl).toBe('https://gw2.example.test')
    // Removal: the node did not get its old profile back, so the key stays.
    unsaid((await magpie.removeKey(binding, caller())) as never)
    expect(fake.keys()).toHaveLength(1)
    // Asked again, it goes ahead: the node was already moved back.
    const again = await magpie.removeKey(binding, caller())
    expect(again.ok).toBe(true)
    expect(fake.keys()).toEqual([])
    take()
  })

  test('a node whose capabilities cannot be told refuses the lanes: issuing says so', async () => {
    node.set(
      'reply-status.json',
      JSON.stringify({ v: 1, requestId: 'x', ok: true, state: { odd: true } }),
    )
    const magpie = await connected()
    const issued = await magpie.issueKey(
      { binding: { kind: 'node', id: 'beta-1' }, mainModel: 'openai/gpt-6' },
      caller(),
    )
    expect(issued.ok).toBe(false)
    if (!issued.ok) {
      expect(issued.failure.message).toContain('capabilities-unknown')
      expect(issued.failure.message).toContain('下发到 beta-1 未完成')
    }
    expect(errors.some(line => line.includes('capabilities-unknown'))).toBe(
      true,
    )
    expect(errors.some(line => line.includes('下发到 beta-1 未完成'))).toBe(
      true,
    )
    expect(applies()).toEqual([])
  })

  test('usage names the binding behind each key of ours', async () => {
    const magpie = await connected()
    const issued = await magpie.issueKey(
      { binding: { kind: 'node', id: 'beta-1' }, mainModel: 'openai/gpt-6' },
      caller(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    fake.setUsage('today', {
      calls: 2,
      keys: [
        { keyId: issued.value.keyId, calls: 2, cost: 0.01 },
        { keyId: 'other', calls: 1 },
      ],
    })
    const usage = await magpie.usage('today')
    if (!usage.ok) throw new Error('usage')
    expect(usage.value.keys.map(row => row.binding)).toEqual([
      { kind: 'node', id: 'beta-1' },
      null,
    ])
  })
})

describe('a gateway key for a tenant (P35)', () => {
  test('is a profile with no assignment, for a known tenant only', async () => {
    const magpie = await connected(['acme'])
    const unknown = await magpie.issueKey(
      { binding: { kind: 'tenant', id: 'other' }, mainModel: 'openai/gpt-6' },
      caller(),
    )
    expect(unknown.ok ? 'ok' : unknown.failure.code).toBe('not_found')
    const issued = await magpie.issueKey(
      { binding: { kind: 'tenant', id: 'acme' }, mainModel: 'openai/gpt-6' },
      caller(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    expect(issued.value.profileId).toBe('magpie-tenant-acme')
    expect((await providers.profile('magpie-tenant-acme')).ok).toBe(true)
    expect(applies()).toEqual([])
    const off = await magpie.updateKey(
      { kind: 'tenant', id: 'acme' },
      { enabled: false },
      caller(),
    )
    expect(off.ok && off.value.enabled).toBe(false)
  })
})

describe('a subscriber’s upstream (P35)', () => {
  test('one magpie made although the save was not answered is recorded, not reported as failed', async () => {
    const { magpie, arm } = droppingPort('/api/provider/save', {
      tenants: () => ['t-1'],
      subscriptions: { caller: providers.systemCaller(async () => true) },
    })
    const linked = await magpie.connect(
      {
        gatewayUrl: fake.gatewayUrl,
        managementUrl: fake.managementUrl,
        managementKey: WEB_KEY,
      },
      caller(),
    )
    expect(linked.ok).toBe(true)
    expect((await magpie.ensureTenant('t-1', [])).ok).toBe(true)
    expect((await magpie.setTenantEntitled('t-1', true)).ok).toBe(true)
    arm()
    const added = await magpie.addTenantUpstream('t-1', {
      preset: 'openai',
      key: 'sk-t1-own-0001',
    })
    if (!added.ok) throw new Error(added.failure.message)
    const view = await magpie.tenantView('t-1')
    expect(view.ok && view.value.upstreams.map(one => one.id)).toEqual([
      added.value.id,
    ])
    const key = fake.keys().find(one => one.name.startsWith('qm-tenant-t-1-'))
    expect(key?.models).toEqual([`${added.value.id}/*`])
    expect(key?.off).toBe(false)
    expect(
      fake.requests.filter(request => request.path === '/api/provider/save'),
    ).toHaveLength(1)
  })
})

describe('upstreams and groups', () => {
  test('only API-key presets are added, and new upstreams join every all-mode key', async () => {
    const magpie = await connected()
    const issued = await magpie.issueKey(
      { binding: { kind: 'node', id: 'beta-1' }, mainModel: 'openai/gpt-6' },
      caller(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    const own = await magpie.saveProvider({ preset: 'opencode' }, caller())
    expect(own.ok ? 'ok' : own.failure.code).toBe('rejected')
    const added = await magpie.saveProvider(
      { preset: 'anthropic', key: 'sk-ant-upstream-0001' },
      caller(),
    )
    if (!added.ok) throw new Error(added.failure.message)
    expect(added.value.id).toBe('anthropic')
    expect(fake.key(issued.value.keyId)?.models).toContain('anthropic/*')
    expect(JSON.stringify(added)).not.toContain('sk-ant-upstream-0001')
  })

  test('a custom upstream is added by its URLs and joins every all-mode key', async () => {
    const magpie = await connected()
    const issued = await magpie.issueKey(
      { binding: { kind: 'node', id: 'beta-1' }, mainModel: 'openai/gpt-6' },
      caller(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    const both = await magpie.saveProvider(
      { preset: 'openai', chat: 'https://api.example.cn/v1' },
      caller(),
    )
    expect(both.ok ? 'ok' : both.failure.code).toBe('invalid')
    const neither = await magpie.saveProvider({ preset: '' }, caller())
    expect(neither.ok ? 'ok' : neither.failure.code).toBe('invalid')
    const added = await magpie.saveProvider(
      {
        preset: '',
        name: 'api2',
        key: 'sk-custom-upstream-0001',
        chat: 'https://api.example.cn/v1',
        responses: 'https://api.example.cn/v1',
      },
      caller(),
    )
    if (!added.ok) throw new Error(added.failure.message)
    expect(added.value).toMatchObject({
      id: 'api2',
      preset: '',
      host: 'api.example.cn',
      access: 'key',
    })
    expect(fake.key(issued.value.keyId)?.models).toContain('api2/*')
    expect(JSON.stringify(added)).not.toContain('sk-custom-upstream-0001')
  })

  test('a provider test does not hold up the writes behind it', async () => {
    const magpie = await connected()
    fake.fault({
      target: 'management',
      path: '/api/provider/test',
      times: 1,
      delayMs: 1_500,
    })
    const order: string[] = []
    const testing = magpie
      .testProvider('openai', caller())
      .then(result => order.push(`test ${result.ok}`))
    await Bun.sleep(100)
    const write = magpie
      .setProviderEnabled('openai', false, caller())
      .then(result => order.push(`write ${result.ok}`))
    await Promise.all([testing, write])
    expect(order).toEqual(['write true', 'test true'])
  })

  test('a subscription upstream is read-only here', async () => {
    const magpie = await connected()
    for (const result of [
      await magpie.setProviderEnabled('codex', false, caller()),
      await magpie.testProvider('codex', caller()),
      await magpie.removeProvider('codex', caller()),
    ]) {
      expect(result.ok ? 'ok' : result.failure.code).toBe('rejected')
    }
    expect(fake.provider('codex')?.off).toBe(false)
  })

  test('a group made through the console holds API-key upstreams only', async () => {
    const magpie = await connected()
    const mixed = await magpie.saveGroup(
      { id: 'mine', members: ['openai/gpt-6', 'codex/gpt-6-codex'] },
      caller(),
    )
    expect(mixed.ok ? 'ok' : mixed.failure.code).toBe('rejected')
    const saved = await magpie.saveGroup(
      { id: 'mine', members: ['openai/gpt-6'], routing: 'order' },
      caller(),
    )
    if (!saved.ok) throw new Error(saved.failure.message)
    expect(saved.value).toMatchObject({
      id: 'mine',
      routing: 'order',
      eligible: true,
    })
  })
})

describe('profile ids', () => {
  test('fit the profile grammar for any node or tenant id', () => {
    expect(magpieProfileId({ kind: 'node', id: 'beta-1' })).toBe(
      'magpie-node-beta-1',
    )
    for (const id of ['tokyo_1', 'Acme.Corp', 'x'.repeat(100)]) {
      const made = magpieProfileId({ kind: 'tenant', id })
      expect(made).toMatch(/^[a-z0-9-]{1,48}$/)
    }
    expect(magpieProfileId({ kind: 'node', id: 'tokyo_1' })).not.toBe(
      magpieProfileId({ kind: 'node', id: 'tokyo-1' }),
    )
  })
})
