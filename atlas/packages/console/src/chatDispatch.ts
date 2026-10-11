// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type Access, type ConsoleAccounts } from './access.js'
import { chatScopeOf } from './accountsHttp.js'
import type {
  ChatSendInput,
  ChatSession,
  ChatTurn,
  ConsoleDeps,
  ConsoleResult,
} from './deps.js'
import type { UsageScope } from './governance.js'
import { reserveUsage, usageDenial, usageScopeOf } from './quota.js'
import { fail } from './respond.js'
import { failureResponse, guardChat } from './routes/shared.js'
import { tenantScope } from './tenancy.js'

interface ChatDispatchContext {
  readonly deps: Pick<ConsoleDeps, 'chat' | 'usage' | 'tenancy'>
  readonly accounts: ConsoleAccounts | undefined
  readonly access: Access
  readonly now: number
  readonly requestId: string
}

/** Shared ownership and quota boundary for HTTP and creator-owned schedules. */
export class ChatDispatch {
  readonly #ctx: ChatDispatchContext

  constructor(ctx: ChatDispatchContext) {
    this.#ctx = ctx
  }

  /** A schedule has a subject, never a stored credential or a frozen role. */
  static forSubject(
    subject: string,
    input: Omit<ChatDispatchContext, 'access'>,
  ): ChatDispatch | Response {
    let principal: Access['principal']
    if (subject === 'legacy:admin') {
      principal = { kind: 'legacy', subject, credential: 'bearer' }
    } else {
      const listed = input.accounts?.book.list()
      if (listed && !listed.ok)
        return fail(503, 'unavailable', listed.refusal.message)
      const account = listed?.ok
        ? listed.value.accounts.find(
            row => row.subject === subject && row.state === 'active',
          )
        : undefined
      if (!account) return fail(403, 'forbidden', '账号权限已变化，请重新登录')
      principal = {
        kind: 'user',
        subject: account.subject,
        role: account.role,
        credential: 'bearer',
        authenticatedAt: input.now,
      }
    }
    return new ChatDispatch({
      ...input,
      access: {
        principal,
        sid: null,
        refusal: null,
        breakGlass:
          principal.kind === 'legacy' && input.accounts?.breakGlass === true,
        credential: {
          role:
            principal.kind === 'legacy' || principal.role === 'ops'
              ? 'admin'
              : 'view',
          source: 'bearer',
          header: true,
          crossOrigin: false,
        },
      },
    })
  }

  authorize(target?: string): Response | null {
    const { access, accounts, deps } = this.#ctx
    const denied = guardChat(access, 'guarded')
    if (denied) return denied
    if (access.current?.() === false)
      return fail(403, 'forbidden', '账号权限已变化，请重新登录')
    if (access.principal?.kind === 'user') {
      const listed = accounts?.book.list()
      if (listed && !listed.ok)
        return fail(503, 'unavailable', listed.refusal.message)
      if (
        !listed?.ok ||
        !listed.value.accounts.some(
          row =>
            row.subject === access.principal?.subject &&
            row.state === 'active' &&
            row.role ===
              (access.principal?.kind === 'user'
                ? access.principal.role
                : null),
        )
      )
        return fail(403, 'forbidden', '账号权限已变化，请重新登录')
    }
    if (target !== undefined && deps.tenancy !== undefined) {
      try {
        const scope = tenantScope(
          deps.tenancy.read(),
          access.principal,
          access.breakGlass,
        )
        if (!scope.platform && !scope.address(target))
          return fail(404, 'not_found', '资源不存在')
      } catch {
        return fail(503, 'unavailable', '租户配置不可用，访问已暂停')
      }
    }
    return null
  }

  /** Schedules preflight before reading/reusing their dedicated session. HTTP
   * retains its existing lazy endpoint check in ChatPort.send (including errors).
   * The port still rechecks the authoritative endpoint before sending bytes. */
  async authorizeTarget(target: string): Promise<Response | null> {
    const denied = this.authorize(target)
    if (denied) return denied
    const targets = await this.#ctx.deps.chat!.targets()
    const changed = this.authorize(target)
    if (changed) return changed
    if (!targets.ok) return failureResponse(targets.failure)
    return targets.value.some(row => row.address === target && row.dialable)
      ? null
      : fail(403, 'forbidden', '目标已不在对话可拨允许名单内')
  }

