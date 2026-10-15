// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 扩展's page script (`view/extensions.ts`). The form body is the server's
 * (`/fragments/extensions/form`); this script shows the parts that fit the
 * chosen transport or source and turns the form into a draft for
 * `/v0/extensions`.
 */

export const EXTENSIONS_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var WORDS = { mcp: '连接器', skill: '技能', plugin: '插件' };

  function refresh() {
    var mount = byId('extensions');
    return mount ? qc.refreshRegion(mount) : Promise.resolve();
  }

  function value(form, name) {
    var field = form.elements[name];
    return field && typeof field.value === 'string' ? field.value.trim() : '';
  }

  function sync(form) {
    var blocks = form.querySelectorAll('[data-when]');
    for (var i = 0; i < blocks.length; i++) {
      var rule = blocks[i].getAttribute('data-when').split(':');
      var shown = rule[1].split(',').indexOf(value(form, rule[0])) >= 0;
      blocks[i].hidden = !shown;
    }
  }

  function open(query, title) {
    var body = byId('extension-body');
    if (!body) return;
    qc.say(byId('extension-status'), '', 'muted');
    qc.setText('extension-title', title);
    qc.loadHtml('/fragments/extensions/form' + query).then(function (html) {
      body.innerHTML = html;
      sync(byId('extension-form'));
      qc.openDialog('extension-dialog', null);
    }).catch(function (err) { qc.toast(qc.failLine('打开', err), qc.failTone(err)); });
  }

  qc.onAction('extension-new', function (button) {
    var kind = button.getAttribute('data-kind') || 'mcp';
    open('?kind=' + encodeURIComponent(kind), '添加' + (WORDS[kind] || '扩展'));
  });
  qc.onAction('extension-edit', function (button) {
    var kind = button.getAttribute('data-kind') || 'mcp';
    open('?id=' + encodeURIComponent(button.getAttribute('data-id') || ''), '编辑' + (WORDS[kind] || '扩展'));
  });

  document.addEventListener('change', function (event) {
    var form = event.target && event.target.closest && event.target.closest('#extension-form');
    if (form) sync(form);
  });

  function lines(text) {
    return String(text || '').split('\\n').map(function (line) { return line.trim(); }).filter(Boolean);
  }

  /** "NAME=value" sets, a bare "NAME" keeps what the hub has. */
  function pairs(text) {
    var out = {};
    lines(text).forEach(function (line) {
      var at = line.indexOf('=');
      if (at < 0) out[line] = null;
      else out[line.slice(0, at).trim()] = line.slice(at + 1);
    });
    return out;
  }

  function draftOf(form) {
    var kind = value(form, 'kind');
    var draft = { kind: kind, enabled: !!(form.elements.enabled && form.elements.enabled.checked), agents: [] };
    var id = value(form, 'extensionId');
    if (id) draft.id = id;
    var boxes = form.querySelectorAll('input[name="agents"]:checked');
    for (var i = 0; i < boxes.length; i++) draft.agents.push(boxes[i].value);
    var name = value(form, 'name');
    if (name) draft.name = name;
    if (kind === 'mcp') {
      draft.transport = value(form, 'transport');
      draft.approval = value(form, 'approval');
      if (draft.transport === 'stdio') {
        draft.command = value(form, 'command');
        draft.args = lines(form.elements.args && form.elements.args.value);
        draft.env = pairs(form.elements.env && form.elements.env.value);
      } else {
        draft.url = value(form, 'url');
        draft.headers = pairs(form.elements.headers && form.elements.headers.value);
      }
    } else if (kind === 'skill' && value(form, 'from') === 'inline') {
      draft.description = value(form, 'description');
      draft.body = form.elements.body ? form.elements.body.value : '';
    } else {
      draft.source = { repo: value(form, 'repo'), ref: value(form, 'ref'), path: value(form, 'path') };
    }
    return draft;
  }

  qc.onSubmit('extension-form', function (form) {
    var status = byId('extension-status');
    var draft = draftOf(form);
    if (draft.kind === 'mcp' && !draft.name) { qc.say(status, '名称必填', 'bad'); return; }
    if (draft.source && !draft.source.repo) { qc.say(status, '仓库必填', 'bad'); return; }
    qc.say(status, draft.source ? '正在解析仓库' : '保存中', 'muted');
    qc.sendJson('POST', '/v0/extensions', draft).then(function (view) {
      qc.closeDialog(byId('extension-dialog'));
      qc.toast('已保存 ' + view.name + ' · 正在下发', 'ok');
      return refresh();
    }).catch(function (err) { qc.say(status, qc.failLine('保存', err), qc.failTone(err)); });
  });

  qc.onAction('extension-toggle', function (button) {
    var id = button.getAttribute('data-id') || '';
    var name = button.getAttribute('data-name') || '';
    var enabled = button.getAttribute('data-enabled') === '1';
    qc.sendJson('POST', '/v0/extensions', { id: id, enabled: enabled }).then(function () {
      qc.toast((enabled ? '已启用 ' : '已停用 ') + name, 'ok');
      return refresh();
    }).catch(function (err) { qc.toast(qc.failLine(enabled ? '启用' : '停用', err), qc.failTone(err)); });
  });

  qc.onAction('extension-remove', function (button) {
    var id = button.getAttribute('data-id') || '';
    var name = button.getAttribute('data-name') || '';
    qc.setText('confirm-extension-remove-name', name);
    qc.openDialog('confirm-extension-remove', function () {
      qc.sendJson('DELETE', '/v0/extensions/' + encodeURIComponent(id)).then(function () {
        qc.toast('已删除 ' + name, 'ok');
        return refresh();
      }).catch(function (err) { qc.toast(qc.failLine('删除', err), qc.failTone(err)); });
    });
  });
})();
`
