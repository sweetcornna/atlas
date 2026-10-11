// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 记忆's page script: the filter submits itself, the write dialog adds or
 * corrects one, the forget dialog retires one (`view/memory.ts`). Every
 * write is `sendJson`; the list comes back as the server's fragment.
 */

export const MEMORY_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;

  function agent() {
    var select = byId('memory-agent');
    return select ? select.value : '';
  }

  function refresh() {
    var mount = byId('memory');
    return mount ? qc.refreshRegion(mount) : Promise.resolve();
  }

  // The filter is a native GET; picking a choice is the submit. Empty
  // choices are left out so the address stays as short as the server's.
  var filter = byId('memory-filter');
  if (filter) {
    filter.addEventListener('submit', function () {
      var fields = filter.querySelectorAll('input[name], select[name]');
      for (var i = 0; i < fields.length; i++) {
        var field = fields[i];
        if (field.value !== '') continue;
        if (field.type !== 'radio' || field.checked) field.disabled = true;
      }
    });
    // Back from the next page restores this one from the cache, as left.
    window.addEventListener('pageshow', function () {
      var off = filter.querySelectorAll(':disabled');
      for (var i = 0; i < off.length; i++) off[i].disabled = false;
    });
    filter.addEventListener('change', function (event) {
      if (event.target && event.target.name === 'q') return;
      if (typeof filter.requestSubmit === 'function') filter.requestSubmit();
      else filter.submit();
    });
  }

  var form = byId('memory-form');

  function open(data) {
    if (!form) return;
    form.reset();
    qc.clearFields(form);
    qc.say(byId('memory-status'), '', 'muted');
    form.elements.memoryId.value = data ? data.id : '';
    qc.setText('memory-title', data ? '改这条' : '记一条');
    if (data) {
      var kinds = form.querySelectorAll('input[name="kind"]');
      for (var i = 0; i < kinds.length; i++) kinds[i].checked = kinds[i].value === data.kind;
      form.elements.title.value = data.title;
      form.elements.summary.value = data.summary;
      form.elements.body.value = data.body;
    }
    qc.openDialog('memory-dialog', null);
  }

  qc.onAction('memory-new', function () { open(null); });
  qc.onAction('memory-edit', function (button) {
    var data = null;
    try { data = JSON.parse(button.getAttribute('data-memory') || 'null'); } catch (e) { data = null; }
    if (data) open(data);
  });

  var RULES = {
    title: function (v) { return v ? '' : '必填'; },
    summary: function (v) { return v ? '' : '必填'; }
  };

  qc.onSubmit('memory-form', function (target) {
    var status = byId('memory-status');
    if (!qc.checkFields(target, RULES)) { qc.say(status, '有字段需要修改', 'bad'); return; }
    var kind = target.querySelector('input[name="kind"]:checked');
    var body = {
      agent: agent(),
      kind: kind ? kind.value : 'preference',
      title: target.elements.title.value.trim(),
      summary: target.elements.summary.value.trim(),
      body: target.elements.body.value.trim()
    };
    var id = target.elements.memoryId.value;
    qc.say(status, '保存中', 'muted');
    var sent = id
      ? qc.sendJson('PUT', '/v0/memory/' + encodeURIComponent(id), body)
      : qc.sendJson('POST', '/v0/memory', body);
    sent.then(function () {
      qc.closeDialog(byId('memory-dialog'));
      qc.toast(id ? '已改好 · 旧的那条留在历史里' : '记下了', 'ok');
      return refresh();
    }).catch(function (err) { qc.say(status, qc.failLine('保存', err), qc.failTone(err)); });
  });

  var forget = byId('memory-forget-form');
  qc.onAction('memory-forget', function (button) {
    if (!forget) return;
    forget.reset();
    forget.elements.memoryId.value = button.getAttribute('data-id') || '';
    qc.setText('memory-forget-name', button.getAttribute('data-title') || '');
    qc.openDialog('memory-forget-dialog', null);
  });

  qc.onSubmit('memory-forget-form', function (target) {
    var id = target.elements.memoryId.value;
    qc.sendJson('POST', '/v0/memory/' + encodeURIComponent(id) + '/forget', {
      agent: agent(),
      reason: target.elements.reason.value.trim() || '用户在控制台删除'
    }).then(function () {
      qc.closeDialog(byId('memory-forget-dialog'));
      qc.toast('忘掉了', 'ok');
      return refresh();
    }).catch(function (err) { qc.toast(qc.failLine('忘记', err), qc.failTone(err)); });
  });
})();
`
