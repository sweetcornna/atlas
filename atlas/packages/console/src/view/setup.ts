// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 初始化配置页：顶部一行进度，下面按顺序列出必需与建议的步骤，最后是可选项。
 *
 * 每一步折叠时只有标题、一句状态和右侧一个入口；第一个没完成、又能在页内完成
 * 的步骤默认展开它的表单。已完成的步骤收起，需要改时点「更换」再展开。没有写
 * 权限的读者只看到状态，不画按钮（按钮点了也只会被拒）。
 */

import type { SetupSnapshot, SetupStep } from '../setupState.js'
import { icon } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { selectField, textField } from './kit.js'

export interface SetupPageModel {
  readonly snapshot: SetupSnapshot
  /** 能做账号、主智能体这类写操作（管理令牌或运维账号）。 */
  readonly admin: boolean
  /** 能写模型服务（个人运维账号）。 */
  readonly modelWriter: boolean
  /** 主智能体能在页面上改（宿主接了存储）。 */
  readonly mainSettable: boolean
}

const KIND_WORD: Readonly<Record<SetupStep['kind'], string>> = {
  required: '必需',
  recommended: '建议',
  optional: '可选',
}

const GROUP_WORD: Readonly<Record<string, string>> = {
  'cn-paygo': '国内按量',
  intl: '国际',
  plan: '套餐',
}

function mark(step: SetupStep, index: number): string {
  if (step.state === 'done')
    return `<span class="setup-mark" data-state="done" aria-label="已完成">${icon(
      'check',
      { small: true },
    )}</span>`
  return `<span class="setup-mark" data-state="${attr(step.state)}" aria-hidden="true">${index + 1}</span>`
}

function linkButton(step: SetupStep, primary: boolean): string {
  if (step.link === undefined) return ''
  return (
    `<a class="btn ${primary ? 'btn-primary' : 'btn-secondary'} btn-small" ` +
    `href="${attr(step.link.href)}" data-nav>${escapeHtml(step.link.label)}</a>`
  )
}

function accountPanel(model: SetupPageModel): string {
  if (!model.admin) return ''
  return (
    `<div class="setup-panel">` +
    `<p class="note">在这个浏览器里打开一条一次性邀请 · 领取后直接以运维账号登录 · 凭据只显示一次 请存好</p>` +
    `<div class="kit-acts setup-left">` +
    `<button type="button" class="btn btn-primary btn-small" data-action="setup-ops-invite" data-write>` +
    `创建运维账号</button></div></div>`
  )
}

function modelPanel(model: SetupPageModel): string {
  const presets = model.snapshot.presets
  if (!model.modelWriter) {
    return `<div class="setup-panel"><p class="note">用运维账号登录后可以在这里直接接入</p></div>`
  }
  if (presets.length === 0) return ''
  const choices = presets.map(
    preset =>
      [
        preset.id,
        `${preset.vendor} · ${preset.name}（${GROUP_WORD[preset.group] ?? preset.group}）`,
      ] as const,
  )
  return (
    `<form class="setup-panel setup-form" id="setup-model-form" novalidate>` +
    selectField('presetId', '服务', choices, {
      form: 'setup',
      wide: true,
      required: true,
    }) +
    textField('key', '密钥', {
      form: 'setup',
      type: 'password',
      wide: true,
      required: true,
      mono: true,
      placeholder: '粘贴 API 密钥',
    }) +
    `<p class="note">保存后设为全局默认并下发到所有节点 · magpie 网关 / 本地模型 / 自定义地址去模型页新增</p>` +
    `<div class="kit-acts setup-left">` +
    `<button type="submit" class="btn btn-primary btn-small" data-write>保存并设为默认</button>` +
    `<a class="btn btn-ghost btn-small" href="/admin/providers/new" data-nav>更多服务</a>` +
    `</div></form>`
  )
}

function mainPanel(model: SetupPageModel): string {
  const { agents, main, mainFromPage } = model.snapshot
  if (!model.admin || !model.mainSettable || agents.length === 0) return ''
  const choices = agents.map(
    agent =>
      [
        agent.address,
        `${agent.agent} · ${agent.node}${agent.online ? '' : '（不在线）'}`,
      ] as const,
  )
  const reset = mainFromPage
    ? `<button type="button" class="btn btn-ghost btn-small" data-action="setup-main-reset" data-write>恢复启动参数</button>`
    : ''
  return (
    `<form class="setup-panel setup-form" id="setup-main-form" novalidate>` +
    selectField('address', '主智能体', choices, {
      form: 'setup',
      wide: true,
      required: true,
      ...(main === null ? {} : { selected: main }),
    }) +
    `<p class="note">对话首页默认打开它 · 由它接活并按难度派给子会话</p>` +
    `<div class="kit-acts setup-left">` +
    `<button type="submit" class="btn btn-primary btn-small" data-write>保存</button>${reset}` +
    `</div></form>`
  )
}

function panelOf(step: SetupStep, model: SetupPageModel): string {
  if (step.state === 'blocked') return ''
  switch (step.id) {
    case 'account':
      return step.state === 'todo' ? accountPanel(model) : ''
    case 'model':
      return modelPanel(model)
    case 'main':
      return mainPanel(model)
    default:
      return ''
  }
}

