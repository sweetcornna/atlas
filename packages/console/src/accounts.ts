// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Personal accounts on the console: who they are, how they come to exist, and
 * the book that remembers both (`tenancy-m1.md` §1.1, §3.1–§3.5).
 *
 * ## Invitation, not registration, and no password
 *
 * An account exists because an `ops` holder (or, during migration, the admin
 * token) issued an invitation for one. The invitation is a single-use random
 * token bound to a role, alive for at most {@link INVITE_TTL_MS}; consuming it
 * mints the account and its **personal credential** — 32 random bytes, shown
 * once, stored as a SHA-256. There is no password: recovering one needs an
 * out-of-band channel, and the invitation already is that channel, so a reset
 * is "revoke the credential, issue a new invitation" (§3.1).
 *
 * ## One place decides, one place remembers
 *
 * Everything here is synchronous on purpose. "This invitation has not been
 * used" and "it is used now" must be one step: an `await` between them is the
 * window in which two concurrent redemptions of the same token both succeed.
 * The ledger port is synchronous for the same reason (`deps.ts`,
 * `LedgerPort`).
 *
 * The book replays its ledger strictly (`ledger.ts`) and then checks that
 * every line makes sense against the ones before it: an invitation consumed
 * twice, an account created from an invitation that never existed, a record
 * kind this version does not know. Any of those leaves the book
 * **unavailable** — personal access is refused, an alarm is raised, and the
 * two legacy tokens keep working so an operator can still reach the console
 * to see why. A write that fails does the same: memory and disk must never be
 * allowed to disagree, and the only safe side to fall on is the closed one.
 *
 * ## What is never on disk
 *
 * The invitation token and the personal credential. Both are hashed before
 * they are written, and the plaintext exists in exactly one response each.
 */

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import type { LedgerPort } from './deps.js'
import {
  encodeLedgerEntry,
  ledgerDigest,
  nextPrevious,
  readLedger,
  type LedgerData,
  type LedgerEntry,
} from './ledger.js'

/** Every personal credential starts with this. */
const PERSONAL_CREDENTIAL_PREFIX = 'qmu_'

/** Every invitation token starts with this. */
const INVITE_TOKEN_PREFIX = 'qmi_'

/** How long an invitation lives unless the issuer asks for less (§3.1: ≤ 72 h). */
const INVITE_TTL_MS = 72 * 60 * 60 * 1000

/** Shortest invitation an issuer may ask for. Anything shorter is a typo. */
const MIN_INVITE_TTL_MS = 5 * 60 * 1000

/**
 * Open (unused, unexpired, not withdrawn) invitations the console will hold
 * at once.
 *
 * Twenty covers a batch of new users for a 20–50 person beta, and caps what a
 * stolen `ops` credential can hand out before anybody reads the list. It is
 * also the ceiling on per-person quotas multiplying (§4.2): accounts only come
 * from invitations.
 */
export const MAX_OPEN_INVITES = 20

/** Longest note an issuer can attach to an invitation / account. */
const MAX_LABEL_LENGTH = 40

/** Bytes of randomness in an invitation token and a personal credential. */
const SECRET_BYTES = 32

/** The ledger format version this code writes and accepts. */
const LEDGER_VERSION = 1

/**
 * Every key a ledger record may carry. `#append` refuses any other, so a
 * record cannot grow a plaintext field by accident: a secret reaches disk only
 * as one of the `…Hash` keys. `test/invites.test.ts` scans this list.
 */
const LEDGER_FIELDS: ReadonlySet<string> = new Set([
  'ledger',
  'version',
  'inviteId',
  'tokenHash',
  'role',
  'expiresAt',
  'issuedBy',
  'subject',
  'label',
  'credentialHash',
  'by',
])

/** What an account may do. `tenancy-m1.md` §3.2 has the table. */
export type AccountRole = 'viewer' | 'member' | 'ops'

/** A person, as the console names them: `u:` and 16 lowercase hex digits. */
export type AccountSubject = `u:${string}`

