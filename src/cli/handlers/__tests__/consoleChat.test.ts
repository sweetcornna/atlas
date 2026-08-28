// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 控制台聊天面的 host 实现：回程、允许名单、落盘。
 *
 * **零 `mock.module`**：链路是一个注入进去的接口（`ChatDialer`），注册中心是一个
 * 手写的假端口，落盘写的是真的临时文件。四种回程——ack、完成、失败、超时——都在
 * 这里各跑一遍，因为它们**不保证按顺序到**，而那正是这个模块唯一难写对的地方。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ConsoleAgent,
  ConsoleResult,
  RegisterAgentInput,
  RegistryPort,
} from '@qianmo/console'
import {
  LEGACY_MESSAGE_TYPES,
  MessageType,
  ProtocolErrorCode,
  createMessage,
  createNotify,
  type QianmoMessage,
} from '@qianmo/protocol'
import {
  createConsoleChatPort,
  normalizeChatEndpoint,
  type ChatDialer,
  type ChatLink,
  type ConsoleChatEndpoint,
  type ConsoleChatHub,
} from '../consoleChat.js'

const TARGET = 'qianmo://node-b/reviewer'
const ENDPOINT = 'ws://127.0.0.1:38612'
const OTHER = 'qianmo://node-z/stranger'
const FROM = 'qianmo://console/operator'
const PSK = 'demo-psk-that-is-long-enough-000'
const OTHER_PSK = 'other-psk-that-is-long-enough-01'

function agent(address: string, endpoint: string): ConsoleAgent {
  return {
    address,
    endpoint,
    capabilities: [],
    status: 'online',
    registeredAt: 1,
    lastHeartbeatAt: 2,
    expiresAt: 3,
  }
}

class FakeRegistry implements RegistryPort {
  listResult: ConsoleResult<readonly ConsoleAgent[]> = {
    ok: true,
    value: [agent(TARGET, ENDPOINT), agent(OTHER, 'ws://10.0.0.9:38611')],
  }

  list(): Promise<ConsoleResult<readonly ConsoleAgent[]>> {
    return Promise.resolve(this.listResult)
  }

  register(_input: RegisterAgentInput): Promise<ConsoleResult<ConsoleAgent>> {
    return Promise.resolve({
      ok: false,
      failure: { code: 'unsupported', message: 'not used here' },
    })
  }

  deregister(): Promise<ConsoleResult<void>> {
    return Promise.resolve({
      ok: false,
      failure: { code: 'unsupported', message: 'not used here' },
    })
  }

  heartbeat(): Promise<ConsoleResult<ConsoleAgent>> {
    return Promise.resolve({
      ok: false,
      failure: { code: 'unsupported', message: 'not used here' },
    })
  }
}

/** One dialled link, with the far side under the test's control. */
class FakeLink implements ChatLink {
  readonly sent: QianmoMessage[] = []
  connects = 0
  closed = false
  connectError: Error | null = null
  sendError: Error | null = null
  /** Called inside `sendAndWait`, before it resolves — the racy case. */
  duringSend: ((message: QianmoMessage) => void) | null = null

  constructor(
    readonly url: string,
    readonly reply: (message: QianmoMessage) => void,
    readonly psk: string,
  ) {}

  async connect(): Promise<void> {
    this.connects += 1
    if (this.connectError !== null) throw this.connectError
  }

  async sendAndWait(message: QianmoMessage): Promise<string> {
    this.sent.push(message)
    this.duringSend?.(message)
    if (this.sendError !== null) throw this.sendError
    return 'accepted'
  }

  isClosed(): boolean {
    return this.closed
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

class FakeDialer {
  readonly links: FakeLink[] = []
  nextConnectError: Error | null = null

  readonly dial: ChatDialer = input => {
    const link = new FakeLink(input.url, input.onReply, input.psk)
    link.connectError = this.nextConnectError
    this.links.push(link)
    return link
  }

  get last(): FakeLink {
    const link = this.links[this.links.length - 1]
    if (link === undefined) throw new Error('no link was dialled')
    return link
  }
}

interface Harness {
  readonly hub: ConsoleChatHub
  readonly registry: FakeRegistry
  readonly dialer: FakeDialer
  readonly storePath: string
  readonly updates: { sessionId: string; revision: number }[]
  advance(ms: number): void
}

let directory: string
let created: ConsoleChatHub[] = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-console-chat-'))
  created = []
})

