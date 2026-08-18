// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { describe, expect, test } from 'bun:test'
import { InMemoryRegistry, ManualClock } from '@qianmo/registry'
import {
  announceRegistrations,
  type Registration,
} from './p81-announce-core.js'

/**
 * 用**真**的 `InMemoryRegistry`，不 mock。这个函数的全部价值就在于它和那张表的
 * 交互（`register()` 对活着的地址换端点会返回 `E_CONFLICT`），把表 mock 掉等于把
 * 被测的那件事替换成一个我自己写的假设。
 */
const makeRegistry = (clock: ManualClock, ttlMs = 90_000): InMemoryRegistry =>
  new InMemoryRegistry({ clock, ttlMs })

const at = (address: string, endpoint: string): Registration => ({
  address,
  endpoint,
})

const endpointOf = (registry: InMemoryRegistry, address: string): string =>
  registry.resolve(address)?.endpoint ?? '<不在表上>'

describe('announceRegistrations', () => {
  test('表上没有时整条登记', () => {
    const registry = makeRegistry(new ManualClock(1_000))
    const outcomes = announceRegistrations(registry, [
      at('qianmo://node-a/planner', 'ws://127.0.0.1:38611'),
    ])

    expect(outcomes).toEqual([
      { kind: 'registered', address: 'qianmo://node-a/planner' },
    ])
    expect(endpointOf(registry, 'qianmo://node-a/planner')).toBe(
      'ws://127.0.0.1:38611',
    )
  })

  test('端点没变时是续租，不是重登记', () => {
    const clock = new ManualClock(1_000)
    const registry = makeRegistry(clock)
    const declared = [at('qianmo://node-a/planner', 'ws://127.0.0.1:38611')]

    announceRegistrations(registry, declared)
    const first = registry.resolve('qianmo://node-a/planner')
    clock.advance(20_000)
    const outcomes = announceRegistrations(registry, declared)
    const second = registry.resolve('qianmo://node-a/planner')

    expect(outcomes).toEqual([
      { kind: 'renewed', address: 'qianmo://node-a/planner' },
    ])
    // registeredAt 不变 = 这条记录没有被推倒重来；expiresAt 变了 = 租约确实续上了。
    expect(second?.registeredAt).toBe(first?.registeredAt as number)
    expect(second?.expiresAt).toBeGreaterThan(first?.expiresAt as number)
  })

  /**
   * 这一条是整个文件存在的理由。修好之前这里会拿到 `renewed` 且端点停在旧值上，
   * 而且**没有任何报错**——内测环境的入站从直连改成走隧道口时就是这么静默失效的。
   */
  test('端点变了：撤掉旧的重登记，表上换成新端点', () => {
    const clock = new ManualClock(1_000)
    const registry = makeRegistry(clock)
    const address = 'qianmo://node-a/planner'

    announceRegistrations(registry, [at(address, 'ws://127.0.0.1:38611')])
    clock.advance(20_000) // 租约还活着（TTL 90 s），正是最容易漏掉的那个窗口
    const outcomes = announceRegistrations(registry, [
      at(address, 'ws://127.0.0.1:38631'),
    ])

    expect(outcomes).toEqual([
      {
        kind: 'moved',
        address,
        from: 'ws://127.0.0.1:38611',
        to: 'ws://127.0.0.1:38631',
      },
    ])
    expect(endpointOf(registry, address)).toBe('ws://127.0.0.1:38631')
  })

  test('搬家之后再跑一轮就安静了（收敛，不是每轮都搬）', () => {
    const clock = new ManualClock(1_000)
    const registry = makeRegistry(clock)
    const address = 'qianmo://node-a/planner'
    const moved = [at(address, 'ws://127.0.0.1:38631')]

    announceRegistrations(registry, [at(address, 'ws://127.0.0.1:38611')])
    announceRegistrations(registry, moved)
    clock.advance(20_000)

    expect(announceRegistrations(registry, moved)).toEqual([
      { kind: 'renewed', address },
    ])
  })

  test('租约过期后是 registered 而不是 moved', () => {
    const clock = new ManualClock(1_000)
    const registry = makeRegistry(clock)
    const address = 'qianmo://node-a/planner'

    announceRegistrations(registry, [at(address, 'ws://127.0.0.1:38611')])
    clock.advance(90_001) // 过了 TTL：表上那条已经不算活着
    const outcomes = announceRegistrations(registry, [
      at(address, 'ws://127.0.0.1:38631'),
    ])

    // 端点确实变了，但没有「旧的」可撤——如实报 registered，别把两件事混成一件。
    expect(outcomes).toEqual([{ kind: 'registered', address }])
    expect(endpointOf(registry, address)).toBe('ws://127.0.0.1:38631')
  })

  test('多条地址：只有变了的那条搬家，其余照旧续租', () => {
    const clock = new ManualClock(1_000)
    const registry = makeRegistry(clock)
    const before = [
      at('qianmo://node-a/planner', 'ws://127.0.0.1:38611'),
      at('qianmo://node-b/reviewer', 'ws://127.0.0.1:38612'),
      at('qianmo://node-b/ops', 'ws://127.0.0.1:38612'),
    ]
    announceRegistrations(registry, before)
    clock.advance(20_000)

    const outcomes = announceRegistrations(registry, [
      before[0] as Registration,
      at('qianmo://node-b/reviewer', 'ws://127.0.0.1:38632'),
      before[2] as Registration,
    ])

    expect(outcomes.map(o => o.kind)).toEqual(['renewed', 'moved', 'renewed'])
    expect(endpointOf(registry, 'qianmo://node-a/planner')).toBe(
      'ws://127.0.0.1:38611',
    )
    expect(endpointOf(registry, 'qianmo://node-b/reviewer')).toBe(
      'ws://127.0.0.1:38632',
    )
    // 同节点的另一个智能体没被连累：撤的是地址那一条，不是整个节点。
    expect(endpointOf(registry, 'qianmo://node-b/ops')).toBe(
      'ws://127.0.0.1:38612',
    )
  })

  test('登记失败抛错而不是静默跳过', () => {
    const registry = makeRegistry(new ManualClock(1_000))

    expect(() =>
      announceRegistrations(registry, [at('不是一个地址', 'ws://127.0.0.1:1')]),
    ).toThrow(/注册失败/)
  })

  test('前一条失败不会把后面几条一起吞掉——抛错前已登记的仍在表上', () => {
    const registry = makeRegistry(new ManualClock(1_000))

    expect(() =>
      announceRegistrations(registry, [
        at('qianmo://node-a/planner', 'ws://127.0.0.1:38611'),
        at('不是一个地址', 'ws://127.0.0.1:1'),
      ]),
    ).toThrow()
    expect(endpointOf(registry, 'qianmo://node-a/planner')).toBe(
      'ws://127.0.0.1:38611',
    )
  })
})
