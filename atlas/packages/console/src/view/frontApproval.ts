// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The conversation front's own approval prompt (P39 §2.1).
 *
 * `/` does not poll approvals (its client refreshes only the chat panels and
 * the stream), so this is a separate, small flow: while the page is visible
 * it asks `GET /v0/approvals?mine=1` every few seconds for requests waiting on
 * this person, and shows the oldest as a dialog — what the agent wants to do,
 * 批准本次 or 拒绝. A decision that needs a fresh personal credential asks for
 * it in the same dialog (`POST /v0/approvals/auth`, the approval session the
 * admin approvals page uses) and then sends the decision. A browser
 * notification goes out too when the reader has allowed them. Nothing of the
 * front's layout changes: one dialog and one script, both only when the
 * console has approvals and the reader may approve.
 */

import type { Lang } from '../i18n.js'
import { attr, escapeHtml } from './escape.js'

interface Words {
  readonly title: string
  readonly approve: string
  readonly deny: string
  readonly later: string
  readonly credential: string
  readonly verify: string
  readonly needCredential: string
  readonly failed: string
  readonly agent: string
  readonly expires: string
  readonly command: string
  readonly network: string
  readonly github: string
  readonly other: string
}

const WORDS: Readonly<Record<Lang, Words>> = {
  'zh-CN': {
    title: '需要你确认',
    approve: '批准本次',
    deny: '拒绝',
    later: '稍后',
    credential: '个人凭据',
    verify: '验证并批准',
    needCredential: '批准需要 30 分钟内验证过的个人凭据',
    failed: '没有完成 · 请稍后再试',
    agent: '智能体',
    expires: '到期',
    command: '执行命令',
    network: '联网读取',
    github: 'GitHub 操作',
    other: '工具调用',
  },
  en: {
    title: 'Needs your confirmation',
    approve: 'Approve once',
    deny: 'Deny',
    later: 'Later',
    credential: 'Personal credential',
    verify: 'Verify and approve',
    needCredential:
      'Approving needs a personal credential verified in the last 30 minutes',
    failed: 'Not completed. Try again shortly.',
    agent: 'Agent',
    expires: 'Expires',
    command: 'Run a command',
    network: 'Read from the network',
    github: 'GitHub action',
    other: 'Tool call',
  },
  ja: {
    title: '確認が必要です',
    approve: '今回のみ承認',
    deny: '拒否',
    later: 'あとで',
    credential: '個人の認証情報',
    verify: '確認して承認',
    needCredential: '承認には 30 分以内に確認した個人の認証情報が必要です',
    failed: '完了しませんでした。しばらくしてから再試行してください',
    agent: 'エージェント',
    expires: '期限',
    command: 'コマンドの実行',
    network: 'ネットワークの読み取り',
    github: 'GitHub の操作',
    other: 'ツールの呼び出し',
  },
}

/** The dialog, closed; the script fills it. */
export function frontApprovalDialog(lang: Lang): string {
  const w = WORDS[lang]
  return (
    `<dialog class="dialog fx-approval" id="fx-approval" aria-labelledby="fx-approval-title" ` +
    `data-words="${attr(JSON.stringify(w))}">` +
    `<h2 id="fx-approval-title">${escapeHtml(w.title)}</h2>` +
    `<p class="fx-approval-what" id="fx-approval-what"></p>` +
    `<pre class="fx-approval-detail" id="fx-approval-detail"></pre>` +
    `<p class="fx-approval-meta" id="fx-approval-meta"></p>` +
    `<form class="fx-approval-auth" id="fx-approval-auth" hidden>` +
    `<label for="fx-approval-credential">${escapeHtml(w.needCredential)}</label>` +
    `<input id="fx-approval-credential" name="credential" type="password" class="input" autocomplete="off" required>` +
    `</form>` +
    `<p class="fx-approval-status" id="fx-approval-status" role="status"></p>` +
    `<div class="dialog-actions">` +
    `<button type="button" class="btn btn-secondary" data-approval-choice="later">${escapeHtml(w.later)}</button>` +
    `<button type="button" class="btn btn-secondary" data-approval-choice="deny">${escapeHtml(w.deny)}</button>` +
    `<button type="button" class="btn btn-primary" data-approval-choice="allow-once">${escapeHtml(w.approve)}</button>` +
    `</div></dialog>`
  )
}

export const FRONT_APPROVAL_CSS = `
.fx-approval { width: min(520px, calc(100% - 32px)); }
.fx-approval h2 { margin: 0 0 8px; font-size: 16px; }
.fx-approval-what { margin: 0 0 8px; font-weight: 600; }
.fx-approval-detail { max-height: 180px; overflow: auto; margin: 0 0 8px; padding: 8px 10px; border-radius: 8px; background: var(--color-bg); font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
.fx-approval-detail:empty { display: none; }
.fx-approval-meta, .fx-approval-status { margin: 0 0 8px; font-size: 12.5px; color: var(--color-quiet); }
.fx-approval-auth { display: flex; flex-direction: column; gap: 6px; margin: 0 0 8px; font-size: 12.5px; }
.fx-approval-auth[hidden] { display: none; }
`

