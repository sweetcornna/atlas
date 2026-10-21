// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
// 规则来源 NousResearch/hermes-agent `plugins/platforms/weixin/adapter.py:15`、`:56-78`、`:264-269`、`:394-518`、`:701-706`、`:716-737`、`:879-890`、`:965-975`、`:1205-1206`、`:1402-1407`，`gateway/platforms/helpers.py:548-570`，取于 `63220ae5`，取用日期 2026-10-19

/**
 * WeChat (iLink) message rules (`runtimes-channels.md` §2.6), rewritten in
 * TypeScript after hermes-agent's Weixin adapter:
 *
 * - a group is named by `room_id` / `chat_room_id`, or by a `to_user_id`
 *   that is not the bot on a user message (`_guess_chat_type`);
 * - iLink re-sends the same text under new message ids: one sender's
 *   identical text counts once in five minutes (content dedup);
 * - Markdown stays (WeChat renders it, code blocks too); blank runs are
 *   squeezed and long prose lines wrapped at 120 so they can be copied;
 * - one message when it fits 2000 characters, except a short chatty
 *   exchange (two to six short lines), which goes out line by line; a
 *   longer reply is packed by Markdown blocks;
 * - `-2` "too frequent" opens a 30-second circuit; `-2` with "unknown
 *   error" / "prepare failed" is a stale session, like `-14`.
 */

import { createHash } from 'node:crypto'
import { text } from '../net.js'
import { splitMessage } from '../text.js'
import type { ChannelChat, ChannelTextBatch } from '../types.js'

/** hermes `MAX_MESSAGE_LENGTH`. */
export const WEIXIN_MAX_MESSAGE_LENGTH = 2_000
/** hermes `WEIXIN_COPY_LINE_WIDTH`. */
const COPY_LINE_WIDTH = 120
/** hermes `MESSAGE_DEDUP_TTL_SECONDS`. */
const DEDUP_TTL_MS = 300_000
const DEDUP_KEPT = 2_000
/** hermes `rate_limit_circuit_open_seconds`. */
export const WEIXIN_RATE_CIRCUIT_MS = 30_000
/** hermes shared text-batch cadence (`_configure_text_batch_delays`). */
export const WEIXIN_TEXT_BATCH: ChannelTextBatch = {
  quietMs: 300,
  splitMs: 1_000,
}

const HEADER = /^(#{1,6})\s+(.+?)\s*$/
const TABLE_RULE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/
const FENCE = /^```([^\n`]*)\s*$/

/** hermes `_guess_chat_type`. */
export function weixinChat(
  message: Record<string, unknown>,
  accountId: string,
): ChannelChat {
  const room = (text(message.room_id) || text(message.chat_room_id)).trim()
  const to = text(message.to_user_id).trim()
  if (
    room !== '' ||
    (to !== '' &&
      accountId !== '' &&
      to !== accountId &&
      Number(message.msg_type) === 1)
  )
    return {
      type: 'group',
      id: room || to || text(message.from_user_id),
    }
  return { type: 'dm', id: text(message.from_user_id) }
}

/** hermes content fingerprint: `content:<sender>:<md5>`. */
export function contentKey(sender: string, body: string): string {
  return `content:${sender}:${createHash('md5').update(body).digest('hex')}`
}

/** hermes `MessageDeduplicator` with a five-minute window, for the content fingerprints. */
export class ContentDedup {
  readonly #seen = new Map<string, number>()
  readonly #now: () => number

  constructor(now: () => number) {
    this.#now = now
  }

