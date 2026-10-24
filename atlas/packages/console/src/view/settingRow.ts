// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One setting as a row, declared rather than hand-built: the label and one
 * grey line on the left, the control on the right, the way a settings window
 * lays them out. A page lists its rows; this module draws them, and the
 * page's copy of {@link SETTING_ROW_JS} makes each one write itself. A page
 * that draws rows adds {@link SETTING_ROW_CSS} to its `css` and
 * {@link SETTING_ROW_JS} to its `script`: the shared sheet and runtime ride
 * every document, and most pages have no row (`test/p1.test.ts` G1 keeps
 * them small).
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

import { stripJsLineComments } from '../assets/client.js'
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

/** The rows' own rules, for the `css` of a page that draws rows. */
export const SETTING_ROW_CSS = `
/* ---- setting rows (view/settingRow.ts) ---- */
.settings-group { display: flex; flex-direction: column; gap: var(--space-2); }
.settings-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; padding: 0; }
.settings-title { font-size: var(--text-ui); font-weight: var(--weight-semibold); margin: 0; }
/* A group of settings is a list, not a box (qmo-local.md §3.4): one row per
   setting, a hairline between rows. */
.settings-card {
  display: flex; flex-direction: column; padding: 0;
  background: none; border-radius: 0;
}
.setting {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center;
  gap: 2px var(--space-4); padding: var(--space-3) 0; min-height: 52px;
  border-bottom: var(--hairline);
}
.setting:last-child { border-bottom: 0; }
.setting-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.setting-head { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.setting-label { font-size: var(--text-ui); font-weight: var(--weight-medium); color: var(--color-text); }
.setting-desc { font-size: var(--text-small); line-height: var(--lh-small); color: var(--color-muted); margin: 0; }
.setting-dot { display: none; width: 6px; height: 6px; border-radius: 50%; background: var(--color-interactive); flex: none; }
.setting[data-changed] .setting-dot { display: inline-block; }
.setting-scope { margin-left: 2px; }
.setting-reset {
  border: 0; background: none; padding: 0 2px; cursor: pointer; font: inherit;
  font-size: var(--text-small); color: var(--color-interactive-text);
  visibility: hidden; opacity: 0; transition: opacity var(--motion-snap) var(--ease-out);
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
.setting-error { grid-column: 1 / -1; margin: 2px 0 0; font-size: var(--text-small); color: var(--color-danger-text); }
.setting-error[hidden] { display: none; }
@media (max-width: 620px) {
  .setting { grid-template-columns: minmax(0, 1fr); }
  .setting-control { justify-content: flex-start; }
  .setting-sel, .setting-sel-wide, input.setting-input { width: 100%; }
}
`

/**
 * The rows' runtime, for the `script` of a page that draws rows: writes on
 * change, blur or Enter (never the Enter that ends a composition), puts a
 * refused value back with the reason under the row, 恢复默认, and the theme
 * row kept in step with the account menu. Pages with their own writer
 * register it with `qianmoConsole.onSetting(name, run)`.
 */
