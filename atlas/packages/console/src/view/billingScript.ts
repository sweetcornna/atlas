// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The scripts of the subscription pages (`view/billing.ts`).
 *
 * {@link BILLING_PUBLIC_JS} serves `/subscription` and the QR step of
 * `/subscription/checkout`. Those pages are outside the management shell,
 * so it does not lean on the shared runtime: it sends its own JSON with the
 * console header (`auth.ts`, a cookie alone does not open a guarded route),
 * shows failures through the same tables as every other page
 * (`view/errors.ts`), and polls one order until it is paid or closed.
 *
 * {@link BILLING_ADMIN_JS} is 订阅's page script, on the shared runtime like
 * every area page: grant, codes (shown once), refund registration, a chain
 * check.
 */

import { CONSOLE_HEADER } from '../auth.js'
import { errorTableJson } from './errors.js'

export const BILLING_PUBLIC_JS = `
(function () {
  'use strict';
  var ERRORS = ${errorTableJson()};
  var UNCLEAN = new RegExp(ERRORS.unclean);
  var CJK = new RegExp(ERRORS.cjk);

  function byId(id) { return document.getElementById(id); }

  function line(code, status, raw) {
    var text = String(raw || '').trim();
    if (text.length > 0 && text.length <= ERRORS.maxClean && CJK.test(text) && !UNCLEAN.test(text)) return text;
    if (code && Object.prototype.hasOwnProperty.call(ERRORS.codes, code)) return ERRORS.codes[code];
    if (status && Object.prototype.hasOwnProperty.call(ERRORS.statuses, String(status))) return ERRORS.statuses[String(status)];
    return ERRORS.fallback;
  }

  function send(method, path, body) {
    var init = { method: method, credentials: 'same-origin', headers: { '${CONSOLE_HEADER}': '1', accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (response) {
      if (response.status === 204) return null;
      return response.json().catch(function () { return null; }).then(function (data) {
        if (response.ok) return data;
        var error = data && data.error ? data.error : {};
        throw new Error(line(error.code, response.status, error.message));
      });
    }, function () { throw new Error(line('network', 0, '')); });
  }

  function say(text, tone) {
    var box = byId('bl-status');
    if (!box) return;
    box.textContent = text;
    box.setAttribute('data-tone', tone || 'muted');
  }

  function field(form, name) {
    var input = form.elements[name];
    return input && typeof input.value === 'string' ? input.value.trim() : '';
  }

  function reloadSoon() { setTimeout(function () { location.reload(); }, 600); }

  var redeem = byId('bl-redeem-form');
  if (redeem) redeem.addEventListener('submit', function (event) {
    event.preventDefault();
    var code = field(redeem, 'code');
    if (!code) { say('兑换码必填', 'bad'); return; }
    say('兑换中', 'muted');
    send('POST', '/v0/billing/redeem', { code: code }).then(function () {
      say('兑换成功', 'ok');
      reloadSoon();
    }).catch(function (err) { say('兑换失败 · ' + err.message, 'bad'); });
  });

  var model = byId('bl-model-form');
  if (model) model.addEventListener('submit', function (event) {
    event.preventDefault();
    var preset = field(model, 'preset');
    var key = model.elements.key ? model.elements.key.value.trim() : '';
    if (!preset || !key) { say('预设与密钥都要填', 'bad'); return; }
    say('接入中', 'muted');
    send('POST', '/v0/billing/models', { preset: preset, key: key }).then(function () {
      model.elements.key.value = '';
      say('已接入', 'ok');
      reloadSoon();
    }).catch(function (err) { say('接入失败 · ' + err.message, 'bad'); });
  });

  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('[data-action="bl-model-remove"]') : null;
    if (!button) return;
    var id = button.getAttribute('data-id') || '';
    var name = button.getAttribute('data-name') || id;
    if (!window.confirm('删除上游 ' + name)) return;
    send('DELETE', '/v0/billing/models/' + encodeURIComponent(id)).then(function () {
      say('已删除 ' + name, 'ok');
      reloadSoon();
    }).catch(function (err) { say('删除失败 · ' + err.message, 'bad'); });
  });

  var WORD = { created: '等待付款', paid: '已支付 · 订阅已生效', closed: '订单已关闭', expired: '订单已过期', refunded: '已退款' };
  var order = byId('bl-order');
  if (order && order.getAttribute('data-state') === 'created') {
    var id = order.getAttribute('data-order') || '';
    var timer = setInterval(function () {
      send('GET', '/v0/billing/orders/' + encodeURIComponent(id)).then(function (view) {
        if (!view || view.status === 'created') return;
        clearInterval(timer);
        order.setAttribute('data-state', view.status);
        order.textContent = WORD[view.status] || view.status;
        var qr = document.querySelector('.bl-qr');
        if (qr) qr.hidden = true;
      }).catch(function () {});
    }, 3000);
  }
})();
`

