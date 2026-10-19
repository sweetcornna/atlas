// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One setting as a row, declared rather than hand-built: the label and one
 * grey line on the left, the control on the right, the way a settings window
 * lays them out. A page lists its rows; this module draws them, and the
 * shared runtime (`assets/client.ts`, 设置行) makes each one write itself.
 *
 * ## What a row promises
 *
 * - **A change is written at once.** A switch, a select or a segmented choice
 *   sends the moment it changes; a text box sends when it loses focus or on
 *   Enter — never on the Enter that ends an input method's composition, which
 *   is how a Chinese reader picks the characters they typed.
 * - **A refused change undoes itself.** The control goes back to the value
 *   the server has, and the reason is said under the row (`role="alert"`),
 *   not in a toast that leaves before it is read.
 * - **A changed row says so, quietly.** A small dot beside the label when the
 *   value is not the default, and 恢复默认 that appears on hover or focus.
 *   A row left alone draws neither.
 *
 * ## Where the write goes
 *
 * `endpoint` + `field`: `PUT <endpoint>` with `{ [field]: value, ...extra }`.
 * A setting whose write is not that shape names a `handler` instead, and the
 * page's script registers it with `qianmoConsole.onSetting(name, run)`;
 * `run(value, row)` returns a promise the row waits on. A row with neither is
 * read-only. A select is a fixed width (160px, `wide` 220px); two or three
 * choices are better as a segmented control.
 */

import { chevron } from './bits.js'
import { attr, escapeHtml } from './escape.js'

type Choices = readonly (readonly [value: string, label: string])[]

type SettingControl =
  | {
      readonly kind: 'switch'
      readonly value: boolean
      readonly default?: boolean
    }
  | {
      readonly kind: 'select'
      readonly value: string
      readonly options: Choices
      readonly default?: string
      readonly wide?: boolean
    }
  | {
      readonly kind: 'segmented'
      readonly value: string
      readonly options: Choices
      readonly default?: string
    }
  | {
      readonly kind: 'text'
      readonly value: string
      readonly default?: string
      readonly placeholder?: string
      readonly mono?: boolean
      /** Sent as a number when the box holds one. */
      readonly numeric?: boolean
      readonly maxLength?: number
    }
  | {
      /** Markup the caller drew: a button, a link, a value. Not written. */
      readonly kind: 'custom'
      readonly html: string
    }

interface SettingRow {
  /** Unique on the page; the control's id is `set-<id>`. */
  readonly id: string
  readonly label: string
  /** One line, grey, under the label. */
  readonly description?: string
  readonly control: SettingControl
  /** Where the change goes, with {@link SettingRow.field} as the key. */
  readonly endpoint?: string
  readonly field?: string
  readonly method?: 'PUT' | 'POST' | 'PATCH'
  /** Sent with every write, beside the field. */
  readonly extra?: Readonly<Record<string, string | number | boolean>>
  /** A page script's writer instead (`qianmoConsole.onSetting`). */
  readonly handler?: string
  /**
   * Why the control cannot be changed here, said in place of the
   * description; the control is drawn disabled, never left out.
   */
  readonly disabled?: string
  /** A scope that is the exception (本机, 所有节点), as a small badge. */
  readonly scope?: string
  /** A write control (`data-write`): absent from a read-only page. Default true. */
  readonly write?: boolean
}

function valueOf(control: SettingControl): string | null {
  switch (control.kind) {
    case 'switch':
      return control.value ? 'true' : 'false'
    case 'custom':
      return null
    default:
      return control.value
  }
}

function defaultOf(control: SettingControl): string | null {
  switch (control.kind) {
    case 'switch':
      return control.default === undefined
        ? null
        : control.default
          ? 'true'
          : 'false'
    case 'custom':
      return null
    default:
      return control.default ?? null
  }
}

