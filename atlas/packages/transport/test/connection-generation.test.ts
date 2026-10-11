// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  TransportClient,
  startTransportServer,
  newChannelId,
  type InboundContext,
} from '../src/index.js'
import { TEST_PSK, makeMessage } from './helpers.js'

test('a socket replacement keeps the logical channel but changes its authenticated generation', async () => {
  const contexts: InboundContext[] = []
  let release: (() => void) | undefined
  const server = startTransportServer({
    psk: TEST_PSK,
    port: 0,
    onMessage: (_message, ctx) => {
      contexts.push(ctx)
      release ??= ctx.channel.hold()
    },
  })
  const channelId = newChannelId()
  const create = () =>
    new TransportClient({
      endpoint: { url: server.url! },
      node: 'node-a',
      channelId,
      psk: TEST_PSK,
      backoff: { giveUpAfterMs: 0 },
    })
  const first = create(),
    second = create()
  try {
    await first.connect()
    const firstGeneration = first.connectionGeneration
    await first.sendAndWait(makeMessage())
    const old = contexts[0]!
    await second.connect()
    await second.sendAndWait(makeMessage())
    const current = contexts[1]!
    expect(current.channel).toBe(old.channel)
    expect(current.connectionGeneration).not.toBe(old.connectionGeneration)
    expect(old.connectionGeneration).toBeTruthy()
    expect(current.channel.connectionGeneration).toBe(
      current.connectionGeneration,
    )
    expect(second.connectionGeneration).not.toBe(firstGeneration)
    expect(firstGeneration).toBeTruthy()
  } finally {
    await first.close()
    await second.close()
    release?.()
    await server.stop()
  }
})
