// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as tls from 'node:tls'
import * as net from 'node:net'
import { LIMITS } from '@qianmo/protocol'
import { OutboundPolicy } from '../commands/outboundPolicy.js'
import { Wire, mailbox, headerValue } from './wire.js'
import type { MailSettings } from './imap.js'

export function encodedHeader(raw: string): string {
  headerValue(raw)
  if (/^[\x20-\x7e]{0,60}$/.test(raw)) return raw
  const pieces: string[] = []
  let part = ''
  for (const char of raw) {
    if (Buffer.byteLength(part + char) > 30) {
      pieces.push(`=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`)
      part = ''
    }
    part += char
  }
  if (part) pieces.push(`=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`)
  return pieces.join('\r\n ')
}
export function dotEscape(raw: string): string {
  return raw.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..')
}
export function mailData(
  from: string,
  to: readonly string[],
  subject: string,
  body: string,
): string {
  mailbox(from)
  to.forEach(mailbox)
  headerValue(subject)
  if (
    typeof body !== 'string' ||
    Buffer.byteLength(body) > LIMITS.connectorTextBytes
  )
    throw new Error('邮件正文超过上限')
  return dotEscape(
    [
      `From: ${from}`,
      `To: ${to.join(',\r\n ')}`,
      `Subject: ${encodedHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body)
        .toString('base64')
        .match(/.{1,76}/g)
        ?.join('\r\n') ?? '',
    ].join('\r\n'),
  )
}
export class SmtpClient {
  #wire: Wire
  private constructor(wire: Wire) {
    this.#wire = wire
  }
  async #reply(expected: readonly number[]): Promise<string[]> {
    const lines: string[] = []
    for (;;) {
      const line = await this.#wire.line()
      if (!/^\d{3}[- ]/.test(line) || lines.length >= 100)
        throw new Error('SMTP 响应无效')
      lines.push(line)
      if (line[3] === ' ') {
        if (!expected.includes(Number(line.slice(0, 3))))
          throw new Error('SMTP 操作失败')
        return lines
      }
    }
  }
  async #command(
    value: string,
    expected: readonly number[],
  ): Promise<string[]> {
    this.#wire.send(value)
    return this.#reply(expected)
  }
  static async login(
    policy: OutboundPolicy,
    settings: MailSettings,
    secret: string,
  ): Promise<SmtpClient> {
    const client = new SmtpClient(
      new Wire(
        await policy.connect(
          settings.smtpTls,
          settings.smtpHost,
          settings.smtpPort,
        ),
      ),
    )
    try {
      await client.#reply([220])
      let ehlo = await client.#command('EHLO qianmo.local', [250])
      if (settings.smtpTls === 'starttls') {
        if (!ehlo.some(v => /\bSTARTTLS\b/i.test(v)))
          throw new Error('SMTP 不支持 STARTTLS')
        await client.#command('STARTTLS', [220])
        client.#wire.detach()
        const socket = tls.connect({
          socket: client.#wire.socket,
          servername: net.isIP(settings.smtpHost)
            ? undefined
            : settings.smtpHost,
          ca: policy.ca,
          minVersion: 'TLSv1.2',
        })
        const { promise, resolve, reject } = Promise.withResolvers<void>()
        const timer = setTimeout(() => {
          socket.destroy()
          reject(new Error('SMTP TLS 升级超时'))
        }, LIMITS.connectorTimeoutMs)
        socket.once('secureConnect', () => {
          clearTimeout(timer)
          resolve()
        })
        socket.once('error', () => {
          clearTimeout(timer)
          reject(new Error('SMTP TLS 升级失败'))
        })
        await promise
        client.#wire = new Wire(socket)
        ehlo = await client.#command('EHLO qianmo.local', [250])
      }
      headerValue(settings.username)
      headerValue(secret)
      if (ehlo.some(v => /\bAUTH\b.*\bPLAIN\b/i.test(v))) {
        const token = Buffer.from(`\0${settings.username}\0${secret}`).toString(
          'base64',
        )
        const reply = await client.#command(`AUTH PLAIN ${token}`, [235, 334])
        if (reply.at(-1)?.startsWith('334')) await client.#command(token, [235])
      } else if (ehlo.some(v => /\bAUTH\b.*\bLOGIN\b/i.test(v))) {
        await client.#command('AUTH LOGIN', [334])
        await client.#command(
          Buffer.from(settings.username).toString('base64'),
          [334],
        )
        await client.#command(Buffer.from(secret).toString('base64'), [235])
      } else throw new Error('SMTP 不支持口令认证')
      return client
    } catch {
      client.close()
      throw new Error('SMTP 登录失败')
    }
  }
  async send(
    from: string,
    to: readonly string[],
    subject: string,
    body: string,
    beforeSend: () => void = () => {},
  ): Promise<void> {
    const data = mailData(from, to, subject, body)
    await this.#command(`MAIL FROM:<${mailbox(from)}>`, [250])
    for (const recipient of to)
      await this.#command(`RCPT TO:<${mailbox(recipient)}>`, [250, 251])
    beforeSend()
    await this.#command('DATA', [354])
    beforeSend()
    this.#wire.send(`${data}\r\n.`)
    await this.#reply([250])
  }
  async quit(): Promise<void> {
    try {
      await this.#command('QUIT', [221])
    } finally {
      this.close()
    }
  }
  close(): void {
    this.#wire.close()
  }
}
