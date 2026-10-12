// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { resolveAccess } from '../src/access.js'
import { routingApi } from '../src/routes/routingApi.js'
import { headIndex } from '../src/routes/index.js'
import type { RouteContext, RouteModule } from '../src/routes/types.js'
import type { ConsoleDeps } from '../src/deps.js'
import type {
  ModelRoutingPort,
  ModelRoutingView,
  DirectionActor,
} from '../src/directionPorts.js'
import {
  accountsHarness,
  person,
  TOKENS,
  VIEW,
  ADMIN,
} from './accountsHarness.js'
const view: ModelRoutingView = {
  node: null,
  auto: false,
  routes: [],
  revision: 0,
  updatedAt: null,
  updatedBy: null,
}
async function setup() {
  const h = accountsHarness()
  const users = {
    viewer: await person(h.handle, 'viewer'),
    member: await person(h.handle, 'member'),
    ops: await person(h.handle, 'ops'),
  }
  const calls: string[] = []
  const actors: DirectionActor[] = []
  const port: ModelRoutingPort = {
    async snapshot() {
      calls.push('read')
      return {
        ok: true,
        value: { defaults: view, nodes: [], models: [], recent: [] },
      }
    },
    async save(input, actor) {
      calls.push('save')
      actors.push(actor)
      return { ok: true, value: { ...view, ...input } }
    },
    async clearNode(node, actor) {
      calls.push('clear')
      actors.push(actor)
      return { ok: true, value: { ...view, node } }
    },
  }
  const module: RouteModule = {
    area: {
      id: 'providers',
      label: 'Routing',
      group: 'main',
      href: '/admin/providers',
      icon: 'info',
    },
    api: routingApi,
  }
  const handler = headIndex([module], m => m.api).get('routing')!
  const send = async (
    method: string,
    token: string,
    body?: unknown,
    rest: string[] = [],
    admitted = true,
    wired = true,
  ) => {
    const request = new Request('http://console.test/v0/routing', {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const ctx: RouteContext = {
      request,
      url: new URL(request.url),
      deps: { ...(wired ? { routing: port } : {}) } as ConsoleDeps,
      access: resolveAccess(request, TOKENS, { book: h.book }),
      accounts: { book: h.book },
      now: 1,
      viewer: undefined,
      requestId: 'request-test',
      async roster() {
        return { ok: true, value: [] }
      },
      async admit() {
        calls.push('admit')
        return admitted ? null : new Response(null, { status: 503 })
      },
      async record() {
        throw new Error('route must not duplicate port audit')
      },
    }
    return handler.handle(ctx, 'routing', rest)
  }
  return { send, users, calls, actors }
}
const input = {
  node: null,
  auto: true,
  routes: [{ direction: 'chat', profileId: 'chat', modelId: 'model' }],
  revision: 0,
}
test('viewers and members can read, but cannot save or clear; legacy view also rejects writes', async () => {
  const h = await setup()
  for (const token of [
    VIEW,
    h.users.viewer.credential,
    h.users.member.credential,
  ]) {
    expect((await h.send('GET', token)).status).toBe(200)
    expect((await h.send('PUT', token, input)).status).toBe(403)
    expect(
      (await h.send('DELETE', token, undefined, ['nodes', 'node-a'])).status,
    ).toBe(403)
  }
  expect(h.calls).toEqual(['read', 'read', 'read'])
})
test('a personal ops account writes, admitted first, as itself; the shared admin token only reads', async () => {
  const h = await setup()
  const ops = h.users.ops.credential
  expect((await h.send('PUT', ops, input)).status).toBe(200)
  expect(
    (await h.send('DELETE', ops, undefined, ['nodes', 'node-a'])).status,
  ).toBe(200)
  expect(h.calls).toEqual(['admit', 'save', 'admit', 'clear'])
  expect(h.actors[0]).toMatchObject({ role: 'ops', requestId: 'request-test' })
  // A route ships another service's credentials to the nodes: the 模型服务
  // rule, not the admin token.
  expect((await h.send('GET', ADMIN)).status).toBe(200)
  expect((await h.send('PUT', ADMIN, input)).status).toBe(403)
  expect(
    (await h.send('DELETE', ADMIN, undefined, ['nodes', 'node-a'])).status,
  ).toBe(403)
  expect(h.calls).toEqual(['admit', 'save', 'admit', 'clear', 'read'])
})
test('ledger refusal prevents mutation, unwired port is 501 and fields remain closed', async () => {
  const h = await setup()
  const ADMIN = h.users.ops.credential
  expect((await h.send('PUT', ADMIN, input, [], false)).status).toBe(503)
  expect(h.calls).toEqual(['admit'])
  expect((await h.send('GET', VIEW, undefined, [], true, false)).status).toBe(
    501,
  )
  for (const patch of [
    { unknown: 1 },
    { routes: [{ direction: 'dance', profileId: null, modelId: null }] },
    { routes: [{ direction: 'chat', profileId: null, modelId: 'model' }] },
  ])
    expect((await h.send('PUT', ADMIN, { ...input, ...patch })).status).toBe(
      400,
    )
  expect(h.calls).toEqual(['admit'])
})
