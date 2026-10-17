// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { checkOrigin, MagpieClient, MagpieError } from '../src/index.js'
import { FakeMagpie } from '../src/testing.js'

const OWN_SECRET = 'qm-gw-0123456789abcdefghijklmnopqrstuvwxyz'

let fake: FakeMagpie
let client: MagpieClient

function clientFor(
  options: Partial<ConstructorParameters<typeof MagpieClient>[0]> = {},
): MagpieClient {
  return new MagpieClient({
    managementUrl: fake.managementUrl,
    gatewayUrl: fake.gatewayUrl,
    webKey: fake.webKey,
    ...options,
  })
}

async function failure(run: () => Promise<unknown>): Promise<MagpieError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof MagpieError) return error
    throw error
  }
  throw new Error('expected a MagpieError')
}

beforeEach(async () => {
  fake = await FakeMagpie.start({
    providers: [
      {
        id: 'openai',
        preset: 'openai',
        models: ['gpt-6', 'gpt-6-mini'],
        key: 'sk-upstream-openai-0001',
      },
      {
        id: 'openrouter',
        preset: 'openrouter',
        models: ['anthropic/claude-sonnet-5'],
      },
      {
        id: 'codex',
        preset: 'codex',
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
        members: ['openai/gpt-6-mini'],
        routing: 'order',
        extra: { weights: { 'openai/gpt-6-mini': 2 } },
      },
      { id: 'mixed', members: ['openai/gpt-6', 'codex/gpt-6-codex'] },
    ],
  })
  client = clientFor()
})

afterEach(async () => {
  await fake.stop()
})

describe('checkOrigin', () => {
  test('takes https origins and loopback http', () => {
    expect(checkOrigin('https://gw.example.test')).toBe(
      'https://gw.example.test',
    )
    expect(checkOrigin('https://gw.example.test:8443/')).toBe(
      'https://gw.example.test:8443',
    )
    expect(checkOrigin('http://127.0.0.1:3430')).toBe('http://127.0.0.1:3430')
    expect(checkOrigin('http://localhost:3430')).toBe('http://localhost:3430')
    expect(checkOrigin('http://[::1]:3430')).toBe('http://[::1]:3430')
  })

  test.each([
    ['http://gw.example.test'],
    ['http://10.0.0.5:3430'],
    ['https://gw.example.test/v1'],
    ['https://gw.example.test/?a=1'],
    ['https://gw.example.test/#x'],
    ['https://user:pass@gw.example.test'],
    ['ftp://gw.example.test'],
    ['gw.example.test'],
    [''],
    ['https://gw.example.test\n'],
    ['https://gw.example.test:0'],
  ])('refuses %p', url => {
    expect(() => checkOrigin(url)).toThrow(MagpieError)
    try {
      checkOrigin(url)
    } catch (error) {
      expect((error as MagpieError).code).toBe('magpie_bad_url')
    }
  })

  test('the constructor checks both origins', () => {
    expect(
      () => new MagpieClient({ managementUrl: 'http://example.test' }),
    ).toThrow(MagpieError)
    expect(
      () => new MagpieClient({ gatewayUrl: 'https://x.test/path' }),
    ).toThrow(MagpieError)
  })

  test('a web key that would break the cookie is refused', () => {
    expect(
      () =>
        new MagpieClient({ managementUrl: fake.managementUrl, webKey: 'a;b' }),
    ).toThrow(MagpieError)
    expect(
      () => new MagpieClient({ managementUrl: fake.managementUrl, webKey: '' }),
    ).toThrow(MagpieError)
  })
})

