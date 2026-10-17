// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 网关 (P34): the platform's magpie gateway as the hub manages it — the
 * connection, magpie's upstreams and routing groups, the gateway key each
 * node or tenant holds, and what those keys used. Upstreams that sign in to
 * a subscription or borrow a vendor client's identity are listed read-only:
 * Qianmo's keys never reach them (L-6).
 */

import type { ConsoleFailure } from '../deps.js'
import type {
  MagpieGroupView,
  MagpieKeyView,
  MagpieLimitView,
  MagpieProviderView,
  MagpieSnapshot,
  MagpieUsagePeriod,
  MagpieUsageTotalsView,
  MagpieUsageView,
} from '../directionPorts.js'
import {
  absent,
  failureBar,
  scroll,
  sectionHead,
  state,
  tag,
  timeTag,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import {
  actionButton,
  dialogActions,
  dialogTop,
  emptyState,
  segmented,
  selectField,
  switchField,
  textArea,
  textField,
  unwiredCard,
} from './kit.js'

export type MagpieSide =
  | { readonly kind: 'ok'; readonly value: MagpieSnapshot }
  | { readonly kind: 'failed'; readonly failure: ConsoleFailure }
  | { readonly kind: 'unwired' }

export interface MagpieModel {
  readonly side: MagpieSide
  /** May change the gateway (personal ops, platform). */
  readonly writer: boolean
}

export type MagpieUsageSide =
  | { readonly kind: 'ok'; readonly value: MagpieUsageView }
  | { readonly kind: 'failed'; readonly failure: ConsoleFailure }
  | { readonly kind: 'unwired' }

const ROUTING_WORD: Readonly<Record<string, string>> = {
  smart: '智能',
  order: '按顺序',
  rotate: '轮流',
  usage: '按余量',
  pace: '按节奏',
}

const AFFINITY_WORD: Readonly<Record<string, string>> = {
  auto: '自动',
  session: '整段会话',
  turn: '每轮',
  off: '不保持',
  strict: '严格',
}

const LIMIT_WORD: Readonly<Record<string, string>> = {
  day: '每天',
  week: '每周',
  month: '每月',
}

const LANE_WORD: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  'openai-responses': 'OpenAI Responses',
  'openai-chat': 'OpenAI Chat',
}

const MAGPIE_PERIOD_WORD: Readonly<Record<MagpieUsagePeriod, string>> = {
  today: '今天',
  '7d': '7 天',
  '30d': '30 天',
  all: '全部',
}

function mono(text: string): string {
  return `<span class="kit-mono">${escapeHtml(text)}</span>`
}

function fact(key: string, value: string): string {
  return `<div class="mg-fact"><span class="note">${escapeHtml(key)}</span><span>${value}</span></div>`
}

/** A count in a few characters: 980 · 12.4k · 3.1M. */
function compact(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  if (n < 1_000_000_000)
    return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
  return `${(n / 1_000_000_000).toFixed(1)}B`
}

function dollars(n: number): string {
  return `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`
}

/** Host and scheme of an origin; a reader's copy is already host alone. */
function placeOf(url: string): { host: string; scheme: string | null } {
  const at = url.indexOf('://')
  if (at < 0) return { host: url, scheme: null }
  try {
    const parsed = new URL(url)
    return { host: parsed.host, scheme: parsed.protocol.slice(0, -1) }
  } catch {
    return { host: url, scheme: null }
  }
}

function place(url: string | null): string {
  if (url === null) return absent()
  const { host, scheme } = placeOf(url)
  return mono(host) + (scheme === null ? '' : ` ${tag(scheme)}`)
}

function bindingWord(binding: {
  readonly kind: string
  readonly id: string
}): string {
  return `${binding.kind === 'node' ? '节点' : '租户'} ${binding.id}`
}

function bindingKeyOf(binding: {
  readonly kind: string
  readonly id: string
}): string {
  return `${binding.kind}:${binding.id}`
}

// --- connection --------------------------------------------------------

