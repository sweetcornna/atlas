// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type Access, subjectOf } from '../access.js'
import type { HandoffDeviceView } from '../directionPorts.js'
import { fail, json, methodNotAllowed, notFound } from '../respond.js'
import { failureResponse, guard, outcomeOf, safeDecode } from './shared.js'
import type { RouteContext } from './types.js'

export function handoffMember(ctx: RouteContext): Response | null {
  const principal = ctx.access.principal
  if (principal?.kind === 'device')
    return guard(ctx.access.credential, 'view', 'guarded')
  if (principal?.kind !== 'user')
    return guard(ctx.access.credential, 'admin', 'guarded')
  return principal.role === 'viewer'
    ? fail(403, 'forbidden', '需要成员或运维账号')
    : guard(ctx.access.credential, 'view', 'guarded')
}

export async function handoffBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get('content-length')) > 64 * 1024) return null
  try {
    const text = await request.text()
    if (new TextEncoder().encode(text).length > 64 * 1024) return null
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Public pairing door: the code itself is its credential. */
export async function pairHandoffDevice(
  request: Request,
  port: RouteContext['deps']['handoffDevices'],
  remoteAddr: string,
): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  if (port?.pair === undefined)
    return fail(501, 'unsupported', '设备配对未接入')
  const body = await handoffBody(request)
  // Malformed guesses still consume the same source-address budget.
  const result = await port.pair(
    {
      code: typeof body?.code === 'string' ? body.code : '',
      name: typeof body?.name === 'string' ? body.name : '',
      platform: typeof body?.platform === 'string' ? body.platform : null,
      // `qmo sign-in` says so; `qm handoff login` never did.
      kind: body?.kind === 'client' ? 'client' : 'handoff',
    },
    remoteAddr,
  )
  if (result.retryAfter !== undefined) {
    const response = fail(429, 'limit', '配对过于频繁')
    response.headers.set('retry-after', String(result.retryAfter))
    return response
  }
  return result.ok
    ? json({
        deviceId: result.value.deviceId,
        name: result.value.name,
        token: result.value.token,
        console: result.value.console,
      })
    : failureResponse(result.failure)
}

/**
 * The devices `access` may see: ops and the legacy tokens see every device,
 * anyone else only the devices they own (a device: its owner's).
 */
export function visibleDevices(
  devices: readonly HandoffDeviceView[],
  access: Access,
): readonly HandoffDeviceView[] {
  const principal = access.principal
  if (principal === null || principal.kind === 'legacy') return devices
  if (principal.kind === 'user' && principal.role === 'ops') return devices
  const owner = principal.kind === 'device' ? principal.owner : principal.subject
  return devices.filter(device => device.owner === owner)
}

export async function handoffDevicesApi(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const denied = guard(ctx.access.credential, 'view', 'guarded')
  if (denied) return denied
  const port = ctx.deps.handoffDevices
  if (rest.length === 0) {
    if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
    if (!port) return fail(501, 'unsupported', '设备配对未接入')
    const result = await port.listDevices()
    return result.ok
      ? json({ devices: visibleDevices(result.value, ctx.access) })
      : failureResponse(result.failure)
  }
  if (ctx.access.principal?.kind === 'device')
    return fail(403, 'forbidden', '设备不能管理配对与吊销')
  if (rest.length !== 1) return notFound(`unknown path: ${ctx.url.pathname}`)
  const refused = handoffMember(ctx)
  if (refused) return refused
  const pairing = rest[0] === 'pairing'
  if (ctx.request.method !== (pairing ? 'POST' : 'DELETE'))
    return methodNotAllowed([pairing ? 'POST' : 'DELETE'])
  if (!port) return fail(501, 'unsupported', '设备配对未接入')
  const blocked = await ctx.admit()
  if (blocked) return blocked
  const principal = ctx.access.principal
  const actor = {
    subject: subjectOf(ctx.access),
    role: principal?.kind === 'user' ? principal.role : null,
    requestId: ctx.requestId,
  }
  const id = safeDecode(rest[0]!)
  if (id === null) return fail(400, 'invalid', '设备号不合法')
  const result = pairing
    ? await port.issuePairing(
        actor,
        ctx.request.headers.get('origin') ?? ctx.url.origin,
      )
    : await port.revokeDevice(id, actor)
  await ctx.record(
    pairing ? 'handoff.device.pair' : 'handoff.device.revoke',
    pairing ? actor.subject : id,
    ...outcomeOf(result),
  )
  if (!result.ok) return failureResponse(result.failure)
  return json(pairing ? { pairing: result.value } : { device: result.value })
}
