// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 对话前台上的「部署到新服务器」（`node-provisioning.md` §14）。
 *
 * 在对话框里把一台服务器的 SSH 登录信息发给主智能体，就是让中枢把自己复制过去。
 * 这一句**不发给模型**：发送之前，页面脚本在浏览器里认出「地址 + 口令或私钥」，
 * 把它从输入框里拿走，改在输入框上方打开一张卡片，走与后台「添加服务器」同一组
 * 接口（`/v0/replicate/*`）：检查 → 看指纹与配置 → 部署 → 进度。
 *
 * 有私钥、没有地址时也不发：卡片说要补什么，原文留在输入框里由本人改。消息里
 * 有私钥时，服务端还有一道（`routes/chat.ts`），浏览器这一道漏了也到不了模型。
 * 只有口令、旁边没有服务器地址的一句话照常发送：那多半是在聊口令，不是在给。
 *
 * 卡片骨架由服务端画，数值一律经 `textContent` 填进去。
 */

import { attr, escapeHtml } from './escape.js'
import { REPLICATE_STEPS } from './replicate.js'

/**
 * 认出一句话里的 SSH 登录信息。纯函数，没有 DOM：前台脚本内联它，测试直接求值。
 *
 * 认的写法：`user@host[:port]`、`ssh [-p N] user@host`，或分开写的「主机/地址/IP」
 * 「用户/用户名」「端口」；口令跟在「密码/口令/password」后面，私钥是整段 PEM 或
 * OpenSSH 文本。没有口令也没有私钥就不是（返回 `null`），照常发送。
 */
export const SSH_INTENT_JS = `
function sshIntent(text) {
  if (typeof text !== 'string' || text.length > 20000) return null;
  var key = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/.exec(text);
  var rest = key ? text.replace(key[0], ' ') : text;
  // A password is printable ASCII: 「密码怎么改」 is a question, not a password.
  var pw = /(?:密码|口令|\\bpassword\\b|\\bpasswd\\b|\\bpwd\\b)\\s*(?:是|为|[:：=])?\\s*([\\x21-\\x7e]+)/i.exec(rest);
  var secret = key ? key[0] : (pw ? pw[1] : '');
  if (!secret && /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) secret = text.slice(text.indexOf('-----BEGIN'));
  if (!secret) return null;
  if (pw) rest = rest.replace(pw[0], ' ');
  var host = '';
  var user = '';
  var port = 0;
  var at = /(?:^|[\\s:：,，(（])([A-Za-z_][A-Za-z0-9_.-]{0,31})@(\\[[0-9A-Fa-f:]+\\]|(?:\\d{1,3}\\.){3}\\d{1,3}|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)(?::(\\d{1,5}))?/.exec(rest);
  if (at) {
    user = at[1];
    host = at[2].replace(/^\\[|\\]$/g, '');
    if (at[3]) port = Number(at[3]);
  } else {
    var bare = /(?:^|[^\\d.])((?:\\d{1,3}\\.){3}\\d{1,3})(?![\\d.])/.exec(rest);
    var named = /(?:主机|地址|服务器|\\bhost\\b)\\s*(?:是|为|[:：=])?\\s*(\\[[0-9A-Fa-f:]+\\]|[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+)/i.exec(rest);
    if (bare) host = bare[1];
    else if (named) host = named[1].replace(/^\\[|\\]$/g, '');
    var who = /(?:用户名|用户|账号|\\buser(?:name)?\\b)\\s*(?:是|为|[:：=])?\\s*([A-Za-z_][A-Za-z0-9_.-]{0,31})/i.exec(rest);
    if (who) user = who[1];
  }
  if (!port) {
    var p = /(?:-p\\s*|端口\\s*(?:是|为|[:：=])?\\s*|\\bport\\b\\s*(?:is|[:=])?\\s*)(\\d{1,5})/i.exec(rest);
    if (p) port = Number(p[1]);
  }
  return {
    host: host,
    user: user || 'root',
    port: port > 0 && port < 65536 ? port : 22,
    auth: { kind: key || secret.indexOf('-----BEGIN') === 0 ? 'key' : 'password', secret: secret }
  };
}
`

/**
 * Who may use it on this page: `ops`, or `view` (the card says why not). `off`
 * — no `--replicate` on this console — leaves the card and its script out;
 * the server still refuses a private key in a chat message.
 */
