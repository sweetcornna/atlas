// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `/chat` page's script, on top of the shared runtime (`client.ts`).
 *
 * The token, the transport and the console header are the runtime's; this file
 * holds what only the conversation face does. Same permissions as the runtime,
 * no more:
 *
 * 1. Fetch server-rendered fragments and put them on the page. `innerHTML` is
 *    assigned exactly two things, both of them markup the view layer escaped on
 *    the way out (`view/chat.ts`).
 * 2. `POST` JSON. Every response string — including every error — reaches the
 *    page through `textContent`.
 *
 * Token storage has exactly one home, the runtime, so the personal-credential
 * guards (`tenancy-m1.md` §3.3) cover this page without a second copy.
 *
 * ## Switching sessions is a swap, not a navigation
 *
 * Opening a conversation replaces the sessions rail and the thread fragment
 * and rewrites the address bar with `history.replaceState`, instead of
 * navigating to `/chat?session=<id>`: a top-level navigation carries no
 * `Authorization` header, and by the time a session could be switched the
 * token has already been scrubbed out of the address bar, so navigating
 * there would 401 on arrival. See `openSession` for the mechanics. The server
 * renders the whole page only on first entry, or whenever a link naming
 * `?session=` is opened directly.
 *
 * ## The stream, and what happens when it is not there
 *
 * `GET /v0/chat/stream` is an `EventSource`. `EventSource` cannot send headers,
 * so the token rides on the query string — the second position `auth.ts`
 * already accepts, and the reason it accepts it. Every event is a bare
 * `{sessionId, revision}`; the page answers it by refetching the fragments,
 * which keeps "the server renders HTML, the client renders text" true on the
 * streaming face too.
 *
 * When the stream cannot be opened — no `EventSource`, a proxy that buffers, a
 * server that dropped it — the page falls back to polling the same two
 * fragments every two seconds and says so beside the rail. The fallback is not
 * a degraded mode nobody tests: it is the only path when the browser is old,
 * and `?stream=off` forces it for exactly that reason.
 */

