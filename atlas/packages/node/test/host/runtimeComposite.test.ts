// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sessions follow their agent's runtime turn by turn (P36.4), and the portable
 * transcript carries a conversation across a runtime change (§6.3): the first
 * turn on the new runtime opens with a 「前情」 block, later ones do not.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import {
  OmpResidentTurnPort,
  type OmpPromptAdmission,
  type OmpRpcChannel,
  type OmpRpcFrame,
  type ResidentAgentSession,
} from '@qianmo/resident'
import {
  type ExternalSessionPool,
  type OmpSessionPool,
  ResidentRuntimePool,
} from '../../src/host/runtimes/composite.js'
import {
  appendPortableTurn,
  clipText,
  PORTABLE_LOG_MAX_BYTES,
  PORTABLE_PREAMBLE_MAX_BYTES,
  type PortableTurn,
  portableChannel,
  portableLogPath,
  portablePreamble,
  readPortableTurns,
} from '../../src/host/runtimes/portableLog.js'
import { isolatedRoot } from '../providers/fake.js'

let root: ReturnType<typeof isolatedRoot>
beforeEach(() => {
  root = isolatedRoot()
})
afterEach(() => root.dispose())

/** A runtime child that answers every prompt with one tool call and a line. */
class FakeChannel implements OmpRpcChannel {
  readonly prompts: string[] = []
  readonly closed: Promise<void>
  readonly #listeners = new Set<(frame: OmpRpcFrame) => void>()
  readonly #close: () => void
  constructor(
    readonly name: string,
    /** The input reached the runtime's transcript (crash recovery reads it). */
    readonly admitted: (messageId: string) => void = () => {},
  ) {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.closed = promise
    this.#close = resolve
  }
  onFrame(listener: (frame: OmpRpcFrame) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  #emit(frame: OmpRpcFrame): void {
    for (const listener of [...this.#listeners]) listener(frame)
  }
  async prompt(input: {
    messageId: string
    text: string
  }): Promise<OmpPromptAdmission> {
    this.prompts.push(input.text)
    this.admitted(input.messageId)
    const id = randomUUID()
    queueMicrotask(() => {
      this.#emit({
        type: 'message_end',
        message: {
          role: 'user',
          content: [{ type: 'text', text: input.text }],
        },
      })
      this.#emit({
        type: 'tool_execution_start',
        toolCallId: 't1',
        toolName: 'read',
        args: {},
      })
      this.#emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: `${this.name} 的回答 ${this.prompts.length}`,
            },
          ],
        },
      })
      this.#emit({ type: 'prompt_result', id, status: 'completed' })
    })
    return { requestId: id, agentInvoked: true }
  }
  async abort(): Promise<void> {}
  /** The process exits. */
  exit(): void {
    this.#close()
  }
}

class FakePool
  implements OmpSessionPool<FakeChannel>, ExternalSessionPool<FakeChannel>
{
  readonly channels = new Map<string, FakeChannel>()
  readonly opened: string[] = []
  readonly invalidated: string[] = []
  readonly closedSessions: string[] = []
  readonly accepted = new Set<string>()
  readonly owners = new Map<string, string>()
  readonly closed = new Promise<void>(() => {})
  readonly parkedReason = undefined
  readonly alive = true
  constructor(
    readonly name: string,
    readonly agents: readonly string[],
  ) {}
  isStable(): boolean {
    return true
  }
  hasAgent(agent: string): boolean {
    return this.agents.includes(agent)
  }
  owner(sessionId: string): { agent: string } | undefined {
    const agent = this.owners.get(sessionId)
    return agent === undefined ? undefined : { agent }
  }
  async initialize(): Promise<void> {}
  async newSession(input: ResidentAgentSession): Promise<string> {
    const sessionId = randomUUID()
    await this.resumeSession({ ...input, sessionId })
    return sessionId
  }
  async resumeSession(
    input: ResidentAgentSession & { sessionId: string },
  ): Promise<void> {
    this.opened.push(input.sessionId)
    this.owners.set(input.sessionId, input.agent)
  }
  closeSession(sessionId: string): void {
    this.closedSessions.push(sessionId)
  }
  async invalidateAgent(agent: string): Promise<void> {
    this.invalidated.push(agent)
  }
  async channelFor(sessionId: string): Promise<FakeChannel> {
    let channel = this.channels.get(sessionId)
    if (channel === undefined) {
      channel = new FakeChannel(this.name, id => this.accepted.add(id))
      this.channels.set(sessionId, channel)
    }
    return channel
  }
  async isAccepted(_sessionId: string, messageId: string): Promise<boolean> {
    return this.accepted.has(messageId)
  }
  async stop(): Promise<void> {}
}

