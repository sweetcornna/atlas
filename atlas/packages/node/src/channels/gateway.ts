// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat messages → agent turns → replies (P28, `runtimes-channels.md` §2.3).
 *
 * Ported from grantley's `gateway/core.py`. One turn runs per conversation at
 * a time. Messages that arrive while it runs are queued: a private chat folds
 * everything queued into one follow-up turn; a group keeps one entry per
 * sender, in the order each sender first queued, so a burst of chatter costs
 * one turn per person rather than one per line, and nobody waits behind
 * someone else's follow-up details.
 *
 * Context that rarely changes (how this chat works, the operator's channel
 * prompt) is sticky: a conversation gets it on its first turn, again when it
 * changed, after `/new` or a compaction, and every `stickyRefreshTurns`
 * turns (P30).
 */

import { createHash } from 'node:crypto'
import { extractMedia, isSilence, splitMessage } from './text.js'
import type {
  ChannelAdapter,
  ChannelChat,
  ChannelInbound,
  ChannelPlatform,
  ChannelSendOptions,
  ChannelSendResult,
} from './types.js'

export type ChannelLane = 'owner' | 'member'

/** Who a binding answers and how. */
export interface ChannelRules {
  readonly id: string
  /** The owner's own ids on this platform; their private chat is the owner lane. */
  readonly ownerIds: readonly string[]
  /** Non-owners are answered only when the binding names a member agent. */
  readonly members: boolean
  readonly allowAll: boolean
  readonly allowUsers: readonly string[]
  readonly allowGroups: readonly string[]
  /** In groups: answer only when addressed (`mention`) or every message. */
  readonly groupTrigger: 'mention' | 'all'
  /** Collect one sender's consecutive messages for this long before a turn. */
  readonly replyWindowMs: number
  /** Fixed framing the operator wrote for this channel; sticky. */
  readonly prompt?: string
  /**
   * Strangers who write privately get a pairing answer from the hub instead
   * of silence (hermes pairing); the owner approves them.
   */
  readonly pairing?: boolean
}

export interface ChannelConversation {
  /** `<channel>:<dm|group>:<chat>[:<thread>]`; one long-lived session each. */
  readonly key: string
  readonly channelId: string
  readonly platform: ChannelPlatform
  readonly lane: ChannelLane
  readonly chat: ChannelChat
  readonly chatName?: string
}

export interface ChannelTurnResult {
  readonly ok: boolean
  readonly text: string
  readonly error?: string
  readonly cancelled?: boolean
  readonly timedOut?: boolean
  /** The runtime compacted its context during this turn. */
  readonly compacted?: boolean
}

/** Runs turns for the gateway; the hub implements it over its chat face. */
export interface ChannelTurns {
  run(
    conversation: ChannelConversation,
    text: string,
    hooks: { readonly onNotice: (text: string) => void },
  ): Promise<ChannelTurnResult>
  /** The conversation's current session, if it has one. */
  sessionOf(conversation: ChannelConversation): string | undefined
  /** `/new`: the next turn opens a new session. */
  reset(conversation: ChannelConversation): Promise<void>
  /**
   * Stops the running turn and, with `tasks` (`/stop`), the chat's background
   * tasks; `/new` stops only the turn, the tasks follow the chat. False when
   * nothing ran.
   */
  stop(
    conversation: ChannelConversation,
    options?: { readonly tasks?: boolean },
  ): Promise<boolean>
  compact(conversation: ChannelConversation): Promise<string>
  status(conversation: ChannelConversation): Promise<readonly string[]>
  /** `/model`: shows (undefined), sets, or clears (null) this chat's direction. */
  direction(
    conversation: ChannelConversation,
    value: string | null | undefined,
  ): Promise<string>
  /**
   * More context for this turn: sticky blocks (resent only when changed) and
   * a note for this turn only, e.g. the background-task rules and summary.
   * May have to read the conversation first (the long-turn reminder).
   */
  context?(
    conversation: ChannelConversation,
  ): ChannelTurnContext | Promise<ChannelTurnContext>
  /**
   * Answers an owner's short status question ("进度怎么样了") without a turn;
   * null lets the message through as usual (grantley `intercept`).
   */
  intercept?(
    conversation: ChannelConversation,
    text: string,
  ): Promise<string | null>
  /**
   * A private message from someone a pairing channel does not know: the
   * answer to send them (a pairing code), or null to stay silent.
   */
  pair?(
    channelId: string,
    inbound: ChannelInbound,
  ): string | null | Promise<string | null>
  /** `/pair <码>` from the owner: approves that request; the answer to show. */
  approvePairing?(channelId: string, code: string): Promise<string>
}

interface ChannelTurnContext {
  readonly sticky?: readonly StickyPart[]
  readonly note?: string
}

