// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The reply logic ported from grantley (P28, `runtimes-channels.md` §2.3):
 * who is answered on which lane, one turn per conversation with the rest
 * queued and folded, owner commands, sticky framing, silence and failures.
 */

import { describe, expect, test } from 'bun:test'
import {
  ChannelGateway,
  type ChannelRules,
  conversationKey,
  isStatusQuery,
} from '../../src/channels/gateway.js'
import { FakeAdapter, FakeTurns, inbound, until } from './fakes.js'

const RULES: ChannelRules = {
  id: 'ch-1',
  ownerIds: ['owner'],
  members: false,
  allowAll: false,
  allowUsers: [],
  allowGroups: [],
  groupTrigger: 'mention',
  replyWindowMs: 0,
}

function setup(options: { refresh?: number } = {}) {
  const turns = new FakeTurns()
  const adapter = new FakeAdapter()
  const errors: string[] = []
  const gateway = new ChannelGateway({
    turns,
    typingIntervalMs: 5,
    ...(options.refresh === undefined
      ? {}
      : { stickyRefreshTurns: options.refresh }),
    onError: message => errors.push(message),
  })
  return { turns, adapter, gateway, errors }
}

const GROUP = { type: 'group', id: 'g-1' } as const

describe('admission', () => {
  test('the owner private chat is the owner lane; strangers are dropped', async () => {
    const { turns, adapter, gateway } = setup()
    gateway.handle(
      RULES,
      adapter,
      inbound({ userId: 'stranger', chat: { type: 'dm', id: 'stranger' } }),
    )
    gateway.handle(RULES, adapter, inbound({ text: '在吗' }))
    await until(() => turns.calls.length === 1)
    expect(turns.calls[0]!.conversation.lane).toBe('owner')
    expect(turns.calls[0]!.conversation.key).toBe('ch-1:dm:owner')
    expect(turns.calls[0]!.text.endsWith('在吗')).toBe(true)
    turns.answer(0, '在')
    await gateway.idle()
    expect(turns.calls).toHaveLength(1)
  })

  test('other people are answered only with a member agent and on the allow list', async () => {
    const { turns, adapter, gateway } = setup()
    const rules = { ...RULES, members: true, allowUsers: ['friend'] }
    gateway.handle(
      rules,
      adapter,
      inbound({ userId: 'other', chat: { type: 'dm', id: 'other' } }),
    )
    gateway.handle(
      rules,
      adapter,
      inbound({
        userId: 'friend',
        userName: '小王',
        chat: { type: 'dm', id: 'friend' },
      }),
    )
    await until(() => turns.calls.length === 1)
    expect(turns.calls[0]!.conversation.lane).toBe('member')
    expect(turns.calls[0]!.text).toContain('不是你的主人')
    turns.answer(0, '你好')
    await gateway.idle()
  })

  test('groups: only allowed groups, only when addressed under the mention trigger', async () => {
    const { turns, adapter, gateway } = setup()
    const rules = { ...RULES, members: true, allowGroups: ['g-1'] }
    gateway.handle(
      rules,
      adapter,
      inbound({ chat: { type: 'group', id: 'g-2' } }),
    )
    gateway.handle(rules, adapter, inbound({ chat: GROUP, addressed: false }))
    gateway.handle(
      rules,
      adapter,
      inbound({
        chat: GROUP,
        userId: 'u7',
        userName: '老李',
        text: '帮我看看',
      }),
    )
    await until(() => turns.calls.length === 1)
    const call = turns.calls[0]!
    expect(call.conversation.key).toBe('ch-1:group:g-1')
    expect(call.conversation.lane).toBe('member')
    expect(call.text.endsWith('[老李(u7)] 帮我看看')).toBe(true)
    turns.answer(0, '好')
    await gateway.idle()
  })

  test('a group without a member agent hears only the owner', async () => {
    const { turns, adapter, gateway } = setup()
    const rules = {
      ...RULES,
      allowGroups: ['g-1'],
      groupTrigger: 'all' as const,
    }
    gateway.handle(
      rules,
      adapter,
      inbound({ chat: GROUP, userId: 'u7', addressed: false }),
    )
    gateway.handle(
      rules,
      adapter,
      inbound({ chat: GROUP, addressed: false, text: '记一下' }),
    )
    await until(() => turns.calls.length === 1)
    expect(turns.calls[0]!.conversation.lane).toBe('owner')
    turns.answer(0, '记下了')
    await gateway.idle()
  })

  test('a message delivered twice runs once', async () => {
    const { turns, adapter, gateway } = setup()
    gateway.handle(RULES, adapter, inbound({ id: 'same' }))
    gateway.handle(RULES, adapter, inbound({ id: 'same' }))
    await until(() => turns.calls.length === 1)
    turns.answer(0, 'ok')
    await gateway.idle()
    expect(turns.calls).toHaveLength(1)
  })

  test('threads are their own conversations', () => {
    expect(
      conversationKey('c', { type: 'group', id: 'g', threadId: 't' }),
    ).toBe('c:group:g:t')
  })
})

