// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
// 规则来源 NousResearch/hermes-agent `plugins/platforms/discord/adapter.py:1224-1226`、`:1260-1262`、`:1671-1745`、`:2552-2558`、`:5116-5141`、`:5167-5190`、`:6086-6160`、`:6305-6309`，取于 `63220ae5`，取用日期 2026-10-19

/**
 * Discord through its official Gateway (v10) and REST API: identify / resume
 * with heartbeats, `MESSAGE_CREATE` for guild channels and DMs (the
 * `MESSAGE_CONTENT` intent must be enabled for the bot), replies with
 * `message_reference`, and the channel typing endpoint. Which messages are
 * for the bot, and threads as conversations under their parent channel,
 * follow hermes (`rules/discord.ts`).
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
  sendFailure,
  sendFrame,
  text,
} from './net.js'
import {
  DISCORD_MESSAGE_TYPES,
  DISCORD_TEXT_BATCH,
  DISCORD_THREAD_TYPES,
  discordGroupGate,
  discordMentions,
} from './rules/discord.js'
import { discordMarkdown } from './text.js'
import type {
  ChannelAdapter,
  ChannelChat,
  ChannelHealth,
  ChannelInbound,
  ChannelIo,
  ChannelSendOptions,
  ChannelSendResult,
} from './types.js'

export interface DiscordSettings {
  readonly token: string
}

const API = 'https://discord.com/api/v10'
/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT. */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)
/** Threads whose parent is remembered. */
const THREADS_KEPT = 5_000
/** Close codes after which identifying again cannot help. */
const FATAL_CLOSE = new Map<number, string>([
  [4004, 'Discord 拒绝了机器人令牌'],
  [4013, 'Discord 网关意图无效'],
  [4014, '机器人没有开启 Message Content 意图'],
])

export class DiscordAdapter implements ChannelAdapter {
  readonly platform = 'discord' as const
  readonly chunkLimit = 1_900
  /** hermes `_SPLIT_THRESHOLD` for Discord. */
  readonly inboundSplitAt = 1_900
  readonly textBatch = DISCORD_TEXT_BATCH
  readonly groupGate = discordGroupGate
  /** A thread the bot took part in needs no mention (hermes thread participation). */
  readonly followsThreads = true
  readonly #io: ChannelIo
  readonly #settings: DiscordSettings
  readonly #loop: ChannelLoop
  readonly #typing: Debounce
  #botId = ''
  #session: { id: string; resumeUrl: string; seq: number | null } | null = null
  /** Sequence numbers seen before READY names the session. */
  #pendingSeq: number | null = null
  /** Thread channel → parent channel, from `GUILD_CREATE` and the thread events. */
  readonly #threads = new Map<string, string>()

  constructor(settings: DiscordSettings, io: ChannelIo) {
    this.#settings = settings
    this.#io = io
    this.#loop = new ChannelLoop(io)
    this.#typing = new Debounce(8_000, io.now)
  }

  health(): ChannelHealth {
    return this.#loop.health()
  }

