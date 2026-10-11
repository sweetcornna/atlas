// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 连接's page script (`view/connect.ts`). The connection form's body is the
 * server's (`/fragments/connect/form`), drawn per service; this script only
 * opens it, swaps it when another service is picked, and sends what it
 * holds. Pairing asks the hub for a one-time code and shows the line to run.
 */

export const CONNECT_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;

  function refresh() {
    var mount = byId('connect');
    return mount ? qc.refreshRegion(mount) : Promise.resolve();
  }

  function loadForm(query, title) {
    var body = byId('connector-body');
    if (!body) return Promise.resolve();
    qc.say(byId('connector-status'), '', 'muted');
    qc.setText('connector-title', title);
    return qc.loadHtml('/fragments/connect/form' + query).then(function (html) {
      body.innerHTML = html;
    });
  }

  qc.onAction('connector-new', function () {
    loadForm('', '添加连接').then(function () {
      qc.openDialog('connector-dialog', null);
    }).catch(function (err) { qc.toast(qc.failLine('打开', err), qc.failTone(err)); });
  });

  qc.onAction('connector-edit', function (button) {
    var id = button.getAttribute('data-id') || '';
    loadForm('?id=' + encodeURIComponent(id), '编辑连接').then(function () {
      qc.openDialog('connector-dialog', null);
    }).catch(function (err) { qc.toast(qc.failLine('打开', err), qc.failTone(err)); });
  });

  // Another service: the same dialog, drawn for it.
  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || target.name !== 'preset' || !target.closest('#connector-form')) return;
    loadForm('?preset=' + encodeURIComponent(target.value), '添加连接').catch(function (err) {
      qc.say(byId('connector-status'), qc.failLine('切换', err), qc.failTone(err));
    });
  });

  qc.onSubmit('connector-form', function (form) {
    var status = byId('connector-status');
    var name = form.elements.name ? form.elements.name.value.trim() : '';
    if (!name) { qc.say(status, '名称必填', 'bad'); return; }
    var id = form.elements.connectorId ? form.elements.connectorId.value : '';
    var preset = form.querySelector('input[name="preset"]:checked') || form.querySelector('input[type="hidden"][name="preset"]');
    var settings = {};
    var fields = form.querySelectorAll('[data-setting]');
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      var key = field.getAttribute('data-setting');
      if (field.type === 'checkbox') settings[key] = field.checked;
      else if (field.getAttribute('data-number') === '1') settings[key] = Number(field.value);
      else settings[key] = field.value.trim();
    }
    var agents = [];
    var boxes = form.querySelectorAll('input[name="agents"]:checked');
    for (var j = 0; j < boxes.length; j++) agents.push(boxes[j].value);
    var secret = form.elements.secret ? form.elements.secret.value : '';
    if (!id && !secret) { qc.say(status, '凭据必填', 'bad'); return; }
    var body = {
      name: name,
      kind: form.elements.kind ? form.elements.kind.value : 'mail',
      preset: preset ? preset.value : '',
      settings: settings,
      agents: agents
    };
    if (id) body.id = id;
    if (secret) body.secret = secret;
    qc.say(status, '保存中', 'muted');
    qc.sendJson('POST', '/v0/connectors', body).then(function () {
      if (form.elements.secret) form.elements.secret.value = '';
      qc.closeDialog(byId('connector-dialog'));
      qc.toast(id ? '已保存 ' + name : '已添加 ' + name + ' · 可以点「测试」连一次', 'ok');
      return refresh();
    }).catch(function (err) { qc.say(status, qc.failLine('保存', err), qc.failTone(err)); });
  });

  qc.onAction('connector-probe', function (button) {
    var id = button.getAttribute('data-id') || '';
    var name = button.getAttribute('data-name') || '';
    qc.toast('正在连 ' + name, 'muted');
    qc.sendJson('POST', '/v0/connectors/' + encodeURIComponent(id) + '/probe', {}).then(function (view) {
      var probe = view && view.lastProbe;
      if (probe && probe.ok) qc.toast(name + ' 连得上', 'ok');
      else qc.toast(name + ' 没连上' + (probe && probe.detail ? ' · ' + probe.detail : ''), 'bad');
      return refresh();
    }).catch(function (err) { qc.toast(qc.failLine('测试', err), qc.failTone(err)); });
  });

  function confirmed(dialog, run) {
    return function (button) {
      var name = button.getAttribute('data-name') || '';
      var id = button.getAttribute('data-id') || '';
      qc.setText(dialog + '-name', name);
      qc.openDialog(dialog, function () { run(id, name); });
    };
  }

  qc.onAction('connector-remove', confirmed('confirm-connector-remove', function (id, name) {
    qc.sendJson('DELETE', '/v0/connectors/' + encodeURIComponent(id)).then(function () {
      qc.toast('已删除 ' + name, 'ok');
      return refresh();
    }).catch(function (err) { qc.toast(qc.failLine('删除', err), qc.failTone(err)); });
  }));

  qc.onAction('device-revoke', confirmed('confirm-device-revoke', function (id, name) {
    qc.sendJson('DELETE', '/v0/handoff/devices/' + encodeURIComponent(id)).then(function () {
      qc.toast('已吊销 ' + name, 'ok');
      return refresh();
    }).catch(function (err) { qc.toast(qc.failLine('吊销', err), qc.failTone(err)); });
  }));

  var expiryTimer = null;
  function countdown(expiresAt) {
    if (expiryTimer) clearInterval(expiryTimer);
    function tick() {
      var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      if (left === 0) {
        qc.setText('pairing-expiry', '配对码已过期 · 关掉重新添加');
        clearInterval(expiryTimer);
        return;
      }
      var m = Math.floor(left / 60);
      var s = left % 60;
      qc.setText('pairing-expiry', m + ' 分 ' + (s < 10 ? '0' : '') + s + ' 秒内有效');
    }
    tick();
    expiryTimer = setInterval(tick, 1000);
  }

  qc.onAction('device-pair', function () {
    qc.sendJson('POST', '/v0/handoff/devices/pairing', {}).then(function (answer) {
      var pairing = answer && answer.pairing ? answer.pairing : answer;
      if (!pairing || !pairing.code) throw new Error('没有拿到配对码');
      qc.setText('pairing-code', pairing.code);
      qc.setText('pairing-command', pairing.command || '');
      countdown(Number(pairing.expiresAt) || Date.now());
      qc.openDialog('pairing-dialog', null);
      return refresh();
    }).catch(function (err) { qc.toast(qc.failLine('配对', err), qc.failTone(err)); });
  });

  qc.onAction('pairing-copy', function () {
    var line = byId('pairing-command');
    var text = line ? line.textContent : '';
    if (!text || !navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function () { qc.toast('已复制', 'ok'); }, function () {});
  });
})();
`
