// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  ConnectorDraft,
  ConsoleResult,
  DirectionActor,
  TenantConfig,
  TenantPort,
} from '@qianmo/console'
import { generateNodeKeyPair } from '@qianmo/capability'
import {
  ConsoleConnectors,
  type ConsoleConnectorsOptions,
} from '../../src/commands/consoleConnectors.js'
import { OutboundPolicy } from '../../src/commands/outboundPolicy.js'
import { parseConsoleArgs } from '../../src/commands/consoleArgs.js'
import { connectorTools } from '../../src/host/connectorTools.js'
import {
  accountsHarness,
  person,
  asBearer,
  ADMIN,
} from '../../../console/test/accountsHarness.js'

const TOKEN = 'p26c-secret-canary-token-0123456789'
const actor: DirectionActor = {
  subject: 'u:0123456789abcdef',
  role: 'ops',
  requestId: 'repo-test',
}
const foreign: DirectionActor = { ...actor, subject: 'u:fedcba9876543210' }
const draft: ConnectorDraft = {
  name: 'Relay',
  kind: 'repo',
  preset: 'github-repo',
  settings: { repo: 'owner/demo', exchange: false },
  secret: TOKEN,
  agents: [],
}
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean()
})
function value<T>(result: ConsoleResult<T>): T {
  if (!result.ok) throw new Error(result.failure.message)
  return result.value
}
function fixture(options: Partial<ConsoleConnectorsOptions> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p26c-book-'))
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }))
  const config = {
    directory,
    agents: async () => ['qianmo://worker/main'],
    policy: new OutboundPolicy({
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    }),
    ...options,
  }
  const book = new ConsoleConnectors(config)
  cleanups.push(() => book.close())
  return { directory, book, config }
}
function scan(directory: string): string {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .map(entry => {
      const file = path.join(directory, entry.name)
      return entry.isDirectory() ? scan(file) : fs.readFileSync(file, 'utf8')
    })
    .join('\n')
}
function tenants(): { tenancy: TenantPort; config: TenantConfig } {
  const config: TenantConfig = {
    version: 1,
    hubServer: 'hub',
    tenants: [{ id: 'a' }, { id: 'b' }],
    subjects: [
      { subject: actor.subject, tenant: 'a' },
      { subject: foreign.subject, tenant: 'b' },
    ],
    platformSubjects: [],
    nodes: [{ nodeId: 'worker', tenant: 'a', server: 'a', memoryRoot: '/a' }],
    jobs: [],
  }
  return {
    config,
    tenancy: {
      read: () => ({ revision: '1', config }),
      subscribe: () => () => {},
    },
  }
}

test('repo CRUD preserves omitted secrets, rotates on demand and keeps deletion/rename precedence across restarts', async () => {
  let fallbackReads = 0
  const f = fixture({
    fallbackRepoCredentials: {
      async resolve(repo) {
        fallbackReads++
        return {
          remoteUrl: `https://github.com/${repo}.git`,
          token: 'legacy-token',
        }
      },
    },
  })
  const created = value(await f.book.save(draft, actor))
  expect(created.repo).toEqual({
    name: 'owner/demo',
    exchange: false,
    private: null,
    push: null,
  })
  expect(await f.book.resolve('OWNER/DEMO')).toEqual({
    remoteUrl: 'https://github.com/owner/demo.git',
    token: TOKEN,
  })
  const { secret: _secret, ...edit } = draft
  const updated = value(
    await f.book.save({ ...edit, id: created.id, name: 'Renamed' }, actor),
  )
  expect(updated.revision).toBe(2)
  expect((await f.book.resolve('owner/demo'))?.token).toBe(TOKEN)
  value(
    await f.book.save(
      { ...edit, id: created.id, secret: `${TOKEN}-rotated` },
      actor,
    ),
  )
  expect((await f.book.resolve('owner/demo'))?.token).toBe(`${TOKEN}-rotated`)
  value(
    await f.book.save(
      { ...edit, id: created.id, settings: { repo: 'owner/new' } },
      actor,
    ),
  )
  expect(await f.book.resolve('owner/demo')).toBeNull()
  value(await f.book.remove(created.id, actor))
  expect(value(await f.book.snapshot()).connectors).toEqual([])
  f.book.close()
  const reopened = new ConsoleConnectors(f.config)
  cleanups.push(() => reopened.close())
  expect(await reopened.resolve('owner/new')).toBeNull()
  expect(await reopened.resolve('owner/demo')).toBeNull()
  expect(fallbackReads).toBe(0)
  expect((await reopened.resolve('owner/legacy'))?.token).toBe('legacy-token')
  expect(fallbackReads).toBe(1)
  expect(scan(f.directory)).not.toContain(TOKEN)
})

