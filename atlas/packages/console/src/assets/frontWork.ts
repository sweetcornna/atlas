// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The files of 广泛性工作 in the browser (P37.17 B, `view/frontWork.ts`).
 *
 * - **预览** opens the preview over the page: the file's name, 下载, and a
 *   frame made now — an empty `sandbox`, no referrer — on the preview's
 *   address; closing the dialog takes the frame out, so nothing keeps
 *   loading behind it and the page holds no frame otherwise.
 * - **产出** in the activity panel starts as the files the hub saw delivered;
 *   while the panel is open on a work session the page asks the outputs
 *   folder (`GET /v0/work/sessions/<id>/outputs`, `work-tasks.md` §4.2) and
 *   shows what it lists, newest first. Asked again when the conversation is
 *   redrawn with a new delivery, and every few seconds while the work runs;
 *   a session that cannot list (an older node, the link down) keeps the
 *   delivered files and is not asked again for a while. A row for a file no
 *   delivery carried is cloned from the document's template and filled as
 *   text.
 */

import { stripJsLineComments } from './client.js'

function workScript(): string {
  return `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var AGAIN_MS = 15000;
  // The last listing: which session, when it was asked, what it said (null
  // when it could not be listed), and which deliveries it had seen.
  var listed = { session: '', at: 0, files: null, seen: '' };
  var asking = '';
  var timer = null;

  function baseName(name) { return name.slice(name.lastIndexOf('/') + 1); }
  function fileUrl(session, name, view) {
    return '/v0/work/sessions/' + encodeURIComponent(session) + '/' + view + '?name=' + encodeURIComponent(name);
  }
  // Binary units, as the server writes them (view/format.ts formatBytes).
  function size(bytes) {
    var units = ['B', 'KiB', 'MiB', 'GiB'];
    var value = Math.max(0, Number(bytes) || 0);
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    var rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
    return (rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1)) + ' ' + units[unit];
  }

  /* ---------------- 预览 ---------------- */

  function dropFrame() {
    var body = byId('fx-preview-body');
    while (body && body.firstChild) body.removeChild(body.firstChild);
  }

  qc.onAction('fx-preview', function (el) {
    var session = el.getAttribute('data-session') || '';
    var name = el.getAttribute('data-name') || '';
    var body = byId('fx-preview-body');
    if (!session || !name || !body || !byId('fx-preview')) return;
    var title = byId('fx-preview-title');
    if (title) title.textContent = el.getAttribute('data-title') || baseName(name);
    var download = byId('fx-preview-download');
    if (download) {
      download.setAttribute('href', fileUrl(session, name, 'file'));
      download.setAttribute('download', baseName(name));
    }
    dropFrame();
    var frame = document.createElement('iframe');
    frame.className = 'fx-preview-frame';
    frame.id = 'fx-preview-frame';
    frame.setAttribute('sandbox', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', body.getAttribute('data-frame-title') || '');
    frame.setAttribute('src', fileUrl(session, name, 'preview'));
    body.appendChild(frame);
    qc.openDialog('fx-preview');
  });
  document.addEventListener('close', function (event) {
    if (event.target && event.target.id === 'fx-preview') dropFrame();
  }, true);

  /* ---------------- 产出 ---------------- */

  function panelOpen() {
    var root = byId('fx');
    return !!root && root.getAttribute('data-panel') === 'open';
  }
  function shownSession() {
    var box = byId('fx-activity');
    return box && !box.hidden ? box.getAttribute('data-session') || '' : '';
  }
  // The deliveries the server drew, as one string to compare.
  function delivered() {
    var rows = document.querySelectorAll('#fx-outputs[data-from="delivered"] .fx-file[data-name]');
    var names = [];
    for (var i = 0; i < rows.length; i++) names.push(rows[i].getAttribute('data-name'));
    return names.join('\\n');
  }

  function rowFor(session, file) {
    var tpl = byId('fx-file-tpl');
    if (!tpl || !tpl.content) return null;
    var proto = tpl.content.querySelector('.fx-file');
    var kind = String(file.kind).replace(/[^a-z]/g, '');
    var mark = tpl.content.querySelector('[data-kind-mark="' + kind + '"]') ||
      tpl.content.querySelector('[data-kind-mark="other"]');
    if (!proto || !mark) return null;
    var row = proto.cloneNode(true);
    var name = String(file.name);
    var shown = baseName(name);
    row.setAttribute('data-kind', mark.getAttribute('data-kind-mark') || 'other');
    row.setAttribute('data-name', name);
    var glyph = row.querySelector('.fx-file-mark');
    if (glyph && mark.firstElementChild) glyph.appendChild(mark.firstElementChild.cloneNode(true));
    var label = row.querySelector('.fx-file-name');
    if (label) { label.textContent = shown; label.setAttribute('title', name); }
    var meta = row.querySelector('.fx-file-meta');
    if (meta) meta.textContent = (mark.getAttribute('data-kind-word') || '') + ' · ' + size(file.size);
    var preview = row.querySelector('[data-action="fx-preview"]');
    var link = row.querySelector('a.fx-file-act');
    var note = row.querySelector('.fx-file-note');
    if (file.tooLarge === true) {
      if (preview) preview.remove();
      if (link) link.remove();
      if (note) note.hidden = false;
      return row;
    }
    if (note) note.remove();
    if (preview && file.preview !== true) preview.remove();
    else if (preview) {
      preview.setAttribute('data-session', session);
      preview.setAttribute('data-name', name);
      preview.setAttribute('data-title', shown);
      preview.setAttribute('aria-label', (preview.getAttribute('data-word') || '') + ' · ' + shown);
    }
    if (link) {
      link.setAttribute('href', fileUrl(session, name, 'file'));
      link.setAttribute('download', shown);
      link.setAttribute('aria-label', (link.getAttribute('data-word') || '') + ' · ' + shown);
    }
    return row;
  }

  // The folder's list in place of the deliveries: a delivered file keeps its
  // row (and the agent's title for it), anything else gets a new one, and a
  // delivered file the folder no longer has goes.
  function apply(session, files) {
    var list = byId('fx-outputs');
    if (!list || shownSession() !== session) return;
    var kept = {};
    var rows = list.querySelectorAll('.fx-file[data-name]');
    for (var i = 0; i < rows.length; i++) kept[rows[i].getAttribute('data-name')] = rows[i];
    var empty = list.querySelector('.fx-panel-empty');
    var order = [];
    for (var j = 0; j < files.length; j++) {
      var file = files[j];
      if (!file || typeof file.name !== 'string') continue;
      var row = kept[file.name] && file.tooLarge !== true ? kept[file.name] : rowFor(session, file);
      if (kept[file.name] === row) delete kept[file.name];
      if (row) order.push(row);
    }
    for (var name in kept) if (Object.prototype.hasOwnProperty.call(kept, name)) kept[name].remove();
    for (var k = 0; k < order.length; k++) {
      if (list.children[k] !== order[k]) list.insertBefore(order[k], list.children[k] || empty);
    }
    if (empty) empty.hidden = order.length > 0;
    list.setAttribute('data-from', 'outputs');
  }

  function refresh(force) {
    var session = shownSession();
    if (!session || !panelOpen() || qc.isExpired()) return;
    var same = listed.session === session;
    var seen = delivered();
    if (same && listed.files) apply(session, listed.files);
    var stale = !same || Date.now() - listed.at >= AGAIN_MS || (seen !== '' && seen !== listed.seen);
    if ((!force && !stale) || asking === session) return;
    asking = session;
    var at = Date.now();
    qc.sendJson('GET', '/v0/work/sessions/' + encodeURIComponent(session) + '/outputs').then(function (data) {
      var files = data && Array.isArray(data.files) ? data.files : null;
      listed = { session: session, at: at, files: files, seen: seen };
      if (files) apply(session, files);
    }, function () {
      listed = { session: session, at: at, files: null, seen: seen };
    }).then(function () { asking = ''; });
  }

  // While the work runs and the panel is open, the folder is looked at again
  // now and then: a file can be written without being delivered yet.
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      var thread = byId('fx-thread');
      if (!document.hidden && thread && thread.getAttribute('data-running') === '1') refresh(false);
      schedule();
    }, AGAIN_MS);
  }

  document.addEventListener('qianmo:front-view', function () { refresh(false); });
  document.addEventListener('qianmo:front-panel', function () { refresh(false); });
  qc.onExpire(function () { if (timer) clearTimeout(timer); timer = null; });

  function start() {
    refresh(false);
    schedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
`
}

/** The script of a work session's files, after the panel's (`view/front.ts`). */
export const FRONT_WORK_JS = stripJsLineComments(workScript())
