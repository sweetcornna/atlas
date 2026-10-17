// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public edition's source footer (AGPL §13, public-edition.md §0): not
 * only the plans, subscription and checkout pages but every page a member of
 * the public reaches — the login, sign-up and invitation doors, the
 * credential page they answer with, and the conversation front — links the
 * corresponding source, and the terms when there are some. The link is the
 * billing port's `sourceUrl` as the host hands it over (the repository at
 * this build's commit, `packages/node/src/provenance.ts`). The default
 * edition's doors stay as they were.
 */

import { describe, expect, test } from 'bun:test'
import { sourceFooter } from '../src/view/source.js'
import {
  BASE,
  accountsHarness,
  asSession,
  formPost,
  invite,
  person,
} from './accountsHarness.js'
import { publicConsole, type PublicPerson } from './billingFake.js'

const SOURCE =
  'https://github.com/sweetcornna/atlas/tree/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const LINK = `<a href="${SOURCE}" rel="noopener" data-source>源代码 · AGPL-3.0</a>`
const TERMS =
  '<a href="https://qianmo.example/terms" rel="noopener">服务条款</a>'

function page(path: string, who?: PublicPerson): Request {
  return new Request(`${BASE}${path}`, {
    headers: {
      accept: 'text/html',
      ...(who === undefined
        ? {}
        : { authorization: `Bearer ${who.credential}` }),
    },
  })
}

function pinned() {
  const f = publicConsole()
  f.billing.siteView = { ...f.billing.siteView, sourceUrl: SOURCE }
  return f
}

describe('sourceFooter', () => {
  test('the source link, then the terms when there are some', () => {
    expect(sourceFooter({ sourceUrl: SOURCE, termsUrl: null })).toBe(
      `<footer class="foot">${LINK}</footer>`,
    )
    const both = sourceFooter(
      { sourceUrl: SOURCE, termsUrl: 'https://qianmo.example/terms' },
      'bl-foot',
    )
    expect(both).toStartWith(`<footer class="bl-foot">${LINK}`)
    expect(both).toContain(TERMS)
  })

  test('both addresses are escaped as attributes', () => {
    const html = sourceFooter({
      sourceUrl: 'https://example.cn/a"b',
      termsUrl: 'https://example.cn/<t>',
    })
    expect(html).toContain('href="https://example.cn/a&quot;b"')
    expect(html).toContain('href="https://example.cn/&lt;t&gt;"')
  })
})

describe('every public-edition page carries the source link', () => {
  test('the doors: login, sign-up, invitation', async () => {
    const f = pinned()
    for (const path of ['/login', '/signup', '/invite']) {
      const response = await f.handle(page(path))
      expect(`${path} ${response.status}`).toBe(`${path} 200`)
      const html = await response.text()
      expect(html).toContain(LINK)
      expect(html).toContain(TERMS)
    }
  })

  test('the credential page after sign-up and after an invitation', async () => {
    const f = pinned()
    const signedUp = await f.handle(
      formPost('/signup', { label: '' }, { 'sec-fetch-site': 'same-origin' }),
    )
    expect(signedUp.status).toBe(200)
    expect(await signedUp.text()).toContain(LINK)

    const issued = f.book.issueInvite({
      role: 'member',
      issuedBy: 'legacy:admin',
    })
    if (!issued.ok) throw new Error('issue')
    const accepted = await f.handle(
      formPost(
        '/invite',
        { invite: issued.value.token },
        { 'sec-fetch-site': 'same-origin' },
      ),
    )
    expect(accepted.status).toBe(200)
    const credential = await accepted.text()
    expect(credential).toContain('个人凭据只显示这一次')
    expect(credential).toContain(LINK)
  })

  test('the conversation front of a subscriber with a node', async () => {
    const f = pinned()
    const response = await f.handle(page('/', f.paid))
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('id="fx-thread"')
    expect(html).toContain(LINK)
  })

  test('the management side a subscriber lands on, and its error page', async () => {
    const f = pinned()
    for (const path of [
      '/admin/overview',
      '/admin/nodes',
      '/admin/usage',
      '/admin/nope',
    ]) {
      const response = await f.handle(page(path, f.paid))
      const html = await response.text()
      expect(`${path} ${html.includes('class="shell"')}`).toBe(`${path} true`)
      expect(`${path} ${html.includes(LINK)}`).toBe(`${path} true`)
    }
  })

  test('the plans page and a standing card use the same footer', async () => {
    const f = pinned()
    for (const [path, who] of [
      ['/plans', undefined],
      ['/', f.unpaid],
    ] as const) {
      const html = await (await f.handle(page(path, who))).text()
      expect(html).toContain(`<footer class="bl-foot">${LINK}`)
    }
  })
})

/** What a person reads on a page: no style, no script, no markup. */
function readable(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<script>[\s\S]*?<\/script>/g, '')
    .replace(/<[^>]*>/g, ' ')
}

describe('the public sign-up page describes the public flow', () => {
  test('a subscription opens the tenant; no environment owner assigns it', async () => {
    const html = readable(await (await pinned().handle(page('/signup'))).text())
    expect(html).toContain('订阅套餐后开通租户')
    expect(html).not.toContain('环境负责人')
  })
})

describe('the public doors keep the copy rules', () => {
  test('login, sign-up, invitation and the credential page: no 。，、 or exclamation', async () => {
    const f = pinned()
    const pages: [string, Request][] = [
      ['/login', page('/login')],
      ['/signup', page('/signup')],
      ['/invite', page('/invite')],
      [
        'POST /signup',
        formPost('/signup', { label: '' }, { 'sec-fetch-site': 'same-origin' }),
      ],
    ]
    const found: string[] = []
    for (const [where, request] of pages) {
      const text = readable(await (await f.handle(request)).text())
      for (const mark of ['。', '，', '、', '！', '!'])
        if (text.includes(mark)) found.push(`${where} ${mark}`)
    }
    expect(found).toEqual([])
  })
})

describe('the default edition is unchanged', () => {
  test('its doors and its front carry no source footer', async () => {
    const h = accountsHarness({ accounts: { breakGlass: true } })
    const { token } = await invite(h.handle, 'member')
    const responses = [
      await h.handle(new Request(`${BASE}/login`)),
      await h.handle(new Request(`${BASE}/invite`)),
      await h.handle(formPost('/invite', { invite: token })),
    ]
    for (const response of responses) {
      const html = await response.text()
      expect(html).not.toContain('data-source')
    }
  })

  test('its management side carries none either', async () => {
    const h = accountsHarness()
    const member = await person(h.handle, 'member')
    const response = await h.handle(
      asSession('GET', '/admin/overview', member.sid, { header: false }),
    )
    const html = await response.text()
    expect(html).toContain('class="shell"')
    expect(html).not.toContain('data-source')
  })
})
