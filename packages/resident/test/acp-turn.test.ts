// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { describe, expect, mock, test } from 'bun:test'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { ProtocolErrorCode } from '@qianmo/protocol'
import { AcpResidentTurnPort } from '../src/acp-turn.js'

const INPUT = {
  sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  messageId: '11111111-2222-4333-8444-555555555555',
  prompt: 'mailbox prompt',
}

function chunk(text: string, sessionId = INPUT.sessionId): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
  }
}

describe('ACP resident turn port', () => {
  test('checks deterministic input status through the resident extension', async () => {
    const connection = {
      extMethod: mock(async () => ({ accepted: true })),
      prompt: mock(async () => ({ userMessageId: null })),
    }
    const port = new AcpResidentTurnPort(connection)

    await expect(port.isAccepted(INPUT)).resolves.toBe(true)
    expect(connection.extMethod).toHaveBeenCalledWith('qianmo/input-status', {
      sessionId: INPUT.sessionId,
      messageId: INPUT.messageId,
    })
  })

  test('read-flip callback runs on input-accepted, before prompt completes', async () => {
    let releasePrompt!: () => void
    const connection = {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(
        () =>
          new Promise<{ userMessageId: null }>(resolve => {
            releasePrompt = () => resolve({ userMessageId: null })
          }),
      ),
    }
    const port = new AcpResidentTurnPort(connection)
    const accepted = mock(async () => {})

    const executing = port.execute(INPUT, accepted)
    await port.handleInputAccepted({ messageId: INPUT.messageId })

    expect(accepted).toHaveBeenCalledTimes(1)
    expect(connection.prompt).toHaveBeenCalledWith({
      sessionId: INPUT.sessionId,
      messageId: INPUT.messageId,
      prompt: [{ type: 'text', text: INPUT.prompt }],
    })
    releasePrompt()
    await executing
  })

  test('uses the prompt response message id when notification delivery races it', async () => {
    const connection = {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(async () => ({ userMessageId: INPUT.messageId })),
    }
    const port = new AcpResidentTurnPort(connection)
    const accepted = mock(async () => {})

    await port.execute(INPUT, accepted)

    expect(accepted).toHaveBeenCalledTimes(1)
  })

  test('aggregates the turn body from the structured agent message chunks', async () => {
    let releasePrompt!: () => void
    const connection = {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(
        () =>
          new Promise<{ userMessageId: string; stopReason: string }>(
            resolve => {
              releasePrompt = () =>
                resolve({
                  userMessageId: INPUT.messageId,
                  stopReason: 'end_turn',
                })
            },
          ),
      ),
    }
    const port = new AcpResidentTurnPort(connection)

    const executing = port.execute(INPUT, async () => {})
    // Thoughts are not the answer, and another session is not this task.
    port.handleSessionUpdate(chunk('the '))
    port.handleSessionUpdate({
      sessionId: INPUT.sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking out loud' },
      },
    })
    port.handleSessionUpdate(chunk('stolen body', 'another-session'))
    port.handleSessionUpdate(chunk('answer'))
    releasePrompt()

    await expect(executing).resolves.toEqual({
      outcome: 'completed',
      content: 'the answer',
    })
  })

  test('a body cannot leak from one turn into the next', async () => {
    const connection = {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(async () => ({
        userMessageId: INPUT.messageId,
        stopReason: 'end_turn',
      })),
    }
    const port = new AcpResidentTurnPort(connection)

    const first = port.execute(INPUT, async () => {})
    port.handleSessionUpdate(chunk('first'))
    await first
    // Late chunk for a settled turn: dropped, not carried forward.
    port.handleSessionUpdate(chunk('late'))

    const second = port.execute(
      { ...INPUT, messageId: '22222222-3333-4444-8555-666666666666' },
      async () => {},
    )
    port.handleSessionUpdate(chunk('second'))

    await expect(second).resolves.toEqual({
      outcome: 'completed',
      content: 'second',
    })
  })

  test('a cancelled turn is a failed result, not an empty completed one', async () => {
    const connection = {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(async () => ({
        userMessageId: INPUT.messageId,
        stopReason: 'cancelled',
      })),
    }
    const port = new AcpResidentTurnPort(connection)

    await expect(port.execute(INPUT, async () => {})).resolves.toEqual({
      outcome: 'failed',
      code: ProtocolErrorCode.E_TASK_FAILED,
      reason: 'ACP turn was cancelled',
    })
  })

  test('refusals and ceiling stops are failures too, not truncated successes', async () => {
    for (const stopReason of ['refusal', 'max_tokens', 'max_turn_requests']) {
      const connection = {
        extMethod: mock(async () => ({ accepted: false })),
        prompt: mock(async () => ({
          userMessageId: INPUT.messageId,
          stopReason,
        })),
      }
      const port = new AcpResidentTurnPort(connection)

      const result = await port.execute(INPUT, async () => {})

      expect(result.outcome).toBe('failed')
      if (result.outcome !== 'failed') throw new Error('unreachable')
      expect(result.code).toBe(ProtocolErrorCode.E_TASK_FAILED)
      expect(result.reason.length).toBeGreaterThan(0)
    }
  })

  test('an unfamiliar stop reason is not invented into a failure', async () => {
    const connection = {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(async () => ({
        userMessageId: INPUT.messageId,
        stopReason: 'something_this_build_has_never_heard_of',
      })),
    }
    const port = new AcpResidentTurnPort(connection)

    await expect(port.execute(INPUT, async () => {})).resolves.toEqual({
      outcome: 'completed',
      content: '',
    })
  })

  test('unknown acceptance notifications cannot flip a mailbox entry', async () => {
    const connection = {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(async () => ({ userMessageId: null })),
    }
    const port = new AcpResidentTurnPort(connection)

    await expect(
      port.handleInputAccepted({ messageId: 'unknown' }),
    ).resolves.toBeUndefined()
  })
})
