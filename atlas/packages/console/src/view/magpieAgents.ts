// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 网关 › 智能体 (P36.5, `harness-backends.md` §4.3): every node's agents with
 * the runtime they run on, their model and its state, one 底层 row per node
 * with the catalog's runtimes, and whether new nodes join magpie on their
 * own. Writers get the selects and buttons, everyone else names and states;
 * failure text is folded under 详情 and only ever reaches writers.
 */

import type { ConsoleFailure } from '../deps.js'
import type {
  MagpieAgentModelView,
  MagpieAgentsNodeView,
  MagpieAgentsSnapshot,
  MagpieAgentView,
  MagpieRuntimeEntryView,
  MagpieRuntimeView,
} from '../directionPorts.js'
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
import { actionButton, emptyState, unwiredCard } from './kit.js'

export type MagpieAgentsSide =
  | { readonly kind: 'ok'; readonly value: MagpieAgentsSnapshot }
  | { readonly kind: 'failed'; readonly failure: ConsoleFailure }
  | { readonly kind: 'unwired' }

export interface MagpieAgentsModel {
  readonly side: MagpieAgentsSide
  readonly writer: boolean
  /** `--chat-default`: the main agent, marked 主. */
  readonly mainAgent: string | null
}

const REASON_WORD: Readonly<Record<string, string>> = {
  'not-installed': '未安装',
  installing: '安装中',
  'install-failed': '安装失败',
  'smoke-failed': '兼容检查未过',
  'no-model': '没有可用模型',
  'no-node': '节点没有 Node.js',
}

const GATEWAY_TAG: Readonly<Record<string, string>> = {
  bound: tag('magpie', 'ok'),
  inherit: tag('跟随缺省档案'),
  profile: tag('其他档案'),
  unmanaged: tag('不托管'),
  absent: tag('模型服务外'),
}

function mono(text: string): string {
  return `<span class="kit-mono">${escapeHtml(text)}</span>`
}

function labelOf(
  catalog: readonly MagpieRuntimeEntryView[],
  id: string,
): string {
  return catalog.find(one => one.id === id)?.label ?? id
}

/** One catalog entry on a node: 已装 vX · 未实测 and its button. */
function runtimeChip(
  node: string,
  runtime: MagpieRuntimeView,
  writer: boolean,
): string {
  const words: string[] = []
  if (runtime.builtin) words.push('内置')
  else if (runtime.removing) words.push('卸载中')
  else if (runtime.installing) words.push('安装中')
  else if (runtime.installed)
    words.push(runtime.version === null ? '已装' : `已装 v${runtime.version}`)
  else words.push('未装')
  if (!runtime.verified) words.push('未实测')
  const failed =
    runtime.failed === null || runtime.installed || runtime.installing
      ? ''
      : ` ${state('bad', '安装失败')}${
          writer && runtime.failed.message !== null
            ? rawDetail(runtime.failed.message)
            : ''
        }`
  const busy = runtime.installing || runtime.removing
  const button =
    !writer || runtime.builtin || busy
      ? ''
      : runtime.installed
        ? actionButton('magpie-runtime-remove', '卸载', {
            tone: 'ghost',
            data: { node, runtime: runtime.id, name: runtime.label },
          })
        : actionButton('magpie-runtime-install', '安装', {
            tone: 'ghost',
            data: { node, runtime: runtime.id, name: runtime.label },
          })
  return (
    `<span class="mg-rt" data-runtime="${attr(runtime.id)}"${busy ? ' data-busy' : ''}>` +
    `<b>${escapeHtml(runtime.label)}</b> ` +
    `${busy ? state('warn', words.join(' · ')) : `<span class="note">${escapeHtml(words.join(' · '))}</span>`}` +
    `${failed}${button}</span>`
  )
}

function select(
  name: string,
  label: string,
  data: Readonly<Record<string, string>>,
  options: string,
): string {
  const attrs = Object.entries(data)
    .map(([key, value]) => ` data-${key}="${attr(value)}"`)
    .join('')
  return (
    `<span class="sel mg-sel"><select class="input" name="${attr(name)}" ` +
    `aria-label="${attr(label)}"${attrs} data-write>${options}</select>${chevron()}</span>`
  )
}

function option(value: string, text: string, selected: boolean): string {
  return `<option value="${attr(value)}"${selected ? ' selected' : ''}>${escapeHtml(text)}</option>`
}

