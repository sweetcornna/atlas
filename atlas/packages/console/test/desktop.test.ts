// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** 云端电脑 (P21): the page over `FakeDesktop`. */

import { describe, expect, test } from 'bun:test'
import { FakeDesktop } from './directionFakes.js'
import {
  ADMIN,
  browse,
  NOW,
  pageHarness,
  VIEW,
  visibleText,
  withoutScripts,
} from './pageHarness.js'

function wired(desktop: FakeDesktop | null = new FakeDesktop(() => NOW)) {
  const h = pageHarness({
    ports: desktop === null ? {} : { desktop },
  })
  return { handle: h.handle, desktop }
}

async function read(
  handle: (request: Request) => Promise<Response>,
  path: string,
  token = ADMIN,
): Promise<string> {
  const response = await handle(browse(path, token))
  expect(`${path} ${response.status}`).toBe(`${path} 200`)
  return await response.text()
}

describe('云端电脑', () => {
  test('one card per agent: its switches, states, confirmation, activity', async () => {
    const { handle } = wired()
    const html = await read(handle, '/admin/desktop')
    const text = visibleText(html)
    for (const word of [
      'planner',
      'tokyo-1 · Linux',
      '运行中',
      ':12',
      '177.4 MiB',
      '24 小时 37 次操作 · 4 次经你批准',
    ]) {
      expect(`${word} ${text.includes(word)}`).toBe(`${word} true`)
    }
    expect(html).toContain('id="dk-browser-tokyo-1-planner"')
    expect(html).toContain('id="dk-computer-tokyo-1-planner"')
    // An older macOS node has no computer: the switch stays, off and
    // disabled, with why.
    expect(html).toMatch(/id="dk-computer-osaka-1-writer"[^>]* disabled/)
    expect(text).toContain('这台 macOS 节点的版本还不提供电脑 · 升级节点后可用')
    // Nothing runs for writer: its one button turns the browser on.
    expect(card(html, 'osaka-1/writer')).toContain(
      'data-action="desktop-open" data-node="osaka-1" data-agent="writer" data-write>打开浏览器',
    )
    // Something runs for planner: its one button shows the picture, to anyone.
    expect(card(html, 'tokyo-1/planner')).toMatch(
      /data-action="desktop-view" data-node="tokyo-1" data-agent="planner">.*查看画面/,
    )
    // An agent whose node is away cannot be switched.
    expect(html).toMatch(/id="dk-browser-berlin-1-helper"[^>]* disabled/)
    expect(text).toContain('连不上')
    expect(html).toContain('title="Chromium 启动后 20 秒没有就绪"')
    // The recent actions: host names and how each went, never what was typed.
    expect(text).toContain('mail.example.com')
    expect(text).toContain('你批准的')
    expect(text).toContain('被拒')
    expect(text).toContain('只记操作类别与主机名')
  })

  test('a view token reads every state and changes none', async () => {
    const { handle } = wired()
    const html = withoutScripts(await read(handle, '/admin/desktop', VIEW))
    expect(html).not.toContain('data-desktop-unit')
    expect(html).not.toContain('data-desktop-confirm')
    expect(html).not.toContain('desktop-recycle')
    expect(html).not.toContain('data-write')
    expect(visibleText(html)).toContain('动手前确认')
    expect(visibleText(html)).toContain(
      '看屏幕不问 · 点击 输入 打开网址逐次问你',
    )
    // 查看画面 is for every reader; 打开浏览器 is a change.
    expect(html).toContain('data-action="desktop-view"')
    expect(html).not.toContain('data-action="desktop-open"')
  })

  test('the admin token gets switches, the confirmation choice and recycling for what is on', async () => {
    const { handle } = wired()
    const html = withoutScripts(await read(handle, '/admin/desktop'))
    expect(html).toContain('data-desktop-confirm')
    expect(html).toContain(
      'data-action="desktop-recycle" data-node="tokyo-1" data-agent="planner"',
    )
    // Nothing is on for writer: nothing to recycle.
    expect(html).not.toContain(
      'data-node="osaka-1" data-agent="writer" data-write>清空回收',
    )
    expect(html).toContain('id="confirm-desktop-recycle"')
  })

  test('a failing list is a failure bar; failing actions are one line; no port is no area', async () => {
    const desktop = new FakeDesktop(() => NOW)
    desktop.failList = true
    const failing = wired(desktop)
    const text = visibleText(await read(failing.handle, '/fragments/desktop'))
    expect(text).toContain('云端电脑')
    expect(text).not.toContain('planner')
    const none = wired(null)
    expect((await none.handle(browse('/admin/desktop', ADMIN))).status).toBe(
      404,
    )
    expect(await read(none.handle, '/admin/overview')).not.toContain(
      'href="/admin/desktop"',
    )
    expect(
      (await none.handle(browse('/fragments/desktop/x', ADMIN))).status,
    ).toBe(404)
  })
})

/** The card of one agent, from its `data-key` to the end of its article. */
function card(html: string, key: string): string {
  const start = html.indexOf(`data-key="${key}"`)
  expect(`${key} ${start > 0}`).toBe(`${key} true`)
  return html.slice(start, html.indexOf('</article>', start))
}

