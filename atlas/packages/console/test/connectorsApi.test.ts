// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, expect, test } from 'bun:test'
import type { Access } from '../src/access.js'
import type { ConsoleDeps } from '../src/deps.js'
import type {
  ConnectorDraft,
  ConnectorView,
  ConnectorsPort,
} from '../src/directionPorts.js'
import { connectorsApi } from '../src/routes/connectorsApi.js'
import { createConsoleHandler } from '../src/http.js'
import type { RouteContext } from '../src/routes/types.js'
import { scopedConsoleDeps, tenantRequestDenial } from '../src/tenantScope.js'
import type { TenantConfig } from '../src/tenancy.js'
import { LIMITS, TOKENS } from './accountsHarness.js'

const connection = (
  id = 'one',
  tenant: string | null = null,
  agent = 'worker',
): ConnectorView => ({
  id,
  tenant,
  revision: 1,
  name: 'Fixture',
  kind: 'mail',
  preset: 'custom-mail',
  summary: { account: 'us***@example.com' },
  readOnly: false,
  secretSet: true,
  secretSetAt: 1,
  agents: [`qianmo://${agent}/main`],
  evaluated: false,
  lastProbe: null,
  createdAt: 1,
  createdBy: 'u:0123456789abcdef',
})
let calls: string[],
  admits: number,
  records: string[],
  blocked: boolean,
  failure: boolean
