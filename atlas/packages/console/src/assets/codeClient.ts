// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Code's page script (`/code`, `view/frontCode.ts`), after the shared
 * runtime, the front's own and `CODE_RENDER_JS` (`assets/codeRender.ts`).
 *
 * Inside the desktop app — `window.__QMO_SHELL__` an object and Tauri's
 * `invoke` and `Channel` both there — it drives local sessions through the
 * shell's `qmo_local_*` commands and one ordered event channel, straight to
 * the runner (`qmo-local.md` §4.5). It never asks the hub for anything: no
 * `fetch`, no `EventSource`, no fragment. Once the page is loaded the hub
 * can go away and a session keeps streaming, opens, sends and shows its
 * changes.
 *
 * - **Start.** `qmo_local_watch` first, then `qmo_local_list` (the
 *   features, the folders, the sessions) and `qmo_local_agents` for the
 *   picker: an agent whose protocol is in `features.protocols` can be picked,
 *   the others are greyed with 后续版本支持. A refusal that does not start
 *   with `qmo ` is Tauri's — an app from before local sessions — and the page
 *   says to update it; one that does is said as it is.
 * - **The list.** By folder, newest first; each row the title, the agent
 *   and a dot for its state. `/code?session=<id>` by `pushState`; back and
 *   forward move between sessions.
 * - **A new session.** A recent folder or 选择文件夹… (the shell's native
 *   picker), the agent, the permission mode (自动审批 unless changed; 跳过权限确认
 *   asks once more in a line under the box), Remote held off until P37.15,
 *   and the first line. Sent at once: the line is drawn first, and a start
 *   that fails puts it back in the box (§3.3, a new conversation).
 * - **A session.** `qmo_local_read` (the newest 200 records; the rest when
 *   the reader scrolls to the top). Every event carries `seq`: one already
 *   drawn is dropped, a gap or a trimmed record reads again. `delta`s join
 *   the live answer at their `offset`, redrawn at most once a frame; the
 *   record replaces it. A line sent is drawn first with its `clientId`; one
 *   that fails stays as 未送达 · 重试. While the agent works the send button is
 *   停止. The permission mode shows the new value first and says 已生效 or
 *   下一轮生效, or goes back and says why. An ask is answered from its card.
 * - **Changes.** `qmo_local_changes` lists the files, `qmo_local_diff`
 *   shows one; read again within a second of a tool finishing, and by hand.
 *
 * All text goes in with `textContent`; nothing here turns a string into
 * markup.
 */

import { FRONT_NARROW_PX } from '../view/frontStyle.js'
import { stripJsLineComments } from './client.js'

