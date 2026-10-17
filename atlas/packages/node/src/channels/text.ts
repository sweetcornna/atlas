// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Text rules shared by every chat platform: intentional silence, splitting a
 * long reply without breaking code blocks, and rendering the agent's markdown
 * into each platform's own dialect (Telegram MarkdownV2, Slack mrkdwn, plain
 * text for QQ and WeChat; Discord renders markdown natively).
 *
 * Ported from grantley's `gateway/silence.py` and
 * `platforms/telegram/formatting.py`.
 */

const SILENT_MARKERS = new Set(['[SILENT]', 'SILENT', 'NO_REPLY', '[NO_REPLY]'])

function stripEdgePunctuation(text: string): string {
  const punctuation = /[\p{P}]/u
  let start = 0
  let end = text.length
  while (
    start < end &&
    !'[]'.includes(text[start]!) &&
    punctuation.test(text[start]!)
  )
    start++
  while (
    end > start &&
    !'[]'.includes(text[end - 1]!) &&
    punctuation.test(text[end - 1]!)
  )
    end--
  return text.slice(start, end).trim()
}

/**
 * The agent chose not to answer: empty, or exactly a silence marker (stray
 * edge punctuation such as `*NO_REPLY*` allowed). Prose that merely mentions
 * the marker is a real reply.
 */
export function isSilence(reply: string): boolean {
  const text = reply.trim()
  if (text === '') return true
  const bare = stripEdgePunctuation(text)
  return [text, bare, text.toUpperCase(), bare.toUpperCase()].some(candidate =>
    SILENT_MARKERS.has(candidate),
  )
}

/**
 * Splits a reply into chunks of at most `limit` characters, preferring line
 * then word boundaries. A split inside a fenced code block closes the fence
 * and reopens it (with its language) in the next chunk; several chunks get
 * `(1/3)` markers. Lengths are UTF-16 code units, the unit Telegram counts
 * its limit in and the stricter one for every other platform.
 */
export function splitMessage(content: string, limit: number): string[] {
  if (content.length <= limit) return [content]
  const reserve = 10
  const fenceClose = '\n```'
  const chunks: string[] = []
  let remaining = content
  let carry: string | null = null
  while (remaining.length > 0) {
    const prefix = carry === null ? '' : `\`\`\`${carry}\n`
    let headroom = limit - reserve - prefix.length - fenceClose.length
    if (headroom < 1) headroom = Math.max(1, Math.floor(limit / 2))
    if (prefix.length + remaining.length <= limit - reserve) {
      let last = prefix + remaining
      let open = carry !== null
      for (const line of remaining.split('\n'))
        if (line.trim().startsWith('```')) open = !open
      if (open) last += fenceClose
      chunks.push(last)
      break
    }
    const region = remaining.slice(0, headroom)
    let splitAt = region.lastIndexOf('\n')
    if (splitAt < headroom / 2) splitAt = region.lastIndexOf(' ')
    if (splitAt < 1) splitAt = Math.max(1, headroom)
    // Keep a surrogate pair together.
    const code = remaining.charCodeAt(splitAt - 1)
    if (code >= 0xd800 && code <= 0xdbff) splitAt++
    // Never leave an inline code span open across chunks.
    const candidate = remaining.slice(0, splitAt)
    if (
      ((candidate.match(/`/g) ?? []).length -
        (candidate.match(/\\`/g) ?? []).length) %
        2 ===
      1
    ) {
      const lastTick = candidate.lastIndexOf('`')
      const safe = Math.max(
        candidate.lastIndexOf(' ', lastTick),
        candidate.lastIndexOf('\n', lastTick),
      )
      if (safe > headroom / 4) splitAt = safe
    }
    const body = remaining.slice(0, splitAt)
    remaining = remaining.slice(splitAt).replace(/^\s+/, '')
    let chunk = prefix + body
    let open = carry !== null
    let language: string = carry ?? ''
    for (const line of body.split('\n')) {
      const stripped = line.trim()
      if (!stripped.startsWith('```')) continue
      if (open) {
        open = false
        language = ''
      } else {
        open = true
        language = stripped.slice(3).trim().split(/\s+/)[0] ?? ''
      }
    }
    if (open) {
      chunk += fenceClose
      carry = language
    } else carry = null
    chunks.push(chunk)
  }
  if (chunks.length === 1) return chunks
  return chunks.map(
    (chunk, index) => `${chunk} (${index + 1}/${chunks.length})`,
  )
}

