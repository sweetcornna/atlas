// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * QQ through the QQ Open Platform bot API (v2): AppID + AppSecret exchanged
 * for an access token, the official WebSocket gateway (identify / resume,
 * heartbeats), private (`C2C_MESSAGE_CREATE`) and group @-messages
 * (`GROUP_AT_MESSAGE_CREATE`), passive replies that carry the triggering
 * message id with an increasing `msg_seq`, and the private-chat "typing"
 * notice (`msg_type` 6).
 *
 * Group messages only reach a bot when it is @-mentioned; that is the
 * platform's rule, so every group message here is addressed.
 */

import {
  ChannelFatalError,
  ChannelLoop,
  ChannelRateLimited,
  Debounce,
  list,
  officialUrl,
  record,
  requestJson,
  runSocket,
  sendFailure,
  sendFrame,
  text,
} from './net.js'
import { plainText } from './text.js'
import type {
  ChannelAdapter,
  ChannelChat,
  ChannelHealth,
  ChannelInbound,
  ChannelIo,
  ChannelSendOptions,
  ChannelSendResult,
} from './types.js'

export interface QqSettings {
  readonly appId: string
  readonly appSecret: string
}

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const API = 'https://api.sgroup.qq.com'
/** Group and C2C (private) message events. */
const INTENTS = 1 << 25
/**
 * Close codes after which reconnecting cannot help (hermes `qqbot`). 4004
 * (token rejected) is not one: the access token may simply have expired; a
 * fresh one is fetched, and wrong credentials fail at the token exchange.
 */
const FATAL_CLOSE = new Map<number, string>([
  [4001, 'QQ 网关拒绝了无效的操作码'],
  [4002, 'QQ 网关拒绝了无效的数据'],
  [4010, 'QQ 网关分片无效'],
  [4011, '机器人需要分片连接'],
  [4012, 'QQ 网关版本无效'],
  [4013, '机器人订阅的事件无效'],
  [4014, '机器人没有开通单聊或群聊消息的权限'],
  [4914, '机器人已下架'],
  [4915, '机器人已封禁'],
])

/** The session cannot be resumed: identify afresh. */
function sessionGone(code: number): boolean {
  return (
    code === 4006 ||
    code === 4007 ||
    code === 9001 ||
    code === 9005 ||
    (code >= 4900 && code <= 4913)
  )
}

/**
 * Three closes this soon after opening, in a row: something QQ will not
 * accept right now. hermes keeps such a bot in its reconnect queue, so the
 * channel pauses five minutes and tries again instead of giving up.
 */
const QUICK_CLOSE_MS = 5_000
const QUICK_CLOSES = 3
const QUICK_PAUSE_MS = 5 * 60_000

export class QqAdapter implements ChannelAdapter {
  readonly platform = 'qq' as const
  readonly chunkLimit = 3_000
  readonly #io: ChannelIo
  readonly #settings: QqSettings
  readonly #loop: ChannelLoop
  readonly #typing: Debounce
  /** The message each chat last sent us: QQ replies are passive, bound to it. */
  readonly #lastInbound = new Map<string, string>()
  readonly #sequence = new Map<string, number>()
  #token: { value: string; expiresAt: number } | null = null
  #session: { id: string; seq: number | null } | null = null
  #quickCloses = 0

  constructor(settings: QqSettings, io: ChannelIo) {
    this.#settings = settings
    this.#io = io
    this.#loop = new ChannelLoop(io)
    this.#typing = new Debounce(50_000, io.now)
  }

  health(): ChannelHealth {
    return this.#loop.health()
  }

