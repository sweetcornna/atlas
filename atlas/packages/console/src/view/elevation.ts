// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 权限模式 (P39, `docs/dev/elevation.md`): how much one agent may do without
 * asking, per agent, for a bounded time.
 *
 * One card per agent: the four modes as one segmented choice, what the
 * current grant has left (expiry, calls), whether the node can sandbox
 * commands, and 收回. Choosing a mode other than 人工确认 opens a dialog for
 * the duration and the call budget; 人工确认 switches off at once. 全部收回
 * sits above the cards. Below: the recent elevated calls, without arguments.
 */

import type { ConsoleFailure } from '../deps.js'
import type {
  ElevationActionView,
  ElevationNodeView,
  ElevationTierName,
} from '../directionPorts.js'
import {
  absent,
  failureBar,
  icon,
  scroll,
  sectionHead,
  state,
  type Tone,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatRelative } from './format.js'
import {
  actionButton,
  dialogActions,
  dialogTop,
  emptyState,
  selectField,
  textField,
} from './kit.js'

export interface ElevationModel {
  readonly agents: readonly ElevationNodeView[]
  readonly actions: readonly ElevationActionView[] | null
  readonly now: number
  readonly ops: boolean
}

/** The mode names, as the page shows them (Claude Code's four modes). */
const ELEVATION_TIER_WORD: Readonly<Record<ElevationTierName, string>> = {
  off: '人工确认',
  'accept-edits': '自动接受编辑',
  auto: '自动审批',
  'full-access': '跳过权限确认',
}

/** One line under each mode: what runs without asking. */
const ELEVATION_TIER_NOTE: Readonly<Record<ElevationTierName, string>> = {
  off: '有后果的操作逐次确认',
  'accept-edits': '工作区编辑直接执行 · 命令 联网 GitHub 逐次确认',
  auto: '沙箱命令 编辑 联网读取直接执行 · GitHub 写操作逐次确认',
  'full-access': '不再逐次确认 · 红线与云端电脑「每一步都确认」照旧',
}

const TIERS: readonly ElevationTierName[] = [
  'off',
  'accept-edits',
  'auto',
  'full-access',
]

const OUTCOME_WORD: Readonly<
  Record<ElevationActionView['outcome'], readonly [Tone, string]>
> = {
  allowed: ['ok', '放行'],
  refused: ['warn', '被拒'],
  completed: ['ok', '完成'],
  failed: ['bad', '失败'],
}

const CLASS_WORD: Readonly<Record<ElevationActionView['cls'], string>> = {
  local: '本机',
  'read-out': '联网读取',
  'act-out': '对外写入',
}

function keyOf(one: ElevationNodeView): string {
  return `${one.node}/${one.agent}`
}

function tierPicker(one: ElevationNodeView, ops: boolean): string {
  if (!ops)
    return `<span class="note">${escapeHtml(ELEVATION_TIER_WORD[one.tier])}</span>`
  const blocked = !one.reachable || (one.unsupportedReason ?? null) !== null
  const name = `el-tier-${one.node}-${one.agent}`
  return (
    `<div class="seg el-tiers" role="radiogroup" aria-label="权限模式">` +
    TIERS.map(
      tier =>
        `<label class="seg-opt" title="${attr(ELEVATION_TIER_NOTE[tier])}"><input type="radio" name="${attr(name)}" value="${tier}" ` +
        `data-elevation-tier data-node="${attr(one.node)}" data-agent="${attr(one.agent)}"` +
        `${one.tier === tier ? ' checked' : ''}${blocked && tier !== 'off' ? ' disabled' : ''} data-write>` +
        `${escapeHtml(ELEVATION_TIER_WORD[tier])}</label>`,
    ).join('') +
    `</div>`
  )
}

function fact(label: string, value: string): string {
  return (
    `<div class="el-fact"><span class="note">${escapeHtml(label)}</span>` +
    `<span class="el-fact-v">${value}</span></div>`
  )
}

