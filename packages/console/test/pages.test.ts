// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every page of the console, through the router, as a browser gets it.
 *
 * One table of paths, and each claim checked against every row: the page is
 * a whole server-rendered document; what it says is in the markup rather than
 * fetched by a script afterwards; it keeps the copy rules and loads nothing
 * from anywhere. A page added to the route table without a row here fails the
 * first test, so "every URL renders on the server" stays a property of the
 * table rather than of the pages somebody remembered to check.
 */

import { describe, expect, test } from 'bun:test'
import { ROUTES } from '../src/routes/index.js'
import { STUB_LINE } from '../src/routes/stub.js'
import {
  ADMIN,
  LABEL,
  TRACE,
  VIEW,
  browse,
  pageHarness,
  visibleText,
  withoutScripts,
} from './pageHarness.js'

interface PageRow {
  readonly path: string
  readonly title: string
  readonly active: string
  /** Text that must be in the markup itself, before any script runs. */
  readonly reads: readonly string[]
}

const PAGES: readonly PageRow[] = [
  {
    path: '/',
    title: '总览',
    active: 'overview',
    reads: [
      '运行概况',
      '<div class="stat-num">3</div>',
      'href="/nodes/tokyo-1"',
    ],
  },
  {
    path: '/nodes',
    title: '节点',
    active: 'nodes',
    reads: [
      '名册',
      'qianmo://tokyo-1/',
      'qianmo://osaka-1/',
      'id="register-dialog"',
    ],
  },
  {
    path: '/nodes/tokyo-1',
    title: 'tokyo-1',
    active: 'nodes',
    reads: ['名册', 'qianmo://tokyo-1/'],
  },
  {
    path: '/chat',
    title: '对话',
    active: 'chat',
    reads: ['会话', 'id="composer"'],
  },
  {
    path: '/audit',
    title: '消息链',
    active: 'audit',
    reads: ['消息链', 'id="audit-filter"', 'data-trace="4bf92f'],
  },
  {
    path: `/audit/trace/${TRACE}`,
    title: '消息链详情',
    active: 'audit',
    reads: ['class="hops"'],
  },
  { path: '/alerts', title: '告警', active: 'alerts', reads: [STUB_LINE] },
  { path: '/jobs', title: '值守作业', active: 'jobs', reads: [STUB_LINE] },
  {
    path: '/approvals',
    title: '审批',
    active: 'approvals',
    reads: [STUB_LINE],
  },
  {
    path: '/providers',
    title: '模型服务',
    active: 'providers',
    reads: [STUB_LINE],
  },
  {
    path: '/servers',
    title: '服务器',
    active: 'servers',
    reads: ['p11', 'tokyo-1'],
  },
  {
    path: '/access',
    title: '账号与访问',
    active: 'access',
    reads: [STUB_LINE],
  },
  { path: '/usage', title: '用量', active: 'usage', reads: [STUB_LINE] },
  {
    path: '/settings',
    title: '设置与关于',
    active: 'settings',
    reads: ['限额', 'id="limits"', LABEL, 'qianmo://tokyo-hub/console'],
  },
]

function harness() {
  return pageHarness({
    chat: true,
    nodeServers: [
      { node: 'tokyo-1', server: 'p11' },
      { node: 'osaka-1', server: 'p12' },
    ],
  })
}

async function read(path: string, token = ADMIN): Promise<string> {
  const response = await harness().handle(browse(path, token))
  expect(`${path} ${response.status}`).toBe(`${path} 200`)
  return await response.text()
}

