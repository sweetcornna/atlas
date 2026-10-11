// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as net from 'node:net'
import { LIMITS } from '@qianmo/protocol'

/** A bounded byte reader: literals are not lines, and unsolicited data is capped too. */
export class Wire {
  readonly socket: net.Socket
  readonly #deadline: Timer
  #buffer = Buffer.alloc(0)
  #failure = false
  #wake: (() => void) | undefined
  readonly #data = (data: Buffer) => {
    if (this.#buffer.length + data.length > LIMITS.connectorResponseBytes) {
      this.#fail()
      return
    }
    this.#buffer = Buffer.concat([this.#buffer, data])
    this.#wake?.()
  }
  readonly #error = () => this.#fail()
  constructor(socket: net.Socket) {
    this.socket = socket
    this.#deadline = setTimeout(this.#error, LIMITS.connectorTimeoutMs)
    socket.on('data', this.#data)
    socket.on('error', this.#error)
    socket.on('close', this.#error)
    socket.setTimeout(LIMITS.connectorTimeoutMs, this.#error)
  }
  #fail(): void {
    clearTimeout(this.#deadline)
    this.#failure = true
    this.#wake?.()
    this.socket.destroy()
  }
  async #wait(): Promise<void> {
    if (this.#failure) throw new Error('协议连接失败或超时')
    const { promise, resolve } = Promise.withResolvers<void>()
    this.#wake = resolve
    await promise
    this.#wake = undefined
  }
  async line(): Promise<string> {
    for (;;) {
      const end = this.#buffer.indexOf('\r\n')
      if ((end < 0 ? this.#buffer.length : end) > LIMITS.connectorLineBytes) {
        this.#fail()
        throw new Error('协议行超过上限')
      }
      if (end >= 0) {
        const value = this.#buffer.subarray(0, end).toString('utf8')
        this.#buffer = this.#buffer.subarray(end + 2)
        return value
      }
      await this.#wait()
    }
  }
  async literal(size: number, maximum: number): Promise<Buffer> {
    if (!Number.isSafeInteger(size) || size < 0 || size > maximum) {
      this.#fail()
      throw new Error('协议字面量超过上限')
    }
    while (this.#buffer.length < size) await this.#wait()
    const result = this.#buffer.subarray(0, size)
    this.#buffer = this.#buffer.subarray(size)
    return result
  }
  send(value: string): void {
    if (this.#failure) throw new Error('协议连接不可用')
    if (
      Buffer.byteLength(value) > LIMITS.connectorResponseBytes ||
      value
        .split('\r\n')
        .some(line => Buffer.byteLength(line) > LIMITS.connectorLineBytes)
    )
      throw new Error('协议发送数据超过上限')
    this.socket.write(`${value}\r\n`)
  }
  detach(): void {
    if (this.#buffer.length) throw new Error('TLS 升级前有多余协议数据')
    clearTimeout(this.#deadline)
    this.socket.off('data', this.#data)
    this.socket.off('error', this.#error)
    this.socket.off('close', this.#error)
    this.socket.setTimeout(0)
  }
  close(): void {
    clearTimeout(this.#deadline)
    this.socket.destroy()
  }
}

export function headerValue(
  value: unknown,
  max: number = LIMITS.connectorLineBytes,
): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > max ||
    /[\r\n]/.test(value) ||
    value.includes('\0')
  )
    throw new Error('邮件头或协议参数无效')
  return value
}
export function imapQuote(value: string): string {
  return `"${headerValue(value).replace(/(["\\])/g, '\\$1')}"`
}
export function mailbox(value: unknown): string {
  const text = headerValue(value, 254)
  if (
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(
      text,
    )
  )
    throw new Error('邮件地址无效')
  return text
}

/** Cap returned UTF-8 bytes after decoding, including malformed-byte replacement. */
export function utf8Prefix(raw: Buffer, limit: number): string {
  const valid = Buffer.from(raw.toString('utf8'))
  let end = Math.min(valid.length, limit)
  while (end < valid.length && (valid[end]! & 0xc0) === 0x80) end--
  return valid.subarray(0, end).toString('utf8')
}