function runtimeCell(
  node: MagpieAgentsNodeView,
  agent: MagpieAgentView,
  catalog: readonly MagpieRuntimeEntryView[],
  writer: boolean,
): string {
  const label = labelOf(catalog, agent.runtime)
  if (!writer || node.state !== 'ok') return escapeHtml(label)
  const installed = node.runtimes.filter(
    runtime => runtime.installed || runtime.id === agent.runtime,
  )
  return select(
    'mg-runtime',
    `${node.node} ${agent.agent} 底层`,
    { node: node.node, agent: agent.agent },
    installed
      .map(runtime =>
        option(runtime.id, runtime.label, runtime.id === agent.runtime),
      )
      .join(''),
  )
}

/** The model choices: 自动 first, then the key's models by family, then groups. */
function modelOptions(
  agent: MagpieAgentView,
  models: readonly MagpieAgentModelView[],
): string {
  const auto = agent.followsNode
    ? '跟随节点主模型'
    : (agent.pick ?? '没有可用模型')
  const chosen = agent.choice.mode === 'manual' ? agent.choice.model : 'auto'
  const groups = new Map<string, MagpieAgentModelView[]>()
  for (const model of models) {
    const name = model.group ? '路由组' : (model.family ?? '其他')
    groups.set(name, [...(groups.get(name) ?? []), model])
  }
  // Routing groups last, whatever order the models came in.
  const routing = groups.get('路由组')
  groups.delete('路由组')
  if (routing !== undefined) groups.set('路由组', routing)
  const missing =
    agent.choice.mode === 'manual' && !models.some(model => model.id === chosen)
      ? option(chosen, chosen, true)
      : ''
  return (
    option('auto', `自动（${auto}）`, chosen === 'auto') +
    missing +
    [...groups]
      .map(
        ([name, rows]) =>
          `<optgroup label="${attr(name)}">${rows
            .map(model => option(model.id, model.id, model.id === chosen))
            .join('')}</optgroup>`,
      )
      .join('')
  )
}

function modelCell(
  node: MagpieAgentsNodeView,
  agent: MagpieAgentView,
  writer: boolean,
): string {
  if (!agent.choosable) return '<span class="note">跟随节点主模型</span>'
  const outside = agent.outOfFamily && agent.choice.mode === 'auto'
  const family = outside ? ` ${tag('系列外', 'warn')}` : ''
  if (writer && node.state === 'ok' && node.gateway === 'bound')
    return (
      select(
        'mg-model',
        `${node.node} ${agent.agent} 模型`,
        { node: node.node, agent: agent.agent },
        modelOptions(agent, node.models),
      ) + family
    )
  const shown =
    agent.choice.mode === 'manual'
      ? agent.choice.model
      : node.gateway === 'bound'
        ? (agent.pick ?? agent.model)
        : agent.model
  const auto =
    agent.choice.mode === 'auto' && node.gateway === 'bound'
      ? `<span class="note">自动</span> `
      : ''
  return `${auto}${shown === null ? absent() : mono(shown)}${family}`
}

function statusCell(
  agent: MagpieAgentView,
  catalog: readonly MagpieRuntimeEntryView[],
  writer: boolean,
): string {
  const detail = (message: string | null) =>
    writer && message !== null ? rawDetail(message) : ''
  if (agent.write?.state === 'pending')
    return `<span data-busy>${state('warn', '下发中')}</span>`
  if (agent.write?.state === 'failed')
    return state('bad', '下发失败') + detail(agent.write.message)
  if (agent.reason !== null)
    return (
      state(
        'warn',
        `暂用 ${labelOf(catalog, agent.effective)} · ${
          REASON_WORD[agent.reason.code] ?? '不可用'
        }`,
      ) + detail(agent.reason.message)
    )
  return state('ok', '生效中')
}

function agentRow(
  node: MagpieAgentsNodeView,
  agent: MagpieAgentView,
  catalog: readonly MagpieRuntimeEntryView[],
  model: MagpieAgentsModel,
): string {
  const main =
    model.mainAgent === `qianmo://${node.node}/${agent.agent}`
      ? ` ${tag('主', 'ok')}`
      : ''
  return (
    `<tr data-key="${attr(`${node.node}/${agent.agent}`)}">` +
    `<td>${mono(`${node.node} / ${agent.agent}`)}${main}</td>` +
    `<td>${runtimeCell(node, agent, catalog, model.writer)}</td>` +
    `<td>${modelCell(node, agent, model.writer)}</td>` +
    `<td>${statusCell(agent, catalog, model.writer)}</td>` +
    `</tr>`
  )
}

