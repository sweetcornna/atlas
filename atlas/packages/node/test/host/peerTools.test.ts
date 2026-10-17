// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qianmo_agents` and `qianmo_ask` on the node (P36.6): a stable tool face,
 * arguments checked before the hub hears anything, the conversation and turn
 * carried up, the wait bounded by the asking turn's own deadline and counted
 * as activity while it lasts. The chain glue the gate reads is here too.
 */

import { expect, test } from 'bun:test'
import { generateNodeKeyPair, signTaskOwner } from '@qianmo/capability'
import {
  createMessage,
  MessageType,
  type ControlOutcome,
} from '@qianmo/protocol'
import {
  askReentry,
  PEER_ASK,
  peerTools,
  type PeerToolOrigin,
} from '../../src/host/peerTools.js'
import { taskTools } from '../../src/host/taskTools.js'

const ctx = { agent: 'main', sessionId: 's-1' }
const CODER = 'qianmo://node-b/coder'

function tools(
  origin: Partial<PeerToolOrigin> | null = {},
  answer: ControlOutcome | Error | (() => Promise<ControlOutcome>) = {
    ok: true,
    value: { answers: [] },
  },
) {
  const calls: [string, Record<string, unknown>, Record<string, unknown>][] = []
  let alive = 0
  const list = peerTools({
    call: async (op, args, options) => {
      calls.push([op, args, options])
      if (answer instanceof Error) throw answer
      return typeof answer === 'function' ? await answer() : answer
    },
    origin: () =>
      origin === null
        ? null
        : {
            contextId: 'console-session',
            taskId: 'turn-7',
            remainingMs: 600_000,
            keepAlive: () => {
              alive++
            },
            ...origin,
          },
    keepAliveMs: 10,
  })
  return {
    calls,
    alive: () => alive,
    list,
    byName: (name: string) => list.find(one => one.name === name)!,
  }
}

test('two tools in a fixed order, closed schemas, the same on every turn and with or without a turn', () => {
  const face = (origin: Partial<PeerToolOrigin> | null) =>
    JSON.stringify(
      [
        ...taskTools({
          call: async () => ({ ok: true, value: null }),
          origin: () => null,
        }),
        ...tools(origin).list,
      ].map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
    )
  const names = tools().list.map(tool => tool.name)
  expect(names).toEqual(['qianmo_agents', 'qianmo_ask'])
  for (const tool of tools().list)
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
    })
  expect(face({})).toBe(face(null))
  expect(face({ remainingMs: 1 })).toBe(face({}))
})

test('a question carries its targets, message, timeout, conversation and turn; the hub call outlives the question', async () => {
  const { calls, byName } = tools(
    {},
    { ok: true, value: { answers: [{ agent: CODER, ok: true, reply: '42' }] } },
  )
  const result = await byName('qianmo_ask').handler(
    { agent: CODER, message: '六乘七是多少？', timeoutSec: 60 },
    ctx,
  )
  expect(result).toMatchObject({
    ok: true,
    text: JSON.stringify({
      answers: [{ agent: CODER, ok: true, reply: '42' }],
    }),
  })
  expect(calls).toEqual([
    [
      'peers.ask',
      {
        agents: [CODER],
        message: '六乘七是多少？',
        timeoutSec: 60,
        contextId: 'console-session',
        taskId: 'turn-7',
      },
      { agent: 'main', timeoutMs: 120_000 },
    ],
  ])
  // The roster: no arguments, the same identity.
  await byName('qianmo_agents').handler({}, ctx)
  expect(calls[1]).toEqual([
    'peers.list',
    { contextId: 'console-session', taskId: 'turn-7' },
    { agent: 'main' },
  ])
})

test('the wait never runs past the asking turn: the timeout shrinks to what is left, too little refuses', async () => {
  const { calls, byName } = tools({ remainingMs: 100_000 })
  await byName('qianmo_ask').handler(
    { agents: [CODER, 'qianmo://node-a/reviewer'], message: 'q' },
    ctx,
  )
  // 100 s left, 30 s kept for the answer: 70 s, not the default 300.
  expect(calls[0]?.[1]).toMatchObject({ timeoutSec: 70 })
  // A short timeout the caller chose is its own business.
  const quick = tools({ remainingMs: 100_000 })
  await quick
    .byName('qianmo_ask')
    .handler({ agent: CODER, message: 'q', timeoutSec: 3 }, ctx)
  expect(quick.calls[0]?.[1]).toMatchObject({ timeoutSec: 3 })
  const late = tools({ remainingMs: 35_000 })
  const refused = await late
    .byName('qianmo_ask')
    .handler({ agent: CODER, message: 'q' }, ctx)
  expect(refused.ok).toBe(false)
  expect(refused.text).toContain('Not enough time')
  expect(late.calls).toEqual([])
})

