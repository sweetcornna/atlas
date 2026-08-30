// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 边界类 ①：触发时机（`protocol.md` §8.3）。
 *
 * 这一类问的都是同一件事：**消息到得比对面准备好要早，会怎样。**
 *
 * | §8.3 的行 | 这里怎么测 |
 * |---|---|
 * | 目标休眠、需要先唤醒 | 目标监听还没起来时投递：连接失败，消息**留在发送方手里**而不是消失 |
 * | 目标在线但正忙 | 同一逻辑通道上排队，收据一条不少 |
 * | 目标刚解冻、截止时间集体越阈 | 过 T-2 闸门的时钟仍接住在飞消息（另见 `timeouts.test.ts`） |
 *
 * 走真 socket，因为这一类的失败模式全在连接的边缘上，用假的传输测不出来。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MessageType,
  createMessage,
  type QianmoMessage,
} from '@qianmo/protocol'
import {
  TransportClient,
  startTransportServer,
  type TransportServerHandle,
} from '@qianmo/transport'

const PSK = 'boundary-trigger-psk-not-a-real-secret'
const PLANNER = 'qianmo://node-a/planner'
const REVIEWER = 'qianmo://node-b/reviewer'

const servers: TransportServerHandle[] = []
const clients: TransportClient[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-trigger-'))
  dirs.push(dir)
  return join(dir, 'node.sock')
}

function request(taskId: string) {
  return createMessage({
    from: PLANNER,
    to: REVIEWER,
    type: MessageType.TaskRequest,
    payload: { ask: 'work' },
    taskId,
  })
}

describe('① 触发时机 —— 目标还没起来', () => {
  test('拨不通就是拨不通：消息留在发送方手里，没有假装送达', async () => {
    const socket = socketPath()
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      backoff: { giveUpAfterMs: 0 },
    })
    clients.push(client)
    await expect(client.connect(500)).rejects.toThrow()
    expect(client.isReady()).toBe(false)
  })

  test('目标随后起来了，同一个客户端重连后消息才真的过去', async () => {
    // 「先投递、后就绪」在 M0 里由 activator 承担（P2.5），传输层这一侧的正确行为
    // 是：不丢、也不假装。这条测的是后半句。
    const socket = socketPath()
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      backoff: { baseDelayMs: 10, maxDelayMs: 30, jitterRatio: 0 },
    })
    clients.push(client)
    await expect(client.connect(300)).rejects.toThrow()

    const received: QianmoMessage[] = []
    const server = startTransportServer({
      psk: PSK,
      unix: socket,
      onMessage: message => {
        received.push(message)
      },
    })
    servers.push(server)

    await client.connect(3_000)
    await client.sendAndWait(request('late-1'), 3_000)
    expect(received.map(message => message.taskId)).toEqual(['late-1'])
  })
})

describe('① 触发时机 —— 目标在线但正忙', () => {
  test('慢处理器不丢消息：三条都被处理，收据一条不少', async () => {
    const socket = socketPath()
    const handled: string[] = []
    const server = startTransportServer({
      psk: PSK,
      unix: socket,
      onMessage: async message => {
        // 处理慢到足以让后面的消息排在它后面。
        await new Promise(resolve => setTimeout(resolve, 30))
        handled.push(message.taskId)
      },
    })
    servers.push(server)

    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
    })
    clients.push(client)
    await client.connect(3_000)

    await Promise.all([
      client.sendAndWait(request('busy-1'), 5_000),
      client.sendAndWait(request('busy-2'), 5_000),
      client.sendAndWait(request('busy-3'), 5_000),
    ])
    expect([...handled].sort()).toEqual(['busy-1', 'busy-2', 'busy-3'])
  })
})

describe('① 触发时机 —— 目标中途走开又回来', () => {
  test('断线期间发出的消息不算送达，重连之后才落地', async () => {
    const socket = socketPath()
    const received: string[] = []
    let server = startTransportServer({
      psk: PSK,
      unix: socket,
      onMessage: message => {
        received.push(message.taskId)
      },
    })
    servers.push(server)

    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      backoff: { baseDelayMs: 10, maxDelayMs: 30, jitterRatio: 0 },
    })
    clients.push(client)
    await client.connect(3_000)
    await client.sendAndWait(request('before'), 3_000)

    await server.stop()
    servers.splice(servers.indexOf(server), 1)
    const deadline = Date.now() + 2_000
    while (client.isReady() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    // 排进队列，但对面此刻没人——这条不该被记成已送达。
    client.send(request('during'))
    expect(client.pending).toBeGreaterThan(0)
    expect(received).toEqual(['before'])

    server = startTransportServer({
      psk: PSK,
      unix: socket,
      onMessage: message => {
        received.push(message.taskId)
      },
    })
    servers.push(server)
    await client.waitForDrain(5_000)
    expect(received).toEqual(['before', 'during'])
  }, 15_000)
})
