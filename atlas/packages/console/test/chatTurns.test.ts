// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { unansweredTurns } from '../src/index.js'
import type { ChatTurn } from '../src/deps.js'

function turn(id: string, fields: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id,
    sessionId: 'session',
    author: 'operator',
    at: 1,
    text: id,
    state: 'delivered',
    ...fields,
  }
}
function waiting(turns: readonly ChatTurn[]): readonly string[] {
  return unansweredTurns(turns).map(one => one.id)
}

test('answers pair by taskId, so A answering after B was sent leaves B waiting', () => {
  const a = turn('a', { taskId: 'task-a' })
  const b = turn('b', { taskId: 'task-b' })
  const reply = turn('reply-a', {
    author: 'agent',
    state: 'done',
    taskId: 'task-a',
  })
  expect(waiting([a, b, reply])).toEqual(['b'])
  expect(
    waiting([
      a,
      b,
      reply,
      turn('reply-b', { author: 'agent', state: 'failed', taskId: 'task-b' }),
    ]),
  ).toEqual([])
})

test('a notice with the taskId is progress and does not answer the operator', () => {
  expect(
    waiting([
      turn('ask', { taskId: 'task' }),
      turn('notice', {
        author: 'agent',
        state: 'done',
        variant: 'notice',
        taskId: 'task',
      }),
      turn('operator-notice', { variant: 'notice' }),
    ]),
  ).toEqual(['ask'])
})

test('failed operator turns never remain in flight, with or without a taskId', () => {
  expect(
    waiting([
      turn('failed-keyed', { state: 'failed', taskId: 'task' }),
      turn('failed-unkeyed', { state: 'failed' }),
      turn('live', { taskId: 'live' }),
    ]),
  ).toEqual(['live'])
})

test('unkeyed turns wait only after the last real agent turn; later notices do not end that wait', () => {
  expect(
    waiting([
      turn('before'),
      turn('first-answer', { author: 'agent', state: 'done' }),
      turn('between'),
      turn('last-answer', { author: 'agent', state: 'done' }),
      turn('after'),
      turn('notice', { author: 'agent', state: 'done', variant: 'notice' }),
    ]),
  ).toEqual(['after'])
})
