// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat channels on the hub (P28, `runtimes-channels.md` §2).
 *
 * Each channel is one bot account on one platform, bound to agents: the
 * owner's private chat goes to `target`, everyone else (groups, other people)
 * to `memberTarget`. The hub runs the platform adapters (`channels/*.ts`),
 * the grantley reply logic (`channels/gateway.ts`), and turns each chat into
 * one long-lived console conversation dispatched as the channel's owner
 * account through the same `ChatDispatch` boundary schedules use, so
 * ownership, tenancy, quota and audit apply unchanged and the owner can read
 * every channel conversation on the console's 对话 page.
 *
 * Bot credentials are sealed with the connector vault (`connectors/secrets.ts`)
 * and never leave the hub; the page only learns whether one is set.
 */

import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  ChatDispatch,
  MODEL_DIRECTIONS,
  type ChannelDraft,
  type ChannelLoginView,
  type ChannelPairingDecision,
  type ChannelPlatformView,
  type ChannelsPort,
  type ChannelsSnapshot,
  type ChannelView,
  type ChatPort,
  type ConsoleAccounts,
  type ConsoleResult,
  type DirectionActor,
  type ModelDirection,
  type TenantPort,
  type UsagePort,
} from '@qianmo/console'
import { parseAddress } from '@qianmo/protocol'
import {
  ChannelGateway,
  type ChannelConversation,
  type ChannelRules,
  type ChannelTurnResult,
  type ChannelTurns,
} from '../channels/gateway.js'
import { DiscordAdapter } from '../channels/discord.js'
import {
  ChannelPairing,
  emptyPairingBook,
  formatPairingCode,
} from '../channels/pairing.js'
import { QqAdapter } from '../channels/qq.js'
import { QqPersonalAdapter } from '../channels/qqPersonal.js'
import { SlackAdapter } from '../channels/slack.js'
import { TelegramAdapter } from '../channels/telegram.js'
import {
  defaultChannelIo,
  isChannelPlatform,
  type ChannelAdapter,
  type ChannelInbound,
  type ChannelIo,
  type ChannelPlatform,
} from '../channels/types.js'
import {
  ILINK_BASE_URL,
  WeixinAdapter,
  weixinQrPoll,
  weixinQrStart,
} from '../channels/weixin.js'
import { ConnectorVault, type ConnectorSecret } from '../connectors/secrets.js'
import { refusal, sendAndWait } from './chatTurn.js'
import { SUPERVISOR_RULES, taskNote } from './consoleTasks.js'
import {
  acquirePrivateInstanceLock,
  ensurePrivateDir,
  type PrivateInstanceLock,
  readTextIfExists,
  writePrivateJson,
} from '../providers/store.js'

export const CHANNEL_PLATFORM_VIEWS: readonly ChannelPlatformView[] = [
  {
    id: 'qq',
    name: 'QQ',
    settings: [{ key: 'appId', label: 'AppID' }],
    secrets: [{ key: 'appSecret', label: 'AppSecret' }],
    qrLogin: false,
    pairing: true,
    hint: '在 QQ 开放平台创建机器人并开通单聊、群聊消息；群里只有 @ 机器人的消息会送达',
    evaluated: false,
  },
  {
    id: 'qq-personal',
    name: '个人 QQ',
    settings: [{ key: 'url', label: 'SnowLuma 地址（正向 WebSocket）' }],
    secrets: [{ key: 'accessToken', label: 'OneBot 访问令牌' }],
    qrLogin: false,
    pairing: false,
    hint: '在自己的电脑上运行 SnowLuma 并扫码登录 QQ（建议小号），开一个正向 WebSocket 并设好 accessToken；阡陌只连接，不安装、不配置它。个人号接入不是 QQ 官方接口，有封号风险',
    evaluated: false,
  },
  {
    id: 'weixin',
    name: '微信',
    settings: [],
    secrets: [],
    qrLogin: true,
    pairing: true,
    hint: '用微信扫码授权一个机器人账号（腾讯 iLink 机器人接口）；扫码的人记为主人',
    evaluated: false,
  },
  {
    id: 'telegram',
    name: 'Telegram',
    settings: [],
    secrets: [{ key: 'token', label: 'Bot Token' }],
    qrLogin: false,
    pairing: true,
    hint: '找 @BotFather 创建机器人；群里 @ 机器人或回复它的消息才会送达，除非关掉隐私模式',
    evaluated: false,
  },
  {
    id: 'discord',
    name: 'Discord',
    settings: [],
    secrets: [{ key: 'token', label: 'Bot Token' }],
    qrLogin: false,
    pairing: true,
    hint: '在开发者后台创建机器人，开启 Message Content 意图后邀请进服务器',
    evaluated: false,
  },
  {
    id: 'slack',
    name: 'Slack',
    settings: [],
    secrets: [
      { key: 'appToken', label: 'App Token（xapp-）' },
      { key: 'botToken', label: 'Bot Token（xoxb-）' },
    ],
    qrLogin: false,
    pairing: true,
    hint: '开启 Socket Mode，订阅 message.im、message.channels、app_mention 事件',
    evaluated: false,
  },
]

const secretSchema = z.object({
  revision: z.number().int().positive(),
  slot: z.enum(['password', 'ics-url']),
  at: z.number(),
  wrapped: z.string(),
  body: z.string(),
})

