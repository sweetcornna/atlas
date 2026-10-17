// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DesktopApps, DesktopConfirm } from '../directionPorts.js'
import { fail, methodNotAllowed, notFound } from '../respond.js'
import {
  actorOf,
  agentRefOf,
  answer,
  bodyOf,
  guardOpsWrite,
  guardRead,
  segment,
  unwired,
} from './directionShared.js'
import type { HeadRoute } from './types.js'

/** What `PUT /v0/desktop/<node>/<agent>` may change. */
interface DesktopChange {
  readonly browser?: boolean
  readonly computer?: boolean
  readonly confirm?: DesktopConfirm
  readonly apps?: DesktopApps
  readonly terminal?: boolean
}

const CHANGE_KEYS = ['browser', 'computer', 'confirm', 'apps', 'terminal']
const CONFIRMS: readonly string[] = ['sensitive', 'always', 'autonomous']
/** A desktop entry id or a bundle id: visible ASCII, no spaces. */
const APP_ID = /^[\x21-\x7e]{1,200}$/
/** runtimes-channels.md §6.3: an id list holds at most 50. */
const DESKTOP_APPS_MAX = 50

/**
 * The body of a desktop change, or the line saying which field is wrong. The
 * line names the field, so the page can mark it (`qianmoConsole.fieldOf`).
 * A repeated app id counts once; the order the operator wrote is kept.
 */
function desktopChangeOf(
  body: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: DesktopChange }
  | { readonly ok: false; readonly message: string } {
  const keys = Object.keys(body)
  if (keys.length === 0 || keys.some(k => !CHANGE_KEYS.includes(k)))
    return { ok: false, message: '只认 browser computer confirm apps terminal' }
  for (const k of ['browser', 'computer', 'terminal'])
    if (body[k] !== undefined && typeof body[k] !== 'boolean')
      return { ok: false, message: `${k} 必须是布尔值` }
  if (
    body.confirm !== undefined &&
    (typeof body.confirm !== 'string' || !CONFIRMS.includes(body.confirm))
  )
    return { ok: false, message: 'confirm 只认 sensitive always autonomous' }
  const change: {
    browser?: boolean
    computer?: boolean
    confirm?: DesktopConfirm
    apps?: DesktopApps
    terminal?: boolean
  } = {}
  if (body.browser !== undefined) change.browser = body.browser as boolean
  if (body.computer !== undefined) change.computer = body.computer as boolean
  if (body.confirm !== undefined)
    change.confirm = body.confirm as DesktopConfirm
  if (body.terminal !== undefined) change.terminal = body.terminal as boolean
  const apps = body.apps
  if (apps === 'all' || apps === 'none') change.apps = apps
  else if (Array.isArray(apps)) {
    if (!apps.every(id => typeof id === 'string' && APP_ID.test(id)))
      return { ok: false, message: 'apps 里的编号须为 1–200 个可见字符' }
    const list = [...new Set(apps as string[])]
    if (list.length === 0)
      return { ok: false, message: 'apps 列表为空 · 不给应用用 none' }
    if (list.length > DESKTOP_APPS_MAX)
      return { ok: false, message: `apps 至多 ${DESKTOP_APPS_MAX} 个` }
    change.apps = list
  } else if (apps !== undefined)
    return { ok: false, message: 'apps 只认 all none 或编号列表' }
  return { ok: true, value: change }
}

/** API only. The port owns the action ledger, once per outbound operation. */
export const desktopApi: HeadRoute = {
  heads: ['desktop'],
  async handle(ctx, _head, rest) {
    const root = rest.length === 0
    const actions = rest.length === 1 && rest[0] === 'actions'
    const recycle = rest.length === 3 && rest[2] === 'recycle'
    const screen = rest.length === 3 && rest[2] === 'screen'
    if (!root && !actions && rest.length !== 2 && !recycle && !screen)
      return notFound(`unknown path: ${ctx.url.pathname}`)
    const read = root || actions || screen
    const denied = read ? guardRead(ctx) : guardOpsWrite(ctx)
    if (denied) return denied
    const methods = read ? ['GET'] : recycle ? ['POST'] : ['PUT']
    if (!methods.includes(ctx.request.method)) return methodNotAllowed(methods)
    const port = ctx.deps.desktop
    if (!port) return unwired('云端电脑')
    if (root) return answer(await port.list())
    if (actions) {
      const raw = ctx.url.searchParams.get('agent')
      const ref = raw === null ? null : agentRefOf(raw)
      const limitText = ctx.url.searchParams.get('limit') ?? '50'
      const limit = Number(limitText)
      if (
        (raw !== null && ref === null) ||
        !/^\d+$/.test(limitText) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 200
      )
        return fail(400, 'invalid', 'agent 或 limit 无效（1–200）')
      return answer(await port.actions(ref, limit))
    }
    const node = segment(rest[0]),
      agent = segment(rest[1])
    const ref = agentRefOf(`qianmo://${node}/${agent}`)
    if (!ref) return fail(400, 'invalid', '节点或智能体无效')
    if (screen) {
      // JSON rather than the image bytes: the console's CSP allows images
      // only as `data:` (respond.ts `cspFor`), so the page builds the data
      // URI from this answer instead of loading a same-origin image.
      if (port.view === undefined) return unwired('云端电脑画面')
      return answer(await port.view(ref))
    }
    let change: DesktopChange = {}
    if (!recycle) {
      const body = await bodyOf(ctx)
      if (body instanceof Response) return body
      const parsed = desktopChangeOf(body)
      if (!parsed.ok) return fail(400, 'invalid', parsed.message)
      change = parsed.value
    }
    const busy = await ctx.admit()
    if (busy) return busy
    return answer(
      recycle
        ? await port.recycle(ref, actorOf(ctx))
        : await port.set(ref, change, actorOf(ctx)),
    )
  },
}
