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
    // macOS: a browser only, said so, no switch for a computer.
    expect(html).not.toContain('id="dk-computer-osaka-1-writer"')
    expect(text).toContain('macOS 节点只提供浏览器')
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
    expect(visibleText(html)).toContain('只看自动 · 其余逐次确认')
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
    expect((await none.handle(browse('/admin/desktop', ADMIN))).status).toBe(404)
    expect(await read(none.handle, '/admin/overview')).not.toContain(
      'href="/admin/desktop"',
    )
    expect(
      (await none.handle(browse('/fragments/desktop/x', ADMIN))).status,
    ).toBe(404)
  })
})
