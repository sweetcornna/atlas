// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The console's action ledger (P15.9, `tenancy-m1.md` §6): who did what, to
 * what, in which request, and how it ended — on disk, hash-chained, and read
 * strictly. The calling side is P18.4's (`deps.ts`, `ActionLedgerPort`); this
 * is the store behind it.
 *
 * ## The account book's lines, not the audit trail's
 *
 * Every line is a `ledger.ts` entry: the chain is `@qianmo/audit`'s
 * construction (`GENESIS_PREVIOUS`, then the SHA-256 of the previous line's
 * canonical form), so an edit, a deletion in the middle or a reordering
 * breaks it from that line on. The record is not an `AuditRecord`, for the
 * reason `ledger.ts` gives for the account book and which holds here word for
 * word: that shape names its writer through the closed `AuditSource` enum, and
 * neither adding a `console` member nor borrowing another layer's is honest.
 *
 * The cost is that `qm audit --verify` cannot read this file — its canonical
 * form is a different one, and it would call an intact ledger broken. The
 * ledger is verified by {@link verifyActionLedger} instead, which the host
 * exposes as `qm console --verify-actions` with `qm audit --verify`'s four
 * states and exit code.
 *
 * ## What a line holds
 *
 * Line 1 is a header naming the ledger and its version, the account book's
 * convention: it is what refuses a `--actions-store` pointed at the account
 * book by mistake. Every later line's `kind` is the action's verb and its data
 * is exactly `requestId`, `subject`, `target`, `outcome`, and `code` /
 * `breakGlass` when present — nothing else is accepted on either side. The
 * port carries no payload to begin with (`deps.ts`, `ConsoleAction`); `target`
 * and `code` are in addition cleaned before they are written, because one of
 * them is a URL path and a token pasted into a path is the one way a secret
 * could otherwise reach this file.
 *
 * ## Closed, not lenient
 *
 * A ledger that cannot be read, has a bad line, or was changed underneath
 * the running console is **closed**: {@link ActionLedger.admit} refuses, so
 * every write the console would make is turned away before it happens (503);
 * {@link ActionLedger.list} refuses, so the read routes say the ledger is
 * unreadable instead of answering from the lines that still parse; and an
 * alarm is raised. Nothing reopens it but a restart, after an operator has
 * moved the file aside. A skipped line here would be a reading of somebody's
 * transcript that nobody can find any more, which is the promise D6 makes to
 * the person whose transcript it is.
 *
 * ## What stays in memory
 *
 * The tail of the chain and the file's stamp — never the entries. The console
 * runs for weeks and the ledger only grows; {@link ActionLedger.list} reads
 * the file each time it is asked, which is also what makes every read strict.
 */

import type {
  ActionLedgerPort,
  ActionOutcome,
  ActionPage,
  ActionQuery,
  ActionRecord,
  AuditChainState,
  ConsoleAction,
  ConsoleResult,
  LedgerPort,
} from './deps.js'
import {
  encodeLedgerEntry,
  ledgerDigest,
  nextPrevious,
  readLedger,
  type LedgerData,
  type LedgerEntry,
  type LedgerValue,
} from './ledger.js'

/** The page size when a query names none. */
const DEFAULT_ACTION_PAGE = 50

/** The most one page holds, whatever the query asks for. */
const MAX_ACTION_PAGE = 500

/**
 * Every decision P14 has the console submit is recorded under this prefix
 * followed by `AuthzDecision.decision` verbatim (`authz.decision.allow-once`,
 * `…allow-window`, `…deny`), with the node's `requestId` verbatim as the
 * target and the approver as the subject. That is the console's half of
 * "两边以 `requestId` 关联" (`tenancy-m1.md` §3.5, `authorization-m1.md`
 * §3.3): the node's chain holds the verdict, this ledger holds who submitted
 * it, and a report joins the two on the request id alone.
 */
export const AUTHZ_DECISION_ACTION_PREFIX = 'authz.decision.'