  /** A schedule must reject exhausted quota before reading any chat port. */
  preflightUsage(target: string, sessionId: string | null): Response | null {
    const denied = this.authorize(target)
    if (denied) return denied
    const result = this.#ctx.deps.usage?.check?.(this.#usageScope(), {
      operation: 'message',
      ...(sessionId === null
        ? { newSession: true, sessionId: `pending:${this.#ctx.requestId}` }
        : { sessionId }),
    })
    return result ? usageDenial(result, this.#ctx.now) : null
  }

  #usageScope(): UsageScope {
    const { deps, access } = this.#ctx
    const scope = usageScopeOf(this.#ctx)
    if (deps.tenancy === undefined) return scope
    const current = tenantScope(
      deps.tenancy.read(),
      access.principal,
      access.breakGlass,
    )
    const tenant = current.platform ? null : current.tenant
    return { ...scope, ...(tenant === null ? {} : { tenant }) }
  }

  #recordOwner(sessionId: string): Response | null {
    const ctx = this.#ctx
    const opener = chatScopeOf(ctx.access, ctx.accounts).opener
    if (opener !== null && ctx.accounts !== undefined) {
      const owned = ctx.accounts.book.recordOwner(sessionId, opener)
      if (!owned.ok) return fail(503, 'unavailable', owned.refusal.message)
    }
    return null
  }

  /** Only for a dedicated session read from the trusted schedule book: migrate
   * ownerless P24 sessions, never overwrite another person's ownership. */
  claimSession(sessionId: string): Response | null {
    const denied = this.authorize()
    if (denied) return denied
    const ctx = this.#ctx
    const opener = chatScopeOf(ctx.access, ctx.accounts).opener
    if (opener === null || ctx.accounts === undefined) return null
    const owner = ctx.accounts.book.ownerOf(sessionId)
    if (owner === opener) return null
    if (owner !== null)
      return fail(404, 'not_found', '这条会话不在本控制台的记录里')
    return this.#recordOwner(sessionId)
  }

  async open(
    target: string,
    recorded?: (result: ConsoleResult<ChatSession>) => Promise<void>,
  ): Promise<ConsoleResult<ChatSession> | Response> {
    const denied = this.authorize(target)
    if (denied) return denied
    const ctx = this.#ctx
    const temporarySession = `pending:${ctx.requestId}`
    const usageScope = this.#usageScope()
    const reservation = reserveUsage(
      ctx,
      { sessionId: temporarySession, newSession: true, operation: 'session' },
      usageScope,
    )
    if (reservation instanceof Response) return reservation
    let result: ConsoleResult<ChatSession>
    try {
      result = await ctx.deps.chat!.open(target)
      if (typeof reservation === 'string' && result.ok)
        ctx.deps.usage?.adoptSession(reservation, result.value.id)
    } catch (error) {
      if (typeof reservation === 'string')
        ctx.deps.usage?.closeSession(usageScope, temporarySession)
      throw error
    } finally {
      if (typeof reservation === 'string') ctx.deps.usage?.finish(reservation)
    }
    if (!result.ok && typeof reservation === 'string')
      ctx.deps.usage?.closeSession(usageScope, temporarySession)
    // HTTP historically records the port outcome before writing the owner.
    await recorded?.(result)
    const ownership = result.ok ? this.#recordOwner(result.value.id) : null
    if (ownership) return ownership
    return result
  }

  async send(
    input: ChatSendInput,
    target?: string,
  ): Promise<ConsoleResult<ChatTurn> | Response> {
    const denied =
      target === undefined
        ? this.authorize()
        : await this.authorizeTarget(target)
    if (denied) return denied
    const ctx = this.#ctx
    if (!chatScopeOf(ctx.access, ctx.accounts).visible(input.sessionId))
      return fail(404, 'not_found', '这条会话不在本控制台的记录里')
    const reservation = reserveUsage(
      ctx,
      { sessionId: input.sessionId, operation: 'message' },
      this.#usageScope(),
    )
    if (reservation instanceof Response) return reservation
    let result: ConsoleResult<ChatTurn>
    try {
      result = await ctx.deps.chat!.send({
        ...input,
        ...(typeof reservation === 'string'
          ? { usageReservation: reservation }
          : {}),
      })
    } catch (error) {
      if (typeof reservation === 'string') ctx.deps.usage?.finish(reservation)
      throw error
    }
    if (
      !result.ok &&
      !result.failure.deliveryUnknown &&
      typeof reservation === 'string'
    )
      ctx.deps.usage?.finish(reservation)
    return result
  }
}
