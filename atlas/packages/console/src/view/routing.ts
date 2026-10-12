// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 任务分工 (P22) on the 模型 page: which model takes which direction of
 * work — code, conversation, planning, quick chores, pictures in, pictures
 * out, speech, video — for every node, or one node's override.
 *
 * One card. A direction left unpicked follows the main model (the media
 * ones stay off). The scope select swaps the card for another node's view
 * (`/fragments/routing?node=`); without script it is a plain GET link.
 */

import {
  MODEL_DIRECTIONS,
  type ModelDirection,
  type ModelRoutingSnapshot,
  type ModelRoutingView,
  type RoutableModelView,
  type RouteDecisionView,
} from '../directionPorts.js'
import type { ConsoleFailure } from '../deps.js'
import { chevron, failureBar, tag } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatRelative } from './format.js'
import { DIRECTION_WORD, switchField } from './kit.js'

/** What a person would send in each direction, one line. */
const DIRECTION_HINT: Readonly<Record<ModelDirection, string>> = {
  code: '写代码 修错 重构 跑测试',
  chat: '日常对话 写简报 回消息',
  plan: '拆解计划 分析方案 做取舍',
  fast: '提取 改写 归类这类小活',
  vision: '看截图 读图片里的内容',
  image: '画图 海报 配图',
  speech: '朗读 配音',
  video: '生成短片',
}

const MEDIA: readonly ModelDirection[] = ['image', 'speech', 'video']

const KIND_OF: Readonly<Record<ModelDirection, RoutableModelView['kind']>> = {
  code: 'chat',
  chat: 'chat',
  plan: 'chat',
  fast: 'chat',
  vision: 'chat',
  image: 'image',
  speech: 'speech',
  video: 'video',
}

const SOURCE_WORD: Readonly<Record<RouteDecisionView['source'], string>> = {
  hint: '任务指定',
  auto: '自动归类',
  default: '主模型',
}

interface RoutingCardModel {
  readonly snapshot: ModelRoutingSnapshot
  /** The scope shown: `null` for every node, else one node's name. */
  readonly node: string | null
  /** Every node the 模型 service knows, for the scope select. */
  readonly nodes: readonly string[]
  readonly writer: boolean
  readonly now: number
}

function viewOf(model: RoutingCardModel): {
  readonly view: ModelRoutingView
  readonly own: boolean
} {
  if (model.node === null) return { view: model.snapshot.defaults, own: true }
  const own = model.snapshot.nodes.find(one => one.node === model.node)
  return own === undefined
    ? { view: model.snapshot.defaults, own: false }
    : { view: own, own: true }
}

function optionValue(model: RoutableModelView): string {
  return `${model.profileId}/${model.modelId}`
}

function modelWord(model: RoutableModelView): string {
  return `${model.modelId} · ${model.profileName}`
}

function noneWord(direction: ModelDirection): string {
  return MEDIA.includes(direction) ? '不开' : '跟随主模型'
}

function pickerOf(
  direction: ModelDirection,
  chosen: string,
  models: readonly RoutableModelView[],
): string {
  const fitting = models.filter(one => one.kind === KIND_OF[direction])
  const options =
    `<option value=""${chosen === '' ? ' selected' : ''}>${escapeHtml(noneWord(direction))}</option>` +
    fitting
      .map(one => {
        const value = optionValue(one)
        return (
          `<option value="${attr(value)}" data-profile="${attr(one.profileId)}" ` +
          `data-model="${attr(one.modelId)}"${value === chosen ? ' selected' : ''}>` +
          `${escapeHtml(modelWord(one))}${one.evaluated ? '' : ' · 未评估'}</option>`
        )
      })
      .join('')
  // Nothing of this kind to pick: say so, and keep the field out of the
  // save (a direction with no select is left as it is).
  if (fitting.length === 0) {
    return `<span class="note route-none">${escapeHtml(
      MEDIA.includes(direction)
        ? '还没有这类模型 · 在下面加一个服务'
        : '还没有对话模型',
    )}</span>`
  }
  return (
    `<span class="sel route-sel"><select class="input" id="route-${direction}" ` +
    `name="route-${direction}" aria-label="${attr(DIRECTION_WORD[direction] ?? direction)}">` +
    `${options}</select>${chevron()}</span>`
  )
}

