// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
// 规则来源 NousResearch/hermes-agent `tests/gateway/test_slack_mention.py:1-576`，取于 `63220ae5`，取用日期 2026-10-19

/**
 * Slack's response rules rewritten after hermes-agent (`src/channels/rules/
 * slack.ts`); the cases follow hermes' `test_slack_mention.py` at
 * `63220ae5`.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  rewriteBangCommand,
  slackGroupGate,
  slackMentionsBot,
  stripSlackMention,
} from '../../src/channels/rules/slack.js'
import { SlackAdapter } from '../../src/channels/slack.js'
import type {
  ChannelAdapter,
  ChannelInbound,
  GroupPolicy,
} from '../../src/channels/types.js'
import { FakeNet, inbound, until } from './fakes.js'

const policy = (over: Partial<GroupPolicy> = {}): GroupPolicy => ({
  trigger: 'mention',
  freeGroups: [],
  keywords: [],
  followed: false,
  ...over,
})

const running: ChannelAdapter[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(adapter => adapter.stop()))
})

async function started<T extends ChannelAdapter>(
  adapter: T,
): Promise<{ adapter: T; got: ChannelInbound[] }> {
  const got: ChannelInbound[] = []
  running.push(adapter)
  await adapter.start(message => got.push(message))
  return { adapter, got }
}

describe('Slack (hermes)', () => {
  test('mentions in both forms; only ours is taken off', () => {
    expect(slackMentionsBot('<@UBOT> hi', 'UBOT')).toBe(true)
    expect(slackMentionsBot('hi <@UBOT|qm>', 'UBOT')).toBe(true)
    expect(slackMentionsBot('<@UOTHER> hi', 'UBOT')).toBe(false)
    expect(stripSlackMention('<@UBOT|qm> 周报 <@U2>', 'UBOT')).toBe(
      '周报 <@U2>',
    )
  })

  test('a known !cmd is /cmd; other exclamations stay', () => {
    const known = new Set(['new', 'stop'])
    expect(rewriteBangCommand('!new', known)).toBe('/new')
    expect(rewriteBangCommand('!stop@qm now', known)).toBe('/stop@qm now')
    expect(rewriteBangCommand('!nice work', known)).toBe('!nice work')
    expect(rewriteBangCommand('hi !new', known)).toBe('hi !new')
  })

  test('free channels and `all` need no mention; otherwise a mention, a wake word or the bot’s thread', () => {
    const at = (addressed = false, threadId = '1.0') =>
      inbound({
        chat: { type: 'group', id: 'C1', threadId },
        addressed,
        text: '看看',
      })
    expect(slackGroupGate(at(), policy())).toBeNull()
    expect(slackGroupGate(at(true), policy())).toBe('explicit')
    expect(slackGroupGate(at(), policy({ freeGroups: ['C1'] }))).toBe(
      'implicit',
    )
    expect(slackGroupGate(at(), policy({ freeGroups: ['C2'] }))).toBeNull()
    expect(slackGroupGate(at(), policy({ trigger: 'all' }))).toBe('implicit')
    expect(slackGroupGate(at(), policy({ followed: true }))).toBe('implicit')
    expect(slackGroupGate(at(), policy({ keywords: ['看看'] }))).toBe(
      'implicit',
    )
  })
})

describe('Slack adapter (hermes rules wired in)', () => {
  test('Slack: !cmd becomes /cmd, both mention forms address, only person subtypes pass', async () => {
    const net = new FakeNet()
      .on('/auth.test', { body: { ok: true, user_id: 'UBOT' } })
      .on('/apps.connections.open', {
        body: { ok: true, url: 'wss://wss-primary.slack.com/x' },
      })
      .on('/users.info', {
        body: { ok: true, user: { profile: { display_name: '小陈' } } },
      })
    const { got } = await started(
      new SlackAdapter({ appToken: 'xapp', botToken: 'xoxb' }, net.io()),
    )
    await until(() => net.sockets.length === 1)
    const socket = net.sockets[0]!
    const event = (envelope: string, body: Record<string, unknown>) =>
      socket.push({
        type: 'events_api',
        envelope_id: envelope,
        payload: {
          event: {
            type: 'message',
            user: 'U1',
            channel: 'C1',
            channel_type: 'channel',
            ...body,
          },
        },
      })
    event('e1', { text: '!new', ts: '1.1', thread_ts: '1.0' })
    event('e2', { text: '<@UBOT|qm> 看看', ts: '1.2' })
    event('e3', { subtype: 'me_message', text: '挥手', ts: '1.3' })
    event('e4', { subtype: 'channel_join', text: '加入了', ts: '1.4' })
    await until(() => got.length === 3)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(got.map(one => [one.text, one.addressed])).toEqual([
      ['/new', false],
      ['看看', true],
      ['挥手', false],
    ])
  })
})