const storedSchema = z.object({
  id: z.string().regex(/^ch-[0-9a-f-]{36}$/),
  name: z.string(),
  platform: z.enum([
    'qq',
    'qq-personal',
    'weixin',
    'telegram',
    'discord',
    'slack',
  ]),
  enabled: z.boolean(),
  owner: z.string(),
  target: z.string(),
  memberTarget: z.string().nullable(),
  ownerIds: z.array(z.string()),
  allowAll: z.boolean(),
  allowUsers: z.array(z.string()),
  allowGroups: z.array(z.string()),
  groupTrigger: z.enum(['mention', 'all']),
  replyWindowMs: z.number().int().min(0).max(60_000),
  prompt: z.string(),
  /** Strangers may ask to pair (hermes); implied when nobody is configured. */
  pairing: z.boolean().default(false),
  settings: z.record(z.string(), z.string()),
  secret: secretSchema.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
type StoredChannel = z.infer<typeof storedSchema>

const bookSchema = z.object({
  v: z.literal(1),
  channels: z.array(storedSchema),
})

const conversationSchema = z.object({
  channelId: z.string(),
  sessionId: z.string().nullable(),
  target: z.string(),
  turns: z.number().int().nonnegative(),
  direction: z.enum(MODEL_DIRECTIONS).nullable(),
  updatedAt: z.number(),
  /** Where the conversation is, for results that arrive outside a turn (P29). */
  lane: z.enum(['owner', 'member']).optional(),
  chat: z
    .object({
      type: z.enum(['dm', 'group']),
      id: z.string(),
      threadId: z.string().optional(),
    })
    .optional(),
})
type StoredConversation = z.infer<typeof conversationSchema>

const pairingBookSchema = z.object({
  requests: z.array(
    z.object({
      id: z.string(),
      userId: z.string(),
      userName: z.string(),
      chatId: z.string(),
      createdAt: z.number(),
      expiresAt: z.number(),
      salt: z.string(),
      hash: z.string(),
    }),
  ),
  asked: z.record(z.string(), z.number()),
  failures: z.number().int().nonnegative(),
  lockedUntil: z.number(),
})

const stateSchema = z.object({
  v: z.literal(1),
  cursors: z.record(
    z.string(),
    z.object({
      offset: z.number().optional(),
      cursor: z.string().optional(),
      contextTokens: z.record(z.string(), z.string()).optional(),
    }),
  ),
  conversations: z.record(z.string(), conversationSchema),
  /** Every console session a chat has used, to its conversation key (`/new` keeps tasks with the chat). */
  sessions: z.record(z.string(), z.string()).default({}),
  /** Pairing requests per channel: salted code hashes, never the codes. */
  pairing: z.record(z.string(), pairingBookSchema).default({}),
})
type StoredState = z.infer<typeof stateSchema>

export interface ConsoleChannelsOptions {
  readonly directory: string
  readonly chat: ChatPort
  readonly accounts?: ConsoleAccounts
  readonly usage?: UsagePort
  readonly tenancy?: TenantPort
  readonly io?: ChannelIo
  readonly now?: () => number
  /** Tests replace the platform adapters. */
  readonly adapter?: (
    channel: {
      readonly platform: ChannelPlatform
      readonly settings: Readonly<Record<string, string>>
    },
    secrets: Readonly<Record<string, string>>,
  ) => ChannelAdapter
  /** Stops a running turn on its node (`/stop`); absent, the gateway only stops waiting. */
  readonly stopTask?: (target: string, taskId: string) => Promise<boolean>
  /** Background tasks (P29): the owner's private chat is a foreground. */
  readonly tasks?: ChannelTasks
  /** How long a turn may take before the gateway gives up waiting. */
  readonly turnTimeoutMs?: number
  /**
   * The paid public edition (P35): no personal QQ. SnowLuma's licence is
   * non-commercial, so the platform is neither offered, saved nor started.
   */
  readonly publicEdition?: boolean
  readonly onError?: (message: string) => void
}

/** Platforms the public edition leaves out. */
const NOT_PUBLIC: ReadonlySet<ChannelPlatform> = new Set(['qq-personal'])

const PAIRING_ANSWER = (code: string) =>
  `你还没有和这个机器人配对。请把配对码 ${formatPairingCode(code)} 发给机器人的主人，批准后就能对话；1 小时内有效。`

/** Hosts where a plain `ws://` token stays off the public internet. */
function privateHost(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || (!host.includes('.') && !host.includes(':')))
    return true
  if (/\.(local|lan|internal|home\.arpa|ts\.net)$/.test(host)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    )
  }
  return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:')
}

/** SnowLuma's address: ws(s) only, no secrets in it, wss off the private network. */
function snowlumaUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('SnowLuma 地址无效')
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:')
    throw new Error('SnowLuma 地址要以 ws:// 或 wss:// 开头')
  if (url.username || url.password || url.searchParams.has('access_token'))
    throw new Error('令牌填在 OneBot 访问令牌里，不要写进地址')
  if (url.protocol === 'ws:' && !privateHost(url.hostname))
    throw new Error('公网上的 SnowLuma 要用 wss://，否则令牌会明文传输')
  url.hash = ''
  return url.toString()
}

/** What channels need of the hub's background tasks (`consoleTasks.ts`). */
export interface ChannelTasks {
  contextFor(sessionId: string, since?: number): string | undefined
  /** Once after a long foreground turn: hand long work to a task (保持空闲). */
  reminderFor?(sessionId: string): Promise<string | undefined>
  statusText(
    sessionId: string,
    options?: { readonly busy?: boolean },
  ): string | undefined
  cancelForSession(sessionId: string): Promise<number>
  onFinished(
    listener: (event: {
      readonly parentSession: string
      readonly text: string
    }) => Promise<boolean | undefined>,
    key?: string,
  ): () => void
  /** Delivers results that could not reach a chat before (it is up now). */
  retryNotifications?(only?: (parentSession: string) => boolean): void
}

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}
function fail<T>(
  code: 'invalid' | 'not_found' | 'unreachable' | 'refused',
  message: string,
): ConsoleResult<T> {
  return { ok: false, failure: { code, message } }
}

function cleanList(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 200)
    throw new Error(`${field}最多 200 项`)
  return [
    ...new Set(
      value.map(item => {
        const entry = String(item).trim()
        if (entry === '' || entry.length > 128 || /\s/.test(entry))
          throw new Error(`${field}含无效项`)
        return entry
      }),
    ),
  ]
}

