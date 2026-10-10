// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readQualityCorpus } from '../eval/quality-corpus.js'
import {
  loadPreregistration,
  parsePreregistration,
  PREREGISTRATION_PATH,
} from '../eval/prereg.js'
import { TokenLedger } from '../eval/answer/ledger.js'
import {
  checkPlan,
  runAnswerEval,
  m0Retriever,
  type AnswerPlan,
} from '../eval/answer/runner.js'
import type { AnswerTransport } from '../eval/answer/types.js'
import { MEMORY_EVIDENCE_PROTOCOL_HASH } from '../src/index.js'

let root: string
let previous: Record<string, string | undefined>
const variables = [
  'QIANMO_RECALL_QUALITY_CORPUS',
  'QIANMO_RECALL_QUALITY_SHA256',
  'QIANMO_RECALL_QUALITY_DOCS_CORPUS',
  'QIANMO_RECALL_QUALITY_DOCS_SHA256',
]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qm-quality-fixture-'))
  previous = Object.fromEntries(variables.map(key => [key, process.env[key]]))
  for (const key of variables) delete process.env[key]
})
afterEach(() => {
  for (const key of variables) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  rmSync(root, { recursive: true, force: true })
})

function fixture(id = 'memory-quality-v2') {
  const positive = {
    id: 'positive',
    kind: 'positive-lexical',
    question: 'How are registry clients authenticated?',
    gold: ['source'],
    forbidden: [],
    acceptable: [],
    mustMention: ['mTLS'],
    mustMentionAny: [['mTLS']],
  }
  return {
    schema: 'qianmo-memory-quality-corpus/v1',
    id,
    seed: 20261008,
    tiers: {
      '1': {
        seed: 20261008,
        liveInScope: 1,
        asOf: '2026-10-08T00:00:00.000Z',
        scope: { projectKey: 'test' },
        entries: [
          {
            key: 'source',
            role: 'gold',
            scope: { layer: 'project', projectKey: 'test' },
            title: 'Registry authentication',
            summary: 'Registry clients use mTLS.',
            body: 'Registry clients use mTLS.',
            tags: [],
            createdAt: '2026-10-07T00:00:00.000Z',
          },
        ],
        queries: [
          positive,
          {
            ...positive,
            id: 'negative',
            kind: 'negative-fabricated',
            question: 'Is a password-only bypass recorded?',
            gold: [],
            mustMention: [],
            mustMentionAny: [],
          },
        ],
      },
    },
  }
}
function seal(value = fixture()) {
  const path = join(root, `${value.id}.json`)
  const text = JSON.stringify(value)
  const sha = createHash('sha256').update(text).digest('hex')
  writeFileSync(path, text)
  const prefix =
    value.id === 'memory-quality-docs-v2'
      ? 'QIANMO_RECALL_QUALITY_DOCS'
      : 'QIANMO_RECALL_QUALITY'
  process.env[`${prefix}_CORPUS`] = path
  process.env[`${prefix}_SHA256`] = sha
  return sha
}
const plan = (): AnswerPlan => ({
  runId: 'unit-only',
  phase: 'trial',
  corpora: [{ id: 'memory-quality-v2', tiers: [1] }],
  repetitions: 1,
  arms: ['m0'],
  providers: ['scripted'],
  seed: 20261008,
  primaryCorpus: 'memory-quality-v2',
  concurrency: 1,
})

test('sealed corpus needs both explicit file and matching digest; labels must refer to its entries', () => {
  expect(() => readQualityCorpus()).toThrow('requires')
  const sha = seal()
  expect(readQualityCorpus().sha256).toBe(sha)
  expect(readQualityCorpus().tiers['1']?.entries[0]?.createdAt).toBeInstanceOf(
    Date,
  )
  process.env.QIANMO_RECALL_QUALITY_SHA256 = '0'.repeat(64)
  expect(() => readQualityCorpus()).toThrow('SHA-256 mismatch')
  const invalid = fixture()
  invalid.tiers['1'].queries[0]!.gold = ['nonexistent']
  seal(invalid)
  expect(() => readQualityCorpus()).toThrow('oracle source keys')
})

test('new plan is refused before calls if the separately frozen preregistration does not pin this corpus', () => {
  const sha = seal()
  const prereg = loadPreregistration()
  expect(() => checkPlan(plan(), prereg)).toThrow('preregistration hash')
  expect(() =>
    checkPlan(plan(), {
      ...prereg,
      corpus: { ...prereg.corpus, memoryQualityV2Sha256: sha },
    }),
  ).not.toThrow()
})

