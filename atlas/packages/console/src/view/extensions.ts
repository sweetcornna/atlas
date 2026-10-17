// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 扩展 (P32): MCP connectors, skills and plugins the operator installs for
 * agents. Each card says what it is, which agents get it and, one line per
 * node, how it landed there; an agent it failed for is named under its node.
 * Secret values stay on the hub; the page shows names only.
 */

import type { ConsoleFailure } from '../deps.js'
import type {
  ExtensionKind,
  ExtensionNodeState,
  ExtensionsSnapshot,
  ExtensionView,
} from '../directionPorts.js'
import { failureBar, icon, sectionHead, state } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import {
  actionButton,
  dialogActions,
  dialogTop,
  emptyState,
  selectField,
  textArea,
  textField,
  unwiredCard,
} from './kit.js'

export type ExtensionsSide =
  | { readonly kind: 'ok'; readonly value: ExtensionsSnapshot }
  | { readonly kind: 'failed'; readonly failure: ConsoleFailure }
  | { readonly kind: 'unwired' }

export interface ExtensionsModel {
  readonly side: ExtensionsSide
  /** May add, change and remove extensions (ops level). */
  readonly ops: boolean
}

const KINDS: readonly (readonly [ExtensionKind, string, string, string])[] = [
  ['mcp', 'Connectors', '连接器', 'plug'],
  ['skill', 'Skills', '技能', 'sparkles'],
  ['plugin', 'Plugins', '插件', 'puzzle'],
]

const TRANSPORT: Readonly<Record<string, string>> = {
  stdio: '本地命令',
  http: 'HTTP',
  sse: 'SSE',
}

function agentName(address: string): string {
  const match = /^qianmo:\/\/([^/]+)\/(.+)$/.exec(address)
  return match === null ? address : `${match[2]} · ${match[1]}`
}

function fact(key: string, value: string): string {
  return `<div class="ex-fact"><span class="note">${escapeHtml(key)}</span><span>${value}</span></div>`
}

function mono(text: string): string {
  return `<span class="kit-mono">${escapeHtml(text)}</span>`
}

/** One node: its state, then each agent it failed for and why. */
function nodeRow(node: ExtensionNodeState): string {
  const failed = node.agents.filter(agent => agent.state === 'failed')
  const partly =
    node.state === 'failed' &&
    node.agents.some(agent => agent.state === 'applied')
  const mark =
    node.state === 'applied'
      ? state('ok', '已生效')
      : node.state === 'pending'
        ? state('warn', '下发中')
        : state(partly ? 'warn' : 'bad', partly ? '部分生效' : '失败')
  const why =
    node.state === 'failed' && failed.length > 0
      ? failed.map(agent =>
          agent.detail === null
            ? agent.agent
            : `${agent.agent} · ${agent.detail}`,
        )
      : node.detail === null || node.state === 'applied'
        ? []
        : [node.detail]
  return (
    `<li class="ex-node"><div class="ex-node-head"><span class="kit-mono">${escapeHtml(node.node)}</span>${mark}</div>` +
    why
      .map(line => `<span class="note ex-why">${escapeHtml(line)}</span>`)
      .join('') +
    `</li>`
  )
}

/** Every node the entry goes to, one line each. */
function landing(extension: ExtensionView): string {
  if (!extension.enabled) return state('muted', '已停用')
  if (extension.nodes.length === 0) return state('muted', '没有节点')
  return `<ul class="ex-nodes">${extension.nodes.map(nodeRow).join('')}</ul>`
}

function card(extension: ExtensionView, model: ExtensionsModel): string {
  const facts: string[] = []
  if (extension.kind === 'mcp') {
    facts.push(
      fact('方式', escapeHtml(TRANSPORT[extension.transport ?? 'stdio'] ?? '')),
    )
    if (extension.command !== null)
      facts.push(
        fact('命令', mono([extension.command, ...extension.args].join(' '))),
      )
    if (extension.url !== null) facts.push(fact('地址', mono(extension.url)))
    const keys = [...extension.envKeys, ...extension.headerKeys]
    if (keys.length > 0) facts.push(fact('秘密', mono(keys.join(' · '))))
    facts.push(
      fact('调用', extension.approval === 'ask' ? '每次先问' : '直接运行'),
    )
  }
  if (extension.source !== null)
    facts.push(
      fact(
        '来源',
        mono(
          `${extension.source.repo}${extension.source.path ? `/${extension.source.path}` : ''} @ ${extension.source.commit.slice(0, 7)}`,
        ),
      ),
    )
  else if (extension.kind === 'skill') facts.push(fact('来源', '直接写'))
  facts.push(
    fact(
      '智能体',
      extension.agents.length === 0
        ? '全部'
        : mono(extension.agents.map(agentName).join(' · ')),
    ),
  )
  const acts = model.ops
    ? `<span class="kit-acts">` +
      actionButton('extension-edit', '编辑', {
        tone: 'ghost',
        data: { id: extension.id, kind: extension.kind },
      }) +
      actionButton('extension-toggle', extension.enabled ? '停用' : '启用', {
        tone: 'ghost',
        data: {
          id: extension.id,
          name: extension.name,
          enabled: extension.enabled ? '0' : '1',
        },
      }) +
      actionButton('extension-remove', '删除', {
        tone: 'ghost',
        data: { id: extension.id, name: extension.name },
      }) +
      `</span>`
    : ''
  return (
    `<article class="card elev-sm ex-card" data-key="${attr(extension.id)}">` +
    `<header class="ex-head"><div class="ex-title"><b>${escapeHtml(extension.name)}</b>` +
    (extension.description
      ? `<span class="note">${escapeHtml(extension.description)}</span>`
      : '') +
    `</div></header>` +
    `<div class="ex-facts">${facts.join('')}</div>` +
    `<div class="ex-landing">${landing(extension)}</div>` +
    (acts === '' ? '' : `<footer class="ex-foot">${acts}</footer>`) +
    `</article>`
  )
}

