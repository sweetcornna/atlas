// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  FileGrantStore,
  ResidentHardline,
  type ResidentEstop,
  type AuthzCall,
} from '@qianmo/resident'
import {
  parseAuthzDecision,
  signAuthzRequest,
  type AuthzOrigin,
  type AuthzRequest,
  type NodeKeyPair,
} from '@qianmo/capability'
import { qianmoConfigPath, protectedConfigRoots } from '@qianmo/paths'
import {
  desktopArgs,
  desktopSummary,
  isDesktopTool,
} from '@qianmo/extension/desktopPolicy'

/**
 * Tools whose every call asks anew. A settings change (P40) is not one: the
 * store takes it once and never on a window, but a 批准并继续 turn making the
 * identical call uses the approval already given instead of asking again.
 */
export function freshApprovalTool(name: string): boolean {
  return (
    [
      'qianmo_memory_write',
      'qianmo_mail_send',
      'qianmo_calendar_create',
    ].includes(name) ||
    // 云端电脑 (P21): every browser/computer action waits for its own approval.
    name.startsWith('qianmo_browser_') ||
    name.startsWith('qianmo_computer_') ||
    // 高权限模式 (P39): an elevated command, network or GitHub call that the
    // tier sends to the operator is approved exactly once, never windowed.
    name.startsWith('qianmo_elevated_')
  )
}

/**
 * A desktop call's approval card gets one readable line (P21+ §6.2), made
 * from the canonical arguments beside it and signed with them. Typed text
 * shows as its length only.
 */
export function withDesktopSummary(call: AuthzCall): AuthzCall {
  if (!isDesktopTool(call.toolName)) return call
  let summary: string
  try {
    summary = desktopSummary(
      call.toolName,
      desktopArgs(call.toolName, call.input.args),
    )
  } catch {
    return call
  }
  return { ...call, input: { ...call.input, summary } }
}

/** Keep ten seconds for the model/tool response to unwind before watchdog expiry. */
export function approvalWaitBudget(
  taskRemainingMs: number,
  watchdogRemainingMs: number,
): number {
  return Math.max(
    0,
    Math.min(60_000, taskRemainingMs, watchdogRemainingMs - 10_000),
  )
}

/**
 * How one approval ended for the caller. `pending` is the wait running out
 * with the request still open: a decision that comes later makes a grant the
 * same call uses when it is made again (批准并继续). `requestId` names the
 * request whose grant let the call through, a grant made before included.
 */
type AuthzOutcome =
  | { readonly kind: 'allowed'; readonly requestId: string }
  | { readonly kind: 'denied'; readonly requestId: string }
  | { readonly kind: 'pending'; readonly requestId: string }
  | { readonly kind: 'refused' }

/** Why a wait ended: a decision, a revoke or shutdown, or the budget. */
type WaitEnd = 'allowed' | 'denied' | 'cancelled' | 'timeout'

export interface ResidentAuthzEvent {
  readonly kind: string
  readonly taskId?: string
  readonly traceId?: string
  readonly detail: Readonly<Record<string, string | number | boolean>>
}
export interface ResidentAuthorizationOptions {
  readonly node: string
  readonly keys: NodeKeyPair
  readonly approvers: ReadonlyMap<string, string>
  readonly commanderKeys: () => Iterable<string>
  readonly memoryRoot: string
  readonly protectedRoots?: readonly string[]
  readonly estop: ResidentEstop
  readonly audit?: (event: ResidentAuthzEvent) => void
  readonly now?: () => number
}