export const SETTING_ROW_JS = stripJsLineComments(`
(function () {
  'use strict';
  var qc = window.qianmoConsole;
  if (!qc || qc.onSetting) return;

  // A row writes itself: a switch, a select or a segmented choice on change,
  // a text box on blur or Enter. A refused write puts the control back to
  // the value the server has and says why under the row. Enter that ends an
  // input method's composition is the reader choosing characters, not
  // asking to save: it is ignored (isComposing, and the 229 of browsers that
  // do not set it).
  var settingHandlers = {};

  function settingInputs(row) { return row.querySelectorAll('[data-setting-input]'); }

  function settingRead(row) {
    var kind = row.getAttribute('data-setting-kind');
    var inputs = settingInputs(row);
    if (kind === 'switch') return inputs[0] && inputs[0].checked ? 'true' : 'false';
    if (kind === 'segmented') {
      for (var i = 0; i < inputs.length; i++) if (inputs[i].checked) return inputs[i].value;
      return '';
    }
    return inputs[0] ? String(inputs[0].value).trim() : '';
  }

  function settingPut(row, value) {
    var kind = row.getAttribute('data-setting-kind');
    var inputs = settingInputs(row);
    if (kind === 'switch') { if (inputs[0]) inputs[0].checked = value === 'true'; return; }
    if (kind === 'segmented') {
      for (var i = 0; i < inputs.length; i++) inputs[i].checked = inputs[i].value === value;
      return;
    }
    if (inputs[0]) inputs[0].value = value;
  }

  function settingMark(row) {
    var fallback = row.getAttribute('data-setting-default');
    if (fallback !== null && row.getAttribute('data-setting-value') !== fallback) row.setAttribute('data-changed', '');
    else row.removeAttribute('data-changed');
  }

  function settingError(row, text) {
    var err = row.querySelector('.setting-error');
    if (!err) return;
    err.textContent = text || '';
    err.hidden = !text;
  }

  function settingWire(row, value) {
    if (row.getAttribute('data-setting-kind') === 'switch') return value === 'true';
    if (row.querySelector('[data-setting-numeric]') && value !== '' && isFinite(Number(value))) return Number(value);
    return value;
  }

  function settingSend(row, value) {
    var name = row.getAttribute('data-setting-handler');
    if (name) {
      var run = settingHandlers[name];
      if (typeof run !== 'function') return Promise.reject({ human: '这一项需要页面脚本' });
      return Promise.resolve().then(function () { return run(settingWire(row, value), row); });
    }
    var endpoint = row.getAttribute('data-setting-endpoint');
    if (!endpoint) return Promise.reject({ human: '这一项是只读的' });
    var body = {};
    try { body = JSON.parse(row.getAttribute('data-setting-extra') || '{}') || {}; } catch (e) { body = {}; }
    body[row.getAttribute('data-setting-field') || ''] = settingWire(row, value);
    return qc.sendJson(row.getAttribute('data-setting-method') || 'PUT', endpoint, body);
  }

  function settingCommit(row, value) {
    var was = row.getAttribute('data-setting-value') || '';
    if (value === was || row.getAttribute('aria-busy') === 'true') return;
    row.setAttribute('aria-busy', 'true');
    settingError(row, '');
    settingSend(row, value).then(function () {
      row.setAttribute('data-setting-value', value);
      settingMark(row);
      row.dispatchEvent(new CustomEvent('qianmo:setting', { bubbles: true, detail: { value: value } }));
    }, function (err) {
      settingPut(row, was);
      settingError(row, qc.failLine('保存', err));
    }).then(function () { row.removeAttribute('aria-busy'); });
  }

  function settingOf(el) {
    if (!el || !el.closest || !el.hasAttribute || !el.hasAttribute('data-setting-input')) return null;
    return el.closest('.setting[data-setting]');
  }

  document.addEventListener('change', function (event) {
    var row = settingOf(event.target);
    if (!row || row.getAttribute('data-setting-kind') === 'text') return;
    settingCommit(row, settingRead(row));
  });

  document.addEventListener('focusout', function (event) {
    var row = settingOf(event.target);
    if (row && row.getAttribute('data-setting-kind') === 'text') settingCommit(row, settingRead(row));
  });

  document.addEventListener('keydown', function (event) {
    var row = settingOf(event.target);
    if (!row || row.getAttribute('data-setting-kind') !== 'text') return;
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      settingCommit(row, settingRead(row));
    } else if (event.key === 'Escape') {
      settingPut(row, row.getAttribute('data-setting-value') || '');
      settingError(row, '');
    }
  });

  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('[data-setting-reset]') : null;
    if (!button) return;
    var row = button.closest('.setting[data-setting]');
    if (!row) return;
    event.preventDefault();
    var fallback = row.getAttribute('data-setting-default');
    if (fallback === null) return;
    settingPut(row, fallback);
    settingCommit(row, fallback);
  });

  // 外观: the row and the account menu's select are one preference; the
  // runtime writes it (applyTheme) and says so (qianmo:theme).
  function showTheme(value) {
    var rows = document.querySelectorAll('.setting[data-setting-handler="theme"]');
    for (var i = 0; i < rows.length; i++) {
      settingPut(rows[i], value);
      rows[i].setAttribute('data-setting-value', value);
      settingMark(rows[i]);
    }
  }

  settingHandlers.theme = function (value) {
    if (!qc.applyTheme(String(value))) throw { human: '外观只认跟随系统 浅色 深色' };
  };

  document.addEventListener('qianmo:theme', function (event) {
    showTheme(event.detail && event.detail.value ? String(event.detail.value) : 'system');
  });
  showTheme(document.documentElement.getAttribute('data-theme') || 'system');

  // A setting row's own writer: run(value, row) -> a value or a promise.
  qc.onSetting = function (name, run) { settingHandlers[name] = run; };
})();
`)
