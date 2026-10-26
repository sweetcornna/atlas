// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 分栏与侧栏 (P37.18, `docs/dev/qmo-app.md` §11), what the server draws and
 * sends:
 *
 * - **The script.** `FRONT_SPLIT_JS` under 52,000 characters, parses, ships
 *   without its line comments, builds no markup from a string, opens no
 *   stream of its own but the window's; it sits in every face's one inline
 *   script ahead of the front's own, and the peek's two delays are the ones
 *   §11.4 gives. Code's own scripts gain nothing: `CODE_JS` is as it was.
 * - **A pane's document.** `/`, `/app` and `/code` with `pane=1`: the same
 *   face with `data-pane="1"`, no settings card and no right-click menu, ⌄
 *   and × in its bar — and the only documents that may be framed, by this
 *   origin alone (`frame-ancestors 'self'`, `SAMEORIGIN`). Any other value
 *   of `pane`, any other page, the login door and the errors on a pane's
 *   address keep `'none'` and `DENY`.
 * - **The rows.** 在右侧打开 and 在下方打开 are drawn once, in the window's
 *   right-click menu, for the script to copy into a row's ⋯; the words and
 *   the keyboard help's rows in each language.
 */

import { describe, expect, test } from 'bun:test'
import { CODE_JS } from '../src/assets/codeClient.js'
import { FRONT_JS } from '../src/assets/frontClient.js'
import {
  FRONT_SPLIT_JS,
  PANE_MAX,
  PANE_MIN_H,
  PANE_MIN_W,
  PANE_ROWS,
  PEEK_CLOSE_MS,
  PEEK_OPEN_MS,
} from '../src/assets/frontSplit.js'
import type { ChatTarget } from '../src/deps.js'
import { LANGS } from '../src/i18n.js'
import { documentCspFor, inlineScripts } from '../src/respond.js'
import { SPLIT_TEXT } from '../src/view/frontSplit.js'
import { ADDRESS } from './accountsHarness.js'
import { ADMIN, BASE, browse, pageHarness } from './pageHarness.js'
import { WorkChat } from './workFake.js'

const REVIEWER: ChatTarget = {
  address: 'qianmo://tokyo-1/reviewer',
  node: 'tokyo-1',
  agent: 'reviewer',
  endpoint: 'ws://127.0.0.1:38611/',
  status: 'online',
  dialable: true,
}

/** A front with planner's resident conversation and one work session. */
async function seeded() {
  const chat = new WorkChat()
  chat.moreTargets.push(REVIEWER)
  const resident = await chat.open(ADDRESS, { resident: true })
  const work = await chat.open(REVIEWER.address, {
    work: true,
    workflow: 'slides',
  })
  if (!resident.ok || !work.ok) throw new Error('no sessions')
  const h = pageHarness({ chat: true, ports: { chat } })
  return { h, work: work.value.id }
}

function get(path: string, cookie = ''): Request {
  const headers: Record<string, string> = {
    accept: 'text/html',
    authorization: `Bearer ${ADMIN}`,
  }
  if (cookie !== '') headers['cookie'] = cookie
  return new Request(`${BASE}${path}`, { headers })
}

function framing(response: Response): [string, string] {
  return [
    /frame-ancestors [^;]+$/.exec(
      response.headers.get('content-security-policy') ?? '',
    )?.[0] ?? '',
    response.headers.get('x-frame-options') ?? '',
  ]
}

/** The opening tag of `#fx`. */
function rootOf(html: string): string {
  return /<div class="fx" id="fx"[^>]*>/.exec(html)?.[0] ?? ''
}

