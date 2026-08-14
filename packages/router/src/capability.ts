// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The port through which authorization reaches the inbound gate.
 *
 * The routing layer decides *when* a message is authorized — protocol.md
 * §10.1's rule S-2 fixes that: after the envelope is structurally sound and
 * **before anything with a cost**. It does not decide *how*: that needs keys, a
 * signature scheme and a replay store, all of which live in
 * `@qianmo/capability`.
 *
 * Keeping the port here and the implementation there means this package still
 * imports nothing but `@qianmo/protocol`, and a node that has no capability
 * story yet still gets loop detection and rate limiting rather than nothing.
 */

import type {
  CapabilityLevel,
  ProtocolErrorCode,
  QianmoMessage,
} from '@qianmo/protocol'

/** What a gate concluded about one message. */
export type CapabilityDecision =
  | {
      readonly ok: true
      /**
       * The level this message carries — a **ceiling** on what it may cause,
       * never a grant added to what the local agent already has (rule S-3).
       */
      readonly level: CapabilityLevel
      /** Issuing node, when a token was presented. */
      readonly issuer?: string
    }
  | {
      readonly ok: false
      /** `E_CAP_INVALID` or `E_CAP_INSUFFICIENT` (protocol.md §11). */
      readonly code: ProtocolErrorCode
      readonly reason: string
    }

/** Verifies the capability a message presents, if any. */
export interface CapabilityGate {
  check(message: QianmoMessage, now: number): CapabilityDecision
}
