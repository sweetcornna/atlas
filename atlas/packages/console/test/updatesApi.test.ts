// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/v0/updates` (P31): everyone with view reads the versions, only ops see
 * the notification channels, and only a personal ops account (not
 * break-glass) changes the settings or starts a check — guard and admission
 * before any effect.
 */

import { beforeEach, expect, test } from 'bun:test'
import type { Access } from '../src/access.js'
import type { ConsoleDeps } from '../src/deps.js'
import type { UpdatesSnapshot } from '../src/directionPorts.js'
import type { RouteContext } from '../src/routes/types.js'
import { updatesApi } from '../src/routes/updatesApi.js'
import { LIMITS } from './accountsHarness.js'
import { FakeUpdates } from './directionFakes.js'

const NOW = 1_700_000_000_000
let port: FakeUpdates
let admits: number
let records: string[]
let deps: ConsoleDeps
const denied = {
  ok: false as const,
  failure: { code: 'unsupported' as const, message: 'unused' },
}

beforeEach(() => {
  port = new FakeUpdates(() => NOW)
  admits = 0
  records = []
  deps = {
    limits: LIMITS,
    updates: port,
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
  return updatesApi.handle(
    ctx,
    'updates',
    path.split('/').filter(Boolean).slice(2),
  )
}

test('view reads; notification channels only for ops', async () => {
  for (const role of ['view', 'admin', 'viewer', 'member', 'ops'] as const) {
    const response = await call('GET', '/v0/updates', access(role))
    expect(response.status).toBe(200)
    const snapshot = (await response.json()) as UpdatesSnapshot
    const ops = role === 'admin' || role === 'ops'
    expect(snapshot.sources.map(one => one.id)).toEqual([
      'qianmopi',
      'claude-code',
      'codex',
      'qianmo',
    ])
    expect(`${role} ${snapshot.channelChoices.length > 0}`).toBe(
      `${role} ${ops}`,
    )
    expect(`${role} ${snapshot.channels.length > 0}`).toBe(`${role} ${ops}`)
  }
  expect((await call('GET', '/v0/updates', access('none'))).status).toBe(401)
  expect(admits).toBe(0)
})

test('only a personal ops account saves or runs; nothing happens before the guard', async () => {
  for (const who of [
    access('view'),
    access('admin'),
    access('viewer'),
    access('member'),
    access('ops', true),
  ]) {
    expect((await call('POST', '/v0/updates', who, { times: [] })).status).toBe(
      403,
    )
    expect((await call('POST', '/v0/updates/run', who, {})).status).toBe(403)
    expect((await call('POST', '/v0/updates/upgrade', who, {})).status).toBe(
      403,
    )
    expect((await call('POST', '/v0/updates/rollback', who, {})).status).toBe(
      403,
    )
  }
  expect(port.calls).toEqual([])
  expect(admits).toBe(0)
})

test('save and run are admitted and recorded', async () => {
  const ops = access('ops')
  const saved = await call('POST', '/v0/updates', ops, {
    times: [{ kind: 'weekly', days: [1, 4], time: '09:30' }],
    timezone: 'Asia/Tokyo',
    actions: { qianmopi: 'auto', qianmo: 'auto' },
    channels: [],
    repo: null,
  })
  expect(saved.status).toBe(200)
  const value = (await saved.json()) as UpdatesSnapshot
  expect(value.sources.find(one => one.id === 'qianmopi')?.action).toBe('auto')
  expect(value.sources.find(one => one.id === 'qianmo')?.action).toBe('notify')
  const run = await call('POST', '/v0/updates/run', ops, {})
  expect(((await run.json()) as UpdatesSnapshot).running).toBe(true)
  expect((await call('GET', '/v0/updates/run', ops)).status).toBe(405)
  expect((await call('DELETE', '/v0/updates', ops)).status).toBe(405)
  expect((await call('GET', '/v0/updates/x', ops)).status).toBe(404)
  expect(admits).toBe(2)
  expect(records).toEqual(['updates.save updates', 'updates.run updates'])
  expect(port.calls).toEqual(['save 1', 'run'])
})

test('upgrade and rollback take an optional exact version', async () => {
  const ops = access('ops')
  expect((await call('POST', '/v0/updates/upgrade', ops, {})).status).toBe(200)
  expect(
    (await call('POST', '/v0/updates/upgrade', ops, { version: '3.0.2' }))
      .status,
  ).toBe(200)
  expect((await call('POST', '/v0/updates/rollback', ops, {})).status).toBe(200)
  expect(
    (await call('POST', '/v0/updates/rollback', ops, { version: 'latest' }))
      .status,
  ).toBe(400)
  expect(
    (await call('POST', '/v0/updates/rollback', ops, { version: '3.0.0' }))
      .status,
  ).toBe(200)
  expect(port.calls).toEqual([
    'upgrade latest',
    'upgrade 3.0.2',
    'rollback backup',
    'rollback 3.0.0',
  ])
  expect(records).toEqual([
    'updates.upgrade updates',
    'updates.upgrade updates',
    'updates.rollback updates',
    'updates.rollback updates',
  ])
})

test('without an updates port the API says so', async () => {
  const { updates: _gone, ...rest } = deps
  deps = rest
  expect((await call('GET', '/v0/updates', access('ops'))).status).toBe(501)
})