const ROLES: ReadonlySet<string> = new Set(['viewer', 'member', 'ops'])
const SUBJECT = /^u:[0-9a-f]{16}$/
const INVITE_ID = /^[0-9a-f]{16}$/
const DIGEST = /^[0-9a-f]{64}$/
/** Who may be named as the one who issued, withdrew or revoked something. */
const ACTOR = /^(u:[0-9a-f]{16}|legacy:admin)$/

function isRole(value: unknown): value is AccountRole {
  return typeof value === 'string' && ROLES.has(value)
}

function isSubject(value: unknown): value is AccountSubject {
  return typeof value === 'string' && SUBJECT.test(value)
}

/**
 * Refuse a legacy token that looks like one of this module's secrets.
 *
 * The prefixes are how the console tells a personal credential in a query
 * string from a legacy token that is allowed there, and how the page script
 * decides what it may keep. A legacy token that happened to start with one
 * would make both calls wrong, so a console with accounts on will not start
 * with one. `resolveTokens` is not touched for this (`tenancy-m1.md` §3.4):
 * its three rules are about the tokens, this one is about accounts.
 */
export function assertTokensUnlikeAccountSecrets(tokens: {
  readonly view: string
  readonly admin: string
}): void {
  for (const [which, token] of [
    ['view', tokens.view],
    ['admin', tokens.admin],
  ] as const) {
    if (
      token.startsWith(PERSONAL_CREDENTIAL_PREFIX) ||
      token.startsWith(INVITE_TOKEN_PREFIX)
    ) {
      throw new Error(
        `开启账号时 ${which} token 不能以 ${PERSONAL_CREDENTIAL_PREFIX} 或 ` +
          `${INVITE_TOKEN_PREFIX} 开头；这两个前缀留给个人凭据与邀请，请换一枚 token。`,
      )
    }
  }
}

/** Why the book said no. `code` is for the HTTP layer, `message` for people. */
export interface AccountRefusal {
  readonly code: 'unavailable' | 'refused' | 'invalid' | 'not_found' | 'limit'
  readonly message: string
}

export type AccountOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: AccountRefusal }

/** The one answer every unusable, expired, withdrawn or unknown invitation gets. */
const INVITE_REFUSED = '邀请无效或已失效'

/** What the issuer gets back, exactly once. */
interface IssuedInvite {
  readonly inviteId: string
  /** The plaintext token. Not stored anywhere; this is its only appearance. */
  readonly token: string
  readonly role: AccountRole
  readonly expiresAt: number
  /** Present on a reset invitation: the account it restores. */
  readonly subject?: AccountSubject
}

/** What the invitee gets back, exactly once. */
interface AcceptedInvite {
  readonly subject: AccountSubject
  readonly role: AccountRole
  /** The plaintext personal credential. Its only appearance. */
  readonly credential: string
}

/** One invitation as the account list shows it. Never the token or its hash. */
interface InviteSummary {
  readonly inviteId: string
  readonly role: AccountRole
  readonly issuedAt: number
  readonly expiresAt: number
  readonly issuedBy: string
  readonly state: 'open' | 'expired' | 'consumed' | 'withdrawn'
  readonly subject?: AccountSubject
  readonly label?: string
}

/** One account as the account list shows it. Never the credential or its hash. */
interface AccountSummary {
  readonly subject: AccountSubject
  readonly role: AccountRole
  readonly createdAt: number
  readonly state: 'active' | 'reset' | 'revoked'
  readonly label?: string
}

interface InviteState {
  readonly inviteId: string
  readonly tokenHash: string
  readonly role: AccountRole
  readonly issuedAt: number
  readonly expiresAt: number
  readonly issuedBy: string
  readonly subject?: AccountSubject
  readonly label?: string
  state: 'open' | 'consumed' | 'withdrawn'
}

interface AccountState {
  readonly subject: AccountSubject
  readonly role: AccountRole
  readonly createdAt: number
  readonly label?: string
  credentialHash: string | null
  revoked: boolean
}

export interface AccountBookOptions {
  /** The account ledger (`accounts.ndjson`). */
  readonly accounts: LedgerPort
  readonly now?: () => number
  /** Source of randomness. Injected only so a collision can be forced in a test. */
  readonly randomBytes?: (size: number) => Uint8Array
  /** Where an alarm goes. The host writes it to stderr. */
  readonly onAlarm?: (message: string) => void
}

