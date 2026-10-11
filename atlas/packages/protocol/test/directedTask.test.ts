// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  createMessage,
  MessageType,
  validateMessage,
  isDirectedTaskRequestPayload,
} from '../src/index.js'
for (const direction of [
  'code',
  'chat',
  'plan',
  'fast',
  'vision',
  'image',
  'speech',
  'video',
])
  test(`directed ${direction} task validates, beside the payload's other fields`, () => {
    const payload = { prompt: 'hello', direction }
    const message = createMessage({
      type: MessageType.TaskRequest,
      from: 'qianmo://hub/operator',
      to: 'qianmo://node/main',
      payload,
    })
    expect(validateMessage(message, { now: Date.now() }).ok).toBe(true)
    // A local command rides beside the hint (P18.20): payloads stay open.
    expect(
      validateMessage(
        { ...message, payload: { ...payload, command: { name: 'compact' } } },
        { now: Date.now() },
      ).ok,
    ).toBe(true)
  })
test('bad hints reject, legacy opaque payloads keep their old contract', () => {
  expect(
    isDirectedTaskRequestPayload({ prompt: 'hello', direction: 'dance' }),
  ).toBe(false)
  const bad = createMessage({
    type: MessageType.TaskRequest,
    from: 'qianmo://hub/operator',
    to: 'qianmo://node/main',
    payload: { prompt: 'hello', direction: 'dance' },
  })
  expect(validateMessage(bad, { now: Date.now() }).ok).toBe(false)
  const message = createMessage({
    type: MessageType.TaskRequest,
    from: 'qianmo://hub/operator',
    to: 'qianmo://node/main',
    payload: { goal: 'hello', oldField: 1 },
  })
  expect(validateMessage(message, { now: Date.now() }).ok).toBe(true)
})