function connectionPill(snapshot: MagpieSnapshot): string {
  const { connection } = snapshot
  if (!connection.configured) return state('muted', '未连接')
  const check = connection.check
  if (check === null) return state('warn', '未核对')
  if (!check.ok) return state('bad', `核对失败 · ${check.code ?? '未知'}`)
  return state(
    'ok',
    check.version === null ? '已连接' : `已连接 · ${check.version}`,
  )
}

const GATEWAY_STATE: Readonly<
  Record<string, readonly ['ok' | 'warn' | 'bad', string]>
> = {
  keyed: ['ok', '要网关密钥'],
  open: ['warn', '无需密钥即可调用'],
  closed: ['bad', '没有共享到网络'],
  unreachable: ['bad', '连不上'],
}

function connectionSection(snapshot: MagpieSnapshot, writer: boolean): string {
  const { connection } = snapshot
  const acts = writer
    ? `<span class="kit-acts">` +
      (connection.configured
        ? actionButton('magpie-check', '核对', { tone: 'ghost' })
        : '') +
      (connection.configured
        ? actionButton('magpie-connect', '编辑', { tone: 'ghost' })
        : actionButton('magpie-connect', '连接', {
            tone: 'primary',
            glyph: 'plus',
          })) +
      `</span>`
    : ''
  const head = sectionHead('Connection', '连接', {
    headingId: 'h-mg-conn',
    tail: `<div class="kit-row">${connectionPill(snapshot)}</div>`,
  })
  if (!connection.configured) {
    return (
      `<section class="sec" aria-labelledby="h-mg-conn">${head}` +
      emptyState(
        '还没有连接 magpie',
        'magpie serve --web=127.0.0.1:3430 · 网关开 TLS 并要求密钥',
        acts,
      ) +
      `</section>`
    )
  }
  const check = connection.check
  const gateway = check === null ? null : (GATEWAY_STATE[check.gateway] ?? null)
  const facts = [
    fact('网关', place(connection.gatewayUrl)),
    fact('管理', place(connection.managementUrl)),
    fact(
      '管理密钥',
      connection.keySet ? state('ok', '已封存') : state('bad', '未设置'),
    ),
    fact('网关侧', gateway === null ? absent() : state(gateway[0], gateway[1])),
    fact('核对', check === null ? absent() : timeTag(check.at, 'datetime')),
  ]
  const problem =
    snapshot.problem === null
      ? ''
      : `<p class="mg-problem">${state('bad', `读取 magpie 失败 · ${snapshot.problem.message}`)}</p>`
  return (
    `<section class="sec" aria-labelledby="h-mg-conn">${head}` +
    `<article class="card elev-sm mg-card"><div class="mg-facts">${facts.join('')}</div>` +
    `${problem}<footer class="mg-foot">${acts}</footer></article></section>`
  )
}

// --- upstreams ---------------------------------------------------------

/**
 * An empty list that was not read: before a connection, or while magpie
 * does not answer (the connection section says why). Null when the list
 * is magpie's own answer, so an empty one means there are none.
 */
function unread(snapshot: MagpieSnapshot, what: string): string | null {
  if (!snapshot.connection.configured)
    return emptyState('未连接', `连接 magpie 后列出${what}`)
  if (snapshot.problem !== null)
    return emptyState(`${what}读取失败`, 'magpie 没有应答 · 原因见连接一节')
  return null
}

const ACCESS_TAG: Readonly<Record<string, string>> = {
  key: tag('API 密钥', 'ok'),
  account: tag('订阅账号 · 阡陌不用', 'warn'),
  client: tag('客户端身份 · 阡陌不用', 'warn'),
}

function table(
  caption: string,
  headers: readonly string[],
  rows: readonly string[],
): string {
  const head = headers
    .map(name => `<th scope="col">${escapeHtml(name)}</th>`)
    .join('')
  return scroll(
    `<table class="trail mg-table"><caption class="sr-only">${escapeHtml(caption)}</caption>` +
      `<thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`,
  )
}

