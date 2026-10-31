// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The conversation front's script, on top of the shared runtime (`client.ts`).
 * One script draws both faces (`view/front.ts`): 智能体 at `/` and 对话 at
 * `/app`, each with the agents down the side, one conversation per agent
 * (P37.17). Where they differ it asks which face it is on (`CHAT`).
 *
 * It keeps the runtime's two rules and adds nothing that bends them: the only
 * HTML it puts on the page is a fragment the server rendered (`view/front.ts`),
 * adopted by id out of a detached `<template>`; every other string — a status
 * line, a placeholder, the line the person just sent while it travels — goes
 * in as text.
 *
 * ## What it does
 *
 * - **Switches without navigating.** Picking an agent opens the reader's one
 *   conversation with it (P37.17; its welcome before the first line); opening
 *   one of its other conversations from ⋯ 其他对话 does the same swap of the
 *   head, the thread and the side list, read-only, and every move pushes the
 *   address (`/?agent=` for an agent's own conversation, nothing for the main
 *   agent's, `/?session=` for any other; the same under `/app`), so the back
 *   button walks the conversations and a reload lands on the same one. A
 *   top-level navigation is never needed after the first load.
 * - **Marks what is unread.** Each agent row carries when its conversation
 *   last moved; the page remembers, per row and in this browser only, the
 *   last time it was looked at, and dots the rows that moved since. The tab's
 *   title counts them; in the desktop app so does the badge, and an agent
 *   finishing while the window is elsewhere is a notification
 *   (`assets/frontShell.ts`).
 * - **Keeps the conversations that are not with one agent in their days**
 *   (P37.17 B): grouped 今天 · 昨天 · 过去 7 天 · 更早 by this browser's clock;
 *   the search line filters them by title, and the agents by name.
 * - **Keys**: ⌘N or Ctrl N the main agent's conversation (⌘⇧O in a browser),
 *   ⌘K the search line, ⌘⇧S the sidebar, ⌘. the session panel; in a narrow
 *   window the sidebar is a drawer.
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

import { FRONT_NARROW_PX } from '../view/frontStyle.js'
import { stripJsLineComments } from './client.js'

function frontScript(): string {
  return `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var say = qc.say;

  // Which face this page is (view/front.ts): '/' draws the agents, '/app'
  // the conversations. The same script runs both; the few things that differ
  // ask CHAT.
  var CHAT = !!byId('fx') && byId('fx').getAttribute('data-layout') === 'chat';
  // A frame with no conversation in it (view/front.ts): Code at /code, or
  // Work for a reader who may not hold one here. The side list, the menus
  // and the keys work; nothing asks the conversation routes.
  var CHATLESS = !!byId('fx') && byId('fx').hasAttribute('data-chatless');
  // One pane of a window's (P37.18, assets/frontSplit.ts): its side list is
  // the window's, so it never asks for its own.
  var PANE = !!byId('fx') && byId('fx').getAttribute('data-pane') === '1';
  // The window shows panes: its own view is hidden under them.
  function split() { return !!window.qianmoSplit && window.qianmoSplit.on(); }
  var APPLE = /Mac|iPhone|iPad/.test(navigator.platform || '');
  var HOME = CHAT ? '/app' : '/';
  var LAYOUT_QUERY = CHAT ? 'layout=chat' : '';
  var NARROW = '(max-width: ${FRONT_NARROW_PX}px)';
  var ROUTES = {
    side: '/fragments/chat/front/side',
    view: '/fragments/chat/front/view',
    create: '/v0/chat/sessions',
    work: '/v0/work/sessions',
    stream: '/v0/chat/stream',
    model: '/fragments/providers/chat?target='
  };
  var POLL_MS = 2500;
  var MODEL_REUSE_MS = 30000;
  var STORE = 'qianmo.front.';
  // resident: the thread on screen is the agent's own conversation with the
  // reader (P37.17), addressed by the agent rather than by its id. work: the
  // page is 开始一项工作 (P37.17 B), agent being who does it; flow: the
  // workflow the next line goes with.
  var state = { active: '', agent: '', scope: 'agent', busy: false, resident: false, work: false, flow: '' };
  // The agent whose other conversations the dialog lists (⋯ 其他对话).
  var othersFor = '';
  var mainAgent = '';
  var pollTimer = null;
  var source = null;
  var opened = false;
  var sideTimer = null;
  var viewTimer = null;
  // A stream the hub refused (a restart behind a proxy) is closed for good:
  // it is opened again, later each time, while the polls keep the page up.
  var reopenTimer = null;
  var reopenDelay = 0;
  // The fragments last swapped in and the nodes they became: the same answer
  // again (a 304, a poll, an event that changed nothing shown) is not parsed
  // and swapped in again, which on a long conversation is most of the cost.
  var shownView = null;
  var shownSide = null;
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
  // The front's own title, also when the document came for an area and
  // the settings card is up over it (assets/nav.ts).
  var baseTitle = (byId('settings') && byId('settings').getAttribute('data-work-title')) || document.title;

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
    return !!(window.matchMedia && window.matchMedia(NARROW).matches);
  }

  /* ---------------- fragments ---------------- */

  // Parsed in a detached template - inert, no script runs - and adopted by
  // id. With keep, the thread of the conversation already on screen is
  // brought up to date in place (morph) rather than swapped whole.
  function adopt(html, ids, keep) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    for (var i = 0; i < ids.length; i++) {
      var next = tpl.content.querySelector('#' + ids[i]);
      var current = byId(ids[i]);
      if (!next || !current) continue;
      if (ids[i] !== 'fx-thread') current.replaceWith(next);
      else if (keep && sameThread(current, next)) morph(current, next);
      else { mark(next); current.replaceWith(next); }
    }
  }

  // A thread drawn again is mostly what it was: on a conversation of 280
  // entries, swapping all of it for every step of an answer was the page's
  // whole cost (layout and style of everything, each time). Each entry keeps
  // the markup it came from (qmoSrc); an entry the server draws the same is
  // left where it is, with what the page did to it (its times, its folds),
  // and only the rest goes in.
  function sameThread(current, next) {
    var session = current.getAttribute('data-session') || '';
    return !!session && session === (next.getAttribute('data-session') || '') &&
      !!current.querySelector(':scope > .fx-msgs') && !!next.querySelector(':scope > .fx-msgs');
  }
  function mark(el) {
    for (var i = 0; i < el.children.length; i++) {
      var kid = el.children[i];
      if (kid.classList.contains('fx-msgs')) mark(kid);
      else kid.qmoSrc = kid.outerHTML;
    }
  }
  function morph(live, next) {
    var a;
    for (a = live.attributes.length - 1; a >= 0; a--) {
      if (!next.hasAttribute(live.attributes[a].name)) live.removeAttribute(live.attributes[a].name);
    }
    for (a = 0; a < next.attributes.length; a++) {
      var at = next.attributes[a];
      if (live.getAttribute(at.name) !== at.value) live.setAttribute(at.name, at.value);
    }
    var have = {};
    var oldList = null;
    for (var i = 0; i < live.children.length; i++) {
      var old = live.children[i];
      if (old.classList.contains('fx-msgs')) oldList = old;
      else if (old.qmoSrc) (have[old.qmoSrc] = have[old.qmoSrc] || []).push(old);
    }
    var kids = Array.prototype.slice.call(next.children);
    var want = [];
    for (var k = 0; k < kids.length; k++) {
      var kid = kids[k];
      if (oldList && kid.classList.contains('fx-msgs')) { morph(oldList, kid); want.push(oldList); continue; }
      if (kid.classList.contains('fx-msgs')) { mark(kid); want.push(kid); continue; }
      var src = kid.outerHTML;
      var same = have[src] && have[src].shift();
      if (same) want.push(same);
      else { kid.qmoSrc = src; want.push(kid); }
    }
    for (var w = 0; w < want.length; w++) {
      if (live.children[w] !== want[w]) live.insertBefore(want[w], live.children[w] || null);
    }
    while (live.children.length > want.length) live.removeChild(live.lastElementChild);
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

  // An agent's view is its resident conversation when the reader has one
  // (P37.17): opening it is a reading like opening one by id.
  // The new work page reads nothing: it is never an opening.
  function viewUrl(opening) {
    var query = [];
    var path = ROUTES.view;
    if (state.active) path += '/' + encodeURIComponent(state.active);
    else if (state.work) query.push('work=new');
    if (!state.active && state.agent) query.push('agent=' + encodeURIComponent(state.agent));
    if (opening && (state.active || (state.agent && !state.work))) query.push('open=1');
    if (LAYOUT_QUERY) query.push(LAYOUT_QUERY);
    return path + (query.length ? '?' + query.join('&') : '');
  }

  // opening marks the fetch that is somebody switching to a conversation: the
  // server writes a ledger line for it (P15.9), and never for a refresh.
  function refreshView(opening, toBottom) {
    if (CHATLESS || split() || qc.isExpired()) return Promise.resolve();
    var seq = ++viewSeq;
    var scroller = byId('fx-scroll');
    var stick = toBottom === true || atBottom(scroller);
    var before = replyCount();
    var figure = figureIn('fx-head');
    return qc.loadHtml(viewUrl(opening)).then(function (html) {
      if (seq !== viewSeq || qc.isExpired()) return false;
      // Only a refresh in the background: an opening, a send or a retry
      // (toBottom) redraws whatever came back.
      if (!opening && toBottom !== true && shownView && shownView.html === html &&
          shownView.thread === byId('fx-thread')) {
        stopRetry();
        return true;
      }
      var was = threadState();
      adopt(html, ['fx-head', 'fx-thread', 'fx-activity'], !opening);
      shownView = { html: html, thread: byId('fx-thread') };
      stopRetry();
      keepFigure(figure);
      if (!opening) easeRedraw(was);
      keepUnsent();
      keepChoices(byId('fx-thread'));
      keepChoices(byId('fx-activity'));
      var thread = byId('fx-thread');
      var target = thread ? thread.getAttribute('data-target') : '';
      if (target) state.agent = target;
      state.work = !state.active && !!thread && thread.getAttribute('data-new-work') === '1';
      // An agent's view came back as its resident conversation: from here
      // on it is that session, refreshed and sent to by its id.
      var shown = thread ? thread.getAttribute('data-session') || '' : '';
      if (!state.active && shown) state.active = shown;
      state.resident = !!thread && thread.getAttribute('data-resident') === '1';
      // Opened by its id and found to be the agent's own: addressed by the agent.
      if (opening && state.resident) setAddress(true);
      if (!opening && replyCount() > before) announce();
      paint();
      stampTimers();
      if (stick && scroller) scroller.scrollTop = scroller.scrollHeight;
      updateJump();
      askModel();
      document.dispatchEvent(new CustomEvent('qianmo:front-view'));
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
    prev.qmoSrc = next.qmoSrc;
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
    if (CHATLESS || PANE || qc.isExpired()) return Promise.resolve();
    var seq = ++sideSeq;
    var query = [];
    if (state.agent) query.push('agent=' + encodeURIComponent(state.agent));
    if (state.active) query.push('active=' + encodeURIComponent(state.active));
    if (LAYOUT_QUERY) query.push(LAYOUT_QUERY);
    var scroller = byId('fx-side-scroll');
    var top = scroller ? scroller.scrollTop : 0;
    var list = document.querySelector('#fx-history .fx-hist-list');
    var listTop = list ? list.scrollTop : 0;
    return qc.loadHtml(ROUTES.side + (query.length ? '?' + query.join('&') : '')).then(function (html) {
      if (seq !== sideSeq || qc.isExpired()) return;
      if (shownSide && shownSide.html === html && shownSide.stack === byId('fx-stack')) {
        markCurrent();
        return;
      }
      // A menu, the agent picker or the 其他对话 dialog somebody has open is
      // not swapped out from under the pointer.
      var ids = ['fx-stack'];
      if (!document.querySelector('#fx-agents .fx-more[open]')) ids.push('fx-agents');
      if (!document.querySelector('#fx-recents .fx-more[open]')) ids.push('fx-recents');
      var others = byId('fx-others');
      if (!others || !others.open) ids.push('fx-history');
      var picker = byId('fx-agent-menu');
      if (!picker || picker.hidden) ids.push('fx-agent-menu');
      adopt(html, ids);
      // Kept only when all of it went in: a part held back for an open menu
      // comes in with the next answer, the same or not.
      shownSide = ids.length === 5 ? { html: html, stack: byId('fx-stack') } : null;
      regroup();
      keepChoices(byId('fx-agents'));
      keepChoices(byId('fx-stack'));
      if (scroller) scroller.scrollTop = top;
      var after = document.querySelector('#fx-history .fx-hist-list');
      if (after) after.scrollTop = listTop;
      markCurrent();
      applyHistory();
      applyAgents();
      paintPicker();
      // The approval poll marks a work session that waits on the reader (等你).
      document.dispatchEvent(new CustomEvent('qianmo:front-side'));
    });
  }

  function soonSide() {
    if (sideTimer || qc.isExpired()) return;
    sideTimer = setTimeout(function () { sideTimer = null; refreshSide(); }, 350);
  }

  // The stream's events for the conversation on screen, a few to a step:
  // one read for the lot.
  function soonView() {
    if (viewTimer || qc.isExpired()) return;
    viewTimer = setTimeout(function () { viewTimer = null; refreshView(false); }, 150);
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
    // 模型 and 权限模式 act on the conversation open here (frontTools.ts);
    // /app's agent picker is how a held welcome gets an agent it can start.
    var picks = document.querySelectorAll('.fx-pick-btn:not(#fx-agent-btn)');
    for (var i = 0; i < picks.length; i++) picks[i].disabled = !live;
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
    // Not the reader's own conversation with its agent: read here (P37.17).
    var readOnly = thread.getAttribute('data-readonly') === '1';
    var name = agentName();
    setComposer((open && !readOnly) || start);
    var box = byId('fx-text');
    if (box) {
      box.setAttribute('placeholder', readOnly
        ? tx('readOnly', '只读')
        : state.work && start ? tx('newWorkPlaceholder', '描述要做的事')
        : open || start ? tx('messageTo', '发消息给 ') + name : tx('unavailable', '暂不可对话'));
    }
    markCurrent();
    paintGreeting();
    paintPicker();
    paintFlow();
    paintComputer();
    paintModes();
  }

  // The greeting over a new conversation, by the reader's own clock: the
  // server drew it by its own.
  function paintGreeting() {
    var line = document.querySelector('#fx-thread [data-greet]');
    var list = words.greetings;
    if (!line || !list || !list.length) return;
    var hour = new Date().getHours();
    var said = list[hour >= 5 && hour < 12 ? 0 : hour >= 12 && hour < 18 ? 1 : 2];
    if (typeof said === 'string' && line.textContent !== said) line.textContent = said;
  }

  // The agent picker: over /app's new conversation and, as 由谁来做, the new
  // work page of either face (P37.17 B), holding the agent it goes to - the
  // figure and the name copied from its menu row.
  function paintPicker() {
    var pick = byId('fx-agent-pick');
    if (!pick) return;
    var thread = byId('fx-thread');
    pick.hidden = !(thread && thread.getAttribute('data-welcome') === '1' && (CHAT || state.work));
    var rows = document.querySelectorAll('#fx-agent-menu [data-agent-pick]');
    var chosen = null;
    for (var i = 0; i < rows.length; i++) {
      var on = rows[i].getAttribute('data-agent-pick') === state.agent;
      rows[i].setAttribute('aria-checked', on ? 'true' : 'false');
      if (on) chosen = rows[i];
    }
    var face = byId('fx-agent-face');
    var name = byId('fx-agent-name');
    if (!chosen || !face || !name) return;
    var figure = chosen.querySelector('.avatar');
    var shown = face.querySelector('.avatar');
    if (figure && (!shown || shown.getAttribute('data-face') !== figure.getAttribute('data-face'))) {
      var copy = figure.cloneNode(true);
      copy.setAttribute('width', '18');
      copy.setAttribute('height', '18');
      while (face.firstChild) face.removeChild(face.firstChild);
      face.appendChild(copy);
    }
    name.textContent = chosen.getAttribute('data-name') || '';
  }

  // 云端电脑 in use: the conversation on screen has its agent working a
  // computer or a browser right now (the live line's kind, view/front.ts).
  function paintComputer() {
    var mark = byId('fx-computer');
    if (mark) mark.hidden = !document.querySelector('#fx-thread .fx-typing[data-kind="screen"]');
  }

  // 对话 · 智能体 carries the conversation on screen across.
  function paintModes() {
    var links = document.querySelectorAll('.fx-mode-item[data-mode]');
    for (var i = 0; i < links.length; i++) {
      var to = links[i].getAttribute('data-mode') === 'chat' ? '/app' : '/';
      links[i].setAttribute('href', to + addressQuery());
    }
  }

  // Where the conversation on screen lives (P37.17): an agent's own
  // conversation by the agent (nothing for the main agent's), any other by
  // its id.
  function addressQuery() {
    if (state.active && !state.resident) return '?session=' + encodeURIComponent(state.active);
    if (state.work) return '?work=new';
    return state.agent && state.agent !== mainAgent ? '?agent=' + encodeURIComponent(state.agent) : '';
  }

  function markCurrent() {
    var start = byId('fx-new-work');
    if (start) {
      if (state.work && !state.active) start.setAttribute('aria-current', 'true');
      else start.removeAttribute('aria-current');
    }
    // The new work page and a work session are no agent's row (P37.17 B).
    var thread = byId('fx-thread');
    var working = state.work || (!!thread && thread.getAttribute('data-work') === '1');
    var rows = document.querySelectorAll('#fx-agents .fx-agent-row');
    for (var i = 0; i < rows.length; i++) {
      var here = !working && rows[i].getAttribute('data-address') === state.agent;
      rows[i].classList.toggle('is-current', here);
      var button = rows[i].querySelector('.fx-agent');
      if (button) {
        if (here) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      }
    }
    var recents = document.querySelectorAll('#fx-recents .fx-ritem-row');
    for (var r = 0; r < recents.length; r++) {
      var current = !!state.active && recents[r].getAttribute('data-session') === state.active;
      recents[r].classList.toggle('is-current', current);
      var open = recents[r].querySelector('.fx-ritem');
      if (open) {
        if (current) open.setAttribute('aria-current', 'true');
        else open.removeAttribute('aria-current');
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
  // On screen: the open conversation, or with panes up one of theirs.
  function onScreen(id) { return split() ? window.qianmoSplit.shows(id) : id === state.active && showsState(); }
  function seenOf(key) {
    if (Object.prototype.hasOwnProperty.call(seenHere, key)) return seenHere[key];
    var kept = stored(key);
    return kept === null ? null : Number(kept) || 0;
  }
  function markSeen(key, at) {
    seenHere[key] = at;
    keep(key, String(at));
  }
  // In the desktop app, an answer that lands out of sight is a system
  // notification (assets/frontShell.ts): a row that moved since this page
  // last drew it, that no longer waits for an answer, while the window is
  // not in front or shows another conversation. A row seen for the first
  // time is never news.
  var drawnAt = {};
  function noteMoved(key, updated, waiting, title, body, session) {
    var before = Object.prototype.hasOwnProperty.call(drawnAt, key) ? drawnAt[key] : null;
    drawnAt[key] = updated;
    if (before === null || !(updated > before) || waiting || !window.qianmoShell) return;
    var away = document.hidden || !document.hasFocus() || !session || !onScreen(session);
    if (away) window.qianmoShell.notify(title, body, session);
  }

  // /app's rows are conversations: one is unread when it moved after this
  // browser last had it on screen.
  function markUnreadSessions() {
    var rows = document.querySelectorAll('#fx-recents .fx-ritem-row');
    var count = 0;
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].getAttribute('data-session') || '';
      var updated = Number(rows[i].getAttribute('data-updated')) || 0;
      var key = 'seen.s.' + id;
      var seen = seenOf(key);
      var here = !!id && onScreen(id) && !document.hidden;
      if (updated && (here || seen === null)) { markSeen(key, updated); seen = updated; }
      var unread = !!updated && updated > (seen || 0);
      rows[i].classList.toggle('is-unread', unread);
      if (unread) count++;
      noteMoved(key, updated, rows[i].getAttribute('data-running') === '1',
        rows[i].getAttribute('data-agent') || '', rows[i].getAttribute('data-preview') || '', id);
    }
    return count;
  }

  function markUnread() {
    var count = markUnreadSessions();
    var rows = document.querySelectorAll('#fx-agents .fx-agent-row');
    for (var i = 0; i < rows.length; i++) {
      var address = rows[i].getAttribute('data-address') || '';
      var updated = Number(rows[i].getAttribute('data-updated')) || 0;
      var latest = rows[i].getAttribute('data-latest') || '';
      var key = 'seen.' + address;
      var seen = seenOf(key);
      var here = !!latest && onScreen(latest) && !document.hidden;
      if (updated && (here || seen === null)) { markSeen(key, updated); seen = updated; }
      var unread = !!updated && updated > (seen || 0);
      rows[i].classList.toggle('is-unread', unread);
      if (unread) count++;
      var name = rows[i].querySelector('.fx-agent-name');
      var said = rows[i].querySelector('.fx-agent-sub');
      noteMoved(key, updated, rows[i].classList.contains('is-busy'),
        name ? name.textContent : '', said ? said.textContent : '', latest);
    }
    // The card names its area in the title while it is up.
    if (!(byId('settings') && byId('settings').open)) document.title = count ? '(' + count + ') ' + baseTitle : baseTitle;
    if (window.qianmoShell) window.qianmoShell.badge(count);
  }

  // /app's list, by the reader's calendar: each row goes to its day's
  // group by the reader's own midnight (the server grouped by its own).
  function dayGroupOf(at, now) {
    var midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    var before = function (days) {
      var day = new Date(midnight.getTime());
      day.setDate(day.getDate() - days);
      return day.getTime();
    };
    if (at >= midnight.getTime()) return 'today';
    if (at >= before(1)) return 'yesterday';
    if (at >= before(7)) return 'week';
    return 'older';
  }
  function regroup() {
    var section = byId('fx-recents');
    if (!section) return;
    var now = Date.now();
    var groups = {};
    var list = section.querySelectorAll('.fx-rgroup');
    for (var g = 0; g < list.length; g++) groups[list[g].getAttribute('data-group')] = list[g];
    var rows = section.querySelectorAll('.fx-ritem-row');
    var homes = [];
    var moved = false;
    for (var i = 0; i < rows.length; i++) {
      homes.push(groups[dayGroupOf(Number(rows[i].getAttribute('data-updated')) || 0, now)] || null);
      if (homes[i] && rows[i].parentElement !== homes[i]) moved = true;
    }
    // The rows are newest first in the document: put back in that order,
    // each group stays newest first. Nothing moves when nothing has to (a
    // moved row would lose the focus).
    if (moved) {
      for (var j = 0; j < rows.length; j++) if (homes[j]) homes[j].appendChild(rows[j]);
    }
    applyRecents();
  }

  // The search over the conversations by day: titles and agents' names.
  // How many rows it leaves, out of how many.
  function applyRecents() {
    var section = byId('fx-recents');
    if (!section) return [0, 0];
    var search = byId('fx-search');
    var q = search ? search.value.trim().toLowerCase() : '';
    var rows = section.querySelectorAll('.fx-ritem-row');
    var shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var text = (rows[i].querySelector('.fx-ritem-title') || rows[i]).textContent + ' ' + (rows[i].getAttribute('data-agent') || '');
      rows[i].hidden = !!q && text.toLowerCase().indexOf(q) < 0;
      if (!rows[i].hidden) shown++;
    }
    var groups = section.querySelectorAll('.fx-rgroup');
    for (var g = 0; g < groups.length; g++) {
      groups[g].hidden = !groups[g].querySelector('.fx-ritem-row:not([hidden])');
    }
    return [shown, rows.length];
  }

  // The search over the agents and the conversations under them: one line
  // when it leaves nothing in either.
  function applyAgents() {
    var works = applyRecents();
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
    if (none) none.hidden = !(q && rows.length + works[1] && !(shown + works[0]));
  }

  // 其他对话 (P37.17): the agent whose ⋯ opened the dialog, or all.
  function applyHistory() {
    var section = byId('fx-history');
    if (!section) return;
    var agent = othersFor || state.agent;
    section.setAttribute('data-scope', state.scope);
    var toggles = section.querySelectorAll('[data-action="fx-scope"]');
    for (var t = 0; t < toggles.length; t++) {
      toggles[t].setAttribute('aria-pressed', toggles[t].getAttribute('data-scope') === state.scope ? 'true' : 'false');
    }
    var items = section.querySelectorAll('.fx-hitem');
    var mine = 0;
    for (var i = 0; i < items.length; i++) {
      var target = items[i].getAttribute('data-target');
      if (target === agent) mine++;
      items[i].hidden = !(state.scope === 'all' || !agent || target === agent);
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
    empty('agent', state.scope === 'agent' && items.length > 0 && mine === 0 && !!agent);
  }

  function announce() {
    var line = byId('reply-announcement');
    var replies = document.querySelectorAll('#fx-thread .fx-msg-agent:not(.fx-pending)');
    var last = replies.length ? replies[replies.length - 1].querySelector('.fx-text, .fx-pre') : null;
    if (line) line.textContent = tx('newReply', '收到新回复 · ') + (last ? last.textContent.slice(0, 240) : tx('seeChat', '回到对话查看'));
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
    // The node's models, for the 模型 picker to list (frontTools.ts).
    var shelf = byId('fx-model-data');
    if (shelf) shelf.textContent = '';
    if (!slot || !thread || !model.html || thread.getAttribute('data-target') !== model.target) return;
    var tpl = document.createElement('template');
    tpl.innerHTML = model.html;
    var label = tpl.content.querySelector('#prov-chat-label');
    // /app's head chip names the model too, as text.
    var chip = byId('fx-chip-model');
    if (chip) chip.textContent = label ? label.textContent.trim() : '';
    if (label) slot.appendChild(label);
    var models = tpl.content.querySelector('#prov-chat-models');
    if (models && shelf) shelf.appendChild(models);
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

  // The settings card is up (assets/nav.ts): the address is the card's.
  function carded() {
    var card = byId('settings');
    return !!card && card.open;
  }

  function setAddress(replace) {
    if (carded()) return;
    var url = HOME + addressQuery();
    try {
      var entry = { active: state.resident ? '' : state.active, agent: state.agent, work: state.work && !state.active };
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
        var first = document.querySelector('#fx-side .fx-agent') || byId('fx-search');
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
    var wide = window.matchMedia(NARROW);
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
  // A view on its way: the thread dims and a thin line runs under the bar,
  // both only after a moment (view/frontStyle.ts), so a quick switch shows
  // neither.
  function busyView(on) {
    var main = byId('fx-main');
    if (!main) return;
    if (on) main.setAttribute('aria-busy', 'true');
    else main.removeAttribute('aria-busy');
  }

  function go(opening) {
    if (CHATLESS) return Promise.resolve();
    nav++;
    var mine = nav;
    switching = true;
    stopRetry();
    setComposer(false);
    markCurrent();
    applyHistory();
    say(byId('fx-status'), '', 'muted');
    soonSide();
    busyView(true);
    // Unheld when this fetch settles, drawn or not; the composer itself waits
    // for the thread on screen to be this conversation (showsState), which a
    // fetch that was overtaken leaves to the one that overtook it.
    return refreshView(opening, true).then(function () {
      if (mine !== nav) return;
      switching = false;
      busyView(false);
      paint();
      if (showsState()) focusBox();
    }, function (err) {
      if (mine !== nav) return;
      switching = false;
      busyView(false);
      paint();
      say(byId('fx-status'), failText('open', err), qc.failTone(err));
    });
  }

  // An agent: the server answers with the reader's one conversation with it,
  // or its welcome before the first line (P37.17).
  function selectAgent(address) {
    setDrawer(false);
    closeMenus();
    closeOthers();
    if (!address) return;
    if (address === state.agent && state.resident && !switching && showsState()) { focusBox(); return; }
    state.active = '';
    state.resident = false;
    state.work = false;
    state.agent = address;
    setAddress(false);
    go(true);
  }

  // A row opens its agent's conversation, the way a chat app opens a
  // contact: the agent reads as one running thread.
  function pickAgent(el) {
    selectAgent(el.getAttribute('data-address') || '');
  }

  function openSession(id) {
    setDrawer(false);
    closeMenus();
    closeOthers();
    if (!id) return;
    if (id === state.active && !switching && showsState()) { focusBox(); return; }
    state.active = id;
    state.resident = false;
    state.work = false;
    setAddress(false);
    go(true);
  }

  // ⌘N (⌘⇧O in a browser) and the side's row: 开始一项工作 (P37.17 B), the
  // main agent doing it until somebody picks another under 由谁来做.
  function newWork() {
    if (CHATLESS) return;
    setDrawer(false);
    closeMenus();
    closeOthers();
    if (state.work && !state.active && !switching && showsState()) { focusBox(); return; }
    state.active = '';
    state.resident = false;
    state.work = true;
    state.agent = mainAgent || state.agent;
    setAddress(false);
    go(false);
  }

  // ⋯ 其他对话: the dialog of an agent's other conversations, which open
  // read-only.
  function openOthers(address) {
    closeMenus();
    othersFor = address || state.agent;
    state.scope = 'agent';
    applyHistory();
    qc.openDialog('fx-others');
  }
  function closeOthers() {
    var box = byId('fx-others');
    if (box && box.open) box.close();
  }

  window.addEventListener('popstate', function (event) {
    var entry = event.state;
    // The settings card's own moves (assets/nav.ts): the conversation under
    // the card did not change.
    if (CHATLESS || window.location.pathname.indexOf('/admin') === 0 || (entry && entry.qianmoNav)) return;
    if (entry && (entry.active || '') === (state.resident ? '' : state.active) && (entry.agent || state.agent) === state.agent &&
      !!entry.work === (state.work && !state.active)) return;
    if (!entry) {
      var params = new URLSearchParams(window.location.search);
      entry = { active: params.get('session') || '', agent: params.get('agent') || mainAgent, work: params.get('work') === 'new' };
    }
    state.active = entry.active || '';
    state.resident = false;
    state.work = !state.active && !!entry.work;
    state.agent = entry.agent || state.agent;
    go(!state.work);
  });

  /* ---------------- sending ---------------- */

  // The session a send goes to, decided when the send starts: the open one,
  // or the agent's own conversation with the reader (P37.17) - the one they
  // have, which another tab may just have opened, or a new one. A session
  // the person has since moved away from is still the agent's row, not the
  // conversation on screen.
  function ensureSession(pin) {
    if (pin.active) return Promise.resolve({ id: pin.active, fresh: false });
    if (!pin.agent) return Promise.reject({ human: tx('pickAgent', '先选一个智能体') });
    return qc.sendJson('POST', ROUTES.create, { target: pin.agent }).then(function (data) {
      if (!data || !data.id) throw { human: tx('noSession', '没能开出会话') };
      var id = String(data.id);
      if (pin.nav === nav) {
        state.active = id;
        state.resident = true;
        setAddress(true);
      }
      return { id: id, fresh: true };
    });
  }

  // 开始一项工作's first line (P37.17 B): one request opens the work session
  // and sends the line in it, with the workflow and - when somebody else was
  // picked under 由谁来做 - the agent. Opened with the line refused, the
  // session is still the conversation from here on.
  function openWork(pin, text, flow) {
    var body = { text: text };
    if (flow) body.workflow = flow;
    if (pin.agent && pin.agent !== mainAgent) body.agent = pin.agent;
    var adopt = function (id) {
      if (pin.nav !== nav) return;
      state.active = id;
      state.work = false;
      state.resident = false;
      setAddress(true);
    };
    return qc.sendJson('POST', ROUTES.work, body).then(function (data) {
      var id = data && data.session && data.session.id ? String(data.session.id) : '';
      if (!id) throw { human: tx('noSession', '没能开出会话') };
      adopt(id);
      return { id: id, fresh: true };
    }, function (err) {
      var session = err && err.data && err.data.session;
      if (session && session.id) {
        adopt(String(session.id));
        err.opened = { id: String(session.id), fresh: true };
      }
      throw err;
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
    // The agent is still on an earlier line: this one waits for its next step.
    meta.textContent = thread.getAttribute('data-running') === '1'
      ? tx('queuedNext', '排队中 · 下一步时送达')
      : tx('sending', '发送中');
    article.appendChild(bubble);
    article.appendChild(meta);
    list.appendChild(article);
    var scroller = byId('fx-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    return article;
  }

  // Lines that did not go, by conversation: a redraw of that conversation
  // keeps them at its end until they are sent again or the page goes.
  var unsent = [];

  // Drawn the way the server draws a line that was not delivered
  // (is-failed, fx-fail), with 重试 beside the words.
  function unsentLine(line, text, session) {
    line.classList.remove('is-sending');
    line.classList.add('is-failed');
    var meta = line.querySelector('.fx-meta');
    if (meta) {
      meta.textContent = '';
      var words = document.createElement('span');
      words.className = 'fx-fail';
      words.textContent = tx('notDelivered', '未送达');
      meta.appendChild(words);
      var again = document.createElement('button');
      again.type = 'button';
      again.className = 'fx-retry';
      again.textContent = tx('retry', '重试');
      again.addEventListener('click', function () {
        if (state.busy) return;
        unsent = unsent.filter(function (one) { return one.line !== line; });
        line.remove();
        send(text);
      });
      meta.appendChild(again);
    }
    unsent.push({ line: line, session: session });
  }

  function keepUnsent() {
    var thread = byId('fx-thread');
    var list = thread ? thread.querySelector('.fx-msgs') : null;
    if (!list) return;
    var session = thread.getAttribute('data-session') || '';
    for (var i = 0; i < unsent.length; i++) {
      if (unsent[i].session === session && !list.contains(unsent[i].line)) list.appendChild(unsent[i].line);
    }
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
    var ready = !!thread && thread.getAttribute('data-readonly') !== '1' &&
      (thread.getAttribute('data-open') === '1' || thread.getAttribute('data-start') === '1');
    if (!ready) { say(status, tx('unavailable', '暂不可对话'), 'bad'); return; }
    var pin = { nav: nav, agent: state.agent, active: state.active, work: state.work && !state.active };
    var welcome = !pin.active;
    // The workflow goes with this line only, and never with a local command
    // (work-tasks.md §2.2).
    var flow = state.flow && !localCommand(text) ? state.flow : '';
    hideCommands();
    stopVoice();
    state.busy = true;
    if (form) form.setAttribute('aria-busy', 'true');
    var kept = box.value;
    var keptFlow = state.flow;
    if (typeof given !== 'string') box.value = '';
    autosize();
    if (flow) setFlow('');
    var ghost = paintSending(text);
    say(status, '', 'muted');
    play([['thinking', 0]]);
    var opened = null;
    var sent = false;
    var going = pin.work
      ? openWork(pin, text, flow).then(function (session) { opened = session; })
      : ensureSession(pin).then(function (session) {
        opened = session;
        var body = { text: text };
        if (flow) body.workflow = flow;
        return qc.sendJson('POST', ROUTES.create + '/' + encodeURIComponent(session.id) + '/messages', body);
      });
    going.then(function () {
      sent = true;
    }, function (err) {
      // A work that opened and whose first line did not go (work-tasks.md
      // §1.2): its session is the conversation now.
      if (err && err.opened) opened = err.opened;
      if (pin.nav === nav && flow && !state.flow) setFlow(keptFlow);
      // The send itself failed. In a conversation that was already open the
      // line stays where it was, marked 未送达 with 重试 (P37.13, 先改后同步).
      // On a welcome the line replaced, the welcome is drawn again and the
      // text goes back into the box: there is no conversation to keep it in.
      var keepLine = !!ghost && !welcome && pin.nav === nav;
      if (keepLine) unsentLine(ghost, text, pin.active);
      else if (ghost) ghost.remove();
      if (pin.nav === nav) {
        if (!keepLine && typeof given !== 'string' && !box.value) box.value = kept;
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

  // The text's length when the box was last sized. Typing on can only make
  // it taller: one look at whether it overflows. Shorter (a deletion, a value
  // put back) is measured from scratch, which costs two more layouts a key.
  var sizedLength = 0;
  function autosize() {
    var box = byId('fx-text');
    if (!box) return;
    var length = box.value.length;
    // An empty box is one line: its placeholder can wrap while the layout
    // settles, and must never be what sizes it.
    if (!length) box.style.height = '';
    else if (length < sizedLength || !box.style.height) {
      box.style.height = 'auto';
      box.style.height = Math.min(box.scrollHeight, 240) + 'px';
    } else if (box.clientHeight < 240 && box.scrollHeight > box.clientHeight) {
      box.style.height = Math.min(box.scrollHeight, 240) + 'px';
    }
    sizedLength = length;
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
    var count = 0;
    for (var i = 0; i < all.length; i++) {
      all[i].hidden = !offered(all[i]);
      all[i].setAttribute('aria-selected', 'false');
      if (!all[i].hidden) count++;
    }
    list.hidden = !count;
    picked = count ? 0 : -1;
    markPicked();
    var plus = byId('fx-plus');
    if (plus) plus.setAttribute('aria-expanded', count ? 'true' : 'false');
    box.focus();
  }
  // A row the composer may offer now: on the new work page there is no
  // conversation yet, so only the workflows (P37.17 B).
  function offered(row) {
    return !state.work || state.active || row.classList.contains('fx-cmd-flow');
  }
  function showCommands(box) {
    var list = byId('fx-cmds');
    if (!list) return;
    var value = box.value;
    if (value.charAt(0) !== '/' || /\\s/.test(value)) { hideCommands(); return; }
    var all = list.querySelectorAll('.fx-cmd');
    var any = false;
    for (var i = 0; i < all.length; i++) {
      var match = offered(all[i]) && ((all[i].getAttribute('data-cmd') || '').indexOf(value) === 0 ||
        (all[i].getAttribute('data-alt') || '').indexOf(value) === 0);
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
    var flow = row.getAttribute('data-flow');
    // A workflow is not typed: it becomes the chip, and what was typed to
    // find it goes.
    if (flow) {
      if (box.value.charAt(0) === '/' && !/\\s/.test(box.value)) box.value = '';
      setFlow(flow);
    } else box.value = (row.getAttribute('data-cmd') || '') + ' ';
    hideCommands();
    autosize();
    box.focus();
  }

  // Whether a line is one of the console's local commands (/compact and
  // the rest), which never go with a workflow.
  function localCommand(text) {
    var match = /^\\/([a-z-]+)/.exec(text);
    return !!match && !!document.querySelector('#fx-cmds .fx-cmd:not(.fx-cmd-flow)[data-cmd="/' + match[1] + '"]');
  }

  /* ---------------- the workflow (P37.17 B) ---------------- */

  // The chip in the composer says which workflow the next line goes with;
  // the new work page's cards and the / menu set it, its x clears it.
  function setFlow(id) {
    state.flow = id && document.querySelector('#fx-cmds [data-flow="' + id + '"]') ? id : '';
    paintFlow();
  }
  function paintFlow() {
    var chip = byId('fx-flow-chip');
    var flow = state.flow;
    if (chip) {
      chip.hidden = !flow;
      chip.setAttribute('data-flow', flow);
      var option = flow ? document.querySelector('#fx-cmds [data-flow="' + flow + '"]') : null;
      var name = byId('fx-flow-chip-name');
      var said = option ? option.querySelector('span') : null;
      if (name) name.textContent = said ? said.textContent : '';
      var mark = byId('fx-flow-chip-mark');
      var glyph = option ? option.querySelector('svg') : null;
      if (mark && (!glyph || !mark.firstChild || mark.getAttribute('data-flow') !== flow)) {
        while (mark.firstChild) mark.removeChild(mark.firstChild);
        if (glyph) mark.appendChild(glyph.cloneNode(true));
        mark.setAttribute('data-flow', flow);
      }
    }
    var cards = document.querySelectorAll('#fx-thread .fx-flow[data-workflow]');
    for (var i = 0; i < cards.length; i++) {
      cards[i].setAttribute('aria-pressed', cards[i].getAttribute('data-workflow') === flow ? 'true' : 'false');
    }
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
    try { source = window.qianmoSplit ? window.qianmoSplit.stream(ROUTES.stream) : new EventSource(ROUTES.stream); }
    catch (e) { startPolling(tx('polling', '轮询中')); return; }
    source.addEventListener('open', function () {
      var resync = !!pollTimer || opened;
      reopenDelay = 0;
      stopPolling();
      say(byId('fx-live'), '', 'muted');
      // A reconnect may have missed events while it was down: catch up once.
      if (resync) refreshAll();
      opened = true;
    });
    source.addEventListener('chat', function (event) {
      var payload = null;
      try { payload = JSON.parse(event.data); } catch (e) { payload = null; }
      if (payload && payload.sessionId && payload.sessionId === state.active) soonView();
      soonSide();
    });
    var mine = source;
    source.addEventListener('error', function () {
      startPolling(tx('polling', '轮询中'));
      // Not 200: the browser gave up on it (readyState 2). A pane's stream
      // is the window's (qianmoSplit) and never ends up here.
      if (mine !== source || mine.readyState !== 2 || reopenTimer || qc.isExpired()) return;
      reopenDelay = Math.min(reopenDelay ? reopenDelay * 2 : 5000, 60000);
      reopenTimer = setTimeout(function () {
        reopenTimer = null;
        if (mine === source && !qc.isExpired()) startStream();
      }, reopenDelay);
    });
  }

  /* ---------------- wiring ---------------- */

  qc.onExpire(function () {
    if (source) { source.close(); source = null; }
    stopPolling();
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (sideTimer) { clearTimeout(sideTimer); sideTimer = null; }
    if (viewTimer) { clearTimeout(viewTimer); viewTimer = null; }
    if (reopenTimer) { clearTimeout(reopenTimer); reopenTimer = null; }
    if (settle) { clearTimeout(settle); settle = null; }
    stopRetry();
    viewSeq++;
    sideSeq++;
    say(byId('fx-live'), tx('disconnected', '已断开'), 'muted');
  });

  qc.onAction('fx-agent', function (el) { pickAgent(el); });
  qc.onAction('fx-new-work', function () { newWork(); });
  qc.onAction('fx-flow', function (el) {
    var id = el.getAttribute('data-workflow') || '';
    setFlow(state.flow === id ? '' : id);
    focusBox();
  });
  qc.onAction('fx-flow-clear', function () { setFlow(''); focusBox(); });
  qc.onAction('fx-others', function (el) { openOthers(el.getAttribute('data-address') || ''); });
  qc.onAction('fx-open', function (el) { openSession(el.getAttribute('data-session') || ''); });
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
  function toggleSide(open) {
    var root = byId('fx');
    if (!root) return;
    if (narrow()) { setDrawer(open === undefined ? root.getAttribute('data-drawer') !== 'open' : open); return; }
    var closed = root.getAttribute('data-side') === 'closed';
    var next = open === undefined ? closed : open;
    root.setAttribute('data-side', next ? 'open' : 'closed');
    keep('side', next ? 'open' : 'closed');
  }
  qc.onAction('fx-side', function () { toggleSide(); });

  // ⌘K: the search, with the side list brought into view first.
  function focusSearch() {
    var search = byId('fx-search');
    if (!search) return;
    toggleSide(true);
    search.focus();
    search.select();
  }
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
    // A worker's conversation from the panel opens here, in /app's face.
    var worker = CHAT ? target.closest('a.fx-task-open') : null;
    if (worker && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      var id = new URL(worker.href, window.location.href).searchParams.get('session') || '';
      if (id) { event.preventDefault(); openSession(id); return; }
    }
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
      newWork();
      return;
    }
    // The front's shortcuts (qmo-app.md §4.4), ⌘ on a Mac and Ctrl elsewhere;
    // an open dialog keeps the keys.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.isComposing && !document.querySelector('dialog[open]')) {
      var key = String(event.key || '').toLowerCase();
      if (!event.shiftKey && key === 'n') { event.preventDefault(); newWork(); return; }
      if (!event.shiftKey && key === 'k') { event.preventDefault(); focusSearch(); return; }
      if (event.shiftKey && key === 's') { event.preventDefault(); toggleSide(); return; }
      // ⌘B (Ctrl B elsewhere; ⌃B on a Mac stays the text box's).
      if (!event.shiftKey && key === 'b' && (APPLE ? event.metaKey : event.ctrlKey)) { event.preventDefault(); toggleSide(); return; }
      if (!event.shiftKey && (key === '.' || event.code === 'Period')) {
        event.preventDefault();
        var panel = byId('fx-panel-toggle');
        if (panel) panel.click();
        return;
      }
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
    else if (target.id === 'fx-search') applyAgents();
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !qc.isExpired()) { markUnread(); refreshAll(); }
  });
  // Back online (assets/frontShell.ts): catch up on what was missed.
  document.addEventListener('qianmo:online', function () {
    if (!qc.isExpired()) refreshAll();
  });
  // The thread's live line decides the computer's mark; a refresh may change it.
  document.addEventListener('qianmo:front-view', paintComputer);

  function start() {
    var thread = byId('fx-thread');
    state.active = (thread && thread.getAttribute('data-session')) || '';
    state.agent = (thread && thread.getAttribute('data-target')) || '';
    state.resident = !!thread && thread.getAttribute('data-resident') === '1';
    state.work = !state.active && !!thread && thread.getAttribute('data-new-work') === '1';
    var mainRow = document.querySelector('#fx-agents .fx-agent-main');
    var mainPick = document.querySelector('#fx-agent-menu [data-main]');
    mainAgent = mainRow ? mainRow.getAttribute('data-address') || ''
      : mainPick ? mainPick.getAttribute('data-agent-pick') || '' : '';
    state.scope = stored('scope') === 'all' ? 'all' : 'agent';
    var root = byId('fx');
    if (root && stored('side') === 'closed' && !narrow()) root.setAttribute('data-side', 'closed');
    // Under the settings card (an area's address, or an error drawn in it)
    // the entry is the card's (assets/nav.ts).
    if (!carded()) {
      try {
        history.replaceState({ active: state.resident ? '' : state.active, agent: state.agent, work: state.work }, '', window.location.pathname + window.location.search);
      } catch (e) { /* cosmetic */ }
    }
    var mic = byId('fx-mic');
    if (mic && Recognition) mic.hidden = false;
    markAccent();
    regroup();
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
    if (CHATLESS) return;
    focusBox();
    askModel();
    qc.afterSession(startStream);
  }

  // The composer's pickers send a pick as a line of the conversation, the
  // way it would be typed; the model label is asked again after it.
  window.qianmoFront = {
    send: function (text) {
      send(text);
      model.at = 0;
    },
    // The agent picker (frontTools.ts): the agent a new conversation goes to
    // on /app; on the new work page, who does it - the page stays.
    pickAgent: function (address) {
      if (!address) return;
      if (state.work && !state.active) {
        state.agent = address;
        paintPicker();
        focusBox();
        return;
      }
      if (state.active || address !== state.agent) selectAgent(address);
      else paintPicker();
    },
    // What the panes ask of this page (assets/frontSplit.ts): show a pane's
    // conversation here (agent=, session=, work=new, or the main agent's),
    // say which one is here, and the side list's two keys.
    open: function (query) {
      var params = new URLSearchParams(String(query || ''));
      if (params.get('work') === 'new') { newWork(); return; }
      var id = params.get('session') || '';
      state.active = id;
      state.resident = false;
      state.work = false;
      if (!id) state.agent = params.get('agent') || mainAgent;
      setAddress(true);
      go(true);
    },
    where: function () { return addressQuery().slice(1); },
    side: function () { toggleSide(); },
    search: function () { focusSearch(); }
  };

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
