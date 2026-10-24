// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The front and the desktop app (`docs/dev/qmo-app.md` §5), on both faces,
 * and the few things a page does for its window either way.
 *
 * The desktop app tells the page it is there with `window.__QMO_SHELL__`
 * (`{ platform, window, version }`) and the `qianmo_shell` cookie the server
 * draws `<html data-shell>` from (`preferences.ts`). The page asks it for
 * something only through `window.__TAURI__.core.invoke`, and only when that
 * is there: in a browser every call below is a no-op and nothing changes.
 *
 * - **退出登录** in the account menu is the device's sign-out in the app
 *   (`qmo_sign_out`): leaving only the web session would be undone at once,
 *   since the app signs in again by itself (§3 step 5).
 * - **Notifications and the badge** (`qmo_notify`, `qmo_badge`) are offered
 *   to the front's script as `window.qianmoShell`; it decides when
 *   (`assets/frontClient.ts`, the unread marks).
 * - **The keyboard help** gains the app's quick-entry shortcut
 *   (`qmo_shell_info`).
 * - **Keys are named for the platform**: ⌘ and ⇧ on a Mac, Ctrl and Shift
 *   elsewhere.
 * - **Offline**: a thin line under the bar while the browser says the network
 *   is gone; it goes by itself when it is back, and the front catches up.
 * - **The first frame** (`docs/dev/qmo-local.md` §3.5): whenever the side
 *   panel's layout changes — open or closed, its width, how many rows and
 *   day headings it shows, the theme — it is reported with
 *   `qmo_boot_layout`, so the app's skeleton can draw the same shapes next
 *   time. An app without the command makes it a no-op. The management side
 *   reports the same fields (`assets/nav.ts`).
 */

import { FRONT_NARROW_PX } from '../view/frontStyle.js'
import { stripJsLineComments } from './client.js'

function shellScript(): string {
  return `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var shell = window.__QMO_SHELL__ && typeof window.__QMO_SHELL__ === 'object' ? window.__QMO_SHELL__ : null;
  var core = window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function'
    ? window.__TAURI__.core : null;
  if (shell && typeof shell.window === 'string') document.documentElement.setAttribute('data-shell-window', shell.window);

  function invoke(command, args) {
    if (!core) return Promise.resolve(null);
    try { return Promise.resolve(core.invoke(command, args || {})).catch(function () { return null; }); }
    catch (e) { return Promise.resolve(null); }
  }

  function clip(text, limit) {
    var flat = String(text || '').replace(/\\s+/g, ' ').trim();
    return flat.length <= limit ? flat : flat.slice(0, limit - 1) + '…';
  }

  var mac = (shell && shell.platform === 'macos') || /Mac|iPhone|iPad/.test(navigator.platform || '');
  function glyph(key) {
    var k = String(key).trim();
    if (!mac) return k === 'CmdOrCtrl' || k === 'CommandOrControl' || k === 'Cmd' ? 'Ctrl' : k;
    var map = { Ctrl: '⌃', Control: '⌃', Cmd: '⌘', Command: '⌘', CmdOrCtrl: '⌘', CommandOrControl: '⌘', Super: '⌘',
      Meta: '⌘', Alt: '⌥', Option: '⌥', Shift: '⇧', Space: 'Space' };
    return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : k;
  }
  function namePlatformKeys() {
    if (!mac) return;
    var mods = document.querySelectorAll('kbd[data-mod]');
    for (var i = 0; i < mods.length; i++) mods[i].textContent = '⌘';
    var shifts = document.querySelectorAll('kbd[data-shift]');
    for (var j = 0; j < shifts.length; j++) shifts[j].textContent = '⇧';
  }

  // The device's sign-out, ahead of the runtime's own submit handling.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!core || !form || !form.classList || !form.classList.contains('fx-sign-out')) return;
    event.preventDefault();
    event.stopPropagation();
    invoke('qmo_sign_out');
  }, true);

  var lastBadge = -1;
  window.qianmoShell = {
    present: !!core,
    notify: function (title, body, session) {
      if (!core) return;
      var args = { title: clip(title, 120), body: clip(body, 300) };
      if (session && /^[A-Za-z0-9_-]{1,128}$/.test(session)) args.session = session;
      invoke('qmo_notify', args);
    },
    badge: function (count) {
      if (!core) return;
      var n = Math.max(0, Math.min(999, Math.floor(Number(count) || 0)));
      if (n === lastBadge) return;
      lastBadge = n;
      invoke('qmo_badge', { count: n });
    }
  };

  function quickShortcut() {
    invoke('qmo_shell_info').then(function (info) {
      var keys = info && typeof info.quickShortcut === 'string' ? info.quickShortcut : '';
      var row = byId('fx-key-quick');
      var cell = byId('fx-key-quick-keys');
      if (!keys || !row || !cell) return;
      while (cell.firstChild) cell.removeChild(cell.firstChild);
      var parts = keys.split('+');
      for (var i = 0; i < parts.length; i++) {
        var cap = document.createElement('kbd');
        cap.textContent = glyph(parts[i]);
        cell.appendChild(cap);
      }
      row.hidden = false;
    });
  }

  function paintOnline() {
    var line = byId('fx-offline');
    if (line) line.hidden = navigator.onLine !== false;
  }
  window.addEventListener('offline', paintOnline);
  window.addEventListener('online', function () {
    paintOnline();
    document.dispatchEvent(new CustomEvent('qianmo:online'));
  });

  var laidOut = '';
  var layoutTimer = null;
  function visible(list) {
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0) n++;
    }
    return n;
  }
  function layoutNow() {
    var root = byId('fx');
    var side = byId('fx-side');
    if (!root || !side) return;
    var open = root.getAttribute('data-side') !== 'closed' &&
      !(window.matchMedia && window.matchMedia('(max-width: ${FRONT_NARROW_PX}px)').matches);
    var info = {
      page: root.getAttribute('data-layout') === 'chat' ? 'chat' : 'agents',
      side: open ? 'open' : 'closed',
      sideWidth: Math.round(side.getBoundingClientRect().width),
      rows: Math.min(60, visible(side.querySelectorAll('.fx-ritem-row, .fx-agent-row'))),
      labels: Math.min(20, visible(side.querySelectorAll('.fx-rgroup-name'))),
      theme: document.documentElement.getAttribute('data-theme') || 'system'
    };
    var text = JSON.stringify(info);
    if (text === laidOut) return;
    laidOut = text;
    invoke('qmo_boot_layout', { layout: info });
  }
  function layout() {
    if (!shell || !core) return;
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutTimer = setTimeout(function () { layoutTimer = null; layoutNow(); }, 400);
  }

  function start() {
    namePlatformKeys();
    paintOnline();
    if (core) quickShortcut();
    if (!shell || !core) return;
    layout();
    window.addEventListener('resize', layout);
    document.addEventListener('qianmo:theme', layout);
    var root = byId('fx');
    var list = byId('fx-side-scroll');
    if (typeof MutationObserver !== 'function') return;
    if (root) new MutationObserver(layout).observe(root, { attributes: true, attributeFilter: ['data-side'] });
    if (list) new MutationObserver(layout).observe(list, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
`
}

/** The front's bridge to the desktop app, appended to its scripts (`view/front.ts`). */
export const FRONT_SHELL_JS = stripJsLineComments(shellScript())