export const FRONT_APPROVAL_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  var dialog = document.getElementById('fx-approval');
  if (!qc || !dialog) return;
  var w = {};
  try { w = JSON.parse(dialog.getAttribute('data-words') || '{}'); } catch (e) { w = {}; }
  var current = null;
  var dismissed = {};
  var notified = {};
  var busy = false;

  function text(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }
  function describe(item) {
    var name = String(item.toolName || '');
    var input = item.input || {};
    var tool = name.indexOf('qianmo_elevated_') === 0 ? name.slice(16) : name;
    if (tool === 'bash') return [w.command, String(input.command || '')];
    if (tool === 'web_search') return [w.network, String(input.query || '')];
    if (tool === 'read') return [w.network, String(input.path || input.paths || '')];
    if (tool === 'github') {
      var line = String(input.op || '');
      if (input.repo) line += ' · ' + input.repo;
      if (input.title) line += ' · ' + input.title;
      return [w.github, line];
    }
    var detail = '';
    try { detail = JSON.stringify(input, null, 2); } catch (e) { detail = ''; }
    if (detail.length > 1200) detail = detail.slice(0, 1200) + '…';
    return [(w.other || '') + ' · ' + name, detail];
  }
  function show(item) {
    current = item;
    var parts = describe(item);
    text('fx-approval-what', parts[0]);
    text('fx-approval-detail', parts[1]);
    var agent = String(item.agent || '').replace(/^qianmo:\\/\\//, '');
    text('fx-approval-meta', (w.agent || '') + ' ' + agent + ' · ' + (w.expires || '') + ' ' +
      new Date(item.expiresAt).toLocaleTimeString());
    text('fx-approval-status', '');
    var auth = document.getElementById('fx-approval-auth');
    if (auth) auth.hidden = true;
    if (!dialog.open) dialog.showModal();
    if (!notified[item.requestId] && 'Notification' in window && Notification.permission === 'granted') {
      notified[item.requestId] = true;
      try { new Notification(w.title || '', { body: parts[0] + (parts[1] ? ' · ' + parts[1].slice(0, 120) : ''), tag: item.requestId }); } catch (e) { /* not shown */ }
    }
  }
  function close() {
    current = null;
    if (dialog.open) dialog.close();
  }
  function poll() {
    if (busy || document.visibilityState !== 'visible') return;
    qc.sendJson('GET', '/v0/approvals?mine=1').then(function (answer) {
      var items = ((answer && answer.approvals) || []).filter(function (item) {
        return item.status === 'pending' && !item.continuation && !dismissed[item.requestId];
      });
      items.sort(function (a, b) { return a.createdAt - b.createdAt; });
      if (current && !items.some(function (item) { return item.requestId === current.requestId; })) close();
      if (!current && items.length > 0) show(items[0]);
    }, function () { /* the next tick tries again */ });
  }
  function decide(choice, retried) {
    if (!current) return;
    var item = current;
    busy = true;
    qc.sendJson('POST', '/v0/approvals/' + encodeURIComponent(item.requestId), {
      digest: item.digest, decision: choice
    }).then(function () {
      busy = false;
      dismissed[item.requestId] = true;
      close();
      poll();
    }, function (err) {
      busy = false;
      var auth = document.getElementById('fx-approval-auth');
      var status = err && err.status;
      if (status === 403 && !retried && auth) {
        auth.hidden = false;
        var input = document.getElementById('fx-approval-credential');
        if (input) input.focus();
        text('fx-approval-status', w.needCredential || '');
        dialog.setAttribute('data-pending-choice', choice);
        return;
      }
      text('fx-approval-status', w.failed || '');
    });
  }
  function verifyThenDecide() {
    var input = document.getElementById('fx-approval-credential');
    var choice = dialog.getAttribute('data-pending-choice') || 'allow-once';
    if (!input || !input.value) return;
    var credential = input.value;
    input.value = '';
    qc.sendJson('POST', '/v0/approvals/auth', { credential: credential }).then(function () {
      decide(choice, true);
    }, function () {
      text('fx-approval-status', w.failed || '');
    });
  }
  dialog.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('[data-approval-choice]') : null;
    if (!button || !current) return;
    var choice = button.getAttribute('data-approval-choice');
    if (choice === 'later') {
      dismissed[current.requestId] = true;
      close();
      return;
    }
    var auth = document.getElementById('fx-approval-auth');
    if (auth && !auth.hidden && choice === 'allow-once') {
      verifyThenDecide();
      return;
    }
    decide(choice, false);
  });
  dialog.addEventListener('submit', function (event) {
    event.preventDefault();
    verifyThenDecide();
  });
  dialog.addEventListener('cancel', function () {
    if (current) dismissed[current.requestId] = true;
    current = null;
  });
  document.addEventListener('visibilitychange', poll);
  window.addEventListener('focus', poll);
  setInterval(poll, 5000);
  poll();
})();
`