test('bad coordinates, duplicate repos, exchange collisions and agent authorization are rejected without partial writes', async () => {
  const { book } = fixture()
  for (const repo of [
    'owner/..',
    'owner/a..b',
    'owner/demo.git',
    'https://github.com/owner/demo',
    'a/b/c',
    'owner/with space',
  ])
    expect((await book.save({ ...draft, settings: { repo } }, actor)).ok).toBe(
      false,
    )
  expect(
    (await book.save({ ...draft, agents: ['qianmo://worker/main'] }, actor)).ok,
  ).toBe(false)
  expect(
    (
      await book.save(
        { ...draft, settings: { repo: 'owner/demo', exchange: 'true' } },
        actor,
      )
    ).ok,
  ).toBe(false)
  expect(
    (
      await book.save(
        { ...draft, settings: { repo: 'owner/demo', token: TOKEN } },
        actor,
      )
    ).ok,
  ).toBe(false)
  const created = value(
    await book.save(
      { ...draft, settings: { repo: 'owner/demo', exchange: true } },
      actor,
    ),
  )
  expect(
    (await book.save({ ...draft, settings: { repo: 'OWNER/DEMO' } }, actor)).ok,
  ).toBe(false)
  expect(
    (
      await book.save(
        { ...draft, settings: { repo: 'owner/second', exchange: true } },
        actor,
      )
    ).ok,
  ).toBe(false)
  const second = value(
    await book.save({ ...draft, settings: { repo: 'owner/second' } }, actor),
  )
  expect(
    (
      await book.save(
        { ...draft, id: second.id, settings: { exchange: true } },
        actor,
      )
    ).ok,
  ).toBe(false)
  value(
    await book.save(
      { ...draft, id: created.id, settings: { exchange: false } },
      actor,
    ),
  )
  expect(
    value(
      await book.save(
        { ...draft, id: second.id, settings: { exchange: true } },
        actor,
      ),
    ).repo?.exchange,
  ).toBe(true)
  const concurrent = await Promise.all([
    book.save({ ...draft, settings: { repo: 'owner/race' } }, actor),
    book.save({ ...draft, settings: { repo: 'owner/race' } }, actor),
  ])
  expect(concurrent.filter(row => row.ok)).toHaveLength(1)
})

for (const c of [
  {
    name: 'private push',
    status: 200,
    body: { private: true, permissions: { push: true } },
    exchange: true,
    ok: true,
    detail: '仓库可读写（未评估）',
    private: true,
    push: true,
  },
  {
    name: 'public relay',
    status: 200,
    body: { private: false, permissions: { push: true } },
    exchange: false,
    ok: true,
    detail: '仓库可读写（未评估）',
    private: false,
    push: true,
  },
  {
    name: 'public exchange',
    status: 200,
    body: { private: false, permissions: { push: true } },
    exchange: true,
    ok: false,
    detail: '文件交换仓库必须私有',
    private: false,
    push: true,
  },
  {
    name: 'no push',
    status: 200,
    body: { private: true, permissions: { push: false } },
    exchange: false,
    ok: false,
    detail: '令牌没有写权限',
    private: true,
    push: false,
  },
  {
    name: 'missing permissions',
    status: 200,
    body: { private: true },
    exchange: false,
    ok: false,
    detail: '令牌没有写权限',
    private: true,
    push: false,
  },
  ...[401, 403, 404, 500, 302].map(status => ({
    name: `HTTP ${status}`,
    status,
    body: { message: TOKEN },
    exchange: false,
    ok: false,
    detail: [401, 403].includes(status)
      ? '令牌无效或没有权限'
      : status === 404
        ? '仓库不存在或令牌看不到它'
        : '仓库探测失败；请核对出站策略与网络',
    private: null,
    push: null,
  })),
  {
    name: 'malformed response',
    status: 200,
    body: { private: TOKEN },
    exchange: false,
    ok: false,
    detail: '仓库探测失败；请核对出站策略与网络',
    private: null,
    push: null,
  },
  {
    name: 'network error',
    status: 0,
    body: {},
    exchange: false,
    ok: false,
    detail: '仓库探测失败；请核对出站策略与网络',
    private: null,
    push: null,
  },
]) {
  test(`injected repo probe: ${c.name} records facts and exposes only fixed errors`, async () => {
    let requests = 0
    const { book, directory } = fixture({
      repoFetch: async (url, init) => {
        requests++
        expect(url).toBe('https://api.github.com/repos/owner/demo')
        expect(init.redirect).toBe('manual')
        expect(new Headers(init.headers).get('authorization')).toBe(
          `Bearer ${TOKEN}`,
        )
        expect(new Headers(init.headers).get('accept')).toBe(
          'application/vnd.github+json',
        )
        if (!c.status) throw new Error(`upstream-secret-${TOKEN}`)
        return new Response(JSON.stringify(c.body), {
          status: c.status,
          headers: { location: `https://evil.test/${TOKEN}` },
        })
      },
    })
    const saved = value(
      await book.save(
        { ...draft, settings: { repo: 'owner/demo', exchange: c.exchange } },
        actor,
      ),
    )
    const probed = value(await book.probe(saved.id, actor))
    expect(requests).toBe(1)
    expect(probed.lastProbe).toMatchObject({
      ok: c.ok,
      detail: c.detail,
      private: c.private,
      push: c.push,
    })
    expect(probed.repo).toEqual({
      name: 'owner/demo',
      exchange: c.exchange,
      private: c.private,
      push: c.push,
    })
    expect((await book.resolve('owner/demo')) !== null).toBe(c.ok)
    expect(JSON.stringify(probed)).not.toContain(TOKEN)
    expect(scan(directory)).not.toContain(TOKEN)
  })
}

