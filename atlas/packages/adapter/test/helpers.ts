// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared fixtures for the adapter tests.
 *
 * Everything here is real: a real temp directory, the real `@qianmo/mailbox`
 * functions, real envelopes from `@qianmo/protocol`. No module is mocked —
 * the behaviour under test *is* the interaction with the mailbox, so
 * replacing it with a double would test nothing.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { QianmoMessage } from '@qianmo/protocol'
import { MessageType, createMessage } from '@qianmo/protocol'

/** A temp config root, wired in through `QIANMO_CONFIG_DIR`. */
export interface TempConfig {
  readonly root: string
  readonly configDir: string
  restore(): void
}

/** Point `qianmoConfigDir()` at a throwaway directory. */
export function useTempConfig(prefix: string): TempConfig {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const configDir = join(root, 'config')
  const previous = process.env.QIANMO_CONFIG_DIR
  process.env.QIANMO_CONFIG_DIR = configDir
  return {
    root,
    configDir,
    restore(): void {
      if (previous === undefined) {
        delete process.env.QIANMO_CONFIG_DIR
      } else {
        process.env.QIANMO_CONFIG_DIR = previous
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export const NODE_A = 'node-a'
export const NODE_B = 'node-b'
export const SENDER = `qianmo://${NODE_A}/planner`
export const RECIPIENT = `qianmo://${NODE_B}/reviewer`
export const TEAM = 'nest'

/** A valid `task.request` bound for {@link RECIPIENT}. */
export function makeEnvelope(
  overrides: Partial<{
    from: string
    to: string
    payload: unknown
    createdAt: number
    deliverTtlMs: number
    taskTtlMs: number
    type: MessageType
  }> = {},
): QianmoMessage {
  return createMessage({
    from: overrides.from ?? SENDER,
    to: overrides.to ?? RECIPIENT,
    type: overrides.type ?? MessageType.TaskRequest,
    payload: overrides.payload ?? { instruction: 'review the diff' },
    ...(overrides.createdAt === undefined
      ? {}
      : { createdAt: overrides.createdAt }),
    ...(overrides.deliverTtlMs === undefined
      ? {}
      : { deliverTtlMs: overrides.deliverTtlMs }),
    ...(overrides.taskTtlMs === undefined
      ? {}
      : { taskTtlMs: overrides.taskTtlMs }),
  })
}
