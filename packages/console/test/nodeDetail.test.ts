// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One node's page (A3) and its lifecycle (J2), against P18.11's DoD:
 *
 * - every lifecycle action is a button that opens a confirmation, the
 *   confirmation is what sends, and each send leaves exactly one line in the
 *   action ledger — the page itself none;
 * - the 「模型」 tab points at `/fragments/providers/node/<node>` and links to
 *   `/providers?node=<node>` for a reader with no script;
 * - viewer, member, ops and the two legacy tokens: write controls only for
 *   the two that may write, and who changed an address only for them;
 * - every tab reads without script, and the copy keeps the console's rules.
 *
 * The browser half — the dialog really opening, the ledger really empty until
 * it is confirmed — is `browser/nodes.browser.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import type { ConsoleDeps } from '../src/deps.js'
import {
  ADMIN,
  VIEW,
  accountsHarness,
  asBearer,
  asSession,
  person,
} from './accountsHarness.js'
import {
  KYOTO,
  OLD,
  OPS_SUBJECT,
  PLANNER,
  REVIEWER,
  SCOUT,
  SLEEPER,
  StatefulLifecycle,
} from './lifecycleFake.js'
import { MemoryActionLedger } from './memoryActions.js'
import {
  AGENTS,
  PageAudit,
  PageRegistry,
  agentAt,
  visibleText,
  withoutScripts,
} from './pageHarness.js'

const TABS = [
  '/nodes/tokyo-1',
  '/nodes/tokyo-1/agents',
  '/nodes/tokyo-1/lifecycle',
  '/nodes/tokyo-1/models',
] as const

function scene(extra: Partial<ConsoleDeps> = {}) {
  const lifecycle = new StatefulLifecycle()
  const actions = new MemoryActionLedger()
  const registry = new PageRegistry()
  const h = accountsHarness({
    deps: {
      registry,
      audit: new PageAudit(),
      lifecycle,
      actions,
      nodeServers: [{ node: 'odd node/名', server: 'p11' }],
      ...extra,
    },
  })
  return { h, lifecycle, actions, registry }
}

async function page(
  h: ReturnType<typeof scene>['h'],
  path: string,
  token = ADMIN,
): Promise<string> {
  const response = await h.handle(
    new Request(`http://console.test${path}`, {
      headers: { accept: 'text/html', authorization: `Bearer ${token}` },
    }),
  )
  expect(`${path} ${response.status}`).toBe(`${path} 200`)
  return await response.text()
}

/** The `data-verb`s drawn on one row of the lifecycle table. */
function verbsOn(html: string, address: string): string[] {
  const start = html.indexOf(`<tr data-key="${address}"`)
  if (start === -1) throw new Error(`no row for ${address}`)
  const row = html.slice(start, html.indexOf('</tr>', start))
  return [...row.matchAll(/data-verb="([a-z]+)"/g)].map(match => match[1] ?? '')
}

/** One row's markup. */
function rowOf(html: string, address: string): string {
  const start = html.indexOf(`<tr data-key="${address}"`)
  return html.slice(start, html.indexOf('</tr>', start))
}

/** Everything in a document that would let its reader change something. */
function writeMarks(html: string): readonly string[] {
  const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '')
  const found: string[] = []
  if (/\sdata-write[\s>=]/.test(markup)) found.push('data-write')
  for (const marker of [
    'data-action="lifecycle"',
    'id="confirm-pause"',
    'id="confirm-publish"',
    'publish-dialog',
    'register-dialog',
    'wake-dialog',
  ]) {
    if (markup.includes(marker)) found.push(marker)
  }
  for (const form of markup.match(/<form[^>]*>/g) ?? []) {
    const plainGet = /method="get"/i.test(form)
    const logout = form.includes('id="logout-form"')
    if (!plainGet && !logout) found.push(form)
  }
  return found
}

