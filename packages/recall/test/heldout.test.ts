// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The held-out set interface (§2.4 item 2, D-1 R5): the file format, what
 * disqualifies a set, and the R2–R4 judgment that only runs on a set that
 * matches its preregistered hash.
 *
 * No real held-out question appears here — its author is someone else. The
 * sets below are made of nonsense tokens (`zqxv…`): zero overlap with any
 * entry by construction, and useless as a template.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  memoizeForCandidateSet,
  NULL_RANKERS,
} from '../eval/fusion-reference.js'
import {
  goldDecisions,
  HELDOUT_PATH,
  type HeldoutSet,
  heldoutDigest,
  heldoutProblems,
  loadHeldout,
  parseHeldout,
} from '../eval/heldout.js'
import { parsePreregistration } from '../eval/prereg.js'
import { referenceArms } from '../eval/retrieval-gates.js'
import { type HeldoutArms, judgeRetrieval } from '../eval/retrieval-judgment.js'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const CHECKER = join(REPO_ROOT, 'scripts/qianmo-recall-heldout-check.ts')

/** A well-formed set of nonsense questions, two per gold decision. */
function nonsenseSet(): HeldoutSet {
  return {
    corpus: 'synthetic-v1',
    author: 'test fixture',
    questions: goldDecisions().flatMap((decision, index) =>
      [1, 2].map(n => ({
        id: `ho-${decision.id}-${n}`,
        gold: decision.id,
        question: `zqxv${index}x${n} qqzv${index}y${n}？`,
      })),
    ),
  }
}

function toToml(set: HeldoutSet): string {
  return [
    '# Copyright 2026 Qianmo AgentNest Team',
    '# SPDX-License-Identifier: AGPL-3.0-or-later',
    'schema = "qianmo-recall-heldout/v1"',
    `corpus = "${set.corpus}"`,
    `author = ${JSON.stringify(set.author)}`,
    ...set.questions.flatMap(q => [
      '',
      '[[questions]]',
      `id = ${JSON.stringify(q.id)}`,
      `gold = ${JSON.stringify(q.gold)}`,
      `question = ${JSON.stringify(q.question)}`,
    ]),
    '',
  ].join('\n')
}

describe('format and problems', () => {
  test('nothing is delivered yet', () => {
    expect(loadHeldout()).toBeNull()
    expect(loadHeldout(HELDOUT_PATH)).toBeNull()
  })

  test('the file round-trips; a clean set has no problems', () => {
    const set = nonsenseSet()
    expect(parseHeldout(toToml(set))).toEqual(set)
    expect(set.questions.length).toBe(40)
    expect(heldoutProblems(set)).toEqual([])
  })

  test('shape errors are refused at parse time', () => {
    expect(() => parseHeldout('schema = "x"')).toThrow(/schema must be/)
    expect(() =>
      parseHeldout(
        [
          'schema = "qianmo-recall-heldout/v1"',
          'corpus = "synthetic-v1"',
          'author = "a"',
          '[[questions]]',
          'id = "ho-a"',
          'gold = "wake"',
        ].join('\n'),
      ),
    ).toThrow(/needs exactly id, gold and question/)
  })

  test('every disqualifying property is named', () => {
    const [wake] = goldDecisions().filter(d => d.id === 'wake')
    if (wake === undefined) throw new Error('corpus changed')
    const set = nonsenseSet()
    const questions = [
      // Copies the decision's own title: shares tokens with its gold.
      {
        ...set.questions[0],
        id: 'ho-copy',
        gold: 'wake',
        question: wake.title,
      },
      { ...set.questions[1], id: 'Bad Id' },
      { ...set.questions[2], id: 'ho-copy' },
      { ...set.questions[3], gold: 'no-such-decision' },
      { ...set.questions[4], question: '？？' },
      { ...set.questions[5], question: set.questions[6]?.question ?? '' },
      ...set.questions.slice(6),
    ].map(q => ({
      id: q.id ?? '',
      gold: q.gold ?? '',
      question: q.question ?? '',
    }))
    const problems = heldoutProblems({ ...set, questions }).join('\n')
    expect(problems).toContain('ho-copy: shares tokens with its gold')
    expect(problems).toContain('Bad Id: id must match')
    expect(problems).toContain('ho-copy: duplicate id')
    expect(problems).toContain('gold no-such-decision is not one of the 20')
    expect(problems).toContain('the question has no ranking tokens')
    expect(problems).toContain('same question as ho-')
    expect(problems).toMatch(/gold \S+: 1 questions, expected 2/)
  })

  test('full-width letters do not hide an overlap', () => {
    // The tokeniser keeps `ｐ９５` apart from `p95`; the check folds width.
    const set = nonsenseSet()
    const questions = set.questions.map(q =>
      q.id === 'ho-wake-1' ? { ...q, question: 'ｐ９５要求是多少？' } : q,
    )
    expect(heldoutProblems({ ...set, questions })).toEqual([
      'ho-wake-1: shares tokens with its gold: p95',
    ])
  }, 60_000)
})

