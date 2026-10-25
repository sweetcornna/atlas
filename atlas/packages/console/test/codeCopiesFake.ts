// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Remote copies in memory (P37.15), for the hub's tests: the same
 * semantics as the node's file store (`consoleCodeCopies.ts`) — a turn's
 * last line at the place of its first, `full` without writing — with the
 * limits a test can make small.
 */

import {
  CODE_ACCOUNT_MAX_COPIES,
  CODE_COPY_MAX_BYTES,
  type CodeCopiesPort,
  type CodeCopy,
  type CodeCopyHeader,
  type CodeCopyRecord,
  codeOwnerKey,
} from '../src/codeRemote.js'

interface Entry {
  readonly owner: string
  readonly device: string
  header: CodeCopyHeader
  stored: number
  bytes: number
  full: boolean
  readonly records: CodeCopyRecord[]
}

export class MemoryCopies implements CodeCopiesPort {
  readonly #entries = new Map<string, Entry>()
  readonly maxCopies: number
  readonly maxBytes: number
  readonly notes: string[] = []

  constructor(
    limits: { readonly copies?: number; readonly bytes?: number } = {},
  ) {
    this.maxCopies = limits.copies ?? CODE_ACCOUNT_MAX_COPIES
    this.maxBytes = limits.bytes ?? CODE_COPY_MAX_BYTES
  }

  #key(owner: string, device: string, session: string): string {
    return `${owner} ${device} ${session}`
  }

  #view(entry: Entry): CodeCopy {
    return {
      device: entry.device,
      header: entry.header,
      stored: entry.stored,
      bytes: entry.bytes,
      full: entry.full,
    }
  }

  /** The records stored for a copy, every line as sent. */
  lines(owner: string, device: string, session: string): CodeCopyRecord[] {
    return [
      ...(this.#entries.get(this.#key(owner, device, session))?.records ?? []),
    ]
  }

  list(owner: string): readonly CodeCopy[] {
    return [...this.#entries.values()]
      .filter(entry => entry.owner === owner)
      .map(entry => this.#view(entry))
  }

  get(owner: string, device: string, session: string): CodeCopy | undefined {
    const entry = this.#entries.get(this.#key(owner, device, session))
    return entry === undefined ? undefined : this.#view(entry)
  }

  saveHeader(
    owner: string,
    device: string,
    header: CodeCopyHeader,
  ): 'ok' | 'full' {
    const key = this.#key(owner, device, header.id)
    const known = this.#entries.get(key)
    if (known !== undefined) {
      known.header = header
      return 'ok'
    }
    if (this.list(owner).length >= this.maxCopies) return 'full'
    this.#entries.set(key, {
      owner,
      device,
      header,
      stored: 0,
      bytes: 0,
      full: false,
      records: [],
    })
    return 'ok'
  }

  append(
    owner: string,
    device: string,
    session: string,
    records: readonly CodeCopyRecord[],
  ): { readonly stored: number } | 'full' | 'missing' {
    const entry = this.#entries.get(this.#key(owner, device, session))
    if (entry === undefined) return 'missing'
    const size = records.reduce(
      (sum, record) => sum + Buffer.byteLength(`${JSON.stringify(record)}\n`),
      0,
    )
    if (entry.full || entry.bytes + size > this.maxBytes) {
      entry.full = true
      return 'full'
    }
    entry.records.push(...records)
    entry.bytes += size
    if (records.length > 0) entry.stored = records[records.length - 1]!.seq
    return { stored: entry.stored }
  }

  read(
    owner: string,
    device: string,
    session: string,
    before: number | undefined,
    limit: number,
  ) {
    const entry = this.#entries.get(this.#key(owner, device, session))
    if (entry === undefined) return undefined
    const turns = new Map<string, { first: number; record: CodeCopyRecord }>()
    let lastSeq = 0
    for (const record of entry.records) {
      const known = turns.get(record.turn.id)
      turns.set(record.turn.id, { first: known?.first ?? record.seq, record })
      lastSeq = Math.max(lastSeq, record.seq)
    }
    const all = [...turns.values()].filter(
      one => before === undefined || one.first < before,
    )
    const shown = all.slice(Math.max(0, all.length - limit))
    return {
      records: shown.map(one => one.record),
      more: all.length > shown.length,
      lastSeq,
    }
  }

  remove(owner: string, device: string, session: string): boolean {
    return this.#entries.delete(this.#key(owner, device, session))
  }

  removeDevice(owner: string, device: string): void {
    for (const [key, entry] of [...this.#entries])
      if (entry.owner === owner && entry.device === device)
        this.#entries.delete(key)
  }

  removeOwner(owner: string): void {
    for (const [key, entry] of [...this.#entries])
      if (entry.owner === owner) this.#entries.delete(key)
  }

  prune(keep: (ownerKey: string, device: string) => boolean): number {
    const dropped = new Set<string>()
    for (const [key, entry] of [...this.#entries]) {
      if (keep(codeOwnerKey(entry.owner), entry.device)) continue
      this.#entries.delete(key)
      dropped.add(`${entry.owner} ${entry.device}`)
    }
    return dropped.size
  }

  note(line: string): void {
    this.notes.push(line)
  }
}