/** The polled body of the page. */
export function renderExtensions(model: ExtensionsModel): string {
  const side = model.side
  if (side.kind === 'unwired')
    return unwiredCard(
      '扩展',
      '给智能体装 MCP 连接器 · 技能与插件',
      'qm console … --extensions',
    )
  if (side.kind === 'failed') return failureBar(side.failure, '扩展')
  return KINDS.map(([kind, kicker, name, glyph]) => {
    const rows = side.value.extensions.filter(one => one.kind === kind)
    const add = model.ops
      ? actionButton('extension-new', `添加${name}`, {
          glyph: 'plus',
          data: { kind },
        })
      : ''
    const body =
      rows.length === 0
        ? emptyState(`还没有${name}`, NOTES[kind], add)
        : `<div class="ex-grid">${rows.map(one => card(one, model)).join('')}</div>`
    return (
      `<section class="sec" aria-labelledby="h-ex-${kind}">` +
      sectionHead(kicker, name, {
        headingId: `h-ex-${kind}`,
        tail: `<div class="kit-row">${icon(glyph, { small: true })}${
          rows.length > 0 ? add : ''
        }</div>`,
      }) +
      body +
      `</section>`
    )
  }).join('')
}

const NOTES: Readonly<Record<ExtensionKind, string>> = {
  mcp: '本地命令或远程地址 · 三种底层都能用',
  skill: '直接写 SKILL.md 或从 GitHub 公开仓库导入',
  plugin: '从 GitHub 公开仓库导入 · 按插件自带的清单加载技能与说明',
}

function agentChecks(
  choices: readonly string[],
  chosen: readonly string[],
): string {
  return (
    `<fieldset class="field field-wide ex-agents"><legend class="flabel">智能体</legend>` +
    `<div class="ex-agent-grid">` +
    choices
      .map(
        address =>
          `<label class="chk"><input type="checkbox" name="agents" value="${attr(address)}"${
            chosen.includes(address) ? ' checked' : ''
          }><span class="bx">${icon('check', { small: true })}</span>${escapeHtml(agentName(address))}</label>`,
      )
      .join('') +
    `</div><span class="note field-help">都不选就是全部智能体</span></fieldset>`
  )
}

function sourceFields(extension: ExtensionView | null): string {
  return (
    textField('repo', 'GitHub 仓库', {
      wide: true,
      mono: true,
      value: extension?.source?.repo ?? '',
      placeholder: 'owner/name',
    }) +
    textField('ref', '分支 · 标签或提交', {
      mono: true,
      value: extension?.source?.ref ?? '',
      placeholder: 'main',
    }) +
    textField('path', '目录', {
      mono: true,
      value: extension?.source?.path ?? '',
      placeholder: 'skills/review',
    })
  )
}

