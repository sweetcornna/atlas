// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createConsoleHandler,
  type ActionLedgerPort,
  type ChatSendInput,
  type ChatSession,
  type ChatTranscript,
  type ChatTurn,
  type ConsoleResult,
  type DirectionActor,
  type NotifyChannelView,
  type ScheduleDraft,
  type SchedulesSnapshot,
  type ScheduleView,
  type TenantSnapshot,
} from '@qianmo/console'
import {
  CountingChat,
  LIMITS,
  START,
  TOKENS,
  accountsHarness,
  asBearer,
  person,
} from '../../../console/test/accountsHarness.js'
import type { ScheduleNotification } from '../../src/commands/consoleNotifyChannels.js'
import { ConsoleSchedules } from '../../src/commands/consoleSchedules.js'

const TOKYO = 'qianmo://tokyo-1/planner'
const BERLIN = 'qianmo://berlin-1/planner'

/** Two tenants' agents, with transcripts that can carry a finished reply. */
class TenantChat extends CountingChat {
  readonly turns = new Map<string, ChatTurn[]>()
  override async targets() {
    return {
      ok: true as const,
      value: [TOKYO, BERLIN].map(address => ({
        address,
        node: new URL(address).hostname,
        agent: 'planner',
        endpoint: 'ws://127.0.0.1:38611/',
        status: 'online' as const,
        dialable: true,
      })),
    }
  }
  override async open(target: string): Promise<ConsoleResult<ChatSession>> {
    const opened = await super.open(target)
    if (opened.ok) {
      const session = { ...opened.value, node: new URL(target).hostname }
      this.sessionsById.set(session.id, session)
      this.turns.set(session.id, [])
      return { ok: true, value: session }
    }
    return opened
  }
  override async transcript(
    sessionId: string,
  ): Promise<ConsoleResult<ChatTranscript>> {
    this.transcripts += 1
    const session = this.sessionsById.get(sessionId)
    return session === undefined
      ? { ok: false, failure: { code: 'not_found', message: 'deleted' } }
      : { ok: true, value: { session, turns: this.turns.get(sessionId)! } }
  }
  override async send(input: ChatSendInput): Promise<ConsoleResult<ChatTurn>> {
    this.sends += 1
    this.sent.push(input)
    const taskId = `task-${this.sends}`
    const turn: ChatTurn = {
      id: `turn-${this.sends}`,
      sessionId: input.sessionId,
      author: 'operator',
      at: START,
      text: input.text,
      state: 'delivered',
      taskId,
    }
    this.turns.get(input.sessionId)!.push(turn, {
      id: `reply-${this.sends}`,
      sessionId: input.sessionId,
      author: 'agent',
      at: START,
      text: '简报已写好',
      state: 'done',
      taskId,
    })
    return { ok: true, value: turn }
  }
}

