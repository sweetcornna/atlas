// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A settings change waiting for approval (P40, `docs/dev/agent-settings.md`
 * §4.2 and §6), as the approvals page (`routes/approvals.ts`) draws it.
 *
 * The request's `input` is the hub's `bound`: the setting's id, the target,
 * the input with its secrets replaced by markers, and `card` — the area, the
 * setting, one sentence, the value before and after (already redacted and
 * shortened by the hub), the role the change needs and the panel it lives
 * on. A person decides on the card and on nothing else: the raw input is not
 * drawn, so a secret's marker or a long JSON body never stands in for the
 * two values that matter.
 *
 * The conversation front draws the same card in its own script
 * (`frontApproval.ts`, `APPROVAL_CARD_JS`), with the same reading of `card`;
 * the tests hold the two readings to each other.
 */

import type { AccountRole } from '../contracts.js'
import { attr, escapeHtml } from './escape.js'

/** The tool a settings change is approved as (§3.2). */
export const SETTINGS_CHANGE_TOOL = 'qianmo_settings_change'

/** What a card's value may run to on screen; the hub already cut it at 200. */
const CARD_TEXT = 400

interface SettingsCard {
  readonly area: string
  readonly label: string
  readonly title: string
  /** Before the change; `null` when the change creates something. */
  readonly current: string | null
  readonly next: string
  /** The account role the change needs: who may approve it. */
  readonly role: 'ops' | 'member'
  /** The panel the setting lives on; `null` unless it is a path on this console. */
  readonly page: string | null
}

function clip(value: string): string {
  return value.length > CARD_TEXT ? `${value.slice(0, CARD_TEXT)}…` : value
}

/** A path on this console: `/…`, not `//host` or `/\host`, no control characters. */
function consolePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null
  if (!/^\/(?![/\\])/.test(value) || /\s/.test(value)) return null
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return null
  }
  return value
}

/**
 * The card out of a settings change's `input`, or `null` when it is missing
 * or malformed — then nothing about the change can be shown, and nobody is
 * offered a button to approve it.
 */
export function settingsCardOf(
  input: Readonly<Record<string, unknown>>,
): SettingsCard | null {
  const card = input['card']
  if (card === null || typeof card !== 'object' || Array.isArray(card))
    return null
  const c = card as Record<string, unknown>
  const { area, label, next, current, role } = c
  if (
    typeof area !== 'string' ||
    typeof label !== 'string' ||
    typeof next !== 'string' ||
    (current !== null && typeof current !== 'string') ||
    (role !== 'ops' && role !== 'member')
  )
    return null
  return {
    area: clip(area),
    label: clip(label),
    title: typeof c['title'] === 'string' ? clip(c['title']) : '',
    current: current === null ? null : clip(current),
    next: clip(next),
    role,
    page: consolePath(c['page']),
  }
}

/** Whether this reader may decide a change that needs `role`. */
export function mayApprove(
  role: 'ops' | 'member',
  viewer: AccountRole,
): boolean {
  return role === 'member' ? viewer !== 'viewer' : viewer === 'ops'
}

/**
 * Show invisible controls as literal codepoints, including inside paths and
 * JSON: a bidirectional override in a value reads as `‮`, not as text
 * running the other way.
 */
export function escapeShown(value: string): string {
  return escapeHtml(
    [...String(value)]
      .map(char => {
        const code = char.codePointAt(0)!
        return (code < 32 && code !== 10 && code !== 9) ||
          (code >= 0x7f && code <= 0x9f) ||
          code === 0x61c ||
          code === 0x200e ||
          code === 0x200f ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069)
          ? `\\u${code.toString(16).padStart(4, '0')}`
          : char
      })
      .join(''),
  )
}

function kv(key: string, value: string): string {
  return `<div class="kv"><span class="k">${escapeHtml(key)}</span><span class="v">${escapeShown(value)}</span></div>`
}

/**
 * The card on the approvals page: the sentence, area · setting, before and
 * after, who may approve and the way to the panel. A malformed card says so.
 */
export function settingsCardHtml(card: SettingsCard | null): string {
  if (card === null)
    return '<p class="bar bar-warn">设置更改的内容不完整 · 只能拒绝</p>'
  const rows =
    card.current === null
      ? kv('新建', card.next)
      : kv('现在', card.current) + kv('改为', card.next)
  return (
    (card.title === '' ? '' : `<p><b>${escapeShown(card.title)}</b></p>`) +
    `<p>${escapeShown(card.area)} · ${escapeShown(card.label)}` +
    `${card.role === 'ops' ? ' · 需要运维批准' : ''}</p>` +
    rows +
    (card.page === null
      ? ''
      : `<p><a href="${attr(card.page)}">在面板里看</a></p>`)
  )
}