function readOf(
  direction: ModelDirection,
  chosen: RoutableModelView | undefined,
): string {
  if (chosen === undefined) {
    return `<span class="note">${escapeHtml(noneWord(direction))}</span>`
  }
  return (
    `<span class="route-model">${escapeHtml(modelWord(chosen))}</span>` +
    (chosen.evaluated ? '' : tag('未评估', 'muted'))
  )
}

function rows(model: RoutingCardModel, view: ModelRoutingView): string {
  return MODEL_DIRECTIONS.map(direction => {
    const route = view.routes.find(one => one.direction === direction)
    const chosen =
      route === undefined || route.profileId === null
        ? undefined
        : model.snapshot.models.find(
            one =>
              one.profileId === route.profileId &&
              one.modelId === route.modelId,
          )
    const value =
      route === undefined || route.profileId === null || route.modelId === null
        ? ''
        : `${route.profileId}/${route.modelId}`
    return (
      `<div class="route-row${MEDIA.includes(direction) ? ' route-media' : ''}">` +
      `<div class="route-dir"><b>${escapeHtml(DIRECTION_WORD[direction] ?? direction)}</b>` +
      `<span class="note">${escapeHtml(DIRECTION_HINT[direction])}</span></div>` +
      `<div class="route-pick">${
        model.writer
          ? pickerOf(direction, value, model.snapshot.models)
          : readOf(direction, chosen)
      }</div></div>`
    )
  }).join('')
}

function scopeOf(model: RoutingCardModel): string {
  if (model.nodes.length === 0) return ''
  const options = [
    `<option value=""${model.node === null ? ' selected' : ''}>所有节点</option>`,
    ...model.nodes.map(name => {
      const own = model.snapshot.nodes.some(one => one.node === name)
      return `<option value="${attr(name)}"${name === model.node ? ' selected' : ''}>${escapeHtml(
        `${name}${own ? ' · 单独设置' : ''}`,
      )}</option>`
    }),
  ].join('')
  return (
    `<form class="route-scope" method="get" action="/admin/providers" id="routing-scope">` +
    `<label class="sr-only" for="routing-node">范围</label>` +
    `<span class="sel"><select class="input" id="routing-node" name="routing">${options}</select>${chevron()}</span>` +
    `<noscript><button type="submit" class="btn btn-secondary btn-small">切换</button></noscript>` +
    `</form>`
  )
}

function recentOf(model: RoutingCardModel): string {
  const recent = model.snapshot.recent.filter(
    one => model.node === null || one.node === model.node,
  )
  if (recent.length === 0) return ''
  const items = recent
    .slice(0, 8)
    .map(
      one =>
        `<li><span class="note">${escapeHtml(formatRelative(one.at, model.now))}</span>` +
        `<span>${escapeHtml(`${one.agent} · ${one.node}`)}</span>` +
        `<b>${escapeHtml(DIRECTION_WORD[one.direction] ?? one.direction)}</b>` +
        `<span class="note">${escapeHtml(SOURCE_WORD[one.source])}</span>` +
        `<span class="kit-mono">${escapeHtml(one.model)}</span></li>`,
    )
    .join('')
  return (
    `<details class="route-recent"><summary>${chevron()}最近 ${escapeHtml(String(recent.length))} 次分派</summary>` +
    `<ul>${items}</ul></details>`
  )
}

