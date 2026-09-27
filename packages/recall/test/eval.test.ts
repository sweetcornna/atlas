// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The retrieval-layer baseline harness (`eval/`).
 *
 * These tests pin the *measuring instrument* — metric arithmetic, dataset
 * determinism, label integrity — and deliberately assert nothing about the
 * numbers the instrument currently reads. A baseline written into a test as
 * an expected value would freeze today's retrieval quality into a standard,
 * and the point of M1 is to move it.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildDataset,
  DEFAULT_SEED,
  EVAL_QUERY_KINDS,
  FIXED_LIVE_IN_SCOPE,
  MAX_LIVE_IN_SCOPE,
  mulberry32,
  TARGET_PROJECT,
  type EvalEntry,
} from '../eval/dataset.js'
import {
  coverage,
  leakCount,
  meanOf,
  ranksOf,
  recallAtK,
  reciprocalRank,
  round4,
} from '../eval/metrics.js'
import {
  renderMarkdown,
  runBaseline,
  summarise,
  type QueryOutcome,
} from '../eval/run.js'

const SMALL_TIER = 30

function isLiveInTarget(entry: EvalEntry): boolean {
  return (
    entry.scope.layer === 'project' &&
    entry.scope.projectKey === TARGET_PROJECT &&
    entry.revokedAt === undefined &&
    entry.invalidAt === undefined
  )
}

describe('metrics', () => {
  const ranking = ['a', 'b', 'c', 'd', 'e']

  test('recall@k counts gold inside the first k, over distinct gold', () => {
    expect(recallAtK(ranking, ['c'], 1)).toBe(0)
    expect(recallAtK(ranking, ['c'], 3)).toBe(1)
    expect(recallAtK(ranking, ['a', 'e'], 2)).toBe(0.5)
    expect(recallAtK(ranking, ['a', 'a'], 1)).toBe(1)
    expect(recallAtK(ranking, ['z'], 5)).toBe(0)
    expect(recallAtK(ranking, ['a'], 0)).toBe(0)
  })

  test('a query without gold has no recall at all, not 0 and not 1', () => {
    expect(recallAtK(ranking, [], 5)).toBeNull()
    expect(reciprocalRank(ranking, [])).toBeNull()
    expect(coverage(ranking, [])).toBeNull()
  })

  test('reciprocal rank uses the first gold hit', () => {
    expect(reciprocalRank(ranking, ['c'])).toBeCloseTo(1 / 3, 12)
    expect(reciprocalRank(ranking, ['d', 'b'])).toBe(0.5)
    expect(reciprocalRank(ranking, ['z'])).toBe(0)
  })

  test('coverage, leaks and ranks', () => {
    expect(coverage(['a', 'b'], ['b', 'x'])).toBe(0.5)
    expect(leakCount(['a', 'b', 'c'], ['c', 'x', 'c'])).toBe(1)
    expect(leakCount(['a'], [])).toBe(0)
    expect(ranksOf(ranking, ['b', 'z'])).toEqual([2, null])
  })

  test('means skip nulls, and round4 keeps four decimals', () => {
    expect(meanOf([1, null, 0])).toBe(0.5)
    expect(meanOf([null, null])).toBeNull()
    expect(meanOf([])).toBeNull()
    expect(round4(1 / 3)).toBe(0.3333)
    expect(round4(null)).toBeNull()
  })

  test('summarise aggregates exactly what it is given', () => {
    const base: QueryOutcome = {
      id: 'q',
      kind: 'positive-lexical',
      mode: 'ranked',
      candidates: 10,
      injected: 5,
      gold: ['g'],
      goldRanks: [1],
      goldRelevance: [2],
      recallAt1: 1,
      recallAt5: 1,
      recallAt10: 1,
      reciprocalRank: 1,
      candidateRecall: 1,
      injectionCoverage: 1,
      forbiddenLabels: 1,
      forbiddenInCandidates: 0,
      forbiddenInjected: 0,
      top1: 'g',
      lureAtTop1: false,
    }
    const outcomes: QueryOutcome[] = [
      base,
      {
        ...base,
        id: 'q2',
        mode: 'full',
        recallAt1: 0,
        reciprocalRank: 0.5,
        injectionCoverage: 0,
        forbiddenInjected: 1,
        lureAtTop1: true,
      },
      {
        ...base,
        id: 'q3',
        kind: 'negative-fabricated',
        gold: [],
        recallAt1: null,
        recallAt5: null,
        recallAt10: null,
        reciprocalRank: null,
        candidateRecall: null,
        injectionCoverage: null,
        forbiddenLabels: 0,
      },
    ]
    const summary = summarise(outcomes)
    expect(summary.queries).toBe(3)
    expect(summary.withGold).toBe(2)
    expect(summary.fullMode).toBe(1)
    expect(summary.recallAt1).toBe(0.5)
    expect(summary.mrr).toBe(0.75)
    expect(summary.injectionCoverage).toBe(0.5)
    expect(summary.forbiddenLabels).toBe(2)
    expect(summary.forbiddenInjected).toBe(1)
    expect(summary.lureAtTop1).toBe(1)
  })
})

