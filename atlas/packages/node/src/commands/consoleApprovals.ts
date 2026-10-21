// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { freshApprovalTool } from '../host/residentAuthorization.js'
import { randomBytes } from 'node:crypto'
import {
  StaticPublicKeyDirectory,
  authzDigest,
  MAX_AUTHZ_WINDOW_MS,
  parseAuthzDecision,
  signAuthzDecision,
  signAuthzRevoke,
  verifyAuthzDecisionSignature,
  verifyAuthzRequest,
  type AuthzRequest,
  type NodeKeyPair,
} from '@qianmo/capability'
import {
  AccountBook,
  encodeLedgerEntry,
  mayApprove,
  nextPrevious,
  readLedger,
  settingsCallOf,
  type ApprovalDecisionInput,
  type ApprovalContinueResult,
  type ChatPort,
  type UsagePort,
  type ApprovalItem,
  type ApprovalPort,
  type ConsolePrincipal,
  type ConsoleResult,
  type LedgerEntry,
  type LedgerPort,
  type TenantPort,
} from '@qianmo/console'
import {
  assertAddress,
  createMessage,
  LEGACY_MESSAGE_TYPES,
  MessageType,
  ProtocolErrorCode,
  type QianmoMessage,
} from '@qianmo/protocol'
import { TransportClient, TransportReceiptError } from '@qianmo/transport'
import { NodeRouter } from '@qianmo/router'

export interface ApprovalEndpoint {
  readonly node: string
  readonly url: string
  readonly psk: string
  readonly publicKey: string
}
interface CachedRequest {
  readonly request: AuthzRequest
  status: ApprovalItem['status']
  approver?: string
  revokePending?: boolean
  continuation?: 'reserved' | 'sent'
  once?: boolean
  allowedUntil?: number
  approvedAt?: number
  consumed?: boolean
}
/**
 * One node's approval subscription, as far as the hub knows it.
 *
 * The node keeps a subscription on the logical channel it arrived on, with no
 * expiry (`#approvalChannels` in `host/resident.ts`); the transport server
 * drops that channel when its socket goes away with nothing unreceipted, and
 * every reconnect calls `onReady`. So one accepted subscription per connection
 * is all a node needs, and repeating it only writes the node's audit trail.
 */
interface Subscription {
  /** The `connectionGeneration` the node accepted the subscription on. */
  generation?: string
  /** The subscription in flight, shared by the periodic check and `onReady`. */
  running?: Promise<void>
  /** After a refusal: no new subscription before this, save on reconnect. */
  retryAt?: number
  /** What was last logged, so the same problem is logged once. */
  problem?: string
}
export interface ConsoleApprovalsOptions {
  readonly from: string
  readonly accounts: AccountBook
  readonly commandKeys: NodeKeyPair
  readonly approvalKeys: NodeKeyPair
  readonly targets: readonly ApprovalEndpoint[]
  readonly ledger: LedgerPort & { close?(): void }
  readonly tenancy?: TenantPort
  readonly chat?: ChatPort
  readonly usage?: UsagePort
  readonly now?: () => number
  /** Period of the redial and revoke check, 10 s; tests shorten it. */
  readonly checkEveryMs?: number
  /** Link keep-alive period, the transport's 15 s; tests shorten it. */
  readonly keepAliveIntervalMs?: number
  readonly onError?: (error: unknown) => void
}
const refusal = (
  code: 'refused' | 'unreachable' | 'invalid' | 'not_found',
  message: string,
): ConsoleResult<never> => ({ ok: false, failure: { code, message } })
const freshMs = 30 * 60_000
/** The P40 change tool: one approval per change, bound to `SettingsBound`. */
const SETTINGS_TOOL = 'qianmo_settings_change'
const ROLE_RANK: Readonly<Record<string, number>> = {
  viewer: 0,
  member: 1,
  ops: 2,
}

/** The role a settings change needs (`bound.card.role`), or null when unreadable. */
function settingsRole(input: unknown): 'ops' | 'member' | null {
  const card =
    typeof input === 'object' && input !== null && 'card' in input
      ? (input as { readonly card?: unknown }).card
      : undefined
  const role =
    typeof card === 'object' && card !== null && 'role' in card
      ? (card as { readonly role?: unknown }).role
      : undefined
  return role === 'ops' || role === 'member' ? role : null
}