/** The whole card; the fragment answers the same markup for another scope. */
export function renderRoutingCard(model: RoutingCardModel): string {
  const { view, own } = viewOf(model)
  const scopeNote =
    model.node === null
      ? '不同方向的任务交给不同模型 · 没选的方向跟随主模型 · 生图 语音 视频不选就不开'
      : own
        ? `${model.node} 用自己的分工 · 其余节点不受影响`
        : `${model.node} 现在跟随所有节点的分工 · 保存后它单独生效`
  const updated =
    view.updatedAt === null
      ? ''
      : `<span class="note">${escapeHtml(
          `${formatRelative(view.updatedAt, model.now)}由 ${view.updatedBy ?? '未知'} 修改`,
        )}</span>`
  const auto = model.writer
    ? switchField('auto', '没说方向的任务按内容自动分派', view.auto, {
        id: 'routing-auto',
      })
    : `<span class="note">${view.auto ? '没说方向的任务按内容自动分派' : '没说方向的任务交给主模型'}</span>`
  const clear =
    model.writer && model.node !== null && own
      ? `<button type="button" class="btn btn-ghost btn-small" data-action="routing-clear" ` +
        `data-node="${attr(model.node)}" data-write>回到所有节点的分工</button>`
      : ''
  const save = model.writer
    ? `<button type="submit" class="btn btn-primary btn-small" data-write>保存分工</button>`
    : ''
  const body =
    `<div class="route-grid">${rows(model, view)}</div>` +
    `<div class="route-foot">${auto}<span class="kit-acts">${clear}${save}</span></div>` +
    `<p class="note route-status" id="routing-status" role="status"></p>`
  return (
    `<section class="card elev-sm route-card" id="routing" data-node="${attr(model.node ?? '')}">` +
    `<header class="route-head"><div><h2 class="route-title">任务分工</h2>` +
    `<p class="note">${escapeHtml(scopeNote)}</p>${updated}</div>${scopeOf(model)}</header>` +
    (model.writer
      ? `<form id="routing-form" novalidate data-revision="${attr(String(view.revision))}">${body}</form>`
      : body) +
    recentOf(model) +
    `</section>`
  )
}

export function renderRoutingFailure(failure: ConsoleFailure): string {
  return (
    `<section class="card elev-sm route-card" id="routing">` +
    `<header class="route-head"><div><h2 class="route-title">任务分工</h2></div></header>` +
    failureBar(failure, '任务分工') +
    `</section>`
  )
}

export const ROUTING_CSS = `
.route-card { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4) var(--space-6); margin-bottom: var(--space-4); }
.route-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); flex-wrap: wrap; }
.route-title { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: var(--text-16, 16px); margin-bottom: 2px; }
.route-scope .sel { min-width: 180px; }
.route-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 400px), 1fr)); gap: 0 var(--space-6); }
.route-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px solid var(--color-line); min-width: 0; }
.route-dir { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
.route-dir .note { font-size: var(--text-12); }
.route-dir b { font-weight: 600; font-size: var(--text-13-5, 13.5px); }
.route-pick { display: flex; align-items: center; gap: var(--space-2); flex: 0 0 min(52%, 250px); min-width: 0; justify-content: flex-end; }
.route-sel { width: 100%; }
.route-sel select { width: 100%; }
.route-model { font-size: var(--text-13); overflow-wrap: anywhere; text-align: right; }
.route-none { font-size: var(--text-12); text-align: right; }
.route-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
.route-status:empty { display: none; }
.route-recent > summary { list-style: none; cursor: pointer; font-size: var(--text-12-5); color: var(--color-muted); display: inline-flex; align-items: center; gap: 4px; }
.route-recent > summary::-webkit-details-marker { display: none; }
.route-recent[open] > summary svg { transform: rotate(180deg); }
.route-recent ul { list-style: none; margin: var(--space-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.route-recent li { display: flex; gap: var(--space-2); align-items: baseline; flex-wrap: wrap; font-size: var(--text-12-5); }
@media (max-width: 700px) { .route-row { flex-direction: column; align-items: stretch; } .route-pick { flex-basis: auto; justify-content: stretch; } .route-model { text-align: left; } }
`
