// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/v0/extensions` (P32): everyone with view sees what is installed and
 * where, only ops see commands, addresses and skill text, nobody sees secret
 * values, and only a personal ops account (not break-glass) changes anything
 * — guard and admission before any effect.
 */

import { beforeEach, expect, test } from 'bun:test'
import type { Access } from '../src/access.js'
import type { ConsoleDeps } from '../src/deps.js'
import type {
  ExtensionsSnapshot,
  ExtensionView,
} from '../src/directionPorts.js'
import type { RouteContext } from '../src/routes/types.js'
import { extensionsApi } from '../src/routes/extensionsApi.js'
import { LIMITS } from './accountsHarness.js'
import { FakeExtensions } from './directionFakes.js'

const NOW = 1_700_000_000_000
let port: FakeExtensions
let admits: number
let records: string[]
let deps: ConsoleDeps
const denied = {
  ok: false as const,
  failure: { code: 'unsupported' as const, message: 'unused' },
}

beforeEach(() => {
  port = new FakeExtensions()
  admits = 0
  records = []
  deps = {
    limits: LIMITS,
    extensions: port,
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
  return extensionsApi.handle(
    ctx,
    'extensions',
    path.split('/').filter(Boolean).slice(2),
  )
}

test('view reads what is installed; only ops see how', async () => {
  for (const role of ['view', 'admin', 'viewer', 'member', 'ops'] as const) {
    const response = await call('GET', '/v0/extensions', access(role))
    expect(response.status).toBe(200)
    const snapshot = (await response.json()) as ExtensionsSnapshot
    const ops = role === 'admin' || role === 'ops'
    const docs = snapshot.extensions.find(one => one.name === 'docs')!
    expect(docs.nodes.map(node => node.state)).toEqual(['applied', 'failed'])
    expect(`${role} ${docs.command}`).toBe(`${role} ${ops ? 'docs-mcp' : null}`)
    expect(`${role} ${docs.envKeys.length}`).toBe(`${role} ${ops ? 1 : 0}`)
    const skill = snapshot.extensions.find(one => one.kind === 'skill')!
    expect(`${role} ${skill.body !== null}`).toBe(`${role} ${ops}`)
  }
  expect((await call('GET', '/v0/extensions', access('none'))).status).toBe(401)
  expect(admits).toBe(0)
})

test('only a personal ops account saves or removes; nothing happens before the guard', async () => {
  for (const who of [
    access('view'),
    access('admin'),
    access('viewer'),
    access('member'),
    access('ops', true),
  ]) {
    expect(
      (await call('POST', '/v0/extensions', who, { kind: 'mcp', name: 'x' }))
        .status,
    ).toBe(403)
    expect(
      (await call('DELETE', `/v0/extensions/${port.entries[0]!.id}`, who))
        .status,
    ).toBe(403)
  }
  expect(port.calls).toEqual([])
  expect(admits).toBe(0)
})

test('save, switch and remove are admitted and recorded by id', async () => {
  const ops = access('ops')
  const id = port.entries[0]!.id
  const saved = await call('POST', '/v0/extensions', ops, {
    kind: 'mcp',
    name: 'search',
    command: 'search-mcp',
    env: { KEY: 'value' },
  })
  expect(saved.status).toBe(200)
  const view = (await saved.json()) as ExtensionView
  expect(view.envKeys).toEqual(['KEY'])
  expect(JSON.stringify(view)).not.toContain('value"')
  const off = await call('POST', '/v0/extensions', ops, { id, enabled: false })
  expect(((await off.json()) as ExtensionView).enabled).toBe(false)
  expect(
    (await call('POST', '/v0/extensions', ops, { kind: 'mcp', name: 'Bad' }))
      .status,
  ).toBe(400)
  expect((await call('DELETE', `/v0/extensions/${id}`, ops)).status).toBe(204)
  expect((await call('PUT', '/v0/extensions', ops)).status).toBe(405)
  expect((await call('GET', '/v0/extensions/a/b', ops)).status).toBe(404)
  expect(records).toEqual([
    'extension.save new',
    `extension.save ${id}`,
    'extension.save new',
    `extension.remove ${id}`,
  ])
})

test('without an extensions port the API says so', async () => {
  const { extensions: _gone, ...rest } = deps
  deps = rest
  expect((await call('GET', '/v0/extensions', access('ops'))).status).toBe(501)
})
