// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat platforms a hub can bind to an agent (P28, `runtimes-channels.md` §2).
 *
 * Every adapter speaks its platform's own official interface (charter §7.2
 * item 8) and turns the platform's events into {@link ChannelInbound}; the
 * gateway (`gateway.ts`) owns everything platform-independent. The one
 * exception is `qq-personal`: an ordinary QQ account through a SnowLuma
 * OneBot 11 bridge, by the owner's decision of 2026-10-17 (charter v3.8,
 * `runtimes-channels.md` §2.5); the official bot stays `qq`.
 */

export const CHANNEL_PLATFORMS = [
  'qq',
  'qq-personal',
  'weixin',
  'telegram',
  'discord',
  'slack',
] as const
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number]

export function isChannelPlatform(value: unknown): value is ChannelPlatform {
  return CHANNEL_PLATFORMS.includes(value as ChannelPlatform)
}

/** One conversation on a platform: a private chat, or a group (and topic). */
export interface ChannelChat {
  readonly type: 'dm' | 'group'
  /** The platform's own id for the chat (QQ openid, Telegram chat id, …). */
  readonly id: string
  /** Telegram forum topic, Slack thread, Discord thread channel. */
  readonly threadId?: string
}

/** The message the sender quoted with their own. */
export interface ChannelQuote {
  readonly messageId?: string
  readonly text: string
  readonly authorId?: string
  readonly authorName?: string
  /** The quoted message is one the bot sent. */
  readonly own: boolean
}

export interface ChannelInbound {
  readonly chat: ChannelChat
  readonly chatName?: string
  readonly messageId: string
  readonly userId: string
  readonly userName: string
  readonly text: string
  /**
   * The bot was addressed: a private chat, an @-mention, a reply to the bot,
   * or an event the platform only raises on a mention (QQ group @-messages).
   */
  readonly addressed: boolean
  readonly quote?: ChannelQuote
  /** Who else the message names, where the platform says (group rules, `rules/`). */
  readonly mention?: ChannelMention
  /** Attachments the platform reported; the first version describes them only. */
  readonly attachments?: readonly {
    readonly name: string
    readonly kind: string
  }[]
}

/**
 * Mentions of others, for the platform's group rules: hermes drops a
 * message that names other bots and not this one (Telegram
 * `exclusive_bot_mentions`, Discord admission), and one that names other
 * people and not the bot (Discord `ignore_no_mention`).
 */
export interface ChannelMention {
  /** It explicitly names another bot and not this one. */
  readonly otherBots?: boolean
  /** It names someone, but not the bot. */
  readonly othersOnly?: boolean
}

/** How a group's own rules see a message (`gate.ts`). */
export interface GroupPolicy {
  /** `mention`: when addressed (or by the rules below); `all`: every message. */
  readonly trigger: 'mention' | 'all'
  /** Rooms answered without a mention (hermes `free_response_*`). */
  readonly freeGroups: readonly string[]
  /** Words that wake the bot without a mention (grantley group keywords, hermes `mention_patterns`). */
  readonly keywords: readonly string[]
  /** The message is in a thread the bot takes part in. */
  readonly followed: boolean
}

/**
 * `explicit`: the bot was named (a mention, a reply to it); `implicit`: the
 * room's rules let the message in without that; null: it is not for the bot.
 * Only implicit replies wait out a group's cooldown (grantley).
 */
export type GroupVerdict = 'explicit' | 'implicit' | null

/**
 * hermes text batching (`base.py` `_enqueue_text_event`): a quiet wait
 * before a turn, longer after a piece as long as the client's own split.
 */
export interface ChannelTextBatch {
  readonly quietMs: number
  readonly splitMs: number
  /** Shorter waits for short batches: `[up to characters, ms]` (Telegram). */
  readonly fast?: readonly (readonly [number, number])[]
}

export interface ChannelSendOptions {
  /** Reply to (quote) this message natively, where the platform can. */
  readonly replyTo?: string
}

