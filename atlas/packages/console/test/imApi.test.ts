// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/v0/im` (P28): everyone with view reads the channels, only ops see platform
 * user ids, and only a personal ops account (not break-glass) writes or
 * starts a WeChat login — guard and admission before any effect, only
 * generated ids in the action ledger.
 */

import { beforeEach, expect, test } from 'bun:test'
import type { Access } from '../src/access.js'
import type { ConsoleDeps } from '../src/deps.js'
import type { ChannelsSnapshot } from '../src/directionPorts.js'
import { channelsApi } from '../src/routes/imApi.js'
import type { RouteContext } from '../src/routes/types.js'
import { LIMITS } from './accountsHarness.js'
import { FakeChannels } from './directionFakes.js'

const NOW = 1_700_000_000_000
let port: FakeChannels
let admits: number
let records: string[]
let deps: ConsoleDeps
const denied = {
  ok: false as const,
  failure: { code: 'unsupported' as const, message: 'unused' },
}

beforeEach(() => {
  port = new FakeChannels(() => NOW)
  admits = 0
  records = []
  deps = {
    limits: LIMITS,
    channels: port,
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
              subject: 'u:0123456789abcdef',
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
  const ctx: RouteContext = {
    request,
    url: new URL(request.url),
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
    record: async (action, target) => {
      records.push(`${action} ${target}`)
      return true
    },
  }
  return channelsApi.handle(ctx, 'im', path.split('/').filter(Boolean).slice(2))
}

test('view reads; platform user ids only for ops', async () => {
  for (const role of ['view', 'admin', 'viewer', 'member', 'ops'] as const) {
    const response = await call('GET', '/v0/im', access(role))
    expect(response.status).toBe(200)
    const channel = ((await response.json()) as ChannelsSnapshot).channels[0]!
    const ops = role === 'admin' || role === 'ops'
    expect(`${role} ${channel.ownerIds.length > 0}`).toBe(`${role} ${ops}`)
    expect(`${role} ${'appId' in channel.settings}`).toBe(`${role} ${ops}`)
    expect(`${role} ${channel.pairingRequests.length > 0}`).toBe(
      `${role} ${ops}`,
    )
  }
  expect((await call('GET', '/v0/im', access('none'))).status).toBe(401)
  expect(admits).toBe(0)
})

test('only a personal ops account writes; nothing happens before the guard', async () => {
  for (const who of [
    access('view'),
    access('admin'),
    access('viewer'),
    access('member'),
    access('ops', true),
  ]) {
    expect((await call('POST', '/v0/im', who, { name: 'x' })).status).toBe(403)
    expect((await call('DELETE', '/v0/im/ch-1', who)).status).toBe(403)
    expect(
      (await call('POST', '/v0/im/login', who, { platform: 'weixin' })).status,
    ).toBe(403)
    expect(
      (
        await call('POST', '/v0/im/ch-1/pairing', who, {
          requestId: 'pr-1',
          decision: 'owner',
        })
      ).status,
    ).toBe(403)
  }
  expect(port.calls).toEqual([])
  expect(admits).toBe(0)
})

test('save, login and remove are admitted and recorded with generated ids only', async () => {
  const ops = access('ops')
  const saved = await call('POST', '/v0/im', ops, {
    name: '新 Telegram',
    platform: 'telegram',
    target: 'qianmo://tokyo-1/planner',
    secrets: { token: 't' },
  })
  expect(saved.status).toBe(200)
  const login = await call('POST', '/v0/im/login', ops, {
    id: 'not an id',
    name: '微信',
    platform: 'weixin',
    target: 'qianmo://tokyo-1/planner',
  })
  const view = (await login.json()) as { loginId: string; state: string }
  expect(view.state).toBe('wait')
  expect(
    (await (
      await call('GET', `/v0/im/login/${view.loginId}`, ops)
    ).json()) as object,
  ).toMatchObject({ state: 'scanned' })
  expect((await call('DELETE', '/v0/im/ch-1', ops)).status).toBe(204)
  expect((await call('PUT', '/v0/im', ops)).status).toBe(405)
  expect((await call('GET', '/v0/im/a/b', ops)).status).toBe(404)
  expect(admits).toBe(3)
  expect(records).toEqual(['im.save new', 'im.login -', 'im.remove -'])
  expect(port.calls).toEqual([
    'save new 新 Telegram',
    'login 微信',
    'remove ch-1',
  ])
})

test('a pairing request is decided by ops, validated and recorded', async () => {
  const ops = access('ops')
  for (const body of [
    { requestId: 'pr-1', decision: 'admin' },
    { requestId: '../x', decision: 'owner' },
    { decision: 'owner' },
  ])
    expect((await call('POST', '/v0/im/ch-1/pairing', ops, body)).status).toBe(
      400,
    )
  expect((await call('GET', '/v0/im/ch-1/pairing', ops)).status).toBe(405)
  const decided = await call('POST', '/v0/im/ch-1/pairing', ops, {
    requestId: 'pr-1',
    decision: 'owner',
  })
  expect(decided.status).toBe(200)
  expect(((await decided.json()) as { ownerIds: string[] }).ownerIds).toEqual([
    'OWNER-OPENID',
    'STRANGER-OPENID',
  ])
  expect(records).toEqual(['im.pair -:owner'])
  expect(port.calls).toEqual(['pair ch-1 pr-1 owner'])
})

test('without a channels port the API says so', async () => {
  const { channels: _gone, ...rest } = deps
  deps = rest
  expect((await call('GET', '/v0/im', access('ops'))).status).toBe(501)
})
