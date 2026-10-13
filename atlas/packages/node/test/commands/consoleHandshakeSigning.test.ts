// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateNodeKeyPair,
  NodeCapabilities,
  signBytes,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import type { RegistryPort } from '@qianmo/console'
import { NodeRouter } from '@qianmo/router'
import { ProtocolErrorCode } from '@qianmo/protocol'
import {
  authSigningInput,
  computeMac,
  newChannelId,
  newNonce,
  verifyAuthAttempt,
  HandshakeRejection,
  signReady,
  verifyReady,
  type HandshakeIdentity,
} from '@qianmo/transport'
import { wireConsoleChat, wireConsoleWake } from '../../src/commands/console.js'
import { parseConsoleArgs } from '../../src/commands/consoleArgs.js'
import { createConsoleChatPort } from '../../src/commands/consoleChat.js'
import { createWakePort } from '../../src/commands/consolePorts.js'
import { createConsoleWakeIssuer } from '../../src/commands/consoleWakeIdentity.js'

const PSK = 'console-handshake-regression-secret'
const FROM = 'qianmo://console/operator'
const URL = 'ws://127.0.0.1:12345/'

function registryFor(nodes: readonly string[]): RegistryPort {
  return {
    async list() {
      return {
        ok: true,
        value: nodes.map(node => ({
          address: `qianmo://${node}/main`,
          endpoint: node === 'worker' ? URL : 'ws://127.0.0.1:12346/',
          capabilities: [],
          status: 'online' as const,
          registeredAt: 1,
          lastHeartbeatAt: 1,
          expiresAt: Number.MAX_SAFE_INTEGER,
        })),
      }
    },
    async register() {
      return { ok: false, failure: { code: 'unsupported', message: 'unused' } }
    },
    async deregister() {
      return { ok: false, failure: { code: 'unsupported', message: 'unused' } }
    },
    async heartbeat() {
      return { ok: false, failure: { code: 'unsupported', message: 'unused' } }
    },
  }
}

/** Real verifier, with the same signed tuple a TransportClient sends. */
function authenticate(
  signing: HandshakeIdentity | undefined,
  required: boolean,
) {
  const serverNonce = newNonce()
  const clientNonce = newNonce()
  const channelId = newChannelId()
  return verifyAuthAttempt(
    PSK,
    signing === undefined
      ? {
          keys: generateNodeKeyPair(),
          directory: new StaticPublicKeyDirectory(),
          required,
        }
      : {
          keys: generateNodeKeyPair(),
          directory: new StaticPublicKeyDirectory([
            ['console', signing.keys.publicKey],
          ]),
          required,
        },
    serverNonce,
    {
      node: 'console',
      nonce: serverNonce,
      clientNonce,
      channelId,
      mac: computeMac(PSK, serverNonce, clientNonce, 'console', channelId),
      ...(signing === undefined
        ? {}
        : {
            sig: signBytes(
              signing.keys,
              authSigningInput(serverNonce, clientNonce, 'console', channelId),
            ),
          }),
    },
  )
}

for (const approvals of [false, true]) {
  test(`wake authenticates to a mandatory signed peer without tenancy (approvals=${approvals})`, () => {
    const own = generateNodeKeyPair()
    const peer = generateNodeKeyPair()
    let seen: Parameters<typeof createWakePort>[0] | undefined
    const config = parseConsoleArgs([
      '--wake-sign',
      `--wake-url=worker=${URL}`,
      `--trust=worker=${peer.publicKey}`,
      ...(approvals
        ? [
            '--accounts',
            '--approvals',
            '--chat-sign',
            `--chat-url=worker=${URL}`,
          ]
        : []),
    ])
    const wiring = wireConsoleWake(config, {
      pskFromEnv: () => PSK,
      loadIdentity: () => ({
        node: 'console',
        publicKey: own.publicKey,
        issue: createConsoleWakeIssuer('console', own),
      }),
      loadKeys: () => own,
      // Only capture here: wireConsoleWake turns any throw from this seam
      // into "PSK unavailable", so an assertion inside it could never fail
      // the test.
      createWakePort: options => {
        seen = options
        return createWakePort(options)
      },
    })
    expect(wiring.targets?.[0]?.wake).toBeDefined()
    expect(wiring.targets?.[0]?.unavailableReason).toBeUndefined()
    expect(seen?.signing?.required).toBe(true)
    expect(seen?.signing?.directory.publicKeyOf('worker')).toBe(peer.publicKey)
    // A peer that requires signatures takes the console's signed attempt…
    expect(authenticate(seen?.signing, true)).toMatchObject({
      ok: true,
      authentication: 'signature',
    })
    // …and refuses the same attempt without one, so the pass above is the
    // signature's doing and not the PSK's.
    expect(authenticate(undefined, true)).toMatchObject({ ok: false })
  })
}

