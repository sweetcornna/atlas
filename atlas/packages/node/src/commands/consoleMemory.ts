// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  MEMORY_KINDS,
  type AgentRef,
  type ConsoleResult,
  type DirectionActor,
  type MemoryDraft,
  type MemoryEntryView,
  type MemoryKind,
  type MemoryPort,
  type MemoryQueryInput,
  type RegistryPort,
} from '@qianmo/console'
import {
  isValidSegment,
  parseAddress,
  type ControlOutcome,
} from '@qianmo/protocol'
import type { ControlLinks } from './consoleControl.js'

export interface MemoryListPage {
  readonly entries: readonly MemoryEntryView[]
  readonly total: number
  readonly counts: Readonly<Record<MemoryKind, number>>
  readonly nextOffset: number | null
}

export interface MemoryLinks {
  request: ControlLinks['request']
  status: ControlLinks['status']
}
const fail = <T>(
  code:
    | 'unreachable'
    | 'refused'
    | 'not_found'
    | 'invalid'
    | 'unsupported'
    | 'rejected',
  message: string,
): ConsoleResult<T> => ({ ok: false, failure: { code, message } })
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function entry(
  value: unknown,
  ref: AgentRef,
  actor: DirectionActor,
): value is MemoryEntryView {
  if (
    !object(value) ||
    value.node !== ref.node ||
    value.agent !== ref.agent ||
    value.owner !== actor.subject ||
    value.scope !== 'long' ||
    value.contextId !== null
  )
    return false
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.summary === 'string' &&
    typeof value.body === 'string' &&
    (value.kind === null || MEMORY_KINDS.includes(value.kind as MemoryKind)) &&
    Array.isArray(value.tags) &&
    value.tags.every(tag => typeof tag === 'string') &&
    object(value.source) &&
    typeof value.source.kind === 'string' &&
    typeof value.source.id === 'string' &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    [value.validAt, value.invalidAt].every(
      at => at === null || (typeof at === 'number' && Number.isFinite(at)),
    ) &&
    (value.retired === null ||
      (object(value.retired) &&
        ['revoked', 'archived'].includes(String(value.retired.kind)) &&
        typeof value.retired.reason === 'string' &&
        typeof value.retired.by === 'string')) &&
    [value.supersedes, value.supersededBy].every(
      id => id === null || typeof id === 'string',
    )
  )
}

/** The console creates operation ids. Caller-supplied JSON never chooses one. */
export class ConsoleMemory implements MemoryPort {
  readonly #links: MemoryLinks
  readonly #registry: RegistryPort | undefined
  readonly #roster = new Map<string, readonly AgentRef[]>()
  constructor(options: {
    readonly links: MemoryLinks
    readonly registry?: RegistryPort
  }) {
    this.#links = options.links
    this.#registry = options.registry
  }

