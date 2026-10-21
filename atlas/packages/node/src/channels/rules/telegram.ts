// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
// 规则来源 NousResearch/hermes-agent `plugins/platforms/telegram/adapter.py:528`、`:547-552`、`:625-636`、`:1091-1102`、`:5781-5796`、`:5863-5890`、`:5952-6067`、`:6085-6119`、`:6379-6413`、`:6578-6589`，取于 `63220ae5`，取用日期 2026-10-19

/**
 * Telegram's group rules and topics (`runtimes-channels.md` §2.6),
 * rewritten in TypeScript after hermes-agent's Telegram adapter, function
 * by function:
 *
 * - mentions are what Telegram's entities say (`mention`, `text_mention`,
 *   `/cmd@bot`); raw text is looked at only when a message has no entities,
 *   and narrowly (`_message_mentions_bot`, `_extract_bot_mention_usernames`);
 * - a message that explicitly names other bots and not this one is not for
 *   it, even as a reply (`exclusive_bot_mentions`, on by default);
 * - free chats and topics (`<chat>:<topic>`, General is `1`) need no
 *   mention; otherwise a reply to the bot, a mention or a wake word does
 *   (`_should_process_message`);
 * - the topic is the one Telegram routes by: General in a forum is `1`,
 *   which sends omit and typing keeps; a reply anchor in a plain group is
 *   not a topic (`_effective_message_thread_id`);
 * - short texts settle sooner (adaptive text batching).
 */

import { matchesKeyword } from '../gate.js'
import { list, record, text } from '../net.js'
import type {
  ChannelInbound,
  ChannelTextBatch,
  GroupPolicy,
  GroupVerdict,
} from '../types.js'

type Message = Record<string, unknown>

/** The forum's General topic (hermes `_GENERAL_TOPIC_THREAD_ID`). */
export const GENERAL_TOPIC = '1'

/** hermes Telegram text batching: 0.3 s, 1 s after a split piece; ≤320 chars 0.18 s, ≤1024 0.24 s. */
export const TELEGRAM_TEXT_BATCH: ChannelTextBatch = {
  quietMs: 300,
  splitMs: 1_000,
  fast: [
    [320, 180],
    [1_024, 240],
  ],
}

/** Decides only whether a foreign @handle is bot-shaped (hermes `_FOREIGN_BOT_HANDLE_RE`). */
const FOREIGN_BOT_HANDLE = /^[a-z0-9_]{2,29}bot$/i

/** hermes `_effective_message_thread_id`. */
export function telegramThreadId(message: Message): string | undefined {
  const chat = record(message.chat)
  const type = text(chat.type)
  const raw = text(message.message_thread_id)
  const topic = message.is_topic_message === true
  const group = type === 'group' || type === 'supergroup'
  const forum = group && chat.is_forum === true
  if (raw !== '')
    return forum || (group && topic) || (type === 'private' && topic)
      ? raw
      : undefined
  return forum ? GENERAL_TOPIC : undefined
}

/** `sendMessage` rejects `message_thread_id=1`: General is sent without it. */
export function telegramSendThreadId(threadId?: string): number | undefined {
  return !threadId || threadId === GENERAL_TOPIC ? undefined : Number(threadId)
}

/** `sendChatAction` needs it, General included. */
export function telegramTypingThreadId(threadId?: string): number | undefined {
  return threadId ? Number(threadId) : undefined
}

/** `(text, entities)` for the message text and its caption. */
function sources(message: Message): [string, Record<string, unknown>[]][] {
  return [
    [text(message.text), list(message.entities).map(record)],
    [text(message.caption), list(message.caption_entities).map(record)],
  ]
}

/** An entity's text; offsets are UTF-16 units, as JavaScript strings are. */
function span(source: string, entity: Record<string, unknown>): string | null {
  const offset = Number(entity.offset)
  const length = Number(entity.length)
  if (!Number.isInteger(offset) || offset < 0 || !(length > 0)) return null
  return source.slice(offset, offset + length)
}

/**
 * hermes `_extract_bot_mention_usernames`: bot handles a message names
 * explicitly. A foreign handle counts only when bot-shaped (`…bot`); the
 * bot's own counts whatever its shape.
 */
