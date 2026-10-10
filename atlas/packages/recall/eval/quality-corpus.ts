// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { CorpusDataset } from './corpora.js'

type QualityId = 'memory-quality-v2' | 'memory-quality-docs-v2'
type FrozenQuality = {
  seed: number
  tiers: Readonly<Record<string, CorpusDataset>>
  sha256: string
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid frozen quality corpus object')
  return value as Record<string, unknown>
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}
function date(value: unknown): Date {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error('invalid frozen quality corpus date')
  return new Date(value)
}

/** Only a separately authored, SHA-pinned file is accepted; no generated fallback. */
export function readQualityCorpus(
  id: QualityId = 'memory-quality-v2',
): FrozenQuality {
  const prefix =
    id === 'memory-quality-v2'
      ? 'QIANMO_RECALL_QUALITY'
      : 'QIANMO_RECALL_QUALITY_DOCS'
  const path = process.env[`${prefix}_CORPUS`]
  const expected = process.env[`${prefix}_SHA256`]
  if (!path || !expected || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error(
      `sealed quality corpus requires ${prefix}_CORPUS and ${prefix}_SHA256`,
    )
  const bytes = readFileSync(path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== expected)
    throw new Error('sealed quality corpus SHA-256 mismatch')
  const source = record(JSON.parse(bytes.toString('utf8')))
  if (
    source.schema !== 'qianmo-memory-quality-corpus/v1' ||
    source.id !== id ||
    !Number.isSafeInteger(source.seed)
  )
    throw new Error('invalid frozen quality corpus header')
  const tiers: Record<string, CorpusDataset> = {}
  for (const [tier, value] of Object.entries(record(source.tiers))) {
    const row = record(value)
    if (
      !/^[1-9][0-9]*$/.test(tier) ||
      row.seed !== source.seed ||
      row.liveInScope !== Number(tier) ||
      !Array.isArray(row.entries) ||
      !Array.isArray(row.queries)
    )
      throw new Error('invalid frozen quality corpus tier')
    record(row.scope)
    const keys = new Set<string>()
    const entries = row.entries.map(value => {
      const entry = record(value)
      for (const field of ['key', 'role', 'title', 'summary', 'body'])
        if (typeof entry[field] !== 'string')
          throw new Error('invalid frozen quality entry text')
      if (!entry.key || keys.has(entry.key as string) || !strings(entry.tags))
        throw new Error('invalid or repeated frozen quality entry key')
      keys.add(entry.key as string)
      record(entry.scope)
      return {
        ...entry,
        createdAt: date(entry.createdAt),
        ...(entry.invalidAt === undefined
          ? {}
          : { invalidAt: date(entry.invalidAt) }),
        ...(entry.revokedAt === undefined
          ? {}
          : { revokedAt: date(entry.revokedAt) }),
      }
    })
    const ids = new Set<string>()
    for (const value of row.queries) {
      const query = record(value)
      if (
        typeof query.id !== 'string' ||
        !query.id ||
        ids.has(query.id) ||
        typeof query.kind !== 'string' ||
        typeof query.question !== 'string'
      )
        throw new Error('invalid or repeated frozen quality query')
      ids.add(query.id)
      for (const field of ['gold', 'forbidden', 'acceptable']) {
        const list = query[field]
        if (!strings(list) || list.some(key => !keys.has(key)))
          throw new Error('invalid frozen quality oracle source keys')
      }
      if (
        !strings(query.mustMention) ||
        !Array.isArray(query.mustMentionAny) ||
        !query.mustMentionAny.every(strings)
      )
        throw new Error('invalid frozen quality answer labels')
    }
    if (ids.size === 0 || entries.length === 0)
      throw new Error('empty frozen quality corpus')
    tiers[tier] = {
      ...row,
      entries,
      asOf: date(row.asOf),
    } as unknown as CorpusDataset
  }
  if (Object.keys(tiers).length === 0)
    throw new Error('empty frozen quality corpus tiers')
  return { seed: source.seed as number, tiers, sha256 }
}

export function qualityCorpus(id: QualityId) {
  return {
    id,
    get seeds() {
      return [readQualityCorpus(id).seed]
    },
    get tiers() {
      return Object.keys(readQualityCorpus(id).tiers).map(Number)
    },
    get kinds() {
      return [
        ...new Set(
          Object.values(readQualityCorpus(id).tiers).flatMap(tier =>
            tier.queries.map(query => query.kind),
          ),
        ),
      ]
    },
    get pooledKinds() {
      return this.kinds.filter(kind => kind.startsWith('positive-'))
    },
    get answerKinds() {
      return this.kinds
    },
    build(tier: number, seed: number): CorpusDataset {
      const corpus = readQualityCorpus(id)
      const data = corpus.tiers[String(tier)]
      if (seed !== corpus.seed || data === undefined)
        throw new Error('sealed quality corpus has no requested seed/tier')
      return data
    },
    digest() {
      return readQualityCorpus(id).sha256
    },
  } as const
}