/** Short progress questions and nudges (grantley `tasks._QUERY`, `_NUDGE`). */
const STATUS_QUERY = new RegExp(
  '^(?:' +
    '(?:(?:你|你们)[，,\\s]*)?' +
    '(?:(?:现在|目前)[，,\\s]*)?' +
    '(?:(?:这个任务|那个任务|当前任务|后台任务|任务)[，,\\s]*)?' +
    '(?:(?:现在|目前|到底|还)[，,\\s]*)?' +
    '(?:' +
    '(?:什么|啥)?(?:进度|进展)(?:(?:到哪(?:一步)?|怎么样|如何|怎样)(?:了|啦)?|呢|吗|了)?|' +
    '有(?:新)?(?:进度|进展)(?:了)?(?:吗|没|没有)?|' +
    '(?:做|进行|执行)?到哪(?:一步)?(?:了|啦)?|' +
    '(?:做完|完成|做好)(?:了)?(?:吗|没|没有)|' +
    '(?:怎么样|如何)了|' +
    '在(?:做|干)(?:什么|啥|嘛)(?:呢)?|' +
    '在(?:做|跑|运行|执行|工作|忙)(?:吗|没|呢)|' +
    '(?:卡住|停止|停下)(?:了)?(?:吗|没|没有)|' +
    '怎么(?:不动|停下|停止)(?:了)?|' +
    '(?:还要)?多久(?:能|才)?(?:完成|做完|做好)?|' +
    '好了(?:吗|没)' +
    ')' +
    '|(?:any\\s+)?(?:status|progress|updates?)(?:\\s+(?:update|on\\s+(?:the\\s+)?task))?' +
    ')[？?！!。\\s]*$',
  'i',
)
const NUDGE = /^(?:快点|加油|催一下|好了没|好了吗)[！!？?。\s]*$/

/** The whole message is a progress question or a nudge. */
export function isStatusQuery(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.startsWith('/') || trimmed.length > 160)
    return false
  return STATUS_QUERY.test(trimmed) || NUDGE.test(trimmed)
}

/** One accepted message, or several folded into one. */
interface ChannelEvent {
  readonly conversation: ChannelConversation
  readonly inbound: ChannelInbound
  readonly fromOwner: boolean
  /** Lines already carry `[name(id)]` prefixes. */
  readonly prefixed: boolean
  readonly merged: number
  /** The platform message ids folded into this event. */
  readonly ids: readonly string[]
}

const PLATFORM_NAMES: Record<ChannelPlatform, string> = {
  qq: 'QQ',
  'qq-personal': 'QQ',
  weixin: '微信',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
}

const FORMAT_HINTS: Record<ChannelPlatform, string> = {
  qq: 'QQ 按纯文本显示，不要用 Markdown 表格和标题',
  'qq-personal':
    'QQ 按纯文本显示，不要用 Markdown 表格和标题；像人聊天一样简短，很长的内容会折成一张聊天记录卡片',
  weixin: '微信按纯文本显示，不要用 Markdown 表格和标题，每段不要太长',
  telegram: '可以用常见 Markdown（粗体、代码、链接）',
  discord: '可以用 Markdown',
  slack: '可以用常见 Markdown，会转成 Slack 的格式',
}

/**
 * Group chatter an addressed turn sees (hermes `channel_context`, its
 * OneBot `reply_context.py`): in a room the message that names the bot is
 * usually the last of an exchange. Lines are kept in memory only, per room,
 * and each is shown to the agent at most once.
 */
const CONTEXT_LINES = 12
const CONTEXT_LINE_CHARS = 200
const CONTEXT_KEEP = 50
const CONTEXT_MAX_AGE_MS = 2 * 60 * 60_000
const CONTEXT_ROOMS = 500

interface RoomLine {
  readonly id: string
  readonly at: number
  readonly line: string
  shown: boolean
}

/** Sends a chunk again after a throttle or a transient failure (hermes send retry). */
const SEND_ATTEMPTS = 3
const SEND_BACKOFF_MS = [2_000, 4_000]
/** A platform asking for a longer pause than this is not slept through. */
const SEND_MAX_WAIT_MS = 60_000
/** Chunks one reply may take; the rest stays on the console (hermes Discord `MAX_SPLIT_MESSAGES`). */
const MAX_CHUNKS = 8
const TRUNCATED = '（回复太长，后面的部分没有发出，完整内容在控制台对话页。）'

/**
 * A message as long as the client's own split is probably the first piece
 * of a long paste: wait for the rest before starting a turn (hermes text
 * batching, `_SPLIT_THRESHOLD`).
 */
const SPLIT_WAIT_MS = 1_000
const SPLIT_WAIT_CAP_MS = 4_000

/**
 * Turns one group room may start in five minutes before it is paused
 * (hermes `bot_loop_guard`): two bots answering each other never stop.
 */
const ROOM_TURNS = 20
const ROOM_WINDOW_MS = 5 * 60_000
const ROOM_PAUSE_MS = 10 * 60_000

/** How long a message id is remembered against redelivery (hermes `MessageDeduplicator`). */
const DEDUP_MS = 300_000
/** Threads per adapter the bot is known to take part in. */
const THREADS_KEPT = 2_000

