// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 添加服务器：把中枢复制到一台新服务器（`node-provisioning.md` §14）。
 *
 * 三段，同一张卡片上依次出现：
 *
 * 1. 登录信息：地址、端口、用户名，口令或私钥。点「检查」只做一次只读的登录与
 *    探查，不往那台机器写任何东西。
 * 2. 确认：主机指纹、系统、内存、磁盘，以及节点名、智能体名与服务器名（可改）。
 *    点「部署」就是确认了这把指纹。
 * 3. 进度：一步一行，作业在后台跑，关掉页面也不影响。
 *
 * 第二、三段的骨架在这里画好，数值由页面脚本用 `textContent` 填：检查与进度的
 * 回包里每一个字段都来自那台陌生机器，不能当标记插进页面。
 *
 * 凭据输入框在提交之后由脚本清空；它们从不出现在任何回包或片段里。
 */

import type { ReplicateJob } from '../deps.js'
import { bar, sectionHead, state, timeTag, type Tone } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { actionButton, segmented, textArea, textField } from './kit.js'

/**
 * 作业的每一步与它在页面上的说法，顺序就是作业的顺序。宿主的执行器
 * （`qm replicate run`）用同一组名字，`test/replicate.test.ts` 钉住两边一致。
 */
export const REPLICATE_STEPS: readonly (readonly [
  step: string,
  label: string,
])[] = [
  ['pin', '核对主机指纹'],
  ['login', '登录'],
  ['probe', '检查环境'],
  ['prepare', '生成密钥'],
  ['payload', '复制部署树'],
  ['secrets', '写入密钥'],
  ['start', '启动节点'],
  ['register', '登记到中枢'],
  ['enroll', '接入模型下发'],
  ['restart', '重启中枢'],
  ['ready', '等待就绪'],
]

const REPLICATE_HEADING_ID = 'h-replicate'

function stepLabel(step: string): string {
  return REPLICATE_STEPS.find(([name]) => name === step)?.[1] ?? step
}

const JOB_TONE: Readonly<
  Record<ReplicateJob['state'], readonly [Tone, string]>
> = {
  running: ['muted', '进行中'],
  done: ['ok', '已上线'],
  failed: ['bad', '失败'],
}

/** One past or running job, as a line in the list under the form. */
function jobLine(job: ReplicateJob): string {
  const [tone, word] = JOB_TONE[job.state]
  const tail =
    job.state === 'done' && job.address !== undefined
      ? `<span class="mono">${escapeHtml(job.address)}</span>`
      : job.state === 'failed'
        ? `<span class="note">停在「${escapeHtml(stepLabel(job.step))}」${
            job.error === undefined ? '' : ` · ${escapeHtml(job.error)}`
          }</span>`
        : `<span class="note">${escapeHtml(stepLabel(job.step))}</span>`
  return (
    `<li class="rp-job" data-job="${attr(job.job)}" data-state="${attr(job.state)}">` +
    `<span class="rp-job-main"><b>${escapeHtml(job.node)}</b>` +
    `<span class="note mono">${escapeHtml(job.host)}</span></span>` +
    `${state(tone, word)}${tail}` +
    `<span class="note">${timeTag(job.updatedAt, 'clock', 'mono')}</span></li>`
  )
}

/** The list of jobs; also what `/fragments/replicate/jobs` answers. */
export function renderReplicateJobs(jobs: readonly ReplicateJob[]): string {
  if (jobs.length === 0) return `<p class="note rp-none">还没有复制记录</p>`
  return `<ul class="rp-jobs">${jobs.map(jobLine).join('')}</ul>`
}

function stepsSkeleton(): string {
  return (
    `<ol class="rp-steps" data-role="steps">` +
    REPLICATE_STEPS.map(
      ([step, label]) =>
        `<li data-step="${attr(step)}" data-state="todo">` +
        `<span class="rp-mark" aria-hidden="true"></span>` +
        `<span class="rp-label">${escapeHtml(label)}</span>` +
        `<span class="note rp-detail" data-role="detail"></span></li>`,
    ).join('') +
    `</ol>`
  )
}

interface ReplicateModel {
  /** Ops may run it; anyone else sees the list and one line saying why not. */
  readonly writable: boolean
  readonly jobs: readonly ReplicateJob[]
  /** A failed job read: the form still works, the list says it could not load. */
  readonly jobsFailure: string | null
}

