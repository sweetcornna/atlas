// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  generateNodeKeyPair,
  NodeCapabilities,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import { createMessage, createTaskResult, MessageType } from '@qianmo/protocol'
import { startTransportServer } from '@qianmo/transport'
import { dispatchA2aTask } from '../../src/commands/a2a.js'
import { loadConsoleWakeIdentity } from '../../src/commands/consoleWakeIdentity.js'

test('A2A internal boundary authenticates both fixed nodes and signs capability before real dispatch', async () => {
  const identity = loadConsoleWakeIdentity('qianmo://a2a-bridge/a2a')
  const worker = generateNodeKeyPair()
  const directory = new StaticPublicKeyDirectory([
    ['a2a-bridge', identity.publicKey],
  ])
  const cap = new NodeCapabilities({
    node: 'worker',
    directory,
    trustedIssuers: ['a2a-bridge'],
  })
  const psk = 'a2a-transport-test-only-psk-0000000'
  let accepted = 0
  const server = startTransportServer({
    hostname: '127.0.0.1',
    port: 0,
    psk,
    signing: { node: 'worker', keys: worker, directory, required: true },
    onMessage(message, context) {
      accepted++
      expect(context.channel.authenticatedPeerNode).toBe('a2a-bridge')
      expect(cap.check(message, Date.now()).ok).toBe(true)
      // Same signed node cannot resolve this call with a reply for another context.
      context.channel.send({
        ...createTaskResult(message, message.to, {
          outcome: 'completed',
          content: 'wrong context',
        }),
        contextId: 'foreign',
      })
      context.channel.send(
        createTaskResult(message, message.to, {
          outcome: 'completed',
          content: 'verified',
        }),
      )
    },
  })
  try {
    const request = createMessage({
      from: 'qianmo://a2a-bridge/sdk',
      to: 'qianmo://worker/dev',
      type: MessageType.TaskRequest,
      contextId: 'expected',
      payload: { prompt: 'work' },
    })
    const reply = await dispatchA2aTask(
      {
        node: 'a2a-bridge',
        target: request.to,
        targetPublicKey: worker.publicKey,
        endpoint: server.url!,
        psk,
      },
      request,
      AbortSignal.timeout(3000),
    )
    expect(reply.payload).toMatchObject({ content: 'verified' })
    expect(accepted).toBe(1)
  } finally {
    await server.stop()
  }
})

for (const mode of ['wrong-target-key', 'unsigned-server'] as const)
  test(`A2A refuses ${mode} despite matching PSK and sends zero tasks`, async () => {
    const identity = loadConsoleWakeIdentity('qianmo://a2a-bridge/a2a')
    const worker = generateNodeKeyPair(),
      trusted = generateNodeKeyPair()
    const psk = 'a2a-transport-test-only-psk-0000000'
    let accepted = 0
    const server = startTransportServer({
      hostname: '127.0.0.1',
      port: 0,
      psk,
      ...(mode === 'unsigned-server'
        ? {}
        : {
            signing: {
              node: 'worker',
              keys: worker,
              directory: new StaticPublicKeyDirectory([
                ['a2a-bridge', identity.publicKey],
              ]),
              required: true,
            },
          }),
      onMessage: () => {
        accepted++
      },
    })
    try {
      const message = createMessage({
        from: 'qianmo://a2a-bridge/sdk',
        to: 'qianmo://worker/dev',
        type: MessageType.TaskRequest,
        payload: { prompt: 'must not execute' },
      })
      await expect(
        dispatchA2aTask(
          {
            node: 'a2a-bridge',
            target: message.to,
            targetPublicKey: trusted.publicKey,
            endpoint: server.url!,
            psk,
          },
          message,
          AbortSignal.timeout(700),
        ),
      ).rejects.toThrow()
      expect(accepted).toBe(0)
    } finally {
      await server.stop()
    }
  }, 3000)
