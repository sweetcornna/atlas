// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { describe, expect, test } from 'bun:test'
import type { QianmoMessage } from '@qianmo/protocol'
import { ReceiptStatus, startTransportServer } from '@qianmo/transport'
import {
  executeResidentWake,
  parseResidentWakeArgs,
  type ResidentWakeConfig,
} from '../residentWake.js'

const PSK = 'resident-wake-test-not-a-real-secret'

const BASE = [
  '--url=ws://host.internal:7330',
  '--from=qianmo://node-a/operator',
  '--to=qianmo://node-b/reviewer',
  '--prompt=check scheduled work',
] as const

describe('resident wake CLI configuration', () => {
  test('parses an immediate manual wake with explicit network identities', () => {
    expect(parseResidentWakeArgs(BASE, 'qianmo')).toEqual({
      url: 'ws://host.internal:7330/',
      from: 'qianmo://node-a/operator',
      to: 'qianmo://node-b/reviewer',
      prompt: 'check scheduled work',
      afterMs: 0,
      timeoutMs: 90_000,
      deliverTtlMs: 90_000,
    })
  })

  test('parses a delayed wake without changing its delivery budget', () => {
    expect(
      parseResidentWakeArgs(
        [...BASE, '--after-ms=60000', '--deliver-ttl-ms=120000'],
        'qianmo',
      ),
    ).toMatchObject({ afterMs: 60_000, deliverTtlMs: 120_000 })
  })

  test('requires Qianmo identity and valid WebSocket and address inputs', () => {
    expect(() => parseResidentWakeArgs(BASE, 'occ')).toThrow(
      'OCC_IDENTITY=qianmo',
    )
    expect(() =>
      parseResidentWakeArgs(
        BASE.map(arg =>
          arg.startsWith('--url=') ? '--url=http://host.internal' : arg,
        ),
        'qianmo',
      ),
    ).toThrow('must use ws or wss')
    expect(() =>
      parseResidentWakeArgs(
        BASE.map(arg => (arg.startsWith('--to=') ? '--to=reviewer' : arg)),
        'qianmo',
      ),
    ).toThrow('not a qianmo:// address')
  })

  test('bounds timer, timeout and delivery values', () => {
    expect(() =>
      parseResidentWakeArgs([...BASE, '--after-ms=-1'], 'qianmo'),
    ).toThrow('--after-ms')
    expect(() =>
      parseResidentWakeArgs([...BASE, '--timeout-ms=0'], 'qianmo'),
    ).toThrow('--timeout-ms')
    expect(() =>
      parseResidentWakeArgs([...BASE, '--deliver-ttl-ms=0'], 'qianmo'),
    ).toThrow('--deliver-ttl-ms')
  })

  test('delivers manual and timer wakes over authenticated transport', async () => {
    const received: QianmoMessage[] = []
    const server = startTransportServer({
      psk: PSK,
      port: 0,
      hostname: '127.0.0.1',
      onMessage: message => {
        received.push(message)
      },
    })
    const config: ResidentWakeConfig = {
      url: server.url!,
      from: 'qianmo://node-a/operator',
      to: 'qianmo://node-b/reviewer',
      prompt: 'run scheduled check',
      afterMs: 0,
      timeoutMs: 2_000,
      deliverTtlMs: 2_000,
    }

    try {
      const manual = await executeResidentWake(config, PSK)
      const timerStartedAt = Date.now()
      const timer = await executeResidentWake({ ...config, afterMs: 20 }, PSK)

      expect(manual.receipt).toBe(ReceiptStatus.Accepted)
      expect(timer.receipt).toBe(ReceiptStatus.Accepted)
      expect(received).toHaveLength(2)
      expect(received.map(message => message.payload)).toEqual([
        { trigger: 'manual', prompt: 'run scheduled check' },
        { trigger: 'timer', prompt: 'run scheduled check' },
      ])
      expect(received[1]!.createdAt).toBeGreaterThanOrEqual(timerStartedAt + 15)
    } finally {
      await server.stop()
    }
  })
})
