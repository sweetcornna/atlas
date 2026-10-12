// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createInterface } from 'node:readline'
import type { AssistantMessage } from '@oh-my-pi/pi-ai'
import { RpcFrameEncoder } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame'
import { RpcPromptResults } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-prompt-results'
import { RpcSessionSettleWatcher } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-settle'
import type { AgentSessionEvent } from '@oh-my-pi/pi-coding-agent/session/agent-session'

// Real production reporters own prompt_result and session_settled. The host
// controls when the background job wakes, never when the session settles.
const encoder = new RpcFrameEncoder()
const emit = (frame: object) => process.stdout.write(encoder.encode(frame))
const backgroundDone = Promise.withResolvers<void>()
const resultWritten = Promise.withResolvers<void>()
const session = {
  isStreaming: false,
  hasAdmittedSubmission: false,
  queuedMessageCount: 0,
  pendingAsyncWork: false,
  hasPendingAsyncWork() {
    return this.pendingAsyncWork
  },
  async settleAsyncWork() {
    await backgroundDone.promise
  },
}
const results = new RpcPromptResults(session, frame => {
  emit(frame)
  resultWritten.resolve()
})
const watcher = new RpcSessionSettleWatcher(session, emit)
function observe(event: AgentSessionEvent, forward = true) {
  if (forward) emit(event)
  results.observe(event)
  watcher.observe(event)
}
function assistant(stopReason: 'stop' | 'error' | 'aborted'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'settlement fixture response' }],
    api: 'openai-completions',
    provider: 'fixture',
    model: 'fixture',
    stopReason,
    ...(stopReason === 'error' ? { errorMessage: 'background failed' } : {}),
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}
function end(stopReason: 'stop' | 'error' | 'aborted', forwardMessage = true) {
  const message = assistant(stopReason)
  observe({ type: 'message_end', message }, forwardMessage)
  session.isStreaming = false
  observe({
    type: 'agent_end',
    messages: [message],
    isTerminal: true,
    yielded: true,
  })
}
function respond(frame: Record<string, unknown>, data: object = {}) {
  emit({
    type: 'response',
    id: frame.id,
    command: frame.type,
    success: true,
    data,
  })
}
async function handle(frame: Record<string, unknown>) {
  if (frame.type === 'prompt') {
    const ticket = results.begin(String(frame.id))
    session.pendingAsyncWork = true
    session.isStreaming = true
    observe({ type: 'agent_start' })
    results.settle(ticket)
    respond(frame, { agentInvoked: true })
    end('stop')
    return
  }
  if (frame.type === 'fixture_exit') {
    process.exit(7)
  }
  if (frame.type === 'fixture_protocol_error') {
    process.stdout.write('invalid RPC JSON\n')
    return
  }
  if (frame.type === 'fixture_continue' || frame.type === 'abort') {
    // Ensure completed(false) has left the production reporter before waking
    // another run. There is no prompt ticket for a background continuation.
    await resultWritten.promise
    if (
      frame.type === 'abort' &&
      process.env.QIANMO_SETTLEMENT_ABORT_ACK_ONLY === '1'
    ) {
      // A cancelled/detached continuation need not publish agent_end. The
      // pending settle check still observes its background work draining.
      session.pendingAsyncWork = false
      respond(frame)
      backgroundDone.resolve()
      return
    }
    const ticket =
      process.env.QIANMO_SETTLEMENT_NEW_PROMPT === '1'
        ? results.begin('second-prompt')
        : undefined
    session.isStreaming = true
    observe({ type: 'agent_start' })
    if (ticket) results.settle(ticket)
    const outcome =
      frame.type === 'abort' ? 'aborted' : process.env.QIANMO_SETTLEMENT_OUTCOME
    session.pendingAsyncWork = false
    end(
      outcome === 'error' || outcome === 'aborted' ? outcome : 'stop',
      process.env.QIANMO_SETTLEMENT_END_ONLY !== '1',
    )
    if (process.env.QIANMO_SETTLEMENT_FRAME_ERROR === '1')
      emit({ type: 'rpc_frame_error', error: 'fixture frame overflow' })
    respond(frame)
    backgroundDone.resolve()
    return
  }
  respond(frame)
}
createInterface({ input: process.stdin }).on('line', line => {
  void handle(JSON.parse(line) as Record<string, unknown>).catch(error => {
    process.stderr.write(String(error))
    process.exit(1)
  })
})
emit({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] })
