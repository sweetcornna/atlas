// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The P1 items of `console-audit.md` §4 that can be shown without a browser
 * (P18.14): what a whole page says once the handler has drawn it. The browser
 * half is `browser/p1.browser.test.ts`; the copy rules are `copyGate.test.ts`.
 */

import { AuditSource, type AuditRecord } from '@qianmo/audit'
import { describe, expect, test } from 'bun:test'
import type { AuditPage, ConsoleCertificate } from '../src/deps.js'
import { renderOverview } from '../src/view/page.js'
import {
  ADMIN,
  NOW,
  TRACE,
  VIEW,
  agentAt,
  browse,
  pageHarness,
  visibleText,
  type PageHarness,
} from './pageHarness.js'

describe('C6 · an empty trail offers a wake only where one can happen', () => {
  async function emptyTrail(token: string, wake: boolean): Promise<string> {
    const h = pageHarness({ wake })
    h.audit.readResult = {
      ok: true,
      value: {
        records: [],
        chain: 'empty',
        intact: true,
        issueCount: 0,
        total: 0,
      },
    }
    const response = await h.handle(browse('/audit', token))
    expect(response.status).toBe(200)
    return await response.text()
  }

  test('a writer on a console that can wake is sent to the page that wakes', async () => {
    const html = await emptyTrail(ADMIN, true)
    expect(html).toContain('还没有业务消息经过这条链 · 唤醒一个智能体后')
    expect(html).toContain('href="/nodes" data-nav data-write')
    expect(visibleText(html)).not.toContain('连通')
  })

  test('a reader, or a console that cannot wake, is offered nothing', async () => {
    for (const html of [
      await emptyTrail(VIEW, true),
      await emptyTrail(ADMIN, false),
    ]) {
      expect(html).toContain('还没有业务消息经过这条链')
      expect(html).not.toContain('去节点页唤醒')
      expect(html).not.toContain('唤醒一个智能体后')
    }
  })

  test('the nodes page says why waking is off, by its real cause', async () => {
    const h = pageHarness({ wake: false })
    const html = await (await h.handle(browse('/nodes', ADMIN))).text()
    expect(html).toContain('唤醒不可用 · 启动时没有配置唤醒目标')
    expect(html).not.toContain('QIANMO_TRANSPORT_PSK')
  })
})

