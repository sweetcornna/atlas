// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import {
  constants,
  closeSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** A compiled resident has no package tree. Extract its own bundled policy,
 * never an extension located relative to the deployment's working directory. */
export function residentExtensionPath(sessionDir: string): string {
  if (process.env.QIANMO_OMP_ENTRY !== 'self')
    return Bun.resolveSync('@qianmo/extension', import.meta.dir)
  let source: unknown
  try {
    source = require('../generated/provenance.ts').RESIDENT_EXTENSION_SOURCE
  } catch {
    throw new Error('compiled resident extension asset is unavailable')
  }
  if (typeof source !== 'string' || source.length === 0)
    throw new Error('compiled resident extension asset is unavailable')
  return writeResidentExtensionAsset(sessionDir, source)
}

export function writeResidentExtensionAsset(
  sessionDir: string,
  source: string,
): string {
  const digest = createHash('sha256').update(source).digest('hex')
  const path = join(sessionDir, `resident-extension-${digest}.mjs`)
  try {
    writeFileSync(path, source, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  // Refuse a pre-existing link or stale/corrupt file instead of silently loading
  // code controlled by cwd or left by a different build. O_NOFOLLOW also closes
  // the lstat/open race at this read boundary.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (readFileSync(fd, 'utf8') !== source)
      throw new Error(
        'compiled resident extension asset differs from this binary',
      )
  } finally {
    closeSync(fd)
  }
  return path
}
