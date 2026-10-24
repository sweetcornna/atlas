// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 更新 (P31): when the hub checks for new versions of qianmopi, Claude Code,
 * Codex and qianmo itself, what it does about each, and what it found.
 */

import type { ConsoleFailure } from '../deps.js'
import type {
  UpdateRunView,
  UpdateSourceView,
  UpdatesSnapshot,
  UpdateTime,
  UpgradeJobView,
} from '../directionPorts.js'
import { failureBar, scroll, sectionHead, state, timeTag } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import {
  actionButton,
  checkGroup,
  dialogActions,
  dialogTop,
  segmented,
  selectField,
  textField,
  unwiredCard,
} from './kit.js'
import { WEEKDAY, zoneChoices } from './schedules.js'

export type UpdatesSide =
  | { readonly kind: 'ok'; readonly value: UpdatesSnapshot }
  | { readonly kind: 'failed'; readonly failure: ConsoleFailure }
  | { readonly kind: 'unwired' }

export interface UpdatesModel {
  readonly side: UpdatesSide
  /** May change the settings and start a check (ops level). */
  readonly ops: boolean
}

function timeText(time: UpdateTime): string {
  return time.kind === 'daily'
    ? `每天 ${time.time}`
    : `${time.days.map(day => `周${WEEKDAY[day - 1] ?? day}`).join(' ')} ${time.time}`
}

function sourceState(source: UpdateSourceView): string {
  if (source.error !== null) return state('bad', source.error)
  if (source.checkedAt === null) return state('muted', '未检查')
  if (source.latest === null) return state('muted', '未知')
  const behind =
    source.nodes.length > 0
      ? source.nodes.some(one => one.version !== source.latest)
      : source.current !== source.latest
  return behind ? state('warn', '有新版本') : state('ok', '已是最新')
}

function nodeLine(
  node: UpdateSourceView['nodes'][number],
  source: UpdateSourceView['id'],
): string {
  const how =
    source === 'qianmo'
      ? node.managed
        ? '可在线升级'
        : '源码运行'
      : node.pinned
        ? '启动参数指定'
        : node.managed
          ? '阡陌安装'
          : '机器自带'
  return (
    `<span class="up-node"><span class="kit-mono">${escapeHtml(node.node)}</span>` +
    `<span class="kit-mono">${escapeHtml(node.version ?? '未安装')}</span>` +
    `<span class="note">${how}</span></span>`
  )
}

function sourceRow(source: UpdateSourceView): string {
  const current =
    source.nodes.length > 0
      ? `<span class="up-nodes">${source.nodes.map(one => nodeLine(one, source.id)).join('')}</span>`
      : `<span class="kit-mono">${escapeHtml(source.current ?? '—')}</span>`
  return (
    `<tr data-key="${attr(source.id)}">` +
    `<th scope="row">${escapeHtml(source.name)}</th>` +
    `<td>${current}</td>` +
    `<td><span class="kit-mono">${escapeHtml(source.latest ?? '—')}</span></td>` +
    `<td>${sourceState(source)}</td>` +
    `<td>${source.action === 'auto' ? '自动处理' : '只通知'}</td>` +
    `<td class="when">${source.checkedAt === null ? '<span class="note">—</span>' : timeTag(source.checkedAt, 'datetime')}</td>` +
    `</tr>`
  )
}

const OUTCOME: Readonly<
  Record<
    UpdateRunView['outcome'],
    readonly ['ok' | 'warn' | 'bad' | 'muted', string]
  >
> = {
  current: ['ok', '已是最新'],
  available: ['warn', '有新版本'],
  dispatched: ['ok', '已触发同步'],
  installed: ['ok', '已安装'],
  failed: ['bad', '失败'],
}

function historyRow(snapshot: UpdatesSnapshot, run: UpdateRunView): string {
  const [tone, word] = OUTCOME[run.outcome]
  const name =
    snapshot.sources.find(one => one.id === run.source)?.name ?? run.source
  return (
    `<tr>` +
    `<td class="when">${timeTag(run.at, 'datetime')}</td>` +
    `<td>${escapeHtml(name)}</td>` +
    `<td><span class="kit-mono">${escapeHtml(run.current ?? '—')} → ${escapeHtml(run.latest ?? '—')}</span></td>` +
    `<td>${state(tone, word)}</td>` +
    `<td>${run.detail === null ? '' : `<span class="note">${escapeHtml(run.detail)}</span>`}` +
    `${run.trigger === 'manual' ? ' <span class="note">· 手动</span>' : ''}</td>` +
    `</tr>`
  )
}

const STEP: Readonly<
  Record<
    UpgradeJobView['steps'][number]['state'],
    readonly ['ok' | 'warn' | 'bad' | 'muted', string]
  >
> = {
  pending: ['muted', '未开始'],
  upgrading: ['warn', '进行中'],
  done: ['ok', '完成'],
  skipped: ['muted', '跳过'],
  failed: ['bad', '失败'],
}

