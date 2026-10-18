// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The 渠道 cards: a channel whose platform this edition leaves out can only be removed. */

import { expect, test } from 'bun:test'
import type { ChannelView } from '../src/directionPorts.js'
import { renderChannels } from '../src/view/channels.js'
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