function codeScript(): string {
  return `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  var R = window.qianmoCode;
  if (!qc || !R) return;
  var byId = qc.byId;
  var local = byId('code-local');
  var web = byId('code-web');
  if (!local || !web) return;
  function words(node) {
    try { return JSON.parse((node && node.getAttribute('data-text')) || '{}') || {}; } catch (e) { return {}; }
  }
  var own = words(local);
  var front = words(byId('fx'));
  function tx(key, fallback) {
    return typeof own[key] === 'string' ? own[key] : typeof front[key] === 'string' ? front[key] : fallback;
  }
  R.words(tx);
  var el = R.el;

  var core = window.__TAURI__ && window.__TAURI__.core;
  var shell = !!window.__QMO_SHELL__ && typeof window.__QMO_SHELL__ === 'object' && !!core &&
    typeof core.invoke === 'function' && typeof core.Channel === 'function';
  var newRow = byId('code-new');

  function elsewhere(line) {
    local.hidden = true;
    web.hidden = false;
    if (line) web.textContent = line;
    if (newRow) newRow.disabled = true;
  }
  if (!shell) { elsewhere(''); return; }
  local.hidden = false;
  web.hidden = true;

  var PICK = 'pick';
  var KEY = 'qianmo.code.';
  var NARROW = '(max-width: ${FRONT_NARROW_PX}px)';
  var box = byId('code-text');
  var form = byId('code-box');
  var say = byId('code-say');
  var go = byId('code-go');
  var stop = byId('code-stop');
  var folderPick = byId('code-folder');
  var agentPick = byId('code-agent');
  var modePick = byId('code-mode');
  var msgs = byId('code-msgs');
  var scroller = byId('code-scroll');
  var panel = byId('code-changes');
  var toggle = byId('code-changes-btn');

  var features = { protocols: [] };
  var folders = [];
  var sessions = {};
  var agents = [];
  var listed = false;
  var listing = false;
  var current = '';
  var view = null;
  var blankMode = 'auto';
  var lastFolder = '';
  var modeAsk = 0;
  var modeWant = '';
  var changesAsk = 0;
  var opened = {};
  var down = false;
  var frame = 0;
  var ticker = null;
  var soonTimer = null;

  function call(command, args) {
    try { return Promise.resolve(core.invoke(command, args || {})); } catch (e) { return Promise.reject(e); }
  }
  function why(err) { return typeof err === 'string' ? err : err && err.message ? String(err.message) : String(err || ''); }
  function tell(text, tone) { qc.say(say, text || '', tone || 'muted'); }
  function stored(key) { try { return window.localStorage.getItem(KEY + key) || ''; } catch (e) { return ''; } }
  function keep(key, value) { try { window.localStorage.setItem(KEY + key, value); } catch (e) { /* a convenience only */ } }
  function narrow() { return !!(window.matchMedia && window.matchMedia(NARROW).matches); }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function values(map) { var out = []; for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) out.push(map[k]); return out; }
  function idInUrl() {
    var m = /[?&]session=([^&#]*)/.exec(window.location.search);
    try { return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return ''; }
  }
  function clientId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  function running() { return !!current && !!sessions[current] && sessions[current].state === 'running'; }
  function closeDrawer() {
    var root = byId('fx');
    var scrim = document.querySelector('.fx-scrim');
    if (root && root.getAttribute('data-drawer') === 'open' && scrim) scrim.click();
  }

  // ---- the side list ----

  function stateWord(state) {
    return tx(state === 'running' ? 'running' : state === 'waiting' ? 'waiting' : state === 'interrupted' ?
      'interrupted' : state === 'failed' ? 'failed' : 'idle', '');
  }

  function side() {
    var list = byId('code-sessions');
    if (!list) return;
    var focused = document.activeElement && list.contains(document.activeElement) ?
      document.activeElement.getAttribute('data-session') : null;
    var all = values(sessions).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    clear(list);
    if (!all.length) { list.appendChild(el('p', 'fx-none', tx('none', ''))); return; }
    var groups = {};
    var order = [];
    for (var i = 0; i < all.length; i++) {
      var folder = all[i].folder || {};
      var key = folder.id ? 'f:' + folder.id : 'n:' + (folder.name || '');
      if (!groups[key]) { groups[key] = { name: folder.name || '', rows: [] }; order.push(key); }
      groups[key].rows.push(all[i]);
    }
    for (var g = 0; g < order.length; g++) {
      var group = groups[order[g]];
      var block = el('div', 'fx-rgroup');
      block.appendChild(el('h3', 'fx-rgroup-name', group.name));
      for (var r = 0; r < group.rows.length; r++) {
        var s = group.rows[r];
        var row = el('div', 'fx-ritem-row fx-code-row' + (s.id === current ? ' is-current' : ''));
        var button = el('button', 'fx-ritem');
        button.type = 'button';
        button.setAttribute('data-action', 'code-open');
        button.setAttribute('data-session', s.id);
        if (s.id === current) button.setAttribute('aria-current', 'page');
        var dot = el('span', 'dot fx-code-dot is-' + (s.state || 'idle'));
        dot.setAttribute('role', 'img');
        dot.setAttribute('aria-label', stateWord(s.state));
        dot.title = stateWord(s.state);
        button.appendChild(dot);
        button.appendChild(el('span', 'fx-ritem-title', s.title || tx('untitled', '')));
        button.appendChild(el('span', 'fx-code-tag', (s.agent && s.agent.name) || ''));
        row.appendChild(button);
        block.appendChild(row);
      }
      list.appendChild(block);
    }
    if (focused) {
      var again = list.querySelector('[data-session="' + focused.replace(/"/g, '') + '"]');
      if (again) again.focus();
    }
  }

  // ---- the new session's pickers ----

  function drawFolders(pick) {
    clear(folderPick);
    var hold = el('option', '', tx('folder', ''));
    hold.value = '';
    hold.disabled = true;
    hold.hidden = true;
    folderPick.appendChild(hold);
    var chosen = pick || stored('folder');
    var found = '';
    for (var i = 0; i < folders.length; i++) {
      var f = folders[i];
      var option = el('option', '', f.name || f.path || f.id);
      option.value = f.id;
      if (f.path) option.title = f.path;
      folderPick.appendChild(option);
      if (f.id === chosen || (!found && i === 0)) found = f.id;
    }
    var more = el('option', '', tx('pickFolder', ''));
    more.value = PICK;
    folderPick.appendChild(more);
    folderPick.value = found;
    lastFolder = found;
  }

  function drawAgents() {
    clear(agentPick);
    var protocols = Array.isArray(features.protocols) ? features.protocols : [];
    var chosen = stored('agent');
    var first = '';
    var picked = '';
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      var ok = a.available === true && protocols.indexOf(a.protocol) !== -1;
      var label = String(a.name || a.id || '') + (a.version ? ' \\u00b7 ' + a.version : '');
      if (a.available !== true) label += ' \\u00b7 ' + String(a.reason || tx('agentNotReady', ''));
      else if (!ok) label += ' \\u00b7 ' + tx('later', '');
      var option = el('option', '', label);
      option.value = String(a.id || '');
      option.disabled = !ok;
      agentPick.appendChild(option);
      if (ok && !first) first = option.value;
      if (ok && option.value === chosen) picked = chosen;
    }
    agentPick.value = picked || first;
  }

  var scanning = 0;
  function scan(rescan) {
    var mine = ++scanning;
    var again = byId('code-rescan');
    if (again) again.disabled = true;
    if (rescan) tell(tx('scanning', ''), 'muted');
    call('qmo_local_agents', { rescan: !!rescan }).then(function (data) {
      if (mine !== scanning) return;
      if (again) again.disabled = false;
      agents = data && Array.isArray(data.agents) ? data.agents : [];
      drawAgents();
      if (rescan || !agents.length) tell(agents.length ? '' : tx('noLocalAgents', ''), 'muted');
    }, function (err) {
      if (mine !== scanning) return;
      if (again) again.disabled = false;
      tell(why(err), 'warn');
    });
  }

  // ---- views ----

  function head() {
    var s = current ? sessions[current] : null;
    var mount = byId('code-head');
    if (mount) mount.hidden = !s && !view;
    var title = byId('code-title');
    var sub = byId('code-sub');
    if (title) title.textContent = s ? (s.title || tx('untitled', '')) : view && view.title ? view.title : '';
    if (sub) {
      sub.textContent = s ? [s.folder && s.folder.name, s.agent && s.agent.name].filter(Boolean).join(' \\u00b7 ') : '';
    }
    if (toggle) toggle.hidden = !s;
    if (panel) panel.hidden = !s || !changesOpen();
  }

  function composer() {
    var busy = running();
    go.hidden = busy;
    stop.hidden = !busy;
    box.placeholder = current || view ? box.getAttribute('data-reply') || '' : box.getAttribute('data-first') || '';
    var mode = current && sessions[current] ? sessions[current].mode : blankMode;
    if (mode && !modeWant && modePick.value !== mode && byId('code-bypass').hidden) modePick.value = mode;
  }

  function grow() {
    box.style.height = '';
    if (box.value) box.style.height = Math.min(box.scrollHeight, 240) + 'px';
  }

  function show(which) {
    local.setAttribute('data-view', which);
    bypass(false);
  }

  function fresh(id) {
    return { id: id, turns: {}, drawn: 0, oldest: 0, more: false, live: null, reading: 0, queue: [],
      cache: {}, groups: {}, lines: [], activity: '', pend: null, older: false, title: '' };
  }

  function blank(push) {
    current = '';
    view = null;
    if (push) history.pushState(null, '', '/code');
    clear(msgs);
    show('blank');
    head();
    side();
    composer();
    tick();
  }

  function open(id, push) {
    if (!sessions[id]) { blank(push); return; }
    var lines = view && view.id === '' ? view.lines : [];
    current = id;
    if (push) history.pushState(null, '', '/code?session=' + encodeURIComponent(id));
    view = fresh(id);
    view.lines = lines;
    clear(msgs);
    // The last session's files are not this one's.
    opened = {};
    clear(byId('code-files'));
    byId('code-count').textContent = '';
    qc.say(byId('code-note'), '', 'muted');
    show('session');
    head();
    side();
    composer();
    tell('', 'muted');
    load();
    if (changesOpen()) changes();
  }

  // ---- records ----

  function put(record) {
    var turn = record && record.turn;
    if (!turn || typeof turn.id !== 'string' || typeof record.seq !== 'number') return;
    var have = view.turns[turn.id];
    if (!have) view.turns[turn.id] = { t: turn, s: record.seq, f: record.seq };
    else {
      if (record.seq > have.s) { have.t = turn; have.s = record.seq; }
      if (record.seq < have.f) have.f = record.seq;
    }
    if (!view.oldest || record.seq < view.oldest) view.oldest = record.seq;
    if (view.live && view.live.turn === turn.id) view.live = null;
    if (turn.clientId) {
      for (var i = view.lines.length - 1; i >= 0; i--) if (view.lines[i].clientId === turn.clientId) view.lines.splice(i, 1);
    }
  }

  function merge(v, data, fill) {
    var records = data && Array.isArray(data.records) ? data.records : [];
    if (data && data.session && data.session.id) sessions[data.session.id] = data.session;
    var lowest = 0;
    for (var i = 0; i < records.length; i++) if (!lowest || records[i].seq < lowest) lowest = records[i].seq;
    // A gap wider than one page: start over from this page.
    if (fill && v.drawn && lowest > v.drawn + 1) { v.turns = {}; v.oldest = 0; v.more = true; }
    for (var j = 0; j < records.length; j++) put(records[j]);
    if (data && typeof data.lastSeq === 'number' && data.lastSeq > v.drawn) v.drawn = data.lastSeq;
    if (!fill || !v.oldest || lowest <= v.oldest) v.more = !!(data && data.more);
    var live = data && data.live;
    var liveId = live ? (typeof live.turn === 'string' ? live.turn : live.turn && live.turn.id) : '';
    if (liveId && !v.turns[liveId]) v.live = { turn: liveId, text: String(live.text || ''), at: Date.now() };
  }

  function load() {
    var v = view;
    var fill = v.drawn > 0;
    v.reading += 1;
    call('qmo_local_read', { session: v.id, limit: 200 }).then(function (data) {
      if (view === v) merge(v, data, fill);
    }, function (err) {
      if (view === v) tell(why(err), 'warn');
    }).then(function () {
      if (view !== v) return;
      v.reading -= 1;
      if (v.reading) return;
      var queued = v.queue;
      v.queue = [];
      for (var i = 0; i < queued.length; i++) apply(queued[i]);
      head();
      composer();
      paint(true);
    });
  }

  function older() {
    var v = view;
    if (!v || v.older || !v.more || !v.oldest) return;
    v.older = true;
    var from = scroller.scrollHeight - scroller.scrollTop;
    call('qmo_local_read', { session: v.id, before: v.oldest, limit: 200 }).then(function (data) {
      if (view !== v) return;
      merge(v, data, false);
      v.more = !!(data && data.more);
      paint(false);
      scroller.scrollTop = scroller.scrollHeight - from;
    }, function (err) {
      if (view === v) tell(why(err), 'warn');
    }).then(function () { v.older = false; });
  }

  function soon() {
    if (soonTimer) clearTimeout(soonTimer);
    soonTimer = setTimeout(function () { soonTimer = null; changes(); }, 500);
  }

  function apply(event) {
    var v = view;
    if (event.type === 'record') {
      if (typeof event.seq !== 'number' || event.seq <= v.drawn) return;
      if (event.trimmed || event.seq !== v.drawn + 1 || !event.record) { load(); return; }
      v.drawn = event.seq;
      put(event.record);
      var tool = event.record.turn && event.record.turn.tool;
      if (tool && tool.status && tool.status !== 'running') soon();
      paint(false);
    } else if (event.type === 'delta') {
      var live = v.live;
      if (!live || live.turn !== event.turn) {
        if (event.offset !== 0 || v.turns[event.turn]) return;
        live = v.live = { turn: event.turn, text: '', at: Date.now() };
      }
      if (event.offset !== live.text.length) return;
      live.text += String(event.text || '');
      if (!frame) frame = window.requestAnimationFrame(function () { frame = 0; paint(false); });
    } else if (event.type === 'activity') {
      v.activity = String(event.words || '');
      paint(false);
    }
  }

  function onEvent(event) {
    if (!event || typeof event !== 'object') return;
    var type = event.type;
    if (type === 'runner') {
      if (event.state === 'down') {
        down = true;
        // What was streaming went with the process; its record, if any, comes on reading.
        if (view && view.live) { view.live = null; paint(false); }
        tell(tx('down', '') + (event.reason ? ' \\u00b7 ' + event.reason : ''), 'warn');
      } else if (event.state === 'up' && (down || !listed) && !listing) {
        // Every start says up, the first too: only one after a fall, or
        // after a list that failed, reads again.
        down = false;
        tell('', 'muted');
        var again = listed;
        list(!again).then(function () { if (again && view && view.id) load(); }, refused);
      }
      return;
    }
    if (type === 'session') {
      var s = event.session;
      if (!s || typeof s.id !== 'string') return;
      var was = sessions[s.id] ? sessions[s.id].state : '';
      sessions[s.id] = s;
      side();
      if (s.id === current) {
        head();
        composer();
        if (was === 'running' && s.state !== 'running') soon();
        paint(false);
      }
      return;
    }
    if (type === 'removed') {
      delete sessions[event.session];
      side();
      if (event.session === current) blank(true);
      return;
    }
    if (!view || !view.id || event.session !== view.id) return;
    if (view.reading) { view.queue.push(event); return; }
    apply(event);
  }

  // ---- drawing a session ----

  function cached(key, sig, make) {
    var have = view.cache[key];
    if (!have || have.sig !== sig) { have = view.cache[key] = { sig: sig, el: make(), fresh: true }; }
    have.used = true;
    return have.el;
  }

  function place(parent, want) {
    for (var i = 0; i < want.length; i++) {
      if (parent.children[i] !== want[i]) parent.insertBefore(want[i], parent.children[i] || null);
    }
    while (parent.children.length > want.length) parent.removeChild(parent.lastElementChild);
  }

  function how(turn) { return turn.state === 'pending' ? 'queued' : turn.state === 'failed' ? 'unsent' : ''; }

  function paint(bottom) {
    var v = view;
    if (!v) return;
    var atEnd = bottom || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    for (var key in v.cache) if (Object.prototype.hasOwnProperty.call(v.cache, key)) { v.cache[key].used = false; v.cache[key].fresh = false; }
    var all = values(v.turns).sort(function (a, b) { return a.f - b.f; });
    var lastUser = '';
    var since = 0;
    for (var k = 0; k < all.length; k++) {
      if (all[k].t.author === 'operator' && all[k].t.variant !== 'notice') { lastUser = all[k].t.id; since = all[k].t.at; }
    }
    var want = [];
    var before;
    var group = null;
    var groups = [];
    for (var i = 0; i < all.length; i++) {
      var entry = all[i];
      var t = entry.t;
      var step = t.variant === 'notice' && !R.asking(t);
      if (!(step && group) && R.pauses(t.at, before)) {
        want.push(cached('sep:' + t.id, t.at + '|' + before, sepOf(t.at, before)));
      }
      before = t.at;
      if (step) {
        if (!group) {
          group = v.groups['steps:' + t.id] || (v.groups['steps:' + t.id] = R.steps('steps:' + t.id));
          group.items = [];
          groups.push(group);
          want.push(group.el);
        }
        group.items.push(entry);
        continue;
      }
      group = null;
      want.push(cached('turn:' + t.id, entry.s + '|' + (t.id === lastUser), turnOf(t, t.id === lastUser)));
    }
    for (var g = 0; g < groups.length; g++) steps(groups[g], g === groups.length - 1 && group === groups[g] && running());
    if (v.live) {
      if (!v.live.el) v.live.el = R.agent({ text: '', at: v.live.at }, true);
      var text = v.live.el.querySelector('.fx-text');
      clear(text);
      R.richText(text, v.live.text);
      want.push(v.live.el);
    }
    for (var l = 0; l < v.lines.length; l++) {
      var line = v.lines[l];
      if (!line.el || line.drawn !== line.how) { line.el = R.user(line, line.how, false); line.el.qmoLine = line; line.drawn = line.how; }
      want.push(line.el);
    }
    if (running() && !(v.live && v.live.text)) {
      if (!v.pend) v.pend = R.pending();
      v.pend.querySelector('.fx-typing-word').textContent = v.activity || tx('thinking', '');
      v.since = since || (sessions[current] && sessions[current].updatedAt) || Date.now();
      want.push(v.pend);
    } else v.activity = '';
    place(msgs, want);
    var focus = null;
    for (var c in v.cache) {
      if (!Object.prototype.hasOwnProperty.call(v.cache, c)) continue;
      if (!v.cache[c].used) delete v.cache[c];
      else if (v.cache[c].fresh && v.cache[c].el.className === 'fx-perm') focus = v.cache[c].el.querySelector('.fx-perm-once');
    }
    // Not out of a field with words in it: a space typed there would approve.
    var at = document.activeElement;
    if (focus && !(at && /^(TEXTAREA|INPUT)$/.test(at.tagName) && at.value)) focus.focus({ preventScroll: true });
    tick();
    if (atEnd) scroller.scrollTop = scroller.scrollHeight;
  }

  function sepOf(at, before) { return function () { return R.sep(at, before); }; }
  function turnOf(t, last) {
    return function () {
      if (R.asking(t)) return R.ask(t);
      if (t.author === 'operator') return R.user(t, how(t), last);
      return R.agent(t, false);
    };
  }

  function steps(group, live) {
    var want = [];
    var worst = 'muted';
    for (var i = 0; i < group.items.length; i++) {
      var t = group.items[i].t;
      want.push(cached('step:' + t.id, group.items[i].s, stepOf(t)));
      var tool = t.tool || {};
      if (tool.status === 'failed' || t.severity === 'error') worst = 'bad';
      else if (worst !== 'bad' && (tool.status === 'denied' || t.severity === 'warn' || (t.ask && t.ask.decision === 'deny'))) worst = 'warn';
    }
    place(group.list, want);
    var last = group.items[group.items.length - 1].t;
    group.label(group.items.length, String(last.ask ? last.ask.title || last.text : last.text || ''), live, worst);
  }
  function stepOf(t) { return function () { return R.step(t); }; }

  function tick() {
    var pend = view && view.pend && view.pend.isConnected ? view.pend : null;
    if (!pend) { if (ticker) { clearInterval(ticker); ticker = null; } return; }
    var clock = pend.querySelector('.fx-typing-time');
    clock.textContent = R.elapsed(Date.now() - view.since);
    if (!ticker) ticker = setInterval(tick, 1000);
  }

  // ---- sending ----

  function send(text) {
    var v = view;
    var line = { clientId: clientId(), text: text, at: Date.now(), how: 'sending' };
    v.lines.push(line);
    box.value = '';
    grow();
    paint(true);
    call('qmo_local_send', { session: v.id, text: text, clientId: line.clientId }).then(function (data) {
      if (data && data.queued && line.how === 'sending') line.how = 'queued';
      if (view === v) paint(false);
    }, function (err) {
      line.how = 'failed';
      if (view !== v) return;
      paint(false);
      tell(why(err), 'warn');
    });
  }

  function start(text) {
    var folder = folderPick.value;
    var agent = agentPick.value;
    if (!folder || folder === PICK) { tell(tx('noFolder', ''), 'warn'); folderPick.focus(); return; }
    if (!agent || !agentPick.options[agentPick.selectedIndex] || agentPick.options[agentPick.selectedIndex].disabled) {
      tell(tx('noLocalAgents', ''), 'warn');
      return;
    }
    var mode = modePick.value;
    var v = view = fresh('');
    v.title = text.split('\\n')[0].slice(0, 80);
    var line = { clientId: clientId(), text: text, at: Date.now(), how: 'sending' };
    v.lines.push(line);
    keep('folder', folder);
    keep('agent', agent);
    box.value = '';
    grow();
    clear(msgs);
    show('session');
    head();
    composer();
    tell('', 'muted');
    paint(true);
    call('qmo_local_start', {
      folder: folder, agent: agent, mode: mode, worktree: false, text: text, clientId: line.clientId, remote: false
    }).then(function (data) {
      var s = data && data.session;
      if (!s || typeof s.id !== 'string') throw new Error('');
      sessions[s.id] = s;
      if (view === v) open(s.id, true);
      else side();
    }).then(null, function (err) {
      if (view !== v) return;
      blank(false);
      box.value = text;
      grow();
      tell(why(err) || tx('noSession', ''), 'warn');
      box.focus();
    });
  }

  function submit() {
    var text = box.value;
    if (!text.trim()) return;
    if (!listed) return;
    if (view && view.id) send(text);
    else if (!view) start(text);
  }

  form.addEventListener('submit', function (event) { event.preventDefault(); submit(); });
  box.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  });
  box.addEventListener('input', grow);

  qc.onAction('code-retry', function (button) {
    var article = button.closest('.fx-msg');
    var line = article && article.qmoLine;
    if (!line || !view) return;
    view.lines.splice(view.lines.indexOf(line), 1);
    send(line.text);
  });

  qc.onAction('code-stop', function () {
    if (!current) return;
    var id = current;
    tell(tx('stopping', ''), 'muted');
    call('qmo_local_stop', { session: id }).then(function () {
      if (current === id) tell('', 'muted');
    }, function (err) {
      if (current === id) tell(why(err), 'warn');
    });
  });

  // ---- the permission mode ----

  function bypass(on) {
    var row = byId('code-bypass');
    if (!row) return;
    row.hidden = !on;
    if (on) { var ok = row.querySelector('[data-action="code-bypass-ok"]'); if (ok) ok.focus(); }
  }

  function setMode(next) {
    if (!current) { blankMode = next; return; }
    var id = current;
    var before = sessions[id].mode;
    var mine = ++modeAsk;
    modeWant = next;
    call('qmo_local_set_mode', { session: id, mode: next }).then(function (data) {
      if (mine !== modeAsk) return;
      modeWant = '';
      if (current !== id) return;
      var mode = (data && data.mode) || next;
      sessions[id].mode = mode;
      modePick.value = mode;
      tell(data && data.applies === 'next-turn' ? tx('next', '') : tx('now', ''), 'muted');
    }, function (err) {
      if (mine !== modeAsk) return;
      modeWant = '';
      if (current !== id) return;
      sessions[id].mode = before;
      modePick.value = before;
      tell(why(err), 'warn');
    });
  }

  modePick.addEventListener('change', function () {
    if (modePick.value === 'full-access') { bypass(true); return; }
    bypass(false);
    setMode(modePick.value);
  });
  qc.onAction('code-bypass-ok', function () { bypass(false); setMode('full-access'); modePick.focus(); });
  qc.onAction('code-bypass-no', function () {
    bypass(false);
    modePick.value = current && sessions[current] ? sessions[current].mode : blankMode;
    modePick.focus();
  });

  // ---- folders and agents ----

  folderPick.addEventListener('change', function () {
    if (folderPick.value !== PICK) { lastFolder = folderPick.value; keep('folder', lastFolder); return; }
    folderPick.value = lastFolder;
    call('qmo_local_pick_folder', {}).then(function (folder) {
      if (!folder || typeof folder.id !== 'string') return;
      folders = [folder].concat(folders.filter(function (f) { return f.id !== folder.id; }));
      drawFolders(folder.id);
      keep('folder', folder.id);
    }, function (err) { tell(why(err), 'warn'); });
  });
  agentPick.addEventListener('change', function () { keep('agent', agentPick.value); });
  qc.onAction('code-rescan', function () { scan(true); });

  // ---- asks ----

  qc.onAction('code-ask', function (button) {
    var card = button.closest('.fx-perm');
    if (!card || !current) return;
    var args = { session: current, ask: card.getAttribute('data-ask') || '', decision: button.getAttribute('data-decision') || '' };
    var note = card.querySelector('.fx-perm-note input');
    if (args.decision === 'deny' && note && note.value.trim()) args.message = note.value.trim();
    var buttons = card.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    call('qmo_local_answer', args).then(null, function (err) {
      for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
      qc.say(card.querySelector('.fx-perm-say'), why(err), 'warn');
    });
  });
  qc.onAction('code-deny', function (button) {
    var note = button.closest('.fx-perm').querySelector('.fx-perm-note');
    note.hidden = !note.hidden;
    button.setAttribute('aria-expanded', note.hidden ? 'false' : 'true');
    if (!note.hidden) note.querySelector('input').focus();
  });
  // Enter approves nothing: a button takes space or a click; in the note it denies.
  msgs.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || !event.target.closest) return;
    var card = event.target.closest('.fx-perm');
    if (!card) return;
    event.preventDefault();
    if (event.target.tagName === 'INPUT' && !event.isComposing) card.querySelector('.fx-perm-note button').click();
  });

  // ---- changes ----

  function changesOpen() { return local.getAttribute('data-changes') === 'open'; }
  function showChanges(on) {
    if (on) local.setAttribute('data-changes', 'open');
    else local.removeAttribute('data-changes');
    if (toggle) toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (panel) panel.hidden = !on || !current;
    if (on) changes();
  }

  function changes() {
    if (!current || !changesOpen()) return;
    var id = current;
    var mine = ++changesAsk;
    call('qmo_local_changes', { session: id }).then(function (data) {
      if (mine === changesAsk && current === id) drawChanges(data || {});
    }, function (err) {
      if (mine === changesAsk && current === id) qc.say(byId('code-note'), why(err), 'warn');
    });
  }

  function drawChanges(data) {
    var files = Array.isArray(data.files) ? data.files : [];
    var list = byId('code-files');
    var note = byId('code-note');
    clear(list);
    byId('code-count').textContent = files.length ? String(files.length) : '';
    if (data.source !== 'git') { qc.say(note, tx('notGit', ''), 'muted'); return; }
    qc.say(note, !files.length ? tx('clean', '') : data.truncated ? tx('cut', '') : '', 'muted');
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var path = String(f.path || '');
      var li = el('li', 'fx-code-file');
      li.setAttribute('data-path', path);
      var row = el('button', 'fx-code-frow');
      row.type = 'button';
      row.setAttribute('data-action', 'code-diff');
      row.setAttribute('aria-expanded', opened[path] ? 'true' : 'false');
      var status = String(f.status || '');
      var mark = el('span', 'fx-code-fstat mono', status.slice(0, 1).toUpperCase());
      mark.title = status;
      row.appendChild(mark);
      row.appendChild(el('span', 'fx-code-fpath mono', path));
      row.appendChild(f.binary ? el('span', 'fx-stat', tx('binary', '')) : R.stat(f.added, f.removed));
      li.appendChild(row);
      var pre = el('pre', 'fx-pre fx-diff');
      pre.hidden = !opened[path];
      li.appendChild(pre);
      list.appendChild(li);
      if (opened[path]) diff(li, path);
    }
  }

  function diff(li, path) {
    var id = current;
    var pre = li.querySelector('pre');
    call('qmo_local_diff', { session: id, path: path }).then(function (data) {
      if (current !== id) return;
      clear(pre);
      if (data && data.binary) pre.appendChild(el('span', 'fx-diff-ctx', tx('binary', '')));
      else R.diff(pre, (data && data.text) || '');
      if (data && data.truncated) pre.appendChild(el('span', 'fx-diff-hunk', tx('cut', '')));
    }, function (err) {
      if (current !== id) return;
      clear(pre);
      pre.appendChild(el('span', 'fx-diff-ctx', why(err)));
    });
  }

  qc.onAction('code-diff', function (button) {
    var li = button.closest('.fx-code-file');
    var path = li.getAttribute('data-path') || '';
    var on = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', on ? 'true' : 'false');
    li.querySelector('pre').hidden = !on;
    if (on) { opened[path] = true; diff(li, path); } else delete opened[path];
  });
  qc.onAction('code-changes', function () {
    var on = !changesOpen();
    if (!narrow()) keep('changes', on ? 'open' : 'shut');
    showChanges(on);
  });
  qc.onAction('code-refresh', changes);

  // ---- moving around ----

  qc.onAction('code-open', function (button) {
    closeDrawer();
    var id = button.getAttribute('data-session') || '';
    if (id !== current || !view || view.id !== id) open(id, true);
  });
  qc.onAction('code-new', function () {
    closeDrawer();
    if (current || view) blank(true);
    box.focus();
  });
  window.addEventListener('popstate', function () {
    if (window.location.pathname !== '/code' || !listed) return;
    var id = idInUrl();
    if (id === current) return;
    if (id && sessions[id]) open(id, false);
    else blank(false);
  });
  scroller.addEventListener('scroll', function () { if (scroller.scrollTop < 40) older(); });

  function list(route) {
    listing = true;
    return call('qmo_local_list', {}).then(function (data) {
      listing = false;
      features = (data && data.features) || { protocols: [] };
      folders = data && Array.isArray(data.folders) ? data.folders : [];
      var all = data && Array.isArray(data.sessions) ? data.sessions : [];
      sessions = {};
      for (var i = 0; i < all.length; i++) if (all[i] && typeof all[i].id === 'string') sessions[all[i].id] = all[i];
      listed = true;
      drawFolders('');
      drawAgents();
      side();
      if (!route) { head(); composer(); return; }
      var id = idInUrl();
      if (id && sessions[id]) open(id, false);
      else { if (id) history.replaceState(null, '', '/code'); blank(false); }
    }, function (err) { listing = false; throw err; });
  }

  // The app's own refusal says what went wrong; anything else is an app
  // from before local sessions.
  function refused(err) {
    listing = false;
    if (!/^qmo /.test(why(err))) { elsewhere(tx('updateApp', '')); return; }
    tell(why(err), 'warn');
  }

  var channel = new core.Channel();
  channel.onmessage = function (event) { onEvent(event); };
  showChanges(narrow() ? false : stored('changes') !== 'shut');
  show('blank');
  listing = true;
  call('qmo_local_watch', { channel: channel }).then(function () { return list(true); }).then(null, refused);
  scan(false);
})();
`
}

/** Code's page script. */
export const CODE_JS = stripJsLineComments(codeScript())
