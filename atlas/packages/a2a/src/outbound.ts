// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import { AuditSource, type AuditInput } from '@qianmo/audit'
import {
  assertValidMessage,
  createTaskResult,
  isDeliveryExpired,
  MessageType,
  newId,
  ProtocolErrorCode,
  taskExpiresAt,
  withHop,
  type QianmoMessage,
} from '@qianmo/protocol'
import { LoopGuard, LoopVerdict } from '@qianmo/router'
import { requestPeer, peerUrl } from './http.js'
import { A2aTaskStore, type TaskMapping } from './store.js'
import { type A2aPeer, object, terminal } from './types.js'

export interface A2aOutboundOptions {
  store: A2aTaskStore
  node: string
  identity: string
  peers: readonly A2aPeer[]
  audit(input: AuditInput): void
  pollMs?: number
}
/** Authenticated internal callers choose a configured peer name, never an arbitrary URL. */
export class A2aOutbound {
  readonly #options: A2aOutboundOptions
  readonly #loops = new LoopGuard()
  readonly #pending = new Map<string, Promise<QianmoMessage>>()
  constructor(options: A2aOutboundOptions) {
    if (
      new Set(options.peers.map(peer => peer.id)).size !== options.peers.length
    )
      throw new Error('duplicate peer id')
    for (const peer of options.peers) peerUrl(peer)
    this.#options = options
  }
  send(peerId: string, request: QianmoMessage): Promise<QianmoMessage> {
    assertValidMessage(request, { now: Date.now() })
    if (request.type !== MessageType.TaskRequest || isDeliveryExpired(request))
      throw new Error('only unexpired task.request can cross A2A boundary')
    const peer = this.#options.peers.find(candidate => candidate.id === peerId)
    if (!peer) throw new Error('peer is not allowed')
    const key = JSON.stringify(['outbound', request.taskId])
    const digest = createHash('sha256')
      .update(
        JSON.stringify([peerId, request.from, request.to, request.payload]),
      )
      .digest('hex')
    const prior = this.#options.store.duplicate(key)
    if (prior) {
      if (prior.digest !== digest)
        throw new Error('task revisited boundary with different request')
      const pending = this.#pending.get(key)
      if (pending) return pending
      return Promise.resolve(this.#result(request, prior))
    }
    const message = withHop(request, this.#options.node)
    if (this.#loops.admit(message, Date.now()) !== LoopVerdict.Fresh)
      throw new Error('boundary loop refused')
    const id = newId()
    const mapping: TaskMapping = {
      id,
      owner: request.from,
      direction: 'outbound',
      peer: peerId,
      internalId: request.taskId,
      dedupKey: key,
      digest,
      task: {
        id,
        contextId: request.contextId ?? newId(),
        status: {
          state: 'TASK_STATE_WORKING',
          timestamp: new Date().toISOString(),
        },
      },
    }
    this.#options.store.reserve(mapping)
    const pending = this.#execute(peer, message, mapping).finally(() =>
      this.#pending.delete(key),
    )
    this.#pending.set(key, pending)
    return pending
  }
  #result(request: QianmoMessage, mapping: TaskMapping): QianmoMessage {
    if (mapping.task.status.state === 'TASK_STATE_COMPLETED')
      return createTaskResult(request, request.to, {
        outcome: 'completed',
        content:
          mapping.task.artifacts
            ?.flatMap(artifact => artifact.parts.map(part => part.text))
            .join('\n') ?? '',
      })
    return createTaskResult(request, request.to, {
      outcome: 'failed',
      code: ProtocolErrorCode.E_TASK_FAILED,
      reason:
        'A2A task failed, is unsupported, or has an uncertain execution outcome; inspect its persisted mapping',
    })
  }
  async #execute(
    peer: A2aPeer,
    message: QianmoMessage,
    mapping: TaskMapping,
  ): Promise<QianmoMessage> {
    const audit = (kind: string, outcome: 'ok' | 'refused') =>
      this.#options.audit({
        at: Date.now(),
        source: AuditSource.A2a,
        kind,
        node: this.#options.node,
        peer: peer.id,
        taskId: message.taskId,
        traceId: message.traceId,
        msgId: message.msgId,
        outcome,
        detail: {
          externalTaskId: mapping.externalId ?? '',
          direction: 'outbound',
          hops: message.hops.length,
        },
      })
    const deadline = Math.min(taskExpiresAt(message), Date.now() + 300_000)
    const remaining = () => {
      const ms = deadline - Date.now()
      if (ms <= 0) throw new Error('task expired')
      return Math.min(ms, 30_000)
    }
    try {
      audit('a2a.outbound', 'ok')
      const prompt =
        object(message.payload) && typeof message.payload.prompt === 'string'
          ? message.payload.prompt
          : JSON.stringify(message.payload)
      const response = await requestPeer(
        peer,
        '/message:send',
        {
          ...(peer.tenant ? { tenant: peer.tenant } : {}),
          message: {
            messageId: message.msgId,
            role: 'ROLE_USER',
            parts: [{ text: prompt }],
            contextId: mapping.task.contextId,
            metadata: {
              qianmoBoundary: {
                gateway: this.#options.identity,
                hops: message.hops,
                internalTaskId: message.taskId,
              },
            },
          },
          configuration: {
            returnImmediately: true,
            acceptedOutputModes: ['text/plain'],
          },
        },
        remaining(),
      )
      let task: unknown = object(response) ? response.task : undefined
      if (
        !object(task) ||
        typeof task.id !== 'string' ||
        !task.id ||
        task.id.length > 256
      )
        throw new Error('peer did not return a task')
      mapping.externalId = task.id
      this.#options.store.save(mapping)
      for (;;) {
        if (
          !object(task) ||
          task.id !== mapping.externalId ||
          !object(task.status) ||
          typeof task.status.state !== 'string'
        )
          throw new Error('invalid task response')
        const state = task.status.state
        if (terminal(state)) {
          if (state !== 'TASK_STATE_COMPLETED')
            throw new Error('remote task failed')
          if (
            !Array.isArray(task.artifacts) ||
            task.artifacts.some(
              artifact =>
                !object(artifact) ||
                !Array.isArray(artifact.parts) ||
                artifact.parts.some(
                  part =>
                    !object(part) ||
                    typeof part.text !== 'string' ||
                    ['raw', 'url', 'data'].some(key => key in part),
                ),
            )
          )
            throw new Error('peer result is not a text artifact')
          mapping.task.artifacts = task.artifacts.map(artifact => ({
            artifactId: newId(),
            parts: (artifact as { parts: { text: string }[] }).parts.map(
              part => ({ text: part.text }),
            ),
          }))
          mapping.task.status = {
            state: 'TASK_STATE_COMPLETED',
            timestamp: new Date().toISOString(),
          }
          this.#options.store.save(mapping)
          audit('a2a.outbound.completed', 'ok')
          return this.#result(message, mapping)
        }
        if (!['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(state))
          throw new Error(
            'peer requires an unsupported interactive continuation',
          )
        await new Promise(resolve =>
          setTimeout(
            resolve,
            Math.min(this.#options.pollMs ?? 250, remaining()),
          ),
        )
        task = await requestPeer(
          peer,
          `/tasks/${encodeURIComponent(mapping.externalId)}${peer.tenant ? `?tenant=${encodeURIComponent(peer.tenant)}` : ''}`,
          undefined,
          remaining(),
        )
      }
    } catch {
      mapping.task.status = {
        state: 'TASK_STATE_FAILED',
        timestamp: new Date().toISOString(),
      }
      this.#options.store.save(mapping)
      audit('a2a.outbound.failed', 'refused')
      return this.#result(message, mapping)
    }
  }
}
