// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * In-place navigation for the management side (`docs/dev/qmo-local.md`
 * §3.2), as one string inlined after the shared runtime (`client.ts`).
 *
 * Every page under `/admin` is still a whole server-rendered document: a
 * browser that opens one, reloads it or runs no script gets exactly what it
 * got before. What this adds is that, once a page is up, moving to another
 * one does not load another document. A same-origin link under `/admin` —
 * the sidebar, the breadcrumb, a row's link — is fetched again with
 * {@link PARTIAL_HEADER}, and the console answers with only the parts that
 * change (`view/shell.ts`, `shellPartial`): the title, the breadcrumb, the
 * top bar's tail, the page body, the sidebar's items, the page's own sheet
 * and the page's own script. Those are put in place; the frame, the runtime,
 * the toasts, the dialogs outside the page and the document itself stay.
 *
 * ## What it never does
 *
 * It never builds markup. Everything it puts on the page is markup the
 * server rendered for this reader (the runtime's own rule, `client.ts`), and
 * the one script it runs is a page script the document's policy already
 * allows by hash: the first document lists every page script the reader can
 * navigate to (`respond.ts`, `cspFor`), the answer names the hash of the one
 * it carries, and when the policy does not list it — another release, a
 * role that changed — the browser loads the page as a whole document
 * instead. The same happens for anything that is not this protocol's
 * answer: a 401 or a redirect to the login door (the desktop app catches
 * that one and signs in again, `qmo-app.md` §3), a 403, a 404, another
 * release's frame ({@link navScript}'s key). Only a failure to get any
 * answer keeps the page on screen, with one thin line and one retry.
 *
 * ## A page script's lifetime
 *
 * Page scripts are written as if their page were the document: they add
 * listeners to `document` and `window`, start timers, register actions with
 * the runtime. Run again on every visit, they would pile up. So a page
 * script is mounted inside a recording scope: while it runs, the listeners
 * it adds to `document` and `window`, the timers it starts, the actions,
 * submits and expiry hooks it registers with the runtime and the properties
 * it adds to `window` and the runtime are noted, and leaving the page undoes
 * exactly those — the expiry hooks run first, since they are what stops a
 * page's pollers. Work a page starts later, from a click, is stopped the same
 * way: by the expiry hook the page registers for it (`qc.onExpire`), or by
 * one registered with `qianmoNav.onLeave`.
 *
 * ## Speed
 *
 * A link is fetched when the pointer goes down on it, or after it has been
 * hovered for 80 ms; the answer is reused for five seconds. The last twenty
 * pages are kept in memory: going back, or to a page seen before, shows the
 * kept copy at once and asks again in the background, replacing the copy
 * only if it changed and the reader has not touched the page since. Nothing
 * is written to storage; signing out, switching tokens and a lapsed session
 * empty it, and the next move after a token switch is a whole document (its
 * role chip and policy are the new credential's).
 *
 * ## The rest of §3
 *
 * - **先改后同步 for `data-write` controls (§3.3).** A switch, a radio or a
 *   select marked `data-write` already changes the moment it is used; while
 *   the write its change sends is out, a line beside it says 保存中, and a
 *   refused write puts the control back and says why in the same place. A
 *   form's 保存 button reads 保存中 while its write is out. Setting rows
 *   (`view/settingRow.ts`) do all of this themselves and are left alone.
 * - **Leaving for the front (§3.2).** A link out of `/admin` (对话 is `/`)
 *   is a whole navigation, but the sidebar marks the item and the page dims
 *   at once, so the click is answered before the next document paints.
 * - **The first frame (§3.5).** In the desktop app (`window.__QMO_SHELL__`)
 *   the side panel's layout is reported with `qmo_boot_layout` whenever it
 *   changes; a shell without the command makes it a no-op.
 */

import { CONSOLE_HEADER, CONSOLE_HEADER_VALUE } from '../auth.js'
import { stripJsLineComments } from './client.js'

/** The request header that asks a page for its parts instead of a document. */
export const PARTIAL_HEADER = 'x-qianmo-partial'

/** The shape of the parts (`view/shell.ts`, `ShellPartial`); bumped on change. */
export const PARTIAL_VERSION = 1

function navSource(key: string): string {
  return `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc || window.qianmoNav) return;
  if (typeof fetch !== 'function' || !window.history || !history.pushState ||
      typeof Map !== 'function' || !('content' in document.createElement('template'))) return;

  // The frame this document carries; an answer for another frame is a
  // whole navigation.
  var SHELL = '${key}';
  var VERSION = ${PARTIAL_VERSION};
  var KEEP = 20;
  var FRESH_MS = 5000;
  var HOVER_MS = 80;
  var RETRY_MS = 1200;
  var byId = qc.byId;
  var later = window.setTimeout;
  var never = window.clearTimeout;

  /* ---------------- a page script's scope ---------------- */

  var page = null;
  var rec = null;

  function patch(obj, name, fn) {
    var own = Object.prototype.hasOwnProperty.call(obj, name);
    var was = obj[name];
    obj[name] = fn;
    return function () { if (own) obj[name] = was; else delete obj[name]; };
  }

  function added(before, after) {
    var seen = {};
    for (var i = 0; i < before.length; i++) seen[before[i]] = true;
    return after.filter(function (key) { return !seen[key]; });
  }

  // Everything a page script does to the document, the window and the
  // runtime while it runs is noted, so leaving the page can undo it.
  function begin() {
    var s = { on: [], timers: [], actions: [], submits: [], leave: [], keys: [], globals: [] };
    var keys = Object.keys(qc);
    var globals = Object.keys(window);
    var timeout = window.setTimeout;
    var interval = window.setInterval;
    var onAction = qc.onAction;
    var onSubmit = qc.onSubmit;
    var listen = function (target) {
      var add = target.addEventListener;
      return patch(target, 'addEventListener', function (type, fn, options) {
        s.on.push([target, type, fn, options]);
        return add.call(target, type, fn, options);
      });
    };
    var undo = [
      listen(document),
      listen(window),
      patch(window, 'setTimeout', function () {
        var id = timeout.apply(window, arguments);
        s.timers.push(id);
        return id;
      }),
      patch(window, 'setInterval', function () {
        var id = interval.apply(window, arguments);
        s.timers.push(id);
        return id;
      }),
      patch(qc, 'onAction', function (name, run) { s.actions.push(name); onAction(name, run); }),
      patch(qc, 'onSubmit', function (id, run) { s.submits.push(id); onSubmit(id, run); }),
      patch(qc, 'onExpire', function (run) { s.leave.push(run); })
    ];
    rec = {
      scope: s,
      done: function () {
        for (var i = undo.length - 1; i >= 0; i--) undo[i]();
        s.keys = added(keys, Object.keys(qc));
        s.globals = added(globals, Object.keys(window));
      }
    };
  }

  function end() {
    var r = rec;
    if (!r) return null;
    rec = null;
    r.done();
    return r.scope;
  }

  function unmount(s) {
    if (!s) return;
    var i;
    for (i = 0; i < s.leave.length; i++) {
      try { s.leave[i](); } catch (e) { /* one hook must not keep the rest */ }
    }
    for (i = 0; i < s.on.length; i++) {
      var one = s.on[i];
      try { one[0].removeEventListener(one[1], one[2], one[3]); } catch (e) { /* gone already */ }
    }
    for (i = 0; i < s.timers.length; i++) never(s.timers[i]);
    for (i = 0; i < s.actions.length; i++) qc.onAction(s.actions[i], undefined);
    for (i = 0; i < s.submits.length; i++) qc.onSubmit(s.submits[i], undefined);
    for (i = 0; i < s.keys.length; i++) delete qc[s.keys[i]];
    for (i = 0; i < s.globals.length; i++) {
      try { delete window[s.globals[i]]; } catch (e) { /* not ours to delete */ }
    }
  }

  // Run a page script the policy allows (its hash is in the document's
  // CSP): inserted as an inline script it runs at once, inside the scope.
  function mount(text) {
    begin();
    if (text) {
      var el = document.createElement('script');
      el.textContent = text;
      try { document.body.appendChild(el); el.remove(); } catch (e) { /* the page stays without its script */ }
    }
    return end();
  }

  /* ---------------- the parts ---------------- */

  var cache = new Map();
  var pending = {};
  var scrolls = {};
  var seq = 0;
  var here = location.pathname + location.search;
  var whole = false;
  var touched = false;

  function admin(path) { return path === '/admin' || path.indexOf('/admin/') === 0; }
  function keyOf(url) { return url.pathname + url.search; }

  function linkOf(target) {
    var a = target && target.closest ? target.closest('a[href]') : null;
    if (!a || typeof a.href !== 'string' || a.hasAttribute('download') ||
        (a.target && a.target !== '_self')) return null;
    var url;
    try { url = new URL(a.href, location.href); } catch (e) { return null; }
    if (url.origin !== location.origin) return null;
    return { a: a, url: url };
  }

  function keep(key, data) {
    cache.delete(key);
    cache.set(key, { at: Date.now(), data: data });
    while (cache.size > KEEP) cache.delete(cache.keys().next().value);
  }

  function forget() { cache.clear(); pending = {}; }

  function allowed(hash) {
    var meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return !!meta && (meta.getAttribute('content') || '').indexOf(hash) !== -1;
  }

  function headers() {
    var h = { 'Accept': 'application/json', '${PARTIAL_HEADER}': '1', '${CONSOLE_HEADER}': '${CONSOLE_HEADER_VALUE}' };
    var token = qc.readToken();
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  // The page's parts, or a refusal: { whole: true } when only a document
  // can answer (let the browser load it), { retry: true } when nothing did.
  function load(key, fresh) {
    var hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < FRESH_MS) return Promise.resolve(hit.data);
    if (pending[key]) return pending[key];
    var p = fetch(key, { headers: headers(), credentials: 'same-origin', cache: 'no-store' }).then(function (res) {
      var type = res.headers.get('content-type') || '';
      // A hub or a proxy in front of it that could not answer: keep the page.
      if (res.status >= 500) throw { retry: true, status: res.status };
      if (res.status === 401 || type.indexOf('application/json') === -1) throw { whole: true };
      return res.json().then(function (data) {
        if (!data || data.v !== VERSION) throw { whole: true };
        if (data.shell !== SHELL || (data.hash && !allowed(data.hash))) throw { whole: true };
        var landed = res.redirected ? keyOf(new URL(res.url)) : key;
        if (!admin(landed.split('?')[0])) throw { whole: true };
        data.url = landed;
        keep(key, data);
        if (landed !== key) keep(landed, data);
        return data;
      });
    }, function () { throw { retry: true, status: 0 }; }).then(null, function (why) {
      throw why && (why.whole || why.retry) ? why : { whole: true };
    });
    pending[key] = p;
    var done = function () { if (pending[key] === p) delete pending[key]; };
    p.then(done, done);
    return p;
  }

  function warm(key) {
    if (key === here || whole || qc.isExpired()) return;
    load(key).then(null, function () { /* the click will say */ });
  }

  /* ---------------- painting ---------------- */

  var note = null;

  function busy(on) {
    if (on) document.documentElement.setAttribute('data-nav-busy', '');
    else document.documentElement.removeAttribute('data-nav-busy');
  }

  function say(text, retry) {
    if (!note && !text) return;
    if (!note) {
      note = document.createElement('p');
      note.className = 'bar bar-warn conn nav-note';
      note.id = 'nav-note';
      note.setAttribute('role', 'status');
      var conn = byId('conn');
      if (conn && conn.parentNode) conn.parentNode.insertBefore(note, conn.nextSibling);
      else return;
    }
    note.textContent = text;
    note.hidden = !text;
    if (retry) {
      var again = document.createElement('button');
      again.type = 'button';
      again.className = 'btn btn-ghost btn-small';
      again.textContent = '重试';
      again.addEventListener('click', retry);
      note.appendChild(document.createTextNode(' '));
      note.appendChild(again);
    }
  }

  // The item a click came from is current at once; the answer confirms it.
  function mark(from) {
    if (!from || !from.classList || !from.classList.contains('nav-item')) return;
    var items = document.querySelectorAll('#side .nav-item[aria-current]');
    for (var i = 0; i < items.length; i++) items[i].removeAttribute('aria-current');
    from.setAttribute('aria-current', 'page');
  }

  // The sidebar's items in place when they are the same items, so the
  // focused link and an opened fold stay as they are; redrawn otherwise.
  function patchNav(markup) {
    var nav = document.querySelector('#side nav.nav');
    if (!nav) return;
    var tpl = document.createElement('template');
    tpl.innerHTML = markup;
    var fresh = tpl.content.querySelectorAll('a.nav-item');
    var old = nav.querySelectorAll('a.nav-item');
    var same = fresh.length === old.length;
    for (var i = 0; same && i < fresh.length; i++) same = fresh[i].id === old[i].id;
    if (same) {
      for (var j = 0; j < old.length; j++) {
        if (old[j].innerHTML !== fresh[j].innerHTML) old[j].innerHTML = fresh[j].innerHTML;
        if (old[j].className !== fresh[j].className) old[j].className = fresh[j].className;
        if (fresh[j].hasAttribute('aria-current')) old[j].setAttribute('aria-current', 'page');
        else old[j].removeAttribute('aria-current');
      }
    } else {
      var open = !!nav.querySelector('details.nav-fold[open]');
      nav.innerHTML = markup;
      var fold = nav.querySelector('details.nav-fold');
      if (fold && open) fold.open = true;
    }
    var current = nav.querySelector('[aria-current="page"]');
    var holder = current && current.closest('details');
    if (holder) holder.open = true;
  }

  function refreshRow(data) {
    var row = document.querySelector('#side .refresh-row');
    if (!row && data.poll && data.refresh) {
      var foot = document.querySelector('#side .side-foot');
      if (!foot) return;
      foot.insertAdjacentHTML('afterbegin', data.refresh);
      row = foot.querySelector('.refresh-row');
      var toggle = byId('auto-refresh');
      var picker = byId('refresh-interval');
      var again = function () { if (qc.schedule) qc.schedule(); };
      if (toggle) toggle.addEventListener('change', again);
      if (picker) picker.addEventListener('change', again);
    }
    if (row) row.hidden = !data.poll;
  }

  function paint(data) {
    document.title = data.documentTitle;
    var title = byId('page-title');
    if (title) {
      title.textContent = data.title;
      var crumbs = title.parentNode.querySelector('nav');
      if (crumbs) crumbs.remove();
      if (data.crumbs) title.insertAdjacentHTML('beforebegin', data.crumbs);
    }
    var tail = document.querySelector('.top .top-tail');
    if (tail) tail.innerHTML = data.actions;
    var main = byId('main');
    if (main) main.innerHTML = data.main;
    patchNav(data.nav);
    var sheets = document.head.querySelectorAll('style');
    var sheet = sheets.length > 1 ? sheets[sheets.length - 1] : null;
    if (sheet && sheet.textContent !== data.css) sheet.textContent = data.css;
    refreshRow(data);
  }

  function fade(apply) {
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof document.startViewTransition !== 'function' || still) { apply(); return; }
    var root = document.documentElement;
    root.classList.add('nav-fade');
    var off = function () { root.classList.remove('nav-fade'); };
    try {
      var t = document.startViewTransition(apply);
      t.finished.then(off, off);
      if (t.ready) t.ready.then(null, function () {});
      if (t.updateCallbackDone) t.updateCallbackDone.then(null, function () {});
    } catch (e) { off(); apply(); }
  }

  // Leaving the page on screen: its script's work stops, its dialogs close.
  function leave() {
    unmount(page);
    page = null;
    qc.closeDialogs();
    qc.closeDrawer('side');
  }

  function show(data, how, y, mine) {
    fade(function () {
      if (mine !== seq) return;
      var active = document.activeElement;
      var main = byId('main');
      var lost = !active || active === document.body || (main && main.contains(active));
      leave();
      paint(data);
      if (how === 'push') history.pushState({ qianmoNav: 1 }, '', data.url);
      else if (data.url !== location.pathname + location.search) history.replaceState({ qianmoNav: 1 }, '', data.url);
      here = data.url;
      page = mount(data.script);
      if (qc.schedule) qc.schedule();
      window.scrollTo(0, typeof y === 'number' ? y : 0);
      if (lost && main) main.focus({ preventScroll: true });
      touched = false;
      say('');
      layout();
      document.dispatchEvent(new CustomEvent('qianmo:nav', { detail: { url: here } }));
    });
  }

  // A kept copy is on screen: ask again, and put the answer up only if it
  // differs and the reader has not started on the page.
  function revalidate(key, mine) {
    load(key, true).then(function (data) {
      if (mine !== seq || touched || here !== data.url) return;
      var main = byId('main');
      if (main && main.innerHTML === data.main) return;
      show(data, 'stay', window.scrollY, mine);
    }, function () { /* the copy on screen stays */ });
  }

  function fallBack(key, how) {
    if (how === 'pop' || how === 'stay') location.reload();
    else location.assign(key);
  }

  function go(key, how, y, from) {
    if (whole || qc.isExpired()) { fallBack(key, how); return; }
    var mine = ++seq;
    scrolls[here] = window.scrollY;
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    mark(from);
    var hit = cache.get(key);
    if (hit) {
      show(hit.data, how, y, mine);
      if (Date.now() - hit.at >= FRESH_MS) revalidate(key, mine);
      return;
    }
    busy(true);
    var attempt = function (tries) {
      load(key).then(function (data) {
        if (mine !== seq) return;
        busy(false);
        show(data, how, y, mine);
      }, function (why) {
        if (mine !== seq) return;
        if (why.whole) { fallBack(key, how); return; }
        if (tries === 0) {
          say('页面没有打开 · 正在重试');
          later(function () { if (mine === seq) attempt(1); }, RETRY_MS);
          return;
        }
        busy(false);
        say(navigator.onLine === false ? '页面没有打开 · 浏览器离线' :
          '页面没有打开 · ' + (why.status ? 'HTTP ' + why.status : '无法连接'),
          function () { go(key, how === 'pop' ? 'stay' : how, y, null); });
      });
    };
    attempt(0);
  }

  /* ---------------- wiring ---------------- */

  // Last in line, so a page script or the runtime that took the click
  // (data-action, a dialog opener) keeps it.
  window.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
        event.shiftKey || event.altKey) return;
    var hit = linkOf(event.target);
    if (!hit) return;
    var url = hit.url;
    if (!admin(url.pathname)) { leaving(hit.a); return; }
    if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
    event.preventDefault();
    var key = keyOf(url);
    go(key, key === here ? 'stay' : 'push', 0, hit.a);
  });

  // Out of /admin (对话 is the front at /): a whole document, but the click
  // is answered now.
  function leaving(a) {
    mark(a);
    busy(true);
    later(function () { busy(false); }, 8000);
  }
  window.addEventListener('pageshow', function () { busy(false); });

  document.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    var hit = linkOf(event.target);
    if (hit && admin(hit.url.pathname)) warm(keyOf(hit.url));
  }, true);

  var hover = null;
  document.addEventListener('pointerover', function (event) {
    var hit = linkOf(event.target);
    if (!hit || !admin(hit.url.pathname)) return;
    var key = keyOf(hit.url);
    if (hover && hover.key === key) return;
    if (hover) never(hover.timer);
    hover = { key: key, timer: later(function () { hover = null; warm(key); }, HOVER_MS) };
  }, true);
  document.addEventListener('pointerout', function (event) {
    if (!hover) return;
    var hit = linkOf(event.relatedTarget);
    if (hit && keyOf(hit.url) === hover.key) return;
    never(hover.timer);
    hover = null;
  }, true);

  window.addEventListener('popstate', function () {
    var key = location.pathname + location.search;
    if (key === here) return;
    if (!admin(location.pathname)) { location.reload(); return; }
    go(key, 'pop', scrolls[key] || 0, null);
  });

  // The reader started on the page: a background answer no longer replaces it.
  var start = function (event) {
    var main = byId('main');
    if (main && event.target && main.contains(event.target)) touched = true;
  };
  document.addEventListener('pointerdown', start, true);
  document.addEventListener('keydown', start, true);

  // A new credential is a new reader: nothing kept, and the next move loads
  // a whole document (role chip, policy and sidebar are theirs).
  document.addEventListener('click', function (event) {
    var el = event.target && event.target.closest ?
      event.target.closest('[data-action="token-save"], [data-action="token-clear"]') : null;
    if (el) { forget(); whole = true; }
  }, true);
  document.addEventListener('submit', function (event) {
    if (event.target && event.target.id === 'logout-form') { forget(); whole = true; }
  }, true);
  qc.onExpire(function () {
    forget();
    whole = true;
    if (page) { var s = page; page = null; unmount(s); }
  });

  /* ---------------- 先改后同步: data-write controls (§3.3) ---------------- */

  var writing = null;
  var before = typeof WeakMap === 'function' ? new WeakMap() : null;
  var CHOICE = 'select[data-write], input[type="radio"][data-write]';

  function checkedIn(radio) {
    if (!radio.name) return radio.checked ? radio : null;
    var scope = radio.form || document;
    var group = scope.querySelectorAll('input[type="radio"]');
    for (var i = 0; i < group.length; i++) {
      if (group[i].name === radio.name && group[i].checked) return group[i];
    }
    return null;
  }

  // A select's value and a radio group's choice before the reader changes
  // them; a checkbox's is the opposite of what it says now.
  function noteBefore(event) {
    var el = event.target;
    if (!before || !el || !el.matches || !el.matches(CHOICE)) return;
    before.set(el, el.tagName === 'SELECT' ? { value: el.value } : { radio: checkedIn(el) });
  }
  document.addEventListener('focusin', noteBefore, true);
  document.addEventListener('pointerdown', noteBefore, true);

  function undoFor(el) {
    if (el.type === 'checkbox') { var was = !el.checked; return function () { el.checked = was; }; }
    var seen = before ? before.get(el) : null;
    if (!seen) return null;
    if (el.tagName === 'SELECT') return function () { el.value = seen.value; };
    return function () { if (seen.radio) seen.radio.checked = true; else el.checked = false; };
  }

  document.addEventListener('change', function (event) {
    var el = event.target;
    if (!el || !el.matches || !el.matches('input[type="checkbox"][data-write], ' + CHOICE)) return;
    if (el.closest('.setting[data-setting]')) return;
    writing = { el: el, undo: undoFor(el) };
    later(function () { writing = null; }, 0);
  }, true);

  var submitting = null;
  document.addEventListener('submit', function (event) {
    var by = event.submitter;
    if (!by || by.tagName !== 'BUTTON' || !by.hasAttribute('data-write') || by.children.length > 0) return;
    if (!/^保存/.test((by.textContent || '').trim())) return;
    submitting = by;
    later(function () { submitting = null; }, 0);
  }, true);

  function lineBeside(el) {
    var anchor = el.closest('label') || el;
    var next = anchor.nextElementSibling;
    if (next && next.hasAttribute('data-write-note')) return next;
    var line = document.createElement('span');
    line.className = 'write-note';
    line.setAttribute('data-write-note', '');
    line.setAttribute('role', 'status');
    anchor.parentNode.insertBefore(line, anchor.nextSibling);
    return line;
  }

  var sendJson = qc.sendJson;
  qc.sendJson = function (method) {
    var job = null;
    var button = null;
    if (method !== 'GET') {
      job = writing;
      button = submitting;
      writing = null;
      submitting = null;
    }
    var sent = sendJson.apply(qc, arguments);
    if (button) {
      var words = button.textContent;
      button.textContent = '保存中…';
      var back = function () { if (button.textContent === '保存中…') button.textContent = words; };
      sent.then(back, back);
    }
    if (!job || !job.el.isConnected || !job.el.parentNode) return sent;
    var el = job.el;
    var line = lineBeside(el);
    qc.say(line, '保存中…', 'muted');
    el.setAttribute('aria-busy', 'true');
    return sent.then(function (data) {
      el.removeAttribute('aria-busy');
      qc.say(line, '', 'muted');
      return data;
    }, function (err) {
      el.removeAttribute('aria-busy');
      if (job.undo && el.isConnected) job.undo();
      qc.say(line, qc.failLine('保存', err), qc.failTone(err));
      line.setAttribute('role', 'alert');
      throw err;
    });
  };

  /* ---------------- the first frame (§3.5) ---------------- */

  var shell = !!window.__QMO_SHELL__ && typeof window.__QMO_SHELL__ === 'object';
  var core = window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function' ?
    window.__TAURI__.core : null;
  var sent = '';
  var layoutTimer = null;

  // What the desktop app's skeleton draws before this page paints next time
  // (qmo-local.md §3.5): which frame, whether the side panel is out, how
  // wide, how many rows and group headings it shows, the theme.
  function layoutNow() {
    var side = byId('side');
    if (!side) return;
    var narrow = !!(window.matchMedia && window.matchMedia('(max-width: 1000px)').matches);
    // Rows inside a closed fold are not drawn; checkVisibility says so where
    // a closed <details> skips its content rather than removing its boxes.
    var visible = function (list) {
      var n = 0;
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0) n++;
      }
      return n;
    };
    var info = {
      page: 'admin',
      side: narrow ? 'closed' : 'open',
      sideWidth: Math.round(side.getBoundingClientRect().width),
      rows: Math.min(60, visible(side.querySelectorAll('.nav-item'))),
      labels: Math.min(20, visible(side.querySelectorAll('.nav-group-name'))),
      theme: document.documentElement.getAttribute('data-theme') || 'system'
    };
    var text = JSON.stringify(info);
    if (text === sent) return;
    sent = text;
    try { Promise.resolve(core.invoke('qmo_boot_layout', { layout: info })).then(null, function () {}); }
    catch (e) { /* an older app without the command */ }
  }

  function layout() {
    if (!shell || !core) return;
    if (layoutTimer) never(layoutTimer);
    layoutTimer = later(function () { layoutTimer = null; layoutNow(); }, 400);
  }
  window.addEventListener('resize', layout);
  document.addEventListener('toggle', function (event) {
    if (event.target && event.target.classList && event.target.classList.contains('nav-fold')) layout();
  }, true);
  document.addEventListener('qianmo:theme', layout);

  /* ---------------- the page this document came with ---------------- */

  window.qianmoNav = {
    // Whatever a page wants to move to, in place when it can be.
    go: function (url) {
      var target;
      try { target = new URL(url, location.href); } catch (e) { return; }
      if (target.origin !== location.origin || !admin(target.pathname)) { location.assign(url); return; }
      go(keyOf(target), 'push', 0, null);
    },
    // The end of the first page script's scope (the shell puts this after it).
    mounted: function () { var s = end(); if (s) page = s; },
    // Work a page started that leaving it should stop.
    onLeave: function (run) {
      if (rec) rec.scope.leave.push(run);
      else if (page) page.leave.push(run);
    }
  };

  // A page script that threw before the call above: its scope ends here.
  document.addEventListener('DOMContentLoaded', function () {
    window.qianmoNav.mounted();
    layout();
  });
  if (document.readyState !== 'loading') later(layout, 0);

  begin();
})();
`
}

/**
 * The navigation runtime for a document whose frame is `key`
 * (`view/shell.ts`, `SHELL_KEY`). An answer naming another key is from a
 * release with another sheet or runtime, and is loaded as a whole document.
 */
export function navScript(key: string): string {
  return stripJsLineComments(navSource(key))
}

/**
 * What the shell puts after the first page's script, in the same `<script>`:
 * the end of that script's recording scope.
 */
export const NAV_MOUNTED_JS =
  '\nwindow.qianmoNav && window.qianmoNav.mounted();\n'
