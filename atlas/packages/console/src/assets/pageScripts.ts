// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The page scripts of the areas that have one, as strings.
 *
 * Each runs after the shared runtime (`client.ts`) on its own page only
 * (`routes/types.ts`, `PageRoute.script`), and reaches the runtime through
 * `window.qianmoConsole`. They hold what used to be the one page script's
 * area-specific half — the register, wake, heartbeat and deregister actions,
 * the chain panel, the server note — moved without changing what any of them
 * sends. The runtime's rules hold here too: the server renders HTML, the
 * client renders text, and every response string reaches the page through
 * `textContent`.
 */

/** 节点: register, wake, heartbeat, deregister. */
export const NODES_PAGE_JS = `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var say = qc.say;
  var setText = qc.setText;

  var ROUTES = { agents: '/v0/agents', wake: '/v0/wake' };

  function refreshRoster() {
    var mount = byId('roster');
    return mount ? qc.refreshRegion(mount) : Promise.resolve();
  }

  function fieldValue(form, name) {
    var el = form.elements[name];
    return el && typeof el.value === 'string' ? el.value.trim() : '';
  }

  // Capabilities are four checkboxes sharing one name, so the value is every
  // ticked box rather than one string to split. The server still accepts the
  // comma-separated form an older client would have sent.
  function checkedValues(form, name) {
    var out = [];
    var nodes = form.querySelectorAll('input[name="' + name + '"]:checked');
    for (var i = 0; i < nodes.length; i++) out.push(nodes[i].value);
    return out;
  }

  // The registry's own grammar (protocol address.ts, registry.ts
  // isValidEndpoint), checked here first: a typo is caught on the field it is
  // in, instead of coming back from the registry as a refusal in English (D3).
  var SEGMENT = '[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?';
  var ADDRESS = new RegExp('^qianmo://' + SEGMENT + '/' + SEGMENT + '$');
  var SCHEMES = ['ws:', 'wss:', 'http:', 'https:', 'ws+unix:'];
  var ADDRESS_FORMAT = '格式应为 qianmo://节点/智能体 · 小写字母 数字 - _';
  var ENDPOINT_FORMAT = '格式应为 ws://主机:端口 或 qianmo:// 地址';

  function addressWhy(value) {
    if (!value) return '必填';
    return ADDRESS.test(value) ? '' : ADDRESS_FORMAT;
  }

  function endpointWhy(value) {
    if (!value) return '必填';
    if (value.length > 512) return '过长 · 上限 512 字符';
    if (ADDRESS.test(value)) return '';
    try {
      if (SCHEMES.indexOf(new URL(value).protocol) !== -1) return '';
    } catch (e) { /* not a URL at all */ }
    return ENDPOINT_FORMAT;
  }

  var REGISTER_RULES = { address: addressWhy, endpoint: endpointWhy };

  // What a field the registry refused is told, when the refusal names it.
  var REGISTER_REFUSED = {
    address: ADDRESS_FORMAT,
    endpoint: ENDPOINT_FORMAT,
    publicKey: '应为 base64url 编码的 Ed25519 公钥',
    capabilities: '能力不合法',
    status: '状态不合法'
  };

  // A refusal that names a field is said on the field; the rest in the
  // status line and the corner, as before.
  function refusedOnField(form, err, table) {
    var name = qc.fieldOf(err, Object.keys(table));
    if (!name) return false;
    var said = table[name];
    var el = qc.markField(form, name, typeof said === 'function' ? said(form) : said);
    if (el) el.focus();
    return el !== null;
  }

  function onRegister(form) {
    var status = byId('register-status');
    if (!qc.checkFields(form, REGISTER_RULES)) {
      say(status, '有字段需要修改', 'bad');
      return;
    }
    var address = fieldValue(form, 'address');
    var endpoint = fieldValue(form, 'endpoint');
    var body = {
      address: address,
      endpoint: endpoint,
      capabilities: checkedValues(form, 'capabilities'),
      status: fieldValue(form, 'status') || 'online'
    };
    var key = fieldValue(form, 'publicKey');
    if (key) body.publicKey = key;
    say(status, '注册中…', 'muted');
    qc.sendJson('POST', ROUTES.agents, body).then(function () {
      say(status, '', 'muted');
      qc.clearFields(form);
      form.reset();
      qc.closeDialog(byId('register-dialog'));
      qc.toast('已注册 ' + address, 'ok');
      return refreshRoster();
    }).catch(function (err) {
      // Said where the form is, and in the corner: the dialog may be the
      // thing the operator is looking at, or the thing they just closed.
      say(status, qc.failLine('注册', err), qc.failTone(err));
      if (refusedOnField(form, err, REGISTER_REFUSED)) return;
      qc.toast(qc.failLine('注册', err), qc.failTone(err));
    });
  }

  var WAKE_REFUSED = {
    afterMs: function (form) {
      var box = form.elements['afterMs'];
      return '应为 0 到 ' + (box ? box.getAttribute('max') : '') + ' 之间的整数毫秒';
    },
    prompt: '必填'
  };

  // The 回调 field is gone from the form: the console can only ever wake the
  // one URL it was started with, so url is left out of the body entirely and
  // the server falls back to the pinned one.
  function afterWhy(value, el) {
    if (!value) return '';
    var max = Number(el.getAttribute('max')) || 0;
    var n = Number(value);
    return Math.floor(n) === n && n >= 0 && (max === 0 || n <= max) ? '' :
      '应为 0 到 ' + max + ' 之间的整数毫秒';
  }

  var WAKE_RULES = {
    // A text box when there is no roster to choose from; a select is always
    // one of the roster's own addresses.
    to: function (value, el) { return el.tagName === 'SELECT' ? (value ? '' : '必选') : addressWhy(value); },
    prompt: function (value) { return value ? '' : '必填'; },
    afterMs: afterWhy
  };

  function onWake(form) {
    var status = byId('wake-status');
    if (!qc.checkFields(form, WAKE_RULES)) {
      say(status, '有字段需要修改', 'bad');
      return;
    }
    var body = {
      from: fieldValue(form, 'from'),
      to: fieldValue(form, 'to'),
      prompt: fieldValue(form, 'prompt')
    };
    var node = fieldValue(form, 'node');
    if (node) body.node = node;
    var after = fieldValue(form, 'afterMs');
    if (after) body.afterMs = Number(after);
    if (!body.from) {
      say(status, '发起方为空 · 在高级选项里填写', 'bad');
      return;
    }
    say(status, '', 'muted');
    setText('confirm-wake-to', body.to);
    setText('confirm-wake-from', body.from);
    setText('confirm-wake-after', (body.afterMs || 0) + ' ms');
    setText('confirm-wake-prompt', body.prompt);
    qc.openDialog('confirm-wake', function () { doWake(form, body); });
  }

  function doWake(form, body) {
    var status = byId('wake-status');
    say(status, '唤醒中…', 'muted');
    qc.sendJson('POST', ROUTES.wake, body).then(function (data) {
      var receipt = data && data.receipt ? String(data.receipt) : '';
      var task = data && data.taskId ? String(data.taskId) : '';
      // The button says 唤醒, so the result says 已唤醒. An operator should not
      // have to work out whether 已发送 is the same event they asked for.
      var line = '已唤醒 · task ' + task + (receipt ? ' · 回执 ' + receipt : '');
      say(status, line, 'ok');
      qc.toast(line, 'ok');
    }).catch(function (err) {
      say(status, qc.failLine('唤醒', err), qc.failTone(err));
      if (refusedOnField(form, err, WAKE_REFUSED)) return;
      qc.toast(qc.failLine('唤醒', err), qc.failTone(err));
    });
  }

  // A row's two actions report in the corner: the row itself is replaced by
  // the refresh that follows, so a line written into it would not survive.
  function onHeartbeat(el) {
    var address = el.getAttribute('data-address') || '';
    qc.sendJson('POST', ROUTES.agents + '/' + encodeURIComponent(address) + '/heartbeat')
      .then(function () {
        qc.toast('已心跳 ' + address, 'ok');
        return refreshRoster();
      })
      .catch(function (err) { qc.toast(qc.failLine('心跳', err), qc.failTone(err)); });
  }

  function onDeregister(el) {
    var address = el.getAttribute('data-address') || '';
    setText('confirm-deregister-addr', address);
    qc.openDialog('confirm-deregister', function () { doDeregister(address); });
  }

  function doDeregister(address) {
    qc.sendJson('DELETE', ROUTES.agents + '/' + encodeURIComponent(address))
      .then(function () {
        qc.toast('已注销 ' + address, 'ok');
        return refreshRoster();
      })
      .catch(function (err) { qc.toast(qc.failLine('注销', err), qc.failTone(err)); });
  }

  // The roster filter is a native GET and stays one: it works with this
  // script disabled. All that is added is dropping the empty boxes, so the
  // resulting URL is the shortest thing that reproduces this view (D6).
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || form.id !== 'roster-filter') return;
    var controls = form.querySelectorAll('input, select');
    for (var i = 0; i < controls.length; i++) {
      if (controls[i].value === '') controls[i].disabled = true;
    }
  });
  // Back to this page from the history cache: the boxes are usable again.
  window.addEventListener('pageshow', function () {
    var form = document.getElementById('roster-filter');
    if (!form) return;
    var controls = form.querySelectorAll('input, select');
    for (var i = 0; i < controls.length; i++) controls[i].disabled = false;
  });

  qc.onAction('heartbeat', onHeartbeat);
  qc.onAction('deregister', onDeregister);
  qc.onSubmit('register-form', onRegister);
  qc.onSubmit('wake-form', onWake);
})();
`

