// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Run by `sessionScope.test.ts` in its own `bun test` process: the command
 * queue and bootstrap state both have process-global `mock.module`
 * registrations in the main suite (`tests/mocks/messageQueueManager.ts`,
 * `tests/mocks/state.ts`), and the task-framework suites replace
 * `enqueuePendingNotification` with a no-op there. These checks need the real
 * modules, so they load them in a fresh module registry.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { getOriginalCwd, setOriginalCwd } from '../../../bootstrap/state.js'
import { getProjectTempDir } from '../../permissions/filesystem.js'
import { getTaskOutputDir } from '../../task/diskOutput.js'
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
})

describe('task output files are kept per ACP session', () => {
  test("each session's outputs go under its own project temp directory, and stay there", () => {
    // Before this, the first session to start a task fixed the directory for
    // the whole process: every other agent's output landed in the first
    // agent's project temp directory, readable there without asking, and the
    // owner could not read its own file.
    const saved = getOriginalCwd()
    try {
      setOriginalCwd('/srv/qm-scope-test/agent-one')
      const tempOne = getProjectTempDir()
      const dirOne = runInSessionScope('scope-test-one', getTaskOutputDir)

      setOriginalCwd('/srv/qm-scope-test/agent-two')
      const tempTwo = getProjectTempDir()
      const dirTwo = runInSessionScope('scope-test-two', getTaskOutputDir)

      expect(tempOne).not.toBe(tempTwo)
      expect(dirOne).toBe(join(tempOne, 'scope-test-one', 'tasks'))
      expect(dirTwo).toBe(join(tempTwo, 'scope-test-two', 'tasks'))
      // Session one's work finishing while session two is current still
      // names session one's files.
      expect(runInSessionScope('scope-test-one', getTaskOutputDir)).toBe(dirOne)
    } finally {
      setOriginalCwd(saved)
    }
  })
})
