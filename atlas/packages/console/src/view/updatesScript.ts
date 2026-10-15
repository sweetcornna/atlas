// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 更新's page script (`view/updates.ts`). The form body is the server's
 * (`/fragments/updates/form`); a check runs on the hub in the background and
 * the polled region shows its result. An upgrade or rollback is followed
 * until it ends; the hub restarts on the way, so failed polls are expected,
 * and the page reloads once the hub answers again with the job finished.
 */

export const UPDATES_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;

  function refresh() {
    var mount = byId('updates');
    return mount ? qc.refreshRegion(mount) : Promise.resolve();
  }

  qc.onAction('updates-edit', function () {
    var body = byId('updates-body');
    if (!body) return;
    qc.say(byId('updates-status'), '', 'muted');
    qc.loadHtml('/fragments/updates/form').then(function (html) {
      body.innerHTML = html;
      qc.openDialog('updates-dialog', null);
    }).catch(function (err) { qc.toast(qc.failLine('打开', err), qc.failTone(err)); });
  });

  function checked(form, name) {
    var out = [];
    var boxes = form.querySelectorAll('input[name="' + name + '"]:checked');
    for (var i = 0; i < boxes.length; i++) out.push(boxes[i].value);
    return out;
  }

  qc.onSubmit('updates-form', function (form) {
    var status = byId('updates-status');
    var raw = form.elements.times ? form.elements.times.value : '';
    var times = raw.split(/[\\s,，、]+/).filter(Boolean);
    for (var i = 0; i < times.length; i++) {
      if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(times[i])) { qc.say(status, '时间写成 HH:MM，如 08:00', 'bad'); return; }
    }
    var days = checked(form, 'days').map(Number);
    var draft = {
      times: times.map(function (time) {
        return days.length ? { kind: 'weekly', days: days, time: time } : { kind: 'daily', time: time };
      }),
      timezone: form.elements.timezone ? form.elements.timezone.value : 'Asia/Shanghai',
      actions: {},
      channels: checked(form, 'channels'),
      repo: form.elements.repo && form.elements.repo.value.trim() ? form.elements.repo.value.trim() : null
    };
    var radios = form.querySelectorAll('input[type="radio"][name^="action-"]:checked');
    for (var j = 0; j < radios.length; j++) draft.actions[radios[j].name.slice(7)] = radios[j].value;
    qc.say(status, '保存中', 'muted');
    qc.sendJson('POST', '/v0/updates', draft).then(function () {
      qc.closeDialog(byId('updates-dialog'));
      qc.toast('已保存', 'ok');
      return refresh();
    }).catch(function (err) { qc.say(status, qc.failLine('保存', err), qc.failTone(err)); });
  });

  var watching = null;
  function watch() {
    if (watching) return;
    var misses = 0;
    function tick() {
      qc.sendJson('GET', '/v0/updates').then(function (snapshot) {
        misses = 0;
        var job = snapshot.upgrade;
        if (job && job.state === 'running') { refresh(); watching = setTimeout(tick, 3000); return; }
        watching = null;
        window.location.reload();
      }).catch(function () {
        // The hub is restarting.
        misses++;
        watching = setTimeout(tick, misses > 3 ? 5000 : 2000);
      });
    }
    watching = setTimeout(tick, 2000);
  }

  qc.onAction('updates-upgrade', function (button) {
    var version = button.getAttribute('data-version') || '';
    qc.setText('confirm-updates-upgrade-version', version);
    qc.openDialog('confirm-updates-upgrade', function () {
      qc.sendJson('POST', '/v0/updates/upgrade', version ? { version: version } : {}).then(function () {
        qc.toast('开始升级 ' + version, 'ok');
        refresh();
        watch();
      }).catch(function (err) { qc.toast(qc.failLine('升级', err), qc.failTone(err)); });
    });
  });

  qc.onAction('updates-rollback', function () {
    var body = byId('updates-rollback-body');
    if (!body) return;
    qc.say(byId('updates-rollback-status'), '', 'muted');
    qc.loadHtml('/fragments/updates/rollback').then(function (html) {
      body.innerHTML = html;
      qc.openDialog('updates-rollback-dialog', null);
    }).catch(function (err) { qc.toast(qc.failLine('打开', err), qc.failTone(err)); });
  });

  qc.onSubmit('updates-rollback-form', function (form) {
    var picked = form.querySelector('input[name="rollbackVersion"]:checked');
    var version = picked ? picked.value : '';
    qc.say(byId('updates-rollback-status'), '提交中', 'muted');
    qc.sendJson('POST', '/v0/updates/rollback', version ? { version: version } : {}).then(function () {
      qc.closeDialog(byId('updates-rollback-dialog'));
      qc.toast('开始回滚', 'ok');
      refresh();
      watch();
    }).catch(function (err) { qc.say(byId('updates-rollback-status'), qc.failLine('回滚', err), qc.failTone(err)); });
  });

  // A job already running when the page opened is followed too.
  if (document.querySelector('[data-job-state="running"]')) watch();

  qc.onAction('updates-run', function (button) {
    if (button.getAttribute('data-busy') === '1') return;
    qc.sendJson('POST', '/v0/updates/run', {}).then(function () {
      qc.toast('开始检查', 'ok');
      return refresh();
    }).catch(function (err) { qc.toast(qc.failLine('检查', err), qc.failTone(err)); });
  });
})();
`