function nodeHead(
  node: MagpieAgentsNodeView,
  snapshot: MagpieAgentsSnapshot,
  writer: boolean,
): string {
  const tags = [
    GATEWAY_TAG[node.gateway] ?? '',
    node.tenant === null ? '' : tag(`租户 ${node.tenant}`),
  ].join(' ')
  const join =
    writer &&
    snapshot.connected &&
    node.tenant === null &&
    (node.gateway === 'inherit' ||
      node.gateway === 'profile' ||
      node.gateway === 'unmanaged')
      ? actionButton('magpie-join', '接入 magpie', {
          tone: 'ghost',
          data: { node: node.node },
        })
      : ''
  let rest: string
  if (node.state === 'old') rest = state('warn', '节点版本过旧')
  else if (node.state === 'unreachable')
    rest =
      state('bad', '连不上') +
      (writer && node.error !== null ? rawDetail(node.error) : '')
  else
    rest = `<span class="mg-rts">${node.runtimes
      .map(runtime => runtimeChip(node.node, runtime, writer))
      .join('')}</span>`
  return (
    `<tr class="mg-node" data-key="${attr(`node:${node.node}`)}">` +
    `<th scope="rowgroup"><b>${escapeHtml(node.node)}</b> ${tags} ${join}</th>` +
    `<td colspan="3"><span class="note">底层</span> ${rest}</td>` +
    `</tr>`
  )
}

function autoJoinTail(snapshot: MagpieAgentsSnapshot, writer: boolean): string {
  const pill = !snapshot.connected
    ? state('muted', '未连接 magpie')
    : snapshot.autoJoin
      ? state('ok', '新节点自动接入')
      : state('muted', '新节点不自动接入')
  const toggle = writer
    ? actionButton(
        'magpie-autojoin',
        snapshot.autoJoin ? '关闭自动接入' : '打开自动接入',
        { tone: 'ghost', data: { on: snapshot.autoJoin ? '0' : '1' } },
      )
    : ''
  return `<div class="kit-row">${pill}${toggle}</div>`
}

/** The polled 智能体 section of the gateway page. */
export function renderMagpieAgents(model: MagpieAgentsModel): string {
  const side = model.side
  if (side.kind === 'unwired')
    return (
      `<section class="sec" aria-labelledby="h-mg-agents">` +
      sectionHead('Agents', '智能体', { headingId: 'h-mg-agents' }) +
      unwiredCard(
        '节点控制链路',
        '各智能体的底层与模型经控制链路读写',
        'qm console … --control <节点>=<地址>',
      ) +
      `</section>`
    )
  if (side.kind === 'failed') return failureBar(side.failure, '智能体')
  const snapshot = side.value
  const head = sectionHead('Agents', '智能体', {
    headingId: 'h-mg-agents',
    tail: autoJoinTail(snapshot, model.writer),
  })
  const body =
    snapshot.nodes.length === 0
      ? emptyState('还没有节点', '控制链路上的节点列在这里')
      : scroll(
          `<table class="trail mg-table mg-agents"><caption class="sr-only">智能体</caption>` +
            `<thead><tr><th scope="col">智能体</th><th scope="col">底层</th>` +
            `<th scope="col">模型</th><th scope="col">状态</th></tr></thead>` +
            snapshot.nodes
              .map(
                node =>
                  `<tbody>${nodeHead(node, snapshot, model.writer)}${node.agents
                    .map(agent =>
                      agentRow(node, agent, snapshot.catalog, model),
                    )
                    .join('')}</tbody>`,
              )
              .join('') +
            `</table>`,
        )
  return `<section class="sec" aria-labelledby="h-mg-agents">${head}${body}</section>`
}

export const MAGPIE_AGENTS_CSS = `
.mg-agents .mg-node th { text-align: left; font-weight: normal; white-space: nowrap; }
.mg-rts { display: inline-flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); }
.mg-rt { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--text-13); }
.mg-sel { display: inline-block; min-width: 9rem; max-width: 18rem; }
.mg-sel select { width: 100%; }
`
