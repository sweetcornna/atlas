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

import type {
  ConsoleFailure,
  HandoffTaskState,
  HandoffTaskView,
} from '../deps.js'
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
  /** The relay ledger, newest first; unwired when the hub has no handoff. */
  readonly relays: Side<readonly HandoffTaskView[]>
  /** Where relayed code lives: the user's GitHub repo, or the hub (legacy). */
  readonly codeStore: 'github' | 'hub' | null
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
  repo: 'GitHub 仓库',
}

const KIND_GLYPH: Readonly<Record<string, string>> = {
  mail: 'mail',
  calendar: 'calendar',
  repo: 'git-branch',
}

function kindGlyph(kind: string): string {
  return KIND_GLYPH[kind] ?? 'plug'
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
  username: '账号',
  user: '账号',
  account: '账号',
  email: '邮箱',
  imapHost: '收信服务器',
  imapPort: '收信端口',
  smtpHost: '发信服务器',
  smtpPort: '发信端口',
  smtpTls: '发信加密',
  caldavUrl: 'CalDAV 地址',
  host: '服务器',
  repo: '仓库',
  exchange: '用作文件交换仓库（必须私有）',
}

/** The settings that are the person's own, shown unfolded. */
const ACCOUNT_KEYS: readonly string[] = [
  'username',
  'user',
  'account',
  'email',
  'repo',
  'exchange',
]

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

function fact(key: string, value: string): string {
  return `<div class="con-fact"><span class="note">${escapeHtml(key)}</span><span>${value}</span></div>`
}

/** A GitHub repo: its name, what the last test found, and what it is for. */
function repoFacts(repo: NonNullable<ConnectorView['repo']>): string {
  const untested = '<span class="note">未测试</span>'
  const visibility =
    repo.private === null
      ? untested
      : repo.private
        ? '私有'
        : repo.exchange
          ? state('bad', '公开 · 不能做文件交换')
          : '公开'
  const push =
    repo.push === null ? untested : repo.push ? '可写' : state('bad', '只读')
  return (
    fact('仓库', `<span class="kit-mono">${escapeHtml(repo.name)}</span>`) +
    fact('可见性', visibility) +
    fact('写权限', push) +
    fact('用途', repo.exchange ? '接力 · 文件交换' : '接力')
  )
}

