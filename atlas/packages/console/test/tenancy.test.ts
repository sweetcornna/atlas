// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileUsageStore } from '../src/usage.js'
import {
  FakeMemory,
  FakeSchedules,
  FakeFiles,
  FakeDesktop,
  FakeConnectors,
  FakeRouting,
  FakeHandoffDevices,
  FakeAvatars,
  FakeExtensions,
  FakeUpdates,
  FakeChannels,
} from './directionFakes.js'
import { describe, expect, test } from 'bun:test'
import { AccountBook, type AccountRole } from '../src/accounts.js'
import {
  parseTenantConfig,
  type TenantConfig,
  type TenantPort,
} from '../src/tenancy.js'
import { createConsoleHandler } from '../src/http.js'
import type { SchedulesSnapshot } from '../src/directionPorts.js'
import {
  type ConsoleAgent,
  type ConsoleDeps,
  type ConsoleResult,
} from '../src/deps.js'
import {
  CountingChat,
  LIMITS,
  MemoryLedger,
  TOKENS,
  asBearer,
  formPost,
  credentialOn,
  BASE,
} from './accountsHarness.js'

const ok = <T>(value: T): ConsoleResult<T> => ({ ok: true, value })
const initial = (): TenantConfig => ({
  version: 1,
  hubServer: 'hub',
  tenants: [{ id: 'a' }, { id: 'b' }],
  subjects: [],
  nodes: [
    { nodeId: 'tokyo-1', tenant: 'a', server: 'sa', memoryRoot: '/data/a' },
    { nodeId: 'berlin-1', tenant: 'b', server: 'sb', memoryRoot: '/data/b' },
  ],
  jobs: [
    { jobId: 'ja', tenant: 'a', nodeId: 'tokyo-1' },
    { jobId: 'jb', tenant: 'b', nodeId: 'berlin-1' },
  ],
  platformSubjects: [],
})
const agent = (node: string): ConsoleAgent => ({
  address: `qianmo://${node}/planner`,
  endpoint: 'ws://127.0.0.1',
  capabilities: [],
  status: 'online',
  registeredAt: 1,
  lastHeartbeatAt: 1,
  expiresAt: 9999999999999,
})

