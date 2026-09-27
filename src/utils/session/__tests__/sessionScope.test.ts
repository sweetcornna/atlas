// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Task notifications stay with the ACP session whose work produced them
 * (review E-8). The end-to-end case — a real `--acp` child, a background
 * command in one session, another session's turn — is
 * `tests/integration/qianmo-resident-bypass-corpus.test.ts`; this file pins the
 * queue rule itself, including the shapes that one child cannot easily stage.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  enqueuePendingNotification,
  getCommandsByMaxPriority,
  resetCommandQueue,
} from '../messageQueueManager.js'
import { currentSessionScope, runInSessionScope } from '../sessionScope.js'

function notice(value: string): void {
  enqueuePendingNotification({
    value,
    mode: 'task-notification',
    priority: 'next',
  })
}

function drained(): string[] {
  return getCommandsByMaxPriority('next').map(cmd => String(cmd.value))
}

beforeEach(() => resetCommandQueue())
afterEach(() => resetCommandQueue())

describe('task notifications are scoped to the ACP session that caused them', () => {
  test("another session's drain does not see it; its own does", () => {
    runInSessionScope('session-a', () => notice('from-a'))

    expect(runInSessionScope('session-b', drained)).toEqual([])
    expect(runInSessionScope('session-a', drained)).toEqual(['from-a'])
  })

  test('outside every session, a scoped notice is not handed out', () => {
    // Every ACP drain runs inside a turn's scope. A reader with no scope at
    // all has no claim to another session's result.
    runInSessionScope('session-a', () => notice('from-a'))
    expect(drained()).toEqual([])
  })

  test('an unscoped notice is visible everywhere, as before', () => {
    // REPL and print mode never enter a scope: their queue must not change.
    notice('unscoped')
    expect(drained()).toEqual(['unscoped'])
    expect(runInSessionScope('session-b', drained)).toEqual(['unscoped'])
  })

  test('work that finishes during another turn still reports its own session', async () => {
    // The E-8 shape: a continuation registered in A's turn fires while B's
    // turn is the one running.
    let finish: () => void = () => {}
    const work = new Promise<void>(resolve => {
      finish = resolve
    })
    const posted = runInSessionScope('session-a', () =>
      work.then(() => notice('late-from-a')),
    )

    await runInSessionScope('session-b', async () => {
      expect(currentSessionScope()).toBe('session-b')
      finish()
      await posted
      expect(drained()).toEqual([])
    })
    expect(runInSessionScope('session-a', drained)).toEqual(['late-from-a'])
  })

  test('entering a scope always opens a new boundary', () => {
    // A turn woken by the previous turn's release starts in that turn's
    // context; the scope it enters must replace it, not nest under it.
    const seen = runInSessionScope('session-a', () =>
      runInSessionScope('session-b', () => currentSessionScope()),
    )
    expect(seen).toBe('session-b')
    expect(currentSessionScope()).toBeUndefined()
  })
})
