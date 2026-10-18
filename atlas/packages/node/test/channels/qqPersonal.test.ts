// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The personal QQ adapter against a scripted SnowLuma (OneBot 11 forward
 * WebSocket): handshake, the two health domains, inbound mapping, sends
 * acknowledged by echo, merged-forward cards and the action allowlist. Not
 * run against a real account (`evaluated: false`).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  QQ_PERSONAL_ACTIONS,
  QqPersonalAdapter,
  cqSegments,
  forwardNodes,
} from '../../src/channels/qqPersonal.js'
import type { ChannelInbound } from '../../src/channels/types.js'
import { FakeNet, type FakeSocket, until } from './fakes.js'

const SELF = '10001000'
const running: QqPersonalAdapter[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(adapter => adapter.stop()))
})

type Frame = Record<string, unknown>

/** A SnowLuma that answers the adapter's actions; `answers` overrides by action. */
function snowluma(answers: Record<string, (frame: Frame) => unknown> = {}) {
  const net = new FakeNet()
  net.respond = frame => {
    const action = String(frame.action)
    const custom = answers[action]
    if (custom) return custom(frame)
    switch (action) {
      case 'get_login_info':
        return {
          status: 'ok',
          retcode: 0,
          data: { user_id: Number(SELF), nickname: '小阡' },
        }
      case 'get_status':
        return { status: 'ok', retcode: 0, data: { online: true, good: true } }
      case 'send_private_msg':
      case 'send_group_msg':
      case 'send_private_forward_msg':
      case 'send_group_forward_msg':
        return {
          status: 'ok',
          retcode: 0,
          data: { message_id: 900 + net.exchanges.length },
        }
      case 'set_input_status':
        return { status: 'ok', retcode: 0, data: {} }
      default:
        return {
          status: 'failed',
          retcode: 1404,
          data: null,
          wording: 'unknown action',
        }
    }
  }
  return net
}

async function started(net: FakeNet) {
  const adapter = new QqPersonalAdapter(
    { url: 'ws://127.0.0.1:3001/', accessToken: 'ob-token' },
    net.io(),
  )
  const got: ChannelInbound[] = []
  running.push(adapter)
  await adapter.start(message => got.push(message))
  await until(() => net.sockets.length === 1)
  const socket = net.sockets[0]!
  await until(() => sent(socket, 'get_status').length === 1)
  await until(() => adapter.health().state === 'connected')
  return { adapter, got, socket }
}

function sent(socket: FakeSocket, action: string): Frame[] {
  return (socket.sent as Frame[]).filter(frame => frame.action === action)
}

function message(overrides: Frame): Frame {
  return {
    time: 1,
    self_id: Number(SELF),
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 1,
    user_id: 30003000,
    message: [{ type: 'text', data: { text: '你好' } }],
    raw_message: '你好',
    font: 0,
    sender: { user_id: 30003000, nickname: '张三', card: '' },
    ...overrides,
  }
}

