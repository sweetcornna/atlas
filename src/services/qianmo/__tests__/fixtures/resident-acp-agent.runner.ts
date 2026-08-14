// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type {
  Agent,
  AgentSideConnection as AcpConnection,
  InitializeRequest,
  NewSessionRequest,
  PromptRequest,
  ResumeSessionRequest,
} from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'

const accepted = new Map<string, Set<string>>()
let connection!: AcpConnection

function remember(sessionId: string, messageId: string): void {
  let messages = accepted.get(sessionId)
  if (messages === undefined) {
    messages = new Set<string>()
    accepted.set(sessionId, messages)
  }
  messages.add(messageId)
}

const agent: Agent = {
  initialize: async (_params: InitializeRequest) => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      sessionCapabilities: { resume: {} },
    },
  }),
  authenticate: async () => {},
  newSession: async (_params: NewSessionRequest) => ({
    sessionId: randomUUID(),
  }),
  unstable_resumeSession: async (_params: ResumeSessionRequest) => ({}),
  prompt: async (params: PromptRequest) => {
    const messageId = params.messageId
    if (typeof messageId !== 'string') {
      throw new Error('resident fixture requires messageId')
    }
    remember(params.sessionId, messageId)
    await connection.extNotification('qianmo/session-activity', {
      active: true,
    })
    await connection.extNotification('qianmo/input-accepted', {
      sessionId: params.sessionId,
      messageId,
    })
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text: 'fixture response' },
      },
    })
    if (process.env.QIANMO_FIXTURE_HOLD_BUSY === '1') {
      await new Promise<void>(() => {})
    }
    await connection.extNotification('qianmo/session-activity', {
      active: false,
    })
    return { stopReason: 'end_turn', userMessageId: messageId }
  },
  cancel: async () => {},
  extMethod: async (method, params) => {
    if (method !== 'qianmo/input-status') return {}
    const sessionId = params.sessionId
    const messageId = params.messageId
    return {
      accepted:
        typeof sessionId === 'string' &&
        typeof messageId === 'string' &&
        (accepted.get(sessionId)?.has(messageId) ?? false),
    }
  },
}

const writable = Writable.toWeb(
  process.stdout,
) as unknown as WritableStream<Uint8Array>
const readable = Readable.toWeb(
  process.stdin,
) as unknown as ReadableStream<Uint8Array>
connection = new AgentSideConnection(
  () => agent,
  ndJsonStream(writable, readable),
)
process.stdin.resume()
