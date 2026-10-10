// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { ompChildEnv } from '@qianmo/paths'
import {
  stageProviderApply,
  commitPendingProviderConfig,
  nodeModelSelection,
} from '../../src/providers/node.js'
import { computeEffectiveProviderState } from '../../src/providers/effective.js'
import { ompArgv } from '../../src/omp/launch.js'
import { applyRequest, CANARY_KEY } from './helpers.js'
import { fakeOpenAI, isolatedRoot } from './fake.js'
import { runAutocompact } from '../../src/commands/providerAutocompact.js'

test('compiled profile is used by a real isolated omp RPC child and matches effective state', async () => {
  const fixture = isolatedRoot()
  const server = fakeOpenAI()
  let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined
  try {
    expect(
      stageProviderApply(
        applyRequest({
          profile: {
            lane: 'openai-chat',
            baseUrl: server.baseUrl,
            compat: {},
            models: [
              {
                id: 'wire-model',
                role: 'main',
                tiers: ['sonnet'],
                capabilities: {
                  mode: 'explicit',
                  thinking: false,
                  adaptive_thinking: false,
                  interleaved_thinking: false,
                },
                effort: {
                  send: 'always',
                  levels: ['low', 'medium', 'high'],
                  level: 'high',
                },
                contextTokens: 128000,
                maxOutputTokens: 1024,
              },
            ],
          },
        }),
      ).ok,
    ).toBe(true)
    expect((await commitPendingProviderConfig()).status).toBe('committed')
    const selected = nodeModelSelection()!
    const frames: Record<string, unknown>[] = []
    child = Bun.spawn(
      ompArgv([
        '--mode',
        'rpc',
        '--no-ui',
        '--no-tools',
        '--no-extensions',
        '--no-skills',
        '--no-rules',
        '--no-title',
        '--model',
        `${selected.provider}/${selected.modelId}`,
        '--thinking',
        selected.thinkingLevel!,
      ]),
      {
        cwd: fixture.root,
        env: ompChildEnv(process.env),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const stderr = new Response(child.stderr).text()
    let complete!: () => void
    let fail!: (error: Error) => void
    const done = new Promise<void>((resolve, reject) => {
      complete = resolve
      fail = reject
    })
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    const reading = (async () => {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        pending += decoder.decode(chunk.value, { stream: true })
        let at: number
        while ((at = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, at)
          pending = pending.slice(at + 1)
          try {
            const frame = JSON.parse(line)
            frames.push(frame)
            if (frame.type === 'prompt_result') {
              if (frame.status === 'error')
                fail(new Error(JSON.stringify(frame)))
              else complete()
            }
          } catch {}
        }
      }
    })()
    child.stdin.write(
      JSON.stringify({
        id: 'open',
        type: 'open_session',
        sessionPath: join(fixture.root, 'sessions'),
        provider: selected.provider,
        modelId: selected.modelId,
      }) + '\n',
    )
    child.stdin.write(
      JSON.stringify({ id: 'prompt', type: 'prompt', message: 'Reply OK' }) +
        '\n',
    )
    const timer = setTimeout(
      () => fail(new Error('RPC prompt timed out')),
      20000,
    )
    try {
      await done
    } finally {
      clearTimeout(timer)
    }
    const request = server.requests[0]!
    expect(request).toBeDefined()
    expect(request.path).toBe('/v1/chat/completions')
    expect(request.headers.get('authorization')).toBe(`Bearer ${CANARY_KEY}`)
    expect(request.body.model).toBe('wire-model')
    expect(request.body.stream).toBe(true)
    expect(request.body.reasoning_effort).toBe('high')
    const effective = await computeEffectiveProviderState()
    expect(effective).toMatchObject({
      wire: 'openai-completions',
      model: 'wire-model',
      effortLevel: 'high',
      effortOnWire: true,
      contextTokens: 128000,
    })
    expect(frames.some(f => f.type === 'message_end')).toBe(true)
    child.kill()
    await child.exited
    await reading
    await stderr
    const compact = await runAutocompact({ value: '100000', json: true })
    expect(JSON.parse(compact.stdout)).toMatchObject({
      ok: true,
      autoCompactWindow: 100000,
      source: 'settings',
    })
    expect((await computeEffectiveProviderState()).autoCompactWindow).toBe(
      100000,
    )
  } finally {
    child?.kill()
    if (child) await child.exited
    server.stop()
    fixture.dispose()
  }
}, 30000)
