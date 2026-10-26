// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, mock, test } from 'bun:test'
import {
  OmpResidentTurnPort,
  parseTurnStepDedupKey,
  turnFailureKind,
  type ResidentToolEvent,
  type ResidentTurnProgress,
} from '../src/omp-turn.js'
import type {
  OmpRpcFrame,
  OmpRpcChannel,
  OmpPromptAdmission,
} from '../src/omp-rpc.js'
import { ResidentInactivityError } from '../src/inactivity.js'

const input = {
  sessionId: 'session-1',
  messageId: 'message-1',
  networkMsgId: 'network-1',
  prompt: 'hello',
}
function fixture(
  options: ConstructorParameters<typeof OmpResidentTurnPort>[1] = {},
) {
  const listeners = new Set<(frame: OmpRpcFrame) => void>()
  let admitted!: (value: OmpPromptAdmission) => void
  let closed!: () => void
  const channel: OmpRpcChannel = {
    prompt: mock(
      () =>
        new Promise<OmpPromptAdmission>(resolve => {
          admitted = resolve
        }),
    ),
    abort: mock(async () => {}),
    onFrame: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    closed: new Promise(resolve => {
      closed = resolve
    }),
  }
  const router = {
    channelFor: async () => channel,
    isAccepted: mock(async () => true),
  }
  return {
    channel,
    router,
    port: new OmpResidentTurnPort(router, options),
    close: () => closed(),
    admit: (agentInvoked = true, output?: string) =>
      admitted({ requestId: 'r-1', agentInvoked, output }),
    emit: (frame: OmpRpcFrame) => {
      for (const listener of listeners) listener(frame)
    },
  }
}
const user = {
  type: 'message_end',
  message: { role: 'user', content: 'hello' },
}
const assistant = (text: string, stopReason = 'stop') => ({
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text }], stopReason },
})
const complete = {
  type: 'prompt_result',
  id: 'r-1',
  status: 'completed',
  sessionSettled: true,
}
async function started(f: ReturnType<typeof fixture>) {
  await Promise.resolve()
  expect(f.channel.prompt).toHaveBeenCalled()
}

