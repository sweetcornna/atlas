// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 分栏与侧栏 (P37.18, `docs/dev/qmo-app.md` §11): the panes of one window,
 * and the collapsed side list that peeks out on a pause over its button.
 * One script for every face (`/`, `/app`, `/code`), inlined right after the
 * shared runtime so the hooks it hangs are there before the front's own
 * scripts look for them. It runs in one of two places:
 *
 * **The window's document** (no `data-pane` on `#fx`):
 *
 * - **Panes are frames.** Two to four same-origin `<iframe>`s, each a face's
 *   address with `pane=1` and one checked query (`agent=`, `session=`,
 *   `work=new`, or none), side by side, a column split once at most. A frame
 *   is never moved in the document (that would load it again): each sits in
 *   `#fx-split` by its own `left`, `top`, `width` and `height`, from the
 *   columns' and rows' shares. The dividers drag (the frames let go of the
 *   pointer meanwhile), double-click or Enter to even out, step by the arrow
 *   keys. Under 320 × 200 a pane, only the focused one shows; the others
 *   stay.
 * - **Opening one.** A row dragged onto the content (its right third is a
 *   pane to the right, its bottom third one below, the rest that pane), a
 *   row's ⋯ (Code's gains the two as it opens) or right-click 在右侧打开 /
 *   在下方打开, and ⌃⌘\ / ⌃⌘- (Ctrl+Alt off
 *   a Mac) for a new one — 开始一项工作 on Work, a new session on Code. With
 *   panes up a row picked in the side list opens in the focused pane, and
 *   one already open somewhere takes the focus instead.
 * - **Focus and closing.** ⌃] / ⌃[ move the focus, ⌃⌘W closes the focused
 *   pane; down to one, the window shows it itself again, its unsent line
 *   carried back, as it carried the window's line into the first pane.
 * - **Remembered** per face in `localStorage` (`qianmo.split.work`,
 *   `qianmo.split.code`): read and written inside try/catch, and anything
 *   out of shape drops the whole of it for one pane. An address that names
 *   a conversation puts it in the focused pane; the address follows the
 *   focused pane by `replaceState`, so Back does not walk the panes.
 * - **One stream for all of them.** `qianmoSplit.stream(url)` is the
 *   window's `EventSource`, and every pane's (below) is fed from it; Code's
 *   runner channel is registered once, by the window, and each pane's
 *   channel is given what it gets. A window holds one long connection
 *   however many panes it shows (§11.2).
 * - **The side list's peek.** Collapsed, a rest of `PEEK_OPEN_MS` on its
 *   button floats it out over the content; leaving the button and the list
 *   folds it back after `PEEK_CLOSE_MS`, unless a menu is open in it, a row
 *   is being dragged from it, a dialog it opened is up or the keyboard is
 *   in it. A click on the button while it is out opens the side list for
 *   good; Esc folds it; the keyboard's focus on the button floats it at once.
 *   Without hover the button is a drawer's.
 * - **The desktop app's menu** calls `window.__qmoMenu(<action>)`.
 *
 * **A pane's document** (`data-pane="1"`):
 *
 * - Not in a frame of the window's (a trip back from `/login`, a pasted
 *   address), it goes to the face's own address without `pane=1`.
 * - It borrows the window's shell: inside the desktop app its
 *   `window.__TAURI__` lets only `qmo_local_*` through, to the window's own
 *   `invoke`, and its `qmo_local_watch` is a place on the window's channel,
 *   so the badge, notifications, the first frame's layout and sign-out stay
 *   the window's. Its `qianmoSplit.stream(url)` is fed by the window's.
 * - Its moves replace its own address (keeping `pane=1`) and tell the
 *   window; its keys the window owns (⌘B, ⌘K, ⌘,, and the pane keys) go to
 *   the window; a link to another page is the window's to follow; its
 *   session running out is the window's; in the macOS app a press on its
 *   bar moves the window, as the app's own drag strip does.
 * - ⌄ lists its row's ⋯ items, cloned, then 只留这一栏 and 关闭分栏; × closes it.
 *
 * Every string goes in as text; nothing here builds markup from one.
 */

import { FRONT_NARROW_PX } from '../view/frontStyle.js'
import { stripJsLineComments } from './client.js'

/** How long the pointer rests on the side list's button before it peeks out (§11.4). */
export const PEEK_OPEN_MS = 300

/** How long after leaving the button and the peek it folds back. */
export const PEEK_CLOSE_MS = 250

/** The smallest a pane shows at. */
export const PANE_MIN_W = 320
export const PANE_MIN_H = 200

/** At most this many panes, and this many in one column. */
export const PANE_MAX = 4
export const PANE_ROWS = 2

/** One arrow key on a divider. */
const STEP_PX = 24

