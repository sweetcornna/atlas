// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 主动执行 — scheduled turns the hub starts on an agent, what each run said,
 * and where the result is pushed (P24, `directions-2026-10.md` §7).
 *
 * ## Three kinds of "when", one sentence
 *
 * A schedule is 每天 08:00, 每周一三五 09:30 or 每 2 小时, always with its
 * zone. The table says it in that one line rather than three columns, because
 * the operator scans for "what fires at eight", not for a cron field.
 *
 * ## A run is shown with what it said
 *
 * The point of this page over the old watch jobs is that the reply is kept.
 * The latest runs are drawn as cards with the first lines of the reply, the
 * channels it was pushed to and whether each push worked, and a link into the
 * conversation that holds the whole turn.
 *
 * ## Writes are dialogs outside the polled region
 *
 * The schedule and channel forms live in `<dialog>`s rendered once with the
 * page, so a refresh never replaces a form someone is typing into. A row's
 * 编辑 carries the schedule as JSON in `data-schedule`; the page script reads
 * it and writes field values, never markup.
 */

import type {
  NotifyChannelKind,
  NotifyChannelView,
  ScheduleRunOutcome,
  ScheduleRunView,
  SchedulesSnapshot,
  ScheduleTemplateView,
  ScheduleView,
  ScheduleWhen,
} from '../directionPorts.js'
import type { ConsoleFailure } from '../deps.js'
import {
  absent,
  address,
  bar,
  failureBar,
  hint,
  icon,
  railSep,
  scroll,
  sectionHead,
  state,
  tag,
  timeTag,
  toned,
  type Tone,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatDuration, formatRelative } from './format.js'
import {
  actionButton,
  checkGroup,
  DIRECTION_WORD,
  dialogActions,
  dialogTop,
  emptyState,
  segmented,
  selectField,
  statCard,
  switchField,
  textArea,
  textField,
  unwiredCard,
} from './kit.js'

export const WEEKDAY = ['一', '二', '三', '四', '五', '六', '日'] as const

const TEMPLATE_WORD: Readonly<Record<string, string>> = {
  briefing: '晨间简报',
  followup: '跟进待办',
  mail: '整理邮件',
  custom: '自定义',
}

const OUTCOME_WORD: Readonly<Record<ScheduleRunOutcome, string>> = {
  running: '运行中',
  completed: '完成',
  failed: '失败',
  timeout: '超时',
  skipped: '跳过',
}

const OUTCOME_TONE: Readonly<Record<ScheduleRunOutcome, Tone>> = {
  running: 'warn',
  completed: 'ok',
  failed: 'bad',
  timeout: 'bad',
  skipped: 'muted',
}

const CHANNEL_WORD: Readonly<Record<NotifyChannelKind, string>> = {
  webhook: '通用 Webhook',
  bark: 'Bark',
  wecom: '企业微信群机器人',
  feishu: '飞书群机器人',
  ntfy: 'ntfy',
}

/** The zones offered in the form; the schedule's own zone is added if absent. */
const ZONES = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
] as const

/** `每天 08:00` / `每周一三五 09:30` / `每 2 小时` — one line, no zone. */
function whenText(when: ScheduleWhen): string {
  switch (when.kind) {
    case 'daily':
      return `每天 ${when.time}`
    case 'weekly': {
      const days = [...when.days]
        .sort((a, b) => a - b)
        .map(day => WEEKDAY[day - 1] ?? '')
        .join('')
      return days.length === 7
        ? `每天 ${when.time}`
        : `每周${days} ${when.time}`
    }
    case 'interval':
      return when.everyMinutes % 60 === 0
        ? `每 ${when.everyMinutes / 60} 小时`
        : `每 ${when.everyMinutes} 分钟`
  }
}

function zoneNote(zone: string): string {
  return zone === 'Asia/Shanghai' ? '北京时间' : zone
}

function outcomeTag(outcome: ScheduleRunOutcome): string {
  return state(OUTCOME_TONE[outcome], OUTCOME_WORD[outcome])
}

/**
 * A run whose end never came back (a local timeout, a restart mid-run) is
 * `unknown`: the agent may still be working, so the schedule holds and the
 * page says so instead of the `running` it keeps underneath.
 */
