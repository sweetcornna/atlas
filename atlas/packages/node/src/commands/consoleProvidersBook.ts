// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 模型服务的期望状态：`providers.ndjson`（`providers-console-m1.md` §2.4、§3.7，
 * P18.6）。
 *
 * ## 行格式与严格读
 *
 * 行是控制台账号库那一种（`packages/console/src/ledger.ts`：平铺的 data、上一行规范形
 * 的 SHA-256 成链），文件面是动作账本那一份（`FileActionLedger`：目录 0700、文件
 * 0600、`O_APPEND | O_NOFOLLOW`、每行 fsync、文件指纹）。**一行坏了、链断了、运行中
 * 被别人改了，整本停用**：模型服务这一面拒绝服务并告警，节点照用最后一次下发的配置。
 * 跳过一行在这里的后果是把一次「停止托管」读丢、把节点又下发回去。
 *
 * ## 只有标识、指纹与哈希
 *
 * 档案正文（不含任何密钥值，`keys[]` 只有 id 与指纹）以 JSON 字符串放在
 * `profile.saved` 的 `body` 里，重放时用目录包的 `parseProviderProfile` 严格解析，
 * 下线判定的时钟是那一行自己的时间——账本不会因为日历走过某个下线日而自己坏掉。
 * 其余事件只有档案 id、节点名、请求 id、指纹和哈希。
 *
 * ## 事件
 *
 * 首行 `ledger.header {ledger:'providers', version:1}`；其后见 {@link BookEvent}。
 * §3.7 的事件表之外多了四种：`default.set`（全局默认）、`context.set` /
 * `context.cleared`（D-8 的节点覆盖）、`apply.committed`（节点回报「这一次已提交」时
 * 的 `appliedHash`，下一次 apply 的 `expect.ownedHash` 只取它，§2.3 第 4 步）、
 * `probe.result`（§6.3.8「最近 10 次下发与测连」）。
 */

import {
  type ActionLedgerStore,
  type ActionOutcome,
  encodeLedgerEntry,
  ledgerDigest,
  type LedgerData,
  type LedgerEntry,
  nextPrevious,
  type ProviderActivity,
  type ProviderAssignment,
  readLedger,
} from '@qianmo/console'
import {
  isKeyId,
  isProfileId,
  isSecretFingerprint,
  type Lane,
  LANES,
  parseProviderProfile,
  migrateLegacyCompat,
  type ProviderProfile,
} from '@qianmo/providers'
import { isProtocolNodeName } from './consoleProvidersExec.js'

const HEADER_KIND = 'ledger.header'
const LEDGER_NAME = 'providers'
const LEDGER_VERSION = 1
const APPLIED_HASH = /^sha256:[0-9a-f]{64}$/
const REQUEST_ID = /^[0-9A-Za-z_-]{8,64}$/
const CODE = /^[a-z0-9][a-z0-9_.-]{0,39}$/
const OUTCOMES: readonly ActionOutcome[] = ['ok', 'refused', 'failed']
const PROBE_MODES = ['auth', 'latency', 'call'] as const
/** §6.3.8: the node page lists the last ten. */
const ACTIVITY_LIMIT = 10

export type BookEvent =
  | {
      readonly kind: 'profile.saved'
      readonly id: string
      readonly revision: number
      readonly body: string
    }
  | {
      readonly kind: 'profile.deleted'
      readonly id: string
      readonly revision: number
    }
  | {
      readonly kind: 'secret.set'
      readonly profileId: string
      readonly keyId: string
      readonly fp: string
    }
  | {
      readonly kind: 'secret.cleared'
      readonly profileId: string
      readonly keyId: string
    }
  /** `profileId: ''` is "no global default". */
  | { readonly kind: 'default.set'; readonly profileId: string }
  | {
      readonly kind: 'scope.assigned'
      readonly node: string
      readonly mode: ProviderAssignment['mode']
      readonly profileId?: string
    }
  | {
      readonly kind: 'context.set'
      readonly node: string
      readonly tokens: number
    }
  | { readonly kind: 'context.cleared'; readonly node: string }
  | ({ readonly kind: 'apply.result' } & SentRecord)
  | {
      readonly kind: 'apply.committed'
      readonly node: string
      readonly requestId: string
      readonly appliedHash: string
    }
  | {
      readonly kind: 'probe.result'
      readonly node: string
      readonly requestId: string
      readonly profileId: string
      readonly mode: (typeof PROBE_MODES)[number]
      readonly ok: boolean
      readonly reachable: boolean
    }

