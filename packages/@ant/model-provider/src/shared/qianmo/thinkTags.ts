// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reasoning written inline in the answer text — `<think>…</think>` and its
 * variants — split out of a Chat Completions stream (P18.8, hermes #8; design
 * `providers-console-m1.md` §5.6 row 8).
 *
 * MiniMax without `reasoning_split`, and local Qwen3 / R1-distilled models
 * served without a reasoning parser, put the chain of thought in
 * `delta.content` between tags. The stream adapter showed it as the answer
 * and replayed it as answer text on every later turn (hermes-research
 * §11.9-①B). Now the text between the tags becomes reasoning — the adapter's
 * thinking block — and only the rest is answer text.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/think_scrubber.py:43-54, 79-90` — the tag set (`think`,
 *     `thinking`, `reasoning`, `thought`, `REASONING_SCRATCHPAD`), matched
 *     case-insensitively; a closed pair counts anywhere, an unterminated
 *     open tag only at a block boundary (start of stream, or only whitespace
 *     since the last newline), so prose that mentions `<think>` is left alone;
 *   - `:106-202`, `:255-306` — inside a block, any close tag ends it; out of
 *     one, the earlier of a closed pair and a boundary open tag wins; a tail
 *     that may be the start of a tag is held back until the next delta
 *     settles it (`:344-364`);
 *   - `:204-233` — at the end of the stream a held tail that turned out not
 *     to be a tag is released as text;
 *   - `:308-341` — the block-boundary test;
 *   - `:366-396` — orphan close tags are removed from the text together with
 *     the whitespace after them.
 * Only the rules are taken; the code is ours.
 *
 * Qianmo differences:
 *   - hermes discards the text inside a block (its display shows reasoning
 *     elsewhere); here it is returned as reasoning, so it lands in the
 *     thinking block instead of being lost;
 *   - an unterminated block at the end of the stream stays reasoning — hermes
 *     drops it for the same reason it drops every block;
 *   - whitespace right after an open tag and right after a close tag is the
 *     tags' separator and is dropped, so `<think>\n\n</think>\n\nanswer`
 *     (Qwen3 with thinking off) gives the answer alone, not an empty thinking
 *     block and an answer starting with blank lines.
 */

const TAG_NAMES = [
  'think',
  'thinking',
  'reasoning',
  'thought',
  'REASONING_SCRATCHPAD',
] as const

/** Lower-cased: matching is case-insensitive. */
const OPEN_TAGS = TAG_NAMES.map(name => `<${name}>`.toLowerCase())
const CLOSE_TAGS = TAG_NAMES.map(name => `</${name}>`.toLowerCase())
const MAX_TAG_LENGTH = Math.max(
  ...[...OPEN_TAGS, ...CLOSE_TAGS].map(tag => tag.length),
)

const LEADING_SEPARATOR = /^[ \t\r\n]+/

export type InlineSegment = { kind: 'text' | 'reasoning'; text: string }

type Match = { index: number; length: number }

function firstTag(lower: string, tags: readonly string[]): Match | undefined {
  let best: Match | undefined
  for (const tag of tags) {
    const index = lower.indexOf(tag)
    if (index !== -1 && (best === undefined || index < best.index)) {
      best = { index, length: tag.length }
    }
  }
  return best
}

/** Length of the longest tail of `lower` that is a proper prefix of a tag. */
function partialTagSuffix(lower: string, tags: readonly string[]): number {
  for (
    let size = Math.min(lower.length, MAX_TAG_LENGTH - 1);
    size > 0;
    size--
  ) {
    const tail = lower.slice(-size)
    if (tags.some(tag => tag.length > size && tag.startsWith(tail))) {
      return size
    }
  }
  return 0
}

/** The earliest `<tag>…</tag>` of one variant, as offsets into the buffer. */
function earliestClosedPair(
  lower: string,
):
  | { start: number; innerStart: number; innerEnd: number; end: number }
  | undefined {
  let best:
    | { start: number; innerStart: number; innerEnd: number; end: number }
    | undefined
  for (const [i, open] of OPEN_TAGS.entries()) {
    const close = CLOSE_TAGS[i]!
    const start = lower.indexOf(open)
    if (start === -1) continue
    const innerStart = start + open.length
    const innerEnd = lower.indexOf(close, innerStart)
    if (innerEnd === -1) continue
    if (best === undefined || start < best.start) {
      best = { start, innerStart, innerEnd, end: innerEnd + close.length }
    }
  }
  return best
}

function stripOrphanCloseTags(text: string): string {
  if (!text.includes('</')) return text
  const lower = text.toLowerCase()
  let out = ''
  let i = 0
  while (i < text.length) {
    const tag = lower.startsWith('</', i)
      ? CLOSE_TAGS.find(close => lower.startsWith(close, i))
      : undefined
    if (tag === undefined) {
      out += text[i]
      i++
      continue
    }
    i += tag.length
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++
  }
  return out
}

/**
 * Splits streamed answer text into text and reasoning. One instance per
 * stream: {@link feed} each `delta.content`, {@link flush} at the end.
 */
export class InlineThinkSplitter {
  private inBlock = false
  /** A tail that may be the start of a tag, held for the next delta. */
  private held = ''
  /** The last text released ended a line, or none has been released. */
  private atLineStart = true
  /** A block just closed: drop the whitespace before the answer resumes. */
  private trimText = false
  /** A block just opened: drop the whitespace before its first word. */
  private trimReasoning = false

  feed(delta: string): InlineSegment[] {
    const out: InlineSegment[] = []
    if (delta === '') return out
    let buf = this.held + delta
    this.held = ''
    while (buf !== '') {
      const lower = buf.toLowerCase()
      if (this.inBlock) {
        const close = firstTag(lower, CLOSE_TAGS)
        if (close === undefined) {
          const keep = partialTagSuffix(lower, CLOSE_TAGS)
          this.pushReasoning(out, buf.slice(0, buf.length - keep))
          this.held = buf.slice(buf.length - keep)
          return out
        }
        this.pushReasoning(out, buf.slice(0, close.index))
        buf = buf.slice(close.index + close.length)
        this.inBlock = false
        this.trimText = true
        continue
      }

      const pair = earliestClosedPair(lower)
      const open = this.openAtBoundary(buf, lower)
      if (
        pair !== undefined &&
        (open === undefined || pair.start <= open.index)
      ) {
        this.pushText(out, buf.slice(0, pair.start))
        this.trimReasoning = true
        this.pushReasoning(out, buf.slice(pair.innerStart, pair.innerEnd))
        this.trimReasoning = false
        buf = buf.slice(pair.end)
        this.trimText = true
        continue
      }
      if (open !== undefined) {
        this.pushText(out, buf.slice(0, open.index))
        buf = buf.slice(open.index + open.length)
        this.inBlock = true
        this.trimReasoning = true
        continue
      }

      const keep = Math.max(
        partialTagSuffix(lower, OPEN_TAGS),
        partialTagSuffix(lower, CLOSE_TAGS),
      )
      this.pushText(out, buf.slice(0, buf.length - keep))
      this.held = buf.slice(buf.length - keep)
      return out
    }
    return out
  }

  /** End of stream: release what was held, and start over. */
  flush(): InlineSegment[] {
    const out: InlineSegment[] = []
    if (this.inBlock) this.pushReasoning(out, this.held)
    else this.pushText(out, this.held)
    this.inBlock = false
    this.held = ''
    this.atLineStart = true
    this.trimText = false
    this.trimReasoning = false
    return out
  }

  private openAtBoundary(buf: string, lower: string): Match | undefined {
    let best: Match | undefined
    for (const tag of OPEN_TAGS) {
      for (
        let index = lower.indexOf(tag);
        index !== -1;
        index = lower.indexOf(tag, index + 1)
      ) {
        if (!this.isBlockBoundary(buf, index)) continue
        if (best === undefined || index < best.index) {
          best = { index, length: tag.length }
        }
        break
      }
    }
    return best
  }

  private isBlockBoundary(buf: string, index: number): boolean {
    const before = buf.slice(0, index)
    const lastNewline = before.lastIndexOf('\n')
    if (lastNewline === -1) return this.atLineStart && before.trim() === ''
    return before.slice(lastNewline + 1).trim() === ''
  }

  private pushText(out: InlineSegment[], raw: string): void {
    let text = stripOrphanCloseTags(raw)
    if (this.trimText) text = text.replace(LEADING_SEPARATOR, '')
    if (text === '') return
    this.trimText = false
    this.atLineStart = text.endsWith('\n')
    push(out, 'text', text)
  }

  private pushReasoning(out: InlineSegment[], raw: string): void {
    const text = this.trimReasoning ? raw.replace(LEADING_SEPARATOR, '') : raw
    if (text === '') return
    this.trimReasoning = false
    push(out, 'reasoning', text)
  }
}

function push(
  out: InlineSegment[],
  kind: InlineSegment['kind'],
  text: string,
): void {
  const last = out.at(-1)
  if (last?.kind === kind) last.text += text
  else out.push({ kind, text })
}
