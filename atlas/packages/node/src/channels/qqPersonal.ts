// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A personal QQ account through SnowLuma (`runtimes-channels.md` §2.5).
 *
 * SnowLuma drives a logged-in QQ desktop client and speaks OneBot 11. This
 * adapter is the owner's 2026-10-17 exception to charter §7.2 item 8 (the
 * official bot stays `qq.ts`); everything else follows the owner's own
 * hermes OneBot plugin:
 *
 * - the hub dials SnowLuma's forward WebSocket and binds nothing; it never
 *   installs, configures or logs in SnowLuma (its licence forbids bundling
 *   and scripted deployment, and the QR login belongs to the account owner);
 * - the OneBot token travels as `Authorization: Bearer` and `access_token`;
 *   a rejected handshake (401/403) stops the channel instead of retrying;
 * - the link and the QQ account are two health domains: heartbeats with
 *   `status.online`, `bot_offline` and a `get_status` probe decide whether
 *   the account is logged in, and a logged-out account refuses sends;
 * - only the actions in {@link ACTIONS} are ever called: a OneBot token also
 *   unlocks cookies, credentials and raw packets, none of which the hub needs;
 * - sends are spaced (SnowLuma itself does not rate limit) and wait for
 *   the echo-correlated answer.
 *
 * When to answer in a group and how a reply is shaped follow the owner's
 * grantley (`rules/qqPersonal.ts`): keywords, the cooldown and the speech
 * cap, a sender's follow-ups heard without a new @, commands only in the
 * owner's private chat, `[MSG_BREAK]` bubbles and merged-forward cards.
 */

import { randomUUID } from 'node:crypto'
import {
  ChannelFatalError,
  ChannelLoop,
  Debounce,
  list,
  record,
  runSocket,
  text,
} from './net.js'
import {
  capBubbles,
  chunkText,
  classifyOnebotError,
  FORWARD_LEAD_TEXT,
  MAX_BUBBLES_PER_REPLY,
  MAX_MESSAGE_LENGTH,
  planReply,
  qqPersonalGroupGate,
  type SendErrorKind,
} from './rules/qqPersonal.js'
import { plainText } from './text.js'
import type {
  ChannelAdapter,
  ChannelChat,
  ChannelHealth,
  ChannelInbound,
  ChannelIo,
  ChannelQuote,
  ChannelSendOptions,
  ChannelSendResult,
} from './types.js'

export interface QqPersonalSettings {
  /** SnowLuma's forward WebSocket, e.g. `ws://127.0.0.1:3001`. */
  readonly url: string
  /** The OneBot token of that `wsServers` entry (not the WebUI password). */
  readonly accessToken: string
}

/** Every OneBot action this adapter may call. */
export const QQ_PERSONAL_ACTIONS: ReadonlySet<string> = new Set([
  'get_login_info',
  'get_status',
  'get_msg',
  'send_private_msg',
  'send_group_msg',
  'send_private_forward_msg',
  'send_group_forward_msg',
  'set_input_status',
])

const CALL_TIMEOUT_MS = 15_000
const QUOTE_TIMEOUT_MS = 3_000
/** SnowLuma heartbeats every 30 s; three missed means the link is gone. */
const SILENT_LINK_MS = 90_000
const WATCH_MS = 15_000
/** Account probe (hermes `account_probe_secs`). */
const PROBE_MS = 60_000
/** Gap between two sends from the account, any chat. */
const SEND_SPACING_MS = 800
/** Characters per merged-forward node. */
const NODE_CHARS = 1_500
const ACCOUNT_OFFLINE = 'QQ 账号已离线，请在 SnowLuma 里重新扫码登录'
/** `threadId` of a temporary session: the group it came through. */
const TEMP_PREFIX = 'temp:'
/** An action that never left: the socket was not open when its turn came. */
const UNSENT = Symbol('unsent')
const TOKEN_UNFIT = 'OneBot 访问令牌含有不能放进请求头的字符，请重新填写'
const DISCONNECTED: ChannelSendResult = {
  ok: false,
  error: 'SnowLuma 未连接',
  retryable: true,
}
const REJECTED =
  'SnowLuma 拒绝了 OneBot 令牌（填 wsServers 里的 accessToken，不是 WebUI 密码）'

