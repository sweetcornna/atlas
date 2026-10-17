// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 网关's page script (`view/magpie.ts`). Form bodies are the server's
 * (`/fragments/magpie/form`); this script turns them into the JSON
 * `/v0/magpie` takes, asks before anything that cannot be undone, and moves
 * the usage section between periods. Addresses are put together here from
 * a scheme and a host, so the page itself never carries a full URL.
 *
 * The 智能体 section (`view/magpieAgents.ts`) sends a select's change at once
 * to `/v0/magpie/agents/configure`, and while a runtime installs it follows
 * the section every few seconds until nothing is busy.
 */

export const MAGPIE_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;

  function refresh() {
    var jobs = [];
    var main = byId('magpie');
    var agents = byId('magpie-agents');
    var usage = byId('magpie-usage');
    if (main) jobs.push(qc.refreshRegion(main));
    if (agents) jobs.push(qc.refreshRegion(agents));
    if (usage) jobs.push(qc.refreshRegion(usage));
    return Promise.all(jobs);
  }

  var following = null;
  function stopFollowing() {
    if (following !== null) clearInterval(following);
    following = null;
  }
  function follow() {
    if (following !== null) return;
    following = setInterval(function () {
      var mount = byId('magpie-agents');
      if (!mount || qc.isExpired()) { stopFollowing(); return; }
      qc.refreshRegion(mount).then(function () {
        if (!mount.querySelector('[data-busy]')) stopFollowing();
      }).catch(function () {});
    }, 3000);
  }
  qc.onExpire(stopFollowing);
  if (document.querySelector('#magpie-agents [data-busy]')) follow();

  function value(form, name) {
    var field = form.elements[name];
    return field && typeof field.value === 'string' ? field.value.trim() : '';
  }

  function lines(text) {
    return String(text || '').split('\\n').map(function (line) { return line.trim(); }).filter(Boolean);
  }

  function number(text) {
    if (text === '') return undefined;
    var n = Number(text);
    return isFinite(n) ? n : undefined;
  }

  function open(kind, id, title) {
    var body = byId('magpie-body');
    if (!body) return;
    qc.say(byId('magpie-status'), '', 'muted');
    qc.setText('magpie-title', title);
    var query = '?kind=' + encodeURIComponent(kind) + (id ? '&id=' + encodeURIComponent(id) : '');
    qc.loadHtml('/fragments/magpie/form' + query).then(function (html) {
      body.innerHTML = html;
      qc.openDialog('magpie-dialog', null);
    }).catch(function (err) { qc.toast(qc.failLine('打开', err), qc.failTone(err)); });
  }

  function confirmThen(what, note, run) {
    qc.setText('confirm-magpie-what', what);
    qc.setText('confirm-magpie-note', note);
    qc.openDialog('confirm-magpie', run);
  }

  function done(text) {
    qc.toast(text, 'ok');
    return refresh();
  }

  function failed(verb) {
    return function (err) { qc.toast(qc.failLine(verb, err), qc.failTone(err)); };
  }

  qc.onAction('magpie-connect', function () { open('connect', '', '连接 magpie'); });
  qc.onAction('magpie-provider-new', function () { open('provider', '', '添加上游'); });
  qc.onAction('magpie-group-new', function () { open('group', '', '新建路由组'); });
  qc.onAction('magpie-group-edit', function (button) {
    open('group', button.getAttribute('data-id') || '', '编辑路由组');
  });
  qc.onAction('magpie-key-new', function () { open('key', '', '为节点签发网关密钥'); });
  qc.onAction('magpie-key-edit', function (button) {
    open('key', button.getAttribute('data-binding') || '', '修改网关密钥');
  });

  qc.onAction('magpie-check', function () {
    qc.sendJson('POST', '/v0/magpie/check', {}).then(function (view) {
      var check = view && view.check;
      if (check && check.ok) return done('核对完成' + (check.version ? ' · ' + check.version : ''));
      qc.toast('核对失败' + (check && check.code ? ' · ' + check.code : ''), 'bad');
      return refresh();
    }).catch(failed('核对'));
  });

  function limitsOf(form) {
    var out = [];
    for (var i = 0; i < 5; i++) {
      var period = value(form, 'limitPeriod' + i);
      if (!period) continue;
      var limit = { period: period };
      var span = number(value(form, 'limitSpan' + i));
      if (period === 'days') limit.days = span;
      if (period === 'hours') limit.hours = span;
      var tokens = number(value(form, 'limitTokens' + i));
      var cost = number(value(form, 'limitCost' + i));
      if (tokens !== undefined) limit.tokens = tokens;
      if (cost !== undefined) limit.cost = cost;
      out.push(limit);
    }
    return out;
  }

  function origin(form, prefix) {
    var host = value(form, prefix + 'Host');
    return host ? value(form, prefix + 'Scheme') + '://' + host : '';
  }

  function request(form) {
    var kind = value(form, 'form');
    if (kind === 'connect') {
      var connect = { gatewayUrl: origin(form, 'gateway'), managementUrl: origin(form, 'management') };
      var secret = form.elements.managementKey ? form.elements.managementKey.value : '';
      if (secret) connect.managementKey = secret;
      var port = number(value(form, 'webCookiePort'));
      if (port !== undefined) connect.webCookiePort = port;
      return { path: '/v0/magpie/connection', body: connect, ok: '已保存连接', need: connect.gatewayUrl && connect.managementUrl ? '' : '网关与管理地址都要填' };
    }
    if (kind === 'provider') {
      var provider = { preset: value(form, 'preset') };
      var key = form.elements.key ? form.elements.key.value.trim() : '';
      if (key) provider.key = key;
      if (value(form, 'name')) provider.name = value(form, 'name');
      var urls = 0;
      ['chat', 'responses', 'anthropic'].forEach(function (lane) {
        if (!provider.preset && value(form, lane)) { provider[lane] = value(form, lane); urls += 1; }
      });
      var need = provider.preset ? '' : !urls ? '要选预设或填自定义地址' : provider.name ? '' : '自定义上游要给名称';
      return { path: '/v0/magpie/providers', body: provider, ok: '已添加上游', need: need };
    }
    if (kind === 'group') {
      var group = {
        id: value(form, 'id'),
        name: value(form, 'name'),
        members: lines(form.elements.members && form.elements.members.value),
        routing: value(form, 'routing'),
        affinity: value(form, 'affinity')
      };
      if (value(form, 'from')) group.from = value(form, 'from');
      return { path: '/v0/magpie/groups', body: group, ok: '已保存路由组', need: group.id ? '' : '路由组 id 必填' };
    }
    var binding = value(form, 'binding');
    var models = lines(form.elements.models && form.elements.models.value);
    var draft = {
      mainModel: value(form, 'mainModel'),
      fastModel: value(form, 'fastModel') || null,
      limits: limitsOf(form)
    };
    if (value(form, 'editing')) {
      draft.models = models.length > 0 ? models : null;
      return { path: '/v0/magpie/keys/' + encodeURIComponent(binding), body: draft, ok: '已修改网关密钥', need: draft.mainModel ? '' : '主模型必填' };
    }
    draft.binding = binding;
    draft.lane = value(form, 'lane');
    if (models.length > 0) draft.models = models;
    return { path: '/v0/magpie/keys', body: draft, ok: '已签发 · 正在下发到节点', need: binding && draft.mainModel ? '' : '绑定与主模型必填' };
  }

  qc.onSubmit('magpie-form', function (form) {
    var status = byId('magpie-status');
    var asked = request(form);
    if (asked.need) { qc.say(status, asked.need, 'bad'); return; }
    qc.say(status, '保存中', 'muted');
    qc.sendJson('POST', asked.path, asked.body).then(function () {
      qc.closeDialog(byId('magpie-dialog'));
      return done(asked.ok);
    }).catch(function (err) { qc.say(status, qc.failLine('保存', err), qc.failTone(err)); });
  });

  qc.onAction('magpie-provider-test', function (button) {
    var id = button.getAttribute('data-id') || '';
    var name = button.getAttribute('data-name') || id;
    qc.toast('正在测试 ' + name, 'muted');
    qc.sendJson('POST', '/v0/magpie/providers/' + encodeURIComponent(id) + '/test', {}).then(function (results) {
      var list = results || [];
      var ok = list.length > 0 && list.every(function (one) { return one.ok; });
      var line = list.map(function (one) {
        return one.protocol + ' ' + (one.status === null ? '无应答' : one.status) + ' ' + one.ms + ' ms';
      }).join(' · ');
      qc.toast(name + ' · ' + (line || '没有结果'), ok ? 'ok' : 'bad');
    }).catch(failed('测试'));
  });

  qc.onAction('magpie-provider-toggle', function (button) {
    var id = button.getAttribute('data-id') || '';
    var name = button.getAttribute('data-name') || id;
    var enabled = button.getAttribute('data-enabled') === '1';
    qc.sendJson('POST', '/v0/magpie/providers/' + encodeURIComponent(id), { enabled: enabled }).then(function () {
      return done((enabled ? '已启用 ' : '已停用 ') + name);
    }).catch(failed(enabled ? '启用' : '停用'));
  });

  qc.onAction('magpie-provider-remove', function (button) {
    var id = button.getAttribute('data-id') || '';
    var name = button.getAttribute('data-name') || id;
    confirmThen(name, '从 magpie 删除这个上游 · 用到它的路由组随之少一个成员', function () {
      qc.sendJson('DELETE', '/v0/magpie/providers/' + encodeURIComponent(id)).then(function () {
        return done('已删除 ' + name);
      }).catch(failed('删除'));
    });
  });

  qc.onAction('magpie-group-remove', function (button) {
    var id = button.getAttribute('data-id') || '';
    var name = button.getAttribute('data-name') || id;
    confirmThen(name, '删除路由组 · 白名单里的这一项随后收回', function () {
      qc.sendJson('DELETE', '/v0/magpie/groups/' + encodeURIComponent(id)).then(function () {
        return done('已删除 ' + name);
      }).catch(failed('删除'));
    });
  });

  qc.onAction('magpie-key-toggle', function (button) {
    var binding = button.getAttribute('data-binding') || '';
    var name = button.getAttribute('data-name') || binding;
    var enabled = button.getAttribute('data-enabled') === '1';
    qc.sendJson('POST', '/v0/magpie/keys/' + encodeURIComponent(binding), { enabled: enabled }).then(function () {
      return done((enabled ? '已启用 ' : '已停用 ') + name);
    }).catch(failed(enabled ? '启用' : '停用'));
  });

  qc.onAction('magpie-key-reset', function (button) {
    var binding = button.getAttribute('data-binding') || '';
    var index = Number(button.getAttribute('data-index') || '0');
    qc.sendJson('POST', '/v0/magpie/keys/' + encodeURIComponent(binding), { resetLimit: index }).then(function () {
      return done('已重新计数');
    }).catch(failed('重新计数'));
  });

  qc.onAction('magpie-key-rotate', function (button) {
    var binding = button.getAttribute('data-binding') || '';
    var name = button.getAttribute('data-name') || binding;
    confirmThen(name, 'magpie 生成新值 · 写进模型档案再下发 · 旧值立即失效', function () {
      qc.sendJson('POST', '/v0/magpie/keys/' + encodeURIComponent(binding) + '/rotate', {}).then(function () {
        return done('已轮换 ' + name);
      }).catch(failed('轮换'));
    });
  });

  qc.onAction('magpie-key-remove', function (button) {
    var binding = button.getAttribute('data-binding') || '';
    var name = button.getAttribute('data-name') || binding;
    confirmThen(name, '节点先换回原来的模型档案 · 再删除密钥与档案', function () {
      qc.sendJson('DELETE', '/v0/magpie/keys/' + encodeURIComponent(binding)).then(function (result) {
        return done(result && result.profileKept ? '已收回 ' + name + ' · 档案仍有节点在用 · 已保留' : '已收回 ' + name);
      }).catch(failed('收回'));
    });
  });

  qc.onAction('magpie-autojoin', function (button) {
    var on = button.getAttribute('data-on') === '1';
    qc.sendJson('POST', '/v0/magpie/agents/autojoin', { on: on }).then(function () {
      return done(on ? '新节点自动接入已打开' : '新节点自动接入已关闭');
    }).catch(failed(on ? '打开' : '关闭'));
  });

  qc.onAction('magpie-join', function (button) {
    var node = button.getAttribute('data-node') || '';
    confirmThen(node, '签发网关密钥 · 节点的模型档案换成 magpie 并下发 · 收回密钥即换回', function () {
      qc.sendJson('POST', '/v0/magpie/agents/join', { node: node }).then(function () {
        return done('已接入 ' + node);
      }).catch(failed('接入'));
    });
  });

  qc.onAction('magpie-runtime-install', function (button) {
    var node = button.getAttribute('data-node') || '';
    var runtime = button.getAttribute('data-runtime') || '';
    var name = button.getAttribute('data-name') || runtime;
    qc.sendJson('POST', '/v0/magpie/agents/install', { node: node, runtime: runtime }).then(function (job) {
      var running = job && job.state === 'running';
      if (running) follow();
      return done(running ? node + ' 正在安装 ' + name : node + ' 已安装 ' + name);
    }).catch(failed('安装'));
  });

  qc.onAction('magpie-runtime-remove', function (button) {
    var node = button.getAttribute('data-node') || '';
    var runtime = button.getAttribute('data-runtime') || '';
    var name = button.getAttribute('data-name') || runtime;
    confirmThen(node + ' · ' + name, '从节点卸载 · 有智能体用着它时节点会拒绝', function () {
      qc.sendJson('POST', '/v0/magpie/agents/remove', { node: node, runtime: runtime }).then(function (job) {
        var running = job && job.state === 'running';
        if (running) follow();
        return done(running ? node + ' 正在卸载 ' + name : node + ' 已卸载 ' + name);
      }).catch(failed('卸载'));
    });
  });

  function configure(select) {
    var body = {
      node: select.getAttribute('data-node') || '',
      agent: select.getAttribute('data-agent') || ''
    };
    var what = select.name === 'mg-runtime' ? '底层' : '模型';
    if (select.name === 'mg-runtime') body.runtime = select.value;
    else body.model = select.value;
    select.disabled = true;
    qc.sendJson('POST', '/v0/magpie/agents/configure', body).then(function () {
      return done(body.agent + ' 的' + what + '已下发');
    }).catch(function (err) {
      failed('下发')(err);
      return refresh();
    }).then(function () { select.disabled = false; });
  }

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (target && (target.name === 'mg-runtime' || target.name === 'mg-model')) {
      configure(target);
      return;
    }
    if (!target || target.name !== 'magpie-period') return;
    var mount = byId('magpie-usage');
    if (!mount) return;
    mount.setAttribute('data-poll', '/fragments/magpie/usage?period=' + encodeURIComponent(target.value));
    qc.refreshRegion(mount).catch(failed('读取用量'));
  });
})();
`
