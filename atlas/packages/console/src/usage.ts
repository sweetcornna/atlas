// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type {
  TokenColumns,
  UsageAdmission,
  UsageLimits,
  UsagePolicy,
  UsagePort,
  UsageRow,
  UsageScope,
  UsageSnapshot,
} from './governance.js'

const DAY = 86_400_000
const OFFSET = 8 * 3_600_000
const ZERO: TokenColumns = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
const COLUMNS = ['input', 'output', 'cacheWrite', 'cacheRead'] as const
const terminalKey = (taskId: string, node?: string) =>
  JSON.stringify([taskId, node ?? null])
const dayOf = (at: number) => new Date(at + OFFSET).toISOString().slice(0, 10)
const validCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
function assertPrivateFile(fd: number): void {
  const stat = fstatSync(fd)
  if (
    !stat.isFile() ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  )
    throw new Error('usage state must be a private regular file')
}
function columns(value: unknown): value is TokenColumns {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  return (
    COLUMNS.every(key => validCount((value as Record<string, unknown>)[key])) &&
    Object.keys(value).length === 4
  )
}
function validScope(value: UsageScope): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.subject === 'string' &&
    value.subject.length > 0 &&
    value.subject.length <= 256 &&
    (value.kind === 'person' || value.kind === 'job') &&
    (value.tenant === undefined ||
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.tenant))
  )
}
function buckets(scope: UsageScope): string[] {
  return [
    `${scope.kind}:${scope.subject}`,
    ...(scope.tenant === undefined ? [] : [`tenant:${scope.tenant}`]),
    `global:${scope.kind}`,
  ]
}
interface Reservation {
  readonly node?: string
  readonly id: string
  readonly scope: UsageScope
  readonly expiresAt: number
  readonly sessionId?: string
}
type Event =
  | {
      v: 1
      kind: 'reserve'
      at: number
      day: string
      reservation: Reservation
      sessionId?: string
      operation?: 'message' | 'wake' | 'session'
    }
  | {
      v: 1
      kind: 'finish'
      at: number
      day: string
      id: string
      usage: TokenColumns
    }
  | {
      v: 1
      kind: 'record'
      at: number
      day: string
      id: string
      scope: UsageScope
      usage: TokenColumns
    }
  | {
      v: 1
      kind: 'close'
      at: number
      day: string
      scope: UsageScope
      sessionId: string
    }
  | {
      v: 1
      kind: 'bind'
      at: number
      day: string
      id: string
      taskId: string
      node?: string
    }
  | {
      v: 1
      kind: 'session'
      at: number
      day: string
      id: string
      sessionId: string
    }
  | {
      v: 1
      kind: 'unattributed'
      at: number
      day: string
      id: string
      taskId: string
      usage: TokenColumns
      node?: string
    }
  | {
      v: 1
      kind: 'terminal'
      at: number
      day: string
      taskId: string
      node?: string
    }

interface FileUsageOptions {
  readonly path: string
  readonly policy: UsagePolicy
  readonly now?: () => number
  readonly monotonic?: () => number
  /** Bound lost in-flight reservations after a hub crash; never less than a turn TTL. */
  readonly reservationTtlMs?: number
}

/** Single-writer hub ledger. Every admission is durable before a caller may send. */
export class FileUsageStore implements UsagePort {
  readonly #options: FileUsageOptions
  readonly #now: () => number
  readonly #monotonic: () => number
  readonly #tokens = new Map<string, TokenColumns>()
  readonly #counts = new Map<string, { messages: number; wakes: number }>()
  readonly #reservations = new Map<string, Reservation>()
  readonly #sessions = new Map<string, Set<string>>()
  readonly #seen = new Set<string>()
  readonly #tasks = new Map<string, Reservation>()
  readonly #unattributed = new Map<
    string,
    Extract<Event, { kind: 'unattributed' }>[]
  >()
  readonly #terminal = new Set<string>()
  #writer: Database | undefined
  #fd: number | undefined
  #problem: string | null = null
  #day: string
  #wall: number
  #mono: number