function fixture() {
  const ledger = new MemoryLedger(),
    sessions = new MemoryLedger()
  const book = new AccountBook({ accounts: ledger, sessions })
  function person(role: AccountRole = 'ops') {
    const issued = book.issueInvite({ role, issuedBy: 'legacy:admin' })
    if (!issued.ok) throw new Error('issue')
    const accepted = book.acceptInvite(issued.value.token)
    if (!accepted.ok) throw new Error('accept')
    return accepted.value
  }
  const alice = person(),
    bob = person(),
    outsider = person('member'),
    platform = person()
  let config: TenantConfig = {
    ...initial(),
    subjects: [
      { subject: alice.subject, tenant: 'a' },
      { subject: bob.subject, tenant: 'b' },
    ],
    platformSubjects: [platform.subject],
  }
  let revision = 1,
    broken = false
  const listeners = new Set<() => void>()
  const tenancy: TenantPort = {
    read() {
      if (broken) throw new Error('broken')
      return { config, revision: String(revision) }
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
  const chat = new CountingChat()
  for (const [id, node] of [
    ['a-session', 'tokyo-1'],
    ['b-session', 'berlin-1'],
  ] as const)
    chat.sessionsById.set(id, {
      id,
      node,
      agent: 'planner',
      target: `qianmo://${node}/planner`,
      createdAt: 1,
      updatedAt: 1,
      turnCount: 1,
      preview: `${id} private`,
    })
  let effects = 0,
    admission = 0,
    auditReads = 0
  const deps: ConsoleDeps = {
    limits: LIMITS,
    tenancy,
    chat,
    registry: {
      async list() {
        return ok([agent('tokyo-1'), agent('berlin-1')])
      },
      async register(input) {
        effects++
        return ok(
          agent(input.address.includes('tokyo') ? 'tokyo-1' : 'berlin-1'),
        )
      },
      async heartbeat() {
        effects++
        return ok(agent('tokyo-1'))
      },
      async deregister() {
        effects++
        return ok(undefined)
      },
    },
    audit: {
      async read() {
        auditReads++
        return ok({
          records: [],
          chain: 'empty',
          intact: true,
          issueCount: 0,
          total: 0,
        })
      },
      async chain() {
        auditReads++
        return ok(null)
      },
    },
    audits: ['tokyo-1', 'berlin-1'].map(node => ({
      node,
      kind: 'authoritative',
      audit: {
        async read() {
          auditReads++
          return ok({
            records: [],
            chain: 'empty',
            intact: true,
            issueCount: 0,
            total: 0,
          })
        },
        async chain() {
          auditReads++
          return ok(null)
        },
      },
    })),
    nodeServers: [
      { node: 'tokyo-1', server: 'sa' },
      { node: 'berlin-1', server: 'sb' },
    ],
    serverNotes: {
      async list() {
        return ok([
          { server: 'sa', note: 'a-private', updatedAt: 1 },
          { server: 'sb', note: 'b-private', updatedAt: 1 },
        ])
      },
      async set(server, note) {
        effects++
        return ok({ server, note, updatedAt: 1 })
      },
    },
    wakeTargets: ['tokyo-1', 'berlin-1'].map(node => ({
      node,
      url: `ws://${node}`,
      wake: {
        async send() {
          effects++
          return ok({ msgId: 'm', taskId: 't', receipt: 'accepted' })
        },
      },
    })),
    actions: {
      async admit() {
        admission++
        return ok(undefined)
      },
      async record() {
        effects++
        return ok(undefined)
      },
      async list() {
        return ok({ entries: [], nextBeforeSeq: null })
      },
    },
    notify: {
      async notices() {
        return ok({
          notices: [
            {
              id: 'na',
              at: 1,
              node: 'tokyo-1',
              from: 'qianmo://berlin-1/planner',
              level: 'info',
              kind: 'watch',
              summary: 'a-notice',
            },
            {
              id: 'nb',
              at: 1,
              node: 'berlin-1',
              from: 'qianmo://tokyo-1/planner',
              level: 'info',
              kind: 'watch',
              summary: 'b-notice',
            },
            {
              id: 'unbound',
              at: 1,
              from: 'qianmo://tokyo-1/planner',
              level: 'info',
              kind: 'watch',
              summary: 'untrusted',
            },
          ],
          total: 3,
          present: true,
          intact: true,
        })
      },
      async acks() {
        return ok([])
      },
      async ack(id, by) {
        effects++
        return ok({ id, by, at: 1 })
      },
    },
  }
  // The 2026-10 ports (review D01); only some carry a tenant wrapper yet.
  const memory = new FakeMemory(() => 1)
  const schedules = new FakeSchedules(
    () => 1,
    [
      'qianmo://tokyo-1/planner',
      'qianmo://osaka-1/writer',
      'qianmo://berlin-1/planner',
    ],
  )
  schedules.channels = [
    ...schedules.channels,
    { ...schedules.channels[0]!, id: 'ch-a', name: 'a-channel', tenant: 'a' },
    { ...schedules.channels[0]!, id: 'ch-b', name: 'b-channel', tenant: 'b' },
  ]
  const files = new FakeFiles(() => 1),
    desktop = new FakeDesktop(() => 1),
    connectors = new FakeConnectors(() => 1),
    routing = new FakeRouting(() => 1),
    handoffDevices = new FakeHandoffDevices(() => 1),
    avatars = new FakeAvatars(() => 1),
    extensions = new FakeExtensions(),
    updates = new FakeUpdates(() => 1),
    channels = new FakeChannels(() => 1)
  const handle = createConsoleHandler(
    {
      ...deps,
      memory,
      schedules,
      files,
      desktop,
      connectors,
      routing,
      handoffDevices,
      avatars,
      extensions,
      updates,
      channels,
    },
    TOKENS,
    {
      book,
      signup: { maxAccounts: 7, attemptsPerHour: 5 },
    },
  )
  return {
    handle,
    memory,
    schedules,
    files,
    desktop,
    connectors,
    routing,
    handoffDevices,
    avatars,
    extensions,
    updates,
    channels,
    alice,
    bob,
    outsider,
    platform,
    book,
    ledger,
    sessions,
    chat,
    deps,
    counts: () => ({ effects, admission, auditReads }),
    change() {
      config = { ...config, subjects: [] }
      revision++
      for (const fn of [...listeners]) fn()
    },
    break() {
      broken = true
    },
  }
}

describe('M2 authoritative deployment policy', () => {
  test('same-tenant positive and cross-tenant hardware/path/job negatives', () => {
    expect(parseTenantConfig(initial()).nodes).toHaveLength(2)
    expect(() =>
      parseTenantConfig({
        ...initial(),
        nodes: initial().nodes.map(n => ({ ...n, server: 'shared' })),
      }),
    ).toThrow('服务器')
    expect(() =>
      parseTenantConfig({
        ...initial(),
        nodes: initial().nodes.map(n => ({
          ...n,
          memoryRoot: n.tenant === 'a' ? '/data' : '/data/b',
        })),
      }),
    ).toThrow('重叠')
    expect(() =>
      parseTenantConfig({
        ...initial(),
        nodes: initial().nodes.map(n => ({ ...n, server: 'hub' })),
      }),
    ).toThrow('中枢')
    expect(() =>
      parseTenantConfig({
        ...initial(),
        jobs: [{ jobId: 'j', tenant: 'a', nodeId: 'berlin-1' }],
      }),
    ).toThrow('不一致')
    expect(() => parseTenantConfig({ ...initial(), extra: true })).toThrow(
      '未知',
    )
    expect(() =>
      parseTenantConfig({
        ...initial(),
        nodes: [...initial().nodes, initial().nodes[0]],
      }),
    ).toThrow('重复')
  })
  test('Windows canonical paths casefold and segment boundaries', () => {
    const config = {
      ...initial(),
      nodes: initial().nodes.map(n => ({
        ...n,
        memoryRoot: n.tenant === 'a' ? 'C:\\Memory\\A' : 'c:/memory/a/child',
      })),
    }
    expect(() => parseTenantConfig(config)).toThrow('重叠')
    expect(() =>
      parseTenantConfig({
        ...config,
        nodes: config.nodes.map(n => ({
          ...n,
          memoryRoot: n.tenant === 'b' ? 'C:/memory/ab' : n.memoryRoot,
        })),
      }),
    ).not.toThrow()
  })
})

describe('M2 request scopes', () => {
  test('tenant ops cannot bypass the platform access guard through admin, API or fragment routes', async () => {
    const h = fixture()
    // Positive reads prove these are live entry points containing Bob's identifier.
    for (const path of [
      '/admin/access',
      '/v0/accounts',
      '/fragments/access/members',
    ]) {
      const platform = await h.handle(
        asBearer('GET', path, h.platform.credential),
      )
      expect(platform.status).toBe(200)
      expect(await platform.text()).toContain(h.bob.subject)
    }
    for (const path of [
      '/access',
      '/admin/access',
      '/v0/accounts',
      '/fragments/access/members',
    ]) {
      const response = await h.handle(asBearer('GET', path, h.alice.credential))
      const body = await response.text()
      expect(body).not.toContain(h.bob.subject)
      expect(response.status).toBe(403)
      expect(body).toContain('此功能需要平台管理身份')
    }
  })

  test.each([
    'a',
    'b',
  ] as const)('%s: list/detail/send are bounded by authenticated subject; effects remain zero', async tenant => {
    const h = fixture(),
      actor = tenant === 'a' ? h.alice : h.bob,
      own = tenant === 'a' ? 'tokyo-1' : 'berlin-1',
      other = tenant === 'a' ? 'berlin-1' : 'tokyo-1',
      ownId = `${tenant}-session`,
      otherId = tenant === 'a' ? 'b-session' : 'a-session'
    const list = await h.handle(asBearer('GET', '/v0/agents', actor.credential))
    const text = await list.text()
    expect(list.status).toBe(200)
    expect(text).toContain(own)
    expect(text).not.toContain(other)
    expect(
      (
        await h.handle(
          asBearer('GET', `/v0/chat/sessions/${otherId}`, actor.credential),
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await h.handle(
          asBearer(
            'POST',
            `/v0/chat/sessions/${otherId}/messages`,
            actor.credential,
            { text: 'attack' },
          ),
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await h.handle(
          asBearer('POST', '/v0/agents', actor.credential, {
            address: `qianmo://${other}/planner`,
            endpoint: 'ws://other',
          }),
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await h.handle(
          asBearer(
            'PUT',
            `/v0/servers/${tenant === 'a' ? 'sb' : 'sa'}/note`,
            actor.credential,
            { note: 'attack' },
          ),
        )
      ).status,
    ).toBe(404)
    expect(h.chat.transcripts).toBe(0)
    expect(h.chat.sends).toBe(0)
    expect(h.counts()).toMatchObject({ effects: 0, admission: 0 })
    expect(
      (
        await h.handle(
          asBearer('GET', `/v0/chat/sessions/${ownId}`, actor.credential),
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await h.handle(
          asBearer(
            'POST',
            `/v0/chat/sessions/${ownId}/messages`,
            actor.credential,
            { text: 'hello' },
          ),
        )
      ).status,
    ).toBe(200)
    expect(h.chat.sends).toBe(1)
  })
  test('unmapped account and legacy token see empty datasets; platform scope explicitly controls all nodes', async () => {
    const h = fixture()
    for (const credential of [
      h.outsider.credential,
      TOKENS.admin,
      TOKENS.view,
    ]) {
      const text = await (
        await h.handle(asBearer('GET', '/v0/agents', credential))
      ).text()
      expect(text).not.toContain('tokyo-1')
      expect(text).not.toContain('berlin-1')
    }
    expect(
      await (
        await h.handle(asBearer('GET', '/v0/agents', h.platform.credential))
      ).text(),
    ).toContain('berlin-1')
    for (const path of [
      '/v0/accounts',
      '/v0/providers',
      '/admin/settings',
      '/v0/handoff',
    ])
      expect(
        (await h.handle(asBearer('GET', path, h.alice.credential))).status,
      ).toBe(403)
  })
  test('memory, files, connectors, schedules and the cloud computer are tenant-scoped before admission; the remaining 2026-10 ports stay unwired', async () => {
    const h = fixture()
    const allowed = await h.handle(
      asBearer('GET', '/v0/memory', h.alice.credential),
    )
    expect(allowed.status).toBe(200)
    expect(h.memory.calls).toEqual([`list tokyo-1/planner ${h.alice.subject}`])
    // Schedules by their target agent, channels by their owner tenant; the
    // platform-only `ch-1` and tenant b's `ch-b` stay out of sight.
    const listed = await h.handle(
      asBearer('GET', '/v0/schedules', h.alice.credential),
    )
    expect(listed.status).toBe(200)
    const snapshot = (await listed.json()) as SchedulesSnapshot
    expect(snapshot.schedules.map(v => v.id)).toEqual(['sch-1'])
    expect(snapshot.runs.map(v => v.scheduleId)).toEqual(['sch-1', 'sch-1'])
    expect(snapshot.channels.map(v => v.id)).toEqual(['ch-a'])
    expect(snapshot.targets).toEqual(['qianmo://tokyo-1/planner'])
    expect(
      (
        await h
          .handle(asBearer('GET', '/v0/schedules', h.platform.credential))
          .then(r => r.json() as Promise<SchedulesSnapshot>)
      ).channels.map(v => v.id),
    ).toEqual(['ch-1', 'ch-a', 'ch-b'])
    const jobs = await h.handle(
      asBearer('GET', '/admin/jobs', h.alice.credential),
    )
    expect(jobs.status).toBe(200)
    const html = await jobs.text()
    expect(html).toContain('a-channel')
    for (const foreign of ['b-channel', 'osaka-1', 'berlin-1'])
      expect(html).not.toContain(foreign)
    h.schedules.calls.length = 0
    for (const [method, path, body] of [
      ['GET', '/v0/schedules/sch-2', undefined],
      ['POST', '/v0/schedules/sch-2/run', undefined],
      ['DELETE', '/v0/schedules/sch-2', undefined],
      [
        'POST',
        '/v0/schedules',
        { title: 'x', target: 'qianmo://berlin-1/planner', channels: [] },
      ],
      [
        'POST',
        '/v0/schedules',
        { title: 'x', target: 'qianmo://tokyo-1/planner', channels: ['ch-b'] },
      ],
      ['POST', '/v0/channels/ch-b/test', undefined],
      ['DELETE', '/v0/channels/ch-1', undefined],
      ['POST', '/v0/channels', { tenant: 'b', name: 'x', kind: 'bark' }],
    ] as const) {
      const result = await h.handle(
        asBearer(method, path, h.alice.credential, body),
      )
      expect(result.status).toBe(404)
    }
    expect(h.schedules.calls).toEqual([])
    h.memory.calls.length = 0
    for (const [method, suffix] of [
      ['POST', ''],
      ['PUT', '/mem-11'],
      ['POST', '/mem-11/forget'],
      ['POST', '/mem-11/invalidate'],
    ] as const) {
      const result = await h.handle(
        asBearer(method, `/v0/memory${suffix}`, h.alice.credential, {
          agent: 'qianmo://berlin-1/planner',
          kind: 'plan',
          title: 'x',
          summary: 'x',
          body: '',
          reason: 'x',
        }),
      )
      expect(result.status).toBe(404)
    }
    expect(
      (
        await h.handle(
          asBearer(
            'GET',
            '/v0/memory?agent=qianmo%3A%2F%2Fberlin-1%2Fplanner',
            h.alice.credential,
          ),
        )
      ).status,
    ).toBe(404)
    expect(h.memory.calls).toEqual([])
    expect(h.counts()).toMatchObject({ effects: 0, admission: 0 })
    const made = await h.handle(
      asBearer('POST', '/v0/memory', h.alice.credential, {
        agent: 'qianmo://tokyo-1/planner',
        kind: 'plan',
        title: 'x',
        summary: 'x',
        body: '',
      }),
    )
    expect(made.status).toBe(200)
    expect(await made.json()).toMatchObject({
      owner: h.alice.subject,
      node: 'tokyo-1',
    })
    h.memory.calls.length = 0
    h.change()
    expect(
      (await h.handle(asBearer('GET', '/v0/memory', h.alice.credential)))
        .status,
    ).toBe(200)
    expect(h.memory.calls).toEqual([])
    for (const path of ['/v0/routing', '/v0/avatars']) {
      expect(
        (await h.handle(asBearer('GET', path, h.alice.credential))).status,
      ).toBe(501)
    }
    // Withdrawn from every tenant: the schedules page empties.
    const withdrawn = (await (
      await h.handle(asBearer('GET', '/v0/schedules', h.alice.credential))
    ).json()) as SchedulesSnapshot
    expect([withdrawn.schedules, withdrawn.runs, withdrawn.channels]).toEqual([
      [],
      [],
      [],
    ])
    for (const key of [
      'agent:qianmo://berlin-1/planner',
      `user:${h.bob.subject}`,
    ]) {
      const response = await h.handle(
        asBearer(
          'PUT',
          `/v0/avatars/${encodeURIComponent(key)}`,
          h.alice.credential,
          {},
        ),
      )
      expect(response.status).toBe(501)
    }
    const page = await (
      await h.handle(asBearer('GET', '/admin/overview', h.alice.credential))
    ).text()
    // 文件互通 (P20, `filesScope.ts`), 连接 (P25) and 云端电脑 (P21) have tenant
    // wrappers: their pages show.
    for (const href of ['/admin/files', '/admin/connect', '/admin/desktop'])
      expect(page).toContain(`href="${href}"`)
    for (const port of [h.routing, h.handoffDevices, h.avatars])
      expect(port.calls).toEqual([])
  })
  test('extensions, updates and chat channels are platform-wide: a tenant account reads and writes none of them (P32 audit 3)', async () => {
    const h = fixture()
    // Tenant a's ops account: nothing to read, nothing reaches the ports —
    // not another tenant's node (osaka-2), not a command for tenant b's agent.
    for (const [method, path, body] of [
      ['GET', '/v0/extensions', undefined],
      [
        'POST',
        '/v0/extensions',
        {
          kind: 'mcp',
          name: 'evil',
          command: 'sh',
          args: ['-c', 'id'],
          agents: ['qianmo://berlin-1/planner'],
        },
      ],
      [
        'DELETE',
        '/v0/extensions/ext-00000000-0000-4000-8000-000000000001',
        undefined,
      ],
      ['GET', '/v0/updates', undefined],
      ['POST', '/v0/updates/upgrade', {}],
      ['POST', '/v0/updates/run', undefined],
      ['GET', '/v0/im', undefined],
      [
        'POST',
        '/v0/im',
        { name: 'x', platform: 'qq', target: 'qianmo://berlin-1/planner' },
      ],
    ] as const) {
      const response = await h.handle(
        asBearer(method, path, h.alice.credential, body),
      )
      expect(response.status).toBe(501)
      const text = await response.text()
      for (const foreign of ['osaka-2', 'docs-mcp', 'berlin-1'])
        expect(text).not.toContain(foreign)
    }
    for (const path of ['/admin/extensions', '/admin/updates', '/admin/im'])
      expect(
        (await h.handle(asBearer('GET', path, h.alice.credential))).status,
      ).toBe(404)
    expect([h.extensions.calls, h.updates.calls, h.channels.calls]).toEqual([
      [],
      [],
      [],
    ])
    expect(h.counts()).toMatchObject({ effects: 0, admission: 0 })
    // The platform account still has all three.
    for (const path of ['/v0/extensions', '/v0/updates', '/v0/im'])
      expect(
        (await h.handle(asBearer('GET', path, h.platform.credential))).status,
      ).toBe(200)
  })
  test('audit source selectors and server notes cannot reach an external tenant', async () => {
    const h = fixture()
    expect(
      (
        await h.handle(
          asBearer('GET', '/v0/audit?node=berlin-1', h.alice.credential),
        )
      ).status,
    ).toBe(404)
    expect(h.counts().auditReads).toBe(0)
    expect(
      (
        await h.handle(
          asBearer('GET', '/v0/audit?node=tokyo-1', h.alice.credential),
        )
      ).status,
    ).toBe(200)
    const text = await (
      await h.handle(asBearer('GET', '/v0/servers', h.alice.credential))
    ).text()
    expect(text).toContain('a-private')
    expect(text).not.toContain('b-private')
  })
  test('notify scope trusts connection node, never sender labels', async () => {
    const h = fixture()
    const text = await (
      await h.handle(asBearer('GET', '/admin/alerts', h.alice.credential))
    ).text()
    expect(text).toContain('a-notice')
    expect(text).not.toContain('b-notice')
    expect(text).not.toContain('untrusted')
  })
  test('SSE only emits scoped updates and closes on policy change', async () => {
    const h = fixture()
    const response = await h.handle(
      asBearer('GET', '/v0/chat/stream', h.alice.credential),
    )
    const reader = response.body!.getReader()
    await reader.read()
    h.chat.emit('b-session')
    h.chat.emit('a-session')
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('a-session')
    expect(first).not.toContain('b-session')
    h.change()
    expect((await reader.read()).done).toBe(true)
    expect(h.chat.listeners.size).toBe(0)
    const body = await (
      await h.handle(asBearer('GET', '/v0/agents', h.alice.credential))
    ).text()
    expect(body).not.toContain('tokyo-1')
  })
  test('HTTP quota derives tenant server-side; changing request tenant cannot evade its cap', async () => {
    const h = fixture()
    const usage = new FileUsageStore({
      path: join(
        mkdtempSync(join(tmpdir(), 'qm-tenancy-quota-')),
        'usage.ndjson',
      ),
      policy: {
        mode: 'enforce',
        person: {},
        job: {},
        global: { tokens: 100 },
        tenants: { a: { tokens: 10 } },
      },
    })
    try {
      usage.record(
        'prior',
        { subject: 'another-user', kind: 'person', tenant: 'a' },
        { input: 10, output: 0, cacheWrite: 0, cacheRead: 1000 },
      )
      const handle = createConsoleHandler({ ...h.deps, usage }, TOKENS, {
        book: h.book,
      })
      const denied = await handle(
        asBearer(
          'POST',
          '/v0/chat/sessions/a-session/messages',
          h.alice.credential,
          { text: 'hello', tenant: 'b' },
        ),
      )
      expect(denied.status).toBe(429)
      expect(h.chat.sends).toBe(0)
      expect(
        (
          await handle(
            asBearer(
              'POST',
              '/v0/chat/sessions/b-session/messages',
              h.bob.credential,
              { text: 'hello' },
            ),
          )
        ).status,
      ).toBe(200)
      expect(h.chat.sends).toBe(1)
      const text = await (
        await handle(asBearer('GET', '/v0/usage', h.bob.credential))
      ).text()
      expect(text).not.toContain('tenant:a')
      expect(text).not.toContain('another-user')
      expect(text).toContain('tenant:b')
    } finally {
      usage.close()
    }
  })
  test('error-page shell uses the same scoped registry as successful pages', async () => {
    const h = fixture()
    const request = asBearer('GET', '/does-not-exist', h.outsider.credential)
    request.headers.set('accept', 'text/html')
    const response = await h.handle(request)
    expect(response.status).toBe(404)
    const body = await response.text()
    expect(body).not.toContain('tokyo-1')
    expect(body).not.toContain('berlin-1')
    expect(body).not.toContain('nav-count">2<')
  })
  test('corrupt enabled policy fails closed before ports', async () => {
    const h = fixture()
    h.break()
    expect(
      (
        await h.handle(
          asBearer('POST', '/v0/agents', h.alice.credential, {
            address: 'qianmo://tokyo-1/planner',
            endpoint: 'ws://ok',
          }),
        )
      ).status,
    ).toBe(503)
    expect(h.counts()).toEqual({ effects: 0, admission: 0, auditReads: 0 })
  })
})

describe('M2 self registration', () => {
  test('member-only, fresh subject, one-time credential, replayable hashes; foreign origin/forged subject cannot take over', async () => {
    const h = fixture(),
      before = h.ledger.appends
    expect((await h.handle(new Request(`${BASE}/signup`))).status).toBe(200)
    expect(h.ledger.appends).toBe(before)
    expect(
      (
        await h.handle(
          formPost(
            '/signup',
            { label: 'attack' },
            { origin: 'https://evil.test' },
          ),
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await h.handle(
          formPost('/signup', { subject: h.alice.subject, role: 'ops' }),
        )
      ).status,
    ).toBe(400)
    const created = await h.handle(formPost('/signup', { label: 'Alice' }))
    expect(created.status).toBe(200)
    const credential = credentialOn(await created.text())
    expect(h.ledger.text).not.toContain(credential)
    const principal = h.book.bearerPrincipal(credential)
    expect(principal).toMatchObject({ ok: true, value: { role: 'member' } })
    if (!principal.ok || principal.value.kind !== 'user')
      throw new Error('positive control')
    expect(principal.value.subject).not.toBe(h.alice.subject)
    expect(
      await (await h.handle(asBearer('GET', '/v0/agents', credential))).text(),
    ).not.toContain('tokyo-1')
    expect(
      await (await h.handle(new Request(`${BASE}/signup`))).text(),
    ).not.toContain(credential)
    const restarted = new AccountBook({
      accounts: new MemoryLedger('accounts', h.ledger.text),
      sessions: new MemoryLedger(),
    })
    expect(restarted.bearerPrincipal(credential).ok).toBe(true)
    expect(restarted.bearerPrincipal(h.alice.credential).ok).toBe(true)
  })
  test('successes consume rate budget and a concurrent cap cannot be overrun', async () => {
    const h = fixture()
    const results = await Promise.all(
      Array.from({ length: 6 }, () => h.handle(formPost('/signup', {}))),
    )
    expect(results.filter(r => r.status === 200)).toHaveLength(3)
    expect(results.filter(r => r.status === 429)).toHaveLength(3)
    const last = results.at(-1)!
    expect(last.headers.get('retry-after')).not.toBeNull()
    const accounts = h.book.list()
    expect(accounts.ok && accounts.value.accounts.length).toBe(7)
  })
  test('disabled by default and absent tenancy cannot open signup', async () => {
    const h = fixture()
    const handler = createConsoleHandler(
      { ...h.deps, tenancy: undefined },
      TOKENS,
      { book: h.book, signup: { maxAccounts: 100 } },
    )
    expect((await handler(formPost('/signup', {}))).status).toBe(404)
    const disabled = createConsoleHandler(h.deps, TOKENS, { book: h.book })
    expect((await disabled(formPost('/signup', {}))).status).toBe(404)
  })
})

describe('wake authority across asynchronous dispatch', () => {
  for (const change of [
    'none',
    'tenant',
    'account',
    'policy-error',
    'platform-policy',
  ] as const) {
    test(`${change}: host callback combines current credential and tenant policy`, async () => {
      const h = fixture()
      const actor = change === 'platform-policy' ? h.platform : h.alice
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let delivered = 0
      const usage = new FileUsageStore({
        path: join(
          mkdtempSync(join(tmpdir(), 'qm-wake-revoke-')),
          'usage.ndjson',
        ),
        policy: {
          mode: 'enforce',
          person: { inFlight: 1 },
          job: {},
          global: {},
        },
      })
      const handle = createConsoleHandler(
        {
          ...h.deps,
          usage,
          wakeTargets: [
            {
              node: 'tokyo-1',
              url: 'ws://fixture',
              wake: {
                async send(input) {
                  expect(input.beforeDispatch).toBeTypeOf('function')
                  entered.resolve()
                  await release.promise
                  try {
                    input.beforeDispatch?.()
                  } catch (error) {
                    return {
                      ok: false,
                      failure: { code: 'rejected', message: String(error) },
                    }
                  }
                  delivered++
                  input.onTaskCreated?.('fixture-wake', 'tokyo-1')
                  return ok({
                    msgId: 'm',
                    taskId: 'fixture-wake',
                    receipt: 'accepted',
                  })
                },
              },
            },
          ],
        },
        TOKENS,
        { book: h.book },
      )
      try {
        const pending = handle(
          asBearer('POST', '/v0/wake', actor.credential, {
            node: 'tokyo-1',
            from: 'qianmo://console/operator',
            to: 'qianmo://tokyo-1/planner',
            prompt: 'authorized wake',
            url: '',
            // A forged JSON callback must not replace the host closure.
            beforeDispatch: 'ignore authorization',
          }),
        )
        await entered.promise
        if (change === 'tenant' || change === 'platform-policy') h.change()
        if (change === 'account') h.book.revoke(h.alice.subject, 'legacy:admin')
        if (change === 'policy-error') h.break()
        release.resolve()
        const response = await pending
        expect(response.status).toBe(
          change === 'none' ? 200 : change === 'policy-error' ? 503 : 403,
        )
        expect(delivered).toBe(change === 'none' ? 1 : 0)
        // Known pre-send rejection releases quota; successful delivery remains in flight.
        const next = usage.reserve({
          kind: 'person',
          subject: actor.subject,
          tenant: 'a',
        })
        expect(next.ok).toBe(change !== 'none')
      } finally {
        release.resolve()
        usage.close()
      }
    })
  }
})
