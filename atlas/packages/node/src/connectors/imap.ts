// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { LIMITS } from '@qianmo/protocol'
import { OutboundPolicy } from '../commands/outboundPolicy.js'
import { Wire, imapQuote, headerValue, utf8Prefix } from './wire.js'

export interface MailSettings {
  readonly imapHost: string
  readonly imapPort: number
  readonly smtpHost: string
  readonly smtpPort: number
  readonly smtpTls: 'smtps' | 'starttls'
  readonly username: string
}
interface Reply {
  lines: string[]
  literals: Buffer[]
}
type Sexp = string | number | null | Sexp[]
function sexp(raw: string): Sexp {
  const tokens = raw.match(/\(|\)|"(?:\\.|[^"\\])*"|[^\s()]+/g) ?? []
  let offset = 0
  const read = (depth: number): Sexp => {
    if (depth > 30) throw new Error('邮件结构过深')
    const token = tokens[offset++]
    if (token === '(') {
      const values: Sexp[] = []
      while (tokens[offset] !== ')') {
        if (offset >= tokens.length) throw new Error('邮件结构无效')
        values.push(read(depth + 1))
      }
      offset++
      return values
    }
    if (!token || token === ')') throw new Error('邮件结构无效')
    return token.startsWith('"')
      ? token.slice(1, -1).replace(/\\(.)/g, '$1')
      : token.toUpperCase() === 'NIL'
        ? null
        : /^\d+$/.test(token)
          ? Number(token)
          : token
  }
  return read(0)
}
function parameter(value: Sexp | undefined, key: string): string | null {
  if (!Array.isArray(value)) return null
  for (let i = 0; i < value.length; i += 2)
    if (
      String(value[i]).toUpperCase() === key &&
      typeof value[i + 1] === 'string'
    )
      return value[i + 1] as string
  return null
}
export function mailParts(raw: string): {
  text: { part: string; encoding: string } | null
  attachments: { name: string; size: number }[]
} {
  const result: {
    text: { part: string; encoding: string } | null
    attachments: { name: string; size: number }[]
  } = { text: null, attachments: [] }
  const visit = (node: Sexp, path: string): void => {
    if (!Array.isArray(node)) throw new Error('邮件结构无效')
    if (Array.isArray(node[0])) {
      for (let i = 0; Array.isArray(node[i]); i++)
        visit(node[i]!, path ? `${path}.${i + 1}` : `${i + 1}`)
      return
    }
    const type = String(node[0]).toUpperCase(),
      subtype = String(node[1]).toUpperCase()
    const disposition = node[type === 'TEXT' ? 9 : type === 'MESSAGE' ? 11 : 8]
    const attached =
      Array.isArray(disposition) &&
      String(disposition[0]).toUpperCase() === 'ATTACHMENT'
    const name =
      parameter(
        Array.isArray(disposition) ? disposition[1] : null,
        'FILENAME',
      ) ?? parameter(node[2], 'NAME')
    if (attached || name !== null)
      result.attachments.push({
        name: headerValue(name ?? 'attachment'),
        size: typeof node[6] === 'number' ? node[6] : 0,
      })
    else if (type === 'TEXT' && subtype === 'PLAIN' && !result.text)
      result.text = {
        part: path || 'TEXT',
        encoding: String(node[5]).toUpperCase(),
      }
  }
  visit(sexp(raw), '')
  return result
}
export function decodeWords(value: string): string {
  const joined = value.replace(
    /(=\?utf-8\?[bq]\?[^?]*\?=)[ \t]+(?==\?utf-8\?[bq]\?)/gi,
    '$1',
  )
  return joined.replace(
    /=\?utf-8\?([bq])\?([^?]*)\?=/gi,
    (_all: string, kind: string, data: string) =>
      kind.toLowerCase() === 'b'
        ? Buffer.from(data, 'base64').toString('utf8')
        : Buffer.from(
            data
              .replace(/_/g, ' ')
              .replace(/=([a-f\d]{2})/gi, (_v: string, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
              ),
            'latin1',
          ).toString('utf8'),
  )
}
export function mailHeaders(raw: string): Record<string, string> {
  const unfolded = raw.replace(/\r\n[ \t]+/g, ' ')
  const result: Record<string, string> = {}
  for (const line of unfolded.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).toLowerCase()
    if (['subject', 'from', 'to', 'date'].includes(key))
      result[key] = utf8Prefix(
        Buffer.from(headerValue(decodeWords(line.slice(colon + 1).trim()))),
        512,
      )
  }
  return result
}

