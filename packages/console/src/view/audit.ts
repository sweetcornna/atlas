// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The trail, and one reconstructed chain out of it.
 *
 * Two rules from the packages this renders carry into the markup, and both are
 * the kind of thing a tidier-looking rewrite quietly undoes:
 *
 * 1. **Refusals are the content, not the noise.** `query.ts` never filters on
 *    outcome, because a chain showing only what worked answers "what
 *    happened?" with "the parts that happened". So `refused` and `dropped` are
 *    never greyed down, and the chain states both counts first.
 * 2. **A broken hash chain is a headline.** `AuditPage.intact === false` means
 *    the trail may have been edited underneath us. It is stated twice, in two
 *    registers: `断裂 2` in `--dead` on the rail, where the eye lands before
 *    anything else, and a one-line strip at the top of the results.
 *
 * The way (2) is expressed changed once: it used to be a full-bleed dark red
 * banner pinned above the whole page. A banner that wide is a banner that gets
 * dismissed as chrome, it pushed the actual page down by a row, and it made the
 * loudest thing on screen a colour rather than a number. Two red characters in
 * the ledger rail are quieter and harder to stop seeing.
 *
 * ## The chain is a path, not a second table
 *
 * `renderChain` draws hops left to right — `node ──kind──● node` — because the
 * one question that brings somebody to a reconstructed chain is *where did it
 * stop*, and a stack of table rows answers that with reading rather than with
 * looking. The outcome is the mark at the end of each segment: a filled dot for
 * 通过, a hollow square for 拒绝, a dashed segment for 丢弃. Flex boxes and
 * hairlines; no SVG, no icon font, no pictograph.
 *
 * ## Why the filter form is outside `#audit-results`
 *
 * The poller refreshes `#audit-rail` and `#audit-results` and leaves the form
 * alone. A five-second timer that replaces the form is a five-second timer that
 * eats whatever the operator was typing into the trace box.
 */

import { AuditSource, traceIdSegment } from '@qianmo/audit'
import type { AuditRecord, MessageChain } from '@qianmo/audit'
import {
  absent,
  chip,
  failureBar,
  hint,
  rail,
  railSep,
  scroll,
  state,
  toned,
  type Tone,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatDateTime, formatDuration, toDatetimeLocal } from './format.js'
import type { AuditFilter, AuditPage, ConsoleFailure } from '../deps.js'

/** How many characters of an id are enough to tell two of them apart. */
const ID_PREFIX = 8

const OUTCOME_LABEL: Readonly<Record<string, string | undefined>> = {
  ok: '通过',
  refused: '拒绝',
  dropped: '丢弃',
}

const OUTCOME_TONE: Readonly<Record<string, Tone | undefined>> = {
  ok: 'ok',
  refused: 'bad',
  dropped: 'warn',
}

/** Chinese name for each of the 12 layers; unknown values print raw. */
const SOURCE_LABEL: Readonly<Record<string, string | undefined>> = {
  transport: '传输',
  router: '路由',
  capability: '能力',
  activator: '唤醒',
  adapter: '适配',
  resident: '常驻',
  negotiation: '协商',
  tunnel: '隧道',
  backup: '备份',
  diagnosis: '诊断',
  registry: '注册',
  capacity: '容量',
}

function sourceText(source: string): string {
  return SOURCE_LABEL[source] ?? source
}

function outcomeText(outcome: string): string {
  return OUTCOME_LABEL[outcome] ?? outcome
}

function outcomeCell(outcome: string): string {
  return state(OUTCOME_TONE[outcome] ?? 'muted', outcomeText(outcome))
}

function shortId(value: string): string {
  return value.length <= ID_PREFIX ? value : `${value.slice(0, ID_PREFIX)}…`
}

/**
 * `detail` is a free-form map written by whichever layer logged the line, so
 * both keys and values are attacker-shaped. Rendered as escaped `k=v` text.
 */
function detailLine(
  detail: Readonly<Record<string, string | number | boolean>> | undefined,
): string {
  if (detail === undefined) return ''
  const entries = Object.entries(detail)
  if (entries.length === 0) return ''
  const text = entries
    .map(
      ([key, value]) =>
        `${escapeHtml(key)}=<span class="dv">${escapeHtml(String(value))}</span>`,
    )
    .join(' · ')
  return `<div class="detail">${text}</div>`
}

