// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The entire client, as one string. Roughly 200 lines, no framework, no build.
 *
 * ## What it is allowed to do
 *
 * Three things, and the list is short on purpose:
 *
 * 1. **Poll for server-rendered fragments and put them on the page.** The
 *    fragments come out of `view/*.ts`, which escaped everything on the way
 *    out, so `innerHTML` here is putting back exactly what the server decided
 *    to emit. That is the *only* thing that is ever assigned to `innerHTML`.
 * 2. **Submit forms with `fetch`.** Bodies are JSON; every response message,
 *    including every error string, reaches the page through `textContent`.
 * 3. **Carry the token in an `Authorization` header.** Never in a query string,
 *    never rendered into the document.
 *
 * The dividing line worth stating out loud: **nothing derived from the URL, a
 * form field, or a JSON response body is ever concatenated into HTML.** The
 * server renders HTML; the client renders text. When those two rules are kept
 * apart there is no place for an injected string to become markup.
 *
 * ## The routes it expects
 *
 * These are the seams with the HTTP side. Written here in one table so a
 * mismatch is a one-line fix rather than a hunt:
 *
 * | call                                    | expects                     |
 * |-----------------------------------------|-----------------------------|
 * | `GET /fragments/roster`                 | `text/html`, `renderRoster` |
 * | `GET /fragments/audit?<filter>`         | `text/html`, `renderAudit`  |
 * | `GET /fragments/chain/<traceId>`        | `text/html`, `renderChain`  |
 * | `POST /v0/agents`                       | JSON                        |
 * | `POST /v0/agents/<address>/heartbeat`   | JSON                        |
 * | `DELETE /v0/agents/<address>`           | 204 or JSON                 |
 * | `POST /v0/wake`                         | JSON                        |
 *
 * A non-HTML content type on the three fragment routes is treated as an error
 * rather than rendered — if the HTTP side ever answers those with JSON, the
 * page says so instead of pasting a JSON blob into the document.
 *
 * ## Why the audit refresh is a region swap
 *
 * Replacing the whole audit fragment every five seconds would replace the
 * filter form with it, eating whatever the operator was halfway through typing.
 * So the poller lifts `#audit-rail` (the `512 · 断裂 2` digits) and
 * `#audit-results` out of the fetched HTML through a detached `<template>`
 * (which parses but does not execute) and swaps only those two.
 *
 * ## The token arrives two ways
 *
 * `#token=` and `?token=`. The fragment never reaches the server and is the one
 * to prefer, but `occ console` prints its banner link with the query form, so a
 * client that only reads the fragment leaves anybody who followed that link
 * unauthenticated from the first poll onward. Either way it is stored and
 * scrubbed out of the address bar immediately.
 */

