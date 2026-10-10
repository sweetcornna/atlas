// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { answerPrompt } from '../eval/answer/protocol.js'
import {
  FIXTURE_SCHEMA,
  replayTransport,
  recordingTransport,
  type Exchange,
} from '../eval/answer/replay.js'
import { judgeRound, scoreRound } from '../eval/answer/score.js'
import type {
  AnswerRequest,
  AnswerResponse,
  AnswerTransport,
} from '../eval/answer/types.js'
import {
  MEMORY_EVIDENCE_PROTOCOL_HASH,
  MEMORY_EVIDENCE_TOOL,
  handleMemoryEvidenceAnswer,
  recall,
} from '../src/index.js'
import {
  buildWireBody,
  createLiveTransport,
  loadProviders,
} from '../../../scripts/qianmo-recall-answer-live.js'
import { createSandbox, PROJECT_KEY, type Sandbox } from './helpers.js'

let box: Sandbox
beforeEach(() => {
  box = createSandbox()
})
afterEach(() => {
  box.dispose()
})
const response = (input: unknown): AnswerResponse => ({
  text: '',
  thinking: '',
  model: 'loopback',
  stopReason: 'tool_use',
  usage: { input: 1, output: 1 },
  toolCalls: [{ name: 'qianmo_memory_answer', id: 'call_1', input }],
})

test('new evaluation and production share source checking and rendering without changing the scoring oracle', () => {
  const entry = box.write({
    title: 'Client auth',
    summary: 'Registry clients use mTLS.',
  })
  const result = recall(box.store, { scope: { projectKey: PROJECT_KEY } })
  const input = {
    status: 'supported',
    evidence: [{ id: entry.id, quote: entry.summary }],
  }
  const host = handleMemoryEvidenceAnswer(box.store, new Set([entry.id]), input)
  const judged = judgeRound({
    protocol: 'memory-evidence-v2',
    store: box.store,
    result,
    response: response(input),
    keyOf: () => 'source',
    callKey: 'test',
  })
  expect(judged.answer).toBe(host.content)
  expect(judged.answer).toBe(entry.summary)
  expect(host.answer).toContain(entry.createdAt)
  expect(
    scoreRound(judged, {
      kind: 'positive-lexical',
      gold: ['source'],
      acceptable: [],
      mentions: [[entry.createdAt]],
    }).hit,
  ).toBe(false)
  expect(judged.verdict).toBe('accepted')
  // A real quote can still be irrelevant. Empty S(q) MUST remain a misattribution.
  expect(
    scoreRound(judged, {
      kind: 'negative-fabricated',
      gold: [],
      acceptable: [],
      mentions: [],
    }).misattributed,
  ).toBe(true)
  expect(
    scoreRound(judged, {
      kind: 'positive-lexical',
      gold: ['source'],
      acceptable: [],
      mentions: [['mTLS']],
    }).hit,
  ).toBe(true)
  const unsupported = judgeRound({
    protocol: 'memory-evidence-v2',
    store: box.store,
    result,
    response: response({
      status: 'supported',
      evidence: [{ id: entry.id, quote: 'Password-only access is approved.' }],
    }),
    keyOf: () => 'source',
    callKey: 'bad',
  })
  expect(unsupported.verdict).toBe('rejected')
  expect(unsupported.acceptedKeys).toEqual([])
})

test('v1 archived request digest remains byte-identical; v2 recording binds the protocol and cannot silently replay as v1', async () => {
  const entry = box.write({
    title: 'Client auth',
    summary: 'Registry clients use mTLS.',
  })
  const result = recall(box.store, { scope: { projectKey: PROJECT_KEY } })
  const old: AnswerRequest = {
    callKey: 'old',
    ...answerPrompt('legacy-v1', result, 'Client authentication?'),
  }
  const oldResponse = response({ answer: 'mTLS', citations: [entry.id] })
  const provider = {
    providerId: 'fixture',
    requestedModel: 'loopback',
    maxOutputTokens: 100,
  }
  const archived = replayTransport(
    {
      schema: FIXTURE_SCHEMA,
      exchanges: {
        old: {
          provider: 'fixture',
          response: oldResponse,
          requestSha256: createHash('sha256')
            .update(JSON.stringify({ system: old.system, turns: old.turns }))
            .digest('hex'),
        },
      },
    },
    provider,
  )
  expect(await archived.send(old)).toEqual(oldResponse)
  const current: AnswerRequest = {
    callKey: 'new',
    ...answerPrompt('memory-evidence-v2', result, 'Client authentication?'),
  }
  const exchanges: Record<string, Exchange> = {}
  const fake: AnswerTransport = {
    ...provider,
    inputUpperBound: () => 1,
    send: async () =>
      response({
        status: 'supported',
        evidence: [{ id: entry.id, quote: entry.summary }],
      }),
  }
  await recordingTransport(fake, exchanges).send(current)
  const replay = replayTransport(
    {
      schema: FIXTURE_SCHEMA,
      answerProtocol: 'memory-evidence-v2',
      protocolSha256: MEMORY_EVIDENCE_PROTOCOL_HASH,
      exchanges,
    },
    provider,
  )
  expect(() =>
    replayTransport(
      {
        schema: FIXTURE_SCHEMA,
        answerProtocol: 'memory-evidence-v2',
        protocolSha256: '0'.repeat(64),
        exchanges,
      },
      provider,
    ),
  ).toThrow('protocol hash differs')
  expect((await replay.send(current)).toolCalls).toHaveLength(1)
  expect(() =>
    replay.inputUpperBound({ ...current, protocol: 'legacy-v1' }),
  ).toThrow('differs')
  const target = loadProviders()[0]!
  const wire = buildWireBody(target, current, 'http://127.0.0.1')
  expect(wire['tools']).toEqual([
    {
      type: 'function',
      function: {
        name: MEMORY_EVIDENCE_TOOL.name,
        description: MEMORY_EVIDENCE_TOOL.description,
        parameters: MEMORY_EVIDENCE_TOOL.inputSchema,
      },
    },
  ])
  expect(current.system).toEqual([])
})

test('paid transport refuses legacy or unspecified protocol before invoking any network function', async () => {
  let calls = 0
  const transport = createLiveTransport(
    loadProviders()[0]!,
    { apiKey: 'canary', baseURL: 'http://127.0.0.1' },
    {
      fetch: (async () => {
        calls++
        throw new Error('must not be called')
      }) as unknown as typeof fetch,
    },
  )
  const input: AnswerRequest = {
    callKey: 'no-paid-call',
    system: [],
    turns: [],
  }
  expect(() => transport.inputUpperBound(input)).toThrow('replay-only')
  await expect(
    transport.send({ ...input, protocol: 'legacy-v1' }),
  ).rejects.toThrow('replay-only')
  expect(calls).toBe(0)
})