function setup() {
  const where = new Map<string, string>([['coder', 'omp']])
  const omp = new FakePool('qianmopi', ['coder'])
  const external = new FakePool('dsh', ['coder'])
  const errors: unknown[] = []
  const pool = new ResidentRuntimePool(omp, external, {
    runtimeOf: agent => where.get(agent) ?? 'omp',
    onError: error => errors.push(error),
  })
  const port = new OmpResidentTurnPort(pool, {})
  let count = 0
  const turn = async (sessionId: string, prompt: string) =>
    port.execute(
      {
        sessionId,
        messageId: `m-${++count}`,
        prompt,
        networkMsgId: `net-${count}`,
        agent: 'coder',
      },
      async () => {},
    )
  return { where, omp, external, pool, turn, errors }
}

test('each turn goes to the pool of the runtime its agent is on now; the first after a change carries 「前情」', async () => {
  const { where, omp, external, pool, turn, errors } = setup()
  const session = await pool.newSession({ agent: 'coder', cwd: root.root })
  expect(omp.opened).toEqual([session])
  expect(external.opened).toEqual([])

  expect(await turn(session, '看一下 README')).toMatchObject({
    outcome: 'completed',
    content: 'qianmopi 的回答 1',
  })
  expect(omp.channels.get(session)!.prompts).toEqual(['看一下 README'])

  // dsh installed: the agent moves; the next turn is dsh's, with what came before.
  where.set('coder', 'dsh')
  await pool.invalidateAgent('coder')
  expect(omp.invalidated).toEqual(['coder'])
  expect(external.invalidated).toEqual(['coder'])
  expect(await turn(session, '接着改')).toMatchObject({
    outcome: 'completed',
    content: 'dsh 的回答 1',
  })
  expect(external.opened).toEqual([session])
  const moved = external.channels.get(session)!.prompts[0]!
  expect(moved).toStartWith(
    '「前情」这段对话之前在 qianmopi 上进行，现在换到了 DeepSeek Harness',
  )
  expect(moved).toContain('[qianmopi] 用户：看一下 README')
  expect(moved).toContain('[qianmopi] 回答：qianmopi 的回答 1')
  expect(moved).toContain('[qianmopi] 工具：read')
  expect(moved).toEndWith('「前情」完。下面是这一轮的消息：\n\n接着改')

  // Same runtime again: native from here on.
  await turn(session, '再来')
  expect(external.channels.get(session)!.prompts[1]).toBe('再来')

  // Back to qianmopi (a fallback, say): it hears about the dsh turns.
  where.set('coder', 'omp')
  await turn(session, '回来了')
  const back = omp.channels.get(session)!.prompts[1]!
  expect(back).toContain('现在换到了 qianmopi')
  expect(back).toContain('[DeepSeek Harness] 用户：再来')
  expect(back).toContain('[DeepSeek Harness] 回答：dsh 的回答 2')
  // Its own earlier turn is in its conversation already: not carried again.
  expect(back).not.toContain('看一下 README')
  expect(back).toEndWith('回来了')
  // Re-opened in the omp pool only once per move.
  expect(omp.opened).toEqual([session, session])

  const file = portableLogPath('coder', session)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(readPortableTurns(file).map(one => [one.runtime, one.user])).toEqual([
    ['omp', '看一下 README'],
    ['dsh', '接着改'],
    ['dsh', '再来'],
    ['omp', '回来了'],
  ])
  // The record keeps the user's text, not the block in front of it.
  expect(readFileSync(file, 'utf8')).not.toContain('「前情」')
  expect(errors).toEqual([])
})

test('close and crash recovery look at both pools', async () => {
  const { omp, external, pool } = setup()
  const session = await pool.newSession({ agent: 'coder', cwd: root.root })
  external.accepted.add('m-dsh')
  omp.accepted.add('m-omp')
  expect(await pool.isAccepted(session, 'm-dsh')).toBe(true)
  expect(await pool.isAccepted(session, 'm-omp')).toBe(true)
  expect(await pool.isAccepted(session, 'm-none')).toBe(false)
  pool.closeSession(session)
  expect(omp.closedSessions).toEqual([session])
  expect(external.closedSessions).toEqual([session])
})

test('a session from an earlier generation is found by its owner and routed the same way', async () => {
  const { where, external, pool, turn } = setup()
  external.owners.set('old-session', 'coder')
  where.set('coder', 'dsh')
  await turn('old-session', '还记得吗')
  expect(external.channels.get('old-session')!.prompts).toEqual(['还记得吗'])
})

test('local commands pass through untouched and leave no record', async () => {
  const channel = new FakeChannel('qianmopi')
  const file = portableLogPath('coder', 's1')
  appendPortableTurn(file, turnOf('dsh', 'earlier', 'answer'))
  const wrapped = portableChannel(channel, { file, runtime: 'omp' })
  await wrapped.prompt({ messageId: 'm', text: '/compact' })
  expect(channel.prompts).toEqual(['/compact'])
  await Promise.resolve()
  expect(readPortableTurns(file)).toHaveLength(1)
  // Everything else is the channel's own.
  expect(wrapped.closed).toBe(channel.closed)
})