describe('one turn at a time', () => {
  test('a private chat folds everything queued into one follow-up turn', async () => {
    const { turns, adapter, gateway } = setup()
    gateway.handle(RULES, adapter, inbound({ text: '第一句' }))
    await until(() => turns.calls.length === 1)
    gateway.handle(RULES, adapter, inbound({ text: '补充一' }))
    gateway.handle(RULES, adapter, inbound({ text: '补充二' }))
    expect(gateway.busy('ch-1:dm:owner')).toBe(true)
    turns.answer(0, '收到')
    await until(() => turns.calls.length === 2)
    expect(turns.calls[1]!.text.endsWith('补充一\n补充二')).toBe(true)
    turns.answer(1, '都收到')
    await gateway.idle()
    expect(adapter.texts()).toEqual(['收到', '都收到'])
    expect(gateway.busy('ch-1:dm:owner')).toBe(false)
  })

  test('a group keeps one entry per sender, in the order each first queued', async () => {
    const { turns, adapter, gateway } = setup()
    const rules = { ...RULES, members: true, allowGroups: ['g-1'] }
    const say = (userId: string, text: string) =>
      gateway.handle(
        rules,
        adapter,
        inbound({ chat: GROUP, userId, userName: userId, text }),
      )
    say('a', '开头')
    await until(() => turns.calls.length === 1)
    say('b', 'b1')
    say('c', 'c1')
    say('b', 'b2')
    turns.answer(0, '1')
    await until(() => turns.calls.length === 2)
    expect(turns.calls[1]!.text.endsWith('[b] b1\n[b] b2')).toBe(true)
    turns.answer(1, '2')
    await until(() => turns.calls.length === 3)
    expect(turns.calls[2]!.text.endsWith('[c] c1')).toBe(true)
    turns.answer(2, '3')
    await gateway.idle()
  })

  test('a reply window collects a burst into one turn', async () => {
    const { turns, adapter, gateway } = setup()
    const rules = { ...RULES, replyWindowMs: 30 }
    gateway.handle(rules, adapter, inbound({ text: '一' }))
    gateway.handle(rules, adapter, inbound({ text: '二' }))
    await until(() => turns.calls.length === 1)
    expect(turns.calls[0]!.text.endsWith('一\n二')).toBe(true)
    turns.answer(0, 'ok')
    await gateway.idle()
  })

  test('typing runs while the turn does and stops after it', async () => {
    const { turns, adapter, gateway } = setup()
    gateway.handle(RULES, adapter, inbound())
    await until(() => adapter.typed.length >= 2)
    turns.answer(0, 'ok')
    await gateway.idle()
    expect(adapter.typed[0]).toBe('on owner')
    expect(adapter.typed.at(-1)).toBe('off owner')
  })
})