  #headers(): Record<string, string> {
    return { authorization: `Bot ${this.#settings.token}` }
  }

  async start(sink: (message: ChannelInbound) => void): Promise<void> {
    this.#loop.start(async signal => {
      let url: string
      if (this.#session !== null && this.#session.resumeUrl !== '')
        url = this.#session.resumeUrl
      else {
        const reply = await requestJson(this.#io, `${API}/gateway/bot`, {
          headers: this.#headers(),
          signal,
        })
        if (reply.status === 401)
          throw new ChannelFatalError('Discord 拒绝了机器人令牌')
        if (reply.status !== 200)
          throw new Error(`Discord 网关地址获取失败（${reply.status}）`)
        url = reply.body.url as string
      }
      const gateway = officialUrl(url, ['wss:'], ['discord.gg'])
      gateway.searchParams.set('v', '10')
      gateway.searchParams.set('encoding', 'json')
      let heartbeat: ReturnType<typeof setInterval> | undefined
      let acked = true
      const closed = await runSocket(this.#io, gateway.toString(), signal, {
        onMessage: (frame, socket) => {
          if (typeof frame.s === 'number' && this.#session)
            this.#session.seq = frame.s
          else if (typeof frame.s === 'number') this.#pendingSeq = frame.s
          switch (frame.op) {
            case 10: {
              const interval =
                Number(record(frame.d).heartbeat_interval) || 41_250
              clearInterval(heartbeat)
              heartbeat = setInterval(() => {
                if (!acked) {
                  // A zombied connection: drop it and resume.
                  socket.close(4000, 'heartbeat timeout')
                  return
                }
                acked = false
                sendFrame(socket, {
                  op: 1,
                  d: this.#session?.seq ?? this.#pendingSeq,
                })
              }, interval)
              if (this.#session !== null)
                sendFrame(socket, {
                  op: 6,
                  d: {
                    token: this.#settings.token,
                    session_id: this.#session.id,
                    seq: this.#session.seq,
                  },
                })
              else
                sendFrame(socket, {
                  op: 2,
                  d: {
                    token: this.#settings.token,
                    intents: INTENTS,
                    properties: {
                      os: process.platform,
                      browser: 'qianmo',
                      device: 'qianmo',
                    },
                  },
                })
              return
            }
            case 11:
              acked = true
              return
            case 1:
              sendFrame(socket, { op: 1, d: this.#session?.seq ?? null })
              return
            case 7:
              socket.close(4000, 'reconnect requested')
              return
            case 9:
              if (frame.d !== true) this.#session = null
              socket.close(4000, 'invalid session')
              return
            case 0:
              this.#dispatch(text(frame.t), record(frame.d), sink)
          }
        },
      })
      clearInterval(heartbeat)
      const fatal = FATAL_CLOSE.get(closed.code)
      if (fatal !== undefined) throw new ChannelFatalError(fatal)
      if (closed.code === 4007 || closed.code === 4009) this.#session = null
    })
  }

  #dispatch(
    type: string,
    data: Record<string, unknown>,
    sink: (message: ChannelInbound) => void,
  ): void {
    if (type === 'READY') {
      this.#botId = text(record(data.user).id)
      this.#session = {
        id: text(data.session_id),
        resumeUrl: text(data.resume_gateway_url),
        seq: this.#pendingSeq,
      }
      this.#loop.mark('connected')
      return
    }
    if (type === 'RESUMED') {
      this.#loop.mark('connected')
      return
    }
    if (type === 'GUILD_CREATE' || type === 'THREAD_LIST_SYNC') {
      for (const thread of list(data.threads)) this.#thread(record(thread))
      return
    }
    if (type === 'THREAD_CREATE' || type === 'THREAD_UPDATE') {
      this.#thread(data)
      return
    }
    if (type === 'THREAD_DELETE') {
      this.#threads.delete(text(data.id))
      return
    }
    if (type !== 'MESSAGE_CREATE') return
    const author = record(data.author)
    // hermes `allow_bots: none`; system messages (joins, pins, thread
    // starters) are not someone talking.
    if (author.bot === true || text(author.id) === this.#botId) return
    if (!DISCORD_MESSAGE_TYPES.has(Number(data.type ?? 0))) return
    const dm = data.guild_id === undefined || data.guild_id === null
    let body = text(data.content)
    const mentions = discordMentions(data, this.#botId)
    const referenced = record(data.referenced_message)
    const referencedAuthor = record(referenced.author)
    const addressed = dm || mentions.bot
    const otherBots = !dm && mentions.otherBots
    const othersOnly =
      !dm && mentions.anyone && !mentions.bot && !mentions.otherBots
    if (this.#botId !== '')
      body = body.replace(new RegExp(`<@!?${this.#botId}>`, 'g'), '').trim()
    const attachments = list(data.attachments).map(item => {
      const file = record(item)
      return {
        name: text(file.filename) || '附件',
        kind: text(file.content_type).startsWith('image/') ? 'image' : 'file',
      }
    })
    if (body === '' && attachments.length === 0) return
    const member = record(data.member)
    const channel = text(data.channel_id)
    const parent = dm ? undefined : this.#threads.get(channel)
    sink({
      chat: dm
        ? { type: 'dm', id: channel }
        : parent === undefined
          ? { type: 'group', id: channel }
          : { type: 'group', id: parent, threadId: channel },
      messageId: text(data.id),
      userId: text(author.id),
      userName:
        text(member.nick) || text(author.global_name) || text(author.username),
      text: body,
      addressed,
      ...(otherBots || othersOnly
        ? {
            mention: {
              ...(otherBots ? { otherBots } : {}),
              ...(othersOnly ? { othersOnly } : {}),
            },
          }
        : {}),
      ...(text(referenced.content)
        ? {
            quote: {
              messageId: text(referenced.id),
              text: text(referenced.content),
              authorId: text(referencedAuthor.id),
              authorName:
                text(referencedAuthor.global_name) ||
                text(referencedAuthor.username),
              own: text(referencedAuthor.id) === this.#botId,
            },
          }
        : {}),
      ...(attachments.length === 0 ? {} : { attachments }),
    })
  }

  /** A thread channel and its parent, remembered for routing (bounded). */
  #thread(thread: Record<string, unknown>): void {
    const id = text(thread.id)
    const parent = text(thread.parent_id)
    const kind = thread.type === undefined ? 11 : Number(thread.type)
    if (id === '' || parent === '' || !DISCORD_THREAD_TYPES.has(kind)) return
    this.#threads.delete(id)
    this.#threads.set(id, parent)
    if (this.#threads.size > THREADS_KEPT)
      this.#threads.delete(this.#threads.keys().next().value!)
  }

  /** Where a chat's messages go: the thread when there is one. */
  #channel(chat: ChannelChat): string {
    return chat.threadId ?? chat.id
  }

  #post(chat: ChannelChat, markdown: string, replyTo: string | undefined) {
    return requestJson(
      this.#io,
      `${API}/channels/${encodeURIComponent(this.#channel(chat))}/messages`,
      {
        headers: this.#headers(),
        body: {
          content: discordMarkdown(markdown),
          allowed_mentions: { parse: [], replied_user: false },
          ...(replyTo
            ? {
                message_reference: {
                  message_id: replyTo,
                  fail_if_not_exists: false,
                },
              }
            : {}),
        },
      },
    )
  }

  /**
   * A 429 goes back to the gateway with Discord's wait (hermes: the retry
   * waits there, bounded); a reply reference Discord rejects is dropped and
   * the words sent plain.
   */
  async send(
    chat: ChannelChat,
    markdown: string,
    options: ChannelSendOptions = {},
  ): Promise<ChannelSendResult> {
    try {
      let reply = await this.#post(chat, markdown, options.replyTo)
      if (reply.status === 400 && options.replyTo)
        reply = await this.#post(chat, markdown, undefined)
      if (reply.status === 429) {
        const after = Number(reply.body.retry_after)
        return {
          ok: false,
          error: 'Discord 限流',
          retryAfterMs: Number.isFinite(after)
            ? Math.ceil(after * 1_000)
            : (reply.retryAfterMs ?? 1_000),
        }
      }
      if (reply.status !== 200)
        return { ok: false, error: `Discord 发送失败（${reply.status}）` }
      this.#typing.clear(this.#channel(chat))
      return { ok: true, messageId: text(reply.body.id) }
    } catch (error) {
      return sendFailure(error, 'Discord 发送失败')
    }
  }

  async typing(chat: ChannelChat): Promise<void> {
    const channel = this.#channel(chat)
    if (!this.#typing.due(channel)) return
    await requestJson(
      this.#io,
      `${API}/channels/${encodeURIComponent(channel)}/typing`,
      {
        method: 'POST',
        headers: this.#headers(),
      },
    ).catch(() => {})
  }

  async stop(): Promise<void> {
    await this.#loop.stop()
  }
}
