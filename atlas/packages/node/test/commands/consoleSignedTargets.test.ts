// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  generateNodeKeyPair,
  NodeCapabilities,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import type { RegistryPort } from '@qianmo/console'
import { NodeRouter } from '@qianmo/router'
import { startTransportServer, type HandshakeIdentity } from '@qianmo/transport'
import { wireConsoleChat, wireConsoleWake } from '../../src/commands/console.js'
import { parseConsoleArgs } from '../../src/commands/consoleArgs.js'
import { createWakePort } from '../../src/commands/consolePorts.js'
import { createConsoleWakeIssuer } from '../../src/commands/consoleWakeIdentity.js'
import type { ConsoleChatHub } from '../../src/commands/consoleChat.js'

const PSK = 'console-signed-target-test-transport-secret'
const BASE = [
  '--accounts',
  '--tenancy=/tmp/console-signed-target-not-opened.json',
]

for (const face of ['chat', 'wake']) {
  test(`M2 ${face} refuses unsigned, unpinned and legacy target configurations`, () => {
    const key = generateNodeKeyPair().publicKey
    const target = `--${face}-url=worker=ws://127.0.0.1:12345`
    const sign = `--${face}-sign`
    const trust = `--trust=worker=${key}`
    expect(() => parseConsoleArgs([...BASE, target, trust])).toThrow(
      '--tenancy needs',
    )
    expect(() => parseConsoleArgs([...BASE, target, sign])).toThrow(
      '--tenancy needs',
    )
    expect(() =>
      parseConsoleArgs([
        ...BASE,
        `--${face}-url=ws://127.0.0.1:12345`,
        sign,
        trust,
      ]),
    ).toThrow('--tenancy needs')
    expect(
      parseConsoleArgs([...BASE, target, sign, trust]).tenancyPath,
    ).toBeDefined()
  })
}

test('M2 chat without approvals still uses its own key and requires a pinned signed peer', () => {
  const own = generateNodeKeyPair()
  const target = generateNodeKeyPair()
  let signing: HandshakeIdentity | undefined
  const config = parseConsoleArgs([
    ...BASE,
    '--chat-url=worker=ws://127.0.0.1:12345',
    '--chat-sign',
    `--trust=worker=${target.publicKey}`,
  ])
  const wiring = wireConsoleChat(config, {} as RegistryPort, {
    pskFromEnv: () => PSK,
    loadIdentity: () => ({
      node: 'console',
      publicKey: own.publicKey,
      issue: createConsoleWakeIssuer('console', own),
    }),
    loadKeys: node => {
      expect(node).toBe('console')
      return own
    },
    createChatPort: options => {
      signing = options.signing
      return { close: async () => {} } as ConsoleChatHub
    },
  })
  expect(config.approvals).toBeUndefined()
  expect(wiring.hub).toBeDefined()
  expect(signing?.required).toBe(true)
  expect(signing?.keys.publicKey).toBe(own.publicKey)
  expect(signing?.directory.publicKeyOf('worker')).toBe(target.publicKey)
  expect(signing?.directory.publicKeyOf('other')).toBeNull()
})

test('production wake wiring reaches a mandatory signed node and wrong target key never delivers', async () => {
  const own = generateNodeKeyPair()
  const target = generateNodeKeyPair()
  const directory = new StaticPublicKeyDirectory([['console', own.publicKey]])
  const router = new NodeRouter({
    node: 'worker',
    capability: new NodeCapabilities({
      node: 'worker',
      directory,
      trustedIssuers: ['console'],
    }),
  })
  const received: string[] = []
  const server = startTransportServer({
    hostname: '127.0.0.1',
    port: 0,
    psk: PSK,
    signing: { node: 'worker', keys: target, directory, required: true },
    onMessage(message, context) {
      expect(context.channel.authenticatedPeerNode).toBe('console')
      const admitted = router.inbound(message)
      if (!admitted.ok) throw new Error(admitted.reason)
      received.push(message.msgId)
    },
  })
  try {
    for (const [key, expected] of [
      [target.publicKey, true],
      [generateNodeKeyPair().publicKey, false],
    ] as const) {
      const wiring = wireConsoleWake(
        parseConsoleArgs([
          ...BASE,
          `--wake-url=worker=${server.url}`,
          '--wake-sign',
          `--trust=worker=${key}`,
        ]),
        {
          pskFromEnv: () => PSK,
          loadIdentity: () => ({
            node: 'console',
            publicKey: own.publicKey,
            issue: createConsoleWakeIssuer('console', own),
          }),
          loadKeys: () => own,
          createWakePort: options =>
            createWakePort({ ...options, timeoutMs: 400 }),
        },
      )
      const outcome = await wiring.targets?.[0]?.wake?.send({
        node: 'worker',
        from: 'qianmo://console/operator',
        to: 'qianmo://worker/main',
        prompt: 'wake signed fixture',
        url: '',
      })
      expect(outcome?.ok).toBe(expected)
      expect(received).toHaveLength(1)
    }
  } finally {
    await server.stop()
  }
}, 10_000)