function runTag(run: ScheduleRunView): string {
  return run.state === 'unknown'
    ? state('warn', '结果未知 · 待确认')
    : outcomeTag(run.outcome)
}

function scheduleName(schedule: ScheduleView): string {
  const direction =
    schedule.direction === null
      ? ''
      : tag(DIRECTION_WORD[schedule.direction] ?? schedule.direction, 'muted')
  // The template's name says nothing new when the title is that name.
  const word = TEMPLATE_WORD[schedule.template] ?? schedule.template
  const template = word === schedule.title ? '' : tag(word, 'ok')
  const tags = template + direction
  return (
    `<td class="sch-name"><b>${escapeHtml(schedule.title)}</b>` +
    (tags === '' ? '' : `<span class="kit-row">${tags}</span>`) +
    `</td>`
  )
}

function nextCell(schedule: ScheduleView, now: number, estop: boolean): string {
  if (!schedule.enabled)
    return `<td class="when"><span class="note">已停用</span></td>`
  if (schedule.nextRunAt === null) return `<td class="when">${absent()}</td>`
  const note = estop
    ? toned('critical', '急停中 · 到点跳过')
    : `<span class="note">${escapeHtml(formatRelative(schedule.nextRunAt, now))}</span>`
  return `<td class="when"><span class="sch-when">${timeTag(schedule.nextRunAt, 'datetime')}${note}</span></td>`
}

function lastCell(schedule: ScheduleView, now: number): string {
  const run = schedule.lastRun
  if (run === null)
    return `<td class="when"><span class="note">尚未运行</span></td>`
  return (
    `<td class="when"><span class="sch-when">${runTag(run)}` +
    `<span class="note">${escapeHtml(formatRelative(run.startedAt, now))}</span></span></td>`
  )
}

function rowActions(schedule: ScheduleView, member: boolean): string {
  if (!member) return `<td class="acts">${absent()}</td>`
  const payload = JSON.stringify({
    id: schedule.id,
    title: schedule.title,
    target: schedule.target,
    template: schedule.template,
    prompt: schedule.prompt,
    when: schedule.when,
    timezone: schedule.timezone,
    direction: schedule.direction,
    channels: schedule.channels,
    notifyOnlyAgent: schedule.notifyOnlyAgent,
    enabled: schedule.enabled,
    timeoutMs: schedule.timeoutMs,
  })
  return (
    `<td class="acts"><span class="kit-acts">` +
    actionButton('schedule-run', '立即运行', {
      glyph: 'zap',
      data: { id: schedule.id, title: schedule.title },
    }) +
    actionButton('schedule-edit', '编辑', {
      tone: 'ghost',
      data: { schedule: payload },
    }) +
    actionButton('schedule-remove', '删除', {
      tone: 'ghost',
      data: { id: schedule.id, title: schedule.title },
    }) +
    `</span></td>`
  )
}

function enabledCell(schedule: ScheduleView, member: boolean): string {
  if (!member) {
    return `<td>${schedule.enabled ? state('ok', '启用') : state('muted', '停用')}</td>`
  }
  return (
    `<td><label class="sw" title="${schedule.enabled ? '停用' : '启用'}">` +
    `<input type="checkbox" data-action="schedule-toggle" data-id="${attr(schedule.id)}" ` +
    `aria-label="${attr(`${schedule.title} 启用`)}"${schedule.enabled ? ' checked' : ''} data-write>` +
    `<span class="trk"></span></label></td>`
  )
}

function schedulesTable(
  snapshot: SchedulesSnapshot,
  now: number,
  member: boolean,
): string {
  const head = ['任务', '目标', '时间', '下次运行', '最近一次', '启用', '']
    .map(name => `<th scope="col">${escapeHtml(name)}</th>`)
    .join('')
  const rows = snapshot.schedules
    .map(
      schedule =>
        `<tr data-key="${attr(schedule.id)}">` +
        scheduleName(schedule) +
        `<td>${address(schedule.target)}</td>` +
        `<td><span class="sch-when"><span>${escapeHtml(whenText(schedule.when))}</span>` +
        `<span class="note">${escapeHtml(zoneNote(schedule.timezone))}</span></span></td>` +
        nextCell(schedule, now, snapshot.estop) +
        lastCell(schedule, now) +
        enabledCell(schedule, member) +
        rowActions(schedule, member) +
        `</tr>`,
    )
    .join('')
  return scroll(
    `<table class="trail schedules"><caption class="sr-only">定时任务</caption>` +
      `<thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`,
  )
}

