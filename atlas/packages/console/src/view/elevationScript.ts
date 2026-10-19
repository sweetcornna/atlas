// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 权限模式's script (`view/elevation.ts`). Choosing 人工确认 is one
 * `PUT /v0/elevation/<node>/<agent>` with `tier: off`; any other mode opens
 * the duration/budget dialog first, outside the polled region so a refresh
 * cannot eat it. 收回 and 全部收回 ask first. A refused change puts the
 * control back the way the server has it.
 */

export const ELEVATION_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var WORD = { off: '人工确认', 'accept-edits': '自动接受编辑', auto: '自动审批', 'full-access': '跳过权限确认' };
  var NOTE = {
    'accept-edits': '工作区编辑直接执行 · 命令 联网 GitHub 逐次确认',
    auto: '沙箱内命令 工作区编辑 联网读取直接执行 · GitHub 写操作逐次确认',
    'full-access': '不再逐次确认 · 红线与云端电脑「每一步都确认」照旧'
  };
  var pending = null;

  function refresh() {
    var mount = byId('elevation');
    return mount ? qc.refreshRegion(mount) : Promise.resolve();
  }

  function path(node, agent) {
    return '/v0/elevation/' + encodeURIComponent(node) + '/' + encodeURIComponent(agent);
  }

  function put(node, agent, change, word) {
    return qc.sendJson('PUT', path(node, agent), change).then(function () {
      qc.toast(agent + ' · ' + word, 'ok');
      return refresh();
    });
  }

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.closest || !target.closest('#elevation')) return;
    if (!target.hasAttribute('data-elevation-tier') || !target.checked) return;
    var node = target.getAttribute('data-node') || '';
    var agent = target.getAttribute('data-agent') || '';
    var tier = target.value;
    if (tier === 'off') {
      target.disabled = true;
      put(node, agent, { tier: 'off' }, '已回到人工确认').catch(function (err) {
        qc.toast(qc.failLine('切换', err), qc.failTone(err));
        return refresh();
      });
      return;
    }
    pending = { node: node, agent: agent, tier: tier };
    var form = byId('elevation-grant-form');
    if (!form) return;
    qc.clearFields(form);
    qc.setText('elevation-grant-name', agent + ' · ' + node);
    qc.setText('elevation-grant-tier', WORD[tier] || tier);
    qc.setText('elevation-grant-note', NOTE[tier] || '');
    qc.openDialog('elevation-grant', null);
    // A closed dialog without a save leaves the server's choice on the card.
    refresh();
  });

  qc.onSubmit('elevation-grant-form', function (form) {
    var target = pending;
    if (!target) return;
    var calls = Number(form.elements.maxCalls.value);
    if (!Number.isInteger(calls) || calls < 1 || calls > 2000) {
      qc.markField(form, 'maxCalls', '1 到 2000 之间的整数');
      form.elements.maxCalls.focus();
      return;
    }
    var change = { tier: target.tier, ttlMs: Number(form.elements.ttl.value), maxCalls: calls };
    put(target.node, target.agent, change, WORD[target.tier] + ' 已开启').then(function () {
      pending = null;
      qc.closeDialog(byId('elevation-grant'));
    }).catch(function (err) {
      if (qc.fieldOf(err, ['maxCalls'])) qc.markField(form, 'maxCalls', qc.message(err));
      else qc.toast(qc.failLine('开启', err), qc.failTone(err));
    });
  });

  qc.onAction('elevation-revoke', function (button) {
    var node = button.getAttribute('data-node') || '';
    var agent = button.getAttribute('data-agent') || '';
    qc.setText('confirm-elevation-revoke-name', agent + ' · ' + node);
    qc.openDialog('confirm-elevation-revoke', function () {
      qc.sendJson('POST', path(node, agent) + '/revoke', {}).then(function () {
        qc.toast(agent + ' 已收回', 'ok');
        return refresh();
      }).catch(function (err) { qc.toast(qc.failLine('收回', err), qc.failTone(err)); });
    });
  });

  qc.onAction('elevation-revoke-all', function () {
    qc.openDialog('confirm-elevation-revoke-all', function () {
      qc.sendJson('POST', '/v0/elevation/revoke-all', {}).then(function (answer) {
        var rows = (answer && answer.revoked) || [];
        var failed = rows.filter(function (row) { return !row.ok; }).length;
        qc.toast(failed === 0 ? '已全部收回' : failed + ' 个没收回 · 请看卡片', failed === 0 ? 'ok' : 'warn');
        return refresh();
      }).catch(function (err) { qc.toast(qc.failLine('收回', err), qc.failTone(err)); });
    });
  });
})();
`
