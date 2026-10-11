// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { writePrivateFileAtomic } from '../providers/store.js'

export interface ConnectorSecret {
  readonly revision: number
  readonly slot: 'password' | 'ics-url'
  readonly at: number
  readonly wrapped: string
  readonly body: string
}
function aad(
  domain: string,
  id: string,
  slot: string,
  revision: number,
): Buffer {
  return Buffer.from(
    JSON.stringify([`qianmo/connector/${domain}/v1`, id, slot, revision]),
  )
}
function encrypt(key: Buffer, value: Buffer, associated: Buffer): string {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(associated)
  const body = Buffer.concat([cipher.update(value), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}
function decrypt(key: Buffer, raw: string, associated: Buffer): Buffer {
  const value = Buffer.from(raw, 'base64')
  if (value.length < 28) throw new Error('连接器密文无效')
  const cipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    value.subarray(0, 12),
  )
  cipher.setAAD(associated)
  cipher.setAuthTag(value.subarray(12, 28))
  return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()])
}
export function privateText(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file)
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('连接器存储权限无效')
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('连接器存储不可用')
  }
}
/** Vault entries are committed atomically with metadata; revisions cannot split on a crash. */
export class ConnectorVault {
  readonly #keyPath: string
  #master: Buffer | undefined
  constructor(
    keyPath: string,
    existing: readonly { id: string; secret: ConnectorSecret }[],
  ) {
    this.#keyPath = keyPath
    const key = privateText(keyPath)
    if (key !== undefined) {
      if (
        !/^[a-f0-9]{64}\n?$/.test(key) ||
        (fs.lstatSync(path.dirname(keyPath)).mode & 0o077) !== 0
      )
        throw new Error('连接器主密钥无效')
      this.#master = Buffer.from(key.trim(), 'hex')
    }
    if (!this.#master && existing.length)
      throw new Error('连接器主密钥缺失，不会重新生成')
    for (const value of existing)
      this.reveal(value.id, value.secret, value.secret.revision)
  }
  #key(): Buffer {
    if (!this.#master) {
      // Every connector needs a key, including handles and ICS-only accounts.
      if (privateText(this.#keyPath) !== undefined)
        throw new Error('连接器主密钥状态已变化')
      const key = crypto.randomBytes(32)
      writePrivateFileAtomic(this.#keyPath, `${key.toString('hex')}\n`)
      this.#master = key
    }
    return this.#master
  }
  seal(
    id: string,
    slot: ConnectorSecret['slot'],
    revision: number,
    value: string,
    at: number,
  ): ConnectorSecret {
    const data = crypto.randomBytes(32)
    try {
      return {
        revision,
        slot,
        at,
        wrapped: encrypt(this.#key(), data, aad('wrap', id, slot, revision)),
        body: encrypt(
          data,
          Buffer.from(value),
          aad('secret', id, slot, revision),
        ),
      }
    } finally {
      data.fill(0)
    }
  }
  reveal(id: string, value: ConnectorSecret, revision: number): string {
    if (!this.#master || value.revision !== revision)
      throw new Error('连接器秘密修订不符')
    const data = decrypt(
      this.#master,
      value.wrapped,
      aad('wrap', id, value.slot, revision),
    )
    try {
      const plain = decrypt(
        data,
        value.body,
        aad('secret', id, value.slot, revision),
      )
      const result = plain.toString('utf8')
      plain.fill(0)
      return result
    } finally {
      data.fill(0)
    }
  }
  handle(value: Record<string, unknown>): string {
    const raw = Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${raw}.${crypto.createHmac('sha256', this.#key()).update(`qianmo/connector/handle/v1\0${raw}`).digest('base64url')}`
  }
  openHandle(raw: string): Record<string, unknown> {
    if (typeof raw !== 'string' || raw.length > 2048)
      throw new Error('邮件句柄无效')
    const [data, signature, extra] = raw.split('.')
    if (!data || !signature || extra !== undefined)
      throw new Error('邮件句柄无效')
    const expected = crypto
      .createHmac('sha256', this.#key())
      .update(`qianmo/connector/handle/v1\0${data}`)
      .digest()
    const actual = Buffer.from(signature, 'base64url')
    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    )
      throw new Error('邮件句柄无效')
    const parsed: unknown = JSON.parse(
      Buffer.from(data, 'base64url').toString(),
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('邮件句柄无效')
    return parsed as Record<string, unknown>
  }
}