describe('sticky framing', () => {
  test('the first turn carries it, later turns of the same session do not', async () => {
    const { turns, adapter, gateway } = setup()
    const rules = { ...RULES, prompt: '回答要简短' }
    gateway.handle(rules, adapter, inbound({ text: 'a' }))
    await until(() => turns.calls.length === 1)
    expect(turns.calls[0]!.text).toContain(
      '[渠道] 这段对话来自 Telegram 的私聊',
    )
    expect(turns.calls[0]!.text).toContain('[渠道说明]\n回答要简短')
    turns.answer(0, 'ok')
    await gateway.idle()
    gateway.handle(rules, adapter, inbound({ text: 'b' }))
    await until(() => turns.calls.length === 2)
    expect(turns.calls[1]!.text).toBe('b')
    turns.answer(1, 'ok')
    await gateway.idle()
    // A changed prompt is sent again, alone.
    gateway.handle(
      { ...rules, prompt: '回答要详细' },
      adapter,
      inbound({ text: 'c' }),
    )
    await until(() => turns.calls.length === 3)
    expect(turns.calls[2]!.text).toBe('[渠道说明]\n回答要详细\n\nc')
    turns.answer(2, 'ok')
    await gateway.idle()
  })

  test('a channel prompt with blank lines stays one paragraph', async () => {
    const { turns, adapter, gateway } = setup()
    gateway.handle(
      { ...RULES, prompt: '第一条\n\n第二条\n \n\n第三条' },
      adapter,
      inbound({ text: 'a' }),
    )
    await until(() => turns.calls.length === 1)
    expect(turns.calls[0]!.text).toContain(
      '[渠道说明]\n第一条\n第二条\n第三条\n\na',
    )
    turns.answer(0, 'ok')
    await gateway.idle()
  })

  test('a failed turn does not count as delivered', async () => {
    const { turns, adapter, gateway } = setup()
    gateway.handle(RULES, adapter, inbound({ text: 'a' }))
    await until(() => turns.calls.length === 1)
    turns.answer(0, { ok: false, text: '', error: 'boom' })
    await gateway.idle()
    gateway.handle(RULES, adapter, inbound({ text: 'b' }))
    await until(() => turns.calls.length === 2)
    expect(turns.calls[1]!.text).toContain('[渠道]')
    turns.answer(1, 'ok')
    await gateway.idle()
  })

  test('refreshed every N turns and after a compaction', async () => {
    const { turns, adapter, gateway } = setup({ refresh: 2 })
    const send = async (
      index: number,
      result: Parameters<FakeTurns['answer']>[1] = 'ok',
    ) => {
      gateway.handle(RULES, adapter, inbound({ text: `t${index}` }))
      await until(() => turns.calls.length === index + 1)
      turns.answer(index, result)
      await gateway.idle()
      return turns.calls[index]!.text.includes('[渠道]')
    }
    expect(await send(0)).toBe(true)
    expect(await send(1)).toBe(false)
    expect(await send(2)).toBe(true)
    expect(await send(3, { ok: true, text: 'ok', compacted: true })).toBe(false)
    expect(await send(4)).toBe(true)
  })
})

describe('replies', () => {
  test('silence sends nothing; prose that mentions the marker is a reply', async () => {
    const { turns, adapter, gateway } = setup()
    gateway.handle(RULES, adapter, inbound({ text: 'a' }))
    await until(() => turns.calls.length === 1)
    turns.answer(0, ' *[SILENT]* ')
    await gateway.idle()
    expect(adapter.sent).toHaveLength(0)
    gateway.handle(RULES, adapter, inbound({ text: 'b' }))
    await until(() => turns.calls.length === 2)
    turns.answer(1, '我本来想回 [SILENT] 的')
    await gateway.idle()
    expect(adapter.texts()).toEqual(['我本来想回 [SILENT] 的'])
  })

  test('the first chunk replies to the message, long replies are split', async () => {
    const turns = new FakeTurns()
    const adapter = new FakeAdapter('telegram', 40)
    const gateway = new ChannelGateway({ turns })
    gateway.handle(RULES, adapter, inbound({ id: 'm-9' }))
    await until(() => turns.calls.length === 1)
    turns.answer(
      0,
      Array.from({ length: 8 }, (_, i) => `第${i}行内容`).join('\n'),
    )
    await gateway.idle()
    expect(adapter.sent.length).toBeGreaterThan(1)
    expect(adapter.sent[0]!.replyTo).toBe('m-9')
    expect(adapter.sent[1]!.replyTo).toBeUndefined()
    for (const one of adapter.sent)
      expect(one.text.length).toBeLessThanOrEqual(40)
    expect(
      adapter.sent
        .at(-1)!
        .text.endsWith(`(${adapter.sent.length}/${adapter.sent.length})`),
    ).toBe(true)
  })

  test('MEDIA lines are removed and the owner told', async () => {
    const { turns, adapter, gateway } = setup()
    gateway.handle(RULES, adapter, inbound())
    await until(() => turns.calls.length === 1)
    turns.answer(0, '图在这\nMEDIA: /tmp/a.png')
    await gateway.idle()
    expect(adapter.texts()).toEqual([
      '图在这',
      '（回复里有 1 个附件，渠道暂不转交附件，请在控制台查看。）',
    ])
  })

  test('failures reach the owner, never a member, and not after /stop', async () => {
    const { turns, adapter, gateway } = setup()
    const rules = { ...RULES, members: true, allowAll: true }
    gateway.handle(rules, adapter, inbound())
    gateway.handle(
      rules,
      adapter,
      inbound({ userId: 'x', chat: { type: 'dm', id: 'x' } }),
    )
    await until(() => turns.calls.length === 2)
    turns.answer(0, { ok: false, text: '', timedOut: true })
    turns.answer(1, { ok: false, text: '', error: 'secret stack' })
    await gateway.idle()
    expect(adapter.texts()).toEqual([
      '⚠️ 这轮执行到时间上限后停止了。已完成的操作会保留，可以让我接着做；控制台对话页可以查看停止原因。',
    ])
    gateway.handle(rules, adapter, inbound())
    await until(() => turns.calls.length === 3)
    turns.answer(2, { ok: false, text: '', cancelled: true })
    await gateway.idle()
    expect(adapter.sent).toHaveLength(1)
  })

  test('progress notices go to the owner lane only', async () => {
    const { turns, adapter, gateway } = setup()
    const rules = { ...RULES, members: true, allowAll: true }
    gateway.handle(rules, adapter, inbound())
    gateway.handle(
      rules,
      adapter,
      inbound({ userId: 'x', chat: { type: 'dm', id: 'x' } }),
    )
    await until(() => turns.calls.length === 2)
    turns.calls[0]!.notice('子任务完成')
    turns.calls[1]!.notice('子任务完成')
    turns.calls[0]!.notice('[SILENT]')
    turns.answer(0, 'a')
    turns.answer(1, 'b')
    await gateway.idle()
    expect(
      adapter.sent
        .filter(one => one.text === '子任务完成')
        .map(one => one.chat.id),
    ).toEqual(['owner'])
  })

  test('a send failure is reported, not thrown', async () => {
    const { turns, adapter, gateway, errors } = setup()
    adapter.failSend = true
    gateway.handle(RULES, adapter, inbound())
    await until(() => turns.calls.length === 1)
    turns.answer(0, 'x')
    await gateway.idle()
    expect(errors).toEqual(['渠道发送失败：down'])
  })
})

