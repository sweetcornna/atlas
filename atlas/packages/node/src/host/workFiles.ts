// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One work session's folder in its agent's workspace (`work-tasks.md` §5.1):
 * `qmo-work/<session>/{outputs,previews,sources}`. Every lookup goes through
 * the directory handles of `filesSafeFs.ts`, one `openat` per component with
 * `O_NOFOLLOW`, so a link, a hard link, a special file, `..` or a name that
 * only differs in case is refused wherever it appears; folders are made
 * 0700 and files 0600.
 *
 * Names are relative to the part they are in, `/`-separated, four levels at
 * most. Writes go to a temporary sibling first and are renamed over the
 * name, so a reader sees the old file or the new one, never half of it.
 */

import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { workSessionDir, WORK_SESSION_ID } from '@qianmo/paths'
import { WORK_FILE_MAX_BYTES } from '@qianmo/console'
import { FileDirectory, FileFault, relativeFilePath } from './filesSafeFs.js'

export type WorkPart = 'outputs' | 'previews' | 'sources'

/** How deep outputs may nest, counting the file (§4.2). */
export const WORK_MAX_DEPTH = 4
/** Files one listing returns (§4.2). */
export const WORK_LIST_MAX = 200
/** Entries one listing looks at before it stops looking. */
const WORK_SCAN_MAX = 5000
/** Raw bytes per chunk: base64 of it stays inside one 256 KiB envelope. */
export const WORK_CHUNK_BYTES = 160 * 1024

const TEMP_PREFIX = '.qmo-tmp-'

/** What a file is right now; `etag` changes whenever its content may have. */
export interface WorkFileStat {
  readonly size: number
  readonly mtimeMs: number
  readonly etag: string
}

export function workName(value: unknown): string {
  const name = relativeFilePath(value)
  if (name.split('/').length > WORK_MAX_DEPTH) throw new FileFault('too-deep')
  if (name.split('/').some(part => part.startsWith(TEMP_PREFIX)))
    throw new FileFault('invalid-path')
  return name
}

export function isWorkSession(value: unknown): value is string {
  return typeof value === 'string' && WORK_SESSION_ID.test(value)
}