describe('connection', () => {
  test('dials with the OneBot token as Bearer and access_token, then learns who it is', async () => {
    const net = snowluma()
    const { socket } = await started(net)
    expect(socket.headers.authorization).toBe('Bearer ob-token')
    expect(new URL(socket.url).searchParams.get('access_token')).toBe(
      'ob-token',
    )
    expect(sent(socket, 'get_login_info')).toHaveLength(1)
    for (const frame of socket.sent as Frame[]) {
      expect(typeof frame.echo).toBe('string')
      expect(QQ_PERSONAL_ACTIONS.has(String(frame.action))).toBe(true)
    }
  })

  test('a rejected handshake stops the channel and says which secret is wrong', async () => {
    const net = snowluma()
    net.refuseSockets = true
    net.on('http://127.0.0.1:3001', { status: 401, body: { retcode: 1401 } })
    const adapter = new QqPersonalAdapter(
      { url: 'ws://127.0.0.1:3001/', accessToken: 'webui-password' },
      net.io(),
    )
    running.push(adapter)
    await adapter.start(() => {})
    await until(() => adapter.health().state === 'failed')
    expect(adapter.health().detail).toContain('不是 WebUI 密码')
    const probe = net.to('http://127.0.0.1:3001')[0]!
    expect(probe.headers.upgrade).toBe('websocket')
    expect(probe.headers.authorization).toBe('Bearer webui-password')
  })

  test('an unreachable SnowLuma is retried, not failed', async () => {
    const net = snowluma()
    net.refuseSockets = true
    net.on('http://127.0.0.1:3001', { status: 426 })
    const adapter = new QqPersonalAdapter(
      { url: 'ws://127.0.0.1:3001/', accessToken: 'ob-token' },
      net.io(),
    )
    running.push(adapter)
    await adapter.start(() => {})
    await until(() => net.sockets.length >= 2)
    expect(adapter.health().state).toBe('retrying')
    expect(adapter.health().detail).toBe('SnowLuma 不可达')
  })

  test('the QQ account is its own health domain: offline refuses sends until it is back', async () => {
    const net = snowluma()
    const { adapter, socket } = await started(net)
    socket.push({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      self_id: Number(SELF),
      status: { online: false, good: false },
      interval: 30000,
    })
    expect(adapter.health().state).toBe('failed')
    expect(adapter.health().detail).toContain('重新扫码登录')
    const refused = await adapter.send({ type: 'dm', id: '30003000' }, '在吗')
    expect(refused).toMatchObject({ ok: false })
    expect(refused.retryable).toBeUndefined()
    expect(sent(socket, 'send_private_msg')).toHaveLength(0)
    // A heartbeat without the flag is not evidence either way.
    socket.push({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      status: {},
    })
    expect(adapter.health().state).toBe('failed')
    socket.push({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      status: { online: 'true' },
    })
    expect(adapter.health().state).toBe('connected')
    socket.push({ post_type: 'notice', notice_type: 'bot_offline' })
    expect(adapter.health().state).toBe('failed')
  })
})

describe('inbound', () => {
  test('private and group messages, @ the account, CQ strings; its own posts are ignored', async () => {
    const net = snowluma()
    const { got, socket } = await started(net)
    socket.push(message({ message_id: 11 }))
    socket.push(
      message({
        message_id: 12,
        message_type: 'group',
        sub_type: 'normal',
        group_id: 20002000,
        group_name: '测试群',
        user_id: 30003001,
        sender: { user_id: 30003001, nickname: '李四', card: '老李' },
        message: [
          { type: 'at', data: { qq: SELF } },
          { type: 'text', data: { text: ' 帮我看看 ' } },
          { type: 'at', data: { qq: '40004000', name: '王五' } },
          { type: 'image', data: { url: 'https://x', summary: '截图' } },
        ],
      }),
    )
    socket.push(
      message({
        message_id: 13,
        message_type: 'group',
        group_id: 20002000,
        message: '[CQ:face,id=14]随便聊聊 &#91;不是码&#93;',
      }),
    )
    socket.push(message({ message_id: 14, user_id: Number(SELF) }))
    socket.push({ ...message({ message_id: 15 }), post_type: 'message_sent' })
    await until(() => got.length === 3)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(got).toHaveLength(3)
    expect(got[0]).toMatchObject({
      chat: { type: 'dm', id: '30003000' },
      messageId: '11',
      userName: '张三',
      text: '你好',
      addressed: true,
    })
    expect(got[1]).toMatchObject({
      chat: { type: 'group', id: '20002000' },
      chatName: '测试群',
      userName: '老李',
      text: '帮我看看 @王五',
      addressed: true,
      attachments: [{ name: '截图', kind: 'image' }],
    })
    expect(got[2]).toMatchObject({
      text: '[表情]随便聊聊 [不是码]',
      addressed: false,
    })
  })

  test('quoting the account is addressing it; other quotes are looked up', async () => {
    const net = snowluma({
      get_msg: frame => ({
        status: 'ok',
        retcode: 0,
        data: {
          message_id: (frame.params as Frame).message_id,
          sender: { user_id: 50005000, nickname: '赵六' },
          message: [{ type: 'text', data: { text: '原来那句' } }],
        },
      }),
    })
    const { adapter, got, socket } = await started(net)
    const own = await adapter.send(
      { type: 'group', id: '20002000' },
      '我说的话',
    )
    expect(own.ok).toBe(true)
    const group = {
      message_type: 'group',
      group_id: 20002000,
      sender: { user_id: 30003000, nickname: '张三' },
    }
    socket.push(
      message({
        ...group,
        message_id: 21,
        message: [
          { type: 'reply', data: { id: own.messageId } },
          { type: 'text', data: { text: '什么意思' } },
        ],
      }),
    )
    socket.push(
      message({
        ...group,
        message_id: 22,
        message: [
          { type: 'reply', data: { id: '777' } },
          { type: 'text', data: { text: '同意' } },
        ],
      }),
    )
    await until(() => got.length === 2)
    expect(got[0]).toMatchObject({
      addressed: true,
      quote: { own: true, text: '我说的话' },
    })
    expect(got[1]).toMatchObject({
      addressed: false,
      quote: { own: false, text: '原来那句', authorName: '赵六' },
    })
    expect(sent(socket, 'get_msg')).toHaveLength(1)
  })
})

