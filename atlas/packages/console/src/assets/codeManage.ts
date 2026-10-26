// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Managing Code's local sessions (P37.14d, `qmo-local.md` §3.3, §4.3.7,
 * §4.5.5), the third of `/code`'s scripts, after `CODE_JS`
 * (`assets/codeClient.ts`), which hands it `R.host`: its words, the shell
 * call, the status line, the side list, and (`st()`) the sessions it knows,
 * the one open, the runner's features and the folders.
 *
 * - **A worktree of its own.** The switch in a new session's box can be
 *   turned on where the runner can make one (`features.worktree`) and the
 *   folder is a Git one; the line under the box says what it means (from the
 *   current commit; what is not committed stays behind). `CODE_JS` sends it
 *   with `qmo_local_start`.
 * - **A row's ⋯.** This computer's sessions only (a copy from another one
 *   has 「从中枢删除副本」 instead). 改名 turns the row's title into a field: Enter or leaving
 *   it keeps the new title (`qmo_local_rename`), Esc keeps the old one; the
 *   list is not redrawn under it meanwhile (`R.hold`). 删除 hides the row at
 *   once and says so with 撤销 for ten seconds (`R.hidden`); only then does
 *   `qmo_local_delete` go. A second delete sends the first at once. A page
 *   that goes away within the ten seconds deletes nothing: the session is
 *   there next time, which is the side to err on. A worktree left behind
 *   because it has changes is named in the status line.
 *
 * Everything is built with `createElement` and `textContent`.
 */

import { stripJsLineComments } from './client.js'

function manageScript(): string {
  return `
(function () {
  'use strict';

  var qc = window.qianmoConsole;
  var R = window.qianmoCode;
  if (!qc || !R || !R.host) return;
  var H = R.host;
  var byId = qc.byId;
  var el = R.el;
  var tx = H.tx;
  var WAIT = 10000;

  // ---- a worktree of its own ----

  var wt = byId('code-worktree');
  var hint = byId('code-wt-hint');
  function sync() {
    if (!wt) return;
    var st = H.st();
    var pick = byId('code-folder').value;
    var f = st.d.filter(function (one) { return one.id === pick; })[0];
    var can = st.f.worktree === true;
    var git = can && !!f && f.git === true;
    wt.disabled = !git;
    if (!git) wt.checked = false;
    wt.parentNode.title = !can ? tx('later', '') : git ? hint.textContent : tx('gitOnly', '');
    hint.hidden = !wt.checked;
  }
  R.sync = sync;
  if (wt) {
    wt.addEventListener('change', sync);
    byId('code-folder').addEventListener('change', sync);
  }

  // ---- a row's ⋯ ----

  function close(button) {
    var menu = button.closest('details');
    if (menu) menu.open = false;
  }
  function item(name, word, action, id) {
    var b = el('button', 'fx-menu-item');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.setAttribute('data-action', action);
    b.setAttribute('data-session', id);
    b.appendChild(R.icon(name));
    b.appendChild(document.createTextNode(word));
    return b;
  }
  R.rowMenu = function (row, s) {
    if (s.device) return;
    var more = el('details', 'fx-more');
    var button = el('summary', 'fx-icon-btn fx-more-btn');
    button.setAttribute('aria-label', tx('actions', '') + ' \\u00b7 ' + (s.title || tx('untitled', '')));
    button.appendChild(R.icon('ellipsis'));
    var menu = el('div', 'fx-menu');
    menu.setAttribute('role', 'menu');
    menu.appendChild(item('pencil', tx('rename', ''), 'code-rename', s.id));
    menu.appendChild(item('trash-2', tx('remove', ''), 'code-delete', s.id));
    more.appendChild(button);
    more.appendChild(menu);
    row.classList.add('has-more');
    row.appendChild(more);
  };

  function rowOf(id) {
    var list = byId('code-sessions');
    return list && list.querySelector('.fx-ritem[data-session="' + id.replace(/"/g, '') + '"]');
  }

  qc.onAction('code-rename', function (button) {
    var id = button.getAttribute('data-session') || '';
    close(button);
    var s = H.st().s[id];
    var row = rowOf(id);
    if (!s || !row) return;
    var before = s.title || '';
    var field = el('input', 'fx-code-rename');
    field.type = 'text';
    field.maxLength = 120;
    field.value = before;
    field.setAttribute('aria-label', tx('rename', ''));
    R.hold = true;
    row.parentNode.classList.add('is-renaming');
    row.parentNode.replaceChild(field, row);
    field.focus();
    field.select();
    var done = false;
    function finish(save) {
      if (done) return;
      done = true;
      R.hold = false;
      var next = field.value.replace(/[\\u0000-\\u001f\\u007f]+/g, ' ').trim();
      var now = H.st().s[id];
      if (save && now && next && next !== before) {
        now.title = next;
        H.call('qmo_local_rename', { session: id, title: next }).then(null, function (err) {
          var back = H.st().s[id];
          if (back && back.title === next) back.title = before;
          H.side();
          H.head();
          H.tell(H.why(err), 'warn');
        });
      }
      H.side();
      H.head();
      var again = rowOf(id);
      if (again) again.focus();
    }
    field.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
    });
    field.addEventListener('blur', function () { finish(true); });
  });

  // ---- deleting, with ten seconds to undo ----

  var undo = byId('code-undo');
  var waiting = null;

  function settle() {
    var p = waiting;
    waiting = null;
    if (!p) return;
    clearTimeout(p.timer);
    undo.hidden = true;
    H.call('qmo_local_delete', { session: p.id }).then(function (data) {
      delete R.hidden[p.id];
      delete H.st().s[p.id];
      H.side();
      if (data && data.worktree === 'kept') H.tell(tx('kept', '').replace('{p}', String(data.path || '')), 'warn');
    }, function (err) {
      delete R.hidden[p.id];
      H.side();
      H.tell(H.why(err), 'warn');
    });
  }

  qc.onAction('code-delete', function (button) {
    var id = button.getAttribute('data-session') || '';
    close(button);
    var s = H.st().s[id];
    if (!s) return;
    settle();
    R.hidden[id] = true;
    waiting = { id: id, timer: setTimeout(settle, WAIT) };
    if (H.st().c === id) H.blank(true);
    else H.side();
    undo.querySelector('.fx-code-undo-word').textContent = tx('removed', '').replace('{t}', s.title || tx('untitled', ''));
    undo.hidden = false;
  });

  qc.onAction('code-undo', function () {
    var p = waiting;
    waiting = null;
    if (!p) return;
    clearTimeout(p.timer);
    delete R.hidden[p.id];
    undo.hidden = true;
    H.side();
  });
})();
`
}

/** Code's session management, after `CODE_JS` in `/code`. */
export const CODE_MANAGE_JS = stripJsLineComments(manageScript())