function pushedLine(
  run: ScheduleRunView,
  channels: readonly NotifyChannelView[],
): string {
  if (run.pushed.length === 0) return ''
  const names = new Map(channels.map(one => [one.id, one.name]))
  return `<span class="kit-row">${run.pushed
    .map(push =>
      tag(
        `${names.get(push.channelId) ?? push.channelId} ${push.ok ? '已推送' : '推送失败'}`,
        push.ok ? 'ok' : 'bad',
        push.error ?? undefined,
      ),
    )
    .join('')}</span>`
}

function resolveActions(run: ScheduleRunView): string {
  const data = { id: run.scheduleId, run: run.runId }
  return (
    `<div class="run-unknown"><p class="note">没有收到这次的结果 · 本地等待超时或服务重启过 · 智能体可能还在做 · 确认之前不会再发</p>` +
    `<span class="kit-acts">` +
    actionButton('run-resolve', '确认失败', {
      tone: 'ghost',
      data: { ...data, outcome: 'failed' },
    }) +
    actionButton('run-resolve', '确认已完成', {
      data: { ...data, outcome: 'ok' },
    }) +
    `</span></div>`
  )
}

function runCard(
  run: ScheduleRunView,
  titles: ReadonlyMap<string, string>,
  channels: readonly NotifyChannelView[],
  now: number,
  member: boolean,
): string {
  const title = titles.get(run.scheduleId) ?? run.scheduleId
  const took =
    run.finishedAt === null
      ? ''
      : `${railSep()}<span>用时 ${escapeHtml(formatDuration(run.finishedAt - run.startedAt))}</span>`
  const manual = run.trigger === 'manual' ? tag('手动', 'muted') : ''
  const open =
    run.sessionId === null
      ? ''
      : `<a class="jump" href="${attr(`/?session=${encodeURIComponent(run.sessionId)}`)}" data-nav>查看会话</a>`
  const body =
    run.excerpt !== null && run.excerpt !== ''
      ? `<p class="kit-excerpt">${escapeHtml(run.excerpt)}</p>`
      : run.reason === null || run.state === 'unknown'
        ? ''
        : `<p class="note">${escapeHtml(run.reason)}</p>`
  return (
    `<article class="card elev-sm run-card" data-key="${attr(run.runId)}">` +
    `<div class="run-head"><div class="kit-row"><b>${escapeHtml(title)}</b>${runTag(run)}${manual}</div>` +
    `<div class="note kit-row">${timeTag(run.startedAt, 'datetime')}` +
    `<span>${escapeHtml(formatRelative(run.startedAt, now))}</span>${took}</div></div>` +
    body +
    (member && run.state === 'unknown' ? resolveActions(run) : '') +
    `<div class="run-foot">${pushedLine(run, channels)}${open}</div>` +
    `</article>`
  )
}

function runsSection(
  snapshot: SchedulesSnapshot,
  now: number,
  member: boolean,
): string {
  const titles = new Map(snapshot.schedules.map(one => [one.id, one.title]))
  const runs = snapshot.runs.slice(0, 12)
  const body =
    runs.length === 0
      ? hint('还没有运行记录')
      : `<div class="run-grid">${runs
          .map(run => runCard(run, titles, snapshot.channels, now, member))
          .join('')}</div>`
  return (
    `<section class="sec" aria-labelledby="h-runs">` +
    sectionHead('Runs', '运行记录', {
      headingId: 'h-runs',
      tail: `<span class="note">最近 ${runs.length} 次 · 回复只显示开头</span>`,
    }) +
    body +
    `</section>`
  )
}

