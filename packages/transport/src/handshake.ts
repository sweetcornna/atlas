// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isValidSegment } from '@qianmo/protocol'
import {
  signBytes,
  verifyBytes,
  type NodeKeyPair,
  type PublicKeyDirectory,
} from '@qianmo/capability'
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
 *
 * ## The replacement, and why both live here at once
 *
 * P12.3 landed the successor described above: an Ed25519 signature by the
 * dialer's own node key, over the same tuple the MAC covers
 * (key-distribution.md §7.1), plus a signature *back* from the listener
 * (§7.1.1) — because "the peer could verify me" stopped implying "the peer
 * holds the secret too" the moment the proof became asymmetric.
 *
 * The two coexist inside frame version 1 rather than one replacing the other,
 * and that is forced rather than chosen: `frames.ts` compares `v` for strict
 * equality, so a version bump produces two generations that cannot talk at
 * all. Migration therefore rides on an optional field, and this module's job
 * is to decide which proof a given auth frame is offering. See §8.2 for the
 * three phases — this package implements the first two; only `required` on
 * {@link ListenerIdentity} moves a deployment to the third.
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

/** Stable logical connection id generated once per client instance. */
export function newChannelId(): string {
  return randomBytes(16).toString('hex')
}

/** True when a logical connection id has the generated wire shape. */
export function isChannelId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
}

/**
 * `HMAC-SHA256(psk, [frameVersion, serverNonce, clientNonce, node, channelId])`, hex.
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
  channelId: string,
): string {
  return createHmac('sha256', psk)
    .update(
      JSON.stringify([
        FRAME_VERSION,
        serverNonce,
        clientNonce,
        node,
        channelId,
      ]),
    )
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
  /** The logical channel id is malformed. */
  BadChannel = 'bad_channel',
  /** The echoed nonce is not the one this connection issued. */
  NonceMismatch = 'nonce_mismatch',
  /** The MAC does not match — wrong key, or a forged frame. */
  BadMac = 'bad_mac',
  /**
   * A signature was required and the dialer offered none (§8.2 phase ③).
   *
   * The three signature rejections below and {@link HandshakeRejection.BadMac}
   * are **one path on the wire**: every one of them closes with
   * {@link CLOSE_UNAUTHORIZED} and the same reason string, so a dialer cannot
   * learn from the refusal whether this listener wanted a signature, has never
   * heard of it, or simply did not recognise the one it got. The distinction
   * exists only in the local audit record, which is where an operator needs it
   * — "the directory has no key for you" and "your signature is wrong" call
   * for opposite fixes.
   */
  SignatureRequired = 'signature_required',
  /** No published key for the node the dialer claims to be. */
  UnknownSigner = 'unknown_signer',
  /** A signature was offered and it does not verify. */
  BadSignature = 'bad_signature',
}

/** Outcome of {@link verifyAuth}. */
export type HandshakeResult =
  | { readonly ok: true; readonly node: string; readonly channelId: string }
  | { readonly ok: false; readonly rejection: HandshakeRejection }

/** What {@link verifyAuth} needs out of an auth frame. */
export interface AuthAttempt {
  readonly node: string
  readonly nonce: string
  readonly clientNonce: string
  readonly channelId: string
  readonly mac: string
  /** Present when the dialer signed; see {@link verifyAuthAttempt}. */
  readonly sig?: string
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
  if (!isChannelId(attempt.channelId)) {
    return { ok: false, rejection: HandshakeRejection.BadChannel }
  }
  if (attempt.nonce !== serverNonce) {
    return { ok: false, rejection: HandshakeRejection.NonceMismatch }
  }
  const expected = computeMac(
    psk,
    serverNonce,
    attempt.clientNonce,
    attempt.node,
    attempt.channelId,
  )
  if (!macEquals(expected, attempt.mac)) {
    return { ok: false, rejection: HandshakeRejection.BadMac }
  }
  return { ok: true, node: attempt.node, channelId: attempt.channelId }
}

/**
 * Domain-separation prefix for every handshake signature (§4.4, §7.1).
 *
 * Mandatory rather than decorative: the node's Ed25519 key also signs
 * capability tokens, and a signature is only ever a claim about *some* bytes.
 * Without a prefix that only this handshake produces, a signature harvested
 * from one of those faces could be replayed onto the other whenever the byte
 * strings happened to line up.
 */
