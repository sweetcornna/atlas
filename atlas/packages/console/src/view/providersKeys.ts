// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Several keys on one profile (P18.18, `providers-console-m1.md` §9.2): the
 * form's key list and its three dialogs, and what each node reports of its
 * keys.
 *
 * - **The hub's half** is on the form, for ops only: one line per key in the
 *   order the node picks them (priority first, then the order they were
 *   added), each with 已设置 / 未设置, when it was set and its fingerprint,
 *   and 重新填写 / 清除 / 删除; how a new session picks one; 加一把密钥.
 *   Adding or removing a key is a save of the list
 *   (`PUT /v0/providers/profiles/<id>`); filling one in again or clearing it
 *   is that key's own (`…/keys/<keyId>`).
 * - **The node's half** is each node's own pool: 可用 / 冷却中 / 已停用 per
 *   key id, with when a cooling key comes back and why it went out. Nothing
 *   here infers it; a node that reports no keys (one key) shows nothing.
 *
 * A key pool rotates on the two OpenAI-compatible lines only (the node's
 * compile refuses several keys on any other); the form offers 加一把密钥 on
 * those lines and says so on the others.
 */

import type {
  ProviderNodeActual,
  ProviderNodeKey,
  ProviderProfileView,
} from '../deps.js'
import { chevron, sectionHead, state, type Tone, tag } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import {
  CACHE_LINE,
  KEY_SELECTION_WORD,
  dialog,
  minuteOf,
  recap,
  shortFingerprint,
  writeButton,
} from './providers.js'

/** `MAX_KEYS_PER_PROFILE` of the providers catalog. */
const MAX_KEYS = 8

const ROTATING_LANES: ReadonlySet<string> = new Set([
  'openai-chat',
  'openai-responses',
])

const SELECTION_LINE: Readonly<Record<string, string>> = {
  fill_first: '总用排在前面的可用密钥',
  round_robin: '新会话依次用下一把',
  least_used: '新会话用被选次数最少的一把',
}

const HEALTH: Readonly<
  Record<ProviderNodeKey['state'], { word: string; tone: Tone }>
> = {
  ok: { word: '可用', tone: 'ok' },
  cooling: { word: '冷却中', tone: 'warn' },
  dead: { word: '已停用', tone: 'bad' },
}

const REASON_WORD: Readonly<
  Record<NonNullable<ProviderNodeKey['reason']>, string>
> = {
  'rate-limit': '限流',
  'usage-limit': '用量上限',
  billing: '欠费或额度不足',
  auth: '鉴权失败',
  revoked: '凭据已吊销',
}

type KeyView = ProviderProfileView['keys'][number]

/** The order the node takes keys in: priority first, then as listed (`poolOrder`). */
function poolOrder(keys: readonly KeyView[]): KeyView[] {
  return keys
    .map((key, index) => ({ key, index }))
    .sort(
      (a, b) =>
        (b.key.priority ?? 0) - (a.key.priority ?? 0) || a.index - b.index,
    )
    .map(entry => entry.key)
}

/** 加一把密钥, where a pool can rotate and there is room for one more. */
export function addKeyButton(profile: ProviderProfileView): string {
  return ROTATING_LANES.has(profile.lane) && profile.keys.length < MAX_KEYS
    ? writeButton('prov-key-add', '加一把密钥', {})
    : ''
}

/**
 * The stored key list the script sends back when it adds or removes one:
 * ids, names and priorities in the stored order — never a fingerprint.
 */
export function keysAttr(profile: ProviderProfileView): string {
  return JSON.stringify(
    profile.keys.map(key => ({
      id: key.id,
      ...(key.label === undefined ? {} : { label: key.label }),
      ...(key.priority === undefined ? {} : { priority: key.priority }),
    })),
  )
}

/** One key's line, as markup: the time it was set is a `<time>` (时区). */
function keyLine(key: KeyView): string {
  if (key.fingerprint === undefined) return '未设置'
  return (
    '已设置' +
    (key.setAt === undefined ? '' : ` · 设置于 ${minuteOf(key.setAt)}`) +
    escapeHtml(` · 指纹 ${shortFingerprint(key.fingerprint)}`)
  )
}

function selectionField(profile: ProviderProfileView): string {
  const chosen = profile.keySelection ?? 'fill_first'
  const options = Object.entries(KEY_SELECTION_WORD)
    .map(
      ([value, word]) =>
        `<option value="${attr(value)}"${value === chosen ? ' selected' : ''}>${escapeHtml(
          `${word} · ${SELECTION_LINE[value] ?? ''}`,
        )}</option>`,
    )
    .join('')
  return (
    `<label class="field"><span>选取策略</span>` +
    `<span class="sel"><select class="input" id="prov-key-selection" data-write>${options}</select>${chevron()}</span>` +
    `</label>`
  )
}

