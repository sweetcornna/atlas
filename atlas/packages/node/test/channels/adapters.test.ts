// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The five platform adapters against a scripted network (P28): each speaks
 * its platform's official protocol — the requests it makes, the frames it
 * sends, what it hands the gateway — and stops cleanly. None of this has run
 * against a real account (`evaluated: false`).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { DiscordAdapter } from '../../src/channels/discord.js'
import { QqAdapter } from '../../src/channels/qq.js'
import { SlackAdapter } from '../../src/channels/slack.js'
import { TelegramAdapter } from '../../src/channels/telegram.js'
import type {
  ChannelAdapter,
  ChannelInbound,
} from '../../src/channels/types.js'
import {
  ILINK_BASE_URL,
  WeixinAdapter,
  ilinkBaseUrl,
  weixinQrPoll,
  weixinQrStart,
} from '../../src/channels/weixin.js'
import { FakeNet, until } from './fakes.js'

const running: ChannelAdapter[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(adapter => adapter.stop()))
})

async function started<T extends ChannelAdapter>(
  adapter: T,
): Promise<{ adapter: T; got: ChannelInbound[] }> {
  const got: ChannelInbound[] = []
  running.push(adapter)
  await adapter.start(message => got.push(message))
  return { adapter, got }
}

describe('Telegram', () => {
  function world(updates: unknown[]) {
    let polls = 0
    return new FakeNet()
      .on('/getMe', {
        body: { ok: true, result: { id: 42, username: 'qm_bot' } },
      })
      .on('/getUpdates', () =>
        polls++ === 0 ? { body: { ok: true, result: updates } } : undefined,
      )
  }

  test('long polls, keeps the offset, and hands over what was meant for it', async () => {
    const offsets: number[] = []
    const net = world([
      {
        update_id: 7,
        message: {
          message_id: 1,
          chat: { id: 100, type: 'private' },
          from: { id: 5, first_name: '陈' },
          text: '你好',
        },
      },
      {
        update_id: 8,
        message: {
          message_id: 2,
          chat: { id: -200, type: 'supergroup', title: '项目群' },
          from: { id: 6, username: 'li' },
          text: '@qm_bot 看下',
          is_topic_message: true,
          message_thread_id: 33,
        },
      },
      {
        update_id: 9,
        message: {
          message_id: 3,
          chat: { id: -200, type: 'supergroup' },
          from: { id: 6 },
          text: '闲聊',
        },
      },
      {
        update_id: 10,
        message: {
          message_id: 4,
          chat: { id: 100, type: 'private' },
          from: { id: 9, is_bot: true },
          text: 'x',
        },
      },
    ])
    const { adapter, got } = await started(
      new TelegramAdapter(
        { token: 'T0K', offset: 3, onOffset: offset => offsets.push(offset) },
        net.io(),
      ),
    )
    await until(() => net.to('/getUpdates').length === 2)
    expect(adapter.health().state).toBe('connected')
    expect(
      net.to('/getUpdates').map(one => (one.body as { offset: number }).offset),
    ).toEqual([3, 11])
    expect(offsets).toEqual([11])
    expect(
      got.map(one => [
        one.chat.type,
        one.chat.id,
        one.chat.threadId,
        one.text,
        one.addressed,
      ]),
    ).toEqual([
      ['dm', '100', undefined, '你好', true],
      ['group', '-200', '33', '看下', true],
      ['group', '-200', undefined, '闲聊', false],
    ])
    expect(got[1]!.chatName).toBe('项目群')
    expect(net.exchanges[0]!.url).toBe('https://api.telegram.org/botT0K/getMe')
  })

  test('sends MarkdownV2 as a native reply, and the same words plain when Telegram rejects the entities', async () => {
    let first = true
    const net = new FakeNet().on('/sendMessage', exchange => {
      const body = exchange.body as { parse_mode?: string }
      if (body.parse_mode && first) {
        first = false
        return { status: 400, body: { ok: false } }
      }
      return { body: { ok: true, result: { message_id: 77 } } }
    })
    const adapter = new TelegramAdapter({ token: 'T' }, net.io())
    const sent = await adapter.send(
      { type: 'group', id: '-1', threadId: '5' },
      '**完成** v1.2',
      { replyTo: '12' },
    )
    expect(sent).toEqual({ ok: true, messageId: '77' })
    expect(net.exchanges.map(one => one.body)).toEqual([
      {
        chat_id: '-1',
        message_thread_id: 5,
        reply_parameters: { message_id: 12, allow_sending_without_reply: true },
        text: '*完成* v1\\.2',
        parse_mode: 'MarkdownV2',
      },
      {
        chat_id: '-1',
        message_thread_id: 5,
        reply_parameters: { message_id: 12, allow_sending_without_reply: true },
        text: '完成 v1.2',
      },
    ])
  })

  test('a rejected token stops the channel with a reason', async () => {
    const net = new FakeNet().on('/getMe', { status: 401, body: { ok: false } })
    const { adapter } = await started(
      new TelegramAdapter({ token: 'bad' }, net.io()),
    )
    await until(() => adapter.health().state === 'failed')
    expect(adapter.health().detail).toBe('Telegram 拒绝了机器人令牌')
    expect(net.errors.join()).not.toContain('bad')
  })
})

