// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat channels on the hub (P28): sealed credentials, one long-lived console
 * session per chat dispatched as the channel owner, `/new` and `/stop`, the
 * member lane, and the WeChat scan login — against a fake chat face and fake
 * platform adapters.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  ChannelDraft,
  ConsoleResult,
  DirectionActor,
} from '@qianmo/console'
import {
  type ChannelTasks,
  ConsoleChannels,
} from '../../src/commands/consoleChannels.js'
import { FakeAdapter, FakeNet, inbound, until } from '../channels/fakes.js'
import { FakeChat } from './fakeChat.js'

const OWNER_AGENT = 'qianmo://node-a/planner'
const MEMBER_AGENT = 'qianmo://node-b/helper'
const ACTOR: DirectionActor = {
  subject: 'legacy:admin',
  role: null,
  requestId: 'r-1',
}

function value<T>(result: ConsoleResult<T>): T {
  if (!result.ok) throw new Error(result.failure.message)
  return result.value
}

let root: string
let chat: FakeChat
let adapters: {
  adapter: FakeAdapter
  platform: string
  secrets: Record<string, string>
  settings: Record<string, string>
}[]
let stopped: [string, string][]
let open: ConsoleChannels[]

function channels(
  options: { net?: FakeNet; turnTimeoutMs?: number; tasks?: ChannelTasks } = {},
): ConsoleChannels {
  const book = new ConsoleChannels({
    directory: root,
    chat,
    ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
    ...(options.net === undefined ? {} : { io: options.net.io() }),
    ...(options.turnTimeoutMs === undefined
      ? {}
      : { turnTimeoutMs: options.turnTimeoutMs }),
    adapter: (channel, secrets) => {
      const adapter = new FakeAdapter(channel.platform)
      adapters.push({
        adapter,
        platform: channel.platform,
        secrets: { ...secrets },
        settings: { ...channel.settings },
      })
      return adapter
    },
    stopTask: async (target, taskId) => {
      stopped.push([target, taskId])
      return true
    },
  })
  open.push(book)
  book.start()
  return book
}

const TELEGRAM: ChannelDraft = {
  name: '我的 Telegram',
  platform: 'telegram',
  target: OWNER_AGENT,
  ownerIds: ['owner'],
  secrets: { token: '123:SECRET-TOKEN' },
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-channels-'))
  chat = new FakeChat([OWNER_AGENT, MEMBER_AGENT])
  adapters = []
  stopped = []
  open = []
})

