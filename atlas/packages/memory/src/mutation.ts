// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from 'bun:sqlite'
import { closeSync, constants, fstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

/** Serializes multi-file changes. The kernel releases SQLite's lock on crash.
 * This database holds no memory content; Markdown remains the source of truth.
 */
export function withMemoryMutation<T>(root: string, change: () => T): T {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = join(root, '.mutation.sqlite')
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const stat = fstatSync(fd)
    if (
      !stat.isFile() ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    )
      throw new Error('memory mutation lock must be an owner-only regular file')
  } finally {
    closeSync(fd)
  }
  const db = new Database(path)
  try {
    db.exec('PRAGMA busy_timeout = 2000; BEGIN IMMEDIATE')
    const result = change()
    db.exec('COMMIT')
    return result
  } finally {
    db.close()
  }
}