const roots: string[] = []
const books: ConsoleSchedules[] = []
afterEach(async () => {
  for (const book of books.splice(0)) {
    await book.idle()
    book.close()
  }
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

function value<T>(result: ConsoleResult<T>): T {
  if (!result.ok) throw new Error(result.failure.message)
  return result.value
}

function draft(target: string, channels: string[] = []): ScheduleDraft {
  return {
    title: '晨间简报',
    target,
    template: 'briefing',
    prompt: '写一份简报',
    when: { kind: 'daily', time: '08:00' },
    timezone: 'Asia/Shanghai',
    direction: 'medium',
    channels,
    notifyOnlyAgent: false,
    enabled: true,
    timeoutMs: 600_000,
  }
}

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-tenancy-'))
  roots.push(root)
  const h = accountsHarness()
  const subjectOf = (credential: string) => {
    const principal = h.book.bearerPrincipal(credential)
    if (!principal.ok || principal.value.kind !== 'user')
      throw new Error('fixture account unavailable')
    return principal.value.subject
  }
  const alice = await person(h.handle, 'member')
  const aliceOps = await person(h.handle, 'ops')
  const bob = await person(h.handle, 'member')
  const bobOps = await person(h.handle, 'ops')
  const platform = await person(h.handle, 'ops')
  const who = {
    alice: subjectOf(alice.credential),
    aliceOps: subjectOf(aliceOps.credential),
    bob: subjectOf(bob.credential),
    bobOps: subjectOf(bobOps.credential),
    platform: subjectOf(platform.credential),
  }
  let tenant: TenantSnapshot = {
    revision: 'initial',
    config: {
      version: 1,
      hubServer: 'hub',
      tenants: [{ id: 'a' }, { id: 'b' }],
      subjects: [
        { subject: who.alice, tenant: 'a' },
        { subject: who.aliceOps, tenant: 'a' },
        { subject: who.bob, tenant: 'b' },
        { subject: who.bobOps, tenant: 'b' },
      ],
      nodes: [
        {
          nodeId: 'tokyo-1',
          tenant: 'a',
          server: 'server-a',
          memoryRoot: path.join(root, 'a'),
        },
        {
          nodeId: 'berlin-1',
          tenant: 'b',
          server: 'server-b',
          memoryRoot: path.join(root, 'b'),
        },
      ],
      jobs: [],
      platformSubjects: [who.platform],
    },
  }
  const tenancy = { read: () => tenant, subscribe: () => () => {} }
  let admissions = 0
  const actions: ActionLedgerPort = {
    async admit() {
      admissions++
      return { ok: true, value: undefined }
    },
    async record() {
      return { ok: true, value: undefined }
    },
    async list() {
      return { ok: true, value: { entries: [], nextBeforeSeq: null } }
    },
  }
  const chat = new TenantChat()
  const notices: ScheduleNotification[] = []
  const book = new ConsoleSchedules({
    directory: path.join(root, 'schedules'),
    estopPath: path.join(root, 'ESTOP'),
    chat,
    accounts: { book: h.book },
    tenancy,
    actions,
    now: h.clock.now,
    pushOptions: {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    },
    push: async (_kind, _url, notice) => {
      notices.push(notice)
      return { ok: true, error: null, attempts: 1 }
    },
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
      chat,
      schedules: book,
      tenancy,
      actions,
    },
    TOKENS,
    { book: h.book },
  )
  const call = async (
    credential: string,
    method: string,
    route: string,
    body?: unknown,
  ) => {
    const response = await handle(asBearer(method, route, credential, body))
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    }
  }
  const actor = (subject: string, role: DirectionActor['role']) => ({
    subject,
    role,
    requestId: 'direct',
  })
  return {
    alice,
    aliceOps,
    bob,
    bobOps,
    platform,
    who,
    book,
    chat,
    notices,
    call,
    actor,
    admissions: () => admissions,
    move(nodes: Record<string, string>, subjects: Record<string, string>) {
      tenant = {
        revision: `${tenant.revision}+`,
        config: {
          ...tenant.config,
          nodes: tenant.config.nodes.map(row => ({
            ...row,
            tenant: nodes[row.nodeId] ?? row.tenant,
          })),
          subjects: tenant.config.subjects.map(row => ({
            ...row,
            tenant: subjects[row.subject] ?? row.tenant,
          })),
        },
      }
    },
  }
}

