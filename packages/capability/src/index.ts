// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/capability` — authorization for the Qianmo network (P4.3).
 *
 * Four pieces, and the reason they are one package is that each is useless
 * without the others:
 *
 * 1. **keys** (`keys.ts`) — one Ed25519 pair per node, in the encoding
 *    protocol.md §10.1 fixes once for everybody;
 * 2. **tokens** (`token.ts`) — issue and verify, with the binding checks
 *    (`aud` / `sub` / `taskId`), the clock, and rule S-1;
 * 3. **replay** (`nonce.ts`) — because a signature says who wrote a token, not
 *    how many times it may be used;
 * 4. **levels** (`policy.ts`, `gate.ts`) — the three-rung ladder of charter
 *    C-5, applied as a ceiling on what an inbound message may cause.
 *
 * What is *not* here: any way to raise a local agent's permissions. That
 * absence is rule S-3, and `test/authorization-invariants.test.ts` keeps it an
 * absence rather than a habit.
 *
 * Charter N-3 (no production crypto in M0) is untouched by this: it bans a PKI
 * — certificate authorities, issuance chains, rotation, escrow — and a node
 * signing its own capability tokens with its own key is none of those. §3.3 C-5
 * draws that line explicitly.
 */

export {
  NodeCapabilities,
  type NodeCapabilitiesOptions,
  type ShadowRefusal,
  type ShadowRefusalSink,
} from './gate.js'

export {
  generateNodeKeyPair,
  isNodeKeyPair,
  signBytes,
  verifyBytes,
  type NodeKeyPair,
} from './keys.js'

export {
  DEFAULT_NONCE_CAPACITY,
  NonceStore,
  type NonceStoreOptions,
} from './nonce.js'

export {
  OPEN_POLICY,
  SIGNED_TASK_POLICY,
  capabilityPolicy,
  satisfies,
  type CapabilityPolicy,
} from './policy.js'

export {
  StaticPublicKeyDirectory,
  issueCapability,
  verifyCapability,
  type IssueInput,
  type PublicKeyDirectory,
  type VerifyContext,
  type VerifyResult,
} from './token.js'
