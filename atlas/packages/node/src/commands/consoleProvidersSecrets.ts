// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 模型密钥在中枢上的落盘面：主密钥与密文库（`providers-console-m1.md` §3.7、§3.8，
 * P18.6）。
 *
 * ## 信封
 *
 * 每把密钥一把随机的 32 字节数据密钥，AES-256-GCM 加密密钥本身；数据密钥再用主密钥
 * AES-256-GCM 包起来。两层的附加数据都绑 `profileId`、`keyId` 与档案修订号
 * （`secretRef.ts` 的要求）：一段密文挪到另一份档案、另一把 key、或同一份档案的另一个
 * 修订号上都解不开。档案每保存一次，它的密文就按新修订号整份重包（新数据密钥、新 IV）。
 * 只用 `node:crypto`。
 *
 * **它防的是误拷贝，不防中枢失陷**：主密钥与密文在同一台机器上（§3.8）。
 *
 * ## 文件
 *
 * - 密文库 `provider-secrets.json`：`{v:1, entries:{"<profileId>:<keyId>":
 *   {fp, rev, wrappedKey, iv, tag, ct, at}}}`。**整体重写**（P18.2 的
 *   `writePrivateFileAtomic`：tmp 以 0600 创建、fsync、rename，目录 0700），所以轮换
 *   和删除之后旧条目真的从文件里消失。
 * - 主密钥：64 个十六进制字符（32 字节），可带一个换行。0600，所在目录 0700，属主是
 *   本进程的用户；不满足就**拒绝启动这一面**。
 *
 * ## fail-closed
 *
 * 密文库有条目而主密钥不在：这一面停用（「主密钥缺失」），**绝不重新生成**——那会让
 * 全部密文变成孤儿。主密钥在、却解不开任何一条：停用（「主密钥与密文库不符」）。
 * 两种情况下节点照用最后一次下发的配置，中枢什么都不发。主密钥只在第一次真正要写
 * 密钥、而且密文库是空的时候才生成。
 *
 * 路径不在这里拼：从 `consoleArgs.ts` 来，派生自 `qianmoConfigPath()`。
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  isSecretFingerprint,
  parseSecretSlotKey,
  secretFingerprint,
  secretSlotKey,
  type SecretRef,
} from '@qianmo/providers'
import { writePrivateFileAtomic } from '../providers/store.js'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const SECRET_DOMAIN = 'qianmo/provider-secret/v1'
const WRAP_DOMAIN = 'qianmo/provider-wrap/v1'
const MASTER_KEY_TEXT = /^[0-9a-f]{64}\n?$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** One entry of the store, as it lands on disk. Never holds a plain value. */
interface SealedEntry {
  readonly fp: string
  readonly rev: number
  readonly wrappedKey: string
  readonly iv: string
  readonly tag: string
  readonly ct: string
  readonly at: string
}

interface ProviderSecretPaths {
  readonly secretsPath: string
  readonly keyPath: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  )
}

function additionalData(
  domain: string,
  ref: SecretRef,
  revision: number,
): Buffer {
  return Buffer.from(
    `${domain}\u0000${ref.profileId}\u0000${ref.keyId}\u0000${revision}`,
    'utf8',
  )
}

function seal(
  key: Buffer,
  plain: Buffer,
  aad: Buffer,
): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(aad)
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  return { iv, tag: cipher.getAuthTag(), ct }
}

function open(
  key: Buffer,
  iv: Buffer,
  tag: Buffer,
  ct: Buffer,
  aad: Buffer,
): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

/** Encrypt one value for one slot at one revision. */
function sealEntry(
  master: Buffer,
  ref: SecretRef,
  revision: number,
  value: string,
  at: string,
): SealedEntry {
  const dataKey = randomBytes(KEY_BYTES)
  try {
    const body = seal(
      dataKey,
      Buffer.from(value, 'utf8'),
      additionalData(SECRET_DOMAIN, ref, revision),
    )
    const wrapped = seal(
      master,
      dataKey,
      additionalData(WRAP_DOMAIN, ref, revision),
    )
    return {
      fp: secretFingerprint(value),
      rev: revision,
      wrappedKey: Buffer.concat([wrapped.iv, wrapped.tag, wrapped.ct]).toString(
        'base64',
      ),
      iv: body.iv.toString('base64'),
      tag: body.tag.toString('base64'),
      ct: body.ct.toString('base64'),
      at,
    }
  } finally {
    dataKey.fill(0)
  }
}

