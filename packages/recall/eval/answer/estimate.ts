// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The dry run: how many calls and tokens a plan would take, computed offline
 * from the real corpora and the real prompt, so the owner can set the cap
 * before anything is spent.
 *
 * The request of every first-round call is built exactly as a run would
 * build it (M0 retrieval, `buildRecallSystemPrompt`, the question as the one
 * user message) and handed to `measure`, which the command line supplies: it
 * turns the request into the wire body with the base's adapter chain and
 * returns the text the model would read. Characters are then converted with
 * the design's ranges (`docs/dev/memory-m1.md` §10): CJK 0.7–1 token per
 * character, anything else 2.5–4 characters per token; output 300–2 000
 * tokens per call.
 *
 * Not counted, and said so in the result: second rounds after a rejection
 * (they happen only for rejected answers, which is exactly what is not yet
 * known) and retries (the design adds a 20 % margin for those). The M1 arm is
 * estimated with M0's prompt: both fill the same injection budget.
 */

import { buildRecallSystemPrompt } from '../../src/inject.js'
import type { CorpusId } from '../corpora.js'
import { ANSWER_TOKEN_CEILING } from './ledger.js'
import { type AnswerPlan, m0Retriever, prepareTier } from './runner.js'
import type { AnswerRequest, TokenUsage } from './types.js'

type CharCount = { readonly cjk: number; readonly other: number }

type TokenRange = { readonly low: number; readonly high: number }

/** §10's conversion ranges. */
const ESTIMATE_RATES = {
  cjkTokensPerChar: { low: 0.7, high: 1 },
  otherCharsPerToken: { low: 4, high: 2.5 },
  outputTokensPerCall: { low: 300, high: 2000 },
  retryMargin: 0.2,
} as const

/** D-7 as approved: the reference the estimate is compared with. */
const APPROVED_BUDGET = {
  calls: { low: 2100, high: 2400 },
  input: { low: 12_000_000, high: 18_500_000 },
  output: { low: 700_000, high: 4_800_000 },
} as const

const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u

function countChars(text: string): CharCount {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK.test(char)) cjk += 1
    else other += 1
  }
  return { cjk, other }
}

function inputTokens(chars: CharCount): TokenRange {
  const { cjkTokensPerChar: cjk, otherCharsPerToken: other } = ESTIMATE_RATES
  return {
    low: Math.round(chars.cjk * cjk.low + chars.other / other.low),
    high: Math.round(chars.cjk * cjk.high + chars.other / other.high),
  }
}

type EstimateRow = {
  readonly corpus: string
  readonly tier: number
  readonly kind: string
  readonly questions: number
  readonly calls: number
  readonly input: TokenRange
  readonly output: TokenRange
}

export type AnswerEstimate = {
  readonly plan: {
    readonly corpora: AnswerPlan['corpora']
    readonly repetitions: number
    readonly arms: AnswerPlan['arms']
    readonly providers: readonly string[]
  }
  readonly rows: readonly EstimateRow[]
  readonly total: {
    readonly calls: number
    readonly input: TokenRange
    readonly output: TokenRange
  }
  /** Total plus the design's 20 % retry margin. */
  readonly withMargin: {
    readonly calls: number
    readonly input: TokenRange
    readonly output: TokenRange
  }
  readonly approved: typeof APPROVED_BUDGET
  readonly ceiling: TokenUsage
  /** How many calls of this plan's average size fit under the ceiling. */
  readonly callsUnderCeiling: TokenRange
  readonly notCounted: readonly string[]
}

const add = (a: TokenRange, b: TokenRange): TokenRange => ({
  low: a.low + b.low,
  high: a.high + b.high,
})

/**
 * Estimate a plan.
 *
 * @param measure the model-visible text of a request as sent to `provider`.
 */
