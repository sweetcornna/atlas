// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  generateNodeKeyPair,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import { startTransportServer } from '@qianmo/transport'
import { createWakePort } from '../../src/commands/consolePorts.js'
import { gateWakePort } from '../../src/commands/consoleRegistrations.js'

const PSK = 'wake-revocation-loopback-fixture'
for (const revokeAt of ['never', 'delay', 'handshake', 'lifecycle'] as const) {
  test(`wake rechecks authority after ${revokeAt}: no unauthorized wire envelope`, async () => {
    const own = generateNodeKeyPair()
    const peer = generateNodeKeyPair()
    let revoked = false
    let received = 0
    let authenticated = 0
    let bound = 0
    const server = startTransportServer({
      psk: PSK,
      hostname: '127.0.0.1',
      port: 0,
      signing: {
        node: 'worker',
        keys: peer,
        required: true,
        directory: {
          publicKeyOf(node) {
            authenticated++
            if (revokeAt === 'handshake' || revokeAt === 'lifecycle')
              revoked = true
            return node === 'console' ? own.publicKey : null
          },
        },
      },
      onMessage() {
        received++
      },
    })
    try {
      const raw = createWakePort({
        url: `ws://127.0.0.1:${server.port}`,
        psk: PSK,
        timeoutMs: 2000,
        signing: {
          keys: own,
          directory: new StaticPublicKeyDirectory([['worker', peer.publicKey]]),
          required: true,
        },
      })
      const port =
        revokeAt === 'lifecycle'
          ? gateWakePort(raw, () =>
              revoked
                ? {
                    code: 'rejected',
                    message: 'target paused during handshake',
                  }
                : null,
            )
          : raw
      let checked = 0
      const pending = port.send({
        from: 'qianmo://console/operator',
        to: 'qianmo://worker/agent',
        prompt: 'authorized fixture',
        url: '',
        afterMs: revokeAt === 'delay' ? 25 : 0,
        beforeDispatch() {
          checked++
          if (revoked && revokeAt !== 'lifecycle')
            throw new Error('E_AUTH_REVOKED: fixture authority changed')
        },
        onTaskCreated() {
          bound++
        },
      })
      if (revokeAt === 'delay') revoked = true
      const result = await pending
      if (revokeAt === 'never') {
        expect(result.ok).toBe(true)
        expect(received).toBe(1)
        expect(checked).toBe(3)
        expect(bound).toBe(1)
      } else {
        expect(result).toMatchObject({
          ok: false,
          failure: { code: 'rejected' },
        })
        expect(
          result.ok ? undefined : result.failure.deliveryUnknown,
        ).toBeUndefined()
        expect(received).toBe(0)
        expect(checked).toBe(
          revokeAt === 'delay' || revokeAt === 'lifecycle' ? 2 : 3,
        )
        expect(bound).toBe(revokeAt === 'delay' ? 0 : 1)
      }
      expect(authenticated > 0).toBe(revokeAt !== 'delay')
    } finally {
      await server.stop()
    }
  })
}
