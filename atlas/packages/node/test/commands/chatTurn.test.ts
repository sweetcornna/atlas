// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The reply rule channels, background tasks and schedules share
 * (`chatTurn.ts`): which agent line answers a task, and which notices are the
 * agent's own.
 */

import { describe, expect, test } from 'bun:test'
import type { ChatTurn } from '@qianmo/console'
import { agentNotices, terminalReply } from '../../src/commands/chatTurn.js'

function turn(fields: Partial<ChatTurn>): ChatTurn {
  return {
    id: crypto.randomUUID(),
    sessionId: 's',
    author: 'agent',
    at: 100,
    text: 'x',
    state: 'done',
    ...fields,
  }
}

describe('the shared reply rule', () => {
  test('a local timeout is not an answer; the node timeout and a failure are', () => {
    const local = turn({ taskId: 't', state: 'failed', code: 'E_TASK_TIMEOUT' })
    expect(terminalReply([local], 't')).toBeUndefined()
    const remote = { ...local, id: 'r', remoteTerminal: true as const }
    expect(terminalReply([local, remote], 't')?.id).toBe('r')
    const unknown = turn({ taskId: 't', deliveryUnknown: true })
    expect(terminalReply([unknown], 't')).toBeUndefined()
    expect(terminalReply([turn({ taskId: 'other' })], 't')).toBeUndefined()
    expect(
      terminalReply([turn({ taskId: 't', variant: 'notice' })], 't'),
    ).toBeUndefined()
  })

  test("the agent's own notices for this turn, not tool steps, host notes or older ones", () => {
    const own = turn({ variant: 'notice', noticeSource: 'agent', at: 200 })
    const caused = turn({
      variant: 'notice',
      noticeSource: 'agent',
      causeTaskId: 't',
      at: 200,
    })
    const rows = [
      own,
      caused,
      turn({ variant: 'notice', noticeSource: 'step', at: 200 }),
      turn({ variant: 'notice', noticeSource: 'task', at: 200 }),
      turn({ variant: 'notice', noticeSource: 'agent', at: 50 }),
      turn({
        variant: 'notice',
        noticeSource: 'agent',
        causeTaskId: 'other',
        at: 200,
      }),
    ]
    expect(agentNotices(rows, 't', 100).map(one => one.id)).toEqual([
      own.id,
      caused.id,
    ])
  })
})