function controlOf(row: SettingRow, inert: boolean): string {
  const id = `set-${row.id}`
  const off = inert ? ' disabled' : ''
  const write = row.write === false ? '' : ' data-write'
  const describedBy = ` aria-describedby="${attr(`${id}-desc ${id}-err`)}"`
  const control = row.control
  switch (control.kind) {
    case 'switch':
      return (
        `<label class="sw setting-sw"><input type="checkbox" id="${attr(id)}" ` +
        `data-setting-input${describedBy}${control.value ? ' checked' : ''}${off}${write}>` +
        `<span class="trk"></span><span class="sr-only">${escapeHtml(row.label)}</span></label>`
      )
    case 'select':
      return (
        `<span class="sel setting-sel${control.wide === true ? ' setting-sel-wide' : ''}">` +
        `<select class="input" id="${attr(id)}" data-setting-input${describedBy}${off}${write}>` +
        control.options
          .map(
            ([value, label]) =>
              `<option value="${attr(value)}"${value === control.value ? ' selected' : ''}>` +
              `${escapeHtml(label)}</option>`,
          )
          .join('') +
        `</select>${chevron()}</span>`
      )
    case 'segmented':
      return (
        `<div class="seg setting-seg" role="radiogroup" aria-labelledby="${attr(`${id}-label`)}" id="${attr(id)}">` +
        control.options
          .map(
            ([value, label]) =>
              `<label class="seg-opt"><input type="radio" name="${attr(id)}" value="${attr(value)}" ` +
              `data-setting-input${value === control.value ? ' checked' : ''}${off}${write}>` +
              `${escapeHtml(label)}</label>`,
          )
          .join('') +
        `</div>`
      )
    case 'text':
      return (
        `<input class="input setting-input${control.mono === true ? ' mono' : ''}" type="text" ` +
        `id="${attr(id)}" value="${attr(control.value)}" data-setting-input${describedBy} ` +
        `autocomplete="off" spellcheck="false"` +
        (control.numeric === true
          ? ' inputmode="numeric" data-setting-numeric'
          : '') +
        (control.placeholder === undefined
          ? ''
          : ` placeholder="${attr(control.placeholder)}"`) +
        (control.maxLength === undefined
          ? ''
          : ` maxlength="${control.maxLength}"`) +
        `${off}${write}>`
      )
    case 'custom':
      return control.html
  }
}

/** One setting row. */
export function settingRow(row: SettingRow): string {
  const id = `set-${row.id}`
  const value = valueOf(row.control)
  const fallback = defaultOf(row.control)
  const writable =
    row.control.kind !== 'custom' &&
    (row.endpoint !== undefined || row.handler !== undefined)
  const inert = row.disabled !== undefined || !writable
  const changed = fallback !== null && value !== null && value !== fallback
  const data =
    ` data-setting="${attr(row.id)}" data-setting-kind="${row.control.kind}"` +
    (value === null ? '' : ` data-setting-value="${attr(value)}"`) +
    (fallback === null ? '' : ` data-setting-default="${attr(fallback)}"`) +
    (row.endpoint === undefined
      ? ''
      : ` data-setting-endpoint="${attr(row.endpoint)}"` +
        ` data-setting-field="${attr(row.field ?? row.id)}"` +
        ` data-setting-method="${row.method ?? 'PUT'}"`) +
    (row.extra === undefined
      ? ''
      : ` data-setting-extra="${attr(JSON.stringify(row.extra))}"`) +
    (row.handler === undefined
      ? ''
      : ` data-setting-handler="${attr(row.handler)}"`) +
    (changed ? ' data-changed' : '')
  const labelFor =
    row.control.kind === 'segmented' || row.control.kind === 'custom'
      ? ''
      : ` for="${attr(id)}"`
  const reset =
    fallback === null || inert
      ? ''
      : `<button type="button" class="setting-reset" data-setting-reset${
          row.write === false ? '' : ' data-write'
        }>恢复默认</button>`
  const note = row.disabled ?? row.description
  return (
    `<div class="setting${row.disabled === undefined ? '' : ' is-disabled'}"${data}>` +
    `<div class="setting-text">` +
    `<div class="setting-head"><label class="setting-label" id="${attr(`${id}-label`)}"${labelFor}>` +
    `${escapeHtml(row.label)}</label>` +
    `<span class="setting-dot" title="已改动" aria-hidden="true"></span>` +
    (row.scope === undefined
      ? ''
      : `<span class="tag setting-scope">${escapeHtml(row.scope)}</span>`) +
    reset +
    `</div>` +
    (note === undefined
      ? `<span id="${attr(`${id}-desc`)}" hidden></span>`
      : `<p class="setting-desc" id="${attr(`${id}-desc`)}">${escapeHtml(note)}</p>`) +
    `</div>` +
    `<div class="setting-control">${controlOf(row, inert)}</div>` +
    `<p class="setting-error" id="${attr(`${id}-err`)}" role="alert" hidden></p>` +
    `</div>`
  )
}

