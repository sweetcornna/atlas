// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 智能体模型 (`harness-backends.md` §11): every agent's model the way its
 * runtime configures one, drawn after magpie's agents page in the console's
 * own manner. One row per agent: name (the main agent marked 主), runtime, a
 * wide model picker, a narrow effort select, and on Claude Code a 分档 button
 * whose panel holds one row per tier (its model or 同主模型（X）, and its
 * effort under it); opencode's small model sits where the effort would.
 *
 * The model picker is a `<details>` (a redraw keeps it open by its key): 同主模型
 * or 默认 first, then the models of each source (model profile) under its
 * name, a filter that also takes a model id typed in. Every change is sent at
 * once (`agentModelsScript.ts`); a failure puts the old value back and says
 * why under the row. Readers see the values, writers the controls.
 *
 * {@link renderAgentModelsSection} is the whole section (the model page and
 * `/fragments/agents/models`); {@link agentModelControls} is one agent's
 * controls, which the gateway page's agents section puts in its 模型 column.
 */

import type { ConsoleFailure } from '../deps.js'
import type {
  AgentModelFieldView,
  AgentModelsAgentView,
  AgentModelsNodeView,
  AgentModelsSnapshot,
  AgentModelSourceView,
} from '../directionPorts.js'
import { AGENT_EFFORT_WORDS } from '../directionPorts.js'
import {
  absent,
  chevron,
  failureBar,
  rawDetail,
  scroll,
  sectionHead,
  state,
  tag,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { emptyState, unwiredCard } from './kit.js'

export type AgentModelsSide =
  | { readonly kind: 'ok'; readonly value: AgentModelsSnapshot }
  | { readonly kind: 'failed'; readonly failure: ConsoleFailure }
  | { readonly kind: 'unwired' }

export interface AgentModelsSectionModel {
  readonly side: AgentModelsSide
  /** May change agents' models (the model service's writers). */
  readonly writer: boolean
  /** `--chat-default` as `qianmo://<node>/<agent>`: marked 主. */
  readonly mainAgent: string | null
}

/** The polled mount's id and fragment, for pages that place the section. */
const AGENT_MODELS_MOUNT = 'agent-models'
export const AGENT_MODELS_FRAGMENT = '/fragments/agents/models'

function mono(text: string): string {
  return `<span class="kit-mono">${escapeHtml(text)}</span>`
}

/** A model value as shown: its id, without the source in front. */
function bare(value: string): string {
  const slash = value.indexOf('/')
  return slash > 0 ? value.slice(slash + 1) : value
}

function effortWord(level: string): string {
  return AGENT_EFFORT_WORDS[level] ?? level
}

/** What an empty model field runs, in words. */
function emptyWord(field: AgentModelFieldView): string {
  if (field.key === 'model')
    return field.follows === null ? '默认' : `默认（${bare(field.follows)}）`
  if (field.follows === null) return '不设'
  return `同主模型（${bare(field.follows)}）`
}

function fieldOf(
  agent: AgentModelsAgentView,
  key: string,
): AgentModelFieldView | undefined {
  return agent.fields.find(field => field.key === key)
}

function dataOf(
  node: string,
  agent: string,
  field: string,
): Readonly<Record<string, string>> {
  return { node, agent, field }
}

function dataAttrs(data: Readonly<Record<string, string>>): string {
  return Object.entries(data)
    .map(([key, value]) => ` data-${key}="${attr(value)}"`)
    .join('')
}

function pendingTag(field: AgentModelFieldView): string {
  return field.pending ? ` ${tag('节点未收到', 'warn')}` : ''
}

/** The sources a field offers: all of them, or the main model's alone. */
function sourcesFor(
  agent: AgentModelsAgentView,
  field: AgentModelFieldView,
): readonly AgentModelSourceView[] {
  return field.sameSource
    ? agent.sources.filter(source => source.id === agent.source)
    : agent.sources
}

/** The wide model picker: 同主模型 / 默认 first, then each source's models. */
function modelPicker(
  node: string,
  agent: AgentModelsAgentView,
  field: AgentModelFieldView,
): string {
  const sources = sourcesFor(agent, field)
  const current = field.value === '' ? emptyWord(field) : bare(field.value)
  const option = (value: string, text: string, selected: boolean) =>
    `<li><button type="button" class="am-opt" role="option" data-value="${attr(value)}"` +
    `${selected ? ' aria-selected="true"' : ''}>${escapeHtml(text)}</button></li>`
  const known = sources.some(source =>
    source.models.some(model => `${source.id}/${model}` === field.value),
  )
  const groups = sources
    .map(source => {
      const name = source.magpie ? `${source.name} · magpie` : source.name
      return (
        `<li class="am-grp" role="presentation">${escapeHtml(name)}</li>` +
        source.models
          .map(model => {
            const value = `${source.id}/${model}`
            return option(value, model, value === field.value)
          })
          .join('')
      )
    })
    .join('')
  const defaultSource =
    (field.sameSource ? agent.source : (agent.source ?? sources[0]?.id)) ?? ''
  return (
    `<details class="am-pick" data-key="${attr(`am-pick:${node}/${agent.agent}/${field.key}`)}"` +
    `${dataAttrs(dataOf(node, agent.agent, field.key))} data-source="${attr(defaultSource)}"` +
    ` data-sources="${attr(sources.map(source => source.id).join(' '))}">` +
    `<summary class="input am-pick-btn" aria-label="${attr(`${agent.agent} ${field.label}`)}">` +
    `<span class="am-cur" data-am-current>${escapeHtml(current)}</span>${chevron()}</summary>` +
    `<div class="am-pop">` +
    `<input class="input am-filter" type="text" autocomplete="off" spellcheck="false" ` +
    `placeholder="过滤或直接输入模型 id…" aria-label="过滤或直接输入模型 id">` +
    `<ul class="am-opts" role="listbox">` +
    option('', emptyWord(field), field.value === '') +
    (field.value !== '' && !known
      ? option(field.value, bare(field.value), true)
      : '') +
    groups +
    `</ul></div></details>`
  )
}

/** The narrow effort select: 默认 first, then the levels on offer. */
function effortSelect(
  node: string,
  agent: AgentModelsAgentView,
  field: AgentModelFieldView,
): string {
  const levels =
    field.value !== '' && !field.levels.includes(field.value)
      ? [...field.levels, field.value]
      : field.levels
  const options = ['', ...levels]
    .map(
      level =>
        `<option value="${attr(level)}"${level === field.value ? ' selected' : ''}>${escapeHtml(effortWord(level))}</option>`,
    )
    .join('')
  const disabled = field.locked !== null || levels.length === 0
  const title =
    field.locked ?? (levels.length === 0 ? '这个模型没有可选的推理强度' : null)
  return (
    `<span class="sel am-sel"><select class="input" name="am-effort"` +
    ` aria-label="${attr(`${agent.agent} ${field.label}`)}"` +
    `${dataAttrs(dataOf(node, agent.agent, field.key))}` +
    `${title === null ? '' : ` title="${attr(title)}"`}${disabled ? ' disabled' : ''}>` +
    `${options}</select>${chevron()}</span>`
  )
}

/** A field as a reader sees it. */
function fieldText(field: AgentModelFieldView): string {
  if (field.kind === 'effort')
    return field.value === ''
      ? '<span class="note">默认</span>'
      : escapeHtml(effortWord(field.value))
  return field.value === ''
    ? `<span class="note">${escapeHtml(emptyWord(field))}</span>`
    : mono(bare(field.value))
}

/** In magpie's order: the tiers Claude Code resolves, Fable last. */
const TIERS = ['opus', 'sonnet', 'haiku', 'fable'] as const

/**
 * The 分档 button's summary, as magpie writes it: the tiers with a model or
 * an effort of their own, an effort in brackets (`haiku（低） · opus`); none,
 * 同主模型.
 */
export function tiersSummary(agent: AgentModelsAgentView): string {
  const parts: string[] = []
  for (const tier of TIERS) {
    const model = fieldOf(agent, tier)
    const effort = fieldOf(agent, `${tier}_effort`)
    if (model === undefined) continue
    const own = model.value !== ''
    const level = effort?.value ?? ''
    if (!own && level === '') continue
    parts.push(level === '' ? tier : `${tier}（${effortWord(level)}）`)
  }
  return parts.length === 0 ? '同主模型' : parts.join(' · ')
}

/** Claude Code's 分档 panel: one row per tier, its model and its effort under it. */
function tiersPanel(
  node: string,
  agent: AgentModelsAgentView,
  writer: boolean,
): string {
  const rows = TIERS.map(tier => {
    const model = fieldOf(agent, tier)
    const effort = fieldOf(agent, `${tier}_effort`)
    if (model === undefined) return ''
    const effortCell =
      effort === undefined
        ? ''
        : writer
          ? `<div class="am-tier-effort"><span class="note">推理强度</span>${effortSelect(node, agent, effort)}` +
            `${effort.locked === null ? '' : `<span class="note">${escapeHtml(effort.locked)}</span>`}${pendingTag(effort)}</div>`
          : `<div class="am-tier-effort"><span class="note">推理强度</span> ${fieldText(effort)}${pendingTag(effort)}</div>`
    return (
      `<div class="am-tier" data-tier="${attr(tier)}">` +
      `<div class="am-tier-model"><b>${escapeHtml(tier)}</b>` +
      `${writer ? modelPicker(node, agent, model) : fieldText(model)}${pendingTag(model)}</div>` +
      effortCell +
      `</div>`
    )
  }).join('')
  const summary = tiersSummary(agent)
  if (!writer)
    return (
      `<details class="am-tiers" data-key="${attr(`am-tiers:${node}/${agent.agent}`)}">` +
      `<summary class="note">分档 · ${escapeHtml(summary)}</summary>` +
      `<div class="am-pop am-tiers-pop">${rows}</div></details>`
    )
  return (
    `<details class="am-tiers" data-key="${attr(`am-tiers:${node}/${agent.agent}`)}">` +
    `<summary class="btn btn-ghost btn-small" aria-label="${attr(`${agent.agent} 分档`)}">` +
    `分档 · <span data-am-tiers>${escapeHtml(summary)}</span></summary>` +
    `<div class="am-pop am-tiers-pop">${rows}</div></details>`
  )
}

/** The model cell: the picker (or the value), and a reason it is locked. */
function modelCell(
  node: AgentModelsNodeView,
  agent: AgentModelsAgentView,
  writer: boolean,
): string {
  const field = fieldOf(agent, 'model')
  if (field === undefined) return absent()
  if (!writer || node.state !== 'ok' || field.locked !== null)
    return (
      fieldText(field) +
      (field.locked === null || !writer
        ? ''
        : ` <span class="note">${escapeHtml(field.locked)}</span>`)
    )
  return modelPicker(node.node, agent, field)
}

/** The narrow cell: the effort, or opencode's small model. */
function narrowCell(
  node: AgentModelsNodeView,
  agent: AgentModelsAgentView,
  writer: boolean,
): string {
  const effort = fieldOf(agent, 'effort')
  const small = fieldOf(agent, 'small')
  const field = effort ?? small
  if (field === undefined) return '<span class="note">底层不分强度</span>'
  const label = field === small ? '<span class="note">小模型</span> ' : ''
  if (!writer || node.state !== 'ok')
    return `${label}${fieldText(field)}${pendingTag(field)}`
  return (
    label +
    (field.kind === 'effort'
      ? effortSelect(node.node, agent, field)
      : modelPicker(node.node, agent, field)) +
    pendingTag(field)
  )
}

/** The 分档 cell: Claude Code's panel, nothing for the others. */
function tiersCell(
  node: AgentModelsNodeView,
  agent: AgentModelsAgentView,
  writer: boolean,
): string {
  if (fieldOf(agent, 'opus') === undefined) return ''
  return tiersPanel(node.node, agent, writer && node.state === 'ok')
}

/** The write line under a row: the hub's last write that failed, or room for the script's. */
function errorLine(
  node: string,
  agent: AgentModelsAgentView,
  writer: boolean,
): string {
  const failedWrite = agent.write?.state === 'failed' ? agent.write : null
  const text =
    failedWrite === null
      ? ''
      : state('bad', '下发失败') +
        (writer && failedWrite.message !== null
          ? rawDetail(failedWrite.message)
          : '')
  return (
    `<div class="am-err" role="alert" data-am-error="${attr(`${node}/${agent.agent}`)}">` +
    `${text}</div>`
  )
}

/**
 * One agent's controls, for a page that has its own row (the gateway page's
 * agents section): the model picker, the effort (or small model), the 分档
 * button, and the error line.
 */
export function agentModelControls(
  node: AgentModelsNodeView,
  agent: AgentModelsAgentView,
  writer: boolean,
): string {
  const busy =
    agent.write?.state === 'pending'
      ? ` <span data-busy>${state('warn', '下发中')}</span>`
      : ''
  return (
    `<div class="am-cells" data-am-agent="${attr(`${node.node}/${agent.agent}`)}">` +
    `<span class="am-model">${modelCell(node, agent, writer)}</span>` +
    `<span class="am-narrow">${narrowCell(node, agent, writer)}</span>` +
    `${tiersCell(node, agent, writer)}${busy}</div>` +
    errorLine(node.node, agent, writer)
  )
}

/** The agent's controls out of a snapshot, when the node and agent are in it. */
export function agentModelsOf(
  snapshot: AgentModelsSnapshot | null,
  node: string,
  agent: string,
):
  | { readonly node: AgentModelsNodeView; readonly agent: AgentModelsAgentView }
  | undefined {
  const found = snapshot?.nodes.find(one => one.node === node)
  const row = found?.agents.find(one => one.agent === agent)
  return found === undefined || row === undefined
    ? undefined
    : { node: found, agent: row }
}

function nodeHead(node: AgentModelsNodeView, writer: boolean): string {
  let rest = ''
  if (node.state === 'old') rest = state('warn', '节点版本过旧')
  else if (node.state === 'unreachable')
    rest =
      state('bad', '连不上') +
      (writer && node.error !== null ? rawDetail(node.error) : '')
  else if (!node.fields) rest = tag('节点只收模型 · 其余字段升级后补发', 'warn')
  return (
    `<tr class="am-node" data-key="${attr(`am-node:${node.node}`)}">` +
    `<th scope="rowgroup" colspan="5"><b>${escapeHtml(node.node)}</b> ${rest}</th></tr>`
  )
}

function agentRow(
  node: AgentModelsNodeView,
  agent: AgentModelsAgentView,
  model: AgentModelsSectionModel,
): string {
  const main =
    model.mainAgent === `qianmo://${node.node}/${agent.agent}`
      ? ` ${tag('主', 'ok')}`
      : ''
  const busy =
    agent.write?.state === 'pending'
      ? ` <span data-busy>${state('warn', '下发中')}</span>`
      : ''
  return (
    `<tr data-key="${attr(`am:${node.node}/${agent.agent}`)}" data-am-agent="${attr(`${node.node}/${agent.agent}`)}">` +
    `<td>${mono(agent.agent)}${main}</td>` +
    `<td>${escapeHtml(agent.runtimeLabel)}</td>` +
    `<td class="am-model">${modelCell(node, agent, model.writer)}${busy}</td>` +
    `<td class="am-narrow">${narrowCell(node, agent, model.writer)}</td>` +
    `<td>${tiersCell(node, agent, model.writer)}</td>` +
    `</tr>` +
    `<tr class="am-err-row"><td colspan="5">${errorLine(node.node, agent, model.writer)}</td></tr>`
  )
}

/** The 智能体模型 section: every node's agents with their native model fields. */
export function renderAgentModelsSection(
  model: AgentModelsSectionModel,
): string {
  const head = sectionHead('Agent models', '智能体模型', {
    headingId: 'h-agent-models',
  })
  const side = model.side
  if (side.kind === 'unwired')
    return (
      `<section class="sec" aria-labelledby="h-agent-models">${head}` +
      unwiredCard(
        '模型服务与节点控制链路',
        '各智能体的模型经控制链路读写',
        'qm console … --providers <目录> --control <节点>=<地址>',
      ) +
      `</section>`
    )
  if (side.kind === 'failed') return failureBar(side.failure, '智能体模型')
  const nodes = side.value.nodes
  const body =
    nodes.length === 0
      ? emptyState('还没有节点', '控制链路上的节点列在这里')
      : scroll(
          `<table class="trail am-table"><caption class="sr-only">智能体模型</caption>` +
            `<thead><tr><th scope="col">智能体</th><th scope="col">底层</th>` +
            `<th scope="col">模型</th><th scope="col">推理强度</th><th scope="col">分档</th></tr></thead>` +
            nodes
              .map(
                node =>
                  `<tbody>${nodeHead(node, model.writer)}${node.agents
                    .map(agent => agentRow(node, agent, model))
                    .join('')}</tbody>`,
              )
              .join('') +
            `</table>`,
        )
  return `<section class="sec" aria-labelledby="h-agent-models">${head}${body}</section>`
}

/** The section in its polled mount, for a page that places it. */
export function agentModelsMount(model: AgentModelsSectionModel): string {
  return (
    `<div class="kit-pane" id="${AGENT_MODELS_MOUNT}" data-poll="${AGENT_MODELS_FRAGMENT}">` +
    `${renderAgentModelsSection(model)}</div>`
  )
}

export const AGENT_MODELS_CSS = `
.am-table .am-node th { text-align: left; font-weight: normal; white-space: nowrap; }
.am-cells { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.am-model { min-width: 12rem; }
.am-pick { position: relative; display: inline-block; min-width: 12rem; max-width: 22rem; width: 100%; }
.am-pick > summary { list-style: none; display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); cursor: pointer; }
.am-pick > summary::-webkit-details-marker { display: none; }
.am-cur { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, monospace); font-size: var(--text-ui); }
.am-pop { position: absolute; z-index: 20; left: 0; top: calc(100% + 4px); min-width: 100%; max-width: 28rem; padding: var(--space-1); border: 0; border-radius: var(--radius-panel); background: var(--ui-menu); box-shadow: var(--shadow-lg); }
.am-filter { width: 100%; margin-bottom: var(--space-2); }
.am-opts { list-style: none; margin: 0; padding: 0; max-height: 18rem; overflow-y: auto; }
.am-grp { padding: var(--space-2) var(--space-2) 2px; font-size: var(--text-small); color: var(--color-quiet); }
.am-opt { display: block; width: 100%; min-height: var(--control-h); padding: 4px var(--space-2); border: 0; border-radius: var(--radius-control); background: none; text-align: left; font-family: var(--font-mono, monospace); font-size: var(--text-ui); cursor: pointer; overflow-wrap: anywhere; }
.am-opt:hover, .am-opt:focus-visible { background: var(--ui-hover); }
.am-opt[aria-selected="true"] { font-weight: 600; }
.am-narrow .am-pick { min-width: 9rem; }
.am-sel { display: inline-block; min-width: 6rem; max-width: 9rem; }
.am-sel select { width: 100%; }
.am-tiers { position: relative; display: inline-block; }
.am-tiers > summary { list-style: none; cursor: pointer; white-space: nowrap; }
.am-tiers > summary::-webkit-details-marker { display: none; }
.am-tiers-pop { min-width: 22rem; display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3); }
.am-tier { display: flex; flex-direction: column; gap: var(--space-1, 4px); }
.am-tier-model, .am-tier-effort { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.am-tier-model b { min-width: 3.5rem; font-weight: 600; }
.am-err:empty { display: none; }
.am-err { font-size: var(--text-ui); padding: 2px 0; }
.am-err-row td { padding-top: 0; padding-bottom: 0; border-top: 0; }
`

export { AGENT_MODELS_JS } from './agentModelsScript.js'