export async function estimateAnswerPlan(
  plan: Pick<AnswerPlan, 'corpora' | 'repetitions' | 'arms' | 'queryIds'>,
  providers: readonly string[],
  measure: (request: AnswerRequest, provider: string) => string,
): Promise<AnswerEstimate> {
  const rows = new Map<string, EstimateRow>()
  const perQuestion = plan.repetitions * plan.arms.length
  const { outputTokensPerCall } = ESTIMATE_RATES
  for (const { id, tiers } of plan.corpora) {
    for (const tier of tiers) {
      const prepared = await prepareTier(
        id as CorpusId,
        tier,
        { arms: ['m0'], queryIds: plan.queryIds },
        { m0: m0Retriever },
      )
      try {
        for (const { query, results } of prepared.queries.values()) {
          const result = results.m0
          if (result === undefined) throw new Error('estimate: no M0 result')
          const system = buildRecallSystemPrompt(result)
          const key = JSON.stringify([id, tier, query.kind])
          const row = rows.get(key) ?? {
            corpus: id,
            tier,
            kind: query.kind,
            questions: 0,
            calls: 0,
            input: { low: 0, high: 0 },
            output: { low: 0, high: 0 },
          }
          let input: TokenRange = { low: 0, high: 0 }
          for (const provider of providers) {
            const tokens = inputTokens(
              countChars(
                measure(
                  {
                    callKey: `estimate/${id}/${tier}/${query.id}/${provider}`,
                    system,
                    turns: [{ role: 'user', text: query.question }],
                  },
                  provider,
                ),
              ),
            )
            input = add(input, {
              low: tokens.low * perQuestion,
              high: tokens.high * perQuestion,
            })
          }
          const calls = providers.length * perQuestion
          rows.set(key, {
            ...row,
            questions: row.questions + 1,
            calls: row.calls + calls,
            input: add(row.input, input),
            output: add(row.output, {
              low: calls * outputTokensPerCall.low,
              high: calls * outputTokensPerCall.high,
            }),
          })
        }
      } finally {
        prepared.materialised.dispose()
      }
    }
  }
  const list = [...rows.values()]
  const total = list.reduce(
    (acc, row) => ({
      calls: acc.calls + row.calls,
      input: add(acc.input, row.input),
      output: add(acc.output, row.output),
    }),
    { calls: 0, input: { low: 0, high: 0 }, output: { low: 0, high: 0 } },
  )
  const margin = 1 + ESTIMATE_RATES.retryMargin
  const scale = (range: TokenRange): TokenRange => ({
    low: Math.round(range.low * margin),
    high: Math.round(range.high * margin),
  })
  const fit = (perCall: number, ceiling: number) =>
    perCall === 0 ? Number.POSITIVE_INFINITY : Math.floor(ceiling / perCall)
  const perCall = (value: number) =>
    total.calls === 0 ? 0 : value / total.calls
  return {
    plan: {
      corpora: plan.corpora,
      repetitions: plan.repetitions,
      arms: plan.arms,
      providers,
    },
    rows: list,
    total,
    withMargin: {
      calls: Math.ceil(total.calls * margin),
      input: scale(total.input),
      output: scale(total.output),
    },
    approved: APPROVED_BUDGET,
    ceiling: ANSWER_TOKEN_CEILING,
    callsUnderCeiling: {
      // Few calls fit when each is large: `low` uses the high per-call rates.
      low: Math.min(
        fit(perCall(total.input.high), ANSWER_TOKEN_CEILING.input),
        fit(perCall(total.output.high), ANSWER_TOKEN_CEILING.output),
      ),
      high: Math.min(
        fit(perCall(total.input.low), ANSWER_TOKEN_CEILING.input),
        fit(perCall(total.output.low), ANSWER_TOKEN_CEILING.output),
      ),
    },
    notCounted: [
      'second rounds after a rejection (only rejected answers get one)',
      'retries beyond the 20 % margin',
      'the M1 arm is sized with the M0 prompt (same injection budget)',
    ],
  }
}
