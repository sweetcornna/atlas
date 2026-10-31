// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How Code draws a local session's records in the page (`qmo-local.md`
 * §4.5.5). A local session lives on this computer, not on the hub, so there
 * is no server fragment to fetch; and no string of markup is ever put into
 * the page either. Everything here builds nodes with `createElement` and
 * text with `createTextNode` / `textContent`.
 *
 * `richText` is `view/richText.ts` carried over rule for rule — fenced code,
 * inline code, one level of list, bold, paragraphs; no links, images, tables,
 * nested lists or raw HTML; an unpaired backtick or `**` stays as it was.
 * The server escapes first and parses after; here the same decisions are
 * made on the raw text, which gives the same structure because escaping
 * never adds or removes a backtick, an asterisk, a newline or a space. What
 * the server's markup would lose on its way through the HTML parser — a
 * carriage return turned into a newline, a NUL dropped — is done to each
 * text node, so the two serialize to the same string
 * (`test/browser/codeRender.browser.test.ts`).
 *
 * The record shapes follow `view/front.ts` (`userTurn`, `agentTurn`,
 * `stepGroup`, `pendingTail`, `divider`) with the front's classes, so the
 * front's sheet draws them. What is new is a tool line's `+a −r` and its
 * diff, and the ask card. Icons are the server's own SVG, cloned from
 * `<template id="code-icons">` (`view/frontCode.ts`).
 *
 * It hangs one object on `window.qianmoCode` for `CODE_JS` and nothing else.
 */

import { stripJsLineComments } from './client.js'

