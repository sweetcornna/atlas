// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The P1 items of `console-audit.md` §4 that can be shown without a browser
 * (P18.14): what a whole page says once the handler has drawn it. The browser
 * half is `browser/p1.browser.test.ts`; the copy rules are `copyGate.test.ts`.
 */

import { AuditSource, type AuditRecord } from '@qianmo/audit'
import { describe, expect, test } from 'bun:test'
import { CONSOLE_CSS } from '../src/assets/css.js'
import type {
  AuditPage,
  ConsoleAbout,
  ConsoleCertificate,
} from '../src/deps.js'
import { createConsoleHandler } from '../src/http.js'
import { renderOverview } from '../src/view/page.js'
import {
  ADMIN,
  NOW,
  TOKENS,
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

describe('A4 · the settings page says which console this is', () => {
  const ABOUT: ConsoleAbout = {
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    registryUrl: 'http://127.0.0.1:38610',
    auditTrails: ['tokyo-1=/srv/qm/tokyo-1/audit.ndjson'],
    wake: 'disabled (no --wake-url)',
    chat: 'enabled as qianmo://console/operator (signed) -> tokyo-1 -> ws://127.0.0.1:38611/',
    paths: [['对话记录', '/srv/qm/console/chat.ndjson']],
  }

  async function settings(token: string, about?: ConsoleAbout) {
    const h = pageHarness()
    const deps = about === undefined ? h.deps : { ...h.deps, about }
    const handle = createConsoleHandler(deps, TOKENS)
    return await (await handle(browse('/settings', token))).text()
  }

  test('the build, the registry, the trails and both signing states, from the host', async () => {
    const html = await settings(ADMIN, ABOUT)
    for (const fact of [
      '>构建<',
      ABOUT.sourceCommit,
      '>注册中心<',
      'http://127.0.0.1:38610',
      'tokyo-1=/srv/qm/tokyo-1/audit.ndjson',
      'disabled (no --wake-url)',
    ]) {
      expect(html).toContain(fact)
    }
    const signing = html.slice(html.indexOf('>唤醒签名<'))
    expect(signing).toContain('未开启')
    const chat = html.slice(html.indexOf('>对话签名<'))
    expect(chat.slice(0, 200)).toContain('已开启')
  })

  test('whether the wires answer: the registry and each trail, read just now', async () => {
    const h = pageHarness()
    h.registry.listResult = {
      ok: false,
      failure: { code: 'unreachable', message: 'x' },
    }
    const html = await (await h.handle(browse('/settings', ADMIN))).text()
    const health = html.slice(html.indexOf('about-health'))
    expect(health).toMatch(
      /注册中心<\/dt><dd class="plain"><span class="tag[^"]*">不可达/,
    )
    expect(health).toMatch(
      /审计链 · [^<]+<\/dt><dd class="plain"><span class="tag[^"]*">可达/,
    )
  })

  test('the files it writes are shown to a writer only, and no secret is on the page', async () => {
    const admin = await settings(ADMIN, ABOUT)
    expect(admin).toContain('/srv/qm/console/chat.ndjson')
    const view = await settings(VIEW, ABOUT)
    expect(view).not.toContain('/srv/qm/console/chat.ndjson')
    expect(view).toContain('数据路径仅对运维可见')
    for (const html of [admin, view]) {
      const text = visibleText(html)
      expect(text).not.toContain(ADMIN)
      expect(text).not.toContain(VIEW)
    }
  })

  test('without a host that says, the page keeps what the package knows', async () => {
    const html = await settings(ADMIN)
    expect(html).toContain('>实例<')
    expect(html).not.toContain('>构建<')
  })
})

