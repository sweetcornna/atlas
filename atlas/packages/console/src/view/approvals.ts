// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 审批 — the page at `/admin/approvals` and its polled fragment
 * (`routes/approvals.ts`).
 *
 * One column of cards, the requests still waiting first and the decided ones
 * folded under 已处理. A card says what the conversation front's card says —
 * the agent's figure, the per-tool title, the facts (`approvalCard.ts`, the
 * one table both read) — with a status tag, one meta line (node, the way to
 * the conversation, when it lapses), and everything a reviewer may want but a
 * decider does not need folded under 详情: where the request came from, the
 * digest it is bound to and, except for a settings change, the arguments as
 * the node sent them. A settings change is never drawn from its raw input.
 *
 * The actions sit on the right: 批准 (allow-once), 批准 5 分钟 where a
 * window is allowed, 批准并继续, and 拒绝; 撤销授权窗口 once allowed. A
 * member looking at a change that needs ops reads 需要运维批准 and gets no
 * buttons. A signed-in member or operator decides directly (owner,
 * 2026-10-22): no credential is asked for, and a refused decision says why
 * on the status line.
 *
 * A reader who cannot decide (a viewer, a token) gets the audit summary,
 * one card, one row per node.
 */

import type { AvatarSpec } from '../avatar.js'
import type { AccountRole } from '../contracts.js'
import type { ApprovalItem } from '../governance.js'
import { avatarSvg } from './avatar.js'
import {
  approvalCard,
  CARD_WORDS,
  escapeShown,
  SETTINGS_CHANGE_TOOL,
} from './approvalCard.js'
import { chevron, state } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatDateTime, formatRelative } from './format.js'

/** How many decided requests the folded section lists, newest first. */
const DONE_SHOWN = 20

const STATUS: Readonly<
  Record<ApprovalItem['status'], readonly [label: string, tag: string]>
> = {
  pending: ['待审批', 'tag-accent'],
  allowed: ['已批准', 'tag-accent-2'],
  denied: ['已拒绝或撤销', 'tag-neutral'],
  expired: ['已过期', 'tag-neutral'],
  'delivery-unknown': ['投递未确认', 'tag-critical'],
}

interface ApprovalsModel {
  readonly items: readonly ApprovalItem[]
  /** The reader's account role: who may approve a change that needs ops. */
  readonly role: AccountRole
  readonly now: number
  /** The agent's figure, by address. */
  readonly face: (agent: string) => AvatarSpec
}

function facts(rows: readonly (readonly [string, string, boolean?])[]): string {
  return (
    `<dl class="apv-facts">` +
    rows
      .map(
        ([key, value, mono]) =>
          `<dt>${escapeHtml(key)}</dt><dd${mono === true ? ' class="mono"' : ''}>${escapeShown(value)}</dd>`,
      )
      .join('') +
    `</dl>`
  )
}

/** 详情: where the request came from, what it is bound to, the arguments. */
function more(item: ApprovalItem): string {
  const settings = item.toolName === SETTINGS_CHANGE_TOOL
  const id = item.input['id']
  const rows: (readonly [string, string, boolean?])[] = [
    ['智能体', item.agent, true],
    ['会话', item.contextId, true],
  ]
  if (item.origin !== undefined) {
    rows.push(
      ['来源', item.origin.from ?? '本地'],
      ['信任', item.origin.trust],
      ['任务', item.origin.taskId ?? '无', true],
      ['追踪', item.origin.traceId ?? '无', true],
    )
  }
  if (settings && typeof id === 'string') rows.push(['设置项', id, true])
  else if (!settings) rows.push(['工具', item.toolName, true])
  rows.push(['摘要', item.digest, true])
  return (
    `<details class="apv-more" data-key="${attr(`apv-more:${item.requestId}`)}">` +
    `<summary>${chevron()}详情</summary>` +
    facts(rows) +
    (settings
      ? ''
      : `<pre class="apv-json">${escapeShown(JSON.stringify(item.input, null, 2))}</pre>`) +
    `</details>`
  )
}

