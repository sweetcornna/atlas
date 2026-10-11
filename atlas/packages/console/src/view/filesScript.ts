// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 文件互通's script (`view/files.ts`). Approving opens a small form (the
 * scope may widen to a directory, the grant has a lifetime); denying and
 * revoking ask first. Starting a transfer collects one or more sources —
 * more than one is a gathering into the target — and each source can look
 * into its agent's workspace through `/v0/files/browse`.
 */

export const FILES_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var MAX_SOURCES = 8;

  function refresh() {
    var mount = byId('files');
    return mount ? qc.refreshRegion(mount) : Promise.resolve();
  }

  function parentOf(path) {
    var cut = path.lastIndexOf('/');
    return cut <= 0 ? '' : path.slice(0, cut);
  }

  function joinPath(dir, name) {
    return dir ? dir.replace(/\\/+$/, '') + '/' + name : name;
  }

  function bytes(n) {
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB'];
    var v = n / 1024;
    var u = 0;
    while (v >= 1024 && u < units.length - 1) { v = v / 1024; u++; }
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[u];
  }

  function addressParts(address) {
    var m = /^qianmo:\\/\\/([^/]+)\\/([^/]+)$/.exec(address || '');
    return m ? { node: m[1], agent: m[2] } : null;
  }

  // ---- approve ----------------------------------------------------------

  var asked = '';
  qc.onAction('files-approve', function (button) {
    var form = byId('files-approve-form');
    if (!form) return;
    asked = button.getAttribute('data-path') || '';
    form.elements.requestId.value = button.getAttribute('data-id') || '';
    form.elements.scopePath.value = asked;
    form.elements.note.value = '';
    var only = form.querySelector('input[name="scopeKind"][value="file"]');
    if (only) only.checked = true;
    qc.setText('files-approve-source', button.getAttribute('data-source') || '');
    qc.setText('files-approve-target', button.getAttribute('data-target') || '');
    qc.say(byId('files-approve-status'), '', 'muted');
    qc.openDialog('files-approve-dialog', null);
  });

  // 「整个目录」 offers the asked path's directory; 「只这一项」 puts it back.
  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || target.name !== 'scopeKind' || !target.closest('#files-approve-form')) return;
    var form = byId('files-approve-form');
    if (!form) return;
    form.elements.scopePath.value = target.value === 'dir' ? parentOf(asked) : asked;
  });

  qc.onSubmit('files-approve-form', function (form) {
    var status = byId('files-approve-status');
    var id = form.elements.requestId.value;
    var kind = (form.querySelector('input[name="scopeKind"]:checked') || {}).value || 'file';
    var path = form.elements.scopePath.value.trim().replace(/^\\/+|\\/+$/g, '');
    if (kind === 'file' && !path) { qc.say(status, '路径必填', 'bad'); return; }
    var body = {
      approve: true,
      scope: { kind: kind, path: path },
      ttlMs: Number(form.elements.ttlMs.value)
    };
    var note = form.elements.note.value.trim();
    if (note) body.note = note;
    qc.say(status, '批准中', 'muted');
    qc.sendJson('POST', '/v0/files/requests/' + encodeURIComponent(id) + '/decide', body).then(function () {
      qc.closeDialog(byId('files-approve-dialog'));
      qc.toast('已批准 · 传输会自动开始', 'ok');
      return refresh();
    }).catch(function (err) { qc.say(status, qc.failLine('批准', err), qc.failTone(err)); });
  });

  // ---- deny / revoke / retry -------------------------------------------

  function confirmed(dialog, run) {
    return function (button) {
      var id = button.getAttribute('data-id') || '';
      var path = button.getAttribute('data-path') || '';
      qc.setText(dialog + '-name', path || '/');
      qc.openDialog(dialog, function () { run(id); });
    };
  }

  qc.onAction('files-deny', confirmed('confirm-files-deny', function (id) {
    qc.sendJson('POST', '/v0/files/requests/' + encodeURIComponent(id) + '/decide', { approve: false }).then(function () {
      qc.toast('已拒绝', 'ok');
      return refresh();
    }).catch(function (err) { qc.toast(qc.failLine('拒绝', err), qc.failTone(err)); });
  }));

  qc.onAction('files-revoke', confirmed('confirm-files-revoke', function (id) {
    qc.sendJson('POST', '/v0/files/grants/' + encodeURIComponent(id) + '/revoke', {}).then(function () {
      qc.toast('授权已撤销', 'ok');
      return refresh();
    }).catch(function (err) { qc.toast(qc.failLine('撤销', err), qc.failTone(err)); });
  }));

  qc.onAction('files-retry', function (button) {
    var id = button.getAttribute('data-id') || '';
    button.disabled = true;
    qc.sendJson('POST', '/v0/files/transfers/' + encodeURIComponent(id) + '/retry', {}).then(function () {
      qc.toast('已重新开始', 'ok');
      return refresh();
    }).catch(function (err) {
      button.disabled = false;
      qc.toast(qc.failLine('重试', err), qc.failTone(err));
    });
  });

  // ---- start a transfer -------------------------------------------------

  var blank = null;
  function sourceRows() {
    var box = byId('files-sources');
    return box ? box.querySelectorAll('.fx-source') : [];
  }

  qc.onAction('files-new', function () {
    var box = byId('files-sources');
    var form = byId('files-new-form');
    if (!box || !form) return;
    var rows = sourceRows();
    if (blank === null && rows.length > 0) blank = rows[0].cloneNode(true);
    for (var i = rows.length - 1; i > 0; i--) rows[i].remove();
    if (rows[0]) {
      rows[0].querySelector('input[name="sourcePath"]').value = '';
      var list = rows[0].querySelector('.fx-browse');
      list.hidden = true;
      list.textContent = '';
    }
    qc.say(byId('files-new-status'), '', 'muted');
    qc.openDialog('files-new-dialog', null);
  });

  qc.onAction('files-add-source', function () {
    var box = byId('files-sources');
    if (!box || blank === null) return;
    if (sourceRows().length >= MAX_SOURCES) {
      qc.say(byId('files-new-status'), '一次最多汇集 ' + MAX_SOURCES + ' 个来源', 'bad');
      return;
    }
    var row = blank.cloneNode(true);
    row.setAttribute('data-source', String(sourceRows().length));
    box.appendChild(row);
    row.querySelector('input[name="sourcePath"]').focus();
  });

  function showEntries(row, dir, entries) {
    var list = row.querySelector('.fx-browse');
    var input = row.querySelector('input[name="sourcePath"]');
    list.textContent = '';
    function item(label, note, onPick) {
      var b = document.createElement('button');
      b.type = 'button';
      var name = document.createElement('span');
      name.className = 'kit-mono';
      name.textContent = label;
      b.appendChild(name);
      if (note) {
        var n = document.createElement('span');
        n.className = 'note';
        n.textContent = note;
        b.appendChild(n);
      }
      b.addEventListener('click', onPick);
      list.appendChild(b);
    }
    if (dir) item('..', '上一级', function () { browse(row, parentOf(dir)); });
    if (entries.length === 0) {
      var none = document.createElement('p');
      none.className = 'note';
      none.textContent = '这个目录是空的';
      list.appendChild(none);
    }
    entries.forEach(function (entry) {
      var path = joinPath(dir, entry.name);
      if (entry.kind === 'dir') {
        item(entry.name + '/', '打开', function () { input.value = path; browse(row, path); });
      } else {
        var size = typeof entry.size === 'number' ? bytes(entry.size) : '';
        item(entry.name, size, function () { input.value = path; list.hidden = true; });
      }
    });
    list.hidden = false;
  }

  function browse(row, dir) {
    var agent = row.querySelector('select[name="sourceAgent"]').value;
    var list = row.querySelector('.fx-browse');
    list.hidden = false;
    list.textContent = '读取中…';
    var url = '/v0/files/browse?agent=' + encodeURIComponent(agent) + '&path=' + encodeURIComponent(dir);
    return qc.sendJson('GET', url).then(function (answer) {
      var entries = Array.isArray(answer) ? answer : (answer && answer.entries) || [];
      showEntries(row, dir, entries);
    }).catch(function (err) {
      list.textContent = qc.failLine('读取', err);
    });
  }

  qc.onAction('files-browse', function (button) {
    var row = button.closest('.fx-source');
    if (!row) return;
    var list = row.querySelector('.fx-browse');
    if (!list.hidden) { list.hidden = true; return; }
    var typed = row.querySelector('input[name="sourcePath"]').value.trim().replace(/^\\/+|\\/+$/g, '');
    browse(row, typed);
  });

  // A different agent: what was browsed belongs to the old one.
  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || target.name !== 'sourceAgent' || !target.closest('#files-new-form')) return;
    var row = target.closest('.fx-source');
    var list = row.querySelector('.fx-browse');
    list.hidden = true;
    list.textContent = '';
    row.querySelector('input[name="sourcePath"]').value = '';
  });

  qc.onSubmit('files-new-form', function (form) {
    var status = byId('files-new-status');
    var sources = [];
    var rows = sourceRows();
    for (var i = 0; i < rows.length; i++) {
      var agent = rows[i].querySelector('select[name="sourceAgent"]').value;
      var path = rows[i].querySelector('input[name="sourcePath"]').value.trim().replace(/^\\/+|\\/+$/g, '');
      if (!path) continue;
      sources.push({ agent: agent, path: path });
    }
    if (sources.length === 0) { qc.say(status, '至少填一个来源路径', 'bad'); return; }
    var target = form.elements.target.value;
    for (var j = 0; j < sources.length; j++) {
      if (sources[j].agent === target) { qc.say(status, '来源和目标不能是同一个智能体', 'bad'); return; }
    }
    if (!addressParts(target)) { qc.say(status, '选一个目标智能体', 'bad'); return; }
    qc.say(status, '提交中', 'muted');
    qc.sendJson('POST', '/v0/files/transfers', { sources: sources, target: target }).then(function () {
      qc.closeDialog(byId('files-new-dialog'));
      qc.toast(sources.length > 1 ? '已开始汇集 ' + sources.length + ' 个来源' : '传输已开始', 'ok');
      return refresh();
    }).catch(function (err) { qc.say(status, qc.failLine('发起', err), qc.failTone(err)); });
  });
})();
`