describe('commands', () => {
  test('/new stops the turn (not the tasks), resets and re-sends the framing', async () => {
    const { turns, adapter, gateway } = setup()
    gateway.handle(RULES, adapter, inbound({ text: 'a' }))
    await until(() => turns.calls.length === 1)
    turns.answer(0, 'ok')
    await gateway.idle()
    gateway.handle(RULES, adapter, inbound({ text: '/new' }))
    await until(() => adapter.sent.length === 2)
    expect(adapter.texts()[1]).toBe('好，换个新话题。')
    expect(turns.log).toEqual(['stop ch-1:dm:owner', 'reset ch-1:dm:owner'])
    gateway.handle(RULES, adapter, inbound({ text: 'b' }))
    await until(() => turns.calls.length === 2)
    expect(turns.calls[1]!.text).toContain('[渠道]')
    turns.answer(1, 'ok')
    await gateway.idle()
  })

  test('/stop, /model, /compact, /status and /help answer at once', async () => {
    const { turns, adapter, gateway } = setup()
    for (const text of [
      '/stop',
      '/model',
      '/model code',
      '/model default',
      '/compact',
      '/status',
      '/help@qianmo_bot',
    ])
      gateway.handle(RULES, adapter, inbound({ text }))
    await until(() => adapter.sent.length === 7)
    // Commands do not queue behind each other: compare as a set.
    const texts = adapter.texts()
    for (const reply of [
      '现在没在跑任务。',
      '当前方向：默认',
      '已切换到 code',
      '已恢复默认',
      '已压缩上下文。',
    ])
      expect(texts).toContain(reply)
    expect(texts.some(text => text.includes('会话键：ch-1:dm:owner'))).toBe(
      true,
    )
    expect(texts.some(text => text.startsWith('/new 新会话'))).toBe(true)
    expect(turns.calls).toHaveLength(0)
    // /stop also stops the chat's background tasks.
    expect(turns.log).toContain('stop+tasks ch-1:dm:owner')
  })

  test("a member's command is ordinary text, except /help", async () => {
    const { turns, adapter, gateway } = setup()
    const rules = { ...RULES, members: true, allowAll: true }
    const member = { userId: 'x', chat: { type: 'dm' as const, id: 'x' } }
    gateway.handle(rules, adapter, inbound({ ...member, text: '/new' }))
    gateway.handle(rules, adapter, inbound({ ...member, text: '/help' }))
    await until(() => turns.calls.length === 1 && adapter.sent.length === 1)
    expect(turns.calls[0]!.text.endsWith('/new')).toBe(true)
    expect(turns.log).toEqual([])
    turns.answer(0, 'ok')
    await gateway.idle()
  })
})