function actions(
  item: ApprovalItem,
  card: ReturnType<typeof approvalCard>,
): string {
  if (item.status === 'allowed' || item.status === 'delivery-unknown') {
    return (
      `<div class="apv-acts"><button class="btn btn-secondary" data-revoke="${attr(item.requestId)}">` +
      `撤销授权窗口</button></div>`
    )
  }
  if (item.status !== 'pending' || item.continuation !== undefined) return ''
  if (!card.allow && !card.deny)
    return `<p class="apv-hold">${escapeHtml(card.note)}</p>`
  return (
    `<form class="apv-acts" data-approval="${attr(item.requestId)}" data-digest="${attr(item.digest)}">` +
    (card.note === ''
      ? ''
      : `<span class="apv-hold">${escapeHtml(card.note)}</span>`) +
    (card.deny
      ? '<button class="btn btn-ghost btn-danger" name="decision" value="deny">拒绝</button>'
      : '') +
    (card.allow && card.window
      ? '<button class="btn btn-secondary" name="decision" value="allow-window">批准 5 分钟</button>'
      : '') +
    (card.allow
      ? '<button class="btn btn-secondary" name="decision" value="continue">批准并继续</button>' +
        '<button class="btn btn-primary" name="decision" value="allow-once">批准</button>'
      : '') +
    `</form>`
  )
}

function expiry(item: ApprovalItem, now: number): string {
  return (
    `<time datetime="${attr(new Date(item.expiresAt).toISOString())}" ` +
    `title="${attr(formatDateTime(item.expiresAt))}">` +
    `${escapeHtml(formatRelative(item.expiresAt, now))}</time>到期`
  )
}

function itemCard(item: ApprovalItem, model: ApprovalsModel): string {
  const card = approvalCard(item, CARD_WORDS['zh-CN'], model.role)
  const [label, tone] = STATUS[item.status]
  const body =
    (card.what === ''
      ? ''
      : `<p class="apv-what">${escapeShown(card.what)}</p>`) +
    (card.rows.length === 0
      ? ''
      : `<dl class="apv-rows">` +
        card.rows
          .map(
            ([key, value, next]) =>
              `<dt>${escapeHtml(key)}</dt><dd${next === 1 ? ' class="is-next"' : ''}>${escapeShown(value)}</dd>`,
          )
          .join('') +
        `</dl>`) +
    // Anything else's arguments are under 详情, whole.
    (card.detail === '' || card.kind === 'other'
      ? ''
      : `<pre class="apv-detail">${escapeShown(card.detail)}</pre>`) +
    (card.page === ''
      ? ''
      : `<a class="apv-link" href="${attr(card.page)}">${escapeHtml(CARD_WORDS['zh-CN'].panel)}</a>`) +
    (item.continuation === undefined
      ? ''
      : '<p class="apv-hold">继续请求已记录 · 不会自动重发 · 结果见原会话</p>')
  return (
    `<article class="card elev-sm apv-card" data-key="${attr(`apv:${item.requestId}`)}">` +
    `<header class="apv-head">` +
    `<span class="apv-face">${avatarSvg(model.face(item.agent), { size: 28 })}</span>` +
    `<div class="apv-heading"><h2 class="apv-title">${escapeShown(card.title)}</h2>` +
    `<p class="apv-meta">节点 ${escapeShown(item.node)} · ` +
    `<a href="/?session=${attr(encodeURIComponent(item.contextId))}">查看原会话</a> · ` +
    `${expiry(item, model.now)}</p></div>` +
    `<span class="tags">` +
    (card.tag === ''
      ? ''
      : `<span class="tag tag-neutral">${escapeHtml(card.tag)}</span>`) +
    `<span class="tag ${tone}">${escapeHtml(label)}</span></span>` +
    `</header>` +
    (body === '' ? '' : `<div class="apv-body">${body}</div>`) +
    `<div class="apv-foot">${more(item)}${actions(item, card)}</div>` +
    `</article>`
  )
}

const NOTE = '<p class="apv-note">批准绑定确切参数</p>'

/** The polled region for a reader who may decide. */
export function renderApprovals(model: ApprovalsModel): string {
  if (model.items.length === 0)
    return `${NOTE}<p class="bar bar-muted">还没有审批</p>`
  const pending = model.items
    .filter(item => item.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt)
  const done = model.items
    .filter(item => item.status !== 'pending')
    .sort((a, b) => b.createdAt - a.createdAt)
  const shown = done.slice(0, DONE_SHOWN)
  return (
    NOTE +
    (pending.length === 0
      ? '<p class="bar bar-muted">没有待审批的请求</p>'
      : `<div class="apv-list">${pending.map(item => itemCard(item, model)).join('')}</div>`) +
    (done.length === 0
      ? ''
      : `<details class="apv-done" data-key="apv-done">` +
        `<summary>${chevron()}已处理 · ${done.length}</summary>` +
        (done.length > DONE_SHOWN
          ? `<p class="apv-note">只列最近 ${DONE_SHOWN} 项</p>`
          : '') +
        `<div class="apv-list">${shown.map(item => itemCard(item, model)).join('')}</div>` +
        `</details>`)
  )
}