function grantFacts(one: ElevationNodeView, now: number): string {
  const live = one.tier !== 'off'
  const rows = [
    fact(
      '命令',
      one.sandbox
        ? state('ok', '沙箱内执行 · 无网络')
        : `<span title="${attr(one.sandboxReason ?? '')}">${state('muted', '不提供')}</span>`,
    ),
  ]
  if (one.github === false)
    rows.push(
      fact(
        'GitHub',
        `<span title="节点上没有 gh">${state('muted', '不提供')}</span>`,
      ),
    )
  if (live) {
    rows.push(
      fact(
        '到期',
        one.expiresAt === null
          ? absent()
          : escapeHtml(formatRelative(one.expiresAt, now)),
      ),
      fact(
        '次数',
        `${escapeHtml(String(one.usedCalls))} / ${escapeHtml(String(one.maxCalls))}`,
      ),
    )
    if (one.enabledBy !== null)
      rows.push(
        fact(
          '开启人',
          `<span class="kit-mono">${escapeHtml(one.enabledBy)}</span>`,
        ),
      )
  }
  return `<div class="el-facts">${rows.join('')}</div>`
}

function agentCard(one: ElevationNodeView, model: ElevationModel): string {
  const live = one.tier !== 'off'
  const head =
    `<header class="el-head"><span class="el-mark${live ? ' el-live' : ''}">${icon('shield')}</span>` +
    `<div class="el-title"><b>${escapeHtml(one.agent)}</b>` +
    `<span class="note">${escapeHtml(one.node)}</span></div>` +
    (one.reachable ? '' : state('muted', '连不上')) +
    `</header>`
  const unsupported =
    (one.unsupportedReason ?? null) === null
      ? ''
      : `<p class="note el-why">${escapeHtml(one.unsupportedReason ?? '')}</p>`
  const revoke =
    model.ops && live
      ? actionButton('elevation-revoke', '收回', {
          tone: 'danger',
          data: { node: one.node, agent: one.agent },
        })
      : ''
  const activity = `<span class="note">24 小时 ${escapeHtml(String(one.actions24h))} 次高权限调用</span>`
  return (
    `<article class="card elev-sm el-card${live ? ' el-on' : ''}" data-key="${attr(keyOf(one))}">` +
    head +
    `<div class="el-field"><span class="flabel">权限模式</span>${tierPicker(one, model.ops)}` +
    `<span class="note">${escapeHtml(ELEVATION_TIER_NOTE[one.tier])}</span></div>` +
    unsupported +
    grantFacts(one, model.now) +
    `<footer class="el-foot">${activity}${revoke}</footer>` +
    `</article>`
  )
}

function actionsTable(
  actions: readonly ElevationActionView[],
  now: number,
): string {
  if (actions.length === 0) return `<p class="note">还没有高权限调用</p>`
  const head = ['时间', '智能体', '工具', '类别', '目标', '经批准', '结果']
    .map(name => `<th scope="col">${escapeHtml(name)}</th>`)
    .join('')
  const rows = actions
    .map(one => {
      const [tone, word] = OUTCOME_WORD[one.outcome]
      const target = one.op ?? one.host
      return (
        `<tr><td class="when"><span class="note">${escapeHtml(formatRelative(one.at, now))}</span></td>` +
        `<td>${escapeHtml(`${one.agent} · ${one.node}`)}</td>` +
        `<td><span class="kit-mono">${escapeHtml(one.tool)}</span></td>` +
        `<td>${escapeHtml(CLASS_WORD[one.cls] ?? one.cls)}</td>` +
        `<td>${target === null ? absent() : `<span class="kit-mono">${escapeHtml(target)}</span>`}</td>` +
        `<td>${one.approved ? '是' : '否'}</td>` +
        `<td>${state(tone, word)}</td></tr>`
      )
    })
    .join('')
  return scroll(
    `<table class="trail el-actions"><caption class="sr-only">最近的高权限调用</caption>` +
      `<thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`,
  )
}

/** The polled body: the cards, then the recent calls. */
export function renderElevation(model: ElevationModel): string {
  const anyLive = model.agents.some(one => one.tier !== 'off')
  const cards =
    model.agents.length === 0
      ? emptyState(
          '还没有可放权的智能体',
          '节点接上控制链路后 · 它的智能体会出现在这里',
        )
      : `<div class="el-grid">${model.agents.map(one => agentCard(one, model)).join('')}</div>`
  const revokeAll =
    model.ops && anyLive
      ? actionButton('elevation-revoke-all', '全部收回', { tone: 'danger' })
      : ''
  return (
    `<section class="sec" aria-labelledby="h-elev">` +
    sectionHead('Permissions', '权限模式', {
      headingId: 'h-elev',
      tail: revokeAll,
    }) +
    cards +
    `</section>` +
    `<section class="sec" aria-labelledby="h-elev-actions">` +
    sectionHead('Actions', '最近的高权限调用', {
      headingId: 'h-elev-actions',
      tail: `<span class="note">只记工具 类别 目标与摘要 · 不记命令与网页内容</span>`,
    }) +
    (model.actions === null
      ? `<p class="note">调用记录暂时读不到</p>`
      : actionsTable(model.actions, model.now)) +
    `</section>`
  )
}

