// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/v0/avatars` and `/fragments/avatar` — 形象 (`../avatar.ts`).
 *
 * | Route | Who |
 * |---|---|
 * | `GET /v0/avatars?key=…` (repeatable) | view and up |
 * | `PUT /v0/avatars/<key>` | member and up; a `user:` key only its own person, or ops |
 * | `DELETE /v0/avatars/<key>` (back to the default) | same |
 * | `GET /fragments/avatar?key=…&spec=…&default=1` | view and up |
 *
 * A figure is seven choices from closed lists, checked by {@link parseAvatar}
 * before the port sees it. The fragment is the editor's body, drawn by the
 * server for whatever figure the page asks about, so the page never builds a
 * figure itself.
 *
 * {@link facesFor} is how a page that shows figures looks them up: one read
 * of the port for every key it will draw, with the default for anything
 * unsaved — or for everything, when this console has no avatar store.
 */

import {
  type AvatarKey,
  type AvatarRecord,
  type AvatarSpec,
  avatarFor,
  parseAvatar,
  parseAvatarKey,
  userAvatarKey,
} from '../avatar.js'
import { chatScopeOf } from '../accountsHttp.js'
import { fail, html, json, methodNotAllowed, notFound } from '../respond.js'
import { renderAvatarEditor } from '../view/avatar.js'
import {
  actorOf,
  answer,
  bodyOf,
  canMember,
  canOps,
  guardMemberWrite,
  guardRead,
  segment,
  unwired,
  write,
} from './directionShared.js'
import type { HeadRoute, RouteContext } from './types.js'

/** The figures one render draws, already looked up. */
export interface Faces {
  /** This reader's own key. */
  readonly self: AvatarKey
  /** Whether this reader may change figures on this console. */
  readonly editable: boolean
  spec(key: AvatarKey): AvatarSpec
}

/** One read for every figure a render needs; a failed read draws defaults. */
export async function facesFor(
  ctx: RouteContext,
  keys: readonly AvatarKey[],
): Promise<Faces> {
  const self = userAvatarKey(actorOf(ctx).subject)
  const port = ctx.deps.avatars
  let saved: ReadonlyMap<AvatarKey, AvatarRecord> | undefined
  if (port !== undefined) {
    const read = await port.read([...new Set([self, ...keys])])
    if (read.ok) saved = read.value
  }
  return {
    self,
    editable: port !== undefined && canMember(ctx),
    spec: key => avatarFor(key, saved),
  }
}

/** Who a key names, in the words the editor shows above the figure. */
function avatarOwnerName(key: AvatarKey, self: AvatarKey): string {
  if (key === self) return '我'
  if (key.startsWith('user:')) return key.slice('user:'.length)
  const address = key.slice('agent:'.length)
  return address.slice(address.lastIndexOf('/') + 1) || address
}

/** A person changes their own figure; ops may change anybody's. */
async function writeDenial(
  ctx: RouteContext,
  key: AvatarKey,
): Promise<Response | null> {
  if (key.startsWith('user:'))
    return key === userAvatarKey(actorOf(ctx).subject) || canOps(ctx)
      ? null
      : fail(403, 'forbidden', '只能修改自己的形象')
  const address = key.slice('agent:'.length)
  const roster = await ctx.roster()
  if (!roster.ok || !roster.value.some(row => row.address === address))
    return fail(404, 'not_found', '资源不存在')
  const chat = ctx.deps.chat
  if (!chat) return fail(404, 'not_found', '资源不存在')
  const targets = await chat.targets()
  if (!targets.ok || !targets.value.some(row => row.address === address))
    return fail(404, 'not_found', '资源不存在')
  // Roster targets are available to start a conversation (the greet picker).
  // Existing sessions remain subject-scoped; never authorize via a foreign one.
  const scope = chatScopeOf(ctx.access, ctx.accounts)
  if (ctx.access.principal?.kind === 'user' && !canOps(ctx)) {
    const sessions = await chat.sessions()
    if (!sessions.ok) return answer(sessions)
    const matching = sessions.value.filter(row => row.target === address)
    if (matching.length && !matching.some(row => scope.visible(row.id)))
      return fail(404, 'not_found', '资源不存在')
  }
  return null
}

