// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 记忆 (P23): what an agent remembers about the person reading — preferences,
 * plans, projects, the everyday — as cards one can read, correct and forget.
 *
 * Long-term memory is per agent and per account (design review D18), so this
 * page only ever shows the reader's own. The filter is a native GET form
 * (`/memory?agent=&kind=&q=&retired=`): it works without script, and the
 * polled list reads the same query.
 */

import type { ConsoleFailure } from '../deps.js'
import {
  MEMORY_KINDS,
  type AgentRef,
  type MemoryEntryView,
  type MemoryKind,
} from '../directionPorts.js'
import { chevron, failureBar, icon, tag } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatRelative } from './format.js'
import {
  actionButton,
  dialogActions,
  dialogTop,
  emptyState,
  MEMORY_KIND_WORD,
  segmented,
  textArea,
  textField,
  unwiredCard,
} from './kit.js'

export interface MemoryFilter {
  readonly agent: AgentRef | null
  readonly kind: MemoryKind | null
  readonly text: string
  readonly retired: boolean
}

export interface MemoryListModel {
  readonly filter: MemoryFilter
  readonly entries: readonly MemoryEntryView[]
  readonly total: number
  readonly counts: Readonly<Record<MemoryKind, number>>
  readonly now: number
  readonly writer: boolean
}

export function addressOf(ref: AgentRef): string {
  return `qianmo://${ref.node}/${ref.agent}`
}

/** The query string that reproduces a filter, shortest form. */
export function memoryQuery(filter: MemoryFilter): string {
  const params = new URLSearchParams()
  if (filter.agent !== null) params.set('agent', addressOf(filter.agent))
  if (filter.kind !== null) params.set('kind', filter.kind)
  if (filter.text !== '') params.set('q', filter.text)
  if (filter.retired) params.set('retired', '1')
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

const SOURCE_WORD: Readonly<Record<string, string>> = {
  user: '你写的',
  agent: '智能体记下',
  session: '对话里记下',
  archive: '对话归档',
  import: '导入',
}

function card(entry: MemoryEntryView, model: MemoryListModel): string {
  const retired =
    entry.retired !== null ||
    entry.invalidAt !== null ||
    entry.supersededBy !== null
  const kind =
    entry.kind === null
      ? ''
      : tag(MEMORY_KIND_WORD[entry.kind] ?? entry.kind, 'ok')
  const why =
    entry.retired !== null
      ? `<p class="note mem-why">已忘记 · ${escapeHtml(entry.retired.reason)}</p>`
      : entry.supersededBy !== null
        ? `<p class="note mem-why">已改成新的一条</p>`
        : entry.invalidAt !== null
          ? `<p class="note mem-why">已过期</p>`
          : ''
  const data = JSON.stringify({
    id: entry.id,
    kind: entry.kind ?? 'daily',
    title: entry.title,
    summary: entry.summary,
    body: entry.body,
  })
  const actions =
    model.writer && !retired
      ? `<span class="kit-acts">` +
        `<button type="button" class="btn btn-ghost btn-small" data-action="memory-edit" ` +
        `data-memory="${attr(data)}" data-write>编辑</button>` +
        `<button type="button" class="btn btn-ghost btn-small" data-action="memory-forget" ` +
        `data-id="${attr(entry.id)}" data-title="${attr(entry.title)}" data-write>忘记</button>` +
        `</span>`
      : ''
  const body =
    entry.body === '' || entry.body === entry.summary
      ? ''
      : `<details class="mem-more"><summary>${chevron()}全文</summary>` +
        `<p class="mem-body">${escapeHtml(entry.body)}</p></details>`
  return (
    `<article class="card elev-sm mem-card${retired ? ' mem-retired' : ''}" data-key="${attr(entry.id)}">` +
    `<header class="mem-head">${kind}` +
    `<span class="note">${escapeHtml(formatRelative(entry.createdAt, model.now))}</span></header>` +
    `<h3 class="mem-title">${escapeHtml(entry.title)}</h3>` +
    `<p class="mem-summary">${escapeHtml(entry.summary)}</p>` +
    body +
    why +
    `<footer class="mem-foot"><span class="note">` +
    `${escapeHtml(SOURCE_WORD[entry.source.kind] ?? entry.source.kind)}` +
    (entry.scope === 'conversation' ? ' · 只在那次对话里' : '') +
    `</span>${actions}</footer>` +
    `</article>`
  )
}

type CountSlot = MemoryKind | 'all'

function countsOf(
  counts: Readonly<Record<MemoryKind, number>>,
): Readonly<Record<CountSlot, number>> {
  const all = MEMORY_KINDS.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0)
  return { ...counts, all }
}

