// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, timingSafeEqual } from 'node:crypto'
import { AuditSource, type AuditInput } from '@qianmo/audit'
import {
  assertAddress,
  createMessage,
  isTaskResultPayload,
  MessageType,
  newId,
  withHop,
  type QianmoMessage,
} from '@qianmo/protocol'
import { A2aTaskStore, type TaskMapping } from './store.js'
import {
  A2aError,
  A2A_VERSION,
  type AgentSkill,
  type Principal,
  failure,
  json,
  MAX_A2A_BYTES,
  object,
} from './types.js'

export interface A2aGatewayOptions {
  store: A2aTaskStore
  /** Stable gateway id, independent of the listener's URL. */
  identity: string
  node: string
  target: string
  publicUrl: string
  name: string
  skills: AgentSkill[]
  principals: readonly Principal[]
  /** The adapter must preserve identity, enforce signed capability policy and return a correlated terminal envelope. */
  dispatch(message: QianmoMessage, signal: AbortSignal): Promise<QianmoMessage>
  audit(input: AuditInput): void
  timeoutMs?: number
}
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')
const notFound = () =>
  new A2aError(
    'TASK_NOT_FOUND',
    404,
    'Task does not exist or is not accessible',
  )
const unsupported = () =>
  new A2aError(
    'UNSUPPORTED_OPERATION',
    400,
    'This gateway supports non-streaming single-turn text tasks; this operation is unsupported',
  )

async function readBody(request: Request): Promise<unknown> {
  if (!request.body)
    throw new A2aError('INVALID_ARGUMENT', 400, 'Request body required')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_A2A_BYTES)
        throw new A2aError(
          'INVALID_ARGUMENT',
          413,
          'Request exceeds size limit',
        )
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof A2aError) throw error
    throw new A2aError('INVALID_ARGUMENT', 400, 'Invalid JSON')
  }
}

