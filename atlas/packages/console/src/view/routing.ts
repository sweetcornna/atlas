// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 任务模型 (P22, P38) on the 模型 page: which model each difficulty tier of
 * a sub-session takes, at what reasoning effort, and which model makes
 * pictures, speech and video — for every node, or one node's override.
 *
 * Two groups in one card: 任务难度 (complex, medium, simple; unpicked
 * follows the main model) and 生成 (image, speech, video; unpicked is off).
 * A tier with a picked model that takes an effort gets a second select,
 * narrowed to what that model takes; the page script redraws it when the
 * model changes. The scope select swaps the card for another node's view
 * (`/fragments/routing?node=`); without script it is a plain GET link.
 */

import {
  type ModelDirection,
  type ModelRouteView,
  type ModelRoutingSnapshot,
  type ModelRoutingView,
  type RoutableModelView,
  type RouteDecisionView,
  TASK_TIERS,
  type TierEffort,
} from '../directionPorts.js'
import type { ConsoleFailure } from '../deps.js'
import { chevron, failureBar, tag } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatRelative } from './format.js'
import { DIRECTION_WORD, switchField } from './kit.js'

const MEDIA: readonly ModelDirection[] = ['image', 'speech', 'video']

const KIND_OF: Readonly<Record<ModelDirection, RoutableModelView['kind']>> = {
  complex: 'chat',
  medium: 'chat',
  simple: 'chat',
  image: 'image',
  speech: 'speech',
  video: 'video',
}

/** The reasoning efforts as the card names them; '' is the model's default. */
const EFFORT_WORD: Readonly<Record<TierEffort, string>> = {
  none: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
}

const SOURCE_WORD: Readonly<Record<RouteDecisionView['source'], string>> = {
  hint: '任务指定',
  auto: '自动归类',
  default: '主模型',
}

/** What {@link renderTaskModelsCard} draws from (`Parameters<typeof renderTaskModelsCard>[0]` outside). */
interface TaskModelsCardModel {
  readonly snapshot: ModelRoutingSnapshot
  /** The scope shown: `null` for every node, else one node's name. */
  readonly node: string | null
  /** Every node the 模型 service knows, for the scope select. */
  readonly nodes: readonly string[]
  /** The nodes it manages: only those take an apply, and the split rides in one. */
  readonly managed: readonly string[]
  readonly writer: boolean
  readonly now: number
  /** The page the scope select's GET goes to without script; `/admin/providers` by default. */
  readonly scopeAction?: string
}