afterEach(async () => {
  await Promise.all(open.map(book => book.close()))
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the channel book', () => {
  test('credentials are sealed on disk, revealed only to the adapter, kept across restarts and edits', async () => {
    const book = channels()
    const saved = value(await book.save(TELEGRAM, ACTOR))
    expect(saved.secretSet).toBe(true)
    expect(saved.owner).toBe('legacy:admin')
    expect(saved.health.state).toBe('connected')
    expect(adapters[0]!.secrets).toEqual({ token: '123:SECRET-TOKEN' })
    const disk = fs.readFileSync(path.join(root, 'channels.json'), 'utf8')
    expect(disk).not.toContain('SECRET-TOKEN')
    expect(JSON.stringify(value(await book.snapshot()))).not.toContain(
      'SECRET-TOKEN',
    )
    expect(fs.statSync(path.join(root, 'channels.json')).mode & 0o777).toBe(
      0o600,
    )
    await book.close()
    open = []

    const again = channels()
    expect(adapters[1]!.secrets).toEqual({ token: '123:SECRET-TOKEN' })
    // Editing without a secret keeps the sealed one; the adapter restarts.
    value(
      await again.save(
        { ...TELEGRAM, id: saved.id, name: '改名', secrets: {} },
        ACTOR,
      ),
    )
    expect(adapters[0]!.adapter.sink).toBeNull()
    expect(adapters[2]!.secrets).toEqual({ token: '123:SECRET-TOKEN' })
    const snapshot = value(await again.snapshot())
    expect(snapshot.channels.map(one => one.name)).toEqual(['改名'])
    expect(snapshot.agents).toEqual([OWNER_AGENT, MEMBER_AGENT])
    expect(snapshot.platforms.every(one => one.evaluated === false)).toBe(true)
  })

  test('refuses what cannot work', async () => {
    const book = channels()
    const refused = async (draft: ChannelDraft) => {
      const result = await book.save(draft, ACTOR)
      return result.ok
        ? 'saved'
        : `${result.failure.code} ${result.failure.message}`
    }
    expect(await refused({ ...TELEGRAM, secrets: {} })).toBe(
      'invalid 缺少Bot Token',
    )
    expect(await refused({ ...TELEGRAM, target: 'planner' })).toBe(
      'invalid 主人对话的智能体不是有效的智能体地址',
    )
    expect(await refused({ ...TELEGRAM, name: ' ' })).toBe(
      'invalid 名称需要 1–60 个字',
    )
    expect(await refused({ ...TELEGRAM, platform: 'qq' })).toBe(
      'invalid 缺少AppID',
    )
    expect(
      await refused({ ...TELEGRAM, platform: 'weixin', secrets: {} }),
    ).toBe('invalid 请先扫码登录')
    expect(await refused({ ...TELEGRAM, ownerIds: ['a b'] })).toBe(
      'invalid 主人用户号含无效项',
    )
    const saved = value(await book.save(TELEGRAM, ACTOR))
    expect(
      await refused({ ...TELEGRAM, id: saved.id, platform: 'discord' }),
    ).toBe('invalid 渠道平台不能修改')
    expect(
      await refused({
        ...TELEGRAM,
        id: 'ch-00000000-0000-0000-0000-000000000000',
      }),
    ).toBe('not_found 没有这个渠道')
  })

  test('one instance owns the directory', async () => {
    channels()
    const second = channels()
    const result = await second.save(TELEGRAM, ACTOR)
    expect(result.ok ? 'saved' : result.failure.code).toBe('refused')
  })

  test('remove stops the bot and forgets its conversations', async () => {
    const book = channels()
    const saved = value(await book.save(TELEGRAM, ACTOR))
    const adapter = adapters[0]!.adapter
    adapter.sink!(inbound({ text: '你好' }))
    await until(() => chat.sent.length === 1)
    chat.reply(chat.sent[0]!.sessionId, '在')
    await until(() => adapter.sent.length === 1)
    expect(value(await book.snapshot()).channels[0]!.conversations).toBe(1)
    value(await book.remove(saved.id))
    expect(adapter.sink).toBeNull()
    expect(value(await book.snapshot()).channels).toEqual([])
    expect(
      fs.readFileSync(path.join(root, 'state.json'), 'utf8'),
    ).not.toContain(saved.id)
  })
})

