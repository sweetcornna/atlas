// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { createMessage, MessageType } from '@qianmo/protocol'
import {
  generateNodeKeyPair,
  signTaskOwner,
  verifiedTaskOwner,
} from '../src/index.js'

test('only a configured console key can assert the account, and its proof binds the request body, destination, context and task', () => {
  const keys = generateNodeKeyPair(),
    other = generateNodeKeyPair()
  const controllers = new Map([['hub', keys.publicKey]])
  const owner = 'u:0123456789abcdef'
  const raw = createMessage({
    from: 'qianmo://hub/console',
    to: 'qianmo://worker/helper',
    type: MessageType.TaskRequest,
    contextId: 'chat',
    payload: { prompt: 'remember', onBehalfOf: owner },
  })
  const signed = signTaskOwner(raw, keys)
  expect(verifiedTaskOwner(signed, controllers)).toBe(owner)
  expect(verifiedTaskOwner(raw, controllers)).toBeUndefined()
  expect(
    verifiedTaskOwner(signTaskOwner(raw, other), controllers),
  ).toBeUndefined()
  expect(verifiedTaskOwner(signed, new Map())).toBeUndefined()
  for (const change of [
    { taskId: crypto.randomUUID() },
    { to: 'qianmo://worker/other' },
    { contextId: 'other' },
    {
      payload: {
        ...(signed.payload as Record<string, unknown>),
        onBehalfOf: 'u:abcdef0123456789',
      },
    },
    {
      payload: {
        ...(signed.payload as Record<string, unknown>),
        prompt: 'changed',
      },
    },
  ])
    expect(
      verifiedTaskOwner({ ...signed, ...change }, controllers),
    ).toBeUndefined()
  expect(() =>
    signTaskOwner({ ...raw, payload: { onBehalfOf: 'legacy:view' } }, keys),
  ).toThrow('principal')
})
