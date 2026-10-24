// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 网关 › 智能体 (P36.5, `harness-backends.md` §4.3): every node's agents with
 * the runtime they run on, their model and its state, one 底层 row per node
 * with the catalog's runtimes, and whether new nodes join magpie on their
 * own. Writers get the selects and buttons, everyone else names and states;
 * failure text is folded under 详情 and only ever reaches writers.
 *
 * Under each agent on a node with the extension ops, a 「原生扩展」 panel
 * (P36.7, §7.3): plugins, MCP servers and skills as the runtime's own list has
 * them, the pin layer's notes, and the command that opens the runtime's own
 * frontend on the node. The panel is drawn from the hub's cache; opening it
 * asks the node when that is older than a minute (the page script). Installs
 * go through the shared dialog, because a refresh would eat a form in here.
 */

import type { ConsoleFailure } from '../deps.js'
import type {
  AgentModelsSnapshot,
  MagpieAgentModelView,
  MagpieAgentsNodeView,
  MagpieAgentsSnapshot,
  MagpieAgentView,
  MagpieExtensionItemView,
  MagpieExtensionKind,
  MagpieExtensionsView,
  MagpieRuntimeEntryView,
  MagpieRuntimeView,
} from '../directionPorts.js'
import { RUNTIME_FALLBACK_WORDS } from '../directionPorts.js'
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
import { agentModelControls, agentModelsOf } from './agentModels.js'
import { attr, escapeHtml } from './escape.js'
import {
  actionButton,
  emptyState,
  selectField,
  textArea,
  textField,
  unwiredCard,
} from './kit.js'

export type MagpieAgentsSide =
  | { readonly kind: 'ok'; readonly value: MagpieAgentsSnapshot }
  | { readonly kind: 'failed'; readonly failure: ConsoleFailure }
  | { readonly kind: 'unwired' }