describe('the lifecycle tab (J2)', () => {
  test('each address says its state, whether it can be reached, and why not', async () => {
    const { h } = scene()
    const html = await page(h, '/nodes/tokyo-1/lifecycle')
    const expectations: readonly (readonly [string, string])[] = [
      [PLANNER, '已发布 可拨 在名册上'],
      [REVIEWER, '未登记 可拨 在名册上'],
      [SCOUT, '未登记 不可拨 不在名册上'],
      [SLEEPER, '已暂停 不可拨 已暂停 · 恢复之前不拨'],
      [OLD, '已退役 不可拨 已退役 · 不再拨'],
    ]
    for (const [address, said] of expectations) {
      const row = visibleText(rowOf(html, address)).replace(/\s+/g, ' ')
      expect(`${address} ${row.includes(` ${said} `)}`).toBe(`${address} true`)
    }
    // Another node's addresses are not on this one's page.
    expect(html).not.toContain(KYOTO)
    expect(html).not.toContain('qianmo://osaka-1/')
    // The head counts what is blocked.
    expect(html).toContain('data-blocked="3"')
  })

  test('a paused seed the registry host still renews: on the roster, and still not dialled', async () => {
    const { h, registry } = scene()
    registry.listResult = { ok: true, value: [...AGENTS, agentAt(SLEEPER)] }
    const html = await page(h, '/nodes/tokyo-1/lifecycle')
    expect(visibleText(rowOf(html, SLEEPER)).replace(/\s+/g, ' ')).toContain(
      ' 不可拨 已暂停 · 恢复之前不拨 · 名册上仍在是因为注册中心宿主替种子续租 ',
    )
    expect(verbsOn(html, SLEEPER)).toEqual(['resume', 'retire'])
  })

  test('only the actions that will succeed are drawn (console.md §7.3.1)', async () => {
    const { h } = scene()
    const html = await page(h, '/nodes/tokyo-1/lifecycle')
    expect(verbsOn(html, PLANNER)).toEqual(['pause', 'retire'])
    // On the roster through the registry host: no publishing over it.
    expect(verbsOn(html, REVIEWER)).toEqual(['pause', 'retire'])
    expect(verbsOn(html, SCOUT)).toEqual(['publish', 'pause', 'retire'])
    expect(verbsOn(html, SLEEPER)).toEqual(['resume', 'retire'])
    expect(verbsOn(html, OLD)).toEqual([])
  })

  test('every action is a button that opens its confirmation; only the confirmation sends', async () => {
    const { h } = scene()
    const html = await page(h, '/nodes/tokyo-1/lifecycle')
    const buttons =
      html.match(/<button[^>]*data-action="lifecycle"[^>]*>/g) ?? []
    expect(buttons.length).toBe(9)
    for (const button of buttons) {
      // Not a submit, not a link: the click only opens a dialog
      // (`NODE_PAGE_JS`, `confirm`).
      expect(button).toContain('type="button"')
      expect(button).not.toContain('formaction')
    }
    for (const verb of ['publish', 'pause', 'resume', 'retire']) {
      expect(
        html.match(new RegExp(`<dialog[^>]*id="confirm-${verb}"`, 'g')),
      ).toHaveLength(1)
      expect(
        html.match(new RegExp(`data-action="confirm-${verb}"`, 'g')),
      ).toHaveLength(1)
      // The dialog is outside the polled region it acts on.
      expect(html.indexOf(`id="confirm-${verb}"`)).toBeGreaterThan(
        html.indexOf('</section>', html.indexOf('id="lifecycle"')),
      )
    }
    // The page script sends each verb only from its confirmation.
    expect(html).toContain(
      "qc.openDialog('confirm-' + verb, function () { send(verb, address); });",
    )
  })

  test('the four confirmed sends leave exactly one ledger line each, and reading leaves none', async () => {
    const { h, actions, lifecycle } = scene()
    for (const path of [...TABS, '/fragments/lifecycle/tokyo-1']) {
      await h.handle(asBearer('GET', path, ADMIN))
    }
    expect(actions.lines()).toEqual([])

    // What the script sends for each verb, as the page's buttons name them.
    const sends: readonly (readonly [string, string, unknown?])[] = [
      ['publish', '/v0/agents', { address: SCOUT }],
      ['pause', `/v0/agents/${encodeURIComponent(PLANNER)}/pause`],
      ['resume', `/v0/agents/${encodeURIComponent(SLEEPER)}/resume`],
      ['retire', `/v0/agents/${encodeURIComponent(REVIEWER)}/retire`],
    ]
    for (const [verb, path, body] of sends) {
      const response = await h.handle(asBearer('POST', path, ADMIN, body))
      expect(`${verb} ${response.status}`).toBe(`${verb} 200`)
    }
    expect(actions.lines()).toEqual([
      `agent.register ${SCOUT} ok`,
      `agent.pause ${PLANNER} ok`,
      `agent.resume ${SLEEPER} ok`,
      `agent.retire ${REVIEWER} ok`,
    ])
    expect(lifecycle.calls).toHaveLength(4)

    // …and the page reads the new states back.
    const after = await page(h, '/nodes/tokyo-1/lifecycle')
    expect(visibleText(rowOf(after, PLANNER))).toContain('已暂停')
    expect(visibleText(rowOf(after, SLEEPER))).toContain('已发布')
    expect(verbsOn(after, REVIEWER)).toEqual([])
  })

  test('a ledger that cannot be read: no action at all, and the reason on every row', async () => {
    const { h, lifecycle } = scene()
    lifecycle.problem = 'registrations.json 读不出来'
    const html = await page(h, '/nodes/tokyo-1/lifecycle')
    expect(html).toContain(
      '登记簿不可用 · registrations.json 读不出来 · 动作一律不收 · 出口一律不拨',
    )
    expect(html).not.toContain('data-action="lifecycle"')
    for (const address of [PLANNER, REVIEWER, SCOUT, SLEEPER, OLD]) {
      expect(visibleText(rowOf(html, address))).toContain(
        '登记簿不可用 · 修好之前出口一律不拨',
      )
    }
    const overview = visibleText(await page(h, '/nodes/tokyo-1'))
    expect(overview).toContain('登记簿不可用 · 出口一律不拨')
  })

  test('a ledger that only cannot be saved: the exits still judge each row, and only pause and retire are drawn', async () => {
    const { h, lifecycle } = scene()
    lifecycle.problem = 'could not write registrations.json'
    lifecycle.problemKind = 'unwritable'
    const html = await page(h, '/nodes/tokyo-1/lifecycle')
    expect(html).toContain(
      '写不进去 · 发布与恢复已停止 · 暂停与退役照收但重启后会丢',
    )
    expect(html).not.toContain('出口一律不拨')
    // What the exits do with the copy in memory, row by row.
    expect(visibleText(rowOf(html, PLANNER))).toContain('在名册上')
    expect(visibleText(rowOf(html, SLEEPER))).toContain('已暂停 · 恢复之前不拨')
    // Widening is refused (503), narrowing is still taken.
    expect(verbsOn(html, PLANNER)).toEqual(['pause', 'retire'])
    expect(verbsOn(html, SCOUT)).toEqual(['pause', 'retire'])
    expect(verbsOn(html, SLEEPER)).toEqual(['retire'])
    const overview = visibleText(await page(h, '/nodes/tokyo-1'))
    expect(overview).toContain('登记簿写不进去')
    expect(overview).not.toContain('出口一律不拨')
    // And the drawn buttons do succeed.
    const paused = await h.handle(
      asBearer(
        'POST',
        `/v0/agents/${encodeURIComponent(PLANNER)}/pause`,
        ADMIN,
      ),
    )
    expect(paused.status).toBe(200)
  })

  test('a console without a lifecycle says so and draws no action', async () => {
    const { h } = scene({ lifecycle: undefined })
    const html = await page(h, '/nodes/tokyo-1/lifecycle')
    expect(html).toContain('该控制台没有接入登记簿 · 生命周期不可用')
    expect(html).not.toContain('data-action="lifecycle"')
    expect(html).not.toContain('id="confirm-pause"')
  })

  test('the polled region is its own fragment', async () => {
    const { h } = scene()
    const html = await page(h, '/nodes/tokyo-1/lifecycle')
    expect(html).toContain('data-poll="/fragments/lifecycle/tokyo-1"')
    const fragment = await (
      await h.handle(asBearer('GET', '/fragments/lifecycle/tokyo-1', VIEW))
    ).text()
    expect(fragment).toContain(`<tr data-key="${SLEEPER}"`)
    expect(fragment).not.toContain('<html')
  })
})

