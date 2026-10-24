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
import {
  acquirePrivateInstanceLock,
  type PrivateInstanceLock,
  readTextIfExists,
  writePrivateJson,
} from '../providers/store.js'

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
/** One status read per node per pass; each is a line in the node's audit trail. */
const SWEEP_MS = 60_000
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
 *
 * Every change to one agent — a person's or the sweep's — runs one at a time,
 * and the sweep looks again under that agent's turn, so a person's pick that
 * was on its way when the sweep read the nodes is never overwritten.
 */
export class ElevationDefaults implements ElevationPort {
  readonly #inner: ElevationPort
  readonly #options: ElevationDefaultsOptions
  readonly #now: () => number
  readonly #held: Set<string>
  /** When a person last started or finished a change to an agent. */
  readonly #touched = new Map<string, number>()
  readonly #retryAt = new Map<string, number>()
  readonly #turns = new Map<string, Promise<unknown>>()
  /**
   * Why the default is paused: the holds could not be read, so which agents a
   * person turned off is unknown, or another hub process owns the file.
   * Nothing is opened and nothing is written while it is set.
   */
  readonly #paused: string | undefined
  readonly #lock: PrivateInstanceLock | null = null
  /** Said once at start: the lock file could not be made (the disk, not a rival). */
  readonly #lockProblem: string | undefined
  #timer: Timer | undefined
  #sweeping = false
  #closed = false

  constructor(inner: ElevationPort, options: ElevationDefaultsOptions) {
    this.#inner = inner
    this.#options = options
    this.#now = options.now ?? Date.now
    let held: unknown = []
    try {
      const text = readTextIfExists(options.statePath)
      held =
        text === undefined
          ? []
          : (JSON.parse(text) as { held?: unknown } | null)?.held
    } catch {
      held = undefined
    }
    const readable =
      Array.isArray(held) && held.every(k => typeof k === 'string')
    this.#held = new Set(readable ? (held as string[]) : [])
    if (!readable)
      this.#paused = `${options.statePath} 读不出来：哪些智能体被人手动关掉不明，默认档暂停；修好这个文件后重启中枢（删掉它会让此前手动关掉的智能体重新按默认档开启）`
    else {
      try {
        this.#lock = acquirePrivateInstanceLock(`${options.statePath}.lock`)
        if (!this.#lock)
          this.#paused = `${options.statePath} 由另一个中枢进程持有：本进程不按默认档开启，也不记录手动关闭`
      } catch (error) {
        this.#lockProblem = `${options.statePath}.lock 建不出来（${
          error instanceof Error ? error.message : String(error)
        }）：照常按默认档开启，手动关闭可能写不进记录`
      }
    }
  }

  /** One agent's changes, one at a time. */
  #serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const before = this.#turns.get(key) ?? Promise.resolve()
    const mine = before.then(run, run)
    const settled = mine.then(
      () => undefined,
      () => undefined,
    )
    this.#turns.set(key, settled)
    void settled.then(() => {
      if (this.#turns.get(key) === settled) this.#turns.delete(key)
    })
    return mine
  }

  #hold(key: string, on: boolean): void {
    if (this.#paused !== undefined || on === this.#held.has(key)) return
    if (on) this.#held.add(key)
    else this.#held.delete(key)
    // A hold that cannot be written still holds in this process; a person's
    // off or revoke must reach the node whatever the disk says.
    try {
      writePrivateJson(this.#options.statePath, {
        held: [...this.#held].sort(),
      })
    } catch (error) {
      this.#options.onError?.(
        `手动关闭的记录写不进 ${this.#options.statePath}（${
          error instanceof Error ? error.message : String(error)
        }）：本进程内照样不再自动开启，中枢重启后会丢`,
      )
    }
  }

  async list(): Promise<ConsoleResult<readonly ElevationNodeView[]>> {
    const r = await this.#inner.list()
    // A paused default promises nothing, so the rows say nothing about it.
    if (!r.ok || this.#paused !== undefined) return r
    return ok(
      r.value.map(row => ({
        ...row,
        defaultTier: this.#options.tier,
        defaultHeld: this.#held.has(`${row.node}/${row.agent}`),
      })),
    )
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
    const key = `${ref.node}/${ref.agent}`
    this.#touched.set(key, this.#now())
    return this.#serial(key, async () => {
      try {
        if (change.tier !== 'off') {
          const r = await this.#inner.set(ref, change, actor)
          if (r.ok) this.#hold(key, false)
          return r
        }
        // Turning off holds even when the node's answer is lost: the intent
        // is what keeps the default from coming back.
        this.#hold(key, true)
        // Already at 人工确认: holding it is the whole change, and the node's
        // children are left alone.
        if (this.#paused === undefined) {
          const now = await this.#inner.list()
          const row = now.ok
            ? now.value.find(v => v.node === ref.node && v.agent === ref.agent)
            : undefined
          if (row?.reachable && row.tier === 'off')
            return ok({
              ...row,
              defaultTier: this.#options.tier,
              defaultHeld: true,
            })
        }
        return await this.#inner.set(ref, change, actor)
      } finally {
        this.#touched.set(key, this.#now())
      }
    })
  }
  revoke(
    ref: AgentRef,
    actor: ElevationActor,
  ): Promise<ConsoleResult<ElevationNodeView>> {
    const key = `${ref.node}/${ref.agent}`
    this.#touched.set(key, this.#now())
    return this.#serial(key, async () => {
      try {
        this.#hold(key, true)
        return await this.#inner.revoke(ref, actor)
      } finally {
        this.#touched.set(key, this.#now())
      }
    })
  }
  actions(
    ref: AgentRef | null,
    limit: number,
  ): Promise<ConsoleResult<readonly ElevationActionView[]>> {
    return this.#inner.actions(ref, limit)
  }

  /** Whether the sweep may open this agent now; asked again under its turn. */
  #due(key: string, startedAt: number): boolean {
    return (
      !this.#closed &&
      !this.#held.has(key) &&
      (this.#touched.get(key) ?? -Infinity) < startedAt &&
      (this.#retryAt.get(key) ?? 0) <= this.#now()
    )
  }

  /** One pass: open the default on every reachable agent found at `off`. */
  async sweep(): Promise<void> {
    if (this.#sweeping || this.#closed || this.#paused !== undefined) return
    this.#sweeping = true
    try {
      const startedAt = this.#now()
      const list = await this.#inner.list()
      if (!list.ok) return
      for (const row of list.value) {
        const key = `${row.node}/${row.agent}`
        if (
          !row.reachable ||
          row.tier !== 'off' ||
          row.unsupportedReason ||
          !this.#due(key, startedAt)
        )
          continue
        await this.#serial(key, async () => {
          if (!this.#due(key, startedAt)) return
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
        })
      }
    } finally {
      this.#sweeping = false
    }
  }

  start(): void {
    if (this.#timer || this.#closed) return
    if (this.#paused !== undefined) {
      this.#options.onError?.(this.#paused)
      return
    }
    if (this.#lockProblem !== undefined)
      this.#options.onError?.(this.#lockProblem)
    void this.sweep().catch(() => {})
    this.#timer = setInterval(() => {
      void this.sweep().catch(() => {})
    }, this.#options.sweepMs ?? SWEEP_MS)
    this.#timer.unref()
  }

  close(): void {
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    this.#lock?.release()
  }
}