function providerRow(provider: MagpieProviderView, writer: boolean): string {
  const status = !provider.enabled
    ? state('muted', '已停用')
    : provider.ready
      ? state('ok', '可用')
      : state('warn', '未就绪')
  const acts =
    writer && provider.access === 'key'
      ? `<td class="acts"><span class="kit-acts">` +
        actionButton('magpie-provider-test', '测试', {
          tone: 'ghost',
          data: { id: provider.id, name: provider.name },
        }) +
        actionButton(
          'magpie-provider-toggle',
          provider.enabled ? '停用' : '启用',
          {
            tone: 'ghost',
            data: {
              id: provider.id,
              name: provider.name,
              enabled: provider.enabled ? '0' : '1',
            },
          },
        ) +
        actionButton('magpie-provider-remove', '删除', {
          tone: 'ghost',
          data: { id: provider.id, name: provider.name },
        }) +
        `</span></td>`
      : writer
        ? '<td class="acts"></td>'
        : ''
  return (
    `<tr data-key="${attr(provider.id)}">` +
    `<td><b>${escapeHtml(provider.name)}</b> ${mono(provider.id)}</td>` +
    `<td>${provider.host === '' ? absent() : mono(provider.host)}</td>` +
    `<td>${provider.models}</td>` +
    `<td>${status}</td>` +
    `<td>${ACCESS_TAG[provider.access] ?? ''}${provider.plan === null ? '' : ` ${tag(provider.plan)}`}</td>` +
    acts +
    `</tr>`
  )
}

function providersSection(snapshot: MagpieSnapshot, writer: boolean): string {
  const add = writer
    ? actionButton('magpie-provider-new', '添加上游', { glyph: 'plus' })
    : ''
  const rows = snapshot.providers
  const body =
    rows.length === 0
      ? (unread(snapshot, '上游') ??
        emptyState('还没有上游', '从 magpie 预设添加 · 只用 API 密钥', add))
      : table(
          '上游',
          ['名称', '主机', '模型', '状态', '类别', ...(writer ? [''] : [])],
          rows.map(one => providerRow(one, writer)),
        )
  return (
    `<section class="sec" aria-labelledby="h-mg-up">` +
    sectionHead('Upstreams', '上游', {
      headingId: 'h-mg-up',
      tail: `<div class="kit-row">${rows.length > 0 ? add : ''}</div>`,
    }) +
    body +
    `</section>`
  )
}

// --- routing groups ----------------------------------------------------

function groupRow(group: MagpieGroupView, writer: boolean): string {
  const members = [...group.members, ...group.match]
  const acts = writer
    ? `<td class="acts"><span class="kit-acts">` +
      actionButton('magpie-group-edit', '编辑', {
        tone: 'ghost',
        data: { id: group.id },
      }) +
      actionButton('magpie-group-remove', '删除', {
        tone: 'ghost',
        data: { id: group.id, name: group.name },
      }) +
      `</span></td>`
    : ''
  return (
    `<tr data-key="${attr(group.id)}">` +
    `<td><b>${escapeHtml(group.name)}</b> ${mono(`group/${group.id}`)}</td>` +
    `<td>${members.length === 0 ? absent() : mono(members.join(' · '))}` +
    (group.matched.length > 0
      ? ` <span class="note">匹配到 ${group.matched.length}</span>`
      : '') +
    `</td>` +
    `<td>${escapeHtml(ROUTING_WORD[group.routing] ?? group.routing)}</td>` +
    `<td>${escapeHtml(AFFINITY_WORD[group.affinity] ?? group.affinity)}</td>` +
    `<td>${
      group.eligible
        ? tag('API 密钥', 'ok')
        : tag('含订阅或客户端身份 · 阡陌不用', 'warn')
    }</td>` +
    acts +
    `</tr>`
  )
}