function channelsSection(
  snapshot: SchedulesSnapshot,
  now: number,
  ops: boolean,
): string {
  const add = ops
    ? actionButton('channel-new', '添加渠道', { glyph: 'plus' })
    : ''
  const head = ['名称', '类型', '地址', '最近使用', '状态', '']
    .map(name => `<th scope="col">${escapeHtml(name)}</th>`)
    .join('')
  const rows = snapshot.channels
    .map(
      channel =>
        `<tr data-key="${attr(channel.id)}">` +
        `<td><b>${escapeHtml(channel.name)}</b></td>` +
        `<td>${escapeHtml(CHANNEL_WORD[channel.kind])}</td>` +
        `<td><span class="kit-mono">${escapeHtml(channel.host)}</span></td>` +
        `<td class="when">${
          channel.lastUsedAt === null
            ? '<span class="note">未用过</span>'
            : `<span class="note">${escapeHtml(formatRelative(channel.lastUsedAt, now))}</span>`
        }</td>` +
        `<td>${
          channel.lastError === null
            ? state('ok', '正常')
            : `<span title="${attr(channel.lastError)}">${state('bad', '上次失败')}</span>`
        }</td>` +
        `<td class="acts">${
          ops
            ? `<span class="kit-acts">` +
              actionButton('channel-test', '发测试', {
                data: { id: channel.id, name: channel.name },
              }) +
              actionButton('channel-remove', '删除', {
                tone: 'ghost',
                data: { id: channel.id, name: channel.name },
              }) +
              `</span>`
            : absent()
        }</td></tr>`,
    )
    .join('')
  const body =
    snapshot.channels.length === 0
      ? hint(
          ops
            ? '还没有通知渠道 · 添加后定时任务可以把结果推送出去'
            : '还没有通知渠道',
        )
      : scroll(
          `<table class="trail channels"><caption class="sr-only">通知渠道</caption>` +
            `<thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`,
        )
  return (
    `<section class="sec" aria-labelledby="h-channels">` +
    sectionHead('Channels', '通知渠道', {
      headingId: 'h-channels',
      tail: `<div class="kit-row"><span class="note">请求格式按各家公开文档 · 未评估</span>${add}</div>`,
    }) +
    body +
    `</section>`
  )
}

function stats(snapshot: SchedulesSnapshot, now: number): string {
  const enabled = snapshot.schedules.filter(one => one.enabled)
  const next = enabled
    .map(one => one.nextRunAt)
    .filter((at): at is number => at !== null)
    .sort((a, b) => a - b)[0]
  const dayAgo = now - 86_400_000
  const recent = snapshot.runs.filter(run => run.startedAt >= dayAgo)
  const failed = recent.filter(
    run => run.outcome === 'failed' || run.outcome === 'timeout',
  ).length
  const tick = snapshot.estop
    ? toned('critical', '急停中')
    : snapshot.tickAt === null
      ? toned('warn', '调度未运行')
      : now - snapshot.tickAt > 120_000
        ? toned('warn', `调度 ${formatRelative(snapshot.tickAt, now)}`)
        : toned('ok', '调度正常')
  return (
    `<div class="kit-cards">` +
    statCard({
      kicker: '启用的任务',
      value: String(enabled.length),
      hint:
        next === undefined
          ? `共 ${snapshot.schedules.length} 个`
          : `下一次 ${escapeHtml(formatRelative(next, now))}`,
      glyph: 'calendar-clock',
    }) +
    statCard({
      kicker: '近 24 小时运行',
      value: String(recent.length),
      hint:
        failed > 0 ? toned('bad', `失败 ${failed}`) : '<span>没有失败</span>',
      glyph: 'activity',
      blob: 'blob-2',
    }) +
    statCard({
      kicker: '通知渠道',
      value: String(snapshot.channels.length),
      hint: `${snapshot.channels.filter(one => one.lastError !== null).length} 个上次失败`,
      glyph: 'bell',
      blob: 'blob-n',
    }) +
    statCard({
      kicker: '调度',
      value: snapshot.estop ? '停' : '开',
      hint: tick,
      glyph: 'clock',
      blob: 'blob-n',
    }) +
    `</div>`
  )
}

