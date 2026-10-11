// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 文件互通 (P20): files moving between nodes' agents, through the hub.
 *
 * Three things a person does here, top to bottom by urgency: answer the
 * requests waiting on them, watch transfers (and gatherings — 汇集 — of
 * several sources into one agent's inbox) go through their digest checks,
 * and withdraw grants they gave. Paths are workspace-relative; contents
 * never show here.
 */

import type { ConsoleFailure } from '../deps.js'
import type {
  AgentRef,
  FileGrantView,
  FileGroupView,
  FileRequestView,
  FilesSnapshot,
  FileTransferState,
  FileTransferView,
} from '../directionPorts.js'
import {
  chevron,
  failureBar,
  icon,
  sectionHead,
  state,
  tag,
  type Tone,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatBytes, formatDuration, formatRelative } from './format.js'
import {
  actionButton,
  dialogActions,
  dialogTop,
  emptyState,
  selectField,
  textField,
} from './kit.js'

interface FilesModel {
  readonly snapshot: FilesSnapshot
  readonly now: number
  /** May decide, revoke, start and retry (member level). */
  readonly member: boolean
}

const TRANSFER_WORD: Readonly<
  Record<FileTransferState, readonly [Tone, string]>
> = {
  queued: ['muted', '排队中'],
  reading: ['warn', '读取中'],
  verifying: ['warn', '核对中'],
  delivering: ['warn', '送达中'],
  done: ['ok', '已送达'],
  failed: ['bad', '失败'],
}

function addressOf(ref: AgentRef): string {
  return `qianmo://${ref.node}/${ref.agent}`
}

function who(ref: AgentRef): string {
  return `${ref.agent} · ${ref.node}`
}

/** How long a grant has left, in the unit a person would say it in. */
function leftWord(ms: number): string {
  const minutes = Math.ceil(ms / 60_000)
  if (minutes <= 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.round(hours / 24)} 天`
}

function pathChip(path: string): string {
  return `<span class="fx-path kit-mono">${escapeHtml(path === '' ? '/' : path)}</span>`
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function requestCard(request: FileRequestView, model: FilesModel): string {
  const by =
    request.requestedBy === 'agent'
      ? `${who(request.target)} 的智能体申请`
      : `${request.requestedBy} 申请`
  const acts = model.member
    ? `<span class="kit-acts">` +
      actionButton('files-deny', '拒绝', {
        tone: 'ghost',
        data: { id: request.requestId, path: request.path },
      }) +
      actionButton('files-approve', '批准', {
        tone: 'primary',
        data: {
          id: request.requestId,
          path: request.path,
          source: who(request.source),
          target: who(request.target),
        },
      }) +
      `</span>`
    : ''
  return (
    `<article class="card elev-sm fx-request" data-key="${attr(request.requestId)}">` +
    `<div class="fx-flow">` +
    `<div class="fx-end"><span class="note">从</span><b>${escapeHtml(who(request.source))}</b>${pathChip(request.path)}</div>` +
    `<span class="fx-arrow" aria-hidden="true">${icon('arrow-right', { small: true })}</span>` +
    `<div class="fx-end"><span class="note">到</span><b>${escapeHtml(who(request.target))}</b>` +
    `<span class="note">收件箱</span></div>` +
    `</div>` +
    (request.reason === ''
      ? ''
      : `<p class="fx-reason">${escapeHtml(request.reason)}</p>`) +
    `<footer class="fx-foot"><span class="note">${escapeHtml(by)} · ${escapeHtml(
      formatRelative(request.at, model.now),
    )}</span>${acts}</footer>` +
    `</article>`
  )
}

function requestsSection(model: FilesModel): string {
  const pending = model.snapshot.requests.filter(one => one.state === 'pending')
  if (pending.length === 0) return ''
  return (
    `<section class="sec" aria-labelledby="h-fx-req">` +
    sectionHead('Requests', '等你批准', {
      headingId: 'h-fx-req',
      tail: `<span class="note">批准时可以放宽到整个目录 · 默认 1 小时内有效</span>`,
    }) +
    `<div class="fx-requests">${pending.map(one => requestCard(one, model)).join('')}</div>` +
    `</section>`
  )
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

function progress(transfer: FileTransferView): string {
  const total = Math.max(transfer.bytes, 1)
  const done =
    transfer.state === 'done' ? total : Math.min(transfer.doneBytes, total)
  const pct = Math.round((done / total) * 100)
  return (
    `<div class="fx-bar fx-bar-${transfer.state}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">` +
    `<span style="width:${pct}%"></span></div>`
  )
}

function verifiedTag(transfer: FileTransferView): string {
  if (transfer.verified === true) return tag('摘要一致', 'ok')
  if (transfer.verified === false) return tag('摘要不一致', 'bad')
  return ''
}

function transferRow(transfer: FileTransferView, model: FilesModel): string {
  const [tone, word] = TRANSFER_WORD[transfer.state]
  const took =
    transfer.finishedAt === null
      ? ''
      : ` · 用时 ${formatDuration(Math.max(0, transfer.finishedAt - transfer.startedAt))}`
  const retry =
    model.member && transfer.state === 'failed'
      ? actionButton('files-retry', '重试', {
          tone: 'ghost',
          data: { id: transfer.transferId },
        })
      : ''
  // Before the manifest is read there is nothing to count yet.
  const size =
    transfer.manifestSha256 === null && transfer.bytes === 0
      ? '还在清点'
      : `${transfer.files} 个文件 · ${formatBytes(transfer.bytes)}`
  const landed =
    transfer.target.path === null
      ? ''
      : `<span class="note">落在</span>${pathChip(transfer.target.path)}`
  return (
    `<li class="fx-transfer" data-key="${attr(transfer.transferId)}">` +
    `<div class="fx-line"><b>${escapeHtml(who(transfer.source))}</b>${pathChip(transfer.source.path)}` +
    `<span class="fx-arrow" aria-hidden="true">${icon('arrow-right', { small: true })}</span>` +
    `<b>${escapeHtml(who(transfer.target))}</b>${landed}</div>` +
    progress(transfer) +
    `<div class="fx-meta">${state(tone, word)}${verifiedTag(transfer)}` +
    `<span class="note">${escapeHtml(
      `${size}${took} · ${formatRelative(transfer.startedAt, model.now)}`,
    )}</span>` +
    (transfer.reason === null
      ? ''
      : `<span class="note fx-why">${escapeHtml(transfer.reason)}</span>`) +
    retry +
    `</div></li>`
  )
}

function groupBlock(
  group: FileGroupView,
  transfers: readonly FileTransferView[],
  model: FilesModel,
): string {
  const done = transfers.filter(one => one.state === 'done').length
  const failed = transfers.filter(one => one.state === 'failed').length
  return (
    `<div class="card elev-sm fx-group" data-key="${attr(group.groupId)}">` +
    `<header class="fx-group-head"><b>汇集到 ${escapeHtml(who(group.target))}</b>` +
    `<span class="note">${escapeHtml(
      `${transfers.length} 个来源 · ${done} 个完成${failed === 0 ? '' : ` · ${failed} 个失败`} · ${formatRelative(group.createdAt, model.now)}`,
    )}</span></header>` +
    `<ul class="fx-list">${transfers.map(one => transferRow(one, model)).join('')}</ul>` +
    `</div>`
  )
}

function transfersSection(model: FilesModel): string {
  const { transfers, groups } = model.snapshot
  const start = model.member
    ? actionButton('files-new', '发起传输', { glyph: 'plus' })
    : ''
  if (transfers.length === 0) {
    return (
      `<section class="sec" aria-labelledby="h-fx-tr">` +
      sectionHead('Transfers', '传输', { headingId: 'h-fx-tr' }) +
      emptyState(
        '还没有传输',
        '把一个智能体工作区里的文件或目录 · 送进另一个智能体的收件箱 · 几个来源可以一次汇集到一处',
        start,
      ) +
      `</section>`
    )
  }
  const grouped = new Set(groups.flatMap(one => one.transfers))
  const byId = new Map(transfers.map(one => [one.transferId, one]))
  const blocks = groups
    .map(group =>
      groupBlock(
        group,
        group.transfers
          .map(id => byId.get(id))
          .filter((one): one is FileTransferView => one !== undefined),
        model,
      ),
    )
    .join('')
  const single = transfers.filter(one => !grouped.has(one.transferId))
  return (
    `<section class="sec" aria-labelledby="h-fx-tr">` +
    sectionHead('Transfers', '传输', {
      headingId: 'h-fx-tr',
      tail: `<div class="kit-row"><span class="note">每个文件在中枢和收件方各核对一次摘要</span>${start}</div>`,
    }) +
    `<div class="fx-transfers">` +
    blocks +
    (single.length === 0
      ? ''
      : `<div class="card elev-sm fx-group"><ul class="fx-list">${single
          .map(one => transferRow(one, model))
          .join('')}</ul></div>`) +
    `</div></section>`
  )
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

function grantRow(grant: FileGrantView, model: FilesModel): string {
  const live = grant.revokedAt === null && grant.expiresAt > model.now
  const status =
    grant.revokedAt !== null
      ? state('muted', '已撤销')
      : live
        ? state('ok', `还有 ${leftWord(grant.expiresAt - model.now)}`)
        : state('muted', '已过期')
  const revoke =
    model.member && live
      ? actionButton('files-revoke', '撤销', {
          tone: 'ghost',
          data: { id: grant.grantId, path: grant.scope.path },
        })
      : ''
  return (
    `<tr data-key="${attr(grant.grantId)}"${live ? '' : ' class="fx-dead"'}>` +
    `<td><b>${escapeHtml(who(grant.source))}</b></td>` +
    `<td>${pathChip(grant.scope.path)}${grant.scope.kind === 'dir' ? `<span class="note"> 整个目录</span>` : ''}</td>` +
    `<td>${escapeHtml(who(grant.target))}</td>` +
    `<td><span class="kit-mono">${escapeHtml(grant.grantedBy)}</span></td>` +
    `<td>${status}</td>` +
    `<td class="acts">${revoke}</td></tr>`
  )
}

function grantsSection(model: FilesModel): string {
  const grants = model.snapshot.grants
  if (grants.length === 0) return ''
  const head = ['来源', '范围', '给谁', '批准人', '状态', '']
    .map(name => `<th scope="col">${escapeHtml(name)}</th>`)
    .join('')
  return (
    `<section class="sec" aria-labelledby="h-fx-gr">` +
    sectionHead('Grants', '授权', {
      headingId: 'h-fx-gr',
      tail: `<span class="note">有效期内可以再取 · 撤销后立即失效</span>`,
    }) +
    `<div class="scroll"><table class="trail fx-grants"><caption class="sr-only">授权</caption>` +
    `<thead><tr>${head}</tr></thead><tbody>${grants
      .map(one => grantRow(one, model))
      .join('')}</tbody></table></div>` +
    `</section>`
  )
}

/** The polled body. */
export function renderFiles(model: FilesModel): string {
  const limits = model.snapshot.limits
  return (
    requestsSection(model) +
    transfersSection(model) +
    grantsSection(model) +
    `<p class="note fx-limits">${escapeHtml(
      `单个文件不超过 ${formatBytes(limits.maxFileBytes)} · 一次不超过 ${formatBytes(limits.maxTransferBytes)} 或 ${limits.maxFiles} 个文件 · .git .ssh 与命中秘密规则的文件不会传出`,
    )}</p>`
  )
}

export function renderFilesFailure(failure: ConsoleFailure): string {
  return failureBar(failure, '文件互通')
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

const TTL_CHOICES = [
  ['3600000', '1 小时'],
  ['14400000', '4 小时'],
  ['86400000', '24 小时'],
] as const

export function filesDialogs(snapshot: FilesSnapshot): string {
  const agents = snapshot.agents.map(
    one =>
      [
        addressOf(one),
        `${who(one)}${one.reachable ? '' : '（离线）'}`,
      ] as const,
  )
  const approve =
    `<dialog class="dialog" id="files-approve-dialog" aria-labelledby="files-approve-title">` +
    `<form id="files-approve-form" novalidate>` +
    dialogTop('files-approve-title', 'folders', '批准取文件') +
    `<div class="dialog-body form-grid">` +
    `<input type="hidden" name="requestId" value="">` +
    `<div class="recap field-wide"><div class="recap-row"><span class="k">从</span><span id="files-approve-source"></span></div>` +
    `<div class="recap-row"><span class="k">到</span><span id="files-approve-target"></span></div></div>` +
    `<div class="field field-wide"><span class="flabel">范围</span>` +
    `<div class="seg fx-scope" role="radiogroup" aria-label="范围">` +
    `<label class="seg-opt"><input type="radio" name="scopeKind" value="file" checked>只这一项</label>` +
    `<label class="seg-opt"><input type="radio" name="scopeKind" value="dir">整个目录</label></div></div>` +
    textField('scopePath', '路径', {
      wide: true,
      mono: true,
      help: '选「整个目录」时可以改成上一级目录 · 按路径段匹配',
    }) +
    selectField('ttlMs', '有效期', TTL_CHOICES, { selected: '3600000' }) +
    textField('note', '备注', { maxLength: 200, placeholder: '可不填' }) +
    `<p class="note field-wide" id="files-approve-status" role="status"></p>` +
    `</div>` +
    dialogActions('批准', { glyph: 'check' }) +
    `</form></dialog>`
  const start =
    `<dialog class="dialog" id="files-new-dialog" aria-labelledby="files-new-title">` +
    `<form id="files-new-form" novalidate>` +
    dialogTop('files-new-title', 'folders', '发起传输') +
    `<div class="dialog-body form-grid">` +
    `<div class="field field-wide"><span class="flabel">来源</span>` +
    `<div class="fx-sources" id="files-sources">` +
    sourceRow(agents, 0) +
    `</div><button type="button" class="btn btn-ghost btn-small" data-action="files-add-source">` +
    `${icon('plus', { small: true })}再加一个来源 · 汇集</button></div>` +
    selectField('target', '送到', agents, {
      wide: true,
      help: '落在它工作区的 inbox/<来源节点>/ 下 · 同名不覆盖',
    }) +
    `<p class="note field-wide" id="files-new-status" role="status"></p>` +
    `</div>` +
    dialogActions('开始', { glyph: 'check' }) +
    `</form></dialog>`
  const deny =
    `<dialog class="dialog" id="confirm-files-deny" aria-labelledby="confirm-files-deny-title">` +
    dialogTop('confirm-files-deny-title', 'x', '拒绝申请') +
    `<div class="dialog-body"><div class="recap"><div class="recap-row"><span class="k">路径</span>` +
    `<span id="confirm-files-deny-name" class="kit-mono"></span></div></div>` +
    `<p>智能体会收到「被拒绝」· 以后还可以再申请</p></div>` +
    dialogActions('拒绝', { danger: true, action: 'confirm-files-deny' }) +
    `</dialog>` +
    `<dialog class="dialog" id="confirm-files-revoke" aria-labelledby="confirm-files-revoke-title">` +
    dialogTop('confirm-files-revoke-title', 'x', '撤销授权') +
    `<div class="dialog-body"><div class="recap"><div class="recap-row"><span class="k">范围</span>` +
    `<span id="confirm-files-revoke-name" class="kit-mono"></span></div></div>` +
    `<p>立即失效 · 正在进行的传输会停下</p></div>` +
    dialogActions('撤销', { danger: true, action: 'confirm-files-revoke' }) +
    `</dialog>`
  return approve + start + deny
}

/** One source line in the start dialog: agent, path, and a way to look. */
function sourceRow(
  agents: readonly (readonly [string, string])[],
  index: number,
): string {
  const options = agents
    .map(
      ([value, text]) =>
        `<option value="${attr(value)}">${escapeHtml(text)}</option>`,
    )
    .join('')
  return (
    `<div class="fx-source" data-source="${index}">` +
    `<span class="sel"><select class="input" name="sourceAgent" aria-label="来源智能体">${options}</select>${chevron()}</span>` +
    `<input class="input mono" name="sourcePath" placeholder="工作区里的路径 · 例如 reports/2026-10" aria-label="来源路径" autocomplete="off" spellcheck="false">` +
    `<button type="button" class="btn btn-ghost btn-small" data-action="files-browse">浏览</button>` +
    `<div class="fx-browse" hidden></div>` +
    `</div>`
  )
}

export const FILES_PAGE_CSS = `
.fx-requests { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr)); gap: var(--space-3); }
.fx-request { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); }
.fx-flow { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.fx-end { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; flex: 1 1 120px; }
.fx-arrow { color: var(--color-muted); display: inline-flex; }
.fx-path { display: inline-block; max-width: 100%; overflow-wrap: anywhere; font-size: var(--text-12); padding: 1px 6px; border-radius: 6px; background: var(--color-bg); }
.fx-reason { font-size: var(--text-13); line-height: 1.6; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--color-bg); }
.fx-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; }
.fx-transfers { display: flex; flex-direction: column; gap: var(--space-3); }
.fx-group { padding: var(--space-3) var(--space-4); }
.fx-group-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; padding-bottom: var(--space-2); }
.fx-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.fx-transfer { display: flex; flex-direction: column; gap: 6px; padding: var(--space-3) 0; border-top: 1px solid var(--color-divider); }
.fx-transfer:first-child { border-top: 0; }
.fx-line { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--text-13); }
.fx-bar { height: 6px; border-radius: 999px; background: var(--color-bg); overflow: hidden; }
.fx-bar > span { display: block; height: 100%; border-radius: inherit; background: var(--color-accent); transition: width 400ms ease; }
.fx-bar-done > span { background: var(--color-accent-2); }
.fx-bar-failed > span { background: var(--color-critical); opacity: .6; }
@media (prefers-reduced-motion: reduce) { .fx-bar > span { transition: none; } }
.fx-meta { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.fx-why { color: var(--color-critical); }
.fx-dead { opacity: .55; }
.fx-grants td { white-space: nowrap; }
.fx-limits { margin-top: var(--space-4); }
.fx-scope { align-self: flex-start; }
.fx-sources { display: flex; flex-direction: column; gap: var(--space-2); }
.fx-source { display: grid; grid-template-columns: minmax(0, 13em) minmax(0, 1fr) auto; gap: var(--space-2); align-items: center; }
.fx-browse { grid-column: 1 / -1; max-height: 180px; overflow: auto; border-radius: var(--radius-md); background: var(--color-bg); padding: 4px; }
.fx-browse button { display: flex; width: 100%; gap: var(--space-2); align-items: center; padding: 6px 8px; border: 0; background: transparent; border-radius: 8px; font: inherit; font-size: var(--text-13); cursor: pointer; text-align: left; color: inherit; }
.fx-browse button:hover { background: var(--color-surface); }
.fx-browse .note { margin-left: auto; }
@media (max-width: 700px) { .fx-source { grid-template-columns: minmax(0, 1fr) auto; } .fx-source .sel { grid-column: 1 / -1; } }
`