const HEADER_KIND = 'ledger.header'
const LEDGER_NAME = 'actions'
const LEDGER_VERSION = 1

/** Longest target written; longer ones are cut, never refused. */
const MAX_TARGET_LENGTH = 512
const MAX_ACTION_LENGTH = 64
/** A dotted verb: `chat.transcript.open`, `authz.decision.allow-once`. */
const ACTION_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/
const SUBJECT = /^(?:u:[0-9a-f]{16}|legacy:admin|legacy:view|anonymous)$/
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const CODE = /^[a-z0-9][a-z0-9_.-]{0,39}$/
const OUTCOMES: ReadonlySet<string> = new Set(['ok', 'refused', 'failed'])
const REQUIRED_KEYS = ['outcome', 'requestId', 'subject', 'target'] as const
const DATA_KEYS: ReadonlySet<string> = new Set([
  ...REQUIRED_KEYS,
  'code',
  'breakGlass',
])

/**
 * The secrets `accounts.ts` mints — personal credential `qmu_`, invitation
 * `qmi_`, session id `qms_` — each 32 random bytes in base64url after the
 * prefix. Forty characters or more, so an agent named `qms-planner` is left
 * alone.
 */
const MINTED_SECRET = /qm[ius]_[A-Za-z0-9_-]{40,}/g
const REDACTED = '***'
/** A known secret shorter than this is not looked for: it would match noise. */
const MIN_KNOWN_SECRET_LENGTH = 8

const OK: ConsoleResult<void> = { ok: true, value: undefined }

/**
 * `unreachable` because it is the failure that means "the store behind this
 * port could not be used" and maps to 503: the request is fine, the ledger is
 * not, and a retry after an operator has looked at it is the right answer.
 */
const CLOSED: ConsoleResult<never> = {
  ok: false,
  failure: {
    code: 'unreachable',
    message: '动作账本已停用：校验没有通过或写不进去，已告警运维。',
  },
}

/**
 * The file behind the ledger: the account book's port, and a stamp.
 *
 * The stamp is how a running ledger notices that the file was changed by
 * somebody else without reading it on every request: anything that changes
 * whenever the file's content or identity does (the host uses device, inode,
 * size and modification time). Compared for equality, never parsed. `null`
 * when there is no file.
 */
export interface ActionLedgerStore extends LedgerPort {
  stamp(): string | null
}

export interface ActionLedgerOptions {
  readonly store: ActionLedgerStore
  /**
   * Exact values that must never be written — the host passes the two console
   * tokens. Replaced with `***` wherever they turn up in a target or a code.
   */
  readonly secrets?: readonly string[]
  /** Where an alarm goes. The host writes it to stderr. */
  readonly onAlarm?: (message: string) => void
  /** The header's timestamp and the alarm throttle. Entries carry their own. */
  readonly now?: () => number
}

/** What `qm console --verify-actions` reports; the four states of `deps.ts`. */
export interface ActionLedgerVerdict {
  readonly chain: AuditChainState
  /** Actions in the ledger; `0` when it is absent or broken. */
  readonly actions: number
  /** The first problem, when the chain is `broken`. */
  readonly issue?: { readonly line: number; readonly reason: string }
}

type Replay =
  | {
      readonly ok: true
      /** Lines in the file, the header included. */
      readonly lines: number
      readonly previous: string
      readonly records: readonly ActionRecord[]
    }
  | { readonly ok: false; readonly line: number; readonly reason: string }

type Replayed = Extract<Replay, { readonly ok: true }>

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

function withoutControlCharacters(text: string): string {
  let out = ''
  for (const char of text) {
    out += hasControlCharacter(char) ? '�' : char
  }
  return out
}

function isOutcome(value: string): value is ActionOutcome {
  return OUTCOMES.has(value)
}

function isActionName(value: string): boolean {
  return (
    value.length <= MAX_ACTION_LENGTH &&
    ACTION_NAME.test(value) &&
    !value.startsWith('ledger.')
  )
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length >= MIN_KNOWN_SECRET_LENGTH) {
      out = out.split(secret).join(REDACTED)
    }
  }
  return out.replace(MINTED_SECRET, REDACTED)
}

