// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 后台任务's script on the 主动执行 page (`view/tasks.ts`): 取消, after the
 * confirmation, then a refresh of the list.
 *
 * The runtime's rules hold (`assets/client.ts`): the write is `sendJson`, the
 * title reaches the dialog through `setText`, and the only markup that lands
 * is the fragment the server rendered, through `refreshRegion`.
 */

export const TASKS_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;

  function refresh() {
    var mount = qc.byId('tasks');
    return mount ? qc.refreshRegion(mount) : Promise.resolve();
  }

  qc.onAction('task-cancel', function (button) {
    var id = button.getAttribute('data-id') || '';
    var title = button.getAttribute('data-title') || '';
    qc.setText('confirm-task-cancel-name', title);
    qc.openDialog('confirm-task-cancel', function () {
      qc.sendJson('POST', '/v0/tasks/' + encodeURIComponent(id) + '/cancel').then(function () {
        qc.toast('已取消 ' + title, 'ok');
        return refresh();
      }).catch(function (err) {
        qc.toast(qc.failLine('取消', err), qc.failTone(err));
        return refresh();
      });
    });
  });
})();
`
