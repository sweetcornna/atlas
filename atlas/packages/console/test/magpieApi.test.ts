// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/v0/magpie` (P33/P34): everyone with view reads the gateway's state, only
 * writers see full addresses and key tails, and only a personal ops account
 * outside break-glass (a platform subject when there are tenants) changes
 * anything — guard and admission before any effect, every write recorded
 * under a target of our own grammar.
 */

import { beforeEach, expect, test } from 'bun:test'
import type { Access } from '../src/access.js'
import type { ConsoleDeps } from '../src/deps.js'
import type { MagpieKeyView, MagpieSnapshot } from '../src/directionPorts.js'
import { magpieApi } from '../src/routes/magpieApi.js'
import type { RouteContext } from '../src/routes/types.js'
import type { TenantPort } from '../src/tenancy.js'
import { LIMITS } from './accountsHarness.js'
import { FakeMagpie } from './directionFakes.js'

const NOW = 1_700_000_000_000
const SUBJECT = 'u:0123456789abcdef'
let port: FakeMagpie
let admits: number
let records: string[]
let deps: ConsoleDeps
const denied = {
  ok: false as const,
  failure: { code: 'unsupported' as const, message: 'unused' },
}

beforeEach(() => {
  port = new FakeMagpie()
  admits = 0
  records = []
  deps = {
    limits: LIMITS,
    magpie: port,
    registry: {
      list: async () => ({ ok: true, value: [] }),
      register: async () => denied,
      heartbeat: async () => denied,
      deregister: async () => ({ ok: true, value: undefined }),
    },
    audit: { read: async () => denied, chain: async () => denied },
  }
})

function access(
  role: 'none' | 'view' | 'admin' | 'viewer' | 'member' | 'ops',
  breakGlass = false,
): Access {
  const personal = ['viewer', 'member', 'ops'].includes(role)
  return {
    credential: {
      role: personal
        ? role === 'ops'
          ? 'admin'
          : 'view'
        : (role as 'none' | 'view' | 'admin'),
      source: 'bearer',
      header: true,
      crossOrigin: false,
    },
    principal:
      role === 'none'
        ? null
        : personal
          ? {
              kind: 'user',
              subject: SUBJECT,
              role: role as 'ops',
              credential: 'bearer',
              authenticatedAt: 1,
            }
          : {
              kind: 'legacy',
              subject: role === 'admin' ? 'legacy:admin' : 'legacy:view',
              credential: 'bearer',
            },
    sid: null,
    refusal: null,
    breakGlass,
  }
}

function tenancy(platformSubjects: readonly string[] | 'broken'): TenantPort {
  return {
    read() {
      if (platformSubjects === 'broken') throw new Error('租户配置不可用')
      return {
        revision: 'r1',
        config: {
          version: 1,
          hubServer: 'hub',
          tenants: [],
          subjects: [],
          nodes: [],
          jobs: [],
          platformSubjects,
        },
      }
    },
    subscribe: () => () => {},
  }
}

