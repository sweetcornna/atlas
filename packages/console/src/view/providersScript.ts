// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 模型服务's page script: every write the area's pages offer, through the
 * shared runtime (`assets/client.ts`, `window.qianmoConsole`) and the area's
 * JSON (`routes/providers.ts`).
 *
 * - Every write goes through a `<dialog>` the server rendered outside the
 *   polled regions, or a button on a region that is not polled (the form);
 *   text an operator is typing is never inside a region a poll replaces.
 * - After a write the regions are reloaded from the server rather than
 *   patched here: what is on the page is always the hub's answer, and what a
 *   node runs is always the node's (`effective`).
 * - A switch is followed node by node in the progress panel: 已下发 ·
 *   等待空闲 · 已生效, or why not, with 重试 / 覆盖 / 停止托管 where they apply.
 *   It asks the node for its state (`…/refresh`, which the hub throttles)
 *   every 5 s for two minutes, then every 30 s, and gives up waiting at
 *   30 min with the R-6 sentence; nothing is ever forced.
 * - Visible text is set with `textContent` only, in the console's register.
 *
 * The node tab's write controls are links (`writeLink`) so the tab still leads
 * somewhere when it is embedded in a page without this script; here the click
 * is claimed, and `?do=<what>` on this area's node page opens the same dialog
 * the click would have.
 *
 * No backslash and no backtick appear below: this is a template literal, and
 * either would change the script on its way to the page.
 */