/** Host-owned synchronous tool approval. No channel can start a model turn. */
export class ResidentAuthorization {
  readonly store: FileGrantStore
  readonly #options: ResidentAuthorizationOptions
  readonly #waiters = new Map<
    string,
    (end: WaitEnd, expiresAt?: number) => void
  >()
  readonly #now: () => number
  constructor(options: ResidentAuthorizationOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.store = new FileGrantStore({
      path: qianmoConfigPath('resident', 'authz.ndjson'),
      node: options.node,
      approvers: options.approvers,
      commanderKeys: options.commanderKeys,
      hardline: new ResidentHardline({
        stateRoots: protectedConfigRoots(),
        protectedRoots: [
          ...protectedConfigRoots(),
          options.memoryRoot,
          ...(options.protectedRoots ?? []),
        ],
      }),
      estop: options.estop,
      now: this.#now,
    })
    this.#audit('authz.posture', undefined, {
      status: 'approval-enabled',
      scope: 'exact-file-write',
      expiresAt: 60_000,
    })
  }
  #audit(
    kind: string,
    request: AuthzRequest | undefined,
    extra: Record<string, string | number | boolean> = {},
  ): void {
    this.#options.audit?.({
      kind,
      ...(request?.origin.taskId ? { taskId: request.origin.taskId } : {}),
      ...(request?.origin.traceId ? { traceId: request.origin.traceId } : {}),
      detail: {
        ...(request === undefined
          ? {}
          : {
              requestId: request.requestId,
              agent: request.sub.split('/').at(-1) ?? '',
              contextId: request.contextId,
              from: request.origin.from ?? '',
              trust: request.origin.trust,
              tool: request.toolName,
              digest: request.digest,
              expiresAt: request.exp,
            }),
        ...extra,
      },
    })
  }
  signed(request: AuthzRequest): string {
    return signAuthzRequest(this.#options.keys, request)
  }
  pendingFor(peer: string): readonly AuthzRequest[] {
    return this.store
      .pending()
      .filter(
        request =>
          request.origin.from?.startsWith(`qianmo://${peer}/`) === true,
      )
  }
  async request(
    raw: AuthzCall,
    origin: AuthzOrigin,
    deadlineAt: number,
    watchdogRemainingMs: number,
    send: (request: AuthzRequest, wire: string) => void,
    beforeConsume?: (
      expiresAt?: number,
      requestId?: string,
      valid?: () => boolean,
    ) => boolean,
  ): Promise<boolean> {
    const outcome = await this.requestOutcome(
      raw,
      origin,
      deadlineAt,
      watchdogRemainingMs,
      send,
      beforeConsume,
    )
    return outcome.kind === 'allowed'
  }
  /** {@link request}, telling a person's no from a wait that ran out. */
  async requestOutcome(
    raw: AuthzCall,
    origin: AuthzOrigin,
    deadlineAt: number,
    watchdogRemainingMs: number,
    send: (request: AuthzRequest, wire: string) => void,
    beforeConsume?: (
      expiresAt?: number,
      requestId?: string,
      valid?: () => boolean,
    ) => boolean,
  ): Promise<AuthzOutcome> {
    // Asked, used and consumed as one input, so the summary is in the digest.
    const call = withDesktopSummary(raw)
    if (origin.trust !== 'verified-capability') {
      this.#audit('authz.refused', undefined, {
        status: 'unsigned-turn',
        tool: call.toolName,
      })
      return { kind: 'refused' }
    }
    const used = freshApprovalTool(call.toolName)
      ? { kind: 'miss' as const }
      : this.store.use(call)
    if (used.kind === 'hit') {
      this.#audit('authz.grant_used', undefined, {
        requestId: used.grant.requestId,
        contextId: call.contextId,
        tool: call.toolName,
        digest: used.grant.digest,
        scope: used.grant.scope,
        approver: used.grant.approver,
        expiresAt: used.grant.expiresAt,
      })
      return { kind: 'allowed', requestId: used.grant.requestId }
    }
    if (used.kind === 'refused') {
      this.#audit('authz.refused', undefined, {
        status: used.reason,
        tool: call.toolName,
      })
      return { kind: 'refused' }
    }
    const asked = this.store.ask({ ...call, origin })
    if (asked.kind !== 'pending') {
      this.#audit('authz.refused', undefined, {
        status: asked.reason,
        tool: call.toolName,
      })
      return { kind: 'refused' }
    }
    if (asked.created)
      this.#audit('authz.requested', asked.request, { status: 'pending' })
    const waitMs = approvalWaitBudget(
      deadlineAt - this.#now(),
      watchdogRemainingMs,
    )
    if (waitMs === 0) return { kind: 'refused' }
    const requestId = asked.request.requestId
    return await new Promise<AuthzOutcome>(resolve => {
      const finish = (end: WaitEnd, expiresAt?: number) => {
        clearTimeout(timer)
        this.#waiters.delete(requestId)
        if (end !== 'allowed') {
          resolve(
            end === 'denied'
              ? { kind: 'denied', requestId }
              : end === 'timeout'
                ? { kind: 'pending', requestId }
                : { kind: 'refused' },
          )
          return
        }
        let outcome: AuthzOutcome = { kind: 'refused' }
        try {
          const result =
            (beforeConsume?.(expiresAt, requestId, () =>
              this.store.consumedGrantValid(requestId),
            ) ?? true)
              ? this.store.use(call)
              : undefined
          // A fresh-approval tool runs only on the grant made for this very
          // request, once; a window grant never stands in for it.
          if (
            result?.kind === 'hit' &&
            (!freshApprovalTool(call.toolName) ||
              (result.grant.requestId === requestId &&
                result.grant.scope === 'once'))
          ) {
            this.#audit('authz.grant_used', asked.request, {
              scope: result.grant.scope,
              approver: result.grant.approver,
              expiresAt: result.grant.expiresAt,
            })
            outcome = { kind: 'allowed', requestId: result.grant.requestId }
          }
        } catch {
          /* An intent/audit write failure denies even a signed permit. */
        }
        resolve(outcome)
      }
      const timer = setTimeout(() => finish('timeout'), waitMs)
      this.#waiters.set(requestId, finish)
      try {
        send(asked.request, this.signed(asked.request))
      } catch {
        finish('cancelled')
      }
    })
  }
  decision(wire: unknown): boolean {
    const parsed = parseAuthzDecision(wire)
    if (
      parsed?.value.decision === 'allow-window' &&
      this.store
        .pending()
        .some(
          request =>
            request.requestId === parsed.value.requestId &&
            freshApprovalTool(request.toolName),
        )
    ) {
      this.#audit('authz.refused', undefined, {
        status: 'tool-requires-once',
      })
      return false
    }
    const outcome = this.store.applyDecision(wire)
    if (!outcome.ok) {
      this.#audit('authz.refused', undefined, { status: outcome.reason })
      return false
    }
    this.#audit('authz.decision', outcome.request, {
      status: outcome.decision,
      ...(outcome.grant === null
        ? {}
        : {
            approver: outcome.grant.approver,
            scope: outcome.grant.scope,
            expiresAt: outcome.grant.expiresAt,
          }),
    })
    this.#waiters.get(outcome.request.requestId)?.(
      outcome.grant === null ? 'denied' : 'allowed',
      outcome.grant?.expiresAt,
    )
    return true
  }
  revoke(wire: unknown): boolean {
    const outcome = this.store.applyRevoke(wire)
    if (!outcome.ok) {
      this.#audit('authz.refused', undefined, { status: outcome.reason })
      return false
    }
    this.#audit('authz.revoked', undefined, {
      requestId: outcome.requestId,
      status: 'revoked',
    })
    this.#waiters.get(outcome.requestId)?.('cancelled')
    return true
  }
  cancelDesktop(agent: string): void {
    const requests = this.store
      .pending()
      .filter(
        r =>
          r.sub === `qianmo://${this.#options.node}/${agent}` &&
          (r.toolName.startsWith('qianmo_browser_') ||
            r.toolName.startsWith('qianmo_computer_')),
      )
    this.store.cancelRequests(requests.map(r => r.requestId))
    for (const r of requests) this.#waiters.get(r.requestId)?.('cancelled')
  }
  /** Revoke/ESTOP/regrant: drop every pending elevated approval for one agent. */
  cancelElevation(agent: string): void {
    const requests = this.store
      .pending()
      .filter(
        r =>
          r.sub === `qianmo://${this.#options.node}/${agent}` &&
          r.toolName.startsWith('qianmo_elevated_'),
      )
    this.store.cancelRequests(requests.map(r => r.requestId))
    for (const r of requests) this.#waiters.get(r.requestId)?.('cancelled')
  }
  close(): void {
    for (const resolve of [...this.#waiters.values()]) resolve('cancelled')
    this.store.close()
  }
}
