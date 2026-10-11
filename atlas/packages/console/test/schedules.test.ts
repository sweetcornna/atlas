// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** 主动执行 (P24): the schedules half of `/jobs` over `FakeSchedules`. */

import { describe, expect, test } from 'bun:test'
import { FakeSchedules } from './directionFakes.js'
import {
  ADMIN,
  browse,
  NOW,
  pageHarness,
  VIEW,
  visibleText,
  withoutScripts,
} from './pageHarness.js'

function wired() {
  const schedules = new FakeSchedules(() => NOW)
  const h = pageHarness({ ports: { schedules } })
  return { handle: h.handle, schedules }
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

describe('主动执行 · runs', () => {
  test('a finished run shows its reply; a run whose end never came back says so', async () => {
    const { handle } = wired()
    const text = visibleText(await read(handle, '/jobs'))
    expect(text).toContain('晨间简报')
    expect(text).toContain('今天的重点有三件')
    expect(text).toContain('结果未知 · 待确认')
    expect(text).toContain('确认之前，这个任务不会再发')
  })

  test('the admin token can settle an unknown run; a view token only reads', async () => {
    const { handle } = wired()
    const admin = withoutScripts(await read(handle, '/jobs'))
    expect(admin).toContain('data-action="run-resolve"')
    expect(admin).toContain('data-run="run-0"')
    expect(admin).toContain('data-outcome="ok"')
    expect(admin).toContain('data-outcome="failed"')
    const view = withoutScripts(await read(handle, '/jobs', VIEW))
    expect(visibleText(view)).toContain('结果未知 · 待确认')
    expect(view).not.toContain('run-resolve')
  })

  test('once settled, the run reads as its outcome and the buttons go', async () => {
    const { handle, schedules } = wired()
    const settled = await schedules.resolve('sch-1', 'run-0', 'failed', {
      subject: 'legacy:admin',
      role: null,
      requestId: 't',
    })
    expect(settled.ok).toBe(true)
    const html = withoutScripts(await read(handle, '/jobs'))
    expect(visibleText(html)).not.toContain('结果未知')
    expect(html).not.toContain('data-action="run-resolve"')
  })
})