function viewOf(model: TaskModelsCardModel): {
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

function wordOf(direction: ModelDirection): string {
  return DIRECTION_WORD[direction] ?? direction
}

function modelPicker(
  direction: ModelDirection,
  chosen: string,
  models: readonly RoutableModelView[],
): string {
  const fitting = models.filter(one => one.kind === KIND_OF[direction])
  // Nothing of this kind to pick: say so, and keep the field out of the
  // save (a direction with no select is left as it is).
  if (fitting.length === 0) {
    return `<span class="note route-none">${escapeHtml(
      MEDIA.includes(direction)
        ? '还没有这类模型 · 在下面加一个服务'
        : '还没有对话模型',
    )}</span>`
  }
  const options =
    `<option value=""${chosen === '' ? ' selected' : ''}>${escapeHtml(noneWord(direction))}</option>` +
    fitting
      .map(one => {
        const value = optionValue(one)
        return (
          `<option value="${attr(value)}" data-profile="${attr(one.profileId)}" ` +
          `data-model="${attr(one.modelId)}" data-efforts="${attr(one.efforts.join(' '))}"` +
          `${value === chosen ? ' selected' : ''}>` +
          `${escapeHtml(modelWord(one))}${one.evaluated ? '' : ' · 未评估'}</option>`
        )
      })
      .join('')
  return (
    `<span class="sel route-sel"><select class="input" id="route-${direction}" ` +
    `name="route-${direction}" aria-label="${attr(wordOf(direction))}">` +
    `${options}</select>${chevron()}</span>`
  )
}

/**
 * The effort select of a tier: the efforts the picked model takes, after
 * 默认. Drawn hidden when there is nothing to choose (following the main
 * model, or a model without efforts) so the script can show it on a change.
 */
function effortPicker(
  direction: ModelDirection,
  chosen: RoutableModelView | undefined,
  effort: TierEffort | null,
): string {
  const efforts = chosen?.efforts ?? []
  const options =
    `<option value=""${effort === null || !efforts.includes(effort) ? ' selected' : ''}>默认</option>` +
    efforts
      .map(
        one =>
          `<option value="${attr(one)}"${one === effort ? ' selected' : ''}>${escapeHtml(EFFORT_WORD[one])}</option>`,
      )
      .join('')
  return (
    `<span class="sel route-effort" id="effort-box-${direction}"${efforts.length === 0 ? ' hidden' : ''}>` +
    `<select class="input" id="effort-${direction}" name="effort-${direction}" ` +
    `aria-label="${attr(`${wordOf(direction)} 推理强度`)}">${options}</select>${chevron()}</span>`
  )
}

function readOf(
  direction: ModelDirection,
  chosen: RoutableModelView | undefined,
  effort: TierEffort | null,
): string {
  if (chosen === undefined) {
    return `<span class="note">${escapeHtml(noneWord(direction))}</span>`
  }
  const strength =
    effort !== null && chosen.efforts.includes(effort)
      ? ` · ${EFFORT_WORD[effort]}`
      : ''
  return (
    `<span class="route-model">${escapeHtml(modelWord(chosen) + strength)}</span>` +
    (chosen.evaluated ? '' : tag('未评估', 'muted'))
  )
}

function rowOf(
  model: TaskModelsCardModel,
  direction: ModelDirection,
  route: ModelRouteView | undefined,
): string {
  const picked =
    route === undefined || route.profileId === null || route.modelId === null
      ? null
      : { profileId: route.profileId, modelId: route.modelId }
  const chosen =
    picked === null
      ? undefined
      : model.snapshot.models.find(
          one =>
            one.profileId === picked.profileId &&
            one.modelId === picked.modelId,
        )
  const value = picked === null ? '' : `${picked.profileId}/${picked.modelId}`
  const effort = route?.effort ?? null
  const tier = (TASK_TIERS as readonly string[]).includes(direction)
  const pick = model.writer
    ? modelPicker(direction, value, model.snapshot.models) +
      (tier && KIND_OF[direction] === 'chat'
        ? effortPicker(direction, chosen, effort)
        : '')
    : readOf(direction, chosen, effort)
  return (
    `<div class="route-row${tier ? '' : ' route-media'}">` +
    `<div class="route-dir"><b>${escapeHtml(wordOf(direction))}</b></div>` +
    `<div class="route-pick">${pick}</div></div>`
  )
}

function groupOf(
  model: TaskModelsCardModel,
  view: ModelRoutingView,
  title: string,
  directions: readonly ModelDirection[],
): string {
  return (
    `<div class="route-group"><h3 class="route-group-title">${escapeHtml(title)}</h3>` +
    `<div class="route-grid">${directions
      .map(direction =>
        rowOf(
          model,
          direction,
          view.routes.find(one => one.direction === direction),
        ),
      )
      .join('')}</div></div>`
  )
}

function scopeOf(model: TaskModelsCardModel): string {
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
    `<form class="route-scope" method="get" action="${attr(model.scopeAction ?? '/admin/providers')}" id="routing-scope">` +
    `<label class="sr-only" for="routing-node">范围</label>` +
    `<span class="sel"><select class="input" id="routing-node" name="routing">${options}</select>${chevron()}</span>` +
    `<noscript><button type="submit" class="btn btn-secondary btn-small">切换</button></noscript>` +
    `</form>`
  )
}

function recentOf(model: TaskModelsCardModel): string {
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
        `<b>${escapeHtml(wordOf(one.direction))}</b>` +
        `<span class="note">${escapeHtml(SOURCE_WORD[one.source])}</span>` +
        `<span class="kit-mono">${escapeHtml(one.model)}</span></li>`,
    )
    .join('')
  return (
    `<details class="route-recent"><summary>${chevron()}最近 ${escapeHtml(String(recent.length))} 次分派</summary>` +
    `<ul>${items}</ul></details>`
  )
}

/**
 * The nodes this scope's split reaches on the next apply: the one node, or
 * every managed node without a split of its own.
 */
function reachedOf(model: TaskModelsCardModel): readonly string[] {
  if (model.node !== null) {
    return model.managed.includes(model.node) ? [model.node] : []
  }
  return model.managed.filter(
    name => !model.snapshot.nodes.some(one => one.node === name),
  )
}

/**
 * 下发: saving changes the hub's book only; a node takes the split inside an
 * apply. The button carries the revision drawn, so the hub refuses it if the
 * book has moved on since (`routingRevision`). The page script for the 模型
 * area runs it and follows the switch in 切换进度.
 */