describe('Discord', () => {
  function world() {
    return new FakeNet()
      .on('/gateway/bot', { body: { url: 'wss://gateway.discord.gg' } })
      .on('/messages', { body: { id: 'm-out' } })
  }

  test('identifies, then hands over guild mentions and DMs', async () => {
    const net = world()
    const { adapter, got } = await started(
      new DiscordAdapter({ token: 'D' }, net.io()),
    )
    await until(() => net.sockets.length === 1)
    const socket = net.sockets[0]!
    expect(socket.url).toBe('wss://gateway.discord.gg/?v=10&encoding=json')
    socket.push({ op: 10, d: { heartbeat_interval: 60_000 } })
    expect(socket.ops(2)).toEqual([
      {
        op: 2,
        d: {
          token: 'D',
          intents: 37_377,
          properties: {
            os: process.platform,
            browser: 'qianmo',
            device: 'qianmo',
          },
        },
      },
    ])
    socket.push({
      op: 0,
      s: 1,
      t: 'READY',
      d: {
        user: { id: 'bot' },
        session_id: 'sess',
        resume_gateway_url: 'wss://us-east.discord.gg',
      },
    })
    expect(adapter.health().state).toBe('connected')
    socket.push({
      op: 0,
      s: 2,
      t: 'MESSAGE_CREATE',
      d: {
        id: 'm1',
        channel_id: 'c1',
        guild_id: 'g',
        content: '<@bot> 总结一下',
        mentions: [{ id: 'bot' }],
        author: { id: 'u1', username: 'li' },
        member: { nick: '老李' },
      },
    })
    socket.push({
      op: 0,
      s: 3,
      t: 'MESSAGE_CREATE',
      d: {
        id: 'm2',
        channel_id: 'd1',
        content: '在吗',
        author: { id: 'u2', username: 'wang' },
      },
    })
    socket.push({
      op: 0,
      s: 4,
      t: 'MESSAGE_CREATE',
      d: {
        id: 'm3',
        channel_id: 'd1',
        content: 'x',
        author: { id: 'b', bot: true },
      },
    })
    expect(
      got.map(one => [
        one.chat.type,
        one.chat.id,
        one.userName,
        one.text,
        one.addressed,
      ]),
    ).toEqual([
      ['group', 'c1', '老李', '总结一下', true],
      ['dm', 'd1', 'wang', '在吗', true],
    ])
    // A dropped connection resumes the session where it left off.
    socket.close(1006)
    await until(() => net.sockets.length === 2)
    const second = net.sockets[1]!
    expect(second.url).toBe('wss://us-east.discord.gg/?v=10&encoding=json')
    second.push({ op: 10, d: { heartbeat_interval: 60_000 } })
    expect(second.ops(6)).toEqual([
      { op: 6, d: { token: 'D', session_id: 'sess', seq: 4 } },
    ])
  })

  test('a missing Message Content intent stops the channel', async () => {
    const net = world()
    const { adapter } = await started(
      new DiscordAdapter({ token: 'D' }, net.io()),
    )
    await until(() => net.sockets.length === 1)
    net.sockets[0]!.close(4014)
    await until(() => adapter.health().state === 'failed')
    expect(adapter.health().detail).toBe('机器人没有开启 Message Content 意图')
  })

  test('replies by reference, without pinging anyone; a 429 goes back with its wait', async () => {
    let calls = 0
    const net = new FakeNet().on('/messages', () =>
      calls++ === 0
        ? { status: 429, body: { retry_after: 1.5 } }
        : { body: { id: 'm9' } },
    )
    const adapter = new DiscordAdapter({ token: 'D' }, net.io())
    expect(
      await adapter.send({ type: 'group', id: 'c1' }, 'ok', { replyTo: 'm1' }),
    ).toEqual({ ok: false, error: 'Discord 限流', retryAfterMs: 1_500 })
    expect(net.sleeps).toEqual([])
    expect(
      await adapter.send({ type: 'group', id: 'c1' }, 'ok', { replyTo: 'm1' }),
    ).toEqual({ ok: true, messageId: 'm9' })
    expect(net.exchanges[1]!.headers.authorization).toBe('Bot D')
    expect(net.exchanges[1]!.body).toEqual({
      content: 'ok',
      allowed_mentions: { parse: [], replied_user: false },
      message_reference: { message_id: 'm1', fail_if_not_exists: false },
    })
  })

  test('a reference Discord rejects is dropped and the words still go', async () => {
    const net = new FakeNet().on('/messages', exchange =>
      (exchange.body as { message_reference?: unknown }).message_reference
        ? { status: 400, body: { code: 50035 } }
        : { body: { id: 'm2' } },
    )
    const adapter = new DiscordAdapter({ token: 'D' }, net.io())
    expect(
      await adapter.send({ type: 'group', id: 'c1' }, 'ok', {
        replyTo: 'gone',
      }),
    ).toEqual({ ok: true, messageId: 'm2' })
    expect(net.exchanges).toHaveLength(2)
  })
})

