// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The conversation front's script, on top of the shared runtime (`client.ts`).
 *
 * It keeps the runtime's two rules and adds nothing that bends them: the only
 * HTML it puts on the page is a fragment the server rendered (`view/front.ts`),
 * adopted by id out of a detached `<template>`; every other string — a status
 * line, a placeholder, the line the person just sent while it travels — goes
 * in as text.
 *
 * ## What it does
 *
 * - **Switches without navigating.** Picking an agent, opening a session and
 *   starting a new conversation swap the head, the thread and the side panel
 *   and push the address (`/?session=`, `/?agent=`), so the back button walks
 *   the conversations and a reload lands on the same one. A top-level
 *   navigation is never needed after the first load.
 * - **Paints the person's line first.** A sent line shows in the thread at
 *   once, marked as on its way, and is replaced by the server's rendering when
 *   the send returns; a failed send takes it back out and puts the text back
 *   in the composer.
 * - **Listens to the stream.** `GET /v0/chat/stream` carries
 *   `{sessionId, revision}` and nothing else. An event for the open session
 *   refreshes the thread; any event refreshes the side panel, which is where a
 *   sub-agent finishing shows. Without a stream it polls, and says so.
 * - **Keeps what the reader chose.** A step group or a server folded by hand
 *   stays folded across redraws; an open menu is not swapped out from under
 *   the pointer; the side panel keeps its scroll; the thread sticks to the
 *   bottom only when it was at the bottom.
 */

import { stripJsLineComments } from './client.js'

