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
 */

import { PERSONAL_CREDENTIAL_PREFIX } from '../accounts.js'
import { CONSOLE_HEADER, CONSOLE_HEADER_VALUE } from '../auth.js'

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

  function byId(id) { return document.getElementById(id); }

  function setText(id, value) {
    var el = byId(id);
    if (el) el.textContent = value;
  }

  function message(err) {
    return err && err.message ? String(err.message) : String(err);
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

  function openDialog(id, run) {
    var box = byId(id);
    if (!box) { if (run) run(); return; }
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

  /* ---------------- transport ---------------- */

  function loadHtml(url) {
    return fetch(url, {
      headers: authHeaders(),
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var type = res.headers.get('content-type') || '';
      if (type.indexOf('text/html') === -1) {
        throw new Error('响应非 HTML · ' + type);
      }
      return res.text();
    });
  }

  function sendJson(method, url, body) {
    var init = {
      method: method,
      credentials: 'same-origin',
      headers: authHeaders(body === undefined ? {} : { 'Content-Type': 'application/json' })
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(url, init).then(function (res) {
      if (res.status === 204) return null;
      return res.text().then(function (raw) {
        var data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (!res.ok) {
          // http.ts answers { error: { code, message } }. Reaching for
          // data.error directly puts "[object Object]" on the page, which is
          // the one message an operator can do nothing with.
          var err = data && data.error;
          var detail = (err && err.message) || (data && data.message) ||
            (typeof err === 'string' ? err : '');
          throw new Error(detail ? String(detail) : 'HTTP ' + res.status);
        }
        return data;
      });
    });
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

  function refreshRegion(mount) {
    var url = mount.getAttribute('data-poll');
    if (!url) return Promise.resolve();
    var ids = (mount.getAttribute('data-swap') || '').split(' ').filter(Boolean);
    return loadHtml(url).then(function (html) {
      if (ids.length > 0 && swapRegions(html, ids) > 0) return;
      mount.innerHTML = html;
    });
  }

  function refreshAll() {
    var mounts = document.querySelectorAll('[data-poll]');
    var jobs = [];
    for (var i = 0; i < mounts.length; i++) jobs.push(refreshRegion(mounts[i]));
    return Promise.all(jobs);
  }

  function tick() {
    var state = byId('refresh-state');
    return refreshAll().then(function () {
      say(state, '更新于 ' + stamp(new Date()), 'muted');
    }).catch(function (err) {
      say(state, '刷新失败 · ' + message(err), 'bad');
    });
  }

  function schedule() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (!document.querySelector('[data-poll]')) return;
    var toggle = byId('auto-refresh');
    var picker = byId('refresh-interval');
    var on = toggle ? toggle.checked : false;
    var ms = picker ? parseInt(picker.value, 10) : 5000;
    if (!on || !(ms > 0)) { say(byId('refresh-state'), '已暂停', 'muted'); return; }
    refreshTimer = setInterval(function () {
      // A background tab polling every five seconds is a background tab
      // holding a socket open for nobody to look at.
      if (!document.hidden) tick();
    }, ms);
    // The interval is already shown by the select beside this; repeating it
    // here would just be a second copy of the same number.
    say(byId('refresh-state'), '', 'muted');
  }

  /* ---------------- wiring ---------------- */

  document.addEventListener('click', function (event) {
    var origin = event.target;
    if (!origin || !origin.closest) return;
    var opener = origin.closest('[data-open-dialog]');
    if (opener) {
      event.preventDefault();
      openDialog(opener.getAttribute('data-open-dialog') || '', null);
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
      closeDialog(el.closest('dialog'));
      pending = null;
      pendingFor = '';
      if (run) run();
    } else if (action && actions[action]) {
      event.preventDefault();
      actions[action](el, event);
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
    if (submits[form.id]) { event.preventDefault(); submits[form.id](form, event); }
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && refreshTimer) tick();
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
    readToken: readToken,
    loadHtml: loadHtml,
    sendJson: sendJson,
    openDialog: openDialog,
    closeDialog: closeDialog,
    closeDialogs: closeDialogs,
    refreshRegion: refreshRegion,
    onAction: function (name, run) { actions[name] = run; },
    onSubmit: function (id, run) { submits[id] = run; }
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
