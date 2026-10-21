// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The conversation front's approval cards (P39 §2.1, P40 §6).
 *
 * `/` does not poll approvals (its client refreshes only the chat panels and
 * the stream), so this is a separate, small flow: while the page is visible
 * it asks `GET /v0/approvals?mine=1` every few seconds for requests waiting on
 * this person.
 *
 * ## Where a request shows
 *
 * A request's `contextId` is the chat session it was asked in (the node
 * reads the transcript by it when the request is continued, and the console
 * keeps a session's owner under the same id). So a request for the
 * conversation on screen — `#fx-thread[data-session]` — is drawn as a card
 * at the end of the message flow, the way Claude Desktop puts its permission
 * prompt in the conversation: who asks (the agent's figure and name), what,
 * and 拒绝 / 批准. Requests for other conversations are one line above the
 * composer with the way to the oldest of them. The cards live in their own
 * mount after `#fx-thread` (`#fx-asks`), which the front's client never
 * swaps, so a redraw of the thread leaves a half-typed credential alone.
 *
 * ## What a card says
 *
 * The per-tool table is `approvalCard.ts`, shared with the approvals page:
 * a settings change (P40) is drawn from the hub's card only — area ·
 * setting, the value now and the value after, the role it needs, the panel
 * it lives on — never from the raw input; mail, calendar, 云端电脑, elevated
 * commands and memory keep the facts they always showed, in the same frame.
 * A change that needs an operator shows 需要运维批准 to anybody else,
 * without buttons.
 *
 * ## Deciding
 *
 * 批准 does what the moment needs. The node waits on a decision for at most
 * a minute: while the agent's turn in this conversation still runs
 * (`#fx-thread[data-running]`), 批准 is allow-once and the waiting call goes
 * on. Once the turn has ended, 批准 is the approvals page's 批准并继续
 * (`POST /v0/approvals/<id>/continue`) for a request a new turn can carry,
 * and stays allow-once for a tool the node approves fresh on every call
 * (mail, calendar, memory, 云端电脑, elevated). A decision that needs a
 * fresh personal credential asks for it inside the card
 * (`POST /v0/approvals/auth`, the approval session the admin approvals page
 * uses) and then sends the decision once more. A decided card says so
 * for a moment and goes on the next poll. Nothing takes focus when a card
 * arrives: Enter approves only on a focused 批准. A browser notification
 * goes out once per request the reader may decide, when they have allowed
 * them.
 *
 * Every string goes in as text (`textContent`), with invisible controls
 * shown as their codepoints, as on the approvals page.
 */

import type { Lang } from '../i18n.js'
import { APPROVAL_CARD_JS, CARD_WORDS, type CardWords } from './approvalCard.js'
import { attr, escapeHtml } from './escape.js'

/** The card's own words (`approvalCard.ts`) and the front's around them. */
interface FrontWords {
  readonly approve: string
  readonly deny: string
  readonly credential: string
  readonly needCredential: string
  readonly verifyFailed: string
  readonly failed: string
  readonly approved: string
  /** Approved, and the conversation's turn continued (批准并继续). */
  readonly continuing: string
  readonly denied: string
  /** `{n}`: how many requests. */
  readonly elsewhere: string
  /** `{m}`: how many conversations, `{n}`: how many requests. */
  readonly elsewhereMany: string
  readonly open: string
  readonly notifyTitle: string
  readonly region: string
}

type Words = CardWords & FrontWords

const FRONT_WORDS: Readonly<Record<Lang, FrontWords>> = {
  'zh-CN': {
    approve: '批准',
    deny: '拒绝',
    credential: '个人凭据',
    needCredential: '批准需要 30 分钟内验证过的个人凭据',
    verifyFailed: '验证失败 · 要用当前账号的个人凭据',
    failed: '没有完成 · 稍后再试',
    approved: '已批准',
    continuing: '已批准 · 正在继续',
    denied: '已拒绝',
    elsewhere: '另一个对话有 {n} 项待你批准',
    elsewhereMany: '其他 {m} 个对话有 {n} 项待你批准',
    open: '打开',
    notifyTitle: '需要你确认',
    region: '待你批准',
  },
  en: {
    approve: 'Approve',
    deny: 'Deny',
    credential: 'Personal credential',
    needCredential:
      'Approving needs a personal credential verified in the last 30 minutes',
    verifyFailed: "Verification failed · use this account's credential",
    failed: 'Not completed · try again shortly',
    approved: 'Approved',
    continuing: 'Approved · continuing',
    denied: 'Denied',
    elsewhere: 'Another chat has {n} waiting for your approval',
    elsewhereMany: '{m} other chats have {n} waiting for your approval',
    open: 'Open',
    notifyTitle: 'Needs your confirmation',
    region: 'Waiting for your approval',
  },
  ja: {
    approve: '承認',
    deny: '拒否',
    credential: '個人の認証情報',
    needCredential: '承認には 30 分以内に確認した個人の認証情報が必要です',
    verifyFailed:
      '確認に失敗しました · このアカウントの認証情報を使ってください',
    failed: '完了しませんでした · しばらくしてから再試行してください',
    approved: '承認しました',
    continuing: '承認しました · 続行しています',
    denied: '拒否しました',
    elsewhere: '別のチャットに承認待ちが {n} 件あります',
    elsewhereMany: 'ほかの {m} 件のチャットに承認待ちが {n} 件あります',
    open: '開く',
    notifyTitle: '確認が必要です',
    region: '承認待ち',
  },
}

/** The words the card script reads, for tests and the mount. */
export function frontApprovalWords(lang: Lang): Words {
  return { ...CARD_WORDS[lang], ...FRONT_WORDS[lang] }
}

/** The reader's account role, as far as approving goes. */
export type ApproverRole = 'member' | 'ops'

/**
 * The cards' mount, right after `#fx-thread` in the scroll column. Empty and
 * hidden until the script finds a request for the conversation on screen.
 */
export function frontApprovalCards(lang: Lang, role: ApproverRole): string {
  const w = frontApprovalWords(lang)
  return (
    `<section class="fx-asks" id="fx-asks" aria-label="${attr(w.region)}" ` +
    `aria-live="polite" data-role="${attr(role)}" ` +
    `data-words="${attr(JSON.stringify(w))}" hidden></section>`
  )
}

/** The line above the composer for requests in other conversations. */
export function frontApprovalBar(lang: Lang): string {
  const w = FRONT_WORDS[lang]
  return (
    `<div class="fx-ask-bar" id="fx-ask-bar" hidden>` +
    `<span class="fx-ask-bar-dot" aria-hidden="true"></span>` +
    `<span class="fx-ask-bar-text" id="fx-ask-bar-text" role="status"></span>` +
    `<a class="fx-ask-bar-go" id="fx-ask-bar-go" href="/" data-action="fx-open" data-session="">` +
    `${escapeHtml(w.open)}</a></div>`
  )
}

export const FRONT_APPROVAL_CSS = `
.fx-asks { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 0 0 24px; margin-top: -14px; }
.fx-ask {
  display: grid; gap: 8px; width: min(100%, 560px); box-sizing: border-box; padding: 12px 14px;
  border-radius: 14px; background: var(--color-surface);
  box-shadow: inset 0 0 0 0.5px var(--fx-line), var(--shadow-sm);
  animation: fx-ask-in 180ms ease-out;
}
.fx-ask-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.fx-ask-face { display: inline-flex; flex: none; }
.fx-ask-face .avatar { display: block; width: 20px; height: 20px; }
.fx-ask-title { min-width: 0; font-size: var(--text-13-5); font-weight: 600; overflow-wrap: anywhere; }
.fx-ask-tag {
  flex: none; margin-left: auto; padding: 0 6px; border-radius: 4px; font-size: var(--text-11); line-height: 18px;
  background: var(--fx-field); color: var(--color-muted);
}
.fx-ask-what { margin: 0; font-size: var(--text-13); overflow-wrap: anywhere; }
.fx-ask-rows {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 14px; margin: 0; padding: 8px 10px;
  border-radius: 10px; background: var(--fx-field); font-size: var(--text-13);
}
.fx-ask-rows dt { color: var(--color-muted); white-space: nowrap; }
.fx-ask-rows dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.fx-ask-rows dd.is-next { font-weight: 500; }
.fx-ask-detail {
  max-height: 180px; overflow: auto; margin: 0; padding: 8px 10px; border-radius: 10px; background: var(--fx-field);
  font-family: var(--font-mono); font-size: var(--text-12); white-space: pre-wrap; word-break: break-word;
}
.fx-ask-link { justify-self: start; font-size: var(--text-12); color: var(--color-quiet); }
.fx-ask-link:hover { color: var(--color-text); }
.fx-ask-auth { display: grid; gap: 6px; font-size: var(--text-12); color: var(--color-quiet); }
.fx-ask-status { margin: 0; font-size: var(--text-12); color: var(--color-quiet); }
.fx-ask-status:empty { display: none; }
.fx-ask-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.fx-ask-foot:empty { display: none; }
.fx-ask-note { margin-right: auto; font-size: var(--text-12); color: var(--color-muted); }
.fx-ask.is-done { opacity: 0.72; transition: opacity 160ms ease; }
@keyframes fx-ask-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.fx-ask-bar {
  display: flex; align-items: center; gap: 8px; width: fit-content; max-width: 100%; box-sizing: border-box;
  margin-bottom: 8px; padding: 4px 4px 4px 12px; border-radius: 999px;
  background: var(--fx-field); font-size: var(--text-12); color: var(--color-quiet);
}
.fx-ask-bar-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--color-interactive); }
.fx-ask-bar-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-ask-bar-go {
  flex: none; padding: 2px 10px; border-radius: 999px; color: var(--color-text); font-weight: 500; text-decoration: none;
  transition: background-color 120ms ease;
}
.fx-ask-bar-go:hover { background: var(--fx-hover); }
.fx-ask-bar-go:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .fx-ask { animation: none; } }
`

export const FRONT_APPROVAL_JS = `
(function () {
  'use strict';
${APPROVAL_CARD_JS}
  var qc = window.qianmoConsole;
  var mount = document.getElementById('fx-asks');
  if (!qc || !mount) return;
  var w = {};
  try { w = JSON.parse(mount.getAttribute('data-words') || '{}') || {}; } catch (e) { w = {}; }
  var role = mount.getAttribute('data-role') || 'member';
  var HOLD_MS = 1500;
  var items = [];
  var cards = {};
  var notified = {};
  var seq = 0;
  var uid = 0;
  var shownSession = null;

  function byId(id) { return document.getElementById(id); }
  // Invisible controls read as their codepoints, as on the approvals page.
  function shown(value) {
    var s = String(value == null ? '' : value);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if ((c < 32 && c !== 10 && c !== 9) || (c >= 0x7f && c <= 0x9f) || c === 0x61c ||
          c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) {
        out += '\\\\u' + ('000' + c.toString(16)).slice(-4);
      } else {
        out += s.charAt(i);
      }
    }
    return out;
  }
  function add(parent, tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = shown(text);
    parent.appendChild(el);
    return el;
  }
  function openSession() {
    var thread = byId('fx-thread');
    return (thread && thread.getAttribute('data-session')) || '';
  }
  // The agent's figure as the head draws it, still: it is the agent of the
  // conversation on screen, which is the one the card is in.
  function face() {
    var figure = document.querySelector('#fx-head .fx-head-face .avatar');
    if (!figure) return null;
    var copy = figure.cloneNode(true);
    copy.classList.remove('av-live');
    copy.removeAttribute('role');
    copy.removeAttribute('aria-label');
    copy.setAttribute('aria-hidden', 'true');
    copy.setAttribute('data-state', 'idle');
    var looks = copy.querySelectorAll('.av-look');
    for (var i = 0; i < looks.length; i++) looks[i].remove();
    return copy;
  }

  function build(item, card) {
    var el = document.createElement('article');
    el.className = 'fx-ask';
    el.setAttribute('data-request', item.requestId);
    var titleId = 'fx-ask-title-' + (++uid);
    el.setAttribute('role', 'group');
    el.setAttribute('aria-labelledby', titleId);
    var head = add(el, 'header', 'fx-ask-head');
    var figure = face();
    if (figure) add(head, 'span', 'fx-ask-face').appendChild(figure);
    var title = add(head, 'span', 'fx-ask-title', card.title);
    title.id = titleId;
    if (card.tag) add(head, 'span', 'fx-ask-tag', card.tag);
    if (card.what) add(el, 'p', 'fx-ask-what', card.what);
    if (card.rows.length) {
      var list = add(el, 'dl', 'fx-ask-rows');
      for (var i = 0; i < card.rows.length; i++) {
        add(list, 'dt', '', card.rows[i][0]);
        add(list, 'dd', card.rows[i][2] ? 'is-next' : '', card.rows[i][1]);
      }
    }
    if (card.detail) add(el, 'pre', 'fx-ask-detail', card.detail);
    if (card.page) {
      var link = add(el, 'a', 'fx-ask-link', w.panel || '');
      link.href = card.page;
      link.target = '_blank';
      link.rel = 'noopener';
    }
    if (card.allow || card.deny) {
      var form = add(el, 'form', 'fx-ask-auth');
      form.hidden = true;
      var field = 'fx-ask-cred-' + uid;
      var label = add(form, 'label', '', w.needCredential || '');
      label.htmlFor = field;
      var input = add(form, 'input', 'input');
      input.id = field;
      input.type = 'password';
      input.name = 'credential';
      input.autocomplete = 'off';
      input.setAttribute('aria-label', w.credential || '');
    }
    add(el, 'p', 'fx-ask-status').setAttribute('role', 'status');
    var foot = add(el, 'div', 'fx-ask-foot');
    if (card.note) add(foot, 'span', 'fx-ask-note', card.note);
    if (card.deny) choice(foot, 'deny', w.deny, 'btn btn-secondary btn-small');
    if (card.allow) choice(foot, 'allow-once', w.approve, 'btn btn-primary btn-small');
    return el;
  }
  function choice(parent, value, text, cls) {
    var button = add(parent, 'button', cls, text || '');
    button.type = 'button';
    button.setAttribute('data-ask-choice', value);
    return button;
  }
  function status(entry, text) {
    var line = entry.el.querySelector('.fx-ask-status');
    if (line) line.textContent = shown(text);
  }
  function hold(entry, on) {
    var buttons = entry.el.querySelectorAll('[data-ask-choice]');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = on;
  }

  function stuck() {
    var scroller = byId('fx-scroll');
    return !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
  }

  // Cards for the conversation on screen, the line for the others.
  function place() {
    var here = openSession();
    var moved = here !== shownSession;
    shownSession = here;
    var mine = [];
    var others = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (here && item.contextId === here) mine.push(item);
      else if (approvalCard(item, w, role).allow) others.push(item);
    }
    var stick = stuck();
    var keep = {};
    var now = Date.now();
    for (var m = 0; m < mine.length; m++) keep[mine[m].requestId] = true;
    for (var id in cards) {
      if (!Object.prototype.hasOwnProperty.call(cards, id)) continue;
      var entry = cards[id];
      var fresh = entry.doneAt && now - entry.doneAt < HOLD_MS;
      if (keep[id] || (fresh && !moved)) continue;
      entry.el.remove();
      delete cards[id];
    }
    var added = false;
    for (var n = 0; n < mine.length; n++) {
      var one = mine[n];
      if (cards[one.requestId]) continue;
      var card = approvalCard(one, w, role);
      var el = build(one, card);
      mount.appendChild(el);
      cards[one.requestId] = { el: el, item: one, card: card, doneAt: 0, sending: false, pending: 'allow-once' };
      added = true;
    }
    mount.hidden = !mount.firstChild;
    if (added && stick) {
      var scroller = byId('fx-scroll');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }
    banner(others);
  }

  function banner(others) {
    var bar = byId('fx-ask-bar');
    if (!bar) return;
    if (!others.length) { bar.hidden = true; return; }
    var sessions = {};
    var count = 0;
    for (var i = 0; i < others.length; i++) {
      if (!sessions[others[i].contextId]) { sessions[others[i].contextId] = true; count++; }
    }
    var text = (count > 1 ? (w.elsewhereMany || '') : (w.elsewhere || ''))
      .replace('{m}', String(count)).replace('{n}', String(others.length));
    var line = byId('fx-ask-bar-text');
    // Written only when it changes: the line is a status a reader hears.
    if (line && line.textContent !== text) line.textContent = text;
    var go = byId('fx-ask-bar-go');
    if (go) {
      var first = String(others[0].contextId || '');
      go.setAttribute('href', '/?session=' + encodeURIComponent(first));
      go.setAttribute('data-session', first);
    }
    bar.hidden = false;
  }

  function notify(list) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (notified[item.requestId]) continue;
      notified[item.requestId] = true;
      var card = approvalCard(item, w, role);
      if (!card.allow) continue;
      try { new Notification(w.notifyTitle || '', { body: shown(card.title + (card.summary ? ' · ' + card.summary : '')), tag: item.requestId }); } catch (e) { /* not shown */ }
    }
  }

  function poll() {
    if (document.visibilityState !== 'visible' || (qc.isExpired && qc.isExpired())) return;
    var mine = ++seq;
    qc.sendJson('GET', '/v0/approvals?mine=1').then(function (answer) {
      if (mine !== seq) return;
      var list = ((answer && answer.approvals) || []).filter(function (item) {
        return item && item.status === 'pending' && !item.continuation;
      });
      list.sort(function (a, b) { return a.createdAt - b.createdAt; });
      items = list;
      place();
      notify(list);
    }, function () { /* the next tick tries again */ });
  }

  // Whether the asking agent's turn in this conversation is still going:
  // the node is then waiting on the decision itself (at most a minute).
  function running(item) {
    var thread = byId('fx-thread');
    return !!thread && (thread.getAttribute('data-session') || '') === item.contextId &&
      thread.getAttribute('data-running') === '1';
  }

  // 批准 does what the moment needs. While the turn runs it is allow-once;
  // once the turn has ended (the node stopped waiting), a request that can
  // be carried into a new turn is approved and continued (批准并继续), and
  // one the node approves fresh every time stays allow-once.
  function decide(entry, choice, retried) {
    if (entry.sending || entry.doneAt) return;
    entry.sending = true;
    entry.pending = choice;
    hold(entry, true);
    status(entry, '');
    var item = entry.item;
    var resume = choice === 'allow-once' && entry.card.resume && !running(item);
    var path = '/v0/approvals/' + encodeURIComponent(item.requestId) + (resume ? '/continue' : '');
    var body = resume ? { digest: item.digest } : { digest: item.digest, decision: choice };
    qc.sendJson('POST', path, body).then(function () {
      entry.sending = false;
      entry.doneAt = Date.now();
      entry.el.classList.add('is-done');
      var foot = entry.el.querySelector('.fx-ask-foot');
      if (foot) foot.textContent = '';
      var auth = entry.el.querySelector('.fx-ask-auth');
      if (auth) auth.hidden = true;
      status(entry, choice === 'deny' ? (w.denied || '') : resume ? (w.continuing || '') : (w.approved || ''));
      setTimeout(poll, HOLD_MS + 100);
    }, function (err) {
      entry.sending = false;
      hold(entry, false);
      var auth = entry.el.querySelector('.fx-ask-auth');
      if (err && err.status === 403 && !retried && auth) {
        auth.hidden = false;
        var field = auth.querySelector('input');
        if (field) field.focus({ preventScroll: true });
        // The whole card in view: the field and the buttons under it.
        if (entry.el.scrollIntoView) entry.el.scrollIntoView({ block: 'nearest' });
        status(entry, '');
        return;
      }
      status(entry, (w.failed || '') + (err && err.human ? ' · ' + err.human : ''));
    });
  }

  function verify(entry, choice) {
    var field = entry.el.querySelector('.fx-ask-auth input');
    if (!field) return;
    if (!field.value) { field.focus(); return; }
    var credential = field.value;
    field.value = '';
    hold(entry, true);
    qc.sendJson('POST', '/v0/approvals/auth', { credential: credential }).then(function () {
      var auth = entry.el.querySelector('.fx-ask-auth');
      if (auth) auth.hidden = true;
      hold(entry, false);
      decide(entry, choice, true);
    }, function () {
      hold(entry, false);
      status(entry, w.verifyFailed || '');
      field.focus();
    });
  }

  function entryOf(target) {
    var el = target && target.closest ? target.closest('.fx-ask') : null;
    return el ? cards[el.getAttribute('data-request') || ''] || null : null;
  }

  mount.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('[data-ask-choice]') : null;
    var entry = button ? entryOf(button) : null;
    if (!entry) return;
    var picked = button.getAttribute('data-ask-choice') || '';
    var auth = entry.el.querySelector('.fx-ask-auth');
    if (auth && !auth.hidden) verify(entry, picked);
    else decide(entry, picked, false);
  });
  mount.addEventListener('submit', function (event) {
    event.preventDefault();
    var entry = entryOf(event.target);
    if (entry) verify(entry, entry.pending || 'allow-once');
  });
  // Another conversation on screen: its cards now, without waiting a tick.
  document.addEventListener('qianmo:front-view', function () {
    if (openSession() !== shownSession) place();
  });
  document.addEventListener('visibilitychange', poll);
  window.addEventListener('focus', poll);
  setInterval(poll, 5000);
  poll();
})();
`