afterEach(async () => {
  for (const hub of created) await hub.close()
  rmSync(directory, { recursive: true, force: true })
})

function harness(
  options: {
    readonly storePath?: string
    readonly endpoints?: readonly (string | ConsoleChatEndpoint)[]
    readonly taskTtlMs?: number
    readonly registry?: FakeRegistry
  } = {},
): Harness {
  const registry = options.registry ?? new FakeRegistry()
  const dialer = new FakeDialer()
  const storePath = options.storePath ?? join(directory, 'chat.ndjson')
  let clock = 1_700_000_000_000
  let counter = 0
  const updates: { sessionId: string; revision: number }[] = []

  const hub = createConsoleChatPort({
    from: FROM,
    endpoints: (options.endpoints ?? [ENDPOINT]).map(one =>
      typeof one === 'string' ? { url: one, psk: PSK } : one,
    ),
    storePath,
    registry,
    dial: dialer.dial,
    now: () => clock,
    newId: () => `id-${(counter += 1)}`,
    ...(options.taskTtlMs === undefined
      ? {}
      : { taskTtlMs: options.taskTtlMs }),
  })
  created.push(hub)
  hub.subscribe(update => updates.push({ ...update }))

  return {
    hub,
    registry,
    dialer,
    storePath,
    updates,
    advance: ms => {
      clock += ms
    },
  }
}

function taskResult(request: QianmoMessage, payload: unknown): QianmoMessage {
  return createMessage({
    from: TARGET,
    to: FROM,
    type: MessageType.TaskResult,
    taskId: request.taskId,
    payload,
  })
}

async function openAndSend(
  h: Harness,
  text = '看一下速率表',
): Promise<{ sessionId: string; request: QianmoMessage }> {
  const opened = await h.hub.open(TARGET)
  if (!opened.ok) throw new Error(opened.failure.message)
  const sent = await h.hub.send({ sessionId: opened.value.id, text })
  if (!sent.ok) throw new Error(sent.failure.message)
  return {
    sessionId: opened.value.id,
    request: h.dialer.last.sent[0] as QianmoMessage,
  }
}

describe('chat endpoint normalisation', () => {
  test('folds the trailing slash and refuses anything that is not ws', () => {
    expect(normalizeChatEndpoint('ws://127.0.0.1:38612')).toBe(
      'ws://127.0.0.1:38612/',
    )
    expect(normalizeChatEndpoint('ws://127.0.0.1:38612/')).toBe(
      'ws://127.0.0.1:38612/',
    )
    expect(normalizeChatEndpoint('http://127.0.0.1:38612')).toBeNull()
    expect(normalizeChatEndpoint('qianmo://node-b/reviewer')).toBeNull()
    expect(normalizeChatEndpoint('not a url')).toBeNull()
  })
})

describe('chat targets', () => {
  test('lists everybody the registry knows and says who may be dialled', async () => {
    const h = harness()
    const targets = await h.hub.targets()
    if (!targets.ok) throw new Error('unreachable')

    expect(targets.value.map(target => target.address)).toEqual([TARGET, OTHER])
    // 名字从注册中心来（发现），能不能拨从启动参数来（授权）。
    expect(targets.value[0]?.dialable).toBe(true)
    expect(targets.value[1]?.dialable).toBe(false)
    expect(targets.value[0]?.agent).toBe('reviewer')
    expect(targets.value[0]?.node).toBe('node-b')
  })

  test('passes a registry outage through as a failure', async () => {
    const h = harness()
    h.registry.listResult = {
      ok: false,
      failure: { code: 'unreachable', message: '注册中心不可达' },
    }
    expect(await h.hub.targets()).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
  })
})

describe('chat sessions', () => {
  test('refuses a target that is not an address', async () => {
    const h = harness()
    expect(await h.hub.open('node-b/reviewer')).toMatchObject({
      ok: false,
      failure: { code: 'invalid' },
    })
  })

  test('opens, lists and reads back an empty session', async () => {
    const h = harness()
    const opened = await h.hub.open(TARGET)
    if (!opened.ok) throw new Error('unreachable')
    expect(opened.value).toMatchObject({
      target: TARGET,
      node: 'node-b',
      agent: 'reviewer',
      turnCount: 0,
      preview: '',
    })

    const listed = await h.hub.sessions()
    if (!listed.ok) throw new Error('unreachable')
    expect(listed.value).toHaveLength(1)

    const transcript = await h.hub.transcript(opened.value.id)
    if (!transcript.ok) throw new Error('unreachable')
    expect(transcript.value.turns).toEqual([])
  })

  test('answers a session it has never heard of with not_found', async () => {
    const h = harness()
    expect(await h.hub.transcript('nope')).toMatchObject({
      ok: false,
      failure: { code: 'not_found' },
    })
    expect(await h.hub.send({ sessionId: 'nope', text: 'x' })).toMatchObject({
      ok: false,
      failure: { code: 'not_found' },
    })
  })
})