function connectorCard(connector: ConnectorView, model: ConnectModel): string {
  const facts =
    connector.repo === undefined
      ? Object.entries(connector.summary)
          .map(([key, value]) =>
            fact(
              settingWord(key),
              `<span class="kit-mono">${escapeHtml(value)}</span>`,
            ),
          )
          .join('')
      : repoFacts(connector.repo)
  const agents =
    connector.kind === 'repo'
      ? `<span class="note">中枢自己用 · 不授权给智能体</span>`
      : connector.agents.length === 0
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
      kindGlyph(connector.kind),
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
      '连上邮箱或日历后 · 智能体可以读信 看日程 · 发信和建日程每次都要你批准 · 连上 GitHub 仓库后 · 接力的代码和节点间的文件都放在你自己的仓库 · 凭据只存在中枢',
      'qm console … --connectors',
    )
  } else if (side.kind === 'failed') {
    body = failureBar(side.failure, '应用连接')
  } else if (side.value.connectors.length === 0) {
    body = emptyState(
      '还没有连接',
      '连上邮箱或日历后 · 智能体可以读信 看日程 · 发信和建日程每次都要你批准 · 连上 GitHub 仓库后 · 接力的代码和节点间的文件都放在你自己的仓库',
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
    `<b>${escapeHtml(device.name)}</b>` +
    // A client device can open the front; a handoff device only relays.
    (device.kind === 'client'
      ? `<span class="tag tag-neutral">客户端</span>`
      : '') +
    `</div></td>` +
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

const RELAY_STATE: Readonly<
  Record<HandoffTaskState, readonly ['ok' | 'warn' | 'bad' | 'muted', string]>
> = {
  accepted: ['muted', '已登记'],
  dispatched: ['warn', '已派发'],
  running: ['warn', '进行中'],
  done: ['ok', '已完成'],
  failed: ['bad', '失败'],
  returned: ['ok', '已接回'],
}

/** How many relays the page lists; the rest stay in the ledger. */
const RELAY_ROWS = 8

function shortCommit(commit: string): string {
  return commit.slice(0, 7)
}

function relayCode(task: HandoffTaskView): string {
  const code = task.code
  if (code === undefined) return '<span class="note">中枢</span>'
  const result =
    code.result === undefined
      ? ''
      : ` · 结果 <span class="kit-mono">${escapeHtml(shortCommit(code.result.commit))}</span>`
  const sessions =
    code.sessions === null
      ? ` ${tag('无会话记录', 'muted', code.sessionsReason)}`
      : ''
  const cleaned = code.cleaned === true ? ` ${tag('分支已清理')}` : ''
  return (
    `<span class="kit-mono">${escapeHtml(code.repo)}</span>` +
    `<span class="note"> · 起点 <span class="kit-mono">${escapeHtml(shortCommit(code.wip.commit))}</span>${result}</span>` +
    sessions +
    cleaned
  )
}

function relayRow(task: HandoffTaskView, model: ConnectModel): string {
  const [tone, word] = RELAY_STATE[task.state]
  const goal = task.manifest.brief.goal.trim()
  return (
    `<tr data-key="${attr(task.taskId)}">` +
    `<td><b>${goal === '' ? escapeHtml(task.taskId) : escapeHtml(goal.length > 40 ? `${goal.slice(0, 40)}…` : goal)}</b>` +
    `<div class="note kit-mono">${escapeHtml(task.manifest.project)}</div></td>` +
    `<td>${task.node === null ? absent() : `<span class="kit-mono">${escapeHtml(task.node)}</span>`}</td>` +
    `<td>${relayCode(task)}</td>` +
    `<td>${task.state === 'failed' && task.reason !== null ? state(tone, `${word} · ${task.reason}`) : state(tone, word)}</td>` +
    `<td class="when"><span class="note">${escapeHtml(formatRelative(task.updatedAt, model.now))}</span></td></tr>`
  )
}

function relaysBlock(model: ConnectModel): string {
  const side = model.relays
  if (side.kind === 'unwired') return ''
  if (side.kind === 'failed') return failureBar(side.failure, '接力')
  const where =
    model.codeStore === 'github'
      ? '代码和结果放在你自己的 GitHub 仓库的 qianmo/* 分支 · 中枢只存台账 · 接回后分支删除'
      : '代码经中枢的仓库中转'
  const repos =
    model.connectors.kind === 'ok'
      ? model.connectors.value.connectors.filter(one => one.kind === 'repo')
          .length
      : null
  const missing =
    model.codeStore === 'github' && repos === 0
      ? `<p class="note">还没有 GitHub 仓库连接 · 在上面「应用连接」里添加 · 或启动时给 --handoff-repo</p>`
      : ''
  if (side.value.length === 0)
    return (
      `<div class="relays"><h3 class="relays-h">最近接力</h3>` +
      `<p class="note">还没有接力 · ${escapeHtml(where)}</p>${missing}</div>`
    )
  const rows = [...side.value]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RELAY_ROWS)
  const head = ['任务', '节点', '代码', '状态', '更新']
    .map(name => `<th scope="col">${escapeHtml(name)}</th>`)
    .join('')
  return (
    `<div class="relays"><h3 class="relays-h">最近接力</h3>` +
    `<p class="note">${escapeHtml(where)}</p>${missing}` +
    scroll(
      `<table class="trail relays-t"><caption class="sr-only">最近接力</caption>` +
        `<thead><tr>${head}</tr></thead><tbody>${rows
          .map(one => relayRow(one, model))
          .join('')}</tbody></table>`,
    ) +
    `</div>`
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
      'qm console … --connectors（在「应用连接」添加 GitHub 仓库）或 --handoff-repo <owner/name>=<令牌文件>',
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
    (side.kind === 'unwired' ? '' : relaysBlock(model)) +
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
      kindGlyph(preset.kind),
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
  if (key === 'smtpTls') {
    const options = [
      ['smtps', 'SMTPS（通常 465）'],
      ['starttls', 'STARTTLS（通常 587）'],
    ] as const
    return (
      `<label class="field"><span class="flabel">${escapeHtml(settingWord(key))}</span>` +
      `<span class="sel"><select class="input" name="s-${attr(key)}" data-setting="${attr(key)}" data-number="0">${options
        .map(
          ([id, word]) =>
            `<option value="${id}"${value === id ? ' selected' : ''}>${escapeHtml(word)}</option>`,
        )
        .join('')}</select>${chevron()}</span></label>`
    )
  }
  const numeric = typeof value === 'number'
  return textField(`s-${key}`, settingWord(key), {
    value: String(value),
    type: numeric ? 'number' : 'text',
    mono: !numeric,
    wide,
    ...(key === 'repo'
      ? { placeholder: 'owner/name', required: true, maxLength: 140 }
      : {}),
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
  const repo = input.preset.kind === 'repo'
  const secret = textField(
    'secret',
    repo ? 'GitHub 令牌' : subscription ? '订阅地址' : '口令或授权码',
    {
      type: 'password',
      wide: true,
      required: !editing,
      placeholder: editing ? '不改就留空' : '',
      help: repo
        ? '细粒度令牌 · 只选这一个仓库 · Contents 读写 · 只存在中枢 · 加密保存'
        : '只存在中枢 · 加密保存 · 页面上不再显示',
    },
  )
  const agents = repo
    ? `<p class="note field-wide">中枢自己用 · 接力的代码和结果、节点间的文件经它交换 · 不授权给智能体</p>`
    : input.agents.length === 0
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

/**
 * The pairing dialog; the code arrives from `POST /v0/handoff/devices/pairing`.
 * The client's steps show when the answer has a `qmo sign-in` line, the
 * handoff steps when it has a `qm handoff login` one (clients.md §3.1).
 */
export function pairingDialog(): string {
  const copy = (target: string) =>
    `<button type="button" class="btn btn-secondary btn-small" data-action="pairing-copy" data-target="${target}">复制</button>`
  return (
    `<dialog class="dialog" id="pairing-dialog" aria-labelledby="pairing-title">` +
    `<div class="dialog-form">` +
    dialogTop('pairing-title', 'laptop', '添加设备') +
    `<div class="dialog-body pair-body">` +
    `<p class="pair-code" id="pairing-code" aria-label="配对码"></p>` +
    `<p class="note" id="pairing-expiry"></p>` +
    `<ol class="pair-steps" id="pairing-client" hidden>` +
    `<li><b>阡陌客户端</b><span class="note">在要用的电脑上运行下面这行 · 按提示输入上面的配对码 · 只能用一次</span>` +
    `<code class="cmd mono pair-cmd" id="pairing-client-command" data-raw></code>` +
    `<span class="kit-row">${copy('pairing-client-command')}</span></li>` +
    `<li><b>打开前台</b><span class="note">之后运行 qmo open</span></li>` +
    `</ol>` +
    `<ol class="pair-steps" id="pairing-handoff" hidden>` +
    `<li><b>装插件</b><span class="note">在本机的 Claude Code 或 Codex 里装上阡陌插件</span></li>` +
    `<li><b>登录一次</b><span class="note">在本机终端运行下面这行 · 配对码只能用一次</span>` +
    `<code class="cmd mono pair-cmd" id="pairing-command" data-raw></code>` +
    `<span class="kit-row">${copy('pairing-command')}</span></li>` +
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
/* One connection per row (qmo-local.md §3.4): the name on the left, its
   state and actions on the right, the facts and the agents under it; a
   hairline between rows. */
.con-grid { display: flex; flex-direction: column; }
.con-grid > .con-card {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center;
  column-gap: var(--space-6); row-gap: var(--space-2); padding: var(--space-3) 0;
}
.con-grid > .con-card + .con-card { border-top: var(--hairline); }
.con-grid > .con-card > * { grid-column: 1 / -1; padding-left: calc(var(--control-h) + var(--space-3)); }
.con-grid > .con-card > .con-head { grid-column: 1; grid-row: 1; padding-left: 0; }
.con-grid > .con-card > .con-foot { grid-column: 2; grid-row: 1; padding-left: 0; }
.con-head { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.con-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 var(--space-2); flex: 1; min-width: 0; }
.con-title b { font-size: var(--text-ui); font-weight: var(--weight-semibold); overflow-wrap: anywhere; }
.con-glyph { display: inline-grid; place-items: center; width: var(--control-h); height: var(--control-h); border-radius: var(--radius-control); background: var(--ui-field); color: var(--color-quiet); flex: none; }
.con-glyph.con-calendar { color: var(--color-accent-2, var(--color-accent)); }
.con-glyph.con-repo { color: var(--color-text); }
.con-preset .con-glyph { width: 24px; height: 24px; border-radius: var(--radius-sm); }
.con-facts { display: flex; flex-wrap: wrap; gap: 2px var(--space-5); }
.con-fact { display: flex; align-items: baseline; gap: 6px; font-size: var(--text-ui); min-width: 0; }
.con-agents { display: flex; flex-wrap: wrap; gap: 6px; }
.con-agent { font-size: var(--text-small); padding: 0 8px; border-radius: var(--radius-xs); background: var(--ui-field); }
.con-foot { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-3); flex-wrap: wrap; }
.con-calls { margin-top: 0; }
.con-calls > summary { list-style: none; cursor: pointer; font-size: var(--text-small); color: var(--color-muted); display: inline-flex; align-items: center; gap: 4px; }
.con-calls > summary::-webkit-details-marker { display: none; }
.con-calls[open] > summary svg { transform: rotate(180deg); }
.con-calls ul { list-style: none; margin: var(--space-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.con-calls li { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; font-size: var(--text-small); }
.con-presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: var(--space-2); }
.con-preset { display: flex; align-items: center; gap: var(--space-2); min-height: var(--control-h); padding: 0 10px; border-radius: var(--radius-control); background: var(--color-field); cursor: pointer; font-size: var(--text-ui); border: 1px solid var(--ui-line); }
.con-preset input { position: absolute; opacity: 0; pointer-events: none; }
.con-preset:has(input:checked) { border-color: var(--color-text); }
.con-preset:has(input:focus-visible) { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.con-hint { display: flex; gap: 6px; align-items: flex-start; }
.con-more > summary { list-style: none; cursor: pointer; font-size: var(--text-small); color: var(--color-muted); display: inline-flex; align-items: center; gap: 4px; padding: 4px 0; }
.con-more > summary::-webkit-details-marker { display: none; }
.con-more[open] > summary svg { transform: rotate(180deg); }
.con-more > .form-grid { margin-top: var(--space-2); }
.con-status:empty { display: none; }
.con-dialog .dialog-body { max-height: min(70vh, 640px); overflow: auto; }
.dev-glyph { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: var(--radius-control); background: var(--ui-field); color: var(--color-muted); }
.dev-revoked { opacity: .55; }
.trail.devices { min-width: 640px; }
.trail.devices td:first-child { min-width: 9em; }
.pair-steps { margin: var(--space-3) 0 0; padding: 0; list-style: none; counter-reset: step; display: flex; flex-direction: column; gap: var(--space-3); }
.pair-steps[hidden] { display: none; }
.pair-steps li { counter-increment: step; display: flex; flex-direction: column; gap: 4px; position: relative; padding-left: 34px; }
.pair-steps li::before { content: counter(step); position: absolute; left: 0; top: 0; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: var(--text-small); font-weight: 600; background: var(--color-accent-fill); color: var(--color-on-accent-fill); }
.pair-cmd { display: block; padding: var(--space-2) var(--space-3); border-radius: var(--radius-control); background: var(--ui-field); white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-small); }
.pair-code { font-family: var(--font-mono); font-size: var(--text-title); line-height: var(--lh-title); letter-spacing: .14em; text-align: center; padding: var(--space-4) var(--space-3); border-radius: var(--radius-control); background: var(--ui-field); margin: 0; }
.pair-code:empty { display: none; }
.relays { margin-top: var(--space-6); display: flex; flex-direction: column; gap: var(--space-2); }
.relays-h { margin: 0; font-size: var(--text-ui); font-weight: 600; }
.relays-t { min-width: 600px; }
.relays-t td { vertical-align: top; }
.relays-t td:first-child { min-width: 10em; }
.relays-t td:nth-child(2), .relays-t td:nth-child(5) { white-space: nowrap; }
.relays-t td:nth-child(3) { overflow-wrap: anywhere; }
`
