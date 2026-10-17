// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  isValidSegment,
  LIMITS,
  MessageType,
  parseAddress,
  type QianmoMessage,
} from '@qianmo/protocol'
import { canonicalJson } from './authz.js'
import { signBytes, verifyBytes, type NodeKeyPair } from './keys.js'

/** Only verified console principals can own durable memory. */
export function isMemoryOwner(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value === 'legacy:admin' || /^u:[0-9a-f]{16}$/.test(value))
  )
}

function signingInput(message: QianmoMessage): string {
  const { ownerProof: _proof, ...payload } = message.payload as Record<
    string,
    unknown
  >
  // Relay hops and trace parent can change; the original request cannot.
  return `qianmo.task-owner.v1\n${canonicalJson({
    from: message.from,
    to: message.to,
    type: message.type,
    msgId: message.msgId,
    taskId: message.taskId,
    contextId: message.contextId,
    createdAt: message.createdAt,
    deliverTtlMs: message.deliverTtlMs,
    taskTtlMs: message.taskTtlMs,
    payload,
  })}`
}

export function signTaskOwner(
  message: QianmoMessage,
  keys: NodeKeyPair,
): QianmoMessage {
  if (
    message.type !== MessageType.TaskRequest ||
    !message.payload ||
    typeof message.payload !== 'object' ||
    !isMemoryOwner((message.payload as Record<string, unknown>).onBehalfOf)
  )
    throw new Error('task owner requires a console principal')
  return {
    ...message,
    payload: {
      ...message.payload,
      ownerProof: signBytes(keys, signingInput(message)),
    },
  }
}

/** Never infer a person from a capability issuer or a mailbox's provenance. */
export function verifiedTaskOwner(
  message: QianmoMessage,
  controllers: ReadonlyMap<string, string>,
): string | undefined {
  if (
    message.type !== MessageType.TaskRequest ||
    !message.payload ||
    typeof message.payload !== 'object' ||
    Array.isArray(message.payload)
  )
    return undefined
  const payload = message.payload as Record<string, unknown>
  const node = parseAddress(message.from)?.node
  const key = node === undefined ? undefined : controllers.get(node)
  if (
    !key ||
    !isMemoryOwner(payload.onBehalfOf) ||
    typeof payload.ownerProof !== 'string'
  )
    return undefined
  return verifyBytes(key, signingInput(message), payload.ownerProof)
    ? payload.onBehalfOf
    : undefined
}

/**
 * The request is a hub's background sub-agent turn (P29): `background: true`
 * in a payload whose owner proof verifies against a controller key.
 *
 * The proof covers the whole payload, so the marker is the hub's word and no
 * relay can add or strip it. An unsigned or unverifiable marker is ignored,
 * which is also how a node older than the field reads every request.
 */
export function verifiedBackground(
  message: QianmoMessage,
  controllers: ReadonlyMap<string, string>,
): boolean {
  return (
    verifiedTaskOwner(message, controllers) !== undefined &&
    (message.payload as Record<string, unknown>).background === true
  )
}

/**
 * One asking turn of a synchronous agent-to-agent question (P36.6): the node
 * it runs on and the `taskId` of the `task.request` that started it.
 */
export interface AskChainLink {
  readonly node: string
  readonly taskId: string
}

const CHAIN_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/**
 * The call chain of a hub's ask turn (P36.6, `harness-backends.md` §6.2):
 * `chain: [{node, taskId}]` — the turns waiting on this one's answer,
 * outermost first — in a payload whose owner proof verifies against a
 * controller key, exactly as {@link verifiedBackground} reads its marker.
 *
 * Unsigned, unverifiable, empty, longer than `LIMITS.maxAskChain` or not made
 * of well-formed links: `undefined`, the same as no chain. A node then queues
 * the turn as it always has; nothing is concluded from a bad chain.
 */
export function verifiedChain(
  message: QianmoMessage,
  controllers: ReadonlyMap<string, string>,
): readonly AskChainLink[] | undefined {
  if (verifiedTaskOwner(message, controllers) === undefined) return undefined
  const chain = (message.payload as Record<string, unknown>).chain
  if (
    !Array.isArray(chain) ||
    chain.length === 0 ||
    chain.length > LIMITS.maxAskChain
  )
    return undefined
  const links: AskChainLink[] = []
  for (const link of chain as unknown[]) {
    if (!link || typeof link !== 'object' || Array.isArray(link))
      return undefined
    const { node, taskId, ...rest } = link as Record<string, unknown>
    if (
      Object.keys(rest).length > 0 ||
      !isValidSegment(node) ||
      typeof taskId !== 'string' ||
      !CHAIN_TASK_ID.test(taskId)
    )
      return undefined
    links.push({ node, taskId })
  }
  return links
}