/** A titled group of rows on one card. */
export function settingsGroup(
  title: string,
  rows: readonly string[],
  options: { readonly id?: string; readonly note?: string } = {},
): string {
  if (rows.length === 0) return ''
  const headingId = options.id === undefined ? undefined : `${options.id}-title`
  return (
    `<section class="settings-group"${options.id === undefined ? '' : ` id="${attr(options.id)}"`}` +
    `${headingId === undefined ? '' : ` aria-labelledby="${attr(headingId)}"`}>` +
    `<div class="settings-head"><h2 class="settings-title"${
      headingId === undefined ? '' : ` id="${attr(headingId)}"`
    }>${escapeHtml(title)}</h2>` +
    (options.note === undefined
      ? ''
      : `<span class="note">${escapeHtml(options.note)}</span>`) +
    `</div>` +
    `<div class="settings-card">${rows.join('')}</div></section>`
  )
}

/** The rows' own rules, appended to the shared sheet (`assets/css.ts`). */
export const SETTING_ROW_CSS = `
/* ---- setting rows (view/settingRow.ts) ---- */
.settings-group { display: flex; flex-direction: column; gap: var(--space-2); }
.settings-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; padding: 0 2px; }
.settings-title { font-size: var(--text-14); font-weight: 600; margin: 0; }
.settings-card {
  display: flex; flex-direction: column; padding: 0 var(--space-4);
  background: var(--color-surface); border-radius: var(--radius-xl); box-shadow: var(--shadow-sm);
}
.setting {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center;
  gap: 2px var(--space-4); padding: var(--space-3) 0; min-height: 52px;
  border-bottom: 1px solid var(--color-divider);
}
.setting:last-child { border-bottom: 0; }
.setting-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.setting-head { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.setting-label { font-size: var(--text-13); font-weight: 500; color: var(--color-text); }
.setting-desc { font-size: var(--text-12); color: var(--color-muted); margin: 0; }
.setting-dot { display: none; width: 6px; height: 6px; border-radius: 50%; background: var(--color-interactive); flex: none; }
.setting[data-changed] .setting-dot { display: inline-block; }
.setting-scope { margin-left: 2px; }
.setting-reset {
  border: 0; background: none; padding: 0 2px; cursor: pointer; font: inherit;
  font-size: var(--text-12); color: var(--color-interactive-text);
  visibility: hidden; opacity: 0; transition: opacity 120ms ease;
}
.setting[data-changed]:hover .setting-reset, .setting[data-changed]:focus-within .setting-reset { visibility: visible; opacity: 1; }
.setting-reset:hover { text-decoration: underline; }
@media (hover: none) { .setting[data-changed] .setting-reset { visibility: visible; opacity: 1; } }
.setting-control { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2); min-width: 0; }
.setting-sel { width: 160px; }
.setting-sel-wide { width: 220px; }
input.setting-input { width: 220px; }
.setting[aria-busy="true"] .setting-control { opacity: .6; }
.setting.is-disabled .setting-label { color: var(--color-muted); }
.setting-error { grid-column: 1 / -1; margin: 2px 0 0; font-size: var(--text-12); color: var(--color-danger-text); }
.setting-error[hidden] { display: none; }
@media (max-width: 620px) {
  .setting { grid-template-columns: minmax(0, 1fr); }
  .setting-control { justify-content: flex-start; }
  .setting-sel, .setting-sel-wide, input.setting-input { width: 100%; }
}
`