/** The add / edit form body for one kind. */
export function renderExtensionForm(input: {
  readonly kind: ExtensionKind
  readonly extension: ExtensionView | null
  readonly agentChoices: readonly string[]
}): string {
  const { kind, extension } = input
  const head =
    `<input type="hidden" name="extensionId" value="${attr(extension?.id ?? '')}">` +
    `<input type="hidden" name="kind" value="${attr(kind)}">`
  let fields = ''
  if (kind === 'mcp') {
    const transport = extension?.transport ?? 'stdio'
    fields =
      textField('name', '名称', {
        required: true,
        mono: true,
        value: extension?.name ?? '',
        maxLength: 40,
        help: '小写字母 · 数字与连字符',
      }) +
      selectField(
        'transport',
        '方式',
        [
          ['stdio', '本地命令'],
          ['http', 'HTTP'],
          ['sse', 'SSE'],
        ],
        { selected: transport },
      ) +
      `<div class="form-grid field-wide" data-when="transport:stdio">` +
      textField('command', '命令', {
        wide: true,
        mono: true,
        value: extension?.command ?? '',
        placeholder: 'npx',
        help: '只写命令名 · 节点按 PATH 查找',
      }) +
      textArea('args', '参数', {
        value: (extension?.args ?? []).join('\n'),
        rows: 3,
        help: '每行一个',
      }) +
      textArea('env', '环境变量', {
        value: (extension?.envKeys ?? []).join('\n'),
        rows: 3,
        help: '每行 名称=值 · 只写名称沿用已存的值',
      }) +
      `</div>` +
      `<div class="form-grid field-wide" data-when="transport:http,sse">` +
      textField('url', '地址', {
        wide: true,
        mono: true,
        value: extension?.url ?? '',
        help: '远程服务要用 HTTPS',
      }) +
      textArea('headers', '请求头', {
        value: (extension?.headerKeys ?? []).join('\n'),
        rows: 3,
        help: '每行 名称=值 · 只写名称沿用已存的值',
      }) +
      `</div>` +
      selectField(
        'approval',
        '调用',
        [
          ['ask', '每次先问'],
          ['allow', '直接运行'],
        ],
        { selected: extension?.approval ?? 'ask' },
      )
  } else if (kind === 'skill') {
    const from =
      extension === null || extension.source === null ? 'inline' : 'github'
    fields =
      (extension === null
        ? selectField(
            'from',
            '来源',
            [
              ['inline', '直接写'],
              ['github', 'GitHub 仓库'],
            ],
            { selected: from },
          )
        : `<input type="hidden" name="from" value="${from}">`) +
      `<div class="form-grid field-wide" data-when="from:inline">` +
      textField('name', '名称', {
        mono: true,
        value: extension?.name ?? '',
        maxLength: 64,
        help: '小写字母 · 数字与连字符',
      }) +
      textField('description', '用途', {
        wide: true,
        value: extension?.description ?? '',
        maxLength: 1024,
        help: '智能体据此决定何时用它',
      }) +
      textArea('body', '正文', {
        value: extension?.body ?? '',
        rows: 8,
        maxLength: 32768,
      }) +
      `</div>` +
      `<div class="form-grid field-wide" data-when="from:github">` +
      sourceFields(extension) +
      `<p class="note field-wide">目录里要有 SKILL.md · 名称取它的 name</p>` +
      `</div>`
  } else {
    fields =
      sourceFields(extension) +
      textField('name', '名称', {
        mono: true,
        value: extension?.name ?? '',
        maxLength: 64,
        help: '不填取目录名',
      }) +
      `<p class="note field-wide ex-hint">${icon('info', { small: true })}只加载插件里的技能与说明 · 自带的 MCP 服务 · 钩子与工具不加载 · 只装信任的仓库</p>`
  }
  return (
    head +
    `<div class="form-grid">` +
    fields +
    agentChecks(input.agentChoices, extension?.agents ?? []) +
    `<label class="chk field-wide"><input type="checkbox" name="enabled"${
      extension === null || extension.enabled ? ' checked' : ''
    }><span class="bx">${icon('check', { small: true })}</span>启用</label>` +
    `</div>`
  )
}

export function extensionDialogs(): string {
  return (
    `<dialog class="dialog ex-dialog" id="extension-dialog" aria-labelledby="extension-title">` +
    `<form id="extension-form" novalidate>` +
    dialogTop('extension-title', 'puzzle', '添加扩展') +
    `<div class="dialog-body" id="extension-body"></div>` +
    `<p class="note ex-status" id="extension-status" role="status"></p>` +
    dialogActions('保存', { glyph: 'check' }) +
    `</form></dialog>` +
    `<dialog class="dialog" id="confirm-extension-remove" aria-labelledby="confirm-extension-remove-title">` +
    dialogTop('confirm-extension-remove-title', 'x', '删除扩展') +
    `<div class="dialog-body"><div class="recap"><div class="recap-row"><span class="k">名称</span>` +
    `<span id="confirm-extension-remove-name"></span></div></div><p>各节点随后卸下 · 秘密随之删除</p></div>` +
    dialogActions('删除', {
      danger: true,
      action: 'confirm-extension-remove',
    }) +
    `</dialog>`
  )
}

export const EXTENSIONS_PAGE_CSS = `
.ex-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: var(--space-3); }
.ex-card { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); }
.ex-head { display: flex; align-items: center; gap: var(--space-3); }
.ex-title { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.ex-title b { font-size: var(--text-14, 14px); overflow-wrap: anywhere; }
.ex-facts { display: flex; flex-direction: column; gap: 6px; }
.ex-fact { display: flex; justify-content: space-between; gap: var(--space-3); font-size: var(--text-13); min-width: 0; }
.ex-fact .kit-mono { text-align: right; overflow-wrap: anywhere; }
.ex-landing { margin-top: auto; }
.ex-nodes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: var(--text-13); }
.ex-node { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ex-node-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.ex-why { overflow-wrap: anywhere; }
.ex-foot { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2); flex-wrap: wrap; }
.ex-agents { border: 0; padding: 0; margin: 0; }
.ex-agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: var(--space-2); }
.ex-hint { display: flex; gap: 6px; align-items: flex-start; }
.ex-status:empty { display: none; }
.ex-dialog .dialog-body { max-height: min(70vh, 640px); overflow: auto; }
[data-when][hidden] { display: none; }
`