export interface ChannelSendResult {
  readonly ok: boolean
  readonly messageId?: string
  /** A fixed, secret-free description. */
  readonly error?: string
  /** The platform throttled the send and said how long to wait (429). */
  readonly retryAfterMs?: number
  /** A transient failure (network, timeout, 5xx) the same send may survive. */
  readonly retryable?: boolean
}

export type ChannelState =
  | 'stopped'
  | 'starting'
  | 'connected'
  | 'retrying'
  | 'failed'

export interface ChannelHealth {
  readonly state: ChannelState
  readonly since: number
  /** Fixed, secret-free text for the console. */
  readonly detail?: string
}

export interface ChannelAdapter {
  readonly platform: ChannelPlatform
  /**
   * Characters of markdown one chunk may carry before the adapter renders it
   * into the platform's own format. Below the platform's hard limit, leaving
   * room for escaping.
   */
  readonly chunkLimit: number
  /**
   * The platform's client splits a long paste into messages of about this
   * length: an inbound text this long waits briefly for its continuation
   * (hermes `_SPLIT_THRESHOLD`).
   */
  readonly inboundSplitAt?: number
  /** Least time between two sends to one chat (hermes per-chat budget). */
  readonly sendGapMs?: number
  /** How long a message id is remembered against redelivery (default 5 min). */
  readonly dedupTtlMs?: number
  /**
   * A thread the bot has answered in is a conversation with it: later
   * messages there need no @ (hermes thread participation, Slack).
   */
  readonly followsThreads?: boolean
  /** The platform's text batching; none waits only for split pieces. */
  readonly textBatch?: ChannelTextBatch
  /** The platform's group rules (`rules/`); the default is `gate.ts`. */
  readonly groupGate?: (
    inbound: ChannelInbound,
    policy: GroupPolicy,
  ) => GroupVerdict
  /**
   * A group member whose question is pending or running is still heard
   * without a mention (grantley `has_sender_work`, personal QQ).
   */
  readonly continuesSenders?: boolean
  /**
   * `owner-private`: commands run only in the owner's private chat; in a
   * group, or from anyone else, a leading slash is ordinary text (grantley
   * 主窗口). The default runs the owner's commands anywhere.
   */
  readonly commandScope?: 'owner-private'
  /** How a reply is cut into messages (hermes per-platform `_split_text`); default `splitMessage`. */
  chunks?(markdown: string): string[]
  start(sink: (message: ChannelInbound) => void): Promise<void>
  stop(): Promise<void>
  /** Sends one chunk of agent markdown, rendered the platform's own way. */
  send(
    chat: ChannelChat,
    markdown: string,
    options?: ChannelSendOptions,
  ): Promise<ChannelSendResult>
  /**
   * A whole reply, shaped the platform's own way (grantley `send`: bubbles,
   * a merged-forward card, the quote on the first message only). When
   * present the gateway hands every reply here instead of chunking it; a
   * failure is retryable only while nothing reached the chat.
   */
  sendReply?(
    chat: ChannelChat,
    markdown: string,
    options?: ChannelSendOptions,
  ): Promise<ChannelSendResult>
  /**
   * The platform's native "typing" indicator. The gateway calls it every few
   * seconds while a turn runs; the adapter debounces to the platform's own
   * cadence and drops it where the platform has none for this chat.
   */
  typing?(chat: ChannelChat, replyTo?: string): Promise<void>
  stopTyping?(chat: ChannelChat): Promise<void>
  health(): ChannelHealth
}

/** What the adapters need from the outside world; tests pass fakes. */
export interface ChannelIo {
  readonly fetch: typeof fetch
  readonly WebSocket: WebSocketFactory
  readonly now: () => number
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly onError?: (message: string) => void
}

export type WebSocketFactory = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocket

export function defaultChannelIo(
  onError?: (message: string) => void,
): ChannelIo {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    WebSocket: globalThis.WebSocket as unknown as WebSocketFactory,
    now: Date.now,
    sleep: (ms, signal) =>
      new Promise(resolve => {
        if (signal?.aborted) return resolve()
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      }),
    ...(onError === undefined ? {} : { onError }),
  }
}
