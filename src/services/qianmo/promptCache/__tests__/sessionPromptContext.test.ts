// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.19 CH-1: a session's prompt context survives a switch to another
 * session and a replaced process, and is refreshed by compaction.
 *
 * Driven through the real `activateAcpSessionWorkspace` and
 * `runInAcpWorkspaceTurn`; the memos are seeded directly so nothing reads a
 * real CLAUDE.md or git tree. The end-to-end version (a real `--acp` child and
 * the request bodies it sends) is `tests/integration/qianmo-prompt-cache.test.ts`.
 *
 * No mock.module: every module below loads on its own; isolation is a temp
 * config dir and `resetStateForTests`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { activateAcpSessionWorkspace, runInAcpWorkspaceTurn } = await import(
  '../../../acp/agent/sessionWorkspace.js'
)
const {
  getLastEmittedDate,
  getSystemPromptSectionCache,
  resetStateForTests,
  setLastEmittedDate,
  setSystemPromptSectionCacheEntry,
} = await import('../../../../bootstrap/state.js')
const { getSystemContext, getUserContext } = await import(
  '../../../../context.js'
)
const {
  parsePromptContextSidecar,
  PROMPT_CONTEXT_SIDECAR_NAME,
  resetPromptContextSnapshotsForTesting,
} = await import('../sessionPromptContext.js')
const {
  getPinnedPromptCacheKeys,
  resetPinnedPromptCacheKeysForTesting,
  restorePinnedPromptCacheKeys,
} = await import('../sessionCacheKey.js')

type Values = { [k: string]: string }
type Agent = { sessionId: string; cwd: string; projectDir: string }

let root: string
let A: Agent
let B: Agent
let savedSnapshotEnv: string | undefined
let savedPersistenceEnv: string | undefined

function agent(id: string, name: string): Agent {
  return {
    sessionId: id,
    cwd: join(root, 'ws', name),
    projectDir: join(root, 'config', 'projects', name),
  }
}

function seed(user: Values, system: Values, section: string, date: string) {
  getUserContext.cache.set(undefined, Promise.resolve(user))
  getSystemContext.cache.set(undefined, Promise.resolve(system))
  setSystemPromptSectionCacheEntry('env_info_simple', section)
  setLastEmittedDate(date)
}

async function memo(m: {
  cache: { has(k: unknown): boolean; get(k: unknown): unknown }
}): Promise<Values | undefined> {
  return m.cache.has(undefined)
    ? ((await m.cache.get(undefined)) as Values)
    : undefined
}

function sidecarOf(a: Agent): string {
  return join(a.projectDir, a.sessionId, PROMPT_CONTEXT_SIDECAR_NAME)
}

/** A workspace turn for `a`: what `prompt` does, minus the model. */
async function turn(a: Agent, during: () => void = () => {}): Promise<void> {
  await runInAcpWorkspaceTurn(async () => {
    activateAcpSessionWorkspace(a)
    during()
  })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'qm-prompt-context-')))
  A = agent('aaaaaaaa-0000-4000-8000-000000000001', 'agent-a')
  B = agent('bbbbbbbb-0000-4000-8000-000000000002', 'agent-b')
  savedSnapshotEnv = process.env.QIANMO_PROMPT_CONTEXT_SNAPSHOT
  delete process.env.QIANMO_PROMPT_CONTEXT_SNAPSHOT
  // The sidecar follows the transcript writer's rule, which keeps nothing on
  // disk under NODE_ENV=test without this opt-in.
  savedPersistenceEnv = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  resetPromptContextSnapshotsForTesting()
  resetPinnedPromptCacheKeysForTesting()
})

afterEach(() => {
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
  resetPromptContextSnapshotsForTesting()
  resetPinnedPromptCacheKeysForTesting()
  // activateAcpSessionWorkspace moved the process-global session into a temp
  // tree deleted below; see tests/mocks/state.ts.
  resetStateForTests()
  if (savedSnapshotEnv === undefined)
    delete process.env.QIANMO_PROMPT_CONTEXT_SNAPSHOT
  else process.env.QIANMO_PROMPT_CONTEXT_SNAPSHOT = savedSnapshotEnv
  if (savedPersistenceEnv === undefined)
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = savedPersistenceEnv
  rmSync(root, { recursive: true, force: true })
})