describe('Slack', () => {
  function world() {
    return new FakeNet()
      .on('/auth.test', { body: { ok: true, user_id: 'UBOT' } })
      .on('/apps.connections.open', {
        body: { ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=1' },
      })
      .on('/users.info', {
        body: { ok: true, user: { profile: { display_name: '小陈' } } },
      })
      .on('/chat.postMessage', { body: { ok: true, ts: '200.1' } })
  }

  test('acks every envelope and threads channel conversations', async () => {
    const net = world()
    const { adapter, got } = await started(
      new SlackAdapter({ appToken: 'xapp-1', botToken: 'xoxb-1' }, net.io()),
    )
    await until(() => net.sockets.length === 1)
    expect(net.to('/auth.test')[0]!.headers.authorization).toBe('Bearer xoxb-1')
    expect(net.to('/apps.connections.open')[0]!.headers.authorization).toBe(
      'Bearer xapp-1',
    )
    const socket = net.sockets[0]!
    socket.push({ type: 'hello' })
    expect(adapter.health().state).toBe('connected')
    socket.push({
      type: 'events_api',
      envelope_id: 'e1',
      payload: {
        event: {
          type: 'app_mention',
          user: 'U1',
          channel: 'C1',
          channel_type: 'channel',
          text: '<@UBOT> 周报',
          ts: '100.1',
        },
      },
    })
    socket.push({
      type: 'events_api',
      envelope_id: 'e2',
      payload: {
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          text: '私聊',
          ts: '100.2',
        },
      },
    })
    socket.push({
      type: 'events_api',
      envelope_id: 'e3',
      payload: {
        event: {
          type: 'message',
          subtype: 'bot_message',
          bot_id: 'B',
          channel: 'C1',
          text: 'x',
          ts: '1',
        },
      },
    })
    await until(() => got.length === 2)
    expect(socket.sent).toEqual([
      { envelope_id: 'e1' },
      { envelope_id: 'e2' },
      { envelope_id: 'e3' },
    ])
    expect(
      got.map(one => [
        one.chat.type,
        one.chat.id,
        one.chat.threadId,
        one.text,
        one.userName,
        one.addressed,
      ]),
    ).toEqual([
      ['group', 'C1', '100.1', '周报', '小陈', true],
      ['dm', 'D1', undefined, '私聊', '小陈', true],
    ])
    expect(net.to('/users.info')).toHaveLength(1)
  })

  test('posts into the thread in mrkdwn; stops asking for a status it may not set', async () => {
    const net = world().on('/assistant.threads.setStatus', {
      body: { ok: false, error: 'missing_scope' },
    })
    const adapter = new SlackAdapter(
      { appToken: 'xapp-1', botToken: 'xoxb-1' },
      net.io(),
    )
    const chat = { type: 'group' as const, id: 'C1', threadId: '100.1' }
    expect(await adapter.send(chat, '**好**')).toEqual({
      ok: true,
      messageId: '200.1',
    })
    expect(net.to('/chat.postMessage')[0]!.body).toEqual({
      channel: 'C1',
      text: '*好*',
      thread_ts: '100.1',
      unfurl_links: false,
    })
    await adapter.typing(chat)
    await adapter.typing({ ...chat, id: 'C2' })
    expect(net.to('/assistant.threads.setStatus')).toHaveLength(1)
  })
})

