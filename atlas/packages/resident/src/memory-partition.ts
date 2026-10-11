// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isMemoryOwner } from '@qianmo/capability'
import { createHash } from 'node:crypto'
import {
  type FileMemoryStore,
  type MemoryEntry,
  type MemoryScope,
  type WorkingScope,
} from '@qianmo/memory'
import { isValidSegment } from '@qianmo/protocol'
import {
  DEFAULT_CONTEXT,
  contextOfSessionKey,
  sessionKeyOf,
} from './session-key.js'

export const RESIDENT_MEMORY_KINDS = [
  'preference',
  'plan',
  'project',
  'daily',
] as const
export type ResidentMemoryKind = (typeof RESIDENT_MEMORY_KINDS)[number]
export type ResidentMemoryPartition =
  | {
      readonly scope: 'conversation'
      readonly agent: string
      readonly contextId: string | undefined
      readonly owner?: string
    }
  | { readonly scope: 'long'; readonly agent: string; readonly owner: string }

function segment(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,61}$/.test(value)
    ? `v-${value}`
    : `d-${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)}`
}

export { isMemoryOwner as validMemoryOwner }

/** Session keys always start v-/d-; long keys always start l-. No raw context can collide. */
export function resolveMemoryPartition(
  target: ResidentMemoryPartition,
): WorkingScope {
  if (!isValidSegment(target.agent)) throw new Error('invalid memory agent')
  const projectKey = segment(target.agent)
  if (target.scope === 'long') {
    if (!isMemoryOwner(target.owner))
      throw new Error('long memory requires a verified account')
    return {
      layer: 'working',
      projectKey,
      taskId:
        target.owner === 'legacy:admin'
          ? 'l-admin'
          : `l-${target.owner.slice(2)}`,
    }
  }
  const context =
    contextOfSessionKey(
      sessionKeyOf(target.agent, target.contextId, target.owner),
    ) ?? DEFAULT_CONTEXT
  return { layer: 'working', projectKey, taskId: segment(context) }
}

export type ParsedMemoryPartition =
  | {
      readonly scope: 'long'
      readonly agentKey: string
      readonly owner: string
    }
  | {
      readonly scope: 'conversation'
      readonly agentKey: string
      readonly contextKey: string
    }

/** Validates stored namespaces, including old conversation partitions. */
export function parseMemoryPartition(
  scope: MemoryScope,
): ParsedMemoryPartition | null {
  if (
    scope.layer !== 'working' ||
    !/^(?:v-[A-Za-z0-9][A-Za-z0-9._-]{0,61}|d-[0-9a-f]{32})$/.test(
      scope.projectKey,
    )
  )
    return null
  if (scope.taskId === 'l-admin')
    return { scope: 'long', agentKey: scope.projectKey, owner: 'legacy:admin' }
  if (/^l-[0-9a-f]{16}$/.test(scope.taskId))
    return {
      scope: 'long',
      agentKey: scope.projectKey,
      owner: `u:${scope.taskId.slice(2)}`,
    }
  if (
    /^(?:v-[A-Za-z0-9][A-Za-z0-9._-]{0,61}|d-[0-9a-f]{32})$/.test(scope.taskId)
  )
    return {
      scope: 'conversation',
      agentKey: scope.projectKey,
      contextKey: scope.taskId,
    }
  return null
}

export class MemoryPartitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryPartitionError'
  }
}

export function requireMemoryPartition(
  store: FileMemoryStore,
  target: ResidentMemoryPartition,
  id: string,
): MemoryEntry {
  const expected = resolveMemoryPartition(target)
  const entry = store.getEntry(id)
  if (
    !entry ||
    entry.scope.layer !== 'working' ||
    entry.scope.projectKey !== expected.projectKey ||
    entry.scope.taskId !== expected.taskId
  )
    throw new MemoryPartitionError(`no memory entry ${id} in this partition`)
  return entry
}
