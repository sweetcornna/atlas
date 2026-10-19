// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ActionLedger,
  FileUsageStore,
  createConsoleHandler,
  type ConsoleResult,
  type DirectionActor,
  type ScheduleDraft,
  type SchedulesSnapshot,
} from '@qianmo/console'
import {
  ADDRESS,
  LIMITS,
  TOKENS,
  MemoryLedger,
  accountsHarness,
  asBearer,
  person,
} from '../../../console/test/accountsHarness.js'
import { ConsoleSchedules } from '../../src/commands/consoleSchedules.js'

class MemoryActionStore extends MemoryLedger {
  stamp(): string | null {
    return this.text
  }
}

const stores: FileUsageStore[] = []
const roots: string[] = [],
  books: ConsoleSchedules[] = []
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
const draft: ScheduleDraft = {
  title: 'private schedule',
  prompt: 'owner-only prompt',
  target: ADDRESS,
  template: 'custom',
  when: { kind: 'interval', everyMinutes: 15 },
  timezone: 'UTC',
  direction: 'medium',
  channels: [],
  enabled: false,
  notifyOnlyAgent: false,
  timeoutMs: 1000,
}

async function fixture(withUsage = false) {
  const h = accountsHarness()
  const a = await person(h.handle),
    b = await person(h.handle),
    viewer = await person(h.handle, 'viewer'),
    ops = await person(h.handle, 'ops')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-isolation-'))
  roots.push(root)
  const usage = withUsage
    ? new FileUsageStore({
        path: path.join(root, 'usage.ndjson'),
        now: h.clock.now,
        monotonic: h.clock.now,
        policy: {
          mode: 'enforce',
          person: { inFlight: 1, messages: 10 },
          job: {},
          global: {},
        },
      })
    : undefined
  if (usage) {
    stores.push(usage)
    const send = h.chat.send.bind(h.chat)
    h.chat.send = async input => {
      const result = await send(input)
      return result.ok
        ? {
            ok: true,
            value: {
              ...result.value,
              usageReservation: input.usageReservation,
            },
          }
        : result
    }
  }
  const ledgerStore = new MemoryActionStore()
  const actions = new ActionLedger({ store: ledgerStore, now: h.clock.now })
  const book = new ConsoleSchedules({
    directory: path.join(root, 'schedules'),
    estopPath: path.join(root, 'ESTOP'),
    chat: h.chat,
    accounts: { book: h.book },
    ...(usage ? { usage } : {}),
    actions,
    now: h.clock.now,
    pushOptions: {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    },
  })
  books.push(book)
  const actor = (credential: string): DirectionActor => {
    const principal = h.book.bearerPrincipal(credential)
    if (!principal.ok || principal.value.kind !== 'user')
      throw new Error('no principal')
    return {
      subject: principal.value.subject,
      role: principal.value.role,
      requestId: 'isolation',
    }
  }
  const own = value(await book.save(draft, actor(a.credential)))
  const viewOwn = value(
    await book.save(
      { ...draft, prompt: 'former member prompt' },
      { ...actor(viewer.credential), role: 'member' },
    ),
  )
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
      chat: h.chat,
      schedules: book,
      actions,
      now: h.clock.now,
    },
    TOKENS,
    { book: h.book },
  )
  return {
    h,
    a,
    b,
    viewer,
    ops,
    book,
    own,
    viewOwn,
    handle,
    actor,
    actions,
    ledgerStore,
    usage,
    root,
  }
}

