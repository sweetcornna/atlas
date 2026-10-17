// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Merchant secrets are referenced by file path and become `KeyObject`s at
 * parse time. A `KeyObject` serialises as `{}` and inspects without its
 * material, so a config, an error or a snapshot that holds one cannot echo it.
 * Every message here names the field and the path, never the content.
 */

import {
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  type KeyObject,
} from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs'
import { isAbsolute } from 'node:path'

const MAX_SECRET_BYTES = 64 * 1024
const MIN_RSA_BITS = 2048

/** Reads one secret file: absolute path, regular file, mode 0600 or stricter. */
export type SecretReader = (path: string) => string

/** The default {@link SecretReader}. Refuses symlinks, wide modes and large files. */
export function readSecretFile(path: string): string {
  if (!isAbsolute(path)) throw new Error(`密钥文件必须是绝对路径：${path}`)
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'EIO'
    throw new Error(`密钥文件无法打开（${code}）：${path}`)
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error(`密钥文件不是普通文件：${path}`)
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      throw new Error(`密钥文件权限过宽，需要 0600 或更严：${path}`)
    if (stat.size > MAX_SECRET_BYTES) throw new Error(`密钥文件过大：${path}`)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** PEM body or bare base64 (the Alipay key tool writes the latter). */
function derOf(text: string): Buffer | null {
  const body = text.replace(/\s+/g, '')
  if (body.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null
  return Buffer.from(body, 'base64')
}

function assertRsa(key: KeyObject, label: string): KeyObject {
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (key.asymmetricKeyType !== 'rsa' || bits < MIN_RSA_BITS)
    throw new Error(`${label} 必须是至少 ${MIN_RSA_BITS} 位的 RSA 密钥`)
  return key
}

/** RSA private key from PKCS#8 / PKCS#1 PEM, or bare base64 DER of either. */
export function loadRsaPrivateKey(text: string, label: string): KeyObject {
  const trimmed = text.trim()
  const attempts: (() => KeyObject)[] = trimmed.startsWith('-----BEGIN ')
    ? [() => createPrivateKey({ key: trimmed, format: 'pem' })]
    : [
        () => {
          const der = derOf(trimmed)
          if (der === null) throw new Error('not base64')
          return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
        },
        () => {
          const der = derOf(trimmed)
          if (der === null) throw new Error('not base64')
          return createPrivateKey({ key: der, format: 'der', type: 'pkcs1' })
        },
      ]
  for (const attempt of attempts) {
    let key: KeyObject
    try {
      key = attempt()
    } catch {
      continue
    }
    return assertRsa(key, label)
  }
  throw new Error(`${label} 不是可识别的 RSA 私钥（PEM 或 base64 DER）`)
}

/** RSA public key from SPKI / PKCS#1 PEM, an X.509 PEM, or bare base64 SPKI DER. */
export function loadRsaPublicKey(text: string, label: string): KeyObject {
  const trimmed = text.trim()
  let key: KeyObject | null = null
  try {
    if (trimmed.startsWith('-----BEGIN ')) {
      key = createPublicKey({ key: trimmed, format: 'pem' })
    } else {
      const der = derOf(trimmed)
      if (der !== null)
        key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    }
  } catch {
    key = null
  }
  if (key === null)
    throw new Error(`${label} 不是可识别的 RSA 公钥（PEM 或 base64 DER）`)
  return assertRsa(key, label)
}

/** The WeChat Pay APIv3 key: exactly 32 bytes; one trailing newline tolerated. */
export function loadApiV3Key(text: string, label: string): KeyObject {
  const value = text.replace(/\r?\n$/, '')
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length !== 32) throw new Error(`${label} 必须正好是 32 字节`)
  return createSecretKey(bytes)
}