export const BILLING_ADMIN_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;

  function value(form, name) {
    var field = form.elements[name];
    return field && typeof field.value === 'string' ? field.value.trim() : '';
  }

  function reloadSoon() { setTimeout(function () { location.reload(); }, 800); }

  qc.onAction('bl-grant', function () {
    qc.say(byId('bl-grant-status'), '', 'muted');
    qc.openDialog('bl-grant-dialog', null);
  });

  qc.onAction('bl-codes', function () {
    qc.say(byId('bl-codes-status'), '', 'muted');
    var result = byId('bl-codes-result');
    if (result) result.hidden = true;
    var fields = byId('bl-codes-fields');
    if (fields) fields.hidden = false;
    qc.openDialog('bl-codes-dialog', null);
  });

  qc.onAction('bl-refund', function (button) {
    var form = byId('bl-refund-form');
    if (form && form.elements.order) form.elements.order.value = button.getAttribute('data-order') || '';
    qc.say(byId('bl-refund-status'), '', 'muted');
    qc.openDialog('bl-refund-dialog', null);
  });

  qc.onAction('bl-verify', function () {
    qc.sendJson('GET', '/v0/billing/admin/verify').then(function (chain) {
      if (chain && chain.ok) qc.toast('账本完整 · ' + chain.events + ' 条事件', 'ok');
      else qc.toast('账本不一致 · 第 ' + (chain && chain.seq) + ' 条', 'bad');
    }).catch(function (err) { qc.toast(qc.failLine('校验', err), qc.failTone(err)); });
  });

  qc.onSubmit('bl-grant-form', function (form) {
    var status = byId('bl-grant-status');
    var body = { subject: value(form, 'subject'), planId: value(form, 'plan'), periods: Number(value(form, 'periods')), reason: value(form, 'reason') };
    if (!body.subject || !body.reason) { qc.say(status, '账号与原因必填', 'bad'); return; }
    qc.say(status, '开通中', 'muted');
    qc.sendJson('POST', '/v0/billing/admin/grant', body).then(function () {
      qc.closeDialog(byId('bl-grant-dialog'));
      qc.toast('已开通', 'ok');
      reloadSoon();
    }).catch(function (err) { qc.say(status, qc.failLine('开通', err), qc.failTone(err)); });
  });

  qc.onSubmit('bl-codes-form', function (form) {
    var status = byId('bl-codes-status');
    var result = byId('bl-codes-result');
    if (result && !result.hidden) { qc.closeDialog(byId('bl-codes-dialog')); reloadSoon(); return; }
    var body = { planId: value(form, 'plan'), periods: Number(value(form, 'periods')), count: Number(value(form, 'count')) };
    var days = value(form, 'days');
    if (days) body.expiresInDays = Number(days);
    qc.say(status, '生成中', 'muted');
    qc.sendJson('POST', '/v0/billing/admin/codes', body).then(function (answer) {
      var out = byId('bl-codes-out');
      if (out) out.value = ((answer && answer.codes) || []).join('\\n');
      var fields = byId('bl-codes-fields');
      if (fields) fields.hidden = true;
      if (result) result.hidden = false;
      qc.say(status, '已生成 · 关掉之后不再显示', 'ok');
    }).catch(function (err) { qc.say(status, qc.failLine('生成', err), qc.failTone(err)); });
  });

  qc.onSubmit('bl-refund-form', function (form) {
    var status = byId('bl-refund-status');
    var body = { orderId: value(form, 'order'), reason: value(form, 'reason') };
    if (!body.orderId || !body.reason) { qc.say(status, '订单与原因必填', 'bad'); return; }
    qc.say(status, '登记中', 'muted');
    qc.sendJson('POST', '/v0/billing/admin/refund', body).then(function () {
      qc.closeDialog(byId('bl-refund-dialog'));
      qc.toast('已登记退款', 'ok');
      reloadSoon();
    }).catch(function (err) { qc.say(status, qc.failLine('登记', err), qc.failTone(err)); });
  });
})();
`