test('repo probe cannot bypass public DNS policy and cannot commit after a concurrent removal', async () => {
  let requests = 0
  const blocked = fixture({
    policy: new OutboundPolicy({
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    }),
    repoFetch: async () => {
      requests++
      return Response.json({ private: true, permissions: { push: true } })
    },
  })
  const created = value(await blocked.book.save(draft, actor))
  expect(value(await blocked.book.probe(created.id, actor)).lastProbe?.ok).toBe(
    false,
  )
  expect(requests).toBe(0)
  const { promise, resolve } = Promise.withResolvers<Response>()
  const { promise: started, resolve: notify } = Promise.withResolvers<void>()
  const raced = fixture({
    repoFetch: async () => {
      notify()
      return promise
    },
  })
  const row = value(await raced.book.save(draft, actor))
  const pending = raced.book.probe(row.id, actor)
  await started
  value(await raced.book.remove(row.id, actor))
  resolve(Response.json({ private: true, permissions: { push: true } }))
  expect((await pending).ok).toBe(false)
  expect(await raced.book.resolve('owner/demo')).toBeNull()
})

test('tenant owners can reuse repo names but only one exchange is allowed; credentials never cross tenants or use ownerless CLI tokens', async () => {
  const { tenancy } = tenants()
  const { book } = fixture({
    tenancy,
    fallbackRepoCredentials: {
      async resolve() {
        throw new Error('tenant fallback must not run')
      },
    },
  })
  const a = value(
    await book.save(
      { ...draft, settings: { repo: 'owner/demo', exchange: true } },
      actor,
    ),
  )
  value(
    await book.save(
      {
        ...draft,
        settings: { repo: 'owner/demo', exchange: false },
        secret: 'tenant-b-token',
      },
      foreign,
    ),
  )
  expect(
    (
      await book.save(
        {
          ...draft,
          settings: { repo: 'owner/foreign-exchange', exchange: true },
        },
        foreign,
      )
    ).ok,
  ).toBe(false)
  expect(a.tenant).toBe('a')
  expect(
    (await book.resolve('owner/demo', { ownerSubject: actor.subject }))?.token,
  ).toBe(TOKEN)
  expect((await book.resolve('owner/demo', { tenant: 'b' }))?.token).toBe(
    'tenant-b-token',
  )
  expect(await book.resolve('owner/demo')).toBeNull()
  expect(
    await book.resolve('owner/demo', {
      ownerSubject: actor.subject,
      tenant: 'b',
    }),
  ).toBeNull()
  expect(
    await book.resolve('owner/demo', { ownerSubject: 'legacy:admin' }),
  ).toBeNull()
  expect(await book.resolve('owner/cli', { tenant: 'a' })).toBeNull()
  expect((await book.remove(a.id, foreign)).ok).toBe(false)
  expect((await book.probe(a.id, foreign)).ok).toBe(false)
  value(await book.remove(a.id, actor))
  expect(
    await book.resolve('owner/demo', { ownerSubject: actor.subject }),
  ).toBeNull()
  expect(
    (await book.resolve('owner/demo', { ownerSubject: foreign.subject }))
      ?.token,
  ).toBe('tenant-b-token')
})

