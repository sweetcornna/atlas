// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Code's way to the hub (P37.15, `docs/dev/qmo-local.md` §5.2): the Remote
 * copies of this account's sessions on its other computers, for `/code` in
 * a browser and in a desktop app that is not the one running them. It is
 * the one part of Code's page that talks to the hub — `/v0/code/…` only,
 * with the console header — and it is there only when the server drew
 * `data-remote="1"` (a personal account on a hub with Remote).
 *
 * It hangs `window.qianmoCodeHub` for `CODE_JS`, which keeps drawing every
 * session the same way: a copy is a session whose id is
 * `<device id>.<session id>` (a local id has no dot), and the calls a page
 * makes on a session go here instead of the shell —
 *
 * - `qmo_local_read` → `GET /v0/code/sessions/<d>/<s>?before=&limit=`,
 * - `qmo_local_send`, `qmo_local_answer`, `qmo_local_stop` → `POST …/messages`,
 *   `…/answer`, `…/stop`, answered as the runner on that computer answered,
 * - in a browser `qmo_local_list` is the copies alone, `qmo_local_watch` and
 *   `qmo_local_agents` nothing.
 *
 * Changes come as `GET /v0/code/stream`'s revisions; on each the list is
 * read again and turned into the events the shell would send — a `session`
 * for a copy that changed, a trimmed `record` for one with more records (the
 * page reads it again), a `removed` for one that went. Every 30 s the list
 * is read anyway, should the stream be held up somewhere. In a pane of a
 * window's (P37.18, `assets/frontSplit.ts`) the stream is the window's.
 *
 * A copy's folder is drawn as 设备 · 文件夹 so the side list groups by
 * computer; a copy whose computer is offline is never 运行中.
 */

import { CONSOLE_HEADER, CONSOLE_HEADER_VALUE } from '../auth.js'
import { stripJsLineComments } from './client.js'

function hubScript(): string {
  return `
(function () {
  'use strict';

  var local = document.getElementById('code-local');
  if (!local || local.getAttribute('data-remote') !== '1') return;
  var BASE = '/v0/code/';
  var cache = {};
  var listeners = [];
  var source = null;
  var waiting = null;

  function isKey(id) { return typeof id === 'string' && id.indexOf('.') > 0; }
  function values(map) { var out = []; for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) out.push(map[k]); return out; }
  function path(key, tail) {
    var at = key.indexOf('.');
    return BASE + 'sessions/' + encodeURIComponent(key.slice(0, at)) + '/' + encodeURIComponent(key.slice(at + 1)) +
      (tail ? '/' + tail : '');
  }

  function ask(method, url, body) {
    var headers = { accept: 'application/json' };
    headers['${CONSOLE_HEADER}'] = '${CONSOLE_HEADER_VALUE}';
    var init = { method: method, credentials: 'same-origin', headers: headers };
    if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(url, init).then(function (response) {
      if (response.status === 204) return {};
      return response.json().then(null, function () { return null; }).then(function (data) {
        if (response.ok) return data || {};
        var error = data && data.error;
        throw (error && error.message ? String(error.message) : 'HTTP ' + response.status);
      });
    });
  }

  function summary(s) {
    var device = s.device || {};
    var online = device.online === true;
    var state = String(s.state || 'idle');
    if (!online && (state === 'running' || state === 'waiting')) state = 'interrupted';
    return {
      id: s.id, title: s.title, agent: s.agent, mode: s.mode, state: state,
      folder: { id: null, name: [device.name, s.folder && s.folder.name].filter(Boolean).join(' \\u00b7 ') },
      remote: s.remote === true, full: s.full === true,
      device: { id: String(device.id || ''), name: String(device.name || ''), online: online },
      createdAt: s.createdAt, updatedAt: s.updatedAt, lastSeq: s.lastSeq
    };
  }

  function list() {
    return ask('GET', BASE + 'sessions').then(function (data) {
      var next = {};
      var all = data && Array.isArray(data.sessions) ? data.sessions : [];
      for (var i = 0; i < all.length; i++) if (all[i] && isKey(all[i].id)) next[all[i].id] = summary(all[i]);
      var old = cache;
      cache = next;
      return old;
    });
  }

  function emit(event) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](event); } catch (e) { /* one page, one listener */ }
    }
  }

  function refresh() {
    return list().then(function (old) {
      for (var key in cache) {
        if (!Object.prototype.hasOwnProperty.call(cache, key)) continue;
        var was = old[key];
        var now = cache[key];
        if (!was || JSON.stringify(was) !== JSON.stringify(now)) emit({ type: 'session', session: now });
        if (was && now.lastSeq > was.lastSeq) emit({ type: 'record', session: key, seq: now.lastSeq, trimmed: true });
      }
      for (var gone in old) {
        if (Object.prototype.hasOwnProperty.call(old, gone) && !cache[gone]) emit({ type: 'removed', session: gone });
      }
    }, function () { /* the next revision or the next 30 s */ });
  }

  function soon() {
    if (waiting) return;
    waiting = setTimeout(function () { waiting = null; refresh(); }, 150);
  }

  function watch(listener) {
    listeners.push(listener);
    if (source || typeof EventSource !== 'function') return;
    // A pane's (P37.18) is fed by the window's one stream.
    source = window.qianmoSplit ? window.qianmoSplit.stream(BASE + 'stream') : new EventSource(BASE + 'stream');
    source.addEventListener('code', soon);
    setInterval(refresh, 30000);
  }

  function call(command, args) {
    args = args || {};
    if (command === 'qmo_local_list') {
      return list().then(function () { return { features: { protocols: [] }, folders: [], sessions: values(cache) }; });
    }
    if (command === 'qmo_local_watch') return Promise.resolve({});
    if (command === 'qmo_local_agents') return Promise.resolve({ agents: [] });
    var key = args.session;
    if (!isKey(key)) return Promise.reject('');
    if (command === 'qmo_local_read') {
      var query = [];
      if (args.before) query.push('before=' + encodeURIComponent(args.before));
      if (args.limit) query.push('limit=' + encodeURIComponent(args.limit));
      return ask('GET', path(key) + (query.length ? '?' + query.join('&') : '')).then(function (data) {
        if (data && data.session) data.session = cache[key] = summary(data.session);
        return data;
      });
    }
    if (command === 'qmo_local_send') return ask('POST', path(key, 'messages'), { text: args.text, clientId: args.clientId });
    if (command === 'qmo_local_answer') {
      var answer = { ask: args.ask, decision: args.decision };
      if (args.message) answer.message = args.message;
      return ask('POST', path(key, 'answer'), answer);
    }
    if (command === 'qmo_local_stop') return ask('POST', path(key, 'stop'), {});
    return Promise.reject('');
  }

  window.qianmoCodeHub = {
    mine: function (args) { return !!args && isKey(args.session); },
    call: call,
    watch: watch,
    add: function (data) {
      return list().then(function () {
        var out = {};
        for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
        out.sessions = (Array.isArray(data.sessions) ? data.sessions : []).concat(values(cache));
        return out;
      }, function () { return data; });
    },
    drop: function (key) {
      return ask('DELETE', path(key)).then(function () { delete cache[key]; });
    }
  };
})();
`
}

/** Code's way to the hub. */
export const CODE_HUB_JS = stripJsLineComments(hubScript())
