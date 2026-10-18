// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/v0/im` (P28).
 *
 * | Route | Who |
 * |---|---|
 * | `GET /v0/im` | view and up (bot ids and allow lists only for ops) |
 * | `POST /v0/im`, `DELETE /v0/im/<id>` | ops personal account |
 * | `POST /v0/im/login`, `GET /v0/im/login/<id>` | ops personal account |
 * | `POST /v0/im/<id>/pairing` `{requestId, decision}` | ops personal account |
 */

import type {
  ChannelDraft,
  ChannelPairingDecision,
  ChannelsSnapshot,
} from '../directionPorts.js'
import { fail, methodNotAllowed, notFound } from '../respond.js'
import {
  actorOf,
  answer,
  bodyOf,
  canOps,
  guardOpsWrite,
  guardRead,
  segment,
  unwired,
  write,
} from './directionShared.js'
import type { HeadRoute, RouteContext } from './types.js'

/** Bot credentials follow providerWriter: personal ops, outside break-glass. */
function writer(ctx: RouteContext): boolean {
  return (
    ctx.access.principal?.kind === 'user' &&
    ctx.access.principal.role === 'ops' &&
    !ctx.access.breakGlass
  )
}

/** Only generated channel ids may enter the action ledger, never request text. */
function auditTarget(raw: string): string {
  return /^ch-[0-9a-f-]{36}$/.test(raw) ? raw : '-'
}

const DECISIONS: readonly ChannelPairingDecision[] = ['owner', 'member', 'deny']

/** What a reader below ops level may see: no platform user ids. */
export function channelsForReader(
  snapshot: ChannelsSnapshot,
  ops: boolean,
): ChannelsSnapshot {
  if (ops) return snapshot
  return {
    ...snapshot,
    channels: snapshot.channels.map(channel => ({
      ...channel,
      ownerIds: [],
      allowUsers: [],
      allowGroups: [],
      pairingRequests: [],
      settings: {},
    })),
  }
}

export const channelsApi: HeadRoute = {
  heads: ['im'],
  async handle(ctx, _head, rest) {
    const login = rest[0] === 'login'
    const pairing = !login && rest.length === 2 && rest[1] === 'pairing'
    const allowed =
      rest.length === 0
        ? ['GET', 'POST']
        : login && rest.length === 1
          ? ['POST']
          : login && rest.length === 2
            ? ['GET']
            : pairing
              ? ['POST']
              : rest.length === 1
                ? ['DELETE']
                : null
    if (!allowed) return notFound(`unknown path: ${ctx.url.pathname}`)
    const read = ctx.request.method === 'GET' && rest.length === 0
    const denied = read ? guardRead(ctx) : guardOpsWrite(ctx)
    if (denied) return denied
    if (!read && !writer(ctx))
      return fail(
        403,
        'forbidden',
        '聊天渠道需要运维个人账号；共用令牌与 break-glass 只能查看',
      )
    if (!allowed.includes(ctx.request.method)) return methodNotAllowed(allowed)
    const port = ctx.deps.channels
    if (!port) return unwired('聊天渠道')
    if (read) {
      const snapshot = await port.snapshot()
      return answer(
        snapshot.ok
          ? { ok: true, value: channelsForReader(snapshot.value, canOps(ctx)) }
          : snapshot,
      )
    }
    if (login) {
      if (rest.length === 2) {
        const id = segment(rest[1])
        if (id === null) return fail(400, 'invalid', '登录标识无效')
        return answer(await port.loginStatus(id, actorOf(ctx)))
      }
      const body = await bodyOf(ctx)
      if (body instanceof Response) return body
      return write(
        ctx,
        'im.login',
        typeof body['id'] === 'string' ? auditTarget(body['id']) : 'new',
        () => port.login(body as unknown as ChannelDraft, actorOf(ctx)),
      )
    }
    if (rest.length === 0) {
      const body = await bodyOf(ctx)
      if (body instanceof Response) return body
      return write(
        ctx,
        'im.save',
        typeof body['id'] === 'string' ? auditTarget(body['id']) : 'new',
        () => port.save(body as unknown as ChannelDraft, actorOf(ctx)),
      )
    }
    const id = segment(rest[0])
    if (id === null) return fail(400, 'invalid', '渠道标识无效')
    if (pairing) {
      const body = await bodyOf(ctx)
      if (body instanceof Response) return body
      const requestId =
        typeof body['requestId'] === 'string' &&
        /^[A-Za-z0-9-]{1,64}$/.test(body['requestId'])
          ? body['requestId']
          : null
      const decision = DECISIONS.find(one => one === body['decision'])
      if (requestId === null || decision === undefined)
        return fail(400, 'invalid', '配对请求或处理方式无效')
      return write(ctx, 'im.pair', auditTarget(id), () =>
        port.pair(id, requestId, decision, actorOf(ctx)),
      )
    }
    const response = await write(ctx, 'im.remove', auditTarget(id), () =>
      port.remove(id, actorOf(ctx)),
    )
    return response.ok ? new Response(null, { status: 204 }) : response
  },
}