/** A target as it is written: no secret, no control character, bounded. */
function cleanTarget(raw: string, secrets: readonly string[]): string {
  const text = withoutControlCharacters(redact(raw, secrets))
  if (text.length === 0) return '-'
  return text.length > MAX_TARGET_LENGTH
    ? `${text.slice(0, MAX_TARGET_LENGTH - 1)}…`
    : text
}

function cleanCode(raw: string, secrets: readonly string[]): string | null {
  const text = redact(raw, secrets)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '_')
    .replace(/^[_.-]+/, '')
    .slice(0, 40)
  return CODE.test(text) ? text : null
}

/** One action as a ledger line's kind and data, or why it cannot be one. */
function encodeAction(
  entry: ConsoleAction,
  secrets: readonly string[],
):
  | { readonly kind: string; readonly at: number; readonly data: LedgerData }
  | string {
  if (!isActionName(entry.action)) return '动作名不合格'
  if (!SUBJECT.test(entry.subject)) return '主体不合格'
  if (!REQUEST_ID.test(entry.requestId)) return 'requestId 不合格'
  if (!isOutcome(entry.outcome)) return '结果不合格'
  const at = Math.floor(entry.at)
  if (!Number.isSafeInteger(at) || at < 0) return '时间不合格'
  const data: Record<string, LedgerValue> = {
    requestId: entry.requestId,
    subject: entry.subject,
    target: cleanTarget(entry.target, secrets),
    outcome: entry.outcome,
  }
  const code = entry.code === undefined ? null : cleanCode(entry.code, secrets)
  if (code !== null) data['code'] = code
  if (entry.breakGlass === true) data['breakGlass'] = true
  return { kind: entry.action, at, data }
}

function headerProblem(entry: LedgerEntry): string | null {
  if (entry.kind !== HEADER_KIND) return '首行不是账头'
  const keys = Object.keys(entry.data).sort()
  if (keys.length !== 2 || keys[0] !== 'ledger' || keys[1] !== 'version') {
    return '账头字段不对'
  }
  if (entry.data['ledger'] !== LEDGER_NAME) return '账名不对：这不是动作账本'
  if (entry.data['version'] !== LEDGER_VERSION) {
    return `版本不是 ${LEDGER_VERSION}`
  }
  return null
}

/** One line back into an action, or why it is not one. */
function decodeAction(entry: LedgerEntry): ActionRecord | string {
  if (!isActionName(entry.kind)) return '动作名不对'
  const data = entry.data
  for (const key of Object.keys(data)) {
    if (!DATA_KEYS.has(key)) return `多出字段 ${key}`
  }
  for (const key of REQUIRED_KEYS) {
    if (data[key] === undefined) return `缺字段 ${key}`
  }
  const { requestId, subject, target, outcome, code, breakGlass } = data
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
    return 'requestId 不对'
  }
  if (typeof subject !== 'string' || !SUBJECT.test(subject)) return '主体不对'
  if (
    typeof target !== 'string' ||
    target.length === 0 ||
    target.length > MAX_TARGET_LENGTH ||
    hasControlCharacter(target)
  ) {
    return 'target 不对'
  }
  if (typeof outcome !== 'string' || !isOutcome(outcome)) return '结果不对'
  if (code !== undefined && (typeof code !== 'string' || !CODE.test(code))) {
    return 'code 不对'
  }
  if (breakGlass !== undefined && breakGlass !== true) return 'breakGlass 不对'
  return {
    seq: entry.seq - 1,
    at: entry.at,
    requestId,
    subject,
    ...(breakGlass === true ? { breakGlass: true as const } : {}),
    action: entry.kind,
    target,
    outcome,
    ...(code === undefined ? {} : { code }),
  }
}

