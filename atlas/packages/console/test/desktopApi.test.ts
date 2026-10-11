// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { scopedConsoleDeps, tenantRequestDenial } from '../src/tenantScope.js'
import type { TenantConfig } from '../src/tenancy.js'
import { resolveAccess } from '../src/access.js'
import { desktopApi } from '../src/routes/desktopApi.js'
import type { RouteContext } from '../src/routes/types.js'
import type { ConsoleDeps } from '../src/deps.js'
import type {
  DesktopPort,
  DesktopNodeView,
  DirectionActor,
} from '../src/directionPorts.js'
import {
  accountsHarness,
  person,
  TOKENS,
  VIEW,
  ADMIN,
} from './accountsHarness.js'
const view: DesktopNodeView = {
  node: 'worker',
  agent: 'main',
  reachable: true,
  platform: 'darwin',
  browser: {
    enabled: false,
    state: 'off',
    profileBytes: 0,
    startedAt: null,
    reason: null,
  },
  computer: {
    enabled: false,
    supported: false,
    state: 'off',
    display: null,
    reason: null,
  },
  confirm: 'sensitive',
  lastActionAt: null,
  actions24h: 0,
  confirmed24h: 0,
}
async function setup() {
  const h = accountsHarness()
  const users = {
    viewer: await person(h.handle, 'viewer'),
    member: await person(h.handle, 'member'),
    ops: await person(h.handle, 'ops'),
  }
  const calls: unknown[] = [],
    actors: DirectionActor[] = []
  const port: DesktopPort = {
    async list() {
      calls.push('list')
      return { ok: true, value: [view] }
    },
    async set(ref, change, actor) {
      calls.push(['set', ref, change])
      actors.push(actor)
      return { ok: true, value: view }
    },
    async recycle(ref, actor) {
      calls.push(['recycle', ref])
      actors.push(actor)
      return { ok: true, value: view }
    },
    async actions(ref, limit) {
      calls.push(['actions', ref, limit])
      return { ok: true, value: [] }
    },
  }
  const send = async (
    method: string,
    token: string,
    path = '',
    body?: unknown,
    admitted = true,
    wired = true,
  ) => {
    const request = new Request(`http://console.test/v0/desktop${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const ctx: RouteContext = {
      request,
      url: new URL(request.url),
      deps: { ...(wired ? { desktop: port } : {}) } as ConsoleDeps,
      access: resolveAccess(request, TOKENS, { book: h.book }),
      accounts: { book: h.book },
      now: 1,
      viewer: undefined,
      requestId: 'desktop-request',
      async roster() {
        return { ok: true, value: [] }
      },
      async admit() {
        calls.push('admit')
        return admitted ? null : new Response(null, { status: 503 })
      },
      async record() {
        throw new Error('API must not duplicate the port ledger')
      },
    }
    return desktopApi.handle(
      ctx,
      'desktop',
      ctx.url.pathname.split('/').slice(3).filter(Boolean),
    )
  }
  return { send, users, calls, actors, port, book: h.book }
}
test('desktop reads accept view/member, mutations require ops before any admission or port call', async () => {
  const h = await setup()
  for (const token of [
    VIEW,
    h.users.viewer.credential,
    h.users.member.credential,
  ]) {
    expect((await h.send('GET', token)).status).toBe(200)
    expect(
      (
        await h.send(
          'GET',
          token,
          '/actions?agent=qianmo://worker/main&limit=7',
        )
      ).status,
    ).toBe(200)
    expect(
      (await h.send('PUT', token, '/worker/main', { browser: true })).status,
    ).toBe(403)
    expect((await h.send('POST', token, '/worker/main/recycle')).status).toBe(
      403,
    )
  }
  expect(h.calls.filter(c => c === 'admit')).toEqual([])
})
test('desktop ops writes are admitted first and preserve actor; failure admission has zero port calls', async () => {
  const h = await setup()
  expect(
    (
      await h.send('PUT', h.users.ops.credential, '/worker/main', {
        browser: true,
        confirm: 'always',
      })
    ).status,
  ).toBe(200)
  expect(h.calls).toEqual([
    'admit',
    [
      'set',
      { node: 'worker', agent: 'main' },
      { browser: true, confirm: 'always' },
    ],
  ])
  const principal = h.book.bearerPrincipal(h.users.ops.credential)
  if (!principal.ok) throw new Error('fixture principal unavailable')
  expect(h.actors[0]).toMatchObject({
    subject: principal.value.subject,
    role: 'ops',
    requestId: 'desktop-request',
  })
  expect((await h.send('POST', ADMIN, '/worker/main/recycle')).status).toBe(200)
  const count = h.actors.length
  expect(
    (
      await h.send(
        'PUT',
        h.users.ops.credential,
        '/worker/main',
        { browser: false },
        false,
      )
    ).status,
  ).toBe(503)
  expect(h.actors.length).toBe(count)
})
test('invalid schemas, addresses, query bounds, methods and absent wiring fail before writes', async () => {
  const h = await setup()
  for (const body of [
    {},
    { browser: 1 },
    { computer: null },
    { confirm: 'never' },
    { browser: true, code: '1' },
    [],
  ])
    expect((await h.send('PUT', ADMIN, '/worker/main', body)).status).toBe(400)
  for (const query of [
    'limit=0',
    'limit=201',
    'limit=1.5',
    'limit=NaN',
    'agent=qianmo://worker/../main',
    'agent=invalid',
  ])
    expect((await h.send('GET', VIEW, `/actions?${query}`)).status).toBe(400)
  expect(
    (await h.send('PUT', ADMIN, '/worker/%2Fmain', { browser: true })).status,
  ).toBe(400)
  expect((await h.send('DELETE', ADMIN, '/worker/main')).status).toBe(405)
  expect((await h.send('GET', VIEW, '', undefined, true, false)).status).toBe(
    501,
  )
  expect(h.calls).toEqual([])
})
test('desktop API is mounted on the real HTTP dispatcher', async () => {
  const h = await setup(),
    app = accountsHarness({ deps: { desktop: h.port } })
  const r = await app.handle(
    new Request('http://console.test/v0/desktop', {
      headers: { authorization: `Bearer ${VIEW}` },
    }),
  )
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual([view])
})

test('tenant desktop lists/actions filter both scopes; cross-scope writes and waiting revocation have zero effects', async () => {
  const h = await setup()
  const principal = h.book.bearerPrincipal(h.users.ops.credential)
  if (!principal.ok) throw new Error('fixture principal')
  const config: TenantConfig = {
    version: 1,
    hubServer: 'hub',
    tenants: [{ id: 'a' }, { id: 'b' }],
    subjects: [{ subject: principal.value.subject, tenant: 'a' }],
    platformSubjects: [],
    jobs: [],
    nodes: [
      { nodeId: 'worker', tenant: 'a', server: 'a', memoryRoot: '/data/a' },
      { nodeId: 'foreign', tenant: 'b', server: 'b', memoryRoot: '/data/b' },
    ],
  }
  let revision = '1',
    release: (() => void) | undefined
  const port: DesktopPort = {
    ...h.port,
    async list() {
      await new Promise<void>(r => {
        release = r
      })
      return { ok: true, value: [view, { ...view, node: 'foreign' }] }
    },
    async actions() {
      return {
        ok: true,
        value: ['worker', 'foreign'].map(node => ({
          node,
          agent: 'main',
          at: 1,
          unit: 'browser' as const,
          op: 'screenshot',
          host: null,
          outcome: 'allowed' as const,
        })),
      }
    },
  }
  const request = new Request('http://console.test/v0/desktop/foreign/main', {
    method: 'PUT',
    headers: { authorization: `Bearer ${h.users.ops.credential}` },
  })
  const deps = {
    desktop: port,
    tenancy: { read: () => ({ config, revision }), subscribe: () => () => {} },
  } as unknown as ConsoleDeps
  const access = resolveAccess(request, TOKENS, { book: h.book })
  const scoped = scopedConsoleDeps(deps, access)
  const listing = scoped.deps.desktop!.list()
  release!()
  const listed = await listing
  expect(listed.ok && listed.value.map(v => v.node)).toEqual(['worker'])
  const actions = await scoped.deps.desktop!.actions(null, 50)
  expect(actions.ok && actions.value.map(v => v.node)).toEqual(['worker'])
  expect(
    (
      await scoped.deps.desktop!.set(
        { node: 'foreign', agent: 'main' },
        { browser: true },
        { subject: principal.value.subject, role: 'ops', requestId: 'r' },
      )
    ).ok,
  ).toBe(false)
  expect(
    (
      await tenantRequestDenial(
        request,
        new URL(request.url),
        scoped.deps,
        scoped.scope,
      )
    )?.status,
  ).toBe(404)
  expect(h.calls).toEqual([])
  const pending = scoped.deps.desktop!.list()
  revision = '2'
  release!()
  const revoked = await pending
  expect(revoked.ok && revoked.value).toEqual([])
  expect(
    (
      await scoped.deps.desktop!.recycle(
        { node: 'worker', agent: 'main' },
        { subject: principal.value.subject, role: 'ops', requestId: 'r' },
      )
    ).ok,
  ).toBe(false)
  expect(h.calls).toEqual([])
  revision = '1'
  let effects = 0,
    proceed: (() => void) | undefined
  const waiting = scopedConsoleDeps(
    {
      ...deps,
      desktop: {
        ...port,
        async set(ref, _change, actor) {
          await new Promise<void>(r => {
            proceed = r
          })
          actor.beforeDispatch?.()
          effects++
          return { ok: true as const, value: { ...view, ...ref } }
        },
      },
    },
    access,
  ).deps.desktop!
  const mutation = waiting.set(
    { node: 'worker', agent: 'main' },
    { browser: true },
    { subject: principal.value.subject, role: 'ops', requestId: 'wait' },
  )
  revision = '2'
  proceed!()
  await expect(mutation).rejects.toThrow('E_AUTH_REVOKED')
  expect(effects).toBe(0)
})
