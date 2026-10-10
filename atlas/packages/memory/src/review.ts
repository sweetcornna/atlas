// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isRecallable, type MemoryEntry } from './entry.js'
import { sameMemoryScope } from './governance.js'

/** Review candidates are evidence for a human, never an automatic verdict.
 * The local matcher folds common decision verbs and uses word/CJK bigrams.
 * A caller with an already computed semantic index may supply pair scores;
 * this pure report never loads an index, calls a model or changes the store.
 */
export type MemoryReviewOptions = {
  readonly asOf: Date
  readonly staleDays?: number
  readonly semanticPairs?: readonly {
    left: string
    right: string
    score: number
  }[]
}

function normalized(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function terms(text: string): Set<string> {
  const words =
    normalized(text)
      .replace(/\b(?:select|choose|prefer|adopt|use)\b/g, 'decision')
      .replace(/(?:选择|采用|选用|使用)/g, '决策')
      .match(/[a-z0-9]+|[\u3400-\u9fff]/g) ?? []
  const result = new Set(words.filter(word => word.length > 1))
  for (let i = 1; i < words.length; i++) {
    if (
      /^[\u3400-\u9fff]$/.test(words[i - 1] ?? '') &&
      /^[\u3400-\u9fff]$/.test(words[i] ?? '')
    )
      result.add(`${words[i - 1]}${words[i]}`)
  }
  return result
}

function similarity(a: string, b: string): number {
  const left = terms(a)
  const right = terms(b)
  const overlap = [...left].filter(term => right.has(term)).length
  return left.size && right.size
    ? overlap / Math.sqrt(left.size * right.size)
    : 0
}

export function buildMemoryReview(
  entries: readonly MemoryEntry[],
  options: MemoryReviewOptions,
) {
  const at = options.asOf.toISOString()
  const staleDays = options.staleDays ?? 90
  if (!Number.isFinite(staleDays) || staleDays < 0)
    throw new Error('staleDays must be a nonnegative number')
  const live = entries
    .filter(entry => isRecallable(entry, at))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const stale = live.flatMap(entry => {
    const ageDays = Math.floor(
      (options.asOf.getTime() - Date.parse(entry.createdAt)) / 86_400_000,
    )
    return ageDays >= staleDays
      ? [{ id: entry.id, ageDays, since: entry.createdAt }]
      : []
  })
  const conflicts: {
    left: string
    right: string
    sharedTags: string[]
    similarity: number
    method: 'local-text' | 'semantic-index'
    reason: 'different-conclusions-to-review'
  }[] = []
  for (let i = 0; i < live.length; i++) {
    const a = live[i]!
    for (const b of live.slice(i + 1)) {
      if (!sameMemoryScope(a.scope, b.scope)) continue
      const sharedTags = [
        ...new Set(a.tags.filter(tag => b.tags.includes(tag))),
      ].sort()
      if (
        !sharedTags.length ||
        normalized(`${a.summary}\n${a.body}`) ===
          normalized(`${b.summary}\n${b.body}`)
      )
        continue
      const external = options.semanticPairs?.find(
        pair =>
          (pair.left === a.id && pair.right === b.id) ||
          (pair.left === b.id && pair.right === a.id),
      )
      const score =
        external?.score ??
        Math.max(
          similarity(a.title, b.title),
          similarity(`${a.summary} ${a.body}`, `${b.summary} ${b.body}`),
        )
      if (!Number.isFinite(score) || score < 0.65 || score > 1) continue
      conflicts.push({
        left: a.id,
        right: b.id,
        sharedTags,
        similarity: Math.round(score * 1000) / 1000,
        method: external ? 'semantic-index' : 'local-text',
        reason: 'different-conclusions-to-review',
      })
    }
  }
  return {
    version: 1 as const,
    asOf: at,
    staleDays,
    evaluated: live.length,
    stale,
    conflicts,
  }
}
