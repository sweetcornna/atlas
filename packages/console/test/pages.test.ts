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
import { CONSOLE_CHAT_JS } from '../src/assets/chatClient.js'
import { CONSOLE_CLIENT_JS } from '../src/assets/client.js'
import { CSP, DOCUMENT_CSP, html } from '../src/respond.js'
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
  {
    path: '/jobs',
    title: '值守作业',
    active: 'jobs',
    reads: ['调度器', '调度器心跳未接入', '急停'],
  },
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

  test('there are five, and each says so in one line and polls nothing', async () => {
    expect(STUBS.map(module => module.area.id)).toEqual([
      'alerts',
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

  test('the count beside 节点 is nodes, not agents (A5)', async () => {
    // Three agents on two machines. The overview's 智能体 card says 3; the
    // sidebar item named 节点 says 2.
    const h = harness()
    const html = await (await h.handle(browse('/', ADMIN))).text()
    expect(html).toContain(
      '<span class="nav-label">节点</span><span class="cnt">2</span>',
    )
    expect(html).toContain('<div class="card-kicker">智能体</div>')
    expect(html).toContain('<div class="stat-num">3</div>')
    // An empty registry is 0; an unreadable one is no number at all.
    h.registry.listResult = { ok: true, value: [] }
    expect(await (await h.handle(browse('/', ADMIN))).text()).toContain(
      '<span class="nav-label">节点</span><span class="cnt">0</span>',
    )
    h.registry.listResult = {
      ok: false,
      failure: { code: 'unreachable', message: '连接被拒绝' },
    }
    expect(await (await h.handle(browse('/', ADMIN))).text()).toContain(
      '<span class="nav-label">节点</span></a>',
    )
  })

  test('the conversation is not offered to a token that may not open it', async () => {
    const h = harness()
    const asView = await (await h.handle(browse('/', VIEW))).text()
    expect(asView).not.toContain('id="nav-chat"')
    const asAdmin = await (await h.handle(browse('/', ADMIN))).text()
    expect(asAdmin).toContain('id="nav-chat"')
  })
})

describe('framing (H1)', () => {
  function framingOf(response: Response): readonly [string, string] {
    return [
      response.headers.get('content-security-policy') ?? '',
      response.headers.get('x-frame-options') ?? '',
    ]
  }

  test('every page refuses to be framed, in both headers', async () => {
    const { handle } = harness()
    for (const row of PAGES) {
      const response = await handle(browse(row.path, ADMIN))
      const [policy, xfo] = framingOf(response)
      expect(`${row.path} ${policy}`).toBe(`${row.path} ${DOCUMENT_CSP}`)
      expect(`${row.path} ${xfo}`).toBe(`${row.path} DENY`)
    }
  })

  test('the header policy is the <meta> policy plus frame-ancestors', async () => {
    expect(DOCUMENT_CSP).toBe(`${CSP}; frame-ancestors 'none'`)
    // The meta copy stays, without the directive a meta cannot carry.
    const page = await read('/')
    expect(page).toContain('<meta http-equiv="Content-Security-Policy"')
    expect(page).not.toContain('frame-ancestors')
  })

  test('the login door and the in-place login card refuse it too', async () => {
    const { handle } = harness()
    for (const request of [
      browse('/login'),
      // A view token asking for the conversation: the login card, in place.
      browse('/chat', VIEW),
    ]) {
      const response = await handle(request)
      expect(response.headers.get('content-type')).toBe(
        'text/html; charset=utf-8',
      )
      expect(framingOf(response)).toEqual([DOCUMENT_CSP, 'DENY'])
    }
  })

  test('every document helper carries them, so the invitation pages do', () => {
    expect(framingOf(html('<!DOCTYPE html>'))).toEqual([DOCUMENT_CSP, 'DENY'])
  })
})

describe('errors a browser navigates into are pages (C3)', () => {
  function text(html: string): string {
    return visibleText(html)
  }

  test('an unknown path, signed in: a 404 page in the shell, with the way back', async () => {
    const { handle } = harness()
    const response = await handle(browse('/nope', ADMIN))
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    )
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    const html = await response.text()
    expect(html).toContain(
      '<h1 class="page-title" id="page-title">页面不存在</h1>',
    )
    expect(html).toContain('class="nav-item"')
    expect(html).toContain('<a class="jump" href="/" data-nav>回到总览</a>')
    // No area is marked current on a page that is no area's.
    expect(
      html.slice(html.indexOf('<body>'), html.indexOf('<script>')),
    ).not.toContain('data-nav aria-current="page"')
  })

  test('an unknown path, signed out: the same page on the login panel, no sidebar', async () => {
    const { handle } = harness()
    const response = await handle(browse('/nope'))
    expect(response.status).toBe(404)
    const html = await response.text()
    expect(html).toContain('页面不存在')
    expect(html).toContain('href="/login">去登录</a>')
    expect(html).not.toContain('class="nav-item"')
    expect(html).not.toContain('<script')
  })

  test('a script keeps its JSON, on any path and on the data paths whatever it accepts', async () => {
    const { handle } = harness()
    const script = await handle(
      new Request('http://console.test/nope', {
        headers: { authorization: `Bearer ${ADMIN}` },
      }),
    )
    expect(script.status).toBe(404)
    expect(script.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
    for (const path of ['/v0/nope', '/fragments/nope', '/assets/nope.js']) {
      const response = await handle(browse(path, ADMIN))
      expect(`${path} ${response.headers.get('content-type')}`).toBe(
        `${path} application/json; charset=utf-8`,
      )
    }
  })

  test('a page this console does not have, a node that is not there, a HEAD', async () => {
    const noChat = pageHarness()
    const chat = await noChat.handle(browse('/chat', ADMIN))
    expect(chat.status).toBe(404)
    expect(await chat.text()).toContain('页面不存在')

    const { handle } = harness()
    const node = await handle(browse('/nodes/nowhere', ADMIN))
    expect(node.status).toBe(404)
    expect(await node.text()).toContain('页面不存在')

    const head = await handle(browse('/nodes', ADMIN, 'HEAD'))
    expect(head.status).toBe(405)
    expect(head.headers.get('allow')).toBe('GET')
    expect(head.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  test('a port that throws: a 500 page without the shell, the detail folded away', async () => {
    const h = pageHarness()
    h.registry.list = () => Promise.reject(new Error('registry exploded'))
    const page = await h.handle(browse('/nodes', ADMIN))
    expect(page.status).toBe(500)
    const html = await page.text()
    expect(html).toContain('控制台内部错误')
    expect(html).toContain('<summary>')
    expect(html).toContain('registry exploded')
    expect(html).not.toContain('class="nav-item"')
    // A script still gets the JSON it can parse.
    const json = await h.handle(
      new Request('http://console.test/v0/agents', {
        headers: { authorization: `Bearer ${ADMIN}` },
      }),
    )
    expect(json.status).toBe(500)
    expect(await json.json()).toMatchObject({ error: { code: 'internal' } })
  })

  test('every error page keeps the copy rules', async () => {
    const { handle } = harness()
    for (const request of [
      browse('/nope', ADMIN),
      browse('/nope'),
      browse('/nodes', ADMIN, 'HEAD'),
    ]) {
      const visible = text(await (await handle(request)).text())
      for (const banned of ['。', '，', '、', '！']) {
        expect(visible.includes(banned)).toBe(false)
      }
    }
  })
})

describe('a session that lapses under the page (C1)', () => {
  test('every page carries the expiry dialog, closed, with the way back to itself', async () => {
    for (const [path, back] of [
      ['/', '/login'],
      ['/nodes', '/login?redirect=%2Fnodes'],
      ['/audit?window=24h', '/login?redirect=%2Faudit%3Fwindow%3D24h'],
    ] as const) {
      const html = await read(
        `${path}${path.includes('?') ? '&' : '?'}token=${ADMIN}`,
      )
      expect(html).toContain('<dialog class="dialog" id="session-expired"')
      expect(html).not.toContain('id="session-expired" open')
      // The token the page was opened with never rides along.
      expect(html).toContain(
        `<a class="btn btn-primary" id="session-expired-login" href="${back.replaceAll('&', '&amp;')}">重新登录</a>`,
      )
    }
  })

  test('the runtime stops asking after the first 401, and opens the dialog', () => {
    const runtime = CONSOLE_CLIENT_JS
    expect(runtime).toContain(
      'if (res.status === 401) { expire(); throw new Error(EXPIRED); }',
    )
    // Both transports refuse without leaving the browser once expired.
    expect(runtime.match(/if \(expired\) return refused\(\);/g)).toHaveLength(2)
    expect(runtime).toContain(
      'clearInterval(refreshTimer); refreshTimer = null; }',
    )
    expect(runtime).toContain("openDialog('session-expired', null)")
    // The chat page's stream and fallback poller stop with it.
    expect(CONSOLE_CHAT_JS).toContain('qc.onExpire(function () {')
    expect(CONSOLE_CHAT_JS).toContain('source.close()')
  })
})
