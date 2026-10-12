// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, mock, test } from 'bun:test'
import {
  OmpResidentTurnPort,
  parseTurnStepDedupKey,
  turnFailureKind,
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
