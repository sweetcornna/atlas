// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { createMessage, LIMITS, MessageType } from '@qianmo/protocol'
import {
  generateNodeKeyPair,
  signTaskOwner,
  verifiedBackground,
  verifiedChain,
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

test('the background marker counts only under a verified owner proof, which covers it', () => {
  const keys = generateNodeKeyPair()
  const controllers = new Map([['hub', keys.publicKey]])
  const raw = createMessage({
    from: 'qianmo://hub/console',
    to: 'qianmo://worker/helper',
    type: MessageType.TaskRequest,
    contextId: 'worker-session',
    payload: {
      prompt: 'next phase',
      onBehalfOf: 'legacy:admin',
      background: true,
    },
  })
  const signed = signTaskOwner(raw, keys)
  expect(verifiedBackground(signed, controllers)).toBe(true)
  // Unsigned, or signed by a key this node does not hold: ignored.
  expect(verifiedBackground(raw, controllers)).toBe(false)
  expect(
    verifiedBackground(signTaskOwner(raw, generateNodeKeyPair()), controllers),
  ).toBe(false)
  // A relay can neither strip nor add it under the same proof.
  const payload = signed.payload as Record<string, unknown>
  const { background: _dropped, ...stripped } = payload
  expect(
    verifiedTaskOwner({ ...signed, payload: stripped }, controllers),
  ).toBeUndefined()
  const interactive = signTaskOwner(
    { ...raw, payload: { prompt: 'hi', onBehalfOf: 'legacy:admin' } },
    keys,
  )
  expect(verifiedBackground(interactive, controllers)).toBe(false)
  expect(
    verifiedBackground(
      {
        ...interactive,
        payload: {
          ...(interactive.payload as Record<string, unknown>),
          background: true,
        },
      },
      controllers,
    ),
  ).toBe(false)
})

test('the call chain of an ask counts only under a verified owner proof, and only well formed', () => {
  const keys = generateNodeKeyPair()
  const controllers = new Map([['hub', keys.publicKey]])
  const chain = [
    { node: 'node-a', taskId: crypto.randomUUID() },
    { node: 'node-b', taskId: crypto.randomUUID() },
  ]
  const ask = (payloadChain: unknown) =>
    createMessage({
      from: 'qianmo://hub/console',
      to: 'qianmo://node-a/reviewer',
      type: MessageType.TaskRequest,
      contextId: 'peer-session',
      payload: {
        prompt: '来自 qianmo://node-b/coder 的提问',
        onBehalfOf: 'legacy:admin',
        chain: payloadChain,
      },
    })
  const signed = signTaskOwner(ask(chain), keys)
  expect(verifiedChain(signed, controllers)).toEqual(chain)
  // Unsigned, or signed by a key this node does not hold: no chain.
  expect(verifiedChain(ask(chain), controllers)).toBeUndefined()
  expect(
    verifiedChain(
      signTaskOwner(ask(chain), generateNodeKeyPair()),
      controllers,
    ),
  ).toBeUndefined()
  // The proof covers it: a relay can neither add, strip nor change a link.
  const payload = signed.payload as Record<string, unknown>
  const { chain: _dropped, ...stripped } = payload
  expect(
    verifiedChain({ ...signed, payload: stripped }, controllers),
  ).toBeUndefined()
  expect(
    verifiedChain(
      { ...signed, payload: { ...payload, chain: [chain[0]] } },
      controllers,
    ),
  ).toBeUndefined()
  // Signed but malformed: treated as no chain, never half read.
  const link = { node: 'node-a', taskId: 't-1' }
  for (const bad of [
    [],
    'node-a',
    Array.from({ length: LIMITS.maxAskChain + 1 }, () => link),
    [{ node: 'bad node', taskId: 't-1' }],
    [{ node: 'node-a', taskId: '' }],
    [{ node: 'node-a', taskId: 't-1', agent: 'extra' }],
    [link, null],
  ])
    expect(verifiedChain(signTaskOwner(ask(bad), keys), controllers)).toBe(
      undefined,
    )
  expect(
    verifiedChain(
      signTaskOwner(
        ask(Array.from({ length: LIMITS.maxAskChain }, () => link)),
        keys,
      ),
      controllers,
    ),
  ).toHaveLength(LIMITS.maxAskChain)
})
