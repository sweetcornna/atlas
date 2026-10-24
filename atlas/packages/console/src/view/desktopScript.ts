// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 云端电脑's script (`view/desktop.ts`): a switch or a confirmation choice is
 * one `PUT /v0/desktop/<node>/<agent>`; recycling asks first. A refused
 * change puts the control back the way the server has it.
 *
 * The applications a computer may open are edited in a dialog, outside the
 * polled region, so a refresh cannot eat a list half typed. A host desktop
 * (macOS) takes a list only; turning one on without a list opens the dialog
 * and the save turns it on.
 *
 * Screens: each running computer's card has an empty frame; after the page
 * loads and after every refresh of the region this script asks
 * `GET …/screen` for the latest screenshot and shows it as a `data:` image —
 * the one image source the console's CSP allows. The last image of each
 * computer is kept here and put back the moment a refresh replaces the
 * frame, so the picture does not blink every poll.
 */

export const DESKTOP_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var APP_ID = /^[\\x21-\\x7e]{1,200}$/;
  var BASE64 = /^[A-Za-z0-9+\\/]+={0,2}$/;
  var TYPES = { 'image/png': true, 'image/jpeg': true, 'image/webp': true };

  function refresh() {
    var mount = byId('desktop');
    return mount ? qc.refreshRegion(mount) : Promise.resolve();
  }

  function path(node, agent) {
    return '/v0/desktop/' + encodeURIComponent(node) + '/' + encodeURIComponent(agent);
  }

  function keyOf(el) {
    return (el.getAttribute('data-node') || '') + '/' + (el.getAttribute('data-agent') || '');
  }

  /* ---------------- screens ---------------- */

  var shots = {};
  var faults = {};
  var loading = {};
  var viewing = '';

  function liveFrames() {
    return document.querySelectorAll('#desktop [data-desktop-screen]');
  }

  function paint(key) {
    var frames = liveFrames();
    var shot = shots[key] || null;
    var fault = faults[key] || '';
    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i];
      if (keyOf(frame) !== key) continue;
      var img = frame.querySelector('img');
      var empty = frame.querySelector('.dk-shot-empty');
      var field = frame.closest('.dk-field');
      var at = field ? field.querySelector('.dk-shot-at') : null;
      if (!img || !empty) continue;
      if (shot) {
        if (img.getAttribute('src') !== shot.src) img.setAttribute('src', shot.src);
        img.hidden = false;
        empty.hidden = true;
        frame.classList.add('dk-has');
        if (at) at.textContent = qc.stamp(new Date(shot.at)) + (fault ? ' · ' + fault : '');
      } else {
        img.removeAttribute('src');
        img.hidden = true;
        empty.hidden = false;
        empty.textContent = fault || '还没有截图';
        frame.classList.remove('dk-has');
        if (at) at.textContent = '';
      }
    }
    if (viewing === key && shot) {
      var big = byId('desktop-screen-img');
      if (big && big.getAttribute('src') !== shot.src) big.setAttribute('src', shot.src);
      qc.setText('desktop-screen-at', qc.stamp(new Date(shot.at)));
    }
  }

  function load(frame, then) {
    var key = keyOf(frame);
    if (loading[key]) return;
    loading[key] = true;
    var node = frame.getAttribute('data-node') || '';
    var agent = frame.getAttribute('data-agent') || '';
    qc.sendJson('GET', path(node, agent) + '/screen').then(function (view) {
      loading[key] = false;
      faults[key] = '';
      if (view && TYPES[view.mimeType] === true && typeof view.at === 'number' &&
          typeof view.data === 'string' && BASE64.test(view.data)) {
        shots[key] = { src: 'data:' + view.mimeType + ';base64,' + view.data, at: view.at };
      } else {
        shots[key] = null;
      }
      paint(key);
      if (then) then();
    }, function (err) {
      loading[key] = false;
      faults[key] = qc.message(err);
      paint(key);
      if (then) then();
    });
  }

  // Put back what is known at once, then ask for what is new. A computer
  // that stopped has no frame any more and forgets its picture.
  function screens() {
    var frames = liveFrames();
    var live = {};
    for (var i = 0; i < frames.length; i++) {
      var key = keyOf(frames[i]);
      if (live[key]) continue;
      live[key] = true;
      paint(key);
      load(frames[i]);
    }
    for (var known in shots) {
      if (Object.prototype.hasOwnProperty.call(shots, known) && !live[known]) {
        delete shots[known];
        delete faults[known];
      }
    }
  }

  var mount = byId('desktop');
  if (mount && typeof MutationObserver === 'function') {
    new MutationObserver(screens).observe(mount, { attributes: true, attributeFilter: ['data-refreshed'] });
  }
  // After the runtime's own start, which takes a token handed over in the
  // address first: a request before it would go out without one.
  function begin() { qc.afterSession(screens); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin);
  else begin();

  function openViewer(el) {
    var key = keyOf(el);
    var shot = shots[key];
    if (!shot) return false;
    viewing = key;
    var big = byId('desktop-screen-img');
    if (big) big.setAttribute('src', shot.src);
    qc.setText('desktop-screen-title', '画面 · ' + (el.getAttribute('data-agent') || '') + ' · ' + (el.getAttribute('data-node') || ''));
    qc.setText('desktop-screen-at', '截于 ' + qc.stamp(new Date(shot.at)) + ' · 不是实时画面');
    qc.openDialog('desktop-screen', null);
    return true;
  }

  qc.onAction('desktop-screen', function (frame) { openViewer(frame); });

  // 查看画面: the latest screenshot of the browser or the computer, asked
  // for now if this page has none yet.
  qc.onAction('desktop-view', function (button) {
    if (openViewer(button)) return;
    var key = keyOf(button);
    var frames = liveFrames();
    var frame = null;
    for (var i = 0; i < frames.length; i++) if (keyOf(frames[i]) === key) frame = frames[i];
    if (!frame) { qc.toast('没有在运行 · 没有画面', 'warn'); return; }
    load(frame, function () {
      if (!openViewer(button)) qc.toast(faults[key] || '还没有截图 · 智能体操作后会有', 'warn');
    });
  });

  // 打开浏览器: the one step from nothing to a browser the agent can use.
  qc.onAction('desktop-open', function (button) {
    var node = button.getAttribute('data-node') || '';
    var agent = button.getAttribute('data-agent') || '';
    qc.sendJson('PUT', path(node, agent), { browser: true }).then(function () {
      qc.toast(agent + ' · 浏览器已打开', 'ok');
      return refresh();
    }).catch(function (err) { qc.toast(qc.failLine('打开', err), qc.failTone(err)); });
  });

  var viewer = byId('desktop-screen');
  if (viewer) viewer.addEventListener('close', function () {
    viewing = '';
    var big = byId('desktop-screen-img');
    if (big) big.removeAttribute('src');
  });

  /* ---------------- applications ---------------- */

  var appsFor = null;

  function syncList(form) {
    var mode = form.querySelector('input[name="appsMode"]:checked');
    form.elements.appsList.disabled = !mode || mode.value !== 'list';
  }

  function openApps(el, enable) {
    var form = byId('desktop-apps-form');
    if (!form) return;
    var host = el.getAttribute('data-mode') === 'host';
    var current = el.getAttribute('data-desktop-apps') || 'all';
    appsFor = {
      node: el.getAttribute('data-node') || '',
      agent: el.getAttribute('data-agent') || '',
      host: host,
      enable: enable
    };
    qc.clearFields(form);
    var radios = form.querySelectorAll('input[name="appsMode"]');
    for (var i = 0; i < radios.length; i++) {
      var off = host && radios[i].value !== 'list';
      var opt = radios[i].closest('.seg-opt');
      if (opt) opt.hidden = off;
      radios[i].disabled = off;
      radios[i].checked = host ? radios[i].value === 'list' : radios[i].value === current;
    }
    form.elements.appsList.value = el.getAttribute('data-apps-list') || '';
    qc.setText('desktop-apps-name', appsFor.agent + ' · ' + appsFor.node);
    qc.setText('desktop-apps-note', host
      ? '本机桌面只能操作列表里的应用 · 每行一个 bundle id · 至多 20 个'
      : '每行一个编号 · 至多 50 个 · 终端另由开关决定');
    syncList(form);
    qc.openDialog('desktop-apps', null);
  }

  qc.onAction('desktop-apps', function (button) { openApps(button, false); });

  qc.onSubmit('desktop-apps-form', function (form) {
    var target = appsFor;
    if (!target) return;
    var mode = form.querySelector('input[name="appsMode"]:checked');
    var change = {};
    if (!mode || mode.value === 'list') {
      var limit = target.host ? 20 : 50;
      var parts = String(form.elements.appsList.value || '').split(/\\s+/);
      var ids = [];
      for (var i = 0; i < parts.length; i++) {
        if (parts[i] && ids.indexOf(parts[i]) === -1) ids.push(parts[i]);
      }
      var why = ids.length === 0 ? '至少填一个' : ids.length > limit ? '至多 ' + limit + ' 个' : '';
      for (var j = 0; j < ids.length && !why; j++) {
        if (!APP_ID.test(ids[j])) why = '编号只能是可见字符 · 每个至多 200 个';
      }
      if (why) {
        qc.markField(form, 'appsList', why);
        form.elements.appsList.focus();
        return;
      }
      change.apps = ids;
    } else {
      change.apps = mode.value;
    }
    if (target.enable) change.computer = true;
    qc.sendJson('PUT', path(target.node, target.agent), change).then(function () {
      qc.closeDialog(byId('desktop-apps'));
      qc.toast(target.agent + ' · ' + (target.enable ? '电脑已打开' : '应用已改'), 'ok');
      return refresh();
    }).catch(function (err) {
      if (qc.fieldOf(err, ['apps'])) qc.markField(form, 'appsList', qc.message(err));
      else qc.toast(qc.failLine('保存', err), qc.failTone(err));
    });
  });

  /* ---------------- switches ---------------- */

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var appsForm = target.closest('#desktop-apps-form');
    if (appsForm) {
      if (target.name === 'appsMode') syncList(appsForm);
      return;
    }
    if (!target.closest('#desktop')) return;
    var node = target.getAttribute('data-node');
    var agent = target.getAttribute('data-agent');
    if (!node || !agent) return;
    var change = null;
    var word = '';
    if (target.hasAttribute('data-desktop-unit')) {
      var unit = target.getAttribute('data-desktop-unit');
      if (unit === 'computer' && target.checked && target.hasAttribute('data-desktop-apps')) {
        target.checked = false;
        openApps(target, true);
        return;
      }
      change = {};
      change[unit] = target.checked;
      word = (unit === 'browser' ? '浏览器' : '电脑') + (target.checked ? '已打开' : '已关闭');
    } else if (target.hasAttribute('data-desktop-terminal')) {
      change = { terminal: target.checked };
      word = target.checked ? '终端已允许' : '终端已关闭';
    } else if (target.hasAttribute('data-desktop-confirm') && target.checked) {
      change = { confirm: target.value };
      word = '确认方式已改';
    }
    if (!change) return;
    target.disabled = true;
    qc.sendJson('PUT', path(node, agent), change).then(function () {
      qc.toast(agent + ' · ' + word, 'ok');
      return refresh();
    }).catch(function (err) {
      // The switch went back already, with the reason beside it
      // (data-write, assets/nav.ts); the next refresh confirms it.
      target.disabled = false;
      qc.toast(qc.failLine('切换', err), qc.failTone(err));
    });
  });

  qc.onAction('desktop-recycle', function (button) {
    var node = button.getAttribute('data-node') || '';
    var agent = button.getAttribute('data-agent') || '';
    qc.setText('confirm-desktop-recycle-name', agent + ' · ' + node);
    qc.openDialog('confirm-desktop-recycle', function () {
      qc.sendJson('POST', path(node, agent) + '/recycle', {}).then(function () {
        qc.toast(agent + ' 的浏览器与电脑已清空', 'ok');
        return refresh();
      }).catch(function (err) { qc.toast(qc.failLine('回收', err), qc.failTone(err)); });
    });
  });
})();
`