/** The region the page polls; `data-swap` replaces these ids only. */
export const MEMORY_SWAP = [
  'memory-list',
  'memory-n-all',
  ...MEMORY_KINDS.map(kind => `memory-n-${kind}`),
].join(' ')

/**
 * What `/fragments/memory` answers: the list, and fresh counts for the
 * filter bar (which sits outside the polled region, so typing in its search
 * box is never disturbed by a poll).
 */
export function renderMemoryFragment(
  list: string,
  counts: Readonly<Record<MemoryKind, number>> | null,
): string {
  const fresh =
    counts === null
      ? ''
      : `<div hidden>${Object.entries(countsOf(counts))
          .map(
            ([slot, n]) =>
              `<span class="mem-n" id="memory-n-${slot}">${escapeHtml(String(n))}</span>`,
          )
          .join('')}</div>`
  return `<div id="memory-list">${list}</div>${fresh}`
}

/** The polled list: the cards, or what to do when there are none. */
export function renderMemoryList(model: MemoryListModel): string {
  if (model.filter.agent === null) {
    return emptyState(
      '还没有可以记事的智能体',
      '节点打开记忆后 · 这里列出它为你记下的偏好 计划 项目与日常',
    )
  }
  if (model.entries.length === 0) {
    const filtered = model.filter.kind !== null || model.filter.text !== ''
    return emptyState(
      filtered ? '没有符合条件的记忆' : '还没有长期记忆',
      filtered
        ? '换个类别或关键词再找'
        : '在对话里说一句「记住……」· 或者点「记一条」· 记下的东西会在以后的对话里用上',
    )
  }
  const more =
    model.total > model.entries.length
      ? `<p class="note">还有 ${escapeHtml(String(model.total - model.entries.length))} 条更早的没有列出 · 用关键词缩小范围</p>`
      : ''
  return `<div class="mem-grid">${model.entries.map(one => card(one, model)).join('')}</div>${more}`
}

/** The bar above the list: whose memory, which kind, a search. */
export function renderMemoryBar(
  agents: readonly (AgentRef & { readonly reachable: boolean })[],
  model: Pick<MemoryListModel, 'filter' | 'counts'>,
): string {
  const options = agents
    .map(ref => {
      const value = addressOf(ref)
      const selected =
        model.filter.agent !== null && addressOf(model.filter.agent) === value
      return `<option value="${attr(value)}"${selected ? ' selected' : ''}>${escapeHtml(
        `${ref.agent} · ${ref.node}${ref.reachable ? '' : '（离线）'}`,
      )}</option>`
    })
    .join('')
  const kinds = [
    ['', '全部', 'all'] as const,
    ...MEMORY_KINDS.map(
      kind => [kind, MEMORY_KIND_WORD[kind] ?? kind, kind] as const,
    ),
  ]
  const counts = countsOf(model.counts)
  const chosen = model.filter.kind ?? ''
  return (
    `<form class="mem-bar" id="memory-filter" method="get" action="/memory">` +
    `<label class="sr-only" for="memory-agent">智能体</label>` +
    `<span class="sel"><select class="input" id="memory-agent" name="agent">${options}</select>${chevron()}</span>` +
    `<div class="seg" role="radiogroup" aria-label="类别">${kinds
      .map(
        ([value, text, slot]) =>
          `<label class="seg-opt"><input type="radio" name="kind" value="${attr(value)}"` +
          `${value === chosen ? ' checked' : ''}>${escapeHtml(text)} ` +
          `<span class="mem-n" id="memory-n-${slot}">${counts[slot]}</span></label>`,
      )
      .join('')}</div>` +
    `<label class="sr-only" for="memory-q">找记忆</label>` +
    `<input class="input mem-q" type="search" id="memory-q" name="q" value="${attr(model.filter.text)}" placeholder="找记忆" autocomplete="off">` +
    `<label class="chk mem-retired-toggle"><input type="checkbox" name="retired" value="1"${model.filter.retired ? ' checked' : ''}>` +
    `<span class="bx">${icon('check', { small: true })}</span>含已忘记</label>` +
    `<noscript><button type="submit" class="btn btn-secondary btn-small">筛选</button></noscript>` +
    `</form>`
  )
}

