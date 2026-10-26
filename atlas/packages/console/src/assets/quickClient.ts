// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Quick entry in the browser (`view/frontQuick.ts`), on top of the shared
 * runtime (`client.ts`).
 *
 * - **Enter sends**, Shift Enter breaks the line; the line grows to four.
 *   Sending goes to the reader's one conversation with the agent on the card
 *   (the hub opens it at the first line, P37.17) through the chat routes the
 *   front uses. The id from a send that then failed is used again by the
 *   next try with the same agent.
 * - **Then the main window.** In the desktop app the conversation is handed
 *   over with `qmo_open_session` and the card is cleared for next time; in a
 *   browser the page goes to `/app?session=<id>`.
 * - **The figure picks the agent**: a click opens the roster, the arrow keys
 *   move through it, Enter or a click picks.
 * - **Esc and losing focus hide the window** (`qmo_quick_hide`), only in the
 *   desktop app's quick window; showing it again clears the card and goes
 *   back to the main agent.
 *
 * The desktop app is reached only through `window.__TAURI__.core.invoke`, and
 * only when it is there (`docs/dev/qmo-app.md` §5); every string goes in as
 * text.
 */

import { stripJsLineComments } from './client.js'

function quickScript(): string {
  return `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var root = byId('fx-quick');
  if (!root) return;
  var words = {};
  try { words = JSON.parse(root.getAttribute('data-text') || '{}') || {}; } catch (e) { words = {}; }
  function tx(key, fallback) { return typeof words[key] === 'string' ? words[key] : fallback; }

  var shell = window.__QMO_SHELL__ && typeof window.__QMO_SHELL__ === 'object' ? window.__QMO_SHELL__ : null;
  var core = window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function'
    ? window.__TAURI__.core : null;
  var quickWindow = !!core && !!shell && shell.window === 'quick';
  if (shell && typeof shell.window === 'string') document.documentElement.setAttribute('data-shell-window', shell.window);

  function invoke(command, args) {
    if (!core) return Promise.resolve(null);
    try { return Promise.resolve(core.invoke(command, args || {})).catch(function () { return null; }); }
    catch (e) { return Promise.resolve(null); }
  }

  var MAX_LINES_PX = 4 * 24 + 32;
  var main = root.getAttribute('data-main') || '';
  var agent = '';
  var busy = false;
  var opened = null;
  var cleared = false;
  var box = byId('fx-quick-text');
  var send = byId('fx-quick-send');
  var status = byId('fx-quick-status');
  var menu = byId('fx-quick-menu');
  var face = byId('fx-quick-agent');

  function failText(err) {
    var lead = words.sendFailed;
    if (typeof lead !== 'string') return qc.failLine('发送', err);
    var detail = err && (err.human || err.message) ? String(err.human || err.message) : '';
    return lead + (detail ? ' · ' + detail : '');
  }

  function autosize() {
    if (!box) return;
    box.style.height = 'auto';
    if (box.value) box.style.height = Math.min(box.scrollHeight, MAX_LINES_PX) + 'px';
    else box.style.height = '';
    if (send) send.disabled = busy || box.disabled || !box.value.trim() || !agent;
  }

  function items() {
    return menu ? Array.prototype.slice.call(menu.querySelectorAll('[data-agent-pick]:not(:disabled)')) : [];
  }

  function closeMenu(focusBox) {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    if (face) face.setAttribute('aria-expanded', 'false');
    if (focusBox && box) box.focus();
  }

  function openMenu() {
    if (!menu) return;
    menu.hidden = false;
    if (face) face.setAttribute('aria-expanded', 'true');
    var list = items();
    var checked = menu.querySelector('[data-agent-pick][aria-checked="true"]:not(:disabled)');
    var first = checked || list[0];
    if (first) first.focus();
  }

  // The agent a line goes to: its figure on the card, its name in the box.
  function pick(address) {
    var all = menu ? menu.querySelectorAll('[data-agent-pick]') : [];
    var chosen = null;
    for (var i = 0; i < all.length; i++) {
      var on = all[i].getAttribute('data-agent-pick') === address && !all[i].disabled;
      all[i].setAttribute('aria-checked', on ? 'true' : 'false');
      if (on) chosen = all[i];
    }
    agent = chosen ? address : '';
    if (chosen && face) {
      var figure = chosen.querySelector('.avatar');
      if (figure) {
        var copy = figure.cloneNode(true);
        copy.setAttribute('width', '28');
        copy.setAttribute('height', '28');
        while (face.firstChild) face.removeChild(face.firstChild);
        face.appendChild(copy);
      }
      var name = chosen.getAttribute('data-name') || '';
      face.setAttribute('aria-label', tx('switchAgent', '换智能体') + ' · ' + name);
      if (box) box.setAttribute('placeholder', tx('messageTo', '发消息给 ') + name);
    }
    if (box) box.disabled = !agent;
    if (opened && opened.agent !== agent) opened = null;
    autosize();
  }

  function reset() {
    cleared = false;
    busy = false;
    opened = null;
    root.removeAttribute('aria-busy');
    closeMenu(false);
    if (box) box.value = '';
    qc.say(status, '', 'muted');
    pick(main);
    if (box && !box.disabled) box.focus();
  }

  function hide() {
    if (!quickWindow) return;
    closeMenu(false);
    cleared = true;
    invoke('qmo_quick_hide');
  }

  function submit() {
    if (!box || busy || !agent) return;
    var text = box.value.trim();
    if (!text) return;
    busy = true;
    root.setAttribute('aria-busy', 'true');
    qc.say(status, '', 'muted');
    autosize();
    var target = agent;
    var session = opened && opened.agent === target
      ? Promise.resolve(opened.id)
      : qc.sendJson('POST', '/v0/chat/sessions', { target: target }).then(function (data) {
        if (!data || !data.id) throw { human: tx('noSession', '没能开出会话') };
        opened = { agent: target, id: String(data.id) };
        return opened.id;
      });
    session.then(function (id) {
      return qc.sendJson('POST', '/v0/chat/sessions/' + encodeURIComponent(id) + '/messages', { text: text })
        .then(function () { return id; });
    }).then(function (id) {
      opened = null;
      if (core) {
        invoke('qmo_open_session', { session: id });
        cleared = true;
        reset();
        return;
      }
      window.location.href = '/app?session=' + encodeURIComponent(id);
    }, function (err) {
      busy = false;
      root.removeAttribute('aria-busy');
      qc.say(status, failText(err), qc.failTone(err));
      autosize();
      if (box) box.focus();
    });
  }

  qc.onSubmit('fx-quick-form', function () { submit(); });

  document.addEventListener('click', function (event) {
    var el = event.target && event.target.closest ? event.target : null;
    if (!el) return;
    if (el.closest('#fx-quick-agent')) {
      event.preventDefault();
      if (menu && menu.hidden) openMenu(); else closeMenu(true);
      return;
    }
    var item = el.closest('[data-agent-pick]');
    if (item && menu && menu.contains(item)) {
      event.preventDefault();
      if (item.disabled) return;
      pick(item.getAttribute('data-agent-pick') || '');
      closeMenu(true);
      return;
    }
    if (menu && !menu.hidden && !menu.contains(el)) closeMenu(false);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (menu && !menu.hidden) { closeMenu(true); return; }
      hide();
      return;
    }
    if (menu && !menu.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      var list = items();
      if (!list.length) return;
      event.preventDefault();
      var at = list.indexOf(document.activeElement);
      var next = event.key === 'ArrowDown' ? (at + 1) % list.length : (at <= 0 ? list.length - 1 : at - 1);
      list[next].focus();
      return;
    }
    if (event.target === box && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });

  document.addEventListener('input', function (event) {
    if (event.target === box) autosize();
  });

  // The window is hidden, not closed: shown again, it starts clean.
  window.addEventListener('blur', function () { if (!busy) hide(); });
  window.addEventListener('focus', function () {
    if (cleared) reset();
    else if (box && !box.disabled) box.focus();
  });

  function start() {
    pick(main);
    if (!agent) {
      var first = items()[0];
      if (first) pick(first.getAttribute('data-agent-pick') || '');
    }
    if (box && !box.disabled) box.focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
`
}

/** Quick entry's page script (`view/frontQuick.ts`). */
export const QUICK_JS = stripJsLineComments(quickScript())
