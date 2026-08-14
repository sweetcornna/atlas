// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The node's authorization face: one object the router can ask about a message.
 *
 * It answers exactly one question — "what level does this message carry, and is
 * that enough for what it is asking?" — and it answers it without touching
 * anything else. In particular it does not, and cannot, grant: the return value
 * is a ceiling the caller may respect, and there is no method here that changes
 * what the local agent is allowed to do (rule S-3).
 */

import {
  CapabilityLevel,
  ProtocolErrorCode,
  parseAddress,
  type QianmoMessage,
} from '@qianmo/protocol'
import type { CapabilityDecision, CapabilityGate } from '@qianmo/router'
import type { NodeKeyPair } from './keys.js'
import { NonceStore } from './nonce.js'
import { OPEN_POLICY, satisfies, type CapabilityPolicy } from './policy.js'
import {
  issueCapability,
  verifyCapability,
  type IssueInput,
  type PublicKeyDirectory,
} from './token.js'

export interface NodeCapabilitiesOptions {
  /** This node's segment: the only `aud` it will accept, and its `iss`. */
  readonly node: string
  readonly directory: PublicKeyDirectory
  /** Defaults to {@link OPEN_POLICY} — see `policy.ts` on why. */
  readonly policy?: CapabilityPolicy
  readonly nonces?: NonceStore
  /** Needed only to issue; verification never touches a private key. */
  readonly keys?: NodeKeyPair
}

/** Verifies presented capabilities and applies the node's level policy. */
export class NodeCapabilities implements CapabilityGate {
  readonly node: string
  readonly policy: CapabilityPolicy
  readonly nonces: NonceStore
  readonly #directory: PublicKeyDirectory
  readonly #keys: NodeKeyPair | undefined

  constructor(options: NodeCapabilitiesOptions) {
    this.node = options.node
    this.policy = options.policy ?? OPEN_POLICY
    this.nonces = options.nonces ?? new NonceStore()
    this.#directory = options.directory
    this.#keys = options.keys
  }

  /**
   * Classify one inbound message.
   *
   * An absent token is not an error: it is the `read` level, which is what an
   * unauthenticated peer has. Whether `read` is enough is the policy's call,
   * and the two questions are kept apart so that "you sent no token" and "your
   * token is not good enough" cannot collapse into one indistinguishable
   * rejection.
   */
  check(message: QianmoMessage, now: number): CapabilityDecision {
    if (message.cap === undefined) {
      return this.#applyPolicy(message, CapabilityLevel.Read, undefined)
    }
    const verified = verifyCapability(message.cap, {
      node: this.node,
      handler: message.to,
      taskId: message.taskId,
      now,
      directory: this.#directory,
      nonces: this.nonces,
    })
    if (!verified.ok) {
      return { ok: false, code: verified.code, reason: verified.reason }
    }
    return this.#applyPolicy(message, verified.claims.act, verified.claims.iss)
  }

  /**
   * Mint a token for a peer to present back at `input.aud`.
   *
   * `user-confirmed` is not special-cased here, and does not need to be: this
   * node signs it with its own key, so a token it issues can only ever be
   * accepted by a node that considers this node's `iss` to be itself — which is
   * the same statement rule S-1 makes from the verifying side.
   */
  issue(input: IssueInput): string {
    if (this.#keys === undefined) {
      throw new Error(
        `node ${this.node} has no signing key: capabilities can be verified but not issued`,
      )
    }
    return issueCapability(this.node, this.#keys, input)
  }

  #applyPolicy(
    message: QianmoMessage,
    level: CapabilityLevel,
    issuer: string | undefined,
  ): CapabilityDecision {
    if (satisfies(this.policy, message, level)) {
      return {
        ok: true,
        level,
        ...(issuer === undefined ? {} : { issuer }),
      }
    }
    const required = this.policy.requiredLevel(message)
    const sender = parseAddress(message.from)
    return {
      ok: false,
      code: ProtocolErrorCode.E_CAP_INSUFFICIENT,
      reason: `${message.type} from ${sender === null ? 'an unparseable sender' : sender.node} needs ${required}, presented ${level}`,
    }
  }
}