  /** True when `key` was seen in the window; otherwise it is remembered. */
  duplicate(key: string): boolean {
    const now = this.#now()
    const at = this.#seen.get(key)
    if (at !== undefined && now - at < DEDUP_TTL_MS) return true
    this.#seen.delete(key)
    this.#seen.set(key, now)
    if (this.#seen.size > DEDUP_KEPT)
      for (const [old, when] of this.#seen)
        if (now - when >= DEDUP_TTL_MS || this.#seen.size > DEDUP_KEPT)
          this.#seen.delete(old)
        else break
    return false
  }
}

/** iLink `-2` that is a stale session rather than a rate limit (hermes `_is_stale_session_ret`). */
export function staleSession(code: number, message: string): boolean {
  return (
    code === -2 &&
    ['unknown error', 'prepare failed'].includes(message.toLowerCase())
  )
}

/** Python `str.splitlines()` for the line endings a reply has. */
function lines(content: string): string[] {
  if (content === '') return []
  const out = content.split(/\r\n|\r|\n/)
  if (out[out.length - 1] === '') out.pop()
  return out
}

/** hermes `_walk_markdown_lines`: in-code state is the one before a fence toggles it. */
function* walk(
  content: string,
): Generator<readonly [line: string, fence: boolean, inCode: boolean]> {
  let inCode = false
  for (const raw of lines(content)) {
    const line = raw.trimEnd()
    const fence = FENCE.test(line.trim())
    yield [line, fence, inCode]
    if (fence) inCode = !inCode
  }
}

/** hermes `_normalize_markdown_blocks`: lines right-trimmed, blank runs squeezed, code untouched. */
export function normalizeMarkdownBlocks(content: string): string {
  const result: string[] = []
  let blank = 0
  for (const [line, fence, inCode] of walk(content)) {
    if (!fence && !inCode && line.trim() === '') {
      blank++
      if (blank <= 1) result.push('')
      continue
    }
    if (fence || !inCode) blank = 0
    result.push(line)
  }
  return result.join('\n').trim()
}

/** `textwrap.wrap(width, break_long_words=False, break_on_hyphens=False)`. */
function wrap(line: string, width: number): string[] {
  const out: string[] = []
  let current = ''
  for (const chunk of line.split(/(\s+)/).filter(Boolean)) {
    const space = chunk.trim() === ''
    if (current === '' && space && out.length > 0) continue
    if ((current + chunk).length <= width) {
      current += chunk
      continue
    }
    if (current.trim() !== '') out.push(current.trimEnd())
    current = space ? '' : chunk
  }
  if (current.trim() !== '') out.push(current.trimEnd())
  return out.length > 0 ? out : [line]
}

/** hermes `_wrap_copy_friendly_lines_for_weixin`: prose lines past 120 are wrapped; code and tables are not. */
export function wrapCopyFriendlyLines(content: string): string {
  if (content === '') return content
  const wrapped: string[] = []
  for (const [line, fence, inCode] of walk(content)) {
    const stripped = line.trim()
    const keep =
      fence ||
      inCode ||
      line.length <= COPY_LINE_WIDTH ||
      stripped === '' ||
      stripped.startsWith('|')
    if (keep || TABLE_RULE.test(stripped)) wrapped.push(line)
    else wrapped.push(...wrap(line, COPY_LINE_WIDTH))
  }
  return wrapped.join('\n').trim()
}

/** hermes `format_message`. */
export function formatForWeixin(content: string): string {
  return wrapCopyFriendlyLines(normalizeMarkdownBlocks(content))
}

/** hermes `_split_markdown_blocks`: paragraphs, a fenced block whole. */
export function splitMarkdownBlocks(content: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join('\n').trim())
      current = []
    }
  }
  for (const [line, fence, inCode] of walk(content)) {
    if (fence && !inCode) flush()
    if (fence || inCode || line.trim() !== '') current.push(line)
    else flush()
    if (fence && inCode) flush()
  }
  flush()
  return blocks.filter(Boolean)
}

/** hermes `_split_delivery_units_for_weixin`: top-level lines; indented lines stay with the one above. */
function deliveryUnits(content: string): string[] {
  const units: string[] = []
  for (const block of splitMarkdownBlocks(content)) {
    if (FENCE.test((lines(block)[0] ?? '').trim())) {
      units.push(block)
      continue
    }
    let current: string[] = []
    for (const raw of lines(block)) {
      const line = raw.trimEnd()
      if (current.length > 0 && line.trim() !== '' && /^[ \t]/.test(raw)) {
        current.push(line)
        continue
      }
      units.push(current.join('\n').trim())
      current = line.trim() !== '' ? [line] : []
    }
    units.push(current.join('\n').trim())
  }
  return units.filter(Boolean)
}

/** hermes `_looks_like_chatty_line_for_weixin`. */
function chattyLine(line: string): boolean {
  const stripped = line.trim()
  return (
    stripped !== '' &&
    stripped.length <= 48 &&
    !/^[ \t]/.test(line) &&
    !/^[>\-*【#|]/.test(stripped) &&
    !TABLE_RULE.test(stripped) &&
    !/^\*\*[^*]+\*\*$/.test(stripped) &&
    !/^\d+\.\s/.test(stripped)
  )
}

/** hermes `_should_split_short_chat_block_for_weixin`: two to six short chatty lines, not under a heading. */
export function chattyBlock(block: string): boolean {
  const kept = lines(block).filter(line => line.trim() !== '')
  if (kept.length < 2 || kept.length > 6) return false
  const first = kept[0]!.trim()
  if (
    HEADER.test(first) ||
    (first.length <= 24 && (first.endsWith(':') || first.endsWith('：')))
  )
    return false
  return kept.every(chattyLine)
}

/** hermes `greedy_pack_blocks`, an oversized block cut by `splitMessage`. */
function packBlocks(blocks: readonly string[], max: number): string[] {
  const packed: string[] = []
  let current = ''
  for (const block of blocks) {
    const candidate = current === '' ? block : `${current}\n\n${block}`
    if (candidate.length <= max) {
      current = candidate
      continue
    }
    if (current !== '') {
      packed.push(current)
      current = ''
    }
    if (block.length <= max) current = block
    else packed.push(...splitMessage(block, max))
  }
  if (current !== '') packed.push(current)
  return packed
}

/** hermes `_split_text_for_weixin_delivery` (compact mode). */
export function splitForWeixin(
  content: string,
  max = WEIXIN_MAX_MESSAGE_LENGTH,
): string[] {
  if (content === '') return []
  if (content.length > max) {
    const packed = packBlocks(splitMarkdownBlocks(content), max)
    return packed.length > 0 ? packed : [content]
  }
  return chattyBlock(content) ? deliveryUnits(content) : [content]
}