describe('omp resident turns', () => {
  test('acceptance is the user message event, while completion waits for matching prompt_result', async () => {
    const f = fixture()
    const accept = mock(async () => {})
    const result = f.port.execute(input, accept)
    await started(f)
    f.emit(user)
    await Promise.resolve()
    expect(accept).toHaveBeenCalledTimes(1)
    f.emit(user)
    await Promise.resolve()
    expect(accept).toHaveBeenCalledTimes(1)
    f.emit(assistant('answer'))
    f.emit({ ...complete, id: 'unrelated' })
    f.emit(complete) // completion is allowed to race the response
    f.admit()
    expect(await result).toEqual({ outcome: 'completed', content: 'answer' })
    expect(f.port.activeTurn(input.sessionId)).toBeUndefined()
    expect(await f.port.isAccepted(input)).toBe(true)
    expect(f.router.isAccepted).toHaveBeenCalledWith(
      input.sessionId,
      input.messageId,
    )
  })
  test('awaits durable read acknowledgement and propagates write errors', async () => {
    const f = fixture()
    const error = new Error('ledger disk full')
    const result = f.port.execute(input, async () => {
      throw error
    })
    await started(f)
    f.emit(user)
    f.emit(complete)
    f.admit()
    await expect(result).rejects.toThrow('ledger disk full')
  })
  test('user event does not acknowledge until the linked transcript identity is durable', async () => {
    const f = fixture()
    let persisted = false
    f.router.isAccepted.mockImplementation(async () => persisted)
    const accept = mock(async () => {})
    const result = f.port.execute(input, accept)
    await started(f)
    f.emit(user)
    f.emit(assistant('answer'))
    f.emit(complete)
    f.admit()
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(accept).not.toHaveBeenCalled()
    persisted = true
    expect(await result).toEqual({ outcome: 'completed', content: 'answer' })
    expect(accept).toHaveBeenCalledTimes(1)
  })
  test('local commands admit without waiting for a model event', async () => {
    const f = fixture()
    const accept = mock(async () => {})
    const result = f.port.execute(input, accept)
    await started(f)
    f.admit(false, 'model: fake')
    expect(await result).toEqual({
      outcome: 'completed',
      content: 'model: fake',
    })
    expect(accept).toHaveBeenCalledTimes(1)
  })
  test.each([
    'aborted',
    'error',
  ] as const)('%s is failed, never a successful empty answer', async status => {
    const f = fixture()
    const result = f.port.execute(input, async () => {})
    await started(f)
    f.emit({
      ...complete,
      status,
      error: { message: 'Model returned an empty response', httpStatus: 401 },
    })
    f.admit()
    const answer = await result
    expect(answer.outcome).toBe('failed')
    if (status === 'error' && answer.outcome === 'failed')
      expect(turnFailureKind(answer.reason)).toBe('model_empty_response')
  })
  test('stop aborts the running turn natively, found by its network message id', async () => {
    const f = fixture()
    expect(f.port.stop(input.networkMsgId)).toBe(false)
    const result = f.port.execute(input, async () => {})
    await started(f)
    expect(f.port.stop('network-other')).toBe(false)
    expect(f.port.stop(input.networkMsgId)).toBe(true)
    expect(f.channel.abort).toHaveBeenCalledTimes(1)
    f.emit({ ...complete, status: 'aborted' })
    f.admit()
    expect((await result).outcome).toBe('failed')
    expect(f.port.stop(input.networkMsgId)).toBe(false)
  })
  test('a turn the runtime compacted says so; an aborted, skipped or empty compaction, or none, says nothing', async () => {
    const run = async (frames: readonly OmpRpcFrame[]) => {
      const f = fixture()
      const result = f.port.execute(input, async () => {})
      await started(f)
      f.emit(user)
      for (const frame of frames) f.emit(frame)
      f.emit(assistant('answer'))
      f.emit(complete)
      f.admit()
      return await result
    }
    const compacted = {
      type: 'auto_compaction_end',
      action: 'context-full',
      aborted: false,
      willRetry: false,
      result: { summary: 'earlier turns' },
    }
    expect(await run([compacted])).toEqual({
      outcome: 'completed',
      content: 'answer',
      compacted: true,
    })
    // Claude Code and Codex, as their channels forward them.
    for (const subtype of ['compact_boundary', 'thread/compacted'])
      expect((await run([{ type: 'runtime_status', subtype }])).compacted).toBe(
        true,
      )
    for (const frames of [
      [],
      [{ ...compacted, aborted: true }],
      [{ ...compacted, skipped: true }],
      [{ ...compacted, result: undefined }],
      [{ type: 'auto_compaction_start', reason: 'threshold' }],
      [{ type: 'runtime_status', subtype: 'api_retry' }],
    ])
      expect(await run(frames)).toEqual({
        outcome: 'completed',
        content: 'answer',
      })
    // A failed turn carries it too: the summary replaced the context either way.
    const f = fixture()
    const failed = f.port.execute(input, async () => {})
    await started(f)
    f.emit(user)
    f.emit(compacted)
    f.emit({ ...complete, status: 'aborted' })
    f.admit()
    expect(await failed).toMatchObject({ outcome: 'failed', compacted: true })
  })
  test('empty and whitespace model replies fail; a successful tool-only turn remains valid', async () => {
    for (const body of ['', '   ']) {
      const f = fixture()
      const result = f.port.execute(input, async () => {})
      await started(f)
      f.emit(assistant(body))
      f.emit(complete)
      f.admit()
      const answer = await result
      expect(answer.outcome).toBe('failed')
      if (answer.outcome === 'failed')
        expect(turnFailureKind(answer.reason)).toBe('model_empty_response')
    }
    const f = fixture()
    const result = f.port.execute(input, async () => {})
    await started(f)
    f.emit({
      type: 'tool_execution_end',
      toolName: 'write',
      toolCallId: 'write-1',
      isError: false,
    })
    f.emit(assistant(''))
    f.emit(complete)
    f.admit()
    expect(await result).toEqual({ outcome: 'completed', content: '' })
  })
  test('a token ceiling and a dead child fail the turn', async () => {
    const f = fixture()
    const result = f.port.execute(input, async () => {})
    await started(f)
    f.emit(assistant('partial', 'length'))
    f.emit(complete)
    f.admit()
    expect((await result).outcome).toBe('failed')
    const next = fixture()
    const pending = next.port.execute(input, async () => {})
    await started(next)
    next.admit()
    next.close()
    await expect(pending).rejects.toThrow('exited')
  })
  test('watchdog aborts the child and retains the upstream credential diagnosis', async () => {
    const f = fixture({ inactivity: { timeoutMs: 20 } })
    const result = f.port.execute(input, async () => {})
    await started(f)
    f.admit()
    f.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        errorStatus: 401,
        errorMessage: 'credential rejected',
      },
    })
    await expect(result).rejects.toBeInstanceOf(ResidentInactivityError)
    expect(f.channel.abort).toHaveBeenCalledTimes(1)
  })
  test('progress uses actual tools, suppresses notify, deduplicates and budgets failures', async () => {
    const progress: ResidentTurnProgress[] = []
    const f = fixture({ onProgress: value => progress.push(value) })
    const result = f.port.execute(input, async () => {})
    await started(f)
    f.emit({
      type: 'tool_execution_start',
      toolName: 'qianmo_notify',
      toolCallId: 'notify',
    })
    for (let index = 0; index < 40; index++) {
      f.emit({
        type: 'tool_execution_start',
        toolName: 'read',
        toolCallId: `tool-${index}`,
        args: { path: '/work/a' },
      })
    }
    for (let index = 0; index < 12; index++) {
      f.emit({
        type: 'tool_execution_end',
        toolName: 'read',
        toolCallId: `tool-${index}`,
        isError: true,
      })
    }
    f.emit({
      type: 'tool_execution_end',
      toolName: 'read',
      toolCallId: 'tool-0',
      isError: true,
    })
    f.emit(complete)
    f.admit()
    await result
    expect(progress.filter(p => p.severity === 'info')).toHaveLength(24)
    expect(progress.filter(p => p.severity === 'warn')).toHaveLength(8)
    expect(new Set(progress.map(p => p.dedupKey)).size).toBe(progress.length)
    for (const p of progress)
      expect(parseTurnStepDedupKey(p.dedupKey)?.networkMsgId).toBe('network-1')
  })
  test('tool events carry raw starts and ends, then the turn end; a throwing hook does not fail the turn (P37.17 B)', async () => {
    const events: [string, ResidentToolEvent][] = []
    const f = fixture({
      onToolEvent: (turn, event) => {
        events.push([turn.messageId, event])
        if (event.phase === 'start') throw new Error('host bookkeeping')
      },
    })
    const result = f.port.execute(input, async () => {})
    await started(f)
    f.emit({
      type: 'tool_execution_start',
      toolName: 'todo',
      toolCallId: 't-1',
      args: { ops: [] },
    })
    f.emit({ type: 'tool_execution_start', toolName: 'read' })
    f.emit({
      type: 'tool_execution_end',
      toolName: 'todo',
      toolCallId: 't-1',
      result: { details: { phases: [] } },
    })
    f.emit({
      type: 'tool_execution_end',
      toolName: 'read',
      toolCallId: 'r-1',
      isError: true,
    })
    f.emit(assistant('done'))
    f.emit(complete)
    f.admit()
    expect(await result).toMatchObject({ outcome: 'completed' })
    expect(events).toEqual([
      [
        'message-1',
        {
          phase: 'start',
          toolCallId: 't-1',
          toolName: 'todo',
          args: { ops: [] },
        },
      ],
      [
        'message-1',
        {
          phase: 'end',
          toolCallId: 't-1',
          toolName: 'todo',
          isError: false,
          details: { phases: [] },
        },
      ],
      [
        'message-1',
        {
          phase: 'end',
          toolCallId: 'r-1',
          toolName: 'read',
          isError: true,
          details: undefined,
        },
      ],
      ['message-1', { phase: 'turn_end' }],
    ])
  })
})