describe('transport', () => {
  test('sends the web key as magpie_web_<port>', async () => {
    await client.info()
    const last = fake.requests.at(-1)
    expect(last?.cookie).toBe(true)
    expect(last?.path).toBe('/api/settings')
  })

  test('a wrong web key is magpie_auth, and the key is not in the message', async () => {
    const wrong = clientFor({ webKey: 'not-the-key-123456' })
    const error = await failure(() => wrong.info())
    expect(error.code).toBe('magpie_auth')
    expect(error.status).toBe(401)
    expect(error.message).not.toContain('not-the-key-123456')
  })

  test('the cookie port follows webCookiePort', async () => {
    const proxied = clientFor({ webCookiePort: 3430 })
    expect((await failure(() => proxied.info())).code).toBe('magpie_auth')
  })

  test('no web key is magpie_auth before any request', async () => {
    const bare = new MagpieClient({ managementUrl: fake.managementUrl })
    const before = fake.requests.length
    expect((await failure(() => bare.listKeys())).code).toBe('magpie_auth')
    expect(fake.requests.length).toBe(before)
  })

  test('no management origin is magpie_bad_url', async () => {
    const gatewayOnly = new MagpieClient({ gatewayUrl: fake.gatewayUrl })
    expect((await failure(() => gatewayOnly.info())).code).toBe(
      'magpie_bad_url',
    )
  })

  test('a redirect is refused, not followed', async () => {
    fake.fault({
      target: 'management',
      redirect: 'https://elsewhere.example.test/api/settings',
    })
    const error = await failure(() => client.info())
    expect(error.code).toBe('magpie_bad_response')
    expect(error.status).toBe(302)
    expect(fake.requests.length).toBe(1)
  })

  test('a slow magpie times out', async () => {
    fake.fault({ target: 'management', delayMs: 400, status: 200, body: '{}' })
    const quick = clientFor({ timeoutMs: 100 })
    const error = await failure(() => quick.info())
    expect(error.code).toBe('magpie_unreachable')
    expect(error.message).toContain('超时')
  })

  test('a body past the cap is cut off, declared or streamed', async () => {
    fake.fault({ target: 'management', oversize: 3 * 1024 * 1024 })
    expect((await failure(() => client.info())).code).toBe(
      'magpie_bad_response',
    )
    fake.clearFaults()
    fake.fault({ target: 'management', status: 200, body: 'x'.repeat(5000) })
    const small = clientFor({ maxBytes: 1000 })
    expect((await failure(() => small.info())).code).toBe('magpie_bad_response')
  })

  test('a closed port is magpie_unreachable', async () => {
    const url = fake.managementUrl
    await fake.stop()
    const gone = new MagpieClient({
      managementUrl: url,
      webKey: 'whatever-key',
      timeoutMs: 1000,
    })
    expect((await failure(() => gone.info())).code).toBe('magpie_unreachable')
    fake = await FakeMagpie.start()
  })

  test('a 404 is magpie_not_found', async () => {
    fake.fault({ target: 'management', status: 404, body: 'not found' })
    expect((await failure(() => client.listKeys())).code).toBe(
      'magpie_not_found',
    )
  })

  test('a 500 or a non-JSON body is magpie_bad_response, without the body', async () => {
    fake.fault({
      target: 'management',
      status: 500,
      body: 'panic: secret-ish',
      times: 1,
    })
    const error = await failure(() => client.listKeys())
    expect(error.code).toBe('magpie_bad_response')
    expect(error.message).not.toContain('secret-ish')
    fake.fault({
      target: 'management',
      status: 200,
      body: '<html>',
      contentType: 'text/html',
      times: 1,
    })
    expect((await failure(() => client.listKeys())).code).toBe(
      'magpie_bad_response',
    )
  })

  test("a refusal carries magpie's sentence with every secret of the request taken out", async () => {
    await client.addKey({ name: 'one', secret: OWN_SECRET })
    fake.fault({
      target: 'management',
      path: '/api/caller-keys/add-key',
      status: 400,
      body: JSON.stringify({
        error: `bad ${OWN_SECRET} and ${fake.webKey}\u0007`,
      }),
    })
    const error = await failure(() =>
      client.addKey({ name: 'two', secret: `${OWN_SECRET}-2` }),
    )
    expect(error.code).toBe('magpie_rejected')
    expect(error.message).not.toContain(fake.webKey)
    expect(error.message).not.toContain('\u0007')
  })
})