export const HANDSHAKE_SIGNATURE_DOMAIN = 'qianmo-handshake-v1'

function handshakeMessage(fields: readonly (string | number)[]): string {
  return `${HANDSHAKE_SIGNATURE_DOMAIN}\n${JSON.stringify(fields)}`
}

/**
 * The bytes a dialer signs: the very tuple {@link computeMac} covers, behind
 * the domain prefix (§7.1).
 *
 * Reusing the tuple rather than inventing a second one keeps the two proofs
 * interchangeable — a listener checking either is checking the same five
 * facts — and inherits the reason the tuple is a `JSON.stringify`d array in
 * the first place: a node name containing a separator cannot be split across
 * two fields to forge a different tuple.
 */
export function authSigningInput(
  serverNonce: string,
  clientNonce: string,
  node: string,
  channelId: string,
): string {
  return handshakeMessage([
    FRAME_VERSION,
    serverNonce,
    clientNonce,
    node,
    channelId,
  ])
}

/**
 * The bytes a listener signs: the same tuple plus **its own** node segment
 * (§7.1.1).
 *
 * The sixth field is what makes the two directions un-confusable. A dialer's
 * signature covers a five-element array and a listener's covers a six-element
 * one, so neither can ever be replayed as the other — no matter what the node
 * segments are — and the listener's own name is inside what it signed, which
 * is precisely the claim the dialer wants checked ("you are the node I meant
 * to reach"), not merely "somebody with a key was here".
 */
export function readySigningInput(
  serverNonce: string,
  clientNonce: string,
  node: string,
  channelId: string,
  listenerNode: string,
): string {
  return handshakeMessage([
    FRAME_VERSION,
    serverNonce,
    clientNonce,
    node,
    channelId,
    listenerNode,
  ])
}

/**
 * Ed25519 material and the peer directory one side of a handshake needs.
 *
 * `directory` is `@qianmo/capability`'s {@link PublicKeyDirectory}, the same
 * interface the inbound capability gate reads — one node, one answer to "what
 * key does that peer publish", whether the question is asked about a token or
 * about a handshake. `publicKeyOf` is synchronous by that interface's
 * contract, and this is a second reason for it: the lookup happens inside the
 * socket's message handler, before the dialer has proven anything.
 */
export interface HandshakeIdentity {
  /** This node's own key pair. Only the public half ever leaves the process. */
  readonly keys: NodeKeyPair
  readonly directory: PublicKeyDirectory
  /**
   * Refuse a peer that offers no signature (§8.2 phase ③).
   *
   * Left off during phases ① and ②, which is what makes a signing node and a
   * pre-shared-key node interoperate. Turning it on is the whole of "PSK is
   * retired here" — there is no other switch.
   */
  readonly required?: boolean
}

/** A listener additionally announces the node its own signature is made under. */
export interface ListenerIdentity extends HandshakeIdentity {
  /** This listener's own node segment, sent on the ready frame. */
  readonly node: string
}

/**
 * Check one auth attempt, taking whichever proof it offered.
 *
 * The order is the same one {@link verifyAuth} keeps and for the same reason:
 * the cheap structural checks first, because they leak nothing an attacker
 * does not already know, and **nothing is consumed or bound before the proof
 * verifies** — the caller does not learn a channel id it may act on until
 * this returns `ok`.
 *
 * Which proof is taken is decided by the listener's configuration first and
 * the frame second:
 *
 * - no `signing` at all ⇒ the MAC, exactly as before this existed. A dialer's
 *   `sig` is not merely unchecked here, it is *unread* — a listener that was
 *   never given a directory has no way to check one, and pretending otherwise
 *   would be the worst of the three outcomes;
 * - `signing` and a `sig` on the frame ⇒ the signature, and the MAC is not
 *   consulted at all;
 * - `signing` without a `sig` ⇒ the MAC, unless `required`, which refuses.
 */