/** Clickable. Full segment in `data-trace`, eight characters on screen. */
function traceCell(traceId: string | undefined): string {
  const segment = traceIdSegment(traceId)
  if (segment === null || segment === '') return absent()
  return (
    `<button type="button" class="linkish" data-action="chain" ` +
    `data-trace="${attr(segment)}" title="${attr(segment)}">` +
    `${escapeHtml(shortId(segment))}</button>`
  )
}

function partiesCell(record: AuditRecord): string {
  const node = record.node
  const peer = record.peer
  if (node === undefined && peer === undefined) return absent()
  const left = node === undefined ? '?' : node
  if (peer === undefined) return `<span class="mono">${escapeHtml(left)}</span>`
  return (
    `<span class="mono">${escapeHtml(left)}</span>` +
    `<span class="arrow">→</span>` +
    `<span class="mono">${escapeHtml(peer)}</span>`
  )
}

function recordRow(record: AuditRecord): string {
  return (
    `<tr data-outcome="${attr(record.outcome)}">` +
    `<td class="when mono">${escapeHtml(formatDateTime(record.at))}</td>` +
    `<td>${escapeHtml(sourceText(record.source))}</td>` +
    `<td class="kind"><span class="mono">${escapeHtml(record.kind)}</span>` +
    `${detailLine(record.detail)}</td>` +
    `<td>${outcomeCell(record.outcome)}</td>` +
    `<td>${traceCell(record.traceId)}</td>` +
    `<td class="parties">${partiesCell(record)}</td>` +
    `<td class="mono">${
      record.code === undefined ? absent() : escapeHtml(record.code)
    }</td>` +
    `</tr>`
  )
}

const RECORD_HEADERS = ['时间', '来源', 'kind', '结果', 'trace', '节点', 'code']

