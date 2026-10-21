// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
// 规则来源 NousResearch/hermes-agent `plugins/platforms/telegram/adapter.py:528`、`:547-552`、`:625-636`、`:1091-1102`、`:5781-5796`、`:5863-5890`、`:5952-6067`、`:6085-6119`、`:6379-6413`、`:6578-6589`，取于 `63220ae5`，取用日期 2026-10-19

/**
 * Telegram through the official Bot API: `getUpdates` long polling,
 * `sendMessage` with MarkdownV2 (plain text when Telegram rejects the
 * entities), native replies and forum topics, `sendChatAction` typing.
 * Who is addressed, which topic a message is in and when a group message
 * is for the bot follow hermes (`rules/telegram.ts`).
 */

import {
  ChannelFatalError,
  ChannelLoop,
  ChannelRateLimited,
  Debounce,
  list,
  record,
  requestJson,
  sendFailure,
  text,
} from './net.js'
import {
  cleanTriggerText,
  isReplyToBot,
  mentionsBot,
  mentionsOnlyOtherBots,
  TELEGRAM_TEXT_BATCH,
  telegramGroupGate,
  telegramSendThreadId,
  telegramThreadId,
  telegramTypingThreadId,
} from './rules/telegram.js'
import { plainText, telegramMarkdownV2 } from './text.js'
import type {
  ChannelAdapter,
  ChannelChat,
  ChannelHealth,
  ChannelInbound,
  ChannelIo,
  ChannelSendOptions,
  ChannelSendResult,
} from './types.js'

export interface TelegramSettings {
  readonly token: string
  /** Where polling resumes after a restart. */
  readonly offset?: number
  readonly onOffset?: (offset: number) => void
}