interface ReplyWindow {
  timer: ReturnType<typeof setTimeout>
  readonly opened: number
  readonly fire: () => void
}

function senderKey(event: ChannelEvent): string | null {
  return event.conversation.chat.type === 'group' ? event.inbound.userId : null
}

function identity(inbound: ChannelInbound): string {
  const who = inbound.userName || inbound.userId || '群友'
  return inbound.userId && who !== inbound.userId
    ? `${who}(${inbound.userId})`
    : who
}

/** Folds queued events into one turn, keeping each speaker visible. */
function mergeEvents(events: readonly ChannelEvent[]): ChannelEvent {
  if (events.length === 1) return events[0]!
  const last = events[events.length - 1]!
  const group = last.conversation.chat.type === 'group'
  const lines: string[] = []
  const attachments: { name: string; kind: string }[] = []
  for (const event of events) {
    let text = event.inbound.text.trim()
    if (group && !event.prefixed) text = `[${identity(event.inbound)}] ${text}`
    if (text) lines.push(text)
    attachments.push(...(event.inbound.attachments ?? []))
  }
  return {
    conversation: last.conversation,
    inbound: {
      ...last.inbound,
      text: lines.join('\n'),
      ...(attachments.length === 0 ? {} : { attachments }),
    },
    fromOwner: events.some(event => event.fromOwner),
    prefixed: group || last.prefixed,
    merged: events.reduce((sum, event) => sum + event.merged, 0),
    ids: events.flatMap(event => event.ids),
  }
}

class Pending {
  events: ChannelEvent[] = []

  add(event: ChannelEvent): void {
    const sender = senderKey(event)
    if (sender !== null) {
      const index = this.events.findIndex(
        queued => senderKey(queued) === sender,
      )
      if (index !== -1) {
        // Keep the sender's original place: new details cannot make another
        // member wait behind them.
        this.events[index] = mergeEvents([this.events[index]!, event])
        return
      }
    }
    this.events.push(event)
  }

  take(): ChannelEvent {
    if (this.events[0]!.conversation.chat.type === 'group')
      return this.events.shift()!
    const events = this.events
    this.events = []
    return mergeEvents(events)
  }
}

interface StickyState {
  generation: number
  session: string | undefined
  seen: Map<string, string>
  turns: number
}

export interface StickyPart {
  readonly id: string
  readonly text: string
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** Which sticky blocks each conversation already holds, by fingerprint. */
class StickyContext {
  readonly #state = new Map<string, StickyState>()
  readonly #refresh: number

  constructor(refreshTurns: number) {
    this.#refresh = refreshTurns
  }

  filter(
    key: string,
    generation: number,
    session: string | undefined,
    parts: readonly StickyPart[],
  ): { texts: string[]; marks: Map<string, string> } {
    let state = this.#state.get(key)
    if (
      state === undefined ||
      state.generation !== generation ||
      session === undefined ||
      state.session !== session ||
      (this.#refresh > 0 && state.turns >= this.#refresh)
    ) {
      state = { generation, session, seen: new Map(), turns: 0 }
      this.#state.set(key, state)
    }
    const texts: string[] = []
    const marks = new Map<string, string>()
    for (const part of parts) {
      const print = fingerprint(part.text)
      if (state.seen.get(part.id) === print) continue
      texts.push(part.text)
      marks.set(part.id, print)
    }
    return { texts, marks }
  }

  /** A block counts as delivered only once its turn succeeded. */
  commit(
    key: string,
    marks: ReadonlyMap<string, string>,
    result: ChannelTurnResult,
    session: string | undefined,
  ): void {
    const state = this.#state.get(key)
    if (state === undefined) return
    if (result.compacted) {
      // The summary may have dropped what earlier turns carried.
      this.#state.delete(key)
      return
    }
    if (!result.ok) return
    if (state.session === undefined) state.session = session
    for (const [id, print] of marks) state.seen.set(id, print)
    state.turns++
  }

  forget(key: string): void {
    this.#state.delete(key)
  }
}

export interface ChannelGatewayOptions {
  readonly turns: ChannelTurns
  readonly now?: () => number
  /** Waits between send attempts; tests record them instead. */
  readonly sleep?: (ms: number) => Promise<void>
  /** How often a running turn refreshes the platform's typing indicator. */
  readonly typingIntervalMs?: number
  readonly stickyRefreshTurns?: number
  readonly onError?: (message: string) => void
}

const COMMANDS = new Set([
  'new',
  'reset',
  'clear',
  'stop',
  'status',
  'model',
  'compact',
  'help',
  'pair',
])
const HELP =
  '/new 新会话 · /stop 停止 · /status 状态 · /model [方向|default] · /compact 压缩上下文'
const HELP_PAIR = ' · /pair 码 批准配对'

export function conversationKey(channelId: string, chat: ChannelChat): string {
  return [
    channelId,
    chat.type,
    chat.id,
    ...(chat.threadId ? [chat.threadId] : []),
  ].join(':')
}

export class ChannelGateway {
  readonly #turns: ChannelTurns
  readonly #now: () => number
  readonly #sleep: (ms: number) => Promise<void>
  readonly #typingMs: number
  readonly #onError: ((message: string) => void) | undefined
  readonly #sticky: StickyContext
  readonly #pending = new Map<string, Pending>()
  readonly #active = new Map<string, Promise<void>>()
  readonly #windows = new Map<string, ReplyWindow>()
  readonly #generations = new Map<string, number>()
  readonly #seen = new Map<string, number>()
  /** Recent lines per group room (`<channel>:<chat>`), for addressed turns. */
  readonly #rooms = new Map<string, RoomLine[]>()
  /** Turn starts per room in the last five minutes, and paused rooms. */
  readonly #roomTurns = new Map<string, number[]>()
  readonly #roomPauses = new Map<string, number>()
  /** When each chat last got a send, per adapter, for `sendGapMs`. */
  readonly #lastSends = new WeakMap<ChannelAdapter, Map<string, number>>()
  /** Threads the bot answered in, per adapter, for `followsThreads`. */
  readonly #followed = new WeakMap<ChannelAdapter, Set<string>>()
  #closed = false