/** Read the whole ledger strictly: every line, or the first reason why not. */
function replayActions(text: string): Replay {
  const read = readLedger(text)
  if (!read.ok) return { ok: false, ...read.issue }
  const records: ActionRecord[] = []
  for (const entry of read.entries) {
    if (entry.seq === 1) {
      const problem = headerProblem(entry)
      if (problem !== null) return { ok: false, line: 1, reason: problem }
      continue
    }
    const record = decodeAction(entry)
    if (typeof record === 'string') {
      return { ok: false, line: entry.seq, reason: record }
    }
    records.push(record)
  }
  return {
    ok: true,
    lines: read.entries.length,
    previous: nextPrevious(read.entries),
    records,
  }
}

/**
 * Judge a ledger's text the way `qm audit --verify` judges a trail: absent
 * (no file), empty (a header and nothing after it, or not even that), intact,
 * or broken with the first problem.
 */
export function verifyActionLedger(text: string | null): ActionLedgerVerdict {
  if (text === null) return { chain: 'absent', actions: 0 }
  const replay = replayActions(text)
  if (!replay.ok) {
    return {
      chain: 'broken',
      actions: 0,
      issue: { line: replay.line, reason: replay.reason },
    }
  }
  return {
    chain: replay.records.length === 0 ? 'empty' : 'intact',
    actions: replay.records.length,
  }
}

