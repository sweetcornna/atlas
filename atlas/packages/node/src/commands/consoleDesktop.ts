// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  ActionLedgerPort,
  AgentRef,
  DesktopActionView,
  DesktopNodeView,
  DesktopPort,
  DesktopActor,
  ConsoleResult,
} from '@qianmo/console'
import type { ControlLinks } from './consoleControl.js'
import type { ControlOutcome } from '@qianmo/protocol'
const ok = <T>(value: T): ConsoleResult<T> => ({ ok: true, value })
const failed = <T>(message: string): ConsoleResult<T> => ({
  ok: false,
  failure: { code: 'rejected', message },
})
/** The hub only calls authenticated control links; no omp modules run here. */
export class ConsoleDesktop implements DesktopPort {
  readonly #links: Pick<ControlLinks, 'request' | 'status'>
  readonly #ledger: ActionLedgerPort | undefined
  readonly #cache = new Map<string, readonly DesktopNodeView[]>()
  constructor(
    links: Pick<ControlLinks, 'request' | 'status'>,
    ledger?: ActionLedgerPort,
  ) {
    this.#links = links
    this.#ledger = ledger
  }
  async list(): Promise<ConsoleResult<readonly DesktopNodeView[]>> {
    const rows = await Promise.all(
      this.#links.status().map(async s => {
        const r = await this.#links.request(
          s.node,
          'desktop.status',
          {},
          'console:read',
        )
        if (
          r.ok &&
          Array.isArray(r.value) &&
          r.value.every(
            v =>
              v &&
              typeof v === 'object' &&
              v.node === s.node &&
              typeof v.agent === 'string' &&
              v.browser &&
              v.computer,
          )
        )
          this.#cache.set(s.node, r.value as DesktopNodeView[])
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
    op: string,
    change: Record<string, unknown>,
    actor: DesktopActor,
  ): Promise<ConsoleResult<DesktopNodeView>> {
    const operationId = actor.requestId
    let result: ControlOutcome
    try {
      result = await this.#links.request(
        ref.node,
        op,
        { ...change, agent: ref.agent, operationId },
        actor.subject,
        { timeoutMs: 30000, beforeDispatch: actor.beforeDispatch },
      )
    } catch {
      result = { ok: false, code: 'internal', message: '节点控制失败' }
    }
    await this.#ledger?.record({
      action: op === 'desktop.recycle' ? 'desktop.recycle' : 'desktop.set',
      target: `qianmo://${ref.node}/${ref.agent}`,
      subject: actor.subject,
      requestId: actor.requestId,
      at: Date.now(),
      outcome: result.ok ? 'ok' : 'failed',
      ...(result.ok ? {} : { detail: result.code }),
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
    if (
      !result.value ||
      typeof result.value !== 'object' ||
      (result.value as DesktopNodeView).node !== ref.node ||
      (result.value as DesktopNodeView).agent !== ref.agent
    )
      return failed('节点返回了无效资源')
    return ok(result.value as DesktopNodeView)
  }
  set(
    ref: AgentRef,
    change: Parameters<DesktopPort['set']>[1],
    actor: DesktopActor,
  ): Promise<ConsoleResult<DesktopNodeView>> {
    return this.#write(
      ref,
      (change.browser === false || change.computer === false) &&
        change.browser !== true &&
        change.computer !== true &&
        change.confirm === undefined
        ? 'desktop.disable'
        : 'desktop.enable',
      change,
      actor,
    )
  }
  recycle(
    ref: AgentRef,
    actor: DesktopActor,
  ): Promise<ConsoleResult<DesktopNodeView>> {
    return this.#write(ref, 'desktop.recycle', {}, actor)
  }
  async actions(
    ref: AgentRef | null,
    limit: number,
  ): Promise<ConsoleResult<readonly DesktopActionView[]>> {
    const states = this.#links.status().filter(s => !ref || s.node === ref.node)
    const rows = await Promise.all(
      states.map(async s => {
        const r = await this.#links.request(
          s.node,
          'desktop.actions',
          { ...(ref ? { agent: ref.agent } : {}), limit },
          'console:read',
        )
        return r.ok && Array.isArray(r.value)
          ? (r.value as DesktopActionView[]).filter(
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