export function mentionedBotHandles(
  message: Message,
  ownUsername: string,
): Set<string> {
  const own = ownUsername.replace(/^@/, '').toLowerCase()
  const handles = new Set<string>()
  const isBot = (handle: string) =>
    handle !== '' &&
    ((own !== '' && handle === own) || FOREIGN_BOT_HANDLE.test(handle))
  for (const [source, entities] of sources(message))
    for (const entity of entities) {
      const type = text(entity.type).toLowerCase()
      if (type !== 'mention' && type !== 'bot_command') continue
      const value = span(source, entity)?.trim()
      if (value === undefined) continue
      if (type === 'mention') {
        const handle = value.replace(/^@+/, '').toLowerCase()
        if (isBot(handle)) handles.add(handle)
        continue
      }
      // `/cmd@botname` is one bot_command entity; its suffix names a bot.
      const at = value.indexOf('@')
      if (at < 0) continue
      const target = value
        .slice(at + 1)
        .trim()
        .toLowerCase()
      if (isBot(target)) handles.add(target)
    }
  // Without entities only: Telegram's entities are trusted when present.
  for (const [source, entities] of sources(message)) {
    if (source === '' || entities.length > 0) continue
    for (const match of source.matchAll(
      /(?<![A-Za-z0-9_`/])@([A-Za-z0-9_]{2,31})\b/gi,
    )) {
      const handle = match[1]!.toLowerCase()
      if (isBot(handle)) handles.add(handle)
    }
  }
  return handles
}

/** hermes `_message_mentions_bot`: entities first, then the narrow raw-text fallback. */
export function mentionsBot(
  message: Message,
  bot: { readonly id: string; readonly username: string },
): boolean {
  const username = bot.username.replace(/^@/, '').toLowerCase()
  const expected = username ? `@${username}` : null
  for (const [source, entities] of sources(message))
    for (const entity of entities) {
      const type = text(entity.type).toLowerCase()
      if (type === 'mention' && expected !== null) {
        if (span(source, entity)?.trim().toLowerCase() === expected) return true
      } else if (type === 'text_mention') {
        if (bot.id !== '' && text(record(entity.user).id) === bot.id)
          return true
      } else if (type === 'bot_command' && expected !== null) {
        const command = span(source, entity)
        if (command === null) continue
        const at = command.indexOf('@')
        if (at >= 0 && command.slice(at).trim().toLowerCase() === expected)
          return true
      }
    }
  return username !== '' && mentionedBotHandles(message, username).has(username)
}

/**
 * hermes `_explicit_bot_mentions_exclude_self`: `@bot3 hi @bot4` is not for
 * `@bot1`, not even as a reply to it.
 */
export function mentionsOnlyOtherBots(
  message: Message,
  ownUsername: string,
): boolean {
  const own = ownUsername.replace(/^@/, '').toLowerCase()
  if (own === '') return false
  const handles = mentionedBotHandles(message, own)
  return handles.size > 0 && !handles.has(own)
}

/** hermes `_is_reply_to_bot`. */
export function isReplyToBot(message: Message, botId: string): boolean {
  const from = record(record(message.reply_to_message).from)
  return botId !== '' && text(from.id) === botId
}

/** hermes `_clean_bot_trigger_text`: `@bot,` and the like go; a bare `@bot` stays. */
export function cleanTriggerText(body: string, username: string): string {
  const handle = username.replace(/^@/, '')
  if (body === '' || handle === '') return body
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const cleaned = body
    .replace(new RegExp(`@${escaped}\\b[,:\\-]*\\s*`, 'gi'), '')
    .trim()
  return cleaned || body
}

/**
 * hermes `_should_process_message` after `allowed_chats` (the binding's
 * group list): other bots named and not this one, no; a free chat or
 * topic, yes; then the `all` trigger, a reply or mention, or a wake word.
 */
export function telegramGroupGate(
  inbound: ChannelInbound,
  policy: GroupPolicy,
): GroupVerdict {
  if (inbound.mention?.otherBots) return null
  const topic = `${inbound.chat.id}:${inbound.chat.threadId ?? GENERAL_TOPIC}`
  if (
    policy.freeGroups.includes(inbound.chat.id) ||
    policy.freeGroups.includes(topic)
  )
    return inbound.addressed ? 'explicit' : 'implicit'
  if (inbound.addressed) return 'explicit'
  if (policy.trigger === 'all') return 'implicit'
  return matchesKeyword(inbound.text, policy.keywords) ? 'implicit' : null
}
