// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  ActionLedgerPort,
  AgentRef,
  DesktopActionView,
  DesktopNodeView,
  DesktopPort,
  DesktopActor,
  DesktopScreenView,
  ConsoleResult,
} from '@qianmo/console'
import type { ControlLinks } from './consoleControl.js'
import type { ControlOutcome } from '@qianmo/protocol'
const ok = <T>(value: T): ConsoleResult<T> => ({ ok: true, value })
const failed = <T>(message: string): ConsoleResult<T> => ({
  ok: false,
  failure: { code: 'rejected', message },
})
/** runtimes-channels.md §6.6: at most 4 MiB of image, as base64. */
const SCREEN_MAX_BASE64 = Math.ceil((4 * 1024 * 1024) / 3) * 4
const SCREEN_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
]
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
/** What a node from before `desktop.view` answers for an op it does not know. */
const OLD_NODE_REPLY = 'Invalid desktop operation'
function screenOf(value: unknown): DesktopScreenView | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  return Number.isFinite(v.at) &&
    typeof v.mimeType === 'string' &&
    SCREEN_TYPES.includes(v.mimeType) &&
    typeof v.data === 'string' &&
    v.data.length > 0 &&
    v.data.length <= SCREEN_MAX_BASE64 &&
    v.data.length % 4 === 0 &&
    BASE64.test(v.data)
    ? {
        at: v.at as number,
        mimeType: v.mimeType as DesktopScreenView['mimeType'],
        data: v.data,
      }
    : undefined
}
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
    // `desktop.disable` takes nothing but false unit flags; a policy change
    // (confirm, apps, terminal) is an enable that keeps the units as they are.
    const onlyOff =
      Object.keys(change).length > 0 &&
      Object.entries(change).every(
        ([key, value]) =>
          (key === 'browser' || key === 'computer') && value === false,
      )
    return this.#write(
      ref,
      onlyOff ? 'desktop.disable' : 'desktop.enable',
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
  /** The private desktop's latest screenshot, read over `desktop.view`. */
  async view(ref: AgentRef): Promise<ConsoleResult<DesktopScreenView | null>> {
    const r = await this.#links.request(
      ref.node,
      'desktop.view',
      { agent: ref.agent },
      'console:read',
    )
    if (r.ok) {
      const screen = screenOf(r.value)
      return screen === undefined ? failed('节点返回了无效画面') : ok(screen)
    }
    if (
      r.code === 'unsupported' ||
      (r.code === 'invalid' && r.message === OLD_NODE_REPLY)
    )
      return {
        ok: false,
        failure: {
          code: 'unsupported',
          message: '节点版本过旧 · 不能查看画面',
        },
      }
    if (r.code === 'invalid' && r.message.startsWith('控制回执超过'))
      return failed('画面超过控制链路的大小上限')
    return {
      ok: false,
      failure: {
        code:
          r.code === 'unreachable' || r.code === 'timeout'
            ? 'unreachable'
            : r.code === 'invalid'
              ? 'invalid'
              : 'refused',
        message: r.message,
      },
    }
  }
}