type Segment = { type: string; data: Record<string, unknown> }
type Answer = Record<string, unknown>
/** A send and, when it failed, what kind of failure (grantley's vocabulary). */
interface Delivery {
  readonly result: ChannelSendResult
  readonly kind: SendErrorKind | null
}

/** A failure after part of the reply went out: sending it again would repeat that part. */
function final(result: ChannelSendResult): ChannelSendResult {
  return {
    ok: false,
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}

/** OneBot ids are integers; QQ numbers fit a double exactly. */
function numeric(id: string): number | string {
  return /^\d{1,15}$/.test(id) ? Number(id) : id
}

/** Loose boolean dialects of the online flag (hermes `_coerce_online`). */
function online(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase()
    if (['true', 'online', '1', 'yes'].includes(word)) return true
    if (['false', 'offline', '0', 'no'].includes(word)) return false
  }
  return null
}

function onlineOf(status: Record<string, unknown>): boolean | null {
  return (
    online(status.online) ??
    online(record(status.app).online) ??
    online(status.good)
  )
}

const CQ_ESCAPES: Record<string, string> = {
  '&#91;': '[',
  '&#93;': ']',
  '&#44;': ',',
  '&amp;': '&',
}

function unescapeCq(value: string): string {
  return value.replace(/&#91;|&#93;|&#44;|&amp;/g, match => CQ_ESCAPES[match]!)
}

/** A `messageFormat: "string"` message (CQ codes) as segments. */
export function cqSegments(raw: string): Segment[] {
  const segments: Segment[] = []
  const code = /\[CQ:([A-Za-z_.-]+)((?:,[^,\]]*)*)\]/g
  let last = 0
  for (let match = code.exec(raw); match !== null; match = code.exec(raw)) {
    if (match.index > last)
      segments.push({
        type: 'text',
        data: { text: unescapeCq(raw.slice(last, match.index)) },
      })
    const data: Record<string, unknown> = {}
    for (const pair of match[2]!.split(',').slice(1)) {
      const at = pair.indexOf('=')
      if (at > 0) data[pair.slice(0, at)] = unescapeCq(pair.slice(at + 1))
    }
    segments.push({ type: match[1]!, data })
    last = code.lastIndex
  }
  if (last < raw.length)
    segments.push({ type: 'text', data: { text: unescapeCq(raw.slice(last)) } })
  return segments
}

function segmentsOf(message: unknown): Segment[] {
  if (typeof message === 'string') return cqSegments(message)
  return list(message).flatMap(item => {
    const one = record(item)
    return typeof one.type === 'string'
      ? [{ type: one.type, data: record(one.data) }]
      : []
  })
}

/** Paragraphs packed into forward-card nodes of at most `limit` characters. */
export function forwardNodes(content: string, limit = NODE_CHARS): string[] {
  const nodes: string[] = []
  let current = ''
  const pieces = content.split(/\n{2,}/).flatMap(paragraph => {
    const out: string[] = []
    let rest = paragraph
    while (rest.length > limit) {
      let at = rest.lastIndexOf('\n', limit)
      if (at < limit / 2) at = rest.lastIndexOf(' ', limit)
      if (at < limit / 2) at = limit
      out.push(rest.slice(0, at))
      rest = rest.slice(at).replace(/^\s+/, '')
    }
    if (rest) out.push(rest)
    return out
  })
  for (const piece of pieces) {
    if (current && current.length + 2 + piece.length > limit) {
      nodes.push(current)
      current = piece
    } else current = current ? `${current}\n\n${piece}` : piece
  }
  if (current) nodes.push(current)
  return nodes
}