  constructor(options: FileUsageOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#monotonic = options.monotonic ?? (() => performance.now())
    this.#wall = this.#now()
    this.#mono = this.#monotonic()
    this.#day = dayOf(this.#wall)
    if (!['shadow', 'enforce'].includes(options.policy.mode))
      throw new Error('invalid usage mode')
    for (const limit of [
      options.policy.person,
      options.policy.job,
      options.policy.global,
      ...Object.values(options.policy.tenants ?? {}),
    ]) {
      if (
        Object.entries(limit).some(
          ([key, value]) =>
            !['tokens', 'inFlight', 'sessions', 'messages', 'wakes'].includes(
              key,
            ) || !validCount(value),
        )
      )
        throw new Error('invalid usage limit')
    }
    try {
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
      // SQLite's OS advisory lock is released by the kernel on crash; unlike a
      // PID file it cannot be stolen by two simultaneous stale-lock cleaners.
      const lockPath = `${options.path}.writer.sqlite`
      const lockFd = openSync(
        lockPath,
        constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      try {
        assertPrivateFile(lockFd)
      } finally {
        closeSync(lockFd)
      }
      this.#writer = new Database(lockPath, { create: true })
      this.#writer.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE')
      this.#fd = openSync(
        options.path,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_APPEND |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      assertPrivateFile(this.#fd)
      const text = readFileSync(this.#fd, 'utf8')
      for (const line of text.split('\n')) {
        if (line === '') continue
        const event: Event = JSON.parse(line)
        if (!this.#valid(event)) throw new Error('invalid usage ledger row')
        this.#apply(event)
        // Reopening after a backwards wall-clock jump must not grant a new day.
        if (event.day > this.#day) this.#day = event.day
      }
    } catch (error) {
      this.#problem = `usage ledger unavailable: ${String(error)}`
      this.close()
    }
  }

  #valid(event: Event): boolean {
    if (
      !event ||
      event.v !== 1 ||
      !validCount(event.at) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(event.day)
    )
      return false
    if (
      'node' in event &&
      (typeof event.node !== 'string' || event.node.length === 0)
    )
      return false
    if (event.kind === 'reserve')
      return (
        !!event.reservation &&
        typeof event.reservation.id === 'string' &&
        validScope(event.reservation.scope) &&
        validCount(event.reservation.expiresAt) &&
        (event.sessionId === undefined ||
          typeof event.sessionId === 'string') &&
        (event.operation === undefined ||
          ['message', 'wake', 'session'].includes(event.operation))
      )
    if (event.kind === 'finish')
      return typeof event.id === 'string' && columns(event.usage)
    if (event.kind === 'bind')
      return typeof event.id === 'string' && typeof event.taskId === 'string'
    if (event.kind === 'session')
      return typeof event.id === 'string' && typeof event.sessionId === 'string'
    if (event.kind === 'unattributed')
      return (
        typeof event.id === 'string' &&
        typeof event.taskId === 'string' &&
        columns(event.usage)
      )
    if (event.kind === 'terminal') return typeof event.taskId === 'string'
    if (event.kind === 'record')
      return (
        typeof event.id === 'string' &&
        validScope(event.scope) &&
        columns(event.usage)
      )
    return (
      event.kind === 'close' &&
      validScope(event.scope) &&
      typeof event.sessionId === 'string'
    )
  }

  #clock(): number {
    const now = this.#now()
    const mono = this.#monotonic()
    const drift = now - this.#wall - (mono - this.#mono)
    if (Math.abs(drift) > 300_000)
      this.#problem =
        'wall clock jumped; usage window held until operator restart'
    this.#wall = now
    this.#mono = mono
    if (this.#problem === null && dayOf(now) > this.#day) this.#day = dayOf(now)
    return now
  }

  #add(scope: UsageScope, day: string, usage: TokenColumns): void {
    for (const bucket of buckets(scope)) {
      const key = `${day}/${bucket}`
      const old = this.#tokens.get(key) ?? ZERO
      const next = Object.fromEntries(
        COLUMNS.map(column => [column, old[column] + usage[column]]),
      ) as unknown as TokenColumns
      if (!columns(next)) throw new Error('usage counter overflow')
      this.#tokens.set(key, next)
    }
  }

  #apply(event: Event): void {
    if (event.kind === 'reserve') {
      if (this.#reservations.has(event.reservation.id))
        throw new Error('duplicate reservation')
      this.#reservations.set(event.reservation.id, {
        ...event.reservation,
        ...(event.sessionId === undefined
          ? {}
          : { sessionId: event.sessionId }),
      })
      for (const bucket of buckets(event.reservation.scope)) {
        const key = `${event.day}/${bucket}`
        const counts = this.#counts.get(key) ?? { messages: 0, wakes: 0 }
        if (event.operation === 'message') counts.messages += 1
        if (event.operation === 'wake') counts.wakes += 1
        this.#counts.set(key, counts)
      }
      if (event.sessionId !== undefined)
        for (const bucket of buckets(event.reservation.scope)) {
          const sessions = this.#sessions.get(bucket) ?? new Set<string>()
          sessions.add(`${event.reservation.scope.subject}/${event.sessionId}`)
          this.#sessions.set(bucket, sessions)
        }
    } else if (event.kind === 'finish') {
      const reservation = this.#reservations.get(event.id)
      if (reservation === undefined)
        throw new Error('finish without reservation')
      this.#add(reservation.scope, event.day, event.usage)
      this.#reservations.delete(event.id)
    } else if (event.kind === 'bind') {
      const reservation = this.#reservations.get(event.id)
      if (reservation === undefined || this.#tasks.has(event.taskId))
        throw new Error('invalid task binding')
      const bound = {
        ...reservation,
        ...(event.node === undefined ? {} : { node: event.node }),
      }
      this.#tasks.set(event.taskId, bound)
      for (const pending of this.#unattributed.get(event.taskId) ?? [])
        if (pending.node === undefined || pending.node === bound.node)
          this.#add(reservation.scope, pending.day, pending.usage)
      this.#unattributed.delete(event.taskId)
      if (
        this.#terminal.has(terminalKey(event.taskId)) ||
        this.#terminal.has(terminalKey(event.taskId, bound.node))
      )
        this.#reservations.delete(reservation.id)
    } else if (event.kind === 'session') {
      const reservation = this.#reservations.get(event.id)
      if (reservation?.sessionId === undefined)
        throw new Error('session without reservation')
      for (const bucket of buckets(reservation.scope)) {
        this.#sessions
          .get(bucket)
          ?.delete(`${reservation.scope.subject}/${reservation.sessionId}`)
        this.#sessions
          .get(bucket)
          ?.add(`${reservation.scope.subject}/${event.sessionId}`)
      }
      this.#reservations.set(event.id, {
        ...reservation,
        sessionId: event.sessionId,
      })
    } else if (event.kind === 'unattributed') {
      if (this.#seen.has(event.id)) throw new Error('duplicate usage event')
      this.#seen.add(event.id)
      const pending = this.#unattributed.get(event.taskId) ?? []
      pending.push(event)
      this.#unattributed.set(event.taskId, pending)
    } else if (event.kind === 'terminal') {
      this.#terminal.add(terminalKey(event.taskId, event.node))
      const reservation = this.#tasks.get(event.taskId)
      if (
        reservation !== undefined &&
        (event.node === undefined || event.node === reservation.node)
      )
        this.#reservations.delete(reservation.id)
    } else if (event.kind === 'record') {
      if (this.#seen.has(event.id)) throw new Error('duplicate usage event')
      this.#seen.add(event.id)
      this.#add(event.scope, event.day, event.usage)
    } else {
      for (const bucket of buckets(event.scope))
        this.#sessions
          .get(bucket)
          ?.delete(`${event.scope.subject}/${event.sessionId}`)
    }
  }

  #append(event: Event): boolean {
    if (this.#problem !== null || this.#fd === undefined) return false
    try {
      const bytes = Buffer.from(`${JSON.stringify(event)}\n`)
      let offset = 0
      while (offset < bytes.length)
        offset += writeSync(this.#fd, bytes, offset, bytes.length - offset)
      fsyncSync(this.#fd)
      this.#apply(event)
      return true
    } catch (error) {
      this.#problem = `usage ledger write failed: ${String(error)}`
      return false
    }
  }

  #limits(bucket: string): UsageLimits {
    if (bucket.startsWith('global:')) return this.#options.policy.global
    if (bucket.startsWith('tenant:'))
      return this.#options.policy.tenants?.[bucket.slice(7)] ?? {}
    return bucket.startsWith('job:')
      ? this.#options.policy.job
      : this.#options.policy.person
  }

  #row(bucket: string, now: number): UsageRow {
    const tokens = this.#tokens.get(`${this.#day}/${bucket}`) ?? ZERO
    return {
      ...tokens,
      ...(this.#counts.get(`${this.#day}/${bucket}`) ?? {
        messages: 0,
        wakes: 0,
      }),
      day: this.#day,
      bucket,
      charged: tokens.input + tokens.output + tokens.cacheWrite,
      inFlight: [...this.#reservations.values()].filter(
        r => r.expiresAt > now && buckets(r.scope).includes(bucket),
      ).length,
      sessions: this.#sessions.get(bucket)?.size ?? 0,
      limits: this.#limits(bucket),
    }
  }

  #snapshot(subject?: string): UsageSnapshot {
    const now = this.#clock()
    const names = new Set<string>(
      [...this.#tokens.keys(), ...this.#counts.keys()]
        .filter(key => key.startsWith(`${this.#day}/`))
        .map(key => key.slice(11)),
    )
    for (const r of this.#reservations.values())
      for (const key of buckets(r.scope)) names.add(key)
    for (const key of this.#sessions.keys()) names.add(key)
    if (subject !== undefined) names.add(`person:${subject}`)
    return {
      mode: this.#options.policy.mode,
      day: this.#day,
      resetsAt: Date.parse(`${this.#day}T00:00:00+08:00`) + DAY,
      lowerBound: true,
      problem: this.#problem,
      rows: [...names]
        .filter(key => subject === undefined || key === `person:${subject}`)
        .sort()
        .map(key => this.#row(key, now)),
    }
  }

  async read(subject?: string): Promise<UsageSnapshot> {
    return this.#snapshot(subject)
  }

  reserve(
    scope: UsageScope,
    input: {
      readonly sessionId?: string
      readonly newSession?: boolean
      readonly operation?: 'message' | 'wake' | 'session'
    } = {},
  ): UsageAdmission {
    if (
      !validScope(scope) ||
      (input.newSession && !input.sessionId) ||
      (input.operation !== undefined &&
        !['message', 'wake', 'session'].includes(input.operation))
    )
      throw new Error('invalid usage admission')
    const now = this.#clock()
    const exceeded: string[] = []
    for (const bucket of buckets(scope)) {
      const row = this.#row(bucket, now)
      const countNew =
        input.newSession &&
        !this.#sessions.get(bucket)?.has(`${scope.subject}/${input.sessionId}`)
          ? 1
          : 0
      if (
        (row.limits.tokens !== undefined && row.charged >= row.limits.tokens) ||
        (input.operation === 'message' &&
          row.limits.messages !== undefined &&
          row.messages >= row.limits.messages) ||
        (input.operation === 'wake' &&
          row.limits.wakes !== undefined &&
          row.wakes >= row.limits.wakes) ||
        (row.limits.inFlight !== undefined &&
          row.inFlight >= row.limits.inFlight) ||
        (row.limits.sessions !== undefined &&
          row.sessions + countNew > row.limits.sessions)
      )
        exceeded.push(bucket)
    }
    if (
      this.#problem !== null ||
      (exceeded.length > 0 && this.#options.policy.mode === 'enforce')
    )
      return {
        ok: false,
        reason: this.#problem === null ? 'quota' : 'unavailable',
        snapshot: this.#snapshot(scope.subject),
      }
    const id = randomUUID()
    if (
      !this.#append({
        v: 1,
        kind: 'reserve',
        at: now,
        day: this.#day,
        reservation: {
          id,
          scope: { ...scope },
          expiresAt: now + (this.#options.reservationTtlMs ?? 3_600_000),
        },
        ...(input.newSession ? { sessionId: input.sessionId } : {}),
        ...(input.operation === undefined
          ? {}
          : { operation: input.operation }),
      })
    )
      return {
        ok: false,
        reason: 'unavailable',
        snapshot: this.#snapshot(scope.subject),
      }
    return { ok: true, reservationId: id, shadowExceeded: exceeded }
  }

  finish(reservationId: string, usage: TokenColumns = ZERO): void {
    if (!columns(usage)) throw new Error('invalid token columns')
    if (!this.#reservations.has(reservationId)) return
    this.#append({
      v: 1,
      kind: 'finish',
      at: this.#clock(),
      day: this.#day,
      id: reservationId,
      usage,
    })
  }

  record(
    eventId: string,
    scope: UsageScope,
    usage: TokenColumns,
    observedAt?: number,
  ): void {
    if (!eventId || !validScope(scope) || !columns(usage))
      throw new Error('invalid usage observation')
    if (this.#seen.has(eventId)) return
    const at = this.#clock()
    if (observedAt !== undefined && !validCount(observedAt))
      throw new Error('invalid usage observation time')
    if (
      !this.#append({
        v: 1,
        kind: 'record',
        at,
        day:
          observedAt === undefined
            ? this.#day
            : dayOf(Math.min(at, observedAt)),
        id: eventId,
        scope: { ...scope },
        usage,
      })
    )
      throw new Error('usage observation unavailable')
  }

  bindTask(reservationId: string, taskId: string, node?: string): void {
    if (node !== undefined && !node) throw new Error('invalid usage task node')
    if (
      this.#tasks.get(taskId)?.id === reservationId &&
      this.#tasks.get(taskId)?.node === node
    )
      return
    if (
      !taskId ||
      this.#tasks.has(taskId) ||
      !this.#reservations.has(reservationId)
    )
      throw new Error('invalid usage task binding')
    if (
      !this.#append({
        v: 1,
        kind: 'bind',
        at: this.#clock(),
        day: this.#day,
        id: reservationId,
        taskId,
        ...(node === undefined ? {} : { node }),
      })
    )
      throw new Error('usage task binding unavailable')
  }

  adoptSession(reservationId: string, sessionId: string): void {
    if (
      !sessionId ||
      this.#reservations.get(reservationId)?.sessionId === undefined
    )
      throw new Error('invalid session adoption')
    if (
      !this.#append({
        v: 1,
        kind: 'session',
        at: this.#clock(),
        day: this.#day,
        id: reservationId,
        sessionId,
      })
    )
      throw new Error('session adoption unavailable')
  }

  finishTask(taskId: string, node?: string): void {
    const bound = this.#tasks.get(taskId)
    if (node !== undefined && bound !== undefined && node !== bound.node) return
    if (this.#terminal.has(terminalKey(taskId, node))) return
    if (
      !this.#append({
        v: 1,
        kind: 'terminal',
        at: this.#clock(),
        day: this.#day,
        taskId,
        ...(node === undefined ? {} : { node }),
      })
    )
      throw new Error('usage terminal unavailable')
  }

  /** Durable host-owned attribution; callers cannot mutate the stored scope. */
  taskScope(taskId: string): UsageScope | undefined {
    const scope = this.#tasks.get(taskId)?.scope
    return scope === undefined ? undefined : { ...scope }
  }

  recordTask(
    eventId: string,
    taskId: string,
    usage: TokenColumns,
    observedAt?: number,
    node?: string,
  ): void {
    if (!eventId || !taskId || !columns(usage))
      throw new Error('invalid task usage observation')
    if (this.#seen.has(eventId)) return
    const reservation = this.#tasks.get(taskId)
    if (
      node !== undefined &&
      reservation !== undefined &&
      node !== reservation.node
    )
      return
    if (reservation !== undefined)
      this.record(eventId, reservation.scope, usage, observedAt)
    else {
      const at = this.#clock()
      if (observedAt !== undefined && !validCount(observedAt))
        throw new Error('invalid usage observation time')
      if (
        !this.#append({
          v: 1,
          kind: 'unattributed',
          at,
          day:
            observedAt === undefined
              ? this.#day
              : dayOf(Math.min(at, observedAt)),
          id: eventId,
          taskId,
          usage,
          ...(node === undefined ? {} : { node }),
        })
      )
        throw new Error('usage observation unavailable')
    }
  }

  closeSession(scope: UsageScope, sessionId: string): void {
    if (!validScope(scope)) throw new Error('invalid usage scope')
    this.#append({
      v: 1,
      kind: 'close',
      at: this.#clock(),
      day: this.#day,
      scope,
      sessionId,
    })
  }

  close(): void {
    if (this.#writer !== undefined) {
      this.#writer.close()
      this.#writer = undefined
    }
    if (this.#fd !== undefined) closeSync(this.#fd)
    this.#fd = undefined
  }
}

/** Instance-scoped counter delta. A reset starts a new cumulative epoch. */
export function usageDelta(
  previous: TokenColumns | undefined,
  current: TokenColumns,
): TokenColumns {
  if (!columns(current)) throw new Error('invalid token columns')
  if (
    previous === undefined ||
    COLUMNS.some(key => current[key] < previous[key])
  )
    return { ...current }
  return Object.fromEntries(
    COLUMNS.map(key => [key, current[key] - previous[key]]),
  ) as unknown as TokenColumns
}
