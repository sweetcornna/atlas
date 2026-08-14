// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { describe, expect, test } from 'bun:test'
import { NodeTurnGate } from '../src/turn-gate.js'

describe('node turn gate', () => {
  test('serializes turns across different sessions in arrival order', async () => {
    const gate = new NodeTurnGate()
    const events: string[] = []
    let releaseFirst!: () => void

    const first = gate.run(async () => {
      events.push('a:start')
      await new Promise<void>(resolve => {
        releaseFirst = resolve
      })
      events.push('a:end')
    })
    const second = gate.run(async () => {
      events.push('b:start')
      events.push('b:end')
    })

    await Promise.resolve()
    expect(events).toEqual(['a:start'])
    expect(gate.active).toBe(true)
    expect(gate.queued).toBe(1)

    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
    expect(gate.active).toBe(false)
  })

  test('a failed turn still releases the next one', async () => {
    const gate = new NodeTurnGate()
    const first = gate.run(async () => {
      throw new Error('turn failed')
    })
    const second = gate.run(async () => 'next')

    await expect(first).rejects.toThrow('turn failed')
    await expect(second).resolves.toBe('next')
  })
})