interface Pending {
  readonly resolve: (answer: Answer | null) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export class QqPersonalAdapter implements ChannelAdapter {
  readonly platform = 'qq-personal' as const
  readonly chunkLimit = MAX_MESSAGE_LENGTH
  readonly groupGate = qqPersonalGroupGate
  /** grantley `has_sender_work`: a sender's follow-ups need no new @. */
  readonly continuesSenders = true
  /** grantley 主窗口: a group is not a console. */
  readonly commandScope = 'owner-private' as const
  readonly #io: ChannelIo
  readonly #settings: QqPersonalSettings
  readonly #loop: ChannelLoop
  readonly #typing: Debounce
  readonly #pending = new Map<string, Pending>()
  /** Messages the account sent: id → text, so quoting one is addressing the bot. */
  readonly #own = new Map<string, string>()
  /** Who sent each recent inbound message, for the @ on a group reply. */
  readonly #senders = new Map<string, string>()
  #socket: WebSocket | null = null
  #selfId = ''
  #nickname = ''
  /** null until the first explicit signal: unknown is not offline. */
  #account: boolean | null = null
  #lastFrameAt = 0
  #inboundChain: Promise<void> = Promise.resolve()
  #sendChain: Promise<unknown> = Promise.resolve()
  #lastSendAt = 0
  #typingSupported = true
  #seq = 0

  constructor(settings: QqPersonalSettings, io: ChannelIo) {
    this.#settings = settings
    this.#io = io
    this.#loop = new ChannelLoop(io)
    this.#typing = new Debounce(5_000, io.now)
  }

  health(): ChannelHealth {
    return this.#loop.health()
  }

  #socketUrl(): string {
    const url = new URL(this.#settings.url)
    url.searchParams.set('access_token', this.#settings.accessToken)
    return url.toString()
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.#settings.accessToken}` }
  }

  /**
   * Bun's WebSocket hides the handshake status, so a socket that never
   * opened is asked once over HTTP with the same upgrade request: 401/403
   * is a wrong token, not an outage.
   */
  async #handshakeRejected(signal: AbortSignal): Promise<boolean> {
    const url = new URL(this.#socketUrl())
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    try {
      const response = await this.#io.fetch(url.toString(), {
        headers: {
          ...this.#headers(),
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': Buffer.from(randomUUID().slice(0, 16)).toString(
            'base64',
          ),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      })
      await response.body?.cancel().catch(() => {})
      return response.status === 401 || response.status === 403
    } catch {
      return false
    }
  }

