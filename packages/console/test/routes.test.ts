// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The route table as a table: who claims which head, and what happens when
 * two modules reach for the same one.
 */

import { describe, expect, test } from 'bun:test'
import { ROUTES, headIndex } from '../src/routes/index.js'
import type { HeadRoute, RouteModule } from '../src/routes/types.js'

const handler: HeadRoute['handle'] = async () => new Response(null)

function module(id: string, heads: readonly string[]): RouteModule {
  return {
    area: {
      id: 'alerts',
      label: id,
      group: 'run',
      href: `/${id}`,
      icon: 'info',
    },
    api: { heads, handle: handler },
  }
}

describe('the route table', () => {
  test('every API and fragment head is claimed by exactly one module', () => {
    const api = headIndex(ROUTES, m => m.api, ['accounts', 'health'])
    const fragments = headIndex(ROUTES, m => m.fragments)
    // The heads the console answered before the split, all still answered.
    for (const head of [
      'agents',
      'wake',
      'audit',
      'servers',
      'limits',
      'chat',
    ]) {
      expect(api.has(head)).toBe(true)
    }
    for (const head of ['roster', 'audit', 'chain', 'limits', 'chat']) {
      expect(fragments.has(head)).toBe(true)
    }
  })

  test('a head claimed twice is refused when the table is built', () => {
    expect(() =>
      headIndex([module('a', ['x']), module('b', ['x'])], m => m.api),
    ).toThrow('route head claimed twice: x')
  })

  test('a module cannot claim a head the console keeps for itself', () => {
    expect(() =>
      headIndex([module('a', ['health'])], m => m.api, ['accounts', 'health']),
    ).toThrow('route head claimed twice: health')
  })
})