/** The form's key list, for a profile with more than one key (ops only). */
export function keyList(profile: ProviderProfileView): string {
  const ordered = poolOrder(profile.keys)
  const primary = ordered[0]?.id
  const rows = ordered
    .map(
      key =>
        `<li class="prov-pool-row" data-pool-key="${attr(key.id)}">` +
        `<span class="mono">${escapeHtml(key.id)}</span>` +
        (key.label === undefined
          ? ''
          : `<span>${escapeHtml(key.label)}</span>`) +
        (key.id === primary ? tag('主密钥') : '') +
        `<span class="note">${keyLine(key)}</span>` +
        `<span class="prov-actions">` +
        writeButton('prov-key-rotate', '重新填写', { key: key.id }) +
        (key.fingerprint === undefined
          ? ''
          : writeButton(
              'prov-key-clear',
              '清除',
              { key: key.id },
              { danger: true },
            )) +
        writeButton(
          'prov-key-remove',
          '删除',
          { key: key.id },
          { danger: true },
        ) +
        `</span></li>`,
    )
    .join('')
  const rotates = ROTATING_LANES.has(profile.lane)
  return (
    `<div class="field field-wide prov-pool" id="prov-pool">` +
    `<span>密钥 · ${profile.keys.length} 把</span>` +
    `<ul class="prov-pool-list">${rows}</ul>` +
    (rotates
      ? ''
      : `<p class="note prov-rule" data-tone="warn">这条线路一次只接受一把密钥 · 节点会拒收 · 删到一把或改用 OpenAI 兼容线路</p>`) +
    selectionField(profile) +
    `<p class="note">按会话选定 · 同一会话一直用同一把 · 遇到限流 用量上限 欠费或鉴权失败才换下一把并冷却 · 排第一的是主密钥 · 测连只用它</p>` +
    `<p class="note">${escapeHtml(`增删和重新填写都要下发才生效 · 换到另一把时${CACHE_LINE}`)}</p>` +
    `<div class="prov-actions">` +
    addKeyButton(profile) +
    (profile.keys.length >= MAX_KEYS
      ? `<span class="note">最多 ${MAX_KEYS} 把</span>`
      : '') +
    `</div>` +
    `</div>`
  )
}

/** The form's key dialogs: outside every polled region, ops only. */
export function keyDialogs(): string {
  const password = (id: string) =>
    `<div class="field"><label for="${attr(id)}">密钥</label>` +
    `<input class="input mono" type="password" id="${attr(id)}" autocomplete="off" ` +
    `spellcheck="false" placeholder="粘贴密钥 · 保存后不再显示"></div>`
  return (
    dialog({
      id: 'prov-key-add-dialog',
      glyph: 'plus',
      title: '加一把密钥',
      confirm: '加入',
      body:
        recap('编号', 'prov-key-add-id') +
        `<div class="field"><label for="prov-key-add-label">名称 · 可不填</label>` +
        `<input class="input" id="prov-key-add-label" maxlength="40" autocomplete="off"></div>` +
        password('prov-key-add-value') +
        `<p class="note">只加这一把 · 表单里没保存的改动不随之保存 · 下发后节点才用它</p>`,
    }) +
    dialog({
      id: 'prov-key-rotate-dialog',
      glyph: 'refresh-cw',
      title: '重新填写密钥',
      confirm: '保存',
      body:
        recap('编号', 'prov-key-rotate-id') +
        password('prov-key-rotate-value') +
        `<p class="note">旧密文随即从密文库删除 · 节点在下一次下发前仍用旧值</p>`,
    }) +
    dialog({
      id: 'prov-key-remove-dialog',
      glyph: 'x',
      title: '删除密钥',
      confirm: '删除',
      danger: true,
      body:
        recap('编号', 'prov-key-remove-id') +
        `<p class="note">从这份模型服务里去掉这一把 · 密文随即从密文库删除 · 节点在下一次下发前仍用原来那一组</p>`,
    })
  )
}

/** Why a key is not in use, as markup: a cool-down's end is a `<time>` (时区). */
function healthDetail(key: ProviderNodeKey): string {
  const reason =
    key.reason === undefined ? '' : escapeHtml(REASON_WORD[key.reason])
  if (key.state === 'cooling') {
    return [key.until === undefined ? '' : `到 ${minuteOf(key.until)}`, reason]
      .filter(part => part !== '')
      .join(' · ')
  }
  if (key.state === 'dead') {
    return [reason, '重新填写这一把并下发后恢复']
      .filter(part => part !== '')
      .join(' · ')
  }
  return ''
}

/** One node's keys in one line: `k1 可用 · k2 冷却中 · k3 已停用`. */
export function nodeKeysLine(actual: ProviderNodeActual | null): string {
  const keys = actual?.keys
  if (keys === undefined || keys.length === 0) return ''
  return `<span class="note" data-cell="keys">${escapeHtml(
    keys.map(key => `${key.id} ${HEALTH[key.state].word}`).join(' · '),
  )}</span>`
}

/** The node tab's section: each key the node reports, with why and until when. */
export function nodeKeysSection(actual: ProviderNodeActual | null): string {
  const keys = actual?.keys
  if (keys === undefined || keys.length === 0) return ''
  return (
    `<section class="sec" aria-labelledby="h-prov-pool">` +
    sectionHead('Keys', '密钥轮换', {
      headingId: 'h-prov-pool',
      tail: `<span class="note">节点报告 · 只有编号 · 不含密钥</span>`,
    }) +
    `<ul class="prov-recent">` +
    keys
      .map(key => {
        const detail = healthDetail(key)
        return (
          `<li data-pool-key="${attr(key.id)}"><span class="mono">${escapeHtml(
            key.id,
          )}</span>` +
          state(HEALTH[key.state].tone, HEALTH[key.state].word) +
          (detail === '' ? '' : `<span class="note">${detail}</span>`) +
          `</li>`
        )
      })
      .join('') +
    `</ul>` +
    `</section>`
  )
}