describe('云端电脑 · 像人一样操作 (§6)', () => {
  test("three confirmations, each with its words; the choice is the server's", async () => {
    const { handle } = wired()
    const html = withoutScripts(await read(handle, '/admin/desktop'))
    const planner = card(html, 'tokyo-1/planner')
    for (const value of ['sensitive', 'always', 'autonomous'])
      expect(planner).toContain(`value="${value}" data-desktop-confirm`)
    expect(planner).toMatch(
      /value="sensitive" data-desktop-confirm[^>]* checked/,
    )
    const text = visibleText(planner)
    for (const word of ['动手前确认', '每一步都确认', '只确认有后果的操作'])
      expect(text).toContain(word)
    expect(visibleText(card(html, 'kyoto-1/designer'))).toContain(
      '只确认有后果的操作',
    )
    // A node from before §6 refuses `autonomous`: not offered there.
    const old = card(html, 'osaka-1/writer')
    expect(old).toContain('value="always" data-desktop-confirm')
    expect(old).not.toContain('value="autonomous"')
    const view = withoutScripts(await read(handle, '/admin/desktop', VIEW))
    expect(visibleText(card(view, 'kyoto-1/designer'))).toContain(
      '只确认有后果的操作',
    )
  })

  test('a private desktop shows its facts: window manager, accessibility, confinement, memory, apps, terminal', async () => {
    const { handle } = wired()
    const html = withoutScripts(await read(handle, '/admin/desktop'))
    const planner = card(html, 'tokyo-1/planner')
    const text = visibleText(planner).replace(/\s+/g, ' ')
    for (const word of [
      '桌面 私有桌面',
      '窗口管理器 openbox',
      '无障碍 可用',
      '隔离 已隔离',
      '内存 312 MiB / 1.5 GiB',
      'org.gnome.TextEditor',
      'firefox-esr',
      '允许终端',
    ])
      expect(`${word} ${text.includes(word)}`).toBe(`${word} true`)
    // Ops edit the list in a dialog and flip the terminal on the card.
    expect(planner).toContain(
      'data-action="desktop-apps" data-node="tokyo-1" data-agent="planner" data-desktop-apps="list"',
    )
    expect(planner).toContain(
      'data-apps-list="org.gnome.TextEditor\norg.gnome.Calculator\nfirefox-esr"',
    )
    expect(planner).toMatch(
      /id="dk-terminal-tokyo-1-planner" data-desktop-terminal[^>]*data-write/,
    )
    expect(planner).not.toMatch(/data-desktop-terminal[^>]* checked/)
    expect(html).toContain('id="desktop-apps-form"')
    expect(text).not.toContain('现有的 Mac 桌面')
  })

  test('a reader sees the same facts as words, and no control to change them', async () => {
    const { handle } = wired()
    const html = withoutScripts(await read(handle, '/admin/desktop', VIEW))
    const planner = card(html, 'tokyo-1/planner')
    const text = visibleText(planner).replace(/\s+/g, ' ')
    expect(text).toContain('终端 不给')
    expect(text).toContain('org.gnome.Calculator')
    expect(planner).not.toContain('data-action="desktop-apps"')
    expect(planner).not.toContain('data-desktop-terminal')
    expect(html).not.toContain('id="desktop-apps-form"')
    // The enlarged screen is for every reader.
    expect(html).toContain('id="desktop-screen"')
    expect(html).toContain('id="desktop-screen-img"')
  })

  test('all, none, a long list, an unconfined desktop and one without a window manager', async () => {
    const desktop = new FakeDesktop(() => NOW)
    const planner = desktop.units[0]!
    const many = Array.from({ length: 9 }, (_, i) => `app-${i}`)
    const variants = [
      { apps: 'all' as const, word: '应用 全部' },
      { apps: 'none' as const, word: '应用 不给' },
      { apps: many, word: '共 9 个' },
    ]
    for (const { apps, word } of variants) {
      desktop.units[0] = {
        ...planner,
        computer: {
          ...planner.computer,
          apps,
          confined: false,
          windowManager: null,
          terminal: true,
          memoryBytes: null,
        },
      }
      const { handle } = wired(desktop)
      const html = withoutScripts(await read(handle, '/admin/desktop', VIEW))
      const text = visibleText(card(html, 'tokyo-1/planner')).replace(
        /\s+/g,
        ' ',
      )
      expect(`${word} ${text.includes(word)}`).toBe(`${word} true`)
      expect(text).toContain('隔离 未隔离 · 不能打开应用')
      expect(text).toContain('窗口管理器 无')
      expect(text).toContain('终端 允许')
      expect(text).toContain('内存 — / 1.5 GiB')
    }
    // Only the first six ids are drawn.
    const { handle } = wired(desktop)
    const html = await read(handle, '/admin/desktop', VIEW)
    expect(html).toContain('app-5')
    expect(html).not.toContain('app-6')
  })

  test('a macOS host desktop: list only, said so, and turning it on asks for the list', async () => {
    const { handle } = wired()
    const html = withoutScripts(await read(handle, '/admin/desktop'))
    const designer = card(html, 'kyoto-1/designer')
    const text = visibleText(designer).replace(/\s+/g, ' ')
    expect(text).toContain('桌面 本机桌面')
    expect(text).toContain(
      '操作的是这台节点现有的 Mac 桌面 · 只能用列表里的应用',
    )
    expect(text).toContain('应用 未列出')
    expect(text).toContain('无障碍 不可用')
    // No private display: no window manager, no confinement, no terminal row.
    expect(text).not.toContain('窗口管理器')
    expect(text).not.toContain('隔离')
    expect(text).not.toContain('终端')
    expect(designer).toMatch(
      /id="dk-computer-kyoto-1-designer" data-desktop-unit="computer"[^>]* data-desktop-apps="list" data-apps-list="" data-mode="host"/,
    )
    // The private desktop's switch opens straight away.
    expect(card(html, 'tokyo-1/planner')).not.toMatch(
      /data-desktop-unit="computer"[^>]* data-desktop-apps/,
    )
  })

  test('the screen: an empty frame while the computer runs, filled by the script; none when it is off', async () => {
    const { handle } = wired()
    const html = withoutScripts(await read(handle, '/fragments/desktop'))
    const planner = card(html, 'tokyo-1/planner')
    expect(planner).toContain(
      'class="dk-shot" data-action="desktop-screen" data-node="tokyo-1" data-agent="planner" data-desktop-screen aria-label="放大查看"',
    )
    expect(visibleText(planner)).toContain('最近的画面')
    expect(visibleText(planner)).toContain('还没有截图')
    // The fragment carries no picture: the page asks for it on its own.
    expect(planner).not.toContain('data:image')
    // A browser alone has a picture too (desktop.view takes the newest of either).
    expect(card(html, 'kyoto-1/designer')).toContain('data-desktop-screen')
    // Nothing on: no frame.
    expect(card(html, 'osaka-1/writer')).not.toContain('dk-shot')
  })

  test('a computer switched on but not running has a frame the script leaves alone', async () => {
    const desktop = new FakeDesktop(() => NOW)
    const planner = desktop.units[0]!
    desktop.units[0] = {
      ...planner,
      browser: { ...planner.browser, state: 'starting' },
      computer: { ...planner.computer, state: 'starting' },
    }
    const { handle } = wired(desktop)
    const planned = card(
      await read(handle, '/fragments/desktop'),
      'tokyo-1/planner',
    )
    expect(planned).toContain('class="dk-shot"')
    expect(planned).not.toContain('data-desktop-screen')
    expect(visibleText(planned)).toContain('没有在运行')
  })

  test('a node from before §6 sends none of the new fields: the card is what it was, without errors', async () => {
    const desktop = new FakeDesktop(() => NOW)
    const planner = desktop.units[0]!
    desktop.units[0] = {
      ...planner,
      computer: {
        enabled: true,
        supported: true,
        state: 'running',
        display: ':12',
        reason: null,
      },
    }
    // And one that sends nonsense where the new fields go.
    desktop.units[1] = {
      ...desktop.units[1]!,
      computer: {
        enabled: false,
        supported: true,
        state: 'off',
        display: null,
        reason: null,
        apps: 42 as unknown as 'all',
        memoryBytes: 'lots' as unknown as number,
        memoryLimitBytes: undefined,
        mode: 'cloud' as unknown as 'host',
      },
      confirm: 'sometimes' as unknown as 'always',
    }
    const { handle } = wired(desktop)
    for (const token of [ADMIN, VIEW]) {
      const html = withoutScripts(await read(handle, '/admin/desktop', token))
      const old = card(html, 'tokyo-1/planner')
      expect(old).not.toContain('dk-facts')
      expect(old).not.toContain('data-action="desktop-apps"')
      expect(old).toContain('data-desktop-screen')
      expect(visibleText(old)).toContain(':12')
      const odd = card(html, 'osaka-1/writer')
      expect(odd).not.toContain('dk-facts')
      expect(visibleText(odd)).not.toContain('undefined')
      expect(visibleText(odd)).not.toContain('NaN')
    }
  })

  test('the new operations read as words in the recent actions', async () => {
    const desktop = new FakeDesktop(() => NOW)
    const actions = desktop.actions.bind(desktop)
    desktop.actions = async (ref, limit) => {
      const r = await actions(ref, limit)
      if (!r.ok) return r
      return {
        ok: true,
        value: ['actions', 'open_app', 'observe', 'clipboard_write'].map(
          (op, i) => ({
            at: NOW - i * 1000,
            node: 'tokyo-1',
            agent: 'planner',
            unit: 'computer' as const,
            op,
            host: null,
            outcome: 'allowed' as const,
          }),
        ),
      }
    }
    const { handle } = wired(desktop)
    const text = visibleText(await read(handle, '/fragments/desktop'))
    for (const word of ['批量动作', '打开应用', '读窗口', '写剪贴板'])
      expect(text).toContain(word)
  })
})
