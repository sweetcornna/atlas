// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 连接: what the agents can reach beyond their nodes.
 *
 * Two halves on one page, because a person thinks of them together — "what
 * is plugged in":
 *
 * - **应用连接** (P25): mailboxes and calendars the hub holds the
 *   credentials for. Agents use them through host tools; sending mail and
 *   creating events always waits for the person's approval.
 * - **本机工具** (P19): the laptops whose Claude Code or Codex carry the
 *   qianmo plugin. Pair once, and work hands off between the laptop and the
 *   agents on the servers.
 *
 * Every credential stays on the hub; the page shows a host name, a masked
 * account and "已设置", never a secret.
 */

import type { ConsoleFailure } from '../deps.js'
import type {
  ConnectorCallView,
  ConnectorPresetView,
  ConnectorsSnapshot,
  ConnectorView,
  HandoffDeviceView,
} from '../directionPorts.js'
import {
  absent,
  chevron,
  failureBar,
  hint,
  icon,
  scroll,
  sectionHead,
  state,
  tag,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatRelative } from './format.js'
import {
  actionButton,
  checkGroup,
  dialogActions,
  dialogTop,
  emptyState,
  textField,
  unwiredCard,
} from './kit.js'

/** A side of the page: its data, why it is missing, or not wired at all. */
export type Side<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'failed'; readonly failure: ConsoleFailure }
  | { readonly kind: 'unwired' }

export interface ConnectModel {
  readonly connectors: Side<ConnectorsSnapshot>
  readonly devices: Side<readonly HandoffDeviceView[]>
  readonly now: number
  /** May add, change, test and remove connections (ops level). */
  readonly ops: boolean
  /** May pair a device (member level). */
  readonly member: boolean
  /** Who reads, to tell which devices they may revoke. */
  readonly subject: string | null
}

const KIND_WORD: Readonly<Record<string, string>> = {
  mail: '邮件',
  calendar: '日历',
}

const OP_WORD: Readonly<Record<string, string>> = {
  'mail.search': '找邮件',
  'mail.read': '读邮件',
  'mail.send': '发邮件',
  'calendar.events': '看日程',
  'calendar.create': '建日程',
}

/** The non-secret settings a person recognises, in the order they read them. */
const SETTING_WORD: Readonly<Record<string, string>> = {
  user: '账号',
  account: '账号',
  email: '邮箱',
  imapHost: '收信服务器',
  imapPort: '收信端口',
  smtpHost: '发信服务器',
  smtpPort: '发信端口',
  caldavUrl: 'CalDAV 地址',
  host: '服务器',
}

/** The settings that are the person's own, shown unfolded. */
const ACCOUNT_KEYS: readonly string[] = ['user', 'account', 'email']

function settingWord(key: string): string {
  return SETTING_WORD[key] ?? key
}

function agentName(address: string): string {
  const match = /^qianmo:\/\/([^/]+)\/(.+)$/.exec(address)
  return match === null ? address : `${match[2]} · ${match[1]}`
}

// ---------------------------------------------------------------------------
// 应用连接
// ---------------------------------------------------------------------------

function probeLine(connector: ConnectorView, now: number): string {
  const probe = connector.lastProbe
  if (probe === null) return `<span class="note">还没测试过</span>`
  return (
    `<span title="${attr(probe.detail)}">${state(
      probe.ok ? 'ok' : 'bad',
      probe.ok ? '连得上' : '上次没连上',
    )}</span>` +
    `<span class="note">${escapeHtml(formatRelative(probe.at, now))}</span>`
  )
}