describe('the panes’ script', () => {
  test('stays inside its budget, parses, and ships without line comments', () => {
    expect(FRONT_SPLIT_JS.length).toBeLessThan(52_000)
    expect(() => new Function(FRONT_SPLIT_JS)).not.toThrow()
    for (const line of FRONT_SPLIT_JS.split('\n')) {
      expect(line.trimStart().startsWith('//')).toBe(false)
    }
    // Code's own script gains nothing (the runner's channel is shared from the window).
    expect(CODE_JS).not.toContain('qianmoSplit')
    expect(CODE_JS.length).toBeLessThan(37_000)
  })

  test('builds no markup from a string and opens no stream but the window’s one', () => {
    for (const word of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'eval(',
      'new Function',
      'fetch(',
      'XMLHttpRequest',
      'BroadcastChannel',
      'SharedWorker',
      'postMessage',
    ]) {
      expect(`${word} ${FRONT_SPLIT_JS.includes(word)}`).toBe(`${word} false`)
    }
    expect(FRONT_SPLIT_JS.match(/new EventSource\(/g)).toHaveLength(2)
    // One is the window's stream, the other a pane's out of any window (it goes away).
    expect(FRONT_SPLIT_JS).toContain('var real = new EventSource(url);')
    expect(FRONT_SPLIT_JS).toContain(
      'stream: function (url) { return new EventSource(url); }',
    )
  })

  test('keeps §11’s numbers', () => {
    expect(PEEK_OPEN_MS).toBeGreaterThanOrEqual(250)
    expect(PEEK_OPEN_MS).toBeLessThanOrEqual(400)
    expect(PEEK_CLOSE_MS).toBeGreaterThanOrEqual(200)
    expect(PEEK_CLOSE_MS).toBeLessThanOrEqual(300)
    expect([PANE_MAX, PANE_ROWS, PANE_MIN_W, PANE_MIN_H]).toEqual([
      4, 2, 320, 200,
    ])
    expect(FRONT_SPLIT_JS).toContain(`}, ${PEEK_OPEN_MS});`)
    expect(FRONT_SPLIT_JS).toContain(`}, ${PEEK_CLOSE_MS});`)
  })

  test('runs ahead of the front’s own, in every face’s one inline script', async () => {
    const { h } = await seeded()
    for (const path of ['/', '/app', '/code']) {
      const response = await h.handle(get(path, 'qianmo_shell=macos'))
      expect(`${path} ${response.status}`).toBe(`${path} 200`)
      const scripts = inlineScripts(await response.text())
      expect(scripts).toHaveLength(1)
      const script = scripts[0] ?? ''
      const split = script.indexOf(FRONT_SPLIT_JS)
      expect(split).toBeGreaterThan(0)
      expect(script.indexOf(FRONT_JS)).toBe(split + FRONT_SPLIT_JS.length)
    }
  })
})

describe('a pane’s document', () => {
  test('on each face: data-pane, no settings card or right-click menu, ⌄ and × in its bar', async () => {
    const { h, work } = await seeded()
    for (const path of [
      '/?pane=1',
      `/?session=${work}&pane=1`,
      `/?agent=${encodeURIComponent(REVIEWER.address)}&pane=1`,
      '/?work=new&pane=1',
      '/app?pane=1',
      '/code?pane=1',
    ]) {
      const response = await h.handle(get(path, 'qianmo_shell=macos'))
      expect(`${path} ${response.status}`).toBe(`${path} 200`)
      const html = await response.text()
      expect(`${path} ${rootOf(html)}`).toContain('data-pane="1"')
      expect(html).toContain('<body class="fx-body fx-pane-doc">')
      expect(html).not.toContain('id="settings"')
      expect(html).not.toContain('id="fx-split-ctx"')
      expect(html).toContain('id="fx-pane-more"')
      expect(html).toContain('data-action="fx-pane-close"')
      expect(html).toContain('data-action="fx-pane-solo"')
      // ⌄ after the title, × the last thing in the bar.
      const head = html.slice(
        html.indexOf('class="fx-head-mount"'),
        html.indexOf('</header>'),
      )
      expect(head.indexOf('id="fx-pane-more"')).toBeGreaterThan(0)
      expect(head.lastIndexOf('</button></div>')).toBeGreaterThan(
        head.indexOf('data-action="fx-pane-close"'),
      )
    }
  })

  test('is the one document that may be framed, by this origin alone', async () => {
    const { h } = await seeded()
    for (const path of ['/?pane=1', '/app?pane=1', '/code?pane=1']) {
      const response = await h.handle(get(path))
      expect(framing(response)).toEqual([
        "frame-ancestors 'self'",
        'SAMEORIGIN',
      ])
      const html = await response.text()
      // Its scripts by hash, as every document's; only the framing differs.
      expect(response.headers.get('content-security-policy')).toBe(
        documentCspFor(inlineScripts(html), true),
      )
      const meta =
        /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/
          .exec(html)?.[1]
          ?.replaceAll('&#39;', "'")
      expect(`${meta}; frame-ancestors 'self'`).toBe(
        response.headers.get('content-security-policy') ?? '',
      )
    }
    for (const path of [
      '/',
      '/app',
      '/code',
      '/?pane=0',
      '/?pane=yes',
      '/?pane=1&pane=1x',
      '/admin/settings?pane=1',
      '/admin/nodes?pane=1',
      '/fragments/chat/front/side?pane=1',
      '/nope?pane=1',
    ]) {
      const response = await h.handle(get(path))
      const [ancestors, xfo] = framing(response)
      if (response.headers.get('content-type')?.startsWith('text/html')) {
        expect(`${path} ${ancestors} ${xfo}`).toBe(
          `${path} frame-ancestors 'none' DENY`,
        )
      }
      if (response.status === 200 && path.startsWith('/?')) {
        expect(rootOf(await response.text())).not.toContain('data-pane')
      }
    }
  })

  test('without a sign-in it is the login door, and that refuses to be framed', async () => {
    const { h } = await seeded()
    const response = await h.handle(browse('/?pane=1'))
    expect(response.status).toBe(303)
    const to = response.headers.get('location') ?? ''
    expect(to.startsWith('/login')).toBe(true)
    const door = await h.handle(browse(to))
    expect(framing(door)).toEqual(["frame-ancestors 'none'", 'DENY'])
  })

  test('a console without the conversation sends a Work pane away, and still draws a Code one', async () => {
    const off = pageHarness()
    const response = await off.handle(get('/?pane=1'))
    expect([response.status, response.headers.get('location')]).toEqual([
      303,
      '/admin',
    ])
    // What the window then finds in the frame is no pane: 这个会话打不开.
    const admin = await off.handle(get('/admin'))
    expect(framing(admin)).toEqual(["frame-ancestors 'none'", 'DENY'])
    const code = await off.handle(get('/code?pane=1'))
    expect(code.status).toBe(200)
    expect(framing(code)).toEqual(["frame-ancestors 'self'", 'SAMEORIGIN'])
    expect(rootOf(await code.text())).toContain('data-pane="1"')
  })
})

