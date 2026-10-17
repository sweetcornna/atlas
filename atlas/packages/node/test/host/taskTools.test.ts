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

test('seven tools, always offered, with closed schemas', () => {
  const { byName } = tools(null)
  for (const name of [
    'start',
    'agents',
    'status',
    'send',
    'cancel',
    'report',
    'updates',
  ])
    expect(byName(`qianmo_task_${name}`).parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
    })
})

test('the agent list takes no arguments and goes to tasks.agents', async () => {
  const { calls, byName } = tools({ contextId: 'c', taskId: 't' })
  expect((await byName('qianmo_task_agents').handler({}, ctx)).ok).toBe(true)
  expect(
    (await byName('qianmo_task_agents').handler({ node: 'x' }, ctx)).ok,
  ).toBe(false)
  expect(calls).toEqual([
    ['tasks.agents', { contextId: 'c', taskId: 't' }, { agent: 'main' }],
  ])
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

test('a refusal is shown; an unknown outcome says what is safe to do next', async () => {
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
    (await broken.byName('qianmo_task_cancel').handler({ id: 'x' }, ctx)).text,
  ).toContain('Check with qianmo_task_status before retrying')
  // A sub-agent may not read status: its two calls say to repeat them.
  const updates = await broken.byName('qianmo_task_updates').handler({}, ctx)
  expect(updates.text).toContain('Call qianmo_task_updates again')
  const report = await broken
    .byName('qianmo_task_report')
    .handler({ summary: 's', state: 'working' }, ctx)
  expect(report.text).toContain('Call qianmo_task_report again')
  for (const text of [updates.text, report.text])
    expect(text).not.toContain('qianmo_task_status')
})

test('a start can be planned: after or at, everyMinutes with times, passed on as given', async () => {
  const { calls, byName } = tools({ contextId: 'c', taskId: 't' })
  const start = byName('qianmo_task_start')
  expect(start.parameters).toMatchObject({
    properties: {
      after: { type: 'integer' },
      at: { type: 'string' },
      everyMinutes: { type: 'integer' },
      times: { type: 'integer' },
    },
    required: ['title', 'instructions'],
  })
  await start.handler(
    { title: '巡检', instructions: '看磁盘', everyMinutes: 60, times: 3 },
    ctx,
  )
  expect(calls[0]![1]).toMatchObject({ everyMinutes: 60, times: 3 })
})

test('the descriptions carry the coordination rules to a console conversation', () => {
  const { byName } = tools(null)
  const start = byName('qianmo_task_start').description
  for (const cue of [
    "Keep this conversation free for the owner's next message",
    'never wait for it here',
    'Do it yourself when one or two steps finish it',
    'one simple tool call, reading one file',
    'Start a task without agent, in your own sub-session',
    'more than a minute or two',
    'may go to another agent',
    'qianmo_task_agents, preferring idle and cheaper ones',
    'separate tasks that run in parallel',
    'after (minutes, 1-10080) or at (an ISO time with its zone, at most 7 days ahead)',
    'everyMinutes (30-10080) with times (1-100)',
    'Tell the owner what you started or planned',
  ])
    expect(start).toContain(cue)
  const status = byName('qianmo_task_status').description
  expect(status).toContain(
    'report the real phase; only a completed task is done',
  )
  expect(status).toContain('decide the next step yourself')
  expect(byName('qianmo_task_send').description).toContain('cancels no task')
  expect(byName('qianmo_task_agents').description).toContain(
    'prefer idle and cheaper ones',
  )
  // The sub-agent's two tools still say they are not for the foreground.
  for (const name of ['qianmo_task_report', 'qianmo_task_updates'])
    expect(byName(name).description).toStartWith('Background sub-agent only.')
})
