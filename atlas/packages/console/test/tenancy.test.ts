// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileUsageStore } from '../src/usage.js'
import { describe, expect, test } from 'bun:test'
import { AccountBook, type AccountRole } from '../src/accounts.js'
import {
  parseTenantConfig,
  type TenantConfig,
  type TenantPort,
} from '../src/tenancy.js'
import { createConsoleHandler } from '../src/http.js'
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
  const handle = createConsoleHandler(deps, TOKENS, {
    book,
    signup: { maxAccounts: 7, attemptsPerHour: 5 },
  })
  return {
    handle,
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
      '/settings',
      '/v0/handoff',
    ])
      expect(
        (await h.handle(asBearer('GET', path, h.alice.credential))).status,
      ).toBe(403)
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
      await h.handle(asBearer('GET', '/alerts', h.alice.credential))
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