test('all five host tools reject repo ids, do not list them, request no approvals and never persist the token in their audit', async () => {
  let outbound = 0,
    approvals = 0
  const { book, directory } = fixture({
    repoFetch: async () => {
      outbound++
      throw new Error(TOKEN)
    },
  })
  const saved = value(await book.save(draft, actor))
  const tools = connectorTools({
    call: (op, args, ctx) =>
      book.handle(op, args, {
        ...ctx,
        node: 'worker',
        callId: ctx.callId ?? crypto.randomUUID(),
      }),
    approve: async () => {
      approvals++
      return null
    },
  })
  const ctx = { agent: 'main', sessionId: 'session' }
  const args = {
    connectorId: saved.id,
    id: 'message',
    to: 'a@example.com',
    subject: 's',
    body: 'b',
    from: '2026-10-11T00:00:00Z',
    toTime: '2026-10-12T00:00:00Z',
    title: 'meeting',
    start: '2026-10-11T00:00:00Z',
    end: '2026-10-11T01:00:00Z',
  }
  for (const tool of tools) {
    const properties = (
      tool.parameters as { properties: Record<string, unknown> }
    ).properties
    const input = Object.fromEntries(
      Object.keys(properties)
        .filter(key => Object.hasOwn(args, key))
        .map(key => [key, args[key as keyof typeof args]]),
    )
    if (tool.name === 'qianmo_calendar_events') input['to'] = args.toTime
    const result = await tool.handler(input, ctx)
    if (tool.name === 'qianmo_connectors')
      expect(result.details).toEqual({ ok: true, value: [] })
    else expect(result.ok).toBe(false)
  }
  expect(approvals).toBe(0)
  expect(outbound).toBe(0)
  expect(scan(directory)).not.toContain(TOKEN)
  expect(
    fs.readFileSync(path.join(directory, 'connector-audit.ndjson'), 'utf8'),
  ).toContain('refused')
})

test('real connectors API accepts personal ops CRUD/probe and unchanged secrets; shared token cannot write or acquire the token', async () => {
  const { book, directory } = fixture({
    repoFetch: async () =>
      Response.json({ private: true, permissions: { push: true } }),
  })
  const h = accountsHarness({ deps: { connectors: book } })
  const ops = await person(h.handle, 'ops')
  const call = (
    method: string,
    url: string,
    body?: unknown,
    bearer = ops.credential,
  ) => h.handle(asBearer(method, url, bearer, body))
  expect((await call('POST', '/v0/connectors', draft, ADMIN)).status).toBe(403)
  const created = await call('POST', '/v0/connectors', draft)
  expect(created.status).toBe(200)
  const saved = (await created.json()) as { id: string }
  expect((await call('POST', `/v0/connectors/${saved.id}/probe`)).status).toBe(
    200,
  )
  const { secret: _secret, ...edit } = draft
  expect(
    (
      await call('POST', '/v0/connectors', {
        ...edit,
        id: saved.id,
        name: 'Updated',
      })
    ).status,
  ).toBe(200)
  expect((await book.resolve('owner/demo'))?.token).toBe(TOKEN)
  expect(
    (
      await call('POST', '/v0/connectors', {
        ...draft,
        settings: { repo: 'owner/demo', exchange: true },
      })
    ).status,
  ).toBe(400)
  expect(
    (await call('DELETE', `/v0/connectors/${saved.id}`, undefined, ADMIN))
      .status,
  ).toBe(403)
  expect(
    (await call('POST', `/v0/connectors/${saved.id}/probe`, undefined, ADMIN))
      .status,
  ).toBe(403)
  const view = await call('GET', '/v0/connectors', undefined, ADMIN)
  expect(await view.text()).not.toContain(TOKEN)
  expect((await call('DELETE', `/v0/connectors/${saved.id}`)).status).toBe(204)
  expect(await book.resolve('owner/demo')).toBeNull()
  expect(scan(directory)).not.toContain(TOKEN)
})