describe('dataset', () => {
  test('the PRNG is a pure function of its seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const c = mulberry32(43)
    const first = [a(), a(), a()]
    expect([b(), b(), b()]).toEqual(first)
    expect([c(), c(), c()]).not.toEqual(first)
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  test('same seed and tier, same corpus; another seed, another corpus', () => {
    const one = buildDataset(200, DEFAULT_SEED)
    const two = buildDataset(200, DEFAULT_SEED)
    expect(JSON.stringify(one)).toBe(JSON.stringify(two))
    const other = buildDataset(200, DEFAULT_SEED + 1)
    expect(JSON.stringify(other.entries)).not.toBe(JSON.stringify(one.entries))
    // The questions are fixed text; only the corpus varies with the seed.
    expect(other.queries).toEqual(one.queries)
  })

  test('the tier is exactly the number of live entries in the target scope', () => {
    for (const tier of [FIXED_LIVE_IN_SCOPE, SMALL_TIER, 500]) {
      const dataset = buildDataset(tier)
      expect(dataset.entries.filter(isLiveInTarget).length).toBe(tier)
    }
    expect(() => buildDataset(FIXED_LIVE_IN_SCOPE - 1)).toThrow(RangeError)
    expect(() => buildDataset(MAX_LIVE_IN_SCOPE + 1)).toThrow(RangeError)
    expect(() => buildDataset(40.5)).toThrow(RangeError)
  })

  test('every label names an entry, and each label means what it says', () => {
    const dataset = buildDataset(SMALL_TIER)
    const byKey = new Map(dataset.entries.map(entry => [entry.key, entry]))
    expect(byKey.size).toBe(dataset.entries.length)
    expect(new Set(dataset.queries.map(q => q.id)).size).toBe(
      dataset.queries.length,
    )
    for (const kind of EVAL_QUERY_KINDS) {
      expect(dataset.queries.some(query => query.kind === kind)).toBe(true)
    }
    for (const query of dataset.queries) {
      for (const key of query.gold) {
        const entry = byKey.get(key)
        expect(entry === undefined ? null : isLiveInTarget(entry)).toBe(true)
      }
      for (const key of query.forbidden) {
        const entry = byKey.get(key)
        expect(entry === undefined ? null : isLiveInTarget(entry)).toBe(false)
      }
      if (query.kind.startsWith('positive-')) {
        expect(query.gold.length).toBeGreaterThan(0)
        expect(query.mustMention.length).toBeGreaterThan(0)
      }
      if (query.kind === 'negative-fabricated') {
        expect(query.gold).toEqual([])
        expect(query.forbidden).toEqual([])
      }
      if (
        query.kind === 'negative-retired' ||
        query.kind === 'negative-cross-scope'
      ) {
        expect(query.forbidden.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('runner', () => {
  test('the mismatch label holds against the real ranker', () => {
    // A `positive-mismatch` question must give its gold entry no ranking
    // signal at all — that is the D-6 shape the kind stands for. Checked with
    // the shipped scorer, so a tokenizer change that quietly creates overlap
    // shows up here as a label error rather than as a better baseline.
    const report = runBaseline({ tiers: [SMALL_TIER] })
    const [tier] = report.tiers
    if (tier === undefined) throw new Error('no tier report')
    for (const outcome of tier.queries) {
      if (outcome.kind === 'positive-mismatch') {
        expect(outcome.goldRelevance).toEqual([0])
      }
      if (outcome.kind === 'positive-lexical') {
        expect(outcome.goldRelevance[0] ?? 0).toBeGreaterThan(0)
      }
      // The tier label is what recall actually saw.
      expect(outcome.candidates).toBe(SMALL_TIER)
    }
  })

  test('two runs from scratch produce the same report', () => {
    const one = runBaseline({ tiers: [SMALL_TIER], decay: ['default', 'off'] })
    const two = runBaseline({ tiers: [SMALL_TIER], decay: ['default', 'off'] })
    expect(JSON.stringify(two)).toBe(JSON.stringify(one))
    expect(one.tiers.map(t => t.decay)).toEqual(['default', 'off'])
  })

  test('the markdown has one row per kind plus the pooled row, per tier', () => {
    const report = runBaseline({ tiers: [SMALL_TIER] })
    const rows = renderMarkdown(report)
      .split('\n')
      .filter(line => line.startsWith(`| ${SMALL_TIER} |`))
    expect(rows.length).toBe(EVAL_QUERY_KINDS.length + 1)
  })
})
