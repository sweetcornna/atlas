// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The freeze (`scripts/qianmo-recall-freeze.ts`): it fills only empty keys,
 * never overwrites a set one, and reports a set value that recomputes
 * differently. The recomputation itself (a few minutes of baseline) is run
 * by the command, not here.
 */

import { describe, expect, test } from 'bun:test'
import { parsePreregistration } from '../../packages/recall/eval/prereg.js'
import { applyFreeze } from '../qianmo-recall-freeze.js'

const TEXT = [
  '[answer]',
  '# bootstrap_seed =',
  'e1_inference = "bootstrap"',
  '[corpus]',
  '# synthetic_v1_sha256 =',
  `docs_dev_v1_sha256 = "${'a'.repeat(64)}"`,
  '# heldout_ids_sha256 =',
  '',
].join('\n')

describe('applyFreeze', () => {
  test('fills placeholders, agrees, conflicts and leaves pending keys alone', () => {
    const outcome = applyFreeze(TEXT, [
      { section: 'answer', key: 'bootstrap_seed', value: 20260927 },
      { section: 'answer', key: 'e1_inference', value: 'signflip' },
      { section: 'corpus', key: 'synthetic_v1_sha256', value: 'b'.repeat(64) },
      { section: 'corpus', key: 'docs_dev_v1_sha256', value: 'a'.repeat(64) },
      { section: 'corpus', key: 'heldout_ids_sha256', value: null },
    ])
    expect(outcome.filled).toEqual(['bootstrap_seed', 'synthetic_v1_sha256'])
    expect(outcome.agreed).toEqual(['docs_dev_v1_sha256'])
    expect(outcome.pending).toEqual(['heldout_ids_sha256'])
    expect(outcome.conflicts).toEqual([
      'e1_inference: file has bootstrap, recomputed signflip',
    ])
    const frozen = parsePreregistration(outcome.text)
    expect(frozen.answer.bootstrapSeed).toBe(20260927)
    // A set value is never overwritten, even when it disagrees.
    expect(frozen.answer.e1Inference).toBe('bootstrap')
    expect(frozen.corpus.syntheticV1Sha256).toBe('b'.repeat(64))
    expect(outcome.text).toContain('# heldout_ids_sha256 =')
  })

  test('a placeholder in the wrong section is not used', () => {
    const outcome = applyFreeze('[corpus]\n# bootstrap_seed =\n', [
      { section: 'answer', key: 'bootstrap_seed', value: 1 },
    ])
    expect(outcome.filled).toEqual([])
    expect(outcome.conflicts).toEqual([
      'bootstrap_seed: no "# bootstrap_seed =" placeholder in [answer]',
    ])
  })
})