/** One page of `records` (oldest first) for `query`, newest first. */
function pageOf(
  records: readonly ActionRecord[],
  query: ActionQuery,
): ActionPage {
  const asked = Math.floor(query.limit ?? DEFAULT_ACTION_PAGE)
  const limit = Number.isFinite(asked)
    ? Math.min(Math.max(1, asked), MAX_ACTION_PAGE)
    : DEFAULT_ACTION_PAGE
  const targets =
    query.targets === undefined ? undefined : new Set(query.targets)
  const entries: ActionRecord[] = []
  let more = false
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record === undefined) continue
    if (query.beforeSeq !== undefined && record.seq >= query.beforeSeq) {
      continue
    }
    if (query.subject !== undefined && record.subject !== query.subject) {
      continue
    }
    if (targets !== undefined && !targets.has(record.target)) continue
    if (
      query.actionPrefix !== undefined &&
      !record.action.startsWith(query.actionPrefix)
    ) {
      continue
    }
    if (entries.length === limit) {
      more = true
      break
    }
    entries.push(record)
  }
  const last = entries.at(-1)
  return {
    entries,
    nextBeforeSeq: more && last !== undefined ? last.seq : null,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ActionLedger implements ActionLedgerPort {
  readonly #store: ActionLedgerStore
  readonly #secrets: readonly string[]
  readonly #onAlarm: (message: string) => void
  readonly #now: () => number

  /** Lines in the file, the header included, as this process last saw it. */
  #lines = 0
  #previous = nextPrevious([])
  #stamp: string | null = null
  #problem: string | null = null
  #lastAlarmAt = Number.NEGATIVE_INFINITY

  constructor(options: ActionLedgerOptions) {
    this.#store = options.store
    this.#secrets = options.secrets ?? []
    this.#onAlarm = options.onAlarm ?? (() => {})
    this.#now = options.now ?? Date.now
    const replay = this.#replay()
    if (replay === null) return
    this.#lines = replay.lines
    this.#previous = replay.previous
    if (this.#lines === 0) {
      // Created now rather than at the first action: a console with accounts
      // on and nothing done yet has an empty ledger, not a missing one, and
      // `--verify-actions` can tell those two apart.
      this.#append(HEADER_KIND, Math.floor(this.#now()), {
        ledger: LEDGER_NAME,
        version: LEDGER_VERSION,
      })
      return
    }
    this.#refreshStamp()
  }

  /** The file, for the banner and the alarms. Not a secret. */
  get path(): string {
    return this.#store.path
  }

  /** Null while the ledger is usable; otherwise why it was closed. */
  get problem(): string | null {
    return this.#problem
  }

  admit(): Promise<ConsoleResult<void>> {
    return Promise.resolve(this.#usable() ? OK : CLOSED)
  }

  record(entry: ConsoleAction): Promise<ConsoleResult<void>> {
    const encoded = encodeAction(entry, this.#secrets)
    if (typeof encoded === 'string') {
      // A caller's bug, not the ledger's state: refuse this one entry and say
      // so loudly, but keep taking the rest.
      this.#onAlarm(`console actions: 拒收一条记录（${encoded}）`)
      return Promise.resolve({
        ok: false,
        failure: { code: 'invalid', message: encoded },
      })
    }
    if (!this.#usable()) return Promise.resolve(CLOSED)
    return Promise.resolve(
      this.#append(encoded.kind, encoded.at, encoded.data) ? OK : CLOSED,
    )
  }

  list(query: ActionQuery): Promise<ConsoleResult<ActionPage>> {
    if (this.#problem !== null) {
      this.#remind()
      return Promise.resolve(CLOSED)
    }
    const replay = this.#replay()
    if (replay === null || !this.#matches(replay) || !this.#refreshStamp()) {
      return Promise.resolve(CLOSED)
    }
    return Promise.resolve({ ok: true, value: pageOf(replay.records, query) })
  }

  // --- the file ----------------------------------------------------------

  #fail(reason: string): void {
    if (this.#problem === null) this.#problem = `${this.#store.path} ${reason}`
    this.#lastAlarmAt = this.#now()
    this.#onAlarm(
      `console actions: ${this.#store.path} ${reason}；写操作已暂停、操作记录拒绝读取。` +
        '把这个文件移走留证，再重启控制台',
    )
  }

  /** Repeat the alarm for a refused request, at most once a minute. */
  #remind(): void {
    if (this.#problem === null) return
    const now = this.#now()
    if (now - this.#lastAlarmAt < 60_000) return
    this.#lastAlarmAt = now
    this.#onAlarm(`console actions: ${this.#problem}；动作账本仍停用`)
  }

  /** The whole file, strictly; `null` (and closed) when it cannot be trusted. */
  #replay(): Replayed | null {
    let text: string | null
    try {
      text = this.#store.read()
    } catch (error) {
      this.#fail(`读不出来（${messageOf(error)}）`)
      return null
    }
    const replay = replayActions(text ?? '')
    if (!replay.ok) {
      this.#fail(`第 ${replay.line} 行：${replay.reason}`)
      return null
    }
    return replay
  }

  /** True when the file ends exactly where this process left it. */
  #matches(replay: Replayed): boolean {
    if (replay.lines === this.#lines && replay.previous === this.#previous) {
      return true
    }
    this.#fail('在控制台运行期间被改动：链尾与本进程写下的不一致')
    return false
  }

  #refreshStamp(): boolean {
    try {
      this.#stamp = this.#store.stamp()
      return true
    } catch (error) {
      this.#fail(`读不到文件状态（${messageOf(error)}）`)
      return false
    }
  }

  /**
   * Whether the next entry may be written. Cheap while the file is the one
   * this process last wrote; when its stamp moved, the whole file is read
   * again and must still end exactly where this process left it.
   */
  #usable(): boolean {
    if (this.#problem !== null) {
      this.#remind()
      return false
    }
    let stamp: string | null
    try {
      stamp = this.#store.stamp()
    } catch (error) {
      this.#fail(`读不到文件状态（${messageOf(error)}）`)
      return false
    }
    if (stamp !== null && stamp === this.#stamp) return true
    const replay = this.#replay()
    if (replay === null || !this.#matches(replay)) return false
    this.#stamp = stamp
    return true
  }

  #append(kind: string, at: number, data: LedgerData): boolean {
    const entry: LedgerEntry = {
      seq: this.#lines + 1,
      at,
      kind,
      data,
      prev: this.#previous,
    }
    try {
      this.#store.append(encodeLedgerEntry(entry))
    } catch (error) {
      this.#fail(`写不进去（${messageOf(error)}）`)
      return false
    }
    this.#lines = entry.seq
    this.#previous = ledgerDigest(entry)
    return this.#refreshStamp()
  }
}