export type FrontReplicateMode = 'ops' | 'view' | 'off'

/** The card above the composer. Present on every front page; hidden until used. */
export function frontReplicateCard(mode: FrontReplicateMode): string {
  const steps = REPLICATE_STEPS.map(
    ([step, label]) =>
      `<li data-step="${attr(step)}" data-state="todo"><span class="rp-mark" aria-hidden="true"></span>` +
      `<span class="rp-label">${escapeHtml(label)}</span>` +
      `<span class="note rp-detail" data-role="detail"></span></li>`,
  ).join('')
  return (
    `<section class="fx-rp" id="fx-rp" data-mode="${attr(mode)}" aria-live="polite" hidden>` +
    `<div class="fx-rp-head"><b>部署到新服务器</b>` +
    `<span class="note mono" data-role="login"></span>` +
    `<button type="button" class="btn btn-ghost btn-small fx-rp-x" data-action="fx-rp-close">关闭</button></div>` +
    `<p class="fx-rp-line note" data-role="status"></p>` +
    `<dl class="rp-facts" data-role="facts" hidden>` +
    `<div><dt>主机指纹</dt><dd class="mono" data-role="fingerprint"></dd></div>` +
    `<div><dt>系统</dt><dd data-role="system"></dd></div>` +
    `<div><dt>内存</dt><dd data-role="mem"></dd></div>` +
    `<div><dt>磁盘</dt><dd data-role="disk"></dd></div>` +
    `</dl>` +
    `<p class="bar bar-warn" data-role="reason" hidden></p>` +
    `<div class="fx-rp-names" data-role="names" hidden>` +
    `<label class="field"><span class="flabel">节点名</span><input class="input mono" name="rp-node" maxlength="64" autocomplete="off" spellcheck="false"></label>` +
    `<label class="field"><span class="flabel">智能体名</span><input class="input mono" name="rp-agent" maxlength="63" autocomplete="off" spellcheck="false"></label>` +
    `<label class="field"><span class="flabel">服务器名</span><input class="input mono" name="rp-server" maxlength="64" autocomplete="off" spellcheck="false"></label>` +
    `</div>` +
    `<ol class="rp-steps" data-role="steps" hidden>${steps}</ol>` +
    `<p class="bar" data-role="done" hidden></p>` +
    `<p class="bar bar-bad" data-role="failed" hidden></p>` +
    `<div class="fx-rp-acts" data-role="acts" hidden>` +
    `<button type="button" class="btn btn-primary btn-small" data-action="fx-rp-deploy">部署</button>` +
    `<button type="button" class="btn btn-ghost btn-small" data-action="fx-rp-close">取消</button></div>` +
    `<div class="fx-rp-acts" data-role="after" hidden>` +
    `<a class="btn btn-secondary btn-small" data-role="chat" href="/">打开对话</a></div>` +
    `</section>`
  )
}

export const FRONT_REPLICATE_CSS = `
.fx-rp { margin-bottom: 8px; padding: 12px 14px; border: 1px solid var(--fx-line, var(--color-divider)); border-radius: 14px; background: var(--color-surface); box-shadow: var(--shadow-sm); display: grid; gap: 10px; }
.fx-rp[hidden] { display: none; }
.fx-rp-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.fx-rp-head .fx-rp-x { margin-left: auto; }
.fx-rp-line:empty { display: none; }
.fx-rp-names { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.fx-rp-names[hidden] { display: none; }
.fx-rp-acts { display: flex; gap: 8px; flex-wrap: wrap; }
.fx-rp-acts[hidden] { display: none; }
.fx-rp .rp-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px 14px; margin: 0; }
.fx-rp .rp-facts[hidden] { display: none; }
.fx-rp .rp-facts dt { font-size: var(--text-12); color: var(--color-muted); }
.fx-rp .rp-facts dd { margin: 2px 0 0; overflow-wrap: anywhere; color: var(--color-text); font-size: var(--text-13); }
.fx-rp .rp-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.fx-rp .rp-steps[hidden] { display: none; }
.fx-rp .rp-steps li { display: grid; grid-template-columns: 12px auto minmax(0, 1fr); align-items: center; gap: 10px; font-size: var(--text-13); }
.fx-rp .rp-mark { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--color-divider); box-sizing: border-box; }
.fx-rp .rp-steps li[data-state="todo"] .rp-label { color: var(--color-muted); }
.fx-rp .rp-steps li[data-state="start"] .rp-mark { border-color: var(--color-text); animation: fx-rp-pulse 1.2s ease-in-out infinite; }
.fx-rp .rp-steps li[data-state="ok"] .rp-mark { background: var(--color-accent-2-600); border-color: var(--color-accent-2-600); }
.fx-rp .rp-steps li[data-state="fail"] .rp-mark { background: var(--color-critical); border-color: var(--color-critical); }
.fx-rp .rp-detail { overflow-wrap: anywhere; }
@keyframes fx-rp-pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .fx-rp .rp-steps li[data-state="start"] .rp-mark { animation: none; } }
`