test('only host-rendered memory answers retain citations and they are rechecked at terminal result', async () => {
  let live = true
  const f = fixture({
    memoryAnswer: () => ({
      ok: live,
      text: live ? 'host verified [source qm-mem-real]' : 'source revoked',
    }),
  })
  const pending = f.port.execute(
    { ...input, memoryIds: ['qm-mem-real'] },
    async () => {},
  )
  await started(f)
  expect(
    f.port.memoryAnswer(input.sessionId, {
      answer: 'draft',
      citations: ['qm-mem-real'],
    }).ok,
  ).toBe(true)
  f.emit(assistant('untrusted final qm-mem-forged'))
  f.emit(complete)
  f.admit()
  expect(await pending).toMatchObject({
    outcome: 'completed',
    content: 'host verified [source qm-mem-real]',
  })
  const again = f.port.execute(input, async () => {})
  await started(f)
  expect(f.port.memoryAnswer(input.sessionId, {}).ok).toBe(true)
  live = false
  f.emit(assistant('looks fine'))
  f.emit(complete)
  f.admit()
  expect(await again).toMatchObject({ outcome: 'failed' })
})

test('plain assistant text cannot manufacture memory source citations', async () => {
  const f = fixture()
  const pending = f.port.execute(input, async () => {})
  await started(f)
  f.emit(assistant('I cite qm-mem-forged'))
  f.emit(complete)
  f.admit()
  const result = await pending
  expect(result).toMatchObject({
    outcome: 'completed',
    content: 'I cite [unverified memory reference]',
  })
})

