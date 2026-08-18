// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The small shapes every section reuses.
 *
 * Kept in one file so a failure reads the same in the node table as in the
 * trail. A console where "registry unreachable" and "trail unreadable" look
 * like two different kinds of event trains the operator to skim past one.
 *
 * ## Colour states a fact, and nothing else
 *
 * {@link state} and {@link toned} are the only two functions here that emit a
 * colour, and both of them are saying something about the network: 在线 /
 * 滞后 / 过期, 通过 / 拒绝 / 丢弃, 断裂. Nothing that an operator *does* is
 * coloured — buttons, borders and selected states are ink, and the accent hue
 * exists only in the focus ring. Once colour means "state" everywhere, a red
 * pixel anywhere on the page is worth turning your head for.
 *
 * ## The rail
 *
 * Every row of the page is `[rail][pane]`. {@link rail} builds the left cell:
 * the section noun in a mono micro-label, and under it one dense line of
 * digits. The digits are why the explanatory sentences could be deleted rather
 * than merely shortened — `4 · 在线 2` answers the question the sentence was
 * pretending to.
 */

import { attr, escapeHtml } from './escape.js'
import type { ConsoleRole } from '../auth.js'
import type { ConsoleFailure } from '../deps.js'

export type Tone = 'ok' | 'warn' | 'bad' | 'muted'

/** A one-line strip. Facts and a number, never a paragraph. */
export function bar(tone: Tone, text: string, extraClass = ''): string {
  const cls = `bar bar-${tone}${extraClass === '' ? '' : ` ${extraClass}`}`
  return `<p class="${cls}">${escapeHtml(text)}</p>`
}

/**
 * What went wrong, as a verb the subject can carry.
 *
 * `注册中心` + `unreachable` reads out as `注册中心不可达 · 连接被拒绝`: the
 * thing, what happened to it, then the detail. The old strip said
 * `注册中心 · <message>`, which made every failure depend on the port having
 * written a good sentence — and the ports write what their transport handed
 * them.
 *
 * The raw `code` still rides at the end even though `deps.ts` calls it "for
 * tests, not for users": when an operator files a bug report it is the one part
 * of the string that survives being retyped by hand.
 */
const FAILURE_LEAD: Readonly<Record<ConsoleFailure['code'], string>> = {
  unreachable: '不可达',
  rejected: '被拒绝',
  not_found: '未找到',
  unsupported: '不支持',
  invalid: '无效',
}

export function failureBar(failure: ConsoleFailure, subject: string): string {
  const lead = `${subject}${FAILURE_LEAD[failure.code] ?? '出错'}`
  return (
    `<p class="bar bar-bad" role="alert">` +
    `<span>${escapeHtml(lead)} · ${escapeHtml(failure.message)}</span>` +
    `<code class="bar-code">${escapeHtml(failure.code)}</code></p>`
  )
}

/** A coloured dot and a word — the status shape inside a table cell. */
export function state(tone: Tone, text: string): string {
  return (
    `<span class="state"><span class="dot dot-${tone}"></span>` +
    `${escapeHtml(text)}</span>`
  )
}

/**
 * A word in the colour of the thing it is reporting, with no dot.
 *
 * For the rail, where the counts sit one after another on a single dense line
 * and a row of dots would turn that line into beadwork.
 */
export function toned(tone: Tone, text: string): string {
  return `<span class="tone-${tone}">${escapeHtml(text)}</span>`
}

/** A neutral outlined label: capability tags, active filters, id fragments. */
export function chip(text: string, title?: string): string {
  const attrs = title === undefined ? '' : ` title="${attr(title)}"`
  return `<span class="chip"${attrs}>${escapeHtml(text)}</span>`
}

/** The empty state. One short line, and nothing else. */
export function hint(text: string): string {
  return `<p class="hint">${escapeHtml(text)}</p>`
}

/**
 * Horizontal scroll container for wide tables. Wide content scrolls inside its
 * own box; the page body never scrolls sideways.
 */
export function scroll(inner: string): string {
  return `<div class="scroll">${inner}</div>`
}

/** For a value that is genuinely absent, so an empty cell is never ambiguous. */
export function absent(): string {
  return '<span class="absent">—</span>'
}

/**
 * The left cell of a row: the section noun, and optionally a line of digits.
 *
 * `digits` is pre-rendered markup rather than a string because the numbers in
 * it are the coloured half of the page — `在线 2` is {@link toned} `ok` and
 * `断裂 2` is `bad`, and those two are the reason the row has a rail at all.
 */
export function rail(
  name: string,
  options: {
    readonly id?: string
    readonly digits?: string
    readonly sub?: boolean
    /** Id on the cell itself, for the regions the poller swaps. */
    readonly mount?: string
    /**
     * Numbers this rail already computed, echoed onto the cell as `data-*`
     * so `page.ts` can build the overview stat cards without re-deriving
     * them from a second pass over the source data. The keys are our own
     * literals, never attacker input, but the values still go through
     * {@link attr} — the discipline in `escape.ts` is "every interpolation",
     * not "every interpolation that looks risky today".
     */
    readonly stats?: Readonly<Record<string, string | number | boolean>>
  } = {},
): string {
  const tag = options.sub === true ? 'h3' : 'h2'
  const id = options.id === undefined ? '' : ` id="${attr(options.id)}"`
  const mount =
    options.mount === undefined ? '' : ` id="${attr(options.mount)}"`
  const statsAttrs =
    options.stats === undefined
      ? ''
      : Object.entries(options.stats)
          .map(([key, value]) => ` data-${key}="${attr(String(value))}"`)
          .join('')
  const digits =
    options.digits === undefined || options.digits === ''
      ? ''
      : `<p class="rail-num">${options.digits}</p>`
  return (
    `<div class="rail"${mount}${statsAttrs}>` +
    `<${tag} class="rail-name"${id}>${escapeHtml(name)}</${tag}>` +
    digits +
    `</div>`
  )
}

/** The `·` between two numbers on a rail line. Quiet enough to be a comma. */
export function railSep(): string {
  return '<span class="sep">·</span>'
}

/**
 * Which of the two credentials this page is being read with, and the way out.
 *
 * Both halves earn their pixels. The admin token is a strict superset of the
 * view token (`auth.ts`), so an operator holding one has no way to tell from
 * the page which one it is — until something is missing and the page looks
 * broken rather than restricted. And a console whose credential lives in a
 * cookie needs a door out of it: before the login page existed, "use a
 * different token" meant editing a URL; with an `HttpOnly` cookie it would
 * otherwise mean opening the browser's cookie settings.
 *
 * The logout control is a native form rather than a button the script wires up,
 * so it keeps working on the same terms as the login page it leads back to.
 * `none` renders nothing: a page reached without a credential is not a page
 * this function is ever asked about.
 */
const ROLE_TEXT: Readonly<Record<ConsoleRole, string>> = {
  admin: '管理',
  view: '只读',
  none: '',
}

export function identityControl(role: ConsoleRole): string {
  if (role === 'none') return ''
  return (
    `<div class="group identity">` +
    `<span class="chip" id="role">${escapeHtml(ROLE_TEXT[role])}</span>` +
    `<form id="logout-form" method="post" action="/logout">` +
    `<button type="submit" class="btn">退出</button></form>` +
    `</div>`
  )
}
