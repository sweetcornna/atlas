// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 任务分工's script (`view/routing.ts`): the scope select swaps the card for
 * another node's, the form saves every direction at once, and a node's own
 * split can be dropped back to everyone's. The card is replaced whole after
 * each, from `/fragments/routing`.
 */

export const ROUTING_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var DIRECTIONS = ['code', 'chat', 'plan', 'fast', 'vision', 'image', 'speech', 'video'];

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

  document.addEventListener('change', function (event) {
    var target = event.target;
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
      routes.push({ direction: DIRECTIONS[i], profileId: profile, modelId: model });
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
      qc.toast(node ? node + ' 的分工已保存' : '分工已保存 · 节点下次空闲时生效', 'ok');
      return reload(node);
    }).catch(function (err) { qc.say(status, qc.failLine('保存', err), qc.failTone(err)); });
  });

  qc.onAction('routing-clear', function (button) {
    var node = button.getAttribute('data-node') || '';
    if (!node) return;
    qc.sendJson('DELETE', '/v0/routing/nodes/' + encodeURIComponent(node)).then(function () {
      qc.toast(node + ' 回到所有节点的分工', 'ok');
      return reload(node);
    }).catch(function (err) { qc.toast(qc.failLine('恢复', err), qc.failTone(err)); });
  });
})();
`