describe('outbound', () => {
  test('a group reply quotes the message and @s its sender on the first chunk; the echo carries the id', async () => {
    const net = snowluma()
    const { adapter, got, socket } = await started(net)
    socket.push(
      message({
        message_id: 31,
        message_type: 'group',
        group_id: 20002000,
        message: [
          { type: 'at', data: { qq: SELF } },
          { type: 'text', data: { text: '在吗' } },
        ],
      }),
    )
    await until(() => got.length === 1)
    const result = await adapter.send(
      { type: 'group', id: '20002000' },
      '**在**，有事说',
      { replyTo: '31' },
    )
    expect(result.ok).toBe(true)
    expect(result.messageId).toMatch(/^\d+$/)
    const frame = sent(socket, 'send_group_msg')[0]!
    expect(frame.params).toEqual({
      group_id: 20002000,
      message: [
        { type: 'reply', data: { id: '31' } },
        { type: 'at', data: { qq: '30003000' } },
        { type: 'text', data: { text: '在，有事说' } },
      ],
    })
    await adapter.send({ type: 'dm', id: '30003000' }, '私聊')
    expect(sent(socket, 'send_private_msg')[0]!.params).toEqual({
      user_id: 30003000,
      message: [{ type: 'text', data: { text: '私聊' } }],
    })
  })

  test('a temporary session is its own chat, answered through its group', async () => {
    const net = snowluma()
    const { adapter, got, socket } = await started(net)
    const temp = (id: number, group: number) =>
      message({
        message_id: id,
        sub_type: 'group',
        sender: { user_id: 30003000, nickname: '张三', group_id: group },
      })
    socket.push(temp(41, 20002000))
    socket.push(temp(42, 20002001))
    socket.push(message({ message_id: 43 }))
    await until(() => got.length === 3)
    expect(got.map(one => one.chat)).toEqual([
      { type: 'dm', id: '30003000', threadId: 'temp:20002000' },
      { type: 'dm', id: '30003000', threadId: 'temp:20002001' },
      { type: 'dm', id: '30003000' },
    ])
    // The plain private message in between changes nobody's route.
    await adapter.send(got[0]!.chat, '好')
    await adapter.send(got[2]!.chat, '嗯')
    const frames = sent(socket, 'send_private_msg').map(frame => frame.params)
    expect(frames[0]).toMatchObject({ user_id: 30003000, group_id: 20002000 })
    expect(frames[1]).not.toHaveProperty('group_id')
  })

  test('a send while the socket is closing is refused as retryable, not counted as sent', async () => {
    const net = snowluma()
    const { adapter, socket } = await started(net)
    socket.readyState = 2
    expect(await adapter.send({ type: 'dm', id: '1' }, 'x')).toEqual({
      ok: false,
      error: 'SnowLuma 未连接',
      retryable: true,
    })
    expect(sent(socket, 'send_private_msg')).toHaveLength(0)
  })

  test('a refusal is reported with the backend wording; a missing echo counts as sent', async () => {
    let answer: unknown = {
      status: 'failed',
      retcode: 100,
      data: null,
      wording: '发送失败：被禁言',
    }
    const net = snowluma({ send_group_msg: () => answer })
    const { adapter } = await started(net)
    const refused = await adapter.send({ type: 'group', id: '1' }, 'x')
    expect(refused).toEqual({
      ok: false,
      error: 'QQ 发送失败（100 发送失败：被禁言）',
    })
    answer = undefined
    const silent = adapter.send({ type: 'group', id: '1' }, 'y')
    expect(
      await Promise.race([
        silent,
        new Promise(r => setTimeout(() => r('pending'), 20)),
      ]),
    ).toBe('pending')
  })

  test('sends from the account are spaced', async () => {
    const net = snowluma()
    const { adapter } = await started(net)
    await Promise.all([
      adapter.send({ type: 'dm', id: '1' }, 'a'),
      adapter.send({ type: 'dm', id: '2' }, 'b'),
    ])
    expect(net.sleeps.some(ms => ms > 0 && ms <= 800)).toBe(true)
  })

  test('a long reply is one merged-forward card; in a group a quoted lead line goes first', async () => {
    const net = snowluma()
    const { adapter, got, socket } = await started(net)
    socket.push(
      message({
        message_id: 51,
        message_type: 'group',
        group_id: 20002000,
        message: [
          { type: 'at', data: { qq: SELF } },
          { type: 'text', data: { text: '写个总结' } },
        ],
      }),
    )
    await until(() => got.length === 1)
    const long = Array.from(
      { length: 6 },
      (_, i) => `第${i}段${'字'.repeat(400)}`,
    ).join('\n\n')
    const result = await adapter.sendLong(
      { type: 'group', id: '20002000' },
      long,
      { replyTo: '51' },
    )
    expect(result?.ok).toBe(true)
    const lead = sent(socket, 'send_group_msg')[0]!.params as Frame
    expect((lead.message as Frame[])[0]).toEqual({
      type: 'reply',
      data: { id: '51' },
    })
    const card = sent(socket, 'send_group_forward_msg')[0]!.params as Frame
    const nodes = card.messages as { type: string; data: Frame }[]
    expect(nodes.length).toBeGreaterThan(1)
    expect(nodes[0]!.data).toMatchObject({
      name: '小阡',
      uin: SELF,
      nickname: '小阡',
      user_id: SELF,
    })
    const joined = nodes
      .map(node => ((node.data.content as Frame[])[0]!.data as Frame).text)
      .join('\n\n')
    expect(joined).toBe(long)
  })

  test('a card the backend refuses is declined, so the gateway sends chunks', async () => {
    const net = snowluma({
      send_private_forward_msg: () => ({
        status: 'failed',
        retcode: 1404,
        data: null,
      }),
    })
    const { adapter } = await started(net)
    expect(
      await adapter.sendLong({ type: 'dm', id: '1' }, 'x'.repeat(2_000)),
    ).toBeNull()
  })

  test('typing is private-only and stops asking a backend without it', async () => {
    const net = snowluma({
      set_input_status: () => ({ status: 'failed', retcode: 1404, data: null }),
    })
    const { adapter, socket } = await started(net)
    await adapter.typing({ type: 'group', id: '1' })
    await adapter.typing({ type: 'dm', id: '30003000' })
    await adapter.stopTyping({ type: 'dm', id: '30003000' })
    await adapter.typing({ type: 'dm', id: '30003000' })
    const frames = sent(socket, 'set_input_status')
    expect(frames).toHaveLength(1)
    expect(frames[0]!.params).toEqual({ user_id: 30003000, event_type: 1 })
  })
})

describe('helpers', () => {
  test('the allowlist holds no account-level action', () => {
    for (const action of [
      'get_cookies',
      'get_credentials',
      'get_clientkey',
      'request_decrypt_key',
      'send_packet',
      'bot_exit',
      'set_qq_profile',
      'delete_friend',
      'set_group_kick',
    ])
      expect(QQ_PERSONAL_ACTIONS.has(action)).toBe(false)
  })

  test('CQ codes become segments with their escapes undone', () => {
    expect(cqSegments('a[CQ:at,qq=1]b[CQ:reply,id=9]&amp;')).toEqual([
      { type: 'text', data: { text: 'a' } },
      { type: 'at', data: { qq: '1' } },
      { type: 'text', data: { text: 'b' } },
      { type: 'reply', data: { id: '9' } },
      { type: 'text', data: { text: '&' } },
    ])
  })

  test('forward nodes pack paragraphs and split the ones that are too long', () => {
    expect(forwardNodes('a\n\nb', 10)).toEqual(['a\n\nb'])
    expect(forwardNodes(`${'x'.repeat(25)}\n\nyy`, 10)).toEqual([
      'x'.repeat(10),
      'x'.repeat(10),
      `${'x'.repeat(5)}\n\nyy`,
    ])
  })
})