describe('QQ', () => {
  function world() {
    return new FakeNet()
      .on('getAppAccessToken', {
        body: { access_token: 'ACC', expires_in: 7200 },
      })
      .on('/gateway', { body: { url: 'wss://api.sgroup.qq.com/websocket' } })
      .on('/messages', { body: { id: 'out' } })
  }

  test('exchanges AppID and secret for a token, identifies, and hands over private and group @-messages', async () => {
    const net = world()
    const { adapter, got } = await started(
      new QqAdapter({ appId: '1020', appSecret: 'SEC' }, net.io()),
    )
    await until(() => net.sockets.length === 1)
    expect(net.to('getAppAccessToken')[0]!.body).toEqual({
      appId: '1020',
      clientSecret: 'SEC',
    })
    expect(net.to('/gateway')[0]!.headers).toMatchObject({
      authorization: 'QQBot ACC',
      'x-union-appid': '1020',
    })
    const socket = net.sockets[0]!
    socket.push({ op: 10, d: { heartbeat_interval: 45_000 } })
    await until(() => socket.ops(2).length === 1)
    expect(socket.ops(2)[0]).toEqual({
      op: 2,
      d: { token: 'QQBot ACC', intents: 1 << 25, shard: [0, 1] },
    })
    socket.push({ op: 0, s: 1, t: 'READY', d: { session_id: 'qs' } })
    expect(adapter.health().state).toBe('connected')
    socket.push({
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'q1', content: ' 你好 ', author: { user_openid: 'OPEN1' } },
    })
    socket.push({
      op: 0,
      s: 3,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'q2',
        group_openid: 'G1',
        content: '@小阡 这个',
        message_type: 103,
        msg_elements: [{ content: '原话' }],
        author: { member_openid: 'M1' },
      },
    })
    expect(
      got.map(one => [
        one.chat.type,
        one.chat.id,
        one.userId,
        one.text,
        one.quote?.text,
      ]),
    ).toEqual([
      ['dm', 'OPEN1', 'OPEN1', '你好', undefined],
      ['group', 'G1', 'M1', '这个', '原话'],
    ])
    // Passive replies: bound to the triggering message, msg_seq counting
    // up; QQ Markdown, as hermes sends it.
    await adapter.send({ type: 'dm', id: 'OPEN1' }, '**一**')
    await adapter.send({ type: 'dm', id: 'OPEN1' }, '二', { replyTo: 'q1' })
    await adapter.send({ type: 'group', id: 'G1' }, '三')
    expect(
      net
        .to('/messages')
        .map(one => [
          one.url.replace('https://api.sgroup.qq.com', ''),
          one.body,
        ]),
    ).toEqual([
      [
        '/v2/users/OPEN1/messages',
        {
          markdown: { content: '**一**' },
          msg_type: 2,
          msg_id: 'q1',
          msg_seq: 1,
        },
      ],
      [
        '/v2/users/OPEN1/messages',
        { markdown: { content: '二' }, msg_type: 2, msg_id: 'q1', msg_seq: 2 },
      ],
      [
        '/v2/groups/G1/messages',
        { markdown: { content: '三' }, msg_type: 2, msg_id: 'q2', msg_seq: 1 },
      ],
    ])
    // The typing notice exists for private chats only.
    await adapter.typing({ type: 'group', id: 'G1' })
    await adapter.typing({ type: 'dm', id: 'OPEN1' }, 'q1')
    expect(net.to('/messages').at(-1)!.body).toEqual({
      msg_type: 6,
      input_notify: { input_type: 1, input_second: 60 },
      msg_id: 'q1',
      msg_seq: 3,
    })
    // An expired token closes with 4004: reconnect with a fresh one and resume.
    socket.close(4004)
    await until(() => net.sockets.length === 2)
    expect(net.to('getAppAccessToken')).toHaveLength(2)
    net.sockets[1]!.push({ op: 10, d: { heartbeat_interval: 45_000 } })
    await until(() => net.sockets[1]!.ops(6).length === 1)
    expect(net.sockets[1]!.ops(6)[0]).toEqual({
      op: 6,
      d: { token: 'QQBot ACC', session_id: 'qs', seq: 3 },
    })
  })

  test('wrong credentials fail at the token exchange', async () => {
    const net = new FakeNet().on('getAppAccessToken', {
      body: { code: 100016, message: 'invalid appid or secret' },
    })
    const { adapter } = await started(
      new QqAdapter({ appId: '1', appSecret: 'x' }, net.io()),
    )
    await until(() => adapter.health().state === 'failed')
    expect(adapter.health().detail).toBe('QQ 拒绝了 AppID 或 AppSecret')
  })
})

