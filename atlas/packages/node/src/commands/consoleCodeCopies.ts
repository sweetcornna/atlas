// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the hub keeps the Remote copies of local Code sessions (P37.15,
 * `docs/dev/qmo-local.md` §5.3):
 *
 * ```
 * <root>/<owner key>/<device id>/<session id>/session.json    the head, written whole
 * <root>/<owner key>/<device id>/<session id>/events.ndjson   the records, appended
 * ```
 *
 * `<root>` comes from the caller, derived from `qianmoConfigPath()`; the
 * owner key is a hash of the account's subject (`codeOwnerKey`), so no
 * account name is ever a path. Folders are 0700, files 0600. A record line
 * has the envelope of the device's own `events.ndjson`
 * (`{kind: 'turn', seq, turn}`), and a reader keeps each turn's last line
 * at the place of its first, as the device does.
 *
 * An account's copies are read from disk the first time the account is
 * asked about and kept in memory after; a copy's records only when a page
 * reads them, the last few kept.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CODE_ACCOUNT_MAX_BYTES,
  CODE_ACCOUNT_MAX_COPIES,
  CODE_COPY_MAX_BYTES,
  type CodeCopiesPort,
  type CodeCopy,
  type CodeCopyHeader,
  type CodeCopyPage,
  type CodeCopyRecord,
  codeHeaderOf,
  codeOwnerKey,
  codeRecordOf,
} from '@qianmo/console'

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const OWNER_KEY = /^[0-9a-f]{32}$/
const DEVICE_ID = /^d-[a-z2-7]{12}$/
const SESSION_ID = /^cs_[A-Za-z0-9_-]{22}$/
/** Transcripts kept parsed in memory. */
const KEEP_PARSED = 16

interface Entry {
  readonly device: string
  header: CodeCopyHeader
  stored: number
  bytes: number
  full: boolean
}

interface Parsed {
  /** turn id → its place (first seq) and its last line. */
  readonly turns: Map<string, { first: number; record: CodeCopyRecord }>
  lastSeq: number
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  fs.chmodSync(dir, DIR_MODE)
}

function writeWhole(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, text, { mode: FILE_MODE, flag: 'wx' })
  fs.renameSync(temp, file)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface ConsoleCodeCopiesOptions {
  readonly root: string
  readonly note?: (line: string) => void
}