test('the asking turn counts as active for as long as it waits, and no longer', async () => {
  let release!: (value: ControlOutcome) => void
  const pending = new Promise<ControlOutcome>(resolve => {
    release = resolve
  })
  const t = tools({}, () => pending)
  const asked = t
    .byName('qianmo_ask')
    .handler({ agent: CODER, message: 'q' }, ctx)
  await Bun.sleep(60)
  const during = t.alive()
  expect(during).toBeGreaterThanOrEqual(3)
  release({ ok: true, value: { answers: [] } })
  await asked
  const after = t.alive()
  await Bun.sleep(40)
  expect(t.alive()).toBe(after)
})

test('refused before the hub: bad arguments, no running conversation turn', async () => {
  const { calls, byName } = tools()
  const ask = byName('qianmo_ask')
  for (const bad of [
    null,
    [],
    { message: 'no target' },
    { agent: CODER },
    { agent: CODER, message: '   ' },
    { agent: CODER, agents: [CODER], message: 'both' },
    { agents: [], message: 'none' },
    { agents: [CODER, CODER], message: 'twice' },
    {
      agents: ['a', 'b', 'c', 'd', 'e'].map(n => `qianmo://n/${n}`),
      message: 'five',
    },
    { agent: CODER, message: 'x'.repeat(PEER_ASK.maxMessageBytes + 1) },
    // 16 KiB counts bytes: 6000 CJK characters are 18000 bytes.
    { agent: CODER, message: '问'.repeat(6_000) },
    { agent: CODER, message: 'q', timeoutSec: 0 },
    { agent: CODER, message: 'q', timeoutSec: 1.5 },
    { agent: CODER, message: 'q', timeoutSec: PEER_ASK.maxTimeoutSec + 1 },
    { agent: CODER, message: 'q', contextId: 'forged' },
  ])
    expect((await ask.handler(bad, ctx)).ok).toBe(false)
  expect((await byName('qianmo_agents').handler({ x: 1 }, ctx)).ok).toBe(false)
  expect(calls).toEqual([])
  const outside = tools(null)
  const result = await outside
    .byName('qianmo_ask')
    .handler({ agent: CODER, message: 'q' }, ctx)
  expect(result.text).toContain('only available in a console')
  expect(outside.calls).toEqual([])
})

test('a refusal is shown as such; a hub that never answered says the outcome is unknown', async () => {
  const refused = tools(
    {},
    { ok: false, code: 'refused', message: '定时任务的会话不能问其他智能体' },
  )
  expect(
    await refused
      .byName('qianmo_ask')
      .handler({ agent: CODER, message: 'q' }, ctx),
  ).toMatchObject({
    ok: false,
    text: '{"error":"定时任务的会话不能问其他智能体"}',
  })
  const broken = tools({}, new Error('link down'))
  expect(
    (
      await broken
        .byName('qianmo_ask')
        .handler({ agent: CODER, message: 'q' }, ctx)
    ).text,
  ).toContain('unknown')
})

test("a turn's re-entry key and chain come only from a request the hub signed", () => {
  const hub = generateNodeKeyPair()
  const controllers = new Map([['hub', hub.publicKey]])
  const raw = createMessage({
    from: 'qianmo://hub/console',
    to: 'qianmo://node-b/coder',
    type: MessageType.TaskRequest,
    contextId: 'peer-session',
    payload: {
      prompt: '来自 qianmo://node-b/main 的提问',
      onBehalfOf: 'legacy:admin',
      chain: [
        { node: 'node-a', taskId: 'far' },
        { node: 'node-b', taskId: 'near' },
      ],
    },
  })
  const signed = signTaskOwner(raw, hub)
  // Only this node's links: those are the turns here that can be waiting.
  expect(askReentry(signed, 'node-b', controllers)).toEqual({
    key: signed.taskId,
    chain: ['near'],
  })
  expect(askReentry(signed, 'node-c', controllers)).toEqual({
    key: signed.taskId,
  })
  // Unsigned, or signed by a key this node does not hold: nothing at all.
  expect(askReentry(raw, 'node-b', controllers)).toBeUndefined()
  expect(
    askReentry(
      signTaskOwner(raw, generateNodeKeyPair()),
      'node-b',
      controllers,
    ),
  ).toBeUndefined()
})