describe('conversations', () => {
  test('one session per chat, reused turn after turn, dispatched as the owner', async () => {
    const book = channels()
    value(await book.save({ ...TELEGRAM, prompt: '简短回答' }, ACTOR))
    const adapter = adapters[0]!.adapter
    adapter.sink!(inbound({ id: '11', text: '今天的安排' }))
    await until(() => chat.sent.length === 1)
    expect(chat.opened).toEqual([OWNER_AGENT])
    const session = chat.sent[0]!.sessionId
    expect(chat.sent[0]!.text).toContain('[渠道] 这段对话来自 Telegram 的私聊')
    expect(chat.sent[0]!.text).toContain('[渠道说明]\n简短回答')
    expect(chat.sent[0]!.text.endsWith('今天的安排')).toBe(true)
    chat.notice(session, '正在查日历')
    chat.reply(session, '上午开会')
    await until(() => adapter.sent.length === 2)
    expect(adapter.sent.map(one => [one.text, one.replyTo])).toEqual([
      ['正在查日历', undefined],
      ['上午开会', '11'],
    ])
    adapter.sink!(inbound({ text: '下午呢' }))
    await until(() => chat.sent.length === 2)
    expect(chat.sent[1]).toMatchObject({ sessionId: session, text: '下午呢' })
    chat.reply(session, '空着')
    await until(() => adapter.sent.length === 3)
    expect(chat.opened).toHaveLength(1)
    const state = JSON.parse(
      fs.readFileSync(path.join(root, 'state.json'), 'utf8'),
    )
    expect(Object.values(state.conversations)).toMatchObject([
      { sessionId: session, target: OWNER_AGENT, turns: 2 },
    ])
  })

  test('/new opens a fresh session for the next message', async () => {
    const book = channels()
    value(await book.save(TELEGRAM, ACTOR))
    const adapter = adapters[0]!.adapter
    adapter.sink!(inbound({ text: 'a' }))
    await until(() => chat.sent.length === 1)
    chat.reply(chat.sent[0]!.sessionId, 'ok')
    await until(() => adapter.sent.length === 1)
    adapter.sink!(inbound({ text: '/new' }))
    await until(() => adapter.sent.length === 2)
    adapter.sink!(inbound({ text: 'b' }))
    await until(() => chat.sent.length === 2)
    expect(chat.opened).toHaveLength(2)
    expect(chat.sent[1]!.sessionId).not.toBe(chat.sent[0]!.sessionId)
    expect(chat.sent[1]!.text).toContain('[渠道]')
    chat.reply(chat.sent[1]!.sessionId, 'ok')
    await until(() => adapter.sent.length === 3)
  })

  test('/stop stops the task on its node and sends no failure note', async () => {
    const book = channels()
    value(await book.save(TELEGRAM, ACTOR))
    const adapter = adapters[0]!.adapter
    adapter.sink!(inbound({ text: '跑个长任务' }))
    await until(() => chat.sent.length === 1)
    const task = chat.lastTask(chat.sent[0]!.sessionId)
    adapter.sink!(inbound({ text: '/stop' }))
    await until(() => adapter.sent.length === 1)
    expect(adapter.texts()).toEqual(['停下了。'])
    expect(stopped).toEqual([[OWNER_AGENT, task]])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(adapter.sent).toHaveLength(1)
  })

  test('/compact and /model go through the chat face as local commands and directions', async () => {
    const book = channels()
    value(await book.save(TELEGRAM, ACTOR))
    const adapter = adapters[0]!.adapter
    adapter.sink!(inbound({ text: '/compact' }))
    await until(() => adapter.sent.length === 1)
    expect(adapter.texts()).toEqual(['还没有可压缩的上下文。'])
    adapter.sink!(inbound({ text: '/model fast' }))
    await until(() => adapter.sent.length === 2)
    adapter.sink!(inbound({ text: 'hi' }))
    await until(() => chat.sent.length === 1)
    expect(chat.sent[0]!.direction).toBe('fast')
    chat.reply(chat.sent[0]!.sessionId, 'ok')
    await until(() => adapter.sent.length === 3)
    adapter.sink!(inbound({ text: '/compact' }))
    await until(() => chat.sent.length === 2)
    expect(chat.sent[1]).toMatchObject({ text: '/compact', command: 'compact' })
    chat.reply(chat.sent[1]!.sessionId, '已压缩')
    await until(() => adapter.sent.length === 4)
    expect(adapter.texts().slice(1)).toEqual([
      '这个会话改用「fast」方向的模型',
      'ok',
      '上下文已压缩。',
    ])
  })

  test('other people talk to the member agent in their own session', async () => {
    const book = channels()
    value(
      await book.save(
        { ...TELEGRAM, memberTarget: MEMBER_AGENT, allowAll: true },
        ACTOR,
      ),
    )
    const adapter = adapters[0]!.adapter
    adapter.sink!(
      inbound({
        userId: 'guest',
        chat: { type: 'dm', id: 'guest' },
        text: '你是谁',
      }),
    )
    await until(() => chat.sent.length === 1)
    expect(chat.opened).toEqual([MEMBER_AGENT])
    expect(chat.sent[0]!.text).toContain('不是你的主人')
    chat.reply(chat.sent[0]!.sessionId, '内部错误', 'failed')
    await new Promise(resolve => setTimeout(resolve, 20))
    // A failure is the owner's business, never shown to a member.
    expect(adapter.sent).toHaveLength(0)
  })

  test('a turn that never answers times out with a note to the owner', async () => {
    const book = channels({ turnTimeoutMs: 30 })
    value(await book.save(TELEGRAM, ACTOR))
    const adapter = adapters[0]!.adapter
    adapter.sink!(inbound())
    await until(() => adapter.sent.length === 1)
    expect(adapter.texts()[0]).toContain('这轮执行到时间上限后停止了')
  })

  test('a disabled channel neither connects nor answers', async () => {
    const book = channels()
    const saved = value(await book.save({ ...TELEGRAM, enabled: false }, ACTOR))
    expect(adapters).toHaveLength(0)
    expect(saved.health.state).toBe('stopped')
  })
})

