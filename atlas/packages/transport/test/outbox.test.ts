// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import type { QianmoMessage } from '@qianmo/protocol'
import { EnvelopeOutbox } from '../src/outbox.js'
import { makeMessage } from './helpers.js'

function outbox(options: { canWrite?: boolean } = {}): {
  readonly outbox: EnvelopeOutbox
  readonly written: QianmoMessage[]
} {
  const written: QianmoMessage[] = []
  return {
    written,
    outbox: new EnvelopeOutbox({
      canWrite: () => options.canWrite ?? true,
      isClosed: () => false,
      write: message => {
        written.push(message)
        return true
      },
    }),
  }
}

describe('EnvelopeOutbox close', () => {
  test('a caller waiting for drain is told why it will never drain', async () => {
    const { outbox: queue } = outbox()
    queue.send(makeMessage())
    const draining = queue.waitForDrain(5_000)
    const reason = new Error('transport server closed before receipt')

    queue.close(reason)

    // Without this the caller waits out its own timeout and is then told
    // "did not drain" — the symptom, with the cause thrown away.
    await expect(draining).rejects.toThrow(
      'transport server closed before receipt',
    )
  })

  test('a closed outbox stops reporting a queue that can no longer move', () => {
    const { outbox: queue } = outbox()
    queue.send(makeMessage())
    expect(queue.pending).toBe(1)

    queue.close(new Error('channel reclaimed'))

    expect(queue.pending).toBe(0)
  })
})

test('once-only written requests become unknown on disconnect and never replay', async () => {
  const { outbox: queue, written } = outbox()
  const delivery = queue.sendOnce(makeMessage(), 5_000)
  const rejected = delivery.receipt.catch(error => error)
  queue.disconnect()
  expect(await rejected).toBeInstanceOf(Error)
  expect(delivery.cancel()).toBe('unknown')
  expect(queue.pending).toBe(0)
  queue.replay()
  expect(written).toHaveLength(1)
})

test('an unwritten request expires as not-sent and is withdrawn before reconnect', async () => {
  const options = { canWrite: false }
  const { outbox: queue, written } = outbox(options)
  const delivery = queue.sendOnce(makeMessage(), 5)
  await expect(delivery.receipt).rejects.toThrow()
  expect(delivery.cancel()).toBe('not-sent')
  expect(queue.pending).toBe(0)
  options.canWrite = true
  queue.replay()
  expect(written).toEqual([])
})

test('a socket refusing a write reports not-sent and leaves nothing to replay', async () => {
  let attempts = 0
  const queue = new EnvelopeOutbox({
    canWrite: () => true,
    isClosed: () => false,
    write: () => {
      attempts++
      return false
    },
  })
  const delivery = queue.sendOnce(makeMessage(), 5)
  await expect(delivery.receipt).rejects.toThrow()
  expect(delivery.cancel()).toBe('not-sent')
  expect(queue.pending).toBe(0)
  queue.replay()
  expect(attempts).toBe(1)
})