function groupsSection(snapshot: MagpieSnapshot, writer: boolean): string {
  const add = writer
    ? actionButton('magpie-group-new', '新建路由组', { glyph: 'plus' })
    : ''
  const rows = snapshot.groups
  const body =
    rows.length === 0
      ? (unread(snapshot, '路由组') ??
        emptyState(
          '还没有路由组',
          '把几个上游的模型编成一组 · 按规则分流',
          add,
        ))
      : table(
          '路由组',
          ['名称', '成员', '路由', '保持', '类别', ...(writer ? [''] : [])],
          rows.map(one => groupRow(one, writer)),
        )
  return (
    `<section class="sec" aria-labelledby="h-mg-groups">` +
    sectionHead('Routing groups', '路由组', {
      headingId: 'h-mg-groups',
      tail: `<div class="kit-row">${rows.length > 0 ? add : ''}</div>`,
    }) +
    body +
    `</section>`
  )
}

// --- gateway keys ------------------------------------------------------

function windowWord(limit: {
  readonly period: string
  readonly days: number | null
  readonly hours: number | null
}): string {
  if (limit.period === 'days') return `每 ${limit.days ?? 0} 天`
  if (limit.period === 'hours') return `每 ${limit.hours ?? 0} 小时`
  return LIMIT_WORD[limit.period] ?? limit.period
}

function limitLine(
  limit: MagpieLimitView,
  index: number,
  writer: boolean,
  key: string,
): string {
  const parts: string[] = []
  if (limit.tokens !== null)
    parts.push(
      `${compact(limit.tokensUsed ?? 0)}/${compact(limit.tokens)} token`,
    )
  if (limit.cost !== null)
    parts.push(`${dollars(limit.costUsed ?? 0)}/${dollars(limit.cost)}`)
  const text = `${windowWord(limit)} ${parts.join(' · ')}`
  const reset = writer
    ? actionButton('magpie-key-reset', '重新计数', {
        tone: 'ghost',
        data: { binding: key, index: String(index) },
      })
    : ''
  return `<div class="mg-limit">${limit.spent ? state('bad', `${text} · 已用完`) : escapeHtml(text)}${reset}</div>`
}

function keyRow(key: MagpieKeyView, writer: boolean): string {
  const id = bindingKeyOf(key.binding)
  const status =
    key.present === false
      ? state('bad', 'magpie 中已无此密钥')
      : key.enabled === null
        ? state('muted', '未知')
        : key.enabled
          ? state('ok', '启用')
          : state('muted', '已停用')
  const models =
    key.modelsMode === 'all'
      ? `合格的全部 · ${key.models.length} 条`
      : `指定 · ${key.models.length} 条`
  const acts = writer
    ? `<td class="acts"><span class="kit-acts">` +
      actionButton('magpie-key-edit', '编辑', {
        tone: 'ghost',
        data: { binding: id },
      }) +
      (key.enabled === null
        ? ''
        : actionButton('magpie-key-toggle', key.enabled ? '停用' : '启用', {
            tone: 'ghost',
            data: {
              binding: id,
              name: bindingWord(key.binding),
              enabled: key.enabled ? '0' : '1',
            },
          })) +
      actionButton('magpie-key-rotate', '轮换', {
        tone: 'ghost',
        data: { binding: id, name: bindingWord(key.binding) },
      }) +
      actionButton('magpie-key-remove', '收回', {
        tone: 'ghost',
        data: { binding: id, name: bindingWord(key.binding) },
      }) +
      `</span></td>`
    : ''
  return (
    `<tr data-key="${attr(id)}">` +
    `<td><b>${escapeHtml(bindingWord(key.binding))}</b> ${mono(key.profileId)}</td>` +
    `<td>${mono(key.mainModel)}${key.fastModel === null ? '' : ` · ${mono(key.fastModel)}`}` +
    ` <span class="note">${escapeHtml(LANE_WORD[key.lane] ?? key.lane)}</span></td>` +
    `<td>${escapeHtml(models)}</td>` +
    `<td>${
      key.limits.length === 0
        ? '<span class="note">不限</span>'
        : key.limits
            .map((limit, index) => limitLine(limit, index, writer, id))
            .join('')
    }</td>` +
    `<td>${status}</td>` +
    (writer
      ? `<td>${key.masked === null ? absent() : mono(key.masked)}</td>`
      : '') +
    acts +
    `</tr>`
  )
}

