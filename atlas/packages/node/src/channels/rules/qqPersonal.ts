// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
// 规则来源 grantley `src/grantley/platforms/onebot/router.py:378-410`、`adapter.py:131-169`、`adapter.py:1210-1221`、`adapter.py:1332-1365`、`adapter.py:1511-1684`、`adapter.py:4409-4836`，取于 `81fbbd77`（含当时的工作区），取用日期 2026-10-19
// 规则来源 NousResearch/hermes-agent `gateway/platforms/helpers.py:121-162`、`gateway/platforms/base.py:1674-1712`、`gateway/platforms/base.py:1793-1795`，取于 `63220ae5`，取用日期 2026-10-19

/**
 * Personal QQ's group rules and reply shaping (`runtimes-channels.md` §2.6),
 * the owner's grantley OneBot gateway rewritten in TypeScript. grantley
 * took two helpers from hermes-agent unchanged (`strip_markdown` before it
 * learned `keep_link_targets`, and `classify_send_error`); they follow the
 * hermes lines named above.
 *
 * A reply is one of two shapes, chosen once on the whole finished text:
 * chat bubbles (split on `[MSG_BREAK]`, at most three, each cut at 3800
 * characters with `(n/N)`), or one merged-forward card when the reply is
 * longer than 1000 characters, has more than three bubbles, or starts with
 * `[LONG_REPLY]`. A card keeps code and links (only fence lines go); chat
 * strips Markdown. Only the first message carries the quote and the @.
 */

import { matchesKeyword } from '../gate.js'
import type { ChannelInbound, GroupPolicy, GroupVerdict } from '../types.js'

/** One reply, several chat bubbles (grantley `BUBBLE_SEPARATOR`). */
export const BUBBLE_SEPARATOR = '[MSG_BREAK]'
/** The agent asks for a card whatever the length (grantley `LONG_REPLY_MARKER`). */
export const LONG_REPLY_MARKER = '[LONG_REPLY]'
/** Past this a reply is a considered answer: one card (grantley `FORWARD_TEXT_THRESHOLD`). */
export const FORWARD_TEXT_THRESHOLD = 1_000
/** Bubbles one reply may fire (grantley `DEFAULT_MAX_BUBBLES_PER_REPLY`). */
export const MAX_BUBBLES_PER_REPLY = 3
/** One QQ message (grantley `MAX_MESSAGE_LENGTH`). */
export const MAX_MESSAGE_LENGTH = 3_800
/** A card cannot @, so in a group this line carries the @ first (grantley `FORWARD_LEAD_TEXT`). */
export const FORWARD_LEAD_TEXT = '完整回复在下面。'

/**
 * grantley `ChannelRouter._group_reply_allowed` after the whitelist: an @
 * or a quote of the bot is explicit; otherwise `mention` answers only a
 * configured keyword, `all` answers everything unless keywords are set,
 * then only those. A leading `/` in a group is ordinary text (主窗口).
 */
export function qqPersonalGroupGate(
  inbound: ChannelInbound,
  policy: GroupPolicy,
): GroupVerdict {
  if (inbound.addressed) return 'explicit'
  const matched =
    policy.trigger === 'all' && policy.keywords.length === 0
      ? true
      : matchesKeyword(inbound.text, policy.keywords)
  return matched ? 'implicit' : null
}

const STRIP_RULES: readonly (readonly [RegExp, string])[] = [
  [/\*\*([\s\S]+?)\*\*/g, '$1'],
  [/\*([\s\S]+?)\*/g, '$1'],
  [/\b__(?![\s_])([\s\S]+?)(?<![\s_])__\b/g, '$1'],
  [/\b_(?![\s_])([\s\S]+?)(?<![\s_])_\b/g, '$1'],
  [/```[a-zA-Z0-9_+-]*\n?/g, ''],
  [/`(.+?)`/g, '$1'],
  [/^#{1,6}\s+/gm, ''],
]

/** hermes `strip_markdown` as grantley has it: QQ renders none, link targets are dropped. */
export function stripMarkdown(text: string): string {
  let out = text
  for (const [pattern, replacement] of STRIP_RULES)
    out = out.replace(pattern, replacement)
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/** A complete answer keeps its code and links; only the fence lines go. */
export function stripFences(text: string): string {
  return text.replace(/^ {0,3}```[\w+-]*[ \t]*(?:\n|$)/gm, '').trim()
}

/** grantley `split_bubbles`: the marker splits, empty bubbles drop. */
export function splitBubbles(content: string): string[] {
  if (!content.includes(BUBBLE_SEPARATOR)) {
    const stripped = content.trim()
    return stripped ? [stripped] : []
  }
  return content
    .split(BUBBLE_SEPARATOR)
    .map(part => part.trim())
    .filter(Boolean)
}

/**
 * grantley `cap_bubbles`: the overflow is merged into the last bubble kept,
 * never dropped. `limit <= 0` turns the cap off.
 */
export function capBubbles(
  bubbles: readonly string[],
  limit: number,
): string[] {
  if (limit <= 0 || bubbles.length <= limit) return [...bubbles]
  const head = bubbles.slice(0, limit - 1)
  head.push(
    bubbles
      .slice(limit - 1)
      .filter(Boolean)
      .join('\n'),
  )
  return head
}

/**
 * grantley `chunk_text`: at most `limit` characters each, cut at the latest
 * paragraph, line or sentence end past half the budget (else hard), every
 * character kept; several chunks open with `(n/N)`.
 */
