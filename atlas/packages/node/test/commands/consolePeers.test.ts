// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Synchronous questions between agents on the hub (P36.6): the caller's turn
 * checked as for background tasks, one kept conversation per asking
 * conversation and asked agent, targets in parallel, the signed call chain
 * built and extended, cycles and over-deep chains refused, a late target
 * stopped, and one audit record per target without the text.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ChatSendInput } from '@qianmo/console'
import { LIMITS, type ControlOutcome } from '@qianmo/protocol'
import { NodeTurnGate } from '@qianmo/resident'
import { MemoryActionLedger } from '../../../console/test/memoryActions.js'
import {
  ConsolePeers,
  type ConsolePeersOptions,
  type PeerAnswer,
  type PeerRosterRow,
} from '../../src/commands/consolePeers.js'
import { until } from '../channels/fakes.js'
import { FakeChat } from './fakeChat.js'

const MAIN = 'qianmo://node-a/main'
const HELPER = 'qianmo://node-a/helper'
const CODER = 'qianmo://node-b/coder'
const REVIEWER = 'qianmo://node-b/reviewer'
const OTHER = 'qianmo://node-c/other'

let root: string
let chat: FakeChat
let actions: MemoryActionLedger
let stopped: [string, string][]
let open: ConsolePeers[]

function peers(options: Partial<ConsolePeersOptions> = {}): ConsolePeers {
  const book = new ConsolePeers({
    directory: root,
    chat,
    actions,
    stopTask: async (target, taskId) => {
      stopped.push([target, taskId])
      return true
    },
    // One second of a question is 20 ms here.
    timeoutMs: sec => sec * 20,
    ...options,
  })
  open.push(book)
  book.start()
  return book
}

/** A conversation with one line still waiting for its answer. */
async function conversation(target = MAIN): Promise<string> {
  const session = await chat.open(target)
  if (!session.ok) throw new Error('open')
  await chat.send({ sessionId: session.value.id, text: '帮我问一下' })
  return session.value.id
}

function call(
  book: ConsolePeers,
  op: 'ask' | 'list',
  sessionId: string,
  args: Record<string, unknown> = {},
  address = MAIN,
): Promise<ControlOutcome> {
  const [, , node, agent] = address.split('/')
  return book.handle(
    `peers.${op}`,
    { ...args, contextId: sessionId, taskId: chat.lastTask(sessionId) },
    { node: node!, agent: agent!, callId: 'c-1' },
  )
}

function ask(
  book: ConsolePeers,
  sessionId: string,
  agents: readonly string[],
  extra: Record<string, unknown> = {},
  address = MAIN,
): Promise<ControlOutcome> {
  return call(
    book,
    'ask',
    sessionId,
    { agents, message: '六乘七是多少？', timeoutSec: 300, ...extra },
    address,
  )
}

function answers(outcome: ControlOutcome): PeerAnswer[] {
  if (!outcome.ok) throw new Error(outcome.message)
  return (outcome.value as { answers: PeerAnswer[] }).answers
}

/** The conversations the hub asked `target` in, oldest first. */
function asked(target: string): string[] {
  return [
    ...new Set(
      chat.sent
        .filter(one => one.chain !== undefined)
        .map(one => one.sessionId)
        .filter(id => chat.records.get(id)?.session.target === target),
    ),
  ]
}

/** The conversation the hub asked `target` in, once it has `n` lines. */
async function askedIn(target: string, n = 1): Promise<string> {
  await until(() => {
    const id = asked(target).at(-1)
    return id !== undefined && chat.sentTo(id).length >= n
  })
  return asked(target).at(-1)!
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-peers-'))
  chat = new FakeChat([MAIN, HELPER, CODER, REVIEWER, OTHER])
  actions = new MemoryActionLedger()
  stopped = []
  open = []
})

afterEach(async () => {
  await Promise.all(open.map(book => book.close()))
  fs.rmSync(root, { recursive: true, force: true })
})