/** The polled fragment: the cards, the schedules, the runs and the channels. */
export function renderSchedules(
  snapshot: SchedulesSnapshot,
  now: number,
  roles: { readonly member: boolean; readonly ops: boolean },
): string {
  const estop = snapshot.estop
    ? bar('critical', '紧急停止已拉下 · 到点的定时任务一律跳过')
    : ''
  const table =
    snapshot.schedules.length === 0
      ? emptyState(
          '还没有定时任务',
          '让智能体每天早上整理简报 · 或定时跟进待办和邮件 · 结果推送到通知渠道',
          roles.member
            ? `<div>${actionButton('schedule-new', '新建定时任务', { glyph: 'plus', tone: 'primary', small: false })}</div>`
            : '',
        )
      : schedulesTable(snapshot, now, roles.member)
  return (
    stats(snapshot, now) +
    estop +
    `<section class="sec" aria-labelledby="h-schedules">` +
    sectionHead('Schedules', '定时任务', {
      headingId: 'h-schedules',
      stats: { schedules: snapshot.schedules.length },
    }) +
    table +
    `</section>` +
    runsSection(snapshot, now, roles.member) +
    channelsSection(snapshot, now, roles.ops)
  )
}

/** The fragment when the schedules port is absent or failed. */
export function renderSchedulesUnavailable(
  failure: ConsoleFailure | null,
): string {
  if (failure !== null) return failureBar(failure, '定时任务')
  return unwiredCard(
    '定时任务',
    '中枢启动时打开定时任务后 · 这里可以新建每天或每周运行的任务 · 结果保存在对话里并推送到通知渠道',
    'qm console --chat-url <节点>=<地址> --schedules',
  )
}

export function zoneChoices(): readonly (readonly [string, string])[] {
  return ZONES.map(zone => [zone, zoneNote(zone)] as const)
}

/**
 * The schedule form, rendered once with the page. `targets`, `channels` and
 * `templates` fill the choices; the page script fills the rest when editing.
 */
export function scheduleDialog(
  snapshot: Pick<SchedulesSnapshot, 'targets' | 'channels' | 'templates'>,
): string {
  const templates = JSON.stringify(
    snapshot.templates.map((one: ScheduleTemplateView) => ({
      id: one.id,
      title: one.title,
      prompt: one.prompt,
      needs: one.needs,
    })),
  )
  const targets: readonly (readonly [string, string])[] =
    snapshot.targets.length === 0
      ? [['', '没有可选的智能体']]
      : snapshot.targets.map(target => [target, target] as const)
  const directions: readonly (readonly [string, string])[] = [
    ['', '不指定难度'],
    ...Object.entries(DIRECTION_WORD).filter(
      ([key]) => key === 'complex' || key === 'medium' || key === 'simple',
    ),
  ]
  const channels = snapshot.channels.map(one => [one.id, one.name] as const)
  return (
    `<dialog class="dialog dialog-wide" id="schedule-dialog" aria-labelledby="schedule-title">` +
    dialogTop('schedule-title', 'calendar-clock', '定时任务', true) +
    `<form id="schedule-form" class="stack" novalidate data-templates="${attr(templates)}">` +
    `<input type="hidden" name="scheduleId" value="">` +
    `<div class="form-grid">` +
    textField('title', '名称', {
      required: true,
      placeholder: '例如 晨间简报',
      maxLength: 80,
    }) +
    selectField('target', '交给哪个智能体', targets, { required: true }) +
    `</div>` +
    segmented(
      'template',
      '内容',
      snapshot.templates.map(one => [one.id, one.title] as const),
      'briefing',
    ) +
    `<p class="note" id="schedule-needs" hidden></p>` +
    textArea('prompt', '提示词', {
      required: true,
      rows: 5,
      maxLength: 4000,
      help: '模板只是预填 · 可以改成自己的话',
    }) +
    segmented(
      'kind',
      '频率',
      [
        ['daily', '每天'],
        ['weekly', '每周'],
        ['interval', '间隔'],
      ],
      'daily',
    ) +
    `<div class="form-grid" id="schedule-when">` +
    `<div data-when="daily weekly">${textField('time', '时间', { type: 'time', value: '08:00', required: true })}</div>` +
    `<div data-when="interval">${textField('everyMinutes', '间隔分钟', { type: 'number', value: '120', min: 15, help: '最短 15 分钟' })}</div>` +
    selectField('timezone', '时区', zoneChoices(), {
      selected: 'Asia/Shanghai',
    }) +
    `</div>` +
    `<div data-when="weekly">${checkGroup(
      'days',
      '星期',
      WEEKDAY.map((day, index) => [String(index + 1), `周${day}`] as const),
      ['1', '2', '3', '4', '5'],
    )}</div>` +
    `<details class="adv"><summary>${icon('chevron-down', { small: true, cls: 'chev' })}更多 · 难度 通知 超时</summary>` +
    `<div class="adv-body">` +
    selectField('direction', '任务难度', directions) +
    textField('timeoutMinutes', '超时分钟', {
      type: 'number',
      value: '10',
      min: 1,
      max: 60,
    }) +
    (channels.length === 0
      ? `<p class="note field-wide">还没有通知渠道 · 结果只保存在对话里</p>`
      : checkGroup('channels', '推送到', channels)) +
    `<div class="field field-wide">${switchField('notifyOnlyAgent', '只在智能体主动通知时推送', false, { id: 'f-notifyOnlyAgent' })}</div>` +
    `</div></details>` +
    `<div class="kit-row">${switchField('enabled', '保存后立即启用', true, { id: 'f-enabled' })}</div>` +
    `<p class="status" id="schedule-status" role="status"></p>` +
    dialogActions('保存', { glyph: 'check' }) +
    `</form></dialog>`
  )
}