export function renderReplicate(model: ReplicateModel): string {
  const head = sectionHead('Add server', '添加服务器', {
    headingId: REPLICATE_HEADING_ID,
  })
  const list =
    `<div class="rp-list" id="rp-jobs">` +
    (model.jobsFailure === null
      ? renderReplicateJobs(model.jobs)
      : bar('warn', `复制记录读不出来 · ${model.jobsFailure}`)) +
    `</div>`
  if (!model.writable) {
    return (
      head +
      `<div class="pane"><p class="note">只有运维账号可以添加服务器</p>${list}</div>`
    )
  }

  const login =
    `<form class="card elev-sm rp-card" id="rp-inspect-form" autocomplete="off">` +
    `<div class="form-grid rp-grid">` +
    textField('host', '地址', {
      required: true,
      mono: true,
      placeholder: '203.0.113.7',
      form: 'rp',
      maxLength: 253,
    }) +
    textField('port', 'SSH 端口', {
      type: 'number',
      value: '22',
      min: 1,
      max: 65535,
      form: 'rp',
    }) +
    textField('user', '用户名', {
      value: 'root',
      mono: true,
      form: 'rp',
      maxLength: 32,
    }) +
    segmented(
      'auth',
      '登录方式',
      [
        ['password', '口令'],
        ['key', '私钥'],
      ],
      'password',
    ) +
    `<div class="rp-auth" data-auth="password">` +
    textField('password', '口令', {
      type: 'password',
      form: 'rp',
      wide: true,
    }) +
    `</div>` +
    `<div class="rp-auth" data-auth="key" hidden>` +
    textArea('key', '私钥', {
      rows: 5,
      form: 'rp',
      placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----',
    }) +
    `</div>` +
    `</div>` +
    `<div class="row-acts">` +
    `<button type="submit" class="btn btn-primary btn-small" data-write>检查</button>` +
    `<span class="note">凭据只用这一次 · 不保存</span>` +
    `<span class="note" data-role="status" id="rp-inspect-status"></span>` +
    `</div></form>`

  const confirm =
    `<form class="card elev-sm rp-card" id="rp-start-form" hidden autocomplete="off">` +
    `<input type="hidden" name="ticket" value="">` +
    `<input type="hidden" name="fingerprint" value="">` +
    `<dl class="rp-facts">` +
    `<div><dt>服务器</dt><dd class="mono" data-role="login"></dd></div>` +
    `<div><dt>主机指纹</dt><dd class="mono" data-role="fingerprint"></dd></div>` +
    `<div><dt>系统</dt><dd data-role="system"></dd></div>` +
    `<div><dt>内存</dt><dd data-role="mem"></dd></div>` +
    `<div><dt>磁盘</dt><dd data-role="disk"></dd></div>` +
    `</dl>` +
    `<p class="bar bar-warn" data-role="reason" hidden></p>` +
    `<div class="form-grid rp-grid">` +
    textField('node', '节点名', {
      required: true,
      mono: true,
      form: 'rps',
      maxLength: 64,
    }) +
    textField('agent', '智能体名', {
      required: true,
      mono: true,
      form: 'rps',
      maxLength: 63,
    }) +
    textField('server', '服务器名', {
      required: true,
      mono: true,
      form: 'rps',
      maxLength: 64,
    }) +
    `</div>` +
    `<div class="row-acts">` +
    `<button type="submit" class="btn btn-primary btn-small" data-write data-role="deploy">部署</button>` +
    actionButton('rp-cancel', '取消', { tone: 'ghost', write: false }) +
    `<span class="note" id="rp-start-status"></span>` +
    `</div></form>`

  const progress =
    `<div class="card elev-sm rp-card" id="rp-progress" hidden>` +
    `<div class="rp-progress-head"><b data-role="title"></b>` +
    `<span class="note mono" data-role="job"></span></div>` +
    stepsSkeleton() +
    `<p class="bar bar-ok" data-role="done" hidden></p>` +
    `<p class="bar bar-bad" data-role="failed" hidden></p>` +
    `<div class="row-acts" data-role="after" hidden>` +
    `<a class="btn btn-secondary btn-small" data-role="chat" href="/">去对话</a>` +
    actionButton('rp-again', '再添加一台', { tone: 'ghost', write: false }) +
    `</div></div>`

  return (
    head +
    `<div class="pane"><div class="stack" id="replicate">` +
    login +
    confirm +
    progress +
    list +
    `</div></div>`
  )
}

/** Rules only this section needs. */
export const REPLICATE_CSS = `
#replicate-section [hidden] { display: none; }
.rp-card { padding: var(--space-4); display: grid; gap: var(--space-3); }
.rp-card .seg { justify-self: start; align-self: flex-start; width: max-content; }
.rp-grid .field-wide, .rp-auth { grid-column: 1 / -1; }
.rp-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-2) var(--space-4); margin: 0; }
.rp-facts dt { font-size: var(--text-12); color: var(--color-muted); }
.rp-facts dd { margin: 2px 0 0; overflow-wrap: anywhere; color: var(--color-text); }
.rp-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.rp-steps li { display: grid; grid-template-columns: 12px auto minmax(0, 1fr); align-items: center; gap: var(--space-3); font-size: var(--text-13); }
.rp-mark { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--color-divider); box-sizing: border-box; }
.rp-steps li[data-state="todo"] .rp-label { color: var(--color-muted); }
.rp-steps li[data-state="start"] .rp-mark { border-color: var(--color-text); animation: rp-pulse 1.2s ease-in-out infinite; }
.rp-steps li[data-state="ok"] .rp-mark { background: var(--color-accent-2-600); border-color: var(--color-accent-2-600); }
.rp-steps li[data-state="fail"] .rp-mark { background: var(--color-critical); border-color: var(--color-critical); }
.rp-detail { overflow-wrap: anywhere; }
.rp-progress-head { display: flex; gap: var(--space-3); align-items: baseline; flex-wrap: wrap; }
.rp-jobs { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.rp-job { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); align-items: baseline; font-size: var(--text-13); }
.rp-job-main { display: inline-flex; gap: var(--space-2); align-items: baseline; }
@keyframes rp-pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .rp-steps li[data-state="start"] .rp-mark { animation: none; } }
`
