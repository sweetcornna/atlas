// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  ActionLedgerPort,
  ChatPort,
  ChatSendInput,
  ChatSession,
  ChatTranscript,
  ChatTurn,
  ChatUpdate,
  ConsoleAction,
  ConsoleResult,
  DirectionActor,
  ScheduleDraft,
  SchedulesSnapshot,
} from '@qianmo/console'
import { ConsoleSchedules } from '../../src/commands/consoleSchedules.js'
import type { ScheduleNotification } from '../../src/commands/consoleNotifyChannels.js'

const TARGET = 'qianmo://node-b/helper'
const START = Date.parse('2026-10-11T00:07:00Z')
const STEP = 15 * 60_000
const actor: DirectionActor = {
  subject: 'u:0123456789abcdef',
  role: 'ops',
  requestId: 'request-1',
}
function value<T>(result: ConsoleResult<T>): T {
  if (!result.ok) throw new Error(result.failure.message)
  return result.value
}
function draft(patch: Partial<ScheduleDraft> = {}): ScheduleDraft {
  return {
    title: '晨间任务',
    target: TARGET,
    template: 'custom',
    prompt: '请写简报',
    when: { kind: 'interval', everyMinutes: 15 },
    timezone: 'Asia/Shanghai',
    direction: 'chat',
    channels: [],
    notifyOnlyAgent: false,
    enabled: true,
    timeoutMs: 600_000,
    ...patch,
  }
}