/** Whether `role` is at least `needed`. */
function roleCovers(role: string, needed: 'ops' | 'member'): boolean {
  return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[needed] ?? 99)
}

/**
 * Until when an allowed request may be used here. A settings change is made
 * by the identical call in the turn 批准并继续 starts, after the decision's
 * minute on the wire, so it lasts as long as its request (the node's grant
 * does the same); a connector call is taken by the call that waited for it.
 */
function allowedUntil(request: AuthzRequest, decisionExp: number): number {
  return request.toolName === SETTINGS_TOOL ? request.exp : decisionExp
}

/**
 * What the 批准并继续 turn is asked to do. That turn may run in a session that
 * never saw the original call, so it names the tool and, for a settings
 * change whose bound gives them back, the exact arguments the person approved.
 */
function continuationText(request: AuthzRequest): string {
  const head = `Continue the operation associated with approval ${request.requestId}`
  const call =
    request.toolName === SETTINGS_TOOL ? settingsCallOf(request.input) : null
  return call === null
    ? `${head}: call ${request.toolName} again with the arguments it was approved with. Keep the approved tool and arguments unchanged.`
    : `${head}: call ${request.toolName} once with exactly these arguments, then report its answer: ${JSON.stringify(call)}`
}
/** A refusing node is asked again after this, or when its link reconnects. */
const refusedRetryMs = 10 * 60_000

/** A durable approval index plus proactive, mutually authenticated node links. */
export class ConsoleApprovals implements ApprovalPort {
  readonly #options: ConsoleApprovalsOptions
  readonly #router: NodeRouter
  readonly #node: string
  readonly #now: () => number
  readonly #requests = new Map<string, CachedRequest>()
  readonly #links = new Map<string, TransportClient>()
  readonly #subscriptions = new Map<string, Subscription>()
  readonly #entries: LedgerEntry[] = []
  readonly #busy = new Set<string>()
  readonly #continuing = new Set<string>()
  readonly #accountEpoch = new Map<string, number>()
  readonly #detach: () => void
  #problem: string | null = null
  #closed = false
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(options: ConsoleApprovalsOptions) {
    this.#options = options
    this.#node = assertAddress(options.from).node
    this.#router = new NodeRouter({ node: this.#node })
    this.#now = options.now ?? Date.now
    if (options.commandKeys.publicKey === options.approvalKeys.publicKey)
      throw new Error('approval and commander keys must differ')
    if (
      new Set(options.targets.map(target => target.node)).size !==
      options.targets.length
    )
      throw new Error('duplicate approval node')
    const journal = readLedger(options.ledger.read() ?? '')
    if (!journal.ok) throw new Error('approval ledger is corrupt')
    for (const entry of journal.entries) {
      const id = entry.data['requestId']
      if (entry.kind === 'request') {
        const node = entry.data['node'],
          wire = entry.data['wire']
        const target = options.targets.find(item => item.node === node)
        const request =
          target && typeof wire === 'string'
            ? verifyAuthzRequest(wire, target.publicKey)
            : null
        if (
          !request ||
          request.iss !== node ||
          this.#requests.has(request.requestId)
        )
          throw new Error('invalid approval request ledger')
        this.#requests.set(request.requestId, { request, status: 'pending' })
      } else if (entry.kind === 'decision') {
        const wire = entry.data['wire'],
          parts = typeof wire === 'string' ? parseAuthzDecision(wire) : null
        const cached =
          typeof id === 'string' ? this.#requests.get(id) : undefined
        if (
          !parts ||
          !cached ||
          !verifyAuthzDecisionSignature(
            parts,
            options.approvalKeys.publicKey,
          ) ||
          parts.value.requestId !== id ||
          parts.value.digest !== cached.request.digest ||
          parts.value.aud !== cached.request.iss ||
          parts.value.sub !== cached.request.sub ||
          !parts.value.approver.startsWith(`${this.#node}/`)
        )
          throw new Error('invalid approval decision ledger')
        cached.status = 'delivery-unknown'
        cached.approver = parts.value.approver
        cached.once = parts.value.decision === 'allow-once'
        cached.allowedUntil = allowedUntil(cached.request, parts.value.exp)
        cached.approvedAt = parts.value.nbf
      } else if (entry.kind === 'delivered') {
        const cached =
          typeof id === 'string' ? this.#requests.get(id) : undefined
        if (
          !cached ||
          cached.status !== 'delivery-unknown' ||
          !['allowed', 'denied'].includes(String(entry.data['status']))
        )
          throw new Error('invalid approval receipt ledger')
        cached.status = entry.data['status'] as 'allowed' | 'denied'
      } else if (
        entry.kind === 'connector-consumed' ||
        entry.kind === 'settings-consumed'
      ) {
        const cached =
          typeof id === 'string' ? this.#requests.get(id) : undefined
        if (
          !cached ||
          cached.consumed ||
          !cached.once ||
          entry.data['digest'] !== cached.request.digest ||
          (entry.kind === 'settings-consumed') !==
            (cached.request.toolName === SETTINGS_TOOL)
        )
          throw new Error(
            entry.kind === 'settings-consumed'
              ? 'invalid settings action ledger'
              : 'invalid connector action ledger',
          )
        cached.consumed = true
      } else if (entry.kind === 'continuation' || entry.kind === 'continued') {
        const cached =
          typeof id === 'string' ? this.#requests.get(id) : undefined
        if (
          !cached ||
          (entry.kind === 'continuation'
            ? cached.continuation !== undefined
            : cached.continuation !== 'reserved')
        )
          throw new Error('invalid approval continuation ledger')
        cached.continuation =
          entry.kind === 'continuation' ? 'reserved' : 'sent'
      } else if (entry.kind === 'revoke' || entry.kind === 'revoked') {
        const cached =
          typeof id === 'string' ? this.#requests.get(id) : undefined
        if (!cached || cached.approver === undefined)
          throw new Error('invalid approval revocation ledger')
        cached.revokePending = entry.kind === 'revoke'
        cached.status = 'denied'
      } else throw new Error('unknown approval ledger event')
      this.#entries.push(entry)
    }
    // A crash may occur after account reset but before its fanout. Restart revokes
    // all surviving grants, avoiding any dependency on stale credential generations.
    for (const cached of this.#requests.values())
      if (cached.status === 'allowed' || cached.status === 'delivery-unknown')
        this.#queueRevoke(cached)
    this.#detach = options.accounts.onAccountEnded(event => {
      this.#accountEpoch.set(
        event.subject,
        (this.#accountEpoch.get(event.subject) ?? 0) + 1,
      )
      try {
        for (const cached of this.#requests.values())
          if (
            cached.approver === `${this.#node}/${event.subject}` &&
            (cached.status === 'allowed' ||
              cached.status === 'delivery-unknown')
          )
            this.#queueRevoke(cached)
        void this.#flushRevokes()
      } catch (error) {
        this.#options.onError?.(error)
      }
    })
  }

