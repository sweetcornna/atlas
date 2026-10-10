// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import { dirname, join } from 'node:path'
import { ompChildEnv } from '@qianmo/paths'

function trustedEntry(stat: fs.Stats, uid: number): boolean {
  return stat.uid === uid && (stat.mode & 0o7022) === 0
}

interface CacheEntry {
  readonly path: string
  readonly stat: fs.Stats
  readonly tighten: boolean
}

/** Only inspect the native cache's normal version/file layout, with bounded work. */
function inspectCache(
  cache: string,
  uid: number,
  allowTightening: boolean,
): CacheEntry[] | undefined {
  const entries: CacheEntry[] = []
  let privateAncestors = true
  for (const path of [dirname(dirname(cache)), dirname(cache)]) {
    const stat = fs.lstatSync(path)
    if (!stat.isDirectory() || !trustedEntry(stat, uid)) return
    privateAncestors &&= (stat.mode & 0o7777) === 0o700
    entries.push({ path, stat, tighten: false })
  }
  let remaining = 512
  function visit(path: string, depth: number): boolean {
    const stat = fs.lstatSync(path)
    if (stat.uid !== uid) return false
    if (stat.isFile()) {
      if (!trustedEntry(stat, uid)) return false
      entries.push({ path, stat, tighten: false })
      return true
    }
    if (!stat.isDirectory() || depth > 1) return false
    const tighten =
      allowTightening && privateAncestors && (stat.mode & 0o7777) === 0o775
    if (!tighten && !trustedEntry(stat, uid)) return false
    entries.push({ path, stat, tighten })
    const dir = fs.opendirSync(path)
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (--remaining < 0 || !visit(join(path, entry.name), depth + 1))
          return false
      }
      return true
    } finally {
      dir.closeSync()
    }
  }
  return fs.lstatSync(cache).isDirectory() && visit(cache, 0)
    ? entries
    : undefined
}

function sameEntry(
  actual: fs.Stats,
  expected: fs.Stats,
  mode: number,
): boolean {
  return (
    actual.uid === expected.uid &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.mode === mode
  )
}

/** The loader may create 0775 directories under umask 0002. Tighten only
 * that ordinary mode, behind two owner-only ancestors, after full preflight.
 * Never chmod a path or an addon file. This does not isolate hostile same-UID
 * mutation or establish a portable ACL security model. */
function tightenCache(
  cache: string,
  uid: number,
  entries: CacheEntry[],
): boolean {
  const pending = entries.filter(entry => entry.tighten)
  if (pending.length === 0) return true
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants
  if (!O_DIRECTORY || !O_NOFOLLOW) return false
  const opened: { entry: CacheEntry; fd: number }[] = []
  function repair(): boolean {
    // Open and validate every candidate before changing any mode. Failed
    // preflight or initial fd checks cannot begin the chmod pass. A later
    // race/failure may leave completed tightening, but still refuses reuse.
    for (const entry of pending) {
      const fd = fs.openSync(entry.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
      opened.push({ entry, fd })
      const stat = fs.fstatSync(fd)
      if (!stat.isDirectory() || !sameEntry(stat, entry.stat, entry.stat.mode))
        return false
    }
    for (const entry of entries) {
      if (!sameEntry(fs.lstatSync(entry.path), entry.stat, entry.stat.mode))
        return false
    }
    for (const { entry, fd } of opened) {
      if (!sameEntry(fs.fstatSync(fd), entry.stat, entry.stat.mode))
        return false
      const mode = entry.stat.mode & ~0o020
      fs.fchmodSync(fd, mode & 0o7777)
      if (
        !sameEntry(fs.fstatSync(fd), entry.stat, mode) ||
        !sameEntry(fs.lstatSync(entry.path), entry.stat, mode)
      )
        return false
    }
    for (const entry of entries) {
      const mode = entry.tighten ? entry.stat.mode & ~0o020 : entry.stat.mode
      if (!sameEntry(fs.lstatSync(entry.path), entry.stat, mode)) return false
    }
    return inspectCache(cache, uid, false) !== undefined
  }
  let repaired = false
  let closed = true
  try {
    repaired = repair()
  } finally {
    for (const { fd } of opened) {
      try {
        fs.closeSync(fd)
      } catch {
        closed = false
      }
    }
  }
  return repaired && closed
}

/**
 * Keep probe credentials/sessions private while reusing an existing same-user
 * native cache. Never accept an inherited PI_* redirect. A directory link
 * survives the compiled entry's second ompChildEnv() sanitization; overriding
 * PI_NATIVES_DIR would not. The native loader may maintain old cache versions.
 *
 * No cache is created here. Missing/unsafe caches and unsupported links keep
 * the original private cold-cache path. Without POSIX ownership checks (e.g.
 * Windows), retain that path too. This is not isolation from the same UID.
 */
export function reuseProbeNativeCache(
  base: NodeJS.ProcessEnv,
  probe: NodeJS.ProcessEnv,
): void {
  if (typeof process.getuid !== 'function') return
  const cache = ompChildEnv(base).PI_NATIVES_DIR!
  const destination = ompChildEnv(probe).PI_NATIVES_DIR!
  if (cache === destination) return
  try {
    const uid = process.getuid()
    const entries = inspectCache(cache, uid, true)
    if (!entries || !tightenCache(cache, uid, entries)) return
    // The destination is absent inside the newly-created private probe root.
    // Recursive removal of that root unlinks this entry, not its target.
    fs.symlinkSync(cache, destination, 'dir')
  } catch {
    // Reuse is optional; the real probe still runs with its original timeout.
  }
}
