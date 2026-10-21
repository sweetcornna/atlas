// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 渠道 (P28): chat apps bound to agents. Each card is one bot account; the
 * owner's private chat goes to one agent, groups and other people to another
 * (or nobody). Credentials stay on the hub; the page shows "已设置".
 */

import type { ConsoleFailure } from '../deps.js'
import type {
  ChannelGroupOption,
  ChannelPlatformView,
  ChannelsSnapshot,
  ChannelView,
} from '../directionPorts.js'
import { qrSvg } from './qr.js'
import { failureBar, icon, sectionHead, state, tag } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatRelative } from './format.js'
import {
  actionButton,
  dialogActions,
  dialogTop,
  emptyState,
  selectField,
  textArea,
  textField,
  unwiredCard,
} from './kit.js'

export type ChannelsSide =
  | { readonly kind: 'ok'; readonly value: ChannelsSnapshot }
  | { readonly kind: 'failed'; readonly failure: ConsoleFailure }
  | { readonly kind: 'unwired' }

export interface ChannelsModel {
  readonly side: ChannelsSide
  readonly now: number
  /** May add, change and remove channels (ops level). */
  readonly ops: boolean
}

const STATE: Readonly<
  Record<
    ChannelView['health']['state'],
    readonly ['ok' | 'warn' | 'bad' | 'muted', string]
  >
> = {
  connected: ['ok', '在线'],
  starting: ['warn', '连接中'],
  retrying: ['warn', '重连中'],
  failed: ['bad', '失败'],
  stopped: ['muted', '已停用'],
}

function agentName(address: string): string {
  const match = /^qianmo:\/\/([^/]+)\/(.+)$/.exec(address)
  return match === null ? address : `${match[2]} · ${match[1]}`
}

function platformName(snapshot: ChannelsSnapshot, id: string): string {
  return snapshot.platforms.find(one => one.id === id)?.name ?? id
}

function fact(key: string, value: string): string {
  return `<div class="ch-fact"><span class="note">${escapeHtml(key)}</span><span>${value}</span></div>`
}

/** Pending pairing requests, with the decisions for ops (hermes pairing). */
function pairings(channel: ChannelView, model: ChannelsModel): string {
  if (!model.ops || channel.pairingRequests.length === 0) return ''
  const rows = channel.pairingRequests.map(request => {
    const data = (decision: string) => ({
      id: channel.id,
      request: request.id,
      decision,
      name: request.userName,
    })
    return (
      `<div class="ch-pair"><span class="ch-pair-who"><b>${escapeHtml(request.userName)}</b>` +
      `<span class="kit-mono note" title="${attr(request.userId)}">${escapeHtml(request.userId)}</span></span>` +
      `<span class="note">${escapeHtml(formatRelative(request.createdAt, model.now))}</span>` +
      `<span class="kit-acts">` +
      actionButton('channel-pair', '设为主人', {
        tone: 'ghost',
        data: data('owner'),
      }) +
      (channel.memberTarget === null
        ? ''
        : actionButton('channel-pair', '设为成员', {
            tone: 'ghost',
            data: data('member'),
          })) +
      actionButton('channel-pair', '拒绝', {
        tone: 'ghost',
        data: data('deny'),
      }) +
      `</span></div>`
    )
  })
  return `<div class="ch-pairs" aria-label="配对请求">${rows.join('')}</div>`
}

