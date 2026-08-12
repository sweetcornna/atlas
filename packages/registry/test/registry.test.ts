// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_TTL_MS,
  InMemoryRegistry,
  ManualClock,
  RegistryErrorCode,
  isValidEndpoint,
} from '../src/index.js'

const TTL = 90_000
const ENDPOINT = 'qianmo://tokyo-1/planner'

let clock: ManualClock
let registry: InMemoryRegistry

beforeEach(() => {
  clock = new ManualClock(1_000)
  registry = new InMemoryRegistry({ ttlMs: TTL, clock })
})

describe('endpoint validation', () => {
  test('accepts qianmo addresses and http(s) urls', () => {
    expect(isValidEndpoint('qianmo://tokyo-1/planner')).toBe(true)
    expect(isValidEndpoint('http://127.0.0.1:8080/agent')).toBe(true)
    expect(isValidEndpoint('https://nest.example.com/a')).toBe(true)
  })

  test('rejects anything else', () => {
    expect(isValidEndpoint('ftp://example.com')).toBe(false)
    expect(isValidEndpoint('tokyo-1/planner')).toBe(false)
    expect(isValidEndpoint('')).toBe(false)
    expect(isValidEndpoint(42)).toBe(false)
  })
})

describe('register', () => {
  test('defaults to a 90s lease', () => {
    expect(DEFAULT_TTL_MS).toBe(90_000)
    expect(new InMemoryRegistry().ttlMs).toBe(90_000)
  })

  test('creates an entry and stamps the lease', () => {
    const result = registry.register('planner', ENDPOINT, ['plan', 'summarise'])
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`)
    expect(result.created).toBe(true)
    expect(result.entry.name).toBe('planner')
    expect(result.entry.capabilities).toEqual(['plan', 'summarise'])
    expect(result.entry.registeredAt).toBe(1_000)
    expect(result.entry.expiresAt).toBe(1_000 + TTL)
  })

  test('defaults capabilities to an empty list', () => {
    const result = registry.register('planner', ENDPOINT)
    if (!result.ok) throw new Error('expected ok')
    expect(result.entry.capabilities).toEqual([])
  })

  test('re-registering the same endpoint refreshes instead of creating', () => {
    registry.register('planner', ENDPOINT, ['plan'])
    clock.advance(5_000)
    const again = registry.register('planner', ENDPOINT, ['plan', 'review'])
    if (!again.ok) throw new Error('expected ok')
    expect(again.created).toBe(false)
    expect(again.entry.registeredAt).toBe(1_000)
    expect(again.entry.expiresAt).toBe(6_000 + TTL)
    expect(again.entry.capabilities).toEqual(['plan', 'review'])
    expect(registry.size).toBe(1)
  })

  test('rejects a different endpoint for a live name with E_CONFLICT', () => {
    registry.register('planner', ENDPOINT)
    const clash = registry.register('planner', 'qianmo://osaka-2/planner')
    expect(clash.ok).toBe(false)
    if (clash.ok) throw new Error('expected conflict')
    expect(clash.code).toBe(RegistryErrorCode.E_CONFLICT)
  })

  test('allows a new endpoint once the old lease expired', () => {
    registry.register('planner', ENDPOINT)
    clock.advance(TTL + 1)
    const retaken = registry.register('planner', 'qianmo://osaka-2/planner')
    if (!retaken.ok) throw new Error('expected ok')
    expect(retaken.created).toBe(true)
    expect(retaken.entry.endpoint).toBe('qianmo://osaka-2/planner')
  })

  test('rejects invalid input with E_BAD_REQUEST', () => {
    for (const bad of [
      registry.register('Bad Name', ENDPOINT),
      registry.register('planner', 'nope'),
    ]) {
      expect(bad.ok).toBe(false)
      if (bad.ok) throw new Error('expected failure')
      expect(bad.code).toBe(RegistryErrorCode.E_BAD_REQUEST)
    }
    const badCaps = registry.register('planner', ENDPOINT, ['ok', 5])
    expect(badCaps.ok).toBe(false)
  })
})

describe('resolve / list / deregister', () => {
  test('resolves a live agent and misses an unknown one', () => {
    registry.register('planner', ENDPOINT)
    expect(registry.resolve('planner')?.endpoint).toBe(ENDPOINT)
    expect(registry.resolve('ghost')).toBeNull()
  })

  test('lists live agents sorted by name', () => {
    registry.register('worker', 'qianmo://osaka-2/worker')
    registry.register('planner', ENDPOINT)
    expect(registry.list().map(a => a.name)).toEqual(['planner', 'worker'])
  })

  test('deregister removes the entry and reports whether it existed', () => {
    registry.register('planner', ENDPOINT)
    expect(registry.deregister('planner')).toBe(true)
    expect(registry.resolve('planner')).toBeNull()
    expect(registry.deregister('planner')).toBe(false)
  })
})

describe('ttl expiry', () => {
  test('an entry stays live up to its deadline and drops out after it', () => {
    registry.register('planner', ENDPOINT)
    clock.advance(TTL - 1)
    expect(registry.resolve('planner')).not.toBeNull()
    clock.advance(1)
    expect(registry.resolve('planner')).not.toBeNull()
    clock.advance(1)
    expect(registry.resolve('planner')).toBeNull()
    expect(registry.list()).toEqual([])
  })

  test('heartbeat extends the lease', () => {
    registry.register('planner', ENDPOINT)
    clock.advance(TTL - 10)
    const beat = registry.heartbeat('planner')
    expect(beat).not.toBeNull()
    expect(beat?.lastHeartbeatAt).toBe(clock.now())
    expect(beat?.expiresAt).toBe(clock.now() + TTL)

    clock.advance(TTL)
    expect(registry.resolve('planner')).not.toBeNull()
    clock.advance(1)
    expect(registry.resolve('planner')).toBeNull()
  })

  test('heartbeat on an expired or unknown agent returns null', () => {
    registry.register('planner', ENDPOINT)
    clock.advance(TTL + 1)
    expect(registry.heartbeat('planner')).toBeNull()
    expect(registry.heartbeat('ghost')).toBeNull()
  })

  test('full lifecycle: register -> resolve -> heartbeat -> expire', () => {
    registry.register('planner', ENDPOINT, ['plan'])
    expect(registry.resolve('planner')?.capabilities).toEqual(['plan'])

    clock.advance(TTL / 2)
    expect(registry.heartbeat('planner')).not.toBeNull()

    clock.advance(TTL / 2)
    expect(registry.resolve('planner')).not.toBeNull()

    clock.advance(TTL)
    expect(registry.resolve('planner')).toBeNull()
    expect(registry.size).toBe(0)
  })

  test('prune drops expired entries eagerly', () => {
    registry.register('planner', ENDPOINT)
    registry.register('worker', 'qianmo://osaka-2/worker')
    clock.advance(TTL + 1)
    expect(registry.prune()).toBe(2)
    expect(registry.prune()).toBe(0)
  })

  test('clear empties the table', () => {
    registry.register('planner', ENDPOINT)
    registry.clear()
    expect(registry.size).toBe(0)
  })
})
