// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
// 规则来源 NousResearch/hermes-agent `tests/gateway/test_discord_free_response.py:1-1060`、`tests/gateway/test_discord_admission_thread_exemption.py:1-81`，取于 `63220ae5`，取用日期 2026-10-19

/**
 * Discord's response rules rewritten after hermes-agent (`src/channels/rules/
 * discord.ts`); the cases follow hermes' `test_discord_free_response.py` and
 * `test_discord_admission_thread_exemption.py` at `63220ae5`.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { DiscordAdapter } from '../../src/channels/discord.js'
import {
  discordGroupGate,
  discordMentions,
} from '../../src/channels/rules/discord.js'
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

describe('Discord (hermes)', () => {
  const at = (
    over: Partial<{
      threadId: string
      addressed: boolean
      otherBots: boolean
      othersOnly: boolean
    }> = {},
  ) =>
    inbound({
      chat: {
        type: 'group',
        id: 'c1',
        ...(over.threadId ? { threadId: over.threadId } : {}),
      },
      addressed: over.addressed ?? false,
      ...(over.otherBots || over.othersOnly
        ? {
            mention: {
              ...(over.otherBots ? { otherBots: true } : {}),
              ...(over.othersOnly ? { othersOnly: true } : {}),
            },
          }
        : {}),
    })

  test('mentions: listed, or the raw <@id> token; other bots tell apart', () => {
    expect(
      discordMentions({ content: 'hi', mentions: [{ id: '42' }] }, '42'),
    ).toEqual({
      bot: true,
      otherBots: false,
      anyone: true,
    })
    expect(
      discordMentions({ content: 'hi <@!42>', mentions: [] }, '42').bot,
    ).toBe(true)
    expect(
      discordMentions(
        { content: 'hi', mentions: [{ id: '7', bot: true }] },
        '42',
      ),
    ).toEqual({ bot: false, otherBots: true, anyone: true })
  })

  test('a mention is needed, except in free channels (or their threads) and the bot’s threads', () => {
    expect(discordGroupGate(at(), policy())).toBeNull()
    expect(discordGroupGate(at({ addressed: true }), policy())).toBe('explicit')
    expect(discordGroupGate(at(), policy({ freeGroups: ['c1'] }))).toBe(
      'implicit',
    )
    expect(
      discordGroupGate(at({ threadId: 't1' }), policy({ freeGroups: ['c1'] })),
    ).toBe('implicit')
    expect(
      discordGroupGate(at({ threadId: 't1' }), policy({ freeGroups: ['t1'] })),
    ).toBe('implicit')
    expect(discordGroupGate(at(), policy({ freeGroups: ['*'] }))).toBe(
      'implicit',
    )
    expect(
      discordGroupGate(at({ threadId: 't1' }), policy({ followed: true })),
    ).toBe('implicit')
  })

  test('someone else’s mention is their conversation, except in a bot thread or a free channel', () => {
    expect(
      discordGroupGate(at({ othersOnly: true }), policy({ trigger: 'all' })),
    ).toBeNull()
    expect(
      discordGroupGate(
        at({ othersOnly: true, threadId: 't1' }),
        policy({ followed: true }),
      ),
    ).toBe('implicit')
    expect(
      discordGroupGate(
        at({ othersOnly: true }),
        policy({ freeGroups: ['c1'] }),
      ),
    ).toBe('implicit')
    // Another bot named and not this one: dropped even where all is heard.
    expect(
      discordGroupGate(at({ otherBots: true }), policy({ freeGroups: ['c1'] })),
    ).toBeNull()
    expect(
      discordGroupGate(at({ otherBots: true, addressed: true }), policy()),
    ).toBe('explicit')
  })
})

describe('Discord adapter (hermes rules wired in)', () => {
  test('Discord: threads route under their parent, system messages and others’ conversations are marked', async () => {
    const net = new FakeNet()
      .on('/gateway/bot', { body: { url: 'wss://gateway.discord.gg' } })
      .on('/messages', { body: { id: 'out' } })
      .on('/typing', { status: 204 })
    const { adapter, got } = await started(
      new DiscordAdapter({ token: 'D' }, net.io()),
    )
    await until(() => net.sockets.length === 1)
    const socket = net.sockets[0]!
    socket.push({ op: 10, d: { heartbeat_interval: 60_000 } })
    socket.push({
      op: 0,
      s: 1,
      t: 'READY',
      d: { user: { id: '42' }, session_id: 's' },
    })
    socket.push({
      op: 0,
      s: 2,
      t: 'GUILD_CREATE',
      d: { id: 'g', threads: [{ id: 't1', parent_id: 'c1', type: 11 }] },
    })
    socket.push({
      op: 0,
      s: 3,
      t: 'THREAD_CREATE',
      d: { id: 't2', parent_id: 'c1', type: 11 },
    })
    socket.push({
      op: 0,
      s: 4,
      t: 'THREAD_DELETE',
      d: { id: 't2', parent_id: 'c1', type: 11 },
    })
    const said = (
      id: string,
      channel: string,
      extra: Record<string, unknown> = {},
    ) =>
      socket.push({
        op: 0,
        s: 5,
        t: 'MESSAGE_CREATE',
        d: {
          id,
          channel_id: channel,
          guild_id: 'g',
          type: 0,
          content: 'hi',
          author: { id: 'u1', username: 'li' },
          ...extra,
        },
      })
    said('m1', 't1')
    said('m2', 't2')
    said('m3', 'c1', { type: 7 })
    said('m4', 'c1', { mentions: [{ id: 'u2' }], content: '<@u2> 你看' })
    said('m5', 'c1', {
      mentions: [{ id: '42' }],
      content: '<@42> 你看',
      type: 19,
    })
    expect(
      got.map(one => [one.messageId, one.chat, one.addressed, one.mention]),
    ).toEqual([
      ['m1', { type: 'group', id: 'c1', threadId: 't1' }, false, undefined],
      ['m2', { type: 'group', id: 't2' }, false, undefined],
      ['m4', { type: 'group', id: 'c1' }, false, { othersOnly: true }],
      ['m5', { type: 'group', id: 'c1' }, true, undefined],
    ])
    await adapter.send(got[0]!.chat, '好')
    await adapter.typing(got[0]!.chat)
    expect(net.to('/channels/t1/messages')).toHaveLength(1)
    expect(net.to('/channels/t1/typing')).toHaveLength(1)
    expect(adapter.followsThreads).toBe(true)
  })
})
