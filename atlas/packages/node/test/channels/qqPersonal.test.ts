// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The personal QQ adapter against a scripted SnowLuma (OneBot 11 forward
 * WebSocket): handshake, the two health domains, inbound mapping, sends
 * acknowledged by echo, the action allowlist, and the reply shaping ported
 * from grantley (its `test_hermes_bubble_cap.py`, `test_hermes_router.py`
 * and `test_hermes_reply_quote.py` are the specification). Not run against
 * a real account (`evaluated: false`).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  QQ_PERSONAL_ACTIONS,
  QqPersonalAdapter,
  cqSegments,
  forwardNodes,
} from '../../src/channels/qqPersonal.js'
import {
  capBubbles,
  chunkText,
  classifyOnebotError,
  FORWARD_LEAD_TEXT,
  FORWARD_TEXT_THRESHOLD,
  LONG_REPLY_MARKER,
  MAX_MESSAGE_LENGTH,
  planReply,
  qqPersonalGroupGate,
  splitBubbles,
  stripMarkdown,
} from '../../src/channels/rules/qqPersonal.js'
import type { ChannelInbound, GroupPolicy } from '../../src/channels/types.js'
import { FakeNet, type FakeSocket, inbound, until } from './fakes.js'

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
        { type: 'text', data: { text: ' 在，有事说' } },
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

  test('a send still queued when SnowLuma goes away is not counted as sent', async () => {
    const net = snowluma({
      send_private_msg: frame =>
        (frame.params as { message: { data: { text?: string } }[] }).message[0]!
          .data.text === 'first'
          ? undefined
          : { status: 'ok', retcode: 0, data: { message_id: 1 } },
    })
    const { adapter, socket } = await started(net)
    const first = adapter.send({ type: 'dm', id: '1' }, 'first')
    const second = adapter.send({ type: 'dm', id: '1' }, 'second')
    await until(() => sent(socket, 'send_private_msg').length === 1)
    // SnowLuma stays away: no reconnect to carry the second message.
    net.refuseSockets = true
    net.on('http://127.0.0.1:3001', { status: 426 })
    socket.close(1006, 'gone')
    // Written but never acknowledged: may have arrived, so it counts as sent.
    expect(await first).toEqual({ ok: true })
    expect(await second).toEqual({
      ok: false,
      error: 'SnowLuma 未连接',
      retryable: true,
    })
    expect(
      sent(socket, 'send_private_msg').map(
        frame =>
          (frame.params as { message: { data: { text?: string } }[] })
            .message[0]!.data.text,
      ),
    ).toEqual(['first'])
  })

  test('a token that cannot go into a header stops the channel without echoing it', async () => {
    const net = snowluma()
    const adapter = new QqPersonalAdapter(
      { url: 'ws://127.0.0.1:3001/', accessToken: 'sec\nret' },
      net.io(),
    )
    running.push(adapter)
    await adapter.start(() => {})
    await until(() => adapter.health().state === 'failed')
    expect(adapter.health().detail).toBe(
      'OneBot 访问令牌含有不能放进请求头的字符，请重新填写',
    )
    expect(net.sockets).toHaveLength(0)
    expect(JSON.stringify([adapter.health(), net.errors])).not.toContain('sec')
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

// ---------------------------------------------------------------------------
// Reply shaping, ported from grantley `test_hermes_bubble_cap.py` and
// `test_hermes_reply_quote.py`
// ---------------------------------------------------------------------------

const SEP = '[MSG_BREAK]'
const DM = { type: 'dm', id: '30003000' } as const
const ROOM = { type: 'group', id: '20002000' } as const

type Seg = { type: string; data: Frame }

function plainFrames(socket: FakeSocket): Frame[] {
  return (socket.sent as Frame[]).filter(
    frame =>
      frame.action === 'send_private_msg' || frame.action === 'send_group_msg',
  )
}

function sendFrames(socket: FakeSocket): Frame[] {
  return (socket.sent as Frame[]).filter(frame =>
    String(frame.action).startsWith('send_'),
  )
}

function segmentsOf(frame: Frame): Seg[] {
  return (frame.params as Frame).message as Seg[]
}

function wire(socket: FakeSocket): string[] {
  return plainFrames(socket).map(frame =>
    segmentsOf(frame)
      .filter(seg => seg.type === 'text')
      .map(seg => String(seg.data.text))
      .join('')
      .trimStart(),
  )
}

function cards(socket: FakeSocket): Frame[] {
  return (socket.sent as Frame[]).filter(frame =>
    String(frame.action).endsWith('_forward_msg'),
  )
}

function nodeTexts(socket: FakeSocket): string[] {
  const card = cards(socket)[0]!.params as Frame
  return (card.messages as { data: Frame }[]).map(node =>
    String(((node.data.content as Seg[])[0]!.data as Frame).text),
  )
}

const quotes = (frame: Frame) =>
  frame.action !== undefined &&
  !String(frame.action).endsWith('_forward_msg') &&
  segmentsOf(frame).some(seg => seg.type === 'reply')
const ats = (frame: Frame) =>
  !String(frame.action).endsWith('_forward_msg') &&
  segmentsOf(frame).some(seg => seg.type === 'at')

/** Answers for one action, in order; afterwards the default. */
function queue(...answers: unknown[]) {
  let n = 0
  return () =>
    answers.length > 0
      ? answers.shift()
      : { status: 'ok', retcode: 0, data: { message_id: 7000 + ++n } }
}

const failed = (retcode: number, message: string) => ({
  status: 'failed',
  retcode,
  data: null,
  message,
})

/** A group message from 777 the reply will answer. */
async function asked(
  socket: FakeSocket,
  got: ChannelInbound[],
  id = 55501,
): Promise<void> {
  socket.push(
    message({
      message_id: id,
      message_type: 'group',
      group_id: Number(ROOM.id),
      user_id: 777,
      sender: { user_id: 777, nickname: '七七七' },
      message: [
        { type: 'at', data: { qq: SELF } },
        { type: 'text', data: { text: '问一下' } },
      ],
    }),
  )
  await until(() => got.some(one => one.messageId === String(id)))
}

describe('reply shaping (grantley send)', () => {
  test('one to three bubbles go out as written; only the first quotes', async () => {
    const net = snowluma()
    const { adapter, socket } = await started(net)
    const parts = ['先说这个', '再说那个', '还有这个']
    const result = await adapter.sendReply(DM, parts.join(SEP), {
      replyTo: '55501',
    })
    expect(result.ok).toBe(true)
    expect(cards(socket)).toEqual([])
    expect(wire(socket)).toEqual(parts)
    expect(plainFrames(socket).map(quotes)).toEqual([true, false, false])
    expect(segmentsOf(plainFrames(socket)[0]!)[0]).toEqual({
      type: 'reply',
      data: { id: '55501' },
    })
  })

  test('in a group only the first bubble @s and quotes the asker', async () => {
    const net = snowluma()
    const { adapter, got, socket } = await started(net)
    await asked(socket, got)
    await adapter.sendReply(
      ROOM,
      ['先说这个', '再说那个', '还有这个'].join(SEP),
      {
        replyTo: '55501',
      },
    )
    const frames = plainFrames(socket)
    expect(frames.map(ats)).toEqual([true, false, false])
    expect(frames.map(quotes)).toEqual([true, false, false])
    expect(segmentsOf(frames[0]!)[1]).toEqual({
      type: 'at',
      data: { qq: '777' },
    })
  })

  test('length and bubble count route to a card only when strictly past the limit', async () => {
    const net = snowluma()
    const { adapter, socket } = await started(net)
    const at = '字'.repeat(FORWARD_TEXT_THRESHOLD)
    await adapter.sendReply(DM, at)
    expect(cards(socket)).toEqual([])
    expect(wire(socket)).toEqual([at])
    const past = '字'.repeat(FORWARD_TEXT_THRESHOLD + 1)
    await adapter.sendReply(DM, past)
    expect(cards(socket)).toHaveLength(1)
    expect(nodeTexts(socket).join('')).toBe(past)
    const four = ['一', '二', '三', '四']
    await adapter.sendReply(DM, four.join(SEP))
    expect(cards(socket)).toHaveLength(2)
    const second = cards(socket)[1]!.params as Frame
    expect(
      (second.messages as { data: Frame }[]).map(
        node => ((node.data.content as Seg[])[0]!.data as Frame).text,
      ),
    ).toEqual(four)
    expect(wire(socket)).toEqual([at])
  })

  test('a long private reply is exactly one card; in a group a quoted @ lead line goes first', async () => {
    const net = snowluma()
    const { adapter, got, socket } = await started(net)
    await adapter.sendReply(DM, '很长的回答'.repeat(300), { replyTo: '1' })
    expect(sendFrames(socket)).toHaveLength(1)
    expect(sendFrames(socket)[0]!.action).toBe('send_private_forward_msg')
    await asked(socket, got)
    await adapter.sendReply(ROOM, '很长的回答'.repeat(300), {
      replyTo: '55501',
    })
    const [lead, card] = sendFrames(socket).slice(1)
    expect(lead!.action).toBe('send_group_msg')
    expect(ats(lead!) && quotes(lead!)).toBe(true)
    expect(wire(socket)).toEqual([FORWARD_LEAD_TEXT])
    expect(card!.action).toBe('send_group_forward_msg')
    const node = ((card!.params as Frame).messages as { data: Frame }[])[0]!
    expect(node.data).toMatchObject({
      name: '小阡',
      uin: SELF,
      nickname: '小阡',
      user_id: SELF,
    })
  })

  test('[LONG_REPLY] sends a short complete answer as a card with its code and sources', async () => {
    const net = snowluma()
    const { adapter, socket } = await started(net)
    const body =
      'def _calc_(x):\n    return x ** 2 * 3\n\n依据：https://docs.python.org/3/'
    expect(body.length).toBeLessThan(FORWARD_TEXT_THRESHOLD)
    expect(
      (await adapter.sendReply(DM, `${LONG_REPLY_MARKER}\n${body}`)).ok,
    ).toBe(true)
    expect(nodeTexts(socket)).toEqual([body])
    expect(JSON.stringify(socket.sent)).not.toContain(LONG_REPLY_MARKER)
  })

  test('chat bubbles lose their Markdown; a card keeps everything but the fences', async () => {
    const net = snowluma()
    const { adapter, socket } = await started(net)
    await adapter.sendReply(DM, '**粗** 和 [文档](https://x.y/z) `code`')
    expect(wire(socket)).toEqual(['粗 和 文档 code'])
    await adapter.sendReply(
      DM,
      `${LONG_REPLY_MARKER}\n\`\`\`py\na_b = 1\n\`\`\`\n见 [文档](https://x.y/z)`,
    )
    expect(nodeTexts(socket)).toEqual(['a_b = 1\n见 [文档](https://x.y/z)'])
  })

  test('a refused card falls back to at most three bubbles without losing a word', async () => {
    const net = snowluma({
      send_private_forward_msg: queue(failed(1200, 'forward unsupported')),
    })
    const { adapter, socket } = await started(net)
    const parts = Array.from({ length: 8 }, (_, i) => `第${i + 1}句话内容`)
    const result = await adapter.sendReply(DM, parts.join(SEP))
    expect(result.ok).toBe(true)
    expect(cards(socket)).toHaveLength(1)
    const messages = wire(socket)
    expect(messages).toHaveLength(3)
    expect(messages[2]).toBe(parts.slice(2).join('\n'))
    for (const part of parts) expect(messages.join('')).toContain(part)
  })

  test('an explicit card that is refused still delivers the complete answer', async () => {
    const net = snowluma({
      send_private_forward_msg: queue(failed(1200, 'try later')),
    })
    const { adapter, socket } = await started(net)
    const body = 'return x ** 2 * 3\n参考：https://docs.python.org/3/'
    expect((await adapter.sendReply(DM, LONG_REPLY_MARKER + body)).ok).toBe(
      true,
    )
    expect(wire(socket)).toEqual([body])
  })

  test('a card refused after its lead line does not quote or @ again', async () => {
    const net = snowluma({
      send_group_forward_msg: queue(failed(1200, 'unsupported')),
    })
    const { adapter, got, socket } = await started(net)
    await asked(socket, got)
    const parts = ['第一句', '第二句', '第三句', '第四句']
    const result = await adapter.sendReply(ROOM, parts.join(SEP), {
      replyTo: '55501',
    })
    expect(result.ok).toBe(true)
    const frames = sendFrames(socket)
    expect(frames[0]!.action).toBe('send_group_msg')
    expect(frames[1]!.action).toBe('send_group_forward_msg')
    expect(
      frames.slice(2).every(frame => frame.action === 'send_group_msg'),
    ).toBe(true)
    expect(frames.filter(ats)).toHaveLength(1)
    expect(frames.filter(quotes)).toHaveLength(1)
    for (const part of parts)
      expect(wire(socket).slice(1).join('')).toContain(part)
  })

  test('a lead line that fails for a passing reason skips the card; the bubbles quote and @', async () => {
    const net = snowluma({ send_group_msg: queue(failed(1200, 'send failed')) })
    const { adapter, got, socket } = await started(net)
    await asked(socket, got)
    const result = await adapter.sendReply(
      ROOM,
      ['第一句', '第二句', '第三句', '第四句'].join(SEP),
      { replyTo: '55501' },
    )
    expect(result.ok).toBe(true)
    expect(cards(socket)).toEqual([])
    const second = plainFrames(socket)[1]!
    expect(ats(second) && quotes(second)).toBe(true)
    expect(wire(socket)[1]).toContain('第一句')
  })

  test('a forbidden or vanished chat is reported, never retried as bubbles', async () => {
    const lead = snowluma({ send_group_msg: queue(failed(1403, 'forbidden')) })
    const one = await started(lead)
    await asked(one.socket, one.got)
    const refused = await one.adapter.sendReply(
      ROOM,
      ['第一句', '第二句', '第三句', '第四句'].join(SEP),
      { replyTo: '55501' },
    )
    expect(refused.ok).toBe(false)
    expect(refused.retryable).toBeUndefined()
    expect(sendFrames(one.socket)).toHaveLength(1)

    const card = snowluma({
      send_group_forward_msg: queue(failed(1403, 'forbidden')),
    })
    const two = await started(card)
    await asked(two.socket, two.got)
    const after = await two.adapter.sendReply(
      ROOM,
      ['第一句', '第二句', '第三句', '第四句'].join(SEP),
      { replyTo: '55501' },
    )
    expect(after.ok).toBe(false)
    expect(sendFrames(two.socket).map(frame => frame.action)).toEqual([
      'send_group_msg',
      'send_group_forward_msg',
    ])

    const gone = snowluma({
      send_private_forward_msg: queue(failed(1404, 'unknown target')),
    })
    const three = await started(gone)
    const dead = await three.adapter.sendReply(DM, '很长的回答'.repeat(300))
    expect(dead.ok).toBe(false)
    expect(plainFrames(three.socket)).toEqual([])
  })

  test('a passing failure is retryable only while nothing reached the chat', async () => {
    const net = snowluma({
      send_private_msg: queue(
        failed(1200, 'connection closed'),
        { status: 'ok', retcode: 0, data: { message_id: 1 } },
        failed(1200, 'connection closed'),
      ),
    })
    const { adapter } = await started(net)
    const first = await adapter.sendReply(DM, '一句话')
    expect(first).toMatchObject({ ok: false, retryable: true })
    const partial = await adapter.sendReply(DM, ['一', '二'].join(SEP))
    expect(partial.ok).toBe(false)
    expect(partial.retryable).toBeUndefined()
  })
})

describe('grantley rules', () => {
  const policy = (over: Partial<GroupPolicy> = {}): GroupPolicy => ({
    trigger: 'mention',
    freeGroups: [],
    keywords: [],
    followed: false,
    ...over,
  })
  const said = (text: string, addressed = false) =>
    inbound({ chat: { type: 'group', id: '9999' }, text, addressed })

  test('the default is mention-only; configured keywords also wake it, case aside', () => {
    expect(qqPersonalGroupGate(said('闲聊'), policy())).toBeNull()
    expect(qqPersonalGroupGate(said('在吗', true), policy())).toBe('explicit')
    const kw = policy({ keywords: ['格兰', 'Aemeath'] })
    expect(qqPersonalGroupGate(said('格兰在吗'), kw)).toBe('implicit')
    expect(qqPersonalGroupGate(said('hey AEMEATH there'), kw)).toBe('implicit')
    expect(qqPersonalGroupGate(said('吃了吗'), kw)).toBeNull()
    // An @ needs no keyword.
    expect(
      qqPersonalGroupGate(said('help', true), policy({ keywords: ['never'] })),
    ).toBe('explicit')
  })

  test('`all` answers everything, unless keywords are set', () => {
    expect(qqPersonalGroupGate(said('随便'), policy({ trigger: 'all' }))).toBe(
      'implicit',
    )
    const kw = policy({ trigger: 'all', keywords: ['格兰'] })
    expect(qqPersonalGroupGate(said('格兰'), kw)).toBe('implicit')
    expect(qqPersonalGroupGate(said('nope'), kw)).toBeNull()
  })

  test('a slash command is not a summons in a group', () => {
    expect(
      qqPersonalGroupGate(said('/status'), policy({ keywords: ['never'] })),
    ).toBeNull()
  })

  test('bubbles: split on the marker, overflow merged into the last, nothing lost', () => {
    expect(splitBubbles(`a${SEP}${SEP} b `)).toEqual(['a', 'b'])
    expect(splitBubbles('  ')).toEqual([])
    const parts = ['a', 'b', 'c', 'd', 'e']
    expect(capBubbles(parts, 3)).toEqual(['a', 'b', 'c\nd\ne'])
    expect(capBubbles(parts, 1)).toEqual(['a\nb\nc\nd\ne'])
    expect(capBubbles(parts, 0)).toEqual(parts)
    expect(capBubbles(['a', 'b', 'c'], 3)).toEqual(['a', 'b', 'c'])
    expect(capBubbles([], 3)).toEqual([])
  })

  test('chunks are cut at paragraphs, then lines, then sentences, and numbered', () => {
    expect(chunkText('短')).toEqual(['短'])
    const body = `${'甲'.repeat(3000)}\n\n${'乙'.repeat(3000)}`
    const chunks = chunkText(body)
    expect(chunks).toEqual([
      `(1/2)\n${'甲'.repeat(3000)}`,
      `(2/2)\n${'乙'.repeat(3000)}`,
    ])
    for (const chunk of chunkText('字'.repeat(MAX_MESSAGE_LENGTH * 2)))
      expect(chunk.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH)
    const sentences = chunkText(`${'句'.repeat(60)}。${'尾'.repeat(30)}`, 80)
    expect(sentences[0]).toBe(`(1/2)\n${'句'.repeat(60)}。`)
  })

  test('chat strips Markdown the hermes way; a plan is decided on the whole reply', () => {
    expect(
      stripMarkdown('## 标题\n**粗**和*斜*，[链接](https://a.b)\n\n\n\n尾'),
    ).toBe('标题\n粗和斜，链接\n\n尾')
    expect(planReply('x'.repeat(1_001)).card).toBe(true)
    expect(planReply(['1', '2', '3'].join(SEP)).card).toBe(false)
    expect(planReply(`  ${LONG_REPLY_MARKER} 短`)).toEqual({
      content: '短',
      bubbles: ['短'],
      card: true,
    })
  })

  test('OneBot failures: phrases first, then retcodes, then QQ wording', () => {
    expect(classifyOnebotError(1200, 'Too Many Requests')).toBe('rate_limited')
    expect(classifyOnebotError(1404, '')).toBe('not_found')
    expect(classifyOnebotError(1401)).toBe('forbidden')
    expect(classifyOnebotError(100, '发送失败：被禁言')).toBe('forbidden')
    expect(classifyOnebotError(100, '群不存在')).toBe('not_found')
    expect(classifyOnebotError(100, '发送过快')).toBe('rate_limited')
    expect(classifyOnebotError(100, '消息过长')).toBe('too_long')
    expect(classifyOnebotError(1200, 'timeout')).toBe('transient')
    expect(classifyOnebotError(1200, 'try later')).toBe('unknown')
  })
})
