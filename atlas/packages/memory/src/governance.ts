// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  assertKeySegment,
  type MemoryEntry,
  type MemoryScope,
} from './entry.js'

export function sameMemoryScope(a: MemoryScope, b: MemoryScope): boolean {
  if (a.layer !== b.layer) return false
  if (a.layer === 'baseline')
    return b.layer === 'baseline' && a.period === b.period
  if (b.layer === 'baseline' || a.projectKey !== b.projectKey) return false
  return (
    a.layer === 'project' || (b.layer === 'working' && a.taskId === b.taskId)
  )
}

/** Imported/archived provenance is not independently authenticated: protect it
 * like operator input instead of allowing a peer to overwrite it. */
function trust(entry: MemoryEntry): number {
  return entry.source.kind === 'session' || entry.source.kind === 'agent'
    ? 0
    : 1
}

export function validateReplacement(
  newEntry: MemoryEntry,
  old: MemoryEntry,
): void {
  assertKeySegment('superseded id', old.id)
  if (newEntry.id === old.id)
    throw new Error('an entry cannot supersede itself')
  if (!sameMemoryScope(newEntry.scope, old.scope))
    throw new Error('supersedes requires the exact same scope and layer')
  if (
    newEntry.supersedesWriter !== 'operator' &&
    (trust(newEntry) > 0 || trust(old) > 0)
  )
    throw new Error(
      'peer supersedes cannot claim or replace higher-trust provenance',
    )
  if (trust(newEntry) < trust(old))
    throw new Error('supersedes cannot replace higher-trust provenance')
  if (newEntry.validAt < old.validAt)
    throw new Error('replacement validAt must not precede the old validAt')
}
