// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The three permission levels, applied to inbound messages (charter C-5).
 *
 * ## What a level is, and what it is not
 *
 * The level a message carries is a **ceiling** on what that message may cause
 * this node to do. It is never added to what the local agent already has —
 * rule S-3, and the reason it can be stated so flatly is that there is no code
 * path from here into the base's permission state at all. `authorization.test.ts`
 * asserts that as a scan rather than as a promise, because "we did not call
 * that API" is exactly the sort of claim that quietly stops being true.
 *
 * ## Why unsigned traffic is admitted by the default policy
 *
 * An unsigned message is `read`, and {@link OPEN_POLICY} — what the M0 wiring
 * uses — requires no more than that. This is a deliberate, bounded choice, not
 * an oversight:
 *
 * - the mechanism is *not* optional: any token that **is** presented is fully
 *   verified, a forged one is refused, `user-confirmed` from a remote issuer is
 *   refused by S-1 whatever it is signed with, and no message can raise a
 *   level;
 * - what is optional in M0 is *requiring* a token, and it has to be, because
 *   M0 has no key distribution: `AgentRecord.publicKey` exists and is
 *   validated, but nothing publishes it yet. Demanding signatures before there
 *   is a way to learn keys would not make the network safer, it would make it
 *   silent — and AC-2's accepted evidence runs on unsigned envelopes.
 *
 * {@link SIGNED_TASK_POLICY} is the enforcing counterpart, exercised by this
 * package's suite and by the AC-3/P4.3 demo, and it is what M1 switches the
 * default to once mTLS brings key distribution with it (charter N-3).
 */

import {
  CapabilityLevel,
  MessageType,
  levelAtLeast,
  type QianmoMessage,
} from '@qianmo/protocol'

/** Decides what a message must present before this node acts on it. */
export interface CapabilityPolicy {
  requiredLevel(message: QianmoMessage): CapabilityLevel
}

/** Build a policy from a per-type table; unlisted types require `read`. */
export function capabilityPolicy(
  levels: Partial<Record<MessageType, CapabilityLevel>>,
): CapabilityPolicy {
  return {
    requiredLevel(message: QianmoMessage): CapabilityLevel {
      return levels[message.type] ?? CapabilityLevel.Read
    },
  }
}

/**
 * Everything may arrive unsigned. The M0 default — see the module header for
 * why, and for what remains enforced under it.
 */
export const OPEN_POLICY: CapabilityPolicy = capabilityPolicy({})

/**
 * Work has to be authorized: a `task.request` or a `wake` opens a turn that can
 * change the workspace, so both need `write-limited`. Replies stay at `read` —
 * an answer to a task this node itself asked for authorizes nothing.
 */
export const SIGNED_TASK_POLICY: CapabilityPolicy = capabilityPolicy({
  [MessageType.TaskRequest]: CapabilityLevel.WriteLimited,
  [MessageType.Wake]: CapabilityLevel.WriteLimited,
})

/** True when `level` clears what `policy` demands of `message`. */
export function satisfies(
  policy: CapabilityPolicy,
  message: QianmoMessage,
  level: CapabilityLevel,
): boolean {
  return levelAtLeast(level, policy.requiredLevel(message))
}