describe('identity', () => {
  test('hello needs a gateway key beyond loopback', async () => {
    expect((await failure(() => client.hello())).code).toBe('magpie_auth')
    const key = await client.addKey({ name: 'probe', secret: OWN_SECRET })
    expect(key.id).not.toBe('')
    expect(await client.hello(OWN_SECRET)).toEqual({
      name: 'magpie',
      version: '0.1.1268-fake',
    })
  })

  test("the gateway's 401 text, which quotes the key, never reaches the error", async () => {
    const error = await failure(() => client.hello('qm-gw-wrong-key-WXYZ'))
    expect(error.code).toBe('magpie_auth')
    expect(error.message).not.toContain('WXYZ')
  })

  test('an open gateway answers without a key', async () => {
    fake.gatewayOpen = true
    expect((await client.hello()).name).toBe('magpie')
  })

  test('something that is not magpie is magpie_not_magpie', async () => {
    fake.gatewayOpen = true
    fake.fault({
      target: 'gateway',
      status: 200,
      body: JSON.stringify({ name: 'ollama' }),
    })
    expect((await failure(() => client.hello())).code).toBe('magpie_not_magpie')
    fake.fault({
      target: 'management',
      status: 200,
      body: JSON.stringify({ ok: true }),
    })
    expect((await failure(() => client.info())).code).toBe('magpie_not_magpie')
  })

  test('info reads version and gateway', async () => {
    const info = await client.info()
    expect(info.version).toBe('0.1.1268-fake')
    expect(info.gateway).toBe(fake.gatewayUrl)
    expect(info.onNetwork).toBe(true)
  })
})

