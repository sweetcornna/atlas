// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The shared client runtime, as one string. No framework, no build.
 *
 * Every console page inlines this, followed by the active page's own script
 * (`routes/types.ts`, `PageRoute.script`). The runtime is written once and
 * holds everything two pages would otherwise each write a copy of
 * (`providers-console-m1.md` §6.1): the token, the transport, the confirm
 * dialogs, the polled regions and the refresh switch. A page script reaches it
 * through `window.qianmoConsole` and adds only its own actions.
 *
 * ## What it is allowed to do
 *
 * The list is short on purpose:
 *
 * 1. **Poll for server-rendered fragments and put them on the page.** The
 *    fragments come out of `view/*.ts`, which escaped everything on the way
 *    out, so `innerHTML` here is putting back exactly what the server decided
 *    to emit. That is the *only* thing that is ever assigned to `innerHTML`.
 * 2. **Submit with `fetch`.** Bodies are JSON; every response message,
 *    including every error string, reaches the page through `textContent`.
 * 3. **Carry the token in an `Authorization` header.** Never in a query string
 *    of a request it makes, never rendered into the document.
 * 4. **Send the console header on every request.** See below.
 *
 * The dividing line worth stating out loud: **nothing derived from the URL, a
 * form field, or a JSON response body is ever concatenated into HTML.** The
 * server renders HTML; the client renders text. When those two rules are kept
 * apart there is no place for an injected string to become markup.
 *
 * ## A polled region is declared, not coded
 *
 * A page marks an element `data-poll="<fragment url>"`; the runtime refetches
 * it on the refresh interval. `data-swap="<id> <id>"` narrows the swap to the
 * named descendants, which is how the trail keeps its filter form: replacing
 * the whole audit fragment every five seconds would eat whatever the operator
 * was halfway through typing, so only the header digits and the results swap,
 * lifted out of the fetched HTML through a detached `<template>` (which parses
 * but does not execute). A region that holds text somebody is writing — the
 * server notes — is simply never marked.
 *
 * A non-HTML content type on a fragment is treated as an error rather than
 * rendered — if the HTTP side ever answers one with JSON, the page says so
 * instead of pasting a JSON blob into the document.
 *
 * ## A refresh keeps what the reader was doing (D1)
 *
 * Replacing a region throws away state the server never knew: which rows
 * were expanded, which control had focus. Before every swap the runtime notes
 * the `data-key` of every open `<details>` in the region and describes the
 * focused element (its id, the `data-key` row it sits in, its tag and its
 * identifying `data-*`); after the swap it reopens those rows and puts focus
 * back on the element that matches. A page that wants its rows kept gives
 * them a stable `data-key` — the roster keys each by its address. Each
 * finished refresh bumps the region's `data-refreshed`, which is what a
 * browser-level test waits on.
 *
 * ## The token arrives two ways
 *
 * `#token=` and `?token=`. The fragment never reaches the server and is the one
 * to prefer, but `qm console` prints its banner link with the query form, so a
 * client that only reads the fragment leaves anybody who followed that link
 * unauthenticated from the first poll onward. Either way it is stored and
 * scrubbed out of the address bar immediately.
 *
 * There is a third way in that this script never sees: the login page sets an
 * `HttpOnly` cookie, which the browser attaches by itself and no script can
 * read. That is why every request below carries `CONSOLE_HEADER` whether or not
 * there is a token in `localStorage` — the server requires it of any cookie-
 * authenticated request that is not a plain document read, and a header a
 * cross-origin page cannot set is what makes an ambient credential safe
 * (`auth.ts`). Requests already carrying a `Bearer` pay one header for nothing,
 * which is cheaper than a rule with an exception in it.
 *
 * The token box stays, and so does `localStorage`: a `Bearer` still overrides
 * the cookie, which is what makes "look at this console as the other role for a
 * minute" possible without logging out.
 *
 * ## One place an action reports back (D2)
 *
 * `toast(text, tone)` puts one line in the shell's `#toasts` region, bottom
 * right, through `textContent` like every other string here. The region is
 * `aria-live="polite"`; a failure is additionally `role="alert"`, so a screen
 * reader interrupts for it. A line leaves on its own after a few seconds, or
 * on a click. Before this, a heartbeat's result was written into a status
 * line inside the register form — measured off-screen.
 *
 * ## A 401 ends the page's session, once (C1)
 *
 * The first 401 any request gets — a poll, a write, a page script's fetch —
 * stops everything that would ask again: the refresh timer, and whatever a
 * page script registered with `onExpire` (the chat page's stream and its
 * fallback poller). Every later request fails without leaving the browser.
 * Then the server-rendered `#session-expired` dialog opens, with the way back
 * to this page through the login door. Before this, a lapsed cookie produced
 * 刷新失败 · HTTP 401 in the sidebar every five seconds, forever.
 */

import { PERSONAL_CREDENTIAL_PREFIX } from '../accounts.js'
import { CONSOLE_HEADER, CONSOLE_HEADER_VALUE } from '../auth.js'
import { errorTableJson } from '../view/errors.js'