  constructor(options: ChannelGatewayOptions) {
    this.#turns = options.turns
    this.#now = options.now ?? Date.now
    this.#sleep =
      options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.#typingMs = options.typingIntervalMs ?? 4_500
    this.#sticky = new StickyContext(options.stickyRefreshTurns ?? 40)
    this.#onError = options.onError
  }

  /** Whether a turn is running or queued for this conversation. */
  busy(key: string): boolean {
    return (
      this.#active.has(key) || (this.#pending.get(key)?.events.length ?? 0) > 0
    )
  }

  /** Settles when every running conversation loop has ended. */
  async idle(): Promise<void> {
    while (this.#active.size > 0)
      await Promise.allSettled([...this.#active.values()])
  }

  close(): void {
    this.#closed = true
    for (const window of this.#windows.values()) clearTimeout(window.timer)
    this.#windows.clear()
    this.#pending.clear()
  }

  /** Entry point for adapters: returns at once, the turn runs in the background. */
  handle(
    rules: ChannelRules,
    adapter: ChannelAdapter,
    inbound: ChannelInbound,
  ): void {
    if (
      this.#closed ||
      this.#duplicate(
        rules.id,
        inbound.messageId,
        adapter.dedupTtlMs ?? DEDUP_MS,
      )
    )
      return
    const event = this.#admit(rules, adapter, inbound)
    if (event === 'pair') {
      void this.#pair(rules, adapter, inbound).catch(error =>
        this.#onError?.(
          `渠道 ${rules.id} 配对失败：${String((error as Error)?.message ?? error)}`,
        ),
      )
      return
    }
    if (event === null) return
    void this.#dispatch(rules, adapter, event).catch(error =>
      this.#onError?.(
        `渠道 ${rules.id} 处理消息失败：${String((error as Error)?.message ?? error)}`,
      ),
    )
  }

  /** Remembers each id until its time is up (the adapter's, else five minutes). */
  #duplicate(channelId: string, messageId: string, ttlMs: number): boolean {
    const now = this.#now()
    const key = `${channelId}:${messageId}`
    if (this.#seen.size > 2_000)
      for (const [seen, until] of this.#seen)
        if (until <= now) this.#seen.delete(seen)
    const until = this.#seen.get(key)
    if (until !== undefined && until > now) return true
    this.#seen.delete(key)
    this.#seen.set(key, now + ttlMs)
    return false
  }

  /** Who may talk here and on which lane; null drops the message, `pair` asks the hub. */
  #admit(
    rules: ChannelRules,
    adapter: ChannelAdapter,
    message: ChannelInbound,
  ): ChannelEvent | 'pair' | null {
    let inbound = message
    const fromOwner = rules.ownerIds.includes(inbound.userId)
    let lane: ChannelLane
    if (inbound.chat.type === 'dm') {
      if (fromOwner) lane = 'owner'
      else if (
        rules.members &&
        (rules.allowAll || rules.allowUsers.includes(inbound.userId))
      )
        lane = 'member'
      else
        return rules.pairing === true && this.#turns.pair !== undefined
          ? 'pair'
          : null
    } else {
      if (!rules.allowAll && !rules.allowGroups.includes(inbound.chat.id))
        return null
      // Everything said in an allowed room is context for the next turn
      // that is meant for the bot, answered or not.
      this.#remember(rules.id, inbound)
      // A thread the bot answered in is a conversation with it (hermes,
      // Slack): no mention needed there.
      if (!inbound.addressed && this.#follows(adapter, inbound.chat))
        inbound = { ...inbound, addressed: true }
      if (rules.groupTrigger === 'mention' && !inbound.addressed) return null
      if (!fromOwner && !rules.members) return null
      lane = rules.members ? 'member' : 'owner'
    }
    return {
      conversation: {
        key: conversationKey(rules.id, inbound.chat),
        channelId: rules.id,
        platform: adapter.platform,
        lane,
        chat: inbound.chat,
        ...(inbound.chatName === undefined
          ? {}
          : { chatName: inbound.chatName }),
      },
      inbound,
      fromOwner,
      prefixed: false,
      merged: 1,
      ids: [inbound.messageId],
    }
  }

  #roomKey(channelId: string, chat: ChannelChat): string {
    return `${channelId}:${chat.id}`
  }