function shipOf(model: TaskModelsCardModel, view: ModelRoutingView): string {
  const reached = reachedOf(model)
  if (reached.length === 0) {
    return `<span class="note">${escapeHtml(
      model.node === null
        ? '没有跟随这份分工的托管节点 · 无需下发'
        : `${model.node} 不受托管 · 先给它指派模型服务`,
    )}</span>`
  }
  return (
    `<button type="button" class="btn btn-secondary btn-small" id="routing-ship" ` +
    `data-action="prov-apply-routing" data-nodes="${attr(reached.join(' '))}" ` +
    `data-revision="${attr(String(view.revision))}" data-write>` +
    `${escapeHtml(`下发到 ${reached.length} 台节点`)}</button>`
  )
}

/**
 * The whole 任务模型 card; the fragment `/fragments/routing?node=` answers
 * the same markup for another scope. Its page script is `ROUTING_PAGE_JS`
 * (`view/routingScript.ts`), its sheet {@link ROUTING_CSS}; the 下发 button
 * is run by the 模型 area's script (`prov-apply-routing`).
 */
export function renderTaskModelsCard(model: TaskModelsCardModel): string {
  const { view, own } = viewOf(model)
  const scopeNote =
    model.node === null
      ? '子会话按难度选模型；没设的跟随主模型'
      : own
        ? `${model.node} 用自己的设置 · 其余节点不受影响`
        : `${model.node} 现在跟随所有节点的设置 · 保存后它单独生效`
  const updated =
    view.updatedAt === null
      ? ''
      : `<span class="note">${escapeHtml(
          `${formatRelative(view.updatedAt, model.now)}由 ${view.updatedBy ?? '未知'} 修改`,
        )}</span>`
  const auto = model.writer
    ? switchField('auto', '没标难度的任务按内容自动分档', view.auto, {
        id: 'routing-auto',
      })
    : `<span class="note">${view.auto ? '没标难度的任务按内容自动分档' : '没标难度的任务交给主模型'}</span>`
  const clear =
    model.writer && model.node !== null && own
      ? `<button type="button" class="btn btn-ghost btn-small" data-action="routing-clear" ` +
        `data-node="${attr(model.node)}" data-write>回到所有节点的设置</button>`
      : ''
  const save = model.writer
    ? `<button type="submit" class="btn btn-primary btn-small" data-write>保存</button>`
    : ''
  const ship = model.writer ? shipOf(model, view) : ''
  const body =
    `<div class="route-groups">` +
    groupOf(model, view, '任务难度', TASK_TIERS) +
    groupOf(model, view, '生成', MEDIA) +
    `</div>` +
    `<div class="route-foot">${auto}<span class="kit-acts">${clear}${ship}${save}</span></div>` +
    `<p class="note route-status" id="routing-status" role="status"></p>`
  return (
    `<section class="card elev-sm route-card" id="routing" data-node="${attr(model.node ?? '')}">` +
    `<header class="route-head"><div><h2 class="route-title">任务模型</h2>` +
    `<p class="note">${escapeHtml(scopeNote)}</p>${updated}</div>${scopeOf(model)}</header>` +
    (model.writer
      ? `<form id="routing-form" novalidate data-revision="${attr(String(view.revision))}">${body}</form>`
      : body) +
    recentOf(model) +
    `</section>`
  )
}

/** The card's place when the routing book cannot be read. */
export function renderTaskModelsFailure(failure: ConsoleFailure): string {
  return (
    `<section class="card elev-sm route-card" id="routing">` +
    `<header class="route-head"><div><h2 class="route-title">任务模型</h2></div></header>` +
    failureBar(failure, '任务模型') +
    `</section>`
  )
}

export const ROUTING_CSS = `
.route-card { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4) var(--space-6); margin-bottom: var(--space-4); }
.route-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); flex-wrap: wrap; }
.route-title { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: var(--text-16, 16px); margin-bottom: 2px; }
.route-scope .sel { min-width: 180px; }
.route-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: var(--space-3) var(--space-6); }
.route-group { display: flex; flex-direction: column; min-width: 0; }
.route-group-title { font-size: var(--text-12-5, 12.5px); font-weight: 600; color: var(--color-muted); margin: 0 0 2px; }
.route-grid { display: flex; flex-direction: column; }
.route-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px solid var(--color-line); min-width: 0; }
.route-dir { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 0 1 auto; }
.route-dir b { font-weight: 600; font-size: var(--text-13-5, 13.5px); }
.route-pick { display: flex; align-items: center; gap: var(--space-2); flex: 1 1 auto; max-width: 360px; min-width: 0; justify-content: flex-end; }
.route-sel { flex: 1 1 auto; min-width: 0; }
.route-effort { flex: 0 0 88px; }
.route-effort[hidden] { display: none; }
.route-effort select { width: 100%; }
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
@media (max-width: 700px) { .route-row { flex-direction: column; align-items: stretch; } .route-pick { flex-basis: auto; max-width: none; justify-content: stretch; } .route-model { text-align: left; } }
`
