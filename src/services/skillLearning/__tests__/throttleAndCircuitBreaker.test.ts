/**
 * Unit tests for H5 (LLM call throttle), H6 (message watermark dedup),
 * and H7 (circuit breaker) improvements.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resetSkillLearningConfig,
  setSkillLearningConfigForTest,
} from '../config.js'
import {
  createLlmObserverBackendForTest,
  llmObserverBackend,
  resetCircuitBreaker,
} from '../llmObserverBackend.js'
import {
  resetRuntimeLLMBookkeeping,
  resetRuntimeObserverForTest,
  runSkillLearningPostSampling,
} from '../runtimeObserver.js'
import type { REPLHookContext } from '../../../utils/hooks/postSamplingHooks.js'
import {
  setActiveObserverBackend,
  getActiveObserverBackend,
  registerObserverBackend,
  type ObserverBackend,
} from '../observerBackend.js'
import type { StoredSkillObservation } from '../observationStore.js'
import type { AssistantMessage } from '../../../types/message.js'
import type { queryHaiku } from '../../api/claude.js'

let root: string
let previousCwd: string
const originalEnv = { ...process.env }
const originalBackendName = getActiveObserverBackend().name
type LlmObserverQuery = typeof queryHaiku

function haikuResponse(text: string): AssistantMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  } as unknown as AssistantMessage
}

function unavailableObserverQuery(): Promise<AssistantMessage> {
  return Promise.reject(new Error('No assistant message found'))
}

function makeCtx(
  messages: Array<{ uuid: string; content: string }>,
): REPLHookContext {
  return {
    querySource: 'repl_main_thread',
    messages: messages.map(({ uuid, content }) => ({
      type: 'user' as const,
      uuid: uuid as any,
      message: { role: 'user' as const, content },
    })),
    systemPrompt: [] as any,
    userContext: {},
    systemContext: {},
    toolUseContext: { agentId: undefined } as any,
  }
}

function make5Msgs(prefix: string): Array<{ uuid: string; content: string }> {
  return Array.from({ length: 5 }, (_, i) => ({
    uuid: `${prefix}-${i}`,
    content: '不要 mock，用 testing-library',
  }))
}

function makeObs(count: number): StoredSkillObservation[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `o${i}`,
    timestamp: new Date().toISOString(),
    event: 'user_message' as const,
    sessionId: 's1',
    projectId: 'p1',
    projectName: 'project',
    cwd: '/tmp',
    messageText: 'test message',
  }))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-throttle-test-'))
  previousCwd = process.cwd()
  process.chdir(root)
  process.env = { ...originalEnv }
  process.env.CLAUDE_SKILL_LEARNING_HOME = join(root, 'learning-home')
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.SKILL_LEARNING_ENABLED = '1'
  process.env.NODE_ENV = 'test'
  resetRuntimeObserverForTest()
  resetCircuitBreaker()
  setActiveObserverBackend(originalBackendName)
})

afterEach(() => {
  process.chdir(previousCwd)
  process.env = { ...originalEnv }
  resetSkillLearningConfig()
  rmSync(root, { recursive: true, force: true })
  resetRuntimeObserverForTest()
  resetCircuitBreaker()
  setActiveObserverBackend(originalBackendName)
})

// ---------------------------------------------------------------------------
// H5: LLM throttle — minimum observation count gate
// ---------------------------------------------------------------------------
describe('H5: LLM call throttle', () => {
  test('fewer than 5 observations routes to heuristic — LLM backend not called', async () => {
    let llmCallCount = 0
    const trackingBackend: ObserverBackend = {
      name: 'tracking-under5',
      analyze() {
        llmCallCount++
        return []
      },
    }
    registerObserverBackend(trackingBackend)
    setActiveObserverBackend('tracking-under5')

    // 3 messages → 3 observations, below the threshold of 5.
    await runSkillLearningPostSampling(
      makeCtx([
        { uuid: 'u5a', content: '不要 mock，用 testing-library' },
        { uuid: 'u5b', content: '不要 mock，用 testing-library' },
        { uuid: 'u5c', content: '不要 mock，用 testing-library' },
      ]),
    )

    expect(llmCallCount).toBe(0)
  })

  test('session cap: more calls than cap reaches heuristic fallback', async () => {
    // Cap at 1 call, cooldown 0ms.
    setSkillLearningConfigForTest({
      llm: { maxCallsPerSession: 1, cooldownMs: 0 },
    })

    let llmCallCount = 0
    const trackingBackend: ObserverBackend = {
      name: 'tracking-cap',
      analyze() {
        llmCallCount++
        return []
      },
    }
    registerObserverBackend(trackingBackend)
    setActiveObserverBackend('tracking-cap')

    // First call with 5 messages — reaches LLM.
    await runSkillLearningPostSampling(makeCtx(make5Msgs('cap1')))
    expect(llmCallCount).toBe(1)

    // Second call with 5 different messages — cap hit, must NOT reach LLM.
    await runSkillLearningPostSampling(makeCtx(make5Msgs('cap2')))
    expect(llmCallCount).toBe(1)
  })

  test('cooldown gate: second call within cooldown window skips LLM', async () => {
    // Very long cooldown — second call is always within window.
    setSkillLearningConfigForTest({
      llm: { cooldownMs: 999_999_000, maxCallsPerSession: 100 },
    })

    let llmCallCount = 0
    const trackingBackend: ObserverBackend = {
      name: 'tracking-cooldown',
      analyze() {
        llmCallCount++
        return []
      },
    }
    registerObserverBackend(trackingBackend)
    setActiveObserverBackend('tracking-cooldown')

    await runSkillLearningPostSampling(makeCtx(make5Msgs('cd1')))
    expect(llmCallCount).toBe(1)

    // Second call — still within 999999 second cooldown.
    await runSkillLearningPostSampling(makeCtx(make5Msgs('cd2')))
    expect(llmCallCount).toBe(1)
  })

  test('resetRuntimeLLMBookkeeping resets session counter and timestamps', async () => {
    setSkillLearningConfigForTest({
      llm: { maxCallsPerSession: 1, cooldownMs: 0 },
    })

    let llmCallCount = 0
    const trackingBackend: ObserverBackend = {
      name: 'tracking-reset',
      analyze() {
        llmCallCount++
        return []
      },
    }
    registerObserverBackend(trackingBackend)
    setActiveObserverBackend('tracking-reset')

    // First call reaches LLM; cap = 1, so second call is blocked.
    await runSkillLearningPostSampling(makeCtx(make5Msgs('rr1')))
    await runSkillLearningPostSampling(makeCtx(make5Msgs('rr2')))
    expect(llmCallCount).toBe(1)

    // After reset the counter clears — next call reaches LLM again.
    resetRuntimeLLMBookkeeping()
    await runSkillLearningPostSampling(makeCtx(make5Msgs('rr3')))
    expect(llmCallCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// H6: Message watermark dedup
// ---------------------------------------------------------------------------
describe('H6: message watermark dedup', () => {
  test('same message uuids are not re-processed in a subsequent call', async () => {
    // Use a backend that counts observations to detect dedup.
    let totalObservations = 0
    const countingBackend: ObserverBackend = {
      name: 'counting-dedup',
      analyze(observations) {
        totalObservations += observations.length
        return []
      },
    }
    registerObserverBackend(countingBackend)
    setActiveObserverBackend('counting-dedup')
    setSkillLearningConfigForTest({
      llm: { cooldownMs: 0, maxCallsPerSession: 100 },
    })

    const messages = make5Msgs('ded')

    // First call: 5 new message observations.
    await runSkillLearningPostSampling(makeCtx(messages))
    const afterFirst = totalObservations

    // Second call with SAME messages: all uuids already seen → 0 new
    // observations from messages. The early `if (observations.length === 0) return`
    // fires and the backend is never called.
    await runSkillLearningPostSampling(makeCtx(messages))
    const afterSecond = totalObservations

    expect(afterSecond).toBe(afterFirst)
  })

  test('different message uuids are always processed', async () => {
    let totalObservations = 0
    const countingBackend: ObserverBackend = {
      name: 'counting-dedup-new',
      analyze(observations) {
        totalObservations += observations.length
        return []
      },
    }
    registerObserverBackend(countingBackend)
    setActiveObserverBackend('counting-dedup-new')
    setSkillLearningConfigForTest({
      llm: { cooldownMs: 0, maxCallsPerSession: 100 },
    })

    await runSkillLearningPostSampling(makeCtx(make5Msgs('new1')))
    const afterFirst = totalObservations

    // Different uuids — all 5 new messages pass dedup.
    await runSkillLearningPostSampling(makeCtx(make5Msgs('new2')))
    expect(totalObservations).toBeGreaterThan(afterFirst)
  })

  test('resetRuntimeLLMBookkeeping clears dedup set — same uuids reprocessed', async () => {
    let totalObservations = 0
    const countingBackend: ObserverBackend = {
      name: 'counting-dedup-clr',
      analyze(observations) {
        totalObservations += observations.length
        return []
      },
    }
    registerObserverBackend(countingBackend)
    setActiveObserverBackend('counting-dedup-clr')
    setSkillLearningConfigForTest({
      llm: { cooldownMs: 0, maxCallsPerSession: 100 },
    })

    const messages = make5Msgs('clr')
    await runSkillLearningPostSampling(makeCtx(messages))
    const afterFirst = totalObservations

    // After reset, dedup set is cleared — same messages are reprocessed.
    resetRuntimeLLMBookkeeping()
    await runSkillLearningPostSampling(makeCtx(messages))
    expect(totalObservations).toBeGreaterThan(afterFirst)
  })
})

// ---------------------------------------------------------------------------
// H7: Circuit breaker (tests the llmObserverBackend state machine directly)
// ---------------------------------------------------------------------------
describe('H7: circuit breaker', () => {
  test('circuit opens after expected observer failures and skips later queries', async () => {
    resetCircuitBreaker()
    let calls = 0
    const query: LlmObserverQuery = async () => {
      calls++
      return await unavailableObserverQuery()
    }
    const backend = createLlmObserverBackendForTest(query)

    setSkillLearningConfigForTest({
      llm: { failureThreshold: 3, circuitCooldownMs: 60_000, timeoutMs: 50 },
    })

    const obs = makeObs(5)

    await backend.analyze(obs)
    await backend.analyze(obs)
    await backend.analyze(obs)
    expect(calls).toBe(3)

    await backend.analyze(obs)
    expect(calls).toBe(3)

    resetCircuitBreaker()
    const result = await backend.analyze(obs)
    expect(Array.isArray(result)).toBe(true)
    expect(calls).toBe(4)
  })

  test('circuit breaker env vars are respected', async () => {
    resetCircuitBreaker()
    let calls = 0
    const query: LlmObserverQuery = async () => {
      calls++
      return await unavailableObserverQuery()
    }
    const backend = createLlmObserverBackendForTest(query)

    setSkillLearningConfigForTest({
      llm: { failureThreshold: 1, circuitCooldownMs: 60_000, timeoutMs: 50 },
    })

    const obs = makeObs(5)

    await backend.analyze(obs)
    expect(calls).toBe(1)

    await backend.analyze(obs)
    expect(calls).toBe(1)

    resetCircuitBreaker()
    const result = await backend.analyze(obs)
    expect(Array.isArray(result)).toBe(true)
    expect(calls).toBe(2)
  })

  test('empty observations bypass circuit breaker entirely', async () => {
    resetCircuitBreaker()

    // Empty observations → short-circuit at top of analyseWithHaiku → []
    // regardless of circuit state.
    const result = await llmObserverBackend.analyze([])
    expect(result).toEqual([])
  })

  test('resetCircuitBreaker resets state to closed', async () => {
    resetCircuitBreaker()
    setSkillLearningConfigForTest({ llm: { timeoutMs: 50 } })

    // After reset, the backend is in clean state. Calling it with observations
    // returns an array (either LLM result or heuristic fallback).
    const result = await llmObserverBackend.analyze(makeObs(3))
    expect(Array.isArray(result)).toBe(true)

    resetCircuitBreaker()
    const result2 = await llmObserverBackend.analyze(makeObs(3))
    expect(Array.isArray(result2)).toBe(true)
  })

  test('test query injection stays offline despite credentials, cwd, and VCR record pollution', async () => {
    const fixtureRoot = join(root, 'fixtures-root')
    process.env.ANTHROPIC_API_KEY = 'ambient-test-credential'
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixtureRoot
    process.env.FORCE_VCR = '1'
    process.env.USER_TYPE = 'ant'
    process.env.VCR_RECORD = '1'

    let calls = 0
    const query: LlmObserverQuery = async () => {
      calls++
      return haikuResponse('[]')
    }
    const backend = createLlmObserverBackendForTest(query)

    await backend.analyze(makeObs(5))

    expect(calls).toBe(1)
    expect(existsSync(fixtureRoot)).toBe(false)
  })

  test('default test backend fails closed despite VCR record pollution', async () => {
    const fixtureRoot = join(root, 'default-fixtures-root')
    process.env.ANTHROPIC_API_KEY = 'ambient-test-credential'
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixtureRoot
    process.env.FORCE_VCR = '1'
    process.env.USER_TYPE = 'ant'
    process.env.VCR_RECORD = '1'

    await llmObserverBackend.analyze(makeObs(5))

    expect(existsSync(fixtureRoot)).toBe(false)
  })

  test('unexpected VCR or infrastructure errors propagate instead of falling back', async () => {
    const fixtureFailure = new Error('Anthropic API fixture missing: corrupt')
    const query: LlmObserverQuery = async () => {
      throw fixtureFailure
    }
    const backend = createLlmObserverBackendForTest(query)

    await expect(backend.analyze(makeObs(5))).rejects.toBe(fixtureFailure)
  })
})
