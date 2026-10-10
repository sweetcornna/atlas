// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The supported subset uses canonical v1.0 ProtoJSON, not the 0.3 binding. */
export const A2A_VERSION = '1.0'
export const A2A_MEDIA_TYPE = 'application/a2a+json'
export const MAX_A2A_BYTES = 256 * 1024
export type TaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
export interface A2aTask {
  id: string
  contextId: string
  status: {
    state: TaskState
    timestamp: string
    message?: {
      messageId: string
      role: 'ROLE_AGENT'
      parts: { text: string }[]
    }
  }
  artifacts?: { artifactId: string; parts: { text: string }[] }[]
}
export interface AgentSkill {
  id: string
  name: string
  description: string
  tags: string[]
}
export interface Principal {
  /** Stable deployment identity; tokens may rotate without changing task ownership. */
  id: string
  token: string
  from: string
  targets: readonly string[]
}
export interface A2aPeer {
  id: string
  url: string
  /** Explicit addresses allowed for this host, checked on every connection. */
  addresses: readonly string[]
  token: string
  tenant?: string
  /** HTTP is allowed only for literal loopback development peers. */
  allowLoopbackHttp?: boolean
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export class A2aError extends Error {
  constructor(
    readonly reason: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export function failure(
  reason: string,
  status: number,
  message: string,
): Response {
  return Response.json(
    {
      error: {
        code: status,
        message,
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason,
            domain: 'a2a-protocol.org',
          },
        ],
      },
    },
    {
      status,
      headers: { 'Content-Type': A2A_MEDIA_TYPE, 'A2A-Version': A2A_VERSION },
    },
  )
}
export function json(value: unknown): Response {
  return Response.json(value, {
    headers: {
      'Content-Type': A2A_MEDIA_TYPE,
      'A2A-Version': A2A_VERSION,
      'Cache-Control': 'no-store',
    },
  })
}
export function terminal(state: string): boolean {
  return (
    state === 'TASK_STATE_COMPLETED' ||
    state === 'TASK_STATE_FAILED' ||
    state === 'TASK_STATE_REJECTED' ||
    state === 'TASK_STATE_CANCELED'
  )
}
