// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * hermes #17 — Z.AI Coding Plan GLM-5.2 overload: three short retries, then
 * 30 / 60 / 90 / 120 s, seven retries in all (P18.12).
 *
 * The 429 body is constructed in the shape hermes describes
 * (`agent/retry_utils.py:21-24`, `:143-159`: HTTP 429, code 1305, "The
 * service may be temporarily overloaded"); the SDK case runs it through the
 * real OpenAI SDK against a local stub. No vendor was called.
 */
import { describe, expect, test } from 'bun:test'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import OpenAI from 'openai'
import { OpenAIRequestError } from 'src/services/api/openai/retry.js'
import { classifyRetryableAPIError } from 'src/services/api/retryClassification.js'
import { retryThirdPartyEventStream } from 'src/services/api/streamAssembly.js'
import {
  isZaiCodingOverload,
  ZAI_OVERLOAD_MAX_RETRIES,
  zaiOverloadWait,
} from '../vendorBackoff.js'

const ZAI = {
  model: 'glm-5.2',
  baseURL: 'https://api.z.ai/api/coding/paas/v4',
}
const BODY = {
  error: {
    code: '1305',
    message:
      'The service may be temporarily overloaded, please try again later',
  },
}

function overload(status = 429, body: unknown = BODY.error) {
  return new OpenAIRequestError(`request failed (${status})`, {
    retryable: true,
    status,
    cause: body,
  })
}

describe('isZaiCodingOverload — hermes is_zai_coding_overload_error', () => {
  test('429 + 1305 on the coding endpoint for GLM-5.2', () => {
    expect(isZaiCodingOverload(overload(), ZAI)).toBe(true)
    expect(
      isZaiCodingOverload(
        overload(429, { message: 'temporarily overloaded' }),
        ZAI,
      ),
    ).toBe(true)
  })

  test.each([
    ['another model', { ...ZAI, model: 'glm-5.1' }, overload()],
    [
      'the general endpoint',
      { ...ZAI, baseURL: 'https://api.z.ai/api/paas/v4' },
      overload(),
    ],
    [
      'the China endpoint',
      { ...ZAI, baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' },
      overload(),
    ],
    ['a 503 with the same text', ZAI, overload(503)],
    [
      'a quota 429',
      ZAI,
      overload(429, { code: '1113', message: 'Insufficient balance' }),
    ],
  ] as const)('not for %s', (_label, target, error) => {
    expect(isZaiCodingOverload(error, target)).toBe(false)
  })

  test("the OpenAI SDK's own 429 error carries what the rule reads", async () => {
    const client = new OpenAI({
      apiKey: 'sk-test-canary-p1812-zai',
      baseURL: ZAI.baseURL,
      maxRetries: 0,
      fetch: (async () =>
        new Response(JSON.stringify(BODY), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    })
    const error = await client.chat.completions
      .create({ model: ZAI.model, messages: [{ role: 'user', content: 'q' }] })
      .catch((caught: unknown) => caught)
    expect(isZaiCodingOverload(error, ZAI)).toBe(true)
    // And the ladder retries it at all (not read as a quota wall).
    expect(classifyRetryableAPIError(error).retryable).toBe(true)
  })
})

describe('zaiOverloadWait — the schedule', () => {
  test('3 short, then 30/60/90/120 s, then give up', () => {
    const at = (retry: number, random = 0) =>
      zaiOverloadWait(overload(), retry, 777, ZAI, () => random)
    expect([1, 2, 3].map(retry => at(retry))).toEqual([
      { giveUp: false, delayMs: 777 },
      { giveUp: false, delayMs: 777 },
      { giveUp: false, delayMs: 777 },
    ])
    expect([4, 5, 6, 7].map(retry => at(retry))).toEqual(
      [30_000, 60_000, 90_000, 120_000].map(delayMs => ({
        giveUp: false,
        delayMs,
      })),
    )
    // Jitter: up to 20 % on top.
    expect(at(4, 1)).toEqual({ giveUp: false, delayMs: 36_000 })
    expect(ZAI_OVERLOAD_MAX_RETRIES).toBe(7)
    expect(at(8)).toEqual({ giveUp: true })
  })

  test('anything else: undefined, the caller keeps its backoff', () => {
    expect(zaiOverloadWait(overload(503), 5, 777, ZAI)).toBeUndefined()
    expect(zaiOverloadWait(overload(), 5, 777, undefined)).toBeUndefined()
  })
})

describe('the main loop ladder', () => {
  async function run(target: typeof ZAI | undefined) {
    const delays: number[] = []
    let attempts = 0
    let thrown: unknown
    try {
      for await (const _ of retryThirdPartyEventStream({
        signal: new AbortController().signal,
        maxRetries: 10,
        delay: async ms => {
          delays.push(ms)
        },
        backoffTarget: target,
        create: async (): Promise<AsyncIterable<BetaRawMessageStreamEvent>> => {
          attempts++
          throw overload()
        },
      })) {
      }
    } catch (error) {
      thrown = error
    }
    return { delays, attempts, thrown }
  }

  test('Z.AI coding overload: 7 retries, the last four long', async () => {
    const { delays, attempts, thrown } = await run(ZAI)
    expect(attempts).toBe(8)
    expect(thrown).toBeInstanceOf(OpenAIRequestError)
    expect(delays).toHaveLength(7)
    // The ladder's own first three steps: 500 ms, 1 s, 2 s (+ ≤25 %).
    expect(delays.slice(0, 3).every(ms => ms < 3_000)).toBe(true)
    const long = delays.slice(3)
    for (const [i, baseMs] of [30_000, 60_000, 90_000, 120_000].entries()) {
      expect(long[i]).toBeGreaterThanOrEqual(baseMs)
      expect(long[i]).toBeLessThanOrEqual(baseMs * 1.2)
    }
  })

  test('the same error on another endpoint keeps the ladder: 10 retries', async () => {
    const { delays, attempts } = await run({
      ...ZAI,
      baseURL: 'https://gateway.example/v1',
    })
    expect(attempts).toBe(11)
    expect(Math.max(...delays)).toBeLessThanOrEqual(40_000)
  })
})