function statOf(fd: number): WorkFileStat {
  const stat = fs.fstatSync(fd, { bigint: true })
  return {
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    etag: createHash('sha256')
      .update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`)
      .digest('hex')
      .slice(0, 32),
  }
}

/**
 * Walk `segments` down from `start`, which is consumed (closed, or returned
 * when there is nothing to walk). Null when a segment is missing and not
 * being made.
 */
function descend(
  start: FileDirectory,
  segments: readonly string[],
  create: boolean,
): FileDirectory | null {
  let dir = start
  try {
    for (const segment of segments) {
      if (
        !create &&
        !dir
          .names()
          .some(one => one.normalize('NFC') === segment.normalize('NFC'))
      ) {
        dir.close()
        return null
      }
      const next = dir.directory(segment, create)
      dir.close()
      dir = next
    }
    return dir
  } catch (error) {
    dir.close()
    throw error
  }
}

/** The folders of one session in one workspace. */
export class WorkFolder {
  readonly #workspace: string
  readonly #session: string

  constructor(workspace: string, session: string) {
    if (!isWorkSession(session)) throw new FileFault('invalid-session')
    this.#workspace = workspace
    this.#session = session
  }

  /** The part's directory, or null when it does not exist yet. */
  #part(part: WorkPart, create: boolean): FileDirectory | null {
    const root = FileDirectory.root(fs.realpathSync(this.#workspace))
    return descend(root, workSessionDir(this.#session, part).split('/'), create)
  }

  /** The directory holding `name`, made on the way when `create`. */
  #parent(
    part: WorkPart,
    name: string,
    create: boolean,
  ): { readonly dir: FileDirectory; readonly leaf: string } | null {
    const base = this.#part(part, create)
    if (base === null) return null
    const segments = name.split('/')
    const leaf = segments.pop()!
    const dir = descend(base, segments, create)
    return dir === null ? null : { dir, leaf }
  }

  /** Write `bytes` as `name`, replacing what was there. */
  write(part: WorkPart, nameValue: string, bytes: Uint8Array): WorkFileStat {
    const name = workName(nameValue)
    if (bytes.byteLength > WORK_FILE_MAX_BYTES) throw new FileFault('limit')
    const found = this.#parent(part, name, true)!
    const { dir, leaf } = found
    try {
      const temp = `${TEMP_PREFIX}${randomUUID()}`
      const fd = dir.open(temp, true)
      try {
        let offset = 0
        while (offset < bytes.byteLength)
          offset += fs.writeSync(fd, bytes, offset, bytes.byteLength - offset)
        fs.fsyncSync(fd)
      } catch (error) {
        fs.closeSync(fd)
        dir.remove(temp)
        throw error
      }
      fs.closeSync(fd)
      try {
        dir.replace(temp, leaf)
      } catch (error) {
        dir.remove(temp)
        throw error
      }
      const check = dir.open(leaf)
      try {
        const stat = statOf(check)
        if (!fs.fstatSync(check).isFile()) throw new FileFault('unsafe-type')
        return stat
      } finally {
        fs.closeSync(check)
      }
    } finally {
      dir.close()
    }
  }

  /** Open `name` for reading: a regular file with one link, or a fault. */
  #openFile(part: WorkPart, nameValue: string): number {
    const name = workName(nameValue)
    const found = this.#parent(part, name, false)
    if (found === null) throw new FileFault('not-found')
    try {
      if (
        !found.dir
          .names()
          .some(one => one.normalize('NFC') === found.leaf.normalize('NFC'))
      )
        throw new FileFault('not-found')
      const fd = found.dir.open(found.leaf)
      if (!fs.fstatSync(fd).isFile()) {
        fs.closeSync(fd)
        throw new FileFault('not-found')
      }
      return fd
    } finally {
      found.dir.close()
    }
  }

  stat(part: WorkPart, name: string): WorkFileStat | null {
    try {
      const fd = this.#openFile(part, name)
      try {
        return statOf(fd)
      } finally {
        fs.closeSync(fd)
      }
    } catch (error) {
      if (error instanceof FileFault && error.code === 'not-found') return null
      throw error
    }
  }

  /** One chunk; `etag`, when given, must still be the file's. */
  read(
    part: WorkPart,
    name: string,
    offset: number,
    length: number,
    etag?: string,
  ): { readonly stat: WorkFileStat; readonly data: Uint8Array } {
    const fd = this.#openFile(part, name)
    try {
      const stat = statOf(fd)
      if (etag !== undefined && etag !== stat.etag)
        throw new FileFault('changed')
      if (stat.size > WORK_FILE_MAX_BYTES) throw new FileFault('limit')
      if (offset > stat.size) throw new FileFault('invalid-offset')
      const want = Math.min(length, stat.size - offset)
      const data = Buffer.alloc(want)
      let got = 0
      while (got < want) {
        const n = fs.readSync(fd, data, got, want - got, offset + got)
        if (n === 0) break
        got += n
      }
      if (got !== want || statOf(fd).etag !== stat.etag)
        throw new FileFault('changed')
      return { stat, data: new Uint8Array(data.buffer, data.byteOffset, got) }
    } finally {
      fs.closeSync(fd)
    }
  }

  /** The whole file, when it is at most `max` bytes. */
  readAll(
    part: WorkPart,
    name: string,
    max = WORK_FILE_MAX_BYTES,
  ): { readonly stat: WorkFileStat; readonly data: Uint8Array } {
    const fd = this.#openFile(part, name)
    try {
      const stat = statOf(fd)
      if (stat.size > max) throw new FileFault('limit')
      const data = Buffer.alloc(stat.size)
      let got = 0
      while (got < stat.size) {
        const n = fs.readSync(fd, data, got, stat.size - got, got)
        if (n === 0) break
        got += n
      }
      if (got !== stat.size || statOf(fd).etag !== stat.etag)
        throw new FileFault('changed')
      return { stat, data: new Uint8Array(data.buffer, data.byteOffset, got) }
    } finally {
      fs.closeSync(fd)
    }
  }

  /** Content digest, read in chunks so a large file is never held whole. */
  sha256(part: WorkPart, name: string): { stat: WorkFileStat; sha256: string } {
    const fd = this.#openFile(part, name)
    try {
      const stat = statOf(fd)
      if (stat.size > WORK_FILE_MAX_BYTES) throw new FileFault('limit')
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(1024 * 1024)
      let offset = 0
      while (offset < stat.size) {
        const n = fs.readSync(fd, buffer, 0, buffer.length, offset)
        if (n === 0) break
        hash.update(buffer.subarray(0, n))
        offset += n
      }
      if (offset !== stat.size || statOf(fd).etag !== stat.etag)
        throw new FileFault('changed')
      return { stat, sha256: hash.digest('hex') }
    } finally {
      fs.closeSync(fd)
    }
  }

  /**
   * Regular files under `outputs/`, newest first, at most
   * {@link WORK_LIST_MAX}. Links, hard links, special files and folders that
   * cannot be read safely are left out rather than failing the listing.
   */
  list(): {
    readonly files: readonly ({ readonly name: string } & WorkFileStat)[]
    readonly truncated: boolean
  } {
    const base = this.#part('outputs', false)
    if (base === null) return { files: [], truncated: false }
    const found: ({ name: string } & WorkFileStat)[] = []
    let scanned = 0
    let stopped = false
    const walk = (dir: FileDirectory, prefix: string, depth: number): void => {
      let names: string[]
      try {
        names = dir.names()
      } catch {
        return
      }
      for (const entry of names) {
        if (scanned >= WORK_SCAN_MAX) {
          stopped = true
          return
        }
        scanned++
        if (entry.startsWith(TEMP_PREFIX)) continue
        const name = prefix === '' ? entry : `${prefix}/${entry}`
        try {
          workName(name)
        } catch {
          continue
        }
        let fd: number
        try {
          fd = dir.open(entry)
        } catch {
          continue
        }
        const stat = fs.fstatSync(fd)
        if (stat.isDirectory()) {
          if (depth + 1 >= WORK_MAX_DEPTH) {
            fs.closeSync(fd)
            continue
          }
          let child: FileDirectory
          try {
            child = new FileDirectory(fd)
          } catch {
            continue
          }
          try {
            walk(child, name, depth + 1)
          } finally {
            child.close()
          }
          continue
        }
        try {
          if (stat.isFile()) found.push({ name, ...statOf(fd) })
        } finally {
          fs.closeSync(fd)
        }
      }
    }
    try {
      walk(base, '', 0)
    } finally {
      base.close()
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
    return {
      files: found.slice(0, WORK_LIST_MAX),
      truncated: stopped || found.length > WORK_LIST_MAX,
    }
  }
}
