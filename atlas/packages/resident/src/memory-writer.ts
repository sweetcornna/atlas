// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Writing into the memory partition a resident turn reads (design
 * `memory-m1.md` §6.4, P16.W).
 *
 * Before this module nothing in production wrote memory at all, so the working
 * layer of every resident node was empty and the sidecar returned `''` on every
 * turn. There are two writers in M1 and both go through here:
 *
 *   1. `qm memory add / revoke / invalidate` — an operator on the node itself
 *      (`node/src/commands/memory.ts`), `source.kind = 'user'`;
 *   2. an agent-side write tool — `source.kind = 'agent'`, one approval per
 *      write (P14), enabled only with the signed approval bridge.
 *
 * WHY THE PARTITION IS COMPUTED HERE AND NOT BY THE CALLER
 *
 * The directory an entry lands in is `resolveMemoryPartition(target)` —
 * the same typed resolver the sidecar reads with. Writing through the same function is
 * what makes "the operator wrote it, the next turn of that context sees it" a
 * property of the code rather than of two call sites agreeing. A caller that
 * built its own `{ projectKey, taskId }` could put a memory in a directory no
 * turn ever recalls, and nothing would say so.
 *
 * WHAT IS NOT DONE ON THE WAY IN
 *
 * The text is stored as given. Entry content is neutralized where it becomes
 * framing — `renderEntry`, the single exit into any prompt (P16.0, invariant
 * I-8) — so escaping it here as well would show operators a rewritten body and
 * run the neutralizer twice on the way out.
 */

import type { FileMemoryStore, MemoryEntry, WorkingScope } from '@qianmo/memory'
import {
  resolveMemoryPartition,
  requireMemoryPartition,
  type ResidentMemoryKind,
  MemoryPartitionError,
} from './memory-partition.js'

/** Which partition: one agent of this node, one requester context. */
export interface ResidentMemoryTarget {
  readonly owner?: string
  readonly agent: string
  /**
   * Required and non-empty. `sessionKeyOf` folds an empty context into
   * `default`, which would make "no context given" silently mean "the default
   * bucket"; a write has to name the bucket it goes to.
   */
  readonly contextId: string
}

/**
 * The only two provenances a resident partition accepts. `session`, `archive`
 * and `import` belong to other writers (the sedimentation task, bulk loads),
 * and letting them in here would make the trust level of an entry a matter of
 * what the caller claimed.
 */
export interface ResidentMemorySource {
  readonly kind: 'user' | 'agent'
  readonly id: string
}

/**
 * Host-owned memory write. Long writes require the verified owner supplied by the host.
 */
interface ResidentMemoryWrite extends ResidentMemoryTarget {
  readonly scope?: 'long'
  readonly kind?: ResidentMemoryKind
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly tags?: readonly string[]
  /** Event axis: when the fact became true. Defaults to the write time. */
  readonly validAt?: Date
  /** Event axis: a known end, for a fact that expires (§6.2 row 1). */
  readonly invalidAt?: Date | null
  readonly source: ResidentMemorySource
}

/**
 * Refusals that are the caller's to fix: an unnamed context, an entry that is
 * not in the named partition. Store-level failures (`MemoryStoreError`,
 * `MemoryValidationError`) pass through unchanged.
 */
export class ResidentMemoryWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResidentMemoryWriteError'
  }
}

/** The working-layer scope a `(agent, contextId)` pair reads and writes. */
export function residentMemoryScope(
  target: ResidentMemoryTarget,
): WorkingScope {
  if (target.contextId.length === 0) {
    throw new ResidentMemoryWriteError(
      'a memory write needs an explicit context; an empty one is not "default"',
    )
  }
  return resolveMemoryPartition({ ...target, scope: 'conversation' })
}

const RESIDENT_SOURCE_KINDS: ReadonlySet<string> = new Set(['user', 'agent'])

/** Persist one entry into the partition the target's turns recall from. */
export function writeResidentMemory(
  store: FileMemoryStore,
  write: ResidentMemoryWrite,
): MemoryEntry {
  // Checked at run time as well: the agent-side writer's input crosses a
  // process boundary, where the type above is only a hope.
  if (!RESIDENT_SOURCE_KINDS.has(write.source.kind)) {
    throw new ResidentMemoryWriteError(
      `a resident memory write must come from a user or an agent (got ${JSON.stringify(write.source.kind)})`,
    )
  }
  return store.write({
    scope:
      write.scope === 'long'
        ? resolveMemoryPartition({
            scope: 'long',
            agent: write.agent,
            owner: write.owner ?? '',
          })
        : residentMemoryScope(write),
    title: write.title,
    summary: write.summary,
    body: write.body,
    source: { kind: write.source.kind, id: write.source.id },
    tags: [
      ...(write.tags ?? []).filter(
        tag =>
          write.kind === undefined || !tag.toLowerCase().startsWith('kind:'),
      ),
      ...(write.kind === undefined ? [] : [`kind:${write.kind}`]),
    ],
    ...(write.validAt === undefined ? {} : { validAt: write.validAt }),
    ...(write.invalidAt === undefined ? {} : { invalidAt: write.invalidAt }),
  })
}

/**
 * Withdraw an entry — the ingest axis (`FileMemoryStore.revoke`). It stops
 * being recalled at every `asOf` and stays on disk for audit. For "this fact
 * stopped being true" use {@link invalidateResidentMemory} instead.
 */
export function revokeResidentMemory(
  store: FileMemoryStore,
  request: ResidentMemoryTarget & {
    readonly id: string
    readonly reason: string
    readonly by: string
  },
): MemoryEntry {
  try {
    requireMemoryPartition(
      store,
      { ...request, scope: 'conversation' },
      request.id,
    )
  } catch (error) {
    if (!(error instanceof MemoryPartitionError)) throw error
    throw new ResidentMemoryWriteError(
      `no memory entry ${request.id} in this agent and context`,
    )
  }
  return store.revoke(request.id, { reason: request.reason, by: request.by })
}

/**
 * Record that the fact stopped being true — the event axis
 * (`FileMemoryStore.invalidate`). Questions about earlier moments still see it.
 */
export function invalidateResidentMemory(
  store: FileMemoryStore,
  request: ResidentMemoryTarget & { readonly id: string; readonly at?: Date },
): MemoryEntry {
  try {
    requireMemoryPartition(
      store,
      { ...request, scope: 'conversation' },
      request.id,
    )
  } catch (error) {
    if (!(error instanceof MemoryPartitionError)) throw error
    throw new ResidentMemoryWriteError(
      `no memory entry ${request.id} in this agent and context`,
    )
  }
  return store.invalidate(request.id, request.at)
}