function keysSection(snapshot: MagpieSnapshot, writer: boolean): string {
  const add =
    writer && snapshot.connection.configured
      ? actionButton('magpie-key-new', '为节点签发', { glyph: 'plus' })
      : ''
  const rows = snapshot.keys
  const body =
    rows.length === 0
      ? emptyState(
          '还没有网关密钥',
          '每个节点一把 · 中枢签发并写进它的模型档案',
          add,
        )
      : table(
          '网关密钥',
          [
            '绑定',
            '模型',
            '白名单',
            '限额',
            '状态',
            ...(writer ? ['尾号', ''] : []),
          ],
          rows.map(one => keyRow(one, writer)),
        )
  return (
    `<section class="sec" aria-labelledby="h-mg-keys">` +
    sectionHead('Gateway keys', '网关密钥', {
      headingId: 'h-mg-keys',
      tail: `<div class="kit-row">${rows.length > 0 ? add : ''}</div>`,
    }) +
    body +
    `</section>`
  )
}

/** The polled body of the page: connection, upstreams, groups and keys. */
export function renderMagpie(model: MagpieModel): string {
  const side = model.side
  if (side.kind === 'unwired')
    return unwiredCard(
      '模型网关',
      '平台的 magpie 网关 · 节点拿中枢签发的密钥直连',
      'qm console … --accounts --providers --magpie',
    )
  if (side.kind === 'failed') return failureBar(side.failure, '模型网关')
  const snapshot = side.value
  return (
    connectionSection(snapshot, model.writer) +
    providersSection(snapshot, model.writer) +
    groupsSection(snapshot, model.writer) +
    keysSection(snapshot, model.writer)
  )
}

// --- usage -------------------------------------------------------------

function totalsLine(totals: MagpieUsageTotalsView): string {
  return [
    `调用 ${compact(totals.calls)}`,
    `失败 ${compact(totals.errors)}`,
    `输入 ${compact(totals.input)}`,
    `输出 ${compact(totals.output)}`,
    `缓存读 ${compact(totals.cacheRead)}`,
    `估算 ${dollars(totals.cost)}`,
  ].join(' · ')
}

function usageCells(row: MagpieUsageTotalsView): string {
  return (
    `<td>${compact(row.calls)}</td><td>${compact(row.input)}</td>` +
    `<td>${compact(row.output)}</td><td>${compact(row.cacheRead)}</td>` +
    `<td>${dollars(row.cost)}${row.unpriced > 0 ? ` <span class="note">另 ${row.unpriced} 次无价目</span>` : ''}</td>`
  )
}

const USAGE_HEAD = ['调用', '输入', '输出', '缓存读', '估算']

/** The usage section, one period. */
export function renderMagpieUsage(
  side: MagpieUsageSide,
  period: MagpieUsagePeriod,
): string {
  const seg = segmented(
    'magpie-period',
    '周期',
    (Object.keys(MAGPIE_PERIOD_WORD) as MagpieUsagePeriod[]).map(
      value => [value, MAGPIE_PERIOD_WORD[value]] as const,
    ),
    period,
  )
  const head = sectionHead('Usage', '用量', { headingId: 'h-mg-usage' })
  if (side.kind === 'unwired') return ''
  if (side.kind === 'failed')
    return (
      `<section class="sec" aria-labelledby="h-mg-usage">${head}${seg}` +
      failureBar(side.failure, '用量') +
      `</section>`
    )
  const usage = side.value
  const keys =
    usage.keys.length === 0
      ? ''
      : table(
          '按密钥',
          ['密钥', ...USAGE_HEAD],
          usage.keys.map(
            row =>
              `<tr data-key="${attr(row.keyId)}"><td>${
                row.binding === null
                  ? mono(row.name)
                  : `<b>${escapeHtml(bindingWord(row.binding))}</b>`
              }</td>${usageCells(row)}</tr>`,
          ),
        )
  const models =
    usage.models.length === 0
      ? ''
      : table(
          '按模型',
          ['模型', ...USAGE_HEAD],
          usage.models.map(
            row =>
              `<tr data-key="${attr(row.id)}"><td>${mono(row.id)}</td>${usageCells(row)}</tr>`,
          ),
        )
  return (
    `<section class="sec" aria-labelledby="h-mg-usage">${head}${seg}` +
    `<p class="mg-totals">${escapeHtml(totalsLine(usage.totals))}</p>` +
    `<p class="note">费用是 magpie 按它的价目估算 · 不是账单</p>` +
    (keys === '' && models === ''
      ? `<p class="note">这段时间没有调用</p>`
      : keys + models) +
    `</section>`
  )
}

