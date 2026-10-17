// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  OmpTurnRouter,
  ResidentAgentSession,
  ResidentSessionConnection,
} from '@qianmo/resident'
import type { OmpRpcProcess, ResidentOmpPool } from '../residentOmp.js'
import type { ExternalRuntimeChannel } from './channel.js'
import type { ExternalRuntimePool } from './pool.js'

/**
 * One node, several runtimes: qianmopi sessions go to the omp pool, Claude
 * Code and Codex sessions to the external pool, by the agent that owns the
 * session. With no external agents this is the omp pool unchanged.
 *
 * Only the omp pool decides the generation's fate (`closed`, parking): an
 * external process that dies fails its own turn and is restarted on the next
 * one, without taking the qianmopi children down with it.
 */
export class ResidentRuntimePool
  implements ResidentSessionConnection, OmpTurnRouter
{
  readonly omp: ResidentOmpPool
  readonly external: ExternalRuntimePool | undefined
  readonly closed: Promise<void>

  constructor(omp: ResidentOmpPool, external?: ExternalRuntimePool) {
    this.omp = omp
    this.external = external
    this.closed = omp.closed
  }

  get alive(): boolean {
    return this.omp.alive && (this.external?.alive ?? true)
  }
  get parkedReason(): string | undefined {
    return this.omp.parkedReason
  }
  isStable(stableAfterMs: number): boolean {
    return (
      this.omp.isStable(stableAfterMs) ||
      (this.external?.isStable(stableAfterMs) ?? false)
    )
  }

  #externalFor(sessionId: string): ExternalRuntimePool | undefined {
    return this.external?.owner(sessionId) === undefined
      ? undefined
      : this.external
  }

  async initialize(): Promise<void> {
    await this.omp.initialize()
    await this.external?.initialize()
  }
  newSession(input: ResidentAgentSession): Promise<string> {
    return this.external?.hasAgent(input.agent)
      ? this.external.newSession(input)
      : this.omp.newSession(input)
  }
  resumeSession(
    input: ResidentAgentSession & { sessionId: string },
  ): Promise<void> {
    return this.external?.hasAgent(input.agent)
      ? this.external.resumeSession(input)
      : this.omp.resumeSession(input)
  }
  closeSession(sessionId: string): void {
    const external = this.#externalFor(sessionId)
    if (external) external.closeSession(sessionId)
    else this.omp.closeSession(sessionId)
  }
  async invalidateAgent(agent: string): Promise<void> {
    if (this.external?.hasAgent(agent))
      await this.external.invalidateAgent(agent)
    else await this.omp.invalidateAgent(agent)
  }
  channelFor(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<OmpRpcProcess | ExternalRuntimeChannel> {
    const external = this.#externalFor(sessionId)
    return external
      ? external.channelFor(sessionId, signal)
      : this.omp.channelFor(sessionId, signal)
  }
  isAccepted(sessionId: string, messageId: string): Promise<boolean> {
    const external = this.#externalFor(sessionId)
    return external
      ? external.isAccepted(sessionId, messageId)
      : this.omp.isAccepted(sessionId, messageId)
  }
  async stop(): Promise<void> {
    await Promise.all([this.omp.stop(), this.external?.stop()])
  }
}
