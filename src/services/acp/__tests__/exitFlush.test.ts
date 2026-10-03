// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { createAcpExitGate } from '../exitFlush.js'

// The end-to-end property — a turn answered just before SIGTERM survives into
// the resumed session — is held by tests/integration/acp-exit-transcript.test.ts
// against a real `--acp` child. These pin the two properties that one cannot
// reach without a disk that refuses to finish: the budget, and that only the
// first trigger runs the shutdown.

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function recorder() {
  const exits: number[] = []
  const lines: string[] = []
  return {
    exits,
    lines,
    exit: (code: number) => {
      exits.push(code)
    },
    log: (line: string) => {
      lines.push(line)
    },
  }
}

describe('createAcpExitGate', () => {
  test('only the first trigger owns the shutdown', () => {
    const r = recorder()
    const gate = createAcpExitGate({ exit: r.exit, log: r.log, budgetMs: 10 })

    // SIGTERM, then the connection closing as the parent lets go of the pipe.
    expect(gate.begin()).toBe(true)
    expect(gate.begin()).toBe(false)
    expect(gate.begin()).toBe(false)
  })

  test('flush waits for the transcript queue to drain', async () => {
    const r = recorder()
    let drained = false
    const gate = createAcpExitGate({
      flush: async () => {
        await sleep(20)
        drained = true
      },
      exit: r.exit,
      log: r.log,
      budgetMs: 1_000,
    })

    gate.begin()
    await gate.flush()

    expect(drained).toBe(true)
    expect(r.lines).toEqual([])
  })

  test('a flush that never finishes still ends in exit 0 at the budget', async () => {
    const r = recorder()
    const gate = createAcpExitGate({
      flush: () => new Promise<void>(() => {}),
      exit: r.exit,
      log: r.log,
      budgetMs: 30,
    })

    gate.begin()
    void gate.flush()
    expect(r.exits).toEqual([])

    await sleep(120)
    // 0, not a failure code: the resident reads anything else as a crash.
    expect(r.exits).toEqual([0])
    expect(r.lines.join('\n')).toContain('did not finish within 30ms')
  })

  test('a flush that fails is reported and does not stop the exit', async () => {
    const r = recorder()
    const gate = createAcpExitGate({
      flush: async () => {
        throw new Error('ENOSPC: no space left on device')
      },
      exit: r.exit,
      log: r.log,
      budgetMs: 1_000,
    })

    gate.begin()
    await gate.flush()

    expect(r.lines.join('\n')).toContain('ENOSPC')
  })

  test('nothing is armed before a trigger arrives', async () => {
    const r = recorder()
    createAcpExitGate({ exit: r.exit, log: r.log, budgetMs: 10 })

    await sleep(50)
    expect(r.exits).toEqual([])
  })
})