async function call(
  method: string,
  path: string,
  who: Access,
  body?: unknown,
): Promise<Response> {
  const request = new Request(`http://console.test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }),
  })
  const url = new URL(request.url)
  const ctx: RouteContext = {
    request,
    url,
    deps,
    access: who,
    accounts: undefined,
    now: NOW,
    viewer: undefined,
    requestId: 'request',
    roster: () => deps.registry.list(),
    admit: async () => {
      admits++
      return null
    },
    record: async (action, target, outcome) => {
      records.push(`${action} ${target} ${outcome}`)
      return true
    },
  }
  return magpieApi.handle(
    ctx,
    'magpie',
    url.pathname.split('/').filter(Boolean).slice(2),
  )
}

test('view and up read the gateway; only a writer sees addresses whole and key tails', async () => {
  for (const role of ['view', 'admin', 'viewer', 'member', 'ops'] as const) {
    const response = await call('GET', '/v0/magpie', access(role))
    expect(response.status).toBe(200)
    const snapshot = (await response.json()) as MagpieSnapshot
    const writer = role === 'ops'
    expect(`${role} ${snapshot.connection.gatewayUrl}`).toBe(
      `${role} ${writer ? 'https://gw.tokyo.example:8443' : 'gw.tokyo.example:8443'}`,
    )
    expect(`${role} ${snapshot.connection.managementUrl}`).toBe(
      `${role} ${writer ? 'http://127.0.0.1:3430' : '127.0.0.1:3430'}`,
    )
    expect(`${role} ${snapshot.keys[0]?.masked}`).toBe(
      `${role} ${writer ? '…a1b2' : null}`,
    )
    expect(snapshot.providers.map(one => one.access)).toEqual([
      'key',
      'key',
      'account',
    ])
  }
  const breakGlass = (await (
    await call('GET', '/v0/magpie', access('ops', true))
  ).json()) as MagpieSnapshot
  expect(breakGlass.keys[0]?.masked).toBeNull()
  expect((await call('GET', '/v0/magpie', access('none'))).status).toBe(401)
  expect(admits).toBe(0)
})

test('usage reads by period and refuses one magpie would read as 30 days', async () => {
  const response = await call(
    'GET',
    '/v0/magpie/usage?period=30d',
    access('view'),
  )
  expect(response.status).toBe(200)
  const usage = (await response.json()) as { period: string; keys: unknown[] }
  expect(usage.period).toBe('30d')
  expect(usage.keys).toHaveLength(1)
  expect(
    (await call('GET', '/v0/magpie/usage?period=90d', access('view'))).status,
  ).toBe(400)
})

const WRITES: readonly (readonly [string, string, unknown?])[] = [
  [
    'POST',
    '/v0/magpie/connection',
    { gatewayUrl: 'https://a.test', managementUrl: 'http://127.0.0.1:3430' },
  ],
  ['POST', '/v0/magpie/check', {}],
  ['POST', '/v0/magpie/providers', { preset: 'openai', key: 'sk-upstream' }],
  ['POST', '/v0/magpie/providers/openai', { enabled: false }],
  ['POST', '/v0/magpie/providers/openai/test', {}],
  ['DELETE', '/v0/magpie/providers/openai'],
  ['POST', '/v0/magpie/groups', { id: 'fast', routing: 'rotate' }],
  ['DELETE', '/v0/magpie/groups/fast'],
  [
    'POST',
    '/v0/magpie/keys',
    { binding: 'node:osaka-1', mainModel: 'openai/gpt-6' },
  ],
  ['POST', '/v0/magpie/keys/node%3Atokyo-1', { enabled: false }],
  ['POST', '/v0/magpie/keys/node%3Atokyo-1/rotate', {}],
  ['DELETE', '/v0/magpie/keys/node%3Atokyo-1'],
]

test('nobody but a personal ops account writes; nothing happens before the guard', async () => {
  for (const who of [
    access('view'),
    access('admin'),
    access('viewer'),
    access('member'),
    access('ops', true),
  ]) {
    for (const [method, path, body] of WRITES) {
      const response = await call(method, path, who, body)
      expect(`${method} ${path} ${response.status}`).toBe(
        `${method} ${path} 403`,
      )
    }
  }
  expect(port.calls).toEqual([])
  expect(admits).toBe(0)
  expect(records).toEqual([])
})

test('with tenants, only a platform subject writes; a broken tenancy refuses', async () => {
  deps = { ...deps, tenancy: tenancy(['u:ffffffffffffffff']) }
  for (const [method, path, body] of WRITES) {
    expect((await call(method, path, access('ops'), body)).status).toBe(403)
  }
  deps = { ...deps, tenancy: tenancy('broken') }
  expect(
    (await call('POST', '/v0/magpie/check', access('ops'), {})).status,
  ).toBe(403)
  deps = { ...deps, tenancy: tenancy([SUBJECT]) }
  expect(
    (await call('POST', '/v0/magpie/check', access('ops'), {})).status,
  ).toBe(200)
  expect(port.calls).toEqual([`check ${SUBJECT}`])
})

test('every write is admitted once and recorded under our own target', async () => {
  const ops = access('ops')
  const statuses: number[] = []
  for (const [method, path, body] of WRITES) {
    statuses.push((await call(method, path, ops, body)).status)
  }
  expect(statuses).toEqual([
    200, 200, 200, 200, 200, 204, 200, 204, 200, 200, 200, 200,
  ])
  expect(admits).toBe(WRITES.length)
  expect(records).toEqual([
    'magpie.connect magpie ok',
    'magpie.check magpie ok',
    'magpie.provider.save new ok',
    'magpie.provider.toggle openai ok',
    'magpie.provider.test openai ok',
    'magpie.provider.remove openai ok',
    'magpie.group.save fast ok',
    'magpie.group.remove fast ok',
    'magpie.key.issue node:osaka-1 ok',
    'magpie.key.update node:tokyo-1 ok',
    'magpie.key.rotate node:tokyo-1 ok',
    'magpie.key.remove node:tokyo-1 ok',
  ])
  expect(port.calls[0]).toBe(`connect https://a.test ${SUBJECT}`)
})