describe('providers', () => {
  test('lists with access class and plan, never a key', async () => {
    const providers = await client.listProviders()
    const byId = Object.fromEntries(
      providers.map(provider => [provider.id, provider]),
    )
    expect(byId['openai']?.access).toBe('key')
    expect(byId['openai']?.modelIds).toEqual(['gpt-6', 'gpt-6-mini'])
    expect(byId['codex']?.access).toBe('account')
    expect(byId['codex']?.plan).toBe('pro')
    expect(byId['zen']?.access).toBe('client')
    expect(JSON.stringify(providers)).not.toContain('sk-upstream-openai-0001')
  })

  test('presets leave out remote, own-client and endpoint ones', async () => {
    const ids = (await client.listPresets()).map(preset => preset.id)
    expect(ids).toContain('openai')
    expect(ids).toContain('ollama')
    expect(ids).not.toContain('remote-magpie')
    expect(ids).not.toContain('opencode')
    expect(ids).not.toContain('azure')
  })

  test('save adds under the next free id and returns it', async () => {
    const added = await client.saveProvider({
      preset: 'openai',
      key: 'sk-upstream-openai-0002',
    })
    expect(added.id).toBe('openai-2')
    expect(added.access).toBe('key')
    const body = fake.requests.find(
      request => request.path === '/api/provider/save',
    )?.body
    expect(body).toMatchObject({
      new: true,
      preset: 'openai',
      key: 'sk-upstream-openai-0002',
    })
  })

  test("save's refusal does not repeat the key", async () => {
    fake.fault({
      target: 'management',
      path: '/api/provider/save',
      status: 400,
      body: JSON.stringify({ error: 'key sk-upstream-bad-9999 refused' }),
    })
    const error = await failure(() =>
      client.saveProvider({ preset: 'openai', key: 'sk-upstream-bad-9999' }),
    )
    expect(error.code).toBe('magpie_rejected')
    expect(error.message).not.toContain('sk-upstream-bad-9999')
  })

  test('save checks its draft before asking', async () => {
    const before = fake.requests.length
    await expect(client.saveProvider({ preset: '' })).rejects.toThrow(
      MagpieError,
    )
    await expect(client.saveProvider({ preset: 'Bad Preset' })).rejects.toThrow(
      MagpieError,
    )
    await expect(
      client.saveProvider({ preset: 'openai', key: 'a b' }),
    ).rejects.toThrow(MagpieError)
    await expect(
      client.saveProvider({ preset: '', chat: 'https://x.test/v1' }),
    ).rejects.toThrow(MagpieError)
    expect(fake.requests.length).toBe(before)
  })

  test('a custom provider goes by its URLs', async () => {
    const added = await client.saveProvider({
      preset: '',
      name: 'My Relay',
      chat: 'https://relay.example.test/v1',
      key: 'k-123456789',
    })
    expect(added.preset).toBe('')
    expect(added.host).toBe('relay.example.test')
  })

  test('on, off, delete', async () => {
    const off = await client.setProviderEnabled('openai', false)
    expect(off.find(provider => provider.id === 'openai')?.enabled).toBe(false)
    const on = await client.setProviderEnabled('openai', true)
    expect(on.find(provider => provider.id === 'openai')?.enabled).toBe(true)
    const left = await client.deleteProvider('openrouter')
    expect(left.some(provider => provider.id === 'openrouter')).toBe(false)
    expect((await failure(() => client.deleteProvider('nope'))).code).toBe(
      'magpie_rejected',
    )
    await expect(client.deleteProvider('../x')).rejects.toThrow(MagpieError)
  })

  test("test drops the vendor's text", async () => {
    const ok = await client.testProvider('openai')
    expect(ok).toEqual([
      { protocol: 'chat', ok: true, status: 200, ms: 42, model: 'gpt-6' },
    ])
    await client.setProviderEnabled('openai', false)
    const bad = await client.testProvider('openai')
    expect(bad[0]?.ok).toBe(false)
    expect(JSON.stringify(bad)).not.toContain('sk-upstream-openai-0001')
  })

  test('models refetch', async () => {
    expect(await client.providerModels('openai')).toEqual({
      count: 2,
      models: ['gpt-6', 'gpt-6-mini'],
    })
  })
})

describe('groups', () => {
  test('lists own members apart from matched ones', async () => {
    fake.setGroup({
      id: 'router',
      members: ['openai/gpt-6'],
      match: ['openrouter/*'],
    })
    const groups = await client.listGroups()
    const router = groups.find(group => group.id === 'router')
    expect(router?.members).toEqual(['openai/gpt-6'])
    expect(router?.matched).toEqual(['openrouter/anthropic/claude-sonnet-5'])
    expect(router?.match).toEqual(['openrouter/*'])
    expect(router?.routing).toBe('smart')
    expect(groups.find(group => group.id === 'fast')?.routing).toBe('order')
  })

  test('save keeps what it does not change, and never stores what was matched', async () => {
    fake.setGroup({
      id: 'router',
      members: ['openai/gpt-6'],
      match: ['openrouter/*'],
      extra: { firstToken: 9 },
    })
    await client.saveGroup({ id: 'router', routing: 'rotate' })
    const stored = fake.group('router')
    expect(stored?.members).toEqual(['openai/gpt-6'])
    expect(stored?.match).toEqual(['openrouter/*'])
    expect(stored?.['firstToken']).toBe(9)
    expect(stored?.['routing']).toBe('rotate')
    expect(stored?.['ready']).toBeUndefined()
  })

  test('save with members replaces them', async () => {
    const saved = await client.saveGroup({
      id: 'fast',
      members: ['openai/gpt-6', 'openai/gpt-6-mini'],
      affinity: 'session',
    })
    expect(saved.members).toEqual(['openai/gpt-6', 'openai/gpt-6-mini'])
    expect(saved.affinity).toBe('session')
    expect(fake.group('fast')?.['weights']).toEqual({ 'openai/gpt-6-mini': 2 })
  })

  test('smart and auto go as magpie empty strings', async () => {
    await client.saveGroup({ id: 'fast', routing: 'smart', affinity: 'auto' })
    expect(fake.group('fast')?.['routing']).toBeUndefined()
    expect(fake.group('fast')?.['affinity']).toBeUndefined()
  })

  test('a new group needs members; a rename moves it', async () => {
    await expect(client.saveGroup({ id: 'empty' })).rejects.toThrow(MagpieError)
    const created = await client.saveGroup({
      id: 'new.one',
      name: 'New',
      members: ['openai/gpt-6'],
    })
    expect(created.name).toBe('New')
    const renamed = await client.saveGroup({ id: 'renamed', from: 'new.one' })
    expect(renamed.id).toBe('renamed')
    expect(fake.group('new.one')).toBeUndefined()
  })

  test('save checks ids, routing and members locally', async () => {
    const before = fake.requests.length
    await expect(
      client.saveGroup({ id: 'Bad Id', members: ['a/b'] }),
    ).rejects.toThrow(MagpieError)
    // @ts-expect-error an unknown routing is the point
    await expect(
      client.saveGroup({ id: 'g', routing: 'weight', members: ['a/b'] }),
    ).rejects.toThrow(MagpieError)
    await expect(
      client.saveGroup({ id: 'g', members: ['nomodel'] }),
    ).rejects.toThrow(MagpieError)
    expect(fake.requests.length).toBe(before)
  })

  test('delete', async () => {
    const left = await client.deleteGroup('mixed')
    expect(left.map(group => group.id)).toEqual(['fast'])
  })
})