/**
 * What is spliced into the two token functions of the runtime.
 *
 * Empty strings reproduce the legacy behaviour. With accounts on, a personal
 * credential never reaches `localStorage` (`tenancy-m1.md` §3.3): `writeToken`
 * — the only function here that calls `setItem` — refuses a value with the
 * credential's prefix before it touches storage, whether it came from
 * `#token=`, `?token=` or the paste box, and `readToken` drops one that is
 * somehow already there. The legacy tokens keep the old behaviour for as long
 * as migration lasts.
 */
interface TokenGuards {
  readonly read: string
  readonly write: string
}

const NO_GUARDS: TokenGuards = { read: '', write: '' }

const PERSONAL_GUARDS: TokenGuards = {
  read:
    `\n    try { if ((window.localStorage.getItem(TOKEN_KEY) || '')` +
    `.indexOf('${PERSONAL_CREDENTIAL_PREFIX}') === 0) ` +
    `window.localStorage.removeItem(TOKEN_KEY); } catch (e) { /* none held */ }`,
  write:
    `\n    if (value && String(value).indexOf('${PERSONAL_CREDENTIAL_PREFIX}') === 0) {` +
    `\n      say(byId('token-state'), '个人凭据请在登录页填写', 'warn');` +
    `\n      return;` +
    `\n    }`,
}