test('members and viewers read only their own prompts, run records and excerpts across API and jobs fragments', async () => {
  const f = await fixture()
  const send = f.h.chat.send.bind(f.h.chat)
  f.h.chat.send = async input => {
    const result = await send(input)
    return result.ok
      ? { ok: true, value: { ...result.value, taskId: 'isolation-task' } }
      : result
  }
  const transcript = f.h.chat.transcript.bind(f.h.chat)
  f.h.chat.transcript = async id => {
    const result = await transcript(id)
    return result.ok && f.h.chat.sends > 0
      ? {
          ok: true,
          value: {
            ...result.value,
            turns: [
              {
                id: 'private-reply',
                sessionId: id,
                taskId: 'isolation-task',
                author: 'agent',
                at: f.h.clock.now(),
                text: 'private reply excerpt',
                state: 'done',
                remoteTerminal: true,
              },
            ],
          },
        }
      : result
  }
  value(await f.book.runNow(f.own.id, f.actor(f.a.credential)))
  await f.book.idle()
  for (const [credential, expected] of [
    [f.a.credential, f.own.id],
    [f.b.credential, undefined],
    [f.viewer.credential, f.viewOwn.id],
  ] as const) {
    const response = await f.handle(
      asBearer('GET', '/v0/schedules', credential),
    )
    expect(response.status).toBe(200)
    const snapshot = (await response.json()) as SchedulesSnapshot
    expect(snapshot.schedules.map(v => v.id)).toEqual(
      expected === undefined ? [] : [expected],
    )
    expect(snapshot.runs.map(v => v.scheduleId)).toEqual(
      credential === f.a.credential ? [f.own.id] : [],
    )
    if (credential === f.a.credential)
      expect(snapshot.runs[0]!.excerpt).toBe('private reply excerpt')
    const page = await (
      await f.handle(asBearer('GET', '/fragments/schedules', credential))
    ).text()
    if (credential !== f.a.credential) {
      expect(page).not.toContain(f.own.id)
      expect(JSON.stringify(snapshot)).not.toContain('owner-only prompt')
      expect(JSON.stringify(snapshot)).not.toContain('private reply excerpt')
    }
  }
  for (const credential of [f.ops.credential, TOKENS.admin!]) {
    const snapshot = (await (
      await f.handle(asBearer('GET', '/v0/schedules', credential))
    ).json()) as SchedulesSnapshot
    expect(snapshot.schedules).toHaveLength(2)
    expect(snapshot.runs).toHaveLength(1)
  }
})

test('foreign details, histories and all writes return 404 before admission or business port calls', async () => {
  const f = await fixture()
  let portCalls = 0
  // Instance-local counting wrappers; visibility uses only the ownership index.
  const originalSnapshot = f.book.snapshot.bind(f.book)
  f.book.snapshot = async actor => {
    portCalls++
    return originalSnapshot(actor)
  }
  const originalSave = f.book.save.bind(f.book)
  f.book.save = async (draft, actor) => {
    portCalls++
    return originalSave(draft, actor)
  }
  const originalEnable = f.book.setEnabled.bind(f.book)
  f.book.setEnabled = async (id, enabled, actor) => {
    portCalls++
    return originalEnable(id, enabled, actor)
  }
  const originalRemove = f.book.remove.bind(f.book)
  f.book.remove = async (id, actor) => {
    portCalls++
    return originalRemove(id, actor)
  }
  const originalRun = f.book.runNow.bind(f.book)
  f.book.runNow = async (id, actor) => {
    portCalls++
    return originalRun(id, actor)
  }
  const originalResolve = f.book.resolve.bind(f.book)
  f.book.resolve = async (id, runId, outcome, actor) => {
    portCalls++
    return originalResolve(id, runId, outcome, actor)
  }
  const ledgerBefore = f.ledgerStore.read()
  for (const credential of [f.b.credential, f.viewer.credential]) {
    for (const [method, suffix, body] of [
      ['GET', '', undefined],
      ['GET', '/runs', undefined],
      ['GET', '/runs/hidden', undefined],
      ['POST', '/enable', undefined],
      ['POST', '/disable', undefined],
      ['POST', '/run', undefined],
      ['POST', '/runs/hidden/resolve', { outcome: 'ok' }],
      ['DELETE', '', undefined],
    ] as const) {
      const response = await f.handle(
        asBearer(
          method,
          `/v0/schedules/${f.own.id}${suffix}`,
          credential,
          body,
        ),
      )
      expect(response.status).toBe(404)
    }
    expect(
      (
        await f.handle(
          asBearer('POST', '/v0/schedules', credential, {
            ...draft,
            id: f.own.id,
            prompt: 'tamper',
          }),
        )
      ).status,
    ).toBe(404)
  }
  expect(portCalls).toBe(0)
  expect(f.ledgerStore.read()).toBe(ledgerBefore)
  expect(f.h.chat.opened).toBe(0)
  expect(f.h.chat.transcripts).toBe(0)
  expect(f.h.chat.sends).toBe(0)
})

test('the shared host path denies foreign updates; delegated ops retains creator in the persistent ledger', async () => {
  const f = await fixture()
  const before = f.ledgerStore.read()
  expect(
    await f.book.save({ ...draft, id: f.own.id }, f.actor(f.b.credential)),
  ).toMatchObject({ ok: false, failure: { code: 'not_found' } })
  expect(
    await f.book.setEnabled(f.own.id, false, f.actor(f.b.credential)),
  ).toMatchObject({ ok: false, failure: { code: 'not_found' } })
  expect(await f.book.remove(f.own.id, f.actor(f.b.credential))).toMatchObject({
    ok: false,
    failure: { code: 'not_found' },
  })
  expect(await f.book.runNow(f.own.id, f.actor(f.b.credential))).toMatchObject({
    ok: false,
    failure: { code: 'not_found' },
  })
  expect(f.ledgerStore.read()).toBe(before)
  const changed = value(
    await f.book.save(
      { ...draft, id: f.own.id, prompt: 'delegated edit' },
      f.actor(f.ops.credential),
    ),
  )
  expect(changed.createdBy).toBe(f.own.createdBy)
  const reopened = new ActionLedger({
    store: f.ledgerStore,
    now: f.h.clock.now,
  })
  expect(value(await reopened.list({})).entries[0]).toMatchObject({
    subject: f.actor(f.ops.credential).subject,
    createdBy: f.own.createdBy,
    target: f.own.id,
    action: 'schedule.save',
  })
})