function card(
  channel: ChannelView,
  model: ChannelsModel,
  snapshot: ChannelsSnapshot,
): string {
  const [tone, word] = STATE[channel.enabled ? channel.health.state : 'stopped']
  const health = `<span title="${attr(channel.health.detail ?? '')}">${state(
    tone,
    channel.health.detail && tone === 'bad'
      ? `${word} · ${channel.health.detail}`
      : word,
  )}</span>`
  // A platform this hub no longer offers (personal QQ on the public
  // edition): the channel can only be removed.
  const offered = snapshot.platforms.some(one => one.id === channel.platform)
  const acts = !model.ops
    ? ''
    : !offered
      ? `<span class="kit-acts">` +
        actionButton('channel-remove', '删除', {
          tone: 'ghost',
          data: { id: channel.id, name: channel.name },
        }) +
        `</span>`
      : `<span class="kit-acts">` +
        (channel.platform === 'weixin'
          ? actionButton('channel-relogin', '重新扫码', {
              tone: 'ghost',
              data: { id: channel.id, name: channel.name },
            })
          : '') +
        actionButton('channel-edit', '编辑', {
          tone: 'ghost',
          data: { id: channel.id },
        }) +
        actionButton('channel-toggle', channel.enabled ? '停用' : '启用', {
          tone: 'ghost',
          data: {
            id: channel.id,
            name: channel.name,
            enabled: channel.enabled ? '0' : '1',
          },
        }) +
        actionButton('channel-remove', '删除', {
          tone: 'ghost',
          data: { id: channel.id, name: channel.name },
        }) +
        `</span>`
  return (
    `<article class="card elev-sm ch-card" data-key="${attr(channel.id)}">` +
    `<header class="ch-head"><span class="ch-glyph ch-${attr(channel.platform)}">${icon('messages-square')}</span>` +
    `<div class="ch-title"><b>${escapeHtml(channel.name)}</b>` +
    `<span class="note">${escapeHtml(platformName(snapshot, channel.platform))}</span></div>` +
    (channel.evaluated ? '' : tag('未评估', 'muted')) +
    `</header><div class="ch-facts">` +
    fact(
      '主人',
      `<span class="kit-mono">${escapeHtml(agentName(channel.target))}</span>`,
    ) +
    fact(
      '其他人',
      channel.memberTarget === null
        ? '<span class="note">不回应</span>'
        : `<span class="kit-mono">${escapeHtml(agentName(channel.memberTarget))}</span>`,
    ) +
    fact('群里', channel.groupTrigger === 'all' ? '每条都回' : '@ 时回') +
    fact('会话', escapeHtml(String(channel.conversations))) +
    (channel.pairingOpen
      ? fact(
          '配对',
          channel.pairingRequests.length > 0
            ? `${channel.pairingRequests.length} 条待处理`
            : '接受申请',
        )
      : '') +
    fact(
      '凭据',
      channel.secretSet ? '已设置' : '<span class="note">未设置</span>',
    ) +
    `</div>` +
    pairings(channel, model) +
    `<footer class="ch-foot"><span class="kit-row">${health}` +
    `<span class="note">${escapeHtml(formatRelative(channel.health.since, model.now))}</span></span>${acts}</footer>` +
    `</article>`
  )
}

/** The polled body of the page. */
export function renderChannels(model: ChannelsModel): string {
  const side = model.side
  const add =
    model.ops && side.kind === 'ok'
      ? actionButton('channel-new', '添加渠道', { glyph: 'plus' })
      : ''
  let body: string
  if (side.kind === 'unwired')
    body = unwiredCard(
      '聊天渠道',
      'QQ / 微信 / Telegram / Discord / Slack 的消息交给智能体回复',
      'qm console … --channels',
    )
  else if (side.kind === 'failed') body = failureBar(side.failure, '聊天渠道')
  else if (side.value.channels.length === 0)
    body = emptyState(
      '还没有渠道',
      side.value.platforms.map(one => one.name).join(' / '),
      add,
    )
  else
    body = `<div class="ch-grid">${side.value.channels.map(one => card(one, model, side.value)).join('')}</div>`
  return (
    `<section class="sec" aria-labelledby="h-channels">` +
    sectionHead('Channels', '聊天渠道', {
      headingId: 'h-channels',
      tail: `<div class="kit-row"><span class="note">未评估</span>${
        side.kind === 'ok' && side.value.channels.length > 0 ? add : ''
      }</div>`,
    }) +
    body +
    `</section>`
  )
}

function list(values: readonly string[] | undefined): string {
  return (values ?? []).join(', ')
}

/** The group rules the platform offers (`ChannelPlatformView.groupOptions`). */
function groupRuleFields(
  platform: ChannelPlatformView,
  channel: ChannelView | null,
): string {
  const offers = (option: ChannelGroupOption) =>
    platform.groupOptions.includes(option)
  return (
    (offers('freeGroups')
      ? textField('freeGroups', '不用 @ 的群', {
          wide: true,
          mono: true,
          value: list(channel?.freeGroups),
          help:
            platform.id === 'telegram'
              ? '逗号分隔 · 话题写 群号:话题号'
              : '逗号分隔',
        })
      : '') +
    (offers('keywords')
      ? textField('keywords', '唤醒词', {
          wide: true,
          value: list(channel?.keywords),
          help: '逗号分隔 · 群里出现就回',
        })
      : '') +
    (offers('budget')
      ? textField('groupCooldownSeconds', '群冷却（秒）', {
          type: 'number',
          min: 0,
          max: 86400,
          value: String(channel?.groupCooldownSeconds ?? 0),
          help: '没被 @ 时两次回复的间隔',
        }) +
        textField('groupSpeechMax', '发言上限（条）', {
          type: 'number',
          min: 0,
          max: 1000,
          value: String(channel?.groupSpeechMax ?? 0),
        }) +
        textField('groupSpeechMinutes', '上限时段（分钟）', {
          type: 'number',
          min: 0,
          max: 1440,
          value: String(channel?.groupSpeechMinutes ?? 0),
          help: '0 不限',
        })
      : '')
  )
}