  async #call(
    ref: AgentRef,
    op: string,
    args: Record<string, unknown>,
    actor: DirectionActor,
  ): Promise<ConsoleResult<unknown>> {
    if (
      !this.#links.status().some(row => row.node === ref.node) ||
      !isValidSegment(ref.agent)
    )
      return fail('not_found', '智能体不存在')
    let result: ControlOutcome
    try {
      result = await this.#links.request(
        ref.node,
        op,
        { ...args, agent: ref.agent, owner: actor.subject },
        actor.subject,
      )
    } catch {
      return fail('unreachable', '节点记忆操作结果未知；请查看列表核对')
    }
    if (result.ok) return result
    if (['timeout', 'unreachable', 'hub-unavailable'].includes(result.code))
      return fail('unreachable', '节点记忆操作结果未知；请查看列表核对')
    if (
      result.code === 'not_found' ||
      result.code === 'invalid' ||
      result.code === 'unsupported' ||
      result.code === 'rejected' ||
      result.code === 'refused'
    )
      return fail(result.code, result.message)
    return fail('refused', '节点拒绝记忆操作')
  }

  async agents(): Promise<
    ConsoleResult<readonly (AgentRef & { readonly reachable: boolean })[]>
  > {
    const statuses = this.#links.status()
    const listed = await this.#registry?.list()
    if (listed?.ok) {
      for (const state of statuses) {
        const refs = listed.value.flatMap(row => {
          const parsed = parseAddress(row.address)
          return parsed?.node === state.node && parsed.agent !== 'console'
            ? [{ node: parsed.node, agent: parsed.agent }]
            : []
        })
        if (refs.length) this.#roster.set(state.node, refs)
      }
    }
    const results = await Promise.all(
      statuses.map(async state => {
        let reachable = state.connected
        if (reachable) {
          const refs: AgentRef[] = []
          let offset: number | null = 0
          try {
            while (offset !== null) {
              const page = await this.#links.request(
                state.node,
                'memory.agents',
                { offset, limit: 200 },
                'legacy:admin',
              )
              if (
                !page.ok ||
                !object(page.value) ||
                !Array.isArray(page.value.agents) ||
                !page.value.agents.every(
                  ref =>
                    object(ref) &&
                    ref.node === state.node &&
                    typeof ref.agent === 'string' &&
                    isValidSegment(ref.agent),
                )
              ) {
                reachable = false
                break
              }
              for (const ref of page.value.agents as AgentRef[])
                refs.push({ node: ref.node, agent: ref.agent })
              const next = page.value.nextOffset
              if (
                next !== null &&
                (typeof next !== 'number' ||
                  !Number.isSafeInteger(next) ||
                  next <= offset ||
                  next !== offset + page.value.agents.length)
              ) {
                reachable = false
                break
              }
              offset = next as number | null
            }
            if (reachable) this.#roster.set(state.node, refs)
          } catch {
            reachable = false
          }
        }
        return (this.#roster.get(state.node) ?? []).map(ref => ({
          ...ref,
          reachable,
        }))
      }),
    )
    return { ok: true, value: results.flat() }
  }

  async list(
    input: MemoryQueryInput,
    actor: DirectionActor,
  ): Promise<ConsoleResult<MemoryListPage>> {
    const { node: _node, agent: _agent, ...query } = input
    const result = await this.#call(input, 'memory.list', query, actor)
    if (!result.ok) return result
    const value = result.value
    if (
      !object(value) ||
      !Array.isArray(value.entries) ||
      !value.entries.every(one => entry(one, input, actor)) ||
      typeof value.total !== 'number' ||
      !Number.isSafeInteger(value.total) ||
      value.total < value.entries.length ||
      !object(value.counts) ||
      !MEMORY_KINDS.every(
        kind =>
          Number.isSafeInteger(
            value.counts && (value.counts as Record<string, unknown>)[kind],
          ) && Number((value.counts as Record<string, unknown>)[kind]) >= 0,
      ) ||
      (value.nextOffset !== null &&
        (typeof value.nextOffset !== 'number' ||
          !Number.isSafeInteger(value.nextOffset) ||
          value.nextOffset <= (input.offset ?? 0)))
    )
      return fail<never>('unreachable', '节点返回了无效记忆列表')
    return {
      ok: true as const,
      value: {
        entries: value.entries as MemoryEntryView[],
        total: value.total,
        counts: value.counts as Record<MemoryKind, number>,
        nextOffset: value.nextOffset as number | null,
      },
    }
  }

  async #write(
    ref: AgentRef,
    op: string,
    args: Record<string, unknown>,
    actor: DirectionActor,
  ): Promise<ConsoleResult<MemoryEntryView>> {
    const result = await this.#call(
      ref,
      op,
      { ...args, operationId: crypto.randomUUID(), requestId: actor.requestId },
      actor,
    )
    if (!result.ok) return result
    return entry(result.value, ref, actor)
      ? { ok: true, value: result.value }
      : fail(
          'unreachable',
          '记忆操作结果未知：节点返回无效结果；请查看列表核对',
        )
  }
  add(ref: AgentRef, draft: MemoryDraft, actor: DirectionActor) {
    return this.#write(ref, 'memory.add', { draft }, actor)
  }
  edit(ref: AgentRef, id: string, draft: MemoryDraft, actor: DirectionActor) {
    return this.#write(ref, 'memory.edit', { id, draft }, actor)
  }
  forget(ref: AgentRef, id: string, reason: string, actor: DirectionActor) {
    return this.#write(ref, 'memory.forget', { id, reason }, actor)
  }
  invalidate(ref: AgentRef, id: string, actor: DirectionActor) {
    return this.#write(ref, 'memory.invalidate', { id }, actor)
  }
}
