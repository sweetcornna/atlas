// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The signed handshake, at the level of the functions that decide it
 * (key-distribution.md §7.1 / §7.1.1). The end-to-end half is in
 * `signed-handshake.test.ts`; this file pins the verdicts.
 *
 * Zero mocks: every signature here is a real Ed25519 signature over real
 * bytes, because the only interesting failures are the ones where the bytes
 * differ by something a mock would have papered over.
 */

import { describe, expect, test } from 'bun:test'
import {
  StaticPublicKeyDirectory,
  generateNodeKeyPair,
  signBytes,
  verifyBytes,
} from '@qianmo/capability'
import {
  HANDSHAKE_SIGNATURE_DOMAIN,
  HandshakeRejection,
  ReadyRejection,
  authSigningInput,
  computeMac,
  newNonce,
  readySigningInput,
  signReady,
  verifyAuthAttempt,
  verifyReady,
  type AuthAttempt,
  type HandshakeIdentity,
} from '../src/index.js'
import { TEST_PSK, WRONG_PSK } from './helpers.js'

const CHANNEL_ID = 'a'.repeat(32)

const dialerKeys = generateNodeKeyPair()
const listenerKeys = generateNodeKeyPair()
const impostorKeys = generateNodeKeyPair()

function directory(): StaticPublicKeyDirectory {
  return new StaticPublicKeyDirectory([
    ['node-a', dialerKeys.publicKey],
    ['node-b', listenerKeys.publicKey],
  ])
}

function listenerIdentity(required = false) {
  return {
    node: 'node-b',
    keys: listenerKeys,
    directory: directory(),
    required,
  }
}

function signedAttempt(
  serverNonce: string,
  overrides: Partial<AuthAttempt> = {},
  signWith = dialerKeys,
): AuthAttempt {
  const clientNonce = overrides.clientNonce ?? newNonce()
  const node = overrides.node ?? 'node-a'
  const channelId = overrides.channelId ?? CHANNEL_ID
  return {
    node,
    nonce: overrides.nonce ?? serverNonce,
    clientNonce,
    channelId,
    mac:
      overrides.mac ??
      computeMac(TEST_PSK, serverNonce, clientNonce, node, channelId),
    sig:
      'sig' in overrides
        ? overrides.sig
        : signBytes(
            signWith,
            authSigningInput(serverNonce, clientNonce, node, channelId),
          ),
  }
}

describe('signing input', () => {
  test('carries the domain prefix and the tuple the MAC covers', () => {
    const input = authSigningInput('sn', 'cn', 'node-a', CHANNEL_ID)
    expect(input).toBe(
      `${HANDSHAKE_SIGNATURE_DOMAIN}\n${JSON.stringify([1, 'sn', 'cn', 'node-a', CHANNEL_ID])}`,
    )
  })

  test('the two directions can never be confused for one another', () => {
    // Six fields against five: a dialer's signature is not a well-formed
    // listener signature over *any* tuple, whatever the node segments are.
    const auth = authSigningInput('sn', 'cn', 'node-a', CHANNEL_ID)
    const ready = readySigningInput('sn', 'cn', 'node-a', CHANNEL_ID, 'node-b')
    expect(ready).not.toBe(auth)
    expect(
      verifyBytes(dialerKeys.publicKey, ready, signBytes(dialerKeys, auth)),
    ).toBe(false)
  })

  test('a node name containing a separator cannot forge another tuple', () => {
    // Why the tuple is a JSON array rather than a concatenation: the two
    // spellings below would collide under any separator-joined encoding.
    expect(authSigningInput('sn', 'cn', 'a","b', CHANNEL_ID)).not.toBe(
      authSigningInput('sn', 'cn","b', 'a', CHANNEL_ID),
    )
  })
})