export const PROVIDERS_PAGE_JS = `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;

  function all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function one(sel, root) { return (root || document).querySelector(sel); }
  function enc(s) { return encodeURIComponent(s); }
  function valueOf(id) { var el = qc.byId(id); return el ? String(el.value || '').trim() : ''; }
  function data(el, name) { return el ? el.getAttribute('data-' + name) || '' : ''; }

  // A navigation, signed the way the runtime signs data-nav links.
  function go(path) {
    var token = qc.readToken();
    window.location.href = token
      ? path + (path.indexOf('?') === -1 ? '?' : '&') + 'token=' + enc(token)
      : path;
  }

  function refreshAll() {
    var mounts = all('[data-poll]');
    for (var i = 0; i < mounts.length; i++) {
      qc.refreshRegion(mounts[i]).catch(function () { /* the next tick says so */ });
    }
  }

  function digits(text) {
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (c !== ' ' && c !== '_' && c !== ',') out += c;
    }
    return out;
  }

  // 200000 / 200k / 1M; null for empty; NaN for nonsense.
  function tokensOf(raw) {
    var text = digits(String(raw || '').trim());
    if (text === '') return null;
    var scale = 1;
    var last = text.charAt(text.length - 1).toLowerCase();
    if (last === 'k') { scale = 1000; text = text.slice(0, -1); }
    else if (last === 'm') { scale = 1000000; text = text.slice(0, -1); }
    if (!/^[0-9]+([.][0-9]+)?$/.test(text)) return NaN;
    return Math.round(Number(text) * scale);
  }

  function tokensWord(n) {
    if (typeof n !== 'number' || !(n > 0)) return '未报告';
    if (n % 1000000 === 0) return (n / 1000000) + 'M';
    if (n % 1000 === 0) return (n / 1000) + 'k';
    return String(n);
  }

  var SOURCE_WORD = { env: '环境变量', settings: '节点设置', auto: '自动' };
  var PROBE_DOING = { auth: '测连中', latency: '测速中', call: '真实调用中' };

  function probeLine(result) {
    if (result.ok) {
      return {
        tone: 'ok',
        text: '可用' + (result.latency ? ' · ' + result.latency.medianMs + ' ms' : '')
      };
    }
    if (result.reachable) {
      return {
        tone: 'warn',
        text: '服务可达 · ' + (result.message || '请求被拒') +
          (result.httpStatus ? ' ' + result.httpStatus : '')
      };
    }
    return { tone: 'bad', text: '无法连接 · ' + (result.message || '没有响应') };
  }

  /* ---------------- progress (§6.3.4) ---------------- */

  var FAST_MS = 5000;
  var SLOW_MS = 30000;
  var FAST_FOR_MS = 120000;
  var GIVE_UP_MS = 30 * 60 * 1000;
  var tracked = {};
  var trackTimer = null;

  function progressRow(node) {
    var list = qc.byId('prov-progress-list');
    var panel = qc.byId('prov-progress');
    if (!list) return null;
    if (panel) panel.hidden = false;
    var rows = all('li[data-node]', list);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-node') === node) return rows[i];
    }
    var li = document.createElement('li');
    li.setAttribute('data-node', node);
    list.appendChild(li);
    return li;
  }

  function button(action, label, attrs, danger) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = danger ? 'btn btn-ghost btn-danger btn-small' : 'btn btn-secondary btn-small';
    b.setAttribute('data-action', action);
    b.setAttribute('data-write', '');
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) b.setAttribute('data-' + key, attrs[key]);
    }
    b.textContent = label;
    return b;
  }

  function paintRow(li, tone, text, detail, buttons) {
    if (!li) return;
    li.setAttribute('data-tone', tone);
    li.innerHTML = '';
    var name = document.createElement('span');
    name.className = 'mono';
    name.textContent = li.getAttribute('data-node');
    var word = document.createElement('span');
    word.className = 'prov-plan-state';
    word.textContent = text;
    li.appendChild(name);
    li.appendChild(word);
    if (detail) {
      var note = document.createElement('span');
      note.className = 'note';
      note.textContent = detail;
      li.appendChild(note);
    }
    for (var i = 0; buttons && i < buttons.length; i++) li.appendChild(buttons[i]);
  }

  function failureButtons(result) {
    if (result.code === 'conflict') {
      return [
        button('prov-force', '覆盖节点上的改动', { node: result.node, keys: (result.diffKeys || []).join(' ') }),
        button('prov-unmanage', '停止托管', { node: result.node }, true)
      ];
    }
    return [button('prov-retry', '重试', { node: result.node })];
  }

  function report(results) {
    var failed = [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var li = progressRow(r.node);
      if (r.outcome === 'ok') {
        paintRow(li, 'warn', r.pending ? '已下发 · 等待空闲' : '已下发',
          r.sessions === 'reset' ? '新会话' : (r.sessions === 'keep' ? '保留会话' : ''));
        track(r.node, r.requestId);
      } else {
        failed.push(r.node);
        paintRow(li, 'bad', '没有成功 · ' + (r.code || r.outcome), r.message, failureButtons(r));
      }
    }
    if (failed.length > 0) qc.toast('这几台没有成功 · ' + failed.join(' '), 'bad');
    else if (results.length > 0) qc.toast('已下发 · 节点在空闲时切换', 'ok');
    else qc.toast('没有要下发的节点', 'muted');
  }

  function track(node, requestId) {
    tracked[node] = { requestId: requestId, since: Date.now() };
    schedule();
  }

  function schedule() {
    if (trackTimer || qc.isExpired()) return;
    var oldest = Infinity;
    for (var node in tracked) {
      if (Object.prototype.hasOwnProperty.call(tracked, node)) oldest = Math.min(oldest, tracked[node].since);
    }
    if (oldest === Infinity) return;
    var wait = Date.now() - oldest < FAST_FOR_MS ? FAST_MS : SLOW_MS;
    trackTimer = setTimeout(function () { trackTimer = null; followAll(); }, wait);
  }

  function landed(actual, requestId) {
    return actual && actual.pending === null && actual.applied &&
      actual.applied.requestId === requestId &&
      (actual.loadedHash === actual.appliedHash || !actual.resident || !actual.resident.running);
  }

  function follow(node) {
    var entry = tracked[node];
    return qc.sendJson('POST', '/v0/providers/nodes/' + enc(node) + '/refresh').then(function (data) {
      var view = data && data.node;
      var actual = view && view.actual;
      var li = progressRow(node);
      if (landed(actual, entry.requestId)) {
        delete tracked[node];
        if (actual.resident && actual.resident.running) paintRow(li, 'ok', '已下发 · 已生效', '');
        else paintRow(li, 'ok', '已写入 · 节点未运行', '下次启动时加载');
        return;
      }
      var waited = Date.now() - entry.since;
      var turns = actual && actual.pending ? actual.pending.waitingTurns : null;
      if (waited >= GIVE_UP_MS) {
        delete tracked[node];
        paintRow(li, 'bad', '等待超时', '已等待 30 分钟' +
          (turns === null || turns === undefined ? '' : ' · 节点仍有 ' + turns + ' 个进行中的对话') +
          ' · 未强制切换');
        return;
      }
      paintRow(li, 'warn', '已下发 · 等待空闲',
        turns === null || turns === undefined ? '' : '进行中的对话 ' + turns + ' 个');
    }).catch(function (err) {
      paintRow(progressRow(node), 'warn', '已下发 · 状态暂时读不到', qc.message(err));
    });
  }

  function followAll() {
    var jobs = [];
    for (var node in tracked) {
      if (Object.prototype.hasOwnProperty.call(tracked, node)) jobs.push(follow(node));
    }
    Promise.all(jobs).then(function () { refreshAll(); schedule(); });
  }

  qc.onExpire(function () {
    if (trackTimer) clearTimeout(trackTimer);
    trackTimer = null;
    tracked = {};
  });

  qc.onAction('prov-progress-close', function () {
    var panel = qc.byId('prov-progress');
    if (panel) panel.hidden = true;
  });

  function apply(nodes, options) {
    var body = { nodes: nodes };
    if (options && options.sessions) body.sessions = options.sessions;
    if (options && options.force) body.force = true;
    for (var i = 0; i < nodes.length; i++) paintRow(progressRow(nodes[i]), 'muted', '下发中', '');
    return qc.sendJson('POST', '/v0/providers/apply', body).then(function (data) {
      report((data && data.results) || []);
      refreshAll();
    }).catch(function (err) {
      for (var j = 0; j < nodes.length; j++) {
        paintRow(progressRow(nodes[j]), 'bad', '没有成功', qc.message(err),
          [button('prov-retry', '重试', { node: nodes[j] })]);
      }
      qc.toast('下发失败 · ' + qc.message(err), 'bad');
    });
  }

  qc.onAction('prov-retry', function (el) {
    el.disabled = true;
    apply([data(el, 'node')]);
  });

  /* ---------------- reading the hub ---------------- */

  function overview() {
    return qc.sendJson('GET', '/v0/providers');
  }

  function namesIn(view) {
    var names = {};
    var profiles = (view && view.profiles) || [];
    for (var i = 0; i < profiles.length; i++) names[profiles[i].profile.id] = profiles[i].profile.name;
    return names;
  }

  function nodeIn(view, name) {
    var nodes = (view && view.nodes) || [];
    for (var i = 0; i < nodes.length; i++) if (nodes[i].node === name) return nodes[i];
    return null;
  }

  // Keeping sessions across a line or host change waits on every node's own
  // report of a replay filter (§2.7); never a constant here.
  function gateKeep(selectId, noteId, view, nodes) {
    var select = qc.byId(selectId);
    var note = qc.byId(noteId);
    if (!select) return;
    var able = nodes.length > 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodeIn(view, nodes[i]);
      if (!node || !node.actual || node.actual.capabilities.replayFilter !== true) able = false;
    }
    var keep = one('option[value="keep"]', select);
    if (keep) keep.disabled = !able;
    if (!able && select.value === 'keep') select.value = '';
    if (note) note.hidden = able;
  }

  function planLine(list, result, names, view) {
    var li = document.createElement('li');
    li.setAttribute('data-node', result.node);
    var node = nodeIn(view, result.node);
    var current = node && node.actual && node.actual.applied
      ? (names[node.actual.applied.profileId] || node.actual.applied.profileId)
      : '节点本地配置';
    var target = result.profileId ? (names[result.profileId] || result.profileId) : '';
    var parts = [];
    if (target) parts.push('当前 ' + current + ' 到 ' + target);
    if (result.outcome === 'ok') {
      var keys = result.diffKeys || [];
      parts.push(keys.length === 0 ? '没有变化' : keys.length + ' 个键会变');
      if (result.sessions) parts.push(result.sessions === 'keep' ? '保留会话' : '开始新的会话');
      li.setAttribute('data-tone', 'ok');
    } else {
      parts.push('不能下发 · ' + (result.code || '') + ' ' + (result.message || ''));
      li.setAttribute('data-tone', 'bad');
    }
    var name = document.createElement('span');
    name.className = 'mono';
    name.textContent = result.node;
    var text = document.createElement('span');
    text.className = 'prov-plan-state';
    text.textContent = parts.join(' · ');
    li.appendChild(name);
    li.appendChild(text);
    if (result.diffKeys && result.diffKeys.length > 0) {
      var keysLine = document.createElement('span');
      keysLine.className = 'note mono prov-keys';
      keysLine.textContent = result.diffKeys.join(' ');
      li.appendChild(keysLine);
    }
    list.appendChild(li);
  }

  function say(list, text, tone) {
    if (!list) return;
    list.innerHTML = '';
    var li = document.createElement('li');
    li.setAttribute('data-tone', tone || 'muted');
    li.textContent = text;
    list.appendChild(li);
  }

  function dryRun(nodes, profileId, list, view) {
    if (!list) return Promise.resolve();
    if (nodes.length === 0) { say(list, '没有受影响的节点'); return Promise.resolve(); }
    say(list, '正在比对');
    var body = { nodes: nodes, dryRun: true };
    if (profileId) body.profileId = profileId;
    return qc.sendJson('POST', '/v0/providers/apply', body).then(function (data) {
      list.innerHTML = '';
      var names = namesIn(view);
      var results = (data && data.results) || [];
      for (var i = 0; i < results.length; i++) planLine(list, results[i], names, view);
    }).catch(function (err) { say(list, '比对失败 · ' + qc.message(err), 'bad'); });
  }

  /* ---------------- switch (§6.3.4) ---------------- */

  var switching = null;
  var switchView = null;

  function scope() {
    var picked = one('input[name="prov-switch-scope"]:checked');
    return picked ? picked.value : 'default';
  }

  function switchNodes() {
    if (scope() === 'nodes') {
      return all('input[name="prov-switch-node"]:checked').map(function (box) { return box.value; });
    }
    var nodes = (switchView && switchView.nodes) || [];
    return nodes.filter(function (n) { return n.assignment.mode === 'inherit'; })
      .map(function (n) { return n.node; });
  }

  function planSwitch() {
    if (!switching) return;
    var list = qc.byId('prov-switch-plan');
    var picker = qc.byId('prov-switch-nodes');
    if (picker) picker.hidden = scope() !== 'nodes';
    var nodes = switchNodes();
    gateKeep('prov-switch-sessions', 'prov-switch-keep-note', switchView, nodes);
    dryRun(nodes, switching.profile, list, switchView).then(function () {
      if (scope() !== 'default' || !list) return;
      var pinned = ((switchView && switchView.nodes) || []).filter(function (n) {
        return n.assignment.mode !== 'inherit';
      });
      for (var i = 0; i < pinned.length; i++) {
        var li = document.createElement('li');
        li.setAttribute('data-tone', 'muted');
        li.textContent = pinned[i].node + ' · ' +
          (pinned[i].assignment.mode === 'unmanaged' ? '不托管' : '单独指定') + ' · 不受影响';
        list.appendChild(li);
      }
    });
  }

  function confirmSwitch() {
    if (!switching) return;
    var target = switching;
    var sessions = valueOf('prov-switch-sessions');
    var nodes = switchNodes();
    if (scope() !== 'default' && nodes.length === 0) { qc.toast('没有选节点', 'warn'); return; }
    // 跳过测连 goes on record before anything changes; unrecorded, nothing does.
    var start = target.skipped
      ? qc.sendJson('POST', '/v0/providers/profiles/' + enc(target.profile) + '/skip-probe', {})
      : Promise.resolve();
    var first;
    if (scope() === 'default') {
      first = start.then(function () {
        return qc.sendJson('PUT', '/v0/providers/default', { profileId: target.profile });
      });
    } else {
      first = nodes.reduce(function (chain, node) {
        return chain.then(function () {
          return qc.sendJson('PUT', '/v0/providers/nodes/' + enc(node) + '/assignment',
            { mode: 'profile', profileId: target.profile });
        });
      }, start);
    }
    first.then(function () {
      if (nodes.length === 0) {
        qc.toast('已设为全局默认 · 没有跟随默认的节点', 'ok');
        refreshAll();
        return null;
      }
      return apply(nodes, { sessions: sessions });
    }).catch(function (err) { qc.toast('切换失败 · ' + qc.message(err), 'bad'); });
  }

  // skipped: reached through 保存并切换 on the 跳过测连 box, not a probe.
  function openSwitch(profile, name, skipped) {
    switching = { profile: profile, name: name, skipped: skipped === true };
    qc.setText('prov-switch-name', name);
    var def = one('input[name="prov-switch-scope"][value="default"]');
    if (def) def.checked = true;
    var sessions = qc.byId('prov-switch-sessions');
    if (sessions) sessions.value = '';
    qc.openDialog('prov-switch-dialog', confirmSwitch);
    overview().then(function (view) { switchView = view; planSwitch(); })
      .catch(function (err) { say(qc.byId('prov-switch-plan'), '读不到节点 · ' + qc.message(err), 'bad'); });
  }

  qc.onAction('prov-switch', function (el) { openSwitch(data(el, 'profile'), data(el, 'name')); });

  document.addEventListener('change', function (event) {
    var t = event.target;
    if (!t || !t.name) return;
    if (t.name === 'prov-switch-scope' || t.name === 'prov-switch-node') planSwitch();
  });

  /* ---------------- one node ---------------- */

  function openApply(node) {
    qc.setText('prov-apply-node', node);
    var sessions = qc.byId('prov-apply-sessions');
    if (sessions) sessions.value = '';
    qc.openDialog('prov-apply-dialog', function () {
      apply([node], { sessions: valueOf('prov-apply-sessions') });
    });
    overview().then(function (view) {
      gateKeep('prov-apply-sessions', 'prov-apply-keep-note', view, [node]);
      return dryRun([node], '', qc.byId('prov-apply-plan'), view);
    }).catch(function (err) { say(qc.byId('prov-apply-plan'), qc.message(err), 'bad'); });
  }

  function openDiff(node) {
    qc.setText('prov-diff-node', node);
    qc.setText('prov-diff-keys', '正在比对');
    qc.openDialog('prov-diff-dialog', null);
    qc.sendJson('POST', '/v0/providers/apply', { nodes: [node], dryRun: true }).then(function (data) {
      var r = ((data && data.results) || [])[0];
      if (!r) { qc.setText('prov-diff-keys', '没有结果'); return; }
      if (r.outcome !== 'ok') { qc.setText('prov-diff-keys', (r.code || '') + ' · ' + r.message); return; }
      var keys = r.diffKeys || [];
      qc.setText('prov-diff-keys', keys.length === 0 ? '没有变化' : keys.join(' '));
    }).catch(function (err) { qc.setText('prov-diff-keys', qc.message(err)); });
  }

  function probeNode(node, profile) {
    qc.toast(node + ' · 测连中', 'muted');
    qc.sendJson('POST', '/v0/providers/probe', { node: node, mode: 'auth', profileId: profile })
      .then(function (result) {
        var line = probeLine(result);
        qc.toast(node + ' · ' + line.text, line.tone === 'ok' ? 'ok' : 'bad');
        refreshAll();
      }).catch(function (err) { qc.toast(node + ' · 测连失败 · ' + qc.message(err), 'bad'); });
  }

  function openAssign(el) {
    var node = data(el, 'node');
    qc.setText('prov-assign-node', node);
    var mode = data(el, 'mode') || 'inherit';
    var radio = one('input[name="prov-assign-mode"][value="' + mode + '"]');
    if (radio) radio.checked = true;
    var picker = qc.byId('prov-assign-profile');
    if (picker && data(el, 'profile')) picker.value = data(el, 'profile');
    qc.openDialog('prov-assign-dialog', function () {
      var picked = one('input[name="prov-assign-mode"]:checked');
      var body = { mode: picked ? picked.value : 'inherit' };
      if (body.mode === 'profile') body.profileId = valueOf('prov-assign-profile');
      qc.sendJson('PUT', '/v0/providers/nodes/' + enc(node) + '/assignment', body).then(function () {
        qc.toast('已保存指派 · 下发后节点才切换', 'ok');
        refreshAll();
      }).catch(function (err) { qc.toast('指派失败 · ' + qc.message(err), 'bad'); });
    });
  }

  function saveContext(node, tokens) {
    return qc.sendJson('PUT', '/v0/providers/nodes/' + enc(node) + '/context', { tokens: tokens })
      .then(function () {
        qc.toast(tokens === null ? '已恢复默认 · 随下一次下发生效' : '已保存 · 随下一次下发生效', 'ok');
        refreshAll();
      }).catch(function (err) { qc.toast('上下文窗口没有保存 · ' + qc.message(err), 'bad'); });
  }

  function openContext(node, current) {
    qc.setText('prov-context-node', node);
    var input = qc.byId('prov-context-value');
    if (input) input.value = current || '';
    qc.openDialog('prov-context-dialog', function () {
      var raw = valueOf('prov-context-value');
      var tokens = tokensOf(raw);
      if (tokens !== null && isNaN(tokens)) {
        qc.toast('上下文窗口要写成 token 数 · 例如 200000 或 1M', 'bad');
        return;
      }
      saveContext(node, raw === '' ? null : raw);
    });
    if (input) input.focus();
  }

  function openAutocompact(node) {
    qc.setText('prov-autocompact-node', node);
    qc.setText('prov-autocompact-now', '正在读节点上的值');
    var input = qc.byId('prov-autocompact-value');
    if (input) input.value = '';
    qc.openDialog('prov-autocompact-dialog', function () {
      var value = valueOf('prov-autocompact-value');
      if (value === '') { qc.toast('写 auto 或 100k 到 1M', 'warn'); return; }
      qc.sendJson('PUT', '/v0/providers/nodes/' + enc(node) + '/autocompact', { value: value })
        .then(function (result) {
          qc.toast('已写到节点 · 生效 ' + tokensWord(result.autoCompactWindow) + ' · 来源 ' +
            (SOURCE_WORD[result.source] || result.source), 'ok');
          return qc.sendJson('POST', '/v0/providers/nodes/' + enc(node) + '/refresh');
        }).then(function () { refreshAll(); })
        .catch(function (err) { qc.toast('自动压缩阈值没有写入 · ' + qc.message(err), 'bad'); });
    });
    qc.sendJson('GET', '/v0/providers/nodes/' + enc(node) + '/autocompact').then(function (result) {
      qc.setText('prov-autocompact-now', '节点现在 ' + tokensWord(result.autoCompactWindow) +
        ' · 来源 ' + (SOURCE_WORD[result.source] || result.source));
    }).catch(function (err) { qc.setText('prov-autocompact-now', '读不到节点上的值 · ' + qc.message(err)); });
  }

  function openForce(node, keys) {
    qc.setText('prov-force-node', node);
    qc.setText('prov-force-keys', keys || '');
    qc.openDialog('prov-force-dialog', function () { apply([node], { force: true }); });
  }

  function openUnmanage(node) {
    qc.setText('prov-unmanage-node', node);
    qc.openDialog('prov-unmanage-dialog', function () {
      qc.sendJson('PUT', '/v0/providers/nodes/' + enc(node) + '/assignment', { mode: 'unmanaged' })
        .then(function () {
          qc.toast('已停止托管 · 节点上的文件没有改动', 'ok');
          refreshAll();
        }).catch(function (err) { qc.toast('停止托管失败 · ' + qc.message(err), 'bad'); });
    });
  }

  function refreshNode(node) {
    qc.sendJson('POST', '/v0/providers/nodes/' + enc(node) + '/refresh').then(function () {
      qc.toast(node + ' · 已刷新', 'ok');
      refreshAll();
    }).catch(function (err) { qc.toast(node + ' · 刷新失败 · ' + qc.message(err), 'bad'); });
  }

  qc.onAction('prov-apply', function (el) { openApply(data(el, 'node')); });
  qc.onAction('prov-diff', function (el) { openDiff(data(el, 'node')); });
  qc.onAction('prov-probe', function (el) { probeNode(data(el, 'node'), data(el, 'profile')); });
  qc.onAction('prov-assign', openAssign);
  qc.onAction('prov-context', function (el) { openContext(data(el, 'node'), data(el, 'tokens')); });
  qc.onAction('prov-context-clear', function (el) { openContext(data(el, 'node'), ''); });
  qc.onAction('prov-autocompact', function (el) { openAutocompact(data(el, 'node')); });
  qc.onAction('prov-refresh', function (el) { refreshNode(data(el, 'node')); });
  qc.onAction('prov-force', function (el) { openForce(data(el, 'node'), data(el, 'keys')); });
  qc.onAction('prov-unmanage', function (el) { openUnmanage(data(el, 'node')); });

  /* ---------------- default, delete ---------------- */

  function openDefault(profile) {
    var picker = qc.byId('prov-default-select');
    if (picker) picker.value = profile || '';
    qc.openDialog('prov-default-dialog', function () {
      var id = valueOf('prov-default-select');
      qc.sendJson('PUT', '/v0/providers/default', { profileId: id === '' ? null : id }).then(function () {
        qc.toast(id === '' ? '已取消全局默认' : '已更改全局默认 · 跟随默认的节点下发后切换', 'ok');
        refreshAll();
      }).catch(function (err) { qc.toast('全局默认没有保存 · ' + qc.message(err), 'bad'); });
    });
  }

  qc.onAction('prov-default-open', function (el) { openDefault(data(el, 'profile')); });
  qc.onAction('prov-default', function (el) { openDefault(data(el, 'profile')); });

  qc.onAction('prov-delete', function (el) {
    var id = data(el, 'profile');
    qc.setText('prov-delete-name', data(el, 'name'));
    qc.openDialog('prov-delete-dialog', function () {
      qc.sendJson('DELETE', '/v0/providers/profiles/' + enc(id), { ifMatch: Number(data(el, 'revision')) })
        .then(function () {
          qc.toast('已删除', 'ok');
          if (qc.byId('prov-editor')) go('/providers');
          else refreshAll();
        }).catch(function (err) { qc.toast('没有删除 · ' + qc.message(err), 'bad'); });
    });
  });

  /* ---------------- export (§3.9) ---------------- */

  qc.onAction('prov-export', function () {
    qc.sendJson('GET', '/v0/providers/export').then(function (doc) {
      var text = JSON.stringify(doc, null, 2);
      var link = document.createElement('a');
      var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      link.href = url;
      link.download = 'qianmo-providers.json';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      qc.toast('已导出 · 不含密钥', 'ok');
    }).catch(function (err) { qc.toast('导出失败 · ' + qc.message(err), 'bad'); });
  });

  /* ---------------- the form (§6.3.2, §6.3.3) ---------------- */

  var editor = qc.byId('prov-editor');
  var probedAs = null;

  function result(id, text, tone) {
    var el = qc.byId(id);
    if (el) qc.say(el, text, tone);
  }

  function checkedValues(block, field) {
    return all('input[data-f="' + field + '"]:checked', block).map(function (box) { return box.value; });
  }

  function field(block, name) {
    var el = one('[data-f="' + name + '"]', block);
    return el ? String(el.value || '').trim() : '';
  }

  function readModel(block) {
    var send = field(block, 'send') || 'auto';
    var model = {
      id: field(block, 'id'),
      role: field(block, 'role') || 'main',
      tiers: checkedValues(block, 'tier'),
      capabilities: { mode: 'family' },
      effort: { send: send }
    };
    if (send !== 'auto') {
      var bits = checkedValues(block, 'bit');
      model.capabilities = {
        mode: 'explicit',
        thinking: bits.indexOf('thinking') !== -1,
        adaptive_thinking: bits.indexOf('adaptive_thinking') !== -1,
        interleaved_thinking: bits.indexOf('interleaved_thinking') !== -1
      };
    }
    var level = field(block, 'level');
    if (level) model.effort.level = level;
    var levels = checkedValues(block, 'levels');
    if (levels.length > 0) model.effort.levels = levels;
    var context = tokensOf(field(block, 'context'));
    if (context !== null) model.contextTokens = context;
    var maxout = tokensOf(field(block, 'maxout'));
    if (maxout !== null) model.maxOutputTokens = maxout;
    var retire = field(block, 'retire');
    if (retire) model.retireAt = retire;
    return model;
  }

  function readEdit() {
    var edit = {
      name: valueOf('prov-name'),
      lane: valueOf('prov-lane'),
      baseUrl: valueOf('prov-base'),
      auth: { scheme: valueOf('prov-auth') || 'bearer' },
      effortLock: valueOf('prov-lock') || null,
      models: all('#prov-models [data-model]').map(readModel),
      compat: {},
      templateValues: {}
    };
    if (data(editor, 'mode') === 'create') edit.id = valueOf('prov-id');
    if (qc.byId('prov-site')) edit.site = valueOf('prov-site');
    var vars = all('[data-template]', editor);
    for (var i = 0; i < vars.length; i++) {
      edit.templateValues[vars[i].getAttribute('data-template')] = String(vars[i].value || '').trim();
    }
    var rows = all('#prov-compat [data-compat]');
    for (var j = 0; j < rows.length; j++) {
      var key = field(rows[j], 'ckey');
      if (key) edit.compat[key] = field(rows[j], 'cval');
    }
    return edit;
  }

  function secret() {
    var typed = valueOf('prov-key');
    if (typed) return typed;
    return data(editor, 'mode') === 'create' ? data(editor, 'placeholder-key') : '';
  }

  function where(body) {
    if (data(editor, 'mode') === 'edit') body.profileId = data(editor, 'profile');
    else {
      body.presetId = data(editor, 'preset');
      if (qc.byId('prov-site')) body.site = valueOf('prov-site');
    }
    return body;
  }

  function candidate() {
    var body = where({ edit: readEdit() });
    var s = secret();
    if (s) body.secret = s;
    return body;
  }

  function signature() {
    var body = candidate();
    return JSON.stringify(body);
  }

  function runCheck(mode) {
    var node = valueOf('prov-probe-node');
    if (!node) { result('prov-probe-result', '没有可用来测连的节点', 'bad'); return; }
    var body = candidate();
    body.node = node;
    body.mode = mode;
    var sig = signature();
    result('prov-probe-result', PROBE_DOING[mode] + ' · ' + node, 'muted');
    qc.sendJson('POST', '/v0/providers/probe', body).then(function (r) {
      var line = probeLine(r);
      var text = line.text;
      if (r.suggestion && r.suggestion.baseUrl) {
        var base = qc.byId('prov-base');
        if (base) base.value = r.suggestion.baseUrl;
        var adv = qc.byId('prov-adv');
        if (adv) adv.open = true;
        text += ' · 已按探测结果改为 ' + r.suggestion.baseUrl;
        sig = signature();
      }
      result('prov-probe-result', text, line.tone);
      if (mode === 'auth') probedAs = r.ok ? sig : null;
    }).catch(function (err) { result('prov-probe-result', '没有测成 · ' + qc.message(err), 'bad'); });
  }

  function fetchModels() {
    var node = valueOf('prov-probe-node');
    if (!node) { result('prov-probe-result', '没有可用来拉取的节点', 'bad'); return; }
    var body = candidate();
    body.node = node;
    result('prov-probe-result', '正在拉取模型列表', 'muted');
    qc.sendJson('POST', '/v0/providers/models', body).then(function (r) {
      var list = qc.byId('prov-model-list');
      var seen = {};
      var ids = all('#prov-models [data-f="id"]').map(function (input) { return input.value; });
      var fetched = ((r && r.models) || []).map(function (m) { return m.id; });
      if (list) list.innerHTML = '';
      ids.concat(fetched).forEach(function (id) {
        if (!id || seen[id]) return;
        seen[id] = true;
        var opt = document.createElement('option');
        opt.value = id;
        if (list) list.appendChild(opt);
      });
      result('prov-probe-result', '拉到 ' + fetched.length + ' 个模型 · 在模型 id 的下拉里选', 'ok');
      var adv = qc.byId('prov-adv');
      if (adv) adv.open = true;
    }).catch(function (err) { result('prov-probe-result', '没有拉到 · ' + qc.message(err), 'bad'); });
  }

  function save() {
    var body = where({ profile: readEdit() });
    var typed = secret();
    if (typed) {
      body.secrets = {};
      body.secrets[data(editor, 'key-id') || 'k1'] = typed;
    }
    var edit = data(editor, 'mode') === 'edit';
    if (edit) body.ifMatch = Number(data(editor, 'revision'));
    result('prov-result', '保存中', 'muted');
    var url = edit
      ? '/v0/providers/profiles/' + enc(data(editor, 'profile'))
      : '/v0/providers/profiles';
    return qc.sendJson(edit ? 'PUT' : 'POST', url, body).then(function (r) {
      var profile = r.profile;
      var key = qc.byId('prov-key');
      if (key) key.value = '';
      result('prov-result', '已保存 · 修订 ' + profile.revision, 'ok');
      return profile;
    }).catch(function (err) {
      result('prov-result', '没有保存 · ' + qc.message(err), 'bad');
      throw err;
    });
  }

  // After the first save the form is the stored profile's form: the same
  // fields, now saved with its revision, at its own address.
  function becomeStored(profile) {
    editor.setAttribute('data-mode', 'edit');
    editor.setAttribute('data-profile', profile.id);
    editor.setAttribute('data-revision', String(profile.revision));
    var id = qc.byId('prov-id');
    if (id) id.readOnly = true;
    try { history.replaceState(null, '', '/providers/profiles/' + enc(profile.id)); } catch (e) { /* stays */ }
  }

  function paintFamily(block) {
    var note = one('[data-family-note]', block);
    if (!note) return;
    var lane = valueOf('prov-lane');
    var id = field(block, 'id').toLowerCase();
    var host = '';
    try { host = new URL(valueOf('prov-base')).hostname; } catch (e) { host = ''; }
    note.hidden = !(lane === 'anthropic' && (id.indexOf('claude') !== -1 || host === 'api.anthropic.com'));
  }

  function paintSend(block, fresh) {
    var send = field(block, 'send');
    var explicit = send === 'always' || send === 'never';
    all('[data-when="explicit"]', block).forEach(function (el) { el.hidden = !explicit; });
    if (explicit && fresh && checkedValues(block, 'bit').length === 0 && valueOf('prov-lane') === 'anthropic') {
      var thinking = one('input[data-f="bit"][value="thinking"]', block);
      if (thinking) thinking.checked = true;
    }
  }

  // Follow-ups 3 and 4: what the line allows, from the nodes' own reports.
  function paintLane() {
    var lane = valueOf('prov-lane');
    var chatOpen = data(editor, 'chat-always') === '1';
    var autoOnly = lane === 'gemini' || lane === 'grok';
    all('#prov-models [data-model], #prov-model-template').forEach(function (holder) {
      var root = holder.content || holder;
      all('option[data-explicit]', root).forEach(function (opt) {
        var off = autoOnly || (opt.hasAttribute('data-chat-gate') && lane === 'openai-chat' && !chatOpen);
        if (off) opt.setAttribute('disabled', '');
        else opt.removeAttribute('disabled');
      });
    });
    var gate = qc.byId('prov-chat-gate');
    if (gate) gate.hidden = !(lane === 'openai-chat' && !chatOpen);
    all('#prov-models [data-model]').forEach(paintFamily);
  }

  function keyHint() {
    var hint = qc.byId('prov-key-hint');
    var typed = valueOf('prov-key');
    if (!hint) return;
    var prefixes = [];
    var planPrefixes = [];
    try { prefixes = JSON.parse(data(editor, 'key-prefixes') || '[]'); } catch (e) { prefixes = []; }
    try { planPrefixes = JSON.parse(data(editor, 'plan-prefixes') || '[]'); } catch (e2) { planPrefixes = []; }
    var pattern = data(editor, 'key-pattern');
    if (!typed) { hint.hidden = true; return; }
    var starts = function (list) {
      for (var i = 0; i < list.length; i++) if (typed.indexOf(list[i]) === 0) return true;
      return false;
    };
    var fits = true;
    if (pattern) {
      try { fits = new RegExp(pattern).test(typed) || (prefixes.length > 0 && starts(prefixes)); } catch (e3) { fits = true; }
    } else if (prefixes.length > 0) fits = starts(prefixes);
    var planLike = planPrefixes.length > 0 && starts(planPrefixes) && !starts(prefixes);
    if (planLike) {
      hint.textContent = '这个前缀通常属于套餐密钥 · 当前选的是按量地址';
      hint.hidden = false;
    } else if (!fits) {
      hint.textContent = '密钥前缀和这家服务常见的不同 · 常见前缀 ' + data(editor, 'key-display');
      hint.hidden = false;
    } else hint.hidden = true;
  }

  if (editor) {
    editor.addEventListener('input', function (event) {
      var t = event.target;
      if (t && t.id === 'prov-key') keyHint();
      var block = t && t.closest ? t.closest('[data-model]') : null;
      if (block && t.getAttribute('data-f') === 'id') paintFamily(block);
      if (t && t.id === 'prov-base') all('#prov-models [data-model]').forEach(paintFamily);
    });
    editor.addEventListener('change', function (event) {
      var t = event.target;
      if (!t) return;
      if (t.id === 'prov-lane') paintLane();
      if (t.id === 'prov-site') {
        var picked = t.options[t.selectedIndex];
        var base = qc.byId('prov-base');
        if (picked && base && picked.getAttribute('data-base-url')) base.value = picked.getAttribute('data-base-url');
      }
      if (t.getAttribute('data-f') === 'send') paintSend(t.closest('[data-model]'), true);
    });

    qc.onAction('prov-check', function (el) {
      var mode = data(el, 'mode');
      if (mode === 'call') qc.openDialog('prov-call-dialog', function () { runCheck('call'); });
      else runCheck(mode);
    });
    qc.onAction('prov-models-fetch', fetchModels);

    qc.onAction('prov-save', function () {
      var creating = data(editor, 'mode') === 'create';
      save().then(function (profile) {
        if (creating) go('/providers/profiles/' + enc(profile.id));
        else go(window.location.pathname);
      }).catch(function () { /* said on the result line */ });
    });

    qc.onAction('prov-save-switch', function () {
      var skip = qc.byId('prov-skip-probe');
      var skipped = probedAs !== signature();
      if (skipped && !(skip && skip.checked)) {
        result('prov-result', '保存并切换要求本页测连可用 · 先测连或勾选跳过测连', 'warn');
        return;
      }
      save().then(function (profile) {
        becomeStored(profile);
        openSwitch(profile.id, profile.name, skipped);
      }).catch(function () { /* said on the result line */ });
    });

    qc.onAction('prov-model-add', function () {
      var tpl = qc.byId('prov-model-template');
      var list = qc.byId('prov-models');
      if (!tpl || !list) return;
      var block = tpl.content.firstElementChild.cloneNode(true);
      var role = one('[data-f="role"]', block);
      if (role && list.children.length > 0) role.value = 'extra';
      list.appendChild(block);
      paintLane();
      var input = one('[data-f="id"]', block);
      if (input) input.focus();
    });
    qc.onAction('prov-model-remove', function (el) {
      var block = el.closest('[data-model]');
      if (block) block.remove();
    });
    qc.onAction('prov-compat-add', function () {
      var tpl = qc.byId('prov-compat-template');
      var list = qc.byId('prov-compat');
      if (!tpl || !list) return;
      var row = tpl.content.firstElementChild.cloneNode(true);
      list.appendChild(row);
      var input = one('[data-f="ckey"]', row);
      if (input) input.focus();
    });
    qc.onAction('prov-compat-remove', function (el) {
      var row = el.closest('[data-compat]');
      if (row) row.remove();
    });

    qc.onAction('prov-key-refill', function () {
      var key = qc.byId('prov-key');
      if (key) { key.focus(); key.scrollIntoView({ block: 'center' }); }
    });
    qc.onAction('prov-key-clear', function (el) {
      qc.openDialog('prov-clear-dialog', function () {
        var url = '/v0/providers/profiles/' + enc(data(editor, 'profile')) + '/keys/' + enc(data(el, 'key'));
        qc.sendJson('DELETE', url, { ifMatch: Number(data(editor, 'revision')) }).then(function () {
          go(window.location.pathname);
        }).catch(function (err) { result('prov-result', '没有清除 · ' + qc.message(err), 'bad'); });
      });
    });

    all('#prov-models [data-model]').forEach(function (block) { paintSend(block, false); });
    paintLane();
  }

  /* ---------------- import (§6.3.6) ---------------- */

  var importing = null;

  function importList(preview) {
    var holder = qc.byId('prov-import-list');
    if (!holder) return;
    holder.innerHTML = '';
    var list = document.createElement('ul');
    list.className = 'prov-import-list';
    var collisions = preview.collisions || [];
    (preview.profiles || []).forEach(function (profile) {
      var li = document.createElement('li');
      li.setAttribute('data-profile', profile.id);
      var name = document.createElement('strong');
      name.textContent = profile.name;
      var meta = document.createElement('span');
      meta.className = 'note mono';
      var main = (profile.models || []).filter(function (m) { return m.role === 'main'; })[0];
      meta.textContent = profile.id + ' · ' + profile.lane + ' · ' + (main ? main.id : '');
      li.appendChild(name);
      li.appendChild(meta);
      if (collisions.indexOf(profile.id) !== -1) {
        var label = document.createElement('label');
        label.className = 'field';
        var text = document.createElement('span');
        text.textContent = '已有同 id 的档案 · 另存为';
        var input = document.createElement('input');
        input.className = 'input mono';
        input.setAttribute('data-rename', profile.id);
        input.value = profile.id + '-2';
        label.appendChild(text);
        label.appendChild(input);
        li.appendChild(label);
      }
      list.appendChild(li);
    });
    (preview.warnings || []).forEach(function (w) {
      var li = document.createElement('li');
      li.className = 'note';
      li.textContent = w.path + ' · ' + w.message;
      list.appendChild(li);
    });
    holder.appendChild(list);
  }

  qc.onAction('prov-import-preview', function () {
    var text = valueOf('prov-import-text');
    importing = null;
    if (!text) { result('prov-import-result', '先选文件或粘贴内容', 'warn'); return; }
    result('prov-import-result', '正在检查', 'muted');
    qc.sendJson('POST', '/v0/providers/import/preview', { text: text }).then(function (preview) {
      importing = text;
      importList(preview);
      result('prov-import-result', '共 ' + (preview.profiles || []).length + ' 份 · 确认后点导入', 'ok');
    }).catch(function (err) {
      var holder = qc.byId('prov-import-list');
      if (holder) holder.innerHTML = '';
      result('prov-import-result', '整份拒绝 · ' + qc.message(err), 'bad');
    });
  });

  qc.onAction('prov-import-run', function () {
    if (importing === null || importing !== valueOf('prov-import-text')) {
      result('prov-import-result', '先预览这份内容', 'warn');
      return;
    }
    var renames = {};
    all('[data-rename]').forEach(function (input) {
      renames[input.getAttribute('data-rename')] = String(input.value || '').trim();
    });
    qc.sendJson('POST', '/v0/providers/import', { text: importing, renames: renames }).then(function (r) {
      var count = ((r && r.profiles) || []).length;
      result('prov-import-result', '已导入 ' + count + ' 份 · 都没有密钥 · 到各自页面填写', 'ok');
      importing = null;
    }).catch(function (err) { result('prov-import-result', '没有导入 · ' + qc.message(err), 'bad'); });
  });

  var file = qc.byId('prov-import-file');
  if (file) {
    file.addEventListener('change', function () {
      var picked = file.files && file.files[0];
      if (!picked) return;
      picked.text().then(function (text) {
        var area = qc.byId('prov-import-text');
        if (area) area.value = text;
        importing = null;
        result('prov-import-result', '已读入 ' + picked.name + ' · 点预览检查', 'muted');
      });
    });
  }

  /* ---------------- ?do= on the node page ---------------- */

  var asked = new URLSearchParams(window.location.search).get('do');
  var tab = one('.prov-node-in');
  if (asked && /^[a-z-]{1,24}$/.test(asked) && tab) {
    var node = tab.getAttribute('data-node') || '';
    try {
      var rest = new URLSearchParams(window.location.search);
      rest.delete('do');
      var query = rest.toString();
      history.replaceState(null, '', window.location.pathname + (query ? '?' + query : ''));
    } catch (e) { /* the parameter stays; it only opens a dialog */ }
    var control = one('[data-action][data-node="' + node + '"][href*="do=' + asked + '"]', tab);
    if (control) control.click();
  }
})();
`