function connectorCard(connector: ConnectorView, model: ConnectModel): string {
  const facts = Object.entries(connector.summary)
    .map(
      ([key, value]) =>
        `<div class="con-fact"><span class="note">${escapeHtml(settingWord(key))}</span>` +
        `<span class="kit-mono">${escapeHtml(value)}</span></div>`,
    )
    .join('')
  const agents =
    connector.agents.length === 0
      ? `<span class="note">还没有授权给智能体</span>`
      : connector.agents
          .map(
            one =>
              `<span class="con-agent">${escapeHtml(agentName(one))}</span>`,
          )
          .join('')
  const acts = model.ops
    ? `<span class="kit-acts">` +
      actionButton('connector-probe', '测试', {
        tone: 'ghost',
        data: { id: connector.id, name: connector.name },
      }) +
      actionButton('connector-edit', '编辑', {
        tone: 'ghost',
        data: { id: connector.id },
      }) +
      actionButton('connector-remove', '删除', {
        tone: 'ghost',
        data: { id: connector.id, name: connector.name },
      }) +
      `</span>`
    : ''
  return (
    `<article class="card elev-sm con-card" data-key="${attr(connector.id)}">` +
    `<header class="con-head"><span class="con-glyph con-${attr(connector.kind)}">${icon(
      connector.kind === 'mail' ? 'mail' : 'calendar',
    )}</span>` +
    `<div class="con-title"><b>${escapeHtml(connector.name)}</b>` +
    `<span class="note">${escapeHtml(KIND_WORD[connector.kind] ?? connector.kind)}` +
    `${connector.readOnly ? ' · 只读' : ''}</span></div>` +
    (connector.evaluated ? '' : tag('未评估', 'muted')) +
    `</header>` +
    `<div class="con-facts">${facts}` +
    `<div class="con-fact"><span class="note">凭据</span><span>${
      connector.secretSet
        ? `已设置${
            connector.secretSetAt === null
              ? ''
              : ` · ${escapeHtml(formatRelative(connector.secretSetAt, model.now))}`
          }`
        : '<span class="note">未设置</span>'
    }</span></div></div>` +
    `<div class="con-agents">${agents}</div>` +
    `<footer class="con-foot"><span class="kit-row">${probeLine(connector, model.now)}</span>${acts}</footer>` +
    `</article>`
  )
}

function callsList(
  calls: readonly ConnectorCallView[],
  snapshot: ConnectorsSnapshot,
  now: number,
): string {
  if (calls.length === 0) return ''
  const names = new Map(snapshot.connectors.map(one => [one.id, one.name]))
  const rows = calls
    .slice(0, 10)
    .map(
      call =>
        `<li><span class="note">${escapeHtml(formatRelative(call.at, now))}</span>` +
        `<span>${escapeHtml(agentName(call.agent))}</span>` +
        `<b>${escapeHtml(OP_WORD[call.op] ?? call.op)}</b>` +
        `<span class="note">${escapeHtml(names.get(call.connectorId) ?? call.connectorId)}</span>` +
        state(
          call.outcome === 'ok'
            ? 'ok'
            : call.outcome === 'refused'
              ? 'warn'
              : 'bad',
          call.outcome === 'ok'
            ? call.count === null
              ? '完成'
              : `${call.count} 条`
            : call.outcome === 'refused'
              ? '被拒'
              : '失败',
        ) +
        `</li>`,
    )
    .join('')
  return `<details class="con-calls"><summary>${chevron()}最近 ${escapeHtml(
    String(calls.length),
  )} 次调用</summary><ul>${rows}</ul></details>`
}