// --- forms -------------------------------------------------------------

const SCHEMES: readonly (readonly [string, string])[] = [
  ['https', 'https'],
  ['http', 'http 仅本机回环'],
]

function originFields(
  prefix: 'gateway' | 'management',
  label: string,
  url: string | null,
  placeholder: string,
): string {
  const where = url === null ? null : placeOf(url)
  return (
    selectField(`${prefix}Scheme`, `${label}协议`, SCHEMES, {
      selected: where?.scheme ?? (prefix === 'gateway' ? 'https' : 'http'),
    }) +
    textField(`${prefix}Host`, `${label}主机与端口`, {
      required: true,
      mono: true,
      value: where?.host ?? '',
      placeholder,
    })
  )
}

function connectForm(snapshot: MagpieSnapshot): string {
  const { connection } = snapshot
  return (
    `<input type="hidden" name="form" value="connect">` +
    `<div class="form-grid">` +
    originFields(
      'gateway',
      '网关',
      connection.gatewayUrl,
      'gateway.example.cn',
    ) +
    originFields(
      'management',
      '管理',
      connection.managementUrl,
      '127.0.0.1:3430',
    ) +
    textField('managementKey', '管理密钥', {
      type: 'password',
      wide: true,
      mono: true,
      help: connection.keySet
        ? '不填沿用已封存的 · 即 MAGPIE_WEB_KEY'
        : '即 MAGPIE_WEB_KEY',
    }) +
    textField('webCookiePort', '管理页端口', {
      type: 'number',
      min: 1,
      max: 65535,
      help: '前面有反向代理时填 magpie 实际监听的端口',
    }) +
    `</div>`
  )
}

function providerForm(snapshot: MagpieSnapshot): string {
  return (
    `<input type="hidden" name="form" value="provider">` +
    `<div class="form-grid">` +
    selectField(
      'preset',
      '预设',
      [
        ...snapshot.presets.map(
          preset =>
            [
              preset.id,
              preset.noKey ? `${preset.name} · 无需密钥` : preset.name,
            ] as const,
        ),
        ['', '自定义地址'] as const,
      ],
      { wide: true },
    ) +
    textField('key', '上游 API 密钥', {
      type: 'password',
      wide: true,
      mono: true,
      help: '只交给 magpie · 中枢不留存',
    }) +
    textField('name', '名称', {
      maxLength: 80,
      help: '不填用预设名 · 自定义地址时必填',
    }) +
    textField('chat', 'Chat Completions 地址', {
      type: 'url',
      wide: true,
      mono: true,
      placeholder: 'https://api.example.cn/v1',
      help: '仅自定义地址 · 以 /v1 结尾',
    }) +
    textField('responses', 'Responses 地址', {
      type: 'url',
      wide: true,
      mono: true,
      placeholder: 'https://api.example.cn/v1',
      help: '仅自定义地址 · 以 /v1 结尾',
    }) +
    textField('anthropic', 'Anthropic Messages 地址', {
      type: 'url',
      wide: true,
      mono: true,
      placeholder: 'https://api.example.cn',
      help: '仅自定义地址 · 填源站 · 三项至少填一项',
    }) +
    `</div>`
  )
}