describe('WeChat scan login', () => {
  test('the scanner becomes the owner and the bot token is sealed', async () => {
    let polls = 0
    const net = new FakeNet()
      .on('get_bot_qrcode', {
        body: {
          qrcode: 'Q1',
          qrcode_img_content: 'https://liteapp.weixin.qq.com/q/Q1',
        },
      })
      .on('get_qrcode_status', () =>
        polls++ < 1
          ? { body: { status: 'scaned' } }
          : {
              body: {
                status: 'confirmed',
                ilink_bot_id: 'bot@im.bot',
                bot_token: 'WX-SECRET',
                baseurl: 'https://ilinkai.weixin.qq.com',
                ilink_user_id: 'wx-owner',
              },
            },
      )
    const book = channels({ net })
    const draft: ChannelDraft = {
      name: '微信',
      platform: 'weixin',
      target: OWNER_AGENT,
    }
    const login = value(await book.login(draft, ACTOR))
    expect(login).toMatchObject({
      state: 'wait',
      qr: 'https://liteapp.weixin.qq.com/q/Q1',
    })
    expect(value(await book.loginQr(login.loginId, ACTOR))).toBe(
      'https://liteapp.weixin.qq.com/q/Q1',
    )
    const other = await book.loginStatus(login.loginId, {
      ...ACTOR,
      subject: 'u:someone',
    })
    expect(other.ok).toBe(false)
    await until(() => adapters.length === 1)
    const status = value(await book.loginStatus(login.loginId, ACTOR))
    expect(status.state).toBe('confirmed')
    expect(adapters[0]!.secrets).toEqual({ token: 'WX-SECRET' })
    expect(adapters[0]!.settings).toEqual({
      accountId: 'bot@im.bot',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    })
    const channel = value(await book.snapshot()).channels[0]!
    expect(channel).toMatchObject({
      id: status.channelId,
      platform: 'weixin',
      ownerIds: ['wx-owner'],
      secretSet: true,
    })
    expect(
      fs.readFileSync(path.join(root, 'channels.json'), 'utf8'),
    ).not.toContain('WX-SECRET')
  })

  test('only WeChat logs in by scanning', async () => {
    const book = channels({ net: new FakeNet() })
    const result = await book.login({ ...TELEGRAM }, ACTOR)
    expect(result.ok ? 'ok' : result.failure.message).toBe(
      '只有微信需要扫码登录',
    )
  })
})