/** Decrypt one entry; throws when the master key or the binding does not match. */
function openEntry(master: Buffer, ref: SecretRef, entry: SealedEntry): string {
  const wrapped = Buffer.from(entry.wrappedKey, 'base64')
  if (wrapped.length !== IV_BYTES + TAG_BYTES + KEY_BYTES) {
    throw new Error('wrappedKey 长度不对')
  }
  const dataKey = open(
    master,
    wrapped.subarray(0, IV_BYTES),
    wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    wrapped.subarray(IV_BYTES + TAG_BYTES),
    additionalData(WRAP_DOMAIN, ref, entry.rev),
  )
  try {
    const plain = open(
      dataKey,
      Buffer.from(entry.iv, 'base64'),
      Buffer.from(entry.tag, 'base64'),
      Buffer.from(entry.ct, 'base64'),
      additionalData(SECRET_DOMAIN, ref, entry.rev),
    )
    const value = plain.toString('utf8')
    plain.fill(0)
    const expected = Buffer.from(entry.fp, 'utf8')
    const actual = Buffer.from(secretFingerprint(value), 'utf8')
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new Error('指纹与内容不符')
    }
    return value
  } finally {
    dataKey.fill(0)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEntry(value: unknown): SealedEntry | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value).sort().join(',')
  if (keys !== 'at,ct,fp,iv,rev,tag,wrappedKey') return null
  const { fp, rev, wrappedKey, iv, tag, ct, at } = value
  if (!isSecretFingerprint(fp)) return null
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 0) {
    return null
  }
  for (const field of [wrappedKey, iv, tag, ct]) {
    if (typeof field !== 'string' || !BASE64.test(field)) return null
  }
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null
  return {
    fp,
    rev,
    wrappedKey: wrappedKey as string,
    iv: iv as string,
    tag: tag as string,
    ct: ct as string,
    at,
  }
}

/** The whole store, strictly: every entry or the reason there are none. */
function parseStore(
  text: string,
): { ok: true; entries: Map<string, SealedEntry> } | { ok: false } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.entries)) {
    return { ok: false }
  }
  if (Object.keys(parsed).sort().join(',') !== 'entries,v') return { ok: false }
  const entries = new Map<string, SealedEntry>()
  for (const [slot, raw] of Object.entries(parsed.entries)) {
    const entry = parseEntry(raw)
    if (entry === null || parseSecretSlotKey(slot) === null) {
      return { ok: false }
    }
    entries.set(slot, entry)
  }
  return { ok: true, entries }
}

/**
 * Why `path` is not fit to hold the master key, or `null`. Checks the file
 * itself (regular file, not a link, owner-only, owned by this user) and the
 * directory it sits in (owner-only).
 */
function masterKeyProblem(path: string): string | null {
  const ownUid = typeof process.getuid === 'function' ? process.getuid() : null
  const stats = lstatSync(path)
  if (!stats.isFile()) return '主密钥不是普通文件（符号链接不跟）'
  if ((stats.mode & 0o077) !== 0) {
    return `主密钥权限过宽（${(stats.mode & 0o777).toString(8)}，要 600）`
  }
  if (ownUid !== null && stats.uid !== ownUid) return '主密钥不属于本进程的用户'
  const directory = lstatSync(dirname(path))
  if ((directory.mode & 0o077) !== 0) {
    return `主密钥所在目录权限过宽（${(directory.mode & 0o777).toString(8)}，要 700）`
  }
  return null
}

function readMasterKey(path: string): Buffer | string {
  const problem = masterKeyProblem(path)
  if (problem !== null) return problem
  const text = readFileSync(path, 'utf8')
  if (!MASTER_KEY_TEXT.test(text)) {
    return '主密钥格式不对：要 64 个小写十六进制字符（32 字节）'
  }
  return Buffer.from(text.trim(), 'hex')
}

function fileExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false
    throw error
  }
}

/**
 * The secret store. Opened once at console start; a store that could not be
 * opened carries its {@link problem} and refuses everything.
 *
 * Every method is synchronous on purpose: "check, then write" must not have an
 * `await` between the two, or two requests interleave inside it.
 */
export class ProviderSecretStore {
  readonly #paths: ProviderSecretPaths
  readonly #now: () => Date
  #entries = new Map<string, SealedEntry>()
  #master: Buffer | null = null
  #problem: string | null = null

  constructor(paths: ProviderSecretPaths, now: () => Date = () => new Date()) {
    this.#paths = paths
    this.#now = now
    try {
      this.#open()
    } catch (error) {
      this.#problem = `密文库打不开（${messageOf(error)}）`
    }
  }

  /** `null` while usable; otherwise why the providers face is closed. */
  get problem(): string | null {
    return this.#problem
  }