/** 消息链: the chain panel, and the filter form's shortest URL. */
export const AUDIT_PAGE_JS = `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;

  // Markup, not JSON: /v0/audit/chain/ answers with the data and loadHtml
  // rejects anything that is not text/html.
  var CHAIN = '/fragments/chain/';

  function openChain(el) {
    var panel = byId('chain');
    var trace = el.getAttribute('data-trace') || '';
    var node = el.getAttribute('data-audit-node') || '';
    if (!panel || !trace) return;
    var path = CHAIN + encodeURIComponent(trace);
    if (node) path += '?node=' + encodeURIComponent(node);
    qc.loadHtml(path).then(function (html) {
      panel.innerHTML = html;
      panel.hidden = false;
      panel.scrollIntoView({ block: 'nearest' });
    }).catch(function (err) {
      // textContent, never innerHTML: this string can carry a server message.
      panel.textContent = '消息链加载失败 · ' + qc.message(err);
      panel.hidden = false;
    });
  }

  function closeChain() {
    var panel = byId('chain');
    if (panel) { panel.hidden = true; panel.textContent = ''; }
  }

  qc.onAction('chain', openChain);
  qc.onAction('chain-close', closeChain);

  // The filter is a native GET and stays one: it works with this script
  // disabled. All that is added is dropping the empty boxes, so the resulting
  // URL is the shortest thing that reproduces this view.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || form.id !== 'audit-filter') return;
    var controls = form.querySelectorAll('input, select');
    for (var i = 0; i < controls.length; i++) {
      if (controls[i].value === '') controls[i].disabled = true;
    }
  });
  // Back to this page from the history cache: the boxes are usable again.
  window.addEventListener('pageshow', function () {
    var form = document.getElementById('roster-filter');
    if (!form) return;
    var controls = form.querySelectorAll('input, select');
    for (var i = 0; i < controls.length; i++) controls[i].disabled = false;
  });
})();
`

/** 服务器: saving a note. */
export const SERVERS_PAGE_JS = `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;

  // The servers page is never polled, because it holds a textarea somebody may
  // be mid-sentence in. So a save reports itself in place, through the status
  // line beside the button, and nothing on the page is re-fetched afterwards.
  function onServerNote(el) {
    var card = el.closest('[data-server]');
    var server = el.getAttribute('data-server') || '';
    if (!card || !server) return;
    var box = card.querySelector('textarea[name="note"]');
    var status = card.querySelector('[data-role="note-status"]');
    if (!box) return;
    qc.say(status, '保存中…', 'muted');
    qc.sendJson('PUT', '/v0/servers/' + encodeURIComponent(server) + '/note',
      { note: box.value })
      .then(function () {
        qc.say(status, '已保存 ' + qc.stamp(new Date()), 'ok');
        qc.toast('备注已保存 · ' + server, 'ok');
      })
      .catch(function (err) {
        qc.say(status, qc.failLine('保存', err), qc.failTone(err));
        qc.toast(qc.failLine('保存', err), qc.failTone(err));
      });
  }

  qc.onAction('server-note', onServerNote);
})();
`
