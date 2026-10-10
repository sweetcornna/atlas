// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import {
  createMemoryEmbedder,
  parseEmbeddingConfig,
} from '../../src/host/memoryEmbedding.js'

test('embedding config is off by default, local loopback only, remote same gateway only', () => {
  expect(parseEmbeddingConfig({ kind: 'off' })).toBeNull()
  expect(() =>
    parseEmbeddingConfig({
      kind: 'ollama',
      endpoint: 'http://other:11434',
      model: 'm',
      dimensions: 2,
    }),
  ).toThrow('loopback')
  expect(() =>
    parseEmbeddingConfig(
      {
        kind: 'openai',
        endpoint: 'https://other/v1/',
        model: 'm',
        dimensions: 2,
        apiKeyEnv: 'TEST_KEY',
      },
      'https://gateway/v1/',
    ),
  ).toThrow('gateway origin')
  expect(() =>
    parseEmbeddingConfig({
      kind: 'ollama',
      endpoint: 'http://localhost:11434?secret=bad',
      model: 'm',
      dimensions: 2,
    }),
  ).toThrow('credentials')
})

test('local adapter really sends batches without inherited credentials and preserves shape and usage', async () => {
  const batches: string[][] = []
  let leakedAuth = false
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      leakedAuth ||= request.headers.has('authorization')
      expect(new URL(request.url).pathname).toBe('/api/embed')
      const body = (await request.json()) as {
        input: string[]
        truncate: boolean
      }
      expect(body.truncate).toBe(false)
      batches.push(body.input)
      return Response.json({
        embeddings: body.input.map(text => [text.length, 1]),
        prompt_eval_count: body.input.length * 2,
      })
    },
  })
  try {
    const embedder = createMemoryEmbedder(
      {
        kind: 'ollama',
        endpoint: server.url.toString(),
        model: 'local',
        dimensions: 2,
        batchSize: 2,
      },
      { OPENAI_API_KEY: 'must-not-leak' },
    )
    expect(
      await embedder.embed(['a', 'bb', 'ccc'], {
        signal: new AbortController().signal,
      }),
    ).toEqual({
      vectors: [
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      usage: { tokens: 6 },
    })
    expect(batches).toEqual([['a', 'bb'], ['ccc']])
    expect(leakedAuth).toBe(false)
  } finally {
    server.stop(true)
  }
})

test('bad dimensions and redirects fail before cache consumption', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return Response.json({ embeddings: [[1]] })
    },
  })
  try {
    const embedder = createMemoryEmbedder({
      kind: 'ollama',
      endpoint: server.url.toString(),
      model: 'local',
      dimensions: 2,
    })
    await expect(
      embedder.embed(['a'], { signal: new AbortController().signal }),
    ).rejects.toThrow('invalid embedding')
  } finally {
    server.stop(true)
  }
})