// -- tables -----------------------------------------------------------------

const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*){1,}\|?\s*$/

function tableCells(row: string): string[] {
  let text = row.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split('|').map(cell => cell.trim())
}

function renderTable(block: readonly string[]): string {
  const headers = tableCells(block[0]!)
  if (block.length < 3 || headers.length < 2) return block.join('\n')
  const labelled = tableCells(block[2]!).length === headers.length + 1
  return block
    .slice(2)
    .map((row, index) => {
      const cells = tableCells(row)
      const heading = labelled
        ? cells[0] || `Row ${index + 1}`
        : (cells.find(Boolean) ?? `Row ${index + 1}`)
      const data = (labelled ? cells.slice(1) : cells).slice(0, headers.length)
      while (data.length < headers.length) data.push('')
      const bullets = headers
        .map((header, column) =>
          !labelled && data[column] === heading
            ? null
            : `• ${header}: ${data[column]}`,
        )
        .filter(line => line !== null)
      return [`**${heading}**`, ...bullets].join('\n')
    })
    .join('\n\n')
}

/** Pipe tables become bold headings with bullets; no chat app draws tables. */
export function tablesToBullets(text: string): string {
  if (!text.includes('|') || !text.includes('-')) return text
  const lines = text.split('\n')
  const out: string[] = []
  let fenced = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced
      out.push(line)
      continue
    }
    if (
      !fenced &&
      line.includes('|') &&
      index + 1 < lines.length &&
      TABLE_SEPARATOR.test(lines[index + 1]!)
    ) {
      const block = [line, lines[index + 1]!]
      let next = index + 2
      while (next < lines.length && lines[next]!.trim().includes('|'))
        block.push(lines[next++]!)
      out.push(renderTable(block))
      index = next - 1
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

// -- placeholders -----------------------------------------------------------

/** Private-use brackets around stash slots; markdown rules never produce them. */
const OPEN = '\uE000'
const CLOSE = '\uE001'
const SLOT = /\uE000(\d+)\uE001/g

class Stash {
  readonly #values: string[] = []
  put(value: string): string {
    this.#values.push(value)
    return `${OPEN}${this.#values.length - 1}${CLOSE}`
  }
  restore(text: string): string {
    let result = text
    for (let pass = 0; pass < 3 && result.includes(OPEN); pass++)
      result = result.replace(
        SLOT,
        (_m, index: string) => this.#values[Number(index)] ?? '',
      )
    return result
  }
}

const FENCED = /```(?:[^\n]*\n)?[\s\S]*?```/g
const INLINE_CODE = /`[^`\n]+`/g
const LINK = /\[([^\]]+)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)/g

// -- Telegram MarkdownV2 ------------------------------------------------------

const MDV2_SPECIAL = /([_*[\]()~`>#+\-=|{}.!\\])/g

export function escapeMarkdownV2(text: string): string {
  return text.replace(MDV2_SPECIAL, '\\$1')
}

/** Standard markdown to Telegram MarkdownV2; everything else escaped. */
export function telegramMarkdownV2(markdown: string): string {
  if (markdown === '') return markdown
  const stash = new Stash()
  let text = tablesToBullets(markdown)
  text = text.replace(FENCED, raw => {
    const newline = raw.indexOf('\n')
    const openEnd = newline !== -1 && newline < raw.length - 3 ? newline + 1 : 3
    const body = raw
      .slice(openEnd, -3)
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
    return stash.put(`${raw.slice(0, openEnd)}${body}\`\`\``)
  })
  text = text.replace(INLINE_CODE, raw => stash.put(raw.replace(/\\/g, '\\\\')))
  text = text.replace(LINK, (_m, display: string, url: string) =>
    stash.put(
      `[${escapeMarkdownV2(display)}](${url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)')})`,
    ),
  )
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_m, title: string) =>
    stash.put(
      `*${escapeMarkdownV2(title.trim().replace(/\*\*(.+?)\*\*/g, '$1'))}*`,
    ),
  )
  text = text.replace(/\*\*(.+?)\*\*/g, (_m, inner: string) =>
    stash.put(`*${escapeMarkdownV2(inner)}*`),
  )
  text = text.replace(/\*([^*\n]+)\*/g, (_m, inner: string) =>
    stash.put(`_${escapeMarkdownV2(inner)}_`),
  )
  text = text.replace(/~~(.+?)~~/g, (_m, inner: string) =>
    stash.put(`~${escapeMarkdownV2(inner)}~`),
  )
  text = text.replace(/\|\|(.+?)\|\|/g, (_m, inner: string) =>
    stash.put(`||${escapeMarkdownV2(inner)}||`),
  )
  text = text.replace(/^(>{1,3}) (.+)$/gm, (_m, marker: string, body: string) =>
    stash.put(`${marker} ${escapeMarkdownV2(body)}`),
  )
  return stash.restore(escapeMarkdownV2(text))
}

