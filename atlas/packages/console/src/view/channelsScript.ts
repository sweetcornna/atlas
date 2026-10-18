// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 渠道's page script (`view/channels.ts`). The form body is the server's
 * (`/fragments/im/form`); WeChat saves by scanning: the hub starts the
 * login, this script shows the server-drawn QR and polls until the scan is
 * confirmed.
 */

export const CHANNELS_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;

  function refresh() {
    var mount = byId('channels');
    return mount ? qc.refreshRegion(mount) : Promise.resolve();
  }

  function loadForm(query, title) {
    var body = byId('channel-body');
    if (!body) return Promise.resolve();
    qc.say(byId('channel-status'), '', 'muted');
    qc.setText('channel-title', title);
    return qc.loadHtml('/fragments/im/form' + query).then(function (html) {
      body.innerHTML = html;
    });
  }

  function open(query, title) {
    loadForm(query, title).then(function () {
      qc.openDialog('channel-dialog', null);
    }).catch(function (err) { qc.toast(qc.failLine('打开', err), qc.failTone(err)); });
  }

  qc.onAction('channel-new', function () { open('', '添加渠道'); });
  qc.onAction('channel-edit', function (button) {
    open('?id=' + encodeURIComponent(button.getAttribute('data-id') || ''), '编辑渠道');
  });

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || target.name !== 'platform' || !target.closest('#channel-form')) return;
    loadForm('?platform=' + encodeURIComponent(target.value), '添加渠道').catch(function (err) {
      qc.say(byId('channel-status'), qc.failLine('切换', err), qc.failTone(err));
    });
  });

  function split(value) {
    return String(value || '').split(/[\\s,，]+/).filter(Boolean);
  }

  function draftOf(form) {
    var platform = form.querySelector('input[name="platform"]:checked') || form.querySelector('input[type="hidden"][name="platform"]');
    var draft = {
      name: form.elements.name ? form.elements.name.value.trim() : '',
      platform: platform ? platform.value : '',
      target: form.elements.target ? form.elements.target.value : '',
      memberTarget: form.elements.memberTarget && form.elements.memberTarget.value ? form.elements.memberTarget.value : null,
      groupTrigger: form.elements.groupTrigger ? form.elements.groupTrigger.value : 'mention',
      replyWindowMs: form.elements.replyWindowMs ? Number(form.elements.replyWindowMs.value || 0) : 0,
      allowGroups: split(form.elements.allowGroups && form.elements.allowGroups.value),
      allowUsers: split(form.elements.allowUsers && form.elements.allowUsers.value),
      allowAll: !!(form.elements.allowAll && form.elements.allowAll.checked),
      prompt: form.elements.prompt ? form.elements.prompt.value : '',
      settings: {},
      secrets: {}
    };
    if (form.elements.ownerIds) draft.ownerIds = split(form.elements.ownerIds.value);
    if (form.elements.pairing) draft.pairing = !!form.elements.pairing.checked;
    var id = form.elements.channelId ? form.elements.channelId.value : '';
    if (id) draft.id = id;
    var settings = form.querySelectorAll('[data-setting]');
    for (var i = 0; i < settings.length; i++) draft.settings[settings[i].getAttribute('data-setting')] = settings[i].value.trim();
    var secrets = form.querySelectorAll('[data-secret]');
    for (var j = 0; j < secrets.length; j++) if (secrets[j].value) draft.secrets[secrets[j].getAttribute('data-secret')] = secrets[j].value;
    return draft;
  }

  var polling = null;
  var shownQr = '';
  function stopPolling() { if (polling) { clearTimeout(polling); polling = null; } }

  function showQr(loginId) {
    return qc.loadHtml('/fragments/im/qr/' + encodeURIComponent(loginId)).then(function (html) {
      var mount = byId('channel-qr');
      if (mount) mount.innerHTML = html;
    });
  }

  var WORDS = { wait: '用微信扫一扫', scanned: '已扫码，请在手机上确认', expired: '二维码已过期，请重新扫码', failed: '登录失败' };

  function poll(loginId) {
    qc.sendJson('GET', '/v0/im/login/' + encodeURIComponent(loginId)).then(function (view) {
      if (view.qr && view.qr !== shownQr) { shownQr = view.qr; showQr(loginId); }
      if (view.state === 'confirmed') {
        stopPolling();
        qc.closeDialog(byId('channel-login'));
        qc.toast('微信已接入', 'ok');
        refresh();
        return;
      }
      qc.setText('channel-login-state', (WORDS[view.state] || view.state) + (view.detail ? ' · ' + view.detail : ''));
      if (view.state === 'failed' || view.state === 'expired') { stopPolling(); return; }
      polling = setTimeout(function () { poll(loginId); }, 2000);
    }).catch(function (err) {
      stopPolling();
      qc.setText('channel-login-state', qc.failLine('登录', err));
    });
  }

  function login(draft) {
    stopPolling();
    return qc.sendJson('POST', '/v0/im/login', draft).then(function (view) {
      shownQr = view.qr;
      qc.setText('channel-login-state', WORDS.wait);
      return showQr(view.loginId).then(function () {
        qc.openDialog('channel-login', null);
        var box = byId('channel-login');
        if (box) box.addEventListener('close', stopPolling, { once: true });
        poll(view.loginId);
      });
    });
  }

  qc.onSubmit('channel-form', function (form) {
    var status = byId('channel-status');
    var draft = draftOf(form);
    if (!draft.name) { qc.say(status, '名称必填', 'bad'); return; }
    if (!draft.target) { qc.say(status, '请选主人对话的智能体', 'bad'); return; }
    var qr = form.elements.qrLogin && form.elements.qrLogin.value === '1';
    if (qr && !draft.id) {
      qc.say(status, '正在获取二维码', 'muted');
      login(draft).then(function () {
        qc.closeDialog(byId('channel-dialog'));
      }).catch(function (err) { qc.say(status, qc.failLine('扫码', err), qc.failTone(err)); });
      return;
    }
    qc.say(status, '保存中', 'muted');
    qc.sendJson('POST', '/v0/im', draft).then(function () {
      qc.closeDialog(byId('channel-dialog'));
      qc.toast('已保存 ' + draft.name, 'ok');
      return refresh();
    }).catch(function (err) { qc.say(status, qc.failLine('保存', err), qc.failTone(err)); });
  });

  qc.onAction('channel-relogin', function (button) {
    var id = button.getAttribute('data-id') || '';
    qc.sendJson('GET', '/v0/im').then(function (snapshot) {
      var found = (snapshot.channels || []).filter(function (one) { return one.id === id; })[0];
      if (!found) throw new Error('没有这个渠道');
      return login({ id: found.id, name: found.name, platform: found.platform, target: found.target, memberTarget: found.memberTarget });
    }).catch(function (err) { qc.toast(qc.failLine('扫码', err), qc.failTone(err)); });
  });

  qc.onAction('channel-toggle', function (button) {
    var id = button.getAttribute('data-id') || '';
    var name = button.getAttribute('data-name') || '';
    var enabled = button.getAttribute('data-enabled') === '1';
    qc.sendJson('GET', '/v0/im').then(function (snapshot) {
      var found = (snapshot.channels || []).filter(function (one) { return one.id === id; })[0];
      if (!found) throw new Error('没有这个渠道');
      return qc.sendJson('POST', '/v0/im', { id: id, name: found.name, platform: found.platform, target: found.target, enabled: enabled });
    }).then(function () {
      qc.toast((enabled ? '已启用 ' : '已停用 ') + name, 'ok');
      return refresh();
    }).catch(function (err) { qc.toast(qc.failLine(enabled ? '启用' : '停用', err), qc.failTone(err)); });
  });

  var DECIDED = { owner: '已设为主人', member: '已设为成员', deny: '已拒绝' };
  qc.onAction('channel-pair', function (button) {
    var id = button.getAttribute('data-id') || '';
    var decision = button.getAttribute('data-decision') || '';
    var name = button.getAttribute('data-name') || '';
    qc.sendJson('POST', '/v0/im/' + encodeURIComponent(id) + '/pairing', {
      requestId: button.getAttribute('data-request') || '',
      decision: decision
    }).then(function () {
      qc.toast((DECIDED[decision] || '已处理') + ' ' + name, 'ok');
      return refresh();
    }).catch(function (err) { qc.toast(qc.failLine('配对', err), qc.failTone(err)); });
  });

  qc.onAction('channel-remove', function (button) {
    var id = button.getAttribute('data-id') || '';
    var name = button.getAttribute('data-name') || '';
    qc.setText('confirm-channel-remove-name', name);
    qc.openDialog('confirm-channel-remove', function () {
      qc.sendJson('DELETE', '/v0/im/' + encodeURIComponent(id)).then(function () {
        qc.toast('已删除 ' + name, 'ok');
        return refresh();
      }).catch(function (err) { qc.toast(qc.failLine('删除', err), qc.failTone(err)); });
    });
  });
})();
`
