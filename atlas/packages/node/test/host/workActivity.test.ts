// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P37.17 B — the activity tracker (`docs/dev/work-tasks.md` §3.3, §5.5):
 * omp's `todo` list reaches the hub at most once per debounce window and
 * once more when the turn ends; skills come from `/skill:` in the prompt and
 * from `read skill://…`; a turn that used nothing reports nothing; a turn
 * with no console origin is never reported; a failed hub call never throws.
 */

import { describe, expect, test } from 'bun:test'
import type { ControlOutcome } from '@qianmo/protocol'
import type { ResidentToolEvent } from '@qianmo/resident'
import {
  todoItems,
  WORK_ACTIVITY_DEBOUNCE_MS,
  type WorkActivityInput,
  WorkActivityTracker,
} from '../../src/host/workActivity.js'

interface Sent {
  readonly op: string
  readonly args: Record<string, unknown>
  readonly agent: string
}

function tracker(
  options: {
    origin?: (
      input: WorkActivityInput,
    ) => { contextId: string; taskId: string } | null
    debounceMs?: number
    fail?: boolean
  } = {},
) {
  const sent: Sent[] = []
  const work = new WorkActivityTracker({
    call: async (op, args, { agent }) => {
      sent.push({ op, args, agent })
      if (options.fail === true) throw new Error('link down')
      return { ok: true, value: {} } satisfies ControlOutcome
    },
    origin:
      options.origin ??
      (input =>
        input.sessionId === 'chat-1'
          ? { contextId: 'ctx-1', taskId: 'task-1' }
          : null),
    debounceMs: options.debounceMs ?? 20,
  })
  return { work, sent }
}

const INPUT: WorkActivityInput = {
  sessionId: 'chat-1',
  messageId: 'm-1',
  prompt: '/skill:qmo-slides 做一份季度汇报',
  agent: 'writer',
}

const todo = (statuses: string[]): ResidentToolEvent => ({
  phase: 'end',
  toolCallId: `todo-${statuses.join('-')}`,
  toolName: 'todo',
  isError: false,
  details: {
    phases: [
      {
        name: '准备',
        tasks: statuses.map((status, index) => ({
          content: `第 ${index + 1} 步`,
          status,
        })),
      },
    ],
  },
})

const start = (
  toolName: string,
  args: Record<string, unknown>,
  id = toolName,
): ResidentToolEvent => ({ phase: 'start', toolCallId: id, toolName, args })

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('todoItems', () => {
  test('reads omp’s phases, skips what is not a list item', () => {
    expect(
      todoItems({
        phases: [
          {
            name: 'A',
            tasks: [
              { content: 'one', status: 'completed' },
              { content: 'two', status: 'in_progress' },
              { content: 'bad', status: 'later' },
              { content: 3, status: 'pending' },
              null,
            ],
          },
          { name: 7, tasks: [{ content: 'three', status: 'pending' }] },
          { name: 'no tasks' },
        ],
      }),
    ).toEqual([
      { phase: 'A', content: 'one', status: 'completed' },
      { phase: 'A', content: 'two', status: 'in_progress' },
      { phase: '', content: 'three', status: 'pending' },
    ])
    expect(todoItems(null)).toBeUndefined()
    expect(todoItems({ phases: 'x' })).toBeUndefined()
    expect(todoItems({ phases: [] })).toEqual([])
  })

  test('at most a hundred items', () => {
    const tasks = Array.from({ length: 150 }, (_, i) => ({
      content: `t${i}`,
      status: 'pending',
    }))
    expect(todoItems({ phases: [{ name: 'p', tasks }] })).toHaveLength(100)
  })
})

