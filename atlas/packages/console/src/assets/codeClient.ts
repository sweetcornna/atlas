// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Code's page script (`/code`, `view/frontCode.ts`), on top of the shared
 * runtime and the front's own.
 *
 * Inside the desktop app (`window.__QMO_SHELL__` with Tauri's `invoke`) it
 * asks the shell which agents this computer has — `qmo_local_agents`, the
 * answer of `qmo agents --json`, `{ agents: [...] }` with each one's `name`,
 * `version`, `available` and, when it is not, a `reason` (`qmo-local.md`
 * §4.2) — and lists them; 重新检测 asks again with `rescan`. It fills the
 * agent picker of a new session with the ones that can run, and leaves 开始
 * shut: local sessions open with P37.14.
 *
 * A browser, or an app too old to have the command, gets the one line that
 * Code is the desktop app's. An app that has it refuses in one line of its
 * own, always starting with `qmo` (`qmo did not start: …`, `qmo agents took
 * longer than 30 s`, `qmo agents: …` with what qmo said — an older qmo
 * without the subcommand is one of these — and `qmo agents printed an
 * unexpected answer`); that line is said in the status line, with 重新检测
 * to try again. Any other refusal is Tauri's, for a command the app does
 * not have or does not allow this page: the app is older than Code.
 *
 * The rows are built from the answer with `textContent` and nothing else;
 * the page never turns the answer into markup.
 */

import { stripJsLineComments } from './client.js'

function codeScript(): string {
  return `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var local = byId('code-local');
  var web = byId('code-web');
  if (!local || !web) return;
  var words = {};
  try { words = JSON.parse((byId('fx') && byId('fx').getAttribute('data-text')) || '{}') || {}; } catch (e) { words = {}; }
  function tx(key, fallback) { return typeof words[key] === 'string' ? words[key] : fallback; }

  var core = window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function' ?
    window.__TAURI__.core : null;
  var shell = !!core && !!window.__QMO_SHELL__ && typeof window.__QMO_SHELL__ === 'object';
  var start = byId('code-new');

  // Code is the desktop app's: the one line, and nothing to start.
  function elsewhere() {
    local.hidden = true;
    web.hidden = false;
    if (start) start.disabled = true;
  }

  if (!shell) { elsewhere(); return; }
  local.hidden = false;
  web.hidden = true;

  function row(agent) {
    var li = document.createElement('li');
    var ready = agent.available === true;
    li.className = 'fx-code-agent' + (ready ? '' : ' is-off');
    var name = document.createElement('span');
    name.className = 'fx-code-name';
    name.textContent = String(agent.name || agent.id || '');
    li.appendChild(name);
    if (agent.version) {
      var version = document.createElement('span');
      version.className = 'fx-code-ver mono';
      version.textContent = String(agent.version);
      li.appendChild(version);
    }
    var state = document.createElement('span');
    state.className = 'state fx-code-ready';
    var dot = document.createElement('span');
    dot.className = 'dot ' + (ready ? 'dot-ok' : 'dot-muted');
    state.appendChild(dot);
    state.appendChild(document.createTextNode(ready ? tx('agentReady', '可用') :
      String(agent.reason || tx('agentNotReady', '不可用'))));
    li.appendChild(state);
    return li;
  }

  function draw(list) {
    var box = byId('code-agents');
    var pick = byId('code-agent');
    if (box) {
      while (box.firstChild) box.removeChild(box.firstChild);
      for (var i = 0; i < list.length; i++) box.appendChild(row(list[i]));
    }
    if (pick) {
      while (pick.firstChild) pick.removeChild(pick.firstChild);
      for (var j = 0; j < list.length; j++) {
        if (list[j].available !== true) continue;
        var option = document.createElement('option');
        option.value = String(list[j].id || '');
        option.textContent = String(list[j].name || list[j].id || '') + (list[j].version ? ' · ' + list[j].version : '');
        pick.appendChild(option);
      }
      pick.disabled = pick.options.length === 0;
    }
  }

  var asking = 0;
  function scan(rescan) {
    var mine = ++asking;
    var line = byId('code-state');
    var again = byId('code-rescan');
    qc.say(line, tx('scanning', '正在检测'), 'muted');
    if (again) again.disabled = true;
    var answer;
    try { answer = Promise.resolve(core.invoke('qmo_local_agents', { rescan: !!rescan })); }
    catch (e) { answer = Promise.reject(e); }
    answer.then(function (data) {
      if (mine !== asking) return;
      if (again) again.disabled = false;
      var list = data && Array.isArray(data.agents) ? data.agents : [];
      draw(list);
      qc.say(line, list.length ? '' : tx('noLocalAgents', '这台电脑上没有找到 agent'), 'muted');
    }, function (err) {
      if (mine !== asking) return;
      if (again) again.disabled = false;
      var why = typeof err === 'string' ? err : err && err.message ? String(err.message) : '';
      // The app's own refusal says what went wrong; anything else is an
      // app from before the command.
      if (!/^qmo /.test(why)) { elsewhere(); return; }
      qc.say(line, why, 'warn');
    });
  }

  qc.onAction('code-rescan', function () { scan(true); });
  qc.onAction('code-new', function () {
    var folder = byId('code-folder');
    if (folder) folder.focus();
  });
  var form = byId('code-start');
  if (form) form.addEventListener('submit', function (event) { event.preventDefault(); });

  scan(false);
})();
`
}

/** Code's page script. */
export const CODE_JS = stripJsLineComments(codeScript())
