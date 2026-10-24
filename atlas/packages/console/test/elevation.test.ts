// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** 权限模式 (P39): the page and `/v0/elevation` over `FakeElevation`. */

import { describe, expect, test } from 'bun:test'
import {
  accountsHarness,
  asAdmin,
  asSession,
  ManualClock,
  person,
} from './accountsHarness.js'
import { FakeElevation } from './elevationFake.js'
import {
  ADMIN,
  browse,
  NOW,
  pageHarness,
  VIEW,
  visibleText,
  withoutScripts,
} from './pageHarness.js'

async function read(
  handle: (request: Request) => Promise<Response>,
  path: string,
  token = ADMIN,
): Promise<string> {
  const response = await handle(browse(path, token))
  expect(`${path} ${response.status}`).toBe(`${path} 200`)
  return await response.text()
}

describe('权限模式 page', () => {
  test('one card per agent: the four modes, what is left, sandbox, why not', async () => {
    const h = pageHarness({
      ports: { elevation: new FakeElevation(() => NOW) },
    })
    const html = await read(h.handle, '/admin/elevation')
    const text = visibleText(html)
    for (const word of [
      'planner',
      '人工确认',
      '自动接受编辑',
      '自动审批',
      '跳过权限确认',
      '12 / 200',
      '沙箱内执行 · 无网络',
      '高权限模式只对 qianmopi 底层生效',
      '不记命令与网页内容',
      'pr_create',
    ])
      expect(`${word} ${text.includes(word)}`).toBe(`${word} true`)
    // An agent the mode cannot reach offers only 人工确认.
    expect(html).toMatch(
      /value="auto" data-elevation-tier data-node="berlin-1" data-agent="helper"[^>]* disabled/,
    )
    expect(html).toContain('data-action="elevation-revoke-all"')
    expect(html).toContain('id="elevation-grant"')
    // Only a node that reported no gh says GitHub is not offered.
    expect(html.match(/节点上没有 gh/g)?.length).toBe(1)
  })
  test('the hub default (--elevation-default) shows on every card, held ones as held', async () => {
    const port = new FakeElevation(() => NOW)
    port.agents = port.agents.map((one, i) => ({
      ...one,
      defaultTier: 'auto' as const,
      defaultHeld: i === 1,
    }))
    const h = pageHarness({ ports: { elevation: port } })
    const text = visibleText(await read(h.handle, '/admin/elevation'))
    expect(text.match(/自动审批 · 到期后自动再开/g)?.length).toBe(
      port.agents.length - 1,
    )
    expect(text).toContain('已手动关闭 · 不自动开启')
  })
  test('a view token reads every state and changes none', async () => {
    const h = pageHarness({
      ports: { elevation: new FakeElevation(() => NOW) },
    })
    const html = withoutScripts(await read(h.handle, '/admin/elevation', VIEW))
    expect(html).not.toContain('data-elevation-tier')
    expect(html).not.toContain('elevation-revoke')
    expect(html).not.toContain('data-write')
    expect(visibleText(html)).toContain('自动审批')
  })
  test('no port is no area', async () => {
    const h = pageHarness({})
    const response = await h.handle(browse('/admin/elevation', ADMIN))
    expect(response.status).toBe(404)
  })
})

describe('/v0/elevation (P39 §5)', () => {
  function wired() {
    const clock = new ManualClock(NOW)
    const elevation = new FakeElevation(clock.now)
    const h = accountsHarness({ clock, deps: { elevation } })
    return { ...h, elevation }
  }
  const auto = { tier: 'auto', ttlMs: 3_600_000, maxCalls: 50 }

  test('a fresh personal ops session opens a mode; a stale one may only switch off', async () => {
    const h = wired()
    const ops = await person(h.handle, 'ops')
    const opened = await h.handle(
      asSession('PUT', '/v0/elevation/osaka-1/writer', ops.sid, { body: auto }),
    )
    expect(opened.status).toBe(200)
    expect(((await opened.json()) as { tier: string }).tier).toBe('auto')
    h.clock.advance(31 * 60_000)
    const stale = await h.handle(
      asSession('PUT', '/v0/elevation/osaka-1/writer', ops.sid, {
        body: { tier: 'full-access' },
      }),
    )
    expect(stale.status).toBe(403)
    expect(await stale.text()).toContain('30 分钟')
    const off = await h.handle(
      asSession('PUT', '/v0/elevation/osaka-1/writer', ops.sid, {
        body: { tier: 'off' },
      }),
    )
    expect(off.status).toBe(200)
  })
  test('the legacy admin token never opens a mode but can switch off and revoke', async () => {
    const h = wired()
    const refused = await h.handle(
      asAdmin('PUT', '/v0/elevation/osaka-1/writer', auto),
    )
    expect(refused.status).toBe(403)
    expect(
      (
        await h.handle(
          asAdmin('POST', '/v0/elevation/tokyo-1/planner/revoke', {}),
        )
      ).status,
    ).toBe(200)
    expect(h.elevation.calls).toContain('revoke tokyo-1/planner')
  })
  test('a member cannot change a mode at all', async () => {
    const h = wired()
    const member = await person(h.handle, 'member')
    const r = await h.handle(
      asSession('PUT', '/v0/elevation/osaka-1/writer', member.sid, {
        body: { tier: 'off' },
      }),
    )
    expect(r.status).toBe(403)
    expect(h.elevation.calls).toEqual([])
  })
  test('bad bodies are refused before anything is sent', async () => {
    const h = wired()
    const ops = await person(h.handle, 'ops')
    for (const body of [
      { tier: 'confirm-each' },
      { tier: 'auto', ttlMs: 1000 },
      { tier: 'auto', maxCalls: 5000 },
      { tier: 'off', ttlMs: 3_600_000 },
      { tier: 'auto', extra: true },
    ]) {
      const r = await h.handle(
        asSession('PUT', '/v0/elevation/osaka-1/writer', ops.sid, { body }),
      )
      expect(`${JSON.stringify(body)} ${r.status}`).toBe(
        `${JSON.stringify(body)} 400`,
      )
    }
    expect(h.elevation.calls).toEqual([])
  })
  test('revoke-all withdraws every live grant and reports each', async () => {
    const h = wired()
    const r = await h.handle(asAdmin('POST', '/v0/elevation/revoke-all', {}))
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      revoked: { address: string; ok: boolean }[]
    }
    expect(body.revoked).toEqual([
      { address: 'qianmo://tokyo-1/planner', ok: true },
    ])
    const list = (await (
      await h.handle(asAdmin('GET', '/v0/elevation'))
    ).json()) as { tier: string }[]
    expect(list.every(one => one.tier === 'off')).toBe(true)
  })
})
