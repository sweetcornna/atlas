// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * WeChat through Tencent's iLink bot API (`ilinkai.weixin.qq.com`): the
 * owner scans a QR code to authorize a bot account, the hub long-polls
 * `getupdates`, and every reply echoes the peer's latest `context_token`
 * (WeChat refuses a reply without it). Typing uses the ticket `getconfig`
 * hands out. No reverse-engineered protocol and no client hooks.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import {
  ChannelFatalError,
  ChannelLoop,
  Debounce,
  list,
  record,
  requestJson,
  text,
} from './net.js'
import { plainText } from './text.js'
import type {
  ChannelAdapter,
  ChannelChat,
  ChannelHealth,
  ChannelInbound,
  ChannelIo,
  ChannelSendResult,
} from './types.js'

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const CHANNEL_VERSION = '2.2.0'
const CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0)
const SESSION_EXPIRED = -14
const ITEM_TEXT = 1
const ITEM_IMAGE = 2
const ITEM_VOICE = 3
const ITEM_FILE = 4
const ITEM_VIDEO = 5
const MESSAGE_FROM_BOT = 2

function headers(token?: string): Record<string, string> {
  return {
    authorizationtype: 'ilink_bot_token',
    'x-wechat-uin': Buffer.from(
      String(randomBytes(4).readUInt32BE(0)),
    ).toString('base64'),
    'ilink-app-id': 'bot',
    'ilink-app-clientversion': CLIENT_VERSION,
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  }
}

/** The iLink host the login (or a redirect during it) named; never another domain. */
export function ilinkBaseUrl(raw: unknown): string {
  const value = text(raw)
  if (value === '') return ILINK_BASE_URL
  const url = new URL(value.includes('://') ? value : `https://${value}`)
  if (
    url.protocol !== 'https:' ||
    !(
      url.hostname === 'weixin.qq.com' ||
      url.hostname.endsWith('.weixin.qq.com')
    )
  )
    throw new ChannelFatalError('微信返回的服务地址不在官方域名下')
  return url.origin
}

export interface WeixinQr {
  /** Opaque value to poll with. */
  readonly qrcode: string
  /** What the QR image encodes (a URL WeChat opens), for the console to draw. */
  readonly content: string
}

/** Starts a bot login: the console shows `content` as a QR code to scan in WeChat. */
export async function weixinQrStart(io: ChannelIo): Promise<WeixinQr> {
  const reply = await requestJson(
    io,
    `${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
    {
      headers: headers(),
      timeoutMs: 35_000,
    },
  )
  const qrcode = text(reply.body.qrcode)
  if (qrcode === '') throw new Error('微信没有返回登录二维码')
  return { qrcode, content: text(reply.body.qrcode_img_content) || qrcode }
}

export type WeixinQrStatus =
  | {
      readonly state: 'wait' | 'scanned' | 'expired'
      readonly baseUrl?: string
    }
  | {
      readonly state: 'confirmed'
      readonly accountId: string
      readonly token: string
      readonly baseUrl: string
      /** The WeChat user who scanned: the owner. */
      readonly userId: string
    }

export async function weixinQrPoll(
  io: ChannelIo,
  qrcode: string,
  baseUrl = ILINK_BASE_URL,
): Promise<WeixinQrStatus> {
  const reply = await requestJson(
    io,
    `${ilinkBaseUrl(baseUrl)}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    { headers: headers(), timeoutMs: 40_000 },
  ).catch(() => ({
    status: 0,
    body: { status: 'wait' } as Record<string, unknown>,
  }))
  const status = text(reply.body.status) || 'wait'
  if (status === 'confirmed') {
    const accountId = text(reply.body.ilink_bot_id)
    const token = text(reply.body.bot_token)
    if (accountId === '' || token === '')
      throw new Error('微信确认登录但没有返回凭据')
    return {
      state: 'confirmed',
      accountId,
      token,
      baseUrl: ilinkBaseUrl(reply.body.baseurl),
      userId: text(reply.body.ilink_user_id),
    }
  }
  if (status === 'scaned_but_redirect')
    return { state: 'scanned', baseUrl: ilinkBaseUrl(reply.body.redirect_host) }
  if (status === 'scaned') return { state: 'scanned' }
  if (status === 'expired') return { state: 'expired' }
  return { state: 'wait' }
}