export const CONSOLE_CLIENT_JS = `
(function () {
  'use strict';

  var ROUTES = {
    roster: '/fragments/roster',
    audit: '/fragments/audit',
    // Markup, not JSON: /v0/audit/chain/ answers with the data and loadHtml
    // rejects anything that is not text/html.
    chain: '/fragments/chain/',
    agents: '/v0/agents',
    wake: '/v0/wake'
  };
  var TOKEN_KEY = 'qianmo.console.token';
  var memoryToken = '';
  var refreshTimer = null;
  var clockTimer = null;

  function byId(id) { return document.getElementById(id); }

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
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' +
      pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' +
      pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* ---------------- token ---------------- */

  function readToken() {
    try { return window.localStorage.getItem(TOKEN_KEY) || ''; }
    catch (e) { return memoryToken; }
  }

  function writeToken(value) {
    memoryToken = value;
    try {
      if (value) window.localStorage.setItem(TOKEN_KEY, value);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* private mode: the in-memory copy is all we get */ }
    paintToken();
  }

  function paintToken() {
    var has = readToken() !== '';
    say(byId('token-state'), has ? '令牌已存' : '无令牌', has ? 'ok' : 'muted');
    paintCrossPageLink();
  }

  // The chat page is a second document, so reaching it is a top-level
  // navigation - and a navigation carries no Authorization header while this
  // console keeps its credential out of cookies on purpose (auth.ts). So the
  // link gets the token in its query string, the same position the CLI banner
  // uses and the same one the destination scrubs out of the address bar on
  // arrival. Left alone when there is no token: a link to a 401 is still a
  // better answer than a link that pretends to be authenticated.
  function paintCrossPageLink() {
    var link = byId('to-chat');
    if (!link) return;
    var token = readToken();
    link.setAttribute('href', token ? '/chat?token=' + encodeURIComponent(token) : '/chat');
  }

  // A token handed over in the URL is stored and then wiped from the address
  // bar: it must not sit in history, in a screenshot of the URL bar, or in
  // whatever the operator pastes into a chat window next.
  //
  // Both spellings are read. The fragment (#token=) is the safer one - it never
  // reaches the server - but the banner "occ console" prints links with
  // ?token=, which is also what auth.ts accepts on the request, so a page
  // opened from that banner has to seed itself too or the first poll 401s.
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

  function authHeaders(extra) {
    var headers = extra || {};
    var token = readToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
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

  /* ---------------- fragments ---------------- */

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

  function refreshRoster() {
    return loadHtml(ROUTES.roster).then(function (html) {
      var mount = byId('roster');
      if (mount) mount.innerHTML = html;
    });
  }

  function refreshAudit() {
    var mount = byId('audit');
    if (!mount) return Promise.resolve();
    var query = mount.getAttribute('data-query') || '';
    return loadHtml(ROUTES.audit + (query ? '?' + query : '')).then(function (html) {
      // The rail digits change with every poll and the results below them do
      // too; the filter form between them must not, so only those two swap.
      if (swapRegions(html, ['audit-rail', 'audit-results']) === 0) {
        mount.innerHTML = html;
      }
    });
  }

  function tick() {
    var state = byId('refresh-state');
    return Promise.all([refreshRoster(), refreshAudit()]).then(function () {
      say(state, '更新于 ' + stamp(new Date()), 'muted');
    }).catch(function (err) {
      say(state, '刷新失败 · ' + message(err), 'bad');
    });
  }

  function schedule() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
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

  /* ---------------- forms ---------------- */

  function fieldValue(form, name) {
    var el = form.elements[name];
    return el && typeof el.value === 'string' ? el.value.trim() : '';
  }

  function splitList(value) {
    var parts = String(value || '').replace(/，/g, ',').split(',');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var piece = parts[i].trim();
      if (piece) out.push(piece);
    }
    return out;
  }

  function onRegister(form) {
    var status = byId('register-status');
    var address = fieldValue(form, 'address');
    var endpoint = fieldValue(form, 'endpoint');
    if (!address || !endpoint) {
      say(status, '地址与端点必填', 'bad');
      return;
    }
    var body = {
      address: address,
      endpoint: endpoint,
      capabilities: splitList(fieldValue(form, 'capabilities')),
      status: fieldValue(form, 'status') || 'online'
    };
    var key = fieldValue(form, 'publicKey');
    if (key) body.publicKey = key;
    say(status, '注册中…', 'muted');
    sendJson('POST', ROUTES.agents, body).then(function () {
      say(status, '已注册 ' + address, 'ok');
      form.reset();
      return refreshRoster();
    }).catch(function (err) {
      say(status, '注册失败 · ' + message(err), 'bad');
    });
  }

  function onWake(form) {
    var status = byId('wake-status');
    var body = {
      from: fieldValue(form, 'from'),
      to: fieldValue(form, 'to'),
      prompt: fieldValue(form, 'prompt'),
      url: fieldValue(form, 'url')
    };
    var after = fieldValue(form, 'afterMs');
    if (after) body.afterMs = Number(after);
    if (!body.from || !body.to || !body.prompt) {
      say(status, '发起方、目标与提示词必填', 'bad');
      return;
    }
    say(status, '唤醒中…', 'muted');
    sendJson('POST', ROUTES.wake, body).then(function (data) {
      var receipt = data && data.receipt ? String(data.receipt) : '';
      var task = data && data.taskId ? String(data.taskId) : '';
      // The button says 唤醒, so the result says 已唤醒. An operator should not
      // have to work out whether 已发送 is the same event they asked for.
      say(status, '已唤醒 · task ' + task + (receipt ? ' · 回执 ' + receipt : ''), 'ok');
    }).catch(function (err) {
      say(status, '唤醒失败 · ' + message(err), 'bad');
    });
  }

  function onAgentAction(action, address) {
    var status = byId('register-status');
    if (action === 'heartbeat') {
      say(status, '心跳 ' + address + '…', 'muted');
      sendJson('POST', ROUTES.agents + '/' + encodeURIComponent(address) + '/heartbeat')
        .then(function () {
          say(status, '已心跳 ' + address, 'ok');
          return refreshRoster();
        })
        .catch(function (err) { say(status, '心跳失败 · ' + message(err), 'bad'); });
      return;
    }
    if (action === 'deregister') {
      var ok = window.confirm('注销 ' + address + ' ?');
      if (!ok) return;
      say(status, '注销 ' + address + '…', 'muted');
      sendJson('DELETE', ROUTES.agents + '/' + encodeURIComponent(address))
        .then(function () {
          say(status, '已注销 ' + address, 'ok');
          return refreshRoster();
        })
        .catch(function (err) { say(status, '注销失败 · ' + message(err), 'bad'); });
    }
  }

  function openChain(trace) {
    var panel = byId('chain');
    if (!panel || !trace) return;
    loadHtml(ROUTES.chain + encodeURIComponent(trace)).then(function (html) {
      panel.innerHTML = html;
      panel.hidden = false;
      panel.scrollIntoView({ block: 'nearest' });
    }).catch(function (err) {
      // textContent, never innerHTML: this string can carry a server message.
      panel.textContent = '消息链加载失败 · ' + message(err);
      panel.hidden = false;
    });
  }

  /* ---------------- wiring ---------------- */

  document.addEventListener('click', function (event) {
    var origin = event.target;
    if (!origin || !origin.closest) return;
    var el = origin.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');
    if (action === 'heartbeat' || action === 'deregister') {
      event.preventDefault();
      onAgentAction(action, el.getAttribute('data-address') || '');
    } else if (action === 'chain') {
      event.preventDefault();
      openChain(el.getAttribute('data-trace') || '');
    } else if (action === 'chain-close') {
      event.preventDefault();
      var panel = byId('chain');
      if (panel) { panel.hidden = true; panel.textContent = ''; }
    } else if (action === 'token-save') {
      event.preventDefault();
      var input = byId('token');
      if (input) { writeToken(input.value.trim()); input.value = ''; }
    } else if (action === 'token-clear') {
      event.preventDefault();
      writeToken('');
    }
  });

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.id) return;
    if (form.id === 'register-form') { event.preventDefault(); onRegister(form); return; }
    if (form.id === 'wake-form') { event.preventDefault(); onWake(form); return; }
    if (form.id === 'audit-filter') {
      // Let the native GET through, but drop the empty boxes so the resulting
      // URL is the shortest thing that reproduces this view.
      var controls = form.querySelectorAll('input, select');
      for (var i = 0; i < controls.length; i++) {
        if (controls[i].value === '') controls[i].disabled = true;
      }
    }
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
    var clock = byId('clock');
    if (clock) {
      clockTimer = setInterval(function () { clock.textContent = stamp(new Date()); }, 1000);
    }
    schedule();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`
