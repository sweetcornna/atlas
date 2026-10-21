// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The form and card pieces the 2026-10 areas are built from
 * (`directionPorts.ts`): 接力, 文件互通, 记忆, 主动执行, 云端电脑, 应用连接,
 * 任务分工.
 *
 * Everything here composes classes the shared sheet already defines —
 * `.field`, `.sel`, `.chk`, `.sw`, `.seg`, `.card`, `.stat`, `.dialog` — so
 * the new pages look like the old ones by construction rather than by a
 * second sheet that tries to. Like every view module: text in, escaped
 * markup out; nothing here reads a request.
 */

import { chevron, icon } from './bits.js'
import { attr, escapeHtml } from './escape.js'

/** The coloured disc and title at the top of a dialog. */
export function dialogTop(
  id: string,
  glyph: string,
  title: string,
  alt = false,
): string {
  return (
    `<div class="dlg-top"><span class="dlg-icon${alt ? ' dlg-icon-2' : ''}">` +
    icon(glyph) +
    `</span><div class="dialog-title" id="${attr(id)}">` +
    `${escapeHtml(title)}</div></div>`
  )
}

/** The cancel and confirm buttons at the foot of a dialog form. */
export function dialogActions(
  submitLabel: string,
  options: {
    readonly glyph?: string
    readonly danger?: boolean
    /** A `data-action` for a confirm dialog; absent makes a form's submit button. */
    readonly action?: string
    readonly cancel?: string
  } = {},
): string {
  const cls = options.danger === true ? 'btn btn-danger' : 'btn btn-primary'
  const glyph =
    options.glyph === undefined ? '' : icon(options.glyph, { small: true })
  const button =
    options.action === undefined
      ? `<button type="submit" class="${cls}" data-write>${glyph}${escapeHtml(submitLabel)}</button>`
      : `<button type="button" class="${cls}" data-action="${attr(options.action)}" data-write>` +
        `${glyph}${escapeHtml(submitLabel)}</button>`
  return (
    `<div class="dialog-actions">` +
    `<button type="button" class="btn btn-secondary" data-action="confirm-cancel">` +
    `${escapeHtml(options.cancel ?? '取消')}</button>` +
    button +
    `</div>`
  )
}

interface FieldOptions {
  readonly required?: boolean
  readonly wide?: boolean
  readonly value?: string
  readonly placeholder?: string
  /** One quiet line under the control. */
  readonly help?: string
  readonly type?: 'text' | 'password' | 'number' | 'time' | 'url' | 'email'
  readonly mono?: boolean
  readonly min?: number
  readonly max?: number
  readonly maxLength?: number
  /** Id prefix, for a page with two forms that share field names. */
  readonly form?: string
}

function fieldId(name: string, options: FieldOptions): string {
  return `f-${options.form === undefined ? '' : `${options.form}-`}${name}`
}

function labelOf(id: string, label: string, required: boolean): string {
  const mark = required ? '<i class="req">*</i>' : ''
  return `<label for="${attr(id)}">${escapeHtml(label)}${mark}</label>`
}

function helpOf(help: string | undefined): string {
  return help === undefined
    ? ''
    : `<span class="note field-help">${escapeHtml(help)}</span>`
}

/** One labelled input. */
export function textField(
  name: string,
  label: string,
  options: FieldOptions = {},
): string {
  const id = fieldId(name, options)
  const cls = options.wide === true ? 'field field-wide' : 'field'
  const type = options.type ?? 'text'
  const extra =
    (options.required === true ? ' required' : '') +
    (options.value === undefined ? '' : ` value="${attr(options.value)}"`) +
    (options.placeholder === undefined
      ? ''
      : ` placeholder="${attr(options.placeholder)}"`) +
    (options.min === undefined ? '' : ` min="${options.min}"`) +
    (options.max === undefined ? '' : ` max="${options.max}"`) +
    (options.maxLength === undefined ? '' : ` maxlength="${options.maxLength}"`)
  const inputCls = options.mono === true ? 'input mono' : 'input'
  return (
    `<div class="${cls}">${labelOf(id, label, options.required === true)}` +
    `<input class="${inputCls}" type="${type}" id="${attr(id)}" name="${attr(name)}" ` +
    `autocomplete="off" spellcheck="false"${extra}>${helpOf(options.help)}</div>`
  )
}