  #append(kind: string, data: LedgerEntry['data']): void {
    if (this.#problem !== null) throw new Error(this.#problem)
    const entry = {
      seq: this.#entries.length + 1,
      at: this.#now(),
      kind,
      data,
      prev: nextPrevious(this.#entries),
    }
    try {
      this.#options.ledger.append(encodeLedgerEntry(entry))
      this.#entries.push(entry)
    } catch (error) {
      this.#problem = 'approval ledger unavailable'
      this.#options.onError?.(error)
      throw error
    }
  }

  #visible(
    principal: ConsolePrincipal,
    cached: CachedRequest,
    approve = false,
  ): boolean {
    if (this.#closed || this.#problem || principal.kind !== 'user') return false
    const listing = this.#options.accounts.list()
    const account = listing.ok
      ? listing.value.accounts.find(
          row => row.subject === principal.subject && row.state === 'active',
        )
      : undefined
    if (
      !account ||
      account.role !== principal.role ||
      account.role === 'viewer'
    )
      return false
    if (this.#options.tenancy) {
      const config = this.#options.tenancy.read().config
      if (!config.platformSubjects.includes(principal.subject)) {
        const tenant = config.subjects.find(
          row => row.subject === principal.subject,
        )?.tenant
        if (
          tenant === undefined ||
          config.nodes.find(row => row.nodeId === cached.request.iss)
            ?.tenant !== tenant
        )
          return false
      }
    }
    const owner = this.#options.accounts.ownerOf(cached.request.contextId)
    if (!approve) return principal.role === 'ops' || owner === principal.subject
    const age = this.#now() - principal.authenticatedAt
    return age >= 0 && age < freshMs && mayApprove(principal, owner)
  }

  async list(
    principal: ConsolePrincipal,
  ): Promise<ConsoleResult<readonly ApprovalItem[]>> {
    if (this.#problem) return refusal('unreachable', this.#problem)
    try {
      return {
        ok: true,
        value: [...this.#requests.values()]
          .filter(cached => this.#visible(principal, cached))
          .map(({ request, status, continuation }) => ({
            ...(continuation === undefined ? {} : { continuation }),
            requestId: request.requestId,
            node: request.iss,
            agent: request.sub,
            contextId: request.contextId,
            owner: this.#options.accounts.ownerOf(request.contextId),
            toolName: request.toolName,
            input: request.input,
            digest: request.digest,
            createdAt: request.iat,
            expiresAt: request.exp,
            origin: request.origin,
            status:
              status === 'pending' && request.exp <= this.#now()
                ? 'expired'
                : status,
          }))
          .sort((a, b) => b.createdAt - a.createdAt),
      }
    } catch {
      return refusal('unreachable', '审批配置不可用')
    }
  }

  #receive(target: ApprovalEndpoint, message: QianmoMessage): void {
    if (message.type !== MessageType.AuthzRequest)
      throw new Error('unsupported approval message')
    const payload = message.payload
    const wire =
      payload && typeof payload === 'object' && 'request' in payload
        ? payload.request
        : undefined
    const request =
      typeof wire === 'string'
        ? verifyAuthzRequest(wire, target.publicKey)
        : null
    if (
      !request ||
      request.iss !== target.node ||
      assertAddress(message.from).node !== target.node ||
      message.to !== this.#options.from ||
      request.iat > this.#now() ||
      request.exp <= this.#now() ||
      request.exp - request.iat > MAX_AUTHZ_WINDOW_MS
    )
      throw new Error('invalid or expired approval request')
    const previous = this.#requests.get(request.requestId)
    if (previous) {
      if (
        previous.request.digest !== request.digest ||
        previous.request.contextId !== request.contextId ||
        previous.request.iss !== request.iss
      )
        throw new Error('approval request identity collision')
      return
    }
    this.#append('request', { wire: wire as string, node: target.node })
    this.#requests.set(request.requestId, { request, status: 'pending' })
  }

  async #link(target: ApprovalEndpoint): Promise<TransportClient> {
    if (this.#closed) throw new Error('approvals stopped')
    let link = this.#links.get(target.node)
    if (!link || link.isClosed()) {
      link = new TransportClient({
        endpoint: { url: target.url },
        node: this.#node,
        peerNode: target.node,
        psk: target.psk,
        supportedTypes: [...LEGACY_MESSAGE_TYPES, MessageType.AuthzRequest],
        signing: {
          keys: this.#options.commandKeys,
          directory: new StaticPublicKeyDirectory([
            [target.node, target.publicKey],
          ]),
          required: true,
        },
        ...(this.#options.keepAliveIntervalMs === undefined
          ? {}
          : { keepAliveIntervalMs: this.#options.keepAliveIntervalMs }),
        onMessage: message => this.#receive(target, message),
        // Each (re)connection may land on a fresh channel at the node, so
        // this is when a subscription is owed — refusal back-off or not,
        // since a node that comes back may have been upgraded.
        onReady: () => {
          void this.#maintain(target, true)
          void this.#flushRevokes()
        },
      })
      this.#links.set(target.node, link)
    }
    await link.connect(5_000)
    return link
  }

  /** A line for the log that names the node it is about. */
  #report(node: string, what: string, error?: unknown): void {
    this.#options.onError?.(
      error === undefined
        ? `节点 ${node} ${what}`
        : `节点 ${node} ${what} · ${String(error)}`,
    )
  }

  /**
   * Subscribe to `target` when this connection is not subscribed yet.
   *
   * The periodic check only redials a dead link: a link still reconnecting is
   * its own client's job (and `onReady` subscribes), a live one already
   * subscribed is left alone, and a node that refused is asked again after
   * {@link refusedRetryMs}. Never rejects.
   */
  #maintain(target: ApprovalEndpoint, reconnected = false): Promise<void> {
    if (this.#closed) return Promise.resolve()
    const state = this.#subscriptions.get(target.node) ?? {}
    this.#subscriptions.set(target.node, state)
    if (state.running) return state.running
    const link = this.#links.get(target.node)
    if (!reconnected) {
      if (
        link &&
        !link.isClosed() &&
        (!link.isReady() || state.generation === link.connectionGeneration)
      )
        return Promise.resolve()
      if (state.retryAt !== undefined && this.#now() < state.retryAt)
        return Promise.resolve()
    }
    const running = this.#subscribe(target, state).finally(() => {
      state.running = undefined
    })
    state.running = running
    return running
  }

  async #subscribe(
    target: ApprovalEndpoint,
    state: Subscription,
  ): Promise<void> {
    try {
      const link = await this.#link(target)
      const generation = link.connectionGeneration
      const routed = this.#router.outbound(
        createMessage({
          from: this.#options.from,
          to: `qianmo://${target.node}/console`,
          type: MessageType.AuthzRequest,
          payload: { subscribe: true },
        }),
      )
      if (!routed.ok) throw new Error('approval subscription refused by router')
      await link.sendAndWait(routed.message, 5_000)
      // A reconnect while waiting moved the node to a new channel; the next
      // check subscribes that one unless its own `onReady` already did.
      if (
        generation !== null &&
        this.#links.get(target.node) === link &&
        link.connectionGeneration === generation
      )
        state.generation = generation
      state.retryAt = undefined
      if (state.problem !== undefined) {
        state.problem = undefined
        this.#report(target.node, '审批订阅已恢复')
      }
    } catch (error) {
      if (this.#closed) return
      // A rejected receipt says resending the same bytes will not help: an old
      // build has no `authz.request` at all (E_BAD_TYPE), a new one refuses
      // a hub that is not its approver. Anything else is the link.
      const code =
        error instanceof TransportReceiptError
          ? (error.receiptCode ?? 'rejected')
          : undefined
      if (code !== undefined) state.retryAt = this.#now() + refusedRetryMs
      const problem = code === undefined ? 'unreachable' : `refused:${code}`
      if (state.problem === problem) return
      state.problem = problem
      const retry = `${refusedRetryMs / 60_000} 分钟后或重连时再试`
      if (code === undefined) this.#report(target.node, '审批订阅失败', error)
      else if (code === ProtocolErrorCode.E_BAD_TYPE)
        this.#report(target.node, `不支持审批（E_BAD_TYPE），${retry}`)
      else this.#report(target.node, `拒绝审批订阅（${code}），${retry}`)
    }
  }

  start(): void {
    if (this.#timer || this.#closed) return
    const check = async (): Promise<void> => {
      await Promise.all(
        this.#options.targets.map(target => this.#maintain(target)),
      )
      await this.#flushRevokes()
    }
    void check()
    this.#timer = setInterval(() => {
      void check()
    }, this.#options.checkEveryMs ?? 10_000)
    this.#timer.unref?.()
  }

  async #send(
    cached: CachedRequest,
    type: MessageType.AuthzDecision | MessageType.AuthzRevoke,
    payload: Record<string, string>,
    authorized?: () => boolean,
  ): Promise<void> {
    const target = this.#options.targets.find(
      row => row.node === cached.request.iss,
    )
    if (!target) throw new Error('approval node is not configured')
    const link = await this.#link(target)
    if (authorized?.() === false)
      throw new Error('approval identity changed during connection')
    const draft = createMessage({
      from: this.#options.from,
      to: cached.request.sub,
      type,
      payload,
      contextId: cached.request.contextId,
    })
    const routed = this.#router.outbound(draft)
    if (!routed.ok) throw new Error('approval message refused by router')
    await link.sendAndWait(routed.message, 5_000)
  }

  async decide(
    principal: ConsolePrincipal,
    input: ApprovalDecisionInput,
  ): Promise<ConsoleResult<{ readonly delivered: boolean }>> {
    const cached = this.#requests.get(input.requestId)
    if (!cached) return refusal('not_found', '没有这条审批请求')
    const epoch = this.#accountEpoch.get(principal.subject) ?? 0
    const authorized = () =>
      epoch === (this.#accountEpoch.get(principal.subject) ?? 0) &&
      this.#visible(principal, cached, true)
    let locked = false
    try {
      if (!this.#visible(principal, cached, true))
        return refusal('refused', '审批需要有效的本人凭据与会话权限')
      if (
        cached.status !== 'pending' ||
        cached.request.exp <= this.#now() ||
        this.#busy.has(input.requestId) ||
        input.digest !== cached.request.digest
      )
        return refusal('refused', '审批请求已变化或失效')
      if (
        freshApprovalTool(cached.request.toolName) &&
        input.decision === 'allow-window'
      )
        return refusal('invalid', '此工具必须逐次批准，不支持授权窗口')
      if (cached.request.toolName === SETTINGS_TOOL) {
        // P40 §5.2: a change is approved once, by somebody who could make it.
        if (input.decision === 'allow-window')
          return refusal('invalid', '设置更改只能逐次批准 不支持授权窗口')
        const needed = settingsRole(cached.request.input)
        if (
          needed === null ||
          principal.kind !== 'user' ||
          !roleCovers(principal.role, needed)
        )
          return refusal(
            'refused',
            needed === 'ops'
              ? '这项更改需要运维批准'
              : '这项更改需要成员或运维批准',
          )
      }
      const windowMs = input.windowMs ?? 0
      if (
        !['allow-once', 'allow-window', 'deny'].includes(input.decision) ||
        !Number.isSafeInteger(windowMs) ||
        (input.decision === 'allow-window'
          ? windowMs <= 0 || windowMs > MAX_AUTHZ_WINDOW_MS
          : windowMs !== 0)
      )
        return refusal('invalid', '审批时长无效')
      this.#busy.add(input.requestId)
      locked = true
      const approver = `${this.#node}/${principal.subject}`
      const exp = Math.min(cached.request.exp, this.#now() + 60_000)
      const decision = signAuthzDecision(this.#options.approvalKeys, {
        v: 1,
        requestId: input.requestId,
        aud: cached.request.iss,
        sub: cached.request.sub,
        digest: cached.request.digest,
        decision: input.decision,
        windowMs,
        approver,
        nbf: this.#now(),
        exp,
        nonce: randomBytes(24).toString('base64url'),
      })
      this.#append('decision', { requestId: input.requestId, wire: decision })
      cached.approver = approver
      cached.once = input.decision === 'allow-once'
      cached.allowedUntil = allowedUntil(cached.request, exp)
      cached.approvedAt = this.#now()
      cached.status = 'delivery-unknown'
      await this.#send(
        cached,
        MessageType.AuthzDecision,
        { decision },
        authorized,
      )
      if (!cached.revokePending) {
        const status = input.decision === 'deny' ? 'denied' : 'allowed'
        this.#append('delivered', { requestId: input.requestId, status })
        cached.status = status
      }
      // An account can be revoked while the socket awaits its receipt.
      if (!authorized() || cached.revokePending) {
        this.#queueRevoke(cached)
        await this.#flushRevokes()
        return refusal('refused', '审批身份已失效 已撤销授权')
      }
      return { ok: true, value: { delivered: true } }
    } catch (error) {
      this.#report(cached.request.iss, '未确认审批结果', error)
      return refusal('unreachable', '节点未确认审批结果 请检查节点状态')
    } finally {
      if (locked) this.#busy.delete(input.requestId)
      void this.#flushRevokes()
    }
  }

  /** Hub is the P14 approver: consume its own durable record before any external mutation. */
  consumeConnector(input: {
    readonly requestId: string
    readonly node: string
    readonly agent: string
    readonly contextId: string
    readonly toolName: string
    readonly input: Record<string, unknown>
  }): boolean {
    const cached = this.#requests.get(input.requestId)
    if (
      !cached ||
      !cached.once ||
      cached.consumed ||
      cached.revokePending ||
      !['allowed', 'delivery-unknown'].includes(cached.status) ||
      (cached.allowedUntil ?? 0) <= this.#now() ||
      cached.request.exp <= this.#now() ||
      cached.request.iss !== input.node ||
      cached.request.sub !== `qianmo://${input.node}/${input.agent}` ||
      cached.request.contextId !== input.contextId ||
      cached.request.toolName !== input.toolName
    )
      return false
    if (
      !['qianmo_mail_send', 'qianmo_calendar_create'].includes(input.toolName)
    )
      return false
    const digest = authzDigest(input)
    if (cached.request.digest !== digest) return false
    const subject = cached.approver?.slice(this.#node.length + 1)
    const accounts = this.#options.accounts.list()
    const account = accounts.ok
      ? accounts.value.accounts.find(
          row => row.subject === subject && row.state === 'active',
        )
      : undefined
    if (
      !account ||
      !this.#visible(
        {
          kind: 'user',
          subject: account.subject,
          role: account.role,
          credential: 'approval-session',
          authenticatedAt: cached.approvedAt ?? 0,
        },
        cached,
        true,
      )
    )
      return false
    try {
      this.#append('connector-consumed', { requestId: input.requestId, digest })
      cached.consumed = true
      return true
    } catch {
      return false
    }
  }

  /**
   * The settings change's approval (P40 §5.2), consumed before the change is
   * made: the same state checks as {@link consumeConnector}, a digest over the
   * bound the hub has just computed again from the real arguments, and an
   * approver who is still an active account with at least the role the change
   * needs. Answers that approver, to make the change as; `null` for anything
   * else, and nothing is consumed then.
   */
  consumeSettings(input: {
    readonly requestId: string
    readonly node: string
    readonly agent: string
    readonly contextId: string
    readonly bound: unknown
    readonly callId: string
  }): Extract<ConsolePrincipal, { kind: 'user' }> | null {
    const cached = this.#requests.get(input.requestId)
    if (
      !cached ||
      !cached.once ||
      cached.consumed ||
      cached.revokePending ||
      !['allowed', 'delivery-unknown'].includes(cached.status) ||
      (cached.allowedUntil ?? 0) <= this.#now() ||
      cached.request.exp <= this.#now() ||
      cached.request.iss !== input.node ||
      cached.request.sub !== `qianmo://${input.node}/${input.agent}` ||
      cached.request.contextId !== input.contextId ||
      cached.request.toolName !== SETTINGS_TOOL
    )
      return null
    const digest = authzDigest({
      node: input.node,
      agent: input.agent,
      contextId: input.contextId,
      toolName: SETTINGS_TOOL,
      input: input.bound,
    })
    if (cached.request.digest !== digest) return null
    const needed = settingsRole(input.bound)
    const subject = cached.approver?.slice(this.#node.length + 1)
    const accounts = this.#options.accounts.list()
    const account = accounts.ok
      ? accounts.value.accounts.find(
          row => row.subject === subject && row.state === 'active',
        )
      : undefined
    if (!account || needed === null || !roleCovers(account.role, needed))
      return null
    const approver: Extract<ConsolePrincipal, { kind: 'user' }> = {
      kind: 'user',
      subject: account.subject,
      role: account.role,
      credential: 'approval-session',
      authenticatedAt: cached.approvedAt ?? 0,
    }
    if (!this.#visible(approver, cached, true)) return null
    try {
      this.#append('settings-consumed', {
        requestId: input.requestId,
        digest,
        callId: input.callId,
      })
      cached.consumed = true
      return approver
    } catch {
      return null
    }
  }

  /** A new, metered inbound task, never a retry of an uncertain send. */
  async continue(
    principal: ConsolePrincipal,
    input: { readonly requestId: string; readonly digest: string },
  ): Promise<ApprovalContinueResult> {
    const cached = this.#requests.get(input.requestId),
      chat = this.#options.chat
    if (!cached || !chat || !this.#options.usage)
      return refusal('not_found', '审批请求、原会话或用量记录不可用')
    let reservation: string | undefined
    let accepted = false
    let locked = false
    const epoch = this.#accountEpoch.get(principal.subject) ?? 0
    const authorized = () =>
      epoch === (this.#accountEpoch.get(principal.subject) ?? 0) &&
      this.#visible(principal, cached, true) &&
      !cached.revokePending &&
      (cached.status === 'pending' || cached.status === 'allowed') &&
      cached.request.exp > this.#now() &&
      input.digest === cached.request.digest
    try {
      if (
        cached.continuation ||
        this.#continuing.has(input.requestId) ||
        !authorized()
      )
        return refusal('refused', '审批继续已提交或权限已变化，请查看原会话')
      this.#continuing.add(input.requestId)
      locked = true
      const original = cached.request.origin.taskId
      if (!original || cached.request.origin.from !== this.#options.from)
        return refusal('refused', '审批请求没有本控制台的原任务关联')
      const transcript = await chat.transcript(cached.request.contextId)
      if (!transcript.ok) return transcript
      const { session, turns } = transcript.value
      const rows = turns.filter(row => row.variant !== 'notice')
      const completed = new Set(
        rows
          .filter(
            row =>
              row.author === 'agent' &&
              (row.state === 'done' || row.state === 'failed'),
          )
          .map(row => row.taskId),
      )
      if (
        !authorized() ||
        session.target !== cached.request.sub ||
        session.node !== cached.request.iss ||
        !rows.some(
          row => row.taskId === original && row.author === 'operator',
        ) ||
        !rows.some(
          row =>
            row.taskId === original &&
            row.author === 'agent' &&
            row.remoteTerminal === true &&
            (row.state === 'done' || row.state === 'failed'),
        ) ||
        rows.some(
          row =>
            ['pending', 'delivered', 'read'].includes(row.state) &&
            !completed.has(row.taskId),
        )
      )
        return refusal('refused', '原任务尚未终止或会话忙碌，请等待原任务结束')
      const tenant = this.#options.tenancy
        ?.read()
        .config.nodes.find(row => row.nodeId === cached.request.iss)?.tenant
      const admitted = this.#options.usage?.reserve(
        {
          subject: principal.subject,
          kind: 'person',
          ...(tenant === undefined ? {} : { tenant }),
        },
        { sessionId: session.id, operation: 'message' },
      )
      if (admitted && !admitted.ok) return { ok: false, quota: admitted }
      reservation = admitted?.reservationId
      // Fsync intent before granting or sending. A crash/ambiguous receipt never
      // turns a browser retry into a second model task or a second charge.
      this.#append('continuation', {
        requestId: input.requestId,
        originalTaskId: original,
      })
      cached.continuation = 'reserved'
      if (cached.status === 'pending') {
        const decision = await this.decide(principal, {
          ...input,
          decision: 'allow-once',
        })
        if (!decision.ok) return decision
      }
      if (!authorized())
        return refusal('refused', '审批权限已变化，继续任务未发送')
      const sent = await chat.send({
        sessionId: session.id,
        text: continuationText(cached.request),
        continuation: { afterTaskId: original, authorized },
        ...(reservation === undefined ? {} : { usageReservation: reservation }),
      })
      if (!sent.ok) return sent
      accepted = true
      if (sent.value.deliveryUnknown || !sent.value.taskId)
        return refusal(
          'unreachable',
          '继续任务结果未确认，请查看原会话；不会自动重发',
        )
      this.#append('continued', {
        requestId: input.requestId,
        taskId: sent.value.taskId,
      })
      cached.continuation = 'sent'
      return {
        ok: true,
        value: { sessionId: session.id, taskId: sent.value.taskId },
      }
    } catch (error) {
      this.#report(cached.request.iss, '审批后的继续任务未确认', error)
      return refusal(
        'unreachable',
        '继续任务结果未确认，请查看原会话；不会自动重发',
      )
    } finally {
      if (locked) this.#continuing.delete(input.requestId)
      if (!accepted && reservation !== undefined)
        this.#options.usage?.finish(reservation)
    }
  }

  #queueRevoke(cached: CachedRequest): void {
    if (cached.revokePending) return
    this.#append('revoke', { requestId: cached.request.requestId })
    cached.revokePending = true
    cached.status = 'denied'
  }

  async #flushRevokes(): Promise<void> {
    for (const cached of this.#requests.values()) {
      const id = cached.request.requestId
      if (
        !cached.revokePending ||
        !cached.approver ||
        this.#busy.has(id) ||
        this.#closed
      )
        continue
      this.#busy.add(id)
      try {
        const revoke = signAuthzRevoke(this.#options.approvalKeys, {
          v: 1,
          requestId: id,
          aud: cached.request.iss,
          approver: cached.approver,
          nbf: this.#now(),
          exp: this.#now() + 60_000,
          nonce: randomBytes(24).toString('base64url'),
        })
        await this.#send(cached, MessageType.AuthzRevoke, { revoke })
        this.#append('revoked', { requestId: id })
        cached.revokePending = false
      } catch (error) {
        this.#report(cached.request.iss, '撤销授权未完成', error)
      } finally {
        this.#busy.delete(id)
      }
    }
  }

  async revoke(
    principal: ConsolePrincipal,
    requestId: string,
  ): Promise<ConsoleResult<{ readonly delivered: boolean }>> {
    const cached = this.#requests.get(requestId)
    if (!cached || !cached.approver)
      return refusal('not_found', '没有这条已签发授权')
    try {
      if (!this.#visible(principal, cached, true))
        return refusal('refused', '撤销需要有效的本人凭据与会话权限')
      this.#queueRevoke(cached)
      await this.#flushRevokes()
      return cached.revokePending
        ? refusal('unreachable', '撤销已记账 等待节点确认')
        : { ok: true, value: { delivered: true } }
    } catch {
      return refusal('unreachable', '审批账本不可用')
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#detach()
    if (this.#timer) clearInterval(this.#timer)
    await Promise.all([...this.#links.values()].map(link => link.close()))
    this.#options.ledger.close?.()
  }
}