function renderScript(): string {
  return `
(function () {
  'use strict';

  var doc = document;
  var tx = function () { return ''; };
  function w(key) { return tx(key, ''); }
  var PAUSE_MS = 10 * 60 * 1000;

  function el(tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  // What the HTML parser does to the server's text on its way in.
  function clean(text) { return String(text).replace(/\\r\\n?/g, '\\n').replace(/\\u0000/g, ''); }
  function put(parent, text) {
    var value = clean(text);
    if (value) parent.appendChild(doc.createTextNode(value));
    return parent;
  }
  function icon(name) {
    var box = doc.getElementById('code-icons');
    var found = box && box.content ? box.content.querySelector('[data-i="' + name + '"]') : null;
    return found && found.firstElementChild ? found.firstElementChild.cloneNode(true) : doc.createTextNode('');
  }

  // ---- the markdown subset (view/richText.ts) ----

  function bold(parent, text) {
    var pattern = /\\*\\*(?!\\s)([^*\\n]+?)\\*\\*/g;
    var at = 0;
    var match;
    while ((match = pattern.exec(text)) !== null) {
      put(parent, text.slice(at, match.index));
      parent.appendChild(put(el('b'), match[1]));
      at = pattern.lastIndex;
    }
    put(parent, text.slice(at));
  }
  // A code span ends at its line; a lone backtick is a backtick.
  function inline(parent, text) {
    var rest = text;
    while (rest.length > 0) {
      var open = rest.indexOf('\\x60');
      if (open === -1) { bold(parent, rest); break; }
      var close = rest.indexOf('\\x60', open + 1);
      var newline = rest.indexOf('\\n', open + 1);
      if (close === -1 || (newline !== -1 && newline < close)) {
        bold(parent, rest.slice(0, open + 1));
        rest = rest.slice(open + 1);
        continue;
      }
      if (open > 0) bold(parent, rest.slice(0, open));
      parent.appendChild(put(el('code', 'mono'), rest.slice(open + 1, close)));
      rest = rest.slice(close + 1);
    }
  }
  function isFence(line) { return /^\\s*\\x60\\x60\\x60/.test(line); }

  function richText(parent, text) {
    var lines = String(text).split('\\n');
    var paragraph = [];
    var items = [];
    var drawn = false;
    function flushParagraph() {
      if (!paragraph.length) return;
      var body = paragraph.join('\\n').trim();
      paragraph = [];
      if (!body) return;
      var p = el('p', 'turn-p');
      inline(p, body);
      parent.appendChild(p);
      drawn = true;
    }
    function flushList() {
      if (!items.length) return;
      var list = el('ul', 'turn-list');
      for (var k = 0; k < items.length; k++) {
        var li = el('li');
        inline(li, items[k]);
        list.appendChild(li);
      }
      parent.appendChild(list);
      items = [];
      drawn = true;
    }
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (isFence(line)) {
        flushParagraph();
        flushList();
        var body = [];
        i += 1;
        while (i < lines.length && !isFence(lines[i])) { body.push(lines[i]); i += 1; }
        i += 1;
        var pre = el('pre', 'turn-code');
        pre.appendChild(put(el('code'), body.join('\\n')));
        parent.appendChild(pre);
        drawn = true;
        continue;
      }
      var item = /^\\s{0,3}[-*]\\s+(.*)$/.exec(line);
      if (item) { flushParagraph(); items.push(item[1] || ''); i += 1; continue; }
      if (line.trim() === '') { flushParagraph(); flushList(); i += 1; continue; }
      flushList();
      paragraph.push(line);
      i += 1;
    }
    flushParagraph();
    flushList();
    if (!drawn) parent.appendChild(el('p', 'turn-empty', '（空）'));
    return parent;
  }

  // The answer still arriving, redrawn as it grows (at most once a frame).
  // What ends at a blank line outside a fence is drawn once and kept; only
  // the rest is drawn again. A blank line closes a paragraph and a list, so
  // the pieces come out as richText would draw the whole.
  function grow(parent, text) {
    var st = parent.qmoGrow;
    if (!st || text.length < st.text.length || text.slice(0, st.text.length) !== st.text) {
      while (parent.firstChild) parent.removeChild(parent.firstChild);
      st = parent.qmoGrow = { text: '', scan: 0, fence: false, cut: 0, kept: 0, tail: [] };
    }
    st.text = text;
    var at = st.scan;
    var end;
    while ((end = text.indexOf('\\n', at)) !== -1) {
      var line = text.slice(at, end);
      if (isFence(line)) st.fence = !st.fence;
      else if (!st.fence && line.trim() === '') st.cut = end + 1;
      at = end + 1;
    }
    st.scan = at;
    for (var i = 0; i < st.tail.length; i++) parent.removeChild(st.tail[i]);
    var done = text.slice(st.kept, st.cut);
    if (done.trim()) richText(parent, done);
    st.kept = st.cut;
    var box = doc.createDocumentFragment();
    var rest = text.slice(st.cut);
    if (rest.trim() || !parent.firstChild) richText(box, rest);
    st.tail = Array.prototype.slice.call(box.childNodes);
    parent.appendChild(box);
    return parent;
  }

  // ---- pieces ----

  function lang() { return doc.documentElement.lang || 'zh-CN'; }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function clock(at) { var d = new Date(at); return two(d.getHours()) + ':' + two(d.getMinutes()); }
  function when(at, cls) { return el('time', cls || 'fx-when', clock(at)); }
  function button(cls, text, action) {
    var b = el('button', cls, text);
    b.type = 'button';
    b.setAttribute('data-action', action);
    return b;
  }
  function elapsed(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }

  // A pause longer than ten minutes: the time, centred; the date too on a new day.
  function sep(at, before) {
    var box = el('div', 'fx-sep');
    box.setAttribute('role', 'separator');
    var t = when(at, 'fx-sep-time');
    if (before === undefined || new Date(before).toDateString() !== new Date(at).toDateString()) {
      try { t.textContent = new Date(at).toLocaleDateString(lang(), { month: 'short', day: 'numeric' }) + ' ' + clock(at); }
      catch (e) { /* the clock alone */ }
    }
    box.appendChild(t);
    return box;
  }
  function pauses(at, before) { return before === undefined || at - before > PAUSE_MS; }

  // +a −r of a tool that changed a file.
  function stat(added, removed) {
    var box = el('span', 'fx-stat');
    if (typeof added === 'number') box.appendChild(el('span', 'fx-add', '+' + added));
    if (typeof removed === 'number') box.appendChild(el('span', 'fx-del', '\\u2212' + removed));
    return box;
  }

  // A unified diff, a class on each added, removed and hunk line; no highlighting.
  function diff(parent, text) {
    var lines = clean(text).split('\\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var cls = /^@@/.test(line) ? 'fx-diff-hunk' :
        /^\\+(?!\\+\\+ )/.test(line) ? 'fx-diff-add' :
        /^-(?!-- )/.test(line) ? 'fx-diff-del' : 'fx-diff-ctx';
      parent.appendChild(el('span', cls, line === '' ? ' ' : line));
    }
    return parent;
  }

  // ---- records ----

  // A person's line. how: 'sending' | 'queued' | 'unsent' | 'failed' (not delivered), and last.
  function user(turn, how, last) {
    var article = el('article', 'fx-msg fx-msg-user' + (how === 'failed' ? ' is-failed' : '') +
      (how === 'sending' ? ' is-sending' : '') + (how === 'queued' ? ' is-queued' : '') + (last ? ' is-last' : ''));
    article.appendChild(richText(el('div', 'fx-bubble'), turn.text || ''));
    var meta = el('div', 'fx-meta');
    var more = el('span', 'fx-meta-more');
    more.appendChild(when(turn.at || Date.now()));
    meta.appendChild(more);
    var note = { sending: 'sending', queued: 'queued', unsent: 'notSent', failed: 'notDelivered' }[how];
    if (note) meta.appendChild(el('span', how === 'unsent' || how === 'failed' ? 'fx-fail' : 'fx-queued', w(note)));
    if (how === 'failed') meta.appendChild(button('fx-retry', w('retry'), 'code-retry'));
    article.appendChild(meta);
    return article;
  }

  // The agent's answer; live while it is still arriving.
  function agent(turn, live) {
    var failed = turn.state === 'failed';
    var article = el('article', 'fx-msg fx-msg-agent' + (failed ? ' is-failed' : '') + (live ? ' is-live' : ''));
    var body = el('div', 'fx-msg-body');
    var bubble = el('div', 'fx-bubble fx-bubble-agent');
    bubble.appendChild(richText(el('div', 'fx-text'), turn.text || ''));
    body.appendChild(bubble);
    if (!live) {
      var meta = el('div', 'fx-meta');
      if (failed) meta.appendChild(el('span', 'fx-fail', w('failed')));
      var more = el('span', 'fx-meta-more');
      more.appendChild(when(turn.at));
      meta.appendChild(more);
      var copy = button('fx-mini', null, 'fx-copy-turn');
      copy.setAttribute('aria-label', w('copy'));
      copy.appendChild(icon('copy'));
      meta.appendChild(copy);
      body.appendChild(meta);
    }
    article.appendChild(body);
    return article;
  }

  // An ask still waiting for the person: a card, not a step.
  function asking(turn) { return !!(turn && turn.ask && typeof turn.ask === 'object' && !turn.ask.decision); }

  function decided(ask) {
    if (ask.decision === 'deny') return w('denied');
    if (ask.decision === 'session') return w('allowedAll');
    return w('allowed');
  }

  // One process line: a tool, an answered ask, or a note from the runner.
  function step(turn) {
    var tool = turn.tool && typeof turn.tool === 'object' ? turn.tool : null;
    var ask = turn.ask && typeof turn.ask === 'object' ? turn.ask : null;
    var status = tool ? tool.status : '';
    var severity = status === 'failed' ? 'error' : status === 'denied' || (ask && ask.decision === 'deny') ? 'warn' :
      (turn.severity === 'warn' || turn.severity === 'error' ? turn.severity : 'info');
    var li = el('li', 'fx-step fx-step-' + severity);
    var mark = el('span', 'fx-step-mark');
    if (status === 'running') mark.appendChild(el('span', 'fx-spin'));
    else mark.appendChild(icon(severity === 'error' ? 'x' : severity === 'warn' ? 'alert-triangle' : 'check'));
    li.appendChild(mark);
    var body = el('div', 'fx-step-body');
    var line = el('div', 'fx-step-line');
    var words = String(ask ? (ask.title || turn.text || '') : (turn.text || ''));
    if (ask) words += ' \\u00b7 ' + decided(ask);
    line.appendChild(el('span', 'fx-step-text', words));
    if (tool && (typeof tool.added === 'number' || typeof tool.removed === 'number')) line.appendChild(stat(tool.added, tool.removed));
    line.appendChild(when(turn.at));
    body.appendChild(line);
    if (typeof turn.detail === 'string' && turn.detail) {
      var more = el('details', 'fx-step-detail');
      var summary = el('summary');
      summary.appendChild(icon('chev'));
      summary.appendChild(doc.createTextNode(w('details')));
      more.appendChild(summary);
      var pre = el('pre', 'fx-pre fx-pre-quiet');
      if (tool && tool.detailKind === 'diff') { pre.className += ' fx-diff'; diff(pre, turn.detail); }
      else put(pre, turn.detail);
      more.appendChild(pre);
      body.appendChild(more);
    }
    li.appendChild(body);
    return li;
  }

  // A run of steps folded into one line: how many, and the last one.
  function steps(key) {
    var box = el('details', 'fx-steps');
    box.setAttribute('data-key', key);
    var head = el('summary', 'fx-steps-head');
    head.appendChild(icon('list-checks'));
    var label = el('span', 'fx-steps-label');
    var last = el('span', 'fx-steps-last');
    head.appendChild(label);
    head.appendChild(last);
    head.appendChild(icon('chev'));
    box.appendChild(head);
    var list = el('ol', 'fx-step-list');
    box.appendChild(list);
    var drawn = '';
    return {
      el: box,
      list: list,
      // count, the last step's words, whether the turn still runs, and the worst severity;
      // written only when one of them changed (this runs on every frame of an answer).
      label: function (count, words, running, worst) {
        var sig = count + '|' + running + '|' + worst + '|' + words;
        if (sig === drawn) return;
        drawn = sig;
        label.textContent = w(running ? 'doing' : 'done').replace('{n}', String(count)).replace('{s}', count === 1 ? '' : 's');
        last.textContent = words;
        box.className = 'fx-steps fx-steps-' + worst + (running ? ' is-running' : '');
      }
    };
  }

  // What the agent waits for: its words, where, and three answers. Enter
  // approves nothing; the focus goes to 允许一次 (CODE_JS).
  function ask(turn) {
    var info = turn.ask;
    var card = el('div', 'fx-perm');
    card.setAttribute('role', 'group');
    card.setAttribute('data-ask', String(info.id || ''));
    var title = String(info.title || turn.text || info.tool || '');
    card.setAttribute('aria-label', title);
    var head = el('div', 'fx-perm-head');
    head.appendChild(icon('alert-triangle'));
    head.appendChild(el('span', 'fx-perm-title', title));
    if (info.tool && info.tool !== title) head.appendChild(el('span', 'fx-perm-tool mono', info.tool));
    card.appendChild(head);
    var paths = Array.isArray(info.paths) ? info.paths : [];
    if (paths.length) {
      var list = el('ul', 'fx-perm-paths');
      for (var i = 0; i < paths.length && i < 20; i++) list.appendChild(el('li', 'mono', paths[i]));
      card.appendChild(list);
    }
    if (typeof info.input === 'string' && info.input) card.appendChild(put(el('pre', 'fx-pre fx-pre-quiet'), info.input));
    var options = Array.isArray(info.options) ? info.options : ['once', 'session', 'deny'];
    var acts = el('div', 'fx-perm-acts');
    function answer(cls, words, decision) {
      var b = acts.appendChild(button('btn btn-small ' + cls, words, decision ? 'code-ask' : 'code-deny'));
      if (decision) b.setAttribute('data-decision', decision);
      return b;
    }
    answer('btn-primary fx-perm-once', w('once'), 'once');
    if (options.indexOf('session') !== -1) answer('btn-secondary', w('always'), 'session');
    answer('btn-ghost', w('deny'), '').setAttribute('aria-expanded', 'false');
    card.appendChild(acts);
    var note = el('div', 'fx-perm-note');
    note.hidden = true;
    var input = el('input', 'input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = w('note');
    input.setAttribute('aria-label', w('note'));
    note.appendChild(input);
    note.appendChild(button('btn btn-secondary btn-small', w('deny'), 'code-ask')).setAttribute('data-decision', 'deny');
    card.appendChild(note);
    var say = el('p', 'fx-perm-say');
    say.setAttribute('role', 'status');
    card.appendChild(say);
    return card;
  }

  // The live status line: the wave, what the agent is doing, for how long.
  function pending() {
    var box = el('div', 'fx-msg fx-msg-agent fx-pending');
    box.setAttribute('role', 'status');
    var body = el('div', 'fx-msg-body');
    var line = el('div', 'fx-typing');
    var slot = el('span', 'fx-act-slot');
    var dots = el('span', 'fx-live-dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.appendChild(el('i'));
    dots.appendChild(el('i'));
    dots.appendChild(el('i'));
    slot.appendChild(dots);
    line.appendChild(slot);
    line.appendChild(el('span', 'fx-typing-word', w('thinking')));
    line.appendChild(el('span', 'fx-typing-time', '0s'));
    body.appendChild(line);
    box.appendChild(body);
    return box;
  }

  window.qianmoCode = {
    words: function (lookup) { tx = lookup; },
    el: el,
    icon: icon,
    richText: richText,
    grow: grow,
    diff: diff,
    stat: stat,
    clock: clock,
    elapsed: elapsed,
    sep: sep,
    pauses: pauses,
    user: user,
    agent: agent,
    asking: asking,
    step: step,
    steps: steps,
    ask: ask,
    pending: pending
  };
})();
`
}

/** Code's record and rich-text drawing, ahead of `CODE_JS` in `/code`. */
export const CODE_RENDER_JS = stripJsLineComments(renderScript())