/**
 * The card's script. `window.qianmoFrontReplicate.take(text)` is what the
 * composer asks before it sends (`assets/frontClient.ts`): `'taken'` means the
 * line was credentials and is now this card's; `'keep'` means it was, but
 * something is missing, so the text stays in the box and is not sent; `null`
 * means an ordinary line.
 */
export const FRONT_REPLICATE_JS = `
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc) return;
  ${SSH_INTENT_JS}
  var card = qc.byId('fx-rp');
  var mode = card ? card.getAttribute('data-mode') : 'off';
  var ticket = '';
  var fingerprint = '';
  var timer = 0;
  var misses = 0;
  var busy = false;

  function el(role) { return card ? card.querySelector('[data-role="' + role + '"]') : null; }
  function show(node, on) { if (node) node.hidden = !on; }
  function text(node, value) { if (node) node.textContent = value; }
  function mb(n) { return n >= 1024 ? (n / 1024).toFixed(1) + ' GB' : n + ' MB'; }
  function field(name) { return card ? card.querySelector('[name="' + name + '"]') : null; }

  function reset() {
    if (timer) { clearTimeout(timer); timer = 0; }
    ticket = ''; fingerprint = ''; busy = false; misses = 0;
    ['facts', 'reason', 'names', 'steps', 'done', 'failed', 'acts', 'after'].forEach(function (role) { show(el(role), false); });
    var rows = card ? card.querySelectorAll('li[data-step]') : [];
    for (var i = 0; i < rows.length; i++) {
      rows[i].setAttribute('data-state', 'todo');
      var d = rows[i].querySelector('[data-role="detail"]');
      if (d) d.textContent = '';
    }
  }

  function line(value, tone) { qc.say(el('status'), value, tone || 'muted'); }

  function inspect(intent) {
    reset();
    show(card, true);
    text(el('login'), intent.user + '@' + intent.host + (intent.port === 22 ? '' : ':' + intent.port));
    line('正在登录检查 · 凭据没有发给模型', 'muted');
    busy = true;
    var body = { host: intent.host, port: intent.port, user: intent.user, auth: intent.auth };
    intent.auth = null;
    qc.sendJson('POST', '/v0/replicate/inspect', body).then(function (found) {
      busy = false;
      body = null;
      var key = found.hostKeys && found.hostKeys[0];
      ticket = found.ticket || '';
      fingerprint = key ? key.fingerprint : '';
      text(el('fingerprint'), key ? key.type + ' ' + key.fingerprint : '—');
      text(el('system'), [found.os, found.arch, found.kernel].filter(Boolean).join(' · ') || '—');
      text(el('mem'), found.memMb ? mb(found.memMb) : '—');
      text(el('disk'), found.diskMb ? mb(found.diskMb) + ' 可用' : '—');
      show(el('facts'), true);
      var suggested = found.suggested || {};
      if (field('rp-node')) field('rp-node').value = suggested.node || '';
      if (field('rp-agent')) field('rp-agent').value = suggested.agent || '';
      if (field('rp-server')) field('rp-server').value = suggested.server || '';
      if (!found.supported || !key) {
        text(el('reason'), '不能部署 · ' + (found.reason || '没有读到主机指纹'));
        show(el('reason'), true);
        line('', 'muted');
        return;
      }
      line('核对指纹无误后点「部署」', 'muted');
      show(el('names'), true);
      show(el('acts'), true);
    }).catch(function (err) {
      busy = false;
      body = null;
      line(qc.failLine('检查', err), qc.failTone(err));
    });
  }

  function paint(job) {
    show(el('steps'), true);
    var rollback = [];
    for (var i = 0; i < job.events.length; i++) {
      var ev = job.events[i];
      if (ev.step === 'rollback') { if (ev.detail) rollback.push(ev.detail); continue; }
      var row = card.querySelector('li[data-step="' + ev.step + '"]');
      if (!row) continue;
      var detail = row.querySelector('[data-role="detail"]');
      if (ev.state === 'info') { text(detail, ev.detail || ''); continue; }
      row.setAttribute('data-state', ev.state);
      if (ev.state === 'fail') text(detail, ev.detail || '');
    }
    show(el('done'), job.state === 'done');
    show(el('failed'), job.state === 'failed');
    show(el('after'), job.state === 'done');
    if (job.state === 'done') {
      text(el('done'), '已上线 · ' + (job.address || ''));
      var chat = el('chat');
      if (chat && job.address) chat.setAttribute('href', '/?agent=' + encodeURIComponent(job.address));
      line('', 'muted');
    }
    if (job.state === 'failed') {
      text(el('failed'), (job.error || '失败') + (rollback.length ? ' · ' + rollback.join('；') : ''));
      line('', 'muted');
    }
  }

  function follow(id) {
    function tick() {
      timer = 0;
      if (qc.isExpired()) return;
      qc.sendJson('GET', '/v0/replicate/jobs/' + encodeURIComponent(id)).then(function (job) {
        misses = 0;
        paint(job);
        if (job.state === 'running') timer = setTimeout(tick, 2000);
        else qc.toast(job.state === 'done' ? '已上线 · ' + job.node : '复制失败 · ' + job.node, job.state === 'done' ? 'ok' : 'bad');
      }).catch(function () {
        misses += 1;
        if (misses > 1) line('中枢重启中', 'muted');
        timer = setTimeout(tick, misses > 30 ? 5000 : 2000);
      });
    }
    timer = setTimeout(tick, 1500);
  }

  qc.onAction('fx-rp-deploy', function () {
    if (busy || !ticket) return;
    var body = {
      ticket: ticket,
      fingerprint: fingerprint,
      node: field('rp-node') ? field('rp-node').value.trim() : '',
      agent: field('rp-agent') ? field('rp-agent').value.trim() : '',
      server: field('rp-server') ? field('rp-server').value.trim() : ''
    };
    if (!body.node || !body.agent || !body.server) { line('三个名字都要填', 'bad'); return; }
    busy = true;
    line('正在开始', 'muted');
    qc.sendJson('POST', '/v0/replicate/start', body).then(function (job) {
      ticket = '';
      show(el('names'), false);
      show(el('acts'), false);
      line('在后台进行 · 关掉页面也不影响', 'muted');
      paint(job);
      follow(job.job);
    }).catch(function (err) {
      busy = false;
      line(qc.failLine('部署', err), qc.failTone(err));
    });
  });

  qc.onAction('fx-rp-close', function () {
    if (timer) { clearTimeout(timer); timer = 0; }
    reset();
    show(card, false);
  });

  qc.onExpire(function () { if (timer) { clearTimeout(timer); timer = 0; } });

  window.qianmoFrontReplicate = {
    take: function (value) {
      var intent = sshIntent(value);
      if (!intent) return null;
      // A password with no server beside it is just a sentence about one.
      if (intent.auth.kind === 'password' && !intent.host) return null;
      if (!card) return 'keep';
      show(card, true);
      if (mode !== 'ops') {
        reset();
        text(el('login'), '');
        line('凭据没有发出 · 只有运维账号可以部署新服务器', 'warn');
        return 'keep';
      }
      if (!intent.host) {
        reset();
        text(el('login'), '');
        line('私钥没有发出 · 没认出服务器地址 · 写成 root@203.0.113.7 再发', 'warn');
        return 'keep';
      }
      if (busy || timer) { line('上一台还在进行', 'warn'); return 'keep'; }
      // Started outside the composer's submit: a request begun inside it
      // belongs to the send button (client.ts C4), which would come back
      // enabled over an empty box once the check answers.
      busy = true;
      setTimeout(function () { inspect(intent); }, 0);
      return 'taken';
    }
  };
})();
`