/** The add / edit form body for one platform. */
export function renderChannelForm(input: {
  readonly platforms: readonly ChannelPlatformView[]
  readonly platform: ChannelPlatformView
  readonly agents: readonly string[]
  readonly channel: ChannelView | null
}): string {
  const { platform, channel } = input
  const editing = channel !== null
  const chips = editing
    ? `<p class="note">平台 · ${escapeHtml(platform.name)}</p>`
    : `<div class="field field-wide"><span class="flabel">平台</span><div class="ch-platforms" role="radiogroup" aria-label="平台">${input.platforms
        .map(
          one =>
            `<label class="ch-platform"><input type="radio" name="platform" value="${attr(one.id)}"${
              one.id === platform.id ? ' checked' : ''
            }><span>${escapeHtml(one.name)}</span></label>`,
        )
        .join('')}</div></div>`
  const agents = input.agents.map(one => [one, agentName(one)] as const)
  const settings = platform.settings
    .map(field =>
      textField(`s-${field.key}`, field.label, {
        value: channel?.settings[field.key] ?? '',
        mono: true,
        required: true,
      }).replace('<input ', `<input data-setting="${attr(field.key)}" `),
    )
    .join('')
  const secrets = platform.secrets
    .map(field =>
      textField(`k-${field.key}`, field.label, {
        type: 'password',
        wide: true,
        required: !editing,
        placeholder: editing ? '不改就留空' : '',
      }).replace('<input ', `<input data-secret="${attr(field.key)}" `),
    )
    .join('')
  return (
    `<input type="hidden" name="channelId" value="${attr(channel?.id ?? '')}">` +
    (editing
      ? `<input type="hidden" name="platform" value="${attr(platform.id)}">`
      : '') +
    `<input type="hidden" name="qrLogin" value="${platform.qrLogin ? '1' : '0'}">` +
    `<div class="form-grid">` +
    chips +
    `<p class="note field-wide ch-hint">${icon('info', { small: true })}${escapeHtml(platform.hint)}</p>` +
    textField('name', '名称', {
      required: true,
      wide: true,
      maxLength: 60,
      value: channel?.name ?? platform.name,
    }) +
    selectField('target', '主人对话', agents, {
      required: true,
      wide: true,
      selected: channel?.target ?? agents[0]?.[0] ?? '',
    }) +
    selectField('memberTarget', '其他人与群', [['', '不回应'], ...agents], {
      wide: true,
      selected: channel?.memberTarget ?? '',
    }) +
    settings +
    secrets +
    (platform.qrLogin
      ? ''
      : textField('ownerIds', '主人的用户号', {
          wide: true,
          mono: true,
          value: list(channel?.ownerIds),
          help: '逗号分隔',
        })) +
    `<details class="ch-more field-wide"><summary>更多</summary><div class="form-grid">` +
    selectField(
      'groupTrigger',
      '群里',
      [
        ['mention', '@ 时回'],
        ['all', '每条都回'],
      ],
      {
        selected: channel?.groupTrigger ?? 'mention',
      },
    ) +
    textField('replyWindowMs', '回复窗口（毫秒）', {
      type: 'number',
      min: 0,
      max: 60000,
      value: String(channel?.replyWindowMs ?? 0),
    }) +
    textField('allowGroups', '允许的群', {
      wide: true,
      mono: true,
      value: list(channel?.allowGroups),
      help: '逗号分隔',
    }) +
    groupRuleFields(platform, channel) +
    textField('allowUsers', '允许私聊的人', {
      wide: true,
      mono: true,
      value: list(channel?.allowUsers),
      help: '逗号分隔',
    }) +
    `<label class="chk field-wide"><input type="checkbox" name="allowAll"${channel?.allowAll ? ' checked' : ''}>` +
    `<span class="bx">${icon('check', { small: true })}</span>不限人和群</label>` +
    (platform.pairing
      ? selectField(
          'pairing',
          '陌生人私聊',
          [
            ['auto', '没填主人时可申请配对'],
            ['on', '可申请配对'],
            ['off', '不回应'],
          ],
          { wide: true, selected: channel?.pairing ?? 'auto' },
        ) +
        `<p class="note field-wide">对方私聊机器人发 /pair 配对码 · 或在渠道卡片上批准</p>`
      : '') +
    `<label class="chk field-wide"><input type="checkbox" name="groupContext"${(channel?.groupContext ?? true) ? ' checked' : ''}>` +
    `<span class="bx">${icon('check', { small: true })}</span>群里被 @ 时带上最近的群聊</label>` +
    textArea('prompt', '渠道说明', {
      value: channel?.prompt ?? '',
      maxLength: 4000,
      rows: 3,
    }) +
    (platform.qrLogin && editing
      ? textField('ownerIds', '主人的用户号', {
          wide: true,
          mono: true,
          value: list(channel?.ownerIds),
        })
      : '') +
    `</div></details>` +
    `</div>`
  )
}

