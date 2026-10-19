// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  ActionLedgerPort,
  AgentRef,
  ConsoleResult,
  ElevationActionView,
  ElevationActor,
  ElevationNodeView,
  ElevationPort,
  ElevationTierName,
} from '@qianmo/console'
import type { ControlLinks } from './consoleControl.js'
import type { ControlOutcome } from '@qianmo/protocol'

const ok = <T>(value: T): ConsoleResult<T> => ({ ok: true, value })
const failed = <T>(message: string): ConsoleResult<T> => ({
  ok: false,
  failure: { code: 'rejected', message },
})

function isNodeView(value: unknown, node: string): value is ElevationNodeView {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    v.node === node &&
    typeof v.agent === 'string' &&
    typeof v.tier === 'string' &&
    typeof v.epoch === 'number'
  )
}

/** The hub drives the node's `elevation.*` control face; no omp runs here. */
export class ConsoleElevation implements ElevationPort {
  readonly #links: Pick<ControlLinks, 'request' | 'status'>
  readonly #ledger: ActionLedgerPort | undefined
  readonly #cache = new Map<string, readonly ElevationNodeView[]>()
  constructor(
    links: Pick<ControlLinks, 'request' | 'status'>,
    ledger?: ActionLedgerPort,
  ) {
    this.#links = links
    this.#ledger = ledger
  }
  async list(): Promise<ConsoleResult<readonly ElevationNodeView[]>> {
    const rows = await Promise.all(
      this.#links.status().map(async s => {
        const r = await this.#links.request(
          s.node,
          'elevation.status',
          {},
          'console:read',
        )
        if (
          r.ok &&
          Array.isArray(r.value) &&
          r.value.every(v => isNodeView(v, s.node))
        )
          this.#cache.set(s.node, r.value as ElevationNodeView[])
        return (this.#cache.get(s.node) ?? []).map(row => ({
          ...row,
          reachable: r.ok,
        }))
      }),
    )
    return ok(rows.flat())
  }
  async #write(
    ref: AgentRef,
    op: 'elevation.enable' | 'elevation.disable' | 'elevation.revoke',
    change: Record<string, unknown>,
    actor: ElevationActor,
  ): Promise<ConsoleResult<ElevationNodeView>> {
    let result: ControlOutcome
    try {
      result = await this.#links.request(
        ref.node,
        op,
        { ...change, agent: ref.agent, operationId: actor.requestId },
        actor.subject,
        { timeoutMs: 30000, beforeDispatch: actor.beforeDispatch },
      )
    } catch {
      result = { ok: false, code: 'internal', message: '节点控制失败' }
    }
    await this.#ledger?.record({
      action: op,
      target: `qianmo://${ref.node}/${ref.agent}`,
      subject: actor.subject,
      requestId: actor.requestId,
      at: Date.now(),
      outcome: result.ok ? 'ok' : 'failed',
      ...(result.ok ? {} : { code: result.code }),
    })
    if (!result.ok)
      return {
        ok: false,
        failure: {
          code:
            result.code === 'unreachable' || result.code === 'timeout'
              ? 'unreachable'
              : result.code === 'unsupported'
                ? 'unsupported'
                : result.code === 'invalid'
                  ? 'invalid'
                  : 'refused',
          message: result.message,
          ...(result.code === 'timeout'
            ? { deliveryUnknown: true as const }
            : {}),
        },
      }
    if (!isNodeView(result.value, ref.node) || result.value.agent !== ref.agent)
      return failed('节点返回了无效的放权状态')
    return ok(result.value)
  }
  set(
    ref: AgentRef,
    change: {
      readonly tier: ElevationTierName
      readonly ttlMs?: number
      readonly maxCalls?: number
    },
    actor: ElevationActor,
  ): Promise<ConsoleResult<ElevationNodeView>> {
    if (change.tier === 'off')
      return this.#write(ref, 'elevation.disable', {}, actor)
    return this.#write(
      ref,
      'elevation.enable',
      {
        tier: change.tier,
        ...(change.ttlMs === undefined ? {} : { ttlMs: change.ttlMs }),
        ...(change.maxCalls === undefined ? {} : { maxCalls: change.maxCalls }),
      },
      actor,
    )
  }
  revoke(
    ref: AgentRef,
    actor: ElevationActor,
  ): Promise<ConsoleResult<ElevationNodeView>> {
    return this.#write(ref, 'elevation.revoke', {}, actor)
  }
  async actions(
    ref: AgentRef | null,
    limit: number,
  ): Promise<ConsoleResult<readonly ElevationActionView[]>> {
    const states = this.#links.status().filter(s => !ref || s.node === ref.node)
    const rows = await Promise.all(
      states.map(async s => {
        const r = await this.#links.request(
          s.node,
          'elevation.actions',
          { ...(ref ? { agent: ref.agent } : {}), limit },
          'console:read',
        )
        return r.ok && Array.isArray(r.value)
          ? (r.value as ElevationActionView[]).filter(
              a => a.node === s.node && (!ref || a.agent === ref.agent),
            )
          : []
      }),
    )
    return ok(
      rows
        .flat()
        .sort((a, b) => b.at - a.at)
        .slice(0, limit),
    )
  }
}