const API = 'https://api.telegram.org'
/** Conflicting pollers tolerated in a row before the channel stops. */
const CONFLICT_LIMIT = 5

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = 'telegram' as const
  readonly chunkLimit = 3_500
  /** The client splits a long paste near 4096 characters (hermes `_SPLIT_THRESHOLD`). */
  readonly inboundSplitAt = 4_000
  /** One message per chat per second (hermes per-chat budget). */
  readonly sendGapMs = 1_000
  readonly textBatch = TELEGRAM_TEXT_BATCH
  readonly groupGate = telegramGroupGate
  readonly #io: ChannelIo
  readonly #settings: TelegramSettings
  readonly #loop: ChannelLoop
  readonly #typing: Debounce
  #offset: number
  #botId = ''
  #username = ''
  /** 409s in a row from getUpdates. */
  #conflicts = 0

  constructor(settings: TelegramSettings, io: ChannelIo) {
    this.#settings = settings
    this.#io = io
    this.#loop = new ChannelLoop(io)
    this.#typing = new Debounce(4_000, io.now)
    this.#offset = settings.offset ?? 0
  }

  health(): ChannelHealth {
    return this.#loop.health()
  }

  async #call(
    method: string,
    body: Record<string, unknown>,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ) {
    const reply = await requestJson(
      this.#io,
      `${API}/bot${this.#settings.token}/${method}`,
      {
        body,
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      },
    )
    if (reply.status === 401 || reply.status === 404)
      throw new ChannelFatalError('Telegram 拒绝了机器人令牌')
    if (reply.status === 429) {
      const after = Number(record(reply.body.parameters).retry_after)
      throw new ChannelRateLimited((Number.isFinite(after) ? after : 5) * 1_000)
    }
    return reply
  }

  async start(sink: (message: ChannelInbound) => void): Promise<void> {
    this.#loop.start(async signal => {
      const me = await this.#call('getMe', {}, 15_000, signal)
      if (me.body.ok !== true) throw new Error('Telegram getMe 失败')
      const bot = record(me.body.result)
      this.#botId = text(bot.id)
      this.#username = text(bot.username)
      this.#loop.mark('connected')
      while (!signal.aborted) {
        const reply = await this.#call(
          'getUpdates',
          { offset: this.#offset, timeout: 30, allowed_updates: ['message'] },
          45_000,
          signal,
        )
        if (reply.status === 409) {
          // A poller from a restart usually goes away within seconds
          // (hermes keeps polling through conflicts); a webhook does not.
          if (++this.#conflicts >= CONFLICT_LIMIT)
            throw new ChannelFatalError(
              '这个机器人另有程序在接收消息（webhook 或另一个轮询）',
            )
          throw new Error('这个机器人另有程序在接收消息，稍后重试')
        }
        if (reply.body.ok !== true) throw new Error('Telegram getUpdates 失败')
        this.#conflicts = 0
        this.#loop.mark('connected')
        for (const update of list(reply.body.result)) {
          const row = record(update)
          const id = Number(row.update_id)
          if (Number.isSafeInteger(id) && id >= this.#offset)
            this.#offset = id + 1
          const inbound = this.#inbound(record(row.message))
          if (inbound !== null) sink(inbound)
        }
        this.#settings.onOffset?.(this.#offset)
      }
    })
  }

  #inbound(message: Record<string, unknown>): ChannelInbound | null {
    const chat = record(message.chat)
    const from = record(message.from)
    const kind = text(chat.type)
    if (
      from.is_bot === true ||
      (kind !== 'private' && kind !== 'group' && kind !== 'supergroup')
    )
      return null
    const group = kind !== 'private'
    const reply = record(message.reply_to_message)
    const replyFrom = record(reply.from)
    const addressed =
      !group ||
      mentionsBot(message, { id: this.#botId, username: this.#username }) ||
      isReplyToBot(message, this.#botId)
    const otherBots = group && mentionsOnlyOtherBots(message, this.#username)
    const body = cleanTriggerText(
      text(message.text) || text(message.caption),
      this.#username,
    ).trim()
    const attachments: { name: string; kind: string }[] = []
    if (list(message.photo).length > 0)
      attachments.push({ name: '图片', kind: 'image' })
    for (const field of ['document', 'audio', 'video', 'voice'] as const) {
      const file = record(message[field])
      if (Object.keys(file).length > 0)
        attachments.push({ name: text(file.file_name) || field, kind: field })
    }
    if (body === '' && attachments.length === 0) return null
    const quoteText =
      text(record(message.quote).text) ||
      text(reply.text) ||
      text(reply.caption)
    const name = [text(from.first_name), text(from.last_name)]
      .filter(Boolean)
      .join(' ')
    const thread = telegramThreadId(message)
    const chatRef: ChannelChat = {
      type: kind === 'private' ? 'dm' : 'group',
      id: text(chat.id),
      ...(thread ? { threadId: thread } : {}),
    }
    return {
      chat: chatRef,
      ...(text(chat.title) ? { chatName: text(chat.title) } : {}),
      messageId: text(message.message_id),
      userId: text(from.id),
      userName: name || text(from.username) || text(from.id),
      text: body,
      addressed,
      ...(otherBots ? { mention: { otherBots } } : {}),
      ...(quoteText
        ? {
            quote: {
              messageId: text(reply.message_id),
              text: quoteText,
              authorId: text(replyFrom.id),
              authorName:
                text(replyFrom.first_name) || text(replyFrom.username),
              own: this.#botId !== '' && text(replyFrom.id) === this.#botId,
            },
          }
        : {}),
      ...(attachments.length === 0 ? {} : { attachments }),
    }
  }

  async send(
    chat: ChannelChat,
    markdown: string,
    options: ChannelSendOptions = {},
  ): Promise<ChannelSendResult> {
    const topic = telegramSendThreadId(chat.threadId)
    const base: Record<string, unknown> = {
      chat_id: chat.id,
      ...(topic === undefined ? {} : { message_thread_id: topic }),
      ...(options.replyTo
        ? {
            reply_parameters: {
              message_id: Number(options.replyTo),
              allow_sending_without_reply: true,
            },
          }
        : {}),
    }
    try {
      let reply = await this.#call('sendMessage', {
        ...base,
        text: telegramMarkdownV2(markdown),
        parse_mode: 'MarkdownV2',
      })
      if (reply.status === 400)
        // Entities Telegram cannot parse: the same words, unformatted.
        reply = await this.#call('sendMessage', {
          ...base,
          text: plainText(markdown),
        })
      if (reply.body.ok !== true)
        return { ok: false, error: `Telegram 发送失败（${reply.status}）` }
      this.#typing.clear(chat.id)
      return { ok: true, messageId: text(record(reply.body.result).message_id) }
    } catch (error) {
      return sendFailure(error, 'Telegram 发送失败')
    }
  }

  async typing(chat: ChannelChat): Promise<void> {
    if (!this.#typing.due(`${chat.id}:${chat.threadId ?? ''}`)) return
    const topic = telegramTypingThreadId(chat.threadId)
    await this.#call('sendChatAction', {
      chat_id: chat.id,
      action: 'typing',
      ...(topic === undefined ? {} : { message_thread_id: topic }),
    }).catch(() => {})
  }

  async stop(): Promise<void> {
    await this.#loop.stop()
  }
}