  #threadKey(chat: ChannelChat): string | null {
    return chat.type === 'group' && chat.threadId
      ? `${chat.id}:${chat.threadId}`
      : null
  }

  #follows(adapter: ChannelAdapter, chat: ChannelChat): boolean {
    const key = this.#threadKey(chat)
    return (
      adapter.followsThreads === true &&
      key !== null &&
      (this.#followed.get(adapter)?.has(key) ?? false)
    )
  }

  #joined(adapter: ChannelAdapter, chat: ChannelChat): void {
    const key = this.#threadKey(chat)
    if (adapter.followsThreads !== true || key === null) return
    let threads = this.#followed.get(adapter)
    if (threads === undefined) {
      threads = new Set()
      this.#followed.set(adapter, threads)
    }
    threads.delete(key)
    threads.add(key)
    if (threads.size > THREADS_KEPT)
      threads.delete(threads.values().next().value!)
  }

  async #pair(
    rules: ChannelRules,
    adapter: ChannelAdapter,
    inbound: ChannelInbound,
  ): Promise<void> {
    const reply = await this.#turns.pair?.(rules.id, inbound)
    if (reply) await this.#send(adapter, inbound.chat, reply, inbound.messageId)
  }

  /** The room is paused (too many turns); its lines are still kept. */
  #paused(conversation: ChannelConversation): boolean {
    if (conversation.chat.type !== 'group') return false
    const key = this.#roomKey(conversation.channelId, conversation.chat)
    const until = this.#roomPauses.get(key)
    if (until === undefined) return false
    if (until > this.#now()) return true
    this.#roomPauses.delete(key)
    return false
  }

  #countTurn(conversation: ChannelConversation): void {
    if (conversation.chat.type !== 'group') return
    const key = this.#roomKey(conversation.channelId, conversation.chat)
    const now = this.#now()
    const recent = (this.#roomTurns.get(key) ?? []).filter(
      at => now - at < ROOM_WINDOW_MS,
    )
    recent.push(now)
    this.#roomTurns.delete(key)
    if (recent.length < ROOM_TURNS) {
      this.#roomTurns.set(key, recent)
      if (this.#roomTurns.size > CONTEXT_ROOMS)
        this.#roomTurns.delete(this.#roomTurns.keys().next().value!)
      return
    }
    this.#roomPauses.set(key, now + ROOM_PAUSE_MS)
    this.#onError?.(
      `渠道 ${conversation.channelId} 的群 ${conversation.chat.id} 五分钟内跑了 ${ROOM_TURNS} 轮，暂停 10 分钟（防止和其他机器人互相回复）`,
    )
  }

  #remember(channelId: string, inbound: ChannelInbound): void {
    const key = this.#roomKey(channelId, inbound.chat)
    const now = this.#now()
    const kept = (this.#rooms.get(key) ?? []).filter(
      line => now - line.at <= CONTEXT_MAX_AGE_MS,
    )
    const media = (inbound.attachments ?? []).map(file =>
      file.kind === 'image' ? '[图片]' : `[文件 ${file.name}]`,
    )
    const said = [inbound.text.trim(), ...media].filter(Boolean).join(' ')
    if (said === '') return
    const clipped =
      [...said].length > CONTEXT_LINE_CHARS
        ? `${[...said].slice(0, CONTEXT_LINE_CHARS).join('')}…`
        : said
    kept.push({
      id: inbound.messageId,
      at: now,
      line: `[${identity(inbound)}] ${clipped.replace(/\s*\n\s*/g, ' ')}`,
      shown: false,
    })
    this.#rooms.delete(key)
    this.#rooms.set(key, kept.slice(-CONTEXT_KEEP))
    if (this.#rooms.size > CONTEXT_ROOMS)
      this.#rooms.delete(this.#rooms.keys().next().value!)
  }

  /**
   * What the room said that this turn's agent has not seen: lines before
   * the turn's own messages that no earlier turn carried. Everything up to
   * the turn's last message counts as seen afterwards.
   */
  #roomContext(event: ChannelEvent): string | null {
    const { conversation } = event
    if (conversation.chat.type !== 'group') return null
    const lines = this.#rooms.get(
      this.#roomKey(conversation.channelId, conversation.chat),
    )
    if (lines === undefined) return null
    const own = new Set(event.ids)
    let end = lines.length
    while (end > 0 && !own.has(lines[end - 1]!.id)) end--
    if (end === 0) end = lines.length
    const unseen = lines
      .slice(0, end)
      .filter(line => !line.shown && !own.has(line.id))
    for (const line of lines.slice(0, end)) line.shown = true
    if (unseen.length === 0) return null
    return [
      '[群里最近的消息]',
      ...unseen.slice(-CONTEXT_LINES).map(line => line.line),
    ].join('\n')
  }

  async #dispatch(
    rules: ChannelRules,
    adapter: ChannelAdapter,
    event: ChannelEvent,
  ): Promise<void> {
    const command = /^\/([a-z]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(
      event.inbound.text.trim(),
    )
    if (command && COMMANDS.has(command[1]!.toLowerCase())) {
      const name = command[1]!.toLowerCase()
      // Members cannot steer the agent; their commands are ordinary text.
      if (event.fromOwner || name === 'help') {
        await this.#command(adapter, event, name, (command[2] ?? '').trim())
        return
      }
    }
    const { conversation, inbound } = event
    if (
      this.#turns.intercept !== undefined &&
      event.fromOwner &&
      conversation.lane === 'owner' &&
      conversation.chat.type === 'dm' &&
      isStatusQuery(inbound.text)
    ) {
      const reply = await this.#turns.intercept(conversation, inbound.text)
      if (reply !== null) {
        await this.#send(adapter, conversation.chat, reply, inbound.messageId)
        return
      }
    }
    if (this.#paused(conversation)) return
    const key = conversation.key
    const split =
      adapter.inboundSplitAt !== undefined &&
      inbound.text.length >= adapter.inboundSplitAt
    if (this.#active.has(key)) {
      this.#queue(key).add(event)
      return
    }
    const window = this.#windows.get(key)
    if (window !== undefined) {
      this.#queue(key).add(event)
      if (split) {
        // Another full-length piece: the paste goes on.
        clearTimeout(window.timer)
        window.timer = setTimeout(
          window.fire,
          Math.max(
            0,
            Math.min(SPLIT_WAIT_MS, window.opened + SPLIT_WAIT_CAP_MS - Date.now()),
          ),
        )
      }
      return
    }
    const waitMs = Math.max(rules.replyWindowMs, split ? SPLIT_WAIT_MS : 0)
    if (waitMs > 0) {
      this.#queue(key).add(event)
      const fire = () => {
        this.#windows.delete(key)
        const pending = this.#pending.get(key)
        if (pending === undefined || pending.events.length === 0) return
        this.#start(rules, adapter, key, pending.take())
      }
      this.#windows.set(key, {
        timer: setTimeout(fire, waitMs),
        opened: Date.now(),
        fire,
      })
      return
    }
    this.#start(rules, adapter, key, event)
  }

  #queue(key: string): Pending {
    let pending = this.#pending.get(key)
    if (pending === undefined) {
      pending = new Pending()
      this.#pending.set(key, pending)
    }
    return pending
  }

  #start(
    rules: ChannelRules,
    adapter: ChannelAdapter,
    key: string,
    first: ChannelEvent,
  ): void {
    const loop = (async () => {
      try {
        await this.#run(rules, adapter, first)
        for (;;) {
          const pending = this.#pending.get(key)
          if (
            this.#closed ||
            pending === undefined ||
            pending.events.length === 0
          )
            break
          if (this.#paused(first.conversation)) {
            this.#pending.delete(key)
            break
          }
          const next = pending.take()
          if (pending.events.length === 0) this.#pending.delete(key)
          await this.#run(rules, adapter, next)
        }
      } finally {
        this.#active.delete(key)
      }
    })()
    this.#active.set(key, loop)
    void loop.catch(error =>
      this.#onError?.(
        `渠道 ${rules.id} 回合失败：${String((error as Error)?.message ?? error)}`,
      ),
    )
  }

  async #run(
    rules: ChannelRules,
    adapter: ChannelAdapter,
    event: ChannelEvent,
  ): Promise<void> {
    const { conversation, inbound } = event
    this.#countTurn(conversation)
    const generation = this.#generations.get(conversation.key) ?? 0
    const session = this.#turns.sessionOf(conversation)
    // A task note that cannot be had is left out: the owner's words still go.
    let extra: ChannelTurnContext | undefined
    try {
      extra = await this.#turns.context?.(conversation)
    } catch (error) {
      this.#onError?.(
        `渠道 ${rules.id} 后台任务附注失败：${String((error as Error)?.message ?? error)}`,
      )
    }
    const { texts, marks } = this.#sticky.filter(
      conversation.key,
      generation,
      session,
      [...this.#stickyParts(rules, conversation), ...(extra?.sticky ?? [])],
    )
    const text = [
      ...texts,
      extra?.note ?? '',
      this.#roomContext(event) ?? '',
      ...this.#notes(event),
      this.#body(event),
    ]
      .filter(Boolean)
      .join('\n\n')
    const stopTyping = this.#typing(
      adapter,
      conversation.chat,
      inbound.messageId,
    )
    let result: ChannelTurnResult
    try {
      result = await this.#turns.run(conversation, text, {
        onNotice: notice => {
          if (conversation.lane === 'owner' && !isSilence(notice))
            void this.#send(adapter, conversation.chat, notice).catch(() => {})
        },
      })
    } catch (error) {
      result = {
        ok: false,
        text: '',
        error: String((error as Error)?.message ?? error),
      }
    } finally {
      await stopTyping()
    }
    if (result.compacted)
      this.#generations.set(conversation.key, generation + 1)
    this.#sticky.commit(
      conversation.key,
      marks,
      result,
      this.#turns.sessionOf(conversation),
    )
    await this.#deliver(adapter, event, result)
  }

  #stickyParts(
    rules: ChannelRules,
    conversation: ChannelConversation,
  ): StickyPart[] {
    const where =
      conversation.chat.type === 'dm'
        ? '私聊'
        : `群聊${conversation.chatName ? `「${conversation.chatName}」` : ''}`
    const who =
      conversation.lane === 'owner'
        ? conversation.chat.type === 'dm'
          ? '对方是你的主人。'
          : '群里只有你的主人能和你说话。'
        : '说话的人不是你的主人，按成员对待：不透露主人的私事、文件和设备，不替成员执行改动。群消息每行前面的 [昵称(编号)] 是发言人。'
    const parts: StickyPart[] = [
      {
        id: 'channel',
        text: [
          `[渠道] 这段对话来自 ${PLATFORM_NAMES[conversation.platform]} 的${where}。${who}`,
          `你的回复会原样发到聊天里，直接写给对方看的话；${FORMAT_HINTS[conversation.platform]}。不需要回复时只回 [SILENT]。`,
        ].join('\n'),
      },
    ]
    // One paragraph, so readers of the transcript can tell it from the words
    // after it (background task context drops it).
    if (rules.prompt?.trim())
      parts.push({
        id: 'channel_prompt',
        text: `[渠道说明]\n${rules.prompt.trim().replace(/\n[ \t]*(\n[ \t]*)+/g, '\n')}`,
      })
    return parts
  }

  #notes(event: ChannelEvent): string[] {
    const notes: string[] = []
    const quote = event.inbound.quote
    if (quote && quote.text.trim()) {
      const snippet = [...quote.text].slice(0, 500).join('')
      notes.push(
        quote.own
          ? `[在回复你之前说的："${snippet}"]`
          : `[在回复 ${quote.authorName || quote.authorId || '某人'} 的消息："${snippet}"]`,
      )
    }
    for (const file of event.inbound.attachments ?? [])
      notes.push(
        `[对方发了${file.kind === 'image' ? '一张图片' : '一个文件'}：${file.name}（渠道暂不转交附件）]`,
      )
    return notes
  }

  #body(event: ChannelEvent): string {
    const text = event.inbound.text
    if (event.conversation.chat.type !== 'group' || event.prefixed) return text
    return `[${identity(event.inbound)}] ${text}`
  }

  #typing(
    adapter: ChannelAdapter,
    chat: ChannelChat,
    replyTo: string,
  ): () => Promise<void> {
    if (adapter.typing === undefined) return async () => {}
    const tick = () => {
      void adapter.typing?.(chat, replyTo).catch(() => {})
    }
    tick()
    const timer = setInterval(tick, this.#typingMs)
    return async () => {
      clearInterval(timer)
      await adapter.stopTyping?.(chat).catch(() => {})
    }
  }

  async #deliver(
    adapter: ChannelAdapter,
    event: ChannelEvent,
    result: ChannelTurnResult,
  ): Promise<void> {
    const { conversation, inbound } = event
    if (!result.ok) {
      if (result.cancelled || conversation.lane !== 'owner') return
      const note = result.timedOut
        ? '⚠️ 这轮执行到时间上限后停止了。已完成的操作会保留，可以让我接着做；控制台对话页可以查看停止原因。'
        : `⚠️ 这轮中断了：${[...(result.error ?? '未知错误')].slice(0, 220).join('')}。可以在控制台对话页查看运行过程。`
      await this.#send(adapter, conversation.chat, note, inbound.messageId)
      return
    }
    const { text, dropped } = extractMedia(result.text)
    if (!isSilence(text))
      await this.#send(adapter, conversation.chat, text, inbound.messageId)
    if (dropped > 0 && conversation.lane === 'owner')
      await this.#send(
        adapter,
        conversation.chat,
        `（回复里有 ${dropped} 个附件，渠道暂不转交附件，请在控制台查看。）`,
      )
  }

  /** Sends text outside a turn (a background task's result); false if it failed. */
  post(
    adapter: ChannelAdapter,
    chat: ChannelChat,
    text: string,
  ): Promise<boolean> {
    return this.#send(adapter, chat, text)
  }

  async #send(
    adapter: ChannelAdapter,
    chat: ChannelChat,
    text: string,
    replyTo?: string,
  ): Promise<boolean> {
    if (
      text.length > (adapter.longReplyAt ?? adapter.chunkLimit) &&
      adapter.sendLong !== undefined
    ) {
      const whole = await adapter
        .sendLong(chat, text, replyTo ? { replyTo } : {})
        .catch(() => null)
      if (whole?.ok) {
        this.#joined(adapter, chat)
        return true
      }
    }
    let first = true
    for (const chunk of this.#chunks(text, adapter.chunkLimit)) {
      const sent = await this.#sendChunk(
        adapter,
        chat,
        chunk,
        first && replyTo ? { replyTo } : {},
      )
      first = false
      if (!sent.ok) {
        this.#onError?.(`渠道发送失败：${sent.error ?? '未知原因'}`)
        return false
      }
      this.#joined(adapter, chat)
    }
    return true
  }

  /** At most {@link MAX_CHUNKS}: a longer reply is cut at a line and says so. */
  #chunks(text: string, limit: number): string[] {
    const chunks = splitMessage(text, limit)
    if (chunks.length <= MAX_CHUNKS) return chunks
    for (
      let budget = limit * (MAX_CHUNKS - 1);
      budget > limit;
      budget -= Math.ceil(limit / 4)
    ) {
      let head = text.slice(0, budget)
      const line = head.lastIndexOf('\n')
      if (line > budget / 2) head = head.slice(0, line)
      const kept = splitMessage(head.trimEnd(), limit)
      if (kept.length < MAX_CHUNKS) return [...kept, TRUNCATED]
    }
    return [...chunks.slice(0, MAX_CHUNKS - 1), TRUNCATED]
  }

  /**
   * One chunk, sent again when the platform throttled it (after the wait it
   * named) or failed before reaching it (2 s, then 4 s, as hermes `_send_with_retry`);
   * three attempts at most. A failure that may already have delivered the
   * text is not marked retryable by the adapters, so nobody gets it twice.
   */
  async #sendChunk(
    adapter: ChannelAdapter,
    chat: ChannelChat,
    chunk: string,
    options: ChannelSendOptions,
  ): Promise<ChannelSendResult> {
    const gap = adapter.sendGapMs ?? 0
    const chatKey = `${chat.id}:${chat.threadId ?? ''}`
    let sends = this.#lastSends.get(adapter)
    if (sends === undefined) {
      sends = new Map()
      this.#lastSends.set(adapter, sends)
    }
    for (let attempt = 1; ; attempt++) {
      const last = sends.get(chatKey)
      if (gap > 0 && last !== undefined) {
        const wait = last + gap - this.#now()
        if (wait > 0) await this.#sleep(wait)
      }
      const sent = await adapter.send(chat, chunk, options)
      sends.delete(chatKey)
      sends.set(chatKey, this.#now())
      if (sends.size > 1_000) sends.delete(sends.keys().next().value!)
      if (sent.ok || attempt >= SEND_ATTEMPTS || this.#closed) return sent
      const wait =
        sent.retryAfterMs ??
        (sent.retryable ? SEND_BACKOFF_MS[attempt - 1] : undefined)
      if (wait === undefined || wait > SEND_MAX_WAIT_MS) return sent
      await this.#sleep(wait)
    }
  }

  #help(): string {
    return this.#turns.approvePairing === undefined ? HELP : HELP + HELP_PAIR
  }

  async #command(
    adapter: ChannelAdapter,
    event: ChannelEvent,
    name: string,
    args: string,
  ): Promise<void> {
    const { conversation } = event
    const key = conversation.key
    let reply: string
    switch (name) {
      case 'new':
      case 'reset':
      case 'clear':
        this.#pending.delete(key)
        await this.#turns.stop(conversation)
        await this.#turns.reset(conversation)
        this.#sticky.forget(key)
        this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1)
        reply = '好，换个新话题。'
        break
      case 'stop': {
        this.#pending.delete(key)
        reply = (await this.#turns.stop(conversation, { tasks: true }))
          ? '停下了。'
          : '现在没在跑任务。'
        break
      }
      case 'status':
        reply = [
          ...(await this.#turns.status(conversation)),
          `会话键：${key}`,
          `通道：${conversation.lane === 'owner' ? '主人' : '成员'}`,
          `进行中：${this.#active.has(key) ? '是' : '否'}，排队：${this.#pending.get(key)?.events.length ?? 0}`,
        ].join('\n')
        break
      case 'model':
        reply = await this.#turns.direction(
          conversation,
          args === ''
            ? undefined
            : args === 'default' || args === 'reset'
              ? null
              : args.split(/\s+/)[0]!,
        )
        break
      case 'compact':
        reply = await this.#turns.compact(conversation)
        if (/已压缩/.test(reply)) {
          this.#sticky.forget(key)
          this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1)
        }
        break
      case 'pair':
        reply =
          this.#turns.approvePairing === undefined
            ? this.#help()
            : args === ''
              ? '用法：/pair 配对码'
              : await this.#turns.approvePairing(conversation.channelId, args)
        break
      default:
        reply = this.#help()
    }
    await this.#send(adapter, conversation.chat, reply, event.inbound.messageId)
  }
}