describe('WeChat (iLink)', () => {
  test('login: a QR code, then the status until confirmed, on the official domain only', async () => {
    const statuses = [
      { status: 'wait' },
      {
        status: 'scaned_but_redirect',
        redirect_host: 'sh.ilinkai.weixin.qq.com',
      },
      {
        status: 'confirmed',
        ilink_bot_id: 'bot@im.bot',
        bot_token: 'BT',
        baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_user_id: 'wx-owner',
      },
    ]
    const net = new FakeNet()
      .on('get_bot_qrcode', {
        body: {
          qrcode: 'Q1',
          qrcode_img_content: 'https://liteapp.weixin.qq.com/q/Q1',
        },
      })
      .on('get_qrcode_status', () => ({ body: statuses.shift() }))
    const io = net.io()
    expect(await weixinQrStart(io)).toEqual({
      qrcode: 'Q1',
      content: 'https://liteapp.weixin.qq.com/q/Q1',
    })
    expect(net.exchanges[0]!.url).toBe(
      `${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
    )
    expect(net.exchanges[0]!.headers['ilink-app-id']).toBe('bot')
    expect(await weixinQrPoll(io, 'Q1')).toEqual({ state: 'wait' })
    const scanned = await weixinQrPoll(io, 'Q1')
    expect(scanned).toEqual({
      state: 'scanned',
      baseUrl: 'https://sh.ilinkai.weixin.qq.com',
    })
    expect(await weixinQrPoll(io, 'Q1', scanned.baseUrl)).toEqual({
      state: 'confirmed',
      accountId: 'bot@im.bot',
      token: 'BT',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      userId: 'wx-owner',
    })
    expect(
      net.exchanges.at(-1)!.url.startsWith('https://sh.ilinkai.weixin.qq.com/'),
    ).toBe(true)
    expect(() => ilinkBaseUrl('https://evil.example/weixin.qq.com')).toThrow(
      '微信返回的服务地址不在官方域名下',
    )
    expect(() => ilinkBaseUrl('http://ilinkai.weixin.qq.com')).toThrow()
  })

  test('long polls, remembers each peer’s context token, and echoes it in replies', async () => {
    let polls = 0
    const states: { cursor: string; contextTokens: Record<string, string> }[] =
      []
    const net = new FakeNet()
      .on('/getupdates', () =>
        polls++ === 0
          ? {
              body: {
                ret: 0,
                get_updates_buf: 'CUR2',
                msgs: [
                  {
                    message_id: 1,
                    from_user_id: 'wx-a',
                    context_token: 'CTX-A',
                    item_list: [{ type: 1, text_item: { text: '你好' } }],
                  },
                  {
                    message_id: 2,
                    from_user_id: 'bot@im.bot',
                    item_list: [{ type: 1, text_item: { text: 'echo' } }],
                  },
                  {
                    message_id: 3,
                    from_user_id: 'wx-b',
                    message_type: 1,
                    item_list: [{ type: 2 }],
                  },
                ],
              },
            }
          : undefined,
      )
      .on('/sendmessage', { body: { ret: 0 } })
    const { adapter, got } = await started(
      new WeixinAdapter(
        {
          accountId: 'bot@im.bot',
          token: 'BT',
          baseUrl: ILINK_BASE_URL,
          cursor: 'CUR1',
          onState: state => states.push(state),
        },
        net.io(),
      ),
    )
    await until(() => net.to('/getupdates').length === 2)
    expect(
      net
        .to('/getupdates')
        .map(one => (one.body as { get_updates_buf: string }).get_updates_buf),
    ).toEqual(['CUR1', 'CUR2'])
    expect(net.to('/getupdates')[0]!.headers).toMatchObject({
      authorizationtype: 'ilink_bot_token',
      authorization: 'Bearer BT',
    })
    expect(adapter.health().state).toBe('connected')
    expect(states).toEqual([
      { cursor: 'CUR2', contextTokens: { 'wx-a': 'CTX-A' } },
    ])
    expect(
      got.map(one => [one.chat.id, one.text, one.attachments?.[0]?.kind]),
    ).toEqual([
      ['wx-a', '你好', undefined],
      ['wx-b', '', 'image'],
    ])
    // Markdown stays: WeChat renders it (hermes `format_message`).
    expect(adapter.chunks('**收到**\n\n\n\n好')).toEqual(['**收到**\n\n好'])
    expect(await adapter.send({ type: 'dm', id: 'wx-a' }, '**收到**')).toEqual({
      ok: true,
    })
    const msg = (
      net.to('/sendmessage')[0]!.body as { msg: Record<string, unknown> }
    ).msg
    expect(msg).toMatchObject({
      to_user_id: 'wx-a',
      message_type: 2,
      context_token: 'CTX-A',
      item_list: [{ type: 1, text_item: { text: '**收到**' } }],
    })
  })

  test('an expired session stops the channel and asks for a new scan', async () => {
    const net = new FakeNet().on('/getupdates', { body: { errcode: -14 } })
    const { adapter } = await started(
      new WeixinAdapter(
        { accountId: 'b', token: 'BT', baseUrl: ILINK_BASE_URL },
        net.io(),
      ),
    )
    await until(() => adapter.health().state === 'failed')
    expect(adapter.health().detail).toBe('微信登录已失效，请在控制台重新扫码')
  })
})

describe('failure classes (hermes)', () => {
  test('Telegram: a throttle carries its wait, an unreachable API is retryable, a timeout is not', async () => {
    let mode = 'throttle'
    const net = new FakeNet().on('/sendMessage', () => {
      if (mode === 'throttle')
        return {
          status: 429,
          body: { ok: false, parameters: { retry_after: 3 } },
        }
      return { body: { ok: true, result: { message_id: 1 } } }
    })
    const adapter = new TelegramAdapter({ token: 'T' }, net.io())
    expect(await adapter.send({ type: 'dm', id: '1' }, 'x')).toMatchObject({
      ok: false,
      retryAfterMs: 3_000,
    })
    const down = new FakeNet()
    const io = down.io()
    const refused = new TelegramAdapter(
      { token: 'T' },
      {
        ...io,
        fetch: (async () => {
          throw new TypeError('connect ECONNREFUSED')
        }) as unknown as typeof fetch,
      },
    )
    expect(await refused.send({ type: 'dm', id: '1' }, 'x')).toMatchObject({
      ok: false,
      retryable: true,
    })
    mode = 'ok'
    expect(adapter.inboundSplitAt).toBe(4_000)
    expect(adapter.sendGapMs).toBe(1_000)
  })

  test('Telegram: another poller is waited out a few times before the channel stops', async () => {
    const net = new FakeNet()
      .on('/getMe', { body: { ok: true, result: { id: 42, username: 'b' } } })
      .on('/getUpdates', { status: 409, body: { ok: false } })
    const { adapter } = await started(
      new TelegramAdapter({ token: 'T' }, net.io()),
    )
    await until(() => net.to('/getUpdates').length >= 2)
    expect(adapter.health().state).not.toBe('failed')
    await until(() => adapter.health().state === 'failed')
    expect(net.to('/getUpdates')).toHaveLength(5)
    expect(adapter.health().detail).toContain('另有程序')
  })

  test('Slack: 429 and ratelimited carry Retry-After, 5xx is retryable, other errors are final', async () => {
    const answers = [
      {
        status: 429,
        headers: { 'retry-after': '7' },
        body: { ok: false, error: 'ratelimited' },
      },
      { status: 200, body: { ok: false, error: 'ratelimited' } },
      { status: 503, body: {} },
      { status: 200, body: { ok: false, error: 'channel_not_found' } },
    ]
    const net = new FakeNet().on('/chat.postMessage', () => answers.shift())
    const adapter = new SlackAdapter(
      { appToken: 'xapp', botToken: 'xoxb' },
      net.io(),
    )
    const chat = { type: 'group' as const, id: 'C1', threadId: '1.1' }
    expect(await adapter.send(chat, 'a')).toMatchObject({
      ok: false,
      retryAfterMs: 7_000,
    })
    expect(await adapter.send(chat, 'a')).toMatchObject({
      ok: false,
      retryAfterMs: 1_000,
    })
    expect(await adapter.send(chat, 'a')).toMatchObject({
      ok: false,
      retryable: true,
    })
    const final = await adapter.send(chat, 'a')
    expect(final).toEqual({
      ok: false,
      error: 'Slack 发送失败（channel_not_found）',
    })
    expect(adapter.followsThreads).toBe(true)
    expect(adapter.dedupTtlMs).toBe(3_600_000)
  })

  test('Slack: posts by bots and apps are not people', async () => {
    const net = new FakeNet()
      .on('/auth.test', { body: { ok: true, user_id: 'UBOT' } })
      .on('/apps.connections.open', {
        body: { ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=1' },
      })
      .on('/users.info', {
        body: { ok: true, user: { profile: { display_name: '人' } } },
      })
    const { got } = await started(
      new SlackAdapter({ appToken: 'xapp', botToken: 'xoxb' }, net.io()),
    )
    await until(() => net.sockets.length === 1)
    const socket = net.sockets[0]!
    socket.push({ type: 'hello' })
    const base = {
      type: 'message',
      channel: 'D1',
      channel_type: 'im',
      user: 'U1',
      text: 'hi',
    }
    const events = [
      { ...base, ts: '1', bot_profile: { name: 'x' } },
      { ...base, ts: '2', app_id: 'A1' },
      { ...base, ts: '3', app_id: 'A1', client_msg_id: 'c' },
      { ...base, ts: '4' },
    ]
    for (const [i, event] of events.entries())
      socket.push({
        type: 'events_api',
        envelope_id: `e${i}`,
        payload: { event },
      })
    await until(() => got.length === 2)
    expect(got.map(one => one.messageId)).toEqual(['3', '4'])
  })

  test('QQ: protocol close codes stop the channel; quick closes back off and keep reconnecting', async () => {
    const world = () =>
      new FakeNet()
        .on('getAppAccessToken', {
          body: { access_token: 'ACC', expires_in: 7200 },
        })
        .on('/gateway', { body: { url: 'wss://api.sgroup.qq.com/websocket' } })
    const net = world()
    const { adapter } = await started(
      new QqAdapter({ appId: '1', appSecret: 's' }, net.io()),
    )
    await until(() => net.sockets.length === 1)
    net.sockets[0]!.close(4014, 'disallowed intents')
    await until(() => adapter.health().state === 'failed')
    expect(adapter.health().detail).toBe('机器人没有开通单聊或群聊消息的权限')

    const quick = world()
    const second = await started(
      new QqAdapter({ appId: '1', appSecret: 's' }, quick.io()),
    )
    for (let i = 0; i < 3; i++) {
      await until(() => quick.sockets.length === i + 1)
      await until(() => quick.sockets[i]!.readyState === 1)
      quick.sockets[i]!.close(4900, 'internal')
    }
    // Not a dead end (hermes keeps it in the reconnect queue): a long pause, then again.
    await until(() => quick.sleeps.includes(300_000))
    expect(second.adapter.health().state).toBe('retrying')
    expect(second.adapter.health().detail).toContain('5 分钟后重连')
    await until(() => quick.sockets.length === 4)
  })

  test('WeChat: a stale context token is dropped and the words resent; too frequent waits 30 s', async () => {
    const sends: Record<string, unknown>[] = []
    let answers = [{ errcode: -14 }, { ret: 0 }]
    const net = new FakeNet().on('/sendmessage', exchange => {
      sends.push((exchange.body as { msg: Record<string, unknown> }).msg)
      return { body: answers.shift() ?? { ret: 0 } }
    })
    const states: unknown[] = []
    const adapter = new WeixinAdapter(
      {
        accountId: 'b',
        token: 'BT',
        baseUrl: ILINK_BASE_URL,
        contextTokens: { 'wx-a': 'OLD' },
        onState: state => states.push(state),
      },
      net.io(),
    )
    expect(await adapter.send({ type: 'dm', id: 'wx-a' }, '在')).toEqual({
      ok: true,
    })
    expect(sends.map(one => one.context_token)).toEqual(['OLD', undefined])
    expect(states).toEqual([{ cursor: '', contextTokens: {} }])
    answers = [{ errcode: -2 }]
    expect(await adapter.send({ type: 'dm', id: 'wx-a' }, '在')).toEqual({
      ok: false,
      error: '微信限流',
      retryAfterMs: 30_000,
    })
    // The circuit is open: the next send waits without asking iLink.
    const held = await adapter.send({ type: 'dm', id: 'wx-a' }, '在')
    expect(held).toMatchObject({ ok: false, error: '微信限流' })
    expect(held.retryAfterMs).toBeGreaterThan(0)
    expect(held.retryAfterMs).toBeLessThanOrEqual(30_000)
    expect(sends).toHaveLength(3)
    // Without a context token, an expired session is the login itself.
    const fresh = new WeixinAdapter(
      { accountId: 'b', token: 'BT', baseUrl: ILINK_BASE_URL },
      net.io(),
    )
    answers = [{ errcode: -14 }]
    const result = await fresh.send({ type: 'dm', id: 'wx-a' }, '在')
    expect(result).toMatchObject({ ok: false })
    expect(fresh.health().state).toBe('failed')
    expect(adapter.sendGapMs).toBe(1_500)
  })
})
