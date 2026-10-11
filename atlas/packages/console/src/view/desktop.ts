// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 云端电脑 (P21): each node's main agent may get a browser of its own, and on
 * Linux nodes with a virtual display, a computer of its own.
 *
 * One card per agent: two switches (浏览器, 电脑), how much to confirm, what
 * state the units are in, a recycle button; below, the last actions taken.
 * Operating a browser is the base's (omp's) ability; what this page manages
 * is qianmo's part — which agent gets one, what it must ask first, and
 * wiping it clean.
 */

import type { ConsoleFailure } from '../deps.js'
import type {
  DesktopActionView,
  DesktopConfirm,
  DesktopNodeView,
  DesktopUnitState,
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
import { formatBytes, formatRelative } from './format.js'
import { actionButton, dialogActions, dialogTop, emptyState } from './kit.js'

export interface DesktopModel {
  readonly units: readonly DesktopNodeView[]
  readonly actions: readonly DesktopActionView[] | null
  readonly now: number
  readonly ops: boolean
}

const STATE_WORD: Readonly<Record<DesktopUnitState, readonly [Tone, string]>> =
  {
    off: ['muted', '关着'],
    starting: ['warn', '启动中'],
    running: ['ok', '运行中'],
    failed: ['bad', '出错'],
  }

const CONFIRM_WORD: Readonly<Record<DesktopConfirm, string>> = {
  sensitive: '只看自动 · 其余逐次确认',
  always: '每一步都确认',
}

const PLATFORM_WORD: Readonly<Record<string, string>> = {
  linux: 'Linux',
  darwin: 'macOS',
  other: '其他系统',
}

const OUTCOME_WORD: Readonly<
  Record<DesktopActionView['outcome'], readonly [Tone, string]>
> = {
  allowed: ['ok', '自动放行'],
  confirmed: ['ok', '你批准的'],
  denied: ['warn', '被拒'],
  failed: ['bad', '失败'],
  intent: ['muted', '待执行'],
  unknown: ['warn', '结果未知'],
}

const OP_WORD: Readonly<Record<string, string>> = {
  screenshot: '截图',
  read_page: '读页面',
  find: '查元素',
  tabs: '看标签页',
  navigate: '打开网址',
  click: '点击',
  type: '输入',
  press: '按键',
  key: '按键',
  scroll: '滚动',
}

function keyOf(unit: DesktopNodeView): string {
  return `${unit.node}/${unit.agent}`
}

function unitSwitch(
  unit: DesktopNodeView,
  which: 'browser' | 'computer',
  ops: boolean,
): string {
  const on = which === 'browser' ? unit.browser.enabled : unit.computer.enabled
  const label = which === 'browser' ? '专属浏览器' : '专属电脑'
  // A node that cannot have a computer shows no switch for one: the note
  // under the switches says why.
  if (which === 'computer' && !unit.computer.supported) return ''
  if (!ops) {
    return (
      `<span class="dk-flag"><span>${label}</span>` +
      `${state(on ? 'ok' : 'muted', on ? '开' : '关')}</span>`
    )
  }
  const id = `dk-${which}-${unit.node}-${unit.agent}`
  return (
    `<label class="sw dk-sw" for="${attr(id)}"><input type="checkbox" id="${attr(id)}" ` +
    `data-desktop-unit="${which}" data-node="${attr(unit.node)}" data-agent="${attr(unit.agent)}"` +
    `${on ? ' checked' : ''}${unit.reachable ? '' : ' disabled'} data-write>` +
    `<span class="trk"></span><span>${label}</span></label>`
  )
}

function noComputer(unit: DesktopNodeView): string {
  if (unit.computer.supported) return ''
  return `<p class="note dk-nocomp">${
    unit.platform === 'darwin'
      ? 'macOS 节点只提供浏览器 · 不操作真实桌面'
      : '这个节点没有虚拟显示 · 只提供浏览器'
  }</p>`
}

function unitState(
  label: string,
  unitStateValue: DesktopUnitState,
  reason: string | null,
  extra: string,
): string {
  const [tone, word] = STATE_WORD[unitStateValue]
  return (
    `<div class="dk-state"><span class="note">${escapeHtml(label)}</span>` +
    `<span${reason === null ? '' : ` title="${attr(reason)}"`}>${state(tone, word)}</span>` +
    `${extra}</div>`
  )
}

function confirmPicker(unit: DesktopNodeView, ops: boolean): string {
  if (!ops) {
    return `<span class="note">${escapeHtml(CONFIRM_WORD[unit.confirm])}</span>`
  }
  const name = `dk-confirm-${unit.node}-${unit.agent}`
  return (
    `<div class="seg dk-confirm" role="radiogroup" aria-label="确认">` +
    (['sensitive', 'always'] as const)
      .map(
        value =>
          `<label class="seg-opt"><input type="radio" name="${attr(name)}" value="${value}" ` +
          `data-desktop-confirm data-node="${attr(unit.node)}" data-agent="${attr(unit.agent)}"` +
          `${unit.confirm === value ? ' checked' : ''}${unit.reachable ? '' : ' disabled'} data-write>` +
          `${escapeHtml(CONFIRM_WORD[value])}</label>`,
      )
      .join('') +
    `</div>`
  )
}

function unitCard(unit: DesktopNodeView, model: DesktopModel): string {
  const anyOn = unit.browser.enabled || unit.computer.enabled
  const live =
    unit.browser.state === 'running' || unit.computer.state === 'running'
  const head =
    `<header class="dk-head"><span class="dk-screen${live ? ' dk-live' : ''}">${icon('monitor')}</span>` +
    `<div class="dk-title"><b>${escapeHtml(unit.agent)}</b>` +
    `<span class="note">${escapeHtml(unit.node)}${
      unit.platform === null
        ? ''
        : ` · ${escapeHtml(PLATFORM_WORD[unit.platform] ?? unit.platform)}`
    }</span></div>` +
    (unit.reachable ? '' : state('muted', '连不上')) +
    `</header>`
  const profile =
    unit.browser.profileBytes === null
      ? ''
      : `<span class="note">资料 ${escapeHtml(formatBytes(unit.browser.profileBytes))}</span>`
  const display =
    unit.computer.display === null
      ? ''
      : `<span class="note kit-mono">${escapeHtml(unit.computer.display)}</span>`
  const states =
    `<div class="dk-states">` +
    unitState('浏览器', unit.browser.state, unit.browser.reason, profile) +
    (unit.computer.supported
      ? unitState('电脑', unit.computer.state, unit.computer.reason, display)
      : '') +
    `</div>`
  const activity =
    unit.lastActionAt === null
      ? `<span class="note">还没有操作</span>`
      : `<span class="note">24 小时 ${escapeHtml(String(unit.actions24h))} 次操作 · ${escapeHtml(
          String(unit.confirmed24h),
        )} 次经你批准 · 最近 ${escapeHtml(formatRelative(unit.lastActionAt, model.now))}</span>`
  const recycle =
    model.ops && anyOn
      ? actionButton('desktop-recycle', '清空回收', {
          tone: 'ghost',
          data: { node: unit.node, agent: unit.agent },
        })
      : ''
  return (
    `<article class="card elev-sm dk-card${anyOn ? ' dk-on' : ''}" data-key="${attr(keyOf(unit))}">` +
    head +
    `<div class="dk-switches">${unitSwitch(unit, 'browser', model.ops)}${unitSwitch(unit, 'computer', model.ops)}</div>` +
    noComputer(unit) +
    states +
    `<div class="dk-field"><span class="flabel">确认</span>${confirmPicker(unit, model.ops)}</div>` +
    `<footer class="dk-foot">${activity}${recycle}</footer>` +
    `</article>`
  )
}

function actionsTable(
  actions: readonly DesktopActionView[],
  now: number,
): string {
  if (actions.length === 0) return `<p class="note">还没有操作记录</p>`
  const head = ['时间', '智能体', '对象', '操作', '目标', '结果']
    .map(name => `<th scope="col">${escapeHtml(name)}</th>`)
    .join('')
  const rows = actions
    .map(one => {
      const [tone, word] = OUTCOME_WORD[one.outcome]
      return (
        `<tr><td class="when"><span class="note">${escapeHtml(formatRelative(one.at, now))}</span></td>` +
        `<td>${escapeHtml(`${one.agent} · ${one.node}`)}</td>` +
        `<td>${one.unit === 'browser' ? '浏览器' : '电脑'}</td>` +
        `<td>${escapeHtml(OP_WORD[one.op] ?? one.op)}</td>` +
        `<td>${one.host === null ? absent() : `<span class="kit-mono">${escapeHtml(one.host)}</span>`}</td>` +
        `<td>${state(tone, word)}</td></tr>`
      )
    })
    .join('')
  return scroll(
    `<table class="trail dk-actions"><caption class="sr-only">最近的操作</caption>` +
      `<thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`,
  )
}

/** The polled body: the cards, then the recent actions. */
export function renderDesktop(model: DesktopModel): string {
  const cards =
    model.units.length === 0
      ? emptyState(
          '还没有能用云端电脑的智能体',
          '节点接上控制链路后 · 它的主智能体会出现在这里',
        )
      : `<div class="dk-grid">${model.units.map(one => unitCard(one, model)).join('')}</div>`
  return (
    `<section class="sec" aria-labelledby="h-desk">` +
    sectionHead('Desktops', '专属浏览器与电脑', {
      headingId: 'h-desk',
      tail: `<span class="note">浏览与操作能力来自基座 · 阡陌管分配 授权与回收</span>`,
    }) +
    cards +
    `</section>` +
    `<section class="sec" aria-labelledby="h-desk-actions">` +
    sectionHead('Actions', '最近的操作', {
      headingId: 'h-desk-actions',
      tail: `<span class="note">只记操作类别与主机名 · 不记输入的内容</span>`,
    }) +
    (model.actions === null
      ? `<p class="note">操作记录暂时读不到</p>`
      : actionsTable(model.actions, model.now)) +
    `</section>`
  )
}

export function renderDesktopFailure(failure: ConsoleFailure): string {
  return failureBar(failure, '云端电脑')
}

export function desktopConfirms(): string {
  const id = 'confirm-desktop-recycle'
  return (
    `<dialog class="dialog" id="${id}" aria-labelledby="${id}-title">` +
    dialogTop(`${id}-title`, 'x', '清空回收') +
    `<div class="dialog-body"><div class="recap"><div class="recap-row"><span class="k">智能体</span>` +
    `<span id="${id}-name"></span></div></div>` +
    `<p>停掉浏览器和电脑 · 删除它的资料目录 登录状态 下载与截图 · 删除后不能恢复</p></div>` +
    dialogActions('清空回收', { danger: true, action: id }) +
    `</dialog>`
  )
}

export const DESKTOP_PAGE_CSS = `
.dk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 330px), 1fr)); gap: var(--space-3); }
.dk-card { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); }
.dk-head { display: flex; align-items: center; gap: var(--space-3); }
.dk-title { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.dk-title b { font-size: var(--text-14, 14px); }
.dk-screen { position: relative; display: inline-grid; place-items: center; width: 38px; height: 38px; border-radius: 12px; background: var(--color-bg); color: var(--color-muted); flex: none; }
.dk-screen.dk-live { color: var(--color-accent); }
.dk-screen.dk-live::after { content: ''; position: absolute; right: 5px; top: 5px; width: 7px; height: 7px; border-radius: 50%; background: var(--color-ok, #6f8f5f); box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-ok, #6f8f5f) 60%, transparent); animation: dk-pulse 2.4s ease-out infinite; }
@keyframes dk-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-ok, #6f8f5f) 55%, transparent); } 70%, 100% { box-shadow: 0 0 0 7px transparent; } }
@media (prefers-reduced-motion: reduce) { .dk-screen.dk-live::after { animation: none; } }
.dk-switches { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-6); }
.dk-flag { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--text-13); }
.dk-nocomp { margin-top: calc(var(--space-2) * -1); font-size: var(--text-12); }
.dk-states { display: flex; flex-direction: column; gap: 6px; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--color-bg); }
.dk-state { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-13); }
.dk-state > .note:first-child { width: 4em; }
.dk-field { display: flex; flex-direction: column; gap: 6px; }
.dk-confirm .seg-opt { font-size: var(--text-12-5); }
.dk-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; margin-top: auto; }
.dk-card:not(.dk-on) .dk-states { opacity: .7; }
`
