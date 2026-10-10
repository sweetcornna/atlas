// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MemoryEntry } from '@qianmo/memory'
import {
  contentHash,
  entryEmbeddingText,
  estimateEmbeddingTokens,
  isUsableVector,
  type EmbeddingProvider,
} from './embedding.js'
import { HYBRID_DEFAULTS } from './hybrid.js'
import type { EmbeddingUsageMeter } from './usage.js'
import type { VectorIndex } from './vector-index.js'

/** Explicit operator-only warming; the complete workload is checked before any call. */
export async function backfillVectors(options: {
  readonly entries: readonly MemoryEntry[]
  readonly index: VectorIndex
  readonly embedder: EmbeddingProvider
  readonly meter: EmbeddingUsageMeter
  readonly maxChars: number
  readonly maxInputChars?: number
  readonly signal?: AbortSignal
}): Promise<{ entries: number; chars: number; reservedTokens: number }> {
  if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 0)
    throw new Error('invalid backfill character budget')
  const pending = options.entries
    .filter(entry => entry.expiredAt === null)
    .map(entry => {
      const text = entryEmbeddingText(
        entry,
        options.maxInputChars ?? HYBRID_DEFAULTS.maxInputChars,
      )
      return {
        text,
        key: {
          entryId: entry.id,
          contentHash: contentHash(text),
          providerId: options.embedder.id,
          model: options.embedder.model,
          dimensions: options.embedder.dimensions,
        },
      }
    })
    .filter(row => options.index.get(row.key) === undefined)
  const chars = pending.reduce(
    (sum, row) => sum + Array.from(row.text).length,
    0,
  )
  const reservedTokens = pending.reduce(
    (sum, row) => sum + estimateEmbeddingTokens(row.text),
    0,
  )
  if (chars > options.maxChars)
    throw new Error(
      'backfill character budget exceeded; no embedding requested',
    )
  if (reservedTokens > options.meter.remaining())
    throw new Error('backfill token budget exceeded; no embedding requested')
  if (pending.length === 0) return { entries: 0, chars, reservedTokens }
  if (options.meter.reserve !== undefined) {
    if (!options.meter.reserve(reservedTokens))
      throw new Error('backfill token budget exceeded; no embedding requested')
  } else options.meter.charge(reservedTokens)
  const result = await options.embedder.embed(
    pending.map(row => row.text),
    { signal: options.signal ?? AbortSignal.timeout(600_000) },
  )
  if (
    result.vectors.length !== pending.length ||
    result.vectors.some(
      vector => !isUsableVector(vector, options.embedder.dimensions),
    )
  )
    throw new Error('invalid backfill vectors')
  if (result.usage !== undefined && result.usage.tokens > reservedTokens)
    options.meter.charge(result.usage.tokens - reservedTokens)
  for (let i = 0; i < pending.length; i++)
    options.index.set(pending[i]!.key, result.vectors[i]!)
  return { entries: pending.length, chars, reservedTokens }
}
