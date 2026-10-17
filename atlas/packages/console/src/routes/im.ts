// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 渠道 (P28): chat apps bound to agents.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /admin/im`, `GET /fragments/im` | view and up |
 * | `GET /fragments/im/form?platform=&id=` | ops level |
 * | `GET /fragments/im/qr/<login>` | ops level (the WeChat login code) |
 *
 * The JSON behind the buttons is `/v0/im` (`routes/imApi.ts`).
 */

import { fail, html, methodNotAllowed, notFound } from '../respond.js'
import {
  CHANNELS_PAGE_CSS,
  channelDialogs,
  type ChannelsModel,
  renderChannelForm,
  renderChannelQr,
  renderChannels,
} from '../view/channels.js'
import { CHANNELS_PAGE_JS } from '../view/channelsScript.js'
import { KIT_CSS } from '../view/kit.js'
import { channelsApi, channelsForReader } from './imApi.js'
import { actorOf, canOps, guardRead, segment } from './directionShared.js'
import { failureResponse } from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

async function modelOf(ctx: RouteContext): Promise<ChannelsModel> {
  const port = ctx.deps.channels
  const ops = canOps(ctx)
  if (port === undefined)
    return { side: { kind: 'unwired' }, now: ctx.now, ops }
  const snapshot = await port.snapshot()
  return {
    side: snapshot.ok
      ? { kind: 'ok', value: channelsForReader(snapshot.value, ops) }
      : { kind: 'failed', failure: snapshot.failure },
    now: ctx.now,
    ops,
  }
}

async function formFragment(ctx: RouteContext): Promise<Response> {
  if (!canOps(ctx)) return fail(403, 'forbidden', '添加和修改渠道需要管理权限')
  const port = ctx.deps.channels
  if (port === undefined)
    return fail(501, 'unsupported', '该控制台没有接入聊天渠道')
  const snapshot = await port.snapshot()
  if (!snapshot.ok) return failureResponse(snapshot.failure)
  const { platforms, channels, agents } = snapshot.value
  const id = ctx.url.searchParams.get('id')
  const channel =
    id === null ? null : (channels.find(one => one.id === id) ?? null)
  if (id !== null && channel === null) return notFound('没有这个渠道')
  const asked = channel?.platform ?? ctx.url.searchParams.get('platform')
  const platform = platforms.find(one => one.id === asked) ?? platforms[0]
  if (platform === undefined) return fail(503, 'unreachable', '没有可用的平台')
  return html(renderChannelForm({ platforms, platform, agents, channel }))
}

async function channelsFragment(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const denied = guardRead(ctx)
  if (denied !== null) return denied
  if (rest.length === 0) return html(renderChannels(await modelOf(ctx)))
  if (rest.length === 1 && rest[0] === 'form') return formFragment(ctx)
  if (rest.length === 2 && rest[0] === 'qr') {
    if (!canOps(ctx)) return fail(403, 'forbidden', '扫码登录需要管理权限')
    const port = ctx.deps.channels
    const id = segment(rest[1])
    if (port === undefined || id === null) return notFound('没有这次登录')
    const content = await port.loginQr(id, actorOf(ctx))
    if (!content.ok) return failureResponse(content.failure)
    return html(renderChannelQr(content.value))
  }
  return notFound(`unknown path: ${ctx.url.pathname}`)
}

export const channelsRoute: RouteModule = {
  area: {
    id: 'im',
    label: '渠道',
    group: 'main',
    href: '/admin/im',
    icon: 'messages-square',
  },
  page: {
    match: segments =>
      segments.length === 1 && segments[0] === 'im' ? [] : null,
    guard: 'view',
    available: ctx => ctx.deps.channels !== undefined,
    async render(ctx) {
      if (ctx.deps.channels === undefined)
        return notFound(`unknown path: ${ctx.url.pathname}`)
      const model = await modelOf(ctx)
      return {
        title: '渠道',
        body:
          `<div class="kit-pane" id="channels" data-poll="/fragments/im">${renderChannels(model)}</div>` +
          (model.ops ? channelDialogs() : ''),
      }
    },
    css: KIT_CSS + CHANNELS_PAGE_CSS,
    script: CHANNELS_PAGE_JS,
  },
  api: channelsApi,
  fragments: {
    heads: ['im'],
    handle: (ctx, _head, rest) => channelsFragment(ctx, rest),
  },
}
