// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CString,
  dlopen,
  FFIType,
  ptr,
  type Pointer,
  type Library,
} from 'bun:ffi'

export class FileFault extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

// Darwin arm64 openat is variadic; its fixed-arity syscall stub __openat
// preserves the mode argument under FFI. Bun has no openat API. These libc calls keep every child lookup anchored to
// an open directory, including enumeration and the final no-replace rename.
const FILE_SYMBOLS = {
  [process.platform === 'darwin' ? '__openat' : 'openat']: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
  unlinkat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  mkdirat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  dup: { args: [FFIType.i32], returns: FFIType.i32 },
  fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
  readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
  closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
  [process.platform === 'darwin' ? 'renameatx_np' : 'renameat2']: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
} as const
function libc() {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new FileFault('unsupported-platform')
  return dlopen(
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    FILE_SYMBOLS,
  )
}
let native: Library<typeof FILE_SYMBOLS> | null = null
function symbols() {
  native ??= libc()
  return native.symbols
}
function openAt(
  directory: number,
  name: Pointer,
  flags: number,
  mode: number,
): number {
  const fd = symbols()[process.platform === 'darwin' ? '__openat' : 'openat']!(
    directory,
    name,
    flags,
    mode,
  )
  if (typeof fd !== 'number' || !Number.isInteger(fd))
    throw new FileFault('filesystem')
  return fd
}
const cstring = (value: string) => Buffer.from(`${value}\0`)
const identity = (fd: number): string => {
  const stat = fs.fstatSync(fd, { bigint: true })
  return `${stat.dev}:${stat.ino}`
}
export const nameKey = (value: string) =>
  value.normalize('NFKC').toUpperCase().toLowerCase()

export function relativeFilePath(value: unknown, root = false): string {
  if (root && (value === '' || value === '.')) return ''
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.from(value, 'utf8').toString('utf8') !== value ||
    Buffer.byteLength(value) > 2048 ||
    /[\\:]/.test(value) ||
    [...value].some(
      char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    value.startsWith('/')
  )
    throw new FileFault('invalid-path')
  const parts = value.split('/')
  for (const part of parts) {
    if (
      part === '.' ||
      part === '..' ||
      !part ||
      /[. ]$/.test(part) ||
      Buffer.byteLength(part) > 240 ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) ||
      nameKey(part) === '.' ||
      nameKey(part) === '..' ||
      /[/\\:]/.test(part.normalize('NFKC'))
    )
      throw new FileFault('invalid-path')
  }
  return value.normalize('NFC')
}