let deps: ConsoleDeps
const port: ConnectorsPort = {
  async snapshot() {
    calls.push('snapshot')
    return {
      ok: true,
      value: {
        connectors: [connection()],
        presets: [],
        recent: [],
        agents: ['qianmo://worker/main'],
      },
    }
  },
  async save(draft, actor) {
    calls.push('save')
    expect(admits).toBe(1)
    expect(actor.role).toBe('ops')
    expect(draft.secret).toBe('hidden-password')
    return failure
      ? { ok: false, failure: { code: 'invalid', message: 'invalid input' } }
      : { ok: true, value: connection() }
  },
  async remove(id) {
    calls.push(`remove:${id}`)
    return { ok: true, value: null }
  },
  async probe(id) {
    calls.push(`probe:${id}`)
    return { ok: true, value: connection() }
  },
}
const denied = {
  ok: false as const,
  failure: { code: 'unsupported' as const, message: 'unused' },
}
beforeEach(() => {
  calls = []
  admits = 0
  records = []
  blocked = false
  failure = false
  deps = {
    limits: LIMITS,
    connectors: port,
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
  cookie = false,
  header = true,
): Access {
  const personal = ['viewer', 'member', 'ops'].includes(role)
  return {
    credential: {
      role: personal
        ? role === 'ops'
          ? 'admin'
          : 'view'
        : (role as 'none' | 'view' | 'admin'),
      source: cookie ? 'cookie' : 'bearer',
      header,
      crossOrigin: false,
    },
    principal:
      role === 'none'
        ? null
        : personal
          ? {
              kind: 'user',
              subject: 'u:0123456789abcdef',
              role: role as 'viewer' | 'member' | 'ops',
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
function context(
  method: string,
  path: string,
  who: Access,
  body?: string,
): RouteContext {
  const request = new Request(`http://console.test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { body, headers: { 'content-type': 'application/json' } }),
  })
  return {
    request,
    url: new URL(request.url),
    deps,
    access: who,
    accounts: undefined,
    now: 1,
    viewer: undefined,
    requestId: 'request',
    roster: () => deps.registry.list(),
    admit: async () => {
      admits++
      return blocked ? new Response(null, { status: 503 }) : null
    },
    record: async action => {
      records.push(action)
      return true
    },
  }
}
async function request(
  method: string,
  path: string,
  who: Access,
  body?: string,
) {
  const ctx = context(method, path, who, body)
  return connectorsApi.handle(
    ctx,
    'connectors',
    path.split('/').filter(Boolean).slice(2),
  )
}
test('connectors API is registered; authenticated view reads, anonymous cannot', async () => {
  const realHttp = createConsoleHandler(deps, TOKENS)
  expect(
    (
      await realHttp(
        new Request('http://console.test/v0/connectors', {
          headers: { authorization: `Bearer ${TOKENS.view}` },
        }),
      )
    ).status,
  ).toBe(200)
  for (const role of ['view', 'admin', 'viewer', 'member', 'ops'] as const) {
    const result = await request('GET', '/v0/connectors', access(role))
    expect(result.status).toBe(200)
    expect(
      ((await result.json()) as { connectors: ConnectorView[] }).connectors[0]!
        .evaluated,
    ).toBe(false)
  }
  expect((await request('GET', '/v0/connectors', access('none'))).status).toBe(
    401,
  )
  expect(admits).toBe(0)
})
test('only personal ops can save/delete/probe; guard and admission precede effects', async () => {
  for (const who of [
    access('view'),
    access('admin'),
    access('viewer'),
    access('member'),
    access('ops', true),
    access('ops', false, true, false),
  ]) {
    expect((await request('POST', '/v0/connectors', who, '{}')).status).toBe(
      403,
    )
    expect((await request('DELETE', '/v0/connectors/one', who)).status).toBe(
      403,
    )
    expect(
      (await request('POST', '/v0/connectors/one/probe', who)).status,
    ).toBe(403)
  }
  expect(calls).toEqual([])
  expect(admits).toBe(0)
  blocked = true
  expect(
    (await request('POST', '/v0/connectors', access('ops'), '{}')).status,
  ).toBe(503)
  expect(calls).toEqual([])
  blocked = false
  admits = 0
  expect(
    (
      await request(
        'POST',
        '/v0/connectors',
        access('ops'),
        JSON.stringify({ name: 'Fixture', secret: 'hidden-password' }),
      )
    ).status,
  ).toBe(200)
  expect(records).toEqual(['connector.save'])
  expect(
    (await request('DELETE', '/v0/connectors/one', access('ops'))).status,
  ).toBe(204)
  expect(
    (await request('POST', '/v0/connectors/one/probe', access('ops'))).status,
  ).toBe(200)
})
test('malformed bodies, methods, unavailable ports and failure shapes are mapped without effects', async () => {
  expect(
    (await request('POST', '/v0/connectors', access('ops'), 'not-json')).status,
  ).toBe(400)
  expect(admits).toBe(0)
  expect((await request('PUT', '/v0/connectors', access('ops'))).status).toBe(
    405,
  )
  expect(
    (await request('POST', '/v0/connectors/one/unknown', access('ops'))).status,
  ).toBe(404)
  failure = true
  expect(
    (
      await request(
        'POST',
        '/v0/connectors',
        access('ops'),
        JSON.stringify({ secret: 'hidden-password' }),
      )
    ).status,
  ).toBe(400)
  deps = { ...deps, connectors: undefined }
  expect((await request('GET', '/v0/connectors', access('view'))).status).toBe(
    501,
  )
})
test('tenant wrapper filters ownership, calls and agents; refuses foreign writes before admission and fails closed on revision change', async () => {
  let revision = '1'
  const config: TenantConfig = {
    version: 1,
    hubServer: 'hub',
    tenants: [{ id: 'a' }, { id: 'b' }],
    subjects: [{ subject: 'u:0123456789abcdef', tenant: 'a' }],
    platformSubjects: [],
    nodes: [
      { nodeId: 'worker', tenant: 'a', server: 'sa', memoryRoot: '/a' },
      { nodeId: 'other', tenant: 'b', server: 'sb', memoryRoot: '/b' },
    ],
    jobs: [],
  }
  let saved: ConnectorDraft | undefined
  const original = {
    ...deps,
    tenancy: { read: () => ({ revision, config }), subscribe: () => () => {} },
    connectors: {
      ...port,
      snapshot: async () => ({
        ok: true as const,
        value: {
          connectors: [
            connection('one', 'a'),
            connection('foreign', 'b', 'other'),
          ],
          presets: [],
          recent: [
            {
              at: 1,
              connectorId: 'foreign',
              agent: 'qianmo://other/main',
              op: 'mail.send',
              outcome: 'ok' as const,
              count: 1,
              detail: null,
            },
          ],
          agents: ['qianmo://worker/main', 'qianmo://other/main'],
        },
      }),
      save: async (draft: ConnectorDraft) => {
        saved = draft
        return { ok: true as const, value: connection('new', 'a') }
      },
    },
  }
  const scoped = scopedConsoleDeps(original, access('ops'))
  deps = scoped.deps
  const listing = await deps.connectors!.snapshot()
  expect(listing.ok && listing.value.connectors.map(v => v.id)).toEqual(['one'])
  expect(listing.ok && listing.value.recent).toEqual([])
  expect(listing.ok && listing.value.agents).toEqual(['qianmo://worker/main'])
  const ctx = context(
    'POST',
    '/v0/connectors',
    access('ops'),
    JSON.stringify({ id: 'foreign', agents: ['qianmo://worker/main'] }),
  )
  expect(
    (await tenantRequestDenial(ctx.request, ctx.url, deps, scoped.scope))
      ?.status,
  ).toBe(404)
  expect(admits).toBe(0)
  const foreign = await deps.connectors!.probe('foreign', {
    subject: 'u:0123456789abcdef',
    role: 'ops',
    requestId: 'r',
  })
  expect(foreign.ok).toBe(false)
  expect(calls).not.toContain('probe:foreign')
  const draft: ConnectorDraft = {
    name: 'Scoped',
    kind: 'mail',
    preset: 'custom-mail',
    settings: {},
    agents: ['qianmo://worker/main'],
  }
  expect(
    (
      await deps.connectors!.save(
        { ...draft, agents: ['qianmo://other/main'] },
        { subject: 'u:0123456789abcdef', role: 'ops', requestId: 'r' },
      )
    ).ok,
  ).toBe(false)
  expect(
    (
      await deps.connectors!.save(draft, {
        subject: 'u:0123456789abcdef',
        role: 'ops',
        requestId: 'r',
      })
    ).ok,
  ).toBe(true)
  expect(saved?.tenant).toBe('a')
  revision = '2'
  expect((await deps.connectors!.snapshot()).ok).toBe(false)
  expect(
    (
      await deps.connectors!.probe('one', {
        subject: 'u:0123456789abcdef',
        role: 'ops',
        requestId: 'r',
      })
    ).ok,
  ).toBe(false)
})