interface AuditReport {
  readonly sources: readonly {
    readonly node: string
    readonly integrity: string
    readonly truncated: boolean
  }[]
  readonly summary?: readonly {
    readonly node: string
    readonly requests: number
    readonly used: number
    readonly refused: number
    readonly pending: number
  }[]
}

/** For a reader who cannot decide: the audit summary, one row per node. */
export function renderApprovalsAudit(report: AuditReport): string {
  const nodes = [
    ...new Set([
      ...report.sources.map(source => source.node),
      ...(report.summary ?? []).map(row => row.node),
    ]),
  ]
  const rows = nodes.map(node => {
    const source = report.sources.find(one => one.node === node)
    const counts = (report.summary ?? []).find(row => row.node === node)
    const intact =
      source !== undefined &&
      (source.integrity === 'intact' || source.integrity === 'empty')
    return (
      `<div class="apv-audit-row">` +
      `<span class="apv-audit-node mono">${escapeShown(node)}</span>` +
      `<span class="apv-audit-counts">` +
      (counts === undefined
        ? '—'
        : `请求 ${counts.requests} · 已使用 ${counts.used} · 拒绝 ${counts.refused} · 待批 ${counts.pending}`) +
      `</span>` +
      `<span class="apv-audit-state">` +
      (source === undefined
        ? ''
        : intact
          ? state('ok', '审计链完整')
          : state('warn', '审计不可用或未通过校验')) +
      (source?.truncated === true
        ? '<span class="tag tag-neutral">仅显示近期记录</span>'
        : '') +
      `</span></div>`
    )
  })
  return (
    '<p class="bar bar-muted">审批需要个人成员或运维账号 · 旧令牌与应急身份不能审批</p>' +
    `<section class="card elev-sm apv-audit" aria-labelledby="apv-audit-title">` +
    `<header class="apv-audit-head"><h2 class="apv-title" id="apv-audit-title">审计汇总</h2>` +
    `<span class="apv-note">每节点最近 500 条 · 只汇总完整审计链</span></header>` +
    (rows.length === 0
      ? '<p class="apv-hold">没有审计来源</p>'
      : rows.join('')) +
    `</section>`
  )
}

/** The page's frame around the polled region: the status line. */
export function approvalsFrame(content: string): string {
  return (
    `<div class="apv-page">` +
    `<p id="approval-status" class="apv-status" role="status"></p>` +
    `<div class="apv" data-poll="/fragments/approvals">${content}</div>` +
    `</div>`
  )
}

