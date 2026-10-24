// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A management page asked for its parts (P37.13, `docs/dev/qmo-local.md`
 * §3.2): `X-Qianmo-Partial: 1` gets the page as JSON, without the frame;
 * anything else gets the document it always got. Checked here, through the
 * router:
 *
 * - **The two answers.** Same page, same status, both varying on the header;
 *   the parts are what the document draws for that page, and nothing the
 *   frame draws once.
 * - **Who may see what does not move.** The guard runs first for both, and a
 *   refusal is the JSON a script can act on, never a page: no credential is
 *   401, a view token on a chat page is 403, a cookie without the console
 *   header is 403 (the parts are a script's read, like a fragment).
 * - **The policy only grows in `script-src`.** A document allows by hash the
 *   page scripts its reader can move to, and only those; the parts carry the
 *   hash of their script, which is in that list; every other directive is
 *   the same string as before.
 */

import { describe, expect, test } from 'bun:test'
import { CONSOLE_HEADER, SESSION_COOKIE } from '../src/auth.js'
import { CONSOLE_CLIENT_JS } from '../src/assets/client.js'
import { PARTIAL_HEADER, PARTIAL_VERSION } from '../src/assets/nav.js'
import { cspFor, documentCspFor, scriptHash } from '../src/respond.js'
import { ROUTES } from '../src/routes/index.js'
import { CONSOLE_NAV_JS } from '../src/view/shell.js'
import { FakeMemory } from './directionFakes.js'
import { ADMIN, BASE, VIEW, browse, pageHarness } from './pageHarness.js'

function parts(
  path: string,
  credential: { readonly bearer?: string; readonly cookie?: string } = {
    bearer: ADMIN,
  },
  extra: Record<string, string> = {},
): Request {
  const headers: Record<string, string> = {
    accept: 'application/json',
    [PARTIAL_HEADER]: '1',
    ...extra,
  }
  if (credential.bearer !== undefined) {
    headers['authorization'] = `Bearer ${credential.bearer}`
  }
  if (credential.cookie !== undefined) {
    headers['cookie'] = `${SESSION_COOKIE}=${credential.cookie}`
  }
  return new Request(`${BASE}${path}`, { headers })
}

interface Parts {
  readonly v: number
  readonly shell: string
  readonly documentTitle: string
  readonly title: string
  readonly crumbs: string
  readonly actions: string
  readonly main: string
  readonly nav: string
  readonly active: string
  readonly poll: boolean
  readonly refresh: string
  readonly css: string
  readonly script: string
  readonly hash: string
}

function scriptSources(policy: string): readonly string[] {
  const directive =
    policy.split('; ').find(one => one.startsWith('script-src ')) ?? ''
  return directive.split(' ').slice(1)
}

function withoutScriptSrc(policy: string): string {
  return policy
    .split('; ')
    .filter(one => !one.startsWith('script-src '))
    .join('; ')
}

function pageScriptOf(area: string): string {
  const script = ROUTES.find(module => module.area.id === area)?.page?.script
  if (script === undefined) throw new Error(`no page script for ${area}`)
  return script
}

describe('a page asked for its parts', () => {
  test('answers JSON with the page and none of the frame; without the header, the document', async () => {
    const h = pageHarness({ chat: true })
    const answer = await h.handle(parts('/admin/nodes'))
    expect(answer.status).toBe(200)
    expect(answer.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
    expect(answer.headers.get('vary')).toBe(PARTIAL_HEADER)
    expect(answer.headers.get('cache-control')).toBe('no-store')
    expect(answer.headers.get('content-security-policy')).toBeNull()
    const page = (await answer.json()) as Parts
    expect(page.v).toBe(PARTIAL_VERSION)
    expect(page.title).toBe('节点')
    expect(page.active).toBe('nodes')
    expect(page.poll).toBe(true)
    expect(page.refresh).toContain('id="auto-refresh"')
    expect(page.script).toBe(pageScriptOf('nodes'))
    expect(page.hash).toBe(scriptHash(page.script))
    // The current item is marked in the sidebar's items.
    expect(page.nav).toContain(
      'id="nav-nodes" href="/admin/nodes" data-nav aria-current="page"',
    )
    // None of the frame: no document, no sheet, no runtime, no side panel.
    const whole = JSON.stringify(page)
    for (const frame of [
      '<!DOCTYPE',
      '<style>',
      '<script>',
      'id="side"',
      'window.qianmoConsole =',
    ]) {
      expect([frame, whole.includes(frame)]).toEqual([frame, false])
    }

    const document = await h.handle(browse('/admin/nodes', ADMIN))
    expect(document.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    )
    expect(document.headers.get('vary')).toBe(PARTIAL_HEADER)
    const body = await document.text()
    // The parts are what the document draws there.
    expect(body).toContain(page.main)
    expect(body).toContain(page.nav)
    expect(body).toContain(page.crumbs)
    expect(body).toContain(`<div class="top-tail">${page.actions}</div>`)
    expect(body).toContain(`<style>${page.css}</style>`)
    expect(body).toContain(`<title>${page.documentTitle}</title>`)
    // The frame the parts belong in is the one this document carries.
    expect(body).toContain(`var SHELL = '${page.shell}';`)
  })

  test('a page without polling or a script says so; a refusal from the page is its JSON, not parts', async () => {
    const h = pageHarness({ chat: true })
    const overview = (await (
      await h.handle(parts('/admin/overview'))
    ).json()) as Parts
    expect(overview.script).toBe('')
    expect(overview.hash).toBe('')
    // A node nobody knows: the page answers 404 itself, and a browser that
    // navigates there gets the error page; the parts request gets the JSON,
    // which the navigation runtime answers by loading the document.
    const missing = await h.handle(parts('/admin/nodes/nowhere'))
    expect(missing.status).toBe(404)
    const answer = (await missing.json()) as Record<string, unknown>
    expect(answer['v']).toBeUndefined()
    expect(answer['error']).toBeDefined()
    const unknown = await h.handle(parts('/admin/no-such-area'))
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('content-type')).toContain('application/json')
  })

  test('the guard decides first, and a refusal is JSON, never a page or a redirect', async () => {
    const h = pageHarness({
      chat: true,
      ports: { memory: new FakeMemory(() => 0) },
    })
    // No credential: 401, where a navigation is sent to the door.
    const none = await h.handle(parts('/admin/nodes', {}))
    expect(none.status).toBe(401)
    expect(none.headers.get('location')).toBeNull()
    expect(
      ((await none.json()) as { error: { code: string } }).error.code,
    ).toBe('unauthorized')
    const door = await h.handle(browse('/admin/nodes'))
    expect(door.status).toBe(303)
    // A view token reads a view page's parts, and not a chat page's.
    expect(
      (await h.handle(parts('/admin/nodes', { bearer: VIEW }))).status,
    ).toBe(200)
    const memory = await h.handle(parts('/admin/memory', { bearer: VIEW }))
    expect(memory.status).toBe(403)
    expect(memory.headers.get('content-type')).toContain('application/json')
    expect((await h.handle(parts('/admin/memory'))).status).toBe(200)
    // Only GET.
    const post = await h.handle(
      new Request(`${BASE}/admin/nodes`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}`, [PARTIAL_HEADER]: '1' },
      }),
    )
    expect(post.status).toBe(405)
  })

  test('a cookie session reads the parts only with the console header', async () => {
    const h = pageHarness({ chat: true })
    const login = await h.handle(
      new Request(`${BASE}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `token=${ADMIN}&redirect=%2Fadmin`,
      }),
    )
    const cookie = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(
      login.headers.get('set-cookie') ?? '',
    )?.[1]
    expect(cookie).toBeDefined()
    const bare = await h.handle(parts('/admin/nodes', { cookie }))
    expect(bare.status).toBe(403)
    const marked = await h.handle(
      parts('/admin/nodes', { cookie }, { [CONSOLE_HEADER]: '1' }),
    )
    expect(marked.status).toBe(200)
    // The document itself still opens on the cookie alone.
    const document = await h.handle(
      new Request(`${BASE}/admin/nodes`, {
        headers: { accept: 'text/html', cookie: `${SESSION_COOKIE}=${cookie}` },
      }),
    )
    expect(document.status).toBe(200)
  })
})

