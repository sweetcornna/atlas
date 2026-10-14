// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 添加服务器的页面脚本（`view/replicate.ts`）。检查 → 确认 → 部署 → 跟进度。
 *
 * 每一个从回包里来的值都经 `textContent` 进页面。口令与私钥在检查请求发出的
 * 同一刻从输入框里清掉：之后的确认与部署只认宿主给的票。
 *
 * 部署过程中中枢会重启一次（「重启中枢」那一步），那几秒里读进度会失败；这不是
 * 作业失败，脚本照常隔两秒再读，直到作业自己说做完或失败。
 */

export const REPLICATE_PAGE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  var byId = qc.byId;
  var timer = 0;
  var misses = 0;

  function el(root, role) { return root ? root.querySelector('[data-role="' + role + '"]') : null; }
  function show(node, on) { if (node) node.hidden = !on; }
  function text(node, value) { if (node) node.textContent = value; }
  function mb(n) { return n >= 1024 ? (n / 1024).toFixed(1) + ' GB' : n + ' MB'; }

  function authKind(form) {
    var picked = form.querySelector('input[name="auth"]:checked');
    return picked ? picked.value : 'password';
  }

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || target.name !== 'auth' || !target.closest('#rp-inspect-form')) return;
    var blocks = document.querySelectorAll('#rp-inspect-form [data-auth]');
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].hidden = blocks[i].getAttribute('data-auth') !== target.value;
    }
  });

  function clearSecrets(form) {
    if (form.elements.password) form.elements.password.value = '';
    if (form.elements.key) form.elements.key.value = '';
  }

  qc.onSubmit('rp-inspect-form', function (form) {
    var status = byId('rp-inspect-status');
    var host = form.elements.host.value.trim();
    var port = Number(form.elements.port.value || '22');
    var user = form.elements.user.value.trim();
    var kind = authKind(form);
    var secret = kind === 'key' ? form.elements.key.value : form.elements.password.value;
    if (!host) { qc.say(status, '地址必填', 'bad'); return; }
    if (!user) { qc.say(status, '用户名必填', 'bad'); return; }
    if (!secret) { qc.say(status, kind === 'key' ? '私钥必填' : '口令必填', 'bad'); return; }
    clearSecrets(form);
    qc.say(status, '正在登录检查', 'muted');
    return qc.sendJson('POST', '/v0/replicate/inspect', {
      host: host, port: port, user: user, auth: { kind: kind, secret: secret }
    }).then(function (found) {
      secret = '';
      qc.say(status, '', 'muted');
      fillConfirm(found);
      show(form, false);
      show(byId('rp-start-form'), true);
    }).catch(function (err) {
      secret = '';
      qc.say(status, qc.failLine('检查', err), qc.failTone(err));
    });
  });

  function fillConfirm(found) {
    var form = byId('rp-start-form');
    if (!form) return;
    var key = found.hostKeys && found.hostKeys[0];
    form.elements.ticket.value = found.ticket || '';
    form.elements.fingerprint.value = key ? key.fingerprint : '';
    text(el(form, 'login'), found.user + '@' + found.host + (found.port === 22 ? '' : ':' + found.port));
    text(el(form, 'fingerprint'), key ? key.type + ' ' + key.fingerprint : '—');
    text(el(form, 'system'), [found.os, found.arch, found.kernel].filter(Boolean).join(' · ') || '—');
    text(el(form, 'mem'), found.memMb ? mb(found.memMb) : '—');
    text(el(form, 'disk'), found.diskMb ? mb(found.diskMb) + ' 可用' : '—');
    var reason = el(form, 'reason');
    text(reason, found.supported ? '' : '不能部署 · ' + (found.reason || ''));
    show(reason, !found.supported);
    var suggested = found.suggested || {};
    form.elements.node.value = suggested.node || '';
    form.elements.agent.value = suggested.agent || '';
    form.elements.server.value = suggested.server || '';
    var deploy = el(form, 'deploy');
    if (deploy) deploy.disabled = !found.supported || !key;
    qc.say(byId('rp-start-status'), '', 'muted');
  }

  function backToLogin() {
    var start = byId('rp-start-form');
    if (start) { start.elements.ticket.value = ''; start.elements.fingerprint.value = ''; }
    show(start, false);
    show(byId('rp-progress'), false);
    show(byId('rp-inspect-form'), true);
  }

  qc.onAction('rp-cancel', backToLogin);
  qc.onAction('rp-again', backToLogin);

  qc.onSubmit('rp-start-form', function (form) {
    var status = byId('rp-start-status');
    var body = {
      ticket: form.elements.ticket.value,
      fingerprint: form.elements.fingerprint.value,
      node: form.elements.node.value.trim(),
      agent: form.elements.agent.value.trim(),
      server: form.elements.server.value.trim()
    };
    if (!body.node || !body.agent || !body.server) { qc.say(status, '三个名字都要填', 'bad'); return; }
    qc.say(status, '正在开始', 'muted');
    return qc.sendJson('POST', '/v0/replicate/start', body).then(function (job) {
      form.elements.ticket.value = '';
      qc.say(status, '', 'muted');
      show(form, false);
      follow(job);
    }).catch(function (err) {
      qc.say(status, qc.failLine('部署', err), qc.failTone(err));
    });
  });

  function paint(job) {
    var card = byId('rp-progress');
    if (!card) return;
    show(card, true);
    text(el(card, 'title'), job.node + ' · ' + job.host);
    text(el(card, 'job'), job.job);
    var rollback = [];
    for (var i = 0; i < job.events.length; i++) {
      var ev = job.events[i];
      if (ev.step === 'rollback') { if (ev.detail) rollback.push(ev.detail); continue; }
      var row = card.querySelector('li[data-step="' + ev.step + '"]');
      if (!row) continue;
      if (ev.state === 'info') { text(el(row, 'detail'), ev.detail || ''); continue; }
      row.setAttribute('data-state', ev.state);
      if (ev.state === 'fail') text(el(row, 'detail'), ev.detail || '');
    }
    var done = el(card, 'done');
    var failed = el(card, 'failed');
    show(done, job.state === 'done');
    show(failed, job.state === 'failed');
    if (job.state === 'done') {
      text(done, '已上线 · ' + (job.address || ''));
      var chat = el(card, 'chat');
      if (chat && job.address) chat.setAttribute('href', '/?agent=' + encodeURIComponent(job.address));
    }
    if (job.state === 'failed') {
      text(failed, (job.error || '失败') + (rollback.length ? ' · ' + rollback.join('；') : ''));
    }
    show(el(card, 'after'), job.state !== 'running');
    show(el(card, 'chat'), job.state === 'done');
  }

  function stop() { if (timer) { clearTimeout(timer); timer = 0; } }

  function refreshList() {
    var mount = byId('rp-jobs');
    if (!mount) return;
    qc.loadHtml('/fragments/replicate/jobs').then(function (html) { mount.innerHTML = html; }).catch(function () {});
  }

  function follow(job) {
    stop();
    misses = 0;
    var rows = document.querySelectorAll('#rp-progress li[data-step]');
    for (var i = 0; i < rows.length; i++) {
      rows[i].setAttribute('data-state', 'todo');
      text(el(rows[i], 'detail'), '');
    }
    paint(job);
    if (job.state !== 'running') { refreshList(); return; }
    var id = job.job;
    function tick() {
      timer = 0;
      if (qc.isExpired()) return;
      qc.sendJson('GET', '/v0/replicate/jobs/' + encodeURIComponent(id)).then(function (next) {
        misses = 0;
        paint(next);
        if (next.state === 'running') timer = setTimeout(tick, 2000);
        else {
          refreshList();
          qc.toast(next.state === 'done' ? '已上线 · ' + next.node : '复制失败 · ' + next.node, next.state === 'done' ? 'ok' : 'bad');
        }
      }).catch(function () {
        // The hub restarts once during the job; keep reading.
        misses += 1;
        var card = byId('rp-progress');
        var row = card && card.querySelector('li[data-step="restart"]');
        if (row && misses > 1) text(el(row, 'detail'), '中枢重启中');
        timer = setTimeout(tick, misses > 30 ? 5000 : 2000);
      });
    }
    timer = setTimeout(tick, 1500);
  }

  qc.onExpire(stop);

  // A job that was running when the page loaded: pick it up.
  var running = document.querySelector('#rp-jobs li[data-state="running"]');
  if (running && byId('rp-progress')) {
    var id = running.getAttribute('data-job') || '';
    qc.sendJson('GET', '/v0/replicate/jobs/' + encodeURIComponent(id)).then(function (job) {
      show(byId('rp-inspect-form'), false);
      follow(job);
    }).catch(function () {});
  }
})();
`