describe('B1 · the token pairs keep 4.5:1, in both schemes, without a browser', () => {
  // The browser test (`browser/contrast.browser.test.ts`) measures every text
  // on every page; this holds the token table itself where Chrome is absent.
  type Rgb = readonly [number, number, number]

  function tokens(block: string): Map<string, string> {
    const out = new Map<string, string>()
    for (const match of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
      out.set(match[1] ?? '', (match[2] ?? '').trim())
    }
    return out
  }

  const light = tokens(CONSOLE_CSS.slice(0, CONSOLE_CSS.indexOf('@media')))
  const darkBlock = CONSOLE_CSS.slice(
    CONSOLE_CSS.indexOf('@media (prefers-color-scheme: dark)'),
  )
  const dark = new Map([
    ...light,
    ...tokens(darkBlock.slice(0, darkBlock.indexOf('\n}\n'))),
  ])

  function hex(value: string): Rgb {
    const h = value.replace('#', '')
    return [0, 2, 4].map(i =>
      Number.parseInt(h.slice(i, i + 2), 16),
    ) as unknown as Rgb
  }

  /** A token's colour, with `var()` followed and `color-mix(… transparent)` laid over `ground`. */
  function colour(table: Map<string, string>, name: string, ground: Rgb): Rgb {
    const value = table.get(name) ?? ''
    const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value)
    if (ref) return colour(table, ref[1] ?? '', ground)
    const mix =
      /^color-mix\(in srgb, var\(--([a-z0-9-]+)\) (\d+)%, transparent\)$/.exec(
        value,
      )
    if (mix) {
      const ink = colour(table, mix[1] ?? '', ground)
      const a = Number(mix[2]) / 100
      return ink.map(
        (v, i) => v * a + (ground[i] ?? 0) * (1 - a),
      ) as unknown as Rgb
    }
    return hex(value)
  }

  function ratio(a: Rgb, b: Rgb): number {
    const lum = (c: Rgb) =>
      c
        .map(v => {
          const s = v / 255
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        })
        .reduce((sum, v, i) => sum + v * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0)
    const [l1, l2] = [lum(a), lum(b)]
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }

  /** [text token, ground token] pairs the sheet actually paints. */
  const PAIRS: readonly (readonly [string, string])[] = [
    ['color-text', 'color-bg'],
    ['color-text', 'color-surface'],
    ...[
      'color-bg',
      'color-surface',
      'color-neutral-100',
      'color-neutral-200',
      'color-neutral-300',
    ].flatMap(
      ground =>
        [
          ['color-muted', ground],
          ['color-quiet', ground],
        ] as const,
    ),
    ['color-accent-700', 'color-bg'],
    ['color-accent-700', 'color-surface'],
    ['color-bg', 'color-accent-fill'],
    ['color-bg', 'color-accent-fill-hover'],
    ['color-bg', 'color-accent-fill-active'],
    ['color-accent-800', 'color-accent-100'],
    ['color-accent-2-800', 'color-bg'],
    ['color-accent-2-800', 'color-accent-2-200'],
    ['color-critical', 'color-bg'],
  ]

  for (const [scheme, table] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    test(scheme, () => {
      const short: string[] = []
      for (const [ink, ground] of PAIRS) {
        const under = colour(table, ground, [0, 0, 0])
        const value = ratio(colour(table, ink, under), under)
        if (value < 4.5) short.push(`${ink} on ${ground}: ${value.toFixed(2)}`)
      }
      expect(short).toEqual([])
    })
  }

  test('positive control: the old values would fail', () => {
    const old = new Map(light)
    old.set(
      'color-muted',
      'color-mix(in srgb, var(--color-text) 55%, transparent)',
    )
    old.set('color-accent-fill', 'var(--color-accent)')
    const surface = colour(old, 'color-surface', [0, 0, 0])
    expect(ratio(colour(old, 'color-muted', surface), surface)).toBeLessThan(
      4.5,
    )
    const fill = colour(old, 'color-accent-fill', [0, 0, 0])
    expect(ratio(colour(old, 'color-bg', fill), fill)).toBeLessThan(4.5)
  })
})

describe('D6 · the roster can be searched and filtered, without a script', () => {
  function rows(html: string): string[] {
    const at = html.indexOf('id="roster"')
    const roster = at < 0 ? html : html.slice(at)
    return [...roster.matchAll(/<details class="row" data-key="([^"]+)"/g)].map(
      match => match[1] ?? '',
    )
  }

  const servers = [
    { node: 'tokyo-1', server: 'p11' },
    { node: 'osaka-1', server: 'p12' },
  ]

  test('a search keeps the matching rows, counts what it hid, and the poll replays it', async () => {
    const h = pageHarness({ nodeServers: servers })
    const html = await (await h.handle(browse('/nodes?q=OSAKA', ADMIN))).text()
    expect(rows(html)).toEqual(['qianmo://osaka-1/writer'])
    expect(html).toContain('筛选后 1 · 共 3')
    expect(html).toContain('data-poll="/fragments/roster?q=OSAKA"')
    expect(html).toContain(
      '<form id="roster-filter" class="roster-filter" method="get" action="/nodes" role="search">',
    )
    expect(html).toContain('value="OSAKA"')
    // The wake picker still offers every address: the filter is a view.
    const picker = html.slice(html.indexOf('id="wake-to"'))
    expect(picker).toContain('qianmo://tokyo-1/planner')
    const fragment = await (
      await h.handle(browse('/fragments/roster?q=OSAKA', ADMIN))
    ).text()
    expect(rows(fragment)).toEqual(['qianmo://osaka-1/writer'])
    // The count is inside the polled fragment, so a refresh recounts it.
    expect(fragment).toContain('筛选后 1 · 共 3')
  })

  test('by state, judged as the rows judge it, and by server', async () => {
    const h = pageHarness({ nodeServers: servers })
    h.registry.listResult = {
      ok: true,
      value: [
        agentAt('qianmo://tokyo-1/planner'),
        agentAt('qianmo://tokyo-1/gone', {
          lastHeartbeatAt: NOW - 900_000,
          expiresAt: NOW - 810_000,
        }),
        agentAt('qianmo://osaka-1/writer'),
      ],
    }
    const expired = await (
      await h.handle(browse('/nodes?state=expired', ADMIN))
    ).text()
    expect(rows(expired)).toEqual(['qianmo://tokyo-1/gone'])
    expect(expired).toContain('<option value="expired" selected>过期</option>')
    const p12 = await (
      await h.handle(browse('/nodes?server=p12', ADMIN))
    ).text()
    expect(rows(p12)).toEqual(['qianmo://osaka-1/writer'])
    expect(p12).toContain('<option value="p12" selected>p12</option>')
  })

  test('nothing matching says so and offers the way back; nonsense is ignored', async () => {
    const h = pageHarness()
    const none = await (
      await h.handle(browse('/nodes?q=nowhere', ADMIN))
    ).text()
    expect(rows(none)).toEqual([])
    expect(none).toContain('没有符合筛选的智能体 · 共 3 个')
    expect(none).toContain('href="/nodes" data-nav>清除筛选')
    expect(none).not.toContain('注册第一个')
    const odd = await (
      await h.handle(browse('/nodes?state=sideways', ADMIN))
    ).text()
    expect(rows(odd)).toHaveLength(3)
    expect(odd).toContain('data-poll="/fragments/roster"')
    // No server select on a console that does not know its servers.
    expect(odd).not.toContain('id="roster-server"')
  })
})