  #open(): void {
    const { secretsPath, keyPath } = this.#paths
    if (fileExists(secretsPath)) {
      const stats = lstatSync(secretsPath)
      if (!stats.isFile()) {
        this.#problem = '密文库不是普通文件（符号链接不跟）'
        return
      }
      if ((stats.mode & 0o077) !== 0) {
        this.#problem = `密文库权限过宽（${(stats.mode & 0o777).toString(8)}，要 600）`
        return
      }
      const parsed = parseStore(readFileSync(secretsPath, 'utf8'))
      if (!parsed.ok) {
        this.#problem = '密文库无法解析'
        return
      }
      this.#entries = parsed.entries
    }
    if (!fileExists(keyPath)) {
      if (this.#entries.size > 0) {
        // Never regenerate: a fresh key would orphan every entry above.
        this.#problem = `主密钥缺失（${keyPath}）而密文库里有 ${this.#entries.size} 把密钥；不会重新生成`
      }
      return
    }
    const master = readMasterKey(keyPath)
    if (typeof master === 'string') {
      this.#problem = master
      return
    }
    for (const [slot, entry] of this.#entries) {
      const ref = parseSecretSlotKey(slot)
      try {
        if (ref === null) throw new Error('槽名不对')
        void openEntry(master, ref, entry)
      } catch {
        master.fill(0)
        this.#problem = '主密钥与密文库不符：至少一把密钥解不开'
        return
      }
    }
    this.#master = master
  }

  #require(): void {
    if (this.#problem !== null) throw new Error(this.#problem)
  }

  /** Create the master key now: only when there is none and nothing is sealed. */
  #ensureMaster(): Buffer {
    if (this.#master !== null) return this.#master
    if (this.#entries.size > 0 || fileExists(this.#paths.keyPath)) {
      throw new Error('主密钥状态不对，拒绝生成')
    }
    const master = randomBytes(KEY_BYTES)
    writePrivateFileAtomic(this.#paths.keyPath, `${master.toString('hex')}\n`)
    const problem = masterKeyProblem(this.#paths.keyPath)
    if (problem !== null) {
      master.fill(0)
      this.#problem = problem
      throw new Error(problem)
    }
    this.#master = master
    return master
  }

  #write(next: Map<string, SealedEntry>): void {
    const entries: Record<string, SealedEntry> = {}
    for (const slot of [...next.keys()].sort()) {
      const entry = next.get(slot)
      if (entry !== undefined) entries[slot] = entry
    }
    writePrivateFileAtomic(
      this.#paths.secretsPath,
      `${JSON.stringify({ v: 1, entries })}\n`,
    )
    this.#entries = next
  }

  /** The fingerprint of the sealed key in `ref`, or `null` when there is none. */
  fingerprint(ref: SecretRef): string | null {
    return this.#entries.get(secretSlotKey(ref))?.fp ?? null
  }

  /** When the key in `ref` was sealed, or `null`. */
  sealedAt(ref: SecretRef): string | null {
    return this.#entries.get(secretSlotKey(ref))?.at ?? null
  }

  /**
   * The plain value, for exactly one purpose: writing it into the stdin of a
   * sixth-action request. Callers never log it, return it, or keep it.
   */
  reveal(ref: SecretRef): string | null {
    this.#require()
    const entry = this.#entries.get(secretSlotKey(ref))
    if (entry === undefined || this.#master === null) return null
    return openEntry(this.#master, ref, entry)
  }

  /**
   * Bring every key of `profileId` to `revision` in one rewrite of the file:
   * keys in `set` are sealed from the given value (a new key, or a rotation);
   * the other keys listed in `keep` are re-sealed from their current value
   * (the revision is part of the binding); keys of the profile that are in
   * neither are dropped. Returns the fingerprint of each key in `set`.
   *
   * The old ciphertext of every key of the profile is gone from the file
   * afterwards, so a rotation or a removal leaves nothing behind (§3.7).
   */
  commit(
    profileId: string,
    revision: number,
    keep: readonly string[],
    set: Readonly<Record<string, string>> = {},
  ): Record<string, string> {
    this.#require()
    const master =
      Object.keys(set).length > 0 ? this.#ensureMaster() : this.#master
    const at = this.#now().toISOString()
    const next = new Map<string, SealedEntry>()
    for (const [slot, entry] of this.#entries) {
      const ref = parseSecretSlotKey(slot)
      if (ref !== null && ref.profileId === profileId) continue
      next.set(slot, entry)
    }
    for (const [slot, entry] of this.#entries) {
      const ref = parseSecretSlotKey(slot)
      if (ref === null || ref.profileId !== profileId) continue
      if (!keep.includes(ref.keyId) || Object.hasOwn(set, ref.keyId)) continue
      if (master === null) continue
      const value = openEntry(master, ref, entry)
      next.set(slot, sealEntry(master, ref, revision, value, entry.at))
    }
    const fingerprints: Record<string, string> = {}
    for (const [keyId, value] of Object.entries(set)) {
      if (master === null) throw new Error('没有主密钥')
      const ref = { profileId, keyId }
      const entry = sealEntry(master, ref, revision, value, at)
      next.set(secretSlotKey(ref), entry)
      fingerprints[keyId] = entry.fp
    }
    this.#write(next)
    return fingerprints
  }

  /** Drop every key of `profileId` (the profile is being deleted). */
  forget(profileId: string): void {
    this.commit(profileId, 0, [])
  }
}