  async start(sink: (message: ChannelInbound) => void): Promise<void> {
    this.#loop.start(async signal => {
      // Bun rejects such a header with the token in its message.
      if (!/^[\x21-\x7e]+$/.test(this.#settings.accessToken))
        throw new ChannelFatalError(TOKEN_UNFIT)
      let watch: ReturnType<typeof setInterval> | undefined
      let probe: ReturnType<typeof setInterval> | undefined
      const closed = await runSocket(this.#io, this.#socketUrl(), signal, {
        headers: this.#headers(),
        onOpen: socket => {
          this.#socket = socket
          this.#lastFrameAt = this.#io.now()
          this.#markLink()
          void this.#identify()
          watch = setInterval(() => {
            if (this.#io.now() - this.#lastFrameAt > SILENT_LINK_MS)
              socket.close(4000, 'silent')
          }, WATCH_MS)
          probe = setInterval(() => void this.#probe(), PROBE_MS)
        },
        onMessage: frame => this.#frame(frame, sink),
      })
      clearInterval(watch)
      clearInterval(probe)
      this.#socket = null
      for (const [echo, pending] of this.#pending) {
        clearTimeout(pending.timer)
        pending.resolve(null)
        this.#pending.delete(echo)
      }
      if (signal.aborted) return
      if (!closed.opened) {
        if (await this.#handshakeRejected(signal))
          throw new ChannelFatalError(REJECTED)
        throw new Error('SnowLuma 不可达')
      }
      if (closed.code === 1008)
        throw new Error('SnowLuma 断开了连接（令牌可能已更换）')
    })
  }

  /** The link is up; the account decides whether the channel works. */
  #markLink(): void {
    if (this.#account === false) this.#loop.mark('failed', ACCOUNT_OFFLINE)
    else this.#loop.mark('connected')
  }

  #setAccount(value: boolean | null): void {
    if (value === null || value === this.#account) return
    this.#account = value
    if (this.#socket !== null) this.#markLink()
  }

  async #identify(): Promise<void> {
    const login = await this.#call('get_login_info', {})
    if (login !== null && login !== UNSENT && this.#ok(login)) {
      const data = record(login.data)
      if (text(data.user_id)) this.#selfId = text(data.user_id)
      this.#nickname = text(data.nickname)
    }
    await this.#probe()
  }

  async #probe(): Promise<void> {
    const status = await this.#call('get_status', {})
    if (status !== null && status !== UNSENT && this.#ok(status))
      this.#setAccount(onlineOf(record(status.data)))
  }

  #ok(answer: Answer): boolean {
    const code = answer.retcode
    return (
      answer.status !== 'failed' &&
      (code === undefined || code === 0 || code === 1)
    )
  }

  /**
   * One action, answered by its echo. {@link UNSENT} when it never left
   * (worth sending again); null when it left and no answer came (it may have
   * arrived, so senders count it as sent).
   */
  #call(
    action: string,
    params: Record<string, unknown>,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<Answer | null | typeof UNSENT> {
    if (!QQ_PERSONAL_ACTIONS.has(action))
      return Promise.reject(new Error(`不允许的 OneBot 动作：${action}`))
    const socket = this.#socket
    if (socket === null || socket.readyState !== 1)
      return Promise.resolve(UNSENT)
    const echo = `qm-${++this.#seq}-${randomUUID().slice(0, 8)}`
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo)
        resolve(null)
      }, timeoutMs)
      this.#pending.set(echo, { resolve, timer })
      socket.send(JSON.stringify({ action, params, echo }))
    })
  }

  #frame(
    frame: Record<string, unknown>,
    sink: (message: ChannelInbound) => void,
  ): void {
    this.#lastFrameAt = this.#io.now()
    if (frame.echo !== undefined) {
      const pending = this.#pending.get(String(frame.echo))
      if (pending !== undefined) {
        this.#pending.delete(String(frame.echo))
        clearTimeout(pending.timer)
        pending.resolve(frame)
      }
      return
    }
    if (text(frame.self_id) && !this.#selfId) this.#selfId = text(frame.self_id)
    switch (frame.post_type) {
      case 'meta_event':
        if (frame.meta_event_type === 'heartbeat')
          this.#setAccount(onlineOf(record(frame.status)))
        return
      case 'notice':
        if (frame.notice_type === 'bot_offline') this.#setAccount(false)
        return
      case 'message':
        this.#inboundChain = this.#inboundChain
          .then(() => this.#inbound(frame))
          .then(inbound => {
            if (inbound !== null) sink(inbound)
          })
          .catch(() => {})
    }
  }

  async #inbound(
    event: Record<string, unknown>,
  ): Promise<ChannelInbound | null> {
    const user = text(event.user_id)
    if (user === '' || (this.#selfId !== '' && user === this.#selfId))
      return null
    const sender = record(event.sender)
    const group = event.message_type === 'group'
    const groupId = text(event.group_id)
    if (group && groupId === '') return null
    if (!group && event.message_type !== 'private') return null
    // A temporary session belongs to the user and the group it came
    // through: its own chat (and conversation), routed by that group.
    const via =
      !group && event.sub_type === 'group'
        ? text(sender.group_id) || text(event.group_id)
        : ''
    let body = ''
    let addressed = !group
    let replyId = ''
    const attachments: { name: string; kind: string }[] = []
    for (const segment of segmentsOf(event.message)) {
      const data = segment.data
      switch (segment.type) {
        case 'text':
          body += text(data.text)
          break
        case 'at': {
          const qq = text(data.qq)
          if (this.#selfId !== '' && qq === this.#selfId) addressed = true
          else
            body += qq === 'all' ? '@全体成员 ' : `@${text(data.name) || qq} `
          break
        }
        case 'reply':
          replyId = text(data.id)
          break
        case 'face':
        case 'mface':
          body += '[表情]'
          break
        case 'image':
          attachments.push({
            name: text(data.summary) || '图片',
            kind: 'image',
          })
          break
        case 'record':
          attachments.push({ name: '语音', kind: 'voice' })
          break
        case 'video':
          attachments.push({ name: '视频', kind: 'video' })
          break
        case 'file':
          attachments.push({
            name: text(data.name) || text(data.file) || '文件',
            kind: 'file',
          })
          break
        case 'forward':
          body += '[聊天记录]'
          break
        case 'json':
        case 'xml':
          body += '[卡片消息]'
          break
      }
    }
    body = body.trim()
    if (body === '' && attachments.length === 0) return null
    const messageId = text(event.message_id)
    if (messageId === '') return null
    const quote = replyId === '' ? undefined : await this.#quote(replyId)
    // Quoting the bot is speaking to it (hermes `quote_reply_addresses_bot`).
    if (quote?.own) addressed = true
    this.#senders.set(messageId, user)
    if (this.#senders.size > 1_000)
      this.#senders.delete(this.#senders.keys().next().value!)
    return {
      chat: group
        ? { type: 'group', id: groupId }
        : via
          ? { type: 'dm', id: user, threadId: `${TEMP_PREFIX}${via}` }
          : { type: 'dm', id: user },
      ...(group && text(event.group_name)
        ? { chatName: text(event.group_name) }
        : {}),
      messageId,
      userId: user,
      userName: text(sender.card) || text(sender.nickname) || user,
      text: body,
      addressed,
      ...(quote === undefined ? {} : { quote }),
      ...(attachments.length === 0 ? {} : { attachments }),
    }
  }

  async #quote(id: string): Promise<ChannelQuote | undefined> {
    const own = this.#own.get(id)
    if (own !== undefined) return { messageId: id, text: own, own: true }
    const answer = await this.#call(
      'get_msg',
      { message_id: numeric(id) },
      QUOTE_TIMEOUT_MS,
    )
    if (answer === null || answer === UNSENT || !this.#ok(answer))
      return undefined
    const data = record(answer.data)
    const sender = record(data.sender)
    const quoted = segmentsOf(data.message ?? data.raw_message)
      .map(segment =>
        segment.type === 'text'
          ? text(segment.data.text)
          : segment.type === 'image'
            ? '[图片]'
            : '',
      )
      .join('')
      .trim()
    if (quoted === '') return undefined
    const author = text(sender.user_id) || text(data.user_id)
    return {
      messageId: id,
      text: quoted,
      ...(author ? { authorId: author } : {}),
      ...(text(sender.card) || text(sender.nickname)
        ? { authorName: text(sender.card) || text(sender.nickname) }
        : {}),
      own: this.#selfId !== '' && author === this.#selfId,
    }
  }

  // -- outbound ---------------------------------------------------------------

  /**
   * Every send from the account goes through one queue with a gap between
   * sends: SnowLuma does not pace, and a burst is what QQ's risk control
   * notices first.
   */
  #paced<T>(send: () => Promise<T>): Promise<T> {
    const run = this.#sendChain.then(async () => {
      const wait = this.#lastSendAt + SEND_SPACING_MS - this.#io.now()
      if (wait > 0) await this.#io.sleep(wait)
      try {
        return await send()
      } finally {
        this.#lastSendAt = this.#io.now()
      }
    })
    this.#sendChain = run.catch(() => {})
    return run
  }

  #target(chat: ChannelChat): Record<string, unknown> {
    if (chat.type === 'group') return { group_id: numeric(chat.id) }
    const via = chat.threadId?.startsWith(TEMP_PREFIX)
      ? chat.threadId.slice(TEMP_PREFIX.length)
      : ''
    return {
      user_id: numeric(chat.id),
      ...(via ? { group_id: numeric(via) } : {}),
    }
  }

  /** Quote the message (and @ its sender in a group) on the first chunk. */
  #lead(chat: ChannelChat, replyTo: string | undefined): Segment[] {
    if (replyTo === undefined) return []
    const segments: Segment[] = [{ type: 'reply', data: { id: replyTo } }]
    const author = this.#senders.get(replyTo)
    if (
      chat.type === 'group' &&
      author !== undefined &&
      author !== this.#selfId
    )
      segments.push({ type: 'at', data: { qq: author } })
    return segments
  }

  /** Checked again inside the send queue: the socket may close while a send waits. */
  #refusal(): ChannelSendResult | null {
    if (this.#account === false) return { ok: false, error: ACCOUNT_OFFLINE }
    if (this.#socket === null || this.#socket.readyState !== 1)
      return DISCONNECTED
    return null
  }

  /**
   * A OneBot refusal, with the backend's words; trying again helps only a
   * transient or throttled one (grantley `classify_onebot_error`).
   */
  #refused(answer: Answer): Delivery {
    const code = Number(answer.retcode)
    const words = text(answer.wording) || text(answer.message)
    const said = [...words].slice(0, 80).join('')
    const kind = classifyOnebotError(
      Number.isFinite(code) ? code : undefined,
      words,
    )
    return {
      kind,
      result: {
        ok: false,
        error: `QQ 发送失败（${Number.isFinite(code) ? code : '未知'}${said ? ` ${said}` : ''}）`,
        ...(kind === 'transient' || kind === 'rate_limited'
          ? { retryable: true }
          : {}),
      },
    }
  }

  /** The answer to a send; no answer in time counts as sent (hermes: a missing echo is not a failure). */
  #result(answer: Answer | null | typeof UNSENT, remember: string): Delivery {
    if (answer === UNSENT) return { result: DISCONNECTED, kind: 'transient' }
    if (answer === null) {
      this.#io.onError?.('SnowLuma 没有确认这条消息，按已发送处理')
      return { result: { ok: true }, kind: null }
    }
    if (!this.#ok(answer)) return this.#refused(answer)
    const id = text(record(answer.data).message_id)
    if (id) {
      this.#own.set(id, [...remember].slice(0, 500).join(''))
      if (this.#own.size > 500) this.#own.delete(this.#own.keys().next().value!)
    }
    return {
      result: { ok: true, ...(id ? { messageId: id } : {}) },
      kind: null,
    }
  }

  /**
   * One chat message: the quote (and in a group the @) when this is the
   * first of a reply, then the words (grantley `_lead_segments`).
   */
  #text(
    chat: ChannelChat,
    content: string,
    replyTo: string | undefined,
  ): Promise<Delivery> {
    return this.#paced(async () => {
      const late = this.#refusal()
      if (late !== null)
        return {
          result: late,
          kind: late === DISCONNECTED ? 'transient' : 'unknown',
        }
      const lead = this.#lead(chat, replyTo)
      const words =
        lead.length > 0 && chat.type === 'group' ? ` ${content}` : content
      return this.#result(
        await this.#call(
          chat.type === 'group' ? 'send_group_msg' : 'send_private_msg',
          {
            ...this.#target(chat),
            message: [...lead, { type: 'text', data: { text: words } }],
          },
        ),
        content,
      )
    })
  }

  /** One message of agent markdown, as plain text. */
  async send(
    chat: ChannelChat,
    markdown: string,
    options: ChannelSendOptions = {},
  ): Promise<ChannelSendResult> {
    const refused = this.#refusal()
    if (refused !== null) return refused
    return (await this.#text(chat, plainText(markdown), options.replyTo)).result
  }

  /**
   * One merged-forward ("聊天记录") card, a node per bubble (a bubble past
   * 1500 characters over several). A card can neither quote nor @, so in a
   * group a quoted lead line with the @ goes first (grantley
   * `_deliver_forward`). Nodes carry both key dialects (`name`/`uin` and
   * `nickname`/`user_id`).
   */
  async #card(
    chat: ChannelChat,
    bodies: readonly string[],
    replyTo: string | undefined,
  ): Promise<Delivery & { readonly leadSent: boolean }> {
    if (this.#selfId === '')
      return {
        result: {
          ok: false,
          error: '还不知道本号的 QQ 号，发不了聊天记录卡片',
        },
        kind: 'unknown',
        leadSent: false,
      }
    let leadSent = false
    const author =
      replyTo === undefined ? undefined : this.#senders.get(replyTo)
    if (
      chat.type === 'group' &&
      author !== undefined &&
      author !== this.#selfId
    ) {
      const lead = await this.#text(chat, FORWARD_LEAD_TEXT, replyTo)
      if (!lead.result.ok) return { ...lead, leadSent }
      leadSent = true
    }
    const name = this.#nickname || 'Qmo'
    const whole = bodies.join('\n')
    const answer = await this.#paced(async () => {
      if (this.#refusal() !== null) return UNSENT
      return this.#call(
        chat.type === 'group'
          ? 'send_group_forward_msg'
          : 'send_private_forward_msg',
        {
          ...this.#target(chat),
          messages: bodies
            .flatMap(body => forwardNodes(body))
            .map(node => ({
              type: 'node',
              data: {
                name,
                uin: this.#selfId,
                nickname: name,
                user_id: this.#selfId,
                content: [{ type: 'text', data: { text: node } }],
              },
            })),
        },
      )
    })
    return { ...this.#result(answer, whole), leadSent }
  }

  /**
   * A whole reply, grantley `send`: decided once on the finished text, it
   * is a card (too long, too many bubbles, `[LONG_REPLY]`) or up to three
   * bubbles. A card the backend refuses falls back to bubbles, capped and
   * after the lead line if that went out; a forbidden or vanished chat
   * cannot take bubbles either. Only the first message quotes and @s.
   */
  async sendReply(
    chat: ChannelChat,
    markdown: string,
    options: ChannelSendOptions = {},
  ): Promise<ChannelSendResult> {
    const refused = this.#refusal()
    if (refused !== null) return refused
    const plan = planReply(markdown)
    if (plan.bubbles.length === 0) return { ok: true }
    let delivered = false
    let bubbles = plan.bubbles
    if (plan.card) {
      const card = await this.#card(chat, plan.bubbles, options.replyTo)
      if (card.result.ok) return card.result
      delivered = card.leadSent
      if (card.kind === 'forbidden' || card.kind === 'not_found')
        return delivered ? final(card.result) : card.result
      this.#io.onError?.('聊天记录卡片没有发出，改为分条发送')
      bubbles = capBubbles(plan.bubbles, MAX_BUBBLES_PER_REPLY)
    }
    let first = !delivered
    let last: ChannelSendResult = { ok: true }
    for (const bubble of bubbles)
      for (const chunk of chunkText(bubble, MAX_MESSAGE_LENGTH)) {
        const sent = await this.#text(
          chat,
          chunk,
          first ? options.replyTo : undefined,
        )
        if (!sent.result.ok) return delivered ? final(sent.result) : sent.result
        delivered = true
        first = false
        last = sent.result
      }
    return last
  }

  /** Private chats only: QQ groups show no typing state. */
  async typing(chat: ChannelChat): Promise<void> {
    if (
      chat.type !== 'dm' ||
      !this.#typingSupported ||
      this.#account === false ||
      !this.#typing.due(chat.id)
    )
      return
    const answer = await this.#call(
      'set_input_status',
      { user_id: numeric(chat.id), event_type: 1 },
      5_000,
    )
    if (answer !== null && answer !== UNSENT && Number(answer.retcode) === 1404)
      this.#typingSupported = false
  }

  async stopTyping(chat: ChannelChat): Promise<void> {
    this.#typing.clear(chat.id)
  }

  async stop(): Promise<void> {
    await this.#loop.stop()
  }
}
