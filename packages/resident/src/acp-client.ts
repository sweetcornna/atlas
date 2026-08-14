// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  Stream,
} from '@agentclientprotocol/sdk'
import type { ResidentSessionConnection } from './sessions.js'
import {
  ACP_INPUT_ACCEPTED_METHOD,
  ACP_SESSION_ACTIVITY_METHOD,
  type AcpPromptConnection,
} from './acp-turn.js'

export type ResidentActivitySink = (active: boolean) => void | Promise<void>

export interface ResidentAcpClientOptions {
  readonly stream: Stream
  readonly onInputAccepted: (params: Record<string, unknown>) => Promise<void>
  readonly onActivity?: ResidentActivitySink
  readonly onSessionUpdate?: (
    params: SessionNotification,
  ) => void | Promise<void>
}

class ResidentClient implements Client {
  readonly #onInputAccepted: (params: Record<string, unknown>) => Promise<void>
  readonly #onActivity: ResidentActivitySink | undefined
  readonly #onSessionUpdate:
    | ((params: SessionNotification) => void | Promise<void>)
    | undefined

  constructor(options: ResidentAcpClientOptions) {
    this.#onInputAccepted = options.onInputAccepted
    this.#onActivity = options.onActivity
    this.#onSessionUpdate = options.onSessionUpdate
  }

  async requestPermission(
    _params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return { outcome: { outcome: 'cancelled' } }
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    await this.#onSessionUpdate?.(params)
  }

  async extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (method === ACP_INPUT_ACCEPTED_METHOD) {
      await this.#onInputAccepted(params)
      return
    }
    if (method === ACP_SESSION_ACTIVITY_METHOD) {
      if (typeof params.active === 'boolean') {
        await this.#onActivity?.(params.active)
      }
    }
  }
}

export class ResidentAcpConnection
  implements ResidentSessionConnection, AcpPromptConnection
{
  readonly #connection: ClientSideConnection

  constructor(options: ResidentAcpClientOptions) {
    const client = new ResidentClient(options)
    this.#connection = new ClientSideConnection(() => client, options.stream)
  }

  get closed(): Promise<void> {
    return this.#connection.closed
  }

  async initialize(): Promise<void> {
    await this.#connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'qianmo-resident', version: '0' },
      _meta: { qianmo: { resident: true } },
    })
  }

  async newSession(input: { agent: string; cwd: string }): Promise<string> {
    const result = await this.#connection.newSession({
      cwd: input.cwd,
      mcpServers: [],
      _meta: {
        permissionMode: 'dontAsk',
        qianmo: { resident: true, agent: input.agent },
      },
    })
    return result.sessionId
  }

  async resumeSession(input: {
    agent: string
    cwd: string
    sessionId: string
  }): Promise<void> {
    await this.#connection.unstable_resumeSession({
      sessionId: input.sessionId,
      cwd: input.cwd,
      mcpServers: [],
      _meta: {
        permissionMode: 'dontAsk',
        qianmo: { resident: true, agent: input.agent },
      },
    })
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return await this.#connection.extMethod(method, params)
  }

  async prompt(params: {
    sessionId: string
    messageId: string
    prompt: readonly [{ type: 'text'; text: string }]
  }): Promise<{ readonly userMessageId?: string | null }> {
    return await this.#connection.prompt({
      sessionId: params.sessionId,
      messageId: params.messageId,
      prompt: [...params.prompt],
    })
  }
}

export function createResidentAcpStream(
  writableToAgent: WritableStream<Uint8Array>,
  readableFromAgent: ReadableStream<Uint8Array>,
): Stream {
  return ndJsonStream(writableToAgent, readableFromAgent)
}
