// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The route table as a table: who claims which head, and what happens when
 * two modules reach for the same one.
 */

import { describe, expect, test } from 'bun:test'
import {
  RESERVED_PAGE_HEADS,
  ROUTES,
  headIndex,
  pageOf,
} from '../src/routes/index.js'
import type { AreaId, HeadRoute, RouteModule } from '../src/routes/types.js'

const handler: HeadRoute['handle'] = async () => new Response(null)

function module(id: string, heads: readonly string[]): RouteModule {
  return {
    area: {
      id: 'alerts',
      label: id,
      group: 'manage',
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

describe('the pages', () => {
  /** Every area, with its path and group, in sidebar order. */
  const AREAS: readonly (readonly [AreaId, string, string, boolean])[] = [
    ['chat', '/chat', 'main', false],
    ['jobs', '/jobs', 'main', false],
    ['memory', '/memory', 'main', false],
    ['connect', '/connect', 'main', false],
    ['desktop', '/desktop', 'main', false],
    ['providers', '/providers', 'main', false],
    ['overview', '/overview', 'manage', false],
    ['nodes', '/nodes', 'manage', false],
    ['files', '/files', 'manage', false],
    ['audit', '/audit', 'manage', false],
    ['alerts', '/alerts', 'manage', false],
    ['approvals', '/approvals', 'manage', false],
    ['servers', '/servers', 'manage', false],
    ['access', '/access', 'manage', false],
    ['usage', '/usage', 'manage', false],
    ['settings', '/settings', 'manage', false],
  ]

  test('every area has a module, in sidebar order, with a page at its href', () => {
    expect(ROUTES.map(m => m.area.id)).toEqual(AREAS.map(([id]) => id))
    for (const [id, href, group, pending] of AREAS) {
      const module = ROUTES.find(m => m.area.id === id)
      expect(module?.area.href).toBe(href)
      expect(module?.area.group).toBe(group as 'main')
      expect(`${id} ${module?.area.pending === true}`).toBe(`${id} ${pending}`)
      const segments = href.split('/').filter(part => part !== '')
      expect(pageOf(ROUTES, segments)?.module.area.id).toBe(id)
    }
  })

  test('the sub-pages land on their area, with the rest of the path', () => {
    expect(pageOf(ROUTES, ['nodes', 'tokyo-1'])?.rest).toEqual(['tokyo-1'])
    expect(pageOf(ROUTES, ['audit', 'trace', 'abc'])?.module.area.id).toBe(
      'audit',
    )
    // Anything deeper, or beside, is nobody's page: the console's 404.
    for (const path of [
      ['nodes', 'a', 'b'],
      ['audit', 'trace'],
      ['audit', 'other', 'abc'],
      ['alerts', 'x'],
      ['settings', 'x'],
      ['nope'],
    ]) {
      expect(pageOf(ROUTES, path)).toBeUndefined()
    }
  })

  test('no page can answer a reserved first segment', () => {
    const greedy: RouteModule = {
      area: {
        id: 'alerts',
        label: 'x',
        group: 'manage',
        href: '/',
        icon: 'info',
      },
      page: {
        match: segments => segments,
        guard: 'view',
        render: async () => ({ title: 'x', body: '' }),
      },
    }
    for (const head of RESERVED_PAGE_HEADS) {
      expect(pageOf([greedy], [head, 'x'])).toBeUndefined()
    }
    expect(RESERVED_PAGE_HEADS).toEqual([
      'v0',
      'fragments',
      'assets',
      'login',
      'logout',
      'invite',
    ])
    // And no real module tries.
    for (const module of ROUTES) {
      for (const head of RESERVED_PAGE_HEADS) {
        expect(module.page?.match([head])).toBeNull()
      }
    }
  })
})