describe('the node page (A3)', () => {
  test('four tabs, each a plain link, the current one marked', async () => {
    const { h } = scene()
    for (const path of TABS) {
      const html = await page(h, path)
      for (const tab of TABS) {
        expect(html).toContain(`href="${tab}" data-nav`)
      }
      expect(
        html.match(/class="node-tab"[^>]*aria-current="page"/g),
      ).toHaveLength(1)
    }
  })

  test('the overview: agents, server, lifecycle in numbers, the latest trail', async () => {
    const { h } = scene({ nodeServers: [{ node: 'tokyo-1', server: 'p11' }] })
    const html = visibleText(await page(h, '/nodes/tokyo-1'))
    expect(html).toContain('2 个')
    expect(html).toContain('p11')
    expect(html).toContain('已发布 1')
    expect(html).toContain('已暂停 1')
    expect(html).toContain('已退役 1')
    expect(html).toContain('不可拨 3')
    expect(html).toContain('最近的消息链')
  })

  test('「模型」 points at the providers fragment, and links to the matrix without script', async () => {
    const { h } = scene()
    const html = await page(h, '/nodes/tokyo-1/models')
    expect(html).toContain(
      'id="node-models" data-fragment="/fragments/providers/node/tokyo-1"',
    )
    expect(html).toContain('href="/providers?node=tokyo-1" data-nav')
    // The node is one percent-encoded segment (console.md §5).
    const odd = await page(
      h,
      `/nodes/${encodeURIComponent('odd node/名')}/models`,
    )
    expect(odd).toContain(
      `data-fragment="/fragments/providers/node/${encodeURIComponent(
        'odd node/名',
      )}"`,
    )
    expect(odd).toContain(
      `href="/providers?node=${encodeURIComponent('odd node/名')}"`,
    )
    // On this console the fragment is not there yet: the tab's script is
    // what turns that 404 into one line (browser suite), not the page.
    const missing = await h.handle(
      asBearer('GET', '/fragments/providers/node/tokyo-1', VIEW),
    )
    expect(missing.status).toBe(404)
  })

  test('a node only the ledger knows is a page; a node nobody knows is a 404', async () => {
    const { h } = scene()
    const kyoto = await page(h, '/nodes/kyoto-1/lifecycle')
    expect(kyoto).toContain(`<tr data-key="${KYOTO}"`)
    // Not on the managed list: resume would be refused as unmanaged.
    expect(verbsOn(kyoto, KYOTO)).toEqual(['retire'])
    for (const path of ['/nodes/nowhere', '/nodes/tokyo-1/bogus']) {
      const response = await h.handle(asBearer('GET', path, ADMIN))
      expect(`${path} ${response.status}`).toBe(`${path} 404`)
    }
  })

  test('/nodes: 发布 replaces 注册节点 with a managed list, and lists what the roster does not show', async () => {
    const { h } = scene()
    const html = await page(h, '/nodes')
    expect(html).toContain('data-open-dialog="publish-dialog"')
    expect(html).not.toContain('data-open-dialog="register-dialog"')
    const publish = html.slice(
      html.indexOf('id="publish-dialog"'),
      html.indexOf('</dialog>', html.indexOf('id="publish-dialog"')),
    )
    // Only what is managed, unpublished and off the roster.
    expect(publish.match(/<option value="[^"]*"/g)).toEqual([
      `<option value="${SCOUT}"`,
    ])
    expect(html).toContain('id="ledger-only"')
    expect(html).toContain(
      'href="/nodes/kyoto-1/lifecycle" data-nav>kyoto-1</a>',
    )
    // Every roster card is a way to its node's page.
    expect(html).toContain('<a href="/nodes/tokyo-1" data-nav>tokyo-1</a>')

    const { h: plain } = scene({ lifecycle: undefined })
    const old = await page(plain, '/nodes')
    expect(old).toContain('data-open-dialog="register-dialog"')
    expect(old).not.toContain('publish-dialog')
  })
})

