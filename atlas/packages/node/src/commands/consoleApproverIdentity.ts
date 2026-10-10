// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  generateNodeKeyPair,
  isNodeKeyPair,
  signBytes,
  verifyBytes,
  type NodeKeyPair,
} from '@qianmo/capability'
import { qianmoConfigPath } from '@qianmo/paths'
import { consoleWakeIdentityNode } from './consoleWakeIdentity.js'

/** Separate from the commander key: approval authority never grants task authority. */
export function consoleApproverIdentityPath(node: string): string {
  return qianmoConfigPath('qianmo', 'console-keys', `${node}.approver.json`)
}

export function loadConsoleApproverIdentity(from: string): {
  readonly node: string
  readonly keys: NodeKeyPair
} {
  const node = consoleWakeIdentityNode(from)
  const path = consoleApproverIdentityPath(node)
  const read = (): NodeKeyPair => {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = fstatSync(fd)
      if (
        !stat.isFile() ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      )
        throw new Error(
          'approver identity must be a private regular file (0600)',
        )
      const stored: unknown = JSON.parse(readFileSync(fd, 'utf8'))
      if (
        !stored ||
        typeof stored !== 'object' ||
        !('node' in stored) ||
        stored.node !== node ||
        !('version' in stored) ||
        stored.version !== 1 ||
        !isNodeKeyPair(stored)
      )
        throw new Error('invalid approver identity; refusing replacement')
      if (
        !verifyBytes(
          stored.publicKey,
          'qianmo-approver-key-check',
          signBytes(stored, 'qianmo-approver-key-check'),
        )
      )
        throw new Error('approver key pair does not match')
      return { publicKey: stored.publicKey, privateKey: stored.privateKey }
    } finally {
      closeSync(fd)
    }
  }
  try {
    return { node, keys: read() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const keys = generateNodeKeyPair()
  let fd: number
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return { node, keys: read() }
  }
  try {
    writeFileSync(fd, `${JSON.stringify({ version: 1, node, ...keys })}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return { node, keys }
}