class FakeChat implements ChatPort {
  readonly records = new Map<string, ChatTranscript>()
  readonly sent: ChatSendInput[] = []
  readonly listeners = new Set<(update: ChatUpdate) => void>()
  clock: () => number = () => START
  autoReply: string | null = null
  sendError = false
  async targets() {
    return {
      ok: true as const,
      value: [
        {
          address: TARGET,
          node: 'node-b',
          agent: 'helper',
          endpoint: 'ws://127.0.0.1:1234',
          status: 'online',
          dialable: true,
        },
        {
          address: 'qianmo://other/denied',
          node: 'other',
          agent: 'denied',
          endpoint: 'ws://remote:1234',
          status: 'online',
          dialable: false,
        },
      ],
    }
  }
  async sessions() {
    return {
      ok: true as const,
      value: [...this.records.values()].map(record => record.session),
    }
  }
  async open(target: string) {
    const session: ChatSession = {
      id: crypto.randomUUID(),
      target,
      node: 'node-b',
      agent: 'helper',
      createdAt: this.clock(),
      updatedAt: this.clock(),
      turnCount: 0,
      preview: '',
    }
    this.records.set(session.id, { session, turns: [] })
    this.emit(session.id)
    return { ok: true as const, value: session }
  }
  async transcript(sessionId: string): Promise<ConsoleResult<ChatTranscript>> {
    const record = this.records.get(sessionId)
    return record
      ? { ok: true, value: record }
      : { ok: false, failure: { code: 'not_found', message: 'deleted' } }
  }
  async send(input: ChatSendInput): Promise<ConsoleResult<ChatTurn>> {
    this.sent.push(input)
    if (this.sendError)
      return {
        ok: false,
        failure: { code: 'unreachable', message: 'transport failed' },
      }
    const turn: ChatTurn = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      text: input.text,
      author: 'operator',
      at: this.clock(),
      state: 'delivered',
      taskId: crypto.randomUUID(),
    }
    this.add(turn)
    if (this.autoReply !== null) this.reply(input.sessionId, this.autoReply)
    return { ok: true, value: turn }
  }
  add(turn: ChatTurn): void {
    const record = this.records.get(turn.sessionId)!
    this.records.set(turn.sessionId, {
      ...record,
      turns: [...record.turns, turn],
    })
    this.emit(turn.sessionId)
  }
  reply(
    sessionId: string,
    text: string,
    state: 'done' | 'failed' = 'done',
    code?: string,
  ): void {
    const operator = [...this.records.get(sessionId)!.turns]
      .reverse()
      .find(turn => turn.author === 'operator')!
    this.add({
      id: crypto.randomUUID(),
      sessionId,
      author: 'agent',
      at: this.clock(),
      text,
      state,
      taskId: operator.taskId,
      code,
    })
  }
  notice(sessionId: string, text: string, at = this.clock()): void {
    this.add({
      id: crypto.randomUUID(),
      sessionId,
      author: 'agent',
      at,
      text,
      state: 'done',
      variant: 'notice',
      noticeSource: 'agent',
      taskId: crypto.randomUUID(),
    })
  }
  emit(sessionId: string): void {
    for (const listener of this.listeners) listener({ sessionId, revision: 1 })
  }
  subscribe(listener: (update: ChatUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

let root: string
let now: number
let chat: FakeChat
let book: ConsoleSchedules
let actions: ConsoleAction[]
let notices: ScheduleNotification[]
let errors: string[]
let deniedLedger = false
const ledger: ActionLedgerPort = {
  async admit() {
    return deniedLedger
      ? { ok: false, failure: { code: 'unreachable', message: 'closed' } }
      : { ok: true, value: undefined }
  },
  async record(entry) {
    actions.push(entry)
    return { ok: true, value: undefined }
  },
  async list() {
    return { ok: true, value: { entries: [], nextBeforeSeq: null } }
  },
}
function open(): ConsoleSchedules {
  return new ConsoleSchedules({
    directory: path.join(root, 'schedules'),
    estopPath: path.join(root, 'ESTOP'),
    chat,
    actions: ledger,
    now: () => now,
    onError: message => {
      errors.push(message)
    },
    push: async (_kind, _url, notice) => {
      notices.push(notice)
      return { ok: true, error: null, attempts: 1 }
    },
  })
}
async function snapshot(): Promise<SchedulesSnapshot> {
  return value(await book.snapshot())
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-schedules-'))
  now = START
  chat = new FakeChat()
  chat.clock = () => now
  actions = []
  notices = []
  errors = []
  deniedLedger = false
  book = open()
})
afterEach(async () => {
  await book.idle()
  book.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('schedule book and secret boundary', () => {
  test('save/edit/disable/enable/remove persist the creation anchor and dedicated state', async () => {
    const saved = value(
      await book.save(
        draft({ when: { kind: 'interval', everyMinutes: 15, anchorMs: 1 } }),
        actor,
      ),
    )
    expect(saved.nextRunAt).toBe(START + STEP)
    expect(saved.when).toEqual({
      kind: 'interval',
      everyMinutes: 15,
      anchorMs: START,
    })
    now += 1000
    const changed = value(
      await book.save(
        draft({
          id: saved.id,
          title: '新的标题',
          when: { kind: 'interval', everyMinutes: 30 },
        }),
        actor,
      ),
    )
    expect(changed.createdAt).toBe(START)
    expect(changed.nextRunAt).toBe(START + 2 * STEP)
    expect(value(await book.setEnabled(saved.id, false, actor)).enabled).toBe(
      false,
    )
    now += 3 * STEP
    expect(value(await book.setEnabled(saved.id, true, actor)).nextRunAt).toBe(
      START + 4 * STEP,
    )
    book.close()
    book = open()
    expect((await snapshot()).schedules[0]!.title).toBe('新的标题')
    expect(
      fs.statSync(path.join(root, 'schedules', 'schedules.json')).mode & 0o777,
    ).toBe(0o600)
    expect(value(await book.remove(saved.id, actor))).toBeNull()
    expect((await snapshot()).schedules).toEqual([])
    expect((await book.remove(saved.id, actor)).ok).toBe(false)
    expect(actions.map(action => action.action)).toEqual([
      'schedule.save',
      'schedule.save',
      'schedule.disable',
      'schedule.enable',
      'schedule.remove',
      'schedule.remove',
    ])
    expect(actions[0]!.subject).toBe(actor.subject)
  })

  test('validates all host inputs, roles and whitelist before creating durable jobs', async () => {
    for (const patch of [
      { title: '' },
      { prompt: '' },
      { timeoutMs: 0 },
      { timeoutMs: 3_600_001 },
      { timezone: 'Unknown/Zone' },
      { when: { kind: 'daily', time: '24:00' } },
      { when: { kind: 'weekly', time: '08:00', days: [1, 1] } },
      { when: { kind: 'interval', everyMinutes: 14 } },
      { channels: ['missing'] },
      { direction: 'unknown' },
    ]) {
      expect(
        await book.save({ ...draft(), ...patch } as ScheduleDraft, actor),
      ).toMatchObject({ ok: false, failure: { code: 'invalid' } })
    }
    expect(
      await book.save(draft({ target: 'qianmo://other/denied' }), actor),
    ).toMatchObject({ ok: false, failure: { code: 'rejected' } })
    expect(
      await book.save(draft(), { ...actor, role: 'viewer' }),
    ).toMatchObject({ ok: false, failure: { code: 'refused' } })
    deniedLedger = true
    expect(await book.save(draft(), actor)).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    expect((await snapshot()).schedules).toEqual([])
    deniedLedger = false
    expect(
      value(await book.save(draft(), { ...actor, role: 'member' })).createdBy,
    ).toBe(actor.subject)
  })

  test('omitted timezone/direction/timeout use documented defaults; corrupt state fails closed', async () => {
    const input = {
      ...draft(),
      timezone: undefined,
      direction: undefined,
      timeoutMs: undefined,
    }
    const saved = value(
      await book.save(input as unknown as ScheduleDraft, actor),
    )
    expect(saved).toMatchObject({
      timezone: 'Asia/Shanghai',
      direction: 'chat',
      timeoutMs: 600_000,
    })
    book.close()
    fs.writeFileSync(path.join(root, 'schedules', 'schedules.json'), '{corrupt')
    expect(() => open()).toThrow('定时任务簿无法恢复')
  })

  test('channels can edit without resubmitting URL, test, reject in-use deletion and remove without exposing addresses', async () => {
    const secret = 'https://example.test/device-secret?key=query-secret'
    const channel = value(
      await book.saveChannel(
        { name: '手机', kind: 'webhook', url: secret },
        actor,
      ),
    )
    expect(channel.host).toBe('example.test')
    const changed = value(
      await book.saveChannel(
        { id: channel.id, name: '新名称', kind: 'bark' },
        actor,
      ),
    )
    expect(changed.host).toBe('example.test')
    expect(value(await book.testChannel(channel.id, actor)).lastUsedAt).toBe(
      now,
    )
    const job = value(await book.save(draft({ channels: [channel.id] }), actor))
    expect(await book.removeChannel(channel.id, actor)).toMatchObject({
      ok: false,
      failure: { code: 'rejected' },
    })
    expect(
      await book.saveChannel(
        { name: '远程 HTTP', kind: 'webhook', url: 'http://remote.test/key' },
        actor,
      ),
    ).toMatchObject({ ok: false, failure: { code: 'invalid' } })
    expect(
      await book.saveChannel({ name: '缺少 URL', kind: 'webhook' }, actor),
    ).toMatchObject({ ok: false, failure: { code: 'invalid' } })
    expect(
      await book.saveChannel(
        { name: '角色', kind: 'webhook', url: secret },
        { ...actor, role: 'member' },
      ),
    ).toMatchObject({ ok: false, failure: { code: 'refused' } })
    expect(JSON.stringify(await snapshot())).not.toContain(secret)
    expect(JSON.stringify(actions)).not.toContain(secret)
    expect(
      fs.readFileSync(path.join(root, 'schedules', 'schedules.json'), 'utf8'),
    ).not.toContain(secret)
    expect(
      fs.readFileSync(
        path.join(root, 'schedules', 'channels.secret.json'),
        'utf8',
      ),
    ).toContain(secret)
    expect(
      fs.statSync(path.join(root, 'schedules', 'channels.secret.json')).mode &
        0o777,
    ).toBe(0o600)
    value(await book.remove(job.id, actor))
    value(await book.removeChannel(channel.id, actor))
    expect((await snapshot()).channels).toEqual([])
    expect(
      fs.readFileSync(
        path.join(root, 'schedules', 'channels.secret.json'),
        'utf8',
      ),
    ).not.toContain(secret)
    expect(
      actions.some(
        action => action.action === 'channel.remove' && action.outcome === 'ok',
      ),
    ).toBe(true)
  })
})

describe('execution through the conversation port', () => {
  test('due sends carry direction/deadline, race-safe replies are saved and pushed once', async () => {
    const channel = value(
      await book.saveChannel(
        { name: '推送', kind: 'webhook', url: 'https://example.test/secret' },
        actor,
      ),
    )
    const job = value(
      await book.save(
        draft({ channels: [channel.id], direction: 'plan' }),
        actor,
      ),
    )
    chat.autoReply = '中'.repeat(2100)
    now += STEP - 1
    await book.tick()
    await book.idle()
    expect(chat.sent).toHaveLength(0)
    now++
    await book.tick()
    await book.idle()
    expect(chat.sent).toHaveLength(1)
    expect(chat.sent[0]).toMatchObject({
      text: job.prompt,
      direction: 'plan',
      taskTtlMs: job.timeoutMs,
    })
    const run = (await snapshot()).runs[0]!
    expect(run).toMatchObject({
      scheduleId: job.id,
      plannedAt: START + STEP,
      outcome: 'completed',
      trigger: 'schedule',
      pushed: [{ channelId: channel.id, ok: true, error: null }],
    })
    expect(run.excerpt).toBe('中'.repeat(2000))
    expect(notices[0]!.body).toBe(run.excerpt!)
    expect(chat.records.get(run.sessionId!)!.turns[1]!.text).toBe(
      '中'.repeat(2100),
    )
    expect(
      fs
        .readFileSync(path.join(root, 'schedules', 'runs.ndjson'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1)
    await book.tick()
    await book.idle()
    expect(chat.sent).toHaveLength(1)
  })

  test('manual runs do not advance time, reuse the dedicated session, and rebuild a deleted session', async () => {
    const job = value(
      await book.save(draft({ enabled: false, direction: null }), actor),
    )
    chat.autoReply = '完成'
    const first = value(await book.runNow(job.id, actor))
    await book.idle()
    expect(first.trigger).toBe('manual')
    const session = chat.sent[0]!.sessionId
    value(await book.runNow(job.id, actor))
    await book.idle()
    expect(chat.sent[1]!.sessionId).toBe(session)
    expect(chat.sent[0]!.direction).toBeUndefined()
    expect((await snapshot()).schedules[0]!.nextRunAt).toBe(job.nextRunAt)
    chat.records.delete(session)
    value(await book.runNow(job.id, actor))
    await book.idle()
    expect(chat.sent[2]!.sessionId).not.toBe(session)
    book.close()
    book = open()
    value(await book.runNow(job.id, actor))
    await book.idle()
    expect(chat.sent[3]!.sessionId).toBe(chat.sent[2]!.sessionId)
  })

  test('timeouts use the injected clock, push a terminal outcome and ignore late replies', async () => {
    const channel = value(
      await book.saveChannel(
        { name: '推送', kind: 'webhook', url: 'https://example.test/secret' },
        actor,
      ),
    )
    const job = value(await book.save(draft({ channels: [channel.id] }), actor))
    value(await book.runNow(job.id, actor))
    await book.idle()
    now += job.timeoutMs - 1
    await book.tick()
    await book.idle()
    expect((await snapshot()).runs[0]!.outcome).toBe('running')
    now++
    await book.tick()
    await book.idle()
    expect((await snapshot()).runs[0]!).toMatchObject({
      outcome: 'timeout',
      reason: '任务超时',
    })
    expect(notices[0]!.qianmo.outcome).toBe('timeout')
    chat.reply(chat.sent[0]!.sessionId, '迟到的回复')
    await book.idle()
    expect((await snapshot()).runs).toHaveLength(1)
    expect(notices).toHaveLength(1)
  })

  test('overlapping slots skip; ESTOP skips both scheduled and manual work without sends', async () => {
    const job = value(await book.save(draft({ timeoutMs: 3_600_000 }), actor))
    now += STEP
    await book.tick()
    await book.idle()
    now += STEP
    await book.tick()
    await book.idle()
    expect(chat.sent).toHaveLength(1)
    expect(
      (await snapshot()).runs.some(
        run => run.outcome === 'skipped' && run.reason === '上一轮未结束',
      ),
    ).toBe(true)
    expect(value(await book.runNow(job.id, actor)).reason).toBe('上一轮未结束')
    fs.writeFileSync(path.join(root, 'ESTOP'), '')
    now += STEP
    await book.tick()
    await book.idle()
    expect(value(await book.runNow(job.id, actor)).reason).toBe('紧急停止')
    expect((await snapshot()).estop).toBe(true)
    expect(
      (await snapshot()).runs.some(
        run => run.outcome === 'skipped' && run.reason === '紧急停止',
      ),
    ).toBe(true)
    expect(chat.sent).toHaveLength(1)
    expect(notices).toHaveLength(0)
  })

  test('missed slots catch up once after restart; nextRunAt is not recalculated at startup', async () => {
    const job = value(await book.save(draft(), actor))
    book.close()
    now += 5 * STEP
    book = open()
    expect((await snapshot()).schedules[0]!.nextRunAt).toBe(job.nextRunAt)
    chat.autoReply = '补跑完成'
    await book.tick()
    await book.idle()
    const result = await snapshot()
    expect(chat.sent).toHaveLength(1)
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0]!.reason).toBe('错过 4 次，仅补跑一次')
    expect(result.schedules[0]!.nextRunAt).toBe(START + 6 * STEP)
  })

  test('a pending run becomes failed after restart without sending it again', async () => {
    const job = value(await book.save(draft(), actor))
    value(await book.runNow(job.id, actor))
    await book.idle()
    book.close()
    now += 1000
    book = open()
    const run = (await snapshot()).runs[0]!
    expect(run).toMatchObject({
      outcome: 'failed',
      reason: '控制台重启',
      finishedAt: now,
    })
    expect(chat.sent).toHaveLength(1)
    book.close()
    book = open()
    expect((await snapshot()).runs).toHaveLength(1)
  })

  test('agent notices select this run only; stale notices do not enable a later push', async () => {
    const channel = value(
      await book.saveChannel(
        { name: '推送', kind: 'webhook', url: 'https://example.test/secret' },
        actor,
      ),
    )
    const job = value(
      await book.save(
        draft({ channels: [channel.id], notifyOnlyAgent: true }),
        actor,
      ),
    )
    value(await book.runNow(job.id, actor))
    await book.idle()
    const session = chat.sent[0]!.sessionId
    chat.notice(session, '需要用户拿主意')
    chat.reply(session, '回复全文')
    await book.idle()
    expect(notices.map(notice => notice.body)).toEqual(['需要用户拿主意'])
    now++
    value(await book.runNow(job.id, actor))
    await book.idle()
    chat.notice(session, '延迟的上一轮通知', now - 1)
    chat.add({
      id: crypto.randomUUID(),
      sessionId: session,
      author: 'agent',
      at: now,
      text: '自动工具过程',
      state: 'done',
      variant: 'notice',
      noticeSource: 'step',
    })
    chat.add({
      id: crypto.randomUUID(),
      sessionId: session,
      author: 'agent',
      at: now,
      text: '其他任务的显式通知',
      state: 'done',
      variant: 'notice',
      noticeSource: 'agent',
      causeTaskId: 'other-task',
    })
    chat.reply(session, '无需通知')
    await book.idle()
    expect(notices).toHaveLength(1)
  })

  test('failed sends/results are terminal, pushes fail safely and URLs never enter snapshots, runs or diagnostic logs', async () => {
    const secret = 'https://example.test/device-secret?key=query-secret'
    const channel = value(
      await book.saveChannel(
        { name: '推送', kind: 'webhook', url: secret },
        actor,
      ),
    )
    const job = value(await book.save(draft({ channels: [channel.id] }), actor))
    chat.sendError = true
    value(await book.runNow(job.id, actor))
    await book.idle()
    expect((await snapshot()).runs[0]).toMatchObject({
      outcome: 'failed',
      reason: '对话发送失败',
    })
    chat.sendError = false
    now++
    value(await book.runNow(job.id, actor))
    await book.idle()
    chat.reply(chat.sent[1]!.sessionId, `失败 ${secret}`, 'failed')
    await book.idle()
    const current = await snapshot()
    expect(current.runs[0]!.outcome).toBe('failed')
    expect(current.runs[0]!.excerpt).toBe('失败 [渠道地址]')
    expect(JSON.stringify(current)).not.toContain(secret)
    expect(
      fs.readFileSync(path.join(root, 'schedules', 'runs.ndjson'), 'utf8'),
    ).not.toContain(secret)
    expect(JSON.stringify(actions)).not.toContain(secret)
    expect(JSON.stringify(errors)).not.toContain(secret)
  })

  test('reload keeps the newest 500 durable runs and snapshot exposes only the newest 50', async () => {
    const job = value(await book.save(draft(), actor))
    fs.writeFileSync(path.join(root, 'ESTOP'), '')
    for (let i = 0; i < 505; i++) {
      now++
      value(await book.runNow(job.id, actor))
    }
    book.close()
    book = open()
    const snapshot = await book.snapshot()
    expect(value(snapshot).runs).toHaveLength(50)
    expect(value(snapshot).runs[0]!.startedAt).toBe(now)
    expect(value(snapshot).runs[49]!.startedAt).toBe(now - 49)
    expect(chat.sent).toHaveLength(0)
  })

  test('notification failure records pushed=false without changing the completed agent outcome', async () => {
    book.close()
    book = new ConsoleSchedules({
      directory: path.join(root, 'schedules'),
      estopPath: path.join(root, 'ESTOP'),
      chat,
      now: () => now,
      push: async () => {
        throw new Error('https://example.test/device-secret')
      },
      onError: line => errors.push(line),
    })
    const channel = value(
      await book.saveChannel(
        {
          name: '通知',
          kind: 'webhook',
          url: 'https://example.test/device-secret',
        },
        actor,
      ),
    )
    const job = value(await book.save(draft({ channels: [channel.id] }), actor))
    chat.autoReply = '完成了'
    value(await book.runNow(job.id, actor))
    await book.idle()
    expect((await snapshot()).runs[0]).toMatchObject({
      outcome: 'completed',
      excerpt: '完成了',
      pushed: [{ channelId: channel.id, ok: false, error: '通知推送失败' }],
    })
    expect((await snapshot()).channels[0]).toMatchObject({
      lastUsedAt: now,
      lastError: '通知推送失败',
    })
    expect(await book.testChannel(channel.id, actor)).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    expect(JSON.stringify(await snapshot())).not.toContain('device-secret')
    expect(JSON.stringify(errors)).not.toContain('device-secret')
    expect(
      fs.readFileSync(path.join(root, 'schedules', 'runs.ndjson'), 'utf8'),
    ).not.toContain('device-secret')
  })

  test('weekly catchup counts missed slots across a year; a closed ledger retains due time', async () => {
    now = Date.parse('2026-12-28T00:00:00+08:00')
    const job = value(
      await book.save(
        draft({ when: { kind: 'weekly', time: '08:00', days: [1] } }),
        actor,
      ),
    )
    now = Date.parse('2027-01-18T09:00:00+08:00')
    deniedLedger = true
    await book.tick()
    await book.idle()
    expect(chat.sent).toHaveLength(0)
    expect((await snapshot()).schedules[0]!.nextRunAt).toBe(job.nextRunAt)
    deniedLedger = false
    chat.autoReply = '跨年补跑'
    await book.tick()
    await book.idle()
    expect(chat.sent).toHaveLength(1)
    expect((await snapshot()).runs[0]!.reason).toBe('错过 3 次，仅补跑一次')
    expect((await snapshot()).schedules[0]!.nextRunAt).toBe(
      Date.parse('2027-01-25T08:00:00+08:00'),
    )
    expect(actions.at(-1)).toMatchObject({
      action: 'schedule.run',
      subject: 'system:schedules',
      target: job.id,
    })
  })

  test('unrelated task replies and old notice rows cannot settle or push this run', async () => {
    const job = value(await book.save(draft(), actor))
    value(await book.runNow(job.id, actor))
    await book.idle()
    const sessionId = chat.sent[0]!.sessionId
    chat.add({
      id: crypto.randomUUID(),
      sessionId,
      author: 'agent',
      at: now,
      text: '另一任务',
      state: 'done',
      taskId: 'other-task',
    })
    await book.idle()
    expect((await snapshot()).runs[0]!.outcome).toBe('running')
    chat.reply(sessionId, '正确回复')
    await book.idle()
    expect((await snapshot()).runs[0]).toMatchObject({
      outcome: 'completed',
      excerpt: '正确回复',
    })
  })

  test('recovery deduplicates a finalized run whose in-flight checkpoint survived the crash', async () => {
    const job = value(await book.save(draft(), actor))
    value(await book.runNow(job.id, actor))
    await book.idle()
    const bookPath = path.join(root, 'schedules', 'schedules.json')
    const checkpoint = fs.readFileSync(bookPath, 'utf8')
    chat.reply(chat.sent[0]!.sessionId, '已完成')
    await book.idle()
    book.close()
    fs.writeFileSync(bookPath, checkpoint)
    book = open()
    expect((await snapshot()).runs).toHaveLength(1)
    expect((await snapshot()).runs[0]).toMatchObject({
      outcome: 'completed',
      excerpt: '已完成',
    })
    expect(
      fs
        .readFileSync(path.join(root, 'schedules', 'runs.ndjson'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1)
  })

  test('a torn history append does not swallow the next run or prevent another restart', async () => {
    const job = value(await book.save(draft(), actor))
    chat.autoReply = '第一轮'
    value(await book.runNow(job.id, actor))
    await book.idle()
    book.close()
    const runPath = path.join(root, 'schedules', 'runs.ndjson')
    fs.appendFileSync(runPath, '{"runId":"interrupted')
    book = open()
    now++
    chat.autoReply = '第二轮'
    value(await book.runNow(job.id, actor))
    await book.idle()
    book.close()
    book = open()
    expect((await snapshot()).runs.map(run => run.excerpt)).toEqual([
      '第二轮',
      '第一轮',
    ])
    expect(chat.sent).toHaveLength(2)
    expect(errors).toContain('定时任务运行记录有不完整行，已忽略')
  })

  test('rotating and removing a channel never re-exposes an old URL in public task text', async () => {
    const oldUrl = 'https://example.test/old-device-secret'
    const newUrl = 'https://example.test/new-device-secret'
    const channel = value(
      await book.saveChannel(
        { name: '渠道', kind: 'webhook', url: oldUrl },
        actor,
      ),
    )
    value(await book.save(draft({ prompt: `请处理 ${oldUrl}` }), actor))
    value(
      await book.saveChannel(
        { id: channel.id, name: '渠道', kind: 'webhook', url: newUrl },
        actor,
      ),
    )
    value(await book.removeChannel(channel.id, actor))
    expect(JSON.stringify(await snapshot())).not.toContain(oldUrl)
    book.close()
    book = open()
    expect(JSON.stringify(await snapshot())).not.toContain(oldUrl)
    expect(
      fs.readFileSync(path.join(root, 'schedules', 'schedules.json'), 'utf8'),
    ).not.toContain(oldUrl)
  })

  test('saving an enabled draft resumes after now; a same-millisecond new manual run is the lastRun', async () => {
    const job = value(await book.save(draft({ enabled: false }), actor))
    now += 4 * STEP
    const resumed = value(
      await book.save(draft({ id: job.id, enabled: true }), actor),
    )
    expect(resumed.nextRunAt).toBe(START + 5 * STEP)
    await book.tick()
    await book.idle()
    expect(chat.sent).toHaveLength(0)
    chat.autoReply = '完成'
    value(await book.runNow(job.id, actor))
    await book.idle()
    chat.autoReply = null
    const pending = value(await book.runNow(job.id, actor))
    await book.idle()
    expect((await snapshot()).schedules[0]!.lastRun).toMatchObject({
      runId: pending.runId,
      outcome: 'running',
    })
  })
})
