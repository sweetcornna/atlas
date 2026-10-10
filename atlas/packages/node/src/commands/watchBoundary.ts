// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TenantPort, UsageScope } from '@qianmo/console'
import {
  assertAddress,
  MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import { NodeRouter } from '@qianmo/router'
import type { ScheduledJob } from '@qianmo/scheduler'

/** Fixed job targets, fresh tenant policy, and the actual signed connection identity. */
export class WatchBoundary {
  readonly #router: NodeRouter
  constructor(
    readonly from: string,
    readonly jobs: readonly ScheduledJob[],
    readonly tenancy?: TenantPort,
  ) {
    this.#router = new NodeRouter({ node: assertAddress(from).node })
  }
  allows(job: ScheduledJob): boolean {
    return this.scope(job) !== undefined
  }
  scope(job: ScheduledJob): UsageScope | undefined {
    if (!this.jobs.some(row => row.id === job.id && row.target === job.target))
      return undefined
    if (!this.tenancy) return { kind: 'job', subject: job.id }
    try {
      const node = assertAddress(job.target).node
      const config = this.tenancy.read().config
      const assignment = config.jobs.find(row => row.jobId === job.id)
      return assignment?.nodeId === node &&
        config.nodes.some(
          row => row.nodeId === node && row.tenant === assignment.tenant,
        )
        ? { kind: 'job', subject: job.id, tenant: assignment!.tenant }
        : undefined
    } catch {
      return undefined
    }
  }
  outbound(message: QianmoMessage): QianmoMessage {
    const outcome = this.#router.outbound(message)
    if (!outcome.ok) throw new Error(`watch router: ${outcome.code}`)
    return outcome.message
  }
  inbound(
    message: QianmoMessage,
    connectionTarget: string,
    authenticatedPeer: string | null,
  ): boolean {
    // Router precedes application effects, including audit notifications/stdout.
    if (!this.#router.inbound(message).ok) return false
    if (
      ![MessageType.Notify, MessageType.TaskResult, MessageType.Error].includes(
        message.type,
      )
    )
      return false
    if (message.to !== this.from) return false
    const job = this.jobs.find(
      row => row.id === message.contextId && row.target === message.from,
    )
    if (!job || !this.allows(job)) return false
    const node = assertAddress(job.target).node
    if (node !== connectionTarget) return false
    if (authenticatedPeer !== null && authenticatedPeer !== node) return false
    // PSK labels are display names, never M2 identities.
    return !this.tenancy || authenticatedPeer === node
  }
}
