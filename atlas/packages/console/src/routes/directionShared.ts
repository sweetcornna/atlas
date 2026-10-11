// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the 2026-10 areas share on the route side (`directionPorts.ts`).
 *
 * Two write levels, decided once here so five areas cannot disagree:
 *
 * - **member** — things a person does for their own work: pair a device,
 *   approve a file request, edit their agent's memory, schedule a briefing.
 *   The same rule as the chat face ({@link guardChat}): a personal `member` or
 *   `ops` account, or the legacy admin token; a `viewer` is refused.
 * - **ops** — things that change what a node is allowed to do or hold a
 *   credential: open a cloud desktop, route models, connect a mailbox, add a
 *   push channel. The admin token or a personal `ops` account
 *   ({@link canWrite}).
 *
 * A page draws a write control only when the caller passes the matching
 * test, and marks it `data-write` (`test/roles.test.ts`).
 */

import type { ConsoleResult } from '../contracts.js'
import type { DirectionActor } from '../directionPorts.js'
import { fail, json, readJsonObject } from '../respond.js'
import { canWrite, failureResponse, guard, guardChat } from './shared.js'
import type { ConsoleActionName, RouteContext } from './types.js'

/** Who is doing this, as a port records it. */
export function actorOf(ctx: RouteContext): DirectionActor {
  const principal = ctx.access.principal
  if (principal?.kind === 'user') {
    return {
      subject: principal.subject,
      role: principal.role,
      requestId: ctx.requestId,
    }
  }
  return {
    subject:
      principal?.subject ??
      (ctx.access.credential.role === 'admin' ? 'legacy:admin' : 'legacy:view'),
    role: null,
    requestId: ctx.requestId,
  }
}

/** May this caller use member-level write controls (see the module note)? */
export function canMember(ctx: RouteContext): boolean {
  return guardChat(ctx.access, 'document') === null
}

/** May this caller use ops-level write controls? */
export function canOps(ctx: RouteContext): boolean {
  return canWrite(ctx.access)
}

/** The member guard for a JSON write. `null` to proceed. */
export function guardMemberWrite(ctx: RouteContext): Response | null {
  return guardChat(ctx.access, 'guarded')
}

/** The ops guard for a JSON write. `null` to proceed. */
export function guardOpsWrite(ctx: RouteContext): Response | null {
  return guard(ctx.access.credential, 'admin', 'guarded')
}

/** The view guard for a JSON read. `null` to proceed. */
export function guardRead(ctx: RouteContext): Response | null {
  return guard(ctx.access.credential, 'view', 'guarded')
}

/** The answer when an area's port was not wired into this console. */
export function unwired(what: string): Response {
  return fail(501, 'unsupported', `该控制台没有接入${what}`)
}

/** A JSON object body, or the 400 that says it is not one. */
export async function bodyOf(
  ctx: RouteContext,
): Promise<Record<string, unknown> | Response> {
  const body = await readJsonObject(ctx.request)
  return body ?? fail(400, 'invalid', '请求体必须是 JSON 对象')
}

/** A port result as the JSON answer: the value, or the failure's status. */
export function answer<T>(result: ConsoleResult<T>, status = 200): Response {
  return result.ok
    ? json(result.value, status)
    : failureResponse(result.failure)
}

/**
 * Run one write: ask the ledger first, call the port, write the line, answer.
 *
 * The ports record their own audit; this line is the console's action
 * ledger, which the ports do not touch, so a write is in the ledger exactly
 * once whichever port served it.
 */
export async function write<T>(
  ctx: RouteContext,
  action: ConsoleActionName,
  target: string,
  run: () => Promise<ConsoleResult<T>>,
  status = 200,
): Promise<Response> {
  const busy = await ctx.admit()
  if (busy !== null) return busy
  const result = await run()
  await ctx.record(
    action,
    target,
    result.ok ? 'ok' : 'failed',
    result.ok ? undefined : result.failure.code,
  )
  return answer(result, status)
}

/** A string field, trimmed; `undefined` when absent or not a string. */
export function stringField(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key]
  return typeof value === 'string' ? value.trim() : undefined
}

/** One decoded path segment, or `null` for malformed percent-encoding. */
export function segment(value: string | undefined): string | null {
  if (value === undefined || value === '') return null
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** `qianmo://<node>/<agent>` split, or null. Same grammar as the registry. */
export function agentRefOf(
  value: unknown,
): { readonly node: string; readonly agent: string } | null {
  if (typeof value !== 'string') return null
  const match =
    /^qianmo:\/\/([a-z0-9][a-z0-9_-]{0,63})\/([a-z0-9][a-z0-9_-]{0,63})$/.exec(
      value,
    )
  if (match === null) return null
  return { node: match[1] ?? '', agent: match[2] ?? '' }
}