describe('who sees what (viewer, member, ops, legacy tokens)', () => {
  const PATHS = [...TABS, '/nodes', '/fragments/lifecycle/tokyo-1']

  async function marks(
    h: ReturnType<typeof scene>['h'],
    request: (path: string) => Request,
  ) {
    const out: Record<string, readonly string[]> = {}
    for (const path of PATHS) {
      const response = await h.handle(request(path))
      expect(`${path} ${response.status}`).toBe(`${path} 200`)
      out[path] = writeMarks(await response.text())
    }
    return out
  }

  test('viewer, member and the view token: no write control on any tab, and not who did it', async () => {
    const { h } = scene()
    const viewer = await person(h.handle, 'viewer')
    const member = await person(h.handle, 'member')
    const callers: Record<string, (path: string) => Request> = {
      viewer: path =>
        asSession('GET', path, viewer.sid, {
          header: path.startsWith('/fragments'),
          accept: 'text/html',
        }),
      member: path =>
        asSession('GET', path, member.sid, {
          header: path.startsWith('/fragments'),
          accept: 'text/html',
        }),
      'view token': path => asBearer('GET', path, VIEW),
    }
    for (const [who, request] of Object.entries(callers)) {
      const found = await marks(h, request)
      for (const [path, list] of Object.entries(found)) {
        expect(`${who} ${path} ${list.join(',')}`).toBe(`${who} ${path} `)
      }
      const life = await (
        await h.handle(request('/nodes/tokyo-1/lifecycle'))
      ).text()
      expect(`${who} ${life.includes(OPS_SUBJECT)}`).toBe(`${who} false`)
      expect(life).toContain('id="read-only"')
    }
  })

  test('ops and the admin token: the controls, and who changed each address', async () => {
    const { h } = scene()
    const ops = await person(h.handle, 'ops')
    const callers: Record<string, (path: string) => Request> = {
      ops: path =>
        asSession('GET', path, ops.sid, {
          header: path.startsWith('/fragments'),
          accept: 'text/html',
        }),
      'admin token': path => asBearer('GET', path, ADMIN),
    }
    for (const [who, request] of Object.entries(callers)) {
      const found = await marks(h, request)
      expect(
        `${who} ${found['/nodes/tokyo-1/lifecycle']?.includes('data-action="lifecycle"')}`,
      ).toBe(`${who} true`)
      expect(found['/nodes/tokyo-1/lifecycle']).toContain('id="confirm-pause"')
      expect(found['/fragments/lifecycle/tokyo-1']).toContain('data-write')
      expect(found['/nodes']).toContain('publish-dialog')
      const life = await (
        await h.handle(request('/nodes/tokyo-1/lifecycle'))
      ).text()
      expect(`${who} ${life.includes(OPS_SUBJECT)}`).toBe(`${who} true`)
      expect(life).not.toContain('id="read-only"')
    }
  })
})