// -- Slack mrkdwn -------------------------------------------------------------

function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Standard markdown to Slack mrkdwn (`*bold*`, `_italic_`, `<url|text>`). */
export function slackMrkdwn(markdown: string): string {
  const stash = new Stash()
  let text = tablesToBullets(markdown)
  text = text.replace(FENCED, raw =>
    stash.put(
      `\`\`\`\n${escapeSlack(raw.replace(/^```[^\n]*\n?/, '').slice(0, -3))}\`\`\``,
    ),
  )
  text = text.replace(INLINE_CODE, raw => stash.put(escapeSlack(raw)))
  text = text.replace(LINK, (_m, display: string, url: string) =>
    stash.put(`<${url}|${escapeSlack(display)}>`),
  )
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_m, title: string) =>
    stash.put(`*${escapeSlack(title.trim().replace(/\*\*(.+?)\*\*/g, '$1'))}*`),
  )
  text = text.replace(/\*\*(.+?)\*\*/g, (_m, inner: string) =>
    stash.put(`*${escapeSlack(inner)}*`),
  )
  text = text.replace(
    /(?<![*\w])\*([^*\n]+)\*(?![*\w])/g,
    (_m, inner: string) => stash.put(`_${escapeSlack(inner)}_`),
  )
  text = text.replace(/~~(.+?)~~/g, (_m, inner: string) =>
    stash.put(`~${escapeSlack(inner)}~`),
  )
  text = text.replace(/^>\s?(.*)$/gm, (_m, body: string) =>
    stash.put(`> ${escapeSlack(body)}`),
  )
  return stash.restore(escapeSlack(text))
}

// -- plain text (QQ, WeChat) ---------------------------------------------------

/**
 * Markdown for platforms that show text as typed. Code keeps its content
 * (fences dropped), links keep their address, emphasis markers go.
 */
export function plainText(markdown: string): string {
  const stash = new Stash()
  let text = tablesToBullets(markdown)
  text = text.replace(FENCED, raw =>
    stash.put(
      raw
        .replace(/^```[^\n]*\n?/, '')
        .slice(0, -3)
        .replace(/\n$/, ''),
    ),
  )
  text = text.replace(INLINE_CODE, raw => stash.put(raw.slice(1, -1)))
  text = text.replace(LINK, (_m, display: string, url: string) =>
    stash.put(display === url ? url : `${display}（${url}）`),
  )
  text = text
    .replace(/^#{1,6}\s+(.+)$/gm, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
  return stash.restore(text).trim()
}

/** Discord draws markdown itself; only tables need rewriting. */
export function discordMarkdown(markdown: string): string {
  return tablesToBullets(markdown)
}

/**
 * `MEDIA:<path>` lines the agent wrote. Attachments travel through the node's
 * file publication (P20), which this version does not drive yet, so the
 * lines are removed and counted.
 */
export function extractMedia(text: string): { text: string; dropped: number } {
  let dropped = 0
  const cleaned = text.replace(/^\s*MEDIA:\s*\S.*$/gm, () => {
    dropped++
    return ''
  })
  return {
    text: dropped === 0 ? text : cleaned.replace(/\n{3,}/g, '\n\n').trim(),
    dropped,
  }
}