/** What the hub sent in one apply, and how the node answered. */
export interface SentRecord {
  readonly node: string
  readonly requestId: string
  readonly profileId: string
  readonly revision: number
  readonly outcome: ActionOutcome
  readonly code?: string
  readonly pending: boolean
  readonly force: boolean
  readonly sessions: 'keep' | 'reset'
  readonly lane: Lane
  /** Base URL host, for the §2.7 session policy. Never a path or a query. */
  readonly host: string
  /** The D-8 node override that went out with it, if any. */
  readonly context?: number
}

interface State {
  readonly profiles: Map<string, ProviderProfile>
  /** Highest revision ever recorded per id, deleted incarnations included. */
  readonly lastRevision: Map<string, number>
  defaultProfileId: string | null
  readonly assignments: Map<string, ProviderAssignment>
  readonly contexts: Map<string, number>
  readonly sent: Map<string, SentRecord>
  readonly committed: Map<string, { requestId: string; appliedHash: string }>
  readonly activity: Map<string, ProviderActivity[]>
}

function emptyState(): State {
  return {
    profiles: new Map(),
    lastRevision: new Map(),
    defaultProfileId: null,
    assignments: new Map(),
    contexts: new Map(),
    sent: new Map(),
    committed: new Map(),
    activity: new Map(),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function pushActivity(state: State, node: string, entry: ProviderActivity) {
  const list = state.activity.get(node) ?? []
  list.unshift(entry)
  if (list.length > ACTIVITY_LIMIT) list.length = ACTIVITY_LIMIT
  state.activity.set(node, list)
}

function referenced(state: State, id: string): boolean {
  if (state.defaultProfileId === id) return true
  for (const assignment of state.assignments.values()) {
    if (assignment.mode === 'profile' && assignment.profileId === id) {
      return true
    }
  }
  return false
}

/** An event as a ledger kind and flat data. */
function encodeEvent(event: BookEvent): {
  kind: string
  data: LedgerData
} {
  const { kind, ...rest } = event
  const data: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) data[key] = value as string | number | boolean
  }
  return { kind, data }
}

const FIELDS: Readonly<Record<BookEvent['kind'], readonly string[]>> = {
  'profile.saved': ['body', 'id', 'revision'],
  'profile.deleted': ['id', 'revision'],
  'secret.set': ['fp', 'keyId', 'profileId'],
  'secret.cleared': ['keyId', 'profileId'],
  'default.set': ['profileId'],
  'scope.assigned': ['mode', 'node', 'profileId?'],
  'context.set': ['node', 'tokens'],
  'context.cleared': ['node'],
  'apply.result': [
    'code?',
    'context?',
    'force',
    'host',
    'lane',
    'node',
    'outcome',
    'pending',
    'profileId',
    'requestId',
    'revision',
    'sessions',
  ],
  'apply.committed': ['appliedHash', 'node', 'requestId'],
  'probe.result': ['mode', 'node', 'ok', 'profileId', 'reachable', 'requestId'],
}

function hasFields(data: LedgerData, fields: readonly string[]): boolean {
  const allowed = new Set(fields.map(field => field.replace(/\?$/, '')))
  for (const key of Object.keys(data)) if (!allowed.has(key)) return false
  return fields.every(field => field.endsWith('?') || data[field] !== undefined)
}

