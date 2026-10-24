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
import { readTextIfExists, writePrivateJson } from '../providers/store.js'

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

/** The ledger and node actor of the hub's own default grants. */
export const SYSTEM_ELEVATION_SUBJECT = 'system:elevation'
/** A default grant runs as long and as often as one grant may (P39 §6). */
const DEFAULT_GRANT_TTL_MS = 24 * 60 * 60_000
const DEFAULT_GRANT_CALLS = 2000
const SWEEP_MS = 30_000
/** After a refusal (ESTOP, external runtime), the agent is left alone this long. */
const RETRY_MS = 10 * 60_000

export interface ElevationDefaultsOptions {
  /** The tier an agent at `off` is opened at. */
  readonly tier: Exclude<ElevationTierName, 'off'>
  /** Where the agents a person turned off are kept across hub restarts. */
  readonly statePath: string
  readonly now?: () => number
  readonly sweepMs?: number
  readonly onError?: (message: string) => void
}

/**
 * The hub's default permission mode (`--elevation-default`). The node keeps
 * P39's rules — every grant expires, is bounded in calls and is gone after a
 * restart — and the hub opens the default again on every agent it finds at
 * `off`, as `system:elevation`. A person's choice wins: turning an agent off or
 * revoking it holds it at 人工确认 until a person picks a tier again; a tier a
 * person opens expires back to the default. Holds live in {@link
 * ElevationDefaultsOptions.statePath}; nothing else is kept here.
 */
export class ElevationDefaults implements ElevationPort {
  readonly #inner: ElevationPort
  readonly #options: ElevationDefaultsOptions
  readonly #now: () => number
  readonly #held: Set<string>
  /** When a person last changed an agent; a sweep that read before it skips it. */
  readonly #touched = new Map<string, number>()
  readonly #retryAt = new Map<string, number>()
  /**
   * The holds could not be read: which agents a person turned off is
   * unknown, so nothing is opened until the file is fixed.
   */
  readonly #unreadable: boolean
  #timer: Timer | undefined
  #sweeping = false
  #closed = false

  constructor(inner: ElevationPort, options: ElevationDefaultsOptions) {
    this.#inner = inner
    this.#options = options
    this.#now = options.now ?? Date.now
    const text = readTextIfExists(options.statePath)
    let held: unknown = []
    try {
      held =
        text === undefined
          ? []
          : (JSON.parse(text) as { held?: unknown } | null)?.held
    } catch {
      held = undefined
    }
    this.#unreadable =
      !Array.isArray(held) || held.some(k => typeof k !== 'string')
    this.#held = new Set(this.#unreadable ? [] : (held as string[]))
  }

  #hold(key: string, on: boolean): void {
    this.#touched.set(key, this.#now())
    if (this.#unreadable || on === this.#held.has(key)) return
    if (on) this.#held.add(key)
    else this.#held.delete(key)
    writePrivateJson(this.#options.statePath, { held: [...this.#held].sort() })
  }

  async list(): Promise<ConsoleResult<readonly ElevationNodeView[]>> {
    const r = await this.#inner.list()
    if (!r.ok) return r
    return ok(
      r.value.map(row => ({
        ...row,
        defaultTier: this.#options.tier,
        defaultHeld: this.#held.has(`${row.node}/${row.agent}`),
      })),
    )
  }
  async set(
    ref: AgentRef,
    change: {
      readonly tier: ElevationTierName
      readonly ttlMs?: number
      readonly maxCalls?: number
    },
    actor: ElevationActor,
  ): Promise<ConsoleResult<ElevationNodeView>> {
    const key = `${ref.node}/${ref.agent}`
    // Turning off holds even when the node's answer is lost: the intent is
    // what keeps the default from coming back.
    if (change.tier === 'off') this.#hold(key, true)
    const r = await this.#inner.set(ref, change, actor)
    if (r.ok && change.tier !== 'off') this.#hold(key, false)
    return r
  }
  revoke(
    ref: AgentRef,
    actor: ElevationActor,
  ): Promise<ConsoleResult<ElevationNodeView>> {
    this.#hold(`${ref.node}/${ref.agent}`, true)
    return this.#inner.revoke(ref, actor)
  }
  actions(
    ref: AgentRef | null,
    limit: number,
  ): Promise<ConsoleResult<readonly ElevationActionView[]>> {
    return this.#inner.actions(ref, limit)
  }

  /** One pass: open the default on every reachable agent found at `off`. */
  async sweep(): Promise<void> {
    if (this.#sweeping || this.#closed || this.#unreadable) return
    this.#sweeping = true
    try {
      const startedAt = this.#now()
      const list = await this.#inner.list()
      if (!list.ok) return
      for (const row of list.value) {
        const key = `${row.node}/${row.agent}`
        if (
          this.#closed ||
          !row.reachable ||
          row.tier !== 'off' ||
          row.unsupportedReason ||
          this.#held.has(key) ||
          (this.#touched.get(key) ?? -Infinity) >= startedAt ||
          (this.#retryAt.get(key) ?? 0) > this.#now()
        )
          continue
        const r = await this.#inner.set(
          { node: row.node, agent: row.agent },
          {
            tier: this.#options.tier,
            ttlMs: DEFAULT_GRANT_TTL_MS,
            maxCalls: DEFAULT_GRANT_CALLS,
          },
          {
            subject: SYSTEM_ELEVATION_SUBJECT,
            role: null,
            requestId: crypto.randomUUID(),
          },
        )
        if (r.ok) this.#retryAt.delete(key)
        else {
          this.#retryAt.set(key, this.#now() + RETRY_MS)
          this.#options.onError?.(
            `qianmo://${key} 按默认档开启失败：${r.failure.message}；10 分钟后再试`,
          )
        }
      }
    } finally {
      this.#sweeping = false
    }
  }

  start(): void {
    if (this.#timer || this.#closed) return
    if (this.#unreadable) {
      this.#options.onError?.(
        `${this.#options.statePath} 读不出来：哪些智能体被人手动关掉不明，默认档暂停，修好或删掉这个文件后重启中枢`,
      )
      return
    }
    void this.sweep().catch(() => {})
    this.#timer = setInterval(() => {
      void this.sweep().catch(() => {})
    }, this.#options.sweepMs ?? SWEEP_MS)
    this.#timer.unref()
  }

  close(): void {
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
  }
}
