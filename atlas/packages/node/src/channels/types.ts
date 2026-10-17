// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat platforms a hub can bind to an agent (P28, `runtimes-channels.md` §2).
 *
 * Every adapter speaks its platform's own official interface (charter §7.2
 * item 8) and turns the platform's events into {@link ChannelInbound}; the
 * gateway (`gateway.ts`) owns everything platform-independent.
 */

export const CHANNEL_PLATFORMS = [
  'qq',
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
  /** Attachments the platform reported; the first version describes them only. */
  readonly attachments?: readonly {
    readonly name: string
    readonly kind: string
  }[]
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
  start(sink: (message: ChannelInbound) => void): Promise<void>
  stop(): Promise<void>
  /** Sends one chunk of agent markdown, rendered the platform's own way. */
  send(
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
