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
  test(`directed ${direction} task validates; unknown fields cannot cross the wire`, () => {
    const payload = { prompt: 'hello', direction }
    const message = createMessage({
      type: MessageType.TaskRequest,
      from: 'qianmo://hub/operator',
      to: 'qianmo://node/main',
      payload,
    })
    expect(validateMessage(message, { now: Date.now() }).ok).toBe(true)
    expect(
      validateMessage(
        { ...message, payload: { ...payload, extra: 1 } },
        { now: Date.now() },
      ).ok,
    ).toBe(false)
  })
test('bad hints reject, legacy opaque payloads keep their old contract', () => {
  expect(
    isDirectedTaskRequestPayload({ prompt: 'hello', direction: 'dance' }),
  ).toBe(false)
  const message = createMessage({
    type: MessageType.TaskRequest,
    from: 'qianmo://hub/operator',
    to: 'qianmo://node/main',
    payload: { goal: 'hello', oldField: 1 },
  })
  expect(validateMessage(message, { now: Date.now() }).ok).toBe(true)
})