  async #accessToken(signal?: AbortSignal): Promise<string> {
    if (this.#token !== null && this.#io.now() < this.#token.expiresAt - 60_000)
      return this.#token.value
    const reply = await requestJson(this.#io, TOKEN_URL, {
      body: {
        appId: this.#settings.appId,
        clientSecret: this.#settings.appSecret,
      },
      ...(signal === undefined ? {} : { signal }),
    })
    const value = text(reply.body.access_token)
    if (value === '') {
      if (reply.status === 200 || reply.status === 400 || reply.status === 401)
        throw new ChannelFatalError('QQ 拒绝了 AppID 或 AppSecret')
      throw new Error(`QQ 访问令牌获取失败（${reply.status}）`)
    }
    const seconds = Number(reply.body.expires_in)
    this.#token = {
      value,
      expiresAt:
        this.#io.now() + (Number.isFinite(seconds) ? seconds : 7_200) * 1_000,
    }
    return value
  }

  async #api(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const token = await this.#accessToken(signal)
    return requestJson(this.#io, `${API}${path}`, {
      method,
      headers: {
        authorization: `QQBot ${token}`,
        'x-union-appid': this.#settings.appId,
      },
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
    })
  }

  async start(sink: (message: ChannelInbound) => void): Promise<void> {
    this.#loop.start(async signal => {
      const gateway = await this.#api('GET', '/gateway', undefined, signal)
      if (gateway.status === 401)
        throw new ChannelFatalError('QQ 拒绝了机器人凭据')
      if (gateway.status !== 200)
        throw new Error(`QQ 网关地址获取失败（${gateway.status}）`)
      const url = officialUrl(gateway.body.url, ['wss:'], ['qq.com'])
      let heartbeat: ReturnType<typeof setInterval> | undefined
      let openedAt = 0
      const closed = await runSocket(this.#io, url.toString(), signal, {
        onOpen: () => {
          openedAt = this.#io.now()
        },
        onMessage: (frame, socket) => {
          if (typeof frame.s === 'number' && frame.s > 0 && this.#session)
            this.#session.seq = frame.s
          switch (frame.op) {
            case 10: {
              const interval =
                Number(record(frame.d).heartbeat_interval) || 45_000
              clearInterval(heartbeat)
              heartbeat = setInterval(
                () =>
                  sendFrame(socket, { op: 1, d: this.#session?.seq ?? null }),
                Math.floor(interval * 0.8),
              )
              void this.#accessToken(signal).then(
                token =>
                  sendFrame(
                    socket,
                    this.#session !== null && this.#session.seq !== null
                      ? {
                          op: 6,
                          d: {
                            token: `QQBot ${token}`,
                            session_id: this.#session.id,
                            seq: this.#session.seq,
                          },
                        }
                      : {
                          op: 2,
                          d: {
                            token: `QQBot ${token}`,
                            intents: INTENTS,
                            shard: [0, 1],
                          },
                        },
                  ),
                () => socket.close(4000, 'token'),
              )
              return
            }
            case 7:
              socket.close(4000, 'reconnect requested')
              return
            case 9:
              this.#session = null
              socket.close(4000, 'invalid session')
              return
            case 0:
              this.#dispatch(
                text(frame.t),
                record(frame.d),
                typeof frame.s === 'number' ? frame.s : null,
                sink,
              )
          }
        },
      })
      clearInterval(heartbeat)
      if (signal.aborted) return
      const fatal = FATAL_CLOSE.get(closed.code)
      if (fatal !== undefined) throw new ChannelFatalError(fatal)
      if (sessionGone(closed.code)) this.#session = null
      if (closed.code === 4004) this.#token = null
      if (closed.opened && this.#io.now() - openedAt < QUICK_CLOSE_MS) {
        if (++this.#quickCloses >= QUICK_CLOSES) {
          this.#quickCloses = 0
          throw new ChannelRateLimited(
            QUICK_PAUSE_MS,
            'QQ 网关连上就断开，已连续三次，5 分钟后重连（检查机器人的消息权限）',
          )
        }
      } else this.#quickCloses = 0
      // 4008: sending too fast; QQ asks for a pause.
      if (closed.code === 4008)
        throw new ChannelRateLimited(60_000, 'QQ 网关要求放慢，60 秒后重连')
    })
  }

  #dispatch(
    type: string,
    data: Record<string, unknown>,
    seq: number | null,
    sink: (message: ChannelInbound) => void,
  ): void {
    if (type === 'READY') {
      this.#session = { id: text(data.session_id), seq }
      this.#loop.mark('connected')
      return
    }
    if (type === 'RESUMED') {
      this.#loop.mark('connected')
      return
    }
    const author = record(data.author)
    let chat: ChannelChat
    let user: string
    if (type === 'C2C_MESSAGE_CREATE') {
      user = text(author.user_openid)
      chat = { type: 'dm', id: user }
    } else if (type === 'GROUP_AT_MESSAGE_CREATE') {
      user = text(author.member_openid)
      chat = { type: 'group', id: text(data.group_openid) }
    } else return
    if (user === '' || chat.id === '') return
    const messageId = text(data.id)
    const body = text(data.content).trim()
    const attachments = list(data.attachments).map(item => {
      const file = record(item)
      return {
        name: text(file.filename) || '附件',
        kind: text(file.content_type).startsWith('image') ? 'image' : 'file',
      }
    })
    // message_type 103: the user quoted a message; msg_elements[0] carries it.
    const quoted =
      Number(data.message_type) === 103
        ? list(data.msg_elements)
            .map(element => text(record(element).content).trim())
            .filter(Boolean)
            .join(' ')
        : ''
    if (body === '' && attachments.length === 0) return
    this.#lastInbound.set(`${chat.type}:${chat.id}`, messageId)
    sink({
      chat,
      messageId,
      userId: user,
      userName: user,
      text: body,
      addressed: true,
      ...(quoted ? { quote: { text: quoted, own: false } } : {}),
      ...(attachments.length === 0 ? {} : { attachments }),
    })
  }

  #nextSeq(messageId: string): number {
    const next = (this.#sequence.get(messageId) ?? 0) + 1
    if (this.#sequence.size > 500) this.#sequence.clear()
    this.#sequence.set(messageId, next)
    return next
  }

  #path(chat: ChannelChat): string {
    return chat.type === 'dm'
      ? `/v2/users/${encodeURIComponent(chat.id)}/messages`
      : `/v2/groups/${encodeURIComponent(chat.id)}/messages`
  }

  async send(
    chat: ChannelChat,
    markdown: string,
    options: ChannelSendOptions = {},
  ): Promise<ChannelSendResult> {
    const replyTo =
      options.replyTo ?? this.#lastInbound.get(`${chat.type}:${chat.id}`)
    try {
      const reply = await this.#api('POST', this.#path(chat), {
        content: plainText(markdown),
        msg_type: 0,
        ...(replyTo
          ? { msg_id: replyTo, msg_seq: this.#nextSeq(replyTo) }
          : {}),
      })
      if (reply.status !== 200)
        return {
          ok: false,
          error: `QQ 发送失败（${reply.status}${text(reply.body.code) ? ` ${text(reply.body.code)}` : ''}）`,
        }
      return { ok: true, messageId: text(reply.body.id) }
    } catch (error) {
      return sendFailure(error, 'QQ 发送失败')
    }
  }

  /** Private chats only: QQ has no group typing notice. */
  async typing(chat: ChannelChat, replyTo?: string): Promise<void> {
    if (chat.type !== 'dm' || !this.#typing.due(chat.id)) return
    const messageId = replyTo ?? this.#lastInbound.get(`dm:${chat.id}`)
    if (!messageId) return
    await this.#api('POST', this.#path(chat), {
      msg_type: 6,
      input_notify: { input_type: 1, input_second: 60 },
      msg_id: messageId,
      msg_seq: this.#nextSeq(messageId),
    }).catch(() => {})
  }

  async stopTyping(chat: ChannelChat): Promise<void> {
    this.#typing.clear(chat.id)
  }

  async stop(): Promise<void> {
    await this.#loop.stop()
  }
}
