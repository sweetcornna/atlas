// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateNodeKeyPair,
  NodeCapabilities,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import type { RegistryPort } from '@qianmo/console'
import { NodeRouter } from '@qianmo/router'
import { errorReply, ProtocolErrorCode } from '@qianmo/protocol'
import { startTransportServer, type HandshakeIdentity } from '@qianmo/transport'
import { wireConsoleChat, wireConsoleWake } from '../../src/commands/console.js'
import { parseConsoleArgs } from '../../src/commands/consoleArgs.js'
import { createWakePort } from '../../src/commands/consolePorts.js'
import { createConsoleWakeIssuer } from '../../src/commands/consoleWakeIdentity.js'
import {
  createConsoleChatPort,
  type ConsoleChatHub,
} from '../../src/commands/consoleChat.js'

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
      signing = options.endpoints[0]?.signing
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

for (const mode of ['no-tenancy', 'approvals', 'tenancy'] as const) {
  test(`production wake wiring reaches a mandatory signed node and wrong target key never delivers (${mode})`, async () => {
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
            ...(mode === 'tenancy'
              ? BASE
              : mode === 'approvals'
                ? [
                    '--accounts',
                    '--approvals',
                    '--chat-sign',
                    `--chat-url=worker=${server.url}`,
                  ]
                : []),
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
}

test('production chat without tenancy or approvals reaches a mandatory signed peer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'console-signed-chat-'))
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
  let received = 0
  const server = startTransportServer({
    hostname: '127.0.0.1',
    port: 0,
    psk: PSK,
    signing: { node: 'worker', keys: target, directory, required: true },
    onMessage(message, context) {
      expect(context.channel.authenticatedPeerNode).toBe('console')
      const admitted = router.inbound(message)
      if (!admitted.ok) throw new Error(admitted.reason)
      received++
    },
  })
  let hub: ConsoleChatHub | undefined
  try {
    const registry: RegistryPort = {
      async list() {
        return {
          ok: true,
          value: [
            {
              address: 'qianmo://worker/main',
              endpoint: server.url!,
              capabilities: [],
              status: 'online' as const,
              registeredAt: 1,
              lastHeartbeatAt: 1,
              expiresAt: Number.MAX_SAFE_INTEGER,
            },
          ],
        }
      },
      async register() {
        return {
          ok: false,
          failure: { code: 'unsupported', message: 'unused' },
        }
      },
      async deregister() {
        return {
          ok: false,
          failure: { code: 'unsupported', message: 'unused' },
        }
      },
      async heartbeat() {
        return {
          ok: false,
          failure: { code: 'unsupported', message: 'unused' },
        }
      },
    }
    hub = wireConsoleChat(
      parseConsoleArgs([
        '--chat-sign',
        `--chat-url=worker=${server.url}`,
        `--trust=worker=${target.publicKey}`,
        `--chat-store=${join(root, 'chat.ndjson')}`,
      ]),
      registry,
      {
        pskFromEnv: () => PSK,
        loadIdentity: () => ({
          node: 'console',
          publicKey: own.publicKey,
          issue: createConsoleWakeIssuer('console', own),
        }),
        loadKeys: () => own,
        createChatPort: options =>
          createConsoleChatPort({
            ...options,
            connectTimeoutMs: 600,
            sendTimeoutMs: 600,
          }),
      },
    ).hub
    const opened = await hub!.open('qianmo://worker/main')
    if (!opened.ok) throw new Error(opened.failure.message)
    const outcome = await hub!.send({
      sessionId: opened.value.id,
      text: 'signed command',
    })
    expect(outcome.ok).toBe(true)
    expect(received).toBe(1)
  } finally {
    await hub?.close()
    await server.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

for (const required of [false, true]) {
  test(`production wake with an unknown target key retains PSK (peer requires signature=${required})`, async () => {
    const own = generateNodeKeyPair()
    const target = generateNodeKeyPair()
    const directory = new StaticPublicKeyDirectory([['console', own.publicKey]])
    let received = 0
    const server = startTransportServer({
      hostname: '127.0.0.1',
      port: 0,
      psk: PSK,
      signing: { node: 'worker', keys: target, directory, required },
      onMessage(_message, context) {
        expect(context.channel.authenticatedPeerNode).toBeNull()
        received++
      },
    })
    try {
      const warnings: string[] = []
      const wiring = wireConsoleWake(
        parseConsoleArgs(['--wake-sign', `--wake-url=worker=${server.url}`]),
        {
          pskFromEnv: () => PSK,
          onWarning: message => warnings.push(message),
          loadIdentity: () => ({
            node: 'console',
            publicKey: own.publicKey,
            issue: createConsoleWakeIssuer('console', own),
          }),
          loadKeys: () => own,
          createWakePort: options =>
            createWakePort({ ...options, timeoutMs: 600 }),
        },
      )
      const outcome = await wiring.targets![0]!.wake!.send({
        node: 'worker',
        from: 'qianmo://console/operator',
        to: 'qianmo://worker/main',
        prompt: 'PSK migration fixture',
        url: '',
      })
      expect(outcome.ok).toBe(!required)
      expect(received).toBe(required ? 0 : 1)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('worker')
      if (!outcome.ok) {
        expect(outcome.failure.message).toContain('4003')
        expect(outcome.failure.message).toContain('PSK')
        expect(outcome.failure.message).toContain('--trust')
      }
    } finally {
      await server.stop()
    }
  })
}

test('production wake with a signed handshake still refuses an invalid capability', async () => {
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
  let authenticated = false
  let executed = 0
  const server = startTransportServer({
    hostname: '127.0.0.1',
    port: 0,
    psk: PSK,
    signing: { node: 'worker', keys: target, directory, required: true },
    onMessage(message, context) {
      authenticated = context.channel.authenticatedPeerNode === 'console'
      const admitted = router.inbound(message)
      if (!admitted.ok) {
        context.channel.send(
          errorReply(message, admitted.code, admitted.reason),
        )
        throw new Error(admitted.reason)
      }
      executed++
    },
  })
  try {
    const wiring = wireConsoleWake(
      parseConsoleArgs([
        '--wake-sign',
        `--wake-url=worker=${server.url}`,
        `--trust=worker=${target.publicKey}`,
      ]),
      {
        pskFromEnv: () => PSK,
        loadIdentity: () => ({
          node: 'console',
          publicKey: own.publicKey,
          issue: () => 'invalid-capability',
        }),
        loadKeys: () => own,
        createWakePort: options =>
          createWakePort({ ...options, timeoutMs: 600 }),
      },
    )
    const outcome = await wiring.targets![0]!.wake!.send({
      node: 'worker',
      from: 'qianmo://console/operator',
      to: 'qianmo://worker/main',
      prompt: 'unauthorized wake',
      url: '',
    })
    expect(authenticated).toBe(true)
    expect(outcome).toMatchObject({ ok: false, failure: { code: 'refused' } })
    if (outcome.ok) throw new Error('unauthorized wake delivered')
    expect(outcome.failure.message).toContain(ProtocolErrorCode.E_CAP_INVALID)
    expect(executed).toBe(0)
  } finally {
    await server.stop()
  }
})
