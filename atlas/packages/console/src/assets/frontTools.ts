// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The composer's two pickers in the browser (`view/frontTools.ts`).
 *
 * - **模型** lists the target node's models from the data the model service's
 *   chat fragment carries (`#prov-chat-models`, moved here by the front's
 *   script), and a pick is sent as the conversation's own local command
 *   through the front's send (`window.qianmoFront.send`), so it shows in the
 *   transcript like any line the person typed.
 * - **权限模式** reads `/v0/elevation` for the agent in focus when it opens,
 *   and writes `PUT /v0/elevation/<node>/<agent>` with the mode alone (the
 *   node's default time and calls). 跳过权限确认 asks first. A hub without
 *   the port (404 or 501) leaves 人工确认 and says 未接入; a refusal is said in
 *   the composer's status line.
 *
 * - **智能体** (`/app` only) picks who a new conversation goes to, through the
 *   front's own switch (`window.qianmoFront.pickAgent`).
 *
 * One menu is open at a time; Escape or a click elsewhere closes it, and the
 * arrow keys move between its items.
 */

import { stripJsLineComments } from './client.js'

function toolsScript(): string {
  return `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var words = {};
  try { words = JSON.parse((byId('fx') && byId('fx').getAttribute('data-text')) || '{}') || {}; } catch (e) { words = {}; }
  function tx(key, fallback) { return typeof words[key] === 'string' ? words[key] : fallback; }

  var open = null;

  function close(focus) {
    if (!open) return;
    open.menu.hidden = true;
    open.button.setAttribute('aria-expanded', 'false');
    if (focus) open.button.focus();
    open = null;
  }

  function items(menu) {
    return Array.prototype.slice.call(menu.querySelectorAll('.fx-pick-item:not(:disabled):not([hidden])'));
  }

  function show(button, menu) {
    close(false);
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    open = { button: button, menu: menu };
    var list = items(menu);
    var checked = menu.querySelector('.fx-pick-item[aria-checked="true"]:not(:disabled)');
    var first = checked || list[0];
    if (first) first.focus();
  }

  function target() {
    var thread = byId('fx-thread');
    var address = thread ? thread.getAttribute('data-target') || '' : '';
    var match = /^qianmo:\\/\\/([^/]+)\\/(.+)$/.exec(address);
    return match ? { address: address, node: match[1], agent: match[2] } : null;
  }

  function status(text, tone) {
    var line = byId('fx-status');
    if (line) qc.say(line, text, tone);
  }

  /* ---------------- 模型 ---------------- */

  function check(button, on) { button.setAttribute('aria-checked', on ? 'true' : 'false'); }

  // The level last picked per conversation in this page. Only shown with no
  // model service to read the node's own back from: then it is the one thing
  // known, and the transcript has the node's answer to it.
  var picked = {};

  function paintModels() {
    var data = byId('prov-chat-models');
    var group = byId('fx-model-group');
    var list = byId('fx-model-list');
    var menu = byId('fx-model-menu');
    if (!group || !list || !menu) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    var where = target();
    var effort = data ? data.getAttribute('data-effort') || '' : (where && picked[where.address]) || '';
    var levels = menu.querySelectorAll('[data-effort]');
    for (var i = 0; i < levels.length; i++) check(levels[i], levels[i].getAttribute('data-effort') === effort);
    group.hidden = !data;
    if (!data) return;
    var provider = data.getAttribute('data-provider') || '';
    var current = data.getAttribute('data-model') || '';
    var mark = menu.querySelector('[data-effort] svg');
    var models = data.querySelectorAll('[data-model-id]');
    for (var j = 0; j < models.length; j++) {
      var id = models[j].getAttribute('data-model-id') || '';
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'fx-pick-item';
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('data-model-cmd', provider + '/' + id);
      check(row, id === current);
      if (mark) row.appendChild(mark.cloneNode(true));
      var name = document.createElement('span');
      name.className = 'mono';
      name.textContent = id;
      row.appendChild(name);
      list.appendChild(row);
    }
  }

  function command(text) {
    close(true);
    var front = window.qianmoFront;
    if (front && typeof front.send === 'function') front.send(text);
  }

  /* ---------------- 权限模式 ---------------- */

  var perm = { address: '', tier: 'off', wired: false, asking: false };

  function paintPerm(note) {
    var pick = byId('fx-perm-pick');
    var word = byId('fx-perm-word');
    var menu = byId('fx-perm-menu');
    var line = byId('fx-perm-note');
    if (!pick || !menu) return;
    pick.setAttribute('data-tier', perm.tier);
    var rows = menu.querySelectorAll('[data-perm]');
    var ops = perm.wired && pick.getAttribute('data-ops') === '1';
    for (var i = 0; i < rows.length; i++) {
      var tier = rows[i].getAttribute('data-perm');
      check(rows[i], tier === perm.tier);
      rows[i].disabled = !ops || tier === perm.tier;
      if (tier === perm.tier && word) {
        var label = rows[i].querySelector('span');
        word.textContent = label ? label.textContent : tier;
      }
    }
    if (line && note !== undefined) line.textContent = note;
  }

  function readPerm() {
    var where = target();
    if (!where || perm.asking) return Promise.resolve();
    perm.asking = true;
    return qc.sendJson('GET', '/v0/elevation').then(function (list) {
      var one = null;
      var rows = Array.isArray(list) ? list : [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i] && rows[i].node === where.node && rows[i].agent === where.agent) one = rows[i];
      }
      perm = { address: where.address, tier: one && one.tier ? String(one.tier) : 'off', wired: !!one, asking: false };
      var pick = byId('fx-perm-pick');
      var note = !one
        ? tx('notWired', '未接入 · 一直是人工确认')
        : one.unsupportedReason
          ? String(one.unsupportedReason)
          : pick && pick.getAttribute('data-ops') === '1'
            ? (byId('fx-perm-note') && byId('fx-perm-note').getAttribute('data-defaults')) || ''
            : tx('opsOnly', '只有运维能切换');
      if (one && one.unsupportedReason) perm.wired = false;
      paintPerm(note);
    }, function (err) {
      perm = { address: where.address, tier: 'off', wired: false, asking: false };
      paintPerm(err && (err.status === 404 || err.status === 501) ? tx('notWired', '未接入 · 一直是人工确认') : qc.failLine('读取', err));
    });
  }

  function setPerm(tier) {
    var where = target();
    if (!where) return;
    close(true);
    qc.sendJson('PUT', '/v0/elevation/' + encodeURIComponent(where.node) + '/' + encodeURIComponent(where.agent), { tier: tier })
      .then(function (view) {
        perm.tier = view && view.tier ? String(view.tier) : tier;
        paintPerm();
        var word = byId('fx-perm-word');
        qc.toast(tx('switchedTo', '已切换为 ') + (word ? word.textContent : tier), 'ok');
      }, function (err) {
        status(qc.failLine('切换', err), qc.failTone(err));
      });
  }

  /* ---------------- wiring ---------------- */

  document.addEventListener('click', function (event) {
    var el = event.target && event.target.closest ? event.target : null;
    if (!el) return;
    var button = el.closest('#fx-model-btn, #fx-perm-btn, #fx-agent-btn');
    if (button) {
      event.preventDefault();
      var menu = byId(button.getAttribute('aria-controls') || '');
      if (!menu) return;
      if (open && open.menu === menu) { close(true); return; }
      if (button.id === 'fx-model-btn') paintModels();
      else if (button.id === 'fx-perm-btn' && target()) readPerm();
      show(button, menu);
      return;
    }
    var item = el.closest('.fx-pick-item');
    if (item && open && open.menu.contains(item)) {
      event.preventDefault();
      if (item.disabled) return;
      if (item.hasAttribute('data-agent-pick')) {
        close(true);
        var front = window.qianmoFront;
        if (front && typeof front.pickAgent === 'function') front.pickAgent(item.getAttribute('data-agent-pick') || '');
      }
      else if (item.hasAttribute('data-model-cmd')) command('/model ' + item.getAttribute('data-model-cmd'));
      else if (item.hasAttribute('data-model-auto')) command('/model auto');
      else if (item.hasAttribute('data-effort')) {
        var level = item.getAttribute('data-effort');
        var here = target();
        if (here) picked[here.address] = level;
        command('/effort ' + level);
      }
      else if (item.hasAttribute('data-perm')) {
        var tier = item.getAttribute('data-perm');
        if (tier === 'full-access') { close(true); qc.openDialog('fx-perm-confirm', function () { setPerm(tier); }); }
        else setPerm(tier);
      }
      return;
    }
    if (open && !open.menu.contains(el)) close(false);
  });

  document.addEventListener('keydown', function (event) {
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    var list = items(open.menu);
    if (!list.length) return;
    event.preventDefault();
    var at = list.indexOf(document.activeElement);
    var next = event.key === 'ArrowDown' ? (at + 1) % list.length : (at <= 0 ? list.length - 1 : at - 1);
    list[next].focus();
  });

  // Another agent in focus: its own mode, read once, not on every redraw.
  function follow() {
    var where = target();
    if (where && where.address === perm.address) return;
    perm = { address: where ? where.address : '', tier: 'off', wired: false, asking: false };
    paintPerm();
    if (where && byId('fx-perm-btn')) readPerm();
  }
  document.addEventListener('qianmo:front-view', follow);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', follow);
  else follow();
})();
`
}

/** The pickers' script, appended to the front's own (`view/front.ts`). */
export const FRONT_TOOLS_JS = stripJsLineComments(toolsScript())
