// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { isValidSegment } from '@qianmo/protocol'
import type {
  AdmissionIntegrityIssue,
  AdmissionLedger,
  AdmissionQueryResult,
  AdmissionRecord,
  DetectedAdmissionRecord,
  PendingAdmission,
  ResidentMailboxMessage,
} from './contracts.js'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COMPACT_AFTER_READS = 128

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const allowed = [...expected].sort()
  return (
    actual.length === allowed.length &&
    actual.every((key, index) => key === allowed[index])
  )
}

function isMailboxMessage(value: unknown): value is ResidentMailboxMessage {
  const message = record(value)
  if (message === undefined) return false
  const optional = [
    ...(message.color === undefined ? [] : ['color']),
    ...(message.summary === undefined ? [] : ['summary']),
  ]
  return (
    exactKeys(message, ['from', 'text', 'timestamp', 'read', ...optional]) &&
    typeof message.from === 'string' &&
    typeof message.text === 'string' &&
    typeof message.timestamp === 'string' &&
    typeof message.read === 'boolean' &&
    (message.color === undefined || typeof message.color === 'string') &&
    (message.summary === undefined || typeof message.summary === 'string')
  )
}

function isDetected(
  value: Record<string, unknown>,
): value is Record<string, unknown> & DetectedAdmissionRecord {
  return (
    exactKeys(value, [
      'kind',
      'messageId',
      'sessionId',
      'detectedAt',
      'agent',
      'team',
      'readBefore',
      'snapshot',
      'prompt',
      ...(value.networkMsgId === undefined ? [] : ['networkMsgId']),
    ]) &&
    value.kind === 'detected' &&
    typeof value.messageId === 'string' &&
    UUID_PATTERN.test(value.messageId) &&
    typeof value.sessionId === 'string' &&
    UUID_PATTERN.test(value.sessionId) &&
    typeof value.detectedAt === 'number' &&
    Number.isFinite(value.detectedAt) &&
    value.detectedAt >= 0 &&
    isValidSegment(value.agent) &&
    isValidSegment(value.team) &&
    record(value.readBefore) !== undefined &&
    Object.entries(record(value.readBefore) ?? {}).every(
      ([identity, count]) =>
        identity.length > 0 &&
        typeof count === 'number' &&
        Number.isInteger(count) &&
        count >= 0,
    ) &&
    Array.isArray(value.snapshot) &&
    value.snapshot.length > 0 &&
    value.snapshot.every(isMailboxMessage) &&
    typeof value.prompt === 'string' &&
    value.prompt.length > 0 &&
    (value.networkMsgId === undefined ||
      (typeof value.networkMsgId === 'string' && value.networkMsgId.length > 0))
  )
}

function isTransition(
  value: Record<string, unknown>,
): value is Record<string, unknown> & AdmissionRecord {
  return (
    exactKeys(value, ['kind', 'messageId', 'at']) &&
    (value.kind === 'admitted' || value.kind === 'read') &&
    typeof value.messageId === 'string' &&
    UUID_PATTERN.test(value.messageId) &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at) &&
    value.at >= 0
  )
}

function isAdmissionRecord(value: unknown): value is AdmissionRecord {
  const candidate = record(value)
  return (
    candidate !== undefined &&
    (isDetected(candidate) || isTransition(candidate))
  )
}

function validateRecord(value: AdmissionRecord): void {
  if (!isAdmissionRecord(value)) throw new Error('invalid admission record')
}

export class FileAdmissionLedger implements AdmissionLedger {
  readonly #path: string
  readonly #pending = new Map<string, PendingAdmission>()
  #fd: number | null = null
  #loaded = false
  #integrityIssues: AdmissionIntegrityIssue[] = []
  #readsSinceCompaction = 0

  constructor(path: string) {
    if (path.trim() === '') throw new Error('ledger path must not be empty')
    this.#path = path
  }

  get path(): string {
    return this.#path
  }

  #handle(): number {
    if (this.#fd === null) {
      const directory = dirname(this.#path)
      mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
      chmodSync(directory, DIRECTORY_MODE)
      this.#fd = openSync(
        this.#path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      )
      chmodSync(this.#path, FILE_MODE)
    }
    return this.#fd
  }

  #apply(value: AdmissionRecord): void {
    if (value.kind === 'detected') {
      if (!this.#pending.has(value.messageId)) {
        this.#pending.set(value.messageId, { ...value, phase: 'detected' })
      }
      return
    }

    if (value.kind === 'admitted') {
      const detected = this.#pending.get(value.messageId)
      if (detected?.phase === 'detected') {
        this.#pending.set(value.messageId, {
          ...detected,
          phase: 'admitted',
          admittedAt: value.at,
        })
      }
      return
    }

    this.#pending.delete(value.messageId)
  }

  #load(): void {
    if (this.#loaded) return

    this.#pending.clear()
    this.#integrityIssues = []
    this.#readsSinceCompaction = 0
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#loaded = true
        return
      }
      throw error
    }

    const lines = raw.split('\n')
    const tail = lines.pop()
    for (const [index, line] of lines.entries()) {
      if (line === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isAdmissionRecord(parsed)) this.#apply(parsed)
        else
          this.#integrityIssues.push({
            line: index + 1,
            kind: 'corrupt_line',
          })
      } catch {
        this.#integrityIssues.push({
          line: index + 1,
          kind: 'corrupt_line',
        })
      }
    }
    if (tail !== undefined && tail !== '') {
      this.#integrityIssues.push({
        line: lines.length + 1,
        kind: 'torn_tail',
      })
    }
    this.#loaded = true
  }

  append(value: AdmissionRecord): void {
    validateRecord(value)
    this.#load()
    const fd = this.#handle()
    writeSync(fd, `${JSON.stringify(value)}\n`)
    fsyncSync(fd)
    this.#apply(value)

    if (value.kind === 'read') this.#readsSinceCompaction++
  }

  #result(): AdmissionQueryResult {
    return {
      pending: [...this.#pending.values()].sort(
        (left, right) => left.detectedAt - right.detectedAt,
      ),
      integrityIssues: [...this.#integrityIssues],
    }
  }

  query(): AdmissionQueryResult {
    this.#load()
    if (this.#readsSinceCompaction >= COMPACT_AFTER_READS) this.#compactLoaded()
    return this.#result()
  }

  compact(): void {
    this.#load()
    this.#compactLoaded()
  }

  #compactLoaded(): void {
    const result = this.#result()
    if (result.integrityIssues.length > 0) {
      throw new Error('cannot compact a damaged admission ledger')
    }
    const directory = dirname(this.#path)
    mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
    chmodSync(directory, DIRECTORY_MODE)
    const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`
    try {
      const fd = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      )
      try {
        const body = result.pending
          .flatMap(pending => {
            if (pending.phase === 'detected') {
              const { phase, ...detected } = pending
              return [`${JSON.stringify(detected)}\n`]
            }
            const { phase, admittedAt, ...detected } = pending
            return [
              `${JSON.stringify(detected)}\n`,
              `${JSON.stringify({
                kind: 'admitted',
                messageId: detected.messageId,
                at: admittedAt,
              })}\n`,
            ]
          })
          .join('')
        writeFileSync(fd, body)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      this.#closeHandle()
      renameSync(temporary, this.#path)
      this.#readsSinceCompaction = 0
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }

  #closeHandle(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd)
      this.#fd = null
    }
  }

  close(): void {
    this.#closeHandle()
    this.#loaded = false
    this.#pending.clear()
    this.#integrityIssues = []
    this.#readsSinceCompaction = 0
  }
}