function jobCard(job: UpgradeJobView): string {
  const what = job.kind === 'upgrade' ? '升级' : '回滚'
  const head =
    job.state === 'running'
      ? state('warn', `${what}进行中`)
      : job.state === 'done'
        ? state('ok', `${what}完成`)
        : state('bad', `${what}失败`)
  return (
    `<div class="card up-job" data-job-state="${attr(job.state)}">` +
    `<div class="kit-row">${head}<span class="kit-mono">${escapeHtml(job.target ?? '本机备份')}</span>` +
    `<span class="note">${timeTag(job.startedAt, 'datetime')}</span></div>` +
    `<ol class="up-steps">${job.steps
      .map(step => {
        const [tone, word] = STEP[step.state]
        return (
          `<li><span class="kit-mono">${escapeHtml(step.node === 'hub' ? '中枢' : step.node)}</span>${state(tone, word)}` +
          (step.detail === null
            ? ''
            : `<span class="note">${escapeHtml(step.detail)}</span>`) +
          `</li>`
        )
      })
      .join('')}</ol></div>`
  )
}

/** qianmo itself: the hub's version, the rolling upgrade and the way back. */
function qianmoPanel(snapshot: UpdatesSnapshot, ops: boolean): string {
  const source = snapshot.sources.find(one => one.id === 'qianmo')
  const latest = source?.latest ?? null
  const running = snapshot.upgrade?.state === 'running'
  const acts =
    ops && !running
      ? `<span class="kit-acts">` +
        (latest !== null
          ? actionButton('updates-upgrade', `升级到 ${latest}`, {
              glyph: 'arrow-up',
              data: { version: latest },
            })
          : '') +
        (snapshot.hub.backup !== null || snapshot.rollbackVersions.length > 0
          ? actionButton('updates-rollback', '回滚', {
              tone: 'ghost',
              glyph: 'history',
            })
          : '') +
        `</span>`
      : ''
  return (
    `<section class="sec" aria-labelledby="h-qianmo-upgrade">` +
    sectionHead('Upgrade', '阡陌升级', {
      headingId: 'h-qianmo-upgrade',
      sub: true,
      tail:
        `<div class="kit-row"><span class="note">中枢 ${escapeHtml(snapshot.hub.version)}` +
        `${snapshot.hub.upgradable ? '' : ' · 源码运行'}` +
        `${snapshot.hub.backup === null ? '' : ` · 备份 ${escapeHtml(snapshot.hub.backup)}`}</span>${acts}</div>`,
    }) +
    `<p class="note">逐台进行 · 中枢最后 · 核对后等在途工作做完再替换 · 一台失败即停</p>` +
    (snapshot.upgrade === null ? '' : jobCard(snapshot.upgrade)) +
    `</section>`
  )
}

function table(caption: string, head: readonly string[], rows: string): string {
  return scroll(
    `<table class="trail up-table"><caption class="sr-only">${escapeHtml(caption)}</caption>` +
      `<thead><tr>${head.map(one => `<th scope="col">${escapeHtml(one)}</th>`).join('')}</tr></thead>` +
      `<tbody>${rows}</tbody></table>`,
  )
}

/** The polled body of the page. */
export function renderUpdates(model: UpdatesModel): string {
  const side = model.side
  if (side.kind === 'unwired')
    return unwiredCard(
      '更新检查',
      '定时检查 qianmopi · Claude Code · Codex · 阡陌的新版本',
      'qm console … --updates',
    )
  if (side.kind === 'failed') return failureBar(side.failure, '更新检查')
  const snapshot = side.value
  const acts = model.ops
    ? `<span class="kit-acts">` +
      actionButton('updates-edit', '设定', {
        tone: 'ghost',
        glyph: 'calendar-clock',
      }) +
      actionButton('updates-run', snapshot.running ? '检查中' : '立即检查', {
        glyph: 'refresh-cw',
        ...(snapshot.running ? { data: { busy: '1' } } : {}),
      }) +
      `</span>`
    : ''
  const when =
    snapshot.times.length === 0
      ? '未设检查时间'
      : `${snapshot.times.map(timeText).join(' · ')} · ${snapshot.timezone}`
  const next =
    snapshot.nextAt === null
      ? ''
      : `<span class="note">下次 ${timeTag(snapshot.nextAt, 'datetime')}</span>`
  const history =
    snapshot.history.length === 0
      ? '<p class="note">还没有检查记录</p>'
      : table(
          '检查记录',
          ['时间', '来源', '版本', '结果', '说明'],
          snapshot.history.map(run => historyRow(snapshot, run)).join(''),
        )
  return (
    `<section class="sec" aria-labelledby="h-updates">` +
    sectionHead('Updates', '版本', {
      headingId: 'h-updates',
      tail: `<div class="kit-row"><span class="note">${escapeHtml(when)}</span>${next}${acts}</div>`,
    }) +
    table(
      '版本',
      ['来源', '当前', '最新', '状态', '动作', '检查于'],
      snapshot.sources.map(sourceRow).join(''),
    ) +
    `</section>` +
    qianmoPanel(snapshot, model.ops) +
    `<section class="sec" aria-labelledby="h-update-history">` +
    sectionHead('History', '检查记录', {
      headingId: 'h-update-history',
      sub: true,
    }) +
    history +
    `</section>`
  )
}

