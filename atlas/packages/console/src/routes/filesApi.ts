// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FileScope } from '../directionPorts.js'
import { fail, methodNotAllowed, notFound } from '../respond.js'
import {
  actorOf,
  agentRefOf,
  answer,
  bodyOf,
  canMember,
  guardMemberWrite,
  guardRead,
  segment,
  unwired,
} from './directionShared.js'
import type { HeadRoute } from './types.js'

function validPath(value: unknown, root = false): value is string {
  if (root && (value === '' || value === '.')) return true
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 2048 &&
    !/[\\:]/.test(value) &&
    ![...value].some(
      char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) &&
    value
      .split('/')
      .every(
        part =>
          part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part),
      )
  )
}
/** API only; the files page owner attaches this HeadRoute. The port owns the ledger. */
export const filesApi: HeadRoute = {
  heads: ['files'],
  async handle(ctx, _head, rest) {
    const snapshot = rest.length === 0
    const browse = rest.length === 1 && rest[0] === 'browse'
    const create = rest.length === 1 && rest[0] === 'transfers'
    const decide =
      rest.length === 3 && rest[0] === 'requests' && rest[2] === 'decide'
    const revoke =
      rest.length === 3 && rest[0] === 'grants' && rest[2] === 'revoke'
    const retry =
      rest.length === 3 && rest[0] === 'transfers' && rest[2] === 'retry'
    const read = snapshot || browse
    const denied = snapshot
      ? guardRead(ctx)
      : browse
        ? canMember(ctx)
          ? null
          : guardMemberWrite(ctx)
        : guardMemberWrite(ctx)
    if (denied) return denied
    if (!(read || create || decide || revoke || retry))
      return notFound(`unknown path: ${ctx.url.pathname}`)
    if (ctx.request.method !== (read ? 'GET' : 'POST'))
      return methodNotAllowed([read ? 'GET' : 'POST'])
    const port = ctx.deps.files
    if (!port) return unwired('文件互通')
    if (snapshot) return answer(await port.snapshot())
    if (browse) {
      const ref = agentRefOf(ctx.url.searchParams.get('agent')),
        path = ctx.url.searchParams.get('path') ?? ''
      if (!ref || !validPath(path, true))
        return fail(400, 'invalid', '智能体地址或路径无效')
      return answer(await port.browse(ref, path))
    }
    const id = create ? null : segment(rest[1])
    if (!create && (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)))
      return fail(400, 'invalid', '标识无效')
    let input: Record<string, unknown> | null = null
    if (create || decide) {
      const body = await bodyOf(ctx)
      if (body instanceof Response) return body
      input = body
    }
    if (create) {
      const target = agentRefOf(input!['target']),
        sources = input!['sources']
      if (
        !target ||
        !Array.isArray(sources) ||
        sources.length === 0 ||
        sources.length > 100
      )
        return fail(400, 'invalid', '来源与目标无效')
      const refs = []
      for (const source of sources) {
        if (!source || typeof source !== 'object' || Array.isArray(source))
          return fail(400, 'invalid', '来源无效')
        const ref = agentRefOf(source.agent)
        if (!ref || !validPath(source.path))
          return fail(400, 'invalid', '来源地址或路径无效')
        refs.push({ ...ref, path: source.path })
      }
      const admitted = await ctx.admit()
      if (admitted) return admitted
      return answer(
        await port.transfer({ sources: refs, target }, actorOf(ctx)),
      )
    }
    if (decide) {
      const body = input!
      let scope: FileScope | undefined
      if (body['scope'] !== undefined) {
        const value = body['scope']
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          !('kind' in value) ||
          !('path' in value) ||
          (value.kind !== 'file' && value.kind !== 'dir') ||
          !validPath(value.path)
        )
          return fail(400, 'invalid', '授权范围无效')
        scope = { kind: value.kind, path: value.path }
      }
      if (
        typeof body['approve'] !== 'boolean' ||
        (body['ttlMs'] !== undefined &&
          (typeof body['ttlMs'] !== 'number' ||
            !Number.isSafeInteger(body['ttlMs']) ||
            body['ttlMs'] <= 0)) ||
        (body['note'] !== undefined &&
          (typeof body['note'] !== 'string' || body['note'].length > 2000))
      )
        return fail(400, 'invalid', '决定参数无效')
      const admitted = await ctx.admit()
      if (admitted) return admitted
      return answer(
        await port.decide(
          id!,
          {
            approve: body['approve'],
            ...(scope ? { scope } : {}),
            ...(typeof body['ttlMs'] === 'number'
              ? { ttlMs: body['ttlMs'] }
              : {}),
            ...(typeof body['note'] === 'string' ? { note: body['note'] } : {}),
          },
          actorOf(ctx),
        ),
      )
    }
    const admitted = await ctx.admit()
    if (admitted) return admitted
    return revoke
      ? answer(await port.revokeGrant(id!, actorOf(ctx)))
      : answer(await port.retry(id!, actorOf(ctx)))
  },
}