describe('background tasks', () => {
  class FakeTasks implements ChannelTasks {
    readonly cancelled: string[] = []
    listener:
      | ((event: {
          parentSession: string
          text: string
        }) => Promise<boolean | undefined>)
      | null = null
    summary: string | undefined = '[当前会话的后台任务] [{"id":"task-1"}]'
    contextFor() {
      return this.summary
    }
    statusText() {
      return this.summary === undefined ? undefined : '周报：执行中'
    }
    async cancelForSession(sessionId: string) {
      this.cancelled.push(sessionId)
      return 1
    }
    onFinished(
      listener: (event: {
        parentSession: string
        text: string
      }) => Promise<boolean | undefined>,
    ) {
      this.listener = listener
      return () => {
        this.listener = null
      }
    }
  }

  test("the owner's private chat is a foreground: rules, task note, status answers, /stop, results", async () => {
    const fake = new FakeTasks()
    const book = channels({ tasks: fake })
    value(
      await book.save(
        { ...TELEGRAM, memberTarget: MEMBER_AGENT, allowAll: true },
        ACTOR,
      ),
    )
    const adapter = adapters[0]!.adapter
    adapter.sink!(inbound({ text: '帮我写周报' }))
    await until(() => chat.sent.length === 1)
    const session = chat.sent[0]!.sessionId
    // The rules are sticky from the first turn; the task note needs a session.
    expect(chat.sent[0]!.text).toContain('[后台任务协调规则]')
    chat.reply(session, '已经交给后台')
    await until(() => adapter.sent.length === 1)
    adapter.sink!(inbound({ text: '再加一张图' }))
    await until(() => chat.sent.length === 2)
    expect(chat.sent[1]!.text).toBe(
      '[当前会话的后台任务] [{"id":"task-1"}]\n\n再加一张图',
    )
    chat.reply(session, '好')
    await until(() => adapter.sent.length === 2)
    expect(book.foreground(session)).toBe(true)
    // A status question is answered from the task ledger, with no turn.
    adapter.sink!(inbound({ text: '进度怎么样了' }))
    await until(() => adapter.sent.length === 3)
    expect(adapter.texts()[2]).toBe('周报：执行中')
    expect(chat.sent).toHaveLength(2)
    // /stop cancels the chat's tasks even with no turn running.
    adapter.sink!(inbound({ text: '/stop' }))
    await until(() => adapter.sent.length === 4)
    expect(adapter.texts()[3]).toBe('停下了。')
    expect(fake.cancelled).toEqual([session])
    // A finished task reaches the chat its conversation lives in.
    expect(
      await fake.listener!({ parentSession: session, text: '周报：已完成' }),
    ).toBe(true)
    expect(adapter.texts()[4]).toBe('周报：已完成')
    expect(
      await fake.listener!({ parentSession: 'elsewhere', text: 'x' }),
    ).toBeUndefined()
    // After /new the chat keeps its tasks: both sessions are related.
    adapter.sink!(inbound({ text: '/new' }))
    await until(() => adapter.sent.length === 6)
    adapter.sink!(inbound({ text: '新话题' }))
    await until(() => chat.sent.length === 3)
    expect(book.related(chat.sent[2]!.sessionId)).toEqual([
      session,
      chat.sent[2]!.sessionId,
    ])
    chat.reply(chat.sent[2]!.sessionId, 'ok')
    await until(() => adapter.sent.length === 7)
  })

  test('other people and groups get no task rules and may not start tasks', async () => {
    const fake = new FakeTasks()
    const book = channels({ tasks: fake })
    value(
      await book.save(
        { ...TELEGRAM, memberTarget: MEMBER_AGENT, allowAll: true },
        ACTOR,
      ),
    )
    const adapter = adapters[0]!.adapter
    adapter.sink!(
      inbound({
        userId: 'guest',
        chat: { type: 'dm', id: 'guest' },
        text: '进度怎么样了',
      }),
    )
    await until(() => chat.sent.length === 1)
    expect(chat.sent[0]!.text).not.toContain('[后台任务协调规则]')
    expect(book.foreground(chat.sent[0]!.sessionId)).toBe(false)
    expect(book.foreground('not-a-channel-session')).toBe(true)
    chat.reply(chat.sent[0]!.sessionId, 'hi')
    await until(() => adapter.sent.length === 1)
  })
})