/** A ledger line back into an event, shape only; `null` when it is not one. */
function decodeEvent(kind: string, data: LedgerData): BookEvent | null {
  if (!Object.hasOwn(FIELDS, kind)) return null
  const known = kind as BookEvent['kind']
  if (!hasFields(data, FIELDS[known])) return null
  const text = (key: string): string | null =>
    typeof data[key] === 'string' ? (data[key] as string) : null
  const node = text('node')
  if (node !== null && !isProtocolNodeName(node)) return null
  switch (known) {
    case 'profile.saved': {
      const id = text('id')
      const body = text('body')
      if (!isProfileId(id) || body === null || !isRevision(data.revision)) {
        return null
      }
      return { kind: known, id, revision: data.revision, body }
    }
    case 'profile.deleted': {
      const id = text('id')
      if (!isProfileId(id) || !isRevision(data.revision)) return null
      return { kind: known, id, revision: data.revision }
    }
    case 'secret.set': {
      const profileId = text('profileId')
      const keyId = text('keyId')
      const fp = text('fp')
      if (
        !isProfileId(profileId) ||
        !isKeyId(keyId) ||
        !isSecretFingerprint(fp)
      )
        return null
      return { kind: known, profileId, keyId, fp }
    }
    case 'secret.cleared': {
      const profileId = text('profileId')
      const keyId = text('keyId')
      if (!isProfileId(profileId) || !isKeyId(keyId)) return null
      return { kind: known, profileId, keyId }
    }
    case 'default.set': {
      const profileId = text('profileId')
      if (profileId === null || (profileId !== '' && !isProfileId(profileId)))
        return null
      return { kind: known, profileId }
    }
    case 'scope.assigned': {
      const mode = text('mode')
      const profileId = text('profileId')
      if (node === null) return null
      if (mode === 'profile' && isProfileId(profileId)) {
        return { kind: known, node, mode, profileId }
      }
      if ((mode === 'inherit' || mode === 'unmanaged') && profileId === null) {
        return { kind: known, node, mode }
      }
      return null
    }
    case 'context.set':
      if (node === null || !isRevision(data.tokens)) return null
      return { kind: known, node, tokens: data.tokens }
    case 'context.cleared':
      return node === null ? null : { kind: known, node }
    case 'apply.result': {
      const requestId = text('requestId')
      const profileId = text('profileId')
      const outcome = text('outcome')
      const code = text('code')
      const sessions = text('sessions')
      const lane = text('lane')
      const host = text('host')
      if (
        node === null ||
        requestId === null ||
        !REQUEST_ID.test(requestId) ||
        !isProfileId(profileId) ||
        !isRevision(data.revision) ||
        !OUTCOMES.includes(outcome as ActionOutcome) ||
        (data.code !== undefined && (code === null || !CODE.test(code))) ||
        typeof data.pending !== 'boolean' ||
        typeof data.force !== 'boolean' ||
        (sessions !== 'keep' && sessions !== 'reset') ||
        !(LANES as readonly string[]).includes(lane ?? '') ||
        host === null ||
        host.length === 0 ||
        host.length > 253 ||
        (data.context !== undefined && !isRevision(data.context))
      ) {
        return null
      }
      return {
        kind: known,
        node,
        requestId,
        profileId,
        revision: data.revision,
        outcome: outcome as ActionOutcome,
        ...(code === null ? {} : { code }),
        pending: data.pending,
        force: data.force,
        sessions,
        lane: lane as Lane,
        host,
        ...(typeof data.context === 'number' ? { context: data.context } : {}),
      }
    }
    case 'apply.committed': {
      const requestId = text('requestId')
      const appliedHash = text('appliedHash')
      if (
        node === null ||
        requestId === null ||
        !REQUEST_ID.test(requestId) ||
        appliedHash === null ||
        !APPLIED_HASH.test(appliedHash)
      ) {
        return null
      }
      return { kind: known, node, requestId, appliedHash }
    }
    case 'probe.result': {
      const requestId = text('requestId')
      const profileId = text('profileId')
      const mode = text('mode')
      if (
        node === null ||
        requestId === null ||
        !REQUEST_ID.test(requestId) ||
        !isProfileId(profileId) ||
        !(PROBE_MODES as readonly string[]).includes(mode ?? '') ||
        typeof data.ok !== 'boolean' ||
        typeof data.reachable !== 'boolean'
      ) {
        return null
      }
      return {
        kind: known,
        node,
        requestId,
        profileId,
        mode: mode as (typeof PROBE_MODES)[number],
        ok: data.ok,
        reachable: data.reachable,
      }
    }
  }
}

