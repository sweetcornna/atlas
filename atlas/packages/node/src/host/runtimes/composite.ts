// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  OmpRpcChannel,
  OmpTurnRouter,
  ResidentAgentSession,
  ResidentSessionConnection,
} from '@qianmo/resident'
import type { OmpRpcProcess } from '../residentOmp.js'
import { FALLBACK_RUNTIME } from './catalog.js'
import type { ExternalRuntimeChannel } from './channel.js'
import { portableChannel, portableLogPath } from './portableLog.js'

/** What the composite uses of a pool; `ResidentOmpPool` and `ExternalRuntimePool` are ones. */
interface SessionPool<C extends OmpRpcChannel>
  extends ResidentSessionConnection {
  readonly alive: boolean
  isStable(stableAfterMs: number): boolean
  closeSession(sessionId: string): void
  invalidateAgent(agent: string): Promise<void>
  channelFor(sessionId: string, signal?: AbortSignal): Promise<C>
  isAccepted(sessionId: string, messageId: string): Promise<boolean>
  stop(): Promise<void>
}

/** The qianmopi pool (`ResidentOmpPool`): its fate is the generation's. */
export interface OmpSessionPool<C extends OmpRpcChannel = OmpRpcProcess>
  extends SessionPool<C> {
  readonly closed: Promise<void>
  readonly parkedReason: string | undefined
}

/** The external pool (`ExternalRuntimePool`). */
export interface ExternalSessionPool<
  C extends OmpRpcChannel = ExternalRuntimeChannel,
> extends SessionPool<C> {
  hasAgent(agent: string): boolean
  owner(sessionId: string): { readonly agent: string } | undefined
  /** {@link ExternalRuntimePool.conversationSince}. */
  conversationSince?(sessionId: string): number | undefined
}

/** How sessions are routed between the pools. */
export interface RuntimeRouting {
  /**
   * Where `agent`'s sessions run now: `omp` (qianmopi) or an external
   * catalog id (P36 §3), read for every new turn. Absent: the agents the
   * external pool has run there, the rest on qianmopi (P27).
   */
  readonly runtimeOf?: (agent: string) => string
  /**
   * Keep each session's portable transcript and carry it over when the
   * runtime changes (§6.3). Default: on when `runtimeOf` is given.
   */
  readonly portable?: boolean
  readonly onError?: (error: unknown) => void
}

/**
 * One node, several runtimes: each turn of a session goes to the pool of the
 * runtime its agent runs on at that moment — the omp pool for qianmopi, the
 * external pool for the others. Both pools know every agent, so a session
 * can move between them; the pool it moves to opens a new native session,
 * and the portable transcript tells the new runtime what happened before.
 *
 * Only the omp pool decides the generation's fate (`closed`, parking): an
 * external process that dies fails its own turn and is restarted on the next
 * one, without taking the qianmopi children down with it.
 */
export class ResidentRuntimePool<
  O extends OmpRpcChannel = OmpRpcProcess,
  E extends OmpRpcChannel = ExternalRuntimeChannel,
