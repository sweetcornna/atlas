// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The session panel in the browser (`view/frontPanel.ts`).
 *
 * The bar's panel button opens and closes it, and the choice is kept in
 * this browser. Nobody chose yet: on a wide window it opens by itself when
 * there is a background task still open. While it is open its body is
 * fetched again every few seconds (`/fragments/chat/front/panel`), keeping
 * the rows the reader unfolded; while it is closed only the button's dot is
 * kept current, at a slower pace. 停止 sends `POST /v0/tasks/<id>/cancel` and
 * says 正在停止 until the answer.
 *
 * A work session's activity (P37.17 B, `view/frontWork.ts`) is the panel's
 * head: on a wide window the panel opens by itself when one is on screen,
 * unless the reader closed it, and closes again on leaving it if it was
 * the page that opened it.
 */

import { stripJsLineComments } from './client.js'

function panelScript(): string {
  return `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var PANEL_URL = '/fragments/chat/front/panel';
  var KEY = 'qianmo.front.panel';
  var OPEN_MS = 5000;
  var CLOSED_MS = 30000;
  var words = {};
  try { words = JSON.parse((byId('fx') && byId('fx').getAttribute('data-text')) || '{}') || {}; } catch (e) { words = {}; }
  function tx(key, fallback) { return typeof words[key] === 'string' ? words[key] : fallback; }

  var timer = null;
  var loading = false;
  var unfolded = {};
  // The answer last swapped in and the node it became: the same again is
  // only counted, not parsed and swapped.
  var shown = null;
  // The panel is open because a work session is on screen, not by choice.
  var auto = false;

  function chosen() {
    try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function choose(value) {
    try { window.localStorage.setItem(KEY, value); } catch (e) { /* a convenience only */ }
  }
  function isOpen() {
    var root = byId('fx');
    return !!root && root.getAttribute('data-panel') === 'open';
  }

  function show(open) {
    var root = byId('fx');
    var panel = byId('fx-panel');
    var button = byId('fx-panel-toggle');
    if (!root || !panel) return;
    if (open) root.setAttribute('data-panel', 'open');
    else root.removeAttribute('data-panel');
    panel.hidden = !open;
    if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.dispatchEvent(new CustomEvent('qianmo:front-panel', { detail: { open: open } }));
  }

  function wide() {
    return !!(window.matchMedia && window.matchMedia('(min-width: 1101px)').matches);
  }
  function workShown() {
    var box = byId('fx-activity');
    return !!box && !box.hidden;
  }
  // A work session came on screen or went (P37.17 B).
  function followWork() {
    if (workShown()) {
      if (!isOpen() && chosen() !== 'closed' && wide()) {
        auto = true;
        show(true);
        load();
        schedule();
      }
    } else if (auto) {
      auto = false;
      if (isOpen()) { show(false); schedule(); }
    }
  }

  function badge(body) {
    var dot = byId('fx-panel-badge');
    if (!dot || !body) return;
    var head = body.querySelector('.fx-panel-sec[data-open-tasks]');
    var count = head ? Number(head.getAttribute('data-open-tasks')) || 0 : 0;
    var waiting = !!body.querySelector('.fx-task-attention');
    dot.hidden = count === 0;
    dot.classList.toggle('is-attention', waiting);
    return count;
  }

  function remember() {
    var rows = document.querySelectorAll('#fx-panel-body details[data-key]');
    for (var i = 0; i < rows.length; i++) unfolded[rows[i].getAttribute('data-key')] = rows[i].open;
  }

  function load() {
    if (loading || qc.isExpired()) return Promise.resolve(0);
    loading = true;
    remember();
    return qc.loadHtml(PANEL_URL).then(function (html) {
      var body = byId('fx-panel-body');
      if (shown && shown.html === html && shown.el === body) return badge(body);
      var tpl = document.createElement('template');
      tpl.innerHTML = html;
      var next = tpl.content.querySelector('#fx-panel-body');
      var current = byId('fx-panel-body');
      if (!next || !current) return 0;
      var rows = next.querySelectorAll('details[data-key]');
      for (var i = 0; i < rows.length; i++) {
        var key = rows[i].getAttribute('data-key');
        if (Object.prototype.hasOwnProperty.call(unfolded, key)) rows[i].open = unfolded[key];
      }
      var focused = document.activeElement && current.contains(document.activeElement)
        ? document.activeElement.getAttribute('data-task-stop') : null;
      current.replaceWith(next);
      shown = { html: html, el: next };
      if (focused) {
        var again = next.querySelector('[data-task-stop="' + focused + '"]');
        if (again) again.focus();
      }
      return badge(next);
    }, function () { return 0; }).then(function (count) {
      loading = false;
      return count;
    });
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      load().then(schedule);
    }, isOpen() ? OPEN_MS : CLOSED_MS);
  }

  function toggle() {
    auto = false;
    var open = !isOpen();
    choose(open ? 'open' : 'closed');
    show(open);
    if (open) load();
    schedule();
  }

  document.addEventListener('click', function (event) {
    var el = event.target && event.target.closest ? event.target : null;
    if (!el) return;
    if (el.closest('[data-action="fx-panel"]')) {
      event.preventDefault();
      event.stopPropagation();
      toggle();
      return;
    }
    var stop = el.closest('[data-task-stop]');
    if (!stop || stop.disabled) return;
    event.preventDefault();
    var id = stop.getAttribute('data-task-stop') || '';
    var label = stop.getAttribute('aria-label') || '';
    stop.disabled = true;
    stop.setAttribute('aria-label', tx('stopping', '正在停止'));
    qc.sendJson('POST', '/v0/tasks/' + encodeURIComponent(id) + '/cancel').then(function () {
      qc.toast(tx('stopped', '已停止'), 'ok');
      return load();
    }, function (err) {
      stop.disabled = false;
      stop.setAttribute('aria-label', label);
      qc.toast(qc.failLine('停止', err), qc.failTone(err));
    });
  }, true);

  function start() {
    if (!byId('fx-panel')) return;
    var choice = chosen();
    if (choice === 'open') show(true);
    else followWork();
    document.addEventListener('qianmo:front-view', followWork);
    load().then(function (count) {
      if (choice === null && wide() && count > 0 && !isOpen()) show(true);
      schedule();
    });
    qc.onExpire(function () { if (timer) clearTimeout(timer); timer = null; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
`
}

/** The panel's script, appended to the front's own (`view/front.ts`). */
export const FRONT_PANEL_JS = stripJsLineComments(panelScript())