test('shared channels remain selectable by members and never return a URL to viewers', async () => {
  const f = await fixture()
  const secret = 'https://notice.test/private-key?token=fixture-secret'
  const channel = value(
    await f.book.saveChannel(
      { name: 'shared', kind: 'webhook', url: secret },
      f.actor(f.ops.credential),
    ),
  )
  const chosen = value(
    await f.book.save(
      { ...draft, channels: [channel.id] },
      f.actor(f.a.credential),
    ),
  )
  expect(chosen.channels).toEqual([channel.id])
  const response = await f.handle(
    asBearer('GET', '/v0/schedules', f.viewer.credential),
  )
  const snapshot = (await response.json()) as SchedulesSnapshot
  expect(snapshot.channels).toEqual([channel])
  expect(JSON.stringify(snapshot)).not.toContain('private-key')
  expect(JSON.stringify(snapshot)).not.toContain('fixture-secret')
  const legacy = value(await f.book.snapshot({ subject: 'legacy:admin' }))
  expect(legacy.schedules).toHaveLength(3)
})

test('the creator confirms unknown results through the API and only unknown runs can be resolved', async () => {
  const f = await fixture()
  const run = value(await f.book.runNow(f.own.id, f.actor(f.a.credential)))
  await f.book.idle()
  const route = `/v0/schedules/${f.own.id}/runs/${run.runId}/resolve`
  expect(
    (await f.handle(asBearer('POST', route, f.a.credential, { outcome: 'ok' })))
      .status,
  ).toBe(400)
  f.h.clock.advance(draft.timeoutMs)
  await f.book.tick()
  await f.book.idle()
  expect(
    (
      await f.handle(
        asBearer('POST', route, f.a.credential, { outcome: 'timeout' }),
      )
    ).status,
  ).toBe(400)
  const confirmed = await f.handle(
    asBearer('POST', route, f.a.credential, { outcome: 'ok' }),
  )
  expect(confirmed.status).toBe(200)
  expect(await confirmed.json()).toMatchObject({
    state: 'completed',
    outcome: 'completed',
    runId: run.runId,
  })
  expect(value(await f.actions.list({})).entries[0]).toMatchObject({
    action: 'schedule.resolve',
    subject: f.own.createdBy,
    createdBy: f.own.createdBy,
  })
  expect(
    (
      await f.handle(
        asBearer('POST', `/v0/schedules/${f.own.id}/run`, f.a.credential),
      )
    ).status,
  ).toBe(200)
  await f.book.idle()
  expect(f.h.chat.sends).toBe(2)
})

test('manual confirmation after restart releases its recorded usage reservation so in-flight quota permits another run', async () => {
  const f = await fixture(true)
  const run = value(await f.book.runNow(f.own.id, f.actor(f.a.credential)))
  await f.book.idle()
  f.h.clock.advance(draft.timeoutMs)
  await f.book.tick()
  await f.book.idle()
  expect((await f.usage!.read(f.own.createdBy)).rows[0]!.inFlight).toBe(1)
  f.book.close()
  const recovered = new ConsoleSchedules({
    directory: path.join(f.root, 'schedules'),
    estopPath: path.join(f.root, 'ESTOP'),
    chat: f.h.chat,
    accounts: { book: f.h.book },
    usage: f.usage,
    actions: f.actions,
    now: f.h.clock.now,
  })
  books.push(recovered)
  value(
    await recovered.resolve(
      f.own.id,
      run.runId,
      'failed',
      f.actor(f.a.credential),
    ),
  )
  expect((await f.usage!.read(f.own.createdBy)).rows[0]!.inFlight).toBe(0)
  value(await recovered.runNow(f.own.id, f.actor(f.a.credential)))
  await recovered.idle()
  expect(f.h.chat.sends).toBe(2)
  expect((await f.usage!.read(f.own.createdBy)).rows[0]!.inFlight).toBe(1)
})
