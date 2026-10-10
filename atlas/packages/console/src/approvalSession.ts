// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomBytes } from 'node:crypto'
import type { AccountBook, ConsolePrincipal } from './accounts.js'
import { cookieOf } from './auth.js'
import { RegistrationThrottle } from './signup.js'

export const APPROVAL_COOKIE = 'qianmo_approval'
const APPROVAL_SESSION_MS = 30 * 60_000
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
interface Grant {
  readonly subject: string
  readonly authenticatedAt: number
}

class ApprovalSessions {
  readonly #grants = new Map<string, Grant>()
  readonly #throttle = new RegistrationThrottle()
  constructor(readonly book: AccountBook) {
    book.onAccountEnded(event => {
      for (const [key, grant] of this.#grants)
        if (grant.subject === event.subject) this.#grants.delete(key)
    })
  }
  issue(
    current: ConsolePrincipal | null,
    credential: string,
    now: number,
  ): string | null {
    if (current?.kind !== 'user' || current.role === 'viewer') return null
    if (this.#throttle.take(current.subject, now, 20) > 0) return null
    const checked = this.book.bearerPrincipal(credential)
    if (
      !checked.ok ||
      checked.value.kind !== 'user' ||
      checked.value.subject !== current.subject
    )
      return null
    for (const [key, grant] of this.#grants)
      if (
        now - grant.authenticatedAt >= APPROVAL_SESSION_MS ||
        grant.subject === current.subject
      )
        this.#grants.delete(key)
    const secret = randomBytes(32).toString('base64url')
    this.#grants.set(hash(secret), {
      subject: current.subject,
      authenticatedAt: now,
    })
    return secret
  }
  principal(
    request: Request,
    current: ConsolePrincipal | null,
    now: number,
  ): ConsolePrincipal | null {
    if (current?.kind !== 'user') return null
    if (current.credential === 'bearer') return current
    const cookie = cookieOf(request, APPROVAL_COOKIE)
    const grant = this.#grants.get(hash(cookie))
    if (
      grant === undefined ||
      grant.subject !== current.subject ||
      now < grant.authenticatedAt ||
      now - grant.authenticatedAt >= APPROVAL_SESSION_MS
    )
      return null
    const accounts = this.book.list()
    if (
      !accounts.ok ||
      !accounts.value.accounts.some(
        v => v.subject === grant.subject && v.state === 'active',
      )
    )
      return null
    return {
      ...current,
      credential: 'approval-session',
      authenticatedAt: grant.authenticatedAt,
    }
  }
}
const stores = new WeakMap<AccountBook, ApprovalSessions>()
export function approvalSessions(book: AccountBook): ApprovalSessions {
  let store = stores.get(book)
  if (store === undefined) {
    store = new ApprovalSessions(book)
    stores.set(book, store)
  }
  return store
}
export function approvalCookie(_request: Request, secret: string): string {
  return `${APPROVAL_COOKIE}=${secret}; Path=/v0/approvals; Max-Age=1800; HttpOnly; SameSite=Strict; Secure`
}
