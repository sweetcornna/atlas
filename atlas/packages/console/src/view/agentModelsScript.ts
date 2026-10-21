// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The 智能体模型 controls' script (`view/agentModels.ts`), for any page that
 * draws them (the gateway page's agents section, the model page).
 *
 * - A model picker is a `<details>`: picking an option, or typing a model id
 *   into its filter and pressing Enter, sends `{node, agent, field, value}`
 *   to `/v0/magpie/agents/configure` at once. A typed id without a source in
 *   front goes under the picker's default source (the main model's). Enter
 *   while an input method is composing does nothing.
 * - An effort select sends on change.
 * - The new value shows at once; a refusal puts the old one back and says
 *   why under the row, and a success redraws the region.
 * - While a picker or a 分档 panel is open, the region's polling holds, so a
 *   redraw never eats what is being typed; closing lets it go again.
 */

export const AGENT_MODELS_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc || window.qianmoAgentModels) return;
  window.qianmoAgentModels = true;
  var OPEN = 'details.am-pick[open], details.am-tiers[open]';

  function has(el, cls) { return !!(el && el.classList && el.classList.contains(cls)); }
  function mountOf(el) { return el && el.closest ? el.closest('[data-poll], [data-am-poll]') : null; }
  function hold(mount) {
    if (!mount || !mount.hasAttribute('data-poll')) return;
    mount.setAttribute('data-am-poll', mount.getAttribute('data-poll'));
    mount.removeAttribute('data-poll');
  }
  function release(mount) {
    if (!mount || !mount.hasAttribute('data-am-poll') || mount.querySelector(OPEN)) return;
    mount.setAttribute('data-poll', mount.getAttribute('data-am-poll'));
    mount.removeAttribute('data-am-poll');
  }
  function redraw(mount) {
    if (!mount) return Promise.resolve();
    if (mount.hasAttribute('data-am-poll')) {
      mount.setAttribute('data-poll', mount.getAttribute('data-am-poll'));
      mount.removeAttribute('data-am-poll');
    }
    return qc.refreshRegion(mount).then(function () {
      if (mount.querySelector(OPEN)) hold(mount);
    }).catch(function () {});
  }
  function errorBox(node, agent) {
    var key = node + '/' + agent;
    var boxes = document.querySelectorAll('[data-am-error]');
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].getAttribute('data-am-error') === key) return boxes[i];
    }
    return null;
  }

  function send(holder, value, undo) {
    var node = holder.getAttribute('data-node') || '';
    var agent = holder.getAttribute('data-agent') || '';
    var field = holder.getAttribute('data-field') || '';
    var box = errorBox(node, agent);
    if (box) box.textContent = '';
    var mount = mountOf(holder);
    return qc.sendJson('POST', '/v0/magpie/agents/configure', {
      node: node, agent: agent, field: field, value: value
    }).then(function () {
      return redraw(mount);
    }, function (err) {
      undo();
      if (box) box.textContent = qc.failLine('保存', err);
      else qc.toast(qc.failLine('保存', err), qc.failTone(err));
    });
  }

  function pick(details, value, text) {
    var current = details.querySelector('[data-am-current]');
    var before = current ? current.textContent : '';
    if (current) current.textContent = text;
    details.open = false;
    send(details, value, function () { if (current) current.textContent = before; });
  }

  function options(details) {
    return Array.prototype.slice.call(details.querySelectorAll('.am-opt'));
  }
  function visible(details) {
    return options(details).filter(function (one) { return !one.parentNode.hidden; });
  }

  function filter(input) {
    var query = input.value.trim().toLowerCase();
    var list = input.parentNode.querySelector('.am-opts');
    if (!list) return;
    var group = null;
    var shown = 0;
    for (var i = 0; i < list.children.length; i++) {
      var item = list.children[i];
      if (has(item, 'am-grp')) {
        if (group) group.hidden = shown === 0;
        group = item;
        shown = 0;
        continue;
      }
      var hit = !query || item.textContent.toLowerCase().indexOf(query) >= 0;
      item.hidden = !hit;
      if (hit) shown += 1;
    }
    if (group) group.hidden = shown === 0;
  }

  /** What Enter in the filter picks: an option named so, else the typed id. */
  function typed(details, input) {
    var text = input.value.trim();
    if (!text) return null;
    var match = options(details).filter(function (one) {
      return one.textContent === text || one.getAttribute('data-value') === text;
    })[0];
    if (match) return { value: match.getAttribute('data-value') || '', text: match.textContent };
    if (/\\s/.test(text)) return null;
    var sources = (details.getAttribute('data-sources') || '').split(' ').filter(Boolean);
    var named = sources.some(function (id) { return text.indexOf(id + '/') === 0; });
    if (named) return { value: text, text: text.slice(text.indexOf('/') + 1) };
    var source = details.getAttribute('data-source') || '';
    if (!source) return null;
    return { value: source + '/' + text, text: text };
  }

  var composing = false;
  document.addEventListener('compositionstart', function (event) {
    if (has(event.target, 'am-filter')) composing = true;
  }, true);
  document.addEventListener('compositionend', function (event) {
    if (has(event.target, 'am-filter')) composing = false;
  }, true);

  document.addEventListener('input', function (event) {
    if (has(event.target, 'am-filter')) filter(event.target);
  });

  document.addEventListener('keydown', function (event) {
    var input = event.target;
    if (!has(input, 'am-filter')) return;
    var details = input.closest('details.am-pick');
    if (!details) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      details.open = false;
      var summary = details.querySelector('summary');
      if (summary) summary.focus();
      return;
    }
    if (event.key === 'ArrowDown') {
      var first = visible(details)[0];
      if (first) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.key !== 'Enter') return;
    // An input method's Enter ends the composition; it picks nothing.
    if (event.isComposing || composing || event.keyCode === 229) return;
    event.preventDefault();
    var chosen = typed(details, input);
    if (chosen) pick(details, chosen.value, chosen.text);
  });

  document.addEventListener('click', function (event) {
    var target = event.target;
    var option = target && target.closest ? target.closest('.am-opt') : null;
    if (option) {
      var details = option.closest('details.am-pick');
      if (!details) return;
      event.preventDefault();
      pick(details, option.getAttribute('data-value') || '', option.textContent);
      return;
    }
    // A click outside an open picker or panel closes it.
    var open = document.querySelectorAll(OPEN);
    for (var i = 0; i < open.length; i++) {
      if (!open[i].contains(target)) open[i].open = false;
    }
  });

  document.addEventListener('change', function (event) {
    var select = event.target;
    if (!select || select.name !== 'am-effort') return;
    var before = '';
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].defaultSelected) before = select.options[i].value;
    }
    select.disabled = true;
    send(select, select.value, function () { select.value = before; }).then(function () {
      select.disabled = false;
    });
  });

  document.addEventListener('toggle', function (event) {
    var details = event.target;
    if (!has(details, 'am-pick') && !has(details, 'am-tiers')) return;
    var mount = mountOf(details);
    if (!details.open) { release(mount); return; }
    hold(mount);
    if (has(details, 'am-pick')) {
      var input = details.querySelector('.am-filter');
      if (input) { input.value = ''; filter(input); input.focus({ preventScroll: true }); }
    }
  }, true);
})();
`
