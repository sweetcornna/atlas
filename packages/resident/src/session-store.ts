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
} from 'node:fs'
import { dirname } from 'node:path'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ResidentSessionStore {
  get(agent: string): string | undefined
  set(agent: string, sessionId: string): void
  entries(): Readonly<Record<string, string>>
}

function isSessionMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([agent, sessionId]) =>
        SEGMENT_PATTERN.test(agent) &&
        typeof sessionId === 'string' &&
        UUID_PATTERN.test(sessionId),
    )
  )
}

export class FileResidentSessionStore implements ResidentSessionStore {
  readonly #path: string
  readonly #sessions: Record<string, string>

  constructor(path: string) {
    if (path.trim() === '')
      throw new Error('session store path must not be empty')
    this.#path = path
    this.#sessions = this.#read()
  }

  get path(): string {
    return this.#path
  }

  get(agent: string): string | undefined {
    return this.#sessions[agent]
  }

  set(agent: string, sessionId: string): void {
    if (!SEGMENT_PATTERN.test(agent)) throw new Error('agent is invalid')
    if (!UUID_PATTERN.test(sessionId)) throw new Error('sessionId is invalid')
    this.#sessions[agent] = sessionId
    this.#write()
  }

  entries(): Readonly<Record<string, string>> {
    return { ...this.#sessions }
  }

  #read(): Record<string, string> {
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('resident session store is corrupt')
    }
    if (!isSessionMap(parsed))
      throw new Error('resident session store is invalid')
    return { ...parsed }
  }

  #write(): void {
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
        writeFileSync(fd, `${JSON.stringify(this.#sessions)}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, this.#path)
      chmodSync(this.#path, FILE_MODE)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
}

export class MemoryResidentSessionStore implements ResidentSessionStore {
  readonly #sessions: Record<string, string> = {}

  get(agent: string): string | undefined {
    return this.#sessions[agent]
  }

  set(agent: string, sessionId: string): void {
    this.#sessions[agent] = sessionId
  }

  entries(): Readonly<Record<string, string>> {
    return { ...this.#sessions }
  }
}
