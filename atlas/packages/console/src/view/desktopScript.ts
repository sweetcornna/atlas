// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 云端电脑's script (`view/desktop.ts`): a switch or a confirmation choice is
 * one `PUT /v0/desktop/<node>/<agent>`; recycling asks first. A refused
 * change puts the control back the way the server has it.
 */

export const DESKTOP_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;

  function refresh() {
    var mount = byId('desktop');
    return mount ? qc.refreshRegion(mount) : Promise.resolve();
  }

  function path(node, agent) {
    return '/v0/desktop/' + encodeURIComponent(node) + '/' + encodeURIComponent(agent);
  }

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.closest || !target.closest('#desktop')) return;
    var node = target.getAttribute('data-node');
    var agent = target.getAttribute('data-agent');
    if (!node || !agent) return;
    var change = null;
    var word = '';
    if (target.hasAttribute('data-desktop-unit')) {
      var unit = target.getAttribute('data-desktop-unit');
      change = {};
      change[unit] = target.checked;
      word = (unit === 'browser' ? '浏览器' : '电脑') + (target.checked ? '开了' : '关了');
    } else if (target.hasAttribute('data-desktop-confirm') && target.checked) {
      change = { confirm: target.value };
      word = '确认方式已改';
    }
    if (!change) return;
    target.disabled = true;
    qc.sendJson('PUT', path(node, agent), change).then(function () {
      qc.toast(agent + ' · ' + word, 'ok');
      return refresh();
    }).catch(function (err) {
      qc.toast(qc.failLine('切换', err), qc.failTone(err));
      return refresh();
    });
  });

  qc.onAction('desktop-recycle', function (button) {
    var node = button.getAttribute('data-node') || '';
    var agent = button.getAttribute('data-agent') || '';
    qc.setText('confirm-desktop-recycle-name', agent + ' · ' + node);
    qc.openDialog('confirm-desktop-recycle', function () {
      qc.sendJson('POST', path(node, agent) + '/recycle', {}).then(function () {
        qc.toast(agent + ' 的浏览器与电脑已清空', 'ok');
        return refresh();
      }).catch(function (err) { qc.toast(qc.failLine('回收', err), qc.failTone(err)); });
    });
  });
})();
`