describe('chat send', () => {
  test('sends a task.request and records the receipt on the operator turn', async () => {
    const h = harness()
    const opened = await h.hub.open(TARGET)
    if (!opened.ok) throw new Error('unreachable')

    h.advance(0)
    const sent = await h.hub.send({ sessionId: opened.value.id, text: '你好' })
    if (!sent.ok) throw new Error(sent.failure.message)

    const request = h.dialer.last.sent[0]
    expect(request?.type).toBe(MessageType.TaskRequest)
    expect(request?.from).toBe(FROM)
    expect(request?.to).toBe(TARGET)
    expect(request?.payload).toEqual({ prompt: '你好' })
    // §6.3 call site 1：发起方把自己写进 hops[0]，否则审计链没有头。
    expect(request?.hops).toEqual(['console'])

    expect(sent.value).toMatchObject({
      author: 'operator',
      state: 'delivered',
      receipt: 'accepted',
      taskId: request?.taskId,
    })
  })

  test('refuses a target whose endpoint is off the allow list', async () => {
    const h = harness()
    const opened = await h.hub.open(OTHER)
    if (!opened.ok) throw new Error('unreachable')
    const sent = await h.hub.send({ sessionId: opened.value.id, text: '你好' })

    expect(sent).toMatchObject({ ok: false, failure: { code: 'rejected' } })
    // 注册中心没有鉴权，所以「它说端点在那儿」不是拨过去的理由。
    expect(h.dialer.links).toHaveLength(0)
  })

  test('a turn carries its session id as the context id', async () => {
    // 一个字段两件事：常驻侧据它分 ACP 会话（多轮上下文），节点发 notify 时也
    // 只能靠它归组——notify 每条自带全新 taskId，归不到会话就只能丢。
    const h = harness()
    const first = await h.hub.open(TARGET)
    if (!first.ok) throw new Error('unreachable')
    await h.hub.send({ sessionId: first.value.id, text: '一' })
    await h.hub.send({ sessionId: first.value.id, text: '二' })

    const sent = h.dialer.last.sent
    expect(sent).toHaveLength(2)
    // 同一条会话的两轮共用一个上下文；taskId 每轮都不同。
    expect(sent[0]?.contextId).toBe(first.value.id)
    expect(sent[1]?.contextId).toBe(first.value.id)
    expect(sent[0]?.taskId).not.toBe(sent[1]?.taskId)

    const second = await h.hub.open(TARGET)
    if (!second.ok) throw new Error('unreachable')
    await h.hub.send({ sessionId: second.value.id, text: '三' })
    expect(h.dialer.last.sent[2]?.contextId).toBe(second.value.id)
    expect(second.value.id).not.toBe(first.value.id)
  })

  test('a named endpoint only serves the node it was authorised for', async () => {
    // 注册中心零鉴权：它完全可以说 node-z 的 agent 就在 node-b 的端点上。绑定让
    // 那条被改过的记录拨不动——否则它等于把 node-b 的钥匙借给了任何一个名字。
    const registry = new FakeRegistry()
    registry.listResult = {
      ok: true,
      value: [agent(TARGET, ENDPOINT), agent(OTHER, ENDPOINT)],
    }
    const h = harness({
      registry,
      endpoints: [{ url: ENDPOINT, psk: PSK, node: 'node-b' }],
    })

    const targets = await h.hub.targets()
    if (!targets.ok) throw new Error('unreachable')
    expect(targets.value.map(one => [one.address, one.dialable])).toEqual([
      [TARGET, true],
      [OTHER, false],
    ])

    const opened = await h.hub.open(OTHER)
    if (!opened.ok) throw new Error('unreachable')
    const sent = await h.hub.send({ sessionId: opened.value.id, text: '你好' })
    expect(sent).toMatchObject({ ok: false, failure: { code: 'rejected' } })
    if (sent.ok) throw new Error('unreachable')
    // 「不在名单里」与「在名单里但绑给了别人」是两句不同的话。
    expect(sent.failure.message).toContain('在允许名单里是 node-b 的端点')
    expect(sent.failure.message).toContain('--chat-url node-z=')
    expect(h.dialer.links).toHaveLength(0)
  })

  test('each endpoint is dialled with its own key', async () => {
    const registry = new FakeRegistry()
    registry.listResult = {
      ok: true,
      value: [agent(TARGET, ENDPOINT), agent(OTHER, 'ws://10.0.0.9:38611')],
    }
    const h = harness({
      registry,
      endpoints: [
        { url: ENDPOINT, psk: PSK, node: 'node-b' },
        { url: 'ws://10.0.0.9:38611', psk: OTHER_PSK, node: 'node-z' },
      ],
    })

    const first = await h.hub.open(TARGET)
    if (!first.ok) throw new Error('unreachable')
    await h.hub.send({ sessionId: first.value.id, text: '一' })
    expect(h.dialer.last.psk).toBe(PSK)

    const second = await h.hub.open(OTHER)
    if (!second.ok) throw new Error('unreachable')
    await h.hub.send({ sessionId: second.value.id, text: '二' })
    expect(h.dialer.last.psk).toBe(OTHER_PSK)
  })

  test('refuses a target the registry does not have', async () => {
    const h = harness()
    const opened = await h.hub.open('qianmo://node-q/ghost')
    if (!opened.ok) throw new Error('unreachable')
    expect(
      await h.hub.send({ sessionId: opened.value.id, text: '你好' }),
    ).toMatchObject({ ok: false, failure: { code: 'not_found' } })
  })

  test('refuses an empty message before it reaches the router', async () => {
    const h = harness()
    const opened = await h.hub.open(TARGET)
    if (!opened.ok) throw new Error('unreachable')
    expect(
      await h.hub.send({ sessionId: opened.value.id, text: '   ' }),
    ).toMatchObject({ ok: false, failure: { code: 'invalid' } })
  })

  test('marks the turn failed and drops the link when the dial fails', async () => {
    const h = harness()
    h.dialer.nextConnectError = new Error('ECONNREFUSED')
    const opened = await h.hub.open(TARGET)
    if (!opened.ok) throw new Error('unreachable')

    const sent = await h.hub.send({ sessionId: opened.value.id, text: '你好' })
    expect(sent).toMatchObject({ ok: false, failure: { code: 'unreachable' } })
    // 连不上的 client 自己还在退避重连，丢引用而不 close 就是漏一条循环。
    expect(h.dialer.last.closed).toBe(true)

    const transcript = await h.hub.transcript(opened.value.id)
    if (!transcript.ok) throw new Error('unreachable')
    expect(transcript.value.turns[0]?.state).toBe('failed')
  })

  test('reuses one link for a second message to the same endpoint', async () => {
    const h = harness()
    const opened = await h.hub.open(TARGET)
    if (!opened.ok) throw new Error('unreachable')
    await h.hub.send({ sessionId: opened.value.id, text: '一' })
    await h.hub.send({ sessionId: opened.value.id, text: '二' })
    expect(h.dialer.links).toHaveLength(1)
    expect(h.dialer.last.connects).toBe(1)
  })
})