test('a tenant reads, creates and drives only schedules aimed at its own agents', async () => {
  const t = await setup()
  const own = await t.call(
    t.alice.credential,
    'POST',
    '/v0/schedules',
    draft(TOKYO),
  )
  expect(own.status).toBe(200)
  const foreign = await t.call(
    t.bob.credential,
    'POST',
    '/v0/schedules',
    draft(BERLIN),
  )
  expect(foreign.status).toBe(200)
  const ownId = (own.body as ScheduleView).id
  const foreignId = (foreign.body as ScheduleView).id
  value(await t.book.runNow(foreignId, t.actor(t.who.bob, 'member')))
  await t.book.idle()

  // Tenant ops may manage every schedule of its tenant, never another's.
  const listed = (await t.call(t.aliceOps.credential, 'GET', '/v0/schedules'))
    .body as SchedulesSnapshot
  expect(listed.schedules.map(row => row.id)).toEqual([ownId])
  expect(listed.targets).toEqual([TOKYO])
  expect(listed.runs).toEqual([])
  const everything = (
    await t.call(t.platform.credential, 'GET', '/v0/schedules')
  ).body as SchedulesSnapshot
  expect(everything.schedules.map(row => row.id).sort()).toEqual(
    [ownId, foreignId].sort(),
  )
  expect(everything.runs.map(row => row.target)).toEqual([BERLIN])

  const admitted = t.admissions()
  const sends = t.chat.sends
  for (const [method, route, body] of [
    ['GET', `/v0/schedules/${foreignId}`],
    ['GET', `/v0/schedules/${foreignId}/runs`],
    ['POST', `/v0/schedules/${foreignId}/run`],
    ['POST', `/v0/schedules/${foreignId}/disable`],
    ['DELETE', `/v0/schedules/${foreignId}`],
    ['POST', '/v0/schedules', { ...draft(TOKYO), id: foreignId }],
    ['POST', '/v0/schedules', draft(BERLIN)],
  ] as const) {
    const answer = await t.call(t.aliceOps.credential, method, route, body)
    expect(answer.status).toBe(404)
  }
  // Refused before the ledger admission and before any chat effect.
  expect(t.admissions()).toBe(admitted)
  expect(t.chat.sends).toBe(sends)
  expect(
    value(await t.book.snapshot(t.actor('legacy:admin', null))).schedules,
  ).toHaveLength(2)

  const ran = await t.call(
    t.aliceOps.credential,
    'POST',
    `/v0/schedules/${ownId}/run`,
  )
  expect(ran.status).toBe(200)
  await t.book.idle()
  expect(t.chat.sent.at(-1)?.text).toBe('写一份简报')
})

test('a run stays with the tenant whose agent it went to', async () => {
  const t = await setup()
  const made = await t.call(
    t.platform.credential,
    'POST',
    '/v0/schedules',
    draft(TOKYO),
  )
  const id = (made.body as ScheduleView).id
  value(await t.book.runNow(id, t.actor(t.who.platform, 'ops')))
  await t.book.idle()
  // Platform re-aims the schedule at the other tenant's agent.
  const moved = await t.call(t.platform.credential, 'POST', '/v0/schedules', {
    ...draft(BERLIN),
    id,
  })
  expect(moved.status).toBe(200)
  const a = (await t.call(t.aliceOps.credential, 'GET', '/v0/schedules'))
    .body as SchedulesSnapshot
  const b = (await t.call(t.bobOps.credential, 'GET', '/v0/schedules'))
    .body as SchedulesSnapshot
  // Tenant a keeps the run on its own agent, not the schedule now aimed away.
  expect(a.schedules).toEqual([])
  expect(a.runs.map(row => row.target)).toEqual([TOKYO])
  // Tenant b gets the schedule without tenant a's reply in it.
  expect(b.schedules.map(row => [row.id, row.lastRun])).toEqual([[id, null]])
  expect(b.runs).toEqual([])
  expect(JSON.stringify(b)).not.toContain('简报已写好')
  const all = value(await t.book.snapshot(t.actor('legacy:admin', null)))
  expect(all.schedules[0]?.lastRun?.excerpt).toBe('简报已写好')
})

