// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The P1 items of `console-audit.md` §4 that can be shown without a browser
 * (P18.14): what a whole page says once the handler has drawn it. The browser
 * half is `browser/p1.browser.test.ts`; the copy rules are `copyGate.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { ADMIN, VIEW, browse, pageHarness, visibleText } from './pageHarness.js'

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