describe('the rows and the words', () => {
  test('the two items are drawn once, in the right-click menu, not in every row', async () => {
    const { h, work } = await seeded()
    const html = await (await h.handle(get('/'))).text()
    // The script copies them into a row's ⋯ as it opens (assets/frontSplit.ts).
    const ctx =
      /<div class="fx-menu fx-split-ctx" id="fx-split-ctx" role="menu" hidden>[\s\S]*?<\/button><\/div>/.exec(
        html,
      )?.[0]
    expect(ctx).toBeDefined()
    expect(
      (ctx ?? '').match(
        /<button type="button" class="fx-menu-item fx-split-item" role="menuitem" data-action="fx-split" data-split-to="(right|below)" data-split-q="">/g,
      ),
    ).toHaveLength(2)
    expect(html.match(/<button[^>]*data-action="fx-split"/g)).toHaveLength(2)
    expect(html).toContain(`data-session="${work}"`)
    // A pane's document has no side list of its own to open beside from.
    const pane = await (await h.handle(get('/?pane=1'))).text()
    expect(pane).not.toMatch(/<button[^>]*data-action="fx-split"/)
  })

  test('the words and the keys, in each language', async () => {
    const { h } = await seeded()
    for (const lang of LANGS) {
      const t = SPLIT_TEXT[lang]
      const html = await (
        await h.handle(get('/', `qianmo_lang=${lang}`))
      ).text()
      const words = JSON.parse(
        (/data-split-text="([^"]*)"/.exec(rootOf(html))?.[1] ?? '{}')
          .replaceAll('&quot;', '"')
          .replaceAll('&#39;', "'")
          .replaceAll('&amp;', '&'),
      ) as Record<string, string>
      expect(words).toEqual({
        paneFailed: t.paneFailed,
        paneFull: t.paneFull,
        resize: t.resize,
        pane: t.pane,
        close: t.close,
      })
      for (const label of [t.openRight, t.openBelow]) {
        expect(`${lang} ${html.includes(label)}`).toBe(`${lang} true`)
      }
      for (const what of Object.values(t.keys)) {
        expect(`${lang} ${html.includes(`<dt>${what}</dt>`)}`).toBe(
          `${lang} true`,
        )
      }
      expect(html).toContain(
        '<kbd data-ctrl>Ctrl</kbd><kbd data-modalt>Alt</kbd><kbd>\\</kbd>',
      )
      expect(html).toContain('<kbd data-mod>Ctrl</kbd><kbd>B</kbd>')
      const pane = await (
        await h.handle(get('/?pane=1', `qianmo_lang=${lang}`))
      ).text()
      expect(pane).toContain(`aria-label="${t.paneMenu}"`)
      expect(pane).toContain(`aria-label="${t.closePane}"`)
      expect(pane).toContain(t.soloPane)
    }
  })
})
