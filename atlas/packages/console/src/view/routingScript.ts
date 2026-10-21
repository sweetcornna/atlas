// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 任务模型's script (`view/routing.ts`): the scope select swaps the card for
 * another node's, a tier's effort select follows the model picked beside it
 * (narrowed to the efforts that model takes, hidden when it takes none), the
 * form saves every direction at once, and a node's own split can be dropped
 * back to everyone's. The card is replaced whole after each, from
 * `/fragments/routing`.
 *
 * Saving changes the hub's book and nothing on a node, so a save or a clear
 * ends on 尚未下发 beside the card's 下发 button rather than on a line that
 * says it took effect. The button itself is the 模型 area's apply
 * (`providersScript.ts`, `prov-apply-routing`), which tells this script how
 * it went with a `qianmo-routing-applied` event.
 */

export const ROUTING_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var DIRECTIONS = ['complex', 'medium', 'simple', 'image', 'speech', 'video'];
  var EFFORT_WORD = { none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };

  function scope() {
    var card = byId('routing');
    return card ? card.getAttribute('data-node') || '' : '';
  }

  function reload(node) {
    var url = '/fragments/routing' + (node ? '?node=' + encodeURIComponent(node) : '');
    return qc.loadHtml(url).then(function (html) {
      var card = byId('routing');
      if (!card) return;
      var tpl = document.createElement('template');
      tpl.innerHTML = html;
      var next = tpl.content.firstElementChild;
      if (next) card.replaceWith(next);
    });
  }

  // Said on the redrawn card: what was saved, and that no node has it yet.
  function unshipped(lead) {
    var status = byId('routing-status');
    var ship = byId('routing-ship');
    if (!ship) {
      qc.say(status, lead + ' · 没有要下发的托管节点', 'muted');
      qc.toast(lead, 'ok');
      return;
    }
    qc.say(status, lead + ' · 尚未下发 · 节点仍按之前的分工派活 · 点' + ship.textContent + '后生效', 'warn');
    qc.toast(lead + ' · 尚未下发到节点', 'warn');
    ship.focus();
  }

  document.addEventListener('qianmo-routing-applied', function (event) {
    var outcome = event.detail || {};
    var results = outcome.results;
    if (!results) {
      // Turned away whole, most often because the split was saved again
      // since this card was drawn: show the one the hub has now.
      reload(scope()).then(function () {
        qc.say(byId('routing-status'), '没有下发 · ' + (outcome.message || '') + ' · 卡片已换成最新的分工', 'bad');
      }).catch(function (err) { qc.toast(qc.failLine('刷新', err), qc.failTone(err)); });
      return;
    }
    var failed = [];
    for (var i = 0; i < results.length; i++) {
      if (results[i].outcome !== 'ok') failed.push(results[i].node);
    }
    qc.say(byId('routing-status'), failed.length === 0
      ? '已下发 · 节点空闲时切换到这份分工 · 进度看上方切换进度'
      : '这几台没有下发成功 · ' + failed.join(' ') + ' · 原因看上方切换进度', failed.length === 0 ? 'ok' : 'bad');
  });

  // The efforts the picked model takes, after 默认; the current choice is
  // kept when the new model takes it too.
  function followModel(direction) {
    var select = byId('route-' + direction);
    var effort = byId('effort-' + direction);
    var box = byId('effort-box-' + direction);
    if (!select || !effort || !box) return;
    var option = select.options[select.selectedIndex];
    var raw = option && option.value ? option.getAttribute('data-efforts') || '' : '';
    var efforts = raw ? raw.split(' ') : [];
    var keep = effort.value;
    while (effort.options.length > 1) effort.remove(1);
    for (var i = 0; i < efforts.length; i++) {
      var one = document.createElement('option');
      one.value = efforts[i];
      one.textContent = EFFORT_WORD[efforts[i]] || efforts[i];
      effort.appendChild(one);
    }
    effort.value = efforts.indexOf(keep) >= 0 ? keep : '';
    box.hidden = efforts.length === 0;
  }

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (target && target.id && target.id.indexOf('route-') === 0) {
      followModel(target.id.slice('route-'.length));
      return;
    }
    if (!target || target.id !== 'routing-node') return;
    var node = target.value;
    reload(node).then(function () {
      var url = new URL(window.location.href);
      if (node) url.searchParams.set('routing', node);
      else url.searchParams.delete('routing');
      history.replaceState(null, '', url.pathname + url.search);
    }).catch(function (err) { qc.toast(qc.failLine('切换', err), qc.failTone(err)); });
  });

  qc.onSubmit('routing-form', function (form) {
    var status = byId('routing-status');
    var routes = [];
    for (var i = 0; i < DIRECTIONS.length; i++) {
      var select = byId('route-' + DIRECTIONS[i]);
      if (!select || select.disabled) continue;
      var option = select.options[select.selectedIndex];
      var profile = option && option.value ? option.getAttribute('data-profile') : null;
      var model = option && option.value ? option.getAttribute('data-model') : null;
      var effort = byId('effort-' + DIRECTIONS[i]);
      var box = byId('effort-box-' + DIRECTIONS[i]);
      var level = model && effort && box && !box.hidden && effort.value ? effort.value : null;
      routes.push({ direction: DIRECTIONS[i], profileId: profile, modelId: model, effort: level });
    }
    var auto = byId('routing-auto');
    var node = scope();
    qc.say(status, '保存中', 'muted');
    qc.sendJson('PUT', '/v0/routing', {
      node: node || null,
      auto: !!(auto && auto.checked),
      routes: routes,
      revision: Number(form.getAttribute('data-revision')) || 0
    }).then(function () {
      return reload(node).then(function () {
        unshipped(node ? node + ' 的分工已保存' : '分工已保存');
      });
    }).catch(function (err) { qc.say(byId('routing-status'), qc.failLine('保存', err), qc.failTone(err)); });
  });

  qc.onAction('routing-clear', function (button) {
    var node = button.getAttribute('data-node') || '';
    if (!node) return;
    qc.sendJson('DELETE', '/v0/routing/nodes/' + encodeURIComponent(node)).then(function () {
      return reload(node).then(function () {
        unshipped(node + ' 已回到所有节点的分工');
      });
    }).catch(function (err) { qc.toast(qc.failLine('恢复', err), qc.failTone(err)); });
  });
})();
`
