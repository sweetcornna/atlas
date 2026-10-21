// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
// 规则来源 NousResearch/hermes-agent `plugins/platforms/slack/adapter.py:395-411`、`:4098-4148`、`:4187-4222`、`:4510-4533`、`:4555-4572`、`:4584-4590`、`:4632-4640`、`:6385-6419`，取于 `63220ae5`，取用日期 2026-10-19

/**
 * Slack's group rules (`runtimes-channels.md` §2.6), rewritten in
 * TypeScript after hermes-agent's Slack adapter:
 *
 * - only messages a person sends: no subtype, or `file_share`,
 *   `thread_broadcast`, `me_message`, `document_mention` (an allowlist, so
 *   subtypes Slack adds later stay out);
 * - the bot is mentioned as `<@U…>` or `<@U…|name>`, or by a wake word;
 * - a free channel needs no mention; elsewhere an unmentioned message wakes
 *   the bot only in a thread it takes part in: one it was mentioned in (a
 *   top-level mention starts that thread) or one it answered in
 *   (`_channel_gate_allows`, `_should_wake_on_unmentioned_message`);
 * - Slack refuses slash commands in threads, so a known `!cmd` is `/cmd`.
 */

import { matchesKeyword } from '../gate.js'
import type { ChannelInbound, GroupPolicy, GroupVerdict } from '../types.js'

/** Subtypes that are a person speaking (hermes' allowlist minus `bot_message`: bots are not answered). */
export const SLACK_SUBTYPES: ReadonlySet<string> = new Set([
  '',
  'file_share',
  'thread_broadcast',
  'me_message',
  'document_mention',
])

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** hermes `_slack_message_mentions_self`: `<@U123>` or `<@U123|name>` anywhere. */
export function slackMentionsBot(body: string, botUser: string): boolean {
  return (
    botUser !== '' &&
    new RegExp(`<@${escape(botUser)}(?:\\|[^>]*)?>`).test(body)
  )
}

/** The bot's own mention, in either form, taken out of the text. */
export function stripSlackMention(body: string, botUser: string): string {
  if (botUser === '') return body
  return body
    .replace(new RegExp(`<@${escape(botUser)}(?:\\|[^>]*)?>`, 'g'), '')
    .trim()
}

/** hermes `_rewrite_known_bang_command`: `!new` is `/new`; `!nice work` stays. */
export function rewriteBangCommand(
  body: string,
  known: ReadonlySet<string>,
): string {
  const trimmed = body.trimStart()
  if (!trimmed.startsWith('!')) return body
  const name = (trimmed.slice(1).split(/\s/, 1)[0] ?? '')
    .split('@', 1)[0]!
    .toLowerCase()
  return name !== '' && !name.includes('/') && known.has(name)
    ? `/${trimmed.slice(1)}`
    : body
}

/**
 * hermes `_channel_gate_allows` after `allowed_channels` (the binding's
 * channel list): a free channel (or the `all` trigger, hermes
 * `require_mention: false`), a mention or wake word, else only a thread
 * the bot takes part in.
 */
export function slackGroupGate(
  inbound: ChannelInbound,
  policy: GroupPolicy,
): GroupVerdict {
  if (policy.freeGroups.includes(inbound.chat.id) || policy.trigger === 'all')
    return inbound.addressed ? 'explicit' : 'implicit'
  if (inbound.addressed) return 'explicit'
  if (matchesKeyword(inbound.text, policy.keywords)) return 'implicit'
  return policy.followed ? 'implicit' : null
}