/** One labelled textarea. */
export function textArea(
  name: string,
  label: string,
  options: FieldOptions & { readonly rows?: number } = {},
): string {
  const id = fieldId(name, options)
  const cls = options.wide === false ? 'field' : 'field field-wide'
  const extra =
    (options.required === true ? ' required' : '') +
    (options.placeholder === undefined
      ? ''
      : ` placeholder="${attr(options.placeholder)}"`) +
    (options.maxLength === undefined ? '' : ` maxlength="${options.maxLength}"`)
  return (
    `<div class="${cls}">${labelOf(id, label, options.required === true)}` +
    `<textarea class="input" id="${attr(id)}" name="${attr(name)}" rows="${
      options.rows ?? 4
    }" spellcheck="false"${extra}>${escapeHtml(options.value ?? '')}</textarea>` +
    `${helpOf(options.help)}</div>`
  )
}

/** One labelled native select with the shared chevron. */
export function selectField(
  name: string,
  label: string,
  choices: readonly (readonly [value: string, text: string])[],
  options: FieldOptions & { readonly selected?: string } = {},
): string {
  const id = fieldId(name, options)
  const cls = options.wide === true ? 'field field-wide' : 'field'
  const opts = choices
    .map(
      ([value, text]) =>
        `<option value="${attr(value)}"${
          value === options.selected ? ' selected' : ''
        }>${escapeHtml(text)}</option>`,
    )
    .join('')
  return (
    `<div class="${cls}">${labelOf(id, label, options.required === true)}` +
    `<span class="sel"><select class="input" id="${attr(id)}" name="${attr(name)}"` +
    `${options.required === true ? ' required' : ''}>${opts}</select>${chevron()}</span>` +
    `${helpOf(options.help)}</div>`
  )
}

/** A pill checkbox (`.chk`). Several sharing a name make a multi-choice. */
function checkPill(
  name: string,
  value: string,
  text: string,
  checked = false,
): string {
  return (
    `<label class="chk"><input type="checkbox" name="${attr(name)}" value="${attr(
      value,
    )}"${checked ? ' checked' : ''}>` +
    `<span class="bx">${icon('check', { small: true })}</span>${escapeHtml(text)}</label>`
  )
}

/** A labelled group of pill checkboxes. */
export function checkGroup(
  name: string,
  label: string,
  choices: readonly (readonly [value: string, text: string])[],
  checked: readonly string[] = [],
  help?: string,
): string {
  return (
    `<div class="field field-wide"><span class="flabel">${escapeHtml(label)}</span>` +
    `<div class="rowx gap-2 wrap">${choices
      .map(([value, text]) =>
        checkPill(name, value, text, checked.includes(value)),
      )
      .join('')}</div>${helpOf(help)}</div>`
  )
}

/** The pill switch (`.sw`), for an on/off setting inside a form. */
export function switchField(
  name: string,
  label: string,
  checked: boolean,
  options: { readonly id?: string; readonly disabled?: boolean } = {},
): string {
  const id = options.id ?? `f-${name}`
  return (
    `<label class="sw" for="${attr(id)}"><input type="checkbox" id="${attr(
      id,
    )}" name="${attr(name)}"${checked ? ' checked' : ''}${
      options.disabled === true ? ' disabled' : ''
    }>` + `<span class="trk"></span><span>${escapeHtml(label)}</span></label>`
  )
}