export function verifyAuthAttempt(
  psk: string,
  signing: HandshakeIdentity | undefined,
  serverNonce: string,
  attempt: AuthAttempt,
): HandshakeResult {
  if (!isValidSegment(attempt.node)) {
    return { ok: false, rejection: HandshakeRejection.BadNode }
  }
  if (!isChannelId(attempt.channelId)) {
    return { ok: false, rejection: HandshakeRejection.BadChannel }
  }
  if (attempt.nonce !== serverNonce) {
    return { ok: false, rejection: HandshakeRejection.NonceMismatch }
  }
  if (signing !== undefined && attempt.sig !== undefined) {
    const publicKey = signing.directory.publicKeyOf(attempt.node)
    if (publicKey === null) {
      return { ok: false, rejection: HandshakeRejection.UnknownSigner }
    }
    const signed = authSigningInput(
      serverNonce,
      attempt.clientNonce,
      attempt.node,
      attempt.channelId,
    )
    if (!verifyBytes(publicKey, signed, attempt.sig)) {
      return { ok: false, rejection: HandshakeRejection.BadSignature }
    }
    return { ok: true, node: attempt.node, channelId: attempt.channelId }
  }
  if (signing?.required === true) {
    return { ok: false, rejection: HandshakeRejection.SignatureRequired }
  }
  return verifyAuth(psk, serverNonce, attempt)
}

/** The two fields a listener adds to its ready frame when it signs (§7.1.1). */
export function signReady(
  signing: ListenerIdentity,
  serverNonce: string,
  clientNonce: string,
  node: string,
  channelId: string,
): { readonly node: string; readonly sig: string } {
  return {
    node: signing.node,
    sig: signBytes(
      signing.keys,
      readySigningInput(
        serverNonce,
        clientNonce,
        node,
        channelId,
        signing.node,
      ),
    ),
  }
}

/** Why a dialer refused a ready frame. Stable strings — they reach audit records. */
export enum ReadyRejection {
  /** The listener did not sign, and this dialer requires it (§8.2 phase ③). */
  Unsigned = 'ready_unsigned',
  /** Signed, but by a node other than the one this dialer set out to reach. */
  WrongNode = 'ready_wrong_node',
  /** No published key for that node — nothing to check the signature against. */
  UnknownSigner = 'ready_unknown_signer',
  /** A signature was offered and it does not verify. */
  BadSignature = 'ready_bad_signature',
}

export type ReadyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: ReadyRejection }

/** The tuple both halves of the handshake signed, as the dialer remembers it. */
export interface HandshakeTuple {
  readonly serverNonce: string
  readonly clientNonce: string
  readonly node: string
  readonly channelId: string
}

/**
 * Check the listener's half of the handshake (§7.1.1).
 *
 * `peerNode` is the node the dialer *meant* to reach, and looking the key up
 * under that name rather than under the name on the frame is the whole point:
 * it is what turns a tampered `AgentRecord.endpoint` from a successful
 * redirect into a failed connection (§11 T-B′). A listener that answers with
 * a different name than the dialer asked for is refused before any signature
 * is even checked — the name is the claim being tested.
 *
 * An unsigned ready is accepted unless `required`, which is the coexistence
 * rule again: during §8.2 phase ① the peer on the other end may be a build
 * that has never heard of this field.
 */
export function verifyReady(
  peerNode: string,
  signing: HandshakeIdentity,
  tuple: HandshakeTuple,
  frame: { readonly node?: string; readonly sig?: string },
): ReadyResult {
  if (frame.sig === undefined || frame.node === undefined) {
    return signing.required === true
      ? { ok: false, rejection: ReadyRejection.Unsigned }
      : { ok: true }
  }
  if (frame.node !== peerNode) {
    return { ok: false, rejection: ReadyRejection.WrongNode }
  }
  const publicKey = signing.directory.publicKeyOf(peerNode)
  if (publicKey === null) {
    return { ok: false, rejection: ReadyRejection.UnknownSigner }
  }
  const signed = readySigningInput(
    tuple.serverNonce,
    tuple.clientNonce,
    tuple.node,
    tuple.channelId,
    frame.node,
  )
  return verifyBytes(publicKey, signed, frame.sig)
    ? { ok: true }
    : { ok: false, rejection: ReadyRejection.BadSignature }
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
