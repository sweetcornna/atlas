// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 连接: 应用连接 (P25) and 本机工具 (P19 devices) on one page.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /admin/connect`, `GET /fragments/connect` | view and up |
 * | `GET /fragments/connect/form?preset=&id=` | ops level (the add / edit dialog's body) |
 *
 * The JSON behind the buttons lives with its owners: `/v0/connectors`
 * (`routes/connectorsApi.ts`) and `/v0/handoff/devices` (`routes/handoff.ts`).
 * The area shows when either port is wired; a console with neither has no
 * 连接 at all.
 */

import type { ConsoleResult } from '../contracts.js'
import type { HandoffTaskView } from '../deps.js'
import type {
  ConnectorPresetView,
  ConnectorsSnapshot,
  ConnectorView,
  HandoffDeviceView,
} from '../directionPorts.js'
import { fail, html, methodNotAllowed, notFound } from '../respond.js'
import {
  CONNECT_PAGE_CSS,
  type ConnectModel,
  connectConfirms,
  connectorDialog,
  pairingDialog,
  renderConnect,
  renderConnectorForm,
  type Side,
} from '../view/connect.js'
import { CONNECT_PAGE_JS } from '../view/connectScript.js'
import { KIT_CSS } from '../view/kit.js'
import { connectorsApi } from './connectorsApi.js'
import { canMember, canOps, guardRead } from './directionShared.js'
import { failureResponse } from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

async function sideOf<T>(
  run: (() => Promise<ConsoleResult<T>>) | null,
): Promise<Side<T>> {
  if (run === null) return { kind: 'unwired' }
  const result = await run()
  return result.ok
    ? { kind: 'ok', value: result.value }
    : { kind: 'failed', failure: result.failure }
}

/** What a reader below ops level may see of a connection: no raw settings. */
function forReader(
  snapshot: ConnectorsSnapshot,
  ops: boolean,
): ConnectorsSnapshot {
  if (ops) return snapshot
  return {
    ...snapshot,
    connectors: snapshot.connectors.map(
      ({ settings: _settings, ...rest }) => rest,
    ),
  }
}

async function modelOf(ctx: RouteContext): Promise<ConnectModel> {
  const connectors = ctx.deps.connectors
  const devices = ctx.deps.handoffDevices
  const handoff = ctx.deps.handoff
  const ops = canOps(ctx)
  const [connectorSide, deviceSide, relaySide] = await Promise.all([
    sideOf(connectors === undefined ? null : () => connectors.snapshot()),
    sideOf<readonly HandoffDeviceView[]>(
      devices === undefined ? null : () => devices.listDevices(),
    ),
    sideOf<readonly HandoffTaskView[]>(
      handoff === undefined ? null : () => handoff.list(),
    ),
  ])
  return {
    connectors:
      connectorSide.kind === 'ok'
        ? { kind: 'ok', value: forReader(connectorSide.value, ops) }
        : connectorSide,
    devices: deviceSide,
    relays: relaySide,
    codeStore: handoff === undefined ? null : (handoff.codeStore ?? 'hub'),
    now: ctx.now,
    ops,
    member: canMember(ctx),
    subject: ctx.access.principal?.subject ?? null,
  }
}

function pageBody(model: ConnectModel): string {
  return (
    `<div class="kit-pane" id="connect" data-poll="/fragments/connect">` +
    renderConnect(model) +
    `</div>` +
    (model.ops && model.connectors.kind === 'ok' ? connectorDialog() : '') +
    (model.member && model.devices.kind === 'ok' ? pairingDialog() : '') +
    connectConfirms(model.ops, model.member)
  )
}

async function formFragment(ctx: RouteContext): Promise<Response> {
  if (!canOps(ctx)) {
    return fail(403, 'forbidden', '添加和修改连接需要管理权限')
  }
  const port = ctx.deps.connectors
  if (port === undefined)
    return fail(501, 'unsupported', '该控制台没有接入应用连接')
  const snapshot = await port.snapshot()
  if (!snapshot.ok) return failureResponse(snapshot.failure)
  const { presets, connectors, agents } = snapshot.value
  const id = ctx.url.searchParams.get('id')
  const connector: ConnectorView | null =
    id === null ? null : (connectors.find(one => one.id === id) ?? null)
  if (id !== null && connector === null) {
    return notFound('没有这个连接')
  }
  const asked = ctx.url.searchParams.get('preset')
  const preset: ConnectorPresetView | undefined =
    connector === null
      ? (presets.find(one => one.id === asked) ?? presets[0])
      : (presets.find(one => one.id === connector.preset) ?? {
          id: connector.preset,
          kind: connector.kind,
          evaluated: false,
          name: connector.name,
          defaults: {},
          hint: '',
        })
  if (preset === undefined) {
    return fail(503, 'unreachable', '没有可用的服务预设')
  }
  return html(
    renderConnectorForm({
      presets,
      agents,
      preset,
      connector,
      settings: formSettings(preset, connector),
    }),
  )
}

/**
 * The fields a connection of this kind needs, in reading order: a preset
 * fills what it knows (it may leave an unconfirmed host blank), a saved
 * connection what it has.
 */
function formSettings(
  preset: ConnectorPresetView,
  connector: ConnectorView | null,
): Readonly<Record<string, string | number | boolean>> {
  // A repo's preset names its shape (`owner/name`), not a value to keep.
  if (preset.kind === 'repo')
    return { repo: '', exchange: false, ...connector?.settings }
  const fields: Record<string, string | number | boolean> =
    preset.kind === 'mail'
      ? {
          username: '',
          imapHost: '',
          imapPort: 993,
          smtpHost: '',
          smtpPort: 465,
          smtpTls: 'smtps',
        }
      : /ics/i.test(preset.id)
        ? {}
        : { username: '', caldavUrl: '' }
  return { ...fields, ...preset.defaults, ...connector?.settings }
}

async function connectFragment(
  ctx: RouteContext,
  rest: readonly string[],
): Promise<Response> {
  if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
  const denied = guardRead(ctx)
  if (denied !== null) return denied
  if (rest.length === 0) return html(renderConnect(await modelOf(ctx)))
  if (rest.length === 1 && rest[0] === 'form') return await formFragment(ctx)
  return notFound(`unknown path: ${ctx.url.pathname}`)
}

export const connectRoute: RouteModule = {
  area: {
    id: 'connect',
    label: '应用连接',
    group: 'manage',
    href: '/admin/connect',
    icon: 'plug',
  },
  page: {
    match: segments =>
      segments.length === 1 && segments[0] === 'connect' ? [] : null,
    guard: 'view',
    available: ctx =>
      ctx.deps.connectors !== undefined ||
      ctx.deps.handoffDevices !== undefined,
    async render(ctx) {
      if (
        ctx.deps.connectors === undefined &&
        ctx.deps.handoffDevices === undefined
      ) {
        return notFound(`unknown path: ${ctx.url.pathname}`)
      }
      return { title: '应用连接', body: pageBody(await modelOf(ctx)) }
    },
    css: KIT_CSS + CONNECT_PAGE_CSS,
    script: CONNECT_PAGE_JS,
  },
  api: connectorsApi,
  fragments: {
    heads: ['connect'],
    handle: (ctx, _head, rest) => connectFragment(ctx, rest),
  },
}
