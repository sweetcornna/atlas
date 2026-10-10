// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from 'node:crypto'
import {
  StaticPublicKeyDirectory,
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
  type QianmoMessage,
} from '@qianmo/protocol'
import { TransportClient } from '@qianmo/transport'
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
  readonly onError?: (error: unknown) => void
}
const refusal = (
  code: 'refused' | 'unreachable' | 'invalid' | 'not_found',
  message: string,
): ConsoleResult<never> => ({ ok: false, failure: { code, message } })
const freshMs = 30 * 60_000

/** A durable approval index plus proactive, mutually authenticated node links. */
export class ConsoleApprovals implements ApprovalPort {
  readonly #options: ConsoleApprovalsOptions
  readonly #router: NodeRouter
  readonly #node: string
  readonly #now: () => number
  readonly #requests = new Map<string, CachedRequest>()
  readonly #links = new Map<string, TransportClient>()
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
        onMessage: message => this.#receive(target, message),
        onReady: () => {
          void this.#subscribe(target).catch(error =>
            this.#options.onError?.(error),
          )
          void this.#flushRevokes()
        },
      })
      this.#links.set(target.node, link)
    }
    await link.connect(5_000)
    return link
  }

  async #subscribe(target: ApprovalEndpoint): Promise<void> {
    const link = await this.#link(target)
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
  }

  start(): void {
    if (this.#timer || this.#closed) return
    const connect = async (): Promise<void> => {
      await Promise.all(
        this.#options.targets.map(async target => {
          try {
            await this.#subscribe(target)
          } catch (error) {
            this.#options.onError?.(error)
          }
        }),
      )
      await this.#flushRevokes()
    }
    void connect()
    this.#timer = setInterval(() => {
      void connect()
    }, 10_000)
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
        cached.request.toolName === 'qianmo_memory_write' &&
        input.decision === 'allow-window'
      )
        return refusal('invalid', '记忆写入必须逐次批准，不支持授权窗口')
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
        exp: Math.min(cached.request.exp, this.#now() + 60_000),
        nonce: randomBytes(24).toString('base64url'),
      })
      this.#append('decision', { requestId: input.requestId, wire: decision })
      cached.approver = approver
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
      this.#options.onError?.(error)
      return refusal('unreachable', '节点未确认审批结果 请检查节点状态')
    } finally {
      if (locked) this.#busy.delete(input.requestId)
      void this.#flushRevokes()
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
        text: `Continue the operation associated with approval ${cached.request.requestId}. Keep the approved tool and arguments unchanged.`,
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
      this.#options.onError?.(error)
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
        this.#options.onError?.(error)
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