export function renderElevationFailure(failure: ConsoleFailure): string {
  return failureBar(failure, '权限模式')
}

/** The ops-only dialogs: a mode's duration and budget, revoke, revoke all. */
export function elevationDialogs(): string {
  const revoke = 'confirm-elevation-revoke'
  const all = 'confirm-elevation-revoke-all'
  return (
    `<dialog class="dialog" id="elevation-grant" aria-labelledby="elevation-grant-title">` +
    `<form id="elevation-grant-form" novalidate>` +
    dialogTop('elevation-grant-title', 'shield', '切换权限模式') +
    `<div class="dialog-body"><div class="recap">` +
    `<div class="recap-row"><span class="k">智能体</span><span id="elevation-grant-name"></span></div>` +
    `<div class="recap-row"><span class="k">模式</span><span id="elevation-grant-tier"></span></div></div>` +
    `<p class="note" id="elevation-grant-note"></p>` +
    selectField(
      'ttl',
      '生效时长',
      [
        ['900000', '15 分钟'],
        ['3600000', '1 小时'],
        ['7200000', '2 小时'],
        ['28800000', '8 小时'],
        ['86400000', '24 小时'],
      ],
      { selected: '7200000', help: '到期自动回到人工确认' },
    ) +
    textField('maxCalls', '次数上限', {
      type: 'number',
      min: 1,
      max: 2000,
      value: '200',
      help: '1–2000 · 用尽自动回到人工确认',
    }) +
    `</div>` +
    dialogActions('开启', { glyph: 'check' }) +
    `</form></dialog>` +
    `<dialog class="dialog" id="${revoke}" aria-labelledby="${revoke}-title">` +
    dialogTop(`${revoke}-title`, 'x', '收回') +
    `<div class="dialog-body"><div class="recap"><div class="recap-row"><span class="k">智能体</span>` +
    `<span id="${revoke}-name"></span></div></div>` +
    `<p>立即回到人工确认 · 正在执行的回合会被中止 · 待批的高权限审批作废</p></div>` +
    dialogActions('收回', { danger: true, action: revoke }) +
    `</dialog>` +
    `<dialog class="dialog" id="${all}" aria-labelledby="${all}-title">` +
    dialogTop(`${all}-title`, 'x', '全部收回') +
    `<div class="dialog-body"><p>所有已放权的智能体立即回到人工确认 · 正在执行的回合会被中止</p></div>` +
    dialogActions('全部收回', { danger: true, action: all }) +
    `</dialog>`
  )
}

export const ELEVATION_PAGE_CSS = `
.el-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: var(--space-3); }
.el-card { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); }
.el-head { display: flex; align-items: center; gap: var(--space-3); }
.el-title { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.el-title b { font-size: var(--text-14, 14px); }
.el-mark { display: inline-grid; place-items: center; width: 38px; height: 38px; border-radius: 12px; background: var(--color-bg); color: var(--color-muted); flex: none; }
.el-mark.el-live { color: var(--color-accent-2); }
.el-field { display: flex; flex-direction: column; gap: 6px; }
.el-tiers { flex-direction: column; border-radius: var(--radius-md); }
.el-tiers .seg-opt { font-size: var(--text-12-5); }
.el-tiers .seg-opt + .seg-opt { border-left: 0; border-top: 1px solid var(--color-divider); }
.el-why { margin: 0; font-size: var(--text-12); }
.el-facts { display: flex; flex-direction: column; gap: 6px; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--color-bg); }
.el-fact { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-13); min-height: 22px; }
.el-fact > .note:first-child { width: 4.5em; flex: none; }
.el-fact-v { display: flex; align-items: center; gap: var(--space-2); min-width: 0; flex: 1; }
.el-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; margin-top: auto; }
`