describe('verifyAuthAttempt — which proof is taken', () => {
  test('no signing material: the MAC decides, and `sig` is not read', () => {
    const nonce = newNonce()
    // A signature by a total stranger, on a listener with no directory: it is
    // not merely unchecked, there is nothing here that could check it, and the
    // MAC is still what the frame lives or dies by.
    const attempt = signedAttempt(nonce, {}, impostorKeys)
    expect(verifyAuthAttempt(TEST_PSK, undefined, nonce, attempt)).toEqual({
      ok: true,
      node: 'node-a',
      channelId: CHANNEL_ID,
    })
    expect(verifyAuthAttempt(WRONG_PSK, undefined, nonce, attempt)).toEqual({
      ok: false,
      rejection: HandshakeRejection.BadMac,
    })
  })

  test('signing material and a signature: the signature decides, not the MAC', () => {
    const nonce = newNonce()
    const attempt = signedAttempt(nonce, { mac: 'f'.repeat(64) })
    expect(
      verifyAuthAttempt(TEST_PSK, listenerIdentity(), nonce, attempt),
    ).toEqual({ ok: true, node: 'node-a', channelId: CHANNEL_ID })
  })

  test('signing material, no signature: the MAC still decides (§8.2 phase ①)', () => {
    const nonce = newNonce()
    const attempt = signedAttempt(nonce, { sig: undefined })
    expect(
      verifyAuthAttempt(TEST_PSK, listenerIdentity(), nonce, attempt),
    ).toEqual({ ok: true, node: 'node-a', channelId: CHANNEL_ID })
  })

  test('signing material with `required`: an unsigned frame is refused', () => {
    const nonce = newNonce()
    const attempt = signedAttempt(nonce, { sig: undefined })
    expect(
      verifyAuthAttempt(TEST_PSK, listenerIdentity(true), nonce, attempt),
    ).toEqual({ ok: false, rejection: HandshakeRejection.SignatureRequired })
  })
})

describe('verifyAuthAttempt — the signature itself', () => {
  test('a signature by another key over the same tuple is refused', () => {
    const nonce = newNonce()
    const attempt = signedAttempt(nonce, {}, impostorKeys)
    expect(
      verifyAuthAttempt(TEST_PSK, listenerIdentity(), nonce, attempt),
    ).toEqual({ ok: false, rejection: HandshakeRejection.BadSignature })
  })

  test('`node` is authority: a valid signature cannot be moved onto another name', () => {
    // The whole of DoD 4. `node-a` signs its own tuple, then the frame claims
    // to be `node-b` — which is what a PSK holder gets away with today.
    const nonce = newNonce()
    const clientNonce = newNonce()
    const attempt: AuthAttempt = {
      node: 'node-b',
      nonce,
      clientNonce,
      channelId: CHANNEL_ID,
      mac: computeMac(TEST_PSK, nonce, clientNonce, 'node-b', CHANNEL_ID),
      sig: signBytes(
        dialerKeys,
        authSigningInput(nonce, clientNonce, 'node-a', CHANNEL_ID),
      ),
    }
    expect(
      verifyAuthAttempt(TEST_PSK, listenerIdentity(), nonce, attempt),
    ).toEqual({ ok: false, rejection: HandshakeRejection.BadSignature })
    // And the MAC alone would have let it through — that is the difference the
    // signature buys.
    expect(verifyAuthAttempt(TEST_PSK, undefined, nonce, attempt)).toEqual({
      ok: true,
      node: 'node-b',
      channelId: CHANNEL_ID,
    })
  })

  test('a node with no published key is refused, distinctly, in the record', () => {
    const nonce = newNonce()
    const identity: HandshakeIdentity = {
      keys: listenerKeys,
      directory: new StaticPublicKeyDirectory(),
    }
    expect(
      verifyAuthAttempt(TEST_PSK, identity, nonce, signedAttempt(nonce)),
    ).toEqual({ ok: false, rejection: HandshakeRejection.UnknownSigner })
  })

  test('a signature made for another channel or nonce does not travel', () => {
    const nonce = newNonce()
    const other = newNonce()
    const clientNonce = newNonce()
    const replayed: AuthAttempt = {
      node: 'node-a',
      nonce,
      clientNonce,
      channelId: CHANNEL_ID,
      mac: computeMac(TEST_PSK, nonce, clientNonce, 'node-a', CHANNEL_ID),
      sig: signBytes(
        dialerKeys,
        authSigningInput(other, clientNonce, 'node-a', CHANNEL_ID),
      ),
    }
    expect(
      verifyAuthAttempt(TEST_PSK, listenerIdentity(), nonce, replayed),
    ).toEqual({ ok: false, rejection: HandshakeRejection.BadSignature })
  })

  test('the cheap structural checks still run first, signed or not', () => {
    const nonce = newNonce()
    expect(
      verifyAuthAttempt(
        TEST_PSK,
        listenerIdentity(),
        nonce,
        signedAttempt(nonce, { node: 'not a segment' }),
      ),
    ).toEqual({ ok: false, rejection: HandshakeRejection.BadNode })
    expect(
      verifyAuthAttempt(
        TEST_PSK,
        listenerIdentity(),
        nonce,
        signedAttempt(nonce, { channelId: 'short' }),
      ),
    ).toEqual({ ok: false, rejection: HandshakeRejection.BadChannel })
    expect(
      verifyAuthAttempt(
        TEST_PSK,
        listenerIdentity(),
        nonce,
        signedAttempt(nonce, { nonce: newNonce() }),
      ),
    ).toEqual({ ok: false, rejection: HandshakeRejection.NonceMismatch })
  })
})