describe('gateway keys', () => {
  test('add with our value, found by its unique name; the list masks it', async () => {
    const key = await client.addKey({ name: 'qm-node-a-1', secret: OWN_SECRET })
    expect(key.name).toBe('qm-node-a-1')
    expect(key.masked).toBe(`…${OWN_SECRET.slice(-4)}`)
    expect(fake.key(key.id)?.secret).toBe(OWN_SECRET)
    const listed = await client.listKeys()
    expect(JSON.stringify(listed)).not.toContain(OWN_SECRET)
  })

  test('add refuses a duplicate name, a magpie prefix and a short value', async () => {
    await client.addKey({ name: 'dup', secret: OWN_SECRET })
    expect(
      (
        await failure(() =>
          client.addKey({ name: 'dup', secret: `${OWN_SECRET}x` }),
        )
      ).code,
    ).toBe('magpie_invalid')
    expect(
      (
        await failure(() =>
          client.addKey({ name: 'p', secret: 'sk-magpie-abcdefgh' }),
        )
      ).code,
    ).toBe('magpie_invalid')
    expect(
      (await failure(() => client.addKey({ name: 's', secret: 'short' }))).code,
    ).toBe('magpie_invalid')
    expect(
      (await failure(() => client.addKey({ name: '', secret: OWN_SECRET })))
        .code,
    ).toBe('magpie_invalid')
  })

  test('limits: set, replace in place, change windows, clear', async () => {
    const { id } = await client.addKey({ name: 'lim', secret: OWN_SECRET })
    let key = await client.setKeyLimits(id, [
      { period: 'day', tokens: 1000 },
      { period: 'month', cost: 5 },
    ])
    expect(key.limits).toEqual([
      { period: 'day', tokens: 1000 },
      { period: 'month', cost: 5 },
    ])
    const since = fake.key(id)?.limits[0]?.since
    key = await client.setKeyLimits(id, [
      { period: 'day', tokens: 2000 },
      { period: 'month', cost: 6 },
    ])
    expect(key.limits[0]?.tokens).toBe(2000)
    expect(fake.key(id)?.limits[0]?.since).toBe(since)
    key = await client.setKeyLimits(id, [
      { period: 'hours', hours: 5, tokens: 10 },
    ])
    expect(key.limits).toEqual([{ period: 'hours', hours: 5, tokens: 10 }])
    key = await client.setKeyLimits(id, [])
    expect(key.limits).toEqual([])
  })

  test('limits are checked locally', async () => {
    const { id } = await client.addKey({ name: 'lim', secret: OWN_SECRET })
    const six = Array.from({ length: 6 }, (_, n) => ({
      period: 'days' as const,
      days: n + 1,
      tokens: 1,
    }))
    expect((await failure(() => client.setKeyLimits(id, six))).code).toBe(
      'magpie_invalid',
    )
    expect(
      (await failure(() => client.setKeyLimits(id, [{ period: 'day' }]))).code,
    ).toBe('magpie_invalid')
    expect(
      (
        await failure(() =>
          client.setKeyLimits(id, [{ period: 'days', tokens: 1 }]),
        )
      ).code,
    ).toBe('magpie_invalid')
    expect(
      (
        await failure(() =>
          client.setKeyLimits(id, [
            { period: 'day', tokens: 1 },
            { period: 'day', cost: 1 },
          ]),
        )
      ).code,
    ).toBe('magpie_invalid')
    expect(
      (
        await failure(() =>
          client.setKeyLimits(id, [{ period: 'day', tokens: -1 }]),
        )
      ).code,
    ).toBe('magpie_invalid')
  })

  test('used and reset', async () => {
    const { id } = await client.addKey({ name: 'lim', secret: OWN_SECRET })
    await client.setKeyLimits(id, [{ period: 'day', tokens: 100 }])
    fake.setKeyUsed(id, 150)
    let key = (await client.listKeys()).find(one => one.id === id)
    expect(key?.used[0]).toMatchObject({
      period: 'day',
      tokens: 100,
      tokensUsed: 150,
      spent: true,
    })
    key = await client.resetKeyLimit(id, 0)
    expect(key.used[0]?.tokensUsed).toBe(0)
    expect((await failure(() => client.resetKeyLimit(id, -1))).code).toBe(
      'magpie_invalid',
    )
  })

  test('models: an empty list is refused, a list is kept', async () => {
    const { id } = await client.addKey({ name: 'm', secret: OWN_SECRET })
    expect((await failure(() => client.setKeyModels(id, []))).code).toBe(
      'magpie_invalid',
    )
    expect(
      (await failure(() => client.setKeyModels(id, ['nomodel']))).code,
    ).toBe('magpie_invalid')
    const key = await client.setKeyModels(id, ['openai/*', 'group/fast'])
    expect(key.models).toEqual(['openai/*', 'group/fast'])
  })

  test('on and off; remove; an unknown key', async () => {
    const { id } = await client.addKey({ name: 'o', secret: OWN_SECRET })
    expect((await client.setKeyEnabled(id, false)).enabled).toBe(false)
    expect((await client.setKeyEnabled(id, true)).enabled).toBe(true)
    await client.removeKey(id)
    expect(await client.listKeys()).toEqual([])
    expect((await failure(() => client.removeKey(id))).code).toBe(
      'magpie_rejected',
    )
    expect((await failure(() => client.setKeyLimits(id, []))).code).toBe(
      'magpie_not_found',
    )
  })

  test("rotate gives magpie's new value once and keeps id and limits", async () => {
    const { id } = await client.addKey({ name: 'r', secret: OWN_SECRET })
    await client.setKeyLimits(id, [{ period: 'week', tokens: 9 }])
    const { secret } = await client.rotateKey(id)
    expect(secret.startsWith('sk-magpie-key-')).toBe(true)
    expect(fake.key(id)?.secret).toBe(secret)
    expect(fake.key(id)?.limits.length).toBe(1)
  })

  test('choices list models and groups, never accounts', async () => {
    const choices = await client.keyChoices()
    expect(
      choices.some(choice => choice.id === 'group/fast' && choice.group),
    ).toBe(true)
    expect(
      choices.some(
        choice => choice.id === 'openai/gpt-6' && choice.provider === 'openai',
      ),
    ).toBe(true)
    expect(choices.some(choice => choice.id.endsWith('acct-1'))).toBe(false)
  })
})