describe('the checker the author runs', () => {
  test('reports shared tokens, exits 1; a clean file exits 0 with its hash', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qianmo-heldout-'))
    try {
      const set = nonsenseSet()
      const clean = join(directory, 'clean.heldout.toml')
      writeFileSync(clean, toToml(set))
      const ok = Bun.spawnSync([process.execPath, 'run', CHECKER, clean], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(ok.exitCode).toBe(0)
      expect(ok.stdout.toString()).toContain(
        `heldout_ids_sha256 = ${heldoutDigest(set)}`,
      )
      const [wake] = goldDecisions().filter(d => d.id === 'wake')
      const dirty = join(directory, 'dirty.heldout.toml')
      writeFileSync(
        dirty,
        toToml({
          ...set,
          questions: set.questions.map(q =>
            q.id === 'ho-wake-1' ? { ...q, question: wake?.title ?? '' } : q,
          ),
        }),
      )
      const bad = Bun.spawnSync([process.execPath, 'run', CHECKER, dirty], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(bad.exitCode).toBe(1)
      expect(bad.stdout.toString()).toMatch(/FAIL ho-wake-1 → wake {2}shared: /)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('R2–R4 judgment on the held-out set', () => {
  const set = nonsenseSet()
  const prereg = (
    heldout: string | null,
    unit: 'question' | 'gold' | null = 'gold',
  ) =>
    parsePreregistration(
      [
        '[retrieval]',
        'alpha_primary = 0.025',
        unit === null ? '' : `sign_test_unit = "${unit}"`,
        '[corpus]',
        'shuffle_seed = 20261003',
        heldout === null ? '' : `heldout_ids_sha256 = "${heldout}"`,
      ].join('\n'),
    )
  const nullArms: HeldoutArms = (materialised, dataset, permutation) => {
    const scorer = NULL_RANKERS['outlier-unigram']
    if (scorer === undefined) throw new Error('no null ranker')
    const memo = memoizeForCandidateSet(scorer)
    return referenceArms(
      materialised,
      dataset,
      entries => memo(entries),
      permutation,
    )
  }

  test('refuses without a delivered set, a preregistered hash, or a matching one', () => {
    const arms: HeldoutArms = () => {
      throw new Error('must not run')
    }
    const digest = heldoutDigest(set)
    expect(
      judgeRetrieval({ prereg: prereg(digest), heldout: null, arms }).reason,
    ).toBe('held-out set not delivered')
    expect(
      judgeRetrieval({ prereg: prereg(null), heldout: set, arms }).reason,
    ).toBe('preregistration: corpus.heldout_ids_sha256 not generated')
    const other = { ...set, questions: set.questions.slice(1) }
    const refused = judgeRetrieval({
      prereg: prereg(digest),
      heldout: other,
      arms,
    })
    expect(refused.status).toBe('not-evaluable')
    expect(refused.reason).toBe(
      'held-out set differs from its preregistered id-list hash',
    )
    expect(
      judgeRetrieval({
        prereg: prereg(heldoutDigest(set), null),
        heldout: set,
        arms,
      }).reason,
    ).toBe('preregistration: retrieval.sign_test_unit not generated')
    const withProblems = judgeRetrieval({
      prereg: prereg(heldoutDigest(other)),
      heldout: other,
      arms,
    })
    expect(withProblems.reason).toMatch(/^held-out set has problems: /)
  })

  test('judges every seed; a query-blind ranker fails R4, and R3 depends on the unit', () => {
    // Nonsense questions tie every entry at zero relevance, so the fusion
    // order past the floor is the query-blind ranker's alone — the case R4
    // exists for. Counted per question, each gold it pulls in scores twice
    // (two questions per gold) and R3 passes; counted per gold, it does not.
    const byGold = judgeRetrieval({
      prereg: prereg(heldoutDigest(set), 'gold'),
      heldout: set,
      arms: nullArms,
    })
    expect(byGold.status).toBe('judged')
    expect(byGold.R3?.perSeed.map(v => v.seed)).toEqual([
      20260926, 20260927, 20260928, 20260929, 20260930,
    ])
    expect(byGold.R3?.pass).toBe(false)
    expect(byGold.R4?.pass).toBe(false)
    // Blind to the question, the real and shuffled arms inject the same.
    expect(byGold.R4?.perSeed.every(v => v.wins === 0 && v.losses === 0)).toBe(
      true,
    )
    const byQuestion = judgeRetrieval({
      prereg: prereg(heldoutDigest(set), 'question'),
      heldout: set,
      arms: nullArms,
    })
    expect(byQuestion.R3?.pass).toBe(true)
    expect(byQuestion.R4?.pass).toBe(false)
    const perSeed = (v: typeof byGold) => v.R3?.perSeed.map(x => x.wins) ?? []
    for (const [index, wins] of perSeed(byQuestion).entries()) {
      expect(wins).toBeGreaterThan(perSeed(byGold)[index] ?? 0)
    }
  }, 180_000)
})
