// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 设置与关于 · 实例 — which console this is, what it is wired to, and whether
 * those wires answer (A4).
 *
 * The facts come from the host (`ConsoleDeps.about`, the same values the
 * startup banner prints); the health comes from reads the page has just made.
 * The two are kept apart on the page because they answer different questions:
 * "what was this started with" does not change while it runs, "does it
 * answer" changes every minute.
 */

import type { ConsoleAbout, ConsoleFailure } from '../deps.js'
import { tag } from './bits.js'
import { escapeHtml } from './escape.js'

/** One port the page just asked, and what came back. */
interface PortHealth {
  readonly name: string
  /** `null` when it answered. */
  readonly failure: ConsoleFailure | null
}

interface AboutModel {
  readonly label: string
  readonly identity: string
  readonly binName: string
  readonly about?: ConsoleAbout
  readonly ports: readonly PortHealth[]
  /** The reader may write: the files this console keeps are shown to them. */
  readonly canWrite: boolean
}

function row(key: string, value: string, mono = true): string {
  return (
    `<div class="lim-row"><dt>${escapeHtml(key)}</dt>` +
    `<dd class="${mono ? 'mono' : 'plain'}">${value}</dd></div>`
  )
}

function list(values: readonly string[]): string {
  return values.length === 0
    ? '—'
    : values.map(value => escapeHtml(value)).join('<br>')
}

/** A wire as a word, and the banner's own line beside it for whoever needs it. */
function wired(on: boolean, line: string): string {
  return (
    tag(on ? '已开启' : '未开启', on ? 'ok' : 'muted') +
    ` <span class="mono note">${escapeHtml(line)}</span>`
  )
}

/** The instance section of 设置与关于. */
export function renderAbout(model: AboutModel): string {
  const about = model.about
  const rows = [
    row('实例', escapeHtml(model.label)),
    row('控制台身份', escapeHtml(model.identity)),
    row('命令名', escapeHtml(model.binName)),
  ]
  if (about !== undefined) {
    rows.push(
      row('构建', escapeHtml(about.sourceCommit)),
      row('注册中心', escapeHtml(about.registryUrl)),
      row('审计链来源', list(about.auditTrails)),
      row('唤醒', wired(!about.wake.startsWith('disabled'), about.wake), false),
      row(
        '唤醒签名',
        about.wakeSigning === undefined
          ? tag('未开启', 'muted')
          : tag('已开启', 'ok') +
              ` <span class="mono note">${escapeHtml(about.wakeSigning)}</span>`,
        false,
      ),
      row('对话', wired(!about.chat.startsWith('disabled'), about.chat), false),
      row(
        '对话签名',
        tag(
          about.chat.includes('(signed)') ? '已开启' : '未开启',
          about.chat.includes('(signed)') ? 'ok' : 'muted',
        ),
        false,
      ),
    )
  }
  const facts = `<dl class="dl">${rows.join('')}</dl>`

  const health =
    model.ports.length === 0
      ? ''
      : `<dl class="dl about-health">` +
        model.ports
          .map(port =>
            row(
              port.name,
              port.failure === null ? tag('可达', 'ok') : tag('不可达', 'bad'),
              false,
            ),
          )
          .join('') +
        `</dl>`

  const paths =
    about === undefined || about.paths.length === 0
      ? ''
      : model.canWrite
        ? `<dl class="dl about-paths">` +
          about.paths
            .map(([label, path]) => row(label, escapeHtml(path)))
            .join('') +
          `</dl>`
        : `<p class="note">数据路径仅对运维可见</p>`

  return facts + health + paths
}