describe('H5 · a token in the address bar becomes a session, once', () => {
  const HTML = { accept: 'text/html,application/xhtml+xml' }

  function navigate(path: string, cookie?: string): Request {
    const headers: Record<string, string> = { ...HTML }
    if (cookie !== undefined) headers['cookie'] = `qianmo_console=${cookie}`
    return new Request(`http://console.test${path}`, { headers })
  }

  test('a navigation with ?token= is answered with the cookie and the same address without it', async () => {
    const h = pageHarness()
    const response = await h.handle(
      navigate(`/audit?source=router&token=${ADMIN}&limit=7`),
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      '/audit?source=router&limit=7',
    )
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(
      new RegExp(`^qianmo_console=${ADMIN}; Path=/; HttpOnly; SameSite=Strict`),
    )
    // Nothing rendered, nothing read: the page comes on the next request.
    expect(h.registry.listCalls).toBe(0)
    const page = await h.handle(navigate('/audit?source=router&limit=7', ADMIN))
    expect(page.status).toBe(200)
  })

  test('a token that is not one of the pair is not exchanged, and a stale one beside a cookie changes nothing', async () => {
    const h = pageHarness()
    const wrong = await h.handle(navigate('/nodes?token=not-a-token-at-all'))
    expect(wrong.status).not.toBe(200)
    expect(wrong.headers.get('set-cookie')).toBeNull()
    const stale = await h.handle(
      navigate('/nodes?token=not-a-token-at-all', VIEW),
    )
    expect(stale.status).toBe(200)
    expect(stale.headers.get('set-cookie')).toBeNull()
  })

  test('a script still uses ?token= on a JSON route, unexchanged', async () => {
    const h = pageHarness()
    const response = await h.handle(
      new Request(`http://console.test/v0/agents?token=${VIEW}`),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  test('the runtime signs no link, and the stream URL carries no token', async () => {
    const h = pageHarness({ chat: true })
    for (const path of ['/nodes', '/chat']) {
      const html = await (await h.handle(navigate(path, ADMIN))).text()
      const script = html.slice(html.indexOf('<script>'))
      // No URL is built with the token in it, anywhere in what the page runs.
      expect(script).not.toMatch(/'\??token=' \+/)
      expect(script).not.toContain('paintLinks')
      if (path === '/chat') {
        expect(script).toContain('new EventSource(ROUTES.stream)')
      }
    }
  })
})

describe('A2 · every overview card is something that changes', () => {
  const HOUR = 3_600_000

  function record(seq: number, outcome: string): AuditRecord {
    return {
      seq,
      at: NOW - 60_000,
      source: AuditSource.Router,
      kind: outcome === 'ok' ? 'forwarded' : outcome,
      traceId: TRACE,
      outcome,
      prev: '0'.repeat(64),
    } as AuditRecord
  }

  async function overview(
    h: PageHarness,
    page: Partial<AuditPage> = {},
  ): Promise<string> {
    h.audit.readResult = {
      ok: true,
      value: {
        records: [],
        chain: 'intact',
        intact: true,
        issueCount: 0,
        total: 40,
        ...page,
      },
    }
    return await (await h.handle(browse('/', ADMIN))).text()
  }

  test('the two protocol constants are gone, and the last hour is read instead', async () => {
    const h = pageHarness()
    const html = await overview(h)
    expect(html).not.toContain('注册租约')
    expect(html).not.toContain('速率预算')
    expect(h.audit.filters.at(-1)).toEqual({ from: NOW - HOUR, limit: 500 })
  })

  test('refusals and drops in the window are counted, with the way to the records', async () => {
    const h = pageHarness()
    const html = await overview(h, {
      records: [
        record(1, 'refused'),
        record(2, 'refused'),
        record(3, 'dropped'),
        record(4, 'ok'),
      ],
      earlier: null,
    })
    const card = html.slice(html.indexOf('近 1 小时拒绝'))
    expect(card).toContain('<div class="stat-num">2</div>')
    expect(card).toContain('<span class="tone-warn">丢弃 1</span>')
    expect(card).toContain(
      'href="/audit?window=1h&amp;outcome=refused" data-nav>查看',
    )
  })

  test('a window fuller than one read says the count is a floor', async () => {
    const h = pageHarness()
    const html = await overview(h, {
      records: [record(9, 'refused')],
      earlier: 8,
    })
    expect(html).toContain('<div class="stat-num">1+</div>')
    expect(html).toContain('丢弃 0+')
  })

  test('an unreadable trail is said, not counted as zero', async () => {
    const h = pageHarness()
    h.audit.readResult = {
      ok: false,
      failure: { code: 'unreachable', message: 'x' },
    }
    const html = await (await h.handle(browse('/', ADMIN))).text()
    const card = html.slice(html.indexOf('近 1 小时拒绝'))
    expect(card).toContain('<div class="stat-num">—</div>')
    expect(card).toContain('读不到审计链')
  })

  test('stale and expired agents are named on the agent card, and only when there are any', async () => {
    const h = pageHarness()
    h.registry.listResult = {
      ok: true,
      value: [
        agentAt('qianmo://tokyo-1/planner'),
        agentAt('qianmo://tokyo-1/late', {
          lastHeartbeatAt: NOW - 200_000,
          expiresAt: NOW - 110_000,
        }),
      ],
    }
    const html = await overview(h)
    const card = html.slice(
      html.indexOf('card-kicker">智能体'),
      html.indexOf('card-kicker">消息链'),
    )
    expect(card).toContain('在线 1')
    expect(card).toMatch(/(滞后|过期) 1/)
    const calm = await overview(pageHarness())
    const calmCard = calm.slice(
      calm.indexOf('card-kicker">智能体'),
      calm.indexOf('card-kicker">消息链'),
    )
    expect(calmCard).not.toContain('滞后')
    expect(calmCard).not.toContain('过期')
  })

  test('with chat and no certificate source, the fourth card is the conversations', async () => {
    const h = pageHarness({ chat: true })
    const html = await overview(h)
    expect(html).toContain('class="cards g4"')
    expect(html).toContain('近 1 小时会话')
  })
})

describe('A2 · the certificate card', () => {
  test('counts, the ones that need a look, and the revocation list', () => {
    const base = {
      roster: '',
      audit: '',
      recent: { refused: 0, dropped: 0, more: false },
      now: NOW,
      nodes: '',
    }
    const valid = { node: 'tokyo-1', status: 'valid' } as ConsoleCertificate
    const expiring = {
      node: 'osaka-1',
      status: 'expiring',
    } as ConsoleCertificate
    const healthy = renderOverview({
      ...base,
      certificates: {
        snapshot: {
          certificates: [valid, valid],
          revocationList: {
            issuedAt: NOW - 1,
            nextUpdate: NOW + HOUR_MS,
            revokedCount: 3,
          },
        },
        failure: null,
      },
    })
    expect(healthy).toContain('class="cards g4"')
    expect(healthy).toContain('2 张证书有效')
    expect(healthy).toContain('已吊销 3')
    const attention = renderOverview({
      ...base,
      certificates: {
        snapshot: {
          certificates: [valid, expiring],
          revocationList: {
            issuedAt: NOW - 2,
            nextUpdate: NOW - 1,
            revokedCount: 0,
          },
        },
        failure: null,
      },
    })
    expect(attention).toContain('1 张证书需注意')
    expect(attention).toContain('吊销清单已过期')
    const never = renderOverview({
      ...base,
      certificates: {
        snapshot: { certificates: [valid], revocationList: null },
        failure: null,
      },
    })
    expect(never).toContain('吊销清单未发布')
    const down = renderOverview({
      ...base,
      certificates: {
        snapshot: null,
        failure: { code: 'unreachable', message: 'x' },
      },
    })
    expect(down).toContain('读不到证书目录')
  })
})

const HOUR_MS = 3_600_000