describe('the policy of a page that swaps pages in place', () => {
  test('allows the page scripts its reader can move to, and grows nothing but script-src', async () => {
    const h = pageHarness({
      chat: true,
      ports: { memory: new FakeMemory(() => 0) },
    })
    const admin = await h.handle(browse('/admin/nodes', ADMIN))
    const viewer = await h.handle(browse('/admin/nodes', VIEW))
    const adminPolicy = admin.headers.get('content-security-policy') ?? ''
    const viewerPolicy = viewer.headers.get('content-security-policy') ?? ''
    for (const policy of [adminPolicy, viewerPolicy]) {
      // Every other directive is the one a document without them states.
      expect(withoutScriptSrc(policy)).toBe(
        withoutScriptSrc(documentCspFor([CONSOLE_CLIENT_JS])),
      )
      expect(policy).not.toContain("'unsafe-inline' 'sha")
      expect(policy).not.toContain("'unsafe-eval'")
      expect(policy).not.toContain("'strict-dynamic'")
      expect(scriptSources(policy)).toContain(scriptHash(pageScriptOf('nodes')))
      expect(scriptSources(policy)).toContain(scriptHash(pageScriptOf('audit')))
      expect(scriptSources(policy)).toContain(
        scriptHash(pageScriptOf('settings')),
      )
    }
    // 记忆 is a chat page: an admin can move there, a view token cannot,
    // and its script is listed only for the one who can.
    expect(scriptSources(adminPolicy)).toContain(
      scriptHash(pageScriptOf('memory')),
    )
    expect(scriptSources(viewerPolicy)).not.toContain(
      scriptHash(pageScriptOf('memory')),
    )
    // The <meta> states the same policy, less frame-ancestors.
    const body = await admin.text()
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/
      .exec(body)?.[1]
      ?.replaceAll('&#39;', "'")
    expect(`${meta}; frame-ancestors 'none'`).toBe(adminPolicy)
    // The parts' own hash is one the document allows.
    const page = (await (
      await h.handle(parts('/admin/settings'))
    ).json()) as Parts
    expect(scriptSources(adminPolicy)).toContain(page.hash)
  })

  test('an error page in the shell allows them too, and a front page does not', async () => {
    const h = pageHarness({ chat: true })
    const missing = await h.handle(browse('/admin/nodes/nowhere', ADMIN))
    expect(missing.status).toBe(404)
    expect(
      scriptSources(missing.headers.get('content-security-policy') ?? ''),
    ).toContain(scriptHash(pageScriptOf('nodes')))
    const front = await h.handle(browse('/', ADMIN))
    expect(
      scriptSources(front.headers.get('content-security-policy') ?? ''),
    ).toHaveLength(1)
  })

  test('cspFor over the same scripts in another order is the same set', () => {
    const one = cspFor(['a', 'b', 'a'])
    expect(scriptSources(one)).toEqual([scriptHash('a'), scriptHash('b')])
  })
})

describe('the navigation runtime', () => {
  test('stays small, parses, and never puts a token in a URL', () => {
    expect(CONSOLE_NAV_JS.length).toBeLessThan(24_000)
    expect(() => new Function(CONSOLE_NAV_JS)).not.toThrow()
    expect(
      CONSOLE_NAV_JS.split('\n').filter(line => /^\s*\/\//.test(line)),
    ).toEqual([])
    expect(CONSOLE_NAV_JS).not.toMatch(/[?&]token=/)
    // A stored token rides as a header, like every other request.
    expect(CONSOLE_NAV_JS).toContain("h['Authorization'] = 'Bearer ' + token")
    // Everything it puts on the page is the server's markup or text.
    expect(CONSOLE_NAV_JS).not.toContain('eval(')
    expect(CONSOLE_NAV_JS).not.toContain('new Function')
  })
})