function address(raw: unknown, field: string): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (parseAddress(value) === null)
    throw new Error(`${field}不是有效的智能体地址`)
  return value
}

interface Running {
  readonly adapter: ChannelAdapter
  readonly channelId: string
}

interface PendingLogin {
  readonly id: string
  readonly draft: ChannelDraft
  readonly actor: string
  qrcode: string
  content: string
  baseUrl: string
  state: ChannelLoginView['state']
  channelId?: string
  detail?: string
  readonly startedAt: number
}

interface ActiveTurn {
  readonly target: string
  taskId: string | null
  cancel: () => void
}

export class ConsoleChannels implements ChannelsPort {
  readonly #options: ConsoleChannelsOptions
  readonly #io: ChannelIo
  readonly #now: () => number
  readonly #bookPath: string
  readonly #statePath: string
  readonly #lock: PrivateInstanceLock | null
  readonly #vault: ConnectorVault
  readonly #channels = new Map<string, StoredChannel>()
  readonly #running = new Map<string, Running>()
  readonly #logins = new Map<string, PendingLogin>()
  readonly #active = new Map<string, ActiveTurn>()
  /**
   * The task note each conversation's session last received, and the one on
   * its way with the turn in flight: a note goes out only when it changed,
   * and counts as received once that turn answered.
   */
  readonly #noted = new Map<string, { text: string; at: number }>()
  readonly #offered = new Map<string, { text: string; at: number }>()
  readonly #gateway: ChannelGateway
  #state: StoredState
  #closed = false
  readonly #unsubscribeTasks: (() => void) | undefined

