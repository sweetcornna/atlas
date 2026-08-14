// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import type { ResidentSessionStore } from './session-store.js'

export interface ResidentAgentSession {
  readonly agent: string
  readonly cwd: string
}

export interface ResidentSessionConnection {
  initialize(): Promise<void>
  newSession(input: ResidentAgentSession): Promise<string>
  resumeSession(
    input: ResidentAgentSession & { sessionId: string },
  ): Promise<void>
}

export class ResidentSessionManager {
  readonly #connection: ResidentSessionConnection
  readonly #store: ResidentSessionStore
  readonly #agents: readonly ResidentAgentSession[]
  readonly #sessions = new Map<string, string>()

  constructor(options: {
    readonly connection: ResidentSessionConnection
    readonly store: ResidentSessionStore
    readonly agents: readonly ResidentAgentSession[]
  }) {
    if (options.agents.length === 0) {
      throw new Error('resident node requires at least one agent')
    }
    const names = new Set<string>()
    for (const agent of options.agents) {
      if (names.has(agent.agent)) {
        throw new Error(`duplicate resident agent ${agent.agent}`)
      }
      names.add(agent.agent)
    }
    this.#connection = options.connection
    this.#store = options.store
    this.#agents = options.agents
  }

  async start(): Promise<void> {
    await this.#connection.initialize()
    for (const agent of this.#agents) {
      const stored = this.#store.get(agent.agent)
      if (stored === undefined) {
        const sessionId = await this.#connection.newSession(agent)
        this.#store.set(agent.agent, sessionId)
        this.#sessions.set(agent.agent, sessionId)
      } else {
        await this.#connection.resumeSession({ ...agent, sessionId: stored })
        this.#sessions.set(agent.agent, stored)
      }
    }
  }

  sessionOf(agent: string): string {
    const sessionId = this.#sessions.get(agent)
    if (sessionId === undefined) {
      throw new Error(`resident agent ${agent} has no active ACP session`)
    }
    return sessionId
  }

  sessions(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.#sessions)
  }
}