function frontScript(): string {
  return `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var say = qc.say;

  var ROUTES = {
    side: '/fragments/chat/front/side',
    view: '/fragments/chat/front/view',
    create: '/v0/chat/sessions',
    stream: '/v0/chat/stream',
    model: '/fragments/providers/chat?target='
  };
  var POLL_MS = 2500;
  var MODEL_REUSE_MS = 30000;
  var STORE = 'qianmo.front.';
  var state = { active: '', agent: '', scope: 'agent', busy: false };
  var mainAgent = '';
  var pollTimer = null;
  var source = null;
  var sideTimer = null;
  var viewSeq = 0;
  var sideSeq = 0;
  var choices = {};
  var model = { target: '', html: '', at: 0, asking: false };

  function stored(key) {
    try { return window.localStorage.getItem(STORE + key); } catch (e) { return null; }
  }
  function keep(key, value) {
    try { window.localStorage.setItem(STORE + key, value); } catch (e) { /* a convenience only */ }
  }
  function narrow() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 900px)').matches);
  }

  /* ---------------- fragments ---------------- */

  // Parsed in a detached template - inert, no script runs - and adopted by id.
  function adopt(html, ids) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    for (var i = 0; i < ids.length; i++) {
      var next = tpl.content.querySelector('#' + ids[i]);
      var current = byId(ids[i]);
      if (next && current) current.replaceWith(next);
    }
  }

  // A <details data-key> folded or unfolded by hand stays that way.
  document.addEventListener('click', function (event) {
    var target = event.target;
    var summary = target && target.closest ? target.closest('details[data-key] > summary') : null;
    if (!summary) return;
    var details = summary.parentElement;
    choices[details.getAttribute('data-key')] = !details.open;
  }, true);

  function keepChoices(root) {
    if (!root) return;
    var list = root.querySelectorAll('details[data-key]');
    for (var i = 0; i < list.length; i++) {
      var key = list[i].getAttribute('data-key');
      if (Object.prototype.hasOwnProperty.call(choices, key)) list[i].open = choices[key];
    }
  }

  function atBottom(el) {
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  }

  function replyCount() {
    var thread = byId('fx-thread');
    return thread ? thread.querySelectorAll('.fx-msg-agent:not(.fx-pending)').length : 0;
  }

  function viewUrl(opening) {
    if (state.active) {
      return ROUTES.view + '/' + encodeURIComponent(state.active) + (opening ? '?open=1' : '');
    }
    return ROUTES.view + (state.agent ? '?agent=' + encodeURIComponent(state.agent) : '');
  }

  // opening marks the fetch that is somebody switching to a conversation: the
  // server writes a ledger line for it (P15.9), and never for a refresh.
  function refreshView(opening, toBottom) {
    var seq = ++viewSeq;
    var scroller = byId('fx-scroll');
    var stick = toBottom === true || atBottom(scroller);
    var before = replyCount();
    var figure = figureIn('fx-head');
    return qc.loadHtml(viewUrl(opening)).then(function (html) {
      if (seq !== viewSeq) return;
      adopt(html, ['fx-head', 'fx-thread']);
      keepFigure(figure);
      keepChoices(byId('fx-thread'));
      var thread = byId('fx-thread');
      var target = thread ? thread.getAttribute('data-target') : '';
      if (target) state.agent = target;
      if (!opening && replyCount() > before) announce();
      paint();
      stampTimers();
      if (stick && scroller) scroller.scrollTop = scroller.scrollHeight;
      updateJump();
      askModel();
    });
  }

  function refreshSide() {
    var seq = ++sideSeq;
    var query = [];
    if (state.agent) query.push('agent=' + encodeURIComponent(state.agent));
    if (state.active) query.push('active=' + encodeURIComponent(state.active));
    var scroller = byId('fx-side-scroll');
    var top = scroller ? scroller.scrollTop : 0;
    return qc.loadHtml(ROUTES.side + (query.length ? '?' + query.join('&') : '')).then(function (html) {
      if (seq !== sideSeq) return;
      // A menu somebody has open is not swapped out from under the pointer.
      var menuOpen = document.querySelector('#fx-agents .fx-more[open]');
      adopt(html, menuOpen ? ['fx-history', 'fx-stack'] : ['fx-agents', 'fx-history', 'fx-stack']);
      keepChoices(byId('fx-agents'));
      keepChoices(byId('fx-stack'));
      if (scroller) scroller.scrollTop = top;
      markCurrent();
      applyHistory();
    });
  }

  function soonSide() {
    if (sideTimer) return;
    sideTimer = setTimeout(function () { sideTimer = null; refreshSide(); }, 350);
  }

  function refreshAll() {
    return Promise.all([state.active ? refreshView(false) : Promise.resolve(), refreshSide()]);
  }

  document.addEventListener('qianmo:faces', function () { refreshView(false); refreshSide(); });

  /* ---------------- painting ---------------- */

  function agentName() {
    var thread = byId('fx-thread');
    return (thread && thread.getAttribute('data-agent')) || '';
  }

  function setComposer(on) {
    var box = byId('fx-text');
    var send = byId('fx-send');
    if (box) box.disabled = !on;
    if (send) send.disabled = !on || !box || !box.value.trim();
  }

  function paint() {
    var thread = byId('fx-thread');
    if (!thread) return;
    var main = byId('fx-main');
    var welcome = thread.getAttribute('data-welcome') === '1';
    if (main) main.classList.toggle('is-welcome', welcome);
    var open = thread.getAttribute('data-open') === '1';
    var start = thread.getAttribute('data-start') === '1';
    var name = agentName();
    setComposer(open || start);
    var who = byId('fx-target-name');
    if (who) who.textContent = name || '—';
    var dot = byId('fx-target-dot');
    if (dot) dot.className = 'dot dot-' + (thread.getAttribute('data-tone') || 'muted');
    var box = byId('fx-text');
    if (box) {
      box.setAttribute('placeholder', open
        ? '给 ' + name + ' 发消息 · Enter 发送 · Shift Enter 换行'
        : start
          ? '写下要让 ' + name + ' 做的事 · Enter 开始新会话'
          : '这个智能体暂时不能对话');
    }
    markCurrent();
  }

  function markCurrent() {
    var rows = document.querySelectorAll('#fx-agents .fx-agent-row');
    for (var i = 0; i < rows.length; i++) {
      var here = rows[i].getAttribute('data-address') === state.agent;
      rows[i].classList.toggle('is-current', here);
      var button = rows[i].querySelector('.fx-agent');
      if (button) {
        if (here) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      }
    }
    var items = document.querySelectorAll('#fx-history .fx-hitem');
    for (var j = 0; j < items.length; j++) {
      var active = !!state.active && items[j].getAttribute('data-session') === state.active;
      items[j].classList.toggle('is-active', active);
      if (active) items[j].setAttribute('aria-current', 'true');
      else items[j].removeAttribute('aria-current');
    }
  }

  function applyHistory() {
    var section = byId('fx-history');
    if (!section) return;
    var search = byId('fx-search');
    var q = search ? search.value.trim().toLowerCase() : '';
    section.setAttribute('data-scope', q ? 'all' : state.scope);
    var toggles = section.querySelectorAll('[data-action="fx-scope"]');
    for (var t = 0; t < toggles.length; t++) {
      toggles[t].setAttribute('aria-pressed', toggles[t].getAttribute('data-scope') === state.scope ? 'true' : 'false');
    }
    var items = section.querySelectorAll('.fx-hitem');
    var shown = 0;
    var mine = 0;
    for (var i = 0; i < items.length; i++) {
      var target = items[i].getAttribute('data-target');
      if (target === state.agent) mine++;
      var inScope = !!q || state.scope === 'all' || !state.agent || target === state.agent;
      var matches = !q || items[i].textContent.toLowerCase().indexOf(q) >= 0;
      items[i].hidden = !(inScope && matches);
      if (!items[i].hidden) shown++;
    }
    var groups = section.querySelectorAll('.fx-hgroup');
    for (var g = 0; g < groups.length; g++) {
      groups[g].hidden = !groups[g].querySelector('.fx-hitem:not([hidden])');
    }
    var empty = function (which, on) {
      var line = section.querySelector('[data-empty="' + which + '"]');
      if (line) line.hidden = !on;
    };
    empty('all', items.length === 0);
    empty('search', !!q && items.length > 0 && shown === 0);
    empty('agent', !q && state.scope === 'agent' && items.length > 0 && mine === 0 && !!state.agent);
  }

  function announce() {
    var line = byId('reply-announcement');
    var replies = document.querySelectorAll('#fx-thread .fx-msg-agent:not(.fx-pending)');
    var last = replies.length ? replies[replies.length - 1].querySelector('.fx-text, .fx-pre') : null;
    if (line) line.textContent = '收到新回复 · ' + (last ? last.textContent.slice(0, 240) : '请查看对话');
    play([['speaking', 2400], ['happy', 5000], ['idle', 0]]);
  }

  /* ---------------- the figures (形象) ---------------- */

  var settle = null;

  function figureIn(id) {
    var root = byId(id);
    return root ? root.querySelector('.fx-head-face .avatar, .fx-welcome-face .avatar') : null;
  }

  // A redraw of the same figure keeps the one already moving, with the new
  // state: a new turn changes what it does instead of restarting it.
  function keepFigure(before) {
    var after = figureIn('fx-head');
    if (!before || !after) return;
    if (before.getAttribute('data-face') !== after.getAttribute('data-face')) return;
    before.setAttribute('data-state', after.getAttribute('data-state') || 'idle');
    after.replaceWith(before);
  }

  function figures() {
    var list = [];
    var head = figureIn('fx-head');
    var greet = figureIn('fx-thread');
    if (head) list.push(head);
    if (greet) list.push(greet);
    return list;
  }

  function play(steps) {
    if (settle) { clearTimeout(settle); settle = null; }
    var list = figures();
    if (!list.length || !steps.length) return;
    for (var i = 0; i < list.length; i++) list[i].setAttribute('data-state', steps[0][0]);
    if (steps.length > 1) settle = setTimeout(function () { play(steps.slice(1)); }, steps[0][1]);
  }

  function typing(box) {
    var list = figures();
    if (!list.length) return;
    var now = list[0].getAttribute('data-state');
    if (box.value.trim() && (now === 'idle' || now === 'happy')) play([['listening', 0]]);
    else if (!box.value.trim() && now === 'listening') play([['idle', 0]]);
  }

  /* ---------------- the running clock ---------------- */

  // The pending line says how long the answer has taken. The server drew the
  // number at render time; the page carries it on from there in text.
  var tickTimer = null;
  function fmt(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    return m + 'm ' + (s % 60) + 's';
  }
  function stampTimers() {
    var lines = document.querySelectorAll('#fx-thread [data-elapsed]');
    var now = Date.now();
    for (var i = 0; i < lines.length; i++) lines[i].setAttribute('data-seen', String(now));
    if (lines.length && !tickTimer) tickTimer = setInterval(tick, 1000);
    if (!lines.length && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }
  function tick() {
    var lines = document.querySelectorAll('#fx-thread [data-elapsed]');
    if (!lines.length) { clearInterval(tickTimer); tickTimer = null; return; }
    var now = Date.now();
    for (var i = 0; i < lines.length; i++) {
      var base = Number(lines[i].getAttribute('data-elapsed')) || 0;
      var seen = Number(lines[i].getAttribute('data-seen')) || now;
      var clock = lines[i].querySelector('.fx-typing-time');
      if (clock) clock.textContent = fmt(base + now - seen);
    }
  }

  /* ---------------- the model label (P18.9) ---------------- */

  // The target's model, from the model service area's own fragment, moved into
  // the head; a divider in the thread where the node last switched. Nothing
  // when the fragment is empty: no model service here, or a node it does not
  // manage.
  function paintModel() {
    var slot = byId('fx-model');
    var thread = byId('fx-thread');
    var old = document.querySelectorAll('#fx-thread [data-prov-chat]');
    for (var i = 0; i < old.length; i++) old[i].remove();
    if (slot) slot.textContent = '';
    if (!slot || !thread || !model.html || thread.getAttribute('data-target') !== model.target) return;
    var tpl = document.createElement('template');
    tpl.innerHTML = model.html;
    var label = tpl.content.querySelector('#prov-chat-label');
    if (label) slot.appendChild(label);
    var divider = tpl.content.querySelector('#prov-chat-divider');
    var list = thread.querySelector('.fx-msgs');
    if (!divider || !list) return;
    var at = Number(divider.getAttribute('data-at'));
    var turns = list.querySelectorAll(':scope > .fx-msg, :scope > .fx-steps');
    var first = turns.length ? turns[0].querySelector('time[data-at]') : null;
    if (!first || !(Number(first.getAttribute('data-at')) < at)) return;
    for (var j = 0; j < turns.length; j++) {
      var when = turns[j].querySelector('time[data-at]');
      if (when && Number(when.getAttribute('data-at')) >= at) {
        divider.setAttribute('data-prov-chat', '');
        list.insertBefore(divider, turns[j]);
        return;
      }
    }
  }

  function askModel() {
    var thread = byId('fx-thread');
    var target = thread ? thread.getAttribute('data-target') || '' : '';
    if (!target) { model = { target: '', html: '', at: 0, asking: false }; paintModel(); return; }
    if (model.asking) return;
    if (target === model.target && Date.now() - model.at < MODEL_REUSE_MS) { paintModel(); return; }
    model.asking = true;
    qc.loadHtml(ROUTES.model + encodeURIComponent(target))
      .then(function (html) { model = { target: target, html: html.trim(), at: Date.now(), asking: false }; })
      .catch(function () { model = { target: target, html: '', at: Date.now(), asking: false }; })
      .then(paintModel);
  }

  /* ---------------- moving between conversations ---------------- */

  function setAddress(replace) {
    var url = state.active
      ? '/?session=' + encodeURIComponent(state.active)
      : state.agent && state.agent !== mainAgent
        ? '/?agent=' + encodeURIComponent(state.agent)
        : '/';
    try {
      var entry = { active: state.active, agent: state.agent };
      if (window.location.pathname + window.location.search === url) history.replaceState(entry, '', url);
      else if (replace) history.replaceState(entry, '', url);
      else history.pushState(entry, '', url);
    } catch (e) { /* the address bar is cosmetic; the state is in the variables */ }
  }

  function closeMenus(except) {
    var open = document.querySelectorAll('details.fx-more[open]');
    for (var i = 0; i < open.length; i++) if (open[i] !== except) open[i].open = false;
  }

  function setDrawer(on) {
    var root = byId('fx');
    if (!root) return;
    if (on) root.setAttribute('data-drawer', 'open');
    else root.removeAttribute('data-drawer');
  }

  function focusBox() {
    var box = byId('fx-text');
    if (box && !box.disabled && !narrow()) box.focus();
  }

  function selectAgent(address) {
    setDrawer(false);
    closeMenus();
    if (!address) return;
    state.active = '';
    state.agent = address;
    setAddress(false);
    markCurrent();
    applyHistory();
    say(byId('fx-status'), '', 'muted');
    refreshView(false, true).then(focusBox);
    soonSide();
  }

  function openSession(id) {
    setDrawer(false);
    closeMenus();
    if (!id) return;
    if (id === state.active) { focusBox(); return; }
    state.active = id;
    setAddress(false);
    markCurrent();
    say(byId('fx-status'), '', 'muted');
    refreshView(true, true).then(function () { applyHistory(); focusBox(); });
    soonSide();
  }

  function newChat() {
    setDrawer(false);
    closeMenus();
    state.active = '';
    setAddress(false);
    markCurrent();
    say(byId('fx-status'), '', 'muted');
    refreshView(false, true).then(focusBox);
    soonSide();
  }

  window.addEventListener('popstate', function (event) {
    var entry = event.state;
    if (!entry) {
      var params = new URLSearchParams(window.location.search);
      entry = { active: params.get('session') || '', agent: params.get('agent') || mainAgent };
    }
    state.active = entry.active || '';
    state.agent = entry.agent || state.agent;
    markCurrent();
    refreshView(!!state.active, true);
    soonSide();
  });

  /* ---------------- sending ---------------- */

  function ensureSession() {
    if (state.active) return Promise.resolve({ id: state.active, fresh: false });
    if (!state.agent) return Promise.reject({ human: '先选一个智能体' });
    return qc.sendJson('POST', ROUTES.create, { target: state.agent }).then(function (data) {
      if (!data || !data.id) throw { human: '没能开出会话' };
      state.active = String(data.id);
      setAddress(false);
      return { id: state.active, fresh: true };
    });
  }

  // The line goes on the page before the network answers, as text.
  function paintSending(text) {
    var thread = byId('fx-thread');
    if (!thread) return null;
    var list = thread.querySelector('.fx-msgs');
    if (!list) {
      var main = byId('fx-main');
      if (main) main.classList.remove('is-welcome');
      while (thread.firstChild) thread.removeChild(thread.firstChild);
      list = document.createElement('div');
      list.className = 'fx-msgs';
      thread.appendChild(list);
    }
    var none = list.querySelector('.fx-none');
    if (none) none.remove();
    var article = document.createElement('article');
    article.className = 'fx-msg fx-msg-user is-sending';
    var bubble = document.createElement('div');
    bubble.className = 'fx-bubble';
    var para = document.createElement('p');
    para.className = 'turn-p';
    para.textContent = text;
    bubble.appendChild(para);
    var meta = document.createElement('div');
    meta.className = 'fx-meta';
    meta.textContent = '发送中';
    article.appendChild(bubble);
    article.appendChild(meta);
    list.appendChild(article);
    var scroller = byId('fx-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    return article;
  }

  function send(given) {
    var box = byId('fx-text');
    var status = byId('fx-status');
    var form = byId('fx-composer');
    if (state.busy || !box) return;
    var text = (typeof given === 'string' ? given : box.value).trim();
    if (!text) return;
    var thread = byId('fx-thread');
    var ready = !!thread && (thread.getAttribute('data-open') === '1' || thread.getAttribute('data-start') === '1');
    if (!ready) { say(status, '这个智能体暂时不能对话', 'bad'); return; }
    hideCommands();
    state.busy = true;
    if (form) form.setAttribute('aria-busy', 'true');
    var kept = box.value;
    if (typeof given !== 'string') box.value = '';
    autosize();
    setComposer(true);
    var ghost = paintSending(text);
    say(status, '', 'muted');
    play([['thinking', 0]]);
    var fresh = false;
    ensureSession().then(function (session) {
      fresh = session.fresh;
      return qc.sendJson('POST', ROUTES.create + '/' + encodeURIComponent(session.id) + '/messages', { text: text });
    }).then(function () {
      // A conversation that just began is opened, not refreshed: the reading
      // goes on the ledger like any other opening (P15.9).
      return refreshView(fresh, true).then(soonSide);
    }).catch(function (err) {
      if (ghost) ghost.remove();
      if (typeof given !== 'string' && !box.value) box.value = kept;
      autosize();
      play([['error', 2400], ['idle', 0]]);
      say(status, qc.failLine('发送', err), qc.failTone(err));
      qc.toast(qc.failLine('发送', err), qc.failTone(err));
      if (fresh || state.active) soonSide();
    }).then(function () {
      state.busy = false;
      if (form) form.removeAttribute('aria-busy');
      paint();
      focusBox();
    });
  }

  /* ---------------- the composer ---------------- */

  function autosize() {
    var box = byId('fx-text');
    if (!box) return;
    // An empty box is one line: its placeholder can wrap while the layout
    // settles, and must never be what sizes it.
    if (!box.value) box.style.height = '';
    else {
      box.style.height = 'auto';
      box.style.height = Math.min(box.scrollHeight, 240) + 'px';
    }
    var send = byId('fx-send');
    if (send) send.disabled = box.disabled || !box.value.trim();
  }

  var picked = -1;
  function commandRows() {
    var list = byId('fx-cmds');
    return list ? list.querySelectorAll('.fx-cmd:not([hidden])') : [];
  }
  function hideCommands() {
    var list = byId('fx-cmds');
    if (list) list.hidden = true;
    picked = -1;
  }
  function showCommands(box) {
    var list = byId('fx-cmds');
    if (!list) return;
    var value = box.value;
    if (value.charAt(0) !== '/' || /\\s/.test(value)) { hideCommands(); return; }
    var all = list.querySelectorAll('.fx-cmd');
    var any = false;
    for (var i = 0; i < all.length; i++) {
      var match = (all[i].getAttribute('data-cmd') || '').indexOf(value) === 0;
      all[i].hidden = !match;
      all[i].setAttribute('aria-selected', 'false');
      if (match) any = true;
    }
    list.hidden = !any;
    picked = any ? 0 : -1;
    markPicked();
  }
  function markPicked() {
    var rows = commandRows();
    for (var i = 0; i < rows.length; i++) rows[i].setAttribute('aria-selected', i === picked ? 'true' : 'false');
  }
  function useCommand(row) {
    var box = byId('fx-text');
    if (!box || !row) return;
    box.value = (row.getAttribute('data-cmd') || '') + ' ';
    hideCommands();
    autosize();
    box.focus();
  }

  /* ---------------- the jump button ---------------- */

  function updateJump() {
    var jump = byId('fx-jump');
    var scroller = byId('fx-scroll');
    if (!jump || !scroller) return;
    jump.hidden = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 240;
  }

  /* ---------------- stream ---------------- */

  function startPolling(reason) {
    if (pollTimer || qc.isExpired()) return;
    say(byId('fx-live'), reason, 'muted');
    pollTimer = setInterval(function () {
      if (!document.hidden) refreshAll();
    }, POLL_MS);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function startStream() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('stream') === 'off' || typeof window.EventSource !== 'function') {
      startPolling('轮询中');
      return;
    }
    try { source = new EventSource(ROUTES.stream); }
    catch (e) { startPolling('轮询中'); return; }
    source.addEventListener('open', function () {
      stopPolling();
      say(byId('fx-live'), '', 'muted');
    });
    source.addEventListener('chat', function (event) {
      var payload = null;
      try { payload = JSON.parse(event.data); } catch (e) { payload = null; }
      if (payload && payload.sessionId && payload.sessionId === state.active) refreshView(false);
      soonSide();
    });
    source.addEventListener('error', function () {
      startPolling('实时连接中断 · 轮询中');
    });
  }

  /* ---------------- wiring ---------------- */

  qc.onExpire(function () {
    if (source) { source.close(); source = null; }
    stopPolling();
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    say(byId('fx-live'), '已断开', 'muted');
  });

  qc.onAction('fx-agent', function (el) { selectAgent(el.getAttribute('data-address') || ''); });
  qc.onAction('fx-agent-new', function (el) { selectAgent(el.getAttribute('data-address') || ''); });
  qc.onAction('fx-open', function (el) { openSession(el.getAttribute('data-session') || ''); });
  qc.onAction('fx-new', function () { newChat(); });
  qc.onAction('fx-suggest', function (el) { send(el.getAttribute('data-text') || ''); });
  qc.onAction('fx-jump', function () {
    var scroller = byId('fx-scroll');
    if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  });
  qc.onAction('fx-scope', function (el) {
    state.scope = el.getAttribute('data-scope') === 'all' ? 'all' : 'agent';
    keep('scope', state.scope);
    applyHistory();
  });
  qc.onAction('fx-side', function () {
    var root = byId('fx');
    if (!root) return;
    if (narrow()) { setDrawer(root.getAttribute('data-drawer') !== 'open'); return; }
    var closed = root.getAttribute('data-side') === 'closed';
    root.setAttribute('data-side', closed ? 'open' : 'closed');
    keep('side', closed ? 'open' : 'closed');
  });
  qc.onAction('fx-side-close', function () { setDrawer(false); });

  function copy(text) {
    closeMenus();
    if (!text) return;
    var done = function () { qc.toast('已复制', 'ok'); };
    var failed = function () { qc.toast('复制失败 · 浏览器没有允许写剪贴板', 'warn'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, failed);
      else failed();
    } catch (e) { failed(); }
  }
  qc.onAction('fx-copy', function (el) { copy(el.getAttribute('data-copy') || ''); });
  qc.onAction('fx-copy-turn', function (el) {
    var body = el.closest('.fx-msg-body');
    var text = body ? body.querySelector('.fx-text, .fx-pre') : null;
    copy(text ? text.textContent : '');
  });

  qc.onSubmit('fx-composer', function () { send(); });

  document.addEventListener('toggle', function (event) {
    var details = event.target;
    if (details && details.classList && details.classList.contains('fx-more') && details.open) closeMenus(details);
  }, true);

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    if (!target.closest('details.fx-more')) closeMenus();
    var row = target.closest('.fx-cmd');
    if (row) useCommand(row);
  });

  document.addEventListener('keydown', function (event) {
    var target = event.target;
    var list = byId('fx-cmds');
    var commandsOpen = list && !list.hidden;
    if (target && target.id === 'fx-text') {
      if (commandsOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        var rows = commandRows();
        if (rows.length) {
          event.preventDefault();
          picked = (picked + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
          markPicked();
        }
        return;
      }
      if (commandsOpen && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.isComposing))) {
        var choice = commandRows()[picked];
        if (choice) { event.preventDefault(); useCommand(choice); return; }
      }
      if (event.key === 'Escape' && commandsOpen) { event.preventDefault(); hideCommands(); return; }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'O' || event.key === 'o')) {
      event.preventDefault();
      newChat();
      return;
    }
    if (event.key === 'Escape') {
      if (document.querySelector('details.fx-more[open]')) { closeMenus(); return; }
      var root = byId('fx');
      if (root && root.getAttribute('data-drawer') === 'open') setDrawer(false);
    }
  });

  document.addEventListener('input', function (event) {
    var target = event.target;
    if (!target) return;
    if (target.id === 'fx-text') { autosize(); typing(target); showCommands(target); }
    else if (target.id === 'fx-search') applyHistory();
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !qc.isExpired()) refreshAll();
  });

  function start() {
    var thread = byId('fx-thread');
    state.active = (thread && thread.getAttribute('data-session')) || '';
    state.agent = (thread && thread.getAttribute('data-target')) || '';
    var mainRow = document.querySelector('#fx-agents .fx-agent-main');
    mainAgent = mainRow ? mainRow.getAttribute('data-address') || '' : '';
    state.scope = stored('scope') === 'all' ? 'all' : 'agent';
    var root = byId('fx');
    if (root && stored('side') === 'closed' && !narrow()) root.setAttribute('data-side', 'closed');
    try {
      history.replaceState({ active: state.active, agent: state.agent }, '', window.location.pathname + window.location.search);
    } catch (e) { /* cosmetic */ }
    paint();
    applyHistory();
    autosize();
    stampTimers();
    var scroller = byId('fx-scroll');
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.addEventListener('scroll', updateJump, { passive: true });
    }
    focusBox();
    askModel();
    qc.afterSession(startStream);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`
}

/** The conversation front's page script. */
export const FRONT_JS = stripJsLineComments(frontScript())
