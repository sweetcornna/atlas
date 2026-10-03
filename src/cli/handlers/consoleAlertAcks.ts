// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the console keeps which alerts somebody has acknowledged (J5).
 *
 * The shape of `consoleServerNotes.ts`, for the same reasons: an append-only
 * NDJSON file, one record per line, replayed on start, 0600 in a 0700
 * directory. A torn last line costs that one acknowledgement; an unreadable
 * byte costs one line, never the file.
 *
 * ## The first acknowledgement of an id wins
 *
 * The opposite of the notes, where the last write wins. Acknowledging is a
 * fact about a moment — "this was taken at 14:20" — and a second click by
 * somebody else does not move that moment. The port never writes a second
 * line for an id it already holds; replay keeps the first line anyway, so a
 * file written by two consoles at once still reads the same way.
 *
 * ## Size
 *
 * One line per acknowledged alert. Conditions are keyed by episode and
 * notices by message, so the file grows with what operators actually
 * acknowledged — a person clicking a button. **Compaction is a non-goal**,
 * stated so the next reader does not mistake it for an oversight: a year of a
 * hundred acknowledgements a day is under four megabytes.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AlertAck } from '@qianmo/console'
import { occConfigPath } from '../../config/paths.js'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** The default location, beside the console's other stores. */
export function consoleAlertAcksPath(): string {
  return occConfigPath('qianmo', 'console', 'alert-acks.ndjson')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One acknowledgement from a line, or `null` for anything unexpected. */
function toAck(value: unknown): AlertAck | null {
  if (!isRecord(value)) return null
  const id = value['id']
  const at = value['at']
  const by = value['by']
  if (typeof id !== 'string' || id === '') return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  if (typeof by !== 'string' || by === '') return null
  return { id, at, by }
}

export class AlertAcksStore {
  readonly #path: string

  constructor(path: string) {
    this.#path = path
  }

  /**
   * Replay the file, first acknowledgement per id winning. A missing file is
   * the ordinary first run: nothing acknowledged yet.
   */
  load(): readonly AlertAck[] {
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch {
      return []
    }
    const acks = new Map<string, AlertAck>()
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(parsed) || parsed['kind'] !== 'ack') continue
      const ack = toAck(parsed['ack'])
      if (ack !== null && !acks.has(ack.id)) acks.set(ack.id, ack)
    }
    return [...acks.values()]
  }

  append(ack: AlertAck): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: DIR_MODE })
    appendFileSync(this.#path, `${JSON.stringify({ kind: 'ack', ack })}\n`, {
      mode: FILE_MODE,
    })
  }
}