function splitScript(): string {
  return `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  var root = document.getElementById('fx');
  if (!qc || !root) return;
  var byId = qc.byId;
  var PANE = root.getAttribute('data-pane') === '1';
  var FACE = root.getAttribute('data-layout') || 'agents';
  var CODE = FACE === 'code';
  var PATH = CODE ? '/code' : FACE === 'chat' ? '/app' : '/';
  var NARROW = '(max-width: ${FRONT_NARROW_PX}px)';
  var words = {};
  try { words = JSON.parse(root.getAttribute('data-split-text') || '{}') || {}; } catch (e) { words = {}; }
  function tx(key) { return typeof words[key] === 'string' ? words[key] : ''; }
  function narrow() { return !!(window.matchMedia && window.matchMedia(NARROW).matches); }
  function esc(text) {
    return window.CSS && typeof window.CSS.escape === 'function' ? window.CSS.escape(String(text)) : String(text).replace(/[^A-Za-z0-9_-]/g, '');
  }
  var info = null;
  try { info = (PANE ? window.parent : window).__QMO_SHELL__; } catch (e) { info = null; }
  var MAC = info && typeof info === 'object' ? info.platform === 'macos' : /Mac|iPhone|iPad/.test(navigator.platform || '');
  // What encodeURIComponent leaves; ! and the quote as \\x21 and \\x27, so the
  // string reads as no sentence and seems to start no other string.
  var ID = '[A-Za-z0-9_.\\x21~*\\x27()%-]{1,800}';
  var QUERY = new RegExp(CODE ? '^(?:|session=' + ID + ')$' : '^(?:|work=new|(?:agent|session)=' + ID + ')$');
  function valid(q) { return typeof q === 'string' && QUERY.test(q); }
  // The pane an address names: '' is the face's own (the main agent, a new Code session).
  function queryOf(search) {
    var params = new URLSearchParams(search || '');
    if (!CODE && params.get('work') === 'new') return 'work=new';
    var session = params.get('session');
    if (session) return 'session=' + encodeURIComponent(session);
    var agent = CODE ? '' : params.get('agent');
    if (agent) return 'agent=' + encodeURIComponent(agent);
    return '';
  }
  function sessionOf(q) {
    var m = /^session=(.*)$/.exec(q || '');
    try { return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return ''; }
  }

  // The keys (qmo-app.md §11.3): off a Mac ⌘ is Ctrl and ⌃⌘ is Ctrl+Alt;
  // AltGr (Ctrl+Alt on some keyboards, typing a backslash) is never one.
  var PANE_KEYS = { right: 1, below: 1, next: 1, prev: 1, close: 1 };
  function keyOf(e) {
    if (!e || e.isComposing || (e.getModifierState && e.getModifierState('AltGraph'))) return '';
    var code = e.code || '';
    var both = MAC ? e.ctrlKey && e.metaKey && !e.altKey : e.ctrlKey && e.altKey && !e.metaKey;
    if (both) {
      if (e.shiftKey) return '';
      return code === 'Backslash' ? 'right' : code === 'Minus' ? 'below' : code === 'KeyW' ? 'close' : '';
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (code === 'BracketRight') return 'next';
      if (code === 'BracketLeft') return 'prev';
    }
    var mod = MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod || e.altKey) return '';
    if (code === 'KeyB' && !e.shiftKey) return 'side';
    if (code === 'KeyS' && e.shiftKey) return 'side';
    if (code === 'KeyK' && !e.shiftKey) return 'search';
    if (code === 'Comma' && !e.shiftKey) return 'settings';
    return '';
  }

  if (PANE) pane();
  else frame();

  // ---------------------------------------------------------------- a pane

  function pane() {
    var me = null;
    var host = null;
    try { me = window.frameElement; host = me && window.parent.qianmoSplit; } catch (e) { host = null; }
    if (!host || typeof host.hello !== 'function') {
      try {
        var own = new URL(window.location.href);
        own.searchParams.delete('pane');
        window.location.replace(own.pathname + own.search + own.hash);
      } catch (e) { /* it stays as it is */ }
      window.qianmoSplit = {
        on: function () { return false; },
        shows: function () { return false; },
        stream: function (url) { return new EventSource(url); }
      };
      return;
    }
    var P = window.parent;

    // The window's shell, borrowed: local sessions only (§11.2).
    var shell = null;
    try { shell = P.__QMO_SHELL__ && P.__TAURI__ && P.__TAURI__.core; } catch (e) { shell = null; }
    if (shell && typeof shell.invoke === 'function') {
      var Channel = function () { this.onmessage = null; };
      var borrowed = {
        Channel: Channel,
        invoke: function (command, args) {
          if (command === 'qmo_local_watch') { host.code(me, args && args.channel); return Promise.resolve(null); }
          if (/^qmo_local_/.test(String(command))) return shell.invoke(command, args);
          return Promise.resolve(null);
        }
      };
      try { window.__TAURI__ = { core: borrowed }; } catch (e) { /* the frame keeps its own */ }
      try { window.__QMO_SHELL__ = P.__QMO_SHELL__; } catch (e) { /* the frame keeps its own */ }
    }

    // Its address is its own: nothing goes into the window's history.
    var nativeReplace = history.replaceState;
    var asked = CODE && /[?&]session=/.test(window.location.search);
    function pinned(url) {
      if (url === undefined || url === null) return url;
      try {
        var u = new URL(String(url), window.location.href);
        if (u.origin !== window.location.origin) return url;
        u.searchParams.set('pane', '1');
        return u.pathname + u.search + u.hash;
      } catch (e) { return url; }
    }
    history.pushState = function (state, title, url) {
      asked = false;
      nativeReplace.call(history, state, title, pinned(url));
      host.moved(me);
    };
    history.replaceState = function (state, title, url) {
      nativeReplace.call(history, state, title, pinned(url));
      // Code put its address back to a new session: the one asked for is not there.
      if (asked && url !== undefined && url !== null && !/[?&]session=/.test(String(url))) {
        asked = false;
        host.missing(me);
        return;
      }
      host.moved(me);
    };

    window.qianmoSplit = {
      on: function () { return false; },
      shows: function () { return false; },
      stream: function (url) {
        var on = {};
        var fake = {
          url: url,
          readyState: 0,
          addEventListener: function (type, run) { (on[type] = on[type] || []).push(run); },
          removeEventListener: function (type, run) {
            var list = on[type] || [];
            var at = list.indexOf(run);
            if (at >= 0) list.splice(at, 1);
          },
          close: function () { fake.readyState = 2; host.unsource(fake); },
          fire: function (type, data) {
            if (fake.readyState === 2) return;
            fake.readyState = type === 'error' ? 0 : 1;
            var list = (on[type] || []).slice();
            for (var i = 0; i < list.length; i++) {
              try { list[i].call(fake, { type: type, data: data }); } catch (e) { /* the next one */ }
            }
          }
        };
        host.source(me, url, fake);
        return fake;
      }
    };

    window.addEventListener('keydown', function (event) {
      var key = keyOf(event);
      if (!key) return;
      if (!PANE_KEYS[key] && document.querySelector('dialog[open]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      host.key(me, key);
    }, true);
    window.addEventListener('focus', function () { host.focus(me); });
    document.addEventListener('pointerdown', function () { host.focus(me); }, true);

    // A link to another page is the window's; one to another site opens beside.
    window.addEventListener('click', function (event) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      if ((link.getAttribute('href') || '').charAt(0) === '#') return;
      var to = null;
      try { to = new URL(link.href, window.location.href); } catch (e) { return; }
      if (to.protocol !== 'http:' && to.protocol !== 'https:') return;
      event.preventDefault();
      if (to.origin === window.location.origin) host.follow(me, to.pathname + to.search + to.hash);
      else window.open(to.href, '_blank', 'noopener,noreferrer');
    });

    // The macOS app's drag strip is not in a frame: the window moves for it.
    if (shell && MAC) {
      var strip = function (target) { return !!target && !!target.hasAttribute && target.hasAttribute('data-tauri-drag-region'); };
      document.addEventListener('mousedown', function (event) {
        if (event.button !== 0 || event.detail !== 1 || !strip(event.target)) return;
        event.preventDefault();
        host.drag(1);
      });
      document.addEventListener('dblclick', function (event) { if (strip(event.target)) host.drag(2); });
    }

    qc.onExpire(function () { host.expired(me); });

    // ⌄: the row's own items, then the pane's two.
    var more = byId('fx-pane-more');
    function rowOf() {
      var thread = byId('fx-thread');
      if (!thread) return null;
      var session = thread.getAttribute('data-session') || '';
      if (session && thread.getAttribute('data-resident') !== '1') {
        var work = document.querySelector('#fx-recents .fx-ritem-row[data-session="' + esc(session) + '"]');
        if (work) return work;
      }
      var target = thread.getAttribute('data-target') || '';
      return target ? document.querySelector('#fx-agents .fx-agent-row[data-address="' + esc(target) + '"]') : null;
    }
    function fill() {
      var slot = byId('fx-pane-items');
      if (!slot) return;
      while (slot.firstChild) slot.removeChild(slot.firstChild);
      var row = CODE ? null : rowOf();
      var items = row ? row.querySelectorAll('.fx-menu > .fx-menu-item:not(.fx-split-item)') : [];
      for (var i = 0; i < items.length; i++) slot.appendChild(items[i].cloneNode(true));
      if (items.length) {
        var line = document.createElement('div');
        line.className = 'fx-menu-sep';
        line.setAttribute('role', 'separator');
        slot.appendChild(line);
      }
    }
    if (more) {
      more.addEventListener('toggle', function () { if (more.open) fill(); });
      more.addEventListener('click', function (event) {
        if (event.target && event.target.closest && event.target.closest('.fx-menu-item')) setTimeout(function () { more.open = false; }, 0);
      });
      document.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape' || !more.open) return;
        more.open = false;
        var button = more.querySelector('summary');
        if (button) button.focus();
      });
    }
    qc.onAction('fx-pane-close', function () { host.close(me); });
    qc.onAction('fx-pane-solo', function () { host.solo(me); });

    function box() { return byId(CODE ? 'code-text' : 'fx-text'); }
    function open(q) {
      if (!valid(q)) return;
      if (!CODE && window.qianmoFront) { window.qianmoFront.open(q); return; }
      var id = sessionOf(q);
      var row = id ? document.querySelector('#code-sessions [data-action="code-open"][data-session="' + esc(id) + '"]') : byId('code-new');
      if (CODE && row) { row.click(); return; }
      window.location.replace(PATH + '?' + (q ? q + '&' : '') + 'pane=1');
    }
    host.hello(me, {
      open: open,
      draft: function (text) {
        var b = box();
        if (!b || !text) return;
        b.value = text;
        b.dispatchEvent(new Event('input', { bubbles: true }));
      },
      take: function () { var b = box(); return b ? b.value : ''; },
      focus: function () {
        var b = box();
        if (b && !b.disabled) b.focus();
        else window.focus();
      },
      mark: function (focused, many, inset) {
        if (many && !focused) root.setAttribute('data-pane-dim', '');
        else root.removeAttribute('data-pane-dim');
        root.style.setProperty('--fx-pane-inset', Math.max(0, Math.round(Number(inset) || 0)) + 'px');
      },
      session: function () {
        if (CODE) return sessionOf(queryOf(window.location.search));
        var thread = byId('fx-thread');
        return thread ? thread.getAttribute('data-session') || '' : '';
      }
    });
  }

  // ---------------------------------------------------------------- the window

  function frame() {
    var main = byId('fx-main');
    var side = byId('fx-side');
    var opener = document.querySelector('.fx-top .fx-side-open');
    if (!main || !side) return;
    var SPLITS = CODE || !root.hasAttribute('data-chatless');
    var KEY = 'qianmo.split.' + (CODE ? 'code' : 'work');
    var MAX = ${PANE_MAX};
    var ROWS = ${PANE_ROWS};
    var MIN_W = ${PANE_MIN_W};
    var MIN_H = ${PANE_MIN_H};
    var STEP = ${STEP_PX};
    var cols = [];
    var focus = null;
    var box = null;
    var made = 0;
    var streams = {};
    var sources = [];
    var channels = [];

    function list() {
      var out = [];
      for (var i = 0; i < cols.length; i++) for (var j = 0; j < cols[i].rows.length; j++) out.push(cols[i].rows[j].p);
      return out;
    }
    function on() { return cols.length > 0; }
    function locate(p) {
      for (var i = 0; i < cols.length; i++) for (var j = 0; j < cols[i].rows.length; j++) if (cols[i].rows[j].p === p) return { c: i, r: j };
      return null;
    }
    function paneOf(el) {
      var all = list();
      for (var i = 0; i < all.length; i++) if (all[i].frame === el) return all[i];
      return null;
    }
    function find(q) {
      var all = list();
      for (var i = 0; i < all.length; i++) if (all[i].q === q) return all[i];
      return null;
    }
    // A new work page and a new Code session are never the same twice.
    function many(q) { return q === 'work=new' || (CODE && q === ''); }
    // The main agent by name is the face's own address, as the front writes it.
    function norm(q) {
      var row = CODE ? null : side.querySelector('.fx-agent-row.fx-agent-main');
      var main = row ? row.getAttribute('data-address') : '';
      return main && q === 'agent=' + encodeURIComponent(main) ? '' : q;
    }
    // Each one in its own try: a frame that went away throws, the rest go on.
    function tell(items, run) {
      var keep = [];
      for (var i = 0; i < items.length; i++) {
        if (!items[i].frame || !items[i].frame.isConnected) continue;
        keep.push(items[i]);
        try { run(items[i]); } catch (e) { /* that pane's */ }
      }
      return keep;
    }

    // Code: the runner's one channel is the window's; each pane's channel
    // gets what it gets (qmo-local.md §4.5.2: one channel per page).
    var tauri = null;
    try { tauri = window.__TAURI__ && window.__TAURI__.core; } catch (e) { tauri = null; }
    if (CODE && tauri && typeof tauri.invoke === 'function' && typeof tauri.Channel === 'function') {
      var core = {};
      for (var name in tauri) core[name] = tauri[name];
      core.invoke = function (command, args) {
        if (command === 'qmo_local_watch' && args && args.channel) {
          var page = args.channel;
          var mine = new tauri.Channel();
          mine.onmessage = function (event) {
            if (typeof page.onmessage === 'function') page.onmessage(event);
            channels = tell(channels, function (c) { if (typeof c.channel.onmessage === 'function') c.channel.onmessage(event); });
          };
          return tauri.invoke(command, { channel: mine });
        }
        return tauri.invoke.apply(tauri, arguments);
      };
      var global = {};
      for (var part in window.__TAURI__) global[part] = window.__TAURI__[part];
      global.core = core;
      try { window.__TAURI__ = global; } catch (e) { /* the page keeps the app's own */ }
    }

    function fan(url, type, data) {
      sources = tell(sources, function (s) { if (s.url === url) s.fake.fire(type, data); });
    }

    function src(q) { return PATH + '?' + (q ? q + '&' : '') + 'pane=1'; }
    function make(q, draft) {
      var p = { id: ++made, q: q, el: null, frame: null, api: null, cover: null, draft: draft || '', want: false };
      var el = document.createElement('section');
      el.className = 'fx-pane';
      var view = document.createElement('iframe');
      view.className = 'fx-pane-frame';
      view.title = tx('pane');
      view.addEventListener('load', function () { check(p); });
      view.src = src(q);
      el.appendChild(view);
      p.el = el;
      p.frame = view;
      return p;
    }
    // Loaded but not a pane: an error page, the login door, nothing at all.
    function check(p) {
      var ok = false;
      try {
        var doc = p.frame.contentDocument;
        ok = !!doc && !!doc.querySelector('#fx[data-pane="1"]');
      } catch (e) { ok = false; }
      if (!ok) fail(p);
    }
    function fail(p) {
      p.api = null;
      if (p.cover) return;
      var cover = document.createElement('div');
      cover.className = 'fx-pane-fail';
      cover.setAttribute('role', 'status');
      var line = document.createElement('p');
      line.textContent = tx('paneFailed');
      var shut = document.createElement('button');
      shut.type = 'button';
      shut.className = 'btn btn-small';
      shut.textContent = tx('close');
      shut.addEventListener('click', function () { close(p); });
      cover.appendChild(line);
      cover.appendChild(shut);
      p.el.appendChild(cover);
      p.cover = cover;
      p.frame.hidden = true;
    }
    function unfail(p) {
      if (p.cover && p.cover.parentNode) p.cover.parentNode.removeChild(p.cover);
      p.cover = null;
      p.frame.hidden = false;
    }
    function reload(p) {
      unfail(p);
      p.api = null;
      p.frame.src = src(p.q);
    }

    function ensure() {
      if (box) return box;
      box = document.createElement('div');
      box.className = 'fx-split';
      box.id = 'fx-split';
      main.appendChild(box);
      if (window.ResizeObserver) new ResizeObserver(function () { place(); }).observe(box);
      return box;
    }
    function pct(n) { return Math.round(n * 100000) / 1000 + '%'; }

    var barSig = '';
    var barEls = [];
    function place() {
      if (!box || !on()) return;
      var W = box.clientWidth;
      var H = box.clientHeight;
      var solo = W < cols.length * MIN_W;
      for (var c = 0; c < cols.length && !solo; c++) if (cols[c].rows.length > 1 && H < cols[c].rows.length * MIN_H) solo = true;
      var all = !solo;
      if (all) box.setAttribute('data-many', '');
      else box.removeAttribute('data-many');
      root.setAttribute('data-split', String(list().length));
      var x = 0;
      for (var i = 0; i < cols.length; i++) {
        var col = cols[i];
        var y = 0;
        for (var j = 0; j < col.rows.length; j++) {
          var row = col.rows[j];
          var el = row.p.el;
          if (!el.parentNode) box.appendChild(el);
          el.hidden = !all && row.p !== focus;
          el.style.left = all ? pct(x) : '0';
          el.style.top = all ? pct(y) : '0';
          el.style.width = all ? pct(col.w) : '100%';
          el.style.height = all ? pct(row.h) : '100%';
          el.classList.toggle('is-right', all && i > 0);
          el.classList.toggle('is-lower', all && j > 0);
          if (row.p === focus) el.setAttribute('data-focus', '');
          else el.removeAttribute('data-focus');
          y += row.h;
        }
        x += col.w;
      }
      bars(all);
      marks();
    }

    function bars(all) {
      var sig = all ? cols.map(function (c) { return c.rows.length; }).join(',') : '';
      if (sig !== barSig) {
        for (var k = 0; k < barEls.length; k++) if (barEls[k].parentNode) barEls[k].parentNode.removeChild(barEls[k]);
        barEls = [];
        barSig = sig;
        if (all) {
          for (var i = 0; i < cols.length - 1; i++) barEls.push(bar('v', i));
          for (var c = 0; c < cols.length; c++) if (cols[c].rows.length > 1) barEls.push(bar('h', c));
        }
      }
      for (var b = 0; b < barEls.length; b++) seat(barEls[b]);
    }
    function bar(kind, index) {
      var el = document.createElement('div');
      el.className = 'fx-split-bar';
      el.setAttribute('role', 'separator');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-orientation', kind === 'v' ? 'vertical' : 'horizontal');
      el.setAttribute('aria-label', tx('resize'));
      el.setAttribute('aria-valuemin', '0');
      el.setAttribute('aria-valuemax', '100');
      el.setAttribute('data-kind', kind);
      el.setAttribute('data-index', String(index));
      wire(el);
      box.appendChild(el);
      return el;
    }
    function seat(el) {
      var kind = el.getAttribute('data-kind');
      var i = Number(el.getAttribute('data-index'));
      var x = 0;
      for (var k = 0; k < (kind === 'v' ? i + 1 : i); k++) x += cols[k].w;
      el.style.left = pct(x);
      if (kind === 'v') {
        el.setAttribute('aria-valuenow', String(Math.round(x * 100)));
        return;
      }
      el.style.width = pct(cols[i].w);
      el.style.top = pct(cols[i].rows[0].h);
      el.setAttribute('aria-valuenow', String(Math.round(cols[i].rows[0].h * 100)));
    }
    function share(kind, i) { return kind === 'v' ? cols[i].w : cols[i].rows[0].h; }
    // One divider to a new share, each side of it no smaller than a pane may be.
    function nudge(kind, i, a) {
      if (kind === 'v') {
        if (!cols[i + 1]) return;
        var pair = cols[i].w + cols[i + 1].w;
        var minW = MIN_W / (box.clientWidth || 1);
        a = pair < 2 * minW ? pair / 2 : Math.max(minW, Math.min(pair - minW, a));
        cols[i].w = a;
        cols[i + 1].w = pair - a;
      } else {
        var rows = cols[i].rows;
        if (rows.length < 2) return;
        var minH = MIN_H / (box.clientHeight || 1);
        a = 1 < 2 * minH ? 0.5 : Math.max(minH, Math.min(1 - minH, a));
        rows[0].h = a;
        rows[1].h = 1 - a;
      }
      place();
    }
    function even(kind, i) {
      if (kind === 'v') for (var c = 0; c < cols.length; c++) cols[c].w = 1 / cols.length;
      else if (cols[i]) for (var r = 0; r < cols[i].rows.length; r++) cols[i].rows[r].h = 1 / cols[i].rows.length;
      place();
      save();
    }
    function wire(el) {
      var kind = el.getAttribute('data-kind');
      var i = Number(el.getAttribute('data-index'));
      el.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return;
        event.preventDefault();
        var x0 = event.clientX;
        var y0 = event.clientY;
        var a0 = share(kind, i);
        try { el.setPointerCapture(event.pointerId); } catch (e) { /* the moves still come while over it */ }
        root.setAttribute('data-resizing', '');
        el.classList.add('is-active');
        var move = function (e) {
          if (kind === 'v') nudge(kind, i, a0 + (e.clientX - x0) / (box.clientWidth || 1));
          else nudge(kind, i, a0 + (e.clientY - y0) / (box.clientHeight || 1));
        };
        // However the drag ends (the capture can go first), the frames get the pointer back.
        var up = function () {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          el.removeEventListener('lostpointercapture', up);
          root.removeAttribute('data-resizing');
          el.classList.remove('is-active');
          save();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('lostpointercapture', up);
      });
      el.addEventListener('dblclick', function () { even(kind, i); });
      el.addEventListener('keydown', function (event) {
        var back = kind === 'v' ? 'ArrowLeft' : 'ArrowUp';
        var fore = kind === 'v' ? 'ArrowRight' : 'ArrowDown';
        if (event.key === 'Enter') { event.preventDefault(); even(kind, i); return; }
        if (event.key !== back && event.key !== fore) return;
        event.preventDefault();
        var size = (kind === 'v' ? box.clientWidth : box.clientHeight) || 1;
        nudge(kind, i, share(kind, i) + (event.key === fore ? STEP : -STEP) / size);
        save();
      });
    }

    // The focused pane, a dimmer bar on the others, and room under the side
    // list's button for the pane it floats over.
    function marks() {
      var spread = !!box && box.hasAttribute('data-many');
      var button = opener && opener.offsetParent !== null ? opener.getBoundingClientRect() : null;
      var all = list();
      for (var i = 0; i < all.length; i++) {
        var p = all[i];
        if (!p.api) continue;
        var inset = 0;
        if (button && !p.el.hidden) {
          var r = p.el.getBoundingClientRect();
          if (r.top < button.bottom && r.left < button.right && r.right > button.left) inset = button.right - r.left;
        }
        try { p.api.mark(p === focus, spread, inset); } catch (e) { /* that pane's */ }
      }
      light();
    }
    // The focused pane's row is the side list's current one.
    function rowFor(q) {
      if (q === 'work=new') return byId('fx-new-work');
      if (q === '') return CODE ? byId('code-new') : side.querySelector('.fx-agent-row.fx-agent-main');
      var m = /^(agent|session)=(.*)$/.exec(q);
      if (!m) return null;
      var value = '';
      try { value = decodeURIComponent(m[2]); } catch (e) { return null; }
      if (m[1] === 'agent') return side.querySelector('.fx-agent-row[data-address="' + esc(value) + '"]');
      var hit = side.querySelector('[data-session="' + esc(value) + '"]');
      return hit ? hit.closest('.fx-ritem-row, .fx-agent-row') || hit : null;
    }
    function light() {
      var old = side.querySelectorAll('[data-split-current]');
      for (var i = 0; i < old.length; i++) old[i].removeAttribute('data-split-current');
      if (!on() || !focus) return;
      var row = rowFor(focus.q);
      if (row) row.setAttribute('data-split-current', '');
    }
    var lighting = false;
    new MutationObserver(function () {
      if (!on() || lighting) return;
      lighting = true;
      Promise.resolve().then(function () { lighting = false; light(); });
    }).observe(side, { childList: true, subtree: true });

    function address() {
      if (!focus || window.location.pathname !== PATH) return;
      var card = byId('settings');
      if (card && card.open) return;
      var url = PATH + (focus.q ? '?' + focus.q : '');
      if (window.location.pathname + window.location.search === url) return;
      try { history.replaceState(history.state, '', url); } catch (e) { /* cosmetic */ }
    }
    function round(n) { return Math.round(n * 10000) / 10000; }
    function save() {
      try {
        if (!on()) { window.localStorage.removeItem(KEY); return; }
        window.localStorage.setItem(KEY, JSON.stringify({
          v: 1,
          cols: cols.map(function (c) {
            return { w: round(c.w), rows: c.rows.map(function (r) { return { h: round(r.h), q: r.p.q }; }) };
          }),
          focus: Math.max(0, list().indexOf(focus))
        }));
      } catch (e) { /* the layout is a convenience */ }
    }
    function size(n) { return typeof n === 'number' && isFinite(n) && n > 0 && n <= 1; }
    // What was kept, or null for one pane: anything out of shape drops all of it.
    function shape(data) {
      if (!data || data.v !== 1 || !Array.isArray(data.cols) || data.cols.length < 1 || data.cols.length > MAX) return null;
      var out = [];
      var total = 0;
      var widths = 0;
      for (var i = 0; i < data.cols.length; i++) {
        var c = data.cols[i];
        if (!c || !size(c.w) || !Array.isArray(c.rows) || c.rows.length < 1 || c.rows.length > ROWS) return null;
        var heights = 0;
        var rows = [];
        for (var j = 0; j < c.rows.length; j++) {
          var r = c.rows[j];
          if (!r || !size(r.h) || !valid(r.q)) return null;
          heights += r.h;
          rows.push({ h: r.h, q: norm(r.q) });
        }
        for (var k = 0; k < rows.length; k++) rows[k].h = rows[k].h / heights;
        widths += c.w;
        total += rows.length;
        out.push({ w: c.w, rows: rows });
      }
      if (total < 2 || total > MAX) return null;
      for (var n = 0; n < out.length; n++) out[n].w = out[n].w / widths;
      var f = data.focus;
      if (typeof f !== 'number' || Math.floor(f) !== f || f < 0 || f >= total) f = 0;
      return { cols: out, focus: f };
    }
    function load() {
      var raw = null;
      try { raw = window.localStorage.getItem(KEY); } catch (e) { return null; }
      if (!raw) return null;
      var data = null;
      try { data = JSON.parse(raw); } catch (e) { data = null; }
      var kept = shape(data);
      if (!kept) {
        try { window.localStorage.removeItem(KEY); } catch (e) { /* nothing to drop then */ }
      }
      return kept;
    }

    function topBox() { return byId(CODE ? 'code-text' : 'fx-text'); }
    function setBox(b, text) {
      if (!b) return;
      b.value = text;
      b.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function current() {
      if (!CODE && window.qianmoFront && typeof window.qianmoFront.where === 'function') return norm(window.qianmoFront.where());
      return window.location.pathname === PATH ? norm(queryOf(window.location.search)) : '';
    }
    function full() { qc.toast(tx('paneFull'), 'muted'); }
    function roomFor(where) {
      var area = box || main;
      if (where === 'below') return area.clientHeight >= 2 * MIN_H;
      return area.clientWidth >= (cols.length ? cols.length + 1 : 2) * MIN_W;
    }
    function setFocus(p, move) {
      if (!p) return;
      if (focus !== p) {
        focus = p;
        place();
        save();
        address();
      }
      if (!move) return;
      if (p.api) {
        try { p.api.focus(); } catch (e) { /* that pane's */ }
      } else p.want = true;
    }
    function build(kept) {
      ensure();
      cols = kept.cols.map(function (c) {
        return { w: c.w, rows: c.rows.map(function (r) { return { h: r.h, p: make(r.q) }; }) };
      });
      focus = list()[kept.focus] || list()[0];
      place();
      save();
      address();
    }
    function enter(q, where) {
      if (!roomFor(where)) { full(); return; }
      var b = topBox();
      var draft = b ? b.value : '';
      if (draft) setBox(b, '');
      var first = make(current(), draft);
      var next = make(q);
      ensure();
      cols = where === 'below'
        ? [{ w: 1, rows: [{ h: 0.5, p: first }, { h: 0.5, p: next }] }]
        : [{ w: 0.5, rows: [{ h: 1, p: first }] }, { w: 0.5, rows: [{ h: 1, p: next }] }];
      focus = next;
      next.want = true;
      place();
      save();
      address();
    }
    function add(q, where) {
      var at = locate(focus);
      if (!at || list().length >= MAX) { full(); return; }
      var p = null;
      if (where === 'below') {
        var col = cols[at.c];
        if (col.rows.length >= ROWS || !roomFor('below')) { full(); return; }
        var half = col.rows[at.r].h / 2;
        col.rows[at.r].h = half;
        p = make(q);
        col.rows.splice(at.r + 1, 0, { h: half, p: p });
      } else {
        if (!roomFor('right')) { full(); return; }
        var width = cols[at.c].w / 2;
        cols[at.c].w = width;
        p = make(q);
        cols.splice(at.c + 1, 0, { w: width, rows: [{ h: 1, p: p }] });
        var W = box.clientWidth || 1;
        for (var i = 0; i < cols.length; i++) {
          if (cols[i].w * W >= MIN_W) continue;
          for (var k = 0; k < cols.length; k++) cols[k].w = 1 / cols.length;
          break;
        }
      }
      focus = p;
      p.want = true;
      place();
      save();
      address();
    }
    // Beside: a new pane right of or under the focused one (or the window's own view).
    function openNew(q, where) {
      if (!SPLITS || !valid(q)) return;
      q = norm(q);
      var have = many(q) ? null : find(q);
      if (have) { setFocus(have, true); return; }
      if (!on()) {
        if (!many(q) && q === current()) return;
        enter(q, where);
        return;
      }
      add(q, where);
    }
    // In place: the focused pane changes to it.
    function openHere(q) {
      if (!valid(q)) return;
      q = norm(q);
      var have = many(q) ? null : find(q);
      if (have) { setFocus(have, true); return; }
      var p = focus;
      if (!p) return;
      p.q = q;
      if (p.api) {
        try { p.api.open(q); } catch (e) { reload(p); }
      } else reload(p);
      save();
      address();
      light();
      setFocus(p, true);
    }
    // The window's own view, as before the panes.
    function showHere(q) {
      if (!CODE) {
        if (window.qianmoFront) window.qianmoFront.open(q, true);
        return;
      }
      var id = sessionOf(q);
      var row = id ? side.querySelector('[data-action="code-open"][data-session="' + esc(id) + '"]') : byId('code-new');
      if (row) row.click();
    }
    function drop(p) {
      sources = sources.filter(function (s) { return s.frame !== p.frame; });
      channels = channels.filter(function (c) { return c.frame !== p.frame; });
      if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    }
    function leave(last) {
      var q = last ? last.q : current();
      var draft = '';
      try { draft = last && last.api ? last.api.take() : ''; } catch (e) { draft = ''; }
      var all = list();
      for (var i = 0; i < all.length; i++) drop(all[i]);
      cols = [];
      focus = null;
      if (box && box.parentNode) box.parentNode.removeChild(box);
      box = null;
      barSig = '';
      barEls = [];
      root.removeAttribute('data-split');
      save();
      light();
      showHere(q);
      if (draft) setBox(topBox(), draft);
    }
    function close(p) {
      var at = p ? locate(p) : null;
      if (!at) return;
      var before = list();
      var index = before.indexOf(p);
      var col = cols[at.c];
      col.rows.splice(at.r, 1);
      if (!col.rows.length) {
        cols.splice(at.c, 1);
        var heir = cols[at.c - 1] || cols[at.c];
        if (heir) heir.w += col.w;
      } else {
        for (var r = 0; r < col.rows.length; r++) col.rows[r].h = 1 / col.rows.length;
      }
      drop(p);
      var rest = list();
      if (rest.length < 2) {
        cols = rest.length ? cols : [];
        leave(rest[0] || null);
        return;
      }
      if (focus === p) focus = rest[Math.max(0, Math.min(rest.length - 1, index - 1))];
      place();
      save();
      address();
      setFocus(focus, true);
    }
    function act(name) {
      if (name === 'right' || name === 'below') { openNew(CODE ? '' : 'work=new', name); return; }
      if (name === 'next' || name === 'prev') {
        if (!on()) return;
        var all = list();
        var at = all.indexOf(focus);
        setFocus(all[(at + (name === 'next' ? 1 : all.length - 1)) % all.length], true);
        return;
      }
      if (name === 'close') { if (on()) close(focus); return; }
      var front = window.qianmoFront;
      if (name === 'side') { if (front && front.side) front.side(); return; }
      if (name === 'search') { if (front && front.search) front.search(); return; }
      if (name === 'settings' && typeof window.__qmoOpenSettings === 'function') window.__qmoOpenSettings();
    }
    function modal() { return !!document.querySelector('dialog[open]'); }

    window.qianmoSplit = {
      on: on,
      // Whether a conversation is on screen in a pane (the unread marks, notifications).
      shows: function (id) {
        if (!id || !on()) return false;
        var all = list();
        for (var i = 0; i < all.length; i++) {
          try { if (!all[i].el.hidden && all[i].api && all[i].api.session() === id) return true; } catch (e) { /* gone */ }
        }
        return false;
      },
      stream: function (url) {
        var real = new EventSource(url);
        streams[url] = real;
        ['open', 'error', 'chat', 'code'].forEach(function (type) {
          real.addEventListener(type, function (event) { fan(url, type, event && event.data); });
        });
        return real;
      },
      source: function (el, url, fake) {
        sources.push({ frame: el, url: url, fake: fake });
        setTimeout(function () {
          var real = streams[url];
          if (!real || real.readyState === 2) fake.fire('error');
          else if (real.readyState === 1) fake.fire('open');
        }, 0);
      },
      unsource: function (fake) { sources = sources.filter(function (s) { return s.fake !== fake; }); },
      code: function (el, channel) { if (channel) channels.push({ frame: el, channel: channel }); },
      hello: function (el, api) {
        var p = paneOf(el);
        if (!p) return;
        p.api = api;
        unfail(p);
        if (p.draft) {
          try { api.draft(p.draft); } catch (e) { /* the line stays with the window */ }
          p.draft = '';
        }
        marks();
        if (p === focus && p.want) {
          p.want = false;
          try { api.focus(); } catch (e) { /* that pane's */ }
        }
      },
      moved: function (el) {
        var p = paneOf(el);
        if (!p) return;
        var q = '';
        try { q = norm(queryOf(el.contentWindow.location.search)); } catch (e) { return; }
        if (!valid(q) || q === p.q) return;
        p.q = q;
        save();
        if (p === focus) address();
        light();
      },
      missing: function (el) { var p = paneOf(el); if (p) fail(p); },
      focus: function (el) { setFocus(paneOf(el), false); },
      key: function (el, name) {
        setFocus(paneOf(el), false);
        if (!modal()) act(name);
      },
      close: function (el) { close(paneOf(el)); },
      solo: function (el) { var p = paneOf(el); if (p) leave(p); },
      expired: function () { qc.expire(); },
      follow: function (el, href) {
        if (typeof href !== 'string' || href.charAt(0) !== '/' || href.charAt(1) === '/') return;
        var link = document.createElement('a');
        link.href = href;
        link.hidden = true;
        document.body.appendChild(link);
        link.click();
        if (link.parentNode) link.parentNode.removeChild(link);
      },
      drag: function (n) {
        var internals = window.__TAURI_INTERNALS__;
        if (!internals || typeof internals.invoke !== 'function') return;
        Promise.resolve(internals.invoke(n === 2 ? 'plugin:window|internal_toggle_maximize' : 'plugin:window|start_dragging')).then(null, function () { /* nothing to do */ });
      }
    };
    // The desktop app's View menu (qmo-app.md §11.5).
    window.__qmoMenu = function (what) {
      if (what === 'side' || PANE_KEYS[what]) act(what);
    };

    // ---- the side list's rows: open in the focused pane, ⋯ and right-click, drag

    function rowQuery(el) {
      var action = el.getAttribute('data-action');
      if (action === 'fx-agent') { var address = el.getAttribute('data-address'); return address ? 'agent=' + encodeURIComponent(address) : null; }
      if (action === 'fx-open' || action === 'code-open') { var id = el.getAttribute('data-session'); return id ? 'session=' + encodeURIComponent(id) : null; }
      if (action === 'fx-new-work') return CODE ? null : 'work=new';
      if (action === 'code-new') return CODE ? '' : null;
      return null;
    }
    var ROW = '[data-action="fx-agent"], [data-action="fx-open"], [data-action="code-open"]';
    var ctx = byId('fx-split-ctx');
    function ctxOpen() { return !!ctx && !ctx.hidden; }
    function hideCtx() { if (ctx) ctx.hidden = true; }
    function closeDrawer() {
      var scrim = document.querySelector('.fx-scrim');
      if (root.getAttribute('data-drawer') === 'open' && scrim) scrim.click();
    }

    document.addEventListener('click', function (event) {
      var hit = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
      if (!hit) return;
      if (hit.getAttribute('data-action') === 'fx-split') {
        event.preventDefault();
        event.stopPropagation();
        var menu = hit.closest('details');
        if (menu) menu.open = false;
        hideCtx();
        openNew(hit.getAttribute('data-split-q') || '', hit.getAttribute('data-split-to') === 'below' ? 'below' : 'right');
        return;
      }
      if (!on() || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var others = byId('fx-others');
      if (!side.contains(hit) && !(others && others.contains(hit))) return;
      var q = rowQuery(hit);
      if (q === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (others && others.open && others.contains(hit)) others.close();
      closeDrawer();
      openHere(q);
    }, true);

    side.addEventListener('contextmenu', function (event) {
      if (!ctx || !SPLITS || narrow()) return;
      var row = event.target && event.target.closest ? event.target.closest('.fx-agent-row, .fx-ritem-row') : null;
      var pick = row ? row.querySelector(ROW) : null;
      var q = pick ? rowQuery(pick) : null;
      if (q === null) return;
      event.preventDefault();
      var slot = byId('fx-split-ctx-items');
      if (slot) {
        while (slot.firstChild) slot.removeChild(slot.firstChild);
        var items = row.querySelectorAll('.fx-menu > .fx-menu-item:not(.fx-split-item)');
        for (var i = 0; i < items.length; i++) slot.appendChild(items[i].cloneNode(true));
        if (items.length) {
          var line = document.createElement('div');
          line.className = 'fx-menu-sep';
          line.setAttribute('role', 'separator');
          slot.appendChild(line);
        }
      }
      var picks = ctx.querySelectorAll('[data-action="fx-split"]');
      for (var j = 0; j < picks.length; j++) picks[j].setAttribute('data-split-q', q);
      ctx.hidden = false;
      var w = ctx.offsetWidth;
      var h = ctx.offsetHeight;
      ctx.style.left = Math.max(4, Math.min(event.clientX, window.innerWidth - w - 4)) + 'px';
      ctx.style.top = Math.max(4, Math.min(event.clientY, window.innerHeight - h - 4)) + 'px';
      var first = ctx.querySelector('.fx-menu-item');
      if (first) first.focus({ preventScroll: true });
    });
    if (ctx) {
      ctx.addEventListener('click', function (event) {
        if (event.target && event.target.closest && event.target.closest('.fx-menu-item')) setTimeout(hideCtx, 0);
      });
      document.addEventListener('pointerdown', function (event) { if (ctxOpen() && !ctx.contains(event.target)) hideCtx(); }, true);
      window.addEventListener('blur', hideCtx);
      window.addEventListener('resize', hideCtx);
      side.addEventListener('scroll', hideCtx, true);
    }

    // Code's rows draw their own ⋯ (assets/codeManage.ts): the two go in as it opens.
    document.addEventListener('toggle', function (event) {
      var more = event.target;
      if (!CODE || !ctx || !more || !more.open || !more.matches || !more.matches('details.fx-more') || !side.contains(more)) return;
      var menu = more.querySelector('.fx-menu');
      var pick = more.parentNode ? more.parentNode.querySelector('[data-action="code-open"]') : null;
      var q = pick ? rowQuery(pick) : null;
      if (!menu || q === null || menu.querySelector('.fx-split-item')) return;
      var line = document.createElement('div');
      line.className = 'fx-menu-sep fx-split-item';
      line.setAttribute('role', 'separator');
      menu.appendChild(line);
      var picks = ctx.querySelectorAll('[data-action="fx-split"]');
      for (var i = 0; i < picks.length; i++) {
        var copy = picks[i].cloneNode(true);
        copy.setAttribute('data-split-q', q);
        menu.appendChild(copy);
      }
    }, true);

    var dragging = null;
    var hint = null;
    side.addEventListener('pointerover', function (event) {
      var pick = SPLITS && event.target && event.target.closest ? event.target.closest(ROW) : null;
      if (pick && !pick.hasAttribute('draggable')) pick.setAttribute('draggable', 'true');
    });
    side.addEventListener('dragstart', function (event) {
      var pick = event.target && event.target.closest ? event.target.closest(ROW) : null;
      var q = pick ? rowQuery(pick) : null;
      if (q === null || !SPLITS || narrow() || !event.dataTransfer) return;
      dragging = q;
      try {
        event.dataTransfer.setData('application/x-qmo-pane', q);
        event.dataTransfer.effectAllowed = 'copyMove';
      } catch (e) { /* the drag goes on without it */ }
      root.setAttribute('data-dragging', '');
    });
    function endDrag() {
      dragging = null;
      root.removeAttribute('data-dragging');
      if (hint) hint.hidden = true;
    }
    document.addEventListener('dragend', endDrag);
    // Which pane the pointer is over, and which part of it.
    function zone(x, y) {
      var target = null;
      var rect = null;
      if (on()) {
        var all = list();
        for (var i = 0; i < all.length && !target; i++) {
          if (all[i].el.hidden) continue;
          var r = all[i].el.getBoundingClientRect();
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { target = all[i]; rect = r; }
        }
        if (!target) return null;
      } else rect = main.getBoundingClientRect();
      var fx = (x - rect.left) / (rect.width || 1);
      var fy = (y - rect.top) / (rect.height || 1);
      return { pane: target, where: fx > 2 / 3 ? 'right' : fy > 2 / 3 ? 'below' : 'here', rect: rect };
    }
    function show(z) {
      if (!z) { if (hint) hint.hidden = true; return; }
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'fx-drop';
        hint.setAttribute('aria-hidden', 'true');
        main.appendChild(hint);
      }
      var m = main.getBoundingClientRect();
      var left = z.rect.left - m.left;
      var top = z.rect.top - m.top;
      var w = z.rect.width;
      var h = z.rect.height;
      if (z.where === 'right') { left += w / 2; w /= 2; }
      if (z.where === 'below') { top += h / 2; h /= 2; }
      hint.style.left = left + 6 + 'px';
      hint.style.top = top + 6 + 'px';
      hint.style.width = Math.max(0, w - 12) + 'px';
      hint.style.height = Math.max(0, h - 12) + 'px';
      hint.setAttribute('data-where', z.where);
      hint.hidden = false;
    }
    main.addEventListener('dragover', function (event) {
      if (dragging === null) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      show(zone(event.clientX, event.clientY));
    });
    main.addEventListener('dragleave', function (event) {
      if (dragging !== null && !(event.relatedTarget && main.contains(event.relatedTarget))) show(null);
    });
    main.addEventListener('drop', function (event) {
      if (dragging === null) return;
      event.preventDefault();
      var z = zone(event.clientX, event.clientY);
      var q = dragging;
      endDrag();
      if (!z) return;
      if (z.where === 'here') {
        if (z.pane) { setFocus(z.pane, false); openHere(q); }
        else showHere(q);
        return;
      }
      if (z.pane) setFocus(z.pane, false);
      openNew(q, z.where);
    });

    window.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (ctxOpen()) { event.preventDefault(); event.stopImmediatePropagation(); hideCtx(); return; }
        if (peeking() && !side.querySelector('details[open]') && !modal()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          peek(false);
          // The focus goes back to the button without floating the list out again.
          hush = true;
          if (opener) opener.focus();
          hush = false;
          return;
        }
      }
      var key = keyOf(event);
      if (!PANE_KEYS[key]) return;
      event.preventDefault();
      if (!modal()) act(key);
    }, true);

    // ---- the side list's peek (§11.4)

    var hover = window.matchMedia ? window.matchMedia('(hover: hover)') : null;
    var openTimer = null;
    var closeTimer = null;
    var overButton = false;
    var overSide = false;
    var hush = false;
    function collapsed() { return root.getAttribute('data-side') === 'closed' && !narrow(); }
    function peeking() { return root.hasAttribute('data-peek'); }
    function stopTimers() {
      if (openTimer) { clearTimeout(openTimer); openTimer = null; }
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    }
    function peek(out, how) {
      stopTimers();
      if (out && collapsed()) root.setAttribute('data-peek', how || 'hover');
      else root.removeAttribute('data-peek');
      if (opener) opener.setAttribute('aria-expanded', peeking() ? 'true' : 'false');
    }
    // What keeps it out with the pointer gone: a menu, a drag, a dialog, the keyboard.
    function held() {
      if (dragging !== null || ctxOpen() || side.querySelector('details[open]') || modal()) return true;
      var active = document.activeElement;
      return !!active && side.contains(active) && !!active.matches && active.matches(':focus-visible');
    }
    function soonClose() {
      if (!peeking() || root.getAttribute('data-peek') === 'drawer' || closeTimer) return;
      closeTimer = setTimeout(function () {
        closeTimer = null;
        if (overButton || overSide) return;
        if (held()) { soonClose(); return; }
        peek(false);
      }, ${PEEK_CLOSE_MS});
    }
    if (opener) {
      opener.addEventListener('pointerenter', function (event) {
        overButton = true;
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        if (event.pointerType === 'touch' || !collapsed() || peeking() || openTimer) return;
        openTimer = setTimeout(function () {
          openTimer = null;
          if (overButton) peek(true, 'hover');
        }, ${PEEK_OPEN_MS});
      });
      opener.addEventListener('pointerleave', function () {
        overButton = false;
        if (openTimer) { clearTimeout(openTimer); openTimer = null; }
        soonClose();
      });
      opener.addEventListener('focus', function () {
        if (!hush && collapsed() && !peeking() && opener.matches && opener.matches(':focus-visible')) peek(true, 'key');
      });
      opener.addEventListener('click', function (event) {
        if (!collapsed()) return;
        // No hover (a touch screen): the button is a drawer's.
        if (event.pointerType === 'touch' || (hover && !hover.matches)) {
          event.preventDefault();
          event.stopPropagation();
          peek(!peeking(), 'drawer');
          return;
        }
        // Out already, or not: a click opens the side list for good (the front's own action).
        peek(false);
      }, true);
    }
    side.addEventListener('pointerenter', function () {
      overSide = true;
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    });
    side.addEventListener('pointerleave', function () { overSide = false; soonClose(); });
    function away(target) { return !target || !((opener && opener.contains(target)) || side.contains(target)); }
    side.addEventListener('focusout', function (event) { if (away(event.relatedTarget)) soonClose(); });
    if (opener) opener.addEventListener('focusout', function (event) { if (away(event.relatedTarget)) soonClose(); });
    var scrim = document.querySelector('.fx-scrim');
    if (scrim) {
      scrim.addEventListener('click', function (event) {
        if (root.getAttribute('data-peek') !== 'drawer') return;
        event.preventDefault();
        event.stopPropagation();
        peek(false);
      }, true);
    }
    new MutationObserver(function () {
      if (peeking() && !collapsed()) peek(false);
      place();
    }).observe(root, { attributes: true, attributeFilter: ['data-side'] });
    if (window.matchMedia) {
      var wide = window.matchMedia(NARROW);
      var onWidth = function () { if (peeking() && !collapsed()) peek(false); };
      if (wide.addEventListener) wide.addEventListener('change', onWidth);
      else if (wide.addListener) wide.addListener(onWidth);
    }

    // ---- what was kept

    function start() {
      if (!SPLITS) return;
      var kept = load();
      if (!kept) return;
      var params = new URLSearchParams(window.location.search);
      var named = window.location.pathname === PATH &&
        (!!params.get('session') || (!CODE && (!!params.get('agent') || params.get('work') === 'new')));
      if (named) {
        var asked = norm(queryOf(window.location.search));
        var flat = [];
        for (var i = 0; i < kept.cols.length; i++) for (var j = 0; j < kept.cols[i].rows.length; j++) flat.push(kept.cols[i].rows[j]);
        var at = -1;
        for (var k = 0; k < flat.length; k++) if (flat[k].q === asked) at = k;
        if (at >= 0) kept.focus = at;
        else flat[kept.focus].q = asked;
      }
      build(kept);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})();
`
}

/** The panes' and the peek's script (§11), for every face. */
export const FRONT_SPLIT_JS = stripJsLineComments(splitScript())