function connectorsSection(model: ConnectModel): string {
  const side = model.connectors
  const add =
    model.ops && side.kind === 'ok'
      ? actionButton('connector-new', '添加连接', { glyph: 'plus' })
      : ''
  let body: string
  if (side.kind === 'unwired') {
    body = unwiredCard(
      '应用连接',
      '连上邮箱或日历后 · 智能体可以读信 看日程 · 发信和建日程每次都要你批准 · 凭据只存在中枢',
      'qm console … --connectors',
    )
  } else if (side.kind === 'failed') {
    body = failureBar(side.failure, '应用连接')
  } else if (side.value.connectors.length === 0) {
    body = emptyState(
      '还没有连接',
      '连上邮箱或日历后 · 智能体可以读信 看日程 · 发信和建日程每次都要你批准',
      add,
    )
  } else {
    body =
      `<div class="con-grid">${side.value.connectors
        .map(one => connectorCard(one, model))
        .join('')}</div>` + callsList(side.value.recent, side.value, model.now)
  }
  return (
    `<section class="sec" aria-labelledby="h-apps">` +
    sectionHead('Apps', '应用连接', {
      headingId: 'h-apps',
      tail: `<div class="kit-row"><span class="note">只用测试服务器验证过协议 · 未评估</span>${
        side.kind === 'ok' && side.value.connectors.length > 0 ? add : ''
      }</div>`,
    }) +
    body +
    `</section>`
  )
}

// ---------------------------------------------------------------------------
// 本机工具
// ---------------------------------------------------------------------------

const PLATFORM_WORD: Readonly<Record<string, string>> = {
  'darwin-arm64': 'macOS · Apple 芯片',
  'darwin-x64': 'macOS · Intel',
  'linux-x64': 'Linux',
  'linux-arm64': 'Linux · ARM',
  'win32-x64': 'Windows',
}

function deviceRow(device: HandoffDeviceView, model: ConnectModel): string {
  const revoked = device.revokedAt !== null
  const mayRevoke =
    !revoked && (model.ops || (model.member && device.owner === model.subject))
  return (
    `<tr data-key="${attr(device.deviceId)}"${revoked ? ' class="dev-revoked"' : ''}>` +
    `<td><div class="kit-row"><span class="dev-glyph">${icon('laptop', { small: true })}</span>` +
    `<b>${escapeHtml(device.name)}</b></div></td>` +
    `<td>${
      device.platform === null
        ? absent()
        : escapeHtml(PLATFORM_WORD[device.platform] ?? device.platform)
    }</td>` +
    `<td><span class="kit-mono">${escapeHtml(device.owner)}</span></td>` +
    `<td class="when">${
      device.lastSeenAt === null
        ? '<span class="note">还没上线</span>'
        : `<span class="note">${escapeHtml(formatRelative(device.lastSeenAt, model.now))}</span>`
    }</td>` +
    `<td>${escapeHtml(String(device.tasks))}</td>` +
    `<td>${revoked ? state('muted', '已吊销') : state('ok', '可用')}</td>` +
    `<td class="acts">${
      mayRevoke
        ? actionButton('device-revoke', '吊销', {
            tone: 'ghost',
            data: { id: device.deviceId, name: device.name },
          })
        : absent()
    }</td></tr>`
  )
}

function devicesSection(model: ConnectModel): string {
  const side = model.devices
  const pair =
    model.member && side.kind === 'ok'
      ? actionButton('device-pair', '添加设备', { glyph: 'plus' })
      : ''
  let body: string
  if (side.kind === 'unwired') {
    body = unwiredCard(
      '本机工具',
      '在 Claude Code 或 Codex 里装上阡陌插件 · 配对一次 · 本机和服务器上的智能体就能互相接力',
      'qm console … --handoff-root <目录>',
    )
  } else if (side.kind === 'failed') {
    body = failureBar(side.failure, '本机工具')
  } else if (side.value.length === 0) {
    body = emptyState(
      '还没有配对的设备',
      '在 Claude Code 或 Codex 里装上阡陌插件 · 用这里给的配对码登录一次 · 之后本机的活可以交给服务器上的智能体接着做',
      pair,
    )
  } else {
    const head = ['设备', '系统', '签发人', '最近在线', '任务', '状态', '']
      .map(name => `<th scope="col">${escapeHtml(name)}</th>`)
      .join('')
    body = scroll(
      `<table class="trail devices"><caption class="sr-only">配对的设备</caption>` +
        `<thead><tr>${head}</tr></thead><tbody>${side.value
          .map(one => deviceRow(one, model))
          .join('')}</tbody></table>`,
    )
  }
  return (
    `<section class="sec" aria-labelledby="h-devices">` +
    sectionHead('Devices', '本机工具', {
      headingId: 'h-devices',
      tail: `<div class="kit-row"><span class="note">Claude Code 与 Codex 的阡陌插件 · 接力</span>${
        side.kind === 'ok' && side.value.length > 0 ? pair : ''
      }</div>`,
    }) +
    body +
    `</section>`
  )
}