describe('notes', () => {
  test('quotes and attachments become notes before the text', async () => {
    const { turns, adapter, gateway } = setup()
    gateway.handle(
      RULES,
      adapter,
      inbound({
        text: '这个呢',
        quote: { text: 'x'.repeat(600), own: false, authorName: '小王' },
        attachments: [{ name: 'a.png', kind: 'image' }],
      }),
    )
    await until(() => turns.calls.length === 1)
    const text = turns.calls[0]!.text
    expect(text).toContain(`[在回复 小王 的消息："${'x'.repeat(500)}"]`)
    expect(text).not.toContain('x'.repeat(501))
    expect(text).toContain('[对方发了一张图片：a.png（渠道暂不转交附件）]')
    expect(text.endsWith('这个呢')).toBe(true)
    turns.answer(0, 'ok')
    await gateway.idle()
  })

  test('close drops queued work', async () => {
    const { turns, adapter, gateway } = setup()
    gateway.handle(RULES, adapter, inbound({ text: 'a' }))
    await until(() => turns.calls.length === 1)
    gateway.handle(RULES, adapter, inbound({ text: 'b' }))
    gateway.close()
    gateway.handle(RULES, adapter, inbound({ text: 'c' }))
    turns.answer(0, 'ok')
    await gateway.idle()
    expect(turns.calls).toHaveLength(1)
  })
})

describe('background tasks', () => {
  test('the rules are sticky, the task summary is a note on every turn', async () => {
    const { turns, adapter, gateway } = setup()
    const contexts: string[] = []
    Object.assign(turns, {
      context: (conversation: { key: string }) => {
        contexts.push(conversation.key)
        return {
          sticky: [{ id: 'tasks_rules', text: '[后台任务协调规则] 规则' }],
          note: '[当前会话的后台任务] []',
        }
      },
    })
    for (const [index, text] of ['a', 'b'].entries()) {
      gateway.handle(RULES, adapter, inbound({ text }))
      await until(() => turns.calls.length === index + 1)
      turns.answer(index, 'ok')
      await gateway.idle()
    }
    expect(turns.calls[0]!.text).toContain('[后台任务协调规则] 规则')
    expect(turns.calls[1]!.text).toBe('[当前会话的后台任务] []\n\nb')
    expect(contexts).toEqual(['ch-1:dm:owner', 'ch-1:dm:owner'])
  })

  test("the owner's progress question is answered from task status, without a turn", async () => {
    const { turns, adapter, gateway } = setup()
    let tasks = true
    Object.assign(turns, {
      intercept: async () => (tasks ? '周报：执行中' : null),
    })
    gateway.handle(
      RULES,
      adapter,
      inbound({ text: '进度怎么样了？', id: 'q1' }),
    )
    await until(() => adapter.sent.length === 1)
    expect(adapter.sent[0]).toMatchObject({
      text: '周报：执行中',
      replyTo: 'q1',
    })
    tasks = false
    gateway.handle(RULES, adapter, inbound({ text: '进度怎么样了？' }))
    await until(() => turns.calls.length === 1)
    turns.answer(0, '没有任务')
    await gateway.idle()
    // Not a status question: an ordinary turn.
    gateway.handle(RULES, adapter, inbound({ text: '帮我看看进度表' }))
    await until(() => turns.calls.length === 2)
    turns.answer(1, 'ok')
    await gateway.idle()
  })

  test('post sends a result outside any turn, split to the platform limit', async () => {
    const turns = new FakeTurns()
    const adapter = new FakeAdapter('qq', 30)
    const gateway = new ChannelGateway({ turns })
    expect(
      await gateway.post(
        adapter,
        { type: 'dm', id: 'owner' },
        '结果'.repeat(30),
      ),
    ).toBe(true)
    expect(adapter.sent.length).toBeGreaterThan(1)
    adapter.failSend = true
    expect(await gateway.post(adapter, { type: 'dm', id: 'owner' }, 'x')).toBe(
      false,
    )
  })

  test('isStatusQuery matches whole progress questions only', () => {
    for (const text of [
      '进度怎么样了',
      '现在到哪一步了？',
      '任务做完了吗',
      '好了没',
      '快点！',
      'any updates?',
    ])
      expect(`${text} ${isStatusQuery(text)}`).toBe(`${text} true`)
    for (const text of [
      '帮我查一下进度表',
      '/status',
      '今天天气怎么样了',
      '进度'.repeat(100),
    ])
      expect(`${text} ${isStatusQuery(text)}`).toBe(`${text} false`)
  })
})