export function chunkText(
  body: string,
  limit = MAX_MESSAGE_LENGTH,
  prefixOverhead = 16,
): string[] {
  if (body.length <= limit) return [body]
  const effective = Math.max(limit - prefixOverhead, Math.floor(limit / 2))
  const half = Math.floor(effective / 2)
  const chunks: string[] = []
  let remaining = body
  while (remaining) {
    if (remaining.length <= effective) {
      chunks.push(remaining)
      break
    }
    const window = remaining.slice(0, effective)
    let cut = window.lastIndexOf('\n\n')
    if (cut < half) cut = window.lastIndexOf('\n')
    if (cut < half) {
      cut = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('。'),
        window.lastIndexOf('！'),
        window.lastIndexOf('？'),
      )
      // The punctuation stays with its sentence.
      if (cut > 0) cut += 1
    }
    if (cut < half) cut = effective
    chunks.push(remaining.slice(0, cut).trimEnd())
    remaining = remaining.slice(cut).replace(/^\n+/, '')
  }
  if (chunks.length === 1) return chunks
  return chunks.map((chunk, i) => `(${i + 1}/${chunks.length})\n${chunk}`)
}

export interface ReplyPlan {
  /** The text after the marker and Markdown handling. */
  readonly content: string
  readonly bubbles: readonly string[]
  /** One merged-forward card rather than bubbles. */
  readonly card: boolean
}

/** grantley `send`, steps 2–4: the shape of the whole reply, decided once. */
export function planReply(markdown: string): ReplyPlan {
  let content = markdown
  const force = content.trimStart().startsWith(LONG_REPLY_MARKER)
  if (force)
    content = content.trimStart().slice(LONG_REPLY_MARKER.length).trimStart()
  const complete = force || content.length > FORWARD_TEXT_THRESHOLD
  content = complete ? stripFences(content) : stripMarkdown(content)
  const bubbles = splitBubbles(content)
  return {
    content,
    bubbles,
    card:
      force ||
      content.length > FORWARD_TEXT_THRESHOLD ||
      bubbles.length > MAX_BUBBLES_PER_REPLY,
  }
}

export type SendErrorKind =
  | 'too_long'
  | 'bad_format'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'transient'
  | 'unknown'

const any = (blob: string, ...needles: string[]) =>
  needles.some(needle => blob.includes(needle))

/** hermes `classify_send_error` on the error text: the first matching kind wins. */
export function classifySendError(errorText: string): SendErrorKind {
  const blob = errorText.toLowerCase()
  if (blob.trim() === '') return 'unknown'
  if (any(blob, 'message_too_long', 'too long', 'message is too long'))
    return 'too_long'
  if (
    any(
      blob,
      "can't parse entities",
      'cant parse entities',
      "can't find end",
      'unsupported start tag',
    ) ||
    (blob.includes('entity') && blob.includes('parse')) ||
    (blob.includes('bad request') && blob.includes('entit'))
  )
    return 'bad_format'
  if (
    any(
      blob,
      'forbidden',
      'bot was blocked',
      'blocked by the user',
      'user is deactivated',
      'not enough rights',
      'have no rights',
      'not a member',
    )
  )
    return 'forbidden'
  if (
    any(
      blob,
      'chat not found',
      'message to edit not found',
      'message to reply not found',
      'thread not found',
      'topic_deleted',
      'message_id_invalid',
    )
  )
    return 'not_found'
  if (any(blob, 'flood', 'too many requests', 'retry after', 'rate limit'))
    return 'rate_limited'
  if (
    any(
      blob,
      'connecterror',
      'connectionerror',
      'connectionreset',
      'connectionrefused',
      'connecttimeout',
      'network',
      'broken pipe',
      'remotedisconnected',
      'eoferror',
    )
  )
    return 'transient'
  return 'unknown'
}

/** OneBot retcodes the words alone do not give away (grantley `_RETCODE_HINTS`). */
const RETCODE_HINTS = new Map<number, SendErrorKind>([
  [1401, 'forbidden'],
  [1403, 'forbidden'],
  [1404, 'not_found'],
  [10003, 'bad_format'],
  [10004, 'forbidden'],
])

/**
 * grantley `classify_onebot_error`: the shared classifier, then the
 * retcode table, then the Chinese phrases QQ backends use for being
 * kicked, muted or a target that is gone; never a hopeful guess.
 */
export function classifyOnebotError(
  retcode: number | undefined,
  message = '',
): SendErrorKind {
  const blob = [message, retcode === undefined ? '' : `retcode=${retcode}`]
    .filter(Boolean)
    .join(' ')
  const kind = classifySendError(blob)
  if (kind !== 'unknown') return kind
  const hinted = retcode === undefined ? undefined : RETCODE_HINTS.get(retcode)
  if (hinted !== undefined) return hinted
  if (any(message, '不存在', '未找到', '没有找到')) return 'not_found'
  if (any(message, '禁言', '无权', '权限', '拒绝', '被限制', '不是群成员'))
    return 'forbidden'
  if (any(message, '频繁', '过快', '限制发言')) return 'rate_limited'
  const lowered = message.toLowerCase()
  if (lowered.includes('too long') || message.includes('消息过长'))
    return 'too_long'
  if (any(lowered, 'timeout', 'timed out', 'connection', 'closed'))
    return 'transient'
  return 'unknown'
}
