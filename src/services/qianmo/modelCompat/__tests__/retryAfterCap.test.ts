// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * hermes #16 — the `Retry-After` bound follows the run mode (P18.12): 60 s in
 * the interactive REPL, 600 s for a session nobody is watching (resident ACP,
 * `-p`, SDK). And the main loop's ladder now reads `Retry-After` at all.
 *
 * Constructed errors and SSE; delays are injected where the ladder takes a
 * `delay`, and measured where it does not (one 1 s wait on the chat lane).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { getIsInteractive, setIsInteractive } from 'src/bootstrap/state.js'
import {
  OpenAIRequestError,
  retryAPIRequest,
} from 'src/services/api/openai/retry.js'
import { retryThirdPartyEventStream } from 'src/services/api/streamAssembly.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import {
  retryAfterCapMs,
  UNATTENDED_RETRY_AFTER_CAP_MS,
} from '../vendorBackoff.js'
import { captureOpenAIRequests } from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
const initialInteractive = getIsInteractive()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterEach(() => setIsInteractive(initialInteractive))
afterAll(() => settingsMock.reset())

function rateLimited(retryAfterSeconds: number): OpenAIRequestError {
  return new OpenAIRequestError('request failed (429)', {
    retryable: true,
    status: 429,
    retryAfterMs: retryAfterSeconds * 1000,
  })
}

/** retryAPIRequest against one 429 then success; the delays it asked for. */
async function requestLadder(retryAfterSeconds: number) {
  const delays: number[] = []
  let calls = 0
  const outcome = await retryAPIRequest(
    async () => {
      calls++
      if (calls === 1) throw rateLimited(retryAfterSeconds)
      return 'ok'
    },
    {
      signal: new AbortController().signal,
      delay: async ms => {
        delays.push(ms)
      },
      random: () => 0,
    },
  ).catch(() => 'gave up')
  return { outcome, delays, calls }
}

/** The main loop's ladder against one 429 then a stream; same report. */
async function streamLadder(retryAfterSeconds: number) {
  const delays: number[] = []
  let calls = 0
  try {
    for await (const _ of retryThirdPartyEventStream({
      signal: new AbortController().signal,
      maxRetries: 3,
      delay: async ms => {
        delays.push(ms)
      },
      create: async () => {
        calls++
        if (calls === 1) throw rateLimited(retryAfterSeconds)
        return (async function* () {
          yield { type: 'message_stop' } as BetaRawMessageStreamEvent
        })()
      },
    })) {
    }
    return { outcome: 'ok', delays, calls }
  } catch {
    return { outcome: 'gave up', delays, calls }
  }
}

describe('the bound by run mode', () => {
  test('interactive REPL: 60 s', () => {
    setIsInteractive(true)
    expect(retryAfterCapMs(60_000)).toBe(60_000)
  })

  test('unattended (ACP, -p, SDK): 600 s', () => {
    setIsInteractive(false)
    expect(retryAfterCapMs(60_000)).toBe(UNATTENDED_RETRY_AFTER_CAP_MS)
    expect(UNATTENDED_RETRY_AFTER_CAP_MS).toBe(600_000)
  })
})

describe('retryAPIRequest', () => {
  test('interactive: a 120 s Retry-After ends the ladder', async () => {
    setIsInteractive(true)
    expect(await requestLadder(120)).toEqual({
      outcome: 'gave up',
      delays: [],
      calls: 1,
    })
  })

  test('unattended: the same 120 s is waited out', async () => {
    setIsInteractive(false)
    expect(await requestLadder(120)).toEqual({
      outcome: 'ok',
      delays: [120_000],
      calls: 2,
    })
  })

  test('unattended: past 600 s still ends the ladder', async () => {
    setIsInteractive(false)
    expect((await requestLadder(601)).outcome).toBe('gave up')
  })
})

describe('retryThirdPartyEventStream (the main loop)', () => {
  test('reads Retry-After: waits 5 s, not its own 0.5 s first step', async () => {
    setIsInteractive(true)
    const { outcome, delays } = await streamLadder(5)
    expect(outcome).toBe('ok')
    expect(delays).toHaveLength(1)
    expect(delays[0]).toBe(5_000)
  })

  test('interactive: a 120 s Retry-After ends the turn', async () => {
    setIsInteractive(true)
    expect(await streamLadder(120)).toEqual({
      outcome: 'gave up',
      delays: [],
      calls: 1,
    })
  })

  test('unattended: the same 120 s is waited out', async () => {
    setIsInteractive(false)
    expect(await streamLadder(120)).toEqual({
      outcome: 'ok',
      delays: [120_000],
      calls: 2,
    })
  })
})

describe('chat lane, end to end', () => {
  test("the SDK's 429 Retry-After header reaches the main loop's wait", async () => {
    setIsInteractive(true)
    const started = Date.now()
    const requests = await captureOpenAIRequests({
      model: 'vendor-model-x',
      baseURL: 'https://gateway.example/v1',
      env: { OPENAI_WIRE_API: 'chat' },
      failFirst: [
        {
          status: 429,
          body: { error: { message: 'slow down', type: 'rate_limit' } },
          headers: { 'retry-after': '1' },
        },
      ],
    })
    expect(requests).toHaveLength(2)
    // The ladder's own first step is 500–625 ms; Retry-After says 1 s.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000)
  })
})
