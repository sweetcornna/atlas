// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import type { ControlOutcome } from '@qianmo/protocol'
import { taskTools } from '../../src/host/taskTools.js'

const ctx = { agent: 'main', sessionId: 's-1' }

function tools(
  origin: { contextId: string; taskId: string } | null,
  answer: ControlOutcome | Error = { ok: true, value: { id: 'task-1' } },
) {
  const calls: [string, Record<string, unknown>, { agent: string }][] = []
  const list = taskTools({
    call: async (op, args, options) => {
      calls.push([op, args, options])
      if (answer instanceof Error) throw answer
      return answer
    },
    origin: () => origin,
  })
  return {
    calls,
    byName: (name: string) => list.find(one => one.name === name)!,
  }
}

test('six tools, always offered, with closed schemas', () => {
  const { byName } = tools(null)
  for (const name of ['start', 'status', 'send', 'cancel', 'report', 'updates'])
    expect(byName(`qianmo_task_${name}`).parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
    })
})

test('a call carries the conversation and turn it came from', async () => {
  const { calls, byName } = tools({
    contextId: 'console-session',
    taskId: 'turn-7',
  })
  const result = await byName('qianmo_task_start').handler(
    { title: '周报', instructions: '写周报' },
    ctx,
  )
  expect(result).toMatchObject({ ok: true, text: '{"id":"task-1"}' })
  expect(calls).toEqual([
    [
      'tasks.start',
      {
        title: '周报',
        instructions: '写周报',
        contextId: 'console-session',
        taskId: 'turn-7',
      },
      { agent: 'main' },
    ],
  ])
})

test('refused before the hub: bad arguments, no running console turn', async () => {
  const { calls, byName } = tools({ contextId: 'c', taskId: 't' })
  expect(
    (await byName('qianmo_task_send').handler({ id: 'task-1' }, ctx)).ok,
  ).toBe(false)
  expect(
    (
      await byName('qianmo_task_status').handler(
        { id: 'x', contextId: 'forged' },
        ctx,
      )
    ).ok,
  ).toBe(false)
  expect((await byName('qianmo_task_report').handler([], ctx)).ok).toBe(false)
  expect(calls).toEqual([])
  const offline = tools(null)
  const result = await offline.byName('qianmo_task_status').handler({}, ctx)
  expect(result.text).toContain(
    'only available in a console or chat-channel conversation',
  )
  expect(offline.calls).toEqual([])
})

test('a refusal is shown, an unknown outcome says not to retry blindly', async () => {
  const refused = tools(
    { contextId: 'c', taskId: 't' },
    { ok: false, code: 'refused', message: '当前会话中没有这个任务' },
  )
  expect(
    await refused.byName('qianmo_task_cancel').handler({ id: 'x' }, ctx),
  ).toMatchObject({
    ok: false,
    text: '{"error":"当前会话中没有这个任务"}',
  })
  const broken = tools({ contextId: 'c', taskId: 't' }, new Error('link down'))
  expect(
    (await broken.byName('qianmo_task_updates').handler({}, ctx)).text,
  ).toContain('Check with qianmo_task_status before retrying')
})