test('secondary documents use an independent file and preregistered digest without entering primary gates', () => {
  const sha = seal()
  const docs = fixture('memory-quality-docs-v2')
  docs.tiers['1'].entries[0]!.body = 'Independent document fixture.'
  expect(() => readQualityCorpus('memory-quality-docs-v2')).toThrow(
    'DOCS_CORPUS',
  )
  const docsSha = seal(docs)
  expect(docsSha).not.toBe(sha)
  expect(readQualityCorpus().sha256).toBe(sha)
  expect(readQualityCorpus('memory-quality-docs-v2').sha256).toBe(docsSha)
  const secondaryPlan: AnswerPlan = {
    ...plan(),
    corpora: [...plan().corpora, { id: 'memory-quality-docs-v2', tiers: [1] }],
  }
  const original = loadPreregistration()
  const pinned = {
    ...original,
    corpus: {
      ...original.corpus,
      memoryQualityV2Sha256: sha,
      memoryQualityDocsV2Sha256: docsSha,
    },
  }
  expect(() => checkPlan(secondaryPlan, pinned)).not.toThrow()
  expect(() =>
    checkPlan(secondaryPlan, {
      ...pinned,
      corpus: { ...pinned.corpus, memoryQualityDocsV2Sha256: sha },
    }),
  ).toThrow('preregistration hash')
  const text = readFileSync(PREREGISTRATION_PATH, 'utf8')
    .replace(
      /^\[corpus\]$/m,
      `[corpus]\nmemory_quality_docs_v2_sha256 = "${docsSha}"`,
    )
    .replace(/^\[plan\]$/m, '[plan]\nmemory_quality_docs_v2_tiers = [1]')
  const decoded = parsePreregistration(text)
  expect(decoded.corpus.memoryQualityDocsV2Sha256).toBe(docsSha)
  expect(decoded.plan?.tiers['memory-quality-docs-v2']).toEqual([1])
  expect(decoded.plan?.primaryCorpus).toBe('synthetic-v1')
  expect(decoded.answer).toEqual(original.answer)
  process.env.QIANMO_RECALL_QUALITY_DOCS_CORPUS =
    process.env.QIANMO_RECALL_QUALITY_CORPUS
  process.env.QIANMO_RECALL_QUALITY_DOCS_SHA256 = sha
  expect(() => readQualityCorpus('memory-quality-docs-v2')).toThrow('header')
})

test('v2 runner records the protocol, supports positive evidence and negative abstention, and prevents mixed-protocol resume', async () => {
  const sha = seal()
  const original = loadPreregistration()
  const prereg = {
    values: {
      ...original,
      corpus: { ...original.corpus, memoryQualityV2Sha256: sha },
    },
    sha256: 'unit-only-prereg',
  }
  let calls = 0
  const transport: AnswerTransport = {
    providerId: 'scripted',
    requestedModel: 'not-a-model',
    maxOutputTokens: 20,
    inputUpperBound: () => 100,
    send: async request => {
      calls++
      expect(request.protocol).toBe('memory-evidence-v2')
      expect(request.system).toEqual([])
      const text =
        request.turns[0]?.role === 'user' ? request.turns[0].text : ''
      const id = /^entry_id: (.+)$/m.exec(text)?.[1]
      if (!id) throw new Error('missing actual injection')
      return {
        text: '',
        thinking: '',
        model: 'not-a-model',
        stopReason: 'tool_use',
        usage: { input: 10, output: 10 },
        toolCalls: [
          {
            id: 'answer',
            name: 'qianmo_memory_answer',
            input: text.startsWith('How')
              ? {
                  status: 'supported',
                  evidence: [{ id, quote: 'Registry clients use mTLS.' }],
                }
              : { status: 'insufficient', evidence: [] },
          },
        ],
      }
    },
  }
  const ledger = TokenLedger.open(join(root, 'ledger.json'), {
    runId: 'unit-only',
    phase: 'trial',
    cap: { input: 10000, output: 1000 },
  })
  try {
    const deps = {
      protocol: 'memory-evidence-v2' as const,
      transports: [transport],
      retrievers: { m0: m0Retriever },
      ledger,
      outDir: join(root, 'out'),
      prereg,
    }
    const report = await runAnswerEval(plan(), deps)
    expect(calls).toBe(2)
    expect(report.protocol).toMatchObject({
      version: 'memory-evidence-v2',
      sha256: MEMORY_EVIDENCE_PROTOCOL_HASH,
      placement: 'user-message',
    })
    expect(report.status).toBe('complete')
    const records = readFileSync(join(root, 'out', 'calls.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(
      records.every(record => record.answerProtocol === 'memory-evidence-v2'),
    ).toBe(true)
    expect(
      records.find(record => record.unit.kind === 'positive-lexical').first.hit,
    ).toBe(true)
    expect(
      records.find(record => record.unit.kind === 'negative-fabricated').first
        .acceptedCitations,
    ).toBe(0)
    const before = readFileSync(join(root, 'out', 'report.json'), 'utf8')
    await expect(
      runAnswerEval(plan(), { ...deps, protocol: 'legacy-v1' }),
    ).rejects.toThrow('another answer protocol')
    expect(calls).toBe(2)
    expect(readFileSync(join(root, 'out', 'report.json'), 'utf8')).toBe(before)
  } finally {
    ledger.close()
  }
})
