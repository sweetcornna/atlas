// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Slack through Socket Mode (`apps.connections.open`, app-level `xapp-`
 * token) and the Web API (`chat.postMessage`, bot `xoxb-` token). Channel
 * conversations live in threads, the Slack way: a top-level message starts a
 * thread and the reply goes into it. The "thinking" status uses
 * `assistant.threads.setStatus` where the app has that scope.
 */

import {
  ChannelFatalError,
  ChannelLoop,
  Debounce,
  list,
  officialUrl,
  record,
  requestJson,
  runSocket,
  sendFrame,
  text,
} from './net.js'
import { slackMrkdwn } from './text.js'
import type {
  ChannelAdapter,
  ChannelChat,
  ChannelHealth,
  ChannelInbound,
  ChannelIo,
  ChannelSendResult,
} from './types.js'

export interface SlackSettings {
  /** App-level token (`xapp-…`) with `connections:write`. */
  readonly appToken: string
  /** Bot token (`xoxb-…`). */
  readonly botToken: string
}

const API = 'https://slack.com/api'
const FATAL = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'missing_scope',
])

export class SlackAdapter implements ChannelAdapter {
  readonly platform = 'slack' as const
  readonly chunkLimit = 3_500
  readonly #io: ChannelIo
  readonly #settings: SlackSettings
  readonly #loop: ChannelLoop
  readonly #status: Debounce
  readonly #names = new Map<string, Promise<string>>()
  #botUser = ''
  #statusScope = true

  constructor(settings: SlackSettings, io: ChannelIo) {
    this.#settings = settings
    this.#io = io
    this.#loop = new ChannelLoop(io)
    this.#status = new Debounce(20_000, io.now)
  }

  health(): ChannelHealth {
    return this.#loop.health()
  }

  async #api(
    method: string,
    token: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const reply = await requestJson(this.#io, `${API}/${method}`, {
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body,
      ...(signal === undefined ? {} : { signal }),
    })
    return reply.body
  }

  async start(sink: (message: ChannelInbound) => void): Promise<void> {
    this.#loop.start(async signal => {
      const auth = await this.#api(
        'auth.test',
        this.#settings.botToken,
        {},
        signal,
      )
      if (auth.ok !== true) {
        if (FATAL.has(text(auth.error)))
          throw new ChannelFatalError('Slack 拒绝了 bot 令牌')
        throw new Error('Slack auth.test 失败')
      }
      this.#botUser = text(auth.user_id)
      const opened = await this.#api(
        'apps.connections.open',
        this.#settings.appToken,
        {},
        signal,
      )
      if (opened.ok !== true) {
        if (FATAL.has(text(opened.error)))
          throw new ChannelFatalError(
            'Slack 拒绝了 app 令牌（需要 connections:write）',
          )
        throw new Error('Slack Socket Mode 连接失败')
      }
      const url = officialUrl(opened.url, ['wss:'], ['slack.com'])
      await runSocket(this.#io, url.toString(), signal, {
        onMessage: (frame, socket) => {
          if (frame.type === 'hello') {
            this.#loop.mark('connected')
            return
          }
          if (frame.type === 'disconnect') {
            socket.close(1000, 'refresh')
            return
          }
          if (typeof frame.envelope_id === 'string')
            sendFrame(socket, { envelope_id: frame.envelope_id })
          if (frame.type === 'events_api') {
            const event = record(record(frame.payload).event)
            void this.#inbound(event).then(inbound => {
              if (inbound !== null) sink(inbound)
            })
          }
        },
      })
    })
  }

  /** One `users.info` per user, shared by events that arrive together. */
  #userName(user: string): Promise<string> {
    const known = this.#names.get(user)
    if (known !== undefined) return known
    const lookup = this.#api('users.info', this.#settings.botToken, {
      user,
    }).then(
      info => {
        const profile = record(record(info.user).profile)
        return text(profile.display_name) || text(profile.real_name) || user
      },
      () => user,
    )
    if (this.#names.size > 1_000) this.#names.clear()
    this.#names.set(user, lookup)
    return lookup
  }

  async #inbound(
    event: Record<string, unknown>,
  ): Promise<ChannelInbound | null> {
    const type = text(event.type)
    if (type !== 'message' && type !== 'app_mention') return null
    const subtype = text(event.subtype)
    if (
      subtype !== '' &&
      subtype !== 'file_share' &&
      subtype !== 'thread_broadcast'
    )
      return null
    const user = text(event.user)
    if (user === '' || event.bot_id !== undefined || user === this.#botUser)
      return null
    const channelType = text(event.channel_type)
    const dm = channelType === 'im'
    let body = text(event.text)
    const mention = `<@${this.#botUser}>`
    const addressed =
      dm ||
      type === 'app_mention' ||
      (this.#botUser !== '' && body.includes(mention))
    if (this.#botUser !== '') body = body.split(mention).join('').trim()
    const attachments = list(event.files).map(item => {
      const file = record(item)
      return {
        name: text(file.name) || '附件',
        kind: text(file.mimetype).startsWith('image/') ? 'image' : 'file',
      }
    })
    if (body === '' && attachments.length === 0) return null
    const ts = text(event.ts)
    const thread = text(event.thread_ts) || (dm ? '' : ts)
    return {
      chat: {
        type: dm ? 'dm' : 'group',
        id: text(event.channel),
        ...(thread ? { threadId: thread } : {}),
      },
      messageId: ts,
      userId: user,
      userName: await this.#userName(user),
      text: body,
      addressed,
      ...(attachments.length === 0 ? {} : { attachments }),
    }
  }

  async send(chat: ChannelChat, markdown: string): Promise<ChannelSendResult> {
    try {
      const reply = await this.#api(
        'chat.postMessage',
        this.#settings.botToken,
        {
          channel: chat.id,
          text: slackMrkdwn(markdown),
          ...(chat.threadId ? { thread_ts: chat.threadId } : {}),
          unfurl_links: false,
        },
      )
      if (reply.ok !== true)
        return {
          ok: false,
          error: `Slack 发送失败（${text(reply.error) || '未知'}）`,
        }
      this.#status.clear(chat.id)
      return { ok: true, messageId: text(reply.ts) }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Slack 发送失败',
      }
    }
  }

  async typing(chat: ChannelChat): Promise<void> {
    if (!this.#statusScope || !chat.threadId || !this.#status.due(chat.id))
      return
    const reply = await this.#api(
      'assistant.threads.setStatus',
      this.#settings.botToken,
      {
        channel_id: chat.id,
        thread_ts: chat.threadId,
        status: 'is thinking...',
      },
    ).catch(() => ({}) as Record<string, unknown>)
    // Without the assistant scope Slack has no typing for bots; stop asking.
    if (
      text(reply.error) === 'missing_scope' ||
      text(reply.error) === 'not_allowed_token_type'
    )
      this.#statusScope = false
  }

  async stop(): Promise<void> {
    await this.#loop.stop()
  }
}