describe('verifyReady — the listener proves itself back (§7.1.1)', () => {
  const tuple = {
    serverNonce: 'sn',
    clientNonce: 'cn',
    node: 'node-a',
    channelId: CHANNEL_ID,
  }
  const dialerIdentity = (required = false): HandshakeIdentity => ({
    keys: dialerKeys,
    directory: directory(),
    required,
  })

  test('accepts the listener it dialled', () => {
    const frame = signReady(
      listenerIdentity(),
      tuple.serverNonce,
      tuple.clientNonce,
      tuple.node,
      tuple.channelId,
    )
    expect(verifyReady('node-b', dialerIdentity(), tuple, frame)).toEqual({
      ok: true,
    })
  })

  test('an endpoint that answers as somebody else is refused (T-B′)', () => {
    // The redirect case: a node inside the network, holding a valid
    // certificate, answering a dial meant for `node-b`. It signs perfectly —
    // as itself — and that is exactly why it fails.
    const frame = signReady(
      { node: 'node-c', keys: impostorKeys, directory: directory() },
      tuple.serverNonce,
      tuple.clientNonce,
      tuple.node,
      tuple.channelId,
    )
    expect(verifyReady('node-b', dialerIdentity(), tuple, frame)).toEqual({
      ok: false,
      rejection: ReadyRejection.WrongNode,
    })
  })

  test('claiming the dialled name without the key is refused', () => {
    const frame = signReady(
      { node: 'node-b', keys: impostorKeys, directory: directory() },
      tuple.serverNonce,
      tuple.clientNonce,
      tuple.node,
      tuple.channelId,
    )
    expect(verifyReady('node-b', dialerIdentity(), tuple, frame)).toEqual({
      ok: false,
      rejection: ReadyRejection.BadSignature,
    })
  })

  test('a signature over a different tuple does not carry over', () => {
    const frame = signReady(
      listenerIdentity(),
      'another-nonce',
      tuple.clientNonce,
      tuple.node,
      tuple.channelId,
    )
    expect(verifyReady('node-b', dialerIdentity(), tuple, frame)).toEqual({
      ok: false,
      rejection: ReadyRejection.BadSignature,
    })
  })

  test('an unsigned ready passes in phase ① and is refused with `required`', () => {
    expect(verifyReady('node-b', dialerIdentity(), tuple, {})).toEqual({
      ok: true,
    })
    expect(verifyReady('node-b', dialerIdentity(true), tuple, {})).toEqual({
      ok: false,
      rejection: ReadyRejection.Unsigned,
    })
    // Half a declaration is not a declaration: a `node` with no signature is
    // the unsigned case, not a weaker signed one.
    expect(
      verifyReady('node-b', dialerIdentity(true), tuple, { node: 'node-b' }),
    ).toEqual({ ok: false, rejection: ReadyRejection.Unsigned })
  })

  test('a listener whose key is not published yet is refused', () => {
    const frame = signReady(
      listenerIdentity(),
      tuple.serverNonce,
      tuple.clientNonce,
      tuple.node,
      tuple.channelId,
    )
    const empty: HandshakeIdentity = {
      keys: dialerKeys,
      directory: new StaticPublicKeyDirectory(),
    }
    expect(verifyReady('node-b', empty, tuple, frame)).toEqual({
      ok: false,
      rejection: ReadyRejection.UnknownSigner,
    })
  })
})