export function renderMemoryUnavailable(
  failure: ConsoleFailure | null,
): string {
  if (failure !== null) return failureBar(failure, '记忆')
  return unwiredCard(
    '长期记忆',
    '节点打开记忆后 · 智能体会记住你的偏好 计划 项目和日常 · 你可以在这里查看 修改和让它忘记',
    'qm console --chat-url <节点>=<地址> --memory',
  )
}

/** The top bar's one action. */
export function memoryNewButton(): string {
  return actionButton('memory-new', '记一条', {
    glyph: 'plus',
    tone: 'primary',
  })
}

export function memoryDialogs(): string {
  return (
    `<dialog class="dialog" id="memory-dialog" aria-labelledby="memory-title">` +
    `<form id="memory-form" novalidate>` +
    dialogTop('memory-title', 'brain', '记一条') +
    `<div class="dialog-body form-grid">` +
    `<input type="hidden" name="memoryId" value="">` +
    segmented(
      'kind',
      '类别',
      MEMORY_KINDS.map(kind => [kind, MEMORY_KIND_WORD[kind] ?? kind] as const),
      'preference',
    ) +
    textField('title', '一句话', {
      required: true,
      wide: true,
      maxLength: 120,
      placeholder: '例如 简报控制在 300 字以内',
    }) +
    textArea('summary', '摘要', {
      required: true,
      rows: 2,
      maxLength: 400,
      help: '以后对话里召回的就是这段',
    }) +
    textArea('body', '细节', { rows: 4, maxLength: 4000 }) +
    `<p class="note field-wide" id="memory-status" role="status"></p>` +
    `</div>` +
    dialogActions('保存', { glyph: 'check' }) +
    `</form></dialog>` +
    `<dialog class="dialog" id="memory-forget-dialog" aria-labelledby="memory-forget-title">` +
    `<form id="memory-forget-form" novalidate>` +
    dialogTop('memory-forget-title', 'x', '忘记这条', true) +
    `<div class="dialog-body form-grid">` +
    `<p class="field-wide"><b id="memory-forget-name"></b></p>` +
    `<input type="hidden" name="memoryId" value="">` +
    textField('reason', '为什么', {
      wide: true,
      maxLength: 200,
      placeholder: '例如 已经换了做法',
      help: '记在审计里 · 智能体以后不会再用这条',
    }) +
    `</div>` +
    dialogActions('忘记', { danger: true }) +
    `</form></dialog>`
  )
}

export const MEMORY_PAGE_CSS = `
.mem-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); margin-bottom: var(--space-4); }
.mem-bar .sel { min-width: 200px; }
.mem-q { flex: 1 1 180px; min-width: 140px; max-width: 280px; }
.mem-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-3); }
.mem-card { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-4); transition: transform 150ms ease, box-shadow 150ms ease; }
.mem-card:hover { transform: translateY(-1px); }
.mem-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.mem-title { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: var(--text-15, 15px); line-height: 1.4; }
.mem-summary { font-size: var(--text-13-5, 13.5px); line-height: 1.6; color: var(--color-muted); }
.mem-body { white-space: pre-wrap; font-size: var(--text-13); line-height: 1.6; padding-top: var(--space-2); }
.mem-more > summary { list-style: none; cursor: pointer; font-size: var(--text-12); color: var(--color-muted); display: inline-flex; align-items: center; gap: 4px; min-height: 0; }
.mem-more > summary::-webkit-details-marker { display: none; }
.mem-more[open] > summary svg { transform: rotate(180deg); }
.mem-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-top: auto; padding-top: var(--space-2); }
.mem-n { color: var(--color-muted); font-variant-numeric: tabular-nums; }
.seg-opt:has(input:checked) .mem-n { color: inherit; opacity: .8; }
.mem-retired { opacity: .55; }
.mem-retired:hover { transform: none; }
@media (max-width: 700px) { .mem-q { max-width: none; } }
`
