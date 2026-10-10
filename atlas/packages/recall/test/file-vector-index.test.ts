// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import { mkdtempSync, statSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileMemoryStore } from '@qianmo/memory'
import {
  FileVectorIndex,
  backfillVectors,
  contentHash,
  entryEmbeddingText,
  type EmbeddingProvider,
} from '../src/index.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qm-vectors-'))
  const store = new FileMemoryStore({ root })
  const entry = store.write({
    scope: { layer: 'project', projectKey: 'test' },
    title: 'runtime',
    summary: 'use Bun',
    body: 'Bun is the runtime',
    source: { kind: 'user', id: 'test' },
  })
  const embedder: EmbeddingProvider = {
    id: 'local',
    model: 'fixture',
    dimensions: 2,
    async embed(texts) {
      return { vectors: texts.map(() => [1, 0]) }
    },
  }
  const key = {
    entryId: entry.id,
    contentHash: contentHash(entryEmbeddingText(entry, 8000)),
    providerId: embedder.id,
    model: embedder.model,
    dimensions: 2,
  }
  return { root, store, entry, embedder, key }
}

test('cache is private and survives restart; content and model mismatches miss; revoked vectors are pruned', async () => {
  const { root, store, entry, embedder, key } = fixture()
  let charged = 0
  const index = new FileVectorIndex(root)
  const warmed = await backfillVectors({
    entries: store.query(),
    index,
    embedder,
    meter: {
      remaining: () => 10000,
      charge: n => {
        charged += n
      },
    },
    maxChars: 10000,
  })
  expect(warmed.entries).toBe(1)
  expect(charged).toBeGreaterThan(0)
  index.close()
  const reopened = new FileVectorIndex(root)
  expect(reopened.get(key)).toEqual([1, 0])
  expect(reopened.get({ ...key, contentHash: 'changed' })).toBeUndefined()
  expect(reopened.get({ ...key, model: 'other' })).toBeUndefined()
  expect(store.query()).toHaveLength(1)
  if (process.platform !== 'win32') {
    expect(statSync(join(root, 'index')).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, 'index', 'vectors.sqlite')).mode & 0o777).toBe(
      0o600,
    )
  }
  store.revoke(entry.id, { reason: 'withdrawn', by: 'test' })
  reopened.prune(store)
  expect(reopened.get(key)).toBeUndefined()
  reopened.close()
})

test('complete character/token budget is checked before any request', async () => {
  const { root, store, embedder } = fixture()
  let calls = 0,
    charges = 0
  const index = new FileVectorIndex(root)
  const options = {
    entries: store.query(),
    index,
    embedder: {
      ...embedder,
      async embed(texts: readonly string[]) {
        calls++
        return { vectors: texts.map(() => [1, 0]) }
      },
    },
    meter: {
      remaining: () => 0,
      charge: () => {
        charges++
      },
    },
  }
  await expect(backfillVectors({ ...options, maxChars: 0 })).rejects.toThrow(
    'character budget',
  )
  await expect(
    backfillVectors({ ...options, maxChars: 10000 }),
  ).rejects.toThrow('token budget')
  expect(calls).toBe(0)
  expect(charges).toBe(0)
  index.close()
})

test('index symlink cannot redirect a private cache into an unrelated path', () => {
  const { root } = fixture()
  const elsewhere = mkdtempSync(join(tmpdir(), 'qm-vector-outside-'))
  symlinkSync(elsewhere, join(root, 'index'))
  expect(() => new FileVectorIndex(root)).toThrow()
  expect(statSync(elsewhere).isDirectory()).toBe(true)
})