/** The polled body of the page: both halves. */
export function renderConnect(model: ConnectModel): string {
  return connectorsSection(model) + devicesSection(model)
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/** The add / edit dialog; its body comes from `/fragments/connect/form`. */
export function connectorDialog(): string {
  return (
    `<dialog class="dialog con-dialog" id="connector-dialog" aria-labelledby="connector-title">` +
    `<form id="connector-form" novalidate>` +
    dialogTop('connector-title', 'plug', '添加连接') +
    `<div class="dialog-body" id="connector-body"></div>` +
    `<p class="note con-status" id="connector-status" role="status"></p>` +
    dialogActions('保存', { glyph: 'check' }) +
    `</form></dialog>`
  )
}

function presetChip(preset: ConnectorPresetView, chosen: string): string {
  return (
    `<label class="con-preset"><input type="radio" name="preset" value="${attr(preset.id)}"` +
    `${preset.id === chosen ? ' checked' : ''}>` +
    `<span class="con-glyph con-${attr(preset.kind)}">${icon(
      preset.kind === 'mail' ? 'mail' : 'calendar',
      { small: true },
    )}</span><span>${escapeHtml(preset.name)}</span></label>`
  )
}

function settingField(
  key: string,
  value: string | number | boolean,
  wide = false,
): string {
  if (typeof value === 'boolean') {
    return (
      `<label class="chk field-wide"><input type="checkbox" name="s-${attr(key)}" data-setting="${attr(key)}"` +
      `${value ? ' checked' : ''}><span class="bx">${icon('check', { small: true })}</span>` +
      `${escapeHtml(settingWord(key))}</label>`
    )
  }
  const numeric = typeof value === 'number'
  return textField(`s-${key}`, settingWord(key), {
    value: String(value),
    type: numeric ? 'number' : 'text',
    mono: !numeric,
    wide,
  }).replace(
    '<input ',
    `<input data-setting="${attr(key)}" data-number="${numeric ? '1' : '0'}" `,
  )
}

/**
 * The dialog body for one preset, or for an existing connection: which
 * service, its non-secret settings (pre-filled from the preset), the secret,
 * and which agents may use it.
 */
export function renderConnectorForm(input: {
  readonly presets: readonly ConnectorPresetView[]
  readonly agents: readonly string[]
  readonly preset: ConnectorPresetView
  readonly connector: ConnectorView | null
  /** The settings to fill in: the connection's own, else the preset's. */
  readonly settings: Readonly<Record<string, string | number | boolean>>
}): string {
  const editing = input.connector !== null
  const chips = editing
    ? `<p class="note">服务 · ${escapeHtml(input.preset.name)}</p>`
    : `<div class="field field-wide"><span class="flabel">服务</span>` +
      `<div class="con-presets" role="radiogroup" aria-label="服务">${input.presets
        .map(one => presetChip(one, input.preset.id))
        .join('')}</div></div>`
  // The account is the person's; servers and ports come filled from the
  // preset, so they sit folded unless one is still blank.
  const entries = Object.entries(input.settings)
  const own = entries.filter(([key]) => ACCOUNT_KEYS.includes(key))
  const server = entries.filter(([key]) => !ACCOUNT_KEYS.includes(key))
  const blank = server.some(([, value]) => value === '')
  const settings =
    own.map(([key, value]) => settingField(key, value, true)).join('') +
    (server.length === 0
      ? ''
      : `<details class="con-more field-wide"${blank ? ' open' : ''}>` +
        `<summary>${chevron()}服务器设置${blank ? '' : ` · 已按 ${escapeHtml(input.preset.name)} 填好`}</summary>` +
        `<div class="form-grid">${server
          .map(([key, value]) => settingField(key, value))
          .join('')}</div></details>`)
  // An ICS subscription's address carries its token: it is the secret.
  const subscription = /ics/i.test(input.preset.id)
  const secret = textField(
    'secret',
    subscription ? '订阅地址' : '口令或授权码',
    {
      type: 'password',
      wide: true,
      required: !editing,
      placeholder: editing ? '不改就留空' : '',
      help: '只存在中枢 · 加密保存 · 页面上不再显示',
    },
  )
  const agents =
    input.agents.length === 0
      ? `<p class="note field-wide">还没有可以授权的智能体</p>`
      : checkGroup(
          'agents',
          '哪些智能体能用',
          input.agents.map(one => [one, agentName(one)] as const),
          input.connector?.agents ?? [],
          '发信和建日程每次都要你批准 · 读信与看日程不用',
        )
  return (
    `<input type="hidden" name="connectorId" value="${attr(input.connector?.id ?? '')}">` +
    `<input type="hidden" name="kind" value="${attr(input.preset.kind)}">` +
    (editing
      ? `<input type="hidden" name="preset" value="${attr(input.preset.id)}">`
      : '') +
    `<div class="form-grid">` +
    chips +
    `<p class="note field-wide con-hint">${icon('info', { small: true })}${escapeHtml(input.preset.hint)}</p>` +
    textField('name', '名称', {
      required: true,
      wide: true,
      maxLength: 40,
      value: input.connector?.name ?? input.preset.name,
    }) +
    settings +
    secret +
    agents +
    `</div>`
  )
}

/** The pairing dialog; the code arrives from `POST /v0/handoff/devices/pairing`. */
export function pairingDialog(): string {
  return (
    `<dialog class="dialog" id="pairing-dialog" aria-labelledby="pairing-title">` +
    `<div class="dialog-form">` +
    dialogTop('pairing-title', 'laptop', '添加设备') +
    `<div class="dialog-body pair-body">` +
    `<p class="pair-code" id="pairing-code" aria-label="配对码"></p>` +
    `<ol class="pair-steps">` +
    `<li><b>装插件</b><span class="note">在本机的 Claude Code 或 Codex 里装上阡陌插件</span></li>` +
    `<li><b>登录一次</b><span class="note">在本机终端运行下面这行 · 配对码只能用一次</span>` +
    `<code class="cmd mono pair-cmd" id="pairing-command" data-raw></code>` +
    `<span class="kit-row"><button type="button" class="btn btn-secondary btn-small" data-action="pairing-copy">复制</button>` +
    `<span class="note" id="pairing-expiry"></span></span></li>` +
    `<li><b>开始接力</b><span class="note">在本机说「交给服务器接着做」· 回来时说「接回来」</span></li>` +
    `</ol>` +
    `</div>` +
    `<div class="dialog-actions"><button type="button" class="btn btn-primary" data-action="confirm-cancel">好了</button></div>` +
    `</div></dialog>`
  )
}

/** The confirmations the reader may need: remove a connection, revoke a device. */
export function connectConfirms(ops: boolean, member: boolean): string {
  const confirm = (id: string, title: string, line: string, label: string) =>
    `<dialog class="dialog" id="${id}" aria-labelledby="${id}-title">` +
    dialogTop(`${id}-title`, 'x', title) +
    `<div class="dialog-body"><div class="recap"><div class="recap-row"><span class="k">名称</span>` +
    `<span id="${id}-name"></span></div></div><p>${escapeHtml(line)}</p></div>` +
    dialogActions(label, { danger: true, action: id }) +
    `</dialog>`
  return (
    (ops
      ? confirm(
          'confirm-connector-remove',
          '删除连接',
          '凭据随之删除 · 用到它的智能体再调用会被拒绝',
          '删除',
        )
      : '') +
    (member || ops
      ? confirm(
          'confirm-device-revoke',
          '吊销设备',
          '这台设备的令牌立即失效 · 它登记的接力任务保留',
          '吊销',
        )
      : '')
  )
}

export const CONNECT_PAGE_CSS = `
.con-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: var(--space-3); }
.con-card { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); }
.con-head { display: flex; align-items: center; gap: var(--space-3); }
.con-title { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.con-title b { font-size: var(--text-14, 14px); overflow-wrap: anywhere; }
.con-glyph { display: inline-grid; place-items: center; width: 34px; height: 34px; border-radius: 11px; background: var(--color-accent-soft, var(--color-bg)); color: var(--color-accent); flex: none; }
.con-glyph.con-calendar { background: var(--color-accent-2-soft, var(--color-bg)); color: var(--color-accent-2, var(--color-accent)); }
.con-preset .con-glyph { width: 24px; height: 24px; border-radius: 8px; }
.con-facts { display: flex; flex-direction: column; gap: 6px; }
.con-fact { display: flex; justify-content: space-between; gap: var(--space-3); font-size: var(--text-13); min-width: 0; }
.con-fact .kit-mono { text-align: right; }
.con-agents { display: flex; flex-wrap: wrap; gap: 6px; }
.con-agent { font-size: var(--text-12); padding: 2px 8px; border-radius: 999px; background: var(--color-bg); }
.con-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; margin-top: auto; }
.con-calls { margin-top: var(--space-3); }
.con-calls > summary { list-style: none; cursor: pointer; font-size: var(--text-12-5); color: var(--color-muted); display: inline-flex; align-items: center; gap: 4px; }
.con-calls > summary::-webkit-details-marker { display: none; }
.con-calls[open] > summary svg { transform: rotate(180deg); }
.con-calls ul { list-style: none; margin: var(--space-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.con-calls li { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; font-size: var(--text-12-5); }
.con-presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: var(--space-2); }
.con-preset { display: flex; align-items: center; gap: var(--space-2); padding: 8px 10px; border-radius: var(--radius-md); background: var(--color-bg); cursor: pointer; font-size: var(--text-13); border: 1px solid transparent; }
.con-preset input { position: absolute; opacity: 0; pointer-events: none; }
.con-preset:has(input:checked) { border-color: var(--color-accent); background: var(--color-surface); }
.con-preset:has(input:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.con-hint { display: flex; gap: 6px; align-items: flex-start; }
.con-more > summary { list-style: none; cursor: pointer; font-size: var(--text-12-5); color: var(--color-muted); display: inline-flex; align-items: center; gap: 4px; padding: 4px 0; }
.con-more > summary::-webkit-details-marker { display: none; }
.con-more[open] > summary svg { transform: rotate(180deg); }
.con-more > .form-grid { margin-top: var(--space-2); }
.con-status:empty { display: none; }
.con-dialog .dialog-body { max-height: min(70vh, 640px); overflow: auto; }
.dev-glyph { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 9px; background: var(--color-bg); color: var(--color-muted); }
.dev-revoked { opacity: .55; }
.pair-steps { margin: var(--space-3) 0 0; padding: 0; list-style: none; counter-reset: step; display: flex; flex-direction: column; gap: var(--space-3); }
.pair-steps li { counter-increment: step; display: flex; flex-direction: column; gap: 4px; position: relative; padding-left: 34px; }
.pair-steps li::before { content: counter(step); position: absolute; left: 0; top: 0; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: var(--text-12); font-weight: 600; background: var(--color-accent); color: var(--color-on-accent, #fff); }
.pair-cmd { display: block; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--color-bg); white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-12); }
.pair-code { font-family: var(--font-mono); font-size: 24px; letter-spacing: .14em; text-align: center; padding: var(--space-4) var(--space-3); border-radius: var(--radius-md); background: var(--color-bg); margin: 0; }
.pair-code:empty { display: none; }
`