/** SHA-256 hex of a secret. The only form a secret takes on disk. */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/** True when a label is acceptable; `undefined` is always acceptable. */
function labelProblem(label: string | undefined): string | null {
  if (label === undefined) return null
  if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
    return `备注须为 1 到 ${MAX_LABEL_LENGTH} 个字符`
  }
  for (let i = 0; i < label.length; i += 1) {
    const code = label.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return '备注不能含控制字符'
  }
  return null
}

function str(data: LedgerData, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' ? value : undefined
}

function num(data: LedgerData, key: string): number | undefined {
  const value = data[key]
  return typeof value === 'number' ? value : undefined
}

/** One ledger: the file, what it replayed to, and where its chain ends. */
class Chain {
  readonly port: LedgerPort
  readonly name: string
  count = 0
  previous = ''

  constructor(port: LedgerPort, name: string) {
    this.port = port
    this.name = name
  }
}

export class AccountBook {
  readonly #now: () => number
  readonly #random: (size: number) => Uint8Array
  readonly #onAlarm: (message: string) => void
  readonly #accounts: Chain

  readonly #invites = new Map<string, InviteState>()
  readonly #inviteByHash = new Map<string, string>()
  readonly #accountsBySubject = new Map<AccountSubject, AccountState>()
  readonly #subjectByCredential = new Map<string, AccountSubject>()

  #problem: string | null = null

  constructor(options: AccountBookOptions) {
    this.#now = options.now ?? Date.now
    this.#random = options.randomBytes ?? (size => nodeRandomBytes(size))
    this.#onAlarm = options.onAlarm ?? (() => {})
    this.#accounts = new Chain(options.accounts, 'accounts')
    this.#load(this.#accounts, entry => this.#applyAccount(entry))
  }

  /** Null when the book is usable; otherwise the reason it is not. */
  get problem(): string | null {
    return this.#problem
  }

  // --- loading -----------------------------------------------------------

  #fail(reason: string): void {
    if (this.#problem === null) this.#problem = reason
    this.#onAlarm(`console accounts: ${reason}；个人账号暂停服务`)
  }