/** A segmented single choice (`.seg`). */
export function segmented(
  name: string,
  label: string,
  choices: readonly (readonly [value: string, text: string])[],
  selected: string,
): string {
  return (
    `<div class="field field-wide"><span class="flabel">${escapeHtml(label)}</span>` +
    `<div class="seg" role="radiogroup" aria-label="${attr(label)}">${choices
      .map(
        ([value, text]) =>
          `<label class="seg-opt"><input type="radio" name="${attr(name)}" value="${attr(
            value,
          )}"${value === selected ? ' checked' : ''}>${escapeHtml(text)}</label>`,
      )
      .join('')}</div></div>`
  )
}

/** One number card for the row at the top of an area. */
export function statCard(card: {
  readonly kicker: string
  readonly value: string
  readonly hint: string
  readonly glyph: string
  readonly blob?: 'blob-2' | 'blob-n'
  readonly unit?: string
}): string {
  const blob = card.blob === undefined ? 'blob' : `blob ${card.blob}`
  const unit =
    card.unit === undefined
      ? ''
      : `<span class="u">${escapeHtml(card.unit)}</span>`
  return (
    `<div class="card elev-sm stat">` +
    `<div class="stat-top"><div class="card-kicker">${escapeHtml(card.kicker)}</div>` +
    `<span class="${blob}">${icon(card.glyph)}</span></div>` +
    `<div class="stat-num">${escapeHtml(card.value)}${unit}</div>` +
    `<div class="card-meta">${card.hint}</div></div>`
  )
}

/** An empty state: a short title, one note, and an optional action. */
export function emptyState(title: string, note: string, action = ''): string {
  return (
    `<div class="empty card elev-sm"><div class="stack gap-3">` +
    `<h4 class="empty-title">${escapeHtml(title)}</h4>` +
    `<p class="empty-note">${escapeHtml(note)}</p>${action}</div></div>`
  )
}

/**
 * The card an area shows when its port is not wired into this console: what
 * it would do, and the flag that turns it on. Stated, never left blank — an
 * unwired area that renders an empty table reads as "nothing yet".
 */
export function unwiredCard(
  what: string,
  how: string,
  command?: string,
): string {
  const cmd =
    command === undefined
      ? ''
      : `<code class="cmd mono" data-raw>${escapeHtml(command)}</code>`
  return (
    `<div class="card elev-sm unwired" data-unwired>` +
    `<div class="rowx gap-2">${icon('info', { small: true })}` +
    `<b>${escapeHtml(what)}未接入</b></div>` +
    `<p class="note">${escapeHtml(how)}</p>${cmd}</div>`
  )
}

/** A small button wired to a page action (`qianmoConsole.onAction`). */
export function actionButton(
  action: string,
  label: string,
  options: {
    readonly glyph?: string
    readonly tone?: 'primary' | 'secondary' | 'danger' | 'ghost'
    readonly small?: boolean
    readonly data?: Readonly<Record<string, string>>
    readonly write?: boolean
  } = {},
): string {
  const tone = options.tone ?? 'secondary'
  const cls = `btn btn-${tone}${options.small === false ? '' : ' btn-small'}`
  const data = Object.entries(options.data ?? {})
    .map(([key, value]) => ` data-${key}="${attr(value)}"`)
    .join('')
  return (
    `<button type="button" class="${cls}" data-action="${attr(action)}"${data}` +
    `${options.write === false ? '' : ' data-write'}>` +
    (options.glyph === undefined ? '' : icon(options.glyph, { small: true })) +
    `${escapeHtml(label)}</button>`
  )
}

/** One entry of a row's 更多 menu: what its button would have carried. */
interface MoreItem {
  readonly action: string
  readonly label: string
  readonly data?: Readonly<Record<string, string>>
  /** Undoes something: drawn in the danger colour. */
  readonly danger?: boolean
}

/** A short stable tag for an element id: FNV-1a of the text, base 36. */
function idTag(text: string): string {
  let hash = 0x811c9dc5
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/**
 * A row's rarer actions behind one ⋯ button, the way Claude Desktop folds
 * them. The menu is a native popover: it opens in the top layer, so the
 * table's scroll box never clips it, and the browser closes it on Escape and
 * on a click elsewhere. A page that draws one adds {@link MORE_MENU_JS} to its
 * script. `key` tells this row from the others on the page; `name` is what
 * the row is, for the button's label.
 */
export function moreMenu(
  key: string,
  name: string,
  items: readonly MoreItem[],
): string {
  if (items.length === 0) return ''
  const id = `more-${idTag(key)}`
  const entries = items
    .map(item => {
      const data = Object.entries(item.data ?? {})
        .map(([field, value]) => ` data-${field}="${attr(value)}"`)
        .join('')
      return (
        `<button type="button" class="fx-menu-item${item.danger === true ? ' fx-menu-danger' : ''}" ` +
        `role="menuitem" data-action="${attr(item.action)}"${data} data-write>` +
        `${escapeHtml(item.label)}</button>`
      )
    })
    .join('')
  return (
    `<button type="button" class="btn btn-ghost btn-small btn-icon row-more-btn" ` +
    `popovertarget="${id}" aria-haspopup="menu" aria-label="${attr(`更多操作 · ${name}`)}">` +
    `${icon('ellipsis', { small: true })}</button>` +
    `<div class="fx-menu row-more-menu" id="${id}" popover role="menu" ` +
    `aria-label="${attr(name)}">${entries}</div>`
  )
}

/**
 * What a page with {@link moreMenu} adds to the runtime. The browser opens
 * and closes the popover; this puts it under its button, above it when there
 * is no room (an item is 31px), and on a pick closes it with the focus back
 * on the button before the page's own handler runs, so a dialog the pick
 * opens hands the focus back there. The runtime gives a dialog's focus back
 * to the button too, and holds a refresh while a menu is open. Toggle events
 * do not bubble; the capture phase sees them.
 */
export const MORE_MENU_JS = `
(function () {
  'use strict';
  function button(menu) {
    return document.querySelector('[popovertarget="' + menu.id + '"]');
  }
  document.addEventListener('beforetoggle', function (event) {
    var menu = event.target;
    if (event.newState !== 'open' || !menu.matches || !menu.matches('.row-more-menu')) return;
    var at = button(menu).getBoundingClientRect();
    var high = menu.children.length * 31 + 8;
    menu.style.right = Math.max(8, window.innerWidth - at.right) + 'px';
    menu.style.top = (at.bottom + high > window.innerHeight ? Math.max(8, at.top - high) : at.bottom + 4) + 'px';
  }, true);
  document.addEventListener('click', function (event) {
    var item = event.target && event.target.closest ? event.target.closest('.row-more-menu [data-action]') : null;
    if (!item) return;
    var menu = item.closest('.row-more-menu');
    if (typeof menu.hidePopover === 'function') menu.hidePopover();
    var opener = button(menu);
    if (opener) opener.focus();
  }, true);
})();
`

/** Rules the kit's own markup needs beyond the shared sheet. */
export const KIT_CSS = `
.field-help { display: block; margin-top: 4px; }
.flabel { font-size: var(--text-12); color: var(--color-quiet); }
.wrap { flex-wrap: wrap; }
.unwired { gap: var(--space-2); padding: var(--space-4); }
.unwired .cmd { display: block; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--color-bg); white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-12); }
.kit-row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.kit-acts { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
.kit-pane { display: flex; flex-direction: column; gap: var(--space-3); }
.kit-excerpt { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-13); color: var(--color-quiet); max-height: 12em; overflow: auto; }
.kit-mono { font-family: var(--font-mono); font-size: var(--text-12); overflow-wrap: anywhere; }
.trail td.acts { text-align: right; white-space: nowrap; }
.trail td.acts .kit-acts { flex-wrap: nowrap; }
`

/** The task directions as the pages name them (P38, `directions-2026-10.md` §5.1). */
export const DIRECTION_WORD: Readonly<Record<string, string>> = {
  complex: '复杂任务',
  medium: '一般任务',
  simple: '简单任务',
  image: '生图',
  speech: '语音',
  video: '视频',
}

/** The memory kinds as the pages name them. */
export const MEMORY_KIND_WORD: Readonly<Record<string, string>> = {
  preference: '偏好',
  plan: '计划',
  project: '项目',
  daily: '日常',
}
