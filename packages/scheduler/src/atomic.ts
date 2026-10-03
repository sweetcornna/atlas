// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

/** Every directory this package creates: the hub's operator, nobody else. */
export const DIRECTORY_MODE = 0o700

/** Every file this package writes. */
export const FILE_MODE = 0o600

/**
 * The flags of every file this package creates: create-or-fail, and never
 * through a symlink someone left in the directory.
 */
export const EXCLUSIVE_CREATE =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0)

/**
 * Temp-then-rename, the house pattern: whoever reads `path` sees the old file
 * or the new one, never a prefix of either.
 *
 * `rename(2)` within one directory replaces the name in a single step, so a
 * reader that opens `path` gets one inode or the other; the bytes of the new
 * one are complete and fsynced before its name exists. Writing in place
 * instead — truncate, then write — leaves a window in which the file is empty
 * or half there, and a reader in another process lands in it sooner or later.
 *
 * `stamp` only keeps the temporary name apart from another writer's: two
 * processes sharing the directory write different temporaries and the last
 * rename wins. Throws on failure, after removing the temporary.
 */
export function writeFileAtomically(
  path: string,
  text: string,
  stamp: number,
): void {
  const directory = dirname(path)
  const temporary = `${path}.${process.pid}.${stamp}.tmp`
  try {
    mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
    chmodSync(directory, DIRECTORY_MODE)
    const fd = openSync(temporary, EXCLUSIVE_CREATE, FILE_MODE)
    try {
      writeFileSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
    chmodSync(path, FILE_MODE)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}