/** The file store behind `CodeCopiesPort`. */
export function openConsoleCodeCopies(
  options: ConsoleCodeCopiesOptions,
): CodeCopiesPort {
  const { root } = options
  const owners = new Map<string, Map<string, Entry>>()
  const parsed = new Map<string, Parsed>()

  const keyOf = (device: string, session: string) => `${device}/${session}`
  const copyDir = (ownerKey: string, device: string, session: string) => {
    if (
      !OWNER_KEY.test(ownerKey) ||
      !DEVICE_ID.test(device) ||
      !SESSION_ID.test(session)
    )
      throw new Error('Remote 副本的路径段不对')
    return path.join(root, ownerKey, device, session)
  }

  /** The account's copies, read from disk the first time. */
  const entriesOf = (owner: string): Map<string, Entry> => {
    const ownerKey = codeOwnerKey(owner)
    let entries = owners.get(ownerKey)
    if (entries !== undefined) return entries
    entries = new Map()
    owners.set(ownerKey, entries)
    const ownerDir = path.join(root, ownerKey)
    let devices: string[] = []
    try {
      devices = fs.readdirSync(ownerDir).filter(name => DEVICE_ID.test(name))
    } catch {
      return entries
    }
    for (const device of devices) {
      let sessions: string[] = []
      try {
        sessions = fs
          .readdirSync(path.join(ownerDir, device))
          .filter(name => SESSION_ID.test(name))
      } catch {
        continue
      }
      for (const session of sessions) {
        const dir = copyDir(ownerKey, device, session)
        try {
          const raw: unknown = JSON.parse(
            fs.readFileSync(path.join(dir, 'session.json'), 'utf8'),
          )
          if (!isRecord(raw) || raw.v !== 1) continue
          const header = codeHeaderOf(raw.header)
          if (header === undefined || header.id !== session) continue
          let bytes = 0
          try {
            bytes = fs.statSync(path.join(dir, 'events.ndjson')).size
          } catch {}
          entries.set(keyOf(device, session), {
            device,
            header,
            stored:
              typeof raw.stored === 'number' && Number.isSafeInteger(raw.stored)
                ? raw.stored
                : 0,
            bytes,
            full: raw.full === true,
          })
        } catch {
          // A copy that cannot be read is skipped; its device's next push
          // writes a new head over it.
        }
      }
    }
    return entries
  }

  const view = (entry: Entry): CodeCopy => ({
    device: entry.device,
    header: entry.header,
    stored: entry.stored,
    bytes: entry.bytes,
    full: entry.full,
  })

  const writeHead = (owner: string, entry: Entry): void => {
    const dir = copyDir(codeOwnerKey(owner), entry.device, entry.header.id)
    ensureDir(path.dirname(path.dirname(dir)))
    ensureDir(path.dirname(dir))
    ensureDir(dir)
    writeWhole(
      path.join(dir, 'session.json'),
      `${JSON.stringify({
        v: 1,
        header: entry.header,
        stored: entry.stored,
        full: entry.full,
      })}\n`,
    )
  }

  const totalBytes = (entries: Map<string, Entry>): number => {
    let sum = 0
    for (const entry of entries.values()) sum += entry.bytes
    return sum
  }

  const parse = (owner: string, device: string, session: string): Parsed => {
    const ownerKey = codeOwnerKey(owner)
    const id = `${ownerKey}/${keyOf(device, session)}`
    const kept = parsed.get(id)
    if (kept !== undefined) {
      parsed.delete(id)
      parsed.set(id, kept)
      return kept
    }
    const out: Parsed = { turns: new Map(), lastSeq: 0 }
    let raw = ''
    try {
      raw = fs.readFileSync(
        path.join(copyDir(ownerKey, device, session), 'events.ndjson'),
        'utf8',
      )
    } catch {}
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      const record = codeRecordOf(value, session)
      if (record === undefined) continue
      remember(out, record)
    }
    parsed.set(id, out)
    while (parsed.size > KEEP_PARSED) {
      const oldest = parsed.keys().next().value
      if (oldest === undefined) break
      parsed.delete(oldest)
    }
    return out
  }

  const remember = (into: Parsed, record: CodeCopyRecord): void => {
    const known = into.turns.get(record.turn.id)
    into.turns.set(record.turn.id, {
      first: known?.first ?? record.seq,
      record,
    })
    if (record.seq > into.lastSeq) into.lastSeq = record.seq
  }

  const forget = (prefix: string): void => {
    for (const id of [...parsed.keys()])
      if (id === prefix || id.startsWith(`${prefix}/`)) parsed.delete(id)
  }

  const removeDir = (dir: string): void => {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  return {
    list(owner) {
      return [...entriesOf(owner).values()].map(view)
    },

    get(owner, device, session) {
      const entry = entriesOf(owner).get(keyOf(device, session))
      return entry === undefined ? undefined : view(entry)
    },

    saveHeader(owner, device, header) {
      const entries = entriesOf(owner)
      const key = keyOf(device, header.id)
      const known = entries.get(key)
      if (known === undefined && entries.size >= CODE_ACCOUNT_MAX_COPIES)
        return 'full'
      const entry: Entry = known ?? {
        device,
        header,
        stored: 0,
        bytes: 0,
        full: false,
      }
      entry.header = header
      writeHead(owner, entry)
      entries.set(key, entry)
      return 'ok'
    },

    append(owner, device, session, records) {
      const entries = entriesOf(owner)
      const entry = entries.get(keyOf(device, session))
      if (entry === undefined) return 'missing'
      if (records.length === 0) return { stored: entry.stored }
      const text = records.map(record => `${JSON.stringify(record)}\n`).join('')
      const size = Buffer.byteLength(text)
      if (
        entry.full ||
        entry.bytes + size > CODE_COPY_MAX_BYTES ||
        totalBytes(entries) + size > CODE_ACCOUNT_MAX_BYTES
      ) {
        if (!entry.full) {
          entry.full = true
          writeHead(owner, entry)
        }
        return 'full'
      }
      const dir = copyDir(codeOwnerKey(owner), device, session)
      fs.appendFileSync(path.join(dir, 'events.ndjson'), text, {
        mode: FILE_MODE,
      })
      entry.bytes += size
      entry.stored = records[records.length - 1]!.seq
      writeHead(owner, entry)
      const kept = parsed.get(
        `${codeOwnerKey(owner)}/${keyOf(device, session)}`,
      )
      if (kept !== undefined)
        for (const record of records) remember(kept, record)
      return { stored: entry.stored }
    },

    read(owner, device, session, before, limit): CodeCopyPage | undefined {
      if (entriesOf(owner).get(keyOf(device, session)) === undefined)
        return undefined
      const transcript = parse(owner, device, session)
      const all = [...transcript.turns.values()].filter(
        one => before === undefined || one.first < before,
      )
      const shown = all.slice(Math.max(0, all.length - limit))
      return {
        records: shown.map(one => one.record),
        more: all.length > shown.length,
        lastSeq: transcript.lastSeq,
      }
    },

    remove(owner, device, session) {
      const entries = entriesOf(owner)
      const key = keyOf(device, session)
      if (!entries.delete(key)) return false
      const ownerKey = codeOwnerKey(owner)
      forget(`${ownerKey}/${key}`)
      removeDir(copyDir(ownerKey, device, session))
      return true
    },

    removeDevice(owner, device) {
      if (!DEVICE_ID.test(device)) return
      const entries = entriesOf(owner)
      for (const key of [...entries.keys()])
        if (key.startsWith(`${device}/`)) entries.delete(key)
      const ownerKey = codeOwnerKey(owner)
      forget(`${ownerKey}/${device}`)
      removeDir(path.join(root, ownerKey, device))
    },

    removeOwner(owner) {
      const ownerKey = codeOwnerKey(owner)
      owners.delete(ownerKey)
      forget(ownerKey)
      removeDir(path.join(root, ownerKey))
    },

    prune(keep) {
      let dropped = 0
      let ownerKeys: string[] = []
      try {
        ownerKeys = fs.readdirSync(root).filter(name => OWNER_KEY.test(name))
      } catch {
        return 0
      }
      for (const ownerKey of ownerKeys) {
        let devices: string[] = []
        try {
          devices = fs
            .readdirSync(path.join(root, ownerKey))
            .filter(name => DEVICE_ID.test(name))
        } catch {
          continue
        }
        for (const device of devices) {
          if (keep(ownerKey, device)) continue
          removeDir(path.join(root, ownerKey, device))
          dropped += 1
        }
        owners.delete(ownerKey)
        forget(ownerKey)
      }
      return dropped
    },

    ...(options.note === undefined ? {} : { note: options.note }),
  }
}