describe('WorkActivityTracker', () => {
  test('the default window is two seconds', () => {
    expect(WORK_ACTIVITY_DEBOUNCE_MS).toBe(2000)
  })

  test('list changes inside one window fold into one report; turn end sends the account', async () => {
    const { work, sent } = tracker({ debounceMs: 30 })
    work.onToolEvent(INPUT, start('todo', {}, 't1'))
    work.onToolEvent(INPUT, todo(['in_progress', 'pending']))
    work.onToolEvent(INPUT, todo(['completed', 'in_progress']))
    expect(sent).toHaveLength(0)
    await wait(80)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.op).toBe('work.activity')
    expect(sent[0]!.agent).toBe('writer')
    expect(sent[0]!.args).toEqual({
      contextId: 'ctx-1',
      taskId: 'task-1',
      todo: [
        { phase: '准备', content: '第 1 步', status: 'completed' },
        { phase: '准备', content: '第 2 步', status: 'in_progress' },
      ],
      context: {
        skills: ['qmo-slides'],
        tools: [{ name: 'todo', count: 1 }],
        files: [],
      },
    })
    work.onToolEvent(
      INPUT,
      start('read', { path: 'skill://qmo-slides/reference.md' }),
    )
    work.onToolEvent(
      INPUT,
      start('qianmo_make_document', { name: '汇报.pptx' }, 'm1'),
    )
    work.onToolEvent(INPUT, { phase: 'turn_end' })
    expect(sent).toHaveLength(2)
    // The list did not change since the last report: it is not resent.
    expect(sent[1]!.args.todo).toBeUndefined()
    expect(sent[1]!.args.context).toEqual({
      skills: ['qmo-slides'],
      tools: [
        { name: 'todo', count: 1 },
        { name: 'read', count: 1 },
        { name: 'qianmo_make_document', count: 1 },
      ],
      // skill:// is not a file of the turn; `name` is not a path field.
      files: [],
    })
  })

  test('a list changed after the last report rides on the turn-end report', async () => {
    const { work, sent } = tracker({ debounceMs: 10_000 })
    work.onToolEvent(INPUT, todo(['in_progress']))
    work.onToolEvent(INPUT, { phase: 'turn_end' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.args.todo).toEqual([
      { phase: '准备', content: '第 1 步', status: 'in_progress' },
    ])
    // The window's timer went with the turn: nothing more arrives.
    await wait(30)
    expect(sent).toHaveLength(1)
  })

  test('skills from reading skill:// and files from path arguments', () => {
    const { work, sent } = tracker()
    const plain = { ...INPUT, prompt: '整理一下这些数据' }
    work.onToolEvent(
      plain,
      start('read', { path: 'skill://qmo-sheet/SKILL.md' }, 'r1'),
    )
    work.onToolEvent(plain, start('read', { path: 'data/q3.csv' }, 'r2'))
    work.onToolEvent(plain, start('edit', { file_path: 'notes.md' }, 'e1'))
    work.onToolEvent(
      plain,
      start(
        'qianmo_deliver_files',
        { files: [{ name: 'q3.xlsx' }, 'b.md'] },
        'd1',
      ),
    )
    work.onToolEvent(plain, { phase: 'turn_end' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.args.todo).toBeUndefined()
    expect(sent[0]!.args.context).toEqual({
      skills: ['qmo-sheet'],
      tools: [
        { name: 'read', count: 2 },
        { name: 'edit', count: 1 },
        { name: 'qianmo_deliver_files', count: 1 },
      ],
      files: ['data/q3.csv', 'notes.md', 'q3.xlsx', 'b.md'],
    })
  })

  test('a turn that used nothing reports nothing', () => {
    const { work, sent } = tracker()
    work.onToolEvent({ ...INPUT, prompt: '你好' }, { phase: 'turn_end' })
    expect(sent).toHaveLength(0)
  })

  test('a prompt that only names a skill still reports it', () => {
    const { work, sent } = tracker()
    work.onToolEvent(INPUT, { phase: 'turn_end' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.args.context).toEqual({
      skills: ['qmo-slides'],
      tools: [],
      files: [],
    })
  })

  test('a turn with no console origin, or no agent, is not tracked', async () => {
    const { work, sent } = tracker()
    const other = { ...INPUT, sessionId: 'peer-7' }
    work.onToolEvent(other, todo(['pending']))
    work.onToolEvent(other, { phase: 'turn_end' })
    const anonymous = { ...INPUT, agent: undefined }
    work.onToolEvent(anonymous, todo(['pending']))
    work.onToolEvent(anonymous, { phase: 'turn_end' })
    await wait(40)
    expect(sent).toHaveLength(0)
  })

  test('a failed todo call and a failed hub call are both dropped quietly', async () => {
    const { work, sent } = tracker({ fail: true })
    work.onToolEvent(INPUT, {
      ...todo(['pending']),
      isError: true,
    } as ResidentToolEvent)
    work.onToolEvent(INPUT, { phase: 'turn_end' })
    await wait(10)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.args.todo).toBeUndefined()
  })

  test('close drops pending windows', async () => {
    const { work, sent } = tracker({ debounceMs: 20 })
    work.onToolEvent(INPUT, todo(['pending']))
    work.close()
    await wait(50)
    expect(sent).toHaveLength(0)
  })

  test('each turn starts a fresh account', () => {
    const { work, sent } = tracker()
    work.onToolEvent(INPUT, start('bash', { command: 'ls' }))
    work.onToolEvent(INPUT, { phase: 'turn_end' })
    work.onToolEvent(
      { ...INPUT, prompt: '再改一下' },
      start('edit', { path: 'a.md' }),
    )
    work.onToolEvent({ ...INPUT, prompt: '再改一下' }, { phase: 'turn_end' })
    expect(sent).toHaveLength(2)
    expect(sent[1]!.args.context).toEqual({
      skills: [],
      tools: [{ name: 'edit', count: 1 }],
      files: ['a.md'],
    })
  })
})