describe('usage', () => {
  test('reads the summary of a period', async () => {
    const { id } = await client.addKey({ name: 'u', secret: OWN_SECRET })
    fake.setUsage('7d', {
      calls: 3,
      input: 100,
      output: 50,
      cost: 0.12,
      models: [
        {
          provider: 'openai',
          model: 'gpt-6',
          calls: 3,
          input: 100,
          output: 50,
          cost: 0.12,
        },
      ],
      keys: [{ keyId: id, calls: 3, input: 100, output: 50, cost: 0.12 }],
    })
    const usage = await client.usage('7d')
    expect(usage.period).toBe('7d')
    expect(usage.totals).toMatchObject({
      calls: 3,
      input: 100,
      output: 50,
      cost: 0.12,
    })
    expect(usage.models[0]).toMatchObject({
      id: 'openai/gpt-6',
      name: 'gpt-6',
      calls: 3,
    })
    expect(usage.keys[0]).toMatchObject({ keyId: id, name: 'u', cost: 0.12 })
    expect(fake.requests.at(-1)?.path).toBe('/api/usage?period=7d')
  })

  test('an empty period has no since', async () => {
    expect((await client.usage('today')).since).toBeNull()
  })

  test('an unknown period is refused before asking', async () => {
    const before = fake.requests.length
    // @ts-expect-error an unknown period is the point
    expect((await failure(() => client.usage('90d'))).code).toBe(
      'magpie_invalid',
    )
    expect(fake.requests.length).toBe(before)
  })
})