function groupForm(
  snapshot: MagpieSnapshot,
  group: MagpieGroupView | null,
): string {
  return (
    `<input type="hidden" name="form" value="group">` +
    `<input type="hidden" name="from" value="${attr(group?.id ?? '')}">` +
    `<div class="form-grid">` +
    textField('id', '路由组 id', {
      required: true,
      mono: true,
      value: group?.id ?? '',
      maxLength: 64,
      help: '小写字母 · 数字 · 点与连字符',
    }) +
    textField('name', '名称', { value: group?.name ?? '', maxLength: 80 }) +
    textArea('members', '成员', {
      value: (group?.members ?? []).join('\n'),
      rows: 5,
      help: '每行一个 provider/model 或 group/id',
    }) +
    selectField(
      'routing',
      '路由',
      Object.entries(ROUTING_WORD).map(([value, word]) => [value, word]),
      { selected: group?.routing ?? 'smart' },
    ) +
    selectField(
      'affinity',
      '会话保持',
      Object.entries(AFFINITY_WORD).map(([value, word]) => [value, word]),
      { selected: group?.affinity ?? 'auto' },
    ) +
    (snapshot.models.length > 0
      ? `<p class="note field-wide">可选 ${escapeHtml(snapshot.models.slice(0, 12).join(' · '))}${snapshot.models.length > 12 ? ' 等' : ''}</p>`
      : '') +
    `</div>`
  )
}

function limitRows(limits: readonly MagpieLimitView[]): string {
  const rows: string[] = []
  for (let index = 0; index < 5; index += 1) {
    const limit = limits[index]
    rows.push(
      `<div class="mg-limit-row" data-limit="${index}">` +
        selectField(
          `limitPeriod${index}`,
          `限额 ${index + 1}`,
          [
            ['', '不限'],
            ['day', '每天'],
            ['week', '每周'],
            ['month', '每月'],
            ['days', '每 N 天'],
            ['hours', '每 N 小时'],
          ],
          { selected: limit?.period ?? '' },
        ) +
        textField(`limitSpan${index}`, 'N', {
          type: 'number',
          min: 1,
          value: String(limit?.days ?? limit?.hours ?? ''),
        }) +
        textField(`limitTokens${index}`, 'token 上限', {
          type: 'number',
          min: 0,
          value:
            limit?.tokens === null || limit === undefined
              ? ''
              : String(limit.tokens),
        }) +
        textField(`limitCost${index}`, '费用上限 美元', {
          type: 'number',
          min: 0,
          value:
            limit?.cost === null || limit === undefined
              ? ''
              : String(limit.cost),
        }) +
        // Carried both ways: a limit saved from this form keeps counting
        // cache reads in its tokens when it did before.
        switchField(
          `limitCacheReads${index}`,
          'token 含缓存读',
          limit?.cacheReads === true,
        ) +
        `</div>`,
    )
  }
  return `<div class="field field-wide mg-limits"><span class="flabel">限额</span>${rows.join('')}<span class="note field-help">要启用 magpie 的预算插件才生效</span></div>`
}

/**
 * The model choices, with the key's own models first when they are not
 * among them (a provider switched off since, magpie not answering): the
 * form saved untouched sends the key back as it is, never the first choice.
 */
function modelChoices(
  choices: readonly string[],
  key: MagpieKeyView | null,
): (readonly [string, string])[] {
  const own = [key?.mainModel, key?.fastModel ?? undefined].filter(
    (model, index, all): model is string =>
      model !== undefined &&
      model !== '' &&
      !choices.includes(model) &&
      all.indexOf(model) === index,
  )
  return [
    ...own.map(model => [model, `${model} · 现用`] as const),
    ...choices.map(model => [model, model] as const),
  ]
}

