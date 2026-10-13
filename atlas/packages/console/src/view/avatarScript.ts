// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The 形象 editor's page script (`view/avatar.ts`, `routes/avatars.ts`).
 *
 * Every pick asks the server to draw the editor again for the figure the
 * picks make (`/fragments/avatar?spec=`), so the stage and every thumbnail
 * are always the server's drawing: this script only reads radio values and
 * puts a fragment where the editor is. A slower answer to an older pick is
 * dropped, so a quick run of clicks ends on the last one.
 */

export const AVATAR_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var form = byId('avatar-form');
  if (!form) return;

  // The dialog says in which language it was drawn and carries the script's
  // words for it (view/avatar.ts); without them, 简体中文.
  var dialog = byId('avatar-dialog');
  var lang = dialog ? dialog.getAttribute('data-lang') || 'zh-CN' : 'zh-CN';
  var words = {};
  try { words = JSON.parse(dialog ? dialog.getAttribute('data-text') || '{}' : '{}') || {}; } catch (e) { words = {}; }
  function tx(key, fallback) { return typeof words[key] === 'string' ? words[key] : fallback; }
  function failText(key, verb, err) {
    if (typeof words[key] !== 'string') return qc.failLine(verb, err);
    var detail = err && (err.human || err.message) ? String(err.human || err.message) : '';
    return words[key] + (detail ? ' · ' + detail : '');
  }

  var FIELDS = ['shape', 'color', 'material', 'eyes', 'mouth', 'accessory'];
  var editing = null;
  var seq = 0;
  // 恢复默认 and nothing picked since: saving forgets the saved figure
  // rather than saving a copy of today's default.
  var backToDefault = false;
  // The state being previewed on the stage, kept across redraws.
  var previewState = 'idle';

  function showState() {
    var figure = byId('avatar-editor').querySelector('.av-stage-figure');
    if (figure) figure.setAttribute('data-state', previewState);
    var chips = byId('avatar-editor').querySelectorAll('[data-action="avatar-state"]');
    for (var i = 0; i < chips.length; i++) {
      chips[i].setAttribute('aria-pressed', String(chips[i].getAttribute('data-state') === previewState));
    }
  }

  function specOf() {
    var root = byId('avatar-editor').querySelector('.av-editor');
    var spec = {};
    try { spec = JSON.parse(root ? root.getAttribute('data-spec') || '{}' : '{}'); } catch (e) { spec = {}; }
    for (var i = 0; i < FIELDS.length; i++) {
      var el = form.querySelector('input[name="' + FIELDS[i] + '"]:checked');
      if (el) spec[FIELDS[i]] = el.value;
    }
    var cheeks = form.querySelector('input[name="cheeks"]:checked');
    if (cheeks) spec.cheeks = cheeks.value === 'on';
    return spec;
  }

  function load(query, focusName) {
    var mine = ++seq;
    var url = '/fragments/avatar?key=' + encodeURIComponent(editing.key) + '&lang=' + encodeURIComponent(lang) + query;
    return qc.loadHtml(url).then(function (html) {
      if (mine !== seq) return;
      var editor = byId('avatar-editor');
      var groups = editor.querySelector('.av-groups');
      var top = groups ? groups.scrollTop : 0;
      editor.innerHTML = html;
      groups = editor.querySelector('.av-groups');
      if (groups) groups.scrollTop = top;
      showState();
      if (focusName) {
        var el = form.querySelector('input[name="' + focusName + '"]:checked');
        if (el) el.focus({ preventScroll: true });
      }
    }).catch(function (err) {
      qc.say(byId('avatar-status'), failText('loadFailed', '加载形象', err), qc.failTone(err));
    });
  }

  function draft(spec) {
    return '&spec=' + encodeURIComponent(JSON.stringify(spec));
  }

  qc.onAction('avatar-edit', function (button) {
    editing = {
      key: button.getAttribute('data-key') || '',
      name: button.getAttribute('data-name') || ''
    };
    backToDefault = false;
    previewState = 'idle';
    qc.setText('avatar-who', editing.name === '我' ? tx('mine', '我的形象') : tx('whose', '{name} 的形象').replace('{name}', editing.name));
    qc.say(byId('avatar-status'), '', 'muted');
    load('', null).then(function () { qc.openDialog('avatar-dialog', null); });
  });

  form.addEventListener('change', function (event) {
    var name = event.target && event.target.name;
    if (!name || !editing) return;
    backToDefault = false;
    load(draft(specOf()), name);
  });

  function values(name) {
    var out = [];
    var nodes = form.querySelectorAll('input[name="' + name + '"]');
    for (var i = 0; i < nodes.length; i++) out.push(nodes[i].value);
    return out;
  }

  qc.onAction('avatar-state', function (button) {
    previewState = button.getAttribute('data-state') || 'idle';
    showState();
  });

  // The figure greeting an empty page is pleased to be pointed at. Enter
  // and leave of the figure itself (captured, they do not bubble), so moving
  // across its parts is not a hundred greetings.
  function greet(on) {
    return function (event) {
      var host = event.target;
      if (!host || !host.classList || !host.classList.contains('chat-greet-figure')) return;
      var figure = host.querySelector('.avatar');
      if (!figure) return;
      if (on && figure.getAttribute('data-state') === 'idle') figure.setAttribute('data-state', 'happy');
      if (!on && figure.getAttribute('data-state') === 'happy') figure.setAttribute('data-state', 'idle');
    };
  }
  document.addEventListener('pointerenter', greet(true), true);
  document.addEventListener('pointerleave', greet(false), true);

  qc.onAction('avatar-random', function () {
    if (!editing) return;
    var spec = {};
    for (var i = 0; i < FIELDS.length; i++) {
      var list = values(FIELDS[i]);
      spec[FIELDS[i]] = list[Math.floor(Math.random() * list.length)];
    }
    spec.cheeks = Math.random() < 0.5;
    backToDefault = false;
    load(draft(spec), null);
  });

  qc.onAction('avatar-default', function () {
    if (!editing) return;
    backToDefault = true;
    load('&default=1', null);
  });

  qc.onSubmit('avatar-form', function () {
    if (!editing) return;
    var status = byId('avatar-status');
    var url = '/v0/avatars/' + encodeURIComponent(editing.key);
    qc.say(status, tx('saving', '保存中'), 'muted');
    var sent = backToDefault ? qc.sendJson('DELETE', url) : qc.sendJson('PUT', url, specOf());
    sent.then(function () {
      qc.closeDialog(byId('avatar-dialog'));
      qc.toast(tx('saved', '形象已更新'), 'ok');
      // The greeting on an empty page is outside every refreshed pane, and
      // a page with nothing open has no draft to lose.
      var empty = document.querySelector('.thread-empty');
      if (empty || editing.key.indexOf('user:') === 0 && !document.querySelector('.thread')) {
        window.location.reload();
        return;
      }
      document.dispatchEvent(new CustomEvent('qianmo:faces'));
    }).catch(function (err) {
      qc.say(status, failText('saveFailed', '保存', err), qc.failTone(err));
    });
  });
})();
`
