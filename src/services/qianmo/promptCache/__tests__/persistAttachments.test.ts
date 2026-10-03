// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.19 CH-2 / T-8, the half a unit test can hold: outside the node identity
 * nothing about the transcript changes. The node half — a real `--acp` child
 * writing its attachments and resuming byte-identical — is
 * `tests/integration/qianmo-prompt-cache.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import type { Message } from 'src/types/message.js'
import { IDENTITY_MODE, NODE_IDENTITY_MODE } from 'src/constants/identity.js'
import { isLoggableMessage } from 'src/utils/sessionStorage.js'
import { persistsPromptAttachments } from '../persistAttachments.js'

const attachment = {
  type: 'attachment',
  uuid: '00000000-0000-4000-8000-000000000000',
  attachment: { type: 'date_change', newDate: '2026-10-04' },
} as unknown as Message

describe('persistsPromptAttachments outside the node identity', () => {
  test('this suite runs as a non-node identity', () => {
    expect(IDENTITY_MODE).not.toBe(NODE_IDENTITY_MODE)
  })

  test('off, so isLoggableMessage drops attachments exactly as the base does', () => {
    expect(persistsPromptAttachments()).toBe(false)
    const savedUserType = process.env.USER_TYPE
    delete process.env.USER_TYPE
    try {
      expect(isLoggableMessage(attachment)).toBe(false)
    } finally {
      if (savedUserType !== undefined) process.env.USER_TYPE = savedUserType
    }
  })
})
