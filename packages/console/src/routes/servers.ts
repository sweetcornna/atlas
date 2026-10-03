// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 服务器 — which machine each node runs on, and the operator's note on it.
 *
 * Owns the `/servers` page, `/v0/servers` and `/v0/servers/<id>/note`.
 *
 * ## A server id is chosen from the startup list, never supplied
 *
 * `PUT /v0/servers/<id>/note` looks the id up in `deps.nodeServers` before it
 * reads the body, and answers 403 when it is not there. This is the same rule
 * the wake route applies to a target and it is there for the same reason: the
 * set of things this console will act on is fixed when it starts, so a caller
 * holding the admin token cannot grow it by typing into the page. Without the
 * check, a note route would be an arbitrary key-value store that anyone with
 * that token could fill up.
 *
 * A console started without any `--node-server` answers 501 on both routes
 * rather than 200 with an empty list: "this console was not told where anything
 * runs" and "nothing runs anywhere" are different facts.
 */

import { SERVERS_PAGE_JS } from '../assets/pageScripts.js'
import type { ConsoleCredential } from '../auth.js'
import type { ConsoleDeps, NodeServer } from '../deps.js'
import {
  fail,
  json,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from '../respond.js'
import {
  MAX_SERVER_NOTE_LENGTH,
  renderServers,
  serverCards,
} from '../view/servers.js'
import { escapeHtml } from '../view/escape.js'
import {
  failureOf,
  failureResponse,
  guard,
  underPath,
  type Parsed,
} from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

/** The machines this console was started with. Empty means the face is off. */
function nodeServersOf(deps: ConsoleDeps): readonly NodeServer[] {
  return deps.nodeServers ?? []
}

const SERVERS_UNSUPPORTED =
  '该控制台没有配置服务器归属（启动时缺少 --node-server），因此没有可看的服务器；' +
  '请在启动 occ console 时用 --node-server <node>=<server> 指定后重试。'

/** An empty string is a legitimate value: it is how an operator clears a note. */
function parseServerNote(body: Record<string, unknown>): Parsed<string> {
  const value = body['note']
  if (typeof value !== 'string') {
    return { ok: false, message: '字段 note 必须是字符串' }
  }
  if (value.length > MAX_SERVER_NOTE_LENGTH) {
    return {
      ok: false,
      message: `备注最多 ${MAX_SERVER_NOTE_LENGTH} 个字符`,
    }
  }
  return { ok: true, value }
}

/**
 * The servers section, or nothing at all.
 *
 * `undefined` — not an empty string — when this console was started without a
 * mapping: the page then leaves the whole section out rather than rendering a
 * header over an explanation nobody asked for. Degradation here is "the feature
 * is not on this console", which is a different thing from "the feature failed".
 *
 * A note read that fails does **not** take the section with it: the machines
 * come from the startup flags and are still true, so the strip goes above them.
 */
export async function serversFragment(
  deps: ConsoleDeps,
  credential: ConsoleCredential,
  now: number,
): Promise<string | undefined> {
  const nodeServers = nodeServersOf(deps)
  if (nodeServers.length === 0) return undefined
  const notes = await deps.serverNotes?.list()
  return renderServers({
    cards: serverCards(nodeServers, notes?.ok === true ? notes.value : []),
    failure: notes === undefined ? null : failureOf(notes),
    // Both halves matter: a view token may read a note but not write one, and
    // a console with no store may not write one whoever is holding it.
    editable: credential.role === 'admin' && deps.serverNotes !== undefined,
    notesEnabled: deps.serverNotes !== undefined,
    now,
  })
}

async function handleServers(ctx: RouteContext): Promise<Response> {
  const denied = guard(ctx.access.credential, 'view', 'guarded')
  if (denied !== null) return denied
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const nodeServers = nodeServersOf(ctx.deps)
  if (nodeServers.length === 0) {
    return fail(501, 'unsupported', SERVERS_UNSUPPORTED)
  }
  const notes = await ctx.deps.serverNotes?.list()
  if (notes !== undefined && !notes.ok) return failureResponse(notes.failure)
  return json({ servers: serverCards(nodeServers, notes?.value ?? []) })
}

/**
 * Write one machine's note.
 *
 * The allowlist check runs **before the body is read**, so an unknown id costs
 * a lookup rather than however many bytes the caller decided to send.
 */
async function handleServerNote(
  ctx: RouteContext,
  server: string,
): Promise<Response> {
  const denied = guard(ctx.access.credential, 'admin', 'guarded')
  if (denied !== null) return denied
  if (ctx.request.method !== 'PUT') return methodNotAllowed(['PUT'])
  const nodeServers = nodeServersOf(ctx.deps)
  if (nodeServers.length === 0) {
    return fail(501, 'unsupported', SERVERS_UNSUPPORTED)
  }
  if (!nodeServers.some(entry => entry.server === server)) {
    return fail(403, 'rejected', '该服务器不在启动时配置的白名单中')
  }
  const notes = ctx.deps.serverNotes
  if (notes === undefined) {
    return fail(
      501,
      'unsupported',
      '该控制台没有配置备注存储，因此不能保存备注。',
    )
  }
  const body = await readJsonObject(ctx.request)
  if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
  const note = parseServerNote(body)
  if (!note.ok) return fail(400, 'invalid', note.message)
  const result = await notes.set(server, note.value)
  return result.ok ? json(result.value) : failureResponse(result.failure)
}

/**
 * What the page says when the console was not told where anything runs: the
 * same fact the 501 states, in one line, with the flag that changes it.
 */
const SERVERS_ABSENT_LINE = '未配置服务器归属 · 启动时用 --node-server 指定'

export const serversRoute: RouteModule = {
  area: {
    id: 'servers',
    label: '服务器',
    group: 'config',
    href: '/servers',
    icon: 'hard-drive',
  },
  page: {
    match: underPath('servers'),
    guard: 'view',
    async render(ctx) {
      // Never polled: the cards hold a textarea somebody may be typing in.
      const cards = await serversFragment(
        ctx.deps,
        ctx.access.credential,
        ctx.now,
      )
      return {
        title: '服务器',
        body:
          cards === undefined
            ? `<p class="hint">${escapeHtml(SERVERS_ABSENT_LINE)}</p>`
            : `<section class="sec" id="servers-section">` +
              `<div id="servers">${cards}</div></section>`,
      }
    },
    script: SERVERS_PAGE_JS,
  },
  api: {
    heads: ['servers'],
    async handle(ctx, _head, rest) {
      if (rest.length === 0) return await handleServers(ctx)
      // The id rides in one percent-encoded segment, the same convention an
      // address uses. The charset the host enforces stops short of `/`, but it
      // allows `:` — an IPv6 literal is a legitimate machine name — so the
      // segment still has to be decoded rather than read raw.
      if (rest.length === 2 && rest[1] === 'note') {
        return await handleServerNote(ctx, decodeURIComponent(rest[0] ?? ''))
      }
      return notFound(`unknown path: ${ctx.url.pathname}`)
    },
  },
}
