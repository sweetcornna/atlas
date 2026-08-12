// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isValidSegment } from '@qianmo/protocol'
import { FRAME_VERSION } from './frames.js'

/**
 * Pre-shared-key handshake — **explicitly not production grade** (charter N-3).
 *
 * What it does: proves that the dialer holds the same secret as the listener,
 * over a server-chosen single-use nonce, so a captured handshake cannot be
 * replayed onto a second connection.
 *
 * What it does **not** do, and must be replaced before anything real depends
 * on it (M1, per-node keypairs):
 *
 * - one symmetric secret shared by every node — any holder can impersonate any
 *   other node, so `node` in the auth frame is an audit label, never authority;
 * - no rotation, no expiry, no revocation;
 * - connection-level only: individual envelopes are not authenticated, so an
 *   authenticated peer may claim any `from` (that is why the inbound adapter
 *   re-renders `from` itself, protocol.md rule E-1);
 * - no forward secrecy — confidentiality on the wire comes entirely from TLS.
 *
 * The secret itself is never a literal in this repository. It is supplied by
 * the caller, typically via {@link pskFromEnv}.
 */

/** Shortest secret this package will run with. */
export const PSK_MIN_LENGTH = 16

/** Environment variable {@link pskFromEnv} reads by default. */
export const PSK_ENV_VAR = 'QIANMO_TRANSPORT_PSK'

/** Raised when a secret is missing or too weak to be worth using. */
export class WeakSecretError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WeakSecretError'
  }
}

/**
 * Throw unless `psk` is long enough to be worth the handshake.
 *
 * A short secret is worse than an obviously absent one: it looks like security
 * while being brute-forceable, and the resulting outage is remote and silent.
 */
export function assertUsablePsk(psk: string): void {
  if (psk.length < PSK_MIN_LENGTH) {
    throw new WeakSecretError(
      `pre-shared key must be at least ${PSK_MIN_LENGTH} characters, got ${psk.length}`,
    )
  }
}

/**
 * Read the pre-shared key out of the environment.
 *
 * Injection point for the whole package: no default value, no fallback, no
 * literal anywhere in the tree. A missing variable is a startup failure, not a
 * silent downgrade to an unauthenticated socket.
 */
export function pskFromEnv(
  variable: string = PSK_ENV_VAR,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env[variable]
  if (value === undefined || value.length === 0) {
    throw new WeakSecretError(`${variable} is not set`)
  }
  assertUsablePsk(value)
  return value
}

/** 32 hex characters of CSPRNG output. */
export function newNonce(): string {
  return randomBytes(16).toString('hex')
}

/**
 * `HMAC-SHA256(psk, [frameVersion, serverNonce, clientNonce, node])`, hex.
 *
 * The inputs go through `JSON.stringify` of an array rather than string
 * concatenation, so a node name containing a separator cannot be split across
 * two fields to forge a different tuple.
 */
export function computeMac(
  psk: string,
  serverNonce: string,
  clientNonce: string,
  node: string,
): string {
  return createHmac('sha256', psk)
    .update(JSON.stringify([FRAME_VERSION, serverNonce, clientNonce, node]))
    .digest('hex')
}

/** Why a handshake was refused. Stable strings — they end up in audit records. */
export enum HandshakeRejection {
  /** The bytes were not a frame of this grammar at all. */
  MalformedFrame = 'malformed_frame',
  /** Frame arrived before/instead of the expected auth frame. */
  UnexpectedFrame = 'unexpected_frame',
  /** `node` is not a legal address segment. */
  BadNode = 'bad_node',
  /** The echoed nonce is not the one this connection issued. */
  NonceMismatch = 'nonce_mismatch',
  /** The MAC does not match — wrong key, or a forged frame. */
  BadMac = 'bad_mac',
}

/** Outcome of {@link verifyAuth}. */
export type HandshakeResult =
  | { readonly ok: true; readonly node: string }
  | { readonly ok: false; readonly rejection: HandshakeRejection }

/** What {@link verifyAuth} needs out of an auth frame. */
export interface AuthAttempt {
  readonly node: string
  readonly nonce: string
  readonly clientNonce: string
  readonly mac: string
}

/** Constant-time hex comparison; unequal lengths are unequal, not a throw. */
function macEquals(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(actual, 'hex')
  if (a.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Check one auth attempt against the nonce this connection issued.
 *
 * The MAC comparison is constant-time so a wrong key cannot be recovered byte
 * by byte from response timing. The cheap structural checks run first — they
 * leak nothing an attacker does not already know.
 */
export function verifyAuth(
  psk: string,
  serverNonce: string,
  attempt: AuthAttempt,
): HandshakeResult {
  if (!isValidSegment(attempt.node)) {
    return { ok: false, rejection: HandshakeRejection.BadNode }
  }
  if (attempt.nonce !== serverNonce) {
    return { ok: false, rejection: HandshakeRejection.NonceMismatch }
  }
  const expected = computeMac(
    psk,
    serverNonce,
    attempt.clientNonce,
    attempt.node,
  )
  if (!macEquals(expected, attempt.mac)) {
    return { ok: false, rejection: HandshakeRejection.BadMac }
  }
  return { ok: true, node: attempt.node }
}

/**
 * WebSocket close code for a refused handshake.
 *
 * 4003 is what the base already uses for "unauthorized" on its own client
 * sockets (`src/cli/transports/WebSocketTransport.ts:46`), and it treats the
 * code as permanent — no reconnect storm against a door that will not open.
 * Reusing the number keeps both halves of a mixed deployment agreeing on that.
 */
export const CLOSE_UNAUTHORIZED = 4003

/** WebSocket close code for a frame that is not part of this grammar. */
export const CLOSE_PROTOCOL_ERROR = 1002