/** The QR image of a WeChat login. */
export function renderChannelQr(content: string): string {
  return `<div class="ch-qr">${qrSvg(content)}</div>`
}

export function channelDialogs(): string {
  return (
    `<dialog class="dialog ch-dialog" id="channel-dialog" aria-labelledby="channel-title">` +
    `<form id="channel-form" novalidate>` +
    dialogTop('channel-title', 'messages-square', '添加渠道') +
    `<div class="dialog-body" id="channel-body"></div>` +
    `<p class="note ch-status" id="channel-status" role="status"></p>` +
    dialogActions('保存', { glyph: 'check' }) +
    `</form></dialog>` +
    `<dialog class="dialog" id="channel-login" aria-labelledby="channel-login-title">` +
    `<div class="dialog-form">` +
    dialogTop('channel-login-title', 'messages-square', '微信扫码') +
    `<div class="dialog-body"><div id="channel-qr"></div>` +
    `<p class="note ch-login-state" id="channel-login-state" role="status">用微信扫一扫</p></div>` +
    `<div class="dialog-actions"><button type="button" class="btn btn-secondary" data-action="confirm-cancel">关闭</button></div>` +
    `</div></dialog>` +
    `<dialog class="dialog" id="confirm-channel-remove" aria-labelledby="confirm-channel-remove-title">` +
    dialogTop('confirm-channel-remove-title', 'x', '删除渠道') +
    `<div class="dialog-body"><div class="recap"><div class="recap-row"><span class="k">名称</span>` +
    `<span id="confirm-channel-remove-name"></span></div></div><p>凭据随之删除 · 已有对话保留在对话页</p></div>` +
    dialogActions('删除', { danger: true, action: 'confirm-channel-remove' }) +
    `</dialog>`
  )
}

export const CHANNELS_PAGE_CSS = `
.ch-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: var(--space-3); }
.ch-card { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); }
.ch-head { display: flex; align-items: center; gap: var(--space-3); }
.ch-title { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.ch-title b { font-size: var(--text-14, 14px); overflow-wrap: anywhere; }
.ch-glyph { display: inline-grid; place-items: center; width: 34px; height: 34px; border-radius: 11px; background: var(--ui-field); color: var(--color-quiet); flex: none; }
.ch-facts { display: flex; flex-direction: column; gap: 6px; }
.ch-fact { display: flex; justify-content: space-between; gap: var(--space-3); font-size: var(--text-13); min-width: 0; }
.ch-fact .kit-mono { text-align: right; overflow-wrap: anywhere; }
.ch-pairs { display: flex; flex-direction: column; gap: 6px; padding-top: var(--space-2); border-top: 1px solid var(--color-line, transparent); }
.ch-pair { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); font-size: var(--text-13); }
.ch-pair-who { display: flex; flex-direction: column; gap: 1px; flex: 1 1 8em; min-width: 0; }
.ch-pair-who .kit-mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; overflow-wrap: normal; }
.ch-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; margin-top: auto; }
.ch-platforms { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: var(--space-2); }
.ch-platform { display: flex; align-items: center; gap: var(--space-2); padding: 8px 10px; border-radius: var(--radius-md); background: var(--color-bg); cursor: pointer; font-size: var(--text-13); border: 1px solid transparent; }
.ch-platform input { position: absolute; opacity: 0; pointer-events: none; }
.ch-platform:has(input:checked) { border-color: var(--color-text); background: var(--color-surface); }
.ch-platform:has(input:focus-visible) { outline: 2px solid var(--color-text); outline-offset: 2px; }
.ch-hint { display: flex; gap: 6px; align-items: flex-start; }
.ch-more > summary { cursor: pointer; font-size: var(--text-12-5); color: var(--color-muted); padding: 4px 0; }
.ch-more > .form-grid { margin-top: var(--space-2); }
.ch-status:empty { display: none; }
.ch-dialog .dialog-body { max-height: min(70vh, 640px); overflow: auto; }
.ch-qr { display: grid; place-items: center; padding: var(--space-3); }
.ch-qr svg { width: min(240px, 70vw); height: auto; border-radius: var(--radius-md); }
.ch-login-state { text-align: center; }
`
