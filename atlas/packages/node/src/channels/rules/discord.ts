// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
// 规则来源 NousResearch/hermes-agent `plugins/platforms/discord/adapter.py:1224-1226`、`:1260-1262`、`:1671-1745`、`:2552-2558`、`:5116-5141`、`:5167-5190`、`:6086-6160`、`:6305-6309`，取于 `63220ae5`，取用日期 2026-10-19

/**
 * Discord's group rules and threads (`runtimes-channels.md` §2.6),
 * rewritten in TypeScript after hermes-agent's Discord adapter:
 *
 * - only what people type is a message: `default` and `reply` types
 *   (`_discord_message_admission`);
 * - the bot is mentioned when it is in `mentions` (a reply that pings it
 *   puts it there) or its `<@id>` is in the text
 *   (`_self_is_explicitly_mentioned`);
 * - a message that mentions other bots and not this one is dropped; one
 *   that mentions other people and not the bot is someone else's
 *   conversation, unless it is in a thread the bot takes part in or a free
 *   channel (`ignore_no_mention`, on by default);
 * - otherwise a mention is needed, except in a free channel (by its own id
 *   or, for a thread, its parent's) and in the bot's threads
 *   (`_handle_message`);
 * - a thread is its parent channel's conversation-in-a-thread: allow lists
 *   and free channels match the parent, the thread is the topic.
 */

import { list, record, text } from '../net.js'
import type {
  ChannelChat,
  ChannelInbound,
  ChannelTextBatch,
  GroupPolicy,
  GroupVerdict,
} from '../types.js'

/** hermes Discord text batching: 0.6 s, 2 s after a piece near the 2000 split. */
export const DISCORD_TEXT_BATCH: ChannelTextBatch = {
  quietMs: 600,
  splitMs: 2_000,
}

/** `MessageType.default` and `MessageType.reply`. */
export const DISCORD_MESSAGE_TYPES: ReadonlySet<number> = new Set([0, 19])

/** Announcement, public and private thread channels. */
export const DISCORD_THREAD_TYPES: ReadonlySet<number> = new Set([10, 11, 12])

/** `<@ID>` and the legacy `<@!ID>` in the text (hermes `_raw_mentioned_user_ids`). */
export function rawMentionedIds(content: string): Set<string> {
  return new Set([...content.matchAll(/<@!?(\d+)>/g)].map(match => match[1]!))
}

export interface DiscordMentions {
  /** The bot is mentioned. */
  readonly bot: boolean
  /** Other bots are mentioned. */
  readonly otherBots: boolean
  /** Someone is mentioned (`message.mentions` is not empty). */
  readonly anyone: boolean
}

/** Who a `MESSAGE_CREATE` mentions. */
export function discordMentions(
  data: Record<string, unknown>,
  botId: string,
): DiscordMentions {
  const mentions = list(data.mentions).map(record)
  return {
    bot:
      botId !== '' &&
      (mentions.some(user => text(user.id) === botId) ||
        rawMentionedIds(text(data.content)).has(botId)),
    otherBots: mentions.some(
      user => user.bot === true && text(user.id) !== botId,
    ),
    anyone: mentions.length > 0,
  }
}

/** Free by the channel's own id, a thread's id or its parent's; `*` frees all. */
function free(chat: ChannelChat, freeGroups: readonly string[]): boolean {
  return (
    freeGroups.includes('*') ||
    freeGroups.includes(chat.id) ||
    (chat.threadId !== undefined && freeGroups.includes(chat.threadId))
  )
}

/**
 * hermes admission (mention checks) and `_handle_message`
 * (`require_mention`) for a guild message the binding's channel list let in.
 */
export function discordGroupGate(
  inbound: ChannelInbound,
  policy: GroupPolicy,
): GroupVerdict {
  const open = free(inbound.chat, policy.freeGroups)
  if (inbound.mention?.otherBots && !inbound.addressed) return null
  if (inbound.mention?.othersOnly && !policy.followed && !open) return null
  if (inbound.addressed) return 'explicit'
  if (open || policy.followed || policy.trigger === 'all') return 'implicit'
  return null
}
