// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createConsoleHandler,
  FileUsageStore,
  type ConsoleResult,
  type ScheduleDraft,
  type ScheduleView,
  type TenantSnapshot,
} from '@qianmo/console'
import {
  ADDRESS,
  LIMITS,
  TOKENS,
  accountsHarness,
  asBearer,
  person,
} from '../../../console/test/accountsHarness.js'
import { ConsoleSchedules } from '../../src/commands/consoleSchedules.js'

const roots: string[] = []
const books: ConsoleSchedules[] = []
const stores: FileUsageStore[] = []
afterEach(async () => {
  for (const book of books.splice(0)) {
    await book.idle()
    book.close()
  }
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

function value<T>(result: ConsoleResult<T>): T {
  if (!result.ok) throw new Error(result.failure.message)
  return result.value
}

async function setup(messages = 10, withTenancy = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-auth-'))
  roots.push(root)
  const h = accountsHarness()
  const creator = await person(h.handle)
  const other = await person(h.handle)
  const principal = h.book.bearerPrincipal(creator.credential)
  if (!principal.ok || principal.value.kind !== 'user')
    throw new Error('fixture account unavailable')
  const usage = new FileUsageStore({
    path: path.join(root, 'usage.ndjson'),
    now: h.clock.now,
    monotonic: h.clock.now,
    policy: { mode: 'enforce', person: { messages }, job: {}, global: {} },
  })
  stores.push(usage)
  let tenant: TenantSnapshot = {
    revision: 'initial',
    config: {
      version: 1,
      hubServer: 'hub',
      tenants: [{ id: 'a' }, { id: 'b' }],
      subjects: [{ subject: principal.value.subject, tenant: 'a' }],
      nodes: [
        {
          nodeId: 'tokyo-1',
          tenant: 'a',
          server: 'node-server',
          memoryRoot: path.join(root, 'memory'),
        },
      ],
      jobs: [],
      platformSubjects: [],
    },
  }
  const tenancy = withTenancy
    ? { read: () => tenant, subscribe: () => () => {} }
    : undefined
  const security = {
    accounts: { book: h.book },
    usage,
    ...(tenancy === undefined ? {} : { tenancy }),
  }
  const book = new ConsoleSchedules({
    directory: path.join(root, 'schedules'),
    estopPath: path.join(root, 'ESTOP'),
    chat: h.chat,
    now: h.clock.now,
    ...security,
  })
  books.push(book)
  const handle = createConsoleHandler(
    {
      registry: h.registry,
      audit: {
        read: async () => ({
          ok: false,
          failure: { code: 'unsupported', message: 'fixture' },
        }),
        chain: async () => ({ ok: true, value: null }),
      },
      limits: LIMITS,
      now: h.clock.now,
      chat: h.chat,
      schedules: book,
      usage,
      ...(tenancy === undefined ? {} : { tenancy }),
    },
    TOKENS,
    security.accounts,
  )
  const draft: ScheduleDraft = {
    title: '成员任务',
    target: ADDRESS,
    template: 'custom',
    prompt: '写简报',
    when: { kind: 'interval', everyMinutes: 15 },
    timezone: 'Asia/Shanghai',
    direction: 'medium',
    channels: [],
    notifyOnlyAgent: false,
    enabled: true,
    timeoutMs: 600_000,
  }
  const actor = {
    subject: principal.value.subject,
    role: 'member' as const,
    requestId: 'manual',
  }
  // With tenancy the member reaches the book through the tenant wrapper (D01).
  const response = await handle(
    asBearer('POST', '/v0/schedules', creator.credential, draft),
  )
  expect(response.status).toBe(200)
  const saved = (await response.json()) as ScheduleView
  return {
    h,
    creator,
    other,
    usage,
    book,
    handle,
    saved,
    actor,
    root,
    moveTenant: () => {
      tenant = {
        ...tenant,
        revision: 'changed',
        config: {
          ...tenant.config,
          subjects: [{ subject: principal.value.subject, tenant: 'b' }],
        },
      }
    },
  }
}

test('member-created schedule sessions appear only on that member’s chat rail and reserve personal usage', async () => {
  const { h, creator, other, book, handle, saved, actor, usage } = await setup()
  const response = await handle(
    asBearer('POST', `/v0/schedules/${saved.id}/run`, creator.credential),
  )
  expect(response.status).toBe(200)
  await book.idle()
  const run = value(
    await book.snapshot({ subject: 'legacy:admin', role: null }),
  ).runs[0]!
  expect(run.outcome).toBe('running')
  expect(h.book.ownerOf(run.sessionId!)).toBe(actor.subject)
  const own = await handle(
    asBearer('GET', '/fragments/chat/sessions', creator.credential),
  )
  const foreign = await handle(
    asBearer('GET', '/fragments/chat/sessions', other.credential),
  )
  expect(own.status).toBe(200)
  expect(await own.text()).toContain(run.sessionId!)
  expect(await foreign.text()).not.toContain(run.sessionId!)
  expect(h.chat.sent[0]!.usageReservation).toBeDefined()
  expect(
    (await usage.read(actor.subject)).rows.find(
      row => row.bucket === `person:${actor.subject}`,
    ),
  ).toMatchObject({ messages: 1, inFlight: 1, sessions: 1 })
})

test('revoked creator skips both manual and due runs without any chat calls or disabling the schedule', async () => {
  const { h, book, saved, actor } = await setup()
  expect(h.book.revoke(actor.subject, 'legacy:admin').ok).toBe(true)
  h.clock.advance(15 * 60_000)
  await book.tick()
  await book.idle()
  h.clock.advance(1)
  value(
    await book.runNow(saved.id, {
      subject: 'legacy:admin',
      role: null,
      requestId: 'ops-run',
    }),
  )
  await book.idle()
  const result = value(
    await book.snapshot({ subject: 'legacy:admin', role: null }),
  )
  expect(result.runs).toHaveLength(2)
  for (const run of result.runs)
    expect(run).toMatchObject({
      outcome: 'skipped',
      reason: expect.stringContaining('创建者已无权限'),
    })
  expect(result.schedules[0]!.enabled).toBe(true)
  expect(h.chat.opened).toBe(0)
  expect(h.chat.transcripts).toBe(0)
  expect(h.chat.sends).toBe(0)
})

test('exhausted quota skips a scheduled run with the HTTP quota reason and sends nothing', async () => {
  const { h, book, saved, actor } = await setup(0)
  const targets = h.chat.targets.bind(h.chat)
  let targetCalls = 0
  h.chat.targets = () => {
    targetCalls++
    return targets()
  }
  value(await book.runNow(saved.id, actor))
  await book.idle()
  expect(targetCalls).toBe(0)
  expect(
    value(await book.snapshot({ subject: 'legacy:admin', role: null })).runs[0],
  ).toMatchObject({
    outcome: 'skipped',
    reason: expect.stringContaining('quota'),
  })
  expect(h.chat.sends).toBe(0)
  expect(h.chat.opened).toBe(0)
  expect(h.chat.transcripts).toBe(0)
})

test('revoking a creator with an existing dedicated session makes due ticks call no chat methods', async () => {
  const { h, book, saved, actor } = await setup()
  value(await book.runNow(saved.id, actor))
  await book.idle()
  h.clock.advance(saved.timeoutMs)
  await book.tick()
  await book.idle()
  const pending = value(
    await book.snapshot({ subject: 'legacy:admin', role: null }),
  ).runs.find(run => run.state === 'unknown')!
  value(await book.resolve(saved.id, pending.runId, 'failed', actor))
  const reads = h.chat.transcripts
  expect(h.book.revoke(actor.subject, 'legacy:admin').ok).toBe(true)
  const targets = h.chat.targets.bind(h.chat)
  let targetCalls = 0
  h.chat.targets = () => {
    targetCalls++
    return targets()
  }
  h.clock.advance(15 * 60_000 - saved.timeoutMs)
  await book.tick()
  await book.idle()
  expect(targetCalls).toBe(0)
  expect(h.chat.transcripts).toBe(reads)
  expect(h.chat.opened).toBe(1)
  expect(h.chat.sends).toBe(1)
  expect(
    value(await book.snapshot({ subject: 'legacy:admin', role: null })).runs[0],
  ).toMatchObject({
    outcome: 'skipped',
    reason: expect.stringContaining('创建者已无权限'),
  })
})

test('a creator whose current role is viewer skips with zero chat effects', async () => {
  const { h, book, saved, actor } = await setup()
  const original = h.book.list.bind(h.book)
  // AccountBook has no role-edit API yet; this instance-local fake supplies
  // the authoritative account row a future role change will expose.
  h.book.list = () => {
    const result = original()
    return result.ok
      ? {
          ok: true,
          value: {
            ...result.value,
            accounts: result.value.accounts.map(row =>
              row.subject === actor.subject
                ? { ...row, role: 'viewer' as const }
                : row,
            ),
          },
        }
      : result
  }
  value(await book.runNow(saved.id, actor))
  await book.idle()
  expect(
    value(await book.snapshot({ subject: 'legacy:admin', role: null })).runs[0],
  ).toMatchObject({
    outcome: 'skipped',
    reason: expect.stringContaining('只读账号'),
  })
  expect(h.chat.opened).toBe(0)
  expect(h.chat.transcripts).toBe(0)
  expect(h.chat.sends).toBe(0)
})

test('revocation during transcript I/O is rechecked before quota and send', async () => {
  const { h, book, saved, actor, usage } = await setup()
  const transcript = h.chat.transcript.bind(h.chat)
  h.chat.transcript = async id => {
    expect(h.book.revoke(actor.subject, 'legacy:admin').ok).toBe(true)
    return transcript(id)
  }
  value(await book.runNow(saved.id, actor))
  await book.idle()
  expect(
    value(await book.snapshot({ subject: 'legacy:admin', role: null })).runs[0],
  ).toMatchObject({
    outcome: 'skipped',
    reason: expect.stringContaining('创建者已无权限'),
  })
  expect(h.chat.sends).toBe(0)
  expect(
    (await usage.read(actor.subject)).rows.find(
      row => row.bucket === `person:${actor.subject}`,
    ),
  ).toMatchObject({ messages: 0, inFlight: 0 })
})

test('removing the creator’s tenant scope skips before opening or reading a chat session', async () => {
  const { h, book, saved, actor, moveTenant } = await setup(10, true)
  moveTenant()
  value(await book.runNow(saved.id, actor))
  await book.idle()
  expect(
    value(await book.snapshot({ subject: 'legacy:admin', role: null })).runs[0],
  ).toMatchObject({
    outcome: 'skipped',
    reason: expect.stringContaining('资源不存在'),
  })
  expect(h.chat.opened).toBe(0)
  expect(h.chat.transcripts).toBe(0)
  expect(h.chat.sends).toBe(0)
})

test('an endpoint removed from the dialable list skips a reused session, then a later authorized slot runs', async () => {
  const { h, book, saved, actor } = await setup()
  value(await book.runNow(saved.id, actor))
  await book.idle()
  h.clock.advance(saved.timeoutMs)
  await book.tick()
  await book.idle()
  const pending = value(
    await book.snapshot({ subject: 'legacy:admin', role: null }),
  ).runs.find(run => run.state === 'unknown')!
  value(await book.resolve(saved.id, pending.runId, 'failed', actor))
  const original = h.chat.targets.bind(h.chat)
  h.chat.targets = async () => {
    const result = await original()
    return result.ok
      ? {
          ok: true,
          value: result.value.map(row => ({ ...row, dialable: false })),
        }
      : result
  }
  const reads = h.chat.transcripts
  value(await book.runNow(saved.id, actor))
  await book.idle()
  expect(
    value(await book.snapshot({ subject: 'legacy:admin', role: null })).runs[0],
  ).toMatchObject({
    outcome: 'skipped',
    reason: expect.stringContaining('允许名单'),
  })
  expect(h.chat.transcripts).toBe(reads)
  expect(h.chat.sends).toBe(1)
  h.chat.targets = original
  h.clock.advance(1)
  value(await book.runNow(saved.id, actor))
  await book.idle()
  expect(
    value(await book.snapshot({ subject: 'legacy:admin', role: null })).runs[0],
  ).toMatchObject({
    outcome: 'running',
  })
  expect(h.chat.sends).toBe(2)
  expect(h.chat.opened).toBe(1)
})

test('tenant quota is derived from the creator instead of the runner or system schedules', async () => {
  const { h, book, saved, actor, usage } = await setup(10, true)
  value(
    await book.runNow(saved.id, {
      subject: 'legacy:admin',
      role: null,
      requestId: 'ops',
    }),
  )
  await book.idle()
  const rows = (await usage.read()).rows
  expect(rows.find(row => row.bucket === 'tenant:a')).toMatchObject({
    messages: 1,
    inFlight: 1,
  })
  expect(
    rows.find(row => row.bucket === `person:${actor.subject}`),
  ).toMatchObject({ messages: 1 })
  expect(
    rows.some(
      row =>
        row.bucket === 'person:legacy:admin' ||
        row.bucket === 'person:system:schedules',
    ),
  ).toBe(false)
  expect(h.chat.sent[0]!.usageReservation).toBeDefined()
})

for (const foreignOwner of [false, true]) {
  test(
    foreignOwner
      ? 'a recovered dedicated session owned by another member is neither reassigned nor sent'
      : 'an ownerless P24 session is registered to its creator on recovery and reused',
    async () => {
      const { h, other, book, saved, actor, usage, root } = await setup()
      const session = value(await h.chat.open(ADDRESS))
      const principal = h.book.bearerPrincipal(other.credential)
      if (!principal.ok || principal.value.kind !== 'user')
        throw new Error('fixture account unavailable')
      if (foreignOwner)
        expect(h.book.recordOwner(session.id, principal.value.subject).ok).toBe(
          true,
        )
      book.close()
      const statePath = path.join(root, 'schedules', 'schedules.json')
      const state = JSON.parse(await Bun.file(statePath).text()) as {
        schedules: { sessionId: string | null }[]
      }
      state.schedules[0]!.sessionId = session.id
      await Bun.write(statePath, JSON.stringify(state))
      const recovered = new ConsoleSchedules({
        directory: path.join(root, 'schedules'),
        estopPath: path.join(root, 'ESTOP'),
        chat: h.chat,
        accounts: { book: h.book },
        usage,
        now: h.clock.now,
      })
      books.push(recovered)
      value(await recovered.runNow(saved.id, actor))
      await recovered.idle()
      const run = value(
        await recovered.snapshot({ subject: 'legacy:admin', role: null }),
      ).runs[0]!
      if (foreignOwner) {
        expect(run).toMatchObject({
          outcome: 'skipped',
          reason: expect.stringContaining('创建者已无权限'),
        })
        expect(h.book.ownerOf(session.id)).toBe(principal.value.subject)
        expect(h.chat.sends).toBe(0)
      } else {
        expect(run.outcome).toBe('running')
        expect(h.book.ownerOf(session.id)).toBe(actor.subject)
        expect(h.chat.sent[0]!.sessionId).toBe(session.id)
        expect(h.chat.opened).toBe(1)
      }
    },
  )
}