function recordTable(records: readonly AuditRecord[]): string {
  const head = RECORD_HEADERS.map(
    h => `<th scope="col">${escapeHtml(h)}</th>`,
  ).join('')
  const body = records.map(recordRow).join('')
  return scroll(
    `<table class="grid audit"><caption class="sr-only">审计记录</caption>` +
      `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
  )
}

function option(value: string, label: string, selected: string | undefined) {
  const mark = selected === value ? ' selected' : ''
  return `<option value="${attr(value)}"${mark}>${escapeHtml(label)}</option>`
}

function textField(
  name: string,
  label: string,
  value: string | undefined,
  placeholder: string,
): string {
  return (
    `<label class="field"><span>${escapeHtml(label)}</span>` +
    `<input type="text" name="${attr(name)}" value="${attr(value ?? '')}" ` +
    `placeholder="${attr(placeholder)}" autocomplete="off" ` +
    `spellcheck="false"></label>`
  )
}

function timeField(name: string, label: string, at: number | undefined) {
  const value = at === undefined ? '' : toDatetimeLocal(at)
  return (
    `<label class="field"><span>${escapeHtml(label)}</span>` +
    `<input type="datetime-local" name="${attr(name)}" ` +
    `value="${attr(value)}"></label>`
  )
}

/**
 * The filter bar. A plain `GET` form with no `action`, so it works with script
 * disabled and so the resulting URL is shareable — "here is the query that
 * shows the incident" is the most useful thing an operator can paste into a
 * ticket.
 */
function filterForm(filter: AuditFilter): string {
  const sources = Object.values(AuditSource)
    .map(value => option(value, sourceText(value), filter.source))
    .join('')
  const outcomes = (['ok', 'refused', 'dropped'] as const)
    .map(value => option(value, OUTCOME_LABEL[value] ?? value, filter.outcome))
    .join('')

  return (
    `<form id="audit-filter" class="filters" method="get">` +
    `<label class="field"><span>来源</span><select name="source">` +
    `${option('', '全部', filter.source === undefined ? '' : filter.source)}` +
    `${sources}</select></label>` +
    `<label class="field"><span>结果</span><select name="outcome">` +
    `${option('', '全部', filter.outcome === undefined ? '' : filter.outcome)}` +
    `${outcomes}</select></label>` +
    textField('traceId', 'trace', filter.traceId, 'traceparent 或 trace 段') +
    textField('taskId', 'task', filter.taskId, 'task id') +
    textField('agent', '节点', filter.agent, 'qianmo://node/agent') +
    timeField('from', '起', filter.from) +
    timeField('to', '止', filter.to) +
    `<label class="field field-narrow"><span>条数</span>` +
    `<input type="number" name="limit" min="1" max="1000" ` +
    `value="${attr(filter.limit === undefined ? '' : String(filter.limit))}" ` +
    `placeholder="100"></label>` +
    `<div class="field field-actions">` +
    `<button type="submit" class="btn btn-primary">筛选</button>` +
    `<a class="btn" href="?">清空</a></div>` +
    `</form>`
  )
}

/** Echo of what is being filtered on, so the table is never ambiguous. */
function activeChips(filter: AuditFilter): string {
  const chips: string[] = []
  const push = (key: string, value: string | undefined) => {
    if (value !== undefined && value !== '') chips.push(chip(`${key} ${value}`))
  }
  push('source', filter.source)
  push('outcome', filter.outcome)
  push('trace', filter.traceId)
  push('task', filter.taskId)
  push('node', filter.agent)
  if (filter.from !== undefined) push('from', formatDateTime(filter.from))
  if (filter.to !== undefined) push('to', formatDateTime(filter.to))
  if (chips.length === 0) return ''
  return `<p class="chips">${chips.join('')}</p>`
}

const INTEGRITY_LEAD = '审计链断裂'

/**
 * The second statement of a broken chain: one line, at the top of the results.
 *
 * The first statement is `断裂 N` on the rail. This one exists because the rail
 * digit is two characters and a number, and an operator who has never seen it
 * before needs the noun spelled out once. It is a strip, not a banner: the fact
 * and the count, nothing about what a hash chain is. That belongs in the docs —
 * on screen it made the strip long enough to scan past, which defeats the only
 * thing it is for.
 */
function integrityAlert(page: AuditPage | null): string {
  if (page === null || page.intact) return ''
  const count = Number.isFinite(page.issueCount) ? page.issueCount : 0
  return (
    `<p class="bar bar-bad" id="audit-integrity" role="alert">` +
    `<span>${escapeHtml(INTEGRITY_LEAD)} · ` +
    `<span class="n">${escapeHtml(String(count))}</span> 处</span></p>`
  )
}

const TRAIL_HEADING_ID = 'h-trail'

/**
 * The rail line: how much trail there is, how much of it is on screen, and
 * whether the hash chain still verifies.
 *
 * `显示 N` appears only when a filter is actually hiding something. Printing
 * `512 · 显示 512` every time trains the eye to skip the line that is
 * supposed to be carrying `断裂 2`.
 */
function trailRail(page: AuditPage | null): string {
  const mount = 'audit-rail'
  if (page === null) {
    return rail('消息链', { id: TRAIL_HEADING_ID, mount })
  }

  const parts = [`<span class="total">${escapeHtml(String(page.total))}</span>`]
  const shown = page.records.length
  if (shown !== page.total) parts.push(`显示 ${shown}`)
  const issues = Number.isFinite(page.issueCount) ? page.issueCount : 0
  parts.push(page.intact ? toned('ok', '完整') : toned('bad', `断裂 ${issues}`))
  return rail('消息链', {
    id: TRAIL_HEADING_ID,
    mount,
    digits: parts.join(railSep()),
    // Echoed for the overview 消息链 stat card in page.ts — see the note on
    // `stats` in bits.ts for why the page reads these off the markup rather
    // than re-deriving them from a second copy of `page`.
    stats: { total: page.total, issues, intact: page.intact },
  })
}

/** Render the audit fragment: the rail cell, then the pane with form + results. */
export function renderAudit(
  page: AuditPage | null,
  failure: ConsoleFailure | null,
  filter: AuditFilter,
): string {
  const results: string[] = []
  if (failure !== null) results.push(failureBar(failure, '审计日志'))

  if (page === null) {
    if (failure === null) results.push(hint('未读取审计日志'))
  } else {
    results.push(integrityAlert(page))
    results.push(activeChips(filter))
    results.push(
      page.records.length === 0
        ? hint('无匹配记录')
        : recordTable(page.records),
    )
  }

  return (
    trailRail(page) +
    `<div class="pane">` +
    filterForm(filter) +
    `<div id="audit-results">${results.join('')}</div>` +
    `</div>`
  )
}

function idChips(label: string, values: readonly string[]): string {
  if (values.length === 0) return ''
  const items = values.map(value => chip(shortId(value), value)).join('')
  return (
    `<p class="chain-meta"><span class="k">${escapeHtml(label)}</span>` +
    `${items}</p>`
  )
}

/** The mark that ends a hop: what happened, drawn rather than written. */
function hopMark(outcome: string): string {
  const kind =
    outcome === 'ok'
      ? 'ok'
      : outcome === 'refused'
        ? 'refused'
        : outcome === 'dropped'
          ? 'dropped'
          : 'muted'
  return (
    `<span class="hop-mark mark-${kind}" title="${attr(
      outcomeText(outcome),
    )}"></span>` +
    `<span class="sr-only">${escapeHtml(outcomeText(outcome))}</span>`
  )
}

