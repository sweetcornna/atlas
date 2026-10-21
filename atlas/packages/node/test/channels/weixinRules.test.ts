// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
// 规则来源 NousResearch/hermes-agent `plugins/platforms/weixin/adapter.py:15`、`:56-78`、`:264-269`、`:394-518`、`:701-706`、`:716-737`、`:879-890`、`:965-975`、`:1205-1206`、`:1402-1407`，`gateway/platforms/helpers.py:548-570`，取于 `63220ae5`，取用日期 2026-10-19

/**
 * WeChat (iLink) message rules rewritten after hermes-agent (`src/channels/
 * rules/weixin.ts`, hermes `weixin` at `63220ae5`).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  ContentDedup,
  chattyBlock,
  contentKey,
  formatForWeixin,
  normalizeMarkdownBlocks,
  splitForWeixin,
  staleSession,
  weixinChat,
  wrapCopyFriendlyLines,
} from '../../src/channels/rules/weixin.js'
import type {
  ChannelAdapter,
  ChannelInbound,
} from '../../src/channels/types.js'
import { ILINK_BASE_URL, WeixinAdapter } from '../../src/channels/weixin.js'
import { FakeNet, until } from './fakes.js'

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

describe('WeChat (hermes)', () => {
  test('a group is a room id, or a to_user_id that is not the bot on a user message', () => {
    expect(
      weixinChat({ from_user_id: 'u', room_id: 'r@chatroom' }, 'bot'),
    ).toEqual({
      type: 'group',
      id: 'r@chatroom',
    })
    expect(
      weixinChat(
        { from_user_id: 'u', to_user_id: 'g@chatroom', msg_type: 1 },
        'bot',
      ),
    ).toEqual({
      type: 'group',
      id: 'g@chatroom',
    })
    expect(
      weixinChat({ from_user_id: 'u', to_user_id: 'bot', msg_type: 1 }, 'bot'),
    ).toEqual({
      type: 'dm',
      id: 'u',
    })
    expect(weixinChat({ from_user_id: 'u', to_user_id: 'x' }, 'bot')).toEqual({
      type: 'dm',
      id: 'u',
    })
  })

  test('the same words from the same sender count once in five minutes', () => {
    let now = 0
    const dedup = new ContentDedup(() => now)
    expect(dedup.duplicate(contentKey('u', '好'))).toBe(false)
    expect(dedup.duplicate(contentKey('u', '好'))).toBe(true)
    expect(dedup.duplicate(contentKey('v', '好'))).toBe(false)
    now = 300_000
    expect(dedup.duplicate(contentKey('u', '好'))).toBe(false)
    expect(contentKey('u', '好')).toMatch(/^content:u:[0-9a-f]{32}$/)
  })

  test('Markdown stays; blank runs squeeze outside code; long prose lines wrap at 120', () => {
    expect(normalizeMarkdownBlocks('a  \n\n\n\nb\n```\nx\n\n\ny\n```')).toBe(
      'a\n\nb\n```\nx\n\n\ny\n```',
    )
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    const wrapped = wrapCopyFriendlyLines(words).split('\n')
    expect(wrapped.length).toBeGreaterThan(1)
    for (const line of wrapped) expect(line.length).toBeLessThanOrEqual(120)
    expect(wrapped.join(' ')).toBe(words)
    const table = `| ${'x'.repeat(130)} |`
    expect(wrapCopyFriendlyLines(table)).toBe(table)
    expect(formatForWeixin('**粗**')).toBe('**粗**')
  })

  test('one message when it fits, a short chatty exchange line by line, long replies by blocks', () => {
    expect(splitForWeixin('好的\n马上就来\n等我一下')).toEqual([
      '好的',
      '马上就来',
      '等我一下',
    ])
    expect(chattyBlock('步骤：\n第一\n第二')).toBe(false)
    expect(splitForWeixin('## 标题\n内容')).toEqual(['## 标题\n内容'])
    expect(splitForWeixin('- 一\n- 二')).toEqual(['- 一\n- 二'])
    const long = Array.from(
      { length: 5 },
      (_, i) => `${i}${'字'.repeat(700)}`,
    ).join('\n\n')
    const parts = splitForWeixin(long)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(2_000)
    expect(parts.join('\n\n')).toBe(long)
  })

  test('-2 with unknown error is a stale session, not a rate limit', () => {
    expect(staleSession(-2, 'Unknown Error')).toBe(true)
    expect(staleSession(-2, 'too frequent')).toBe(false)
    expect(staleSession(-14, 'unknown error')).toBe(false)
  })
})

describe('WeChat adapter (hermes rules wired in)', () => {
  test('WeChat: a to_user_id room is a group, and the same words under a new id count once', async () => {
    let polls = 0
    const net = new FakeNet().on('/getupdates', () =>
      polls++ === 0
        ? {
            body: {
              ret: 0,
              msgs: [
                {
                  message_id: 1,
                  from_user_id: 'wx-a',
                  to_user_id: 'room@chatroom',
                  msg_type: 1,
                  item_list: [{ type: 1, text_item: { text: '大家好' } }],
                },
                {
                  message_id: 2,
                  from_user_id: 'wx-a',
                  to_user_id: 'room@chatroom',
                  msg_type: 1,
                  item_list: [{ type: 1, text_item: { text: '大家好' } }],
                },
                {
                  from_user_id: 'wx-b',
                  item_list: [{ type: 1, text_item: { text: '在吗' } }],
                },
              ],
            },
          }
        : undefined,
    )
    const { got } = await started(
      new WeixinAdapter(
        { accountId: 'bot@im.bot', token: 'BT', baseUrl: ILINK_BASE_URL },
        net.io(),
      ),
    )
    await until(() => got.length === 2)
    expect(got.map(one => [one.chat, one.text])).toEqual([
      [{ type: 'group', id: 'room@chatroom' }, '大家好'],
      [{ type: 'dm', id: 'wx-b' }, '在吗'],
    ])
    expect(got[1]!.messageId).toMatch(/^content:wx-b:/)
  })
})