test('chat signs a pinned peer and keeps an unknown peer on PSK in the same hub without tenancy or approvals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'console-handshake-'))
  const own = generateNodeKeyPair()
  const peer = generateNodeKeyPair()
  const warnings: string[] = []
  const attempts: unknown[] = []
  const config = parseConsoleArgs([
    '--chat-sign',
    `--chat-url=worker=${URL}`,
    '--chat-url=unknown=ws://127.0.0.1:12346/',
    `--trust=worker=${peer.publicKey}`,
    `--chat-store=${join(root, 'chat.ndjson')}`,
  ])
  const registry = registryFor(['worker', 'unknown'])
  const wiring = wireConsoleChat(config, registry, {
    pskFromEnv: () => PSK,
    loadIdentity: () => ({
      node: 'console',
      publicKey: own.publicKey,
      issue: createConsoleWakeIssuer('console', own),
    }),
    loadKeys: () => own,
    onWarning: message => warnings.push(message),
    createChatPort: options =>
      createConsoleChatPort({
        ...options,
        dial: input => ({
          connect: async () => {
            const result = authenticate(
              input.signing,
              input.peerNode === 'worker',
            )
            attempts.push(result)
            if (!result.ok) throw new Error(result.rejection)
            if (input.peerNode === 'worker') {
              expect(input.signing?.required).toBe(true)
              expect(input.signing?.directory.publicKeyOf('worker')).toBe(
                peer.publicKey,
              )
            }
          },
          sendAndWait: async message => {
            expect(message.from).toBe(FROM)
            return 'accepted'
          },
          close: async () => {},
          isClosed: () => false,
        }),
      }),
  })
  try {
    for (const node of ['worker', 'unknown']) {
      const opened = await wiring.hub!.open(`qianmo://${node}/main`)
      if (!opened.ok) throw new Error(opened.failure.message)
      const sent = await wiring.hub!.send({
        sessionId: opened.value.id,
        text: 'signed fixture',
      })
      expect(sent.ok).toBe(true)
    }
    expect(attempts).toMatchObject([
      { ok: true, authentication: 'signature' },
      { ok: true, authentication: 'psk' },
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('unknown')
    expect(warnings[0]).toContain('--trust')
    expect(warnings[0]).toContain('PSK')
    expect(wiring.handshakeSigning).toContain('worker: signed')
    expect(wiring.handshakeSigning).toContain('unknown: PSK')
  } finally {
    await wiring.hub?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('signed wake with an unknown public key stays on PSK, warns, and cannot authenticate to a mandatory signed peer', () => {
  const own = generateNodeKeyPair()
  const warnings: string[] = []
  let signing: HandshakeIdentity | undefined
  const wiring = wireConsoleWake(
    parseConsoleArgs(['--wake-sign', `--wake-url=worker=${URL}`]),
    {
      pskFromEnv: () => PSK,
      loadIdentity: () => ({
        node: 'console',
        publicKey: own.publicKey,
        issue: createConsoleWakeIssuer('console', own),
      }),
      loadKeys: () => own,
      onWarning: message => warnings.push(message),
      createWakePort: options => {
        signing = options.signing
        return createWakePort(options)
      },
    },
  )
  expect(signing).toBeUndefined()
  expect(authenticate(signing, false)).toMatchObject({
    ok: true,
    authentication: 'psk',
  })
  expect(authenticate(signing, true)).toEqual({
    ok: false,
    rejection: HandshakeRejection.SignatureRequired,
  })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('worker')
  expect(warnings[0]).toContain('PSK')
  expect(wiring.targets?.[0]?.wake).toBeDefined()
  expect(wiring.handshakeSigning).toContain('worker: PSK')
})

test('production signed wake rejects another sender locally even when the target key is unknown', async () => {
  const own = generateNodeKeyPair()
  let issued = 0
  const wiring = wireConsoleWake(
    parseConsoleArgs(['--wake-sign', `--wake-url=worker=${URL}`]),
    {
      pskFromEnv: () => PSK,
      loadIdentity: () => ({
        node: 'console',
        publicKey: own.publicKey,
        issue: () => {
          issued++
          return 'unused'
        },
      }),
      loadKeys: () => own,
      onWarning: () => {},
      createWakePort: options => createWakePort({ ...options, timeoutMs: 20 }),
    },
  )
  const result = await wiring.targets![0]!.wake!.send({
    from: 'qianmo://other/operator',
    to: 'qianmo://worker/main',
    prompt: 'spoof',
    url: '',
  })
  expect(result).toMatchObject({ ok: false, failure: { code: 'rejected' } })
  if (result.ok) throw new Error('spoof delivered')
  expect(result.failure.message).toContain('E_SENDER_MISMATCH')
  expect(issued).toBe(0)
})

for (const reply of ['wrong-key', 'unsigned-ready'] as const) {
  test(`pinned chat refuses ${reply} and never redials or sends with PSK`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'console-handshake-'))
    const own = generateNodeKeyPair()
    const peer = generateNodeKeyPair()
    const configured = reply === 'wrong-key' ? generateNodeKeyPair() : peer
    const attempts: boolean[] = []
    let sent = 0
    let closed = 0
    const wiring = wireConsoleChat(
      parseConsoleArgs([
        '--chat-sign',
        `--chat-url=worker=${URL}`,
        `--trust=worker=${configured.publicKey}`,
        `--chat-store=${join(root, 'chat.ndjson')}`,
      ]),
      registryFor(['worker']),
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
            dial: input => ({
              async connect() {
                attempts.push(input.signing?.required === true)
                // A missing production signing binding cannot prove the pinned peer.
                if (input.signing === undefined) return
                const tuple = {
                  serverNonce: newNonce(),
                  clientNonce: newNonce(),
                  channelId: newChannelId(),
                  node: 'console',
                }
                const frame =
                  reply === 'unsigned-ready'
                    ? {}
                    : signReady(
                        {
                          node: 'worker',
                          keys: peer,
                          directory: new StaticPublicKeyDirectory(),
                        },
                        tuple.serverNonce,
                        tuple.clientNonce,
                        tuple.node,
                        tuple.channelId,
                      )
                const result = verifyReady(
                  'worker',
                  input.signing,
                  tuple,
                  frame,
                )
                if (!result.ok) throw new Error(result.rejection)
              },
              async sendAndWait() {
                sent++
                return 'accepted'
              },
              async close() {
                closed++
              },
              isClosed: () => false,
            }),
          }),
      },
    )
    try {
      const opened = await wiring.hub!.open('qianmo://worker/main')
      if (!opened.ok) throw new Error(opened.failure.message)
      const outcome = await wiring.hub!.send({
        sessionId: opened.value.id,
        text: 'must not deliver',
      })
      expect(outcome).toMatchObject({
        ok: false,
        failure: { code: 'unreachable' },
      })
      if (outcome.ok) throw new Error('unauthenticated peer received a task')
      expect(outcome.failure.message).toContain(
        reply === 'wrong-key' ? 'ready_bad_signature' : 'ready_unsigned',
      )
      expect(attempts).toEqual([true])
      expect(sent).toBe(0)
      expect(closed).toBe(1)
    } finally {
      await wiring.hub?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('a signed chat handshake still sends an invalid capability through the node authorization gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'console-handshake-'))
  const own = generateNodeKeyPair()
  const peer = generateNodeKeyPair()
  const router = new NodeRouter({
    node: 'worker',
    capability: new NodeCapabilities({
      node: 'worker',
      directory: new StaticPublicKeyDirectory([['console', own.publicKey]]),
      trustedIssuers: ['console'],
    }),
  })
  let authenticated = false
  let executed = 0
  const wiring = wireConsoleChat(
    parseConsoleArgs([
      '--chat-sign',
      `--chat-url=worker=${URL}`,
      `--trust=worker=${peer.publicKey}`,
      `--chat-store=${join(root, 'chat.ndjson')}`,
    ]),
    registryFor(['worker']),
    {
      pskFromEnv: () => PSK,
      loadIdentity: () => ({
        node: 'console',
        publicKey: own.publicKey,
        issue: () => 'invalid-capability',
      }),
      loadKeys: () => own,
      createChatPort: options =>
        createConsoleChatPort({
          ...options,
          dial: input => ({
            async connect() {
              const result = authenticate(input.signing, true)
              if (!result.ok) throw new Error(result.rejection)
              authenticated = result.authentication === 'signature'
            },
            async sendAndWait(message) {
              const decision = router.inbound(message)
              if (!decision.ok)
                throw new Error(`${decision.code}: ${decision.reason}`)
              executed++
              return 'accepted'
            },
            async close() {},
            isClosed: () => false,
          }),
        }),
    },
  )
  try {
    const opened = await wiring.hub!.open('qianmo://worker/main')
    if (!opened.ok) throw new Error(opened.failure.message)
    const outcome = await wiring.hub!.send({
      sessionId: opened.value.id,
      text: 'unauthorized task',
    })
    expect(authenticated).toBe(true)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unauthorized task delivered')
    expect(outcome.failure.message).toContain(ProtocolErrorCode.E_CAP_INVALID)
    expect(executed).toBe(0)
  } finally {
    await wiring.hub?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unknown chat key retains PSK but a mandatory signed peer fails with migration guidance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'console-handshake-'))
  const own = generateNodeKeyPair()
  let sent = 0
  const wiring = wireConsoleChat(
    parseConsoleArgs([
      '--chat-sign',
      `--chat-url=worker=${URL}`,
      `--chat-store=${join(root, 'chat.ndjson')}`,
    ]),
    registryFor(['worker']),
    {
      pskFromEnv: () => PSK,
      onWarning: () => {},
      loadIdentity: () => ({
        node: 'console',
        publicKey: own.publicKey,
        issue: createConsoleWakeIssuer('console', own),
      }),
      loadKeys: () => own,
      createChatPort: options =>
        createConsoleChatPort({
          ...options,
          dial: input => ({
            async connect() {
              const result = authenticate(input.signing, true)
              if (!result.ok)
                throw new Error('transport handshake rejected (4003)')
            },
            async sendAndWait() {
              sent++
              return 'accepted'
            },
            async close() {},
            isClosed: () => false,
          }),
        }),
    },
  )
  try {
    const opened = await wiring.hub!.open('qianmo://worker/main')
    if (!opened.ok) throw new Error(opened.failure.message)
    const outcome = await wiring.hub!.send({
      sessionId: opened.value.id,
      text: 'needs signed handshake',
    })
    expect(outcome).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    if (outcome.ok) throw new Error('PSK reached a mandatory signed peer')
    expect(outcome.failure.message).toContain('PSK')
    expect(outcome.failure.message).toContain('--trust')
    expect(sent).toBe(0)
  } finally {
    await wiring.hub?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

for (const face of ['wake', 'chat'] as const) {
  test(`${face} signing key failures stop startup before a port can be created`, () => {
    const own = generateNodeKeyPair()
    const peer = generateNodeKeyPair()
    const config = parseConsoleArgs([
      `--${face}-sign`,
      `--${face}-url=worker=${URL}`,
      `--trust=worker=${peer.publicKey}`,
    ])
    let created = 0
    const dependencies = {
      pskFromEnv: () => PSK,
      loadIdentity: () => ({
        node: 'console',
        publicKey: own.publicKey,
        issue: createConsoleWakeIssuer('console', own),
      }),
      loadKeys: () => {
        throw new Error('console command key unavailable')
      },
    }
    expect(() => {
      if (face === 'wake')
        wireConsoleWake(config, {
          ...dependencies,
          createWakePort: options => {
            created++
            return createWakePort(options)
          },
        })
      else
        wireConsoleChat(config, registryFor(['worker']), {
          ...dependencies,
          createChatPort: options => {
            created++
            return createConsoleChatPort(options)
          },
        })
    }).toThrow('console command key unavailable')
    expect(created).toBe(0)
  })
}
