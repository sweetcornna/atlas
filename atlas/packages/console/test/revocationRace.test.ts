// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { AccountBook } from '../src/accounts.js'
import { createConsoleHandler } from '../src/http.js'
import { streamScopeOf } from '../src/accountsHttp.js'
import { resolveAccess } from '../src/access.js'
import type { TenantConfig } from '../src/tenancy.js'
import { MemoryLedger, TOKENS } from './accountsHarness.js'
import { pageHarness } from './pageHarness.js'

function fixture() {
  const book = new AccountBook({
    accounts: new MemoryLedger(),
    sessions: new MemoryLedger(),
  })
  const invite = book.issueInvite({ role: 'ops', issuedBy: 'legacy:admin' })
  if (!invite.ok) throw Error('invite')
  const person = book.acceptInvite(invite.value.token)
  if (!person.ok) throw Error('person')
  const config: TenantConfig = {
    version: 1,
    hubServer: 'hub',
    tenants: [{ id: 'a' }],
    subjects: [{ subject: person.value.subject, tenant: 'a' }],
    nodes: [
      {
        nodeId: 'tokyo-1',
        tenant: 'a',
        server: 'node-a',
        memoryRoot: '/data/a',
      },
    ],
    jobs: [],
    platformSubjects: [],
  }
  const request = (path: string) =>
    new Request(`http://console.test${path}`, {
      headers: { authorization: `Bearer ${person.value.credential}` },
    })
  return { book, person: person.value, config, request }
}

test('revocation between authentication and stream subscription closes immediately and emits no data', async () => {
  const f = fixture(),
    h = pageHarness()
  let first = true
  const handler = createConsoleHandler(
    {
      ...h.deps,
      tenancy: {
        read() {
          if (first) {
            first = false
            queueMicrotask(() => {
              f.book.revoke(f.person.subject, 'legacy:admin')
            })
          }
          return { revision: '1', config: f.config }
        },
        subscribe() {
          return () => {}
        },
      },
    },
    TOKENS,
    { book: f.book },
  )
  const response = await handler(f.request('/v0/events'))
  expect(response.status).toBe(403)
  expect(await response.text()).not.toContain('event: revision')
  expect(f.book.openStreams(f.person.subject)).toBe(0)
})

test('exact bearer and session are rechecked after attachment, including credential reset', () => {
  const f = fixture(),
    access = resolveAccess(f.request('/v0/events'), TOKENS, { book: f.book })
  const scope = streamScopeOf(access, { book: f.book })!
  expect(scope.alive()).toBe(true)
  expect(f.book.reset(f.person.subject, 'legacy:admin').ok).toBe(true)
  let closed = 0
  const detach = scope.attach(() => {
    closed++
  })
  expect(closed).toBe(1)
  expect(scope.alive()).toBe(false)
  expect(f.book.openStreams(f.person.subject)).toBe(0)
  detach()
})

for (const change of ['tenant', 'platform', 'account'] as const)
  test(`audit export discards an awaited old-scope result after ${change} revocation`, async () => {
    const f = fixture(),
      h = pageHarness()
    let revision = 1,
      config =
        change === 'platform'
          ? { ...f.config, platformSubjects: [f.person.subject] }
          : f.config
    const audit = {
      async read() {
        await Promise.resolve()
        if (change === 'account')
          f.book.revoke(f.person.subject, 'legacy:admin')
        else {
          revision++
          config = { ...config, subjects: [], platformSubjects: [] }
        }
        const page = h.audit.readResult
        if (!page.ok) throw Error('fixture')
        return {
          ok: true as const,
          value: {
            ...page.value,
            records: page.value.records.map(row => ({
              ...row,
              detail: { secret: 'withdrawn-tenant-record' },
            })),
          },
        }
      },
      async chain() {
        return { ok: true as const, value: null }
      },
    }
    const handler = createConsoleHandler(
      {
        ...h.deps,
        audits: [{ node: 'tokyo-1', kind: 'authoritative', audit }],
        tenancy: {
          read() {
            return { revision: String(revision), config }
          },
          subscribe() {
            return () => {}
          },
        },
      },
      TOKENS,
      { book: f.book },
    )
    const response = await handler(
      f.request('/v0/audit?node=tokyo-1&format=ndjson'),
    )
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('withdrawn-tenant-record')
  })