test('a process gone mid-turn still records the question', async () => {
  const channel = new FakeChannel('dsh')
  channel.prompt = async () => ({ requestId: 'r', agentInvoked: true })
  const file = portableLogPath('coder', 's2')
  const wrapped = portableChannel(channel, { file, runtime: 'dsh' })
  await wrapped.prompt({ messageId: 'm', text: '做到一半' })
  channel.exit()
  await channel.closed
  await Promise.resolve()
  expect(readPortableTurns(file)).toMatchObject([
    { runtime: 'dsh', user: '做到一半', answer: '', status: 'error' },
  ])
})

test('a warm process keeps one close listener however many turns it runs', async () => {
  const channel = new FakeChannel('dsh')
  let listeners = 0
  const then = channel.closed.then.bind(channel.closed)
  Object.defineProperty(channel.closed, 'then', {
    value: (...args: Parameters<typeof then>) => {
      listeners += 1
      return then(...args)
    },
  })
  const file = portableLogPath('coder', 's3')
  const wrapped = portableChannel(channel, { file, runtime: 'dsh' })
  for (let i = 0; i < 5; i++) {
    await wrapped.prompt({ messageId: `m${i}`, text: `第 ${i} 问` })
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  expect(readPortableTurns(file)).toHaveLength(5)
  expect(listeners).toBe(1)
})

function turnOf(
  runtime: string,
  user: string,
  answer: string,
  at = 0,
): PortableTurn {
  return {
    v: 1,
    at,
    runtime,
    messageId: `m-${at}`,
    user,
    answer,
    status: 'completed',
  }
}

test('a runtime that continues its conversation hears only the turns after its last one in it; a new one hears them all', () => {
  const turns = [
    turnOf('codex', '一', '答一', 10),
    turnOf('dsh', '二', '答二', 20),
    turnOf('codex', '三', '答三', 30),
    turnOf('dsh', '四', '答四', 40),
  ]
  const carried = (since?: number) => {
    const text = portablePreamble(turns, 'codex', undefined, since) ?? ''
    return ['一', '二', '三', '四'].filter(user =>
      text.includes(`用户：${user}`),
    )
  }
  // Its conversation began before turn three: turn four is all it missed.
  expect(carried(0)).toEqual(['四'])
  expect(carried(30)).toEqual(['四'])
  // Begun after its turns there (a new conversation): everything.
  expect(carried(31)).toEqual(['一', '二', '三', '四'])
  expect(carried(undefined)).toEqual(['一', '二', '三', '四'])
  // Nothing missed: no block at all.
  expect(
    portablePreamble(turns.slice(0, 3), 'codex', undefined, 0),
  ).toBeUndefined()
  // A turn whose process went away there is not taken for one it has.
  const lost = [
    ...turns.slice(0, 3),
    { ...turnOf('codex', '五', '', 35), status: 'error' as const },
    turnOf('dsh', '六', '答六', 50),
  ]
  const text = portablePreamble(lost, 'codex', undefined, 0) ?? ''
  expect(
    ['一', '二', '三', '五', '六'].filter(user =>
      text.includes(`用户：${user}`),
    ),
  ).toEqual(['五', '六'])
})

test('the transcript keeps the newest 64 KiB; the preamble the newest turns that fit in 12 KiB', () => {
  const file = portableLogPath('coder', 's3')
  const big = '甲'.repeat(3000)
  for (let i = 0; i < 40; i++)
    appendPortableTurn(
      file,
      turnOf(i % 2 ? 'dsh' : 'omp', `第 ${i} 轮 ${big}`, `答 ${i} ${big}`, i),
    )
  expect(statSync(file).size).toBeLessThanOrEqual(PORTABLE_LOG_MAX_BYTES)
  const turns = readPortableTurns(file)
  expect(turns.at(-1)!.at).toBe(39)
  expect(turns.length).toBeLessThan(40)
  expect(turns.map(one => one.at)).toEqual(
    [...turns.keys()].map(i => 40 - turns.length + i),
  )
  const preamble = portablePreamble(turns, 'claude-code')!
  expect(Buffer.byteLength(preamble)).toBeLessThanOrEqual(
    PORTABLE_PREAMBLE_MAX_BYTES,
  )
  expect(preamble).toContain('第 39 轮')
  expect(preamble).not.toContain('第 30 轮')
  expect(preamble.indexOf('第 38 轮')).toBeLessThan(
    preamble.indexOf('第 39 轮'),
  )
  expect(preamble).toContain('现在换到了 Claude Code')
  expect(portablePreamble([], 'dsh')).toBeUndefined()
})

test('clipping keeps both ends and never splits a character', () => {
  const text = `开头${'中'.repeat(5000)}结尾`
  const clipped = clipText(text, 1000)
  expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(1000)
  expect(clipped).toStartWith('开头')
  expect(clipped).toEndWith('结尾')
  expect(clipped).not.toContain('�')
  expect(clipText('short', 1000)).toBe('short')
})