describe('catalog', () => {
  test("lists the gateway's models as the key sees them", async () => {
    const { id } = await client.addKey({ name: 'c', secret: OWN_SECRET })
    let models = await client.catalog(OWN_SECRET)
    expect(models.map(model => model.id)).toContain('codex/gpt-6-codex')
    await client.setKeyModels(id, ['openai/*', 'group/fast'])
    models = await client.catalog(OWN_SECRET)
    expect(models.map(model => model.id).sort()).toEqual([
      'group/fast',
      'openai/gpt-6',
      'openai/gpt-6-mini',
    ])
    expect(fake.requests.at(-1)?.key).toBe(OWN_SECRET)
  })

  test('refuses has_more, an overlong list, and a wrong shape', async () => {
    await client.addKey({ name: 'c', secret: OWN_SECRET })
    fake.fault({
      target: 'gateway',
      times: 1,
      status: 200,
      body: JSON.stringify({ object: 'list', data: [], has_more: true }),
    })
    expect((await failure(() => client.catalog(OWN_SECRET))).code).toBe(
      'magpie_bad_response',
    )
    const long = Array.from({ length: 2001 }, (_, n) => ({ id: `p/m${n}` }))
    fake.fault({
      target: 'gateway',
      times: 1,
      status: 200,
      body: JSON.stringify({ object: 'list', data: long }),
    })
    expect((await failure(() => client.catalog(OWN_SECRET))).code).toBe(
      'magpie_bad_response',
    )
    fake.fault({
      target: 'gateway',
      times: 1,
      status: 200,
      body: JSON.stringify({ data: 'x' }),
    })
    expect((await failure(() => client.catalog(OWN_SECRET))).code).toBe(
      'magpie_bad_response',
    )
  })

  test('a disabled key is magpie_auth', async () => {
    const { id } = await client.addKey({ name: 'c', secret: OWN_SECRET })
    await client.setKeyEnabled(id, false)
    const error = await failure(() => client.catalog(OWN_SECRET))
    expect(error.code).toBe('magpie_auth')
    expect(error.message).not.toContain(OWN_SECRET.slice(-4))
  })
})
