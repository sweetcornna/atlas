// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
// 规则来源 NousResearch/hermes-agent `tests/gateway/test_telegram_group_gating.py:1-1014`、`tests/gateway/test_telegram_mention_boundaries.py:1-155`，取于 `63220ae5`，取用日期 2026-10-19

/**
 * Telegram's response rules rewritten after hermes-agent (`src/channels/rules/
 * telegram.ts`); the cases follow hermes' `test_telegram_group_gating.py`
 * and `test_telegram_mention_boundaries.py` at `63220ae5`.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  cleanTriggerText,
  GENERAL_TOPIC,
  mentionedBotHandles,
  mentionsBot,
  mentionsOnlyOtherBots,
  telegramGroupGate,
  telegramSendThreadId,
  telegramThreadId,
  telegramTypingThreadId,
} from '../../src/channels/rules/telegram.js'
import { TelegramAdapter } from '../../src/channels/telegram.js'
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

describe('Telegram (hermes)', () => {
  const bot = { id: '999', username: 'hermes_bot' }
  const entity = (body: string, mention: string, type = 'mention') => ({
    type,
    offset: body.indexOf(mention),
    length: mention.length,
  })
  const group = (body: string, extra: Record<string, unknown> = {}) => ({
    chat: { id: -200, type: 'supergroup' },
    text: body,
    ...extra,
  })

  test('mentions are what the entities say, UTF-16 offsets included', () => {
    const start = '@hermes_bot hello world'
    expect(
      mentionsBot(
        group(start, { entities: [entity(start, '@hermes_bot')] }),
        bot,
      ),
    ).toBe(true)
    const emoji = '🚀🚀 @hermes_bot hello'
    expect(
      mentionsBot(
        group(emoji, { entities: [entity(emoji, '@hermes_bot')] }),
        bot,
      ),
    ).toBe(true)
    expect(
      mentionsBot(
        group('hey you', {
          entities: [
            { type: 'text_mention', offset: 4, length: 3, user: { id: 999 } },
          ],
        }),
        bot,
      ),
    ).toBe(true)
    const upper = 'hi @HERMES_BOT'
    expect(
      mentionsBot(
        group(upper, { entities: [entity(upper, '@HERMES_BOT')] }),
        bot,
      ),
    ).toBe(true)
    expect(
      mentionsBot(
        group('@hermes_bot hi', {
          entities: [{ type: 'mention', offset: -1, length: 11 }],
        }),
        bot,
      ),
    ).toBe(false)
  })

  test('the raw-text fallback is narrow: no emails, URLs or glued prefixes', () => {
    expect(mentionsBot(group('email me at foo@hermes_bot.example'), bot)).toBe(
      false,
    )
    expect(
      mentionsBot(
        group('see https://example.com/@hermes_bot for details'),
        bot,
      ),
    ).toBe(false)
    expect(
      mentionsBot(group('', { caption: 'foo@hermes_bot.example' }), bot),
    ).toBe(false)
    expect(mentionsBot(group('prefix@hermes_bot hi'), bot)).toBe(false)
    expect(mentionsBot(group('hi @hermes_bot'), bot)).toBe(true)
  })

  test('/cmd@bot is an address; /cmd@other_bot is not', () => {
    const ours = '🧪🧪 /new@hermes_bot'
    const command = group(ours, {
      entities: [entity(ours, '/new@hermes_bot', 'bot_command')],
    })
    expect(mentionsBot(command, bot)).toBe(true)
    expect(mentionedBotHandles(command, '')).toEqual(new Set(['hermes_bot']))
    const theirs = '/status@other_bot'
    expect(
      mentionsBot(
        group(theirs, { entities: [entity(theirs, theirs, 'bot_command')] }),
        bot,
      ),
    ).toBe(false)
  })

  test('explicit mentions of other bots exclude this one, with or without entities', () => {
    const body = '@research_bot @ops_bot hi'
    const tagged = group(body, {
      entities: [entity(body, '@research_bot'), entity(body, '@ops_bot')],
    })
    for (const message of [tagged, group(body)]) {
      expect(mentionsOnlyOtherBots(message, 'default_bot')).toBe(true)
      expect(mentionsOnlyOtherBots(message, 'research_bot')).toBe(false)
      expect(mentionsBot(message, { id: '1', username: 'ops_bot' })).toBe(true)
    }
    const intern = "@Interntestnumber1bot you're not supposed to do the blog"
    expect(mentionsOnlyOtherBots(group(intern), 'Interntestnumber2bot')).toBe(
      true,
    )
    expect(
      mentionsBot(group(intern), { id: '1', username: 'Interntestnumber1bot' }),
    ).toBe(true)
    // A reply to this bot does not override it.
    const replied = inbound({
      chat: { type: 'group', id: '-200' },
      addressed: true,
      mention: { otherBots: true },
    })
    expect(telegramGroupGate(replied, policy({ trigger: 'all' }))).toBeNull()
  })

  test('free chats and topics; then reply or mention, the `all` trigger, a wake word', () => {
    const at = (
      threadId?: string,
      addressed = false,
      text = 'hello everyone',
    ) =>
      inbound({
        chat: { type: 'group', id: '-200', ...(threadId ? { threadId } : {}) },
        addressed,
        text,
      })
    const topics = policy({ freeGroups: ['-200:31'] })
    expect(telegramGroupGate(at('31'), topics)).toBe('implicit')
    expect(telegramGroupGate(at('32'), topics)).toBeNull()
    // A plain group is the General topic.
    expect(
      telegramGroupGate(
        at(),
        policy({ freeGroups: [`-200:${GENERAL_TOPIC}`] }),
      ),
    ).toBe('implicit')
    expect(
      telegramGroupGate(at(undefined), policy({ freeGroups: ['-200'] })),
    ).toBe('implicit')
    expect(telegramGroupGate(at(undefined, true), policy())).toBe('explicit')
    expect(telegramGroupGate(at(), policy({ trigger: 'all' }))).toBe('implicit')
    expect(
      telegramGroupGate(
        at(undefined, false, 'chompy status'),
        policy({ keywords: ['chompy'] }),
      ),
    ).toBe('implicit')
    expect(telegramGroupGate(at(), policy())).toBeNull()
  })

  test('the topic is the routing one: General is 1 in a forum, a plain reply anchor is none', () => {
    const forum = { id: -100, type: 'supergroup', is_forum: true }
    expect(telegramThreadId({ chat: forum })).toBe(GENERAL_TOPIC)
    expect(
      telegramThreadId({
        chat: forum,
        message_thread_id: 8,
        is_topic_message: true,
      }),
    ).toBe('8')
    expect(
      telegramThreadId({
        chat: { id: -200, type: 'group' },
        message_thread_id: 55,
        is_topic_message: false,
      }),
    ).toBeUndefined()
    expect(
      telegramThreadId({
        chat: { id: -200, type: 'supergroup' },
        message_thread_id: 9,
        is_topic_message: true,
      }),
    ).toBe('9')
    expect(telegramSendThreadId(GENERAL_TOPIC)).toBeUndefined()
    expect(telegramSendThreadId('8')).toBe(8)
    expect(telegramTypingThreadId(GENERAL_TOPIC)).toBe(1)
  })

  test('the trigger mention is cleaned off; a bare mention stays', () => {
    expect(cleanTriggerText('@hermes_bot, 在吗', 'hermes_bot')).toBe('在吗')
    expect(cleanTriggerText('看看 @HERMES_BOT: 这个', 'hermes_bot')).toBe(
      '看看 这个',
    )
    expect(cleanTriggerText('@hermes_bot', 'hermes_bot')).toBe('@hermes_bot')
  })
})

describe('Telegram adapter (hermes rules wired in)', () => {
  test('Telegram: General is topic 1, sent without it and typed with it; other bots named and cleaned triggers', async () => {
    let polls = 0
    const net = new FakeNet()
      .on('/getMe', {
        body: { ok: true, result: { id: 42, username: 'qm_bot' } },
      })
      .on('/getUpdates', () =>
        polls++ === 0
          ? {
              body: {
                ok: true,
                result: [
                  {
                    update_id: 1,
                    message: {
                      message_id: 1,
                      chat: { id: -100, type: 'supergroup', is_forum: true },
                      from: { id: 5 },
                      text: '@qm_bot, 看下',
                      entities: [{ type: 'mention', offset: 0, length: 7 }],
                    },
                  },
                  {
                    update_id: 2,
                    message: {
                      message_id: 2,
                      chat: { id: -200, type: 'group' },
                      from: { id: 5 },
                      text: '@other_bot 你来',
                      reply_to_message: { message_id: 9, from: { id: 42 } },
                      message_thread_id: 9,
                    },
                  },
                ],
              },
            }
          : undefined,
      )
      .on('/sendMessage', { body: { ok: true, result: { message_id: 3 } } })
      .on('/sendChatAction', { body: { ok: true } })
    const { adapter, got } = await started(
      new TelegramAdapter({ token: 'T' }, net.io()),
    )
    await until(() => got.length === 2)
    expect(got[0]).toMatchObject({
      chat: { type: 'group', id: '-100', threadId: '1' },
      text: '看下',
      addressed: true,
    })
    expect(got[1]!.chat).toEqual({ type: 'group', id: '-200' })
    expect(got[1]!.mention).toEqual({ otherBots: true })
    expect(
      adapter.groupGate(got[1]!, {
        trigger: 'all',
        freeGroups: [],
        keywords: [],
        followed: false,
      }),
    ).toBeNull()
    await adapter.send(got[0]!.chat, '好')
    expect(net.to('/sendMessage')[0]!.body).not.toHaveProperty(
      'message_thread_id',
    )
    await adapter.typing(got[0]!.chat)
    expect(net.to('/sendChatAction')[0]!.body).toMatchObject({
      message_thread_id: 1,
    })
    expect(adapter.textBatch.quietMs).toBe(300)
  })
})