/** Apply one event to the state, or say why it cannot follow what came before. */
function fold(state: State, event: BookEvent, at: number): string | null {
  switch (event.kind) {
    case 'profile.saved': {
      const expected = (state.lastRevision.get(event.id) ?? 0) + 1
      if (event.revision !== expected) return `修订号应为 ${expected}`
      let raw: unknown
      try {
        raw = JSON.parse(event.body)
      } catch {
        return '档案正文不是 JSON'
      }
      if (
        typeof raw === 'object' &&
        raw !== null &&
        'compat' in raw &&
        typeof raw.compat === 'object' &&
        raw.compat !== null &&
        !Array.isArray(raw.compat)
      )
        raw = {
          ...raw,
          compat: migrateLegacyCompat(raw.compat as Record<string, unknown>),
        }
      const parsed = parseProviderProfile(raw, { now: new Date(at) })
      if (!parsed.ok) return `档案正文不合法（${parsed.error.path}）`
      if (parsed.value.id !== event.id) return '档案 id 与正文不符'
      if (parsed.value.revision !== event.revision) return '修订号与正文不符'
      state.profiles.set(event.id, parsed.value)
      state.lastRevision.set(event.id, event.revision)
      return null
    }
    case 'profile.deleted': {
      const current = state.profiles.get(event.id)
      if (current === undefined) return '删除的档案不存在'
      if (current.revision !== event.revision) return '删除的修订号不对'
      if (referenced(state, event.id)) return '删除的档案仍被指派'
      state.profiles.delete(event.id)
      return null
    }
    case 'secret.set':
    case 'secret.cleared': {
      // Follows the `profile.saved` line that carries the key's new state.
      const profile = state.profiles.get(event.profileId)
      if (profile === undefined) return '密钥所属的档案不存在'
      const key = profile.keys.find(entry => entry.id === event.keyId)
      if (key === undefined) return '档案里没有这把密钥'
      const fingerprint = event.kind === 'secret.set' ? event.fp : undefined
      if (key.fingerprint !== fingerprint) return '密钥指纹与档案不符'
      return null
    }
    case 'default.set':
      if (event.profileId !== '' && !state.profiles.has(event.profileId)) {
        return '默认档案不存在'
      }
      state.defaultProfileId = event.profileId === '' ? null : event.profileId
      return null
    case 'scope.assigned':
      if (event.mode === 'profile') {
        if (
          event.profileId === undefined ||
          !state.profiles.has(event.profileId)
        ) {
          return '指派的档案不存在'
        }
        state.assignments.set(event.node, {
          mode: 'profile',
          profileId: event.profileId,
        })
      } else {
        state.assignments.set(event.node, { mode: event.mode })
      }
      return null
    case 'context.set':
      state.contexts.set(event.node, event.tokens)
      return null
    case 'context.cleared':
      state.contexts.delete(event.node)
      return null
    case 'apply.result': {
      const { kind: _kind, ...sent } = event
      state.sent.set(event.requestId, sent)
      pushActivity(state, event.node, {
        kind: 'apply',
        at,
        requestId: event.requestId,
        profileId: event.profileId,
        outcome: event.outcome,
        ...(event.code === undefined ? {} : { code: event.code }),
        force: event.force,
      })
      return null
    }
    case 'apply.committed': {
      const sent = state.sent.get(event.requestId)
      if (sent === undefined || sent.node !== event.node) {
        return '提交记录对不上任何一次下发'
      }
      state.committed.set(event.node, {
        requestId: event.requestId,
        appliedHash: event.appliedHash,
      })
      return null
    }
    case 'probe.result':
      pushActivity(state, event.node, {
        kind: 'probe',
        at,
        requestId: event.requestId,
        profileId: event.profileId,
        outcome: event.ok ? 'ok' : 'failed',
        ...(event.ok ? {} : { code: 'probe-failed' }),
        mode: event.mode,
      })
      return null
  }
}