export interface WeixinSettings {
  readonly accountId: string
  readonly token: string
  readonly baseUrl: string
  /** Where long polling resumes, and each peer's latest context token. */
  readonly cursor?: string
  readonly contextTokens?: Readonly<Record<string, string>>
  readonly onState?: (state: {
    cursor: string
    contextTokens: Record<string, string>
  }) => void
}

function quoteOf(items: readonly Record<string, unknown>[]): string {
  for (const item of items) {
    const ref = record(item.ref_msg)
    const referenced = record(ref.message_item)
    const parts = [
      text(ref.title),
      text(record(referenced.text_item).text),
    ].filter(Boolean)
    if (parts.length > 0) return parts.join(' | ')
  }
  return ''
}

export class WeixinAdapter implements ChannelAdapter {
  readonly platform = 'weixin' as const
  readonly chunkLimit = 1_800
  readonly #io: ChannelIo
  readonly #settings: WeixinSettings
  readonly #base: string
  readonly #loop: ChannelLoop
  readonly #contexts: Map<string, string>
  readonly #tickets = new Map<string, { ticket: string; at: number }>()
  readonly #typing: Debounce
  #cursor: string

  constructor(settings: WeixinSettings, io: ChannelIo) {
    this.#settings = settings
    this.#io = io
    this.#base = ilinkBaseUrl(settings.baseUrl)
    this.#loop = new ChannelLoop(io)
    this.#contexts = new Map(Object.entries(settings.contextTokens ?? {}))
    this.#cursor = settings.cursor ?? ''
    this.#typing = new Debounce(5_000, io.now)
  }

  health(): ChannelHealth {
    return this.#loop.health()
  }