/** The channel form. The address is write-only: never rendered back. */
export function channelDialog(): string {
  const kinds = Object.entries(CHANNEL_WORD) as readonly (readonly [
    string,
    string,
  ])[]
  return (
    `<dialog class="dialog" id="channel-dialog" aria-labelledby="channel-title">` +
    dialogTop('channel-title', 'bell', '通知渠道') +
    `<form id="channel-form" class="stack" novalidate>` +
    textField('name', '名称', {
      required: true,
      placeholder: '例如 我的手机',
      maxLength: 40,
      wide: true,
    }) +
    selectField('kind', '类型', kinds, { wide: true }) +
    textField('url', '推送地址', {
      required: true,
      wide: true,
      mono: true,
      type: 'url',
      placeholder: 'https://',
      help: '地址里常含密钥 · 保存后页面只显示主机名',
    }) +
    `<p class="status" id="channel-status" role="status"></p>` +
    dialogActions('保存', { glyph: 'check' }) +
    `</form></dialog>`
  )
}

/** The two removal confirmations. Names are written in by the page script. */
export function scheduleConfirms(): string {
  const confirm = (id: string, title: string, line: string, label: string) =>
    `<dialog class="dialog" id="${id}" aria-labelledby="${id}-title">` +
    dialogTop(`${id}-title`, 'x', title) +
    `<div class="dialog-body"><div class="recap"><div class="recap-row"><span class="k">名称</span>` +
    `<span id="${id}-name"></span></div></div><p>${escapeHtml(line)}</p></div>` +
    dialogActions(label, { danger: true, action: id }) +
    `</dialog>`
  return (
    confirm(
      'confirm-schedule-remove',
      '删除定时任务',
      '删除后不再运行 · 已有的运行记录保留',
      '删除',
    ) +
    confirm(
      'confirm-channel-remove',
      '删除通知渠道',
      '用到它的定时任务不再往这里推送',
      '删除',
    )
  )
}

/** The page's own rules. */
export const SCHEDULES_PAGE_CSS = `
.trail.schedules td, .trail.channels td { vertical-align: middle; }
.sch-name { display: flex; flex-direction: column; gap: 4px; min-width: 12em; }
.sch-when { display: inline-flex; flex-direction: column; gap: 2px; white-space: nowrap; }
.run-grid { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.run-card { gap: var(--space-2); padding: var(--space-4); }
.run-head { display: flex; flex-direction: column; gap: 4px; }
.run-unknown { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--color-bg); }
.run-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; }
#schedule-form [data-when][hidden] { display: none; }
.jobs-legacy { margin-top: var(--space-4); }
`
