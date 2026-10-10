// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** What an account may do. `tenancy-m1.md` §3.2 has the table. */
export type AccountRole = 'viewer' | 'member' | 'ops'

/** A person, as the console names them: `u:` and 16 lowercase hex digits. */
export type AccountSubject = `u:${string}`

/**
 * Who is asking (`tenancy-m1.md` §1.1). A discriminated union rather than a
 * string sentinel, so "is this a person" is a type check and not a prefix
 * test somebody forgets.
 *
 * `credential` says how the person got here: a browser session, a personal
 * credential presented as `Authorization: Bearer`, or — reserved for P14 — an
 * approval session. `authenticatedAt` is when that credential was last proven:
 * the login for a session, the request itself for a bearer. P14 reads both to
 * decide what may approve (`authorization-m1.md` §3.3).
 *
 * The legacy tokens are principals too, so that code downstream asks one
 * question; they are never people, never own a session and never approve.
 */
export type ConsolePrincipal =
  | {
      readonly kind: 'user'
      readonly subject: AccountSubject
      readonly role: AccountRole
      readonly authenticatedAt: number
      readonly credential: 'session' | 'approval-session' | 'bearer'
    }
  | {
      readonly kind: 'legacy'
      readonly subject: 'legacy:view' | 'legacy:admin'
      readonly credential: 'session' | 'bearer'
    }

/**
 * Uniform failure shape for every port. `code` is for tests, not for users.
 *
 * `unreachable` and `refused` are the pair worth being careful with, because
 * collapsing them is a bug that costs an operator an afternoon: `unreachable`
 * means the far side was never reached, and it points at tunnels, ports and
 * routes. With `deliveryUnknown`, only the receipt was unreachable: the task
 * may be running, so its quota stays reserved. `refused` means the far side
 * was reached, understood the request and declined
 * it, and it points at that node's policy and its audit trail. A node that
 * refuses a wake for want of a capability token is `refused` — reporting it as
 * `unreachable` sent people to check a network that was working (issue #29).
 *
 * `rejected` is the third of the family and it is about **this** side: a rule
 * here would not let the request leave.
 */
export interface ConsoleFailure {
  /** Bytes may have reached the peer; a failed receipt must not release quota. */
  readonly deliveryUnknown?: true
  readonly code:
    | 'unreachable'
    | 'refused'
    | 'rejected'
    | 'not_found'
    | 'unsupported'
    | 'invalid'
  readonly message: string
}

export type ConsoleResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ConsoleFailure }
