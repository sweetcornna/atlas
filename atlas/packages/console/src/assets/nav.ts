// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The settings card and the moves inside it (`docs/dev/qmo-local.md` §3.2,
 * §3.6), as one string inlined after the front's scripts (`view/front.ts`).
 *
 * Every management area lives under `/admin` and opens as a card over the
 * console's main window (`view/shell.ts`, `renderSettings`): the list of
 * areas on the left, the area on the right. A browser that opens an area's
 * address, reloads it or runs no script gets the whole document with the
 * card drawn open. What this adds is that, once a page is up, nothing loads
 * another document: the card opens over the page (the slider at the foot of
 * the side list, 设置 in its menu, ⌘, or Ctrl+,, the desktop app's menu
 * 设置… through `window.__qmoOpenSettings`), and a same-origin link
 * under `/admin` — the card's list, a breadcrumb, a row's link, an agent's
 * menu on the front — is fetched again with {@link PARTIAL_HEADER}. The
 * console answers with only the parts that change (`shellPartial`): the
 * title, the breadcrumb, the title row's tail, the page, the list's items,
 * the page's own sheet and the page's own script. Those are put in the card;
 * the page under it, the runtime, the toasts and the document stay.
 *
 * ## The card's address
 *
 * Opening the card pushes the area's address, and every move inside it
 * pushes the next; the entries it pushed carry how deep they are. Closing
 * goes back past all of them to the page the card was opened over; a card
 * the document came with (an area's address opened directly) goes back to
 * its first entry and turns it into the front's address. Back and forward
 * open and close the card the same way. A link inside the card that leaves
 * `/admin` closes the card first and then is followed.
 *
 * ## What it never does
 *
 * It never builds markup. Everything it puts on the page is markup the
 * server rendered for this reader (the runtime's own rule, `client.ts`), and
 * the one script it runs is a page script the document's policy already
 * allows by hash: the document lists every page script the reader can
 * navigate to (`respond.ts`, `cspFor`), the answer names the hash of the one
 * it carries, and when the policy does not list it — another release, a
 * role that changed — the browser loads the area as a whole document
 * instead. The same happens for anything that is not this protocol's
 * answer: a 401 or a redirect to the login door (the desktop app catches
 * that one and signs in again, `qmo-app.md` §3), a 403, a 404, another
 * release's frame ({@link navScript}'s key). Only a failure to get any
 * answer keeps the card as it is, with one thin line and one retry.
 *
 * ## A page script's lifetime
 *
 * Page scripts are written as if their page were the document: they add
 * listeners to `document` and `window`, start timers, register actions with
 * the runtime. Run again on every visit, they would pile up. So a page
 * script is mounted inside a recording scope: while it runs, the listeners
 * it adds to `document` and `window`, the timers it starts, the actions,
 * submits and expiry hooks it registers with the runtime and the properties
 * it adds to `window` and the runtime are noted, and leaving the page —
 * moving on, or closing the card — undoes exactly those; the expiry hooks
 * run first, since they are what stops a page's pollers. Work a page starts
 * later, from a click, is stopped the same way: by the expiry hook the page
 * registers for it (`qc.onExpire`), or by one registered with
 * `qianmoNav.onLeave`.
 *
 * ## Speed
 *
 * A link is fetched when the pointer goes down on it, so the time to the
 * button coming up is already spent loading. Hovering fetches nothing: every
 * answer is a roster read and a page render on the hub, and a pointer
 * crossing a list would ask for pages nobody opens. An answer is reused for
 * five seconds. The last twenty pages are kept in memory: going back, or to
 * a page seen before, shows the kept copy at once and asks again in the
 * background, replacing the copy only if it changed and the reader has not
 * touched the page since. Nothing is written to storage but the last area
 * opened (`sessionStorage`), which is where the card opens next; signing
 * out, switching tokens and a lapsed session empty the memory, and the next
 * move after a token switch is a whole document.
 *
 * ## 先改后同步 for `data-write` controls (§3.3)
 *
 * A switch, a radio or a select marked `data-write` already changes the
 * moment it is used; while the write its change sends is out, a line beside
 * it says 保存中, and a refused write puts the control back and says why in
 * the same place. A form's 保存 button reads 保存中 while its write is out.
 * Setting rows (`view/settingRow.ts`) do all of this themselves and are left
 * alone.
 */

import { CONSOLE_HEADER, CONSOLE_HEADER_VALUE } from '../auth.js'
import { stripJsLineComments } from './client.js'

/** The request header that asks a page for its parts instead of a document. */
export const PARTIAL_HEADER = 'x-qianmo-partial'

/**
 * The shape of the parts (`view/shell.ts`, `ShellPartial`); bumped on
 * change. 2: the list is the card's, one flat list (P37.13, §3.6).
 */
export const PARTIAL_VERSION = 2

function navSource(key: string): string {
  return `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  var card = document.getElementById('settings');
  if (!qc || window.qianmoNav || !card) return;
  if (typeof fetch !== 'function' || !window.history || !history.pushState ||
      typeof Map !== 'function' || typeof card.showModal !== 'function' ||
      !('content' in document.createElement('template'))) return;

  // The frame this document carries; an answer for another frame is a
  // whole navigation.
  var SHELL = '${key}';
  var VERSION = ${PARTIAL_VERSION};
  var KEEP = 20;
  var FRESH_MS = 5000;
  var RETRY_MS = 1200;
  var LAST = 'qianmo.settings';
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
  var here = '';
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

  var list = byId('set-nav');
  var search = byId('set-search');
  var note = null;

  function busy(on) {
    if (on) card.setAttribute('data-busy', '');
    else card.removeAttribute('data-busy');
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
    if (!list || !from || !list.contains(from)) return;
    var items = list.querySelectorAll('.nav-item[aria-current]');
    for (var i = 0; i < items.length; i++) items[i].removeAttribute('aria-current');
    from.setAttribute('aria-current', 'page');
  }

  // The search line over the list: names that contain what is typed.
  function filter() {
    if (!list) return;
    var q = search ? (search.value || '').trim().toLowerCase() : '';
    var items = list.querySelectorAll('.nav-item');
    var left = 0;
    for (var i = 0; i < items.length; i++) {
      var label = items[i].querySelector('.nav-label');
      var hit = !q || (label ? label.textContent : '').toLowerCase().indexOf(q) !== -1;
      items[i].hidden = !hit;
      if (hit) left++;
    }
    list.classList.toggle('is-filtering', !!q);
    var none = byId('set-none');
    if (none) none.hidden = left > 0;
  }

  // The list's items in place when they are the same items, so the focused
  // link stays as it is; redrawn otherwise.
  function patchNav(markup) {
    if (!list) return;
    var tpl = document.createElement('template');
    tpl.innerHTML = markup;
    var fresh = tpl.content.querySelectorAll('a.nav-item');
    var old = list.querySelectorAll('a.nav-item');
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
      list.innerHTML = markup;
    }
    filter();
  }

  // The current area in sight in the list (a row that scrolls sideways
  // on a narrow window).
  function reveal() {
    var at = list ? list.querySelector('.nav-item[aria-current]') : null;
    if (at && at.scrollIntoView) at.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function refreshRow(data) {
    var row = card.querySelector('.refresh-row');
    if (!row && data.poll && data.refresh) {
      var foot = card.querySelector('.set-foot');
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

  // The page's own sheet is the document's last <style>.
  function sheet(css) {
    var sheets = document.head.querySelectorAll('style');
    var last = sheets.length > 1 ? sheets[sheets.length - 1] : null;
    if (last && last.textContent !== css) last.textContent = css;
  }

  function lead(crumbs, title) {
    var head = byId('page-title');
    if (!head) return;
    head.textContent = title;
    var old = head.parentNode.querySelector('nav');
    if (old) old.remove();
    if (crumbs) head.insertAdjacentHTML('beforebegin', crumbs);
  }

  function paint(data) {
    document.title = data.documentTitle;
    lead(data.crumbs, data.title);
    var tail = byId('set-tail');
    if (tail) tail.innerHTML = data.actions;
    var main = byId('main');
    if (main) main.innerHTML = data.main;
    patchNav(data.nav);
    reveal();
    sheet(data.css);
    refreshRow(data);
    try { sessionStorage.setItem(LAST, data.url); } catch (e) { /* the first area next time */ }
  }

  // The card with nothing in it: what it is between two openings.
  function blank() {
    lead('', '');
    var tail = byId('set-tail');
    if (tail) tail.innerHTML = '';
    var main = byId('main');
    if (main) main.innerHTML = '';
    sheet('');
    var row = card.querySelector('.refresh-row');
    if (row) row.hidden = true;
    if (list) {
      var items = list.querySelectorAll('.nav-item[aria-current]');
      for (var i = 0; i < items.length; i++) items[i].removeAttribute('aria-current');
    }
    say('');
  }

  function still() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function fade(apply) {
    if (typeof document.startViewTransition !== 'function' || still() || !card.hasAttribute('data-shown')) { apply(); return; }
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

  // Leaving the page in the card: its script's work stops, its dialogs close.
  function leave() {
    unmount(page);
    page = null;
    var main = byId('main');
    var open = main ? main.querySelectorAll('dialog[open]') : [];
    for (var i = 0; i < open.length; i++) { try { open[i].close(); } catch (e) { /* closed already */ } }
  }

  /* ---------------- the card's address ---------------- */

  // An entry the card pushed: how deep it is, and whether the card came
  // with the document ('doc') or was opened over the page ('work').
  function entry() { var s = history.state; return s && s.qianmoNav ? s : null; }

  function push(url) {
    var s = entry();
    history.pushState({ qianmoNav: 1, d: s ? (s.d || 0) + 1 : 1, base: s ? s.base : 'work' }, '', url);
  }

  function replace(url) {
    var s = entry();
    history.replaceState({ qianmoNav: 1, d: s ? s.d || 0 : 0, base: s ? s.base : 'doc' }, '', url);
  }

  // The front's address under the card: the face this document draws.
  function workHome() {
    var fx = byId('fx');
    var layout = fx ? fx.getAttribute('data-layout') : '';
    return layout === 'chat' ? '/app' : layout === 'code' ? '/code' : '/';
  }

  function show(data, how, y, mine) {
    fade(function () {
      if (mine !== seq) return;
      var active = document.activeElement;
      var main = byId('main');
      var lost = !active || active === document.body || active === card || (main && main.contains(active));
      leave();
      paint(data);
      if (how === 'push') push(data.url);
      else if (data.url !== location.pathname + location.search) replace(data.url);
      here = data.url;
      page = mount(data.script);
      if (qc.schedule) qc.schedule();
      if (main) main.scrollTop = typeof y === 'number' ? y : 0;
      if (lost && main) main.focus({ preventScroll: true });
      touched = false;
      say('');
      document.dispatchEvent(new CustomEvent('qianmo:nav', { detail: { url: here } }));
    });
  }

  // A kept copy is on screen: ask again, and put the answer up only if it
  // differs and the reader has not started on the page.
  function revalidate(key, mine) {
    load(key, true).then(function (data) {
      if (mine !== seq || touched || here !== data.url || !card.open) return;
      var main = byId('main');
      if (main && main.innerHTML === data.main) return;
      show(data, 'stay', main ? main.scrollTop : 0, mine);
    }, function () { /* the copy on screen stays */ });
  }

  function fallBack(key, how) {
    if (how === 'pop' || how === 'stay') location.reload();
    else location.assign(key);
  }

  function go(key, how, y, from) {
    if (whole || qc.isExpired()) { fallBack(key, how); return; }
    var mine = ++seq;
    var main = byId('main');
    if (here) scrolls[here] = main ? main.scrollTop : 0;
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
        if (!card.open) return;
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

  /* ---------------- opening and closing ---------------- */

  var opener = null;
  var popping = false;
  var landing = false;
  var closing = false;
  var closeTimer = 0;
  var workTitle = card.getAttribute('data-work-title') || document.title;
  var toasts = byId('toasts');
  var toastsHome = toasts ? toasts.parentNode : null;

  // The card is in the top layer: the toasts go into it while it is up, or
  // a page's 已保存 would be said behind the scrim.
  function toastsInto(on) {
    if (!toasts || !toastsHome) return;
    if (on) card.appendChild(toasts);
    else toastsHome.appendChild(toasts);
  }

  // Where the card opens: the area last opened in this tab, if this reader
  // still has it, else the first one in the list.
  function lastArea() {
    var items = list ? list.querySelectorAll('a.nav-item') : [];
    var kept = '';
    try { kept = sessionStorage.getItem(LAST) || ''; } catch (e) { kept = ''; }
    for (var i = 0; kept && i < items.length; i++) {
      var path = new URL(items[i].href, location.href).pathname;
      var at = kept.split('?')[0];
      if (at === path || at.indexOf(path + '/') === 0) return kept;
    }
    return items.length ? keyOf(new URL(items[0].href, location.href)) : '/admin';
  }

  function modal() {
    card.showModal();
    toastsInto(true);
  }

  function openCard(from) {
    if (card.open) return;
    closing = false;
    opener = from && from !== document.body ? from : document.activeElement;
    var menus = document.querySelectorAll('details.fx-more[open]');
    for (var i = 0; i < menus.length; i++) menus[i].open = false;
    modal();
    if (still()) card.setAttribute('data-shown', '');
    else requestAnimationFrame(function () { requestAnimationFrame(function () { if (card.open) card.setAttribute('data-shown', ''); }); });
  }

  function closeCard() {
    if (!card.open || closing) return;
    closing = true;
    card.removeAttribute('data-shown');
    if (still()) card.close();
    else closeTimer = later(function () { if (card.open) card.close(); }, 200);
  }

  // However the card closed (the × or the scrim, Esc, back, an expired
  // session closing every dialog): the page in it stops, and the address
  // goes back to the page under it. A 'close' that comes when the card is
  // up again is stale and changes nothing: taking over the card the
  // document came with (below) removes its open attribute, which fires no
  // event (the dialog cleanup steps), and an engine that did would land
  // here after showModal.
  function closed() {
    if (card.open) return;
    closing = false;
    card.removeAttribute('data-shown');
    leave();
    here = '';
    seq++;
    busy(false);
    blank();
    if (qc.schedule) qc.schedule();
    toastsInto(false);
    document.title = workTitle;
    if (search) { search.value = ''; filter(); }
    var s = entry();
    if (!popping && s) {
      if (s.d > 0) { landing = s.base === 'doc'; history.go(-s.d); }
      else history.replaceState(null, '', workHome());
    } else if (s && !admin(location.pathname)) {
      // Back to an error's address the card came with: the front's, too.
      history.replaceState(null, '', workHome());
    }
    popping = false;
    var back = opener;
    opener = null;
    if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
  }
  card.addEventListener('close', closed);

  // Esc: the same way out as the ×. A browser that will not let the page
  // hold Esc closes it at once, and 'close' does the rest. One Esc is one
  // layer, though: Chrome puts a dialog opened without a click (a page
  // script's own) in one group with the card, and sends the card the same
  // close request right after the dialog's. An Esc pressed over a dialog
  // inside the card is that dialog's; the card stays when it may.
  var escInner = false;
  window.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || !card.open) return;
    try { escInner = !!card.querySelector('dialog:modal'); } catch (e) { escInner = !!card.querySelector('dialog[open]'); }
    if (escInner) later(function () { escInner = false; }, 0);
  }, true);
  card.addEventListener('cancel', function (event) {
    event.preventDefault();
    if (escInner) { escInner = false; return; }
    closeCard();
  });

  // Tab past the card's last stop comes back to its first, and Shift+Tab
  // the other way round: a modal dialog alone lets the focus leave for the
  // browser's own toolbar. A dialog open inside the card keeps its keys.
  function stops() {
    var all = card.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (!all[i].disabled && all[i].getClientRects().length > 0) out.push(all[i]);
    }
    return out;
  }
  card.addEventListener('keydown', function (event) {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey ||
        card.querySelector('dialog[open]')) return;
    var all = stops();
    if (!all.length) return;
    var at = document.activeElement;
    var edge = event.shiftKey ? (at === all[0] || !card.contains(at) || at === card) : at === all[all.length - 1];
    if (!edge) return;
    event.preventDefault();
    all[event.shiftKey ? all.length - 1 : 0].focus();
  });

  // The scrim is the dialog itself: a press that starts and ends on it.
  var onScrim = false;
  card.addEventListener('pointerdown', function (event) { onScrim = event.target === card; });
  card.addEventListener('click', function (event) {
    if (event.target === card && onScrim) closeCard();
    onScrim = false;
  });

  qc.onAction('settings-close', function () { closeCard(); });

  // Opening on an area: a link under /admin (the list, a crumb, a row), or
  // one of the front's ways in (data-settings), which open the last area.
  function into(key, from) {
    if (!card.open) openCard(from);
    go(key, key === here ? 'stay' : 'push', 0, from);
  }

  // The way in that is not a link: ⌘, or Ctrl+, here, and the desktop
  // app's menu 设置… and tray 设置, which evaluate this in the main window
  // (qmo-app.md §6). The card opens where it was last; already open (or on
  // its way out), it only takes the focus.
  function openSettings() {
    if (card.open) {
      if (closing) { never(closeTimer); closing = false; card.setAttribute('data-shown', ''); }
      if (!card.contains(document.activeElement)) (byId('main') || card).focus({ preventScroll: true });
      return;
    }
    into(lastArea(), document.activeElement);
  }
  window.__qmoOpenSettings = function () { openSettings(); };

  /* ---------------- wiring ---------------- */

  // Last in line, so a page script or the runtime that took the click
  // (data-action, a dialog opener) keeps it.
  window.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
        event.shiftKey || event.altKey) return;
    var hit = linkOf(event.target);
    if (!hit) return;
    var url = hit.url;
    if (hit.a.hasAttribute('data-settings')) {
      event.preventDefault();
      into(lastArea(), hit.a);
      return;
    }
    // A place on this page (the card's skip link): the browser's.
    if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
    if (!admin(url.pathname)) {
      // Out of the card (the front at /, /app, /code): closed first, then
      // the link is the browser's.
      if (card.open && card.contains(hit.a)) { popping = true; card.close(); }
      return;
    }
    event.preventDefault();
    into(keyOf(url), hit.a);
  });

  document.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    var hit = linkOf(event.target);
    if (!hit) return;
    if (hit.a.hasAttribute('data-settings')) warm(lastArea());
    else if (admin(hit.url.pathname)) warm(keyOf(hit.url));
  }, true);

  window.addEventListener('popstate', function () {
    var key = location.pathname + location.search;
    if (landing) {
      // Back past a card the document came with: its first entry becomes
      // the front's address.
      landing = false;
      history.replaceState(null, '', workHome());
      return;
    }
    if (!admin(location.pathname)) {
      if (card.open) { popping = true; closeCard(); }
      return;
    }
    if (!card.open) openCard(null);
    if (key === here) return;
    go(key, 'pop', scrolls[key] || 0, null);
  });

  // ⌘, or Ctrl+,: the same as the app's menu.
  document.addEventListener('keydown', function (event) {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing) return;
    if (event.key !== ',' && event.code !== 'Comma') return;
    event.preventDefault();
    openSettings();
  });

  if (search) {
    search.addEventListener('input', filter);
    // Enter opens the first area left in the list.
    search.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || event.isComposing) return;
      var first = list ? list.querySelector('a.nav-item:not([hidden])') : null;
      if (!first) return;
      event.preventDefault();
      into(keyOf(new URL(first.href, location.href)), first);
    });
  }

  // The reader started on the page: a background answer no longer replaces it.
  var start = function (event) {
    var main = byId('main');
    if (main && event.target && main.contains(event.target)) touched = true;
  };
  document.addEventListener('pointerdown', start, true);
  document.addEventListener('keydown', start, true);

  // A new credential is a new reader: nothing kept, and the next move loads
  // a whole document (role, policy and list are theirs).
  document.addEventListener('click', function (event) {
    var el = event.target && event.target.closest ?
      event.target.closest('[data-action="token-save"], [data-action="token-clear"]') : null;
    if (el) { forget(); whole = true; }
  }, true);
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (form && (form.id === 'logout-form' || (form.classList && form.classList.contains('fx-sign-out')))) { forget(); whole = true; }
  }, true);
  qc.onExpire(function () {
    forget();
    whole = true;
    if (page) { var s = page; page = null; unmount(s); }
  });

  // Inside the desktop app: its own settings window, from the card's foot.
  var core = window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function' ?
    window.__TAURI__.core : null;
  var desktop = byId('set-desktop');
  if (desktop && core && !!window.__QMO_SHELL__ && typeof window.__QMO_SHELL__ === 'object') desktop.hidden = false;
  qc.onAction('settings-desktop', function () {
    if (!core) return;
    try { Promise.resolve(core.invoke('qmo_open_local_settings')).then(null, function () {}); }
    catch (e) { /* an older app without the window */ }
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

  /* ---------------- the card this document came with ---------------- */

  window.qianmoNav = {
    // Whatever a page wants to move to, in the card when it can be.
    go: function (url) {
      var target;
      try { target = new URL(url, location.href); } catch (e) { return; }
      if (target.origin !== location.origin || !admin(target.pathname)) { location.assign(url); return; }
      into(keyOf(target), null);
    },
    // The end of the first page script's scope (the document puts this after it).
    mounted: function () { var s = end(); if (s) page = s; },
    // Work a page started that leaving it should stop.
    onLeave: function (run) {
      if (rec) rec.scope.leave.push(run);
      else if (page) page.leave.push(run);
    }
  };

  // An area's address, or an error a browser navigated into: the server
  // drew the card open, with the page in it. It becomes modal here, before
  // the first page script runs.
  if (card.open) {
    var at = location.pathname + location.search;
    card.removeAttribute('open');
    modal();
    history.replaceState({ qianmoNav: 1, d: 0, base: 'doc' }, '', at);
    if (admin(location.pathname)) {
      here = at;
      try { sessionStorage.setItem(LAST, here); } catch (e) { /* the first area next time */ }
    }
    reveal();
  }

  // A page script that threw before the call above: its scope ends here.
  document.addEventListener('DOMContentLoaded', function () { window.qianmoNav.mounted(); });

  begin();
})();
`
}

/**
 * The card's runtime for a document whose frame is `key` (`view/shell.ts`,
 * `SHELL_KEY`). An answer naming another key is from a release with another
 * sheet or runtime, and is loaded as a whole document.
 */
export function navScript(key: string): string {
  return stripJsLineComments(navSource(key))
}

/**
 * What a document with the card open puts after the area's script, in the
 * same `<script>`: the end of that script's recording scope.
 */
export const NAV_MOUNTED_JS =
  '\nwindow.qianmoNav && window.qianmoNav.mounted();\n'
