// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The 渠道 cards: a channel whose platform this edition leaves out can only
 * be removed. The form shows the group rules a platform offers, and the page
 * script sends back what the form holds.
 */

import { expect, test } from 'bun:test'
import type { ChannelPlatformView, ChannelView } from '../src/directionPorts.js'
import { renderChannelForm, renderChannels } from '../src/view/channels.js'
import { CHANNELS_PAGE_JS } from '../src/view/channelsScript.js'
import { CHANNEL_PLATFORMS, FakeChannels } from './directionFakes.js'

const NOW = 1_800_000_000_000

test('a channel on a platform the hub no longer offers shows no edit or toggle', async () => {
  const fake = new FakeChannels(() => NOW)
  const kept = fake.channels[0]!
  const excluded: ChannelView = {
    ...kept,
    id: 'ch-2',
    name: '我的 QQ',
    platform: 'qq-personal',
    health: { state: 'failed', since: NOW, detail: '公开版不提供个人 QQ' },
  }
  const html = renderChannels({
    side: {
      kind: 'ok',
      value: {
        channels: [kept, excluded],
        platforms: CHANNEL_PLATFORMS,
        agents: [],
      },
    },
    now: NOW,
    ops: true,
  })
  const card = (id: string) => {
    const start = html.indexOf(`data-key="${id}"`)
    return html.slice(start, html.indexOf('</article>', start))
  }
  expect(card('ch-1')).toContain('channel-edit')
  expect(card('ch-1')).toContain('channel-toggle')
  expect(card('ch-2')).not.toContain('channel-edit')
  expect(card('ch-2')).not.toContain('channel-toggle')
  expect(card('ch-2')).toContain('channel-remove')
  expect(card('ch-2')).toContain('公开版不提供个人 QQ')
})

const PERSONAL: ChannelPlatformView = {
  id: 'qq-personal',
  name: '个人 QQ',
  settings: [{ key: 'url', label: 'SnowLuma 地址' }],
  secrets: [{ key: 'accessToken', label: 'OneBot 访问令牌' }],
  qrLogin: false,
  pairing: false,
  groupOptions: ['keywords', 'budget'],
  hint: 'SnowLuma',
  evaluated: false,
}

function unescape(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Input and select values by name, as a browser would submit them untouched. */
function fieldsOf(
  html: string,
): Record<string, { value: string; checked: boolean }> {
  const fields: Record<string, { value: string; checked: boolean }> = {}
  for (const match of html.matchAll(/<input\b([^>]*)>/g)) {
    const tag = match[1] ?? ''
    const name = /name="([^"]*)"/.exec(tag)?.[1]
    if (name === undefined) continue
    fields[name] = {
      value: unescape(/value="([^"]*)"/.exec(tag)?.[1] ?? ''),
      checked: / checked\b/.test(tag),
    }
  }
  for (const match of html.matchAll(
    /<select\b[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g,
  )) {
    const options = [
      ...(match[2] ?? '').matchAll(/<option value="([^"]*)"( selected)?>/g),
    ]
    const chosen = options.find(option => option[2] !== undefined) ?? options[0]
    fields[match[1]!] = { value: unescape(chosen?.[1] ?? ''), checked: false }
  }
  for (const match of html.matchAll(
    /<textarea\b[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/textarea>/g,
  ))
    fields[match[1]!] = { value: unescape(match[2] ?? ''), checked: false }
  return fields
}

/** Submit an edit form through the page script; the draft it would post. */
function submitted(html: string): Record<string, unknown> {
  const sent: Record<string, unknown>[] = []
  let onSubmit: ((form: unknown) => void) | undefined
  const idle = () => {}
  const qc = {
    byId: () => null,
    say: idle,
    setText: idle,
    toast: idle,
    openDialog: idle,
    closeDialog: idle,
    failLine: () => '',
    failTone: () => 'bad',
    loadHtml: () => Promise.resolve(''),
    refreshRegion: () => Promise.resolve(),
    onAction: idle,
    onExpire: idle,
    onSubmit: (id: string, handler: (form: unknown) => void) => {
      if (id === 'channel-form') onSubmit = handler
    },
    sendJson: (method: string, path: string, body: Record<string, unknown>) => {
      if (method === 'POST' && path === '/v0/im') sent.push(body)
      return new Promise(() => {})
    },
  }
  new Function('window', 'document', CHANNELS_PAGE_JS)(
    { qianmoConsole: qc },
    { addEventListener: idle },
  )
  if (onSubmit === undefined) throw new Error('the script took no form')
  const elements = fieldsOf(html)
  onSubmit({
    elements,
    querySelector: (selector: string) =>
      selector.includes('hidden') ? elements.platform : null,
    querySelectorAll: () => [],
  })
  return sent[0]!
}

test('the form offers only the group rules a platform has, and sends them back', () => {
  const fake = new FakeChannels(() => NOW)
  const telegram = CHANNEL_PLATFORMS.find(one => one.id === 'telegram')!
  const qq = CHANNEL_PLATFORMS.find(one => one.id === 'qq')!
  const base = fake.channels[0]!
  const qqForm = renderChannelForm({
    platforms: CHANNEL_PLATFORMS,
    platform: qq,
    agents: [base.target],
    channel: null,
  })
  for (const name of ['freeGroups', 'keywords', 'groupCooldownSeconds'])
    expect(qqForm).not.toContain(`name="${name}"`)

  const tg: ChannelView = {
    ...base,
    platform: 'telegram',
    freeGroups: ['-1001', '-1002:7'],
    keywords: ['hey bot', '阡陌'],
  }
  const tgForm = renderChannelForm({
    platforms: CHANNEL_PLATFORMS,
    platform: telegram,
    agents: [base.target],
    channel: tg,
  })
  expect(tgForm).toContain('话题写 群号:话题号')
  expect(tgForm).not.toContain('name="groupCooldownSeconds"')
  expect(submitted(tgForm)).toMatchObject({
    platform: 'telegram',
    freeGroups: ['-1001', '-1002:7'],
    keywords: ['hey bot', '阡陌'],
  })
  expect(submitted(tgForm)).not.toHaveProperty('groupSpeechMax')

  const qqPersonal: ChannelView = {
    ...base,
    platform: 'qq-personal',
    keywords: ['小阡'],
    groupCooldownSeconds: 60,
    groupSpeechMax: 3,
    groupSpeechMinutes: 10,
  }
  const personalForm = renderChannelForm({
    platforms: [PERSONAL],
    platform: PERSONAL,
    agents: [base.target],
    channel: qqPersonal,
  })
  expect(personalForm).not.toContain('name="freeGroups"')
  expect(submitted(personalForm)).toMatchObject({
    keywords: ['小阡'],
    groupCooldownSeconds: 60,
    groupSpeechMax: 3,
    groupSpeechMinutes: 10,
  })
})
