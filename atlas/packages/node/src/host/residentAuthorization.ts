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
  readonly #waiters = new Map<string, (approved: boolean) => void>()
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
    call: AuthzCall,
    origin: AuthzOrigin,
    deadlineAt: number,
    watchdogRemainingMs: number,
    send: (request: AuthzRequest, wire: string) => void,
  ): Promise<boolean> {
    if (origin.trust !== 'verified-capability') {
      this.#audit('authz.refused', undefined, {
        status: 'unsigned-turn',
        tool: call.toolName,
      })
      return false
    }
    const used =
      call.toolName === 'qianmo_memory_write'
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
      return true
    }
    if (used.kind === 'refused') {
      this.#audit('authz.refused', undefined, {
        status: used.reason,
        tool: call.toolName,
      })
      return false
    }
    const asked = this.store.ask({ ...call, origin })
    if (asked.kind !== 'pending') {
      this.#audit('authz.refused', undefined, {
        status: asked.reason,
        tool: call.toolName,
      })
      return false
    }
    if (asked.created)
      this.#audit('authz.requested', asked.request, { status: 'pending' })
    const waitMs = approvalWaitBudget(
      deadlineAt - this.#now(),
      watchdogRemainingMs,
    )
    if (waitMs === 0) return false
    return await new Promise<boolean>(resolve => {
      const finish = (approved: boolean) => {
        clearTimeout(timer)
        this.#waiters.delete(asked.request.requestId)
        const result = approved ? this.store.use(call) : undefined
        if (result?.kind === 'hit')
          this.#audit('authz.grant_used', asked.request, {
            scope: result.grant.scope,
            approver: result.grant.approver,
            expiresAt: result.grant.expiresAt,
          })
        resolve(result?.kind === 'hit')
      }
      const timer = setTimeout(() => finish(false), waitMs)
      this.#waiters.set(asked.request.requestId, finish)
      try {
        send(asked.request, this.signed(asked.request))
      } catch {
        finish(false)
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
            request.toolName === 'qianmo_memory_write',
        )
    ) {
      this.#audit('authz.refused', undefined, {
        status: 'memory-write-requires-once',
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
    this.#waiters.get(outcome.request.requestId)?.(outcome.grant !== null)
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
    this.#waiters.get(outcome.requestId)?.(false)
    return true
  }
  close(): void {
    for (const resolve of [...this.#waiters.values()]) resolve(false)
    this.store.close()
  }
}