  #load(chain: Chain, apply: (entry: LedgerEntry) => string | null): void {
    let text: string | null
    try {
      text = chain.port.read()
    } catch (error) {
      this.#fail(
        `${chain.port.path} 读不出来（${error instanceof Error ? error.message : String(error)}）`,
      )
      return
    }
    const read = readLedger(text ?? '')
    if (!read.ok) {
      this.#fail(
        `${chain.port.path} 第 ${read.issue.line} 行：${read.issue.reason}`,
      )
      return
    }
    for (const entry of read.entries) {
      const problem =
        entry.seq === 1 ? this.#header(chain, entry) : apply(entry)
      if (problem !== null) {
        this.#fail(`${chain.port.path} 第 ${entry.seq} 行：${problem}`)
        return
      }
    }
    chain.count = read.entries.length
    chain.previous = nextPrevious(read.entries)
    if (chain.count === 0) {
      this.#append(chain, 'ledger.header', {
        ledger: chain.name,
        version: LEDGER_VERSION,
      })
    }
  }

  #header(chain: Chain, entry: LedgerEntry): string | null {
    if (entry.kind !== 'ledger.header') return '首行不是账头'
    if (str(entry.data, 'ledger') !== chain.name) return '账名不对'
    if (num(entry.data, 'version') !== LEDGER_VERSION) {
      return `版本不是 ${LEDGER_VERSION}`
    }
    return null
  }

  /** Append one entry. False when it did not land, and the book is closed. */
  #append(chain: Chain, kind: string, data: LedgerData): boolean {
    if (this.#problem !== null) return false
    for (const key of Object.keys(data)) {
      // A programming error rather than a state of the world, so it throws
      // instead of closing the book: nothing was written.
      if (!LEDGER_FIELDS.has(key)) {
        throw new Error(`ledger field ${key} is not on the persisted list`)
      }
    }
    const entry: LedgerEntry = {
      seq: chain.count + 1,
      at: this.#now(),
      kind,
      data,
      prev: chain.previous,
    }
    try {
      chain.port.append(encodeLedgerEntry(entry))
    } catch (error) {
      this.#fail(
        `${chain.port.path} 写不进去（${error instanceof Error ? error.message : String(error)}）`,
      )
      return false
    }
    chain.count = entry.seq
    chain.previous = ledgerDigest(entry)
    return true
  }

  // --- replay ------------------------------------------------------------

  /** Apply one account-ledger entry, or say why it cannot be applied. */
  #applyAccount(entry: LedgerEntry): string | null {
    const data = entry.data
    switch (entry.kind) {
      case 'invite.issued': {
        const inviteId = str(data, 'inviteId')
        const tokenHash = str(data, 'tokenHash')
        const role = data['role']
        const expiresAt = num(data, 'expiresAt')
        const issuedBy = str(data, 'issuedBy')
        const subject = data['subject']
        const label = str(data, 'label')
        if (inviteId === undefined || !INVITE_ID.test(inviteId)) {
          return 'inviteId 不对'
        }
        if (this.#invites.has(inviteId)) return 'inviteId 重复'
        if (tokenHash === undefined || !DIGEST.test(tokenHash)) {
          return 'tokenHash 不对'
        }
        if (this.#inviteByHash.has(tokenHash)) return 'tokenHash 重复'
        if (!isRole(role)) return 'role 不对'
        if (expiresAt === undefined || expiresAt <= entry.at) {
          return 'expiresAt 不对'
        }
        if (issuedBy === undefined || !ACTOR.test(issuedBy)) {
          return 'issuedBy 不对'
        }
        if (subject !== undefined) {
          if (!isSubject(subject)) return 'subject 不对'
          const account = this.#accountsBySubject.get(subject)
          if (account === undefined || account.revoked) {
            return '重置邀请指向的账号不存在或已吊销'
          }
          if (account.role !== role) return '重置邀请的角色与账号不符'
        }
        if (labelProblem(label) !== null) return 'label 不对'
        this.#invites.set(inviteId, {
          inviteId,
          tokenHash,
          role,
          issuedAt: entry.at,
          expiresAt,
          issuedBy,
          ...(subject === undefined ? {} : { subject }),
          ...(label === undefined ? {} : { label }),
          state: 'open',
        })
        this.#inviteByHash.set(tokenHash, inviteId)
        return null
      }
      case 'invite.withdrawn': {
        const invite = this.#invites.get(str(data, 'inviteId') ?? '')
        if (invite === undefined) return '撤回了不存在的邀请'
        if (invite.state !== 'open') return '撤回了不是未用状态的邀请'
        if (!ACTOR.test(str(data, 'by') ?? '')) return 'by 不对'
        invite.state = 'withdrawn'
        return null
      }
      case 'account.created': {
        const invite = this.#invites.get(str(data, 'inviteId') ?? '')
        const subject = data['subject']
        const credentialHash = str(data, 'credentialHash')
        const label = str(data, 'label')
        if (invite === undefined) return '开户所用的邀请不存在'
        if (invite.state !== 'open') return '开户所用的邀请不是未用状态'
        if (invite.subject !== undefined) return '重置邀请被当成开户邀请'
        if (entry.at > invite.expiresAt) return '开户时邀请已过期'
        if (!isSubject(subject)) return 'subject 不对'
        if (this.#accountsBySubject.has(subject)) return 'subject 重复'
        if (data['role'] !== invite.role) return 'role 与邀请不符'
        if (credentialHash === undefined || !DIGEST.test(credentialHash)) {
          return 'credentialHash 不对'
        }
        if (this.#subjectByCredential.has(credentialHash)) {
          return 'credentialHash 重复'
        }
        if (labelProblem(label) !== null) return 'label 不对'
        invite.state = 'consumed'
        this.#accountsBySubject.set(subject, {
          subject,
          role: invite.role,
          createdAt: entry.at,
          ...(label === undefined ? {} : { label }),
          credentialHash,
          revoked: false,
        })
        this.#subjectByCredential.set(credentialHash, subject)
        return null
      }
      default:
        // A kind this version does not know is not skipped: skipping is how a
        // record that mattered — a revocation written by a newer build —
        // silently stops mattering.
        return `不认识的记录 ${entry.kind}`
    }
  }

  // --- secrets -----------------------------------------------------------

  #secret(prefix: string): string {
    return `${prefix}${base64url(this.#random(SECRET_BYTES))}`
  }

  /** A fresh id that no invitation has ever carried. */
  #newInviteId(): string {
    for (;;) {
      const id = hex(this.#random(8))
      if (!this.#invites.has(id)) return id
    }
  }

  /** A fresh subject that no account has ever carried, revoked ones included. */
  #newSubject(): AccountSubject {
    for (;;) {
      const subject: AccountSubject = `u:${hex(this.#random(8))}`
      if (!this.#accountsBySubject.has(subject)) return subject
    }
  }

  #unavailable<T>(): AccountOutcome<T> {
    return {
      ok: false,
      refusal: {
        code: 'unavailable',
        message:
          '账号库校验未通过，个人账号暂停服务；请运维查看控制台的错误输出',
      },
    }
  }

  // --- invitations -------------------------------------------------------

  /** Invitations that could still be consumed right now. */
  #openInvites(now: number): number {
    let open = 0
    for (const invite of this.#invites.values()) {
      if (invite.state === 'open' && invite.expiresAt > now) open += 1
    }
    return open
  }

  /**
   * Issue an invitation. The token in the answer is the only copy there will
   * ever be; the ledger gets its hash.
   */
  issueInvite(input: {
    readonly role: AccountRole
    readonly issuedBy: string
    readonly ttlMs?: number
    readonly label?: string
  }): AccountOutcome<IssuedInvite> {
    if (this.#problem !== null) return this.#unavailable()
    if (!isRole(input.role)) {
      return {
        ok: false,
        refusal: {
          code: 'invalid',
          message: '角色只能是 viewer、member 或 ops',
        },
      }
    }
    if (!ACTOR.test(input.issuedBy)) {
      return {
        ok: false,
        refusal: { code: 'invalid', message: '签发人不对' },
      }
    }
    const ttl = input.ttlMs ?? INVITE_TTL_MS
    if (
      !Number.isSafeInteger(ttl) ||
      ttl < MIN_INVITE_TTL_MS ||
      ttl > INVITE_TTL_MS
    ) {
      return {
        ok: false,
        refusal: {
          code: 'invalid',
          message: '邀请时效须在 5 分钟到 72 小时之间',
        },
      }
    }
    const label = labelProblem(input.label)
    if (label !== null) {
      return { ok: false, refusal: { code: 'invalid', message: label } }
    }
    return this.#issue(input.role, input.issuedBy, ttl, input.label, undefined)
  }

  #issue(
    role: AccountRole,
    issuedBy: string,
    ttl: number,
    label: string | undefined,
    subject: AccountSubject | undefined,
  ): AccountOutcome<IssuedInvite> {
    const now = this.#now()
    if (this.#openInvites(now) >= MAX_OPEN_INVITES) {
      return {
        ok: false,
        refusal: {
          code: 'limit',
          message: `未用的邀请已有 ${MAX_OPEN_INVITES} 份，先撤回或等它们过期`,
        },
      }
    }
    const token = this.#secret(INVITE_TOKEN_PREFIX)
    const tokenHash = hashSecret(token)
    const inviteId = this.#newInviteId()
    const expiresAt = now + ttl
    const data: Record<string, string | number> = {
      inviteId,
      tokenHash,
      role,
      expiresAt,
      issuedBy,
    }
    if (subject !== undefined) data['subject'] = subject
    if (label !== undefined) data['label'] = label
    if (!this.#append(this.#accounts, 'invite.issued', data)) {
      return this.#unavailable()
    }
    this.#invites.set(inviteId, {
      inviteId,
      tokenHash,
      role,
      issuedAt: now,
      expiresAt,
      issuedBy,
      ...(subject === undefined ? {} : { subject }),
      ...(label === undefined ? {} : { label }),
      state: 'open',
    })
    this.#inviteByHash.set(tokenHash, inviteId)
    return {
      ok: true,
      value: {
        inviteId,
        token,
        role,
        expiresAt,
        ...(subject === undefined ? {} : { subject }),
      },
    }
  }

  /** Withdraw an open invitation, which also frees its place under the cap. */
  withdrawInvite(inviteId: string, by: string): AccountOutcome<void> {
    if (this.#problem !== null) return this.#unavailable()
    const invite = this.#invites.get(inviteId)
    if (invite === undefined || invite.state !== 'open') {
      return {
        ok: false,
        refusal: { code: 'not_found', message: '没有这份未用的邀请' },
      }
    }
    if (!ACTOR.test(by)) {
      return { ok: false, refusal: { code: 'invalid', message: '操作人不对' } }
    }
    if (!this.#append(this.#accounts, 'invite.withdrawn', { inviteId, by })) {
      return this.#unavailable()
    }
    invite.state = 'withdrawn'
    return { ok: true, value: undefined }
  }

  /**
   * Consume an invitation and mint the credential it promised.
   *
   * Unknown, expired, consumed and withdrawn all get the same refusal, and none
   * of them changes anything: telling a holder which of the four it was is
   * information about somebody else's invitation.
   */
  acceptInvite(token: string): AccountOutcome<AcceptedInvite> {
    if (this.#problem !== null) return this.#unavailable()
    const refused: AccountOutcome<AcceptedInvite> = {
      ok: false,
      refusal: { code: 'refused', message: INVITE_REFUSED },
    }
    if (!token.startsWith(INVITE_TOKEN_PREFIX)) return refused
    const inviteId = this.#inviteByHash.get(hashSecret(token))
    const invite =
      inviteId === undefined ? undefined : this.#invites.get(inviteId)
    const now = this.#now()
    if (
      invite === undefined ||
      invite.state !== 'open' ||
      now > invite.expiresAt
    ) {
      return refused
    }
    const credential = this.#secret(PERSONAL_CREDENTIAL_PREFIX)
    const credentialHash = hashSecret(credential)
    const subject = this.#newSubject()
    const data: Record<string, string> = {
      inviteId: invite.inviteId,
      subject,
      role: invite.role,
      credentialHash,
    }
    if (invite.label !== undefined) data['label'] = invite.label
    if (!this.#append(this.#accounts, 'account.created', data)) {
      return this.#unavailable()
    }
    invite.state = 'consumed'
    this.#accountsBySubject.set(subject, {
      subject,
      role: invite.role,
      createdAt: now,
      ...(invite.label === undefined ? {} : { label: invite.label }),
      credentialHash,
      revoked: false,
    })
    this.#subjectByCredential.set(credentialHash, subject)
    return { ok: true, value: { subject, role: invite.role, credential } }
  }

  // --- reading -----------------------------------------------------------

  /** Accounts and invitations, newest first, with no secret and no hash in them. */
  list(): AccountOutcome<{
    readonly accounts: readonly AccountSummary[]
    readonly invites: readonly InviteSummary[]
  }> {
    if (this.#problem !== null) return this.#unavailable()
    const now = this.#now()
    const accounts: AccountSummary[] = [...this.#accountsBySubject.values()]
      .map(account => ({
        subject: account.subject,
        role: account.role,
        createdAt: account.createdAt,
        state: account.revoked
          ? ('revoked' as const)
          : account.credentialHash === null
            ? ('reset' as const)
            : ('active' as const),
        ...(account.label === undefined ? {} : { label: account.label }),
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
    const invites: InviteSummary[] = [...this.#invites.values()]
      .map(invite => ({
        inviteId: invite.inviteId,
        role: invite.role,
        issuedAt: invite.issuedAt,
        expiresAt: invite.expiresAt,
        issuedBy: invite.issuedBy,
        state:
          invite.state === 'open' && now > invite.expiresAt
            ? ('expired' as const)
            : invite.state,
        ...(invite.subject === undefined ? {} : { subject: invite.subject }),
        ...(invite.label === undefined ? {} : { label: invite.label }),
      }))
      .sort((a, b) => b.issuedAt - a.issuedAt)
    return { ok: true, value: { accounts, invites } }
  }
}