test('channels belong to the tenant that made them and never cross it', async () => {
  const t = await setup()
  const mine = await t.call(t.aliceOps.credential, 'POST', '/v0/channels', {
    name: '团队群',
    kind: 'webhook',
    url: 'https://hooks.example/a',
  })
  expect(mine.status).toBe(200)
  expect(mine.body).toMatchObject({ tenant: 'a', host: 'hooks.example' })
  const shared = await t.call(t.platform.credential, 'POST', '/v0/channels', {
    name: '平台值班',
    kind: 'webhook',
    url: 'https://hooks.example/platform',
  })
  expect(shared.body).toMatchObject({ tenant: null })
  const theirs = await t.call(t.platform.credential, 'POST', '/v0/channels', {
    tenant: 'b',
    name: 'B 群',
    kind: 'webhook',
    url: 'https://hooks.example/b',
  })
  expect(theirs.body).toMatchObject({ tenant: 'b' })
  const mineId = (mine.body as NotifyChannelView).id
  const sharedId = (shared.body as NotifyChannelView).id
  const theirsId = (theirs.body as NotifyChannelView).id

  const seen = (await t.call(t.alice.credential, 'GET', '/v0/schedules'))
    .body as SchedulesSnapshot
  expect(seen.channels.map(row => row.id)).toEqual([mineId])
  expect(JSON.stringify(seen)).not.toContain('B 群')

  const admitted = t.admissions()
  for (const [method, route, body] of [
    ['POST', `/v0/channels/${theirsId}/test`],
    ['DELETE', `/v0/channels/${sharedId}`],
    ['POST', '/v0/channels', { id: theirsId, name: 'x', kind: 'webhook' }],
    [
      'POST',
      '/v0/channels',
      {
        tenant: 'b',
        name: 'x',
        kind: 'webhook',
        url: 'https://hooks.example/x',
      },
    ],
  ] as const) {
    const answer = await t.call(t.aliceOps.credential, method, route, body)
    expect(answer.status).toBe(404)
  }
  for (const channels of [[sharedId], [theirsId]]) {
    const answer = await t.call(
      t.alice.credential,
      'POST',
      '/v0/schedules',
      draft(TOKYO, channels),
    )
    expect(answer.status).toBe(404)
  }
  expect(t.admissions()).toBe(admitted)
  const ok = await t.call(
    t.alice.credential,
    'POST',
    '/v0/schedules',
    draft(TOKYO, [mineId]),
  )
  expect(ok.status).toBe(200)

  // The host refuses a tenant's channel on another tenant's agent even for
  // platform, and a platform-only channel for a tenant member.
  const crossed = await t.book.save(
    draft(TOKYO, [theirsId]),
    t.actor(t.who.platform, 'ops'),
  )
  expect(crossed).toMatchObject({ ok: false, failure: { code: 'invalid' } })
  const borrowed = await t.book.save(
    draft(TOKYO, [sharedId]),
    t.actor(t.who.alice, 'member'),
  )
  expect(borrowed).toMatchObject({ ok: false, failure: { code: 'invalid' } })
  expect(
    await t.book.testChannel(theirsId, t.actor(t.who.aliceOps, 'ops')),
  ).toMatchObject({ ok: false, failure: { code: 'not_found' } })
  expect(
    await t.book.saveChannel(
      { id: theirsId, tenant: 'a', name: 'x', kind: 'webhook' },
      t.actor(t.who.platform, 'ops'),
    ),
  ).toMatchObject({ ok: false, failure: { code: 'invalid' } })
})

test('a channel never carries a result once its agent belongs to another tenant', async () => {
  const t = await setup()
  const channel = value(
    await t.book.saveChannel(
      { name: '团队群', kind: 'webhook', url: 'https://hooks.example/a' },
      t.actor(t.who.aliceOps, 'ops'),
    ),
  )
  const alice = t.actor(t.who.alice, 'member')
  const schedule = value(await t.book.save(draft(TOKYO, [channel.id]), alice))
  value(await t.book.runNow(schedule.id, alice))
  await t.book.idle()
  // Positive control: the same tenant's channel is pushed.
  expect(t.notices).toHaveLength(1)
  let runs = value(await t.book.snapshot(alice)).runs
  expect(runs[0]).toMatchObject({
    outcome: 'completed',
    target: TOKYO,
    pushed: [{ channelId: channel.id, ok: true }],
  })

  // The agent and its member move to tenant b; the run is still authorized.
  t.move({ 'tokyo-1': 'b' }, { [t.who.alice]: 'b' })
  value(await t.book.runNow(schedule.id, alice))
  await t.book.idle()
  expect(t.notices).toHaveLength(1)
  runs = value(await t.book.snapshot(alice)).runs
  expect(runs[0]).toMatchObject({
    outcome: 'completed',
    pushed: [
      {
        channelId: channel.id,
        ok: false,
        error: '通知渠道不属于任务所在租户',
      },
    ],
  })
})