async function avatarsApi(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  const port = ctx.deps.avatars
  const method = ctx.request.method
  if (rest.length === 0) {
    if (method !== 'GET') return methodNotAllowed(['GET'])
    const denied = guardRead(ctx)
    if (denied !== null) return denied
    if (port === undefined && ctx.deps.tenancy !== undefined)
      return unwired('形象存储')
    const keys: AvatarKey[] = []
    for (const raw of ctx.url.searchParams.getAll('key').slice(0, 200)) {
      const key = parseAvatarKey(raw)
      if (key === null) return fail(400, 'invalid', `不认识的形象键 ${raw}`)
      keys.push(key)
    }
    const faces = await facesFor(ctx, keys)
    const saved = new Map<AvatarKey, AvatarRecord>()
    if (port !== undefined && keys.length > 0) {
      const read = await port.read(keys)
      if (!read.ok) return answer(read)
      for (const [key, record] of read.value) saved.set(key, record)
    }
    return json({
      editable: faces.editable,
      avatars: Object.fromEntries(
        keys.map(key => [
          key,
          {
            spec: faces.spec(key),
            saved: saved.has(key),
            updatedAt: saved.get(key)?.updatedAt ?? null,
          },
        ]),
      ),
    })
  }
  const raw = segment(rest[0])
  if (raw === null || rest.length > 1) {
    return notFound(`unknown path: ${ctx.url.pathname}`)
  }
  if (method !== 'PUT' && method !== 'DELETE') {
    return methodNotAllowed(['PUT', 'DELETE'])
  }
  const key = parseAvatarKey(raw)
  if (key === null) return fail(400, 'invalid', `不认识的形象键 ${raw}`)
  const denied = guardMemberWrite(ctx)
  if (denied !== null) return denied
  if (port === undefined) return unwired('形象存储')
  const scopeDenied = await writeDenial(ctx, key)
  if (scopeDenied !== null) return scopeDenied
  if (method === 'DELETE') {
    return await write(ctx, 'avatar.save', key, () =>
      port.save(key, null, actorOf(ctx)),
    )
  }
  const body = await bodyOf(ctx)
  if (body instanceof Response) return body
  const spec = parseAvatar(body)
  if (spec === null) return fail(400, 'invalid', '形象里有不认识的选项')
  return await write(ctx, 'avatar.save', key, () =>
    port.save(key, spec, actorOf(ctx)),
  )
}

/** The editor's body for one figure: `?key=` whose, `?spec=` the draft. */
async function avatarFragment(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  if (rest.length !== 0) return notFound(`unknown path: ${ctx.url.pathname}`)
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const denied = guardRead(ctx)
  if (denied !== null) return denied
  const raw = ctx.url.searchParams.get('key') ?? ''
  const key = parseAvatarKey(raw)
  if (key === null) return fail(400, 'invalid', `不认识的形象键 ${raw}`)
  const faces = await facesFor(ctx, [key])
  // `?default=1`: the figure this key would wear with nothing saved.
  let spec =
    ctx.url.searchParams.get('default') === '1'
      ? avatarFor(key, undefined)
      : faces.spec(key)
  const draft = ctx.url.searchParams.get('spec')
  if (draft !== null && draft.length <= 1000) {
    try {
      spec = parseAvatar(JSON.parse(draft)) ?? spec
    } catch {
      // A draft that is not JSON is no draft: the saved figure stands.
    }
  }
  return html(renderAvatarEditor(spec, avatarOwnerName(key, faces.self)))
}

export const avatarsApiRoute: HeadRoute = {
  heads: ['avatars'],
  handle: (ctx, _head, rest) => avatarsApi(ctx, rest),
}

export const avatarFragmentRoute: HeadRoute = {
  heads: ['avatar'],
  handle: (ctx, _head, rest) => avatarFragment(ctx, rest),
}