type Replay =
  | {
      readonly ok: true
      readonly lines: number
      readonly previous: string
      readonly state: State
    }
  | { readonly ok: false; readonly line: number; readonly reason: string }

function replay(text: string): Replay {
  const read = readLedger(text)
  if (!read.ok) return { ok: false, ...read.issue }
  const state = emptyState()
  for (const entry of read.entries) {
    if (entry.seq === 1) {
      if (
        entry.kind !== HEADER_KIND ||
        entry.data.ledger !== LEDGER_NAME ||
        entry.data.version !== LEDGER_VERSION ||
        Object.keys(entry.data).length !== 2
      ) {
        return { ok: false, line: 1, reason: '首行不是模型服务账本的账头' }
      }
      continue
    }
    const event = decodeEvent(entry.kind, entry.data)
    if (event === null) {
      return { ok: false, line: entry.seq, reason: `${entry.kind} 形状不对` }
    }
    const problem = fold(state, event, entry.at)
    if (problem !== null) {
      return { ok: false, line: entry.seq, reason: problem }
    }
  }
  return {
    ok: true,
    lines: read.entries.length,
    previous: nextPrevious(read.entries),
    state,
  }
}

interface ProviderBookOptions {
  readonly store: ActionLedgerStore
  /** Where an alarm goes; the host writes it to stderr. */
  readonly onAlarm?: (line: string) => void
  readonly now?: () => number
}

/**
 * The hub's desired state, folded from `providers.ndjson`. Reads are served
 * from memory; every write first checks that the file still ends where this
 * process left it (the action ledger's stamp rule), then appends one line.
 */
export class ProviderBook {
  readonly #store: ActionLedgerStore
  readonly #onAlarm: (line: string) => void
  readonly #now: () => number
  #state: State = emptyState()
  #lines = 0
  #previous = nextPrevious([])
  #stamp: string | null = null
  #problem: string | null = null

  constructor(options: ProviderBookOptions) {
    this.#store = options.store
    this.#onAlarm = options.onAlarm ?? (() => {})
    this.#now = options.now ?? Date.now
    const replayed = this.#replay()
    if (replayed === null) return
    this.#adopt(replayed)
    if (this.#lines === 0) {
      this.#append(
        HEADER_KIND,
        { ledger: LEDGER_NAME, version: LEDGER_VERSION },
        Math.floor(this.#now()),
      )
    }
  }

  /** `null` while usable; otherwise why the providers face is closed. */
  get problem(): string | null {
    return this.#problem
  }

  /** Lines in the file; moves on every recorded event. */
  get revision(): number {
    return this.#lines
  }

  profiles(): readonly ProviderProfile[] {
    return [...this.#state.profiles.values()].sort((a, b) =>
      a.id < b.id ? -1 : 1,
    )
  }

  profile(id: string): ProviderProfile | undefined {
    return this.#state.profiles.get(id)
  }

  /** The highest revision `id` has ever had, deleted incarnations included. */
  lastRevision(id: string): number {
    return this.#state.lastRevision.get(id) ?? 0
  }

  get defaultProfileId(): string | null {
    return this.#state.defaultProfileId
  }

  assignment(node: string): ProviderAssignment {
    return this.#state.assignments.get(node) ?? { mode: 'inherit' }
  }