> implements ResidentSessionConnection, OmpTurnRouter
{
  readonly omp: OmpSessionPool<O>
  readonly external: ExternalSessionPool<E> | undefined
  readonly closed: Promise<void>
  readonly #routing: RuntimeRouting
  readonly #portable: boolean
  /** How each session was opened, to open it again in the other pool. */
  readonly #sessions = new Map<string, ResidentAgentSession>()
  /** The pool each session was last opened in. */
  readonly #openedIn = new Map<string, SessionPool<O> | SessionPool<E>>()

  constructor(
    omp: OmpSessionPool<O>,
    external?: ExternalSessionPool<E>,
    routing: RuntimeRouting = {},
  ) {
    this.omp = omp
    this.external = external
    this.closed = omp.closed
    this.#routing = routing
    this.#portable = routing.portable ?? routing.runtimeOf !== undefined
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

  /** The runtime `agent`'s next turn runs on, as this pool can serve it. */
  #runtime(agent: string): string {
    if (this.external === undefined) return FALLBACK_RUNTIME
    const runtimeOf = this.#routing.runtimeOf
    if (runtimeOf !== undefined) return runtimeOf(agent)
    return this.external.hasAgent(agent) ? 'external' : FALLBACK_RUNTIME
  }
  #pool(runtime: string): SessionPool<O> | SessionPool<E> {
    return runtime === FALLBACK_RUNTIME || this.external === undefined
      ? this.omp
      : this.external
  }
  #agentOf(sessionId: string): string | undefined {
    return (
      this.#sessions.get(sessionId)?.agent ??
      this.external?.owner(sessionId)?.agent
    )
  }

  async initialize(): Promise<void> {
    await this.omp.initialize()
    // The external pool starts its tool host on first use when no agent
    // runs there yet.
    if (this.#routing.runtimeOf === undefined) await this.external?.initialize()
  }
  async newSession(input: ResidentAgentSession): Promise<string> {
    const pool = this.#pool(this.#runtime(input.agent))
    const sessionId = await pool.newSession(input)
    this.#sessions.set(sessionId, input)
    this.#openedIn.set(sessionId, pool)
    return sessionId
  }
  async resumeSession(
    input: ResidentAgentSession & { sessionId: string },
  ): Promise<void> {
    const pool = this.#pool(this.#runtime(input.agent))
    await pool.resumeSession(input)
    const { sessionId, ...session } = input
    this.#sessions.set(sessionId, session)
    this.#openedIn.set(sessionId, pool)
  }
  closeSession(sessionId: string): void {
    this.omp.closeSession(sessionId)
    this.external?.closeSession(sessionId)
    this.#sessions.delete(sessionId)
    this.#openedIn.delete(sessionId)
  }
  /** `agent`'s configuration or runtime changed: both pools recycle it. */
  async invalidateAgent(agent: string): Promise<void> {
    await Promise.all([
      this.omp.invalidateAgent(agent),
      this.external?.invalidateAgent(agent),
    ])
  }
  async channelFor(sessionId: string, signal?: AbortSignal): Promise<O | E> {
    const agent = this.#agentOf(sessionId)
    if (agent === undefined) return this.omp.channelFor(sessionId, signal)
    const runtime = this.#runtime(agent)
    const pool = this.#pool(runtime)
    // Moved here from the other pool: open it here first.
    const session = this.#sessions.get(sessionId)
    if (session !== undefined && this.#openedIn.get(sessionId) !== pool) {
      await pool.resumeSession({ ...session, sessionId })
      this.#openedIn.set(sessionId, pool)
    }
    const external = pool === this.omp ? undefined : this.external
    const channel =
      external === undefined
        ? await this.omp.channelFor(sessionId, signal)
        : await external.channelFor(sessionId, signal)
    if (!this.#portable) return channel
    return portableChannel(channel, {
      file: portableLogPath(agent, sessionId),
      runtime: external === undefined ? FALLBACK_RUNTIME : runtime,
      // qianmopi keeps one conversation per session for good.
      conversationSince: () =>
        external === undefined ? 0 : external.conversationSince?.(sessionId),
      ...(this.#routing.onError === undefined
        ? {}
        : { onError: this.#routing.onError }),
    })
  }
  /**
   * Crash recovery: the input reached a transcript of either pool (the
   * session may have changed runtime since).
   */
  async isAccepted(sessionId: string, messageId: string): Promise<boolean> {
    const agent = this.#agentOf(sessionId)
    const first =
      agent === undefined ? this.omp : this.#pool(this.#runtime(agent))
    const second =
      this.external === undefined
        ? undefined
        : first === this.omp
          ? this.external
          : this.omp
    let failure: unknown
    try {
      if (await first.isAccepted(sessionId, messageId)) return true
    } catch (error) {
      if (second === undefined) throw error
      failure = error
    }
    if (second === undefined) return false
    try {
      return await second.isAccepted(sessionId, messageId)
    } catch (error) {
      if (failure !== undefined) throw failure
      return false
    }
  }
  async stop(): Promise<void> {
    await Promise.all([this.omp.stop(), this.external?.stop()])
  }
}
