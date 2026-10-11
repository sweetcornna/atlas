// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 连接: 应用连接 (P25) and 本机工具 (P19 devices) on one page, over the
 * fakes in `directionFakes.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { accountsHarness, asSession, person } from './accountsHarness.js'
import { FakeConnectors, FakeHandoffDevices } from './directionFakes.js'
import {
  ADMIN,
  browse,
  NOW,
  pageHarness,
  VIEW,
  visibleText,
  withoutScripts,
} from './pageHarness.js'

function wired(
  ports: {
    readonly connectors?: FakeConnectors | null
    readonly devices?: FakeHandoffDevices | null
  } = {},
) {
  const connectors =
    ports.connectors === null
      ? undefined
      : (ports.connectors ?? new FakeConnectors(() => NOW))
  const handoffDevices =
    ports.devices === null
      ? undefined
      : (ports.devices ?? new FakeHandoffDevices(() => NOW))
  const h = pageHarness({
    ports: {
      ...(connectors === undefined ? {} : { connectors }),
      ...(handoffDevices === undefined ? {} : { handoffDevices }),
    },
  })
  return { handle: h.handle, connectors, handoffDevices }
}

async function page(
  handle: (request: Request) => Promise<Response>,
  path: string,
  token: string,
): Promise<string> {
  const response = await handle(browse(path, token))
  expect(`${path} ${response.status}`).toBe(`${path} 200`)
  return await response.text()
}

describe('连接 · the page', () => {
  test('both halves: the mailbox with its masked account, the devices', async () => {
    const { handle } = wired()
    const html = await page(handle, '/connect', ADMIN)
    const text = visibleText(html)
    expect(text).toContain('应用连接')
    expect(text).toContain('工作邮箱')
    expect(text).toContain('ch***@qq.com')
    expect(text).toContain('已设置')
    expect(text).toContain('未评估')
    expect(text).toContain('本机工具')
    expect(text).toContain('我的 MacBook')
    expect(text).toContain('macOS · Apple 芯片')
    expect(text).toContain('已吊销')
    // The raw account is for the edit form only, never the page.
    expect(html).not.toContain('chen@qq.com')
  })

  test('the admin token manages connections and pairs devices; a view token only reads', async () => {
    const { handle } = wired()
    const admin = withoutScripts(await page(handle, '/connect', ADMIN))
    for (const mark of [
      'data-action="connector-new"',
      'data-action="connector-probe"',
      'data-action="connector-remove"',
      'data-action="device-pair"',
      'data-action="device-revoke"',
      'id="connector-dialog"',
      'id="pairing-dialog"',
    ]) {
      expect(`${mark} ${admin.includes(mark)}`).toBe(`${mark} true`)
    }
    const view = withoutScripts(await page(handle, '/connect', VIEW))
    for (const mark of [
      'connector-new',
      'connector-probe',
      'device-pair',
      'device-revoke',
      'connector-dialog',
      'pairing-dialog',
    ]) {
      expect(`${mark} ${view.includes(mark)}`).toBe(`${mark} false`)
    }
    expect((await handle(browse('/fragments/connect/form', VIEW))).status).toBe(
      403,
    )
  })

  test('a member pairs a device and revokes only their own; connections stay ops-only', async () => {
    const devices = new FakeHandoffDevices(() => NOW, 'u:someone-else')
    const h = accountsHarness({
      deps: {
        connectors: new FakeConnectors(() => NOW),
        handoffDevices: devices,
      },
    })
    const member = await person(h.handle, 'member')
    const html = await (
      await h.handle(
        asSession('GET', '/connect', member.sid, { header: false }),
      )
    ).text()
    expect(html).toContain('data-action="device-pair"')
    expect(html).not.toContain('data-action="device-revoke"')
    expect(html).not.toContain('data-action="connector-new"')
  })

  test('a half that is not wired says how to wire it; with neither there is no area', async () => {
    const onlyDevices = wired({ connectors: null })
    const text = visibleText(await page(onlyDevices.handle, '/connect', ADMIN))
    expect(text).toContain('应用连接未接入')
    expect(text).toContain('我的 MacBook')
    const neither = wired({ connectors: null, devices: null })
    expect((await neither.handle(browse('/connect', ADMIN))).status).toBe(404)
    const home = await page(neither.handle, '/overview', ADMIN)
    expect(home).not.toContain('href="/connect"')
  })

  test('a failing connection book is a failure bar, the devices still show', async () => {
    const connectors = new FakeConnectors(() => NOW)
    connectors.failSnapshot = true
    const { handle } = wired({ connectors })
    const text = visibleText(await page(handle, '/fragments/connect', ADMIN))
    expect(text).toContain('应用连接')
    expect(text).not.toContain('工作邮箱')
    expect(text).toContain('我的 MacBook')
  })
})

describe('/fragments/connect/form', () => {
  test('a preset fills the servers and folds them; the account and secret are blank', async () => {
    const { handle } = wired()
    const html = await page(
      handle,
      '/fragments/connect/form?preset=gmail',
      ADMIN,
    )
    expect(html).toContain('value="gmail" checked')
    expect(html).toContain('value="imap.gmail.com"')
    expect(html).toContain('已按 Gmail 填好')
    expect(html).toContain('name="secret"')
    expect(html).toContain(' required')
    // An unknown preset is the first one.
    const first = await page(
      handle,
      '/fragments/connect/form?preset=nope',
      ADMIN,
    )
    expect(first).toContain('value="qq-mail" checked')
  })

  test('editing fills the connection’s own settings and agents; the secret may stay blank', async () => {
    const { handle } = wired()
    const html = await page(handle, '/fragments/connect/form?id=con-1', ADMIN)
    expect(html).toContain('name="connectorId" value="con-1"')
    expect(html).toContain('value="chen@qq.com"')
    expect(html).toContain('不改就留空')
    expect(html).toContain('value="qianmo://tokyo-1/planner" checked')
    expect(html).not.toContain('name="preset" value="gmail"')
    expect(
      (await handle(browse('/fragments/connect/form?id=nope', ADMIN))).status,
    ).toBe(404)
    expect((await handle(browse('/fragments/connect/x', ADMIN))).status).toBe(
      404,
    )
  })

  test('an ICS subscription asks for its address as the secret', async () => {
    const { handle } = wired()
    const html = await page(handle, '/fragments/connect/form?preset=ics', ADMIN)
    expect(visibleText(html)).toContain('订阅地址')
    expect(html).not.toContain('服务器设置')
  })
})