describe('without script, and the copy', () => {
  test('every tab reads without script; the writer is told the actions need it', async () => {
    const { h } = scene()
    const lifecycle = withoutScripts(await page(h, '/nodes/tokyo-1/lifecycle'))
    expect(lifecycle).not.toContain('<script')
    for (const address of [PLANNER, REVIEWER, SCOUT, SLEEPER, OLD]) {
      expect(lifecycle).toContain(`<tr data-key="${address}"`)
    }
    expect(lifecycle).toContain('生命周期动作需要启用脚本 · 阅读不受影响')
    const agents = withoutScripts(await page(h, '/nodes/tokyo-1/agents'))
    expect(agents).toContain('qianmo://tokyo-1/<b>planner</b>')
    const models = withoutScripts(await page(h, '/nodes/tokyo-1/models'))
    expect(models).toContain('href="/providers?node=tokyo-1"')
    const overview = withoutScripts(await page(h, '/nodes/tokyo-1'))
    expect(overview).toContain('href="/nodes/tokyo-1/lifecycle" data-nav')
  })

  test('no 。，、 no exclamation, no emoji, on any tab, for a reader or a writer, in any ledger state', async () => {
    const states = [
      [null, 'unreadable'],
      ['registrations.json 读不出来', 'unreadable'],
      ['could not write registrations.json', 'unwritable'],
    ] as const
    for (const [problem, kind] of states) {
      const { h, lifecycle, registry } = scene()
      lifecycle.problem = problem
      lifecycle.problemKind = kind
      registry.listResult = {
        ok: true,
        value: [
          ...AGENTS,
          agentAt('qianmo://tokyo-1/late', {
            expiresAt: 1,
            lastHeartbeatAt: 1,
          }),
        ],
      }
      for (const path of [...TABS, '/nodes', '/nodes/kyoto-1/lifecycle']) {
        for (const token of [ADMIN, VIEW]) {
          const visible = visibleText(await page(h, path, token))
          for (const banned of ['。', '，', '、', '！', '!']) {
            expect(`${path} ${visible.includes(banned)} ${banned}`).toBe(
              `${path} false ${banned}`,
            )
          }
          expect(visible).not.toMatch(/\p{Extended_Pictographic}/u)
        }
      }
    }
  })
})
