// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 主动执行's page script: the schedule and channel dialogs, run now, the
 * enable switch and the two removals (`view/schedules.ts`).
 *
 * The runtime's rules hold (`assets/client.ts`): every write is `sendJson`,
 * every string reaches the page through `textContent` or a form value, and the
 * only markup that ever lands is the fragment the server rendered, through
 * `refreshRegion`.
 */

export const SCHEDULES_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;

  function refresh() {
    var mount = byId('schedules');
    return mount ? qc.refreshRegion(mount) : Promise.resolve();
  }

  function value(form, name) {
    var el = form.elements[name];
    return el && typeof el.value === 'string' ? el.value.trim() : '';
  }

  function checked(form, name) {
    var out = [];
    var nodes = form.querySelectorAll('input[name="' + name + '"]:checked');
    for (var i = 0; i < nodes.length; i++) out.push(nodes[i].value);
    return out;
  }

  function radio(form, name) {
    var el = form.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : '';
  }

  function setRadio(form, name, want) {
    var nodes = form.querySelectorAll('input[name="' + name + '"]');
    for (var i = 0; i < nodes.length; i++) nodes[i].checked = nodes[i].value === want;
  }

  function setChecks(form, name, wanted) {
    var nodes = form.querySelectorAll('input[name="' + name + '"]');
    for (var i = 0; i < nodes.length; i++) nodes[i].checked = wanted.indexOf(nodes[i].value) !== -1;
  }

  var form = byId('schedule-form');
  var templates = [];
  try { templates = JSON.parse(form ? form.getAttribute('data-templates') || '[]' : '[]'); } catch (e) { templates = []; }

  function templateOf(id) {
    for (var i = 0; i < templates.length; i++) if (templates[i].id === id) return templates[i];
    return null;
  }

  // The prompt follows the template until somebody types in it: switching
  // template after editing the text would throw that text away.
  var promptTouched = false;

  function applyTemplate() {
    if (!form) return;
    var one = templateOf(radio(form, 'template'));
    var needs = byId('schedule-needs');
    if (needs) {
      needs.hidden = !(one && one.needs);
      needs.textContent = one && one.needs ? '需要先接上' + one.needs : '';
    }
    if (one && !promptTouched) form.elements.prompt.value = one.prompt;
    if (one && !value(form, 'title') && one.id !== 'custom') form.elements.title.value = one.title;
  }

  function applyKind() {
    if (!form) return;
    var kind = radio(form, 'kind');
    var blocks = form.querySelectorAll('[data-when]');
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].hidden = (blocks[i].getAttribute('data-when') || '').split(' ').indexOf(kind) === -1;
    }
  }

  function reset(data) {
    if (!form) return;
    form.reset();
    qc.clearFields(form);
    qc.say(byId('schedule-status'), '', 'muted');
    promptTouched = !!data;
    form.elements.scheduleId.value = data ? data.id : '';
    if (data) {
      form.elements.title.value = data.title;
      form.elements.target.value = data.target;
      setRadio(form, 'template', data.template);
      form.elements.prompt.value = data.prompt;
      setRadio(form, 'kind', data.when.kind);
      if (data.when.kind === 'interval') form.elements.everyMinutes.value = String(data.when.everyMinutes);
      else form.elements.time.value = data.when.time;
      setChecks(form, 'days', data.when.kind === 'weekly' ? data.when.days.map(String) : ['1', '2', '3', '4', '5']);
      form.elements.timezone.value = data.timezone;
      form.elements.direction.value = data.direction || '';
      form.elements.timeoutMinutes.value = String(Math.round(data.timeoutMs / 60000));
      setChecks(form, 'channels', data.channels);
      form.elements.notifyOnlyAgent.checked = !!data.notifyOnlyAgent;
      form.elements.enabled.checked = !!data.enabled;
    }
    applyKind();
    applyTemplate();
  }

  if (form) {
    form.addEventListener('change', function (event) {
      var name = event.target && event.target.name;
      if (name === 'template') applyTemplate();
      if (name === 'kind') applyKind();
    });
    form.elements.prompt.addEventListener('input', function () { promptTouched = true; });
  }

  function openSchedule(data) {
    reset(data || null);
    qc.openDialog('schedule-dialog', null);
  }

  qc.onAction('schedule-new', function () { openSchedule(null); });
  qc.onAction('schedule-edit', function (button) {
    var data = null;
    try { data = JSON.parse(button.getAttribute('data-schedule') || 'null'); } catch (e) { data = null; }
    if (data) openSchedule(data);
  });

  var TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  var RULES = {
    title: function (v) { return v ? '' : '必填'; },
    target: function (v) { return v ? '' : '选一个智能体'; },
    prompt: function (v) { return v ? '' : '必填'; }
  };

  function whenOf() {
    var kind = radio(form, 'kind');
    if (kind === 'interval') {
      var every = parseInt(value(form, 'everyMinutes'), 10);
      if (!(every >= 15)) return { error: ['everyMinutes', '最短 15 分钟'] };
      return { when: { kind: 'interval', everyMinutes: every } };
    }
    var time = value(form, 'time');
    if (!TIME.test(time)) return { error: ['time', '格式应为 08:00'] };
    if (kind === 'weekly') {
      var days = checked(form, 'days').map(function (d) { return parseInt(d, 10); });
      if (days.length === 0) return { error: ['days', '至少选一天'] };
      return { when: { kind: 'weekly', days: days, time: time } };
    }
    return { when: { kind: 'daily', time: time } };
  }

  qc.onSubmit('schedule-form', function (target) {
    var status = byId('schedule-status');
    if (!qc.checkFields(target, RULES)) { qc.say(status, '有字段需要修改', 'bad'); return; }
    var when = whenOf();
    if (when.error) {
      var el = qc.markField(target, when.error[0], when.error[1]);
      if (el) el.focus();
      qc.say(status, '有字段需要修改', 'bad');
      return;
    }
    var minutes = parseInt(value(target, 'timeoutMinutes'), 10) || 10;
    var body = {
      title: value(target, 'title'),
      target: value(target, 'target'),
      template: radio(target, 'template') || 'custom',
      prompt: target.elements.prompt.value.trim(),
      when: when.when,
      timezone: value(target, 'timezone') || 'Asia/Shanghai',
      direction: value(target, 'direction') || null,
      channels: checked(target, 'channels'),
      notifyOnlyAgent: target.elements.notifyOnlyAgent.checked,
      enabled: target.elements.enabled.checked,
      timeoutMs: Math.max(1, Math.min(60, minutes)) * 60000
    };
    var id = value(target, 'scheduleId');
    if (id) body.id = id;
    qc.say(status, '保存中', 'muted');
    qc.sendJson('POST', '/v0/schedules', body).then(function () {
      qc.closeDialog(byId('schedule-dialog'));
      qc.toast((id ? '已保存 ' : '已新建 ') + body.title, 'ok');
      return refresh();
    }).catch(function (err) {
      qc.say(status, qc.failLine('保存', err), qc.failTone(err));
    });
  });

  qc.onAction('schedule-run', function (button) {
    var id = button.getAttribute('data-id');
    var title = button.getAttribute('data-title') || '';
    qc.sendJson('POST', '/v0/schedules/' + encodeURIComponent(id) + '/run').then(function () {
      qc.toast('已开始运行 ' + title + ' · 结果出来后出现在运行记录里', 'ok');
      return refresh();
    }).catch(function (err) { qc.toast(qc.failLine('运行', err), qc.failTone(err)); });
  });

  // A run whose end never came back holds the schedule until a person says
  // how it went; the answer settles the run and frees the schedule.
  qc.onAction('run-resolve', function (button) {
    var id = button.getAttribute('data-id') || '';
    var run = button.getAttribute('data-run') || '';
    var outcome = button.getAttribute('data-outcome') === 'ok' ? 'ok' : 'failed';
    qc.sendJson('POST', '/v0/schedules/' + encodeURIComponent(id) + '/runs/' + encodeURIComponent(run) + '/resolve', { outcome: outcome }).then(function () {
      qc.toast(outcome === 'ok' ? '已记为完成 · 任务恢复按时运行' : '已记为失败 · 任务恢复按时运行', 'ok');
      return refresh();
    }).catch(function (err) { qc.toast(qc.failLine('确认', err), qc.failTone(err)); });
  });

  // The switch is a checkbox inside the polled table: a click flips it at
  // once, and the refresh after the answer puts it back if the write failed.
  document.addEventListener('change', function (event) {
    var el = event.target;
    if (!el || el.getAttribute('data-action') !== 'schedule-toggle') return;
    var id = el.getAttribute('data-id');
    var verb = el.checked ? 'enable' : 'disable';
    qc.sendJson('POST', '/v0/schedules/' + encodeURIComponent(id) + '/' + verb).then(function () {
      qc.toast(el.checked ? '已启用' : '已停用', 'ok');
      return refresh();
    }).catch(function (err) {
      qc.toast(qc.failLine('切换', err), qc.failTone(err));
      return refresh();
    });
  });

  function confirmRemove(dialog, nameAttr, url, done) {
    return function (button) {
      var name = button.getAttribute(nameAttr) || '';
      var id = button.getAttribute('data-id');
      qc.setText(dialog + '-name', name);
      qc.openDialog(dialog, function () {
        qc.sendJson('DELETE', url + encodeURIComponent(id)).then(function () {
          qc.toast(done + ' ' + name, 'ok');
          return refresh();
        }).catch(function (err) { qc.toast(qc.failLine('删除', err), qc.failTone(err)); });
      });
    };
  }

  qc.onAction('schedule-remove', confirmRemove('confirm-schedule-remove', 'data-title', '/v0/schedules/', '已删除'));
  qc.onAction('channel-remove', confirmRemove('confirm-channel-remove', 'data-name', '/v0/channels/', '已删除'));

  qc.onAction('channel-new', function () {
    var channel = byId('channel-form');
    if (channel) { channel.reset(); qc.clearFields(channel); }
    qc.say(byId('channel-status'), '', 'muted');
    qc.openDialog('channel-dialog', null);
  });

  var CHANNEL_RULES = {
    name: function (v) { return v ? '' : '必填'; },
    url: function (v) {
      if (!v) return '必填';
      try {
        var u = new URL(v);
        if (u.protocol === 'https:') return '';
        if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return '';
        return '只接受 https 地址';
      } catch (e) { return '不是有效的地址'; }
    }
  };

  qc.onSubmit('channel-form', function (target) {
    var status = byId('channel-status');
    if (!qc.checkFields(target, CHANNEL_RULES)) { qc.say(status, '有字段需要修改', 'bad'); return; }
    var body = { name: value(target, 'name'), kind: value(target, 'kind'), url: value(target, 'url') };
    qc.say(status, '保存中', 'muted');
    qc.sendJson('POST', '/v0/channels', body).then(function () {
      target.elements.url.value = '';
      qc.closeDialog(byId('channel-dialog'));
      qc.toast('已添加 ' + body.name, 'ok');
      // The schedule form lists channels as it was rendered; a reload is
      // the honest way to put the new one there.
      window.setTimeout(function () { window.location.reload(); }, 600);
    }).catch(function (err) { qc.say(status, qc.failLine('添加', err), qc.failTone(err)); });
  });

  qc.onAction('channel-test', function (button) {
    var id = button.getAttribute('data-id');
    var name = button.getAttribute('data-name') || '';
    qc.sendJson('POST', '/v0/channels/' + encodeURIComponent(id) + '/test').then(function () {
      qc.toast('已向 ' + name + ' 发出测试通知', 'ok');
      return refresh();
    }).catch(function (err) {
      qc.toast(qc.failLine('测试', err), qc.failTone(err));
      return refresh();
    });
  });
})();
`
