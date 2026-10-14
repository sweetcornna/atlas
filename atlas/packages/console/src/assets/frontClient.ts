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
 * - **Switches without navigating.** Picking an agent opens its latest
 *   conversation (its welcome when it has none); opening a session from the
 *   history menu and starting a new conversation do the same swap of the
 *   head, the thread and the side list, and push the address (`/?session=`,
 *   `/?agent=`), so the back button walks the conversations and a reload
 *   lands on the same one. A top-level navigation is never needed after the
 *   first load.
 * - **Marks what is unread.** Each agent row carries when its agent last
 *   spoke; the page remembers, per agent and in this browser only, the last
 *   time it was looked at, and dots the rows that moved since. The tab's
 *   title counts them.
 * - **Paints the person's line first.** A sent line shows in the thread at
 *   once, marked as on its way, and is replaced by the server's rendering when
 *   the send returns; a failed send takes it back out and puts the text back
 *   in the composer.
 * - **Listens to the stream.** `GET /v0/chat/stream` carries
 *   `{sessionId, revision}` and nothing else. An event for the open session
 *   refreshes the thread; any event refreshes the side panel, which is where a
 *   sub-agent finishing shows. Without a stream it polls, and says so.
 * - **Keeps what the reader chose.** A step group or the running strip
 *   folded by hand stays folded across redraws; an open menu is not swapped
 *   out from under the pointer; the side list and the history menu keep
 *   their scroll; the thread sticks to the bottom only when it was at the
 *   bottom.
 * - **Takes a line by voice** where the browser has speech recognition, asked
 *   to recognise on the device when the browser offers that. The words land
 *   in the composer to be read before they are sent; nothing is sent by
 *   voice alone.
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
  var opened = false;
  var sideTimer = null;
  var viewSeq = 0;
  var sideSeq = 0;
  // Bumped by every move to another conversation. A send pins the number it
  // started under; an answer that arrives after a move updates only the
  // session it belongs to, never what is on screen.
  var nav = 0;
  var switching = false;
  // A view refresh that failed after a send is tried again on its own, a
  // little later each time, until one lands or the person moves on.
  var retryTimer = null;
  var retryDelay = 0;
  var choices = {};
  var model = { target: '', html: '', at: 0, asking: false };
  var baseTitle = document.title;

  // The page's words in the reader's language, sent with the page
  // (view/frontText.ts); Chinese when they are missing.
  var words = {};
  try { words = JSON.parse((byId('fx') && byId('fx').getAttribute('data-text')) || '{}') || {}; } catch (e) { words = {}; }
  function tx(key, fallback) { return typeof words[key] === 'string' ? words[key] : fallback; }
  // A failed open or send: the runtime's own line in Chinese, the page's
  // words and the error's detail in another language.
  function failText(verb, err) {
    var lead = words[verb + 'Failed'];
    if (typeof lead !== 'string') return qc.failLine(verb === 'open' ? '打开' : '发送', err);
    var detail = err && (err.human || err.message) ? String(err.human || err.message) : '';
    return lead + (detail ? ' · ' + detail : '');
  }

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
    if (qc.isExpired()) return Promise.resolve();
    var seq = ++viewSeq;
    var scroller = byId('fx-scroll');
    var stick = toBottom === true || atBottom(scroller);
    var before = replyCount();
    var figure = figureIn('fx-head');
    return qc.loadHtml(viewUrl(opening)).then(function (html) {
      if (seq !== viewSeq || qc.isExpired()) return false;
      var was = threadState();
      adopt(html, ['fx-head', 'fx-thread']);
      stopRetry();
      keepFigure(figure);
      if (!opening) easeRedraw(was);
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
      return true;
    });
  }

  /* ---------------- easing the redraw ---------------- */

  // What the thread held before a redraw: which conversation, how many
  // settled entries, and the live status line.
  function settled(thread) {
    return thread ? thread.querySelectorAll('.fx-msgs > :not(.fx-pending):not([data-prov-chat])') : [];
  }
  function threadState() {
    var thread = byId('fx-thread');
    return {
      session: thread ? thread.getAttribute('data-session') || '' : '',
      count: settled(thread).length,
      pending: thread ? thread.querySelector('.fx-pending') : null
    };
  }

  // A redraw of the same conversation: entries that are new ease in once,
  // and the live status line stays the element it was - its wave keeps
  // moving - with the new words slid in and the new clock carried over.
  function easeRedraw(was) {
    var thread = byId('fx-thread');
    if (!thread || !was.session || (thread.getAttribute('data-session') || '') !== was.session) return;
    var list = settled(thread);
    for (var i = was.count; i < list.length; i++) list[i].classList.add('is-arriving');
    var next = thread.querySelector('.fx-pending');
    if (!next) return;
    var prev = was.pending;
    if (!prev) { next.classList.add('is-arriving'); return; }
    prev.classList.remove('is-arriving');
    var oldWord = prev.querySelector('.fx-typing-word');
    var newWord = next.querySelector('.fx-typing-word');
    if (oldWord && newWord && oldWord.textContent !== newWord.textContent) {
      oldWord.textContent = newWord.textContent;
      oldWord.classList.remove('is-swap');
      void oldWord.offsetWidth;
      oldWord.classList.add('is-swap');
    }
    var oldLine = prev.querySelector('[data-elapsed]');
    var newLine = next.querySelector('[data-elapsed]');
    // Another kind of work: the mark changes with the words.
    if (oldLine && newLine && oldLine.getAttribute('data-kind') !== newLine.getAttribute('data-kind')) {
      var oldSlot = oldLine.querySelector('.fx-act-slot');
      var newSlot = newLine.querySelector('.fx-act-slot');
      if (oldSlot && newSlot) {
        oldSlot.replaceWith(newSlot);
        newSlot.classList.add('is-swap');
      }
      oldLine.className = newLine.className;
      oldLine.setAttribute('data-kind', newLine.getAttribute('data-kind') || 'think');
    }
    if (oldLine && newLine) {
      oldLine.setAttribute('data-elapsed', newLine.getAttribute('data-elapsed') || '0');
      var oldClock = oldLine.querySelector('.fx-typing-time');
      var newClock = newLine.querySelector('.fx-typing-time');
      if (oldClock && newClock) oldClock.textContent = newClock.textContent;
    }
    prev.setAttribute('aria-label', next.getAttribute('aria-label') || '');
    next.replaceWith(prev);
  }

  function stopRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryDelay = 0;
  }

  function retryView(mine) {
    if (retryTimer || qc.isExpired()) return;
    retryDelay = Math.min(retryDelay ? retryDelay * 2 : 3000, 30000);
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (mine !== nav || qc.isExpired()) return;
      refreshView(false, true).then(function (drawn) {
        if (!drawn || mine !== nav) return;
        say(byId('fx-status'), '', 'muted');
        paint();
        focusBox();
      }, function () { retryView(mine); });
    }, retryDelay);
  }

  function refreshSide() {
    if (qc.isExpired()) return Promise.resolve();
    var seq = ++sideSeq;
    var query = [];
    if (state.agent) query.push('agent=' + encodeURIComponent(state.agent));
    if (state.active) query.push('active=' + encodeURIComponent(state.active));
    var scroller = byId('fx-side-scroll');
    var top = scroller ? scroller.scrollTop : 0;
    var list = document.querySelector('#fx-history .fx-hist-list');
    var listTop = list ? list.scrollTop : 0;
    return qc.loadHtml(ROUTES.side + (query.length ? '?' + query.join('&') : '')).then(function (html) {
      if (seq !== sideSeq || qc.isExpired()) return;
      // A menu somebody has open is not swapped out from under the pointer.
      var menuOpen = document.querySelector('#fx-agents .fx-more[open]');
      adopt(html, menuOpen ? ['fx-history', 'fx-stack'] : ['fx-agents', 'fx-history', 'fx-stack']);
      keepChoices(byId('fx-agents'));
      keepChoices(byId('fx-stack'));
      if (scroller) scroller.scrollTop = top;
      var after = document.querySelector('#fx-history .fx-hist-list');
      if (after) after.scrollTop = listTop;
      markCurrent();
      applyHistory();
      applyAgents();
    });
  }

  function soonSide() {
    if (sideTimer || qc.isExpired()) return;
    sideTimer = setTimeout(function () { sideTimer = null; refreshSide(); }, 350);
  }

  function refreshAll() {
    // Not while a first line is on its way: the welcome under it is about to
    // become the conversation, and redrawing it would drop the line.
    var view = state.busy && !state.active ? Promise.resolve() : refreshView(false);
    return Promise.all([view, refreshSide()]);
  }

  document.addEventListener('qianmo:faces', function () { refreshView(false); refreshSide(); });

  /* ---------------- painting ---------------- */

  function agentName() {
    var thread = byId('fx-thread');
    return (thread && thread.getAttribute('data-agent')) || '';
  }

  // Whether the thread on screen is the conversation the state points at. A
  // send goes to state.active, so the composer is live only while that is
  // the conversation the person is looking at: a failed or overtaken switch
  // leaves the old thread up and the composer held.
  function showsState() {
    var thread = byId('fx-thread');
    return !!thread && (thread.getAttribute('data-session') || '') === (state.active || '');
  }

  function setComposer(on) {
    var box = byId('fx-text');
    var send = byId('fx-send');
    var live = on && !switching && showsState();
    if (box) box.disabled = !live;
    if (send) send.disabled = !live || !box || !box.value.trim();
    var plus = byId('fx-plus');
    if (plus) plus.disabled = !live;
    var mic = byId('fx-mic');
    if (mic) mic.disabled = !live;
    if (!live) { hideCommands(); stopVoice(); }
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
    var box = byId('fx-text');
    if (box) box.setAttribute('placeholder', open || start ? tx('messageTo', '发消息给 ') + name : tx('unavailable', '暂不可对话'));
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
    markUnread();
  }

  // An agent's row is unread when its agent spoke after this browser last
  // looked at it. A row seen for the first time is taken as read: the dot
  // is for what changed while the page was open or since the last visit,
  // not for the whole roster on a first load. Only the conversation that
  // spoke counts as looking: the agent's welcome or an older conversation of
  // its does not. What this page has seen it remembers itself, so storage
  // that refuses a write cannot bring a read dot back.
  var seenHere = {};
  function seenOf(key) {
    if (Object.prototype.hasOwnProperty.call(seenHere, key)) return seenHere[key];
    var kept = stored(key);
    return kept === null ? null : Number(kept) || 0;
  }
  function markSeen(key, at) {
    seenHere[key] = at;
    keep(key, String(at));
  }
  function markUnread() {
    var rows = document.querySelectorAll('#fx-agents .fx-agent-row');
    var count = 0;
    for (var i = 0; i < rows.length; i++) {
      var address = rows[i].getAttribute('data-address') || '';
      var updated = Number(rows[i].getAttribute('data-updated')) || 0;
      var latest = rows[i].getAttribute('data-latest') || '';
      var key = 'seen.' + address;
      var seen = seenOf(key);
      var here = !!latest && latest === state.active && showsState() && !document.hidden;
      if (updated && (here || seen === null)) { markSeen(key, updated); seen = updated; }
      var unread = !!updated && updated > (seen || 0);
      rows[i].classList.toggle('is-unread', unread);
      if (unread) count++;
    }
    document.title = count ? '(' + count + ') ' + baseTitle : baseTitle;
  }

  function applyAgents() {
    var section = byId('fx-agents');
    if (!section) return;
    var search = byId('fx-search');
    var q = search ? search.value.trim().toLowerCase() : '';
    var rows = section.querySelectorAll('.fx-agent-row');
    var shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var text = (rows[i].textContent + ' ' + (rows[i].getAttribute('data-address') || '')).toLowerCase();
      rows[i].hidden = !!q && text.indexOf(q) < 0;
      if (!rows[i].hidden) shown++;
    }
    var none = section.querySelector('[data-empty="search"]');
    if (none) none.hidden = !(q && rows.length && !shown);
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
    if (line) line.textContent = tx('newReply', '收到新回复 · ') + (last ? last.textContent.slice(0, 240) : tx('seeChat', '请查看对话'));
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
    if (qc.isExpired()) return;
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
    if (qc.isExpired()) return;
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
        // Above the pause's time, so the time stays next to the turn it dates.
        var before = turns[j].previousElementSibling;
        var anchor = before && before.classList.contains('fx-sep') ? before : turns[j];
        divider.setAttribute('data-prov-chat', '');
        list.insertBefore(divider, anchor);
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

  // The drawer takes focus when it opens and gives it back when it closes.
  var drawerOpener = null;
  function setDrawer(on) {
    var root = byId('fx');
    if (!root) return;
    var was = root.getAttribute('data-drawer') === 'open';
    var main = byId('fx-main');
    if (on) {
      root.setAttribute('data-drawer', 'open');
      if (main) main.inert = true;
      if (!was) {
        drawerOpener = document.activeElement;
        var first = document.querySelector('#fx-side .fx-new');
        if (first) first.focus();
      }
    } else {
      root.removeAttribute('data-drawer');
      if (main) main.inert = false;
      if (was && narrow()) {
        var back = drawerOpener && drawerOpener.isConnected
          ? drawerOpener
          : document.querySelector('.fx-top [data-action="fx-side"]');
        if (back && back.focus) back.focus();
      }
      drawerOpener = null;
    }
  }

  // Widened past the drawer breakpoint with the drawer open: it closes, so
  // the page it made inert comes back.
  if (window.matchMedia) {
    var wide = window.matchMedia('(max-width: 900px)');
    var onWidth = function () { if (!wide.matches) setDrawer(false); };
    if (wide.addEventListener) wide.addEventListener('change', onWidth);
    else if (wide.addListener) wide.addListener(onWidth);
  }

  function focusBox() {
    var box = byId('fx-text');
    if (box && !box.disabled && !narrow()) box.focus();
  }

  // One move to another conversation: the composer is held until the view
  // that move asked for is on screen, so a line can never be sent to a
  // session other than the one shown.
  function go(opening) {
    nav++;
    var mine = nav;
    switching = true;
    stopRetry();
    setComposer(false);
    markCurrent();
    applyHistory();
    say(byId('fx-status'), '', 'muted');
    soonSide();
    // Unheld when this fetch settles, drawn or not; the composer itself waits
    // for the thread on screen to be this conversation (showsState), which a
    // fetch that was overtaken leaves to the one that overtook it.
    return refreshView(opening, true).then(function () {
      if (mine !== nav) return;
      switching = false;
      paint();
      if (showsState()) focusBox();
    }, function (err) {
      if (mine !== nav) return;
      switching = false;
      paint();
      say(byId('fx-status'), failText('open', err), qc.failTone(err));
    });
  }

  function selectAgent(address) {
    setDrawer(false);
    closeMenus();
    if (!address) return;
    state.active = '';
    state.agent = address;
    setAddress(false);
    go(false);
  }

  // A row opens its agent's latest conversation, the way a chat app opens a
  // contact: the agent reads as one running thread. An agent with none
  // opens on its welcome.
  function pickAgent(el) {
    var address = el.getAttribute('data-address') || '';
    var row = el.closest ? el.closest('.fx-agent-row') : null;
    var latest = row ? row.getAttribute('data-latest') || '' : '';
    if (!latest) { selectAgent(address); return; }
    state.agent = address;
    openSession(latest);
  }

  function openSession(id) {
    setDrawer(false);
    closeMenus();
    if (!id) return;
    if (id === state.active && !switching && showsState()) { focusBox(); return; }
    state.active = id;
    setAddress(false);
    go(true);
  }

  function newChat() {
    setDrawer(false);
    closeMenus();
    state.active = '';
    setAddress(false);
    go(false);
  }

  window.addEventListener('popstate', function (event) {
    var entry = event.state;
    if (!entry) {
      var params = new URLSearchParams(window.location.search);
      entry = { active: params.get('session') || '', agent: params.get('agent') || mainAgent };
    }
    state.active = entry.active || '';
    state.agent = entry.agent || state.agent;
    go(!!state.active);
  });

  /* ---------------- sending ---------------- */

  // The session a send goes to, decided when the send starts: the open one,
  // or a new one with the agent shown. A session opened for a send that the
  // person has since moved away from becomes theirs in the list, not the
  // conversation on screen.
  function ensureSession(pin) {
    if (pin.active) return Promise.resolve({ id: pin.active, fresh: false });
    if (!pin.agent) return Promise.reject({ human: tx('pickAgent', '先选一个智能体') });
    return qc.sendJson('POST', ROUTES.create, { target: pin.agent }).then(function (data) {
      if (!data || !data.id) throw { human: tx('noSession', '没能开出会话') };
      var id = String(data.id);
      if (pin.nav === nav) {
        state.active = id;
        setAddress(false);
      }
      return { id: id, fresh: true };
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
    meta.textContent = tx('sending', '发送中');
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
    if (switching || !showsState()) { say(status, tx('opening', '正在打开会话'), 'muted'); return; }
    var text = (typeof given === 'string' ? given : box.value).trim();
    if (!text) return;
    // SSH credentials are never sent to a model: the 部署到新服务器 card takes
    // them (view/frontReplicate.ts). 'keep' leaves the text in the box.
    var taken = window.qianmoFrontReplicate ? window.qianmoFrontReplicate.take(text) : null;
    if (taken) {
      if (taken === 'taken' && typeof given !== 'string') { box.value = ''; autosize(); }
      return;
    }
    var thread = byId('fx-thread');
    var ready = !!thread && (thread.getAttribute('data-open') === '1' || thread.getAttribute('data-start') === '1');
    if (!ready) { say(status, tx('unavailable', '暂不可对话'), 'bad'); return; }
    var pin = { nav: nav, agent: state.agent, active: state.active };
    var welcome = !pin.active;
    hideCommands();
    stopVoice();
    state.busy = true;
    if (form) form.setAttribute('aria-busy', 'true');
    var kept = box.value;
    if (typeof given !== 'string') box.value = '';
    autosize();
    var ghost = paintSending(text);
    say(status, '', 'muted');
    play([['thinking', 0]]);
    var opened = null;
    var sent = false;
    ensureSession(pin).then(function (session) {
      opened = session;
      return qc.sendJson('POST', ROUTES.create + '/' + encodeURIComponent(session.id) + '/messages', { text: text });
    }).then(function () {
      sent = true;
    }, function (err) {
      // The send itself failed: the line comes back out, the text goes back
      // into the box, and a welcome that the line replaced is drawn again.
      if (ghost) ghost.remove();
      if (pin.nav === nav) {
        if (typeof given !== 'string' && !box.value) box.value = kept;
        autosize();
        play([['error', 2400], ['idle', 0]]);
        say(status, failText('send', err), qc.failTone(err));
        // The welcome the line replaced comes back; a conversation opened for
        // the line is shown instead, empty, with the text back in the box.
        if (welcome) refreshView(!!(opened && opened.fresh), true).catch(function () {});
      }
      qc.toast(failText('send', err), qc.failTone(err));
      if (opened) soonSide();
    }).then(function () {
      state.busy = false;
      if (form) form.removeAttribute('aria-busy');
      if (!sent) { paint(); return; }
      soonSide();
      if (pin.nav !== nav) return;
      // Sent and on screen. A refresh that fails now is a refresh that
      // failed, not a send: the line went, and the stream or the next poll
      // brings the view up to date.
      // A conversation that just began is opened, not refreshed: the
      // reading goes on the ledger like any other opening (P15.9).
      return refreshView(!!(opened && opened.fresh), true).then(function () {
        paint();
        focusBox();
      }, function () {
        if (ghost) {
          var meta = ghost.querySelector('.fx-meta');
          if (meta) meta.textContent = tx('sent', '已发送');
        }
        paint();
        say(status, tx('sentRetrying', '已发送 · 刷新失败 · 自动重试中'), 'warn');
        retryView(pin.nav);
      });
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
    var plus = byId('fx-plus');
    if (plus) plus.setAttribute('aria-expanded', 'false');
    picked = -1;
  }
  // The + button lists every command, whatever is in the box.
  function toggleCommands() {
    var list = byId('fx-cmds');
    var box = byId('fx-text');
    if (!list || !box || box.disabled) return;
    if (!list.hidden) { hideCommands(); box.focus(); return; }
    var all = list.querySelectorAll('.fx-cmd');
    for (var i = 0; i < all.length; i++) { all[i].hidden = false; all[i].setAttribute('aria-selected', 'false'); }
    list.hidden = !all.length;
    picked = all.length ? 0 : -1;
    markPicked();
    var plus = byId('fx-plus');
    if (plus) plus.setAttribute('aria-expanded', all.length ? 'true' : 'false');
    box.focus();
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
    var plus = byId('fx-plus');
    if (plus) plus.setAttribute('aria-expanded', any ? 'true' : 'false');
    markPicked();
  }
  function markPicked() {
    var rows = commandRows();
    for (var i = 0; i < rows.length; i++) rows[i].setAttribute('aria-selected', i === picked ? 'true' : 'false');
  }
  /* ---------------- voice ---------------- */

  var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var voice = null;

  function stopVoice() {
    if (voice) { try { voice.abort(); } catch (e) { /* already stopped */ } voice = null; }
    var mic = byId('fx-mic');
    if (mic) mic.setAttribute('aria-pressed', 'false');
  }

  // What is heard goes into the box after what was there, to be read and
  // sent by hand. Typing in the box ends the listening: from then on the
  // words are the reader's, and a late result must not write over them.
  function startVoice() {
    var box = byId('fx-text');
    var mic = byId('fx-mic');
    if (!Recognition || !box || box.disabled || !mic) return;
    if (voice) { try { voice.stop(); } catch (e) { stopVoice(); } return; }
    var rec;
    try { rec = new Recognition(); } catch (e) { say(byId('fx-status'), tx('voiceUnavailable', '语音输入不可用'), 'muted'); return; }
    var base = box.value;
    var join = base && !/\\s$/.test(base) ? ' ' : '';
    rec.lang = tx('voiceLang', 'zh-CN');
    rec.interimResults = true;
    rec.continuous = false;
    if ('processLocally' in rec) { try { rec.processLocally = true; } catch (e) { /* the browser decides */ } }
    rec.onresult = function (event) {
      if (voice !== rec) return;
      var heard = '';
      for (var i = 0; i < event.results.length; i++) heard += event.results[i][0].transcript;
      box.value = base + join + heard;
      autosize();
      typing(box);
    };
    rec.onerror = function (event) {
      var code = event && event.error;
      if (code !== 'aborted' && code !== 'no-speech') say(byId('fx-status'), tx('voiceUnavailable', '语音输入不可用'), 'muted');
    };
    rec.onend = function () {
      if (voice !== rec) return;
      voice = null;
      mic.setAttribute('aria-pressed', 'false');
      focusBox();
    };
    voice = rec;
    mic.setAttribute('aria-pressed', 'true');
    say(byId('fx-status'), '', 'muted');
    try { rec.start(); } catch (e) { stopVoice(); say(byId('fx-status'), tx('voiceUnavailable', '语音输入不可用'), 'muted'); }
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
      startPolling(tx('polling', '轮询中'));
      return;
    }
    try { source = new EventSource(ROUTES.stream); }
    catch (e) { startPolling(tx('polling', '轮询中')); return; }
    source.addEventListener('open', function () {
      var resync = !!pollTimer || opened;
      stopPolling();
      say(byId('fx-live'), '', 'muted');
      // A reconnect may have missed events while it was down: catch up once.
      if (resync) refreshAll();
      opened = true;
    });
    source.addEventListener('chat', function (event) {
      var payload = null;
      try { payload = JSON.parse(event.data); } catch (e) { payload = null; }
      if (payload && payload.sessionId && payload.sessionId === state.active) refreshView(false);
      soonSide();
    });
    source.addEventListener('error', function () {
      startPolling(tx('polling', '轮询中'));
    });
  }

  /* ---------------- wiring ---------------- */

  qc.onExpire(function () {
    if (source) { source.close(); source = null; }
    stopPolling();
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (sideTimer) { clearTimeout(sideTimer); sideTimer = null; }
    if (settle) { clearTimeout(settle); settle = null; }
    stopRetry();
    viewSeq++;
    sideSeq++;
    say(byId('fx-live'), tx('disconnected', '已断开'), 'muted');
  });

  qc.onAction('fx-agent', function (el) { pickAgent(el); });
  qc.onAction('fx-agent-new', function (el) { selectAgent(el.getAttribute('data-address') || ''); });
  qc.onAction('fx-open', function (el) { openSession(el.getAttribute('data-session') || ''); });
  qc.onAction('fx-new', function () { newChat(); });
  qc.onAction('fx-plus', function () { toggleCommands(); });
  qc.onAction('fx-mic', function () { startVoice(); });
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
    var done = function () { qc.toast(tx('copied', '已复制'), 'ok'); };
    var failed = function () { qc.toast(tx('copyFailed', '复制失败'), 'warn'); };
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

  /* ---------------- 主题色 ---------------- */

  // A preset by name or a picked #rrggbb: applied at once, kept in a cookie
  // the server draws the next page with (preferences.ts).
  // The same choice as accentInk in view/accent.ts: the better of ink and
  // white, or pure black where neither reaches 4.5:1.
  function accentInk(hex) {
    var luminance = function (color) {
      var lin = function (at) {
        var v = parseInt(color.slice(at, at + 2), 16) / 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
    };
    var ground = luminance(hex);
    var contrast = function (ink) {
      var other = luminance(ink);
      return (Math.max(ground, other) + 0.05) / (Math.min(ground, other) + 0.05);
    };
    var best = contrast('#111110') >= contrast('#ffffff') ? '#111110' : '#ffffff';
    return contrast(best) >= 4.5 ? best : '#000000';
  }
  function markAccent() {
    var root = document.documentElement;
    var name = root.getAttribute('data-accent') || 'ink';
    var swatches = document.querySelectorAll('.fx-swatch[data-accent]');
    for (var i = 0; i < swatches.length; i++) {
      swatches[i].setAttribute('aria-pressed', swatches[i].getAttribute('data-accent') === name ? 'true' : 'false');
    }
    var custom = byId('fx-accent-custom');
    var label = custom ? custom.parentElement : null;
    var picked = root.style.getPropertyValue('--qm-accent').trim();
    if (label) label.classList.toggle('is-picked', name === 'custom');
    if (custom && /^#[0-9a-f]{6}$/i.test(picked)) custom.value = picked;
  }
  function setAccent(value) {
    var root = document.documentElement;
    var picked = /^#[0-9a-f]{6}$/i.test(value);
    if (picked) {
      root.setAttribute('data-accent', 'custom');
      root.style.setProperty('--qm-accent', value.toLowerCase());
      root.style.setProperty('--qm-accent-ink', accentInk(value));
    } else {
      root.setAttribute('data-accent', value);
      root.style.removeProperty('--qm-accent');
      root.style.removeProperty('--qm-accent-ink');
    }
    document.cookie = 'qianmo_accent=' + encodeURIComponent(value.toLowerCase()) +
      '; Path=/; Max-Age=31536000; SameSite=Strict' + (location.protocol === 'https:' ? '; Secure' : '');
    markAccent();
  }
  qc.onAction('fx-accent', function (el) { setAccent(el.getAttribute('data-accent') || 'ink'); });
  document.addEventListener('input', function (event) {
    if (event.target && event.target.id === 'fx-accent-custom') setAccent(event.target.value);
  });

  // 语言: kept in a cookie the server reads (i18n.ts), then the page is drawn
  // again in it - every word on it comes from the server.
  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || target.id !== 'fx-lang') return;
    var value = String(target.value || '');
    if (!/^(zh-CN|en|ja)$/.test(value)) return;
    document.cookie = 'qianmo_lang=' + value + '; Path=/; Max-Age=31536000; SameSite=Strict' +
      (location.protocol === 'https:' ? '; Secure' : '');
    location.reload();
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
    else if (!target.closest('#fx-composer')) hideCommands();
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
      // The topmost surface owns Esc: an open dialog is the runtime's.
      if (document.querySelector('dialog[open]')) return;
      if (document.querySelector('details.fx-more[open]')) { closeMenus(); return; }
      var root = byId('fx');
      if (root && root.getAttribute('data-drawer') === 'open') setDrawer(false);
    }
  });

  document.addEventListener('input', function (event) {
    var target = event.target;
    if (!target) return;
    if (target.id === 'fx-text') { if (voice) stopVoice(); autosize(); typing(target); showCommands(target); }
    else if (target.id === 'fx-search') { applyAgents(); applyHistory(); }
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !qc.isExpired()) { markUnread(); refreshAll(); }
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
    var mic = byId('fx-mic');
    if (mic && Recognition) mic.hidden = false;
    markAccent();
    paint();
    applyHistory();
    applyAgents();
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