describe('chat reply path', () => {
  test('ack marks the turn read, task.result appends the answer', async () => {
    const h = harness()
    const { sessionId, request } = await openAndSend(h)
    const link = h.dialer.last

    h.advance(1_200)
    link.reply(
      createMessage({
        from: TARGET,
        to: FROM,
        type: MessageType.Ack,
        taskId: request.taskId,
        payload: { acceptedAt: 1 },
      }),
    )

    h.advance(2_800)
    link.reply(
      taskResult(request, {
        outcome: 'completed',
        content: '速率表在 packages/router/src/rate.ts',
        completedAt: 2,
      }),
    )

    const transcript = await h.hub.transcript(sessionId)
    if (!transcript.ok) throw new Error('unreachable')
    const [ask, answer] = transcript.value.turns
    expect(ask).toMatchObject({
      author: 'operator',
      state: 'read',
      readMs: 1_200,
    })
    expect(answer).toMatchObject({
      author: 'agent',
      state: 'done',
      text: '速率表在 packages/router/src/rate.ts',
      elapsedMs: 4_000,
      taskId: request.taskId,
    })
    // 每一次变化都通知一次订阅者，revision 单调递增。
    expect(h.updates.length).toBeGreaterThanOrEqual(4)
    expect(h.updates.at(-1)?.sessionId).toBe(sessionId)
  })

  test('a notify lands in the transcript as a notice, grouped by contextId', async () => {
    const h = harness()
    const { sessionId, request } = await openAndSend(h)
    const link = h.dialer.last

    h.advance(400)
    link.reply(
      createNotify({
        from: TARGET,
        to: FROM,
        // 归组只认这个，而不是 taskId——notify 每条都带一个全新的。
        contextId: sessionId,
        payload: {
          kind: 'task',
          severity: 'info',
          summary: '读了 packages/router/src/rate.ts',
          observedAt: 1,
          detail: '命中 3 处',
        },
      }),
    )

    const transcript = await h.hub.transcript(sessionId)
    if (!transcript.ok) throw new Error('unreachable')
    expect(transcript.value.turns[1]).toMatchObject({
      author: 'agent',
      variant: 'notice',
      severity: 'info',
      state: 'done',
      text: '读了 packages/router/src/rate.ts',
      detail: '命中 3 处',
    })
    // 操作者那一轮还在等它自己的回复，没被这条过程推进。
    expect(transcript.value.turns[0]).toMatchObject({
      author: 'operator',
      state: 'delivered',
      taskId: request.taskId,
    })
  })

  test('a notify for a session this console does not have is dropped', async () => {
    const h = harness()
    const { sessionId } = await openAndSend(h)
    h.dialer.last.reply(
      createNotify({
        from: TARGET,
        to: FROM,
        contextId: 'a-session-from-some-other-process',
        payload: {
          kind: 'task',
          severity: 'warn',
          summary: '不该出现在任何转录里',
          observedAt: 1,
        },
      }),
    )

    const transcript = await h.hub.transcript(sessionId)
    if (!transcript.ok) throw new Error('unreachable')
    expect(transcript.value.turns).toHaveLength(1)
  })

  test('the dialled link declares notify, or the node sends none', async () => {
    // 少了这句声明，常驻侧按能力发现判定这个对端不实现 notify，一条都不发——
    // 而且两边日志都不会说为什么。
    const dialled: Array<readonly string[] | undefined> = []
    const hub = createConsoleChatPort({
      from: FROM,
      endpoints: [{ url: ENDPOINT, psk: PSK }],
      storePath: join(directory, 'declares.ndjson'),
      registry: new FakeRegistry(),
      dial: input => {
        dialled.push(input.supportedTypes)
        return new FakeLink(input.url, input.onReply, input.psk)
      },
    })
    created.push(hub)
    const opened = await hub.open(TARGET)
    if (!opened.ok) throw new Error('unreachable')
    await hub.send({ sessionId: opened.value.id, text: '你好' })

    expect(dialled[0]).toEqual([...LEGACY_MESSAGE_TYPES, MessageType.Notify])
    // floor 那一段不是新承诺（不声明时对面就按它假设）；新增的只有这一条。
    expect(LEGACY_MESSAGE_TYPES).not.toContain(MessageType.Notify)
  })

  test('a failed task.result becomes a failed agent turn carrying the code', async () => {
    const h = harness()
    const { sessionId, request } = await openAndSend(h)
    h.dialer.last.reply(
      taskResult(request, {
        outcome: 'failed',
        code: ProtocolErrorCode.E_TASK_FAILED,
        reason: '模型没有返回内容',
        completedAt: 2,
      }),
    )

    const transcript = await h.hub.transcript(sessionId)
    if (!transcript.ok) throw new Error('unreachable')
    expect(transcript.value.turns[1]).toMatchObject({
      author: 'agent',
      state: 'failed',
      code: ProtocolErrorCode.E_TASK_FAILED,
      text: '模型没有返回内容',
    })
  })

  test('an error reply settles the task the same way', async () => {
    const h = harness()
    const { sessionId, request } = await openAndSend(h)
    h.dialer.last.reply(
      createMessage({
        from: TARGET,
        to: FROM,
        type: MessageType.Error,
        taskId: request.taskId,
        payload: {
          code: ProtocolErrorCode.E_UNKNOWN_AGENT,
          reason: '这个节点上没有 reviewer',
        },
      }),
    )
    const transcript = await h.hub.transcript(sessionId)
    if (!transcript.ok) throw new Error('unreachable')
    expect(transcript.value.turns[1]).toMatchObject({
      state: 'failed',
      code: ProtocolErrorCode.E_UNKNOWN_AGENT,
    })
  })

  test('a reply that lands inside sendAndWait is not overwritten by the receipt', async () => {
    // 本机回环上 task.result 完全可能先于回执落地；状态只升不降就是为了这个。
    const h = harness()
    const opened = await h.hub.open(TARGET)
    if (!opened.ok) throw new Error('unreachable')

    // The first send is what dials the link; arm the far side on it, then send
    // again so the ack lands *inside* `sendAndWait` for the second turn.
    await h.hub.send({ sessionId: opened.value.id, text: '第一句' })
    const link = h.dialer.last
    link.duringSend = message => {
      link.reply(
        createMessage({
          from: TARGET,
          to: FROM,
          type: MessageType.Ack,
          taskId: message.taskId,
          payload: { acceptedAt: 1 },
        }),
      )
    }
    await h.hub.send({ sessionId: opened.value.id, text: '第二句' })

    const transcript = await h.hub.transcript(opened.value.id)
    if (!transcript.ok) throw new Error('unreachable')
    const second = transcript.value.turns[1]
    expect(second?.state).toBe('read')
    // 回执仍然记下来了，只是没有把状态降回 delivered。
    expect(second?.receipt).toBe('accepted')
  })

  test('drops a reply whose task nobody is waiting for', async () => {
    const h = harness()
    const { sessionId, request } = await openAndSend(h)
    h.dialer.last.reply(
      taskResult(request, {
        outcome: 'completed',
        content: '第一份',
        completedAt: 2,
      }),
    )
    // 重放/重复的第二份不该再追加一轮。
    h.dialer.last.reply(
      taskResult(request, {
        outcome: 'completed',
        content: '第二份',
        completedAt: 3,
      }),
    )

    const transcript = await h.hub.transcript(sessionId)
    if (!transcript.ok) throw new Error('unreachable')
    expect(transcript.value.turns).toHaveLength(2)
    expect(transcript.value.turns[1]?.text).toBe('第一份')
  })

  test('gives up locally when nothing comes back at all', async () => {
    const h = harness({ taskTtlMs: 20 })
    const { sessionId } = await openAndSend(h)
    await Bun.sleep(90)

    const transcript = await h.hub.transcript(sessionId)
    if (!transcript.ok) throw new Error('unreachable')
    // 永远停在「已投递」是所有状态里最像「还在想」的一个。
    expect(transcript.value.turns[0]?.state).toBe('failed')
    expect(transcript.value.turns[1]).toMatchObject({
      author: 'agent',
      state: 'failed',
      code: 'E_TASK_TIMEOUT',
    })
  })
})