export const APPROVALS_PAGE_CSS = `
.apv-page, .apv, .apv-list { display: flex; flex-direction: column; gap: var(--space-3); max-width: 880px; }
/* One request per row (qmo-local.md §3.4), a hairline between rows. */
.apv-list { gap: 0; }
.apv-note { margin: 0; font-size: var(--text-small); color: var(--color-muted); }
.apv-status { margin: 0; font-size: var(--text-small); color: var(--color-quiet); }
.apv-status:empty { display: none; }
.apv-card { gap: var(--space-3); }
.apv-list > .apv-card { padding: var(--space-4) 0; }
.apv-list > .apv-card + .apv-card { border-top: var(--hairline); }
.apv-head { display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; }
.apv-face { display: inline-flex; flex: none; }
.apv-heading { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.apv-title { margin: 0; font-size: var(--text-ui); font-weight: var(--weight-semibold); overflow-wrap: anywhere; }
.apv-meta { margin: 0; font-size: var(--text-small); color: var(--color-muted); }
.apv-meta a { color: var(--color-quiet); }
.apv-meta a:hover { color: var(--color-text); }
.apv-head .tags { flex: none; }
.apv-body, .apv-foot { padding-left: 40px; }
.apv-body { display: flex; flex-direction: column; gap: var(--space-2); }
.apv-what { margin: 0; font-size: var(--text-ui); overflow-wrap: anywhere; }
.apv-rows, .apv-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 14px; margin: 0; }
.apv-rows { padding: var(--space-2) var(--space-3); border-radius: var(--radius-control); background: var(--ui-field); font-size: var(--text-ui); }
.apv-rows dt, .apv-facts dt { color: var(--color-muted); white-space: nowrap; }
.apv-rows dd, .apv-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.apv-rows dd.is-next { font-weight: 500; }
.apv-detail, .apv-json {
  margin: 0; max-height: 180px; overflow: auto; padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control); background: var(--ui-field);
  font-family: var(--font-mono); font-size: var(--text-small); white-space: pre-wrap; word-break: break-word;
}
.apv-link { align-self: flex-start; font-size: var(--text-small); color: var(--color-quiet); }
.apv-link:hover { color: var(--color-text); }
.apv-hold { margin: 0; display: inline-flex; align-items: center; min-height: var(--control-h); font-size: var(--text-small); color: var(--color-muted); }
.apv-foot { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: var(--space-3); }
.apv-more > summary, .apv-done > summary {
  display: inline-flex; align-items: center; gap: 4px; min-height: var(--control-h); cursor: pointer; list-style: none;
  font-size: var(--text-small); color: var(--color-muted); transition: color var(--motion-snap) var(--ease-out);
}
.apv-more > summary::-webkit-details-marker, .apv-done > summary::-webkit-details-marker { display: none; }
.apv-more > summary:hover, .apv-done > summary:hover { color: var(--color-text); }
.apv-more[open] { display: flex; flex-direction: column; gap: var(--space-2); }
.apv-facts { font-size: var(--text-small); }
.apv-acts { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2); flex-wrap: wrap; }
.apv-done > summary { font-size: var(--text-ui); }
.apv-done[open] > summary { margin-bottom: var(--space-3); }
.apv-done[open] > .apv-note { margin-bottom: var(--space-2); }
.apv-audit { gap: 0; padding-top: var(--space-3); padding-bottom: var(--space-2); border-top: var(--hairline); }
.apv-audit-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; padding-bottom: var(--space-2); }
.apv-audit-row {
  display: grid; grid-template-columns: minmax(96px, auto) minmax(0, 1fr) auto; align-items: center; gap: var(--space-3);
  padding: var(--space-2) 0; border-top: var(--hairline); font-size: var(--text-ui);
}
.apv-audit-counts { color: var(--color-quiet); }
.apv-audit-state { display: inline-flex; align-items: center; gap: var(--space-2); }
@media (max-width: 720px) {
  .apv-body, .apv-foot { padding-left: 0; }
  .apv-foot, .apv-audit-row { grid-template-columns: minmax(0, 1fr); }
  .apv-acts { justify-content: flex-start; }
}
`

/**
 * The page script: each decision and each revocation. A refusal is said on
 * the status line, with the reason the console gave. Field names and data
 * attributes are the page's contract with this script.
 */
export const APPROVALS_PAGE_JS = `(function () {
  'use strict';
  var qc = window.qianmoConsole;
  function status(text) {
    var line = document.getElementById('approval-status');
    if (line) line.textContent = text;
  }
  function refused(verb, err) {
    status(verb + '未完成 · ' + (err && err.human ? err.human : '刷新后重试'));
  }
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f.matches('[data-approval]')) return;
    e.preventDefault();
    var button = e.submitter;
    if (!button) return;
    var decision = button.value;
    var continuation = decision === 'continue';
    var buttons = f.querySelectorAll('button');
    buttons.forEach(function (b) { b.disabled = true; });
    var body = { digest: f.dataset.digest, decision: decision };
    if (decision === 'allow-window') body.windowMs = 300000;
    qc.sendJson('POST', '/v0/approvals/' + encodeURIComponent(f.dataset.approval) + (continuation ? '/continue' : ''), body).then(function () {
      location.reload();
    }).catch(function (err) {
      buttons.forEach(function (b) { b.disabled = false; });
      refused('审批', err);
    });
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-revoke]');
    if (!b) return;
    b.disabled = true;
    qc.sendJson('DELETE', '/v0/approvals/' + encodeURIComponent(b.dataset.revoke)).then(function () {
      location.reload();
    }).catch(function (err) {
      b.disabled = false;
      refused('撤销', err);
    });
  });
})();`