describe('every page', () => {
  test('every area of the route table has a row here', () => {
    for (const module of ROUTES) {
      expect(PAGES.some(row => row.path === module.area.href)).toBe(true)
    }
  })

  test('is a whole document rendered by the server, the area marked current', async () => {
    for (const row of PAGES) {
      const response = await harness().handle(browse(row.path, ADMIN))
      expect(`${row.path} ${response.status}`).toBe(`${row.path} 200`)
      expect(response.headers.get('content-type')).toBe(
        'text/html; charset=utf-8',
      )
      const html = await response.text()
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
      expect(html).toContain(
        `<title>阡陌 console · ${row.title} · ${LABEL}</title>`,
      )
      expect(html).toContain(
        `<h1 class="page-title" id="page-title">${row.title}</h1>`,
      )
      expect(html).toContain(`id="nav-${row.active}" href="`)
      expect(
        html.match(
          new RegExp(
            `id="nav-${row.active}" href="[^"]*" data-nav aria-current="page"`,
          ),
        ),
      ).not.toBeNull()
    }
  })

  test('reads without script: the content is in the markup, the navigation is links', async () => {
    for (const row of PAGES) {
      const bare = withoutScripts(await read(row.path))
      expect(bare).not.toContain('<script')
      for (const text of row.reads) {
        expect(`${row.path} ${bare.includes(text)} ${text}`).toBe(
          `${row.path} true ${text}`,
        )
      }
      // Every area is a plain link to its own path: navigation is the
      // browser's, not the script's.
      for (const module of ROUTES) {
        expect(bare).toContain(
          `id="nav-${module.area.id}" href="${module.area.href}"`,
        )
      }
    }
  })

  test('keeps the copy rules: no 。，、 no exclamation, no emoji', async () => {
    for (const row of PAGES) {
      const text = visibleText(await read(row.path))
      for (const banned of ['。', '，', '、', '！', '!']) {
        expect(`${row.path} ${text.includes(banned)} ${banned}`).toBe(
          `${row.path} false ${banned}`,
        )
      }
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })

  test('loads nothing from anywhere, and carries one style and one script', async () => {
    for (const row of PAGES) {
      const html = await read(row.path)
      const stripped = html.replace(/<link rel="icon"[^>]*>\n?/, '')
      expect(stripped).not.toContain('<link')
      expect(stripped).not.toContain('http://')
      expect(stripped).not.toContain('https://')
      expect(stripped).not.toContain('src="')
      expect(stripped).not.toContain('<iframe')
      expect(html.split('<style>')).toHaveLength(2)
      expect(html.split('<script>')).toHaveLength(2)
    }
  })

  test("the page script is the page's own: no page carries another's", async () => {
    const nodes = await read('/nodes')
    const audit = await read('/audit')
    const servers = await read('/servers')
    const overview = await read('/')
    expect(nodes).toContain("qc.onSubmit('register-form', onRegister)")
    expect(audit).not.toContain("qc.onSubmit('register-form'")
    expect(audit).toContain("qc.onAction('chain', openChain)")
    expect(servers).toContain("qc.onAction('server-note', onServerNote)")
    expect(overview).not.toContain('qc.onAction(')
  })

  test('every section is a stacked header over its own body', async () => {
    for (const [path, kickers] of [
      ['/', ['Overview', 'Nodes']],
      ['/nodes', ['Roster']],
      ['/audit', ['Trail']],
      ['/settings', ['Instance', 'Limits']],
    ] as const) {
      const html = await read(path)
      const body = html.slice(html.indexOf('<main'))
      expect(body).not.toContain('class="rail"')
      for (const kicker of kickers) {
        expect(
          `${path} ${body.includes(`<div class="kicker">${kicker}</div>`)}`,
        ).toBe(`${path} true`)
      }
    }
  })
})

describe('placeholders', () => {
  const STUBS = ROUTES.filter(module => module.area.pending === true)

  test('there are six, and each says so in one line and polls nothing', async () => {
    expect(STUBS.map(module => module.area.id)).toEqual([
      'alerts',
      'jobs',
      'approvals',
      'providers',
      'access',
      'usage',
    ])
    for (const module of STUBS) {
      const html = await read(module.area.href)
      const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'))
      expect(main).toContain(STUB_LINE)
      expect(main).not.toContain('<form')
      expect(html).not.toContain('data-poll=')
      expect(html).not.toContain('id="auto-refresh"')
    }
  })

  test('the sidebar marks every placeholder, on every page', async () => {
    const html = await read('/')
    for (const module of STUBS) {
      expect(html).toContain(
        `<span class="nav-label">${module.area.label}</span><span class="nav-tag">未提供</span>`,
      )
    }
  })

  test('nothing under a placeholder is a page', async () => {
    const { handle } = harness()
    expect((await handle(browse('/alerts/x', ADMIN))).status).toBe(404)
  })
})

describe('the doors in front of the pages', () => {
  test('an anonymous browser is sent to the login door with the way back', async () => {
    const { handle } = harness()
    for (const row of PAGES) {
      const response = await handle(browse(row.path))
      expect(`${row.path} ${response.status}`).toBe(`${row.path} 303`)
      expect(response.headers.get('location')).toBe(
        row.path === '/'
          ? '/login'
          : `/login?redirect=${encodeURIComponent(row.path)}`,
      )
    }
  })

  test('a script without a credential keeps its 401', async () => {
    const { handle } = harness()
    for (const row of PAGES) {
      const response = await handle(
        new Request(`http://console.test${row.path}`),
      )
      expect(`${row.path} ${response.status}`).toBe(`${row.path} 401`)
    }
  })

  test('a page answers GET and nothing else', async () => {
    const { handle } = harness()
    for (const row of PAGES) {
      const response = await handle(browse(row.path, ADMIN, 'POST'))
      expect(`${row.path} ${response.status}`).toBe(`${row.path} 405`)
      expect(response.headers.get('allow')).toBe('GET')
    }
  })

  test('a view token reads every page except the conversation', async () => {
    const { handle } = harness()
    for (const row of PAGES) {
      const response = await handle(browse(row.path, VIEW))
      const expected = row.active === 'chat' ? 403 : 200
      expect(`${row.path} ${response.status}`).toBe(`${row.path} ${expected}`)
    }
  })
})

describe('one node, one trace', () => {
  test('a node page shows that node alone and polls that node alone', async () => {
    const html = await read('/nodes/tokyo-1')
    expect(html).toContain('qianmo://tokyo-1/')
    expect(html).not.toContain('qianmo://osaka-1/')
    expect(html).toContain('data-poll="/fragments/roster?node=tokyo-1"')
    expect(html).toContain('<li><a href="/nodes" data-nav>节点</a></li>')
    expect(html).toContain('<li aria-current="page">tokyo-1</li>')

    const { handle } = harness()
    const fragment = await (
      await handle(browse('/fragments/roster?node=tokyo-1', ADMIN))
    ).text()
    expect(fragment).toContain('qianmo://tokyo-1/')
    expect(fragment).not.toContain('qianmo://osaka-1/')
  })

  test('a node the registry does not list is a 404, a malformed one too', async () => {
    const { handle } = harness()
    expect((await handle(browse('/nodes/nowhere', ADMIN))).status).toBe(404)
    expect((await handle(browse('/nodes/%E0%A4%A', ADMIN))).status).toBe(404)
  })

  test("a registry that cannot be read is the roster's strip, not a 404", async () => {
    const h = harness()
    h.registry.listResult = {
      ok: false,
      failure: { code: 'unreachable', message: '连接被拒绝' },
    }
    const response = await h.handle(browse('/nodes/tokyo-1', ADMIN))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('注册中心不可达 · 连接被拒绝')
  })

  test('a trace page is the chain, and a trace the trail does not hold is a 404', async () => {
    const html = await read(`/audit/trace/${TRACE}`)
    expect(html).toContain('class="hops"')
    expect(html).toContain('<li><a href="/audit" data-nav>消息链</a></li>')
    const { handle } = harness()
    const missing = await handle(browse('/audit/trace/ffff', ADMIN))
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('未找到该 trace')
  })
})

describe('the trail page', () => {
  test('the poller replays the current filter, escaped, as a query string', async () => {
    const html = await read(
      `/audit?source=router&traceId=${encodeURIComponent('" onload="alert(1)')}&limit=25&from=1699996400000`,
    )
    const poll = /id="audit" data-poll="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(poll.startsWith('/fragments/audit?')).toBe(true)
    expect(poll).toContain('source=router')
    expect(poll).toContain('limit=25')
    expect(poll).toContain('from=1699996400000')
    expect(html).not.toContain('" onload="')
    expect(html).toContain('data-swap="audit-rail audit-results"')
  })

  test('an empty filter polls the bare fragment rather than a stray question mark', async () => {
    const html = await read('/audit')
    expect(html).toContain('data-poll="/fragments/audit"')
  })

  test('the node filter offers the addresses the registry lists', async () => {
    const html = await read('/audit')
    expect(html).toContain('<option value="qianmo://osaka-1/writer">')
  })
})

describe('the shell around every page', () => {
  test('one registry read serves the sidebar, the health strip and the page', async () => {
    for (const path of ['/', '/nodes', '/audit', '/settings', '/alerts']) {
      const h = harness()
      await h.handle(browse(path, ADMIN))
      expect(`${path} ${h.registry.listCalls}`).toBe(`${path} 1`)
    }
  })

  test('a registry that cannot be read still opens every page, and says so on top', async () => {
    const h = harness()
    h.registry.listResult = {
      ok: false,
      failure: { code: 'unreachable', message: '连接被拒绝' },
    }
    for (const row of PAGES) {
      if (row.path === '/nodes/tokyo-1') continue
      const response = await h.handle(browse(row.path, ADMIN))
      expect(`${row.path} ${response.status}`).toBe(`${row.path} 200`)
      expect(await response.text()).toContain('注册中心不可达')
    }
  })

  test('the conversation is not offered to a token that may not open it', async () => {
    const h = harness()
    const asView = await (await h.handle(browse('/', VIEW))).text()
    expect(asView).not.toContain('id="nav-chat"')
    const asAdmin = await (await h.handle(browse('/', ADMIN))).text()
    expect(asAdmin).toContain('id="nav-chat"')
  })
})
