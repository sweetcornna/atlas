// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { NodeDesktop, type DesktopLauncher } from '../../src/host/desktop.js'
import type { DesktopActionView, DesktopNodeView } from '@qianmo/console'
const ctx = { peer: 'hub', actor: 'ops', taskId: 'control' }
const hash = (args: unknown) =>
  createHash('sha256').update(JSON.stringify(args)).digest('hex')
async function fixture(
  platform: NodeJS.Platform = 'darwin',
  opts: { xvfb?: boolean; now?: () => number } = {},
) {
  const previous = process.env.QIANMO_CONFIG_DIR
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p21-unit-'))
  process.env.QIANMO_CONFIG_DIR = root
  const calls: {
    program: string
    argv: readonly string[]
    env: Record<string, string | undefined>
  }[] = []
  const stops: number[] = []
  let tabs = 1,
    pid = 100,
    estop = false
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      Response.json(Array.from({ length: tabs }, () => ({ type: 'page' }))),
  })
  const launcher: DesktopLauncher = {
    available: name =>
      name === 'Xvfb' || name === 'xauth' ? opts.xvfb === true : true,
    async run(program, argv, env) {
      calls.push({ program, argv, env })
      const auth = argv[1]!
      fs.writeFileSync(auth, 'fixture-cookie', { mode: 0o600 })
      return 0
    },
    async start(program, argv, env) {
      calls.push({ program, argv, env: { ...env } })
      if (program === '/bin/sh') fs.writeFileSync(argv.at(-1)!, '27\n')
      const profileArg = argv.find(a => a.startsWith('--user-data-dir='))
      if (profileArg)
        fs.writeFileSync(
          path.join(profileArg.split('=')[1]!, 'DevToolsActivePort'),
          `${server.port}\n/ws\n`,
        )
      const ownPid = pid++
      let running = true
      return {
        pid: ownPid,
        alive: () => running,
        async stop() {
          running = false
          stops.push(ownPid)
        },
      }
    },
    async reap(id) {
      stops.push(id)
    },
  }
  const audits: unknown[] = []
  const node = new NodeDesktop({
    node: 'worker',
    agents: ['main', 'other'],
    estop: () => estop,
    platform,
    launcher,
    now: opts.now,
    idleMs: 1000,
    downloadBytes: 20,
    tabLimit: 2,
    audit: e => audits.push(e),
  })
  const enable = (
    operationId = 'enable',
    change: Record<string, unknown> = { browser: true },
  ) =>
    node.control(
      'desktop.enable',
      { agent: 'main', operationId, ...change },
      ctx,
    )
  const view = async () =>
    (await node.control('desktop.status', {}, ctx)) as {
      ok: true
      value: DesktopNodeView[]
    }
  return {
    root,
    node,
    launcher,
    calls,
    stops,
    audits,
    enable,
    view,
    setTabs: (v: number) => {
      tabs = v
    },
    setEstop: () => {
      estop = true
    },
    async cleanup() {
      await node.close()
      await server.stop(true)
      process.env.QIANMO_CONFIG_DIR = previous
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}
function callOf(
  node: NodeDesktop,
  toolName = 'qianmo_browser_click',
  args?: Record<string, unknown>,
  invocationId = 'invoke',
) {
  const resource = node.resource('main')!
  const input = args ?? { selector: '#send', tab: resource.tab }
  return {
    toolName,
    input: {
      invocationId,
      resourceId: resource.resourceId,
      resourceEpoch: resource.resourceEpoch,
      args: input,
      canonicalArgsDigest: hash(input),
      phase: 'reserve',
    },
  }
}
test('host allocates trusted launch args, deduplicates controls, refuses mismatches and ESTOP enables, recycles data', async () => {
  const f = await fixture()
  try {
    expect((await f.enable()).ok).toBe(true)
    expect((await f.enable()).ok).toBe(true)
    expect(f.calls.filter(c => c.program.includes('Chrome')).length).toBe(1)
    expect((await f.enable('enable', { browser: false })).ok).toBe(false)
    const launch = f.calls.find(c => c.program.includes('Chrome'))!
    expect(launch.argv).toContain('--remote-debugging-port=0')
    expect(launch.argv).toContain('--remote-debugging-address=127.0.0.1')
    expect(launch.argv).not.toContain('--no-sandbox')
    const profile = path.join(f.root, 'qianmo/desktop/main/browser')
    expect(fs.statSync(profile).mode & 0o777).toBe(0o700)
    const old = f.node.resource('main')!
    f.setEstop()
    expect((await f.enable('estop')).ok).toBe(false)
    expect(
      (
        await f.node.control(
          'desktop.disable',
          { agent: 'main', operationId: 'off' },
          ctx,
        )
      ).ok,
    ).toBe(true)
    expect(fs.existsSync(profile)).toBe(true)
    expect(f.node.resource('main')!.resourceEpoch).toBeGreaterThan(
      old.resourceEpoch,
    )
    expect(
      (
        await f.node.control(
          'desktop.recycle',
          { agent: 'main', operationId: 'recycle' },
          ctx,
        )
      ).ok,
    ).toBe(true)
    expect(fs.existsSync(path.dirname(profile))).toBe(false)
    expect(f.stops).toContain(100)
  } finally {
    await f.cleanup()
  }
})
test('exact turn and epoch leases gate one action; denial, replay, grant window and stale targets cause zero commits', async () => {
  const f = await fixture()
  try {
    await f.enable()
    let live = true,
      approved = 0
    const call = callOf(f.node)
    const gate = (phase: string, extra = {}) =>
      f.node.gate(
        'main',
        'session',
        'task',
        'ctx',
        { ...call, input: { ...call.input, phase, ...extra } },
        () => live,
        async (_bound, before) => {
          approved++
          return before(undefined, 'fixture-request', () => true)
        },
      )
    expect(await gate('reserve')).toBe(true)
    expect(await gate('commit')).toBe(false)
    expect(
      await gate('authorize', {
        observedTargetDigest: 'a'.repeat(64),
        host: 'example.test',
      }),
    ).toBe(true)
    expect(approved).toBe(1)
    expect(await gate('commit', { observedTargetDigest: 'b'.repeat(64) })).toBe(
      false,
    )
    expect(await gate('commit', { observedTargetDigest: 'a'.repeat(64) })).toBe(
      true,
    )
    expect(await gate('commit', { observedTargetDigest: 'a'.repeat(64) })).toBe(
      false,
    )
    expect(await gate('completed')).toBe(true)
    expect(await gate('reserve')).toBe(false)
    const rows = (await f.node.control('desktop.actions', {}, ctx)) as {
      value: DesktopActionView[]
    }
    expect(rows.value[0]).toMatchObject({
      outcome: 'confirmed',
      confirmed: true,
      taskId: 'task',
      host: 'example.test',
    })
    expect(JSON.stringify(f.audits)).not.toContain('#send')
    const old = callOf(f.node, 'qianmo_browser_click', undefined, 'old')
    await f.node.control(
      'desktop.recycle',
      { agent: 'main', operationId: 'r' },
      ctx,
    )
    expect(
      await f.node.gate(
        'main',
        'session',
        'task',
        'ctx',
        old,
        () => true,
        async () => true,
      ),
    ).toBe(false)
    await f.enable('new')
    const fresh = callOf(f.node, 'qianmo_browser_click', undefined, 'fresh')
    live = false
    expect(
      await f.node.gate(
        'main',
        'session',
        'task',
        'ctx',
        fresh,
        () => live,
        async () => true,
      ),
    ).toBe(false)
  } finally {
    await f.cleanup()
  }
})
test('sensitive observation bypasses approver; always observes through approval and turn revocation prevents consume', async () => {
  const f = await fixture()
  try {
    await f.enable()
    let asks = 0,
      live = true
    const run = async (id: string, allow: boolean) => {
      const call = callOf(
        f.node,
        'qianmo_browser_screenshot',
        { tab: f.node.resource('main')!.tab },
        id,
      )
      const gate = (phase: string) =>
        f.node.gate(
          'main',
          's',
          't',
          'c',
          {
            ...call,
            input: {
              ...call.input,
              phase,
              observedTargetDigest: 'a'.repeat(64),
            },
          },
          () => live,
          async (_call, before) => {
            asks++
            if (!allow) live = false
            return before(undefined, 'fixture-request', () => true)
          },
        )
      expect(await gate('reserve')).toBe(true)
      return {
        authorized: await gate('authorize'),
        commit: () => gate('commit'),
        done: () => gate('completed'),
      }
    }
    const read = await run('read', true)
    expect(read.authorized).toBe(true)
    expect(asks).toBe(0)
    expect(await read.commit()).toBe(true)
    await read.done()
    await f.enable('policy', { confirm: 'always' })
    expect((await run('revoked', false)).authorized).toBe(false)
    expect(asks).toBe(1)
  } finally {
    await f.cleanup()
  }
})
test('Linux launcher uses Xauthority, dynamic display, no TCP/no -ac and macOS cannot open computer', async () => {
  const f = await fixture('linux', { xvfb: true })
  try {
    expect(
      (await f.enable('linux', { browser: true, computer: true })).ok,
    ).toBe(true)
    const xvfb = f.calls.find(c => c.program === '/bin/sh')!
    expect(xvfb.argv[1]).toContain('-screen 0 1440x900x24 -nolisten tcp -auth')
    expect(xvfb.argv[1]).not.toContain('-ac ')
    const browser = f.calls.find(c => c.program.includes('chromium'))!
    expect(browser.env.DISPLAY).toBe(':27')
    expect(browser.env.XAUTHORITY).toBe(
      path.join(f.root, 'qianmo/desktop/main/Xauthority'),
    )
    expect(browser.env.WAYLAND_DISPLAY).toBeUndefined()
    expect(f.node.resource('main')?.computer).toBe(true)
    expect(
      (
        await f.node.control(
          'desktop.disable',
          { agent: 'main', browser: false, operationId: 'browser-off' },
          ctx,
        )
      ).ok,
    ).toBe(true)
    expect(f.node.resource('main')).toMatchObject({
      browser: false,
      computer: true,
    })
    expect(
      (
        await f.node.control(
          'desktop.disable',
          { agent: 'main', browser: true, operationId: 'bad-disable' },
          ctx,
        )
      ).ok,
    ).toBe(false)
  } finally {
    await f.cleanup()
  }
  const mac = await fixture()
  try {
    expect((await mac.enable('bad', { computer: true })).ok).toBe(false)
  } finally {
    await mac.cleanup()
  }
  const missing = await fixture('linux')
  try {
    expect((await missing.view()).value[0]?.computer.supported).toBe(false)
    expect((await missing.enable('bad', { computer: true })).ok).toBe(false)
  } finally {
    await missing.cleanup()
  }
})
test('download/tab quotas and idle deadline disable resources', async () => {
  let now = 10000
  const f = await fixture('darwin', { now: () => now })
  try {
    await f.enable()
    fs.writeFileSync(
      path.join(f.root, 'qianmo/desktop/main/downloads/file'),
      'x'.repeat(21),
    )
    await f.node.sweep()
    expect((await f.view()).value[0]?.browser).toMatchObject({
      enabled: false,
      reason: '下载配额超限，已停用',
    })
    fs.unlinkSync(path.join(f.root, 'qianmo/desktop/main/downloads/file'))
    await f.enable('tabs')
    f.setTabs(3)
    await f.node.sweep()
    expect((await f.view()).value[0]?.browser.enabled).toBe(false)
    f.setTabs(1)
    await f.enable('idle')
    now += 1001
    await f.node.sweep()
    expect((await f.view()).value[0]?.browser.reason).toBe('空闲超时，已停用')
  } finally {
    await f.cleanup()
  }
})

test('restart reaps orphan trees and converts incomplete intent to unknown without replaying the action', async () => {
  const f = await fixture()
  let recovered: NodeDesktop | undefined
  try {
    await f.enable()
    const call = callOf(f.node)
    const gate = (phase: string) =>
      f.node.gate(
        'main',
        's',
        't',
        'c',
        {
          ...call,
          input: { ...call.input, phase, observedTargetDigest: 'a'.repeat(64) },
        },
        () => true,
        async (_call, before) =>
          before(undefined, 'fixture-request', () => true),
      )
    await gate('reserve')
    await gate('authorize')
    await gate('commit')
    recovered = new NodeDesktop({
      node: 'worker',
      agents: ['main'],
      launcher: f.launcher,
      estop: () => false,
    })
    const status = (await recovered.control('desktop.status', {}, ctx)) as {
      value: DesktopNodeView[]
    }
    expect(status.value[0]?.browser.enabled).toBe(false)
    expect(f.stops).toContain(100)
    const actions = (await recovered.control('desktop.actions', {}, ctx)) as {
      value: DesktopActionView[]
    }
    expect(actions.value[0]?.outcome).toBe('unknown')
    expect(
      await recovered.gate(
        'main',
        's',
        't',
        'c',
        call,
        () => true,
        async () => true,
      ),
    ).toBe(false)
  } finally {
    await recovered?.close()
    await f.cleanup()
  }
})
test('failed deletion remains failed and the resource cannot report successful recycling', async () => {
  const f = await fixture()
  let failed: NodeDesktop | undefined
  try {
    await f.enable()
    await f.node.close()
    failed = new NodeDesktop({
      node: 'worker',
      agents: ['main'],
      launcher: f.launcher,
      estop: () => false,
      removeData: () => {
        throw new Error('disk refused deletion')
      },
    })
    expect(
      (
        await failed.control(
          'desktop.recycle',
          { agent: 'main', operationId: 'fail-delete' },
          ctx,
        )
      ).ok,
    ).toBe(false)
    const status = (await failed.control('desktop.status', {}, ctx)) as {
      value: DesktopNodeView[]
    }
    expect(status.value[0]?.browser.state).toBe('failed')
    expect(
      fs.existsSync(path.join(f.root, 'qianmo/desktop/main/browser')),
    ).toBe(true)
  } finally {
    await failed?.close()
    await f.cleanup()
  }
})

test('recycle during pending approval invalidates the lease; later approval cannot consume or commit', async () => {
  const f = await fixture()
  try {
    await f.enable()
    const call = callOf(f.node)
    const asked = Promise.withResolvers<void>(),
      decision = Promise.withResolvers<void>()
    let consumes = 0
    const gate = (phase: string) =>
      f.node.gate(
        'main',
        's',
        'pending-task',
        'c',
        {
          ...call,
          input: { ...call.input, phase, observedTargetDigest: 'a'.repeat(64) },
        },
        () => true,
        async (_call, before) => {
          asked.resolve()
          await decision.promise
          const allowed = before(undefined, 'pending-approval', () => true)
          if (allowed) consumes++
          return allowed
        },
      )
    expect(await gate('reserve')).toBe(true)
    const pending = gate('authorize')
    await asked.promise
    expect(
      (
        await f.node.control(
          'desktop.recycle',
          { agent: 'main', operationId: 'pending-recycle' },
          ctx,
        )
      ).ok,
    ).toBe(true)
    decision.resolve()
    expect(await pending).toBe(false)
    expect(await gate('commit')).toBe(false)
    expect(consumes).toBe(0)
    expect(f.stops).toContain(100)
  } finally {
    await f.cleanup()
  }
})
test('revocation of a consumed permit before commit prevents the external action', async () => {
  const f = await fixture()
  try {
    await f.enable()
    let permitValid = true
    const call = callOf(f.node)
    const gate = (phase: string) =>
      f.node.gate(
        'main',
        's',
        't',
        'c',
        {
          ...call,
          input: { ...call.input, phase, observedTargetDigest: 'a'.repeat(64) },
        },
        () => true,
        async (_call, before) =>
          before(undefined, 'request', () => permitValid),
      )
    expect(await gate('reserve')).toBe(true)
    expect(await gate('authorize')).toBe(true)
    permitValid = false
    expect(await gate('commit')).toBe(false)
    const rows = (await f.node.control('desktop.actions', {}, ctx)) as {
      value: DesktopActionView[]
    }
    expect(rows.value[0]?.outcome).toBe('denied')
  } finally {
    await f.cleanup()
  }
})