function chatScript(): string {
  return `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var say = qc.say;

  var ROUTES = {
    sessions: '/fragments/chat/sessions',
    thread: '/fragments/chat/thread/',
    create: '/v0/chat/sessions',
    stream: '/v0/chat/stream'
  };
  var POLL_MS = 2000;
  var pollTimer = null;
  var source = null;
  var active = '';
  var busy = false;

  /* ---------------- fragments ---------------- */

  // The composer is not inside either fragment, so the two facts it shows -
  // which agent, and whether that agent is reachable - are copied off the
  // freshly rendered thread as text, never re-derived here.
  function paintComposer() {
    var thread = byId('chat-thread');
    var target = byId('composer-target');
    var text = byId('composer-state-text');
    var dot = byId('composer-dot');
    if (!thread) return;
    if (target) target.textContent = thread.getAttribute('data-target') || '—';
    if (text) text.textContent = thread.getAttribute('data-state') || '';
    if (dot) dot.className = 'dot dot-' + (thread.getAttribute('data-tone') || 'muted');
  }

  function atBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  // opening marks the one fetch that is somebody switching to a
  // conversation rather than a refresh of the one already open: the server
  // writes a ledger line for it (P15.9), and never for a poll.
  function refreshThread(keepScroll, opening) {
    var mount = byId('thread-mount');
    if (!mount || !active) return Promise.resolve();
    var stick = keepScroll === false ? true : atBottom(mount);
    var url = ROUTES.thread + encodeURIComponent(active) + (opening ? '?open=1' : '');
    return qc.loadHtml(url).then(function (html) {
      mount.innerHTML = html;
      paintComposer();
      if (stick) mount.scrollTop = mount.scrollHeight;
    });
  }

  function refreshSessions() {
    var mount = byId('chat-sessions');
    if (!mount) return Promise.resolve();
    var picker = byId('chat-target');
    var chosen = picker ? picker.value : '';
    var url = ROUTES.sessions + (active ? '?active=' + encodeURIComponent(active) : '');
    return qc.loadHtml(url).then(function (html) {
      var current = byId('chat-sessions');
      if (!current) return;
      // Parsed in a detached template - inert, no script execution - and then
      // adopted, the same swap the runtime uses for the audit regions.
      var tpl = document.createElement('template');
      tpl.innerHTML = html;
      var next = tpl.content.querySelector('#chat-sessions');
      if (!next) return;
      current.replaceWith(next);
      // Restore whatever target was picked: the rail is replaced on every
      // event, and a picker that resets itself under the cursor is a picker
      // that opens a conversation with the wrong agent.
      var picked = byId('chat-target');
      if (picked && chosen) picked.value = chosen;
    });
  }

  function refreshAll(keepScroll, opening) {
    return Promise.all([refreshThread(keepScroll, opening), refreshSessions()]);
  }

  /* ---------------- actions ---------------- */

  function setComposerEnabled(on) {
    var box = byId('chat-text');
    var send = byId('chat-send');
    var why = byId('composer-why');
    if (box) box.disabled = !on;
    if (send) send.disabled = !on;
    if (why) why.hidden = on;
  }

  // Switching conversations swaps the two fragments and rewrites the address
  // bar. It deliberately does NOT navigate: on a Bearer session a top-level
  // navigation to /chat?session=... carries no Authorization header, so it
  // would 401 the moment the token was scrubbed out of the URL - which is the
  // first thing the runtime does on arrival. A cookie session would survive
  // the navigation, but a swap that works for one credential and reloads the
  // whole document for the other is two behaviours to keep true; everything
  // after the first load goes through fetch.
  function openSession(id) {
    if (!id || id === active) return;
    active = id;
    try {
      history.replaceState(null, '', '/chat?session=' + encodeURIComponent(id));
    } catch (e) { /* the address bar is cosmetic; the state is in the variable */ }
    setComposerEnabled(true);
    say(byId('chat-status'), '', 'muted');
    refreshAll(false, true).then(function () {
      var box = byId('chat-text');
      if (box) box.focus();
    });
  }

  function newSession() {
    var picker = byId('chat-target');
    var status = byId('chat-status');
    var target = picker ? picker.value : '';
    if (!target) { say(status, '先选一个智能体', 'bad'); return; }
    say(status, '新建会话…', 'muted');
    qc.sendJson('POST', ROUTES.create, { target: target }).then(function (data) {
      if (data && data.id) openSession(String(data.id));
      else say(status, '新建失败 · 服务端没有返回会话', 'bad');
    }).catch(function (err) {
      say(status, qc.failLine('新建', err), qc.failTone(err));
      qc.toast(qc.failLine('新建', err), qc.failTone(err));
    });
  }

  function send() {
    var box = byId('chat-text');
    var status = byId('chat-status');
    if (!box || busy) return;
    var text = box.value.trim();
    if (!text) return;
    if (!active) { say(status, '先选一条会话', 'bad'); return; }
    busy = true;
    box.disabled = true;
    say(status, '发送中…', 'muted');
    qc.sendJson('POST', ROUTES.create + '/' + encodeURIComponent(active) + '/messages',
      { text: text }
    ).then(function () {
      box.value = '';
      autosize();
      say(status, '', 'muted');
      return refreshAll(false);
    }).catch(function (err) {
      say(status, qc.failLine('发送', err), qc.failTone(err));
      qc.toast(qc.failLine('发送', err), qc.failTone(err));
    }).then(function () {
      busy = false;
      box.disabled = false;
      box.focus();
    });
  }

  /* ---------------- stream ---------------- */

  function startPolling(reason) {
    if (pollTimer || qc.isExpired()) return;
    say(byId('stream-state'), reason, 'muted');
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
    // EventSource cannot carry a header, and the token no longer rides in
    // its URL (H5): it opens on the session cookie, which the runtime has
    // already exchanged any token this page was handed for (afterSession).
    try { source = new EventSource(ROUTES.stream); }
    catch (e) { startPolling('轮询中'); return; }

    source.addEventListener('open', function () {
      stopPolling();
      say(byId('stream-state'), '实时', 'ok');
    });
    source.addEventListener('chat', function (event) {
      var payload = null;
      try { payload = JSON.parse(event.data); } catch (e) { payload = null; }
      // A session other than the open one still moves the rail: its preview
      // and its "3 分钟前" are what tell the operator to go and look.
      if (payload && payload.sessionId && payload.sessionId !== active) {
        refreshSessions();
        return;
      }
      refreshAll();
    });
    source.addEventListener('error', function () {
      // EventSource retries on its own; the poller covers the gap and is
      // stopped again by the next 'open'. A 401 is not retried by the
      // browser, and the poller's first fetch is what turns it into the
      // expiry dialog.
      startPolling('轮询中 · 实时连接中断');
    });
  }

  /* ---------------- composer behaviour ---------------- */

  function autosize() {
    var box = byId('chat-text');
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, 220) + 'px';
  }

  /* ---------------- wiring ---------------- */

  // A 401 anywhere ends the stream and the fallback poller with the rest
  // of the page (the runtime's C1 note).
  qc.onExpire(function () {
    if (source) { source.close(); source = null; }
    stopPolling();
    say(byId('stream-state'), '已断开', 'muted');
  });

  qc.onAction('chat-open', function (el) { openSession(el.getAttribute('data-session') || ''); });
  qc.onAction('chat-new', function () { newSession(); });
  qc.onSubmit('composer', function () { send(); });

  document.addEventListener('keydown', function (event) {
    if (event.target && event.target.id === 'chat-text') {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
      }
    }
  });

  document.addEventListener('input', function (event) {
    if (event.target && event.target.id === 'chat-text') autosize();
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !qc.isExpired()) refreshAll();
  });

  function start() {
    active = new URLSearchParams(window.location.search).get('session') || '';
    paintComposer();
    autosize();
    // The server already decided this on the first render; re-asserting it here
    // keeps one rule ("a session is open") rather than two that can disagree.
    setComposerEnabled(byId('chat-thread') !== null &&
      byId('chat-thread').getAttribute('data-session') !== null);
    var mount = byId('thread-mount');
    if (mount) mount.scrollTop = mount.scrollHeight;
    var box = byId('chat-text');
    if (box && !box.disabled) box.focus();
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

/** The conversation face's page script. One variant: tokens are the runtime's. */
export const CONSOLE_CHAT_JS = chatScript()
