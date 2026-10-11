// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { LIMITS } from './limits.js'
import { MessageType } from './message.js'

/** Declare the whole bidirectional control surface; none is a legacy type. */
export const CONTROL_MESSAGE_TYPES: readonly MessageType[] = Object.freeze([
  MessageType.NodeControl,
  MessageType.NodeControlResult,
  MessageType.HubSubscribe,
  MessageType.HubCall,
  MessageType.HubCallResult,
])

export interface NodeControlPayload {
  readonly op: string
  readonly args: Record<string, unknown>
  readonly actor: string
}

export type ControlOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string }

export interface HubSubscribePayload {
  readonly subscribe: true
}

export interface HubCallPayload {
  readonly callId: string
  readonly op: string
  readonly args: Record<string, unknown>
}

export type HubCallResultPayload = ControlOutcome & { readonly callId: string }

const OP_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/
const UUID_PATTERN =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

export function isControlOp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= LIMITS.maxControlOpLength &&
    OP_PATTERN.test(value)
  )
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value)
  return (
    actual.length === expected.length &&
    expected.every(key => actual.includes(key))
  )
}

export function isNodeControlPayload(
  value: unknown,
): value is NodeControlPayload {
  return (
    object(value) &&
    keys(value, ['op', 'args', 'actor']) &&
    isControlOp(value.op) &&
    object(value.args) &&
    typeof value.actor === 'string' &&
    value.actor.length <= LIMITS.maxControlActorLength
  )
}

function outcome(
  value: Record<string, unknown>,
  extra: readonly string[],
): boolean {
  return value.ok === true
    ? keys(value, [...extra, 'ok', 'value'])
    : value.ok === false &&
        keys(value, [...extra, 'ok', 'code', 'message']) &&
        typeof value.code === 'string' &&
        typeof value.message === 'string'
}

export function isNodeControlResultPayload(
  value: unknown,
): value is ControlOutcome {
  return object(value) && outcome(value, [])
}

export function isHubSubscribePayload(
  value: unknown,
): value is HubSubscribePayload {
  return object(value) && keys(value, ['subscribe']) && value.subscribe === true
}

export function isHubCallPayload(value: unknown): value is HubCallPayload {
  return (
    object(value) &&
    keys(value, ['callId', 'op', 'args']) &&
    typeof value.callId === 'string' &&
    UUID_PATTERN.test(value.callId) &&
    isControlOp(value.op) &&
    object(value.args)
  )
}

export function isHubCallResultPayload(
  value: unknown,
): value is HubCallResultPayload {
  return (
    object(value) &&
    typeof value.callId === 'string' &&
    UUID_PATTERN.test(value.callId) &&
    outcome(value, ['callId'])
  )
}