export function createA2aGateway(options: A2aGatewayOptions): {
  fetch(request: Request): Promise<Response>
  drain(): Promise<void>
} {
  assertAddress(options.target, 'target')
  const publicUrl = new URL(options.publicUrl)
  if (
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.pathname !== '/' ||
    (publicUrl.protocol !== 'https:' &&
      !(
        publicUrl.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(publicUrl.hostname)
      ))
  )
    throw new Error(
      'publicUrl must be an HTTPS origin or literal loopback HTTP origin',
    )
  const ids = new Set<string>()
  const tokens = new Set<string>()
  for (const principal of options.principals) {
    assertAddress(principal.from, 'principal.from')
    // The transport authenticates a node, so the synthetic identity lives on it.
    if (!principal.from.startsWith(`qianmo://${options.node}/`))
      throw new Error('principal identity must belong to gateway node')
    if (
      !principal.id ||
      !principal.token ||
      ids.has(principal.id) ||
      tokens.has(principal.token)
    )
      throw new Error('principals require unique ids and tokens')
    ids.add(principal.id)
    tokens.add(principal.token)
  }
  if (!options.skills.length) throw new Error('at least one skill is required')
  const inFlight = new Map<string, Promise<void>>()
  const credentials = options.principals.map(principal => ({
    principal,
    hash: digest(`Bearer ${principal.token}`),
  }))
  const timeoutMs = options.timeoutMs ?? 300_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000)
    throw new Error('invalid gateway timeout')
  options.store.recover()
  const card = {
    name: options.name,
    description:
      'Qianmo v0 boundary: single-turn text tasks with durable task lookup. Cancellation, interactive continuation, streaming and push notifications are unsupported.',
    version: '1.0.0',
    supportedInterfaces: [
      {
        url: options.publicUrl,
        protocolBinding: 'HTTP+JSON',
        protocolVersion: A2A_VERSION,
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: options.skills,
  }
  function audit(
    kind: string,
    mapping: TaskMapping,
    message: QianmoMessage,
    outcome: 'ok' | 'refused' = 'ok',
  ) {
    options.audit({
      at: Date.now(),
      source: AuditSource.A2a,
      kind,
      taskId: message.taskId,
      msgId: message.msgId,
      traceId: message.traceId,
      node: options.node,
      peer: mapping.owner,
      outcome,
      detail: { externalTaskId: mapping.id, direction: 'inbound' },
    })
  }
  function start(mapping: TaskMapping, message: QianmoMessage): Promise<void> {
    const controller = new AbortController()
    const operation = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        mapping.task.status = {
          state: 'TASK_STATE_WORKING',
          timestamp: new Date().toISOString(),
        }
        options.store.save(mapping)
        const reply = await Promise.race([
          options.dispatch(message, controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new Error('deadline exceeded'))
            }, timeoutMs)
          }),
        ])
        if (
          reply.taskId !== message.taskId ||
          reply.from !== message.to ||
          reply.to !== message.from ||
          reply.type !== MessageType.TaskResult ||
          !isTaskResultPayload(reply.payload)
        )
          throw new Error('uncorrelated or invalid task result')
        if (reply.payload.outcome !== 'completed')
          throw new Error('internal task failed')
        if (Buffer.byteLength(reply.payload.content) > MAX_A2A_BYTES / 2)
          throw new Error('task output exceeds limit')
        mapping.task.status = {
          state: 'TASK_STATE_COMPLETED',
          timestamp: new Date().toISOString(),
        }
        mapping.task.artifacts = [
          { artifactId: newId(), parts: [{ text: reply.payload.content }] },
        ]
        options.store.save(mapping)
        audit('a2a.completed', mapping, reply)
      } catch {
        mapping.task.status = {
          state: 'TASK_STATE_FAILED',
          timestamp: new Date().toISOString(),
          message: {
            messageId: newId(),
            role: 'ROLE_AGENT',
            parts: [
              {
                text: 'Task failed, timed out, or returned an invalid result. See the gateway audit trail.',
              },
            ],
          },
        }
        options.store.save(mapping)
        audit('a2a.failed', mapping, message, 'refused')
      } finally {
        if (timer) clearTimeout(timer)
        inFlight.delete(mapping.id)
      }
    })()
    inFlight.set(mapping.id, operation)
    return operation
  }
  return {
    async drain() {
      await Promise.all(inFlight.values())
    },
    async fetch(request) {
      try {
        const url = new URL(request.url)
        const hash = Buffer.from(
          digest(request.headers.get('authorization') ?? ''),
        )
        const principal = credentials.find(entry =>
          timingSafeEqual(Buffer.from(entry.hash), hash),
        )?.principal
        if (!principal)
          return failure('UNAUTHENTICATED', 401, 'Authentication required')
        if (!principal.targets.includes(options.target)) throw notFound()
        if (
          url.pathname === '/.well-known/agent-card.json' &&
          request.method === 'GET'
        )
          return json(card)
        if (request.headers.get('a2a-version') !== A2A_VERSION)
          return failure(
            'VERSION_NOT_SUPPORTED',
            400,
            'A2A-Version: 1.0 is required',
          )
        if (request.method === 'GET' && url.pathname.startsWith('/tasks/')) {
          const id = decodeURIComponent(url.pathname.slice('/tasks/'.length))
          const mapping = options.store.get(id)
          if (
            !mapping ||
            mapping.owner !== principal.id ||
            mapping.direction !== 'inbound'
          )
            throw notFound()
          if (url.searchParams.get('tenant')) throw notFound()
          return json(mapping.task)
        }
        if (request.method !== 'POST' || url.pathname !== '/message:send')
          throw unsupported()
        if (
          !['application/json', 'application/a2a+json'].includes(
            (request.headers.get('content-type') ?? '').split(';')[0]!.trim(),
          )
        )
          throw new A2aError(
            'INVALID_ARGUMENT',
            415,
            'JSON Content-Type required',
          )
        const body = await readBody(request)
        if (!object(body) || !object(body.message))
          throw new A2aError('INVALID_ARGUMENT', 400, 'message is required')
        if (body.tenant) throw notFound()
        const message = body.message
        if (message.taskId !== undefined && typeof message.taskId !== 'string')
          throw new A2aError('INVALID_ARGUMENT', 400, 'Invalid taskId')
        if (typeof message.taskId === 'string' && message.taskId) {
          const prior = options.store.get(message.taskId)
          if (
            !prior ||
            prior.owner !== principal.id ||
            prior.direction !== 'inbound'
          )
            throw notFound()
          throw unsupported()
        }
        if (
          message.role !== 'ROLE_USER' ||
          typeof message.messageId !== 'string' ||
          message.messageId.length < 1 ||
          message.messageId.length > 256
        )
          throw new A2aError(
            'INVALID_ARGUMENT',
            400,
            'ROLE_USER and a bounded messageId are required',
          )
        if (
          message.contextId !== undefined &&
          (typeof message.contextId !== 'string' ||
            message.contextId.length < 1 ||
            message.contextId.length > 256)
        )
          throw new A2aError('INVALID_ARGUMENT', 400, 'Invalid contextId')
        if (
          !Array.isArray(message.parts) ||
          !message.parts.length ||
          message.parts.some(
            part =>
              !object(part) ||
              typeof part.text !== 'string' ||
              ['raw', 'url', 'data'].some(key => key in part),
          )
        )
          throw new A2aError(
            'CONTENT_TYPE_NOT_SUPPORTED',
            400,
            'Only text parts are supported',
          )
        // Reserved boundary ancestry is never allowed to come back as a fresh task.
        if (
          (object(message.metadata) && 'qianmoBoundary' in message.metadata) ||
          (object(body.metadata) && 'qianmoBoundary' in body.metadata)
        )
          throw new A2aError(
            'INVALID_ARGUMENT',
            400,
            'Boundary loop or unsupported forwarding metadata',
          )
        const configuration = body.configuration
        if (configuration !== undefined && !object(configuration))
          throw new A2aError('INVALID_ARGUMENT', 400, 'Invalid configuration')
        if (object(configuration) && configuration.pushNotificationConfig)
          throw new A2aError(
            'PUSH_NOTIFICATION_NOT_SUPPORTED',
            400,
            'Push notifications are unsupported',
          )
        if (
          object(configuration) &&
          configuration.acceptedOutputModes !== undefined &&
          (!Array.isArray(configuration.acceptedOutputModes) ||
            !configuration.acceptedOutputModes.includes('text/plain'))
        )
          throw new A2aError(
            'CONTENT_TYPE_NOT_SUPPORTED',
            400,
            'Only text/plain output is supported',
          )
        const text = message.parts
          .map(part => (part as { text: string }).text)
          .join('\n')
        const fingerprint = digest(
          JSON.stringify([text, message.contextId ?? null]),
        )
        const key = JSON.stringify(['inbound', principal.id, message.messageId])
        const prior = options.store.duplicate(key)
        if (prior) {
          if (prior.digest !== fingerprint)
            throw new A2aError(
              'INVALID_ARGUMENT',
              400,
              'messageId was reused with different content',
            )
          if (object(configuration) && configuration.returnImmediately === true)
            return json({ task: prior.task })
          await inFlight.get(prior.id)
          return json({ task: options.store.get(prior.id)!.task })
        }
        if (inFlight.size >= 64)
          throw new A2aError(
            'RESOURCE_EXHAUSTED',
            429,
            'Gateway concurrency limit reached',
          )
        const id = newId()
        const contextId =
          typeof message.contextId === 'string' ? message.contextId : newId()
        const envelope = withHop(
          createMessage({
            from: principal.from,
            to: options.target,
            type: MessageType.TaskRequest,
            payload: { prompt: text },
            contextId: digest(JSON.stringify([principal.id, contextId])),
            taskTtlMs: timeoutMs,
          }),
          options.node,
        )
        const mapping: TaskMapping = {
          id,
          owner: principal.id,
          direction: 'inbound',
          internalId: envelope.taskId,
          dedupKey: key,
          digest: fingerprint,
          task: {
            id,
            contextId,
            status: {
              state: 'TASK_STATE_SUBMITTED',
              timestamp: new Date().toISOString(),
            },
          },
        }
        options.store.reserve(mapping)
        audit('a2a.accepted', mapping, envelope)
        const operation = start(mapping, envelope)
        if (
          !(object(configuration) && configuration.returnImmediately === true)
        )
          await operation
        return json({ task: options.store.get(id)!.task })
      } catch (error) {
        if (error instanceof A2aError)
          return failure(error.reason, error.status, error.message)
        return failure('INTERNAL', 500, 'Gateway request failed')
      }
    },
  }
}