test('connectors CLI enables GitHub relay nodes without a CLI repo or SSH git root', () => {
  const key = generateNodeKeyPair().publicKey
  const parsed = parseConsoleArgs([
    '--connectors',
    '--accounts',
    '--approvals',
    '--chat-sign',
    '--chat-url',
    'worker=ws://127.0.0.1:12345',
    '--control',
    'worker=ws://127.0.0.1:12345',
    '--trust',
    `worker=${key}`,
    '--handoff-node',
    'worker=ws://127.0.0.1:12345',
  ])
  expect(parsed.handoffNodes).toEqual([
    { node: 'worker', url: 'ws://127.0.0.1:12345/' },
  ])
  expect(() =>
    parseConsoleArgs(['--handoff-node', 'worker=ws://127.0.0.1:12345']),
  ).toThrow()
})

test('tenantScope API lists only owned repos, preserves omitted secrets and refuses foreign CRUD/probe before effects', async () => {
  const auth = accountsHarness()
  const a = await person(auth.handle, 'ops'),
    b = await person(auth.handle, 'ops')
  const pa = auth.book.bearerPrincipal(a.credential),
    pb = auth.book.bearerPrincipal(b.credential)
  if (!pa.ok || !pb.ok) throw new Error('principal missing')
  const tenancy: TenantPort = {
    read: () => ({
      revision: '1',
      config: {
        version: 1,
        hubServer: 'hub',
        tenants: [{ id: 'a' }, { id: 'b' }],
        subjects: [
          { subject: pa.value.subject, tenant: 'a' },
          { subject: pb.value.subject, tenant: 'b' },
        ],
        platformSubjects: [],
        nodes: [],
        jobs: [],
      },
    }),
    subscribe: () => () => {},
  }
  let probes = 0
  const { book } = fixture({
    tenancy,
    repoFetch: async () => {
      probes++
      return Response.json({ private: true, permissions: { push: true } })
    },
  })
  const h = accountsHarness({
    ledger: auth.ledger,
    sessions: auth.sessions,
    deps: { connectors: book, tenancy },
  })
  const call = (method: string, url: string, bearer: string, body?: unknown) =>
    h.handle(asBearer(method, url, bearer, body))
  const savedA = await call('POST', '/v0/connectors', a.credential, {
    ...draft,
    settings: { repo: 'owner/demo', exchange: true },
  })
  const savedB = await call('POST', '/v0/connectors', b.credential, {
    ...draft,
    settings: { repo: 'owner/demo', exchange: false },
    secret: 'tenant-b-token',
  })
  expect(savedA.status).toBe(200)
  expect(savedB.status).toBe(200)
  const rowA = (await savedA.json()) as { id: string },
    rowB = (await savedB.json()) as { id: string }
  const listing = (await (
    await call('GET', '/v0/connectors', a.credential)
  ).json()) as { connectors: { id: string; agents: string[] }[] }
  expect(
    listing.connectors.map(row => ({ id: row.id, agents: row.agents })),
  ).toEqual([{ id: rowA.id, agents: [] }])
  expect(
    (await call('POST', `/v0/connectors/${rowB.id}/probe`, a.credential))
      .status,
  ).toBe(404)
  expect(
    (await call('DELETE', `/v0/connectors/${rowB.id}`, a.credential)).status,
  ).toBe(404)
  expect(
    (
      await call('POST', '/v0/connectors', a.credential, {
        ...draft,
        id: rowB.id,
      })
    ).status,
  ).toBe(404)
  expect(probes).toBe(0)
  const { secret: _secret, ...edit } = draft
  expect(
    (
      await call('POST', '/v0/connectors', a.credential, {
        ...edit,
        id: rowA.id,
        name: 'Own edit',
        settings: { repo: 'owner/demo' },
      })
    ).status,
  ).toBe(200)
  expect(
    (await book.resolve('owner/demo', { ownerSubject: pa.value.subject }))
      ?.token,
  ).toBe(TOKEN)
  expect(
    (
      await call('POST', '/v0/connectors', a.credential, {
        ...draft,
        settings: { repo: 'owner/second', exchange: true },
      })
    ).status,
  ).toBe(400)
  expect(
    (await call('POST', `/v0/connectors/${rowA.id}/probe`, a.credential))
      .status,
  ).toBe(200)
  expect(probes).toBe(1)
  expect(
    (await call('DELETE', `/v0/connectors/${rowA.id}`, a.credential)).status,
  ).toBe(204)
  expect(
    (await book.resolve('owner/demo', { ownerSubject: pb.value.subject }))
      ?.token,
  ).toBe('tenant-b-token')
})