describe('chat persistence', () => {
  test('a restarted console still has the conversation', async () => {
    const storePath = join(directory, 'restart.ndjson')
    const first = harness({ storePath })
    const { sessionId, request } = await openAndSend(first, '重启前问的')
    first.dialer.last.reply(
      taskResult(request, {
        outcome: 'completed',
        content: '重启前答的',
        completedAt: 2,
      }),
    )
    await first.hub.close()

    const second = harness({ storePath })
    const listed = await second.hub.sessions()
    if (!listed.ok) throw new Error('unreachable')
    expect(listed.value).toHaveLength(1)
    expect(listed.value[0]?.turnCount).toBe(2)
    expect(listed.value[0]?.preview).toBe('重启前答的')

    const transcript = await second.hub.transcript(sessionId)
    if (!transcript.ok) throw new Error('unreachable')
    expect(transcript.value.turns.map(turn => turn.text)).toEqual([
      '重启前问的',
      '重启前答的',
    ])
    // 同一轮改了几次就写了几行，重放时后写的那行赢。
    const lines = readFileSync(storePath, 'utf8').trim().split('\n')
    expect(lines.length).toBeGreaterThan(3)
  })

  test('a torn line costs that line, not the transcript', async () => {
    const storePath = join(directory, 'torn.ndjson')
    const first = harness({ storePath })
    await openAndSend(first, '完整的一句')
    await first.hub.close()

    Bun.write(storePath, `${readFileSync(storePath, 'utf8')}{"kind":"turn"`)
    const second = harness({ storePath })
    const listed = await second.hub.sessions()
    if (!listed.ok) throw new Error('unreachable')
    expect(listed.value).toHaveLength(1)
    expect(listed.value[0]?.preview).toBe('完整的一句')
  })
})

describe('chat teardown', () => {
  test('close drops the links and the subscriptions', async () => {
    const h = harness()
    await openAndSend(h)
    const link = h.dialer.last
    await h.hub.close()
    expect(link.closed).toBe(true)
  })
})