function runtimeScript(guards: TokenGuards): string {
  return `
(function () {
  'use strict';

  var TOKEN_KEY = 'qianmo.console.token';
  var memoryToken = '';
  var refreshTimer = null;
  // What the open confirm dialog will do when its confirm button is pressed.
  var pending = null;
  var actions = {};
  var submits = {};
  // Set by the first 401; nothing asks the server again after it.
  var expired = false;
  var expireHooks = [];

  function byId(id) { return document.getElementById(id); }

  function setText(id, value) {
    var el = byId(id);
    if (el) el.textContent = value;
  }

  /* ---------------- what a failure says (C5) ---------------- */

  // The same tables view/errors.ts renders failure strips with, serialised
  // from there; the algorithm below is that module's humanizeError written
  // out again, and test/copyGate.test.ts runs the two over one corpus. An API
  // message is for whoever reads the JSON; the page shows the short line and
  // keeps the original for 详情.
  /* humanize:start */
  var ERRORS = ${errorTableJson()};
  var UNCLEAN = new RegExp(ERRORS.unclean);
  var CJK = new RegExp(ERRORS.cjk);
  var PROTOCOL = new RegExp(ERRORS.protocol);
  var PATTERNS = ERRORS.patterns.map(function (p) { return [new RegExp(p[0], 'i'), p[1]]; });
  // The last line message() produced and the original behind it, so the
  // failure toast that quotes the line can fold the original under 详情.
  var lastMapped = null;

  function cleanLine(text) {
    return text.length > 0 && text.length <= ERRORS.maxClean &&
      CJK.test(text) && !UNCLEAN.test(text);
  }

  function ownPhrase(table, key) {
    if (key === undefined || key === null || key === '') return undefined;
    var name = String(key);
    return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
  }

  function humanize(code, status, raw) {
    raw = String(raw === undefined || raw === null ? '' : raw).trim();
    var parts = raw.split(' · ');
    var head = parts[0] || '';
    var lead = parts.length > 1 && head.length <= ERRORS.maxLead &&
      cleanLine(head) && !PROTOCOL.test(head) ? head : '';
    var phrase = '';
    for (var i = 0; i < PATTERNS.length; i++) {
      if (PATTERNS[i][0].test(raw)) { phrase = PATTERNS[i][1]; break; }
    }
    if (phrase === '' && cleanLine(raw)) return { text: raw, detail: '' };
    if (phrase === '') {
      phrase = ownPhrase(ERRORS.codes, code);
      if (phrase === undefined) phrase = ownPhrase(ERRORS.statuses, status);
      if (phrase === undefined) phrase = ERRORS.fallback;
    }
    var text = lead === '' || lead === phrase ? phrase : lead + ' · ' + phrase;
    var protocol = PROTOCOL.exec(raw);
    if (protocol && text.indexOf(protocol[0]) === -1) text = text + ' · ' + protocol[0];
    return { text: text, detail: raw === text ? '' : raw };
  }
  /* humanize:end */

  // An Error whose message is already the page's line: code and status for
  // a script that branches on them, the original in detail.
  function failure(code, status, raw) {
    var human = humanize(code, status, raw);
    var err = new Error(human.text);
    err.code = code || '';
    err.status = status || 0;
    err.detail = human.detail;
    err.human = human.text;
    return err;
  }

  // What reaches the page for any rejection: a failure from this runtime as
  // it is, anything else (a page script's own throw, a TypeError) through
  // the same mapping.
  function message(err) {
    if (err && typeof err.human === 'string') {
      lastMapped = { text: err.human, detail: err.detail || '', code: err.code || '' };
      return err.human;
    }
    var raw = err && err.message ? String(err.message) : String(err);
    var human = humanize(err && err.code, err && err.status, raw);
    lastMapped = { text: human.text, detail: human.detail, code: (err && err.code) || '' };
    return human.text;
  }

  // The line a page script reports a failed write with: 注册失败 · 无法连接.
  // A write the operator stopped waiting for has not failed as far as anybody
  // knows (C4), so it is not called one: 注册 · 已停止等待 · 服务端可能仍在处理.
  function failLine(verb, err) {
    var line = message(err);
    return err && err.code === 'aborted' ? verb + ' · ' + line : verb + '失败 · ' + line;
  }

  function failTone(err) { return err && err.code === 'aborted' ? 'warn' : 'bad'; }

  // A fetch that never got an answer: stopped on purpose, or no network.
  function unanswered(e) {
    if (e && e.human) return e;
    if (e && e.name === 'AbortError') return failure('aborted', 0, '');
    return failure('network', 0, e && e.message ? e.message : String(e));
  }

  function say(el, value, tone) {
    if (!el) return;
    el.textContent = value;
    el.setAttribute('data-tone', tone || 'muted');
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function stamp(d) {
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' +
      pad(d.getSeconds());
  }

  /* ---------------- toasts ---------------- */

  var TOAST_MS = 6000;
  var TOAST_BAD_MS = 10000;
  var TOAST_MAX = 4;

  // A failure that quotes the line message() just produced carries the
  // original under 详情: selectable, and kept on screen while it is open.
  function toast(text, tone, detail) {
    var region = byId('toasts');
    if (!region || !text) return;
    var quoted = tone === 'bad' && lastMapped && text.indexOf(lastMapped.text) !== -1;
    if (detail === undefined && quoted && lastMapped.detail) detail = lastMapped.detail;
    // A page script that does not know about 停止等待 still says 失败 for
    // it; the tone at least does not.
    if (quoted && lastMapped.code === 'aborted') tone = 'warn';
    if (tone === 'bad') lastMapped = null;
    var line = document.createElement('div');
    line.className = 'toast';
    line.setAttribute('data-tone', tone || 'muted');
    if (tone === 'bad') line.setAttribute('role', 'alert');
    var words = document.createElement('span');
    words.className = 'toast-text';
    words.textContent = text;
    line.appendChild(words);
    var more = null;
    if (detail) {
      more = document.createElement('details');
      more.className = 'toast-detail';
      var summary = document.createElement('summary');
      summary.textContent = '详情';
      var raw = document.createElement('pre');
      raw.className = 'raw';
      raw.setAttribute('data-raw', '');
      raw.textContent = detail;
      more.appendChild(summary);
      more.appendChild(raw);
      line.appendChild(more);
    }
    region.appendChild(line);
    evict(region);
    var gone = function () { if (line.parentNode) line.parentNode.removeChild(line); };
    line.addEventListener('click', function (event) {
      if (more && event.target && event.target.closest && event.target.closest('.toast-detail')) return;
      gone();
    });
    var later = function () {
      if (more && more.open) { setTimeout(later, TOAST_BAD_MS); return; }
      gone();
    };
    setTimeout(later, tone === 'bad' ? TOAST_BAD_MS : TOAST_MS);
  }

  // The oldest result goes first; a line for work still in flight stays,
  // because its 停止等待 is the only way to stop waiting.
  function evict(region) {
    var lines = region.querySelectorAll('.toast:not([data-progress])');
    var extra = region.children.length - TOAST_MAX;
    for (var i = 0; i < lines.length && extra > 0; i++, extra--) lines[i].remove();
  }

  /* ---------------- dialogs ---------------- */

  // Native <dialog>s, rendered by the server and filled in by a page script
  // with textContent. They live outside every polled region on purpose: a
  // dialog inside one would be replaced out from under whoever is reading it.
  // showModal() gives the focus trap, Escape and the inert page behind; the
  // 'close' listener below is the one place a closed dialog forgets what its
  // confirm button was going to do, however it was closed.
  var pendingFor = '';

  function closeDialog(box) {
    if (!box || !box.open) return;
    if (typeof box.close === 'function') box.close();
    else { box.removeAttribute('open'); forget(box); }
  }

  function closeDialogs() {
    var open = document.querySelectorAll('dialog[open]');
    for (var i = 0; i < open.length; i++) closeDialog(open[i]);
    pending = null;
    pendingFor = '';
  }

  function forget(box) {
    if (box && box.id === pendingFor) { pending = null; pendingFor = ''; }
  }

  // Who opened each dialog: the control being dispatched, or failing that
  // whatever had focus. Its confirm runs as that control's work (C4), and it
  // is where focus goes back to when the dialog closes (D4).
  var openers = {};

  function openerOf(id) {
    var seen = openers[id];
    if (!seen) return null;
    if (seen.el.isConnected) return seen.el;
    // Replaced by a refresh while the dialog was up: the same control in
    // the new markup, found the way a refresh finds the focused one.
    var found = seen.mount && seen.mount.isConnected ? locate(seen.mount, seen.desc) : null;
    if (found) seen.el = found;
    return found;
  }

  function openDialog(id, run) {
    var box = byId(id);
    if (!box) { if (run) run(); return; }
    var from = trigger || document.activeElement;
    if (from && from !== document.body && !box.contains(from)) {
      var mount = from.closest('[data-poll]');
      openers[id] = { el: from, mount: mount, desc: describe(from, mount || document.body) };
    }
    if (run) { pending = run; pendingFor = id; }
    if (box.open) return;
    if (typeof box.showModal === 'function') box.showModal();
    else box.setAttribute('open', '');
  }

  /* ---------------- token ---------------- */

  function readToken() {${guards.read}
    try { return window.localStorage.getItem(TOKEN_KEY) || ''; }
    catch (e) { return memoryToken; }
  }

  function writeToken(value) {${guards.write}
    memoryToken = value;
    try {
      if (value) window.localStorage.setItem(TOKEN_KEY, value);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* private mode: the in-memory copy is all we get */ }
    paintToken();
  }

  // Says nothing when there is no local token, because there may still be a
  // cookie session and this script cannot see it (HttpOnly). The role chip is
  // the server-rendered answer to "who am I"; this line only ever reports the
  // localStorage copy.
  function paintToken() {
    var has = readToken() !== '';
    say(byId('token-state'), has ? '令牌已存' : '', has ? 'ok' : 'muted');
    paintLinks();
  }

  // Every page is its own document, so moving between them is a top-level
  // navigation - and a navigation carries no Authorization header. So every
  // link the shell marks data-nav gets the token in its query string, the same
  // position the CLI banner uses and the same one the destination scrubs out
  // of the address bar on arrival. Left alone when there is no token, which is
  // the ordinary case rather than a broken one: a cookie session has nothing
  // to sign a link with and needs nothing, because the browser attaches the
  // cookie to the navigation (auth.ts).
  function paintLinks() {
    var token = readToken();
    var links = document.querySelectorAll('a[data-nav]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var base = link.getAttribute('data-href');
      if (base === null) {
        base = link.getAttribute('href') || '/';
        link.setAttribute('data-href', base);
      }
      if (!token) { link.setAttribute('href', base); continue; }
      link.setAttribute('href', base + (base.indexOf('?') === -1 ? '?' : '&') +
        'token=' + encodeURIComponent(token));
    }
  }

  // A token handed over in the URL is stored and then wiped from the address
  // bar: it must not sit in history, in a screenshot of the URL bar, or in
  // whatever the operator pastes into a chat window next.
  function seedTokenFromUrl() {
    var found = '';
    var hash = window.location.hash || '';
    if (hash.length > 1 && hash.indexOf('token=') !== -1) {
      found = new URLSearchParams(hash.slice(1)).get('token') || '';
    }
    var search = window.location.search || '';
    if (!found && search.indexOf('token=') !== -1) {
      found = new URLSearchParams(search).get('token') || '';
    }
    if (!found) return;
    writeToken(found);
    try {
      var rest = new URLSearchParams(search);
      rest.delete('token');
      var query = rest.toString();
      history.replaceState(null, '', window.location.pathname + (query ? '?' + query : ''));
    } catch (e) { window.location.hash = ''; }
  }

  // The console header rides on everything, token or no token: with a cookie
  // session it is what the server requires (a cross-origin page cannot set it
  // without a preflight this server never answers), and with a Bearer it is one
  // ignored header. A conditional here would be a rule with an exception.
  function authHeaders(extra) {
    var headers = extra || {};
    var token = readToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    headers['${CONSOLE_HEADER}'] = '${CONSOLE_HEADER_VALUE}';
    return headers;
  }

  /* ---------------- session expiry ---------------- */

  var EXPIRED = '会话已失效';

  function expire() {
    if (expired) return;
    expired = true;
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    for (var i = 0; i < expireHooks.length; i++) {
      try { expireHooks[i](); } catch (e) { /* one hook must not keep the rest running */ }
    }
    say(byId('refresh-state'), '已停止 · ' + EXPIRED, 'bad');
    var link = byId('session-expired-login');
    if (link) {
      var here = window.location.pathname + window.location.search;
      link.setAttribute('href', here === '/' ? '/login' :
        '/login?redirect=' + encodeURIComponent(here));
    }
    closeDialogs();
    openDialog('session-expired', null);
  }

  // The one place a response status is looked at before anything else.
  function checked(res) {
    if (res.status === 401) { expire(); throw failure('unauthorized', 401, EXPIRED); }
    return res;
  }

  // Escape closes the expiry dialog like any other: Chrome lets a page veto
  // that only right after a click, and never twice in a row, so a dialog that
  // tried to stay up would stay up some of the time. Closed, it leaves the
  // page readable - a half-written message can still be copied out - and
  // stopped: the next thing tried that would need the server brings it back.
  function refused() {
    openDialog('session-expired', null);
    return Promise.reject(failure('unauthorized', 401, EXPIRED));
  }

  /* ---------------- fields (D3) ---------------- */

  // A field that is wrong says so where it is: aria-invalid on the control
  // and one line under it, tied to it by aria-describedby so a screen reader
  // reads the reason with the label. The line goes as soon as the field is
  // edited. A page script supplies the rules; the runtime only marks.
  function controlOf(form, name) {
    var el = form.elements[name];
    // A group of checkboxes sharing a name: the first stands for the group.
    if (el && !el.tagName && el.length !== undefined) el = el[0];
    return el || null;
  }

  function errorIdOf(el) {
    return (el.id || 'f-' + (el.name || 'field')) + '-error';
  }

  function markField(form, name, text) {
    var el = controlOf(form, name);
    if (!el) return null;
    var id = errorIdOf(el);
    var line = byId(id);
    if (!line) {
      line = document.createElement('p');
      line.className = 'field-error';
      line.id = id;
      (el.closest('.field') || el.parentNode).appendChild(line);
    }
    line.textContent = text;
    el.setAttribute('aria-invalid', 'true');
    var described = (el.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
    if (described.indexOf(id) === -1) {
      described.push(id);
      el.setAttribute('aria-describedby', described.join(' '));
    }
    // A field folded away under 高级选项 would be marked out of sight.
    var fold = el.closest('details');
    if (fold && !fold.open) fold.open = true;
    return el;
  }

  function unmarkField(el) {
    if (!el || !el.getAttribute || el.getAttribute('aria-invalid') !== 'true') return;
    var id = errorIdOf(el);
    el.removeAttribute('aria-invalid');
    var rest = (el.getAttribute('aria-describedby') || '').split(' ').filter(function (part) {
      return part && part !== id;
    });
    if (rest.length > 0) el.setAttribute('aria-describedby', rest.join(' '));
    else el.removeAttribute('aria-describedby');
    var line = byId(id);
    if (line) line.remove();
  }

  function clearFields(form) {
    var marked = form.querySelectorAll('[aria-invalid="true"]');
    for (var i = 0; i < marked.length; i++) unmarkField(marked[i]);
  }

  // rules: { name: function (trimmed value, control) -> '' or the reason }.
  // Marks every field that fails, focuses the first, true when none did.
  function checkFields(form, rules) {
    clearFields(form);
    var first = null;
    for (var name in rules) {
      if (!Object.prototype.hasOwnProperty.call(rules, name)) continue;
      var el = controlOf(form, name);
      if (!el || el.disabled) continue;
      var why = rules[name](typeof el.value === 'string' ? el.value.trim() : '', el);
      if (why && markField(form, name, why) && !first) first = el;
    }
    if (first) first.focus();
    return first === null;
  }

  // A refusal that names one of the request body's own keys - the
  // registry's 'invalid endpoint: x', the route's '字段 afterMs 必须是…' -
  // goes back onto that field. Only for 'invalid', where the key names the
  // field at fault rather than merely appearing in a sentence.
  function fieldOf(err, names) {
    if (!err || err.code !== 'invalid') return '';
    var raw = String(err.detail || err.message || '');
    for (var i = 0; i < names.length; i++) {
      if (new RegExp('(^|[^A-Za-z])' + names[i] + '([^A-Za-z]|$)', 'i').test(raw)) return names[i];
    }
    return '';
  }

  /* ---------------- work in flight (C4) ---------------- */

  // A write is somebody's: the button that was clicked, the form's submit
  // button, or - for a confirmed action - the control that opened the
  // confirm. Whatever sendJson a dispatch starts synchronously belongs to
  // that control, so every page script gets the same behaviour without
  // saying anything: the control is disabled and aria-busy until the answer
  // is in, which is what stops a double click sending twice; after a second,
  // a line says how long it has been and offers 停止等待, which aborts the
  // request. Stopping waiting is not undoing - the server may still finish -
  // and the line it leaves says exactly that (errors.ts, 'aborted').
  var SLOW_MS = 1000;
  var trigger = null;
  var inflight = [];

  function within(el, run) {
    var outer = trigger;
    trigger = el || null;
    try { run(); } finally { trigger = outer; }
  }

  function labelOf(el) {
    var named = el.getAttribute('data-busy-label') || el.getAttribute('aria-label') ||
      el.textContent || '';
    return named.replace(/s+/g, ' ').trim() || '操作';
  }

  function busyOn(el) {
    el.setAttribute('aria-busy', 'true');
    if ('disabled' in el) el.disabled = true;
  }

  function busyOff(el, wasDisabled) {
    el.removeAttribute('aria-busy');
    if ('disabled' in el) el.disabled = wasDisabled;
  }

  function track(el) {
    if (!el || !el.isConnected) return null;
    for (var i = 0; i < inflight.length; i++) {
      if (inflight[i].el === el) { inflight[i].count += 1; return inflight[i]; }
    }
    var mount = el.closest('[data-poll]');
    var job = {
      el: el,
      desc: describe(el, mount || document.body),
      label: labelOf(el),
      controller: typeof AbortController === 'function' ? new AbortController() : null,
      started: Date.now(),
      wasDisabled: !!el.disabled,
      hadFocus: document.activeElement === el,
      count: 1,
      stopped: false,
      line: null,
      words: null,
      timer: null,
      ticker: null
    };
    busyOn(el);
    job.timer = setTimeout(function () { showProgress(job); }, SLOW_MS);
    inflight.push(job);
    return job;
  }

  function paintProgress(job) {
    var secs = Math.max(1, Math.round((Date.now() - job.started) / 1000));
    job.words.textContent = job.label + ' · 进行中 · 已用 ' + secs + ' 秒';
  }

  function showProgress(job) {
    if (inflight.indexOf(job) === -1) return;
    var line = document.createElement('div');
    line.setAttribute('data-progress', '');
    var words = document.createElement('span');
    words.className = 'toast-text';
    line.appendChild(words);
    job.line = line;
    job.words = words;
    paintProgress(job);
    if (job.controller) {
      var stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'btn btn-ghost btn-small';
      stop.setAttribute('data-progress-stop', '');
      stop.textContent = '停止等待';
      stop.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        job.stopped = true;
        job.controller.abort();
      });
      line.appendChild(stop);
    }
    // A modal dialog makes the rest of the page inert, so a stop button in
    // the corner would be out of reach behind the dialog that asked. Inside
    // that dialog, above its buttons, instead.
    var box = job.el.isConnected ? job.el.closest('dialog[open]') : null;
    if (box) {
      line.className = 'progress';
      var row = job.el.closest('.dialog-actions');
      if (row && row.parentNode) row.parentNode.insertBefore(line, row);
      else box.appendChild(line);
    } else {
      var region = byId('toasts');
      if (!region) return;
      line.className = 'toast progress';
      line.setAttribute('data-tone', 'muted');
      region.appendChild(line);
    }
    // Announced once, as it appears; not again every second.
    line.setAttribute('aria-live', 'off');
    job.ticker = setInterval(function () { paintProgress(job); }, 1000);
  }

  function settle(job) {
    job.count -= 1;
    if (job.count > 0) return;
    clearTimeout(job.timer);
    if (job.ticker) clearInterval(job.ticker);
    var at = inflight.indexOf(job);
    if (at !== -1) inflight.splice(at, 1);
    var active = document.activeElement;
    var lost = !active || active === document.body || (job.line && job.line.contains(active));
    if (job.line && job.line.parentNode) job.line.parentNode.removeChild(job.line);
    var el = job.el;
    if (!el.isConnected) return;
    busyOff(el, job.wasDisabled);
    // A disabled control drops focus; give it back to whoever was on it, or
    // to whoever just pressed 停止等待 (now gone with its line).
    if (lost && (job.hadFocus || job.stopped) && !el.disabled) el.focus({ preventScroll: true });
  }

  // A control replaced by a refresh while its write is out: the replacement
  // is the same control, so it is busy too.
  function rebusy(mount) {
    for (var i = 0; i < inflight.length; i++) {
      var job = inflight[i];
      if (job.el.isConnected) continue;
      var found = locate(mount, job.desc);
      if (!found) continue;
      job.el = found;
      job.wasDisabled = !!found.disabled;
      busyOn(found);
    }
  }

  /* ---------------- transport ---------------- */

  function loadHtml(url) {
    if (expired) return refused();
    return fetch(url, {
      headers: authHeaders(),
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(checked, function (e) { throw unanswered(e); }).then(function (res) {
      if (!res.ok) throw failure('', res.status, 'HTTP ' + res.status);
      var type = res.headers.get('content-type') || '';
      if (type.indexOf('text/html') === -1) {
        throw failure('format', res.status, '响应非 HTML · ' + type);
      }
      return res.text();
    });
  }

  function sendJson(method, url, body) {
    if (expired) return refused();
    var job = track(trigger);
    var init = {
      method: method,
      credentials: 'same-origin',
      headers: authHeaders(body === undefined ? {} : { 'Content-Type': 'application/json' })
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (job && job.controller) init.signal = job.controller.signal;
    var sent = fetch(url, init).then(checked, function (e) { throw unanswered(e); }).then(function (res) {
      if (res.status === 204) return null;
      return res.text().then(function (raw) {
        var data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (!res.ok) {
          // http.ts answers { error: { code, message } }. Reaching for
          // data.error directly puts "[object Object]" on the page, which is
          // the one message an operator can do nothing with. The message is
          // the developer's; the page gets the line (C5).
          var err = data && data.error;
          var detail = (err && err.message) || (data && data.message) ||
            (typeof err === 'string' ? err : '');
          var code = err && typeof err.code === 'string' ? err.code : '';
          throw failure(code, res.status, detail ? String(detail) : 'HTTP ' + res.status);
        }
        return data;
      });
    }).then(null, function (e) { throw unanswered(e); });
    if (!job) return sent;
    // Settled before the page script hears, so its own then sees the
    // control enabled again.
    return sent.then(function (data) { settle(job); return data; },
      function (err) { settle(job); throw err; });
  }

  /* ---------------- polled regions ---------------- */

  // The fetched HTML is parsed in a detached template: inert, no script
  // execution, nothing touches the live document until a node is adopted.
  function swapRegions(html, ids) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    var swapped = 0;
    for (var i = 0; i < ids.length; i++) {
      var next = tpl.content.querySelector('#' + ids[i]);
      var current = byId(ids[i]);
      if (next && current) { current.replaceWith(next); swapped += 1; }
    }
    return swapped;
  }

  // The attributes that tell one control from its neighbours once its row
  // has been found: which action, on what.
  var IDENTITY = ['data-action', 'data-address', 'data-trace', 'data-session',
    'data-server', 'name'];

  function keyedIn(mount, key) {
    var rows = mount.querySelectorAll('[data-key]');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-key') === key) return rows[i];
    }
    return null;
  }

  function snapshot(mount) {
    var open = {};
    var rows = mount.querySelectorAll('details[open][data-key]');
    for (var i = 0; i < rows.length; i++) open[rows[i].getAttribute('data-key')] = true;
    var focus = null;
    var active = document.activeElement;
    if (active && active !== document.body && mount.contains(active)) {
      focus = describe(active, mount);
    }
    return { open: open, focus: focus };
  }

  // Enough to find the same control in a fresh copy of the region: its id,
  // the keyed row it sits in, its tag and its identifying attributes.
  function describe(el, mount) {
    var holder = el.closest('[data-key]');
    var desc = {
      id: el.id || '',
      key: holder && mount.contains(holder) ? holder.getAttribute('data-key') : null,
      tag: el.tagName,
      attrs: []
    };
    for (var j = 0; j < IDENTITY.length; j++) {
      if (el.hasAttribute(IDENTITY[j])) desc.attrs.push([IDENTITY[j], el.getAttribute(IDENTITY[j])]);
    }
    return desc;
  }

  function locate(mount, focus) {
    if (focus.id) {
      var named = byId(focus.id);
      if (named && mount.contains(named)) return named;
    }
    var scope = focus.key === null ? mount : keyedIn(mount, focus.key);
    if (!scope) return null;
    var candidates = scope.querySelectorAll(focus.tag);
    for (var i = 0; i < candidates.length; i++) {
      var match = true;
      for (var j = 0; j < focus.attrs.length; j++) {
        if (candidates[i].getAttribute(focus.attrs[j][0]) !== focus.attrs[j][1]) {
          match = false;
          break;
        }
      }
      if (match) return candidates[i];
    }
    return null;
  }

  function restore(mount, state) {
    var rows = mount.querySelectorAll('details[data-key]');
    for (var i = 0; i < rows.length; i++) {
      if (state.open[rows[i].getAttribute('data-key')] === true) rows[i].open = true;
    }
    if (state.focus) {
      var target = locate(mount, state.focus);
      if (target && typeof target.focus === 'function') {
        target.focus({ preventScroll: true });
      }
    }
  }

  var refreshes = 0;

  /* ---------------- connection state (C2) ---------------- */

  // A refresh that fails leaves the old data on the page, which is right -
  // a blank roster reads as "everyone left" - and wrong unless the page says
  // how old it is. So a failure lights one line under the top bar (#conn,
  // role=status) and stamps each polled region with the instant it was last
  // good; the next success takes both away. Failures back off: each one
  // doubles the wait, up to a minute, and a success puts it back.
  var BACKOFF_MAX_MS = 60000;
  var failures = 0;
  var pollMs = 0;
  // The page the server rendered is the first good read.
  var lastGood = Date.now();

  function asOf(at) { return '数据截至 ' + stamp(new Date(at)); }

  function connSay(text, tone) {
    var line = byId('conn');
    if (!line) return;
    if (!text) { line.hidden = true; line.textContent = ''; return; }
    line.textContent = text;
    line.setAttribute('data-tone', tone || 'bad');
    line.hidden = false;
  }

  function staleMark(mount) {
    var at = Number(mount.getAttribute('data-as-of')) || lastGood;
    var mark = null;
    for (var i = 0; i < mount.children.length; i++) {
      if (mount.children[i].hasAttribute('data-asof')) { mark = mount.children[i]; break; }
    }
    if (!mark) {
      mark = document.createElement('p');
      mark.className = 'asof';
      mark.setAttribute('data-asof', '');
      mount.insertBefore(mark, mount.firstChild);
    }
    mark.textContent = asOf(at);
  }

  function clearStale(mount) {
    var marks = mount.querySelectorAll('[data-asof]');
    for (var i = 0; i < marks.length; i++) marks[i].remove();
  }

  function refreshRegion(mount) {
    var url = mount.getAttribute('data-poll');
    if (!url) return Promise.resolve();
    var ids = (mount.getAttribute('data-swap') || '').split(' ').filter(Boolean);
    return loadHtml(url).then(function (html) {
      var state = snapshot(mount);
      if (!(ids.length > 0 && swapRegions(html, ids) > 0)) mount.innerHTML = html;
      restore(mount, state);
      rebusy(mount);
      clearStale(mount);
      mount.setAttribute('data-as-of', String(Date.now()));
      refreshes += 1;
      mount.setAttribute('data-refreshed', String(refreshes));
    }, function (err) {
      if (!expired) staleMark(mount);
      throw err;
    });
  }

  function refreshAll() {
    var mounts = document.querySelectorAll('[data-poll]');
    var jobs = [];
    for (var i = 0; i < mounts.length; i++) jobs.push(refreshRegion(mounts[i]));
    return Promise.all(jobs);
  }

  function nextWait() {
    return failures === 0 ? pollMs : Math.min(BACKOFF_MAX_MS, pollMs * Math.pow(2, failures));
  }

  function offlineLine() {
    return '浏览器离线 · ' + asOf(lastGood);
  }

  function tick() {
    var state = byId('refresh-state');
    return refreshAll().then(function () {
      failures = 0;
      lastGood = Date.now();
      connSay('');
      say(state, '更新于 ' + stamp(new Date()), 'muted');
    }).catch(function (err) {
      // An expiry has already said so, in the dialog and on this line.
      if (expired) return;
      failures += 1;
      var wait = Math.round(nextWait() / 1000);
      connSay(navigator.onLine === false ? offlineLine() :
        '连接中断 · 正在重试 · ' + asOf(lastGood) + (wait > 0 ? ' · ' + wait + ' 秒后再试' : ''));
      say(state, '刷新失败 · ' + message(err), 'bad');
    });
  }

  // A chain of timeouts rather than an interval, so a failure can stretch
  // the next wait and a slow refresh never overlaps the next one.
  function arm() {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    if (expired || !(pollMs > 0)) return;
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      // A background tab polling every five seconds is a background tab
      // holding a socket open for nobody to look at.
      if (document.hidden) { arm(); return; }
      tick().then(arm);
    }, nextWait());
  }

  function schedule() {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    pollMs = 0;
    if (expired || !document.querySelector('[data-poll]')) return;
    var toggle = byId('auto-refresh');
    var picker = byId('refresh-interval');
    var on = toggle ? toggle.checked : false;
    var ms = picker ? parseInt(picker.value, 10) : 5000;
    if (!on || !(ms > 0)) { say(byId('refresh-state'), '已暂停', 'muted'); return; }
    pollMs = ms;
    arm();
    // The interval is already shown by the select beside this; repeating it
    // here would just be a second copy of the same number.
    say(byId('refresh-state'), '', 'muted');
  }

  // Back in view, or back online: ask now rather than at the end of a wait
  // that may have grown to a minute.
  function refreshNow() {
    if (expired || !(pollMs > 0)) return;
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    tick().then(arm);
  }

  /* ---------------- wiring ---------------- */

  document.addEventListener('click', function (event) {
    var origin = event.target;
    if (!origin || !origin.closest) return;
    var opener = origin.closest('[data-open-dialog]');
    if (opener) {
      event.preventDefault();
      within(opener, function () { openDialog(opener.getAttribute('data-open-dialog') || '', null); });
      return;
    }
    var el = origin.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');
    if (action === 'token-save') {
      event.preventDefault();
      var input = byId('token');
      if (input) { writeToken(input.value.trim()); input.value = ''; }
    } else if (action === 'token-clear') {
      event.preventDefault();
      writeToken('');
    } else if (action === 'confirm-cancel') {
      // Closes the dialog the button is in and nothing else: 返回修改 on a
      // confirmation has to land back on the form that asked for it.
      event.preventDefault();
      closeDialog(el.closest('dialog'));
    } else if (action && action.indexOf('confirm-') === 0) {
      event.preventDefault();
      var run = pending;
      var opener = openerOf(pendingFor);
      closeDialog(el.closest('dialog'));
      pending = null;
      pendingFor = '';
      if (run) within(opener, run);
    } else if (action && actions[action]) {
      event.preventDefault();
      if (el.getAttribute('aria-busy') === 'true') return;
      within(el, function () { actions[action](el, event); });
    }
  });

  // Escape is the browser's: a modal <dialog> closes on it by itself. What is
  // left is to drop the pending action of whichever dialog just closed.
  // 'close' does not bubble, so this listens in the capture phase.
  document.addEventListener('close', function (event) {
    var box = event.target;
    if (box && box.tagName === 'DIALOG') forget(box);
  }, true);

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.id) return;
    // Not prevented: the native POST is what clears the cookie, and it works
    // with this script disabled. All that is added is dropping the
    // localStorage copy - leaving it behind would mean the next visit sends a
    // Bearer for a token the operator just walked away from.
    if (form.id === 'logout-form') { writeToken(''); return; }
    if (!submits[form.id]) return;
    event.preventDefault();
    var by = event.submitter || form.querySelector('[type="submit"]');
    if (by && by.getAttribute('aria-busy') === 'true') return;
    within(by, function () { submits[form.id](form, event); });
  });

  // Editing a marked field takes its mark away; the next check decides again.
  document.addEventListener('input', function (event) { unmarkField(event.target); }, true);
  document.addEventListener('change', function (event) { unmarkField(event.target); }, true);

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshNow();
  });

  window.addEventListener('offline', function () {
    if (!expired) connSay(offlineLine());
  });

  window.addEventListener('online', function () {
    failures = 0;
    refreshNow();
  });

  function start() {
    seedTokenFromUrl();
    paintToken();
    var toggle = byId('auto-refresh');
    var picker = byId('refresh-interval');
    if (toggle) toggle.addEventListener('change', schedule);
    if (picker) picker.addEventListener('change', schedule);
    schedule();
  }

  window.qianmoConsole = {
    byId: byId,
    setText: setText,
    say: say,
    stamp: stamp,
    message: message,
    failLine: failLine,
    failTone: failTone,
    checkFields: checkFields,
    markField: markField,
    clearFields: clearFields,
    fieldOf: fieldOf,
    humanize: humanize,
    readToken: readToken,
    toast: toast,
    loadHtml: loadHtml,
    sendJson: sendJson,
    openDialog: openDialog,
    closeDialog: closeDialog,
    closeDialogs: closeDialogs,
    refreshRegion: refreshRegion,
    onAction: function (name, run) { actions[name] = run; },
    onSubmit: function (id, run) { submits[id] = run; },
    // A page script's own pollers and streams stop here, with the runtime's.
    onExpire: function (run) { expireHooks.push(run); },
    expire: expire,
    isExpired: function () { return expired; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`
}

/** The runtime as a console without accounts serves it. */
export const CONSOLE_CLIENT_JS = runtimeScript(NO_GUARDS)

/**
 * The same runtime for a console with accounts: identical but for the two
 * guards that keep a personal credential out of `localStorage`.
 */
export const CONSOLE_CLIENT_JS_ACCOUNTS = runtimeScript(PERSONAL_GUARDS)