  contextOverride(node: string): number | null {
    return this.#state.contexts.get(node) ?? null
  }

  /** §2.3 step 4: the hash the node reported when it committed OUR last request. */
  committed(node: string): { requestId: string; appliedHash: string } | null {
    return this.#state.committed.get(node) ?? null
  }

  sent(requestId: string): SentRecord | undefined {
    return this.#state.sent.get(requestId)
  }

  activity(node: string): readonly ProviderActivity[] {
    return this.#state.activity.get(node) ?? []
  }

  /** Is `id` the default or some node's explicit choice? */
  isReferenced(id: string): boolean {
    return referenced(this.#state, id)
  }

  /**
   * Record one event. `false` when the book is closed or the event cannot
   * follow what is already there (a caller bug: alarmed, nothing written).
   */
  record(event: BookEvent): boolean {
    if (!this.#usable()) return false
    const at = Math.floor(this.#now())
    const probe = cloneState(this.#state)
    const problem = fold(probe, event, at)
    if (problem !== null) {
      this.#onAlarm(
        `console providers: 拒收一条事件（${event.kind}：${problem}）`,
      )
      return false
    }
    const { kind, data } = encodeEvent(event)
    if (!this.#append(kind, data, at)) return false
    this.#state = probe
    return true
  }

  // --- the file ----------------------------------------------------------

  #fail(reason: string): void {
    if (this.#problem === null) this.#problem = `${this.#store.path} ${reason}`
    this.#onAlarm(
      `console providers: ${this.#store.path} ${reason}；模型服务已停用，节点照用最后一次下发的配置。` +
        '把这个文件移走留证，再重启控制台',
    )
  }

  #replay(): Extract<Replay, { ok: true }> | null {
    let text: string | null
    try {
      text = this.#store.read()
    } catch (error) {
      this.#fail(`读不出来（${messageOf(error)}）`)
      return null
    }
    const result = replay(text ?? '')
    if (!result.ok) {
      this.#fail(`第 ${result.line} 行：${result.reason}`)
      return null
    }
    return result
  }

  #adopt(result: Extract<Replay, { ok: true }>): void {
    this.#state = result.state
    this.#lines = result.lines
    this.#previous = result.previous
    try {
      this.#stamp = this.#store.stamp()
    } catch (error) {
      this.#fail(`读不到文件状态（${messageOf(error)}）`)
    }
  }

  #usable(): boolean {
    if (this.#problem !== null) return false
    let stamp: string | null
    try {
      stamp = this.#store.stamp()
    } catch (error) {
      this.#fail(`读不到文件状态（${messageOf(error)}）`)
      return false
    }
    if (stamp !== null && stamp === this.#stamp) return true
    const result = this.#replay()
    if (result === null) return false
    if (result.lines !== this.#lines || result.previous !== this.#previous) {
      this.#fail('在控制台运行期间被改动：链尾与本进程写下的不一致')
      return false
    }
    this.#stamp = stamp
    return true
  }

  #append(kind: string, data: LedgerData, at: number): boolean {
    const entry: LedgerEntry = {
      seq: this.#lines + 1,
      at,
      kind,
      data,
      prev: this.#previous,
    }
    try {
      this.#store.append(encodeLedgerEntry(entry))
      this.#stamp = this.#store.stamp()
    } catch (error) {
      this.#fail(`写不进去（${messageOf(error)}）`)
      return false
    }
    this.#lines = entry.seq
    this.#previous = ledgerDigest(entry)
    return true
  }
}

function cloneState(state: State): State {
  return {
    profiles: new Map(state.profiles),
    lastRevision: new Map(state.lastRevision),
    defaultProfileId: state.defaultProfileId,
    assignments: new Map(state.assignments),
    contexts: new Map(state.contexts),
    sent: new Map(state.sent),
    committed: new Map(state.committed),
    activity: new Map(
      [...state.activity].map(([node, list]) => [node, [...list]]),
    ),
  }
}