/**
 * One hop: where it happened, what was attempted, how it ended.
 *
 * The node name falls back to the layer that logged the line. A record without
 * `node` is not anonymous — it happened in 传输 or 路由 — and printing `?`
 * there would throw away the one thing the record does say about location.
 */
function hop(record: AuditRecord): string {
  const where = record.node ?? sourceText(record.source)
  const code =
    record.code === undefined
      ? ''
      : `<span class="hop-code mono">${escapeHtml(record.code)}</span>`
  return (
    `<li class="hop" data-outcome="${attr(record.outcome)}" ` +
    `data-seq="${attr(String(record.seq))}">` +
    `<span class="hop-node mono" title="${attr(where)}">` +
    `${escapeHtml(where)}</span>` +
    `<span class="hop-link"><span class="hop-kind mono">` +
    `${escapeHtml(record.kind)}</span><span class="hop-line"></span></span>` +
    hopMark(record.outcome) +
    code +
    `</li>`
  )
}

function chainHead(title: string): string {
  return (
    `<div class="chain-head">` +
    `<h3 class="chain-title">消息链</h3>` +
    title +
    `<span class="spacer"></span>` +
    `<button type="button" class="btn" data-action="chain-close">关闭` +
    `</button></div>`
  )
}

/**
 * One reconstructed chain, in the order `reconstructChain` handed it over.
 *
 * The order is `seq`, not `at`, and this renderer must not re-sort: two nodes'
 * clocks disagree, and a timestamp sort can put an ack above the message it
 * answers. Anything that looks out of order is a real clock skew worth seeing,
 * not a display bug worth fixing.
 */
export function renderChain(chain: MessageChain | null): string {
  if (chain === null) {
    return chainHead('') + hint('未找到该 trace')
  }

  const counts = [`${chain.records.length} 条`]
  if (chain.refused > 0) counts.push(toned('bad', `拒绝 ${chain.refused}`))
  if (chain.dropped > 0) counts.push(toned('warn', `丢弃 ${chain.dropped}`))
  const head = chainHead(
    `<span class="chain-count">${counts.join(railSep())}</span>`,
  )

  // The path. Each record is one hop; the final peer, when the last record
  // names one, closes the line so the reader can see where it was headed.
  const last = chain.records[chain.records.length - 1]
  const terminal =
    last !== undefined && last.peer !== undefined
      ? `<li class="hop"><span class="hop-node mono" title="${attr(
          last.peer,
        )}">${escapeHtml(last.peer)}</span></li>`
      : ''
  const hops = `<ol class="hops">${chain.records
    .map(hop)
    .join('')}${terminal}</ol>`

  const meta = idChips('task', chain.taskIds) + idChips('msg', chain.msgIds)

  const foot =
    `<p class="chain-foot mono">` +
    `<span title="${attr(chain.traceId)}">` +
    `${escapeHtml(shortId(chain.traceId))}</span>` +
    ` · ${escapeHtml(formatDuration(chain.lastAt - chain.firstAt))}</p>`

  return head + hops + meta + foot
}