export class ImapClient {
  readonly #wire: Wire
  #tag = 0
  private constructor(wire: Wire) {
    this.#wire = wire
  }
  static async login(
    policy: OutboundPolicy,
    settings: MailSettings,
    secret: string,
  ): Promise<ImapClient> {
    const wire = new Wire(
      await policy.connect('imaps', settings.imapHost, settings.imapPort),
    )
    const client = new ImapClient(wire)
    try {
      if (!/^\* OK\b/i.test(await wire.line()))
        throw new Error('IMAP 欢迎响应无效')
      await client.command(
        `LOGIN ${imapQuote(settings.username)} ${imapQuote(secret)}`,
      )
      return client
    } catch {
      wire.close()
      throw new Error('IMAP 登录失败')
    }
  }
  async command(
    command: string,
    literalLimit: number = LIMITS.connectorLineBytes,
  ): Promise<Reply> {
    const tag = `A${++this.#tag}`
    this.#wire.send(`${tag} ${command}`)
    const reply: Reply = { lines: [], literals: [] }
    let bytes = 0
    for (;;) {
      const line = await this.#wire.line()
      bytes += Buffer.byteLength(line)
      if (bytes > LIMITS.connectorResponseBytes)
        throw new Error('IMAP 响应超过上限')
      if (line.startsWith(`${tag} `)) {
        if (!line.startsWith(`${tag} OK`)) throw new Error('IMAP 操作失败')
        return reply
      }
      if (/^\* BYE\b/.test(line) && command !== 'LOGOUT')
        throw new Error('IMAP 连接结束')
      reply.lines.push(line)
      const literal = /\{(\d+)\}$/.exec(line)
      if (literal) {
        const size = Number(literal[1])
        bytes += size
        if (bytes > LIMITS.connectorResponseBytes)
          throw new Error('IMAP 响应超过上限')
        reply.literals.push(await this.#wire.literal(size, literalLimit))
      }
    }
  }
  #uid(reply: Reply, uid: string): void {
    const fetched = reply.lines.filter(v => /^\* \d+ FETCH\b/i.test(v))
    if (
      !fetched.length ||
      fetched.some(v => /\bUID (\d+)\b/i.exec(v)?.[1] !== uid)
    )
      throw new Error('IMAP 邮件 UID 不符')
  }
  async select(folder: string): Promise<string> {
    const result = await this.command(`EXAMINE ${imapQuote(folder)}`)
    const validity = /\[UIDVALIDITY (\d+)\]/i.exec(result.lines.join(' '))?.[1]
    if (!validity) throw new Error('IMAP 未提供 UIDVALIDITY')
    return validity
  }
  async search(input: {
    query?: string
    since?: string
    limit?: number
  }): Promise<{ uid: string; headers: Record<string, string> }[]> {
    const clauses = [input.query ? `TEXT ${imapQuote(input.query)}` : 'ALL']
    if (input.since) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(input.since) ||
        !Number.isFinite(Date.parse(input.since))
      )
        throw new Error('邮件日期无效')
      const date = new Date(input.since)
      clauses.push(
        `SINCE ${date.getUTCDate()}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]}-${date.getUTCFullYear()}`,
      )
    }
    const result = await this.command(`UID SEARCH ${clauses.join(' ')}`)
    const ids =
      result.lines
        .find(v => v.startsWith('* SEARCH'))
        ?.slice(8)
        .trim()
        .split(/\s+/)
        .filter(v => /^\d+$/.test(v)) ?? []
    const messages = []
    for (const uid of ids.slice(-(input.limit ?? 10)).reverse()) {
      const fetched = await this.command(
        `UID FETCH ${uid} (UID BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO DATE)]<0.${LIMITS.connectorLineBytes}>)`,
      )
      this.#uid(fetched, uid)
      messages.push({
        uid,
        headers: mailHeaders(fetched.literals[0]?.toString('utf8') ?? ''),
      })
    }
    return messages
  }
  async read(uid: string): Promise<{
    headers: Record<string, string>
    body: string
    truncated: boolean
    attachments: { name: string; size: number }[]
  }> {
    if (!/^\d+$/.test(uid)) throw new Error('邮件 UID 无效')
    const meta = await this.command(
      `UID FETCH ${uid} (UID BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO DATE)]<0.${LIMITS.connectorLineBytes}>)`,
    )
    this.#uid(meta, uid)
    const structure = meta.lines
      .map(v => /BODYSTRUCTURE\s+(\(.+)/i.exec(v)?.[1])
      .find(v => v !== undefined)
    if (!structure) throw new Error('邮件不存在或结构无效')
    const parts = mailParts(structure)
    let body = '',
      truncated = false
    if (parts.text) {
      const text = await this.command(
        `UID FETCH ${uid} (UID BODY.PEEK[${parts.text.part}]<0.${LIMITS.connectorTextBytes}>)`,
        LIMITS.connectorTextBytes,
      )
      this.#uid(text, uid)
      const raw = text.literals[0] ?? Buffer.alloc(0)
      const decoded =
        parts.text.encoding === 'BASE64'
          ? Buffer.from(raw.toString('ascii'), 'base64')
          : parts.text.encoding === 'QUOTED-PRINTABLE'
            ? Buffer.from(
                raw
                  .toString('latin1')
                  .replace(/=\r\n/g, '')
                  .replace(/=([a-f\d]{2})/gi, (_v: string, hex: string) =>
                    String.fromCharCode(Number.parseInt(hex, 16)),
                  ),
                'latin1',
              )
            : raw
      body = utf8Prefix(decoded, LIMITS.connectorTextBytes)
      truncated = raw.length === LIMITS.connectorTextBytes
    }
    return {
      headers: mailHeaders(meta.literals[0]?.toString('utf8') ?? ''),
      body,
      truncated,
      attachments: parts.attachments,
    }
  }
  async logout(): Promise<void> {
    try {
      await this.command('LOGOUT')
    } finally {
      this.#wire.close()
    }
  }
  close(): void {
    this.#wire.close()
  }
}