function stepItem(
  step: SetupStep,
  index: number,
  model: SetupPageModel,
  open: boolean,
): string {
  const panel = panelOf(step, model)
  const note =
    step.note === undefined
      ? ''
      : `<p class="note setup-note">${escapeHtml(step.note)}</p>`
  const head =
    `<div class="setup-text">` +
    `<div class="setup-title"><span>${escapeHtml(step.title)}</span>` +
    (step.kind === 'required'
      ? ''
      : `<span class="setup-kind">${KIND_WORD[step.kind]}</span>`) +
    `</div>` +
    `<p class="setup-sum">${escapeHtml(step.summary)}</p>${note}</div>`
  const primary = step.state === 'todo' && panel === ''
  const acts = `<div class="setup-acts">${linkButton(step, primary)}</div>`
  if (panel === '') {
    return (
      `<li class="setup-step" id="step-${attr(step.id)}" data-state="${attr(step.state)}">` +
      mark(step, index) +
      `<div class="setup-main"><div class="setup-row">${head}${acts}</div></div></li>`
    )
  }
  const toggle = step.state === 'done' ? '更换' : '展开'
  return (
    `<li class="setup-step" id="step-${attr(step.id)}" data-state="${attr(step.state)}">` +
    mark(step, index) +
    `<details class="setup-main"${open ? ' open' : ''}>` +
    `<summary class="setup-row">${head}<div class="setup-acts">` +
    `<span class="btn btn-ghost btn-small setup-toggle" aria-hidden="true">${toggle}</span>` +
    `${step.link === undefined ? '' : linkButton(step, false)}</div></summary>` +
    `${panel}</details></li>`
  )
}

function header(model: SetupPageModel): string {
  const { steps, remaining } = model.snapshot
  const required = steps.filter(step => step.kind === 'required')
  const done = required.length - remaining
  const percent =
    required.length === 0 ? 100 : Math.round((done / required.length) * 100)
  const line =
    remaining === 0
      ? '必需的几步都完成了 · 可以开始对话'
      : `还差 ${remaining} 步 · 完成后就能和主智能体对话`
  const start =
    remaining === 0 ? `<a class="btn btn-primary" href="/">开始对话</a>` : ''
  return (
    `<div class="card elev-sm setup-head">` +
    `<div class="setup-head-text"><p class="setup-count">${done} / ${required.length}</p>` +
    `<p class="note">${escapeHtml(line)}</p></div>${start}` +
    `<div class="setup-bar" role="progressbar" aria-label="初始化进度" aria-valuemin="0" ` +
    `aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div>` +
    `</div>`
  )
}

/** 整页正文。 */
export function renderSetup(model: SetupPageModel): string {
  const main = model.snapshot.steps.filter(step => step.kind !== 'optional')
  const optional = model.snapshot.steps.filter(step => step.kind === 'optional')
  const firstOpen = main.find(
    step => step.state === 'todo' && panelOf(step, model) !== '',
  )
  return (
    `<div class="setup">` +
    header(model) +
    `<ol class="setup-steps card elev-sm">` +
    main
      .map((step, index) => stepItem(step, index, model, step === firstOpen))
      .join('') +
    `</ol>` +
    `<h2 class="setup-sub">可选</h2>` +
    `<ul class="setup-steps setup-optional card elev-sm">` +
    optional
      .map((step, index) => stepItem(step, main.length + index, model, false))
      .join('') +
    `</ul></div>`
  )
}

/** 本页自己的样式。 */
export const SETUP_CSS = `
.setup { display: flex; flex-direction: column; gap: var(--space-4); max-width: 760px; }
.setup-head { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: var(--space-3); padding: var(--space-4); }
.setup-head-text { display: flex; flex-direction: column; gap: 2px; }
.setup-count { margin: 0; font-size: var(--text-20); font-weight: 600; font-variant-numeric: tabular-nums; }
.setup-head .note { margin: 0; }
.setup-bar { grid-column: 1 / -1; height: 4px; border-radius: var(--radius-pill); background: var(--color-divider); overflow: hidden; }
.setup-bar > span { display: block; height: 100%; background: var(--color-accent-fill); border-radius: inherit; transition: width .2s ease; }
.setup-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.setup-step { display: grid; grid-template-columns: 28px 1fr; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--color-divider); }
.setup-step:last-child { border-bottom: 0; }
.setup-mark { width: 22px; height: 22px; margin-top: 1px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: var(--text-12); font-weight: 600; color: var(--color-quiet); border: 1.5px solid var(--color-divider); font-variant-numeric: tabular-nums; }
.setup-mark[data-state="done"] { border-color: transparent; background: var(--color-accent-2-600); color: #fff; }
.setup-mark[data-state="blocked"] { border-style: dashed; }
.setup-main { min-width: 0; }
.setup-row { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); list-style: none; cursor: default; }
details.setup-main > summary { cursor: pointer; }
details.setup-main > summary::-webkit-details-marker { display: none; }
.setup-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.setup-title { display: flex; align-items: center; gap: var(--space-2); font-weight: 600; font-size: var(--text-14); }
.setup-kind { font-weight: 400; font-size: var(--text-11-5); color: var(--color-quiet); border: 1px solid var(--color-divider); border-radius: var(--radius-pill); padding: 0 6px; }
.setup-sum { margin: 0; font-size: var(--text-13); color: var(--color-muted); overflow-wrap: anywhere; }
.setup-step[data-state="done"] .setup-sum { color: var(--color-quiet); }
.setup-note { margin: 0; }
.setup-acts { display: flex; gap: var(--space-2); flex: none; align-items: center; }
details[open] .setup-toggle { visibility: hidden; }
.setup-panel { margin-top: var(--space-3); display: flex; flex-direction: column; gap: var(--space-3); }
.setup-panel > .note { margin: 0; }
.setup-form .field { max-width: 460px; }
.setup-left { justify-content: flex-start; }
.setup-sub { margin: var(--space-2) 0 0; font-size: var(--text-13); font-weight: 600; color: var(--color-muted); }
.setup-optional .setup-mark { visibility: hidden; }
@media (max-width: 640px) {
  .setup-row { flex-direction: column; }
  .setup-head { grid-template-columns: 1fr; }
}
`