  constructor(options: ConsoleChannelsOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#io =
      options.io ?? defaultChannelIo(message => options.onError?.(message))
    ensurePrivateDir(options.directory)
    this.#bookPath = path.join(options.directory, 'channels.json')
    this.#statePath = path.join(options.directory, 'state.json')
    this.#lock = acquirePrivateInstanceLock(
      path.join(options.directory, 'instance.lock'),
    )
    if (!this.#lock)
      options.onError?.('渠道目录已由另一实例持有；本实例只读，不连接任何平台')
    const book = readTextIfExists(this.#bookPath)
    const stored =
      book === undefined ? [] : bookSchema.parse(JSON.parse(book)).channels
    this.#vault = new ConnectorVault(
      path.join(options.directory, 'vault.key'),
      stored.flatMap(channel =>
        channel.secret
          ? [{ id: channel.id, secret: channel.secret as ConnectorSecret }]
          : [],
      ),
    )
    for (const channel of stored) this.#channels.set(channel.id, channel)
    const state = readTextIfExists(this.#statePath)
    this.#state =
      state === undefined
        ? { v: 1, cursors: {}, conversations: {}, sessions: {}, pairing: {} }
        : stateSchema.parse(JSON.parse(state))
    this.#unsubscribeTasks = options.tasks?.onFinished(
      event => this.#taskFinished(event),
      'channels',
    )
    this.#gateway = new ChannelGateway({
      turns: this.#turns(),
      ...(options.now === undefined ? {} : { now: options.now }),
      onError: message => options.onError?.(message),
    })
  }

  /** Connects every enabled channel. */
  start(): void {
    if (!this.#lock?.owned()) return
    for (const channel of this.#channels.values())
      if (channel.enabled) this.#launch(channel)
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#unsubscribeTasks?.()
    this.#gateway.close()
    for (const active of this.#active.values()) active.cancel()
    await Promise.allSettled(
      [...this.#running.values()].map(running => running.adapter.stop()),
    )
    this.#running.clear()
    this.#lock?.release()
  }

  // -- persistence ------------------------------------------------------------

  #saveBook(): void {
    writePrivateJson(this.#bookPath, {
      v: 1,
      channels: [...this.#channels.values()],
    })
  }

  #saveState(): void {
    if (!this.#lock?.owned()) return
    try {
      writePrivateJson(this.#statePath, this.#state)
    } catch {
      this.#options.onError?.('渠道状态写入失败')
    }
  }

  #secrets(channel: StoredChannel): Record<string, string> {
    if (channel.secret === null) return {}
    const raw = this.#vault.reveal(
      channel.id,
      channel.secret as ConnectorSecret,
      channel.secret.revision,
    )
    return z.record(z.string(), z.string()).parse(JSON.parse(raw))
  }

  // -- adapters ---------------------------------------------------------------

  #adapter(
    channel: StoredChannel,
    secrets: Readonly<Record<string, string>>,
  ): ChannelAdapter {
    if (this.#options.adapter) return this.#options.adapter(channel, secrets)
    const cursor = this.#state.cursors[channel.id] ?? {}
    const remember = (value: Partial<StoredState['cursors'][string]>) => {
      this.#state.cursors[channel.id] = {
        ...this.#state.cursors[channel.id],
        ...value,
      }
      this.#saveState()
    }
    switch (channel.platform) {
      case 'telegram':
        return new TelegramAdapter(
          {
            token: secrets.token ?? '',
            ...(cursor.offset === undefined ? {} : { offset: cursor.offset }),
            onOffset: offset => remember({ offset }),
          },
          this.#io,
        )
      case 'discord':
        return new DiscordAdapter({ token: secrets.token ?? '' }, this.#io)
      case 'slack':
        return new SlackAdapter(
          {
            appToken: secrets.appToken ?? '',
            botToken: secrets.botToken ?? '',
          },
          this.#io,
        )
      case 'qq-personal':
        return new QqPersonalAdapter(
          {
            url: channel.settings.url ?? '',
            accessToken: secrets.accessToken ?? '',
          },
          this.#io,
        )
      case 'qq':
        return new QqAdapter(
          {
            appId: channel.settings.appId ?? '',
            appSecret: secrets.appSecret ?? '',
          },
          this.#io,
        )
      case 'weixin':
        return new WeixinAdapter(
          {
            accountId: channel.settings.accountId ?? '',
            token: secrets.token ?? '',
            baseUrl: channel.settings.baseUrl ?? ILINK_BASE_URL,
            ...(cursor.cursor === undefined ? {} : { cursor: cursor.cursor }),
            ...(cursor.contextTokens === undefined
              ? {}
              : { contextTokens: cursor.contextTokens }),
            onState: state => remember(state),
          },
          this.#io,
        )
    }
  }

  #launch(channel: StoredChannel): void {
    if (
      this.#closed ||
      !this.#lock?.owned() ||
      this.#running.has(channel.id) ||
      this.#excluded(channel.platform)
    )
      return
    let adapter: ChannelAdapter
    try {
      adapter = this.#adapter(channel, this.#secrets(channel))
    } catch {
      this.#options.onError?.(`渠道 ${channel.id} 的凭据无法读取`)
      return
    }
    this.#running.set(channel.id, { adapter, channelId: channel.id })
    void adapter
      .start(message => {
        const current = this.#channels.get(channel.id)
        if (current === undefined || !current.enabled) return
        this.#gateway.handle(this.#rules(current), adapter, message)
      })
      // Results that found this channel down go out now; other channels'
      // results keep their attempts.
      .then(() =>
        this.#options.tasks?.retryNotifications?.(
          session => this.#rowOf(session)?.channelId === channel.id,
        ),
      )
      .catch(() => this.#options.onError?.(`渠道 ${channel.id} 启动失败`))
  }

  async #halt(id: string): Promise<void> {
    const running = this.#running.get(id)
    this.#running.delete(id)
    await running?.adapter.stop().catch(() => {})
  }

  #excluded(platform: ChannelPlatform): boolean {
    return this.#options.publicEdition === true && NOT_PUBLIC.has(platform)
  }

  /** Whether strangers may ask to pair: switched on, or nobody configured (hermes). */
  #pairingOpen(channel: StoredChannel): boolean {
    const platform = CHANNEL_PLATFORM_VIEWS.find(
      view => view.id === channel.platform,
    )
    if (platform?.pairing !== true) return false
    return (
      channel.pairing ||
      (channel.ownerIds.length === 0 &&
        channel.allowUsers.length === 0 &&
        !channel.allowAll)
    )
  }

  #pairing(channelId: string): ChannelPairing {
    let book = this.#state.pairing[channelId]
    if (book === undefined) {
      book = emptyPairingBook()
      this.#state.pairing[channelId] = book
    }
    return new ChannelPairing(book, this.#now)
  }

  /** A stranger's private message on a pairing channel: a code, or silence. */
  #ask(channelId: string, inbound: ChannelInbound): string | null {
    const channel = this.#channels.get(channelId)
    if (channel === undefined || !this.#pairingOpen(channel)) return null
    const asked = this.#pairing(channelId).ask(
      inbound.userId,
      inbound.userName,
      inbound.chat.id,
    )
    if (asked.kind === 'quiet') return null
    this.#saveState()
    return PAIRING_ANSWER(asked.code)
  }

  /** `/pair <码>` from the owner: the person joins as a member. */
  async #approveByCode(channelId: string, code: string): Promise<string> {
    const channel = this.#channels.get(channelId)
    if (channel === undefined) return '没有这个渠道'
    if (channel.memberTarget === null)
      return '这个渠道没有成员对话的智能体；要把对方设为主人，请在控制台处理。'
    const found = this.#pairing(channelId).redeem(code)
    this.#saveState()
    if (found === 'locked') return '配对码错了太多次，1 小时后再试。'
    if (found === null) return '配对码不对或已过期。'
    await this.#admitPaired(channel, found, 'member')
    return `已批准 ${found.userName}，对方现在可以和成员智能体对话。`
  }

  async #admitPaired(
    channel: StoredChannel,
    request: { readonly userId: string; readonly chatId: string },
    decision: 'owner' | 'member',
  ): Promise<StoredChannel> {
    const updated: StoredChannel = {
      ...channel,
      ...(decision === 'owner'
        ? { ownerIds: [...new Set([...channel.ownerIds, request.userId])] }
        : {
            allowUsers: [...new Set([...channel.allowUsers, request.userId])],
          }),
      updatedAt: this.#now(),
    }
    // Rules are read per message: no reconnect needed.
    this.#channels.set(channel.id, updated)
    this.#saveBook()
    const running = this.#running.get(channel.id)
    if (running !== undefined)
      await this.#gateway
        .post(
          running.adapter,
          { type: 'dm', id: request.chatId },
          '配对已通过，可以开始对话了。',
        )
        .catch(() => false)
    return updated
  }

  #rules(channel: StoredChannel): ChannelRules {
    return {
      id: channel.id,
      pairing: this.#pairingOpen(channel),
      ownerIds: channel.ownerIds,
      members: channel.memberTarget !== null,
      allowAll: channel.allowAll,
      allowUsers: channel.allowUsers,
      allowGroups: channel.allowGroups,
      groupTrigger: channel.groupTrigger,
      replyWindowMs: channel.replyWindowMs,
      ...(channel.prompt ? { prompt: channel.prompt } : {}),
    }
  }

  // -- turns ------------------------------------------------------------------

  #targetOf(conversation: ChannelConversation): string | null {
    const channel = this.#channels.get(conversation.channelId)
    if (channel === undefined) return null
    return conversation.lane === 'owner' ? channel.target : channel.memberTarget
  }

  #conversation(
    conversation: ChannelConversation,
    target: string,
  ): StoredConversation {
    let row = this.#state.conversations[conversation.key]
    if (row === undefined || row.target !== target) {
      row = {
        channelId: conversation.channelId,
        sessionId: null,
        target,
        turns: 0,
        direction: row?.direction ?? null,
        updatedAt: this.#now(),
      }
      this.#state.conversations[conversation.key] = row
    }
    row.lane = conversation.lane
    row.chat = { ...conversation.chat }
    return row
  }

  #dispatch(channel: StoredChannel): ChatDispatch | string {
    const dispatch = ChatDispatch.forSubject(channel.owner, {
      deps: {
        chat: this.#options.chat,
        ...(this.#options.usage === undefined
          ? {}
          : { usage: this.#options.usage }),
        ...(this.#options.tenancy === undefined
          ? {}
          : { tenancy: this.#options.tenancy }),
      },
      accounts: this.#options.accounts,
      now: this.#now(),
      requestId: randomUUID(),
    })
    return dispatch instanceof Response ? '渠道主人的账号已不可用' : dispatch
  }

  /** Opens (or reuses) the conversation's session and sends one line; resolves with the agent's terminal reply. */
  async #exchange(
    conversation: ChannelConversation,
    text: string,
    options: {
      readonly command?: 'compact'
      readonly onNotice?: (text: string) => void
    },
  ): Promise<ChannelTurnResult> {
    const channel = this.#channels.get(conversation.channelId)
    const target = this.#targetOf(conversation)
    if (channel === undefined || target === null)
      return { ok: false, text: '', error: '这个渠道没有可对话的智能体' }
    const dispatch = this.#dispatch(channel)
    if (typeof dispatch === 'string')
      return { ok: false, text: '', error: dispatch }
    const row = this.#conversation(conversation, target)
    const quota = dispatch.preflightUsage(target, row.sessionId)
    if (quota) return refusal(quota)
    const denied = await dispatch.authorizeTarget(target)
    if (denied) return refusal(denied)
    let transcript =
      row.sessionId === null
        ? null
        : await this.#options.chat.transcript(row.sessionId)
    if (
      row.sessionId === null ||
      !transcript?.ok ||
      transcript.value.session.target !== target
    ) {
      const opened = await dispatch.open(target)
      if (opened instanceof Response) return refusal(opened)
      if (!opened.ok) return { ok: false, text: '', error: '没能开启对话' }
      row.sessionId = opened.value.id
      this.#state.sessions[opened.value.id] = conversation.key
      row.turns = 0
      this.#saveState()
      transcript = await this.#options.chat.transcript(row.sessionId)
    } else {
      const claimed = dispatch.claimSession(row.sessionId)
      if (claimed) return refusal(claimed)
    }
    if (!transcript?.ok) return { ok: false, text: '', error: '对话记录不可用' }
    const active: ActiveTurn = { target, taskId: null, cancel: () => {} }
    const turn = sendAndWait({
      chat: this.#options.chat,
      dispatch,
      target,
      input: {
        sessionId: row.sessionId,
        text,
        ...(options.command === undefined ? {} : { command: options.command }),
        ...(row.direction === null ? {} : { direction: row.direction }),
      },
      baseline: new Set(transcript.value.turns.map(one => one.id)),
      now: this.#now,
      timeoutMs: this.#options.turnTimeoutMs ?? 30 * 60_000,
      ...(options.onNotice === undefined ? {} : { onNotice: options.onNotice }),
      onTask: taskId => {
        active.taskId = taskId
      },
    })
    active.cancel = turn.cancel
    this.#active.set(conversation.key, active)
    const outcome = await turn.outcome
    if (this.#active.get(conversation.key) === active)
      this.#active.delete(conversation.key)
    if (outcome.ok) {
      row.turns++
      row.updatedAt = this.#now()
      this.#saveState()
    }
    return outcome
  }

  #turns(): ChannelTurns {
    return {
      run: async (conversation, text, hooks) => {
        const offered = this.#offered.get(conversation.key)
        this.#offered.delete(conversation.key)
        const outcome = await this.#exchange(conversation, text, {
          onNotice: hooks.onNotice,
        })
        if (outcome.compacted) this.#noted.delete(conversation.key)
        else if (outcome.ok && offered !== undefined)
          this.#noted.set(conversation.key, offered)
        return outcome
      },
      sessionOf: conversation =>
        this.#state.conversations[conversation.key]?.sessionId ?? undefined,
      reset: async conversation => {
        this.#noted.delete(conversation.key)
        const row = this.#state.conversations[conversation.key]
        if (row !== undefined) {
          row.sessionId = null
          row.turns = 0
          this.#saveState()
        }
      },
      stop: async (conversation, options = {}) => {
        const session = this.#sessionFor(conversation.key)
        const cancelled =
          !options.tasks || session == null || this.#options.tasks === undefined
            ? 0
            : await this.#options.tasks.cancelForSession(session)
        const active = this.#active.get(conversation.key)
        if (active === undefined) return cancelled > 0
        if (active.taskId !== null && this.#options.stopTask)
          await this.#options
            .stopTask(active.target, active.taskId)
            .catch(() => false)
        active.cancel()
        return true
      },
      context: async conversation => {
        const session = this.#sessionFor(conversation.key)
        const tasks = this.#options.tasks
        if (!this.#foregroundLane(conversation) || tasks === undefined)
          return {}
        const noted = this.#noted.get(conversation.key)
        const at = this.#now()
        const text =
          session == null ? undefined : tasks.contextFor(session, noted?.at)
        const fresh = text === noted?.text ? undefined : text
        if (fresh !== undefined)
          this.#offered.set(conversation.key, { text: fresh, at })
        const reminder =
          session == null ? undefined : await tasks.reminderFor?.(session)
        const note = taskNote(fresh, reminder)
        return {
          sticky: [{ id: 'tasks_rules', text: SUPERVISOR_RULES }],
          ...(note === undefined ? {} : { note }),
        }
      },
      pair: (channelId, inbound) => this.#ask(channelId, inbound),
      approvePairing: (channelId, code) =>
        this.#approveByCode(channelId, code),
      intercept: async conversation => {
        const session = this.#sessionFor(conversation.key)
        if (session == null || !this.#foregroundLane(conversation)) return null
        return (
          this.#options.tasks?.statusText(session, {
            busy: this.#active.has(conversation.key),
          }) ?? null
        )
      },
      compact: async conversation => {
        if (this.#state.conversations[conversation.key]?.sessionId == null)
          return '还没有可压缩的上下文。'
        const result = await this.#exchange(conversation, '/compact', {
          command: 'compact',
        })
        if (result.ok) this.#noted.delete(conversation.key)
        return result.ok
          ? '上下文已压缩。'
          : `压缩失败：${[...(result.error ?? '')].slice(0, 200).join('')}`
      },
      status: async conversation => {
        const row = this.#state.conversations[conversation.key]
        const target = this.#targetOf(conversation)
        const owner = this.#channels.get(conversation.channelId)?.owner
        const cache = owner === undefined ? null : await this.#cacheHit(owner)
        return [
          `智能体：${target ?? '未配置'}`,
          `会话：${row?.sessionId ?? '尚未开始'}`,
          `轮数：${row?.turns ?? 0}`,
          `方向：${row?.direction ?? '默认'}`,
          ...(cache === null ? [] : [`今日缓存命中：${cache}`]),
        ]
      },
      direction: async (conversation, value) => {
        const target = this.#targetOf(conversation)
        if (target === null) return '这个渠道没有可对话的智能体'
        const row = this.#conversation(conversation, target)
        if (value === undefined) return `当前方向：${row.direction ?? '默认'}`
        if (value === null) {
          row.direction = null
          this.#saveState()
          return '已恢复默认方向'
        }
        if (!MODEL_DIRECTIONS.includes(value as ModelDirection))
          return `可选方向：${MODEL_DIRECTIONS.join('、')}，或 default`
        row.direction = value as ModelDirection
        this.#saveState()
        return `这个会话改用「${value}」方向的模型`
      },
    }
  }

  /** Today's prompt-cache hit rate of the channel owner (usage ledger, P18.19); null without data. */
  async #cacheHit(owner: string): Promise<string | null> {
    const usage = this.#options.usage
    if (usage === undefined) return null
    const snapshot = await usage.read(owner).catch(() => null)
    if (snapshot === null) return null
    let read = 0
    let prompt = 0
    for (const row of snapshot.rows) {
      read += row.cacheRead
      prompt += row.input + row.cacheRead + row.cacheWrite
    }
    return prompt === 0 ? null : `${Math.round((read / prompt) * 100)}%`
  }

  /** The owner's private chat: the conversation that may run background tasks. */
  #foregroundLane(conversation: {
    readonly lane?: string
    readonly chat?: { readonly type: string }
  }): boolean {
    return conversation.lane === 'owner' && conversation.chat?.type === 'dm'
  }

  /**
   * The chat's session for its tasks: the current one, or after `/new` and
   * before the next turn opens one, the last it had (tasks follow the chat).
   */
  #sessionFor(key: string): string | undefined {
    const current = this.#state.conversations[key]?.sessionId
    if (current != null) return current
    return Object.entries(this.#state.sessions)
      .filter(([, owner]) => owner === key)
      .at(-1)?.[0]
  }

  #rowOf(sessionId: string): StoredConversation | undefined {
    const key = this.#state.sessions[sessionId]
    return key === undefined ? undefined : this.#state.conversations[key]
  }

  /** False for a channel conversation that may not start background tasks. */
  foreground(sessionId: string): boolean {
    const row = this.#rowOf(sessionId)
    return row === undefined || this.#foregroundLane(row)
  }

  /** Every session the same chat has used, so tasks outlive `/new`. */
  related(sessionId: string): readonly string[] {
    const key = this.#state.sessions[sessionId]
    if (key === undefined) return [sessionId]
    return Object.entries(this.#state.sessions)
      .filter(([, owner]) => owner === key)
      .map(([session]) => session)
  }

  /** A background task's result, sent to the chat its conversation lives in. */
  async #taskFinished(event: {
    readonly parentSession: string
    readonly text: string
  }): Promise<boolean | undefined> {
    const row = this.#rowOf(event.parentSession)
    if (row === undefined) return undefined
    const running = this.#running.get(row.channelId)
    if (running === undefined || row.chat === undefined) return false
    return this.#gateway.post(running.adapter, row.chat, event.text)
  }

  // -- ChannelsPort -----------------------------------------------------------

  #view(channel: StoredChannel): ChannelView {
    const running = this.#running.get(channel.id)
    return {
      id: channel.id,
      name: channel.name,
      platform: channel.platform,
      enabled: channel.enabled,
      target: channel.target,
      memberTarget: channel.memberTarget,
      ownerIds: channel.ownerIds,
      allowAll: channel.allowAll,
      allowUsers: channel.allowUsers,
      allowGroups: channel.allowGroups,
      groupTrigger: channel.groupTrigger,
      replyWindowMs: channel.replyWindowMs,
      prompt: channel.prompt,
      pairing: channel.pairing,
      pairingOpen: this.#pairingOpen(channel),
      pairingRequests: (this.#state.pairing[channel.id] === undefined
        ? []
        : this.#pairing(channel.id).pending()
      ).map(request => ({
        id: request.id,
        userId: request.userId,
        userName: request.userName,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      })),
      settings: channel.settings,
      secretSet: channel.secret !== null,
      health: running?.adapter.health() ?? this.#idleHealth(channel),
      conversations: Object.values(this.#state.conversations).filter(
        row => row.channelId === channel.id,
      ).length,
      evaluated: false,
      owner: channel.owner,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    }
  }

  #idleHealth(channel: StoredChannel): ChannelView['health'] {
    if (channel.enabled && this.#excluded(channel.platform))
      return {
        state: 'failed',
        since: channel.updatedAt,
        detail: '公开版不提供个人 QQ',
      }
    const held = channel.enabled && !this.#lock?.owned()
    return {
      state: held ? 'failed' : 'stopped',
      since: channel.updatedAt,
      ...(held ? { detail: '另一控制台实例持有渠道' } : {}),
    }
  }

  async snapshot(): Promise<ConsoleResult<ChannelsSnapshot>> {
    const targets = await this.#options.chat.targets()
    return ok({
      channels: [...this.#channels.values()].map(channel =>
        this.#view(channel),
      ),
      platforms: CHANNEL_PLATFORM_VIEWS.filter(
        view => !this.#excluded(view.id),
      ),
      agents: targets.ok
        ? targets.value.filter(row => row.dialable).map(row => row.address)
        : [],
    })
  }

  /** Validates a draft into a stored channel; `secrets` merge over the old ones. */
  #build(
    draft: ChannelDraft,
    actor: DirectionActor,
    previous: StoredChannel | undefined,
    credentials?: {
      readonly settings: Record<string, string>
      readonly secrets: Record<string, string>
    },
  ): StoredChannel {
    if (!isChannelPlatform(draft.platform) || this.#excluded(draft.platform))
      throw new Error('不支持的平台')
    if (previous && previous.platform !== draft.platform)
      throw new Error('渠道平台不能修改')
    const platform = CHANNEL_PLATFORM_VIEWS.find(
      view => view.id === draft.platform,
    )!
    const name = String(draft.name ?? '').trim()
    if (name === '' || [...name].length > 60)
      throw new Error('名称需要 1–60 个字')
    const replyWindowMs = Number(
      draft.replyWindowMs ?? previous?.replyWindowMs ?? 0,
    )
    if (
      !Number.isInteger(replyWindowMs) ||
      replyWindowMs < 0 ||
      replyWindowMs > 60_000
    )
      throw new Error('回复窗口需在 0–60000 毫秒之间')
    const prompt = String(draft.prompt ?? previous?.prompt ?? '').trim()
    if (prompt.length > 4_000) throw new Error('渠道说明最多 4000 字')
    const settings: Record<string, string> = {
      ...previous?.settings,
      ...credentials?.settings,
    }
    for (const field of platform.settings) {
      const value = draft.settings?.[field.key]
      if (value !== undefined) settings[field.key] = String(value).trim()
      if (!settings[field.key]) throw new Error(`缺少${field.label}`)
    }
    const ownerIds = cleanList(
      draft.ownerIds ?? previous?.ownerIds,
      '主人用户号',
    )
    if (draft.platform === 'qq-personal') {
      settings.url = snowlumaUrl(settings.url ?? '')
      // A personal account answers only people the owner named: no
      // pairing replies to strangers from someone's own QQ.
      if (ownerIds.length === 0) throw new Error('个人 QQ 需要填主人的 QQ 号')
      if (ownerIds.some(id => !/^\d{5,12}$/.test(id)))
        throw new Error('主人的 QQ 号只能是数字')
    }
    let secrets = previous ? this.#secrets(previous) : {}
    const supplied = { ...credentials?.secrets }
    for (const field of platform.secrets) {
      const value = draft.secrets?.[field.key]
      if (typeof value === 'string' && value.trim() !== '')
        supplied[field.key] = value.trim()
    }
    secrets = { ...secrets, ...supplied }
    for (const field of platform.secrets)
      if (!secrets[field.key]) throw new Error(`缺少${field.label}`)
    if (platform.qrLogin && !secrets.token) throw new Error('请先扫码登录')
    const id = previous?.id ?? `ch-${randomUUID()}`
    const now = this.#now()
    const revision = (previous?.secret?.revision ?? 0) + 1
    const secret =
      Object.keys(supplied).length > 0 || previous?.secret == null
        ? Object.keys(secrets).length === 0
          ? null
          : this.#vault.seal(
              id,
              'password',
              revision,
              JSON.stringify(secrets),
              now,
            )
        : previous.secret
    const memberRaw =
      draft.memberTarget === undefined
        ? previous?.memberTarget
        : draft.memberTarget
    return {
      id,
      name,
      platform: draft.platform,
      enabled: draft.enabled ?? previous?.enabled ?? true,
      owner: previous?.owner ?? actor.subject,
      target: address(draft.target ?? previous?.target, '主人对话的智能体'),
      memberTarget:
        memberRaw === null || memberRaw === undefined || memberRaw === ''
          ? null
          : address(memberRaw, '成员对话的智能体'),
      ownerIds,
      allowAll: draft.allowAll ?? previous?.allowAll ?? false,
      allowUsers: cleanList(
        draft.allowUsers ?? previous?.allowUsers,
        '允许的用户',
      ),
      allowGroups: cleanList(
        draft.allowGroups ?? previous?.allowGroups,
        '允许的群',
      ),
      groupTrigger:
        draft.groupTrigger === 'all'
          ? 'all'
          : draft.groupTrigger === 'mention'
            ? 'mention'
            : (previous?.groupTrigger ?? 'mention'),
      replyWindowMs,
      prompt,
      pairing: platform.pairing && (draft.pairing ?? previous?.pairing ?? false),
      settings,
      secret: secret as StoredChannel['secret'],
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
  }

  async #commit(channel: StoredChannel): Promise<ChannelView> {
    await this.#halt(channel.id)
    this.#channels.set(channel.id, channel)
    this.#saveBook()
    if (channel.enabled) this.#launch(channel)
    return this.#view(channel)
  }

  async save(
    draft: ChannelDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ChannelView>> {
    if (!this.#lock?.owned())
      return fail('refused', '渠道目录由另一控制台实例持有')
    const previous =
      draft.id === undefined ? undefined : this.#channels.get(draft.id)
    if (draft.id !== undefined && previous === undefined)
      return fail('not_found', '没有这个渠道')
    let channel: StoredChannel
    try {
      channel = this.#build(draft, actor, previous)
    } catch (error) {
      return fail(
        'invalid',
        error instanceof Error ? error.message : '渠道配置无效',
      )
    }
    return ok(await this.#commit(channel))
  }

  async remove(id: string): Promise<ConsoleResult<null>> {
    if (!this.#lock?.owned())
      return fail('refused', '渠道目录由另一控制台实例持有')
    if (!this.#channels.has(id)) return fail('not_found', '没有这个渠道')
    await this.#halt(id)
    this.#channels.delete(id)
    delete this.#state.cursors[id]
    delete this.#state.pairing[id]
    for (const [key, row] of Object.entries(this.#state.conversations))
      if (row.channelId === id) {
        delete this.#state.conversations[key]
        for (const [session, owner] of Object.entries(this.#state.sessions))
          if (owner === key) delete this.#state.sessions[session]
      }
    this.#saveBook()
    this.#saveState()
    return ok(null)
  }

  async pair(
    channelId: string,
    requestId: string,
    decision: ChannelPairingDecision,
  ): Promise<ConsoleResult<ChannelView>> {
    if (!this.#lock?.owned())
      return fail('refused', '渠道目录由另一控制台实例持有')
    const channel = this.#channels.get(channelId)
    if (channel === undefined) return fail('not_found', '没有这个渠道')
    if (decision === 'member' && channel.memberTarget === null)
      return fail('invalid', '这个渠道没有成员对话的智能体')
    const request = this.#pairing(channelId).take(requestId)
    if (request === null) return fail('not_found', '这条配对请求已过期或已处理')
    this.#saveState()
    if (decision === 'deny') return ok(this.#view(channel))
    return ok(this.#view(await this.#admitPaired(channel, request, decision)))
  }

  #loginView(login: PendingLogin): ChannelLoginView {
    return {
      loginId: login.id,
      state: login.state,
      qr: login.content,
      ...(login.channelId === undefined ? {} : { channelId: login.channelId }),
      ...(login.detail === undefined ? {} : { detail: login.detail }),
    }
  }

  async login(
    draft: ChannelDraft,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ChannelLoginView>> {
    if (!this.#lock?.owned())
      return fail('refused', '渠道目录由另一控制台实例持有')
    if (draft.platform !== 'weixin')
      return fail('invalid', '只有微信需要扫码登录')
    if (draft.id !== undefined && !this.#channels.has(draft.id))
      return fail('not_found', '没有这个渠道')
    for (const [id, login] of this.#logins)
      if (this.#now() - login.startedAt > 15 * 60_000) this.#logins.delete(id)
    let qr
    try {
      qr = await weixinQrStart(this.#io)
    } catch (error) {
      return fail(
        'unreachable',
        error instanceof Error ? error.message : '微信登录二维码获取失败',
      )
    }
    const login: PendingLogin = {
      id: randomUUID(),
      draft,
      actor: actor.subject,
      qrcode: qr.qrcode,
      content: qr.content,
      baseUrl: ILINK_BASE_URL,
      state: 'wait',
      startedAt: this.#now(),
    }
    this.#logins.set(login.id, login)
    void this.#watchLogin(login, actor).catch(() => {
      login.state = 'failed'
    })
    return ok(this.#loginView(login))
  }

  async loginStatus(
    loginId: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<ChannelLoginView>> {
    const login = this.#logins.get(loginId)
    if (login === undefined || login.actor !== actor.subject)
      return fail('not_found', '没有这次登录')
    return ok(this.#loginView(login))
  }

  async loginQr(
    loginId: string,
    actor: DirectionActor,
  ): Promise<ConsoleResult<string>> {
    const login = this.#logins.get(loginId)
    if (login === undefined || login.actor !== actor.subject)
      return fail('not_found', '没有这次登录')
    return ok(login.content)
  }

  /** Polls WeChat until the scan is confirmed, refreshing an expired code up to three times. */
  async #watchLogin(login: PendingLogin, actor: DirectionActor): Promise<void> {
    let refreshes = 0
    while (!this.#closed && this.#now() - login.startedAt < 10 * 60_000) {
      if (this.#logins.get(login.id) !== login) return
      let status
      try {
        status = await weixinQrPoll(this.#io, login.qrcode, login.baseUrl)
      } catch (error) {
        login.state = 'failed'
        login.detail = error instanceof Error ? error.message : '微信登录失败'
        return
      }
      if (status.state === 'confirmed') {
        const previous =
          login.draft.id === undefined
            ? undefined
            : this.#channels.get(login.draft.id)
        try {
          const ownerIds = new Set([
            ...(login.draft.ownerIds ?? previous?.ownerIds ?? []),
            ...(status.userId ? [status.userId] : []),
          ])
          const channel = this.#build(
            { ...login.draft, ownerIds: [...ownerIds] },
            actor,
            previous,
            {
              settings: {
                accountId: status.accountId,
                baseUrl: status.baseUrl,
              },
              secrets: { token: status.token },
            },
          )
          // A new bot account starts its long poll afresh.
          if (previous?.settings.accountId !== status.accountId)
            delete this.#state.cursors[channel.id]
          await this.#commit(channel)
          login.channelId = channel.id
          login.state = 'confirmed'
        } catch (error) {
          login.state = 'failed'
          login.detail = error instanceof Error ? error.message : '渠道配置无效'
        }
        return
      }
      if (status.baseUrl) login.baseUrl = status.baseUrl
      if (status.state === 'expired') {
        if (++refreshes > 3) {
          login.state = 'expired'
          return
        }
        try {
          const qr = await weixinQrStart(this.#io)
          login.qrcode = qr.qrcode
          login.content = qr.content
          login.baseUrl = ILINK_BASE_URL
          login.state = 'wait'
        } catch {
          login.state = 'expired'
          return
        }
      } else login.state = status.state
      await this.#io.sleep(1_000)
    }
    if (login.state !== 'confirmed') login.state = 'expired'
  }
}
