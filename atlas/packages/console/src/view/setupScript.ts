// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 初始化配置页的脚本（`view/setup.ts`）。每个动作都走已有的接口，做完整页刷新：
 * 页面上的每一步都是当场从端口读的，刷新就是最准的结果。
 *
 * - 创建运维账号：`POST /v0/accounts/invites {role:'ops'}`，拿到一次性链接就在
 *   本浏览器打开（令牌在 `#` 后，不进服务器日志）。
 * - 接入模型：`POST /v0/providers/profiles`（预设 + 密钥）→
 *   `PUT /v0/providers/default` → `POST /v0/providers/apply`。下发失败不回滚
 *   前两步：档案与默认已经存下，提示去模型页看各节点。
 * - 主智能体：`PUT /v0/setup/main {address}`，恢复启动参数时 `address: null`。
 */

export const SETUP_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;

  function reload() { window.location.reload(); }

  qc.onAction('setup-ops-invite', function () {
    return qc.sendJson('POST', '/v0/accounts/invites', { role: 'ops', label: '初始化配置' }).then(function (data) {
      if (!data || typeof data.link !== 'string') throw new Error('没有拿到邀请链接');
      window.location.href = data.link;
    }).catch(function (err) { qc.toast(qc.failLine('创建邀请', err), qc.failTone(err)); });
  });

  qc.onSubmit('setup-model-form', function (form) {
    var preset = form.elements.presetId ? form.elements.presetId.value : '';
    var key = form.elements.key ? form.elements.key.value.trim() : '';
    if (!preset) { qc.toast('先选一个服务', 'bad'); return; }
    if (!key) { qc.markField(form, 'key', '密钥必填'); return; }
    var profileId = '';
    return qc.sendJson('POST', '/v0/providers/profiles', {
      presetId: preset,
      profile: {},
      secrets: { k1: key }
    }).then(function (data) {
      profileId = data && data.profile ? data.profile.id : '';
      if (!profileId) throw new Error('保存后没有拿到档案');
      return qc.sendJson('PUT', '/v0/providers/default', { profileId: profileId });
    }).then(function () {
      return qc.sendJson('POST', '/v0/providers/apply', {}).catch(function (err) {
        qc.toast('已设为默认 · 下发没有全部成功 · 去模型页看各节点', 'warn', qc.message(err));
      });
    }).then(function () {
      form.elements.key.value = '';
      qc.toast('模型已接入', 'ok');
      reload();
    }).catch(function (err) {
      qc.toast(qc.failLine(profileId ? '设为默认' : '保存', err), qc.failTone(err));
    });
  });

  qc.onSubmit('setup-main-form', function (form) {
    var address = form.elements.address ? form.elements.address.value : '';
    if (!address) { qc.toast('先选一个智能体', 'bad'); return; }
    return qc.sendJson('PUT', '/v0/setup/main', { address: address }).then(function () {
      qc.toast('主智能体已更新', 'ok');
      reload();
    }).catch(function (err) { qc.toast(qc.failLine('保存', err), qc.failTone(err)); });
  });

  qc.onAction('setup-main-reset', function () {
    return qc.sendJson('PUT', '/v0/setup/main', { address: null }).then(function () {
      qc.toast('已恢复启动参数', 'ok');
      reload();
    }).catch(function (err) { qc.toast(qc.failLine('恢复', err), qc.failTone(err)); });
  });
})();
`