describe('per-session prompt context (CH-1)', () => {
  test('A → B → A: A gets back exactly its own context; B started fresh', async () => {
    await turn(A, () =>
      seed(
        { claudeMd: 'A rules', currentDate: 'd1' },
        { gitStatus: 'A st' },
        'A env',
        '2026-10-03',
      ),
    )
    await turn(B, () => {
      expect(getUserContext.cache.has(undefined)).toBe(false)
      expect(getSystemContext.cache.has(undefined)).toBe(false)
      expect(getSystemPromptSectionCache().size).toBe(0)
      expect(getLastEmittedDate()).toBeNull()
      seed(
        { claudeMd: 'B rules', currentDate: 'd2' },
        { gitStatus: 'B st' },
        'B env',
        '2026-10-04',
      )
    })
    await turn(A)
    expect(await memo(getUserContext)).toEqual({
      claudeMd: 'A rules',
      currentDate: 'd1',
    })
    expect(await memo(getSystemContext)).toEqual({ gitStatus: 'A st' })
    expect(getSystemPromptSectionCache().get('env_info_simple')).toBe('A env')
    expect(getLastEmittedDate()).toBe('2026-10-03')
    await turn(B)
    expect(await memo(getUserContext)).toEqual({
      claudeMd: 'B rules',
      currentDate: 'd2',
    })
    expect(getLastEmittedDate()).toBe('2026-10-04')
  })

  test('the same session reopened in another workspace starts fresh, from memory or disk', async () => {
    await turn(A, () =>
      seed({ claudeMd: 'A' }, { gitStatus: 'A' }, 'A env', 'd'),
    )
    await turn(B)
    const moved = { ...A, cwd: join(root, 'ws', 'elsewhere') }
    await turn(moved)
    expect(getUserContext.cache.has(undefined)).toBe(false)
    expect(getSystemPromptSectionCache().size).toBe(0)
    expect(getLastEmittedDate()).toBeNull()
  })

  test('QIANMO_PROMPT_CONTEXT_SNAPSHOT=0: back to A recomputes, as before P18.19', async () => {
    process.env.QIANMO_PROMPT_CONTEXT_SNAPSHOT = '0'
    await turn(A, () => seed({ claudeMd: 'A' }, { gitStatus: 'A' }, 'A', 'x'))
    await turn(B)
    await turn(A)
    expect(getUserContext.cache.has(undefined)).toBe(false)
    expect(getSystemContext.cache.has(undefined)).toBe(false)
  })

  test('each turn writes a 0600 sidecar; a new process resumes the session from it', async () => {
    restorePinnedPromptCacheKeys(A.sessionId, { 'gpt-6-luna': 'qm:p:pinned' })
    await turn(A, () =>
      seed(
        { claudeMd: 'A rules', currentDate: 'd1' },
        { gitStatus: 'A st' },
        'A env',
        '2026-10-03',
      ),
    )
    const path = sidecarOf(A)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      format: 1,
      sessionId: A.sessionId,
      cwd: A.cwd,
      userContext: { claudeMd: 'A rules', currentDate: 'd1' },
      systemContext: { gitStatus: 'A st' },
      lastEmittedDate: '2026-10-03',
      cacheKeys: { 'gpt-6-luna': 'qm:p:pinned' },
    })

    // A replaced child: nothing in memory, a different session current.
    await turn(B)
    resetPromptContextSnapshotsForTesting()
    resetPinnedPromptCacheKeysForTesting()
    getUserContext.cache.clear?.()
    getSystemContext.cache.clear?.()

    await turn(A)
    expect(await memo(getUserContext)).toEqual({
      claudeMd: 'A rules',
      currentDate: 'd1',
    })
    expect(await memo(getSystemContext)).toEqual({ gitStatus: 'A st' })
    expect(getLastEmittedDate()).toBe('2026-10-03')
    expect(getPinnedPromptCacheKeys(A.sessionId)).toEqual({
      'gpt-6-luna': 'qm:p:pinned',
    })
  })

  test('no sidecar when session persistence is off (same rule as the transcript)', async () => {
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    await turn(A, () => seed({ claudeMd: 'A' }, { gitStatus: 'A' }, 'env', 'd'))
    expect(() => statSync(sidecarOf(A))).toThrow()
  })

  test('compaction refreshes it: cleared memos are recomputed and the next turn records them', async () => {
    restorePinnedPromptCacheKeys(A.sessionId, { 'gpt-6-luna': 'qm:p:pinned' })
    await turn(A, () =>
      seed({ claudeMd: 'old' }, { gitStatus: 'old' }, 'env', 'd'),
    )
    await turn(A, () => {
      // what postCompactCleanup does, then the next turn's recompute
      getUserContext.cache.clear?.()
      getUserContext.cache.set(undefined, Promise.resolve({ claudeMd: 'new' }))
    })
    const written = JSON.parse(readFileSync(sidecarOf(A), 'utf8'))
    expect(written.userContext).toEqual({ claudeMd: 'new' })
    expect(written.cacheKeys).toEqual({ 'gpt-6-luna': 'qm:p:pinned' })
  })
})

describe('parsePromptContextSidecar', () => {
  // The same directory name, composed and decomposed.
  const composed = '/w/caf\u00e9'.normalize('NFC')
  const decomposed = composed.normalize('NFD')
  const good = {
    format: 1 as const,
    sessionId: 's',
    cwd: composed,
    userContext: { claudeMd: 'x' },
    lastEmittedDate: null,
    cacheKeys: {},
  }

  test('accepts its own session and cwd (NFC-insensitive)', () => {
    expect(decomposed).not.toBe(composed)
    expect(
      parsePromptContextSidecar(JSON.stringify(good), {
        sessionId: 's',
        cwd: decomposed,
      }),
    ).toEqual(good)
  })

  test('anything off is treated as no sidecar', () => {
    const at = { sessionId: 's', cwd: composed }
    for (const bad of [
      'not json',
      JSON.stringify({ ...good, format: 2 }),
      JSON.stringify({ ...good, sessionId: 'other' }),
      JSON.stringify({ ...good, cwd: '/elsewhere' }),
      JSON.stringify({ ...good, userContext: { claudeMd: 1 } }),
      JSON.stringify({ ...good, lastEmittedDate: 3 }),
      JSON.stringify({ ...good, cacheKeys: null }),
    ]) {
      expect(parsePromptContextSidecar(bad, at)).toBeUndefined()
    }
  })
})
