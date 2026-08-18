/**
 * Failure-path observability for the LLM observer backend.
 *
 * The backend's contract is "an LLM failure must never destabilise skill
 * learning": every failure returns the heuristic fallback and never throws.
 * These tests pin that contract AND the logging layered on top of it, so the
 * two failure branches stay distinguishable:
 *
 *   - queryHaiku threw  → logForDebugging + logError. Infrastructure breakage
 *     (a read-only FS during a VCR recording run, a missing API fixture in CI)
 *     must reach the error channel instead of silently degrading to heuristics.
 *   - output unparseable → logForDebugging only. No Error object exists there,
 *     so none is fabricated and the error channel stays clean.
 *
 * Why `logError` is observed through a shared module mock rather than through
 * `getInMemoryErrors()`: ~20 test files install `tests/mocks/log.ts`'s
 * `logMock` at module load with no reset, and Bun's `mock.module` is
 * process-global and last-write-wins. In a full-shard run whichever of them
 * loads first turns `logError` into a no-op and `getInMemoryErrors()` into
 * `() => []` for every file after it, so the in-memory ring reports nothing
 * (verified: the ring-based version of these tests passed alone and failed
 * under `bun test`). This file's own complete-surface delegating mock is
 * order-independent, and `reset()` in `afterAll` keeps it from leaking to
 * later files.
 *
 * `logForDebugging` is deliberately not asserted on: it is silently dropped
 * whenever NODE_ENV=test (utils/telemetry/debug.ts), so there is nothing to
 * observe.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupApiClaudeMock } from '../../../../tests/mocks/apiClaude.js'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'
import * as realLog from '../../../utils/telemetry/log.js'

// Both mocks must be installed before the module under test is imported so the
// ESM import bindings pick up the stubs.
const haikuCalls: Array<{ userPrompt: string }> = []
let haikuResponder: () => Promise<unknown> = async () => ({
  message: { content: [{ type: 'text', text: '[]' }] },
})

type HaikuResult = Awaited<
  ReturnType<typeof import('../../api/claude.js').queryHaiku>
>

const apiClaudeMock = setupApiClaudeMock({
  queryHaiku: async args => {
    haikuCalls.push({ userPrompt: args.userPrompt })
    return (await haikuResponder()) as HaikuResult
  },
})

const loggedErrors: unknown[] = []
const logMock = makeSharedModuleMock(
  'src/utils/telemetry/log.ts',
  realLog,
).setup({
  logError: (error: unknown) => {
    loggedErrors.push(error)
  },
})

afterAll(() => {
  apiClaudeMock.reset()
  logMock.reset()
})

import {
  resetSkillLearningConfig,
  setSkillLearningConfigForTest,
} from '../config.js'
import {
  llmObserverBackend,
  resetCircuitBreaker,
} from '../llmObserverBackend.js'
import type { StoredSkillObservation } from '../observationStore.js'

const originalEnv = { ...process.env }
let root: string

function makeObs(count: number): StoredSkillObservation[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `obs-${i}`,
    timestamp: new Date().toISOString(),
    event: 'user_message' as const,
    sessionId: 's-llm-observer',
    projectId: 'p1',
    projectName: 'project',
    cwd: '/tmp',
    messageText: 'test message',
  }))
}

function loggedMessages(): string[] {
  return loggedErrors.map(error =>
    error instanceof Error ? error.message : String(error),
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'llm-observer-test-'))
  process.env = { ...originalEnv }
  process.env.CLAUDE_SKILL_LEARNING_HOME = join(root, 'learning-home')
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.NODE_ENV = 'test'

  // The mocked queryHaiku resolves immediately, but the abort signal is armed
  // before the call — keep it well under the test budget.
  setSkillLearningConfigForTest({
    llm: { timeoutMs: 50, failureThreshold: 3, circuitCooldownMs: 60_000 },
  })

  haikuCalls.length = 0
  loggedErrors.length = 0
  haikuResponder = async () => ({
    message: { content: [{ type: 'text', text: '[]' }] },
  })
  resetCircuitBreaker()
})

afterEach(() => {
  process.env = { ...originalEnv }
  resetSkillLearningConfig()
  resetCircuitBreaker()
  haikuCalls.length = 0
  loggedErrors.length = 0
  rmSync(root, { recursive: true, force: true })
})

describe('llmObserverBackend — queryHaiku failure path', () => {
  test('infrastructure error is logged and still falls back without throwing', async () => {
    haikuResponder = async () => {
      throw new Error("EROFS: read-only file system, mkdir '/mock'")
    }

    const result = await llmObserverBackend.analyze(makeObs(5))

    // Fallback semantics unchanged: no throw, array result.
    expect(Array.isArray(result)).toBe(true)
    // The failure really came from queryHaiku, not from an earlier gate.
    expect(haikuCalls.length).toBe(1)
    // logError ran — the reason is recoverable from the error channel.
    expect(loggedErrors.length).toBe(1)
    expect(loggedMessages()[0]).toContain('EROFS')
  })

  test('the logged reason distinguishes infrastructure failure from API failure', async () => {
    haikuResponder = async () => {
      throw new Error('Anthropic API fixture missing')
    }

    await llmObserverBackend.analyze(makeObs(5))

    expect(loggedMessages()).toEqual(['Anthropic API fixture missing'])
  })
})

describe('llmObserverBackend — unparseable output path', () => {
  test('non-JSON output falls back without touching the error channel', async () => {
    haikuResponder = async () => ({
      message: { content: [{ type: 'text', text: 'no json here' }] },
    })

    const result = await llmObserverBackend.analyze(makeObs(5))

    expect(Array.isArray(result)).toBe(true)
    expect(haikuCalls.length).toBe(1)
    // Debug-only branch: no Error object exists, so none is fabricated.
    expect(loggedErrors).toEqual([])
  })

  test('empty candidate list from valid JSON also stays off the error channel', async () => {
    haikuResponder = async () => ({
      message: { content: [{ type: 'text', text: '[]' }] },
    })

    const result = await llmObserverBackend.analyze(makeObs(5))

    expect(Array.isArray(result)).toBe(true)
    expect(loggedErrors).toEqual([])
  })
})