test('a port refusal keeps its code and is recorded as failed', async () => {
  const ops = access('ops')
  const plain = await call('POST', '/v0/magpie/connection', ops, {
    gatewayUrl: 'http://a.test',
    managementUrl: 'http://127.0.0.1:3430',
  })
  expect(plain.status).toBe(400)
  const account = await call('POST', '/v0/magpie/providers', ops, {
    preset: 'codex',
  })
  expect(account.status).toBe(400)
  expect(
    ((await account.json()) as { error: { code: string } }).error.code,
  ).toBe('rejected')
  const missing = await call(
    'POST',
    '/v0/magpie/keys/node%3Anowhere/rotate',
    ops,
    {},
  )
  expect(missing.status).toBe(404)
  expect(records).toEqual([
    'magpie.connect magpie failed',
    'magpie.provider.save new failed',
    'magpie.key.rotate node:nowhere failed',
  ])
})

test('bodies and path segments are checked before the port is asked', async () => {
  const ops = access('ops')
  const bad: readonly (readonly [string, string, unknown?])[] = [
    ['POST', '/v0/magpie/connection', { gatewayUrl: '' }],
    ['POST', '/v0/magpie/providers', {}],
    ['POST', '/v0/magpie/providers/Bad_Id', { enabled: true }],
    ['POST', '/v0/magpie/providers/openai', { enabled: 'yes' }],
    ['POST', '/v0/magpie/groups', { id: 'g', routing: 'weight' }],
    ['DELETE', '/v0/magpie/groups/Bad.Group'],
    ['POST', '/v0/magpie/keys', { binding: 'node:Bad Node', mainModel: 'a/b' }],
    ['POST', '/v0/magpie/keys', { binding: 'node:osaka-1' }],
    [
      'POST',
      '/v0/magpie/keys',
      {
        binding: { kind: 'tenant', id: 'acme' },
        mainModel: 'a/b',
        limits: [{ period: 'year', tokens: 1 }],
      },
    ],
    [
      'POST',
      '/v0/magpie/keys',
      {
        binding: 'node:osaka-1',
        mainModel: 'a/b',
        limits: new Array(6).fill({ period: 'day', tokens: 1 }),
      },
    ],
    ['POST', '/v0/magpie/keys/server%3Ax', { enabled: true }],
    ['POST', '/v0/magpie/keys/node%3Atokyo-1', { resetLimit: -1 }],
    ['POST', '/v0/magpie/keys/node%3Atokyo-1', { models: 'openai/*' }],
  ]
  for (const [method, path, body] of bad) {
    const response = await call(method, path, ops, body)
    expect(`${method} ${path} ${JSON.stringify(body)} ${response.status}`).toBe(
      `${method} ${path} ${JSON.stringify(body)} 400`,
    )
  }
  expect(port.calls).toEqual([])
  expect(records).toEqual([])
})

test('a tenant binding and a key change reach the port as typed drafts', async () => {
  const ops = access('ops')
  const issued = await call('POST', '/v0/magpie/keys', ops, {
    binding: { kind: 'tenant', id: 'acme' },
    mainModel: 'openai/gpt-6',
    fastModel: 'group/fast',
    lane: 'openai-chat',
    models: ['openai/*'],
    limits: [{ period: 'days', days: '7', tokens: '1000' }],
  })
  expect(issued.status).toBe(200)
  const view = (await issued.json()) as MagpieKeyView
  expect(view.binding).toEqual({ kind: 'tenant', id: 'acme' })
  expect(view.lane).toBe('openai-chat')
  expect(view.modelsMode).toBe('list')
  const back = await call('POST', '/v0/magpie/keys/tenant%3Aacme', ops, {
    models: null,
    fastModel: null,
  })
  const changed = (await back.json()) as MagpieKeyView
  expect(changed.modelsMode).toBe('all')
  expect(changed.fastModel).toBeNull()
})

test('unknown paths, wrong methods and a missing port', async () => {
  const ops = access('ops')
  const unknown = await call('GET', '/v0/magpie/nope', ops)
  expect(unknown.status).toBe(404)
  expect(await unknown.text()).toContain('unknown path')
  expect(
    (await call('GET', '/v0/magpie/keys/node%3Atokyo-1/x', ops)).status,
  ).toBe(404)
  expect((await call('PUT', '/v0/magpie', ops)).status).toBe(405)
  expect((await call('GET', '/v0/magpie/providers/openai', ops)).status).toBe(
    405,
  )
  expect((await call('POST', '/v0/magpie/groups/fast', ops, {})).status).toBe(
    405,
  )
  const { magpie: _gone, ...rest } = deps
  deps = rest
  expect((await call('GET', '/v0/magpie', ops)).status).toBe(501)
  expect((await call('POST', '/v0/magpie/check', ops, {})).status).toBe(501)
})