export interface MagpieAgentsModel {
  readonly side: MagpieAgentsSide
  readonly writer: boolean
  /** `--chat-default`: the main agent, marked 主. */
  readonly mainAgent: string | null
  /**
   * Each agent's native model fields (`view/agentModels.ts`, §11): where an
   * agent is in it, its 模型 cell is the model picker, effort and 分档 of
   * the model section instead of the gateway's own model select.
   */
  readonly models?: AgentModelsSnapshot | null
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
          RUNTIME_FALLBACK_WORDS[agent.reason.code] ?? '不可用'
        }`,
      ) + detail(agent.reason.message)
    )
  return state('ok', '生效中')
}

const KIND_WORD: Readonly<Record<MagpieExtensionKind, string>> = {
  plugin: '插件',
  mcp: 'MCP',
  skill: '技能',
}

/** The web frontend's port when the open command names one (`--port 8123`), else null. */
function portOf(command: string): number | null {
  const match = /(?:^|\s)--port(?:=|\s+)(\d{1,5})(?=\s|$)/.exec(command)
  const port = match === null ? Number.NaN : Number(match[1])
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

function copyButton(text: string): string {
  return actionButton('magpie-ext-copy', '复制', {
    tone: 'ghost',
    data: { copy: text },
    write: false,
  })
}

function extensionItem(
  view: MagpieExtensionsView,
  item: MagpieExtensionItemView,
  writer: boolean,
  busy: boolean,
): string {
  const facts = [
    item.version === null ? '' : `v${item.version}`,
    item.source ?? '',
  ].filter(Boolean)
  const remove =
    writer && !busy
      ? actionButton('magpie-ext-remove', '卸载', {
          tone: 'ghost',
          data: {
            node: view.node,
            agent: view.agent,
            kind: item.kind,
            name: item.name,
          },
        })
      : ''
  return (
    `<li class="mg-ext-item">${mono(item.name)} ` +
    (item.enabled ? state('ok', '启用') : state('muted', '停用')) +
    (facts.length === 0
      ? ''
      : ` <span class="note">${escapeHtml(facts.join(' · '))}</span>`) +
    (item.notLoaded === null
      ? ''
      : ` <span class="note mg-ext-off">${escapeHtml(item.notLoaded)}</span>`) +
    `${remove}</li>`
  )
}

/** The job line: an install or removal in flight, or the last one that failed. */
function extensionJob(view: MagpieExtensionsView, writer: boolean): string {
  const job = view.job
  if (job === null) return ''
  const what = `${KIND_WORD[job.kind]} ${job.name}`
  if (job.state === 'running')
    return `<span data-busy>${state(
      'warn',
      `${job.op === 'install' ? '安装中' : '卸载中'} · ${what}`,
    )}</span>`
  return (
    state(
      'bad',
      `${job.op === 'install' ? '安装失败' : '卸载失败'} · ${what}`,
    ) + (writer && job.message !== null ? rawDetail(job.message) : '')
  )
}

/** The open command and, for a web frontend on a port, the forwarding line. */
function extensionOpen(node: string, command: string | null): string {
  if (command === null) return ''
  const port = portOf(command)
  const forward =
    port === null ? null : `ssh -L ${port}:127.0.0.1:${port} ${node}`
  return (
    `<div class="mg-ext-open"><code class="kit-mono">${escapeHtml(command)}</code>` +
    `${copyButton(command)}<span class="note">在节点上运行 · 进入该底层的官方前端</span></div>` +
    (forward === null
      ? ''
      : `<div class="mg-ext-open"><code class="kit-mono">${escapeHtml(forward)}</code>` +
        `${copyButton(forward)}<span class="note">网页前端 · 先在本机转发这个端口 · 再打开节点打印的地址</span></div>`)
  )
}

function extensionBody(view: MagpieExtensionsView, writer: boolean): string {
  const busy = view.job?.state === 'running'
  const install =
    writer && !busy
      ? actionButton('magpie-ext-new', '安装扩展', {
          tone: 'ghost',
          data: { node: view.node, agent: view.agent },
        })
      : ''
  const job = extensionJob(view, writer)
  const head =
    job === '' && install === ''
      ? ''
      : `<div class="kit-row">${job}${install}</div>`
  if (view.state === 'unread') return `${head}<p class="note">读取中</p>`
  const failed =
    view.state === 'failed'
      ? `<p>${state('bad', '没读到列表')}${
          writer && view.error !== null ? rawDetail(view.error) : ''
        }</p>`
      : ''
  const groups = (['plugin', 'mcp', 'skill'] as const)
    .map(kind => {
      const items = view.items.filter(item => item.kind === kind)
      return (
        `<div class="mg-ext-group"><span class="note">${KIND_WORD[kind]}</span>` +
        (items.length === 0
          ? ` ${absent()}`
          : `<ul>${items
              .map(item => extensionItem(view, item, writer, busy))
              .join('')}</ul>`) +
        `</div>`
      )
    })
    .join('')
  const notes =
    view.notes.length === 0
      ? ''
      : `<ul class="mg-ext-notes">${view.notes
          .map(note => `<li class="note">${escapeHtml(note)}</li>`)
          .join('')}</ul>`
  return (
    head +
    failed +
    (view.state === 'ok' || view.items.length > 0 ? groups : '') +
    notes +
    extensionOpen(view.node, view.openCommand)
  )
}

/** The 原生扩展 row under an agent; nothing on a node without the ops. */
function extensionsRow(agent: MagpieAgentView, writer: boolean): string {
  const view = agent.extensions
  if (view === null) return ''
  const count =
    view.state === 'ok'
      ? ` <span class="note">${view.items.length} 项</span>`
      : ''
  const busy =
    view.job?.state === 'running'
      ? ` <span data-busy>${state('warn', view.job.op === 'install' ? '安装中' : '卸载中')}</span>`
      : ''
  return (
    `<tr class="mg-ext-row"><td colspan="4">` +
    `<details class="mg-ext" data-key="${attr(`ext:${view.node}/${view.agent}`)}" ` +
    `data-node="${attr(view.node)}" data-agent="${attr(view.agent)}" ` +
    `data-fresh="${view.fresh ? '1' : '0'}">` +
    `<summary><span class="note">原生扩展</span>${count}${busy}</summary>` +
    `<div class="mg-ext-body">${extensionBody(view, writer)}</div>` +
    `</details></td></tr>`
  )
}

/** The dialog body that installs one native extension for an agent. */
export function renderMagpieExtensionForm(target: {
  readonly node: string
  readonly agent: string
}): string {
  return (
    `<input type="hidden" name="form" value="ext">` +
    `<input type="hidden" name="node" value="${attr(target.node)}">` +
    `<input type="hidden" name="agent" value="${attr(target.agent)}">` +
    `<p class="note">${escapeHtml(`${target.node} / ${target.agent}`)} · 由该底层自己的命令安装</p>` +
    `<div class="form-grid">` +
    selectField(
      'extKind',
      '种类',
      [
        ['plugin', '插件'],
        ['mcp', 'MCP'],
        ['skill', '技能'],
      ],
      { wide: true },
    ) +
    textField('source', '来源', {
      wide: true,
      mono: true,
      maxLength: 300,
      placeholder: 'owner/repo · @scope/name@1.2.3 · name@market',
      help: '插件填 · GitHub 仓库 · npm 包名 · 名字@市场 · 技能只收 GitHub 仓库',
    }) +
    textField('name', 'MCP 名字', {
      mono: true,
      maxLength: 64,
      help: '仅 MCP · 字母数字与 _ - · qm- 开头的留给连接器',
    }) +
    textField('command', 'MCP 命令', {
      mono: true,
      maxLength: 256,
      placeholder: 'npx',
      help: '仅 MCP · 与地址二选一',
    }) +
    textArea('args', 'MCP 参数', {
      rows: 3,
      help: '每行一个 · 密钥用连接器存',
    }) +
    textField('url', 'MCP 地址', {
      type: 'url',
      wide: true,
      mono: true,
      maxLength: 500,
      placeholder: 'https://mcp.example.com/mcp',
      help: '仅 MCP · https · 不带账号口令与查询参数',
    }) +
    `</div>`
  )
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
  // The native fields when the hub has them for this agent (§11); the
  // runtime select above may have just moved it, so the runtime must match.
  const native = agentModelsOf(model.models ?? null, node.node, agent.agent)
  const models =
    native !== undefined && native.agent.runtime === agent.runtime
      ? agentModelControls(native.node, native.agent, model.writer)
      : modelCell(node, agent, model.writer)
  return (
    `<tr data-key="${attr(`${node.node}/${agent.agent}`)}">` +
    `<td>${mono(`${node.node} / ${agent.agent}`)}${main}</td>` +
    `<td>${runtimeCell(node, agent, catalog, model.writer)}</td>` +
    `<td>${models}</td>` +
    `<td>${statusCell(agent, catalog, model.writer)}</td>` +
    `</tr>` +
    extensionsRow(agent, model.writer)
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
.mg-rt { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--text-ui); }
.mg-sel { display: inline-block; min-width: 9rem; max-width: 18rem; }
.mg-sel select { width: 100%; }
.mg-ext-row td { padding-top: 0; }
.mg-ext summary { cursor: pointer; display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--text-ui); }
.mg-ext-body { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-2) 0 var(--space-2) var(--space-4); font-size: var(--text-ui); }
.mg-ext-group ul, .mg-ext-notes { margin: 0; padding-left: var(--space-4); }
.mg-ext-item { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.mg-ext-off { font-style: italic; }
.mg-ext-open { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.mg-ext-open code { overflow-wrap: anywhere; }
`