function keyForm(snapshot: MagpieSnapshot, key: MagpieKeyView | null): string {
  const taken = new Set(snapshot.keys.map(one => bindingKeyOf(one.binding)))
  const choices: (readonly [string, string])[] = [
    ...snapshot.nodes.map(node => [`node:${node}`, `节点 ${node}`] as const),
    ...snapshot.tenants.map(
      tenant => [`tenant:${tenant}`, `租户 ${tenant}`] as const,
    ),
  ].filter(([value]) => !taken.has(value))
  const models = modelChoices(snapshot.models, key)
  const binding =
    key === null
      ? selectField('binding', '绑定', choices, { required: true, wide: true })
      : `<input type="hidden" name="binding" value="${attr(bindingKeyOf(key.binding))}">` +
        `<p class="field-wide"><b>${escapeHtml(bindingWord(key.binding))}</b> ${mono(key.profileId)}</p>`
  return (
    `<input type="hidden" name="form" value="key">` +
    `<input type="hidden" name="editing" value="${key === null ? '' : '1'}">` +
    `<div class="form-grid">` +
    binding +
    selectField('mainModel', '主模型', models, {
      required: true,
      selected: key?.mainModel ?? '',
    }) +
    selectField('fastModel', '快速模型', [['', '不设'], ...models], {
      selected: key?.fastModel ?? '',
    }) +
    (key === null
      ? selectField(
          'lane',
          '线路',
          Object.entries(LANE_WORD).map(([value, word]) => [value, word]),
          { selected: 'anthropic' },
        )
      : '') +
    textArea('models', '模型白名单', {
      value: key?.modelsMode === 'list' ? key.models.join('\n') : '',
      rows: 4,
      help: '每行一个 · 不填就是合格的全部 · 订阅账号与客户端身份的上游永远不在内',
    }) +
    limitRows(key?.limits ?? []) +
    `</div>`
  )
}

/** The dialog body for one form. */
export function renderMagpieForm(input: {
  readonly kind: 'connect' | 'provider' | 'group' | 'key'
  readonly snapshot: MagpieSnapshot
  readonly group?: MagpieGroupView | null
  readonly key?: MagpieKeyView | null
}): string {
  if (input.kind === 'connect') return connectForm(input.snapshot)
  if (input.kind === 'provider') return providerForm(input.snapshot)
  if (input.kind === 'group')
    return groupForm(input.snapshot, input.group ?? null)
  return keyForm(input.snapshot, input.key ?? null)
}

export function magpieDialogs(): string {
  return (
    `<dialog class="dialog mg-dialog" id="magpie-dialog" aria-labelledby="magpie-title">` +
    `<form id="magpie-form" novalidate>` +
    dialogTop('magpie-title', 'waypoints', '模型网关') +
    `<div class="dialog-body" id="magpie-body"></div>` +
    `<p class="note mg-status" id="magpie-status" role="status"></p>` +
    dialogActions('保存', { glyph: 'check' }) +
    `</form></dialog>` +
    `<dialog class="dialog" id="confirm-magpie" aria-labelledby="confirm-magpie-title">` +
    dialogTop('confirm-magpie-title', 'x', '确认') +
    `<div class="dialog-body"><div class="recap"><div class="recap-row"><span class="k">对象</span>` +
    `<span id="confirm-magpie-what"></span></div></div><p id="confirm-magpie-note"></p></div>` +
    dialogActions('确认', { danger: true, action: 'confirm-magpie' }) +
    `</dialog>`
  )
}

export const MAGPIE_PAGE_CSS = `
.mg-card { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); }
.mg-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 6px var(--space-4); }
.mg-fact { display: flex; justify-content: space-between; gap: var(--space-3); font-size: var(--text-13); min-width: 0; }
.mg-fact .kit-mono { overflow-wrap: anywhere; }
.mg-foot { display: flex; justify-content: flex-end; }
.mg-problem { margin: 0; }
.mg-table td { vertical-align: top; }
.mg-limit { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--text-13); }
.mg-totals { margin: 0; font-size: var(--text-13); }
.mg-limits { gap: var(--space-2); }
.mg-limit-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--space-2); }
.mg-status:empty { display: none; }
.mg-dialog .dialog-body { max-height: min(70vh, 680px); overflow: auto; }
`