describe('steering a running turn (P38)', () => {
  /** Lets the admission callback and the port's bookkeeping run. */
  async function settleMicrotasks() {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  /** A turn that is running, its input durable, and its result watched. */
  async function runningTurn(steer?: OmpRpcChannel['steer']): Promise<{
    f: ReturnType<typeof fixture>
    result: Promise<unknown>
    ended: () => boolean
  }> {
    const f = fixture()
    if (steer !== undefined) f.channel.steer = steer
    let done = false
    const result = f.port.execute(input, async () => {})
    void result.finally(() => {
      done = true
    })
    await started(f)
    f.admit()
    f.emit(user)
    await settleMicrotasks()
    return { f, result, ended: () => done }
  }

  test('the text reaches the turn, and the turn ends with both prompts’ results in', async () => {
    const steer = mock(async () => ({ requestId: 's-1', agentInvoked: true }))
    const { f, result, ended } = await runningTurn(steer)
    expect(await f.port.steer('network-1', '再加一项')).toBe('steered')
    expect(steer).toHaveBeenCalledWith({ text: '再加一项' })
    f.emit(assistant('first part'))
    f.emit(complete)
    await settleMicrotasks()
    // The turn's own prompt yielded, but the steered one has not answered.
    expect(ended()).toBe(false)
    // Yielded: nothing more goes into it.
    expect(await f.port.steer('network-1', 'too late')).toBe('not_running')
    expect(steer).toHaveBeenCalledTimes(1)
    f.emit(assistant('second part'))
    f.emit({ ...complete, id: 's-1' })
    expect(await result).toEqual({
      outcome: 'completed',
      content: 'first part\n\nsecond part',
    })
  })

  test('a steer still on its way when the run yields holds the end until omp answered it', async () => {
    let admit!: (value: OmpPromptAdmission) => void
    const steer = mock(
      () =>
        new Promise<OmpPromptAdmission>(resolve => {
          admit = resolve
        }),
    )
    const { f, result, ended } = await runningTurn(steer)
    const steered = f.port.steer('network-1', '补充')
    await settleMicrotasks()
    f.emit(assistant('answer'))
    f.emit(complete)
    await settleMicrotasks()
    expect(ended()).toBe(false)
    // omp took it after the yield: it started the next run, which is this
    // turn's too.
    admit({ requestId: 's-2', agentInvoked: true })
    expect(await steered).toBe('steered')
    await settleMicrotasks()
    expect(ended()).toBe(false)
    f.emit(assistant('and the rest'))
    f.emit({ ...complete, id: 's-2' })
    expect(await result).toEqual({
      outcome: 'completed',
      content: 'answer\n\nand the rest',
    })
  })

  test('a refused steer does not hold the turn', async () => {
    const steer = mock(async (): Promise<OmpPromptAdmission> => {
      throw new Error('omp RPC request failed')
    })
    const { f, result } = await runningTurn(steer)
    expect(await f.port.steer('network-1', 'x')).toBe('not_running')
    f.emit(assistant('answer'))
    f.emit(complete)
    expect(await result).toEqual({ outcome: 'completed', content: 'answer' })
  })

  test('nothing to steer: another message, input not durable yet, or a runtime without a way in', async () => {
    const f = fixture()
    f.channel.steer = mock(async () => ({
      requestId: 's-1',
      agentInvoked: true,
    }))
    expect(await f.port.steer('network-1', 'x')).toBe('not_running')
    const result = f.port.execute(input, async () => {})
    await started(f)
    f.admit()
    // The user message has not reached the transcript yet.
    expect(await f.port.steer('network-1', 'x')).toBe('not_running')
    f.emit(user)
    await settleMicrotasks()
    expect(await f.port.steer('network-other', 'x')).toBe('not_running')
    expect(f.channel.steer).not.toHaveBeenCalled()
    f.emit(assistant('answer'))
    f.emit(complete)
    await result

    const external = await runningTurn()
    expect(await external.f.port.steer('network-1', 'x')).toBe('unsupported')
    external.f.emit(assistant('answer'))
    external.f.emit(complete)
    await external.result
  })
})