  async #post(
    endpoint: string,
    payload: Record<string, unknown>,
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ) {
    const reply = await requestJson(
      this.#io,
      `${this.#base}/ilink/bot/${endpoint}`,
      {
        headers: headers(this.#settings.token),
        body: { ...payload, base_info: { channel_version: CHANNEL_VERSION } },
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      },
    )
    const code = Number(reply.body.errcode ?? reply.body.ret ?? 0)
    if (code === SESSION_EXPIRED || reply.status === 401)
      throw new ChannelFatalError('微信登录已失效，请在控制台重新扫码')
    return { ...reply, code }
  }

  #persist(): void {
    this.#settings.onState?.({
      cursor: this.#cursor,
      contextTokens: Object.fromEntries(this.#contexts),
    })
  }

  async start(sink: (message: ChannelInbound) => void): Promise<void> {
    this.#loop.start(async signal => {
      let timeoutMs = 35_000
      while (!signal.aborted) {
        let reply
        try {
          reply = await this.#post(
            'getupdates',
            { get_updates_buf: this.#cursor },
            timeoutMs + 5_000,
            signal,
          )
        } catch (error) {
          if (error instanceof Error && /超时/.test(error.message)) continue
          throw error
        }
        if (reply.code !== 0)
          throw new Error(`微信 getupdates 失败（${reply.code}）`)
        this.#loop.mark('connected')
        const suggested = Number(reply.body.longpolling_timeout_ms)
        if (Number.isFinite(suggested) && suggested > 0) timeoutMs = suggested
        const next = text(reply.body.get_updates_buf)
        let changed = false
        if (next !== '' && next !== this.#cursor) {
          this.#cursor = next
          changed = true
        }
        for (const raw of list(reply.body.msgs)) {
          const message = record(raw)
          const from = text(message.from_user_id)
          if (
            from === '' ||
            from === this.#settings.accountId ||
            Number(message.message_type) === MESSAGE_FROM_BOT
          )
            continue
          const context = text(message.context_token)
          if (context !== '' && this.#contexts.get(from) !== context) {
            this.#contexts.set(from, context)
            changed = true
          }
          const inbound = this.#inbound(message, from)
          if (inbound !== null) sink(inbound)
        }
        if (changed) this.#persist()
      }
    })
  }

  #inbound(
    message: Record<string, unknown>,
    from: string,
  ): ChannelInbound | null {
    const items = list(message.item_list).map(record)
    let body = ''
    const attachments: { name: string; kind: string }[] = []
    for (const item of items) {
      const type = Number(item.type)
      if (type === ITEM_TEXT && body === '')
        body = text(record(item.text_item).text)
      else if (type === ITEM_VOICE && body === '')
        body = text(record(item.voice_item).text)
      else if (type === ITEM_IMAGE)
        attachments.push({ name: '图片', kind: 'image' })
      else if (type === ITEM_FILE)
        attachments.push({
          name: text(record(item.file_item).file_name) || '文件',
          kind: 'file',
        })
      else if (type === ITEM_VIDEO)
        attachments.push({ name: '视频', kind: 'video' })
    }
    if (body.trim() === '' && attachments.length === 0) return null
    const room = text(message.room_id) || text(message.chat_room_id)
    const quoted = quoteOf(items)
    return {
      chat: room ? { type: 'group', id: room } : { type: 'dm', id: from },
      messageId: text(message.message_id) || randomUUID(),
      userId: from,
      userName: from,
      text: body.trim(),
      addressed: true,
      ...(quoted ? { quote: { text: quoted, own: false } } : {}),
      ...(attachments.length === 0 ? {} : { attachments }),
    }
  }

  async send(chat: ChannelChat, markdown: string): Promise<ChannelSendResult> {
    const context = this.#contexts.get(chat.id)
    try {
      const reply = await this.#post('sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: chat.id,
          client_id: randomUUID(),
          message_type: MESSAGE_FROM_BOT,
          message_state: 2,
          item_list: [
            { type: ITEM_TEXT, text_item: { text: plainText(markdown) } },
          ],
          ...(context === undefined ? {} : { context_token: context }),
        },
      })
      if (reply.status !== 200 || reply.code !== 0)
        return {
          ok: false,
          error: `微信发送失败（${reply.code || reply.status}）`,
        }
      return { ok: true }
    } catch (error) {
      if (error instanceof ChannelFatalError)
        this.#loop.mark('failed', error.message)
      return {
        ok: false,
        error: error instanceof Error ? error.message : '微信发送失败',
      }
    }
  }

  async #ticket(user: string): Promise<string | undefined> {
    const known = this.#tickets.get(user)
    if (known !== undefined && this.#io.now() - known.at < 600_000)
      return known.ticket
    const context = this.#contexts.get(user)
    const reply = await this.#post(
      'getconfig',
      {
        ilink_user_id: user,
        ...(context === undefined ? {} : { context_token: context }),
      },
      10_000,
    )
    const ticket = text(reply.body.typing_ticket)
    if (ticket === '') return undefined
    this.#tickets.set(user, { ticket, at: this.#io.now() })
    return ticket
  }

  async typing(chat: ChannelChat): Promise<void> {
    if (chat.type !== 'dm' || !this.#typing.due(chat.id)) return
    const ticket = await this.#ticket(chat.id).catch(() => undefined)
    if (ticket === undefined) return
    await this.#post(
      'sendtyping',
      { ilink_user_id: chat.id, typing_ticket: ticket, status: 1 },
      10_000,
    ).catch(() => {})
  }

  async stopTyping(chat: ChannelChat): Promise<void> {
    this.#typing.clear(chat.id)
    const ticket = this.#tickets.get(chat.id)?.ticket
    if (ticket === undefined) return
    await this.#post(
      'sendtyping',
      { ilink_user_id: chat.id, typing_ticket: ticket, status: 2 },
      10_000,
    ).catch(() => {})
  }

  async stop(): Promise<void> {
    await this.#loop.stop()
  }
}