describe('asking', () => {
  test('one target: the question goes out marked with its source and the signed chain; the answer is its terminal text', async () => {
    const book = peers()
    const caller = await conversation()
    const pending = ask(book, caller, [CODER])
    const peer = await askedIn(CODER)
    const line = chat.sentTo(peer)[0]!
    expect(line.text.split('\n')[0]).toBe(`来自 ${MAIN} 的提问`)
    expect(line.text).toContain('六乘七是多少？')
    expect(line.chain).toEqual([
      { node: 'node-a', taskId: chat.lastTask(caller) },
    ])
    // The question's own timeout, counted from when it was asked.
    expect(line.taskTtlMs).toBeLessThanOrEqual(300 * 20)
    expect(line.taskTtlMs).toBeGreaterThan(299 * 20)
    // An interactive turn: never the background class.
    expect(line.background).toBeUndefined()
    chat.notice(peer, '查了一下')
    chat.reply(peer, '42')
    expect(answers(await pending)).toEqual([
      { agent: CODER, ok: true, reply: '42' },
    ])
  })

  test('several targets go out together and come back in the order asked', async () => {
    const book = peers()
    const caller = await conversation()
    const pending = ask(book, caller, [CODER, REVIEWER])
    // Both are out before either has answered.
    const coder = await askedIn(CODER)
    const reviewer = await askedIn(REVIEWER)
    chat.reply(reviewer, '看过了，没问题')
    chat.reply(coder, '42', 'failed')
    expect(answers(await pending)).toEqual([
      { agent: CODER, ok: false, code: 'failed', error: '42' },
      { agent: REVIEWER, ok: true, reply: '看过了，没问题' },
    ])
  })

  test('each asking conversation keeps one conversation per agent, across asks and restarts', async () => {
    const book = peers()
    const caller = await conversation()
    const first = ask(book, caller, [CODER])
    const peer = await askedIn(CODER)
    chat.reply(peer, '42')
    await first
    const second = ask(book, caller, [CODER], { message: '那六乘八呢？' })
    await askedIn(CODER, 2)
    expect(asked(CODER)).toEqual([peer])
    // Only the first question explains what this conversation is.
    const [one, two] = chat.sentTo(peer)
    expect(one!.text).toContain('同步发来的提问')
    expect(two!.text).toBe(`来自 ${MAIN} 的提问\n\n那六乘八呢？`)
    chat.reply(peer, '48')
    expect(answers(await second)[0]).toMatchObject({ reply: '48' })
    // The pair survives a restart, in a file only the hub user reads.
    const file = path.join(root, 'peers.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    await book.close()
    const again = peers()
    const third = ask(again, caller, [CODER])
    await askedIn(CODER, 3)
    expect(asked(CODER)).toEqual([peer])
    chat.reply(peer, 'ok')
    await third
    // Another asking conversation: another conversation with the same agent.
    const other = await conversation()
    const fourth = ask(again, other, [CODER])
    await until(() => asked(CODER).length === 2)
    chat.reply(asked(CODER)[1]!, 'ok')
    await fourth
  })

  test('a target past the question is stopped on its node and reported as timed out', async () => {
    const book = peers()
    const caller = await conversation()
    const pending = ask(book, caller, [CODER, REVIEWER], { timeoutSec: 5 })
    const reviewer = await askedIn(REVIEWER)
    chat.reply(reviewer, '好')
    const coder = await askedIn(CODER)
    const result = answers(await pending)
    expect(result[0]).toMatchObject({
      agent: CODER,
      ok: false,
      code: 'timeout',
    })
    expect(result[1]).toMatchObject({ agent: REVIEWER, ok: true })
    expect(stopped).toEqual([[CODER, chat.lastTask(coder)]])
  })

  test('a turn that could not be stopped is reported so, and the next question opens a new conversation', async () => {
    const book = peers({ stopTask: async () => false })
    const caller = await conversation()
    const pending = ask(book, caller, [CODER], { timeoutSec: 5 })
    const coder = await askedIn(CODER)
    const result = answers(await pending)[0]!
    expect(result).toMatchObject({ agent: CODER, ok: false, code: 'timeout' })
    expect(JSON.stringify(result)).toContain('没能停止它这一轮')
    // Its late answer lands in the old conversation, not the next question's.
    const next = ask(book, caller, [CODER])
    await until(() => asked(CODER).length === 2)
    const fresh = asked(CODER)[1]!
    expect(fresh).not.toBe(coder)
    chat.reply(fresh, '好')
    expect(answers(await next)[0]).toMatchObject({ ok: true, reply: '好' })
  })

  test("the node's own timeout answer also stops the turn it left running", async () => {
    const book = peers()
    const caller = await conversation()
    const pending = ask(book, caller, [CODER], { timeoutSec: 100 })
    const coder = await askedIn(CODER)
    chat.timeout(coder, true)
    expect(answers(await pending)[0]).toMatchObject({ code: 'timeout' })
    expect(stopped).toEqual([[CODER, chat.lastTask(coder)]])
  })

  test('two questions to one agent from one conversation take turns in its conversation', async () => {
    const book = peers()
    const caller = await conversation()
    const first = ask(book, caller, [CODER], { message: '第一问' })
    const second = ask(book, caller, [CODER], { message: '第二问' })
    const peer = await askedIn(CODER)
    await Bun.sleep(20)
    expect(chat.sentTo(peer)).toHaveLength(1)
    chat.reply(peer, '一')
    await until(() => chat.sentTo(peer).length === 2)
    chat.reply(peer, '二')
    expect(answers(await first)[0]).toMatchObject({ reply: '一' })
    expect(answers(await second)[0]).toMatchObject({ reply: '二' })
  })

  test('a question waiting for its turn spends its own timeout meanwhile', async () => {
    const book = peers()
    const caller = await conversation()
    const first = ask(book, caller, [CODER], { message: '第一问' })
    const second = ask(book, caller, [CODER], {
      message: '第二问',
      timeoutSec: 5,
    })
    const peer = await askedIn(CODER)
    await Bun.sleep(150)
    chat.reply(peer, '一')
    expect(answers(await first)[0]).toMatchObject({ reply: '一' })
    expect(answers(await second)[0]).toMatchObject({ code: 'timeout' })
    // It never went out: nothing to stop either.
    expect(chat.sentTo(peer)).toHaveLength(1)
    expect(stopped).toEqual([])
  })

  test('when the asking turn ends first, its questions are withdrawn: the one out is stopped, the one waiting never goes out', async () => {
    const book = peers()
    const caller = await conversation()
    // Two questions to one agent from the same turn: the second waits for
    // the first in their conversation.
    const first = ask(book, caller, [CODER], { message: '第一问' })
    const second = ask(book, caller, [CODER], { message: '第二问' })
    const peer = await askedIn(CODER)
    const started = Date.now()
    // The asking turn is stopped on its node; its answer reaches the hub.
    chat.reply(caller, '这一轮已停止', 'failed', { remoteTerminal: true })
    await until(() => stopped.length === 1, 1_000)
    expect(stopped).toEqual([[CODER, chat.lastTask(peer)]])
    expect(answers(await first)[0]).toMatchObject({
      agent: CODER,
      ok: false,
      code: 'cancelled',
    })
    expect(answers(await second)[0]).toMatchObject({ code: 'cancelled' })
    // Not the question's own 300 s (6 s here).
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(chat.sentTo(peer)).toHaveLength(1)
    expect(actions.entries.map(one => [one.outcome, one.code]).sort()).toEqual([
      ['failed', 'cancelled'],
      ['failed', 'cancelled'],
    ])
  })

  test('a withdrawn question that could not be stopped is reported so, and the next one opens a new conversation', async () => {
    const book = peers({ stopTask: async () => false })
    const caller = await conversation()
    const pending = ask(book, caller, [CODER])
    const peer = await askedIn(CODER)
    chat.reply(caller, '这一轮已停止', 'failed', { remoteTerminal: true })
    const result = answers(await pending)[0]!
    expect(result).toMatchObject({ code: 'cancelled' })
    expect(JSON.stringify(result)).toContain('没能停止')
    // A later turn of the same conversation asks again: a new conversation.
    await chat.send({ sessionId: caller, text: '再问一次' })
    const next = ask(book, caller, [CODER])
    await until(() => asked(CODER).length === 2)
    expect(asked(CODER)[1]).not.toBe(peer)
    chat.reply(asked(CODER)[1]!, '好')
    expect(answers(await next)[0]).toMatchObject({ ok: true })
  })

  test('a very long answer is cut to fit the reply', async () => {
    const book = peers()
    const caller = await conversation()
    const pending = ask(book, caller, [CODER])
    chat.reply(await askedIn(CODER), '答'.repeat(100_000))
    const [answer] = answers(await pending)
    if (!answer?.ok) throw new Error('no answer')
    expect(Buffer.byteLength(answer.reply)).toBeLessThanOrEqual(160 * 1024)
    expect(answer.reply.endsWith('（回答过长，已截断）')).toBe(true)
  })
})

describe('the call chain', () => {
  test('an asked agent that asks on extends the chain; asking back up it is refused', async () => {
    const book = peers()
    const caller = await conversation()
    const outer = ask(book, caller, [CODER])
    const peer = await askedIn(CODER)
    // CODER, answering in its conversation, asks back and asks on.
    const inner = ask(book, peer, [MAIN, REVIEWER], {}, CODER)
    const reviewer = await askedIn(REVIEWER)
    expect(chat.sentTo(reviewer)[0]!.chain).toEqual([
      { node: 'node-a', taskId: chat.lastTask(caller) },
      { node: 'node-b', taskId: chat.lastTask(peer) },
    ])
    expect(chat.sentTo(reviewer)[0]!.text.split('\n')[0]).toBe(
      `来自 ${CODER} 的提问`,
    )
    chat.reply(reviewer, '可以')
    const [back, on] = answers(await inner)
    expect(back).toMatchObject({ agent: MAIN, ok: false, code: 'cycle' })
    if (back?.ok === false) expect(back.error).toContain(MAIN)
    expect(on).toMatchObject({ agent: REVIEWER, ok: true, reply: '可以' })
    // Asking itself is the shortest cycle.
    const self = ask(book, peer, [CODER], {}, CODER)
    expect(answers(await self)[0]).toMatchObject({ code: 'cycle' })
    chat.reply(peer, '42')
    await outer
    // Once its question is answered, the conversation is no answer any more:
    // a line someone sends there later starts a chain of its own.
    await chat.send({ sessionId: peer, text: '再看看' })
    const later = ask(book, peer, [MAIN], {}, CODER)
    const main = await askedIn(MAIN)
    expect(chat.sentTo(main)[0]!.chain).toEqual([
      { node: 'node-b', taskId: chat.lastTask(peer) },
    ])
    chat.reply(main, '好')
    await later
  })

  test(`a chain ${LIMITS.maxAskChain} asks deep goes no further`, async () => {
    const book = peers()
    const order = [MAIN, CODER, REVIEWER, HELPER, OTHER]
    let session = await conversation(order[0])
    const pending: Promise<ControlOutcome>[] = []
    for (let level = 0; level < LIMITS.maxAskChain; level++) {
      pending.push(ask(book, session, [order[level + 1]!], {}, order[level]))
      session = await askedIn(order[level + 1]!)
    }
    expect(chat.sentTo(session)[0]!.chain).toHaveLength(LIMITS.maxAskChain)
    const deeper = await ask(
      book,
      session,
      [OTHER],
      {},
      order[LIMITS.maxAskChain],
    )
    expect(deeper).toMatchObject({ ok: false })
    if (!deeper.ok) expect(deeper.message).toContain('不能再往下问')
    expect(asked(OTHER)).toEqual([])
    expect(actions.entries.at(-1)).toMatchObject({
      outcome: 'refused',
      code: 'depth',
      target: `${order[LIMITS.maxAskChain]} → ${OTHER}`,
    })
    for (const target of order.slice(1, LIMITS.maxAskChain + 1).reverse())
      chat.reply(asked(target)[0]!, 'ok')
    await Promise.all(pending)
  })

  test('a busy agent on a node where the chain waits is refused at once; elsewhere it is asked', async () => {
    const book = peers()
    const caller = await conversation()
    // HELPER (node-a, where the asker runs) and CODER (node-b) both have a
    // line in flight already.
    for (const target of [HELPER, CODER]) {
      const id = await conversation(target)
      const record = chat.records.get(id)!
      chat.records.set(id, {
        ...record,
        session: { ...record.session, running: true },
      })
    }
    const pending = ask(book, caller, [HELPER, CODER])
    chat.reply(await askedIn(CODER), '42')
    const [helper, coder] = answers(await pending)
    expect(helper).toMatchObject({ ok: false, code: 'busy' })
    expect(coder).toMatchObject({ ok: true })
    expect(asked(HELPER)).toEqual([])
  })
})

/**
 * Two nodes, each with the real `NodeTurnGate`: a line sent to an agent runs
 * as a turn on its node's gate, keyed by its task, with the chain links on
 * that node — what `askReentry` passes a resident. An agent's turn does what
 * the test scripted for it, else answers at once.
 */
class TwoNodes extends FakeChat {
  readonly gates = new Map([
    ['node-a', new NodeTurnGate()],
    ['node-b', new NodeTurnGate()],
  ])
  readonly scripts = new Map<string, (sessionId: string) => Promise<void>>()

  override async send(input: ChatSendInput) {
    const sent = await super.send(input)
    if (!sent.ok) return sent
    const target = this.records.get(input.sessionId)!.session.target
    const node = target.split('/')[2]!
    const chain = (input.chain ?? [])
      .filter(link => link.node === node)
      .map(link => link.taskId)
    const script =
      this.scripts.get(target) ?? (async (id: string) => this.reply(id, '42'))
    void this.gates
      .get(node)!
      .run(() => script(input.sessionId), {
        key: sent.value.taskId!,
        ...(chain.length > 0 ? { chain } : {}),
      })
      .catch(() => {})
    return sent
  }

  idle(): boolean {
    return [...this.gates.values()].every(
      gate => !gate.active && gate.queued === 0,
    )
  }
}

describe('two nodes asking across', () => {
  test('crossing questions from two unrelated turns: one is refused busy at once, the other is answered', async () => {
    const nodes = new TwoNodes([MAIN, HELPER, CODER, REVIEWER, OTHER])
    chat = nodes
    const book = peers()
    // MAIN (node-a) asks REVIEWER (node-b) while CODER (node-b) asks HELPER
    // (node-a): each question lands behind the other node's asking turn.
    const both = Promise.withResolvers<void>()
    let started = 0
    const results = new Map<string, ControlOutcome>()
    const asker =
      (self: string, target: string) =>
      async (sessionId: string): Promise<void> => {
        if (++started === 2) both.resolve()
        await both.promise
        const outcome = await ask(
          book,
          sessionId,
          [target],
          { timeoutSec: 50 },
          self,
        )
        results.set(self, outcome)
        nodes.reply(sessionId, 'done')
      }
    nodes.scripts.set(MAIN, asker(MAIN, REVIEWER))
    nodes.scripts.set(CODER, asker(CODER, HELPER))
    await conversation(MAIN)
    await conversation(CODER)
    await until(() => results.size === 2, 5_000)
    const main = answers(results.get(MAIN)!)[0]!
    const coder = answers(results.get(CODER)!)[0]!
    // Neither waits out its timeout behind the other.
    expect([main, coder].map(one => (one.ok ? 'ok' : one.code)).sort()).toEqual(
      ['busy', 'ok'],
    )
    const refused = [main, coder].find(one => !one.ok)
    if (refused?.ok === false) expect(refused.error).toContain('稍后再问')
    expect(stopped).toEqual([])
    await until(() => nodes.idle())
  })

  test('one chain crossing nodes and back still nests', async () => {
    const nodes = new TwoNodes([MAIN, HELPER, CODER, REVIEWER, OTHER])
    chat = nodes
    const book = peers()
    let outer: ControlOutcome | undefined
    // MAIN (node-a) asks CODER (node-b), which asks HELPER back on node-a.
    nodes.scripts.set(MAIN, async sessionId => {
      outer = await ask(book, sessionId, [CODER], { timeoutSec: 50 }, MAIN)
      nodes.reply(sessionId, 'done')
    })
    nodes.scripts.set(CODER, async sessionId => {
      const inner = await ask(
        book,
        sessionId,
        [HELPER],
        { timeoutSec: 50 },
        CODER,
      )
      nodes.reply(sessionId, JSON.stringify(answers(inner)[0]))
    })
    await conversation(MAIN)
    await until(() => outer !== undefined, 5_000)
    const [answer] = answers(outer!)
    expect(answer).toMatchObject({ agent: CODER, ok: true })
    if (answer?.ok)
      expect(JSON.parse(answer.reply)).toMatchObject({
        agent: HELPER,
        ok: true,
        reply: '42',
      })
    await until(() => nodes.idle())
  })
})

describe('who may ask', () => {
  test("only a live turn of the agent's own conversation", async () => {
    const book = peers()
    const caller = await conversation()
    expect(await ask(book, caller, [CODER], {}, HELPER)).toMatchObject({
      ok: false,
      message: '会话不属于这个智能体',
    })
    chat.reply(caller, '答完了')
    expect(await ask(book, caller, [CODER])).toMatchObject({
      ok: false,
      message: '这一轮不在进行中',
    })
    expect(
      await book.handle(
        'peers.ask',
        { agents: [CODER], message: 'q', timeoutSec: 1 },
        { node: 'node-a', agent: 'main', callId: 'c' },
      ),
    ).toMatchObject({ ok: false, message: '缺少会话信息' })
    expect(chat.sent.filter(one => one.chain)).toEqual([])
  })

  test("a schedule's session and a channel group may not ask; a background worker may", async () => {
    const scheduled = await conversation()
    const group = await conversation()
    const book = peers({
      scheduled: id => id === scheduled,
      foreground: id => id !== group,
    })
    expect(await ask(book, scheduled, [CODER])).toMatchObject({
      ok: false,
      message: expect.stringContaining('定时任务的会话'),
    })
    expect(await ask(book, group, [CODER])).toMatchObject({ ok: false })
    expect(actions.entries.map(one => [one.outcome, one.code])).toEqual([
      ['refused', 'scheduled'],
      ['refused', 'foreground'],
    ])
    // A P29 worker conversation is an ordinary conversation of its agent.
    const worker = await chat.open(MAIN)
    if (!worker.ok) throw new Error('open')
    await chat.send({
      sessionId: worker.value.id,
      text: '后台任务：周报',
      background: true,
    })
    const pending = ask(book, worker.value.id, [CODER])
    chat.reply(await askedIn(CODER), '42')
    expect(answers(await pending)[0]).toMatchObject({ ok: true })
  })

  test('bad questions are refused whole; targets off the dial list one by one', async () => {
    const book = peers()
    const caller = await conversation()
    for (const bad of [
      { agents: [] },
      { agents: [CODER, CODER] },
      { agents: [CODER, REVIEWER, HELPER, OTHER, 'qianmo://x/y'] },
      { message: ' ' },
      { message: 'x'.repeat(16 * 1024 + 1) },
      { timeoutSec: 0 },
      { timeoutSec: 1801 },
      { timeoutSec: 2.5 },
    ])
      expect((await ask(book, caller, [CODER], bad)).ok).toBe(false)
    const result = answers(
      await ask(book, caller, ['qianmo://node-z/stranger', 'not an address']),
    )
    expect(result).toEqual([
      {
        agent: 'qianmo://node-z/stranger',
        ok: false,
        code: 'refused',
        error: '目标已不在对话可拨允许名单内',
      },
      {
        agent: 'not an address',
        ok: false,
        code: 'invalid',
        error: '不是有效的智能体地址',
      },
    ])
    expect(chat.opened.filter(one => one !== MAIN)).toEqual([])
  })
})

describe('audit', () => {
  test('one record per target, as the conversation owner, with the outcome and never the text', async () => {
    const book = peers()
    const caller = await conversation()
    const pending = ask(book, caller, [CODER, REVIEWER], {
      message: '机密问题：密码是多少',
      timeoutSec: 5,
    })
    chat.reply(await askedIn(CODER), '机密回答')
    await pending
    const entries = actions.entries.map(
      ({ action, subject, target, outcome, code }) => ({
        action,
        subject,
        target,
        outcome,
        code,
      }),
    )
    expect(entries).toEqual(
      expect.arrayContaining([
        {
          action: 'peer.ask',
          subject: 'legacy:admin',
          target: `${MAIN} → ${CODER}`,
          outcome: 'ok',
          code: undefined,
        },
        {
          action: 'peer.ask',
          subject: 'legacy:admin',
          target: `${MAIN} → ${REVIEWER}`,
          outcome: 'failed',
          code: 'timeout',
        },
      ]),
    )
    expect(entries).toHaveLength(2)
    expect(new Set(actions.entries.map(one => one.requestId)).size).toBe(1)
    expect(JSON.stringify(actions.entries)).not.toContain('机密')
  })

  test('a ledger that cannot be written stops the question before it goes out', async () => {
    const book = peers()
    actions.admitResult = {
      ok: false,
      failure: { code: 'unreachable', message: 'closed' },
    }
    const caller = await conversation()
    expect(await ask(book, caller, [CODER])).toMatchObject({
      ok: false,
      message: '操作记录不可写，问答暂停',
    })
    expect(asked(CODER)).toEqual([])
  })
})

describe('the roster', () => {
  test('dialable agents but the caller, with runtime, model, online, busy and a line about each', async () => {
    const status = async (node: string): Promise<unknown> =>
      node === 'node-b'
        ? {
            defaultRuntime: 'dsh',
            agents: [
              {
                agent: 'coder',
                configured: {
                  runtime: 'codex',
                  model: 'auto',
                  source: 'config',
                },
                effective: { runtime: 'codex', model: 'gpt-6-codex' },
              },
              {
                agent: 'reviewer',
                configured: { runtime: 'dsh', model: null, source: 'default' },
                effective: { runtime: 'omp' },
                // The installer's own words: for the operator, not a model.
                reason: {
                  code: 'install-failed',
                  message:
                    'npm ERR! 404 GET https://registry.npmjs.org/@deepseek-ai%2fdsh - token npm_SECRETtoken',
                },
              },
            ],
          }
        : node === 'node-c'
          ? { unexpected: true }
          : undefined
    const requests: [string, string, string][] = []
    const book = peers({
      control: {
        request: async (node, op, _args, actor) => {
          requests.push([node, op, actor])
          const value = await status(node)
          return value === undefined
            ? { ok: false, code: 'unsupported', message: '不支持此控制操作' }
            : { ok: true, value }
        },
      },
    })
    const caller = await conversation()
    const busy = await conversation(CODER)
    const record = chat.records.get(busy)!
    chat.records.set(busy, {
      ...record,
      session: { ...record.session, running: true },
    })
    const listed = await call(book, 'list', caller)
    if (!listed.ok) throw new Error(listed.message)
    const rows = (listed.value as { agents: PeerRosterRow[] }).agents
    expect(rows.map(row => row.agent)).toEqual([HELPER, CODER, REVIEWER, OTHER])
    const byAgent = new Map(rows.map(row => [row.agent, row]))
    expect(byAgent.get(CODER)).toEqual({
      agent: CODER,
      runtime: 'Codex',
      model: 'gpt-6-codex',
      online: true,
      busy: true,
      description: 'Codex 上的智能体，模型 gpt-6-codex',
    })
    expect(byAgent.get(REVIEWER)).toMatchObject({
      runtime: 'qianmopi',
      model: null,
      busy: false,
      description:
        'qianmopi 上的智能体，配置的是 DeepSeek Harness，暂用 qianmopi：安装失败',
    })
    expect(JSON.stringify(rows)).not.toContain('npm')
    // A node that said nothing usable: the row is there, the facts are not.
    expect(byAgent.get(OTHER)).toMatchObject({
      runtime: null,
      model: null,
      description: '节点 node-c 没有回报它的底层与模型',
    })
    // One `runtime.status` per node, not per agent.
    expect(requests.map(([node, op]) => `${node} ${op}`).sort()).toEqual([
      'node-a runtime.status',
      'node-b runtime.status',
      'node-c runtime.status',
    ])
  })
})