export class FileDirectory {
  readonly fd: number
  constructor(fd: number) {
    this.fd = fd
    if (!fs.fstatSync(fd).isDirectory()) {
      fs.closeSync(fd)
      throw new FileFault('unsafe-type')
    }
  }
  static root(absolute: string): FileDirectory {
    if (!path.isAbsolute(absolute)) throw new FileFault('invalid-workspace')
    let dir = new FileDirectory(
      fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY),
    )
    try {
      // The registered workspace is the trust anchor; OS aliases such as /var
      // are resolved once here. All untrusted relative components use openat
      // with the alias check (`open`). The anchor's own components are
      // realpath's spelling, opened as they are: no listing of each ancestor
      // (a large one, like a busy temp directory, made every call slow), and
      // a sibling differing only in case does not refuse the workspace.
      for (const part of fs.realpathSync(absolute).split('/').filter(Boolean)) {
        const fd = openAt(
          dir.fd,
          ptr(cstring(part)),
          fs.constants.O_RDONLY |
            fs.constants.O_DIRECTORY |
            fs.constants.O_NOFOLLOW,
          0,
        )
        if (fd < 0) throw new FileFault('unsafe-open')
        const next = new FileDirectory(fd)
        dir.close()
        dir = next
      }
      return dir
    } catch (error) {
      dir.close()
      throw error
    }
  }
  get generation(): string {
    return identity(this.fd)
  }
  names(): string[] {
    const dot = cstring('.')
    const fd = openAt(
      this.fd,
      ptr(dot),
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
      0,
    )
    if (fd < 0) throw new FileFault('filesystem')
    const stream = symbols().fdopendir(fd)
    if (!stream) {
      fs.closeSync(fd)
      throw new FileFault('filesystem')
    }
    const names: string[] = []
    try {
      for (;;) {
        const entry = symbols().readdir(stream)
        if (!entry) break
        const name = new CString(
          entry,
          process.platform === 'darwin' ? 21 : 19,
        ).toString()
        if (name !== '.' && name !== '..') names.push(name)
      }
      const keys = new Set<string>()
      for (const name of names) {
        const key = nameKey(name)
        if (keys.has(key)) throw new FileFault('name-alias')
        keys.add(key)
      }
      return names.sort()
    } finally {
      symbols().closedir(stream)
    }
  }
  #checkName(name: string, creating: boolean): string {
    relativeFilePath(name)
    if (name.includes('/')) throw new FileFault('invalid-path')
    const matches = this.names().filter(one => nameKey(one) === nameKey(name))
    if (
      matches.some(one => one.normalize('NFC') !== name.normalize('NFC')) ||
      (creating && matches.length)
    )
      throw new FileFault('name-alias')
    return matches[0] ?? name
  }
  open(name: string, create = false, write = false): number {
    const buffer = cstring(this.#checkName(name, create))
    const flags =
      fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK |
      (create
        ? fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
        : write
          ? fs.constants.O_WRONLY
          : fs.constants.O_RDONLY)
    const fd = openAt(this.fd, ptr(buffer), flags, 0o600)
    if (fd < 0) throw new FileFault('unsafe-open')
    try {
      const stat = fs.fstatSync(fd)
      if (
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)
      )
        throw new FileFault('unsafe-type')
      const check = openAt(
        this.fd,
        ptr(buffer),
        fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK |
          fs.constants.O_RDONLY,
        0,
      )
      if (check < 0) throw new FileFault('unsafe-open')
      try {
        if (identity(check) !== identity(fd)) throw new FileFault('path-race')
      } finally {
        fs.closeSync(check)
      }
      this.#checkName(name, false)
      return fd
    } catch (error) {
      fs.closeSync(fd)
      throw error
    }
  }
  openWrite(name: string): number {
    return this.open(name, false, true)
  }
  directory(name: string, create = false): FileDirectory {
    if (
      create &&
      !this.names().some(one => one.normalize('NFC') === name.normalize('NFC'))
    ) {
      this.#checkName(name, true)
      const buffer = cstring(name)
      if (symbols().mkdirat(this.fd, ptr(buffer), 0o700) !== 0)
        throw new FileFault('unsafe-open')
    }
    return new FileDirectory(this.open(name))
  }
  walk(relative: string, create = false): FileDirectory {
    let dir = new FileDirectory(symbols().dup(this.fd))
    try {
      for (const part of relative.split('/').filter(Boolean)) {
        const next = dir.directory(part, create)
        dir.close()
        dir = next
      }
      return dir
    } catch (error) {
      dir.close()
      throw error
    }
  }
  renameExclusive(from: string, to: string): void {
    this.#checkName(to, true)
    const source = cstring(from),
      target = cstring(to)
    const rename =
      symbols()[process.platform === 'darwin' ? 'renameatx_np' : 'renameat2']!
    if (
      rename(
        this.fd,
        ptr(source),
        this.fd,
        ptr(target),
        process.platform === 'darwin' ? 4 : 1,
      ) !== 0
    )
      throw new FileFault('rename-collision')
    fs.fsyncSync(this.fd)
  }
  remove(name: string): void {
    if (!this.names().includes(name)) return
    const fd = this.open(name),
      stat = fs.fstatSync(fd)
    if (stat.isDirectory()) {
      const dir = new FileDirectory(fd)
      try {
        for (const child of dir.names()) dir.remove(child)
      } finally {
        dir.close()
      }
    } else fs.closeSync(fd)
    const value = cstring(name)
    if (
      symbols().unlinkat(
        this.fd,
        ptr(value),
        stat.isDirectory() ? (process.platform === 'darwin' ? 0x80 : 0x200) : 0,
      ) !== 0
    )
      throw new FileFault('cleanup-failed')
  }
  close(): void {
    fs.closeSync(this.fd)
  }
}