/** The settings form body, filled with the current settings. */
export function renderUpdatesForm(snapshot: UpdatesSnapshot): string {
  const times = [...new Set(snapshot.times.map(one => one.time))].join(', ')
  const days = [
    ...new Set(
      snapshot.times.flatMap(one => (one.kind === 'weekly' ? one.days : [])),
    ),
  ].map(String)
  const zones = zoneChoices()
  const choices = zones.some(([zone]) => zone === snapshot.timezone)
    ? zones
    : [[snapshot.timezone, snapshot.timezone] as const, ...zones]
  return (
    `<div class="form-grid">` +
    textField('times', '检查时间', {
      mono: true,
      value: times,
      placeholder: '08:00, 20:00',
      help: '24 小时制 · 逗号分隔 · 留空不定时检查',
    }) +
    selectField('timezone', '时区', choices, { selected: snapshot.timezone }) +
    `</div>` +
    checkGroup(
      'days',
      '星期',
      WEEKDAY.map((day, index) => [String(index + 1), `周${day}`] as const),
      days,
      '不选就每天',
    ) +
    snapshot.sources
      .filter(one => one.autoAvailable)
      .map(one =>
        segmented(
          `action-${one.id}`,
          one.name,
          [
            ['notify', '只通知'],
            ['auto', '自动处理'],
          ],
          one.action,
        ),
      )
      .join('') +
    `<p class="note">qianmopi 自动处理 = 触发上游同步 PR（仍需评审） · Claude Code 与 Codex = 节点装新版 · 阡陌 = 逐台升级</p>` +
    textField('repo', '阡陌仓库', {
      wide: true,
      mono: true,
      value: snapshot.repo ?? '',
      placeholder: 'owner/name',
      help: '查阡陌发行 · 触发上游同步 · 令牌取自「连接」页的同名仓库连接',
    }) +
    (snapshot.channelChoices.length === 0
      ? `<p class="note">还没有通知渠道 · 结果只记在本页</p>`
      : checkGroup(
          'channels',
          '有新版本时推送到',
          snapshot.channelChoices.map(one => [one.id, one.name] as const),
          snapshot.channels,
        ))
  )
}

/** The rollback choices: the local backup, then the older releases. */
export function renderRollbackChoices(snapshot: UpdatesSnapshot): string {
  const choices: (readonly [string, string])[] = [
    ...(snapshot.hub.backup === null
      ? []
      : [['', `本机备份 ${snapshot.hub.backup}`] as const]),
    ...snapshot.rollbackVersions.map(one => [one, `发行 ${one}`] as const),
  ]
  return segmented('rollbackVersion', '回到', choices, choices[0]?.[0] ?? '')
}

export function updatesDialog(): string {
  return (
    `<dialog class="dialog" id="updates-rollback-dialog" aria-labelledby="updates-rollback-title">` +
    `<form id="updates-rollback-form" novalidate>` +
    dialogTop('updates-rollback-title', 'history', '回滚阡陌') +
    `<div class="dialog-body"><div id="updates-rollback-body"></div>` +
    `<p class="note">逐台进行 · 中枢最后 · 在途工作做完才换</p></div>` +
    `<p class="note up-status" id="updates-rollback-status" role="status"></p>` +
    dialogActions('回滚', { glyph: 'history', danger: true }) +
    `</form></dialog>` +
    `<dialog class="dialog" id="confirm-updates-upgrade" aria-labelledby="confirm-updates-upgrade-title">` +
    dialogTop('confirm-updates-upgrade-title', 'arrow-up', '升级阡陌') +
    `<div class="dialog-body"><div class="recap"><div class="recap-row"><span class="k">版本</span>` +
    `<span id="confirm-updates-upgrade-version" class="kit-mono"></span></div></div>` +
    `<p>逐台进行 · 中枢最后 · 中枢重启时页面短暂断开</p></div>` +
    dialogActions('升级', { action: 'confirm-updates-upgrade' }) +
    `</dialog>` +
    `<dialog class="dialog" id="updates-dialog" aria-labelledby="updates-title">` +
    `<form id="updates-form" novalidate>` +
    dialogTop('updates-title', 'calendar-clock', '更新检查设定') +
    `<div class="dialog-body" id="updates-body"></div>` +
    `<p class="note up-status" id="updates-status" role="status"></p>` +
    dialogActions('保存', { glyph: 'check' }) +
    `</form></dialog>`
  )
}

export const UPDATES_PAGE_CSS = `
.up-table td, .up-table th { vertical-align: top; }
.up-nodes { display: flex; flex-direction: column; gap: 4px; }
.up-node { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: baseline; }
.up-status:empty { display: none; }
#updates-dialog .dialog-body { max-height: min(70vh, 640px); overflow: auto; }
.up-job { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) 0; margin-top: var(--space-3); border-top: var(--hairline); }
.up-steps { margin: 0; padding-left: 1.2em; display: flex; flex-direction: column; gap: 4px; }
.up-steps li { display: flex; gap: var(--space-2); align-items: baseline; flex-wrap: wrap; }
`
